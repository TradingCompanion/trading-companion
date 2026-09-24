// Serves a snapshot from backups/ on its own port, so a redesign can be compared against the
// site it replaced. Same server as scripts/serve-web.js; only the root differs.
'use strict';
process.env.WEB_ROOT = process.env.WEB_ROOT || require('path').resolve(__dirname, '..', 'backups', require('fs').readFileSync(require('path').resolve(__dirname, '..', 'backups', 'LATEST'), 'utf8').trim().replace(/^backups\//, ''));
require('./serve-web.js');
