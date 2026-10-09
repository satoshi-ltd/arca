export const REPORT_FRESH_MS = 300000;

const ago = (at, now) => {
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000);
  return seconds < 60
    ? "just now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} min ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)} h ago`
        : `${Math.floor(seconds / 86400)} d ago`;
};

export function deviceNodes(machines, { selfId, hubAway = false, now = Date.now() } = {}) {
  return (machines || [])
    .filter((m) => !m.isHub && !m.revoked)
    .map((machine) => {
      const at =
        machine.reportedAt && !Number.isNaN(Date.parse(machine.reportedAt))
          ? machine.reportedAt
          : "";
      const state = !at
        ? "none"
        : now - Date.parse(at) < REPORT_FRESH_MS
          ? "fresh"
          : "stale";
      const self = Boolean(selfId) && machine.credentialId === selfId;
      const line = hubAway || state === "none" ? "none" : state === "fresh" ? "solid" : "dashed";
      const report =
        state === "none"
          ? { text: "No report yet", tone: "mute", icon: "circle-dashed" }
          : hubAway
            ? self
              ? { text: "Offline", tone: "mute", icon: "wifi-off" }
              : { text: `Last report ${ago(at, now)}`, tone: "mute", icon: "circle-dashed" }
            : state === "fresh"
              ? { text: `Reported ${ago(at, now)}`, tone: "ok", icon: "activity" }
              : { text: `Reported ${ago(at, now)}`, tone: "warning", icon: "clock" };
      return {
        key: machine.credentialId || machine.machineId || machine.name,
        machine,
        self,
        at,
        state,
        line,
        report,
      };
    })
    .sort((a, b) => Number(b.self) - Number(a.self));
}
