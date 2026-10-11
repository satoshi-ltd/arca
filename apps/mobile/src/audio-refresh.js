import { positionMap } from "./audio-positions.js";

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

export function mergeHubPositions(known, rows, finished, deviceId) {
  const next = positionMap(rows, finished);
  for (const [key, row] of known) {
    const hub = next.get(key);
    if (hub ? (row.updated || 0) > (hub.updated || 0) : deviceId != null && row.device === deviceId) next.set(key, row);
  }
  if (next.size === known.size && [...next].every(([key, row]) => known.has(key) && sameRow(known.get(key), row))) return known;
  return next;
}

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
