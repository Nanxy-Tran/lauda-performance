import React from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { Canvas, Fill, Path, type SkPath } from '@shopify/react-native-skia';

import { styles } from './styles';

export type OscilloscopeChartProps = {
  gridPath: SharedValue<SkPath>;
  baselinePath: SharedValue<SkPath>;
  oscilloscopePath: SharedValue<SkPath>;
  onLayout: (e: LayoutChangeEvent) => void;
  calUiBanner: string | null;
  mono: string;
};

export function OscilloscopeChart({
  gridPath,
  baselinePath,
  oscilloscopePath,
  onLayout,
  calUiBanner,
  mono,
}: OscilloscopeChartProps) {
  return (
    <View style={styles.chartWrap} onLayout={onLayout}>
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
  );
}
