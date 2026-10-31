import { native } from "./private-network";
import { TransferSession } from "./transfer-session.js";
import { mediaLibrary } from "./media-library";
import { errorNotice } from "../../desktop/src/notice-contract.js";
import { clearIncoming } from "./incoming-files";
import { Platform, AppState, AppRegistry } from "react-native";
import * as SQLite from "expo-sqlite";
import * as Notifications from "expo-notifications";
import { NOTIFICATIONS_DENIED } from "./notification-permission.js";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { client } from "./persistence";
import { Replica } from "./replica";
import { ReplicaStore } from "./replica-store";
import { files } from "./files";
import { player } from "./music-player";
import * as Application from "expo-application";
import config from "../app.json";
let finishTransferTask;
AppRegistry.registerHeadlessTask(
  "ArcaPhotoTransfer",
  () => () =>
    new Promise((resolve) => {
      if (!transfer.active && !transfer.starting) resolve();
      else finishTransferTask = resolve;
    }),
);
let backgroundAllowed = false;
const transfer = new TransferSession({
  visible: () =>
    Platform.OS === "android" &&
    backgroundAllowed &&
    AppState.currentState === "active",
  start: async () => {
    await Notifications.requestPermissionsAsync();
    await native.startTransfer();
  },
  stop: async () => {
    finishTransferTask?.();
    finishTransferTask = null;
    await native.stopTransfer();
  },
  update: (progress) =>
    native.transferProgress(
      progress?.direction === "upload"
        ? "Uploading files"
        : progress?.direction === "download"
          ? "Downloading files"
          : "Synchronizing folders",
      progress?.bytesDone || 0,
      progress?.bytesTotal || 0,
    ),
});
export const canContinueInBackground = () =>
  transfer.active || !!transfer.starting;
if (Platform.OS === "android")
  native.addListener("transferStopped", ({ reason }) => {
    finishTransferTask?.();
    finishTransferTask = null;
    currentReplica?.suspend();
    const report = (error) => {
      if (currentReplica) currentReplica.error = error.message;
      changed();
    };
    void transfer.end().catch(report);
    if (reason === "timeout")
      report(new Error("Android stopped background synchronization after its time limit. Open the app to continue."));
    if (reason === "paused") void currentReplica?.pause(true).catch(report);
  });
export const BACKGROUND_TASK = "arca-sync";
const listeners = new Set();
let runtimePromise;
let galleryTimer;
let currentReplica;
const noticeState = new Map();
let pendingResponse = null;
let notificationEpoch = 0;
const responseListeners = new Set();
export function subscribeNotificationResponse(listener) {
  responseListeners.add(listener);
  if (pendingResponse) {
    listener(pendingResponse);
    pendingResponse = null;
  }
  return () => responseListeners.delete(listener);
}
function receivedResponse(response) {
  if (currentReplica?.removing) return;
  if (notificationEpoch && !client.state().connection?.linked) return;
  const item = response?.notification?.request?.content?.data?.notice;
  if (
    !item ||
    !["review", "retry", "pair", "backup", "folder"].includes(item.action)
  )
    return;
  Notifications.clearLastNotificationResponseAsync().catch(() => {});
  const destination = {
    ...item,
    execute: response.actionIdentifier === item.action,
  };
  if (responseListeners.size)
    for (const listener of responseListeners) listener(destination);
  else pendingResponse = destination;
}
Notifications.addNotificationResponseReceivedListener(receivedResponse);
const initialNotificationEpoch = notificationEpoch;
Notifications.getLastNotificationResponseAsync()
  .then((response) => {
    if (notificationEpoch === initialNotificationEpoch) receivedResponse(response);
  })
  .catch(() => {});
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: AppState.currentState !== "active",
    shouldShowList: AppState.currentState !== "active",
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});
async function publishConditions(store, items) {
  const ids = new Set(items.map((n) => n.id));
  for (const [id, state] of noticeState)
    if (!ids.has(id)) {
      clearTimeout(state.timer);
      noticeState.delete(id);
    }
  for (const item of items) {
    let state = noticeState.get(item.id);
    if (!state) {
      state = { since: Date.now(), sent: "", timer: null };
      noticeState.set(item.id, state);
    }
    const signature = String(item.incident || "condition");
    if (
      state.sent === signature ||
      !(await store.get("notifications", false)) ||
      AppState.currentState === "active"
    )
      continue;
    if (item.offline && Date.now() - state.since < 60000) {
      if (!state.timer)
        state.timer = setTimeout(
          () => {
            state.timer = null;
            runtime()
              .then((r) => r.sync())
              .catch(() => {});
          },
          60000 - (Date.now() - state.since),
        );
      continue;
    }
    await Notifications.scheduleNotificationAsync({
      identifier: item.id,
      content: {
        title: item.title,
        body: item.body,
        categoryIdentifier: `arca-${item.action}`,
        data: {
          notice: { id: item.id, action: item.action, volume: item.volume },
        },
        ...(Platform.OS === "ios"
          ? { threadIdentifier: item.volume || item.id }
          : {}),
      },
      trigger: null,
    });
    state.sent = signature;
  }
}
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changed() {
  transfer.progress(currentReplica?.progress);
  clearTimeout(galleryTimer);
  if (
    currentReplica?.moreGalleryWork &&
    !currentReplica.busy &&
    !currentReplica.stopped &&
    !currentReplica.paused &&
    AppState.currentState === "active"
  )
    galleryTimer = setTimeout(
      () => currentReplica.sync(false, { scheduled: true }),
      500,
    );
  for (const listener of listeners) listener();
}
export function runtime() {
  if (!runtimePromise)
    runtimePromise = (async () => {
      const store = new ReplicaStore(
        await SQLite.openDatabaseAsync("replica.sqlite"),
      );
      const replica = new Replica({
        store,
        transfer,
        media: mediaLibrary,
        player: Platform.OS === "android" ? player : null,
        cleanupDevice: () => cleanupDevice(store),
        files,
        client,
        platform: Platform.OS,
        version: Application.nativeApplicationVersion || config.expo.version,
        changed,
        notify: async (title, body, detail) => {
          if (detail?.conditions)
            return publishConditions(store, detail.conditions);
          const item = detail || { ...errorNotice(body), title };
          return publishConditions(store, [item]);
        },
      });
      currentReplica = replica;
      await client.load();
      await replica.load();
      backgroundAllowed = await replica.store.get("background", false);
      await clearIncoming(replica);
      return replica;
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
}
if (Platform.OS === "ios")
  try {
    BackgroundTask.addExpirationListener(() => currentReplica?.suspend());
  } catch {}
TaskManager.defineTask(BACKGROUND_TASK, async () => {
  try {
    const replica = await runtime();
    if (!(await replica.store.get("background", false)))
      return BackgroundTask.BackgroundTaskResult.Success;
    await replica.sync(false, { scheduled: true });
    return replica.error
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});
export async function setBackground(enabled) {
  const replica = await runtime();
  if (enabled) {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted)
      throw new Error("Background refresh is disabled in system settings");
    await BackgroundTask.registerTaskAsync(BACKGROUND_TASK, {
      minimumInterval: 15,
    });
  } else if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK))
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_TASK);
  await replica.store.set("background", enabled);
  backgroundAllowed = enabled;
  if (!enabled && transfer.active) {
    replica.suspend();
    await transfer.end().catch(() => {});
  }
}
async function cleanupDevice(store) {
  backgroundAllowed = false;
  notificationEpoch++;
  pendingResponse = null;
  for (const state of noticeState.values()) clearTimeout(state.timer);
  noticeState.clear();
  const steps = [
    ["background setting", () => store.set("background", false)],
    [
      "background task",
      async () => {
        if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK))
          await BackgroundTask.unregisterTaskAsync(BACKGROUND_TASK);
      },
    ],
    [
      "scheduled notifications",
      () => Notifications.cancelAllScheduledNotificationsAsync(),
    ],
    [
      "delivered notifications",
      () => Notifications.dismissAllNotificationsAsync(),
    ],
    [
      "notification response",
      () => Notifications.clearLastNotificationResponseAsync(),
    ],
  ];
  const results = await Promise.allSettled(
    steps.map(([, work]) => Promise.resolve().then(work)),
  );
  const failed = steps.filter(
    (_, index) => results[index].status === "rejected",
  );
  if (failed.length)
    throw new Error(
      `Device files were erased, but cleanup could not finish: ${failed.map(([name]) => name).join(", ")}. Retry Erase this device.`,
    );
}
export async function destroyReplica() {
  const replica = await runtime();
  backgroundAllowed = false;
  notificationEpoch++;
  pendingResponse = null;
  await replica.destroy(true);
}
async function registerNotificationCategories() {
  for (const [action, label] of [
    ["review", "Review"],
    ["folder", "Review"],
    ["retry", "Retry now"],
    ["pair", "Pair again"],
    ["backup", "Backup settings"],
  ])
    await Notifications.setNotificationCategoryAsync(`arca-${action}`, [
      {
        identifier: action,
        buttonTitle: label,
        options: { opensAppToForeground: true },
      },
    ]);
}
registerNotificationCategories().catch(() => {});
export async function notificationsGranted() {
  try {
    return !!(await Notifications.getPermissionsAsync()).granted;
  } catch {
    return true;
  }
}
export async function setNotifications(enabled) {
  await registerNotificationCategories();
  if (enabled) {
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted)
      throw Object.assign(new Error("Allow Arca notifications in system settings"), {
        code: NOTIFICATIONS_DENIED,
      });
    if (Platform.OS === "android")
      await Notifications.setNotificationChannelAsync("default", {
        name: "Arca",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
  }
  const replica = await runtime();
  await replica.store.set("notifications", enabled);
}
