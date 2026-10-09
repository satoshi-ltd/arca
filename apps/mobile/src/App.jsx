import { galleryVideoURI } from "./video-playback";
import { StickyDetailSide } from "./StickyDetailSide";
import * as Application from "expo-application";
import { textSizes, textScale } from "./text-size.js";
import { coalescedRefresh, retainSnapshot } from "./ui-refresh.js";
import { fileIcon } from "../../desktop/src/file-icons.js";
import { native } from "./private-network.js";
import { copyPicked } from "./incoming-files.js";
import { canContinueInBackground } from "./runtime";
import { BrandActivity, Busy, Scaffold } from "./components";
import { GallerySetup } from "./GallerySource";
import { galleryConfig } from "./gallery.js";
import { allPhotosNote, sourceAlbums } from "./validation.js";
import { historyEmpty } from "./history-empty.js";
import { clockTime, dayLabel } from "./history-days.js";
import { Section } from "./components";
import { ConfirmDialog } from "./components";
import { useRetained } from "./motion";
import { subscribeNotificationResponse } from "./runtime";
import { NoticeStack, ErrorNotice } from "./Notice";
import { crashRecord } from "./crash";
import { crashNotice } from "./crash-record";
import {
  createNoticeStore,
  errorNotice,
  conditionNotices,
  isHubUnreachable,
  HUB_ONLY_REASON,
} from "../../desktop/src/notice-contract.js";
import { Onboarding } from "./Onboarding";
import { PairingForm } from "./PairingForm";
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
  ArrivalsStrip,
  DeviceBranch,
  DeviceMapSide,
  ActionRow,
  SettingsGroup,
  SegmentedControl,
  Icon,
  Button,
  Field,
  Card,
  Tag,
  Toggle,
  Sheet,
  ApprovalSheet,
  EmptyState,
} from "./components";
import { client } from "./persistence";
import { isPickerCancelled, sourceUnavailable } from "./action-errors.js";
import { shouldStopSync } from "./transfer-session.js";
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
import { offlineFileHistory, sameDetail } from "./file-history.js";
import { IncomingShare } from "./IncomingShare";
import { GalleryDateRail } from "./GalleryDateRail";
import { FolderGallery } from "./FolderGallery";
import { coalescedRun } from "./folder-listing";
import { FolderRecent } from "./FolderRecent";
import {
  MiniPlayer,
  MusicLibrary,
  MusicSheet,
  NowPlaying,
} from "./MusicLibrary";
import { player, playerAvailable, usePlayingId } from "./music-player";
import { baseContext, musicSheet, playlistKey } from "./music-library.js";
import {
  folderLibrary,
  isMusicFolder,
  publishMusic,
  readMusicHistory,
  recordMusicPlay,
  renameMusicPlay,
} from "./music-sync.js";
import {
  failedChange,
  readLastChange,
  seededChange,
  shortName,
} from "./recent-cache";
import { sidebarLayout, fileMenuPosition } from "./layout";
import { bytes, folderSize } from "./format";
import { browseEntries } from "./browse";
import { deviceNodes } from "./device-map";
import { homeFromActivity, latestLine, newestCovers, newestImages } from "./home-data";
import { ActivityStrip, AwayBanner, DayGroup } from "./HistoryActivity";
import { FilePreview, RowThumb } from "./FilePreview";
import { awayDue, daySummary, localDay, stripBars } from "./history-activity";
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
const tabs = ["Folders", "Devices", "History", "Settings"];
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
  const openSheet = useRef(null);
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
    listing = useRef(new Map()),
    shownFolder = useRef(null);
  const [replica, setReplica] = useState(null);
  const [state, setState] = useState(client.state()),
    [view, setView] = useState("Folders"),
    [locals, setLocals] = useState([]),
    [machines, setMachines] = useState(null),
    [machinesSaved, setMachinesSaved] = useState(false),
    [machinesLoaded, setMachinesLoaded] = useState(false),
    [pickedDevice, setPickedDevice] = useState(""),
    [historyDays, setHistoryDays] = useState(null),
    [home, setHome] = useState({ arrivals: [], last: {}, previews: {} }),
    [previewEntry, setPreviewEntry] = useState(null),
    [awayNotice, setAwayNotice] = useState(null),
    [landingDay, setLandingDay] = useState(""),
    [landingReady, setLandingReady] = useState(false),
    [selectedRev, setSelectedRev] = useState(""),
    [lastChange, setLastChange] = useState(undefined),
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
    [ignorePolicy, setIgnorePolicy] = useState({ id: null, text: "" }),
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
  const [musicRoute, setMusicRoute] = useState([{ kind: "artists" }]);
  const [musicSearch, setMusicSearch] = useState(null);
  const [musicHistory, setMusicHistory] = useState([]);
  const [historyTick, setHistoryTick] = useState(0);
  const [musicData, setMusicData] = useState(null);
  const [musicEdits, setMusicEdits] = useState(0);
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
    const visibleFolders = folders.map((stored) => {
      const folder = {
        ...stored,
        changes: r.folderChanges?.get(stored.id) || 0,
      };
      const transient =
        folder.issue &&
        (errorNotice(folder.issue).offline ||
          /^(Request cancelled|Sync paused)$/.test(folder.issue));
      return transient &&
        (!r.connectionChecked || errorNotice(r.error || "").offline)
        ? { ...folder, issue: null }
        : folder;
    });
    setLocals((old) => retainSnapshot(old, visibleFolders));
    setStatus((old) =>
      retainSnapshot(old, {
        busy: r.busy,
        offline: !!r.hubUnavailable,
        syncingVolume: r.paused || r.hubUnavailable ? null : r.syncingVolume,
        picking: !!r.picking,
        importing: !!r.importing,
        paused: r.paused,
        progress: r.paused || r.hubUnavailable ? null : r.progress,
        error: r.error,
        last,
        free,
        musicTick: r.musicTick || 0,
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
  function reconnect() {
    if (status.offline) startSync();
  }
  function listFiles(id = folder?.id) {
    if (!id || !engine.current) return Promise.resolve();
    const r = engine.current;
    const scope = r.scope;
    const key = `${scope}:${id}`;
    const shown = () =>
      mounted.current && shownFolder.current === key && scope === r.scope;
    if (listing.current.has(key) && shown()) {
      setEntries(folderLists.current.get(key) || []);
      if (!folderLists.current.has(key)) setFilesLoading(true);
    }
    return coalescedRun(
      listing.current,
      key,
      async (first) => {
        if (first) {
          const known = folderLists.current.get(key);
          if (shown()) {
            setEntries(known || []);
            if (!known) setFilesLoading(true);
          }
          if (!known) {
            const cached = await r.store
              .get(`gallery-list:${scope}:${id}`, [])
              .catch(() => []);
            if (shown() && !folderLists.current.has(key)) setEntries(cached);
          }
        }
        const list = [];
        const root = r.files.folder(scope, id);
        if (await r.files.exists(root))
          for await (const e of r.files.walk(root)) list.push(e);
        const sorted = list.sort((a, b) => a.path.localeCompare(b.path));
        folderLists.current.delete(key);
        folderLists.current.set(key, sorted);
        while (folderLists.current.size > 20)
          folderLists.current.delete(folderLists.current.keys().next().value);
        if (shown()) setEntries(sorted);
        await r.store
          .set(`gallery-list:${scope}:${id}`, sorted.slice(0, 2000))
          .catch(() => {});
      },
      () => {
        if (shown()) setFilesLoading(false);
      },
    );
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
  const [galleryRailModel, setGalleryRailModel] = useState(null);
  const [galleryViewport, setGalleryViewport] = useState({ y: 0, height: 0 });
  const galleryScroll = useRef(null);
  const galleryScrollY = useRef(0);
  const galleryRail = useRef(null);
  const [noticeItems, setNoticeItems] = useState([]);
  useEffect(() => {
    const off = notices.subscribe(() => setNoticeItems(notices.snapshot()));
    return () => {
      off();
      notices.dispose();
    };
  }, [notices]);
  useEffect(() => {
    const crash = crashRecord.take();
    if (crash) notices.push(crashNotice(crash));
  }, [notices]);
  const retryAction = useRef(null);
  const errorCode = useRef({});
  const localAction = useRef(false);
  useEffect(() => {
    if (success) notices.push({ kind: "info", title: success });
  }, [success, notices]);
  async function runLocal(work) {
    if (localAction.current) return;
    localAction.current = true;
    try {
      await work();
    } catch (e) {
      if (!mounted.current || isPickerCancelled(e)) return;
      const message = e.message || "Could not complete this action.";
      retryAction.current = () => runLocal(work);
      retryAction.current.message = message;
      errorCode.current = { message, code: e.code };
      setError(message);
    } finally {
      localAction.current = false;
    }
  }
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
      retryAction.current = e.journaled
        ? () => {
            if (engine.current?.paused) return;
            setError("");
            startSync();
          }
        : () => run(work, options);
      const message = e.message || "Could not complete this action.";
      retryAction.current.message = message;
      errorCode.current = { message, code: e.code, hubOnly: !!options.hubOnly };
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
        if (!mounted.current) return;
        setReplica(engine.current);
        setName(
          await engine.current.store.get(
            "name",
            Platform.OS === "ios" ? "iPhone" : "Android",
          ),
        );
        await update();
        engine.current.sync(false, { scheduled: true });
      },
      { silent: true },
    );
    const app = AppState.addEventListener("change", (value) => {
      if (value === "active") {
        engine.current?.lastInventory.clear();
        engine.current?.sync(false, { scheduled: true });
      } else if (shouldStopSync(value, canContinueInBackground()))
        engine.current?.suspend();
    });
    const timer = setInterval(() => {
      const r = engine.current;
      if (
        AppState.currentState === "active" &&
        !action.current &&
        r &&
        !(
          Date.now() - (r.eventsHealthyAt || 0) < 20000 &&
          Date.now() - (r.lastScheduledAt || 0) < 60000
        )
      )
        r.sync(false, { scheduled: true });
    }, 15000);
    return () => {
      mounted.current = false;
      unsub();
      clearTimeout(updateTimer);
      clearInterval(timer);
      app.remove();
      engine.current?.suspend();
    };
  }, []);
  openSheet.current = sheet;
  shownFolder.current =
    folder && engine.current ? `${engine.current.scope}:${folder.id}` : null;
  const listedFolder = locals.find((f) => f.id === folder?.id);
  useEffect(() => {
    if (!folder || !engine.current) return;
    listFiles(folder.id).catch((e) => setError(e.message));
  }, [
    folder?.id,
    listedFolder?.files,
    listedFolder?.bytes,
    listedFolder?.changes,
  ]);
  const connection = state.connection,
    connected = connection?.linked,
    catalog = state.catalog,
    volumes = catalog?.volumes || [];
  useEffect(() => {
    if (!connected || !catalog?.changeEvents) return;
    let controller;
    let disposed = false;
    const start = () => {
      controller?.abort();
      if (disposed || AppState.currentState !== "active") return;
      controller = new AbortController();
      const signal = controller.signal;
      void (async () => {
        let cursor = null;
        while (!signal.aborted) {
          try {
            const next = await client.api(
              `/v1/events?${new URLSearchParams(cursor ? { after: cursor } : {})}`,
              undefined,
              { signal },
            );
            if (signal.aborted) break;
            if (engine.current) engine.current.eventsHealthyAt = Date.now();
            if (next.cursor !== cursor || engine.current?.hubUnavailable) {
              cursor = next.cursor;
              void engine.current?.sync(false, { scheduled: true });
            }
          } catch {
            // The ordinary scheduler remains the fallback for connection failures.
            break;
          }
        }
      })();
    };
    start();
    const listener = AppState.addEventListener("change", start);
    const retry = setInterval(start, 60000);
    return () => {
      disposed = true;
      controller?.abort();
      listener.remove();
      clearInterval(retry);
    };
  }, [connected, connection?.hubId, catalog?.changeEvents]);
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
      if (engine.current?.hubUnavailable) {
        setWebApproval(null);
        return;
      }
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
  useEffect(() => setApprovalError(""), [webApproval?.id]);
  const approvalRequest =
    webApproval && !sheet && !status.picking && !status.importing
      ? webApproval
      : null;
  const [shownApproval, releaseApproval] = useRetained(approvalRequest);
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
  const shownChange =
    folder && replica && lastChange?.key === `${replica.scope}:${folder.id}`
      ? lastChange.value
      : undefined;
  const authorName = (id) =>
    machines?.find((m) => m.machineId === id || m.credentialId === id)?.name ||
    (id === connection?.id ? name : "Unknown device");
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
  const musicFolder =
    !!folder && !photoFolder && isMusicFolder(catalog, folder.id);
  const musicView = musicFolder && fileView === "music";
  const policyEntry = entries.find((entry) => entry.path === ".arcaignore");
  useEffect(() => {
    const replica = engine.current;
    if (!(photoFolder || fileView === "gallery") || !folder || !replica)
      return undefined;
    const id = folder.id;
    let active = true;
    (async () => {
      const uri = replica.files.work(replica.scope, id, ".arcaignore");
      const stat = await replica.files.stat(uri);
      const text =
        stat && !stat.directory && stat.size <= 65536
          ? await replica.files.text(uri)
          : "";
      if (active) setIgnorePolicy({ id, text });
    })().catch(() => active && setIgnorePolicy({ id, text: "" }));
    return () => {
      active = false;
    };
  }, [
    photoFolder,
    fileView,
    folder?.id,
    status.last,
    policyEntry?.mtime,
    policyEntry?.size,
  ]);
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
      !["Devices", "Settings", "Folders", "File detail"].includes(screen) ||
      !connected ||
      !replica
    ) {
      setMachines(null);
      setMachinesSaved(false);
      setMachinesLoaded(false);
      return;
    }
    replica
      .remoteView("/v1/machines")
      .then((data) => {
        if (cancelled) return;
        setMachines(data.machines);
        setMachinesSaved(!!data.offline);
        setMachinesLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setMachines(null);
        setMachinesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [screen, connected, status.last, status.offline, replica]);
  useEffect(() => {
    if (!folder || screen !== "Folders" || photoFolder || !replica)
      return undefined;
    let cancelled = false;
    const key = `${replica.scope}:${folder.id}`;
    setLastChange((previous) => seededChange(previous, key));
    readLastChange({
      key,
      volume: folder.id,
      load: (route) => replica.remoteView(route),
    })
      .then((value) => {
        if (!cancelled) setLastChange({ key, value });
      })
      .catch(() => {
        if (!cancelled)
          setLastChange((previous) => failedChange(previous, key));
      });
    return () => {
      cancelled = true;
    };
  }, [folder?.id, screen, photoFolder, replica, status.last, status.offline]);
  useEffect(() => {
    if (!musicFolder || !replica) return undefined;
    let active = true;
    const key = `${replica.scope}:${folder.id}`;
    (async () => {
      const value = await folderLibrary(replica, folder.id);
      if (active) setMusicData({ key, ...value });
    })().catch(() => active && setMusicData(null));
    return () => {
      active = false;
    };
  }, [musicFolder, folder?.id, replica, status.last, status.musicTick, musicEdits]);
  const playingId = usePlayingId(musicFolder && screen === "Folders");
  const musicTab = musicRoute[0]?.kind;
  useEffect(() => {
    if (!musicFolder || !replica || musicTab !== "recent") return undefined;
    let active = true;
    const read = () =>
      readMusicHistory(replica).then((value) => active && setMusicHistory(value));
    read();
    const settled = setTimeout(read, 1500);
    return () => {
      active = false;
      clearTimeout(settled);
    };
  }, [musicFolder, musicTab, replica, playingId, historyTick]);
  const shownMusic =
    musicData?.key === `${replica?.scope}:${folder?.id}` ? musicData : null;
  const musicCover = (key, size) => {
    if (!key || !replica?.scope) return null;
    try {
      for (const option of size === "large" ? ["large", "small"] : ["small"]) {
        const uri = replica.files.musicCover(replica.scope, key, option);
        if (!replica.files.present || replica.files.present(uri)) return uri;
      }
    } catch {
      return null;
    }
    return null;
  };
  function musicCommand(name, value) {
    player.command(name, value).catch((e) => setError(e.message));
  }
  function playMusic(context, track, shuffle = false, position = -1) {
    if (!track) return;
    if (!playerAvailable) {
      if (engine.current)
        recordMusicPlay(engine.current, baseContext(context))
          .then(() => setHistoryTick((tick) => tick + 1))
          .catch(() => {});
      openFileDetail({ path: track.path, uri: track.uri }).catch((e) =>
        setError(e.message),
      );
      return;
    }
    runLocal(async () => {
      await publishMusic(engine.current).catch(() => {});
      await player.play(
        context,
        track.id,
        shuffle,
        Number.isSafeInteger(position) ? position : -1,
      );
    });
  }
  function musicChanged() {
    setMusicEdits((count) => count + 1);
    publishMusic(engine.current).catch(() => {});
    if (connected && !status.paused) startSync();
  }
  function changePlaylist(kind, value) {
    const r = engine.current;
    run(
      async () => {
        const result =
          kind === "add"
            ? await r.addToPlaylist(folder.id, value.playlist.path, value.track.path)
            : kind === "remove"
              ? await r.removeFromPlaylist(
                  folder.id,
                  value.playlist.path,
                  value.entry,
                  value.path,
                )
              : kind === "create"
                ? await r.createPlaylist(folder.id, value.name, value.track.path)
                : await r.renamePlaylist(folder.id, value.playlist.path, value.name);
        if (kind === "rename") {
          await renameMusicPlay(r, value.playlist.id, playlistKey(folder.id, result.path)).catch(() => {});
          setHistoryTick((tick) => tick + 1);
          setMusicRoute((route) =>
            route.map((item) =>
              item.kind === "playlist" && item.id === value.playlist.id
                ? { ...item, id: playlistKey(folder.id, result.path) }
                : item,
            ),
          );
        }
        setSheet(null);
        musicChanged();
      },
      {
        success:
          kind === "remove"
            ? "Removed from playlist"
            : kind === "rename"
              ? "Playlist renamed"
              : `Added to ${kind === "add" ? value.playlist.name : value.name}`,
      },
    );
  }
  async function deletePlaylist(playlist) {
    const unsynced = await engine.current
      .hasUnsyncedContent(folder.id, playlist.path)
      .catch(() => true);
    confirm(
      "Delete this playlist?",
      (unsynced
        ? "Its latest changes have not reached the hub, so this cannot be undone."
        : "Deletes it from all synced copies. Retained history can be restored.") +
        (!connected || status.paused
          ? " Deletion will sync when connected and resumed."
          : ""),
      () =>
        run(
          async () => {
            await engine.current.removeFile(folder.id, playlist.path);
            setSheet(null);
            setMusicRoute((route) =>
              route.filter(
                (item) => !(item.kind === "playlist" && item.id === playlist.id),
              ),
            );
            musicChanged();
          },
          { success: "Playlist deleted" },
        ),
      "Delete playlist",
    );
  }
  useEffect(() => {
    if (screen === "History" && connected && replica)
      getHistory().catch((e) => setError(e.message));
  }, [
    screen,
    connected,
    replica,
    status.offline,
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
  useEffect(() => {
    if (!connected || !replica) return;
    let unresolved = false;
    const key = (r) => `historySeen:${r?.scope}`;
    const mark = () => {
      const r = engine.current;
      if (r?.scope && !unresolved) r.store.set(key(r), Date.now()).catch(() => {});
    };
    const check = async () => {
      const r = engine.current;
      if (!r?.scope) return;
      const last = await r.store.get(key(r), 0).catch(() => 0);
      if (!awayDue(last)) {
        unresolved = false;
        mark();
        return;
      }
      unresolved = true;
      try {
        const ids = historyFolderIds(
          await r.store.folders(r.scope),
          client.state().catalog?.volumes || [],
        );
        if (!ids.length) return;
        const data = await r.interactiveClient.api(
          `/v1/activity-days?${new URLSearchParams({
            days: "1",
            offset: String(new Date().getTimezoneOffset()),
            volumes: ids.join(","),
            since: new Date(Number(last)).toISOString(),
          })}`,
        );
        if (!data?.since) return;
        unresolved = false;
        mark();
        if (data.since.changes)
          setAwayNotice({ since: new Date(Number(last)).toISOString(), ...data.since });
      } catch {}
    };
    check();
    const listener = AppState.addEventListener("change", (value) =>
      value === "active" ? check() : mark(),
    );
    return () => listener.remove();
  }, [connected, replica]);
  const landingCount = useRef(-1);
  const stopLanding = () => {
    landingCount.current = -1;
    setLandingDay("");
    setLandingReady(false);
  };
  useEffect(() => {
    if (!landingDay || landingReady) return;
    const reached =
      history.versions.some((row) => localDay(row.created) < landingDay) ||
      !history.next;
    if (reached) setLandingReady(true);
    else if (historyError || landingCount.current === history.versions.length)
      stopLanding();
    else if (!historyLoading) {
      landingCount.current = history.versions.length;
      getHistory(null, true).catch((e) => setHistoryError(e.message));
    }
  }, [landingDay, landingReady, history, historyLoading, historyError]);
  useEffect(() => {
    stopLanding();
    setSelectedRev("");
  }, [screen, historyFilter, historyVolume]);
  useEffect(() => {
    setPreviewEntry(null);
  }, [folder?.id, directory, search, screen]);
  useEffect(() => {
    if (screen !== "Folders" || !connected || !replica || folder) return;
    let live = true;
    (async () => {
      const r = engine.current;
      const selected = locals.filter((f) => f.selected);
      if (!r?.scope || !selected.length) return;
      let derived = { arrivals: [], last: {} };
      try {
        const page = await r.remoteView("/v1/activity?limit=50&filter=revisions", { silent: true });
        derived = homeFromActivity(page.versions, selected.map((f) => f.id));
      } catch {}
      const previews = {};
      for (const f of selected) {
        if (!live) return;
        try {
          const isGallery = galleryConfig(f) || f.gallery || catalog?.volumes?.find((v) => v.id === f.id)?.gallery;
          if (isGallery) {
            const rows = await r.store.recentRows(r.scope, f.id);
            const uris = newestImages(rows)
              .map((path) => r.files.work(r.scope, f.id, path))
              .filter((uri) => !r.files.present || r.files.present(uri));
            if (uris.length) previews[f.id] = { kind: "photos", uris };
          } else if (isMusicFolder(catalog, f.id)) {
            const library = await r.store.musicLibrary(r.scope, f.id);
            const uris = newestCovers(library?.value).map((key) => musicCover(key, "small"));
            if (uris.some(Boolean)) previews[f.id] = { kind: "covers", uris };
          }
        } catch {}
      }
      if (live) setHome({ ...derived, previews });
    })();
    return () => {
      live = false;
    };
  }, [screen, connected, replica, folder, catalog?.volumes?.length, locals.map((f) => `${f.id}:${f.files}:${f.completed ? 1 : 0}:${f.selected ? 1 : 0}`).join(",")]);
  const actionLocked = busy || !engine.current;
  async function openFolder(f) {
    setEntries(
      folderLists.current.get(`${engine.current?.scope}:${f.id}`) || [],
    );
    setFolder(f);
    setPhotoCount(null);
    setSearchOpen(false);
    setFileView(
      (f.gallery || catalog?.volumes?.find((v) => v.id === f.id)?.gallery) &&
        !galleryConfig(f)
        ? "gallery"
        : isMusicFolder(catalog, f.id) && !galleryConfig(f)
          ? "music"
          : "files",
    );
    setMusicRoute([{ kind: "artists" }]);
    setMusicSearch(null);
    setDirectory("");
    setVisibleCount(100);
    setSearch("");
  }
  async function getHistory(target = null, more = false, quiet = false) {
    const selectedIds = historyFolderIds(
      await engine.current.store.folders(engine.current.scope),
      client.state().catalog?.volumes || [],
    );
    if (target && !selectedIds.includes(target.volume))
      throw new Error("Start syncing this folder to view its history.");
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
      if (!quiet) {
        setFileHistory({ versions: [], next: null });
        setSheet(target);
      }
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
      if (!more) setHistoryDays(null);
      q.set("filter", historyFilter);
      setHistoryLoading(true);
    }
    let page;
    try {
      page = target
        ? await engine.current.remoteView(`/v1/history?${q}`)
        : await scopedActivity(
            (query) => engine.current.remoteView(`/v1/activity?${query}`),
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
    const saved =
      target && page.offline && !more
        ? await engine.current.store
            .current(engine.current.scope, target.volume, target.path)
            .catch(() => null)
        : null;
    if (request !== historyRequest.current || !mounted.current) return;
    if (quiet && !sameDetail(openSheet.current, target)) return;
    const own = target && !more ? offlineFileHistory(page, saved, localEntry) : null;
    if (!target && !more && selectedIds.length)
      engine.current
        .remoteView(
          `/v1/activity-days?${new URLSearchParams({
            days: "30",
            offset: String(new Date().getTimezoneOffset()),
            ...(q.get("volume") ? { volume: q.get("volume") } : { volumes: selectedIds.join(",") }),
          })}`,
        )
        .then((days) => {
          if (request === historyRequest.current && Array.isArray(days?.days))
            setHistoryDays(days);
        })
        .catch(() => setHistoryDays(null));
    (target ? setFileHistory : setHistory)({
      versions: more
        ? [...previous.versions, ...page.versions]
        : (own?.versions ?? page.versions),
      next: page.next,
      offline: !!page.offline,
    });
    if (target)
      setSheet({
        kind: "history",
        originEntry: target.originEntry || null,
        ...target,
        localEntry,
        currentRev: more ? target.currentRev : own.currentRev,
      });
  }
  useEffect(() => {
    if (
      sheet?.kind === "history" &&
      connected &&
      replica &&
      !status.offline &&
      fileHistory.offline
    )
      getHistory(
        {
          volume: sheet.volume,
          path: sheet.path,
          originEntry: sheet.originEntry,
          localEntry: sheet.localEntry,
        },
        false,
        true,
      ).catch((e) => setDetailError(e.message));
  }, [
    status.offline,
    connected,
    replica,
    sheet?.kind,
    sheet?.path,
    fileHistory.offline,
  ]);
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
  async function resolveVideo(item) {
    const r = engine.current;
    return galleryVideoURI(item, {
      files: r.files,
      scope: r.scope,
      volume: folder.id,
    });
  }
  function deleteMedia(item) {
    return new Promise((resolve) =>
      confirm(
        Array.isArray(item)
          ? `Delete ${item.length} photos?`
          : "Delete this photo?",
        "Deletes the selected photos and their Live Photo resources from the shared gallery for everyone. Originals stay in Photos. Recovery depends on this folder’s version retention.",
        () =>
          run(
            async () => {
              try {
                resolve(
                  await engine.current.galleryDeletions.delete(folder.id, item),
                );
              } catch (error) {
                if (error.deletedRows?.length) resolve(error.deletedRows);
                throw error;
              } finally {
                await listFiles();
                if (connected && !status.paused) startSync();
              }
            },
            { success: "Photos deleted", hubOnly: true },
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
        const result = await (
          kind === "photos"
            ? ImagePicker.launchImageLibraryAsync({
                mediaTypes: ["images"],
                allowsMultipleSelection: true,
                quality: 1,
              })
            : DocumentPicker.getDocumentAsync({
                multiple: true,
                copyToCacheDirectory: Platform.OS !== "android",
              })
        ).catch((error) => {
          throw sourceUnavailable(error);
        });
        if (result.canceled) return;
        if (kind === "photos" && source) {
          await replica.gallery.addPhotos(folder.id, result.assets);
        } else {
          const copied =
            kind !== "photos" && Platform.OS === "android"
              ? await copyPicked(
                  replica,
                  (uri, destination) => native.receiveShared(uri, destination),
                  result.assets,
                  `import-${Date.now()}`,
                )
              : null;
          const assets = copied || result.assets;
          try {
            for (const asset of assets)
              await replica.importFile(
                folder.id,
                directory +
                  (asset.name || asset.fileName || `photo-${Date.now()}.jpg`),
                asset.uri,
              );
          } finally {
            for (const asset of assets)
              await (copied
                ? replica.files.remove(asset.uri)
                : replica.files.discardPicked(asset.uri)
              ).catch(() => {});
          }
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
  function configureGallery(options, info = {}) {
    const all = !options.albums?.length;
    const switchedToAll = all && !!source && sourceAlbums(source).length > 0;
    const save = () =>
      run(
        async () => {
          await engine.current.gallery.configure(folder.id, options, true);
          setSheet(null);
          await listFiles();
          startSync();
        },
        {
          label: source ? "Saving changes…" : "Enabling uploads…",
          hubOnly: true,
        },
      );
    if (source && source.mode !== "damaged" && !switchedToAll) {
      save();
      return;
    }
    const what = all
      ? allPhotosNote({
          videos: options.videos,
          limited: info.limited,
          count: info.count,
        })
      : options.albums.length === 1
        ? "Uploads this album"
        : "Uploads these albums";
    const upgrade = all && !!source;
    confirm(
      upgrade ? "Upload every photo?" : "Enable photo uploads?",
      `${what}. ${all ? "This uses your current network, including mobile data. " : ""}Arca keeps a complete local copy of the shared folder, including photos from other devices. Uses storage on this phone. Originals stay in Photos.`,
      save,
      upgrade ? "Upload everything" : "Enable uploads",
    );
  }
  function unlink() {
    const target = folder;
    const gallery = galleryConfig(locals.find((f) => f.id === target.id));
    const sourceOnly = gallery?.mode === "source";
    const message = sourceOnly
      ? "Stops photo uploads and removes this folder’s Arca copy and album link. Originals in Photos, hub files and history are kept. Unsynced local changes will be lost; export the folder first to keep them."
      : "Removes this folder’s Arca copy from this phone. Hub files and history are kept. Unsynced local changes will be lost; use Export folder first to keep them.";
    confirm(
      `Stop syncing “${target.name}”?`,
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
      "Stop syncing and delete",
    );
  }
  function destroy() {
    confirm(
      "Erase this device?",
      "Permanently deletes every downloaded folder, any unsynced changes and this phone’s pairing and saved settings. Arca returns to first-run setup. Hub files and history and other devices are kept. This cannot be undone. Works offline. If the hub cannot be reached, remove this device from its Devices list separately.",
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
            setView("Devices");
          },
          {
            label: "Erasing this device…",
            errorTitle: "Could not erase this device",
            destroy: true,
          },
        ),
      "Erase this device",
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
          const left = await client.disconnect();
          if (left.connection?.leaving)
            notices.push({
              id: "disconnect-pending",
              kind: "info",
              title: "Disconnect pending",
              body: "This phone leaves the hub once it is reachable again. Local files are kept.",
            });
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
  const folderSubtitle = `${photoFolder ? `${photoCount ?? "—"} photos` : musicView && shownMusic ? `${shownMusic.library.tracks.size.toLocaleString("en")} tracks · ${shownMusic.library.albums.size.toLocaleString("en")} albums` : `${entrySummary.files} files`} · ${bytes(entrySummary.bytes)} local${status.paused ? " · Paused" : ""}`;
  const timelineNotice =
    sourceConfig?.mode === "damaged"
      ? sourceConfig.issue
      : sourceConfig && !sourceConfig.enabled
        ? "Photo uploads are disabled for this album."
        : "";
  const timeline =
    folder && engine.current ? (
      <FolderGallery
        key={folder.id}
        columns={wide ? 6 : 4}
        api={galleryAPI}
        connected={connected}
        offline={!!status.offline}
        reconnect={reconnect}
        store={engine.current.store}
        scope={engine.current.scope}
        volume={folder.id}
        entries={entries}
        loading={filesLoading}
        refreshKey={status.last}
        onRail={setGalleryRailModel}
        scrollRef={galleryScroll}
        railRef={galleryRail}
        onSummary={({ count }) => setPhotoCount(count)}
        uploads={
          source
            ? {
                store: engine.current.store,
                media: engine.current.gallery.media,
                summary: source.summary,
                scannedAt: source.scannedAt,
                dismissLost: () =>
                  run(() => engine.current.gallery.dismissLost(folder.id)),
              }
            : null
        }
        notice={timelineNotice}
        ignoreText={ignorePolicy.id === folder.id ? ignorePolicy.text : ""}
        folderName={folder.name}
        resolveVideo={resolveVideo}
        history={(item) => openFileDetail(item)}
        share={(item) => shareMedia(item).catch((e) => setError(e.message))}
        remove={currentFolder?.selected ? deleteMedia : null}
      />
    ) : null;
  async function resolveConflict(entry, volume = folder?.id) {
    if (!locals.find((f) => f.id === volume)?.selected)
      throw new Error(
        "Start syncing this folder before resolving conflicts.",
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
        "Start syncing this folder before resolving conflicts.",
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
      "Restore this version?",
      "The hub creates a new version. It will synchronize to every selected copy.",
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
        }, { hubOnly: true }),
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
      if (
        folder &&
        view === "Folders" &&
        musicView &&
        musicRoute.length === 1 &&
        typeof musicSearch === "string" &&
        shownMusic?.library?.tracks.size
      ) {
        setMusicSearch(null);
        return true;
      }
      if (
        folder &&
        view === "Folders" &&
        musicView &&
        musicRoute.length > 1 &&
        shownMusic?.library?.tracks.size
      ) {
        setMusicRoute(musicRoute.slice(0, -1));
        return true;
      }
      if (folder && view === "Folders") {
        setFolder(null);
        return true;
      }
      return false;
    });
    return () => listener.remove();
  }, [
    sheet,
    folder,
    view,
    fileActionsOpen,
    musicView,
    musicRoute,
    shownMusic,
    musicSearch,
  ]);
  const selectTab = (tab) => {
    historyRequest.current++;
    setView(tab);
    setSheet(null);
  };
  const showError = error || status.error;
  const noticeFolder = useRef(null);
  useEffect(() => {
    const conditions = conditionNotices({
      error: status.error,
      hubName: state.catalog?.name,
      catalog: state.catalog,
      volumes: locals,
    });
    if (folder?.id && noticeFolder.current !== folder.id)
      for (const kind of ["folder", "photo-uploads"])
        notices.clear(`status:${kind}:${folder.id}`);
    noticeFolder.current = folder?.id || null;
    notices.reconcile(conditions);
    if (error)
      notices.push(
        errorNotice(
          errorCode.current.message === error ? errorCode.current : error,
          {
            id: "action",
            hubName: state.catalog?.name,
            action: retryAction.current ? "retry" : null,
            hubOnly:
              errorCode.current.message === error && !!errorCode.current.hubOnly,
          },
        ),
      );
    else notices.clear("action");
  }, [error, status.error, locals, state.catalog, notices, folder?.id]);
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
          if (item.volume) {
            const target = locals.find((f) => f.id === item.volume);
            if (target) openFolder(target).catch((e) => setError(e.message));
            else setFolder(null);
          }
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
              (status.busy && !status.offline) ||
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
    ? async () =>
        confirm(
          "Delete this file?",
          ((await engine.current
            .hasUnsyncedContent(sheet.volume, sheet.path)
            .catch(() => true))
            ? "Its latest changes have not reached the hub, so this cannot be undone."
            : "Deletes from all synced copies. Retained history can be restored.") +
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
            (status.busy && !status.offline) ||
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
                                    : musicFolder
                                      ? "music"
                                      : "folder"
                                  : undefined
                              }
                              subtitle={folderSubtitle}
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
                              disabled={!engine.current || !sheet.localEntry}
                              onPress={() => runLocal(openCurrentFile)}
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
                                setSheet({
                                  kind: "folder-actions",
                                  volume: folder,
                                })
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
                            activity={!status.offline && status.busy}
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
                  locals={locals}
                  onSaved={update}
                />
                <KeyboardScrollView
                  onLayout={(event) => {
                    const { y, height } = event.nativeEvent.layout;
                    setGalleryViewport((old) =>
                      old.y === y && old.height === height
                        ? old
                        : { y, height },
                    );
                  }}
                  key={`${screen}:${folder?.id || ""}${musicView ? `:${musicRoute.length}:${JSON.stringify(musicRoute.at(-1))}` : ""}`}
                  onScroll={(event) => {
                    const { contentOffset } = event.nativeEvent;
                    if (contentOffset.y !== galleryScrollY.current)
                      galleryScroll.current?.(contentOffset.y);
                    galleryScrollY.current = contentOffset.y;
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
                  {folder && screen === "Folders" && !photoFolder && !musicView && (
                    <View style={[s.group, s.statsGrid]}>
                      {[
                        [
                          "Status",
                          status.paused
                            ? "Paused"
                            : status.offline
                              ? "Offline"
                              : currentFolder?.issue || status.error
                                ? "Needs attention"
                                : status.busy &&
                                    status.syncingVolume === currentFolder?.id
                                  ? "Syncing"
                                  : currentFolder?.completed
                                    ? "Up to date"
                                    : "Not yet synced",
                          currentFolder?.completed
                            ? `Completed ${relative(currentFolder.completed)}`
                            : "No completed sync yet",
                        ],
                        shownChange === undefined
                          ? ["Last change", "…", ""]
                          : shownChange === null
                            ? ["Last change", "Not available", ""]
                            : shownChange.change
                              ? [
                                  "Last change",
                                  relative(shownChange.change.created),
                                  `${shortName(shownChange.change.path)}${machinesLoaded || shownChange.change.author === connection?.id ? ` · ${authorName(shownChange.change.author)}` : ""}${shownChange.saved ? " · last known" : ""}`,
                                ]
                              : shownChange.saved
                                ? [
                                    "Last change",
                                    "No saved versions",
                                    "Connect to the hub for the newest",
                                  ]
                                : [
                                    "Last change",
                                    "No changes yet",
                                    "Accepted by the hub",
                                  ],
                        [
                          "Version history",
                          retentionLabel,
                          historyRetention === "off"
                            ? "Current files only"
                            : "Older versions kept",
                        ],
                      ].map(([label, value, note], index) => (
                        <View
                          key={label}
                          style={[
                            s.statCellThird,
                            !wide && index === 2 && s.statCellWide,
                          ]}
                        >
                          <Text style={s.caption}>{label}</Text>
                          <Text style={s.statValue}>{value}</Text>
                          {!!note && (
                            <Text numberOfLines={1} style={s.caption}>
                              {note}
                            </Text>
                          )}
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
                            label="Open Devices"
                            onPress={() => setView("Devices")}
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
                        ) : musicView ? (
                          <MusicLibrary
                            library={shownMusic?.library}
                            saved={!!shownMusic?.saved}
                            indexing={!!shownMusic?.indexing}
                            offline={!!status.offline}
                            route={musicRoute}
                            push={(next) => setMusicRoute([...musicRoute, next])}
                            pop={() => setMusicRoute(musicRoute.slice(0, -1))}
                            select={(kind) => setMusicRoute([{ kind }])}
                            history={musicHistory}
                            search={musicSearch}
                            setSearch={setMusicSearch}
                            folderId={folder.id}
                            cover={musicCover}
                            canPlay={playerAvailable}
                            play={playMusic}
                            playingId={playingId}
                            sync={() => startSync(true)}
                            reconnect={reconnect}
                            trackActions={(value) =>
                              setSheet({ kind: "track-actions", ...value })
                            }
                            playlistActions={(playlist) =>
                              setSheet({ kind: "playlist-actions", playlist })
                            }
                          />
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
                                  scope={replica?.scope}
                                  onLoading={setRecentLoading}
                                  connected={connected && !!replica}
                                  load={(route) => replica.remoteView(route)}
                                  updated={status.last}
                                  offline={status.offline}
                                  reconnect={reconnect}
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
                                            } else if (wide && !compact) setPreviewEntry(e);
                                            else openFileDetail(e);
                                          }}
                                          onLongPress={() => {
                                            if (!e.directory) setSheet({ kind: "peek", entry: e });
                                          }}
                                          accessibilityActions={e.directory ? undefined : [{ name: "preview", label: "Preview" }]}
                                          onAccessibilityAction={() => {
                                            if (!e.directory) setSheet({ kind: "peek", entry: e });
                                          }}
                                          style={[
                                            s.settingRow,
                                            s.separator,
                                            previewEntry?.path === e.path && wide && !compact && s.historyRowChosen,
                                          ]}
                                        >
                                          <View style={s.row}>
                                            <RowThumb entry={e} enabled={index < 30} />
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
                                  </View>
                                  {!filesLoading &&
                                    !visibleEntries.length && (
                                      <EmptyState
                                        icon="folders"
                                        title={
                                          search
                                            ? "No matching files"
                                            : currentFolder?.completed
                                              ? "This folder is empty"
                                              : "No local files yet"
                                        }
                                        text={
                                          search
                                            ? "Try another name."
                                            : currentFolder?.completed
                                              ? "Files appear here as they arrive from your hub."
                                              : "Files appear here as they download from your hub."
                                        }
                                      />
                                    )}
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
                                {!compact && !!previewEntry && entries.some((x) => x.path === previewEntry.path) && (
                                  <Section>
                                    <Text style={s.eyebrow}>PREVIEW</Text>
                                    <Card>
                                      <FilePreview entry={previewEntry} files={engine.current?.files} />
                                      <Text style={s.heading}>{previewEntry.path.split("/").pop()}</Text>
                                      <Text style={s.caption}>{bytes(previewEntry.size || 0)}</Text>
                                      <Button label="Open" onPress={() => openFileDetail(previewEntry)} />
                                    </Card>
                                  </Section>
                                )}
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
                                      <Tag variant="self">This device</Tag>
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
                                          {m.albumFolderIds?.includes(
                                            folder.id,
                                          ) && <Tag>Album source</Tag>}
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
                          {!!home.arrivals.length && !!connection && (
                            <ArrivalsStrip
                              arrivals={home.arrivals}
                              nameOf={authorName}
                              relative={relative}
                              onOpen={(row) =>
                                getHistory({ volume: row.volume, path: row.path }).catch((e) => setError(e.message))
                              }
                            />
                          )}
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
                                      galleryConfig(f) ||
                                      f.gallery ||
                                      catalog?.volumes?.find(
                                        (v) => v.id === f.id,
                                      )?.gallery
                                        ? "gallery"
                                        : isMusicFolder(catalog, f.id)
                                          ? "music"
                                          : "folders"
                                    }
                                    description={`${f.files} files · ${bytes(f.bytes)} local`}
                                    preview={home.previews[f.id]}
                                    latest={latestLine(home.last[f.id], authorName, relative)}
                                    conflict={!!catalog?.volumes?.find((v) => v.id === f.id)?.conflicts}
                                    status={
                                      status.paused
                                        ? "Paused"
                                        : f.issue || galleryConfig(f)?.issue
                                          ? "Needs attention"
                                          : status.offline
                                            ? "Offline"
                                            : status.busy &&
                                                status.syncingVolume === f.id
                                              ? "Syncing"
                                              : !f.completed ||
                                                  (galleryConfig(f)?.enabled &&
                                                    (galleryConfig(f).summary
                                                      ?.pending ||
                                                      !galleryConfig(f)
                                                        .scannedAt ||
                                                      Object.keys(
                                                        galleryConfig(f)
                                                          .cursors || {},
                                                      ).length))
                                                ? "Incomplete"
                                                : "Up to date"
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
                                      icon={v.gallery ? "gallery" : v.music && catalog?.music ? "music" : "folders"}
                                      description={folderSize(v)}
                                      disabled={!connected || actionLocked}
                                      onPress={() => choose(v)}
                                    />
                                  ))}
                              </View>
                            </Section>
                          )}
                          {connected && !catalog && !status.offline && (
                            <Scaffold dashed label="Loading shared folders" />
                          )}
                          {!locals.length &&
                            !volumes.length &&
                            (!connected || catalog || status.offline) && (
                              <EmptyState
                                icon="folder-open"
                                title="No folders yet"
                                text="Shared folders from your hub appear here."
                              />
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
                      files={engine.current?.files}
                      retry={() => {
                        reconnect();
                        getHistory(sheet).catch((e) =>
                          setDetailError(e.message),
                        );
                      }}
                      author={authorName}
                      volume={
                        volumes.find((v) => v.id === sheet.volume) ||
                        locals.find((v) => v.id === sheet.volume)
                      }
                      date={date}
                      locked={actionLocked}
                      connected={connected}
                      offline={status.offline || !!fileHistory.offline}
                      restore={restore}
                      canResolve={locals.some(
                        (f) => f.id === sheet.volume && f.selected,
                      )}
                      reviewConflict={() =>
                        run(
                          () =>
                            resolveConflict({ path: sheet.path }, sheet.volume),
                          { hubOnly: true },
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
                        }, { hubOnly: true })
                      }
                      retry={() => run(() => client.refresh(), { hubOnly: true })}
                      download={(ids) =>
                        run(async () => {
                          const r = engine.current;
                          await client.refresh().catch((error) => {
                            if (
                              !client.state().catalog ||
                              !isHubUnreachable(error)
                            )
                              throw error;
                          });
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
                  {screen === "Devices" && (() => {
                    const hubAway = !!status.offline;
                    const nodes = deviceNodes(machines, {
                      selfId: connection?.id,
                      hubAway,
                    });
                    const tree = !wide && !!connection && nodes.length > 0;
                    const pick = (key) =>
                      setPickedDevice((now) => (now === key ? "" : key));
                    const selfState = status.paused
                                    ? "Paused"
                                    : status.offline
                                      ? "Offline"
                                      : status.error ||
                                          locals.some(
                                            (f) => f.selected && f.issue,
                                          )
                                        ? "Needs attention"
                                        : status.busy
                                          ? "Syncing"
                                          : locals.some(
                                                (f) =>
                                                  f.selected && !f.completed,
                                              )
                                            ? "Incomplete"
                                            : status.last
                                              ? "Up to date"
                                              : "Not yet synced";
                    const sideMap = wide && !!connection && nodes.length > 0;
                    return (
                    <View style={sideMap ? s.deviceMapRow : s.deviceMapPlain}>
                    <View style={sideMap ? s.deviceMapMain : s.deviceMapPlain}>
                      {connection ? (
                        <Section>
                          <Text style={s.eyebrow}>{tree ? "NETWORK" : "HUB CONNECTION"}</Text>
                          {machinesSaved && !!machines?.length && (
                            <Text style={s.caption}>
                              Showing saved device information.
                            </Text>
                          )}
                          {!machines && !status.offline && (
                            <Scaffold label="Loading devices" />
                          )}
                          <HubConnection
                            connection={connection}
                            name={catalog?.name}
                            machine={machines?.find((m) => m.isHub)}
                            busy={actionLocked}
                            disconnect={disconnect}
                            away={tree && hubAway}
                            retry={() => run(() => client.refresh(), { hubOnly: true })}
                          />
                          {tree && (
                            <View style={s.deviceTree}>
                              {nodes.map((node) => (
                                <DeviceBranch key={node.key} line={node.line}>
                                  <MachineRow
                                    name={node.machine.name}
                                    description={`${{ darwin: "macOS", android: "Android", ios: "iOS", linux: "Linux", win32: "Windows" }[node.machine.platform] || node.machine.platform || "Platform not reported"}${node.machine.lastAddress ? ` · ${node.machine.lastAddress}` : ""}`}
                                    role={node.machine.role || "Replica"}
                                    self={node.self}
                                    report={node.report}
                                    state={node.self ? selfState : undefined}
                                    away={hubAway || node.state === "none"}
                                  />
                                </DeviceBranch>
                              ))}
                            </View>
                          )}
                          {tree && !hubAway && (
                            <Text style={s.caption}>
                              Solid line: report under 5 min · Dashed: older ·
                              No line: never reported
                            </Text>
                          )}
                        </Section>
                      ) : (
                        <PairingForm
                          name={name}
                          setName={setName}
                          address={address}
                          setAddress={setAddress}
                          code={code}
                          setCode={setCode}
                          busy={busy}
                          blocked={!engine.current}
                          pair={() =>
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
                              }, { hubOnly: true })
                            }
                        />
                      )}
                      {!connection && (
                        <Text style={[s.caption, s.centerText]}>
                          No Arca account or password. Your connection
                          credential is stored securely on this device.
                        </Text>
                      )}
                      {connection && !tree && (
                        <>
                          <Section>
                            <Text style={s.eyebrow}>DEVICES</Text>
                            <View style={s.folderList}>
                              <MachineRow
                                chosen={!!connection?.id && pickedDevice === connection.id}
                                name={name}
                                self
                                role="Replica"
                                totals={`${locals.filter((f) => f.selected).length} folders · ${bytes(locals.filter((f) => f.selected).reduce((n, f) => n + (f.bytes || 0), 0))} local`}
                                description={`${Platform.OS === "ios" ? "iOS" : "Android"}${machines?.find((m) => m.credentialId === connection.id)?.lastAddress ? ` · ${machines.find((m) => m.credentialId === connection.id).lastAddress}` : ""}`}
                                state={selfState}
                              />
                              {machines?.length ? (
                                machines
                                  .filter(
                                    (m) =>
                                      !m.isHub &&
                                      m.credentialId !== connection.id,
                                  )
                                  .map((m) => (
                                    <MachineRow
                                      key={m.credentialId}
                                      chosen={pickedDevice === m.credentialId}
                                      name={m.name}
                                      description={`${{ darwin: "macOS", android: "Android", ios: "iOS", linux: "Linux", win32: "Windows" }[m.platform] || m.platform || "Platform not reported"}${m.lastAddress ? ` · ${m.lastAddress}` : ""}`}
                                      role={m.role || "Replica"}
                                      state={m.revoked ? "Removed" : "Linked"}
                                    />
                                  ))
                              ) : (
                                machinesLoaded && (
                                  <EmptyState
                                    icon="devices"
                                    title="No saved devices"
                                    text="Sync online to save device information."
                                  />
                                )
                              )}
                            </View>
                          </Section>
                        </>
                      )}
                    </View>
                    {sideMap && (
                      <DeviceMapSide
                        nodes={nodes}
                        hubName={catalog?.name}
                        away={hubAway}
                        picked={pickedDevice}
                        onPick={pick}
                      />
                    )}
                    </View>
                    );
                  })()}
                  {screen === "History" && (
                    <>
                      {!connected && (
                        <Text style={s.text}>Connect to view hub history.</Text>
                      )}
                      {history.offline && (
                        <Text style={s.caption}>
                          Showing saved history · recent entries only.
                        </Text>
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
                          <EmptyState
                            {...historyEmpty({
                              offline: history.offline,
                              filter: historyFilter,
                              hasFolder: !!historyVolume,
                            })}
                          />
                        )}
                      {!!history.versions.length && (() => {
                        const twoPane = wide && !compact;
                        const days = historyFilter === "revisions" ? historyDays : null;
                        const summaries = new Map((days?.days || []).map((d) => [d.day, d]));
                        const groups = Array.from(
                          history.versions.reduce((map, row) => {
                            const key = localDay(row.created);
                            if (!map.has(key)) map.set(key, { day: dayLabel(row.created), rows: [] });
                            map.get(key).rows.push(row);
                            return map;
                          }, new Map()),
                        );
                        const landing = landingReady
                          ? groups.find(([key]) => key <= landingDay)?.[0] || groups.at(-1)?.[0]
                          : null;
                        const rowId = (row) => `${row.volume}:${row.rev}`;
                        const chosen =
                          history.versions.find((row) => rowId(row) === selectedRev) ||
                          history.versions[0];
                        const banner = awayNotice ? (
                          <AwayBanner
                            notice={awayNotice}
                            nameOf={authorName}
                            onDismiss={() => setAwayNotice(null)}
                          />
                        ) : null;
                        return (
                          <>
                            {!twoPane && banner}
                            {!!days && (
                              <ActivityStrip
                                bars={stripBars(days.days)}
                                onJump={(key) => {
                                  setLandingReady(false);
                                  setLandingDay(key);
                                }}
                              />
                            )}
                            <View style={twoPane ? s.historyPane : undefined}>
                              <View style={twoPane ? s.historyPaneList : s.historyGroups}>
                                {twoPane && banner}
                                {groups.map(([key, { day, rows }]) => (
                                  <DayGroup
                                    key={key}
                                    dayKey={key}
                                    landing={landing}
                                    onLanded={stopLanding}
                                    header={<Text style={s.eyebrow}>{day.toUpperCase()}</Text>}
                                    summary={daySummary(summaries.get(key), authorName)}
                                  >
                                    <View style={s.group}>
                                      {rows.map((row, index) => (
                                        <Pressable
                                          key={rowId(row)}
                                          accessibilityRole="button"
                                          accessibilityLabel={`View history for ${row.path}`}
                                          onPress={() =>
                                            twoPane
                                              ? setSelectedRev(rowId(row))
                                              : getHistory({
                                                  volume: row.volume,
                                                  path: row.path,
                                                }).catch((e) => setError(e.message))
                                          }
                                          style={[
                                            s.settingRow,
                                            index > 0 && s.separator,
                                            s.row,
                                            twoPane && chosen && rowId(chosen) === rowId(row) && s.historyRowChosen,
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
                                              style={[s.rowTitle, !!row.deleted && s.deletedFile]}
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
                                              {!wide && (
                                                <Text style={s.tabularTime}>
                                                  {` · ${clockTime(row.created)}`}
                                                </Text>
                                              )}
                                            </Text>
                                          </View>
                                          {wide && (
                                            <>
                                              <Text numberOfLines={1} style={[s.caption, s.historyFolder]}>
                                                {row.folder}
                                              </Text>
                                              <Text style={[s.mono, s.historyRevision]}>
                                                rev {row.rev}
                                              </Text>
                                              <Text style={[s.caption, s.historyDate]}>
                                                {clockTime(row.created)}
                                              </Text>
                                            </>
                                          )}
                                          <Icon name="chevron" color={c.mute} />
                                        </Pressable>
                                      ))}
                                    </View>
                                  </DayGroup>
                                ))}
                              </View>
                              {twoPane && !!chosen && (
                                <View style={s.historyPaneSide}>
                                  <Text style={s.eyebrow}>REVISION</Text>
                                  <Text style={s.rowTitle}>{chosen.path}</Text>
                                  <Text style={s.caption}>{chosen.folder}</Text>
                                  <Text style={s.caption}>
                                    {`${authorName(chosen.author)} · ${clockTime(chosen.created)} · rev ${chosen.rev}`}
                                  </Text>
                                  <Button
                                    label="File history"
                                    onPress={() =>
                                      getHistory({
                                        volume: chosen.volume,
                                        path: chosen.path,
                                      }).catch((e) => setError(e.message))
                                    }
                                  />
                                </View>
                              )}
                            </View>
                          </>
                        );
                      })()}
                      {history.next && (
                        <Button
                          label="Show more versions"
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
                              retry={() => run(() => client.refresh(), { hubOnly: true })}
                            />
                          </Section>
                        </>
                      )}
                      <Section>
                        <Text style={s.eyebrow}>THIS DEVICE</Text>
                        <Card>
                          <Field
                            label="Device name"
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
                                if (!reported && engine.current.nameReportError)
                                  setError(
                                    `Name saved on this device, but not updated on the hub. ${engine.current.nameReportError}`,
                                  );
                                else if (!reported)
                                  notices.push({
                                    id: "name-saved",
                                    kind: "info",
                                    title: "Name saved on this device",
                                    body: client.state().connection
                                      ? "It reaches the hub once the hub is reachable."
                                      : "It is used when this phone connects to a hub.",
                                  });
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
                            <Text style={s.text}>Mobile app</Text>
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
                          title="Erase this device"
                          danger
                          actions={
                            <Button
                              label="Erase this device…"
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
                            device. Hub files and other devices are kept.
                          </Text>
                        </Card>
                      </Section>
                    </>
                  )}
                </KeyboardScrollView>
                {folder && screen === "Folders" && photoFolder && (
                  <GalleryDateRail
                    key={folder.id}
                    model={galleryRailModel}
                    viewport={galleryViewport}
                    controller={galleryRail}
                  />
                )}
                {folder && screen === "Folders" && musicFolder && !sheet && (
                  <MiniPlayer
                    library={shownMusic?.library}
                    cover={musicCover}
                    open={() => setSheet({ kind: "now-playing" })}
                    command={musicCommand}
                  />
                )}
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
                (/stop syncing/i.test(shownConfirmation.label)
                  ? "unlink"
                  : /delete/i.test(shownConfirmation.label)
                    ? "trash"
                    : /unlink|remove/i.test(shownConfirmation.label)
                      ? "unlink"
                      : "alert")
              }
              destructive={/erase|delete|stop syncing|remove/i.test(
                shownConfirmation.label,
              )}
              closing={!confirmation}
              onExited={releaseConfirmation}
              onConfirm={() => settle(true)}
              onCancel={() => settle(false)}
            />
          )}
          {shownApproval && (
            <ApprovalSheet
              request={shownApproval}
              hubName={catalog?.name || "hub"}
              busy={approvalBusy}
              error={approvalError}
              onDecision={answerWebApproval}
              closing={!approvalRequest}
              onExited={releaseApproval}
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
              {...(shownSheet.kind === "rename-file"
                ? {
                    title: "Rename file",
                    icon: "edit",
                    subtitle: shownSheet.path.split("/").at(-1),
                  }
                : shownSheet.kind === "peek"
                  ? {
                      title: shownSheet.entry.path.split("/").pop(),
                      icon: fileIcon(shownSheet.entry.path),
                      subtitle: bytes(shownSheet.entry.size || 0),
                    }
                  : shownSheet.kind === "gallery"
                  ? { title: "Photo uploads", icon: "gallery", subtitle: folder?.name }
                  : shownSheet.kind === "now-playing"
                    ? { title: "Now playing", icon: "music" }
                  : shownSheet.kind === "history-filter"
                    ? { title: "Shared folder", icon: "folders" }
                    : shownSheet.kind === "folder-actions"
                      ? {
                          title: shownSheet.volume.name,
                          icon: photoFolder ? "gallery" : musicFolder ? "music" : "folder",
                          subtitle: folderSubtitle,
                          menu: true,
                        }
                      : shownSheet.kind === "select"
                        ? {
                            title: shownSheet.volume.name,
                            icon: shownSheet.volume.gallery ? "gallery" : shownSheet.volume.music && catalog?.music ? "music" : "folder",
                            subtitle: `${folderSize(shownSheet.volume)} on hub`,
                          }
                        : shownSheet.kind === "conflict"
                          ? {
                              title: "Resolve conflict",
                              icon: "conflict",
                              subtitle: shownSheet.original.path.split("/").at(-1),
                            }
                          : musicSheet(shownSheet))}
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
              {shownSheet.kind === "peek" && (
                <View style={s.stack}>
                  <FilePreview entry={shownSheet.entry} files={engine.current?.files} />
                  <Button
                    label="Open"
                    onPress={() => {
                      const entry = shownSheet.entry;
                      setSheet(null);
                      openFileDetail(entry);
                    }}
                  />
                  {!!shownSheet.entry.uri && (
                    <Button
                      quiet
                      icon="export"
                      label="Share this file"
                      onPress={() =>
                        runLocal(async () => {
                          if (!(await Sharing.isAvailableAsync()))
                            throw new Error("Sharing is unavailable on this device.");
                          await Sharing.shareAsync(shownSheet.entry.uri);
                        })
                      }
                    />
                  )}
                </View>
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
              {!!musicSheet(shownSheet) && (
                <MusicSheet
                  sheet={shownSheet}
                  library={shownMusic?.library}
                  cover={musicCover}
                  locked={actionLocked}
                  open={setSheet}
                  change={changePlaylist}
                  remove={deletePlaylist}
                />
              )}
              {shownSheet.kind === "now-playing" && (
                <NowPlaying
                  library={shownMusic?.library}
                  cover={musicCover}
                  command={musicCommand}
                  openAlbum={(track) => {
                    setSheet(null);
                    setFileView("music");
                    setMusicSearch(null);
                    setMusicRoute([
                      { kind: "albums" },
                      { kind: "album", id: track.albumId },
                    ]);
                  }}
                />
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
              {shownSheet.kind === "folder-actions" &&
                folder?.id === shownSheet.volume.id && (
                  <>
                    <View style={s.actionGroup}>
                      {!!folder.selected && (
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
                      {musicFolder && (
                        <ActionRow
                          label={musicView ? "View files" : "View library"}
                          icon={musicView ? "folder" : "music"}
                          onPress={() => {
                            setSheet(null);
                            setFileView(musicView ? "files" : "music");
                            setMusicRoute([{ kind: "artists" }]);
                            setMusicSearch(null);
                            setVisibleCount(100);
                          }}
                        />
                      )}
                      {!!folder.selected && !musicFolder && (
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
                      {!!folder.selected && (
                        <ActionRow
                          label="Export folder…"
                          icon="export"
                          disabled={actionLocked}
                          onPress={() => {
                            setSheet(null);
                            run(() =>
                              engine.current.withImportPicker(async () => {
                                await engine.current.settle();
                                return engine.current.files.exportDirectory(
                                  engine.current.files.folder(
                                    engine.current.scope,
                                    folder.id,
                                  ),
                                  "arca-folder",
                                );
                              }),
                            );
                          }}
                        />
                      )}
                      {!musicFolder && (
                      <ActionRow
                        label={source ? "Change album…" : "Link album…"}
                        note={!source && status.offline ? HUB_ONLY_REASON : undefined}
                        icon="gallery"
                        disabled={
                          actionLocked ||
                          !connected ||
                          (!source &&
                            (status.offline ||
                              !currentFolder?.completed ||
                              !!currentFolder?.issue))
                        }
                        onPress={() => setSheet({ kind: "gallery" })}
                      />
                      )}
                      {source && (
                        <ActionRow
                          label={
                            source.enabled
                              ? "Disable uploads"
                              : "Enable uploads"
                          }
                          icon="upload"
                          disabled={busy || source.mode !== "source"}
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
                  <Card title="Start syncing">
                    <Text style={s.text}>
                      Download this folder and keep it in sync.
                    </Text>
                    <Text style={s.caption}>
                      {Number.isFinite(shownSheet.volume.bytes)
                        ? `Needs ${bytes(shownSheet.volume.bytes)} · `
                        : ""}
                      {bytes(status.free)} free
                    </Text>
                  </Card>
                  <Button
                    label="Start syncing"
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
                    disabled={!connected || status.offline || actionLocked}
                    onPress={() =>
                      run(() => chooseConflict(shownSheet.choice), {
                        label: "Restoring selected version…",
                        hubOnly: true,
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
                  disabled={!engine.current || !sheet.localEntry}
                  onPress={() => {
                    setFileActionsOpen(false);
                    runLocal(shareCurrentFile);
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

function galleryAPI(route, body, options) {
  return client.api(route, body, options);
}
