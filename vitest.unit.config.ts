import { defineConfig } from "vitest/config"
import tsconfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
  test: {
    name: "unit",
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 5_000,
    hookTimeout: 5_000,
    pool: "threads",
  },
})
