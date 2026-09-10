export async function selectFirstFolders(replica, catalog, ids) {
  const selected = [...new Set(ids)].map((id) =>
    catalog.volumes.find((v) => v.id === id),
  );
  if (
    !selected.length ||
    selected.some(
      (v) =>
        !v || v.policyError || !Number.isSafeInteger(v.bytes) || v.bytes < 0,
    )
  )
    throw new Error("Refresh the hub folders and choose available folders.");
  await replica.space(selected.reduce((sum, v) => sum + v.bytes * 2, 0));
  for (const volume of selected) await replica.select(volume);
  await replica.store.set("onboarding", null);
}
