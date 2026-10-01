const JPEG = "data:image/jpeg;base64,";
const PAUSE = 30000;

export async function fetchHubPreview({ api, volume, item, hash, large }) {
  const query = new URLSearchParams({ volume, path: item.path, hash });
  if (large) query.set("size", "large");
  const result = await api(`/v1/gallery/preview?${query}`, undefined, {
    timeout: 30000,
  });
  if (typeof result?.data !== "string" || !result.data.startsWith(JPEG))
    throw new Error("Hub preview unavailable");
  return result.data.slice(JPEG.length);
}

export function acceptedHash(known, item) {
  const row = known?.get(item.path);
  return row && !row.deleted && row.hash && row.size === item.size
    ? row.hash
    : null;
}

export function createHubPreviews({
  api,
  save,
  unreachable,
  busy,
  now = Date.now,
}) {
  const refused = new Set();
  let pausedUntil = 0;
  return {
    async preview({ linked, volume, hash, item, large = false }) {
      if (!linked || !hash || !item.uri || item.upload) return null;
      const variant = large
        ? "large"
        : item.kind === "video"
          ? "poster"
          : "thumb";
      const key = `${item.uri}:${item.size}:${item.mtime}:${variant}`;
      if (!large && (now() < pausedUntil || refused.has(key))) return null;
      try {
        return await save(item, variant, () =>
          fetchHubPreview({ api, volume, item, hash, large }),
        );
      } catch (error) {
        if (large) return null;
        if (unreachable(error)) pausedUntil = now() + PAUSE;
        else if (!busy(error)) refused.add(key);
        return null;
      }
    },
    clear() {
      refused.clear();
      pausedUntil = 0;
    },
  };
}

export function hubFallback({ previews, context }) {
  return (render, large = false) =>
    async (item, ...rest) => {
      try {
        return await render(item, ...rest);
      } catch (error) {
        const uri = await previews.preview({ ...context(item), item, large });
        if (uri) return uri;
        throw error;
      }
    };
}
