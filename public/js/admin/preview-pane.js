/* RSVPer admin — live preview pane (setup wizard and Settings).
 *
 * The real guest card runs in an iframe (/admin/preview, admin-only) against a
 * sample household. This sends it unsaved values as the couple edits, so the
 * card updates instantly. Messages go to the same origin only, and nothing in
 * the preview is ever saved or sent.
 *
 * Usage: var pane = R.previewPane({ settings: function () { return current } });
 *        pane.onDraft(section, values) / pane.send({ menu | theme | evening })
 */
(function () {
  'use strict';

  var R = window.RSVPer;

  function previewPane(opts) {
    opts = opts || {};
    var frame = document.getElementById('previewFrame');
    var eveningBtn = document.getElementById('previewEveningBtn');
    var ready = false;
    var pending = { sections: {} };
    var drafts = {};
    var timer = null;

    function current() {
      return (opts.settings && opts.settings()) || {};
    }

    function flush() {
      if (!ready || !frame || !frame.contentWindow) return;
      pending.type = 'rsvper-preview';
      frame.contentWindow.postMessage(pending, window.location.origin);
      pending = { sections: {} };
    }

    function send(update) {
      if (update.sections) Object.assign(pending.sections, update.sections);
      if (update.menu) pending.menu = update.menu;
      if (update.evening !== undefined) pending.evening = update.evening;
      if (update.theme) pending.theme = update.theme;
      clearTimeout(timer);
      timer = setTimeout(flush, 120);
    }

    // The preview may have loaded (and announced itself) before this pane was
    // created, e.g. on Settings, which waits for data first. Same origin, so
    // check directly as well as listening for its message.
    function checkLoaded() {
      try {
        if (frame && frame.contentWindow && frame.contentWindow.RSVPerCard) {
          ready = true;
          flush();
        }
      } catch {
        /* not ready yet */
      }
    }
    if (frame) frame.addEventListener('load', checkLoaded);
    checkLoaded();

    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin) return;
      if (!frame || event.source !== frame.contentWindow) return;
      if (event.data && event.data.type === 'rsvper-preview-ready') {
        ready = true;
        flush();
      }
    });

    [].forEach.call(document.querySelectorAll('[data-preview-as]'), function (button) {
      button.addEventListener('click', function () {
        [].forEach.call(document.querySelectorAll('[data-preview-as]'), function (b) {
          b.classList.toggle('active', b === button);
          b.setAttribute('aria-pressed', String(b === button));
        });
        send({ evening: button.dataset.previewAs === 'evening' });
      });
    });

    function refreshEveningToggle() {
      if (!eveningBtn) return;
      var ev = drafts.evening || current().evening || {};
      eveningBtn.disabled = !ev.enabled;
      if (eveningBtn.disabled && eveningBtn.classList.contains('active')) {
        document.querySelector('[data-preview-as="day"]').click();
      }
    }

    // Narrower screens: the preview is a panel (a side panel on tablets, a
    // sheet from the bottom on phones) opened with the Preview button. The
    // form behind it keeps everything typed, so you can flip back and forth.
    var toggle = document.getElementById('previewToggle');
    var aside = document.querySelector('.live-preview');
    if (toggle && aside) {
      var backdrop = document.createElement('div');
      backdrop.className = 'preview-backdrop';
      backdrop.hidden = true;
      document.body.appendChild(backdrop);

      // Panel mode = the Preview button is showing (CSS decides by width).
      var panelMode = function () {
        return getComputedStyle(toggle).display !== 'none';
      };
      var isOpen = function () {
        return aside.classList.contains('open');
      };
      var setOpen = function (open, focus) {
        aside.classList.toggle('open', open);
        document.documentElement.classList.toggle('preview-open', open);
        backdrop.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Hide preview' : 'Preview';
        // A closed panel is off-screen: keep keyboards and screen readers out.
        aside.inert = panelMode() && !open;
        if (open && focus !== false) {
          var close = aside.querySelector('[data-preview-close]');
          if (close) close.focus();
        } else if (!open && focus !== false) {
          toggle.focus();
        }
      };

      toggle.addEventListener('click', function () {
        setOpen(!isOpen());
      });
      backdrop.addEventListener('click', function () {
        setOpen(false);
      });
      [].forEach.call(aside.querySelectorAll('[data-preview-close]'), function (button) {
        button.addEventListener('click', function () {
          setOpen(false);
        });
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && isOpen()) setOpen(false);
      });
      // Crossing into the wide layout (preview always visible) closes the panel.
      var sync = function () {
        if (!panelMode() && isOpen()) setOpen(false, false);
        aside.inert = panelMode() && !isOpen();
      };
      window.addEventListener('resize', sync);
      sync();
    }

    return {
      send: send,
      drafts: drafts,
      onDraft: function (section, values) {
        drafts[section] = values;
        var update = {};
        update[section] = values;
        send({ sections: update });
        if (section === 'evening') refreshEveningToggle();
      },
      saved: function (section) {
        delete drafts[section];
      },
      refreshEveningToggle: refreshEveningToggle,
      weddingDate: function () {
        return (
          (drafts.event && drafts.event.date) || (current().event && current().event.date) || null
        );
      },
    };
  }

  R.previewPane = previewPane;
})();
