import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Icon, useDesign } from "./components";
import { FilePreview } from "./FilePreview";
import { fileIcon } from "../../desktop/src/file-icons.js";
import { formatDay } from "./music-library";
import { useMotion } from "./motion";
import { motion } from "./design-tokens.js";
import { SEARCH_LABELS, searchCanReveal, searchItems, searchSubtitle, searchTitle, searchVerb, searchViewAction } from "./search-local";

const AnimatedKeyboardView = Animated.createAnimatedComponent(KeyboardAvoidingView);
const LEAD = { recent: "clock", folder: "folders", song: "music", album: "album", artist: "artist", show: "podcast", episode: "podcast", playlist: "playlist", period: "gallery", more: "more", page: "more" };

function Lead({ item, cover }) {
  const { s, c } = useDesign();
  const art = cover && ["song", "album", "artist", "show", "episode"].includes(item.type) && item.cover ? cover(item.cover) : null;
  if (art) return <Image source={{ uri: art }} resizeMethod="resize" style={[s.searchCover, item.type === "artist" && s.searchCoverRound]} />;
  return (
    <View style={[s.tile, item.type === "artist" && s.searchCoverRound]}>
      <Icon name={LEAD[item.type] || item.icon || fileIcon(item.path || "")} size={16} color={c.accent} />
    </View>
  );
}

function Row({ item, subtitle, active, onPress, onLongPress, trailing, cover }) {
  const { s, c } = useDesign();
  const title = searchTitle(item);
  const kind = SEARCH_LABELS[item.of]?.[2] || "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[item.type === "more" || item.type === "page" ? "" : kind, title, subtitle].filter(Boolean).join(", ")}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[s.searchRow, active && s.historyRowChosen]}
    >
      <Lead item={item} cover={cover} />
      <View style={[s.flex, s.stack]}>
        <Text numberOfLines={1} style={s.rowTitle}>
          {title}
        </Text>
        {!!subtitle && (
          <Text numberOfLines={1} style={s.caption}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing === undefined ? <Icon name="chevron" size={16} color={c.mute} /> : trailing}
    </Pressable>
  );
}

export function GlobalSearch({ visible, twoPane, search, recents, onForget, actions, onOpen, onClose, uri, cover, files, folderFiles, timeLeft, describe }) {
  const { s, c } = useDesign();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState(0);
  const [held, setHeld] = useState(null);
  const { duration, easing } = useMotion();
  const fade = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(fade, {
      toValue: visible ? 1 : 0,
      duration: duration(visible ? motion.enter : motion.exit),
      easing,
      useNativeDriver: true,
    }).start(({ finished }) => finished && !visible && setMounted(false));
  }, [visible]);
  useEffect(() => {
    if (!mounted) {
      setQuery("");
      setType("");
      setResults(null);
      setSelected(0);
      setHeld(null);
    }
  }, [mounted]);
  useEffect(() => {
    if (!visible) return;
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const found = await search(query, type, 0);
        if (live) {
          setResults(found);
          setSelected(0);
        }
      } catch {
        if (live) setResults({ groups: [] });
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, type, visible]);
  const items = useMemo(() => searchItems(results, type), [results, type]);
  const subtitle = (item) => searchSubtitle(item, { files: folderFiles(item.id), left: item.type === "episode" ? timeLeft(item) : null });
  const chosen = items[selected];
  const quickActions = query.trim().length >= 2 && !type ? actions.filter((a) => a.label.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const more = async () => {
    const loaded = results?.groups?.[0];
    if (!loaded) return;
    const next = await search(query, type, loaded.rows.length).catch(() => null);
    const page = next?.groups?.[0];
    if (page) setResults({ groups: [{ ...page, rows: [...loaded.rows, ...page.rows] }] });
  };
  const open = (item, mode = "default") => {
    if (item.type === "more") {
      setType(item.of);
      return;
    }
    if (item.type === "page") return void more();
    setHeld(null);
    onOpen(item, query, mode);
  };
  const press = (item, index) => {
    if (twoPane && !["song", "episode", "more", "page"].includes(item.type)) setSelected(index);
    else open(item);
  };
  const hold = (item) => {
    if (item.type !== "more" && item.type !== "page") setHeld(item);
  };
  const groups = [];
  items.forEach((item, index) => {
    if (groups.at(-1)?.label !== item.group) groups.push({ label: item.group, count: item.count, entries: [] });
    groups.at(-1).entries.push([item, index]);
  });
  const header = (label, count) => (
    <View style={s.searchLabel}>
      <Text style={s.eyebrow}>{label.toUpperCase()}</Text>
      {!!count && <Text style={s.eyebrow}>{count}</Text>}
    </View>
  );
  const list = (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.searchBody}>
      {!query.trim() && !type && (
        <>
          {!!recents.length && (
            <View style={s.searchGroup}>
              {header("Recent searches", 0)}
              {recents.map((text) => (
                <Row
                  key={text}
                  item={{ type: "recent", title: text }}
                  onPress={() => setQuery(text)}
                  trailing={
                    <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${text}`} onPress={() => onForget(text)} style={s.searchForget}>
                      <Icon name="close" size={16} color={c.mute} />
                    </Pressable>
                  }
                />
              ))}
            </View>
          )}
          <View style={s.searchGroup}>
            {header("Actions", 0)}
            {actions.map((action) => (
              <Row key={action.name} item={{ type: "action", title: action.label, icon: action.icon }} trailing={null} onPress={() => onOpen({ type: "action", ...action }, "")} />
            ))}
          </View>
        </>
      )}
      {!!query.trim() && results && !items.length && !quickActions.length && (
        <View style={s.searchEmpty}>
          <Icon name="search" size={24} color={c.mute} />
          <Text style={s.heading}>{`No matches for “${query.trim()}”`}</Text>
          <Text style={s.caption}>Search covers folders, files, photos, music and podcasts held on this phone.</Text>
        </View>
      )}
      {groups.map((group) => {
        const cells = group.entries.filter(([item]) => item.type === "photo");
        return (
          <View key={group.label} style={s.searchGroup}>
            {header(group.label, group.count)}
            {group.entries
              .filter(([item]) => item.type !== "photo" && item.type !== "more" && item.type !== "page")
              .map(([item, index]) => (
                <Row
                  key={`${item.type}:${item.volume || ""}:${item.id || item.path || item.month}`}
                  item={item}
                  subtitle={subtitle(item)}
                  cover={cover}
                  active={twoPane && selected === index}
                  trailing={item.type === "song" || item.type === "episode" ? <Icon name="play" size={16} color={c.accent} /> : undefined}
                  onPress={() => press(item, index)}
                  onLongPress={() => hold(item)}
                />
              ))}
            {!!cells.length && (
              <View style={s.searchThumbs}>
                {cells.map(([item, index]) => {
                  const source = uri(item);
                  const day = formatDay((item.date || "").slice(0, 10));
                  return (
                    <Pressable
                      key={`${item.volume}:${item.path}`}
                      accessibilityRole="button"
                      accessibilityLabel={["Photo", day || item.name, item.folder].join(", ")}
                      onPress={() => press(item, index)}
                      onLongPress={() => hold(item)}
                      style={s.searchCell}
                    >
                      <View style={[s.searchThumb, twoPane && selected === index && s.searchThumbChosen]}>
                        {source ? <Image source={{ uri: source }} resizeMethod="resize" style={s.searchThumbImage} /> : <Icon name={item.kind === "video" ? "play" : "gallery"} color={c.mute} />}
                      </View>
                      <Text numberOfLines={1} style={s.caption}>
                        {day || item.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {group.entries
              .filter(([item]) => item.type === "more" || item.type === "page")
              .map(([item]) => (
                <Row key={item.type} item={item} cover={cover} trailing={null} onPress={() => open(item)} />
              ))}
          </View>
        );
      })}
      {!!quickActions.length && (
        <View style={s.searchGroup}>
          {header("Actions", 0)}
          {quickActions.map((action) => (
            <Row key={action.name} item={{ type: "action", title: action.label, icon: action.icon }} trailing={null} onPress={() => onOpen({ type: "action", ...action }, "")} />
          ))}
        </View>
      )}
    </ScrollView>
  );
  const shown = twoPane && chosen && !["more", "page"].includes(chosen.type) ? chosen : null;
  const about = shown && ["album", "show", "playlist", "artist"].includes(shown.type) ? describe(shown) : null;
  const pane = shown ? (
    <View style={s.searchPane}>
      {shown.type === "photo" || shown.type === "file" ? (
        <FilePreview entry={{ path: shown.path, uri: uri(shown), size: shown.size }} files={files} />
      ) : about ? (
        <Image source={{ uri: about.cover || undefined }} resizeMethod="resize" style={s.searchPaneCover} />
      ) : null}
      <Text style={s.heading}>{searchTitle(shown)}</Text>
      <Text style={s.caption}>{subtitle(shown)}</Text>
      {about?.rows.slice(0, 6).map((row) => (
        <View key={row.key} style={s.searchPaneRow}>
          <Text style={s.caption}>{row.number}</Text>
          <Text numberOfLines={1} style={[s.text, s.flex]}>
            {row.title}
          </Text>
          <Text style={s.caption}>{row.length}</Text>
        </View>
      ))}
      <Button primary label={searchVerb(shown)} onPress={() => open(shown)} />
      {(shown.type === "album" || shown.type === "show" || shown.type === "playlist") && <Button label="Play" icon="play" onPress={() => open(shown, "play")} />}
      {searchCanReveal(shown) && <Button label="Show in folder" icon="folder-open" onPress={() => open(shown, "reveal")} />}
    </View>
  ) : null;
  const sheet = held ? (
    <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setHeld(null)} style={s.searchSheetBackdrop}>
      <Pressable style={s.searchSheet}>
        <Row item={held} subtitle={subtitle(held)} cover={cover} trailing={null} onPress={() => setHeld(null)} />
        <Button label={searchVerb(held, !!timeLeft(held))} icon={held.type === "song" || held.type === "episode" ? "play" : "chevron"} onPress={() => open(held)} />
        {!!searchViewAction(held) && <Button label={searchViewAction(held)} icon={held.type === "song" ? "album" : "podcast"} onPress={() => open(held, "view")} />}
        {searchCanReveal(held) && <Button label="Show in folder" icon="folder-open" onPress={() => open(held, "reveal")} />}
      </Pressable>
    </Pressable>
  ) : null;
  return (
    <Modal visible={mounted} animationType="none" transparent onRequestClose={() => (held ? setHeld(null) : onClose())}>
      <Animated.View style={[s.flex, { opacity: fade }]} pointerEvents={visible ? "auto" : "none"}>
      <SafeAreaView style={twoPane ? s.searchBackdrop : s.searchScreen}>
        <AnimatedKeyboardView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={[
            twoPane ? s.searchDialog : s.searchFull,
            {
              transform: twoPane
                ? [{ scale: fade.interpolate({ inputRange: [0, 1], outputRange: [motion.dialogScale, 1] }) }]
                : [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [motion.distance, 0] }) }],
            },
          ]}
        >
          <View style={s.searchField}>
            <Icon name="search" color={c.mute} />
            {!!type && (
              <View style={s.searchChip}>
                <Text style={s.searchChipText}>{SEARCH_LABELS[type][0]}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${SEARCH_LABELS[type][0]} filter`} onPress={() => setType("")} style={s.searchChipRemove}>
                  <Icon name="close" size={14} color={c.okFg} />
                </Pressable>
              </View>
            )}
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === "Backspace" && !query && type) setType("");
              }}
              placeholder="Search Arca"
              placeholderTextColor={c.mute}
              accessibilityLabel="Search Arca"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={s.searchInput}
            />
            {!!query && (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery("")} style={s.searchForget}>
                <Icon name="close" size={16} color={c.mute} />
              </Pressable>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel search" onPress={onClose} style={s.searchCancel}>
              <Text style={s.heading}>Cancel</Text>
            </Pressable>
          </View>
          <View style={twoPane ? s.searchSplit : s.flex}>
            <View style={s.flex}>{list}</View>
            {pane}
          </View>
          {sheet}
        </AnimatedKeyboardView>
      </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}
