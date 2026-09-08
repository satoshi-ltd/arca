// Publish complete generation files before replacing the recovery manifest.
export async function writePortableBackup(files, scope, store, through) {
  const dir = files.backup(scope).replace(/\/$/, "");
  await files.mkdir(dir);
  const history = `revisions-${through}.ndjson`;
  const pending = `${dir}/.arca-history`;
  const manifest = `${dir}/.arca-manifest`;
  const encode = (value) => new TextEncoder().encode(value);
  try {
    await files.remove(pending);
    await files.write(pending, new Uint8Array());
    let after = 0,
      offset = 0;
    for (;;) {
      const page = await store.archiveRows(scope, after);
      if (!page.length) break;
      for (const row of page) {
        if (row.rev > through) break;
        const data = encode(JSON.stringify(row) + "\n");
        await files.write(pending, data, offset);
        offset += data.length;
      }
      after = page.at(-1).rev;
      if (after >= through) break;
    }
    await files.replace(pending, `${dir}/${history}`);
    await files.remove(manifest);
    await files.write(
      manifest,
      encode(
        JSON.stringify({
          format: "arca-portable-backup",
          version: 1,
          through,
          history,
          volumes: await store.get(`backupVolumes:${scope}`, []),
        }),
      ),
    );
    await files.replace(manifest, `${dir}/manifest.json`);
  } finally {
    await files.remove(pending);
    await files.remove(manifest);
  }
}
