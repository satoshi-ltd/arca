import { normalizeTitle } from "./video-names.js";

export const RELATED_LIMIT = 12;
export const SHARED_KEYWORDS = 2;

const add = (map, key, value) => (map.get(key) || map.set(key, []).get(key)).push(value);

export function franchisesOf(title) {
  const text = String(title || "");
  const names = [text.includes(":") ? text.slice(0, text.indexOf(":")) : text, /\bA (\S+\s+\S.*) Story$/i.exec(text)?.[1]];
  return [...new Set(names.map((name) => normalizeTitle(name)).filter((name) => name.length >= 3))];
}

function index(pool, signals) {
  const byKey = new Map();
  const byCollection = new Map();
  const byKeyword = new Map();
  const byFranchise = new Map();
  for (const title of pool) {
    const signal = signals.get(title) || {};
    if (signal.key) add(byKey, signal.key, title);
    if (title.collection) add(byCollection, title.collection, title);
    for (const name of franchisesOf(title.title)) add(byFranchise, name, title);
    for (const word of new Set(signal.keywords || [])) add(byKeyword, word, title);
  }
  const recommendedBy = new Map(pool.map((title) => [title, new Set()]));
  for (const title of pool)
    for (const key of signals.get(title)?.recommended || [])
      for (const other of byKey.get(key) || []) {
        if (other === title) continue;
        recommendedBy.get(title).add(other);
        recommendedBy.get(other).add(title);
      }
  return { byCollection, byFranchise, byKeyword, recommendedBy };
}

export function relatedTitles(titles, signals = new Map(), limit = RELATED_LIMIT) {
  const result = new Map();
  for (const kids of [false, true]) {
    const pool = titles.filter((title) => !!title.kids === kids);
    const { byCollection, byFranchise, byKeyword, recommendedBy } = index(pool, signals);
    for (const item of pool) {
      const candidates = new Map();
      const entry = (other) => candidates.get(other) || candidates.set(other, { other, sibling: false, franchise: false, recommended: false, shared: 0 }).get(other);
      for (const other of (item.collection && byCollection.get(item.collection)) || []) if (other !== item) entry(other).sibling = true;
      for (const name of franchisesOf(item.title)) for (const other of byFranchise.get(name)) if (other !== item) entry(other).franchise = true;
      for (const other of recommendedBy.get(item)) entry(other).recommended = true;
      for (const word of new Set(signals.get(item)?.keywords || [])) for (const other of byKeyword.get(word)) if (other !== item) entry(other).shared++;
      const own = signals.get(item)?.key;
      const scored = [...candidates.values()].filter((c) => !(own && signals.get(c.other)?.key === own)).filter((c) => c.sibling || c.franchise || c.recommended || c.shared >= SHARED_KEYWORDS);
      scored.sort((a, b) => b.sibling - a.sibling || b.franchise - a.franchise || b.recommended - a.recommended || b.shared - a.shared || (Number(b.other.rating) || 0) - (Number(a.other.rating) || 0) || String(a.other.title).localeCompare(String(b.other.title)));
      result.set(item, scored.slice(0, limit).map((c) => c.other.id));
    }
  }
  return result;
}
