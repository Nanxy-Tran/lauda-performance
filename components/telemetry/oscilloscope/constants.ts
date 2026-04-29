import { Platform } from 'react-native';

export const BUFFER_LEN = 360;

/** HUD pitch/roll EMA — accel-only tilt; higher = snappier (then quantized for display). */
export const HUD_ANGLE_EMA = 0.12;

export const RAD_TO_DEG = 180 / Math.PI;

/**
 * Stationary deadzone (g): |Vert Z| below this → display 0.00 (chart + leak prevention).
 */
export const STATIONARY_DEADZONE_Z_G = 0.04;

/** Speed below this (km/h) displays as zero. */
export const SPEED_DISPLAY_ZERO_BELOW_KMH = 5;

/** Peak-G hysteresis — ignore buzz below this magnitude on MA_Z (motorcycle vibration). */
export const PEAK_THRESHOLD_G = 0.15;

/** Moving-average length for Peak-G (40ms @ ~100Hz-ish sampling ≈ 4 samples). */
export const PEAK_MA_SAMPLES = 4;

export const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});
