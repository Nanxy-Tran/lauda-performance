import { useSharedValue } from 'react-native-reanimated';

import { BUFFER_LEN } from '../constants';
import { KALMAN_P0 } from '../dspConstants';

/**
 * All UI-thread telemetry state for accel projection, waveform buffer, HUD, and DSP sliders.
 * `chartW/H` bootstrap from window size; layout + effects keep SVs aligned on resize.
 *
 * `vertUserLpSv` — tunable first-stage EMA (user α). `cleanVertZSv` — final telemetry (drift + 25 Hz + Kalman out) for chart/FSM/HUD.
 */
export function useOscilloscopeSharedValues(winW: number, winH: number) {
  const chartWsv = useSharedValue(Math.max(winW, 120));
  const chartHsv = useSharedValue(winH);

  const rawAx = useSharedValue(0);
  const rawAy = useSharedValue(0);
  const rawAz = useSharedValue(1);

  const gravUnitX = useSharedValue(0);
  const gravUnitY = useSharedValue(0);
  const gravUnitZ = useSharedValue(1);

  /** User-tunable LPF on linear vert Z (before MotoGP DSP chain). */
  const vertUserLpSv = useSharedValue(0);
  /** Drift slow LP of `vertUserLp` for high-pass by subtraction. */
  const dspDriftLpSv = useSharedValue(0);
  /** 25 Hz-ish road/suspension band after drift removal. */
  const dspRoadLpfSv = useSharedValue(0);
  /** 1D Kalman estimate (g). */
  const dspKalmanXSv = useSharedValue(0);
  const dspKalmanPSv = useSharedValue(KALMAN_P0);
  /** Final vertical g for buffer, FSM, HF log (post chain). */
  const cleanVertZSv = useSharedValue(0);
  const hasCalibSv = useSharedValue(0);

  const vertFastAlphaSv = useSharedValue(0.06);
  const sensitivityMultiplierSv = useSharedValue(2.5);
  const bumpThresholdGsv = useSharedValue(0.35);
  const stableZoneGsv = useSharedValue(0.15);
  const stableHoldMssv = useSharedValue(200);
  const harshPeakGsv = useSharedValue(1.0);
  const overdampedSettlingMssv = useSharedValue(450);
  const zeroCrossEpsGsv = useSharedValue(0.06);

  const writeIdxSv = useSharedValue(0);
  const waveData = useSharedValue(new Float32Array(BUFFER_LEN));
  const sampleTick = useSharedValue(0);

  const pitchFusDegSv = useSharedValue(0);
  const rollFusDegSv = useSharedValue(0);
  const pitchCalBiasDegSv = useSharedValue(0);
  const rollCalBiasDegSv = useSharedValue(0);

  const dspPitchDeg = useSharedValue(0);
  const dspRollDeg = useSharedValue(0);
  const dspPeakG = useSharedValue(0);
  const dspPeakRollLeftDeg = useSharedValue(0);
  const dspPeakRollRightDeg = useSharedValue(0);
  const dspPeakVertZSv = useSharedValue(0);
  const hudDisplayZSv = useSharedValue(0);
  const peakFifo0Sv = useSharedValue(0);
  const peakFifo1Sv = useSharedValue(0);
  const peakFifo2Sv = useSharedValue(0);
  const peakFifo3Sv = useSharedValue(0);

  const speedKmH = useSharedValue(0);

  /** Wall clock delta for filter tuning (updated in reaction). */
  const lastAccelSampleWallMsSv = useSharedValue(0);

  /** Terrain classifier + overlay (numbers: see dspConstants). */
  const terrainKindSv = useSharedValue(0);
  const terrainSbStateSv = useSharedValue(0);
  const terrainSbPeakTimeSv = useSharedValue(0);
  const terrainPhStateSv = useSharedValue(0);
  const terrainPhPeakTimeSv = useSharedValue(0);

  /** 0 = no flash; else Date.now() at last terrain hit. */
  const terrainFlashStartSv = useSharedValue(0);
  const terrainOverlayOpacitySv = useSharedValue(0);

  return {
    chartWsv,
    chartHsv,
    rawAx,
    rawAy,
    rawAz,
    gravUnitX,
    gravUnitY,
    gravUnitZ,
    vertUserLpSv,
    dspDriftLpSv,
    dspRoadLpfSv,
    dspKalmanXSv,
    dspKalmanPSv,
    cleanVertZSv,
    hasCalibSv,
    vertFastAlphaSv,
    sensitivityMultiplierSv,
    bumpThresholdGsv,
    stableZoneGsv,
    stableHoldMssv,
    harshPeakGsv,
    overdampedSettlingMssv,
    zeroCrossEpsGsv,
    writeIdxSv,
    waveData,
    sampleTick,
    pitchFusDegSv,
    rollFusDegSv,
    pitchCalBiasDegSv,
    rollCalBiasDegSv,
    dspPitchDeg,
    dspRollDeg,
    dspPeakG,
    dspPeakRollLeftDeg,
    dspPeakRollRightDeg,
    dspPeakVertZSv,
    hudDisplayZSv,
    peakFifo0Sv,
    peakFifo1Sv,
    peakFifo2Sv,
    peakFifo3Sv,
    speedKmH,
    lastAccelSampleWallMsSv,
    terrainKindSv,
    terrainSbStateSv,
    terrainSbPeakTimeSv,
    terrainPhStateSv,
    terrainPhPeakTimeSv,
    terrainFlashStartSv,
    terrainOverlayOpacitySv,
  };
}

export type OscilloscopeSharedValues = ReturnType<typeof useOscilloscopeSharedValues>;
