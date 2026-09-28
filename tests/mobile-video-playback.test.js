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
