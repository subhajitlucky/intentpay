# IntentPay — frontend

The React client for IntentPay. It talks to the Express API in the repository
root; it has no server logic of its own.

Requires **Node 22 or newer**: the test environment (jsdom 30) depends on a Node
API that does not exist in Node 20.

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # vitest
npm run build    # production bundle in dist/
npm run lint
```

## Configuration

The API base URL defaults to `http://localhost:3000/api`. Override it with a
`.env` file in this directory:

```env
VITE_API_BASE=http://localhost:3000/api
```

That port has to match `PORT` in the backend's `.env`.

## Layout

```text
src/
  App.jsx                       app shell, dashboard, assistant panel
  index.css                     design tokens, base layer, shared primitives
  App.css                       component styles
  components/
    VoiceConsole.jsx            voice mode panel
    TransactionLedger.jsx       transaction history as a statement table
    BrandGlyph.jsx              the wordmark
  lib/
    voice-mode.js               wake-word engine, voice command grammar, speech
    intent-voice.js             Whisper fallback recorder with silence detection
    redaction.js                strips secrets before they reach the screen or storage
  config/api.js                 API base URL
  __tests__/                    vitest suites
```

Voice mode needs a browser with the Web Speech API for wake-word listening
(Chrome or Edge). Elsewhere the console falls back to a tap-to-speak recorder
backed by Whisper via `@xenova/transformers`.
