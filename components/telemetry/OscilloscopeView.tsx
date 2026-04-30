import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useRef, useState } from 'react';
import { Alert, useWindowDimensions, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  applyPresetConfig,
  TELEMETRY_PRESETS,
  type TelemetryPresetId,
  type TelemetryPresetMode,
} from './telemetryPresets';
import {
  type SuspensionBumpDiagResult,
  useSuspensionBumpFsm,
} from './useSuspensionBumpFsm';
import { WHEELBASE_M } from './oscilloscope/dspConstants';
import { MONO_FONT } from './oscilloscope/constants';
import { OscilloscopeChart } from './oscilloscope/OscilloscopeChart';
import { OscilloscopeDashboard } from './oscilloscope/OscilloscopeDashboard';
import { styles } from './oscilloscope/styles';
import { useOscilloscopeCalibration } from './oscilloscope/hooks/useOscilloscopeCalibration';
import { useOscilloscopeSharedValues } from './oscilloscope/hooks/useOscilloscopeSharedValues';
import { useOscilloscopeTelemetryEngine } from './oscilloscope/hooks/useOscilloscopeTelemetryEngine';

export default function OscilloscopeView() {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
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
    vertFastAlphaSv,
    sensitivityMultiplierSv,
  } = sv;

  const hfLogRef = useRef<any[]>([]);
  const isHfLoggingSv = useSharedValue(0);
  const [isHfLogging, setIsHfLogging] = useState(false);

  const appendHfData = useCallback((z: number, pitch: number, roll: number, speed: number) => {
    hfLogRef.current.push({
      t: Date.now(),
      z: Number(z.toFixed(3)),
      p: Number(pitch.toFixed(1)),
      r: Number(roll.toFixed(1)),
      s: Number(speed.toFixed(1)),
    });
  }, []);

  const toggleHfLog = useCallback(() => {
    setIsHfLogging((prev) => {
      const turningOn = !prev;
      if (turningOn) {
        hfLogRef.current = [];
        isHfLoggingSv.value = 1;
      } else {
        isHfLoggingSv.value = 0;
      }
      return turningOn;
    });
  }, [isHfLoggingSv]);

  const [precisionCalBusy, setPrecisionCalBusy] = useState(false);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [dashLocked, setDashLocked] = useState(false);
  const [frontBumpDiag, setFrontBumpDiag] = useState<SuspensionBumpDiagResult | null>(null);
  const [rearBumpDiag, setRearBumpDiag] = useState<SuspensionBumpDiagResult | null>(null);
  const [telemetryPresetMode, setTelemetryPresetMode] = useState<TelemetryPresetMode>('HIGH_SPEED_IMPACT');
  const [dspPresetSyncNonce, setDspPresetSyncNonce] = useState(0);

  const exportToJSON = useCallback(async () => {
    if (hfLogRef.current.length === 0) {
      Alert.alert('No HF telemetry to export');
      return;
    }
    const currentConfig =
      telemetryPresetMode === 'custom'
        ? {
            name: 'Custom',
            alpha: vertFastAlphaSv.value,
            multiplier: sensitivityMultiplierSv.value,
            threshold: bumpThresholdGsv.value,
            stableZone: stableZoneGsv.value,
            stableHoldMs: stableHoldMssv.value,
            harshPeakG: harshPeakGsv.value,
            overdampedSettlingMs: overdampedSettlingMssv.value,
          }
        : TELEMETRY_PRESETS[telemetryPresetMode];
    const exportPayload = {
      metadata: {
        exportTime: new Date().toISOString(),
        presetMode: telemetryPresetMode,
        config: currentConfig,
        wheelbase_m: WHEELBASE_M,
      },
      data: hfLogRef.current,
    };
    const jsonStr = JSON.stringify(exportPayload);
    const baseUri = FileSystem.documentDirectory;
    if (!baseUri) {
      Alert.alert('Export failed', 'Documents directory unavailable.');
      return;
    }
    const uri = `${baseUri}Lauda_HF_${Date.now()}.json`;
    try {
      await FileSystem.writeAsStringAsync(uri, jsonStr, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      await Sharing.shareAsync(uri);
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : 'Could not write or share.');
    }
  }, [
    bumpThresholdGsv,
    harshPeakGsv,
    overdampedSettlingMssv,
    sensitivityMultiplierSv,
    stableHoldMssv,
    stableZoneGsv,
    telemetryPresetMode,
    vertFastAlphaSv,
  ]);

  const onDiagnosticsReady = useCallback(
    (front: SuspensionBumpDiagResult, rear: SuspensionBumpDiagResult | null) => {
      setFrontBumpDiag(front);
      setRearBumpDiag(rear);
    },
    []
  );

  const clearBumpDiagnostics = useCallback(() => {
    setFrontBumpDiag(null);
    setRearBumpDiag(null);
  }, []);

  const selectTelemetryPreset = useCallback(
    (id: TelemetryPresetId) => {
      applyPresetConfig(TELEMETRY_PRESETS[id], {
        vertFastAlphaSv,
        sensitivityMultiplierSv,
        bumpThresholdG: bumpThresholdGsv,
        stableZoneG: stableZoneGsv,
        stableHoldMs: stableHoldMssv,
        harshPeakG: harshPeakGsv,
        overdampedSettlingMs: overdampedSettlingMssv,
      });
      setTelemetryPresetMode(id);
      setDspPresetSyncNonce((n) => n + 1);
    },
    [
      bumpThresholdGsv,
      harshPeakGsv,
      overdampedSettlingMssv,
      sensitivityMultiplierSv,
      stableHoldMssv,
      stableZoneGsv,
      vertFastAlphaSv,
    ]
  );

  const telemetryPresetLabel =
    telemetryPresetMode === 'custom' ? 'Custom DSP' : TELEMETRY_PRESETS[telemetryPresetMode].name;

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

  const settlePrecisionCalib = useCallback(() => setPrecisionCalBusy(false), []);

  const {
    hud,
    onChartLayout,
    gridPath,
    baselinePath,
    oscilloscopePath,
    terrainKindSv,
    terrainOverlayOpacitySv,
  } = useOscilloscopeTelemetryEngine(
    winW,
    winH,
    dashLocked,
    setAdvancedSettingsOpen,
    sv,
    isHfLoggingSv,
    appendHfData,
    settlePrecisionCalib
  );

  const { startPrecisionCalibrate, resetPeakMax } = useOscilloscopeCalibration({
    sv,
    resetBumpFsm,
    clearBumpDiagnostics,
    setPrecisionCalibBusy: setPrecisionCalBusy,
  });

  return (
    <View style={styles.root}>
      <OscilloscopeChart
        gridPath={gridPath}
        baselinePath={baselinePath}
        oscilloscopePath={oscilloscopePath}
        terrainKindSv={terrainKindSv}
        terrainOverlayOpacitySv={terrainOverlayOpacitySv}
        onLayout={onChartLayout}
        mono={mono}
        calStateSv={sv.calStateSv}
        calProgressSv={sv.calProgressSv}
        chartWsv={sv.chartWsv}
      />

      <OscilloscopeDashboard
        mono={mono}
        bottomInsetPad={insets.bottom}
        dashLocked={dashLocked}
        setDashLocked={setDashLocked}
        advancedSettingsOpen={advancedSettingsOpen}
        setAdvancedSettingsOpen={setAdvancedSettingsOpen}
        hud={hud}
        frontBumpDiag={frontBumpDiag}
        rearBumpDiag={rearBumpDiag}
        telemetryPresetMode={telemetryPresetMode}
        telemetryPresetLabel={telemetryPresetLabel}
        selectTelemetryPreset={selectTelemetryPreset}
        sv={sv}
        dspPresetSyncNonce={dspPresetSyncNonce}
        setTelemetryPresetMode={setTelemetryPresetMode}
        precisionCalBusy={precisionCalBusy}
        resetPeakMax={resetPeakMax}
        startPrecisionCalibrate={startPrecisionCalibrate}
        isHfLogging={isHfLogging}
        toggleHfLog={toggleHfLog}
        exportToJSON={exportToJSON}
      />
    </View>
  );
}
