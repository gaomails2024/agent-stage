import {
  STATUS_LABELS_EN,
  STATUS_LABELS_ZH,
  isBuiltinStatus,
  type StatusId,
} from '../domain/status';

export function statusLabelZh(status: StatusId): string {
  if (isBuiltinStatus(status)) return STATUS_LABELS_ZH[status];
  return status;
}

export function statusLabelEn(status: StatusId): string {
  if (isBuiltinStatus(status)) return STATUS_LABELS_EN[status];
  return status;
}

export function statusLabel(status: StatusId): string {
  // User-facing badge: Chinese only (EN via statusLabelEn for debug)
  return statusLabelZh(status);
}

/** Stable pastel accent from agent id */
export function accentForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 48% 42%)`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || '?';
}
