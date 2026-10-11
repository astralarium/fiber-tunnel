/// <reference types="vitest/config" />
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    dts({
      tsconfigPath: "./tsconfig.app.json",
      exclude: ["**/*.test.*", "src/test-*", "src/react-reconciler.d.ts"],
      bundleTypes: true,
    }),
  ],
  build: {
    outDir: "dist",
    copyPublicDir: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) =>
        ["react", "react/jsx-runtime", "react/compiler-runtime"].includes(id),
      // Bundling strips source directives; RSC needs this module client-side.
      output: { banner: '"use client";' },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
