// Renaming changes only the final component, never the containing folder.
export function renamedPath(current, name) {
  if (typeof name !== "string" || !name || /[/\\]/.test(name))
    throw new Error("Enter a filename without folder separators.");
  name = name.normalize("NFC");
  const prefix = current.slice(0, current.lastIndexOf("/") + 1);
  if (current === ".arcaignore" || prefix + name === ".arcaignore")
    throw new Error(
      "Edit .arcaignore through the folder’s exclusion settings.",
    );
  return prefix + name;
}
