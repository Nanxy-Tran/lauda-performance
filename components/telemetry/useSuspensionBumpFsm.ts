import { useCallback, useMemo, useRef } from 'react';
import { runOnJS, runOnUI, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import type { FrameInfo, SharedValue } from 'react-native-reanimated';

import { WHEELBASE_M } from './oscilloscope/dspConstants';

const FSM_IDLE = 0;
const FSM_IMPACT = 1;
const FSM_SETTLING = 2;

const SETTLING_ABORT_MS = 12000;

export type SuspensionSurfaceStatus =
  | 'HARSH_IMPACT'
  | 'UNDERDAMPED'
  | 'OVERDAMPED'
  | 'GOOD';

export type SuspensionBumpDiagResult = {
  maxPeakZG: number;
  bounceCount: number;
  impactStartMs: number;
  settlingDurationMs: number;
  compressionAdvice: string;
  reboundAdvice: string;
  surfaceStatus: SuspensionSurfaceStatus;
  pitchBiasNote: string;
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

function pitchBiasNoteFromDeg(deg: number): string {
  'worklet';
  if (deg < -2.0) {
    return `BRAKING: Front loaded (${deg.toFixed(1)}°). Expect harsher impact.`;
  }
  if (deg > 2.0) {
    return `ACCELERATING: Rear loaded (${deg.toFixed(1)}°).`;
  }
  return 'COASTING: Neutral balance.';
}

function rearHitDelayMsSpeed(speedKmH: number): number {
  'worklet';
  const cms = Math.max(speedKmH / 3.6, 0.001);
  return (WHEELBASE_M / cms) * 1000;
}

export type UseSuspensionBumpFsmParams = {
  vertZ: SharedValue<number>;
  hasCalib: SharedValue<number>;
  pitchDeg: SharedValue<number>;
  onDiagnosticsReady: (frontDiag: SuspensionBumpDiagResult, rearDiag: SuspensionBumpDiagResult | null) => void;
  bumpThresholdG: SharedValue<number>;
  stableZoneG: SharedValue<number>;
  stableHoldMs: SharedValue<number>;
  harshPeakG: SharedValue<number>;
  overdampedSettlingMs: SharedValue<number>;
  zeroCrossEpsG: SharedValue<number>;
  speedKmH: SharedValue<number>;
};

export function useSuspensionBumpFsm({
  vertZ,
  hasCalib,
  pitchDeg,
  onDiagnosticsReady,
  bumpThresholdG,
  stableZoneG,
  stableHoldMs,
  harshPeakG,
  overdampedSettlingMs,
  zeroCrossEpsG,
  speedKmH,
}: UseSuspensionBumpFsmParams): { resetBumpFsm: () => void } {
  const cbRef = useRef(onDiagnosticsReady);
  cbRef.current = onDiagnosticsReady;
  const lastFrontDiagRef = useRef<SuspensionBumpDiagResult | null>(null);

  const emitFrontDoneJS = useCallback((r: SuspensionBumpDiagResult) => {
    lastFrontDiagRef.current = r;
    cbRef.current(r, null);
  }, []);

  const emitRearWithStoredFrontJS = useCallback((rear: SuspensionBumpDiagResult) => {
    const f = lastFrontDiagRef.current;
    if (f) {
      cbRef.current(f, rear);
    }
  }, []);

  const fStateSv = useSharedValue(FSM_IDLE);
  const fMaxPeakSv = useSharedValue(0);
  const fBouncesSv = useSharedValue(0);
  const fImpactMsSv = useSharedValue(0);
  const fSettlingStartSv = useSharedValue(0);
  const fPrevZSv = useSharedValue(0);
  const fStableAccumSv = useSharedValue(0);
  const fPitchAtImpactSv = useSharedValue(0);

  const rearKickAtMsSv = useSharedValue(0);

  const rStateSv = useSharedValue(FSM_IDLE);
  const rMaxPeakSv = useSharedValue(0);
  const rBouncesSv = useSharedValue(0);
  const rImpactMsSv = useSharedValue(0);
  const rSettlingStartSv = useSharedValue(0);
  const rPrevZSv = useSharedValue(0);
  const rStableAccumSv = useSharedValue(0);

  const bumpWorklet = useMemo(() => {
    const w = (_frame: FrameInfo) => {
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
      const wallMs = Date.now();
      const dt = _frame.timeSincePreviousFrame;
      const deltaMs = dt != null && dt > 0 && dt < 200 ? dt : 1000 / 60;
      const absZ = Math.abs(z);

      const fs0 = fStateSv.value;
      if (fs0 === FSM_IDLE) {
        if (absZ > bumpTh) {
          fStateSv.value = FSM_IMPACT;
          fImpactMsSv.value = wallMs;
          fPitchAtImpactSv.value = pitchDeg.value;
          fMaxPeakSv.value = absZ;
          fStableAccumSv.value = 0;
          if (rStateSv.value === FSM_IDLE) {
            rearKickAtMsSv.value = wallMs + rearHitDelayMsSpeed(speedKmH.value);
          } else {
            rearKickAtMsSv.value = 0;
          }
        }
      } else if (fs0 === FSM_IMPACT) {
        if (absZ > fMaxPeakSv.value) {
          fMaxPeakSv.value = absZ;
        }
        if (absZ < bumpTh) {
          fStateSv.value = FSM_SETTLING;
          fSettlingStartSv.value = wallMs;
          fBouncesSv.value = 0;
          fPrevZSv.value = z;
          fStableAccumSv.value = 0;
        }
      } else {
        const prevZf = fPrevZSv.value;
        if (Math.abs(prevZf) > zxEps * 0.5 && Math.abs(z) > zxEps * 0.5 && prevZf * z < 0) {
          fBouncesSv.value += 1;
        }
        fPrevZSv.value = z;

        if (absZ <= stableZ) {
          fStableAccumSv.value += deltaMs;
        } else {
          fStableAccumSv.value = 0;
        }

        const fSettlingStart = fSettlingStartSv.value;
        if (wallMs - fSettlingStart > SETTLING_ABORT_MS) {
          fStateSv.value = FSM_IDLE;
          fMaxPeakSv.value = 0;
          fBouncesSv.value = 0;
          fStableAccumSv.value = 0;
        } else if (fStableAccumSv.value >= holdMs) {
          const settlingDurationMs = wallMs - fSettlingStart;
          const peak = fMaxPeakSv.value;
          const bounces = fBouncesSv.value;
          const impactStart = fImpactMsSv.value;
          const pitchN = pitchBiasNoteFromDeg(fPitchAtImpactSv.value);
          const diagBase = evaluateDiagnostics(peak, bounces, settlingDurationMs, harshG, overMs);

          runOnJS(emitFrontDoneJS)({
            maxPeakZG: peak,
            bounceCount: bounces,
            impactStartMs: impactStart,
            settlingDurationMs,
            compressionAdvice: diagBase.compressionAdvice,
            reboundAdvice: diagBase.reboundAdvice,
            surfaceStatus: diagBase.surfaceStatus,
            pitchBiasNote: pitchN,
          });

          fStateSv.value = FSM_IDLE;
          fMaxPeakSv.value = 0;
          fBouncesSv.value = 0;
          fStableAccumSv.value = 0;
        }
      }

      if (rStateSv.value === FSM_IDLE && rearKickAtMsSv.value > 0 && wallMs >= rearKickAtMsSv.value) {
        rStateSv.value = FSM_IMPACT;
        rearKickAtMsSv.value = 0;
        rImpactMsSv.value = wallMs;
        rMaxPeakSv.value = absZ;
        rStableAccumSv.value = 0;
      }

      const rs = rStateSv.value;
      if (rs === FSM_IMPACT) {
        if (absZ > rMaxPeakSv.value) {
          rMaxPeakSv.value = absZ;
        }
        if (absZ < bumpTh) {
          rStateSv.value = FSM_SETTLING;
          rSettlingStartSv.value = wallMs;
          rBouncesSv.value = 0;
          rPrevZSv.value = z;
          rStableAccumSv.value = 0;
        }
      } else if (rs === FSM_SETTLING) {
        const prevZr = rPrevZSv.value;
        if (Math.abs(prevZr) > zxEps * 0.5 && Math.abs(z) > zxEps * 0.5 && prevZr * z < 0) {
          rBouncesSv.value += 1;
        }
        rPrevZSv.value = z;

        if (absZ <= stableZ) {
          rStableAccumSv.value += deltaMs;
        } else {
          rStableAccumSv.value = 0;
        }

        const rSettlingStart = rSettlingStartSv.value;
        if (wallMs - rSettlingStart > SETTLING_ABORT_MS) {
          rStateSv.value = FSM_IDLE;
          rMaxPeakSv.value = 0;
          rBouncesSv.value = 0;
          rStableAccumSv.value = 0;
        } else if (rStableAccumSv.value >= holdMs) {
          const settlingDurationMs = wallMs - rSettlingStart;
          const peak = rMaxPeakSv.value;
          const bounces = rBouncesSv.value;
          const impactStart = rImpactMsSv.value;
          const diagBase = evaluateDiagnostics(peak, bounces, settlingDurationMs, harshG, overMs);

          runOnJS(emitRearWithStoredFrontJS)({
            maxPeakZG: peak,
            bounceCount: bounces,
            impactStartMs: impactStart,
            settlingDurationMs,
            compressionAdvice: diagBase.compressionAdvice,
            reboundAdvice: diagBase.reboundAdvice,
            surfaceStatus: diagBase.surfaceStatus,
            pitchBiasNote: '',
          });

          rStateSv.value = FSM_IDLE;
          rMaxPeakSv.value = 0;
          rBouncesSv.value = 0;
          rStableAccumSv.value = 0;
        }
      }
    };
    return w;
  }, [
    emitFrontDoneJS,
    emitRearWithStoredFrontJS,
    hasCalib,
    vertZ,
    pitchDeg,
    bumpThresholdG,
    stableZoneG,
    stableHoldMs,
    harshPeakG,
    overdampedSettlingMs,
    zeroCrossEpsG,
    speedKmH,
  ]);

  useFrameCallback(bumpWorklet);

  const resetBumpFsm = useCallback(() => {
    lastFrontDiagRef.current = null;
    runOnUI(() => {
      'worklet';
      fStateSv.value = FSM_IDLE;
      fMaxPeakSv.value = 0;
      fBouncesSv.value = 0;
      fImpactMsSv.value = 0;
      fSettlingStartSv.value = 0;
      fPrevZSv.value = 0;
      fStableAccumSv.value = 0;
      fPitchAtImpactSv.value = 0;

      rearKickAtMsSv.value = 0;

      rStateSv.value = FSM_IDLE;
      rMaxPeakSv.value = 0;
      rBouncesSv.value = 0;
      rImpactMsSv.value = 0;
      rSettlingStartSv.value = 0;
      rPrevZSv.value = 0;
      rStableAccumSv.value = 0;
    })();
  }, [
    fStateSv,
    fMaxPeakSv,
    fBouncesSv,
    fImpactMsSv,
    fSettlingStartSv,
    fPrevZSv,
    fStableAccumSv,
    fPitchAtImpactSv,
    rearKickAtMsSv,
    rStateSv,
    rMaxPeakSv,
    rBouncesSv,
    rImpactMsSv,
    rSettlingStartSv,
    rPrevZSv,
    rStableAccumSv,
  ]);

  return { resetBumpFsm };
}
