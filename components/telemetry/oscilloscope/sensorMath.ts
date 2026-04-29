import { RAD_TO_DEG, STATIONARY_DEADZONE_Z_G } from './constants';

/** Snap pitch/roll HUD to 0.5° steps so the readout does not flicker on engine vibration. */
export function hudTiltDisplayDeg(deg: number): number {
  'worklet';
  return Math.round(deg * 2) / 2;
}

/**
 * Absolute tilt (deg): Pitch = atan2(ay, az), Roll = atan2(-ax, √(ay²+az²)) — accelerometer only.
 */
export function accelPitchRollDegAbsolute(ax: number, ay: number, az: number): {
  pitchDeg: number;
  rollDeg: number;
} {
  'worklet';
  const yz = ay * ay + az * az;
  const denom = yz > 0 ? Math.sqrt(yz) : 0;
  const pitchDeg = Math.atan2(ay, az) * RAD_TO_DEG;
  const rollDeg = Math.atan2(-ax, denom) * RAD_TO_DEG;
  return { pitchDeg, rollDeg };
}

/** Clamp displayed vertical linear Z (OSC + HUD + bump FSM). */
export function displayWorldZG(zAfterProcessG: number) {
  'worklet';
  const z = zAfterProcessG;
  return Math.abs(z) < STATIONARY_DEADZONE_Z_G ? 0 : z;
}
