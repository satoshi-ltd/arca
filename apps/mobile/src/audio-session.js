import { useCallback, useEffect, useRef, useState } from "react";
import { native } from "./private-network";
import { parseTrackNode } from "./music-library.js";
import { player, playerAvailable } from "./music-player";
import {
  SAVE_INTERVAL,
  positionToSave,
  positionMap,
  remember,
  shouldSave,
  trackFile,
} from "./audio-positions.js";
import { SLEEP_OFF, sleepCheck, startSleep } from "./sleep-timer.js";

const SEEK_SETTLE = 2000;

export function useAudioSession({ enabled, api, device, lookup }) {
  const [positions, setPositions] = useState(() => new Map());
  const [sleep, setSleepState] = useState(SLEEP_OFF);
  const live = useRef({ id: null, position: 0, duration: 0, playing: false });
  const lastSaved = useRef(0);
  const seekingUntil = useRef(0);
  const sleepRef = useRef(SLEEP_OFF);
  const deps = useRef({ api, device, lookup });
  deps.current = { api, device, lookup };

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const { positions: rows } = await deps.current.api("/v1/audio-positions");
      setPositions(positionMap(rows));
    } catch {}
  }, [enabled]);

  const save = useCallback(async (snapshot, force) => {
    const node = parseTrackNode(snapshot.id);
    const file = trackFile(node?.track);
    const duration = snapshot.duration / 1000;
    const position = snapshot.position / 1000;
    const now = Date.now();
    if (!file || !shouldSave({ position, duration, force, now, last: lastSaved.current, seeking: now < seekingUntil.current }))
      return;
    lastSaved.current = now;
    const info = await deps.current.lookup(node.track).catch(() => null);
    if (!info?.hash) return;
    const body = { volume: file.volume, path: file.path, hash: info.hash, position, duration };
    setPositions((known) => remember(known, body, deps.current.device, now));
    deps.current.api("/v1/audio-position", body).catch(() => {});
  }, []);

  const observe = useCallback(
    (state) => {
      if (!state) return;
      const before = live.current;
      const next = {
        id: state.id ?? null,
        position: state.position || 0,
        duration: state.duration || 0,
        playing: !!state.playing,
        ended: !!state.ended,
      };
      live.current = next;
      const plan = positionToSave(before, next);
      if (plan) save(plan.snapshot, plan.force);
    },
    [save],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    if (!playerAvailable) return undefined;
    let active = true;
    const subscription = native.addListener("musicState", (state) => active && observe(state));
    player.command("state").then((state) => active && observe(state), () => {});
    const poll = setInterval(() => {
      if (live.current.playing || sleepRef.current.mode !== "off")
        player.command("state").then((state) => active && observe(state), () => {});
    }, 1000);
    return () => {
      active = false;
      subscription.remove();
      clearInterval(poll);
    };
  }, [enabled, observe, refresh]);

  useEffect(() => {
    if (!enabled || sleep.mode === "off") return undefined;
    const tick = setInterval(() => {
      const now = Date.now();
      const state = live.current;
      const track = parseTrackNode(state.id)?.track || null;
      const step = sleepCheck(sleepRef.current, now, { ...state, track });
      if (step === "near") sleepRef.current = { ...sleepRef.current, near: true };
      if (step !== "due" && step !== "cancel") return;
      sleepRef.current = SLEEP_OFF;
      setSleepState(SLEEP_OFF);
      if (step === "cancel") return;
      const snapshot = { ...state };
      const pause = state.playing ? player.command("toggle") : Promise.resolve();
      pause.then(() => save(snapshot, true), () => {});
    }, 1000);
    return () => clearInterval(tick);
  }, [enabled, sleep, save]);

  const setSleep = useCallback((value) => {
    const track = parseTrackNode(live.current.id)?.track || null;
    const timer = value === "off" ? SLEEP_OFF : startSleep(value, Date.now(), track);
    sleepRef.current = timer;
    setSleepState(timer);
  }, []);

  const seeked = useCallback(() => {
    seekingUntil.current = Date.now() + SEEK_SETTLE;
    lastSaved.current = Date.now() - SAVE_INTERVAL + SEEK_SETTLE;
  }, []);

  return { positions, refresh, sleep, setSleep, seeked };
}

export function useNow(active, every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [active, every]);
  return now;
}
