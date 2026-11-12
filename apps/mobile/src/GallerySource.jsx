import { Scaffold } from "./components";
import React, { useEffect, useRef, useState } from "react";
import { AppState, Image, Linking, Pressable, View } from "react-native";
import { Text } from "./Text";
import {
  Button,
  FolderRow,
  Icon,
  InlineMessage,
  MediaPlaceholder,
  PLACEHOLDER_GLYPH_MIN,
  Section,
  SheetFooter,
  Toggle,
  useDesign,
} from "./components";
import { ErrorNotice } from "./Notice";
import { count } from "./format";
import {
  allPhotosNote,
  gallerySettingsChanged,
  sourceAlbums,
} from "./validation.js";

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
  const { s } = useDesign();
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
        <MediaPlaceholder
          size={PLACEHOLDER_GLYPH_MIN}
          video={item.video}
          label={item.name || "Preview unavailable"}
        />
      )}
    </View>
  );
}

export function GallerySetup({ gallery, source, locked, enable }) {
  const { s } = useDesign();
  const [options, setOptions] = useState(null);
  const [videos, setVideos] = useState(source?.videos || false);
  const [albums, setAlbums] = useState(sourceAlbums(source));
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState([]);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [library, setLibrary] = useState(null);
  const loads = useRef(0);
  async function load(includeVideos = videos, request = true) {
    const id = ++loads.current;
    setLoading(true);
    setError("");
    setDenied(false);
    try {
      const next = await gallery.options(includeVideos, request);
      if (id !== loads.current) return;
      setOptions(next);
      setVideos(includeVideos);
    } catch (error) {
      if (id !== loads.current) return;
      const refused = error.code === "PHOTO_PERMISSION";
      setError(error.message);
      setDenied(refused);
      if (refused) setOptions(null);
    } finally {
      if (id === loads.current) setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [gallery]);
  const reload = useRef(load);
  reload.current = load;
  useEffect(() => {
    if (!options) return;
    let active = true;
    setPreview([]);
    setLibrary(null);
    gallery.media
      .page({ albumId: albums[0]?.id, videos })
      .then(async (page) => {
        if (active && !albums.length)
          setLibrary({ count: page.totalCount ?? null, videos });
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
  }, [gallery, options, albums[0]?.id, videos]);
  const limited = options?.permission.accessPrivileges === "limited";
  useEffect(() => {
    if (!limited) return;
    let timer;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reload.current(undefined, false), 500);
    };
    const app = AppState.addEventListener("change", (state) => state === "active" && refresh());
    const library = gallery.media.changes(refresh);
    return () => {
      clearTimeout(timer);
      app.remove();
      library.remove();
    };
  }, [gallery, limited]);
  const allLabel = limited ? "Allowed photos" : "All photos";
  const libraryCount = library?.videos === videos ? library.count : null;
  const allNote = allPhotosNote({ videos, limited, count: libraryCount });
  const changed = gallerySettingsChanged(
    source,
    albums.map((album) => album.id),
    videos,
  );
  const toggle = (album) =>
    setAlbums((held) =>
      held.some((a) => a.id === album.id)
        ? held.filter((a) => a.id !== album.id)
        : [...held, album],
    );
  const summary = !albums.length
    ? allLabel
    : albums.length === 1
      ? albums[0].title
      : count(albums.length, "album", "albums");
  if (choosing && options)
    return (
      <>
        <View style={s.row}>
          <Button
            label="Back"
            icon="back"
            ghost
            onPress={() => setChoosing(false)}
          />
          <Text style={[s.heading, s.flex]}>Choose albums</Text>
          <Button
            label="Refresh albums"
            icon="refresh"
            iconOnly
            ghost
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
            selected={!albums.length}
            name={allLabel}
            description={allNote}
            disabled={locked || loading}
            onPress={() => setAlbums([])}
          />
          {albums
            .filter((held) => !options.albums.some((a) => a.id === held.id))
            .map((held) => (
              <FolderRow
                key={held.id}
                icon="gallery"
                grouped
                divider
                selectable
                selected
                name={held.title}
                description="Unavailable"
                disabled={locked || loading}
                onPress={() => toggle(held)}
              />
            ))}
          {options.albums.map((a) => (
            <FolderRow
              key={a.id}
              icon="gallery"
              grouped
              divider
              selectable
              selected={albums.some((held) => held.id === a.id)}
              name={a.title}
              description={
                a.assetCount == null
                  ? undefined
                  : `${a.assetCount.toLocaleString("en")} ${a.assetCount === 1 ? "item" : "items"}`
              }
              disabled={locked || loading}
              onPress={() => toggle({ id: a.id, title: a.title })}
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
        Upload new photos automatically and keep the shared folder available
        offline in Arca, including photos from other devices. Originals stay in
        Photos.
      </Text>
      <ErrorNotice error={error} retry={() => load()} />
      {denied && (
        <Button label="Open settings" onPress={() => Linking.openSettings()} />
      )}
      {!options && loading && <Scaffold label="Loading albums" />}
      {options && (
        <>
          {limited && (
            <>
              <InlineMessage tone="warning">
                Limited photo access: only selected photos are accessible.
              </InlineMessage>
              <Button label="Open settings" onPress={() => gallery.media.allowMore().catch(() => {})} />
            </>
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
              name={summary}
              description={
                !albums.length
                  ? allNote
                  : albums.length > 1
                    ? albums.map((a) => a.title).join(", ")
                    : "Album"
              }
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
          <SheetFooter>
            <Button
              primary
              label={source ? "Save changes" : "Enable uploads"}
              disabled={
                locked ||
                loading ||
                !changed ||
                albums.some((a) => !options.albums.some((o) => o.id === a.id))
              }
              onPress={() => enable({ albums, videos }, { count: libraryCount, limited })}
            />
          </SheetFooter>
          <GalleryDetails>
            <Text style={s.caption}>
              Existing and new photos are included. Deleting from Photos keeps
              uploaded files. Originals stay in Photos.
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
