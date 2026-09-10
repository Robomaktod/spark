import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The engine ships to the browser (web plan §4). It is plain ESM with integer
 * maths and no Node APIs, so it needs no shim — only the workspace packages
 * resolved from their built output.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/live': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: 'index.html',
        // A second entry so the browser-parity test can import the very engine
        // the viewer ships rather than a separately built copy of it.
        parity: 'src/parity.ts',
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'parity' ? 'assets/parity.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
