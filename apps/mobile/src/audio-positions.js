export const RESUME_MIN_SECONDS = 1200;
export const RESUME_HEAD_SECONDS = 10;
export const RESUME_TAIL_SECONDS = 60;
export const SAVE_INTERVAL = 15000;

export const positionKey = (volume, path) => `${volume}\0${path}`;

export const isFinished = (row) => !!row && (row.finished === true || row.position === 0);

export function positionMap(rows, finished = []) {
  const map = new Map();
  const keep = (row) => {
    const key = positionKey(row.volume, row.path);
    const known = map.get(key);
    if (!known || (known.updated || 0) < (row.updated || 0)) map.set(key, row);
  };
  const file = (row) => typeof row?.volume === "string" && typeof row.path === "string";
  for (const row of Array.isArray(rows) ? rows : [])
    if (file(row) && isFinished(row)) keep({ ...row, position: 0, finished: true });
    else if (file(row) && Number.isFinite(row.position) && Number.isFinite(row.duration) && row.duration > 0) keep(row);
  for (const row of Array.isArray(finished) ? finished : []) if (file(row)) keep({ ...row, position: 0, finished: true });
  return map;
}

export function positionSignature(positions) {
  return [...positions.values()]
    .map((row) => `${row.volume}\0${row.path}:${isFinished(row) ? "done" : Math.floor(row.position / 60)}`)
    .sort()
    .join("|");
}

export function trackFile(id) {
  const at = typeof id === "string" ? id.indexOf(":") : -1;
  return at > 0 ? { volume: id.slice(0, at), path: id.slice(at + 1) } : null;
}

export function playedRow(positions, track) {
  if (!positions || !track?.folder || !track.path) return null;
  const row = positions.get(positionKey(track.folder, track.path));
  return row && (!track.hash || !row.hash || row.hash === track.hash) ? row : null;
}

export function savedPosition(positions, track) {
  const row = playedRow(positions, track);
  return row && !isFinished(row) ? row : null;
}

export function shouldSave({ position, duration, seeking = false, force = false, now, last = 0 }) {
  if (seeking || !(duration >= RESUME_MIN_SECONDS)) return false;
  if (!(position >= RESUME_HEAD_SECONDS)) return false;
  return force || now - last >= SAVE_INTERVAL;
}

export function remember(positions, body, device, now) {
  const next = new Map(positions);
  const key = positionKey(body.volume, body.path);
  const finished = body.position >= body.duration - RESUME_TAIL_SECONDS;
  next.set(key, {
    ...body,
    ...(finished ? { position: 0, finished: true } : {}),
    device: device?.id ?? null,
    name: device?.name ?? null,
    updated: now,
  });
  return next;
}

export function timeLeft(seconds) {
  const minutes = Math.max(1, Math.round(Math.max(0, seconds) / 60));
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left`
    : `${minutes} min left`;
}

export function fraction(position, duration) {
  return duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
}

export function resumeCandidate(positions, library, volume, playingId = null, accept = () => true) {
  if (!positions || !library) return null;
  const rows = [...positions.values()]
    .filter((row) => row.volume === volume && !isFinished(row))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  for (const row of rows) {
    const id = `${row.volume}:${row.path}`;
    const track = library.tracks.get(id);
    if (id === playingId || !track || !accept(track) || (track.hash && row.hash && track.hash !== row.hash)) continue;
    return { row, track };
  }
  return null;
}

export const END_SLACK_MS = 3000;

export function positionToSave(before, next) {
  if (before.id && before.id !== next.id) {
    if (!(before.duration >= RESUME_MIN_SECONDS * 1000)) return null;
    const ended = before.duration - before.position <= END_SLACK_MS;
    return { snapshot: ended ? { ...before, position: before.duration } : before, force: true };
  }
  if (next.id && before.id === next.id && before.playing && !next.playing)
    return { snapshot: next.ended ? { ...next, position: next.duration } : next, force: true };
  return next.id && next.playing ? { snapshot: next, force: false } : null;
}
