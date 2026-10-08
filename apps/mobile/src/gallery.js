import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import ignore from "../../../packages/vendor/ignore/index.cjs";
import { builtinExcluded } from "../../../packages/core/builtin-exclusions.js";
import {
  gallerySettingsChanged,
  parseGallery,
  sourceAlbums,
  validPath,
  validRow,
} from "./validation.js";
import { isHubUnreachable } from "../../desktop/src/notice-contract.js";

const digest = (value) => bytesToHex(sha256(new TextEncoder().encode(value)));
export function galleryConfig(folder) {
  const config = parseGallery(folder?.gallery);
  return config?.mode !== "local" ? config : null;
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

export function recoveredPick(text) {
  try {
    const row = JSON.parse(text);
    if (!row || typeof row !== "object" || Array.isArray(row)) return {};
    return typeof row.name === "string" && row.name ? { name: row.name } : {};
  } catch {
    return {};
  }
}

const ascii = (bytes, from, to) =>
  String.fromCharCode(...bytes.slice(from, to));
export function pickedExtension(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return ".png";
  if (ascii(bytes, 0, 4) === "GIF8") return ".gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return ".webp";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return ".heic";
    if (brand === "avif") return ".avif";
    if (brand === "qt  ") return ".mov";
    return ".mp4";
  }
  return "";
}

// Album uploads supplement the ordinary shared-folder working copy.
// Removing an asset from Photos never proposes a shared deletion.
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
      throw Object.assign(
        new Error(
          "Allow photo library access in system settings to use Photo uploads.",
        ),
        { code: "PHOTO_PERMISSION" },
      );
    return permission;
  }
  async options(videos = false) {
    const permission = await this.permission(videos, true);
    return { permission, albums: await this.media.albums() };
  }
  async configure(volume, options, confirmed = false) {
    const r = this.r;
    if (!confirmed) throw new Error("Confirm enabling album uploads first.");
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
      let away = r.hubUnavailable;
      if (
        (await r.store.gallery(r.scope, volume))?.mode !== "source" &&
        !away
      )
        try {
          await r.client.refresh();
        } catch (error) {
          if (!isHubUnreachable(error) || !r.client.state().catalog) throw error;
          away = true;
        }
      const remote = r.client
        .state()
        .catalog?.volumes.find((v) => v.id === volume);
      if (!r.client.state().connection?.linked || !remote)
        throw new Error(
          "Connect to the hub and start syncing an existing shared folder.",
        );
      if (remote.policyError) throw new Error(remote.policyError);
      const folder = await r.store.folder(r.scope, volume);
      if (!folder?.selected)
        throw new Error("Start syncing this folder first.");
      const permission = await this.permission(!!options.videos);
      const albums = [
        ...new Map(
          (options.albums || []).map((album) => [album.id, album]),
        ).values(),
      ];
      if (albums.length) {
        const available = new Set((await this.media.albums()).map((a) => a.id));
        const missing = albums.filter((album) => !available.has(album.id));
        if (missing.length)
          throw new Error(
            missing.length === 1
              ? "This album is unavailable. Choose an accessible album."
              : "These albums are unavailable. Choose accessible albums.",
          );
      }
      const old = await r.store.gallery(r.scope, volume);
      const damaged = old?.mode === "damaged";
      if (
        old &&
        !damaged &&
        gallerySettingsChanged(
          old,
          albums.map((album) => album.id),
          !!options.videos,
        ) &&
        (await r.store.gallerySummary(r.scope, volume)).pending
      )
        throw new Error(
          "Finish pending uploads before changing the source, or remove this source and configure it again.",
        );
      const source = {
        ...old,
        // A lost record may have been mid-conversion: recover missing files before any scan.
        mode: damaged ? "converting" : "source",
        enabled: old?.mode === "source" ? old.enabled : true,
        albums,
        albumId: undefined,
        albumName: undefined,
        videos: !!options.videos,
        prefix:
          old?.prefix?.replace(/^Phone-/, "Machine-") ||
          `Machine-${digest(r.scope + ":" + r.client.state().connection.id).slice(0, 12)}`,
        cursors: {},
        after: undefined,
        scannedAt: null,
        issue: null,
        limited: permission.accessPrivileges === "limited",
      };
      if (!away && r.client.state().catalog?.gallery && !remote.gallery)
        await r.client.api("/v1/gallery/link", { volume });
      await r.store.setGallery(r.scope, volume, source);
      await r.store.retryGallery(r.scope, volume);
    } finally {
      r.importing = r.busy = false;
      r.changed();
    }
  }
  async journal(source, volume, asset) {
    const r = this.r;
    const id = asset.assetId || `picked-${await r.files.hash(asset.uri)}`;
    let item = await r.store.galleryAsset(r.scope, volume, id);
    if (item?.state === "accepted") return null;
    item ||= {
      id,
      name: asset.fileName || "photo.jpg",
      prefix: source.prefix,
      state: "pending",
    };
    if (!asset.assetId) {
      const stat = await r.files.stat(asset.uri);
      if (!stat || stat.directory)
        throw new Error(
          "The picked photo is no longer available. Pick it again.",
        );
      const durable = r.files.picked(r.scope, volume, id);
      const named = r.files.picked(r.scope, volume, `${id}-name`);
      const kept = await r.files.stat(durable);
      const before = (await r.files.stat(named))
        ? (await r.files.text(named).catch(() => "")).trim()
        : null;
      let copied = false;
      let renamed = false;
      try {
        if (!kept || kept.size !== stat.size) {
          await r.space(stat.size);
          await r.files.mkdir(r.files.parent(durable));
          copied = true;
          await r.files.copy(asset.uri, durable);
        }
        if (before !== item.name.trim()) {
          renamed = true;
          await r.files.remove(named);
          await r.files.write(named, new TextEncoder().encode(item.name));
        }
      } catch (error) {
        if (copied) await r.files.remove(durable).catch(() => {});
        if (renamed) {
          await r.files.remove(named).catch(() => {});
          if (before)
            await r.files
              .write(named, new TextEncoder().encode(before))
              .catch(() => {});
        }
        throw error;
      }
      item.picked = { name: item.name, key: "original" };
      delete item.lost;
    }
    item.manual = true;
    if (item.state === "unavailable") item.state = "pending";
    item.retryAt = 0;
    await r.store.putGalleryAsset(r.scope, volume, item);
    if (!asset.assetId) await r.files.discardPicked(asset.uri).catch(() => {});
    return item;
  }
  async addPhotos(volume, assets) {
    const r = this.r;
    await r.requireActiveReplica();
    if (r.active || r.busy || r.removing || r.importing)
      throw new Error("Wait for synchronization to finish.");
    if (r.paused) throw new Error("Resume syncing before adding photos.");
    r.importing = r.busy = true;
    r.stopped = false;
    const queued = [];
    try {
      r.check();
      const folder = await r.store.folder(r.scope, volume);
      const source = galleryConfig(folder);
      if (!source || source.mode !== "source")
        throw new Error("Photo uploads are unavailable for this folder.");
      // Journal the entire selection before transferring any photo. A failed
      // first transfer must not discard the remaining selections.
      let journalFailure;
      for (const asset of assets) {
        r.check();
        try {
          const item = await this.journal(source, volume, asset);
          if (item && !queued.some((previous) => previous.id === item.id))
            queued.push(item);
        } catch (error) {
          if (
            ["SYNC_INTERRUPTED", "SYNC_YIELD"].includes(error.code) ||
            r.syncAbort?.signal.aborted
          )
            throw error;
          journalFailure ||= error;
        }
      }
      if (journalFailure && !queued.length) throw journalFailure;
      if (r.hubUnavailable) {
        if (!queued.length) return;
        throw Object.assign(new Error("Hub unreachable"), { hubUnavailable: true });
      }
      await r.client.refresh();
      r.check();
      const policy = await this.policy(volume);
      let failure = journalFailure;
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
          if (error.code === "PICKED_LOST") item.lost = true;
          await r.store.putGalleryAsset(r.scope, volume, item);
          failure ||= error;
        }
      }
      if (failure) throw failure;
    } catch (error) {
      if (
        queued.length &&
        error &&
        typeof error === "object" &&
        (["SYNC_INTERRUPTED", "SYNC_YIELD"].includes(error.code) ||
          isHubUnreachable(error))
      )
        try {
          error.journaled = true;
        } catch {}
      throw error;
    } finally {
      try {
        const source = await r.store.gallery(r.scope, volume);
        if (source && source.mode !== "damaged") {
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
      // The change feed takes no lease; a new snapshot would replace this phone's paused first-download lease.
      let after = resource.base || 0,
        through;
      do {
        r.check();
        const query = new URLSearchParams({
          volume,
          after: String(after),
          ...(through ? { through: String(through) } : {}),
        });
        const page = await r.client.api(`/v1/changes?${query}`);
        through = page.through;
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
    }
    return false;
  }
  async register(folder, item) {
    const r = this.r;
    if (!r.client.state().catalog?.galleryDeletion) return false;
    if (
      item.picked ||
      item.id.startsWith("picked-") ||
      item.resources?.some((r) => r.path.includes(".conflict-"))
    ) {
      item.registered = true;
      await r.store.putGalleryAsset(r.scope, folder.id, item);
      return false;
    }
    item.group ||= digest(r.scope + ":" + item.id);
    const result = await r.client.api("/v1/gallery/register", {
      volume: folder.id,
      asset: item.group,
      resources: item.resources,
    });
    item.registered = !result.removed;
    if (result.removed) {
      item.state = "removed";
      item.issue = null;
    }
    await r.store.putGalleryAsset(r.scope, folder.id, item);
    return result.removed;
  }
  async gone(id, error = null) {
    if (/Photo is no longer accessible\. Check photo permissions\./.test(error?.message || ""))
      return true;
    if (!this.media.exists) return false;
    try {
      return !(await this.media.exists(id));
    } catch {
      return false;
    }
  }
  async releaseMissing(folder, source, item, error, permission) {
    if (error.code !== "SOURCE_UNAVAILABLE" || item.picked) return false;
    permission ||= await this.permission(source.videos).catch(() => null);
    if (
      !permission?.granted ||
      permission.accessPrivileges === "limited" ||
      !(await this.gone(item.id, error))
    )
      return false;
    await this.release(folder, item);
    return true;
  }
  async release(folder, item) {
    if (item.previousResources) {
      const fresh = new Map(
        (item.resources || [])
          .filter((resource) => resource.accepted)
          .map((resource) => [resource.key, resource]),
      );
      item.state = "accepted";
      item.resources = item.previousResources.map(
        (resource) => fresh.get(resource.key) || resource,
      );
      delete item.previousResources;
      delete item.modificationTime;
    } else item.state = "unavailable";
    item.issue = null;
    item.retryAt = 0;
    await this.r.store.putGalleryAsset(this.r.scope, folder.id, item);
  }
  async dropPicked(volume, item) {
    if (item.picked)
      for (const key of [item.id, `${item.id}-name`])
        await this.r.files
          .remove(this.r.files.picked(this.r.scope, volume, key))
          .catch(() => {});
    delete item.picked;
    delete item.lost;
  }
  async dismissLost(volume) {
    const r = this.r;
    await r.requireActiveReplica();
    if (r.importing || r.picking)
      throw new Error("Wait for synchronization to finish.");
    for (const item of await r.store.galleryLost(r.scope, volume)) {
      if (await r.files.stat(r.files.picked(r.scope, volume, item.id)))
        continue;
      await this.dropPicked(volume, item);
      item.state = "unavailable";
      item.issue = null;
      item.retryAt = 0;
      await r.store.putGalleryAsset(r.scope, volume, item);
    }
    const source = await r.store.gallery(r.scope, volume);
    if (source && source.mode !== "damaged") {
      source.summary = await r.store.gallerySummary(r.scope, volume);
      source.issue = source.summary.failed
        ? "Some photos could not be uploaded. Retry to continue."
        : null;
      await r.store.setGallery(r.scope, volume, source);
    }
    r.changed();
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
      if (await this.register(folder, item)) return;
      item.state = "accepted";
      if (item.previousResources) item.acceptedAt = Date.now();
      delete item.previousResources;
      await this.dropPicked(folder.id, item);
      item.issue = null;
      await save();
      return;
    }
    r.check();
    await r.space(0);
    const stage = r.files.galleryStage(r.scope, folder.id);
    await r.files.clearGalleryStage(r.scope, folder.id);
    try {
      r.check();
      const exported = item.picked
        ? [
            {
              ...item.picked,
              uri: r.files.picked(r.scope, folder.id, item.id),
            },
          ]
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
        if (!stat && item.picked)
          throw Object.assign(
            new Error(
              "The picked photo is no longer available. Pick it again or dismiss it.",
            ),
            { code: "PICKED_LOST" },
          );
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
              "The previous photo version could not be verified.",
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
      if (await this.register(folder, item)) return;
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
      await this.dropPicked(folder.id, item);
      item.issue = null;
      item.retryAt = 0;
      await save();
    } finally {
      // Temporary exports are separate from the synchronized working copy.
      await r.files.clearGalleryStage(r.scope, folder.id);
    }
  }
  async sendManual(folder, source) {
    const r = this.r;
    const manual = await r.store.galleryManual(
      r.scope,
      folder.id,
      Date.now(),
      24,
    );
    if (!manual.length) return;
    r.moreGalleryWork ||= manual.length === 24;
    const policy = await this.policy(folder.id);
    for (const item of manual) {
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
        if (await this.releaseMissing(folder, source, item, error)) continue;
        item.state = "failed";
        item.issue = error.message;
        item.retryAt = Date.now() + 60000;
        if (error.code === "PICKED_LOST") item.lost = true;
        await r.store.putGalleryAsset(r.scope, folder.id, item);
      }
    }
    source.summary = await r.store.gallerySummary(r.scope, folder.id);
    source.issue = source.summary.failed
      ? "Some photos could not be uploaded. Retry to continue."
      : null;
    await r.store.setGallery(r.scope, folder.id, source);
  }
  async cycle(folder) {
    const r = this.r;
    let source = await r.store.gallery(r.scope, folder.id);
    source.prefix = source.prefix.replace(/^Phone-/, "Machine-");
    for (const { id, row } of await r.store.corruptPicks(r.scope, folder.id)) {
      const kept = r.files.picked(r.scope, folder.id, id);
      if (await r.files.stat(kept)) {
        const named = r.files.picked(r.scope, folder.id, `${id}-name`);
        const savedName = (await r.files.stat(named))
          ? (await r.files.text(named).catch(() => "")).trim()
          : "";
        const name =
          savedName ||
          recoveredPick(row).name ||
          `photo${pickedExtension(await r.files.read(kept, 0, 16).catch(() => []))}`;
        await r.store.putGalleryAsset(r.scope, folder.id, {
          id,
          name,
          prefix: source.prefix,
          state: "pending",
          manual: true,
          picked: { name, key: "original" },
          retryAt: 0,
        });
      }
      await r.store.forgetCorruptPick(r.scope, folder.id, id);
    }
    await r.files.clearGalleryStage(r.scope, folder.id);
    const catalog = r.client.state().catalog;
    if (
      catalog?.gallery &&
      !catalog.volumes.find((v) => v.id === folder.id)?.gallery
    )
      await r.client.api("/v1/gallery/link", { volume: folder.id });
    if (catalog?.galleryDeletion) {
      const registration = await r.store.unregisteredGalleryAssets(
        r.scope,
        folder.id,
      );
      for (const item of registration) {
        r.check();
        try {
          await this.register(folder, item);
        } catch (error) {
          if (![400, 409].includes(error.status)) throw error;
          // Historical uploads may no longer have a verifiable current head.
          // Keep their originals and continue uploading other assets.
          item.registered = true;
          item.registrationIssue = error.message;
          await r.store.putGalleryAsset(r.scope, folder.id, item);
        }
      }
      r.moreGalleryWork ||= registration.length === 24;
      await r.galleryDeletions.receive(folder.id);
    }
    if (r.force) await r.store.retryGalleryManual(r.scope, folder.id);
    if (!source.enabled) {
      await this.sendManual(folder, source);
      return;
    }
    try {
      await this.sendManual(folder, source);
      const permission = await this.permission(source.videos);
      source.limited = permission.accessPrivileges === "limited";
      const selected = sourceAlbums(source);
      let targets = [null];
      let missingNotice = null;
      if (selected.length) {
        const available = new Set((await this.media.albums()).map((a) => a.id));
        const gone = selected.filter((album) => !available.has(album.id));
        if (gone.length === selected.length)
          throw Object.assign(
            new Error(
              selected.length === 1
                ? "The selected album is unavailable. Choose an accessible album in Photo uploads."
                : "The selected albums are unavailable. Choose accessible albums in Photo uploads.",
            ),
            { code: "SOURCE_UNAVAILABLE" },
          );
        targets = selected
          .filter((album) => available.has(album.id))
          .map((album) => album.id);
        if (gone.length)
          missingNotice = `${gone.map((album) => album.title || "An album").join(", ")} ${gone.length === 1 ? "is" : "are"} unavailable. Choose accessible albums in Photo uploads.`;
      }
      const cursorKey = (id) => id ?? "all";
      source.cursors = Object.fromEntries(
        Object.entries(source.cursors || {}).filter(([key]) =>
          targets.some((id) => cursorKey(id) === key),
        ),
      );
      const scanning = () => Object.keys(source.cursors).length > 0;
      const policy = await this.policy(folder.id);
      if (r.force) await r.store.retryGallery(r.scope, folder.id);
      // Persist the cursor only after the entire page is durable. A fresh pass
      // after completion catches moved/older photos and changing OS inventories.
      const scanDue =
        scanning() ||
        !source.scannedAt ||
        r.force ||
        Date.now() - Date.parse(source.scannedAt) >= 60000;
      for (let pageIndex = 0; scanDue && pageIndex < 4; pageIndex++) {
        r.check();
        const target = targets.find(
          (id) => source.cursors?.[cursorKey(id)] !== null,
        );
        if (target === undefined) {
          source.cursors = {};
          source.scannedAt = new Date().toISOString();
          await r.store.setGallery(r.scope, folder.id, source);
          break;
        }
        const cursor = source.cursors?.[cursorKey(target)] || null;
        let page;
        try {
          page = await this.media.page({
            ...source,
            albumId: target,
            after: cursor,
          });
        } catch (error) {
          source.cursors = {};
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
          } else if (known.state === "unavailable") {
            await r.store.putGalleryAsset(r.scope, folder.id, {
              ...known,
              modificationTime: asset.modificationTime,
              state: "pending",
              retryAt: 0,
              issue: null,
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
        if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor))
          throw new Error("The photo library returned an invalid page cursor.");
        source.cursors = {
          ...source.cursors,
          [cursorKey(target)]: page.hasNextPage ? page.endCursor : null,
        };
        const finished = targets.every(
          (id) => source.cursors[cursorKey(id)] === null,
        );
        if (finished) {
          source.cursors = {};
          source.scannedAt = new Date().toISOString();
        }
        await r.store.setGallery(r.scope, folder.id, source);
        if (finished) break;
      }
      let failure = null;
      let storageBlocked = false;
      const previousMoreWork = r.moreGalleryWork;
      r.moreGalleryWork ||= scanning();
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
          if (await this.releaseMissing(folder, source, item, error, permission))
            continue;
          item.state = "failed";
          item.issue = error.message;
          item.retryAt = Date.now() + 60000;
          if (error.code === "PICKED_LOST") item.lost = true;
          await r.store.putGalleryAsset(r.scope, folder.id, item);
          failure = `${item.name || "Photo"}: ${error.message}`;
          if (
            /not enough storage|no space left on device|\bENOSPC\b/i.test(
              error.message,
            )
          ) {
            storageBlocked = true;
            break;
          }
        }
      }
      source.summary = await r.store.gallerySummary(r.scope, folder.id);
      if (storageBlocked) r.moreGalleryWork = previousMoreWork;
      else
        r.moreGalleryWork ||= !!(
          await r.store.galleryWork(r.scope, folder.id, Date.now(), 1)
        ).length;
      const latest =
        !failure && source.summary.failed
          ? await r.store.galleryFailure(r.scope, folder.id)
          : null;
      source.issue =
        failure ||
        missingNotice ||
        (latest?.issue
          ? `${latest.name || "Photo"}: ${latest.issue}`
          : source.summary.failed
            ? "Some gallery items need attention. Retry to review the next error."
            : null);
      if (!scanning() && !source.summary.pending)
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
      // Album availability affects uploads from Photos, not the shared working copy.
      if (["SOURCE_UNAVAILABLE", "GALLERY_ITEMS_FAILED"].includes(error.code))
        return;
      throw error;
    } finally {
      r.changed();
    }
  }
}
