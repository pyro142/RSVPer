/* RSVPer — live preview bridge.
 *
 * Loaded only on /admin/preview (the admin-only preview of the guest card).
 * The setup wizard posts unsaved settings here; this applies them to the
 * card instantly, using the same formatting the server uses, then asks
 * rsvp.js to rebuild the reply form against a sample household.
 *
 * Only messages from this same origin and from the embedding admin page are
 * accepted, and every value is written with textContent / validated URLs.
 */
(function () {
  'use strict';

  var card = window.RSVPerCard;
  if (!card) return;

  var base = card.config();
  var settings = JSON.parse(JSON.stringify((base.preview && base.preview.settings) || {}));
  var menu = (base.preview && base.preview.menu) || [];

  function slot(name) {
    return document.querySelector('[data-slot="' + name + '"]');
  }

  function setText(name, value) {
    var node = slot(name);
    if (node) node.textContent = value || '';
  }

  function show(name, visible) {
    var node = slot(name);
    if (node) node.hidden = !visible;
  }

  function safeUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    if (value.charAt(0) === '/' && value.charAt(1) !== '/') return value;
    try {
      var url = new URL(value);
      return url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function locale() {
    return (settings.event && settings.event.locale) || 'en-GB';
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(locale(), {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(iso + 'T12:00:00Z'));
    } catch {
      return iso;
    }
  }

  function formatTime(hhmm) {
    if (!hhmm) return '';
    var parts = hhmm.split(':').map(Number);
    try {
      return new Intl.DateTimeFormat(locale(), {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(2000, 0, 1, parts[0], parts[1])));
    } catch {
      return hhmm;
    }
  }

  function fill(template, values) {
    return String(template || '').replace(/\{([a-z_]+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
    });
  }

  function imageUrl(ref) {
    if (!ref) return null;
    if (ref.kind === 'builtin') return '/img/' + ref.name + '.svg';
    if (ref.kind === 'url') return safeUrl(ref.url);
    if (ref.kind === 'upload') return '/media/' + encodeURIComponent(ref.id);
    return null;
  }

  function render() {
    var s = settings;
    var c = s.couple || {};
    var e = s.event || {};
    var v = s.venue || {};
    var copy = s.copy || {};
    var ev = s.evening || {};
    var img = s.images || {};

    var date = formatDate(e.date);
    var dayTime = formatTime(e.ceremony_time);

    document.documentElement.lang = locale();
    setText(
      'title',
      (c.name_one || '') + ' ' + (c.joiner || '&') + ' ' + (c.name_two || '') + ': RSVP',
    );
    setText('name-one', c.name_one);
    setText('joiner', c.joiner || '&');
    setText('name-two', c.name_two);
    setText('headline', copy.headline);

    show('date-line', !!date);
    setText('date', date);
    setText('time', dayTime ? '· ' + dayTime : '');

    show('venue-line', !!(v.name || v.address));
    setText('venue-name', v.name);
    setText('venue-address', v.address ? '· ' + v.address : '');
    var link = slot('venue-link');
    var map = safeUrl(v.map_url);
    if (link) {
      if (map) link.setAttribute('href', map);
      else link.removeAttribute('href');
    }

    var hero = imageUrl(img.hero);
    show('hero-frame', !!hero);
    var heroImg = slot('hero');
    if (heroImg && hero) heroImg.src = hero;
    if (heroImg) heroImg.alt = img.hero_alt || '';
    show('decoration', img.decoration !== 'none');

    setText('code-prompt', copy.code_prompt);
    setText('code-help', copy.code_help);
    setText('intro', fill(copy.intro, { date: date || 'our big day' }));
    setText('accept-label', copy.accept_label);
    setText('decline-label', copy.decline_label);
    setText('decline-note', copy.decline_note);
    setText('day-label', ev.day_label);
    setText('evening-label', ev.evening_label);
    setText(
      'evening-note',
      fill(ev.evening_note, { reception_time: formatTime(e.reception_time) }),
    );
    setText('contact', s.rsvp && s.rsvp.contact);

    // Hand rsvp.js the derived config it uses for themes and messages.
    var next = Object.assign({}, card.config(), {
      times: { day: dayTime, evening: formatTime(e.reception_time) },
      hero: { day: imageUrl(img.hero), evening: imageUrl(img.hero_evening) },
      copy: Object.assign({}, card.config().copy, copy),
      preview: { settings: settings, menu: menu },
    });
    // Rebuild the reply form only when what it asks has changed.
    var shape = JSON.stringify([s.features, ev.enabled, ev.day_label, ev.evening_label, menu]);
    card.refresh(next, { rebuild: shape !== lastShape });
    lastShape = shape;
  }

  var lastShape = null;

  /**
   * Unsaved colours: ask the server for the derived CSS (it does the colour
   * maths) and swap it in. Only the latest request wins.
   */
  var themeRequest = 0;
  function applyTheme(theme) {
    var hex = /^#[0-9a-fA-F]{6}$/;
    var params = new URLSearchParams();
    if (hex.test(theme.background || '')) params.set('background', theme.background);
    if (hex.test(theme.brand || '')) params.set('brand', theme.brand);
    if (/^[a-z]{1,20}$/.test(theme.font || '')) params.set('font', theme.font);
    var id = ++themeRequest;
    // v= gives a fresh address, skipping any copy cached by an older version.
    params.set('v', '2');
    fetch('/admin/theme.css?' + params.toString(), {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(function (res) {
        return res.ok ? res.text() : '';
      })
      .then(function (css) {
        if (id !== themeRequest) return;
        var style = document.getElementById('rsvper-theme');
        if (!style) {
          style = document.createElement('style');
          style.id = 'rsvper-theme';
          document.head.appendChild(style);
        }
        style.textContent = css;
      })
      .catch(function () {
        /* preview only */
      });
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'rsvper-preview') return;

    if (data.sections && typeof data.sections === 'object') {
      Object.keys(data.sections).forEach(function (key) {
        var value = data.sections[key];
        if (value && typeof value === 'object') {
          settings[key] = Object.assign({}, settings[key] || {}, value);
        }
      });
    }
    if (Array.isArray(data.menu)) menu = data.menu;
    if (data.theme && typeof data.theme === 'object') applyTheme(data.theme);
    if (data.evening !== undefined) card.refresh(null, { evening: !!data.evening });
    render();
  });

  // Tell the admin page we're ready for updates.
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'rsvper-preview-ready' }, window.location.origin);
  }
})();
