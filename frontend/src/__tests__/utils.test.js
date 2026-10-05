import { describe, it, expect } from 'vitest'
import { sanitizeVoiceTranscript } from '../lib/intent-voice'
import { API_BASE } from '../config/api'

describe('sanitizeVoiceTranscript', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeVoiceTranscript('  send 2 eth to alice  ')).toBe('send 2 eth to alice')
  })

  it('returns empty string for non-strings', () => {
    expect(sanitizeVoiceTranscript(null)).toBe('')
    expect(sanitizeVoiceTranscript(undefined)).toBe('')
    expect(sanitizeVoiceTranscript(42)).toBe('')
    expect(sanitizeVoiceTranscript({})).toBe('')
  })
})

describe('API_BASE', () => {
  it('defaults to localhost and has no trailing slash', () => {
    expect(API_BASE.length).toBeGreaterThan(0)
    expect(API_BASE.endsWith('/')).toBe(false)
  })
})
