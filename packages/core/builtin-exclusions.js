// Fixed sync policy shared by the daemon and mobile engines, independent of UI.
// Exact OS metadata names only: do not infer broad cache or document exclusions.
const systemMetadata = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

export function builtinExcluded(name) {
  return name.split("/").some((part) => systemMetadata.has(part.toLowerCase()));
}
