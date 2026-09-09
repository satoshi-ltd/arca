import { verifyPrivateURL } from "./network-policy.js";
import { fromByteArray, toByteArray } from "base64-js";
import { requireNativeModule } from "expo-modules-core";
export const native = requireNativeModule("ArcaNetwork");
export const resolvePrivateURL = (value) =>
  verifyPrivateURL(value, native, nativeFetch);

export async function nativeFetch(url, options = {}) {
  const body =
    options.body === undefined
      ? null
      : fromByteArray(
          typeof options.body === "string"
            ? new TextEncoder().encode(options.body)
            : new Uint8Array(options.body),
        );
  const result = await native.request(
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
    headers: { get: (key) => fields.get(key.toLowerCase()) || null },
    json: async () => JSON.parse(new TextDecoder().decode(data)),
    arrayBuffer: async () =>
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
}
