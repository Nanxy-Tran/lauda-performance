/**
 * ELM327 / OBD-II response helpers (Mode 01 PID hex from ECU).
 * Hex strings may include spaces, CR/LF, or a trailing `>` prompt.
 */

/** True when ELM/OBD replies have no usable payload (Euro5/CAN quirks, bus idle). */
export function isElmNonDataResponse(raw: string): boolean {
  if (raw == null || typeof raw !== 'string') return true;
  if (raw.includes('?')) return true;
  const u = raw.toUpperCase();
  return (
    u.includes('SEARCHING') ||
    u.includes('NO DATA') ||
    u.includes('UNABLE') ||
    u.includes('CAN ERROR') ||
    u.includes('BUS INIT') ||
    u.includes('STOPPED') ||
    u.includes('DATA ERROR') ||
    u.includes('BUFFER FULL')
  );
}

/**
 * Mode 01 positive response: `41` + PID (2 hex) + data bytes.
 * Strips spaces, `>`, CR/LF only (per ELM line routing).
 */
export function decodeElmResponse(rawStr: string): { pid: string; value: number } | null {
  if (!rawStr || isElmNonDataResponse(rawStr)) return null;

  const hex = rawStr.replace(/[\s>\r\n]/g, '').toUpperCase();

  const idx41 = hex.indexOf('41');
  const framed = idx41 >= 0 ? hex.slice(idx41) : hex;
  if (!framed.startsWith('41')) return null;

  if (framed.length < 6) return null;

  const pid = framed.substring(2, 4);
  const aStr = framed.substring(4, 6);
  if (aStr.length < 2) return null;
  const A = parseInt(aStr, 16);
  if (!Number.isFinite(A) || A < 0 || A > 255) return null;

  const bStr = framed.substring(6, 8);
  const hasB = bStr.length >= 2;
  let Bparsed = NaN;
  if (hasB) Bparsed = parseInt(bStr, 16);

  switch (pid) {
    case '0C': {
      if (!hasB || framed.length < 8) return null;
      if (!Number.isFinite(Bparsed) || Bparsed < 0 || Bparsed > 255) return null;
      const rpm = ((A * 256 + Bparsed) / 4) | 0;
      if (!Number.isFinite(rpm) || rpm < 0 || rpm > 16383) return null;
      return { pid, value: rpm };
    }
    case '05':
    case '0F':
      return { pid, value: A - 40 };
    case '11': {
      const pct = (A * 100) / 255;
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
      return { pid, value: Math.round(pct * 10) / 10 };
    }
    case '0D':
      return { pid, value: A };
    default:
      return null;
  }
}

/** Adapter / ECU nominal voltage lines like `13.2V`, `RX: 14.1V`. */
export function parseVoltage(rawStr: string): number {
  if (!rawStr || typeof rawStr !== 'string') return 0;
  const m = rawStr.match(/-?\d+\.?\d*/);
  if (!m?.[0]) return 0;
  const v = parseFloat(m[0]);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10) / 10;
}

/** ELM `AT RV`-style strings; alias of {@link parseVoltage}. */
export function parseBatteryVoltage(str: string): number {
  return parseVoltage(str);
}

function stripToHexChars(str: string): string {
  return str.replace(/[>\sV\r\n]/gi, '').toUpperCase();
}

/** Strip ELM prompts, voltage/unit noise, ASCII whitespace; upper-case hex. */
export function cleanHexResponse(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return stripToHexChars(str);
}

/** PID 0x0C — Engine RPM (delegates to {@link decodeElmResponse}). */
export function parseEngineRpm(hex: string): number {
  if (isElmNonDataResponse(hex)) return 0;
  const d = decodeElmResponse(hex);
  return d?.pid === '0C' ? d.value : 0;
}

/** PID 0x0D — Vehicle speed (km/h): A */
export function parseVehicleSpeed(hex: string): number {
  if (isElmNonDataResponse(hex)) return 0;
  const d = decodeElmResponse(hex);
  return d?.pid === '0D' ? d.value : 0;
}

/** PID 0x05 — Coolant temp (°C): A - 40 */
export function parseCoolantTemp(hex: string): number {
  if (isElmNonDataResponse(hex)) return 0;
  const d = decodeElmResponse(hex);
  return d?.pid === '05' ? d.value : 0;
}

/** PID 0x0F — Intake air temp (°C): A - 40 */
export function parseIntakeAirTemp(hex: string): number {
  if (isElmNonDataResponse(hex)) return 0;
  const d = decodeElmResponse(hex);
  return d?.pid === '0F' ? d.value : 0;
}

/** PID 0x11 — Throttle position (%) */
export function parseThrottlePosition(hex: string): number {
  if (isElmNonDataResponse(hex)) return 0;
  const d = decodeElmResponse(hex);
  return d?.pid === '11' ? d.value : 0;
}
