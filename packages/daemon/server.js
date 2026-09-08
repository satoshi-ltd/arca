import { ACTIVE_POLL_MS, IDLE_POLL_MS, IDLE_AFTER_MS } from "./sync-work.js";
import { folderPreview } from "./folder-preview.js";
import { acceptReport, machines } from "./machines.js";
import { shortCode, normalizeCode, Attempts } from "./codes.js";
import { listPage, browsePage } from "./pages.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { moveFolder, retentionPlan, applyRetention } from "./maintenance.js";
import { snapshotPage } from "./snapshots.js";
import { Web } from "./web.js";
import { Engine } from "./engine.js";
import {
  Network,
  verifiedTailnetURL,
  verifiedLanURL,
  lanAddress,
} from "./network.js";
import {
  runtimeInstallation,
  digest,
  token,
  fail,
  hashFile,
  atomic,
  requireSpace,
  syncDirectory,
} from "./storage.js";

async function body(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) fail("Request too large", 413);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
function equal(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export async function start(home, options = {}) {
  const lock = path.join(path.resolve(home), "daemon.lock");
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(fs.readFileSync(lock, "utf8"));
    try {
      process.kill(pid, 0);
      fail("A daemon already owns this state directory", 409);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    }
  }
  let engine;
  try {
    engine = new Engine(home);
  } catch (e) {
    fs.unlinkSync(lock);
    throw e;
  }
  const s = engine.store;
  const config = engine.config;
  if (runtimeInstallation === "desktop" && config.installation !== "desktop") {
    config.installation = "desktop";
    s.saveConfig();
  }
  const webEnabled = config.installation !== "desktop";
  const network = new Network(engine, options.network);
  let web;
  try {
    if (webEnabled)
      web = new Web(
        home,
        options.webOrigin || process.env.ARCA_WEB_ORIGIN || config.webOrigin,
      );
  } catch (error) {
    engine.close();
    fs.unlinkSync(lock);
    throw error;
  }
  const pairingAttempts = new Attempts();
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "");
      const pathname = new URL(req.url, "http://localhost").pathname;
      const lanHttp = !req.socket.encrypted && lanAddress(remote);
      const lanAllowed =
        config.role === "hub" && config.network?.allowLanHttp === true;
      const discovery =
        req.method === "GET" && pathname === "/.well-known/arca";
      const requireLanAccess = () => {
        if (lanHttp && !lanAllowed)
          fail(
            "Enable Allow HTTP on local network in the hub's Settings to connect from this address",
            412,
          );
      };
      if (
        config.network?.mode === "tailscale" &&
        !(lanHttp && (lanAllowed || discovery)) &&
        !["127.0.0.1", "::1"].includes(remote)
      ) {
        requireLanAccess();
        const state = await network.detector.read();
        if (
          state.state !== "connected" ||
          ![state.self, ...state.peers].some((p) =>
            p.addresses.includes(remote),
          )
        )
          fail("Tailscale access unavailable", 403);
      }
      if (
        !webEnabled &&
        (pathname.startsWith("/auth/") ||
          pathname === "/v1/web-sessions/revoke" ||
          (!pathname.startsWith("/v1/") &&
            pathname !== "/pair" &&
            pathname !== "/.well-known/arca"))
      )
        return send(404, {
          error: "Web access is not available in the desktop installation",
        });
      if (req.headers.origin && (!web || !web.sameOrigin(req)))
        fail("Invalid browser origin", 403);
      if (req.method === "POST" && req.url === "/pair") {
        if (config.role !== "hub") fail("Pair with a hub", 409);
        requireLanAccess();
        if (req.headers.origin) fail("Use the local Arca client to pair", 403);
        pairingAttempts.check(remote);
        let b;
        try {
          b = JSON.parse((await body(req, 4096)).toString());
        } catch {
          fail("Invalid pairing request", 400);
        }
        if (!b || typeof b !== "object" || Array.isArray(b))
          fail("Invalid pairing request", 400);
        return send(
          201,
          await engine.exclusive(() => {
            const code = digest(normalizeCode(b.code, "P")),
              invitation = s.db
                .prepare(
                  "SELECT * FROM pairing WHERE code_hash=? AND expires>?",
                )
                .get(code, Date.now());
            if (!invitation) {
              s.db
                .prepare(
                  "INSERT INTO auth_failures VALUES('pair',1) ON CONFLICT(purpose) DO UPDATE SET failures=failures+1",
                )
                .run();
              if (
                s.db
                  .prepare(
                    "SELECT failures FROM auth_failures WHERE purpose='pair'",
                  )
                  .get().failures >= 5
              ) {
                s.db.prepare("DELETE FROM pairing").run();
                fail(
                  "Pairing code invalidated after five failed attempts. Generate a new code.",
                  429,
                );
              }
              fail("Pairing code invalid, expired or already used", 401);
            }
            const id = crypto.randomUUID(),
              secret = token();
            s.db.exec("BEGIN IMMEDIATE");
            try {
              s.db.prepare("DELETE FROM pairing WHERE code_hash=?").run(code);
              s.db
                .prepare(
                  "INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,'replica')",
                )
                .run(id, invitation.name, digest(secret));
              s.db.exec("COMMIT");
            } catch (e) {
              s.db.exec("ROLLBACK");
              throw e;
            }
            return { id, token: secret, hubId: config.id };
          }),
        );
      }
      if (web && (await web.handle(req, res, body))) return;
      if (req.method === "GET" && req.url === "/.well-known/arca")
        return send(200, {
          ...network.hello(),
          access: {
            daemonTransport: req.socket.encrypted ? "https" : "http",
            networkMode: config.network?.mode || "standalone",
            allowLanHttp: lanAllowed,
            codeDigits: 6,
            codeExpiresInSeconds: 600,
          },
        });
      const browserSession = web?.session(req);
      if (browserSession && req.method !== "GET" && !web.sameOrigin(req))
        fail("Invalid browser origin", 403);
      if (req.headers.origin && !browserSession) fail("Unauthorized", 401);
      const credential = (req.headers.authorization || "").replace(
        /^Bearer /,
        "",
      );
      const admin =
        Boolean(browserSession) || equal(credential, config.adminToken);
      const device = admin
        ? { id: config.id, role: "admin" }
        : s.db
            .prepare("SELECT * FROM devices WHERE token_hash=? AND revoked=0")
            .get(digest(credential));
      if (!device) fail("Unauthorized", 401);
      if (!admin) requireLanAccess();
      if (!admin)
        s.db
          .prepare("UPDATE devices SET last_seen=?,last_address=? WHERE id=?")
          .run(
            new Date().toISOString(),
            req.socket.remoteAddress?.replace(/^::ffff:/, "") || null,
            device.id,
          );
      const url = new URL(req.url, "http://localhost");
      const route = url.pathname;
      const jsonBody = async () => {
        try {
          const value = JSON.parse((await body(req)).toString());
          if (!value || typeof value !== "object" || Array.isArray(value))
            fail("Expected a JSON object", 400);
          return value;
        } catch (e) {
          if (e.status) throw e;
          fail("Invalid JSON");
        }
      };
      const checkCredential = () => {
        if (
          !admin &&
          !s.db
            .prepare(
              "SELECT id FROM devices WHERE id=? AND token_hash=? AND revoked=0",
            )
            .get(device.id, digest(credential))
        )
          fail("Unauthorized", 401);
      };
      const authorizedWork = (work) =>
        engine.exclusive(() => {
          checkCredential();
          return work();
        });
      const requireAdmin = () => {
        if (!admin) fail("Local administrator credential required", 403);
      };
      const requireHub = () => {
        if (config.role !== "hub") fail("This device is not the hub", 409);
      };
      if (req.method === "GET" && route === "/v1/ignore-policy") {
        requireAdmin();
        requireHub();
        return send(200, engine.ignorePolicy(url.searchParams.get("id")));
      }
      if (req.method === "GET" && route === "/v1/machines") {
        if (config.role !== "hub") {
          requireAdmin();
          return send(200, await engine.json("/v1/machines"));
        }
        return send(200, machines(engine));
      }
      if (req.method === "GET" && route === "/v1/network") {
        requireAdmin();
        return send(200, await network.status());
      }
      if (req.method === "GET" && route === "/v1/discovery") {
        requireAdmin();
        return send(200, await network.peers());
      }
      if (req.method === "GET" && route === "/v1/promotion-plan") {
        requireAdmin();
        return send(200, engine.promotionPlan());
      }
      if (req.method === "GET" && route === "/v1/status") {
        requireAdmin();
        return send(200, engine.status());
      }
      if (req.method === "GET" && route === "/v1/catalog") {
        requireHub();
        return send(200, {
          protocol: 1,
          changes: true,
          conflictResolution: true,
          blobRanges: true,
          id: config.id,
          name: config.name,
          ready: s.volumes().length > 0,
          volumes: s.volumes().map((v) => ({
            id: v.id,
            name: v.name,
            conflicts: s.unresolvedConflicts(v.id),
            files: s.rows(v.id).filter((r) => !r.deleted).length,
            bytes: s
              .rows(v.id)
              .reduce((n, r) => n + (r.deleted ? 0 : r.size), 0),
          })),
        });
      }
      if (req.method === "GET" && route === "/v1/remote") {
        requireAdmin();
        return send(
          200,
          config.role === "hub"
            ? {
                name: config.name,
                volumes: s.volumes().map((v) => {
                  const rows = s.rows(v.id).filter((r) => !r.deleted);
                  return {
                    id: v.id,
                    name: v.name,
                    files: rows.length,
                    bytes: rows.reduce((n, r) => n + r.size, 0),
                  };
                }),
              }
            : await engine.json("/v1/catalog"),
        );
      }
      if (req.method === "GET" && route === "/v1/changes") {
        requireHub();
        const volume = s.volume(url.searchParams.get("volume")).id;
        const latest = Number(
          s.db
            .prepare("SELECT seq FROM sqlite_sequence WHERE name='revisions'")
            .get()?.seq || 0,
        );
        const after = Number(url.searchParams.get("after") || 0);
        const through = Number(url.searchParams.get("through") ?? latest);
        if (
          ![after, through].every((n) => Number.isSafeInteger(n) && n >= 0) ||
          after > through ||
          through > latest
        )
          fail("Invalid change cursor; reconcile this folder", 409);
        const files = s.db
          .prepare(
            "SELECT * FROM files WHERE volume=? AND rev>? AND rev<=? ORDER BY rev LIMIT 500",
          )
          .all(volume, after, through);
        return send(200, {
          files,
          through,
          next: files.length === 500 ? files.at(-1).rev : null,
        });
      }
      if (req.method === "GET" && route === "/v1/snapshot") {
        requireHub();
        const volume = s.volume(url.searchParams.get("volume")).id;
        // An active hub scan already refreshes the catalog. Readers can use
        // committed revisions without waiting behind that entire scan.
        if (!url.searchParams.get("session") && engine.phase !== "syncing")
          await authorizedWork(() => engine.scanHub(volume));
        checkCredential();
        if (url.searchParams.has("limit"))
          return send(
            200,
            snapshotPage(s, device.id, volume, {
              session: url.searchParams.get("session"),
              after: url.searchParams.get("after") || "",
              limit: Number(url.searchParams.get("limit")),
            }),
          );
        return send(200, { files: s.rows(volume) });
      }
      if (req.method === "GET" && route === "/v1/archive") {
        requireHub();
        if (!admin && !["backup", "replica"].includes(device.role))
          fail("Linked machine credential required", 403);
        if (!admin)
          s.db
            .prepare(
              "INSERT INTO backup_ack(device,revision,enabled) VALUES(?,0,1) ON CONFLICT(device) DO UPDATE SET enabled=1",
            )
            .run(device.id);
        if (url.searchParams.has("limit")) {
          const highest = s.db
            .prepare("SELECT COALESCE(MAX(rev),0) AS n FROM revisions")
            .get().n;
          const through = url.searchParams.has("through")
            ? Number(url.searchParams.get("through"))
            : highest;
          const after = Number(url.searchParams.get("after") || 0),
            limit = Number(url.searchParams.get("limit"));
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 1000 ||
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isSafeInteger(through) ||
            through < after ||
            through > highest
          )
            fail("Invalid archive cursor", 409);
          const rows = s.db
            .prepare(
              "SELECT * FROM revisions WHERE rev>? AND rev<=? ORDER BY rev LIMIT ?",
            )
            .all(after, through, limit + 1);
          return send(200, {
            revisions: rows.slice(0, limit),
            through,
            next: rows.length > limit ? rows[limit - 1].rev : null,
            volumes: s.volumes().map((v) => ({ id: v.id, name: v.name })),
          });
        }
        return send(200, {
          revisions: s.db.prepare("SELECT * FROM revisions ORDER BY rev").all(),
          through: s.db
            .prepare("SELECT COALESCE(MAX(rev),0) AS n FROM revisions")
            .get().n,
        });
      }
      if (req.method === "GET" && route === "/v1/activity") {
        if (config.role !== "hub") {
          requireAdmin();
          return send(200, await engine.json(`/v1/activity${url.search}`));
        }
        const limit = Number(url.searchParams.get("limit") || 50);
        const before = Number(
          url.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
        );
        const volume = url.searchParams.get("volume");
        const filter = url.searchParams.get("filter") || "all";
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !Number.isSafeInteger(before) ||
          before < 1 ||
          !["all", "conflicts", "deleted"].includes(filter)
        )
          fail("Invalid activity query");
        if (volume) s.volume(volume);
        const rows = s.db
          .prepare(
            `SELECT r.*, v.name AS folder FROM revisions r JOIN volumes v ON v.id=r.volume WHERE r.rev<? ${volume ? "AND r.volume=?" : ""} ${filter === "deleted" ? "AND r.deleted=1" : filter === "conflicts" ? "AND instr(r.path,'.conflict-')>0 AND r.deleted=0 AND NOT EXISTS (SELECT 1 FROM conflict_resolutions c WHERE c.volume=r.volume AND c.path=r.path AND c.conflict_rev>=r.rev) AND EXISTS (SELECT 1 FROM files f WHERE f.volume=r.volume AND f.path=r.path AND f.deleted=0)" : ""} ORDER BY r.rev DESC LIMIT ?`,
          )
          .all(...[before, ...(volume ? [volume] : []), limit + 1]);
        return send(200, {
          versions: rows.slice(0, limit).map((row) => s.conflictStatus(row)),
          next: rows.length > limit ? rows[limit - 1].rev : null,
        });
      }
      if (req.method === "GET" && route === "/v1/history") {
        const volume = url.searchParams.get("volume");
        const name = url.searchParams.get("path");
        if (config.role !== "hub") {
          requireAdmin();
          return send(200, await engine.json(`/v1/history${url.search}`));
        }
        s.volume(volume);
        return send(
          200,
          url.searchParams.has("limit")
            ? listPage(s, volume, url.searchParams, name)
            : {
                versions: s
                  .history(volume, name)
                  .map((row) => s.conflictStatus(row)),
              },
        );
      }
      if (req.method === "GET" && route === "/v1/browse") {
        requireAdmin();
        const volume = s.volume(url.searchParams.get("volume")).id;
        return send(200, browsePage(s, volume, url.searchParams));
      }
      if (req.method === "GET" && route === "/v1/files") {
        requireAdmin();
        const volume = s.volume(url.searchParams.get("volume")).id;
        return send(
          200,
          url.searchParams.has("limit")
            ? listPage(s, volume, url.searchParams)
            : { files: s.rows(volume) },
        );
      }
      if (route.startsWith("/v1/blobs/") && req.method === "GET") {
        requireHub();
        const hash = route.split("/").at(-1);
        const file = s.blob(hash);
        if (!fs.existsSync(file)) fail("Object not found", 404);
        const size = fs.statSync(file).size;
        let offset = 0,
          end = size - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          if (!match) fail("Invalid range", 416);
          offset = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
          if (
            ![offset, end].every(Number.isSafeInteger) ||
            offset >= size ||
            end < offset
          )
            fail("Range exceeds content", 416);
        }
        res.writeHead(req.headers.range ? 206 : 200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": req.headers.range ? end - offset + 1 : size,
          "Accept-Ranges": "bytes",
          ...(req.headers.range
            ? { "Content-Range": `bytes ${offset}-${end}/${size}` }
            : {}),
        });
        const stream = fs.createReadStream(file, {
          start: offset,
          ...(req.headers.range ? { end } : {}),
        });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (route.startsWith("/v1/uploads/")) {
        requireHub();
        if (device.role === "backup") fail("Backup cannot upload", 403);
        const hash = route.split("/").at(-1);
        const file = s.blob(hash);
        const tmp = path.join(s.uploads, `${device.id}-${hash}.part`);
        if (req.method === "GET")
          return send(200, {
            complete: fs.existsSync(file),
            offset: fs.existsSync(tmp) ? fs.statSync(tmp).size : 0,
          });
        if (req.method === "PUT") {
          const data = await body(req);
          const offset = Number(url.searchParams.get("offset"));
          const size = Number(url.searchParams.get("size"));
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size > 100 * 1024 ** 3 ||
            offset + data.length > size
          )
            fail("Invalid upload bounds");
          return send(
            200,
            await authorizedWork(() => {
              if (fs.existsSync(file)) return { complete: true, offset: size };
              const actual = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
              if (offset !== actual)
                fail("Upload offset mismatch; query upload status", 409);
              requireSpace(s.uploads, data.length);
              fs.appendFileSync(tmp, data, { mode: 0o600 });
              const complete = offset + data.length === size;
              if (complete) {
                if (hashFile(tmp) !== hash) {
                  fs.unlinkSync(tmp);
                  fail("Upload hash mismatch", 409);
                }
                const fd = fs.openSync(tmp, "r+");
                try {
                  fs.fsyncSync(fd);
                } finally {
                  fs.closeSync(fd);
                }
                fs.renameSync(tmp, file);
                syncDirectory(s.objects);
              }
              return { complete, offset: offset + data.length };
            }),
          );
        }
      }
      if (req.method === "POST") {
        const b = await jsonBody();
        checkCredential();
        if (route === "/v1/settings") {
          requireAdmin();
          if (
            typeof b.name !== "string" ||
            !b.name.trim() ||
            b.name.length > 100 ||
            /[\x00-\x1f]/.test(b.name)
          )
            fail("Machine name must contain 1–100 printable characters");
          config.name = b.name.trim();
          s.saveConfig();
          engine.lastReport = null;
          await engine.reportMachine(true);
          return send(200, { name: config.name });
        }
        if (route === "/v1/web-sessions/revoke") {
          requireAdmin();
          web.sessions.clear();
          return send(200, { revoked: true });
        }
        if (route === "/v1/leave") {
          requireHub();
          if (admin) fail("Use a linked machine credential to disconnect", 403);
          await authorizedWork(() => s.forgetDevice(device.id));
          return send(200, { disconnected: true });
        }
        if (route === "/v1/machine-report") {
          requireHub();
          if (admin) fail("Use a linked machine credential to report", 403);
          return send(200, acceptReport(s, device, b));
        }
        if (route === "/v1/snapshot-release") {
          requireHub();
          const active = s.db
            .prepare("SELECT id FROM snapshot_sessions WHERE id=? AND owner=?")
            .get(b.session, device.id);
          if (active) {
            s.db
              .prepare("DELETE FROM snapshot_files WHERE session=?")
              .run(b.session);
            s.db
              .prepare("DELETE FROM snapshot_sessions WHERE id=?")
              .run(b.session);
          }
          return send(200, { ok: true });
        }
        if (route === "/v1/backup-ack") {
          requireHub();
          if (admin) fail("Device credential required", 403);
          const highest = s.db
            .prepare("SELECT COALESCE(MAX(rev),0) AS n FROM revisions")
            .get().n;
          if (
            typeof b.enabled !== "boolean" ||
            (b.enabled &&
              (!Number.isSafeInteger(b.revision) ||
                b.revision < 0 ||
                b.revision > highest))
          )
            fail("Invalid backup acknowledgement");
          s.db
            .prepare(
              "INSERT INTO backup_ack VALUES(?,?,?,?) ON CONFLICT(device) DO UPDATE SET revision=MAX(revision,excluded.revision),enabled=excluded.enabled,updated=excluded.updated",
            )
            .run(
              device.id,
              b.revision || 0,
              b.enabled ? 1 : 0,
              new Date().toISOString(),
            );
          return send(200, { ok: true });
        }
        if (route === "/v1/propose") {
          requireHub();
          if (device.role === "backup") fail("Backup cannot write", 403);
          return send(
            200,
            await authorizedWork(() => engine.propose(b, device)),
          );
        }
        if (route === "/v1/conflict-choice") {
          if (config.role !== "hub") {
            requireAdmin();
            if (!s.volume(b.volume).selected)
              fail(
                "Select this folder for synchronization before resolving conflicts.",
                409,
              );
            await engine.reportMachine(true);
            return send(200, await engine.json("/v1/conflict-choice", b));
          }
          if (device?.role === "backup")
            fail("Backup cannot restore upstream", 403);
          if (!admin) {
            const report = s.db
              .prepare("SELECT report FROM machine_reports WHERE device=?")
              .get(device.id);
            if (
              !report ||
              !JSON.parse(report.report).folderIds?.includes(b.volume)
            )
              fail(
                "Select this folder for synchronization before resolving conflicts.",
                409,
              );
          }
          const marker =
            typeof b.path === "string" ? b.path.lastIndexOf(".conflict-") : -1;
          if (marker < 1 || !["original", "conflict"].includes(b.choice))
            fail("Invalid conflict selection");
          return send(
            200,
            await authorizedWork(() => {
              const originalPath = b.path.slice(0, marker);
              const original = s.current(b.volume, originalPath),
                conflict = s.current(b.volume, b.path);
              if (
                !conflict ||
                conflict.deleted ||
                !original ||
                original.rev !== b.originalRev ||
                conflict.rev !== b.conflictRev
              )
                fail("Files changed. Review the conflict again.", 409);
              const chosen = b.choice === "original" ? original : conflict;
              if (chosen.deleted)
                fail("Choose a version with file content", 409);
              return s.commit(
                b.volume,
                originalPath,
                chosen,
                device?.id || config.id,
                true,
                original.hash,
                { path: b.path, rev: conflict.rev, choice: b.choice },
              );
            }),
          );
        }
        if (route === "/v1/restore") {
          if (device.role === "backup")
            fail("Backup cannot restore upstream", 403);
          return send(
            200,
            await authorizedWork(() => engine.restore(b.volume, b.path, b.rev)),
          );
        }
        requireAdmin();
        if (route === "/v1/promote")
          return send(
            200,
            await authorizedWork(() => engine.promote(b.confirmed === true)),
          );
        if (route === "/v1/locate-folder") {
          const located = await authorizedWork(() => {
            const v = s.volume(b.id);
            let available = true;
            try {
              s.assertVolume(v);
            } catch {
              available = false;
            }
            if (available)
              fail(
                "The current folder is available. Use Change location to move it.",
                409,
              );
            const location = s.resolveLocation(b.path);
            const marker = path.join(location, ".arca-volume");
            if (
              !fs.existsSync(marker) ||
              fs.readFileSync(marker, "utf8") !== v.id
            )
              fail(
                "Choose the original folder with its matching Arca marker. Files are not created or replaced.",
                409,
              );
            return s.addVolume(v.name, location, v.id);
          });
          setImmediate(tick);
          return send(200, located);
        }
        if (route === "/v1/move-folder")
          return send(
            200,
            await authorizedWork(() => moveFolder(engine, b.id, b.path)),
          );
        if (route === "/v1/retention") {
          requireHub();
          return send(
            200,
            await authorizedWork(() => {
              const plan = retentionPlan(s, b),
                confirmation = digest(JSON.stringify(plan));
              if (!b.apply)
                return {
                  remove: plan.remove.length,
                  retained: plan.retained,
                  protected: plan.protected,
                  folders: plan.folders,
                  hasBackup: plan.hasBackup,
                  confirmation,
                };
              if (b.confirmation !== confirmation)
                fail(
                  "History changed. Preview retention again before applying.",
                  409,
                );
              const result = applyRetention(s, b);
              config.retention = { days: plan.days, versions: plan.versions };
              s.saveConfig();
              return result;
            }),
          );
        }
        if (route === "/v1/backup")
          return send(
            200,
            await authorizedWork(() =>
              engine.configureBackup(b.enabled, b.path),
            ),
          );
        if (route === "/v1/network/lan")
          return send(200, await network.setLanHttp(b.enabled));
        if (route === "/v1/network")
          return send(200, await network.setMode(b.mode));
        if (route === "/v1/client") {
          network.heartbeat(b.kind);
          return send(200, { ok: true });
        }
        if (route === "/v1/sync") {
          if (engine.paused) fail("Resume synchronization first", 409);
          if (b.background === true) {
            setImmediate(() => tick(true));
            return send(202, { accepted: true });
          }
          await authorizedWork(() => engine.cycle());
          return send(200, engine.status());
        }
        if (route === "/v1/pause") {
          if (
            b.seconds !== undefined &&
            (!Number.isSafeInteger(b.seconds) ||
              b.seconds < 1 ||
              b.seconds > 86400)
          )
            fail("Invalid pause duration");
          engine.paused = Boolean(b.paused);
          if (engine.paused) engine.scanner.interrupt();
          engine.pauseUntil =
            engine.paused && b.seconds ? Date.now() + b.seconds * 1000 : null;
          return send(200, engine.status());
        }
        if (route === "/v1/path-check") {
          const location = s.resolveLocation(b.path);
          if (
            location === s.home ||
            s.home.startsWith(location + path.sep) ||
            (location.startsWith(s.home + path.sep) &&
              !location.startsWith(config.root + path.sep))
          )
            fail("State and volume paths overlap");
          for (const v of s.volumes()) {
            if (
              v.id !== b.id &&
              (v.path === location ||
                v.path.startsWith(location + path.sep) ||
                location.startsWith(v.path + path.sep))
            )
              fail(
                v.path === location
                  ? fs.existsSync(location)
                    ? `Already linked to "${v.name}". Choose another folder.`
                    : `The directory is missing, but "${v.name}" is still registered in Arca. Its catalog and history were retained. Deleting the directory does not remove the share.`
                  : `This folder overlaps "${v.name}" (${v.path}). Choose a folder outside that share; parent and child folders cannot be shared separately.`,
              );
          }
          let ancestor = location;
          while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
          if (!fs.statSync(ancestor).isDirectory()) fail("Choose a directory");
          try {
            fs.accessSync(
              ancestor,
              fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
            );
          } catch {
            fail(
              fs.existsSync("/.dockerenv")
                ? `This folder is not accessible inside Docker. Mount the host folder at ${location} and allow the Arca user to read and write it.`
                : `Arca cannot read or write ${location}. Check this folder’s permissions.`,
              403,
            );
          }
          const disk = fs.statfsSync(ancestor);
          return send(200, {
            path: location,
            exists: fs.existsSync(location),
            writable: true,
            freeBytes: disk.bavail * disk.bsize,
            ...(b.preview === true
              ? { preview: await folderPreview(location) }
              : {}),
          });
        }
        if (route === "/v1/rename-share" || route === "/v1/ignore-policy") {
          requireAdmin();
          requireHub();
          return send(
            200,
            await authorizedWork(() =>
              route === "/v1/rename-share"
                ? engine.renameShare(b.id, b.name)
                : engine.saveIgnorePolicy(b.id, b.text, b.version),
            ),
          );
        }
        if (route === "/v1/volumes") {
          return send(
            201,
            await authorizedWork(() =>
              engine.publish(b.name, b.path, b.createIgnore ?? false),
            ),
          );
        }
        if (route === "/v1/select")
          return send(
            200,
            await authorizedWork(() => engine.select(b.id, b.path)),
          );
        if (route === "/v1/delete-share") {
          requireHub();
          const v = s.volume(b.id);
          if (b.confirmedName !== v.name)
            fail("Type the share name to confirm deletion", 400);
          engine.stopVolumes.add(b.id);
          engine.scanner.interrupt();
          try {
            return send(
              200,
              await authorizedWork(() => {
                const result = s.forgetVolume(b.id);
                engine.folderStates.delete(b.id);
                return result;
              }),
            );
          } finally {
            engine.stopVolumes.delete(b.id);
          }
        }
        if (route === "/v1/unselect") {
          if (config.role === "backup") fail("Backup keeps every folder");
          s.volume(b.id);
          engine.stopVolumes.add(b.id);
          engine.scanner.interrupt();
          try {
            return send(
              200,
              await authorizedWork(() => {
                if (config.role === "replica") s.forgetVolume(b.id);
                else
                  s.db
                    .prepare("UPDATE volumes SET selected=0 WHERE id=?")
                    .run(b.id);
                engine.folderStates.delete(b.id);
                void engine.reportMachine(true);
                return { retained: true };
              }),
            );
          } finally {
            engine.stopVolumes.delete(b.id);
          }
        }
        if (route === "/v1/pairing") {
          requireHub();
          if (typeof b.name !== "string" || !b.name.trim())
            fail("Machine name is required");
          const previous = new Set(
            s.db
              .prepare("SELECT code_hash FROM pairing")
              .all()
              .map((r) => r.code_hash),
          );
          try {
            const webCode = JSON.parse(
              fs.readFileSync(path.join(s.home, "web-code.json"), "utf8"),
            );
            if (webCode.expires > Date.now()) previous.add(webCode.hash);
          } catch {}
          let code;
          do {
            code = shortCode();
          } while (previous.has(digest(code)));
          const expires = Date.now() + 600000;
          s.db.exec("BEGIN IMMEDIATE");
          try {
            s.db.prepare("DELETE FROM pairing").run();
            s.db
              .prepare("DELETE FROM auth_failures WHERE purpose='pair'")
              .run();
            s.db
              .prepare("INSERT INTO pairing VALUES(?,?,?)")
              .run(
                digest(normalizeCode(code, "P")),
                b.name.trim().slice(0, 100),
                expires,
              );
            s.db.exec("COMMIT");
          } catch (e) {
            s.db.exec("ROLLBACK");
            throw e;
          }
          return send(201, { code, expires });
        }
        if (route === "/v1/devices") {
          requireHub();
          const role = b.role || "replica";
          if (
            !["replica", "backup"].includes(role) ||
            typeof b.name !== "string" ||
            !b.name.trim()
          )
            fail("Invalid machine");
          const id = crypto.randomUUID();
          const secret = token();
          s.db
            .prepare(
              "INSERT INTO devices(id,name,token_hash,role) VALUES(?,?,?,?)",
            )
            .run(id, b.name.trim().slice(0, 100), digest(secret), role);
          return send(201, { id, name: b.name, role, token: secret });
        }
        if (route === "/v1/revoke") {
          requireHub();
          requireAdmin();
          if (typeof b.id !== "string" || !b.id)
            fail("Machine ID required", 400);
          await authorizedWork(() => s.forgetDevice(b.id));
          return send(200, { revoked: true, removed: true });
        }
        if (route === "/v1/disconnect") {
          requireAdmin();
          if (b.confirmed !== true) fail("Confirm disconnection first", 400);
          return send(200, await engine.disconnect());
        }
        if (route === "/v1/connect") {
          requireAdmin();
          if (config.role === "hub")
            fail("A hub cannot connect as a replica", 409);
          if (
            config.hub &&
            (s.volumes().length || config.backup?.path) &&
            !b.reconcile
          )
            fail(
              "Use replacement-hub reconciliation to preserve existing folders",
              409,
            );
          let remote = new URL(b.url);
          if (
            !["http:", "https:"].includes(remote.protocol) ||
            remote.username ||
            remote.password ||
            remote.search ||
            remote.hash
          )
            fail("Invalid hub URL");
          if (
            remote.protocol === "http:" &&
            !["localhost", "127.0.0.1", "[::1]"].includes(remote.hostname) &&
            !b.privateNetwork
          )
            remote = lanAddress(remote.hostname)
              ? await verifiedLanURL(remote)
              : await verifiedTailnetURL(
                  remote,
                  await network.detector.read(true),
                );
          if (b.code) {
            const paired = await fetch(`${remote.origin}/pair`, {
              redirect: "error",
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: b.code }),
              signal: AbortSignal.timeout(10000),
            });
            if (!paired.ok)
              fail("Pairing code expired, already used or refused", 401);
            b.token = (await paired.json()).token;
          }
          if (!/^[a-f0-9]{64}$/.test(b.token || ""))
            fail("Invalid machine token");
          const response = await fetch(`${remote.origin}/v1/catalog`, {
            redirect: "error",
            headers: { Authorization: `Bearer ${b.token}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) fail("Hub refused credential", 401);
          const catalog = await response.json();
          if (catalog.protocol !== 1) fail("Unsupported hub protocol");
          await authorizedWork(() => {
            const prior = config.hub || config.disconnectedHub;
            if (
              prior &&
              prior.id !== catalog.id &&
              !b.reconcile &&
              s.volumes().length
            )
              fail(
                "Reconnect to the original hub. Use replacement-hub recovery to switch existing folders safely.",
                409,
              );
            if (b.reconcile) {
              if (config.backup?.enabled)
                fail(
                  "Disable backup before reconnecting to a replacement hub",
                  409,
                );
              if (
                s
                  .volumes()
                  .some(
                    (v) =>
                      !catalog.volumes.some((remote) => remote.id === v.id),
                  )
              )
                fail("Replacement hub is missing known shared folders", 409);
              s.recover();
              const checkpoint = path.join(
                s.home,
                `before-reconnect-${crypto.randomUUID()}.sqlite`,
              );
              s.db.exec(`VACUUM INTO '${checkpoint.replaceAll("'", "''")}'`);
              fs.chmodSync(checkpoint, 0o600);
              const next = {
                ...config,
                hub: {
                  url: remote.origin,
                  token: b.token,
                  id: catalog.id,
                  name: catalog.name,
                },
                catalog: catalog.volumes.map((v) => ({
                  id: v.id,
                  name: v.name,
                })),
              };
              delete next.disconnectedHub;
              if (config.backup?.path)
                next.backup = {
                  enabled: false,
                  previousLocation: config.backup.path,
                };
              const id = crypto.randomUUID(),
                journal = path.join(s.home, "promotion.json");
              atomic(journal, JSON.stringify({ id, config: next }));
              s.db.exec("BEGIN IMMEDIATE");
              try {
                s.db.exec(
                  "DELETE FROM files; DELETE FROM pending; DELETE FROM proposals; DELETE FROM sync_state; DELETE FROM sync_dirty;",
                );
                s.db.prepare("INSERT INTO transitions VALUES(?)").run(id);
                s.db.exec("COMMIT");
              } catch (e) {
                s.db.exec("ROLLBACK");
                throw e;
              }
              delete config.disconnectedHub;
              Object.assign(config, next);
              s.saveConfig();
              fs.unlinkSync(journal);
              return;
            }
            config.hub = {
              url: remote.origin,
              token: b.token,
              id: catalog.id,
              name: catalog.name,
            };
            delete config.disconnectedHub;
            config.catalog = catalog.volumes.map((v) => ({
              id: v.id,
              name: v.name,
            }));
            for (const v of s.volumes().filter((v) => v.selected))
              engine.work.mark(v.id);
            s.saveConfig();
          });
          return send(200, { connected: true, name: catalog.name });
        }
      }
      fail("Endpoint not found", 404);
    } catch (e) {
      if (!res.headersSent) send(e.status || 500, { error: e.message });
      else res.destroy();
    }
  });
  network.apiHandler = server.listeners("request")[0];
  server.requestTimeout = 65000;
  const host = options.host ?? config.host;
  if (
    !["127.0.0.1", "localhost", "::1"].includes(host) &&
    !options.privateNetwork
  ) {
    engine.close();
    fs.unlinkSync(lock);
    fail(
      "Non-loopback binding requires --private-network (Tailscale, TLS proxy, or explicitly enabled local network HTTP)",
    );
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? config.port, host, resolve);
    });
  } catch (e) {
    engine.close();
    fs.unlinkSync(lock);
    throw e;
  }
  network.port = server.address().port;
  engine.listeningPort = network.port;
  network.mainHost = host;
  await network.start();
  const watchers = new Map();
  const events = new Map();
  const flushEvents = () => {
    if (!events.size) return;
    s.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [volume, names] of events)
        for (const name of names) engine.work.mark(volume, name);
      s.db.exec("COMMIT");
      events.clear();
    } catch (e) {
      s.db.exec("ROLLBACK");
      throw e;
    }
  };
  let stopping = false,
    running = false,
    changedTimer,
    timer,
    lastActivity = Date.now(),
    failures = 0,
    rerun = false,
    requestedFull = false,
    retryAt = 0;
  const schedule = (delay) => {
    if (stopping || options.timer === false) return;
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  };
  const watchFolders = () => {
    const selected = s.volumes().filter((v) => v.selected && v.path);
    const paths = new Set(selected.map((v) => v.path));
    for (const [folder, w] of watchers)
      if (!paths.has(folder)) {
        w.close();
        watchers.delete(folder);
      }
    for (const folder of paths)
      if (!watchers.has(folder)) {
        try {
          const volume = selected.find((v) => v.path === folder);
          engine.work.mark(volume.id); // Startup/new selections may have missed events.
          let ignored = s.ignoreRules(volume);
          const w = fs.watch(
            folder,
            { recursive: true },
            (_event, filename) => {
              if (stopping) return;
              const name = filename
                ? String(filename).split(path.sep).join("/")
                : "";
              if (name.split("/").some((p) => p.startsWith(".arca-"))) return;
              if (!name || name === ".arcaignore") {
                try {
                  ignored = s.ignoreRules(volume);
                } catch {
                  ignored = () => false;
                }
              } else if (ignored(name)) return;
              let names = events.get(volume.id);
              if (!names) events.set(volume.id, (names = new Set()));
              if (!names.has("")) names.add(name);
              if (!name || name === ".arcaignore" || names.size > 2048) {
                names.clear();
                names.add("");
              }
              clearTimeout(changedTimer);
              changedTimer = setTimeout(tick, 1000);
            },
          );
          w.on("error", () => {
            engine.work.mark(volume.id);
            schedule(1000);
            w.close();
            watchers.delete(folder);
          });
          watchers.set(folder, w);
        } catch {
          /* Periodic scans remain the correctness fallback. */
        }
      }
  };
  const tick = async (forceFull = false) => {
    if (stopping) return;
    if (forceFull) {
      requestedFull = true;
      retryAt = 0;
    }
    if (Date.now() < retryAt) {
      schedule(retryAt - Date.now());
      return;
    }
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    const activity = engine.activity;
    const full = requestedFull;
    requestedFull = false;
    try {
      flushEvents();
      await engine.exclusive(() => engine.cycle({ incremental: !full }));
      failures = engine.error ? Math.min(failures + 1, 5) : 0;
      if (engine.activity !== activity) lastActivity = Date.now();
    } catch (error) {
      engine.error = error.message;
      failures = Math.min(failures + 1, 5);
    } finally {
      running = false;
      if (!stopping && options.timer !== false) {
        watchFolders();
        const normal =
          config.role === "hub" || Date.now() - lastActivity >= IDLE_AFTER_MS
            ? IDLE_POLL_MS
            : ACTIVE_POLL_MS;
        retryAt = failures
          ? Date.now() + Math.min(300000, ACTIVE_POLL_MS * 2 ** failures)
          : 0;
        const pending =
          !engine.paused &&
          s.db
            .prepare(
              "SELECT 1 FROM sync_dirty d JOIN volumes v ON v.id=d.volume WHERE v.selected=1 LIMIT 1",
            )
            .get();
        schedule(
          failures
            ? Math.min(300000, ACTIVE_POLL_MS * 2 ** failures)
            : rerun || pending
              ? 1000
              : normal,
        );
        rerun = false;
      }
    }
  };
  if (options.timer !== false) {
    watchFolders();
    tick();
    server.on("request", (req, res) => {
      if (
        req.method === "POST" &&
        [
          "/v1/volumes",
          "/v1/select",
          "/v1/unselect",
          "/v1/delete-share",
          "/v1/ignore-policy",
          "/v1/pause",
          "/v1/move",
          "/v1/connect",
        ].includes(req.url?.split("?")[0])
      )
        res.once("finish", () => {
          if (res.statusCode < 300 && !stopping) {
            watchFolders();
            schedule(1000);
          }
        });
    });
  }
  return {
    engine,
    network,
    server,
    port: server.address().port,
    async close() {
      stopping = true;
      clearTimeout(changedTimer);
      for (const w of watchers.values()) w.close();
      flushEvents();
      clearTimeout(timer);
      await network.close();
      await new Promise((resolve) => server.close(resolve));
      await engine.tail;
      engine.close();
      fs.unlinkSync(lock);
    },
  };
}
