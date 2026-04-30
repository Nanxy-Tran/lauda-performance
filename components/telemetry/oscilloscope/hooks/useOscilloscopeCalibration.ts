import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { runOnUI } from 'react-native-reanimated';

import type { OscilloscopeSharedValues } from './useOscilloscopeSharedValues';

type CalibrationParams = {
  sv: OscilloscopeSharedValues;
  resetBumpFsm: () => void;
  clearBumpDiagnostics: () => void;
  /** When non-null (e.g. OscilloscopeView), disables CAL buttons while precision cal runs */
  setPrecisionCalibBusy?: Dispatch<SetStateAction<boolean>>;
};

export function useOscilloscopeCalibration({
  sv,
  resetBumpFsm,
  clearBumpDiagnostics,
  setPrecisionCalibBusy,
}: CalibrationParams) {
  const {
    calStateSv,
    calStartMsSv,
    calSumX,
    calSumY,
    calSumZ,
    calCount,
    calProgressSv,
    hasCalibSv,
    dspPeakG,
    peakFifo0Sv,
    peakFifo1Sv,
    peakFifo2Sv,
    peakFifo3Sv,
    dspPeakRollLeftDeg,
    dspPeakRollRightDeg,
    dspPeakVertZSv,
  } = sv;

  const startPrecisionCalibrate = useCallback(() => {
    setPrecisionCalibBusy?.(true);
    resetBumpFsm();
    clearBumpDiagnostics();
    runOnUI(() => {
      'worklet';
      calSumX.value = 0;
      calSumY.value = 0;
      calSumZ.value = 0;
      calCount.value = 0;
      calProgressSv.value = 0;
      hasCalibSv.value = 0;
      calStartMsSv.value = Date.now();
      calStateSv.value = 1;
    })();
  }, [
    calCount,
    calProgressSv,
    calStartMsSv,
    calStateSv,
    calSumX,
    calSumY,
    calSumZ,
    clearBumpDiagnostics,
    hasCalibSv,
    resetBumpFsm,
    setPrecisionCalibBusy,
  ]);

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

  return { startPrecisionCalibrate, resetPeakMax };
}
