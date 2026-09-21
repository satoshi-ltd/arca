import { StickyDetailSide } from "./StickyDetailSide";
import * as Application from "expo-application";
import { textSizes, textScale } from "./text-size.js";
import { coalescedRefresh, retainSnapshot } from "./ui-refresh.js";
import { fileIcon } from "../../desktop/src/file-icons.js";
import { native } from "./private-network.js";
import { canContinueInBackground } from "./runtime";
import { BrandActivity, Busy, Scaffold } from "./components";
import { GallerySetup } from "./GallerySource";
import { uploadStatus } from "./gallery-timeline";
import { galleryConfig } from "./gallery.js";
import { Section } from "./components";
import { ConfirmDialog } from "./components";
import { useRetained } from "./motion";
import { subscribeNotificationResponse } from "./runtime";
import { NoticeStack, ErrorNotice } from "./Notice";
import {
  createNoticeStore,
  errorNotice,
  conditionNotices,
} from "../../desktop/src/notice-contract.js";
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
  Platform,
  StatusBar,
  useWindowDimensions,
  Dimensions,
  Linking,
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
  ScreenTitle,
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
  ApprovalSheet,
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
import { FolderGallery } from "./FolderGallery";
import { FolderRecent } from "./FolderRecent";
import { sidebarLayout, fileMenuPosition } from "./layout";
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
  const fileMenuTrigger = useRef(null);
  const pageRoot = useRef(null);
  layout.current = sidebarLayout(
    layout.current,
    width,
    keyboardVisible ? Dimensions.get("screen").height : height,
  );
  const wide = layout.current;
  const compactAndroid = Platform.OS === "android" && !wide;
  const compact = wide && width < 1100;
  const s = useMemo(
    () => styles(c, wide, compact, fontScale, textScale(prefs.textSize)),
    [c, wide, compact, fontScale, prefs.textSize],
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
    [renameName, setRenameName] = useState(""),
    [fileActionsOpen, setFileActionsOpen] = useState(false),
    [fileMenuStyle, setFileMenuStyle] = useState(null),
    [deviceName, setDeviceName] = useState(null),
    [history, setHistory] = useState({ versions: [], next: null }),
    [historyLoading, setHistoryLoading] = useState(false),
    [historyError, setHistoryError] = useState(""),
    [historyVolume, setHistoryVolume] = useState(""),
    [historyFilter, setHistoryFilter] = useState("revisions");
  const historyRequest = useRef(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [recentLoading, setRecentLoading] = useState(false);
  const folderLists = useRef(new Map());
  const [detailError, setDetailError] = useState("");
  const [fileHistory, setFileHistory] = useState({ versions: [], next: null });
  const updateQueue = useRef(null);
  const freeSpaceSample = useRef({ at: 0, value: null });
  function update() {
    updateQueue.current ||= coalescedRefresh(readSnapshot);
    return updateQueue.current();
  }
  async function readSnapshot() {
    const r = engine.current;
    if (!r || !mounted.current) return;
    const [folders, last, notifications, background, theme, free, textSize] =
      await Promise.all([
        r.scope ? r.store.folders(r.scope) : [],
        r.store.get(`lastSync:${r.scope}`),
        r.store.get("notifications", false),
        r.store.get("background", false),
        r.store.get("theme", "system"),
        Date.now() - freeSpaceSample.current.at < 30000
          ? freeSpaceSample.current.value
          : r.files.free().then((value) => {
              freeSpaceSample.current = { at: Date.now(), value };
              return value;
            }),
        r.store.get("textSize", 1),
      ]);
    if (!mounted.current) return;
    setState((old) => retainSnapshot(old, client.state()));
    setLocals((old) => retainSnapshot(old, folders));
    setStatus((old) =>
      retainSnapshot(old, {
        busy: r.busy,
        syncingVolume: r.syncingVolume,
        picking: !!r.picking,
        importing: !!r.importing,
        paused: r.paused,
        progress: r.progress,
        error: r.error,
        last,
        free,
      }),
    );
    const onboarding = await r.store.get("onboarding");
    if (!mounted.current) return;
    setPrefs((old) =>
      retainSnapshot(old, {
        notifications,
        background,
        theme,
        textSize: textScale(textSize),
        onboarding,
      }),
    );
  }
  function startSync(force = false) {
    const replica = engine.current;
    if (!replica) return;
    void replica.sync(force).catch((error) => {
      if (mounted.current) setError(error.message || "Synchronization failed.");
    });
  }
  async function listFiles(id = folder?.id) {
    if (!id || !engine.current) return;
    const request = ++fileRequest.current;
    const r = engine.current;
    const scope = r.scope;
    const key = `${scope}:${id}`;
    const known = folderLists.current.get(key);
    setEntries(known || []);
    setFilesLoading(true);
    try {
      if (!known) {
        const cached = await r.store
          .get(`gallery-list:${scope}:${id}`, [])
          .catch(() => []);
        if (
          mounted.current &&
          request === fileRequest.current &&
          scope === r.scope
        )
          setEntries(cached);
      }
      const list = [];
      const root = r.files.folder(scope, id);
      if (await r.files.exists(root))
        for await (const e of r.files.walk(root)) list.push(e);
      if (
        mounted.current &&
        request === fileRequest.current &&
        scope === r.scope
      ) {
        const sorted = list.sort((a, b) => a.path.localeCompare(b.path));
        folderLists.current.set(key, sorted);
        while (folderLists.current.size > 20)
          folderLists.current.delete(folderLists.current.keys().next().value);
        setEntries(sorted);
        await r.store
          .set(`gallery-list:${scope}:${id}`, sorted.slice(0, 2000))
          .catch(() => {});
      }
    } finally {
      if (mounted.current && request === fileRequest.current)
        setFilesLoading(false);
    }
  }
  const notices = useMemo(() => createNoticeStore(), []);
  const [photoCount, setPhotoCount] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [shownConfirmation, releaseConfirmation] = useRetained(confirmation);
  function ask(title, message, label = title, icon) {
    return new Promise((resolve) =>
      setConfirmation({ title, message, label, icon, resolve }),
    );
  }
  function confirm(title, message, action, label = title, cancel) {
    ask(title, message, label).then((ok) => (ok ? action() : cancel?.()));
  }
  const settle = (ok) => {
    const current = confirmation;
    setConfirmation(null);
    current?.resolve(ok);
  };
  const [timelineDemand, setTimelineDemand] = useState(0);
  const nearEnd = useRef(false);
  const [noticeItems, setNoticeItems] = useState([]);
  useEffect(() => {
    const off = notices.subscribe(() => setNoticeItems(notices.snapshot()));
    return () => {
      off();
      notices.dispose();
    };
  }, [notices]);
  const retryAction = useRef(null);
  useEffect(() => {
    if (success) notices.push({ kind: "info", title: success });
  }, [success, notices]);
  async function run(work, options = {}) {
    if (action.current) {
      if (!options.silent)
        notices.push({
          kind: "info",
          title: "Another action is still running.",
        });
      return;
    }
    action.current = true;
    retryAction.current = null;
    setBusy(true);
    setActionLabel(options.silent ? "" : options.label || "Working…");
    setSuccess("");
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
    } finally {
      action.current = false;
      if (mounted.current) {
        setBusy(false);
        setActionLabel("");
        void update().catch((e) => {
          if (mounted.current)
            setError(e.message || "Could not refresh this view.");
        });
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    let updateTimer;
    const unsub = subscribe(() => {
      if (updateTimer) return;
      updateTimer = setTimeout(() => {
        updateTimer = null;
        update().catch(() => {});
      }, 100);
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
      else if (!canContinueInBackground()) engine.current?.stop();
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
    if (!folder || !engine.current) return;
    listFiles(folder.id).catch((e) => setError(e.message));
    return () => {
      fileRequest.current++;
    };
  }, [folder?.id, status.busy, status.syncingVolume, status.last]);
  const connection = state.connection,
    connected = connection?.linked,
    catalog = state.catalog,
    volumes = catalog?.volumes || [];
  const [webApproval, setWebApproval] = useState(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  useEffect(() => {
    if (!connected) {
      setWebApproval(null);
      return;
    }
    let active = true,
      pending = false;
    const check = async () => {
      if (!active || pending || AppState.currentState !== "active") return;
      pending = true;
      try {
        const data = await client.api("/v1/web-approvals");
        if (active) setWebApproval(data.requests[0] || null);
      } catch {
        if (active) setWebApproval(null);
      } finally {
        pending = false;
      }
    };
    check();
    const timer = setInterval(check, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connected, connection?.hubId]);
  const answerWebApproval = async (decision) => {
    if (!webApproval || approvalBusy) return;
    setApprovalBusy(true);
    setApprovalError("");
    try {
      await client.api("/v1/web-approvals", { id: webApproval.id, decision });
      setWebApproval(null);
    } catch (error) {
      setApprovalError(error.message);
    } finally {
      setApprovalBusy(false);
    }
  };
  const currentFolder = locals.find((f) => f.id === folder?.id);
  const historyRetention =
    catalog?.volumes?.find((v) => v.id === folder?.id)?.historyRetention ??
    "1m";
  const retentionLabel =
    {
      off: "Off",
      "1d": "On · 1 day",
      "1w": "On · 1 week",
      "1m": "On · 30 days",
      forever: "Forever",
    }[historyRetention] || "On · 30 days";
  const sourceConfig = galleryConfig(currentFolder);
  const source = sourceConfig
    ? { ...sourceConfig, issue: currentFolder.issue || sourceConfig.issue }
    : null;
  const photoFolder =
    !!folder &&
    !!(
      source ||
      folder.gallery ||
      catalog?.volumes?.find((v) => v.id === folder.id)?.gallery
    );
  const onboarding = (!connection && !catalog) || !!prefs.onboarding;
  const onboardingStep = connection
    ? "folders"
    : prefs.onboarding
      ? "pair"
      : "welcome";
  useEffect(
    () => setFileActionsOpen(false),
    [sheet?.kind, sheet?.path, width, height],
  );
  const historyDetail = sheet?.kind === "history";
  const detail = historyDetail;
  const [shownSheet, releaseSheet] = useRetained(
    sheet && !detail ? sheet : null,
  );
  const screen = onboarding ? "Onboarding" : detail ? "File detail" : view;
  const screenDepth = detail ? 2 : folder && screen === "Folders" ? 1 : 0;
  const lastDepth = useRef(screenDepth);
  const screenEnter =
    screenDepth > lastDepth.current
      ? "forward"
      : screenDepth < lastDepth.current
        ? "back"
        : "fade";
  useEffect(() => {
    lastDepth.current = screenDepth;
  }, [screenDepth]);
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
  const actionLocked = busy || !engine.current;
  const locked = actionLocked || status.busy;
  async function openFolder(f) {
    setEntries(
      folderLists.current.get(`${engine.current?.scope}:${f.id}`) || [],
    );
    setFolder(f);
    setPhotoCount(null);
    setTimelineDemand(0);
    nearEnd.current = false;
    setSearchOpen(false);
    setFileView(
      (f.gallery || catalog?.volumes?.find((v) => v.id === f.id)?.gallery) &&
        !galleryConfig(f)
        ? "gallery"
        : "files",
    );
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
      localEntry: entry.uri ? entry : null,
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
  async function openMedia(item) {
    if (item.uri && typeof native.openFile === "function") {
      await native.openFile(item.uri);
      return;
    }
    await openFileDetail(item);
  }
  function deleteMedia(item) {
    return new Promise((resolve) =>
      confirm(
        "Delete this photo?",
        "Deletes from synced folders. Originals in a phone’s system gallery are kept. Recovery depends on this folder’s revision retention." +
          (!connected || status.paused
            ? " Deletion will sync when connected and resumed."
            : ""),
        () =>
          run(
            async () => {
              await engine.current.removeFile(folder.id, item.path);
              resolve(true);
              await listFiles();
              if (connected && !status.paused) startSync();
            },
            { success: "Photo deleted" },
          ).then(() => resolve(false)),
        "Delete photo",
        () => resolve(false),
      ),
    );
  }
  async function shareMedia(item) {
    if (!(await Sharing.isAvailableAsync()))
      throw new Error("Sharing is unavailable on this device.");
    await Sharing.shareAsync(item.uri);
  }
  async function currentFileURI() {
    const uri = engine.current.files.work(
      engine.current.scope,
      sheet.volume,
      sheet.path,
    );
    if (!(await engine.current.files.exists(uri)))
      throw new Error("This file is not available locally yet.");
    return uri;
  }
  async function openCurrentFile() {
    if (typeof native.openFile !== "function")
      throw new Error(
        "Install the updated Arca app to open files. You can still use Share from the file menu.",
      );
    const result = await native.openFile(await currentFileURI());
    if (result === "install-permission")
      Alert.alert(
        "Allow APK installation",
        "To open this APK, allow Arca under Install unknown apps in Android Settings. Then return here and tap Open again.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Open settings",
            onPress: () => run(() => native.openInstallSettings()),
          },
        ],
      );
  }
  async function shareCurrentFile() {
    const uri = await currentFileURI();
    if (!(await Sharing.isAvailableAsync()))
      throw new Error("Sharing is unavailable on this device.");
    await Sharing.shareAsync(uri);
  }
  async function imported(kind) {
    const replica = engine.current;
    try {
      await replica.withImportPicker(async () => {
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
        if (kind === "photos" && source) {
          await replica.gallery.addPhotos(folder.id, result.assets);
        } else {
          for (const asset of result.assets)
            await replica.importFile(
              folder.id,
              directory +
                (asset.name || asset.fileName || `photo-${Date.now()}.jpg`),
              asset.uri,
            );
          await listFiles();
        }
      });
    } finally {
      if (connected && !status.paused) startSync();
    }
  }
  function choose(v) {
    setSheet({ kind: "select", volume: v });
  }
  function configureGallery(options) {
    const save = () =>
      run(
        async () => {
          await engine.current.gallery.configure(folder.id, options, true);
          setSheet(null);
          await listFiles();
          startSync();
        },
        { label: source ? "Saving changes…" : "Enabling uploads…" },
      );
    if (source) {
      save();
      return;
    }
    confirm(
      "Enable photo uploads?",
      "Replaces this phone’s Arca copy with gallery uploads. Only verified local files are removed. Photos and hub files are kept.",
      save,
      "Enable uploads",
    );
  }
  function unlink() {
    const target = folder;
    const gallery = galleryConfig(locals.find((f) => f.id === target.id));
    const sourceOnly = gallery?.mode === "source";
    const message = sourceOnly
      ? "Stops photo uploads and removes the link to this album. Photos on this phone, uploaded files and hub history are kept. Linking again may upload photos again."
      : "Removes this folder’s Arca copy from this phone. Hub files and history are kept. Unsynced local changes will be lost; use Export folder first to keep them.";
    confirm(
      "Stop syncing?",
      message,
      () =>
        run(
          async () => {
            await engine.current.unselect(target.id);
            setSheet(null);
            setFolder(null);
            setView("Folders");
          },
          { label: "Stopping sync…" },
        ),
      "Stop syncing",
    );
  }
  function destroy() {
    confirm(
      "Destroy this replica?",
      "Permanently deletes all downloaded folders and unsynced changes, credentials, selections, index, queues and caches. Arca returns to first-run setup. Hub files and history and other machines are kept. This cannot be undone. Works offline. If the hub cannot be reached, remove this machine from its Machines list separately.",
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
  const visibleEntries = useMemo(
    () => browseEntries(entries, directory, search),
    [entries, directory, search],
  );
  const entrySummary = useMemo(
    () => ({
      files: entries.filter((entry) => !entry.directory).length,
      bytes: entries.reduce((total, entry) => total + (entry.size || 0), 0),
    }),
    [entries],
  );
  const timelineNotice = source
    ? ["Needs attention", "Disabled"].find(
        (state) =>
          state ===
          uploadStatus(source, {
            connected,
            paused: status.paused,
            busy: status.busy,
          }),
      ) || ""
    : currentFolder?.issue || status.error
      ? "Needs attention"
      : "";
  const timeline =
    folder && engine.current ? (
      <FolderGallery
        key={folder.id}
        api={galleryAPI}
        connected={connected}
        store={engine.current.store}
        scope={engine.current.scope}
        volume={folder.id}
        entries={entries}
        loading={filesLoading}
        columns={wide ? 6 : 4}
        refreshKey={status.last}
        demand={timelineDemand}
        onSummary={({ count }) => setPhotoCount(count)}
        uploads={
          source
            ? {
                store: engine.current.store,
                media: engine.current.gallery.media,
                summary: source.summary,
                scannedAt: source.scannedAt,
              }
            : null
        }
        notice={timelineNotice}
        folderName={folder.name}
        open={(item) => openMedia(item).catch((e) => setError(e.message))}
        history={(item) => openFileDetail(item)}
        share={(item) => shareMedia(item).catch((e) => setError(e.message))}
        remove={!source && currentFolder?.selected ? deleteMedia : null}
      />
    ) : null;
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
    const volume = sheet.volume;
    const previous = sheet.returnTo;
    setSheet(previous || null);
    startSync();
    if (previous?.kind === "history") await getHistory(previous);
    notices.push({
      kind: "info",
      title: "Selected version restored. Source versions kept.",
      action: "show",
      actionLabel: "Show",
      volume,
    });
    if (folder) await listFiles();
  }
  async function restore(row) {
    confirm(
      "Restore this revision?",
      "The hub creates a new revision. It will synchronize to every selected copy.",
      () =>
        run(async () => {
          const restored = await client.api("/v1/restore", {
            volume: row.volume,
            path: row.path,
            rev: row.rev,
          });
          startSync();
          if (folder) await listFiles();
          await getHistory(sheet?.kind === "history" ? sheet : null);
          notices.push({
            kind: "info",
            title: `Restored ${row.path}${restored.rev ? ` as rev ${restored.rev}` : ""}`,
            action: "show",
            actionLabel: "Show",
            volume: row.volume,
          });
        }),
      "Restore",
    );
  }
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (fileActionsOpen) {
        setFileActionsOpen(false);
        return true;
      }
      if (sheet) {
        historyRequest.current++;
        setSheet(
          ["conflict", "rename-file"].includes(sheet.kind)
            ? sheet.returnTo || null
            : null,
        );
        return true;
      }
      if (folder && view === "Folders") {
        setFolder(null);
        return true;
      }
      return false;
    });
    return () => listener.remove();
  }, [sheet, folder, view, fileActionsOpen]);
  const selectTab = (tab) => {
    historyRequest.current++;
    setView(tab);
    setSheet(null);
  };
  const showError = error || status.error;
  useEffect(() => {
    const conditions = conditionNotices({
      error: status.error,
      hubName: state.catalog?.name,
      catalog: state.catalog,
      volumes: locals,
    });
    notices.reconcile(conditions);
    if (error)
      notices.push(
        errorNotice(error, {
          id: "action",
          hubName: state.catalog?.name,
          action: retryAction.current ? "retry" : null,
        }),
      );
    else notices.clear("action");
  }, [error, status.error, locals, state.catalog, notices]);
  const noticeAction = (item) => {
    if (item.action === "review" || item.action === "show") {
      setView("History");
      setHistoryVolume(item.volume || "");
      setHistoryFilter(item.action === "review" ? "conflicts" : "revisions");
      setSheet(null);
    } else if (item.action === "folder") {
      const target = locals.find((f) => f.id === item.volume);
      setView("Folders");
      setSheet(null);
      if (target) openFolder(target).catch((e) => setError(e.message));
      else setFolder(null);
    } else if (item.action === "pair") {
      setView("Settings");
      setSheet(null);
    } else if (item.id === "action" && retryAction.current)
      retryAction.current();
    else startSync();
  };
  useEffect(
    () =>
      subscribeNotificationResponse((item) => {
        if (item.action === "retry" && item.execute) startSync();
        if (item.action === "review") {
          setView("History");
          setHistoryVolume(item.volume || "");
          setHistoryFilter("conflicts");
        } else {
          setView(
            item.action === "pair" || item.action === "backup"
              ? "Settings"
              : "Folders",
          );
          if (item.volume)
            setFolder(locals.find((f) => f.id === item.volume) || null);
        }
        setSheet(null);
      }),
    [locals],
  );
  const opening =
    (!fonts && !fontError) || (!engine.current && busy && !showError);
  useEffect(() => {
    if (!opening) SplashScreen.hideAsync().catch(() => {});
  }, [opening]);
  if (opening)
    return (
      <SafeAreaProvider>
        <Design.Provider
          value={{
            s,
            c,
            wide,
            active:
              busy ||
              status.busy ||
              detailLoading ||
              historyLoading ||
              !!(folder && (filesLoading || recentLoading)),
          }}
        >
          <SafeAreaView style={s.root}>
            <View style={s.content}>
              <Text style={s.heading}>Arca</Text>
              <Scaffold label="Opening Arca" />
            </View>
          </SafeAreaView>
        </Design.Provider>
      </SafeAreaProvider>
    );
  const renameCurrentFile =
    sheet?.localEntry && sheet.path !== ".arcaignore"
      ? () => {
          setRenameName(sheet.path.split("/").at(-1));
          setError("");
          setSheet({
            kind: "rename-file",
            path: sheet.path,
            returnTo: sheet,
          });
        }
      : null;
  const deleteCurrentFile = sheet?.localEntry
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
                await engine.current.removeFile(target.volume, target.path);
                setSheet(null);
                if (folder) await listFiles();
                if (connected && !status.paused) startSync();
              },
              { success: "File deleted" },
            ),
          "Delete file",
        )
    : null;
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
      <Design.Provider
        value={{
          s,
          c,
          wide,
          active:
            busy ||
            status.busy ||
            detailLoading ||
            historyLoading ||
            !!(folder && (filesLoading || recentLoading)),
        }}
      >
        <View ref={pageRoot} style={s.root} collapsable={false}>
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
                  <View
                    style={[
                      s.viewHeader,
                      (detail || (folder && screen === "Folders")) &&
                        s.detailViewHeader,
                    ]}
                  >
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
                      <View
                        style={[
                          s.row,
                          !detail &&
                            !(folder && view === "Folders") &&
                            s.screenHeader,
                        ]}
                      >
                        <View style={s.flex}>
                          {detail ? (
                            <View style={s.row}>
                              {!wide && <BrandActivity />}
                              {!compactAndroid && (
                                <View style={[s.tile, wide && s.detailTile]}>
                                  <Icon name={fileIcon(sheet.path)} />
                                </View>
                              )}
                              <View style={[s.flex, s.stack]}>
                                <Text
                                  accessibilityRole="header"
                                  style={
                                    compactAndroid ? s.detailTitle : s.title
                                  }
                                >
                                  {sheet.path.split("/").pop()}
                                </Text>
                              </View>
                            </View>
                          ) : folder && view === "Folders" ? (
                            <ScreenTitle
                              detail={compactAndroid}
                              contentIcon={
                                wide
                                  ? folder.gallery || source
                                    ? "gallery"
                                    : "folder"
                                  : undefined
                              }
                              subtitle={
                                photoFolder
                                  ? `${photoCount ?? "—"} photos · ${source ? `${source.summary?.bytes == null ? "—" : bytes(source.summary.bytes)} uploaded` : `${bytes(entrySummary.bytes)} local`}${status.paused ? " · Paused" : ""}`
                                  : `${entrySummary.files} files · ${bytes(entrySummary.bytes)} local${status.paused ? " · Paused" : ""}`
                              }
                            >
                              {folder.name}
                            </ScreenTitle>
                          ) : (
                            <ScreenTitle>{view}</ScreenTitle>
                          )}
                        </View>
                        {historyDetail && (
                          <View style={s.rowAction}>
                            <Button
                              label="Open"
                              icon="external"
                              iconOnly={!wide}
                              disabled={actionLocked || !sheet.localEntry}
                              onPress={() => run(openCurrentFile)}
                            />
                            <View>
                              <Pressable
                                ref={fileMenuTrigger}
                                accessibilityRole="button"
                                accessibilityLabel="File actions"
                                accessibilityState={{
                                  expanded: fileActionsOpen,
                                  disabled: actionLocked,
                                }}
                                disabled={actionLocked}
                                style={[
                                  s.button,
                                  s.iconButton,
                                  actionLocked && s.disabled,
                                ]}
                                onPress={() => {
                                  if (fileActionsOpen) {
                                    setFileActionsOpen(false);
                                    return;
                                  }
                                  fileMenuTrigger.current?.measureInWindow(
                                    (x, y, width, height) => {
                                      pageRoot.current?.measureInWindow(
                                        (rootX, rootY, rootWidth) => {
                                          setFileMenuStyle(
                                            fileMenuPosition(
                                              x - rootX,
                                              y - rootY,
                                              width,
                                              height,
                                              rootWidth,
                                            ),
                                          );
                                          setFileActionsOpen(true);
                                        },
                                      );
                                    },
                                  );
                                }}
                              >
                                <Icon name="more" />
                              </Pressable>
                            </View>
                          </View>
                        )}
                        {folder && screen === "Folders" && (
                          <View style={s.rowAction}>
                            {!wide && !photoFolder && fileView === "files" && (
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
                            activity={status.busy}
                            disabled={status.paused || !engine.current}
                            onPress={() => startSync(true)}
                          />
                        )}
                      </View>
                    )}
                    {screen === "History" && !wide && historyControls}
                  </View>
                )}
                <IncomingShare
                  connection={connection}
                  name={catalog?.name}
                  machine={machines?.find((m) => m.isHub)}
                  catalog={catalog}
                  locals={locals.filter((f) => !galleryConfig(f))}
                  onSaved={update}
                />
                <KeyboardScrollView
                  key={`${screen}:${folder?.id || ""}`}
                  onScroll={(event) => {
                    const { contentOffset, layoutMeasurement, contentSize } =
                      event.nativeEvent;
                    const near =
                      contentOffset.y + layoutMeasurement.height >
                      contentSize.height - 1200;
                    if (near !== nearEnd.current) {
                      nearEnd.current = near;
                      if (near) setTimelineDemand((n) => n + 1);
                    }
                  }}
                  style={s.scroll}
                  contentContainerStyle={[
                    s.content,
                    !onboarding && s.viewBody,
                    onboarding && s.setup,
                  ]}
                  keyboardShouldPersistTaps="handled"
                  enter={screenEnter}
                  enterStyle={[s.enter, onboarding && s.enterSetup]}
                >
                  {folder && screen === "Folders" && !photoFolder && (
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
                        ["Revision history", retentionLabel],
                      ].map(([label, value]) => (
                        <View key={label} style={s.statCell}>
                          <Text style={s.caption}>{label}</Text>
                          <Text style={s.statValue}>{value}</Text>
                        </View>
                      ))}
                    </View>
                  )}
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
                                startSync();
                              })
                            }
                          />
                        </Card>
                      )}
                      {folder ? (
                        photoFolder ? (
                          timeline
                        ) : (
                          <View style={s.detailGrid}>
                            <View style={s.detailMain}>
                              <View style={s.folderToolbar}>
                                <View style={!wide && s.flex}>
                                  <SegmentedControl
                                    options={[
                                      { label: "Files", value: "files" },
                                      { label: "Recent", value: "recent" },
                                      { label: "Gallery", value: "gallery" },
                                    ]}
                                    value={fileView}
                                    onChange={(value) => {
                                      setFileView(value);
                                      setVisibleCount(100);
                                    }}
                                  />
                                </View>
                                {wide && !source && fileView === "files" && (
                                  <Button
                                    size="small"
                                    iconOnly
                                    label={
                                      searchOpen
                                        ? "Close search"
                                        : "Search files"
                                    }
                                    icon={searchOpen ? "close" : "search"}
                                    onPress={() => {
                                      setSearchOpen(!searchOpen);
                                      setSearch("");
                                      setVisibleCount(100);
                                    }}
                                  />
                                )}
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
                              {fileView === "gallery" ? (
                                timeline
                              ) : fileView === "recent" ? (
                                <FolderRecent
                                  volume={folder.id}
                                  scope={engine.current?.scope}
                                  onLoading={setRecentLoading}
                                  connected={connected}
                                  updated={status.last}
                                  date={date}
                                  open={(row) =>
                                    getHistory({
                                      volume: folder.id,
                                      path: row.path,
                                    }).catch((e) => setError(e.message))
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
                                    {visibleEntries
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
                                            } else openFileDetail(e);
                                          }}
                                          style={[s.settingRow, s.separator]}
                                        >
                                          <View style={s.row}>
                                            <Icon
                                              name={fileIcon(
                                                e.path,
                                                e.directory,
                                              )}
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
                                            <Icon
                                              name="chevron"
                                              color={c.mute}
                                            />
                                          </View>
                                        </Pressable>
                                      ))}
                                    {filesLoading && !entries.length && (
                                      <Scaffold label="Loading files" />
                                    )}
                                    {!filesLoading &&
                                      !visibleEntries.length && (
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
                                  {visibleEntries.length > visibleCount && (
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
                              <StickyDetailSide>
                                <Section>
                                  <Text style={s.eyebrow}>LOCAL COPY</Text>
                                  <Card>
                                    <Text style={s.text}>
                                      {currentFolder?.issue
                                        ? "Sync needs attention."
                                        : currentFolder?.completed
                                          ? "Available offline."
                                          : "Keep Arca open to finish syncing."}
                                    </Text>
                                  </Card>
                                </Section>
                                <Section>
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
                                          (m.folderIds?.includes(folder.id) ||
                                            m.albumFolderIds?.includes(
                                              folder.id,
                                            )),
                                      )
                                      .map((m) => (
                                        <View
                                          key={m.machineId}
                                          style={[
                                            s.settingRow,
                                            s.row,
                                            s.separator,
                                          ]}
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
                                          <Tag>
                                            {m.albumFolderIds?.includes(
                                              folder.id,
                                            )
                                              ? "Album source"
                                              : "Replica"}
                                          </Tag>
                                        </View>
                                      ))}
                                  </View>
                                </Section>
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
                              </StickyDetailSide>
                            )}
                          </View>
                        )
                      ) : (
                        <>
                          {!!locals.length && (
                            <Section>
                              <Text style={s.eyebrow}>
                                SELECTED ON THIS DEVICE
                              </Text>
                              <View style={s.folderList}>
                                {locals.map((f) => (
                                  <FolderRow
                                    key={f.id}
                                    name={f.name}
                                    icon={
                                      galleryConfig(f) ? "gallery" : "folders"
                                    }
                                    description={
                                      galleryConfig(f)
                                        ? `${galleryConfig(f).summary?.accepted || 0} photos · ${galleryConfig(f).summary?.bytes == null ? "—" : bytes(galleryConfig(f).summary.bytes)} uploaded`
                                        : `${f.files} files · ${bytes(f.bytes)} local`
                                    }
                                    status={
                                      galleryConfig(f)
                                        ? f.issue || galleryConfig(f).issue
                                          ? "Needs attention"
                                          : !galleryConfig(f).enabled
                                            ? "Disabled"
                                            : status.paused
                                              ? "Paused"
                                              : status.busy &&
                                                  status.syncingVolume === f.id
                                                ? "Syncing"
                                                : galleryConfig(f).summary
                                                      ?.pending ||
                                                    !galleryConfig(f)
                                                      .scannedAt ||
                                                    galleryConfig(f).after
                                                  ? "Incomplete"
                                                  : "Up to date"
                                        : status.paused
                                          ? "Paused"
                                          : f.issue
                                            ? "Needs attention"
                                            : status.busy &&
                                                status.syncingVolume === f.id
                                              ? "Syncing"
                                              : f.completed
                                                ? "Up to date"
                                                : "Incomplete"
                                    }
                                    onPress={() =>
                                      openFolder(f).catch((e) =>
                                        setError(e.message),
                                      )
                                    }
                                  />
                                ))}
                              </View>
                            </Section>
                          )}
                          {volumes.some(
                            (v) => !locals.some((f) => f.id === v.id),
                          ) && (
                            <Section>
                              <Text style={s.eyebrow}>
                                ON HUB · NOT SELECTED
                              </Text>
                              <View style={s.folderList}>
                                {volumes
                                  .filter(
                                    (v) => !locals.some((f) => f.id === v.id),
                                  )
                                  .map((v) => (
                                    <FolderRow
                                      key={v.id}
                                      name={v.name}
                                      available
                                      description={`${v.files} files · ${bytes(v.bytes)}`}
                                      disabled={!connected || actionLocked}
                                      onPress={() => choose(v)}
                                    />
                                  ))}
                              </View>
                            </Section>
                          )}
                          {connected && !catalog && (
                            <Scaffold dashed label="Loading shared folders" />
                          )}
                          {!locals.length &&
                            !volumes.length &&
                            (!connected || catalog) && (
                              <Card title="No folders yet">
                                <Text style={s.text}>
                                  Shared folders from your hub appear here.
                                </Text>
                              </Card>
                            )}
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
                      retry={() =>
                        getHistory(sheet).catch((e) =>
                          setDetailError(e.message),
                        )
                      }
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
                      locked={actionLocked}
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
                      loadMore={() =>
                        getHistory(sheet, true).catch((e) =>
                          setDetailError(e.message),
                        )
                      }
                      openFolder={
                        locals.some((f) => f.id === sheet.volume)
                          ? () => {
                              const target = locals.find(
                                (f) => f.id === sheet.volume,
                              );
                              setSheet(null);
                              setView("Folders");
                              openFolder(target).catch((e) =>
                                setError(e.message),
                              );
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
                      busy={actionLocked}
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
                      {connection ? (
                        <Section>
                          <Text style={s.eyebrow}>HUB CONNECTION</Text>
                          {!machines && <Scaffold label="Loading machines" />}
                          <HubConnection
                            connection={connection}
                            name={catalog?.name}
                            machine={machines?.find((m) => m.isHub)}
                            busy={actionLocked}
                            disconnect={disconnect}
                            retry={() => run(() => client.refresh())}
                          />
                        </Section>
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
                            placeholder="http://192.168.1.10:17831"
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
                                const r = engine.current;
                                r.scope = client.state().connection.hubId;
                                await r.store.set("scope", r.scope);
                                startSync();
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
                          <Section>
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
                                        locals.some(
                                          (f) => f.selected && f.issue,
                                        )
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
                          </Section>
                        </>
                      )}
                    </>
                  )}
                  {screen === "History" && (
                    <>
                      {!connected && (
                        <Text style={s.text}>Connect to view hub history.</Text>
                      )}
                      {historyLoading && !history.versions.length && (
                        <Scaffold kind="history" label="Loading history" />
                      )}
                      {!historyLoading && !!historyError && (
                        <ErrorNotice
                          error={historyError}
                          retry={() =>
                            client
                              .refresh()
                              .then(() => getHistory())
                              .catch((e) => setHistoryError(e.message))
                          }
                        />
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
                            <Section key={day}>
                              <Text style={s.eyebrow}>{day.toUpperCase()}</Text>
                              <View style={s.group}>
                                {rows.map((row, index) => (
                                  <Pressable
                                    key={`${row.volume}:${row.rev}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={`View history for ${row.path}`}
                                    onPress={() =>
                                      getHistory({
                                        volume: row.volume,
                                        path: row.path,
                                      }).catch((e) => setError(e.message))
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
                                            : `${bytes(row.size)}`}
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
                            </Section>
                          ))}
                        </View>
                      )}
                      {history.next && (
                        <Button
                          label="Load older revisions"
                          busy={historyLoading}
                          onPress={() =>
                            getHistory(null, true).catch((e) =>
                              setHistoryError(e.message),
                            )
                          }
                        />
                      )}
                    </>
                  )}
                  {screen === "Settings" && (
                    <>
                      {connection && (
                        <>
                          <Section>
                            <Text style={s.eyebrow}>HUB CONNECTION</Text>
                            <HubConnection
                              connection={connection}
                              name={catalog?.name}
                              machine={machines?.find((m) => m.isHub)}
                              busy={actionLocked}
                              disconnect={disconnect}
                              retry={() => run(() => client.refresh())}
                            />
                          </Section>
                        </>
                      )}
                      <Section>
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
                                if (!reported)
                                  setError(
                                    `Name saved on this device, but not updated on the hub. ${engine.current.nameReportError || "Connect to the hub and try again."}`,
                                  );
                              });
                            }}
                          />
                        </Card>
                      </Section>
                      <Section>
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
                                  if (!v) startSync();
                                })
                              }
                            />
                          </Card>
                          <Card title="Last completed sync">
                            <Text style={s.text}>{date(status.last)}</Text>
                          </Card>
                        </SettingsGroup>
                      </Section>
                      <Section>
                        <Text style={s.eyebrow}>MOBILE PREFERENCES</Text>
                        <SettingsGroup>
                          <Card>
                            <Toggle
                              label="Background refresh"
                              description="When the system allows. Open Arca to continue immediately."
                              value={!!prefs.background}
                              disabled={busy}
                              onChange={(v) => run(() => setBackground(v))}
                            />
                          </Card>
                          {Platform.OS === "android" && (
                            <Card
                              title="Photo uploads"
                              actions={
                                <Button
                                  label="Open app settings"
                                  onPress={() =>
                                    run(() => Linking.openSettings())
                                  }
                                />
                              }
                            >
                              <Text style={s.caption}>
                                On Samsung, set Battery to Unrestricted and keep
                                Arca out of Sleeping apps.
                              </Text>
                            </Card>
                          )}
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
                      </Section>
                      <Section>
                        <Text style={s.eyebrow}>STORAGE</Text>
                        <Card title={`${bytes(status.free)} free`}>
                          <Text style={s.text}>
                            Selected files are stored persistently on this
                            device.
                          </Text>
                          {Platform.OS === "ios" && (
                            <Text style={s.caption}>
                              Find Arca under On My iPhone in the Files app.
                            </Text>
                          )}
                        </Card>
                      </Section>
                      <Section>
                        <Text style={s.eyebrow}>SERVICE</Text>
                        <SettingsGroup>
                          <Card
                            title={`Arca v${Application.nativeApplicationVersion || config.expo.version}`}
                            actions={
                              <Button
                                label="Copy diagnostics"
                                icon="copy"
                                onPress={() =>
                                  native
                                    .copyText(
                                      JSON.stringify(
                                        {
                                          appVersion:
                                            Application.nativeApplicationVersion,
                                          build: Application.nativeBuildVersion,
                                          bundleVersion: config.expo.version,
                                          platform: Platform.OS,
                                          osVersion: Platform.Version,
                                          machineId: connection?.id || null,
                                          linked: !!connected,
                                          paused: !!status.paused,
                                        },
                                        null,
                                        2,
                                      ),
                                    )
                                    .then(() =>
                                      notices.push({
                                        kind: "info",
                                        title: "Diagnostics copied",
                                      }),
                                    )
                                    .catch((e) => setError(e.message))
                                }
                              />
                            }
                          >
                            <Text style={s.caption}>
                              Build{" "}
                              {Application.nativeBuildVersion || "Unknown"} ·{" "}
                              {Platform.OS === "ios" ? "iOS" : "Android"}{" "}
                              {String(Platform.Version)}
                            </Text>
                          </Card>
                          <Card title="Runtime">
                            <Text style={s.text}>Mobile replica</Text>
                            <Text style={s.caption}>
                              Sync runs while Arca is open. Background activity
                              depends on this device’s permissions and system
                              limits.
                            </Text>
                          </Card>
                        </SettingsGroup>
                      </Section>
                      <Section>
                        <Text style={s.eyebrow}>APPEARANCE</Text>
                        <SettingsGroup>
                          <Card
                            title="Theme"
                            actions={
                              <SegmentedControl
                                options={["light", "dark", "system"].map(
                                  (value) => ({
                                    value,
                                    label:
                                      value[0].toUpperCase() + value.slice(1),
                                  }),
                                )}
                                value={prefs.theme || "system"}
                                onChange={(value) =>
                                  engine.current.store
                                    .set("theme", value)
                                    .then(update)
                                    .catch((e) => setError(e.message))
                                }
                              />
                            }
                          >
                            <Text style={s.caption}>
                              Use light, dark or your system appearance.
                            </Text>
                          </Card>
                          <Card
                            title="Text size"
                            actions={
                              <SegmentedControl
                                options={textSizes}
                                value={textScale(prefs.textSize)}
                                onChange={(value) =>
                                  engine.current.store
                                    .set("textSize", value)
                                    .then(update)
                                    .catch((e) => setError(e.message))
                                }
                              />
                            }
                          >
                            <Text style={s.caption}>
                              Adjust text in Arca alongside your system text
                              size. Applies to phone and Fold layouts.
                            </Text>
                          </Card>
                        </SettingsGroup>
                      </Section>
                      <Section>
                        <Text style={[s.eyebrow, s.errorText]}>
                          DANGER ZONE
                        </Text>
                        <Card
                          title="Destroy this replica"
                          danger
                          actions={
                            <Button
                              label="Destroy replica…"
                              icon="trash"
                              primary
                              danger
                              busy={actionLocked}
                              onPress={destroy}
                            />
                          }
                        >
                          <Text style={s.text}>
                            Deletes all local folders and resets Arca on this
                            device. Hub files and other machines are kept.
                          </Text>
                        </Card>
                      </Section>
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
          {(!sheet || detail) && (
            <NoticeStack
              items={noticeItems}
              onDismiss={(id) => notices.remove(id)}
              onAction={noticeAction}
              disabled={actionLocked}
            />
          )}
          {shownConfirmation && (
            <ConfirmDialog
              title={shownConfirmation.title}
              message={shownConfirmation.message}
              label={shownConfirmation.label}
              icon={
                shownConfirmation.icon ||
                (/delete/i.test(shownConfirmation.label)
                  ? "trash"
                  : /stop syncing|unlink|remove/i.test(shownConfirmation.label)
                    ? "unlink"
                    : "alert")
              }
              destructive={/destroy|delete|stop syncing|remove/i.test(
                shownConfirmation.label,
              )}
              closing={!confirmation}
              onExited={releaseConfirmation}
              onConfirm={() => settle(true)}
              onCancel={() => settle(false)}
            />
          )}
          {webApproval && !sheet && !status.picking && !status.importing && (
            <ApprovalSheet
              request={webApproval}
              hubName={catalog?.name || "hub"}
              busy={approvalBusy}
              error={approvalError}
              onDecision={answerWebApproval}
            />
          )}
          {shownSheet && (
            <Sheet
              closing={!sheet || detail}
              onExited={releaseSheet}
              overlay={
                <NoticeStack
                  items={noticeItems.filter((n) => n.kind === "info")}
                  onDismiss={(id) => notices.remove(id)}
                  onAction={noticeAction}
                  disabled={actionLocked}
                />
              }
              title={
                shownSheet.kind === "rename-file"
                  ? "Rename file"
                  : shownSheet.kind === "gallery"
                    ? "Photo uploads"
                    : shownSheet.kind === "history-filter"
                      ? "Shared folder"
                      : shownSheet.kind === "folder-actions"
                        ? folder.name
                        : shownSheet.kind === "select"
                          ? shownSheet.volume.name
                          : shownSheet.kind === "history"
                            ? shownSheet.path
                            : shownSheet.kind === "conflict"
                              ? "Resolve conflict"
                              : shownSheet.entry.path
              }
              busy={busy}
              busyLabel={actionLabel}
              onClose={() =>
                setSheet(
                  ["conflict", "rename-file"].includes(shownSheet.kind)
                    ? shownSheet.returnTo || null
                    : null,
                )
              }
            >
              {!!error && shownSheet.kind !== "folder-actions" && (
                <ErrorNotice error={error} retry={retryAction.current} />
              )}
              {shownSheet.kind === "rename-file" && (
                <View style={s.group}>
                  <Text style={s.text}>
                    The new name syncs to other copies. Earlier history stays
                    under the previous name.
                  </Text>
                  <Field
                    label="Filename"
                    value={renameName}
                    onChangeText={setRenameName}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!actionLocked}
                  />
                  <Button
                    label="Rename"
                    disabled={
                      actionLocked ||
                      !renameName ||
                      renameName === shownSheet.path.split("/").at(-1)
                    }
                    onPress={() =>
                      run(
                        async () => {
                          const target = shownSheet.returnTo;
                          await engine.current.renameFile(
                            target.volume,
                            target.path,
                            renameName,
                            target.currentRev,
                          );
                          setSheet(null);
                          if (folder) await listFiles();
                          if (connected && !status.paused) startSync();
                        },
                        { success: "File renamed" },
                      )
                    }
                  />
                </View>
              )}
              {shownSheet.kind === "gallery" && (
                <GallerySetup
                  gallery={engine.current.gallery}
                  source={source}
                  locked={actionLocked}
                  enable={configureGallery}
                />
              )}
              {shownSheet.kind === "history-filter" && (
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
              {shownSheet.kind === "folder-actions" && (
                <>
                  <View style={s.actionGroup}>
                    {!!folder.selected && !source && (
                      <ActionRow
                        label="Add files…"
                        icon="upload"
                        disabled={actionLocked}
                        onPress={() => {
                          setSheet(null);
                          run(() => imported("files"));
                        }}
                      />
                    )}
                    {!!folder.selected && !source && (
                      <ActionRow
                        label="Add photos…"
                        icon="image"
                        disabled={actionLocked}
                        onPress={() => {
                          setSheet(null);
                          run(() => imported("photos"));
                        }}
                      />
                    )}
                    {(!source || source.mode === "converting") && (
                      <ActionRow
                        label="Export folder…"
                        icon="export"
                        disabled={
                          locked || (!!source && source.mode !== "converting")
                        }
                        onPress={() => {
                          setSheet(null);
                          run(() =>
                            engine.current.withImportPicker(() =>
                              engine.current.files.exportDirectory(
                                engine.current.files.folder(
                                  engine.current.scope,
                                  folder.id,
                                ),
                                "arca-folder",
                              ),
                            ),
                          );
                        }}
                      />
                    )}
                    <ActionRow
                      label={source ? "Change album…" : "Link album…"}
                      icon="gallery"
                      disabled={
                        actionLocked ||
                        !connected ||
                        (!source &&
                          (!currentFolder?.completed || !!currentFolder?.issue))
                      }
                      onPress={() => setSheet({ kind: "gallery" })}
                    />
                    {source && (
                      <ActionRow
                        label={
                          source.enabled ? "Disable uploads" : "Enable uploads"
                        }
                        icon="upload"
                        disabled={busy || source.mode === "converting"}
                        onPress={() =>
                          run(() =>
                            engine.current.gallery.setEnabled(
                              folder.id,
                              !source.enabled,
                            ),
                          )
                        }
                      />
                    )}
                    <ActionRow
                      label="View history"
                      icon="history"
                      disabled={busy || !connected}
                      onPress={() => {
                        setHistoryVolume(folder.id);
                        setHistoryFilter("revisions");
                        setSheet(null);
                        setView("History");
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
              {shownSheet.kind === "select" && (
                <>
                  <Card title="Keep a local copy">
                    <Text style={s.text}>
                      Download this folder and keep it in sync.
                    </Text>
                    <Text style={s.caption}>
                      {bytes(shownSheet.volume.bytes)} on hub ·{" "}
                      {bytes(status.free)} free here
                    </Text>
                  </Card>
                  <Button
                    label="Select"
                    primary
                    busy={busy}
                    onPress={() =>
                      run(async () => {
                        await engine.current.select(shownSheet.volume);
                        setSheet(null);
                        startSync();
                      })
                    }
                  />
                </>
              )}
              {shownSheet.kind === "conflict" && (
                <>
                  <Text style={s.text}>
                    Choose which version to use for the original file.
                  </Text>
                  {[
                    ["original", "Original file", shownSheet.original],
                    ["conflict", "Conflict copy", shownSheet.conflict],
                  ].map(([choice, label, row]) => (
                    <Pressable
                      key={choice}
                      accessibilityRole="radio"
                      accessibilityLabel={`${label}, ${row.path}`}
                      accessibilityState={{
                        checked: shownSheet.choice === choice,
                        disabled: actionLocked || !!row.deleted,
                      }}
                      disabled={actionLocked || !!row.deleted}
                      onPress={() => setSheet({ ...shownSheet, choice })}
                      style={[
                        s.card,
                        s.conflictChoice,
                        shownSheet.choice === choice &&
                          s.conflictChoiceSelected,
                      ]}
                    >
                      <View style={s.row}>
                        <Icon
                          name={shownSheet.choice === choice ? "check" : "file"}
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
                    Both copies remain available in history.
                  </Text>
                  <Button
                    primary
                    label="Restore selected"
                    busy={busy}
                    disabled={!connected || actionLocked}
                    onPress={() =>
                      run(() => chooseConflict(shownSheet.choice), {
                        label: "Restoring selected version…",
                      })
                    }
                  />
                  <Button
                    quiet
                    label="Keep both as they are"
                    disabled={actionLocked}
                    onPress={() => setSheet(shownSheet.returnTo || null)}
                  />
                </>
              )}
            </Sheet>
          )}
          {fileActionsOpen && historyDetail && (
            <View style={s.fileMenuOverlay} pointerEvents="box-none">
              <Pressable
                style={s.fileMenuDismiss}
                accessibilityRole="button"
                accessibilityLabel="Close file actions"
                onPress={() => setFileActionsOpen(false)}
              />
              <View style={[s.fileActionMenu, fileMenuStyle]}>
                <ActionRow
                  label="Share"
                  icon="export"
                  disabled={actionLocked || !sheet.localEntry}
                  onPress={() => {
                    setFileActionsOpen(false);
                    run(shareCurrentFile);
                  }}
                />
                <ActionRow
                  label="Rename…"
                  icon="edit"
                  disabled={
                    actionLocked ||
                    !renameCurrentFile ||
                    !!fileHistory.versions[0]?.deleted
                  }
                  onPress={() => {
                    setFileActionsOpen(false);
                    renameCurrentFile?.();
                  }}
                />
                <ActionRow
                  label="Delete file…"
                  icon="trash"
                  danger
                  divider
                  disabled={
                    actionLocked ||
                    !deleteCurrentFile ||
                    !!fileHistory.versions[0]?.deleted
                  }
                  onPress={() => {
                    setFileActionsOpen(false);
                    deleteCurrentFile?.();
                  }}
                />
              </View>
            </View>
          )}
        </View>
      </Design.Provider>
    </SafeAreaProvider>
  );
}

function galleryAPI(route) {
  return client.api(route);
}
