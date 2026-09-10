import { Section } from "./components";
import { ErrorNotice } from "./Notice";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Text, View } from "react-native";
import * as Sharing from "expo-sharing";
import {
  Button,
  Card,
  Field,
  FolderRow,
  Icon,
  Sheet,
  useDesign,
} from "./components";
import { runtime } from "./runtime";
import { bytes } from "./format";
import {
  IncomingSession,
  incomingDestination,
  incomingFilenameError,
} from "./incoming-files";

// One share operation; cancellation discards the app-owned temporary copies.
export function IncomingShare({ connection, catalog, locals, onSaved }) {
  const { s } = useDesign();
  const [items, setItems] = useState([]),
    [open, setOpen] = useState(false);
  const [volume, setVolume] = useState(null),
    [directory, setDirectory] = useState("");
  const [directories, setDirectories] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const receiving = useRef(false),
    saving = useRef(false),
    session = useRef(null);
  useEffect(() => {
    setVolume(null);
    setDirectory("");
  }, [connection?.hubId]);
  useEffect(() => {
    let active = true;
    async function receive() {
      if (receiving.current || saving.current) return;
      receiving.current = true;
      try {
        const r = await runtime();
        session.current ||= new IncomingSession(r);
        let pending;
        const raw = Sharing.getSharedPayloads();
        if (raw.length) {
          if (active) {
            setPreparing(true);
            setItems([]);
            setError("");
            setVolume(null);
            setDirectory("");
            setOpen(true);
          }
          pending = await session.current.receive(
            async () => {
              if (
                raw.some(
                  (p) =>
                    !["file", "image", "audio", "video"].includes(p.shareType),
                )
              )
                throw new Error(
                  "Share the exported file, rather than a link or text.",
                );
              return Sharing.getResolvedSharedPayloadsAsync();
            },
            `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          );
          Sharing.clearSharedPayloads();
        }
        if (active && pending?.length) {
          setVolume(null);
          setDirectory("");
          setError("");
          setItems(pending);
          setOpen(true);
        } else if (!active) await session.current.cancel();
      } catch (e) {
        Sharing.clearSharedPayloads();
        if (active) {
          setError(e.message);
          setOpen(true);
        }
      } finally {
        if (active) setPreparing(false);
        receiving.current = false;
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
    (async () => {
      const r = await runtime();
      const choices = new Set();
      if (volume && r.scope) {
        const root = r.files.folder(r.scope, volume.id);
        if (await r.files.exists(root))
          for await (const entry of r.files.walk(root)) {
            const parts = entry.path.split("/");
            if (!entry.directory) parts.pop();
            while (parts.length) {
              choices.add(parts.join("/"));
              parts.pop();
            }
          }
      }
      if (active) setDirectories([...choices].sort());
    })().catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [volume?.id, connection?.hubId]);
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
      if (!local?.selected)
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
      setOpen(false);
      setVolume(null);
      setDirectory("");
      await onSaved();
      if (!r.paused) await r.sync();
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
    try {
      await session.current?.cancel();
      setItems([]);
      setVolume(null);
      setDirectory("");
      Sharing.clearSharedPayloads();
      setOpen(false);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const destinations = locals.filter((f) => f.selected);
  const children = directories.filter(
    (p) =>
      p.startsWith(directory ? `${directory}/` : "") &&
      !p.slice(directory ? directory.length + 1 : 0).includes("/"),
  );
  return (
    <>
      {open && (
        <Sheet
          title={items.length > 1 ? "Save files" : "Save file"}
          busy={busy}
          onClose={discard}
        >
          <ErrorNotice error={error} />
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
                        onChangeText={(name) => {
                          setError("");
                          setItems((current) =>
                            current.map((entry) =>
                              entry.id === item.id ? { ...entry, name } : entry,
                            ),
                          );
                        }}
                      />
                      {!!incomingFilenameError(item.name) && (
                        <Text accessibilityRole="alert" style={s.errorText}>
                          {incomingFilenameError(item.name)}
                        </Text>
                      )}
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
              <ActivityIndicator />
              <Text style={s.text}>Preparing files…</Text>
            </View>
          )}
          {!preparing &&
            !!items.length &&
            (!connection?.hubId ? (
              <Text style={s.text}>
                Pair with your hub, then share the files again.
              </Text>
            ) : !volume ? (
              <Section>
                <Text style={s.eyebrow}>SELECTED FOLDERS</Text>
                {!destinations.length && (
                  <Text style={s.text}>
                    Select a folder in Folders, then share the files again.
                  </Text>
                )}
                <View style={s.group}>
                  {destinations.map((v, index) => (
                    <FolderRow
                      grouped
                      divider={index > 0}
                      disabled={busy}
                      key={v.id}
                      name={v.name}
                      description={`${v.files ?? 0} files · ${bytes(v.bytes)} local`}
                      onPress={() => {
                        setVolume(v);
                        setDirectory("");
                      }}
                    />
                  ))}
                </View>
              </Section>
            ) : (
              <>
                <Button
                  disabled={busy}
                  quiet
                  label="Shared folders"
                  icon="back"
                  onPress={() => setVolume(null)}
                />
                <Card>
                  <View style={s.row}>
                    <View style={s.tile}>
                      <Icon name="folders" size={16} />
                    </View>
                    <View style={[s.flex, s.stack]}>
                      <Text style={s.rowTitle}>{volume.name}</Text>
                      <Text style={s.mono}>{directory || "/"}</Text>
                    </View>
                  </View>
                </Card>
                {directory && (
                  <Button
                    disabled={busy}
                    label="Parent folder"
                    icon="back"
                    onPress={() =>
                      setDirectory(directory.split("/").slice(0, -1).join("/"))
                    }
                  />
                )}
                {!!children.length && (
                  <View style={s.group}>
                    {children.map((p, index) => (
                      <FolderRow
                        grouped
                        divider={index > 0}
                        disabled={busy}
                        key={p}
                        name={p.split("/").pop()}
                        onPress={() => setDirectory(p)}
                      />
                    ))}
                  </View>
                )}
                <Field
                  editable={!busy}
                  label="Subfolder (optional)"
                  placeholder="e.g. workouts/2026"
                  value={directory}
                  onChangeText={setDirectory}
                />
                <Text style={s.caption}>
                  Saved locally first. Upload waits when offline or paused.
                  Existing files with different content are kept separately.
                </Text>
                <Button
                  primary
                  label="Save here"
                  disabled={
                    !items.length ||
                    items.some((item) => incomingFilenameError(item.name))
                  }
                  busy={busy}
                  onPress={save}
                />
              </>
            ))}
          <Button label="Cancel" disabled={busy} onPress={discard} />
        </Sheet>
      )}
    </>
  );
}
