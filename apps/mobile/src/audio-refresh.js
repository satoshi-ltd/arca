import { positionKey, positionMap, remember } from "./audio-positions.js";

export const POSITIONS_REFRESH_INTERVAL = 30000;

const sameRow = (a, b) => a === b || (a.updated === b.updated && a.position === b.position && !!a.finished === !!b.finished && a.hash === b.hash);

export function singleFlight(run) {
  let flight = null;
  return () => {
    flight ||= Promise.resolve()
      .then(run)
      .finally(() => {
        flight = null;
      });
    return flight;
  };
}

export function mergeHubPositions(known, rows, finished, deviceId, queued = null) {
  const next = positionMap(rows, finished);
  for (const [key, row] of known) {
    const hub = next.get(key);
    if (hub ? (row.updated || 0) > (hub.updated || 0) : deviceId != null && row.device === deviceId && (!queued || queued.has(key))) next.set(key, row);
  }
  if (next.size === known.size && [...next].every(([key, row]) => known.has(key) && sameRow(known.get(key), row))) return known;
  return next;
}

export function adoptPositions(known, rows) {
  let next = known;
  for (const [key, row] of positionMap(rows)) {
    if ((next.get(key)?.updated || 0) >= (row.updated || 0)) continue;
    if (next === known) next = new Map(known);
    next.set(key, row);
  }
  return next;
}

export const queuedKeys = (entries) => new Set((Array.isArray(entries) ? entries : []).map((entry) => positionKey(entry.volume, entry.path)));

export const queuedRows = (entries, device) =>
  (Array.isArray(entries) ? entries : []).map((entry) => remember(new Map(), entry, device, entry.at).get(positionKey(entry.volume, entry.path)));

export const savedRows = (saved, deviceId) =>
  deviceId != null && saved?.device === deviceId && Array.isArray(saved.rows) ? saved.rows : [];

export function startPositionRefresh({ refresh, interval = POSITIONS_REFRESH_INTERVAL, foreground, onForeground, timer = { set: setInterval, clear: clearInterval } }) {
  let reading = false;
  let stopped = false;
  const run = async () => {
    if (stopped || reading || !foreground()) return;
    reading = true;
    try {
      await refresh();
    } finally {
      reading = false;
    }
  };
  const handle = timer.set(run, interval);
  const release = onForeground(run);
  run();
  return () => {
    stopped = true;
    timer.clear(handle);
    release();
  };
}
