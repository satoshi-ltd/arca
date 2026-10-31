import { bytes, count, fileCount } from "./format.js";

const baseName = (path) => String(path).split("/").pop();

const hubLine = (pending) =>
  pending == null
    ? "Files not yet on the hub could not be counted."
    : pending
      ? `${fileCount(pending)} not yet on the hub.`
      : "Everything is on the hub.";

export const deleteFile = (name, unsynced, offline) => ({
  title: `Delete “${baseName(name)}”?`,
  message:
    (unsynced
      ? "Its latest changes have not reached the hub, so this cannot be undone."
      : "Deletes from all synced copies. Retained history can be restored.") +
    (offline ? " Deletion will sync when connected and resumed." : ""),
  label: "Delete file",
  icon: "trash",
  destructive: true,
});

export const deleteTrack = (title, offline) => ({
  title: `Delete “${title}”?`,
  message:
    "It is removed from every device. History keeps it for the folder's retention and you can restore it from History." +
    (offline ? " Deletion will sync when connected and resumed." : ""),
  label: "Delete track",
  icon: "trash",
  destructive: true,
});

export const deletePlaylist = (name, unsynced, offline) => ({
  title: `Delete “${name}”?`,
  message:
    (unsynced
      ? "Its latest changes have not reached the hub, so this cannot be undone."
      : "Deletes it from all synced copies. Retained history can be restored.") +
    (offline ? " Deletion will sync when connected and resumed." : ""),
  label: "Delete playlist",
  icon: "trash",
  destructive: true,
});

export const deletePhotos = (items) => {
  const many = Array.isArray(items) && items.length !== 1;
  const total = Array.isArray(items) ? items.length : 1;
  return {
    title: many ? `Delete ${count(total, "photo", "photos")}?` : "Delete this photo?",
    message:
      "Deletes the selected photos and their Live Photo resources from the shared gallery for everyone. Originals stay in Photos. Recovery depends on this folder’s version retention.",
    label: many ? `Delete ${count(total, "photo", "photos")}` : "Delete photo",
    icon: "trash",
    destructive: true,
  };
};

export const restoreVersion = (row, when) => ({
  title: `Restore “${baseName(row.path)}”?`,
  message: `The hub creates a new version from the one saved ${when} (rev ${row.rev}). It will synchronize to every selected copy.`,
  label: "Restore",
  icon: "restore",
  destructive: false,
});

export const disconnectHub = () => ({
  title: "Disconnect from hub?",
  message: "Local files are kept. A new pairing code will be required to reconnect.",
  label: "Disconnect",
  icon: "unplug",
  destructive: true,
});

export const stopSyncing = ({ name, files, size, pending, sourceOnly }) => ({
  title: `Stop syncing “${name}”?`,
  message:
    `${Number.isFinite(files) ? `${fileCount(files)} · ` : ""}${bytes(size)} on this phone will be deleted; ${hubLine(pending)} ` +
    (sourceOnly
      ? "Stops photo uploads and removes this folder’s Arca copy and album link. Originals in Photos, hub files and history are kept. Unsynced local changes will be lost; export the folder first to keep them."
      : "Removes this folder’s copy from this phone. Hub files and history are kept. Unsynced local changes will be lost; use Export folder first to keep them."),
  label: "Stop syncing and delete",
  icon: "unlink",
  destructive: true,
});

export const stopStreaming = ({ name, files, size }) => ({
  title: `Stop syncing “${name}”?`,
  message: `${files ? `${fileCount(files)} · ${bytes(size)} downloaded on this phone will be deleted. ` : ""}Stops streaming it here. Hub files and history are kept.`,
  label: files ? "Stop syncing and delete" : "Stop syncing",
  icon: "unlink",
  destructive: true,
});

export const eraseDevice = ({ folders, size, pending }) => ({
  title: "Erase this device?",
  message:
    `${count(folders, "folder", "folders")} · ${bytes(size)} on this phone will be deleted; ${hubLine(pending)} ` +
    "Permanently deletes every downloaded folder, any unsynced changes and this phone’s pairing and saved settings. The app returns to first-run setup. Hub files and history and other devices are kept. This cannot be undone. Works offline. If the hub cannot be reached, remove this device from its Devices list separately.",
  label: "Erase this device",
  icon: "trash",
  destructive: true,
});

export const deleteVideo = ({ title, season = null, unit, items }) => {
  const what = unit === "movie" ? "the file" : `${count(items.length, "episode", "episodes")}`;
  return {
    title: `Delete “${title}”${season == null ? "" : ` season ${season}`}?`,
    message: `Removes ${what} from the hub for every device and cannot be undone: Movies & TV keeps no copies or history. The download${items.length === 1 ? "" : "s"} on this device ${items.length === 1 ? "goes" : "go"} with it.`,
    label: unit === "movie" ? "Delete movie" : `Delete ${count(items.length, "episode", "episodes")}`,
    icon: "trash",
    destructive: true,
  };
};
