import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { AxisBumpAdviceCard } from './AxisBumpAdviceCard';
import { GpsTrackLogger } from '../GpsTrackLogger';
import { OscilloscopeSettingsDrawer } from './OscilloscopeSettingsDrawer';
import type { TelemetryPresetId, TelemetryPresetMode } from '../telemetryPresets';
import { HudMetricTile } from './HudMetricTile';
import type { HudSnap } from './types';
import type { SuspensionBumpDiagResult } from '../useSuspensionBumpFsm';
import type { OscilloscopeSharedValues } from './hooks/useOscilloscopeSharedValues';
import { styles } from './styles';

export type OscilloscopeDashboardProps = {
  mono: string;
  bottomInsetPad: number;

  dashLocked: boolean;
  setDashLocked: React.Dispatch<React.SetStateAction<boolean>>;

  advancedSettingsOpen: boolean;
  setAdvancedSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;

  hud: HudSnap;

  frontBumpDiag: SuspensionBumpDiagResult | null;
  rearBumpDiag: SuspensionBumpDiagResult | null;

  telemetryPresetMode: TelemetryPresetMode;
  telemetryPresetLabel: string;
  selectTelemetryPreset: (id: TelemetryPresetId) => void;

  sv: OscilloscopeSharedValues;
  dspPresetSyncNonce: number;
  setTelemetryPresetMode: React.Dispatch<React.SetStateAction<TelemetryPresetMode>>;

  precisionCalBusy: boolean;
  resetPeakMax: () => void;
  startPrecisionCalibrate: () => void;

  isHfLogging: boolean;
  toggleHfLog: () => void;
  exportToJSON: () => void;
};

export function OscilloscopeDashboard({
  mono,
  bottomInsetPad,
  dashLocked,
  setDashLocked,
  advancedSettingsOpen,
  setAdvancedSettingsOpen,
  hud,
  frontBumpDiag,
  rearBumpDiag,
  telemetryPresetMode,
  telemetryPresetLabel,
  selectTelemetryPreset,
  sv,
  dspPresetSyncNonce,
  setTelemetryPresetMode,
  precisionCalBusy,
  resetPeakMax,
  startPrecisionCalibrate,
  isHfLogging,
  toggleHfLog,
  exportToJSON,
}: OscilloscopeDashboardProps) {
  const { speedKmH, dspPeakVertZSv, dspPitchDeg, dspRollDeg } = sv;

  const rearWaitingPlaceholder =
    frontBumpDiag !== null && rearBumpDiag === null ? 'Waiting for rear impact…' : null;

  return (
    <>
      <ScrollView style={[styles.bottomPanel]} contentContainerStyle={{ paddingBottom: 12 + bottomInsetPad }}>
      <View style={styles.hudTopBar}>
        <View style={styles.logoCluster}>
          <Text style={[styles.logo, { fontFamily: mono }]}>LAUDA Performance</Text>
          <Text style={[styles.logoSub, { fontFamily: mono }]}>OSC DIAGRAM</Text>
          <Text style={[styles.presetDashboardBadge, { fontFamily: mono }]} numberOfLines={1}>
            Preset · {telemetryPresetLabel}
          </Text>
        </View>
        <View style={styles.dashboardTools}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dashLocked ? 'Unlock dashboard controls' : 'Lock dashboard controls'}
            onPress={() => setDashLocked((v) => !v)}
            style={({ pressed }) => [styles.toolBtn, pressed && styles.toolBtnPressed]}
          >
            <Ionicons
              name={dashLocked ? 'lock-closed' : 'lock-open-outline'}
              size={22}
              color={dashLocked ? '#5cff9b' : '#6b7a72'}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open advanced filter settings"
            disabled={dashLocked}
            onPress={() => !dashLocked && setAdvancedSettingsOpen(true)}
            style={({ pressed }) => [
              styles.toolBtn,
              dashLocked && styles.toolBtnDisabled,
              pressed && styles.toolBtnPressed,
            ]}
          >
            <Ionicons name="settings-outline" size={22} color={dashLocked ? '#3a453f' : '#6b7a72'} />
          </Pressable>
        </View>
      </View>

      <View style={styles.presetSwitchRow}>
        <View style={[styles.presetSegmentTrack, dashLocked && styles.presetSegmentTrackLocked]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="High speed bump preset — lower chart gain, bump analysis above 0.35 g"
            accessibilityState={{ selected: telemetryPresetMode === 'HIGH_SPEED_IMPACT' }}
            disabled={dashLocked}
            onPress={() => selectTelemetryPreset('HIGH_SPEED_IMPACT')}
            style={({ pressed }) => [
              styles.presetSegmentBtn,
              styles.presetSegmentLeft,
              telemetryPresetMode === 'HIGH_SPEED_IMPACT' && styles.presetSegmentBtnActive,
              pressed && telemetryPresetMode !== 'HIGH_SPEED_IMPACT' && styles.presetSegmentBtnPressed,
              dashLocked && styles.presetSegmentBtnDisabled,
            ]}
          >
            <Text
              style={[
                styles.presetSegmentLbl,
                telemetryPresetMode === 'HIGH_SPEED_IMPACT' && styles.presetSegmentLblActive,
                { fontFamily: mono },
              ]}
            >
              IMPACT
            </Text>
          </Pressable>
          <View style={styles.presetSegmentDivider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Smooth micro-vibration preset — higher alpha and gain, bump threshold 0.10 g"
            accessibilityState={{ selected: telemetryPresetMode === 'SMOOTH_SURFACE' }}
            disabled={dashLocked}
            onPress={() => selectTelemetryPreset('SMOOTH_SURFACE')}
            style={({ pressed }) => [
              styles.presetSegmentBtn,
              styles.presetSegmentRight,
              telemetryPresetMode === 'SMOOTH_SURFACE' && styles.presetSegmentBtnActive,
              pressed && telemetryPresetMode !== 'SMOOTH_SURFACE' && styles.presetSegmentBtnPressed,
              dashLocked && styles.presetSegmentBtnDisabled,
            ]}
          >
            <Text
              style={[
                styles.presetSegmentLbl,
                telemetryPresetMode === 'SMOOTH_SURFACE' && styles.presetSegmentLblActive,
                { fontFamily: mono },
              ]}
            >
              CHATTER
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.hudMetricsPanel}>
        <View style={styles.hudSection}>
          <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Motion</Text>
          <View style={styles.hudMetricRow}>
            <HudMetricTile label="SPD" value={hud.speed.toFixed(1)} suffix="km/h" mono={mono} />
            <HudMetricTile
              label="Pitch"
              value={`${hud.pitch >= 0 ? '+' : ''}${hud.pitch.toFixed(1)}`}
              suffix="°"
              mono={mono}
            />
            <HudMetricTile
              label="Roll"
              value={`${hud.roll >= 0 ? '+' : ''}${hud.roll.toFixed(1)}`}
              suffix="°"
              mono={mono}
            />
          </View>
        </View>

        <View style={styles.hudSection}>
          <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Acceleration</Text>
          <View style={styles.hudMetricRow}>
            <HudMetricTile label="Peak G" value={hud.peak.toFixed(2)} suffix="g" alert mono={mono} />
            <HudMetricTile label="Vert Z" value={hud.zG.toFixed(2)} suffix="g" muted mono={mono} />
          </View>
        </View>

        <View style={styles.hudSection}>
          <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Suspension · dual axis</Text>
          <View style={styles.bumpAdviceRowDual}>
            <AxisBumpAdviceCard
              axisTitle="Front Fork"
              diag={frontBumpDiag}
              mono={mono}
              showPitchBadge
              rearWaitingPlaceholder={null}
            />
            <AxisBumpAdviceCard
              axisTitle="Rear Shock"
              diag={rearBumpDiag}
              mono={mono}
              showPitchBadge={false}
              rearWaitingPlaceholder={rearWaitingPlaceholder}
            />
          </View>
        </View>

        {/*<View style={styles.hudSection}>*/}
        {/*  <View style={styles.hudMetricRow}>*/}
        {/*    <HudMetricTile label="Roll left" value={hud.peakRollLeft.toFixed(1)} suffix="°" mono={mono} />*/}
        {/*    <HudMetricTile label="Roll right" value={hud.peakRollRight.toFixed(1)} suffix="°" mono={mono} />*/}
        {/*    <HudMetricTile label="Peak Vert Z" value={hud.peakVertZ.toFixed(2)} suffix="g" mono={mono} />*/}
        {/*  </View>*/}
        {/*</View>*/}
      </View>

      <View style={styles.calRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset peak G and angle maximums to zero"
          disabled={dashLocked || precisionCalBusy}
          onPress={resetPeakMax}
          style={({ pressed }) => [
            styles.resetMaxBtn,
            (dashLocked || precisionCalBusy) && styles.resetMaxBtnDisabled,
            pressed && styles.resetMaxBtnPressed,
          ]}
        >
          <Text style={[styles.resetMaxLabel, { fontFamily: mono }]}>RESET MAX</Text>
        </Pressable>
        <GpsTrackLogger
          speedKmH={speedKmH}
          dspPeakVertZSv={dspPeakVertZSv}
          dspPitchDeg={dspPitchDeg}
          dspRollDeg={dspRollDeg}
          dashLocked={dashLocked}
          mono={mono}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Precision calibration: average gravity axis over ~3 seconds. Long press to open filter settings."
          disabled={precisionCalBusy}
          onPress={startPrecisionCalibrate}
          onLongPress={() => {
            if (!dashLocked && !precisionCalBusy) setAdvancedSettingsOpen(true);
          }}
          delayLongPress={450}
          style={() => [styles.calBtn, precisionCalBusy && styles.calBtnDisabled]}
        >
          <View pointerEvents="none" style={styles.calGlow} />
          <Text style={[styles.calLabel, { fontFamily: mono }]}>CAL</Text>
        </Pressable>
      </View>

      <View style={styles.hfTelemetryRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isHfLogging ? 'Stop high-frequency JSON telemetry' : 'Start high-frequency JSON telemetry'}
          disabled={dashLocked}
          onPress={toggleHfLog}
          style={({ pressed }) => [
            styles.hfJsonRecBtn,
            dashLocked && styles.hfJsonRecBtnDisabled,
            isHfLogging && styles.hfJsonRecBtnOn,
            pressed && styles.hfJsonRecBtnPressed,
          ]}
        >
          <Text style={[styles.hfJsonRecLabel, { fontFamily: mono }]}>{isHfLogging ? 'REC JSON ●' : 'REC JSON'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Export HF telemetry JSON"
          disabled={isHfLogging || dashLocked}
          onPress={() => {
            void exportToJSON();
          }}
          style={({ pressed }) => [
            styles.hfJsonExportBtn,
            (isHfLogging || dashLocked) && styles.hfJsonExportBtnDisabled,
            pressed && styles.hfJsonExportBtnPressed,
          ]}
        >
          <Text style={[styles.hfJsonExportLabel, { fontFamily: mono }]}>EXP JSON</Text>
        </Pressable>
      </View>
    </ScrollView>
      <OscilloscopeSettingsDrawer
        visible={advancedSettingsOpen && !dashLocked}
        onClose={() => setAdvancedSettingsOpen(false)}
        mono={mono}
        sv={sv}
        dspPresetSyncNonce={dspPresetSyncNonce}
        setTelemetryPresetMode={setTelemetryPresetMode}
      />
    </>
  );
}
