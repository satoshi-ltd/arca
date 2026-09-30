import fs from 'node:fs';
import path from 'node:path';

export function keepLatest(apk) {
  const directory = path.dirname(apk);
  const dev = apk.endsWith('-dev.apk');
  const app = `${path.basename(apk).split('-')[0]}-`;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    if (
      entry.isFile() &&
      entry.name.startsWith(app) &&
      /-android(-dev)?\.apk$/.test(entry.name) &&
      entry.name.endsWith('-dev.apk') === dev &&
      entry.name !== path.basename(apk)
    )
      fs.rmSync(path.join(directory, entry.name));
}
