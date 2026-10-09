import test from "node:test";
import assert from "node:assert/strict";
import { buildLibrary, isEpisode } from "../apps/desktop/src/music-library.js";
import { isEpisode as phoneEpisode, episodeFolders } from "../apps/mobile/src/music-library.js";

const real = [
  { path: "Un Podcast Sobre Bitcoin/2026-10-09 Un infiltrado.mp3", duration: 1175 },
  { path: "monos estocásticos/2026-10-01 Claude Opus 5.5.mp3", artist: "Antonio Ortiz, Matías S. Zavia", duration: 4791 },
  { path: "monos estocásticos/2026-10-08 OpenAI resuelve.mp3", duration: 4563 },
  { path: "WORLDCAST/2026-10-08 Cura del Vaticano.mp3", album: "WORLDCAST", genre: "Podcast", duration: 7163 },
  { path: "Tengo un Plan/2026-10-08 Experto en Conversación.mp3", duration: 6427 },
  { path: "Miles Davis/Kind of Blue/01 So What.mp3", artist: "Miles Davis", album: "Kind of Blue", duration: 562 },
].map((item, index) => ({ hash: `h${index}`, title: null, artist: null, albumArtist: null, album: null, genre: null, ...item }));

test("a dated file name without an album, a Podcast genre or long untagged audio is an episode", () => {
  assert.equal(isEpisode(real[0]), true, "a short untagged dated episode");
  assert.equal(isEpisode(real[1]), true, "an episode tagged with its hosts as artist");
  assert.equal(isEpisode(real[5]), false, "music stays music");
  assert.deepEqual(real.map(isEpisode), real.map(phoneEpisode), "desktop and phone agree");
});

test("a dated download tagged with its host and show but no track number is an episode, even alone at the folder root", () => {
  const items = [
    { path: "2026-10-07 Lo que la ola de derecha va a hacer con tu ahorro.mp3", title: "Lo que la ola de derecha va a hacer con tu ahorro", artist: "Alberto Mera", album: "Un Podcast Sobre Bitcoin", duration: 1099 },
    { path: "2026-09-25 Mikel Azcona Al Corte Podcast EP128.mp3", title: "Mikel Azcona", album: "Al Corte", genre: "Podcast", duration: 3840 },
    { path: "Live/2019-05-01 Live at the Roxy.mp3", artist: "Band", album: "Live at the Roxy", track: 3, duration: 300 },
  ].map((item, index) => ({ hash: `d${index}`, track: null, albumArtist: null, genre: null, ...item }));
  assert.deepEqual(items.map(isEpisode), [true, true, false]);
  assert.deepEqual(items.map(phoneEpisode), [true, true, false]);
  const library = buildLibrary({ tracks: items });
  assert.deepEqual(library.shows.map((show) => show.name).sort(), ["Al Corte", "Un Podcast Sobre Bitcoin"]);
  assert.deepEqual(library.albumList.map((album) => album.title), ["Live at the Roxy"]);
  assert.equal(library.artists.some((artist) => artist.name === "Alberto Mera"), false);
});

test("every file in a show folder follows its episodes, and music keeps its albums", () => {
  const library = buildLibrary({ tracks: real });
  assert.deepEqual(library.shows.map((show) => show.name).sort(), ["Tengo un Plan", "Un Podcast Sobre Bitcoin", "WORLDCAST", "monos estocásticos"]);
  assert.deepEqual(library.albumList.map((album) => album.title), ["Kind of Blue"]);
  assert.equal(library.shows.find((show) => show.name === "monos estocásticos").tracks.length, 2);
  assert.ok(episodeFolders(real).has("monos estocásticos"));
  assert.equal(episodeFolders([{ path: "2026-10-01 loose.mp3" }]).size, 0, "a file at the root never turns its neighbours into episodes");
});

test("an episode is titled by its own title tag, never by the show's name, and otherwise by its file name without the date", async () => {
  const { episodeTitle } = await import("../apps/desktop/src/music-library.js");
  const phone = (await import("../apps/mobile/src/music-library.js")).episodeTitle;
  const cases = [
    [{ path: "LO QUE TÚ DIGAS con Alex Fidalgo/2026-10-06 Lleva 15 Años Investigando - 556.mp3", title: "Lleva 15 Años Investigando a los Niños In Vitro: Esto es lo que Encontró - #556" }, "LO QUE TÚ DIGAS con Alex Fidalgo", "Lleva 15 Años Investigando a los Niños In Vitro: Esto es lo que Encontró - #556"],
    [{ path: "monos estocásticos/2026-10-01 Claude Opus 5.5 es fantástico.mp3", title: "monos estocásticos" }, "monos estocásticos", "Claude Opus 5.5 es fantástico"],
    [{ path: "The Diary Of A CEO with Steven Bartlett/2026-10-05 Dana White This Generation.mp3", title: null }, "The Diary Of A CEO with Steven Bartlett", "Dana White This Generation"],
  ];
  for (const [item, show, expected] of cases) {
    assert.equal(episodeTitle(item, show), expected);
    assert.equal(phone(item, show), expected);
  }
});
