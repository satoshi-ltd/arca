// Seeds the store-review hub: three shared folders, generated photos, videos,
// documents and a few edits so History has revisions. Runs once, inside the
// Arca image on the review network: node /app/review/seed.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const config = JSON.parse(fs.readFileSync("/data/state/config.json", "utf8"));
const hub = process.env.ARCA_REVIEW_HUB || "http://arca-review:17831";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(route, body) {
  const response = await fetch(hub + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${config.adminToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${result.error}`);
  return result;
}

let random = 1;
const seeded = (seed) => {
  random = seed;
};
const rand = () => {
  random = (random * 1664525 + 1013904223) % 4294967296;
  return random / 4294967296;
};
const between = (low, high) => low + rand() * (high - low);

const palettes = {
  sunset: { sky: ["#2b1d4e", "#c8456c", "#f7a35c"], sun: "#ffd27a", hills: ["#6b3a5e", "#46284a", "#271a33"], water: "#8a3d63" },
  morning: { sky: ["#8ec5e8", "#cfe7f2", "#fbe9d0"], sun: "#fff4d6", hills: ["#9db7a6", "#6f927e", "#476a58"], water: "#7fb3cf" },
  night: { sky: ["#05070f", "#13203f", "#2c3f6b"], sun: "#f2f0e6", hills: ["#1c2a44", "#121c30", "#0a111e"], water: "#18294a", stars: true },
  forest: { sky: ["#a9d3e0", "#d8ecd9", "#eef4dc"], sun: "#fffbe6", hills: ["#6c9a6b", "#3f6e4a", "#21422c"], trees: true },
  beach: { sky: ["#4aa3df", "#8fd0f0", "#e8f6fb"], sun: "#fffdf0", hills: ["#e9d4a7", "#d9bc84", "#c49e62"], water: "#2a8fc4" },
  snow: { sky: ["#6f8fb8", "#b9cde3", "#eef3f8"], sun: "#ffffff", hills: ["#dfe8f1", "#b8c8d9", "#8ea3bb"], trees: true },
  desert: { sky: ["#f0a35e", "#f6c98b", "#fbe6c3"], sun: "#fff1d0", hills: ["#d98c56", "#b8693d", "#8a4a2a"] },
  dusk: { sky: ["#1d2b53", "#5b4a8a", "#e6879a"], sun: "#ffe0b3", hills: ["#3a3566", "#262347", "#15142b"], city: true },
};

function ridge(width, base, roughness) {
  let points = [base, base];
  for (let span = width; span > width / 64; span /= 2) {
    const next = [];
    for (let i = 0; i < points.length - 1; i++)
      next.push(points[i], (points[i] + points[i + 1]) / 2 + between(-1, 1) * roughness * span);
    next.push(points.at(-1));
    points = next;
  }
  return points.map((y, i) => `${((i / (points.length - 1)) * width).toFixed(1)},${y.toFixed(1)}`).join(" ");
}

function landscape(kind, width, height, seed) {
  seeded(seed);
  const p = palettes[kind];
  const horizon = height * between(0.55, 0.68);
  const sun = { x: width * between(0.2, 0.8), y: horizon * between(0.35, 0.8), r: width * between(0.04, 0.07) };
  const parts = [
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">` +
      p.sky.map((color, i) => `<stop offset="${i / (p.sky.length - 1)}" stop-color="${color}"/>`).join("") +
      `</linearGradient><radialGradient id="glow"><stop offset="0" stop-color="${p.sun}" stop-opacity="0.9"/><stop offset="1" stop-color="${p.sun}" stop-opacity="0"/></radialGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#sky)"/>`,
  ];
  if (p.stars)
    for (let i = 0; i < 160; i++)
      parts.push(`<circle cx="${between(0, width).toFixed(0)}" cy="${between(0, horizon).toFixed(0)}" r="${between(0.8, 2.6).toFixed(1)}" fill="#fff" opacity="${between(0.3, 0.9).toFixed(2)}"/>`);
  parts.push(`<circle cx="${sun.x}" cy="${sun.y}" r="${sun.r * 4}" fill="url(#glow)"/><circle cx="${sun.x}" cy="${sun.y}" r="${sun.r}" fill="${p.sun}"/>`);
  for (let i = 0; i < 5 && !p.stars; i++) {
    const x = between(0, width), y = between(height * 0.08, horizon * 0.6), w = between(120, 360);
    parts.push(`<g fill="#fff" opacity="${between(0.35, 0.7).toFixed(2)}"><ellipse cx="${x}" cy="${y}" rx="${w}" ry="${w * 0.22}"/><ellipse cx="${x + w * 0.4}" cy="${y - w * 0.12}" rx="${w * 0.5}" ry="${w * 0.2}"/></g>`);
  }
  p.hills.forEach((color, layer) => {
    const base = horizon - height * (0.18 - layer * 0.07);
    parts.push(`<polygon fill="${color}" points="0,${height} ${ridge(width, base, 0.35 - layer * 0.08)} ${width},${height}"/>`);
  });
  if (p.city) {
    let x = 0;
    while (x < width) {
      const w = between(50, 140), h = between(height * 0.08, height * 0.32);
      parts.push(`<rect x="${x}" y="${horizon - h}" width="${w}" height="${h + height}" fill="#0f0e20"/>`);
      for (let wy = horizon - h + 16; wy < horizon - 12; wy += 26)
        for (let wx = x + 10; wx < x + w - 14; wx += 22)
          if (rand() < 0.4) parts.push(`<rect x="${wx}" y="${wy}" width="10" height="14" fill="#ffd98a" opacity="0.85"/>`);
      x += w + between(4, 18);
    }
  }
  if (p.water) {
    parts.push(`<rect y="${horizon}" width="${width}" height="${height - horizon}" fill="${p.water}"/>`);
    for (let i = 0; i < 70; i++) {
      const y = between(horizon + 6, height), w = between(40, 260);
      parts.push(`<rect x="${between(0, width)}" y="${y}" width="${w}" height="${between(2, 5)}" fill="${i % 3 ? "#fff" : p.sun}" opacity="${between(0.08, 0.3).toFixed(2)}"/>`);
    }
  }
  if (p.trees)
    for (let i = 0; i < 40; i++) {
      const x = between(0, width), y = between(horizon + height * 0.05, height), s = between(30, 110) * (y / height);
      parts.push(`<polygon fill="${p.hills[2]}" points="${x},${y - s * 2.4} ${x - s * 0.7},${y} ${x + s * 0.7},${y}"/><rect x="${x - s * 0.08}" y="${y}" width="${s * 0.16}" height="${s * 0.35}" fill="#3b2a1e"/>`);
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

const albums = {
  "Camera roll": [
    ["IMG_20240316_081512", "morning"], ["IMG_20240427_193044", "sunset"], ["IMG_20240602_121901", "beach"],
    ["IMG_20240715_220318", "night"], ["IMG_20240823_102755", "forest"], ["IMG_20241005_175230", "dusk"],
    ["IMG_20241121_160402", "desert"], ["IMG_20241228_113617", "snow"],
  ],
  "Lisbon 2025": [
    ["IMG_20250612_093114", "morning"], ["IMG_20250612_134502", "beach"], ["IMG_20250612_204811", "sunset"],
    ["IMG_20250613_111930", "beach"], ["IMG_20250613_213355", "dusk"], ["IMG_20250614_074206", "morning"],
    ["IMG_20250614_192748", "sunset"], ["IMG_20250615_230105", "night"],
  ],
  "Mountains 2026": [
    ["IMG_20260212_085941", "snow"], ["IMG_20260212_152237", "snow"], ["IMG_20260213_071408", "morning"],
    ["IMG_20260213_174526", "sunset"], ["IMG_20260214_103017", "forest"], ["IMG_20260214_221844", "night"],
    ["IMG_20260215_120355", "snow"], ["IMG_20260215_165912", "dusk"],
  ],
  Home: [
    ["IMG_20260503_101220", "forest"], ["IMG_20260621_211533", "dusk"], ["IMG_20260718_140841", "beach"],
    ["IMG_20260809_063052", "morning"], ["IMG_20260911_190406", "sunset"], ["IMG_20260927_224718", "night"],
  ],
};
const videos = [
  ["Lisbon 2025/VID_20250613_201500.mp4", "2025-06-13T20:15:00Z", "gradients=s=960x540:speed=0.015:c0=0x2b1d4e:c1=0xc8456c:c2=0xf7a35c:c3=0x46284a:n=4:r=24"],
  ["Mountains 2026/VID_20260214_111000.mp4", "2026-02-14T11:10:00Z", "mandelbrot=s=960x540:r=24:maxiter=256:end_scale=0.05"],
];

const dateOf = (name) => {
  const [, y, mo, d, h, mi, s] = name.match(/_(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)/);
  return new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +s));
};

function pdf(title, paragraphs) {
  const escape = (text) => text.replace(/[\\()]/g, "\\$&");
  const lines = [];
  for (const paragraph of paragraphs) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if ((line + " " + word).trim().length > 88) {
        lines.push(line);
        line = word;
      } else line = (line + " " + word).trim();
    }
    lines.push(line, "");
  }
  const pages = [];
  for (let i = 0; i < lines.length; i += 40) pages.push(lines.slice(i, i + 40));
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"];
  const kids = [];
  pages.forEach((page, index) => {
    const head = index === 0 ? `BT /F2 20 Tf 72 740 Td (${escape(title)}) Tj ET\n` : "";
    const body = `BT /F1 11 Tf 72 ${index === 0 ? 706 : 740} Td 15 TL\n${page.map((line) => `(${escape(line)}) '`).join("\n")}\nET`;
    const stream = head + body;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function wav() {
  const rate = 22050;
  const notes = [392, 440, 494, 523, 587, 523, 494, 440, 392, 330, 349, 392];
  const step = 0.42;
  const samples = new Int16Array(Math.round(rate * step * notes.length));
  notes.forEach((frequency, n) => {
    const start = Math.round(n * step * rate);
    for (let i = 0; i < step * rate; i++) {
      const t = i / rate;
      const envelope = Math.min(1, t * 30) * Math.exp(-t * 4);
      samples[start + i] = Math.round(9000 * envelope * (Math.sin(2 * Math.PI * frequency * t) + 0.3 * Math.sin(4 * Math.PI * frequency * t)));
    }
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer)]);
}

const sensors = ["time,temperature_c,humidity_pct,co2_ppm"];
for (let h = 0; h < 48; h++) {
  const t = new Date(Date.UTC(2026, 8, 28, h)).toISOString();
  sensors.push(`${t},${(19 + 3 * Math.sin(h / 4)).toFixed(1)},${(48 + 8 * Math.cos(h / 5)).toFixed(0)},${Math.round(520 + 180 * Math.abs(Math.sin(h / 7)))}`);
}

const documents = {
  "README.md": `# Welcome to the Arca demo\n\nThis hub exists so you can try Arca without setting up your own server. Everything here is sample content.\n\n- **Photos** is a gallery: browse by month, open a photo, check its info, play a video.\n- **Documents** holds ordinary files: open them, share them, edit them on another device and watch the change arrive.\n- **Phone uploads** is empty. Link a photo album to it from the app to upload your own pictures.\n\nOpen a file's history to see earlier versions. *Work/Project plan.md* and *Personal/Shopping list.md* have several, and *Personal/Old notes.txt* was deleted and can be restored.\n`,
  "Work/Project plan.md": `# Garden studio project\n\n## Goals\n\n- Build a small studio at the end of the garden\n- Keep the budget under 18,000\n- Finish before the winter\n\n## Milestones\n\n1. Planning permission\n2. Foundations\n3. Frame and roof\n4. Windows and insulation\n5. Electrics and finish\n`,
  "Work/Budget 2026.csv": `category,planned,spent\nFoundations,3200,3050\nTimber frame,4800,4925\nRoofing,2100,1980\nWindows,2600,0\nInsulation,1400,0\nElectrics,1900,0\nFinishes,1500,0\nContingency,500,0\n`,
  "Work/Meeting notes 2026-09-30.txt": `Weekly sync, 30 September 2026\n\nPresent: Ana, Ben, Chloe\n\n- Frame is up; roofing starts Monday.\n- Window supplier confirmed delivery for 14 October.\n- Ben to get two quotes for the electrics.\n- Next meeting: 7 October.\n`,
  "Personal/Shopping list.md": `# Shopping list\n\n- [ ] Oat milk\n- [ ] Bread\n- [ ] Tomatoes\n- [ ] Coffee beans\n- [ ] Olive oil\n`,
  "Personal/Trip to Lisbon.md": `# Lisbon, June 2025\n\n## Day 1\nMorning walk through the old town, lunch by the river, sunset from a viewpoint.\n\n## Day 2\nTram ride to the west of the city, pastries, afternoon at the beach.\n\n## Day 3\nMuseum in the morning, market for lunch, last dinner near the water.\n`,
  "Personal/Books to read.txt": `Books to read\n\n- Something about the sea\n- A history of maps\n- The one my sister keeps recommending\n- A good cookbook for weeknights\n`,
  "Personal/Old notes.txt": `Old notes\n\nThese notes are no longer needed. This file is deleted after the demo is set up, so you can find it in History and restore it.\n`,
  "Recipes/Chickpea and spinach stew.md": `# Chickpea and spinach stew\n\nServes 4 · 35 minutes\n\n## Ingredients\n- 2 tins of chickpeas\n- 200 g spinach\n- 1 onion, 3 garlic cloves\n- 1 tin of chopped tomatoes\n- 1 tsp smoked paprika, 1 tsp cumin\n\n## Method\n1. Soften the onion and garlic in olive oil.\n2. Add the spices, then the tomatoes and chickpeas.\n3. Simmer for 20 minutes.\n4. Stir in the spinach until it wilts. Season and serve with bread.\n`,
  "Recipes/Banana bread.md": `# Banana bread\n\n- 3 ripe bananas\n- 75 g melted butter\n- 150 g sugar\n- 1 egg\n- 190 g flour, 1 tsp baking soda, a pinch of salt\n\nMash the bananas, mix in the rest, bake at 175 °C for 55 minutes.\n`,
  "Data/settings.json": JSON.stringify({ theme: "auto", units: "metric", backupHour: 3, devices: ["laptop", "phone", "tablet"] }, null, 2) + "\n",
  "Data/Sensors September.csv": sensors.join("\n") + "\n",
  "Drawings/Floor plan.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="#f7f5ef"/><g fill="none" stroke="#244d3e" stroke-width="6"><rect x="40" y="40" width="520" height="320"/><line x1="320" y1="40" x2="320" y2="240"/><line x1="40" y1="240" x2="420" y2="240"/></g><g font-family="sans-serif" font-size="22" fill="#244d3e"><text x="120" y="150">Studio</text><text x="400" y="150">Storage</text><text x="200" y="310">Terrace</text></g></svg>\n`,
  "Drawings/Logo sketch.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="90" fill="#244d3e"/><path d="M50 130 L100 50 L150 130 Z" fill="#f4f6f1"/><circle cx="100" cy="112" r="14" fill="#244d3e"/></svg>\n`,
};
const pdfs = {
  "Work/Quarterly report.pdf": pdf("Quarterly report, Q3 2026", [
    "Summary. The garden studio project is on schedule and slightly under budget. Foundations and the timber frame are complete, and roofing begins next week.",
    "Spending. Of the 18,000 budget, 9,955 has been spent so far. Timber cost 125 more than planned because of a price rise in August; roofing came in 120 under.",
    "Risks. Window delivery is the main risk to the timeline. The supplier has confirmed 14 October, which still leaves three weeks before the first frosts.",
    "Next quarter. Install the windows, insulate, finish the electrics and decorate. The studio should be in use by early December.",
  ]),
  "Manuals/Bike maintenance.pdf": pdf("Bike maintenance checklist", [
    "Every ride. Check tyre pressure, make sure both brakes stop the wheel firmly and listen for unusual noises.",
    "Every week. Wipe the chain and apply a few drops of lubricant, then wipe off the excess. Check that the quick releases or thru-axles are tight.",
    "Every month. Inspect the brake pads for wear, check the chain for stretch, and look over the tyres for cuts or embedded glass.",
    "Every year. Have the bearings, cables and housing checked, and replace the chain if it is worn. A well kept chain saves the cassette and chainrings.",
  ]),
};

async function main() {
  await api("/v1/network/lan", { enabled: true });
  const created = {};
  for (const name of ["Photos", "Documents", "Phone uploads"]) created[name] = await api("/v1/volumes", { name });
  await api("/v1/gallery/link", { volume: created.Photos.id });

  const photos = created.Photos.path;
  sharp.concurrency(1);
  let seed = 7;
  for (const [album, shots] of Object.entries(albums))
    for (const [name, kind] of shots) {
      const portrait = seed % 5 === 0;
      const [width, height] = portrait ? [1536, 2048] : [2048, 1536];
      const file = path.join(photos, album, `${name}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await sharp(Buffer.from(landscape(kind, width, height, seed++ * 7919))).jpeg({ quality: 84, mozjpeg: true }).toFile(file);
      fs.utimesSync(file, dateOf(name), dateOf(name));
    }
  for (const [name, created_at, source] of videos) {
    const file = path.join(photos, name);
    const run = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", source, "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", "-metadata", `creation_time=${created_at}`, "-y", file]);
    if (run.status !== 0) throw new Error(`ffmpeg ${name}: ${run.stderr}`);
    fs.utimesSync(file, new Date(created_at), new Date(created_at));
  }

  const docs = created.Documents.path;
  const write = (name, content) => {
    const file = path.join(docs, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  for (const [name, content] of Object.entries({ ...documents, ...pdfs })) write(name, content);
  write("Audio/Voice memo.wav", wav());
  fs.writeFileSync(path.join(created["Phone uploads"].path, "About this folder.md"), "# Phone uploads\n\nLink a photo album to this folder in the Arca app. Its photos upload here and every device that selects the folder gets a copy.\n");

  const expected = { Photos: 32, Documents: Object.keys(documents).length + Object.keys(pdfs).length + 1, "Phone uploads": 1 };
  const settled = async () => {
    let previous = "";
    for (let i = 0; i < 180; i++) {
      const { volumes } = await api("/v1/catalog");
      const counts = JSON.stringify(volumes.map((v) => v.files));
      if (counts === previous && volumes.every((v) => v.files >= (expected[v.name] ?? 0))) return;
      previous = counts;
      await sleep(2000);
    }
    throw new Error("The hub did not index the seed within six minutes");
  };
  await settled();
  // Two later edits and a deletion give History something to show.
  await sleep(3000);
  write("Work/Project plan.md", documents["Work/Project plan.md"].replace("1. Planning permission", "1. ~~Planning permission~~ (approved 2 September)").replace("2. Foundations", "2. ~~Foundations~~ (done)"));
  write("Personal/Shopping list.md", documents["Personal/Shopping list.md"].replace("- [ ] Bread", "- [x] Bread").replace("- [ ] Coffee beans", "- [x] Coffee beans"));
  await sleep(8000);
  write("Personal/Shopping list.md", documents["Personal/Shopping list.md"].replace("- [ ] Bread", "- [x] Bread").replace("- [ ] Coffee beans", "- [x] Coffee beans") + "- [ ] Lemons\n- [ ] Rice\n");
  fs.rmSync(path.join(docs, "Personal/Old notes.txt"));
  await sleep(8000);
  const { volumes } = await api("/v1/catalog");
  console.log(JSON.stringify(volumes.map(({ name, files, bytes, gallery }) => ({ name, files, bytes, gallery }))));
}

await main();
