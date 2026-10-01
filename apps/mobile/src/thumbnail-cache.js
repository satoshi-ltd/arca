import { mediaKind } from "../../../packages/core/gallery-date.js";
// Cancellable preparation with bounded parallelism. A failed derivative never replaces an original.
export async function prepareThumbnails(
  entries,
  previous,
  io,
  active = () => true,
  changed = () => {},
  keep = entries,
  concurrency = 1,
  failed = () => {},
  delta = false,
) {
  const paths = new Set(keep.map((entry) => entry.path));
  const next = Object.fromEntries(
    Object.entries(previous).filter(([path]) => paths.has(path)),
  );
  const queue = entries.filter(
    (entry) => !entry.directory && mediaKind(entry.path),
  );
  let stopped = false;
  const work = async () => {
    while (queue.length && !stopped) {
      if (!active()) {
        stopped = true;
        return;
      }
      const entry = queue.shift();
      const signature = entry.signature || `${entry.size}:${entry.mtime}`;
      const old = previous[entry.path];
      let uri =
        old?.signature === signature && (await io.exists(old.uri))
          ? old.uri
          : null;
      if (!uri) {
        try {
          uri = await io.render(entry);
        } catch (error) {
          failed(entry, error);
        }
      }
      if (!active()) {
        stopped = true;
        return;
      }
      if (uri) next[entry.path] = { signature, uri };
      else delete next[entry.path];
      if (uri !== old?.uri || signature !== old?.signature) {
        changed(delta ? { [entry.path]: next[entry.path] ?? null } : { ...next });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work));
  if (stopped) return null;
  if (!delta && JSON.stringify(next) !== JSON.stringify(previous))
    changed(next);
  return next;
}

export function savedThumbnail(saved, item) {
  const found = saved[item.path];
  return found && found.signature === item.signature ? found.uri : null;
}

export function isFlatCacheFile(uri, directory) {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return (
    !!uri && uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/")
  );
}

export async function nativeFirst(native, fallback) {
  if (native)
    try {
      await native();
      return null;
    } catch {
      /* Older binaries and unsupported sources use the portable renderer. */
    }
  return fallback();
}

export function createLimiter(limit, timeout = 0) {
  let running = 0;
  const urgent = [];
  const idle = [];
  const drain = () => {
    while (running < limit && (urgent.length || idle.length)) {
      running++;
      (urgent.length ? urgent : idle).shift()();
    }
  };
  return {
    run(task, priority = true) {
      return new Promise((resolve, reject) => {
        (priority ? urgent : idle).push(() => {
          let timer;
          const work = Promise.resolve().then(task);
          const guarded = timeout
            ? Promise.race([
                work,
                new Promise((_, stop) => {
                  timer = setTimeout(
                    () => stop(new Error("Render timed out")),
                    timeout,
                  );
                }),
              ])
            : work;
          guarded.then(resolve, reject).finally(() => {
            clearTimeout(timer);
            running--;
            drain();
          });
        });
        drain();
      });
    },
  };
}

export function previewProgress(candidates, saved, failed) {
  let done = 0;
  let failures = 0;
  for (const item of candidates) {
    if (savedThumbnail(saved, item)) done++;
    else if (failed.has(item.path)) failures++;
  }
  return {
    total: candidates.length,
    done,
    failed: failures,
    waiting: candidates.length - done - failures,
  };
}

export function pruneSaved(saved, keep) {
  return Object.fromEntries(
    Object.entries(saved).filter(([path]) => keep.has(path)),
  );
}

export function createFlusher(
  flush,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now,
) {
  let timer = null;
  let due = 0;
  return {
    queue(delay) {
      const at = now() + delay;
      if (timer !== null && due <= at) return;
      cancel(timer);
      due = at;
      timer = schedule(() => {
        timer = null;
        flush();
      }, delay);
    },
    now() {
      cancel(timer);
      timer = null;
      flush();
    },
    cancel() {
      cancel(timer);
      timer = null;
    },
    get pending() {
      return timer !== null;
    },
  };
}
