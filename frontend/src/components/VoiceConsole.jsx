import React from 'react';
import {
  AudioLines,
  Ear,
  HelpCircle,
  Mic,
  MicOff,
  Square,
  Volume2,
  X
} from 'lucide-react';
import { VOICE_COMMAND_HELP, VOICE_STATES, WAKE_WORD_LABEL } from '../lib/voice-mode';

const STATE_COPY = {
  [VOICE_STATES.OFF]: { label: 'Voice mode off', detail: 'Turn it on to talk to IntentPay.', tone: 'idle' },
  [VOICE_STATES.WAKE]: { label: 'Listening', detail: `Say “${WAKE_WORD_LABEL}, what is my balance?”`, tone: 'listening' },
  [VOICE_STATES.CAPTURING]: { label: 'Go ahead', detail: 'Listening to your command...', tone: 'capturing' },
  [VOICE_STATES.BUSY]: { label: 'Working on it', detail: 'Running your request.', tone: 'busy' },
  [VOICE_STATES.SPEAKING]: { label: 'Speaking', detail: 'Say “stop” to interrupt.', tone: 'speaking' },
  [VOICE_STATES.ERROR]: { label: 'Voice mode stopped', detail: 'Check the microphone and try again.', tone: 'error' }
};

const KIND_ICON = {
  command: Ear,
  dispatched: AudioLines,
  wake: Mic,
  ambient: MicOff,
  reply: Volume2
};

function timeOf(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

export default function VoiceConsole({
  state = VOICE_STATES.OFF,
  supported = true,
  error = '',
  transcript = null,
  log = [],
  showHelp = false,
  hint = '',
  fallbackAvailable = false,
  fallbackListening = false,
  onClose,
  onToggleHelp,
  onFallbackToggle,
  onStopSpeaking
}) {
  const copy = STATE_COPY[state] || STATE_COPY[VOICE_STATES.OFF];
  const tone = error ? 'error' : copy.tone;

  return (
    <section className="voice-console" aria-label="Voice mode">
      <header className="voice-console-header">
        <div className={`voice-orb ${tone}`} aria-hidden="true">
          <span className="voice-orb-ring" />
          <span className="voice-orb-ring delay" />
          <AudioLines size={20} />
        </div>
        <div className="voice-console-title">
          <h4>Voice Mode</h4>
          <span className={`voice-state ${tone}`}>{copy.label}</span>
        </div>
        <button
          type="button"
          className="btn voice-icon-btn"
          onClick={onToggleHelp}
          title="What can I say?"
          aria-pressed={showHelp}
        >
          <HelpCircle size={14} />
        </button>
        {state === VOICE_STATES.SPEAKING && (
          <button type="button" className="btn voice-icon-btn" onClick={onStopSpeaking} title="Stop speaking">
            <Square size={14} />
          </button>
        )}
        <button type="button" className="btn voice-icon-btn" onClick={onClose} title="Turn off voice mode">
          <X size={14} />
        </button>
      </header>

      <p className="voice-console-detail">{error || hint || copy.detail}</p>

      <div className={`voice-wave ${tone}`} aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((bar) => (
          <span key={bar} style={{ animationDelay: `${bar * 90}ms` }} />
        ))}
      </div>

      <div className="voice-transcript" role="log" aria-live="polite" aria-relevant="additions text">
        {transcript?.text ? (
          <p className={`voice-transcript-line ${transcript.kind} ${transcript.final ? 'final' : 'interim'}`}>
            {transcript.text}
          </p>
        ) : (
          <p className="voice-transcript-line placeholder">
            {supported ? 'Waiting for the wake word…' : 'Wake-word mode is unavailable in this browser.'}
          </p>
        )}
      </div>

      {!supported && fallbackAvailable && (
        <button
          type="button"
          className={`btn voice-fallback-btn ${fallbackListening ? 'recording' : ''}`}
          onClick={onFallbackToggle}
        >
          {fallbackListening ? <MicOff size={14} /> : <Mic size={14} />}
          {fallbackListening ? 'Stop and transcribe' : 'Tap to speak one command'}
        </button>
      )}

      {log.length > 0 && (
        <ul className="voice-log">
          {log.slice(0, 4).map((entry) => {
            const Icon = KIND_ICON[entry.kind] || Ear;
            return (
              <li key={entry.id} className={`voice-log-item ${entry.kind}`}>
                <Icon size={12} />
                <span className="voice-log-time">{timeOf(entry.at)}</span>
                <span className="voice-log-text">{entry.text || '—'}</span>
              </li>
            );
          })}
        </ul>
      )}

      {showHelp && (
        <div className="voice-help">
          <span className="voice-help-title">Try saying</span>
          <ul>
            {VOICE_COMMAND_HELP.map((item) => (
              <li key={item.say}>
                <span className="voice-help-say">{item.say}</span>
                <span className="voice-help-does">{item.does}</span>
              </li>
            ))}
          </ul>
          {supported && (
            <p className="voice-help-note">
              Wake words: “{WAKE_WORD_LABEL}”, “IntentPay” or “Omnitrix”. Nothing runs without one.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
