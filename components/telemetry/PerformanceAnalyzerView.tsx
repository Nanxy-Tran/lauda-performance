import React, { useCallback, useMemo, useState, type SetStateAction } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import type { SuspensionBumpDiagResult } from './useSuspensionBumpFsm';
import { useSuspensionBumpFsm } from './useSuspensionBumpFsm';
import { useForegroundGpsStream } from './useForegroundGpsStream';
import { MONO_FONT } from './oscilloscope/constants';
import { HudMetricTile } from './oscilloscope/HudMetricTile';
import { useOscilloscopeCalibration } from './oscilloscope/hooks/useOscilloscopeCalibration';
import { useOscilloscopeSharedValues } from './oscilloscope/hooks/useOscilloscopeSharedValues';
import { useOscilloscopeTelemetryEngine } from './oscilloscope/hooks/useOscilloscopeTelemetryEngine';
import { styles } from './oscilloscope/styles';
import { usePerformanceAnalyzer } from './usePerformanceAnalyzer';

export default function PerformanceAnalyzerView(): React.ReactElement {
  const { width: winW, height: winH } = useWindowDimensions();
  const mono = (MONO_FONT as string) ?? 'monospace';
  const sv = useOscilloscopeSharedValues(winW, winH);

  const {
    cleanVertZSv,
    hasCalibSv,
    bumpThresholdGsv,
    stableZoneGsv,
    stableHoldMssv,
    harshPeakGsv,
    overdampedSettlingMssv,
    zeroCrossEpsGsv,
  } = sv;

  const onDiagnosticsReady = useCallback(
    (_front: SuspensionBumpDiagResult, _rear: SuspensionBumpDiagResult | null) => {},
    []
  );

  const clearBumpDiagnostics = useCallback(() => {}, []);

  const { resetBumpFsm } = useSuspensionBumpFsm({
    vertZ: cleanVertZSv,
    hasCalib: hasCalibSv,
    pitchDeg: sv.dspPitchDeg,
    onDiagnosticsReady,
    bumpThresholdG: bumpThresholdGsv,
    stableZoneG: stableZoneGsv,
    stableHoldMs: stableHoldMssv,
    harshPeakG: harshPeakGsv,
    overdampedSettlingMs: overdampedSettlingMssv,
    zeroCrossEpsG: zeroCrossEpsGsv,
    speedKmH: sv.speedKmH,
  });

  const appendHfData = useMemo(() => (_z: number, _p: number, _r: number, _s: number) => {}, []);

  const isHfLoggingSv = useSharedValue(0);

  const noopSetAdv = useCallback((_u: SetStateAction<boolean>) => {}, []);

  const { hud } = useOscilloscopeTelemetryEngine(
    winW,
    winH,
    false,
    noopSetAdv,
    sv,
    isHfLoggingSv,
    appendHfData
  );

  const [calUiBanner, setCalUiBanner] = useState<string | null>(null);

  const { instantCalibrate } = useOscilloscopeCalibration({
    sv,
    resetBumpFsm,
    clearBumpDiagnostics,
    setCalUiBanner,
  });

  useForegroundGpsStream({ speedKmH: sv.speedKmH });

  const { latestResult, clearLatest } = usePerformanceAnalyzer({
    speedKmH: sv.speedKmH,
    pitchDeg: sv.dspPitchDeg,
    hasCalibSv: sv.hasCalibSv,
  });

  const resultCopy = latestResult
    ? latestResult.type === 'ACCEL'
      ? `0-60 km/h: ${latestResult.timeSeconds.toFixed(2)} sec (Squat: +${latestResult.maxPitchDeg.toFixed(1)}°)`
      : `60-0 km/h: ${latestResult.distanceMeters.toFixed(2)} meters (Dive: ${latestResult.maxPitchDeg.toFixed(1)}°)`
    : null;

  return (
    <ScrollView style={styles.bottomPanel} contentContainerStyle={{ paddingBottom: 28, gap: 16 }}>
      {calUiBanner ? (
        <View style={styles.performanceCalibrationFlash}>
          <Text style={styles.calBannerText}>{calUiBanner}</Text>
        </View>
      ) : null}

      <Text style={[styles.performanceAnalyzerTitle, { fontFamily: mono }]}>LAB · ANALYZER</Text>
      <Text style={[styles.performanceBullet, { fontFamily: mono }]}>
        ● Accel: creep below ~2 km/h with squat (+pitch &gt; ~1.5°), then accelerate to ≥60 km/h.
      </Text>
      <Text style={[styles.performanceBullet, { fontFamily: mono }]}>
        ● Brake: &gt;~40 km/h — hard braking with dive (pitch &lt; ~−2° and sharp speed drop).
      </Text>

      <View style={styles.performanceCard}>
        <Text style={[styles.performanceCardTitle, { fontFamily: mono }]}>LAST CAPTURE</Text>
        <Text style={[styles.performanceCardMetric, { fontFamily: mono }]}>
          {resultCopy ?? 'No completed run yet'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear last performance result display"
          hitSlop={8}
          onPress={clearLatest}
        >
          <Text style={[styles.performanceHint, { fontFamily: mono }]}>Clear display</Text>
        </Pressable>
      </View>

      <View style={styles.hudSection}>
        <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Live</Text>
        <View style={styles.hudMetricRow}>
          <HudMetricTile label="SPD" value={hud.speed.toFixed(1)} suffix="km/h" mono={mono} />
          <HudMetricTile
            label="Pitch"
            value={`${hud.pitch >= 0 ? '+' : ''}${hud.pitch.toFixed(1)}`}
            suffix="°"
            mono={mono}
          />
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Calibrate IMU for gravity reference"
        disabled={calUiBanner !== null}
        onPress={instantCalibrate}
        style={({ pressed }) => [
          styles.resetMaxBtn,
          calUiBanner !== null && styles.resetMaxBtnDisabled,
          pressed && styles.resetMaxBtnPressed,
          { alignSelf: 'flex-start' },
        ]}
      >
        <Text style={[styles.resetMaxLabel, { fontFamily: mono }]}>CAL SENSOR</Text>
      </Pressable>

      <Text style={[styles.performanceHint, { fontFamily: mono }]}>
        GPS speed feeds the analyzer automatically in this tab. Calibrate stationary before sprint tests.
      </Text>
    </ScrollView>
  );
}
