// Fixed sync policy shared by the daemon and mobile engines, independent of UI.
// Exact OS metadata and explicitly excluded app settings; never infer note/cache exclusions.
const systemMetadata = new Set([
  ".ds_store",
  ".localized",
  "thumbs.db",
  "desktop.ini",
  ".obsidian",
]);

export function builtinExcluded(name) {
  return name.split("/").some((part) => systemMetadata.has(part.toLowerCase()));
}
