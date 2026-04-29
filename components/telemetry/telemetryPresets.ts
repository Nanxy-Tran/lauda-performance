import type { SharedValue } from 'react-native-reanimated';

export type PresetConfig = {
  alpha: number;
  multiplier: number;
  threshold: number;
  stableZone: number;
  stableHoldMs: number;
  harshPeakG: number;
  overdampedSettlingMs: number;
  name: string;
};

/**
 * RACING / HIGH SPEED: Stiff suspension.
 * Expected to settle very quickly (under 450ms). Hard impacts expected.
 */
export const HIGH_SPEED_IMPACT_PRESET: PresetConfig = {
  alpha: 0.06,
  multiplier: 2.5,
  threshold: 0.35,
  stableZone: 0.15,
  stableHoldMs: 150,
  harshPeakG: 1.5,
  overdampedSettlingMs: 450,
  name: 'Sport / Stiff',
};

/**
 * CITY COMFORT @ 60 km/h: Plush, long-travel suspension.
 * Allows for "boat-like" floating (stableZone 0.18).
 * Needs longer to settle before calling underdamped/overdamped (850ms harsh band).
 */
export const SMOOTH_SURFACE_PRESET: PresetConfig = {
  alpha: 0.15,
  multiplier: 3.0,
  threshold: 0.15,
  stableZone: 0.18,
  stableHoldMs: 200,
  harshPeakG: 1.2,
  overdampedSettlingMs: 850,
  name: 'City Comfort',
};

export const TELEMETRY_PRESETS = {
  HIGH_SPEED_IMPACT: HIGH_SPEED_IMPACT_PRESET,
  SMOOTH_SURFACE: SMOOTH_SURFACE_PRESET,
} as const;

export type TelemetryPresetId = keyof typeof TELEMETRY_PRESETS;

export type TelemetryPresetMode = TelemetryPresetId | 'custom';

export type TelemetryPresetTargets = {
  vertFastAlphaSv: SharedValue<number>;
  sensitivityMultiplierSv: SharedValue<number>;
  bumpThresholdG: SharedValue<number>;
  stableZoneG: SharedValue<number>;
  stableHoldMs: SharedValue<number>;
  harshPeakG: SharedValue<number>;
  overdampedSettlingMs: SharedValue<number>;
};

/** Apply preset DSP/FSM gates on the JS thread; SharedValues are read immediately in worklets. */
export function applyPresetConfig(cfg: PresetConfig, targets: TelemetryPresetTargets): void {
  targets.vertFastAlphaSv.value = cfg.alpha;
  targets.sensitivityMultiplierSv.value = cfg.multiplier;
  targets.bumpThresholdG.value = cfg.threshold;
  targets.stableZoneG.value = cfg.stableZone;
  targets.stableHoldMs.value = cfg.stableHoldMs;
  targets.harshPeakG.value = cfg.harshPeakG;
  targets.overdampedSettlingMs.value = cfg.overdampedSettlingMs;
}
