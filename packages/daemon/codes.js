import crypto from "node:crypto";
import { fail } from "./storage.js";
export function shortCode() {
  return String(crypto.randomInt(1000000)).padStart(6, "0");
}
export function normalizeCode(value) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/[\s-]/g, "");
  if (/^[0-9]{6}$/.test(compact)) return compact;
  return "";
}
export class Attempts {
  constructor(now = Date.now) {
    this.now = now;
    this.entries = new Map();
    this.global = { count: 0, until: 0 };
  }
  check(address) {
    const now = this.now();
    for (const [key, value] of this.entries)
      if (value.until <= now) this.entries.delete(key);
    if (this.global.until <= now)
      this.global = { count: 0, until: now + 60000 };
    const entry = this.entries.get(address) || { count: 0, until: now + 60000 };
    if (
      entry.count >= 5 ||
      this.global.count >= 50 ||
      (!this.entries.has(address) && this.entries.size >= 1000)
    )
      fail("Too many attempts. Try again in one minute.", 429);
    entry.count++;
    this.global.count++;
    this.entries.set(address, entry);
  }
}
