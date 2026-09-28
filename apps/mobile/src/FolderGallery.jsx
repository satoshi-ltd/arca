import { nativeGallerySources, galleryDisplay } from "./gallery-display";
import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Image,
  Pressable,
  PanResponder,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Button, Icon, Scaffold, useDesign } from "./components";
import {
  groupByMonth,
  mergeTimeline,
  photoCount,
  visibleGalleryMonth,
  pendingUploadLabel,
} from "./gallery-timeline";
import { hubGallery } from "./hub-gallery";
import { hubPreviewFiles } from "./hub-previews";
import { prepareThumbnails } from "./thumbnail-cache";
import { thumbnailFiles } from "./gallery-thumbnails";
import { ScrollPosition } from "./KeyboardPane";
import { PhotoViewer } from "./PhotoViewer";

import { GalleryYear } from "./GalleryYear";
import {
  compactColumns,
  pinchLevel,
  pinchCell,
  pinchGroup,
  levelColumns,
  galleryTileSize,
  galleryYears,
} from "./gallery-scale";

const PAGE = 60;

function Tile({ item, uri, size, onPress, onLongPress, selected }) {
  const { s, c } = useDesign();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        item.upload
          ? `${item.name || "Photo"} · ${item.upload === "failed" ? "Needs attention" : "Uploading"}`
          : `Open ${item.path}`
      }
      style={[
        s.photoTile,
        {
          width: size,
          height: size,
          ...(size < 40 ? { borderRadius: 2 } : {}),
        },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityState={{ selected: !!selected }}
    >
      {uri && !failed ? (
        <Image
          source={{ uri }}
          style={s.galleryImage}
          resizeMode="cover"
          resizeMethod="resize"
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={s.galleryPlaceholder}>
          <Icon
            name={item.kind === "video" ? "file-video" : "image"}
            color={c.mute}
            size={Math.min(24, size / 2)}
          />
        </View>
      )}
      {selected && (
        <View style={s.photoBadge}>
          <Icon name="check" size={14} color="#fff" />
        </View>
      )}
      {!selected && size >= 40 && (item.kind === "video" || !!item.upload) && (
        <View style={s.photoBadge}>
          <Icon
            size={14}
            color="#fff"
            name={
              item.upload
                ? item.upload === "failed"
                  ? "alert"
                  : "upload"
                : "play"
            }
          />
        </View>
      )}
    </Pressable>
  );
}

// One timeline for every role: hub rows order it, local copies and hub previews fill it.
export function FolderGallery({
  api,
  connected,
  store,
  scope,
  volume,
  entries,
  loading,
  uploads,
  notice,
  refreshKey,
  demand,
  onDates,
  seekRef,
  scrollRef,
  railRef,
  onSummary,
  folderName,
  resolveVideo,
  history,
  share,
  remove,
  columns = 4,
}) {
  const { s, c } = useDesign();
  const position = useContext(ScrollPosition);
  const positionRef = useRef(position);
  positionRef.current = position;
  const rootRef = useRef(null);
  const monthPositions = useRef(new Map());
  const rootTop = useRef(0);
  const rootLayout = useRef(null);
  const lastScrollY = useRef(0);
  const [level, setLevel] = useState("base");
  const density = levelColumns(level, columns);
  const gridPositions = useRef(new Map());
  const pinch = useRef(null),
    anchor = useRef(null),
    layout = useRef(null);
  const suppressPressUntil = useRef(0);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [selection, setSelection] = useState([]);
  const toggle = (item) =>
    setSelection((items) =>
      items.some((p) => p.path === item.path)
        ? items.filter((p) => p.path !== item.path)
        : [...items, item].slice(0, 100),
    );
  const hub = useMemo(
    () => hubGallery({ api, store, scope, volume }),
    [api, store, scope, volume],
  );
  const previews = useMemo(() => hubPreviewFiles(api, volume), [api, volume]);
  const nativeSource = useMemo(
    () =>
      uploads
        ? nativeGallerySources({
            store: uploads.store,
            media: uploads.media,
            scope,
            volume,
          })
        : undefined,
    [uploads?.store, uploads?.media, scope, volume, refreshKey],
  );
  const display = (item, large = false, fallback = false) =>
    galleryDisplay(item, {
      large,
      fallback,
      nativeSource,
      localPreview: thumbnailFiles.render,
      hubPreview: (photo, full) =>
        full ? previews.large(photo) : previews.thumbnail(photo),
    });
  const [index, setIndex] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState([]);
  const [thumbnails, setThumbnails] = useState({});
  const thumbnailProgress = useRef(null);
  const [limit, setLimit] = useState(PAGE);
  const [viewer, setViewer] = useState(null);
  const [hidden, setHidden] = useState(() => new Map());
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState("");
  const pagingRef = useRef(false);
  const [width, setWidth] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    let timer;
    let reading = false;
    const refresh = async () => {
      if (
        !active ||
        reading ||
        !connected ||
        AppState.currentState === "background"
      )
        return;
      reading = true;
      clearTimeout(timer);
      try {
        const fresh = await hub.first();
        if (active) {
          setIndex(fresh);
          setError("");
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        reading = false;
        if (active) timer = setTimeout(refresh, 5000);
      }
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
      else clearTimeout(timer);
    });
    (async () => {
      const cached = await hub.cached();
      if (active && cached) setIndex(cached);
      await refresh();
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [hub, connected, refreshKey, retry]);
  useEffect(() => {
    if (!uploads) {
      setPending([]);
      return;
    }
    let active = true;
    (async () => {
      const rows = await uploads.store.galleryPreview(scope, volume, false, 24);
      const resolved = await Promise.all(
        rows.map(async (row) => {
          try {
            return { ...row, ...(await uploads.media.preview(row.id)) };
          } catch {
            return row;
          }
        }),
      );
      if (active) setPending(resolved);
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [
    uploads?.store,
    uploads?.media,
    scope,
    volume,
    uploads?.summary?.pending,
    uploads?.summary?.failed,
    uploads?.scannedAt,
    refreshKey,
  ]);
  const baseItems = useMemo(
    () =>
      mergeTimeline({ index: index?.items, entries, uploads: pending })
        .filter(
          (item) =>
            !selectedMonth ||
            item.upload ||
            (item.date || "").slice(0, 7) <= selectedMonth,
        )
        .filter(
          (item) =>
            !hidden.has(item.path) || Number(item.rev) > hidden.get(item.path),
        ),
    [index, entries, pending, hidden, selectedMonth],
  );
  const dates = useMemo(() => {
    const months = new Map(
      (index?.timeline || []).map((row) => [row.month, row]),
    );
    const localMonths = new Map();
    for (const item of mergeTimeline({ entries })) {
      const month = (item.date || "").slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(month))
        localMonths.set(month, (localMonths.get(month) || 0) + 1);
    }
    for (const [month, count] of localMonths) {
      if (!months.has(month)) months.set(month, { month, count });
    }
    return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  }, [index?.timeline, entries]);
  const years = useMemo(() => galleryYears(dates), [dates]);
  useEffect(() => {
    onDates?.(density === "years" ? years : dates);
  }, [dates, years, density, onDates]);
  useEffect(() => {
    if (!seekRef) return;
    let active = true;
    seekRef.current = async (month, openPhotos = false) => {
      if (layout.current?.density === "years" && !openPhotos) {
        const box = monthPositions.current.get(month);
        if (box) positionRef.current?.scrollTo(rootTop.current + box.top);
        return;
      }
      anchor.current = null;
      setSelectedMonth(month);
      const grid = layout.current;
      const rows = Math.ceil(
        (positionRef.current?.viewport.height || 800) / (grid.tile + grid.gap),
      );
      setLimit(
        Math.max(
          PAGE,
          (openPhotos ? compactColumns(grid.columns) : grid.density) *
            (rows + 3),
        ),
      );
      monthPositions.current.clear();
      positionRef.current?.scrollTo(rootTop.current);
      if (connected) {
        try {
          const next = await hub.seek(month);
          if (active) {
            setIndex(next);
            setPageError("");
          }
        } catch (error) {
          if (active) setPageError(error.message);
        }
      }
    };
    return () => {
      active = false;
      seekRef.current = null;
    };
  }, [hub, connected, seekRef]);
  useEffect(() => {
    if (!scrollRef) return;
    scrollRef.current = (y, reveal = true) => {
      lastScrollY.current = y;
      const month =
        visibleGalleryMonth(monthPositions.current, y, rootTop.current) ||
        selectedMonth ||
        dates[0]?.month;
      const rail = railRef?.current;
      if (reveal) rail?.show(month);
      else rail?.update(month);
    };
    return () => {
      scrollRef.current = null;
    };
  }, [scrollRef, railRef, dates, selectedMonth]);
  const [nativeUris, setNativeUris] = useState({ resolver: null, values: {} });
  useEffect(() => {
    let active = true;
    if (!nativeSource) return;
    (async () => {
      const values = {};
      for (const item of baseItems.slice(0, limit)) {
        if (!active) return;
        if (item.uri) continue;
        const uri = await nativeSource(item);
        if (uri) values[`${item.path}:${item.hash}`] = uri;
      }
      if (active) setNativeUris({ resolver: nativeSource, values });
    })();
    return () => {
      active = false;
    };
  }, [baseItems, limit, nativeSource]);
  const withNative = (item) => {
    const uri =
      nativeUris.resolver === nativeSource &&
      nativeUris.values[`${item.path}:${item.hash}`];
    return uri && !item.uri ? { ...item, uri, nativeSource: true } : item;
  };
  const items = useMemo(
    () => baseItems.map(withNative),
    [baseItems, nativeUris, nativeSource],
  );
  const count = photoCount(items);
  useEffect(() => {
    onSummary?.({ count: Math.max(count, index?.total || 0) });
  }, [count, index?.total]);
  const shown = useMemo(() => items.slice(0, limit), [items, limit]);
  useEffect(() => {
    if (demand && items.length > limit) setLimit((value) => value + PAGE);
  }, [demand]);
  const more = async () => {
    if (pagingRef.current || !connected || !index?.next) return;
    pagingRef.current = true;
    setPaging(true);
    setPageError("");
    try {
      const next = await hub.more(index);
      if (live.current) setIndex(next);
    } catch (e) {
      if (live.current) setPageError(e.message);
    } finally {
      pagingRef.current = false;
      if (live.current) setPaging(false);
    }
  };
  useEffect(() => {
    if (
      density !== "years" &&
      !loading &&
      !pageError &&
      limit >= (index?.items.length || 0)
    )
      void more();
  }, [limit, index?.next, connected, loading, density]);
  const io = useMemo(
    () => ({
      exists: thumbnailFiles.exists,
      render: (item) =>
        item.kind === "video" ? previews.thumbnail(item) : display(item),
    }),
    [previews, nativeSource],
  );
  useEffect(() => {
    let active = true;
    if (density === "years") return;
    const key = `gallery-thumbnails:${scope}:${volume}`;
    (async () => {
      const cached =
        thumbnailProgress.current?.key === key
          ? thumbnailProgress.current.value
          : await store.get(key, {}).catch(() => ({}));
      if (!active) return;
      thumbnailProgress.current = { key, value: cached };
      setThumbnails(cached);
      if (loading) return;
      const next = await prepareThumbnails(
        shown.filter((item) => !item.upload),
        cached,
        io,
        () => active,
        (value) => {
          if (!active) return;
          thumbnailProgress.current = { key, value };
          setThumbnails(value);
        },
        items,
      );
      if (active && next) await store.set(key, next).catch(() => {});
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [shown, loading, store, scope, volume, io, density]);
  const { gap, size: tile } = galleryTileSize(
    width,
    density === "years" ? compactColumns(columns) : density,
  );
  const pendingItems = useMemo(
    () => items.filter((item) => item.upload),
    [items],
  );
  const groups = useMemo(
    () => groupByMonth(shown.filter((item) => !item.upload)),
    [shown],
  );
  layout.current = {
    groups:
      density === "years"
        ? years.map((year) => ({ ...year, items: [] }))
        : groups,
    years,
    density,
    level,
    columns,
    tile,
    gap,
    width,
  };
  const pinchResponder = useMemo(() => {
    const distance = (touches) =>
      Math.hypot(
        touches[0].pageX - touches[1].pageX,
        touches[0].pageY - touches[1].pageY,
      );
    const finish = () => {
      pinch.current = null;
      suppressPressUntil.current = Date.now() + 300;
      positionRef.current?.setGestureActive(false);
    };
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) =>
        event.nativeEvent.touches.length === 2,
      onMoveShouldSetPanResponderCapture: (event) =>
        event.nativeEvent.touches.length === 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const touches = event.nativeEvent.touches;
        if (touches.length !== 2) return;
        const gesture = { distance: distance(touches) };
        pinch.current = gesture;
        suppressPressUntil.current = Infinity;
        positionRef.current?.setGestureActive(true);
        const pageY = (touches[0].pageY + touches[1].pageY) / 2;
        const pageX = (touches[0].pageX + touches[1].pageX) / 2;
        rootRef.current?.measureInWindow((x, top) => {
          if (pinch.current !== gesture) return;
          const localY = pageY - top;
          const state = layout.current;
          const group = pinchGroup(
            state.groups,
            monthPositions.current,
            localY,
          );
          if (!group) return;
          const box = monthPositions.current.get(group.month);
          if (state.density === "years") {
            gesture.anchor = {
              month: group.month,
              index: 0,
              viewportY:
                rootTop.current + (box?.top || 0) - lastScrollY.current,
            };
            return;
          }
          if (!box) return;
          const gridTop =
            box.top + (gridPositions.current.get(group.month) || 0);
          const step = state.tile + state.gap;
          const cell = pinchCell(
            group.items.length,
            state.density,
            step,
            pageX - x,
            localY - gridTop,
          );
          gesture.anchor = {
            month: group.month,
            index: cell.index,
            viewportY:
              rootTop.current + gridTop + cell.row * step - lastScrollY.current,
          };
        });
      },
      onPanResponderMove: (event) => {
        const touches = event.nativeEvent.touches,
          gesture = pinch.current;
        if (
          !gesture ||
          gesture.changed ||
          touches.length !== 2 ||
          !gesture.anchor
        )
          return;
        const state = layout.current;
        const nextLevel = pinchLevel(
          state.level,
          distance(touches) / Math.max(1, gesture.distance),
        );
        if (nextLevel === state.level) return;
        gesture.changed = true;
        if (state.level === "years") {
          setLevel("compact");
          void seekRef?.current?.(gesture.anchor.month, true);
          return;
        }
        const next = levelColumns(nextLevel, state.columns);
        const year = state.years.find(
          (item) => item.year === gesture.anchor.month.slice(0, 4),
        );
        anchor.current =
          next !== "years"
            ? gesture.anchor
            : year
              ? { ...gesture.anchor, month: year.month, index: 0 }
              : null;
        monthPositions.current.clear();
        setLevel(nextLevel);
        if (next === "years") return;
        const size = galleryTileSize(state.width, next);
        const rows = Math.ceil(
          (positionRef.current?.viewport.height || 800) /
            (size.size + size.gap),
        );
        setLimit((value) => Math.max(value, next * (rows + 3)));
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, []);
  useEffect(() => () => positionRef.current?.setGestureActive(false), []);
  const photos = useMemo(
    () =>
      items.map((item) =>
        item.kind === "video"
          ? { ...item, poster: thumbnails[item.path]?.uri }
          : item,
      ),
    [items, thumbnails],
  );
  const thumb = (item) =>
    thumbnails[item.path]?.signature === item.signature
      ? thumbnails[item.path].uri
      : item.uri || null;
  const leave = (action) => (item) => {
    setViewer(null);
    action(item);
  };
  async function deleteItems(item) {
    const result = await remove(item);
    if (!result) return;
    setSelection((items) =>
      items.filter((photo) => !result.some((row) => row.path === photo.path)),
    );
    setHidden(
      (value) =>
        new Map([...value, ...result.map((row) => [row.path, row.rev])]),
    );
    for (const row of result) void hub.forget(row.path).catch(() => {});
    setViewer((value) => {
      if (!value) return null;
      const remaining = value.items.filter(
        (photo) => !result.some((row) => row.path === photo.path),
      );
      return remaining.length
        ? {
            items: remaining,
            index: Math.min(value.index, remaining.length - 1),
          }
        : null;
    });
  }
  return (
    <View
      ref={rootRef}
      {...pinchResponder.panHandlers}
      style={s.timeline}
      onLayout={(event) => {
        const { y, width } = event.nativeEvent.layout;
        setWidth(width);
        // Zoom height changes can clamp scrolling before its offset event; never remeasure the unchanged root.
        if (rootLayout.current?.y === y && rootLayout.current?.width === width)
          return;
        rootLayout.current = { y, width };
        position?.measure(rootRef.current, ({ top }) => {
          rootTop.current = top;
          scrollRef?.current?.(lastScrollY.current, false);
        });
      }}
    >
      {!!selection.length && (
        <View style={s.row}>
          <Button
            label={`Delete ${selection.length} selected…`}
            danger
            onPress={async () => {
              await deleteItems(selection);
            }}
          />
          <Button label="Cancel selection" onPress={() => setSelection([])} />
        </View>
      )}
      {!!notice && <Text style={s.caption}>{notice}</Text>}

      {!!pendingItems.length && (
        <View style={s.pendingUploads}>
          <View style={s.timelineStatus}>
            <Text style={[s.timelineMonth, s.flex]}>Pending uploads</Text>
            <Text style={s.caption}>
              {pendingUploadLabel(pendingItems, uploads?.summary)}
            </Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.pendingUploadStrip}
          >
            {pendingItems.map((item) => (
              <Tile
                key={item.path}
                item={item}
                size={72}
                uri={item.uri}
                onPress={() =>
                  setViewer({
                    items: photos,
                    index: photos.findIndex(
                      (photo) => photo.path === item.path,
                    ),
                  })
                }
              />
            ))}
          </ScrollView>
        </View>
      )}
      {!!error && !items.length && (
        <View style={s.stack}>
          <Text style={s.caption}>{error}</Text>
          {connected && (
            <Button
              label="Retry"
              onPress={() => {
                setError("");
                setRetry((value) => value + 1);
              }}
            />
          )}
        </View>
      )}
      {density === "years" &&
        years.map((year) => (
          <GalleryYear
            key={year.year}
            year={year}
            api={api}
            connected={connected}
            store={store}
            scope={scope}
            volume={volume}
            entries={entries}
            io={io}
            width={width}
            onPress={() => {
              if (Date.now() <= suppressPressUntil.current) return;
              setLevel("compact");
              void seekRef?.current?.(year.month, true);
            }}
            onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              monthPositions.current.set(year.month, { top: y, height });
              if (anchor.current?.month === year.month) {
                positionRef.current?.scrollTo(
                  Math.max(0, rootTop.current + y - anchor.current.viewportY),
                );
                anchor.current = null;
              }
              scrollRef?.current?.(lastScrollY.current, false);
            }}
          />
        ))}
      {density !== "years" &&
        !!tile &&
        groups.map((group) => (
          <View
            key={group.month}
            style={s.timelineGroup}
            onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              monthPositions.current.set(group.month, { top: y, height });
              const target = anchor.current;
              if (target?.month === group.month) {
                const row = Math.floor(target.index / density);
                const top =
                  rootTop.current +
                  y +
                  (gridPositions.current.get(group.month) || 0) +
                  row * (tile + gap);
                positionRef.current?.scrollTo(
                  Math.max(0, top - target.viewportY),
                );
                anchor.current = null;
              }
              scrollRef?.current?.(lastScrollY.current, false);
            }}
          >
            <Text style={s.timelineMonth}>{group.label}</Text>
            <View
              style={[s.photoGrid, { gap }]}
              onLayout={(event) =>
                gridPositions.current.set(
                  group.month,
                  event.nativeEvent.layout.y,
                )
              }
            >
              {group.items.map((item) => (
                <Tile
                  key={item.path}
                  item={item}
                  size={tile}
                  uri={thumb(item)}
                  selected={selection.some((photo) => photo.path === item.path)}
                  onLongPress={
                    remove && Number.isSafeInteger(item.rev)
                      ? () => {
                          if (Date.now() > suppressPressUntil.current)
                            toggle(item);
                        }
                      : undefined
                  }
                  onPress={() =>
                    Date.now() <= suppressPressUntil.current
                      ? undefined
                      : selection.length
                        ? toggle(item)
                        : setViewer({
                            items: photos,
                            index: photos.findIndex(
                              (photo) => photo.path === item.path,
                            ),
                          })
                  }
                />
              ))}
            </View>
          </View>
        ))}
      {density !== "years" &&
        !items.length &&
        (loading || (!index && connected && !error) ? (
          <Scaffold label="Loading photos" />
        ) : (
          <View style={s.center}>
            <Icon name="image" size={32} color={c.mute} />
            <Text style={s.heading}>No photos yet</Text>
            <Text style={s.caption}>
              {uploads
                ? "Photos from this phone appear here as they upload."
                : "Photos appear here as they arrive from other devices."}
            </Text>
          </View>
        ))}
      {!!pageError && <Text style={s.caption}>{pageError}</Text>}
      {density !== "years" &&
        (items.length > limit || (connected && index?.next)) && (
          <Button
            label={
              paging
                ? "Loading photos…"
                : pageError
                  ? "Retry loading photos"
                  : "Show more"
            }
            disabled={paging}
            onPress={() => {
              setLimit((value) => value + PAGE);
              void more();
            }}
          />
        )}
      <PhotoViewer
        items={viewer ? viewer.items.map(withNative) : photos}
        index={viewer?.index ?? null}
        onClose={() => setViewer(null)}
        onIndexChange={(index) =>
          setViewer((value) => value && { ...value, index })
        }
        resolveLarge={(item, fallback = false) => display(item, true, fallback)}
        info={(item) =>
          api(
            `/v1/gallery/info?${new URLSearchParams({ volume, path: item.path, hash: item.hash })}`,
          )
        }
        folderName={folderName}
        resolveVideo={resolveVideo}
        history={leave(history)}
        share={leave(share)}
        deletable={!!remove}
        remove={deleteItems}
      />
    </View>
  );
}
