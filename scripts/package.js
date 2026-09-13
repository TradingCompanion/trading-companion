#!/usr/bin/env node
// Builds a release and refuses to produce one that carries anything private.
//
//   node scripts/package.js --check   only run the leak scan
//   node scripts/package.js           scan, bundle, build the app folder, zip it
//
// The scan is the point of this script. Everything that ends up in a release is listed in
// package.json's build.files; this reads each of those files and fails on anything that looks like
// a relay address, an API token or a wallet. relay.local.json holds those for local use and is
// never in that list, so a release cannot pick it up by accident. The built app.asar is scanned
// too, because that is the thing people actually download.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Strings a human has confirmed are fixtures or placeholders. Everything else must match nothing.
const ALLOW = fs.readFileSync(path.join(__dirname, 'package-allow.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// What a leak looks like. Loopback addresses and bundled-library identifiers are excluded by
// construction; anything else has to be listed in package-allow.txt or the build stops.
const RULES = [
  // an IP that is not this machine
  [/\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b|255\.255\.255\.255\b)(?:\d{1,3}\.){3}\d{1,3}\b/, 'a bare IP address'],
  // a websocket URL pointing somewhere real: a host of at least three characters, not loopback
  [/\bwss?:\/\/(?!localhost\b|127\.0\.0\.1\b)[A-Za-z0-9][A-Za-z0-9.-]{2,}(?::\d+)?/i, 'a hard-coded relay URL'],
  // Base58 of key length. Real keys carry digits; the camelCase identifiers inside bundled
  // libraries do not, so requiring two digits drops thousands of false alarms without weakening it.
  [/\b(?=(?:[^0-9\s]*[0-9]){2})[1-9A-HJ-NP-Za-km-z]{32,44}\b/, 'something shaped like a Solana address or token'],
  [/\b(?:api[-_]?key|secret|password|private[-_]?key|relaytoken)\b\s*[:=]\s*["'][^"']{8,}/i, 'a credential'],
];
// Only text is worth reading: models, sounds and icons are binary assets with no secrets in them.
const TEXTUAL = /\.(js|mjs|cjs|json|html|css|txt|md)$/i;
const SKIP_NAMES = new Set(['package-lock.json']);

function filesFor(pattern) {
  const clean = pattern.replace(/\/\*\*$/, '');
  const abs = path.join(ROOT, clean);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [abs];
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  })(abs);
  return out;
}

function scan() {
  const patterns = (pkg.build && pkg.build.files) || [];
  if (!patterns.length) throw new Error('package.json has no build.files list; refusing to guess what ships');
  const hits = [];
  let read = 0;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    for (const file of filesFor(pattern)) {
      if (!TEXTUAL.test(file) || SKIP_NAMES.has(path.basename(file))) continue;
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      read++;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const [re, what] of RULES) {
          const m = line.match(re);
          if (m && !ALLOW.includes(m[0])) hits.push({ rel, line: i + 1, what, sample: m[0].slice(0, 48) });
        }
      });
    }
  }
  return { hits, read, patterns };
}

const { hits, read, patterns } = scan();
console.log('[package] scanned ' + read + ' text files across ' + patterns.length + ' entries in build.files');
if (hits.length) {
  console.error('\n[package] REFUSING TO BUILD — these would ship inside the release:\n');
  for (const h of hits) console.error('  ' + h.rel + ':' + h.line + '  ' + h.what + '  ->  ' + h.sample);
  console.error('\nMove it into relay.local.json (never packaged), or add it to scripts/package-allow.txt');
  console.error('if you are certain it is a placeholder.\n');
  process.exit(1);
}
console.log('[package] clean: no addresses, tokens or wallets in anything that ships');

if (process.argv.includes('--check')) process.exit(0);

// relay.local.json sits beside main.js and a stray glob could sweep it in; say plainly whether it
// is here, so a release is never built in the dark about it.
console.log(fs.existsSync(path.join(ROOT, 'relay.local.json'))
  ? '[package] relay.local.json is present locally and is NOT in build.files, so it stays behind'
  : '[package] no relay.local.json here; the build has no relay preset either way');

const WIN = process.platform === 'win32';

console.log('[package] bundling the renderer...');
// the esbuild shim is plain JS: run it with node, rather than npm.cmd through a shell
execFileSync(process.execPath,
  [path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    'src/renderer.js', '--bundle', '--format=iife', '--outfile=dist/renderer.js',
    '--minify-syntax', '--target=chrome130'],
  { cwd: ROOT, stdio: 'inherit' });

console.log('[package] building the app folder...');
const { stage: unpacked, appDir } = require('./build-app').build();

// Scan the staged app, not just the sources it came from: this is the thing people download, and
// it is the only check that would catch a file sneaking in through a stray glob.
{
  const staged = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (TEXTUAL.test(p) && !SKIP_NAMES.has(e.name)) staged.push(p);
    }
  })(appDir);
  const found = new Set();
  for (const f of staged) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const [re, what] of RULES) {
        const m = line.match(re);
        if (m && !ALLOW.includes(m[0])) found.add(path.relative(appDir, f).replace(/\\/g, '/') + ':' + (i + 1) + '  ' + what + '  ->  ' + m[0].slice(0, 48));
      }
    });
  }
  if (found.size) {
    console.error('\n[package] REFUSING TO SHIP — the staged app contains:\n');
    for (const f of found) console.error('  ' + f);
    process.exit(1);
  }
  console.log('[package] staged app is clean across ' + staged.length + ' text files');
}

const zip = path.join(ROOT, 'release', 'Yui-' + pkg.version + '-win-x64.zip');
try { fs.unlinkSync(zip); } catch {}
const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
console.log('[package] zipping...');
if (WIN && fs.existsSync(sevenZip)) {
  execFileSync(sevenZip, ['a', '-tzip', '-mx=7', zip, path.join(unpacked, '*')], { cwd: ROOT, stdio: 'inherit' });
} else {
  execFileSync('powershell', ['-NoProfile', '-Command',
    "Compress-Archive -Path '" + unpacked + "\\*' -DestinationPath '" + zip + "' -Force"], { cwd: ROOT, stdio: 'inherit' });
}
console.log('[package] done — release/' + path.basename(zip) +
  ' (' + (fs.statSync(zip).size / 1048576).toFixed(1) + ' MB)');
