import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["e2e/**", "**/node_modules/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@workspace/page-keys": path.resolve(import.meta.dirname, "../../lib/page-keys/src/index.ts"),
      "@workspace/payment-constants": path.resolve(import.meta.dirname, "../../lib/payment-constants/src/index.ts"),
      "@workspace/object-storage-web": path.resolve(import.meta.dirname, "src/test/mocks/workspace-object-storage-web.ts"),
      "@workspace/api-client-react": path.resolve(import.meta.dirname, "../../lib/api-client-react/src/index.ts"),
      // Ensure react resolves from this package's node_modules when lib source
      // files are imported directly (e.g. use-upload.test.ts).
      react: path.resolve(import.meta.dirname, "node_modules/react"),
      "react-dom": path.resolve(import.meta.dirname, "node_modules/react-dom"),
      // Dedupe react-query to a single physical copy as well. The
      // api-client-react lib (imported from source above) otherwise resolves its
      // own react-query bound to a different react version, which breaks
      // QueryClient context and prevents vi.mock("@tanstack/react-query") from
      // intercepting the lib's hooks.
      "@tanstack/react-query": path.resolve(
        import.meta.dirname,
        "node_modules/@tanstack/react-query",
      ),
    },
  },
});
