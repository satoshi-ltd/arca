// Resolve the current local file at Play time, even if the viewer opened before sync finished.
export async function galleryVideoURI(item, { files, scope, volume }) {
  if (!item.upload) {
    const uri = files.work(scope, volume, item.path);
    if (await files.exists(uri)) return uri;
  }
  if (item.uri?.startsWith("content://")) return item.uri;
  if (item.uri?.startsWith("file://") && (await files.exists(item.uri)))
    return item.uri;
  throw new Error(
    "This video is not available locally yet. Let folder synchronization finish, then try Play again.",
  );
}

export function startVideoPlayback(player, uri, appState, onError) {
  let mounted = true;
  let foreground = appState.currentState === "active";
  player.staysActiveInBackground = false;
  const subscription = appState.addEventListener("change", (state) => {
    foreground = state === "active";
    if (!foreground) player.pause();
  });
  player
    .replaceAsync({ uri })
    .then(() => {
      if (mounted && foreground) player.play();
    })
    .catch((error) => {
      if (mounted) onError(error);
    });
  return () => {
    mounted = false;
    subscription.remove();
    player.pause();
  };
}

export function videoPosterSource(item) {
  const uri = item.nativeSource ? null : item.uri;
  return uri?.startsWith("file://") || uri?.startsWith("content://")
    ? uri
    : null;
}

async function firstFrame(player, attempts, delay) {
  for (let attempt = 1; ; attempt++) {
    const [frame] = await player.generateThumbnailsAsync([0], { maxWidth: 360 });
    if (frame || attempt >= attempts) return frame;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function retrieverPath(uri) {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

export async function renderVideoPoster(
  uri,
  { createPlayer, manipulate, platform, format, attempts = 25, delay = 200 },
) {
  const android = platform === "android";
  // expo-video's Android retriever strips file:// without decoding, so it needs the raw path.
  const player = createPlayer({
    uri: android && uri.startsWith("file://") ? retrieverPath(uri) : uri,
  });
  try {
    // iOS attaches the item asynchronously and returns no frames until then.
    const frame = await firstFrame(player, android ? 1 : attempts, delay);
    if (!frame) throw new Error("Video thumbnail unavailable");
    const context = manipulate(frame);
    try {
      const image = await context.renderAsync();
      const result = await image.saveAsync({ compress: 0.75, format });
      image.release();
      return result.uri;
    } finally {
      context.release();
      frame.release();
    }
  } finally {
    player.release();
  }
}

export function rememberFailures(limit = 512) {
  const failed = new Set();
  const attempt = async (key, work) => {
    if (failed.has(key)) throw new Error("Video thumbnail unavailable");
    try {
      return await work();
    } catch (error) {
      failed.add(key);
      if (failed.size > limit) failed.delete(failed.values().next().value);
      throw error;
    }
  };
  attempt.clear = () => failed.clear();
  return attempt;
}
