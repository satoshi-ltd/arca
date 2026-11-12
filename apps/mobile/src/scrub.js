export const SCRUB_SLOP = 10;
export const SCRUB_SETTLE_MS = 1500;

export const scrubFraction = (x, width, rtl = false) => Math.max(0, Math.min(1, (rtl ? width - x : x) / width));

export const scrubGrant = (x, width, rtl = false) =>
  width > 0 ? { origin: x, width, rtl, slid: false, at: scrubFraction(x, width, rtl) } : null;

export function scrubMove(drag, dx, dy = 0) {
  if (!drag) return null;
  if (!drag.slid && Math.abs(dy) > SCRUB_SLOP && Math.abs(dy) > Math.abs(dx)) return null;
  return { ...drag, slid: drag.slid || Math.abs(dx) > SCRUB_SLOP, at: scrubFraction(drag.origin + dx, drag.width, drag.rtl) };
}

export const scrubTarget = (drag, duration) => (drag && duration > 0 ? drag.at * duration : null);

export const scrubHeld = (held, position, now, near) =>
  held && now - held.at < SCRUB_SETTLE_MS && Math.abs(position - held.target) > near ? held.target : null;

export const scrubShown = (drag, position, duration) => scrubTarget(drag, duration) ?? position;

export const scrubPercent = (position, duration) =>
  `${duration > 0 ? Math.round(Math.max(0, Math.min(1, position / duration)) * 1000) / 10 : 0}%`;
