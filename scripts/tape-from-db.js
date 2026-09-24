// Exports one token's real trade history from the harvester's Postgres into a tape the paper
// terminal can replay (the shape Paperxiom's api.js documents), plus two marks the starter page
// uses: where the guided trade freezes before the run, and where the run tops out.
//
//   node scripts/tape-from-db.js <mint> [--sym TEST] [--name Test] [--freeze "<utc>"] [--top "<utc>" | --topmc <usd>] [--out …]
//
// Reads DB credentials from the harvester's .env (HARVESTER_DIR, default ../../EVERYTHING/pump-harvester).
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require(path.join(__dirname, '..', 'server', 'node_modules', 'pg'));

const args = process.argv.slice(2);
const mint = args.find((a) => !a.startsWith('--'));
if (!mint) { console.error('usage: tape-from-db.js <mint> [--sym X] [--freeze "YYYY-MM-DD HH:MM:SS" (UTC)] [--out file]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..');
const HARV = process.env.HARVESTER_DIR || path.resolve(ROOT, '..', '..', 'EVERYTHING', 'pump-harvester');
const env = {};
for (const line of fs.readFileSync(path.join(HARV, '.env'), 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const SOL_PRICE = 103.57;   // the mock world's SOL price (Mock.SOL_PRICE): the paper bank and the tape agree

(async () => {
  const pool = new Pool({ host: env.DB_HOST || '127.0.0.1', port: +(env.DB_PORT || 5432), database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD, max: 1 });
  const { rows } = await pool.query(
    `select timestamp, slot, trade_type, sol_amount::float8 as sol, token_amount::float8 as tok, market_cap_sol::float8 as mc,
            trader_address as who, is_dev_trade as dev
       from trades where mint = $1 order by timestamp asc, id asc`, [mint]);
  const tok = (await pool.query('select symbol, name from tokens where mint = $1', [mint])).rows[0] || {};
  await pool.end();
  if (!rows.length) { console.error('no trades for ' + mint); process.exit(1); }
  const sym = opt('sym', tok.symbol || mint.slice(0, 6));
  const name = opt('name', tok.name || sym);
  const launch_time = Number(rows[0].timestamp), launch_slot = Number(rows[0].slot);
  const wallets = [], widx = new Map();
  const devRow = rows.find((r) => r.dev) || rows[0];
  const dev = devRow.who; wallets.push(dev); widx.set(dev, 0);
  const T = { mint, sym, name, dev, sol_price: SOL_PRICE, launch_slot, launch_time,
    open_mc_usd: 0, supply: 1e9, t: [], slot: [], mc: [], sol: [], side: [], who: [], isdev: [], tok: [], wallets, names: {},
    migrated: false, migration_slot: null, ath_mc_usd: 0, handle: '', col: 0, age_s: 0, returned: 0,
    // for the guided trade: ms since launch
    freeze_at: 0, top_at: 0 };
  let athI = 0;
  rows.forEach((r, i) => {
    const t = Number(r.timestamp) - launch_time;
    if (!widx.has(r.who)) { widx.set(r.who, wallets.length); wallets.push(r.who); }
    const mcUsd = r.mc * SOL_PRICE;
    T.t.push(t); T.slot.push(Number(r.slot)); T.mc.push(mcUsd); T.sol.push(+r.sol.toFixed(4));
    T.side.push(r.trade_type === 'sell' ? 1 : 0); T.who.push(widx.get(r.who)); T.isdev.push(r.dev ? 1 : 0); T.tok.push(r.tok);
    if (mcUsd > T.ath_mc_usd) { T.ath_mc_usd = mcUsd; athI = i; }
  });
  // the curve was at its floor a moment before the first print
  T.open_mc_usd = Math.min(T.mc[0], 30 * SOL_PRICE * 1e9 / 1.073e9);
  T.returned = T.t.length;
  T.age_s = Math.round((Date.now() - launch_time) / 1000);
  T.top_at = T.t[athI];
  // --top "<utc time>": stop the guided run at the best print up to that second, rather than at
  // the launch's absolute top — a first peak makes a shorter, better-paced lesson.
  const tcap = opt('top', null);
  if (tcap) {
    const cut = Date.parse(tcap.replace(' ', 'T') + 'Z') + 999;
    let best = -1;
    rows.forEach((r, i) => { if (Number(r.timestamp) <= cut && (best < 0 || T.mc[i] > T.mc[best])) best = i; });
    if (best < 0) { console.error('nothing before ' + tcap); process.exit(1); }
    T.top_at = T.t[best]; T.ath_mc_usd = T.mc[best];
    console.log('stop: print #' + best + ' at +' + T.top_at + ' ms (slot ' + T.slot[best] + ', mc ' + (T.mc[best] / SOL_PRICE).toFixed(1) + ' SOL)');
  }
  // --topmc <usd>: stop the guided run the moment the launch first reaches that market cap
  const mcap = opt('topmc', null);
  if (mcap) {
    const want = Number(mcap);
    let at = -1;
    for (let i = 0; i < T.mc.length; i++) if (T.mc[i] >= want) { at = i; break; }
    if (at < 0) { console.error('never reached ' + want + ' (top was ' + Math.round(T.ath_mc_usd) + ')'); process.exit(1); }
    T.top_at = T.t[at]; T.ath_mc_usd = T.mc[at];
    console.log('stop: print #' + at + ' at +' + T.top_at + ' ms (mc $' + Math.round(T.mc[at]).toLocaleString('en-US') + ')');
  }
  const fz = opt('freeze', null);
  if (fz) {
    const cut = Date.parse(fz.replace(' ', 'T') + 'Z') + 999;         // the last print inside that second
    let k = -1; rows.forEach((r, i) => { if (Number(r.timestamp) <= cut) k = i; });
    if (k < 0) { console.error('nothing before ' + fz); process.exit(1); }
    T.freeze_at = T.t[k];
    console.log('freeze: print #' + k + ' at +' + T.freeze_at + ' ms (slot ' + T.slot[k] + ', mc ' + (T.mc[k] / SOL_PRICE).toFixed(1) + ' SOL)');
  }
  console.log('top: print #' + athI + ' at +' + T.top_at + ' ms (slot ' + T.slot[athI] + ', mc ' + (T.ath_mc_usd / SOL_PRICE).toFixed(1) + ' SOL); ' + T.returned + ' prints, ' + wallets.length + ' wallets, ' + ((T.t[T.t.length - 1]) / 1000).toFixed(1) + ' s');
  const out = opt('out', path.join(ROOT, 'web', 'trade', 'tapes', mint + '.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(T));
  console.log('wrote ' + path.relative(ROOT, out) + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB)');
})().catch((e) => { console.error(e.message); process.exit(1); });
