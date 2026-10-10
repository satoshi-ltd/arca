import { createLimiter } from "./thumbnail-cache.js";
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

export function replicaHash({ cachedHash, keysOf }) {
  return async (item) => {
    for (const key of keysOf(item))
      try {
        const record = await cachedHash(key);
        if (
          record?.hash &&
          record.size === item.size &&
          item.mtime != null &&
          record.mtime === item.mtime
        )
          return record.hash;
      } catch {}
    return null;
  };
}

export async function acceptedHash(known, item, hashFile, verifiedHash) {
  const row = known?.get(item.path);
  if (!row || row.deleted || !row.hash || row.size !== item.size || !item.uri)
    return null;
  try {
    const verified = verifiedHash ? await verifiedHash(item) : null;
    if (verified) return verified === row.hash ? row.hash : null;
    return (await hashFile(item.uri)) === row.hash ? row.hash : null;
  } catch {
    return null;
  }
}

export function createAccepted({
  hashFile,
  verifiedHash,
  limiter = createLimiter(1, 600000),
  limit = 4096,
}) {
  const memo = new Map();
  const verify = (known, item, urgent = false) => {
    const row = known?.get(item.path);
    if (!row || row.deleted || !row.hash || row.size !== item.size || !item.uri)
      return Promise.resolve(null);
    const key = `${item.uri}:${item.size}:${item.mtime}:${row.hash}`;
    if (!memo.has(key)) {
      const task = limiter
        .run(() => acceptedHash(known, item, hashFile, verifiedHash), urgent)
        .catch(() => {
          if (memo.get(key) === task) memo.delete(key);
          return null;
        });
      memo.set(key, task);
      if (memo.size > limit) memo.delete(memo.keys().next().value);
    }
    return memo.get(key);
  };
  verify.clear = () => memo.clear();
  return verify;
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
  const variantOf = (item, large) =>
    large ? "large" : item.kind === "video" ? "poster" : "thumb";
  const keyOf = (item, large) =>
    `${item.uri}:${item.size}:${item.mtime}:${variantOf(item, large)}`;
  const allowed = ({ linked, item, large = false }) =>
    !!linked &&
    !!item.uri &&
    !item.upload &&
    (large || (now() >= pausedUntil && !refused.has(keyOf(item, false))));
  return {
    allowed,
    async preview({ linked, volume, hash, item, large = false }) {
      if (!hash || !allowed({ linked, item, large })) return null;
      const variant = variantOf(item, large);
      const key = keyOf(item, large);
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
        const known = await context(item);
        if (previews.allowed && !previews.allowed({ linked: known.linked, item, large }))
          throw error;
        const hash = known.hashOf
          ? await known.hashOf(item, large)
          : known.hash;
        const uri = await previews.preview({ ...known, hash, item, large });
        if (uri) return uri;
        throw error;
      }
    };
}
