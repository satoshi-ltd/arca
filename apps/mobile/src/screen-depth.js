export const ONBOARDING_STEPS = ["welcome", "pair", "folders"];

export function screenDepth({ onboarding, step, detail, inFolder, musicLevel, videoRoute, directory }) {
  if (onboarding) return ONBOARDING_STEPS.indexOf(step);
  if (detail) return 100;
  if (!inFolder) return 0;
  if (musicLevel != null) return 1 + musicLevel;
  if (videoRoute) return videoRoute.length;
  return 1 + (directory ? directory.split("/").length : 0);
}

export const enterKind = (depth, last) => (depth > last ? "forward" : depth < last ? "back" : "fade");
