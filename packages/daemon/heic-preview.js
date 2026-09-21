import { Worker } from "node:worker_threads";

export const isHeic = (name) => /\.hei[cf]$/i.test(name);
export function heicPreview(file, large = false, dimensions = false) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./heic-preview-worker.js", import.meta.url),
      {
        workerData: { file, large },
        execArgv: [],
      },
    );
    const finish = (error, jpeg, width, height) => {
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      if (error) reject(error);
      else
        resolve(
          dimensions
            ? { bytes: Buffer.from(jpeg), width, height }
            : Buffer.from(jpeg),
        );
    };
    const timer = setTimeout(
      () => finish(new Error("HEIC preview timed out")),
      20000,
    );
    worker.once("message", ({ error, jpeg, width, height }) =>
      finish(error ? new Error(error) : null, jpeg, width, height),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", () =>
      finish(new Error("HEIC decoder stopped before producing a preview")),
    );
  });
}
