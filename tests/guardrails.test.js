const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
require('./helpers/env');
const walletManager = require('../wallet-manager');

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';

async function newUser(userId, password = 'correct-horse-battery') {
  const result = await walletManager.createWallet(userId, password);
  assert.equal(result.success, true);
  await walletManager.setPaymentSecret(userId, '1234');
  return result;
}

test('toWeiAmount accepts plain decimal ETH values exactly', () => {
  assert.equal(walletManager.toWeiAmount('0.01'), 10_000_000_000_000_000n);
  assert.equal(walletManager.toWeiAmount('1'), 1_000_000_000_000_000_000n);
  assert.equal(walletManager.toWeiAmount(0.5), 500_000_000_000_000_000n);
  assert.equal(walletManager.toWeiAmount(' 0.25 '), 250_000_000_000_000_000n);
  assert.equal(walletManager.toWeiAmount(ethers.parseEther('3')), 3_000_000_000_000_000_000n);
  assert.equal(walletManager.toWeiAmount('0.000000000000000001'), 1n);
  assert.equal(walletManager.toWeiAmount('1000'), 1_000_000_000_000_000_000_000n);
});

test('toWeiAmount rejects malformed, negative and oversized values', () => {
  const rejected = [
    '0', '0.0', 0, '-1', '-0.5', '0x10', '1e5', '1e-7', 'Infinity', 'NaN', 'abc', '',
    '   ', '1,5', '1.5 ETH', 'null', '0.0000000000000000001', '1000.000000000000000001',
    1001, -0.01, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, [], true
  ];
  for (const value of rejected) {
    assert.equal(walletManager.toWeiAmount(value), null, `expected rejection for ${String(value)}`);
  }
});

test('toWeiAmount allowZero is only used for limits', () => {
  assert.equal(walletManager.toWeiAmount('0'), null);
  assert.equal(walletManager.toWeiAmount('0', { allowZero: true }), 0n);
  assert.equal(walletManager.toWeiAmount('-1', { allowZero: true }), null);
  assert.equal(walletManager.toWeiAmount('0', { allowZero: true, maxWei: 0n }), 0n);
});

test('formatEthAmount produces canonical wei-safe decimals', () => {
  assert.equal(walletManager.formatEthAmount(10_000_000_000_000_000n), '0.01');
  assert.equal(walletManager.formatEthAmount(1n), '0.000000000000000001');
  assert.equal(walletManager.formatEthAmount(ethers.parseEther('1.2300')), '1.23');
});

test('sealSecret and unsealSecret round-trip without storing plaintext', () => {
  const sealed = walletManager.sealSecret('super-secret-password');
  assert.notEqual(sealed.encryptedData, 'super-secret-password');
  assert.equal(walletManager.unsealSecret(sealed), 'super-secret-password');
  assert.equal(walletManager.unsealSecret(null), null);
  assert.equal(walletManager.unsealSecret({ encryptedData: 'ff', iv: '00', authTag: '00' }), null);
  assert.equal(walletManager.sealSecret(''), null);
});

test('empty whitelist means unrestricted, populated whitelist blocks outsiders', async () => {
  await newUser('wl-user');
  assert.equal(walletManager.isAddressWhitelisted('wl-user', ALICE), true);

  walletManager.updateGuardrails('wl-user', undefined, [ALICE]);
  assert.equal(walletManager.isAddressWhitelisted('wl-user', ALICE), true);
  assert.equal(walletManager.isAddressWhitelisted('wl-user', ALICE.toUpperCase().replace('0X', '0x')), true);
  assert.equal(walletManager.isAddressWhitelisted('wl-user', BOB), false);
  assert.equal(walletManager.isAddressWhitelisted('wl-user', 'not-an-address'), false);
  assert.equal(walletManager.isAddressWhitelisted('wl-user', undefined), false);

  const blocked = walletManager.findBlockedRecipient('wl-user', [{ to: ALICE }, { to: BOB }]);
  assert.equal(blocked.to, BOB);
  assert.equal(walletManager.findBlockedRecipient('wl-user', [{ to: ALICE }]), null);
});

test('updateGuardrails validates the daily limit and filters the whitelist', async () => {
  await newUser('gr-user');

  assert.equal(walletManager.updateGuardrails('gr-user', 'abc', undefined).success, false);
  assert.equal(walletManager.updateGuardrails('gr-user', '-5', undefined).success, false);
  assert.equal(walletManager.updateGuardrails('gr-user', '1e9', undefined).success, false);
  assert.equal(walletManager.updateGuardrails('gr-user', undefined, 'ALICE').success, false);
  assert.equal(walletManager.getWallet('gr-user').guardrails.dailyLimit, '1.0');

  assert.equal(walletManager.updateGuardrails('gr-user', '0.5', undefined).success, true);
  assert.equal(walletManager.getWallet('gr-user').guardrails.dailyLimit, '0.5');

  const filtered = walletManager.updateGuardrails('gr-user', undefined, [ALICE, 'nope', BOB, ALICE]);
  assert.equal(filtered.success, true);
  assert.match(filtered.message, /1 invalid address\(es\) were ignored/);
  assert.deepEqual(walletManager.getWallet('gr-user').guardrails.whitelist, [ALICE, BOB]);

  assert.equal(walletManager.updateGuardrails('gr-user', '0', undefined).success, true);
  assert.equal(walletManager.getWallet('gr-user').guardrails.dailyLimit, '0.0');
  assert.equal(walletManager.isAddressWhitelisted('gr-user', BOB), true);
});

test('daily limit reservations accumulate and block overspend', async () => {
  await newUser('lim-user');
  walletManager.updateGuardrails('lim-user', '1.0', undefined);

  const first = walletManager.reserveDailySpend('lim-user', '0.4');
  assert.equal(first.ok, true);
  const second = walletManager.reserveDailySpend('lim-user', '0.6');
  assert.equal(second.ok, true);

  const third = walletManager.reserveDailySpend('lim-user', '0.000000000000000001');
  assert.equal(third.ok, false);
  assert.match(third.reason, /Daily spending limit exceeded/);
  assert.equal(walletManager.getWallet('lim-user').guardrails.spentToday, '1.0');
});

test('releasing a reservation returns capacity and clamps at zero', async () => {
  await newUser('rel-user');
  walletManager.updateGuardrails('rel-user', '1.0', undefined);

  walletManager.reserveDailySpend('rel-user', '0.5');
  assert.equal(walletManager.releaseDailySpend('rel-user', '0.2'), true);
  assert.equal(walletManager.getWallet('rel-user').guardrails.spentToday, '0.3');
  assert.equal(walletManager.releaseDailySpend('rel-user', '5'), true);
  assert.equal(walletManager.getWallet('rel-user').guardrails.spentToday, '0.0');
  assert.equal(walletManager.releaseDailySpend('rel-user', 'not-a-number'), false);
  assert.equal(walletManager.reserveDailySpend('rel-user', 'not-a-number').ok, false);
  assert.equal(walletManager.reserveDailySpend('nobody', '0.1').ok, false);
});

test('daily spend rolls over on a new day', async () => {
  await newUser('roll-user');
  walletManager.updateGuardrails('roll-user', '1.0', undefined);
  walletManager.reserveDailySpend('roll-user', '0.9');

  const walletsFile = path.join(process.env.INTENTPAY_DATA_DIR, 'wallets.json');
  const raw = JSON.parse(fs.readFileSync(walletsFile, 'utf8'));
  raw['roll-user'].guardrails.lastSpentDate = '2000-01-01';
  fs.writeFileSync(walletsFile, JSON.stringify(raw), 'utf8');

  const state = walletManager.getDailySpendState('roll-user');
  assert.equal(state.spentTodayWei, 0n);
  assert.equal(walletManager.reserveDailySpend('roll-user', '0.5').ok, true);
  assert.equal(walletManager.getDailySpendState('roll-user').spentTodayWei, 500_000_000_000_000_000n);
});

test('a zero daily limit blocks every payment', async () => {
  await newUser('zero-limit-user');
  walletManager.updateGuardrails('zero-limit-user', '0', undefined);
  const reservation = walletManager.reserveDailySpend('zero-limit-user', '0.000000000000000001');
  assert.equal(reservation.ok, false);
  assert.match(reservation.reason, /Daily spending limit exceeded/);
});

test('recordTransaction rejects junk and normalises valid entries', async () => {
  await newUser('tx-user');

  assert.equal(walletManager.recordTransaction('tx-user', null), false);
  assert.equal(walletManager.recordTransaction('tx-user', { type: 'send' }), false);
  assert.equal(walletManager.recordTransaction('tx-user', { to: 'nope', amount: '1' }), false);
  assert.equal(walletManager.recordTransaction('tx-user', { to: ALICE }), false);
  assert.equal(walletManager.recordTransaction('tx-user', { to: ALICE, amount: '-1' }), false);
  assert.equal(walletManager.recordTransaction('tx-user', { to: ALICE, amount: '0x10' }), false);
  assert.equal(walletManager.recordTransaction('tx-user', { to: ALICE, amount: '1', status: 'pwned', type: 'steal' }), true);

  const history = walletManager.getWallet('tx-user').transactions;
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'pending');
  assert.equal(history[0].type, 'send');
  assert.equal(history[0].hash, undefined);

  assert.equal(walletManager.recordTransaction('tx-user', {
    to: ALICE,
    amount: '0.010',
    status: 'success',
    type: 'send',
    mode: 'non-custodial',
    hash: '0x' + 'ab'.repeat(32),
    gasUsed: '21000',
    junk: 'dropped'
  }), true);

  const stored = walletManager.getWallet('tx-user').transactions[0];
  assert.equal(stored.amount, '0.01');
  assert.equal(stored.hash, '0x' + 'ab'.repeat(32));
  assert.equal(stored.gasUsed, '21000');
  assert.equal(stored.junk, undefined);
  assert.equal(walletManager.recordTransaction('ghost-user', { to: ALICE, amount: '1' }), false);
});

test('transaction history is capped at 50 entries', async () => {
  await newUser('cap-user');
  for (let i = 0; i < 60; i += 1) {
    walletManager.recordTransaction('cap-user', { to: ALICE, amount: '0.001', status: 'success' });
  }
  const history = walletManager.getWallet('cap-user').transactions;
  assert.equal(history.length, 50);
  assert.ok(history.every((tx) => tx.to === ALICE));
});

test('addContact validates handles and addresses instead of trusting the model', async () => {
  await newUser('contact-user');

  assert.equal(walletManager.addContact('contact-user', undefined, ALICE).success, false);
  assert.equal(walletManager.addContact('contact-user', 42, ALICE).success, false);
  assert.equal(walletManager.addContact('contact-user', 'alice', ALICE).success, false);
  assert.equal(walletManager.addContact('contact-user', '@', ALICE).success, false);
  assert.equal(walletManager.addContact('contact-user', '@al ice', ALICE).success, false);
  assert.equal(walletManager.addContact('contact-user', '@__proto__', ALICE).success, false);
  assert.equal(walletManager.addContact('contact-user', '@../etc', ALICE).success, false);
  assert.equal(walletManager.addContact('contact-user', '@alice', undefined).success, false);
  assert.equal(walletManager.addContact('contact-user', '@alice', 'alice-at-example-dot-com').success, false);
  assert.equal(walletManager.addContact('contact-user', '@alice', '0xnothex').success, false);
  assert.deepEqual(walletManager.getWallet('contact-user').contacts, {});

  assert.equal(walletManager.addContact('contact-user', '@Alice', ALICE).success, true);
  assert.equal(walletManager.addContact('contact-user', '@alice', 'vitalik.eth').success, false);
  assert.equal(walletManager.addContact('contact-user', '@alice', ALICE.toUpperCase().replace('0X', '0x')).success, true);
  assert.equal(walletManager.getWallet('contact-user').contacts['@alice'], ALICE);
  assert.equal(walletManager.getContactAddress('contact-user', '@ALICE'), ALICE);
  assert.equal(walletManager.addContact('ghost-user', '@alice', ALICE).success, false);
});

test('safe wallet view never leaks key material or hashes', async () => {
  await newUser('safe-user');
  const safe = walletManager.getSafeWallet('safe-user');
  const raw = walletManager.getWallet('safe-user');

  for (const secret of ['hashedPassword', 'paymentSecretHash', 'encryptedKey', 'iv', 'authTag', 'keySalt']) {
    assert.equal(safe[secret], undefined, `${secret} must not be exposed`);
  }
  assert.ok(raw.encryptedKey);
  assert.equal(safe.address, raw.address);
});
