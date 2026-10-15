// Tests run without the React Router plugin: they only cover server code.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The database test starts a real Postgres (PGlite), so tests get more time
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
