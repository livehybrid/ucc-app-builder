import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Keep test runs from polluting the real agent trace directory — the SSE route
// now traces every chat run, including the ones the route tests drive.
process.env.TRACE_DIR = '.tmp/test-traces';

// Mock matchMedia for components if needed (Vitest + JSDOM environment).
// Guarded so node-environment tests (e.g. server route tests) can share this
// setup file without a `window is not defined` crash.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Mock fetch by default to avoid accidental network requests in the browser-like
  // jsdom suites. Node-env tests keep the real fetch/http so they can drive a server.
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response)
  );
}
