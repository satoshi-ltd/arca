import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) =>
  fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const tabs = [
  ["index.html", "System"],
  ["desktop.html", "Desktop"],
  ["mobile.html", "Mobile"],
  ["proposals.html", "Proposals"],
];
const taskTypes = new Set([
  "bug",
  "feature",
  "chore",
  "verify",
  "deploy",
  "decision",
  "ui",
]);

const roadmapTasks = (text) => {
  const pool = text.slice(text.search(/^## Queue/m));
  const headings = [...pool.matchAll(/^- \*\*([A-Z0-9][A-Z0-9-]*)\*\*/gm)];
  const tasks = headings.map((match, index) => {
    const body = pool.slice(
      match.index,
      headings[index + 1]?.index ?? pool.length,
    );
    return { id: match[1], type: body.match(/^ {2}`(\w+)/m)?.[1] };
  });
  return { tasks, raw: headings.length };
};

const proposalBoards = (html) => ({
  ids: [
    ...html.matchAll(/<article class="kit-board" data-board="([^"]+)"/g),
  ].map((match) => match[1]),
  raw: (html.match(/data-board=/g) || []).length,
  empty: html.includes('class="kit-empty"'),
});

const boardSources = (html) => {
  const starts = [
    ...html.matchAll(/<article class="kit-board" data-board="([^"]+)">/g),
  ];
  return starts.map((match, index) => ({
    id: match[1],
    body: html.slice(
      match.index,
      starts[index + 1]?.index ?? html.indexOf("</section>", match.index),
    ),
  }));
};

const taskBodies = (text) => {
  const pool = text.slice(text.search(/^## Queue/m));
  const headings = [...pool.matchAll(/^- \*\*([A-Z0-9][A-Z0-9-]*)\*\*/gm)];
  return new Map(
    headings.map((match, index) => [
      match[1],
      pool.slice(match.index, headings[index + 1]?.index ?? pool.length),
    ]),
  );
};

const missingBoards = (roadmap, html) => {
  const { ids } = proposalBoards(html);
  return roadmapTasks(roadmap)
    .tasks.filter((task) => task.type === "ui" && !ids.includes(task.id))
    .map((task) => task.id);
};

test("every design page carries the same tabs in the same order and marks only itself", () => {
  const expected = tabs.map(([, label]) => label);
  for (const [page, label] of tabs) {
    const html = read("design", page);
    const nav = html.match(/<nav aria-label="Design kit">([\s\S]*?)<\/nav>/);
    assert.ok(nav, `${page}: no design-kit nav`);
    const links = [
      ...nav[1].matchAll(/<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g),
    ];
    assert.deepEqual(
      links.map((link) => link[3]),
      expected,
      `${page}: tabs`,
    );
    assert.deepEqual(
      links.map((link) => link[1]),
      tabs.map(([file]) => file),
      `${page}: targets`,
    );
    const current = links.filter((link) => /aria-current="page"/.test(link[2]));
    assert.deepEqual(
      current.map((link) => link[3]),
      [label],
      `${page}: current tab`,
    );
  }
});

test("there is no Open work page or tab in the design kit", () => {
  assert.equal(
    fs.existsSync(path.join(root, "design", "open-work.html")),
    false,
  );
  for (const [page] of tabs)
    assert.doesNotMatch(read("design", page), />Open work</, page);
});

test("the Proposals page shows its boards, or says there are none", () => {
  const { ids, raw, empty } = proposalBoards(read("design", "proposals.html"));
  assert.equal(ids.length, raw, "every board marker is a parsed board");
  assert.equal(new Set(ids).size, ids.length, "board IDs are unique");
  assert.equal(
    empty,
    ids.length === 0,
    "the empty state shows exactly when there are no boards",
  );
  const boards = boardSources(read("design", "proposals.html"));
  assert.deepEqual(
    boards.map((board) => board.id),
    ids,
  );
  for (const board of boards) {
    assert.ok(board.body.includes("</article>"), `${board.id}: board is closed`);
    for (const part of [
      `<code>${board.id}</code>`,
      "<h3>",
      "<strong>Why.</strong>",
      "<figcaption>Now</figcaption>",
      "<figcaption>Proposed</figcaption>",
      "<strong>Accept</strong>",
    ])
      assert.ok(board.body.includes(part), `${board.id}: missing ${part}`);
    assert.ok(
      board.body.indexOf("<figcaption>Now</figcaption>") <
        board.body.indexOf("<figcaption>Proposed</figcaption>"),
      `${board.id}: Now comes before Proposed`,
    );
  }
});

test("a board never reuses the ID of a ROADMAP task that is not type ui, and a split task cites its board", () => {
  const roadmap = read("ROADMAP.md");
  const { tasks } = roadmapTasks(roadmap);
  const bodies = taskBodies(roadmap);
  const { ids } = proposalBoards(read("design", "proposals.html"));
  for (const id of ids) {
    const same = tasks.find((task) => task.id === id);
    assert.ok(!same || same.type === "ui", `${id}: a non-ui task has this ID`);
    const logic = tasks.find((task) => task.id === id.replace(/^UI-/, ""));
    if (logic)
      assert.match(
        bodies.get(logic.id),
        new RegExp(`the interface follows board ${id}\\b`, "i"),
        `${logic.id}: accept does not cite ${id}`,
      );
  }
  assert.doesNotMatch(roadmap, /DEC-INFO-NOTICE/);
});

test("board sources end at their own article even when a drawing holds nested articles", () => {
  const html = [
    '<article class="kit-board" data-board="UI-A"><article class="notice-card"></article><strong>Accept</strong></article>',
    '<article class="kit-board" data-board="UI-B"><strong>Accept</strong></article>',
  ].join("\n");
  const boards = boardSources(html);
  assert.deepEqual(
    boards.map((board) => board.id),
    ["UI-A", "UI-B"],
  );
  assert.ok(boards[0].body.includes("Accept"));
  assert.ok(!boards[0].body.includes('data-board="UI-B"'));
});

test("every ROADMAP ui task has a board on the Proposals page", () => {
  const roadmap = read("ROADMAP.md");
  const { tasks, raw } = roadmapTasks(roadmap);
  assert.ok(raw > 20, "the ROADMAP task pool was found");
  assert.equal(tasks.length, raw, "every task heading was parsed");
  for (const task of tasks)
    assert.ok(taskTypes.has(task.type), `${task.id}: type ${task.type}`);
  assert.deepEqual(
    missingBoards(roadmap, read("design", "proposals.html")),
    [],
  );
});

test("the ROADMAP and board parsers catch a missing board and a drifted marker", () => {
  const roadmap = [
    "## Queue",
    "",
    "- **UI-ONE** — Something visual",
    "  `ui · agent · normal`",
    "  accept: the board.",
    "- **FIX-ONE** — Something else",
    "  `bug · agent · normal`",
  ].join("\n");
  assert.deepEqual(roadmapTasks(roadmap).tasks, [
    { id: "UI-ONE", type: "ui" },
    { id: "FIX-ONE", type: "bug" },
  ]);
  const board = (id) =>
    `<article class="kit-board" data-board="${id}"><header><code>${id}</code></header></article>`;
  assert.deepEqual(missingBoards(roadmap, "<main></main>"), ["UI-ONE"]);
  assert.deepEqual(missingBoards(roadmap, board("UI-ONE")), []);
  assert.deepEqual(missingBoards(roadmap, board("OTHER")), ["UI-ONE"]);
  const drifted = `<article data-board="UI-ONE" class="kit-board"></article>`;
  const parsed = proposalBoards(drifted);
  assert.notEqual(parsed.ids.length, parsed.raw);
});
