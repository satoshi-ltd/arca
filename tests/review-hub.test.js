import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("the review hub's proxy serves every route the phone calls and nothing else of the hub", () => {
  const all = read("deploy", "review", "arca-review.sh");
  const script = all.slice(all.indexOf("listen 443 ssl;"));
  const locations = [...script.matchAll(/^\s*location\s+(=\s*)?(\S+)\s*\{/gm)].map(([, exact, where]) => (exact ? "=" : "") + where);
  const client = read("apps", "mobile", "src", "client.js");
  const guard = client.match(/if \(!route\.startsWith\("(\/[^"]+)"\)((?: && route !== "\/[^"]+")*)\)/);
  assert.ok(guard, "client.js keeps its route guard");
  const extra = [...guard[2].matchAll(/route !== "(\/[^"]+)"/g)].map(([, route]) => route);
  assert.ok(locations.includes(guard[1]), `${guard[1]} is proxied`);
  for (const route of extra) assert.ok(locations.includes(`=${route}`), `${route} is proxied`);
  assert.match(read("apps", "mobile", "src", "network-policy.js"), /\/\.well-known\/arca/);
  assert.ok(locations.includes("=/.well-known/arca"));
  assert.ok(locations.includes("=/review"), "the pairing page");
  assert.deepEqual(
    locations.filter((where) => !["=/review", "=/.well-known/arca", "/.well-known/acme-challenge/", "/", guard[1], ...extra.map((route) => `=${route}`)].includes(where)),
    [],
    "no other hub route is published",
  );
  assert.match(script, /location \/ \{\s*return 404;/, "the web administration stays private");
});

test("the review hub runs isolated and its site admits only Cloudflare, without backslashes or printed secrets", () => {
  const script = read("deploy", "review", "arca-review.sh");
  const hub = script.slice(script.indexOf("ExecStart=/usr/bin/docker run"), script.indexOf("ExecStop="));
  for (const flag of ["--init", "--user", "--read-only", "--cap-drop ALL", "no-new-privileges", "--memory 512m", "--pids-limit", "-p 127.0.0.1:"])
    assert.ok(hub.includes(flag), flag);
  assert.match(script, /iptables -A ARCA-REVIEW-OUT -j DROP/);
  assert.match(script, /iptables -A ARCA-REVIEW-IN -j DROP/);
  assert.match(script, /if \(\\\$arca_review_via_cloudflare = 0\) \{\s*return 403;/);
  assert.match(script, /if \(\\\$request_uri ~ "\\\\x5c\|%5\[cC\]"\) \{\s*return 400;/);
  assert.match(script, /location = \/pair \{\s*limit_req zone=arca_review_pair/);
  assert.match(script, /chmod 0600 "\$DISK"/);
  assert.match(script, /openssl passwd -apr1 -stdin/);
  assert.doesNotMatch(script, /cat "\$CREDENTIALS"/);
  const up = script.slice(script.indexOf("\nup() {"));
  assert.ok(up.indexOf("allowLanHttp: true") > 0 && up.indexOf("allowLanHttp: true") < up.indexOf("systemctl restart arca-review.service"),
    "a fresh hub allows LAN HTTP before the daemon starts, or every phone behind nginx gets 412");
  for (const file of ["seed.mjs", "admin.cjs"])
    assert.equal(spawnSync(process.execPath, ["--check", path.join(root, "deploy", "review", file)]).status, 0, file);
});

test("the review kit makes admin calls on the hub's own loopback and the page never holds the admin token", () => {
  const script = read("deploy", "review", "arca-review.sh");
  const page = read("deploy", "review", "codes.py");
  assert.doesNotMatch(script, /admin-token/, "no copy of the admin token outside the hub's state");
  assert.doesNotMatch(page, /Authorization|adminToken|TOKEN/, "the page asks the socket for codes");
  assert.match(page, /AF_UNIX/);
  assert.match(script, /hub_admin\(\) \{ docker exec -i arca-review node - "\$1" <"\$KIT\/admin\.cjs"; \}/);
  assert.match(script, /docker exec -i arca-review node - code <\$KIT\/admin\.cjs/);
  assert.match(script, /SocketGroup=arca-review\nSocketMode=0660/);
  const seed = script.slice(script.indexOf('echo "Seeding sample content'));
  assert.match(seed, /^\s*docker run [^\n]*--network container:arca-review /m, "the seed runs in the hub's network namespace");
  assert.match(read("deploy", "review", "seed.mjs"), /"http:\/\/127\.0\.0\.1:17831"/);
  assert.match(read("deploy", "review", "admin.cjs"), /http:\/\/127\.0\.0\.1:17831/);
});
