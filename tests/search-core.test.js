import test from "node:test";
import assert from "node:assert/strict";
import { dateMatches, dateQuery, searchFold, searchRank, searchTokens } from "../packages/core/search.js";

test("search folds case and only combining accents, and needs every word", () => {
  assert.equal(searchFold("Björk Café"), "bjork cafe");
  assert.equal(searchFold("^·ー`"), "^·ー`");
  assert.equal(searchFold("́"), "");
  assert.deepEqual(searchTokens("  Site  PLAN "), { query: "site  plan", tokens: ["site", "plan"] });
  assert.deepEqual(searchTokens("́").tokens, [], "a query that folds to nothing has no words");
  assert.deepEqual(["plan.txt", "planet.md", "site-plan.pdf", "unplanned"].map((name) => searchRank(name, "plan")), [100, 80, 60, 60]);
});

test("an English month, month and year, year or ISO date is a date query until i18n", () => {
  assert.deepEqual(dateQuery("september 2025"), { prefix: "2025-09", label: "September 2025" });
  assert.deepEqual(dateQuery("2025 sep"), { prefix: "2025-09", label: "September 2025" });
  assert.deepEqual(dateQuery("sept"), { month: "09", label: "September" });
  assert.deepEqual(dateQuery("2025"), { prefix: "2025", label: "2025" });
  assert.deepEqual(dateQuery("2025-09"), { prefix: "2025-09", label: "September 2025" });
  assert.deepEqual(dateQuery("2025-09-14"), { prefix: "2025-09-14", label: "Sep 14, 2025" });
  for (const text of ["septiembre", "marl", "blue", "2025-13", "1850", "may blue"]) assert.equal(dateQuery(text), null, text);
  assert.equal(dateMatches("2025-09-14T10:00:00", dateQuery("september")), true);
  assert.equal(dateMatches("2024-09-14", dateQuery("september 2025")), false);
  assert.equal(dateMatches(null, dateQuery("2025")), false);
});
