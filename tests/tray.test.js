import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

test("disconnected tray keeps the Arca header and explicit static folder warnings", async () => {
  const dom = new JSDOM('<div id="tray-content"></div>', {
    runScripts: "outside-only",
    url: "http://tauri.localhost",
  });
  const w = dom.window;
  w.setInterval = () => 0;
  w.matchMedia = () => ({ matches: false });
  w.ResizeObserver = class {
    observe() {}
  };
  w.lucide = { createIcons() {} };
  w.__TAURI__ = {
    core: {
      invoke: async () => ({
        name: "Mac",
        role: "replica",
        phase: "unlinked",
        lastSync: null,
        volumes: [
          {
            id: "saved",
            name: "Saved folder",
            selected: true,
            sync: { state: "synced" },
          },
        ],
      }),
    },
  };
  try {
    const source = fs.readFileSync(
      new URL("../apps/desktop/src/tray.js", import.meta.url),
      "utf8",
    );
    await w.eval(`(async () => {${source}\n})()`);
    assert.equal(
      w.document.querySelector(".tray-heading strong").textContent,
      "Disconnected",
    );
    const logo = w.document.querySelector(".tray-heading .tray-brand-icon");
    assert.equal(logo.getAttribute("src"), "assets/arca-icon.svg");
    assert.equal(logo.getAttribute("alt"), "Arca");
    assert.ok(w.document.querySelector(".tray-heading.tray-tone-conflict"));
    assert.ok(
      w.document.querySelector('[data-folder="saved"] [data-lucide="folder"]'),
    );
    assert.ok(
      w.document.querySelector('[data-folder="saved"].tray-tone-disconnected'),
    );
    assert.equal(
      w.document.querySelector('[data-folder="saved"] small').textContent,
      "Disconnected",
    );
    assert.equal(
      w.document.querySelectorAll('.busy-grid, [data-lucide="circle-check"]')
        .length,
      0,
    );
  } finally {
    dom.window.close();
  }
});
