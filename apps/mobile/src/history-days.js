export function dayLabel(value, now = new Date()) {
  const day = new Date(value);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day.toDateString() === now.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
export const clockTime = (value) =>
  new Date(value).toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
