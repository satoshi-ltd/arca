// Fixed sync policy shared by the daemon and mobile engines, independent of UI.
// Names that may be user content (cache/, build/, logs/, *.lock, .env) never belong here: this list cannot be re-included.
const systemMetadata = [
  ".ds_store",
  ".localized",
  "icon\r",
  "thumbs.db",
  "ehthumbs.db",
  "desktop.ini",
  ".directory",
];
const systemFolders = [
  ".appledouble",
  ".spotlight-v100",
  ".fseventsd",
  ".documentrevisions-v100",
  ".temporaryitems",
  "system volume information",
  "lost+found",
];
const trash = [".trash", ".trashes", "$recycle.bin", "#recycle", "@recycle"];
const nas = ["@eadir", "#snapshot", ".@__thumb"];
const otherSyncTools = [
  ".stfolder",
  ".stversions",
  ".dropbox",
  ".dropbox.attr",
  ".dropbox.cache",
];
const caches = [
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".cache",
  ".gradle",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".expo",
  ".dart_tool",
  ".terraform",
];
const appSettings = [".obsidian"];
const names = new Set([
  ...systemMetadata,
  ...systemFolders,
  ...trash,
  ...nas,
  ...otherSyncTools,
  ...caches,
  ...appSettings,
]);
const patterns = [
  /^\._/,
  /^\.trash-/,
  /^\.fuse_hidden/,
  /^\.nfs/,
  /^\.sync_.*\.db/,
  /^~\$/,
  /^\.~lock\..*#$/,
  /^\.#/,
  /^#.+#$/,
  /\.(tmp|swp|swo|crdownload|part|partial|download|pid|pyc)$/,
  /~$/,
];
const disposable = new Set(systemMetadata);

export const FIXED_POLICY = [
  ...names,
  ...patterns.map(String),
  ".m2/repository",
].join("\n");

const excludedName = (part) =>
  names.has(part) || patterns.some((pattern) => pattern.test(part));

// Only OS metadata is disposable; temporaries, caches and .git may belong to live work and are never deleted.
export const disposableMetadata = (name) => {
  const key = name.toLowerCase();
  return disposable.has(key) || key.startsWith("._");
};

export function builtinExcluded(name) {
  const parts = name.toLowerCase().split("/");
  return parts.some(
    (part, i) =>
      excludedName(part) || (part === "repository" && parts[i - 1] === ".m2"),
  );
}
