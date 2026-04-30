import React from 'react';
import { Text, View } from 'react-native';

import type { SuspensionBumpDiagResult } from '../useSuspensionBumpFsm';
import { surfaceStatusLabel, suspensionChipPresentation } from './bumpDiagPresentation';
import { styles } from './styles';

type AxisBumpAdviceCardProps = {
  axisTitle: string;
  diag: SuspensionBumpDiagResult | null;
  mono: string;
  showPitchBadge: boolean;
  rearWaitingPlaceholder: string | null;
};

/** Single-axis bump diagnostics (Fork or Shock). */
export function AxisBumpAdviceCard({
  axisTitle,
  diag,
  mono,
  showPitchBadge,
  rearWaitingPlaceholder,
}: AxisBumpAdviceCardProps) {
  const showWaiting = rearWaitingPlaceholder != null && diag === null;

  if (diag === null) {
    return (
      <View style={[styles.bumpDiagCard, styles.bumpAxisCardHalf]}>
        <Text style={[styles.axisBumpCardTitle, { fontFamily: mono }]}>{axisTitle}</Text>
        <Text style={[styles.bumpDiagPlaceholder, { fontFamily: mono }]}>
          {showWaiting
            ? rearWaitingPlaceholder
            : 'Hit a bump after CAL · advice lands when settling holds.'}
        </Text>
      </View>
    );
  }

  const ss = suspensionChipPresentation(diag.surfaceStatus);
  return (
    <View style={[styles.bumpDiagCard, styles.bumpAxisCardHalf]}>
      <Text style={[styles.axisBumpCardTitle, { fontFamily: mono }]}>{axisTitle}</Text>

      {showPitchBadge ? (
        <View style={styles.pitchBiasBadge}>
          <Text style={[styles.pitchBiasBadgeText, { fontFamily: mono }]}>{diag.pitchBiasNote}</Text>
        </View>
      ) : null}

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
