import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digest, init } from "../packages/daemon/storage.js";
import { playerRoute } from "../packages/daemon/machines.js";
import { start } from "../packages/daemon/server.js";

const PLAYER = [
  "GET /v1/blobs/",
  "GET /v1/catalog",
  "GET /v1/gallery",
  "GET /v1/gallery/preview",
  "GET /v1/music/cover",
  "GET /v1/music/library",
  "GET /v1/video/art",
  "GET /v1/video/compatible",
  "GET /v1/video/hls/",
  "GET /v1/video/library",
  "GET /v1/video/media",
  "GET /v1/video/subtitles",
  "POST /v1/delete-file",
  "POST /v1/gallery/delete",
  "POST /v1/leave",
  "POST /v1/machine-report",
  "POST /v1/video/position",
  "POST /v1/video/watch-next/remove",
  "POST /v1/video/watch-next/restore",
  "POST /v1/video/watched",
];
const LINKED = [
  "GET /v1/archive",
  "GET /v1/changes",
  "GET /v1/snapshot",
  "POST /v1/propose",
  "GET /v1/activity",
  "GET /v1/audio-positions",
  "GET /v1/events",
  "GET /v1/gallery/info",
  "GET /v1/gallery/memories",
  "GET /v1/gallery/periods",
  "GET /v1/history",
  "GET /v1/machines",
  "GET /v1/music/media",
  "GET /v1/uploads/",
  "GET /v1/web-approvals",
  "POST /v1/audio-position",
  "POST /v1/audio-position/clear",
  "POST /v1/backup-ack",
  "POST /v1/conflict-choice",
  "POST /v1/gallery/link",
  "POST /v1/gallery/register",
  "POST /v1/gallery/removals",
  "POST /v1/restore",
  "POST /v1/snapshot-release",
  "POST /v1/web-approvals",
  "PUT /v1/uploads/",
];
const ADMIN = [
  "/v1/",
  "/v1/backup",
  "/v1/browse",
  "/v1/client",
  "/v1/connect",
  "/v1/delete-share",
  "/v1/destroy-hub",
  "/v1/destroy-replica",
  "/v1/devices",
  "/v1/disconnect",
  "/v1/discovery",
  "/v1/favorites",
  "/v1/file-preview",
  "/v1/files",
  "/v1/folder-retention",
  "/v1/gallery/archive",
  "/v1/gallery/download",
  "/v1/gallery/media",
  "/v1/gallery/playback",
  "/v1/gallery/preview-image",
  "/v1/gallery/preview-url",
  "/v1/hub-url",
  "/v1/ignore-policy",
  "/v1/images",
  "/v1/locate-folder",
  "/v1/move",
  "/v1/move-folder",
  "/v1/music/download",
  "/v1/music/download/cancel",
  "/v1/music/download/remove",
  "/v1/music/downloads",
  "/v1/music/mark",
  "/v1/music/playback",
  "/v1/music/playlist",
  "/v1/network",
  "/v1/network/lan",
  "/v1/pairing",
  "/v1/path-check",
  "/v1/pause",
  "/v1/promote",
  "/v1/promotion-plan",
  "/v1/remote",
  "/v1/rename-file",
  "/v1/rename-share",
  "/v1/retention",
  "/v1/review-deletions",
  "/v1/revoke",
  "/v1/search",
  "/v1/select",
  "/v1/settings",
  "/v1/setup",
  "/v1/setup-info",
  "/v1/status",
  "/v1/sync",
  "/v1/unselect",
  "/v1/video/",
  "/v1/video/delete",
  "/v1/video/download",
  "/v1/video/download/cancel",
  "/v1/video/download/remove",
  "/v1/video/downloads",
  "/v1/video/kids",
  "/v1/video/mark",
  "/v1/video/match",
  "/v1/video/playback",
  "/v1/video/refresh",
  "/v1/video/settings",
  "/v1/video/tmdb-image",
  "/v1/video/tmdb-search",
  "/v1/volumes",
  "/v1/web-approvers",
  "/v1/web-sessions/revoke",
];
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE"];
const SYNC = { "x-arca-directories": "1", "x-arca-path-transitions": "1" };
const CLEAN = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
const UNKNOWN = "f".repeat(64);
const routeOf = (entry) => entry.split(" ").at(-1);
const allows = (list, method, route) =>
  list.includes(`${method === "HEAD" ? "GET" : method} ${route}`);
const sample = (route) =>
  route.endsWith("/") ? route + "a".repeat(64) : route;
const notServed = ({ status, error }) =>
  (status === 404 && error === "Endpoint not found") ||
  (status === 405 && error === "Method not allowed");

function served() {
  const routes = new Set();
  const folder = new URL("../packages/daemon/", import.meta.url);
  for (const file of fs
    .readdirSync(folder)
    .filter((name) => name.endsWith(".js")))
    for (const match of fs
      .readFileSync(new URL(file, folder), "utf8")
      .matchAll(/["'`](\/v1\/[A-Za-z0-9/_-]*)/g))
      routes.add(match[1]);
  return [...routes].sort();
}

async function daemonFor(t, role) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `arca-roles-${role}-`));
  let daemon;
  t.after(async () => {
    await daemon?.close();
    fs.rmSync(home, CLEAN);
  });
  init(home, { port: 0, role });
  daemon = await start(home, { timer: false });
  const call = async (method, route, token, body) => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...SYNC,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined || method === "GET" || method === "HEAD"
        ? {}
        : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let error = "";
    try {
      error = JSON.parse(text).error || "";
    } catch {}
    return { status: response.status, error, text };
  };
  const admin = daemon.engine.config.adminToken;
  const pair = async (kind) => {
    const { text } = await call("POST", "/v1/pairing", admin, { name: kind });
    return JSON.parse(
      (
        await call("POST", "/pair", null, {
          code: JSON.parse(text).code,
          name: kind,
          kind,
        })
      ).text,
    ).token;
  };
  return { daemon, call, admin, pair };
}

async function refusedBelowAdmin(call, token, literal, label) {
  for (const method of METHODS) {
    const answer = await call(method, sample(literal), token, {});
    assert.ok(
      answer.status === 403 ||
        notServed(answer) ||
        (method === "HEAD" && [404, 405].includes(answer.status)),
      `${label} ${method} ${literal} answered ${answer.status} ${answer.error}`,
    );
  }
}

test("every /v1 route the daemon serves is in the role table, and the table names no route that is gone", () => {
  assert.deepEqual(
    [...new Set([...PLAYER, ...LINKED, ...ADMIN].map(routeOf))].sort(),
    served(),
  );
  for (const entry of [...PLAYER, ...LINKED])
    assert.ok(!ADMIN.includes(routeOf(entry)), entry);
});

test("the player table is the daemon's player allow-list", () => {
  for (const literal of served())
    for (const method of METHODS)
      assert.equal(
        playerRoute(method, sample(literal)),
        allows(PLAYER, method, literal),
        `${method} ${literal}`,
      );
});

test("on a hub nobody reaches a route, a player only its own and a linked replica never an administrator's", async (t) => {
  const { call, pair } = await daemonFor(t, "hub");
  const replica = await pair("replica"),
    player = await pair("player");
  for (const literal of served()) {
    const route = sample(literal);
    for (const method of METHODS) {
      const label = `${method} ${literal}`;
      assert.equal(
        (await call(method, route, null, {})).status,
        401,
        `nobody ${label}`,
      );
      assert.equal(
        (await call(method, `${route}?ticket=${"a".repeat(64)}`, null, {}))
          .status,
        401,
        `ticket ${label}`,
      );
      if (method === "GET")
        assert.equal(
          (await call(method, route, UNKNOWN, {})).status,
          401,
          `unknown token ${label}`,
        );
      if (literal !== "/v1/leave" && !allows(PLAYER, method, literal))
        assert.equal(
          (await call(method, route, player, {})).status,
          403,
          `player ${label}`,
        );
    }
    if (
      METHODS.every(
        (method) =>
          !allows(PLAYER, method, literal) && !allows(LINKED, method, literal),
      )
    )
      await refusedBelowAdmin(call, replica, literal, "replica");
    else
      for (const method of METHODS.filter(
        (m) =>
          m !== "HEAD" &&
          !allows(PLAYER, m, literal) &&
          !allows(LINKED, m, literal),
      )) {
        const answer = await call(method, route, replica, {});
        assert.ok(
          answer.status === 403 || notServed(answer),
          `replica ${method} ${literal} answered ${answer.status} ${answer.error}`,
        );
      }
  }
});

test("a daemon that is not the hub answers only its administrator, even to a device row left in its index", async (t) => {
  const { daemon, call } = await daemonFor(t, "replica");
  const token = "b".repeat(64);
  for (const role of ["replica", "player"])
    daemon.engine.store.db
      .prepare("INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,?)")
      .run(
        `11111111-1111-4111-8111-${role.padEnd(12, "0")}`,
        role,
        digest(token + role),
        role,
      );
  for (const literal of served())
    for (const method of METHODS)
      for (const bearer of [null, UNKNOWN, `${token}replica`, `${token}player`])
        assert.equal(
          (await call(method, sample(literal), bearer, {})).status,
          401,
          `${method} ${literal} ${bearer}`,
        );
});

test("a path that leaves its folder is refused for a player and a linked replica, and nothing outside is read or removed", async (t) => {
  const { call, admin, pair } = await daemonFor(t, "hub");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "arca-roles-files-"));
  t.after(() => fs.rmSync(outside, CLEAN));
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "arca-sentinel-content");
  const folders = {};
  for (const kind of ["plain", "audio", "video"]) {
    const folder = path.join(outside, kind);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "inside.txt"), "inside");
    const created = await call("POST", "/v1/volumes", admin, {
      name: kind,
      path: folder,
    });
    assert.equal(created.status, 201, created.text);
    folders[kind] = JSON.parse(created.text).id;
  }
  assert.equal(
    (await call("POST", "/v1/music/mark", admin, { volume: folders.audio }))
      .status,
    200,
  );
  assert.equal(
    (await call("POST", "/v1/video/mark", admin, { volume: folders.video }))
      .status,
    200,
  );
  const replica = await pair("replica"),
    player = await pair("player");
  const report = {
    machineId: "22222222-2222-4222-8222-222222222222",
    name: "device",
    platform: "linux",
    arch: "x64",
    kernelRelease: "1",
    phase: "idle",
    uptimeSeconds: 1,
    selectedFolders: 3,
    indexedFiles: 3,
    indexedBytes: 18,
    lastSync: null,
    folderIds: Object.values(folders),
  };
  for (const token of [replica, player]) {
    const reported = await call("POST", "/v1/machine-report", token, report);
    assert.equal(reported.status, 200, reported.text);
  }
  const hostile = [
    "../secret.txt",
    "sub/../../secret.txt",
    secret,
    secret.split(path.sep).join("/"),
    ".arca-volume",
    "..\\secret.txt",
  ];
  const reads = [
    "/v1/history",
    "/v1/gallery/preview",
    "/v1/gallery/info",
    "/v1/music/media",
    "/v1/video/media",
    "/v1/video/subtitles",
  ];
  const writes = [
    "/v1/restore",
    "/v1/delete-file",
    "/v1/conflict-choice",
    "/v1/gallery/delete",
    "/v1/propose",
  ];
  const checked = ["/v1/delete-file", "/v1/propose", "/v1/restore"];
  const validated = new Set();
  for (const [who, token] of [
    ["player", player],
    ["replica", replica],
  ])
    for (const [kind, volume] of Object.entries(folders))
      for (const name of hostile) {
        for (const route of reads) {
          const answer = await call(
            "GET",
            `${route}?${new URLSearchParams({ volume, path: name, hash: "a".repeat(64) })}`,
            token,
          );
          const label = `${who} ${kind} GET ${route} ${name} answered ${answer.status} ${answer.error}`;
          if (route === "/v1/history" && answer.status === 200)
            assert.equal(answer.text, '{"versions":[]}', label);
          else assert.ok(answer.status >= 400 && answer.status < 500, label);
          assert.ok(!answer.text.includes("arca-sentinel-content"), label);
        }
        for (const route of writes) {
          const body = {
            volume,
            path: name,
            paths: [name],
            rev: 1,
            base: 0,
            deleted: true,
            choice: "original",
            name,
            id: "x",
          };
          const answer = await call("POST", route, token, body);
          const label = `${who} ${kind} POST ${route} ${name} answered ${answer.status} ${answer.error}`;
          assert.ok(answer.status >= 400 && answer.status < 500, label);
          if (checked.includes(route) && answer.status !== 403) {
            assert.match(
              answer.error,
              /(Unsupported|Invalid) file path/,
              label,
            );
            validated.add(`${who} ${route}`);
          }
        }
        assert.equal(fs.readFileSync(secret, "utf8"), "arca-sentinel-content");
        assert.equal(
          fs.readFileSync(path.join(outside, kind, "inside.txt"), "utf8"),
          "inside",
        );
        assert.ok(fs.existsSync(path.join(outside, kind, ".arca-volume")));
      }
  assert.deepEqual([...validated].sort(), [
    "player /v1/delete-file",
    "replica /v1/delete-file",
    "replica /v1/propose",
    "replica /v1/restore",
  ]);
});
