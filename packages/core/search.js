export const SEARCH_TYPES = ["folders", "songs", "albums", "artists", "shows", "episodes", "playlists", "photos", "files"];
export const SEARCH_AUDIO = /\.(mp3|m4a|flac|wav|ogg|oga|opus|aac|aiff?|wma)$/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_NAMES = MONTHS.map((name) => name[0].toUpperCase() + name.slice(1));

export const searchFold = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .normalize("NFC");

export function searchTokens(raw) {
  const query = searchFold(String(raw ?? "").trim()).trim();
  return { query, tokens: query.split(/\s+/).filter(Boolean) };
}

export function searchRank(name, query) {
  const base = searchFold(name);
  if (base === query || base.replace(/\.[^.]+$/, "") === query) return 100;
  if (base.startsWith(query)) return 80;
  if (base.includes(query)) return 60;
  return 30;
}

const monthOf = (word) => MONTHS.findIndex((name) => word === name || word === name.slice(0, 3) || (word === "sept" && name === "september"));
const isYear = (word) => /^(19|20)\d{2}$/.test(word);

export function dateQuery(query) {
  const iso = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.exec(query);
  if (iso) {
    const month = MONTH_NAMES[Number(iso[2]) - 1];
    return { prefix: iso[0], label: iso[3] ? `${month.slice(0, 3)} ${Number(iso[3])}, ${iso[1]}` : `${month} ${iso[1]}` };
  }
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 1 && isYear(words[0])) return { prefix: words[0], label: words[0] };
  if (words.length === 1 && monthOf(words[0]) >= 0) {
    const month = monthOf(words[0]);
    return { month: String(month + 1).padStart(2, "0"), label: MONTH_NAMES[month] };
  }
  if (words.length === 2) {
    const [name, year] = isYear(words[0]) ? [words[1], words[0]] : words;
    const month = monthOf(name);
    if (month >= 0 && isYear(year)) return { prefix: `${year}-${String(month + 1).padStart(2, "0")}`, label: `${MONTH_NAMES[month]} ${year}` };
  }
  return null;
}

export function dateMatches(date, parsed) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}/.test(date) || !parsed) return false;
  return parsed.prefix ? date.startsWith(parsed.prefix) : date.slice(5, 7) === parsed.month;
}
