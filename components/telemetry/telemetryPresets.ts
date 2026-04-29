import type { SharedValue } from 'react-native-reanimated';

export type PresetConfig = {
  alpha: number;
  multiplier: number;
  threshold: number;
  stableZone: number;
  name: string;
};

/** Default ride profile: highway / spirited — balanced LPF vs chart gain, bumps only above ~0.35 g. */
export const HIGH_SPEED_IMPACT_PRESET: PresetConfig = {
  alpha: 0.06,
  multiplier: 2.5,
  threshold: 0.35,
  stableZone: 0.15,
  name: 'High Speed Impact',
};

/**
 * Road chatter / micro-vibrations — higher α (less LPF damping), stronger chart zoom, sensitive bump FSM.
 */
export const SMOOTH_SURFACE_PRESET: PresetConfig = {
  alpha: 0.2,
  multiplier: 4.5,
  threshold: 0.1,
  stableZone: 0.15,
  name: 'Smooth & Micro',
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
};

/** Apply preset DSP/FSM gates on the JS thread; SharedValues are read immediately in worklets. */
export function applyPresetConfig(cfg: PresetConfig, targets: TelemetryPresetTargets): void {
  const { vertFastAlphaSv, sensitivityMultiplierSv, bumpThresholdG, stableZoneG } = targets;
  vertFastAlphaSv.value = cfg.alpha;
  sensitivityMultiplierSv.value = cfg.multiplier;
  bumpThresholdG.value = cfg.threshold;
  stableZoneG.value = cfg.stableZone;
}
