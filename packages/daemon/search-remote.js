import { replicaLibrary } from "./video-routes.js";
import { streamedLibrary } from "./music-routes.js";

const FRESH_MS = 30000;
const RETRY_MS = 5000;
const WAIT_MS = 4000;

async function refresh(engine, s, volume, kind, state) {
  try {
    const load = kind === "video" ? replicaLibrary : streamedLibrary;
    state.value = await load({ engine, s }, volume, null, AbortSignal.timeout(WAIT_MS));
    state.at = Date.now();
  } catch {
    state.at = Date.now() - FRESH_MS + RETRY_MS;
  }
}

export async function remoteLibraries(engine, s) {
  if (engine.config.role === "hub") return null;
  const states = (engine.searchRemote ||= new Map());
  const wanted = [];
  const modes = s.mediaModes();
  const kept = new Set(s.volumes().filter((v) => v.selected).map((v) => v.id));
  for (const row of engine.config.catalog || []) {
    if (row.video && (modes[row.id] || kept.has(row.id))) wanted.push({ volume: row.id, kind: "video" });
    else if (row.music && modes[row.id] === "stream") wanted.push({ volume: row.id, kind: "music" });
  }
  await Promise.all(
    wanted.map(async ({ volume, kind }) => {
      let state = states.get(volume);
      if (!state || state.kind !== kind) {
        state = { kind, at: 0, value: null, pending: null };
        state.source = { library: () => state.value };
        states.set(volume, state);
      }
      if (Date.now() - state.at < FRESH_MS) return;
      state.pending ||= refresh(engine, s, volume, kind, state).finally(() => {
        state.pending = null;
      });
      if (state.value) return;
      state.first ||= state.pending;
      if (state.pending === state.first) await state.pending;
    }),
  );
  return new Map(wanted.filter(({ volume }) => states.get(volume).value).map(({ volume }) => [volume, states.get(volume)]));
}
