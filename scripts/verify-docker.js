import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const image = process.argv[2];
if (!image) throw new Error("Usage: node scripts/verify-docker.js IMAGE");
const name = `arca-smoke-${randomUUID()}`;
const volume = `${name}-data`;
function docker(args, check = true) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 90000,
  });
  if (check && (result.error || result.status !== 0))
    throw new Error(
      `Docker smoke failed: ${result.error?.message || result.stderr}`,
    );
  return result.stdout?.trim();
}
try {
  docker(["volume", "create", volume]);
  docker([
    "run",
    "--rm",
    "-v",
    `${volume}:/data`,
    image,
    "init",
    "--root",
    "/data/files",
    "--name",
    "release-smoke",
  ]);
  docker(["run", "-d", "--name", name, "-v", `${volume}:/data`, image]);
  const probe = `
    const fs = require('node:fs');
    const c = JSON.parse(fs.readFileSync('/data/state/config.json'));
    (async () => {
      let response;
      for (let n = 0; n < 30; n++) {
        try { response = await fetch('http://127.0.0.1:47831/v1/status', {headers:{Authorization:'Bearer '+c.adminToken}}); if (response.ok) break; } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      if (!response?.ok || (await response.json()).role !== 'hub') throw Error('Hub startup failed');
      if (!(await fetch('http://127.0.0.1:47831/')).ok) throw Error('Server web missing');
      const marker = '/data/files/smoke-id';
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') !== c.id) throw Error('Identity changed');
      fs.writeFileSync(marker, c.id);
    })().catch(() => { console.error('Container API/persistence check failed'); process.exitCode=1; });`;
  docker(["exec", name, "node", "-e", probe]);
  docker(["stop", "-t", "30", name]);
  if (docker(["inspect", "--format", "{{.State.ExitCode}}", name]) !== "0")
    throw new Error("Container did not stop cleanly");
  docker(["start", name]);
  docker(["exec", name, "node", "-e", probe]);
  console.log("Docker hub API, web, restart and persistent identity/files: OK");
} finally {
  docker(["rm", "-f", name], false);
  docker(["volume", "rm", volume], false);
}
