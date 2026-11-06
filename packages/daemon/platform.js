const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
export function reportedPlatform(env = process.env, platform = process.platform) {
  const name = env.ARCA_PLATFORM;
  return platform === "linux" && typeof name === "string" && NAME.test(name) ? name : platform;
}
