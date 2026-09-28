const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');
const { processCommand, provider } = require('./ai-agent');
const walletManager = require('./wallet-manager');
require('dotenv').config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Validate essential env vars on startup
const REQUIRED_ENV = ['RPC_URL', 'ENCRYPTION_KEY', 'OPENROUTER_API_KEY'];
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
});

// Middleware
app.use(helmet()); // Basic security headers
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.requestId = uuidv4();
  const start = Date.now();
  res.setHeader('x-request-id', req.requestId);
  res.on('finish', () => {
    console.log(JSON.stringify({
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start
    }));
  });
  next();
});

// Single generic message so failed auth cannot be used to probe account existence
const INVALID_CREDENTIALS = 'Invalid credentials';

// Rate limiting to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per window
  message: { success: false, message: 'Too many attempts, please try again later.' }
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 chat messages per minute
  message: { success: false, message: 'Slow down! Too many messages.' }
});

const DATA_DIR = process.env.INTENTPAY_DATA_DIR
  ? path.resolve(process.env.INTENTPAY_DATA_DIR)
  : path.join(__dirname, 'data');
const AUTH_SESSIONS_FILE = path.join(DATA_DIR, 'auth-sessions.json');
const authSessions = new Map();
const AUTH_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function ensureAuthSessionStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AUTH_SESSIONS_FILE)) fs.writeFileSync(AUTH_SESSIONS_FILE, JSON.stringify({}), 'utf8');
}

function loadAuthSessions() {
  ensureAuthSessionStorage();
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    let pruned = false;
    Object.entries(raw).forEach(([token, session]) => {
      const isUsable = session
        && session.passwordSecret
        && typeof session.expiresAt === 'number'
        && session.expiresAt > now;
      if (isUsable) {
        authSessions.set(token, session);
      } else {
        pruned = true;
      }
    });
    if (pruned) saveAuthSessions();
  } catch (e) {}
}

function saveAuthSessions() {
  ensureAuthSessionStorage();
  const obj = {};
  for (const [token, session] of authSessions.entries()) obj[token] = session;
  fs.writeFileSync(AUTH_SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function createAuthSession(userId, password) {
  const token = crypto.randomBytes(32).toString('hex');
  authSessions.set(token, {
    userId,
    passwordSecret: walletManager.sealSecret(password),
    authVersion: walletManager.getAuthVersion(userId),
    createdAt: Date.now(),
    expiresAt: Date.now() + AUTH_TTL_MS
  });
  saveAuthSessions();
  return token;
}

function getSessionFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  const session = authSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    authSessions.delete(token);
    saveAuthSessions();
    return null;
  }
  const currentAuthVersion = walletManager.getAuthVersion(session.userId);
  if ((session.authVersion || 1) !== currentAuthVersion) {
    authSessions.delete(token);
    saveAuthSessions();
    return null;
  }
  const password = walletManager.unsealSecret(session.passwordSecret);
  if (!password) {
    authSessions.delete(token);
    saveAuthSessions();
    return null;
  }
  return { token, ...session, password };
}

function revokeAuthSession(req) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const deleted = authSessions.delete(match[1].trim());
  if (deleted) saveAuthSessions();
  return deleted;
}

// Authentication middleware
async function authenticateUser(req, res, next) {
  const requestedUserId = req.headers['x-user-id'] || req.body.userId || req.params.userId;
  const password = req.headers['x-password'];
  const authHeader = req.headers.authorization || '';
  const hasBearerToken = /^Bearer\s+.+/i.test(authHeader);
  const session = getSessionFromRequest(req);

  if (session) {
    if (requestedUserId && requestedUserId !== session.userId) {
      return res.status(403).json({ success: false, message: 'Token does not match requested user.' });
    }
    req.authUserId = session.userId;
    req.authPassword = session.password;
    return next();
  }

  if (hasBearerToken) {
    return res.status(401).json({ success: false, message: 'Session expired or invalid. Please log in again.' });
  }

  const userId = requestedUserId;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'User ID is required' });
  }

  // Check if user exists
  const wallet = walletManager.getWallet(userId);
  if (!wallet) {
    // Unknown users are only allowed through where the flow explicitly needs it,
    // otherwise their existence could be probed without credentials.
    if (req.allowUnknownUser === true) {
      return next();
    }
    return res.status(401).json({ success: false, message: INVALID_CREDENTIALS });
  }

  // If user exists, they must provide a password
  if (!password) {
    return res.status(401).json({ success: false, message: INVALID_CREDENTIALS });
  }

  const isValid = await walletManager.verifyPassword(userId, password);
  if (!isValid) {
    return res.status(401).json({ success: false, message: INVALID_CREDENTIALS });
  }

  req.authUserId = userId;
  req.authPassword = password;

  next();
}

// Signup endpoint
app.post('/api/signup', authLimiter, async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) {
      return res.status(400).json({ success: false, message: 'UserId and password required' });
    }
    const result = await walletManager.createWallet(userId, password);
    if (result.success) {
      const token = createAuthSession(userId, password);
      return res.json({ ...result, token, userId });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Login endpoint
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { userId, password } = req.body;
    const isValid = await walletManager.verifyPassword(userId, password);
    if (isValid) {
      const wallet = walletManager.getWallet(userId);
      const token = createAuthSession(userId, password);
      res.json({ success: true, token, userId, address: wallet.address });
    } else {
      res.status(401).json({ success: false, message: INVALID_CREDENTIALS });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * API Routes
 */

// Chat endpoint - process user messages and manage session state
app.post('/api/chat', (req, res, next) => {
  req.allowUnknownUser = true;
  next();
}, [authenticateUser, chatLimiter], async (req, res) => {
  try {
    const { userId: bodyUserId, message, sessionId, mode, activeAddress } = req.body;
    const userId = req.authUserId || bodyUserId;

    if (!userId || !message) {
      return res.status(400).json({
        success: false,
        message: 'Both userId and message are required'
      });
    }

    // Process the message through the AI agent
    const password = req.authPassword || req.headers['x-password'];
    const result = await processCommand(
      userId,
      message,
      sessionId,
      mode || 'custodial',
      password,
      activeAddress
    );

    // Respond with the result
    res.json(result);
  } catch (error) {
    console.error('Error processing chat message:', error);
    res.status(500).json({
      success: false,
      message: `Server error: ${error.message}`
    });
  }
});

// Get wallet info (addresses and balances)
app.get('/api/wallet/:userId', authenticateUser, async (req, res) => {
  try {
    const userId = req.authUserId || req.params.userId;
    const wallet = walletManager.getSafeWallet(userId);

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'No wallet found for this user'
      });
    }

    // Get the wallet's balance
    const balance = await provider.getBalance(wallet.address);

    res.json({
      success: true,
      ...wallet,
      balance: ethers.formatEther(balance),
      balanceWei: balance.toString()
    });
  } catch (error) {
    console.error('Error getting wallet info:', error);
    res.status(500).json({
      success: false,
      message: `Server error: ${error.message}`
    });
  }
});

// Wallet details. Accounts are created through /api/signup only.
app.post('/api/wallet/:userId', [authLimiter, authenticateUser], async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!req.authUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Use /api/signup to create a new account.'
      });
    }
    const result = await walletManager.createWallet(userId, req.authPassword || req.body.password);

    if (!result.success && /already exists/i.test(result.message || '')) {
      return res.json({ success: true, address: result.address, created: false });
    }

    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }

    return res.status(201).json({ ...result, created: true });
  } catch (error) {
    console.error('Error creating wallet:', error);
    res.status(500).json({
      success: false,
      message: `Server error: ${error.message}`
    });
  }
});

// Send ETH to a recipient
app.post('/api/transaction/:userId', authenticateUser, async (req, res) => {
  try {
    const userId = req.authUserId || req.params.userId;
    const { recipient, amount } = req.body;

    if (!recipient || amount === undefined || amount === null || amount === '') {
      return res.status(400).json({
        success: false,
        message: 'Both recipient and amount are required'
      });
    }

    // Validate address
    if (!ethers.isAddress(recipient)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid recipient address'
      });
    }

    // Validate amount as exact wei
    const amountWei = walletManager.toWeiAmount(amount);
    if (amountWei === null) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a positive number of ETH no greater than 1000'
      });
    }
    const amountEth = walletManager.formatEthAmount(amountWei);

    // Recipient policy
    if (!walletManager.isAddressWhitelisted(userId, recipient)) {
      return res.status(400).json({
        success: false,
        message: `Recipient ${recipient} is not on your whitelist. Update your whitelist before sending to this address.`
      });
    }

    // Get wallet instance
    const password = req.authPassword || req.headers['x-password'];
    const walletInstance = walletManager.getWalletInstance(userId, provider, password);

    if (!walletInstance) {
      return res.status(404).json({
        success: false,
        message: 'No wallet found for this user'
      });
    }

    // Check balance
    const balance = await provider.getBalance(walletInstance.address);
    if (balance < amountWei) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. You have ${ethers.formatEther(balance)} ETH, trying to send ${amountEth} ETH`
      });
    }

    // Reserve against the daily limit before broadcasting
    const reservation = walletManager.reserveDailySpend(userId, amountEth);
    if (!reservation.ok) {
      return res.status(400).json({
        success: false,
        message: reservation.reason
      });
    }

    try {
      // Send transaction
      const tx = await walletInstance.sendTransaction({
        to: recipient,
        value: amountWei,
        gasLimit: 21000 // Standard gas limit for ETH transfers
      });

      // Record transaction
      walletManager.recordTransaction(userId, {
        type: 'send',
        to: recipient,
        amount: amountEth,
        hash: tx.hash,
        status: 'success',
        mode: 'custodial'
      });

      res.json({
        success: true,
        txHash: tx.hash,
        from: walletInstance.address,
        to: recipient,
        amount: amountEth
      });
    } catch (sendError) {
      walletManager.releaseDailySpend(userId, amountEth);
      walletManager.logSecurityEvent(userId, 'Transaction Send Failed', 'medium');
      throw sendError;
    }
  } catch (error) {
    console.error('Error sending transaction:', error);
    res.status(500).json({
      success: false,
      message: `Server error: ${error.message}`
    });
  }
});


// Get transaction history
app.get('/api/history/:userId', authenticateUser, async (req, res) => {
  try {
    const userId = req.authUserId || req.params.userId;
    const wallet = walletManager.getSafeWallet(userId);

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'No wallet found for this user'
      });
    }

    res.json({
      success: true,
      transactions: wallet.transactions || []
    });
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({
      success: false,
      message: `Server error: ${error.message}`
    });
  }
});

// Record a transaction (useful for non-custodial mode)
app.post('/api/record-tx', authenticateUser, async (req, res) => {
  try {
    const userId = req.authUserId;
    const { tx } = req.body;
    if (!tx || typeof tx !== 'object') {
      return res.status(400).json({ success: false, message: 'A transaction payload is required' });
    }
    const recorded = walletManager.recordTransaction(userId, tx);
    if (!recorded) {
      return res.status(400).json({ success: false, message: 'Transaction payload was rejected as invalid' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get security status
app.get('/api/security-status/:userId', authenticateUser, (req, res) => {
  try {
    const userId = req.authUserId || req.params.userId;
    const status = walletManager.getSecurityStatus(userId);
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/logout', authenticateUser, (req, res) => {
  revokeAuthSession(req);
  res.json({ success: true });
});

app.get('/api/auth/me', authenticateUser, (req, res) => {
  res.json({ success: true, userId: req.authUserId });
});

app.post('/api/auth/refresh', authenticateUser, (req, res) => {
  const userId = req.authUserId;
  const password = req.authPassword;
  revokeAuthSession(req);
  const token = createAuthSession(userId, password);
  res.json({ success: true, token, userId });
});

// Basic health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'IntentPay is active' });
});

// Serve a simple home page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>IntentPay</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
          }
          h1 {
            color: #333;
            border-bottom: 1px solid #ddd;
            padding-bottom: 10px;
          }
          .endpoint {
            background: #f5f5f5;
            padding: 15px;
            margin-bottom: 15px;
            border-radius: 5px;
          }
          .method {
            font-weight: bold;
            color: #0066cc;
          }
          code {
            background: #eee;
            padding: 2px 5px;
            border-radius: 3px;
          }
        </style>
      </head>
      <body>
        <h1>IntentPay API</h1>
        
        <p>Welcome to the Multi-User Wallet AI Agent API. Below are the available endpoints:</p>
        
        <div class="endpoint">
          <p><span class="method">POST</span> /api/chat</p>
          <p>Process natural language commands and interact with the wallet agent.</p>
          <p>Required parameters: <code>userId</code>, <code>message</code></p>
          <p>Optional parameters: <code>sessionId</code></p>
        </div>
        
        <div class="endpoint">
          <p><span class="method">GET</span> /api/wallet/:userId</p>
          <p>Get wallet information including address and balance.</p>
        </div>
        
        <div class="endpoint">
          <p><span class="method">POST</span> /api/wallet/:userId</p>
          <p>Create a new wallet for the specified user.</p>
        </div>
        
        <div class="endpoint">
          <p><span class="method">POST</span> /api/transaction/:userId</p>
          <p>Send ETH from the user's wallet to a specified address.</p>
          <p>Required parameters: <code>recipient</code>, <code>amount</code></p>
        </div>
        
        <p>For more information, please refer to the documentation.</p>
      </body>
    </html>
  `);
});

// Start the server
loadAuthSessions();

function startServer() {
  return app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`RPC URL: ${(process.env.RPC_URL || '').substring(0, 20)}...`);
    console.log(`Visit http://localhost:${PORT} to view the API documentation`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
