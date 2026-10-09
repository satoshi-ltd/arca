import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Modal, PanResponder, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { EmptyState, Icon, useDesign } from "./components";
import { Cover } from "./MusicLibrary";
import { artistFor, formatDuration, nextRepeat, parseTrackNode, upNext } from "./music-library.js";
import { useFlight, useMotion } from "./motion";
import { hasFlight } from "./flight.js";
import { useMusicPlayer } from "./music-player";

const isPlaying = (state) => !!state && (state.playing || (state.playWhenReady && !state.ended && !state.error));

function Row({ track, current, onPress }) {
  const { s, c } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${track.title}, ${track.artist}${current ? ", playing" : ""}`}
      accessibilityState={{ selected: current }}
      onPress={onPress}
      style={[s.searchRow, current && s.historyRowChosen]}
    >
      <Icon name={current ? "play" : "music"} size={16} color={current ? c.accent : c.mute} />
      <View style={[s.flex, s.stack]}>
        <Text numberOfLines={1} style={s.rowTitle}>
          {track.title}
        </Text>
        <Text numberOfLines={1} style={s.caption}>
          {track.artist}
        </Text>
      </View>
    </Pressable>
  );
}

export function NowPlayingPage({ visible, library, cover, command, play, openAlbum, openArtist, onClose }) {
  const { s, c, wide } = useDesign();
  const { width, height } = useWindowDimensions();
  const { duration: ms } = useMotion();
  const twoPane = wide && width >= 1100;
  const [state] = useMusicPlayer(visible);
  const [trackWidth, setTrackWidth] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const slide = useRef(new Animated.Value(0)).current;
  const lastVisible = useRef(visible);
  const flying = useRef(false);
  if (visible !== lastVisible.current) {
    lastVisible.current = visible;
    flying.current = visible && hasFlight("cover");
  }
  const lift = flying.current ? 0 : height * 0.2;
  const flight = useFlight("cover", visible);
  const [mounted, setMounted] = useState(visible);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    setQueueOpen(false);
    if (visible) {
      setMounted(true);
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: ms(200), useNativeDriver: true }).start();
    } else
      Animated.timing(slide, { toValue: 0, duration: ms(200), useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
  }, [visible]);
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dy > 12 && g.dy > Math.abs(g.dx) * 1.5,
        onPanResponderRelease: (_, g) => {
          if (g.dy > 80 || g.vy > 1) closeRef.current();
        },
      }),
    [],
  );
  const track = state?.id && library ? library.tracks.get(parseTrackNode(state.id)?.track) : null;
  const queue = useMemo(() => upNext(library, state), [library, state?.id, state?.shuffle]);
  const playing = isPlaying(state);
  const total = state?.duration || (track?.duration ? track.duration * 1000 : 0);
  const position = Math.min(state?.position || 0, total || Infinity);
  const progress = total ? Math.max(0, Math.min(1, position / total)) : 0;
  const artist = artistFor(library, track);
  const control = (label, icon, onPress, active = false, primary = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active ? { selected: true } : undefined}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [primary ? s.playButton : s.playerControl, pressed && s.musicPressed]}
    >
      <Icon name={icon} size={primary ? 28 : 24} color={primary ? c.onAccent : active ? c.accent : c.ink} />
    </Pressable>
  );
  const rows = queue.rows.map((entry) => (
    <Row key={`${entry.position}:${entry.track.id}`} track={entry.track} current={false} onPress={() => play(queue.context, entry.track, entry.position)} />
  ));
  const list = (
    <ScrollView style={s.flex} contentContainerStyle={s.searchBody}>
      {!!track && <Row track={track} current onPress={() => {}} />}
      {rows}
      {!rows.length && (
        <Text style={s.caption}>{queue.shuffled ? "Shuffling: the order is chosen as you go." : "Nothing after this track."}</Text>
      )}
    </ScrollView>
  );
  const main = !state?.id ? (
    <EmptyState icon="music" title="Nothing playing" text="Pick a track in a music folder to play it here." />
  ) : (
    <View style={s.nowPage}>
      <Animated.View ref={flight.frame} style={flight.style}>
        <Cover uri={cover(track?.cover, "large")} size={twoPane ? 320 : Math.min(width - 64, 320)} />
      </Animated.View>
      <View style={[s.stack, s.nowPlayingText]}>
        <Text numberOfLines={2} style={[s.title, s.centerText]}>
          {track?.title || state.title || "Unknown track"}
        </Text>
        <View style={s.nowLinks}>
          {!!(track?.artist || state.artist) && (
            <Pressable accessibilityRole="link" accessibilityLabel={`Artist ${track?.artist || state.artist}`} disabled={!artist} onPress={() => artist && openArtist(artist)}>
              <Text numberOfLines={1} style={[s.text, artist && s.nowLink]}>
                {track?.artist || state.artist}
              </Text>
            </Pressable>
          )}
          {!!(track?.album || state.album) && (
            <Pressable accessibilityRole="link" accessibilityLabel={`Album ${track?.album || state.album}`} disabled={!track} onPress={() => track && openAlbum(track)}>
              <Text numberOfLines={1} style={[s.text, track && s.nowLink]}>
                {track?.album || state.album}
              </Text>
            </Pressable>
          )}
        </View>
        {!!state.error && (
          <Text accessibilityRole="alert" style={[s.caption, s.errorText, s.centerText]}>
            {state.error}
          </Text>
        )}
      </View>
      <View style={s.playerProgressArea}>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel="Position"
          accessibilityValue={{ min: 0, max: Math.round(total / 1000), now: Math.round(position / 1000), text: `${formatDuration(position / 1000) || "0:00"} of ${formatDuration(total / 1000) || "unknown"}` }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            command("seek", Math.max(0, Math.min(total, position + (event.nativeEvent.actionName === "increment" ? 15000 : -15000))))
          }
          onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
          onPress={(event) => total && trackWidth && command("seek", (event.nativeEvent.locationX / trackWidth) * total)}
          style={s.playerTrackArea}
        >
          <View style={s.playerTrack}>
            <View style={[s.playerFill, { width: `${progress * 100}%` }]} />
          </View>
        </Pressable>
        <View style={s.playerTimes}>
          <Text style={s.mono}>{formatDuration(position / 1000) || "0:00"}</Text>
          <Text style={s.mono}>{formatDuration(total / 1000) || "—"}</Text>
        </View>
      </View>
      <View style={s.playerControls}>
        {control("Shuffle", "shuffle", () => command("shuffle", state.shuffle ? 0 : 1), state.shuffle)}
        {control("Previous track", "skip-back", () => command("previous"))}
        {control(playing ? "Pause" : "Play", playing ? "pause" : "play", () => command("toggle"), false, true)}
        {control("Next track", "skip-forward", () => command("next"))}
        {control(
          state.repeat === "one" ? "Repeat one" : state.repeat === "all" ? "Repeat all" : "Repeat off",
          state.repeat === "one" ? "repeat-one" : "repeat",
          () => command("repeat", nextRepeat(state.repeat)),
          state.repeat !== "off",
        )}
      </View>
      {!twoPane && (
        <Pressable accessibilityRole="button" accessibilityLabel="Up next" accessibilityState={{ expanded: queueOpen }} onPress={() => setQueueOpen((open) => !open)} style={s.nowUpNext}>
          <Text style={s.eyebrow}>UP NEXT</Text>
          <Text numberOfLines={1} style={[s.caption, s.flex]}>
            {queue.rows[0]?.track.title || (queue.shuffled ? "Shuffling" : state.repeat !== "off" ? "Repeat is on" : "Nothing after this")}
          </Text>
          <Icon name={queueOpen ? "chevron-down" : "chevron"} color={c.mute} size={16} />
        </Pressable>
      )}
    </View>
  );
  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={onClose}>
      <Animated.View
        style={[
          s.nowRoot,
          {
            opacity: slide,
            transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [lift, 0] }) }],
          },
        ]}
      >
        <SafeAreaView style={s.flex}>
          <View style={s.nowHeader} {...swipe.panHandlers}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close now playing" onPress={onClose} style={s.viewerIconButtonDark}>
              <Icon name="chevron-down" color={c.ink} />
            </Pressable>
            <View style={[s.flex, s.stack]}>
              <Text style={s.eyebrow}>PLAYING FROM</Text>
              <Text numberOfLines={1} style={s.rowTitle}>
                {queue.name || "Music"}
              </Text>
            </View>
          </View>
          <View style={twoPane ? s.nowSplit : s.flex}>
            <ScrollView style={s.flex} contentContainerStyle={s.nowScroll}>
              {main}
            </ScrollView>
            {twoPane && !!state?.id && <View style={s.nowQueue}>{list}</View>}
          </View>
          {!twoPane && queueOpen && !!state?.id && (
            <>
              <Pressable accessibilityRole="button" accessibilityLabel="Close queue" onPress={() => setQueueOpen(false)} style={s.nowQueueScrim} />
              <View style={s.nowQueueSheet}>
                <View style={s.nowQueueHead}>
                  <Text style={[s.eyebrow, s.flex]}>UP NEXT</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="Close queue" onPress={() => setQueueOpen(false)} style={s.viewerIconButtonDark}>
                    <Icon name="chevron-down" color={c.ink} />
                  </Pressable>
                </View>
                {list}
              </View>
            </>
          )}
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}
