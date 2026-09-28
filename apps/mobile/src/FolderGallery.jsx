import { nativeGallerySources, galleryDisplay } from "./gallery-display";
import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Button, Icon, Scaffold, useDesign } from "./components";
import { groupByMonth, mergeTimeline, photoCount } from "./gallery-timeline";
import { hubGallery } from "./hub-gallery";
import { hubPreviewFiles } from "./hub-previews";
import { prepareThumbnails } from "./thumbnail-cache";
import { thumbnailFiles } from "./gallery-thumbnails";
import { ScrollPosition } from "./KeyboardPane";
import { PhotoViewer } from "./PhotoViewer";

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
      style={[s.photoTile, { width: size, height: size }]}
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
          />
        </View>
      )}
      {selected && (
        <View style={s.photoBadge}>
          <Icon name="check" size={14} color="#fff" />
        </View>
      )}
      {!selected && (item.kind === "video" || !!item.upload) && (
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
    for (const item of mergeTimeline({ entries })) {
      const month = (item.date || "").slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(month) && !months.has(month))
        months.set(month, { month, count: 1 });
    }
    return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  }, [index?.timeline, entries]);
  useEffect(() => {
    onDates?.(dates);
  }, [dates, onDates]);
  useEffect(() => {
    if (!seekRef) return;
    let active = true;
    seekRef.current = async (month) => {
      setSelectedMonth(month);
      setLimit(PAGE);
      monthPositions.current.clear();
      positionRef.current?.measure(rootRef.current, ({ top }) => {
        rootTop.current = top;
        positionRef.current.scrollTo(top);
      });
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
    scrollRef.current = (y) => {
      const month = [...monthPositions.current]
        .sort((a, b) => a[1] - b[1])
        .filter(([, top]) => top <= y - rootTop.current + 80)
        .at(-1)?.[0];
      railRef?.current?.show(month || selectedMonth || dates[0]?.month);
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
    if (!loading && !pageError && limit >= (index?.items.length || 0))
      void more();
  }, [limit, index?.next, connected, loading]);
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
  }, [shown, loading, store, scope, volume, io]);
  const gap = 4;
  const tile = width ? Math.floor((width - gap * (columns - 1)) / columns) : 0;
  const pendingItems = useMemo(
    () => items.filter((item) => item.upload),
    [items],
  );
  const groups = useMemo(
    () => groupByMonth(shown.filter((item) => !item.upload)),
    [shown],
  );
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
      style={[s.timeline, dates.length > 1 && s.timelineWithRail]}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
        position?.measure(rootRef.current, ({ top }) => {
          rootTop.current = top;
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
              {Math.max(pendingItems.length, uploads?.summary?.pending || 0)}{" "}
              remaining
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
      {!!tile &&
        groups.map((group) => (
          <View
            key={group.month}
            style={s.timelineGroup}
            onLayout={(event) =>
              monthPositions.current.set(
                group.month,
                event.nativeEvent.layout.y,
              )
            }
          >
            <Text style={s.timelineMonth}>{group.label}</Text>
            <View style={[s.photoGrid, { gap }]}>
              {group.items.map((item) => (
                <Tile
                  key={item.path}
                  item={item}
                  size={tile}
                  uri={thumb(item)}
                  selected={selection.some((photo) => photo.path === item.path)}
                  onLongPress={
                    remove && Number.isSafeInteger(item.rev)
                      ? () => toggle(item)
                      : undefined
                  }
                  onPress={() =>
                    selection.length
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
      {!items.length &&
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
      {(items.length > limit || (connected && index?.next)) && (
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
