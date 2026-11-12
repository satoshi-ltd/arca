export const ANDROID_TOUCH = 48;

const reach = (size) => Math.max(0, Math.ceil((ANDROID_TOUCH - size) / 2));

export function touchSlop(platform, height, width = ANDROID_TOUCH, edges = {}) {
  if (platform !== "android") return undefined;
  const slop = { top: reach(height), bottom: reach(height), left: reach(width), right: reach(width), ...edges };
  return Object.values(slop).some(Boolean) ? slop : undefined;
}
