import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * `obsidian` ships types without runtime, so tests resolve it to the in-repo
 * stub. Source is still typechecked against the real `obsidian` typings.
 */
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test-support/obsidian-stub.ts", import.meta.url))
    }
  },
  test: {
    setupFiles: [fileURLToPath(new URL("./test-support/setup.ts", import.meta.url))]
  }
});
