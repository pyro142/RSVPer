/* RSVPer admin — shared helpers for every admin page.
 *
 * Everything rendered in the admin is text a guest or the couple typed, so it
 * all goes into the DOM through textContent. There is no innerHTML anywhere
 * in the admin, deliberately.
 *
 * Exposes window.RSVPer with: el, api, notify, session, inviteLink,
 * copyLinkButton, ready(callback).
 */

(function () {
  'use strict';

  var API = '/api/admin';
  var $ = function (id) {
    return document.getElementById(id);
  };
  var toast = null;
  var toastTimer = null;
  var sessionInfo = null;

  function notify(message, isError) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.hidden = true;
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.hidden = true;
    }, 3600);
  }

  /**
   * Call the admin API. Sends the CSRF token on every state-changing request
   * and redirects to the login page if the session has expired.
   */
  function api(path, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    var headers = Object.assign({}, options.headers || {});
    if (method !== 'GET' && method !== 'HEAD' && sessionInfo && sessionInfo.csrf) {
      headers['X-CSRF-Token'] = sessionInfo.csrf;
    }
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.json);
    }
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: options.body,
      credentials: 'same-origin',
    }).then(function (res) {
      if (res.status === 401 && sessionInfo && sessionInfo.mode === 'password') {
        window.location.href = '/admin/login';
      }
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          if (!res.ok) {
            var err = new Error(body.error || 'Request failed (' + res.status + ')');
            err.status = res.status;
            err.body = body;
            throw err;
          }
          return body;
        });
    });
  }

  function inviteLink(invite) {
    return ((sessionInfo && sessionInfo.origin) || window.location.origin) + '/' + invite.code;
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------
  // js/theme-init.js has already set the attribute before first paint and left
  // its state on window.__adminTheme. This half only handles the toggle.

  function svg(paths, attrs) {
    var node = document.createElementNS(SVG_NS, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('width', '17');
    node.setAttribute('height', '17');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', attrs && attrs.width ? attrs.width : '1.7');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');

    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      node.appendChild(p);
    });

    return node;
  }

  function moonIcon() {
    return svg(['M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8Z']);
  }

  function sunIcon() {
    return svg([
      'M12 17.2a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4Z',
      'M12 1.8v2.4M12 19.8v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M1.8 12h2.4M19.8 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7',
    ]);
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function paintThemeButton(button) {
    var dark = currentTheme() === 'dark';

    // Show where the button takes you, not where you are — a sun on a dark
    // page reads as "switch to light", which is what it does.
    button.textContent = '';
    var label = el('span', 'sr-only', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.appendChild(dark ? sunIcon() : moonIcon());
    button.appendChild(label);

    button.setAttribute('aria-pressed', dark ? 'true' : 'false');
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function setTheme(theme, remember) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');

    if (remember) {
      try {
        window.localStorage.setItem(
          (window.__adminTheme && window.__adminTheme.key) || 'rsvper-admin-theme',
          theme,
        );
      } catch {
        // Private mode. The theme still applies for this visit.
      }
      if (window.__adminTheme) window.__adminTheme.isFollowingSystem = false;
    }
  }

  function initTheme() {
    var button = $('themeToggle');
    if (!button) return;

    paintThemeButton(button);

    button.addEventListener('click', function () {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
      paintThemeButton(button);
    });

    // Follow the OS only until the operator has expressed a preference of their
    // own — after that, their choice wins even if the system flips at sunset.
    if (window.matchMedia) {
      var query = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function (event) {
        if (!window.__adminTheme || !window.__adminTheme.isFollowingSystem) return;
        setTheme(event.matches ? 'dark' : 'light', false);
        paintThemeButton(button);
      };
      if (query.addEventListener) query.addEventListener('change', onChange);
      else if (query.addListener) query.addListener(onChange);
    }
  }

  /** Two overlapping sheets — the conventional copy glyph. */
  function copyIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    var front = document.createElementNS(SVG_NS, 'rect');
    front.setAttribute('x', '5.6');
    front.setAttribute('y', '5.6');
    front.setAttribute('width', '8.9');
    front.setAttribute('height', '8.9');
    front.setAttribute('rx', '1.7');

    var back = document.createElementNS(SVG_NS, 'path');
    back.setAttribute(
      'd',
      'M10.6 5.6V3.2A1.7 1.7 0 0 0 8.9 1.5H3.2A1.7 1.7 0 0 0 1.5 3.2v5.7a1.7 1.7 0 0 0 1.7 1.7h2.4',
    );

    svg.appendChild(back);
    svg.appendChild(front);
    return svg;
  }

  function tickIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M2.5 8.6 6.2 12.3 13.5 4.2');
    svg.appendChild(path);
    return svg;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }

    // The async clipboard API needs a secure context. Deployed over HTTPS and
    // on localhost it's always there, but fall back rather than leave a button
    // that silently does nothing if the panel is ever reached another way.
    return new Promise(function (resolve, reject) {
      var scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', '');
      scratch.style.position = 'fixed';
      scratch.style.top = '-1000px';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();

      var ok;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      document.body.removeChild(scratch);

      if (ok) resolve();
      else reject(new Error('copy-unavailable'));
    });
  }

  /**
   * Button that copies a household's full invite link.
   *
   * Copies the whole URL rather than the bare code — the link is the thing you
   * paste into a message, and a code on its own means the recipient has to be
   * told where to type it.
   */
  function copyLinkButton(invite, className, label) {
    // Two shapes, one behaviour: a bare icon in the table, and a labelled
    // .btn in the View dialog. The distinct classes let each be sized on its
    // own terms while sharing the copied-state styling.
    var button = el('button', className ? className + ' copy-labelled' : 'copy-btn');
    button.type = 'button';
    button.title = 'Copy invite link';
    button.setAttribute('aria-label', 'Copy invite link for ' + invite.household_name);
    button.appendChild(copyIcon());
    if (label) button.appendChild(el('span', null, label));

    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();

      copyText(inviteLink(invite))
        .then(function () {
          // Swap to a tick briefly. The toast says the same thing, but the
          // confirmation belongs at the point of the click when you're working
          // down a list of sixty.
          button.replaceChild(tickIcon(), button.firstChild);
          button.classList.add('copied');
          notify('Link copied — ' + invite.household_name);

          setTimeout(function () {
            if (!button.isConnected) return;
            button.replaceChild(copyIcon(), button.firstChild);
            button.classList.remove('copied');
          }, 1500);
        })
        .catch(function () {
          notify('Could not copy. Select the link and press Ctrl+C.', true);
        });
    });

    return button;
  }

  // ---------------------------------------------------------------------
  // Top bar: couple names, warnings, sign out
  // ---------------------------------------------------------------------

  function renderChrome(info) {
    var names = document.querySelector('[data-couple]');
    if (names) names.textContent = info.couple;

    var signOut = $('signOut');
    if (signOut) {
      if (info.mode === 'access') {
        signOut.href = '/cdn-cgi/access/logout';
      } else {
        signOut.addEventListener('click', function (event) {
          event.preventDefault();
          api('/logout', { method: 'POST', json: {} }).then(
            function () {
              window.location.href = '/admin/login';
            },
            function () {
              window.location.href = '/admin/login';
            },
          );
        });
      }
    }

    var banner = $('warnings');
    if (banner) {
      banner.textContent = '';
      (info.warnings || []).forEach(function (w) {
        banner.appendChild(el('p', 'banner banner-' + w.level, w.message));
      });
      banner.hidden = !(info.warnings || []).length;
    }
  }

  var readyCallbacks = [];

  function ready(callback) {
    if (sessionInfo) callback(sessionInfo);
    else readyCallbacks.push(callback);
  }

  function refreshSession() {
    return api('/session').then(function (info) {
      sessionInfo = info;
      renderChrome(info);
      return info;
    });
  }

  initTheme();
  refreshSession()
    .then(function (info) {
      readyCallbacks.forEach(function (cb) {
        cb(info);
      });
      readyCallbacks = [];
    })
    .catch(function (err) {
      notify('Could not load your session: ' + err.message, true);
    });

  window.RSVPer = {
    el: el,
    api: api,
    notify: notify,
    ready: ready,
    refreshSession: refreshSession,
    inviteLink: inviteLink,
    copyLinkButton: copyLinkButton,
    session: function () {
      return sessionInfo;
    },
  };
})();
