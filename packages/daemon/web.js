import { shortCode, normalizeCode, Attempts } from "./codes.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { token, digest, atomic, fail, runtimeInstallation } from "./storage.js";

export function browserLabel(agent) {
  const browser = /Edg(?:e|A|iOS)?\//.test(agent)
    ? "Edge"
    : /(?:Firefox|FxiOS)\//.test(agent)
      ? "Firefox"
      : /(?:Chrome|CriOS)\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const os = /iPad|iPhone|iPod/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Windows/.test(agent)
        ? "Windows"
        : /Macintosh|Mac OS X/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

export function hostName(header) {
  if (typeof header !== "string" || /[@/\\?#\s]/.test(header)) return "";
  try {
    return new URL(`http://${header}`).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
  } catch {
    return "";
  }
}
export function trustedHost(header, extra = []) {
  const name = hostName(header);
  return Boolean(
    name &&
      (isIP(name) ||
        !name.includes(".") ||
        name.endsWith(".local") ||
        extra.includes(name)),
  );
}

export function issueWebCode(home) {
  const config = JSON.parse(
    fs.readFileSync(path.join(home, "config.json"), "utf8"),
  );
  if (runtimeInstallation === "desktop" || config.installation === "desktop")
    fail("Web access is not available in the desktop installation", 404);
  let previous;
  try {
    previous = JSON.parse(
      fs.readFileSync(path.join(home, "web-code.json"), "utf8"),
    ).hash;
  } catch {}
  const excluded = new Set([previous]);
  let db;
  try {
    const file = path.join(home, "index.sqlite");
    if (fs.existsSync(file)) {
      db = new DatabaseSync(file, { readOnly: true });
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='pairing'",
          )
          .get()
      )
        for (const row of db
          .prepare("SELECT code_hash FROM pairing WHERE expires>?")
          .all(Date.now()))
          excluded.add(row.code_hash);
    }
  } finally {
    db?.close();
  }
  let code;
  do {
    code = shortCode();
  } while (excluded.has(digest(code)));
  atomic(
    path.join(home, "web-code.json"),
    JSON.stringify({
      hash: digest(normalizeCode(code, "W")),
      expires: Date.now() + 600000,
      failures: 0,
    }),
  );
  return { code, expiresInMinutes: 10 };
}
export class Web {
  constructor(home, publicOrigin) {
    this.home = home;
    if (publicOrigin) {
      const url = new URL(publicOrigin);
      if (
        url.protocol !== "https:" ||
        url.origin !== publicOrigin ||
        url.username ||
        url.password
      )
        fail("Web origin must be an HTTPS origin without a path");
      this.publicOrigin = url.origin;
      this.publicHost = url.host;
    }
    this.trustedHosts = () => [];
    this.sessions = new Map();
    this.requests = new Map();
    this.requestAttempts = new Attempts();
    this.attempts = new Attempts();
  }
  pending() {
    for (const [id, request] of this.requests)
      if (request.expires <= Date.now()) this.requests.delete(id);
    return [...this.requests.values()]
      .filter((r) => r.state === "pending")
      .map(({ secret, ...r }) => r);
  }
  decide(id, decision, approver) {
    this.pending();
    const r = this.requests.get(id);
    if (!r || r.state !== "pending") fail("This request has ended", 409);
    if (!["allow", "deny"].includes(decision)) fail("Invalid decision", 400);
    r.state = decision === "allow" ? "approved" : "denied";
    r.approver = approver;
    return { state: r.state };
  }
  endApprover(id) {
    for (const [key, entry] of this.sessions)
      if (entry.approver === id) this.sessions.delete(key);
    for (const [key, request] of this.requests)
      if (request.approver === id) this.requests.delete(key);
  }
  grant(req, res, approver) {
    const session = token();
    if (this.sessions.size >= 100)
      this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(digest(session), { expiry: Date.now() + 86400000, approver });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": `arca_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.socket.encrypted || this.publicOrigin ? "; Secure" : ""}`,
    });
    res.end('{"ok":true,"state":"approved"}');
  }
  hostAllowed(req) {
    if (this.publicOrigin) return req.headers.host === this.publicHost;
    return trustedHost(req.headers.host, this.trustedHosts());
  }
  sameOrigin(req) {
    if (this.publicOrigin)
      return (
        req.headers.origin === this.publicOrigin &&
        req.headers.host === this.publicHost
      );
    return (
      this.hostAllowed(req) &&
      req.headers.origin ===
        `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`
    );
  }
  session(req) {
    if (!this.hostAllowed(req)) return false;
    const cookie = /(?:^|;\s*)arca_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
    for (const [key, entry] of this.sessions)
      if (entry.expiry < Date.now()) this.sessions.delete(key);
    return cookie && this.sessions.has(digest(cookie));
  }
  async handle(req, res, readBody) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/auth/approval" && req.method === "POST") {
      if (!this.sameOrigin(req)) fail("Invalid browser origin", 403);
      let input;
      try {
        input = JSON.parse((await readBody(req, 4096)).toString());
      } catch {
        fail("Invalid request", 400);
      }
      if (!input || typeof input !== "object") fail("Invalid request", 400);
      this.pending();
      const reply = (data) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(data));
      };
      if (input.action === "create") {
        this.requestAttempts.check(req.socket.remoteAddress);
        if (!this.hasApprovers?.())
          fail("No devices can approve access. Use a sign-in code.", 409);
        if (this.requests.size >= 50) fail("Too many pending requests", 429);
        const address = req.socket.remoteAddress?.replace(/^::ffff:/, "") || "";
        let mine = 0;
        for (const pending of this.requests.values())
          if (pending.ip === address) mine++;
        if (mine >= 3) fail("Too many pending requests from this address", 429);
        const secret = token(),
          id = token(),
          created = Date.now();
        const r = {
          id,
          secret: digest(secret),
          reference: shortCode(),
          state: "pending",
          created,
          expires: created + 600000,
          ip: req.socket.remoteAddress?.replace(/^::ffff:/, "") || "",
          host: String(req.headers.host).slice(0, 255),
          agent: String(req.headers["user-agent"] || "Unknown browser").slice(
            0,
            256,
          ),
        };
        r.browser = browserLabel(r.agent);
        this.requests.set(id, r);
        return (
          reply({ id, secret, reference: r.reference, expires: r.expires }),
          true
        );
      }
      const r = this.requests.get(input.id);
      if (
        !r ||
        typeof input.secret !== "string" ||
        digest(input.secret) !== r.secret
      )
        return (reply({ state: "ended" }), true);
      if (input.action === "cancel") {
        this.requests.delete(r.id);
        return (reply({ state: "cancelled" }), true);
      }
      if (input.action !== "poll") fail("Invalid request", 400);
      if (r.state === "approved") {
        this.requests.delete(r.id);
        if (!this.canRedeem?.(r.approver))
          return (reply({ state: "ended" }), true);
        this.grant(req, res, r.approver);
        return true;
      }
      return (reply({ state: r.state }), true);
    }
    if (url.pathname === "/auth/login" && req.method === "POST") {
      if (!this.sameOrigin(req)) fail("Invalid browser origin", 403);
      const ip = req.socket.remoteAddress;
      this.attempts.check(ip);
      let input;
      try {
        input = JSON.parse((await readBody(req, 4096)).toString());
      } catch {
        fail("Invalid login request", 400);
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        fail("Invalid login request", 400);
      let saved;
      try {
        saved = JSON.parse(
          fs.readFileSync(path.join(this.home, "web-code.json")),
        );
      } catch {}
      if (
        !saved ||
        saved.expires < Date.now() ||
        typeof input.code !== "string" ||
        !normalizeCode(input.code, "W") ||
        digest(normalizeCode(input.code, "W")) !== saved.hash
      ) {
        if (saved && saved.expires >= Date.now()) {
          saved.failures = (saved.failures || 0) + 1;
          if (saved.failures >= 5) {
            fs.unlinkSync(path.join(this.home, "web-code.json"));
            fail(
              "Sign-in code invalidated after five failed attempts. Generate a new code.",
              429,
            );
          }
          atomic(path.join(this.home, "web-code.json"), JSON.stringify(saved));
        }
        fail("Invalid, expired or already-used sign-in code", 401);
      }
      fs.unlinkSync(path.join(this.home, "web-code.json"));
      this.grant(req, res);
      return true;
    }
    if (url.pathname === "/auth/logout" && req.method === "POST") {
      if (!this.sameOrigin(req)) fail("Invalid browser origin", 403);
      const cookie = /(?:^|;\s*)arca_session=([a-f0-9]{64})/.exec(
        req.headers.cookie || "",
      )?.[1];
      if (cookie) this.sessions.delete(digest(cookie));
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie":
          "arca_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
      res.end('{"ok":true}');
      return true;
    }
    const assets = {
      "/": "index.html",
      "/app.js": "app.js",
      "/notice-contract.js": "notice-contract.js",
      "/file-icons.js": "file-icons.js",
      "/music-library.js": "music-library.js",
      "/video-library.js": "video-library.js",
      "/favorite-order.js": "favorite-order.js",
      "/gallery-timeline-layout.js": "gallery-timeline-layout.js",
      "/style.css": "style.css",
      "/tokens.css": "tokens.css",
      "/vendor/lucide.js": "vendor/lucide.js",
      "/assets/arca-icon.svg": "assets/arca-icon.svg",
      "/assets/arca-icon-small.svg": "assets/arca-icon-small.svg",
      "/assets/fonts/instrument-sans.woff2":
        "assets/fonts/instrument-sans.woff2",
      "/assets/fonts/fragment-mono.woff2": "assets/fonts/fragment-mono.woff2",
    };
    if (req.method === "GET" && assets[url.pathname]) {
      const file = fileURLToPath(
        new URL(
          `../../apps/desktop/src/${assets[url.pathname]}`,
          import.meta.url,
        ),
      );
      res.writeHead(200, {
        "Content-Type": url.pathname.endsWith(".woff2")
          ? "font/woff2"
          : url.pathname.endsWith(".svg")
            ? "image/svg+xml"
            : url.pathname.endsWith(".js")
              ? "text/javascript"
              : url.pathname.endsWith(".css")
                ? "text/css"
                : "text/html",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
      });
      res.end(fs.readFileSync(file));
      return true;
    }
    return false;
  }
}
