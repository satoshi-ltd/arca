import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { resolvePrivateURL, nativeFetch } from "./private-network";
import { createClient } from "./client";

const KEY = "arca.hub";
const database = SQLite.openDatabaseAsync("arca.sqlite");
async function db() {
  const value = await database;
  await value.execAsync(
    "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  return value;
}
export const client = createClient({
  resolvePrivateURL,
  fetcher: nativeFetch,
  fileTransfers: true,
  secrets: {
    async read() {
      const value = await SecureStore.getItemAsync(KEY);
      return value ? JSON.parse(value) : null;
    },
    write(value) {
      return SecureStore.setItemAsync(KEY, JSON.stringify(value), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    },
    clear() {
      return SecureStore.deleteItemAsync(KEY);
    },
  },
  cache: {
    async read() {
      const row = await (
        await db()
      ).getFirstAsync("SELECT value FROM cache WHERE key = ?", "catalog");
      return row ? JSON.parse(row.value) : null;
    },
    async write(value) {
      await (
        await db()
      ).runAsync(
        "INSERT OR REPLACE INTO cache VALUES (?, ?)",
        "catalog",
        JSON.stringify(value),
      );
    },
  },
});
