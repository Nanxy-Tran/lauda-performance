/** Target sensor cadence (ms). Android / Expo: 2 ≈ 500 Hz on capable devices. */
export const SENSOR_INTERVAL_MS_TARGET = 2;

/** Assumed sample rate (Hz) for rear trace delay spacing / chart time mapping vs buffer index. */
export const DSP_ASSUMED_FS_HZ = 500;

/** Motorcycle wheelbase for front→rear delay (m). */
export const WHEELBASE_M = 1.57;

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
