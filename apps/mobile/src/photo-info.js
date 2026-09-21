import { bytes } from "./format.js";

const number = (value) => Number(value.toFixed(2)).toString();
export function photoDate(value) {
  if (!value) return "";
  const date = new Date(
    value.length === 7
      ? `${value}-01T12:00:00`
      : value.length === 10
        ? `${value}T12:00:00`
        : value,
  );
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("en", {
    year: "numeric",
    month: "long",
    ...(value.length > 7 ? { day: "numeric" } : {}),
    ...(value.length > 10 ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}
// Mirrors desktop galleryInfo so both clients describe a photo identically.
export function photoInfo(item, meta, folderName = "") {
  const dimensions =
    meta?.width && meta?.height
      ? `${meta.width} × ${meta.height} · ${number((meta.width * meta.height) / 1000000)} MP`
      : "";
  const camera =
    meta?.make && meta.model?.toLowerCase().startsWith(meta.make.toLowerCase())
      ? meta.model
      : [meta?.make, meta?.model].filter(Boolean).join(" ");
  const metrics = [
    ["Aperture", meta?.aperture && `f/${number(meta.aperture)}`],
    [
      "Shutter",
      meta?.exposure &&
        (meta.exposure < 1
          ? `1/${Math.round(1 / meta.exposure)} s`
          : `${number(meta.exposure)} s`),
    ],
    ["ISO", meta?.iso && String(meta.iso)],
    ["Focal", meta?.focalLength && `${number(meta.focalLength)} mm`],
  ].filter(([, value]) => value);
  const coordinates = meta?.location
    ? `${meta.location.latitude.toFixed(6)}, ${meta.location.longitude.toFixed(6)}`
    : "";
  const capture = [
    {
      icon: "calendar",
      label: meta?.captured ? "Taken" : "Date",
      value: photoDate(meta?.captured || item.date),
      detail: meta?.offset ? `UTC${meta.offset}` : "",
    },
    {
      icon: "camera",
      label: "Camera",
      value: camera,
      detail: meta?.lens || "",
    },
  ].filter((row) => row.value || row.detail);
  const arca = [
    {
      icon: "folder",
      label: "File path",
      value: [folderName, item.path].filter(Boolean).join("/"),
    },
    meta?.accepted && {
      icon: "upload",
      label: "Accepted by hub",
      value: photoDate(meta.accepted.date),
      detail: `${meta.accepted.machine ? `From ${meta.accepted.machine} · ` : ""}rev ${meta.accepted.revision}`,
    },
  ].filter(Boolean);
  return {
    name: item.path.split("/").pop(),
    summary: [item.size ? bytes(item.size) : "", dimensions, meta?.format]
      .filter(Boolean)
      .join(" · "),
    capture,
    metrics,
    location: coordinates
      ? {
          text: coordinates,
          url: `https://maps.google.com/?q=${encodeURIComponent(coordinates)}`,
        }
      : null,
    arca,
    hasHistory: !!meta?.hasHistory,
  };
}
