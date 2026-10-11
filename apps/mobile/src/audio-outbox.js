import { isHubUnreachable } from "../../desktop/src/notice-contract.js";

export const permanentRefusal = (error) =>
  Number.isInteger(error?.status) &&
  error.status >= 400 &&
  error.status < 500 &&
  ![401, 408, 429].includes(error.status);

const hubStopped = (error) =>
  isHubUnreachable(error) || !Number.isInteger(error?.status) || [401, 408, 429].includes(error.status);

export async function drainOutbox({ scope, read, acknowledge, send }) {
  if (!scope) return [];
  const { entries } = await read(scope);
  const sent = [];
  const done = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      await send({
        volume: entry.volume,
        path: entry.path,
        hash: entry.hash,
        position: entry.position,
        duration: entry.duration,
        at: entry.at,
      });
      sent.push(entry);
    } catch (error) {
      if (hubStopped(error)) break;
      if (!permanentRefusal(error)) continue;
    }
    done.push({ volume: entry.volume, path: entry.path, at: entry.at });
  }
  if (done.length) await acknowledge(done);
  return sent;
}
