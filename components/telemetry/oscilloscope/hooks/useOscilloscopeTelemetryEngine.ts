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
import { Skia, type SkPath } from '@shopify/react-native-skia';

import {
  BUFFER_LEN,
  HUD_ANGLE_EMA,
  PEAK_THRESHOLD_G,
  PEAK_MA_SAMPLES,
  SPEED_DISPLAY_ZERO_BELOW_KMH,
} from '../constants';
import {
  SENSOR_INTERVAL_MS_TARGET,
  TERRAIN_FLAT,
  TERRAIN_PAIR_WINDOW_MS,
  TERRAIN_POTHOLE,
  TERRAIN_POTHOLE_NEG_G,
  TERRAIN_POTHOLE_POS_G,
  TERRAIN_SPEED_BUMP,
  TERRAIN_SPEED_BUMP_NEG_G,
  TERRAIN_SPEED_BUMP_POS_G,
} from '../dspConstants';
import { accelPitchRollDegAbsolute, displayWorldZG, hudTiltDisplayDeg } from '../sensorMath';
import type { HudSnap } from '../types';
import type { OscilloscopeSharedValues } from './useOscilloscopeSharedValues';

function splineTraceFromBuffer(opts: {
  buf: Float32Array;
  wi: number;
  delaySamples: number;
  cw: number;
  ch: number;
  amp: number;
  pxPerSample: number;
}): SkPath {
  'worklet';
  const { buf, wi, delaySamples, amp, pxPerSample } = opts;
  void opts.cw;
  const midY = opts.ch * 0.52;
  const delayed = delaySamples > 0;

  const xs = new Float32Array(BUFFER_LEN);
  const ys = new Float32Array(BUFFER_LEN);
  let n = 0;

  for (let i = 0; i < BUFFER_LEN; i++) {
    let j: number;
    if (wi < BUFFER_LEN) {
      if (i >= wi) continue;
      j = i;
    } else {
      j = (wi - BUFFER_LEN + i + BUFFER_LEN * 64) % BUFFER_LEN;
    }
    let jr = j;
    if (delayed) {
      jr = (j - delaySamples + BUFFER_LEN * 64) % BUFFER_LEN;
    }
    const v = buf[jr];
    const vx = pxPerSample * i;
    if (!Number.isFinite(v)) continue;
    xs[n] = vx;
    ys[n] = midY - v * amp;
    n++;
  }

  const p = Skia.Path.Make();
  if (n < 2) {
    let started = false;
    let gap = false;
    for (let i = 0; i < BUFFER_LEN; i++) {
      let jj: number;
      if (wi < BUFFER_LEN) {
        if (i >= wi) {
          gap = true;
          continue;
        }
        jj = i;
      } else {
        jj = (wi - BUFFER_LEN + i + BUFFER_LEN * 64) % BUFFER_LEN;
      }
      let jjr = jj;
      if (delayed) {
        jjr = (jj - delaySamples + BUFFER_LEN * 64) % BUFFER_LEN;
      }
      const ve = buf[jjr];
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
}

export function useAccelerometerStream(
  rawAx: OscilloscopeSharedValues['rawAx'],
  rawAy: OscilloscopeSharedValues['rawAy'],
  rawAz: OscilloscopeSharedValues['rawAz']
) {
  useEffect(() => {
    let alive = true;
    Accelerometer.setUpdateInterval(SENSOR_INTERVAL_MS_TARGET);

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
    terrainKindSv,
    terrainSbStateSv,
    terrainSbPeakTimeSv,
    terrainPhStateSv,
    terrainPhPeakTimeSv,
    terrainFlashStartSv,
    terrainOverlayOpacitySv,
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
   * UI-thread pipeline: gravity-linear Z → preset-tunable EMA on `cleanVertZSv`.
   * Terrain bumps/potholes and chart buffer track the same smoothed Δg signal.
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
      const now = Date.now();

      const bx = cur.ax;
      const by = cur.ay;
      const bz = cur.az;

      const z_total = bx * cur.gux + by * cur.guy + bz * cur.guz;
      const vert_z_raw = z_total - 1.0;

      if (cur.hasCalib === 1) {
        const alpha = cur.vertFastAlpha;
        cleanVertZSv.value = alpha * vert_z_raw + (1 - alpha) * cleanVertZSv.value;

        const zt = cleanVertZSv.value;
        const win = TERRAIN_PAIR_WINDOW_MS;

        if (terrainSbStateSv.value === 0 && zt > TERRAIN_SPEED_BUMP_POS_G) {
          terrainSbStateSv.value = 1;
          terrainSbPeakTimeSv.value = now;
        } else if (terrainSbStateSv.value === 1) {
          const t0 = terrainSbPeakTimeSv.value;
          if (zt < TERRAIN_SPEED_BUMP_NEG_G && now - t0 <= win) {
            terrainKindSv.value = TERRAIN_SPEED_BUMP;
            terrainFlashStartSv.value = now;
            terrainOverlayOpacitySv.value = 1;
            terrainSbStateSv.value = 0;
          } else if (now - t0 > win) {
            terrainSbStateSv.value = 0;
          }
        }

        if (terrainPhStateSv.value === 0 && zt < TERRAIN_POTHOLE_NEG_G) {
          terrainPhStateSv.value = 1;
          terrainPhPeakTimeSv.value = now;
        } else if (terrainPhStateSv.value === 1) {
          const t0 = terrainPhPeakTimeSv.value;
          if (zt > TERRAIN_POTHOLE_POS_G && now - t0 <= win) {
            terrainKindSv.value = TERRAIN_POTHOLE;
            terrainFlashStartSv.value = now;
            terrainOverlayOpacitySv.value = 1;
            terrainPhStateSv.value = 0;
          } else if (now - t0 > win) {
            terrainPhStateSv.value = 0;
          }
        }
      } else {
        cleanVertZSv.value = 0;
        terrainSbStateSv.value = 0;
        terrainPhStateSv.value = 0;
        terrainKindSv.value = TERRAIN_FLAT;
      }

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

  const terrainOverlayFrame = useMemo(() => {
    const tick = () => {
      'worklet';
      const start = terrainFlashStartSv.value;
      if (start <= 0) {
        terrainOverlayOpacitySv.value = 0;
        return;
      }
      const elapsed = Date.now() - start;
      if (elapsed >= 2000) {
        terrainOverlayOpacitySv.value = 0;
        terrainFlashStartSv.value = 0;
        terrainKindSv.value = TERRAIN_FLAT;
        return;
      }
      terrainOverlayOpacitySv.value = Math.max(0, 1 - elapsed / 2000);
    };
    return tick;
  }, []);

  useFrameCallback(terrainOverlayFrame);

  const chartRedrawSv = useSharedValue(0);
  const chartRedrawFrame = useMemo(() => () => {
    'worklet';
    chartRedrawSv.value = (chartRedrawSv.value + 1) % 1e9;
  }, []);
  useFrameCallback(chartRedrawFrame);

  const gridPath = useDerivedValue(() => {
    'worklet';
    void sampleTick.value;
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
    void sampleTick.value;
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
    void chartRedrawSv.value;
    void sampleTick.value;
    const cw = chartWsv.value;
    const ch = chartHsv.value;
    void sensitivityMultiplierSv.value;
    const pxPerSample = BUFFER_LEN > 1 ? cw / (BUFFER_LEN - 1) : cw;
    const amp = ch * 0.42 * 1.05 * sensitivityMultiplierSv.value;
    return splineTraceFromBuffer({
      buf: waveData.value,
      wi: writeIdxSv.value,
      delaySamples: 0,
      cw,
      ch,
      amp,
      pxPerSample,
    });
  });

  return {
    hud,
    onChartLayout,
    gridPath,
    baselinePath,
    oscilloscopePath,
    terrainKindSv,
    terrainOverlayOpacitySv,
  };
}
