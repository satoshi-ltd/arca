import { shortCode, normalizeCode, Attempts } from "./codes.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { token, digest, atomic, fail, runtimeInstallation } from "./storage.js";

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
    this.sessions = new Map();
    this.attempts = new Attempts();
  }
  sameOrigin(req) {
    if (this.publicOrigin)
      return (
        req.headers.origin === this.publicOrigin &&
        req.headers.host === this.publicHost
      );
    return (
      req.headers.origin ===
      `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`
    );
  }
  session(req) {
    const cookie = /(?:^|;\s*)arca_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
    for (const [key, expiry] of this.sessions)
      if (expiry < Date.now()) this.sessions.delete(key);
    return cookie && this.sessions.has(digest(cookie));
  }
  async handle(req, res, readBody) {
    const url = new URL(req.url, "http://localhost");
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
      const session = token();
      if (this.sessions.size >= 100)
        this.sessions.delete(this.sessions.keys().next().value);
      this.sessions.set(digest(session), Date.now() + 86400000);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": `arca_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.socket.encrypted || this.publicOrigin ? "; Secure" : ""}`,
      });
      res.end('{"ok":true}');
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
      "/style.css": "style.css",
      "/tokens.css": "tokens.css",
      "/vendor/lucide.js": "vendor/lucide.js",
      "/assets/arca-icon.svg": "assets/arca-icon.svg",
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
