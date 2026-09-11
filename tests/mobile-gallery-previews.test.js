import test from "node:test";
import assert from "node:assert/strict";
import { recentGalleryPreviews } from "../apps/mobile/src/gallery-previews.js";

test("recent previews skip deleted and unavailable media and fill from older receipts", async () => {
  const rows = Array.from({ length: 40 }, (_, id) => ({
    id,
    state: "accepted",
  }));
  const store = {
    galleryPreview: async (_s, _v, accepted, limit, offset) => {
      assert.equal(accepted, true);
      return rows.slice(offset, offset + limit);
    },
  };
  const media = {
    preview: async (id) => {
      if (id < 10) throw new Error("Asset deleted");
      return { uri: id < 15 ? null : `file:///photo-${id}.jpg` };
    },
  };
  const result = await recentGalleryPreviews(store, media, "scope", "photos");
  assert.deepEqual(
    result.map((item) => item.id),
    Array.from({ length: 16 }, (_, i) => i + 15),
  );
  assert.equal(rows.length, 40);
  assert.ok(rows.every((item) => item.state === "accepted"));
});

test("empty gallery and cancelled preview loads finish without placeholders", async () => {
  assert.deepEqual(
    await recentGalleryPreviews(
      { galleryPreview: async () => [] },
      {},
      "s",
      "v",
    ),
    [],
  );
  assert.deepEqual(
    await recentGalleryPreviews({}, {}, "s", "v", () => false),
    [],
  );
});
