/* eslint-disable */
// Package stage/ into dist/data_dictionary-<version>.tar.gz.
// Excludes dotfiles (AppInspect Cloud rejects them) and fixes permissions.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_ID = 'data_dictionary';
const STAGE = path.join(ROOT, 'stage');
const TEMP = path.join(ROOT, 'temp-package', APP_ID);
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(STAGE)) {
    console.error('[package] stage/ not found — run `npm run build` first.');
    process.exit(1);
}

// version from VERSION or app.manifest
let version = '0.1.0';
const manifestPath = path.join(STAGE, 'app.manifest');
if (fs.existsSync(manifestPath)) {
    try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        version = (m.info && m.info.id && m.info.id.version) || version;
    } catch (e) {
        /* ignore */
    }
}

fs.rmSync(path.join(ROOT, 'temp-package'), { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// rsync stage -> temp-package, excluding dotfiles + caches
execSync(
    `rsync -a --exclude='.*' --exclude='__pycache__' --exclude='*.pyc' "${STAGE}/" "${TEMP}/"`,
    { stdio: 'inherit' }
);
execSync(`find "${TEMP}" -type d -exec chmod 755 {} +`);
execSync(`find "${TEMP}" -type f -exec chmod 644 {} +`);

const tarball = path.join(DIST, `${APP_ID}-${version}.tar.gz`);
execSync(`tar -C "${path.join(ROOT, 'temp-package')}" -czf "${tarball}" "${APP_ID}"`, { stdio: 'inherit' });
console.log(`[package] wrote ${tarball}`);
