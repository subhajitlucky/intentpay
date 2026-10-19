/**
 * Resolve the theme before first paint so there is no flash of the wrong one.
 *
 * This lives in its own file rather than inline in index.html because the API
 * serves the client with a Content-Security-Policy of `script-src 'self'`, which
 * blocks inline scripts. Keep it dependency-free and synchronous.
 */
(function () {
  try {
    var saved = localStorage.getItem('intentpay-theme');
    var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = saved === 'light' || saved === 'dark'
      ? saved
      : (prefersLight ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
  } catch {
    document.documentElement.dataset.theme = 'dark';
  }
})();
