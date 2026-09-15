// A disconnected pooled connection may fail before an HTTP response arrives.
// Replay only reads: a failed write may already have reached the hub.
export async function requestWithRecovery(request, url, method, headers, body) {
  const readable = method === "GET" || method === "HEAD";
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(url, method, headers, body);
    } catch (error) {
      const interrupted =
        /unexpected end of stream|connection reset|broken pipe/i.test(
          error?.message || "",
        );
      if (!interrupted) throw error;
      if (readable && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw new Error(
        "The connection to the hub was interrupted. Check the connection and try again.",
        { cause: error },
      );
    }
  }
}
