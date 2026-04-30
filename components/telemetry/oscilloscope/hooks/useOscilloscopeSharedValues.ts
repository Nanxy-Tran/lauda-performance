import { useSharedValue } from 'react-native-reanimated';

import { BUFFER_LEN } from '../constants';

/**
 * All UI-thread telemetry state for accel projection, waveform buffer, HUD, and DSP sliders.
 * `chartW/H` bootstrap from window size; layout + effects keep SVs aligned on resize.
 *
 * `cleanVertZSv` — linear vertical Δg (vertical accel projected on gravity − 1g), smoothed via EMA (`vertFastAlphaSv`) for chart / FSM / HUD.
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

  /** EMA-low-pass vertical Δg output (same channel used for bumps, terrain classifier, waveform buffer). */
  const cleanVertZSv = useSharedValue(0);
  const hasCalibSv = useSharedValue(0);

  const vertFastAlphaSv = useSharedValue(0.06);
  const sensitivityMultiplierSv = useSharedValue(2.5);
  const bumpThresholdGsv = useSharedValue(0.35);
  const stableZoneGsv = useSharedValue(0.15);
  const stableHoldMssv = useSharedValue(150);
  const harshPeakGsv = useSharedValue(1.5);
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

  /** Terrain classifier + overlay (numbers: see dspConstants). */
  const terrainKindSv = useSharedValue(0);
  const terrainSbStateSv = useSharedValue(0);
  const terrainSbPeakTimeSv = useSharedValue(0);
  const terrainPhStateSv = useSharedValue(0);
  const terrainPhPeakTimeSv = useSharedValue(0);

  /** 0 = no flash; else Date.now() at last terrain hit. */
  const terrainFlashStartSv = useSharedValue(0);
  const terrainOverlayOpacitySv = useSharedValue(0);

  /** Precision IMU calibration: 0 IDLE, 1 CALIBRATING. */
  const calStateSv = useSharedValue(0);
  const calStartMsSv = useSharedValue(0);
  const calSumX = useSharedValue(0);
  const calSumY = useSharedValue(0);
  const calSumZ = useSharedValue(0);
  const calCount = useSharedValue(0);
  const calProgressSv = useSharedValue(0);

  return {
    chartWsv,
    chartHsv,
    rawAx,
    rawAy,
    rawAz,
    gravUnitX,
    gravUnitY,
    gravUnitZ,
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
    terrainKindSv,
    terrainSbStateSv,
    terrainSbPeakTimeSv,
    terrainPhStateSv,
    terrainPhPeakTimeSv,
    terrainFlashStartSv,
    terrainOverlayOpacitySv,
    calStateSv,
    calStartMsSv,
    calSumX,
    calSumY,
    calSumZ,
    calCount,
    calProgressSv,
  };
}

export type OscilloscopeSharedValues = ReturnType<typeof useOscilloscopeSharedValues>;
