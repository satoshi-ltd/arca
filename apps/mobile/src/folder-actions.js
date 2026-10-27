import { HUB_ONLY_REASON } from "../../desktop/src/notice-contract.js";

export const PAUSED_REASON = "Sync is paused";
const RUNNING = "Another action is still running.";
const CONNECT = "Connect to the hub first.";

export const albumNote = ({ source, locked, connected, offline, completed, issue }) =>
  locked
    ? RUNNING
    : !connected
      ? CONNECT
      : source
        ? undefined
        : offline
          ? HUB_ONLY_REASON
          : issue
            ? "Fix this folder's sync problem first."
            : !completed
              ? "Available after this folder's first sync."
              : undefined;

export const historyNote = ({ busy, connected }) => (busy ? RUNNING : !connected ? CONNECT : undefined);

export const uploadsNote = ({ busy, mode }) =>
  busy
    ? RUNNING
    : mode === "converting"
      ? "Available once the album link finishes."
      : mode !== "source"
        ? "Choose Change album… to repair the link."
        : undefined;
