import test from "node:test";
import assert from "node:assert/strict";
import {
  isPickerCancelled,
  sourceUnavailable,
} from "../apps/mobile/src/action-errors.js";
import {
  errorNotice,
  isHubUnreachable,
} from "../apps/desktop/src/notice-contract.js";

test("native picker cancellation is a normal exit, including wrapped Expo errors", () => {
  assert.equal(
    isPickerCancelled(
      new Error(
        "Call to function 'FileSystem.pickDirectoryAsync' has been rejected.\n→ Caused by: The file picker was cancelled by the user",
      ),
    ),
    true,
  );
  assert.equal(
    isPickerCancelled(
      new Error("The directory picker was cancelled by the user"),
    ),
    true,
  );
});

test("real export and filesystem failures are never suppressed as cancellation", () => {
  for (const message of [
    "Permission denied",
    "Export was cancelled because disk is full",
    "Network request failed",
    "File does not exist",
  ]) {
    assert.equal(isPickerCancelled(new Error(message)), false);
  }
  assert.equal(isPickerCancelled(null), false);
});

test("provider failures during a pick are local source errors, never a hub outage", () => {
  const cause = new Error(
    "java.net.SocketTimeoutException: timeout while reading content://provider/doc",
  );
  const error = sourceUnavailable(cause);
  assert.equal(error.code, "SOURCE_UNAVAILABLE");
  assert.equal(error.cause, cause);
  assert.match(error.message, /from the app that provides it/);
  assert.equal(isHubUnreachable(error), false);
  assert.equal(errorNotice(error).cause, "");
  const cancelled = new Error("The file picker was cancelled by the user");
  assert.equal(sourceUnavailable(cancelled), cancelled);
});
