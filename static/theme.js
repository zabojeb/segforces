// Applied before first paint so the page never flashes the wrong theme.
(function () {
  var theme = null;
  try { theme = JSON.parse(localStorage.getItem('sf.prefs') || '{}').theme; } catch (e) { /* storage blocked */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
