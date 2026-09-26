// Native directory pickers reject cancellation instead of returning a result.
export function isPickerCancelled(error) {
  return /\b(?:file|directory) picker (?:was )?cancelled by (?:the )?user\b/i.test(
    error?.message || "",
  );
}
export function sourceUnavailable(error) {
  if (isPickerCancelled(error)) return error;
  return Object.assign(
    new Error(
      "Could not read the selected files from the app that provides it. Download it on this phone and add it again.",
      { cause: error },
    ),
    { code: "SOURCE_UNAVAILABLE" },
  );
}
