import React from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { Canvas, Fill, Path, type SkPath } from '@shopify/react-native-skia';

import { REAR_TRACE_COLOR, TERRAIN_POTHOLE, TERRAIN_SPEED_BUMP } from './dspConstants';
import { styles } from './styles';

const FRONT_GREEN = '#34ff94';

export type OscilloscopeChartProps = {
  gridPath: SharedValue<SkPath>;
  baselinePath: SharedValue<SkPath>;
  frontBaseTrace: SharedValue<SkPath>;
  frontActiveTrace: SharedValue<SkPath>;
  rearBaseTrace: SharedValue<SkPath>;
  rearActiveTrace: SharedValue<SkPath>;
  terrainKindSv: SharedValue<number>;
  terrainOverlayOpacitySv: SharedValue<number>;
  onLayout: (e: LayoutChangeEvent) => void;
  calUiBanner: string | null;
  mono: string;
};

export function OscilloscopeChart({
  gridPath,
  baselinePath,
  frontBaseTrace,
  frontActiveTrace,
  rearBaseTrace,
  rearActiveTrace,
  terrainKindSv,
  terrainOverlayOpacitySv,
  onLayout,
  calUiBanner,
  mono,
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

  return (
    <View style={styles.chartWrap} onLayout={onLayout}>
      <Canvas style={styles.canvas}>
        <Fill color="#010101" />
        <Path style="stroke" path={gridPath} color="#242424" strokeWidth={1} strokeCap="square" />
        <Path style="stroke" path={baselinePath} color="#173d2f" strokeWidth={1} strokeCap="round" />
        {/* Front fork — muted context */}
        <Path
          style="stroke"
          path={frontBaseTrace}
          color={FRONT_GREEN}
          strokeWidth={1.15}
          strokeJoin="round"
          strokeCap="round"
        />
        {/* Rear shock — muted context */}
        <Path
          style="stroke"
          path={rearBaseTrace}
          color={REAR_TRACE_COLOR}
          strokeWidth={1.15}
          strokeJoin="round"
          strokeCap="round"
        />
        {/* FSM-highlighted traces */}
        <Path
          style="stroke"
          path={frontActiveTrace}
          color={FRONT_GREEN}
          strokeWidth={2.85}
          strokeJoin="round"
          strokeCap="round"
        />
        <Path
          style="stroke"
          path={rearActiveTrace}
          color={REAR_TRACE_COLOR}
          strokeWidth={2.85}
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

      {calUiBanner ? (
        <View style={styles.calBanner} pointerEvents="none">
          <Text style={[styles.calBannerText, { fontFamily: mono }]}>{calUiBanner}</Text>
        </View>
      ) : null}
    </View>
  );
}
