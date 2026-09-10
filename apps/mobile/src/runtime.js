import { clearIncoming } from "./incoming-files";
import { Platform, AppState } from "react-native";
import * as SQLite from "expo-sqlite";
import * as Notifications from "expo-notifications";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { client } from "./persistence";
import { Replica } from "./replica";
import { ReplicaStore } from "./replica-store";
import { files } from "./files";
export const BACKGROUND_TASK = "arca-sync";
const listeners = new Set();
let runtimePromise;
let lastNotice = "";
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changed() {
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
        files,
        client,
        platform: Platform.OS,
        changed,
        notify: async (title, body) => {
          if (
            !(await store.get("notifications", false)) ||
            AppState.currentState === "active" ||
            lastNotice === body
          )
            return;
          await Notifications.scheduleNotificationAsync({
            content: { title, body },
            trigger: null,
          });
          lastNotice = body;
        },
      });
      await client.load();
      await replica.load();
      await clearIncoming(replica);
      return replica;
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
}
TaskManager.defineTask(BACKGROUND_TASK, async () => {
  try {
    const replica = await runtime();
    if (!(await replica.store.get("background", false)))
      return BackgroundTask.BackgroundTaskResult.Success;
    await replica.sync();
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
}
export async function destroyReplica() {
  const replica = await runtime();
  await setBackground(false);
  await replica.destroy(true);
  await Notifications.cancelAllScheduledNotificationsAsync();
  await Notifications.dismissAllNotificationsAsync();
  lastNotice = "";
}
export async function setNotifications(enabled) {
  if (enabled) {
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted)
      throw new Error("Allow Arca notifications in system settings");
    if (Platform.OS === "android")
      await Notifications.setNotificationChannelAsync("default", {
        name: "Arca",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
  }
  const replica = await runtime();
  await replica.store.set("notifications", enabled);
}
