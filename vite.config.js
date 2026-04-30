import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
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
