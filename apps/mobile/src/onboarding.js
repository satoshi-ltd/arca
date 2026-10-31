import { count } from "./format.js";
import { isMusicFolder } from "./music-sync.js";
import { isVideoFolder } from "./video-sync.js";
export const mediaKind = (catalog, volume, audioStreams) =>
  isVideoFolder(catalog, volume.id) ? "video" : audioStreams && isMusicFolder(catalog, volume.id) ? "audio" : null;
export const defaultMode = (kind) => (kind === "video" ? "stream" : "keep");
export const downloadBytes = (folders, modes) =>
  folders.filter((v) => modes[v.id] !== "stream").reduce((sum, v) => sum + (v.bytes || 0), 0);
export function startLabel(folders, modes) {
  if (!folders.length) return { label: "Choose folders", icon: null };
  if (folders.every((v) => modes[v.id] === "stream")) return { label: "Start streaming", icon: "play" };
  return { label: `Start syncing ${count(folders.length, "folder", "folders")}`, icon: "refresh" };
}
export async function selectFirstFolders(replica, catalog, ids, modes = {}) {
  const selected = [...new Set(ids)].map((id) =>
    catalog.volumes.find((v) => v.id === id),
  );
  if (
    !selected.length ||
    selected.some(
      (v) =>
        !v || v.policyError || !Number.isSafeInteger(v.bytes) || v.bytes < 0,
    )
  )
    throw new Error("Refresh the hub folders and choose available folders.");
  await replica.space(downloadBytes(selected, modes));
  for (const volume of selected) {
    if (modes[volume.id] !== "stream") await replica.select(volume);
    else if (isVideoFolder(catalog, volume.id)) await replica.streamVideo(volume);
    else await replica.streamMusic(volume);
  }
  await replica.store.set("onboarding", null);
}
