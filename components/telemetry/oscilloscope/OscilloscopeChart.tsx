import React from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { Canvas, Fill, Path, type SkPath } from '@shopify/react-native-skia';

import { TERRAIN_POTHOLE, TERRAIN_SPEED_BUMP } from './dspConstants';
import { styles } from './styles';

const FRONT_GREEN = '#34ff94';

export type OscilloscopeChartProps = {
  gridPath: SharedValue<SkPath>;
  baselinePath: SharedValue<SkPath>;
  oscilloscopePath: SharedValue<SkPath>;
  terrainKindSv: SharedValue<number>;
  terrainOverlayOpacitySv: SharedValue<number>;
  onLayout: (e: LayoutChangeEvent) => void;
  mono: string;
  calStateSv: SharedValue<number>;
  calProgressSv: SharedValue<number>;
  chartWsv: SharedValue<number>;
};

export function OscilloscopeChart({
  gridPath,
  baselinePath,
  oscilloscopePath,
  terrainKindSv,
  terrainOverlayOpacitySv,
  onLayout,
  mono,
  calStateSv,
  calProgressSv,
  chartWsv,
}: OscilloscopeChartProps) {
  const bumpStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    top: 10,
    right: 12,
    opacity:
      terrainKindSv.value === TERRAIN_SPEED_BUMP ? terrainOverlayOpacitySv.value : 0,
    pointerEvents: 'none',
  }));

  const potholeStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    top: 42,
    right: 12,
    opacity:
      terrainKindSv.value === TERRAIN_POTHOLE ? terrainOverlayOpacitySv.value : 0,
    pointerEvents: 'none',
  }));

  const calOverlayStyle = useAnimatedStyle(() => ({
    opacity: calStateSv.value === 1 ? 1 : 0,
    pointerEvents: 'none',
  }));

  const calProgressFillStyle = useAnimatedStyle(() => {
    const trackW = Math.max(80, chartWsv.value * 0.88);
    return {
      height: '100%',
      borderRadius: 3,
      backgroundColor: FRONT_GREEN,
      width: calProgressSv.value * trackW,
    };
  });

  return (
    <View style={styles.chartWrap} onLayout={onLayout}>
      <Canvas style={styles.canvas}>
        <Fill color="#010101" />
        <Path style="stroke" path={gridPath} color="#242424" strokeWidth={1} strokeCap="square" />
        <Path style="stroke" path={baselinePath} color="#173d2f" strokeWidth={1} strokeCap="round" />
        <Path
          style="stroke"
          path={oscilloscopePath}
          color={FRONT_GREEN}
          strokeWidth={2.35}
          strokeJoin="round"
          strokeCap="round"
        />
      </Canvas>

      <Animated.View style={bumpStyle}>
        <Text style={[styles.terrainIcon, { fontFamily: mono }]}>⛰</Text>
      </Animated.View>
      <Animated.View style={potholeStyle}>
        <Text style={[styles.terrainIcon, { fontFamily: mono }]}>🕳</Text>
      </Animated.View>

      <Animated.View style={[styles.calPrecOverlay, calOverlayStyle]} pointerEvents="none">
        <Text style={[styles.calPrecTitle, { fontFamily: mono }]}>
          CALIBRATING... KEEP BIKE UPRIGHT
        </Text>
        <View style={styles.calPrecTrack}>
          <Animated.View style={calProgressFillStyle} />
        </View>
      </Animated.View>
    </View>
  );
}
