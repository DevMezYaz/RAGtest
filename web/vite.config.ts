import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5173, proxy: { "/v1": "http://127.0.0.1:4477" } },
  build: {
    outDir: "dist", emptyOutDir: true,
    rollupOptions: { input: { main: `${import.meta.dirname}/index.html`, mosby: `${import.meta.dirname}/mosby.html` } },
  },
});
