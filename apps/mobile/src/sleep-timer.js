export const SLEEP_OFF = { mode: "off" };
export const SLEEP_OPTIONS = [
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "end", label: "End of episode" },
];

export function sleepOptions(podcast) {
  return SLEEP_OPTIONS.map((option) =>
    option.value === "end" && !podcast ? { ...option, label: "End of track" } : option,
  );
}

export function sleepFromState(state) {
  const sleep = state?.sleep;
  if (sleep?.mode === "duration" && Number.isFinite(sleep.endsAt))
    return { mode: "duration", value: sleep.value, endsAt: sleep.endsAt };
  if (sleep?.mode === "end") return { mode: "end", value: sleep.value };
  return SLEEP_OFF;
}

export function sameSleep(a, b) {
  return a.mode === b.mode && a.value === b.value && a.endsAt === b.endsAt;
}

export function sleepRemaining(timer, now) {
  return timer?.mode === "duration" ? Math.max(0, timer.endsAt - now) : null;
}

export function sleepClock(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function sleepLabel(timer, now, podcast = true) {
  if (timer?.mode === "duration") return sleepClock(sleepRemaining(timer, now));
  if (timer?.mode === "end") return podcast ? "End of episode" : "End of track";
  return "";
}
