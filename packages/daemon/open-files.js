import path from "node:path";

const held = new Map();
const key = (file) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file));

export function holdFile(file) {
  const name = key(file);
  held.set(name, (held.get(name) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = held.get(name) - 1;
    if (left > 0) held.set(name, left);
    else held.delete(name);
  };
}

export const fileHeld = (file) => held.has(key(file));

export async function holding(file, work) {
  const release = holdFile(file);
  try {
    return await work();
  } finally {
    release();
  }
}

export async function holdingProcess(file, start) {
  const release = holdFile(file);
  let running;
  try {
    running = start();
    const child = running.child;
    const exited =
      child?.pid && child.exitCode === null && child.signalCode === null
        ? new Promise((resolve) => child.once("exit", resolve))
        : null;
    try {
      return await running;
    } finally {
      if (exited) exited.then(release);
      else release();
    }
  } catch (error) {
    if (!running) release();
    throw error;
  }
}
