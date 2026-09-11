export function validPath(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 1024 ||
    name !== name.normalize("NFC")
  )
    throw new Error("Unsupported file path");
  for (const part of name.split("/"))
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[\\<>:"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) ||
      part.startsWith(".arca-")
    )
      throw new Error("Unsupported file path");
  return name;
}
export function validRow(row, volume) {
  validPath(row.path);
  if (
    row.volume !== volume ||
    !Number.isSafeInteger(row.rev) ||
    row.rev < 1 ||
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    ![0, 1, false, true].includes(row.deleted) ||
    ![undefined, 0, 1, false, true].includes(row.directory) ||
    (row.directory && (row.hash !== null || row.size !== 0)) ||
    (!row.directory && !row.deleted && !/^[a-f0-9]{64}$/.test(row.hash))
  )
    throw new Error("Invalid file metadata from hub");
  return row;
}
