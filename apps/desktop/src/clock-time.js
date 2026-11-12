export const clockTime = (value) =>
  new Date(value).toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
export function pauseEnd(value, now = new Date()) {
  const end = new Date(value);
  return end.toDateString() === now.toDateString()
    ? clockTime(end)
    : `${end.toLocaleDateString("en", { weekday: "short" })} ${clockTime(end)}`;
}
