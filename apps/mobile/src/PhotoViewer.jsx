import { GalleryVideo } from "./GalleryVideo";
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
  StyleSheet,
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
  decideRelease,
  distance,
  dragLook,
  isVerticalIntent,
  midpoint,
  toggleZoom,
  zoomAround,
} from "./viewer-gestures";
import { useMotion } from "./motion";

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

function ZoomableImage({ uri, preview, width, height, onZoomed, onError, onTap, onDrag, onDragEnd, onAction }) {
  const { s } = useDesign();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [uri]);
  const state = useRef(rest);
  const scale = useRef(new Animated.Value(1)).current;
  const offset = useRef(new Animated.ValueXY()).current;
  const gesture = useRef(null);
  const taps = useRef({ at: 0 });
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
    taps.current.at = 0;
  }, [uri, width, height]);
  const tap = (x, y) => {
    const now = Date.now();
    if (now - taps.current.at < 300) {
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
    clearTimeout(taps.current.timer);
    taps.current.timer = setTimeout(() => {
      if (taps.current.at === now) onTap?.();
    }, 300);
  };
  useEffect(() => () => clearTimeout(taps.current.timer), []);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (event) =>
          event.nativeEvent.touches.length > 1 || state.current.scale > 1,
        onMoveShouldSetPanResponder: (event, g) =>
          event.nativeEvent.touches.length > 1 ||
          state.current.scale > 1 ||
          (!!onDrag && isVerticalIntent(g.dx, g.dy, state.current.scale)),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event, g) => {
          gesture.current = {
            ...begin(event.nativeEvent.touches, state.current, g),
            drag:
              event.nativeEvent.touches.length === 1 &&
              state.current.scale <= 1.02 &&
              !!onDrag,
          };
        },
        onPanResponderMove: (event, g) => {
          const touches = event.nativeEvent.touches;
          let begun = gesture.current;
          if (!begun) return;
          if (begun.drag) {
            if (touches.length > 1) {
              onDragEnd?.(0, 0);
              gesture.current = begun = { ...begin(touches, state.current, g), drag: false };
            } else {
              onDrag(g.dy - begun.dy);
              return;
            }
          }
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
        onPanResponderTerminate: () => {
          const begun = gesture.current;
          gesture.current = null;
          if (begun?.drag) onDragEnd?.(0, 0);
        },
        onPanResponderRelease: (event, g) => {
          const begun = gesture.current;
          gesture.current = null;
          if (begun?.drag) {
            onDragEnd?.(g.dy - begun.dy, g.vy);
            return;
          }
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
    [viewport, onDrag, onDragEnd],
  );
  return (
    <View style={[s.viewerPage, viewport]} {...responder.panHandlers}>
      <Pressable
        style={viewport}
        accessibilityRole="image"
        accessibilityLabel="Photo"
        accessibilityActions={onAction ? [
          { name: "details", label: "Photo details" },
          { name: "controls", label: "Show or hide controls" },
          { name: "dismiss", label: "Close photo" },
        ] : undefined}
        onAccessibilityAction={(event) => onAction?.(event.nativeEvent.actionName)}
        onPress={(event) =>
          tap(event.nativeEvent.pageX, event.nativeEvent.pageY)
        }
      >
        {!loaded && !!preview && (
          <Image
            source={{ uri: preview }}
            resizeMode="contain"
            style={s.viewerPreview}
          />
        )}
        <Animated.Image
          source={{ uri }}
          resizeMode="contain"
          onLoad={() => setLoaded(true)}
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

function Page({
  item,
  width,
  height,
  resolveLarge,
  resolveVideo,
  active,
  held,
  onZoomed,
  onTap,
  onDrag,
  onDragEnd,
  onAction,
}) {
  const { s } = useDesign();
  const compatiblePreview = !item.nativeSource && /\.hei[cf]$/i.test(item.path);
  const [uri, setUri] = useState(compatiblePreview ? null : item.uri);
  const [failed, setFailed] = useState(false);
  const fallbackRef = useRef(null);
  useEffect(() => {
    let active = true;
    let retried = false;
    fallbackRef.current = () => {
      if (retried) {
        setFailed(true);
        return;
      }
      retried = true;
      resolveLarge(item, true)
        .then((value) => active && setUri(value))
        .catch(() => active && setFailed(true));
    };
    setFailed(false);
    setUri(compatiblePreview ? null : item.uri);
    if (
      item.kind === "image" &&
      (compatiblePreview || (!item.uri && item.hash))
    )
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
      <GalleryVideo
        item={item}
        active={active}
        held={held}
        resolveVideo={resolveVideo}
        frame={frame}
      />
    );
  if (failed || (!uri && !item.hash && !compatiblePreview))
    return (
      <View style={frame}>
        <Icon name="image" color="rgba(255,255,255,0.6)" size={32} />
        <Text style={s.viewerCaption}>
          {item.uri
            ? "This photo could not be displayed."
            : "This photo is not on this phone yet. It appears once synchronization downloads it."}
        </Text>
      </View>
    );
  if (!uri)
    return (
      <View style={frame}>
        {!!item.preview && (
          <Image
            source={{ uri: item.preview }}
            resizeMode="contain"
            style={s.viewerPreview}
          />
        )}
        <Busy color="#fff" />
      </View>
    );
  return (
    <ZoomableImage
      uri={uri}
      preview={item.preview}
      width={width}
      height={height}
      onZoomed={onZoomed}
      onTap={onTap}
      onDrag={onDrag}
      onDragEnd={onDragEnd}
      onAction={onAction}
      onError={() => fallbackRef.current?.()}
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => !wide && g.dy > 12 && g.dy > Math.abs(g.dx) * 1.5,
        onPanResponderRelease: (_, g) => {
          if (g.dy > 60 || g.vy > 1) closeRef.current();
        },
      }),
    [wide],
  );
  return (
    <View
      style={[
        s.infoPanel,
        wide ? s.infoSide : s.infoSheet,
        wide ? { paddingTop: insets.top } : { paddingBottom: insets.bottom },
      ]}
    >
      <View style={s.sheetHeader} {...swipe.panHandlers}>
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
  resolveVideo,
  history,
  share,
  remove,
  deletable,
  deleteReason,
}) {
  const { s, wide } = useDesign();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { duration } = useMotion();
  const [zoomed, setZoomed] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [chromeOn, setChromeOn] = useState(false);
  const drag = useRef(new Animated.Value(0)).current;
  const chrome = useRef(new Animated.Value(0)).current;
  const live = useRef({});
  live.current = { height, wide, onClose, duration };
  useEffect(() => {
    Animated.timing(chrome, {
      toValue: chromeOn ? 1 : 0,
      duration: duration(120),
      useNativeDriver: true,
    }).start();
  }, [chromeOn]);
  const onTap = useRef(() => setChromeOn((value) => !value)).current;
  const onDrag = useRef((dy) => {
    const { height: h } = live.current;
    const look = dragLook(dy, h);
    drag.setValue(look.translateY);
  }).current;
  const onAction = useRef((name) => {
    if (name === "details") setInfoOpen(true);
    else if (name === "controls") setChromeOn((value) => !value);
    else if (name === "dismiss") live.current.onClose();
  }).current;
  const onDragEnd = useRef((dy, vy) => {
    const { height: h, wide: fold, onClose: close, duration: ms } = live.current;
    const action = decideRelease({ dy, vy, height: h, wide: fold });
    const back = () =>
      Animated.timing(drag, { toValue: 0, duration: ms(200), useNativeDriver: true }).start();
    if (action === "close")
      Animated.timing(drag, { toValue: h, duration: ms(200), useNativeDriver: true }).start(
        () => {
          close();
          drag.setValue(0);
        },
      );
    else {
      back();
      if (action === "info") setInfoOpen(true);
    }
  }).current;
  const [metadata, setMetadata] = useState({});
  const list = useRef(null);
  const strip = useRef(null);
  const visible = index != null && index >= 0 && index < items.length;
  const item = visible ? items[index] : null;
  const canShare = !!item?.uri && !item?.upload && !!share;
  const canDelete =
    deletable && Number.isSafeInteger(item?.rev) && !item?.upload && !!remove;
  useEffect(() => {
    if (visible) {
      setZoomed(false);
      setInfoOpen(false);
      setChromeOn(false);
      drag.setValue(0);
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
  useEffect(() => {
    if (visible && chromeOn)
      strip.current?.scrollToOffset({ offset: Math.max(0, 52 * index - width / 2 + 26), animated: true });
  }, [index, chromeOn, visible]);
  return (
    <Modal
      visible={visible}
      onRequestClose={() => (infoOpen ? setInfoOpen(false) : onClose())}
      animationType="fade"
      transparent
      statusBarTranslucent
      supportedOrientations={["portrait", "landscape"]}
    >
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <View style={[s.viewerRoot, s.viewerTransparent]}>
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            s.viewerBackdrop,
            { opacity: drag.interpolate({ inputRange: [0, height / 2], outputRange: [1, 0], extrapolate: "clamp" }) },
          ]}
        />
        <Animated.View
          style={[
            s.flex,
            {
              transform: [
                { translateY: drag },
                { scale: drag.interpolate({ inputRange: [0, height], outputRange: [1, 0.6], extrapolate: "clamp" }) },
              ],
            },
          ]}
        >
        {visible && (
          <FlatList
            ref={list}
            data={items}
            extraData={`${index}:${infoOpen}`}
            horizontal
            pagingEnabled
            directionalLockEnabled
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
                resolveVideo={resolveVideo}
                active={visible && position === index}
                held={infoOpen}
                onZoomed={(value) => {
                  if (position === index) setZoomed(value);
                }}
                onTap={onTap}
                onDrag={onDrag}
                onDragEnd={onDragEnd}
                onAction={onAction}
              />
            )}
          />
        )}
        </Animated.View>
        {item && (
          <Animated.View
            pointerEvents={chromeOn ? "box-none" : "none"}
            style={[
              s.viewerChrome,
              s.viewerTop,
              {
                paddingTop: insets.top,
                opacity: Animated.multiply(
                  chrome,
                  drag.interpolate({ inputRange: [0, height / 6], outputRange: [1, 0], extrapolate: "clamp" }),
                ),
              },
            ]}
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
                ? {
                    failed: "Needs attention",
                    lost: "No longer on this phone",
                  }[item.upload] || "Uploading"
                : dateLabel(item.date) || item.path.split("/").pop()}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share photo"
              accessibilityState={{ disabled: !canShare }}
              accessibilityHint={
                !canShare
                  ? "Available when the original is downloaded and its upload is complete."
                  : undefined
              }
              disabled={!canShare}
              style={[s.viewerIconButton, !canShare && s.disabled]}
              onPress={() => share(item)}
            >
              <Icon name="export" color="#fff" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Photo information"
              accessibilityState={{ expanded: infoOpen }}
              style={s.viewerIconButton}
              onPress={() => setInfoOpen((value) => !value)}
            >
              <Icon name="info" color="#fff" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete photo"
              accessibilityState={{ disabled: !canDelete }}
              accessibilityHint={
                !canDelete
                  ? deleteReason ||
                    "Available after the hub confirms the photo. Originals stay in Photos."
                  : undefined
              }
              disabled={!canDelete}
              style={[s.viewerIconButton, !canDelete && s.disabled]}
              onPress={() => remove(item)}
            >
              <Icon name="trash" color="#fff" />
            </Pressable>
          </Animated.View>
        )}
        {item && items.length > 1 && (
          <Animated.View
            pointerEvents={chromeOn ? "box-none" : "none"}
            style={[s.viewerStrip, { paddingBottom: insets.bottom + 8, opacity: chrome }]}
          >
            <Text style={s.viewerCount}>{`${index + 1} of ${items.length}`}</Text>
            <FlatList
              ref={strip}
              horizontal
              data={items}
              extraData={index}
              keyExtractor={(entry) => `strip:${entry.path}`}
              showsHorizontalScrollIndicator={false}
              initialNumToRender={9}
              windowSize={5}
              getItemLayout={(_, position) => ({ length: 52, offset: 52 * position, index: position })}
              contentOffset={{ x: Math.max(0, 52 * index - width / 2 + 26), y: 0 }}
              renderItem={({ item: entry, index: position }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Photo ${position + 1} of ${items.length}`}
                  accessibilityState={{ selected: position === index }}
                  onPress={() => onIndexChange(position)}
                  style={[s.viewerThumb, position === index && s.viewerThumbOn]}
                >
                  {!!(entry.preview || entry.uri) && (
                    <Image source={{ uri: entry.preview || entry.uri }} resizeMethod="resize" style={s.viewerThumbImage} />
                  )}
                </Pressable>
              )}
            />
          </Animated.View>
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
