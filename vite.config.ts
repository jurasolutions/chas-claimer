import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The design system's components are plain .jsx; Vite handles them as-is.
  build: { outDir: "dist", sourcemap: true },
});
