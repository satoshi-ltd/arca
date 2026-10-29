import { stripSpans } from "../../../packages/core/subtitle-language.js";

const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const ARROW = /^\s*(\S+)\s+-->\s+(\S+)/;
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&quot;": '"', "&#39;": "'", "&lrm;": "", "&rlm;": "" };

export function parseTime(value) {
  const match = TIME.exec(String(value || "").trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction.padEnd(3, "0")) / 1000;
}

function clean(line) {
  return stripSpans(stripSpans(line, /</, ">"), /\{\\/, "}")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .trim();
}

export function parseCues(text) {
  const blocks = String(text || "")
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => ARROW.test(line));
    if (at < 0) continue;
    const [, from, to] = ARROW.exec(lines[at]);
    const start = parseTime(from);
    const end = parseTime(to);
    if (start == null || end == null || end <= start) continue;
    const raw = lines.slice(at + 1).filter((line) => line.trim());
    const italic = raw.length > 0 && raw.every((line) => /^\s*(<i>|\{\\i1\})/i.test(line));
    const body = raw.map(clean).filter(Boolean);
    if (body.length) cues.push({ start, end, text: body.join("\n"), italic });
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function activeCues(cues, time) {
  if (!Array.isArray(cues) || !Number.isFinite(time)) return [];
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= time) low = mid + 1;
    else high = mid;
  }
  const shown = [];
  for (let index = low - 1; index >= 0 && shown.length < 4; index--) {
    if (cues[index].end > time) shown.unshift(cues[index]);
    if (time - cues[index].start > 600) break;
  }
  return shown;
}

export function cueText(cues, time) {
  const shown = activeCues(cues, time);
  return shown.length ? { text: shown.map((cue) => cue.text).join("\n"), italic: shown.every((cue) => cue.italic) } : null;
}

export function subtitleOptions(player, sidecars) {
  const rows = Array.isArray(sidecars) ? sidecars : [];
  const embedded = rows.filter((sub) => sub?.embedded);
  const tracks = !embedded.length && Array.isArray(player?.availableSubtitleTracks) ? player.availableSubtitleTracks : [];
  return [
    { key: "off", kind: "off", label: "Off" },
    ...embedded
      .filter((sub) => !sub.image && Number.isSafeInteger(sub.stream))
      .map((sub) => ({ key: `stream:${sub.stream}`, kind: "stream", label: sub.label || sub.language || `Subtitles ${sub.stream + 1}`, stream: sub.stream })),
    ...tracks.map((track, index) => ({
      key: `track:${track.id || `${track.language || "track"}-${index}`}`,
      kind: "track",
      label: track.label || track.name || track.language || `Track ${index + 1}`,
      track,
    })),
    ...(Array.isArray(sidecars) ? sidecars : [])
      .filter((sub) => sub && typeof sub.path === "string")
      .map((sub) => ({ key: `file:${sub.path}`, kind: "file", label: sub.label || sub.language || sub.path.split("/").pop(), path: sub.path })),
  ];
}

export function chosenKey(options, embedded, sidecar) {
  if (sidecar) return options.find((option) => option.key === sidecar || option.key === `file:${sidecar}`)?.key || "off";
  if (embedded) {
    const match = options.find((option) => option.kind === "track" && (option.track === embedded || (embedded.id && option.track.id === embedded.id)));
    return match ? match.key : "off";
  }
  return "off";
}

export function applyChoice(option) {
  if (!option || option.kind === "off") return { track: null, sidecar: null };
  if (option.kind === "file") return { track: null, sidecar: option.path };
  if (option.kind === "stream") return { track: null, sidecar: option.key };
  return { track: option.track, sidecar: null };
}

export function restoreChoice(options, remembered) {
  if (!remembered) return null;
  const byLabel = options.find((option) => option.kind === remembered.kind && option.label === remembered.label);
  if (remembered.kind === "stream") return byLabel || null;
  return options.find((option) => option.key === remembered.key) || byLabel || null;
}

export function titleKey(item) {
  return item?.kind === "episode" ? item.show : item?.id || "";
}

export function subtitleRoute(volume, path, embedded = null) {
  return `/v1/video/subtitles?${new URLSearchParams({ volume, path, ...(embedded ? { hash: embedded.hash, stream: String(embedded.stream), poll: "1" } : {}), format: "json" })}`;
}

export function embeddedStream(choice) {
  const match = /^stream:(\d{1,2})$/.exec(choice || "");
  return match ? Number(match[1]) : null;
}
