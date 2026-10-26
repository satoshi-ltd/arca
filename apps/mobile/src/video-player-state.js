import { MIN_POSITION, SAVE_EVERY, UP_NEXT_COUNTDOWN, UP_NEXT_SECONDS } from "./video-library.js";

export const CONTROLS_HIDE = 3000;

export function initialPlayer(now = 0, position = 0) {
  return { position: Math.max(0, Number(position) || 0), duration: 0, playing: false, savedAt: now, saved: null, upNext: null, cancelled: false, ended: false };
}

function save(state, now, effects) {
  if (state.position < MIN_POSITION && !state.saved) return state;
  const key = `${Math.round(state.position)}/${Math.round(state.duration)}`;
  if (key === state.saved) return { ...state, savedAt: now };
  effects.push({ type: "save", position: state.position, duration: state.duration });
  return { ...state, savedAt: now, saved: key };
}

export function playerStep(state, event, hasNext = false) {
  const effects = [];
  const now = event.now ?? 0;
  let next = state;
  if (event.type === "tick") {
    const elapsed = Math.max(0, now - (state.tickAt ?? now));
    next = {
      ...state,
      tickAt: now,
      position: Number.isFinite(event.position) ? Math.max(0, event.position) : state.position,
      duration: Number.isFinite(event.duration) && event.duration > 0 ? event.duration : state.duration,
      playing: !!event.playing,
    };
    if (next.playing && now - next.savedAt >= SAVE_EVERY) next = save(next, now, effects);
    const remaining = next.duration - next.position;
    if (hasNext && !next.cancelled && next.duration > UP_NEXT_SECONDS * 2 && remaining <= UP_NEXT_SECONDS) {
      if (!next.upNext) next = { ...next, upNext: { deadline: now + UP_NEXT_COUNTDOWN } };
      else if (!next.playing) next = { ...next, upNext: { deadline: next.upNext.deadline + elapsed } };
      else if (now >= next.upNext.deadline) {
        next = save({ ...next, upNext: null, cancelled: true }, now, effects);
        effects.push({ type: "next" });
      }
    } else if (next.upNext && remaining > UP_NEXT_SECONDS) next = { ...next, upNext: null };
  } else if (event.type === "pause" || event.type === "exit") {
    const position = Number.isFinite(event.position) && event.position > 0 ? event.position : state.position;
    next = save({ ...state, position, playing: false, ...(event.type === "exit" ? { upNext: null } : {}) }, now, effects);
  } else if (event.type === "ended") {
    next = save({ ...state, position: state.duration || state.position, playing: false, ended: true }, now, effects);
    if (hasNext && !state.cancelled) {
      next = { ...next, upNext: null, cancelled: true };
      effects.push({ type: "next" });
    }
  } else if (event.type === "cancel") {
    next = { ...state, upNext: null, cancelled: true };
  } else if (event.type === "playNext") {
    next = save({ ...state, upNext: null, cancelled: true }, now, effects);
    effects.push({ type: "next" });
  } else if (event.type === "seek") {
    next = { ...state, position: Math.max(0, event.position), cancelled: event.position < state.duration - UP_NEXT_SECONDS ? false : state.cancelled, upNext: null };
  }
  return { state: next, effects };
}

export function countdown(state, now) {
  return state.upNext ? Math.max(0, Math.ceil((state.upNext.deadline - now) / 1000)) : null;
}

export function seekTarget(position, duration, delta) {
  const target = position + delta;
  return Math.max(0, duration > 0 ? Math.min(duration, target) : target);
}

export function scrubAction(name, position, duration) {
  if (name === "increment") return seekTarget(position, duration, 30);
  if (name === "decrement") return seekTarget(position, duration, -10);
  return null;
}

export function clock(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
