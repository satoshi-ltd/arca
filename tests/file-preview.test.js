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
