// Native directory pickers reject cancellation instead of returning a result.
export function isPickerCancelled(error) {
  return /\b(?:file|directory) picker (?:was )?cancelled by (?:the )?user\b/i.test(
    error?.message || "",
  );
}
