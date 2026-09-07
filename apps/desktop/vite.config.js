import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./src", import.meta.url)),
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1425,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
