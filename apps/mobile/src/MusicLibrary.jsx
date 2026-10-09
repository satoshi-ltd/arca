import React, { useMemo, useRef, useState } from "react";
import { putFlight } from "./flight.js";
import { Animated, Image, Pressable, Text, View } from "react-native";
import {
  ActionRow,
  Button,
  EmptyState,
  Field,
  Icon,
  OfflineEmpty,
  pressScale,
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
  formatDay,
  formatDuration,
  formatLength,
  folderContext,
  LIBRARY_CONTEXT,
  libraryTracks,
  episodeRows,
  musicPane,
  musicSearchLabel,
  musicTabs,
  parseTrackNode,
  playlistRows,
  playlistSummary,
  plural,
  recentPlayed,
  searchLibrary,
  showCaption,
  showRows,
  showSummary,
  TAB_LABELS,
  trackContext,
} from "./music-library.js";
import { useMusicPlayer } from "./music-player";
import { ChangeFade, RiseOnce, useFlight, useMotion } from "./motion";
import { motion } from "./design-tokens.js";
import { fraction, resumeCandidate, savedPosition, timeLeft } from "./audio-positions.js";
import { sleepLabel } from "./sleep-timer.js";
import { useNow } from "./audio-session.js";

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
  flight = false,
  selected = false,
}) {
  const { s, c, wide } = useDesign();
  const { reduce } = useMotion();
  const art = useRef(null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={caption ? `${title}, ${caption}` : title}
      accessibilityState={selected ? { selected } : undefined}
      onPress={() =>
        flight && wide && art.current?.measureInWindow
          ? art.current.measureInWindow((x, y, width, height) => {
              putFlight("collection", { x, y, width, height });
              onPress();
            })
          : onPress()
      }
      style={({ pressed }) => [
        s.folderRow,
        s.groupedFolderRow,
        divider && s.separator,
        selected && s.musicSelected,
        pressed && s.pressed,
        pressScale(pressed, reduce),
      ]}
    >
      {cover !== undefined ? (
        <View ref={art}>
          <Cover uri={cover} size={40} icon={icon} />
        </View>
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

function AlbumTile({ album, cover, open }) {
  const { s, wide } = useDesign();
  const art = useRef(null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${album.title}, ${album.artist}`}
      onPress={() =>
        wide && art.current?.measureInWindow
          ? art.current.measureInWindow((x, y, width, height) => {
              putFlight("collection", { x, y, width, height });
              open(album);
            })
          : open(album)
      }
      style={({ pressed }) => [s.musicAlbum, pressed && s.musicTilePressed]}
    >
      <View ref={art}>
        <Cover uri={cover(album.cover, "small")} />
      </View>
      <Text numberOfLines={2} style={s.rowTitle}>
        {album.title}
      </Text>
      <Text numberOfLines={1} style={s.caption}>
        {album.artist}
      </Text>
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
          <AlbumTile key={album.id} album={album} cover={cover} open={open} />
        ))}
      </View>
      {albums.length > shown && (
        <Button label="Show more albums" onPress={() => setShown(shown + 60)} />
      )}
    </>
  );
}

const notes = (offline) => ({
  pending: offline ? "Not on this phone yet" : "Downloading",
  missing: "Not in this folder",
});

const isPlaying = (state) =>
  !!state && (state.playing || (state.playWhenReady && !state.ended && !state.error));

export function NowGlyph({ size = 16 }) {
  const { s, c } = useDesign();
  const [state] = useMusicPlayer(true);
  const playing = isPlaying(state);
  return (
    <ChangeFade token={playing ? "playing" : "paused"} ms={motion.fast} style={s.musicGlyph}>
      <Icon name={playing ? "audio-lines" : "music"} size={size} color={c.accent} />
    </ChangeFade>
  );
}

export function ProgressLine({ value }) {
  const { s } = useDesign();
  return (
    <View style={s.progressLine}>
      <View style={[s.progressFill, { width: `${Math.round(value * 100)}%` }]} />
    </View>
  );
}

function LiveMeta({ track, caption, style }) {
  const [state] = useMusicPlayer(true);
  const total = state?.duration || (track.duration || 0) * 1000;
  const at = Math.min(state?.position || 0, total || 0);
  const left = total ? timeLeft((total - at) / 1000) : "";
  return (
    <>
      <Text numberOfLines={1} style={style}>
        {[caption, left].filter(Boolean).join(" · ")}
      </Text>
      {total > 0 && <ProgressLine value={fraction(at, total)} />}
    </>
  );
}

export function RowMeta({ track, caption, saved, live, style }) {
  if (live) return <LiveMeta track={track} caption={caption} style={style} />;
  return (
    <>
      <Text numberOfLines={1} style={style}>
        {saved ? [caption, timeLeft(saved.duration - saved.position)].filter(Boolean).join(" · ") : caption}
      </Text>
      {!!saved && <ProgressLine value={fraction(saved.position, saved.duration)} />}
    </>
  );
}

const trackCaption = (track, numbered, withAlbum) =>
  track.podcast
    ? withAlbum
      ? [track.artist, formatDay(track.date)].filter(Boolean).join(" · ")
      : formatDay(track.date) || track.artist
    : numbered && !withAlbum
      ? track.artist
      : `${track.artist} · ${track.album}`;

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
  offline,
  positions,
  compact = false,
  flat = false,
}) {
  const { s, c } = useDesign();
  const { reduce } = useMotion();
  const [shown, setShown] = useState(PAGE);
  const NOTES = notes(offline);
  return (
    <>
      <View style={flat ? s.musicPaneList : s.group}>
        {rows.slice(0, shown).map((row, index) => {
          const key = `${index}:${row.track?.id || row.title}`;
          const style = [s.musicTrack, !compact && s.musicTrackTall, index > 0 && s.separator];
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
                  <Cover uri={cover(row.track?.cover, "small")} size={40} icon={row.track?.podcast ? "podcast" : "album"} />
                )}
                <View style={[s.flex, s.stack]}>
                  <Text numberOfLines={1} style={[s.rowTitle, s.musicPending]}>
                    {row.title}
                  </Text>
                  {!compact && (
                    <Text numberOfLines={1} style={[s.caption, s.musicPending]}>
                      {NOTES[row.state]}
                    </Text>
                  )}
                </View>
                {compact && (
                  <Text numberOfLines={1} style={[s.caption, s.musicPending]}>
                    {NOTES[row.state]}
                  </Text>
                )}
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
          const saved = current ? null : savedPosition(positions, track);
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`${canPlay ? (saved ? "Resume" : "Play") : "Open"} ${track.title}, ${track.artist}${saved ? `, ${timeLeft(saved.duration - saved.position)}` : ""}`}
              accessibilityActions={
                actions ? [{ name: "actions", label: "Track actions" }] : undefined
              }
              onAccessibilityAction={() => actions?.(row)}
              onPress={() =>
                play(contextOf ? contextOf(track) : context, track, false, row.position, saved?.position || 0)
              }
              style={({ pressed }) => [...style, pressed && s.pressed, pressScale(pressed, reduce)]}
            >
              {numbered ? (
                <View style={s.musicNumber}>
                  {current ? <NowGlyph /> : <Text style={s.mono}>{row.number}</Text>}
                </View>
              ) : (
                <Cover uri={cover(track.cover, "small")} size={40} icon={track.podcast ? "podcast" : "album"} />
              )}
              <View style={[s.flex, s.stack]}>
                <Text
                  numberOfLines={1}
                  style={[s.rowTitle, current && s.active]}
                >
                  {track.title}
                </Text>
                {!compact && (
                  <RowMeta
                    track={track}
                    caption={trackCaption(track, numbered, withAlbum)}
                    saved={saved}
                    live={current}
                    style={s.caption}
                  />
                )}
              </View>
              {!numbered && current && <NowGlyph />}
              {!!track.duration && !saved && !current && (
                <Text style={s.caption}>
                  {track.podcast ? formatLength(track.duration) : formatDuration(track.duration)}
                </Text>
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
  offline,
  positions,
  episodes = false,
  menu,
  flat = false,
}) {
  const { s, wide } = useDesign();
  const flight = useFlight("collection", true);
  const first = library.tracks.get(tracks[0]);
  const shuffle = () => {
    const index = Math.floor(Math.random() * tracks.length);
    play(context, library.tracks.get(tracks[index]), true, index);
  };
  return (
    <>
      <View style={[s.musicHeader, wide && s.musicHeaderWide]}>
        <Animated.View ref={flight.frame} style={flight.style}>
          <Cover uri={coverUri} size={wide ? 160 : 128} icon={icon} />
        </Animated.View>
        <View style={[s.flex, s.stack]}>
          <Text accessibilityRole="header" style={s.title}>
            {title}
          </Text>
          {!!subtitle && <Text style={s.text}>{subtitle}</Text>}
          {((canPlay && first) || menu) && (
            <View style={s.musicActions}>
              {canPlay && first && (
                <Button
                  primary
                  label="Play"
                  icon="play"
                  onPress={() =>
                    play(context, first, false, 0, savedPosition(positions, first)?.position || 0)
                  }
                />
              )}
              {canPlay && tracks.length > 1 && !episodes && (
                <Button label="Shuffle" icon="shuffle" onPress={shuffle} />
              )}
              {menu && <Button iconOnly label="Playlist actions" icon="more" onPress={menu} />}
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
        numbered={!episodes}
        compact={!episodes && !withAlbum}
        cover={cover}
        canPlay={canPlay}
        actions={actions}
        removable={removable}
        withAlbum={withAlbum}
        offline={offline}
        positions={positions}
        flat={flat}
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

const resumeSeen = { current: false };

function ResumeCard({ item, cover, canPlay, start, deviceId, relative }) {
  const { s } = useDesign();
  const { track, row } = item;
  const where = row.device && row.device === deviceId ? "this phone" : row.name || "another device";
  const caption = [
    track.podcast ? track.artist : null,
    `stopped at ${formatDuration(row.position) || "0:00"}`,
    `${where}, ${relative(new Date(row.updated).toISOString())}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <RiseOnce seen={resumeSeen}>
      <View style={[s.group, s.resumeCard]} accessibilityRole="summary">
        <Cover uri={cover(track.cover, "small")} size={40} icon={track.podcast ? "podcast" : "album"} />
        <View style={[s.flex, s.stack]}>
          <Text style={s.eyebrow}>PICK UP WHERE YOU LEFT OFF</Text>
          <Text numberOfLines={1} style={s.rowTitle}>
            {track.title}
          </Text>
          <Text numberOfLines={2} style={s.caption}>
            {caption}
          </Text>
          <ProgressLine value={fraction(row.position, row.duration)} />
          {canPlay && (
            <View style={s.resumeActions}>
              <Button primary size="small" label="Continue" icon="play" onPress={() => start(row.position)} />
              <Button size="small" label="Start over" icon="rotate-ccw" onPress={() => start(0)} />
            </View>
          )}
        </View>
      </View>
    </RiseOnce>
  );
}

export function MusicLibrary({
  library,
  saved,
  indexing,
  offline,
  route,
  push,
  go,
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
  positions,
  deviceId,
  relative,
}) {
  const { s, wide } = useDesign();
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
        text="Connect to the hub to load this audio library."
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
  const tab = tabs.includes(route[0]?.kind) ? route[0].kind : tabs[0];
  const results = found;
  const pane = musicPane(route, wide);
  const searchLabel = musicSearchLabel(library);
  const top = pane.level > 0 ? route[pane.level] : { kind: results ? "search" : tab };
  const shuffle = (context, ids) => {
    const index = Math.floor(Math.random() * ids.length);
    play(folderContext(folderId, context), library.tracks.get(ids[index]), true, index);
  };
  const everything = libraryTracks(library);
  const resume =
    route.length === 1 && !searching
      ? resumeCandidate(positions, library, folderId, playing)
      : null;
  const root =
    pane.level === 0 ? (
      <>
        {resume && (
          <ResumeCard
            item={resume}
            cover={cover}
            canPlay={canPlay}
            deviceId={deviceId}
            relative={relative}
            start={(at) => {
              const base = trackContext(resume.track);
              const list = library.shows.get(base)?.tracks || library.albums.get(base)?.tracks || [];
              const index = list.indexOf(resume.track.id);
              play(folderContext(folderId, base), resume.track, false, index >= 0 ? index : -1, at);
            }}
          />
        )}
        {tabs.length > 1 && (
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
              label={searching ? "Close search" : searchLabel}
              icon={searching ? "close" : "search"}
              onPress={() => setSearch(searching ? null : "")}
            />
          </View>
        )}
        {searching && (
          <Field
            label={searchLabel}
            autoFocus={!query}
            placeholder={searchLabel}
            returnKeyType="search"
            value={query}
            onChangeText={setSearch}
          />
        )}
        {canPlay && !results && tab !== "podcasts" && everything.length > 1 && (
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
    ) : null;
  const open = (next) =>
    pane.detail ? go([...route.slice(0, pane.level + 1), next]) : push(next);
  const openAlbum = (album) => open({ kind: "album", id: album.id });
  const openPlaylist = (playlist) => open({ kind: "playlist", id: playlist.id });
  const chosen = (kind, id) => pane.detail?.kind === kind && pane.detail.id === id;
  const playlistRow = (playlist, index, caption = playlistSummary(playlist)) => (
    <MusicRow
      key={playlist.id}
      divider={index > 0}
      icon="playlist"
      cover={cover(playlist.cover, "small")}
      title={playlist.name}
      caption={caption}
      selected={chosen("playlist", playlist.id)}
      onPress={() => openPlaylist(playlist)}
    />
  );
  const albumRow = (album, index, caption = album.artist) => (
    <MusicRow
      key={album.id}
      divider={index > 0}
      icon="album"
      cover={cover(album.cover, "small")}
      title={album.title}
      caption={caption}
      selected={chosen("album", album.id)}
      onPress={() => openAlbum(album)}
    />
  );
  const showRow = (show, index) => (
    <MusicRow
      key={show.id}
      divider={index > 0}
      icon="podcast"
      flight={!pane.detail}
      cover={cover(show.cover, "small")}
      title={show.name}
      caption={showCaption(show)}
      selected={chosen("show", show.id)}
      onPress={() => open({ kind: "show", id: show.id })}
    />
  );
  const playingRow = (row) => row.track?.id === playing;
  const albumsOf = (ids) =>
    ids.map((id) => library.albums.get(id)).filter(Boolean);
  const albums = (list, caption = (album) => album.artist) =>
    pane.detail ? (
      <PagedRows items={list} render={(album, index) => albumRow(album, index, caption(album))} />
    ) : (
      <AlbumGrid albums={list} cover={cover} open={openAlbum} />
    );
  const page = (item, flat = false) => {
    if (item.kind === "search") {
      const found =
        results.tracks.length +
        results.albums.length +
        results.artists.length +
        results.playlists.length +
        results.shows.length +
        results.episodes.length;
      return found ? (
        <>
          {results.tracks.length > 0 && (
            <Section>
              <Text style={s.eyebrow}>SONGS</Text>
              <TrackList
                rows={readyRows(library, results.tracks)}
                contextOf={(track) => folderContext(folderId, trackContext(track))}
                isCurrent={playingRow}
                play={play}
                cover={cover}
                canPlay={canPlay}
                positions={positions}
              />
            </Section>
          )}
          {results.albums.length > 0 && (
            <Section>
              <Text style={s.eyebrow}>ALBUMS</Text>
              {albums(results.albums)}
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
                    onPress={() => open({ kind: "artist", id: artist.id })}
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
          {results.shows.length > 0 && (
            <Section>
              <Text style={s.eyebrow}>SHOWS</Text>
              <PagedRows items={results.shows} render={(show, index) => showRow(show, index)} />
            </Section>
          )}
          {results.episodes.length > 0 && (
            <Section>
              <Text style={s.eyebrow}>EPISODES</Text>
              <TrackList
                rows={episodeRows(library, results.episodes)}
                contextOf={(track) => folderContext(folderId, track.show)}
                isCurrent={playingRow}
                play={play}
                cover={cover}
                canPlay={canPlay}
                actions={(row) => trackActions({ track: row.track })}
                withAlbum
                positions={positions}
              />
            </Section>
          )}
        </>
      ) : (
        <EmptyState
          icon="search"
          title={`No results for “${query.trim()}”`}
          text={
            searchLabel === "Search podcasts"
              ? "Try the name of a show or episode."
              : searchLabel === "Search"
                ? "Try the name of a song, album, artist, show or episode."
                : "Try the name of a song, album, artist or playlist."
          }
        />
      );
    }
    if (item.kind === "artists")
      return (
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
    if (item.kind === "artist") {
      const artist = library.artists.find((entry) => entry.id === item.id);
      const ids = artist ? libraryTracks(library, artist.albums) : [];
      return artist ? (
        <Section>
          {!wide && (
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
          )}
          {canPlay && ids.length > 1 && (
            <View style={s.musicActions}>
              <Button
                label="Shuffle"
                icon="shuffle"
                onPress={() => shuffle(artist.id, ids)}
              />
            </View>
          )}
          {albums(albumsOf(artist.albums), (album) =>
            [album.year, plural(album.tracks.length, "track", "tracks")].filter(Boolean).join(" · "),
          )}
        </Section>
      ) : null;
    }
    if (item.kind === "albums") return albums(albumsOf(library.albumOrder));
    if (item.kind === "playlists")
      return (
        <PagedRows
          items={library.playlistOrder.map((id) => library.playlists.get(id))}
          render={(playlist, index) => playlistRow(playlist, index)}
        />
      );
    if (item.kind === "recent") {
      const played = recentPlayed(library, history || []);
      return played.length ? (
        <Section>
          <Text style={s.eyebrow}>RECENTLY PLAYED</Text>
          <View style={s.group}>
            {played.map((entry, index) =>
              library.playlists.has(entry.id)
                ? playlistRow(entry, index, plural(entry.tracks.length, "track", "tracks"))
                : albumRow(entry, index, entry.artist),
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
          {albums(albumsOf(library.recent))}
        </Section>
      );
    }
    if (item.kind === "podcasts")
      return (
        <PagedRows
          items={library.showOrder.map((id) => library.shows.get(id))}
          render={(show, index) => showRow(show, index)}
        />
      );
    if (item.kind === "show") {
      const show = library.shows.get(item.id);
      return show ? (
        <Collection
          title={show.name}
          subtitle={showSummary(show)}
          coverUri={cover(show.cover, "large")}
          icon="podcast"
          rows={showRows(library, show)}
          tracks={show.tracks}
          library={library}
          context={folderContext(folderId, show.id)}
          canPlay={canPlay}
          play={play}
          isCurrent={playingRow}
          cover={cover}
          actions={(row) => trackActions({ track: row.track })}
          offline={offline}
          positions={positions}
          episodes
          flat={flat}
        />
      ) : null;
    }
    if (item.kind === "album") {
      const album = library.albums.get(item.id);
      return album ? (
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
          offline={offline}
          positions={positions}
          flat={flat}
        />
      ) : null;
    }
    const playlist = item.kind === "playlist" ? library.playlists.get(item.id) : null;
    return playlist ? (
      <Collection
        title={playlist.name}
        subtitle={playlistSummary(playlist)}
        coverUri={cover(playlist.cover, "large")}
        icon="playlist"
        rows={playlistRows(library, playlist)}
        tracks={playlist.tracks}
        library={library}
        context={folderContext(folderId, playlist.id)}
        canPlay={canPlay}
        play={play}
        isCurrent={(row) =>
          playingRow(row) &&
          baseContext(node.context) === playlist.id &&
          (node.position === null || node.position === row.position)
        }
        cover={cover}
        actions={(row) =>
          trackActions({
            track: row.track,
            title: row.title,
            path: row.path,
            playlist,
            entry: row.entry,
          })
        }
        removable={playlist.editable}
        withAlbum
        offline={offline}
        positions={positions}
        menu={playlist.editable ? () => playlistActions(playlist) : undefined}
        flat={flat}
      />
    ) : null;
  };
  const gone = (
    <EmptyState
      icon="music"
      title="No longer in this library"
      text="It was removed or renamed on the hub."
    />
  );
  const main = (
    <ChangeFade token={pane.level === 0 ? top.kind : `page:${pane.level}`} ms={motion.fast} style={s.musicPage}>
      {page(top) || gone}
    </ChangeFade>
  );
  return (
    <View style={s.musicPage}>
      {root}
      {pane.detail ? (
        <View style={s.musicSplit}>
          <View style={s.musicSplitList}>{main}</View>
          <View style={s.musicSplitPane}>
            <ChangeFade token={`${pane.detail.kind}:${pane.detail.id}`} ms={motion.fast} style={s.musicPage}>
              {page(pane.detail, true) || gone}
            </ChangeFade>
          </View>
        </View>
      ) : (
        main
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

export function MusicSheet({ sheet, library, cover, locked, open, change, remove, removeTrack }) {
  const { s } = useDesign();
  if (sheet.kind === "track-actions")
    return (
      <>
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
              divider={!!sheet.track}
              disabled={locked}
              onPress={() => change("remove", sheet)}
            />
          )}
        </View>
        {sheet.track && (
          <View style={s.destructiveActionGroup}>
            <ActionRow
              label="Delete…"
              icon="trash"
              danger
              disabled={locked}
              onPress={() => removeTrack(sheet.track)}
            />
          </View>
        )}
      </>
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

const playingTrack = (library, state) =>
  library?.tracks.get(parseTrackNode(state?.id)?.track);

const miniSeen = { current: false };

export function MiniPlayer({ library, cover, open, command, sleep }) {
  const { s, c } = useDesign();
  const { reduce } = useMotion();
  const art = useRef(null);
  const [state] = useMusicPlayer(true);
  const now = useNow(sleep?.mode === "duration");
  if (!state?.id) return null;
  const track = playingTrack(library, state);
  const playing = isPlaying(state);
  const total = state.duration || (track?.duration || 0) * 1000;
  const at = Math.min(state.position || 0, total || 0);
  const sleeping = !!sleep && sleep.mode !== "off";
  const caption = track?.podcast
    ? [track.artist, total ? timeLeft((total - at) / 1000) : ""].filter(Boolean).join(" · ")
    : [track?.artist || state.artist, track?.album || state.album].filter(Boolean).join(" · ");
  return (
    <RiseOnce seen={miniSeen}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Now playing ${track?.title || state.title || ""}`}
        onPress={() => {
          let opened = false;
          const go = () => {
            if (opened) return;
            opened = true;
            open();
          };
          if (!art.current?.measureInWindow) return go();
          art.current.measureInWindow((x, y, width, height) => {
            putFlight("cover", { x, y, width, height });
            go();
          });
          setTimeout(go, 150);
        }}
        style={({ pressed }) => [s.miniPlayer, pressed && s.pressed, pressScale(pressed, reduce)]}
      >
        <View ref={art}>
          <Cover uri={cover(track?.cover, "small")} size={40} icon={track?.podcast ? "podcast" : "album"} />
        </View>
        <View style={[s.flex, s.stack]}>
          <Text numberOfLines={1} style={s.rowTitle}>
            {track?.title || state.title || "Unknown track"}
          </Text>
          {state.error ? (
            <Text numberOfLines={1} style={[s.caption, s.errorText]}>
              {state.error}
            </Text>
          ) : sleeping ? (
            <View style={s.miniSleep} accessibilityLabel={`Sleep timer, ${sleepLabel(sleep, now, !!track?.podcast)}`}>
              <Icon name="moon" size={14} color={c.accent} />
              <Text numberOfLines={1} style={[s.caption, s.active]}>
                {sleepLabel(sleep, now, !!track?.podcast)}
              </Text>
            </View>
          ) : (
            <Text numberOfLines={1} style={s.caption}>
              {caption}
            </Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing ? "Pause" : "Play"}
          hitSlop={8}
          onPress={() => command("toggle")}
          style={s.miniControl}
        >
          <ChangeFade token={playing ? "pause" : "play"} ms={motion.fast}>
            <Icon name={playing ? "pause" : "play"} size={22} color={c.ink} />
          </ChangeFade>
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
        {total > 0 && (
          <View style={s.miniProgress} pointerEvents="none">
            <View style={[s.progressFill, { width: `${Math.round(fraction(at, total) * 100)}%` }]} />
          </View>
        )}
      </Pressable>
    </RiseOnce>
  );
}
