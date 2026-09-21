import test from "node:test";
import assert from "node:assert/strict";
import { requestWithRecovery } from "../apps/mobile/src/native-request.js";
const interrupted = () =>
  new Error(
    "Call to function 'ArcaNetwork.request' rejected: java.io.IOException: unexpected end of stream on com.android.okhttp.Address@123",
  );
test("interrupted reads retry once with the same request and return the response", async () => {
  for (const method of ["GET", "HEAD"]) {
    const calls = [];
    const response = { status: 200, body: "ok" };
    const result = await requestWithRecovery(
      async (...args) => {
        calls.push(args);
        if (calls.length === 1) throw interrupted();
        return response;
      },
      "http://192.168.1.2/file",
      method,
      { Authorization: "test-only" },
      null,
    );
    assert.equal(result, response);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  }
});
test("persistent disconnection is bounded and presents a readable error", async () => {
  let calls = 0;
  await assert.rejects(
    requestWithRecovery(
      async () => {
        calls++;
        throw interrupted();
      },
      "test",
      "GET",
      {},
      null,
    ),
    /The connection to the hub was interrupted/,
  );
  assert.equal(calls, 2);
});
test("writes are never replayed after an ambiguous transport failure", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    let calls = 0;
    await assert.rejects(
      requestWithRecovery(
        async () => {
          calls++;
          throw interrupted();
        },
        "test",
        method,
        {},
        "data",
      ),
      /connection to the hub was interrupted/,
    );
    assert.equal(calls, 1);
  }
});
test("HTTP failures and non-transport exceptions are not retried", async () => {
  const response = { status: 401 };
  assert.equal(
    await requestWithRecovery(async () => response, "test", "GET", {}, null),
    response,
  );
  const error = new Error("Request cancelled");
  let calls = 0;
  await assert.rejects(
    requestWithRecovery(
      async () => {
        calls++;
        throw error;
      },
      "test",
      "GET",
      {},
      null,
    ),
    (e) => e === error,
  );
  assert.equal(calls, 1);
});
test("stale Android network failures retry reads but never replay writes in JavaScript", async () => {
  const stale = () =>
    new Error(
      "Call to function 'ArcaNetwork.request' has been rejected.\n→ Caused by: java.net.SocketException: Binding socket to network 105 failed: EPERM (Operation not permitted)",
    );
  for (const method of ["GET", "HEAD"]) {
    let calls = 0;
    const result = await requestWithRecovery(
      async () => {
        if (++calls === 1) throw stale();
        return { status: 200 };
      },
      "http://192.168.1.2/v1/gallery/info",
      method,
      {},
      method === "POST" ? "e30=" : null,
    );
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(
    requestWithRecovery(
      async () => {
        calls++;
        throw stale();
      },
      "test",
      "POST",
      {},
      "e30=",
    ),
    /connection to the hub was interrupted/,
  );
  assert.equal(calls, 1);
});
