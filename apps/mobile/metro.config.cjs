const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const config = getDefaultConfig(__dirname);
config.watchFolders = [
  path.resolve(__dirname, "../desktop/src"),
  path.resolve(__dirname, "../../packages/vendor"),
  path.resolve(__dirname, "../../packages/core"),
];
module.exports = config;
