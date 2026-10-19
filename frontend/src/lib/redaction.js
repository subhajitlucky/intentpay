/**
 * Shared redaction for anything that reaches the screen or local storage.
 *
 * Voice mode made this load-bearing: a spoken approval ("confirm code 1234")
 * arrives as plain text and must never be echoed back into the chat window, the
 * voice console, or localStorage.
 */
export function redactSensitiveContent(content) {
  if (typeof content !== 'string') return content;
  const trimmed = content.trim();

  // Approvals carry the payment secret. Spoken ones arrive as natural language
  // ("confirm code 1234", "approve it with code 1234") and typed ones use the
  // canonical `intentpay confirm code <secret>` phrase, so both are covered here.
  const approval = trimmed.match(/^(intent\s*pay\s+)?(confirm|approve|authorise|authorize|release|yes|proceed)\b/i);
  if (approval && /\s/.test(trimmed)) {
    return `${approval[1] ? 'intentpay ' : ''}${approval[2].toLowerCase()} [REDACTED]`;
  }

  if (/^(?:set|change|reset)\s+(?:payment\s+)?(?:pin|password|secret|secret\s+word)\s+(?:to\s+)?/i.test(trimmed)) {
    return trimmed.replace(
      /^(.*?\b(?:to)\b\s*).+$/i,
      '$1[REDACTED]'
    ).replace(
      /^(.*?\b(?:pin|password|secret|secret\s+word)\b\s*).+$/i,
      '$1[REDACTED]'
    );
  }

  if (/^(?:reset|change)\s+(?:pin|password)\s+(?:to\s+)?/i.test(trimmed)) {
    return trimmed.replace(/^(.*?\b(?:to)\b\s*).+$/i, '$1[REDACTED]');
  }

  if (/(seed phrase|private key)/i.test(trimmed)) {
    return trimmed.replace(/(seed phrase|private key)(\s*[:=]?\s*).+/i, '$1$2[REDACTED]');
  }

  return content;
}

export function sanitizeMessagesForStorage(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: redactSensitiveContent(m.content)
  }));
}
