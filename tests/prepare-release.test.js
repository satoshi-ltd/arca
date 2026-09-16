import test from "node:test";
import assert from "node:assert/strict";
import { prepareRelease } from "../scripts/prepare-release.js";

function fixture({ release, ref, error } = {}) {
  const created = [];
  const options = {
    repo: { owner: "example", repo: "arca" },
    tag: "v0.4.8",
    sha: "checkout-sha",
    github: {
      paginate: async () => {
        if (error) throw error;
        return release ? [release] : [];
      },
      rest: {
        repos: {
          listReleases() {},
          createRelease: async (value) => created.push(value),
        },
        git: {
          getRef: async () => {
            if (ref) return { data: { object: { sha: ref } } };
            throw Object.assign(new Error("Not found"), { status: 404 });
          },
        },
      },
    },
  };
  return { options, created };
}
const draft = {
  tag_name: "v0.4.8",
  draft: true,
  target_commitish: "checkout-sha",
};

test("publication creates a draft pinned to the checkout without publishing it", async () => {
  const { options, created } = fixture();
  assert.equal(await prepareRelease(options), true);
  assert.equal(created.length, 1);
  assert.equal(created[0].draft, true);
  assert.equal(created[0].prerelease, true);
  assert.equal(created[0].target_commitish, options.sha);
  assert.equal(created[0].tag_name, options.tag);
});

test("a published version skips builds without changing the release", async () => {
  const { options, created } = fixture({ release: { ...draft, draft: false } });
  assert.equal(await prepareRelease(options), false);
  assert.equal(created.length, 0);
});

test("a retry reuses the same checkout draft, including an existing matching tag", async () => {
  for (const ref of [undefined, "checkout-sha"]) {
    const { options, created } = fixture({ release: draft, ref });
    assert.equal(await prepareRelease(options), true);
    assert.equal(created.length, 0);
  }
});

test("a different checkout or an unrelated tag cannot overwrite release assets", async () => {
  for (const config of [
    { release: { ...draft, target_commitish: "other-sha" } },
    { ref: "checkout-sha" },
    { release: draft, ref: "other-sha" },
  ]) {
    const { options, created } = fixture(config);
    await assert.rejects(
      prepareRelease(options),
      /another commit|already exists/,
    );
    assert.equal(created.length, 0);
  }
});

test("GitHub lookup failures cannot be mistaken for an absent release or tag", async () => {
  const { options, created } = fixture({ error: new Error("API unavailable") });
  await assert.rejects(prepareRelease(options), /API unavailable/);
  options.github.paginate = async () => [];
  options.github.rest.git.getRef = async () => {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  };
  await assert.rejects(prepareRelease(options), /Forbidden/);
  assert.equal(created.length, 0);
});
