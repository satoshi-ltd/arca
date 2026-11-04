const REASONS = [
  [/not enough storage|no space left on device|\bENOSPC\b/i, "Not enough space on this phone"],
  [/no longer accessible/i, "No longer accessible in Photos"],
  [/Excluded by \.arcaignore/, "Excluded by this folder’s .arcaignore"],
  [/deleted on the hub/, "Deleted on the hub"],
  [/Original changed during a pending upload/, "The original changed in Photos"],
  [/original resource is unavailable|No original photo or video/, "The original is unavailable in Photos"],
  [/previous photo version could not be verified/, "The earlier version could not be verified"],
  [/has not confirmed/, "The hub has not confirmed it"],
  [/Unsupported gallery resource size/, "The file size is not supported"],
];
export const uploadReason = (issue) =>
  REASONS.find(([pattern]) => pattern.test(issue || ""))?.[1] || "The upload failed";
