import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moveToTrash } from "../packages/daemon/trash.js";

const setup = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-trash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "folder");
  fs.mkdirSync(folder);
  const file = (name, content) => {
    const target = path.join(folder, name);
    fs.writeFileSync(target, content);
    return target;
  };
  return { root, folder, file };
};

test("macOS moves outdated files into the user's Trash without overwriting earlier ones", async (t) => {
  const { root, file } = setup(t);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".Trash"), { recursive: true });
  fs.writeFileSync(path.join(home, ".Trash", "photo.jpg"), "earlier");
  const stale = file("photo.jpg", "stale");
  await moveToTrash([stale], { platform: "darwin", home });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.readFileSync(path.join(home, ".Trash", "photo.jpg"), "utf8"), "earlier");
  assert.equal(fs.readFileSync(path.join(home, ".Trash", "photo 2.jpg"), "utf8"), "stale");
});

test("Linux follows the freedesktop Trash with a restorable .trashinfo", async (t) => {
  const { root, file } = setup(t);
  const data = path.join(root, "data");
  const stale = file("notes 1%.txt", "stale");
  await moveToTrash([stale], { platform: "linux", home: path.join(root, "home"), env: { XDG_DATA_HOME: data } });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.readFileSync(path.join(data, "Trash", "files", "notes 1%.txt"), "utf8"), "stale");
  const info = fs.readFileSync(path.join(data, "Trash", "info", "notes 1%.txt.trashinfo"), "utf8").split("\n");
  assert.equal(info[0], "[Trash Info]");
  const location = info[1].slice("Path=".length);
  assert.doesNotMatch(location, / |%(?![0-9A-F]{2})/, "the path is percent-encoded");
  assert.equal(location.split("/").map(decodeURIComponent).join(path.sep), stale);
  assert.match(info[2], /^DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test("Windows sends batches to the Recycle Bin and fails when a file stays behind", async (t) => {
  const { file } = setup(t);
  const files = Array.from({ length: 45 }, (_, n) => file(`f${n}.txt`, "x"));
  const calls = [];
  await moveToTrash(files, {
    platform: "win32",
    env: {},
    execute: async (command, args, options) => {
      calls.push({ command, batch: JSON.parse(options.env.ARCA_TRASH), script: args.at(-1) });
      for (const target of JSON.parse(options.env.ARCA_TRASH)) fs.rmSync(target);
    },
  });
  assert.deepEqual(calls.map((call) => call.batch.length), [40, 5]);
  assert.equal(calls[0].command, "powershell.exe");
  assert.match(calls[0].script, /SendToRecycleBin/);
  assert.match(calls[0].script, /DriveType -ne 'Fixed'/, "drives without a Recycle Bin are refused, never deleted");
  assert.match(calls[0].script, /NukeOnDelete -eq 1/, "a disabled Recycle Bin is refused");
  assert.match(calls[0].script, /MaxCapacity \* 1MB/, "files larger than the Recycle Bin are refused");
  const kept = file("kept.txt", "x");
  await assert.rejects(
    moveToTrash([kept], { platform: "win32", env: {}, execute: async () => {} }),
    /Could not move .*kept\.txt to the Recycle Bin/,
  );
  assert.equal(fs.existsSync(kept), true);
  let options;
  await assert.rejects(
    moveToTrash([kept], {
      platform: "win32",
      env: {},
      execute: async (command, args, given) => {
        options = given;
        throw Object.assign(new Error("Command failed"), { stderr: "The Recycle Bin is turned off on D:\\\r\n" });
      },
    }),
    /The Recycle Bin is turned off/,
  );
  assert.equal(options.timeout, 120000, "a stuck Recycle Bin never blocks synchronization");
  assert.equal(fs.existsSync(kept), true);
});

test("a file on another volume goes to that volume's trash, never copied onto the home disk", async (t) => {
  const { root, folder, file } = setup(t);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const device = (target) => (path.resolve(target).startsWith(root) && !path.resolve(target).startsWith(home) ? 2 : 1);
  const outside = path.dirname(root);
  const mac = file("mac.jpg", "stale");
  await moveToTrash([mac], { platform: "darwin", home, device, uid: 501 });
  assert.equal(fs.readFileSync(path.join(root, ".Trashes", "501", "mac.jpg"), "utf8"), "stale");
  assert.equal(fs.existsSync(path.join(home, ".Trash", "mac.jpg")), false);
  const linux = file("linux.jpg", "stale");
  await moveToTrash([linux], { platform: "linux", home, env: {}, device, uid: 1000 });
  assert.equal(fs.readFileSync(path.join(root, ".Trash-1000", "files", "linux.jpg"), "utf8"), "stale");
  assert.ok(fs.existsSync(path.join(root, ".Trash-1000", "info", "linux.jpg.trashinfo")));
  assert.equal(fs.existsSync(path.join(home, ".local", "share", "Trash", "files", "linux.jpg")), false);
  assert.ok(outside.length < root.length && folder.startsWith(root));
});
