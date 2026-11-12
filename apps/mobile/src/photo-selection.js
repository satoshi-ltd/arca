export const SELECTION_LIMIT = 100;
export const SELECTION_LIMIT_REASON = `${SELECTION_LIMIT} is the most you can select at once.`;

export function toggleSelection(items, item) {
  if (items.some((photo) => photo.path === item.path))
    return { items: items.filter((photo) => photo.path !== item.path), full: false };
  if (items.length >= SELECTION_LIMIT) return { items, full: true };
  return { items: [...items, item], full: false };
}

export const selectionNote = ({ linked, full, reason }) =>
  !linked ? reason : full ? SELECTION_LIMIT_REASON : "";
