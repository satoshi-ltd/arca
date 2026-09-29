import { nativeGallerySources, galleryDisplay } from "./gallery-display";
import React, {
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  Image,
  Pressable,
  PanResponder,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  Button,
  Icon,
  MediaPlaceholder,
  Scaffold,
  useDesign,
} from "./components";
import {
  mergeTimeline,
  monthLabel,
  pendingUploadLabel,
  railMonthLabel,
  timelineItem,
} from "./gallery-timeline";
import { hubGallery, localGallery } from "./hub-gallery";
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
  galleryYears,
} from "./gallery-scale";
import {
  GALLERY_HEADER,
  galleryLayout,
  galleryWindow,
  itemOffset,
  keptOffset,
  neededMonth,
  sectionAt,
} from "./gallery-layout";

const Tile = memo(function Tile({
  item,
  uri,
  size,
  top,
  left,
  onPress,
  onLongPress,
  selected,
}) {
  const { s } = useDesign();
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
        top !== undefined && s.galleryCell,
        {
          width: size,
          height: size,
          ...(top !== undefined ? { top, left } : {}),
          ...(size < 40 ? { borderRadius: 2 } : {}),
        },
      ]}
      onPress={() => onPress(item)}
      onLongPress={onLongPress && (() => onLongPress(item))}
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
        <MediaPlaceholder size={size} video={item.kind === "video"} />
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
});

// Hub rows only order the timeline; its pixels always come from files on this phone.
export function FolderGallery({
  api,
  connected,
  offline = false,
  store,
  scope,
  volume,
  entries,
  loading,
  uploads,
  notice,
  refreshKey,
  onRail,
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
  const linked = connected && !offline;
  const [failures, setFailures] = useState(0);
  const online = linked && failures < 2;
  const position = useContext(ScrollPosition);
  const positionRef = useRef(position);
  positionRef.current = position;
  const rootRef = useRef(null);
  const yearPositions = useRef(new Map());
  const rootTop = useRef(0);
  const rootLayout = useRef(null);
  const canvasTop = useRef(0);
  const canvasHeight = useRef(0);
  const shownLayout = useRef(null);
  const lastScrollY = useRef(0);
  const [measured, setMeasured] = useState(0);
  const [level, setLevel] = useState("base");
  const density = levelColumns(level, columns);
  const pinch = useRef(null),
    anchor = useRef(null),
    layoutRef = useRef(null);
  const suppressPressUntil = useRef(0);
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
    });
  const [gallery, setGallery] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState([]);
  const [thumbnails, setThumbnails] = useState({});
  const thumbnailProgress = useRef(null);
  const [viewer, setViewer] = useState(null);
  const [hidden, setHidden] = useState(() => new Map());
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ top: -800, bottom: 2400 });
  const bucket = useRef(null);
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
        !linked ||
        AppState.currentState === "background"
      )
        return;
      reading = true;
      clearTimeout(timer);
      try {
        const fresh = await hub.refresh();
        if (active) {
          setGallery(fresh);
          setFailures(0);
          setError("");
        }
      } catch (e) {
        if (active) {
          setFailures((count) => count + 1);
          setError(e.message);
        }
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
      if (active && cached) setGallery(cached);
      await refresh();
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [hub, linked, refreshKey, retry]);
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
  const entryByPath = useMemo(
    () =>
      new Map(
        entries
          .filter((entry) => !entry.directory)
          .map((entry) => [entry.path, entry]),
      ),
    [entries],
  );
  const local = useMemo(() => localGallery(entries), [entries]);
  const source = gallery && (online || !local.total) ? gallery : local;
  const monthCache = useRef(new Map());
  const months = useMemo(() => {
    const view = new Map();
    for (const [month, entry] of Object.entries(source.months)) {
      const known = monthCache.current.get(month);
      if (
        known?.entry === entry &&
        known.byPath === entryByPath &&
        known.hidden === hidden
      ) {
        view.set(month, known.items);
        continue;
      }
      const items = entry.items
        .map((row) =>
          source.local ? row : timelineItem(row, entryByPath.get(row.path)),
        )
        .filter(
          (item) =>
            item &&
            (!hidden.has(item.path) || Number(item.rev) > hidden.get(item.path)),
        );
      monthCache.current.set(month, {
        entry,
        byPath: entryByPath,
        hidden,
        items,
      });
      view.set(month, items);
    }
    return view;
  }, [source, entryByPath, hidden]);
  const sections = useMemo(() => {
    const list = source.timeline
      .map(({ month, count }) => {
        const entry = source.months[month];
        const shown = months.get(month)?.length || 0;
        const removed = entry ? entry.items.length - shown : 0;
        return {
          month,
          count: entry?.complete ? shown : Math.max(shown, count - removed),
        };
      })
      .filter((section) => section.count > 0);
    const undated = source.months.undated;
    if (undated && (undated.items.length || !undated.complete))
      list.unshift({
        month: "undated",
        count:
          (months.get("undated")?.length || 0) + (undated.complete ? 0 : 1),
      });
    return list;
  }, [source, months]);
  const years = useMemo(() => galleryYears(source.timeline), [source.timeline]);
  const layout = useMemo(
    () =>
      galleryLayout(
        sections,
        width,
        density === "years" ? compactColumns(columns) : density,
      ),
    [sections, width, density, columns],
  );
  const rows = useMemo(
    () =>
      density === "years" ? [] : galleryWindow(layout, range.top, range.bottom),
    [layout, range, density],
  );
  const cells = useMemo(() => {
    const list = [];
    for (const { section, first, last } of rows) {
      const items = months.get(section.month) || [];
      for (let row = first; row <= last; row++)
        for (let column = 0; column < layout.columns; column++) {
          const index = row * layout.columns + column;
          if (index >= section.count) break;
          list.push({
            month: section.month,
            index,
            item: items[index],
            top: section.gridTop + row * layout.step,
            left: column * layout.step,
          });
        }
    }
    return list;
  }, [rows, months, layout]);
  const visibleItems = useMemo(
    () => cells.map((cell) => cell.item).filter(Boolean),
    [cells],
  );
  const visibleKey = useMemo(
    () =>
      visibleItems.map((item) => `${item.path}:${item.signature}`).join("\n"),
    [visibleItems],
  );
  const loaded = useMemo(() => {
    const seen = new Set();
    return sections
      .flatMap((section) => months.get(section.month) || [])
      .filter((item) => !seen.has(item.path) && seen.add(item.path));
  }, [sections, months]);
  const complete =
    source.months.undated?.complete !== false &&
    source.timeline.every(({ month }) => source.months[month]?.complete);
  const native = useRef({ resolver: null, values: {} });
  const [, setNativeVersion] = useState(0);
  useEffect(() => {
    if (!nativeSource) return;
    let active = true;
    if (native.current.resolver !== nativeSource)
      native.current = { resolver: nativeSource, values: {} };
    (async () => {
      const found = {};
      for (const item of visibleItems) {
        if (!active) return;
        const key = `${item.path}:${item.hash}`;
        if (item.uri || key in native.current.values) continue;
        found[key] = (await nativeSource(item)) || null;
      }
      if (!active || !Object.keys(found).length) return;
      Object.assign(native.current.values, found);
      setNativeVersion((value) => value + 1);
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [visibleKey, nativeSource]);
  const withNative = (item) => {
    const uri =
      native.current.resolver === nativeSource &&
      native.current.values[`${item.path}:${item.hash}`];
    return uri && !item.uri ? { ...item, uri, nativeSource: true } : item;
  };
  useEffect(() => {
    onSummary?.({ count: Math.max(loaded.length, source.total || 0) });
  }, [loaded.length, source.total]);
  const io = useMemo(
    () => ({
      exists: thumbnailFiles.exists,
      render: (item) =>
        item.kind === "video" ? thumbnailFiles.poster(item) : display(item),
    }),
    [nativeSource],
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
        visibleItems
          .filter((item) => !item.upload)
          .map(withNative)
          .sort((a, b) => (a.kind === "video") - (b.kind === "video")),
        cached,
        io,
        () => active,
        (value) => {
          if (!active) return;
          thumbnailProgress.current = { key, value };
          setThumbnails(value);
        },
        complete
          ? loaded
          : [...loaded, ...Object.keys(cached).map((path) => ({ path }))],
      );
      if (active && next) await store.set(key, next).catch(() => {});
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [visibleKey, loading, store, scope, volume, io, density]);
  const followTimer = useRef(null),
    followedAt = useRef(0);
  const follow = (y) => {
    lastScrollY.current = y;
    if (scrubbing.current) {
      const wait = 100 - (Date.now() - followedAt.current);
      clearTimeout(followTimer.current);
      if (wait > 0) {
        followTimer.current = setTimeout(
          () => followRef.current(lastScrollY.current),
          wait,
        );
        return;
      }
    }
    followedAt.current = Date.now();
    const half = Math.max(200, (positionRef.current?.viewport.height || 800) / 2);
    const next = Math.floor(
      (y - rootTop.current - canvasTop.current) / half,
    );
    if (next === bucket.current) return;
    bucket.current = next;
    setRange({ top: (next - 1) * half, bottom: (next + 4) * half });
  };
  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(() => {
    if (!scrollRef) return;
    scrollRef.current = (y, reveal = true) => {
      followRef.current(y);
      if (reveal) railRef?.current?.reveal(y);
    };
    return () => {
      scrollRef.current = null;
    };
  }, [scrollRef, railRef]);
  const remeasured = () => {
    bucket.current = null;
    follow(lastScrollY.current);
    setMeasured((value) => value + 1);
  };
  const pumping = useRef(false),
    scrubbing = useRef(0),
    scrubTimer = useRef(null),
    failedAt = useRef(0);
  const loader = useRef(null);
  loader.current = { gallery, source, layout, range, online, density };
  const pump = async () => {
    const current = loader.current;
    if (
      pumping.current ||
      Date.now() - scrubbing.current < 250 ||
      !live.current ||
      !current.online ||
      !current.gallery ||
      current.density === "years" ||
      Date.now() - failedAt.current < 3000
    )
      return;
    const top = lastScrollY.current - rootTop.current - canvasTop.current;
    if (current.source !== current.gallery) return;
    const month = neededMonth(
      current.layout,
      current.gallery.months,
      current.range.top,
      current.range.bottom,
      top,
      top + (positionRef.current?.viewport.height || 800),
    );
    if (!month) return;
    pumping.current = true;
    let next = null;
    try {
      next = await hub.load(month);
    } catch {
      failedAt.current = Date.now();
    }
    pumping.current = false;
    if (!live.current) return;
    if (next) setGallery(next);
    else setTimeout(() => void pumpRef.current(), 3100);
  };
  const pumpRef = useRef(pump);
  pumpRef.current = pump;
  useEffect(() => {
    void pumpRef.current();
  }, [gallery, layout, range, online, density]);
  layoutRef.current = { layout, years, density, level, columns, width };
  const applyAnchor = () => {
    const target = anchor.current,
      current = layoutRef.current;
    if (!target || current.density === "years" || !current.layout.step)
      return false;
    anchor.current = null;
    const offset = itemOffset(current.layout, target.month, target.index);
    if (offset === null) return false;
    const y = Math.max(
      0,
      rootTop.current + canvasTop.current + offset - target.viewportY,
    );
    positionRef.current?.scrollTo(y);
    follow(y);
    return true;
  };
  useEffect(() => {
    if (anchor.current && layout.height === canvasHeight.current)
      applyAnchor();
  }, [layout]);
  const keepPlace = (previous, previousTop) => {
    const offset = keptOffset(
      previous,
      layoutRef.current.layout,
      lastScrollY.current - rootTop.current - previousTop,
    );
    if (offset === null) return false;
    const y = rootTop.current + canvasTop.current + offset;
    if (Math.abs(y - lastScrollY.current) < 1) return false;
    positionRef.current?.scrollTo(y);
    follow(y);
    return true;
  };
  if (density === "years") shownLayout.current = null;
  const railShape = useMemo(
    () =>
      layout.sections.map((section) => `${section.month}:${section.top}`).join(","),
    [layout],
  );
  useEffect(() => {
    if (!onRail) return;
    const viewport = position?.viewport.height || 0;
    const start = rootTop.current + (density === "years" ? 0 : canvasTop.current);
    onRail({
      annual: density === "years",
      start,
      end: Math.max(start, (position?.contentSize.height || 0) - viewport),
      viewport,
      offset: () => lastScrollY.current,
      sections:
        density === "years"
          ? years
              .filter((year) => yearPositions.current.has(year.month))
              .map((year) => ({
                key: year.month,
                label: year.year,
                year: year.year,
                offset:
                  rootTop.current + yearPositions.current.get(year.month).top,
              }))
          : layout.sections.map((section) => ({
              key: section.month,
              label: railMonthLabel(section.month),
              year: /^\d{4}-/.test(section.month)
                ? section.month.slice(0, 4)
                : "",
              offset: start + section.top,
            })),
      scrollTo: (y) => {
        positionRef.current?.scrollTo(y);
        followRef.current(y);
        if (!scrubbing.current) return;
        scrubbing.current = Date.now();
        clearTimeout(scrubTimer.current);
        scrubTimer.current = setTimeout(() => void pumpRef.current(), 260);
      },
      scrub: (active) => {
        scrubbing.current = active ? Date.now() : 0;
        if (!active) void pumpRef.current();
      },
    });
  }, [
    onRail,
    railShape,
    density,
    years,
    measured,
    position?.contentSize.height,
    position?.viewport.height,
  ]);
  useEffect(
    () => () => {
      clearTimeout(scrubTimer.current);
      clearTimeout(followTimer.current);
      onRail?.(null);
    },
    [onRail],
  );
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
          const state = layoutRef.current;
          if (state.density === "years") {
            const group = pinchGroup(
              state.years,
              yearPositions.current,
              localY,
            );
            if (!group) return;
            gesture.anchor = {
              month: group.month,
              index: 0,
              viewportY:
                rootTop.current +
                (yearPositions.current.get(group.month)?.top || 0) -
                lastScrollY.current,
            };
            return;
          }
          const grid = state.layout;
          const y = localY - canvasTop.current;
          const section = grid.sections[sectionAt(grid, y)];
          if (!section) return;
          const cell = pinchCell(
            section.count,
            grid.columns,
            grid.step,
            pageX - x,
            y - section.gridTop,
          );
          gesture.anchor = {
            month: section.month,
            index: cell.index,
            viewportY:
              rootTop.current +
              canvasTop.current +
              section.gridTop +
              cell.row * grid.step -
              lastScrollY.current,
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
        const state = layoutRef.current;
        const nextLevel = pinchLevel(
          state.level,
          distance(touches) / Math.max(1, gesture.distance),
        );
        if (nextLevel === state.level) return;
        gesture.changed = true;
        if (state.level === "years") {
          anchor.current = { ...gesture.anchor, index: 0 };
          setLevel("compact");
          return;
        }
        const year = state.years.find(
          (item) => item.year === gesture.anchor.month.slice(0, 4),
        );
        anchor.current =
          levelColumns(nextLevel, state.columns) !== "years"
            ? gesture.anchor
            : year
              ? { ...gesture.anchor, month: year.month, index: 0 }
              : null;
        yearPositions.current.clear();
        setLevel(nextLevel);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, []);
  useEffect(() => () => positionRef.current?.setGestureActive(false), []);
  const pendingItems = useMemo(
    () => mergeTimeline({ uploads: pending }),
    [pending],
  );
  const photos = useMemo(
    () =>
      [...pendingItems, ...loaded].map((item) =>
        item.kind === "video"
          ? { ...item, poster: thumbnails[item.path]?.uri }
          : item,
      ),
    [pendingItems, loaded, thumbnails],
  );
  const thumb = (item) =>
    thumbnails[item.path]?.signature === item.signature
      ? thumbnails[item.path].uri
      : item.uri || null;
  const actions = useRef({});
  actions.current = {
    open: (item) =>
      setViewer({
        items: photos,
        index: photos.findIndex((photo) => photo.path === item.path),
      }),
    press: (item) => {
      if (Date.now() <= suppressPressUntil.current) return;
      if (selection.length) toggle(item);
      else actions.current.open(item);
    },
    select: (item) => {
      if (Date.now() > suppressPressUntil.current) toggle(item);
    },
  };
  const handlers = useRef({
    open: (item) => actions.current.open(item),
    press: (item) => actions.current.press(item),
    select: (item) => actions.current.select(item),
  }).current;
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
          remeasured();
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
                onPress={handlers.open}
              />
            ))}
          </ScrollView>
        </View>
      )}
      {!!error && !sections.length && (
        <View style={s.stack}>
          <Text style={s.caption}>{error}</Text>
          {linked && (
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
            connected={online}
            store={store}
            scope={scope}
            volume={volume}
            entries={entries}
            io={io}
            width={width}
            onPress={() => {
              if (Date.now() <= suppressPressUntil.current) return;
              anchor.current = {
                month: year.month,
                index: 0,
                viewportY: GALLERY_HEADER + 8,
              };
              setLevel("compact");
            }}
            onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              yearPositions.current.set(year.month, { top: y, height });
              if (anchor.current?.month === year.month) {
                positionRef.current?.scrollTo(
                  Math.max(0, rootTop.current + y - anchor.current.viewportY),
                );
                anchor.current = null;
              }
              setMeasured((value) => value + 1);
            }}
          />
        ))}
      {density !== "years" && !!layout.tile && !!sections.length && (
        <View
          style={[s.galleryCanvas, { height: layout.height }]}
          onLayout={(event) => {
            const { y, height } = event.nativeEvent.layout;
            const previous = shownLayout.current,
              previousTop = canvasTop.current;
            canvasTop.current = y;
            canvasHeight.current = height;
            shownLayout.current = layoutRef.current.layout;
            if (applyAnchor() || keepPlace(previous, previousTop)) return;
            if (y !== previousTop) remeasured();
          }}
        >
          {rows
            .filter((row) => row.header)
            .map(({ section }) => (
              <Text
                key={`month:${section.month}`}
                numberOfLines={1}
                style={[s.timelineMonth, s.galleryHeader, { top: section.top }]}
              >
                {monthLabel(section.month)}
              </Text>
            ))}
          {cells.map((cell) => {
            const item = cell.item && withNative(cell.item);
            return item ? (
              <Tile
                key={`${cell.month}:${item.path}`}
                item={item}
                size={layout.tile}
                top={cell.top}
                left={cell.left}
                uri={thumb(item)}
                selected={selection.some((photo) => photo.path === item.path)}
                onPress={handlers.press}
                onLongPress={
                  remove && Number.isSafeInteger(item.rev)
                    ? handlers.select
                    : undefined
                }
              />
            ) : (
              <View
                key={`${cell.month}:${cell.index}`}
                style={[
                  s.photoTile,
                  s.galleryCell,
                  {
                    top: cell.top,
                    left: cell.left,
                    width: layout.tile,
                    height: layout.tile,
                  },
                ]}
              >
                <MediaPlaceholder size={layout.tile} />
              </View>
            );
          })}
        </View>
      )}
      {density !== "years" &&
        !sections.length &&
        (loading || (!gallery && linked && !error) ? (
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
