export const FOLDER_SECTIONS = [
  { kind: "folders", label: "FOLDERS" },
  { kind: "photos", label: "PHOTOS" },
  { kind: "audio", label: "AUDIO" },
  { kind: "video", label: "MOVIES & TV" },
];

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
export const nameOrder = (a, b) => collator.compare(a ?? "", b ?? "");

export function folderSections(folders, kindOf) {
  return FOLDER_SECTIONS.map((section) => ({
    ...section,
    folders: folders
      .filter((folder) => kindOf(folder) === section.kind)
      .sort((a, b) => nameOrder(a.name, b.name)),
  })).filter((section) => section.folders.length);
}

export function folderStatus({ paused, issue, offline, connected, syncing, completed, pending, cycle }) {
  if (paused) return "Paused";
  if (issue) return "Needs attention";
  if (offline) return "Offline";
  if (!connected) return "Disconnected";
  if (syncing) return "Syncing";
  if (!completed) return cycle ? "Waiting" : "Not yet synced";
  return pending ? "Incomplete" : "Up to date";
}
const QUIET_STATES = ["Paused", "Offline", "Disconnected"];
export function folderState({ status, conflict }) {
  if (status === "Syncing") return { tone: null, word: null, icon: null };
  if (status === "Needs attention") return { tone: "danger", word: status, icon: "alert" };
  if (conflict) return { tone: "warning", word: "Conflict", icon: "conflict" };
  if (QUIET_STATES.includes(status)) return { tone: "neutral", word: status, icon: null };
  if (status && status !== "Up to date") return { tone: null, word: status, icon: null };
  return { tone: null, word: null, icon: null };
}
export function machineTone(state) {
  if (["Needs attention", "Removed"].includes(state)) return "danger";
  if (QUIET_STATES.includes(state)) return "neutral";
  return null;
}
export function historyTone(row) {
  if (row.deleted) return "neutral";
  if (row.path.includes(".conflict-") && !row.resolved) return "warning";
  return null;
}
export const historyPath = (path) => {
  const cut = path.lastIndexOf("/");
  return { name: path.slice(cut + 1), dir: path.slice(0, Math.max(cut, 0)) };
};
export const historyCaption = (row, size) =>
  row.deleted
    ? "Deleted · recoverable"
    : row.path.includes(".conflict-")
      ? row.resolved
        ? "Conflict resolved · copy kept"
        : "Conflict copy retained"
      : size;
const DEVICE_WARNINGS = ["Paused", "Offline", "Disconnected"];
export const deviceLabel = (name, device) => [name, "Replica", device.word, device.last].filter(Boolean).join(", ");

export const hubChecking = (replica) => !!(replica.checking && replica.busy);
export const pullHeld = ({ busy, checking }) => !!(busy || checking);

export function deviceStatus({ connected, paused, offline, checking, busy, error, last }, when) {
  const word = !connected
    ? "Disconnected"
    : paused
      ? "Paused"
      : offline
        ? "Offline"
        : error
          ? "Needs attention"
          : checking
            ? "Checking hub…"
            : busy
              ? "Syncing"
              : last
                ? "Up to date"
                : "Not synced yet";
  const tone = word === "Needs attention" ? "danger" : DEVICE_WARNINGS.includes(word) ? "warning" : null;
  return { word, tone, last: last ? `Last sync ${when(last)}` : "" };
}
