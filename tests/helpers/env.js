const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intentpay-test-'));

process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
process.env.RPC_URL = 'http://127.0.0.1:9/unused-in-tests';
process.env.OPENROUTER_API_KEY = 'your_openrouter_key_here';
process.env.INTENTPAY_DATA_DIR = dataDir;
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.PORT = '0';

module.exports = { dataDir };
