import { Scaffold } from "./components";
import React, { useEffect, useState } from "react";
import { Image, Linking, Pressable, Text, View } from "react-native";
import {
  Button,
  Card,
  FolderRow,
  Icon,
  Section,
  Toggle,
  useDesign,
} from "./components";
import { ErrorNotice } from "./Notice";

function GalleryDetails({ children }) {
  const { s } = useDesign();
  const [expanded, setExpanded] = useState(false);
  return (
    <Section>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={s.settingRow}
      >
        <View style={s.row}>
          <Text style={[s.heading, s.flex]}>How it works</Text>
          <Icon name={expanded ? "chevron-down" : "chevron"} />
        </View>
      </Pressable>
      {expanded && children}
    </Section>
  );
}

function PhotoTile({ item }) {
  const { s, c } = useDesign();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.uri]);
  return (
    <View
      style={s.galleryTile}
      accessible
      accessibilityLabel={item.name || "Photo"}
    >
      {item.uri && !item.video && !failed ? (
        <Image
          source={{ uri: item.uri }}
          style={s.galleryImage}
          resizeMode="cover"
          resizeMethod="resize"
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={s.galleryPlaceholder}>
          <Icon name={item.video ? "file" : "image"} size={28} color={c.mute} />
          <Text numberOfLines={1} style={s.caption}>
            {item.name || "Preview unavailable"}
          </Text>
        </View>
      )}
    </View>
  );
}

export function GallerySetup({ gallery, source, locked, enable }) {
  const { s } = useDesign();
  const [options, setOptions] = useState(null);
  const [videos, setVideos] = useState(source?.videos || false);
  const [album, setAlbum] = useState(
    source?.albumId ? { id: source.albumId, title: source.albumName } : null,
  );
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState([]);
  const [error, setError] = useState("");
  async function load(includeVideos = videos) {
    setLoading(true);
    setError("");
    try {
      setOptions(await gallery.options(includeVideos));
      setVideos(includeVideos);
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [gallery]);
  useEffect(() => {
    if (!options) return;
    let active = true;
    setPreview([]);
    gallery.media
      .page({ albumId: album?.id, videos })
      .then(async (page) => {
        const items = await Promise.all(
          page.assets.slice(0, 4).map(async (item) => {
            try {
              return {
                ...item,
                name: item.filename,
                ...(await gallery.media.preview(item.id)),
              };
            } catch {
              return { ...item, name: item.filename };
            }
          }),
        );
        if (active) setPreview(items);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [gallery, options, album?.id, videos]);
  const allLabel =
    options?.permission.accessPrivileges === "limited"
      ? "Allowed photos"
      : "All photos";
  const changed =
    !source ||
    (source.albumId || null) !== (album?.id || null) ||
    !!source.videos !== videos;
  if (choosing && options)
    return (
      <>
        <View style={s.row}>
          <Button
            label="Back"
            icon="back"
            quiet
            onPress={() => setChoosing(false)}
          />
          <Text style={[s.heading, s.flex]}>Choose album</Text>
          <Button
            label="Refresh albums"
            icon="refresh"
            iconOnly
            quiet
            busy={loading}
            disabled={locked}
            onPress={() => load()}
          />
        </View>
        <ErrorNotice error={error} retry={() => load()} />
        <View style={s.group}>
          <FolderRow
            icon="gallery"
            grouped
            selectable
            selected={!album}
            name={allLabel}
            disabled={locked || loading}
            onPress={() => {
              setAlbum(null);
              setChoosing(false);
            }}
          />
          {options.albums.map((a) => (
            <FolderRow
              key={a.id}
              icon="gallery"
              grouped
              divider
              selectable
              selected={album?.id === a.id}
              name={a.title}
              description={
                a.assetCount == null ? undefined : `${a.assetCount} items`
              }
              disabled={locked || loading}
              onPress={() => {
                setAlbum(a);
                setChoosing(false);
              }}
            />
          ))}
        </View>
        {!options.albums.length && (
          <Text style={s.caption}>No albums are available on this phone.</Text>
        )}
      </>
    );
  return (
    <>
      <Text style={s.text}>
        Upload new photos automatically. Originals stay on your phone.
      </Text>
      <ErrorNotice error={error} retry={() => load()} />
      {!!error && (
        <Button label="Open settings" onPress={() => Linking.openSettings()} />
      )}
      {!options && loading && <Scaffold label="Loading albums" />}
      {options && (
        <>
          {options.permission.accessPrivileges === "limited" && (
            <Card title="Limited photo access">
              <Text style={s.text}>
                Only selected photos are accessible. Allow more in system
                settings.
              </Text>
            </Card>
          )}
          {!!preview.length && (
            <View style={s.galleryGrid}>
              {preview.map((item) => (
                <PhotoTile key={item.id} item={item} />
              ))}
            </View>
          )}
          <View style={s.group}>
            <FolderRow
              icon="gallery"
              grouped
              name={album?.title || allLabel}
              description="Album"
              disabled={locked || loading}
              onPress={() => setChoosing(true)}
            />
            <View style={[s.settingRow, s.separator]}>
              <Toggle
                label="Include videos"
                value={videos}
                disabled={locked || loading}
                onChange={load}
              />
            </View>
          </View>
          <Text style={s.caption}>
            Uses your current network, including mobile data.
          </Text>
          <Button
            primary
            label={source ? "Save changes" : "Enable uploads"}
            disabled={
              locked ||
              loading ||
              !changed ||
              (!!album && !options.albums.some((a) => a.id === album.id))
            }
            onPress={() =>
              enable({
                albumId: album?.id || null,
                albumName: album?.title || "All accessible photos",
                videos,
              })
            }
          />
          <GalleryDetails>
            <Text style={s.caption}>
              Existing and new photos are included. Deleting from Photos keeps
              uploaded files. Hub changes never change your gallery.
            </Text>
            <Text style={s.caption}>
              Photo edits are uploaded as new versions. Album organization is
              not copied. Live Photos include their paired video.
            </Text>
            <Text style={s.caption}>
              Cloud originals may need downloading. Transfers use temporary
              space. The system may restrict metadata, including location.
            </Text>
          </GalleryDetails>
        </>
      )}
    </>
  );
}
