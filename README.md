# IntentPay

IntentPay is an AI-assisted Web3 transaction prototype. It translates natural-language payment intent into a structured transaction plan, then keeps execution behind an explicit wallet review step.

The project explores a safer product boundary for AI and blockchain applications: the model can interpret and prepare actions, but the user must still review and approve any irreversible on-chain transaction.

- Status: Prototype
- Portfolio case study: https://subhajitpradhan.vercel.app/projects/intentpay
- Inspect the implementation: `ai-agent.js`, `wallet-manager.js`, and `frontend/`

## Why This Exists

Crypto wallets expose powerful actions through low-level addresses, gas settings, contract calls, and transaction prompts. That is difficult for non-technical users and risky for teams that need guardrails.

IntentPay experiments with a higher-level workflow:

1. A user describes what they want to do in natural language.
2. The backend resolves intent, contacts, balances, and guardrails.
3. The system prepares a structured transaction preview.
4. The wallet remains the final execution boundary.

## Core Flows

- Natural-language payments such as split payments and named recipients.
- Handle and ENS-style recipient resolution.
- Transaction preview before wallet execution.
- Gas estimation and structured transaction errors.
- Spending guardrails and whitelisted recipient concepts.
- Transaction history with status and hashes.
- Security event logging for suspicious or failed actions.

## Architecture

```text
React client
  Intent input, transaction preview, wallet-facing UI

Express API
  Auth, contacts, guardrails, transaction planning, sanitized responses

LLM adapter
  Converts user intent into structured tool calls and transaction plans

Wallet/blockchain layer
  Ethers.js, Sepolia RPC, gas estimation, transaction submission boundary

Security layer
  AES-256-GCM encrypted wallet data, bcrypt password hashing, event logs
```

## Safety Boundary

IntentPay intentionally separates AI planning from blockchain execution.

- The AI does not silently execute transactions.
- The API sanitizes responses so private keys and password hashes do not leave backend logic.
- Transaction details are prepared for review before signing.
- Guardrails restrict recipients and spending limits, and are re-checked at execution time.
- Failed or suspicious flows are recorded through security events.

The execution boundary holds under adversarial input:

- Model output is treated as untrusted. Amounts are converted to exact wei with a
  strict decimal parser, so hex, exponents, negative values and `NaN` are rejected
  before any balance or limit math runs.
- Every recipient is validated as an address, checked against the whitelist, and
  blocked from being the sending address.
- Daily limits are reserved before a transaction is broadcast and released again
  when the send fails, so a failed transfer never consumes the allowance.
- A payment must be released with `intentpay confirm code <payment-secret>`, the
  secret is bcrypt-verified locally and never sent to the model, and repeated
  failures trigger a lockout.
- The staged payment expires after two minutes and is discarded by any other message.

## Tech Stack

- Node.js
- Express.js
- React
- Vite
- Ethers.js v6
- OpenRouter-compatible LLM API
- AES-256-GCM
- bcrypt

## Getting Started

### Prerequisites

- Node.js 18+
- OpenRouter API key
- Sepolia RPC endpoint
- Sepolia test ETH

### Install

```bash
npm install
cd frontend
npm install
```

### Environment

Create a `.env` file in the repository root:

```env
PORT=3001
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ENCRYPTION_KEY=your_32_char_random_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free
```

Use a dedicated test key and testnet-only funds when experimenting locally.

### Run

```bash
node server.js
```

In a second terminal:

```bash
cd frontend
npm run dev
```

Open:

```text
http://localhost:5173
```

### Test

```bash
npm test
```

The suite uses the built-in Node test runner and needs no chain access. It covers
the security score (`tests/wallet-manager.test.js`), amount parsing and guardrail
enforcement (`tests/guardrails.test.js`), intent normalization
(`tests/intent.test.js`), the HTTP auth and policy surface
(`tests/server-auth.test.js`), and the pending-payment approval boundary
(`tests/confirm-flow.test.js`). Each file runs in its own process against a
temporary data directory, and RPC calls are served by a local JSON-RPC stub.

## Example Prompts

- "Remember @alice is 0x742..."
- "Send 0.01 ETH to @alice and 0.02 ETH to vitalik.eth."
- "Set my daily limit to 0.5 ETH."
- "What is my security status?"
- "Show my transaction history."

## Tradeoffs

- Server-side wallet storage is useful for prototyping custodial flows, but production systems should use HSM, MPC, account abstraction, or non-custodial signing models.
- Natural-language UX reduces friction, but every generated action still needs visible review because blockchain transactions are irreversible.
- LLM output must be treated as untrusted input and validated before it reaches transaction-building code.
- The payment secret is a single shared approval factor, so it is only as strong as the user's memory. Production systems should move to per-transaction signing, time locks, and threshold policies.
- `reset pin to <value>` sets the payment secret while `reset password to <value>` rotates the account credential. The phrasing difference is easy to misread and should become explicit settings in the UI.

## Roadmap

- Move sensitive key handling to HSM, KMS, MPC, or smart-account infrastructure.
- Add ERC-4337 account abstraction for recovery, policies, and gas sponsorship.
- Expand guardrails with time locks, approval thresholds, and multi-sig policies.
- Add multi-chain support after the safety model is stable.
- Replace the JSON file store with a transactional database.
- Add coverage for the ENS resolution and voice input paths.
