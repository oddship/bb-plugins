import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.test.{ts,tsx}"], testTimeout: 10000 },
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
});
