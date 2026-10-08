import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` runs Vite in "https" mode with a self-signed certificate.
// HTTPS is needed on iPad for tilt steering (DeviceOrientation permission) and
// for the offline service worker when testing over the local network.
export default defineConfig(({ mode }) => ({
  // Relative base so the built game works from any sub-path
  // (GitHub Pages project sites, Netlify, a USB stick, ...).
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: ['es2020', 'safari15'],
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
}));
