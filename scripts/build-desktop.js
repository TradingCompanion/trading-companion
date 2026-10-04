// Everything the desktop app loads from dist/: the renderer bundle, the main-process half of her
// chat (with the Anthropic SDK bundled in, since the release carries no node_modules), and the
// chat bar, which is the website's own file.
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function build() {
  const common = { absWorkingDir: ROOT, bundle: true, minifySyntax: true, logLevel: 'warning' };
  esbuild.buildSync({ ...common, entryPoints: ['src/renderer.js'], format: 'iife', outfile: 'dist/renderer.js', target: 'chrome130' });
  esbuild.buildSync({ ...common, entryPoints: ['src/desktop-chat.js'], platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/chat.js', target: 'node20' });
  fs.copyFileSync(path.join(ROOT, 'web', 'yui-chat.js'), path.join(ROOT, 'dist', 'yui-chat.js'));
}

module.exports = { build };
if (require.main === module) build();
