export const defaultDeviceName = (platform) => {
  const model = platform.OS === "android" ? platform.constants?.Model : null;
  return typeof model === "string" && model.trim()
    ? model.trim().slice(0, 100)
    : platform.OS === "ios"
      ? "iPhone"
      : "Android";
};
