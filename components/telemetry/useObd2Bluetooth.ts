import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type BleError,
  BleManager,
  type Characteristic,
  type Device,
  type Subscription,
} from 'react-native-ble-plx';

import {
  parseBatteryVoltage,
  parseCoolantTemp,
  parseEngineRpm,
  parseIntakeAirTemp,
  parseThrottlePosition,
  parseVehicleSpeed,
} from '@/utils/obd2Decoder';

export type EcuConnectPhase = 'idle' | 'scanning' | 'connected' | 'error';

export type EcMetricSnapshot = {
  rpm: number;
  coolant: number;
  intake: number;
  tps: number;
  batt: number;
  ecuSpeed: number;
};

const POLL_GAP_MS = 140;
const SCAN_TIMEOUT_MS = 40_000;
const RESP_TIMEOUT_MS = 4500;
const POST_ATZ_MS = 1800;
const CONNECT_TIMEOUT_MS = 18_000;

const NAME_MARKERS = ['VGATE', 'OBD', 'IOS-VLINK'] as const;

let bleSingleton: BleManager | null = null;

function bleManager(): BleManager {
  if (!bleSingleton) bleSingleton = new BleManager();
  return bleSingleton;
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(out);
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

function isObdNameCandidate(device: Device): boolean {
  const name = `${device.name ?? ''} ${device.localName ?? ''}`.toUpperCase();
  return NAME_MARKERS.some((m) => name.includes(m));
}

function normalizeUuid(u: string): string {
  return u.toLowerCase().replace(/-/g, '');
}

async function resolveUartCharacteristics(
  device: Device
): Promise<{ tx: Characteristic; rx: Characteristic } | null> {
  const services = await device.services();
  type Pair = { prio: number; tx: Characteristic; rx: Characteristic };
  const pairs: Pair[] = [];

  for (const srv of services) {
    const suNorm = normalizeUuid(srv.uuid);
    const prio = suNorm.includes('fff0')
      ? 0
      : suNorm.includes('fff')
        ? 1
        : suNorm.includes('49535343')
          ? 2
          : 3;
    const chars = await srv.characteristics();
    const notify = chars.find((c) => c.isNotifiable);
    const write = chars.find((c) => c.isWritableWithResponse || c.isWritableWithoutResponse);
    if (notify && write && notify.uuid !== write.uuid) {
      pairs.push({ prio, tx: write, rx: notify });
    }
  }

  if (pairs.length === 0) return null;
  pairs.sort((a, b) => a.prio - b.prio);
  return { tx: pairs[0].tx, rx: pairs[0].rx };
}

type DeferredString = {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
};

function createDeferredString(): DeferredString {
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
};

export function useObd2Bluetooth({ onMetrics, onError }: UseObd2BluetoothOpts): {
  phase: EcuConnectPhase;
  deviceName: string;
  macAddress: string;
  latencyMsDisplay: string;
  lastBleError: string | null;
  connect: () => void;
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
  onMetricsRef.current = onMetrics;
  onErrorRef.current = onError;

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const deviceRef = useRef<Device | null>(null);
  const txCharRef = useRef<Characteristic | null>(null);

  const rxSubRef = useRef<Subscription | null>(null);
  const discSubRef = useRef<Subscription | null>(null);

  const rxAccumRef = useRef('');
  const pendingRef = useRef<DeferredString | null>(null);
  const respTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pollActiveRef = useRef(false);
  const latencySamplesRef = useRef<number[]>([]);
  const battCarryRef = useRef(0);
  const pollRoundCounterRef = useRef(0);

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
    setLatencyMsDisplay('—');
    onMetricsRef.current?.(ZERO_METRICS);
  }, []);

  const fail = useCallback((title: string, message: string, err?: BleError | Error | unknown) => {
    const detail = err instanceof Error ? err.message : err ? String(err) : '';
    setDeviceName('Not connected');
    setMacAddress('—');
    setLastBleError(detail ? `${message}: ${detail}` : message);
    setPhase('error');
    onErrorRef.current?.(title, detail ? `${message}\n(${detail.slice(0, 220)})` : message);
  }, []);

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

  const removeSubscriptionsSafe = useCallback(() => {
    rxSubRef.current?.remove();
    rxSubRef.current = null;
    discSubRef.current?.remove();
    discSubRef.current = null;
  }, []);

  const stopBleScanSafe = () => {
    try {
      bleManager().stopDeviceScan();
    } catch {
      /* ignore */
    }
  };

  const resetTransportState = useCallback(() => {
    stopPollingTimers();
    clearResponseWait();
    removeSubscriptionsSafe();
    stopBleScanSafe();
    txCharRef.current = null;
    rxAccumRef.current = '';
  }, [clearResponseWait, removeSubscriptionsSafe, stopPollingTimers]);

  const disconnectHardware = useCallback(async () => {
    const d = deviceRef.current;
    deviceRef.current = null;
    if (d) await d.cancelConnection().catch(() => undefined);
  }, []);

  const disconnectCb = useCallback(async () => {
    resetTransportState();
    await disconnectHardware();
    pushZeroMetrics();
    setPhase('idle');
    setDeviceName('Not connected');
    setMacAddress('—');
  }, [disconnectHardware, pushZeroMetrics, resetTransportState]);

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
      /* exhaust buffer */
    }
  }, [tryTakeOneResponse]);

  const notifyListenerRef = useRef<((v64: string) => void) | undefined>(undefined);
  notifyListenerRef.current = (v64: string) => {
    try {
      rxAccumRef.current += base64ToUtf8(v64);
      drainRxWhileTerms();
    } catch {
      /* ignore */
    }
  };

  const writeCmd = useCallback(async (tx: Characteristic, b64: string) => {
    try {
      await tx.writeWithResponse(b64);
    } catch {
      await tx.writeWithoutResponse(b64);
    }
  }, []);

  const elmExchange = useCallback(
    async (cmd: string, timeoutMs = RESP_TIMEOUT_MS): Promise<string> => {
      const tx = txCharRef.current;
      if (!tx) throw new Error('No TX characteristic');
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
      await writeCmd(tx, utf8ToBase64(cmd));

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

  const runElmInitSequence = useCallback(async () => {
    await elmExchange(`AT Z\r`, POST_ATZ_MS + 2500).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, POST_ATZ_MS));
    await elmExchange(`ATE0\r`);
    await elmExchange(`ATL0\r`);
    await elmExchange(`ATS1\r`);
  }, [elmExchange]);

  const prepareMonitor = useCallback((rx: Characteristic, tx: Characteristic) => {
    txCharRef.current = tx;
    rxAccumRef.current = '';
    rxSubRef.current?.remove();
    rxSubRef.current = rx.monitor((error: BleError | null, ch: Characteristic | null) => {
      if (error) return;
      const v64 = ch?.value;
      if (!v64) return;
      notifyListenerRef.current?.(v64);
    });
  }, []);

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

    const m: EcMetricSnapshot = {
      rpm: 0,
      coolant: 0,
      intake: 0,
      tps: 0,
      batt: battCarryRef.current,
      ecuSpeed: 0,
    };

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
        const vbat = parseBatteryVoltage(obdSnippetForParser(rv));
        if (vbat > 0) battCarryRef.current = vbat;
      }
      m.batt = battCarryRef.current;

      if (pollActiveRef.current) {
        onMetricsRef.current?.(m);
      }
    } catch {
      /** skip this round — partial values stay at 0 unless engine running */
    }

    if (pollActiveRef.current) {
      scheduleNextPollRef.current();
    }
  };

  const scanAndConnect = useCallback(async () => {
    const mgr = bleManager();

    if (phaseRef.current === 'scanning' || phaseRef.current === 'connected') return;

    setLastBleError(null);
    battCarryRef.current = 0;
    pollRoundCounterRef.current = 0;

    resetTransportState();
    await disconnectHardware();

    setPhase('scanning');
    setDeviceName('Scanning…');
    setMacAddress('—');

    try {
      const st = await mgr.state();
      if (st !== 'PoweredOn') {
        fail('Bluetooth', 'Bluetooth must be powered on.', undefined);
        return;
      }

      const picked: Device | null = await new Promise((resolve) => {
        let done = false;
        const tout = setTimeout(() => {
          if (done) return;
          done = true;
          stopBleScanSafe();
          resolve(null);
        }, SCAN_TIMEOUT_MS);

        mgr.startDeviceScan(null, null, (_scanErr, d) => {
          if (done || !d || !isObdNameCandidate(d)) return;
          done = true;
          clearTimeout(tout);
          stopBleScanSafe();
          resolve(d);
        });
      });

      if (!picked) {
        fail('Scan timeout', 'No OBD dongle matched (VGATE, OBD, or IOS-VLINK).', undefined);
        pushZeroMetrics();
        return;
      }

      let conn = picked;
      await conn.cancelConnection().catch(() => undefined);

      conn = await conn.connect({ timeout: CONNECT_TIMEOUT_MS });
      await conn.discoverAllServicesAndCharacteristics();

      const uart = await resolveUartCharacteristics(conn);
      if (!uart) {
        await conn.cancelConnection().catch(() => undefined);
        throw new Error('Could not locate UART notify/write pair.');
      }

      prepareMonitor(uart.rx, uart.tx);

      /** Let notifications enable before polling. */
      await new Promise<void>((r) => setTimeout(r, 80));

      await runElmInitSequence();

      deviceRef.current = conn;

      discSubRef.current?.remove();
      discSubRef.current = conn.onDisconnected(() => {
        resetTransportState();
        deviceRef.current = null;
        pushZeroMetrics();
        setPhase('idle');
        setDeviceName('Not connected');
        setMacAddress('—');
      });

      setPhase('connected');
      setDeviceName(conn.name ?? conn.localName ?? 'OBD-II');
      setMacAddress(conn.id ?? '—');

      pollActiveRef.current = true;
      void runPollRoundRef.current();
    } catch (e) {
      stopBleScanSafe();
      resetTransportState();
      const d = deviceRef.current;
      deviceRef.current = null;
      txCharRef.current = null;
      if (d) await d.cancelConnection().catch(() => undefined);
      pushZeroMetrics();
      fail('Connection failed', 'BLE / UART / ELM327 init failed.', e);
      setDeviceName('Not connected');
      setMacAddress('—');
    }
  }, [
    disconnectHardware,
    fail,
    prepareMonitor,
    pushZeroMetrics,
    resetTransportState,
    runElmInitSequence,
  ]);

  const connect = useCallback(() => void scanAndConnect(), [scanAndConnect]);

  const cancelScan = useCallback(async () => {
    resetTransportState();
    await disconnectHardware();
    pushZeroMetrics();
    setPhase('idle');
    setDeviceName('Not connected');
    setMacAddress('—');
  }, [disconnectHardware, pushZeroMetrics, resetTransportState]);

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
    connect,
    cancelScan,
    disconnect: disconnectCb,
  };
}
