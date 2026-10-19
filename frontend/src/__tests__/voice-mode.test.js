import { describe, it, expect } from 'vitest'
import {
  VoiceModeEngine,
  VOICE_STATES,
  buildConfirmMessage,
  matchVoiceCommand,
  matchWakeWord,
  normalizeSpokenDigits,
  normalizeTranscript,
  pickPreferredVoice,
  sanitizeForSpeech
} from '../lib/voice-mode'
import { redactSensitiveContent, sanitizeMessagesForStorage } from '../lib/redaction'

describe('normalizeTranscript', () => {
  it('glues the product name back together however it was transcribed', () => {
    expect(normalizeTranscript('Intent Pay')).toBe('intentpay')
    expect(normalizeTranscript('intent-pay')).toBe('intentpay')
    expect(normalizeTranscript('INTENTPAY')).toBe('intentpay')
    expect(normalizeTranscript('omni tricks')).toBe('omnitrix')
  })

  it('keeps handles, ENS names and addresses intact', () => {
    expect(normalizeTranscript('Send 0.01 to @Alice, please!')).toBe('send 0.01 to @alice please')
    expect(normalizeTranscript('pay vitalik.eth 0xABCD')).toBe('pay vitalik.eth 0xabcd')
  })

  it('returns an empty string for non-strings', () => {
    expect(normalizeTranscript(null)).toBe('')
    expect(normalizeTranscript(undefined)).toBe('')
    expect(normalizeTranscript(7)).toBe('')
  })
})

describe('normalizeSpokenDigits', () => {
  it('collapses runs of spoken digits', () => {
    expect(normalizeSpokenDigits('confirm code one two three four')).toBe('confirm code 1234')
    expect(normalizeSpokenDigits('nine zero zero one')).toBe('9001')
    expect(normalizeSpokenDigits('oh five')).toBe('05')
  })

  it('accepts recogniser homophones inside a run', () => {
    expect(normalizeSpokenDigits('one too three for')).toBe('1234')
    expect(normalizeSpokenDigits('niner eight seven')).toBe('987')
  })

  it('leaves a lone ambiguous homophone as a word', () => {
    // "send 0.01 to alice" must not become "send 0.01 2 alice".
    expect(normalizeSpokenDigits('send 0.01 to alice')).toBe('send 0.01 to alice')
    expect(normalizeSpokenDigits('this is for alice')).toBe('this is for alice')
  })

  it('normalises a single unambiguous digit word', () => {
    expect(normalizeSpokenDigits('send one eth to alice')).toBe('send 1 eth to alice')
  })

  it('handles empty input', () => {
    expect(normalizeSpokenDigits('')).toBe('')
    expect(normalizeSpokenDigits(null)).toBe('')
  })
})

describe('matchWakeWord', () => {
  it('extracts the command that follows the wake word', () => {
    const wake = matchWakeWord('Hey IntentPay, what is my balance?')
    expect(wake.wakeWord).toBe('intentpay')
    expect(wake.command).toBe('what is my balance')
  })

  it('accepts the short and homage wake words', () => {
    expect(matchWakeWord('IntentPay send 1 eth to alice').command).toBe('send 1 eth to alice')
    expect(matchWakeWord('Omnitrix, send 1 eth to alice').wakeWord).toBe('omnitrix')
  })

  it('returns an empty command when only the wake word was spoken', () => {
    const wake = matchWakeWord('hey intent pay')
    expect(wake).not.toBeNull()
    expect(wake.command).toBe('')
  })

  it('reports no match for ambient speech', () => {
    expect(matchWakeWord('so anyway I told him about the wallet')).toBeNull()
    expect(matchWakeWord('')).toBeNull()
  })

  it('normalises digits in the extracted command', () => {
    expect(matchWakeWord('intentpay confirm code one two three four').command).toBe('confirm code 1234')
  })
})

describe('matchVoiceCommand', () => {
  it('routes conversational commands to the chat pipeline', () => {
    expect(matchVoiceCommand('what is my balance')).toEqual({
      type: 'message',
      message: 'what is my balance',
      phrase: 'what is my balance'
    })
    expect(matchVoiceCommand('send 0.01 eth to @alice').type).toBe('message')
  })

  it('recognises local playback commands', () => {
    expect(matchVoiceCommand('stop').type).toBe('stop_speaking')
    expect(matchVoiceCommand('be quiet').type).toBe('stop_speaking')
    expect(matchVoiceCommand('repeat that').type).toBe('repeat')
    expect(matchVoiceCommand('say that again').type).toBe('repeat')
    expect(matchVoiceCommand('what can I say').type).toBe('help')
  })

  it('turns a spoken approval into the canonical server phrase', () => {
    const command = matchVoiceCommand('confirm code 1234')
    expect(command.type).toBe('confirm_payment')
    expect(command.secret).toBe('1234')
    expect(command.message).toBe('intentpay confirm code 1234')
    expect(buildConfirmMessage('1234')).toBe(command.message)
  })

  it('accepts wordy approvals, including spoken digits', () => {
    expect(matchVoiceCommand('confirm the payment with my code 8 8 2 1').secret).toBe('8821')
    expect(matchVoiceCommand('approve it with code 4321').secret).toBe('4321')
    expect(matchVoiceCommand('confirm my code is 4321').secret).toBe('4321')
    expect(matchVoiceCommand('please confirm code four three two one').secret).toBe('4321')
  })

  it('never invents an approval without a secret', () => {
    expect(matchVoiceCommand('confirm').type).toBe('message')
    expect(matchVoiceCommand('confirm the payment').type).toBe('message')
  })

  it('recognises cancellation phrases', () => {
    expect(matchVoiceCommand('cancel that').type).toBe('cancel_payment')
    expect(matchVoiceCommand('never mind').type).toBe('cancel_payment')
    expect(matchVoiceCommand('forget it').type).toBe('cancel_payment')
  })

  it('does not treat a sentence containing a keyword as a local command', () => {
    expect(matchVoiceCommand('how do I cancel a payment that is staged').type).toBe('message')
    expect(matchVoiceCommand('what happens if I say stop').type).toBe('message')
  })

  it('returns null for empty input', () => {
    expect(matchVoiceCommand('')).toBeNull()
    expect(matchVoiceCommand(null)).toBeNull()
  })
})

describe('sanitizeForSpeech', () => {
  it('strips markdown and backticks', () => {
    expect(sanitizeForSpeech('Type `intentpay cancel` to stop.')).toBe('Type intentpay cancel to stop.')
    expect(sanitizeForSpeech('**Bold** and *italic*')).toBe('Bold and italic')
  })

  it('shortens long hashes so they are not read out in full', () => {
    const hash = `0x${'a'.repeat(64)}`
    const spoken = sanitizeForSpeech(`Transaction hash: ${hash}`)
    expect(spoken).toContain('0xaaaa...aaaa')
    expect(spoken).not.toContain(hash)
  })

  it('removes emoji that would otherwise be read aloud', () => {
    expect(sanitizeForSpeech('All confirmed on-chain! 🎉')).toBe('All confirmed on-chain!')
  })

  it('caps very long replies at a sentence boundary', () => {
    const long = `${'Sentence about wallets. '.repeat(60)}`
    const spoken = sanitizeForSpeech(long)
    expect(spoken.length).toBeLessThan(long.length)
    expect(spoken.endsWith('The rest is on screen.')).toBe(true)
  })

  it('returns an empty string for non-strings', () => {
    expect(sanitizeForSpeech(null)).toBe('')
    expect(sanitizeForSpeech(undefined)).toBe('')
  })
})

describe('redactSensitiveContent', () => {
  it('redacts spoken approvals', () => {
    expect(redactSensitiveContent('confirm code 1234')).toBe('confirm [REDACTED]')
    expect(redactSensitiveContent('approve it with code 4321')).toBe('approve [REDACTED]')
  })

  it('redacts the canonical typed approval phrase', () => {
    const redacted = redactSensitiveContent('intentpay confirm code 1234')
    expect(redacted).toBe('intentpay confirm [REDACTED]')
    expect(redacted).not.toContain('1234')
  })

  it('leaves ordinary messages alone', () => {
    expect(redactSensitiveContent('what is my balance?')).toBe('what is my balance?')
    expect(redactSensitiveContent('confirmations are useful')).toBe('confirmations are useful')
  })

  it('keeps secrets out of the stored chat history', () => {
    const stored = sanitizeMessagesForStorage([
      { role: 'user', content: 'intentpay confirm code 1234' },
      { role: 'user', content: 'set payment pin to hunter2' }
    ])
    expect(JSON.stringify(stored)).not.toContain('1234')
    expect(JSON.stringify(stored)).not.toContain('hunter2')
  })
})

describe('pickPreferredVoice', () => {
  it('prefers a natural English voice and falls back safely', () => {
    const voices = [
      { name: 'Google Deutsch', lang: 'de-DE' },
      { name: 'Google US English', lang: 'en-US' },
      { name: 'Some Other', lang: 'en-GB' }
    ]
    expect(pickPreferredVoice(voices).name).toBe('Google US English')
    expect(pickPreferredVoice([])).toBeNull()
    expect(pickPreferredVoice(null)).toBeNull()
    expect(pickPreferredVoice([{ name: 'Only', lang: 'fr-FR' }]).name).toBe('Only')
  })
})

describe('VoiceModeEngine support probing', () => {
  it('exposes idle state and a stable state vocabulary', () => {
    const engine = new VoiceModeEngine()
    expect(engine.state).toBe(VOICE_STATES.OFF)
    expect(engine.running).toBe(false)
    expect(Object.values(VOICE_STATES)).toContain('capturing')
  })

  it('reports whether the browser can listen', () => {
    // jsdom has no Web Speech API, so this must be a clean false rather than a throw.
    expect(VoiceModeEngine.isSupported()).toBe(false)
  })

  it('refuses to start without recognition support', async () => {
    const engine = new VoiceModeEngine()
    await expect(engine.start()).rejects.toThrow(/Web Speech API/)
  })

  it('dispatches a recognised command through the callback', () => {
    const received = []
    const engine = new VoiceModeEngine({ onCommand: (command) => received.push(command) })
    engine.dispatch('confirm code 1234')
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('confirm_payment')
    expect(received[0].message).toBe('intentpay confirm code 1234')
  })

  it('ignores an empty dispatch', () => {
    const received = []
    const engine = new VoiceModeEngine({ onCommand: (command) => received.push(command) })
    engine.dispatch('   ')
    expect(received).toHaveLength(0)
  })
})
