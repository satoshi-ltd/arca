import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = () => fs.readFileSync(new URL("../.github/workflows/publish-docker.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const release = (version, extra = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: true, published_at: "2026-10-17T00:00:00Z", ...extra });
const repo = { owner: "owner", repo: "repo" };
async function harness(version, releases, failure) {
  const text = workflow();
  const step = text.slice(text.indexOf("      - name: Promote latest only"), text.indexOf("\n  record:"));
  const marker = "          script: |\n";
  const script = step.slice(step.indexOf(marker) + marker.length).split("\n").map((line) => line.slice(12)).join("\n");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("github", "context", "core", "require", "process", script);
  let promotions = 0;
  const listReleases = () => {};
  const github = { rest: { repos: { listReleases } }, paginate: async (method, options) => {
    assert.equal(method, listReleases);
    assert.deepEqual(options, { ...repo, per_page: 100 });
    return typeof releases === "function" ? releases() : releases;
  } };
  const result = await run(github, { repo }, { notice() {} }, (name) => {
    assert.equal(name, "node:child_process");
    return { execFileSync: (...args) => {
      assert.deepEqual(args, ["docker", ["buildx", "imagetools", "create", "--tag", "satoshiltd/arca:latest", `satoshiltd/arca:${version}`], { stdio: "inherit" }]);
      if (failure) throw failure;
      promotions++;
    } };
  }, { env: { VERSION: version } });
  return { ...result, promotions };
}

test("Docker publishes its version before querying and promoting latest, under a serialized release group", () => {
  const text = workflow();
  const start = text.indexOf("      - name: Publish verified multiarch image");
  const promote = text.indexOf("      - name: Promote latest only for the newest published release");
  assert.ok(promote > start, "latest is decided after the image build and version publication");
  const build = text.slice(start, promote);
  assert.match(build, /tags: satoshiltd\/arca:\$\{\{ needs\.gate\.outputs\.version \}\}/);
  assert.doesNotMatch(build, /arca:latest/);
  assert.match(text, /group: arca-docker-\$\{\{ github\.event\.pull_request\.number \|\| 'release' \}\}\n  cancel-in-progress: false\n  queue: max/);
  const step = text.slice(promote, text.indexOf("\n  record:"));
  const promotionJob = text.slice(text.indexOf("\n  promote:"), text.indexOf("\n  record:"));
  assert.match(promotionJob, /needs: \[gate, docker\]/);
  assert.match(promotionJob, /needs\.gate\.outputs\.record == 'true'/, "an existing version image still retries promotion");
  assert.match(promotionJob, /needs\.gate\.outputs\.publish == 'true' && needs\.docker\.result == 'success'/);
  assert.match(promotionJob, /uses: docker\/login-action@v3/);
  assert.match(text, /needs: \[gate, docker, promote\]\n    if: always\(\) && needs\.promote\.result == 'success'/);
  assert.doesNotMatch(promotionJob, /actions\/checkout/, "promotion is independent of the version checkout and a failed promotion reruns alone");
  assert.doesNotMatch(step, /import\(/, "promotion also works when the released checkout predates this workflow");
  assert.match(step, /"docker", \["buildx", "imagetools", "create", "--tag", "satoshiltd\/arca:latest", `satoshiltd\/arca:\$\{version\}`\]/);
});

test("latest uses numeric versions across all published releases, including prereleases", async () => {
  const releases = Array.from({ length: 105 }, (_, index) => release(`0.1.${index}`));
  releases.push(release("0.7.9"), release("0.7.10"), release("9.0.0", { draft: true }), release("8.0.0", { published_at: null }), release("7.0.0-beta"));
  assert.deepEqual(await harness("0.7.10", releases), { promoted: true, newest: "0.7.10", promotions: 1 });
  assert.deepEqual(await harness("0.7.9", releases), { promoted: false, newest: "0.7.10", promotions: 0 });
});

test("delayed versions and forced reruns never move latest backwards", async () => {
  const releases = [release("1.0.0"), release("1.0.1")];
  assert.equal((await harness("1.0.1", releases)).promotions, 1);
  for (let retry = 0; retry < 3; retry++) assert.equal((await harness("1.0.0", releases)).promotions, 0);
  assert.equal((await harness("1.0.1", releases)).promotions, 1, "rerunning the newest release remains safe");
});

test("a newer release arriving during the build is observed by the publication-time query", async () => {
  const releases = [release("1.0.0")];
  let finishBuild;
  const build = new Promise((resolve) => { finishBuild = resolve; });
  const publish = async () => { await build; return harness("1.0.0", () => releases); };
  const older = publish();
  releases.push(release("1.0.1"));
  finishBuild();
  assert.equal((await older).promotions, 0);
});

test("an unpublished candidate never changes latest and API failures stop promotion", async () => {
  assert.equal((await harness("1.0.0", [])).promotions, 0);
  assert.equal((await harness("2.0.0", [release("1.0.0")])).promotions, 0);
  await assert.rejects(harness("1.0.0", () => { throw new Error("API unavailable"); }), /API unavailable/);
  await assert.rejects(harness("1.0.0; echo unsafe", []), /Invalid version/);
});

test("a failed retag command fails the workflow step instead of recording success", async () => {
  await assert.rejects(harness("1.0.0", [release("1.0.0")], new Error("registry unavailable")), /registry unavailable/);
});
