export function historyEmpty({ offline, filter, hasFolder }) {
  if (offline)
    return {
      icon: "wifi-off",
      title: "No saved history",
      text: "Connect to the hub to load history.",
    };
  if (filter === "conflicts")
    return {
      icon: "conflict",
      title: "No conflicts",
      text: "Clear Conflicts to see every change.",
    };
  if (filter === "deleted")
    return {
      icon: "trash",
      title: "No deleted files",
      text: "Clear Deleted to see every change.",
    };
  if (hasFolder)
    return {
      icon: "history",
      title: "No changes in this folder",
      text: "Set Shared folder to All to see every change.",
    };
  return {
    icon: "history",
    title: "No history yet",
    text: "Changes to your files appear here.",
  };
}
