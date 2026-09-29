// A request during a walk runs it once more afterwards instead of starting a competing walk.
export function coalescedRun(jobs, key, run, settle = () => {}) {
  const running = jobs.get(key);
  if (running) {
    running.again = true;
    return running.done;
  }
  const job = { again: false };
  jobs.set(key, job);
  job.done = (async () => {
    try {
      let first = true;
      do {
        job.again = false;
        await run(first);
        first = false;
      } while (job.again);
    } finally {
      jobs.delete(key);
      settle();
    }
  })();
  return job.done;
}
