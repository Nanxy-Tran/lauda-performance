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

  const exportToJSON = useCallback(async () => {
    if (hfLogRef.current.length === 0) {
      Alert.alert('No HF telemetry to export');
      return;
    }
    const jsonStr = JSON.stringify(hfLogRef.current);
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
  }, []);

  const [calUiBanner, setCalUiBanner] = useState<string | null>(null);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [dashLocked, setDashLocked] = useState(false);
  const [bumpDiag, setBumpDiag] = useState<SuspensionBumpDiagResult | null>(null);
  const [telemetryPresetMode, setTelemetryPresetMode] = useState<TelemetryPresetMode>('HIGH_SPEED_IMPACT');
  const [dspPresetSyncNonce, setDspPresetSyncNonce] = useState(0);

  const onBumpEventComplete = useCallback((result: SuspensionBumpDiagResult) => {
    setBumpDiag(result);
  }, []);

  const selectTelemetryPreset = useCallback(
    (id: TelemetryPresetId) => {
      applyPresetConfig(TELEMETRY_PRESETS[id], {
        vertFastAlphaSv,
        sensitivityMultiplierSv,
        bumpThresholdG: bumpThresholdGsv,
        stableZoneG: stableZoneGsv,
      });
      setTelemetryPresetMode(id);
      setDspPresetSyncNonce((n) => n + 1);
    },
    [bumpThresholdGsv, sensitivityMultiplierSv, stableZoneGsv, vertFastAlphaSv]
  );

  const telemetryPresetLabel =
    telemetryPresetMode === 'custom' ? 'Custom DSP' : TELEMETRY_PRESETS[telemetryPresetMode].name;

  const { resetBumpFsm } = useSuspensionBumpFsm({
    vertZ: cleanVertZSv,
    hasCalib: hasCalibSv,
    onBumpComplete: onBumpEventComplete,
    bumpThresholdG: bumpThresholdGsv,
    stableZoneG: stableZoneGsv,
    stableHoldMs: stableHoldMssv,
    harshPeakG: harshPeakGsv,
    overdampedSettlingMs: overdampedSettlingMssv,
    zeroCrossEpsG: zeroCrossEpsGsv,
  });

  const { hud, onChartLayout, gridPath, baselinePath, oscilloscopePath } = useOscilloscopeTelemetryEngine(
    winW,
    winH,
    dashLocked,
    setAdvancedSettingsOpen,
    sv,
    isHfLoggingSv,
    appendHfData
  );

  const { instantCalibrate, resetPeakMax } = useOscilloscopeCalibration({
    sv,
    resetBumpFsm,
    setBumpDiag,
    setCalUiBanner,
  });

  return (
    <View style={styles.root}>
      <OscilloscopeChart
        gridPath={gridPath}
        baselinePath={baselinePath}
        oscilloscopePath={oscilloscopePath}
        onLayout={onChartLayout}
        calUiBanner={calUiBanner}
        mono={mono}
      />

      <OscilloscopeDashboard
        mono={mono}
        bottomInsetPad={insets.bottom}
        dashLocked={dashLocked}
        setDashLocked={setDashLocked}
        advancedSettingsOpen={advancedSettingsOpen}
        setAdvancedSettingsOpen={setAdvancedSettingsOpen}
        hud={hud}
        bumpDiag={bumpDiag}
        telemetryPresetMode={telemetryPresetMode}
        telemetryPresetLabel={telemetryPresetLabel}
        selectTelemetryPreset={selectTelemetryPreset}
        sv={sv}
        dspPresetSyncNonce={dspPresetSyncNonce}
        setTelemetryPresetMode={setTelemetryPresetMode}
        calUiBanner={calUiBanner}
        resetPeakMax={resetPeakMax}
        instantCalibrate={instantCalibrate}
        isHfLogging={isHfLogging}
        toggleHfLog={toggleHfLog}
        exportToJSON={exportToJSON}
      />
    </View>
  );
}
