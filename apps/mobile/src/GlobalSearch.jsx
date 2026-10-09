import React, { useEffect, useMemo, useState } from "react";
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Icon, useDesign } from "./components";
import { FilePreview } from "./FilePreview";
import { fileIcon } from "../../desktop/src/file-icons.js";
import { bytes } from "./format";

const SCOPES = [
  ["all", "All"],
  ["files", "Files"],
  ["photos", "Photos"],
  ["music", "Music"],
];

function Row({ icon, title, subtitle, active, onPress, trailing, cover }) {
  const { s, c } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      onPress={onPress}
      style={[s.searchRow, active && s.historyRowChosen]}
    >
      {cover ? (
        <Image source={{ uri: cover }} resizeMethod="resize" style={s.searchCover} />
      ) : (
        <View style={s.tile}>
          <Icon name={icon} size={16} color={c.accent} />
        </View>
      )}
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
      {trailing}
    </Pressable>
  );
}

export function GlobalSearch({ visible, twoPane, search, recents, onForget, actions, onOpen, onClose, uri, cover, files }) {
  const { s, c } = useDesign();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (!visible) {
      setQuery("");
      setScope("all");
      setResults(null);
      setSelected(0);
    }
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const found = await search(query, scope);
        if (live) {
          setResults(found);
          setSelected(0);
        }
      } catch {
        if (live) setResults({ folders: [], files: [], photos: [], music: [], counts: {} });
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, scope, visible]);
  const flat = useMemo(() => {
    if (!results) return [];
    return [
      ...results.folders.map((r) => ({ type: "folder", ...r })),
      ...results.files.map((r) => ({ type: "file", ...r })),
      ...results.photos.map((r) => ({ type: "photo", ...r })),
      ...results.music.map((r) => ({ type: "music", ...r })),
    ];
  }, [results]);
  const chosen = flat[selected];
  const quickActions = query.trim().length >= 2 && scope === "all" ? actions.filter((a) => a.label.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const group = (label, count, children) =>
    children && (
      <View key={label} style={s.searchGroup}>
        <View style={s.searchLabel}>
          <Text style={s.eyebrow}>{label.toUpperCase()}</Text>
          {!!count && <Text style={s.eyebrow}>{count}</Text>}
        </View>
        {children}
      </View>
    );
  const open = (item) => onOpen(item, query);
  const list = (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.searchBody}>
      {!query.trim() && (
        <>
          {!!recents.length &&
            group(
              "Recent searches",
              0,
              recents.map((text) => (
                <Row
                  key={text}
                  icon="clock"
                  title={text}
                  onPress={() => setQuery(text)}
                  trailing={
                    <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${text}`} onPress={() => onForget(text)} style={s.searchForget}>
                      <Icon name="close" size={16} color={c.mute} />
                    </Pressable>
                  }
                />
              )),
            )}
          {group(
            "Actions",
            0,
            actions.map((action) => (
              <Row key={action.name} icon={action.icon} title={action.label} onPress={() => onOpen({ type: "action", ...action }, "")} />
            )),
          )}
        </>
      )}
      {!!query.trim() && results && !flat.length && !quickActions.length && (
        <View style={s.searchEmpty}>
          <Icon name="search" size={24} color={c.mute} />
          <Text style={s.heading}>{`No matches for “${query.trim()}”`}</Text>
          <Text style={s.caption}>Search covers file names, photos and music held on this phone.</Text>
        </View>
      )}
      {!!results && (
        <>
          {group("Folders", results.counts.folders, results.folders.length ? results.folders.map((r, i) => <Row key={r.id} icon="folders" title={r.name} active={twoPane && selected === i} onPress={() => (twoPane ? setSelected(i) : open({ type: "folder", ...r }))} />) : null)}
          {group(
            "Files",
            results.counts.files,
            results.files.length
              ? results.files.map((r, i) => {
                  const index = results.folders.length + i;
                  return <Row key={`${r.volume}:${r.path}`} icon={fileIcon(r.path)} title={r.name} subtitle={`${r.folder} · ${bytes(r.size || 0)}`} active={twoPane && selected === index} onPress={() => (twoPane ? setSelected(index) : open({ type: "file", ...r }))} />;
                })
              : null,
          )}
          {group(
            "Photos",
            results.counts.photos,
            results.photos.length ? (
              <View style={s.searchThumbs}>
                {results.photos.slice(0, 4).map((r, i) => {
                  const index = results.folders.length + results.files.length + i;
                  const source = uri(r);
                  return (
                    <Pressable key={`${r.volume}:${r.path}`} accessibilityRole="button" accessibilityLabel={r.name} onPress={() => (twoPane ? setSelected(index) : open({ type: "photo", ...r }))} style={[s.searchThumb, twoPane && selected === index && s.searchThumbChosen]}>
                      {source ? <Image source={{ uri: source }} resizeMethod="resize" style={s.searchThumbImage} /> : <Icon name={r.kind === "video" ? "play" : "gallery"} color={c.mute} />}
                    </Pressable>
                  );
                })}
              </View>
            ) : null,
          )}
          {group(
            "Music",
            results.counts.music,
            results.music.length
              ? results.music.map((r, i) => {
                  const index = results.folders.length + results.files.length + results.photos.length + i;
                  return <Row key={`${r.volume}:${r.path}`} icon="music" cover={r.cover ? cover(r.cover) : null} title={r.title || r.name} subtitle={[r.artist, r.album].filter(Boolean).join(" · ") || r.folder} active={twoPane && selected === index} onPress={() => (twoPane ? setSelected(index) : open({ type: "music", ...r }))} />;
                })
              : null,
          )}
        </>
      )}
      {!!quickActions.length && group("Actions", 0, quickActions.map((action) => <Row key={action.name} icon={action.icon} title={action.label} onPress={() => onOpen({ type: "action", ...action }, "")} />))}
    </ScrollView>
  );
  const pane =
    twoPane && chosen && chosen.type !== "folder" ? (
      <View style={s.searchPane}>
        <FilePreview entry={{ path: chosen.path, uri: uri(chosen), size: chosen.size }} files={files} />
        <Text style={s.heading}>{chosen.name}</Text>
        <Text style={s.caption}>{chosen.folder}</Text>
        <Button label={chosen.type === "music" ? "Open details" : "Open"} onPress={() => open(chosen)} />
      </View>
    ) : null;
  return (
    <Modal visible={visible} animationType="fade" transparent={twoPane} onRequestClose={onClose}>
      <SafeAreaView style={twoPane ? s.searchBackdrop : s.searchScreen}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={twoPane ? s.searchDialog : s.searchFull}>
          <View style={s.searchField}>
            <Icon name="search" color={c.mute} />
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
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
          <View style={s.searchChips}>
            {SCOPES.map(([id, label]) => (
              <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: scope === id }} onPress={() => setScope(id)} style={[s.searchChip, scope === id && s.searchChipOn]}>
                <Text style={[s.caption, scope === id && s.searchChipText]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={twoPane ? s.searchSplit : s.flex}>
            <View style={s.flex}>{list}</View>
            {pane}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
