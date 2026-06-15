/* eslint-disable */
// Post-process the ucc-gen build output so the app is launcher-visible and
// AppInspect/Splunkbase-clean. ucc-gen often emits is_visible=false and
// check_for_updates=false. Idempotent.
const fs = require('fs');
const path = require('path');

const APP_ID = 'data_dictionary';
const appConfPath = path.join(__dirname, '..', 'build', APP_ID, 'default', 'app.conf');

if (!fs.existsSync(appConfPath)) {
    console.error(`[patch-build] ${appConfPath} not found — did ucc-gen build run?`);
    process.exit(0);
}

let conf = fs.readFileSync(appConfPath, 'utf8');

function setKey(text, stanza, key, value) {
    const stanzaRe = new RegExp(`(\\[${stanza}\\][^\\[]*)`, 'm');
    const m = text.match(stanzaRe);
    if (!m) {
        // append stanza
        return `${text.trimEnd()}\n\n[${stanza}]\n${key} = ${value}\n`;
    }
    let block = m[1];
    const keyRe = new RegExp(`^${key}\\s*=.*$`, 'm');
    if (keyRe.test(block)) {
        block = block.replace(keyRe, `${key} = ${value}`);
    } else {
        block = `${block.trimEnd()}\n${key} = ${value}\n`;
    }
    return text.replace(stanzaRe, block);
}

// ucc-gen stamps the version from `git describe` (e.g. 0.0.0+<sha>) into app.conf,
// app.manifest and globalConfig.json on every build. Pin everything to the
// canonical semver so the installed app, the packaged tarball name, and the
// tracked working tree all agree. CANONICAL_VERSION is the single source of truth.
const CANONICAL_VERSION = '0.1.0';

conf = setKey(conf, 'ui', 'is_visible', 'true');
conf = setKey(conf, 'install', 'is_configured', 'false');
conf = setKey(conf, 'package', 'check_for_updates', 'true');
conf = setKey(conf, 'launcher', 'version', CANONICAL_VERSION);
conf = setKey(conf, 'id', 'version', CANONICAL_VERSION);

fs.writeFileSync(appConfPath, conf, 'utf8');
console.log(`[patch-build] patched app.conf: is_visible=true, check_for_updates=true, version=${CANONICAL_VERSION}`);

// Built app.manifest (what scripts/package.js reads for the tarball name).
const manifestPath = path.join(__dirname, '..', 'build', APP_ID, 'app.manifest');
try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (m.info && m.info.id) {
        m.info.id.version = CANONICAL_VERSION;
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 4) + '\n', 'utf8');
        console.log(`[patch-build] pinned build app.manifest version -> ${CANONICAL_VERSION}`);
    }
} catch (e) {
    console.warn('[patch-build] could not normalise build app.manifest version:', e.message);
}

// Tracked globalConfig.json — keep the working tree clean (no SHA churn).
const gcPath = path.join(__dirname, '..', 'globalConfig.json');
try {
    const gc = JSON.parse(fs.readFileSync(gcPath, 'utf8'));
    if (gc.meta && gc.meta.version !== CANONICAL_VERSION) {
        gc.meta.version = CANONICAL_VERSION;
        fs.writeFileSync(gcPath, JSON.stringify(gc, null, 4) + '\n', 'utf8');
        console.log(`[patch-build] reset globalConfig.json meta.version -> ${CANONICAL_VERSION}`);
    }
} catch (e) {
    console.warn('[patch-build] could not normalise globalConfig.json version:', e.message);
}
