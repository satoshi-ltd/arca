import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Image,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Busy, Button, Icon, Scaffold, useDesign } from "./components";
import { dateLabel } from "./gallery-timeline";
import { photoInfo } from "./photo-info";
import { localPhotoInfo } from "./local-photo-info";
import {
  clampOffset,
  distance,
  midpoint,
  toggleZoom,
  zoomAround,
} from "./viewer-gestures";

const rest = { scale: 1, x: 0, y: 0 };
const begin = (touches, state, gesture) =>
  touches.length > 1
    ? {
        pinch: true,
        state,
        distance: Math.max(1, distance(touches[0], touches[1])),
        mid: midpoint(touches[0], touches[1]),
      }
    : { pinch: false, state, dx: gesture.dx, dy: gesture.dy };

function ZoomableImage({ uri, width, height, onTap, onZoomed, onError }) {
  const { s } = useDesign();
  const state = useRef(rest);
  const scale = useRef(new Animated.Value(1)).current;
  const offset = useRef(new Animated.ValueXY()).current;
  const gesture = useRef(null);
  const taps = useRef({ at: 0, timer: null });
  const viewport = useMemo(() => ({ width, height }), [width, height]);
  const apply = (next, animated = false) => {
    state.current = next;
    onZoomed(next.scale > 1);
    if (!animated) {
      scale.setValue(next.scale);
      offset.setValue({ x: next.x, y: next.y });
      return;
    }
    Animated.parallel([
      Animated.timing(scale, {
        toValue: next.scale,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(offset, {
        toValue: { x: next.x, y: next.y },
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();
  };
  useEffect(() => {
    apply(rest);
    return () => clearTimeout(taps.current.timer);
  }, [uri, width, height]);
  const tap = (x, y) => {
    const now = Date.now();
    if (now - taps.current.at < 300) {
      clearTimeout(taps.current.timer);
      taps.current.at = 0;
      apply(
        toggleZoom(
          state.current,
          { x: x - width / 2, y: y - height / 2 },
          viewport,
        ),
        true,
      );
      return;
    }
    taps.current.at = now;
    taps.current.timer = setTimeout(onTap, 300);
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (event) =>
          event.nativeEvent.touches.length > 1 || state.current.scale > 1,
        onMoveShouldSetPanResponder: (event) =>
          event.nativeEvent.touches.length > 1 || state.current.scale > 1,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event, g) => {
          gesture.current = begin(event.nativeEvent.touches, state.current, g);
        },
        onPanResponderMove: (event, g) => {
          const touches = event.nativeEvent.touches;
          let begun = gesture.current;
          if (!begun) return;
          if (touches.length > 1 !== begun.pinch)
            begun = gesture.current = begin(touches, state.current, g);
          if (begun.pinch) {
            const [a, b] = touches;
            const mid = midpoint(a, b);
            const zoomed = zoomAround(
              begun.state,
              (begun.state.scale * distance(a, b)) / begun.distance,
              { x: begun.mid.x - width / 2, y: begun.mid.y - height / 2 },
              viewport,
            );
            apply({
              scale: zoomed.scale,
              ...clampOffset(
                {
                  x: zoomed.x + mid.x - begun.mid.x,
                  y: zoomed.y + mid.y - begun.mid.y,
                },
                zoomed.scale,
                viewport,
              ),
            });
          } else if (state.current.scale > 1) {
            apply({
              ...state.current,
              ...clampOffset(
                {
                  x: begun.state.x + g.dx - begun.dx,
                  y: begun.state.y + g.dy - begun.dy,
                },
                state.current.scale,
                viewport,
              ),
            });
          }
        },
        onPanResponderRelease: (event, g) => {
          const begun = gesture.current;
          gesture.current = null;
          if (
            begun &&
            !begun.pinch &&
            Math.abs(g.dx) < 6 &&
            Math.abs(g.dy) < 6 &&
            event.nativeEvent.touches.length === 0
          )
            tap(event.nativeEvent.pageX, event.nativeEvent.pageY);
          if (state.current.scale < 1.02) apply(rest, true);
        },
      }),
    [viewport],
  );
  return (
    <View style={[s.viewerPage, viewport]} {...responder.panHandlers}>
      <Pressable
        style={viewport}
        accessibilityRole="image"
        accessibilityLabel="Photo"
        onPress={(event) =>
          tap(event.nativeEvent.pageX, event.nativeEvent.pageY)
        }
      >
        <Animated.Image
          source={{ uri }}
          resizeMode="contain"
          style={[
            viewport,
            {
              transform: [
                { translateX: offset.x },
                { translateY: offset.y },
                { scale },
              ],
            },
          ]}
          onError={onError}
        />
      </Pressable>
    </View>
  );
}

function Page({ item, width, height, resolveLarge, open, onTap, onZoomed }) {
  const { s } = useDesign();
  const [uri, setUri] = useState(item.uri);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setUri(item.uri);
    if (!item.uri && item.kind === "image" && item.hash)
      resolveLarge(item)
        .then((value) => active && setUri(value))
        .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [item.path, item.uri, item.hash]);
  const frame = [s.viewerPage, { width, height }];
  if (item.kind === "video")
    return (
      <Pressable style={frame} onPress={onTap} accessibilityLabel="Video">
        {!!item.poster && (
          <Image
            source={{ uri: item.poster }}
            resizeMode="contain"
            style={[s.viewerPoster, { width, height }]}
          />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Play video"
          style={s.viewerPlay}
          onPress={() => open(item)}
        >
          <Icon name="play" color="#fff" size={32} />
        </Pressable>
      </Pressable>
    );
  if (failed || (!uri && !item.hash))
    return (
      <Pressable style={frame} onPress={onTap}>
        <Icon name="image" color="rgba(255,255,255,0.6)" size={32} />
        <Text style={s.viewerCaption}>
          {item.uri
            ? "This photo could not be displayed."
            : "Preview unavailable. Connect to the hub to view it."}
        </Text>
      </Pressable>
    );
  if (!uri)
    return (
      <Pressable style={frame} onPress={onTap}>
        <Busy color="#fff" />
      </Pressable>
    );
  return (
    <ZoomableImage
      uri={uri}
      width={width}
      height={height}
      onTap={onTap}
      onZoomed={onZoomed}
      onError={() => setFailed(true)}
    />
  );
}

function InfoRow({ icon, label, value, detail, children }) {
  const { s, c } = useDesign();
  return (
    <View style={s.infoRow}>
      <Icon name={icon} color={c.mute} />
      <View style={[s.flex, s.infoValues]}>
        <Text style={s.infoLabel}>{label}</Text>
        {!!value && <Text style={s.text}>{value}</Text>}
        {!!detail && <Text style={s.caption}>{detail}</Text>}
        {children}
      </View>
    </View>
  );
}

// Same fields and formats as the desktop Info panel; a sheet on phones, a side panel on the Fold.
function InfoPanel({ item, state, folderName, onClose, history }) {
  const { s, c, wide } = useDesign();
  const insets = useSafeAreaInsets();
  const info = photoInfo(item, state?.value, folderName);
  return (
    <View
      style={[
        s.infoPanel,
        wide ? s.infoSide : s.infoSheet,
        wide ? { paddingTop: insets.top } : { paddingBottom: insets.bottom },
      ]}
    >
      <View style={s.sheetHeader}>
        <Text accessibilityRole="header" style={[s.heading, s.flex]}>
          Photo details
        </Text>
        <Button label="Close" quiet icon="close" iconOnly onPress={onClose} />
      </View>
      <ScrollView style={s.sheetScroll} contentContainerStyle={s.infoBody}>
        <View style={s.infoIdentity}>
          <Icon
            name={item.kind === "video" ? "file-video" : "image"}
            color={c.accent}
            size={24}
          />
          <Text selectable style={s.infoFilename}>
            {info.name}
          </Text>
          {!!info.summary && <Text style={s.caption}>{info.summary}</Text>}
        </View>
        {!!state?.loading && <Scaffold label="Loading details" />}
        {!!state?.hint && <Text style={s.caption}>{state.hint}</Text>}
        {(!!info.capture.length ||
          !!info.metrics.length ||
          !!info.location) && (
          <View style={s.section}>
            <Text style={s.eyebrow}>CAPTURE</Text>
            {!!info.capture.length && (
              <View style={s.infoCard}>
                {info.capture.map((row) => (
                  <InfoRow key={row.label} {...row} />
                ))}
              </View>
            )}
            {!!info.metrics.length && (
              <View style={s.infoMetrics}>
                {info.metrics.map(([label, value]) => (
                  <View key={label} style={s.infoMetric}>
                    <Text style={s.infoLabel}>{label}</Text>
                    <Text style={s.infoMetricValue}>{value}</Text>
                  </View>
                ))}
              </View>
            )}
            {!!info.location && (
              <View style={s.infoCard}>
                <InfoRow
                  icon="map-pin"
                  label="Location"
                  value={info.location.text}
                >
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="Open in Maps"
                    style={s.row}
                    onPress={() => Linking.openURL(info.location.url)}
                  >
                    <Text style={s.infoLink}>Open in Maps</Text>
                    <Icon name="external" color={c.accent} size={16} />
                  </Pressable>
                </InfoRow>
              </View>
            )}
          </View>
        )}
        <View style={s.section}>
          <Text style={s.eyebrow}>IN ARCA</Text>
          <View style={s.infoCard}>
            {info.arca.map((row) => (
              <InfoRow key={row.label} {...row} />
            ))}
          </View>
        </View>
      </ScrollView>
      <View style={s.infoFooter}>
        <Button
          label="File history"
          icon="history"
          onPress={() => history(item)}
        />
      </View>
    </View>
  );
}

export function PhotoViewer({
  items,
  index,
  onClose,
  onIndexChange,
  resolveLarge,
  info,
  folderName,
  open,
  history,
  share,
  remove,
  deletable,
}) {
  const { s } = useDesign();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [chrome, setChrome] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [metadata, setMetadata] = useState({});
  const list = useRef(null);
  const visible = index != null && index >= 0 && index < items.length;
  const item = visible ? items[index] : null;
  useEffect(() => {
    if (visible) {
      setChrome(true);
      setZoomed(false);
      setInfoOpen(false);
    }
  }, [visible]);
  useEffect(() => {
    if (
      !infoOpen ||
      !item ||
      (metadata[item.path]?.complete &&
        metadata[item.path]?.signature === item.signature)
    )
      return;
    let active = true;
    const path = item.path;
    const update = (change) =>
      active &&
      setMetadata((all) => ({ ...all, [path]: { ...all[path], ...change } }));
    update({
      loading: true,
      complete: false,
      signature: item.signature,
      hint: "",
    });
    // The local copy answers first; the hub only adds acceptance and history.
    const local = item.uri
      ? localPhotoInfo(item).catch(() => null)
      : Promise.resolve(null);
    local.then((value) =>
      update({ value, loading: !!item.hash, complete: !item.hash }),
    );
    if (!item.hash) {
      if (!item.uri)
        update({ hint: "Connect to the hub for capture details." });
      return () => {
        active = false;
      };
    }
    Promise.all([local, info(item).catch((error) => ({ error }))]).then(
      ([mine, hub]) =>
        update({
          loading: false,
          complete: !hub.error,
          value: hub.error
            ? mine
            : {
                ...hub,
                ...Object.fromEntries(
                  Object.entries(mine || {}).filter(([, v]) => v != null),
                ),
              },
          hint:
            hub.error && !mine
              ? hub.error.message || "Details are unavailable right now."
              : "",
        }),
    );
    return () => {
      active = false;
    };
  }, [infoOpen, item?.path, item?.signature]);
  useEffect(() => {
    if (visible) list.current?.scrollToIndex({ index, animated: false });
  }, [width, index, visible]);
  return (
    <Modal
      visible={visible}
      onRequestClose={() => (infoOpen ? setInfoOpen(false) : onClose())}
      animationType="fade"
      statusBarTranslucent
      presentationStyle="fullScreen"
      supportedOrientations={["portrait", "landscape"]}
    >
      <StatusBar
        barStyle="light-content"
        backgroundColor="#000"
        hidden={!chrome}
      />
      <View style={s.viewerRoot}>
        {visible && (
          <FlatList
            ref={list}
            data={items}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={index}
            getItemLayout={(_, position) => ({
              length: width,
              offset: width * position,
              index: position,
            })}
            keyExtractor={(entry) => entry.path}
            windowSize={3}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            scrollEnabled={!zoomed}
            onMomentumScrollEnd={(event) => {
              const next = Math.round(
                event.nativeEvent.contentOffset.x / width,
              );
              if (next !== index && next >= 0 && next < items.length)
                onIndexChange(next);
            }}
            renderItem={({ item: entry, index: position }) => (
              <Page
                item={entry}
                width={width}
                height={height}
                resolveLarge={resolveLarge}
                open={open}
                onTap={() => setChrome((value) => !value)}
                onZoomed={(value) => {
                  if (position === index) setZoomed(value);
                }}
              />
            )}
          />
        )}
        {chrome && item && (
          <View
            style={[s.viewerChrome, s.viewerTop, { paddingTop: insets.top }]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={s.viewerIconButton}
              onPress={onClose}
            >
              <Icon name="back" color="#fff" />
            </Pressable>
            <Text style={[s.viewerTitle, s.flex]} numberOfLines={1}>
              {item.upload
                ? item.upload === "failed"
                  ? "Needs attention"
                  : "Uploading"
                : dateLabel(item.date) || item.path.split("/").pop()}
            </Text>
            {!!item.uri && !item.upload && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Share photo"
                style={s.viewerIconButton}
                onPress={() => share(item)}
              >
                <Icon name="export" color="#fff" />
              </Pressable>
            )}
            {!item.upload && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Photo information"
                accessibilityState={{ expanded: infoOpen }}
                style={s.viewerIconButton}
                onPress={() => setInfoOpen((value) => !value)}
              >
                <Icon name="info" color="#fff" />
              </Pressable>
            )}
            {deletable && !!item.uri && !item.upload && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete photo"
                style={s.viewerIconButton}
                onPress={() => remove(item)}
              >
                <Icon name="trash" color="#fff" />
              </Pressable>
            )}
          </View>
        )}
        {infoOpen && item && (
          <InfoPanel
            item={item}
            state={metadata[item.path]}
            folderName={folderName}
            onClose={() => setInfoOpen(false)}
            history={history}
          />
        )}
      </View>
    </Modal>
  );
}
