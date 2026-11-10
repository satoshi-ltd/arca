export const MAX_PHOTO_ZOOM = 4;
export const DOUBLE_CLICK_ZOOM = 2.5;
export const PHOTO_REST = { scale: 1, x: 0, y: 0 };

export function clampPhotoOffset(offset, scale, image, frame) {
  const maxX = Math.max(0, (image.width * scale - frame.width) / 2);
  const maxY = Math.max(0, (image.height * scale - frame.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

export function zoomPhoto(state, nextScale, focal, image, frame) {
  const scale = Math.min(MAX_PHOTO_ZOOM, Math.max(1, nextScale));
  if (scale === 1) return PHOTO_REST;
  const ratio = scale / state.scale;
  return {
    scale,
    ...clampPhotoOffset({ x: focal.x - (focal.x - state.x) * ratio, y: focal.y - (focal.y - state.y) * ratio }, scale, image, frame),
  };
}

export function panPhoto(state, dx, dy, image, frame) {
  if (state.scale <= 1) return state;
  return { scale: state.scale, ...clampPhotoOffset({ x: state.x + dx, y: state.y + dy }, state.scale, image, frame) };
}

export function attachPhotoZoom(frame) {
  let state = PHOTO_REST;
  let gestureStart = 1;
  let drag = null;
  const image = () => frame.querySelector("img");
  const sizes = () => {
    const img = image();
    const fit = img.naturalWidth && img.naturalHeight ? Math.min(img.offsetWidth / img.naturalWidth, img.offsetHeight / img.naturalHeight) : 0;
    const shown = fit ? { width: img.naturalWidth * fit, height: img.naturalHeight * fit } : { width: img.offsetWidth, height: img.offsetHeight };
    return [shown, { width: frame.clientWidth, height: frame.clientHeight }];
  };
  const focal = (event) => {
    const box = frame.getBoundingClientRect();
    return { x: event.clientX - (box.left + box.width / 2), y: event.clientY - (box.top + box.height / 2) };
  };
  const apply = (next) => {
    state = next;
    frame.style.setProperty("--photo-zoom", String(next.scale));
    frame.style.setProperty("--photo-x", `${next.x}px`);
    frame.style.setProperty("--photo-y", `${next.y}px`);
    frame.classList.toggle("zoomed", next.scale > 1);
  };
  const zoomTo = (scale, event) => apply(zoomPhoto(state, scale, focal(event), ...sizes()));
  const handlers = {
    wheel: (event) => {
      if (!image()) return;
      if (event.ctrlKey) {
        event.preventDefault();
        const delta = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 1000 : 1);
        zoomTo(state.scale * Math.exp(-Math.max(-50, Math.min(50, delta)) / 100), event);
      } else if (state.scale > 1) {
        event.preventDefault();
        apply(panPhoto(state, -event.deltaX, -event.deltaY, ...sizes()));
      }
    },
    gesturestart: (event) => {
      event.preventDefault();
      gestureStart = state.scale;
    },
    gesturechange: (event) => {
      event.preventDefault();
      if (image()) zoomTo(gestureStart * event.scale, event);
    },
    gestureend: (event) => event.preventDefault(),
    dblclick: (event) => {
      if (state.scale <= 1 && !event.target.closest?.("img")) return;
      event.preventDefault();
      zoomTo(state.scale > 1 ? 1 : DOUBLE_CLICK_ZOOM, event);
    },
    pointerdown: (event) => {
      if (state.scale <= 1 || event.button !== 0 || !event.target.closest?.("img")) return;
      event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      frame.setPointerCapture?.(event.pointerId);
      frame.classList.add("panning");
    },
    pointermove: (event) => {
      if (drag?.id !== event.pointerId) return;
      apply(panPhoto(state, event.clientX - drag.x, event.clientY - drag.y, ...sizes()));
      drag.x = event.clientX;
      drag.y = event.clientY;
    },
    pointerup: (event) => {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      frame.classList.remove("panning");
    },
  };
  handlers.pointercancel = handlers.pointerup;
  for (const [name, handler] of Object.entries(handlers)) frame.addEventListener(name, handler, { passive: false });
  const refit = () => {
    if (state.scale > 1 && image()) apply(panPhoto(state, 0, 0, ...sizes()));
  };
  frame.addEventListener("load", refit, { capture: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(refit).observe(frame);
  return {
    get state() {
      return state;
    },
    reset: () => apply(PHOTO_REST),
  };
}
