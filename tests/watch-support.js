import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function canWatchDirectory(count = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arca-watch-probe-"));
  const watchers = [];
  try {
    const folders = Array.from({ length: count }, (_, index) =>
      path.join(directory, String(index)),
    );
    for (const folder of folders) fs.mkdirSync(folder);
    // A first event alone can succeed while subsequent streams stay silent.
    // Exercise sustained delivery and the close/reopen used by tree refreshes.
    for (let generation = 0; generation < 3; generation++) {
      for (const folder of folders)
        watchers.push(fs.watch(folder, {
          recursive: process.platform === "darwin" || process.platform === "win32",
        }));
      const available = await new Promise((resolve) => {
        let settled = false, phase = 0, nextPulse;
        const seen = new Set();
        const timeout = setTimeout(() => finish(false), 5000);
        const finish = (available) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(nextPulse);
          resolve(available);
        };
        const write = () => {
          try {
            for (const folder of folders)
              fs.writeFileSync(path.join(folder, `probe-${phase}.txt`), String(generation));
          } catch {
            finish(false);
          }
        };
        for (const [index, watcher] of watchers.entries()) {
          watcher.on("change", (eventType, filename) => {
            if (settled || String(filename) !== `probe-${phase}.txt`) return;
            if (eventType !== "rename" && eventType !== "change") return finish(false);
            seen.add(index);
            if (seen.size !== count) return;
            if (phase === 1) return finish(true);
            phase++;
            seen.clear();
            nextPulse = setTimeout(write, 100);
          });
          watcher.once("error", () => finish(false));
        }
        write();
      });
      for (const watcher of watchers.splice(0)) watcher.close();
      if (!available) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    for (const watcher of watchers) watcher.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
