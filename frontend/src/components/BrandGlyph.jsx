import React from 'react';

/**
 * The IntentPay mark: a ledger rule with a struck entry.
 * Kept as inline SVG (rather than an icon-font glyph) so the brand mark, the
 * favicon and the accent colour never drift apart.
 */
export default function BrandGlyph({ size = 18 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="IntentPay"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.9">
        <path d="M8.5 10.5h15" />
        <path d="M8.5 16h10" />
        <path d="M8.5 21.5h15" />
      </g>
      <circle cx="23.5" cy="16" r="2.6" fill="currentColor" />
    </svg>
  );
}
