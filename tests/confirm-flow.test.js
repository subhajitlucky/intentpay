const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStubRpc } = require('./helpers/stub-rpc');

const STUB_PORT = 45992;
const stubRpc = createStubRpc({ balance: '0x0' });
stubRpc.listen(STUB_PORT, '127.0.0.1');

require('./helpers/env');
process.env.RPC_URL = `http://127.0.0.1:${STUB_PORT}`;

const walletManager = require('../wallet-manager');

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const PASSWORD = 'correct-horse-battery';
const SECRET = '1234';
const SESSIONS_FILE = path.join(process.env.INTENTPAY_DATA_DIR, 'sessions.json');

test.before(async () => {
  await new Promise((resolve, reject) => {
    stubRpc.once('listening', resolve);
    stubRpc.once('error', reject);
  });
});

test.after(async () => {
  await new Promise((resolve) => stubRpc.close(resolve));
});

// Sessions are loaded into memory once at require time, so seed the pending state
// on disk first and then load a fresh agent that picks it up.
function seedPendingTx(userId, recipients, extra = {}) {
  const sessions = fs.existsSync(SESSIONS_FILE)
    ? JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
    : {};

  sessions[userId] = {
    userId,
    createdAt: new Date().toISOString(),
    state: {
      pendingTx: {
        recipients,
        mode: 'custodial',
        createdAt: new Date().toISOString(),
        ...extra
      }
    },
    history: []
  };

  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

function loadAgentWithPending(userId, recipients, extra = {}, sessionId = null) {
  const key = sessionId ? `${userId}::${sessionId}` : userId;
  seedPendingTx(key, recipients, extra);
  delete require.cache[require.resolve('../ai-agent')];
  return require('../ai-agent').processCommand;
}

function payment(overrides = {}) {
  return {
    to: ALICE,
    original: '@alice',
    amount: '0.01',
    amountWei: '10000000000000000',
    ...overrides
  };
}

async function signIn(userId) {
  await walletManager.createWallet(userId, PASSWORD);
  await walletManager.setPaymentSecret(userId, SECRET);
}

test('a wrong payment secret never reaches execution', async () => {
  const userId = 'flow-wrong-secret';
  await signIn(userId);
  const processCommand = loadAgentWithPending(userId, [payment()]);

  const res = await processCommand(userId, 'intentpay confirm code 9999', null, 'custodial', PASSWORD);
  assert.equal(res.success, false);
  assert.match(res.message, /Invalid payment secret/);
  assert.equal(walletManager.getDailySpendState(userId).spentTodayWei, 0n);
  assert.equal(walletManager.getWallet(userId).transactions.length, 0);
});

test('repeated wrong secrets trigger a lockout', async () => {
  const userId = 'flow-lockout';
  await signIn(userId);
  const processCommand = loadAgentWithPending(userId, [payment()]);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await processCommand(userId, 'intentpay confirm code 0000', null, 'custodial', PASSWORD);
    assert.equal(res.success, false);
  }

  const locked = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);
  assert.equal(locked.success, false);
  assert.match(locked.message, /Too many incorrect approval attempts/);
  assert.equal(walletManager.getDailySpendState(userId).spentTodayWei, 0n);
});

test('a correct secret executes and releases the reservation when the send fails', async () => {
  const userId = 'flow-execute';
  await signIn(userId);
  const processCommand = loadAgentWithPending(userId, [payment()]);

  const res = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);

  assert.equal(res.success, false);
  assert.match(res.message, /Insufficient funds for ETH \+ Gas/);
  assert.equal(res.details.length, 1);
  assert.equal(res.details[0].success, false);

  // The failed send must not consume the daily allowance.
  assert.equal(walletManager.getDailySpendState(userId).spentTodayWei, 0n);

  const history = walletManager.getWallet(userId).transactions;
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'failed');
  assert.match(history[0].error, /Insufficient funds/);
  assert.equal(history[0].hash, undefined);
});

test('execution re-checks the whitelist and refuses a tampered pending payment', async () => {
  const userId = 'flow-whitelist';
  await signIn(userId);
  walletManager.updateGuardrails(userId, '5', [ALICE]);

  const processCommand = loadAgentWithPending(userId, [payment({ to: BOB, original: BOB })]);

  const res = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);
  assert.equal(res.success, false);
  assert.match(res.message, /not on your whitelist/);
  assert.equal(walletManager.getDailySpendState(userId).spentTodayWei, 0n);
  assert.match(walletManager.getWallet(userId).transactions[0].error, /whitelist/);
});

test('execution refuses recipients that are not valid addresses', async () => {
  const userId = 'flow-bad-address';
  await signIn(userId);

  const processCommand = loadAgentWithPending(userId, [payment({ to: 'alice-at-example-dot-com', original: '@alice' })]);

  const res = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);
  assert.equal(res.success, false);
  assert.match(res.message, /Invalid Ethereum address format/);
  assert.equal(walletManager.getDailySpendState(userId).spentTodayWei, 0n);
});

test('execution refuses self-transfers', async () => {
  const userId = 'flow-self';
  await signIn(userId);
  const own = walletManager.getWallet(userId).address;

  const processCommand = loadAgentWithPending(userId, [payment({ to: own, original: own })]);

  const res = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);
  assert.equal(res.success, false);
  assert.match(res.message, /Refusing to send to the sending address/);
});

test('execution stops at the daily limit even if state was tampered with', async () => {
  const userId = 'flow-limit';
  await signIn(userId);
  walletManager.updateGuardrails(userId, '0.005', undefined);

  const processCommand = loadAgentWithPending(userId, [payment()]);

  const res = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);
  assert.equal(res.success, false);
  assert.match(res.message, /Daily spending limit exceeded/);
  assert.match(walletManager.getWallet(userId).transactions[0].error, /Daily spending limit exceeded/);
});

test('a pending payment can be cancelled without executing', async () => {
  const userId = 'flow-cancel';
  await signIn(userId);
  const processCommand = loadAgentWithPending(userId, [payment()]);

  const res = await processCommand(userId, 'intentpay cancel', null, 'custodial', PASSWORD);
  assert.equal(res.success, true);
  assert.match(res.message, /canceled/);
  assert.equal(walletManager.getWallet(userId).transactions.length, 0);
  assert.equal(walletManager.getDailySpendState(userId).spentTodayWei, 0n);
});

test('a stale pending payment expires', async () => {
  const userId = 'flow-expired';
  await signIn(userId);
  const processCommand = loadAgentWithPending(userId, [payment()], {
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  });

  const res = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);
  assert.equal(res.success, false);
  assert.match(res.message, /expired/);
  assert.equal(walletManager.getWallet(userId).transactions.length, 0);
});

test('any unrelated message cancels a pending payment', async () => {
  const userId = 'flow-interrupt';
  await signIn(userId);
  const processCommand = loadAgentWithPending(userId, [payment()]);

  const first = await processCommand(userId, 'what is my balance?', null, 'custodial', PASSWORD);
  assert.match(first.message, /canceled/);
  assert.equal(walletManager.getWallet(userId).transactions.length, 0);

  // The staged payment is gone, so the secret no longer releases anything.
  const second = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);
  assert.equal(walletManager.getWallet(userId).transactions.length, 0);
});

test('non-custodial mode hands unsigned transactions back to the wallet', async () => {
  const userId = 'flow-noncustodial';
  await signIn(userId);
  const processCommand = loadAgentWithPending(userId, [payment()]);

  const res = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'non-custodial', PASSWORD);

  assert.equal(res.success, true);
  assert.equal(res.action, 'sign_required');
  assert.deepEqual(res.transactions, [{ to: ALICE, value: '10000000000000000', original: '@alice' }]);
  assert.equal(walletManager.getWallet(userId).transactions.length, 0);
  assert.equal(walletManager.getDailySpendState(userId).spentTodayWei, 0n);
});

test('a corrupted pending payment is discarded instead of crashing', async () => {
  const userId = 'flow-corrupt';
  await signIn(userId);
  loadAgentWithPending(userId, 'not-an-array', { recipients: 'not-an-array' });
  const processCommand = require('../ai-agent').processCommand;

  const res = await processCommand(userId, `intentpay confirm code ${SECRET}`, null, 'custodial', PASSWORD);
  assert.equal(res.success, false);
  assert.match(res.message, /no longer valid/);
  assert.equal(walletManager.getWallet(userId).transactions.length, 0);
});

test('the payment secret is never stored in plaintext and cannot be read back', async () => {
  const userId = 'flow-secret-storage';
  await signIn(userId);

  const raw = fs.readFileSync(path.join(process.env.INTENTPAY_DATA_DIR, 'wallets.json'), 'utf8');
  assert.ok(!raw.includes(`"${SECRET}"`), 'payment secret must not be stored in plaintext');
  assert.equal(await walletManager.verifyPaymentSecret(userId, SECRET), true);
  assert.equal(await walletManager.verifyPaymentSecret(userId, '9999'), false);
});

test('a client-supplied session id is scoped to one account', async () => {
  const ownerId = 'flow-session-owner';
  const otherId = 'flow-session-other';
  await signIn(ownerId);
  await signIn(otherId);

  const processCommand = loadAgentWithPending(ownerId, [payment()], {}, 'shared');

  // The other account reusing the same session id must not see the staged payment.
  const other = await processCommand(otherId, `intentpay confirm code ${SECRET}`, 'shared', 'custodial', PASSWORD);
  assert.equal(walletManager.getWallet(otherId).transactions.length, 0);
  assert.equal(walletManager.getDailySpendState(otherId).spentTodayWei, 0n);
  assert.match(other.message, /API Key Missing/);

  // The owner still resolves their own session and the payment executes.
  const owner = await processCommand(ownerId, `intentpay confirm code ${SECRET}`, 'shared', 'custodial', PASSWORD);
  assert.match(owner.message, /Insufficient funds for ETH \+ Gas/);
  assert.equal(walletManager.getWallet(ownerId).transactions.length, 1);
  assert.equal(walletManager.getDailySpendState(ownerId).spentTodayWei, 0n);
});
