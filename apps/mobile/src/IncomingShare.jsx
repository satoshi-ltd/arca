import { Busy } from "./components";
import { useRetained } from "./motion";
import { galleryConfig } from "./gallery.js";
import { Eyebrow, Section } from "./components";
import { ErrorNotice } from "./Notice";
import React, { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, View } from "react-native";
import { Text } from "./Text";
import * as Sharing from "expo-sharing";
import {
  ActionRow,
  Button,
  EmptyState,
  Field,
  FolderRow,
  Icon,
  Sheet,
  SheetFooter,
  useDesign,
} from "./components";
import { runtime } from "./runtime";
import { bytes, count } from "./format";
import {
  IncomingSession,
  incomingDestination,
  incomingFilenameError,
  incomingFolderError,
  resolveShared,
  sharedKey,
  shareTurn,
  stallGuard,
} from "./incoming-files";
import { native } from "./private-network";
import {
  loadDestinations,
  otherDestinations,
  placeLabel,
  saveDestination,
  startingDestination,
} from "./share-destinations";

// One share operation; cancellation discards the app-owned temporary copies.
export function IncomingShare({ connection, locals, onSaved, onChoose }) {
  const { s } = useDesign();
  const [items, setItems] = useState([]),
    [open, setOpen] = useState(false);
  const [shownOpen, releaseOpen] = useRetained(open);
  const [volume, setVolume] = useState(null),
    [directory, setDirectory] = useState("");
  const [directories, setDirectories] = useState([]),
    [filePaths, setFilePaths] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [parked, setParked] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [recent, setRecent] = useState([]);
  const [place, setPlace] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [naming, setNaming] = useState(null);
  const receiving = useRef(""),
    owned = useRef(""),
    saving = useRef(false),
    session = useRef(null),
    attempt = useRef(0);
  useEffect(() => {
    setVolume(null);
    setDirectory("");
    setPlace(null);
    setNaming(null);
    setRecent([]);
  }, [connection?.hubId]);
  // A newer share may already be stored when an older run ends: clear only the share that run handled.
  const clearShare = (key) => {
    let stored = key;
    try {
      stored = sharedKey(Sharing.getSharedPayloads());
    } catch {}
    if (stored === key) Sharing.clearSharedPayloads();
  };
  useEffect(() => {
    let active = true;
    async function receive() {
      if (saving.current) return;
      let raw = [];
      let unreadable = null;
      try {
        raw = Sharing.getSharedPayloads();
      } catch (e) {
        unreadable = e;
      }
      const turn = shareTurn(receiving.current, raw);
      if (turn === "ignore" && !unreadable) return;
      if (turn === "replace" || (unreadable && receiving.current))
        await session.current?.cancel().catch(() => {});
      const key = sharedKey(raw);
      receiving.current = key;
      owned.current = key;
      const current = ++attempt.current;
      const superseded = () => current !== attempt.current;
      try {
        if (unreadable) throw unreadable;
        const r = await runtime();
        session.current ||= new IncomingSession(r);
        let pending;
        if (raw.length) {
          if (active) {
            setPreparing(true);
            setItems([]);
            setError("");
            setVolume(null);
            setDirectory("");
            setPlace(null);
            setNaming(null);
            setOpen(true);
          }
          const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          pending = await session.current.receive(async () => {
            if (Platform.OS === "android")
              return resolveShared(
                r,
                (uri, destination) => native.receiveShared(uri, destination),
                raw,
                id,
              );
            if (
              raw.some(
                (p) =>
                  !["file", "image", "audio", "video"].includes(p.shareType),
              )
            )
              throw new Error(
                "Share the exported file, rather than a link or text.",
              );
            return stallGuard(Sharing.getResolvedSharedPayloadsAsync(), async () => 0, {
              startMs: 120000,
            });
          }, id);
          if (superseded()) return;
          clearShare(key);
        }
        if (active && pending?.length) {
          setVolume(null);
          setDirectory("");
          setPlace(null);
          setNaming(null);
          setError("");
          setItems(pending);
          setOpen(true);
        } else if (!active) await session.current.cancel();
      } catch (e) {
        if (superseded()) return;
        if (unreadable) Sharing.clearSharedPayloads();
        else clearShare(key);
        if (active) {
          setError(e.message);
          setOpen(true);
        }
      } finally {
        if (!superseded()) {
          if (active) setPreparing(false);
          receiving.current = "";
        }
      }
    }
    receive();
    const state = AppState.addEventListener("change", (value) => {
      if (value === "active") receive();
    });
    const link = Linking.addEventListener("url", receive);
    return () => {
      active = false;
      state.remove();
      link.remove();
      session.current?.cancel().catch(() => {});
    };
  }, []);
  useEffect(() => {
    let active = true;
    setDirectories([]);
    setFilePaths([]);
    (async () => {
      const r = await runtime();
      const choices = new Set();
      const taken = [];
      const target = place?.folder || volume;
      if (target && r.scope) {
        const root = r.files.folder(r.scope, target.id);
        if (await r.files.exists(root))
          for await (const entry of r.files.walk(root)) {
            const parts = entry.path.split("/");
            if (!entry.directory) {
              taken.push(entry.path);
              parts.pop();
            }
            while (parts.length) {
              choices.add(parts.join("/"));
              parts.pop();
            }
          }
      }
      if (active) {
        setDirectories([...choices].sort());
        setFilePaths(taken);
      }
    })().catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [(place?.folder || volume)?.id, connection?.hubId]);
  useEffect(() => {
    setLoaded(false);
    if (!open) return;
    let active = true;
    (async () => {
      const r = await runtime();
      const choices = locals.filter((f) => !!f.selected && !galleryConfig(f));
      const entries =
        r.scope && r.scope === connection?.hubId
          ? await loadDestinations(r.store, r.scope, choices)
          : [];
      if (!active) return;
      setRecent(entries);
      setLoaded(true);
    })().catch(() => {
      if (!active) return;
      setRecent([]);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [open, connection?.hubId, locals]);
  async function save() {
    if (saving.current || !volume || !connection?.hubId) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await runtime();
      if (r.scope !== connection.hubId)
        throw new Error("The hub changed. Choose the destination again.");
      for (const item of items) incomingDestination(directory, item.name);
      r.stop();
      if (r.active) await r.active;
      const local = await r.store.folder(r.scope, volume.id);
      if (!local?.selected || galleryConfig(local))
        throw new Error(
          "This folder is no longer selected. Choose a folder syncing on this device.",
        );
      r.importing = true;
      try {
        for (const item of items) {
          await r.importFile(
            volume.id,
            incomingDestination(directory, item.name),
            item.uri,
          );
          setItems(await session.current.saved(item));
        }
      } finally {
        r.importing = false;
      }
      await saveDestination(
        r.store,
        r.scope,
        destinations,
        volume.id,
        directory,
      ).catch(() => {});
      const saved = { count: items.length, folder: volume, directory };
      setOpen(false);
      setPlace(null);
      setVolume(null);
      setDirectory("");
      await onSaved(saved);
      if (!r.paused) r.sync().catch((e) => setError(e.message));
    } catch (e) {
      setError(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function discard() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    attempt.current++;
    receiving.current = "";
    setPreparing(false);
    setParked(false);
    try {
      await session.current?.cancel();
      setItems([]);
      setPlace(null);
      setVolume(null);
      setDirectory("");
      clearShare(owned.current);
      setOpen(false);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const destinations = locals.filter((f) => !!f.selected && !galleryConfig(f));
  useEffect(() => {
    if (!open || !loaded || volume) return;
    const start = startingDestination(recent, destinations);
    if (!start) return;
    setVolume(start.folder);
    setDirectory(start.directory);
  }, [open, loaded, volume, recent, destinations.map((f) => f.id).join("\0")]);
  useEffect(() => {
    if (parked && destinations.length && items.length) {
      setParked(false);
      setOpen(true);
    }
  }, [parked, destinations.length]);
  const at = place?.directory || "";
  const children = directories.filter(
    (p) =>
      p.startsWith(at ? `${at}/` : "") &&
      !p.slice(at ? at.length + 1 : 0).includes("/"),
  );
  const saveLabel = `Save ${count(items.length, "file", "files")}`;
  const named = naming?.trim() || "";
  const nameError =
    naming == null || !named
      ? ""
      : incomingFolderError(
          named,
          children.map((p) => p.split("/").pop()),
          filePaths.filter((p) => p.slice(0, p.lastIndexOf("/") + 1) === (at ? `${at}/` : "")).map((p) => p.split("/").pop()),
        );
  const back = () =>
    place.directory
      ? setPlace({ ...place, directory: place.directory.split("/").slice(0, -1).join("/") })
      : setPlace(null);
  const choose = (folder, directory) => {
    setVolume(folder);
    setDirectory(directory);
    setPlace(null);
  };
  return (
    <>
      {shownOpen && (
        <Sheet
          closing={!open}
          onExited={releaseOpen}
          {...(place
            ? { title: "Save to", subtitle: placeLabel(place.folder, place.directory), onBack: back }
            : { title: items.length > 1 ? "Save files" : "Save file", icon: "download" })}
          busy={busy}
          onClose={discard}
        >
          <ErrorNotice error={error} />
          {place ? (
            <>
              {!!otherDestinations(recent, place.folder.id, place.directory).length && (
                <Section>
                  <Eyebrow>Recent</Eyebrow>
                  <View style={s.group}>
                    {otherDestinations(recent, place.folder.id, place.directory).map((entry, index) => (
                      <FolderRow
                        grouped
                        divider={index > 0}
                        disabled={busy}
                        key={`${entry.volume}:${entry.directory}`}
                        icon="history"
                        name={entry.folder.name}
                        description={entry.directory || undefined}
                        onPress={() => choose(entry.folder, entry.directory)}
                      />
                    ))}
                  </View>
                </Section>
              )}
              <View style={s.group}>
                {!at &&
                  destinations
                    .filter((v) => v.id !== place.folder.id)
                    .map((v, index) => (
                      <FolderRow
                        grouped
                        divider={index > 0}
                        disabled={busy}
                        key={v.id}
                        name={v.name}
                        onPress={() => setPlace({ folder: v, directory: "" })}
                      />
                    ))}
                {children.map((p, index) => (
                  <FolderRow
                    grouped
                    divider={index > 0 || (!at && destinations.some((f) => f.id !== place.folder?.id))}
                    disabled={busy}
                    key={p}
                    icon="folder"
                    name={p.split("/").pop()}
                    onPress={() => setPlace({ ...place, directory: p })}
                  />
                ))}
                <ActionRow
                  label="New folder…"
                  icon="folder-plus"
                  divider={!!children.length || (!at && destinations.some((f) => f.id !== place.folder?.id))}
                  disabled={busy}
                  onPress={() => setNaming("")}
                />
              </View>
              <SheetFooter>
                <Button
                  primary
                  label="Save here"
                  icon="check"
                  disabled={busy}
                  onPress={() => choose(place.folder, place.directory)}
                />
              </SheetFooter>
            </>
          ) : (
            <>
              {!!items.length && (
                <View style={s.group}>
                  {items.map((item, index) => (
                    <View
                      key={item.id}
                      style={[s.folderRow, index > 0 && s.separator]}
                    >
                      <Icon name="file" size={20} />
                      {item.renameRequired ? (
                        <View style={s.flex}>
                          <Field
                            label="File name"
                            value={item.name}
                            editable={!busy}
                            autoCapitalize="none"
                            autoCorrect={false}
                            error={incomingFilenameError(item.name)}
                            onChangeText={(name) => {
                              setError("");
                              setItems((current) =>
                                current.map((entry) =>
                                  entry.id === item.id ? { ...entry, name } : entry,
                                ),
                              );
                            }}
                          />
                        </View>
                      ) : (
                        <Text style={[s.rowTitle, s.flex]}>{item.name}</Text>
                      )}
                      <Text style={s.caption}>{bytes(item.size)}</Text>
                    </View>
                  ))}
                </View>
              )}
              {preparing && (
                <View style={s.row} accessibilityLiveRegion="polite">
                  <Busy />
                  <Text style={s.text}>Preparing files…</Text>
                </View>
              )}
              {!preparing &&
                !!items.length &&
                (!connection?.hubId ? (
                  <Text style={s.text}>
                    Pair with your hub, then share the files again.
                  </Text>
                ) : !destinations.length ? (
                  <EmptyState
                    icon="folders"
                    title="No folder to save into"
                    text="Start syncing a folder in Folders. The shared files wait here."
                    action={
                      <Button
                        label="Open Folders"
                        onPress={() => {
                          setParked(true);
                          setOpen(false);
                          onChoose?.();
                        }}
                      />
                    }
                  />
                ) : (
                  !!volume && (
                    <>
                      <Section>
                        <Eyebrow>Save to</Eyebrow>
                        <View style={[s.group, s.folderRow]}>
                          <View style={s.tile}>
                            <Icon name="folder" size={16} />
                          </View>
                          <View style={[s.flex, s.stack]}>
                            <Text numberOfLines={1} style={s.rowTitle}>{volume.name}</Text>
                            {!!directory && <Text numberOfLines={1} style={s.caption}>{directory}</Text>}
                          </View>
                          <Button
                            ghost
                            size="small"
                            label="Change"
                            disabled={busy}
                            onPress={() => setPlace({ folder: volume, directory })}
                          />
                        </View>
                      </Section>
                      <Text style={s.caption}>Saved on this phone first, then uploaded.</Text>
                      <SheetFooter>
                        <Button
                          primary
                          label={saveLabel}
                          icon="download"
                          disabled={
                            !items.length ||
                            items.some((item) => incomingFilenameError(item.name))
                          }
                          busy={busy}
                          onPress={save}
                        />
                      </SheetFooter>
                    </>
                  )
                ))}
            </>
          )}
          {naming != null && (
            <Sheet title="New folder" icon="folder-plus" onClose={() => setNaming(null)}>
              <Field
                label="Folder name"
                value={naming}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                error={nameError}
                onChangeText={setNaming}
              />
              <SheetFooter>
                <Button
                  primary
                  label="Create folder"
                  disabled={!named || !!nameError}
                  onPress={() => {
                    const directory = place.directory ? `${place.directory}/${named}` : named;
                    setDirectories((current) => [...new Set([...current, directory])].sort());
                    setPlace({ ...place, directory });
                    setNaming(null);
                  }}
                />
              </SheetFooter>
            </Sheet>
          )}
        </Sheet>
      )}
    </>
  );
}
