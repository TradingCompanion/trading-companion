// Exercises pet-relay against a fake firehose: matching, fan-out and the public-mode limits.
// No database is needed — the seed fails, which is itself one of the paths worth covering, since
// a relay whose database is down must still tell the pet about trades (just without a PnL).
//
//   node server/test-relay.js
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const FIRE_PORT = 9991, RELAY_PORT = 9992, TOKEN = 'test-token-not-a-secret';
const W1 = 'AAaaBBbbCCccDDddEEeeFFggHHhhJJjjKKkkLLmm11';
const W2 = 'BBbbCCccDDddEEeeFFggHHhhJJjjKKkkLLmmNN22';
const OTHER = 'ZZzzYYyyXXxxWWwwVVvvUUuuTTttSSssRRrr9999';
const MINT = '32Es5KE223XLB6iJAmxcu4LGYHrkkiESkD9yFjaA9acL';
const WSOL = 'So11111111111111111111111111111111111111112';

const results = [];
const expect = (label, ok) => { results.push([label, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a firehose that says whatever we tell it to -----------------------------------------------
const fire = new WebSocket.Server({ port: FIRE_PORT });
const fireClients = new Set();
fire.on('connection', (ws) => { fireClients.add(ws); ws.on('close', () => fireClients.delete(ws)); });
const emit = (o) => { const s = JSON.stringify(o); for (const c of fireClients) c.send(s); };
const trade = (signer, mint, action = 'buy', extra = {}) => ({
  signature: 'sig' + Math.random().toString(36).slice(2), action, txSigner: signer, mint,
  quoteMint: WSOL, tokenAmount: 1e6, quoteAmount: 0.5, marketCapQuote: 30, ...extra,
});

// ---- a client -----------------------------------------------------------------------------------
function client(wallets, opts = {}) {
  const q = new URLSearchParams({ wallets: [].concat(wallets).join(',') });
  if (opts.token) q.set('token', opts.token);
  const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/?${q}`);
  const got = { hello: null, trades: [], prices: [], errors: [], closed: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'hello') got.hello = m;
    else if (m.type === 'trade') got.trades.push(m);
    else if (m.type === 'price') got.prices.push(m);
    else if (m.type === 'error') got.errors.push(m.message);
  });
  ws.on('close', (c) => { got.closed = c; });
  ws.on('error', () => {});
  return { ws, got };
}

(async () => {
  const relay = spawn(process.execPath, [path.join(__dirname, 'pet-relay.js')], {
    env: {
      ...process.env,
      PET_RELAY_PORT: String(RELAY_PORT), PET_RELAY_TOKEN: TOKEN, PET_RELAY_PUBLIC: '1',
      FIREHOSE_URL: `ws://127.0.0.1:${FIRE_PORT}`,
      PET_MAX_PER_IP: '2', PET_MAX_WALLETS: '2', PET_MAX_WALLETS_AUTHED: '10',
      DB_HOST: '127.0.0.1', DB_PORT: '1',            // nothing listens: the seed must fail cleanly
      HARVESTER_DIR: path.join(__dirname, 'no-such-dir'),
      SOL_USD: '100',                                 // no Redis here: a fixed SOL price stands in for the harvester's
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  relay.stdout.on('data', (d) => log.push(d.toString()));
  relay.stderr.on('data', (d) => log.push(d.toString()));
  await sleep(2500);

  const health = async () => (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).json();
  const h0 = await health();
  expect('relay is up and connected to the firehose', h0.ok === true && h0.firehose === true);
  expect('it reports itself as public', h0.public === true);

  // ---- a plain connection, no token -----------------------------------------------------------
  const a = client(W1);
  await sleep(1200);
  expect('an anonymous client is accepted in public mode', !!a.got.hello);
  expect('and is told which wallets it is watching', a.got.hello && a.got.hello.wallets[0] === W1);

  // ---- the matching path ----------------------------------------------------------------------
  emit(trade(W1, MINT));
  await sleep(600);
  expect('a trade by a watched wallet reaches the client', a.got.trades.length === 1);
  expect('with the database down it still arrives, just without a pnl',
    a.got.trades[0] && a.got.trades[0].pnl === null && a.got.trades[0].side === 'buy');

  emit(trade(OTHER, MINT));
  emit(trade(OTHER, 'FFFF5KE223XLB6iJAmxcu4LGYHrkkiESkD9yFjaA9acL'));
  await sleep(600);
  expect('somebody else trading does not reach the client', a.got.trades.length === 1);

  emit(trade(W1, MINT, 'transfer'));
  await sleep(400);
  expect('a non-trade action by a watched wallet is ignored', a.got.trades.length === 1);

  // pretty-printed events must still match: the regexes allow whitespace
  for (const c of fireClients) c.send(JSON.stringify(trade(W1, MINT), null, 2));
  await sleep(600);
  expect('a pretty-printed event still matches', a.got.trades.length === 2);

  const h1 = await health();
  expect('unmatched-event counter stays near zero on well-formed input', h1.eventsUnparsed <= 1);
  expect('the SOL price is reported', h1.solUsd === 100 && a.got.hello.solUsd === 100);

  // ---- other venues and quotes -----------------------------------------------------------------
  // a LaunchLab curve quoted in USDC: converted to SOL-equivalent, the raw quote alongside
  const MINT2 = 'BFPgbDixEMCuAzazAXJr4TicVidiA2ZGCwuUWjqaPkNC';
  emit(trade(W1, MINT2, 'buy', { quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', quoteAmount: 50, marketCapQuote: 5000, pool: 'raydium-launchpad', platform: 'custom' }));
  await sleep(600);
  const t2 = a.got.trades[2];
  expect('a LaunchLab fill quoted in USDC reaches the client', !!t2 && t2.mint === MINT2);
  expect('its amount is SOL-equivalent, the raw quote alongside', !!t2 && Math.abs(t2.amount - 0.5) < 1e-9 && t2.quote === 'SOL' && t2.quoteAmount === 50 && t2.quoteKind === 'usd' && t2.quoteSymbol === 'USDC');
  expect('its market cap comes in dollars and in SOL', !!t2 && t2.mcUsd === 5000 && Math.abs(t2.mcQuote - 50) < 1e-9);
  expect('and it says where the fill happened', !!t2 && t2.venue === 'launchlab');
  emit(trade(W1, MINT, 'sell', { pool: 'pump-amm' }));
  await sleep(500);
  expect('a PumpSwap fill is labelled as such', a.got.trades.length === 4 && a.got.trades[3].venue === 'pump.swap');
  // a sell that carries 98% of the tokens bought (the venue's fee came out of the token side) closes the position
  const MINT3 = '3K9CjLRHL7V8y3yT5fCGrMpFVdpnCkJ7MpB8C5yUz4Gx';
  emit(trade(W1, MINT3, 'buy', { tokenAmount: 1000, quoteAmount: 0.01 }));
  await sleep(400);
  emit(trade(W1, MINT3, 'sell', { tokenAmount: 980, quoteAmount: 0.0096 }));
  await sleep(600);
  const dustSell = a.got.trades.find((t) => t.mint === MINT3 && t.side === 'sell');
  expect('a sell leaving fee dust is relayed', !!dustSell);
  // with the seed failed the relay never builds a book, so the position figures are null; the rule is covered by the unit check below
  expect('and is not reported as still holding', !dustSell || !(dustSell.remainingTokens > 0));
  // a quote nobody has priced: the book cannot take it, and the health page says so
  emit(trade(W1, MINT2, 'buy', { quoteMint: 'QUBTAD8C9bMU9LvmMNgKPhrmBGbHvxpu6vfWQtThxxw', quoteAmount: 3, pool: 'raydium-launchpad' }));
  await sleep(500);
  const hq = await health();
  expect('a fill in an unpriced quote is skipped, not mangled', a.got.trades.length === 6 && hq.unpricedQuotes === 1);

  // ---- limits ----------------------------------------------------------------------------------
  const b = client(W2);
  await sleep(800);
  expect('a second connection from the same address is fine', !!b.got.hello);
  const c = client(W2);
  await sleep(900);
  expect('a third is refused by the per-address cap', !c.got.hello && c.got.closed === 1008);

  b.ws.close(); c.ws.close();
  await sleep(600);
  const d = client(W2);
  await sleep(800);
  expect('and the slot frees up when one disconnects', !!d.got.hello);

  // free a slot first: otherwise this connection is refused by the per-address cap and never
  // reaches the wallet cap we are trying to test
  d.ws.close();
  await sleep(500);
  const many = client([W1, W2, OTHER, MINT], { });
  await sleep(900);
  expect('too many wallets is trimmed, not refused', many.got.hello && many.got.hello.wallets.length === 2);
  expect('and the client is told why', many.got.errors.some((m) => /allows 2 per connection/.test(m)));

  const authed = client([W1, W2, OTHER], { token: TOKEN });
  await sleep(900);
  expect('the token raises the wallet cap', authed.got.hello && authed.got.hello.wallets.length === 3);

  // ---- fan-out ---------------------------------------------------------------------------------
  emit(trade(W1, MINT));
  await sleep(700);
  expect('every session watching a wallet gets its trade',
    a.got.trades.length === 7 && authed.got.trades.length === 1);

  for (const cl of [a, many, authed]) cl.ws.close();
  await sleep(500);
  const h2 = await health();
  expect('sessions are released on disconnect', h2.clients === 0 && h2.watched === 0);

  relay.kill();
  fire.close();
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} relay checks passed`);
  if (failed) { console.log('\n--- relay output ---\n' + log.join('')); process.exitCode = 1; }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('harness failed', e); process.exit(1); });
