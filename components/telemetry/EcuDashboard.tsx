import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import {
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
} from 'react-native-reanimated';

import { useObd2Bluetooth, type EcMetricSnapshot } from './useObd2Bluetooth';
import { MONO_FONT } from './oscilloscope/constants';
import { HudMetricTile } from './oscilloscope/HudMetricTile';
import { styles } from './oscilloscope/styles';

const ZERO_SNAPSHOT: EcMetricSnapshot = {
  rpm: 0,
  coolant: 0,
  intake: 0,
  tps: 0,
  batt: 0,
  ecuSpeed: 0,
};

type HudStrings = {
  rpm: string;
  coolant: string;
  intake: string;
  tps: string;
  batt: string;
  speed: string;
};

function snapshotToHudStrings(m: EcMetricSnapshot): HudStrings {
  return {
    rpm: String(Math.round(m.rpm)),
    coolant: String(Math.round(m.coolant)),
    intake: String(Math.round(m.intake)),
    tps: m.tps.toFixed(1),
    batt: m.batt.toFixed(1),
    speed: String(Math.round(m.ecuSpeed)),
  };
}

export default function EcuDashboard() {
  const mono = (MONO_FONT as string) ?? 'monospace';

  const rpmSv = useSharedValue(0);
  const coolantSv = useSharedValue(0);
  const intakeSv = useSharedValue(0);
  const tpsSv = useSharedValue(0);
  const battSv = useSharedValue(0);
  const speedSv = useSharedValue(0);

  const [disp, setDisp] = useState<HudStrings>(() => snapshotToHudStrings(ZERO_SNAPSHOT));

  const flushHudFromSv = useCallback(
    (r: number, c: number, i: number, t: number, b: number, s: number) => {
      setDisp({
        rpm: String(Math.round(r)),
        coolant: String(Math.round(c)),
        intake: String(Math.round(i)),
        tps: t.toFixed(1),
        batt: b.toFixed(1),
        speed: String(Math.round(s)),
      });
    },
    []
  );

  useAnimatedReaction(
    () =>
      `${rpmSv.value}|${coolantSv.value}|${intakeSv.value}|${tpsSv.value}|${battSv.value}|${speedSv.value}`,
    (sig, prev) => {
      if (sig === prev) {
        return;
      }
      const p = sig.split('|');
      runOnJS(flushHudFromSv)(
        Number(p[0]),
        Number(p[1]),
        Number(p[2]),
        Number(p[3]),
        Number(p[4]),
        Number(p[5])
      );
    },
    [flushHudFromSv]
  );

  useEffect(() => {
    flushHudFromSv(
      rpmSv.value,
      coolantSv.value,
      intakeSv.value,
      tpsSv.value,
      battSv.value,
      speedSv.value
    );
  }, [rpmSv, coolantSv, intakeSv, tpsSv, battSv, speedSv, flushHudFromSv]);

  const onBleError = useCallback((title: string, message: string) => {
    Alert.alert(title, message);
  }, []);

  const applyMetricsFromBle = useCallback(
    (m: EcMetricSnapshot) => {
      rpmSv.value = m.rpm;
      coolantSv.value = m.coolant;
      intakeSv.value = m.intake;
      tpsSv.value = m.tps;
      battSv.value = m.batt;
      speedSv.value = m.ecuSpeed;
    },
    [battSv, coolantSv, intakeSv, rpmSv, speedSv, tpsSv]
  );

  const { phase, deviceName, macAddress, latencyMsDisplay, connect, cancelScan, disconnect } =
    useObd2Bluetooth({
      onMetrics: applyMetricsFromBle,
      onError: onBleError,
    });

  const latencyLabel =
    latencyMsDisplay === '—' ? '—' : `${latencyMsDisplay} ms`;

  const primaryLabel =
    phase === 'connected'
      ? 'DISCONNECT'
      : phase === 'scanning'
        ? 'CANCEL SCAN'
        : phase === 'error'
          ? 'RETRY CONNECT'
          : 'OBD CONNECT';

  const onPrimaryPress =
    phase === 'connected'
      ? () => void disconnect()
      : phase === 'scanning'
        ? () => void cancelScan()
        : () => connect();

  return (
    <ScrollView
      style={styles.bottomPanel}
      contentContainerStyle={{ paddingBottom: 28 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hudTopBar}>
        <View style={styles.logoCluster}>
          <Text style={[styles.logo, { fontFamily: mono }]}>LAUDA Lab</Text>
          <Text style={[styles.ecuScreenTitle, { fontFamily: mono }]}>ECU TELEMETRY</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            phase === 'connected'
              ? 'Disconnect OBD adapter'
              : phase === 'scanning'
                ? 'Cancel Bluetooth scan'
                : phase === 'error'
                  ? 'Retry connecting to OBD adapter'
                  : 'Scan and connect OBD adapter'
          }
          onPress={onPrimaryPress}
          style={({ pressed }) => [
            styles.ecuConnectBtn,
            phase === 'scanning' && styles.ecuConnectBtnScanning,
            phase === 'connected' && styles.ecuConnectBtnConnected,
            phase === 'error' && styles.ecuConnectBtnError,
            pressed && styles.calBtnPressed,
          ]}
        >
          <View pointerEvents="none" style={styles.ecuConnectGlow} />
          <Text
            style={[
              styles.ecuConnectLabel,
              { fontFamily: mono },
              phase === 'scanning' && styles.ecuConnectLabelScanning,
              phase === 'connected' && styles.ecuConnectLabelConnected,
              phase === 'error' && styles.ecuConnectLabelError,
            ]}
          >
            {primaryLabel}
          </Text>
        </Pressable>
      </View>

      <View style={styles.hudSection}>
        <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Connection</Text>
        <View style={styles.performanceCard}>
          <View style={styles.ecuInfoRow}>
            <Text style={[styles.ecuInfoKey, { fontFamily: mono }]}>Device</Text>
            <Text style={[styles.ecuInfoVal, { fontFamily: mono }]} numberOfLines={1}>
              {deviceName}
            </Text>
          </View>
          <View style={styles.ecuInfoRow}>
            <Text style={[styles.ecuInfoKey, { fontFamily: mono }]}>MAC / ID</Text>
            <Text style={[styles.ecuInfoVal, { fontFamily: mono }]} numberOfLines={1}>
              {macAddress}
            </Text>
          </View>
          <View style={styles.ecuInfoRow}>
            <Text style={[styles.ecuInfoKey, { fontFamily: mono }]}>Latency</Text>
            <Text style={[styles.ecuInfoVal, { fontFamily: mono }]}>{latencyLabel}</Text>
          </View>
        </View>
      </View>

      <View style={[styles.hudSection, { marginTop: 4 }]}>
        <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Live ECU</Text>
        <View style={styles.hudMetricRow}>
          <HudMetricTile label="RPM" value={disp.rpm} suffix="rpm" mono={mono} />
          <HudMetricTile label="Coolant" value={disp.coolant} suffix="°C" mono={mono} />
          <HudMetricTile label="Intake" value={disp.intake} suffix="°C" mono={mono} />
        </View>
        <View style={[styles.hudMetricRow, { marginTop: 10 }]}>
          <HudMetricTile label="TPS" value={disp.tps} suffix="%" mono={mono} />
          <HudMetricTile label="Batt" value={disp.batt} suffix="V" mono={mono} />
          <HudMetricTile label="ECU speed" value={disp.speed} suffix="km/h" mono={mono} />
        </View>
      </View>

      <Text style={[styles.performanceHint, { fontFamily: mono, marginTop: 10 }]}>
        ELM327 over BLE · ignition on · decoded values arrive only while the ECU link is alive.
      </Text>
    </ScrollView>
  );
}
