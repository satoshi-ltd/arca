import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { native } from "./private-network";
import { player, playerAvailable } from "./music-player";
import { forget, positionSignature } from "./audio-positions.js";
import { drainOutbox } from "./audio-outbox.js";
import { adoptPositions, mergeHubPositions, queuedKeys, queuedRows, savedRows, singleFlight, startPositionRefresh } from "./audio-refresh.js";
import { SLEEP_OFF, sameSleep, sleepFromState } from "./sleep-timer.js";

const DRAIN_INTERVAL = 5000;

export function useAudioSession({ enabled, watching = false, api, device, scope, cache }) {
  const [positions, setPositions] = useState(() => new Map());
  const [loaded, setLoaded] = useState("");
  const [sleep, setSleepState] = useState(SLEEP_OFF);
  const latest = useRef({ playing: false, sleeping: false });
  const draining = useRef(false);
  const restored = useRef(false);
  const queued = useRef(null);
  const [ready, setReady] = useState(false);
  const known = useRef(positions);
  const deps = useRef({ api, device, scope, cache });
  deps.current = { api, device, scope, cache };

  const apply = useCallback((change) => {
    const next = change(known.current);
    if (next !== known.current) {
      known.current = next;
      setPositions(next);
    }
    return next;
  }, []);

  const read = useRef(null);
  read.current ||= singleFlight(async () => {
    try {
      const { positions: rows, finished } = await deps.current.api("/v1/audio-positions");
      const next = apply((current) => mergeHubPositions(current, rows, finished, deps.current.device.id, queued.current));
      setLoaded(positionSignature(next));
    } catch {}
  });
  const refresh = useCallback(() => (enabled ? read.current() : Promise.resolve()), [enabled]);

  const restore = useCallback(async () => {
    try {
      const saved = await deps.current.cache?.read();
      const next = apply((current) => adoptPositions(current, savedRows(saved, deps.current.device.id)));
      if (next.size) setLoaded(positionSignature(next));
    } catch {}
    restored.current = true;
  }, [apply]);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      await drainOutbox({
        scope: deps.current.scope(),
        read: async (scope) => {
          const pending = await player.outbox(scope);
          queued.current = queuedKeys(pending.entries);
          apply((current) => adoptPositions(current, queuedRows(pending.entries, deps.current.device)));
          return pending;
        },
        acknowledge: player.acknowledge,
        send: (body) => deps.current.api("/v1/audio-position", body),
      });
    } catch {
    } finally {
      draining.current = false;
    }
  }, [apply]);

  const clear = useCallback(
    async (row) => {
      const at = Date.now();
      const answer = await deps.current.api("/v1/audio-position/clear", { volume: row.volume, path: row.path, hash: row.hash, at });
      if (answer?.cleared === false) return read.current();
      apply((current) => forget(current, row, deps.current.device, at));
    },
    [apply],
  );

  const observe = useCallback((state) => {
    if (!state) return;
    const next = sleepFromState(state);
    latest.current = { playing: !!state.playing, sleeping: next.mode !== "off" };
    setSleepState((known) => (sameSleep(known, next) ? known : next));
  }, []);

  useEffect(() => {
    if (!restored.current || deps.current.device.id == null) return;
    deps.current.cache?.write({ device: deps.current.device.id, rows: [...positions.values()] })?.catch(() => {});
  }, [positions]);

  useEffect(() => {
    if (!enabled) {
      restored.current = false;
      queued.current = null;
      setReady(false);
      apply((current) => (current.size ? new Map() : current));
      return undefined;
    }
    let active = true;
    restore().then(async () => {
      if (!active) return;
      if (playerAvailable) await drain();
      if (!active) return;
      setReady(true);
      refresh();
    });
    if (!playerAvailable)
      return () => {
        active = false;
      };
    const read = () => player.command("state").then((state) => active && observe(state), () => {});
    const subscription = native.addListener("musicState", (state) => active && observe(state));
    const watch = AppState.addEventListener("change", (state) => {
      if (state === "active") drain();
    });
    read();
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
  }, [enabled, observe, refresh, drain, restore, apply]);

  useEffect(() => {
    if (!enabled || !watching || !ready) return undefined;
    return startPositionRefresh({
      refresh,
      foreground: () => AppState.currentState === "active",
      onForeground: (run) => {
        const watch = AppState.addEventListener("change", (state) => {
          if (state === "active") run();
        });
        return () => watch.remove();
      },
    });
  }, [enabled, watching, ready, refresh]);

  const setSleep = useCallback(
    (value) => {
      player.sleep(value).then(observe, () => {});
    },
    [observe],
  );

  return { positions, loaded, refresh, clear, sleep, setSleep };
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
