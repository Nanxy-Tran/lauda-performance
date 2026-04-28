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

/** Slider 0–1 maps to pole α ∈ [0.15, 0.20] (two cascaded one‑poles; responsive, still filters engine buzz). */
function sliderToAlpha(slider01: number) {
  'worklet';
  const s = Math.min(Math.max(slider01, 0), 1);
  return 0.15 + s * 0.05;
}

/** Complementary filter: angle = Kg*(angle + ω*dt) + Ka*accel_angle (anchors to gravity when stationary). */
const COMP_K_GYRO = 0.98;
const COMP_K_ACC = 0.02;

/** Above this speed (km/h) we do not apply stationary table lock. */
const SPEED_TABLE_LOCK_ABOVE_KMH = 1.0;
/** Stationary if |ω| < this (rad/s). */
const GYRO_STATIONARY_RAD_S = 0.055;

/** dt clamps: integration stability + avoid duplicate timestamps. */
const DT_MIN_S = 1 / 800;
const DT_MAX_S = 0.12;

/** World-Z dead zone after calibration (g). */
const Z_CLAMP_G = 0.02;

/** Speed below this (km/h) displays as zero. */
const SPEED_DISPLAY_ZERO_BELOW_KMH = 5;

/** q ⊗ r — norm inlined so this worklet has no unresolved sibling calls under RN Worklets bundling. */
function quatMultiplyTuple(
  aw: number,
  ax: number,
  ay: number,
  az: number,
  bw: number,
  bx: number,
  by: number,
  bz: number
): [number, number, number, number] {
  'worklet';
  let rw = aw * bw - ax * bx - ay * by - az * bz;
  let rx = aw * bx + ax * bw + ay * bz - az * by;
  let ry = aw * by - ax * bz + ay * bw + az * bx;
  let rz = aw * bz + ax * by - ay * bx + az * bw;
  let lenSq = rw * rw + rx * rx + ry * ry + rz * rz;
  if (lenSq < 1e-24) {
    return [1, 0, 0, 0];
  }
  const inv = 1 / Math.sqrt(lenSq);
  rw *= inv;
  rx *= inv;
  ry *= inv;
  rz *= inv;
  return [rw, rx, ry, rz];
}

/** q_rel = q_cal⁻¹ ⊗ q — attitude relative to calibration snapshot (level reference). */
function relativeQuat(
  qcw: number,
  qcx: number,
  qcy: number,
  qcz: number,
  qw: number,
  qx: number,
  qy: number,
  qz: number
): [number, number, number, number] {
  'worklet';
  const icw = qcw;
  const icx = -qcx;
  const icy = -qcy;
  const icz = -qcz;
  return quatMultiplyTuple(icw, icx, icy, icz, qw, qx, qy, qz);
}

/** Roll / pitch from world +Z direction in bike body (relative quaternion). Y = longitudinal, Z = vertical. */
function rollPitchDegFromRelQuat(qw: number, qx: number, qy: number, qz: number) {
  'worklet';
  const m = mat3BodyToWorld(qw, qx, qy, qz);
  const gbx = m.m02;
  const gby = m.m12;
  const gbz = m.m22;
  const rollRad = Math.atan2(gbx, gbz);
  const pitchRad = Math.atan2(-gby, Math.sqrt(gbx * gbx + gbz * gbz));
  return {
    rollDeg: (rollRad * 180) / Math.PI,
    pitchDeg: (pitchRad * 180) / Math.PI,
  };
}

/** Minimal quaternion rotating body +Z so it aligns with unit vector v (accel-only tilt). */
function quatAlignZToV(vx: number, vy: number, vz: number): [number, number, number, number] {
  'worklet';
  const dot = vz;
  const cx = -vy;
  const cy = vx;
  const cz = 0;
  const cLenSq = cx * cx + cy * cy;
  if (cLenSq < 1e-12) {
    if (dot > 0) {
      return [1, 0, 0, 0];
    }
    return [0, 1, 0, 0];
  }
  const cLen = Math.sqrt(cLenSq);
  const ax = cx / cLen;
  const ay = cy / cLen;
  const az = cz / cLen;
  let ang = Math.atan2(cLen, dot);
  if (ang > Math.PI * 0.5) {
    ang -= Math.PI;
  }
  const half = ang * 0.5;
  const sh = Math.sin(half);
  return [Math.cos(half), ax * sh, ay * sh, az * sh];
}

/** Roll φ′ · pitch θ′ (rad/s) from body-frame gyro matching rollPitchDegFromRelQuat convention. */
function eulerRatesRollPitchRad(phi: number, theta: number, gx: number, gy: number, gz: number) {
  'worklet';
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const cosTAbs = Math.abs(cosT);
  const tanT = cosTAbs > 1e-3 ? sinT / (cosTAbs > 1e-2 ? cosT : 1e-2 * Math.sign(cosT || 1)) : sinT;
  const rollDot = gx + gy * sinP * tanT + gz * cosP * tanT;
  const pitchDot = gy * cosP - gz * sinP;
  return { rollDot, pitchDot };
}

/** Gravity direction correction (accel vs expected) fused into gyro. */
const BETA = 0.04;

/** Soft peak decay so readout settles without instantaneous collapse. */
const PEAK_HOLD_DECAY = 0.997;

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
};

export default function OscilloscopeView() {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

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

  const z1Sv = useSharedValue(0);
  const z2Sv = useSharedValue(0);

  /** World-Z bias captured from stationary average: Final_Z = (R·a).z − offsetZSv */
  const offsetZSv = useSharedValue(1);

  /** Attitude snapshot at calibration end for relative pitch / roll HUD. */
  const qCalW = useSharedValue(1);
  const qCalX = useSharedValue(0);
  const qCalY = useSharedValue(0);
  const qCalZ = useSharedValue(0);

  /** 0 = acquire · plot + EMA, 1 = 5 s cal (no plot / no EMA), 2 = 1 s stabilize (EMA on, plot off). */
  const dspPhaseSv = useSharedValue(0);
  /** After first CAL, relative angles are trustworthy. */
  const hasCalibSv = useSharedValue(0);

  const slider01 = useSharedValue(0.5);

  const writeIdxSv = useSharedValue(0);
  const waveData = useSharedValue(new Float32Array(BUFFER_LEN));
  const sampleTick = useSharedValue(0);

  /** Complementary filter state (rad), relative to cal — anchored by gravity accel term. */
  const pitchFusRadSv = useSharedValue(0);
  const rollFusRadSv = useSharedValue(0);

  const dspPitchDeg = useSharedValue(0);
  const dspRollDeg = useSharedValue(0);
  const dspPeakG = useSharedValue(0);

  const speedKmH = useSharedValue(0);

  const [hud, setHud] = useState<HudSnap>({ pitch: 0, roll: 0, peak: 0, speed: 0 });
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
      offsetZSv.value,
      dspPhaseSv.value,
      qCalW.value,
      qCalX.value,
      qCalY.value,
      qCalZ.value,
      hasCalibSv.value,
      speedKmH.value,
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
      const offsetZ = vals[8] as number;
      const phase = vals[9] as number;
      const qcW = vals[10] as number;
      const qcX = vals[11] as number;
      const qcY = vals[12] as number;
      const qcZ = vals[13] as number;
      const hasCalib = vals[14] as number;
      const spdKmh = vals[15] as number;

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
      const lx = aw.x;
      const ly = aw.y;
      let lz = aw.z - offsetZ;
      if (Math.abs(lz) < Z_CLAMP_G) {
        lz = 0;
      }

      if (hasCalib === 1) {
        const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const tableStill =
          spdKmh < SPEED_TABLE_LOCK_ABOVE_KMH && gyroMag < GYRO_STATIONARY_RAD_S;

        if (tableStill) {
          pitchFusRadSv.value = 0;
          rollFusRadSv.value = 0;
          dspPitchDeg.value = 0;
          dspRollDeg.value = 0;
        } else if (am > 0.15) {
          const [qaW, qaX, qaY, qaZ] = normalizeQuat(...quatAlignZToV(gmx, gmy, gmz));
          const [rqAw, rqAx, rqAy, rqAz] = relativeQuat(qcW, qcX, qcY, qcZ, qaW, qaX, qaY, qaZ);
          const rpAcc = rollPitchDegFromRelQuat(rqAw, rqAx, rqAy, rqAz);
          const pitchAccRad = (rpAcc.pitchDeg * Math.PI) / 180;
          const rollAccRad = (rpAcc.rollDeg * Math.PI) / 180;

          const pr = pitchFusRadSv.value;
          const rr = rollFusRadSv.value;
          const { rollDot, pitchDot } = eulerRatesRollPitchRad(rr, pr, gx, gy, gz);
          const pitchPred = pr + pitchDot * dt;
          const rollPred = rr + rollDot * dt;
          pitchFusRadSv.value = COMP_K_GYRO * pitchPred + COMP_K_ACC * pitchAccRad;
          rollFusRadSv.value = COMP_K_GYRO * rollPred + COMP_K_ACC * rollAccRad;
          dspPitchDeg.value = (pitchFusRadSv.value * 180) / Math.PI;
          dspRollDeg.value = (rollFusRadSv.value * 180) / Math.PI;
        } else {
          const pr = pitchFusRadSv.value;
          const rr = rollFusRadSv.value;
          const { rollDot, pitchDot } = eulerRatesRollPitchRad(rr, pr, gx, gy, gz);
          pitchFusRadSv.value = pr + pitchDot * dt;
          rollFusRadSv.value = rr + rollDot * dt;
          dspPitchDeg.value = (pitchFusRadSv.value * 180) / Math.PI;
          dspRollDeg.value = (rollFusRadSv.value * 180) / Math.PI;
        }
      } else {
        pitchFusRadSv.value = 0;
        rollFusRadSv.value = 0;
        dspPitchDeg.value = 0;
        dspRollDeg.value = 0;
      }

      const linMag = Math.sqrt(lx * lx + ly * ly + lz * lz);
      let nextPeak = dspPeakG.value * PEAK_HOLD_DECAY;
      if (linMag > nextPeak) {
        nextPeak = linMag;
      }
      dspPeakG.value = nextPeak;

      const emaOn = phase === 0 || phase === 2;
      if (!emaOn) {
        return;
      }

      const inputZ = lz;
      const z1 = alpha * inputZ + (1 - alpha) * z1Sv.value;
      const z2 = alpha * z1 + (1 - alpha) * z2Sv.value;
      z1Sv.value = z1;
      z2Sv.value = z2;

      if (phase === 0) {
        const display = z2;
        const buf = waveData.value;
        const idx = writeIdxSv.value % BUFFER_LEN;
        buf[idx] = display;
        writeIdxSv.value += 1;
        waveData.value = buf;

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
        const aw = rotateBodyToWorld(m, ax, ay, az);
        offsetZSv.value = aw.z;
        qCalW.value = rqw;
        qCalX.value = rqx;
        qCalY.value = rqy;
        qCalZ.value = rqz;
        /** EMA sync: seed both stages to current linear-Z from instant sample (eliminates post-CAL ramp). */
        const awInst = rotateBodyToWorld(m, rx, ry, rz);
        let lzSync = awInst.z - offsetZSv.value;
        if (Math.abs(lzSync) < Z_CLAMP_G) {
          lzSync = 0;
        }
        z1Sv.value = lzSync;
        z2Sv.value = lzSync;
        pitchFusRadSv.value = 0;
        rollFusRadSv.value = 0;
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

  const startCalibration = useCallback(
    () => {
      if (calUiBanner !== null) {
        return;
      }
      clearCalTimers();
      calAccelSumRef.current = { sx: 0, sy: 0, sz: 0, n: 0 };
      calibratingSamplingRef.current = true;
      dspPhaseSv.value = 1;
      setCalUiBanner('HOLD STILL — CAL 5s');
      calTimerRef.current = setTimeout(finishCalibrationWindow, CAL_DURATION_MS);
    },
    [calUiBanner, clearCalTimers, dspPhaseSv, finishCalibrationWindow]
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
            <Text style={[styles.calBannerText, { fontFamily: MONO as string }]}>{calUiBanner}</Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.bottomPanel, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <View style={styles.hudHeaderRow}>
          <View style={styles.logoCluster}>
            <Text style={[styles.logo, { fontFamily: MONO as string }]}>LAUDA</Text>
            <Text style={[styles.logoSub, { fontFamily: MONO as string }]}>OSC TRACE</Text>
          </View>
          <View style={styles.metricsWrap}>
            <HudLine label="SPD" value={`${hud.speed.toFixed(1)}`} suffix="km/h" muted={false} compact />
            <HudLine
              label="PITCH"
              value={`${hud.pitch >= 0 ? '+' : ''}${hud.pitch.toFixed(1)}`}
              suffix="deg"
              muted={false}
              compact
            />
            <HudLine
              label="ROLL"
              value={`${hud.roll >= 0 ? '+' : ''}${hud.roll.toFixed(1)}`}
              suffix="deg"
              muted={false}
              compact
            />
            <HudLine label="PEAK-G" value={hud.peak.toFixed(2)} suffix="" alert compact />
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

        {advancedSettingsOpen && !dashLocked ? (
          <View style={styles.advancedPanel}>
            <Text style={[styles.advancedTitle, { fontFamily: MONO as string }]}>ADVANCED · FILTER α</Text>
            <View style={styles.sensRow}>
              <Text style={[styles.sensLabel, { fontFamily: MONO as string }]}>FILTER α</Text>
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
            <Text style={[styles.calLabel, { fontFamily: MONO as string }]}>CAL</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function HudLine({
  label,
  value,
  suffix,
  muted,
  alert,
  compact,
}: {
  label: string;
  value: string;
  suffix: string;
  muted?: boolean;
  alert?: boolean;
  compact?: boolean;
}) {
  return (
    <View style={[styles.hudBlock, compact && styles.hudBlockCompact]}>
      <Text
        style={[
          styles.hudLab,
          compact && styles.hudLabCompact,
          { fontFamily: MONO as string, opacity: muted ? 0.45 : 0.75 },
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          styles.hudVal,
          compact && styles.hudValCompact,
          { fontFamily: MONO as string, color: alert ? '#ff5570' : '#c8ffd8' },
        ]}
      >
        {value}
        {suffix ? (
          <Text style={[styles.hudSuf, compact && styles.hudSufCompact, { fontFamily: MONO as string }]}>
            {' '}
            {suffix}
          </Text>
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
    borderTopColor: '#2a2a2a',
    paddingHorizontal: 14,
    paddingTop: 10,
    gap: 10,
    backgroundColor: '#000',
  },
  hudHeaderRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 10,
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
  metricsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
    flex: 1,
  },
  calRow: {
    alignItems: 'flex-end',
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
  hudBlock: {
    marginBottom: 4,
  },
  hudBlockCompact: {
    marginBottom: 0,
    minWidth: 68,
    marginLeft: 4,
    marginRight: 4,
  },
  hudLab: {
    color: '#7a8a82',
    fontSize: 10,
    letterSpacing: 1,
  },
  hudLabCompact: {
    fontSize: 9,
  },
  hudVal: {
    fontSize: 19,
    fontVariant: ['tabular-nums'],
  },
  hudValCompact: {
    fontSize: 16,
  },
  hudSuf: {
    fontSize: 11,
    color: '#5e6d66',
  },
  hudSufCompact: {
    fontSize: 9,
  },
  calBtn: {
    paddingHorizontal: 22,
    paddingVertical: 12,
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
    fontSize: 14,
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
