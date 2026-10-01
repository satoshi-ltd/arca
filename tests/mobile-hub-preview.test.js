import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptedHash,
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

test("the hash is the accepted revision only when the local file still has its size", () => {
  const known = new Map([
    ["a.heic", { rev: 3, hash: "h1", size: 10, deleted: false }],
    ["b.heic", { rev: 1, hash: "h2", size: 10, deleted: true }],
    ["c.heic", { rev: 1, hash: null, size: 10, deleted: false }],
  ]);
  assert.equal(acceptedHash(known, item()), "h1");
  assert.equal(acceptedHash(known, item({ size: 11 })), null, "an edited file is not the accepted revision");
  assert.equal(acceptedHash(known, item({ path: "b.heic" })), null, "a deleted row");
  assert.equal(acceptedHash(known, item({ path: "c.heic" })), null, "a row without a hash");
  assert.equal(acceptedHash(known, item({ path: "new.heic" })), null, "a file the hub never accepted");
  assert.equal(acceptedHash(null, item()), null, "before the phone index loads");
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
