// Explicit user actions only. Missing gallery assets never enter this queue.
export class GalleryDeletions {
  constructor(replica) {
    this.r = replica;
  }
  key(volume, kind) {
    return `gallery-deletions:${this.r.scope}:${volume}:${kind}`;
  }
  async pending(volume) {
    return this.r.store.get(this.key(volume, "requests"), []);
  }
  async enqueue(volume, item) {
    const r = this.r;
    if (r.active || r.busy || r.importing || r.removing || r.picking)
      throw new Error("Wait for synchronization to finish.");
    r.importing = true;
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
      const requests = await this.pending(volume);
      for (const row of items)
        if (!requests.some((q) => q.path === row.path && q.rev === row.rev))
          requests.push({
            id: `photo_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`,
            volume,
            path: row.path,
            rev: row.rev,
          });
      await r.store.set(this.key(volume, "requests"), requests);
    } finally {
      r.importing = false;
    }
    r.changed();
  }
  async cancel(volume, id) {
    const r = this.r;
    if (r.active || r.busy || r.importing)
      throw new Error("Wait for synchronization to finish.");
    r.importing = true;
    try {
      await r.store.set(
        this.key(volume, "requests"),
        (await this.pending(volume)).filter((q) => q.id !== id),
      );
    } finally {
      r.importing = false;
      r.changed();
    }
  }
  async flush(volume) {
    const r = this.r;
    if (r.paused || !r.client.state().catalog?.galleryDeletion) return;
    const requests = await this.pending(volume);
    for (const request of [...requests]) {
      if (request.issue) continue;
      r.check();
      try {
        await r.client.api("/v1/gallery/delete", request);
        requests.splice(requests.indexOf(request), 1);
      } catch (error) {
        if (error.status === 409 || error.status === 404)
          request.issue = error.message;
        else throw error;
      } finally {
        await r.store.set(this.key(volume, "requests"), requests);
      }
    }
  }
  async setOriginals(volume, enabled) {
    const r = this.r;
    if (r.active || r.busy || r.importing)
      throw new Error("Wait for synchronization to finish.");
    if (enabled && !r.gallery.media?.canRemove?.())
      throw new Error(
        "Install the updated mobile app to review original removal.",
      );
    r.importing = true;
    try {
      const source = await r.store.gallery(r.scope, volume);
      if (source?.mode !== "source") throw new Error("Link an album first.");
      const page = enabled
        ? await r.interactiveClient.api("/v1/gallery/removals", { volume })
        : null;
      source.originalRemoval = enabled ? { after: page.head } : null;
      await r.store.setGallery(r.scope, volume, source);
      const records = await r.store.get(this.key(volume, "originals"), []);
      for (const event of records)
        if (event.state === "pending") event.state = "kept";
      await r.store.set(this.key(volume, "originals"), records);
    } finally {
      r.importing = false;
      r.changed();
    }
  }
  async reviews(volume) {
    return (await this.r.store.get(this.key(volume, "originals"), [])).filter(
      (e) => e.expires > Date.now(),
    );
  }
  async originals(volume) {
    const records = await this.r.store.get(this.key(volume, "originals"), []);
    return records.filter(
      (e) => e.state === "pending" && e.expires > Date.now(),
    );
  }
  async receive(volume) {
    const r = this.r;
    if (!r.client.state().catalog?.galleryDeletion) return;
    const source = await r.store.gallery(r.scope, volume);
    if (source?.mode !== "source") return;
    let after = await r.store.get(this.key(volume, "cursor"), 0);
    const page = await r.client.api("/v1/gallery/removals", { volume, after });
    const records = await r.store.get(this.key(volume, "originals"), []);
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
        if (
          event.expires > Date.now() &&
          !records.some((e) => e.seq === event.seq)
        )
          records.push({
            ...event,
            assetId: asset.id,
            name: asset.name,
            state:
              source.originalRemoval &&
              event.seq > source.originalRemoval.after &&
              event.eligible
                ? "pending"
                : "kept",
          });
      }
      after = event.seq;
    }
    // Persist work before acknowledging the event cursor.
    await r.store.set(
      this.key(volume, "originals"),
      records.filter((e) => e.expires > Date.now()),
    );
    await r.store.set(this.key(volume, "cursor"), after);
    if (page.next) r.moreGalleryWork = true;
  }
  async restore(volume, event) {
    const r = this.r;
    if (r.active || r.busy || r.importing)
      throw new Error("Wait for synchronization to finish.");
    r.importing = true;
    try {
      const result = await r.interactiveClient.api("/v1/gallery/restore", {
        volume,
        asset: event.asset,
      });
      const item = await r.store.galleryAsset(r.scope, volume, event.assetId);
      if (item) {
        for (const resource of item.resources || []) {
          const row = result.rows.find((row) => row.path === resource.path);
          if (row) {
            resource.hash = row.hash;
            resource.size = row.size;
            resource.rev = row.rev;
            resource.accepted = true;
          }
        }
        item.modificationTime = null;
        item.state = "accepted";
        item.registered = true;
        await r.store.putGalleryAsset(r.scope, volume, item);
      }
      await this.keep(volume, [event.seq], true);
    } finally {
      r.importing = false;
      r.changed();
    }
  }
  async keep(volume, seqs, reserved = false) {
    const r = this.r;
    if (r.active || r.busy || (r.importing && !reserved))
      throw new Error("Wait for synchronization to finish.");
    const alreadyReserved = r.importing;
    r.importing = true;
    try {
      const key = this.key(volume, "originals"),
        records = await this.r.store.get(key, []);
      for (const e of records) if (seqs.includes(e.seq)) e.state = "kept";
      await this.r.store.set(key, records);
    } finally {
      r.importing = alreadyReserved;
      r.changed();
    }
  }
  async removeOriginals(volume, seqs) {
    const r = this.r,
      media = r.gallery.media;
    if (
      r.active ||
      r.busy ||
      r.importing ||
      r.picking ||
      r.removing ||
      r.paused
    )
      throw new Error(
        "Finish synchronization and resume Arca before reviewing originals.",
      );
    if (!media?.foreground?.() || !media.canRemove?.())
      throw new Error("Open the updated Arca app to review originals.");
    r.importing = true;
    const outcomes = [];
    try {
      const source = await r.store.gallery(r.scope, volume);
      if (source?.mode !== "source" || !source.originalRemoval)
        throw new Error("Original removal is disabled on this phone.");
      const key = this.key(volume, "originals"),
        records = await r.store.get(key, []);
      const chosen = records.filter(
        (e) => e.state === "pending" && seqs.includes(e.seq),
      );
      if (!chosen.length || chosen.length > 20)
        throw new Error("Review between 1 and 20 originals at a time.");

      for (const event of chosen) {
        if (!media.foreground())
          throw new Error("Keep Arca open while reviewing originals.");
        const page = await r.interactiveClient.api("/v1/gallery/removals", {
          volume,
          after: event.seq - 1,
        });
        const current = page.events.find((e) => e.seq === event.seq);
        if (!current?.eligible) {
          event.state = "expired";
          outcomes.push({ name: event.name, kept: true });
          continue;
        }
        const asset = await r.store.galleryAsset(
          r.scope,
          volume,
          event.assetId,
        );
        const preview = await media.preview(event.assetId);
        if (
          !asset ||
          !preview.uri ||
          !Number.isFinite(asset.modificationTime) ||
          preview.modificationTime !== asset.modificationTime
        )
          throw new Error(
            `${event.name || "Photo"} changed or is unavailable. Its original was kept.`,
          );
        const stage = r.files.galleryStage(r.scope, volume);
        await r.files.clearGalleryStage(r.scope, volume);
        try {
          const exported = await media.exportForRemoval(event.assetId, stage);
          if (exported.length !== event.resources.length)
            throw new Error("The complete original could not be verified.");
          for (const resource of exported) {
            const expected = event.resources.find(
              (e) => e.key === resource.key,
            );
            if (
              !expected ||
              (await r.files.hash(resource.uri)) !== expected.hash
            )
              throw new Error(
                "This original changed after upload. It was kept.",
              );
          }
          await r.interactiveClient.api("/v1/gallery/removal-check", {
            volume,
            seq: event.seq,
          });
          if (!media.foreground())
            throw new Error("Keep Arca open while reviewing originals.");
          // One asset at a time limits partial OS outcomes; a Live Photo is one asset.
          const removed = await media.remove([event.assetId]);
          if (removed.includes(event.assetId)) event.state = "deleted";
          outcomes.push({ name: event.name, kept: event.state !== "deleted" });
          await r.store.set(key, records);
          if (event.state !== "deleted") break;
        } finally {
          await r.files.clearGalleryStage(r.scope, volume);
        }
      }
      await r.store.set(key, records);
      return outcomes;
    } finally {
      r.importing = false;
      r.changed();
    }
  }
}
