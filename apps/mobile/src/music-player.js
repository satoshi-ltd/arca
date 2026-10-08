import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { native } from "./private-network";

export const playerAvailable =
  Platform.OS === "android" && typeof native.musicPlay === "function";

export const player = {
  play: (context, track, shuffle = false, position = -1) =>
    native.musicPlay(context, track, shuffle, position),
  command: (name, value = 0) => native.musicCommand(name, value),
  reload: async () => {
    if (typeof native.musicReload === "function") await native.musicReload();
  },
  renameHistory: (from, to) => native.musicRenameHistory(from, to),
};

export function usePlayingId(enabled) {
  const [id, setId] = useState(null);
  useEffect(() => {
    if (!enabled || !playerAvailable) return undefined;
    let active = true;
    const update = (value) => active && setId(value?.id ?? null);
    const subscription = native.addListener("musicState", update);
    player.command("state").then(update, () => {});
    return () => {
      active = false;
      subscription.remove();
    };
  }, [enabled]);
  return id;
}

export function useMusicPlayer(enabled) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!enabled || !playerAvailable) return undefined;
    let active = true;
    const update = (value) => active && setState(value);
    const subscription = native.addListener("musicState", update);
    player.command("state").then(update, () => {});
    return () => {
      active = false;
      subscription.remove();
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !playerAvailable || !state?.playing) return undefined;
    const timer = setInterval(
      () => player.command("state").then(setState, () => {}),
      1000,
    );
    return () => clearInterval(timer);
  }, [enabled, state?.playing]);
  return [state, setState];
}
