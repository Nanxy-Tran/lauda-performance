import * as Location from 'expo-location';
import { useEffect, useRef } from 'react';
import type { SharedValue } from 'react-native-reanimated';

export type ForegroundGpsSample = {
  speedMs: number;
  latitude: number;
  longitude: number;
  altitude: number | null;
  timestampMs: number;
};

export type UseForegroundGpsStreamOpts = {
  speedKmH: SharedValue<number>;
  onSample?: (sample: ForegroundGpsSample) => void;
};

/**
 * Foreground GPS watch: updates `speedKmH` every fix and optionally notifies for track logging.
 */
export function useForegroundGpsStream({ speedKmH, onSample }: UseForegroundGpsStreamOpts): void {
  const onSampleRef = useRef(onSample);
  onSampleRef.current = onSample;

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
            timeInterval: 100,
            distanceInterval: 0,
          },
          (loc) => {
            const speedMs = loc.coords.speed;
            const s = Math.max(speedMs ?? 0, 0);
            speedKmH.value = s * 3.6;

            const lat = loc.coords.latitude;
            const lon = loc.coords.longitude;
            const tsMs =
              loc.timestamp != null && loc.timestamp > 0 ? loc.timestamp : Date.now();

            const sample: ForegroundGpsSample = {
              speedMs: s,
              latitude: lat,
              longitude: lon,
              altitude:
                loc.coords.altitude != null && Number.isFinite(loc.coords.altitude)
                  ? loc.coords.altitude
                  : null,
              timestampMs: tsMs,
            };
            onSampleRef.current?.(sample);
          }
        );
      } catch {
        speedKmH.value = 0;
      }
    })();
    return () => {
      void sub?.remove();
    };
  }, [speedKmH]);
}
