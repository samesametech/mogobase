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
    poolOptions: { forks: { singleFork: true } },
  },
})
