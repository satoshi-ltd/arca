const JPEG = "data:image/jpeg;base64,";
const PAUSE = 30000;

export async function fetchHubPreview({ api, volume, item, hash }) {
  const query = new URLSearchParams({ volume, path: item.path, hash });
  const result = await api(`/v1/gallery/preview?${query}`);
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
    async preview({ linked, volume, hash, item }) {
      if (!linked || !hash || !item.uri || item.upload) return null;
      if (now() < pausedUntil) return null;
      const variant = item.kind === "video" ? "poster" : "thumb";
      const key = `${item.uri}:${item.size}:${item.mtime}:${variant}`;
      if (refused.has(key)) return null;
      try {
        return await save(item, variant, () =>
          fetchHubPreview({ api, volume, item, hash }),
        );
      } catch (error) {
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
  return (render) =>
    async (item, ...rest) => {
      try {
        return await render(item, ...rest);
      } catch (error) {
        const uri = await previews.preview({ ...context(item), item });
        if (uri) return uri;
        throw error;
      }
    };
}
