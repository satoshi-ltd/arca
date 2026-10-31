import { count } from "./format.js";
export const downloadLabel = (chosen) =>
  chosen ? `Download ${count(chosen, "folder", "folders")}` : "Choose folders to download";
export const onlyVideoFolders = (catalog) => {
  const volumes = catalog?.volumes || [];
  return !!volumes.length && volumes.every((v) => v.video);
};
export async function selectFirstFolders(replica, catalog, ids, streams = () => false) {
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
  const kept = selected.filter((v) => !streams(v));
  await replica.space(kept.reduce((sum, v) => sum + v.bytes, 0));
  for (const volume of selected) await (streams(volume) ? replica.streamMusic(volume) : replica.select(volume));
  await replica.store.set("onboarding", null);
}
