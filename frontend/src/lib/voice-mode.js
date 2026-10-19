/**
 * Voice mode: hands-free control of IntentPay.
 *
 * The point of this module is that the user never touches the keyboard. The mic
 * stays open, a wake word starts a command, the command runs through the exact
 * same chat pipeline as typed input, and the answer is spoken back. Say "stop"
 * at any time to cut the assistant off mid-sentence.
 *
 * Two properties are deliberate and easy to get wrong:
 *
 * 1. Nothing is dispatched without the wake word. Ambient speech is classified
 *    and shown dimmed in the voice console, never acted on. The single exception
 *    is "stop", which is only allowed to interrupt speech and can never start an
 *    action.
 * 2. The grammar in this file is presentation and routing only. Every command
 *    still travels to the server as text and is authorised there. Spoken
 *    approvals are redacted before they reach the screen or local storage.
 */

export const WAKE_WORD_LABEL = 'Hey IntentPay';

export const VOICE_COMMAND_HELP = [
  { say: 'Hey IntentPay, what is my balance?', does: 'Answer out loud, hands free' },
  { say: 'Hey IntentPay, send 0.01 ETH to @alice', does: 'Stage a payment for approval' },
  { say: 'Hey IntentPay, confirm code 1 2 3 4', does: 'Approve with your spoken payment secret' },
  { say: 'Hey IntentPay, cancel that', does: 'Drop the staged payment' },
  { say: 'Hey IntentPay, add contact @bob is 0x...', does: 'Save a recipient' },
  { say: 'Stop', does: 'Interrupt the assistant mid-sentence' },
  { say: 'Repeat that', does: 'Hear the last answer again' }
];

// ---------------------------------------------------------------------------
// Transcript normalisation
// ---------------------------------------------------------------------------

/**
 * Lowercase, strip punctuation the recogniser invents, and glue the product name
 * back together. Speech engines return "intent pay", "intent-pay" and "intentpay"
 * for the same two syllables, so all of them have to mean the same thing.
 */
export function normalizeTranscript(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9\s.@_-]/g, ' ')
    .replace(/\bintent[\s-]*pay\b/g, 'intentpay')
    .replace(/\bomni[\s-]*tri(?:x|cks|cs)\b/g, 'omnitrix')
    .replace(/\s+/g, ' ')
    .trim();
}

// Digits the recogniser spells out. "Oh" and "niner" are radio habits that show
// up constantly in real transcripts.
const DIGIT_WORDS = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9'
};

// Homophones that only count inside a run of digits, so ordinary sentences keep
// their "to" and "for" instead of turning into numbers.
const DIGIT_HOMOPHONES = {
  to: '2', too: '2', for: '4', fore: '4', ate: '8', won: '1', o: '0', tree: '3'
};

/**
 * Turn spoken digits into numbers: "confirm code one two three four" becomes
 * "confirm code 1234". A run of two or more number words always collapses; a
 * lone ambiguous homophone ("to") is left alone.
 */
export function normalizeSpokenDigits(text) {
  if (typeof text !== 'string' || !text) return '';
  const pieces = text.split(/\s+/).filter(Boolean);
  const result = [];
  let run = [];

  const flush = () => {
    if (run.length === 0) return;
    const singleUnambiguous = run.length === 1 && DIGIT_WORDS[run[0].word] !== undefined;
    if (run.length >= 2 || singleUnambiguous) {
      result.push(run.map((entry) => entry.digit).join(''));
    } else {
      result.push(run[0].raw);
    }
    run = [];
  };

  for (const raw of pieces) {
    const word = raw.toLowerCase().replace(/[^a-z]/g, '');
    // Recognisers are inconsistent: the same code comes back as "8821" or as
    // "8 8 2 1". Single digit characters are treated as their own digit words.
    const isDigitChar = /^\d$/.test(raw);
    const digit = isDigitChar
      ? raw
      : (DIGIT_WORDS[word] !== undefined ? DIGIT_WORDS[word] : DIGIT_HOMOPHONES[word]);
    if (digit !== undefined) {
      run.push({ raw, word, digit });
    } else {
      flush();
      result.push(raw);
    }
  }
  flush();

  return result.join(' ');
}

// Accepts "intentpay", "hey intentpay", "okay intent pay", and the Ben 10 homage
// alias. The alias is only a wake word; it grants no extra powers.
const WAKE_PATTERN = /\b(?:(?:hey|hi|ok|okay|yo|listen|wake\s+up)[\s,]*)?(intentpay|omnitrix)\b/;

/**
 * Split an utterance into wake word + remainder.
 * Returns null when the wake word never appeared, which is the signal to ignore
 * everything else the microphone heard.
 */
export function matchWakeWord(transcript) {
  const text = normalizeTranscript(transcript);
  if (!text) return null;

  const match = WAKE_PATTERN.exec(text);
  if (!match) return null;

  const command = text
    .slice(match.index + match[0].length)
    .replace(/^[\s,.!?-]+/, '')
    .trim();

  return {
    wakeWord: match[1],
    command: normalizeSpokenDigits(command),
    transcript: text
  };
}

// ---------------------------------------------------------------------------
// Local commands
// ---------------------------------------------------------------------------

const STOP_PHRASES = /^(?:stop|stop it|stop that|stop talking|stop speaking|be quiet|quiet|silence|shut up|hush|shush|enough|that'?s enough)$/;
const REPEAT_PHRASES = /^(?:repeat|repeat that|repeat it|say that again|say it again|come again|what did you say|pardon|once more|one more time)$/;
const CANCEL_PHRASES = /^(?:cancel|cancel that|cancel it|cancel the payment|cancel payment|cancel the transaction|never ?mind|forget it|abort|abort that|abort the payment|scrap that)$/;
const HELP_PHRASES = /^(?:help|voice help|what can i say|what can you do|voice commands|list commands|commands|cheat sheet)$/;

// "confirm code 1234", "confirm the payment with my code 1234", "approve 1234".
const CONFIRM_PATTERN = /^(?:please\s+)?(?:confirm|approve|authorise|authorize|release)(?:\s+(?:the\s+)?(?:payment|transaction|transfer|it|that|send))?(?:\s+(?:with\s+)?(?:my\s+)?(?:code|pin|secret|password))?(?:\s+(?:is|of))?\s+(.+)$/;

// Words that can surround an approval but never are one. "confirm the payment"
// must not be read as an approval of a secret called "the payment".
const APPROVAL_FILLER = new Set([
  'the', 'a', 'an', 'my', 'your', 'our', 'it', 'its', 'that', 'this', 'these', 'those',
  'payment', 'transaction', 'transfer', 'send', 'code', 'pin', 'secret', 'password',
  'is', 'are', 'was', 'of', 'with', 'using', 'please', 'now', 'ok', 'okay', 'and', 'to'
]);

function cleanApprovalSecret(rawSecret) {
  if (!rawSecret) return '';
  const words = String(rawSecret).trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && APPROVAL_FILLER.has(words[0].toLowerCase())) words.shift();
  if (words.length === 0) return '';
  if (words.every((word) => APPROVAL_FILLER.has(word.toLowerCase()))) return '';
  return words.join(' ');
}

export function buildConfirmMessage(secret) {
  return `intentpay confirm code ${String(secret || '').trim()}`;
}

/**
 * Classify an already wake-word-stripped command.
 *
 * Returns { type, ... }:
 *   stop_speaking | repeat | cancel_payment | confirm_payment | help | message
 * Unknown phrases fall through to 'message' and go to the normal chat pipeline,
 * which is what makes voice mode feel open-ended instead of scripted.
 */
export function matchVoiceCommand(transcript) {
  const text = normalizeSpokenDigits(normalizeTranscript(transcript));
  if (!text) return null;

  if (STOP_PHRASES.test(text)) return { type: 'stop_speaking', phrase: text };
  if (REPEAT_PHRASES.test(text)) return { type: 'repeat', phrase: text };
  if (HELP_PHRASES.test(text)) return { type: 'help', phrase: text };
  if (CANCEL_PHRASES.test(text)) return { type: 'cancel_payment', phrase: text };

  const confirm = CONFIRM_PATTERN.exec(text);
  if (confirm && confirm[1]) {
    const secret = cleanApprovalSecret(confirm[1].replace(/^(?:it'?s|is|=)\s*/, ''));
    if (secret) {
      return {
        type: 'confirm_payment',
        secret,
        message: buildConfirmMessage(secret),
        phrase: text
      };
    }
  }

  return { type: 'message', message: text, phrase: text };
}

// ---------------------------------------------------------------------------
// Speech output
// ---------------------------------------------------------------------------

const SPEECH_MAX_CHARS = 700;

/**
 * Make a chat reply fit for a human ear: no backticks, no markdown, shortened
 * hashes, no emoji, and a length cap so one long answer cannot hold the mic
 * hostage for a minute.
 */
export function sanitizeForSpeech(text, { maxChars = SPEECH_MAX_CHARS } = {}) {
  if (typeof text !== 'string') return '';

  let out = text
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/0x[0-9a-fA-F]{16,}/g, (match) => `${match.slice(0, 6)}...${match.slice(-4)}`)
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '. ')
    .replace(/\.\s+\./g, '.')
    .trim();

  if (out.length <= maxChars) return out;

  const clipped = out.slice(0, maxChars);
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  const head = lastStop > maxChars * 0.5 ? clipped.slice(0, lastStop + 1) : clipped;
  return `${head.trim()} The rest is on screen.`;
}

function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export const VOICE_STATES = {
  OFF: 'off',
  WAKE: 'wake',
  CAPTURING: 'capturing',
  BUSY: 'busy',
  SPEAKING: 'speaking',
  ERROR: 'error'
};

const CAPTURE_TIMEOUT_MS = 8000;
const INTERIM_SETTLE_MS = 1600;
const FINAL_SETTLE_MS = 700;
const RESTART_DELAY_MS = 250;
const MAX_RAPID_RESTARTS = 6;

export class VoiceModeEngine {
  static isSupported() {
    if (typeof window === 'undefined') return false;
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  constructor({
    onStateChange = () => {},
    onTranscript = () => {},
    onCommand = () => {},
    onSpeechEnd = () => {},
    onError = () => {},
    rate = 1.05
  } = {}) {
    this.onStateChange = onStateChange;
    this.onTranscript = onTranscript;
    this.onCommand = onCommand;
    this.onSpeechEnd = onSpeechEnd;
    this.onError = onError;
    this.rate = rate;

    this.state = VOICE_STATES.OFF;
    this.running = false;
    this.busy = false;
    this.speaking = false;
    this.captureBuffer = '';
    this.captureTimer = null;
    this.settleTimer = null;
    this.restartTimer = null;
    this.rapidRestarts = 0;
    this.lastStartAt = 0;
    this.recognition = null;
    this.voice = null;
    this.speechToken = 0;
    this.voiceListenerAttached = false;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange(next);
  }

  // -- lifecycle -----------------------------------------------------------

  async start() {
    if (!VoiceModeEngine.isSupported()) {
      throw new Error('Wake-word voice mode needs a browser with the Web Speech API (Chrome or Edge).');
    }
    if (this.running) return;

    this.running = true;
    this.rapidRestarts = 0;
    this.attachVoiceListener();
    this.startRecognition();
    this.setState(VOICE_STATES.WAKE);
  }

  stop() {
    this.running = false;
    this.busy = false;
    this.clearCaptureTimers();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.recognition) {
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      try {
        this.recognition.stop();
              } catch {
        // already stopped
      }
      this.recognition = null;
    }
    this.stopSpeaking();
    this.setState(VOICE_STATES.OFF);
  }

  /** True while the app is running a command or talking, so nothing new starts. */
  setBusy(busy) {
    this.busy = !!busy;
    if (busy) {
      this.clearCaptureTimers();
      if (this.state !== VOICE_STATES.SPEAKING) this.setState(VOICE_STATES.BUSY);
    } else if (this.running && this.state !== VOICE_STATES.SPEAKING) {
      this.setState(VOICE_STATES.WAKE);
    }
  }

  // -- recognition ---------------------------------------------------------

  startRecognition() {
    const RecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new RecognitionClass();
    this.recognition = recognition;

    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event);
    recognition.onend = () => this.handleEnd();

    this.lastStartAt = Date.now();
    try {
      recognition.start();
    } catch (err) {
      this.onError(`Could not start the microphone: ${err.message}`);
      this.setState(VOICE_STATES.ERROR);
    }
  }

  handleEnd() {
    if (!this.running) return;

    // Chrome ends continuous recognition after a pause. Restart it, but stop
    // hammering the API if it keeps dying immediately.
    if (Date.now() - this.lastStartAt < 1000) {
      this.rapidRestarts += 1;
    } else {
      this.rapidRestarts = 0;
    }

    if (this.rapidRestarts > MAX_RAPID_RESTARTS) {
      this.running = false;
      this.onError('Voice mode stopped: the browser keeps closing the microphone. Tap the mic to resume.');
      this.setState(VOICE_STATES.ERROR);
      return;
    }

    this.restartTimer = setTimeout(() => {
      if (!this.running) return;
      try {
        this.recognition?.start();
              } catch {
        // start() throws if the recogniser is already running; the next onend retries.
      }
    }, RESTART_DELAY_MS);
  }

  handleError(event) {
    const code = event?.error;
    if (code === 'no-speech' || code === 'aborted') return;

    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.running = false;
      this.onError('Microphone permission is blocked, so voice mode cannot listen.');
      this.setState(VOICE_STATES.ERROR);
      return;
    }

    this.onError(`Voice input error: ${code || 'unknown'}`);
  }

  handleResult(event) {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript || '';
      if (result.isFinal) {
        this.handleFinal(text);
      } else {
        interim += text;
      }
    }
    if (interim.trim()) this.handleInterim(interim.trim());
  }

  handleInterim(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) return;

    // While the assistant talks, the only thing worth hearing is "stop".
    if (this.speaking) {
      if (STOP_PHRASES.test(normalizeSpokenDigits(normalized))) this.stopSpeaking();
      return;
    }

    if (this.busy) return;

    if (this.state === VOICE_STATES.CAPTURING) {
      this.onTranscript({ text: normalizeSpokenDigits(normalized), final: false, kind: 'command' });
      this.scheduleDispatch(INTERIM_SETTLE_MS);
      return;
    }

    const wake = matchWakeWord(normalized);
    if (wake && wake.command) {
      // "hey intentpay send 0.01 to alice" arrives in one breath. Show it live and
      // give the recogniser a moment to finalise before dispatching.
      this.beginCapture();
      this.onTranscript({ text: wake.command, final: false, kind: 'command' });
      this.scheduleDispatch(INTERIM_SETTLE_MS);
    }
  }

  handleFinal(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) return;

    if (this.speaking) {
      if (STOP_PHRASES.test(normalizeSpokenDigits(normalized))) this.stopSpeaking();
      return;
    }

    if (this.busy) return;

    if (this.state === VOICE_STATES.CAPTURING) {
      this.captureBuffer = `${this.captureBuffer} ${normalizeSpokenDigits(normalized)}`.trim();
      this.onTranscript({ text: this.captureBuffer, final: true, kind: 'command' });
      this.scheduleDispatch(FINAL_SETTLE_MS);
      return;
    }

    const wake = matchWakeWord(normalized);
    if (!wake) {
      // Heard, understood, ignored. Shown dimmed in the speaker's own words so the
      // user can see that the microphone works without anything being executed.
      this.onTranscript({ text: String(text).trim(), final: true, kind: 'ambient' });
      return;
    }

    if (wake.command) {
      this.beginCapture();
      this.captureBuffer = wake.command;
      this.onTranscript({ text: wake.command, final: true, kind: 'command' });
      this.scheduleDispatch(FINAL_SETTLE_MS);
      return;
    }

    // Bare wake word: open the mic for the next sentence.
    this.beginCapture();
    this.onTranscript({ text: '', final: true, kind: 'wake' });
  }

  beginCapture() {
    this.clearCaptureTimers();
    this.captureBuffer = '';
    this.setState(VOICE_STATES.CAPTURING);

    this.captureTimer = setTimeout(() => {
      if (this.captureBuffer.trim()) {
        this.dispatch(this.captureBuffer);
      } else {
        // Nothing followed the wake word.
        this.setState(VOICE_STATES.WAKE);
        this.onTranscript({ text: '', final: true, kind: 'timeout' });
      }
    }, CAPTURE_TIMEOUT_MS);
  }

  scheduleDispatch(delay) {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.captureBuffer.trim()) this.dispatch(this.captureBuffer);
    }, delay);
  }

  clearCaptureTimers() {
    if (this.captureTimer) clearTimeout(this.captureTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.captureTimer = null;
    this.settleTimer = null;
  }

  dispatch(rawText) {
    this.clearCaptureTimers();
    const text = String(rawText || '').trim();
    this.captureBuffer = '';
    if (!text) {
      this.setState(VOICE_STATES.WAKE);
      return;
    }

    const command = matchVoiceCommand(text);
    if (!command) {
      this.setState(VOICE_STATES.WAKE);
      return;
    }

    this.onTranscript({ text: command.phrase, final: true, kind: 'dispatched' });
    this.busy = true;
    this.setState(VOICE_STATES.BUSY);
    this.onCommand(command);
  }

  // -- speech output -------------------------------------------------------

  attachVoiceListener() {
    if (this.voiceListenerAttached || !speechSupported()) return;
    this.voiceListenerAttached = true;
    const load = () => {
      const voices = window.speechSynthesis.getVoices() || [];
      this.voice = pickPreferredVoice(voices);
    };
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  /**
   * Speak a reply. Returns immediately; onSpeechEnd fires when the utterance
   * finishes or is interrupted, which is what releases the mic.
   *
   * Speech is an output channel, not a dependency: if the browser refuses the
   * utterance the sequence is released anyway, otherwise a single bad voice
   * object would leave voice mode permanently stuck on "working".
   */
  speak(text) {
    const cleaned = sanitizeForSpeech(text);
    if (!cleaned || !speechSupported()) {
      this.finishSpeech();
      return;
    }

    const token = ++this.speechToken;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // nothing was speaking
    }

    try {
      const utterance = new SpeechSynthesisUtterance(cleaned);
      utterance.rate = this.rate;
      utterance.pitch = 1;
      try {
        if (this.voice) utterance.voice = this.voice;
      } catch {
        // A stale or foreign voice object is not worth losing the reply over.
      }

      const finish = () => {
        if (token !== this.speechToken) return;
        this.finishSpeech();
      };
      utterance.onend = finish;
      utterance.onerror = finish;

      this.speaking = true;
      this.setState(VOICE_STATES.SPEAKING);
      window.speechSynthesis.speak(utterance);
    } catch {
      if (token === this.speechToken) this.finishSpeech();
    }
  }

  stopSpeaking() {
    this.speechToken += 1;
    if (speechSupported()) {
      try {
        window.speechSynthesis.cancel();
              } catch {
        // nothing was speaking
      }
    }
    if (this.speaking) this.finishSpeech();
  }

  finishSpeech() {
    this.speaking = false;
    if (this.running) {
      this.setState(VOICE_STATES.WAKE);
    }
    this.onSpeechEnd();
  }
}

export function pickPreferredVoice(voices = []) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const english = voices.filter((voice) => /^en/i.test(voice.lang || ''));
  const pool = english.length > 0 ? english : voices;
  const preferred = [
    /google us english/i,
    /microsoft (aria|jenny|guy|zira|david)/i,
    /samantha/i,
    /daniel/i,
    /^alex$/i
  ];
  for (const pattern of preferred) {
    const hit = pool.find((voice) => pattern.test(voice.name || ''));
    if (hit) return hit;
  }
  return pool.find((voice) => voice.default) || pool[0];
}
