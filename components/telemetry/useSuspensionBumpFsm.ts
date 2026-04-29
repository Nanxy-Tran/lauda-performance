import { useCallback, useMemo, useRef } from 'react';
import { runOnJS, runOnUI, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import type { FrameInfo, SharedValue } from 'react-native-reanimated';

/** Internal FSM states (UI-thread only). */
const FSM_IDLE = 0;
const FSM_IMPACT = 1;
const FSM_SETTLING = 2;

/** Max time in SETTLING before abandoning without dispatch (avoids stuck state). */
const SETTLING_ABORT_MS = 12000;

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
  settlingDurationMs: number,
  harshPeakG: number,
  overdampedSettlingMs: number
): Pick<SuspensionBumpDiagResult, 'compressionAdvice' | 'reboundAdvice' | 'surfaceStatus'> {
  'worklet';
  let compressionAdvice: string;
  if (maxPeakZG > harshPeakG) {
    compressionAdvice = 'HARSH: Reduce Comp. Damping (Turn Softer / -)';
  } else {
    compressionAdvice = 'COMPRESSION: Good absorption';
  }

  let reboundAdvice: string;
  if (bounceCount >= 2) {
    reboundAdvice = 'BOUNCY (Too Fast): Add Rebound Damping (Turn Stiffer / +)';
  } else if (settlingDurationMs > overdampedSettlingMs && bounceCount <= 1) {
    reboundAdvice = 'PACKING (Too Slow): Reduce Rebound Damping (Turn Softer / -)';
  } else {
    reboundAdvice = 'REBOUND: Stable & Ideal';
  }

  let surfaceStatus: SuspensionSurfaceStatus;
  if (maxPeakZG > harshPeakG) {
    surfaceStatus = 'HARSH_IMPACT';
  } else if (bounceCount >= 2) {
    surfaceStatus = 'UNDERDAMPED';
  } else if (settlingDurationMs > overdampedSettlingMs && bounceCount <= 1) {
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
  bumpThresholdG: SharedValue<number>;
  stableZoneG: SharedValue<number>;
  stableHoldMs: SharedValue<number>;
  harshPeakG: SharedValue<number>;
  overdampedSettlingMs: SharedValue<number>;
  zeroCrossEpsG: SharedValue<number>;
};

/**
 * Core suspension bump FSM: runs on the UI thread via `useFrameCallback`, reads `vertZ` every frame,
 * and invokes `onBumpComplete` **once** per completed bump (via `runOnJS`).
 * Thresholds are SharedValues so they can be tuned live from the UI.
 */
export function useSuspensionBumpFsm({
  vertZ,
  hasCalib,
  onBumpComplete,
  bumpThresholdG,
  stableZoneG,
  stableHoldMs,
  harshPeakG,
  overdampedSettlingMs,
  zeroCrossEpsG,
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

      const bumpTh = bumpThresholdG.value;
      const stableZ = stableZoneG.value;
      const holdMs = stableHoldMs.value;
      const harshG = harshPeakG.value;
      const overMs = overdampedSettlingMs.value;
      const zxEps = zeroCrossEpsG.value;

      const z = vertZ.value;
      const t = frame.timestamp;
      const dt = frame.timeSincePreviousFrame;
      const deltaMs = dt != null && dt > 0 && dt < 200 ? dt : 1000 / 60;

      const absZ = Math.abs(z);
      const state = fsmStateSv.value;

      if (state === FSM_IDLE) {
        if (absZ > bumpTh) {
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
        if (absZ < bumpTh) {
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
      if (Math.abs(prevZ) > zxEps * 0.5 && Math.abs(z) > zxEps * 0.5 && prevZ * z < 0) {
        bounceCountSv.value += 1;
      }
      prevZSv.value = z;

      if (absZ <= stableZ) {
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

      if (stableAccumMsSv.value >= holdMs) {
        const settlingDurationMs = t - settlingStart;
        const peak = maxPeakZSv.value;
        const bounces = bounceCountSv.value;
        const impactStart = impactStartMsSv.value;

        const diag = evaluateDiagnostics(peak, bounces, settlingDurationMs, harshG, overMs);

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
  }, [
    dispatchBumpComplete,
    hasCalib,
    vertZ,
    bumpThresholdG,
    stableZoneG,
    stableHoldMs,
    harshPeakG,
    overdampedSettlingMs,
    zeroCrossEpsG,
  ]);

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
