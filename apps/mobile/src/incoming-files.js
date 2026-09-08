import { validPath } from './replica.js';

export function incomingName(payload, index) {
  const name = (payload.originalName || `shared-file-${index + 1}`).normalize('NFC');
  // A sender supplies a filename, never a destination path.
  if (name.includes('/') || name.includes('\\')) throw new Error('The shared filename contains a path. Rename it in the source app.');
  return validPath(name);
}
export function incomingDestination(directory, name) {
  const prefix = directory.trim().normalize('NFC').replace(/\/$/, '');
  return validPath(prefix ? `${prefix}/${name}` : name);
}
export async function stageIncoming(r, payloads, id) {
  if (!payloads.length || payloads.length > 20) throw new Error('Share between 1 and 20 files at a time.');
  const previous = await r.store.get('incomingFiles', []);
  if (previous.length + payloads.length > 100) throw new Error('Save or discard pending shared files first.');
  const items = payloads.map((p, index) => {
    if (!['file', 'image', 'audio', 'video'].includes(p.shareType) || !/^(file:\/|content:\/\/)/.test(p.contentUri || ''))
      throw new Error('Share the exported file, rather than a link or text.');
    const key = `${id}-${index}`;
    return { id: key, name: incomingName(p, index), source: new URL(p.contentUri).href, expectedSize: p.contentSize, uri: r.files.incoming(key) };
  });
  if (new Set(items.map((item) => item.source)).size !== items.length)
    throw new Error('These shared files use the same temporary name. Share them one at a time.');
  const copied = [];
  try {
    for (const item of items) {
      const stat = await r.files.stat(item.source);
      if (!stat) throw new Error('The shared file is no longer available. Share it again.');
      if (Number.isFinite(item.expectedSize) && item.expectedSize >= 0 && stat.size !== item.expectedSize)
        throw new Error('The shared file is incomplete. Export and share it again.');
      await r.space(stat.size);
      await r.files.mkdir(r.files.parent(item.uri));
      copied.push(item.uri);
      await r.files.copy(item.source, item.uri);
      item.size = stat.size;
      delete item.source;
      delete item.expectedSize;
    }
    const next = [...previous, ...items];
    await r.store.set('incomingFiles', next);
    return next;
  } catch (error) {
    for (const uri of copied) await r.files.remove(uri);
    throw error;
  }
}
export async function forgetIncoming(r, item) {
  const items = await r.store.get('incomingFiles', []);
  const next = items.filter((i) => i.id !== item.id);
  await r.store.set('incomingFiles', next);
  await r.files.remove(item.uri);
  return next;
}
