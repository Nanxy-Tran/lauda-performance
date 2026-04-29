/** Target sensor cadence (ms). Android / Expo: 2 ≈ 500 Hz on capable devices. */
export const SENSOR_INTERVAL_MS_TARGET = 2;

/** Assumed sample rate (Hz) for fixed IIR / Kalman coefficients when wall-clock dt is clamped. */
export const DSP_ASSUMED_FS_HZ = 500;

/** Motorcycle wheelbase for front→rear delay (m). */
export const WHEELBASE_M = 1.57;

/** Ultra-slow drift tracker (Hz) — high-pass by subtraction from user signal. */
export const DSP_DRIFT_LPF_HZ = 0.45;

/** Engine / road roughness band — low-pass after drift removal (Hz). */
export const DSP_ENGINE_LPF_CUT_HZ = 25;

/** Scalar 1D Kalman process / measurement noise (tuned for g-scale). */
export const KALMAN_Q = 1e-5;
export const KALMAN_R = 0.04;
export const KALMAN_P0 = 1;

/** Speed bump: +peak then −trough within this window (ms). */
export const TERRAIN_PAIR_WINDOW_MS = 150;
export const TERRAIN_SPEED_BUMP_POS_G = 0.3;
export const TERRAIN_SPEED_BUMP_NEG_G = -0.2;
export const TERRAIN_POTHOLE_NEG_G = -0.35;
export const TERRAIN_POTHOLE_POS_G = 0.15;

/** Terrain codes for SharedValue (worklet-safe numbers). */
export const TERRAIN_FLAT = 0;
export const TERRAIN_SPEED_BUMP = 1;
export const TERRAIN_POTHOLE = 2;

/** Öhlins-style rear trace gold. */
export const REAR_TRACE_COLOR = '#ffb700';

/** One-pole low-pass: y += alpha * (x - y), alpha = 1 - exp(-2π fc / fs). */
export function onePoleAlpha(fs: number, fc: number): number {
  'worklet';
  if (fc <= 0 || fs <= 0) return 1;
  return 1 - Math.exp((-2 * Math.PI * fc) / fs);
}
