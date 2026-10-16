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
    for (const folder of folders) {
      fs.mkdirSync(folder);
      watchers.push(
        fs.watch(folder, {
          recursive: process.platform === "darwin" || process.platform === "win32",
        }),
      );
    }
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      let remaining = count;
      let settled = false;
      const finish = (available) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(available);
      };
      for (const [index, watcher] of watchers.entries()) {
        watcher.once("change", (eventType) => {
          if (eventType !== "rename" && eventType !== "change")
            return finish(false);
          if (--remaining === 0) finish(true);
        });
        watcher.once("error", () => finish(false));
        fs.writeFileSync(path.join(folders[index], "probe.txt"), "event");
      }
    });
  } catch {
    return false;
  } finally {
    for (const watcher of watchers) watcher.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
