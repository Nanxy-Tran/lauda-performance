import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { DspTuningSliders } from '../DspTuningSliders';
import { GpsTrackLogger } from '../GpsTrackLogger';
import type { TelemetryPresetId, TelemetryPresetMode } from '../telemetryPresets';
import { HudMetricTile } from './HudMetricTile';
import { SuspensionBumpDiagCard } from './SuspensionBumpDiagCard';
import { styles } from './styles';
import type { HudSnap } from './types';
import type { OscilloscopeSharedValues } from './hooks/useOscilloscopeSharedValues';
import type { SuspensionBumpDiagResult } from '../useSuspensionBumpFsm';

export type OscilloscopeDashboardProps = {
  mono: string;
  bottomInsetPad: number;

  dashLocked: boolean;
  setDashLocked: React.Dispatch<React.SetStateAction<boolean>>;

  advancedSettingsOpen: boolean;
  setAdvancedSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;

  hud: HudSnap;

  bumpDiag: SuspensionBumpDiagResult | null;

  telemetryPresetMode: TelemetryPresetMode;
  telemetryPresetLabel: string;
  selectTelemetryPreset: (id: TelemetryPresetId) => void;

  sv: OscilloscopeSharedValues;
  dspPresetSyncNonce: number;
  setTelemetryPresetMode: React.Dispatch<React.SetStateAction<TelemetryPresetMode>>;

  calUiBanner: string | null;
  resetPeakMax: () => void;
  instantCalibrate: () => void;
};

export function OscilloscopeDashboard({
  mono,
  bottomInsetPad,
  dashLocked,
  setDashLocked,
  advancedSettingsOpen,
  setAdvancedSettingsOpen,
  hud,
  bumpDiag,
  telemetryPresetMode,
  telemetryPresetLabel,
  selectTelemetryPreset,
  sv,
  dspPresetSyncNonce,
  setTelemetryPresetMode,
  calUiBanner,
  resetPeakMax,
  instantCalibrate,
}: OscilloscopeDashboardProps) {
  const {
    speedKmH,
    vertFastAlphaSv,
    sensitivityMultiplierSv,
    bumpThresholdGsv,
    stableZoneGsv,
    stableHoldMssv,
    harshPeakGsv,
    overdampedSettlingMssv,
    zeroCrossEpsGsv,
    dspPeakVertZSv,
  } = sv;

  return (
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
            accessibilityLabel="Toggle advanced filter settings"
            disabled={dashLocked}
            onPress={() => !dashLocked && setAdvancedSettingsOpen((v) => !v)}
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
          <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Suspension · bump</Text>
          <SuspensionBumpDiagCard diag={bumpDiag} mono={mono} />
        </View>

        <View style={styles.hudSection}>
          <View style={styles.hudMetricRow}>
            <HudMetricTile label="Roll left" value={hud.peakRollLeft.toFixed(1)} suffix="°" mono={mono} />
            <HudMetricTile label="Roll right" value={hud.peakRollRight.toFixed(1)} suffix="°" mono={mono} />
            <HudMetricTile label="Peak Vert Z" value={hud.peakVertZ.toFixed(2)} suffix="g" mono={mono} />
          </View>
        </View>
      </View>

      {advancedSettingsOpen && !dashLocked ? (
        <View style={styles.advancedPanel}>
          <Text style={[styles.advancedTitle, { fontFamily: mono }]}>
            DSP · FSM LIVE TUNING · 1200cc @ ~45 km/h baseline
          </Text>
          <DspTuningSliders
            mono={mono}
            visible={advancedSettingsOpen && !dashLocked}
            vertFastAlphaSv={vertFastAlphaSv}
            sensitivityMultiplierSv={sensitivityMultiplierSv}
            bumpThresholdG={bumpThresholdGsv}
            stableZoneG={stableZoneGsv}
            stableHoldMs={stableHoldMssv}
            harshPeakG={harshPeakGsv}
            overdampedSettlingMs={overdampedSettlingMssv}
            zeroCrossEpsG={zeroCrossEpsGsv}
            onUserTune={() => setTelemetryPresetMode('custom')}
            externalSyncNonce={dspPresetSyncNonce}
          />
        </View>
      ) : null}

      <View style={styles.calRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset peak G and angle maximums to zero"
          disabled={dashLocked || calUiBanner !== null}
          onPress={resetPeakMax}
          style={({ pressed }) => [
            styles.resetMaxBtn,
            (dashLocked || calUiBanner !== null) && styles.resetMaxBtnDisabled,
            pressed && styles.resetMaxBtnPressed,
          ]}
        >
          <Text style={[styles.resetMaxLabel, { fontFamily: mono }]}>RESET MAX</Text>
        </Pressable>
        <GpsTrackLogger speedKmH={speedKmH} dspPeakVertZSv={dspPeakVertZSv} dashLocked={dashLocked} mono={mono} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Instant calibration: snap vertical axis to zero using current gravity. Long press to open filter settings."
          disabled={calUiBanner !== null}
          onPress={instantCalibrate}
          delayLongPress={450}
          style={() => [styles.calBtn, calUiBanner !== null && styles.calBtnDisabled]}
        >
          <View pointerEvents="none" style={styles.calGlow} />
          <Text style={[styles.calLabel, { fontFamily: mono }]}>CAL</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
