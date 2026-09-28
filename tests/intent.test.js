const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
require('./helpers/env');
const { normalizeRecipients } = require('../ai-agent');

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';

test('accepts the documented recipients array shape', () => {
  const result = normalizeRecipients({
    recipients: [
      { to: '@alice', amount: '0.01' },
      { to: 'vitalik.eth', amount: 0.02 }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.recipients.length, 2);
  assert.deepEqual(result.recipients[0], {
    to: '@alice',
    original: '@alice',
    amount: '0.01',
    amountWei: '10000000000000000'
  });
  assert.equal(result.recipients[1].amountWei, '20000000000000000');
});

test('accepts singular and provider-specific parameter variants', () => {
  const singular = normalizeRecipients({ recipient: ALICE, amount: '0.5' });
  assert.equal(singular.ok, true);
  assert.equal(singular.recipients[0].to, ALICE);
  assert.equal(singular.recipients[0].amount, '0.5');

  const addressValue = normalizeRecipients({ recipients: [{ address: BOB, value: '1' }] });
  assert.equal(addressValue.ok, true);
  assert.equal(addressValue.recipients[0].to, BOB);
  assert.equal(addressValue.recipients[0].amount, '1.0');
});

test('canonicalises amounts to exact wei without float drift', () => {
  const result = normalizeRecipients({ recipients: [{ to: ALICE, amount: '0.010' }] });
  assert.equal(result.recipients[0].amount, '0.01');
  assert.equal(result.recipients[0].amountWei, ethers.parseEther('0.01').toString());

  const split = normalizeRecipients({
    recipients: [
      { to: ALICE, amount: '0.1' },
      { to: BOB, amount: '0.2' }
    ]
  });
  const total = split.recipients.reduce((sum, r) => sum + BigInt(r.amountWei), 0n);
  assert.equal(total, ethers.parseEther('0.3'));
});

test('rejects empty or unusable recipient lists', () => {
  assert.match(normalizeRecipients({}).error, /need recipient\(s\)/);
  assert.match(normalizeRecipients({ recipients: [] }).error, /need recipient\(s\)/);
  assert.match(normalizeRecipients({ recipient: ALICE }).error, /need recipient\(s\)/);
  assert.equal(normalizeRecipients(null).ok, false);
});

test('rejects unsafe amounts that float parsing used to accept', () => {
  const cases = ['-1', '0', '0x10', '1e5', '1e-7', 'NaN', 'Infinity', '1000000', '', 'abc'];
  for (const amount of cases) {
    const result = normalizeRecipients({ recipient: ALICE, amount });
    assert.equal(result.ok, false, `expected rejection for amount ${JSON.stringify(amount)}`);
    assert.match(result.error, /positive number of ETH/);
  }
  assert.equal(normalizeRecipients({ recipient: ALICE, amount: null }).ok, false);
  assert.equal(normalizeRecipients({ recipient: ALICE, amount: undefined }).ok, false);
  assert.equal(normalizeRecipients({ recipient: ALICE, amount: { valueOf: () => 1 } }).ok, false);
});

test('rejects recipients that are not strings', () => {
  for (const to of [null, undefined, 42, {}, [ALICE]]) {
    const result = normalizeRecipients({ recipients: [{ to, amount: '0.1' }] });
    assert.equal(result.ok, false, `expected rejection for recipient ${JSON.stringify(to)}`);
  }
});

test('caps the number of recipients in a single payment', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ to: ALICE, amount: '0.001', i }));
  const result = normalizeRecipients({ recipients: many });
  assert.equal(result.ok, false);
  assert.match(result.error, /at most 10 recipients/);

  const exact = Array.from({ length: 10 }, () => ({ to: ALICE, amount: '0.001' }));
  assert.equal(normalizeRecipients({ recipients: exact }).ok, true);
});

test('trims whitespace around addresses and handles', () => {
  const result = normalizeRecipients({ recipient: `  ${ALICE}  `, amount: ' 0.01 ' });
  assert.equal(result.ok, true);
  assert.equal(result.recipients[0].to, ALICE);
  assert.equal(result.recipients[0].amount, '0.01');
});
