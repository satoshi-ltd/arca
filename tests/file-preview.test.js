import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-file-preview-"));
  init(home, { port: 0, name: "Preview hub" });
  const daemon = await start(home, { timer: false });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const v = daemon.engine.store.addVolume("Docs");
  const api = async (route, token = daemon.engine.config.adminToken, body) => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  const add = async (name, content) => {
    fs.mkdirSync(path.dirname(path.join(v.path, name)), { recursive: true });
    fs.writeFileSync(path.join(v.path, name), content);
    await daemon.engine.cycle();
    return daemon.engine.store.current(v.id, name);
  };
  const preview = (name, hash) => api(`/v1/file-preview?${new URLSearchParams({ volume: v.id, path: name, hash })}`);
  return { daemon, v, api, add, preview };
}

test("a text file previews its first lines, other types and binary files preview nothing", async (t) => {
  const f = await fixture(t);
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const md = await f.add("notes/brief.md", "# Brief\r\nBudget approved\nThird");
  const big = await f.add("long.txt", long);
  const bin = await f.add("data.json", Buffer.from([123, 0, 1, 2, 125]));
  const img = await f.add("photo.png", "not really an image");
  const exact = await f.add("exact.txt", Array.from({ length: 24 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
  const cr = await f.add("mac.txt", "a\rb\rc");
  const utf = await f.add("utf.txt", "é".repeat(2100));
  const dot = await f.add(".gitignore", "node_modules\n");
  const small = await f.preview("notes/brief.md", md.hash);
  assert.deepEqual(small, { kind: "text", lines: ["# Brief", "Budget approved", "Third"], truncated: false, size: md.size });
  const cut = await f.preview("long.txt", big.hash);
  assert.equal(cut.lines.length, 24);
  assert.equal(cut.truncated, true);
  assert.equal(cut.lines[0], "line 1");
  const edge = await f.preview("exact.txt", exact.hash);
  assert.equal(edge.lines.length, 24);
  assert.equal(edge.truncated, false, "exactly 24 lines with a trailing newline is not truncated");
  assert.deepEqual((await f.preview("mac.txt", cr.hash)).lines, ["a", "b", "c"], "a lone carriage return ends a line");
  const wide = await f.preview("utf.txt", utf.hash);
  assert.equal(wide.truncated, true);
  assert.ok(!wide.lines[0].includes("\uFFFD"), "a cut inside a multi-byte character leaves no replacement character");
  assert.deepEqual((await f.preview(".gitignore", dot.hash)).lines, ["node_modules"], "a dotfile previews as text");
  assert.deepEqual(await f.preview("data.json", bin.hash), { kind: "none" }, "a NUL byte means binary");
  assert.deepEqual(await f.preview("photo.png", img.hash), { kind: "none" }, "images preview through the gallery route");
});

test("a preview refuses a stale hash, a missing or ignored file and a replica credential", async (t) => {
  const f = await fixture(t);
  const file = await f.add("a.txt", "one");
  await assert.rejects(f.preview("a.txt", "0".repeat(64)), (error) => error.status === 404, "the hash must be the current one");
  await assert.rejects(f.preview("missing.txt", file.hash), (error) => error.status === 404);
  const invite = await f.api("/v1/devices", undefined, { name: "phone", role: "replica" });
  await assert.rejects(
    f.api(`/v1/file-preview?${new URLSearchParams({ volume: f.v.id, path: "a.txt", hash: file.hash })}`, invite.token),
    (error) => error.status === 401 || error.status === 403,
    "a replica credential does not read previews from the hub",
  );
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "secret.txt\n");
  await f.add("secret.txt", "hidden");
  await f.daemon.engine.cycle();
  const hidden = f.daemon.engine.store.current(f.v.id, "secret.txt");
  assert.equal(hidden, undefined, "an ignored file never enters the index");
  await assert.rejects(f.preview("secret.txt", "1".repeat(64)), (error) => error.status === 404, "an ignored file has no preview");
});

test("search ranks names across folders by scope, skips deleted, ignored and unmatched files and validates input", async (t) => {
  const f = await fixture(t);
  const other = f.daemon.engine.store.addVolume("Holiday photos");
  const put = async (volume, name, content = "x") => {
    fs.mkdirSync(path.dirname(path.join(volume.path, name)), { recursive: true });
    fs.writeFileSync(path.join(volume.path, name), content);
  };
  await put(f.v, "plans/site-plan.pdf");
  await put(f.v, "plans/plan.txt");
  await put(f.v, "old/planet.md");
  await put(f.v, "deep/folder/unplanned.txt");
  await put(f.v, "gone-plan.txt");
  await put(other, "2026/plan-b.jpg", "jpeg");
  await put(other, "tracks/Planet Earth.mp3", "mp3");
  fs.writeFileSync(path.join(f.v.path, ".arcaignore"), "secret-plan.txt\n");
  await put(f.v, "secret-plan.txt");
  await f.daemon.engine.cycle();
  fs.rmSync(path.join(f.v.path, "gone-plan.txt"));
  await f.daemon.engine.cycle();
  const search = (query, scope = "all", limit = 6) => f.api(`/v1/search?${new URLSearchParams({ q: query, scope, limit: String(limit) })}`);
  const all = await search("plan");
  assert.deepEqual(all.files.map((r) => r.name), ["plan.txt", "planet.md", "site-plan.pdf", "unplanned.txt"], "exact name first, then prefix, then contains, newest first among equals");
  assert.deepEqual(all.photos.map((r) => r.name), ["plan-b.jpg"]);
  assert.equal(all.photos[0].folder, "Holiday photos");
  assert.deepEqual(all.music.map((r) => r.name), ["Planet Earth.mp3"]);
  assert.deepEqual(all.counts, { files: 4, photos: 1, music: 1, folders: 0 });
  assert.ok(!JSON.stringify(all).includes("gone-plan"), "deleted files never match");
  assert.ok(!JSON.stringify(all).includes("secret-plan"), "ignored files never match");
  assert.deepEqual((await search("holiday")).folders.map((r) => r.name), ["Holiday photos"]);
  assert.deepEqual((await search("plan", "files")).photos, [], "a scope limits the groups");
  assert.equal((await search("plan", "files", 2)).files.length, 2);
  assert.equal((await search("plan", "files", 2)).counts.files, 4, "counts report every match");
  assert.deepEqual((await search("site pla")).files.map((r) => r.name), ["site-plan.pdf"], "every word must match");
  assert.deepEqual((await search("zzzz")).files, []);
  for (const bad of ["q=", "q=x&scope=everything", "q=x&limit=0", "q=x&limit=99", `q=${"a".repeat(101)}`])
    await assert.rejects(f.api(`/v1/search?${bad}`), (error) => error.status === 400, bad);
  const invite = await f.api("/v1/devices", undefined, { name: "phone", role: "replica" });
  await assert.rejects(f.api("/v1/search?q=plan", invite.token), (error) => error.status === 401 || error.status === 403);
});

test("search folds case for any script, ranks an older exact name above newer partial ones and survives an unreadable ignore file", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.v.path, "Ñandú.txt"), "x");
  await f.daemon.engine.cycle();
  const search = (q) => f.api(`/v1/search?${new URLSearchParams({ q, scope: "files" })}`);
  assert.deepEqual((await search("ñandú")).files.map((r) => r.name), ["Ñandú.txt"], "an uppercase non-ASCII letter matches a lowercase query");
  assert.deepEqual((await search("ÑANDÚ")).files.map((r) => r.name), ["Ñandú.txt"]);
  fs.writeFileSync(path.join(f.v.path, "report.pdf"), "x");
  await f.daemon.engine.cycle();
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(f.v.path, `quarterly-report-${i}.pdf`), String(i));
  await f.daemon.engine.cycle();
  const found = await search("report");
  assert.equal(found.files[0].name, "report.pdf", "the exact name, extension aside, ranks first");
  const store = f.daemon.engine.store;
  const original = store.visibleRules.bind(store);
  store.visibleRules = () => { throw new Error("broken ignore policy"); };
  assert.deepEqual((await search("report")).files, [], "a volume with an unreadable ignore file is skipped instead of failing the search");
  store.visibleRules = original;
});
