import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { DspTuningSliders } from '../DspTuningSliders';
import type { TelemetryPresetMode } from '../telemetryPresets';
import type { OscilloscopeSharedValues } from './hooks/useOscilloscopeSharedValues';
import { styles } from './styles';

const DRAWER_WIDTH_FRAC = 0.715;
const DRAWER_WIDTH_MAX_DP = 404;

/**
 * Drawer motion runs on the UI thread (Reanimated springs + interpolation worklets), not JS rAF pacing,
 * so it stays smooth on high refresh displays (90-120 Hz ProMotion).
 */
const SPRING_OPEN = { stiffness: 340, damping: 34, mass: 0.88 } as const;
const SPRING_CLOSE = { stiffness: 380, damping: 36, mass: 0.9 } as const;

const BACKDROP_OPACITY = 0.54;

export type OscilloscopeSettingsDrawerProps = {
  visible: boolean;
  onClose: () => void;
  mono: string;
  sv: OscilloscopeSharedValues;
  dspPresetSyncNonce: number;
  setTelemetryPresetMode: Dispatch<SetStateAction<TelemetryPresetMode>>;
};

type OscilloscopeSettingsDrawerInteriorProps = OscilloscopeSettingsDrawerProps & {
  mounted: boolean;
  setMounted: React.Dispatch<React.SetStateAction<boolean>>;
};

function OscilloscopeSettingsDrawerInterior({
  visible,
  onClose,
  mono,
  sv,
  dspPresetSyncNonce,
  setTelemetryPresetMode,
  mounted,
  setMounted,
}: OscilloscopeSettingsDrawerInteriorProps) {
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const drawerWidth = Math.min(DRAWER_WIDTH_MAX_DP, Math.round(winW * DRAWER_WIDTH_FRAC));
  const drawerWidthSv = useSharedValue(drawerWidth);
  const translateX = useSharedValue(-drawerWidth);
  const panStartX = useSharedValue(0);

  useEffect(() => {
    drawerWidthSv.value = drawerWidth;
  }, [drawerWidth, drawerWidthSv]);

  useEffect(() => {
    if (!mounted) return;
    cancelAnimation(translateX);
    if (visible) {
      translateX.value = -drawerWidthSv.value;
      translateX.value = withSpring(0, SPRING_OPEN);
    } else {
      translateX.value = withSpring(-drawerWidthSv.value, SPRING_CLOSE, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
  }, [visible, mounted, translateX, drawerWidthSv, setMounted]);

  const backdropStyle = useAnimatedStyle(() => {
    'worklet';
    const w = drawerWidthSv.value;
    return {
      opacity: interpolate(
        translateX.value,
        [-w, 0],
        [0, BACKDROP_OPACITY],
        Extrapolation.CLAMP
      ),
    };
  });

  const panelStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [{ translateX: translateX.value }],
    };
  });

  const panDismiss = Gesture.Pan()
    /** Prefer horizontal intent: activating only after dragging left clears vertical scroll jitter. */
    .activeOffsetX(-14)
    .failOffsetY([-28, 28])
    .onBegin(() => {
      cancelAnimation(translateX);
      panStartX.value = translateX.value;
    })
    .onUpdate((e) => {
      'worklet';
      const w = drawerWidthSv.value;
      const raw = panStartX.value + e.translationX;
      translateX.value = Math.min(0, Math.max(-w, raw));
    })
    .onEnd((e) => {
      'worklet';
      const w = drawerWidthSv.value;
      const thresh = -w * 0.28;
      const shouldClose = translateX.value < thresh || e.velocityX < -720;
      if (shouldClose) {
        runOnJS(onClose)();
      } else {
        translateX.value = withSpring(0, SPRING_OPEN);
      }
    });

  const {
    vertFastAlphaSv,
    sensitivityMultiplierSv,
    bumpThresholdGsv,
    stableZoneGsv,
    stableHoldMssv,
    harshPeakGsv,
    overdampedSettlingMssv,
    zeroCrossEpsGsv,
  } = sv;

  const panelInset = {
    top: insets.top,
    bottom: insets.bottom,
    left: insets.left,
  };

  return (
    <GestureHandlerRootView style={styles.settingsDrawerRoot}>
      <View style={{ flex: 1 }} accessibilityViewIsModal>
        <Animated.View
          accessibilityElementsHidden={!visible}
          importantForAccessibility={visible ? 'yes' : 'no-hide-descendants'}
          pointerEvents={visible ? 'auto' : 'none'}
          style={[styles.settingsDrawerBackdrop, backdropStyle]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss filter settings"
            style={styles.settingsDrawerBackdropPress}
            disabled={!visible}
            onPress={onClose}
          />
        </Animated.View>

        <GestureDetector gesture={panDismiss}>
          <Animated.View
            pointerEvents="box-none"
            style={[
              styles.settingsDrawerPanelWrap,
              {
                width: drawerWidth,
                top: panelInset.top,
                bottom: panelInset.bottom,
                left: panelInset.left,
              },
              panelStyle,
            ]}
          >
            <View style={styles.settingsDrawerPanel}>
              <View pointerEvents="none" style={styles.settingsDrawerEdgeLine} />
              <View style={[styles.settingsDrawerHeader, { paddingTop: 10 }]}>
                <View style={styles.settingsDrawerTitleBlock}>
                  <Text style={[styles.settingsDrawerTitle, { fontFamily: mono }]}>DSP · FSM</Text>
                  <Text style={[styles.settingsDrawerSubtitle, { fontFamily: mono }]}>
                    Live tuning · 1200cc @ ~45 km/h baseline
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close filter settings"
                  onPress={onClose}
                  style={({ pressed }) => [
                    styles.settingsDrawerCloseBtn,
                    pressed && styles.settingsDrawerCloseBtnPressed,
                  ]}
                >
                  <Ionicons name="close" size={22} color="#8a9e94" />
                </Pressable>
              </View>
              <View style={[styles.settingsDrawerBody, { paddingBottom: 14 }]}>
                <DspTuningSliders
                  presentation="sheet"
                  mono={mono}
                  visible={visible}
                  vertFastAlphaSv={vertFastAlphaSv}
                  sensitivityMultiplierSv={sensitivityMultiplierSv}
                  bumpThresholdG={bumpThresholdGsv}
                  stableZoneG={stableZoneGsv}
                  stableHoldMs={stableHoldMssv}
                  harshPeakG={harshPeakGsv}
                  overdampedSettlingMs={overdampedSettlingMssv}
                  zeroCrossEpsG={zeroCrossEpsGsv}
                  onUserTune={() => setTelemetryPresetMode('custom')}
                  externalSyncNonce={dspPresetSyncNonce}
                />
              </View>
            </View>
          </Animated.View>
        </GestureDetector>
      </View>
    </GestureHandlerRootView>
  );
}

export function OscilloscopeSettingsDrawer(props: OscilloscopeSettingsDrawerProps) {
  const { visible, onClose } = props;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
    }
  }, [visible]);

  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaProvider initialMetrics={initialWindowMetrics ?? undefined}>
        <OscilloscopeSettingsDrawerInterior {...props} mounted={mounted} setMounted={setMounted} />
      </SafeAreaProvider>
    </Modal>
  );
}
