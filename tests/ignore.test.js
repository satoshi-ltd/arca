import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileIgnore,
  ensureIgnore,
  readIgnore,
  DEFAULT_IGNORE,
} from "../packages/daemon/exclusions.js";
import {
  builtinExcluded,
  disposableMetadata,
} from "../packages/core/builtin-exclusions.js";

test("root rules support gitignore patterns and parent-directory negation", () => {
  const excluded = compileIgnore(
    "# comment\n/root.txt\n*.tmp\n**/logs/\ncache/*\n!cache/keep.txt\nfile[0-9]?.bak\n\\#literal\n",
  );
  for (const name of [
    "root.txt",
    "a/file.tmp",
    "x/logs/file",
    "cache/drop",
    "file1a.bak",
    "#literal",
  ])
    assert.equal(excluded(name), true, name);
  for (const name of ["a/root.txt", "cache/keep.txt", "filex.bak", "notes.md"])
    assert.equal(excluded(name), false, name);
  assert.equal(
    compileIgnore("cache/\n!cache/keep.txt")("cache/keep.txt"),
    true,
  );
  assert.equal(compileIgnore("cache/")("cache", true), true);
  assert.equal(compileIgnore("cache/")("cache", false), false);
  assert.equal(compileIgnore("*\n!.arca-volume")(".arcaignore"), false);
  assert.equal(compileIgnore("*\n!.arca-volume")(".arca-volume"), true);
});

test("a missing or empty policy keeps only the fixed exclusions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-ignore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  assert.equal(readIgnore(root), "");
  fs.writeFileSync(path.join(root, ".arcaignore"), "");
  assert.equal(readIgnore(root), "");
  const excluded = compileIgnore(readIgnore(root));
  assert.equal(excluded("nested/.git/config"), true);
  assert.equal(excluded("app/node_modules/package/index.js"), true);
  assert.equal(excluded("cache/keep"), false);
});

test("the seeded .arcaignore has no rules and never replaces an existing one", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-ignore-seed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  ensureIgnore(root);
  assert.equal(readIgnore(root), DEFAULT_IGNORE);
  assert.ok(
    DEFAULT_IGNORE.split("\n").every(
      (line) => !line.trim() || line.startsWith("#"),
    ),
  );
  assert.equal(compileIgnore(DEFAULT_IGNORE)("target/app.jar"), false);
  fs.writeFileSync(path.join(root, ".arcaignore"), "custom/\n");
  ensureIgnore(root);
  assert.equal(readIgnore(root), "custom/\n");
});

test("ignore reads reject a dangling symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-ignore-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  try {
    fs.symlinkSync(
      path.join(root, "missing"),
      path.join(root, ".arcaignore"),
      "file",
    );
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("Creating symlinks requires Windows privileges");
      return;
    }
    throw error;
  }
  assert.throws(() => readIgnore(root));
});

test("fixed exclusions apply without rules and despite negation", () => {
  const excludedNames = [
    ".DS_Store",
    "photos/.ds_store",
    ".localized",
    "Folder/Icon\r",
    "Thumbs.db",
    "photos/EHTHUMBS.DB",
    "nested/Desktop.ini",
    "docs/.directory",
    "._report.pdf",
    "photos/._.DS_Store",
    ".AppleDouble/file",
    ".Spotlight-V100/Store-V2/x",
    ".fseventsd/fseventsd-uuid",
    ".DocumentRevisions-V100/db",
    ".TemporaryItems/folders.501/x",
    "System Volume Information/IndexerVolumeGuid",
    "lost+found/#123",
    ".Trash/old.txt",
    ".Trash-1000/files/old.txt",
    ".Trashes/501/old.txt",
    "$RECYCLE.BIN/S-1-5/old.txt",
    "#recycle/old.txt",
    "@Recycle/old.txt",
    "photos/@eaDir/IMG_1.JPG/SYNOPHOTO_THUMB_M.jpg",
    "#snapshot/GMT+07_2026.09.27/file",
    "photos/.@__thumb/default.jpg",
    ".fuse_hidden0000001",
    ".nfs000000000123",
    ".stfolder",
    ".stversions/file~20260927.txt",
    ".dropbox",
    ".dropbox.attr",
    ".dropbox.cache/tmp",
    ".sync_4f2a1b.db",
    ".sync_4f2a1b.db-wal",
    "report.tmp",
    "~$report.docx",
    ".~lock.budget.ods#",
    "notes/.draft.md.swp",
    "notes/.draft.md.swo",
    "notes/draft.md~",
    "notes/.#draft.md",
    "notes/#draft.md#",
    "downloads/video.mp4.crdownload",
    "downloads/video.mp4.part",
    "downloads/video.mp4.partial",
    "downloads/file.pdf.download/data",
    "run/service.pid",
    "app/module.pyc",
    ".git",
    ".git/config",
    "project/.git/objects/ab/cdef",
    "worktree/.git",
    "Project/.GIT/HEAD",
    "app/node_modules/pkg/index.js",
    "app/.venv/bin/python",
    "app/__pycache__/mod.cpython-312.pyc",
    "app/.pytest_cache/v/cache",
    "app/.mypy_cache/3.12/x",
    "app/.ruff_cache/x",
    "app/.tox/py312/x",
    "home/.cache/pip/x",
    "app/.gradle/8.0/x",
    "morpheus/.m2/repository/org/x.jar",
    "web/.next/cache/x",
    "web/.nuxt/x",
    "web/.svelte-kit/x",
    "web/.turbo/x",
    "web/.parcel-cache/x",
    "mobile/.expo/settings.json",
    "flutter/.dart_tool/x",
    "infra/.terraform/providers/x",
    ".obsidian",
    "vault/.OBSIDIAN/workspace.json",
    ".arca-volume",
  ];
  const syncedNames = [
    ".env",
    ".env.local",
    "vault/notes/today.md",
    "notes/.localized.txt",
    "notes/.obsidian-backup/settings.json",
    "notes/.DS_Store.txt",
    "Icon.png",
    "Folder/Icon",
    ".arcaignore",
    ".gitignore",
    ".gitattributes",
    ".github/workflows/ci.yml",
    "notes/.git-notes.md",
    "cache/data.json",
    "build/output.js",
    "dist/app.js",
    "target/app.jar",
    "out/report.pdf",
    "logs/2026.log",
    "src/Pro/Emails/Logs/Log.php",
    "yarn.lock",
    "composer.lock",
    "morpheus/.m2/settings.xml",
    "src/main/java/com/app/repository/UserRepository.java",
    "data/app.sqlite",
    "data/app.sqlite-wal",
    "venv/lib/x",
    "env/config",
    "vendor/lib.php",
    ".vscode/settings.json",
    ".idea/workspace.xml",
    "Trash/notes.md",
    "recycle/notes.md",
    "#ideas.md",
    "notes/~draft.md",
    "part/one.md",
    "photo.download.jpg",
    "notes/tmp.md",
  ];
  for (const text of [
    "",
    "!.DS_Store\n!**/.DS_Store\n!.git\n!**/.git/**\n!node_modules/\n!**/node_modules/**\n!*.tmp\n!.cache/\n!**/.m2/repository/**\n",
  ]) {
    const excluded = compileIgnore(text);
    for (const name of excludedNames) assert.equal(excluded(name), true, name);
    for (const name of syncedNames) assert.equal(excluded(name), false, name);
  }
  for (const name of excludedNames)
    if (!name.startsWith(".arca-"))
      assert.equal(builtinExcluded(name), true, name);
});

test("only OS metadata is disposable, never temporaries, caches or Git data", () => {
  for (const name of [
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    ".localized",
    "Icon\r",
    "._report.pdf",
  ])
    assert.equal(disposableMetadata(name), true, name);
  for (const name of [
    ".git",
    ".obsidian",
    ".gitignore",
    "notes.md",
    "report.tmp",
    "~$report.docx",
    "node_modules",
  ])
    assert.equal(disposableMetadata(name), false, name);
});

test("rule complexity is bounded so matching stays fast, and common gitignore rules still compile", () => {
  for (const text of ["**/node_modules/**\n", "**/logs/\n", "*.tmp\n!keep.tmp\n", "*.sqlite-*\n*.bak*\n**/schedule/runs.json\n", "\\*\\*\\*\\*literal\n", "# " + "*".repeat(300) + "\n", "a/**/b/**\n", "\uFEFF*.tmp\n", "logs/**   \n", "a\\*b\\*c*\n"])
    assert.doesNotThrow(() => compileIgnore(text), text);
  for (const [text, message] of [
    ["**/".repeat(12) + "zzz\n", /line 1 has too many wildcards/],
    ["**/build/**/*.js\n", /too many wildcards/],
    ["*a*a*b\n", /too many wildcards/],
    ["*\\ *\\ *\\ *zz\n", /too many wildcards/],
    ["*\\#*\\a*zz\n", /too many wildcards/],
    ["a/**/b/**\\ \n**/a*/**\\ \n", /line 1 has too many wildcards/],
    [" #" + "/**".repeat(12) + "/zzz\n", /line 1 has too many wildcards/],
    ["\t#" + "/**".repeat(12) + "/zzz\n", /too many wildcards/],
    ["\uFEFF#" + "/**".repeat(12) + "/zzz\n", /too many wildcards/],
    ["ok\n" + "x".repeat(257) + "\n", /line 2 is longer than 256/],
    [Array.from({ length: 201 }, (_, i) => `r${i}`).join("\n"), /more than 200 rules/],
    [Array.from({ length: 33 }, (_, i) => `*a*${i}`).join("\n"), /more than 64 wildcards/],
  ])
    assert.throws(() => compileIgnore(text), message, JSON.stringify(text.slice(0, 40)));
  const worst = [
    Array.from({ length: 32 }, (_, i) => `*a*a${i}`).join("\n"),
    Array.from({ length: 64 }, (_, i) => `**/a${i}/**`).join("\n"),
    Array.from({ length: 64 }, (_, i) => `a/**/a${i}`).join("\n") + "\n" + Array.from({ length: 136 }, (_, i) => `a${i}`).join("\n"),
  ];
  for (const text of worst) {
    for (const name of [Array(510).fill("a").join("/") + "/f.txt", Array(4).fill("a".repeat(255)).join("/")]) {
      const started = performance.now();
      compileIgnore(text)(name);
      assert.ok(performance.now() - started < 2000, `${text.slice(0, 12)} on ${name.length} characters`);
    }
  }
});

test("the phone refuses the same rules before compiling them", async () => {
  const { folderIgnored } = await import("../apps/mobile/src/hub-gallery.js");
  assert.equal(folderIgnored("**/".repeat(12) + "zzz\n"), null, "an unsafe policy is never evaluated and hides nothing it could later forget");
  assert.equal(folderIgnored("*.tmp\n")("a.txt"), false);
});
