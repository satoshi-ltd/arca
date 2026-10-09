export const SLEEP_OFF = { mode: "off" };
export const SLEEP_OPTIONS = [
  { value: "30", label: "30 minutes", ms: 30 * 60000 },
  { value: "60", label: "1 hour", ms: 60 * 60000 },
  { value: "end", label: "End of episode" },
];

export function sleepOptions(podcast) {
  return SLEEP_OPTIONS.map((option) =>
    option.value === "end" && !podcast ? { ...option, label: "End of track" } : option,
  );
}

export function startSleep(value, now, track) {
  const option = SLEEP_OPTIONS.find((item) => item.value === value);
  if (!option) return SLEEP_OFF;
  if (option.value === "end")
    return track ? { mode: "end", value, track, at: now } : SLEEP_OFF;
  return { mode: "duration", value, endsAt: now + option.ms, at: now };
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

export function sleepCheck(timer, now, player) {
  if (!timer || timer.mode === "off") return null;
  if (timer.mode === "duration") return now >= timer.endsAt ? "due" : null;
  if (!player) return null;
  if (player.ended) return "due";
  if (player.track && player.track !== timer.track) return timer.near ? "due" : "cancel";
  const remaining = player.duration > 0 ? player.duration - player.position : Infinity;
  if (remaining <= 1500) return "due";
  return remaining <= 4000 ? "near" : null;
}
