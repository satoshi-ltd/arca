import test from "node:test";
import assert from "node:assert/strict";
import { DOUBLE_CLICK_ZOOM, MAX_PHOTO_ZOOM, PHOTO_REST, attachPhotoZoom, panPhoto, zoomPhoto } from "../apps/desktop/src/photo-zoom.js";

const image = { width: 800, height: 600 };
const frame = { width: 1000, height: 700 };

test("zooming keeps the point under the pointer still, stays between 1× and 4× and never shows past the photo's edges", () => {
  const zoomed = zoomPhoto(PHOTO_REST, 2, { x: 100, y: 50 }, image, frame);
  assert.deepEqual(zoomed, { scale: 2, x: -100, y: -50 });
  assert.equal(zoomPhoto(zoomed, 9, { x: 0, y: 0 }, image, frame).scale, MAX_PHOTO_ZOOM);
  assert.deepEqual(zoomPhoto(zoomed, 0.4, { x: 0, y: 0 }, image, frame), PHOTO_REST, "zooming out past 1× returns to the whole photo");
  const edge = zoomPhoto(PHOTO_REST, 2, { x: 5000, y: -5000 }, image, frame);
  assert.deepEqual(edge, { scale: 2, x: -300, y: 250 }, "the offset is clamped to half the overflow");
  assert.deepEqual(panPhoto(zoomed, 10000, 0, image, frame), { scale: 2, x: 300, y: -50 });
  assert.equal(panPhoto(PHOTO_REST, 50, 50, image, frame), PHOTO_REST, "an unzoomed photo does not pan");
});

function fakeFrame(img = { offsetWidth: 800, offsetHeight: 600 }) {
  const handlers = {};
  const props = {};
  const classes = new Set();
  return {
    props,
    classes,
    handlers,
    clientWidth: 1000,
    clientHeight: 700,
    querySelector: (selector) => (selector === "img" ? img : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
    addEventListener: (name, handler, options) => {
      if (name !== "load") assert.equal(options?.passive, false, `${name} can prevent the page zoom`);
      handlers[name] = handler;
    },
    style: { setProperty: (name, value) => (props[name] = value) },
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    setPointerCapture: () => {},
  };
}
const event = (fields) => ({ clientX: 500, clientY: 350, target: { closest: (selector) => (selector === "img" ? {} : null) }, preventDefault() { this.prevented = true; }, ...fields });

test("a trackpad pinch, a double click and a drag zoom and move the photo in the viewer", () => {
  const frame = fakeFrame();
  const zoom = attachPhotoZoom(frame);
  const dbl = event({});
  frame.handlers.dblclick(dbl);
  assert.ok(dbl.prevented);
  assert.equal(zoom.state.scale, DOUBLE_CLICK_ZOOM);
  assert.equal(frame.props["--photo-zoom"], String(DOUBLE_CLICK_ZOOM));
  assert.ok(frame.classes.has("zoomed"));
  frame.handlers.dblclick(event({}));
  assert.equal(zoom.state.scale, 1, "a second double click shows the whole photo again");
  assert.ok(!frame.classes.has("zoomed"));
  const pinch = event({ ctrlKey: true, deltaY: -100, deltaX: 0, deltaMode: 0 });
  frame.handlers.wheel(pinch);
  assert.ok(pinch.prevented, "the pinch never zooms the whole window");
  assert.ok(Math.abs(zoom.state.scale - Math.exp(0.5)) < 1e-9, "one event zooms by at most e^0.5");
  const scroll = event({ ctrlKey: false, deltaX: 40, deltaY: 20, deltaMode: 0 });
  frame.handlers.wheel(scroll);
  assert.ok(scroll.prevented);
  assert.deepEqual([zoom.state.x, zoom.state.y], [-40, -20], "two-finger scrolling pans a zoomed photo");
  frame.handlers.pointerdown(event({ button: 0, pointerId: 1, clientX: 100, clientY: 100 }));
  assert.ok(frame.classes.has("panning"));
  frame.handlers.pointermove(event({ pointerId: 1, clientX: 130, clientY: 90 }));
  assert.deepEqual([zoom.state.x, zoom.state.y], [-10, -30]);
  frame.handlers.pointerup(event({ pointerId: 1 }));
  assert.ok(!frame.classes.has("panning"));
  frame.handlers.gesturestart(event({ scale: 1 }));
  frame.handlers.gesturechange(event({ scale: 0.1 }));
  assert.equal(zoom.state.scale, 1, "Safari's pinch gesture zooms back out");
  const idle = event({ ctrlKey: false, deltaX: 0, deltaY: 30, deltaMode: 0 });
  frame.handlers.wheel(idle);
  assert.ok(!idle.prevented, "an unzoomed photo leaves scrolling alone");
});

const onFrame = { closest: () => null };

test("while zoomed, a double click anywhere in the frame shows the whole photo, since pointer capture retargets it to the frame", () => {
  const frame = fakeFrame();
  const zoom = attachPhotoZoom(frame);
  frame.handlers.dblclick(event({ target: onFrame }));
  assert.equal(zoom.state.scale, 1, "an unzoomed double click off the photo does nothing");
  frame.handlers.dblclick(event({}));
  frame.handlers.dblclick(event({ target: onFrame }));
  assert.equal(zoom.state.scale, 1);
});

test("dragging the black around a zoomed photo leaves it to the window, and one mouse wheel notch zooms gently", () => {
  const frame = fakeFrame();
  const zoom = attachPhotoZoom(frame);
  frame.handlers.dblclick(event({}));
  const outside = event({ button: 0, pointerId: 2, target: onFrame });
  frame.handlers.pointerdown(outside);
  assert.ok(!outside.prevented && !frame.classes.has("panning"));
  zoom.reset();
  frame.handlers.wheel(event({ ctrlKey: true, deltaY: -3, deltaX: 0, deltaMode: 1 }));
  assert.ok(Math.abs(zoom.state.scale - Math.exp(0.5)) < 1e-9, "a line-mode notch counts as at most 50 px");
  frame.handlers.wheel(event({ ctrlKey: true, deltaY: -120, deltaX: 0, deltaMode: 0 }));
  assert.ok(zoom.state.scale < 3, "a 120 px notch never jumps to the maximum");
});

test("a letterboxed photo pans only over the photo itself, not its black bars", () => {
  const frame = fakeFrame({ offsetWidth: 1000, offsetHeight: 700, naturalWidth: 2000, naturalHeight: 1000 });
  const zoom = attachPhotoZoom(frame);
  frame.handlers.dblclick(event({}));
  frame.handlers.wheel(event({ ctrlKey: false, deltaX: 0, deltaY: -10000, deltaMode: 0 }));
  assert.equal(zoom.state.y, 275, "the 1000x500 photo at 2.5x is 1250 tall in a 700 frame, so it moves at most 275");
  frame.handlers.wheel(event({ ctrlKey: false, deltaX: 0, deltaY: 10000, deltaMode: 0 }));
  assert.equal(zoom.state.y, -275);
});

test("a zoomed photo is clamped again when the full preview replaces the placeholder at a smaller size", () => {
  const img = { offsetWidth: 800, offsetHeight: 600 };
  const frame = fakeFrame(img);
  const zoom = attachPhotoZoom(frame);
  frame.handlers.dblclick(event({}));
  frame.handlers.wheel(event({ ctrlKey: false, deltaX: -10000, deltaY: 0, deltaMode: 0 }));
  assert.equal(zoom.state.x, 500);
  img.offsetWidth = 400;
  frame.handlers.load();
  assert.equal(zoom.state.x, 0, "a 400 px photo at 2.5x is exactly the frame's width, so it can no longer move sideways");
});
