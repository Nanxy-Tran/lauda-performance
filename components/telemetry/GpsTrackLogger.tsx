import * as FileSystem from 'expo-file-system/legacy';
import {
  activateKeepAwakeAsync,
  deactivateKeepAwake,
} from 'expo-keep-awake';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import { runOnUI } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

const KEEP_AWAKE_TAG_GPS_REC = 'LaudaPerformanceGpsRec';

/** GPX / heatmap-ready track sample (logged when moving with REC on). */
export type TrackPoint = {
  lat: number;
  lon: number;
  ele: number;
  speed: number;
  maxZ: number;
  /** Motorcycle lean angle (deg), instantaneous from accel HUD pipeline. */
  roll: number;
  /** Motorcycle pitch angle (deg), instantaneous from accel HUD pipeline. */
  pitch: number;
  time: string;
};

export type GpsTrackLoggerProps = {
  speedKmH: SharedValue<number>;
  dspPeakVertZSv: SharedValue<number>;
  dspPitchDeg: SharedValue<number>;
  dspRollDeg: SharedValue<number>;
  dashLocked: boolean;
  mono: string;
};

export function GpsTrackLogger({
  speedKmH,
  dspPeakVertZSv,
  dspPitchDeg,
  dspRollDeg,
  dashLocked,
  mono,
}: GpsTrackLoggerProps) {
  const [trackLog, setTrackLog] = useState<TrackPoint[]>([]);
  const [isLogging, setIsLogging] = useState(false);

  const isLoggingRef = useRef(false);
  useEffect(() => {
    isLoggingRef.current = isLogging;
  }, [isLogging]);

  /** While recording: keep screen awake — reduces OEM sleep/dim stalls that stall GPS/UI updates while still foregrounded. */
  useEffect(() => {
    if (isLogging) {
      void activateKeepAwakeAsync(KEEP_AWAKE_TAG_GPS_REC);
      return () => {
        void deactivateKeepAwake(KEEP_AWAKE_TAG_GPS_REC);
      };
    }
    void deactivateKeepAwake(KEEP_AWAKE_TAG_GPS_REC);
  }, [isLogging]);

  const trackLogLengthRef = useRef(0);
  trackLogLengthRef.current = trackLog.length;

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

            if (!isLoggingRef.current || s <= 0) {
              return;
            }

            const lat = loc.coords.latitude;
            const lon = loc.coords.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              return;
            }

            const maxZ = dspPeakVertZSv.value;
            const roll = dspRollDeg.value;
            const pitch = dspPitchDeg.value;
            const ele = loc.coords.altitude;
            const spdKmh = s * 3.6;
            const timeStr =
              loc.timestamp != null && loc.timestamp > 0
                ? new Date(loc.timestamp).toISOString()
                : new Date().toISOString();

            const point: TrackPoint = {
              lat,
              lon,
              ele: ele != null && Number.isFinite(ele) ? ele : 0,
              speed: spdKmh,
              maxZ,
              roll,
              pitch,
              time: timeStr,
            };

            setTrackLog((prev) => [...prev, point]);

            runOnUI(() => {
              'worklet';
              dspPeakVertZSv.value = 0;
            })();
          }
        );
      } catch {
        speedKmH.value = 0;
      }
    })();
    return () => {
      void sub?.remove();
    };
  }, [dspPeakVertZSv, dspPitchDeg, dspRollDeg, speedKmH]);

  const toggleTrackLogging = useCallback(() => {
    setIsLogging((prev) => {
      if (prev) {
        Alert.alert('Track stopped', `Array has ${trackLogLengthRef.current} points.`);
        return false;
      }
      return true;
    });
  }, []);

  const exportToGPX = useCallback(async () => {
    if (trackLog.length === 0) {
      Alert.alert('No track data to export');
      return;
    }

    let gpxString = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="LaudaPerformance">\n  <trk>\n    <name>Suspension Telemetry</name>\n    <trkseg>\n`;

    trackLog.forEach((pt) => {
      gpxString += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">\n`;
      gpxString += `        <ele>${pt.ele}</ele>\n`;
      gpxString += `        <time>${pt.time}</time>\n`;
      gpxString += `        <extensions>\n          <speed>${pt.speed}</speed>\n          <maxZ>${pt.maxZ.toFixed(3)}</maxZ>\n          <roll>${pt.roll.toFixed(1)}</roll>\n          <pitch>${pt.pitch.toFixed(1)}</pitch>\n        </extensions>\n`;
      gpxString += `      </trkpt>\n`;
    });

    gpxString += `    </trkseg>\n  </trk>\n</gpx>`;

    const baseUri = FileSystem.documentDirectory;
    if (!baseUri) {
      Alert.alert('Export failed', 'Documents directory unavailable.');
      return;
    }

    const fileUri = `${baseUri}LaudaTelemetry_${new Date().getTime()}.gpx`;

    try {
      await FileSystem.writeAsStringAsync(fileUri, gpxString, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      await Sharing.shareAsync(fileUri);
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : 'Could not write or share the GPX file.');
    }
  }, [trackLog]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isLogging ? 'Stop GPS track recording' : 'Start GPS track recording'}
        disabled={dashLocked}
        onPress={toggleTrackLogging}
        style={({ pressed }) => [
          styles.recBtn,
          dashLocked && styles.recBtnDisabled,
          isLogging && styles.recBtnOn,
          pressed && styles.recBtnPressed,
        ]}
      >
        <Text style={[styles.recLabel, { fontFamily: mono }]}>{isLogging ? 'REC ●' : 'REC'}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Export track as GPX file"
        disabled={isLogging || dashLocked}
        onPress={() => {
          void exportToGPX();
        }}
        style={({ pressed }) => [
          styles.exportGpxBtn,
          (isLogging || dashLocked) && styles.exportGpxBtnDisabled,
          pressed && styles.exportGpxBtnPressed,
        ]}
      >
        <Text style={[styles.exportGpxLabel, { fontFamily: mono }]}>EXPORT GPX</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  recBtn: {
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderRadius: 8,
    backgroundColor: '#14080a',
    borderWidth: 1.5,
    borderColor: '#ff5c73',
    minWidth: 84,
    alignItems: 'center',
  },
  recBtnOn: {
    backgroundColor: '#2a0610',
    borderColor: '#ff2150',
  },
  recBtnDisabled: {
    opacity: 0.35,
  },
  recBtnPressed: {
    opacity: 0.88,
  },
  recLabel: {
    color: '#ff8fa3',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  exportGpxBtn: {
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: '#0a1210',
    borderWidth: 1,
    borderColor: '#3d6b5a',
    minWidth: 108,
    alignItems: 'center',
  },
  exportGpxBtnDisabled: {
    opacity: 0.35,
  },
  exportGpxBtnPressed: {
    opacity: 0.88,
  },
  exportGpxLabel: {
    color: '#7dd4b0',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
