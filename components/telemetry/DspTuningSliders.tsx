import Slider from '@react-native-community/slider';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

export type DspTuningSlidersProps = {
  mono: string;
  visible: boolean;
  vertFastAlphaSv: SharedValue<number>;
  sensitivityMultiplierSv: SharedValue<number>;
  bumpThresholdG: SharedValue<number>;
  stableZoneG: SharedValue<number>;
  stableHoldMs: SharedValue<number>;
  harshPeakG: SharedValue<number>;
  overdampedSettlingMs: SharedValue<number>;
  zeroCrossEpsG: SharedValue<number>;
  /** When sliders move, preset label can flip to Custom. */
  onUserTune?: () => void;
  /** Increment when SharedValues change from outside (e.g. telemetry preset) so sliders resync while open. */
  externalSyncNonce?: number;
};

type TuneKey =
  | 'vertFastAlpha'
  | 'sensitivityMultiplier'
  | 'bumpThresholdG'
  | 'stableZoneG'
  | 'stableHoldMs'
  | 'harshPeakG'
  | 'overdampedSettlingMs'
  | 'zeroCrossEpsG';

/** Live DSP / FSM tuning: sliders write SharedValues consumed by Worklets immediately. */
export function DspTuningSliders({
  mono,
  visible,
  vertFastAlphaSv,
  sensitivityMultiplierSv,
  bumpThresholdG,
  stableZoneG,
  stableHoldMs,
  harshPeakG,
  overdampedSettlingMs,
  zeroCrossEpsG,
  onUserTune,
  externalSyncNonce = 0,
}: DspTuningSlidersProps) {
  const [vals, setVals] = useState<Record<TuneKey, number>>(() => ({
    vertFastAlpha: vertFastAlphaSv.value,
    sensitivityMultiplier: sensitivityMultiplierSv.value,
    bumpThresholdG: bumpThresholdG.value,
    stableZoneG: stableZoneG.value,
    stableHoldMs: stableHoldMs.value,
    harshPeakG: harshPeakG.value,
    overdampedSettlingMs: overdampedSettlingMs.value,
    zeroCrossEpsG: zeroCrossEpsG.value,
  }));

  const syncFromShared = useCallback(() => {
    setVals({
      vertFastAlpha: vertFastAlphaSv.value,
      sensitivityMultiplier: sensitivityMultiplierSv.value,
      bumpThresholdG: bumpThresholdG.value,
      stableZoneG: stableZoneG.value,
      stableHoldMs: stableHoldMs.value,
      harshPeakG: harshPeakG.value,
      overdampedSettlingMs: overdampedSettlingMs.value,
      zeroCrossEpsG: zeroCrossEpsG.value,
    });
  }, [
    bumpThresholdG,
    harshPeakG,
    overdampedSettlingMs,
    sensitivityMultiplierSv,
    stableHoldMs,
    stableZoneG,
    vertFastAlphaSv,
    zeroCrossEpsG,
  ]);

  useEffect(() => {
    if (visible) {
      syncFromShared();
    }
  }, [visible, syncFromShared, externalSyncNonce]);

  const setTune = useCallback(
    (key: TuneKey, sv: SharedValue<number>, v: number) => {
      sv.value = v;
      setVals((p) => ({ ...p, [key]: v }));
      onUserTune?.();
    },
    [onUserTune]
  );

  const ROWS: {
    key: TuneKey;
    label: string;
    min: number;
    max: number;
    step: number;
    sv: SharedValue<number>;
    format: (n: number) => string;
  }[] = [
    {
      key: 'vertFastAlpha',
      label: 'VERT_FAST α (LPF)',
      min: 0.01,
      max: 0.2,
      step: 0.005,
      sv: vertFastAlphaSv,
      format: (n) => n.toFixed(3),
    },
    {
      key: 'sensitivityMultiplier',
      label: 'Chart gain (×)',
      min: 0.8,
      max: 10,
      step: 0.05,
      sv: sensitivityMultiplierSv,
      format: (n) => n.toFixed(2),
    },
    {
      key: 'bumpThresholdG',
      label: 'BUMP_THRESHOLD_G (g)',
      min: 0.1,
      max: 1.2,
      step: 0.01,
      sv: bumpThresholdG,
      format: (n) => n.toFixed(2),
    },
    {
      key: 'stableZoneG',
      label: 'STABLE_ZONE_G (g)',
      min: 0.05,
      max: 0.35,
      step: 0.01,
      sv: stableZoneG,
      format: (n) => n.toFixed(2),
    },
    {
      key: 'stableHoldMs',
      label: 'STABLE_HOLD_MS',
      min: 50,
      max: 800,
      step: 5,
      sv: stableHoldMs,
      format: (n) => n.toFixed(0),
    },
    {
      key: 'harshPeakG',
      label: 'HARSH_PEAK_G',
      min: 0.4,
      max: 3,
      step: 0.05,
      sv: harshPeakG,
      format: (n) => n.toFixed(2),
    },
    {
      key: 'overdampedSettlingMs',
      label: 'OVERDAMPED_SETTLING_MS',
      min: 200,
      max: 1500,
      step: 10,
      sv: overdampedSettlingMs,
      format: (n) => n.toFixed(0),
    },
    {
      key: 'zeroCrossEpsG',
      label: 'ZERO_CROSS_EPS_G',
      min: 0.015,
      max: 0.2,
      step: 0.005,
      sv: zeroCrossEpsG,
      format: (n) => n.toFixed(3),
    },
  ];

  return (
    <ScrollView
      nestedScrollEnabled
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      {ROWS.map((row) => (
        <View key={row.key} style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={[styles.rowLabel, { fontFamily: mono }]} numberOfLines={2}>
              {row.label}
            </Text>
            <Text style={[styles.rowValue, { fontFamily: mono }]}>{row.format(vals[row.key])}</Text>
          </View>
          <Slider
            style={styles.slider}
            minimumValue={row.min}
            maximumValue={row.max}
            step={row.step}
            value={vals[row.key]}
            minimumTrackTintColor="#2cff8a"
            maximumTrackTintColor="#2a3330"
            thumbTintColor="#c4f5dc"
            onValueChange={(v) => setTune(row.key, row.sv, v)}
          />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    maxHeight: 340,
    width: '100%',
  },
  scrollContent: {
    paddingBottom: 8,
    gap: 4,
  },
  row: {
    marginBottom: 10,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  rowLabel: {
    flex: 1,
    color: '#8a9e94',
    fontSize: 10,
    letterSpacing: 0.6,
  },
  rowValue: {
    color: '#c4f5dc',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    minWidth: 56,
    textAlign: 'right',
  },
  slider: {
    width: '100%',
    height: 36,
  },
});
