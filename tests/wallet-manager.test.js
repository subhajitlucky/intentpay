const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = '0'.repeat(32);

const walletManager = require('../wallet-manager');

const critical = (event = 'Suspicious Transfer') => ({ severity: 'high', event });
const failedLogin = () => ({ severity: 'high', event: 'Failed Login Attempt' });

test('module exposes the wallet management surface', () => {
  for (const fn of ['createWallet', 'getSafeWallet', 'calculateSecurityScore', 'logSecurityEvent']) {
    assert.equal(typeof walletManager[fn], 'function', `${fn} should be exported`);
  }
});

test('starts at 100 with no security events', () => {
  assert.equal(walletManager.calculateSecurityScore([]), 100);
  assert.equal(walletManager.calculateSecurityScore(), 100);
});

test('critical high-severity events cost 10 points each', () => {
  assert.equal(walletManager.calculateSecurityScore([critical()]), 90);
  assert.equal(
    walletManager.calculateSecurityScore([critical(), critical('Rejected Transaction')]),
    80,
  );
});

test('failed login attempts apply only a tiny penalty', () => {
  assert.equal(walletManager.calculateSecurityScore([failedLogin()]), 99.99);
  assert.equal(
    walletManager.calculateSecurityScore(Array.from({ length: 50 }, failedLogin)),
    99.5,
  );
});

test('low and medium severity events do not affect the score', () => {
  const logs = [
    { severity: 'low', event: 'Wallet Viewed' },
    { severity: 'medium', event: 'New Contact Added' },
    { severity: 'info', event: 'Login' },
  ];
  assert.equal(walletManager.calculateSecurityScore(logs), 100);
});

test('combined penalties add up', () => {
  const logs = [critical(), critical('Rejected Transaction'), ...Array.from({ length: 50 }, failedLogin)];
  assert.equal(walletManager.calculateSecurityScore(logs), 79.5);
});

test('score never drops below zero', () => {
  const logs = Array.from({ length: 15 }, () => critical('Rejected Transaction'));
  assert.equal(walletManager.calculateSecurityScore(logs), 0);
});
