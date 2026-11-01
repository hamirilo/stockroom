import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  // A build with fewer features is set by STOCKROOM_ environment variables,
  // read by the Rust side too (docs/LIMITS.md, src/lib/limits.ts).
  envPrefix: ["VITE_", "STOCKROOM_"],

  // The app's own code and the libraries in separate files: one bundle went
  // past Vite's 500 kB warning (a CI warning on every build). Loading is from
  // disk, so this is about keeping the warning meaningful, not download size.
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "vendor", test: /[\\/]node_modules[\\/]/ }],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
