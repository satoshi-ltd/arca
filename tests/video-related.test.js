import test from "node:test";
import assert from "node:assert/strict";
import { franchisesOf, relatedTitles } from "../packages/core/video-related.js";

const show = (title, extra = {}) => ({ id: `s:${title}`, kind: "show", title, rating: 8, ...extra });
const movie = (title, extra = {}) => ({ id: `m:${title}`, kind: "movie", title, rating: 7, ...extra });
const titlesOf = (map, item, all) => map.get(item).map((id) => all.find((title) => title.id === id).title);

test("Related lists the same collection, then what TMDB recommends either way, then titles sharing two or more keywords", () => {
  const items = [
    movie("A New Hope", { collection: "Star Wars" }),
    movie("Revenge of the Sith", { collection: "Star Wars", rating: 6 }),
    show("Obi-Wan Kenobi"),
    show("Andor"),
    show("The Mandalorian"),
    movie("Interstellar"),
    movie("Aquaman"),
    movie("Justice League"),
    show("Lost"),
    movie("Notting Hill"),
  ];
  const SPACE = 1;
  const HOPEFUL = 2;
  const SUPERHERO = 3;
  const COMICS = 4;
  const signals = new Map([
    [items[2], { key: "tv:92830", keywords: [SPACE, HOPEFUL], recommended: ["tv:83867"] }],
    [items[3], { key: "tv:83867", keywords: [SPACE], recommended: [] }],
    [items[4], { key: "tv:82856", keywords: [], recommended: ["tv:92830"] }],
    [items[5], { key: "movie:157336", keywords: [SPACE, HOPEFUL], recommended: [] }],
    [items[6], { key: "movie:297802", keywords: [SUPERHERO, COMICS], recommended: [] }],
    [items[7], { key: "movie:791373", keywords: [SUPERHERO, COMICS, SPACE], recommended: [] }],
    [items[8], { key: "tv:4607", keywords: [SPACE, 9], recommended: [] }],
  ]);
  const map = relatedTitles(items, signals);
  assert.deepEqual(titlesOf(map, items[0], items), ["Revenge of the Sith"]);
  assert.deepEqual(titlesOf(map, items[2], items), ["Andor", "The Mandalorian", "Interstellar"], "recommendations in either direction come before keywords");
  assert.deepEqual(titlesOf(map, items[6], items), ["Justice League"]);
  assert.deepEqual(titlesOf(map, items[8], items), [], "one shared keyword is not enough");
  assert.deepEqual(titlesOf(map, items[9], items), [], "a title without signals or collection has no Related");
});

test("kids titles relate only to kids titles, and the list stops at the limit", () => {
  const items = [movie("Toy Story", { kids: true }), movie("Toy Story 2", { kids: true }), movie("Heat")];
  const map = relatedTitles(items, new Map(items.map((item) => [item, { keywords: [5, 6] }])));
  assert.deepEqual(titlesOf(map, items[0], items), ["Toy Story 2"]);
  assert.deepEqual(titlesOf(map, items[2], items), []);
  const many = Array.from({ length: 20 }, (_, index) => movie(`M${index}`));
  assert.equal(relatedTitles(many, new Map(many.map((item) => [item, { keywords: [1, 2] }]))).get(many[0]).length, 12);
});

test("Related scales with the library: three thousand titles with forty keywords and recommendations each finish in seconds", () => {
  const titles = Array.from({ length: 3000 }, (_, i) => movie(`T${i}`));
  const signals = new Map(
    titles.map((title, i) => [
      title,
      {
        key: `movie:${i}`,
        keywords: Array.from({ length: 40 }, (_, k) => (i * 7 + k * 13) % 2000),
        recommended: Array.from({ length: 40 }, (_, k) => `movie:${(i + k * 31) % 3000}`),
      },
    ]),
  );
  const started = Date.now();
  const map = relatedTitles(titles, signals);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.equal(map.get(titles[0]).length, 12);
});

test("two files of the same TMDB title both keep what TMDB recommends", () => {
  const items = [movie("Blade Runner"), movie("Blade Runner (Final Cut)"), movie("Arrival")];
  const signals = new Map([
    [items[0], { key: "movie:78", keywords: [], recommended: [] }],
    [items[1], { key: "movie:78", keywords: [], recommended: [] }],
    [items[2], { key: "movie:329865", keywords: [], recommended: ["movie:78"] }],
  ]);
  const map = relatedTitles(items, signals);
  assert.deepEqual(titlesOf(map, items[2], items).sort(), ["Blade Runner", "Blade Runner (Final Cut)"]);
  assert.ok(titlesOf(map, items[0], items).includes("Arrival"));
  assert.ok(titlesOf(map, items[1], items).includes("Arrival"));
});

test("titles of one franchise relate through the name before the colon or an \"A … Story\" title, after the collection", () => {
  assert.deepEqual(franchisesOf("Rogue One: A Star Wars Story"), ["rogue one", "star wars"]);
  assert.deepEqual(franchisesOf("Up"), [], "a name under three letters never forms a franchise");
  assert.deepEqual(franchisesOf("A Ghost Story"), ["a ghost story"], "a one-word \"A … Story\" name is not a franchise");
  const copies = [movie("Arrival"), movie("Arrival 4K", { title: "Arrival" }), movie("Sicario")];
  copies[1].id = "m:arrival-4k";
  const copied = relatedTitles(copies, new Map([[copies[0], { key: "movie:329865" }], [copies[1], { key: "movie:329865" }]]));
  assert.deepEqual(copied.get(copies[0]), [], "another copy of the same film is never related");
  const items = [
    show("Star Wars: The Bad Batch"),
    movie("Star Wars", { rating: 8.2 }),
    movie("Solo: A Star Wars Story", { rating: 6.6 }),
    movie("Star Wars: Episode III - Revenge of the Sith", { collection: "Star Wars Collection", rating: 7.4 }),
    movie("Star Wars: Episode I - The Phantom Menace", { collection: "Star Wars Collection", rating: 6.5 }),
    show("LEGO Star Wars: Rebuild the Galaxy"),
    show("LEGO Star Wars: The Freemaker Adventures"),
    movie("Notting Hill"),
  ];
  const related = relatedTitles(items);
  assert.deepEqual(titlesOf(related, items[0], items), ["Star Wars", "Star Wars: Episode III - Revenge of the Sith", "Solo: A Star Wars Story", "Star Wars: Episode I - The Phantom Menace"]);
  assert.deepEqual(titlesOf(related, items[3], items).slice(0, 2), ["Star Wars: Episode I - The Phantom Menace", "Star Wars"], "the collection still comes first");
  assert.deepEqual(titlesOf(related, items[5], items), ["LEGO Star Wars: The Freemaker Adventures"]);
  assert.deepEqual(titlesOf(related, items[7], items), []);
});

