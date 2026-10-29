// Per-path matching cost multiplies wildcards by rules by path depth, so these bounds keep a crafted 1,024-character path near 0.1 s.
export function validateIgnore(text) {
  let rules = 0,
    wildcards = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw || /^\s+$/.test(raw) || /(?:[^\\]|^)\\$/.test(raw) || raw.startsWith("#")) continue;
    const line = raw.replace(/^﻿/, "");
    if (++rules > 200) throw new Error(".arcaignore has more than 200 rules");
    if (line.length > 256)
      throw new Error(`.arcaignore line ${index + 1} is longer than 256 characters`);
    const pattern = line
      .replace(/(?<!\\)\s+$/, "")
      .replace(/\\./g, "x")
      .replace(/\/\*\*$/, "");
    const globstars = (pattern.match(/\*\*+/g) || []).length;
    const count = globstars + (pattern.replace(/\*\*+/g, "").match(/\*/g) || []).length;
    if (globstars > 1 || count > 2)
      throw new Error(
        `.arcaignore line ${index + 1} has too many wildcards: use at most two, with at most one ** before the end`,
      );
    if ((wildcards += count) > 64)
      throw new Error(".arcaignore has more than 64 wildcards in total");
  }
}
