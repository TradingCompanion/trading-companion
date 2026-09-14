// pet-relay.js — wallet-filtered trade feed for the desktop pet.
//
// Reads the local pump.fun firehose relay (ws://127.0.0.1:9999, raw PumpApi
// events), keeps a running cost basis per wallet/mint (seeded from the
// harvester's Postgres `trades` table), and pushes small JSON events to any
// connected pet:
//
//   client -> ws://HOST:9998/?token=TOKEN&wallets=addr1,addr2
//   server -> {type:'hello', wallets, positions:[...], firehose, solUsd}
//             {type:'status', firehose, solUsd}
//             {type:'price', mint, price, quote:'SOL', mcQuote, mcUsd, quoteKind, quoteSymbol, solUsd, ts}
//             {type:'trade', side:'buy'|'sell', wallet, mint, symbol, name, venue,
//                            quote:'SOL', amount, tokens, mcQuote, mcUsd,           <- SOL-equivalent
//                            quoteMint, quoteSymbol, quoteKind:'sol'|'usd'|'other', quoteAmount,  <- as traded
//                            pnl, pnlPct, cost, remainingTokens, sig, solUsd, ts}
//             {type:'error', message}
//
// Every venue on the firehose is relayed — pump.fun curves, PumpSwap, Raydium LaunchLab (stonkfun,
// bonk and the rest), Raydium CPMM, Meteora — and every quote token. Curves are quoted in whatever
// the launcher chose (SOL, USDC, xStocks, PUMP…), so amounts and market caps are converted to
// SOL-equivalent for one comparable cost basis, the way the harvester stores them, using the
// harvester's own prices from Redis (`sol:price:usd`, `pump:quotes`). The raw quote travels alongside
// so the pet can still speak dollars for a dollar-quoted coin.
//
// Config: server/.env (PET_RELAY_PORT, PET_RELAY_HOST, PET_RELAY_TOKEN, FIREHOSE_URL)
// and the harvester's .env for DB_* credentials. Token falls back to server/.token.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');

function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}
// server/.env is read first so it can say where the harvester lives: the default only holds when this
// checkout sits beside pump-harvester, and a relay that cannot find it silently loses its cost basis.
const senv = loadEnv(path.join(__dirname, '.env'));
const HARVESTER_DIR = process.env.HARVESTER_DIR || senv.HARVESTER_DIR || path.resolve(__dirname, '../../pump-harvester');
const henv = loadEnv(path.join(HARVESTER_DIR, '.env'));
if (!henv.DB_PASSWORD && !henv.PGPASSWORD && !process.env.PGPASSWORD) console.error('[seed] no DB credentials at ' + HARVESTER_DIR + '/.env — set HARVESTER_DIR in server/.env; trades will relay, positions will not seed');

const PORT = Number(senv.PET_RELAY_PORT || process.env.PET_RELAY_PORT || 9998);
const HOST = senv.PET_RELAY_HOST || process.env.PET_RELAY_HOST || '0.0.0.0';
// POST /simulate injects fake fills into real cost basis: keep it off outside test setups
const SIMULATE = (senv.PET_RELAY_SIMULATE || process.env.PET_RELAY_SIMULATE) === '1';
// Public mode: anyone may connect without a token, under limits. A token shipped inside a public
// download is not a secret, so the honest arrangement is no token plus caps — and the token, when
// someone does hold it, simply raises those caps.
const cfgN = (k, d) => Number(senv[k] || process.env[k] || d);
const PUBLIC = (senv.PET_RELAY_PUBLIC || process.env.PET_RELAY_PUBLIC) === '1';
const MAX_SESSIONS = cfgN('PET_MAX_SESSIONS', 2000);       // total sockets before new ones are turned away
const MAX_PER_IP = cfgN('PET_MAX_PER_IP', 4);              // one person, a few machines
const MAX_WALLETS = cfgN('PET_MAX_WALLETS', 3);            // wallets one anonymous session may watch
const MAX_WALLETS_AUTHED = cfgN('PET_MAX_WALLETS_AUTHED', 40);
const SEED_CONCURRENCY = cfgN('PET_SEED_CONCURRENCY', 4);  // simultaneous history queries
const FIREHOSE_URL = senv.FIREHOSE_URL || process.env.FIREHOSE_URL || 'ws://127.0.0.1:9999';
let TOKEN = senv.PET_RELAY_TOKEN || process.env.PET_RELAY_TOKEN || '';
if (!TOKEN) { try { TOKEN = fs.readFileSync(path.join(__dirname, '.token'), 'utf8').trim(); } catch {} }
if (!TOKEN) { console.error('no PET_RELAY_TOKEN and no .token file; refusing to start without auth'); process.exit(1); }

const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: 'USD1',
};
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ------------------------------------------------------------- quote prices
// The harvester prices every quote token it sees via Jupiter and mirrors the result into Redis
// (`pump:quotes`: mint -> {usd, sym, ts}) next to the live SOL price (`sol:price:usd`). Reading
// those, rather than polling Jupiter again from here, keeps this process keyless and the two in
// agreement. Without Redis (the test harness, a box without the harvester) SOL and stablecoin
// quotes still work; anything else waits until a price is known.
const REDIS_URL = senv.REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUOTE_MAX_AGE_MS = 10 * 60000;   // a price older than this counts as unknown (harvester's rule)
let solUsd = Number(senv.SOL_USD || process.env.SOL_USD) || 0;
const quotes = new Map();              // mint -> { usd, sym, ts }
let unpricedQuotes = 0, quotesLastOk = 0;
function startQuotes() {
  let Redis;
  try { Redis = require('ioredis'); } catch { console.error('[quotes] ioredis not installed: only SOL and stablecoin quotes will relay'); return; }
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: (n) => Math.min(30000, 1000 * n) });
  let warned = false;
  redis.on('error', (e) => { if (!warned) { warned = true; console.error('[quotes] redis:', e.message); } });
  redis.on('ready', () => { warned = false; });
  const tick = async () => {
    try {
      const [s, h] = await Promise.all([redis.get('sol:price:usd'), redis.hgetall('pump:quotes')]);
      const n = Number(s);
      if (n > 0) solUsd = n;
      for (const [mint, json] of Object.entries(h || {})) {
        try { const d = JSON.parse(json); quotes.set(mint, { usd: Number(d.usd) || 0, sym: d.sym || null, ts: Number(d.ts) || 0 }); } catch {}
      }
      quotesLastOk = Date.now();
    } catch {}
  };
  redis.connect().then(tick).catch(() => {});
  setInterval(tick, 5000);
}
startQuotes();
// What one unit of the quote token is worth, or null while it cannot be priced.
function quoteInfo(mint) {
  mint = mint || WSOL;
  if (mint === WSOL) return { usd: solUsd, sym: 'SOL', kind: 'sol' };
  if (STABLES[mint]) return { usd: 1, sym: STABLES[mint], kind: 'usd' };
  const q = quotes.get(mint);
  if (!q || !(q.usd > 0) || Date.now() - q.ts > QUOTE_MAX_AGE_MS) return null;
  return { usd: q.usd, sym: q.sym || mint.slice(0, 4) + '…', kind: 'other' };
}
// SOL-equivalent of an amount in the quote token. SOL passes through, so a relay with no price feed
// at all still handles the common case; anything else needs the SOL price to convert through USD.
function toSol(amount, q) {
  if (q.kind === 'sol') return amount;
  return solUsd > 0 ? (amount * q.usd) / solUsd : null;
}
// Where the fill happened, in the words a trader uses. stonkfun is a frontend on Raydium
// LaunchLab with no on-chain fingerprint; the harvester's resolver marks those in tokens.is_stonkfun.
function venueFor(ev, info) {
  const pool = ev.pool || '';
  if (pool === 'pump') return 'pump.fun';
  if (pool === 'pump-amm') return 'pump.swap';
  if (pool === 'raydium-launchpad') return ev.platform === 'bonk' ? 'bonk' : info && info.stonkfun ? 'stonkfun' : 'launchlab';
  if (pool === 'raydium-cpmm') return 'raydium';
  if (pool.startsWith('meteora')) return 'meteora';
  return pool || null;
}

const pool = new Pool({
  host: henv.DB_HOST || 'localhost', port: Number(henv.DB_PORT || 5432),
  database: henv.DB_NAME || 'pumpdatabase_test', user: henv.DB_USER || 'pump_app', password: henv.DB_PASSWORD || '',
  max: 3, statement_timeout: 20000,
});

// ------------------------------------------------------------- positions
// wallet -> Map(mint -> { tokens, cost, quote })
const positions = new Map();
// wallet -> { promise, ok, sigs:Set|null, tail:[{mint,side,amount,tokens}], doneAt }
// A live fill can also be in the seeded rows (the harvester writes the same firehose),
// so fills that arrive around seeding are checked against the seed before being applied.
const seeded = new Map();
const symbols = new Map(); // mint -> { symbol, name }

function book(wallet) {
  let b = positions.get(wallet);
  if (!b) { b = new Map(); positions.set(wallet, b); }
  return b;
}

const DUST_FRACTION = 0.03;   // of the tokens held before the sell
const DUST_SOL = 0.0005;       // about five cents
// apply one fill to the running cost basis; returns realised pnl info for sells
function applyFill(wallet, mint, side, amount, tokens, quote) {
  const b = book(wallet);
  let p = b.get(mint);
  if (!p) { p = { tokens: 0, cost: 0, quote }; b.set(mint, p); }
  if (side === 'buy') {
    p.tokens += tokens; p.cost += amount; p.quote = quote;
    return { pnl: null, pnlPct: null, cost: null, remainingTokens: p.tokens, remainingCost: p.cost };
  }
  if (p.tokens <= 0) {
    // selling something we never saw bought (history gap): no basis
    return { pnl: null, pnlPct: null, cost: null, remainingTokens: 0, remainingCost: 0 };
  }
  const avg = p.cost / p.tokens;
  const before = p.tokens;
  const sold = Math.min(tokens, p.tokens);
  let cost = avg * sold;
  let pnl = amount * (sold / tokens) - cost; // pro-rate proceeds to the part we have a basis for (history gaps)
  p.tokens -= sold; p.cost -= cost;
  // A "sell everything" rarely clears the book to the token: LaunchLab and stonkfun take their fee
  // out of the trader's side, so the sell event carries ~1-2% fewer tokens than the buy did, and a
  // sliver stays behind forever with the board still up for it. A remainder that is a few percent
  // of what was held, or worth less than a cent, is dust: the position is closed and the dust's
  // cost goes into this sale's realised result, which is what the trader actually experienced.
  const dust = p.tokens > 0 && (p.tokens <= before * DUST_FRACTION || p.tokens * avg < DUST_SOL);
  if (dust || p.tokens < 1e-6) { pnl -= p.cost; cost += p.cost; p.tokens = 0; p.cost = 0; }
  return { pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : null, cost, remainingTokens: p.tokens, remainingCost: p.cost };
}

// the harvester's trades table may or may not carry the transaction signature; find out once
const SIG_CANDIDATES = ['signature', 'tx_signature', 'tx_sig', 'transaction_signature', 'txid', 'tx_id', 'tx_hash', 'sig', 'tx'];
let sigColumn; // undefined = not checked yet, null = none
async function sigColumnName() {
  if (sigColumn !== undefined) return sigColumn;
  try {
    const { rows } = await pool.query(
      `select column_name from information_schema.columns where table_name = 'trades' and column_name = any($1)`, [SIG_CANDIDATES]);
    const found = SIG_CANDIDATES.find((c) => rows.some((r) => r.column_name === c)) || null;
    sigColumn = found;
    console.log(found ? `[seed] trades.${found} used to dedupe live fills against history` : '[seed] trades has no signature column; deduping by fingerprint');
  } catch (e) { console.error('[seed] column probe failed', e.message); return null; } // retry next time
  return sigColumn;
}
const SEED_TAIL = 300;        // fingerprints kept from the end of the seeded history
const SEED_OVERLAP_MS = 180000; // live fills this soon after a seed are checked against it
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

// Every new wallet costs one history query. Unbounded, a crowd arriving at once would put the
// database on its knees and take the harvester with it, so they queue.
let seedsInFlight = 0;
const seedQueue = [];
function pumpSeedQueue() {
  while (seedsInFlight < SEED_CONCURRENCY && seedQueue.length) { seedsInFlight++; seedQueue.shift()(); }
}
function seedWallet(wallet) {
  if (seeded.has(wallet)) return seeded.get(wallet).promise;
  const st = { promise: null, ok: false, sigs: null, tail: [], doneAt: 0 };
  st.promise = (async () => {
    await new Promise((go) => { seedQueue.push(go); pumpSeedQueue(); });
    const t0 = Date.now();
    positions.delete(wallet); // always rebuild from scratch (a previous failed attempt may have applied live fills)
    const sc = await sigColumnName();
    const { rows } = await pool.query(
      `select mint, trade_type, sol_amount::float8 as amount, token_amount::float8 as tokens${sc ? `, "${sc}"::text as sig` : ''}
         from trades where trader_address = $1 order by "timestamp" asc, id asc`, [wallet]);
    if (sc) st.sigs = new Set();
    for (const r of rows) {
      if (!(r.amount > 0) || !(r.tokens > 0)) continue;
      const side = r.trade_type === 'buy' ? 'buy' : 'sell';
      applyFill(wallet, r.mint, side, r.amount, r.tokens, 'SOL');
      if (st.sigs && r.sig) st.sigs.add(r.sig);
      st.tail.push({ mint: r.mint, side, amount: r.amount, tokens: r.tokens });
      if (st.tail.length > SEED_TAIL) st.tail.shift();
    }
    st.ok = true; st.doneAt = Date.now();
    const open = [...book(wallet)].filter(([, v]) => v.tokens > 0).length;
    console.log(`[seed] ${wallet.slice(0, 6)}… ${rows.length} fills -> ${open} open positions (${Date.now() - t0} ms)`);
  })().catch((e) => { console.error('[seed] failed', wallet, e.message); seeded.delete(wallet); positions.delete(wallet); })
    .finally(() => { seedsInFlight--; pumpSeedQueue(); });
  seeded.set(wallet, st);
  return st.promise;
}
// true when a live fill is already part of the seeded history (it landed in the DB before the seed query ran)
function inSeededHistory(wallet, sig, mint, side, amount, tokens) {
  const st = seeded.get(wallet);
  if (!st || !st.ok) return false;
  if (st.sigs) return !!sig && st.sigs.has(sig);
  if (Date.now() - st.doneAt > SEED_OVERLAP_MS) return false;
  const i = st.tail.findIndex((f) => f.mint === mint && f.side === side && near(f.amount, amount) && near(f.tokens, tokens));
  if (i < 0) return false;
  st.tail.splice(i, 1); // each seeded row can absorb one live duplicate
  return true;
}

let tokensHaveFlags = true;   // is_stonkfun / launchpad exist on the harvester's schema; a plain tokens table still works
async function lookupSymbols(mints) {
  const missing = mints.filter((m) => !symbols.has(m));
  if (missing.length) {
    try {
      const cols = tokensHaveFlags ? 'mint, symbol, name, is_stonkfun, launchpad' : 'mint, symbol, name';
      const { rows } = await pool.query(`select ${cols} from tokens where mint = any($1)`, [missing]);
      for (const r of rows) symbols.set(r.mint, { symbol: r.symbol, name: r.name, stonkfun: r.is_stonkfun === true, launchpad: r.launchpad || null });
    } catch (e) {
      if (tokensHaveFlags && /column .* does not exist/i.test(e.message)) { tokensHaveFlags = false; return lookupSymbols(mints); }
      console.error('[symbols]', e.message);
    }
    for (const m of missing) if (!symbols.has(m)) symbols.set(m, { symbol: null, name: null });
  }
  return mints.map((m) => symbols.get(m) || { symbol: null, name: null });
}

function openPositions(wallet) {
  return [...book(wallet)].filter(([, v]) => v.tokens > 0)
    .map(([mint, v]) => { const s = symbols.get(mint) || {}; return { mint, tokens: v.tokens, cost: v.cost, quote: v.quote, symbol: s.symbol, name: s.name }; });
}

// ------------------------------------------------------------- sessions
const sessions = new Set(); // { ws, wallets:Set }
const watched = new Set();  // union of all wallets
// mint -> Set(wallet): every mint some connected client still holds. The firehose carries the
// whole market, so these are the only mints worth forwarding a price for.
const heldMints = new Map();
const lastTick = new Map(); // mint -> ts of the last price we sent (throttle)
const PRICE_MS = Number(senv.PET_PRICE_MS || process.env.PET_PRICE_MS || 400);
// wallet -> the sessions watching it. Without this every trade and every price tick would walk the
// whole session list, which is fine for one viewer and quadratic for a thousand.
const byWallet = new Map();
function rebuildWatched() {
  watched.clear(); byWallet.clear();
  for (const s of sessions) {
    for (const w of s.wallets) {
      watched.add(w);
      let set = byWallet.get(w);
      if (!set) byWallet.set(w, (set = new Set()));
      set.add(s);
    }
  }
  rebuildHeld();
}
function rebuildHeld() {
  heldMints.clear();
  for (const w of watched) {
    const b = positions.get(w);
    if (!b) continue;
    for (const [mint, p] of b) {
      if (!(p.tokens > 0)) continue;
      let set = heldMints.get(mint);
      if (!set) heldMints.set(mint, (set = new Set()));
      set.add(w);
    }
  }
  for (const mint of lastTick.keys()) if (!heldMints.has(mint)) lastTick.delete(mint);
}
function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcastWallet(wallet, obj) { const set = byWallet.get(wallet); if (set) for (const s of set) send(s.ws, obj); }
function broadcastMint(mint, obj) {
  const holders = heldMints.get(mint);
  if (!holders) return;
  const sent = new Set();   // a session watching two wallets that both hold this mint gets one copy
  for (const w of holders) {
    const set = byWallet.get(w);
    if (!set) continue;
    for (const s of set) if (!sent.has(s)) { sent.add(s); send(s.ws, obj); }
  }
}
// a trade by anyone on a mint a client holds: forward just the price, throttled
function emitPrice(ev) {
  const mint = ev.mint;
  if (!heldMints.has(mint)) return;
  const tokens = Number(ev.tokenAmount) || 0;
  const q = quoteInfo(ev.quoteMint);
  if (!q) return;
  const amount = toSol(Number(ev.quoteAmount) || 0, q);
  if (!(tokens > 0) || !(amount > 0)) return;
  const now = Date.now();
  if (now - (lastTick.get(mint) || 0) < PRICE_MS) return;
  lastTick.set(mint, now);
  pricesRelayed++;
  const mcRaw = Number(ev.marketCapQuote) || 0;
  broadcastMint(mint, {
    type: 'price', mint, price: amount / tokens, quote: 'SOL',
    mcQuote: mcRaw > 0 ? toSol(mcRaw, q) : null, mcUsd: mcRaw > 0 && q.usd > 0 ? mcRaw * q.usd : null,
    quoteKind: q.kind, quoteSymbol: q.sym, solUsd: solUsd || null, ts: now,
  });
}
function broadcastAll(obj) { for (const s of sessions) send(s.ws, obj); }

// ------------------------------------------------------------- firehose
let upstream = null, firehoseUp = false, retry = 0;
let eventsSeen = 0, tradesRelayed = 0, pricesRelayed = 0, lastEventAt = 0;
const seen = new Map(); // sig+side -> ts (dedupe)
// Tolerant of whitespace: a producer that starts pretty-printing must not silently mute her.
const RE_SIGNER = /"txSigner"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/;
const RE_MINT = /"mint"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/;
let eventsUnparsed = 0;   // events where neither field was found — if this tracks eventsSeen, the
                          // upstream format has changed and nothing will ever match again
function dedupe(key) {
  const now = Date.now();
  if (seen.has(key)) return true;
  seen.set(key, now);
  if (seen.size > 5000) for (const [k, t] of seen) { if (now - t > 60000) seen.delete(k); if (seen.size < 2500) break; }
  return false;
}

function connectFirehose() {
  const ws = new WebSocket(FIREHOSE_URL);
  upstream = ws;
  ws.on('open', () => { firehoseUp = true; retry = 0; console.log('[firehose] connected', FIREHOSE_URL); broadcastAll({ type: 'status', firehose: true }); });
  ws.on('message', (data) => {
    eventsSeen++; lastEventAt = Date.now();
    if (watched.size === 0) return;
    const s = data.toString();
    // Pull the two fields that decide relevance straight out of the text, then look them up. The
    // old prefilter searched the event once per watched wallet, which is fine for one viewer and
    // hopeless for a thousand; this is the same work no matter how many people are connected.
    const sig = RE_SIGNER.exec(s);
    const mnt = RE_MINT.exec(s);
    if (!sig && !mnt) { eventsUnparsed++; return; }
    const signer = sig && sig[1];
    const mint = mnt && mnt[1];
    if (!(signer && watched.has(signer)) && !(mint && heldMints.has(mint))) return;
    if (!/"action"\s*:\s*"(buy|sell)"/.test(s)) return;
    let ev; try { ev = JSON.parse(s); } catch { return; }
    if (ev.action !== 'buy' && ev.action !== 'sell') return;
    const wallet = ev.txSigner;
    if (watched.has(wallet)) handleTrade(ev, wallet).catch((e) => console.error('[trade]', e.message));
    else emitPrice(ev);
  });
  const down = () => {
    if (upstream !== ws) return;
    upstream = null;
    if (firehoseUp) { firehoseUp = false; console.log('[firehose] disconnected'); broadcastAll({ type: 'status', firehose: false }); }
    const delay = Math.min(20000, 500 * 2 ** retry++);
    setTimeout(connectFirehose, delay);
  };
  ws.on('close', down);
  ws.on('error', (e) => { console.error('[firehose] error', e.message); ws.close(); });
}

async function handleTrade(ev, wallet) {
  const side = ev.action;
  const key = `${ev.signature || ''}_${side}_${wallet}_${ev.mint}`;
  if (dedupe(key)) return;
  const mint = ev.mint;
  const tokens = Number(ev.tokenAmount) || 0;
  const quoteMint = ev.quoteMint || WSOL;
  const quoteAmount = Number(ev.quoteAmount) || 0;
  const q = quoteInfo(quoteMint);
  if (!q) {
    // a quote nobody has priced yet (a brand-new xStock, a Redis outage): the book cannot take it
    unpricedQuotes++;
    console.log(`[trade] ${side} ${wallet.slice(0, 6)}… ${mint.slice(0, 6)}: quote ${quoteMint.slice(0, 8)}… has no price, skipped`);
    return;
  }
  const amount = toSol(quoteAmount, q);
  if (!mint || tokens <= 0 || !(amount > 0)) return;
  const quote = 'SOL';   // the book is kept in SOL-equivalent whatever the pair; the raw quote travels alongside
  await seedWallet(wallet);
  const st = seeded.get(wallet);
  // A fill that reached the database before the seed query ran is already in the book. Applying it
  // again would double it — but staying silent means the pet misses a trade the user just made,
  // which is exactly the case they notice. So skip the accounting and still send the event, with
  // the position read back from the book rather than computed from a fill we must not apply twice.
  const already = inSeededHistory(wallet, ev.signature, mint, side, amount, tokens);
  let r;
  if (already) {
    const held = book(wallet).get(mint);
    console.log(`[trade] ${side} ${wallet.slice(0, 6)}… ${mint.slice(0, 6)}: already in seeded history, relaying without pnl`);
    r = { pnl: null, pnlPct: null, cost: null, remainingTokens: held ? held.tokens : 0, remainingCost: held ? held.cost : 0 };
  } else if (st && st.ok) {
    r = applyFill(wallet, mint, side, amount, tokens, quote);
  } else {
    // the seed failed (database down): tell the pet, but do not build a book a later seed would double
    r = { pnl: null, pnlPct: null, cost: null, remainingTokens: null, remainingCost: null };
  }
  const [sym] = await lookupSymbols([mint]);
  tradesRelayed++;
  const mcRaw = Number(ev.marketCapQuote) || 0;
  const venue = venueFor(ev, sym);
  const msg = {
    type: 'trade', side, wallet, mint, symbol: sym.symbol, name: sym.name, venue, quote,
    amount, tokens, mcQuote: mcRaw > 0 ? toSol(mcRaw, q) : null, mcUsd: mcRaw > 0 && q.usd > 0 ? mcRaw * q.usd : null,
    quoteMint, quoteSymbol: q.sym, quoteKind: q.kind, quoteAmount,
    pnl: r.pnl, pnlPct: r.pnlPct, cost: r.cost, remainingTokens: r.remainingTokens, remainingCost: r.remainingCost,
    sig: ev.signature || null, solUsd: solUsd || null, ts: Date.now(),
  };
  console.log(`[trade] ${side.padEnd(4)} ${wallet.slice(0, 6)}… ${sym.symbol || mint.slice(0, 6)} ${amount.toFixed(4)} SOL` +
    (q.kind !== 'sol' ? ` (${quoteAmount} ${q.sym})` : '') + (venue ? ` on ${venue}` : '') +
    (r.pnl != null ? ` pnl ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(4)} (${r.pnlPct.toFixed(1)}%)` : ''));
  broadcastWallet(wallet, msg);
  rebuildHeld(); // this fill may have opened or closed a position
}

// ------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  // POST /simulate?token=..  {wallet, side:'buy'|'sell', mint, amount, tokens}  -> injects a fake fill (testing)
  if (req.method === 'POST' && req.url.startsWith('/simulate')) {
    if (!SIMULATE) { res.writeHead(404); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) { res.writeHead(403); res.end('bad token'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const b = JSON.parse(body || '{}');
        if (!B58.test(b.wallet || '')) throw new Error('wallet required');
        if (!watched.has(b.wallet)) throw new Error('no client is watching that wallet');
        const ev = {
          action: b.side === 'sell' ? 'sell' : 'buy', txSigner: b.wallet, mint: b.mint || 'SimU1atedMintxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          tokenAmount: Number(b.tokens) || 1000000, quoteAmount: Number(b.amount) || 0.1, quoteMint: WSOL, marketCapQuote: 30,
          signature: 'sim_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        };
        await handleTrade(ev, b.wallet);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: firehoseUp, firehose: firehoseUp, public: PUBLIC,
      clients: sessions.size, capacity: MAX_SESSIONS, watched: watched.size, heldMints: heldMints.size,
      eventsSeen, eventsUnparsed, tradesRelayed, pricesRelayed,
      solUsd: solUsd || null, quotesKnown: quotes.size, quotesAgeMs: quotesLastOk ? Date.now() - quotesLastOk : null, unpricedQuotes,
      seedsInFlight, seedsQueued: seedQueue.length, seededWallets: seeded.size,
      msSinceLastEvent: lastEventAt ? Date.now() - lastEventAt : null,
    }));
    return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocket.Server({ server });

const perIp = new Map();   // ip -> live session count
function ipOf(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const authed = url.searchParams.get('token') === TOKEN;
  if (!authed && !PUBLIC) { send(ws, { type: 'error', message: 'Bad relay token' }); ws.close(1008, 'bad token'); return; }

  const ip = ipOf(req);
  if (!authed) {
    if (sessions.size >= MAX_SESSIONS) {
      send(ws, { type: 'error', message: 'The relay is full right now — try again in a minute.' });
      ws.close(1013, 'full'); return;
    }
    if ((perIp.get(ip) || 0) >= MAX_PER_IP) {
      send(ws, { type: 'error', message: 'Too many connections from your address.' });
      ws.close(1008, 'per-ip limit'); return;
    }
  }

  let wallets = new Set((url.searchParams.get('wallets') || '').split(/[\s,]+/).filter((w) => B58.test(w)));
  if (!wallets.size) { send(ws, { type: 'error', message: 'No valid wallet address given' }); ws.close(1008, 'no wallets'); return; }
  const cap = authed ? MAX_WALLETS_AUTHED : MAX_WALLETS;
  if (wallets.size > cap) {
    wallets = new Set([...wallets].slice(0, cap));   // watch what we can rather than refusing outright
    send(ws, { type: 'error', message: 'Watching the first ' + cap + ' wallets; this relay allows ' + cap + ' per connection.' });
  }
  const session = { ws, wallets, alive: true, ip, authed };
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  sessions.add(session); rebuildWatched();
  console.log(`[client] +${[...wallets].map((w) => w.slice(0, 6) + '…').join(',')} (${sessions.size} clients)`);
  ws.on('pong', () => { session.alive = true; });
  ws.on('close', () => {
    sessions.delete(session); rebuildWatched();
    const n = (perIp.get(session.ip) || 1) - 1;
    if (n > 0) perIp.set(session.ip, n); else perIp.delete(session.ip);
    console.log(`[client] - (${sessions.size} clients)`);
  });
  ws.on('error', () => {});
  await Promise.all([...wallets].map(seedWallet));
  rebuildHeld();
  const pos = [];
  for (const w of wallets) pos.push(...openPositions(w));
  await lookupSymbols(pos.map((p) => p.mint));
  send(ws, { type: 'hello', wallets: [...wallets], positions: pos, firehose: firehoseUp, solUsd: solUsd || null });
});

setInterval(() => {
  for (const s of sessions) {
    if (!s.alive) { try { s.ws.terminate(); } catch {} continue; }
    s.alive = false; try { s.ws.ping(); } catch {}
    send(s.ws, { type: 'status', firehose: firehoseUp, heartbeat: true, solUsd: solUsd || null });
  }
}, 25000);

server.listen(PORT, HOST, () => console.log(`pet-relay listening on ws://${HOST}:${PORT} (firehose ${FIREHOSE_URL})`));
connectFirehose();
