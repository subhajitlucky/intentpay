# IntentPay

IntentPay is an AI-assisted Web3 transaction prototype. It translates natural-language payment intent into a structured transaction plan, then keeps execution behind an explicit wallet review step.

The project explores a safer product boundary for AI and blockchain applications: the model can interpret and prepare actions, but the user must still review and approve any irreversible on-chain transaction.

- Status: Prototype
- Portfolio case study: https://subhajitpradhan.vercel.app/projects/intentpay
- Inspect the implementation: `ai-agent.js`, `wallet-manager.js`, `frontend/`, and
  the voice pipeline in `frontend/src/lib/voice-mode.js`

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
- Voice mode: hands-free wake-word control with spoken replies and spoken approvals.
- Transaction history with status and hashes.
- Security event logging for suspicious or failed actions.

## Architecture

```text
React client
  Intent input, transaction preview, wallet-facing UI, voice mode

Express API
  Auth, contacts, guardrails, transaction planning, sanitized responses

LLM adapter
  Converts user intent into structured tool calls and transaction plans

Wallet/blockchain layer
  Ethers.js, Sepolia RPC, gas estimation, transaction submission boundary

Security layer
  AES-256-GCM encrypted wallet data, bcrypt password hashing, event logs
```

## Voice Mode

Voice mode is the hands-free path through the same pipeline as typed input: the
microphone replaces the keyboard, and every command still travels to `/api/chat`
and is authorised on the server. There is no second execution path.

How it behaves:

- Say **"Hey IntentPay"** (or just "IntentPay", or the nod-to-Ben-10 alias
  "Omnitrix") followed by a command in the same breath: *"Hey IntentPay, what is
  my balance?"*
- The assistant answers out loud and keeps listening, so a whole conversation is
  hands-free.
- Say **"stop"** at any time to interrupt the assistant mid-sentence.
- Say **"confirm code 1 2 3 4"** to approve a staged payment with your spoken
  payment secret. Spoken digits are normalised, and the secret is redacted before
  it reaches the chat window, the voice console, or localStorage.
- "Repeat that", "cancel that", "what can I say" are handled locally without a
  round trip.

Two properties are deliberate:

1. **Nothing runs without the wake word.** Ambient speech is transcribed and shown
   dimmed so you can see the microphone working, but it is never executed. The one
   exception is "stop", which can only silence speech and can never start an
   action.
2. **Voice is an input channel, not an authority.** Spoken approvals still hit the
   bcrypt payment secret, and guardrails, whitelists, daily limits and the
   confirmation boundary are unchanged. The voice grammar only routes and
   normalises text.

Browser support:

- Wake-word mode uses the Web Speech API (`SpeechRecognition`) and needs Chrome or
  Edge. In Chrome, recognition audio is processed by the browser's speech service;
  treat an open microphone accordingly.
- Browsers without continuous recognition (Firefox, Safari) fall back to a
  tap-to-speak button that records with Whisper (`@xenova/transformers`) and stops
  on silence. Wake words are not available there.
- Speech synthesis needs `speechSynthesis`. When it is missing or fails, replies
  stay on screen and voice mode keeps working.

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
- A spoken approval is treated exactly like a typed one: it still has to carry the
  payment secret, and the secret is redacted before it is displayed or stored.

## Tech Stack

- Node.js
- Express.js
- React
- Vite
- Ethers.js v6
- OpenRouter-compatible LLM API
- Web Speech API (voice mode; Whisper via `@xenova/transformers` as fallback)
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

Create a `.env` file in the repository root (`.env.example` is a working starting
point):

```env
PORT=3000
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ENCRYPTION_KEY=your_32_char_encryption_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free
```

Two things the server is strict about:

- `ENCRYPTION_KEY` must be **exactly 32 characters** or the process exits at
  startup. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
- `PORT` must match the port the frontend calls. `frontend/.env` (or the default
  `VITE_API_BASE=http://localhost:3000/api`) has to point at the same port.

The server also refuses to boot if `RPC_URL`, `ENCRYPTION_KEY` or
`OPENROUTER_API_KEY` is missing entirely. With a placeholder OpenRouter key the
app still runs: everything works except the LLM intent parsing, and the assistant
says so in the chat.

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

Register an account (any username and a password of your choosing), then ask the
assistant for your balance. On a fresh Sepolia wallet that is `0.0000 ETH`, which
is expected — fund the address shown in the balance panel from a faucet to see a
non-zero balance.

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

Voice mode has its own frontend suite:

```bash
cd frontend
npm test
```

`frontend/src/__tests__/voice-mode.test.js` covers wake-word extraction, spoken
digit normalisation ("one two three four" to `1234`), approval parsing, secret
redaction, speech sanitisation, and the local playback commands.

## Example Prompts

- "Remember @alice is 0x742..."
- "Send 0.01 ETH to @alice and 0.02 ETH to vitalik.eth."
- "Set my daily limit to 0.5 ETH."
- "What is my security status?"
- "Show my transaction history."

Spoken equivalents in voice mode:

- "Hey IntentPay, what is my balance?"
- "Hey IntentPay, send 0.01 ETH to @alice" then "Hey IntentPay, confirm code 1 2 3 4"
- "Hey IntentPay, cancel that"
- "Stop" / "Repeat that"

## Deploying

IntentPay is a **stateful Node service**, not a static site: it holds an encrypted
keystore, an auth-session store and a JSON database on disk. That single fact
decides where it can run.

**The rule: the process needs a persistent disk, or every wallet it custodies
disappears.** On a platform with an ephemeral filesystem (Vercel functions,
Netlify functions, most FaaS), a cold start or a redeploy starts from an empty
`data/` directory: accounts stop existing and the encrypted keys are gone for
good. Verified locally — the same container that keeps its wallet when `data/` is
a mounted volume loses it when the container is recreated without one.

### One container (recommended for a demo)

The image builds the client with a same-origin API base and serves everything
from one port, so there is no CORS configuration to get wrong:

```bash
docker build -t intentpay .

docker run -d --name intentpay -p 3000:3000 \
  -e ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))") \
  -e RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  -e OPENROUTER_API_KEY=sk-or-v1-... \
  -v intentpay-data:/app/data \
  intentpay
```

Open `http://localhost:3000`. The `-v` flag is the part that matters.

### Two services (API + static client)

The client is a plain Vite build and can live on any static host (Vercel,
Netlify, Cloudflare Pages, GitHub Pages) with the API on a host that offers a
volume:

| Piece | Host | Notes |
| --- | --- | --- |
| `frontend/` | Vercel / Netlify / Pages | set the project root to `frontend` |
| API | Render, Railway, Fly.io, a VPS, or any Docker host | must have a persistent volume on `data/` |

Point the client at the API with `VITE_API_BASE`, and allow its origin on the
server:

```env
# frontend build environment
VITE_API_BASE=https://intentpay-api.example.com/api

# backend environment
CORS_ORIGINS=https://intentpay.example.com
```

`CORS_ORIGINS` is a comma-separated allowlist and defaults to
`http://localhost:5173,http://localhost:3000`. If the browser reports
`Not allowed by CORS`, the deployed client's exact origin is missing from it.

### Required environment variables

`RPC_URL`, `ENCRYPTION_KEY` and `OPENROUTER_API_KEY` must all be set or the
server exits at startup. On a public host, also set:

- `ENCRYPTION_KEY` to a secret managed by the platform, not a file in the image.
  **Losing it makes every stored keystore unreadable.**
- `HTTPS` termination at the proxy. Browsers only grant microphone access to
  voice mode in a secure context, so a plain-HTTP deployment loses that feature.
- `PORT` if the platform injects its own.

### Before putting this on the public internet

The prototype custodies keys on the server. That is fine for testnet
experiments, and the README already argues production needs HSM/KMS, MPC, or
account abstraction. A public deployment should therefore use throwaway Sepolia
keys, and the `.env` above should never contain a mainnet-funded key.

## Tradeoffs

- Server-side wallet storage is useful for prototyping custodial flows, but production systems should use HSM, MPC, account abstraction, or non-custodial signing models.
- Natural-language UX reduces friction, but every generated action still needs visible review because blockchain transactions are irreversible.
- LLM output must be treated as untrusted input and validated before it reaches transaction-building code.
- The payment secret is a single shared approval factor, so it is only as strong as the user's memory. Production systems should move to per-transaction signing, time locks, and threshold policies.
- `reset pin to <value>` sets the payment secret while `reset password to <value>` rotates the account credential. The phrasing difference is easy to misread and should become explicit settings in the UI.
- Voice mode keeps the microphone open while it is enabled, and Chrome processes
  recognition audio in the cloud. A production build would prefer on-device
  wake-word detection and a visible recording indicator tied to the OS mic state.
- Wake-word matching is a deterministic phrase grammar, not a trained wake-word
  model, so it can both miss and false-trigger. Nothing destructive depends on it:
  a false trigger only produces a normal, reviewable request.
- Spoken approval is convenient but lower-entropy than typing a secret. It is
  acceptable here because the secret still has to be known and the transaction is
  staged first; a real deployment should add a device-bound factor.
- Speech is best-effort: if synthesis fails, replies fall back to text rather than
  blocking the flow.

## Roadmap

- Move sensitive key handling to HSM, KMS, MPC, or smart-account infrastructure.
- Add ERC-4337 account abstraction for recovery, policies, and gas sponsorship.
- Expand guardrails with time locks, approval thresholds, and multi-sig policies.
- Add multi-chain support after the safety model is stable.
- Replace the JSON file store with a transactional database.
- Add coverage for the ENS resolution path.
- Add an on-device wake-word model so voice mode does not depend on a cloud
  speech service, plus a per-command "listening" indicator.
