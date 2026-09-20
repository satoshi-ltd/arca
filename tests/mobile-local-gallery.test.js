import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileLocalGallery,
  isGalleryVideo,
} from "../apps/mobile/src/local-gallery.js";
test("local gallery includes nested downloaded media without Photos receipts and keeps positions on refresh", () => {
  const photo = {
    path: "Machine-other/2026/photo.JPG",
    uri: "file:///copy.jpg",
  };
  const movie = { path: "Machine-other/movie.mov", uri: "file:///movie.mov" };
  const initial = reconcileLocalGallery(
    [],
    [
      photo,
      movie,
      { path: "notes.txt" },
      { path: "album.jpg", directory: true },
    ],
  );
  assert.deepEqual(initial, [photo, movie]);
  assert.equal(isGalleryVideo(movie), true);
  const added = { path: "a-new.jpg", uri: "file:///new.jpg" };
  const changed = { ...photo, size: 999 };
  assert.deepEqual(reconcileLocalGallery(initial, [added, changed, movie]), [
    changed,
    movie,
    added,
  ]);
  assert.deepEqual(reconcileLocalGallery(initial, [added, movie]), [
    movie,
    added,
  ]);
  assert.deepEqual(reconcileLocalGallery(initial, []), []);
});
