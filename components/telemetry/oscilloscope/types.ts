/** HUD snapshot synced from UI-thread peaks (slow path). */
export type HudSnap = {
  pitch: number;
  roll: number;
  peak: number;
  speed: number;
  /** Deadzone'd vertical linear G (same as chart). */
  zG: number;
  peakRollLeft: number;
  peakRollRight: number;
  peakVertZ: number;
};
