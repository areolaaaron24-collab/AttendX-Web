import { defineConfig } from 'vite';

export default defineConfig({
  // For a GitHub Pages project site, CI sets VITE_BASE_PATH to /<repository-name>/.
  // Local development falls back to /.
  base: process.env.VITE_BASE_PATH || '/',
  server: { host: '0.0.0.0' },
  preview: { host: '0.0.0.0' },
  build: { sourcemap: false, target: 'es2022' },
});
