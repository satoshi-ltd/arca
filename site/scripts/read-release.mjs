import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
const repo = process.env.GITHUB_REPOSITORY;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || ""))
  throw new Error("Repository is required");
const releases = JSON.parse(
  execFileSync("gh", ["api", `repos/${repo}/releases?per_page=100`], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }),
);
const release = releases
  .filter((r) => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
  .sort((a, b) =>
    b.tag_name
      .slice(1)
      .localeCompare(a.tag_name.slice(1), "en", { numeric: true }),
  )[0];
if (!release) throw new Error("No published Arca release");
for (const suffix of [
  "macos-arm64.dmg",
  "windows-x64.exe",
  "linux-x64.AppImage",
]) {
  if (
    !release.assets.some(
      (a) =>
        a.name === `arca-${release.tag_name.slice(1)}-${suffix}` && a.size > 0,
    )
  )
    throw new Error(`Missing desktop installer: ${suffix}`);
}
await writeFile("site/release.json", JSON.stringify(release, null, 2));
