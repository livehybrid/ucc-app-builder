/**
 * Augment PATH with common pyenv/pip locations so Python binaries can be found
 * regardless of how the server was started.
 */
export function augmentedEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '';
  const extras = [
    `${home}/.pyenv/shims`,
    `${home}/.pyenv/bin`,
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const existing = (process.env.PATH ?? '').split(':');
  const merged = [...extras, ...existing].filter((v, i, a) => v && a.indexOf(v) === i);
  return { ...process.env, PATH: merged.join(':') };
}
