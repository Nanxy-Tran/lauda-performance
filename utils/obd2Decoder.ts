/**
 * ELM327 / OBD-II response helpers (Mode 01 PID hex from ECU).
 * Hex strings may include spaces, CR/LF, or a trailing `>` prompt.
 */

function stripToHexChars(str: string): string {
  return str
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .replace(/>/g, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** Remove spaces, CR, LF, and common ELM prompt noise; upper-case hex. */
export function cleanHexResponse(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return stripToHexChars(str);
}

function byteFromPair(pair: string): number | null {
  if (pair.length < 2) return null;
  const n = parseInt(pair.slice(0, 2), 16);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
}

/** Mode 01 positive response header is `41` + two-char PID, then data bytes. */
function payloadAfterPid(hexClean: string, pid: string): string {
  const pidU = pid.replace(/^0x/i, '').toUpperCase().padStart(2, '0');
  const marker = `41${pidU}`;
  const idx = hexClean.indexOf(marker);
  if (idx === -1) {
    return hexClean;
  }
  return hexClean.slice(idx + marker.length);
}

function parseByteA(hex: string, pid: string): number | null {
  const h = cleanHexResponse(hex);
  if (h.length < 2) return null;
  const payload = payloadAfterPid(h, pid);
  return byteFromPair(payload.slice(0, 2));
}

function parseBytesAB(hex: string, pid: string): { a: number; b: number } | null {
  const h = cleanHexResponse(hex);
  if (h.length < 2) return null;
  const payload = payloadAfterPid(h, pid);
  if (payload.length < 4) return null;
  const a = byteFromPair(payload.slice(0, 2));
  const b = byteFromPair(payload.slice(2, 4));
  if (a === null || b === null) return null;
  return { a, b };
}

/** PID 0x0C — Engine RPM: ((A*256)+B)/4 */
export function parseEngineRpm(hex: string): number {
  const pair = parseBytesAB(hex, '0C');
  if (!pair) return 0;
  const rpm = ((pair.a * 256 + pair.b) / 4) | 0;
  if (!Number.isFinite(rpm) || rpm < 0 || rpm > 16383) return 0;
  return rpm;
}

/** PID 0x0D — Vehicle speed (km/h): A */
export function parseVehicleSpeed(hex: string): number {
  const a = parseByteA(hex, '0D');
  if (a === null) return 0;
  if (a < 0 || a > 255) return 0;
  return a;
}

/** PID 0x05 — Coolant temp (°C): A - 40 */
export function parseCoolantTemp(hex: string): number {
  const a = parseByteA(hex, '05');
  if (a === null) return 0;
  return a - 40;
}

/** PID 0x0F — Intake air temp (°C): A - 40 */
export function parseIntakeAirTemp(hex: string): number {
  const a = parseByteA(hex, '0F');
  if (a === null) return 0;
  return a - 40;
}

/** PID 0x11 — Throttle position (%): (A * 100) / 255 */
export function parseThrottlePosition(hex: string): number {
  const a = parseByteA(hex, '11');
  if (a === null) return 0;
  const pct = (a * 100) / 255;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 0;
  return Math.round(pct * 10) / 10;
}

/**
 * Parse `AT RV` / reference voltage style ASCII (e.g. `12.3V`, `14.1\r`).
 */
export function parseBatteryVoltage(str: string): number {
  if (!str || typeof str !== 'string') return 0;
  const normalized = str.replace(/\r/g, '').replace(/\n/g, '').replace(/V/gi, '').trim();
  const m = normalized.match(/-?\d+\.?\d*/);
  if (!m) return 0;
  const v = parseFloat(m[0]);
  if (!Number.isFinite(v) || v < 0 || v > 24) return 0;
  return Math.round(v * 10) / 10;
}
