import React, { useEffect, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { MediaPlaceholder, useDesign } from "./components";
import { mergeTimeline } from "./gallery-timeline";

// Bounded samples: opening Years never downloads the complete photo catalog.
export function GalleryYear({
  year,
  api,
  connected,
  store,
  scope,
  volume,
  entries,
  io,
  width,
  onPress,
  onLayout,
}) {
  const { s } = useDesign();
  const local = useMemo(
    () =>
      mergeTimeline({ entries })
        .filter((item) => item.date?.startsWith(year.year))
        .slice(0, 24),
    [entries, year.year],
  );
  const [photos, setPhotos] = useState([]);
  useEffect(() => {
    let active = true;
    const key = `gallery-year:${scope}:${volume}:${year.year}`;
    (async () => {
      const saved = await store.get(key, []);
      if (!active) return;
      setPhotos(saved);
      let samples = local;
      if (!samples.length && connected) {
        try {
          const page = await api(
            `/v1/gallery?${new URLSearchParams({ volume, month: year.month })}`,
          );
          samples = mergeTimeline({ index: page.items })
            .filter((item) => item.date?.startsWith(year.year))
            .slice(0, 24);
        } catch {
          /* Cached previews remain available offline. */
        }
      }
      const next = [];
      for (const item of samples) {
        if (!active) return;
        try {
          next.push({ path: item.path, uri: await io.render(item) });
        } catch {
          next.push({ path: item.path, uri: null });
        }
      }
      if (active && next.length) {
        setPhotos(next);
        await store.set(key, next);
      }
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [
    api,
    connected,
    store,
    scope,
    volume,
    year.month,
    year.year,
    year.count,
    local,
    io,
  ]);
  const size = Math.max(1, Math.floor((width - 14) / 8));
  return (
    <Pressable
      style={s.timelineGroup}
      onPress={onPress}
      onLayout={onLayout}
      accessibilityRole="button"
      accessibilityLabel={`${year.year}, ${year.count} photos. Open year`}
    >
      <View style={s.timelineStatus}>
        <Text style={[s.timelineMonth, s.flex]}>{year.year}</Text>
        <Text style={s.caption}>{year.count.toLocaleString("en")} photos</Text>
      </View>
      <View style={s.yearMosaic} pointerEvents="none">
        {Array.from({ length: Math.min(24, year.count) }, (_, index) => {
          const photo = photos[index];
          return (
            <View
              key={index}
              style={[s.yearTile, { width: size, height: size }]}
            >
              {photo?.uri ? (
                <Image
                  source={{ uri: photo.uri }}
                  style={s.galleryImage}
                  resizeMode="cover"
                  onError={() =>
                    setPhotos((current) =>
                      current.map((item, i) =>
                        i === index ? { ...item, uri: null } : item,
                      ),
                    )
                  }
                />
              ) : (
                <MediaPlaceholder size={size} />
              )}
            </View>
          );
        })}
      </View>
    </Pressable>
  );
}
