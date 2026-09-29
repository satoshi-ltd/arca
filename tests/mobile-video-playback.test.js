import test from "node:test";
import assert from "node:assert/strict";
import {
  galleryVideoURI,
  startVideoPlayback,
} from "../apps/mobile/src/video-playback.js";

test("Play resolves a downloaded video even when the open viewer still has only a poster", async () => {
  const files = {
    work: (scope, volume, path) => `file:///${scope}/${volume}/${path}`,
    exists: async () => true,
  };
  assert.equal(
    await galleryVideoURI(
      { path: "clip.mp4", uri: null, poster: "file:///thumb.jpg" },
      { files, scope: "hub", volume: "photos" },
    ),
    "file:///hub/photos/clip.mp4",
  );
  assert.equal(
    await galleryVideoURI(
      { path: "clip.mp4", uri: "content://photos/7" },
      { files, scope: "hub", volume: "photos" },
    ),
    "file:///hub/photos/clip.mp4",
  );
});

test("Play can use the phone original but never plays a poster or a remote URL", async () => {
  const files = {
    work: () => "file:///missing.mp4",
    exists: async (uri) => uri === "file:///original.mp4",
  };
  const context = { files, scope: "hub", volume: "photos" };
  assert.equal(
    await galleryVideoURI(
      { path: "clip.mp4", uri: "content://photos/7" },
      context,
    ),
    "content://photos/7",
  );
  assert.equal(
    await galleryVideoURI(
      { path: "upload:7", upload: "pending", uri: "file:///original.mp4" },
      context,
    ),
    "file:///original.mp4",
  );
  for (const uri of [null, "file:///missing.mp4", "https://hub/video.mp4"])
    await assert.rejects(
      galleryVideoURI(
        { path: "clip.mp4", uri, poster: "file:///thumb.jpg" },
        context,
      ),
      /not available locally yet/,
    );
});

function fixture() {
  let ready, fail, listener;
  const calls = [];
  const player = {
    replaceAsync: ({ uri }) => {
      calls.push(["load", uri]);
      return new Promise((resolve, reject) => {
        ready = resolve;
        fail = reject;
      });
    },
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
  };
  const appState = {
    currentState: "active",
    addEventListener: (_event, fn) => {
      listener = fn;
      return { remove: () => calls.push("unsubscribe") };
    },
  };
  const errors = [];
  const stop = startVideoPlayback(
    player,
    "file:///clip.mp4",
    appState,
    (error) => errors.push(error.message),
  );
  return {
    player,
    calls,
    errors,
    stop,
    ready: async () => {
      ready();
      await new Promise(setImmediate);
    },
    fail: async () => {
      fail(new Error("Unsupported codec"));
      await new Promise(setImmediate);
    },
    background: () => listener("background"),
  };
}

test("video starts after loading, pauses on background and stops when leaving the viewer", async () => {
  const f = fixture();
  assert.equal(f.player.staysActiveInBackground, false);
  await f.ready();
  assert.equal(f.calls.at(-1), "play");
  f.background();
  assert.equal(f.calls.at(-1), "pause");
  f.stop();
  assert.deepEqual(f.calls.slice(-2), ["unsubscribe", "pause"]);
});

test("closing or backgrounding while a video loads prevents late autoplay", async () => {
  for (const action of ["stop", "background"]) {
    const f = fixture();
    f[action]();
    await f.ready();
    assert.equal(f.calls.includes("play"), false);
  }
});

test("playback errors reach the viewer; late failures after closing are ignored", async () => {
  const current = fixture();
  await current.fail();
  assert.deepEqual(current.errors, ["Unsupported codec"]);
  current.stop();
  const closed = fixture();
  closed.stop();
  await closed.fail();
  assert.deepEqual(closed.errors, []);
});

test("video posters come only from files on this phone", async () => {
  const { videoPosterSource } = await import("../apps/mobile/src/video-playback.js");
  assert.equal(videoPosterSource({ uri: "file:///work/clip.mp4" }), "file:///work/clip.mp4");
  assert.equal(videoPosterSource({ uri: "content://media/7" }), "content://media/7");
  assert.equal(videoPosterSource({ uri: "content://media/7", nativeSource: true }), null);
  for (const uri of [null, "https://hub/v1/gallery/preview?path=clip.mp4", "ph://7"])
    assert.equal(videoPosterSource({ uri }), null);
});

test("a video poster is the first local frame and always releases the native player", async () => {
  const { renderVideoPoster } = await import("../apps/mobile/src/video-playback.js");
  const released = [];
  const ref = (name, extra = {}) => ({ ...extra, release: () => released.push(name) });
  const sources = [];
  let calls = 0;
  const tools = (answers, platform = "android") => ({
    platform,
    format: "jpeg",
    attempts: 3,
    delay: 1,
    createPlayer: (source) => {
      sources.push(source.uri);
      calls = 0;
      return ref("player", {
        generateThumbnailsAsync: async (times, options) => {
          assert.deepEqual(times, [0]);
          assert.deepEqual(options, { maxWidth: 360 });
          return answers[Math.min(calls++, answers.length - 1)];
        },
      });
    },
    manipulate: (frame) =>
      ref("context", {
        renderAsync: async () =>
          ref("image", {
            saveAsync: async (options) => {
              assert.deepEqual(options, { compress: 0.75, format: "jpeg" });
              return { uri: `file:///cache/${frame.name}.jpg` };
            },
          }),
      }),
  });
  assert.equal(
    await renderVideoPoster("file:///work/My%20Clips/clip%231.mp4", tools([[ref("frame", { name: "first" })]])),
    "file:///cache/first.jpg",
  );
  assert.deepEqual(sources, ["file:///work/My Clips/clip#1.mp4"]);
  assert.deepEqual(released.sort(), ["context", "frame", "image", "player"]);
  released.length = 0;
  await assert.rejects(renderVideoPoster("file:///work/clip.mp4", tools([[], [ref("frame", { name: "late" })]])), /thumbnail unavailable/);
  assert.equal(calls, 1, "Android reads the frame once");
  assert.deepEqual(released, ["player"]);
  sources.length = 0;
  await renderVideoPoster("file:///work/100%.mp4", tools([[ref("frame", { name: "raw" })]]));
  assert.deepEqual(sources, ["file:///work/100%.mp4"], "an undecodable path is passed through unchanged");

  sources.length = 0;
  assert.equal(
    await renderVideoPoster("file:///work/My%20Clips/clip.mp4", tools([[], [], [ref("frame", { name: "ios" })]], "ios")),
    "file:///cache/ios.jpg",
  );
  assert.equal(calls, 3, "iOS retries until the player item is attached");
  assert.deepEqual(sources, ["file:///work/My%20Clips/clip.mp4"]);
  released.length = 0;
  await assert.rejects(renderVideoPoster("file:///work/slow.mov", tools([[]], "ios")), /thumbnail unavailable/);
  assert.equal(calls, 3);
  assert.deepEqual(released, ["player"]);
});

test("a video whose poster failed is not rendered again until the file changes", async () => {
  const { rememberFailures } = await import("../apps/mobile/src/video-playback.js");
  const attempt = rememberFailures(2);
  let runs = 0;
  const fail = async () => {
    runs++;
    throw new Error("Unsupported codec");
  };
  await assert.rejects(attempt("clip:1:10", fail), /Unsupported codec/);
  await assert.rejects(attempt("clip:1:10", fail), /thumbnail unavailable/);
  assert.equal(runs, 1);
  assert.equal(await attempt("clip:2:20", async () => "file:///poster.jpg"), "file:///poster.jpg");
  await assert.rejects(attempt("b", fail));
  await assert.rejects(attempt("c", fail));
  await assert.rejects(attempt("clip:1:10", fail), /Unsupported codec/, "the oldest failure is forgotten beyond the limit");
  assert.equal(runs, 4);
  attempt.clear();
  await assert.rejects(attempt("b", fail), /Unsupported codec/, "returning to the app forgets failures");
  assert.equal(runs, 5);
});
