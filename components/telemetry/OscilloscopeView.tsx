import {
  Accelerometer,
  Gyroscope,
} from 'expo-sensors';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import { Canvas, Fill, Path, Skia } from '@shopify/react-native-skia';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const BUFFER_LEN = 360;
const CAL_DURATION_MS = 5000;
const STABILIZE_MS = 1000;

/**
 * expo-sensors accelerometer (g): X lateral (right in portrait), Y longitudinal (toward top of device),
 * Z vertical (screen normal; ~+1 g screen-up on a table). Gyro uses the same axis pairing.
 */
function expoAccelToBikeFrame(ax: number, ay: number, az: number) {
  return { bx: ax, by: ay, bz: az };
}

function normalizeQuat(
  qw: number,
  qx: number,
  qy: number,
  qz: number
): [number, number, number, number] {
  'worklet';
  let len = qw * qw + qx * qx + qy * qy + qz * qz;
  if (len < 1e-12) {
    return [1, 0, 0, 0];
  }
  len = Math.sqrt(len);
  return [qw / len, qx / len, qy / len, qz / len];
}

/** Body → world rotation matrix from unit quaternion q = [w,x,y,z]. */
function mat3BodyToWorld(qw: number, qx: number, qy: number, qz: number) {
  'worklet';
  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;

  const m00 = 1 - 2 * (yy + zz);
  const m01 = 2 * (xy - wz);
  const m02 = 2 * (xz + wy);
  const m10 = 2 * (xy + wz);
  const m11 = 1 - 2 * (xx + zz);
  const m12 = 2 * (yz - wx);
  const m20 = 2 * (xz - wy);
  const m21 = 2 * (yz + wx);
  const m22 = 1 - 2 * (xx + yy);
  return { m00, m01, m02, m10, m11, m12, m20, m21, m22 };
}

function rotateBodyToWorld(
  m: ReturnType<typeof mat3BodyToWorld>,
  bx: number,
  by: number,
  bz: number
) {
  'worklet';
  return {
    x: m.m00 * bx + m.m01 * by + m.m02 * bz,
    y: m.m10 * bx + m.m11 * by + m.m12 * bz,
    z: m.m20 * bx + m.m21 * by + m.m22 * bz,
  };
}

/** Rᵀ·[0,0,1]: expected gravity dir in body (unit world +Z upward). */
function gravBodyExpected(m: ReturnType<typeof mat3BodyToWorld>) {
  'worklet';
  return { x: m.m02, y: m.m12, z: m.m22 };
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  'worklet';
  return {
    x: ay * bz - az * by,
    y: az * bx - ax * bz,
    z: ax * by - ay * bx,
  };
}

/** q̇ = 0.5 * q ⊗ (0, ω) */
function quatDerivative(
  qw: number,
  qx: number,
  qy: number,
  qz: number,
  wx: number,
  wy: number,
  wz: number
): [number, number, number, number] {
  'worklet';
  const dqw = -0.5 * (qx * wx + qy * wy + qz * wz);
  const dqx = 0.5 * (qw * wx + qy * wz - qz * wy);
  const dqy = 0.5 * (qw * wy - qx * wz + qz * wx);
  const dqz = 0.5 * (qw * wz + qx * wy - qy * wx);
  return [dqw, dqx, dqy, dqz];
}

/** Chart EMA pole α ∈ [0.12, 0.15] — high smoothness (“buttery” trace). Slider scales within band. */
function sliderToAlpha(slider01: number) {
  'worklet';
  const s = Math.min(Math.max(slider01, 0), 1);
  return 0.12 + s * 0.03;
}

/** Stationary: trust gravity more (accel blend ↑). Matches (1−ALPHA)=~0.10 */
const ACCEL_WEIGHT_STAT = 0.1;
/** Dynamic: trust gyro predominantly. Matches (1−ALPHA)=~0.01 */
const ACCEL_WEIGHT_DYNAMIC = 0.01;
/** gyro rad/s — blend interpolates stationary→dynamic across this span */
const ACCEL_BLEND_STATIC_GYRO_MAG_RPS = 0.06;
const ACCEL_BLEND_DYNAMIC_GYRO_MAG_RPS = 0.26;

/**
 * Adaptive accel weight for complementary fusion (decouples pitch/roll under motion vs gravity at rest).
 * angle = ALPHA·(prev + gyro·Δt) + (1−ALPHA)·accel; (1−ALPHA)=accelBlend.
 */
function adaptiveAccelBlend(gyroMagRadS: number) {
  'worklet';
  const low = ACCEL_BLEND_STATIC_GYRO_MAG_RPS;
  const high = ACCEL_BLEND_DYNAMIC_GYRO_MAG_RPS;
  if (gyroMagRadS <= low) {
    return ACCEL_WEIGHT_STAT;
  }
  if (gyroMagRadS >= high) {
    return ACCEL_WEIGHT_DYNAMIC;
  }
  const t = (gyroMagRadS - low) / (high - low);
  return ACCEL_WEIGHT_STAT + t * (ACCEL_WEIGHT_DYNAMIC - ACCEL_WEIGHT_STAT);
}

/** HUD pitch/roll complementary display EMA — heavy damping for motorcycle vibration (stable, “heavy”). */
const HUD_ANGLE_EMA = 0.03;

const RAD_TO_DEG = 180 / Math.PI;

/** dt clamps: integration stability + avoid duplicate timestamps. */
const DT_MIN_S = 1 / 800;
const DT_MAX_S = 0.12;

/**
 * Stationary deadzone (g): |World_Z| below this → display 0.00 (chart + leak prevention).
 */
const STATIONARY_DEADZONE_Z_G = 0.04;

/** Speed below this (km/h) displays as zero. */
const SPEED_DISPLAY_ZERO_BELOW_KMH = 5;

/** Absolute tilt (deg): Pitch = atan2(ay, az), Roll = atan2(-ax, √(ay²+az²)) — accelerometer gravity anchor. */
function accelPitchRollDegAbsolute(ax: number, ay: number, az: number): {
  pitchDeg: number;
  rollDeg: number;
} {
  'worklet';
  const yz = ay * ay + az * az;
  const denom = yz > 0 ? Math.sqrt(yz) : 0;
  const pitchDeg = Math.atan2(ay, az) * RAD_TO_DEG;
  const rollDeg = Math.atan2(-ax, denom) * RAD_TO_DEG;
  return { pitchDeg, rollDeg };
}

/** Gravity direction correction (accel vs expected) fused into gyro. */
const BETA = 0.04;

/** Peak-G hysteresis — ignore buzz below this magnitude on MA_Z (motorcycle vibration). */
const PEAK_THRESHOLD_G = 0.15;
/** Moving-average length for Peak-G (40ms @ ~100Hz-ish sampling ≈ 4 samples). */
const PEAK_MA_SAMPLES = 4;

/**
 * Slow EMA coefficient for tracking world-Z gravity / DC bias (sensor drift).
 * Only long-term creep; sudden bumps stay in the high-pass output.
 */
const ALPHA_SLOW_DC = 0.002;

/** Clamp world linear Z after offset for display pipeline (OSC + HUD). */
function displayWorldZG(zAfterOffsetG: number) {
  'worklet';
  const z = zAfterOffsetG;
  return Math.abs(z) < STATIONARY_DEADZONE_Z_G ? 0 : z;
}

const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

type HudSnap = {
  pitch: number;
  roll: number;
  peak: number;
  speed: number;
  /** Deadzone’d vertical linear G (same as chart). */
  zG: number;
  peakRollLeft: number;
  peakRollRight: number;
  peakVertZ: number;
};

export default function OscilloscopeView() {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const mono = (MONO as string) ?? 'monospace';

  const chartWsv = useSharedValue(Math.max(winW, 120));
  const chartHsv = useSharedValue(winH);

  const rawAx = useSharedValue(0);
  const rawAy = useSharedValue(0);
  const rawAz = useSharedValue(1);
  const rawGx = useSharedValue(0);
  const rawGy = useSharedValue(0);
  const rawGz = useSharedValue(0);
  const sensorTs = useSharedValue(-1);

  const qwSv = useSharedValue(1);
  const qxSv = useSharedValue(0);
  const qySv = useSharedValue(0);
  const qzSv = useSharedValue(0);

  /** Dynamic gravity / DC estimate (world Z, g) — slow EMA of raw_Z; drift-free Z = raw − this. */
  const currentGravityZSv = useSharedValue(1);

  const z1Sv = useSharedValue(0);
  const z2Sv = useSharedValue(0);

  /** Legacy static Z bias (unused for display; kept 0 — vertical axis uses currentGravityZSv). */
  const offsetZSv = useSharedValue(0);

  /** Attitude snapshot at calibration end for relative pitch / roll HUD. */
  const qCalW = useSharedValue(1);
  const qCalX = useSharedValue(0);
  const qCalY = useSharedValue(0);
  const qCalZ = useSharedValue(0);

  /** 0 = acquire · plot + EMA, 1 = 5 s cal (no plot / no EMA), 2 = 1 s stabilize (EMA on, plot off). */
  const dspPhaseSv = useSharedValue(0);
  /** After first CAL, relative angles are trustworthy. */
  const hasCalibSv = useSharedValue(0);

  const slider01 = useSharedValue(1 / 3);

  const writeIdxSv = useSharedValue(0);
  const waveData = useSharedValue(new Float32Array(BUFFER_LEN));
  const sampleTick = useSharedValue(0);

  /** Fused absolute pitch/roll (deg); complementary filter with accel anchor. */
  const pitchFusDegSv = useSharedValue(0);
  const rollFusDegSv = useSharedValue(0);
  /** Snapshot of absolute tilt at CAL (deg) — HUD shows fused minus these. */
  const pitchCalBiasDegSv = useSharedValue(0);
  const rollCalBiasDegSv = useSharedValue(0);

  const dspPitchDeg = useSharedValue(0);
  const dspRollDeg = useSharedValue(0);
  const dspPeakG = useSharedValue(0);
  /** Max lean magnitudes (deg, positive each side) from HUD roll after cal. */
  const dspPeakRollLeftDeg = useSharedValue(0);
  const dspPeakRollRightDeg = useSharedValue(0);
  /** Max magnitude of displayed Vert Z (deadzone’d, post shock filter). */
  const dspPeakVertZSv = useSharedValue(0);
  /** Last chart sample (g) after deadzone — HUD Z readout. */
  const hudDisplayZSv = useSharedValue(0);
  /** Rolling raw Z (after grav offset, pre deadzone) for Peak-G MA buffer. */
  const peakFifo0Sv = useSharedValue(0);
  const peakFifo1Sv = useSharedValue(0);
  const peakFifo2Sv = useSharedValue(0);
  const peakFifo3Sv = useSharedValue(0);

  const speedKmH = useSharedValue(0);

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
  const [calUiBanner, setCalUiBanner] = useState<string | null>(null);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [dashLocked, setDashLocked] = useState(false);

  const calibratingSamplingRef = useRef(false);
  const calAccelSumRef = useRef({ sx: 0, sy: 0, sz: 0, n: 0 });
  const calTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hudFrame = useSharedValue(0);

  useLayoutEffect(() => {
    chartWsv.value = Math.max(winW, 120);
    chartHsv.value = Math.max(winH * 0.52, 140);
  }, [winW, winH, chartWsv, chartHsv]);

  const onChartLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      chartWsv.value = width;
      chartHsv.value = height;
    },
    [chartWsv, chartHsv]
  );

  useEffect(() => {
    let alive = true;
    Accelerometer.setUpdateInterval(16);
    Gyroscope.setUpdateInterval(16);

    const sa = Accelerometer.addListener(({ x, y, z, timestamp }) => {
      if (!alive) return;
      rawAx.value = x;
      rawAy.value = y;
      rawAz.value = z;
      sensorTs.value = timestamp && timestamp > 0 ? timestamp : performance.now() / 1000;
      if (calibratingSamplingRef.current) {
        const bf = expoAccelToBikeFrame(x, y, z);
        calAccelSumRef.current.sx += bf.bx;
        calAccelSumRef.current.sy += bf.by;
        calAccelSumRef.current.sz += bf.bz;
        calAccelSumRef.current.n += 1;
      }
    });

    const sg = Gyroscope.addListener(({ x, y, z }) => {
      if (!alive) return;
      rawGx.value = x;
      rawGy.value = y;
      rawGz.value = z;
    });

    return () => {
      alive = false;
      sa?.remove?.();
      sg?.remove?.();
    };
  }, [rawAx, rawAy, rawAz, rawGx, rawGy, rawGz, sensorTs]);

  useEffect(() => {
    let sub: Location.LocationSubscription | undefined;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        speedKmH.value = 0;
        return;
      }
      try {
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 400,
            distanceInterval: 1,
          },
          (loc) => {
            const s = Math.max(loc.coords.speed ?? 0, 0);
            speedKmH.value = s * 3.6;
          }
        );
      } catch {
        speedKmH.value = 0;
      }
    })();
    return () => {
      void sub?.remove();
    };
  }, [speedKmH]);

  useEffect(() => {
    if (dashLocked) {
      setAdvancedSettingsOpen(false);
    }
  }, [dashLocked]);

  const lastTsSv = useSharedValue(-1);

  useAnimatedReaction(
    () => [
      rawAx.value,
      rawAy.value,
      rawAz.value,
      rawGx.value,
      rawGy.value,
      rawGz.value,
      sensorTs.value,
      slider01.value,
      dspPhaseSv.value,
      hasCalibSv.value,
    ],
    (vals) => {
      'worklet';
      const ax = vals[0] as number;
      const ay = vals[1] as number;
      const az = vals[2] as number;
      const gx = vals[3] as number;
      const gy = vals[4] as number;
      const gz = vals[5] as number;
      const ts = vals[6] as number;
      const slid = vals[7] as number;
      const phase = vals[8] as number;
      const hasCalib = vals[9] as number;

      const prevTs = lastTsSv.value;
      let dt = ts > 0 && prevTs > 0 ? ts - prevTs : 1 / 120;
      lastTsSv.value = ts > 0 ? ts : lastTsSv.value;
      if (!(dt > 0) || dt > DT_MAX_S) {
        dt = 1 / 120;
      } else if (dt < DT_MIN_S) {
        dt = DT_MIN_S;
      }

      const alpha = sliderToAlpha(slid);
      /** Bike frame = expo portrait axes (must be inlined — no JS helpers in worklets). */
      const bx = ax;
      const by = ay;
      const bz = az;
      const wxg = gx;
      const wyg = gy;
      const wzg = gz;

      let qw = qwSv.value;
      let qx = qxSv.value;
      let qy = qySv.value;
      let qz = qzSv.value;

      const [nqw, nqx, nqy, nqz] = normalizeQuat(qw, qx, qy, qz);
      qw = nqw;
      qx = nqx;
      qy = nqy;
      qz = nqz;

      const m = mat3BodyToWorld(qw, qx, qy, qz);
      const gExp = gravBodyExpected(m);

      const am = Math.sqrt(bx * bx + by * by + bz * bz);
      let gmx = bx;
      let gmy = by;
      let gmz = bz;
      if (am > 1e-4) {
        gmx = bx / am;
        gmy = by / am;
        gmz = bz / am;
      }

      const e = cross(gmx, gmy, gmz, gExp.x, gExp.y, gExp.z);
      const wx = wxg + BETA * e.x;
      const wy = wyg + BETA * e.y;
      const wz = wzg + BETA * e.z;

      const [dqw, dqx, dqy, dqz] = quatDerivative(qw, qx, qy, qz, wx, wy, wz);
      qw += dqw * dt;
      qx += dqx * dt;
      qy += dqy * dt;
      qz += dqz * dt;
      const [fqw, fqx, fqy, fqz] = normalizeQuat(qw, qx, qy, qz);
      qwSv.value = fqw;
      qxSv.value = fqx;
      qySv.value = fqy;
      qzSv.value = fqz;

      if (phase === 1) {
        return;
      }

      const m2 = mat3BodyToWorld(fqw, fqx, fqy, fqz);
      const aw = rotateBodyToWorld(m2, bx, by, bz);
      /** Total world‑Z accel (g) — gravity + vertical linear component. */
      const rawZWorld = aw.z;

      /** 1) Slow DC tracker — follows creeping bias / drift only. */
      currentGravityZSv.value =
        ALPHA_SLOW_DC * rawZWorld +
        (1 - ALPHA_SLOW_DC) * currentGravityZSv.value;

      /** 2) High‑pass / DC blocker — drift‑free vertical acceleration. */
      const driftFreeZ = rawZWorld - currentGravityZSv.value;

      if (hasCalib === 1) {
        const { pitchDeg: accelPitchDeg, rollDeg: accelRollDeg } = accelPitchRollDegAbsolute(bx, by, bz);
        const gyroPitchDegS = gy * RAD_TO_DEG;
        const gyroRollDegS = gx * RAD_TO_DEG;
        const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const accelBlend = adaptiveAccelBlend(gyroMag);
        const gyroBlend = 1 - accelBlend;

        const pitchPred = pitchFusDegSv.value + gyroPitchDegS * dt;
        const rollPred = rollFusDegSv.value + gyroRollDegS * dt;

        pitchFusDegSv.value =
          gyroBlend * pitchPred + accelBlend * accelPitchDeg;
        rollFusDegSv.value = gyroBlend * rollPred + accelBlend * accelRollDeg;

        const pitchRel = pitchFusDegSv.value - pitchCalBiasDegSv.value;
        const rollRel = rollFusDegSv.value - rollCalBiasDegSv.value;
        dspPitchDeg.value =
          HUD_ANGLE_EMA * pitchRel + (1 - HUD_ANGLE_EMA) * dspPitchDeg.value;
        dspRollDeg.value = HUD_ANGLE_EMA * rollRel + (1 - HUD_ANGLE_EMA) * dspRollDeg.value;
      } else {
        pitchFusDegSv.value = 0;
        rollFusDegSv.value = 0;
        dspPitchDeg.value = 0;
        dspRollDeg.value = 0;
      }

      const emaOn = phase === 0 || phase === 2;
      if (!emaOn) {
        return;
      }

      /** 3) Deadzone + shock absorber — fast dual EMA on drift‑free Z (existing chart α). */
      const inputZ = displayWorldZG(driftFreeZ);
      const z1 = alpha * inputZ + (1 - alpha) * z1Sv.value;
      const z2 = alpha * z1 + (1 - alpha) * z2Sv.value;
      z1Sv.value = z1;
      z2Sv.value = z2;

      if (phase === 0) {
        peakFifo3Sv.value = peakFifo2Sv.value;
        peakFifo2Sv.value = peakFifo1Sv.value;
        peakFifo1Sv.value = peakFifo0Sv.value;
        peakFifo0Sv.value = driftFreeZ;
        const maZ =
          (peakFifo0Sv.value +
            peakFifo1Sv.value +
            peakFifo2Sv.value +
            peakFifo3Sv.value) /
          PEAK_MA_SAMPLES;

        if (
          Math.abs(maZ) > Math.abs(dspPeakG.value) &&
          Math.abs(maZ) > PEAK_THRESHOLD_G
        ) {
          dspPeakG.value = Math.abs(maZ);
        }

        const chartSample = displayWorldZG(z2);

        if (hasCalib === 1) {
          const rDeg = dspRollDeg.value;
          if (rDeg < 0) {
            const magL = -rDeg;
            if (magL > dspPeakRollLeftDeg.value) {
              dspPeakRollLeftDeg.value = magL;
            }
          } else if (rDeg > 0) {
            if (rDeg > dspPeakRollRightDeg.value) {
              dspPeakRollRightDeg.value = rDeg;
            }
          }
          if (
            Math.abs(chartSample) > dspPeakVertZSv.value &&
            Math.abs(chartSample) > PEAK_THRESHOLD_G
          ) {
            dspPeakVertZSv.value = Math.abs(chartSample);
          }
        }

        const buf = waveData.value;
        const idx = writeIdxSv.value % BUFFER_LEN;
        buf[idx] = chartSample;
        writeIdxSv.value += 1;
        waveData.value = buf;

        hudDisplayZSv.value = chartSample;

        sampleTick.value += 1;
      }
    }
  );

  const pushHud = useCallback((snap: HudSnap) => {
    setHud(snap);
  }, []);

  /** Shared values intentionally captured from enclosing scope — stable refs. */
  /* eslint-disable react-hooks/exhaustive-deps */
  const hudFrameWorklet = useMemo(() => () => {
    'worklet';
    hudFrame.value += 1;
    if (hudFrame.value % 12 !== 0) {
      return;
    }
    const vKmh = speedKmH.value;
    runOnJS(pushHud)({
      pitch: dspPitchDeg.value,
      roll: dspRollDeg.value,
      peak: dspPeakG.value,
      speed: vKmh < SPEED_DISPLAY_ZERO_BELOW_KMH ? 0 : vKmh,
      zG: hudDisplayZSv.value,
      peakRollLeft: dspPeakRollLeftDeg.value,
      peakRollRight: dspPeakRollRightDeg.value,
      peakVertZ: dspPeakVertZSv.value,
    });
  }, [pushHud]);
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
    const p = Skia.Path.Make();
    p.moveTo(0, midY);
    p.lineTo(cw, midY);
    return p;
  });

  const oscilloscopePath = useDerivedValue(() => {
    'worklet';
    const tick = sampleTick.value;
    void tick;
    const cw = chartWsv.value;
    const ch = chartHsv.value;
    const pxPerSample = BUFFER_LEN > 1 ? cw / (BUFFER_LEN - 1) : cw;
    const midY = ch * 0.52;
    const amp = ch * 0.42 * 1.05;
    const buf = waveData.value;
    const wi = writeIdxSv.value;
    const p = Skia.Path.Make();

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
      const v = buf[j];
      const vx = pxPerSample * i;
      if (!Number.isFinite(v)) {
        gap = true;
        continue;
      }
      const vy = midY - v * amp;
      if (!started || gap) {
        p.moveTo(vx, vy);
        started = true;
        gap = false;
      } else {
        p.lineTo(vx, vy);
      }
    }

    return p;
  });

  const clearCalTimers = useCallback(() => {
    if (calTimerRef.current) {
      clearTimeout(calTimerRef.current);
      calTimerRef.current = null;
    }
    if (stabTimerRef.current) {
      clearTimeout(stabTimerRef.current);
      stabTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearCalTimers();
    },
    [clearCalTimers]
  );

  const finishCalibrationWindow = useCallback(() => {
    calibratingSamplingRef.current = false;
    calTimerRef.current = null;

    const { sx, sy, sz, n } = calAccelSumRef.current;
    if (n < 40) {
      dspPhaseSv.value = 0;
      setCalUiBanner(null);
      return;
    }

    const avx = sx / n;
    const avy = sy / n;
    const avz = sz / n;

    const qw = qwSv.value;
    const qx = qxSv.value;
    const qy = qySv.value;
    const qz = qzSv.value;

    const ix = rawAx.value;
    const iy = rawAy.value;
    const iz = rawAz.value;

    runOnUI(
      (
        ax: number,
        ay: number,
        az: number,
        rx: number,
        ry: number,
        rz: number,
        rqw: number,
        rqx: number,
        rqy: number,
        rqz: number
      ) => {
        'worklet';
        const m = mat3BodyToWorld(rqw, rqx, rqy, rqz);
        offsetZSv.value = 0;
        qCalW.value = rqw;
        qCalX.value = rqx;
        qCalY.value = rqy;
        qCalZ.value = rqz;
        const awInst = rotateBodyToWorld(m, rx, ry, rz);
        /** Snap dynamic gravity estimate — instant zero error on vertical axis. */
        currentGravityZSv.value = awInst.z;
        const lzSync = displayWorldZG(awInst.z - currentGravityZSv.value);
        z1Sv.value = lzSync;
        z2Sv.value = lzSync;
        hudDisplayZSv.value = lzSync;
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
        const { pitchDeg: pCal, rollDeg: rCal } = accelPitchRollDegAbsolute(avx, avy, avz);
        pitchCalBiasDegSv.value = pCal;
        rollCalBiasDegSv.value = rCal;
        pitchFusDegSv.value = pCal;
        rollFusDegSv.value = rCal;
        const buf = waveData.value;
        buf.fill(0);
        waveData.value = buf;
        writeIdxSv.value = 0;
        sampleTick.value = 0;
        hasCalibSv.value = 1;
        dspPhaseSv.value = 2;
      }
    )(avx, avy, avz, ix, iy, iz, qw, qx, qy, qz);

    setCalUiBanner('STABILIZING…');
    stabTimerRef.current = setTimeout(() => {
      runOnUI(() => {
        'worklet';
        dspPhaseSv.value = 0;
      })();
      stabTimerRef.current = null;
      setCalUiBanner(null);
    }, STABILIZE_MS);
  },
  // Shared values are read when the timer fires; empty deps keep a stable timer target.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []
);

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

  const snapDynamicGravityBaseline = useCallback(() => {
    runOnUI(() => {
      'worklet';
      const bx = rawAx.value;
      const by = rawAy.value;
      const bz = rawAz.value;
      const qw = qwSv.value;
      const qx = qxSv.value;
      const qy = qySv.value;
      const qz = qzSv.value;
      const m2 = mat3BodyToWorld(qw, qx, qy, qz);
      const aw = rotateBodyToWorld(m2, bx, by, bz);
      offsetZSv.value = 0;
      currentGravityZSv.value = aw.z;
      const sync = displayWorldZG(aw.z - currentGravityZSv.value);
      z1Sv.value = sync;
      z2Sv.value = sync;
      hudDisplayZSv.value = sync;
    })();
  }, [
    rawAx,
    rawAy,
    rawAz,
    qwSv,
    qxSv,
    qySv,
    qzSv,
    offsetZSv,
    currentGravityZSv,
    z1Sv,
    z2Sv,
    hudDisplayZSv,
  ]);

  const startCalibration = useCallback(
    () => {
      if (calUiBanner !== null) {
        return;
      }
      clearCalTimers();
      calAccelSumRef.current = { sx: 0, sy: 0, sz: 0, n: 0 };
      calibratingSamplingRef.current = true;
      dspPhaseSv.value = 1;
      snapDynamicGravityBaseline();
      setCalUiBanner('HOLD STILL — CAL 5s');
      calTimerRef.current = setTimeout(finishCalibrationWindow, CAL_DURATION_MS);
    },
    [calUiBanner, clearCalTimers, dspPhaseSv, finishCalibrationWindow, snapDynamicGravityBaseline]
  );

  const panStartRel = useSharedValue(0);
  const trackW = Math.min(320, Math.max(winW - 48, 140));

  const panAdvancedEnabled = advancedSettingsOpen && !dashLocked;

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(panAdvancedEnabled)
        .onBegin(() => {
          'worklet';
          panStartRel.value = slider01.value * trackW;
        })
        .onUpdate((evt) => {
          'worklet';
          let nx = panStartRel.value + evt.translationX;
          if (nx < 0) nx = 0;
          if (nx > trackW) nx = trackW;
          slider01.value = nx / trackW;
        }),
    [panAdvancedEnabled, panStartRel, slider01, trackW]
  );

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: slider01.value * (trackW - 28) }],
  }));

  return (
    <View style={styles.root}>
      <View style={styles.chartWrap} onLayout={onChartLayout}>
        <Canvas style={styles.canvas}>
          <Fill color="#010101" />
          <Path style="stroke" path={gridPath} color="#242424" strokeWidth={1} strokeCap="square" />
          <Path style="stroke" path={baselinePath} color="#173d2f" strokeWidth={1} strokeCap="round" />
          <Path
            style="stroke"
            path={oscilloscopePath}
            color="#34ff94"
            strokeWidth={2.25}
            strokeJoin="round"
            strokeCap="round"
          />
        </Canvas>

        {calUiBanner ? (
          <View style={styles.calBanner} pointerEvents="none">
            <Text style={[styles.calBannerText, { fontFamily: mono }]}>{calUiBanner}</Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.bottomPanel, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={styles.hudTopBar}>
          <View style={styles.logoCluster}>
            <Text style={[styles.logo, { fontFamily: mono }]}>LAUDA</Text>
            <Text style={[styles.logoSub, { fontFamily: mono }]}>OSC TRACE</Text>
          </View>
          <View style={styles.dashboardTools}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={dashLocked ? 'Unlock dashboard controls' : 'Lock dashboard controls'}
              onPress={() => setDashLocked((v) => !v)}
              style={({ pressed }) => [styles.toolBtn, pressed && styles.toolBtnPressed]}
            >
              <Ionicons
                name={dashLocked ? 'lock-closed' : 'lock-open-outline'}
                size={22}
                color={dashLocked ? '#5cff9b' : '#6b7a72'}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle advanced filter settings"
              disabled={dashLocked}
              onPress={() => !dashLocked && setAdvancedSettingsOpen((v) => !v)}
              style={({ pressed }) => [
                styles.toolBtn,
                dashLocked && styles.toolBtnDisabled,
                pressed && styles.toolBtnPressed,
              ]}
            >
              <Ionicons
                name="settings-outline"
                size={22}
                color={dashLocked ? '#3a453f' : '#6b7a72'}
              />
            </Pressable>
          </View>
        </View>

        <View style={styles.hudMetricsPanel}>
          <View style={styles.hudSection}>
            <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Motion</Text>
            <View style={styles.hudMetricRow}>
              <HudMetricTile label="SPD" value={hud.speed.toFixed(1)} suffix="km/h" mono={mono} />
              <HudMetricTile
                label="Pitch"
                value={`${hud.pitch >= 0 ? '+' : ''}${hud.pitch.toFixed(1)}`}
                suffix="°"
                mono={mono}
              />
              <HudMetricTile
                label="Roll"
                value={`${hud.roll >= 0 ? '+' : ''}${hud.roll.toFixed(1)}`}
                suffix="°"
                mono={mono}
              />
            </View>
          </View>

          <View style={styles.hudSection}>
            <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Acceleration</Text>
            <View style={styles.hudMetricRow}>
              <HudMetricTile label="Peak G" value={hud.peak.toFixed(2)} suffix="g" alert mono={mono} />
              <HudMetricTile label="Vert Z" value={hud.zG.toFixed(2)} suffix="g" muted mono={mono} />
            </View>
          </View>

          <View style={styles.hudSection}>
            <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Peak · max</Text>
            <View style={styles.hudMetricRow}>
              <HudMetricTile label="Roll left" value={hud.peakRollLeft.toFixed(1)} suffix="°" mono={mono} />
              <HudMetricTile label="Roll right" value={hud.peakRollRight.toFixed(1)} suffix="°" mono={mono} />
              <HudMetricTile label="Peak Vert Z" value={hud.peakVertZ.toFixed(2)} suffix="g" mono={mono} />
            </View>
          </View>
        </View>

        {advancedSettingsOpen && !dashLocked ? (
          <View style={styles.advancedPanel}>
            <Text style={[styles.advancedTitle, { fontFamily: mono }]}>
              ADVANCED · CHART α 0.12–0.15
            </Text>
            <View style={styles.sensRow}>
              <Text style={[styles.sensLabel, { fontFamily: mono }]}>CHART α</Text>
              <GestureDetector gesture={pan}>
                <View style={[styles.track, { width: trackW }]}>
                  <View style={styles.trackFill} />
                  <Animated.View style={[styles.thumb, knobStyle]} />
                </View>
              </GestureDetector>
            </View>
          </View>
        ) : null}

        <View style={styles.calRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset peak G and angle maximums to zero"
            disabled={dashLocked || calUiBanner !== null}
            onPress={resetPeakMax}
            style={({ pressed }) => [
              styles.resetMaxBtn,
              (dashLocked || calUiBanner !== null) && styles.resetMaxBtnDisabled,
              pressed && styles.resetMaxBtnPressed,
            ]}
          >
            <Text style={[styles.resetMaxLabel, { fontFamily: mono }]}>RESET MAX</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Five second calibration: keep device still on a level surface. Long press to open filter settings."
            disabled={calUiBanner !== null}
            onPress={startCalibration}
            onLongPress={() => {
              if (!dashLocked) {
                setAdvancedSettingsOpen(true);
              }
            }}
            delayLongPress={450}
            style={({ pressed }) => [
              styles.calBtn,
              calUiBanner !== null && styles.calBtnDisabled,
              pressed && styles.calBtnPressed,
            ]}
          >
            <View pointerEvents="none" style={styles.calGlow} />
            <Text style={[styles.calLabel, { fontFamily: mono }]}>CAL</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function HudMetricTile({
  label,
  value,
  suffix,
  alert,
  muted,
  mono,
}: {
  label: string;
  value: string;
  suffix: string;
  alert?: boolean;
  muted?: boolean;
  mono: string;
}) {
  const valColor = alert ? '#ff6b82' : muted ? '#87b89a' : '#c4f5dc';
  return (
    <View style={styles.metricTile}>
      <Text style={[styles.metricTileLabel, { fontFamily: mono }]} numberOfLines={2}>
        {label}
      </Text>
      <Text style={[styles.metricTileVal, { fontFamily: mono, color: valColor }]}>
        {value}
        {suffix ? (
          <Text style={[styles.metricTileSuf, { fontFamily: mono }]}> {suffix}</Text>
        ) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: '#000',
  },
  chartWrap: {
    flex: 1,
    minHeight: 200,
    position: 'relative',
  },
  canvas: {
    flex: 1,
    backgroundColor: '#000',
  },
  bottomPanel: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#243028',
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 14,
    backgroundColor: '#000',
  },
  hudTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  hudMetricsPanel: {
    gap: 14,
  },
  hudSection: {
    gap: 10,
  },
  hudSectionLabel: {
    color: '#5a7d68',
    fontSize: 10,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    opacity: 0.92,
  },
  hudMetricRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
  },
  metricTile: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 74,
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 11,
    backgroundColor: '#060a08',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1c2f24',
    // subtle lift
    shadowColor: '#102218',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
    elevation: 3,
  },
  metricTileLabel: {
    fontSize: 9,
    letterSpacing: 0.8,
    color: '#6d8c7a',
    marginBottom: 6,
    lineHeight: 12,
  },
  metricTileVal: {
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.2,
  },
  metricTileSuf: {
    fontSize: 12,
    fontWeight: '500',
    color: '#5f7d6c',
    opacity: 0.85,
  },
  dashboardTools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  toolBtn: {
    padding: 6,
    borderRadius: 6,
  },
  toolBtnPressed: {
    opacity: 0.75,
  },
  toolBtnDisabled: {
    opacity: 0.35,
  },
  advancedPanel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2a3330',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: '#050805',
  },
  advancedTitle: {
    color: '#5e6d66',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  logoCluster: {
    justifyContent: 'flex-start',
  },
  calRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 12,
  },
  resetMaxBtn: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3a5548',
    backgroundColor: '#0a1410',
  },
  resetMaxBtnDisabled: {
    opacity: 0.35,
  },
  resetMaxBtnPressed: {
    opacity: 0.88,
  },
  resetMaxLabel: {
    color: '#8a9e94',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
  },
  logo: {
    color: '#5cff9b',
    fontSize: 15,
    letterSpacing: 2,
    fontWeight: '700',
    marginBottom: -2,
  },
  logoSub: {
    color: '#5a6b63',
    fontSize: 8,
    letterSpacing: 1.4,
    marginBottom: 2,
  },
  calBtn: {
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 8,
    backgroundColor: '#071a10',
    borderWidth: 1,
    borderColor: '#2cff8a',
    overflow: 'visible',
  },
  calBtnDisabled: {
    opacity: 0.35,
  },
  calBanner: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
    zIndex: 4,
  },
  calBannerText: {
    color: '#9effc5',
    fontSize: 13,
    letterSpacing: 1,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  calBtnPressed: {
    opacity: 0.88,
  },
  calGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    shadowColor: '#2cff8a',
    shadowOpacity: 0.85,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  calLabel: {
    color: '#6cffb0',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 2,
  },
  sensRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 4,
  },
  sensLabel: {
    color: '#6b7a72',
    fontSize: 11,
    letterSpacing: 1,
    width: 72,
  },
  track: {
    height: 30,
    justifyContent: 'center',
  },
  trackFill: {
    height: 5,
    borderRadius: 3,
    backgroundColor: '#1a1e1c',
    borderWidth: 1,
    borderColor: '#2a3330',
  },
  thumb: {
    position: 'absolute',
    width: 28,
    height: 20,
    borderRadius: 4,
    top: 5,
    left: 0,
    backgroundColor: '#2cff8a',
    borderWidth: 1,
    borderColor: '#9effc8',
    shadowColor: '#2cff8a',
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
});
