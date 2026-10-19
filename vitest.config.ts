import { defineConfig } from "vitest/config";

// Config propia: los tests no necesitan los plugins de Tauri/Tailwind del dev server.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
