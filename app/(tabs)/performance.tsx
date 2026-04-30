import * as ScreenOrientation from 'expo-screen-orientation';
import { useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import PerformanceAnalyzerView from '@/components/telemetry/PerformanceAnalyzerView';

export default function PerformanceLabScreen() {
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        try {
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
        } catch {
          /* simulator / web */
        }
      })();

      return () => {
        void (async () => {
          try {
            await ScreenOrientation.unlockAsync();
          } catch {
            /* ignore */
          }
        })();
      };
    }, [])
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <PerformanceAnalyzerView />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#000000',
  },
});
