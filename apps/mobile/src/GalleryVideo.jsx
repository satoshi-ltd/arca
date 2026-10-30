import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, Image, Pressable, View } from "react-native";
import { Text } from "./Text";
import { requireOptionalNativeModule, useEvent } from "expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Busy, Icon, useDesign } from "./components";
import { videoSurfaceMargins } from "./layout";
import { holdVideoPlayback, startVideoPlayback } from "./video-playback";

// An installed dev client can receive JS before its new native module is built.
const video = requireOptionalNativeModule("ExpoVideo")
  ? require("expo-video")
  : null;
const { useVideoPlayer, VideoView } = video || {};

function Playback({ uri, held }) {
  const { s, c } = useDesign();
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(null);
  const [loadError, setLoadError] = useState(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const hold = useRef({ resume: false });
  const { status, error } = useEvent(player, "statusChange", {
    status: player.status,
  });
  // Pause before useVideoPlayer releases the native instance in passive cleanup.
  useLayoutEffect(
    () =>
      startVideoPlayback(
        player,
        uri,
        AppState,
        setLoadError,
        () => heldRef.current,
      ),
    [player, uri],
  );
  useEffect(() => {
    holdVideoPlayback(player, held, hold.current);
  }, [player, held]);
  if (loadError || status === "error")
    return (
      <Text style={s.viewerCaption}>
        {loadError?.message ||
          error?.message ||
          "This video format could not be played on this device."}
      </Text>
    );
  return (
    <View style={[s.viewerVideoSurface, videoSurfaceMargins(insets)]}>
      <VideoView
        player={player}
        style={s.viewerVideo}
        nativeControls
        contentFit="contain"
        surfaceType="textureView"
      />
      {(status === "loading" || status === "idle") && (
        <View pointerEvents="none" style={s.viewerVideoLoading}>
          <Busy color={c.onMedia} />
        </View>
      )}
    </View>
  );
}

export function GalleryVideo({ item, active, held, resolveVideo, frame }) {
  const { s, c } = useDesign();
  const [attempt, setAttempt] = useState(0);
  const [uri, setURI] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setURI(null);
    setError("");
    if (active && video)
      resolveVideo(item)
        .then((value) => {
          if (current) setURI(value);
        })
        .catch((failure) => {
          if (current) setError(failure.message);
        });
    return () => {
      current = false;
    };
  }, [active, attempt, item.path, item.hash]);
  return (
    <View style={frame} accessibilityLabel="Video">
      {active && uri ? (
        <Playback key={uri} uri={uri} held={held} />
      ) : (
        <>
          {!!item.poster && (
            <Image
              source={{ uri: item.poster }}
              resizeMode="contain"
              style={s.viewerVideoPoster}
            />
          )}
          {active && video && !error ? (
            <Busy color={c.onMedia} />
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Play video"
                style={s.viewerPlay}
                onPress={() => {
                  if (!video) {
                    setError(
                      "Install the updated Arca mobile build to play videos.",
                    );
                    return;
                  }
                  setAttempt((value) => value + 1);
                }}
              >
                <Icon name="play" color={c.onMedia} size={32} />
              </Pressable>
              {!!error && (
                <Text accessibilityRole="alert" style={s.viewerCaption}>
                  {error}
                </Text>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
