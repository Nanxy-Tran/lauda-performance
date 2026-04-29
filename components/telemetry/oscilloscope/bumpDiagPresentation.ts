import type { SuspensionSurfaceStatus } from '../useSuspensionBumpFsm';

export function suspensionChipPresentation(surfaceStatus: SuspensionSurfaceStatus): {
  chipBg: string;
  chipBorder: string;
  chipText: string;
} {
  switch (surfaceStatus) {
    case 'HARSH_IMPACT':
      return { chipBg: '#18080c', chipBorder: '#ff4d6d', chipText: '#ff8a9e' };
    case 'UNDERDAMPED':
      return { chipBg: '#181004', chipBorder: '#e8a035', chipText: '#ffd18a' };
    case 'OVERDAMPED':
      return { chipBg: '#060e18', chipBorder: '#4a8cff', chipText: '#9ec5ff' };
    case 'GOOD':
    default:
      return { chipBg: '#06180e', chipBorder: '#2cff8a', chipText: '#8cffc4' };
  }
}

export function surfaceStatusLabel(surfaceStatus: SuspensionSurfaceStatus): string {
  switch (surfaceStatus) {
    case 'HARSH_IMPACT':
      return 'HARSH IMPACT';
    case 'UNDERDAMPED':
      return 'UNDERDAMPED';
    case 'OVERDAMPED':
      return 'OVERDAMPED';
    case 'GOOD':
    default:
      return 'GOOD';
  }
}
