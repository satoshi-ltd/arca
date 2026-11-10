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

test("an episode is titled by its own title tag without a leading show name, never by the show's name alone, and otherwise by its file name without the date", async () => {
  const { episodeTitle } = await import("../apps/desktop/src/music-library.js");
  const phone = (await import("../apps/mobile/src/music-library.js")).episodeTitle;
  const cases = [
    [{ path: "LO QUE TÚ DIGAS con Alex Fidalgo/2026-10-06 Lleva 15 Años Investigando - 556.mp3", title: "Lleva 15 Años Investigando a los Niños In Vitro: Esto es lo que Encontró - #556" }, "LO QUE TÚ DIGAS con Alex Fidalgo", "Lleva 15 Años Investigando a los Niños In Vitro: Esto es lo que Encontró - #556"],
    [{ path: "monos estocásticos/2026-10-01 Claude Opus 5.5 es fantástico.mp3", title: "monos estocásticos" }, "monos estocásticos", "Claude Opus 5.5 es fantástico"],
    [{ path: "The Diary Of A CEO with Steven Bartlett/2026-10-05 Dana White This Generation.mp3", title: null }, "The Diary Of A CEO with Steven Bartlett", "Dana White This Generation"],
    [{ path: "The Wild Project/2026-11-05 390.mp3", title: "The Wild Project #390 - Mònica Bernabé | Una mujer viviendo 8 años" }, "The Wild Project", "#390 - Mònica Bernabé | Una mujer viviendo 8 años"],
    [{ path: "podcasts/twp/2026-10-29 389.mp3", title: "the wild project: Casos Reales de Terror" }, "The Wild Project", "Casos Reales de Terror"],
    [{ path: "Al Corte/2026-10-01 ep.mp3", title: "Al Corte - #12" }, "Al Corte", "#12"],
    [{ path: "Monos/2026-10-01 ep.mp3", title: "Monos estocásticos en directo" }, "Monos", "Monos estocásticos en directo"],
    [{ path: "Al Corte/2026-10-01 ep.mp3", title: "Al Cortez y amigos" }, "Al Corte", "Al Cortez y amigos"],
    [{ path: "Al Corte/2026-10-01 ep.mp3", title: "Al Corte - " }, "Al Corte", "Al Corte -"],
    [{ path: "Pods/Season 1/2026-10-01 ep.mp3", title: "Season 12 - Finale" }, "Pods", "Season 12 - Finale"],
    [{ path: "pods/2026/2026-10-01 ep.mp3", title: "2026-10-01 Episode name" }, "pods", "2026-10-01 Episode name"],
    [{ path: "Ep 1/2026-10-01 ep.mp3", title: "Ep 1, 2 y 3" }, "Ep 1", "Ep 1, 2 y 3"],
    [{ path: "Dr/2026-10-01 ep.mp3", title: "Dr. House" }, "Dr", "Dr. House"],
    [{ path: "Monos/2026-10-01 ep.mp3", title: "Monos, estocásticos y algo más" }, "Monos", "Monos, estocásticos y algo más"],
    [{ path: "Monos/2026-10-01 ep.mp3", title: "Monos 3 claves para entender la IA" }, "Monos", "Monos 3 claves para entender la IA"],
    [{ path: "Inc/2026-10-01 ep.mp3", title: "Inc. stories of the year" }, "Inc", "Inc. stories of the year"],
    [{ path: "The Wild Project/2026-10-01 ep.mp3", title: "The Wild Project 388 - Invitado" }, "The Wild Project", "388 - Invitado"],
    [{ path: "Radio 3/2026-10-01 ep.mp3", title: "Radio 3 - 45 años" }, "Radio 3", "45 años"],
    [{ path: "Mo\u0300nica/2026-10-01 Primera.mp3", title: "M\u00f2nica" }, "Mo\u0300nica", "Primera"],
    [{ path: "AI/2026-10-01 ep.mp3", title: "AI.news - 4" }, "AI news", "AI.news - 4"],
    [{ path: "İİ Show/2026-10-01 ep.mp3", title: "İİ Show - Bölüm 4" }, "İİ Show", "Bölüm 4"],
    [{ path: "Mo\u0300nica/2026-10-01 ep.mp3", title: "M\u00f2nica - 1 de 3" }, "Mo\u0300nica", "1 de 3"],
  ];
  for (const [item, show, expected] of cases) {
    assert.equal(episodeTitle(item, show), expected);
    assert.equal(phone(item, show), expected);
  }
});
