import { count } from "./format.js";
import { isMusicFolder } from "./music-sync.js";
import { isVideoFolder } from "./video-sync.js";
export const mediaKind = (catalog, volume, audioStreams) =>
  isVideoFolder(catalog, volume.id) ? "video" : audioStreams && isMusicFolder(catalog, volume.id) ? "audio" : null;
export const defaultMode = (kind) => (kind === "video" ? "stream" : "keep");
export const downloadBytes = (folders, modes, sizes = {}) =>
  folders.filter((v) => modes[v.id] !== "stream").reduce((sum, v) => sum + (sizes[v.id] ?? (v.bytes || 0)), 0);
export function startLabel(folders, modes) {
  if (!folders.length) return { label: "Choose folders", icon: null };
  if (folders.every((v) => modes[v.id] === "stream")) return { label: "Start streaming", icon: "play" };
  return { label: `Start syncing ${count(folders.length, "folder", "folders")}`, icon: "refresh" };
}
export async function selectFirstFolders(replica, catalog, ids, modes = {}, platform = null) {
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
  const sizes = {};
  for (const volume of selected)
    if (isVideoFolder(catalog, volume.id) && modes[volume.id] !== "stream") sizes[volume.id] = await replica.keptBytes(volume, platform);
  await replica.space(downloadBytes(selected, modes, sizes));
  for (const volume of selected) {
    const mode = modes[volume.id] === "stream" ? "stream" : "keep";
    if (isVideoFolder(catalog, volume.id)) await replica.startVideo(volume, mode, platform);
    else if (mode === "stream") await replica.streamMusic(volume);
    else await replica.select(volume);
  }
  await replica.store.set("onboarding", null);
}
