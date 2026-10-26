import test from "node:test";
import assert from "node:assert/strict";
import { audioOptions, channelLabel, currentAudio, languageCode, rememberedAudio, sameLanguage } from "../apps/mobile/src/video-audio.js";

const library = [
  { stream: 0, codec: "eac3", language: "eng", label: "English", channels: 6, default: true },
  { stream: 1, codec: "aac", language: "spa", label: "Spanish", channels: 2 },
  { stream: 2, codec: "ac3", language: "eng", label: "Commentary", channels: 2 },
];

test("player audio tracks take the hub's labels and channels, matched by order and language", () => {
  const player = [{ id: "a", language: "en", label: "English" }, { id: "b", language: "es", label: "español" }, { id: "c", language: "en", label: "English" }];
  assert.deepEqual(audioOptions(player, library).map((o) => o.label), ["English · 5.1", "Spanish · 2.0", "Commentary · 2.0"]);
  const shuffled = [{ id: "b", language: "es" }, { id: "a", language: "en" }];
  assert.deepEqual(audioOptions(shuffled, library).map((o) => o.label), ["Spanish · 2.0", "English · 5.1"], "order mismatches fall back to the language");
  assert.deepEqual(audioOptions([{ id: "x", language: "ja", label: "日本語" }], library).map((o) => o.label), ["日本語"], "an unknown track keeps the player's own name");
  assert.deepEqual(audioOptions(undefined, library), [], "an older player without the API offers nothing");
  assert.equal(channelLabel(8), "7.1");
  assert.equal(channelLabel(1), "Mono");
  assert.equal(channelLabel(0), "");
  assert.equal(languageCode("spa"), "es");
  assert.equal(languageCode("en-US"), "en");
  assert.equal(sameLanguage("ger", "de"), true);
  assert.equal(sameLanguage("", ""), false);
});

test("the current track is checked, and the language chosen for a show is picked again on the next episode", () => {
  const player = [{ id: "a", language: "en", label: "English" }, { id: "b", language: "es", label: "Spanish" }];
  const options = audioOptions(player, library);
  assert.equal(currentAudio(options, { id: "b" }), options[1]);
  assert.equal(currentAudio(options, { language: "en", label: "English" }), options[0]);
  assert.equal(currentAudio(options, null), null);
  const next = audioOptions([{ id: "x", language: "eng" }, { id: "y", language: "spa" }], library);
  assert.equal(rememberedAudio(next, "es"), next[1]);
  assert.equal(rememberedAudio(next, "fr"), null);
  assert.equal(rememberedAudio(next, ""), null);
});
