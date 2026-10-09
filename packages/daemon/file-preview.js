import fs from "node:fs";
import { fail } from "./storage.js";

const TEXT = /\.(txt|md|markdown|mdx|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|sh|bash|zsh|sql|env|gitignore|arcaignore)$/i;
const BYTES = 4096;
const LINES = 24;

export const isTextName = (name) => TEXT.test(name);

export function filePreview(store, volume, name, hash) {
  const folder = store.volume(volume);
  if (store.config.role !== "hub" && !folder.selected)
    fail("Select this folder first", 403);
  const row = store.viewCurrent(volume, name);
  if (
    !row ||
    row.deleted ||
    row.directory ||
    row.hash !== hash ||
    store.visibleRules(volume)(name, false)
  )
    fail("This file is no longer available", 404);
  if (!isTextName(name)) return { kind: "none" };
  const source = store.localContent(volume, name, hash);
  if (!source) return { kind: "none", missing: true };
  const handle = fs.openSync(source, "r");
  let buffer;
  let read;
  try {
    buffer = Buffer.alloc(BYTES);
    read = fs.readSync(handle, buffer, 0, BYTES, 0);
  } finally {
    fs.closeSync(handle);
  }
  const bytes = buffer.subarray(0, read);
  if (bytes.includes(0)) return { kind: "none" };
  const cutBytes = row.size > read;
  let text = bytes.toString("utf8");
  if (cutBytes) text = text.replace(/\uFFFD$/, "");
  const lines = text.split(/\r\n|\r|\n/);
  if (!cutBytes && lines.at(-1) === "") lines.pop();
  return { kind: "text", lines: lines.slice(0, LINES), truncated: cutBytes || lines.length > LINES, size: row.size };
}
