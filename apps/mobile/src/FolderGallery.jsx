import React, { useEffect, useState } from "react";
import { Image, Modal, Pressable, Text, View } from "react-native";
import { reconcileLocalGallery, isGalleryVideo } from "./local-gallery";
import { prepareThumbnails } from "./thumbnail-cache";
import { thumbnailFiles } from "./gallery-thumbnails";
import { Button, Icon, useDesign } from "./components";

function GalleryThumbnail({ item, uri, styles }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri, item.mtime, item.size]);
  return (
    <Image
      source={{ uri: failed ? item.uri : uri || item.uri }}
      style={styles.galleryImage}
      resizeMode="cover"
      accessibilityLabel={item.path}
      onError={() => setFailed(true)}
    />
  );
}

// Use the synchronized working copies, without Photos permissions or hub reads.
export function FolderGallery({
  entries,
  open,
  store,
  scope,
  volume,
  loading,
}) {
  const { s } = useDesign();
  const [photos, setPhotos] = useState(() =>
    reconcileLocalGallery([], entries),
  );
  useEffect(() => {
    setPhotos((previous) => reconcileLocalGallery(previous, entries));
  }, [entries]);
  const [thumbnails, setThumbnails] = useState({});
  useEffect(() => {
    let active = true;
    const key = `gallery-thumbnails:${scope}:${volume}`;
    (async () => {
      const cached = await store.get(key, {});
      if (!active) return;
      setThumbnails(cached);
      if (loading) return;
      const next = await prepareThumbnails(
        entries.slice(0, 2000),
        cached,
        thumbnailFiles,
        () => active,
        (value) => {
          if (active) setThumbnails(value);
        },
      );
      if (active && next) await store.set(key, next);
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [entries, loading, store, scope, volume]);
  const [limit, setLimit] = useState(60);
  const [selected, select] = useState(null);
  const [failed, setFailed] = useState(false);
  const index = photos.findIndex((item) => item.path === selected);
  const active = photos[index];
  useEffect(() => {
    setFailed(false);
  }, [selected]);
  const video = isGalleryVideo;
  return (
    <View>
      {!photos.length && (
        <Text style={s.text}>
          Photos will appear here as they finish downloading.
        </Text>
      )}
      <View style={s.galleryGrid}>
        {photos.slice(0, limit).map((item) => (
          <Pressable
            key={item.path}
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.path}`}
            style={s.galleryTile}
            onPress={() => (video(item) ? open(item) : select(item.path))}
          >
            {video(item) ? (
              <View style={s.galleryPlaceholder}>
                <Icon name="video" />
              </View>
            ) : (
              <GalleryThumbnail
                item={item}
                styles={s}
                uri={
                  thumbnails[item.path]?.signature ===
                  `${item.size}:${item.mtime}`
                    ? thumbnails[item.path].uri
                    : item.uri
                }
              />
            )}
          </Pressable>
        ))}
      </View>
      {photos.length > limit && (
        <Button label="Load more" onPress={() => setLimit(limit + 60)} />
      )}
      <Modal
        visible={!!active}
        onRequestClose={() => select(null)}
        animationType="fade"
      >
        <View style={s.localGalleryViewer}>
          <View style={s.row}>
            <Button label="Close" onPress={() => select(null)} />
            <Button
              label="Open file"
              onPress={() => {
                select(null);
                open(active);
              }}
            />
          </View>
          {active &&
            (failed || video(active) ? (
              <Text style={s.text}>
                Preview unavailable. Open the original file to view it.
              </Text>
            ) : (
              <Image
                key={active.path}
                source={{ uri: active.uri }}
                resizeMode="contain"
                style={s.localGalleryPhoto}
                onError={() => setFailed(true)}
              />
            ))}
          <View style={s.row}>
            <Button
              label="Previous"
              disabled={index <= 0}
              onPress={() => select(photos[index - 1].path)}
            />
            <Button
              label="Next"
              disabled={index < 0 || index >= photos.length - 1}
              onPress={() => select(photos[index + 1].path)}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
