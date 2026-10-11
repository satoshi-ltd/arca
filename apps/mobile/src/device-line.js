import { bytes } from "./format.js";

export const REPORTABLE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;

const PLATFORMS = { darwin: "macOS", linux: "Linux", win32: "Windows", android: "Android", ios: "iOS" };

export const platformName = (platform) => PLATFORMS[platform] || platform || "";

const versionParts = (value) =>
  /^(\d+)\.(\d+)\.(\d+)/.exec(value || "")?.slice(1).map(Number) || null;

export function olderVersion(version, hubVersion) {
  const own = versionParts(version),
    hub = versionParts(hubVersion);
  if (!own || !hub) return false;
  for (let i = 0; i < 3; i++) if (own[i] !== hub[i]) return own[i] < hub[i];
  return false;
}

export function deviceSegments({ platform, version, hubVersion, folders, size }) {
  const os = platformName(platform);
  return [
    os && { parts: [os] },
    olderVersion(version, hubVersion) && {
      parts: [`v${version}`],
      warning: true,
      label: `v${version}, older than the hub’s v${hubVersion}`,
    },
    Number.isSafeInteger(folders) &&
      Number.isSafeInteger(size) && {
        parts: [`${folders.toLocaleString("en")} ${folders === 1 ? "folder" : "folders"}`, bytes(size)],
      },
  ].filter(Boolean);
}

export const segmentText = (part) => part.replace(/ /g, "\u00a0");

export const machineLabel = ({ name, role, self, backup, segments, address, state }) =>
  [
    name,
    role,
    self && "this device",
    backup && "Full backup",
    ...segments.map((segment) => segment.label || segment.parts.join(" · ")),
    address,
    state,
  ]
    .filter(Boolean)
    .join(", ");
