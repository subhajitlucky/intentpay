const http = require('http');

// Minimal JSON-RPC stub: answers balance/chain calls and refuses everything else.
function createStubRpc({ balance = '0x0' } = {}) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch (e) {
        payload = {};
      }

      const answer = (single) => {
        if (single.method === 'eth_getBalance') return balance;
        if (single.method === 'eth_chainId') return '0xaa36a7';
        if (single.method === 'net_version') return '11155111';
        if (single.method === 'eth_blockNumber') return '0x2';
        if (single.method === 'eth_gasPrice') return '0x3b9aca00';
        if (single.method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
        if (single.method === 'eth_getBlockByNumber') {
          return {
            number: '0x2',
            hash: '0x' + '11'.repeat(32),
            parentHash: '0x' + '00'.repeat(32),
            timestamp: '0x65000000',
            gasLimit: '0x1c9c380',
            gasUsed: '0x0',
            baseFeePerGas: '0x3b9aca00',
            miner: '0x' + '00'.repeat(20),
            difficulty: '0x0',
            extraData: '0x',
            nonce: '0x0000000000000000',
            transactions: [],
            sha3Uncles: '0x' + '00'.repeat(32),
            logsBloom: '0x' + '00'.repeat(256),
            stateRoot: '0x' + '00'.repeat(32),
            receiptsRoot: '0x' + '00'.repeat(32),
            size: '0x0',
            uncles: []
          };
        }
        if (single.method === 'eth_feeHistory') {
          return {
            oldestBlock: '0x1',
            baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'],
            gasUsedRatio: [0.5],
            reward: [['0x3b9aca00']]
          };
        }
        return { __error: { code: -32601, message: `${single.method} is not supported in tests` } };
      };

      const single = (entry) => {
        const result = answer(entry);
        if (result && result.__error) {
          return { jsonrpc: '2.0', id: entry.id ?? null, error: result.__error };
        }
        return { jsonrpc: '2.0', id: entry.id ?? null, result };
      };

      const responses = Array.isArray(payload) ? payload.map(single) : single(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responses));
    });
  });
}

module.exports = { createStubRpc };
