/**
 * Default canvas: iPad (4th gen) landscape as secondary monitor.
 * Apple: 9.7" Retina, 2048×1536 @ 264 ppi, 4:3.
 *
 * Design / target window width is **physical 2048×1536** so the UI fills the
 * secondary panel. Logical @2x CSS points (1024×768) are only a note for
 * iPadOS-style scaling — layout math and defaults use 2048.
 * Layout still follows the actual window/viewport (100dvh / 100%), never a
 * primary-monitor assumption.
 */
export const DEFAULT_DISPLAY_PROFILE = {
  id: 'ipad4-landscape',
  label: 'iPad 4 landscape',
  /** Physical pixels (Retina) — also default window size on the secondary panel */
  physicalWidth: 2048,
  physicalHeight: 1536,
  /** Logical / CSS points when the OS scales @2x like iPadOS (informational) */
  logicalWidth: 1024,
  logicalHeight: 768,
  scaleFactor: 2,
  /** Default desktop window = fill physical secondary panel */
  windowWidth: 2048,
  windowHeight: 1536,
  aspectRatio: '4:3' as const,
  diagonalInches: 9.7,
  ppi: 264,
  /** Suggested standing portrait (立绘) box inside a seat */
  portraitAspect: '2:3' as const,
  /** Seat card width on the 2048-wide secondary canvas */
  defaultSeatCardWidth: 130,
  /** Seat strip height — must clear full seat card (portrait only, no meta row) */
  defaultSeatStripHeight: 300,
} as const;

export type DisplayProfile = typeof DEFAULT_DISPLAY_PROFILE;
