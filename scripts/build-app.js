// Assembles the runnable Windows app folder, without electron-builder.
//
// electron-builder insists on unpacking its Windows code-signing bundle before it will produce
// anything, and that bundle contains symlinks, which a normal Windows account is not allowed to
// create. Since this release is an unsigned zip, none of that tooling is needed: an Electron app
// folder is just the prebuilt Electron runtime with the app's own files under resources/app.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT = (pkg.build && pkg.build.productName) || pkg.name;

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
    // symlinks are skipped deliberately: nothing in the runtime needs one on Windows
  }
}

// rcedit is the tool that stamps an icon onto a Windows exe. electron-builder ships it inside its
// winCodeSign bundle, but its own unpacker refuses that bundle on an account without permission to
// create symbolic links — the bundle carries two macOS symlinks it does not even need here. So
// unpack it with the bundled 7-Zip and -snld (skip links) instead, and call rcedit directly.
function findRcedit() {
  const cacheDir = path.join(process.env.LOCALAPPDATA || process.env.HOME || '', 'electron-builder', 'Cache', 'winCodeSign');
  const exe = path.join(cacheDir, 'winCodeSign-2.6.0', 'rcedit-x64.exe');
  if (fs.existsSync(exe)) return exe;

  const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(sevenZip)) return null;

  let archive = null;
  try {
    archive = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.7z')).map((f) => path.join(cacheDir, f))[0] || null;
  } catch { /* no cache dir yet */ }

  if (!archive) {
    const url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      archive = path.join(cacheDir, 'winCodeSign-2.6.0.7z');
      console.log('[build-app] fetching rcedit…');
      execFileSync('curl', ['-fsSL', '-o', archive, url], { stdio: 'pipe' });
    } catch { return null; }
  }

  try {
    // the two symlinks still report an error; everything else, rcedit included, extracts fine
    execFileSync(sevenZip, ['x', '-snld', '-bso0', '-bse0', '-y', archive, '-o' + path.join(cacheDir, 'winCodeSign-2.6.0')], { stdio: 'pipe' });
  } catch { /* partial extraction is expected */ }
  return fs.existsSync(exe) ? exe : null;
}

function build() {
  const stage = path.join(ROOT, 'release', PRODUCT + '-win-x64');
  // The Windows runtime. On Windows that is what npm installed; anywhere else it is the official
  // win32-x64 Electron zip of the same version, unpacked into release/electron-win32-x64.
  const winDist = process.env.ELECTRON_WIN_DIST || path.join(ROOT, 'release', 'electron-win32-x64');
  const dist = fs.existsSync(path.join(winDist, 'electron.exe')) ? winDist : path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(dist, 'electron.exe'))) throw new Error('no Windows Electron runtime: unpack electron-v' + require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version + '-win32-x64.zip into release/electron-win32-x64');

  fs.rmSync(stage, { recursive: true, force: true });
  copyDir(dist, stage);

  // the stock Electron welcome app would otherwise run if resources/app were ever missing
  fs.rmSync(path.join(stage, 'resources', 'default_app.asar'), { force: true });
  fs.renameSync(path.join(stage, 'electron.exe'), path.join(stage, PRODUCT + '.exe'));

  const appDir = path.join(stage, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  let copied = 0;
  for (const pattern of (pkg.build && pkg.build.files) || []) {
    if (pattern.startsWith('!')) continue;
    const rel = pattern.replace(/\/\*\*$/, '');
    const src = path.join(ROOT, rel), dst = path.join(appDir, rel);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) { copyDir(src, dst); copied++; }
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); copied++; }
  }

  // a minimal manifest: the release needs none of the dev scripts or dependency list
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: pkg.name, productName: PRODUCT, version: pkg.version,
    description: pkg.description, license: pkg.license, main: pkg.main,
  }, null, 2) + '\n');

  // Give the exe the right icon and version strings. Cosmetic, so a failure here is reported and
  // the build carries on rather than losing the whole release over it.
  const ico = path.join(ROOT, 'yui.ico');
  const rcedit = findRcedit();
  if (rcedit && fs.existsSync(ico)) {
    try {
      execFileSync(rcedit, [path.join(stage, PRODUCT + '.exe'), '--set-icon', ico,
        '--set-version-string', 'ProductName', PRODUCT,
        '--set-version-string', 'FileDescription', pkg.description || PRODUCT,
        '--set-version-string', 'CompanyName', 'tradingcompanion.fun',
        '--set-file-version', pkg.version, '--set-product-version', pkg.version], { stdio: 'pipe' });
      console.log('[build-app] exe icon and version strings set');
    } catch (e) {
      console.warn('[build-app] rcedit failed (' + String(e.message).split('\n')[0] + '); the exe keeps the Electron icon');
    }
  } else if (fs.existsSync(ico)) {
    // rcedit is a Windows program. Off Windows the same stamp is done in plain JS by resedit.
    try {
      const exe = path.join(stage, PRODUCT + '.exe'), v = pkg.version + '.0';
      execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'resedit-cli', 'dist', 'cli.js'), '--in', exe, '--out', exe + '.new', '--icon', '1,' + ico,
        '--product-name', PRODUCT, '--file-description', PRODUCT, '--company-name', 'tradingcompanion.fun',
        '--product-version', v, '--file-version', v], { stdio: 'pipe' });
      fs.renameSync(exe + '.new', exe);
      console.log('[build-app] exe icon and version strings set (resedit)');
    } catch (e) {
      console.warn('[build-app] resedit failed (' + String(e.message).split('\n')[0] + '); the exe keeps the Electron icon');
    }
  } else {
    console.warn('[build-app] no icon file; the exe keeps the Electron icon');
  }

  console.log('[build-app] ' + path.relative(ROOT, stage) + ' ready (' + copied + ' entries from build.files)');
  return { stage, appDir };
}

module.exports = { build, PRODUCT };
if (require.main === module) build();
