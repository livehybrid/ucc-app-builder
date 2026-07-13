/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // GitHub OAuth device flow — client calls /github-api/login/...
      // Server handles /api/github/login/... to proxy to github.com (avoids CORS)
      '/github-api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/github-api/, '/api/github'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    globals: true,
    // Vitest owns src/** unit tests. Playwright (tests/e2e) has its own runner.
    exclude: ['node_modules', 'dist', 'dist-server', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/setupTests.ts',
        'src/**/*.test.{ts,tsx}',
        'src/vite-env.d.ts',
        'tests/**',
      ],
    },
  },
});
