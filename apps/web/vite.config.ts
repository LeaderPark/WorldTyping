// spec: docs/00 §5(빌드=Vite^5), docs/03 §1.1, WT-M0-01
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
