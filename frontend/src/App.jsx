import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  Cpu,
  Ear,
  LogOut,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  ScrollText,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
  Volume2,
  VolumeX,
  Wallet
} from 'lucide-react';
import axios from 'axios';
import { ethers } from 'ethers';
import { API_BASE } from './config/api';
import { redactSensitiveContent, sanitizeMessagesForStorage } from './lib/redaction';
import {
  VOICE_STATES,
  WAKE_WORD_LABEL,
  VoiceModeEngine,
  matchVoiceCommand,
  matchWakeWord,
  sanitizeForSpeech
} from './lib/voice-mode';
import VoiceConsole from './components/VoiceConsole';
import TransactionLedger from './components/TransactionLedger';
import BrandGlyph from './components/BrandGlyph';
import ThemeToggle from './components/ThemeToggle';
import { isThemePref, nextThemePref, resolveTheme } from './lib/theme';
import './App.css';

const SEPOLIA_CHAIN_ID = '0xaa36a7'; // 11155111
const CHAT_HISTORY_PREFIX = 'onchain_chat_history_';
const MAX_STORED_MESSAGES = 200;
const FALLBACK_SILENCE_MS = 1400;

// First-run prompts. They draft into the composer instead of sending, so nothing
// leaves the browser until the user presses send.
const CHAT_SUGGESTIONS = [
  'What is my balance?',
  'Send 0.01 ETH to @alice',
  'Show my transaction history',
  'Explain gas fees in simple terms'
];

function extractResetSecret(message) {
  if (!message || typeof message !== 'string') return '';
  const match = message.match(/^\s*(?:reset|change)\s+(?:pin|password)\s+(?:to\s+)?(.+?)\s*$/i);
  return match?.[1]?.trim() || '';
}

function getDefaultGreeting(name = '') {
  if (name) {
    return `Hello ${name}! I am IntentPay Assistant. How can I help you today?`;
  }
  return "Hello! I am IntentPay Assistant. I can help you manage your wallet and send payments securely.";
}

function getChatStorageKey(userId) {
  return `${CHAT_HISTORY_PREFIX}${userId || 'anonymous'}`;
}

function App() {
  const [userId, setUserId] = useState(localStorage.getItem('userId') || '');
  const [authToken, setAuthToken] = useState(localStorage.getItem('authToken') || '');
  const [password, setPassword] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(!!(localStorage.getItem('userId') && localStorage.getItem('authToken')));
  const [isSignup, setIsSignup] = useState(false);
  const [wallet, setWallet] = useState(null);
  const [messages, setMessages] = useState([
    { role: 'ai', content: getDefaultGreeting() }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [refreshError, setRefreshError] = useState('');
  const [mode, setMode] = useState('custodial'); // 'custodial' or 'non-custodial'
  const [mmAddress, setMmAddress] = useState('');
  const [history, setHistory] = useState([]);
  const [securityStatus, setSecurityStatus] = useState({ score: 100, status: 'Secure', recentLogs: [] });
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceHintDismissed, setVoiceHintDismissed] = useState(false);

  // Voice mode: hands-free wake-word control with spoken replies.
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState(VOICE_STATES.OFF);
  const [voiceTranscript, setVoiceTranscript] = useState(null);
  const [voiceLog, setVoiceLog] = useState([]);
  const [voiceError, setVoiceError] = useState('');
  const [voiceHint, setVoiceHint] = useState('');
  const [showVoiceHelp, setShowVoiceHelp] = useState(false);
  const [fallbackListening, setFallbackListening] = useState(false);
  const [receiveHint, setReceiveHint] = useState('');
  const [themePref, setThemePref] = useState(() => {
    const stored = localStorage.getItem('intentpay-theme');
    return isThemePref(stored) ? stored : 'system';
  });

  const chatEndRef = useRef(null);
  const chatInputRef = useRef(null);
  const spokenMessageCountRef = useRef(0);
  const speechRecognitionRef = useRef(null);
  const speechDraftRef = useRef('');
  const voiceEngineRef = useRef(null);
  const voiceModeEngineRef = useRef(null);
  const voiceModeRef = useRef(false);
  const voiceCommandRef = useRef(null);
  const lastAiMessageRef = useRef('');
  const voiceLogIdRef = useRef(0);
  const fallbackStoppingRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const sessionCheckedRef = useRef(false);

  const authHeaders = useMemo(() => ({
    'x-user-id': userId,
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(!authToken && password ? { 'x-password': password } : {})
  }), [userId, authToken, password]);

  const canUseSpeech = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const canUseNativeSpeechToText = typeof window !== 'undefined' && (
    'webkitSpeechRecognition' in window || 'SpeechRecognition' in window
  );
  const canUseWhisperSpeechToText = typeof window !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && !!(window.AudioContext || window.webkitAudioContext);
  const canUseSpeechToText = canUseNativeSpeechToText || canUseWhisperSpeechToText;
  // Wake-word mode needs continuous recognition. Whisper cannot run in real time,
  // so it is offered as a one-command fallback instead of pretending otherwise.
  const wakeWordSupported = VoiceModeEngine.isSupported();
  const voiceModeAvailable = wakeWordSupported || canUseWhisperSpeechToText;

  const stopSpeaking = useCallback(() => {
    const engine = voiceModeEngineRef.current;
    if (engine?.running) {
      engine.stopSpeaking();
      return;
    }
    if (!canUseSpeech) return;
    window.speechSynthesis.cancel();
  }, [canUseSpeech]);

  const speakText = useCallback((text) => {
    if (!text) return;
    // In voice mode the engine owns speech so that "stop" can interrupt it and
    // the microphone is only released when the answer finishes.
    const engine = voiceModeEngineRef.current;
    if (engine?.running) {
      engine.speak(text);
      return;
    }
    if (!canUseSpeech) return;
    const utterance = new SpeechSynthesisUtterance(sanitizeForSpeech(text) || String(text));
    utterance.rate = 1;
    utterance.pitch = 1;
    stopSpeaking();
    window.speechSynthesis.speak(utterance);
  }, [canUseSpeech, stopSpeaking]);

  const pushVoiceLog = useCallback((kind, text) => {
    voiceLogIdRef.current += 1;
    const entry = { id: voiceLogIdRef.current, kind, text, at: new Date().toISOString() };
    setVoiceLog((prev) => [entry, ...prev].slice(0, 8));
  }, []);

  const speakReply = useCallback((text) => {
    const clean = typeof text === 'string' ? text : '';
    if (clean.trim()) lastAiMessageRef.current = clean;
    if (!voiceModeRef.current) return;
    const engine = voiceModeEngineRef.current;
    if (!engine?.running) return;
    pushVoiceLog('reply', sanitizeForSpeech(clean).slice(0, 90));
    engine.speak(clean);
  }, [pushVoiceLog]);

  const clearAuthAndReturnToLogin = useCallback((message = '') => {
    sessionCheckedRef.current = false;
    localStorage.removeItem('userId');
    localStorage.removeItem('authToken');
    setUserId('');
    setAuthToken('');
    setPassword('');
    setIsLoggedIn(false);
    setWallet(null);
    setHistory([]);
    setSecurityStatus({ score: 100, status: 'Secure', recentLogs: [] });
    setLastRefreshAt(null);
    setRefreshError('');
    setMessages([{ role: 'ai', content: getDefaultGreeting() }]);
    if (message) setError(message);
  }, []);

  const refreshDashboard = useCallback(async (manual = false) => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    setRefreshError('');

    const headers = authHeaders;

    try {
      const [walletRes, historyRes, securityRes] = await Promise.allSettled([
        axios.get(`${API_BASE}/wallet/${userId}`, { headers }),
        axios.get(`${API_BASE}/history/${userId}`, { headers }),
        axios.get(`${API_BASE}/security-status/${userId}`, { headers })
      ]);

      const issues = [];
      const unauthorized = [walletRes, historyRes, securityRes].some(
        (r) => r.status === 'rejected' && r.reason?.response?.status === 401
      );
      if (unauthorized) {
        clearAuthAndReturnToLogin('Session expired. Please log in again.');
        return;
      }
      let refreshedAnything = false;

      if (walletRes.status === 'fulfilled' && walletRes.value?.data?.success) {
        setWallet(walletRes.value.data);
        refreshedAnything = true;
      } else {
        issues.push(walletRes.reason?.response?.data?.message || 'Wallet refresh failed');
      }

      if (historyRes.status === 'fulfilled' && historyRes.value?.data?.success) {
        setHistory(historyRes.value.data.transactions || []);
        refreshedAnything = true;
      } else {
        issues.push(historyRes.reason?.response?.data?.message || 'History refresh failed');
      }

      if (securityRes.status === 'fulfilled' && securityRes.value?.data?.success) {
        setSecurityStatus(securityRes.value.data);
        refreshedAnything = true;
      } else {
        issues.push(securityRes.reason?.response?.data?.message || 'Security refresh failed');
      }

      if (refreshedAnything) {
        setLastRefreshAt(new Date());
      }

      if (issues.length > 0) {
        const firstIssue = issues[0];
        setRefreshError(firstIssue);
        if (manual) {
          setMessages(prev => [...prev, { role: 'ai', content: `Refresh warning: ${firstIssue}` }]);
        }
      }
    } catch (err) {
      console.error("Manual refresh error", err);
      const msg = err.response?.data?.message || 'Refresh failed';
      setRefreshError(msg);
      if (manual) {
        setMessages(prev => [...prev, { role: 'ai', content: `Refresh failed: ${msg}` }]);
      }
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  }, [authHeaders, userId, clearAuthAndReturnToLogin]);

  /**
   * Theme is a preference, not just a palette switch: "system" follows the OS
   * until the user makes an explicit choice, and index.html has already applied
   * the resolved value before first paint so there is no flash.
   */
  const [systemPrefersLight, setSystemPrefersLight] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event) => setSystemPrefersLight(event.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  const resolvedTheme = resolveTheme(themePref, systemPrefersLight);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    localStorage.setItem('intentpay-theme', themePref);
  }, [themePref, resolvedTheme]);

  const cycleTheme = () => {
    setThemePref((current) => nextThemePref(current));
  };


  useEffect(() => {
    localStorage.removeItem('password');
    if (localStorage.getItem('userId') && !localStorage.getItem('authToken')) {
      localStorage.removeItem('userId');
      setUserId('');
      setIsLoggedIn(false);
    }
  }, []);

  // Landing on a stale zero balance makes a console feel broken, so the dashboard
  // loads itself once a session exists instead of waiting for a manual refresh.
  useEffect(() => {
    if (!isLoggedIn || !userId || !authToken) return;
    refreshDashboard();
  }, [isLoggedIn, userId, authToken, refreshDashboard]);

  useEffect(() => {
    if (!isLoggedIn || !userId || !authToken || sessionCheckedRef.current) return;

    sessionCheckedRef.current = true;
    axios.get(`${API_BASE}/auth/me`, { headers: authHeaders })
      .catch(() => {
        clearAuthAndReturnToLogin('Session expired. Please log in again.');
      });
  }, [isLoggedIn, userId, authToken, authHeaders, clearAuthAndReturnToLogin]);

  useEffect(() => {
    if (!isLoggedIn || !userId) {
      setMessages([{ role: 'ai', content: getDefaultGreeting() }]);
      return;
    }

    try {
      const raw = localStorage.getItem(getChatStorageKey(userId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
          return;
        }
      }
    } catch (err) {
      console.error('Failed to load stored chat history', err);
    }

    setMessages([{ role: 'ai', content: getDefaultGreeting(userId) }]);
  }, [isLoggedIn, userId]);

  useEffect(() => {
    if (!isLoggedIn || !userId) return;
    try {
      const limited = messages.slice(-MAX_STORED_MESSAGES);
      const sanitized = sanitizeMessagesForStorage(limited);
      localStorage.setItem(getChatStorageKey(userId), JSON.stringify(sanitized));
    } catch (err) {
      console.error('Failed to persist chat history', err);
    }
  }, [messages, isLoggedIn, userId]);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, loading]);

  useEffect(() => {
    if (voiceMode) {
      // Voice mode speaks every reply through the engine; the playback toggle
      // only drives typed chat.
      spokenMessageCountRef.current = messages.length;
      return;
    }
    if (!voiceEnabled || !canUseSpeech) {
      spokenMessageCountRef.current = messages.length;
      return;
    }
    if (messages.length <= spokenMessageCountRef.current) return;

    const incoming = messages.slice(spokenMessageCountRef.current);
    const latestAi = [...incoming].reverse().find(
      (m) => m.role === 'ai' && typeof m.content === 'string' && m.content.trim() && !m.content.startsWith('*Thinking:')
    );
    if (latestAi) {
      lastAiMessageRef.current = latestAi.content;
      speakText(latestAi.content);
    }
    spokenMessageCountRef.current = messages.length;
  }, [messages, voiceEnabled, voiceMode, canUseSpeech, speakText]);

  useEffect(() => {
    return () => stopSpeaking();
  }, [stopSpeaking]);

  useEffect(() => {
    return () => {
      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.onresult = null;
        speechRecognitionRef.current.onerror = null;
        speechRecognitionRef.current.onend = null;
        try {
          speechRecognitionRef.current.stop();
        } catch {
          // no-op during unmount cleanup
        }
      }

      if (voiceEngineRef.current) {
        try {
          voiceEngineRef.current.stopAndTranscribe();
        } catch {
          // no-op during unmount cleanup
        }
      }

      if (voiceModeEngineRef.current) {
        try {
          voiceModeEngineRef.current.stop();
        } catch {
          // no-op during unmount cleanup
        }
      }
    };
  }, []);

  const handleAuth = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const endpoint = isSignup ? '/signup' : '/login';
      const resp = await axios.post(`${API_BASE}${endpoint}`, { userId, password });

      if (resp.data.success) {
        const token = resp.data.token;
        if (!token) {
          setError('Authentication failed: server did not return a session token. Please restart backend and login again.');
          setIsLoggedIn(false);
          return;
        }
        localStorage.setItem('userId', userId);
        localStorage.setItem('authToken', token);
        setAuthToken(token);
        sessionCheckedRef.current = false;
        setPassword('');
        setIsLoggedIn(true);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Authentication failed');
    }
  };

  const handleLogout = () => {
    if (authToken) {
      axios.post(`${API_BASE}/logout`, {}, { headers: authHeaders }).catch(() => {});
    }
    clearAuthAndReturnToLogin();
  };

  const clearChatHistory = () => {
    if (!userId) return;
    localStorage.removeItem(getChatStorageKey(userId));
    setMessages([{ role: 'ai', content: getDefaultGreeting(userId) }]);
  };

  const submitUserMessage = async (rawMessage, { speak = false } = {}) => {
    if (!rawMessage || !String(rawMessage).trim()) return;
    const userMsg = String(rawMessage).trim();
    // The raw text is what the server needs (it may carry an approval secret), but
    // the on-screen copy is redacted so a spoken secret never lands in the DOM.
    const displayMsg = redactSensitiveContent(userMsg);
    let replyText = '';
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: displayMsg }]);
    setLoading(true);

    try {
      const resp = await axios.post(`${API_BASE}/chat`, {
        userId,
        message: userMsg,
        mode: mode,
        activeAddress: mode === 'non-custodial' ? mmAddress : null
      }, { headers: authHeaders });

      if (resp.data.thought) {
        setMessages(prev => [...prev, { role: 'ai', content: `*Thinking: ${resp.data.thought}*` }]);
      }
      setMessages(prev => [...prev, { role: 'ai', content: resp.data.message }]);
      replyText = resp.data.message || '';

      const passwordWasUpdated = !!resp.data.passwordUpdated;
      if (passwordWasUpdated) {
        const newSecret = extractResetSecret(userMsg);
        if (newSecret) {
          setPassword(newSecret);
        }
      }

      if (resp.data.action === 'sign_required') {
        await signAndSend(resp.data.transactions);
      }

      const hasExecutedTransactions = Array.isArray(resp.data.details) && resp.data.details.length > 0;

      // Refresh dashboard only after transaction execution (custodial).
      if (!passwordWasUpdated && hasExecutedTransactions) {
        refreshDashboard();
      }
    } catch (err) {
      const serverMsg = err.response?.data?.message;
      if (err.response?.status === 401) {
        replyText = 'Session expired. Please log in again.';
        clearAuthAndReturnToLogin('Session expired. Please log in again.');
        return;
      }
      const fallback = err.response?.status === 401
        ? "Authentication error. Try logging in again."
        : "Request failed. Please try again.";
      replyText = serverMsg || fallback;
      setMessages(prev => [...prev, { role: 'ai', content: replyText }]);
    } finally {
      setLoading(false);
      if (speak) speakReply(replyText);
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    await submitUserMessage(input);
  };

  // -------------------------------------------------------------------------
  // Voice mode
  // -------------------------------------------------------------------------

  /**
   * Run a recognised command. Everything that can change wallet state is handed
   * to the same chat endpoint that typed input uses, so voice mode adds a
   * microphone, never a second execution path.
   */
  const handleVoiceCommand = async (command) => {
    if (!command) return;
    const engine = voiceModeEngineRef.current;
    const release = () => engine?.setBusy(false);

    switch (command.type) {
      case 'stop_speaking':
        engine?.stopSpeaking();
        release();
        return;

      case 'repeat': {
        const previous = lastAiMessageRef.current;
        if (previous) {
          if (engine?.running) engine.speak(previous);
          else speakText(previous);
        } else if (engine?.running) {
          engine.speak('There is nothing to repeat yet.');
        }
        return;
      }

      case 'help':
        setShowVoiceHelp(true);
        if (engine?.running) {
          engine.speak('You can ask for your balance, send ETH to a contact, confirm a payment with your code, or cancel a staged payment. Say stop at any time.');
        } else {
          release();
        }
        return;

      case 'cancel_payment':
        await submitUserMessage('intentpay cancel', { speak: true });
        return;

      case 'confirm_payment':
        // The canonical phrase goes to the server; the console only ever shows
        // the redacted form.
        pushVoiceLog('dispatched', redactSensitiveContent(command.message));
        await submitUserMessage(command.message, { speak: true });
        return;

      default:
        await submitUserMessage(command.message, { speak: true });
    }
  };

  const stopVoiceMode = () => {
    voiceModeRef.current = false;
    setVoiceMode(false);
    setVoiceState(VOICE_STATES.OFF);
    setVoiceTranscript(null);
    setVoiceHint('');
    setVoiceError('');
    setFallbackListening(false);
    const engine = voiceModeEngineRef.current;
    if (engine) engine.stop();
  };

  const startVoiceMode = async () => {
    setVoiceError('');
    setVoiceHint('');
    setShowVoiceHelp(false);

    if (!wakeWordSupported) {
      setVoiceError('Wake-word voice mode needs Chrome or Edge. Use the tap-to-speak button below instead.');
      setVoiceMode(true);
      setVoiceState(VOICE_STATES.ERROR);
      return;
    }

    if (!voiceModeEngineRef.current) {
      voiceModeEngineRef.current = new VoiceModeEngine({
        onStateChange: setVoiceState,
        onError: (message) => setVoiceError(message),
        onSpeechEnd: () => voiceModeEngineRef.current?.setBusy(false),
        onCommand: (command) => {
          // A thrown handler must never wedge voice mode in the busy state.
          const release = (message) => {
            if (message) setVoiceError(message);
            voiceModeEngineRef.current?.setBusy(false);
          };
          try {
            const pending = voiceCommandRef.current?.(command);
            if (pending && typeof pending.catch === 'function') {
              pending.catch((err) => release(`Voice command failed: ${err.message}`));
            }
          } catch (err) {
            release(`Voice command failed: ${err.message}`);
          }
        },
        onTranscript: ({ text, kind, final }) => {
          if (kind === 'wake') {
            setVoiceTranscript(null);
            setVoiceHint('Go ahead, I am listening.');
            return;
          }
          if (kind === 'timeout') {
            setVoiceHint('I did not catch a command. Say the wake word again.');
            return;
          }
          if (!text) return;

          const safe = redactSensitiveContent(text);
          setVoiceTranscript({ text: safe, kind, final });
          // Ambient speech is shown so the user can see the mic working, but it is
          // deliberately kept out of the log to avoid noise.
          if (kind !== 'ambient') pushVoiceLog(kind, safe);
        }
      });
    }

    voiceModeRef.current = true;
    try {
      await voiceModeEngineRef.current.start();
      setVoiceMode(true);
      setVoiceHint(`Voice mode is live. Say “${WAKE_WORD_LABEL}” and your command.`);
    } catch (err) {
      voiceModeRef.current = false;
      setVoiceError(err.message);
      setVoiceState(VOICE_STATES.ERROR);
      setVoiceMode(true);
    }
  };

  const toggleVoiceMode = () => {
    if (voiceMode) stopVoiceMode();
    else startVoiceMode();
  };

  const stopFallbackRecording = async () => {
    if (fallbackStoppingRef.current) return;
    const engine = voiceEngineRef.current;
    setFallbackListening(false);
    if (!engine) return;

    fallbackStoppingRef.current = true;
    setVoiceHint('Transcribing...');
    try {
      const text = await engine.stopAndTranscribe();
      if (!text) {
        setVoiceHint('I did not catch that. Try again.');
        setVoiceState(VOICE_STATES.WAKE);
        return;
      }

      // The tap replaced the wake word, so accept the whole utterance.
      const wake = matchWakeWord(text);
      const spoken = (wake?.command || text).trim();
      const safe = redactSensitiveContent(spoken);
      setVoiceTranscript({ text: safe, kind: 'command', final: true });
      pushVoiceLog('command', safe);
      await handleVoiceCommand(matchVoiceCommand(spoken));
    } catch (err) {
      setVoiceError(`Transcription failed: ${err.message}`);
      setVoiceState(VOICE_STATES.WAKE);
    } finally {
      fallbackStoppingRef.current = false;
    }
  };

  const toggleFallbackRecording = async () => {
    if (fallbackListening) {
      await stopFallbackRecording();
      return;
    }

    setVoiceError('');
    try {
      if (!voiceEngineRef.current) {
        const { IntentVoiceEngine } = await import('./lib/intent-voice');
        voiceEngineRef.current = new IntentVoiceEngine();
      }
      setFallbackListening(true);
      setVoiceState(VOICE_STATES.CAPTURING);
      setVoiceHint('Speak your command. Recording stops when you pause.');
      await voiceEngineRef.current.start({
        silenceTimeoutMs: FALLBACK_SILENCE_MS,
        onSilence: () => { stopFallbackRecording(); }
      });
    } catch (err) {
      setFallbackListening(false);
      setVoiceState(VOICE_STATES.ERROR);
      setVoiceError(`Could not start the microphone: ${err.message}`);
    }
  };

  // The engine captures its callbacks at construction, so it always calls the
  // latest handler instead of a stale first render.
  useEffect(() => {
    voiceCommandRef.current = handleVoiceCommand;
  });

  const startWhisperSpeechToText = async () => {
    try {
      speechDraftRef.current = '';
      setInput('');
      if (!voiceEngineRef.current) {
        const { IntentVoiceEngine } = await import('./lib/intent-voice');
        voiceEngineRef.current = new IntentVoiceEngine();
      }
      await voiceEngineRef.current.start();
      setIsListening(true);
      setMessages(prev => [...prev, { role: 'ai', content: 'Listening... click mic again to stop and transcribe.' }]);
    } catch (err) {
      setIsListening(false);
      setMessages(prev => [...prev, { role: 'ai', content: `Could not start microphone: ${err.message}` }]);
    }
  };

  const startSpeechToText = () => {
    if (!canUseNativeSpeechToText && !canUseWhisperSpeechToText) {
      setMessages(prev => [...prev, { role: 'ai', content: 'Speech-to-text is not supported in this browser.' }]);
      return;
    }
    if (isListening) return;

    if (!canUseNativeSpeechToText && canUseWhisperSpeechToText) {
      startWhisperSpeechToText();
      return;
    }

    const RecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new RecognitionClass();
    speechRecognitionRef.current = recognition;
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    let finalTranscript = '';
    speechDraftRef.current = '';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) {
          finalTranscript += text;
        } else {
          interim += text;
        }
      }
      const transcript = (finalTranscript + interim).trim();
      speechDraftRef.current = transcript;
      setInput(transcript);
    };

    recognition.onerror = () => {
      setMessages(prev => [...prev, { role: 'ai', content: 'Microphone input failed. Check browser mic permission and try again.' }]);
      setIsListening(false);
    };

    recognition.onend = async () => {
      setIsListening(false);
      const spoken = (finalTranscript || speechDraftRef.current || '').trim();
      if (spoken) {
        speechDraftRef.current = '';
        setInput('');
        await submitUserMessage(spoken);
      } else {
        setMessages(prev => [...prev, { role: 'ai', content: "I couldn't catch that voice input. Please try again." }]);
      }
    };

    try {
      setIsListening(true);
      setMessages(prev => [...prev, { role: 'ai', content: 'Listening... speak your command now.' }]);
      recognition.start();
    } catch (err) {
      setIsListening(false);
      setMessages(prev => [...prev, { role: 'ai', content: `Could not start microphone: ${err.message}` }]);
    }
  };

  const stopSpeechToText = () => {
    const pendingTranscript = (speechDraftRef.current || input || '').trim();

    if (voiceEngineRef.current && !canUseNativeSpeechToText) {
      setIsListening(false);
      setMessages(prev => [...prev, { role: 'ai', content: 'Transcribing voice input...' }]);
      voiceEngineRef.current.stopAndTranscribe()
        .then((text) => {
          if (text) {
            setInput(text);
            setMessages(prev => [...prev, { role: 'ai', content: 'Voice captured. Review the text in the input box and press Send.' }]);
          } else {
            setMessages(prev => [...prev, { role: 'ai', content: "I couldn't catch that voice input. Please try again." }]);
          }
        })
        .catch((err) => {
          setMessages(prev => [...prev, { role: 'ai', content: `Transcription failed: ${err.message}` }]);
        });
      return;
    }

    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.stop();
      } catch {
        // no-op; recognizer may already be stopped
      }
    }

    setIsListening(false);
    if (pendingTranscript) {
      speechDraftRef.current = '';
      setInput('');
      submitUserMessage(pendingTranscript);
    } else {
      setMessages(prev => [...prev, { role: 'ai', content: "I couldn't catch that voice input. Please try again." }]);
    }
  };

  const copyToClipboard = () => {
    const address = wallet?.address;
    if (!address) return false;
    try {
      // undefined on insecure origins, which is why this is not assumed.
      navigator.clipboard?.writeText(address);
    } catch {
      // Clipboard access is a convenience, never a requirement.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    return true;
  };

  // "Send" and "Receive" hand the user to the assistant instead of pretending to
  // be a transfer form: every transfer in this app is conversational by design.
  const startTransferIntent = () => {
    setInput('send 0.01 ETH to ');
    chatInputRef.current?.focus();
  };

  const handleReceive = () => {
    if (!copyToClipboard()) {
      setReceiveHint('No wallet yet');
    } else {
      setReceiveHint('Address copied');
    }
    setTimeout(() => setReceiveHint(''), 2400);
  };

  const connectMetaMask = async () => {
    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        
        // Check network immediately
        const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
        if (currentChainId !== SEPOLIA_CHAIN_ID) {
          try {
            await window.ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: SEPOLIA_CHAIN_ID }],
            });
          } catch {
            console.warn("Network switch failed on connect, will retry on sign");
          }
        }

        setMmAddress(accounts[0]);
        setMode('non-custodial');
      } catch (err) {
        console.error("MetaMask connection failed", err);
      }
    } else {
      alert("Please install MetaMask!");
    }
  };

  const handleSepoliaBadgeClick = async () => {
    if (!window.ethereum) {
      setMessages(prev => [...prev, { role: 'ai', content: 'MetaMask is not installed. Sepolia switch is only available via MetaMask.' }]);
      return;
    }

    try {
      const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
      if (currentChainId === SEPOLIA_CHAIN_ID) {
        setMessages(prev => [...prev, { role: 'ai', content: 'You are already on Sepolia Testnet.' }]);
        return;
      }

      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: SEPOLIA_CHAIN_ID }],
        });
      } catch (switchError) {
        if (switchError.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: SEPOLIA_CHAIN_ID,
                chainName: 'Sepolia Test Network',
                nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
                rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
                blockExplorerUrls: ['https://sepolia.etherscan.io'],
              },
            ],
          });
        } else {
          throw switchError;
        }
      }

      setMessages(prev => [...prev, { role: 'ai', content: 'Switched wallet network to Sepolia Testnet.' }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'ai', content: `Network switch failed: ${err.message}` }]);
    }
  };

  const signAndSend = async (transactions) => {
    if (!window.ethereum) return;
    
    setLoading(true);
    try {
      // 1. Ensure we are on Sepolia
      const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
      if (currentChainId !== SEPOLIA_CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: SEPOLIA_CHAIN_ID }],
          });
        } catch (switchError) {
          // This error code indicates that the chain has not been added to MetaMask.
          if (switchError.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: SEPOLIA_CHAIN_ID,
                  chainName: 'Sepolia Test Network',
                  nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
                  rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
                  blockExplorerUrls: ['https://sepolia.etherscan.io'],
                },
              ],
            });
          } else {
            throw switchError;
          }
        }
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      for (const tx of transactions) {
        const txResponse = await signer.sendTransaction({
          to: tx.to,
          value: tx.value
        });
        setMessages(prev => [...prev, { role: 'ai', content: `Transaction sent! Hash: ${txResponse.hash}` }]);
        
        // Record in backend history
        await axios.post(`${API_BASE}/record-tx`, {
          userId,
          tx: {
            type: 'send',
            to: tx.to,
            amount: ethers.formatEther(tx.value),
            hash: txResponse.hash,
            status: 'success',
            mode: 'non-custodial'
          }
        }, { headers: authHeaders });

        await txResponse.wait();
      }
      setMessages(prev => [...prev, { role: 'ai', content: "All transactions confirmed on-chain! 🎉" }]);
    } catch (err) {
      console.error("MetaMask Error:", err);
      setMessages(prev => [...prev, { role: 'ai', content: `MetaMask Error: ${err.message}` }]);
    } finally {
      setLoading(false);
      refreshDashboard();
    }
  };

  const shortAddress = (value) => {
    const text = String(value || '');
    if (!text) return '—';
    return text.length <= 14 ? text : `${text.slice(0, 6)}…${text.slice(-4)}`;
  };

  const custodyTone = securityStatus.score > 80
    ? 'is-secure'
    : securityStatus.score > 50 ? 'is-warning' : 'is-critical';

  const activeAddress = mode === 'non-custodial' && mmAddress ? mmAddress : wallet?.address;
  const guardrails = wallet?.guardrails || {};
  const dailyLimit = parseFloat(guardrails.dailyLimit || '0') || 0;
  // The server rolls the daily counter lazily, so a stale date means "nothing spent".
  const todayKey = new Date().toISOString().split('T')[0];
  const spentToday = guardrails.lastSpentDate === todayKey
    ? (parseFloat(guardrails.spentToday || '0') || 0)
    : 0;
  const limitPct = dailyLimit > 0 ? Math.min(100, Math.round((spentToday / dailyLimit) * 100)) : 0;
  const whitelistCount = Array.isArray(guardrails.whitelist) ? guardrails.whitelist.length : 0;
  const contactEntries = wallet?.contacts ? Object.entries(wallet.contacts) : [];
  const recentLogs = securityStatus.recentLogs || [];

  if (!isLoggedIn) {
    return (
      <div className="app-shell">
        <div className="auth">
          <div className="auth__card reveal">
          <div className="auth__theme">
            <ThemeToggle
              preference={themePref}
              resolved={resolvedTheme}
              onCycle={cycleTheme}
            />
          </div>
            <aside className="auth__aside">
              <div className="topbar__brand">
                <span className="brandmark__glyph">
                  <BrandGlyph size={18} />
                </span>
                <span className="brandmark__text">
                  <span className="brandmark__name">IntentPay</span>
                  <span className="brandmark__tagline">Secure wallet protocol</span>
                </span>
              </div>

              <h1 className="auth__aside-title">
                The model proposes.
                <br />
                <em>You approve.</em>
              </h1>

              <p className="auth__aside-lead">
                IntentPay turns a sentence into a prepared Ethereum transaction, then stops
                at the wallet boundary and waits for you.
              </p>

              <div className="auth__rule" />

              <ul className="review-points">
                <li className="review-point">
                  <span className="review-point__index">01</span>
                  <span className="review-point__text">
                    <strong>Nothing signs itself.</strong> Every transfer is staged, priced and
                    reviewed before it is broadcast.
                  </span>
                </li>
                <li className="review-point">
                  <span className="review-point__index">02</span>
                  <span className="review-point__text">
                    <strong>Guardrails are re-checked at execution.</strong> Limits, whitelists and
                    balances are verified again after approval.
                  </span>
                </li>
                <li className="review-point">
                  <span className="review-point__index">03</span>
                  <span className="review-point__text">
                    <strong>Secrets stay local.</strong> Your approval code never reaches the model,
                    and keys are encrypted at rest.
                  </span>
                </li>
              </ul>
            </aside>

            <div className="auth__form">
              <h2 className="auth__title">{isSignup ? 'Create a wallet' : 'Sign in'}</h2>
              <p className="auth__sub">
                {isSignup
                  ? 'A keypair and an encrypted keystore are generated for this account.'
                  : 'Enter your credentials to open the console.'}
              </p>

              <form onSubmit={handleAuth}>
                <div className="field">
                  <label className="field__label" htmlFor="auth-username">Account</label>
                  <input
                    id="auth-username"
                    type="text"
                    className="field__input"
                    placeholder="your-handle"
                    autoComplete="username"
                    spellCheck="false"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    required
                  />
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="auth-password">Passphrase</label>
                  <input
                    id="auth-password"
                    type="password"
                    className="field__input"
                    placeholder="••••••••••"
                    autoComplete={isSignup ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>

                {error && (
                  <p className="form-error" role="alert">
                    <AlertTriangle size={14} />
                    {error}
                  </p>
                )}

                <button type="submit" className="btn btn--primary btn--block">
                  {isSignup ? 'Create wallet' : 'Open console'}
                </button>
              </form>

              <p className="auth__switch">
                {isSignup ? 'Already holding a wallet?' : 'No wallet yet?'}
                <button
                  type="button"
                  className="auth__switch-btn"
                  onClick={() => setIsSignup(!isSignup)}
                >
                  {isSignup ? 'Sign in' : 'Create one'}
                </button>
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="topbar__brand">
            <span className="brandmark__glyph">
              <BrandGlyph size={18} />
            </span>
            <span className="brandmark__text">
              <span className="brandmark__name">IntentPay</span>
              <span className="brandmark__tagline">Secure wallet protocol</span>
            </span>
          </div>

          <div className="topbar__meta">
            <button
              type="button"
              className="net-chip"
              onClick={handleSepoliaBadgeClick}
              title="Switch the connected wallet to Sepolia"
            >
              <span className="net-chip__dot" />
              Sepolia testnet
            </button>

            <div className={`custody ${custodyTone}`} title="Derived from recent security events">
              <div className="custody__head">
                <span className="custody__label">Custody</span>
                <span className="custody__value">
                  {securityStatus.score}% {securityStatus.status}
                </span>
              </div>
              <div
                className="custody__meter"
                role="meter"
                aria-valuenow={securityStatus.score}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Security score"
              >
                <div className="custody__fill" style={{ width: `${securityStatus.score}%` }} />
              </div>
            </div>

            <div className="account">
              <span className="account__avatar" aria-hidden="true">
                {(userId || '?').slice(0, 2).toUpperCase()}
              </span>
              <span className="account__text">
                <span className="account__name">{userId}</span>
                <span className="account__id">{shortAddress(activeAddress)}</span>
              </span>
            </div>

            <div className="topbar__actions">
              <ThemeToggle
                preference={themePref}
                resolved={resolvedTheme}
                onCycle={cycleTheme}
              />
              <button
                type="button"
                onClick={connectMetaMask}
                className={`btn btn--ghost btn--sm ${mmAddress ? 'is-active' : ''}`}
                title={mmAddress ? `Connected: ${mmAddress}` : 'Connect a browser wallet'}
              >
                <Wallet size={14} />
                {mmAddress ? shortAddress(mmAddress) : 'Connect wallet'}
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="btn btn--icon"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="workspace">
        <div className="workspace__main">
          <section
            className={`balance reveal reveal--1 ${isRefreshing ? 'is-refreshing' : ''}`}
            aria-label="Wallet balance"
          >
            <div className="balance__top">
              <span className="balance__label">Total balance</span>
              <button
                type="button"
                onClick={() => refreshDashboard(true)}
                className="btn btn--icon btn--sm"
                style={{ marginLeft: 'auto' }}
                disabled={isRefreshing}
                title="Refresh balance"
                aria-label="Refresh balance"
              >
                <RefreshCw size={14} className={isRefreshing ? 'is-spinning' : undefined} />
              </button>
            </div>

            <div className="balance__figure">
              {wallet ? parseFloat(wallet.balance).toFixed(4) : '0.0000'}
              <span className="balance__unit">ETH</span>
            </div>

            <div className="balance__allowance">
              <div className="balance__allowance-head">
                <span className="balance__label">Daily allowance</span>
                <span className="balance__allowance-value">
                  {spentToday.toFixed(4)} / {dailyLimit > 0 ? dailyLimit.toFixed(2) : '0.00'} ETH
                </span>
              </div>
              <div
                className="meter"
                role="meter"
                aria-valuenow={limitPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Share of the daily allowance used"
              >
                <div
                  className={`meter__fill${limitPct >= 100 ? ' is-out' : limitPct >= 80 ? ' is-near' : ''}`}
                  style={{ width: `${limitPct}%` }}
                />
              </div>
            </div>

            <div className="balance__foot">
              {wallet?.address && (
                <button
                  type="button"
                  className={`balance__addr ${copied ? 'is-copied' : ''}`}
                  onClick={copyToClipboard}
                  aria-label="Copy wallet address"
                >
                  <span>{wallet.address.slice(0, 10)}…{wallet.address.slice(-6)}</span>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              )}

              <div className="balance__stat">
                <span className="balance__label">Updated</span>
                <span className="balance__stat-value">
                  {lastRefreshAt ? lastRefreshAt.toLocaleTimeString() : '—'}
                </span>
              </div>

              <div className="balance__stat">
                <span className="balance__label">Recipients</span>
                <span className="balance__stat-value">
                  {whitelistCount === 0 ? 'Any address' : `${whitelistCount} allowed`}
                </span>
              </div>
            </div>

            {refreshError && <p className="balance__error">{refreshError}</p>}
          </section>

          <section className="panel reveal reveal--2">
            <div className="panel__head">
              <span className="panel__title">
                <ShieldCheck size={15} />
                Execution path
              </span>
              <span className="panel__meta">
                {mode === 'custodial' ? 'server signed' : 'wallet signed'}
              </span>
            </div>
            <div className="panel__body">
              <div className="seg" role="group" aria-label="Execution path">
                <button
                  type="button"
                  aria-pressed={mode === 'custodial'}
                  className={`seg__btn ${mode === 'custodial' ? 'is-active' : ''}`}
                  onClick={() => setMode('custodial')}
                >
                  <ShieldCheck size={14} />
                  Custodial
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'non-custodial'}
                  className={`seg__btn ${mode === 'non-custodial' ? 'is-active' : ''}`}
                  onClick={() => setMode('non-custodial')}
                >
                  <ShieldAlert size={14} />
                  Non-custodial
                </button>
              </div>

              <div className="actions" style={{ marginTop: 16 }}>
                <button type="button" className="action" onClick={startTransferIntent}>
                  <span className="action__icon">
                    <ArrowUpRight size={16} />
                  </span>
                  <span className="action__text">
                    <span className="action__title">Send</span>
                    <span className="action__hint">Draft a transfer with the assistant</span>
                  </span>
                </button>

                <button type="button" className="action" onClick={handleReceive}>
                  <span className="action__icon">
                    <ArrowDownLeft size={16} />
                  </span>
                  <span className="action__text">
                    <span className="action__title">Receive</span>
                    <span className="action__hint">
                      {receiveHint || 'Copy your deposit address'}
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </section>

          <section className="panel reveal reveal--3">
            <div className="panel__head">
              <span className="panel__title">
                <Users size={15} />
                Contacts
              </span>
              <span className="panel__meta">
                {contactEntries.length > 0 ? `${contactEntries.length} saved` : 'none yet'}
              </span>
            </div>
            {contactEntries.length > 0 ? (
              <div className="rail">
                {contactEntries.map(([handle, addr]) => (
                  <div key={handle} className="rail__item" title={addr}>
                    <span className="rail__handle">{handle}</span>
                    <span className="rail__addr">{shortAddress(addr)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rail__empty">
                No contacts yet. Tell the assistant “remember @alice is 0x…” to save one.
              </p>
            )}
          </section>

          <TransactionLedger transactions={history} />

          <section className="panel reveal reveal--4">
            <div className="panel__head">
              <span className="panel__title">
                <ScrollText size={15} />
                Security log
              </span>
              <span className="panel__meta">
                {recentLogs.length > 0 ? `last ${recentLogs.length}` : 'quiet'}
              </span>
            </div>
            {recentLogs.length > 0 ? (
              <div className="audit">
                {recentLogs.map((entry, index) => (
                  <div
                    key={`${entry.timestamp || 'log'}-${index}`}
                    className={`audit__row sev--${entry.severity || 'low'}`}
                  >
                    <span className="audit__dot" aria-hidden="true" />
                    <span className="audit__event">{entry.event}</span>
                    <span className="audit__time">
                      {entry.timestamp
                        ? new Date(entry.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit'
                          })
                        : '—'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="audit__empty">No security events recorded for this wallet.</p>
            )}
          </section>
        </div>

        <aside className="workspace__side">
          {voiceMode && (
            <VoiceConsole
              state={voiceState}
              supported={wakeWordSupported}
              error={voiceError}
              hint={voiceHint}
              transcript={voiceTranscript}
              log={voiceLog}
              showHelp={showVoiceHelp}
              fallbackAvailable={canUseWhisperSpeechToText}
              fallbackListening={fallbackListening}
              onClose={stopVoiceMode}
              onToggleHelp={() => setShowVoiceHelp((v) => !v)}
              onFallbackToggle={toggleFallbackRecording}
              onStopSpeaking={stopSpeaking}
            />
          )}

          <div className="chat">
            <div className="chat__head">
              <span className="chat__id">
                <Cpu size={15} />
              </span>
              <span className="chat__titling">
                <span className="chat__title">IntentPay Assistant</span>
                <span className="chat__sub">prepares · never signs</span>
              </span>

              <div className="chat__actions">
                <button
                  type="button"
                  onClick={toggleVoiceMode}
                  className={`btn btn--icon ${voiceMode ? 'is-active' : ''}`}
                  title={
                    voiceModeAvailable
                      ? voiceMode ? 'Turn off voice mode' : 'Turn on hands-free voice mode'
                      : 'Voice mode needs a browser with microphone support'
                  }
                  disabled={!voiceModeAvailable}
                  aria-pressed={voiceMode}
                  aria-label="Hands-free voice mode"
                >
                  {voiceMode ? <Radio size={15} /> : <Ear size={15} />}
                </button>

                <button
                  type="button"
                  onClick={() => setVoiceEnabled((v) => !v)}
                  className={`btn btn--icon ${voiceEnabled && !voiceMode ? 'is-active' : ''}`}
                  title={
                    voiceMode
                      ? 'Voice mode always speaks replies'
                      : canUseSpeech
                        ? voiceEnabled ? 'Disable spoken replies' : 'Speak replies aloud'
                        : 'Speech synthesis is not supported'
                  }
                  disabled={!canUseSpeech || voiceMode}
                  aria-pressed={voiceEnabled || voiceMode}
                  aria-label="Spoken replies"
                >
                  {voiceEnabled || voiceMode ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </button>

                <button
                  type="button"
                  onClick={clearChatHistory}
                  className="btn btn--icon"
                  title="Clear transcript"
                  aria-label="Clear transcript"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            {!voiceHintDismissed && !voiceMode && (
              <div className="notice">
                <span className="notice__text">
                  Voice input: tap the mic, speak, tap again to transcribe.
                </span>
                <button type="button" className="notice__cta" onClick={toggleVoiceMode}>
                  Go hands-free
                </button>
                <button
                  type="button"
                  className="btn btn--icon btn--sm"
                  onClick={() => setVoiceHintDismissed(true)}
                  aria-label="Dismiss voice hint"
                >
                  ×
                </button>
              </div>
            )}

            <div className="chat__log" role="log" aria-live="polite" aria-relevant="additions text">
              {messages.map((m, i) => {
                const raw = typeof m.content === 'string' ? m.content : '';
                const isThinking = raw.startsWith('*Thinking:');
                const body = isThinking ? raw.replace(/^\*Thinking:\s*/, '').replace(/\*$/, '') : raw;
                return (
                  <div
                    key={i}
                    className={`message ${m.role === 'user' ? 'message--user' : 'message--ai'}${
                      isThinking ? ' message--thinking' : ''
                    }`}
                  >
                    {isThinking ? `Thinking: ${body}` : body}
                  </div>
                );
              })}
              {loading && (
                <div className="chat__typing" aria-label="Assistant is working">
                  <span />
                  <span />
                  <span />
                </div>
              )}

              {!loading && messages.length <= 1 && (
                <div className="chat__suggestions">
                  <span className="chat__suggestions-title">Try asking</span>
                  {CHAT_SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="chat__suggestion"
                      onClick={() => {
                        setInput(suggestion);
                        chatInputRef.current?.focus();
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={sendMessage} className="chat__composer">
              <button
                type="button"
                onClick={isListening ? stopSpeechToText : startSpeechToText}
                className={`btn btn--icon ${isListening ? 'is-active' : ''}`}
                disabled={fallbackListening}
                title={
                  canUseSpeechToText
                    ? isListening ? 'Stop voice input' : 'Start voice input'
                    : 'Speech-to-text is not supported'
                }
                aria-label="Voice input"
              >
                {isListening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>

              <input
                ref={chatInputRef}
                type="text"
                className="field__input"
                placeholder={
                  voiceMode
                    ? 'Voice mode is on — you can still type'
                    : isListening ? 'Listening…' : 'Describe a payment…'
                }
                aria-label="Message the assistant"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />

              <button
                type="submit"
                className="btn btn--icon"
                title="Send"
                aria-label="Send message"
                disabled={!input.trim()}
              >
                <Send size={16} />
              </button>
            </form>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
