import React, { useCallback, useMemo, useState, type SetStateAction } from 'react';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

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

const CAL_PROGRESS_GREEN = '#34ff94';

export default function PerformanceAnalyzerView(): React.ReactElement {
  const { width: winW, height: winH } = useWindowDimensions();
  const mono = (MONO_FONT as string) ?? 'monospace';
  const sv = useOscilloscopeSharedValues(winW, winH);

  const modalTrackW = useMemo(() => Math.max(220, Math.min(winW - 88, 380)), [winW]);

  const calProgressFillStyle = useAnimatedStyle(
    () => ({
      width: sv.calProgressSv.value * modalTrackW,
      height: '100%' as const,
      borderRadius: 3,
      backgroundColor: CAL_PROGRESS_GREEN,
    }),
    [modalTrackW, sv.calProgressSv]
  );

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

  const [precisionCalBusy, setPrecisionCalBusy] = useState(false);
  const settlePrecisionCalib = useCallback(() => setPrecisionCalBusy(false), []);

  const { hud } = useOscilloscopeTelemetryEngine(
    winW,
    winH,
    false,
    noopSetAdv,
    sv,
    isHfLoggingSv,
    appendHfData,
    settlePrecisionCalib
  );

  const { startPrecisionCalibrate } = useOscilloscopeCalibration({
    sv,
    resetBumpFsm,
    clearBumpDiagnostics,
    setPrecisionCalibBusy: setPrecisionCalBusy,
  });

  useForegroundGpsStream({ speedKmH: sv.speedKmH });

  const { latestResult, clearLatest } = usePerformanceAnalyzer({
    speedKmH: sv.speedKmH,
    pitchDeg: sv.dspPitchDeg,
    hasCalibSv: sv.hasCalibSv,
  });

  const recentPerformanceLine = latestResult
    ? latestResult.type === 'ACCEL'
      ? `0-60 km/h: ${latestResult.timeSeconds.toFixed(2)} sec (Squat: +${latestResult.maxPitchDeg.toFixed(1)}°)`
      : `60-0 km/h: ${latestResult.distanceMeters.toFixed(2)} meters (Dive: ${latestResult.maxPitchDeg.toFixed(1)}°)`
    : 'Idle — auto-detects squat launch (0-60) or dive braking (60-0).';

  return (
    <>
      <Modal
        visible={precisionCalBusy}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => {}}
      >
        <View style={styles.calModalBackdrop} pointerEvents="box-none">
          <View style={styles.calModalCard} accessibilityRole="progressbar">
            <Text style={[styles.calPrecTitle, { fontFamily: mono }]}>
              CALIBRATING... KEEP BIKE UPRIGHT
            </Text>
            <View style={[styles.calModalProgressTrack, { width: modalTrackW }]}>
              <Animated.View style={calProgressFillStyle} />
            </View>
          </View>
        </View>
      </Modal>

      <ScrollView style={styles.bottomPanel} contentContainerStyle={{ paddingBottom: 28, gap: 16 }}>
        <Text style={[styles.performanceAnalyzerTitle, { fontFamily: mono }]}>Brake Analyzer</Text>
        <Text style={[styles.performanceBullet, { fontFamily: mono }]}>
          ● Accel: creep below ~2 km/h with squat (+pitch &gt; ~1.5°), then accelerate to ≥60 km/h.
        </Text>
        <Text style={[styles.performanceBullet, { fontFamily: mono }]}>
          ● Brake: &gt;~40 km/h — hard braking with dive (pitch &lt; ~−2° and sharp speed drop).
        </Text>

        <View style={styles.hudSection}>
          <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Performance</Text>
          <View style={styles.performanceCard}>
            <Text style={[styles.performanceCardTitle, { fontFamily: mono }]}>RECENT</Text>
            <Text style={[styles.performanceCardMetric, { fontFamily: mono }]}>
              {recentPerformanceLine}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear last performance result display"
              disabled={precisionCalBusy}
              hitSlop={8}
              onPress={clearLatest}
            >
              <Text style={[styles.performanceHint, { fontFamily: mono }]}>Clear display</Text>
            </Pressable>
            <Text style={[styles.performanceHint, { fontFamily: mono }]}>
              GPS speed + IMU CAL required. Stay on this tab during a run so capture stays live.
            </Text>
          </View>
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
          accessibilityLabel="Calibrate IMU for gravity reference (~3 seconds)"
          disabled={precisionCalBusy}
          onPress={startPrecisionCalibrate}
          style={({ pressed }) => [
            styles.calBtn,
            precisionCalBusy && styles.calBtnDisabled,
            pressed && styles.calBtnPressed,
            { alignSelf: 'flex-start', paddingHorizontal: 20, paddingVertical: 14 },
          ]}
        >
          <View pointerEvents="none" style={styles.calGlow} />
          <Text style={[styles.calLabel, { fontFamily: mono }]}>CAL SENSOR</Text>
        </Pressable>

        <Text style={[styles.performanceHint, { fontFamily: mono }]}>
          GPS speed feeds this tab automatically. Calibrate stationary before sprint or brake tests.
        </Text>
      </ScrollView>
    </>
  );
}
