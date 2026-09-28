// Explicit shared deletion and source re-upload suppression. Never changes Photos.
export class GalleryDeletions {
  constructor(replica) {
    this.r = replica;
  }
  key(volume, kind) {
    return `gallery-deletions:${this.r.scope}:${volume}:${kind}`;
  }
  async delete(volume, item) {
    const r = this.r;
    if (r.active || r.busy || r.importing || r.removing || r.picking)
      throw new Error("Wait for synchronization to finish.");
    r.importing = true;
    const rows = [];
    try {
      await r.requireActiveReplica();
      if (!r.client.state().catalog?.galleryDeletion)
        throw new Error("Update the hub to delete shared gallery photos.");
      const folder = (await r.store.folders(r.scope)).find(
        (f) => f.id === volume && f.selected,
      );
      if (!folder) throw new Error("Select this folder first.");
      const items = Array.isArray(item) ? item : [item];
      if (
        !items.length ||
        items.length > 100 ||
        items.some((row) => !Number.isSafeInteger(row.rev) || row.rev < 1)
      )
        throw new Error("Refresh the selected photos before deleting.");
      for (const row of items) {
        if (rows.some((removed) => removed.path === row.path)) continue;
        const result = await r.interactiveClient.api("/v1/gallery/delete", {
          id: `photo_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`,
          volume,
          path: row.path,
          rev: row.rev,
        });
        rows.push(...result.rows);
      }
      return rows;
    } catch (error) {
      error.deletedRows = rows;
      throw error;
    } finally {
      r.importing = false;
      r.changed();
    }
  }
  async receive(volume) {
    const r = this.r;
    if (!r.client.state().catalog?.galleryDeletion) return;
    const source = await r.store.gallery(r.scope, volume);
    if (source?.mode !== "source") return;
    let after = await r.store.get(this.key(volume, "cursor"), 0);
    const page = await r.client.api("/v1/gallery/removals", { volume, after });
    for (const event of page.events) {
      const asset = await r.store.galleryAssetByGroup(
        r.scope,
        volume,
        event.asset,
      );
      if (asset) {
        if (event.suppressed) asset.state = "removed";
        asset.issue = null;
        await r.store.putGalleryAsset(r.scope, volume, asset);
      }
      after = event.seq;
    }
    await r.store.set(this.key(volume, "cursor"), after);
    if (page.next) r.moreGalleryWork = true;
  }
}
