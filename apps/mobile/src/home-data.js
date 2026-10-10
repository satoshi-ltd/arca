export const FOLDER_SECTIONS = [
  { kind: "folders", label: "FOLDERS" },
  { kind: "photos", label: "PHOTOS" },
  { kind: "audio", label: "AUDIO" },
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
