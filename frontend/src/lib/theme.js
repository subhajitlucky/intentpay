/**
 * Theme preference helpers.
 *
 * Three states, not two: "system" follows the operating system until the user
 * makes an explicit choice, and the choice outlives the session. The cycle order
 * is system → light → dark, which is the order people expect from a theme button.
 */

export const THEME_PREFS = ['system', 'light', 'dark'];

export function resolveTheme(preference, systemPrefersLight) {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemPrefersLight ? 'light' : 'dark';
}

export function nextThemePref(preference) {
  if (preference === 'light') return 'dark';
  if (preference === 'dark') return 'system';
  return 'light';
}

export function isThemePref(value) {
  return THEME_PREFS.includes(value);
}
