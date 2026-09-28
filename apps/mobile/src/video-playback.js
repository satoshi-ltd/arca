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
