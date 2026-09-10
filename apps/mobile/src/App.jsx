import { Onboarding } from "./Onboarding";
import { selectFirstFolders } from "./onboarding";
import {
  scopedActivity,
  historyFolderIds,
} from "../../../packages/core/scoped-activity.js";
import {
  KeyboardPane,
  KeyboardScrollView,
  useKeyboardVisible,
} from "./KeyboardPane";
import React, { useEffect, useState, useMemo, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  AppState,
  BackHandler,
  Alert,
  useColorScheme,
  ActivityIndicator,
  Platform,
  StatusBar,
  useWindowDimensions,
  Dimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { InstrumentSans_400Regular } from "@expo-google-fonts/instrument-sans/400Regular";
import { InstrumentSans_600SemiBold } from "@expo-google-fonts/instrument-sans/600SemiBold";
import { FragmentMono_400Regular } from "@expo-google-fonts/fragment-mono/400Regular";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { palettes, styles } from "./theme";
import {
  Design,
  Breadcrumbs,
  FolderRow,
  Navigation,
  MachineRow,
  ActionRow,
  SettingsGroup,
  SegmentedControl,
  Icon,
  Logo,
  Button,
  Field,
  Card,
  Tag,
  Toggle,
  Sheet,
} from "./components";
import { client } from "./persistence";
import { isPickerCancelled } from "./action-errors.js";
import {
  runtime,
  subscribe,
  setBackground,
  setNotifications,
  destroyReplica,
} from "./runtime";
import config from "../app.json";
import { HubConnection } from "./HubConnection";
import { FileHistory } from "./FileHistory";
import { IncomingShare } from "./IncomingShare";
import { FolderRecent } from "./FolderRecent";
import { sidebarLayout } from "./layout";
import { bytes } from "./format";
import { browseEntries } from "./browse";
// Keep the native launch surface until fonts and local startup are ready.
SplashScreen.preventAutoHideAsync().catch(() => {});
const relative = (value) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return seconds < 60
    ? "just now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} min ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)} h ago`
        : date(value);
};
const date = (value) =>
  value
    ? new Date(value).toLocaleString("en", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    : "No completed sync yet";
const tabs = ["Folders", "Machines", "History", "Settings"];
function confirm(title, message, action, label = title) {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: label, onPress: action },
  ]);
}
export default function App() {
  const system = useColorScheme();
  const [prefs, setPrefs] = useState({});
  const c =
    palettes[
      (prefs.theme === "system" || !prefs.theme ? system : prefs.theme) ===
      "dark"
        ? "dark"
        : "light"
    ];
  const { width, height, fontScale } = useWindowDimensions();
  const keyboardVisible = useKeyboardVisible();
  const layout = useRef(false);
  layout.current = sidebarLayout(
    layout.current,
    width,
    keyboardVisible ? Dimensions.get("screen").height : height,
  );
  const wide = layout.current;
  const compact = wide && width < 1100;
  const s = useMemo(
    () => styles(c, wide, compact, fontScale),
    [c, wide, compact, fontScale],
  );
  const [fonts, fontError] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_600SemiBold,
    FragmentMono_400Regular,
  });
  const engine = useRef(null),
    action = useRef(false),
    mounted = useRef(true),
    fileRequest = useRef(0);
  const [state, setState] = useState(client.state()),
    [view, setView] = useState("Folders"),
    [locals, setLocals] = useState([]),
    [machines, setMachines] = useState(null),
    [status, setStatus] = useState({}),
    [busy, setBusy] = useState(false),
    [actionLabel, setActionLabel] = useState(""),
    [success, setSuccess] = useState(""),
    [error, setError] = useState(""),
    [address, setAddress] = useState(""),
    [code, setCode] = useState(""),
    [name, setName] = useState(Platform.OS === "ios" ? "iPhone" : "Android");
  const [folder, setFolder] = useState(null),
    [entries, setEntries] = useState([]),
    [search, setSearch] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [fileView, setFileView] = useState("files"),
    [sheet, setSheet] = useState(null),
    [deviceName, setDeviceName] = useState(null),
    [history, setHistory] = useState({ versions: [], next: null }),
    [historyLoading, setHistoryLoading] = useState(false),
    [historyError, setHistoryError] = useState(""),
    [historyVolume, setHistoryVolume] = useState(""),
    [historyFilter, setHistoryFilter] = useState("revisions"),
    [dismissedError, setDismissedError] = useState("");
  const historyRequest = useRef(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [fileHistory, setFileHistory] = useState({ versions: [], next: null });
  async function update() {
    const r = engine.current;
    if (!r || !mounted.current) return;
    const [folders, last, notifications, background, theme, free] =
      await Promise.all([
        r.scope ? r.store.folders(r.scope) : [],
        r.store.get(`lastSync:${r.scope}`),
        r.store.get("notifications", false),
        r.store.get("background", false),
        r.store.get("theme", "system"),
        r.files.free(),
      ]);
    if (!mounted.current) return;
    setState(client.state());
    setLocals(folders);
    setStatus({
      busy: r.busy,
      paused: r.paused,
      progress: r.progress,
      error: r.error,
      last,
      free,
    });
    setPrefs({
      notifications,
      background,
      theme,
      onboarding: await r.store.get("onboarding"),
    });
  }
  async function listFiles(id = folder?.id) {
    if (!id) return;
    const request = ++fileRequest.current;
    const r = engine.current;
    const scope = r.scope;
    const list = [];
    const root = r.files.folder(r.scope, id);
    if (await r.files.exists(root))
      for await (const e of r.files.walk(root)) list.push(e);
    if (mounted.current && request === fileRequest.current && scope === r.scope)
      setEntries(list.sort((a, b) => a.path.localeCompare(b.path)));
  }
  const retryAction = useRef(null);
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(""), 4000);
    return () => clearTimeout(timer);
  }, [success]);
  async function run(work, options = {}) {
    if (action.current) {
      if (options.silent) return;
      Alert.alert(
        "Action in progress",
        "Wait for the current action to finish, then try again.",
      );
      return;
    }
    action.current = true;
    retryAction.current = null;
    setBusy(true);
    setActionLabel(options.silent ? "" : options.label || "Working…");
    setSuccess("");
    setDismissedError("");
    setError("");
    try {
      if (!options.destroy) await engine.current?.requireActiveReplica();
      await work();
      if (options.success) setSuccess(options.success);
    } catch (e) {
      if (isPickerCancelled(e)) return;
      retryAction.current = () => run(work, options);
      const message = e.message || "Could not complete this action.";
      retryAction.current.message = message;
      setError(message);
      if (options.errorTitle) Alert.alert(options.errorTitle, message);
    } finally {
      if (mounted.current) {
        try {
          await update();
        } catch (e) {
          setError(e.message || "Could not refresh this view.");
        }
        setBusy(false);
        setActionLabel("");
      }
      action.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    let updateTimer;
    const unsub = subscribe(() => {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(() => update().catch(() => {}), 80);
    });
    run(
      async () => {
        engine.current = await runtime();
        setName(
          await engine.current.store.get(
            "name",
            Platform.OS === "ios" ? "iPhone" : "Android",
          ),
        );
        await update();
        engine.current.sync();
      },
      { silent: true },
    );
    const app = AppState.addEventListener("change", (value) => {
      if (value === "active") engine.current?.sync();
      else engine.current?.stop();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === "active" && !action.current)
        engine.current?.sync();
    }, 15000);
    return () => {
      mounted.current = false;
      unsub();
      clearTimeout(updateTimer);
      clearInterval(timer);
      app.remove();
      engine.current?.stop();
    };
  }, []);
  useEffect(() => {
    if (!folder || status.busy || !engine.current) return;
    listFiles(folder.id).catch((e) => setError(e.message));
    return () => {
      fileRequest.current++;
    };
  }, [folder?.id, status.busy, status.last]);
  const connection = state.connection,
    connected = connection?.linked,
    catalog = state.catalog,
    volumes = catalog?.volumes || [];
  const currentFolder = locals.find((f) => f.id === folder?.id);
  const onboarding = (!connection && !catalog) || !!prefs.onboarding;
  const onboardingStep = connection
    ? "folders"
    : prefs.onboarding
      ? "pair"
      : "welcome";
  const historyDetail = sheet?.kind === "history";
  const detail = historyDetail;
  const screen = onboarding ? "Onboarding" : detail ? "File detail" : view;
  useEffect(() => {
    let cancelled = false;
    if (
      !["Machines", "Settings", "Folders", "File detail"].includes(screen) ||
      !connected
    ) {
      setMachines(null);
      return;
    }
    client
      .api("/v1/machines")
      .then((data) => {
        if (!cancelled) setMachines(data.machines);
      })
      .catch(() => {
        if (!cancelled) setMachines(null);
      });
    return () => {
      cancelled = true;
    };
  }, [screen, connected, status.last]);
  useEffect(() => {
    if (screen === "History" && connected)
      getHistory().catch((e) => setError(e.message));
  }, [
    screen,
    connected,
    historyVolume,
    historyFilter,
    catalog?.volumes
      .map((v) => v.id)
      .sort()
      .join(","),
    locals
      .filter((f) => f.selected)
      .map((f) => f.id)
      .sort()
      .join(","),
  ]);
  const locked = busy || status.busy || !engine.current;
  async function openFolder(f) {
    setFolder(f);
    setSearchOpen(false);
    setFileView("files");
    setDirectory("");
    setVisibleCount(100);
    setSearch("");
    await listFiles(f.id);
  }
  async function getHistory(target = null, more = false) {
    const selectedIds = historyFolderIds(
      await engine.current.store.folders(engine.current.scope),
      client.state().catalog.volumes,
    );
    if (target && !selectedIds.includes(target.volume))
      throw new Error("Select this folder to view its history.");
    if (target && !more) {
      let localEntry = null;
      if (
        (await engine.current.store.folder(engine.current.scope, target.volume))
          ?.selected
      ) {
        const uri = engine.current.files.work(
          engine.current.scope,
          target.volume,
          target.path,
        );
        const info = await engine.current.files.stat(uri);
        if (info && !info.directory)
          localEntry = { ...info, path: target.path, uri };
      }
      target = { ...target, kind: "history", localEntry };
      setFileHistory({ versions: [], next: null });
      setSheet(target);
    }
    const previous = target ? fileHistory : history;
    const q = new URLSearchParams({
      limit: "50",
      ...(target ? { volume: target.volume, path: target.path } : {}),
      ...(more && previous.next ? { before: String(previous.next) } : {}),
    });
    const request = ++historyRequest.current;
    if (target) setDetailError("");
    if (!target) {
      setHistoryError("");
      if (historyVolume && selectedIds.includes(historyVolume))
        q.set("volume", historyVolume);
      else if (historyVolume) setHistoryVolume("");
      if (!more) setHistory({ versions: [], next: null });
      q.set("filter", historyFilter);
      setHistoryLoading(true);
    }
    let page;
    try {
      page = target
        ? await client.api(`/v1/history?${q}`)
        : await scopedActivity(
            (query) => client.api(`/v1/activity?${query}`),
            selectedIds,
            q,
          );
    } catch (e) {
      if (target) throw e;
      if (request === historyRequest.current) setHistoryError(e.message);
      return;
    } finally {
      if (!target && request === historyRequest.current)
        setHistoryLoading(false);
    }
    let localEntry = target?.localEntry || target?.originEntry;
    if (target && locals.some((f) => f.id === target.volume && f.selected)) {
      const uri = engine.current.files.work(
        engine.current.scope,
        target.volume,
        target.path,
      );
      try {
        const info = await engine.current.files.stat(uri);
        localEntry =
          info && !info.directory ? { ...info, path: target.path, uri } : null;
      } catch {}
    }
    if (request !== historyRequest.current || !mounted.current) return;
    (target ? setFileHistory : setHistory)({
      versions: more ? [...previous.versions, ...page.versions] : page.versions,
      next: page.next,
    });
    if (target)
      setSheet({
        kind: "history",
        originEntry: target.originEntry || null,
        ...target,
        localEntry,
        currentRev: more ? target.currentRev : page.versions[0]?.rev,
      });
  }
  async function openFileDetail(entry) {
    const target = {
      kind: "history",
      volume: folder.id,
      path: entry.path,
      originEntry: entry,
      localEntry: entry,
    };
    setFileHistory({ versions: [], next: null });
    setDetailError("");
    setSheet(target);
    setDetailLoading(true);
    try {
      if (connected) await getHistory(target);
    } catch (e) {
      setDetailError(e.message);
    } finally {
      setDetailLoading(false);
    }
  }
  async function shareCurrentFile() {
    const uri = engine.current.files.work(
      engine.current.scope,
      sheet.volume,
      sheet.path,
    );
    if (!(await engine.current.files.exists(uri)))
      throw new Error("This file is not available locally yet.");
    if (!(await Sharing.isAvailableAsync()))
      throw new Error("Sharing is unavailable on this device.");
    await Sharing.shareAsync(uri);
  }
  async function imported(kind) {
    const result =
      kind === "photos"
        ? await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            allowsMultipleSelection: true,
            quality: 1,
          })
        : await DocumentPicker.getDocumentAsync({
            multiple: true,
            copyToCacheDirectory: true,
          });
    if (result.canceled) return;
    for (const asset of result.assets)
      await engine.current.importFile(
        folder.id,
        directory + (asset.name || asset.fileName || `photo-${Date.now()}.jpg`),
        asset.uri,
      );
    await listFiles();
    if (connected && !status.paused) await engine.current.sync();
  }
  function choose(v) {
    setSheet({ kind: "select", volume: v });
  }
  function unlink() {
    const target = folder;
    confirm(
      "Stop syncing and remove local files?",
      "This removes this folder’s files from this device and frees up space. Files on the hub and other machines, and shared history, stay unchanged. Unsynced changes will be permanently lost. Use Save a copy first if you need them.",
      () => {
        setSheet(null);
        run(
          async () => {
            await engine.current.unselect(target.id);
            setFolder(null);
            setView("Folders");
          },
          {
            label: "Removing local files…",
            success: `${target.name}: local files removed`,
            errorTitle: "Could not remove local files",
          },
        );
      },
      "Remove local files",
    );
  }
  function destroy() {
    confirm(
      "Destroy this replica?",
      "Permanently deletes all downloaded folders and unsynced changes, credentials, selections, index, queues and caches. Arca returns to first-run setup. Hub files and history and other machines are kept. This cannot be undone. If still connected, the hub must be reachable.",
      () =>
        run(
          async () => {
            await destroyReplica();
            setFolder(null);
            setSheet(null);
            setAddress("");
            setCode("");
            setEntries([]);
            setMachines(null);
            setHistory({ versions: [], next: null });
            setName(Platform.OS === "ios" ? "iPhone" : "Android");
            setDeviceName(null);
            setView("Machines");
          },
          {
            label: "Destroying replica…",
            errorTitle: "Could not destroy replica",
            destroy: true,
          },
        ),
      "Destroy replica",
    );
  }
  function disconnect() {
    confirm(
      "Disconnect from hub?",
      "Local files are kept. A new pairing code will be required to reconnect.",
      () =>
        run(async () => {
          const r = engine.current;
          r.stop();
          if (r.active) await r.active;
          await client.disconnect();
          setFolder(null);
          setHistory({ versions: [], next: null });
        }),
      "Disconnect",
    );
  }
  const [directory, setDirectory] = useState(""),
    [visibleCount, setVisibleCount] = useState(100);
  async function resolveConflict(entry, volume = folder?.id) {
    if (!locals.find((f) => f.id === volume)?.selected)
      throw new Error(
        "Select this folder for synchronization before resolving conflicts.",
      );
    const original = entry.path.slice(0, entry.path.lastIndexOf(".conflict-"));
    const query = (path) =>
      "/v1/history?" + new URLSearchParams({ volume, path, limit: "1" });
    const [a, b] = await Promise.all([
      client.api(query(original)),
      client.api(query(entry.path)),
    ]);
    if (!a.versions[0] || !b.versions[0] || b.versions[0].deleted)
      throw new Error("Synchronize this conflict before reviewing it.");
    if (b.versions[0].resolved)
      throw new Error("This conflict is already resolved. Refresh History.");
    setSheet({
      kind: "conflict",
      volume,
      returnTo: sheet,
      choice: a.versions[0].deleted ? "conflict" : "original",
      entry,
      original: a.versions[0],
      conflict: b.versions[0],
    });
  }
  async function chooseConflict(choice) {
    const r = engine.current;
    const selected = await r.store.folder(r.scope, sheet.volume);
    if (!selected?.selected)
      throw new Error(
        "Select this folder for synchronization before resolving conflicts.",
      );
    await r.sync();
    if (r.error) throw new Error(r.error);
    await r.report();
    if (!client.state().catalog?.conflictResolution)
      throw new Error("Update the hub before resolving conflicts.");
    await client.api("/v1/conflict-choice", {
      volume: sheet.volume,
      path: sheet.entry.path,
      choice,
      originalRev: sheet.original.rev,
      conflictRev: sheet.conflict.rev,
    });
    const previous = sheet.returnTo;
    setSheet(previous || null);
    await engine.current.sync();
    if (previous?.kind === "history") await getHistory(previous);
    if (folder) await listFiles();
  }
  async function restore(row) {
    confirm(
      "Restore this revision?",
      "The hub creates a new revision. It will synchronize to every selected copy.",
      () =>
        run(async () => {
          await client.api("/v1/restore", {
            volume: row.volume,
            path: row.path,
            rev: row.rev,
          });
          await engine.current.sync();
          if (folder) await listFiles();
          await getHistory(sheet?.kind === "history" ? sheet : null);
        }),
      "Restore",
    );
  }
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (sheet) {
        historyRequest.current++;
        if (!busy)
          setSheet(sheet.kind === "conflict" ? sheet.returnTo || null : null);
        return true;
      }
      if (folder && view === "Folders") {
        setFolder(null);
        return true;
      }
      return false;
    });
    return () => listener.remove();
  }, [sheet, folder, view, busy]);
  const selectTab = (tab) => {
    historyRequest.current++;
    setView(tab);
    setSheet(null);
  };
  const showError = error || status.error;
  useEffect(() => {
    if (!showError) setDismissedError("");
  }, [showError]);
  const opening =
    (!fonts && !fontError) || (!engine.current && busy && !showError);
  useEffect(() => {
    if (!opening) SplashScreen.hideAsync().catch(() => {});
  }, [opening]);
  if (opening)
    return (
      <SafeAreaProvider>
        <SafeAreaView style={s.root}>
          <ActivityIndicator
            color={c.accent}
            accessibilityLabel="Opening arca"
          />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  const historyControls = (
    <View style={wide ? s.historyTools : s.folderTools}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Shared folder"
        onPress={() => setSheet({ kind: "history-filter" })}
        style={[s.button, s.historyFolderFilter]}
      >
        <Text numberOfLines={1} style={[s.buttonLabel, s.flex]}>
          {volumes.find((v) => v.id === historyVolume)?.name || "All"}
        </Text>
        <Icon name="chevron-down" size={14} />
      </Pressable>
      <SegmentedControl
        options={[
          { label: "Conflicts", value: "conflicts" },
          { label: "Deleted", value: "deleted" },
        ]}
        value={historyFilter}
        onChange={(value) =>
          setHistoryFilter(value === historyFilter ? "revisions" : value)
        }
      />
    </View>
  );
  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={
          c.paper === palettes.dark.paper ? "light-content" : "dark-content"
        }
      />
      <Design.Provider value={{ s, c, wide }}>
        <View style={s.root}>
          <View style={[s.root, wide && !onboarding && s.shell]}>
            {wide && !onboarding && (
              <Navigation
                wide
                compact={compact}
                view={view}
                onSelect={selectTab}
                name={name}
                hub={catalog?.name}
              />
            )}
            <SafeAreaView
              style={s.root}
              edges={
                wide && !onboarding
                  ? ["top", "right", "bottom"]
                  : ["top", "right", "bottom", "left"]
              }
            >
              <KeyboardPane style={s.root}>
                {!onboarding && (
                  <View style={s.viewHeader}>
                    {detail && (
                      <Button
                        quiet
                        label={
                          historyDetail && sheet.originEntry
                            ? "Folder"
                            : view === "Folders"
                              ? "Folder"
                              : "History"
                        }
                        icon="back"
                        onPress={() => {
                          historyRequest.current++;
                          setSheet(null);
                        }}
                      />
                    )}
                    {folder && screen === "Folders" && (
                      <View style={s.compactActions}>
                        <Button
                          quiet
                          label="Folders"
                          icon="back"
                          onPress={() => setFolder(null)}
                        />
                      </View>
                    )}
                    {!onboarding && (
                      <View style={s.row}>
                        <View style={s.flex}>
                          {detail ? (
                            <View style={s.row}>
                              <View style={s.tile}>
                                <Icon name="file" />
                              </View>
                              <View style={[s.flex, s.stack]}>
                                <Text
                                  accessibilityRole="header"
                                  style={s.title}
                                >
                                  {sheet.path.split("/").pop()}
                                </Text>
                                <Text style={s.caption}>
                                  {volumes.find((v) => v.id === sheet.volume)
                                    ?.name ||
                                    folder?.name ||
                                    "Shared folder"}
                                </Text>
                              </View>
                            </View>
                          ) : (
                            <Text accessibilityRole="header" style={s.title}>
                              {folder && view === "Folders"
                                ? folder.name
                                : view}
                            </Text>
                          )}
                          {folder && screen === "Folders" && (
                            <Text style={s.caption}>
                              {`${entries.filter((e) => !e.directory).length} files · ${bytes(entries.reduce((total, e) => total + e.size, 0))} local${status.paused ? " · Paused" : ""}`}
                            </Text>
                          )}
                        </View>
                        {historyDetail && (
                          <Button
                            label="Share"
                            icon="export"
                            iconOnly={!wide}
                            disabled={locked || !sheet.localEntry}
                            onPress={() => run(shareCurrentFile)}
                          />
                        )}
                        {folder && screen === "Folders" && (
                          <View style={s.rowAction}>
                            {fileView === "files" && (
                              <Button
                                iconOnly
                                label={
                                  searchOpen ? "Close search" : "Search files"
                                }
                                icon={searchOpen ? "close" : "search"}
                                onPress={() => {
                                  setSearchOpen(!searchOpen);
                                  setSearch("");
                                  setVisibleCount(100);
                                }}
                              />
                            )}
                            <Button
                              iconOnly
                              label="Folder actions"
                              icon="more"
                              onPress={() =>
                                setSheet({ kind: "folder-actions" })
                              }
                            />
                          </View>
                        )}
                        {screen === "History" && wide && historyControls}
                        {connected && screen === "Folders" && (
                          <Button
                            iconOnly={!!folder}
                            label="Sync now"
                            icon="refresh"
                            busy={locked}
                            disabled={status.paused}
                            onPress={() =>
                              run(
                                async () => {
                                  await engine.current.sync(true);
                                  if (folder) await listFiles();
                                },
                                { silent: true },
                              )
                            }
                          />
                        )}
                      </View>
                    )}
                    {screen === "History" && !wide && historyControls}
                    {folder && screen === "Folders" && wide && (
                      <View style={[s.group, s.statsGrid]}>
                        {[
                          [
                            "Status",
                            currentFolder?.issue || status.error
                              ? "Needs attention"
                              : status.paused
                                ? "Paused"
                                : status.busy
                                  ? "Syncing"
                                  : currentFolder?.completed
                                    ? "Up to date"
                                    : "Not yet synced",
                          ],
                          [
                            "Files",
                            `${currentFolder?.files ?? 0} · ${bytes(currentFolder?.bytes)}`,
                          ],
                          [
                            "Last completed",
                            currentFolder?.completed
                              ? date(currentFolder.completed)
                              : "Not yet",
                          ],
                        ].map(([label, value]) => (
                          <View key={label} style={s.statCell}>
                            <Text style={s.caption}>{label}</Text>
                            <Text style={s.statValue}>{value}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                )}
                <IncomingShare
                  connection={connection}
                  name={catalog?.name}
                  machine={machines?.find((m) => m.isHub)}
                  catalog={catalog}
                  locals={locals}
                  onSaved={update}
                />
                <KeyboardScrollView
                  key={`${screen}:${folder?.id || ""}`}
                  style={s.scroll}
                  contentContainerStyle={[
                    s.content,
                    !onboarding && s.viewBody,
                    onboarding && s.setup,
                  ]}
                  keyboardShouldPersistTaps="handled"
                >
                  {screen === "Folders" && (
                    <>
                      {!connected && (
                        <Card
                          title={
                            connection?.leaving
                              ? "Disconnection pending"
                              : "Disconnected"
                          }
                        >
                          <Text style={s.text}>
                            Local files stay available. Connect to synchronize
                            changes.
                          </Text>
                          <Button
                            label="Open Machines"
                            onPress={() => setView("Machines")}
                          />
                        </Card>
                      )}
                      {status.paused && !folder && (
                        <Card title="Paused">
                          <Text style={s.text}>Files stay as they are.</Text>
                          <Button
                            label="Resume"
                            onPress={() =>
                              run(async () => {
                                await engine.current.pause(false);
                                await engine.current.sync();
                              })
                            }
                          />
                        </Card>
                      )}
                      {folder ? (
                        <View style={s.detailGrid}>
                          <View style={s.detailMain}>
                            <View style={s.folderToolbar}>
                              <View style={!wide && s.flex}>
                                <SegmentedControl
                                  options={[
                                    { label: "Files", value: "files" },
                                    { label: "Recent", value: "recent" },
                                  ]}
                                  value={fileView}
                                  onChange={(value) => {
                                    setFileView(value);
                                    setVisibleCount(100);
                                  }}
                                />
                              </View>
                              {fileView === "recent" && (
                                <Button
                                  quiet
                                  label="All history"
                                  onPress={() => {
                                    setHistoryVolume(folder.id);
                                    setHistoryFilter("revisions");
                                    setFolder(null);
                                    setView("History");
                                  }}
                                />
                              )}
                            </View>
                            {searchOpen && fileView === "files" && (
                              <Field
                                label="Search files"
                                autoFocus
                                placeholder="Search this folder"
                                returnKeyType="search"
                                value={search}
                                onChangeText={(value) => {
                                  setSearch(value);
                                  setVisibleCount(100);
                                }}
                              />
                            )}
                            {fileView === "recent" ? (
                              <FolderRecent
                                volume={folder.id}
                                connected={connected}
                                updated={status.last}
                                date={date}
                                open={(row) =>
                                  run(() =>
                                    getHistory({
                                      volume: folder.id,
                                      path: row.path,
                                    }),
                                  )
                                }
                              />
                            ) : (
                              <>
                                <View style={s.group}>
                                  <Breadcrumbs
                                    name={folder.name}
                                    directory={directory}
                                    onChange={(path) => {
                                      setDirectory(path);
                                      setSearch("");
                                      setVisibleCount(100);
                                    }}
                                  />
                                  {browseEntries(entries, directory, search)
                                    .slice(0, visibleCount)
                                    .map((e, index) => (
                                      <Pressable
                                        key={e.path}
                                        accessibilityRole="button"
                                        accessibilityLabel={
                                          e.directory
                                            ? `Open folder ${e.label}`
                                            : e.label
                                        }
                                        onPress={() => {
                                          if (e.directory) {
                                            setDirectory(e.path + "/");
                                            setVisibleCount(100);
                                          } else run(() => openFileDetail(e));
                                        }}
                                        style={[s.settingRow, s.separator]}
                                      >
                                        <View style={s.row}>
                                          <Icon
                                            name={
                                              e.directory ? "folders" : "file"
                                            }
                                          />
                                          <View style={s.flex}>
                                            <Text style={s.heading}>
                                              {e.label}
                                            </Text>
                                            <Text style={s.caption}>
                                              {e.directory
                                                ? `${e.count} ${e.count === 1 ? "file" : "files"} · ${bytes(e.size)}`
                                                : bytes(e.size)}
                                            </Text>
                                          </View>
                                          <Icon name="chevron" color={c.mute} />
                                        </View>
                                      </Pressable>
                                    ))}
                                  {!browseEntries(entries, directory, search)
                                    .length && (
                                    <View style={s.explorerEmpty}>
                                      <Icon name="folders" color={c.mute} />
                                      <Text style={s.text}>
                                        {search
                                          ? "No matching files"
                                          : currentFolder?.completed
                                            ? "This folder is empty"
                                            : "No local files yet"}
                                      </Text>
                                    </View>
                                  )}
                                </View>
                                {browseEntries(entries, directory, search)
                                  .length > visibleCount && (
                                  <Button
                                    label="Show more files"
                                    onPress={() =>
                                      setVisibleCount((n) => n + 100)
                                    }
                                  />
                                )}
                              </>
                            )}
                          </View>
                          {wide && (
                            <View style={s.detailSide}>
                              <Text style={s.eyebrow}>LOCAL COPY</Text>
                              <Card>
                                <Text style={s.text}>
                                  {currentFolder?.issue
                                    ? "Synchronization needs attention. Review the error to continue."
                                    : currentFolder?.completed
                                      ? "Files are stored on this device and available offline."
                                      : "The local copy is incomplete. Keep Arca open to finish syncing."}
                                </Text>
                              </Card>
                              <Text style={s.eyebrow}>COPIES</Text>
                              <View style={s.group}>
                                <View style={[s.settingRow, s.row]}>
                                  <Icon name="server" />
                                  <Text style={[s.heading, s.flex]}>
                                    {catalog?.name || "Hub"}
                                  </Text>
                                  <Tag variant="hub">Hub</Tag>
                                </View>
                                <View
                                  style={[s.settingRow, s.row, s.separator]}
                                >
                                  <Icon name="phone" />
                                  <Text style={[s.heading, s.flex]}>
                                    {name}
                                  </Text>
                                  <Tag variant="self">This machine</Tag>
                                </View>
                                {(machines || [])
                                  .filter(
                                    (m) =>
                                      !m.isHub &&
                                      m.credentialId !== connection?.id &&
                                      m.folderIds?.includes(folder.id),
                                  )
                                  .map((m) => (
                                    <View
                                      key={m.machineId}
                                      style={[s.settingRow, s.row, s.separator]}
                                    >
                                      <Icon
                                        name={
                                          /android|ios/.test(m.platform)
                                            ? "phone"
                                            : "monitor"
                                        }
                                      />
                                      <Text style={[s.heading, s.flex]}>
                                        {m.name}
                                      </Text>
                                      <Tag>Replica</Tag>
                                    </View>
                                  ))}
                              </View>
                              <Card title="Stop syncing on this device">
                                <Text style={s.text}>
                                  Removes this device’s local copy. Hub files
                                  and history are kept.
                                </Text>
                                <Button
                                  danger
                                  label="Stop syncing…"
                                  icon="unlink"
                                  disabled={busy || !engine.current}
                                  onPress={unlink}
                                />
                              </Card>
                            </View>
                          )}
                        </View>
                      ) : (
                        <>
                          {!!locals.length && (
                            <Text style={s.eyebrow}>
                              SELECTED ON THIS DEVICE
                            </Text>
                          )}
                          <View style={s.folderList}>
                            {locals.map((f) => (
                              <FolderRow
                                key={f.id}
                                name={f.name}
                                description={`${f.files} files · ${bytes(f.bytes)} local`}
                                status={
                                  status.paused
                                    ? "Paused"
                                    : f.issue
                                      ? "Needs attention"
                                      : status.busy
                                        ? "Syncing"
                                        : f.completed
                                          ? "Up to date"
                                          : "Incomplete"
                                }
                                onPress={() => run(() => openFolder(f))}
                              />
                            ))}
                          </View>
                          {volumes.some(
                            (v) => !locals.some((f) => f.id === v.id),
                          ) && (
                            <Text style={s.eyebrow}>ON HUB · NOT SELECTED</Text>
                          )}
                          <View style={s.folderList}>
                            {volumes
                              .filter((v) => !locals.some((f) => f.id === v.id))
                              .map((v) => (
                                <FolderRow
                                  key={v.id}
                                  name={v.name}
                                  available
                                  description={`${v.files} files · ${bytes(v.bytes)}`}
                                  disabled={!connected || locked}
                                  onPress={() => choose(v)}
                                />
                              ))}
                          </View>
                          {!locals.length && !volumes.length && (
                            <Card title="No folders yet">
                              <Text style={s.text}>
                                Shared folders from your hub appear here.
                              </Text>
                            </Card>
                          )}
                          <Text style={s.caption}>
                            {bytes(status.free)} free on this device
                          </Text>
                        </>
                      )}
                    </>
                  )}
                  {historyDetail && (
                    <FileHistory
                      target={sheet}
                      history={fileHistory}
                      loading={detailLoading}
                      error={detailError}
                      localEntry={sheet.localEntry}
                      deleteFile={
                        sheet.localEntry
                          ? () =>
                              confirm(
                                "Delete this file?",
                                "Deletes from all synced copies. Retained history can be restored." +
                                  (!connected || status.paused
                                    ? " Deletion will sync when connected and resumed."
                                    : ""),
                                () =>
                                  run(
                                    async () => {
                                      const target = sheet;
                                      await engine.current.removeFile(
                                        target.volume,
                                        target.path,
                                      );
                                      setSheet(null);
                                      if (folder) await listFiles();
                                      if (connected && !status.paused)
                                        await engine.current.sync();
                                    },
                                    { success: "File deleted" },
                                  ),
                                "Delete file",
                              )
                          : null
                      }
                      retry={() => run(() => getHistory(sheet))}
                      author={(id) =>
                        machines?.find(
                          (m) => m.machineId === id || m.credentialId === id,
                        )?.name ||
                        (id === connection?.id ? name : "Unknown machine")
                      }
                      volume={
                        volumes.find((v) => v.id === sheet.volume) ||
                        locals.find((v) => v.id === sheet.volume)
                      }
                      date={date}
                      locked={locked}
                      connected={connected}
                      restore={restore}
                      canResolve={locals.some(
                        (f) => f.id === sheet.volume && f.selected,
                      )}
                      reviewConflict={() =>
                        run(() =>
                          resolveConflict({ path: sheet.path }, sheet.volume),
                        )
                      }
                      loadMore={() => run(() => getHistory(sheet, true))}
                      openFolder={
                        locals.some((f) => f.id === sheet.volume)
                          ? () => {
                              const target = locals.find(
                                (f) => f.id === sheet.volume,
                              );
                              setSheet(null);
                              setView("Folders");
                              run(() => openFolder(target));
                            }
                          : null
                      }
                    />
                  )}
                  {screen === "Onboarding" && (
                    <Onboarding
                      step={onboardingStep}
                      name={name}
                      setName={setName}
                      address={address}
                      setAddress={setAddress}
                      code={code}
                      setCode={setCode}
                      catalog={catalog}
                      free={status.free}
                      busy={locked}
                      start={() =>
                        run(() =>
                          engine.current.store.set("onboarding", "pair"),
                        )
                      }
                      pair={() =>
                        run(async () => {
                          const r = engine.current;
                          await r.store.set("name", name.trim());
                          await client.pair(address, code, name.trim());
                          setCode("");
                          r.scope = client.state().connection.hubId;
                          await r.store.set("scope", r.scope);
                          await r.store.set("onboarding", "folders");
                        })
                      }
                      retry={() => run(() => client.refresh())}
                      download={(ids) =>
                        run(async () => {
                          const r = engine.current;
                          await client.refresh();
                          r.scope = client.state().connection.hubId;
                          await r.store.set("scope", r.scope);
                          await selectFirstFolders(
                            r,
                            client.state().catalog,
                            ids,
                          );
                          setView("Folders");
                          r.sync();
                        })
                      }
                      skip={() =>
                        run(async () => {
                          await engine.current.store.set("onboarding", null);
                          setView("Folders");
                        })
                      }
                    />
                  )}
                  {screen === "Machines" && (
                    <>
                      {connection && (
                        <Text style={s.eyebrow}>HUB CONNECTION</Text>
                      )}
                      {connection ? (
                        <HubConnection
                          connection={connection}
                          name={catalog?.name}
                          machine={machines?.find((m) => m.isHub)}
                          busy={locked}
                          disconnect={disconnect}
                          retry={() => run(() => client.refresh())}
                        />
                      ) : (
                        <>
                          <View style={s.center}>
                            <Logo />
                            <Text accessibilityRole="header" style={s.heading}>
                              Pair with your hub
                            </Text>
                            <Text style={[s.text, s.centerText]}>
                              Your hub keeps your folders. Choose the ones to
                              keep on this device, with full copies available
                              offline.
                            </Text>
                          </View>
                          <Field
                            label="Name this device"
                            value={name}
                            maxLength={100}
                            onChangeText={setName}
                          />
                          <Field
                            label="Hub address"
                            value={address}
                            onChangeText={setAddress}
                            placeholder="http://192.168.1.10:47831"
                            keyboardType="url"
                          />
                          <Text style={s.caption}>
                            Use HTTPS or Tailscale. For local Wi-Fi, enable HTTP
                            in the hub’s Settings and enter its private IPv4
                            address. Local HTTP traffic is not encrypted.
                          </Text>
                          <Field
                            label="Pairing code"
                            value={code}
                            onChangeText={(v) =>
                              setCode(v.replace(/[^0-9]/g, "").slice(0, 6))
                            }
                            keyboardType="number-pad"
                            textContentType="oneTimeCode"
                            style={[s.input, s.code]}
                          />
                          <Text style={s.caption}>
                            Get a code from Machines on the hub. Six digits ·
                            single use · expires in ten minutes.
                          </Text>
                          <Button
                            label="Pair this device"
                            primary
                            busy={busy}
                            disabled={
                              !engine.current ||
                              code.length !== 6 ||
                              !address ||
                              !name.trim()
                            }
                            onPress={() =>
                              run(async () => {
                                await engine.current.store.set(
                                  "name",
                                  name.trim(),
                                );
                                await client.pair(address, code, name.trim());
                                setCode("");
                                await engine.current.sync();
                                setView("Folders");
                              })
                            }
                          />
                        </>
                      )}
                      {!connection && (
                        <Text style={[s.caption, s.centerText]}>
                          No Arca account or password. Your connection
                          credential is stored securely on this device.
                        </Text>
                      )}
                      {connection && (
                        <>
                          <Text style={s.eyebrow}>MACHINES</Text>
                          <View style={s.folderList}>
                            <MachineRow
                              name={name}
                              self
                              role="Replica"
                              totals={`${locals.filter((f) => f.selected).length} folders · ${bytes(locals.filter((f) => f.selected).reduce((n, f) => n + (f.bytes || 0), 0))} local`}
                              description={`${Platform.OS === "ios" ? "iOS" : "Android"}${machines?.find((m) => m.credentialId === connection.id)?.lastAddress ? ` · ${machines.find((m) => m.credentialId === connection.id).lastAddress}` : ""}`}
                              state={
                                status.paused
                                  ? "Paused"
                                  : status.error ||
                                      locals.some((f) => f.selected && f.issue)
                                    ? "Needs attention"
                                    : status.busy
                                      ? "Syncing"
                                      : locals.some(
                                            (f) => f.selected && !f.completed,
                                          )
                                        ? "Incomplete"
                                        : status.last
                                          ? "Up to date"
                                          : "Not yet synced"
                              }
                            />
                            {machines ? (
                              machines
                                .filter(
                                  (m) =>
                                    !m.isHub &&
                                    m.credentialId !== connection.id,
                                )
                                .map((m) => (
                                  <MachineRow
                                    key={m.credentialId}
                                    name={m.name}
                                    description={`${{ darwin: "macOS", android: "Android", ios: "iOS", linux: "Linux", win32: "Windows" }[m.platform] || m.platform || "Platform not reported"}${m.lastAddress ? ` · ${m.lastAddress}` : ""}`}
                                    role={m.role || "Replica"}
                                    state={m.revoked ? "Revoked" : "Linked"}
                                  />
                                ))
                            ) : (
                              <Text style={s.caption}>
                                Machine list unavailable
                              </Text>
                            )}
                          </View>
                        </>
                      )}
                    </>
                  )}
                  {screen === "History" && (
                    <>
                      {!connected && (
                        <Text style={s.text}>Connect to view hub history.</Text>
                      )}
                      {historyLoading && <ActivityIndicator color={c.accent} />}
                      {!historyLoading && !!historyError && (
                        <Card title="Could not load history">
                          <Text style={s.text}>{historyError}</Text>
                          <Button
                            label="Retry"
                            onPress={() =>
                              run(async () => {
                                await client.refresh();
                                await getHistory();
                              })
                            }
                          />
                        </Card>
                      )}
                      {connected &&
                        !historyLoading &&
                        !historyError &&
                        !history.versions.length && (
                          <Card
                            title={
                              historyFilter !== "revisions" || historyVolume
                                ? "No matching revisions"
                                : "No history yet"
                            }
                          >
                            <Text style={s.text}>
                              Try another filter or sync to check for revisions.
                            </Text>
                          </Card>
                        )}
                      {!!history.versions.length && (
                        <View style={s.historyGroups}>
                          {Array.from(
                            history.versions.reduce((groups, row) => {
                              const day = new Date(
                                row.created,
                              ).toLocaleDateString("en", {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              });
                              if (!groups.has(day)) groups.set(day, []);
                              groups.get(day).push(row);
                              return groups;
                            }, new Map()),
                          ).map(([day, rows]) => (
                            <View key={day} style={s.section}>
                              <Text style={s.eyebrow}>{day.toUpperCase()}</Text>
                              <View style={s.group}>
                                {rows.map((row, index) => (
                                  <Pressable
                                    key={`${row.volume}:${row.rev}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={`View history for ${row.path}`}
                                    onPress={() =>
                                      run(() =>
                                        getHistory({
                                          volume: row.volume,
                                          path: row.path,
                                        }),
                                      )
                                    }
                                    style={[
                                      s.settingRow,
                                      index > 0 && s.separator,
                                      s.row,
                                    ]}
                                  >
                                    <Icon
                                      name={
                                        row.deleted
                                          ? "trash"
                                          : row.path.includes(".conflict-")
                                            ? "conflict"
                                            : "revision"
                                      }
                                      color={
                                        row.deleted
                                          ? c.mute
                                          : row.path.includes(".conflict-") &&
                                              !row.resolved
                                            ? c.warning
                                            : c.accent
                                      }
                                    />
                                    <View style={[s.flex, s.stack]}>
                                      <Text
                                        numberOfLines={1}
                                        style={[
                                          s.rowTitle,
                                          !!row.deleted && s.deletedFile,
                                        ]}
                                      >
                                        {row.path}
                                      </Text>
                                      <Text style={s.caption}>
                                        {!wide && `${row.folder} · `}
                                        {row.deleted
                                          ? "Deleted · recoverable"
                                          : row.path.includes(".conflict-")
                                            ? row.resolved
                                              ? "Conflict resolved · copy kept"
                                              : "Conflict copy retained"
                                            : `${bytes(row.size)} · accepted revision`}
                                        {!wide && ` · ${date(row.created)}`}
                                      </Text>
                                    </View>
                                    {wide && (
                                      <>
                                        <Text
                                          numberOfLines={1}
                                          style={[s.caption, s.historyFolder]}
                                        >
                                          {row.folder}
                                        </Text>
                                        <Text
                                          style={[s.mono, s.historyRevision]}
                                        >
                                          rev {row.rev}
                                        </Text>
                                        <Text
                                          style={[s.caption, s.historyDate]}
                                        >
                                          {relative(row.created)}
                                        </Text>
                                      </>
                                    )}
                                    <Icon name="chevron" color={c.mute} />
                                  </Pressable>
                                ))}
                              </View>
                            </View>
                          ))}
                        </View>
                      )}
                      {history.next && (
                        <Button
                          label="Load older revisions"
                          busy={busy}
                          onPress={() => run(() => getHistory(null, true))}
                        />
                      )}
                    </>
                  )}
                  {screen === "Settings" && (
                    <>
                      {connection && (
                        <>
                          <Text style={s.eyebrow}>HUB CONNECTION</Text>
                          <HubConnection
                            connection={connection}
                            name={catalog?.name}
                            machine={machines?.find((m) => m.isHub)}
                            busy={locked}
                            disconnect={disconnect}
                            retry={() => run(() => client.refresh())}
                          />
                        </>
                      )}
                      <Text style={s.eyebrow}>THIS MACHINE</Text>
                      <Card>
                        <Field
                          label="Machine name"
                          value={deviceName ?? name}
                          onChangeText={setDeviceName}
                          maxLength={100}
                          autoCapitalize="words"
                          returnKeyType="done"
                          editable={!busy}
                          onEndEditing={({ nativeEvent }) => {
                            const nextName = nativeEvent.text.trim();
                            if (nextName === name) {
                              setDeviceName(null);
                              return;
                            }
                            run(async () => {
                              const reported =
                                await engine.current.rename(nextName);
                              setName(nextName);
                              setDeviceName(null);
                              setSuccess(
                                reported
                                  ? "Machine name updated."
                                  : "Name saved. The hub will update on the next sync.",
                              );
                            });
                          }}
                        />
                      </Card>
                      <Text style={s.eyebrow}>LOCAL SYNCHRONIZATION</Text>
                      <SettingsGroup>
                        <Card>
                          <Toggle
                            label="Pause sync"
                            description="Files stay as they are"
                            value={!!status.paused}
                            disabled={busy}
                            onChange={(v) =>
                              run(async () => {
                                await engine.current.pause(v);
                                if (!v) await engine.current.sync();
                              })
                            }
                          />
                        </Card>
                        <Card title="Last completed sync">
                          <Text style={s.text}>{date(status.last)}</Text>
                        </Card>
                      </SettingsGroup>
                      <Text style={s.eyebrow}>MOBILE PREFERENCES</Text>
                      <SettingsGroup>
                        <Card>
                          <Toggle
                            label="Background sync"
                            description="When the system allows. Open Arca to continue immediately."
                            value={!!prefs.background}
                            disabled={busy}
                            onChange={(v) => run(() => setBackground(v))}
                          />
                        </Card>
                        <Card>
                          <Toggle
                            label="System notifications"
                            description="Alerts about conflicts and synchronization errors"
                            value={!!prefs.notifications}
                            disabled={busy}
                            onChange={(v) => run(() => setNotifications(v))}
                          />
                        </Card>
                      </SettingsGroup>
                      <Text style={s.eyebrow}>STORAGE</Text>
                      <Card title={`${bytes(status.free)} free`}>
                        <Text style={s.text}>
                          Selected files are stored persistently on this device.
                        </Text>
                        {Platform.OS === "ios" && (
                          <Text style={s.caption}>
                            Find Arca under On My iPhone in the Files app.
                          </Text>
                        )}
                      </Card>
                      <Text style={s.eyebrow}>APPEARANCE</Text>
                      <Card title="Theme">
                        <SegmentedControl
                          options={["light", "dark", "system"].map((value) => ({
                            value,
                            label: value[0].toUpperCase() + value.slice(1),
                          }))}
                          value={prefs.theme}
                          onChange={(value) =>
                            run(() => engine.current.store.set("theme", value))
                          }
                        />
                        <Text style={s.caption}>
                          Text size follows system accessibility settings.
                        </Text>
                      </Card>
                      <Text style={[s.caption, s.centerText]}>
                        arca {config.expo.version}
                      </Text>
                      <Text style={[s.eyebrow, s.errorText]}>DANGER ZONE</Text>
                      <Card title="Destroy this replica" danger>
                        <Text style={s.text}>
                          Deletes all local folders and resets Arca on this
                          device. Hub files and other machines are kept.
                        </Text>
                        <Button
                          label="Destroy replica…"
                          icon="trash"
                          primary
                          danger
                          busy={locked}
                          onPress={destroy}
                        />
                      </Card>
                    </>
                  )}
                </KeyboardScrollView>
                {!onboarding && !wide && !keyboardVisible && (
                  <Navigation
                    view={view}
                    onSelect={selectTab}
                    name={name}
                    hub={catalog?.name}
                  />
                )}
              </KeyboardPane>
            </SafeAreaView>
          </View>
          {!!(actionLabel || success) && (!sheet || detail) && (
            <View
              style={[s.noticeDock, s.toastNotice]}
              accessibilityLiveRegion="polite"
            >
              <View style={s.row}>
                {actionLabel ? (
                  <ActivityIndicator color="#accb80" />
                ) : (
                  <Icon name="check" size={16} color="#accb80" />
                )}
                <Text style={[s.noticeText, s.toastText, s.flex]}>
                  {actionLabel || success}
                </Text>
                {!actionLabel && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss notification"
                    style={s.noticeClose}
                    onPress={() => setSuccess("")}
                  >
                    <Icon name="close" size={16} color="#f4f6f1" />
                  </Pressable>
                )}
              </View>
            </View>
          )}
          {!actionLabel &&
            !!showError &&
            showError !== dismissedError &&
            (!sheet || detail) && (
              <View style={s.noticeDock} accessibilityRole="alert">
                <View style={s.row}>
                  <Icon name="alert" size={16} color={c.danger} />
                  <Text style={[s.noticeTitle, s.flex]}>
                    Could not complete action
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss notification"
                    style={s.noticeClose}
                    onPress={() => setDismissedError(showError)}
                  >
                    <Icon name="close" size={16} color={c.soft} />
                  </Pressable>
                </View>
                <ScrollView style={s.noticeBody}>
                  <Text style={s.noticeText}>{showError}</Text>
                </ScrollView>
                {(!error || retryAction.current?.message === error) && (
                  <View style={s.compactActions}>
                    <Button
                      label="Retry"
                      disabled={locked}
                      onPress={() => {
                        if (error && retryAction.current) retryAction.current();
                        else
                          run(() => engine.current.sync(), {
                            silent: true,
                          });
                      }}
                    />
                  </View>
                )}
              </View>
            )}
          {sheet && !detail && (
            <Sheet
              title={
                sheet.kind === "history-filter"
                  ? "Shared folder"
                  : sheet.kind === "folder-actions"
                    ? folder.name
                    : sheet.kind === "select"
                      ? sheet.volume.name
                      : sheet.kind === "history"
                        ? sheet.path
                        : sheet.kind === "conflict"
                          ? "Resolve conflict"
                          : sheet.entry.path
              }
              busy={busy}
              busyLabel={actionLabel}
              onClose={() =>
                setSheet(
                  sheet.kind === "conflict" ? sheet.returnTo || null : null,
                )
              }
            >
              {!!error && sheet.kind !== "folder-actions" && (
                <Text accessibilityRole="alert" style={[s.text, s.errorText]}>
                  {error}
                </Text>
              )}
              {sheet.kind === "history-filter" && (
                <View style={s.group}>
                  {[
                    { id: "", name: "All folders" },
                    ...volumes.filter((v) =>
                      locals.some((f) => f.id === v.id && f.selected),
                    ),
                  ].map((v, index) => (
                    <FolderRow
                      key={v.id}
                      grouped
                      divider={index > 0}
                      name={v.name}
                      onPress={() => {
                        setHistoryVolume(v.id);
                        setSheet(null);
                      }}
                    />
                  ))}
                </View>
              )}
              {sheet.kind === "folder-actions" && (
                <>
                  <View style={s.actionGroup}>
                    {!!folder.selected && (
                      <>
                        <ActionRow
                          label="Upload files"
                          icon="upload"
                          disabled={locked}
                          onPress={() => {
                            setSheet(null);
                            run(() => imported("files"));
                          }}
                        />
                        <ActionRow
                          divider
                          label="Import photos"
                          icon="image"
                          disabled={locked}
                          onPress={() => {
                            setSheet(null);
                            run(() => imported("photos"));
                          }}
                        />
                      </>
                    )}
                    {connected && (
                      <ActionRow
                        divider={!!folder.selected}
                        label="View history"
                        icon="history"
                        disabled={locked}
                        onPress={() => {
                          setHistoryVolume(folder.id);
                          setHistoryFilter("revisions");
                          setSheet(null);
                          setView("History");
                        }}
                      />
                    )}
                    <ActionRow
                      divider={!!folder.selected || connected}
                      label="Save a copy…"
                      icon="export"
                      disabled={locked}
                      onPress={() => {
                        setSheet(null);
                        run(async () => {
                          await engine.current.files.exportDirectory(
                            engine.current.files.folder(
                              engine.current.scope,
                              folder.id,
                            ),
                            "arca-folder",
                          );
                          Alert.alert("Folder exported");
                        });
                      }}
                    />
                  </View>
                  <View style={s.destructiveActionGroup}>
                    <ActionRow
                      label="Stop syncing…"
                      icon="unlink"
                      danger
                      disabled={busy || !engine.current}
                      onPress={unlink}
                    />
                  </View>
                </>
              )}
              {sheet.kind === "select" && (
                <>
                  <Card title="Keep a local copy">
                    <Text style={s.text}>
                      {bytes(sheet.volume.bytes)} on hub · {bytes(status.free)}{" "}
                      free here
                    </Text>
                    <Text style={s.caption}>
                      Arca keeps a complete local copy and reserves space for
                      verified transfers. Downloads resume after interruption.
                    </Text>
                  </Card>
                  <Button
                    label="Select"
                    primary
                    busy={busy}
                    onPress={() =>
                      run(async () => {
                        await engine.current.select(sheet.volume);
                        setSheet(null);
                        await engine.current.sync();
                      })
                    }
                  />
                </>
              )}
              {sheet.kind === "conflict" && (
                <>
                  <Text style={s.text}>
                    Choose which version to use for the original file.
                  </Text>
                  {[
                    ["original", "Original file", sheet.original],
                    ["conflict", "Conflict copy", sheet.conflict],
                  ].map(([choice, label, row]) => (
                    <Pressable
                      key={choice}
                      accessibilityRole="radio"
                      accessibilityLabel={`${label}, ${row.path}`}
                      accessibilityState={{
                        checked: sheet.choice === choice,
                        disabled: locked || !!row.deleted,
                      }}
                      disabled={locked || !!row.deleted}
                      onPress={() => setSheet({ ...sheet, choice })}
                      style={[
                        s.card,
                        s.conflictChoice,
                        sheet.choice === choice && s.conflictChoiceSelected,
                      ]}
                    >
                      <View style={s.row}>
                        <Icon
                          name={sheet.choice === choice ? "check" : "file"}
                        />
                        <Text style={s.rowTitle}>{label}</Text>
                      </View>
                      <Text style={s.mono}>{row.path}</Text>
                      <Text style={s.caption}>
                        {row.deleted ? "Deleted" : bytes(row.size)} ·{" "}
                        {date(row.created)} · rev {row.rev}
                      </Text>
                    </Pressable>
                  ))}
                  <Text style={s.caption}>
                    Restoring creates a new revision. Both source versions and
                    the conflict copy are kept.
                  </Text>
                  <Button
                    primary
                    label="Restore selected as new revision"
                    busy={busy}
                    disabled={!connected || locked}
                    onPress={() =>
                      run(() => chooseConflict(sheet.choice), {
                        label: "Restoring selected version…",
                        success:
                          "Selected version restored. Source versions kept.",
                      })
                    }
                  />
                  <Button
                    quiet
                    label="Keep both as they are"
                    disabled={locked}
                    onPress={() => setSheet(sheet.returnTo || null)}
                  />
                </>
              )}
            </Sheet>
          )}
        </View>
      </Design.Provider>
    </SafeAreaProvider>
  );
}
