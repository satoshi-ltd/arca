import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import ignore from "../../../packages/vendor/ignore/index.cjs";
import { builtinExcluded } from "../../../packages/core/builtin-exclusions.js";
import { validPath, validRow } from "./validation.js";
import { isHubUnreachable } from "../../desktop/src/notice-contract.js";

const digest = (value) => bytesToHex(sha256(new TextEncoder().encode(value)));
export function galleryConfig(folder) {
  const config =
    typeof folder?.gallery === "string"
      ? JSON.parse(folder.gallery)
      : folder?.gallery;
  return config?.mode !== "local" ? config || null : null;
}
export function galleryPath(prefix, asset, resource) {
  const date = new Date(asset.creationTime ?? NaN);
  const month = Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 7).replace("-", "/")
    : "Undated";
  const original = (resource.name || "photo").normalize("NFC");
  const match = original.match(/\.([a-zA-Z0-9]{1,12})$/);
  const extension = match ? `.${match[1]}` : "";
  const stem =
    (match ? original.slice(0, -extension.length) : original)
      .replace(/[\\/<>:"|?*\x00-\x1f]/g, "_")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 60) || "photo";
  return validPath(
    `${prefix}/${month}/${stem.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i, "photo-$&")}-${digest(asset.id + ":" + resource.key).slice(0, 24)}${extension}`,
  );
}

// Gallery sources never enter Replica.scan/pull and never produce deletions.
export class Gallery {
  constructor(replica, media) {
    this.r = replica;
    this.media = media;
  }
  async permission(videos, request = false) {
    if (!this.media)
      throw new Error("Install the updated mobile app to use Photo uploads.");
    const permission = await this.media.permission(videos, request);
    if (!permission.granted && permission.accessPrivileges !== "limited")
      throw new Error(
        "Allow photo library access in system settings to use Photo uploads.",
      );
    return permission;
  }
  async options(videos = false) {
    const permission = await this.permission(videos, true);
    return { permission, albums: await this.media.albums() };
  }
  async configure(volume, options, confirmed = false) {
    const r = this.r;
    if (!confirmed)
      throw new Error(
        "Confirm replacing the Arca local copy with a gallery source first.",
      );
    await r.requireActiveReplica();
    if (r.importing || r.removing || r.picking || r.renaming)
      throw new Error("Wait for the current operation to finish.");
    r.importing = true;
    try {
      if (r.active) {
        r.stop();
        await r.active;
      }
      r.busy = true;
      r.stopped = false;
      r.check();
      if ((await r.store.gallery(r.scope, volume))?.mode !== "source")
        await r.client.refresh();
      const remote = r.client
        .state()
        .catalog?.volumes.find((v) => v.id === volume);
      if (!r.client.state().connection?.linked || !remote)
        throw new Error(
          "Connect to the hub and select an existing shared folder.",
        );
      if (remote.policyError) throw new Error(remote.policyError);
      const folder = await r.store.folder(r.scope, volume);
      if (!folder?.selected)
        throw new Error("Select and synchronize this folder first.");
      const pendingConversion = await r.store.gallery(r.scope, volume);
      if (pendingConversion?.mode === "converting") {
        await this.finishConversion(folder, pendingConversion);
        return;
      }
      const permission = await this.permission(!!options.videos);
      if (
        options.albumId &&
        !(await this.media.albums()).some((a) => a.id === options.albumId)
      )
        throw new Error(
          "This album is unavailable. Choose an accessible album.",
        );
      const old = await r.store.gallery(r.scope, volume);
      if (
        old &&
        (old.albumId !== (options.albumId || null) ||
          old.videos !== !!options.videos) &&
        (await r.store.gallerySummary(r.scope, volume)).pending
      )
        throw new Error(
          "Finish pending uploads before changing the source, or remove this source and configure it again.",
        );
      const source = {
        ...old,
        mode: "source",
        enabled: old?.mode === "source" ? old.enabled : true,
        albumId: options.albumId || null,
        albumName: options.albumName || "All accessible photos",
        videos: !!options.videos,
        prefix:
          old?.prefix?.replace(/^Phone-/, "Machine-") ||
          `Machine-${digest(r.scope + ":" + r.client.state().connection.id).slice(0, 12)}`,
        after: null,
        scannedAt: null,
        issue: null,
        limited: permission.accessPrivileges === "limited",
      };
      if (!galleryConfig(folder)) {
        if (!folder.completed || folder.issue)
          throw new Error(
            "Finish a successful folder sync before enabling Photo uploads.",
          );
        if (!(await r.files.exists(r.files.folder(r.scope, volume))))
          throw new Error(
            "The local folder is unavailable. Restore it before enabling Photo uploads.",
          );
        r.force = true;
        await r.syncIgnore(folder);
        await r.scan(folder);
        await r.push(folder);
        await r.pull(folder);
        await this.verifyLocal(folder);
        r.check();
        // Durable mode switch precedes removal: a crash cannot turn missing files into deletions.
        source.mode = "converting";
      }
      if (r.client.state().catalog?.gallery && !remote.gallery)
        await r.client.api("/v1/gallery/link", { volume });
      await r.store.setGallery(r.scope, volume, source);
      if (source.mode === "converting")
        await this.finishConversion(folder, source);
      await r.store.retryGallery(r.scope, volume);
    } finally {
      r.importing = r.busy = false;
      r.changed();
    }
  }
  async addPhotos(volume, assets) {
    const r = this.r;
    await r.requireActiveReplica();
    if (r.active || r.busy || r.removing || r.importing)
      throw new Error("Wait for synchronization to finish.");
    if (r.paused) throw new Error("Resume syncing before adding photos.");
    r.importing = r.busy = true;
    r.stopped = false;
    try {
      await r.client.refresh();
      r.check();
      const folder = await r.store.folder(r.scope, volume);
      const source = galleryConfig(folder);
      if (!source || source.mode !== "source")
        throw new Error("Photo uploads are unavailable for this folder.");
      const queued = [];
      // Journal the entire selection before transferring any photo. A failed
      // first transfer must not discard the remaining selections.
      for (const asset of assets) {
        r.check();
        const id = asset.assetId || `picked-${await r.files.hash(asset.uri)}`;
        let item = await r.store.galleryAsset(r.scope, volume, id);
        if (item?.state === "accepted") continue;
        item ||= {
          id,
          name: asset.fileName || "photo.jpg",
          prefix: source.prefix,
          state: "pending",
        };
        if (!asset.assetId)
          item.picked = { uri: asset.uri, name: item.name, key: "original" };
        item.retryAt = 0;
        await r.store.putGalleryAsset(r.scope, volume, item);
        if (!queued.some((previous) => previous.id === item.id))
          queued.push(item);
      }
      const policy = await this.policy(volume);
      let failure;
      for (const item of queued) {
        r.check();
        try {
          await this.send(folder, item, policy);
        } catch (error) {
          if (r.syncAbort?.signal.aborted) r.check();
          if (
            ["SYNC_INTERRUPTED", "SYNC_YIELD"].includes(error.code) ||
            isHubUnreachable(error)
          )
            throw error;
          item.state = "failed";
          item.issue = error.message;
          item.retryAt = Date.now() + 60000;
          await r.store.putGalleryAsset(r.scope, volume, item);
          failure ||= error;
        }
      }
      if (failure) throw failure;
    } finally {
      try {
        const source = await r.store.gallery(r.scope, volume);
        if (source) {
          source.summary = await r.store.gallerySummary(r.scope, volume);
          source.issue = source.summary.failed
            ? "Some photos could not be uploaded. Retry to continue."
            : null;
          await r.store.setGallery(r.scope, volume, source);
        }
      } finally {
        r.importing = r.busy = false;
        r.changed();
      }
    }
  }

  async verifyLocal(folder) {
    const r = this.r;
    if (
      (await r.store.pending(r.scope, folder.id)).length ||
      (await r.store.applying(r.scope, folder.id)).length
    )
      throw new Error(
        "Local changes are still pending. Sync before converting this folder.",
      );
    const root = r.files.folder(r.scope, folder.id);
    if (!(await r.files.exists(root))) return;
    // Inspect excluded files too: they must never disappear as incidental cleanup.
    for await (const entry of r.files.walk(root, "", true)) {
      r.check();
      const row = await r.store.current(r.scope, folder.id, entry.path);
      if (
        !row ||
        row.deleted ||
        !!row.directory !== !!entry.directory ||
        (!entry.directory && (await r.files.hash(entry.uri)) !== row.hash)
      )
        throw new Error(
          `Keep or export this local item before converting: ${entry.path}`,
        );
    }
  }
  async finishConversion(folder, source) {
    const r = this.r;
    await this.verifyLocal(folder);
    const hashes = new Set(
      (await r.store.rows(r.scope, folder.id)).map((row) => row.hash),
    );
    r.check();
    await r.files.removeFolder(r.scope, folder.id);
    await r.store.clearWorkingIndex(r.scope, folder.id);
    await r.cleanTransferObjects(r.scope, hashes);
    await r.store.setGallery(r.scope, folder.id, { ...source, mode: "source" });
    r.hashCache.clear();
  }
  async setEnabled(volume, enabled) {
    const r = this.r;
    await r.requireActiveReplica();
    if (r.importing || r.removing || r.picking)
      throw new Error("Wait for synchronization to finish.");
    r.importing = true;
    try {
      if (r.active) {
        r.stop();
        await r.active;
      }
      r.busy = true;
      const source = await r.store.gallery(r.scope, volume);
      if (!source || source.mode !== "source")
        throw new Error("Finish configuring this gallery source first.");
      await r.store.setGallery(r.scope, volume, {
        ...source,
        enabled: !!enabled,
        ...(enabled ? { scannedAt: null } : {}),
      });
    } finally {
      r.importing = r.busy = false;
      r.changed();
    }
  }

  async useLocalCopy(volume, confirmed = false) {
    const r = this.r;
    if (!confirmed)
      throw new Error("Confirm downloading a complete local copy first.");
    await r.requireActiveReplica();
    if (r.importing || r.removing || r.picking || r.renaming)
      throw new Error("Wait for the current operation to finish.");
    r.importing = true;
    try {
      if (r.active) {
        r.stop();
        await r.active;
      }
      r.busy = true;
      await r.client.refresh();
      const remote = r.client
        .state()
        .catalog?.volumes.find((v) => v.id === volume);
      const source = await r.store.gallery(r.scope, volume);
      if (
        !remote ||
        !r.client.state().connection?.linked ||
        source?.mode !== "source"
      )
        throw new Error(
          "Connect to the hub and finish configuring this source first.",
        );
      await r.space(remote.bytes * 2);
      await r.files.mkdir(r.files.folder(r.scope, volume));
      await r.store.resetCursor(r.scope, volume);
      await r.store.setGallery(r.scope, volume, {
        ...source,
        mode: "local",
        enabled: false,
      });
    } finally {
      r.importing = r.busy = false;
      r.changed();
    }
  }
  async policy(volume) {
    const r = this.r;
    const { versions } = await r.client.api(
      `/v1/history?volume=${volume}&path=.arcaignore&limit=1`,
    );
    const row = versions[0];
    if (!row || row.deleted) return ignore();
    validRow(row, volume);
    if (row.directory || row.size > 65536)
      throw new Error("Invalid gallery exclusion policy");
    const response = await r.client.raw(`/v1/blobs/${row.hash}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== row.size || bytesToHex(sha256(data)) !== row.hash)
      throw new Error("Gallery exclusion policy failed verification");
    return ignore().add(new TextDecoder().decode(data));
  }
  async acknowledged(volume, resource, recoverConflict = true) {
    const r = this.r;
    let before;
    // A lost response followed by remote deletion must not resurrect the photo.
    do {
      r.check();
      const query = new URLSearchParams({
        volume,
        path: resource.path,
        limit: "50",
        ...(before ? { before: String(before) } : {}),
      });
      const page = await r.client.api(`/v1/history?${query}`);
      const receipt = page.versions.find(
        (row) =>
          !row.deleted &&
          row.hash === resource.hash &&
          row.size === resource.size &&
          row.rev > (resource.base || 0),
      );
      if (receipt) {
        resource.rev = receipt.rev;
        return true;
      }
      before = page.next;
    } while (before);
    if (resource.attempted && recoverConflict) {
      let session, after;
      try {
        do {
          r.check();
          const query = new URLSearchParams({
            volume,
            limit: "250",
            ...(session ? { session, after } : {}),
          });
          const page = await r.client.api(`/v1/snapshot?${query}`);
          session = page.session;
          for (const row of page.files) {
            validRow(row, volume);
            if (
              row.path.startsWith(resource.path + ".conflict-") &&
              (await this.acknowledged(
                volume,
                { ...resource, path: row.path },
                false,
              ))
            ) {
              resource.path = row.path;
              return true;
            }
          }
          after = page.next;
        } while (after);
      } finally {
        if (session) r.releaseSnapshot(session);
      }
    }
    return false;
  }
  async send(folder, item, policy) {
    const r = this.r;
    const save = () => r.store.putGalleryAsset(r.scope, folder.id, item);
    // Receipt recovery happens before reacquiring originals, which may have been deleted.
    for (const resource of item.resources || []) {
      if (
        !resource.accepted &&
        (await this.acknowledged(folder.id, resource))
      ) {
        resource.accepted = true;
        await save();
      }
    }
    if (
      item.resources?.length &&
      item.resources.every((resource) => resource.accepted)
    ) {
      item.state = "accepted";
      if (item.previousResources) item.acceptedAt = Date.now();
      delete item.previousResources;
      delete item.picked;
      item.issue = null;
      await save();
      return;
    }
    await r.transfer.begin();
    r.check();
    await r.space(0);
    const stage = r.files.galleryStage(r.scope, folder.id);
    await r.files.clearGalleryStage(r.scope, folder.id);
    try {
      r.check();
      const exported = item.picked
        ? [item.picked]
        : await this.media.export(item.id, stage).catch((error) => {
            throw Object.assign(new Error(error.message, { cause: error }), {
              code: "SOURCE_UNAVAILABLE",
            });
          });
      if (!exported.length)
        throw new Error("No original photo or video resources are available.");
      const resources = [];
      for (const resource of exported) {
        r.check();
        const stat = await r.files.stat(resource.uri);
        if (!stat || stat.directory || stat.size > 100 * 1024 ** 3)
          throw new Error("Unsupported gallery resource size");
        const prepared = {
          key: resource.key,
          name: resource.name,
          path: galleryPath(item.prefix, item, resource),
          hash: await r.files.hash(resource.uri),
          size: stat.size,
          accepted: false,
        };
        const receipt =
          !item.previousResources &&
          (await r.store.galleryReceipt(
            r.scope,
            folder.id,
            prepared.hash,
            prepared.size,
            !item.picked,
          ));
        if (receipt) {
          prepared.path = receipt.path;
          prepared.accepted = true;
        }
        const prior = item.previousResources?.find(
          (old) => old.key === resource.key,
        );
        if (prior) {
          prepared.path = prior.path;
          const history = await r.client.api(
            `/v1/history?${new URLSearchParams({ volume: folder.id, path: prior.path, limit: "50" })}`,
          );
          if (history.versions[0]?.deleted)
            throw new Error(
              "This photo was deleted on the hub. Restore it there before uploading edits.",
            );
          if (!prior.rev && !(await this.acknowledged(folder.id, prior)))
            throw new Error(
              "The previous photo revision could not be verified.",
            );
          prepared.base = prior.rev;
          if (prior.hash === prepared.hash && prior.size === prepared.size) {
            prepared.accepted = true;
            prepared.rev = prior.rev;
          }
        }
        const previous = item.resources?.find(
          (old) => old.key === resource.key,
        );
        if (
          previous &&
          (previous.hash !== prepared.hash || previous.size !== prepared.size)
        )
          throw new Error(
            "Original changed during a pending upload. Restore the original in Photos and retry.",
          );
        resources.push({
          ...prepared,
          ...previous,
          ...(receipt ? { path: receipt.path, accepted: true } : {}),
        });
      }
      if (
        item.resources &&
        item.resources.some(
          (old) => !resources.some((next) => next.key === old.key),
        )
      )
        throw new Error(
          "An original resource is unavailable. Restore it in Photos and retry.",
        );
      item.resources = resources;
      item.state = "uploading";
      await save();
      for (const resource of resources) {
        r.check();
        if (resource.accepted) continue;
        if (builtinExcluded(resource.path) || policy.ignores(resource.path))
          throw new Error(`Excluded by .arcaignore: ${resource.path}`);
        const uri = exported.find((e) => e.key === resource.key).uri;
        await r.upload({ hash: resource.hash, size: resource.size }, uri, true);
        r.check();
        resource.attempted = true;
        await save();
        const result = await r.client.api("/v1/propose", {
          volume: folder.id,
          path: resource.path,
          base: resource.base || 0,
          hash: resource.hash,
          size: resource.size,
          ...(Number.isFinite(item.creationTime)
            ? { captured: new Date(item.creationTime).toISOString() }
            : {}),
        });
        if (result.conflictPath) {
          // Preserve the hub's concurrent file and track the accepted conflict copy.
          resource.path = validPath(result.conflictPath);
          await save();
        }
        if (!(await this.acknowledged(folder.id, resource)))
          throw new Error(
            "The hub has not confirmed this gallery resource. Retry synchronization.",
          );
        resource.accepted = true;
        await save();
      }
      item.state = "accepted";
      if (item.previousResources) item.acceptedAt = Date.now();
      delete item.previousResources;
      delete item.picked;
      item.issue = null;
      item.retryAt = 0;
      await save();
    } finally {
      // Only one asset is staged; never retain a second photo-library copy.
      await r.files.clearGalleryStage(r.scope, folder.id);
    }
  }
  async cycle(folder) {
    const r = this.r;
    let source = await r.store.gallery(r.scope, folder.id);
    source.prefix = source.prefix.replace(/^Phone-/, "Machine-");
    if (source.mode === "converting") {
      await this.finishConversion(folder, source);
      source = await r.store.gallery(r.scope, folder.id);
    }
    await r.files.clearGalleryStage(r.scope, folder.id);
    const catalog = r.client.state().catalog;
    if (
      catalog?.gallery &&
      !catalog.volumes.find((v) => v.id === folder.id)?.gallery
    )
      await r.client.api("/v1/gallery/link", { volume: folder.id });
    if (!source.enabled) return;
    try {
      const permission = await this.permission(source.videos);
      source.limited = permission.accessPrivileges === "limited";
      if (
        source.albumId &&
        !(await this.media.albums()).some((a) => a.id === source.albumId)
      )
        throw new Error(
          "The selected album is unavailable. Choose an accessible album in Photo uploads.",
        );
      const policy = await this.policy(folder.id);
      if (r.force) await r.store.retryGallery(r.scope, folder.id);
      // Persist the cursor only after the entire page is durable. A fresh pass
      // after completion catches moved/older photos and changing OS inventories.
      const scanDue =
        source.after ||
        !source.scannedAt ||
        r.force ||
        Date.now() - Date.parse(source.scannedAt) >= 60000;
      for (let pageIndex = 0; scanDue && pageIndex < 4; pageIndex++) {
        r.check();
        let page;
        try {
          page = await this.media.page(source);
        } catch (error) {
          source.after = null;
          throw error;
        }
        for (const asset of page.assets) {
          r.check();
          const known = await r.store.galleryAsset(
            r.scope,
            folder.id,
            asset.id,
          );
          if (!known) {
            await r.store.putGalleryAsset(r.scope, folder.id, {
              id: asset.id,
              creationTime: asset.creationTime,
              modificationTime: asset.modificationTime,
              name: asset.filename,
              prefix: source.prefix,
              state: "pending",
            });
          } else if (
            known.state === "accepted" &&
            Number.isFinite(asset.modificationTime) &&
            asset.modificationTime !== known.modificationTime
          ) {
            await r.store.putGalleryAsset(r.scope, folder.id, {
              ...known,
              modificationTime: asset.modificationTime,
              previousResources: known.resources,
              resources: undefined,
              state: "pending",
              retryAt: 0,
              issue: null,
            });
          }
        }
        if (
          page.hasNextPage &&
          (!page.endCursor || page.endCursor === source.after)
        )
          throw new Error("The photo library returned an invalid page cursor.");
        source.after = page.hasNextPage ? page.endCursor : null;
        if (!source.after) source.scannedAt = new Date().toISOString();
        await r.store.setGallery(r.scope, folder.id, source);
        if (!source.after) break;
      }
      let failure = null;
      r.moreGalleryWork ||= !!source.after;
      for (const item of await r.store.galleryWork(
        r.scope,
        folder.id,
        Date.now(),
      )) {
        r.check();
        try {
          await this.send(folder, item, policy);
        } catch (error) {
          if (r.syncAbort?.signal.aborted) r.check();
          if (
            ["SYNC_INTERRUPTED", "SYNC_YIELD"].includes(error.code) ||
            isHubUnreachable(error)
          )
            throw error;
          item.state = "failed";
          item.issue = error.message;
          item.retryAt = Date.now() + 60000;
          await r.store.putGalleryAsset(r.scope, folder.id, item);
          failure = `${item.name || "Photo"}: ${error.message}`;
        }
      }
      source.summary = await r.store.gallerySummary(r.scope, folder.id);
      r.moreGalleryWork ||= !!(
        await r.store.galleryWork(r.scope, folder.id, Date.now(), 1)
      ).length;
      source.issue =
        failure ||
        (source.summary.failed
          ? "Some gallery items need attention. Retry to review the next error."
          : null);
      if (!source.after && !source.summary.pending)
        source.completed = new Date().toISOString();
      await r.store.setGallery(r.scope, folder.id, source);
      if (source.issue)
        throw Object.assign(new Error(source.issue), {
          code: "GALLERY_ITEMS_FAILED",
        });
      await r.store.db.runAsync(
        "UPDATE folders SET issue=NULL WHERE scope=? AND id=?",
        r.scope,
        folder.id,
      );
    } catch (error) {
      source.issue =
        ["SYNC_INTERRUPTED", "SYNC_YIELD"].includes(error.code) ||
        isHubUnreachable(error)
          ? source.issue
          : error.message;
      source.summary = await r.store.gallerySummary(r.scope, folder.id);
      await r.store.setGallery(r.scope, folder.id, source);
      throw error;
    } finally {
      r.changed();
    }
  }
}
