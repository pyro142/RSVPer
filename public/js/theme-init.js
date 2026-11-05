/* Sets the admin theme before the page paints.
 *
 * Loaded from <head> WITHOUT defer or async, on purpose. It has to run before
 * the body renders, or the panel flashes light before flipping to dark — which
 * is worse than not having dark mode at all.
 *
 * The usual trick is a small inline <script> in the head. The Content Security
 * Policy here is script-src 'self' with no unsafe-inline and no hashes, so an
 * inline script would simply be blocked. A tiny same-origin file is the version
 * that actually works, and it costs one cached request.
 *
 * Guest pages never load this. Their dark palette means "you're invited to the
 * evening reception" — it's content, not a preference, so it must not follow the
 * operating system.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'rsvper-admin-theme';

  var stored;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can throw outright in private mode or with cookies blocked.
    // A theme preference isn't worth breaking the page over.
    stored = null;
  }

  var theme = stored === 'dark' || stored === 'light' ? stored : null;

  if (!theme) {
    var prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = prefersDark ? 'dark' : 'light';
  }

  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  // Shared with admin.js so the toggle and this file can't disagree about the
  // key or the accepted values.
  window.__adminTheme = {
    key: STORAGE_KEY,
    current: theme,
    /** True while the theme is still whatever the OS asked for. */
    isFollowingSystem: !stored,
  };
})();
