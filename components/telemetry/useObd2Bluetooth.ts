import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeModules, Platform } from 'react-native';
import RNBluetoothClassic, {
  type BluetoothDevice,
  type BluetoothEventSubscription,
} from 'react-native-bluetooth-classic';

import {
  decodeElmResponse,
  parseCoolantTemp,
  parseEngineRpm,
  parseIntakeAirTemp,
  parseThrottlePosition,
  parseVehicleSpeed,
  parseVoltage,
} from '@/utils/obd2Decoder';
import { requestBluetoothPermissions } from '@/utils/permissions';

export type EcuConnectPhase = 'idle' | 'scanning' | 'connected' | 'error';

export type EcMetricSnapshot = {
  rpm: number;
  coolant: number;
  intake: number;
  tps: number;
  batt: number;
  ecuSpeed: number;
};

const POLL_GAP_MS = 200;
/** ELM/ST FF + adaptive timing + slower Euro-5 29‑bit buses need a generous ceiling. */
const RESP_TIMEOUT_MS = 9000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Paired SPP dongles: Android-Vlink, generic OBD names, etc. */
const NAME_MARKERS = ['VLINK', 'OBD'] as const;

function normalizeBtAddr(addr: string | undefined): string {
  return String(addr ?? '').replace(/[:-]/g, '').toUpperCase();
}

function sameBtAddr(a: string | undefined, b: string | undefined): boolean {
  return normalizeBtAddr(a) === normalizeBtAddr(b);
}

function isObdClassicName(name: string | undefined): boolean {
  const n = `${name ?? ''}`.toUpperCase();
  return NAME_MARKERS.some((m) => n.includes(m));
}

function obdSnippetForParser(rawResponse: string): string {
  const upper = rawResponse.toUpperCase();
  if (upper.includes('NO DATA')) return '';
  const parts = rawResponse.split(/[\r\n]+/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const line = parts[i]?.trim();
    if (!line || line === '>' || /^UNABLE/i.test(line)) continue;
    if (/SEARCHING|BUS INIT/i.test(line)) continue;
    return line;
  }
  return rawResponse.trim();
}

function createDeferredString(): {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ZERO_METRICS: EcMetricSnapshot = {
  rpm: 0,
  coolant: 0,
  intake: 0,
  tps: 0,
  batt: 0,
  ecuSpeed: 0,
};

type UseObd2BluetoothOpts = {
  onMetrics?: (m: EcMetricSnapshot) => void;
  onError?: (title: string, message: string) => void;
  onLog?: (msg: string) => void;
};

function logBleException(onLog: ((msg: string) => void) | undefined, e: unknown): void {
  let line = '';
  try {
    line = `BT ERROR: ${JSON.stringify(e)}`;
  } catch {
    line = `BT ERROR: ${String(e)}`;
  }
  onLog?.(line);
  if (typeof e === 'object' && e !== null) {
    const msg = String((e as { message?: unknown }).message ?? '');
    if (msg && !line.includes(msg)) {
      onLog?.(`BT ERROR message: ${msg}`);
    }
  }
}

export function useObd2Bluetooth({ onMetrics, onError, onLog }: UseObd2BluetoothOpts): {
  phase: EcuConnectPhase;
  deviceName: string;
  macAddress: string;
  latencyMsDisplay: string;
  lastBleError: string | null;
  connectToObd: () => void;
  cancelScan: () => void;
  disconnect: () => void;
} {
  const [phase, setPhase] = useState<EcuConnectPhase>('idle');
  const [deviceName, setDeviceName] = useState('Not connected');
  const [macAddress, setMacAddress] = useState('—');
  const [latencyMsDisplay, setLatencyMsDisplay] = useState('—');
  const [lastBleError, setLastBleError] = useState<string | null>(null);

  const onMetricsRef = useRef(onMetrics);
  const onErrorRef = useRef(onError);
  const onLogRef = useRef(onLog);
  onMetricsRef.current = onMetrics;
  onErrorRef.current = onError;
  onLogRef.current = onLog;

  const log = useCallback((msg: string) => {
    onLogRef.current?.(msg);
  }, []);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const deviceRef = useRef<BluetoothDevice | null>(null);
  const connectionEpochRef = useRef(0);

  const dataRecvSubRef = useRef<BluetoothEventSubscription | null>(null);
  const moduleDiscSubRef = useRef<BluetoothEventSubscription | null>(null);
  const moduleErrorSubRef = useRef<BluetoothEventSubscription | null>(null);

  const rxAccumRef = useRef('');
  const pendingRef = useRef<ReturnType<typeof createDeferredString> | null>(null);
  const respTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pollActiveRef = useRef(false);
  const latencySamplesRef = useRef<number[]>([]);
  const battCarryRef = useRef(0);
  const pollRoundCounterRef = useRef(0);

  /** Last metrics merged from live RX + poll (keeps UI in sync with delimiter-delimited ELM lines). */
  const latestSnapshotRef = useRef<EcMetricSnapshot>({ ...ZERO_METRICS });

  const notifyListenerRef = useRef<((fragment: string) => void) | undefined>(undefined);

  const bumpLatencySample = useCallback((ms: number) => {
    latencySamplesRef.current.push(ms);
    if (latencySamplesRef.current.length > 16) latencySamplesRef.current.shift();
    const sum = latencySamplesRef.current.reduce((a, x) => a + x, 0);
    const avg = sum / latencySamplesRef.current.length;
    setLatencyMsDisplay(String(Math.max(1, Math.round(avg))));
  }, []);

  const pushZeroMetrics = useCallback(() => {
    latencySamplesRef.current = [];
    battCarryRef.current = 0;
    pollRoundCounterRef.current = 0;
    latestSnapshotRef.current = { ...ZERO_METRICS };
    setLatencyMsDisplay('—');
    onMetricsRef.current?.(ZERO_METRICS);
  }, []);

  const fail = useCallback((title: string, message: string, err?: Error | unknown) => {
    log(`${title}: ${message}`);
    if (err !== undefined) {
      logBleException(onLogRef.current, err);
    }
    const detail = err instanceof Error ? err.message : err ? String(err) : '';
    setDeviceName('Not connected');
    setMacAddress('—');
    setLastBleError(detail ? `${message}: ${detail}` : message);
    setPhase('error');
    onErrorRef.current?.(title, detail ? `${message}\n(${detail.slice(0, 220)})` : message);
  }, [log]);

  const clearResponseWait = useCallback(() => {
    if (respTimerRef.current) {
      clearTimeout(respTimerRef.current);
      respTimerRef.current = null;
    }
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) p.reject(new Error('Cancelled'));
  }, []);

  const stopPollingTimers = useCallback(() => {
    pollActiveRef.current = false;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const removeClassicSubscriptionsSafe = useCallback(() => {
    dataRecvSubRef.current?.remove();
    dataRecvSubRef.current = null;
    moduleDiscSubRef.current?.remove();
    moduleDiscSubRef.current = null;
    moduleErrorSubRef.current?.remove();
    moduleErrorSubRef.current = null;
  }, []);

  const resetTransportState = useCallback(() => {
    stopPollingTimers();
    clearResponseWait();
    removeClassicSubscriptionsSafe();
    rxAccumRef.current = '';
  }, [clearResponseWait, removeClassicSubscriptionsSafe, stopPollingTimers]);

  const disconnectHardware = useCallback(async () => {
    const d = deviceRef.current;
    deviceRef.current = null;
    if (d) {
      await d.disconnect().catch(() => undefined);
    }
  }, []);

  const disconnectCb = useCallback(async () => {
    log('Disconnect requested by user.');
    connectionEpochRef.current += 1;
    resetTransportState();
    await disconnectHardware();
    pushZeroMetrics();
    setPhase('idle');
    setDeviceName('Not connected');
    setMacAddress('—');
    log('Disconnected (local).');
  }, [disconnectHardware, log, pushZeroMetrics, resetTransportState]);

  const tryTakeOneResponse = useCallback((): boolean => {
    let buf = rxAccumRef.current;
    const termOrder = ['\r\r>', '\r\n>', '\n\r>', '\r>'];
    for (const term of termOrder) {
      const idx = buf.indexOf(term);
      if (idx === -1) continue;
      const body = buf.slice(0, idx);
      buf = buf.slice(idx + term.length);
      rxAccumRef.current = buf;
      const p = pendingRef.current;
      pendingRef.current = null;
      if (respTimerRef.current) {
        clearTimeout(respTimerRef.current);
        respTimerRef.current = null;
      }
      if (p) p.resolve(body);
      return true;
    }
    return false;
  }, []);

  const drainRxWhileTerms = useCallback(() => {
    while (tryTakeOneResponse()) {
      /* drain */
    }
  }, [tryTakeOneResponse]);

  notifyListenerRef.current = (fragment: string) => {
    try {
      rxAccumRef.current += fragment;
      drainRxWhileTerms();
    } catch {
      /* ignore */
    }
  };

  const writeCmd = useCallback(async (dev: BluetoothDevice, cmd: string) => {
    const ok = await dev.write(cmd, 'ascii');
    if (!ok) throw new Error('RFCOMM write returned false');
  }, []);

  const elmExchange = useCallback(
    async (cmd: string, timeoutMs = RESP_TIMEOUT_MS): Promise<string> => {
      const dev = deviceRef.current;
      if (!dev) throw new Error('No connected Bluetooth device');

      if (pendingRef.current) throw new Error('ELM overlap');

      const def = createDeferredString();
      pendingRef.current = def;

      respTimerRef.current = setTimeout(() => {
        if (pendingRef.current === def) {
          pendingRef.current = null;
          def.reject(new Error('ELM response timeout'));
        }
        if (respTimerRef.current) {
          clearTimeout(respTimerRef.current);
          respTimerRef.current = null;
        }
      }, timeoutMs);

      const tSend = Date.now();
      await writeCmd(dev, cmd);

      try {
        const raw = await def.promise;
        bumpLatencySample(Date.now() - tSend);
        return raw;
      } finally {
        if (pendingRef.current === def) {
          pendingRef.current = null;
        }
        if (respTimerRef.current) {
          clearTimeout(respTimerRef.current);
          respTimerRef.current = null;
        }
      }
    },
    [bumpLatencySample, writeCmd]
  );

  const runElmHandshakeSequence = useCallback(
    async (dev: BluetoothDevice) => {
      log('ELM handshake: TX AT Z (chip reset)');
      await writeCmd(dev, 'AT Z\r');
      await delay(1000);
      log('ELM handshake: TX ATE0 (echo off)');
      await writeCmd(dev, 'ATE0\r');
      await delay(500);
      log('ELM handshake: TX ATL0 (linefeeds off)');
      await writeCmd(dev, 'ATL0\r');
      await delay(500);
      log('ELM handshake: TX AT ST FF (max response timeout)');
      await writeCmd(dev, 'AT ST FF\r');
      await delay(500);
      log('TX: AT SP 7');
      await writeCmd(dev, 'AT SP 7\r');
      await delay(500);
      log('TX: 0100');
      await writeCmd(dev, '0100\r');
      await delay(1000);
      log('ELM handshake: Protocol 7 (CAN 29/500) fast boot complete — PID loop may run');
    },
    [log, writeCmd]
  );

  const attachDataPipe = useCallback(
    (conn: BluetoothDevice) => {
      log(`RFCOMM Rx listener on ${conn.address} (delimiter \\r reconstructed in buffer)`);
      dataRecvSubRef.current?.remove();
      dataRecvSubRef.current = conn.onDataReceived((ev) => {
        const chunk = ev.data ?? '';
        const forUi = chunk.replace(/\r/g, '').replace(/\n/g, '').replace(/>/g, '').trim();
        if (forUi.length > 0) {
          onLogRef.current?.(`RX: ${forUi}`);
        }

        const decoded = decodeElmResponse(forUi);
        if (decoded) {
          const m = { ...latestSnapshotRef.current };
          switch (decoded.pid) {
            case '0C':
              m.rpm = decoded.value;
              break;
            case '05':
              m.coolant = decoded.value;
              break;
            case '0F':
              m.intake = decoded.value;
              break;
            case '11':
              m.tps = decoded.value;
              break;
            case '0D':
              m.ecuSpeed = decoded.value;
              break;
            default:
              break;
          }
          latestSnapshotRef.current = m;
          onMetricsRef.current?.(m);
        }

        if (/V/i.test(chunk) && /\d/.test(chunk)) {
          const volts = parseVoltage(chunk);
          if (volts > 0 && volts <= 30) {
            const m = {
              ...latestSnapshotRef.current,
              batt: volts,
            };
            latestSnapshotRef.current = m;
            battCarryRef.current = volts;
            onMetricsRef.current?.(m);
          }
        }

        if (chunk.length > 0) {
          notifyListenerRef.current?.(`${chunk}\r`);
        }
      });
    },
    [log]
  );

  const attachModuleListeners = useCallback(
    (conn: BluetoothDevice) => {
      moduleDiscSubRef.current?.remove();
      moduleDiscSubRef.current = RNBluetoothClassic.onDeviceDisconnected((ev) => {
        const addr = ev.device?.address;
        if (!addr || !deviceRef.current) return;
        if (!sameBtAddr(addr, conn.address)) return;
        log(`Device disconnected (native event) address=${addr}`);
        resetTransportState();
        deviceRef.current = null;
        pushZeroMetrics();
        setPhase('idle');
        setDeviceName('Not connected');
        setMacAddress('—');
      });

      moduleErrorSubRef.current?.remove();
      moduleErrorSubRef.current = RNBluetoothClassic.onError((ev) => {
        log(`RNBluetoothClassic onError: ${JSON.stringify(ev)}`);
      });
    },
    [log, pushZeroMetrics, resetTransportState]
  );

  const elmExchangeSafeRef = useRef(elmExchange);
  elmExchangeSafeRef.current = elmExchange;

  const scheduleNextPollRef = useRef<() => void>(() => {});

  const runPollRoundRef = useRef<() => Promise<void>>(async () => {});

  scheduleNextPollRef.current = () => {
    if (!pollActiveRef.current) return;
    pollTimerRef.current = setTimeout(() => void runPollRoundRef.current(), POLL_GAP_MS);
  };

  runPollRoundRef.current = async () => {
    if (!pollActiveRef.current || !deviceRef.current) return;

    const m: EcMetricSnapshot = { ...latestSnapshotRef.current };

    const ex = elmExchangeSafeRef.current;

    try {
      m.rpm = parseEngineRpm(obdSnippetForParser(await ex(`010C\r`)));
      m.ecuSpeed = parseVehicleSpeed(obdSnippetForParser(await ex(`010D\r`)));
      m.coolant = parseCoolantTemp(obdSnippetForParser(await ex(`0105\r`)));
      m.intake = parseIntakeAirTemp(obdSnippetForParser(await ex(`010F\r`)));
      m.tps = parseThrottlePosition(obdSnippetForParser(await ex(`0111\r`)));

      pollRoundCounterRef.current += 1;
      if (pollRoundCounterRef.current % 6 === 0 || battCarryRef.current <= 0) {
        const rv = await ex(`AT RV\r`);
        const volts = parseVoltage(rv);
        log(`Decoded V: ${volts}`);
        if (volts > 0) battCarryRef.current = volts;
      }
      m.batt = battCarryRef.current > 0 ? battCarryRef.current : latestSnapshotRef.current.batt;

      latestSnapshotRef.current = { ...m };
      if (pollActiveRef.current) {
        onMetricsRef.current?.(m);
      }
    } catch {
      /** skip partial round */
    }

    if (pollActiveRef.current) {
      scheduleNextPollRef.current();
    }
  };

  const connectToObdInner = useCallback(async () => {
    if (phaseRef.current === 'scanning' || phaseRef.current === 'connected') return;

    connectionEpochRef.current += 1;
    const token = connectionEpochRef.current;

    const stillValid = (): boolean => connectionEpochRef.current === token;

    setLastBleError(null);
    battCarryRef.current = 0;
    pollRoundCounterRef.current = 0;

    resetTransportState();
    await disconnectHardware();

    if (!stillValid()) {
      log('connectToObd aborted before start (cancel).');
      return;
    }

    setPhase('scanning');
    setDeviceName('Resolving paired device…');
    setMacAddress('—');

    if (Platform.OS === 'web') {
      fail('Bluetooth Classic', 'SPP/OBD adapters are not available on web.', undefined);
      pushZeroMetrics();
      return;
    }

    if (!NativeModules.RNBluetoothClassic) {
      log('NativeModules.RNBluetoothClassic is undefined — rebuild Dev Client native app.');
      fail(
        'Native module missing',
        'Bluetooth Classic native module unavailable. Run a Dev Client native build.',
        undefined
      );
      pushZeroMetrics();
      return;
    }

    log('===== connectToObd(): Bluetooth Classic (RFCOMM / SPP) =====');
    log('connectToObd step: requesting Android Bluetooth runtime permissions …');

    const permitted = await requestBluetoothPermissions(log);
    if (!permitted) {
      log('Permission denied');
      pushZeroMetrics();
      fail(
        'Permissions',
        'Bluetooth permissions were denied. Grant Nearby devices / Bluetooth + location if prompted.',
        undefined
      );
      return;
    }

    log('connectToObd step: runtime permissions satisfied — proceeding');

    try {
      const okAvail = await RNBluetoothClassic.isBluetoothAvailable();
      log(`connectToObd step: isBluetoothAvailable() → ${JSON.stringify(okAvail)}`);
      if (!okAvail) {
        fail('Bluetooth', 'Bluetooth is not available on this device.', undefined);
        pushZeroMetrics();
        return;
      }

      const okOn = await RNBluetoothClassic.isBluetoothEnabled();
      log(`connectToObd step: isBluetoothEnabled() → ${JSON.stringify(okOn)}`);
      if (!okOn) {
        fail('Bluetooth', 'Bluetooth must be powered on.', undefined);
        pushZeroMetrics();
        return;
      }

      if (!stillValid()) {
        log('connectToObd invalidated after Bluetooth state check.');
        return;
      }

      log('Fetching paired devices...');
      let bonded: BluetoothDevice[];
      try {
        bonded = await RNBluetoothClassic.getBondedDevices();
      } catch (e) {
        log(`connectToObd step: getBondedDevices() threw — ${JSON.stringify(e)}`);
        logBleException(onLogRef.current, e);
        fail('Bonded devices', 'getBondedDevices() failed.', e);
        pushZeroMetrics();
        return;
      }

      log(`connectToObd step: getBondedDevices returned ${bonded.length} paired device(s).`);

      bonded.forEach((dev, idx) => {
        const snapshot = {
          index: idx,
          id: dev.id,
          address: dev.address,
          name: dev.name ?? null,
          bonded: dev.bonded,
          type: dev.type,
          deviceClass: dev.deviceClass,
        };
        log(`connectToObd step: bonded row #${idx} → ${JSON.stringify(snapshot)}`);
      });

      const picked =
        bonded.find((d) => isObdClassicName(d.name)) ??
        bonded.find((d) => isObdClassicName(d.address));

      if (!picked || !stillValid()) {
        if (!picked) {
          fail(
            'No OBD adapter',
            'No paired dongle matched (name must include "Vlink" or "OBD"). Pair Android-Vlink in system settings first.',
            undefined
          );
        }
        pushZeroMetrics();
        return;
      }

      log(
        `connectToObd step: matched adapter name="${picked.name ?? ''}" address=${picked.address} id=${picked.id}`
      );

      let conn = picked;

      log('Connecting to SPP...');
      log(`device.connect(${JSON.stringify({ delimiter: '\r' })}) …`);

      try {
        const connectedOk = await conn.connect({ delimiter: '\r' });

        log(`connectToObd step: device.connect settled — ok=${JSON.stringify(connectedOk)}`);
        if (!connectedOk) {
          const errMsg = 'device.connect returned false (socket refused or closed)';
          log(errMsg);
          throw new Error(errMsg);
        }
      } catch (e) {
        log(`connectToObd step: SPP connect FAILED raw → ${JSON.stringify(e)}`);
        logBleException(onLogRef.current, e);
        await conn.disconnect().catch(() => undefined);
        throw e;
      }

      if (!stillValid()) {
        log('connectToObd invalidated post-RFCOMM; closing socket.');
        await conn.disconnect().catch(() => undefined);
        return;
      }

      deviceRef.current = conn;

      latestSnapshotRef.current = { ...ZERO_METRICS };

      rxAccumRef.current = '';
      attachDataPipe(conn);
      attachModuleListeners(conn);

      log('connectToObd step: SPP socket up — listener via device.onDataReceived()');

      setDeviceName(conn.name ?? 'OBD-II');
      setMacAddress(conn.address ?? conn.id ?? '—');

      await runElmHandshakeSequence(conn);

      clearResponseWait();
      rxAccumRef.current = '';
      log('ELM handshake: cleared RX accumulator and pending ELM waiter before live PIDs');

      if (!stillValid()) {
        log('Post-init invalidated; tearing down.');
        resetTransportState();
        await disconnectHardware().catch(() => undefined);
        return;
      }

      log('connectToObd step: ELM polling loop armed (device.write PID + AT RV).');

      setPhase('connected');

      pollActiveRef.current = true;
      void runPollRoundRef.current();
    } catch (e) {
      logBleException(onLogRef.current, e);
      resetTransportState();
      await disconnectHardware().catch(() => undefined);
      pushZeroMetrics();
      fail('Connection failed', 'Bluetooth Classic / ELM327 init failed.', e);
      setDeviceName('Not connected');
      setMacAddress('—');
    }
  }, [
    attachDataPipe,
    attachModuleListeners,
    clearResponseWait,
    disconnectHardware,
    fail,
    log,
    pushZeroMetrics,
    resetTransportState,
    runElmHandshakeSequence,
  ]);

  const connectToObd = useCallback(() => void connectToObdInner(), [connectToObdInner]);

  const cancelScan = useCallback(async () => {
    connectionEpochRef.current += 1;
    log('Cancel requested (invalidate in-flight RFCOMM connection attempt).');
    resetTransportState();
    await disconnectHardware();
    pushZeroMetrics();
    setPhase('idle');
    setDeviceName('Not connected');
    setMacAddress('—');
  }, [disconnectHardware, log, pushZeroMetrics, resetTransportState]);

  const disconnectLatestRef = useRef(disconnectCb);
  disconnectLatestRef.current = disconnectCb;

  useEffect(
    () => () => {
      void disconnectLatestRef.current().catch(() => undefined);
    },
    []
  );

  return {
    phase,
    deviceName,
    macAddress,
    latencyMsDisplay,
    lastBleError,
    connectToObd,
    cancelScan,
    disconnect: disconnectCb,
  };
}
