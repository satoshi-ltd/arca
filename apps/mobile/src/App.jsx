import { galleryVideoURI } from "./video-playback";
import { StickyDetailSide } from "./StickyDetailSide";
import * as Application from "expo-application";
import { textSizes, textScale } from "./text-size.js";
import { coalescedRefresh, retainSnapshot } from "./ui-refresh.js";
import { fileIcon } from "../../desktop/src/file-icons.js";
import { mediaSummary } from "./gallery-days";
import { native } from "./private-network.js";
import { copyPicked } from "./incoming-files.js";
import { canContinueInBackground } from "./runtime";
import { BrandActivity, Busy, LaunchHold, PullArch, Scaffold } from "./components";
import { GallerySetup } from "./GallerySource";
import { galleryConfig } from "./gallery.js";
import { allPhotosNote, sourceAlbums } from "./validation.js";
import { historyEmpty } from "./history-empty.js";
import { clockTime, dayLabel } from "./history-days.js";
import { Section } from "./components";
import { ConfirmDialog } from "./components";
import { Rise, useLeaving, useListMotion, useMotion, useRetained } from "./motion";
import { motion } from "./design-tokens.js";
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
  Reveal,
  KeyboardScrollView,
  useKeyboardVisible,
} from "./KeyboardPane";
import React, { useEffect, useState, useMemo, useRef } from "react";
import {
  AccessibilityInfo,
  View,
  Text,
  ScrollView,
  Animated,
  PanResponder,
  Pressable,
  RefreshControl,
  AppState,
  BackHandler,
  Alert,
  useColorScheme,
  Platform,
  StatusBar,
  useWindowDimensions,
  Dimensions,
  Linking,
  findNodeHandle,
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
} from "./MusicLibrary";
import { player, playerAvailable, usePlayingId } from "./music-player";
import { useAudioSession } from "./audio-session.js";
import {
  baseContext,
  folderContext,
  formatDuration,
  formatLength,
  librarySummary,
  librarySymbol,
  musicBackLabel,
  musicPane,
  musicSheet,
  parseTrackNode,
  playingFolder,
  playlistKey,
  plural,
  savedSymbol,
  spokenRepeat,
} from "./music-library.js";
import {
  folderLibrary,
  hubFolderLibrary,
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
import { bytes, folderSize, unbroken } from "./format";
import { FIRST_ROWS, browseEntries, revealWindow } from "./browse";
import { folderSections, historyTone } from "./home-data";
import { FavoritesDrawer, FavoritesSection } from "./Favorites";
import {
  FAVORITE_ICONS,
  emptyFavorites,
  favoriteCaption,
  favoriteKey,
  favoriteRoute,
  isFavorite,
  readFavorites,
  reconcileFavorites,
  sortFavorites,
  favoritesSettled,
  staleFavorites,
  toggleFavorite,
  withoutFavorites,
} from "./favorites.js";
import { FilePreview, RowThumb } from "./FilePreview";
import { GlobalSearch } from "./GlobalSearch";
import { NowPlayingPage } from "./NowPlayingPage";
import { SEARCH_PAGE, SEARCH_PHOTOS, buildResults, forgetSearch, rememberSearch, searchLanding } from "./search-local";
import { searchTokens } from "../../../packages/core/search.js";
import { cachedGalleryItems } from "./hub-gallery.js";
import { savedPosition, timeLeft as leftLabel } from "./audio-positions.js";
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
  const musicRepeat = useRef(null);
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
    [previewEntry, setPreviewEntry] = useState(null),
    [globalSearch, setGlobalSearch] = useState(false),
    [nowPlayingOpen, setNowPlayingOpen] = useState(false),
    [searchRecents, setSearchRecents] = useState([]),
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
    [focusPath, setFocusPath] = useState(null),
    [galleryFocus, setGalleryFocus] = useState(null),
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
    if (r.scope)
      changeFavorites(
        (value) => reconcileFavorites(value, folders.filter((f) => f.selected)),
        r,
      );
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
  function changeFavorites(change, r = engine.current) {
    if (!r?.scope) return Promise.resolve();
    const key = `favorites:${r.scope}`;
    const job = favoriteQueue.current.then(async () => {
      const before = readFavorites(await r.store.get(key, null));
      const after = change(before);
      if (after !== before) await r.store.set(key, after);
      if (mounted.current && engine.current === r)
        setFavorites((old) => retainSnapshot(old, after));
    });
    favoriteQueue.current = job.catch(() => {});
    return job;
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
  const [mediaCounts, setMediaCounts] = useState(null);
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
  const folderMotion = useListMotion(locals.map((f) => f.id));
  const [folderRows, folderLeft] = useLeaving(locals, (f) => f.id);
  const folderLeaving = new Set(folderRows.filter((row) => row.leaving).map((row) => row.key));
  const [pulling, setPulling] = useState(false);
  const [launchShown, setLaunchShown] = useState(true);
  const { duration: motionMs, easing: motionEase } = useMotion();
  const edge = useRef(new Animated.Value(0)).current;
  const pull = useRef(new Animated.Value(0)).current;
  const backRef = useRef(null);
  useEffect(() => {
    pull.setValue(0);
  }, [screen, folder]);
  const edgeState = useRef({ ready: false, width: 0, ms: motionMs, easing: motionEase });
  edgeState.current = { ready: !!folder && view === "Folders" && !sheet && !fileActionsOpen, width, ms: motionMs, easing: motionEase };
  const edgeSwipe = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) =>
          edgeState.current.ready && g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_, g) => edge.setValue(Math.max(0, g.dx)),
        onPanResponderRelease: (_, g) => {
          const { width: span, ms, easing } = edgeState.current;
          if (g.dx > span / 3 || g.vx > 0.6)
            Animated.timing(edge, { toValue: span, duration: ms(motion.exit), easing, useNativeDriver: true }).start(({ finished }) => {
              if (!finished) return;
              backRef.current?.();
              setTimeout(() => edge.setValue(0), motion.fast);
            });
          else Animated.timing(edge, { toValue: 0, duration: ms(motion.enter), easing, useNativeDriver: true }).start();
        },
        onPanResponderTerminate: () =>
          Animated.timing(edge, {
            toValue: 0,
            duration: edgeState.current.ms(motion.enter),
            easing: edgeState.current.easing,
            useNativeDriver: true,
          }).start(),
      }),
    [],
  );
  const [fileMenuShown, releaseFileMenu] = useRetained(fileActionsOpen ? "open" : null);
  const fileMenuFade = useRef(new Animated.Value(0)).current;
  const fileMenuRise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (fileActionsOpen) {
      fileMenuRise.setValue(0);
      Animated.parallel([fileMenuFade, fileMenuRise].map((value) =>
        Animated.timing(value, { toValue: 1, duration: motionMs(motion.fast), easing: motionEase, useNativeDriver: true }),
      )).start();
    } else if (fileMenuShown)
      Animated.timing(fileMenuFade, { toValue: 0, duration: motionMs(motion.exitFast), easing: motionEase, useNativeDriver: true }).start(
        ({ finished }) => finished && releaseFileMenu(),
      );
  }, [fileActionsOpen]);
  function dismissFileMenu() {
    setFileActionsOpen(false);
    const trigger = fileMenuTrigger.current && findNodeHandle(fileMenuTrigger.current);
    if (trigger) AccessibilityInfo.setAccessibilityFocus(trigger);
  }
  const [syncDone, setSyncDone] = useState(false);
  const [favorites, setFavorites] = useState(emptyFavorites);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  useEffect(() => {
    if (!wide) setFavoritesOpen(false);
  }, [wide]);
  const favoriteQueue = useRef(Promise.resolve());
  const wasBusy = useRef(false);
  useEffect(() => {
    const finished = wasBusy.current && !status.busy && !status.offline && !status.error;
    wasBusy.current = !!status.busy;
    if (status.busy) setSyncDone(false);
    if (!finished) return;
    setSyncDone(true);
    const timer = setTimeout(() => setSyncDone(false), 1200);
    return () => clearTimeout(timer);
  }, [status.busy]);
  useEffect(() => {
    if (!pulling || status.busy) return;
    const timer = setTimeout(() => setPulling(false), 800);
    return () => clearTimeout(timer);
  }, [pulling, status.busy]);
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
  const pullSync = screen === "Folders" && !folder && connected && !!replica;
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
  const folderIcon = photoFolder ? "gallery" : musicFolder ? librarySymbol(shownMusic?.library) : "folder";
  const shownLibrary = useRef(null);
  shownLibrary.current = shownMusic?.library || null;
  const playingVolume = playingFolder(playingId);
  const [playingMusic, setPlayingMusic] = useState(null);
  useEffect(() => {
    if (!replica || !playingVolume || playingVolume === folder?.id) return undefined;
    let active = true;
    const key = `${replica.scope}:${playingVolume}`;
    folderLibrary(replica, playingVolume).then(
      (value) => active && setPlayingMusic({ key, library: value.library }),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [replica, playingVolume, folder?.id, status.musicTick]);
  const playingLibrary =
    playingVolume && playingVolume !== folder?.id
      ? playingMusic?.key === `${replica?.scope}:${playingVolume}`
        ? playingMusic.library
        : null
      : shownMusic?.library;
  const [audioSymbols, setAudioSymbols] = useState({});
  const audioIds = locals
    .filter((f) => isMusicFolder(catalog, f.id))
    .map((f) => f.id)
    .join("\n");
  useEffect(() => {
    if (!replica?.scope || !audioIds || screen !== "Folders" || folder) return undefined;
    let active = true;
    (async () => {
      const symbols = {};
      for (const id of audioIds.split("\n")) {
        const saved = await replica.store.musicLibrary(replica.scope, id).catch(() => null);
        if (saved) symbols[id] = savedSymbol(saved.value);
      }
      if (active) setAudioSymbols(symbols);
    })();
    return () => {
      active = false;
    };
  }, [replica, audioIds, screen, folder, status.musicTick]);
  const audio = useAudioSession({
    enabled: !!connected,
    api: (route, body) => client.api(route, body),
    device: { id: connection?.id ?? null, name },
    lookup: async (id) => {
      const known = shownLibrary.current?.tracks.get(id);
      if (known?.hash) return known;
      const r = engine.current;
      const volume = id.slice(0, id.indexOf(":"));
      const path = id.slice(id.indexOf(":") + 1);
      const saved = await r.store.musicLibrary(r.scope, volume);
      return (saved?.value?.tracks || []).find((item) => item?.path === path) || null;
    },
  });
  useEffect(() => {
    if (musicFolder && connected) audio.refresh();
  }, [musicFolder, folder?.id, connected]);
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
  function openPlaying(route) {
    setNowPlayingOpen(false);
    const other =
      playingVolume && playingVolume !== folder?.id
        ? locals.find((f) => f.id === playingVolume)
        : null;
    if (other) openFolder(other).catch((e) => setError(e.message));
    setFileView("music");
    setMusicRoute(route);
  }
  function musicCommand(name, value) {
    player.command(name, value).catch((e) => setError(e.message));
  }
  function playMusic(context, track, shuffle = false, position = -1, at = 0) {
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
      musicRepeat.current = await spokenRepeat(!!track.podcast, musicRepeat.current, player);
      await player.play(
        context,
        track.id,
        shuffle,
        Number.isSafeInteger(position) ? position : -1,
      );
      if (at > 0) {
        audio.seeked();
        await player.command("seek", at * 1000);
      }
    });
  }
  function deleteTrack(track) {
    confirm(
      `Delete “${track.title}”?`,
      "It is removed from every device. History keeps it for the folder's retention and you can restore it from History." +
        (!connected || status.paused
          ? " Deletion will sync when connected and resumed."
          : ""),
      () =>
        run(
          async () => {
            if (parseTrackNode(playingId)?.track === track.id)
              await player.command("stop").catch(() => {});
            await engine.current.removeFile(track.folder, track.path);
            setSheet(null);
            musicChanged();
          },
          { success: "Track deleted" },
        ),
      "Delete",
    );
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
    setPreviewEntry(null);
  }, [folder?.id, directory, screen]);
  useEffect(() => {
    if (!globalSearch) return;
    engine.current?.store.get("searchRecents", []).then((list) => Array.isArray(list) && setSearchRecents(list)).catch(() => {});
  }, [globalSearch]);
  const searchLibraries = useRef(new Map());
  const searchPhotos = useRef(new Map());
  useEffect(() => {
    if (globalSearch) return;
    searchLibraries.current.clear();
    searchPhotos.current.clear();
  }, [globalSearch]);
  const galleryFolder = (f) => !!(galleryConfig(f) || f.gallery || catalog?.volumes?.find((v) => v.id === f.id)?.gallery);
  async function searchAll(query, type = "", offset = 0) {
    const r = engine.current;
    const volumes = locals.filter((f) => f.selected).map((f) => ({ id: f.id, name: f.name, gallery: galleryFolder(f) }));
    const { tokens } = searchTokens(query);
    const rows = {};
    const libraries = {};
    const photos = {};
    if (tokens.length)
      for (const v of volumes) {
        rows[v.id] = await r.store.searchRows(r.scope, v.id, tokens[0]);
        if (isMusicFolder(catalog, v.id) && !v.gallery) {
          if (!searchLibraries.current.has(v.id))
            searchLibraries.current.set(v.id, await folderLibrary(r, v.id).then((value) => value.library, () => null));
          libraries[v.id] = searchLibraries.current.get(v.id);
        }
        if (v.gallery) {
          if (!searchPhotos.current.has(v.id)) searchPhotos.current.set(v.id, await cachedGalleryItems(r.store, r.scope, v.id));
          photos[v.id] = searchPhotos.current.get(v.id);
        }
      }
    return buildResults({ query, type, volumes, rows, libraries, photos, limit: type ? SEARCH_PAGE : SEARCH_PHOTOS, offset });
  }
  const persistRecents = (list) => {
    setSearchRecents(list);
    engine.current?.store.set("searchRecents", list).catch(() => {});
  };
  function playFound(library, folderId, item) {
    const track = item.type === "song" || item.type === "episode" ? library?.tracks.get(item.id) : null;
    const list =
      item.type === "song"
        ? library?.albums.get(track?.albumId)
        : item.type === "episode"
          ? library?.shows.get(track?.show)
          : item.type === "album"
            ? library?.albums.get(item.id)
            : item.type === "show"
              ? library?.shows.get(item.id)
              : item.type === "playlist"
                ? library?.playlists.get(item.id)
                : null;
    const first = track || library?.tracks.get(list?.tracks[0]);
    if (!list || !first) return;
    const at = first.podcast ? savedPosition(audio.positions, first)?.position || 0 : 0;
    playMusic(folderContext(folderId, list.id), first, false, list.tracks.indexOf(first.id), at);
  }
  function openSearchResult(item, query, mode = "default") {
    setGlobalSearch(false);
    if (item.type === "action") {
      if (item.name === "sync") startSync(true);
      else if (item.name === "pause")
        run(async () => {
          await engine.current.pause(!status.paused);
          if (status.paused) startSync();
        });
      else {
        setFolder(null);
        setView(item.name === "settings" ? "Settings" : "Folders");
      }
      return;
    }
    persistRecents(rememberSearch(searchRecents, query));
    const target = locals.find((f) => f.id === (item.type === "folder" ? item.id : item.volume));
    if (!target) return;
    const cached = searchLibraries.current.get(target.id);
    const landing = searchLanding(item, mode);
    if (!landing) return;
    if (landing.to === "history") return void getHistory({ volume: item.volume, path: item.path }).catch((e) => setError(e.message));
    setView("Folders");
    openFolder(target)
      .then(async () => {
        if (landing.to === "files") {
          setFileView("files");
          setDirectory(landing.directory);
          setFocusPath(landing.focus);
        } else if (landing.to === "gallery") {
          setFileView("gallery");
          setGalleryFocus(landing.focus);
        } else if (landing.to === "music") {
          setFileView("music");
          setMusicRoute(landing.route);
          if (landing.play) playFound(cached || (await folderLibrary(engine.current, target.id)).library, target.id, item);
        }
      })
      .catch((e) => setError(e.message));
  }
  function describeFound(item) {
    const library = searchLibraries.current.get(item.volume);
    const list =
      item.type === "album"
        ? library?.albums.get(item.id)
        : item.type === "show"
          ? library?.shows.get(item.id)
          : item.type === "playlist"
            ? library?.playlists.get(item.id)
            : null;
    if (item.type === "artist") {
      const artist = library?.artists.find((entry) => entry.id === item.id);
      return artist && { cover: musicCover(artist.cover, "large"), rows: artist.albums.map((id, index) => ({ key: id, number: index + 1, title: library.albums.get(id)?.title || "", length: "" })) };
    }
    if (!list) return null;
    return {
      cover: musicCover(list.cover, "large"),
      rows: list.tracks.map((id, index) => {
        const track = library.tracks.get(id);
        return { key: id, number: track?.track ?? index + 1, title: track?.title || "", length: track?.podcast ? formatLength(track.duration) : formatDuration(track?.duration) };
      }),
    };
  }
  const favoriteSignature = favorites.items.map(favoriteKey).join("\n");
  const completedSignature = locals.map((f) => `${f.id}:${f.completed || ""}`).join("\n");
  useEffect(() => {
    const r = engine.current;
    if (!r?.scope || !favorites.items.some((entry) => entry.kind !== "folder")) return undefined;
    let active = true;
    (async () => {
      while (r.active) await r.active.catch(() => {});
      if (!active || !favoritesSettled(r)) return;
      const missing = await staleFavorites(favorites.items, locals, {
        hasPath: (folder, target) => r.store.hasPath(r.scope, folder, target),
        library: (folder) => hubFolderLibrary(r, folder),
      });
      if (active && missing.length && favoritesSettled(r)) await changeFavorites((value) => withoutFavorites(value, missing), r);
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [favoriteSignature, completedSignature, status.musicTick, status.busy, replica]);
  const favoriteFolderIcon = (f) =>
    galleryFolder(f) ? "gallery" : isMusicFolder(catalog, f.id) ? audioSymbols[f.id] || "music" : "folders";
  const describeFavorite = (entry) => {
    const f = locals.find((item) => item.id === entry.folder);
    const volume = catalog?.volumes?.find((v) => v.id === entry.folder);
    return {
      label: entry.kind === "folder" ? f?.name || entry.label : entry.label,
      caption: favoriteCaption(entry, f?.name || ""),
      cover: ["directory", "folder"].includes(entry.kind) ? undefined : musicCover(entry.cover || null, "small"),
      icon: entry.kind === "folder" && f ? favoriteFolderIcon(f) : FAVORITE_ICONS[entry.kind],
      state:
        entry.kind !== "folder"
          ? null
          : status.busy && status.syncingVolume === entry.folder
            ? "Syncing"
            : volume?.conflicts
              ? "Conflict"
              : null,
    };
  };
  const folderKind = (f) => (galleryFolder(f) ? "photos" : isMusicFolder(catalog, f.id) ? "audio" : "folders");
  const shownFavorites = sortFavorites(
    favorites.items,
    (entry) => {
      const f = locals.find((item) => item.id === entry.folder);
      return f ? folderKind(f) : "folders";
    },
    (entry) => describeFavorite(entry).label,
  );
  const toggleFavoriteEntry = (entry) => changeFavorites((value) => toggleFavorite(value, entry)).catch((e) => setError(e.message));
  const favoriteSheet = (entry, extra = {}) => setSheet({ kind: "favorite", entry, ...extra });
  function openFavorite(entry) {
    const target = locals.find((f) => f.id === entry.folder && f.selected);
    if (!target) {
      changeFavorites((value) => withoutFavorites(value, [favoriteKey(entry)])).catch(() => {});
      return;
    }
    const landing = favoriteRoute(entry);
    setView("Folders");
    openFolder(target)
      .then(() => {
        if (landing.to === "files") {
          setFileView("files");
          setDirectory(landing.directory);
        } else if (landing.to === "music") {
          setFileView("music");
          setMusicRoute(landing.route);
        }
      })
      .catch((e) => setError(e.message));
  }
  const actionLocked = busy || !engine.current;
  async function openFolder(f) {
    setEntries(
      folderLists.current.get(`${engine.current?.scope}:${f.id}`) || [],
    );
    setFolder(f);
    setMediaCounts(null);
    setFocusPath(null);
    setGalleryFocus(null);
    setFileView(
      (f.gallery || catalog?.volumes?.find((v) => v.id === f.id)?.gallery) &&
        !galleryConfig(f)
        ? "gallery"
        : isMusicFolder(catalog, f.id) && !galleryConfig(f)
          ? "music"
          : "files",
    );
    setMusicRoute([{ kind: "artists" }]);
    setDirectory("");
    setShownRows(FIRST_ROWS);
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
    [shownRows, setShownRows] = useState(FIRST_ROWS);
  const visibleEntries = useMemo(
    () => browseEntries(entries, directory),
    [entries, directory],
  );
  useEffect(() => {
    setShownRows((shown) => revealWindow(visibleEntries, focusPath, shown));
  }, [focusPath, visibleEntries]);
  const entrySummary = useMemo(
    () => ({
      files: entries.filter((entry) => !entry.directory).length,
      bytes: entries.reduce((total, entry) => total + (entry.size || 0), 0),
    }),
    [entries],
  );
  const folderSubtitle = unbroken(`${photoFolder ? (mediaCounts ? mediaSummary(mediaCounts.photos, mediaCounts.videos) : "— photos") : musicView && shownMusic ? librarySummary(shownMusic.library) : `${entrySummary.files} files`} · ${bytes(entrySummary.bytes)} local${status.paused ? " · Paused" : ""}`);
  const musicShown = musicView && shownMusic?.library?.tracks.size ? shownMusic.library : null;
  const searchable = !!connection && locals.some((f) => f.selected);
  const musicAt = musicShown ? musicPane(musicRoute, wide) : null;
  const musicDeep = !!musicAt && musicAt.level > 0;
  const musicArtist =
    musicDeep && wide && musicRoute[musicAt.level].kind === "artist"
      ? musicShown.artists.find((item) => item.id === musicRoute[musicAt.level].id) || null
      : null;
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
        onSummary={setMediaCounts}
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
        focus={galleryFocus}
        onFocused={() => setGalleryFocus(null)}
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
    const handler = () => {
      if (fileActionsOpen) {
        dismissFileMenu();
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
    };
    backRef.current = handler;
    const listener = BackHandler.addEventListener("hardwareBackPress", handler);
    return () => listener.remove();
  }, [
    sheet,
    folder,
    view,
    fileActionsOpen,
    musicView,
    musicRoute,
    shownMusic,
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
          <View style={s.root}>
            <LaunchHold />
          </View>
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
          fontScale: fontScale * textScale(prefs.textSize),
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
                onFavorites={onboarding ? undefined : () => setFavoritesOpen(true)}
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
                          label={
                            musicDeep
                              ? musicBackLabel(
                                  musicRoute,
                                  musicAt.level,
                                  musicShown,
                                  folder.name,
                                )
                              : "Folders"
                          }
                          icon="back"
                          onPress={() =>
                            musicDeep
                              ? setMusicRoute(musicRoute.slice(0, musicAt.level))
                              : setFolder(null)
                          }
                        />
                      </View>
                    )}
                    {!onboarding && (detail || !(musicDeep && !musicArtist)) && (
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
                          ) : musicArtist ? (
                            <ScreenTitle
                              contentIcon="artist"
                              subtitle={`${plural(musicArtist.albums.length, "album", "albums")} · ${plural(musicArtist.tracks, "track", "tracks")}`}
                            >
                              {musicArtist.name}
                            </ScreenTitle>
                          ) : folder && view === "Folders" ? (
                            <ScreenTitle
                              detail={compactAndroid}
                              contentIcon={folderIcon}
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
                            {searchable && (
                              <Button
                                iconOnly
                                ghost
                                label="Search Arca"
                                icon="search"
                                onPress={() => setGlobalSearch(true)}
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
                        {searchable && !folder && !detail && (
                          <Button
                            iconOnly
                            ghost
                            label="Search Arca"
                            icon="search"
                            onPress={() => setGlobalSearch(true)}
                          />
                        )}
                        {connected && screen === "Folders" && folder && (
                          <Button
                            iconOnly
                            label="Sync now"
                            swap
                            icon={syncDone ? "check" : "refresh"}
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
                <Animated.View
                  style={[s.flex, { transform: [{ translateX: edge }] }]}
                  onLayout={(event) => {
                    const { y, height } = event.nativeEvent.layout;
                    setGalleryViewport((old) =>
                      old.y === y && old.height === height
                        ? old
                        : { y, height },
                    );
                  }}
                >
                <KeyboardScrollView
                  key={`${screen}:${folder?.id || ""}${musicView ? `:${musicRoute.length}:${JSON.stringify(musicRoute.at(-1))}` : ""}`}
                  onScroll={(event) => {
                    const { contentOffset } = event.nativeEvent;
                    if (Platform.OS === "ios") pull.setValue(Math.max(0, Math.min(1, -contentOffset.y / 56)));
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
                  refreshControl={
                    pullSync ? (
                      <RefreshControl
                        refreshing={pulling}
                        tintColor={Platform.OS === "ios" ? "transparent" : c.accent}
                        colors={[c.accent]}
                        progressBackgroundColor={c.paper}
                        onRefresh={() => {
                          if (status.paused) return;
                          setPulling(true);
                          startSync(true);
                        }}
                      />
                    ) : undefined
                  }
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
                            go={setMusicRoute}
                            select={(kind) => setMusicRoute([{ kind }])}
                            history={musicHistory}
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
                            resumeActions={(value) =>
                              setSheet({ kind: "resume-actions", ...value })
                            }
                            favorite={{
                              has: (entry) => isFavorite(favorites, entry),
                              hold: (entry) => favoriteSheet(entry),
                              toggle: toggleFavoriteEntry,
                            }}
                            positions={audio.positions}
                            loaded={audio.loaded}
                            command={musicCommand}
                            deviceId={connection?.id}
                            relative={relative}
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
                                      setShownRows(FIRST_ROWS);
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
                                        setFocusPath(null);
                                        setShownRows(FIRST_ROWS);
                                      }}
                                    />
                                    {shownRows.start > 0 && (
                                      <Button
                                        label="Show earlier files"
                                        onPress={() => setShownRows((shown) => ({ ...shown, start: Math.max(0, shown.start - 100) }))}
                                      />
                                    )}
                                    {visibleEntries
                                      .slice(shownRows.start, shownRows.end)
                                      .map((e, index) => (
                                        <Reveal key={e.path} active={focusPath === e.path}>
                                        <Pressable
                                          accessibilityRole="button"
                                          accessibilityLabel={
                                            e.directory
                                              ? `Open folder ${e.label}`
                                              : e.label
                                          }
                                          onPress={() => {
                                            if (e.directory) {
                                              setDirectory(e.path + "/");
                                              setShownRows(FIRST_ROWS);
                                            } else if (wide && !compact) setPreviewEntry(e);
                                            else openFileDetail(e);
                                          }}
                                          onLongPress={() => {
                                            if (!e.directory) setSheet({ kind: "peek", entry: e });
                                            else
                                              favoriteSheet(
                                                { folder: folder.id, kind: "directory", target: e.path, label: e.label },
                                                { detail: `${e.count} ${e.count === 1 ? "file" : "files"}`, open: () => setDirectory(e.path + "/") },
                                              );
                                          }}
                                          accessibilityActions={
                                            e.directory
                                              ? [
                                                  {
                                                    name: "favorite",
                                                    label: isFavorite(favorites, { folder: folder.id, kind: "directory", target: e.path })
                                                      ? "Remove from Favorites"
                                                      : "Add to Favorites",
                                                  },
                                                ]
                                              : [{ name: "preview", label: "Preview" }]
                                          }
                                          onAccessibilityAction={(event) => {
                                            const action = event.nativeEvent.actionName;
                                            if (action === "preview" && !e.directory) setSheet({ kind: "peek", entry: e });
                                            else if (action === "favorite" && e.directory)
                                              toggleFavoriteEntry({ folder: folder.id, kind: "directory", target: e.path, label: e.label });
                                          }}
                                          style={[
                                            s.settingRow,
                                            s.separator,
                                            ((previewEntry?.path === e.path && wide && !compact) || focusPath === e.path) && s.historyRowChosen,
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
                                        </Reveal>
                                      ))}
                                    {filesLoading && !entries.length && (
                                      <Scaffold label="Loading files" />
                                    )}
                                  </View>
                                  {!filesLoading &&
                                    !visibleEntries.length && (
                                      <EmptyState
                                        icon="arca"
                                        title={
                                          currentFolder?.completed
                                            ? "This folder is empty"
                                            : "No local files yet"
                                        }
                                        text={
                                          currentFolder?.completed
                                            ? "Files appear here as they arrive from your hub."
                                            : "Files appear here as they download from your hub."
                                        }
                                      />
                                    )}
                                  {visibleEntries.length > shownRows.end && (
                                    <Button
                                      label="Show more files"
                                      onPress={() =>
                                        setShownRows((shown) => ({ ...shown, end: shown.end + 100 }))
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
                          <FavoritesSection
                            items={shownFavorites}
                            describe={describeFavorite}
                            open={openFavorite}
                            remove={(entry) =>
                              changeFavorites((value) => withoutFavorites(value, [favoriteKey(entry)])).catch((e) => setError(e.message))
                            }
                          />
                          {folderSections(folderRows.map((row) => row.item), folderKind).map((section) => (
                            <Section key={section.kind}>
                              <Text style={s.eyebrow}>{section.label}</Text>
                              <View style={s.group}>
                                {section.folders.map((f, index) => (
                                  <Rise
                                    key={f.id}
                                    tint={c.tint}
                                    leaving={folderLeaving.has(f.id)}
                                    onLeft={() => folderLeft(f.id)}
                                    {...folderMotion(f.id)}
                                  >
                                  <FolderRow
                                    grouped
                                    divider={index > 0}
                                    name={f.name}
                                    icon={
                                      section.kind === "photos"
                                        ? "gallery"
                                        : section.kind === "audio"
                                          ? audioSymbols[f.id] || "music"
                                          : "folders"
                                    }
                                    description={unbroken(`${f.files} files · ${bytes(f.bytes)} local`)}
                                    conflict={!!catalog?.volumes?.find((v) => v.id === f.id)?.conflicts}
                                    progress={
                                      status.busy &&
                                      status.syncingVolume === f.id &&
                                      status.progress?.bytesTotal > 0
                                        ? status.progress.bytesDone /
                                          status.progress.bytesTotal
                                        : undefined
                                    }
                                    status={
                                      status.paused
                                        ? "Paused"
                                        : f.issue || galleryConfig(f)?.issue
                                          ? "Needs attention"
                                          : status.offline
                                            ? "Offline"
                                            : !connected
                                              ? "Disconnected"
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
                                    onLongPress={() =>
                                      favoriteSheet(
                                        { folder: f.id, kind: "folder", target: "", label: f.name },
                                        { open: () => openFolder(f).catch((e) => setError(e.message)) },
                                      )
                                    }
                                    favorite={isFavorite(favorites, { folder: f.id, kind: "folder", target: "" })}
                                    onFavorite={() => toggleFavoriteEntry({ folder: f.id, kind: "folder", target: "", label: f.name })}
                                  />
                                  </Rise>
                                ))}
                              </View>
                            </Section>
                          ))}
                          {volumes.some(
                            (v) => !locals.some((f) => f.id === v.id),
                          ) && (
                            <Section>
                              <Text style={s.eyebrow}>
                                ON HUB · NOT SELECTED
                              </Text>
                              <View style={s.availableGroup}>
                                {volumes
                                  .filter(
                                    (v) => !locals.some((f) => f.id === v.id),
                                  )
                                  .map((v, index) => (
                                    <FolderRow
                                      key={v.id}
                                      grouped
                                      dashedDivider={index > 0}
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
                                icon="arca"
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
                  {screen === "Devices" && (
                    <>
                      {connection ? null : (
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
                      {connection && (
                        <>
                          <Section>
                            <Text style={s.eyebrow}>DEVICES</Text>
                            {machinesSaved && !!machines?.length && (
                              <Text style={s.caption}>
                                Showing saved device information.
                              </Text>
                            )}
                            {!machines && !status.offline && (
                              <Scaffold label="Loading devices" />
                            )}
                            <View style={s.group}>
                              <HubConnection
                                grouped
                                connection={connection}
                                name={catalog?.name}
                                machine={machines?.find((m) => m.isHub)}
                                busy={actionLocked}
                                disconnect={disconnect}
                                retry={() => run(() => client.refresh(), { hubOnly: true })}
                              />
                              <MachineRow
                                grouped
                                divider
                                name={name}
                                self
                                role="Replica"
                                totals={unbroken(`${locals.filter((f) => f.selected).length} folders · ${bytes(locals.filter((f) => f.selected).reduce((n, f) => n + (f.bytes || 0), 0))} local`)}
                                description={`${Platform.OS === "ios" ? "iOS" : "Android"}${machines?.find((m) => m.credentialId === connection.id)?.lastAddress ? ` · ${machines.find((m) => m.credentialId === connection.id).lastAddress}` : ""}`}
                                state={
                                  status.paused
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
                                              : "Not yet synced"
                                }
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
                                      grouped
                                      divider
                                      name={m.name}
                                      description={`${{ darwin: "macOS", android: "Android", ios: "iOS", linux: "Linux", win32: "Windows" }[m.platform] || m.platform || "Platform not reported"}${m.lastAddress ? ` · ${m.lastAddress}` : ""}`}
                                      role={m.role || "Replica"}
                                      backup={!!m.backup?.enabled}
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
                    </>
                  )}
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
                      {!!history.versions.length && (
                        <View style={s.historyGroups}>
                          {Array.from(
                            history.versions.reduce((groups, row) => {
                              const day = dayLabel(row.created);
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
                                    <View
                                      style={[
                                        s.historyGlyph,
                                        historyTone(row) === "warning" && s.tileWarning,
                                        historyTone(row) === "neutral" && s.tileNeutral,
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
                                            ? c.soft
                                            : historyTone(row) === "warning"
                                              ? c.warning
                                              : c.accent
                                        }
                                      />
                                    </View>
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
                                        {!wide && (
                                          <Text style={s.tabularTime}>
                                            {` · ${clockTime(row.created)}`}
                                          </Text>
                                        )}
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
                                          {clockTime(row.created)}
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
                </Animated.View>
                {!!folder && view === "Folders" && !sheet && !fileActionsOpen && (
                  <View style={s.edgeStrip} {...edgeSwipe.panHandlers} />
                )}
                {Platform.OS === "ios" && pullSync && (
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      s.pullMark,
                      { opacity: pulling ? 1 : pull.interpolate({ inputRange: [0, 0.01, 1], outputRange: [0, 1, 1] }) },
                    ]}
                  >
                    <PullArch pull={pull} refreshing={pulling} />
                  </Animated.View>
                )}
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
                    library={playingLibrary}
                    cover={musicCover}
                    open={() => setNowPlayingOpen(true)}
                    command={musicCommand}
                    sleep={audio.sleep}
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
          {wide && (
            <FavoritesDrawer
              visible={favoritesOpen}
              onClose={() => setFavoritesOpen(false)}
              view={view}
              select={selectTab}
              items={shownFavorites}
              describe={describeFavorite}
              open={openFavorite}
              remove={(entry) =>
                changeFavorites((value) => withoutFavorites(value, [favoriteKey(entry)])).catch((e) => setError(e.message))
              }
            />
          )}
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
          <NowPlayingPage
            visible={nowPlayingOpen}
            library={playingLibrary}
            cover={musicCover}
            command={musicCommand}
            play={(context, track, position, at) => playMusic(context, track, false, position, at)}
            onClose={() => setNowPlayingOpen(false)}
            sleep={audio.sleep}
            setSleep={audio.setSleep}
            seeked={audio.seeked}
            positions={audio.positions}
            openShow={(track) => openPlaying([{ kind: "podcasts" }, { kind: "show", id: track.show }])}
            openAlbum={(track) => openPlaying([{ kind: "albums" }, { kind: "album", id: track.albumId }])}
            openArtist={(artist) => openPlaying([{ kind: "artists" }, { kind: "artist", id: artist.id }])}
          />
          <GlobalSearch
            visible={globalSearch}
            twoPane={wide && !compact}
            search={searchAll}
            recents={searchRecents}
            onForget={(text) => persistRecents(forgetSearch(searchRecents, text))}
            actions={[
              ...(status.paused ? [] : [{ name: "sync", label: "Sync now", icon: "refresh" }]),
              { name: "pause", label: status.paused ? "Resume sync" : "Pause sync", icon: status.paused ? "play" : "pause" },
              { name: "choose", label: "Open Folders", icon: "folders" },
              { name: "settings", label: "Open Settings", icon: "settings" },
            ]}
            onOpen={openSearchResult}
            onClose={() => setGlobalSearch(false)}
            uri={(r) => {
              const e = engine.current;
              if (!e?.scope) return null;
              const uri = e.files.work(e.scope, r.volume, r.path);
              return !e.files.present || e.files.present(uri) ? uri : null;
            }}
            cover={(key) => musicCover(key, "small")}
            files={engine.current?.files}
            folderFiles={(id) => locals.find((f) => f.id === id)?.files || 0}
            timeLeft={(item) => {
              const saved = item.type === "episode" ? savedPosition(audio.positions, { folder: item.volume, path: item.path }) : null;
              return saved ? leftLabel(saved.duration - saved.position) : null;
            }}
            describe={describeFound}
          />
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
                  : shownSheet.kind === "history-filter"
                    ? { title: "Shared folder", icon: "folders" }
                    : shownSheet.kind === "folder-actions"
                      ? {
                          title: shownSheet.volume.name,
                          icon: folderIcon,
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
                          : shownSheet.kind === "favorite"
                            ? {
                                title: describeFavorite(shownSheet.entry).label,
                                icon: describeFavorite(shownSheet.entry).icon,
                                subtitle: [describeFavorite(shownSheet.entry).caption, shownSheet.detail].filter(Boolean).join(" · "),
                                menu: true,
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
                  removeTrack={deleteTrack}
                  favorite={{
                    has: (entry) => isFavorite(favorites, entry),
                    toggle: toggleFavoriteEntry,
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
              {shownSheet.kind === "favorite" && (
                <View style={s.actionGroup}>
                  {!!shownSheet.open && (
                    <ActionRow
                      label="Open"
                      icon="folder-open"
                      onPress={() => {
                        setSheet(null);
                        shownSheet.open();
                      }}
                    />
                  )}
                  <ActionRow
                    label={isFavorite(favorites, shownSheet.entry) ? "Remove from Favorites" : "Add to Favorites"}
                    icon={isFavorite(favorites, shownSheet.entry) ? "star-off" : "star"}
                    divider={!!shownSheet.open}
                    onPress={() => {
                      setSheet(null);
                      toggleFavoriteEntry(shownSheet.entry);
                    }}
                  />
                </View>
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
                            setShownRows(FIRST_ROWS);
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
          {!!fileMenuShown && historyDetail && (
            <View style={s.fileMenuOverlay} pointerEvents={fileActionsOpen ? "box-none" : "none"}>
              <Pressable
                style={s.fileMenuDismiss}
                accessibilityRole="button"
                accessibilityLabel="Close file actions"
                onPress={dismissFileMenu}
              />
              <Animated.View
                style={[
                  s.fileActionMenu,
                  fileMenuStyle,
                  {
                    opacity: fileMenuFade,
                    transform: [
                      {
                        translateY: fileMenuRise.interpolate({
                          inputRange: [0, 1],
                          outputRange: [-motion.distance / 2, 0],
                        }),
                      },
                    ],
                  },
                ]}
              >
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
              </Animated.View>
            </View>
          )}
        </View>
        {launchShown && <LaunchHold leaving onLeft={() => setLaunchShown(false)} />}
      </Design.Provider>
    </SafeAreaProvider>
  );
}

function galleryAPI(route, body, options) {
  return client.api(route, body, options);
}
