import { bytes } from "./format.js";

export const REPORTABLE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;

const PLATFORMS = { darwin: "macOS", linux: "Linux", win32: "Windows", android: "Android", ios: "iOS" };

export const platformName = (platform) => PLATFORMS[platform] || platform || "";

export const versionCore = (value) => /^\d+\.\d+\.\d+/.exec(value || "")?.[0] || value || "";

const versionParts = (value) =>
  /^(\d+)\.(\d+)\.(\d+)/.exec(value || "")?.slice(1).map(Number) || null;

export function olderVersion(version, hubVersion) {
  const own = versionParts(version),
    hub = versionParts(hubVersion);
  if (!own || !hub) return false;
  for (let i = 0; i < 3; i++) if (own[i] !== hub[i]) return own[i] < hub[i];
  return false;
}

const folderParts = (folders, size) =>
  Number.isSafeInteger(folders) && Number.isSafeInteger(size)
    ? [`${folders.toLocaleString("en")} ${folders === 1 ? "folder" : "folders"}`, bytes(size)]
    : null;

export function deviceSegments({ platform, version, hubVersion, folders, size, revoked = false }) {
  const os = platformName(platform);
  const totals = folderParts(folders, size);
  return [
    os && { parts: [os] },
    !revoked &&
      olderVersion(version, hubVersion) && {
      parts: [`v${version}`],
      warning: true,
      label: `v${version}, older than the hub’s v${hubVersion}`,
    },
    totals && { parts: totals },
  ].filter(Boolean);
}

export function deviceCells({ version, hubVersion, folders, size, revoked = false }) {
  const older = !revoked && olderVersion(version, hubVersion);
  return {
    version: version
      ? { text: `v${versionCore(version)}`, older, label: older ? `v${version}, older than the hub’s v${hubVersion}` : `v${version}` }
      : null,
    totals: folderParts(folders, size),
  };
}

export const PRESENCE_WINDOW_MS = 120000;

export const FOLD_ROW_WIDTH = 690;

export const foldRowFits = (scale = 1) =>
  40 + 5 * 8 + 32 + 18 + Math.ceil((96 + 76 + 66 + 106 + 72 + 44) * scale) <= FOLD_ROW_WIDTH;

const seenDate = (at) =>
  new Date(at).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function presence({ seen = [], now, offline = false, self = false }) {
  if (self) return { connected: true, label: "Connected" };
  const at = Math.max(...seen.map((value) => Date.parse(value || "")).filter(Number.isFinite));
  if (!Number.isFinite(at)) return null;
  const connected = !offline && (Number.isFinite(now) ? now : Date.now()) - at < PRESENCE_WINDOW_MS;
  return { connected, label: connected ? "Connected" : `Seen ${seenDate(at)}` };
}

export const segmentText = (part) => part.replace(/ /g, "\u00a0");

export function rosterPresence(machines, { offline = false, connectionId } = {}) {
  const hub = machines?.find((m) => m.isHub);
  const now = Date.parse(hub?.reportedAt || "");
  return {
    hub: presence({
      seen: [hub?.reportedAt, machines?.find((m) => !m.isHub && m.credentialId === connectionId)?.lastContact],
      now,
      offline,
    }),
    of: (m) => presence({ seen: [m.lastContact, m.reportedAt], now, offline: offline || !!m.revoked }),
  };
}

export const machineLabel = ({ name, role, self, backup, segments, address, state, presence, version }) =>
  [
    name,
    role,
    self && "this device",
    backup && "Full backup",
    ...segments.map((segment) => segment.label || segment.parts.join(" · ")),
    version,
    address,
    state,
    presence?.label,
  ]
    .filter(Boolean)
    .join(", ");
