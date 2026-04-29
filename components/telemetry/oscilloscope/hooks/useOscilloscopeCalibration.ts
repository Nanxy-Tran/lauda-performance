import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { runOnUI } from 'react-native-reanimated';

import type { SuspensionBumpDiagResult } from '../../useSuspensionBumpFsm';

import { accelPitchRollDegAbsolute, displayWorldZG } from '../sensorMath';
import { KALMAN_P0 } from '../dspConstants';
import type { OscilloscopeSharedValues } from './useOscilloscopeSharedValues';

type CalibrationParams = {
  sv: OscilloscopeSharedValues;
  resetBumpFsm: () => void;
  setBumpDiag: Dispatch<SetStateAction<SuspensionBumpDiagResult | null>>;
  setCalUiBanner: Dispatch<SetStateAction<string | null>>;
};

export function useOscilloscopeCalibration({ sv, resetBumpFsm, setBumpDiag, setCalUiBanner }: CalibrationParams) {
  const {
    rawAx,
    rawAy,
    rawAz,
    gravUnitX,
    gravUnitY,
    gravUnitZ,
    cleanVertZSv,
    vertUserLpSv,
    dspDriftLpSv,
    dspRoadLpfSv,
    dspKalmanXSv,
    dspKalmanPSv,
    hasCalibSv,
    dspPeakG,
    peakFifo0Sv,
    peakFifo1Sv,
    peakFifo2Sv,
    peakFifo3Sv,
    dspPeakRollLeftDeg,
    dspPeakRollRightDeg,
    dspPeakVertZSv,
    dspPitchDeg,
    dspRollDeg,
    pitchCalBiasDegSv,
    rollCalBiasDegSv,
    pitchFusDegSv,
    rollFusDegSv,
    waveData,
    writeIdxSv,
    sampleTick,
    hudDisplayZSv,
    lastAccelSampleWallMsSv,
    terrainKindSv,
    terrainSbStateSv,
    terrainSbPeakTimeSv,
    terrainPhStateSv,
    terrainPhPeakTimeSv,
    terrainFlashStartSv,
    terrainOverlayOpacitySv,
  } = sv;

  const flashCalBanner = useCallback(() => {
    setCalUiBanner('Calibrating · Z on zero');
    setTimeout(() => setCalUiBanner(null), 450);
  }, []);

  /** CAL: freeze gravity axis = normalized accelerometer vector; zero vertical bump channel. Pitch/roll bias from accel. */
  const instantCalibrate = useCallback(() => {
    runOnUI(() => {
      'worklet';
      const bx = rawAx.value;
      const by = rawAy.value;
      const bz = rawAz.value;
      const m = Math.sqrt(bx * bx + by * by + bz * bz);
      if (m > 1e-6) {
        gravUnitX.value = bx / m;
        gravUnitY.value = by / m;
        gravUnitZ.value = bz / m;
      }

      cleanVertZSv.value = 0;
      vertUserLpSv.value = 0;
      dspDriftLpSv.value = 0;
      dspRoadLpfSv.value = 0;
      dspKalmanXSv.value = 0;
      dspKalmanPSv.value = KALMAN_P0;
      lastAccelSampleWallMsSv.value = 0;
      terrainKindSv.value = 0;
      terrainSbStateSv.value = 0;
      terrainSbPeakTimeSv.value = 0;
      terrainPhStateSv.value = 0;
      terrainPhPeakTimeSv.value = 0;
      terrainFlashStartSv.value = 0;
      terrainOverlayOpacitySv.value = 0;

      dspPeakG.value = 0;
      peakFifo0Sv.value = 0;
      peakFifo1Sv.value = 0;
      peakFifo2Sv.value = 0;
      peakFifo3Sv.value = 0;
      dspPeakRollLeftDeg.value = 0;
      dspPeakRollRightDeg.value = 0;
      dspPeakVertZSv.value = 0;
      dspPitchDeg.value = 0;
      dspRollDeg.value = 0;

      const { pitchDeg: pCal, rollDeg: rCal } = accelPitchRollDegAbsolute(bx, by, bz);
      pitchCalBiasDegSv.value = pCal;
      rollCalBiasDegSv.value = rCal;
      pitchFusDegSv.value = pCal;
      rollFusDegSv.value = rCal;

      const buf = waveData.value;
      buf.fill(0);
      waveData.value = buf;
      writeIdxSv.value = 0;
      sampleTick.value = 0;
      hudDisplayZSv.value = displayWorldZG(cleanVertZSv.value);

      hasCalibSv.value = 1;
    })();
    flashCalBanner();
    resetBumpFsm();
    setBumpDiag(null);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [flashCalBanner, resetBumpFsm]);

  const resetPeakMax = useCallback(() => {
    runOnUI(() => {
      'worklet';
      dspPeakG.value = 0;
      peakFifo0Sv.value = 0;
      peakFifo1Sv.value = 0;
      peakFifo2Sv.value = 0;
      peakFifo3Sv.value = 0;
      dspPeakRollLeftDeg.value = 0;
      dspPeakRollRightDeg.value = 0;
      dspPeakVertZSv.value = 0;
    })();
  }, [
    dspPeakG,
    peakFifo0Sv,
    peakFifo1Sv,
    peakFifo2Sv,
    peakFifo3Sv,
    dspPeakRollLeftDeg,
    dspPeakRollRightDeg,
    dspPeakVertZSv,
  ]);

  return { flashCalBanner, instantCalibrate, resetPeakMax };
}
