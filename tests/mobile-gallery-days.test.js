import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as galleryDays from "../apps/mobile/src/gallery-days.js";
import { galleryComplete, galleryCounts, mediaSummary, localMonths, memoryText, monthSections, shownMonths } from "../apps/mobile/src/gallery-days.js";
import { monthLabel, railMonthLabel } from "../apps/mobile/src/gallery-timeline.js";
import { GALLERY_HEADER, GALLERY_SECTION_GAP, galleryLayout, galleryWindow, hubCardSize, itemOffset, mediaAspect, memoryCard, stickyHeading, wallCard } from "../apps/mobile/src/gallery-layout.js";
import { SHARP_BATCH, SHARP_IDLE_MS, SHARP_KEEP, keepRecent, sharpenTiles, tileSources } from "../apps/mobile/src/gallery-sharp.js";
import { levelColumns } from "../apps/mobile/src/gallery-scale.js";
import { mediaSummary as desktopSummary } from "../apps/desktop/src/gallery-timeline-layout.js";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const photos = (day, count, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ path: `${day}/${from + i}.jpg`, date: `${day}T10:${String(i % 60).padStart(2, "0")}:00` }));

test("photos without a date read Date unknown, as on desktop", () => {
  assert.equal(monthLabel("undated"), "Date unknown");
  assert.equal(railMonthLabel("undated"), "Date unknown");
});

test("a UTC capture whose local day falls in the next month is filed under that month", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Madrid";
  try {
    const night = { path: "night.jpg", date: "2026-09-30T23:30:00.000Z" };
    const view = new Map([
      ["2026-10", [{ path: "b.jpg", date: "2026-10-02T09:00:00" }, { path: "a.jpg", date: "2026-10-01T08:00:00" }]],
      ["2026-09", [night, { path: "c.jpg", date: "2026-09-29T10:00:00" }]],
      ["undated", [{ path: "u.jpg", date: null }]],
    ]);
    const months = localMonths(view);
    assert.deepEqual(months.get("2026-10").map((item) => item.path), ["b.jpg", "a.jpg", "night.jpg"]);
    assert.deepEqual(months.get("2026-09").map((item) => item.path), ["c.jpg"]);
    assert.equal(months.get("undated"), view.get("undated"), "untouched months keep their identity");
    const alone = localMonths(new Map([["2026-09", [night]]]));
    assert.deepEqual([...alone.keys()], ["2026-09", "2026-10"]);
    assert.deepEqual(alone.get("2026-09"), []);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("a month gained only through local re-filing shows as a complete section, and a month that lost photos counts what it shows", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Madrid";
  try {
    const night = { path: "night.jpg", date: "2026-09-30T23:30:00.000Z" };
    const c = { path: "c.jpg", date: "2026-09-29T10:00:00" };
    const source = {
      timeline: [{ month: "2026-09", count: 2 }],
      months: { "2026-09": { items: [night, c], complete: true, next: null } },
    };
    const months = localMonths(new Map([["2026-09", [night, c]]]));
    const shown = shownMonths(source, months);
    assert.deepEqual(shown["2026-10"], { items: [night], fresh: 1, complete: true, next: null });
    const sections = monthSections(source, months, shown);
    assert.deepEqual(sections, [{ month: "2026-10", count: 1 }, { month: "2026-09", count: 1 }]);
    const plain = { timeline: [{ month: "2026-08", count: 3 }], months: { "2026-08": { items: [], complete: false } } };
    assert.equal(shownMonths(plain, new Map([["2026-08", []]])), plain.months, "nothing added keeps the hub's months");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("undated photos sit after every dated month, before and after their rows load", () => {
  const source = {
    timeline: [{ month: "2026-09", count: 1 }],
    undated: 3,
    months: { "2026-09": { items: [{ path: "a.jpg", date: "2026-09-02" }], complete: true, next: null } },
  };
  const months = new Map([["2026-09", source.months["2026-09"].items]]);
  assert.deepEqual(monthSections(source, months, source.months), [
    { month: "2026-09", count: 1 },
    { month: "undated", count: 3 },
  ]);
  const undated = [{ path: "u.jpg", date: null }];
  const loaded = { ...source, undated: 1, months: { ...source.months, undated: { items: undated, complete: true, next: null } } };
  assert.deepEqual(
    monthSections(loaded, new Map([...months, ["undated", undated]]), loaded.months).map((section) => section.month),
    ["2026-09", "undated"],
  );
  assert.deepEqual(monthSections({ ...source, undated: 0 }, months, source.months), [{ month: "2026-09", count: 1 }]);
  assert.equal(galleryComplete(source), false, "undated photos the hub has not paged yet keep the gallery incomplete");
  assert.equal(galleryComplete(loaded), true);
  assert.equal(galleryComplete({ ...source, undated: 0 }), true);
});

test("photos in a month run newest first by instant, however the hub ordered their text", () => {
  const zone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const night = { path: "night.jpg", date: "2026-09-27T02:30:00.000Z" };
    const late = { path: "late.jpg", date: "2026-09-26T23:00:00" };
    const c = { path: "c.jpg", date: "2026-09-26T10:00:00" };
    const months = localMonths(new Map([["2026-09", [night, late, c]]]));
    assert.deepEqual(months.get("2026-09").map((item) => item.path), ["late.jpg", "night.jpg", "c.jpg"]);
    const sorted = [late, c];
    assert.equal(localMonths(new Map([["2026-09", sorted]])).get("2026-09"), sorted, "an ordered month keeps its identity");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("the phone gallery builds its sections from the shared month helpers", () => {
  const screen = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(screen, /localMonths\(hubMonths\)[\s\S]*shownMonths\(source, months\)[\s\S]*monthSections\(source, months, shown\)/);
});

test("a pending flight is seen by the page before the hook takes it", () => {
  const motion = read("../apps/mobile/src/motion.js");
  assert.match(motion, /ready: !\(active && key && hasFlight\(key\)\)/);
  const page = read("../apps/mobile/src/NowPlayingPage.jsx");
  assert.match(page, /flying\.current = visible && hasFlight\("cover"\)/);
  assert.match(page, /const lift = flying\.current \? 0 : height \* 0\.2;/);
  const music = read("../apps/mobile/src/MusicLibrary.jsx");
  assert.match(music, /setTimeout\(go, 150\)/);
  const app = read("../apps/mobile/src/App.jsx");
  assert.match(app, /if \(status\.busy\) setSyncDone\(false\);/);
});

test("the gallery header counts videos apart from photos, from the timeline or what is loaded", () => {
  const hub = { timeline: [{ month: "2026-09", count: 2, videos: 2 }], undated: 0, undatedVideos: 0, total: 2, months: {} };
  assert.deepEqual(galleryCounts(hub, []), { photos: 0, videos: 2 });
  const mixed = { timeline: [{ month: "2026-09", count: 3, videos: 1 }], undated: 1, undatedVideos: 0, total: 4, months: {} };
  assert.deepEqual(galleryCounts(mixed, []), { photos: 3, videos: 1 });
  const local = { timeline: [], undated: 0, total: 0, months: {} };
  const loaded = [{ path: "a.mp4", kind: "video" }, { path: "b.mp4", kind: "video" }];
  assert.deepEqual(galleryCounts(local, loaded), { photos: 0, videos: 2 });
});

test("the phone words a gallery summary exactly as desktop does", () => {
  assert.equal(mediaSummary(0, 2), "2 videos");
  assert.equal(mediaSummary(3, 1), "3 photos · 1 video");
  assert.equal(mediaSummary(1, 0), "1 photo");
  for (const [photos, videos] of [[0, 0], [0, 1], [0, 2], [1, 0], [3, 1], [3046, 593], [1, 1]])
    assert.equal(mediaSummary(photos, videos), desktopSummary(photos, videos));
});

const interpolate = ({ inputRange: [a, b], outputRange: [x, y] }, value) =>
  value <= a ? x : value >= b ? y : x + ((value - a) * (y - x)) / (b - a);

test("a month is its heading and one continuous grid, newest first, with no day headings at any level", () => {
  const items = [...photos("2026-09-12", 3), ...photos("2026-09-11", 1), ...photos("2026-09-10", 6)];
  for (const level of ["base", "compact"]) {
    const columns = levelColumns(level, 4);
    const layout = galleryLayout([{ month: "2026-09", count: items.length }, { month: "2026-08", count: 5 }], 344, columns);
    const [september, august] = layout.sections;
    assert.equal(september.height, GALLERY_HEADER + Math.ceil(items.length / columns) * layout.step - layout.gap);
    assert.equal(august.top, september.height + GALLERY_SECTION_GAP);
    assert.equal(itemOffset(layout, "2026-09", columns), september.gridTop + layout.step, "the second row follows the first by one step");
    assert.ok(layout.sections.every((section) => !("plan" in section)));
    assert.deepEqual(Object.keys(galleryWindow(layout, 0, layout.height)[0]).sort(), ["first", "last", "section"]);
  }
  for (const name of ["dayPlan", "dayBlocks", "blockLabel", "dayHeading", "completeDays", "planCell", "DAY_HEAD"])
    assert.equal(galleryDays[name], undefined, `${name} is gone`);
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.doesNotMatch(gallery, /dayHead|dayTick|dayLabel|completeDays|planCell|section\.plan/);
  assert.match(gallery, /galleryLayout\(\s+sections,\s+width,\s+density === "years" \? compactColumns\(columns\) : density,\s+\)/);
  assert.doesNotMatch(read("../apps/mobile/src/theme.js"), /dayHead|dayTick|dayLabel/);
});

test("the month heading sticks while its photos pass under it and the next month pushes it out", () => {
  const layout = galleryLayout([{ month: "2026-09", count: 30 }, { month: "2026-08", count: 8 }], 344, 4);
  const [september, august] = layout.sections;
  const start = 500;
  const { shift, fade } = stickyHeading(september, start);
  assert.equal(shift.extrapolate, "clamp");
  assert.equal(fade.extrapolate, "clamp");
  const travel = september.height - GALLERY_HEADER;
  assert.equal(interpolate(shift, 0), 0, "above its month it rests in place");
  assert.equal(interpolate(fade, start + september.top), 0, "no fade before photos pass under it");
  const scroll = start + september.top + 200;
  assert.equal(september.top + interpolate(shift, scroll), scroll - start, "it holds the top of the viewport");
  assert.equal(interpolate(fade, scroll), 1);
  const pushed = start + august.top - GALLERY_HEADER / 2;
  assert.equal(interpolate(shift, pushed), travel, "it stops at the end of its month");
  assert.ok(september.top + interpolate(shift, pushed) + GALLERY_HEADER <= august.top, "and never overlaps the next heading");
  assert.equal(stickyHeading(august, start).shift.inputRange[0], start + august.top);
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  const heading = gallery.slice(gallery.indexOf("const StickyMonth = memo(function StickyMonth("), gallery.indexOf("const Tile = memo("));
  assert.ok(heading.length > 0, "each heading is its own memoized component");
  assert.match(heading, /useMemo\(\(\) => \{[\s\S]*?stickyHeading\(\{ top, height \}, start\);[\s\S]*?scrollY\.interpolate\(stick\.shift\)[\s\S]*?scrollY\.interpolate\(stick\.fade\)[\s\S]*?\}, \[scrollY, top, height, start\]\)/, "interpolations survive re-renders, so a re-attached node never snaps for a frame");
  assert.match(heading, /translateY: motion \? motion\.shift : 0/);
  assert.match(heading, /opacity: motion\.fade/);
  assert.match(heading, /pointerEvents="box-only"/, "a tap on the stuck heading stops there instead of opening the photo under it");
  assert.doesNotMatch(heading, /pointerEvents="none"|onPress|Responder/, "the heading absorbs taps with no action and leaves scrolling to the scroll view");
  assert.match(gallery, /\{rows\.map\(\(\{ section \}\) => \(\s+<StickyMonth\s+key=\{`month:\$\{section\.month\}`\}\s+month=\{section\.month\}\s+top=\{section\.top\}\s+height=\{section\.height\}\s+start=\{rootTop\.current \+ canvasTop\.current\}\s+scrollY=\{position\?\.scrollY\}/, "every month in the window draws its heading, even when its top has scrolled past");
  const theme = read("../apps/mobile/src/theme.js");
  assert.match(theme, /galleryHeader: \{\s+position: "absolute",\s+left: 0,\s+right: 0,\s+zIndex: 1,\s+backgroundColor: c\.paper,\s+\}/);
  assert.match(theme, /galleryFade: \{[^}]*top: "100%",[^}]*experimental_backgroundImage: `linear-gradient\(\$\{c\.paper\}, \$\{c\.paper\}00\)`/);
});

test("On this day cards are one grid row high at 4:3, at every level and width", () => {
  for (const [width, columns] of [[344, levelColumns("base", 4)], [344, levelColumns("compact", 4)], [700, levelColumns("base", 6)]]) {
    const layout = galleryLayout([{ month: "2026-09", count: 12 }], width, columns);
    const card = memoryCard(layout, 3);
    assert.equal(card.height, layout.tile, `${columns} columns: the card is as tall as a grid row`);
    assert.equal(card.width, Math.round((layout.tile * 4) / 3));
  }
  assert.notEqual(memoryCard(galleryLayout([], 344, 4), 3).height, memoryCard(galleryLayout([], 344, 10), 3).height, "pinching resizes the cards");
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(gallery, /memoryCard\(layout, PixelRatio\.get\(\)\), \[layout\.tile\]/);
  assert.match(gallery, /\[s\.memoryCard, \{ width: card\.width, height: card\.height \}, pressed && s\.pressedFade\]/);
  assert.match(gallery, /<Text numberOfLines=\{1\} style=\{s\.memoryTitle\}>\{text\.title\}<\/Text>\s+<Text numberOfLines=\{1\} style=\{s\.memoryCaption\}>\{text\.caption\}<\/Text>/);
  assert.match(gallery, /contentContainerStyle=\{s\.memoryRow\}/);
});

test("an On this day photo is rendered at its drawn size times the pixel ratio", () => {
  const phone = galleryLayout([], 380, 4);
  assert.equal(memoryCard(phone, 2).size, "thumb", "a 2x phone card fits the 360 px thumbnail");
  assert.equal(memoryCard(phone, 3.5).size, "medium", "a denser screen needs the 720 px medium preview, not the large one");
  const fold = galleryLayout([], 1000, 6);
  assert.equal(Math.ceil(memoryCard(fold, 2.6).width * 2.6), 565);
  assert.equal(memoryCard(fold, 2.6).size, "medium", "a Fold card between 360 and 720 device px uses the medium preview");
  const wide = galleryLayout([], 1000, 4);
  assert.ok(Math.ceil(memoryCard(wide, 2.6).width * 2.6) > 720);
  assert.equal(memoryCard(wide, 2.6).size, "large", "only a card beyond 720 device px asks for the large preview");
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(gallery, /card\.size !== "thumb" && item\.kind !== "video"\s+\? await displayRef\.current\(\s*item,\s*card\.size,\s*true,\s*hubCardSize\(card, mediaAspect\(item\)\),\s*\)\s+: await io\.render\(item\)/);
  assert.match(gallery, /\}, \[memories, card\.size, card\.width, !card\.height, io, entryByPath\]\);/);
  assert.match(gallery, /: withHub\(renderLocal, hubSize\)\(item, size, fallback\);/, "the local render keeps the card's size while the hub fallback uses its own");
  assert.match(gallery, /timelineItem\(memory, entryByPath\.get\(memory\.path\)\)/);
});

test("On this day cards use the desktop toast colours for their shade and text", async () => {
  const { palettes } = await import("../apps/mobile/src/palette.js");
  const tokens = read("../apps/desktop/src/tokens.css");
  for (const theme of ["light", "dark"]) {
    assert.equal(palettes[theme].toastBg, tokens.match(/--toast-bg:\s*(#[\da-f]{6})/)[1]);
    assert.equal(palettes[theme].toastFg, tokens.match(/--toast-fg:\s*(#[\da-f]{6})/)[1]);
  }
  const theme = read("../apps/mobile/src/theme.js");
  assert.match(theme, /memoryShade: \{[^}]*experimental_backgroundImage: `linear-gradient\(\$\{c\.toastBg\}00 30%, \$\{c\.toastBg\}\)`/);
  assert.match(theme, /memoryTitle: \{[^}]*color: c\.toastFg,/);
});

test("On this day titles the date as the desktop does, month first, and says how long ago", () => {
  assert.deepEqual(memoryText({ year: "2025", count: 21 }, "10-10", 2026), { title: "October 10, 2025", caption: "1 year ago · 21 photos" });
  assert.deepEqual(memoryText({ year: "2022", count: 1 }, "03-05", 2026), { title: "March 5, 2022", caption: "4 years ago · 1 photo" });
  const desktop = fs.readFileSync(new URL("../apps/desktop/src/app.js", import.meta.url), "utf8");
  assert.match(desktop, /toLocaleDateString\("en", \{ day: "numeric", month: "long", year: "numeric" \}\)/, "both clients use the same English long date");
  for (const page of ["../design/desktop.html", "../design/mobile.html"])
    assert.doesNotMatch(read(page), />\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}</, `${page} draws the shipped wording`);
  assert.match(read("../design/mobile.html"), /<span>October 10, 2025<\/span>/);
  assert.match(read("../design/desktop.html"), /memory-title">September 12, 2025</);
});

test("zoom is the pinch alone: the Fold has no level control, and the pill and actions name the base level Photos", () => {
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.doesNotMatch(gallery, /SegmentedControl/);
  assert.match(gallery, /\{ base: "Photos", compact: "Months", years: "Years" \}\[level\]/);
  assert.match(gallery, /name: "photos", label: "Show photos"/);
  assert.match(gallery, /\{ photos: "base", months: "compact", years: "years" \}\[event\.nativeEvent\.actionName\]/);
  assert.doesNotMatch(gallery, /"Days"|Show days/);
  assert.match(gallery, /\/v1\/gallery\/memories\?/);
  assert.match(gallery, /slice\(0, 3\)/);
  assert.match(gallery, /toValue: 0,\s+delay: duration\(1000\)/);
});

test("an On this day card falls back to the hub's large preview when the 720 px long-side medium would upscale its crop", () => {
  const card = (width) => ({ size: "medium", pixels: { width, height: Math.ceil((width * 3) / 4) } });
  assert.equal(hubCardSize(card(700), 4 / 3), "medium", "a 4:3 landscape at 720 x 540 covers a 700 px card");
  assert.equal(hubCardSize(card(720), 4 / 3), "medium");
  assert.equal(hubCardSize(card(700), 3 / 4), "large", "a portrait 540 x 720 would upscale on a 700 px card");
  assert.equal(hubCardSize(card(540), 3 / 4), "medium", "but covers a 540 px card");
  assert.equal(hubCardSize(card(500), 3), "large", "a panorama is only 240 px tall at 720 px wide");
  assert.equal(hubCardSize(card(300), 3), "medium");
  assert.equal(hubCardSize(card(540), null), "medium", "an unknown aspect trusts the medium up to 540 device px");
  assert.equal(hubCardSize(card(541), null), "large", "and asks for large above it");
  assert.equal(hubCardSize({ size: "thumb", pixels: { width: 300, height: 225 } }, null), "thumb");
  assert.equal(hubCardSize({ size: "large", pixels: { width: 900, height: 675 } }, 1), "large");
  assert.equal(mediaAspect({ width: 4032, height: 3024 }), 4 / 3);
  assert.equal(mediaAspect({ width: 0, height: 3024 }), null);
  assert.equal(mediaAspect({}), null);
  const fold = memoryCard(galleryLayout([], 1000, 6), 2.6);
  assert.deepEqual(fold.pixels, { width: 565, height: Math.ceil(fold.height * 2.6) });
  assert.equal(hubCardSize(fold, null), "large", "a Fold card of unknown aspect asks the hub for large");
});

test("a wall tile beyond 360 device px asks for the medium preview and never the large one", () => {
  const phone = galleryLayout([], 380, 4);
  assert.equal(wallCard(phone, 2).size, "thumb", "a 2x phone tile fits the 360 px thumbnail");
  const fold = galleryLayout([], 1000, 6);
  assert.ok(Math.ceil(fold.tile * 2.6) > 360);
  assert.equal(wallCard(fold, 2.6).size, "medium", "a Fold column wider than 360 device px uses the medium preview");
  const wide = galleryLayout([], 1000, 2);
  assert.ok(Math.ceil(wide.tile * 2.6) > 720);
  assert.equal(wallCard(wide, 2.6).size, "medium", "a huge tile still stops at the medium preview");
  assert.equal(wallCard(fold, 2.6).pixels.width, Math.ceil(fold.tile * 2.6));
});

test("sharpening tiles waits for idle, renders one at a time, skips what it cannot sharpen and stops when scrolled away", async () => {
  assert.ok(SHARP_IDLE_MS >= 250, "scrolling restarts the wait");
  const items = [
    { key: "a", kind: "image" },
    { key: "v", kind: "video" },
    { key: "u", kind: "image", upload: "pending" },
    { key: "k", kind: "image" },
    { key: "bad", kind: "image" },
    ...Array.from({ length: SHARP_BATCH + 2 }, (_, i) => ({ key: `p${i}`, kind: "image" })),
  ];
  let running = 0;
  let peak = 0;
  const rendered = [];
  const batches = [];
  await sharpenTiles({
    items,
    known: { k: "file:///known.jpg" },
    active: () => true,
    render: async (item) => {
      peak = Math.max(peak, ++running);
      await Promise.resolve();
      running--;
      rendered.push(item.key);
      if (item.key === "bad") throw new Error("decode failed");
      return `file:///${item.key}.jpg`;
    },
    done: (found) => batches.push(Object.keys(found)),
  });
  assert.equal(peak, 1, "one render at a time keeps scrolling smooth");
  assert.deepEqual(rendered.filter((key) => ["v", "u", "k"].includes(key)), [], "videos, uploads and tiles already sharp are skipped");
  assert.ok(rendered.includes("bad") && batches.flat().includes("p0"), "a failed render never stops the others");
  assert.ok(!batches.flat().includes("bad"));
  assert.equal(batches[0].length, SHARP_BATCH, "tiles are published in batches, not one repaint each");
  assert.equal(batches.flat().length, rendered.length - 1);

  let live = true;
  const seen = [];
  await sharpenTiles({
    items: [{ key: "x", kind: "image" }, { key: "y", kind: "image" }],
    active: () => live,
    render: async (item) => {
      live = false;
      seen.push(item.key);
      return "file:///x.jpg";
    },
    done: () => assert.fail("nothing is published after the view moved on"),
  });
  assert.deepEqual(seen, ["x"]);
});

test("a tile that failed to sharpen is not retried on every idle, and the sharp map stays bounded", async () => {
  const failed = new Set();
  const calls = [];
  const run = () =>
    sharpenTiles({
      items: [{ key: "bad", kind: "image" }, { key: "none", kind: "image" }, { key: "ok", kind: "image" }],
      failed,
      active: () => true,
      render: async (item) => {
        calls.push(item.key);
        if (item.key === "bad") throw new Error("undecodable");
        return item.key === "none" ? null : "file:///ok.jpg";
      },
      done: () => {},
    });
  await run();
  await run();
  assert.deepEqual(calls, ["bad", "none", "ok", "ok"], "a failure or an empty answer is remembered; a success is only skipped through `known`");
  assert.deepEqual([...failed].sort(), ["bad", "none"]);
  const big = Object.fromEntries(Array.from({ length: SHARP_KEEP + 25 }, (_, i) => [`k${i}`, `file:///${i}.jpg`]));
  const kept = keepRecent(big);
  assert.equal(Object.keys(kept).length, SHARP_KEEP);
  assert.ok(!("k0" in kept) && `k${SHARP_KEEP + 24}` in kept, "the oldest entries go first");
  assert.equal(keepRecent({ a: "x" }).a, "x");
});

test("a tile never lists the same image twice, so a failed thumbnail reaches the placeholder", () => {
  assert.deepEqual(tileSources("file:///t.jpg", "file:///t.jpg"), ["file:///t.jpg"]);
  assert.deepEqual(tileSources("file:///sharp.jpg", "file:///t.jpg"), ["file:///sharp.jpg", "file:///t.jpg"]);
  assert.deepEqual(tileSources(null, "file:///t.jpg"), ["file:///t.jpg"]);
  assert.deepEqual(tileSources(undefined, null), []);
});

test("the wall keeps the 360 px thumbnail as first paint and swaps in the sharp tile, never asking the hub for the large preview", () => {
  const gallery = read("../apps/mobile/src/FolderGallery.jsx");
  assert.match(gallery, /wallCard\(layout, PixelRatio\.get\(\)\), \[layout\.tile\]/);
  assert.match(gallery, /if \(wall\.size === "thumb" \|\| density === "years" \|\| !layout\.tile\) return;/);
  assert.match(gallery, /displayRef\.current\(item, wall\.size, true, wall\.size\)/);
  assert.doesNotMatch(gallery, /hubCardSize\(wall/, "the wall never takes the memory-card route to the large preview");
  assert.match(gallery, /uri=\{sharp\[sharpKey\(item\)\] \|\| thumb\(item\)\}\s+fallback=\{thumb\(item\)\}/);
  assert.match(gallery, /const sources = tileSources\(uri, fallback\);/);
  assert.match(gallery, /const source = sources\[failed\.key === sourceKey \? failed\.count : 0\];/);
  assert.match(gallery, /failed: sharpFailed\.current,/);
  assert.match(gallery, /\}, \[scope, volume, wall\.size\]\);/);
  assert.match(gallery, /sharpFailed\.current = new Set\(\);\s+\}, \[attempt\]\);/, "a retry forgets the failures but keeps the sharp tiles on screen");
  assert.match(gallery, /known: sharpRef\.current,/);
  assert.match(gallery, /\}, \[visibleKey, wall\.size, wall\.pixels\.width, density, scope, volume, attempt\]\);/);
});
