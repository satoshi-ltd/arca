import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { reportedPlatform } from "../packages/daemon/platform.js";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const desktop = read("apps/desktop/src/app.js");

test("the Docker image names itself Server, and the daemon reports it", () => {
  const environment = /^ENV (.+)$/m.exec(read("deploy/Dockerfile"))[1].split(" ");
  assert.ok(environment.includes("ARCA_PLATFORM=Server"));
  assert.equal(reportedPlatform({ ARCA_PLATFORM: "Server" }, "linux"), "Server");
});
test("a device list tells a server, a computer, a phone and a television apart", () => {
  const source = /const deviceGlyph = [\s\S]*?;\n/.exec(desktop)[0];
  const deviceGlyph = vm.runInNewContext(`${source}deviceGlyph`);
  for (const [role, platform, glyph] of [
    ["hub", "linux", "server"],
    ["hub", "darwin", "server"],
    ["player", "android", "tv"],
    ["replica", "Server", "server"],
    ["", "Server", "server"],
    ["replica", "linux", "monitor"],
    ["replica", "darwin", "monitor"],
    ["replica", "win32", "monitor"],
    ["replica", "arcaOS", "monitor"],
    ["replica", "android", "smartphone"],
    ["replica", "ios", "smartphone"],
    ["", "iOS", "smartphone"],
    ["", "iPadOS", "smartphone"],
    ["replica", "Raspios", "monitor"],
    ["replica", "Helios", "monitor"],
    ["replica", "", "monitor"],
    ["replica", "Home server", "monitor"],
  ])
    assert.equal(deviceGlyph(role, platform), glyph, `${role || "discovered"} on ${platform || "an unreported platform"}`);
  assert.match(desktop, /\$\{icon\(role !== "hub" && role !== "player" && self \? managedGlyph\(\) : deviceGlyph\(role, platform\)\)\}/, "the devices list");
  assert.match(desktop, /deviceGlyph\(p\.arca\.role, p\.arca\.platform \|\| p\.os \|\| ""\),\n\s+\),/, "detected devices decide from the role and platform they announce, never from the text line");
  assert.doesNotMatch(desktop, /deviceGlyph\([^)]*metadata/);
  assert.match(desktop, /\$\{icon\(deviceGlyph\(m\.isHub \? "hub" : "", m\.platform\)\)\}/, "a file's copies");
  assert.equal((desktop.match(/\? "smartphone" : "monitor"/g) || []).length, 0, "no list decides the icon on its own");
});
test("the phone draws a server with the hub's icon, in every list", async () => {
  const { deviceIcon, platformName } = await import("../apps/mobile/src/device-line.js");
  for (const [device, glyph] of [
    [{ hub: true, platform: "linux" }, "server"],
    [{ platform: "Server" }, "server"],
    [{ player: true, platform: "android" }, "tv"],
    [{ platform: "android" }, "phone"],
    [{ platform: "ios" }, "phone"],
    [{ platform: "darwin" }, "monitor"],
    [{ platform: "linux" }, "monitor"],
    [{ platform: "Helios" }, "monitor"],
    [{}, "monitor"],
  ])
    assert.equal(deviceIcon(device), glyph, JSON.stringify(device));
  assert.equal(platformName("Server"), "Server", "and shows the name as written");
  const screens = fs.readdirSync(new URL("../apps/mobile/src", import.meta.url)).filter((name) => /\.jsx$/.test(name)).map((name) => read(`apps/mobile/src/${name}`)).join("\n");
  assert.equal((screens.match(/deviceIcon\(\{/g) || []).length, 2, "the devices list and a folder's copies");
  assert.doesNotMatch(screens, /\? "phone"\s*: "monitor"/, "no list decides the icon on its own");
});
test("the danger card keeps one outline", () => {
  assert.match(read("apps/desktop/src/style.css"), /\.settings-card\.replica-danger \{\n  border-color: var\(--er\);\n  box-shadow: none;\n\}/);
});
