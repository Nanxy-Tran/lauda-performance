import { PermissionsAndroid, Platform } from 'react-native';

/** Best-effort type for PermissionsAndroid.requestMultiple return map. */
type PermissionOutcomeMap = Partial<Record<string, string>>;

/**
 * Requests Android Bluetooth-related runtime permissions before opening an SPP socket:
 * `ACCESS_FINE_LOCATION`, and on API 31+ `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`.
 *
 * Non-Android: resolves `true` (no-op). Pass `onStep` to mirror each outcome in the OBD terminal.
 */
export async function requestBluetoothPermissions(
  onStep?: (message: string) => void
): Promise<boolean> {
  if (Platform.OS !== 'android') {
    onStep?.(`Permission step: skipping (Platform.OS=${Platform.OS})`);
    return true;
  }

  try {
    const sdk = typeof Platform.Version === 'number' ? Platform.Version : 0;
    const keys = [
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ...(sdk >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]
        : []),
    ];

    onStep?.(`Permission step: invoking requestMultiple (Android SDK ${sdk}) …`);
    onStep?.(`Permission step: keys → ${keys.join(', ')}`);

    const outcomes = await PermissionsAndroid.requestMultiple(
      keys as unknown as Parameters<typeof PermissionsAndroid.requestMultiple>[0]
    );
    const map = outcomes as PermissionOutcomeMap;

    let allGranted = true;
    for (const key of keys) {
      const r = map[key];
      onStep?.(`Permission step: outcome ${key} → ${String(r)}`);
      if (r !== PermissionsAndroid.RESULTS.GRANTED) {
        allGranted = false;
      }
    }

    onStep?.(
      `Permission step: final ${allGranted ? 'ALLOWED — proceed' : 'BLOCKED — cannot open SPP'}`
    );
    return allGranted;
  } catch (e) {
    onStep?.(`Permission step: exception ${JSON.stringify(e)}`);
    return false;
  }
}
