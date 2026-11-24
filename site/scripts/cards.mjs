import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { readPages, text } from "./build.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const style = `
@font-face{font-family:Manrope;src:url("{{ASSETS}}/fonts/manrope.woff2");font-weight:200 800}
@font-face{font-family:"Geist Mono";src:url("{{ASSETS}}/fonts/geist-mono.woff2");font-weight:100 900}
html,body{margin:0}
body{width:1200px;height:630px;background:#0c100e;color:#e9eeeb;font-family:Manrope;position:relative;overflow:hidden}
.top{position:absolute;left:80px;right:80px;top:72px;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:18px;font-weight:700;font-size:36px;letter-spacing:-.03em}
.brand img{width:56px;height:56px}
.pills{display:flex;gap:12px}
.pills span{padding:9px 16px;border-radius:999px;background:#141917;box-shadow:0 0 0 1px #2a322e;font-weight:600;font-size:15px;color:#9ba6a0}
.eye{position:absolute;left:80px;top:190px;font:15px "Geist Mono";letter-spacing:.2em;text-transform:uppercase;color:#1ed760}
h1{position:absolute;left:78px;top:226px;width:1000px;margin:0;font-weight:700;line-height:1.04;letter-spacing:-.045em;text-wrap:balance}
h1 b{display:block;color:#1ed760;font-weight:700}
p{position:absolute;left:80px;bottom:70px;margin:0;width:800px;font-size:29px;line-height:38px;color:#9ba6a0}
.foot{position:absolute;left:80px;bottom:72px;font:15px "Geist Mono";letter-spacing:.12em;color:#9ba6a0}
i{position:absolute;border:1px solid #2a322e;border-radius:50%}
.a{width:620px;height:620px;right:-160px;bottom:-300px}
.b{width:460px;height:460px;right:-80px;bottom:-220px}`;
const size = (title) => (title.length <= 26 ? 92 : title.length <= 44 ? 78 : 66);

export function cardHtml({ eyebrow, title, accent = "", text = "", pills = [] }) {
  return `<!doctype html><meta charset="utf-8"><style>${style}\nh1{font-size:${size(title + accent)}px}</style><i class="a"></i><i class="b"></i>
<div class="top"><div class="brand"><img src="{{ASSETS}}/arca-icon.svg">arca</div><div class="pills">${pills.map((pill) => `<span>${escape(pill)}</span>`).join("")}</div></div>
<div class="eye">${escape(eyebrow)}</div>
<h1>${escape(title)}${accent ? `<b>${escape(accent)}</b>` : ""}</h1>
${text ? `<p>${escape(text)}</p>` : '<div class="foot">Free · Self-hosted · No account</div>'}`;
}
export function cards(pages) {
  const home = {
    file: "og-image.png",
    html: cardHtml({ eyebrow: "Free · Self-hosted · No account", title: "Your files.", accent: "Your devices.", text: "Folders, photos, music and movies on a hub you run, across your laptop, phone, tablet and TV.", pills: ["Files", "Photos", "Music", "Movies & TV"] }),
  };
  const rest = pages.map((page) => ({
    file: `card-${page.slug}.png`,
    html: cardHtml({ eyebrow: `Arca / ${page.group}`, title: text(/<h1>([^<]+)<\/h1>/.exec(page.body)[1]) }),
  }));
  return [home, ...rest].map((card) => ({ ...card, key: createHash("sha256").update(card.html).digest("hex").slice(0, 12) }));
}
export async function sitePages() {
  return readPages(path.join(root, "site/pages"), await readFile(path.join(root, "CHANGELOG.md"), "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = process.env.CHROME;
  if (!browser) throw new Error("Set CHROME to a Chrome, Chromium or chrome-headless-shell binary");
  const assets = pathToFileURL(path.join(root, "apps/desktop/src/assets")).href;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "arca-cards-"));
  const manifest = {};
  try {
    for (const card of cards(await sitePages())) {
      const source = path.join(scratch, "card.html");
      const target = path.join(root, "site/assets", card.file);
      await writeFile(source, card.html.replaceAll("{{ASSETS}}", assets));
      await rm(target, { force: true });
      execFileSync(browser, ["--headless", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1200,630", "--virtual-time-budget=3000", "--allow-file-access-from-files", `--screenshot=${target}`, pathToFileURL(source).href], { stdio: "ignore" });
      if (!(await stat(target).catch(() => null))?.size) throw new Error(`The browser drew no ${card.file}`);
      manifest[card.file] = card.key;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await writeFile(path.join(root, "site/cards.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Drew ${Object.keys(manifest).length} social cards`);
}
