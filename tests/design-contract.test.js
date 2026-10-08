import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, digest } from "../packages/daemon/storage.js";
import { start } from "../packages/daemon/server.js";
import { issueWebCode } from "../packages/daemon/web.js";
test("design APIs: bounded filtered history, permissions, session revocation and local assets", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-design-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${d.port}`;
  const token = d.engine.config.adminToken;
  const request = (route, body, credential = token) =>
    fetch(url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + credential,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const v = d.engine.store.addVolume("Design");
  const candidate = path.join(d.engine.config.root, "Preflight only");
  const checked = await request("/v1/path-check", { path: candidate });
  assert.equal(checked.status, 200);
  const pathInfo = await checked.json();
  assert.equal(pathInfo.exists, false);
  assert.ok(pathInfo.freeBytes >= 0);
  assert.equal(
    fs.existsSync(candidate),
    false,
    "Preflight must not create directories",
  );
  const duplicate = await request("/v1/path-check", { path: v.path });
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error, /Already linked to "Design"/);
  const nested = await request("/v1/path-check", {
    path: path.join(v.path, "nested"),
  });
  assert.match((await nested.json()).error, /parent and child folders/);
  assert.equal(
    (await request("/v1/path-check", { path: candidate }, "invalid")).status,
    401,
  );

  fs.writeFileSync(path.join(v.path, "note.txt"), "one");
  fs.writeFileSync(path.join(v.path, "other.txt"), "kept");
  await d.engine.cycle();
  fs.writeFileSync(path.join(v.path, "note.txt"), "two");
  await d.engine.cycle();
  fs.unlinkSync(path.join(v.path, "note.txt"));
  await d.engine.cycle();
  const page = await (await request("/v1/activity?limit=2")).json();
  assert.equal(page.versions.length, 2);
  assert.ok(page.next);
  const next = await (
    await request("/v1/activity?limit=2&before=" + page.next)
  ).json();
  assert.equal(next.versions.length, 1);
  assert.equal(next.next, null);
  assert.ok([...page.versions, ...next.versions].every((row) => !row.deleted));
  assert.ok(next.versions[0].rev < page.next);
  const deleted = await (await request("/v1/activity?filter=deleted")).json();
  assert.equal(deleted.versions.length, 1);
  assert.equal(deleted.versions[0].deleted, 1);
  assert.equal((await request("/v1/activity?limit=10000")).status, 400);
  assert.equal(
    (await request("/v1/locate-folder", { id: v.id, path: v.path })).status,
    409,
  );
  const moved = v.path + "-moved";
  fs.renameSync(v.path, moved);
  const missingRegistered = await request("/v1/path-check", { path: v.path });
  assert.equal(missingRegistered.status, 400);
  assert.match(
    (await missingRegistered.json()).error,
    /directory is missing.*still registered/,
  );
  assert.equal(
    fs.existsSync(v.path),
    false,
    "Preflight must not recreate a missing share",
  );
  assert.equal(
    d.engine.store.volume(v.id).path,
    v.path,
    "Preflight preserves the catalog mapping",
  );

  assert.equal(
    (await request("/v1/locate-folder", { id: v.id, path: candidate })).status,
    409,
  );
  assert.equal(fs.existsSync(candidate), false);
  const located = await request("/v1/locate-folder", { id: v.id, path: moved });
  assert.equal(located.status, 200);
  assert.equal(d.engine.store.volume(v.id).path, fs.realpathSync(moved));

  assert.equal(
    (await request("/v1/activity", undefined, "invalid")).status,
    401,
  );
  const invite = await (
    await request("/v1/devices", { name: "Replica", role: "replica" })
  ).json();
  assert.equal(
    (
      await request(
        "/v1/settings",
        { name: "Changed by replica" },
        invite.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/v1/settings", { name: "Renamed hub" })).status,
    200,
  );
  assert.equal(d.engine.config.name, "Renamed hub");
  assert.equal((await request("/v1/settings", { name: "" })).status, 400);
  const { code } = issueWebCode(home);
  const login = await fetch(url + "/auth/login", {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await fetch(url + "/v1/status", { headers: { cookie } })).status,
    200,
  );
  assert.equal(
    (await request("/v1/web-sessions/revoke", {}, invite.token)).status,
    403,
  );
  assert.equal((await request("/v1/web-sessions/revoke", {})).status, 200);
  assert.equal(
    (await fetch(url + "/v1/status", { headers: { cookie } })).status,
    401,
  );
  for (const [asset, type] of [
    ["/tokens.css", "text/css"],
    ["/vendor/lucide.js", "text/javascript"],
    ["/assets/arca-icon.svg", "image/svg+xml"],
    ["/assets/fonts/instrument-sans.woff2", "font/woff2"],
    ["/assets/fonts/fragment-mono.woff2", "font/woff2"],
  ]) {
    const response = await fetch(url + asset);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), type);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
  }
  assert.equal(
    (await request("/v1/pause", { paused: true, seconds: -1 })).status,
    400,
  );
  await request("/v1/pause", { paused: true, seconds: 1 });
  d.engine.pauseUntil = Date.now() - 1;
  await d.engine.cycle();
  assert.equal(d.engine.paused, false);
});
test("conflict review restores chosen content and rejects stale decisions without removing either history", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-conflict-design-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  t.after(async () => {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const s = d.engine.store,
    v = s.addVolume("Docs");
  const conflict = "note.txt.conflict-machine-operation";
  fs.writeFileSync(path.join(v.path, "note.txt"), "original");
  fs.writeFileSync(path.join(v.path, conflict), "alternative");
  await d.engine.cycle();
  const original = s.current(v.id, "note.txt"),
    other = s.current(v.id, conflict);
  const body = {
    volume: v.id,
    path: conflict,
    choice: "conflict",
    originalRev: original.rev,
    conflictRev: other.rev,
  };
  const request = (b) =>
    fetch(`http://127.0.0.1:${d.port}/v1/conflict-choice`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + d.engine.config.adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(b),
    });
  s.db
    .prepare("INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,?)")
    .run("test-replica", "Test replica", digest("test-credential"), "replica");
  const replicaChoice = () =>
    fetch(`http://127.0.0.1:${d.port}/v1/conflict-choice`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-credential",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await replicaChoice()).status,
    409,
    "A replica without a selected-folder report cannot resolve",
  );
  assert.equal(s.current(v.id, "note.txt").rev, original.rev);
  assert.equal(s.unresolvedConflicts(v.id), 1);
  const conflictIncident = s.conflictRevision(v.id);
  assert.ok(conflictIncident > 0);
  s.db
    .prepare("INSERT INTO machine_reports VALUES(?,?)")
    .run("test-replica", JSON.stringify({ folderIds: [v.id] }));
  assert.equal(
    (await replicaChoice()).status,
    200,
    "A replica selecting the folder can resolve",
  );
  assert.equal(
    fs.readFileSync(path.join(v.path, "note.txt"), "utf8"),
    "alternative",
  );
  assert.equal(
    fs.readFileSync(path.join(v.path, conflict), "utf8"),
    "alternative",
  );
  assert.equal(s.unresolvedConflicts(v.id), 0);
  assert.equal(
    s.conflictRevision(v.id),
    conflictIncident,
    "Resolution alone does not create another incident",
  );
  assert.equal(s.conflictStatus(s.current(v.id, conflict)).resolved, true);
  assert.equal(
    s.conflictStatus(s.current(v.id, conflict)).resolutionRev,
    s.current(v.id, "note.txt").rev,
  );
  assert.equal(s.history(v.id, "note.txt").length, 2);
  assert.equal((await request(body)).status, 409);
  assert.equal((await request({ ...body, path: "note.txt" })).status, 400);
  const originalBefore = s.current(v.id, "note.txt").rev;
  fs.writeFileSync(path.join(v.path, conflict), "a different later edit");
  await d.engine.cycle();
  assert.equal(s.unresolvedConflicts(v.id), 1);
  assert.equal(s.conflictStatus(s.current(v.id, conflict)).resolved, false);
  assert.ok(
    s.conflictRevision(v.id) > conflictIncident,
    "Editing a conflict creates a new notification incident",
  );
  assert.equal(s.current(v.id, "note.txt").rev, originalBefore);
});

test("background sync acknowledges before completion, coalesces requests and exposes failures", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-async-sync-"));
  init(home, { port: 0 });
  const d = await start(home, { timer: false });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let cycles = 0;
  d.engine.cycle = async () => {
    cycles++;
    await gate;
    d.engine.error = "Test transfer failure";
  };
  const request = (route, body) =>
    fetch(`http://127.0.0.1:${d.port}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${d.engine.config.adminToken}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(2000),
    });
  assert.equal((await request("/v1/sync", { background: true })).status, 202);
  assert.equal((await request("/v1/sync", { background: true })).status, 202);
  assert.equal((await request("/v1/status")).status, 200);
  assert.equal(cycles, 1);
  release();
  await d.engine.tail;
  const status = await (await request("/v1/status")).json();
  assert.equal(status.error, "Test transfer failure");
});

test("replica credentials cannot administer the hub; replica administrators cannot create hub resources", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-role-boundary-"));
  init(home, { port: 0 });
  const hub = await start(home, { timer: false });
  t.after(async () => {
    await hub.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = (route, token, body) =>
    fetch(`http://127.0.0.1:${hub.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const admin = hub.engine.config.adminToken;
  const before = hub.engine.config.name;
  for (const role of ["replica"]) {
    const device = await (
      await call("/v1/devices", admin, { name: role, role })
    ).json();
    for (const route of [
      "/v1/volumes",
      "/v1/delete-share",
      "/v1/rename-share",
      "/v1/ignore-policy",
      "/v1/pairing",
      "/v1/devices",
      "/v1/revoke",
      "/v1/settings",
      "/v1/network",
      "/v1/network/lan",
      "/v1/retention",
      "/v1/promote",
      "/v1/backup",
      "/v1/pause",
    ]) {
      const response = await call(route, device.token, {});
      assert.equal(
        response.status,
        403,
        `${role} ${route}: ${await response.text()}`,
      );
    }
    assert.equal((await call("/v1/machines", device.token)).status, 200);
    assert.equal((await call("/v1/status", device.token)).status, 403);
  }
  assert.equal(hub.engine.config.name, before);
  assert.equal(hub.engine.store.volumes().length, 0);
  hub.engine.config.role = "replica";
  for (const route of [
    "/v1/volumes",
    "/v1/pairing",
    "/v1/delete-share",
    "/v1/rename-share",
    "/v1/devices",
    "/v1/revoke",
    "/v1/retention",
  ])
    assert.ok(
      [403, 409].includes((await call(route, admin, {})).status),
      route,
    );
});

test("the photo timeline fits the visible height instead of scrolling", () => {
  const css = fs.readFileSync(
    new URL("../apps/desktop/src/style.css", import.meta.url),
    "utf8",
  );
  const rule = (selector) =>
    css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))[1];
  assert.match(rule("#photo-gallery"), /grid-template-rows: auto auto 1fr;/, "a short gallery leaves no gap above its photos");
  const rail = rule(".photo-timeline");
  assert.match(rail, /height: var\(--timeline-height/);
  assert.doesNotMatch(rail, /overflow-y: auto/);
  const month = rule(".photo-timeline button");
  assert.match(month, /position: absolute;/);
  assert.match(month, /top: calc\(var\(--space-4\) \+ var\(--segment-top, 0px\)\);/);
  assert.match(month, /height: var\(--segment-height, 0px\);/);
});

test("the viewer cell is bounded so portrait videos fit the screen", () => {
  const css = fs.readFileSync(
    new URL("../apps/desktop/src/style.css", import.meta.url),
    "utf8",
  );
  const viewer = css.match(/\n\.photo-viewer-image \{([^}]*)\}/)[1];
  assert.match(viewer, /grid-template: minmax\(0, 1fr\) \/ minmax\(0, 1fr\);/);
  const video = css.match(/\n\.photo-viewer-image video \{([^}]*)\}/)[1];
  assert.match(video, /object-fit: contain;/);
  assert.match(video, /max-height: 100dvh;/);
});

test("sync activity uses the accent and the palette has no separate blue state", () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../apps/desktop/src/${file}`, import.meta.url), "utf8");
  const css = read("style.css");
  const tokens = read("tokens.css");
  assert.doesNotMatch(tokens + css, /--sy(Bg|Fg)?\b/);
  for (const selector of [".sy", ".status-card strong.sy", ".stat-status.sy"])
    assert.match(
      css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))[1],
      /color: var\(--green\);/,
      selector,
    );
  assert.doesNotMatch(read("app.js"), /pill\("Arca detected", "sy"/);
});

test("dialogs share one default width and one wide variant", () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../apps/desktop/src/${file}`, import.meta.url), "utf8");
  const tokens = read("tokens.css");
  const css = read("style.css");
  assert.match(tokens, /--dialog-width: 480px;/);
  assert.match(tokens, /--dialog-wide-width: 640px;/);
  assert.doesNotMatch(tokens, /--(confirmation|approval)-width/);
  for (const name of ["confirmation", "approval", "pair", "restore", "recovery", "conflict"])
    for (const [, body] of css.matchAll(new RegExp(`\\n\\.${name}-dialog \\{([^}]*)\\}`, "g")))
      assert.doesNotMatch(body, /(^|\s)(max-)?width:/, `.${name}-dialog sets its own width`);
  assert.match(css.match(/\n\.wide-dialog \{([^}]*)\}/)[1], /width: var\(--dialog-wide-width\);/);
});

test("every dialog shares one type scale, with body text as large as its buttons", () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../apps/desktop/src/${file}`, import.meta.url), "utf8");
  const tokens = read("tokens.css");
  const css = read("style.css");
  const rule = (selector) =>
    css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1];
  for (const token of ["--dialog-padding", "--dialog-tile", "--dialog-title", "--dialog-title-line", "--dialog-body-line"])
    assert.match(tokens, new RegExp(`${token}: `), token);
  assert.doesNotMatch(tokens, /--(confirmation-title|approval-tile):/);
  assert.match(rule("dialog"), /padding: var\(--dialog-padding\);/);
  assert.match(rule(".modal-title h2"), /font-size: var\(--dialog-title\);/);
  assert.match(rule(".modal-title p"), /font-size: var\(--text-control\);/);
  assert.match(css, /\.text-button \{[^}]*font-size: var\(--text-control\);/, "buttons use the body size");
  assert.doesNotMatch(css, /\n\.(confirmation|approval)-dialog \.modal-title/, "variants never restyle the header");
  assert.match(rule("dialog:has(:where(#submit-dialog.danger)) .modal-title .tile"), /background: var\(--erBg\);/);
  assert.doesNotMatch(read("app.js"), /#submit-dialog"\)\.className = "secondary danger"/);
});

test("the timeline date chip uses the accent like primary buttons", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const chip = css.match(/\n\.photo-timeline-hover \{([^}]*)\}/)[1];
  assert.match(chip, /background: var\(--green\);/);
  assert.match(chip, /color: var\(--onGreen\);/);
  assert.match(css.match(/\n\.primary \{([^}]*)\}/)[1], /background: var\(--green\);/);
});

test("control borders, destructive buttons, toggles and busy dots meet the accessibility contract", () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../apps/desktop/src/${file}`, import.meta.url), "utf8");
  const css = read("style.css");
  const tokens = read("tokens.css");
  const rule = (selector) =>
    css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))[1];
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const value = parseInt(hex.slice(at, at + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  const [light, dark] = tokens.split(/^\[data-theme="dark"\] \{/m);
  const color = (source, name) => source.match(new RegExp(`--${name}:\\s*(#[\\da-f]{6})`))[1];
  for (const [theme, source, base] of [["light", light, light], ["dark", dark, light]]) {
    const pick = (name) => (source.includes(`--${name}:`) ? color(source, name) : color(base, name));
    for (const ground of ["paper", "surface"])
      assert.ok(ratio(pick("control"), pick(ground)) >= 3, `${theme} --control on ${ground}`);
    assert.ok(ratio(pick("onGreen"), pick("er")) >= 4.5, `${theme} danger label`);
  }
  assert.match(css, /border: 1px solid var\(--control\);\n  background: var\(--surface\);\n  color: var\(--ink\);\n  font-size: var\(--text-control\);/, "buttons draw the control border");
  assert.match(css, /width: 100%;\n  min-width: 0;\n  border: 1px solid var\(--control\);/, "fields draw the control border");
  assert.match(rule(".toggle span"), /background: var\(--control\);/);
  for (const selector of [".dropdown-trigger", ".field-with-icon", ".root-selection", ".photo-viewer .photo-info-footer button"])
    assert.match(rule(selector), /border: 1(\.5)?px solid var\(--control\);/, `${selector} draws the control border`);
  assert.match(rule(".tray-tone-paused > svg"), /color: var\(--wa\);/, "the tray draws Paused as a warning");
  assert.match(rule(".primary.danger"), /color: var\(--onGreen\);/);
  assert.match(rule(".toggle input:focus-visible + span"), /outline: 2px solid var\(--green\);/);
  assert.match(rule(".busy-grid i"), /animation: arca-busy var\(--motion-loop\)/);
});

test("every control answers a press, the viewer keeps its own fills and icon buttons grow on coarse pointers", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const tail = css.slice(css.indexOf("@media (hover: hover) {\n  .secondary:hover:not(:disabled)"));
  assert.ok(css.indexOf("@media (hover: hover) {\n  .secondary:hover:not(:disabled)") > css.indexOf(".dropdown-trigger:hover"), "the pressed block comes after every hover rule so it wins");
  assert.match(tail, /\.secondary:hover:not\(:disabled\),\s+\.icon-button:hover:not\(:disabled\) \{\s+background: var\(--hover\);/, "hover fills with --hover, only where hover exists");
  assert.doesNotMatch(css, /\n\.secondary:hover,\n\.icon-button:hover \{\n  background: var\(--surface\);/, "no hover that equals the resting colour");
  const active = tail.match(/\.secondary:active:not\(:disabled\),[^{]*\{([^}]*)\}/)[0];
  for (const selector of [".icon-button:active", ".nav-item:active:not(.active)", ".folder-card:active", ".history-row[role=\"button\"]:active", ".browser-file-row:active", ".dropdown-trigger:active"])
    assert.ok(active.includes(selector), `${selector} fills while pressed`);
  assert.match(active, /background: var\(--hover\);/);
  assert.match(tail, /\.primary:active:not\(:disabled\),\s+\.photo-thumb \.photo-open:active \{\s+opacity: 0\.85;/);
  assert.match(tail, /\.photo-viewer button:hover:not\(:disabled\),\s+\.photo-viewer button:active:not\(:disabled\) \{\s+background: #ffffff26;/, "viewer buttons keep their translucent fill");
  assert.match(tail, /\.photo-viewer \.photo-info button:hover:not\(:disabled\),\s+\.photo-viewer \.photo-info button:active:not\(:disabled\) \{\s+background: var\(--tint\);/, "the Info panel keeps its tint");
  const coarse = tail.slice(tail.indexOf("@media (pointer: coarse) {"));
  assert.match(coarse, /@media \(pointer: coarse\) \{\s+\.icon-button,\s+\.ghost\.icon-button \{\s+width: var\(--touch-target-min\);/);
  assert.match(coarse, /@media \(pointer: coarse\) and \(min-width: 481px\) \{\s+#sync-controls \.ghost\.icon-button,\s+#sync-controls button \{/, "the collapsed 64 px sidebar keeps its small controls");
});

test("the viewer's Back button moves clear of the macOS window controls only in the native Mac app", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const tokens = fs.readFileSync(new URL("../apps/desktop/src/tokens.css", import.meta.url), "utf8");
  assert.match(tokens, /--window-controls-inset: 84px;/);
  const base = css.match(/\n\.photo-viewer \.dialog-actions \{([^}]*)\}/)[1];
  assert.match(base, /left: var\(--space-4\);/, "elsewhere the button keeps its place");
  assert.match(css, /\n\.mac-native \.photo-viewer \.dialog-actions \{\s+left: var\(--window-controls-inset\);\s+\}/);
  assert.ok(css.indexOf(".mac-native .photo-viewer .dialog-actions") > css.indexOf("\n.photo-viewer .dialog-actions {"), "the native rule comes after the base rule");
});

test("floating surfaces lift off the page in dark and the selected segment shows its choice in both themes", () => {
  const read = (file) => fs.readFileSync(new URL(`../apps/desktop/src/${file}`, import.meta.url), "utf8");
  const tokens = read("tokens.css");
  const css = read("style.css");
  const [light, dark] = tokens.split(/^\[data-theme="dark"\] \{/m);
  const color = (source, name) => source.match(new RegExp(`--${name}:\\s*(#[\\da-f]{6})`))?.[1];
  const pick = (theme, name) => color(theme === "dark" ? dark : light, name) ?? color(light, name);
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const value = parseInt(hex.slice(at, at + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  for (const theme of ["light", "dark"]) {
    const selected = pick(theme, "segmentSelected");
    const track = pick(theme, "segmentTrack");
    assert.ok(luminance(selected) > luminance(track), `${theme}: the selected segment is lighter than its track`);
    assert.ok(ratio(selected, track) >= 1.1, `${theme}: and visibly different`);
  }
  assert.equal(pick("light", "notice-surface"), pick("light", "surface"), "light floating surfaces keep the card colour");
  assert.ok(ratio(pick("dark", "notice-surface"), pick("dark", "surface")) >= 1.05, "in dark a floating surface is lighter than the card under it");
  assert.ok(luminance(pick("dark", "notice-surface")) > luminance(pick("dark", "surface")));
  assert.match(dark, /--shadow-menu:\s+0 8px 24px rgba\(0, 0, 0, 0\.55\), 0 0 0 1px var\(--line\);/, "dark menus carry a hairline ring");
  assert.match(dark, /--shadow-dialog:\s+0 24px 64px rgba\(0, 0, 0, 0\.6\), 0 0 0 1px var\(--line\);/);
  assert.match(css, /\n\.segmented \{[^}]*background: var\(--segmentTrack\);/);
  assert.match(css, /\n\.segmented button\.active \{\s+background: var\(--segmentSelected\);/);
  assert.match(css, /\ndialog \{[^}]*background: var\(--notice-surface\);/);
  assert.match(css, /\n\.menu-items \{[^}]*background: var\(--notice-surface\);/);
  assert.match(css, /\n\.menu-items button \{[^}]*background: transparent;/, "menu buttons are not boxes inside the menu");
  for (const theme of ["light", "dark"])
    assert.ok(ratio(pick(theme, "track"), pick(theme, "notice-surface")) >= 1.05, `${theme}: a menu row's hover fill reads on the menu`);
  assert.match(css, /\.menu-items button:hover:not\(:disabled\) \{\s+background: var\(--track\);/);
  assert.match(css, /\.menu-items button:active:not\(:disabled\) \{\s+background: var\(--track\);/);
  assert.ok(ratio(pick("dark", "segmentTrack"), pick("dark", "paper")) >= 1.04, "the dark segmented track shows on the page");
  const dropdown = css.match(/\n\.dropdown-menu \{([^}]*)\}/)[1];
  assert.match(dropdown, /background: var\(--notice-surface\);/);
});

test("a primary icon button keeps its accent fill on hover, so its icon stays visible", () => {
  const css = fs.readFileSync(new URL("../apps/desktop/src/style.css", import.meta.url), "utf8");
  const hover = css.slice(css.indexOf("@media (hover: hover) {\n  .secondary:hover:not(:disabled),"));
  const block = hover.slice(0, hover.indexOf("\n}\n"));
  assert.ok(block.indexOf(".icon-button:hover:not(:disabled)") < block.indexOf(".primary.icon-button:hover:not(:disabled)"), "the primary rule follows the generic one");
  assert.match(block, /\.primary\.icon-button:hover:not\(:disabled\) \{\s+background: var\(--green\);\s+\}/);
});
