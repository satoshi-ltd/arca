import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { native } from "./private-network";
import { player, playerAvailable } from "./music-player";
import { positionMap, positionSignature, remember } from "./audio-positions.js";
import { drainOutbox } from "./audio-outbox.js";
import { SLEEP_OFF, sameSleep, sleepFromState } from "./sleep-timer.js";

const DRAIN_INTERVAL = 5000;

export function useAudioSession({ enabled, api, device, scope }) {
  const [positions, setPositions] = useState(() => new Map());
  const [loaded, setLoaded] = useState("");
  const [sleep, setSleepState] = useState(SLEEP_OFF);
  const latest = useRef({ playing: false, sleeping: false });
  const draining = useRef(false);
  const deps = useRef({ api, device, scope });
  deps.current = { api, device, scope };

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const { positions: rows, finished } = await deps.current.api("/v1/audio-positions");
      const next = positionMap(rows, finished);
      setPositions(next);
      setLoaded(positionSignature(next));
    } catch {}
  }, [enabled]);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      const sent = await drainOutbox({
        scope: deps.current.scope(),
        read: player.outbox,
        acknowledge: player.acknowledge,
        send: (body) => deps.current.api("/v1/audio-position", body),
      });
      if (sent.length)
        setPositions((known) =>
          sent.reduce((next, entry) => remember(next, entry, deps.current.device, entry.at), known),
        );
    } catch {
    } finally {
      draining.current = false;
    }
  }, []);

  const observe = useCallback((state) => {
    if (!state) return;
    const next = sleepFromState(state);
    latest.current = { playing: !!state.playing, sleeping: next.mode !== "off" };
    setSleepState((known) => (sameSleep(known, next) ? known : next));
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    if (!playerAvailable) return undefined;
    let active = true;
    const read = () => player.command("state").then((state) => active && observe(state), () => {});
    const subscription = native.addListener("musicState", (state) => active && observe(state));
    const watch = AppState.addEventListener("change", (state) => {
      if (state === "active") drain();
    });
    read();
    drain();
    const poll = setInterval(() => {
      if (latest.current.playing || latest.current.sleeping) read();
    }, 1000);
    const flush = setInterval(drain, DRAIN_INTERVAL);
    return () => {
      active = false;
      subscription.remove();
      watch.remove();
      clearInterval(poll);
      clearInterval(flush);
    };
  }, [enabled, observe, refresh, drain]);

  const setSleep = useCallback(
    (value) => {
      player.sleep(value).then(observe, () => {});
    },
    [observe],
  );

  return { positions, loaded, refresh, sleep, setSleep };
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
