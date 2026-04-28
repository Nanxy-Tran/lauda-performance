import { useCallback, useMemo, useRef } from 'react';
import { runOnJS, runOnUI, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import type { FrameInfo, SharedValue } from 'react-native-reanimated';

/** Same deadzone as OscilloscopeView display pipeline — keep FSM aligned with chart/HUD vert Z. */
const STATIONARY_DEADZONE_Z_G = 0.04;

export const BUMP_THRESHOLD_G = 0.3;
export const STABLE_ZONE_G = 0.1;
export const STABLE_HOLD_MS = 200;
export const HARSH_PEAK_G = 1.0;
export const OVERDAMPED_SETTLING_MS = 450;

const ZERO_CROSS_EPS_G = 0.02;

/** Internal FSM states (UI-thread only). */
const FSM_IDLE = 0;
const FSM_IMPACT = 1;
const FSM_SETTLING = 2;

/** Max time in SETTLING before abandoning without dispatch (avoids stuck state). */
const SETTLING_ABORT_MS = 12000;

function displayVertZWorklet(zRaw: number): number {
  'worklet';
  const z = zRaw;
  return Math.abs(z) < STATIONARY_DEADZONE_Z_G ? 0 : z;
}

export type SuspensionSurfaceStatus =
  | 'HARSH_IMPACT'
  | 'UNDERDAMPED'
  | 'OVERDAMPED'
  | 'GOOD';

export type SuspensionBumpDiagResult = {
  /** Highest |Z| during IMPACT (g). */
  maxPeakZG: number;
  bounceCount: number;
  impactStartMs: number;
  settlingDurationMs: number;
  compressionAdvice: string;
  reboundAdvice: string;
  surfaceStatus: SuspensionSurfaceStatus;
};

function evaluateDiagnostics(
  maxPeakZG: number,
  bounceCount: number,
  settlingDurationMs: number
): Pick<SuspensionBumpDiagResult, 'compressionAdvice' | 'reboundAdvice' | 'surfaceStatus'> {
  'worklet';
  let compressionAdvice: string;
  if (maxPeakZG > HARSH_PEAK_G) {
    compressionAdvice = 'HARSH: Reduce Comp. Damping (Turn Softer / -)';
  } else {
    compressionAdvice = 'COMPRESSION: Good absorption';
  }

  let reboundAdvice: string;
  if (bounceCount >= 2) {
    reboundAdvice = 'BOUNCY (Too Fast): Add Rebound Damping (Turn Stiffer / +)';
  } else if (settlingDurationMs > OVERDAMPED_SETTLING_MS && bounceCount <= 1) {
    reboundAdvice = 'PACKING (Too Slow): Reduce Rebound Damping (Turn Softer / -)';
  } else {
    reboundAdvice = 'REBOUND: Stable & Ideal';
  }

  let surfaceStatus: SuspensionSurfaceStatus;
  if (maxPeakZG > HARSH_PEAK_G) {
    surfaceStatus = 'HARSH_IMPACT';
  } else if (bounceCount >= 2) {
    surfaceStatus = 'UNDERDAMPED';
  } else if (settlingDurationMs > OVERDAMPED_SETTLING_MS && bounceCount <= 1) {
    surfaceStatus = 'OVERDAMPED';
  } else {
    surfaceStatus = 'GOOD';
  }

  return { compressionAdvice, reboundAdvice, surfaceStatus };
}

export type UseSuspensionBumpFsmParams = {
  /** Drift-free vertical acceleration (g), e.g. `cleanVertZSv`. */
  vertZ: SharedValue<number>;
  hasCalib: SharedValue<number>;
  onBumpComplete: (result: SuspensionBumpDiagResult) => void;
};

/**
 * Core suspension bump FSM: runs on the UI thread via `useFrameCallback`, reads `vertZ` every frame,
 * and invokes `onBumpComplete` **once** per completed bump (via `runOnJS`).
 */
export function useSuspensionBumpFsm({
  vertZ,
  hasCalib,
  onBumpComplete,
}: UseSuspensionBumpFsmParams): { resetBumpFsm: () => void } {
  const onBumpCompleteRef = useRef(onBumpComplete);
  onBumpCompleteRef.current = onBumpComplete;

  const dispatchBumpComplete = useCallback((result: SuspensionBumpDiagResult) => {
    onBumpCompleteRef.current(result);
  }, []);

  const fsmStateSv = useSharedValue(FSM_IDLE);
  const maxPeakZSv = useSharedValue(0);
  const bounceCountSv = useSharedValue(0);
  const impactStartMsSv = useSharedValue(0);
  const settlingStartMsSv = useSharedValue(0);
  const prevZSv = useSharedValue(0);
  const stableAccumMsSv = useSharedValue(0);

  const bumpWorklet = useMemo(() => {
    const w = (frame: FrameInfo) => {
      'worklet';
      if (hasCalib.value !== 1) {
        return;
      }

      const z = displayVertZWorklet(vertZ.value);
      const t = frame.timestamp;
      const dt = frame.timeSincePreviousFrame;
      // First frame has null delta — skip or use 16.7ms default
      const deltaMs = dt != null && dt > 0 && dt < 200 ? dt : 1000 / 60;

      const absZ = Math.abs(z);
      const state = fsmStateSv.value;

      if (state === FSM_IDLE) {
        if (absZ > BUMP_THRESHOLD_G) {
          fsmStateSv.value = FSM_IMPACT;
          impactStartMsSv.value = t;
          maxPeakZSv.value = absZ;
          stableAccumMsSv.value = 0;
        }
        return;
      }

      if (state === FSM_IMPACT) {
        if (absZ > maxPeakZSv.value) {
          maxPeakZSv.value = absZ;
        }
        if (absZ < BUMP_THRESHOLD_G) {
          fsmStateSv.value = FSM_SETTLING;
          settlingStartMsSv.value = t;
          bounceCountSv.value = 0;
          prevZSv.value = z;
          stableAccumMsSv.value = 0;
        }
        return;
      }

      // SETTLING
      const prevZ = prevZSv.value;
      if (Math.abs(prevZ) > ZERO_CROSS_EPS_G * 0.5 && Math.abs(z) > ZERO_CROSS_EPS_G * 0.5 && prevZ * z < 0) {
        bounceCountSv.value += 1;
      }
      prevZSv.value = z;

      if (absZ <= STABLE_ZONE_G) {
        stableAccumMsSv.value += deltaMs;
      } else {
        stableAccumMsSv.value = 0;
      }

      const settlingStart = settlingStartMsSv.value;

      if (t - settlingStart > SETTLING_ABORT_MS) {
        fsmStateSv.value = FSM_IDLE;
        maxPeakZSv.value = 0;
        bounceCountSv.value = 0;
        stableAccumMsSv.value = 0;
        return;
      }

      if (stableAccumMsSv.value >= STABLE_HOLD_MS) {
        const settlingDurationMs = t - settlingStart;
        const peak = maxPeakZSv.value;
        const bounces = bounceCountSv.value;
        const impactStart = impactStartMsSv.value;

        const diag = evaluateDiagnostics(peak, bounces, settlingDurationMs);

        runOnJS(dispatchBumpComplete)({
          maxPeakZG: peak,
          bounceCount: bounces,
          impactStartMs: impactStart,
          settlingDurationMs,
          compressionAdvice: diag.compressionAdvice,
          reboundAdvice: diag.reboundAdvice,
          surfaceStatus: diag.surfaceStatus,
        });

        fsmStateSv.value = FSM_IDLE;
        maxPeakZSv.value = 0;
        bounceCountSv.value = 0;
        stableAccumMsSv.value = 0;
      }
    };
    return w;
  }, [dispatchBumpComplete, hasCalib, vertZ]);

  useFrameCallback(bumpWorklet);

  const resetBumpFsm = useCallback(() => {
    runOnUI(() => {
      'worklet';
      fsmStateSv.value = FSM_IDLE;
      maxPeakZSv.value = 0;
      bounceCountSv.value = 0;
      impactStartMsSv.value = 0;
      settlingStartMsSv.value = 0;
      prevZSv.value = 0;
      stableAccumMsSv.value = 0;
    })();
  }, [
    bounceCountSv,
    fsmStateSv,
    impactStartMsSv,
    maxPeakZSv,
    prevZSv,
    settlingStartMsSv,
    stableAccumMsSv,
  ]);

  return { resetBumpFsm };
}
