import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url))
    }
  },
  // Next's tsconfig uses `jsx: preserve`; tell esbuild to compile any .tsx a
  // test imports (e.g. AutomationsCard) with the automatic React runtime.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
