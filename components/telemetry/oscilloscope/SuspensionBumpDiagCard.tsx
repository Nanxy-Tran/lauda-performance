import React from 'react';
import { Text, View } from 'react-native';

import type { SuspensionBumpDiagResult } from '../useSuspensionBumpFsm';
import { surfaceStatusLabel, suspensionChipPresentation } from './bumpDiagPresentation';
import { styles } from './styles';

export function SuspensionBumpDiagCard({
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
