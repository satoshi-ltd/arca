import { cancellationReason } from "./request-control.js";
import { requestWithRecovery } from "./native-request.js";
import {
  verifyPrivateURL,
  clearNetworkVerification,
} from "./network-policy.js";
import { fromByteArray, toByteArray } from "base64-js";
import { requireNativeModule } from "expo-modules-core";
export const native = requireNativeModule("ArcaNetwork");
export const resolvePrivateURL = (value) =>
  verifyPrivateURL(value, native, nativeFetch);

let requestSerial = 0;
export async function nativeFetch(url, options = {}) {
  const body =
    options.body === undefined
      ? null
      : fromByteArray(
          typeof options.body === "string"
            ? new TextEncoder().encode(options.body)
            : new Uint8Array(options.body),
        );
  const result = await requestWithRecovery(
    async (...args) => {
      if (options.signal?.aborted) throw cancellationReason(options.signal);
      if (typeof native.beginRequest !== "function")
        throw new Error("Update Arca to use the new synchronization engine.");
      const id = `${Date.now()}-${++requestSerial}`;
      native.beginRequest(id, url.startsWith("http:"));
      const cancel = () => native.cancelRequest(id);
      options.signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await native.request(...args, id, options.transfer || {});
      } catch (error) {
        clearNetworkVerification();
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", cancel);
      }
    },
    url,
    options.method || "GET",
    options.headers || {},
    body,
  );
  if (result.status >= 300 && result.status < 400)
    throw new Error("Hub redirects are not allowed. Use its direct address.");
  const data = toByteArray(result.body);
  const fields = new Map(
    Object.entries(result.headers).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    bytesWritten: result.bytesWritten,
    headers: { get: (key) => fields.get(key.toLowerCase()) || null },
    json: async () => JSON.parse(new TextDecoder().decode(data)),
    arrayBuffer: async () =>
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
}
