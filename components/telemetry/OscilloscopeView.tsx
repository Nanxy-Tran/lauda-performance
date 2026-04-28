import {
  Accelerometer,
  Gyroscope,
} from 'expo-sensors';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
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

const G_WORLD_Z = 1;
const BUFFER_LEN = 360;

/** Gravity direction correction (accel vs expected) fused into gyro. */
const BETA = 0.04;

/** Soft peak decay so readout settles without instantaneous collapse. */
const PEAK_HOLD_DECAY = 0.997;

const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

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

/** Slider 0–1 maps to pole α · two identical cascaded one‑poles ⇒ sharp roll‑off above ~ tens of Hz. */
function sliderToAlpha(slider01: number) {
  'worklet';
  return 0.02 + Math.min(Math.max(slider01, 0), 1) * 0.42;
}

type HudSnap = {
  pitch: number;
  peak: number;
  speed: number;
};

export default function OscilloscopeView() {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const SIDEBAR = 118;

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

  const calibZ = useSharedValue(0);
  const slider01 = useSharedValue(0.35);

  const writeIdxSv = useSharedValue(0);
  const waveData = useSharedValue(new Float32Array(BUFFER_LEN));
  const sampleTick = useSharedValue(0);

  const dspPitchDeg = useSharedValue(0);
  const dspPeakG = useSharedValue(0);

  const chartWsv = useSharedValue(Math.max(winW - SIDEBAR, 120));
  const chartHsv = useSharedValue(winH);

  const speedKmH = useSharedValue(0);

  const [hud, setHud] = useState<HudSnap>({ pitch: 0, peak: 0, speed: 0 });

  const hudFrame = useSharedValue(0);

  useLayoutEffect(() => {
    chartWsv.value = Math.max(winW - SIDEBAR, 120);
    chartHsv.value = Math.max(winH - insets.top - insets.bottom - 112, 120);
  }, [SIDEBAR, winW, winH, insets.top, insets.bottom, chartWsv, chartHsv]);

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
      calibZ.value,
    ],
    (
      vals
    ) => {
      'worklet';
      const ax = vals[0] as number;
      const ay = vals[1] as number;
      const az = vals[2] as number;
      const gx = vals[3] as number;
      const gy = vals[4] as number;
      const gz = vals[5] as number;
      const ts = vals[6] as number;
      const slid = vals[7] as number;
      const cz = vals[8] as number;

      let dt =
        ts > 0 && lastTsSv.value > 0 ? ts - lastTsSv.value : 1 / 120;

      lastTsSv.value = ts > 0 ? ts : lastTsSv.value;
      if (dt <= 0 || dt > 0.25) {
        dt = 1 / 120;
      }

      const alpha = sliderToAlpha(slid);

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

      const am = Math.sqrt(ax * ax + ay * ay + az * az);
      let gmx = ax;
      let gmy = ay;
      let gmz = az;
      if (am > 1e-4) {
        gmx = ax / am;
        gmy = ay / am;
        gmz = az / am;
      }

      const e = cross(gmx, gmy, gmz, gExp.x, gExp.y, gExp.z);
      const wx = gx + BETA * e.x;
      const wy = gy + BETA * e.y;
      const wz = gz + BETA * e.z;

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

      const m2 = mat3BodyToWorld(fqw, fqx, fqy, fqz);
      const aw = rotateBodyToWorld(m2, ax, ay, az);
      const lx = aw.x;
      const ly = aw.y;
      const lz = aw.z - G_WORLD_Z;

      const sinp = 2 * (fqw * fqy - fqz * fqx);
      const pitchRad = Math.asin(Math.min(1, Math.max(-1, sinp)));
      dspPitchDeg.value = (pitchRad * 180) / Math.PI;

      const linMag = Math.sqrt(lx * lx + ly * ly + lz * lz);
      let nextPeak = dspPeakG.value * PEAK_HOLD_DECAY;
      if (linMag > nextPeak) {
        nextPeak = linMag;
      }
      dspPeakG.value = nextPeak;

      const inputZ = lz;
      const z1 = alpha * inputZ + (1 - alpha) * z1Sv.value;
      const z2 = alpha * z1 + (1 - alpha) * z2Sv.value;
      z1Sv.value = z1;
      z2Sv.value = z2;

      const display = z2 - cz;

      const buf = waveData.value;
      const idx = writeIdxSv.value % BUFFER_LEN;
      buf[idx] = display;
      writeIdxSv.value += 1;
      waveData.value = buf;

      sampleTick.value += 1;
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
    runOnJS(pushHud)({
      pitch: dspPitchDeg.value,
      peak: dspPeakG.value,
      speed: speedKmH.value,
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

  const handleCalibrate = useCallback(() => {
    runOnUI(() => {
      'worklet';
      calibZ.value = z2Sv.value;
    })();
  }, [calibZ, z2Sv]);

  const panStartRel = useSharedValue(0);
  const chartColumnW = Math.max(winW - SIDEBAR, 160);
  const trackW = Math.min(300, chartColumnW - 48);

  const pan = Gesture.Pan()
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
    });

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: slider01.value * (trackW - 28) }],
  }));

  return (
    <View style={styles.root}>
      <View style={[styles.sidebar, { paddingTop: Math.max(insets.top, 8), width: SIDEBAR }]}>
        <Text style={[styles.logo, { fontFamily: MONO as string }]}>LAUDA</Text>
        <Text style={[styles.logoSub, { fontFamily: MONO as string }]}>OSC TRACE</Text>
        <HudLine label="SPD" value={`${hud.speed.toFixed(1)}`} suffix="km/h" muted={false} />
        <HudLine
          label="PITCH"
          value={`${hud.pitch >= 0 ? '+' : ''}${hud.pitch.toFixed(1)}`}
          suffix="deg"
          muted={false}
        />
        <HudLine label="PEAK-G" value={hud.peak.toFixed(2)} suffix="" alert />
      </View>

      <View style={[styles.flexCol]}>
        <View style={[styles.chartWrap]} onLayout={onChartLayout}>
          <Canvas style={styles.canvas}>
            <Fill color="#010101" />
            <Path
              style="stroke"
              path={gridPath}
              color="#242424"
              strokeWidth={1}
              strokeCap="square"
            />
            <Path
              style="stroke"
              path={baselinePath}
              color="#173d2f"
              strokeWidth={1}
              strokeCap="round"
            />
            <Path
              style="stroke"
              path={oscilloscopePath}
              color="#34ff94"
              strokeWidth={2.25}
              strokeJoin="round"
              strokeCap="round"
            />
          </Canvas>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Calibrate vertical trace"
            onPress={handleCalibrate}
            style={({ pressed }) => [
              styles.calBtn,
              { bottom: insets.bottom + 88, right: 16 },
              pressed && styles.calBtnPressed,
            ]}
          >
            <View pointerEvents="none" style={styles.calGlow} />
            <Text style={[styles.calLabel, { fontFamily: MONO as string }]}>CAL</Text>
          </Pressable>
        </View>

        <View style={[styles.sensRow, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Text style={[styles.sensLabel, { fontFamily: MONO as string }]}>FILTER α</Text>
          <GestureDetector gesture={pan}>
            <View style={[styles.track, { width: trackW }]}>
              <View style={styles.trackFill} />
              <Animated.View style={[styles.thumb, knobStyle]} />
            </View>
          </GestureDetector>
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
}: {
  label: string;
  value: string;
  suffix: string;
  muted?: boolean;
  alert?: boolean;
}) {
  return (
    <View style={styles.hudBlock}>
      <Text style={[styles.hudLab, { fontFamily: MONO as string, opacity: muted ? 0.45 : 0.75 }]}>
        {label}
      </Text>
      <Text
        style={[
          styles.hudVal,
          { fontFamily: MONO as string, color: alert ? '#ff5570' : '#c8ffd8' },
        ]}
      >
        {value}
        {suffix ? (
          <Text style={[styles.hudSuf, { fontFamily: MONO as string }]}> {suffix}</Text>
        ) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#000',
  },
  flexCol: { flex: 1 },
  sidebar: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: '#2a2a2a',
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 10,
    justifyContent: 'flex-start',
  },
  logo: {
    color: '#5cff9b',
    fontSize: 16,
    letterSpacing: 2,
    fontWeight: '700',
    marginBottom: -2,
  },
  logoSub: {
    color: '#5a6b63',
    fontSize: 9,
    letterSpacing: 1.4,
    marginBottom: 10,
  },
  hudBlock: {
    marginBottom: 4,
  },
  hudLab: {
    color: '#7a8a82',
    fontSize: 10,
    letterSpacing: 1,
  },
  hudVal: {
    fontSize: 19,
    fontVariant: ['tabular-nums'],
  },
  hudSuf: {
    fontSize: 11,
    color: '#5e6d66',
  },
  chartWrap: {
    flex: 1,
    position: 'relative',
  },
  canvas: {
    flex: 1,
    backgroundColor: '#000',
  },
  calBtn: {
    position: 'absolute',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#071a10',
    borderWidth: 1,
    borderColor: '#2cff8a',
    overflow: 'visible',
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
    paddingHorizontal: 16,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1c1c1c',
    backgroundColor: '#000',
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
