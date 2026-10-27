export const NOTIFICATIONS_DENIED = "NOTIFICATIONS_DENIED";

export const notificationsOn = (preference, granted) => !!preference && granted !== false;

export const settingsAction = (item, code) =>
  code === NOTIFICATIONS_DENIED ? { ...item, action: "settings", actionLabel: "Open settings" } : item;
