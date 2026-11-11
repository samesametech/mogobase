import { defineConfig } from "vitest/config"
import tsconfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ["tests/setup/integrationGlobalSetup.ts"],
    pool: "forks",
    // One file at a time against the shared replica set; each file in a fresh fork (vitest 4
    // dropped poolOptions.forks.singleFork).
    maxWorkers: 1,
  },
})
