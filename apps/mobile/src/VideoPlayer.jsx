import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, Image, Modal, Pressable, StatusBar, View, useWindowDimensions } from "react-native";
import { Text } from "./Text";
import { requireOptionalNativeModule, useEvent } from "expo";
import { Busy, Button, Icon, useDesign } from "./components";
import { episodeCode, playerTitles } from "./video-library.js";
import { NETWORK_LEFT } from "./video-sync.js";
import { CONTROLS_HIDE, clock, countdown, initialPlayer, playerStep, scrubAction, seekTarget } from "./video-player-state.js";
import { audioOptions, currentAudio, libraryAudioOptions, rememberedAudio, sameLanguage } from "./video-audio.js";
import { COMPATIBLE_AUDIO, absoluteTime, audioForLanguage, createRestarter, fullDuration, recoveryPlan, seekPlan } from "./video-compatible.js";
import { applyChoice, chosenKey, cueText, restoreChoice, subtitleOptions, titleKey } from "./subtitles.js";

const video = requireOptionalNativeModule("ExpoVideo") ? require("expo-video") : null;
const { useVideoPlayer, VideoView } = video || {};
const TICK = 1000;
const remembered = new Map();
const rememberedLanguage = new Map();

function Scrubber({ position, duration, seek }) {
  const { s } = useDesign();
  const [width, setWidth] = useState(0);
  const value = duration > 0 ? Math.min(1, position / duration) : 0;
  const at = (x) => width > 0 && duration > 0 && seek(Math.max(0, Math.min(1, x / width)) * duration);
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="Position"
      accessibilityValue={{ text: `${clock(position)} of ${clock(duration)}` }}
      accessibilityActions={[
        { name: "increment", label: "Forward 30 seconds" },
        { name: "decrement", label: "Back 10 seconds" },
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        const target = scrubAction(nativeEvent.actionName, position, duration);
        if (target != null) seek(target);
      }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onResponderRelease={(event) => at(event.nativeEvent.locationX)}
      style={s.videoScrub}
    >
      <View style={s.videoScrubTrack}>
        <View style={[s.videoScrubFill, { width: `${Math.round(value * 1000) / 10}%` }]} />
      </View>
    </View>
  );
}

function Round({ icon, label, onPress, size = 24, big = false }) {
  const { s, c } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [big ? s.videoRoundBig : s.videoRound, pressed && s.pressedFade]}
    >
      <Icon name={icon} size={size} color={c.onMedia} />
    </Pressable>
  );
}

function Playback({ session, source, next, art, onClose, onNext, save, watchNetwork, loadCues, reopen, initialAudio = null }) {
  const { s, c } = useDesign();
  const player = useVideoPlayer(null);
  const [current, setCurrent] = useState(() => ({ ...source, at: source.compatible ? 0 : session.at }));
  const currentRef = useRef(current);
  currentRef.current = current;
  const [reopening, setReopening] = useState(false);
  const holding = useRef(false);
  const produced = useRef(0);
  const switching = useRef(false);
  const fellBack = useRef(!!source.compatible);
  const retried = useRef(false);
  const chosenAudio = useRef(source.compatible ? source.audio ?? initialAudio : initialAudio);
  const restarter = useRef(null);
  if (!restarter.current)
    restarter.current = createRestarter((request, fresh) => {
      holding.current = true;
      setReopening(true);
      return live.current
        .reopen({ mode: "compatible", ...request })
        .then((value) => {
          if (!fresh()) return;
          setLoadError(null);
          switching.current = true;
          if (value.compatible) chosenAudio.current = value.audio ?? request.audio ?? null;
          setCurrent({ ...value, at: value.compatible ? 0 : request.start || 0 });
        })
        .catch((failure) => fresh() && setLoadError(failure))
        .finally(() => {
          if (!fresh()) return;
          holding.current = false;
          setReopening(false);
        });
    });
  useEffect(() => () => restarter.current.stop(), []);
  const model = useRef(initialPlayer(Date.now(), session.at));
  const [, render] = useState(0);
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const touched = useRef(Date.now());
  const { status, error } = useEvent(player, "statusChange", { status: player.status });
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  const { availableSubtitleTracks } = useEvent(player, "availableSubtitleTracksChange", { availableSubtitleTracks: [] });
  const { subtitleTrack } = useEvent(player, "subtitleTrackChange", { subtitleTrack: null });
  const { currentTime } = useEvent(player, "timeUpdate", { currentTime: 0 });
  const { availableAudioTracks } = useEvent(player, "availableAudioTracksChange", { availableAudioTracks: [] });
  const { audioTrack } = useEvent(player, "audioTrackChange", { audioTrack: null });
  const audios = current.compatible ? libraryAudioOptions(session.item.audioTracks) : audioOptions(availableAudioTracks, session.item.audioTracks);
  const audioNow = current.compatible
    ? audios.find((option) => option.stream === current.audio) || null
    : currentAudio(audios, audioTrack);
  const audioRestored = useRef(!!source.compatible);
  const chooseAudio = (option, remember = true) => {
    if (remember && option.language) rememberedLanguage.set(titleKey(session.item), option.language);
    if (current.compatible || (option.stream != null && COMPATIBLE_AUDIO.has(option.codec.toLowerCase()))) {
      if (current.compatible && option.stream === current.audio) return;
      chosenAudio.current = option.stream;
      restarter.current.now({ start: model.current.position, audio: option.stream });
      return;
    }
    try {
      player.audioTrack = option.track;
      chosenAudio.current = option.stream;
    } catch {
      return;
    }
  };
  useEffect(() => {
    if (audioRestored.current || audios.length < 2) return;
    audioRestored.current = true;
    const option = rememberedAudio(audios, rememberedLanguage.get(titleKey(session.item)));
    if (option && option !== audioNow) chooseAudio(option, false);
  }, [availableAudioTracks?.length]);
  const [sidecar, setSidecar] = useState(null);
  const [cues, setCues] = useState(null);
  const [cueError, setCueError] = useState("");
  const cueCache = useRef(new Map());
  const restored = useRef(false);
  const engineTrack = useRef(null);
  const options = subtitleOptions({ availableSubtitleTracks }, session.item.subtitles || []);
  const choose = (option, remember = true) => {
    const choice = applyChoice(option);
    try {
      player.subtitleTrack = choice.track;
    } catch {
      choice.track = null;
    }
    engineTrack.current = choice.track;
    setSidecar(choice.sidecar);
    if (remember) remembered.set(titleKey(session.item), option ? { key: option.key, kind: option.kind, label: option.label } : null);
  };
  useEffect(() => {
    if (restored.current) return;
    const option = restoreChoice(options, remembered.get(titleKey(session.item)));
    if (!option) {
      if (!engineTrack.current)
        try {
          player.subtitleTrack = null;
        } catch {}
      return;
    }
    restored.current = true;
    choose(option, false);
  }, [availableSubtitleTracks?.length]);
  useEffect(() => {
    let live = true;
    setCueError("");
    if (!sidecar) {
      setCues(null);
      return undefined;
    }
    const cached = cueCache.current.get(sidecar);
    if (cached) {
      setCues(cached);
      return undefined;
    }
    setCues(null);
    loadCues(sidecar)
      .then((value) => {
        cueCache.current.set(sidecar, value);
        if (live) setCues(value);
      })
      .catch((failure) => live && setCueError(failure.message || "These subtitles could not be loaded."));
    return () => {
      live = false;
    };
  }, [sidecar]);
  const live = useRef({});
  live.current = { next, onNext, save, reopen };
  const send = (event) => {
    const { state, effects } = playerStep(model.current, { now: Date.now(), ...event }, !!live.current.next);
    model.current = state;
    for (const effect of effects)
      if (effect.type === "save") live.current.save(effect.position, effect.duration);
      else if (effect.type === "next" && live.current.next) live.current.onNext(live.current.next);
    render((count) => count + 1);
  };
  useLayoutEffect(() => {
    let mounted = true;
    player.timeUpdateEventInterval = 0.25;
    player.staysActiveInBackground = false;
    player.keepScreenOnWhilePlaying = true;
    const titles = playerTitles(session.library, session.item);
    const subscription = AppState.addEventListener("change", (state) => state !== "active" && player.pause());
    produced.current = 0;
    player
      .replaceAsync({ uri: current.uri, ...(current.headers ? { headers: current.headers } : {}), metadata: { title: titles.title, artist: titles.subtitle } })
      .then(() => {
        if (!mounted) return;
        if (!engineTrack.current)
          try {
            player.subtitleTrack = null;
          } catch {}
        if (current.at > 0) player.currentTime = current.at;
        player.play();
      })
      .catch((failure) => mounted && setLoadError(failure));
    return () => {
      mounted = false;
      subscription.remove();
      let position = null;
      try {
        position = switching.current || holding.current ? null : absoluteTime(current, player.currentTime);
        player.pause();
      } catch {
        position = null;
      }
      switching.current = false;
      send({ type: "exit", position });
    };
  }, [player, current.uri]);
  useEffect(
    () =>
      watchNetwork?.(current, () => {
        restarter.current.stop();
        let position = null;
        try {
          position = absoluteTime(current, player.currentTime);
          player.pause();
        } catch {
          position = null;
        }
        send({ type: "pause", position });
        player.replaceAsync(null).catch(() => {});
        setLoadError(new Error(NETWORK_LEFT));
      }),
    [player, current.uri],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Number.isFinite(player.bufferedPosition)) produced.current = Math.max(produced.current, player.bufferedPosition);
      if (!holding.current && !restarter.current.pending())
        send({
          type: "tick",
          position: absoluteTime(currentRef.current, player.currentTime),
          duration: fullDuration(currentRef.current, session.item, player.duration),
          playing: player.playing,
        });
      if (player.playing && Date.now() - touched.current > CONTROLS_HIDE) setControls(false);
    }, TICK);
    const ended = player.addListener("playToEnd", () => send({ type: "ended" }));
    return () => {
      clearInterval(timer);
      ended.remove();
    };
  }, [player]);
  useEffect(() => {
    if (!isPlaying && status === "readyToPlay" && !holding.current && !restarter.current.pending()) send({ type: "pause", position: absoluteTime(currentRef.current, player.currentTime) });
  }, [isPlaying]);
  useEffect(() => {
    if (status === "readyToPlay" && currentRef.current.compatible && !holding.current) retried.current = false;
    if (status !== "error" && !loadError) return;
    const plan = recoveryPlan({
      compatible: !!currentRef.current.compatible,
      fellBack: fellBack.current,
      retried: retried.current,
      networkLeft: loadError?.message === NETWORK_LEFT,
    });
    if (!plan || holding.current) return;
    if (plan === "fallback") fellBack.current = true;
    else retried.current = true;
    restarter.current.now({ start: model.current.position, audio: chosenAudio.current });
  }, [status, loadError]);
  const seekTo = (target) => {
    wake();
    const plan = seekPlan(currentRef.current, target, { duration: player.duration, buffered: player.bufferedPosition, currentTime: player.currentTime, produced: produced.current });
    send({ type: "seek", position: target });
    if (!plan.local || holding.current || restarter.current.pending()) {
      restarter.current.request(target, { audio: chosenAudio.current });
      player.pause();
      return;
    }
    player.currentTime = plan.time;
  };
  const wake = () => {
    touched.current = Date.now();
    setControls(true);
  };
  const close = () => onClose();
  const tryAgain = () => {
    retried.current = false;
    restarter.current.now({ start: model.current.position, audio: chosenAudio.current });
  };
  const titles = playerTitles(session.library, session.item);
  const { position, duration } = model.current;
  const selectedKey = chosenKey(options, subtitleTrack, sidecar);
  const cue = sidecar && cues ? cueText(cues, absoluteTime(current, currentTime)) : null;
  const recovering = (status === "error" || !!loadError) && !!recoveryPlan({ compatible: !!current.compatible, fellBack: fellBack.current, retried: retried.current, networkLeft: loadError?.message === NETWORK_LEFT });
  const failed = !reopening && !recovering && (loadError || status === "error");
  const left = countdown(model.current, now);
  return (
    <View style={s.videoFrame}>
      <VideoView player={player} style={s.videoSurface} nativeControls={false} contentFit="contain" surfaceType="textureView" />
      <Pressable accessibilityLabel={controls ? "Hide controls" : "Show controls"} style={s.videoTapArea} onPress={() => (panel ? (setPanel(null), wake()) : controls ? setControls(false) : wake())} />
      {(reopening || recovering || status === "loading" || status === "idle") && !failed && (
        <View pointerEvents="none" style={s.viewerVideoLoading}>
          <Busy color={c.onMedia} />
        </View>
      )}
      {failed && (
        <View style={s.videoMessage}>
          <Text style={s.videoMessageText}>{loadError?.message || error?.message || "This video can't play on this phone."}</Text>
          <View style={s.row}>
            <Button label="Try again" icon="refresh" primary onPress={tryAgain} />
            <Button label="Close" onPress={close} />
          </View>
        </View>
      )}
      {(controls || failed) && (
        <View style={s.videoTop} pointerEvents="box-none">
          <Round icon="back" label="Close player" onPress={close} />
          <View style={[s.flex, s.stack]}>
            <Text numberOfLines={1} style={s.videoTitle}>
              {titles.title}
            </Text>
            {!!titles.subtitle && (
              <Text numberOfLines={1} style={s.videoSubtitle}>
                {titles.subtitle}
              </Text>
            )}
          </View>
          {!failed && audios.length > 1 && <Round icon="audio-lines" label="Audio" onPress={() => { wake(); setPanel(panel === "audio" ? null : "audio"); }} />}
          {!failed && <Round icon="captions" label="Subtitles" onPress={() => { wake(); setPanel(panel === "subtitles" ? null : "subtitles"); }} />}
        </View>
      )}
      {controls && !failed && (
        <View style={s.videoCenter} pointerEvents="box-none">
          <Round icon="rotate-ccw" label="Back 10 seconds" onPress={() => seekTo(seekTarget(position, duration, -10))} />
          <Round big size={36} icon={isPlaying ? "pause" : "play"} label={isPlaying ? "Pause" : "Play"} onPress={() => { wake(); isPlaying ? player.pause() : player.play(); }} />
          <Round icon="rotate-cw" label="Forward 30 seconds" onPress={() => seekTo(seekTarget(position, duration, 30))} />
        </View>
      )}
      {controls && !failed && (
        <View style={s.videoBottom}>
          <Scrubber
            position={position}
            duration={duration}
            seek={seekTo}
          />
          <View style={s.videoTimes}>
            <Text style={s.videoTime}>{clock(position)}</Text>
            <Text style={s.videoTime}>{`−${clock(Math.max(0, duration - position))}`}</Text>
          </View>
        </View>
      )}
      {!!cue && !failed && (
        <View pointerEvents="none" style={[s.videoCueBox, controls && s.videoCueRaised]}>
          <Text style={[s.videoCue, cue.italic && s.videoCueItalic]}>{cue.text}</Text>
        </View>
      )}
      {panel === "audio" && !failed && (
        <View style={s.videoPanel}>
          <Text style={s.videoPanelTitle}>Audio</Text>
          {audios.map((choice) => {
            const chosen = choice === audioNow;
            return (
              <Pressable
                key={choice.key}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
                onPress={() => {
                  chooseAudio(choice);
                  setPanel(null);
                }}
                style={({ pressed }) => [s.videoPanelRow, pressed && s.pressedFade]}
              >
                <Text style={s.videoPanelText}>{choice.label}</Text>
                {chosen && <Icon name="check" size={18} color={c.onMedia} />}
              </Pressable>
            );
          })}
        </View>
      )}
      {panel === "subtitles" && !failed && (
        <View style={s.videoPanel}>
          <Text style={s.videoPanelTitle}>Subtitles</Text>
          {options.map((choice) => {
            const chosen = choice.key === selectedKey;
            return (
              <Pressable
                key={choice.key}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
                onPress={() => {
                  choose(choice);
                  setPanel(null);
                }}
                style={({ pressed }) => [s.videoPanelRow, pressed && s.pressedFade]}
              >
                <Text style={s.videoPanelText}>{choice.label}</Text>
                {chosen && <Icon name="check" size={18} color={c.onMedia} />}
              </Pressable>
            );
          })}
          {!!cueError && <Text style={s.videoPanelNote}>{cueError}</Text>}
        </View>
      )}
      {left != null && next && (
        <View style={s.videoUpNext}>
          <Text style={s.videoSubtitle}>{`Up next · in ${left} s`}</Text>
          <View style={s.row}>
            <View style={s.videoUpNextStill}>
              {art(next.still) ? <Image source={{ uri: art(next.still) }} style={s.galleryImage} /> : <Icon name="tv" color={c.mediaGlyph} />}
            </View>
            <View style={[s.flex, s.stack]}>
              <Text numberOfLines={1} style={s.videoTitle}>
                {next.title || episodeCode(next)}
              </Text>
              <Text numberOfLines={1} style={s.videoSubtitle}>
                {episodeCode(next)}
              </Text>
            </View>
          </View>
          <View style={s.musicActions}>
            <Button primary size="small" label="Play now" icon="play" onPress={() => send({ type: "playNext" })} />
            <Button size="small" label="Cancel" onPress={() => send({ type: "cancel" })} />
          </View>
        </View>
      )}
    </View>
  );
}

export function VideoPlayer({ session, resolve, save, nextOf, art, onClose, onNext, watchNetwork, loadCues }) {
  const opening = (value) => ({
    ...value,
    start: value.at || 0,
    audio: audioForLanguage(value.item, rememberedLanguage.get(titleKey(value.item)), sameLanguage),
  });
  const { s, c } = useDesign();
  const { width, height } = useWindowDimensions();
  const [source, setSource] = useState(null);
  const [failure, setFailure] = useState("");
  const key = session ? `${session.volume}:${session.item.id}:${session.attempt || 0}` : "";
  useEffect(() => {
    let live = true;
    setSource(null);
    setFailure("");
    if (!session) return undefined;
    if (!video) {
      setFailure("Install the updated app to play videos.");
      return undefined;
    }
    resolve(opening(session))
      .then((value) => live && setSource({ key, value }))
      .catch((error) => live && setFailure(error.message));
    return () => {
      live = false;
    };
  }, [key]);
  const portrait = height > width;
  return (
    <Modal visible={!!session} animationType="none" onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]} statusBarTranslucent>
      <StatusBar hidden />
      <View style={s.videoRoot}>
        <View style={portrait ? [s.videoRotated, { width: height, height: width, transform: [{ rotate: "90deg" }] }] : s.videoLandscape}>
          {session && source?.key === key ? (
            <Playback
              key={key}
              session={session}
              source={source.value}
              watchNetwork={watchNetwork}
              loadCues={(path) => loadCues(session, path)}
              reopen={(request) => resolve({ ...opening(session), ...request })}
              initialAudio={opening(session).audio}
              next={nextOf(session.item)}
              art={(keyName) => art(keyName, "small")}
              onClose={onClose}
              onNext={onNext}
              save={(position, duration) => save(session, position, duration)}
            />
          ) : (
            <View style={s.videoMessage}>
              {failure ? (
                <>
                  <Text style={s.videoMessageText}>{failure}</Text>
                  <Button label="Close" onPress={onClose} />
                </>
              ) : (
                <Busy color={c.onMedia} />
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
