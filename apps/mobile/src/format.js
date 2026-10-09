export const bytes = (n) =>
  n == null
    ? "Unknown"
    : n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : n < 1073741824
          ? `${(n / 1048576).toFixed(1)} MB`
          : `${(n / 1073741824).toFixed(1)} GB`;
export const unbroken = (text) =>
  text
    .split(" · ")
    .map((part) => part.replace(/ /g, "\u00a0"))
    .join(" · ");
export const folderSize = (folder) =>
  Number.isFinite(folder?.files)
    ? unbroken(`${folder.files.toLocaleString("en")} ${folder.files === 1 ? "file" : "files"} · ${bytes(folder.bytes)}`)
    : "Not counted yet";
