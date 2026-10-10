import { fail } from "./storage.js";

export const RESUME_MIN_SECONDS = 1200;
export const RESUME_TAIL_SECONDS = 60;
export const RESUME_HEAD_SECONDS = 10;

export function savePosition(store, owner, body) {
  const { volume, path, hash } = body;
  if (typeof volume !== "string" || typeof path !== "string" || typeof hash !== "string")
    fail("Invalid audio position");
  const position = Number(body.position);
  const duration = Number(body.duration);
  if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration <= 0)
    fail("Invalid audio position");
  store.volume(volume);
  if (duration < RESUME_MIN_SECONDS) return { kept: false };
  const at = Math.min(Math.floor(Number(body.at) || Date.now()), Date.now() + 60000);
  const known = store.db
    .prepare("SELECT updated FROM audio_positions WHERE volume=? AND path=?")
    .get(volume, path);
  if (known && known.updated >= at) return { kept: false };
  if (position < RESUME_HEAD_SECONDS) return { kept: false };
  if (position >= duration - RESUME_TAIL_SECONDS) {
    store.db
      .prepare("INSERT OR REPLACE INTO audio_positions VALUES(?,?,?,0,?,?,?,?)")
      .run(volume, path, hash, duration, owner.id, owner.name, at);
    return { kept: false, cleared: true };
  }
  store.db
    .prepare("INSERT OR REPLACE INTO audio_positions VALUES(?,?,?,?,?,?,?,?)")
    .run(volume, path, hash, position, duration, owner.id, owner.name, at);
  return { kept: true };
}

export function listPositions(store) {
  const rows = store.db
    .prepare("SELECT volume,path,hash,position,duration,device,name,updated FROM audio_positions ORDER BY updated DESC")
    .all();
  return {
    positions: rows.filter((row) => row.position > 0),
    finished: rows.filter((row) => row.position === 0).map(({ volume, path, hash, updated }) => ({ volume, path, hash, updated })),
  };
}

export function mergePositions(hub, queued) {
  const byFile = new Map();
  const rows = [
    ...(hub.positions || []),
    ...(hub.finished || []).map((row) => ({ ...row, finished: true })),
    ...queued.map((row) => (row.position >= row.duration - RESUME_TAIL_SECONDS ? { ...row, finished: true } : row)),
  ];
  for (const row of rows)
    if (!byFile.has(`${row.volume}\0${row.path}`) || byFile.get(`${row.volume}\0${row.path}`).updated < row.updated)
      byFile.set(`${row.volume}\0${row.path}`, row);
  const newest = [...byFile.values()].sort((a, b) => b.updated - a.updated);
  return {
    positions: newest.filter(
      (row) => !row.finished && row.position >= RESUME_HEAD_SECONDS && row.position < row.duration - RESUME_TAIL_SECONDS,
    ),
    finished: newest.filter((row) => row.finished).map(({ volume, path, hash, updated }) => ({ volume, path, hash, updated })),
  };
}
