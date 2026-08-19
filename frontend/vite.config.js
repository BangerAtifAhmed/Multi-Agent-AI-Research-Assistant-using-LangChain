import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server talks to the Express API cross-origin (see CORS_ORIGIN in
// backend/.env). The API base URL is configurable via VITE_API_BASE_URL so no
// host is ever hard-coded for production builds.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
