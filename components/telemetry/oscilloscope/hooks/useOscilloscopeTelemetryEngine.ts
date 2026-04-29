import { Accelerometer } from 'expo-sensors';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import {
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { Skia } from '@shopify/react-native-skia';

import {
  BUFFER_LEN,
  HUD_ANGLE_EMA,
  PEAK_THRESHOLD_G,
  PEAK_MA_SAMPLES,
  SPEED_DISPLAY_ZERO_BELOW_KMH,
} from '../constants';
import { accelPitchRollDegAbsolute, displayWorldZG, hudTiltDisplayDeg } from '../sensorMath';
import type { HudSnap } from '../types';
import type { OscilloscopeSharedValues } from './useOscilloscopeSharedValues';

export function useAccelerometerStream(
  rawAx: OscilloscopeSharedValues['rawAx'],
  rawAy: OscilloscopeSharedValues['rawAy'],
  rawAz: OscilloscopeSharedValues['rawAz']
) {
  useEffect(() => {
    let alive = true;
    Accelerometer.setUpdateInterval(16);

    const sa = Accelerometer.addListener(({ x, y, z }) => {
      if (!alive) return;
      rawAx.value = x;
      rawAy.value = y;
      rawAz.value = z;
    });

    return () => {
      alive = false;
      sa?.remove?.();
    };
  }, [rawAx, rawAy, rawAz]);
}

export function useChartSizeSync(
  winW: number,
  winH: number,
  chartWsv: OscilloscopeSharedValues['chartWsv'],
  chartHsv: OscilloscopeSharedValues['chartHsv']
) {
  useLayoutEffect(() => {
    chartWsv.value = Math.max(winW, 120);
    chartHsv.value = Math.max(winH * 0.52, 140);
  }, [winW, winH, chartWsv, chartHsv]);
}

export function useOscilloscopeTelemetryEngine(
  winW: number,
  winH: number,
  dashLocked: boolean,
  setAdvancedSettingsOpen: Dispatch<SetStateAction<boolean>>,
  sv: OscilloscopeSharedValues,
  isHfLoggingSv: SharedValue<number>,
  appendHfData: (z: number, pitch: number, roll: number, speed: number) => void
) {
  const [hud, setHud] = useState<HudSnap>({
    pitch: 0,
    roll: 0,
    peak: 0,
    speed: 0,
    zG: 0,
    peakRollLeft: 0,
    peakRollRight: 0,
    peakVertZ: 0,
  });

  const {
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
  } = sv;

  useAccelerometerStream(rawAx, rawAy, rawAz);
  useChartSizeSync(winW, winH, chartWsv, chartHsv);

  useEffect(() => {
    if (dashLocked) {
      setAdvancedSettingsOpen(false);
    }
  }, [dashLocked, setAdvancedSettingsOpen]);

  const onChartLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      chartWsv.value = width;
      chartHsv.value = height;
    },
    [chartWsv, chartHsv]
  );

  /**
   * Single UI-thread reaction: dot-product vertical accel (static gravity axis), VERT_FAST LPF,
   * chart buffer / peaks / accel-only HUD pitch–roll EMA (no gyro).
   */
  useAnimatedReaction(
    () => ({
      ax: rawAx.value,
      ay: rawAy.value,
      az: rawAz.value,
      gux: gravUnitX.value,
      guy: gravUnitY.value,
      guz: gravUnitZ.value,
      hasCalib: hasCalibSv.value,
      vertFastAlpha: vertFastAlphaSv.value,
    }),
    (cur) => {
      'worklet';
      const bx = cur.ax;
      const by = cur.ay;
      const bz = cur.az;
      const va = cur.vertFastAlpha;

      const z_total = bx * cur.gux + by * cur.guy + bz * cur.guz;
      const vert_z_raw = z_total - 1.0;
      cleanVertZSv.value = va * vert_z_raw + (1 - va) * cleanVertZSv.value;

      /** Raw LPF output for waveform (no stationary deadzone). */
      const chartSample = cleanVertZSv.value;

      peakFifo3Sv.value = peakFifo2Sv.value;
      peakFifo2Sv.value = peakFifo1Sv.value;
      peakFifo1Sv.value = peakFifo0Sv.value;
      peakFifo0Sv.value = vert_z_raw;
      const maZ =
        (peakFifo0Sv.value +
          peakFifo1Sv.value +
          peakFifo2Sv.value +
          peakFifo3Sv.value) /
        PEAK_MA_SAMPLES;

      if (Math.abs(maZ) > Math.abs(dspPeakG.value) && Math.abs(maZ) > PEAK_THRESHOLD_G) {
        dspPeakG.value = Math.abs(maZ);
      }

      if (cur.hasCalib === 1) {
        const { pitchDeg: aPitch, rollDeg: aRoll } = accelPitchRollDegAbsolute(bx, by, bz);
        pitchFusDegSv.value = HUD_ANGLE_EMA * aPitch + (1 - HUD_ANGLE_EMA) * pitchFusDegSv.value;
        rollFusDegSv.value = HUD_ANGLE_EMA * aRoll + (1 - HUD_ANGLE_EMA) * rollFusDegSv.value;

        const pitchRel = pitchFusDegSv.value - pitchCalBiasDegSv.value;
        const rollRel = rollFusDegSv.value - rollCalBiasDegSv.value;
        dspPitchDeg.value = HUD_ANGLE_EMA * pitchRel + (1 - HUD_ANGLE_EMA) * dspPitchDeg.value;
        dspRollDeg.value = HUD_ANGLE_EMA * rollRel + (1 - HUD_ANGLE_EMA) * dspRollDeg.value;

        const rDeg = dspRollDeg.value;
        if (rDeg < 0) {
          const magL = -rDeg;
          if (magL > dspPeakRollLeftDeg.value) dspPeakRollLeftDeg.value = magL;
        } else if (rDeg > 0) {
          if (rDeg > dspPeakRollRightDeg.value) dspPeakRollRightDeg.value = rDeg;
        }

        if (
          Math.abs(chartSample) > dspPeakVertZSv.value &&
          Math.abs(chartSample) > PEAK_THRESHOLD_G
        ) {
          dspPeakVertZSv.value = Math.abs(chartSample);
        }
      } else {
        dspPitchDeg.value = 0;
        dspRollDeg.value = 0;
        pitchFusDegSv.value = 0;
        rollFusDegSv.value = 0;
      }

      const buf = waveData.value;
      const idx = writeIdxSv.value % BUFFER_LEN;
      buf[idx] = chartSample;
      writeIdxSv.value += 1;
      waveData.value = buf;

      hudDisplayZSv.value = displayWorldZG(cleanVertZSv.value);
      sampleTick.value += 1;

      if (isHfLoggingSv.value === 1) {
        runOnJS(appendHfData)(cleanVertZSv.value, dspPitchDeg.value, dspRollDeg.value, speedKmH.value);
      }
    }
  );

  const vertZHudDerived = useDerivedValue(() => displayWorldZG(cleanVertZSv.value));

  const hudFrame = useSharedValue(0);

  const pushHud = useCallback((snap: HudSnap) => {
    setHud(snap);
  }, []);

  /* eslint-disable react-hooks/exhaustive-deps */
  const hudFrameWorklet = useMemo(() => () => {
    'worklet';
    hudFrame.value += 1;
    if (hudFrame.value % 12 !== 0) {
      return;
    }
    const vKmh = speedKmH.value;
    runOnJS(pushHud)({
      pitch: hudTiltDisplayDeg(dspPitchDeg.value),
      roll: hudTiltDisplayDeg(dspRollDeg.value),
      peak: dspPeakG.value,
      speed: vKmh < SPEED_DISPLAY_ZERO_BELOW_KMH ? 0 : vKmh,
      zG: vertZHudDerived.value,
      peakRollLeft: dspPeakRollLeftDeg.value,
      peakRollRight: dspPeakRollRightDeg.value,
      peakVertZ: dspPeakVertZSv.value,
    });
  }, [pushHud, vertZHudDerived]);
  /* eslint-enable react-hooks/exhaustive-deps */

  useFrameCallback(hudFrameWorklet);

  const gridPath = useDerivedValue(() => {
    'worklet';
    const tick = sampleTick.value;
    void tick;
    const w = chartWsv.value;
    const h = chartHsv.value;
    const p = Skia.Path.Make();
    const nx = 10;
    const ny = 14;
    for (let ix = 0; ix <= nx; ix++) {
      const x = (ix / nx) * w;
      p.moveTo(x, 0);
      p.lineTo(x, h);
    }
    for (let iy = 0; iy <= ny; iy++) {
      const y = (iy / ny) * h;
      p.moveTo(0, y);
      p.lineTo(w, y);
    }
    return p;
  });

  const baselinePath = useDerivedValue(() => {
    'worklet';
    const tick = sampleTick.value;
    void tick;
    const ch = chartHsv.value;
    const cw = chartWsv.value;
    const midY = ch * 0.52;
    const path = Skia.Path.Make();
    path.moveTo(0, midY);
    path.lineTo(cw, midY);
    return path;
  });

  const oscilloscopePath = useDerivedValue(() => {
    'worklet';
    const tick = sampleTick.value;
    void tick;
    const cw = chartWsv.value;
    const ch = chartHsv.value;
    void sensitivityMultiplierSv.value;
    const pxPerSample = BUFFER_LEN > 1 ? cw / (BUFFER_LEN - 1) : cw;
    const midY = ch * 0.52;
    const amp = ch * 0.42 * 1.05 * sensitivityMultiplierSv.value;
    const buf = waveData.value;
    const wi = writeIdxSv.value;
    const p = Skia.Path.Make();

    const xs = new Float32Array(BUFFER_LEN);
    const ys = new Float32Array(BUFFER_LEN);
    let n = 0;

    for (let i = 0; i < BUFFER_LEN; i++) {
      let j: number;
      if (wi < BUFFER_LEN) {
        if (i >= wi) {
          continue;
        }
        j = i;
      } else {
        j = (wi - BUFFER_LEN + i + BUFFER_LEN * 64) % BUFFER_LEN;
      }
      const v = buf[j];
      const vx = pxPerSample * i;
      if (!Number.isFinite(v)) {
        continue;
      }
      xs[n] = vx;
      ys[n] = midY - v * amp;
      n++;
    }

    if (n < 2) {
      let started = false;
      let gap = false;
      for (let i = 0; i < BUFFER_LEN; i++) {
        let j: number;
        if (wi < BUFFER_LEN) {
          if (i >= wi) {
            gap = true;
            continue;
          }
          j = i;
        } else {
          j = (wi - BUFFER_LEN + i + BUFFER_LEN * 64) % BUFFER_LEN;
        }
        const ve = buf[j];
        const vx = pxPerSample * i;
        if (!Number.isFinite(ve)) {
          gap = true;
          continue;
        }
        const vy = midY - ve * amp;
        if (!started || gap) {
          p.moveTo(vx, vy);
          started = true;
          gap = false;
        } else {
          p.lineTo(vx, vy);
        }
      }
      return p;
    }

    if (n === 2) {
      p.moveTo(xs[0], ys[0]);
      p.lineTo(xs[1], ys[1]);
      return p;
    }

    const m0x = (xs[0] + xs[1]) * 0.5;
    const m0y = (ys[0] + ys[1]) * 0.5;
    p.moveTo(m0x, m0y);

    for (let k = 1; k + 1 < n; k++) {
      const ex = k + 1 < n - 1 ? (xs[k] + xs[k + 1]) * 0.5 : xs[n - 1];
      const ey = k + 1 < n - 1 ? (ys[k] + ys[k + 1]) * 0.5 : ys[n - 1];
      p.quadTo(xs[k], ys[k], ex, ey);
    }

    return p;
  });

  return {
    hud,
    onChartLayout,
    gridPath,
    baselinePath,
    oscilloscopePath,
  };
}
