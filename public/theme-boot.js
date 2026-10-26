/*
 * Day or night, decided before the page draws (no white flash at night):
 * the student's own choice if they made one, otherwise the phone's setting.
 * app.js has the switch; this only reads.
 */
(function () {
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) { /* private mode */ }
  var night = saved ? saved === 'night' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', night ? 'night' : 'day');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', night ? '#0a0d22' : '#f6f7fc');
})();
