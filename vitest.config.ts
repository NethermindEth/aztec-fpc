import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "scripts/tests/**/*.ts", "services/*/test/**/*.ts"],
  },
});
