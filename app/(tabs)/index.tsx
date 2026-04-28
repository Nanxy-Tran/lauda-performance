import * as ScreenOrientation from 'expo-screen-orientation';
import { useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import OscilloscopeView from '@/components/telemetry/OscilloscopeView';

export default function TelemetryScreen() {
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
      <OscilloscopeView />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#000000',
  },
});
