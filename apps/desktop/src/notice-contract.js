// Platform-neutral notice data. Renderers own interaction and OS presentation.
export const noticeMetrics = Object.freeze({
  width: 360,
  inset: 16,
  radius: 14,
  padding: 16,
  gap: 12,
  icon: 20,
  title: 15,
  body: 14,
  line: 21,
  detailsHeight: 32,
  duration: 180,
  distance: 8,
  infoTimeout: 4000,
  maxVisible: 3,
});
export function safeDetails(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(
      /((?:token|password|secret|code)\s*[=:]\s*)[^\s&,"'}]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(["'](?:token|password|secret|code)["']\s*:\s*)(["'])(.*?)\2/gi,
      "$1$2[redacted]$2",
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@");
}
export function errorNotice(
  error,
  { id = "action", hubName = "your hub", action = "retry" } = {},
) {
  const details = safeDetails(error?.message || error);
  const offline =
    /fetch failed|network request failed|ECONN|ENOTFOUND|timed? ?out|unreachable|ETIMEDOUT|offline/i.test(
      details,
    );
  const revoked = /\b401\b|revoked|unauthorized|hub refused credential/i.test(
    details,
  );
  const forbidden =
    !revoked &&
    /\b403\b|forbidden|administrator credential required/i.test(details);
  const technical = /Error:|E_[A-Z_]+|\bGET |\bPOST |\bat /m.test(details);
  return {
    id,
    kind: "error",
    icon: offline ? "wifi-off" : "circle-alert",
    title: offline
      ? `Hub ${hubName} unreachable`
      : revoked
        ? /revoked/i.test(details)
          ? "Hub access revoked"
          : "Hub sign-in required"
        : forbidden
          ? "Permission required"
          : "Could not complete action",
    body: offline
      ? `Your edits are saved locally and sync when ${hubName} is back.`
      : revoked
        ? "Your local files are kept. Pair again with a fresh code from the hub."
        : forbidden
          ? "This action requires permission on the hub. Ask its administrator to review your access."
          : technical
            ? "The operation stopped. Review the details and try again."
            : details,
    details:
      offline ||
      revoked ||
      forbidden ||
      /Error:|E_[A-Z_]+|\bGET |\bPOST |\bat /m.test(details)
        ? details
        : "",
    action: revoked ? "pair" : forbidden ? null : action,
    cause: offline ? "connection" : revoked ? "access" : "",
    actionLabel: revoked ? "Pair again" : "Retry now",
    offline,
  };
}
export function conditionNotices(status = {}) {
  const notices = [];
  const hubName = status.hubName || status.catalog?.name || "your hub";
  const shared = new Map();
  const addError = (error, options = {}) => {
    const item = errorNotice(error, { hubName, ...options });
    if (item.cause) {
      if (!shared.has(item.cause))
        shared.set(item.cause, { ...item, id: item.cause });
      return;
    }
    notices.push({
      ...item,
      ...options,
      action: item.action || "folder",
      actionLabel: item.action ? item.actionLabel : "Review",
    });
  };
  for (const local of status.volumes || []) {
    if (
      status.role !== "hub" &&
      (local.selected === false || local.selected === 0)
    )
      continue;
    const remote = status.catalog?.volumes?.find((v) => v.id === local.id);
    const folder = {
      ...local,
      ...(remote && {
        conflicts: remote.conflicts,
        conflictRevision: remote.conflictRevision,
      }),
    };
    if (folder.conflicts > 0)
      notices.push({
        id: `conflict:${folder.id}`,
        incident: folder.conflictRevision || folder.conflicts,
        kind: "warning",
        icon: "git-branch",
        title: `Conflict in ${folder.name}`,
        body: "Files were edited on two machines. Both files were kept.",
        action: "review",
        actionLabel: "Review",
        volume: folder.id,
      });
    if (folder.sync?.error || folder.issue)
      addError(folder.sync?.error || folder.issue, {
        id: `folder:${folder.id}`,
        title: `Synchronization of ${folder.name} stopped`,
        volume: folder.id,
      });
  }
  if (status.backup?.error) {
    const item = errorNotice(status.backup.error, { hubName });
    if (item.cause) addError(status.backup.error);
    else
      notices.push({
        ...item,
        id: "backup",
        title: "Hub backup stopped",
        action: "backup",
        actionLabel: "Backup settings",
      });
  }
  if (status.error) {
    const item = errorNotice(status.error, { hubName });
    if (item.cause || !notices.some((n) => n.id.startsWith("folder:")))
      addError(status.error, { id: "hub" });
  }
  notices.push(...shared.values());
  return notices;
}
export function createNoticeStore({
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let entries = [],
    sequence = 0;
  const listeners = new Set(),
    timers = new Map(),
    dismissed = new Map();
  const signature = (n) =>
    JSON.stringify([
      n.incident,
      n.kind,
      n.icon,
      n.title,
      n.body,
      n.cause || n.details,
      n.action,
      n.actionLabel,
      n.volume,
    ]);
  const emit = () => {
    for (const listener of listeners) listener();
  };
  function remove(id, remember = true) {
    const item = entries.find((n) => n.id === id);
    if (remember && item && item.kind !== "info")
      dismissed.set(id, signature(item));
    cancel(timers.get(id));
    timers.delete(id);
    entries = entries.filter((n) => n.id !== id);
    emit();
  }
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot() {
      return entries.slice(-noticeMetrics.maxVisible);
    },
    push(value) {
      const item = {
        kind: "info",
        ...value,
        id: value.id || `info:${++sequence}`,
      };
      if (dismissed.get(item.id) === signature(item)) return item.id;
      if (item.kind === "error") {
        const sameFailure = (n) =>
          n.kind === "error" &&
          ((item.cause && item.cause === n.cause) ||
            (!item.cause &&
              !n.cause &&
              (item.details || item.body) === (n.details || n.body)));
        const condition = item.id.startsWith("status:");
        if (
          !condition &&
          entries.some((n) => sameFailure(n) && n.id.startsWith("status:"))
        )
          return item.id;
        for (const n of [...entries])
          if (sameFailure(n) && n.id !== item.id && !n.id.startsWith("status:"))
            remove(n.id, false);
      }
      const old = entries.find((n) => n.id === item.id);
      if (old && signature(old) === signature(item)) return item.id;
      cancel(timers.get(item.id));
      dismissed.delete(item.id);
      entries = [
        ...entries.filter((n) => n.id !== item.id),
        { ...item, created: now() },
      ];
      if (item.kind === "info") {
        const timer = schedule(
          () => remove(item.id, false),
          noticeMetrics.infoTimeout,
        );
        timer?.unref?.();
        timers.set(item.id, timer);
      }
      emit();
      return item.id;
    },
    remove,
    clear(id) {
      dismissed.delete(id);
      remove(id, false);
    },
    reconcile(items, prefix = "status:") {
      const ids = new Set(items.map((n) => prefix + n.id));
      for (const id of new Set([
        ...entries.map((n) => n.id),
        ...dismissed.keys(),
      ]))
        if (id.startsWith(prefix) && !ids.has(id)) this.clear(id);
      for (const n of items) this.push({ ...n, id: prefix + n.id });
    },
    dispose() {
      for (const timer of timers.values()) cancel(timer);
      listeners.clear();
      timers.clear();
      entries = [];
      dismissed.clear();
    },
  };
}
