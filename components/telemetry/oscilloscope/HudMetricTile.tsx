import React from 'react';
import { Text, View } from 'react-native';

import { styles } from './styles';

export function HudMetricTile({
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
