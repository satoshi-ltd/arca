import React, { useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import {
  ActionRow,
  Button,
  EmptyState,
  Field,
  Icon,
  OfflineEmpty,
  Scaffold,
  Section,
  SegmentedControl,
  useDesign,
} from "./components";
import {
  albumRows,
  albumSummary,
  artistGroups,
  baseContext,
  formatDuration,
  folderContext,
  LIBRARY_CONTEXT,
  libraryTracks,
  musicTabs,
  nextRepeat,
  parseTrackNode,
  playlistRows,
  playlistSummary,
  plural,
  recentPlayed,
  searchLibrary,
} from "./music-library.js";
import { useMusicPlayer } from "./music-player";

const PAGE = 120;

export function Cover({ uri, size, icon = "album" }) {
  const { s, c } = useDesign();
  const [failed, setFailed] = useState(null);
  const shown = uri && failed !== uri;
  return (
    <View
      style={[
        s.musicCover,
        size ? { width: size, height: size } : s.musicCoverFill,
      ]}
    >
      {shown ? (
        <Image
          source={{ uri }}
          style={s.galleryImage}
          onError={() => setFailed(uri)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Icon name={icon} size={size && size < 64 ? 18 : 28} color={c.mute} />
      )}
    </View>
  );
}

function MusicRow({
  title,
  caption,
  cover,
  icon,
  onPress,
  divider,
  chevron = true,
}) {
  const { s, c } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={caption ? `${title}, ${caption}` : title}
      onPress={onPress}
      style={({ pressed }) => [
        s.folderRow,
        s.groupedFolderRow,
        divider && s.separator,
        pressed && s.pressed,
      ]}
    >
      {cover !== undefined ? (
        <Cover uri={cover} size={44} icon={icon} />
      ) : (
        <View style={s.tile}>
          <Icon name={icon} size={16} color={c.accent} />
        </View>
      )}
      <View style={[s.flex, s.stack]}>
        <Text numberOfLines={1} style={s.rowTitle}>
          {title}
        </Text>
        {!!caption && (
          <Text numberOfLines={1} style={s.caption}>
            {caption}
          </Text>
        )}
      </View>
      {chevron && <Icon name="chevron" color={c.mute} />}
    </Pressable>
  );
}

function AlbumGrid({ albums, cover, open }) {
  const { s } = useDesign();
  const [shown, setShown] = useState(60);
  return (
    <>
      <View style={s.musicGrid}>
        {albums.slice(0, shown).map((album) => (
          <Pressable
            key={album.id}
            accessibilityRole="button"
            accessibilityLabel={`${album.title}, ${album.artist}`}
            onPress={() => open(album)}
            style={({ pressed }) => [s.musicAlbum, pressed && s.musicPressed]}
          >
            <Cover uri={cover(album.cover, "small")} />
            <Text numberOfLines={2} style={s.rowTitle}>
              {album.title}
            </Text>
            <Text numberOfLines={1} style={s.caption}>
              {album.artist}
            </Text>
          </Pressable>
        ))}
      </View>
      {albums.length > shown && (
        <Button label="Show more albums" onPress={() => setShown(shown + 60)} />
      )}
    </>
  );
}

const NOTES = { pending: "Downloading", missing: "Not in this folder" };

function TrackList({
  rows,
  context,
  contextOf,
  isCurrent,
  play,
  numbered,
  cover,
  canPlay,
  actions,
  removable,
  withAlbum,
}) {
  const { s, c } = useDesign();
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      <View style={s.group}>
        {rows.slice(0, shown).map((row, index) => {
          const key = `${index}:${row.track?.id || row.title}`;
          const style = [s.musicTrack, index > 0 && s.separator];
          if (row.state !== "ready")
            return (
              <View
                key={key}
                accessible
                accessibilityLabel={`${row.title}, ${NOTES[row.state].toLowerCase()}`}
                accessibilityActions={
                  removable ? [{ name: "actions", label: "Track actions" }] : undefined
                }
                onAccessibilityAction={() => removable && actions(row)}
                style={style}
              >
                {numbered ? (
                  <View style={s.musicNumber}>
                    <Text style={[s.mono, s.musicPending]}>{row.number}</Text>
                  </View>
                ) : (
                  <Cover uri={cover(row.track?.cover, "small")} size={40} />
                )}
                <View style={[s.flex, s.stack]}>
                  <Text numberOfLines={1} style={[s.rowTitle, s.musicPending]}>
                    {row.title}
                  </Text>
                  <Text numberOfLines={1} style={[s.caption, s.musicPending]}>
                    {NOTES[row.state]}
                  </Text>
                </View>
                {removable && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Track actions"
                    hitSlop={4}
                    onPress={() => actions(row)}
                    style={({ pressed }) => [s.musicRowAction, pressed && s.musicPressed]}
                  >
                    <Icon name="more" size={20} color={c.mute} />
                  </Pressable>
                )}
              </View>
            );
          const { track } = row;
          const current = isCurrent(row);
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`${canPlay ? "Play" : "Open"} ${track.title}, ${track.artist}`}
              accessibilityActions={
                actions ? [{ name: "actions", label: "Track actions" }] : undefined
              }
              onAccessibilityAction={() => actions?.(row)}
              onPress={() =>
                play(contextOf ? contextOf(track) : context, track, false, row.position)
              }
              style={({ pressed }) => [...style, pressed && s.pressed]}
            >
              {numbered ? (
                <View style={s.musicNumber}>
                  {current ? (
                    <Icon name="music" size={16} color={c.accent} />
                  ) : (
                    <Text style={s.mono}>{row.number}</Text>
                  )}
                </View>
              ) : (
                <Cover uri={cover(track.cover, "small")} size={40} />
              )}
              <View style={[s.flex, s.stack]}>
                <Text
                  numberOfLines={1}
                  style={[s.rowTitle, current && s.active]}
                >
                  {track.title}
                </Text>
                <Text numberOfLines={1} style={s.caption}>
                  {numbered && !withAlbum ? track.artist : `${track.artist} · ${track.album}`}
                </Text>
              </View>
              {!!track.duration && (
                <Text style={s.caption}>{formatDuration(track.duration)}</Text>
              )}
              {actions && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Track actions"
                  hitSlop={4}
                  onPress={() => actions(row)}
                  style={({ pressed }) => [s.musicRowAction, pressed && s.musicPressed]}
                >
                  <Icon name="more" size={20} color={c.mute} />
                </Pressable>
              )}
            </Pressable>
          );
        })}
      </View>
      {rows.length > shown && (
        <Button
          label="Show more tracks"
          onPress={() => setShown(shown + PAGE)}
        />
      )}
    </>
  );
}

const readyRows = (library, ids) =>
  ids
    .map((id) => library.tracks.get(id))
    .filter(Boolean)
    .map((track, index) => ({
      track,
      title: track.title,
      state: "ready",
      position: null,
      number: track.track ?? index + 1,
    }));

function Collection({
  title,
  subtitle,
  coverUri,
  icon,
  rows,
  tracks,
  library,
  context,
  canPlay,
  play,
  isCurrent,
  cover,
  actions,
  removable,
  withAlbum,
}) {
  const { s, wide } = useDesign();
  const first = library.tracks.get(tracks[0]);
  const shuffle = () => {
    const index = Math.floor(Math.random() * tracks.length);
    play(context, library.tracks.get(tracks[index]), true, index);
  };
  return (
    <>
      <View style={[s.musicHeader, wide && s.musicHeaderWide]}>
        <Cover uri={coverUri} size={wide ? 160 : 128} icon={icon} />
        <View style={[s.flex, s.stack]}>
          <Text accessibilityRole="header" style={s.title}>
            {title}
          </Text>
          {!!subtitle && <Text style={s.text}>{subtitle}</Text>}
          {canPlay && first && (
            <View style={s.musicActions}>
              <Button
                primary
                label="Play"
                icon="play"
                onPress={() => play(context, first, false, 0)}
              />
              {tracks.length > 1 && (
                <Button label="Shuffle" icon="shuffle" onPress={shuffle} />
              )}
            </View>
          )}
        </View>
      </View>
      {!canPlay && (
        <Text style={s.caption}>
          Playback on this iPhone comes in a later version. Open a track to play
          it in another app.
        </Text>
      )}
      <TrackList
        rows={rows}
        context={context}
        isCurrent={isCurrent}
        play={play}
        numbered
        cover={cover}
        canPlay={canPlay}
        actions={actions}
        removable={removable}
        withAlbum={withAlbum}
      />
    </>
  );
}

function PagedRows({ items, render }) {
  const { s } = useDesign();
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      <View style={s.group}>
        {items.slice(0, shown).map((item, index) => render(item, index))}
      </View>
      {items.length > shown && (
        <Button label="Show more" onPress={() => setShown(shown + PAGE)} />
      )}
    </>
  );
}

function ArtistIndex({ artists, render }) {
  const { s } = useDesign();
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      {artistGroups(artists.slice(0, shown)).map((group) => (
        <Section key={group.letter}>
          <Text style={s.eyebrow}>{group.letter}</Text>
          <View style={s.group}>
            {group.artists.map((artist, index) => render(artist, index))}
          </View>
        </Section>
      ))}
      {artists.length > shown && (
        <Button label="Show more" onPress={() => setShown(shown + PAGE)} />
      )}
    </>
  );
}

const TAB_LABELS = {
  artists: "Artists",
  albums: "Albums",
  playlists: "Playlists",
  recent: "Recent",
  artist: "Artist",
};

export function MusicLibrary({
  library,
  saved,
  indexing,
  offline,
  route,
  push,
  pop,
  select,
  history,
  search,
  setSearch,
  folderId,
  cover,
  canPlay,
  play,
  playingId,
  sync,
  reconnect,
  trackActions,
  playlistActions,
}) {
  const { s } = useDesign();
  const searching = typeof search === "string";
  const query = search || "";
  const found = useMemo(
    () => (library && searching ? searchLibrary(library, query) : null),
    [library, searching, query],
  );
  const node = parseTrackNode(playingId);
  const playing = node?.track || null;
  if (!library) return <Scaffold label="Loading music" />;
  if (!saved)
    return offline ? (
      <OfflineEmpty
        icon="music"
        title="You are offline"
        text="Connect to the hub to load this music library."
        retry={reconnect}
      />
    ) : (
      <EmptyState
        icon="music"
        title="Loading the library"
        text="The hub lists this folder's artists and albums after the next sync."
        action={<Button label="Sync now" icon="refresh" onPress={sync} />}
      />
    );
  if (!library.tracks.size)
    return (
      <EmptyState
        icon="music"
        title="No music on this phone yet"
        text={
          indexing
            ? "The hub is reading this folder's tags. Tracks appear here as they sync."
            : "Tracks appear here as this folder finishes syncing."
        }
      />
    );
  const tabs = musicTabs(library);
  const tab = tabs.includes(route[0]?.kind) ? route[0].kind : "artists";
  const results = found;
  const top =
    route.length > 1 ? route.at(-1) : { kind: results ? "search" : tab };
  const shuffle = (context, ids) => {
    const index = Math.floor(Math.random() * ids.length);
    play(folderContext(folderId, context), library.tracks.get(ids[index]), true, index);
  };
  const shownPlaylist =
    top.kind === "playlist" ? library.playlists.get(top.id) : null;
  const everything = libraryTracks(library);
  const back =
    route.length > 1 ? (
      <View style={s.musicBack}>
        <Button
          quiet
          icon="back"
          label={
            route.length === 2
              ? results
                ? "Search"
                : TAB_LABELS[tab]
              : route.at(-2).kind === "artist"
                ? library.artists.find((item) => item.id === route.at(-2).id)
                    ?.name || TAB_LABELS.artist
                : TAB_LABELS[route.at(-2).kind]
          }
          onPress={pop}
        />
        {shownPlaylist?.editable && (
          <Button
            iconOnly
            quiet
            label="Playlist actions"
            icon="more"
            onPress={() => playlistActions(shownPlaylist)}
          />
        )}
      </View>
    ) : (
      <>
        <View style={s.folderToolbar}>
          <View style={s.flex}>
            <SegmentedControl
              options={tabs.map((value) => ({ value, label: TAB_LABELS[value] }))}
              value={tab}
              onChange={(kind) => {
                setSearch(null);
                select(kind);
              }}
            />
          </View>
          <Button
            iconOnly
            label={searching ? "Close search" : "Search music"}
            icon={searching ? "close" : "search"}
            onPress={() => setSearch(searching ? null : "")}
          />
        </View>
        {searching && (
          <Field
            label="Search music"
            autoFocus={!query}
            placeholder="Songs, albums or artists"
            returnKeyType="search"
            value={query}
            onChangeText={setSearch}
          />
        )}
        {canPlay && !results && everything.length > 1 && (
          <View style={s.musicActions}>
            <Button
              label="Shuffle"
              icon="shuffle"
              onPress={() => shuffle(LIBRARY_CONTEXT, everything)}
            />
          </View>
        )}
        {indexing && (
          <Text style={s.caption}>
            The hub is still reading tags. The library fills in as it goes.
          </Text>
        )}
      </>
    );
  const openAlbum = (album) => push({ kind: "album", id: album.id });
  const openPlaylist = (playlist) => push({ kind: "playlist", id: playlist.id });
  const playlistRow = (playlist, index, caption = playlistSummary(playlist)) => (
    <MusicRow
      key={playlist.id}
      divider={index > 0}
      icon="playlist"
      cover={cover(playlist.cover, "small")}
      title={playlist.name}
      caption={caption}
      onPress={() => openPlaylist(playlist)}
    />
  );
  const playingRow = (row) => row.track?.id === playing;
  const albumsOf = (ids) =>
    ids.map((id) => library.albums.get(id)).filter(Boolean);
  let body = null;
  if (top.kind === "search") {
    const found =
      results.tracks.length +
      results.albums.length +
      results.artists.length +
      results.playlists.length;
    body = found ? (
      <>
        {results.tracks.length > 0 && (
          <Section>
            <Text style={s.eyebrow}>SONGS</Text>
            <TrackList
              rows={readyRows(library, results.tracks)}
              contextOf={(track) => folderContext(folderId, track.albumId)}
              isCurrent={playingRow}
              play={play}
              cover={cover}
              canPlay={canPlay}
            />
          </Section>
        )}
        {results.albums.length > 0 && (
          <Section>
            <Text style={s.eyebrow}>ALBUMS</Text>
            <AlbumGrid albums={results.albums} cover={cover} open={openAlbum} />
          </Section>
        )}
        {results.artists.length > 0 && (
          <Section>
            <Text style={s.eyebrow}>ARTISTS</Text>
            <PagedRows
              items={results.artists}
              render={(artist, index) => (
                <MusicRow
                  key={artist.id}
                  divider={index > 0}
                  icon="artist"
                  cover={cover(artist.cover, "small")}
                  title={artist.name}
                  caption={plural(artist.albums.length, "album", "albums")}
                  onPress={() => push({ kind: "artist", id: artist.id })}
                />
              )}
            />
          </Section>
        )}
        {results.playlists.length > 0 && (
          <Section>
            <Text style={s.eyebrow}>PLAYLISTS</Text>
            <PagedRows
              items={results.playlists}
              render={(playlist, index) => playlistRow(playlist, index)}
            />
          </Section>
        )}
      </>
    ) : (
      <EmptyState
        icon="search"
        title={`No results for “${query.trim()}”`}
        text="Try the name of a song, album, artist or playlist."
      />
    );
  } else if (top.kind === "artists")
    body = (
      <ArtistIndex
        artists={library.artists}
        render={(artist, index) => (
          <MusicRow
            key={artist.id}
            divider={index > 0}
            icon="artist"
            cover={cover(artist.cover, "small")}
            title={artist.name}
            caption={`${plural(artist.albums.length, "album", "albums")} · ${plural(artist.tracks, "track", "tracks")}`}
            onPress={() => push({ kind: "artist", id: artist.id })}
          />
        )}
      />
    );
  else if (top.kind === "artist") {
    const artist = library.artists.find((item) => item.id === top.id);
    const ids = artist ? libraryTracks(library, artist.albums) : [];
    body = artist ? (
      <Section>
        <View style={s.musicHeader}>
          <Cover uri={cover(artist.cover, "small")} size={72} icon="artist" />
          <View style={[s.flex, s.stack]}>
            <Text accessibilityRole="header" style={s.title}>
              {artist.name}
            </Text>
            <Text style={s.caption}>
              {`${plural(artist.albums.length, "album", "albums")} · ${plural(ids.length, "track", "tracks")}`}
            </Text>
          </View>
        </View>
        {canPlay && ids.length > 1 && (
          <View style={s.musicActions}>
            <Button
              label="Shuffle"
              icon="shuffle"
              onPress={() => shuffle(artist.id, ids)}
            />
          </View>
        )}
        <AlbumGrid
          albums={albumsOf(artist.albums)}
          cover={cover}
          open={openAlbum}
        />
      </Section>
    ) : null;
  } else if (top.kind === "albums")
    body = (
      <AlbumGrid
        albums={albumsOf(library.albumOrder)}
        cover={cover}
        open={openAlbum}
      />
    );
  else if (top.kind === "playlists")
    body = (
      <PagedRows
        items={library.playlistOrder.map((id) => library.playlists.get(id))}
        render={(playlist, index) => playlistRow(playlist, index)}
      />
    );
  else if (top.kind === "recent") {
    const played = recentPlayed(library, history || []);
    body = played.length ? (
      <Section>
        <Text style={s.eyebrow}>RECENTLY PLAYED</Text>
        <View style={s.group}>
          {played.map((item, index) =>
            library.playlists.has(item.id) ? (
              playlistRow(item, index, plural(item.tracks.length, "track", "tracks"))
            ) : (
              <MusicRow
                key={item.id}
                divider={index > 0}
                icon="album"
                cover={cover(item.cover, "small")}
                title={item.title}
                caption={item.artist}
                onPress={() => openAlbum(item)}
              />
            ),
          )}
        </View>
      </Section>
    ) : (
      <Section>
        <Text style={s.eyebrow}>RECENTLY ADDED</Text>
        <Text style={s.caption}>
          Nothing from this folder has played on this phone yet. These albums
          were added most recently.
        </Text>
        <AlbumGrid
          albums={albumsOf(library.recent)}
          cover={cover}
          open={openAlbum}
        />
      </Section>
    );
  } else if (top.kind === "album") {
    const album = library.albums.get(top.id);
    body = album ? (
      <Collection
        title={album.title}
        subtitle={albumSummary(album)}
        coverUri={cover(album.cover, "large")}
        rows={albumRows(library, album)}
        tracks={album.tracks}
        library={library}
        context={folderContext(folderId, album.id)}
        canPlay={canPlay}
        play={play}
        isCurrent={playingRow}
        cover={cover}
        actions={(row) => trackActions({ track: row.track })}
      />
    ) : null;
  } else if (shownPlaylist)
    body = (
      <Collection
        title={shownPlaylist.name}
        subtitle={playlistSummary(shownPlaylist)}
        coverUri={cover(shownPlaylist.cover, "large")}
        icon="playlist"
        rows={playlistRows(library, shownPlaylist)}
        tracks={shownPlaylist.tracks}
        library={library}
        context={folderContext(folderId, shownPlaylist.id)}
        canPlay={canPlay}
        play={play}
        isCurrent={(row) =>
          playingRow(row) &&
          baseContext(node.context) === shownPlaylist.id &&
          (node.position === null || node.position === row.position)
        }
        cover={cover}
        actions={(row) =>
          trackActions({
            track: row.track,
            title: row.title,
            path: row.path,
            playlist: shownPlaylist,
            entry: row.entry,
          })
        }
        removable={shownPlaylist.editable}
        withAlbum
      />
    );
  return (
    <View style={s.musicPage}>
      {back}
      {body || (
        <EmptyState
          icon="music"
          title="No longer in this library"
          text="It was removed or renamed on the hub."
        />
      )}
    </View>
  );
}

function PlaylistName({ name = "", label, locked, submit }) {
  const { s } = useDesign();
  const [value, setValue] = useState(name);
  const clean = value.trim();
  const ready = !locked && !!clean && clean !== name;
  return (
    <View style={s.group}>
      <Field
        label="Playlist name"
        value={value}
        onChangeText={setValue}
        autoFocus
        autoCapitalize="sentences"
        returnKeyType="done"
        editable={!locked}
        onSubmitEditing={() => ready && submit(clean)}
      />
      <Button label={label} disabled={!ready} onPress={() => submit(clean)} />
    </View>
  );
}

export function MusicSheet({ sheet, library, cover, locked, open, change, remove }) {
  const { s } = useDesign();
  if (sheet.kind === "track-actions")
    return (
      <View style={s.actionGroup}>
        {sheet.track && (
          <ActionRow
            label="Add to playlist…"
            icon="list-plus"
            disabled={locked}
            onPress={() => open({ kind: "add-to-playlist", track: sheet.track })}
          />
        )}
        {sheet.playlist?.editable && (
          <ActionRow
            label="Remove from playlist"
            icon="list-minus"
            disabled={locked}
            onPress={() => change("remove", sheet)}
          />
        )}
      </View>
    );
  if (sheet.kind === "add-to-playlist") {
    const lists = (library?.playlistOrder || [])
      .map((id) => library.playlists.get(id))
      .filter((playlist) => playlist.editable);
    return (
      <View style={s.group}>
        {lists.map((playlist, index) => (
          <MusicRow
            key={playlist.id}
            divider={index > 0}
            chevron={false}
            icon="playlist"
            cover={cover(playlist.cover, "small")}
            title={playlist.name}
            caption={plural(playlist.tracks.length, "track", "tracks")}
            onPress={() => !locked && change("add", { playlist, track: sheet.track })}
          />
        ))}
        <MusicRow
          divider={lists.length > 0}
          chevron={false}
          icon="plus"
          title="New playlist…"
          caption="Saved as a file in Playlists/"
          onPress={() => open({ kind: "new-playlist", track: sheet.track })}
        />
      </View>
    );
  }
  if (sheet.kind === "new-playlist")
    return (
      <PlaylistName
        label="Create"
        locked={locked}
        submit={(name) => change("create", { name, track: sheet.track })}
      />
    );
  if (sheet.kind === "rename-playlist")
    return (
      <PlaylistName
        name={sheet.playlist.name}
        label="Rename"
        locked={locked}
        submit={(name) => change("rename", { name, playlist: sheet.playlist })}
      />
    );
  if (sheet.kind === "playlist-actions")
    return (
      <>
        <View style={s.actionGroup}>
          <ActionRow
            label="Rename…"
            icon="edit"
            disabled={locked}
            onPress={() => open({ kind: "rename-playlist", playlist: sheet.playlist })}
          />
        </View>
        <View style={s.destructiveActionGroup}>
          <ActionRow
            label="Delete playlist…"
            icon="trash"
            danger
            disabled={locked}
            onPress={() => remove(sheet.playlist)}
          />
        </View>
      </>
    );
  return null;
}

const isPlaying = (state) =>
  !!state && (state.playing || (state.playWhenReady && !state.ended && !state.error));
const playingTrack = (library, state) =>
  library?.tracks.get(parseTrackNode(state?.id)?.track);

export function MiniPlayer({ library, cover, open, command }) {
  const { s, c } = useDesign();
  const [state] = useMusicPlayer(true);
  if (!state?.id) return null;
  const track = playingTrack(library, state);
  const playing = isPlaying(state);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Now playing ${track?.title || state.title || ""}`}
      onPress={open}
      style={({ pressed }) => [s.miniPlayer, pressed && s.pressed]}
    >
      <Cover uri={cover(track?.cover, "small")} size={40} />
      <View style={[s.flex, s.stack]}>
        <Text numberOfLines={1} style={s.rowTitle}>
          {track?.title || state.title || "Unknown track"}
        </Text>
        <Text
          numberOfLines={1}
          style={state.error ? [s.caption, s.errorText] : s.caption}
        >
          {state.error ||
            [track?.artist || state.artist, track?.album || state.album]
              .filter(Boolean)
              .join(" · ")}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? "Pause" : "Play"}
        hitSlop={8}
        onPress={() => command("toggle")}
        style={s.miniControl}
      >
        <Icon
          name={playing ? "pause" : "play"}
          size={22}
          color={c.ink}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next track"
        hitSlop={8}
        disabled={!state.hasNext}
        onPress={() => command("next")}
        style={s.miniControl}
      >
        <Icon name="skip-forward" size={22} color={c.ink} />
      </Pressable>
    </Pressable>
  );
}

export function NowPlaying({ library, cover, command, openAlbum }) {
  const { s, c, wide } = useDesign();
  const [width, setWidth] = useState(0);
  const [state] = useMusicPlayer(true);
  if (!state?.id)
    return (
      <EmptyState
        icon="music"
        title="Nothing playing"
        text="Pick a track in a music folder to play it here."
      />
    );
  const track = playingTrack(library, state);
  const playing = isPlaying(state);
  const duration =
    state.duration || (track?.duration ? track.duration * 1000 : 0);
  const position = Math.min(state.position || 0, duration || Infinity);
  const progress = duration ? Math.max(0, Math.min(1, position / duration)) : 0;
  const control = (label, icon, onPress, active = false, primary = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active ? { selected: true } : undefined}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        primary ? s.playButton : s.playerControl,
        pressed && s.musicPressed,
      ]}
    >
      <Icon
        name={icon}
        size={primary ? 28 : 24}
        color={primary ? c.onAccent : active ? c.accent : c.ink}
      />
    </Pressable>
  );
  return (
    <View style={s.nowPlaying}>
      <Cover uri={cover(track?.cover, "large")} size={wide ? 320 : 280} />
      <View style={[s.stack, s.nowPlayingText]}>
        <Text numberOfLines={2} style={[s.title, s.centerText]}>
          {track?.title || state.title || "Unknown track"}
        </Text>
        <Text numberOfLines={1} style={[s.text, s.centerText]}>
          {[track?.artist || state.artist, track?.album || state.album]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {!!state.error && (
          <Text
            accessibilityRole="alert"
            style={[s.caption, s.errorText, s.centerText]}
          >
            {state.error}
          </Text>
        )}
        {!!track && (
          <Button
            quiet
            icon="album"
            label="Go to album"
            onPress={() => openAlbum(track)}
          />
        )}
      </View>
      <View style={s.playerProgressArea}>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel="Position"
          accessibilityValue={{
            min: 0,
            max: Math.round(duration / 1000),
            now: Math.round(position / 1000),
          }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            command(
              "seek",
              Math.max(
                0,
                Math.min(
                  duration,
                  position + (event.nativeEvent.actionName === "increment" ? 15000 : -15000),
                ),
              ),
            )
          }
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          onPress={(event) =>
            duration &&
            width &&
            command("seek", (event.nativeEvent.locationX / width) * duration)
          }
          style={s.playerTrackArea}
        >
          <View style={s.playerTrack}>
            <View style={[s.playerFill, { width: `${progress * 100}%` }]} />
          </View>
        </Pressable>
        <View style={s.playerTimes}>
          <Text style={s.mono}>
            {formatDuration(position / 1000) || "0:00"}
          </Text>
          <Text style={s.mono}>{formatDuration(duration / 1000) || "—"}</Text>
        </View>
      </View>
      <View style={s.playerControls}>
        {control(
          "Shuffle",
          "shuffle",
          () => command("shuffle", state.shuffle ? 0 : 1),
          state.shuffle,
        )}
        {control("Previous track", "skip-back", () => command("previous"))}
        {control(
          playing ? "Pause" : "Play",
          playing ? "pause" : "play",
          () => command("toggle"),
          false,
          true,
        )}
        {control("Next track", "skip-forward", () => command("next"))}
        {control(
          state.repeat === "one"
            ? "Repeat one"
            : state.repeat === "all"
              ? "Repeat all"
              : "Repeat off",
          state.repeat === "one" ? "repeat-one" : "repeat",
          () => command("repeat", nextRepeat(state.repeat)),
          state.repeat !== "off",
        )}
      </View>
    </View>
  );
}
