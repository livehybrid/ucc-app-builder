// Resolve hooks registered by esm-resolve.mjs. See that file for why.
const RETRY = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || !RETRY.has(err?.code) || /\.[cm]?js$/.test(specifier)) throw err;
    for (const candidate of [`${specifier}.js`, `${specifier}/index.js`]) {
      try {
        return await nextResolve(candidate, context);
      } catch {
        // try the next candidate
      }
    }
    throw err;
  }
}
