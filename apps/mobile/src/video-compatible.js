export const COMPATIBLE_AUDIO = new Set(["ac3", "eac3", "dts", "dca", "truehd", "mlp"]);
export const SEEK_DELAY = 300;
export const SEEK_BEHIND = 9 * 60;

export function audioTrackOf(item, audio = null) {
  const tracks = Array.isArray(item?.audioTracks) ? item.audioTracks : [];
  if (audio != null) {
    const chosen = tracks.find((track) => track.stream === audio);
    if (chosen) return chosen;
  }
  return tracks.find((track) => track.default) || tracks[0] || (item?.audioCodec ? { stream: 0, codec: item.audioCodec } : null);
}

export function needsCompatible(item, audio = null) {
  const track = audioTrackOf(item, audio);
  return !!track && COMPATIBLE_AUDIO.has(String(track.codec || "").toLowerCase());
}

export function audioForLanguage(item, language, same) {
  if (!language) return null;
  const tracks = Array.isArray(item?.audioTracks) ? item.audioTracks : [];
  return tracks.find((track) => same(track.language, language))?.stream ?? null;
}

export function compatibleRoute(volume, item, start = 0, audio = null) {
  return `/v1/video/compatible?${new URLSearchParams({
    volume,
    path: item.path,
    hash: item.hash,
    start: String(Math.max(0, Math.floor(start || 0))),
    ...(audio != null ? { audio: String(audio) } : {}),
  })}`;
}

export function absoluteTime(source, currentTime) {
  return (source?.offset || 0) + (Number.isFinite(currentTime) ? currentTime : 0);
}

export function fullDuration(source, item, playerDuration) {
  if (source?.compatible) return source.duration || item?.duration || 0;
  return playerDuration || item?.duration || 0;
}

export function recoveryPlan({ compatible, fellBack, retried, networkLeft }) {
  if (networkLeft) return null;
  if (!compatible) return fellBack ? null : "fallback";
  return retried ? null : "retry";
}

export function seekPlan(source, target, { duration = 0, buffered = 0, currentTime = 0, produced = 0 } = {}) {
  if (!source?.compatible) return { local: true, time: target };
  const offset = source.offset || 0;
  const finite = (value) => (Number.isFinite(value) ? value : 0);
  const end = offset + Math.max(finite(duration), finite(buffered), finite(currentTime), finite(produced));
  const pruned = offset + finite(currentTime) - SEEK_BEHIND;
  if (target >= offset && target >= pruned && target <= end) return { local: true, time: target - offset };
  return { local: false, start: target };
}

export function createRestarter(run, { delay = SEEK_DELAY, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer = null;
  let generation = 0;
  return {
    request(target, extra = {}) {
      if (timer) cancel(timer);
      const id = ++generation;
      timer = schedule(() => {
        timer = null;
        run({ start: target, ...extra }, () => id === generation);
      }, delay);
    },
    now(request) {
      if (timer) cancel(timer);
      timer = null;
      const id = ++generation;
      return run(request, () => id === generation);
    },
    pending() {
      return !!timer;
    },
    stop() {
      if (timer) cancel(timer);
      timer = null;
      generation++;
    },
  };
}
