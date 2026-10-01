import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../apps/mobile/src/thumbnail-cache.js";
import {
  acceptedHash,
  createAccepted,
  createHubPreviews,
  fetchHubPreview,
  hubFallback,
} from "../apps/mobile/src/hub-preview.js";

const item = (extra = {}) => ({
  path: "a.heic",
  uri: "file:///a.heic",
  size: 10,
  mtime: 1,
  kind: "image",
  ...extra,
});
const reply = (body = "AAAA") => ({ data: `data:image/jpeg;base64,${body}` });
const never = () => false;

test("the hub preview request names the volume, path and hash and returns the JPEG payload", async () => {
  const routes = [];
  const options = [];
  const api = async (route, body, extra) => {
    routes.push(route);
    options.push([body, extra]);
    return reply("QUJD");
  };
  assert.equal(await fetchHubPreview({ api, volume: "v1", item: item(), hash: "h1" }), "QUJD");
  assert.equal(await fetchHubPreview({ api, volume: "v1", item: item(), hash: "h1", large: true }), "QUJD");
  assert.deepEqual(routes, [
    "/v1/gallery/preview?volume=v1&path=a.heic&hash=h1",
    "/v1/gallery/preview?volume=v1&path=a.heic&hash=h1&size=large",
  ]);
  assert.deepEqual(options, [[undefined, { timeout: 30000 }], [undefined, { timeout: 30000 }]], "a HEIC the hub still has to decode gets more time than the default");
  await assert.rejects(fetchHubPreview({ api: async () => ({ unavailable: true }), volume: "v1", item: item(), hash: "h1" }), /Hub preview unavailable/);
  await assert.rejects(fetchHubPreview({ api: async () => ({ data: "data:image/png;base64,AA" }), volume: "v1", item: item(), hash: "h1" }), /Hub preview unavailable/);
});

test("the hash is the accepted revision only when the local bytes match, and only matching rows are ever hashed", async () => {
  const known = new Map([
    ["a.heic", { rev: 3, hash: "h1", size: 10, deleted: false }],
    ["b.heic", { rev: 1, hash: "h2", size: 10, deleted: true }],
    ["c.heic", { rev: 1, hash: null, size: 10, deleted: false }],
  ]);
  const hashed = [];
  const hashFile = async (uri) => {
    hashed.push(uri);
    return "h1";
  };
  assert.equal(await acceptedHash(known, item(), hashFile), "h1");
  assert.equal(hashed.length, 1);
  assert.equal(await acceptedHash(known, item({ size: 11 }), hashFile), null, "an edited file is not the accepted revision");
  assert.equal(await acceptedHash(known, item({ uri: null }), hashFile), null, "a file that is not on the phone");
  assert.equal(await acceptedHash(known, item({ path: "b.heic" }), hashFile), null, "a deleted row");
  assert.equal(await acceptedHash(known, item({ path: "c.heic" }), hashFile), null, "a row without a hash");
  assert.equal(await acceptedHash(known, item({ path: "new.heic" }), hashFile), null, "a file the hub never accepted");
  assert.equal(await acceptedHash(null, item(), hashFile), null, "before the phone index loads");
  assert.equal(hashed.length, 1, "none of those read the file");
  assert.equal(await acceptedHash(known, item(), async () => "edited"), null, "a same-size edit has other bytes");
  assert.equal(await acceptedHash(known, item(), async () => { throw new Error("File disappeared"); }), null);
});

test("a verification is computed once per file and revision, one file at a time, and forgotten on clear", async () => {
  const known = new Map([
    ["a.heic", { hash: "h1", size: 10 }],
    ["b.heic", { hash: "h2", size: 10 }],
    ["c.heic", { hash: "h3", size: 10 }],
  ]);
  let running = 0;
  let peak = 0;
  const calls = [];
  const hashFile = async (uri) => {
    calls.push(uri);
    running++;
    peak = Math.max(peak, running);
    await new Promise(setImmediate);
    running--;
    return { "file:///a.heic": "h1", "file:///b.heic": "other", "file:///c.heic": "h3" }[uri];
  };
  const accepted = createAccepted({ hashFile });
  const a = item({ uri: "file:///a.heic", path: "a.heic" });
  const b = item({ uri: "file:///b.heic", path: "b.heic" });
  const c = item({ uri: "file:///c.heic", path: "c.heic" });
  const results = await Promise.all([accepted(known, a), accepted(known, a), accepted(known, b), accepted(known, c)]);
  assert.deepEqual(results, ["h1", "h1", null, "h3"]);
  assert.deepEqual(calls, ["file:///a.heic", "file:///b.heic", "file:///c.heic"], "the same file in flight is hashed once");
  assert.equal(peak, 1, "files are hashed one at a time");
  assert.equal(await accepted(known, b), null);
  assert.equal(calls.length, 3, "a negative result is remembered too");
  assert.equal(await accepted(known, { ...a, mtime: 2 }), "h1");
  assert.equal(calls.length, 4, "an edited file is verified again");
  accepted.clear();
  assert.equal(await accepted(known, a), "h1");
  assert.equal(calls.length, 5, "clearing forgets what was verified");
});

test("the cheap gates run before any hashing, and the viewer ignores the grid's pause", async () => {
  let clock = 0;
  const previews = createHubPreviews({
    api: async () => {
      throw new Error("Network request failed");
    },
    save: async (entry, variant, load) => load(),
    unreachable: (error) => /Network/.test(error.message),
    busy: never,
    now: () => clock,
  });
  assert.equal(previews.allowed({ linked: true, item: item() }), true);
  assert.equal(previews.allowed({ linked: false, item: item() }), false, "offline");
  assert.equal(previews.allowed({ linked: true, item: item({ uri: null }) }), false, "not on the phone");
  assert.equal(previews.allowed({ linked: true, item: item({ upload: "pending" }) }), false, "a pending upload");
  await previews.preview({ linked: true, volume: "v1", hash: "h", item: item() });
  assert.equal(previews.allowed({ linked: true, item: item({ uri: "file:///b" }) }), false, "paused after an unreachable answer");
  assert.equal(previews.allowed({ linked: true, item: item({ uri: "file:///b" }), large: true }), true, "the viewer asks anyway");
  clock += 30000;
  assert.equal(previews.allowed({ linked: true, item: item({ uri: "file:///b" }) }), true);
  const hashed = [];
  const wrap = hubFallback({
    previews,
    context: () => ({ linked: true, volume: "v1", hashOf: async (value) => (hashed.push(value.uri), "h") }),
  });
  const render = wrap(async () => {
    throw new Error("Unsupported image");
  });
  await assert.rejects(render(item({ uri: "file:///c" })), /Unsupported image/);
  assert.deepEqual(hashed, ["file:///c"], "an allowed fallback verifies the file");
  await assert.rejects(render(item({ uri: "file:///d" })), /Unsupported image/);
  assert.deepEqual(hashed, ["file:///c"], "a paused hub means no hashing at all");
  const offline = hubFallback({ previews, context: () => ({ linked: false, volume: "v1", hashOf: async (value) => (hashed.push(value.uri), "h") }) })(async () => {
    throw new Error("Unsupported image");
  });
  await assert.rejects(offline(item({ uri: "file:///e" })), /Unsupported image/);
  assert.deepEqual(hashed, ["file:///c"], "offline means no hashing either");
});

test("the hub is asked only for photos already on the phone, once, and a saved preview needs no request", async () => {
  const requests = [];
  const saved = new Map();
  const previews = createHubPreviews({
    api: async (route) => {
      requests.push(route);
      return reply();
    },
    save: async (entry, variant, load) => {
      const key = `${entry.uri}:${variant}`;
      if (!saved.has(key)) saved.set(key, `cache://${variant}/${await load()}`);
      return saved.get(key);
    },
    unreachable: never,
    busy: never,
  });
  const context = { linked: true, volume: "v1", hash: "h1" };
  assert.equal(await previews.preview({ ...context, item: item() }), "cache://thumb/AAAA");
  assert.equal(await previews.preview({ ...context, item: item() }), "cache://thumb/AAAA");
  assert.equal(requests.length, 1, "the second call is served from the saved file");
  assert.equal(await previews.preview({ ...context, item: item({ kind: "video", uri: "file:///v.mp4", path: "v.mp4" }) }), "cache://poster/AAAA", "a video gets its poster");
  assert.equal(await previews.preview({ ...context, item: item({ uri: null }) }), null, "never for a photo that is not on the phone");
  assert.equal(await previews.preview({ ...context, item: item({ upload: "pending" }) }), null, "never for a pending upload");
  assert.equal(await previews.preview({ ...context, hash: null, item: item() }), null, "no hash, no request");
  assert.equal(await previews.preview({ ...context, linked: false, item: item({ uri: "file:///other" }) }), null, "offline asks nothing");
  assert.equal(requests.length, 2);
});

test("only a refusal from the hub is remembered; a busy or unreachable hub is asked again", async () => {
  let attempts = 0;
  let failure = new Error("Network request failed");
  const previews = createHubPreviews({
    api: async () => {
      attempts++;
      throw failure;
    },
    save: async (entry, variant, load) => `cache://${await load()}`,
    unreachable: (error) => /Network/.test(error.message),
    busy: (error) => [409, 429].includes(error.status),
  });
  const context = { linked: true, volume: "v1", hash: "h1", item: item() };
  const second = { ...context, item: item({ uri: "file:///b.heic" }) };
  assert.equal(await previews.preview(context), null);
  assert.equal(attempts, 1);
  failure = Object.assign(new Error("Previews are busy. Try again."), { status: 429 });
  previews.clear();
  assert.equal(await previews.preview(context), null);
  assert.equal(await previews.preview(context), null);
  assert.equal(attempts, 3, "a busy hub is not remembered");
  failure = Object.assign(new Error("Sync this photo before previewing it"), { status: 409 });
  assert.equal(await previews.preview(context), null);
  assert.equal(attempts, 4);
  failure = Object.assign(new Error("This photo is no longer available"), { status: 404 });
  assert.equal(await previews.preview(second), null);
  assert.equal(await previews.preview(second), null);
  assert.equal(attempts, 5, "a refusal is remembered");
  previews.clear();
  assert.equal(await previews.preview(second), null);
  assert.equal(attempts, 6, "clearing forgets the refusals");
});

test("after the hub is unreachable no other photo is asked for thirty seconds", async () => {
  let clock = 1000;
  let attempts = 0;
  const previews = createHubPreviews({
    api: async () => {
      attempts++;
      throw new Error("Network request failed");
    },
    save: async (entry, variant, load) => `cache://${await load()}`,
    unreachable: (error) => /Network/.test(error.message),
    busy: never,
    now: () => clock,
  });
  const ask = (name) => previews.preview({ linked: true, volume: "v1", hash: "h", item: item({ uri: `file:///${name}` }) });
  assert.equal(await ask("a"), null);
  assert.equal(await ask("b"), null);
  assert.equal(await ask("c"), null);
  assert.equal(attempts, 1, "one unreachable answer pauses every request");
  clock += 29999;
  assert.equal(await ask("d"), null);
  assert.equal(attempts, 1);
  clock += 1;
  assert.equal(await ask("e"), null);
  assert.equal(attempts, 2, "and they resume afterwards");
});

test("the fallback runs only after the local render fails and rethrows the local error when the hub has nothing", async () => {
  const calls = [];
  const previews = {
    preview: async (request) => {
      calls.push(request);
      return request.item.path === "ok.heic" ? "cache://hub" : null;
    },
  };
  const wrap = hubFallback({ previews, context: (value) => ({ linked: true, volume: "v1", hash: `h-${value.path}` }) });
  const local = async (value) => {
    if (value.path.endsWith(".heic")) throw new Error("Unsupported image");
    return `cache://local/${value.path}`;
  };
  const render = wrap(local);
  assert.equal(await render(item({ path: "b.jpg" })), "cache://local/b.jpg");
  assert.deepEqual(calls, [], "a decodable photo never reaches the hub");
  assert.equal(await render(item({ path: "ok.heic" })), "cache://hub");
  assert.deepEqual(calls[0], { linked: true, volume: "v1", hash: "h-ok.heic", item: item({ path: "ok.heic" }), large: false });
  await assert.rejects(render(item({ path: "bad.heic" })), /Unsupported image/);
});

test("the viewer's large preview comes from the hub only for photos on the phone and is asked for again at every open", async () => {
  let clock = 0;
  let attempts = 0;
  let failure = null;
  const variants = [];
  const previews = createHubPreviews({
    api: async (route) => {
      attempts++;
      if (failure) throw failure;
      assert.match(route, /size=large/);
      return reply("TEFSR0U=");
    },
    save: async (entry, variant, load) => {
      variants.push(variant);
      return `cache://${variant}/${await load()}`;
    },
    unreachable: (error) => /Network/.test(error.message),
    busy: never,
    now: () => clock,
  });
  const context = { linked: true, volume: "v1", hash: "h1", large: true, item: item() };
  assert.equal(await previews.preview(context), "cache://large/TEFSR0U=");
  assert.deepEqual(variants, ["large"]);
  assert.equal(await previews.preview({ ...context, item: item({ uri: null }) }), null, "never for a photo that is not on the phone");
  assert.equal(await previews.preview({ ...context, linked: false }), null, "offline asks nothing");
  failure = Object.assign(new Error("This photo is no longer available"), { status: 404 });
  assert.equal(await previews.preview(context), null);
  assert.equal(await previews.preview(context), null);
  assert.equal(attempts, 3, "a refusal is not remembered for the viewer");
  failure = new Error("Network request failed");
  assert.equal(await previews.preview(context), null);
  assert.equal(await previews.preview(context), null);
  assert.equal(attempts, 5, "an unreachable hub is asked again at the next open");
  assert.equal(await previews.preview({ ...context, large: false }), null);
  assert.equal(attempts, 6, "the grid thumbnail is unaffected by the viewer");
  assert.equal(await previews.preview({ ...context, large: false }), null);
  assert.equal(attempts, 6, "but the unreachable answer paused the grid");
  assert.equal(await previews.preview(context), null);
  assert.equal(attempts, 7, "while the viewer ignores that pause and asks at every open");
  const wrap = hubFallback({ previews: { preview: async (request) => (request.large ? "cache://hub-large" : null) }, context: () => ({ linked: true, volume: "v1", hash: "h1" }) });
  const render = wrap(async () => {
    throw new Error("Unsupported image");
  }, true);
  assert.equal(await render(item(), true, false), "cache://hub-large", "the fallback reports that it is for the large preview");
});


test("hub fallback waits for local hash verification before requesting a preview", async () => {
  let requests = 0;
  const known = new Map([["a.heic", { hash: "accepted", size: 10 }]]);
  let contents = "edited";
  const accepted = createAccepted({ hashFile: async () => contents });
  const render = hubFallback({
    previews: {
      allowed: () => true,
      preview: async ({ hash }) => {
        if (!hash) return null;
        requests++;
        return "cache://verified";
      },
    },
    context: () => ({ linked: true, volume: "v1", hashOf: (entry) => accepted(known, entry) }),
  })(async () => {
    throw new Error("Unsupported image");
  });
  await assert.rejects(render(item()), /Unsupported image/);
  assert.equal(requests, 0);
  accepted.clear();
  contents = "accepted";
  assert.equal(await render(item()), "cache://verified");
  assert.equal(requests, 1);
});

test("the verification memo stays bounded", async () => {
  let calls = 0;
  const known = new Map(["a", "b", "c"].map((name) => [`${name}.heic`, { hash: "h", size: 10 }]));
  const accepted = createAccepted({ hashFile: async () => (calls++, "h"), limit: 2 });
  const of = (name) => item({ uri: `file:///${name}.heic`, path: `${name}.heic` });
  for (const name of ["a", "b", "c"]) await accepted(known, of(name));
  assert.equal(calls, 3);
  await accepted(known, of("c"));
  assert.equal(calls, 3, "the newest are remembered");
  await accepted(known, of("a"));
  assert.equal(calls, 4, "the oldest was forgotten");
});

test("a new accepted revision with the same file is verified again, a hash that times out is not remembered, and the viewer goes first", async () => {
  const known = new Map([["a.heic", { hash: "h1", size: 10 }]]);
  let calls = 0;
  const accepted = createAccepted({ hashFile: async () => (calls++, "h2") });
  assert.equal(await accepted(known, item()), null, "the file has other bytes than the accepted revision");
  known.set("a.heic", { hash: "h2", size: 10 });
  assert.equal(await accepted(known, item()), "h2", "the hub accepted a new revision with the same uri, size and mtime");
  assert.equal(calls, 2);

  let slow = 0;
  const stuck = createAccepted({
    hashFile: async () => {
      slow++;
      if (slow === 1) await new Promise((resolve) => setTimeout(resolve, 60));
      return "h1";
    },
    limiter: createLimiter(1, 10),
  });
  const first = await stuck(new Map([["a.heic", { hash: "h1", size: 10 }]]), item());
  assert.equal(first, null, "a timeout answers null for that call");
  const again = await stuck(new Map([["a.heic", { hash: "h1", size: 10 }]]), item());
  assert.equal(again, "h1", "and is not remembered");

  const order = [];
  const lanes = createAccepted({
    hashFile: async (uri) => {
      order.push(uri);
      await new Promise(setImmediate);
      return "h";
    },
  });
  const rows = new Map(["a", "b", "c", "d"].map((name) => [`${name}.heic`, { hash: "h", size: 10 }]));
  const of = (name) => item({ uri: `file:///${name}.heic`, path: `${name}.heic` });
  await Promise.all([lanes(rows, of("a")), lanes(rows, of("b")), lanes(rows, of("c")), lanes(rows, of("d"), true)]);
  assert.deepEqual(order, ["file:///a.heic", "file:///d.heic", "file:///b.heic", "file:///c.heic"], "the viewer's file jumps the background queue");
});

test("the viewer is allowed without the grid's pause but never offline, and a fallback passes whether it is for the viewer", async () => {
  const previews = createHubPreviews({ api: async () => reply(), save: async () => "cache://x", unreachable: never, busy: never });
  assert.equal(previews.allowed({ linked: false, item: item(), large: true }), false);
  assert.equal(previews.allowed({ linked: true, item: item({ uri: null }), large: true }), false);
  const seen = [];
  const wrap = hubFallback({
    previews: { allowed: () => true, preview: async () => "cache://hub" },
    context: () => ({ linked: true, volume: "v1", hashOf: async (value, large) => (seen.push(large), "h") }),
  });
  const fail = async () => {
    throw new Error("Unsupported image");
  };
  await wrap(fail)(item());
  await wrap(fail, true)(item());
  assert.deepEqual(seen, [false, true]);
});
