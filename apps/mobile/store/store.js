// Builds one store image: ?canvas=ios-phone|ios-ipad|ios-header|ios-search|play-phone|play-tablet|play-feature&slide=N
(() => {
  const params = new URLSearchParams(location.search);
  const canvas = params.get("canvas") || "ios-phone";
  const slide = params.get("slide") || "1";
  const group =
    { "play-feature": "feature", "ios-header": "header", "ios-search": "search" }[canvas] ||
    (/ipad|tablet/.test(canvas) ? "tablet" : "phone");
  const template = document.getElementById(`${group}-${slide}`);
  const root = document.getElementById("canvas");
  root.classList.add(`store-${canvas}`);
  // render.mjs passes the design size; the page zooms it to fill the window.
  const width = Number(params.get("w"));
  const height = Number(params.get("h"));
  if (width && height) {
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    root.style.zoom = String(innerWidth / width);
  }
  root.append(template.content.cloneNode(true));
  document.documentElement.dataset.theme = template.dataset.theme || "light";

  // data-device="phone-N" reuses that slide's phone; the page theme applies to it.
  root.querySelectorAll("[data-device]").forEach((slot) => {
    const source = document.getElementById(slot.dataset.device).content.querySelector(".m-device");
    slot.append(source.cloneNode(true));
  });

  // ?safe=1 outlines Apple's art safe area (measured from its templates) for review.
  const safe = { "ios-header": [1646 / 3840, 661 / 1646], "ios-search": [2168 / 3840, 1030 / 2560] }[canvas];
  if (safe && params.get("safe")) {
    const box = document.createElement("div");
    box.className = "store-safe";
    box.style.width = `${safe[0] * 100}%`;
    box.style.height = `${safe[1] * 100}%`;
    root.append(box);
  }

  // Device names and platforms follow the store the image is for.
  const platform = canvas.startsWith("ios") ? "ios" : "android";
  root.querySelectorAll("[data-ios]").forEach((el) => (el.textContent = el.dataset[platform]));

  // Photo grids: data-photos="first-last", data-videos lists tiles that carry the play badge.
  root.querySelectorAll("[data-photos]").forEach((grid) => {
    const [first, last] = grid.dataset.photos.split("-").map(Number);
    const videos = (grid.dataset.videos || "").split(",").map(Number);
    for (let n = first; n <= last; n++) {
      const tile = document.createElement("div");
      tile.className = "m-photo";
      const img = document.createElement("img");
      img.className = "store-photo";
      img.alt = "";
      img.src = `photos/${String(n).padStart(2, "0")}.jpg`;
      tile.append(img);
      if (videos.includes(n)) {
        const badge = document.createElement("span");
        badge.className = "m-photo-badge";
        badge.innerHTML = '<span data-icon="play" data-size="14"></span>';
        tile.append(badge);
      }
      grid.append(tile);
    }
  });

  const camel = (name) => name.replace(/(^|-)([a-z0-9])/g, (_, a, b) => b.toUpperCase());
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const node = window.lucide?.icons[camel(el.dataset.icon)];
    if (!node) return;
    const size = Number(el.dataset.size) || 16;
    const svg = window.lucide.createElement(node);
    for (const [key, value] of Object.entries({ width: size, height: size, "stroke-width": 1.75, "aria-hidden": "true", class: `icon ${el.className}`.trim() }))
      svg.setAttribute(key, String(value));
    el.replaceWith(svg);
  });

  // Scale the device to the room left under the copy.
  const stage = root.querySelector(".store-stage");
  const device = stage?.querySelector(".m-device");
  if (device && (group === "phone" || group === "tablet")) {
    const room = stage.clientWidth / device.offsetWidth;
    const fit = canvas === "play-phone"
      ? Math.min(0.86, room)
      : Math.min(group === "tablet" ? 1.3 : 1.12, stage.clientHeight / device.offsetHeight, room);
    device.style.setProperty("--fit", fit.toFixed(4));
  }
})();
