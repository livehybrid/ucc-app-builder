// Loaded with `node --import` in front of the compiled server (dist-server/).
//
// The server and the src/lib modules it shares with the frontend are written for
// moduleResolution "bundler", so many relative imports are extensionless
// ('./vfs', '../types/app') or name a directory ('./tools'). Vite, vitest and tsx
// resolve those; plain Node ESM does not, so the tsc output could never start in
// the Docker image. This hook retries a failed relative specifier as `<spec>.js`
// and then `<spec>/index.js`, and changes nothing that already resolves.
import { register } from 'node:module';

register('./esm-resolve-hooks.mjs', import.meta.url);
