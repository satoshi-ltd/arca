const LIMIT = 600;

export function createCrashRecord({ read, write, remove, now = Date.now }) {
  let saved = false;
  return {
    record(error, fatal) {
      if (!fatal || saved) return false;
      try {
        write(
          JSON.stringify({
            name: typeof error?.name === "string" ? error.name : "Error",
            message: String(error?.message ?? error).slice(0, LIMIT),
            at: now(),
          }),
        );
        saved = true;
        return true;
      } catch {
        return false;
      }
    },
    take() {
      saved = false;
      let text;
      try {
        text = read();
      } catch {
        return null;
      }
      if (text == null) return null;
      try {
        remove();
      } catch {
        return null;
      }
      try {
        const value = JSON.parse(text);
        return value &&
          typeof value === "object" &&
          typeof value.message === "string" &&
          Number.isFinite(value.at)
          ? {
              name: typeof value.name === "string" ? value.name : "Error",
              message: value.message,
              at: value.at,
            }
          : null;
      } catch {
        return null;
      }
    },
  };
}

export function installCrashHandler(utils, recorder) {
  const previous = utils?.getGlobalHandler?.();
  utils?.setGlobalHandler?.((error, fatal) => {
    try {
      recorder.record(error, fatal);
    } catch {
      /* The previous handler must still see the error. */
    }
    previous?.(error, fatal);
  });
}

export function crashNotice(record) {
  const when = new Date(record.at).toLocaleString("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return {
    id: "crash",
    kind: "error",
    icon: "circle-alert",
    title: "Arca closed unexpectedly",
    body: "Your files are safe. The error was saved on this phone.",
    details: `${record.name}: ${record.message} · ${when}`,
  };
}
