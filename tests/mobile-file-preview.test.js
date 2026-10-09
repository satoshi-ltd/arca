import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { HEAD_LINES, canRenderImage, headPreview, previewKind } from "../apps/mobile/src/file-preview.js";

const bytes = (text) => new TextEncoder().encode(text);

test("preview kinds follow the extension and the phone only renders formats it can decode", () => {
  assert.equal(previewKind("a/b.PNG"), "image");
  assert.equal(previewKind("clip.mov"), "video");
  assert.equal(previewKind("voice.m4a"), "audio");
  assert.equal(previewKind("notes/brief.md"), "text");
  assert.equal(previewKind(".gitignore"), "text");
  assert.equal(previewKind("budget.xlsx"), "none");
  assert.equal(canRenderImage("x.jpg"), true);
  assert.equal(canRenderImage("x.HEIC"), false, "RN cannot decode HEIC");
  assert.equal(canRenderImage("x.avif"), false, "nor AVIF on older systems");
  assert.equal(canRenderImage("x.mp4"), false);
});

test("a text head shows its first lines, marks a cut and refuses binary", () => {
  assert.deepEqual(headPreview(bytes("a\r\nb\nc\n"), 6), { kind: "text", lines: ["a", "b", "c"], truncated: false });
  assert.deepEqual(headPreview(bytes("a\rb"), 3).lines, ["a", "b"], "a lone carriage return ends a line");
  const long = bytes(Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"));
  const cut = headPreview(long, long.length);
  assert.equal(cut.lines.length, HEAD_LINES);
  assert.equal(cut.truncated, true);
  assert.equal(headPreview(bytes("exact\n"), 6).truncated, false, "a trailing newline is not a cut");
  assert.equal(headPreview(bytes("part"), 99999).truncated, true, "a file longer than the bytes read is cut");
  assert.deepEqual(headPreview(new Uint8Array([123, 0, 125]), 3), { kind: "none" });
  assert.deepEqual(headPreview(null, 0), { kind: "none" });
  const wide = bytes("é".repeat(10)).slice(0, 19);
  assert.ok(!headPreview(wide, 40).lines[0].includes("�"), "a cut inside a character leaves no replacement character");
});

test("the phone Files list shows thumbnails, a long-press peek sheet, File detail's preview and the Fold's pane", () => {
  const app = fs.readFileSync(new URL("../apps/mobile/src/App.jsx", import.meta.url), "utf8");
  const history = fs.readFileSync(new URL("../apps/mobile/src/FileHistory.jsx", import.meta.url), "utf8");
  assert.match(app, /<RowThumb entry=\{e\} enabled=\{index < 30\} \/>/);
  assert.match(app, /onLongPress=\{\(\) => \{\s*if \(!e\.directory\) setSheet\(\{ kind: "peek", entry: e \}\)/);
  assert.match(app, /shownSheet\.kind === "peek"/);
  assert.match(app, /wide && !compact\) setPreviewEntry\(e\)/);
  assert.match(app, /PREVIEW/);
  assert.match(app, /enabled=\{index < 30\}/, "only the first thirty rows decode thumbnails");
  assert.match(app, /setPreviewEntry\(null\);\s*\}, \[folder\?\.id, directory, search, screen\]\)/, "the Fold card never outlives its folder");
  assert.match(app, /accessibilityActions=\{e\.directory \? undefined : \[\{ name: "preview"/, "TalkBack reaches the peek");
  assert.match(history, /<FilePreview entry=\{localEntry\}/);
});
