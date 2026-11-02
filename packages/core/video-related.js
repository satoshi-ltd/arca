import { normalizeTitle } from "./video-names.js";

export const RELATED_LIMIT = 12;
export const SHARED_KEYWORDS = 2;
export const RARE_KEYWORD_SHARE = 40;
export const GENRE_MATCH = 0.55;
const TV_GENRES = new Map([
  [10759, [28, 12]],
  [10765, [878, 14]],
  [10768, [10752, 36]],
  [10762, [10751]],
]);

const add = (map, key, value) => (map.get(key) || map.set(key, []).get(key)).push(value);
const genresOf = (signal) => [...new Set((signal?.genres || []).flatMap((id) => TV_GENRES.get(id) || [id]))];

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
  const byGenre = new Map();
  const byCast = new Map();
  for (const title of pool) {
    const signal = signals.get(title) || {};
    if (signal.key) add(byKey, signal.key, title);
    if (title.collection) add(byCollection, title.collection, title);
    for (const name of franchisesOf(title.title)) add(byFranchise, name, title);
    for (const word of new Set(signal.keywords || [])) add(byKeyword, word, title);
    for (const genre of genresOf(signal)) add(byGenre, genre, title);
    for (const name of new Set(title.cast || [])) add(byCast, name, title);
  }
  const recommendedBy = new Map(pool.map((title) => [title, new Set()]));
  for (const title of pool)
    for (const key of signals.get(title)?.recommended || [])
      for (const other of byKey.get(key) || []) {
        if (other === title) continue;
        recommendedBy.get(title).add(other);
        recommendedBy.get(other).add(title);
      }
  const weight = (list) => Math.log(pool.length / list.length);
  const genreWeight = new Map([...byGenre].map(([genre, list]) => [genre, weight(list) + 0.3]));
  const groups = new Map();
  const groupOf = new Map();
  for (const title of pool) {
    const genres = genresOf(signals.get(title)).sort((a, b) => a - b);
    if (!genres.length) continue;
    const name = genres.join(",");
    const group = groups.get(name) || groups.set(name, { genres: new Set(genres), norm: Math.sqrt(genres.reduce((sum, genre) => sum + genreWeight.get(genre) ** 2, 0)), titles: [], match: null }).get(name);
    group.titles.push(title);
    groupOf.set(title, group);
  }
  const matches = (group) => {
    if (group.match) return group.match;
    group.match = new Map();
    for (const other of groups.values()) {
      let dot = 0;
      for (const genre of group.genres) if (other.genres.has(genre)) dot += genreWeight.get(genre) ** 2;
      const value = dot / (group.norm * other.norm);
      if (value >= GENRE_MATCH) group.match.set(other, value);
    }
    return group.match;
  };
  return { byCollection, byFranchise, byKeyword, byCast, recommendedBy, weight, groupOf, matches };
}

export function relatedTitles(titles, signals = new Map(), limit = RELATED_LIMIT) {
  const result = new Map();
  for (const kids of [false, true]) {
    const pool = titles.filter((title) => !!title.kids === kids);
    const { byCollection, byFranchise, byKeyword, byCast, recommendedBy, weight, groupOf, matches } = index(pool, signals);
    const rare = Math.log(RARE_KEYWORD_SHARE);
    for (const item of pool) {
      const candidates = new Map();
      const entry = (other) =>
        candidates.get(other) ||
        candidates.set(other, { other, sibling: false, franchise: false, recommended: false, shared: 0, keywords: 0, rare: false, genre: 0, cast: 0 }).get(other);
      for (const other of (item.collection && byCollection.get(item.collection)) || []) if (other !== item) entry(other).sibling = true;
      for (const name of franchisesOf(item.title)) for (const other of byFranchise.get(name)) if (other !== item) entry(other).franchise = true;
      for (const other of recommendedBy.get(item)) entry(other).recommended = true;
      for (const word of new Set(signals.get(item)?.keywords || [])) {
        const list = byKeyword.get(word);
        const value = weight(list);
        for (const other of list)
          if (other !== item) {
            const c = entry(other);
            c.shared++;
            c.keywords += value;
            if (value >= rare) c.rare = true;
          }
      }
      for (const name of new Set(item.cast || [])) for (const other of byCast.get(name)) if (other !== item) entry(other).cast++;
      const year = Number(item.year) || 0;
      const era = (title) => {
        const other = Number(title.year) || 0;
        return year && other ? Math.max(0, 1 - Math.abs(year - other) / 25) : 0;
      };
      const soft = (c) => 2 * c.keywords + 3 * c.genre + 1.2 * Math.min(c.cast, 2) + 0.6 * era(c.other);
      const key = signals.get(item)?.key;
      const group = groupOf.get(item);
      const genreMatch = group ? matches(group) : new Map();
      const order = (a, b) =>
        b.sibling - a.sibling ||
        b.franchise - a.franchise ||
        b.recommended - a.recommended ||
        b.score - a.score ||
        (Number(b.other.rating) || 0) - (Number(a.other.rating) || 0) ||
        String(a.other.title).localeCompare(String(b.other.title));
      const keyOf = (title) => signals.get(title)?.key;
      const strong = [];
      const best = [];
      const holder = new Map();
      const offer = (c) => {
        const other = keyOf(c.other);
        const held = other && holder.get(other);
        if (held) {
          if (order(c, held) >= 0) return;
          best.splice(best.indexOf(held), 1);
        } else if (best.length === limit && order(c, best[limit - 1]) >= 0) return;
        let at = best.length;
        while (at > 0 && order(c, best[at - 1]) < 0) at--;
        best.splice(at, 0, c);
        if (other) holder.set(other, c);
        if (best.length > limit) {
          const dropped = best.pop();
          const gone = keyOf(dropped.other);
          if (gone && holder.get(gone) === dropped) holder.delete(gone);
        }
      };
      for (const c of candidates.values()) {
        if (key && keyOf(c.other) === key) continue;
        c.genre = genreMatch.get(groupOf.get(c.other)) || 0;
        if (c.sibling || c.franchise || c.recommended) {
          c.score = soft(c);
          strong.push(c);
        }
      }
      const taken = new Set(strong.map((c) => keyOf(c.other)).filter(Boolean));
      const open = (title) => !(key && keyOf(title) === key) && !taken.has(keyOf(title));
      for (const c of candidates.values()) {
        if (c.sibling || c.franchise || c.recommended || !open(c.other)) continue;
        if (!(c.shared >= SHARED_KEYWORDS || c.rare || c.genre || c.cast)) continue;
        c.score = soft(c);
        if (best.length === limit && c.score < best[limit - 1].score) continue;
        offer(c);
      }
      for (const [other, value] of genreMatch)
        for (const title of other.titles) {
          const score = 3 * value + 0.6 * era(title);
          if ((best.length === limit && score < best[limit - 1].score) || title === item || candidates.has(title) || !open(title)) continue;
          offer({ other: title, sibling: false, franchise: false, recommended: false, genre: value, score });
        }
      strong.sort(order);
      const seen = new Set();
      const picked = [];
      for (const c of [...strong, ...best]) {
        const other = keyOf(c.other);
        if (other && seen.has(other)) continue;
        if (other) seen.add(other);
        picked.push(c.other.id);
        if (picked.length === limit) break;
      }
      result.set(item, picked);
    }
  }
  return result;
}
