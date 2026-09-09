// Directories have metadata and revisions, but no content object.
export const entryKey = (row) =>
  row?.deleted ? null : row?.directory ? "directory" : (row?.hash ?? null);
export const directoryItem = () => ({ directory: 1, hash: null, size: 0 });
