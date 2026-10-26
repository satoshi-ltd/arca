import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  ActionRow,
  Button,
  EmptyState,
  Icon,
  PressScale,
  ProgressRing,
  Scaffold,
  SegmentedControl,
  useDesign,
} from "./components";
import { ScrollPosition } from "./KeyboardPane";
import { ProgressLine } from "./MusicLibrary";
import {
  GRID_GAP,
  MOVIE_SORTS,
  TAB_LABELS,
  cardLabel,
  downloadedTitles,
  episodeCaption,
  episodeTitle,
  gridColumns,
  gridRows,
  gridWindow,
  languageChips,
  playLabel,
  playTarget,
  posterGrid,
  relatedShelf,
  shelfTarget,
  progress,
  resumeLine,
  seasonLabel,
  titleFacts,
  titleFile,
  titleActions,
  videoBackLabel,
  videoShelves,
  videoTabs,
  watchedLine,
} from "./video-library.js";
import { NOT_DOWNLOADABLE, OFFLINE_DOWNLOADS, downloadFraction, downloadLabel, downloadNote, downloadTile, isDownloading } from "./video-downloads.js";


function Art({ uri, shape, icon }) {
  const { s, c } = useDesign();
  const [failed, setFailed] = useState(null);
  const shown = uri && failed !== uri;
  return (
    <View style={[s.videoArt, shape === "poster" ? s.videoPoster : s.videoStill]}>
      {shown ? (
        <Image source={{ uri }} style={s.galleryImage} onError={() => setFailed(uri)} accessibilityIgnoresInvertColors />
      ) : (
        <Icon name={icon} size={28} color={c.mute} />
      )}
    </View>
  );
}

function Watched() {
  const { s, c } = useDesign();
  return (
    <View style={s.videoWatched} pointerEvents="none">
      <Icon name="check" size={14} color={c.onAccent} />
    </View>
  );
}

function Saved() {
  const { s, c } = useDesign();
  return (
    <View style={s.videoSaved} pointerEvents="none">
      <Icon name="arrow-down-to-line" size={14} color={c.onMedia} />
    </View>
  );
}

function Ring({ value, large }) {
  const { s } = useDesign();
  return (
    <View style={large ? s.videoRingLarge : s.videoRing}>
      <ProgressRing fraction={value} size={large ? 20 : 16} thickness={2} />
    </View>
  );
}

function DockMain({ label, icon, onPress, progress }) {
  const { s, c } = useDesign();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [s.button, s.primary, s.videoDockMain, pressed && s.pressedFade]}>
      <Icon name={icon} color={c.onAccent} />
      <Text style={[s.buttonLabel, s.primaryLabel]}>{label}</Text>
      {progress != null && (
        <View style={s.videoDockEdge} pointerEvents="none">
          <View style={[s.videoDockEdgeFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      )}
    </PressScale>
  );
}

function DockTile({ label, icon, ring, value, disabled, onPress, spoken }) {
  const { s, c } = useDesign();
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={spoken || label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={!!disabled}
      onPress={onPress}
      style={({ pressed }) => [s.videoDockTile, pressed && !disabled && s.pressed, disabled && s.disabled]}
    >
      {ring ? <Ring large value={value} /> : <Icon name={icon} size={20} color={c.ink} />}
      <Text numberOfLines={1} style={s.videoDockLabel}>
        {label}
      </Text>
    </PressScale>
  );
}

function EpisodeDownload({ row, start, cancel, allowed }) {
  const { s, c } = useDesign();
  if (row?.state === "done")
    return (
      <View style={s.videoDownload} accessibilityLabel="Downloaded">
        <Icon name="check-circle" color={c.accent} />
      </View>
    );
  const active = isDownloading(row);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? `${downloadLabel(row)}, cancel download` : !allowed ? NOT_DOWNLOADABLE : row ? downloadLabel(row) : "Download episode"}
      accessibilityState={{ disabled: !active && !allowed }}
      disabled={!active && !allowed}
      hitSlop={4}
      onPress={active ? cancel : start}
      style={({ pressed }) => [s.videoDownload, pressed && s.pressedFade, !active && !allowed && s.disabled]}
    >
      {active ? <Ring large value={downloadFraction(row)} /> : <Icon name="download" color={row?.state === "failed" ? c.danger : c.mute} />}
    </Pressable>
  );
}

function VideoCard({ card, wide, art, open, fill, hold }) {
  const { s } = useDesign();
  const removable = card.removable && !!hold;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cardLabel(card)}
      accessibilityActions={removable ? [{ name: "remove", label: "Remove from Watch next" }] : undefined}
      onAccessibilityAction={removable ? () => hold(card) : undefined}
      onLongPress={removable ? () => hold(card) : undefined}
      onPress={() => open(card.item)}
      style={({ pressed }) => [
        wide ? s.videoCardWide : fill ? s.videoCardFill : s.videoCard,
        pressed && s.musicTilePressed,
      ]}
    >
      <View style={s.musicTileCover}>
        <Art uri={art(card.art, wide ? "large" : "small")} shape={wide ? "still" : "poster"} icon={card.icon} />
        {card.progress != null && <ProgressLine value={card.progress} edge />}
        {card.watched && <Watched />}
        {card.saved && <Saved />}
        {(card.next || card.fresh) && (
          <View style={s.videoNext} pointerEvents="none">
            <Text style={s.videoRatingText}>{card.next ? "NEXT" : "NEW"}</Text>
          </View>
        )}
        {!wide && !!card.rating && (
          <View style={s.videoRating} pointerEvents="none">
            <Text style={s.videoRatingText}>{card.rating}</Text>
          </View>
        )}
      </View>
      <Text numberOfLines={1} style={s.rowTitle}>
        {card.title}
      </Text>
      {(!!card.caption || fill) && (
        <Text numberOfLines={1} style={s.caption}>
          {card.caption || " "}
        </Text>
      )}
    </Pressable>
  );
}

function Shelf({ shelf, art, open, hold }) {
  const { s } = useDesign();
  return (
    <View style={s.videoShelfBlock}>
      <Text style={s.eyebrow}>{shelf.title.toUpperCase()}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.videoShelf}>
        {shelf.cards.map((card) => (
          <VideoCard key={card.key} card={card} wide={shelf.wide} art={art} open={open} hold={hold} />
        ))}
      </ScrollView>
    </View>
  );
}

function Grid({ cards, art, open, scrollRef, scrollY }) {
  const { s, wide } = useDesign();
  const position = useContext(ScrollPosition);
  const rows = useMemo(() => gridRows(cards, gridColumns(wide)), [cards, wide]);
  const root = useRef(null);
  const top = useRef(0);
  const height = useRef(0);
  const follow = useRef(null);
  const [range, setRange] = useState(() => gridWindow({ scroll: 0, top: 0, viewport: 0, pitch: 0, rows: rows.length }));
  follow.current = (scroll) => {
    const next = gridWindow({ scroll, top: top.current, viewport: position?.viewport.height || 800, pitch: height.current ? height.current + GRID_GAP : 0, rows: rows.length });
    setRange((old) => (old.first === next.first && old.last === next.last ? old : next));
  };
  useEffect(() => {
    if (!scrollRef) return undefined;
    scrollRef.current = (y) => follow.current(y);
    return () => {
      scrollRef.current = null;
    };
  }, [scrollRef]);
  useEffect(() => follow.current(scrollY?.current || 0), [rows.length, position?.viewport.height]);
  const measure = () => position?.measure(root.current, ({ top: at }) => {
    top.current = at;
    follow.current(scrollY?.current || 0);
  });
  const pitch = height.current ? height.current + GRID_GAP : 0;
  const first = Math.min(range.first, Math.max(0, rows.length - 1));
  const last = Math.min(range.last, rows.length - 1);
  return (
    <View ref={root} onLayout={measure}>
      {pitch > 0 && first > 0 && <View style={{ height: first * pitch }} />}
      {rows.slice(first, last + 1).map((row, index) => (
        <View
          key={row[0].key}
          style={s.videoGridRow}
          onLayout={
            first + index === 0
              ? (event) => {
                  const value = event.nativeEvent.layout.height;
                  if (Math.abs(value - height.current) < 0.5) return;
                  height.current = value;
                  follow.current(scrollY?.current || 0);
                }
              : undefined
          }
        >
          {row.map((card) => (
            <VideoCard key={card.key} card={card} art={art} open={open} fill />
          ))}
        </View>
      ))}
      {pitch > 0 && last < rows.length - 1 && <View style={{ height: (rows.length - 1 - last) * pitch }} />}
    </View>
  );
}

function Band({ item, art, back, backLabel, more }) {
  const { s, c } = useDesign();
  const uri = art(item.backdrop, "large");
  return (
    <View style={s.videoBand}>
      {!!uri && <Image source={{ uri }} style={s.videoBandImage} accessibilityIgnoresInvertColors />}
      <View style={s.videoBandScrim} pointerEvents="none" />
      <View style={s.videoBandBar}>
        <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={back} style={({ pressed }) => [s.videoBandButton, pressed && s.pressedFade]}>
          <Icon name="back" color={c.onMedia} />
          <Text style={s.videoBandLabel}>{backLabel}</Text>
        </Pressable>
        {!!more && (
          <Pressable accessibilityRole="button" accessibilityLabel="Title actions" onPress={more} style={({ pressed }) => [s.videoBandIcon, pressed && s.pressedFade]}>
            <Icon name="more" color={c.onMedia} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function LanguageGroup({ icon, label, codes }) {
  const { s, c } = useDesign();
  if (!codes.length) return null;
  return (
    <View style={s.videoLanguageGroup} accessible accessibilityLabel={label}>
      <Icon name={icon} size={14} color={c.soft} />
      {codes.map((code) => (
        <View key={code} style={s.videoBadge}>
          <Text style={s.videoBadgeText}>{code}</Text>
        </View>
      ))}
    </View>
  );
}

function Languages({ languages }) {
  const { s } = useDesign();
  if (!languages.audio.length && !languages.subtitles.length) return null;
  return (
    <View style={s.videoLanguages}>
      <LanguageGroup icon="audio-lines" label={languages.audioLabel} codes={languages.audio} />
      <LanguageGroup icon="captions" label={languages.subtitleLabel} codes={languages.subtitles} />
    </View>
  );
}

function Facts({ facts }) {
  const { s } = useDesign();
  return (
    <View style={s.videoFacts}>
      {facts.map((fact, index) =>
        fact.kind === "badge" ? (
          <View key={index} style={s.videoBadge}>
            <Text style={s.videoBadgeText}>{fact.text}</Text>
          </View>
        ) : (
          <Text key={index} style={fact.kind === "rating" ? s.videoFactRating : s.caption}>
            {fact.text}
          </Text>
        ),
      )}
    </View>
  );
}

function EpisodeRow({ ep, art, play, divider, row, start, cancel, allowed }) {
  const { s, c } = useDesign();
  const value = progress(ep);
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={`${episodeTitle(ep)}, ${episodeCaption(ep)}${ep.watched ? ", watched" : ""}`}
      onPress={() => play(ep, ep.position?.position || 0)}
      style={({ pressed }) => [s.videoEpisode, divider && s.separator, pressed && s.pressed]}
    >
      <View style={s.videoEpisodeStill}>
        <Art uri={art(ep.still, "small")} shape="still" icon="tv" />
        {value != null && <ProgressLine value={value} edge />}
      </View>
      <View style={[s.flex, s.stack]}>
        <Text numberOfLines={1} style={[s.rowTitle, ep.position && s.videoNow]}>
          {episodeTitle(ep)}
        </Text>
        <Text numberOfLines={1} style={s.caption}>
          {episodeCaption(ep)}
        </Text>
        {!!ep.overview && (
          <Text numberOfLines={2} style={s.caption}>
            {ep.overview}
          </Text>
        )}
      </View>
      {ep.watched && <Icon name="check" size={18} color={c.accent} />}
      <EpisodeDownload row={row} start={start} cancel={cancel} allowed={allowed} />
    </PressScale>
  );
}

function Seasons({ show, season, choose }) {
  const { s } = useDesign();
  if (show.seasons.length < 2) return <Text style={s.eyebrow}>{seasonLabel(show.seasons[0]).toUpperCase()}</Text>;
  return (
    <SegmentedControl
      scroll
      options={show.seasons.map((entry) => ({ value: entry.season, label: seasonLabel(entry) }))}
      value={season}
      onChange={choose}
    />
  );
}

function TitlePage({ library, item, route, setRoute, art, play, more, mark, open, download, startDownload, cancelDownload, canDownload }) {
  const { s, wide } = useDesign();
  const back = () => setRoute(route.slice(0, 1));
  const actions = titleActions(item);
  const watched = actions[0] === "unwatched";
  const show = item.kind === "show";
  const focus = route[1].episode ? library.items.get(route[1].episode) : null;
  const target = playTarget(library, item);
  const season =
    show &&
    (item.seasons.find((entry) => entry.season === route[1].season) ||
      item.seasons.find((entry) => entry.season === (focus || target)?.season) ||
      item.seasons[0]);
  const languages = titleFile(library, item) ? languageChips(titleFile(library, item)) : null;
  const head = (
    <View style={s.videoHead}>
      <View style={s.videoHeadPoster}>
        <Art uri={art(item.poster, "small")} shape="poster" icon={show ? "tv" : "clapperboard"} />
        {watched && <Watched />}
      </View>
      <View style={s.videoHeadText}>
        <Text accessibilityRole="header" style={s.title}>
          {item.title}
        </Text>
        <Facts facts={titleFacts(item, library)} />
        {!!languages && <Languages languages={languages} />}
        {show && <Text style={s.caption}>{watchedLine(item)}</Text>}
      </View>
    </View>
  );
  const row = show ? null : download(item);
  const allowed = show ? false : canDownload(item);
  const tile = show ? null : downloadTile(row, allowed);
  const note = show ? "" : downloadNote(row, allowed, item, Platform.OS);
  const tileAction = { start: () => startDownload([item]), cancel: () => cancelDownload([item]), manage: () => more(item), none: undefined };
  const playRow = target && (
    <View style={s.videoDock}>
      <DockMain label={playLabel(library, item)} icon="play" progress={target.position ? progress(target) : null} onPress={() => play(target, target.position?.position || 0)} />
      {!!target.position && <Text style={s.caption}>{resumeLine(target)}</Text>}
      <View style={s.videoDockTiles}>
        {!!target.position && <DockTile label="Start over" icon="rotate-ccw" onPress={() => play(target, 0)} />}
        {tile && (
          <DockTile
            label={tile.label}
            icon={tile.icon}
            ring={tile.ring}
            value={downloadFraction(row)}
            disabled={tile.disabled}
            spoken={tile.disabled ? `Download unavailable. ${note}` : tile.action === "cancel" ? `${tile.label}, cancel download` : tile.label}
            onPress={tileAction[tile.action]}
          />
        )}
        <DockTile label={watched ? "Unwatch" : "Watched"} icon={watched ? "eye-off" : "check"} spoken={watched ? "Mark as unwatched" : "Mark as watched"} onPress={() => mark(item, !watched)} />
      </View>
      {!!note && <Text style={s.caption}>{note}</Text>}
    </View>
  );
  const facts = (
    <View style={s.stack}>
      {!!item.overview && <Text style={s.text}>{item.overview}</Text>}
      {!!item.cast.length && <Text style={s.caption}>{item.cast.join(", ")}</Text>}
    </View>
  );
  const related = relatedShelf(library, item);
  const relatedRow = related && <Shelf shelf={related} art={art} open={open} />;
  const missing = show ? season.episodes.filter((ep) => canDownload(ep) && (!download(ep) || ["failed", "stale"].includes(download(ep).state))) : [];
  const episodesPane = show && (
    <View style={s.stack}>
      <View style={s.row}>
        <View style={s.flex}>
          <Seasons show={item} season={season.season} choose={(value) => setRoute([route[0], { ...route[1], season: value, episode: undefined }])} />
        </View>
        {wide && (
          <Text style={s.caption}>
            {`${season.episodes.filter((ep) => ep.watched).length} of ${season.episodes.length} watched`}
          </Text>
        )}
        {missing.length > 0 && <Button quiet label="Download season" icon="download" onPress={() => startDownload(missing)} />}
      </View>
      <View style={s.group}>
        {season.episodes.map((ep, index) => (
          <EpisodeRow
            key={ep.id}
            ep={ep}
            art={art}
            play={play}
            divider={index > 0}
            row={download(ep)}
            start={() => startDownload([ep])}
            cancel={() => cancelDownload([ep])}
            allowed={canDownload(ep)}
          />
        ))}
      </View>
    </View>
  );
  return (
    <View style={s.musicPage}>
      <Band item={item} art={art} back={back} backLabel={videoBackLabel(route)} more={() => more(item)} />
      {wide ? (
        <View style={s.videoSplit}>
          <View style={s.videoSplitSide}>
            {head}
            {playRow}
            {show && facts}
          </View>
          <View style={s.videoSplitMain}>
            {!show && facts}
            {relatedRow}
            {episodesPane}
          </View>
        </View>
      ) : (
        <>
          {head}
          {playRow}
          {facts}
          {relatedRow}
          {episodesPane}
        </>
      )}
    </View>
  );
}

export function VideoOffline({ hubName, openDevices }) {
  return (
    <EmptyState
      icon="arca"
      title="Connect to your hub to watch"
      text={`This library streams from ${hubName || "your hub"}. Join your home network or Tailscale to browse and play.`}
      action={<Button label="Open Devices" onPress={openDevices} />}
    />
  );
}

export function VideoLibrary({
  library,
  offline,
  hubName,
  route,
  setRoute,
  art,
  play,
  more,
  mark,
  openDevices,
  hold = null,
  download = () => null,
  startDownload = () => {},
  cancelDownload = () => {},
  canDownload = () => false,
  scrollRef = null,
  scrollY = null,
}) {
  const { s, wide } = useDesign();
  const [sort, setSort] = useState("title");
  const tab = route[0]?.kind;
  if (!library)
    return offline ? (
      <VideoOffline hubName={hubName} openDevices={openDevices} />
    ) : (
      <Scaffold label="Loading videos" />
    );
  const shown = library;
  const open = (item) => {
    const target = shelfTarget(item);
    if (target.play) play(item, item.position?.position || 0);
    else setRoute([route[0], target.route]);
  };
  if (route[1]?.kind === "title") {
    const item = shown.items.get(route[1].id);
    if (item)
      return (
        <TitlePage
          library={shown}
          item={item}
          route={route}
          setRoute={setRoute}
          art={art}
          play={play}
          more={more}
          mark={mark}
          open={open}
          download={download}
          startDownload={startDownload}
          cancelDownload={cancelDownload}
          canDownload={canDownload}
        />
      );
    return (
      <EmptyState
        icon="clapperboard"
        title="No longer in this library"
        text="It was removed or renamed on the hub."
        action={<Button label={videoBackLabel(route)} icon="back" onPress={() => setRoute(route.slice(0, 1))} />}
      />
    );
  }
  if (offline) {
    const saved = downloadedTitles(shown, download);
    if (!saved.length) return <VideoOffline hubName={hubName} openDevices={openDevices} />;
    return (
      <View style={s.musicPage}>
        <Text style={s.caption}>{OFFLINE_DOWNLOADS}</Text>
        <Grid key="downloads" cards={saved} art={art} open={open} scrollRef={scrollRef} scrollY={scrollY} />
      </View>
    );
  }
  const caption = <Text style={s.caption}>Streaming from hub</Text>;
  const tabs = videoTabs(shown);
  if (!tabs.length)
    return (
      <EmptyState
        icon="clapperboard"
        title={library.indexing ? "Reading this library" : "No videos yet"}
        text={library.indexing ? "The hub is reading this folder. Titles appear as it goes." : "Movies, shows and other videos added to this folder appear here."}
      />
    );
  const current = tabs.includes(tab) ? tab : tabs[0];
  const sorting = current !== "home";
  const sorter = <SegmentedControl scroll={!wide} options={MOVIE_SORTS} value={sort} onChange={setSort} />;
  const body =
    current === "home" ? (
      videoShelves(shown, download).map((shelf) => <Shelf key={shelf.key} shelf={shelf} art={art} open={open} hold={hold} />)
    ) : (
      <>
        {sorting && (!wide || tabs.length < 2) && sorter}
        <Grid
          key={`${current}:${sort}`}
          cards={posterGrid(shown, current, { sort })}
          art={art}
          open={current === "other" ? (item) => play(item, item.position?.position || 0) : open}
          scrollRef={scrollRef}
          scrollY={scrollY}
        />
      </>
    );
  return (
    <View style={s.musicPage}>
      {tabs.length > 1 && (
        <View style={s.videoToolbar}>
          <View style={!wide && s.flex}>
            <SegmentedControl
              scroll={!wide}
              options={tabs.map((value) => ({ value, label: TAB_LABELS[value] }))}
              value={current}
              onChange={(value) => setRoute([{ kind: value }])}
            />
          </View>
          {wide && sorting && sorter}
        </View>
      )}
      {caption}
      {library.indexing && <Text style={s.caption}>The hub is still reading this folder. The library fills in as it goes.</Text>}
      {body}
    </View>
  );
}

export function VideoSheet({ sheet, locked, act }) {
  const { s } = useDesign();
  if (sheet.kind === "video-watch")
    return (
      <View style={s.actionGroup}>
        <ActionRow label="Details" icon="info" disabled={locked} onPress={() => act("details")} />
        <ActionRow label="Remove from Watch next" icon="circle-minus" divider disabled={locked} onPress={() => act("remove")} />
      </View>
    );
  const actions = titleActions(sheet.item, !!sheet.downloaded);
  const labels = {
    watched: ["Mark as watched", "check"],
    unwatched: ["Mark as unwatched", "eye-off"],
    "remove-download": ["Remove download", "trash"],
  };
  return (
    <>
      <View style={s.actionGroup}>
        {actions.map((name, index) => (
          <ActionRow key={name} label={labels[name][0]} icon={labels[name][1]} divider={index > 0} disabled={locked} onPress={() => act(name)} />
        ))}
      </View>
    </>
  );
}
