// Administrator calls for the store-review kit. The hub accepts its admin token only on its
// own loopback, so the kit pipes this script into the hub container and the token never
// leaves it:  docker exec -i arca-review node - code|list|remove < admin.cjs
const fs = require("node:fs");

const token = JSON.parse(fs.readFileSync("/data/state/config.json", "utf8")).adminToken;

async function call(route, body) {
  const response = await fetch(`http://127.0.0.1:17831${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${result.error}`);
  return result;
}

async function devices(remove) {
  const machines = (await call("/v1/machines")).machines.filter((machine) => !machine.isHub);
  for (const machine of machines) {
    if (remove) await call("/v1/revoke", { id: machine.credentialId });
    console.log(`${remove ? "removed " : ""}${machine.name} · last sync ${machine.lastSync || "never"} · ${machine.credentialId}`);
  }
  if (!machines.length) console.log("No paired devices");
}

const actions = {
  // The pairing page reads this JSON from its socket.
  code: async () => {
    const { code, expires } = await call("/v1/pairing", { name: "App Review" });
    process.stdout.write(JSON.stringify({ code, expires }));
  },
  list: () => devices(false),
  remove: () => devices(true),
};

const action = actions[process.argv[2]];
if (!action) {
  console.error("Usage: node - code|list|remove < admin.cjs");
  process.exit(1);
}
action().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
