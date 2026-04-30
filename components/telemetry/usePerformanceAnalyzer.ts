import { useCallback, useMemo, useState } from 'react';
import {
  runOnJS,
  type FrameInfo,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

/** Ready for next run segment. */
export const PERF_IDLE = 0;

/** Measuring 0 → 60 km/h (squat → launch). */
export const PERF_ACCELERATING = 1;

/** Measuring hard stop distance (from ~high speed dive). */
export const PERF_BRAKING = 2;

export type PerformanceResult = {
  type: 'ACCEL' | 'BRAKE';
  /** Elapsed interval for segment (accel to 60, or braking until near stop). */
  timeSeconds: number;
  /** Integrated path length over the measured segment (meters). */
  distanceMeters: number;
  /** Accel: max positive pitch (squat). Brake: algebraically smallest pitch reached (dive dominates). */
  maxPitchDeg: number;
};

const ACCEL_ABORT_LOW_KMH = 8;
const ACCEL_ABORT_PEAK_GAP_KMH = 14;
const BRAKE_ENTRY_MIN_KMH = 40;
const BRAKE_RAPID_DROP_KMH = 6;
const BRAKE_DIVE_MIN_DEG = -2;

type UsePerformanceAnalyzerArgs = {
  speedKmH: SharedValue<number>;
  pitchDeg: SharedValue<number>;
  hasCalibSv: SharedValue<number>;
};

export function usePerformanceAnalyzer({
  speedKmH,
  pitchDeg,
  hasCalibSv,
}: UsePerformanceAnalyzerArgs): {
  latestResult: PerformanceResult | null;
  perfStateSv: SharedValue<number>;
  clearLatest: () => void;
} {
  const [latestResult, setLatestResult] = useState<PerformanceResult | null>(null);

  const pushResult = useCallback((r: PerformanceResult) => {
    setLatestResult(r);
  }, []);

  const clearLatest = useCallback(() => {
    setLatestResult(null);
  }, []);

  const perfState = useSharedValue(PERF_IDLE);
  const perfStartTimeMs = useSharedValue(0);
  const maxPitchTracked = useSharedValue(0);
  const distM = useSharedValue(0);
  const prevSpeed = useSharedValue(0);
  const peakDuringAccel = useSharedValue(0);

  const perfFrame = useMemo(() => {
    return (frame: FrameInfo) => {
      'worklet';
      const dtRaw = frame.timeSincePreviousFrame;
      const dtMs = dtRaw != null && dtRaw > 0 && dtRaw < 200 ? dtRaw : 1000 / 60;
      const now = Date.now();
      const v = speedKmH.value;
      const pitch = pitchDeg.value;
      const prevV = prevSpeed.value;

      if (hasCalibSv.value !== 1) {
        if (perfState.value !== PERF_IDLE) {
          perfState.value = PERF_IDLE;
        }
        prevSpeed.value = v;
        return;
      }

      if (perfState.value === PERF_IDLE) {
        if (v < 2 && pitch > 1.5) {
          perfState.value = PERF_ACCELERATING;
          perfStartTimeMs.value = now;
          maxPitchTracked.value = pitch;
          distM.value = 0;
          peakDuringAccel.value = v;
        } else if (
          v > BRAKE_ENTRY_MIN_KMH &&
          prevV > BRAKE_ENTRY_MIN_KMH &&
          prevV - v > BRAKE_RAPID_DROP_KMH &&
          pitch < BRAKE_DIVE_MIN_DEG
        ) {
          perfState.value = PERF_BRAKING;
          perfStartTimeMs.value = now;
          maxPitchTracked.value = pitch;
          distM.value = 0;
        }
        prevSpeed.value = v;
        return;
      }

      if (perfState.value === PERF_ACCELERATING) {
        if (pitch > maxPitchTracked.value) {
          maxPitchTracked.value = pitch;
        }
        if (v > peakDuringAccel.value) {
          peakDuringAccel.value = v;
        }
        distM.value += (v / 3.6) * (dtMs / 1000);

        if (v >= 60) {
          const tSec = (now - perfStartTimeMs.value) / 1000;
          runOnJS(pushResult)({
            type: 'ACCEL',
            timeSeconds: tSec,
            distanceMeters: distM.value,
            maxPitchDeg: maxPitchTracked.value,
          });
          perfState.value = PERF_IDLE;
          prevSpeed.value = v;
          return;
        }

        const elapsed = now - perfStartTimeMs.value;
        if (elapsed > 600 && v < ACCEL_ABORT_LOW_KMH) {
          perfState.value = PERF_IDLE;
          prevSpeed.value = v;
          return;
        }
        if (peakDuringAccel.value > 25 && v < peakDuringAccel.value - ACCEL_ABORT_PEAK_GAP_KMH) {
          perfState.value = PERF_IDLE;
          prevSpeed.value = v;
          return;
        }

        prevSpeed.value = v;
        return;
      }

      if (perfState.value === PERF_BRAKING) {
        if (pitch < maxPitchTracked.value) {
          maxPitchTracked.value = pitch;
        }
        distM.value += (v / 3.6) * (dtMs / 1000);

        if (v < 3) {
          const tSec = (now - perfStartTimeMs.value) / 1000;
          runOnJS(pushResult)({
            type: 'BRAKE',
            timeSeconds: tSec,
            distanceMeters: distM.value,
            maxPitchDeg: maxPitchTracked.value,
          });
          perfState.value = PERF_IDLE;
          prevSpeed.value = v;
          return;
        }

        const brakingElapsed = now - perfStartTimeMs.value;
        if (brakingElapsed > 520 && pitch > -0.55 && v > 18 && v >= prevV - 1.2) {
          perfState.value = PERF_IDLE;
          prevSpeed.value = v;
          return;
        }

        prevSpeed.value = v;
        return;
      }

      prevSpeed.value = v;
    };
    // Stable SharedValue refs captured in worklet; avoid listing .value accessors in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushResult]);

  useFrameCallback(perfFrame);

  return { latestResult, perfStateSv: perfState, clearLatest };
}
