import { Accelerometer } from 'expo-sensors';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
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

import {
  type SuspensionBumpDiagResult,
  type SuspensionSurfaceStatus,
  useSuspensionBumpFsm,
} from './useSuspensionBumpFsm';

const BUFFER_LEN = 360;

/**
 * Vertical linear acceleration uses a STATIC gravity unit vector captured at CAL (dot product).
 * expo-sensors accelerometer (g): X lateral (right in portrait), Y longitudinal, Z toward screen normal.
 */

/** HUD pitch/roll EMA — accel-only tilt; higher = snappier (then quantized for display). */
const HUD_ANGLE_EMA = 0.12;

/** Snap pitch/roll HUD to 0.5° steps so the readout does not flicker on engine vibration. */
function hudTiltDisplayDeg(deg: number): number {
  'worklet';
  return Math.round(deg * 2) / 2;
}

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Stationary deadzone (g): |Vert Z| below this → display 0.00 (chart + leak prevention).
 */
const STATIONARY_DEADZONE_Z_G = 0.04;

/** Speed below this (km/h) displays as zero. */
const SPEED_DISPLAY_ZERO_BELOW_KMH = 5;

/** Absolute tilt (deg): Pitch = atan2(ay, az), Roll = atan2(-ax, √(ay²+az²)) — accelerometer only. */
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

/** Peak-G hysteresis — ignore buzz below this magnitude on MA_Z (motorcycle vibration). */
const PEAK_THRESHOLD_G = 0.15;
/** Moving-average length for Peak-G (40ms @ ~100Hz-ish sampling ≈ 4 samples). */
const PEAK_MA_SAMPLES = 4;

/** Fast LEMA on vertically projected accel (noise vs bumps). */
const VERT_FAST_ALPHA = 0.15;

/** Clamp displayed vertical linear Z (OSC + HUD + bump FSM). */
function displayWorldZG(zAfterProcessG: number) {
  'worklet';
  const z = zAfterProcessG;
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
  /** Deadzone'd vertical linear G (same as chart). */
  zG: number;
  peakRollLeft: number;
  peakRollRight: number;
  peakVertZ: number;
};

/** GPX / heatmap-ready track sample (logged when moving with REC on). */
export type TrackPoint = {
  lat: number;
  lon: number;
  ele: number;
  speed: number;
  maxZ: number;
  time: string;
};

function suspensionChipPresentation(surfaceStatus: SuspensionSurfaceStatus): {
  chipBg: string;
  chipBorder: string;
  chipText: string;
} {
  switch (surfaceStatus) {
    case 'HARSH_IMPACT':
      return { chipBg: '#18080c', chipBorder: '#ff4d6d', chipText: '#ff8a9e' };
    case 'UNDERDAMPED':
      return { chipBg: '#181004', chipBorder: '#e8a035', chipText: '#ffd18a' };
    case 'OVERDAMPED':
      return { chipBg: '#060e18', chipBorder: '#4a8cff', chipText: '#9ec5ff' };
    case 'GOOD':
    default:
      return { chipBg: '#06180e', chipBorder: '#2cff8a', chipText: '#8cffc4' };
  }
}

function surfaceStatusLabel(surfaceStatus: SuspensionSurfaceStatus): string {
  switch (surfaceStatus) {
    case 'HARSH_IMPACT':
      return 'HARSH IMPACT';
    case 'UNDERDAMPED':
      return 'UNDERDAMPED';
    case 'OVERDAMPED':
      return 'OVERDAMPED';
    case 'GOOD':
    default:
      return 'GOOD';
  }
}

export default function OscilloscopeView() {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const mono = (MONO as string) ?? 'monospace';

  const chartWsv = useSharedValue(Math.max(winW, 120));
  const chartHsv = useSharedValue(winH);

  const rawAx = useSharedValue(0);
  const rawAy = useSharedValue(0);
  const rawAz = useSharedValue(1);

  /**
   * World +Z axis expressed in device body coords (unit vector), fixed at CAL.
   * Default: gravity along device +Z (~screen normal) → dot gives Az until user calibrates tilted mount.
   */
  const gravUnitX = useSharedValue(0);
  const gravUnitY = useSharedValue(0);
  const gravUnitZ = useSharedValue(1);

  /** Fast LPF on vertical linear accel (projection minus 1g). */
  const cleanVertZSv = useSharedValue(0);

  /** After first CAL, relative angles / bumps are anchored. */
  const hasCalibSv = useSharedValue(0);

  const slider01 = useSharedValue(1 / 3);

  const writeIdxSv = useSharedValue(0);
  const waveData = useSharedValue(new Float32Array(BUFFER_LEN));
  const sampleTick = useSharedValue(0);

  /** Absolute pitch/roll from accel-only EMA (deg). */
  const pitchFusDegSv = useSharedValue(0);
  const rollFusDegSv = useSharedValue(0);
  /** Snapshot at CAL — HUD shows fused minus bias. */
  const pitchCalBiasDegSv = useSharedValue(0);
  const rollCalBiasDegSv = useSharedValue(0);

  const dspPitchDeg = useSharedValue(0);
  const dspRollDeg = useSharedValue(0);
  const dspPeakG = useSharedValue(0);
  /** Max roll each side after cal (deg). */
  const dspPeakRollLeftDeg = useSharedValue(0);
  const dspPeakRollRightDeg = useSharedValue(0);
  const dspPeakVertZSv = useSharedValue(0);
  /** Last HUD Z (deadzone chart sample). */
  const hudDisplayZSv = useSharedValue(0);
  /** Rolling vert_z_raw samples for Peak-G MA buffer. */
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
  const [bumpDiag, setBumpDiag] = useState<SuspensionBumpDiagResult | null>(null);
  const [trackLog, setTrackLog] = useState<TrackPoint[]>([]);
  const [isLogging, setIsLogging] = useState(false);

  const isLoggingRef = useRef(false);
  useEffect(() => {
    isLoggingRef.current = isLogging;
  }, [isLogging]);

  const trackLogLengthRef = useRef(0);
  trackLogLengthRef.current = trackLog.length;

  const onBumpEventComplete = useCallback((result: SuspensionBumpDiagResult) => {
    setBumpDiag(result);
  }, []);

  const { resetBumpFsm } = useSuspensionBumpFsm({
    vertZ: cleanVertZSv,
    hasCalib: hasCalibSv,
    onBumpComplete: onBumpEventComplete,
  });

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
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 200,
            distanceInterval: 0,
          },
          (loc) => {
            const speedMs = loc.coords.speed;
            const s = Math.max(speedMs ?? 0, 0);
            speedKmH.value = s * 3.6;

            if (!isLoggingRef.current || s <= 0) {
              return;
            }

            const lat = loc.coords.latitude;
            const lon = loc.coords.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              return;
            }

            const maxZ = dspPeakVertZSv.value;
            const ele = loc.coords.altitude;
            const spdKmh = s * 3.6;
            const timeStr =
              loc.timestamp != null && loc.timestamp > 0
                ? new Date(loc.timestamp).toISOString()
                : new Date().toISOString();

            const point: TrackPoint = {
              lat,
              lon,
              ele: ele != null && Number.isFinite(ele) ? ele : 0,
              speed: spdKmh,
              maxZ,
              time: timeStr,
            };

            setTrackLog((prev) => [...prev, point]);

            runOnUI(() => {
              'worklet';
              dspPeakVertZSv.value = 0;
            })();
          }
        );
      } catch {
        speedKmH.value = 0;
      }
    })();
    return () => {
      void sub?.remove();
    };
  }, []);

  useEffect(() => {
    if (dashLocked) {
      setAdvancedSettingsOpen(false);
    }
  }, [dashLocked]);

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
    }),
    (cur) => {
      'worklet';
      const bx = cur.ax;
      const by = cur.ay;
      const bz = cur.az;

      const z_total = bx * cur.gux + by * cur.guy + bz * cur.guz;
      const vert_z_raw = z_total - 1.0;
      cleanVertZSv.value =
        VERT_FAST_ALPHA * vert_z_raw + (1 - VERT_FAST_ALPHA) * cleanVertZSv.value;

      const chartSample = displayWorldZG(cleanVertZSv.value);

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
        pitchFusDegSv.value =
          HUD_ANGLE_EMA * aPitch + (1 - HUD_ANGLE_EMA) * pitchFusDegSv.value;
        rollFusDegSv.value =
          HUD_ANGLE_EMA * aRoll + (1 - HUD_ANGLE_EMA) * rollFusDegSv.value;

        const pitchRel = pitchFusDegSv.value - pitchCalBiasDegSv.value;
        const rollRel = rollFusDegSv.value - rollCalBiasDegSv.value;
        dspPitchDeg.value =
          HUD_ANGLE_EMA * pitchRel + (1 - HUD_ANGLE_EMA) * dspPitchDeg.value;
        dspRollDeg.value =
          HUD_ANGLE_EMA * rollRel + (1 - HUD_ANGLE_EMA) * dspRollDeg.value;

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

      hudDisplayZSv.value = chartSample;
      sampleTick.value += 1;
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

  /** Quadratic Bézier spline through waveform midpoints (fluid trace vs jaggy polyline). */
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

    /** Midpoint spline: control at each vertex, end toward next midpoint until last vertex. */
    for (let k = 1; k + 1 < n; k++) {
      const ex = k + 1 < n - 1 ? (xs[k] + xs[k + 1]) * 0.5 : xs[n - 1];
      const ey = k + 1 < n - 1 ? (ys[k] + ys[k + 1]) * 0.5 : ys[n - 1];
      p.quadTo(xs[k], ys[k], ex, ey);
    }

    return p;
  });

  const flashCalBanner = useCallback(() => {
    setCalUiBanner('CAL · Z zero');
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

  const toggleTrackLogging = useCallback(() => {
    setIsLogging((prev) => {
      if (prev) {
        Alert.alert('Track stopped', `Array has ${trackLogLengthRef.current} points.`);
        return false;
      }
      return true;
    });
  }, []);

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
            <Text style={[styles.logo, { fontFamily: mono }]}>LAUDA Performance</Text>
            <Text style={[styles.logoSub, { fontFamily: mono }]}>OSC DIAGRAM</Text>
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
            <Text style={[styles.hudSectionLabel, { fontFamily: mono }]}>Suspension · bump</Text>
            <SuspensionBumpDiagCard diag={bumpDiag} mono={mono} />
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
              ADVANCED · VERT FAST α FIXED (0.15)
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

          <View style={styles.calRowRight}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isLogging ? 'Stop GPS track recording' : 'Start GPS track recording'}
              disabled={dashLocked}
              onPress={toggleTrackLogging}
              style={({ pressed }) => [
                styles.recBtn,
                dashLocked && styles.recBtnDisabled,
                isLogging && styles.recBtnOn,
                pressed && styles.recBtnPressed,
              ]}
            >
              <Text style={[styles.recLabel, { fontFamily: mono }]}>
                {isLogging ? 'REC ●' : 'REC'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Instant calibration: snap vertical axis to zero using current gravity. Long press to open filter settings."
              disabled={calUiBanner !== null}
              onPress={instantCalibrate}
              delayLongPress={450}
              style={() => [
                styles.calBtn,
                calUiBanner !== null && styles.calBtnDisabled,
              ]}
            >
              <View pointerEvents="none" style={styles.calGlow} />
              <Text style={[styles.calLabel, { fontFamily: mono }]}>CAL</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function SuspensionBumpDiagCard({
  diag,
  mono,
}: {
  diag: SuspensionBumpDiagResult | null;
  mono: string;
}) {
  if (!diag) {
    return (
      <View style={styles.bumpDiagCard}>
        <Text style={[styles.bumpDiagPlaceholder, { fontFamily: mono }]}>
          Hit a bump above 0.8 g (after CAL); tuning advice appears when the trace settles (±0.15 g for 150 ms).
        </Text>
      </View>
    );
  }

  const ss = suspensionChipPresentation(diag.surfaceStatus);
  return (
    <View style={styles.bumpDiagCard}>
      <View style={styles.bumpDiagHeadRow}>
        <View style={[styles.bumpStatusChip, { borderColor: ss.chipBorder, backgroundColor: ss.chipBg }]}>
          <Text style={[styles.bumpStatusChipTxt, { fontFamily: mono, color: ss.chipText }]}>
            {surfaceStatusLabel(diag.surfaceStatus)}
          </Text>
        </View>
        <Text style={[styles.bumpPeakInline, { fontFamily: mono }]}>
          Peak {diag.maxPeakZG.toFixed(2)}{' '}
          <Text style={[styles.metricTileSuf, { fontFamily: mono }]}>g</Text>
        </Text>
      </View>

      <Text style={[styles.bumpAdviceLine, { fontFamily: mono }]}>
        <Text style={styles.bumpAdviceLbl}>Compression · </Text>
        {diag.compressionAdvice}
      </Text>
      <Text style={[styles.bumpAdviceLine, { fontFamily: mono }]}>
        <Text style={styles.bumpAdviceLbl}>Rebound · </Text>
        {diag.reboundAdvice}
      </Text>

      <Text style={[styles.bumpDiagMeta, { fontFamily: mono }]}>
        Bounces {diag.bounceCount} · Settling {diag.settlingDurationMs.toFixed(0)} ms
      </Text>
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
  bumpDiagCard: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 11,
    backgroundColor: '#060a08',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#243028',
    gap: 10,
    shadowColor: '#102218',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.85,
    shadowRadius: 4,
    elevation: 3,
  },
  bumpDiagPlaceholder: {
    color: '#5f7d6c',
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.4,
  },
  bumpDiagHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  bumpStatusChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  bumpStatusChipTxt: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  bumpPeakInline: {
    color: '#c4f5dc',
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  bumpAdviceLine: {
    color: '#a8d4bf',
    fontSize: 12,
    lineHeight: 17,
    letterSpacing: 0.2,
  },
  bumpAdviceLbl: {
    color: '#6d8c7a',
    fontWeight: '600',
  },
  bumpDiagMeta: {
    color: '#5f7d6c',
    fontSize: 10,
    letterSpacing: 0.6,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
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
    gap: 10,
    flexWrap: 'wrap',
  },
  calRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
  recBtn: {
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderRadius: 8,
    backgroundColor: '#14080a',
    borderWidth: 1.5,
    borderColor: '#ff5c73',
    minWidth: 84,
    alignItems: 'center',
  },
  recBtnOn: {
    backgroundColor: '#2a0610',
    borderColor: '#ff2150',
  },
  recBtnDisabled: {
    opacity: 0.35,
  },
  recBtnPressed: {
    opacity: 0.88,
  },
  recLabel: {
    color: '#ff8fa3',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.6,
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
    // backgroundColor: '#071a10',
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
    borderRadius: 32,
    shadowColor: '#2cff8a',
    shadowOpacity: 0.8,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: -4 },
    elevation: 15,
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
