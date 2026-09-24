// Renders the Chrome Web Store promo tiles into release/store-assets/promo-tiles (RGB PNG, exact sizes).
// Needs puppeteer-core (PUP=/path/to/node_modules) and the playwright chromium on the box.
// Owner-requested captures only (see the global rule) — this is a local HTML render, no site loads.
'use strict';
const fs = require('fs'), path = require('path');
const puppeteer = require(process.env.PUP || '/tmp/pup/node_modules/puppeteer-core');
const CHROME = process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const HERE = __dirname, OUT = path.resolve(HERE, '..', '..', 'release', 'store-assets', 'promo-tiles');
const SIZES = [['s', 440, 280, 'promo-small-440x280'], ['m', 1400, 560, 'promo-marquee-1400x560'], ['l', 920, 680, 'promo-large-920x680']];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(path.join(HERE, 'tile.html'), 'utf8');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files', '--hide-scrollbars'] });
  for (const [cls, w, h, name] of SIZES) {
    const tmp = path.join(HERE, `.tile-${cls}.html`);
    fs.writeFileSync(tmp, html.replace('SIZECLASS', cls));
    const page = await browser.newPage(); await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto('file://' + tmp, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready); await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: path.join(OUT, name + '.png'), clip: { x: 0, y: 0, width: w, height: h } });
    await page.close(); fs.unlinkSync(tmp); console.log('tile', name);
  }
  await browser.close();
})().catch((e) => { console.error('TILES FAILED', e); process.exit(1); });
