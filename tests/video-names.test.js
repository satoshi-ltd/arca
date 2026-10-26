import test from "node:test";
import assert from "node:assert/strict";
import { collectionName, languageOf, normalizeTitle, numberRepeats, parseVideoPath, subtitleType, trackTitle, videoType } from "../packages/core/video-names.js";

const movie = (title, year = null, tmdb = null) => ({ kind: "movie", title, year, tmdb });
const episode = (show, season, number, episodeTitle = null, year = null) => ({ kind: "episode", show, season, episode: number, episodeTitle, year });
const other = (title) => ({ kind: "other", title });

const CORPUS = [
  ["Inception (2010).mkv", movie("Inception", 2010)],
  ["Inception (2010)/Inception (2010).mkv", movie("Inception", 2010)],
  ["Inception.2010.1080p.BluRay.x264-SPARKS.mkv", movie("Inception", 2010)],
  ["Inception 2010 720p WEB-DL AAC2.0 H.264-NTb.mp4", movie("Inception", 2010)],
  ["The.Dark.Knight.2008.REMASTERED.1080p.BluRay.x265.10bit.HDR.DTS-HD.MA.5.1-SWTYBLZ.mkv", movie("The Dark Knight", 2008)],
  ["Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-EPSiLON.mkv", movie("Blade Runner 2049", 2017)],
  ["2001.A.Space.Odyssey.1968.1080p.BluRay.x264.mkv", movie("2001 A Space Odyssey", 1968)],
  ["1917 (2019).mp4", movie("1917", 2019)],
  ["2012.2009.720p.BRRip.XviD.AC3-FLAWL3SS.avi", movie("2012", 2009)],
  ["Spider-Man.Homecoming.2017.1080p.WEB-DL.DD5.1.H264-FGT.mkv", movie("Spider-Man Homecoming", 2017)],
  ["The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.EXTENDED.1080p.BluRay.x264.DTS-HD.MA.6.1-FGT.mkv", movie("The Lord of the Rings The Fellowship of the Ring", 2001)],
  ["Charlottes.Web.2006.1080p.WEBRip.x264.mkv", movie("Charlottes Web", 2006)],
  ["Mad_Max_Fury_Road_2015_1080p_BluRay.mkv", movie("Mad Max Fury Road", 2015)],
  ["Movies/The Matrix (1999) {tmdb-603}/The Matrix (1999).mkv", movie("The Matrix", 1999, { type: "movie", id: 603 })],
  ["The Matrix (1999) [tmdbid-603].mkv", movie("The Matrix", 1999, { type: "movie", id: 603 })],
  ["Amélie (2001)/movie.mkv", movie("Amélie", 2001)],
  ["El laberinto del fauno (2006)/el.laberinto.del.fauno.1080p.mkv", movie("El laberinto del fauno", 2006)],
  ["[YTS.MX] Parasite (2019) [1080p] [BluRay] [5.1].mp4", movie("Parasite", 2019)],
  ["www.example.com - Toy Story 4 (2019) 1080p.mkv", movie("Toy Story 4", 2019)],
  ["Películas/Torrente.avi", movie("Torrente")],
  ["Up.2009.mov", movie("Up", 2009)],
  ["Alien.Director's.Cut.1979.1080p.mkv", movie("Alien Director's Cut", 1979)],
  ["Movies/Jaws.mkv", movie("Jaws")],
  ["Her.2013.MULTi.1080p.mkv", movie("Her", 2013)],
  ["Coco (2017) [1080p].webm", movie("Coco", 2017)],
  ["Toy Story (1995) Remastered.m4v", movie("Toy Story", 1995)],
  ["Gladiator.2000.Extended.Remastered.1080p.mkv", movie("Gladiator", 2000)],
  ["Breaking Bad/Season 1/Breaking.Bad.S01E02.Cats.in.the.Bag.720p.HDTV.x264.mkv", episode("Breaking Bad", 1, 2, "Cats in the Bag")],
  ["Breaking Bad/Season 1/02 - Cats in the Bag.mkv", episode("Breaking Bad", 1, 2, "Cats in the Bag")],
  ["Breaking Bad/Season 01/Episode 3.mkv", episode("Breaking Bad", 1, 3, null)],
  ["Breaking Bad/S01/E04 - Cancer Man.mkv", episode("Breaking Bad", 1, 4, "Cancer Man")],
  ["Breaking.Bad.S01.1080p.BluRay/Breaking.Bad.S01E03.1080p.mkv", episode("Breaking Bad", 1, 3, null)],
  ["Breaking.Bad.S05E14.Ozymandias.1080p.WEB-DL.mkv", episode("Breaking Bad", 5, 14, "Ozymandias")],
  ["breaking.bad.s1e5.mkv", episode("breaking bad", 1, 5, null)],
  ["The Office (US)/Temporada 2/2x05 - Halloween.avi", episode("The Office US", 2, 5, "Halloween")],
  ["Doctor Who (2005)/Specials/Doctor.Who.2005.S00E01.The.Christmas.Invasion.mkv", episode("Doctor Who", 0, 1, "The Christmas Invasion", 2005)],
  ["Doctor Who (2005)/Season 0/01 Children in Need.mkv", episode("Doctor Who", 0, 1, "Children in Need", 2005)],
  ["Friends/Friends.S01E01E02.The.One.Where.It.All.Began.mkv", episode("Friends", 1, 1, "The One Where It All Began")],
  ["Friends.S03E25-E26.mkv", episode("Friends", 3, 25, null)],
  ["Series/The Expanse/S02/The.Expanse.S02E05.1080p.mkv", episode("The Expanse", 2, 5, null)],
  ["TV Shows/Dark/Season 3/Dark - S03E08 - The Paradise.mkv", episode("Dark", 3, 8, "The Paradise")],
  ["Kids/Peppa Pig/Season 1/01 Muddy Puddles.mp4", episode("Peppa Pig", 1, 1, "Muddy Puddles")],
  ["Bluey/Temporada 2/Bluey - 2x01 - Dance Mode.mp4", episode("Bluey", 2, 1, "Dance Mode")],
  ["La Casa de Papel/Temporada 1/Capitulo 3.mkv", episode("La Casa de Papel", 1, 3, null)],
  ["Severance {tmdb-95396}/Season 1/Severance.S01E01.mkv", { ...episode("Severance", 1, 1, null), tmdb: { type: "tv", id: 95396 } }],
  ["Shogun.2024.S01E01.Anjin.2160p.DSNP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv", episode("Shogun", 1, 1, "Anjin", 2024)],
  ["Game of Thrones/Season 8/Game.of.Thrones.S08E03.The.Long.Night.1080p.AMZN.WEB-DL.mkv", episode("Game of Thrones", 8, 3, "The Long Night")],
  ["Lost/Season 1/Lost - 1x01 - Pilot (1).avi", episode("Lost", 1, 1, "Pilot 1")],
  ["Lost.S01E01.Pilot.Part.1.mkv", episode("Lost", 1, 1, "Pilot Part 1")],
  ["The Simpsons/Season 10/The Simpsons - Season 10 Episode 2.mkv", episode("The Simpsons", 10, 2, null)],
  ["VID_20230512_181512.mp4", other("VID 20230512 181512")],
  ["IMG_1234.MOV", other("IMG 1234")],
  ["PXL_20240101_120000000.mp4", other("PXL 20240101 120000000")],
  ["MVI_0042.AVI", other("MVI 0042")],
  ["DJI_0001.MP4", other("DJI 0001")],
  ["GOPR0123.MP4", other("GOPR0123")],
  ["20230512_181512.mp4", other("20230512 181512")],
  ["2023-05-12 Beach.mov", other("2023-05-12 Beach")],
  ["Home videos/Birthday.mp4", other("Birthday")],
  ["Home Videos/2019/Christmas morning (2019).mp4", other("Christmas morning (2019)")],
  ["Other/Interview.mp4", other("Interview")],
  ["Inception (2010)/Extras/Making of.mkv", other("Making of")],
  ["Inception (2010)/Inception.2010.sample.mkv", other("Inception.2010.sample")],
  ["random clip.mp4", other("random clip")],
  ["Screen Recording 2024-03-01 at 10.00.00.mov", other("Screen Recording 2024-03-01 at 10.00.00")],
  ["WhatsApp Video 2023-07-04 at 21.10.33.mp4", other("WhatsApp Video 2023-07-04 at 21.10.33")],
];

test("real-world file names parse into movies, episodes and other videos", () => {
  const failures = [];
  for (const [name, expected] of CORPUS) {
    const parsed = parseVideoPath(name);
    const got = Object.fromEntries(Object.keys(expected).map((key) => [key, parsed[key]]));
    try {
      assert.deepEqual(got, expected);
    } catch {
      failures.push(`${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(CORPUS.length >= 60);
});

test("an episode without a name is titled by its number, and every result has the full shape", () => {
  const parsed = parseVideoPath("Breaking Bad/Season 2/Breaking.Bad.S02E07.720p.mkv");
  assert.deepEqual(parsed, {
    kind: "episode",
    title: "Episode 7",
    year: null,
    show: "Breaking Bad",
    season: 2,
    episode: 7,
    episodeTitle: null,
    tmdb: null,
  });
  assert.deepEqual(Object.keys(parseVideoPath("Inception (2010).mkv")).sort(), ["episode", "episodeTitle", "kind", "season", "show", "title", "tmdb", "year"]);
  assert.equal(parseVideoPath("").kind, "other");
});

test("video and subtitle types follow the extension only", () => {
  assert.equal(videoType("a/b.MKV"), "video/x-matroska");
  assert.equal(videoType("b.mp4"), "video/mp4");
  assert.equal(videoType("b.m4v"), "video/mp4");
  assert.equal(videoType("b.mov"), "video/quicktime");
  assert.equal(videoType("b.webm"), "video/webm");
  assert.equal(videoType("b.avi"), "video/x-msvideo");
  assert.equal(videoType("b.mp3"), null);
  assert.equal(videoType("mkv"), null);
  assert.equal(subtitleType("a.es.SRT"), "srt");
  assert.equal(subtitleType("a.vtt"), "vtt");
  assert.equal(subtitleType("a.ass"), null);
});

test("subtitle languages come from codes, names and flags after the video name", () => {
  const cases = [
    ["Movie (2010).es.srt", { language: "es", label: "Spanish" }],
    ["Movie (2010).spa.srt", { language: "es", label: "Spanish" }],
    ["Movie (2010).Spanish.srt", { language: "es", label: "Spanish" }],
    ["Movie (2010).en.forced.srt", { language: "en", label: "English (forced)" }],
    ["Movie (2010).eng.sdh.srt", { language: "en", label: "English (SDH)" }],
    ["Movie (2010).en.forced.sdh.srt", { language: "en", label: "English (forced, SDH)" }],
    ["Movie (2010).es-419.srt", { language: "es-419", label: "Spanish (Latin America)" }],
    ["Movie (2010).latino.srt", { language: "es-419", label: "Spanish (Latin America)" }],
    ["Movie (2010).pt-BR.srt", { language: "pt-BR", label: "Portuguese (Brazil)" }],
    ["Movie (2010).pt.srt", { language: "pt", label: "Portuguese" }],
    ["Movie (2010).fre.vtt", { language: "fr", label: "French" }],
    ["Movie (2010).Deutsch.srt", { language: "de", label: "German" }],
    ["Movie (2010).cat.srt", { language: "ca", label: "Catalan" }],
    ["Movie (2010).srt", { language: null, label: "Subtitles" }],
    ["Subs/2_English.srt", { language: "en", label: "English" }],
    ["Subs/Castellano.srt", { language: "es", label: "Spanish" }],
  ];
  for (const [subtitle, expected] of cases) assert.deepEqual(languageOf(subtitle, "Movie (2010)/Movie (2010).mkv"), expected, subtitle);
  assert.deepEqual(languageOf("Show/S01/Show.S01E01.it.srt", "Show/S01/Show.S01E01.mkv"), { language: "it", label: "Italian" });
});

test("titles normalize for search keys across accents, case and punctuation", () => {
  assert.equal(normalizeTitle("Amélie"), "amelie");
  assert.equal(normalizeTitle("Spider-Man: Homecoming"), "spider man homecoming");
  assert.equal(normalizeTitle("Charlotte's Web"), "charlottes web");
  assert.equal(normalizeTitle("Fast & Furious"), "fast and furious");
});

test("collection names drop the word Collection in any of TMDB's languages", () => {
  assert.equal(collectionName("The Amazing Spider-Man Collection"), "The Amazing Spider-Man");
  assert.equal(collectionName("Spider-Man (MCU) Collection"), "Spider-Man (MCU)");
  assert.equal(collectionName("Spider-Man: Spider-Verse - Colección"), "Spider-Man: Spider-Verse");
  assert.equal(collectionName("Harry Potter Filmreihe"), "Harry Potter");
  assert.equal(collectionName("Jeunet"), "Jeunet");
  assert.equal(collectionName("Collection"), null);
  assert.equal(collectionName(""), null);
  assert.equal(collectionName(null), null);
});

test("a track title that is a release or file name is dropped, so the label stays the language", () => {
  assert.equal(trackTitle("GalaxyRG - Aquaman.and.the.Lost.Kingdom.2023.1080p.WEBRip.1400MB.DD5.1.x264-GalaxyRG"), "");
  assert.equal(trackTitle("Movie.Name.2019.srt"), "");
  assert.equal(trackTitle("YTS.MX"), "");
  assert.equal(trackTitle("x".repeat(60)), "");
  assert.equal(trackTitle(" SDH "), "SDH");
  assert.equal(trackTitle("Latin American"), "Latin American");
  assert.equal(trackTitle("Commentary by the director"), "Commentary by the director");
  for (const codec of ["DTS-HD MA 5.1", "TrueHD Atmos", "AAC 2.0", "DD+ 7.1"]) assert.equal(trackTitle(codec), "", codec);
  assert.equal(trackTitle("Director's commentary 2.0"), "Director's commentary", "codec and channel tokens go, the meaning stays");
  assert.equal(trackTitle("Español Latino AC3 5.1"), "Español Latino");
  assert.equal(trackTitle("Commentary (AC3 2.0)"), "Commentary");
  assert.equal(trackTitle("English DD+ 7.1"), "English");
  assert.equal(trackTitle(null), "");
});

test("repeated track labels are numbered from the second one, in order", () => {
  const out = numberRepeats([{ label: "English" }, { label: "Spanish" }, { label: "English" }, { label: "English" }]);
  assert.deepEqual(out.map((entry) => entry.label), ["English", "Spanish", "English · 2", "English · 3"]);
  assert.deepEqual(numberRepeats([{ label: "English" }, { label: "English · SDH" }]).map((entry) => entry.label), ["English", "English · SDH"]);
});

test("a titled file without a year inside a kids folder is a movie, while episodes and camera clips there keep their kind", () => {
  assert.equal(parseVideoPath("kids/My Neighbor Totoro.mp4").kind, "movie");
  assert.equal(parseVideoPath("Niños/Mi vecino Totoro.mkv").kind, "movie");
  assert.equal(parseVideoPath("Kids/Peppa Pig/Season 1/01 Muddy Puddles.mp4").kind, "episode");
  assert.equal(parseVideoPath("Kids/Bluey S01E01.mp4").kind, "episode");
  assert.equal(parseVideoPath("kids/VID_20230512_181512.mp4").kind, "other");
  assert.notEqual(parseVideoPath("Kids/Peppa Pig/Muddy Puddles.mp4").kind, "movie", "only a file directly inside the kids folder");
  assert.notEqual(parseVideoPath("Kids/Bluey/03.mp4").kind, "movie");
});

test("the show is the folder nearest the episodes, so an umbrella folder never names every show inside it", () => {
  const ep = parseVideoPath("shows/LEGO Star Wars/LEGO Star Wars Rebuild The Galaxy (2024)/LEGO.Star.Wars.Rebuild.the.Galaxy.S01E01.1080p.WEB.h264-DOLORES.mkv");
  assert.deepEqual([ep.kind, ep.show, ep.year, ep.season, ep.episode], ["episode", "LEGO Star Wars Rebuild The Galaxy", 2024, 1, 1]);
  const andor = parseVideoPath("Star Wars/Andor (2022)/Season 2/Andor.S02E03.mkv");
  assert.deepEqual([andor.show, andor.year, andor.season], ["Andor", 2022, 2]);
  const plain = parseVideoPath("TV/Breaking Bad/Season 1/Breaking.Bad.S01E01.mkv");
  assert.equal(plain.show, "Breaking Bad");
  assert.equal(parseVideoPath("Friends/Season 1/Disc 2/Friends.S01E09.mkv").show, "Friends", "disc folders are not shows");
  assert.equal(parseVideoPath("The Office/Season 2/The.Office.S02E01.720p.WEB-GROUP/The.Office.S02E01.mkv").show, "The Office");
});

test("disc folders never name a movie and a bare episode marker is never a movie", () => {
  for (const path of ["Films/Avatar (2009)/CD1/movie.avi", "Films/Avatar (2009)/CD1/avatar.avi", "Films/Avatar (2009)/Disc 2/part.mkv"]) {
    const parsed = parseVideoPath(path);
    assert.deepEqual([parsed.kind, parsed.title, parsed.year], ["movie", "Avatar", 2009], path);
  }
  assert.equal(parseVideoPath("Kids/S01E01.mkv").kind, "other");
  assert.equal(parseVideoPath("Kids/Totoro.mkv").kind, "movie");
});

test("a kids movie may sit in a folder of its own name inside Kids, while a show there stays a show", () => {
  for (const path of ["Kids/Frozen/Frozen.mkv", "Kids/Frozen/Frozen.1080p.mkv", "Niños/Frozen/CD1/Frozen.avi"]) {
    const parsed = parseVideoPath(path);
    assert.deepEqual([parsed.kind, parsed.title], ["movie", "Frozen"], path);
  }
  assert.equal(parseVideoPath("Kids/Bluey/Season 1/Bluey S01E01.mkv").kind, "episode");
  assert.notEqual(parseVideoPath("Kids/Disney/Frozen.mkv").kind, "movie", "a file named unlike its folder may be an episode, so it needs a year");
  assert.notEqual(parseVideoPath("Kids/Disney/Frozen/Frozen.mkv").kind, "movie", "two folders down needs a year");
});

test("a season pack folder marked COMPLETE names the show without that word, and a title that says Complete is untouched", () => {
  const episode = parseVideoPath("Chernobyl.COMPLETE.Season.1.S01.1080p.AMZN.WEB-DL.x265-HETeam/Chernobyl.S01E02.Please.Remain.Calm.1080p.AMZN.WEB-DL.x265-HETeam.mkv");
  assert.deepEqual([episode.kind, episode.show, episode.season, episode.episode], ["episode", "Chernobyl", 1, 2]);
  assert.equal(parseVideoPath("Show.COMPLETED.S02.720p.WEBRip/Show.S02E01.mkv").show, "Show");
  const movie = parseVideoPath("A Complete Unknown (2024).mkv");
  assert.deepEqual([movie.kind, movie.title, movie.year], ["movie", "A Complete Unknown", 2024]);
});

