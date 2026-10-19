import React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

/**
 * Three-state theme control: system → light → dark → system.
 * The icon shows the *preference* (a monitor means "follow the OS"), while the
 * tooltip names the theme that is actually on screen.
 */
export default function ThemeToggle({ preference, resolved, onCycle, className = '' }) {
  const label = preference === 'system'
    ? `System theme (${resolved})`
    : preference === 'light' ? 'Light theme' : 'Dark theme';

  const Icon = preference === 'system' ? Monitor : preference === 'light' ? Sun : Moon;

  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      onClick={onCycle}
      title={`${label} — click to change`}
      aria-label={`${label}. Change theme`}
    >
      <Icon size={15} />
    </button>
  );
}
