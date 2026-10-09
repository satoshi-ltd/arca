const origins = new Map();
const EXPIRES_MS = 600;

export function putFlight(key, rect) {
  origins.set(key, { rect, at: Date.now() });
}

export function takeFlight(key) {
  const entry = origins.get(key);
  origins.delete(key);
  return entry && Date.now() - entry.at <= EXPIRES_MS ? entry.rect : null;
}

export function flightTransform(from, to) {
  if (!from || !to || !(from.width > 0) || !(to.width > 0)) return null;
  return {
    dx: from.x + from.width / 2 - (to.x + to.width / 2),
    dy: from.y + from.height / 2 - (to.y + to.height / 2),
    scale: from.width / to.width,
  };
}
