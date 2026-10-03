import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

class TreeWatcher extends EventEmitter {
  constructor(root, excluded, onChange) {
    super();
    this.root = root;
    this.excluded = excluded;
    this.onChange = onChange;
    this.dirs = new Map();
    this.refresh();
  }
  refresh() {
    this.closeAll();
    this.failure = null;
    this.add("");
    if (this.failure) {
      this.closeAll();
      throw this.failure;
    }
  }
  add(relative) {
    if (this.closed || this.dirs.has(relative)) return;
    if (relative && this.excluded(relative, true)) return;
    const directory = path.join(this.root, relative);
    let watcher;
    try {
      watcher = fs.watch(directory, (_event, filename) =>
        this.changed(relative, filename),
      );
    } catch (error) {
      if (!relative || ["ENOSPC", "EMFILE"].includes(error.code))
        this.failure ||= error;
      return;
    }
    watcher.on("error", (error) => {
      this.remove(relative);
      if (!this.closed && this.listenerCount("error")) this.emit("error", error);
    });
    this.dirs.set(relative, watcher);
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory())
        this.add(relative ? `${relative}/${entry.name}` : entry.name);
  }
  changed(relative, filename) {
    const child = filename ? String(filename).split(path.sep).join("/") : "";
    const name = child ? (relative ? `${relative}/${child}` : child) : relative;
    if (child) {
      let stat;
      try {
        stat = fs.lstatSync(path.join(this.root, name));
      } catch {}
      if (stat?.isDirectory()) {
        this.failure = null;
        this.add(name);
        if (this.failure) this.emit("error", this.failure);
      } else if (this.dirs.has(name)) this.remove(name);
    }
    this.onChange(name);
  }
  remove(relative) {
    for (const [directory, watcher] of this.dirs)
      if (directory === relative || directory.startsWith(relative + "/")) {
        watcher.close();
        this.dirs.delete(directory);
      }
  }
  closeAll() {
    for (const watcher of this.dirs.values()) watcher.close();
    this.dirs.clear();
  }
  watched() {
    return [...this.dirs.keys()];
  }
  close() {
    this.closed = true;
    this.closeAll();
  }
}

// Linux recursive fs.watch spends one inotify watch per directory, excluded trees included.
export function watchTree(root, excluded, onChange) {
  return new TreeWatcher(root, excluded, onChange);
}

export function watchFolder(root, excluded, onChange) {
  if (process.platform !== "darwin" && process.platform !== "win32")
    return watchTree(root, excluded, onChange);
  return fs.watch(root, { recursive: true }, (_event, filename) =>
    onChange(filename ? String(filename).split(path.sep).join("/") : ""),
  );
}
