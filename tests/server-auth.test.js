const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStubRpc } = require('./helpers/stub-rpc');

// The stub RPC must be bound before the provider is constructed at require time.
const STUB_PORT = 45991;
const stubRpc = createStubRpc();
stubRpc.listen(STUB_PORT, '127.0.0.1');

require('./helpers/env');
process.env.RPC_URL = `http://127.0.0.1:${STUB_PORT}`;

const { app } = require('../server');
const walletManager = require('../wallet-manager');

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const PASSWORD = 'correct-horse-battery';

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    stubRpc.once('listening', resolve);
    stubRpc.once('error', reject);
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await new Promise((resolve) => stubRpc.close(resolve));
});

async function api(route, { method = 'GET', body, token, userId, password } = {}) {
  const headers = { Connection: 'close' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (userId) headers['x-user-id'] = userId;
  if (password) headers['x-password'] = password;

  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json() };
}

async function signUp(userId, password = PASSWORD) {
  const res = await api('/signup', { method: 'POST', body: { userId, password } });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.token);
  return res.data.token;
}

test('POST /api/wallet cannot be used to create an unauthenticated account', async () => {
  const res = await api('/wallet/ghost-user', { method: 'POST', body: { password: 'anything' } });
  assert.equal(res.status, 401);
  assert.equal(walletManager.getWallet('ghost-user'), undefined);
});

test('POST /api/wallet requires the account password for an existing user', async () => {
  const token = await signUp('wallet-owner');

  const noAuth = await api('/wallet/wallet-owner', { method: 'POST', body: {} });
  assert.equal(noAuth.status, 401);

  const wrongPassword = await api('/wallet/wallet-owner', { method: 'POST', body: {}, password: 'wrong' });
  assert.equal(wrongPassword.status, 401);
  assert.match(wrongPassword.data.message, /Invalid credentials/);

  const authorized = await api('/wallet/wallet-owner', { method: 'POST', body: {}, token });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.data.created, false);
  assert.equal(authorized.data.address, walletManager.getWallet('wallet-owner').address);
});

test('a session token cannot act on behalf of another user', async () => {
  const token = await signUp('user-a');
  await signUp('user-b');

  const spoofed = await api('/wallet/user-b', { method: 'POST', body: {}, token });
  assert.equal(spoofed.status, 403);
  assert.match(spoofed.data.message, /Token does not match/);

  const spoofedHistory = await api('/history/user-b', { token, userId: 'user-b' });
  assert.equal(spoofedHistory.status, 403);

  const spoofedTx = await api('/transaction/user-b', {
    method: 'POST',
    token,
    body: { recipient: ALICE, amount: '0.01' }
  });
  assert.equal(spoofedTx.status, 403);
});

test('protected reads reject anonymous requests without leaking account existence', async () => {
  await signUp('known-user');

  for (const route of ['/wallet/no-such-user', '/history/no-such-user', '/security-status/no-such-user', '/wallet/known-user']) {
    const res = await api(route);
    assert.equal(res.status, 401, `${route} should require credentials`);
    assert.match(res.data.message, /Invalid credentials|User ID is required/);
  }
});

test('POST /api/transaction rejects malformed and unsafe amounts before touching the chain', async () => {
  const token = await signUp('tx-guard');

  const badAddress = await api('/transaction/tx-guard', {
    method: 'POST', token, body: { recipient: 'definitely-not-an-address', amount: '0.01' }
  });
  assert.equal(badAddress.status, 400);
  assert.match(badAddress.data.message, /Invalid recipient address/);

  for (const amount of ['-1', '0', '0x10', '1e5', 'abc', 1001]) {
    const res = await api('/transaction/tx-guard', {
      method: 'POST', token, body: { recipient: ALICE, amount }
    });
    assert.equal(res.status, 400, `expected rejection for amount ${JSON.stringify(amount)}`);
    assert.match(res.data.message, /positive number of ETH/);
  }

  for (const body of [{ recipient: ALICE }, { recipient: ALICE, amount: '' }, { recipient: ALICE, amount: null }, { amount: '1' }]) {
    const res = await api('/transaction/tx-guard', { method: 'POST', token, body });
    assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(body)}`);
    assert.match(res.data.message, /recipient and amount are required/);
  }

  assert.equal(walletManager.getDailySpendState('tx-guard').spentTodayWei, 0n);
});

test('POST /api/transaction enforces the recipient whitelist', async () => {
  const token = await signUp('wl-http');
  walletManager.updateGuardrails('wl-http', '10', [ALICE]);

  const blocked = await api('/transaction/wl-http', {
    method: 'POST', token, body: { recipient: BOB, amount: '0.01' }
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.message, /not on your whitelist/);

  // Whitelisted recipient clears policy and reaches the balance check (stub reports 0).
  const allowed = await api('/transaction/wl-http', {
    method: 'POST', token, body: { recipient: ALICE, amount: '0.01' }
  });
  assert.equal(allowed.status, 400);
  assert.match(allowed.data.message, /Insufficient balance/);
  assert.equal(walletManager.getDailySpendState('wl-http').spentTodayWei, 0n);
});

test('POST /api/transaction checks balance before reserving daily spend', async () => {
  const token = await signUp('lim-http');
  walletManager.updateGuardrails('lim-http', '0.05', undefined);

  const balanceBlocked = await api('/transaction/lim-http', {
    method: 'POST', token, body: { recipient: ALICE, amount: '0.01' }
  });
  assert.equal(balanceBlocked.status, 400);
  assert.match(balanceBlocked.data.message, /Insufficient balance/);

  const wallet = walletManager.getSafeWallet('lim-http');
  assert.equal(walletManager.getDailySpendState('lim-http').spentTodayWei, 0n);
  assert.equal(wallet.transactions.length, 0);
  assert.equal(wallet.guardrails.dailyLimit, '0.05');
});

test('POST /api/record-tx validates the payload and refuses impersonation', async () => {
  const token = await signUp('rec-a');
  await signUp('rec-b');

  const junk = await api('/record-tx', { method: 'POST', token, body: { tx: { to: 'nope', amount: '1' } } });
  assert.equal(junk.status, 400);
  assert.match(junk.data.message, /rejected as invalid/);

  const missing = await api('/record-tx', { method: 'POST', token, body: {} });
  assert.equal(missing.status, 400);

  const spoofed = await api('/record-tx', {
    method: 'POST',
    token,
    body: { userId: 'rec-b', tx: { to: ALICE, amount: '0.01', status: 'success' } }
  });
  assert.equal(spoofed.status, 403);
  assert.equal(walletManager.getWallet('rec-a').transactions.length, 0);
  assert.equal(walletManager.getWallet('rec-b').transactions.length, 0);

  const ok = await api('/record-tx', {
    method: 'POST',
    token,
    userId: 'rec-a',
    body: { userId: 'rec-a', tx: { to: ALICE, amount: '0.01', status: 'success', hash: '0x' + 'cd'.repeat(32) } }
  });
  assert.equal(ok.status, 200);
  assert.equal(walletManager.getWallet('rec-a').transactions.length, 1);
  assert.equal(walletManager.getWallet('rec-b').transactions.length, 0);
});

test('auth sessions on disk never contain the plaintext password', async () => {
  const token = await signUp('session-user');
  const sessionsFile = path.join(process.env.INTENTPAY_DATA_DIR, 'auth-sessions.json');
  const raw = fs.readFileSync(sessionsFile, 'utf8');

  assert.ok(raw.includes(token), 'session token should be persisted');
  assert.ok(!raw.includes(PASSWORD), 'plaintext password must not be persisted');
  assert.ok(!raw.includes('"password"'), 'no plaintext password field is allowed');

  const sessions = JSON.parse(raw);
  assert.equal(walletManager.unsealSecret(sessions[token].passwordSecret), PASSWORD);

  const me = await api('/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.userId, 'session-user');

  const wrongToken = await api('/auth/me', { token: 'deadbeef' });
  assert.equal(wrongToken.status, 401);
});

test('logout revokes the session and the old token stops working', async () => {
  const token = await signUp('logout-user');

  const before = await api('/auth/me', { token });
  assert.equal(before.status, 200);

  const logout = await api('/logout', { method: 'POST', token });
  assert.equal(logout.status, 200);

  const after = await api('/auth/me', { token });
  assert.equal(after.status, 401);
});

test('refresh rotates the session token', async () => {
  const token = await signUp('refresh-user');

  const refreshed = await api('/auth/refresh', { method: 'POST', token });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.data.token);
  assert.notEqual(refreshed.data.token, token);

  assert.equal((await api('/auth/me', { token })).status, 401);
  assert.equal((await api('/auth/me', { token: refreshed.data.token })).status, 200);
});

test('password reset invalidates existing sessions', async () => {
  const token = await signUp('reset-user');

  const reset = await api('/chat', {
    method: 'POST',
    token,
    body: { message: 'reset password to a-new-secret-9' }
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.passwordUpdated, true);

  assert.equal((await api('/auth/me', { token })).status, 401);
  assert.equal((await api('/login', { method: 'POST', body: { userId: 'reset-user', password: 'a-new-secret-9' } })).status, 200);
});

test('chat allows an unknown user through but never creates or exposes a wallet', async () => {
  const res = await api('/chat', {
    method: 'POST',
    body: { userId: 'never-registered', message: 'send 0.01 ETH to ' + ALICE }
  });
  assert.equal(res.status, 200);
  assert.match(res.data.message, /API Key Missing/);
  assert.equal(walletManager.getWallet('never-registered'), undefined);
});

test('health endpoint stays public', async () => {
  const res = await api('/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
});
