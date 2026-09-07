import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const source = readFileSync(
  new URL("../apps/desktop/src/app.js", import.meta.url),
  "utf8",
).split("const $ =")[0];
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("native zoom restores, bounds rapid shortcuts, resets and persists", async () => {
  const dom = new JSDOM("", {
    url: "http://localhost",
    runScripts: "outside-only",
  });
  const w = dom.window;
  const applied = [];
  w.localStorage.setItem("arca.ui.zoom", "1.2");
  w.__TAURI__ = {
    core: { invoke() {} },
    webview: {
      getCurrentWebview: () => ({
        setZoom: async (value) => applied.push(value),
      }),
    },
  };
  w.eval(source);
  const press = (key, options = {}) => {
    const event = new w.KeyboardEvent("keydown", {
      key,
      metaKey: true,
      cancelable: true,
      ...options,
    });
    w.dispatchEvent(event);
    return event.defaultPrevented;
  };
  await flush();
  assert.equal(applied.at(-1), 1.2);
  for (let i = 0; i < 20; i++) assert.equal(press("+"), true);
  await flush();
  assert.equal(applied.at(-1), 1.5);
  for (let i = 0; i < 20; i++) press("-", { metaKey: false, ctrlKey: true });
  await flush();
  assert.equal(applied.at(-1), 0.7);
  press("0");
  press("=", { shiftKey: true });
  await flush();
  assert.equal(applied.at(-1), 1.1);
  assert.equal(w.localStorage.getItem("arca.ui.zoom"), "1.1");
  assert.equal(press("+", { altKey: true }), false);
  assert.equal(press("-", { metaKey: false }), false);
  press("0");
  await flush();
  assert.equal(applied.at(-1), 1);
  dom.window.close();
});

test("web keeps browser shortcuts untouched", () => {
  const dom = new JSDOM("", {
    url: "http://localhost",
    runScripts: "outside-only",
  });
  dom.window.eval(source);
  const event = new dom.window.KeyboardEvent("keydown", {
    key: "+",
    ctrlKey: true,
    cancelable: true,
  });
  dom.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  dom.window.close();
});
