import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
  },
  resolve: {
    alias: { "@": repositoryRoot },
  },
});
