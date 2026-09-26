#!/usr/bin/env node
import { inspectSetupRoot, initializeServer } from "../daemon/setup.js";
import { normalizeCode } from "../daemon/codes.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { issueWebCode } from "../daemon/web.js";
import { init } from "../daemon/storage.js";
import { start } from "../daemon/server.js";
import { recoverBackup } from "../daemon/recovery.js";

const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    options[key] = [
      "private-network",
      "reconcile",
      "confirm",
      "setup",
    ].includes(key)
      ? true
      : args[++i];
  } else positional.push(args[i]);
}
const [command, ...rest] = positional;
const home = path.resolve(
  options.home || process.env.ARCA_HOME || path.join(os.homedir(), ".arca"),
);
const print = (value) =>
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
try {
  if (!command || command === "help") {
    console.log(
      `Arca 0.6.0 — personal drive\n\n  init --role hub|replica --name NAME --root PATH [--port 17831]\n  daemon [--setup] [--host 127.0.0.1] [--port PORT] [--private-network]\n  network | discover | network-mode standalone|tailscale\n  status | sync | pause | resume\n  pair NAME (one-time machine pairing code)\n  move-folder FOLDER_ID NEW_PATH\n  promotion-plan | promote --confirm\n  retention --days N --versions N [--confirmation PREVIEW_DIGEST]\n  web-code\n  backup enable EMPTY_FOLDER | backup disable\n  add-folder NAME [PATH]\n  invite NAME   (prints a secret once)\n  connect URL --token-file PATH [--private-network]\n  catalog | select FOLDER_ID [LOCAL_PATH] | unselect FOLDER_ID\n  files FOLDER_ID | history FOLDER_ID FILE_PATH\n  restore FOLDER_ID FILE_PATH REVISION\n  revoke MACHINE_ID\n  recover-backup NEW_HOME (source backup is --home; both offline)\n\nAll commands accept --home PATH (default ~/.arca).\nUse --private-network for Tailscale, a TLS proxy, or a trusted LAN with HTTP explicitly enabled in hub Settings.\n`,
    );
  } else if (command === "setup-info") {
    print(inspectSetupRoot(options.root, home));
  } else if (command === "web-code") {
    print(issueWebCode(home));
  } else if (command === "recover-backup") {
    if (!rest[0])
      throw new Error(
        "Usage: recover-backup NEW_HOME --home STOPPED_BACKUP_HOME",
      );
    print(recoverBackup(home, path.resolve(rest[0])));
  } else if (command === "init") {
    if (options.role && !["hub", "replica"].includes(options.role))
      throw new Error("Choose hub or replica");
    const c = init(home, options);
    print({ home, id: c.id, role: c.role, root: c.root });
  } else if (command === "daemon") {
    if (options.setup)
      initializeServer(home, {
        root: options.root,
        port: options.port,
        host: options.host,
      });
    const daemon = await start(home, {
      host: options.host,
      port: options.port === undefined ? undefined : Number(options.port),
      privateNetwork: options["private-network"],
    });
    console.log(
      `Arca ${daemon.engine.config.role} listening on ${options.host || daemon.engine.config.host}:${daemon.port}`,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      daemon.engine.interruptCycle();
      await daemon.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (process.send) {
      process.send({ type: "arca-ready" });
      process.disconnect();
    }
  } else {
    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json")));
    const call = async (route, data) => {
      const response = await fetch(`http://127.0.0.1:${config.port}${route}`, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${config.adminToken}`,
          "Content-Type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(120000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    };
    const query = `/v1/history?volume=${encodeURIComponent(rest[0])}&path=${encodeURIComponent(rest[1])}`;
    switch (command) {
      case "pair":
        print(await call("/v1/pairing", { name: rest[0] }));
        break;
      case "move-folder":
        print(await call("/v1/move-folder", { id: rest[0], path: rest[1] }));
        break;
      case "promotion-plan":
        print(await call("/v1/promotion-plan"));
        break;
      case "promote":
        print(
          await call("/v1/promote", { confirmed: options.confirm === true }),
        );
        break;
      case "retention":
        print(
          await call("/v1/retention", {
            days: Number(options.days || 0),
            versions: Number(options.versions || 0),
            confirmation: options.confirmation,
            apply: !!options.confirmation,
          }),
        );
        break;
      case "network":
        print(await call("/v1/network"));
        break;
      case "discover":
        print(await call("/v1/discovery"));
        break;
      case "backup":
        if (!["enable", "disable"].includes(rest[0]))
          throw new Error("Usage: backup enable EMPTY_FOLDER | backup disable");
        print(
          await call("/v1/backup", {
            enabled: rest[0] === "enable",
            path: rest[1],
          }),
        );
        break;
      case "network-mode":
        print(await call("/v1/network", { mode: rest[0] }));
        break;
      case "status":
        print(await call("/v1/status"));
        break;
      case "sync":
        print(await call("/v1/sync", {}));
        break;
      case "pause":
      case "resume":
        print(await call("/v1/pause", { paused: command === "pause" }));
        break;
      case "add-folder":
        print(
          await call("/v1/volumes", {
            name: rest[0],
            path: rest[1] && path.resolve(rest[1]),
          }),
        );
        break;
      case "invite":
        print(
          await call("/v1/devices", {
            name: rest[0],
            role: options.role || "replica",
          }),
        );
        break;
      case "connect": {
        if (!options["token-file"])
          throw new Error("Use --token-file PATH (plain token or invite JSON)");
        const content = fs.readFileSync(options["token-file"], "utf8").trim();
        const secret = content.startsWith("{")
          ? JSON.parse(content).token || JSON.parse(content).code
          : content;
        print(
          await call("/v1/connect", {
            url: rest[0],
            ...(normalizeCode(secret, "P")
              ? { code: secret }
              : { token: secret }),
            reconcile: !!options.reconcile,
            privateNetwork: Boolean(options["private-network"]),
          }),
        );
        break;
      }
      case "catalog":
        print(await call(config.role === "hub" ? "/v1/catalog" : "/v1/remote"));
        break;
      case "select":
      case "unselect":
        print(
          await call(`/v1/${command}`, {
            id: rest[0],
            ...(command === "select" && rest[1]
              ? { path: path.resolve(rest[1]) }
              : {}),
          }),
        );
        break;
      case "files":
        print(await call(`/v1/files?volume=${encodeURIComponent(rest[0])}`));
        break;
      case "history":
        print(await call(query));
        break;
      case "restore":
        print(
          await call("/v1/restore", {
            volume: rest[0],
            path: rest[1],
            rev: Number(rest[2]),
          }),
        );
        break;
      case "revoke":
        print(await call("/v1/revoke", { id: rest[0] }));
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
} catch (e) {
  console.error(`Arca: ${e.message}`);
  process.exitCode = 1;
}
