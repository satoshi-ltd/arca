export const ARRIVALS = 3;

export function homeFromActivity(rows, selected) {
  const allowed = new Set(selected);
  const fresh = (rows || []).filter((row) => !row.deleted && allowed.has(row.volume));
  return {
    arrivals: fresh.slice(0, ARRIVALS).map(({ volume, path, rev, created, author }) => ({
      volume,
      path,
      rev,
      created,
      author,
    })),
  };
}

export const FOLDER_SECTIONS = [
  { kind: "folders", label: "FOLDERS" },
  { kind: "photos", label: "PHOTOS" },
  { kind: "audio", label: "AUDIO" },
];

export function folderSections(folders, kindOf) {
  return FOLDER_SECTIONS.map((section) => ({
    ...section,
    folders: folders.filter((folder) => kindOf(folder) === section.kind),
  })).filter((section) => section.folders.length);
}
