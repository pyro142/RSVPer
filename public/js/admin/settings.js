/* RSVPer admin — Settings page: one panel per settings section. */
(function () {
  'use strict';

  var R = window.RSVPer;
  var el = R.el;
  var nav = document.getElementById('settingsNav');
  var panels = document.getElementById('settingsPanels');

  var ORDER = [
    'couple',
    'event',
    'venue',
    'rsvp',
    'evening',
    'features',
    'images',
    'copy',
    'privacy',
    'security',
  ];

  function show(id) {
    [].forEach.call(panels.children, function (p) {
      p.hidden = p.dataset.panel !== id;
    });
    [].forEach.call(nav.children, function (a) {
      a.classList.toggle('active', a.dataset.panel === id);
      if (a.dataset.panel === id) {
        a.setAttribute('aria-current', 'page');
        // On phones the menu is one sideways-scrolling row: keep the
        // chosen section in view.
        if (nav.scrollWidth > nav.clientWidth) {
          nav.scrollLeft = a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2;
        }
      } else a.removeAttribute('aria-current');
    });
    try {
      history.replaceState(null, '', '#' + id);
    } catch {
      /* ignore */
    }
  }

  function addNav(id, title) {
    nav.appendChild(navLink(id, title));
  }

  function navLink(id, title) {
    var link = el('a', 'settings-link', title);
    link.href = '#' + id;
    link.dataset.panel = id;
    link.addEventListener('click', function (event) {
      event.preventDefault();
      show(id);
    });
    return link;
  }

  function turnstilePanel() {
    var panel = el('section', 'settings-panel');
    panel.dataset.panel = 'protection';
    R.renderTurnstile(panel);
    return panel;
  }

  function accountPanel() {
    var panel = el('section', 'settings-panel');
    panel.dataset.panel = 'account';
    panel.appendChild(el('h2', 'section-title', 'Admin password'));
    panel.appendChild(
      el(
        'p',
        'section-help',
        'Changing the password here replaces the one you chose when deploying, and signs out every other device.',
      ),
    );
    var form = el('form', 'settings-form');
    form.noValidate = true;
    function field(id, label, autocomplete) {
      var wrap = el('div', 'field');
      var l = el('label', null, label);
      l.htmlFor = id;
      var input = document.createElement('input');
      input.type = 'password';
      input.id = id;
      input.autocomplete = autocomplete;
      wrap.appendChild(l);
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    }
    var current = field('pwCurrent', 'Current password', 'current-password');
    var next = field('pwNew', 'New password (at least 12 characters)', 'new-password');
    var again = field('pwAgain', 'New password again', 'new-password');
    var error = el('p', 'dialog-error');
    error.hidden = true;
    form.appendChild(error);
    var actions = el('div', 'form-actions');
    var save = el('button', 'btn btn-primary', 'Change password');
    save.type = 'submit';
    actions.appendChild(save);
    form.appendChild(actions);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      error.hidden = true;
      if (next.value !== again.value) {
        error.hidden = false;
        error.textContent = 'The new passwords don’t match.';
        return;
      }
      save.disabled = true;
      R.api('/password', { method: 'POST', json: { current: current.value, new: next.value } })
        .then(function () {
          current.value = next.value = again.value = '';
          R.notify('Password changed. Other devices have been signed out.');
        })
        .catch(function (err) {
          error.hidden = false;
          error.textContent = err.message;
        })
        .then(function () {
          save.disabled = false;
        });
    });
    panel.appendChild(form);
    return panel;
  }

  R.ready(function (session) {
    R.api('/settings')
      .then(function (data) {
        var settings = data.settings;
        var pane = R.previewPane({
          settings: function () {
            return settings;
          },
        });
        pane.refreshEveningToggle();
        panels.textContent = '';
        ORDER.forEach(function (section) {
          var spec = R.SETTINGS_SECTIONS[section];
          addNav(section, spec.title);
          var panel = el('section', 'settings-panel');
          panel.dataset.panel = section;
          R.renderSection(panel, section, data.settings[section], {
            onChange: pane.onDraft,
            weddingDate: pane.weddingDate,
            onSaved: function (value) {
              settings[section] = value;
              pane.saved(section);
              R.refreshSession();
            },
          });
          panels.appendChild(panel);
        });
        // Colours come straight after names.
        var colourPanel = el('section', 'settings-panel');
        colourPanel.dataset.panel = 'colours';
        R.renderColours(colourPanel, {
          value: data.settings.theme,
          fontPairs: data.meta.font_pairs,
          onChange: function (colours) {
            pane.send({ theme: colours });
          },
        });
        nav.insertBefore(
          navLink('colours', 'Colours & fonts'),
          nav.querySelector('[data-panel="event"]'),
        );
        panels.insertBefore(colourPanel, panels.querySelector('[data-panel="event"]'));

        // Menu sits after the optional questions it belongs to.
        var menuPanel = el('section', 'settings-panel');
        menuPanel.dataset.panel = 'menu';
        R.renderMenuEditor(menuPanel, {
          onChange: function (menu) {
            pane.send({ menu: menu });
          },
        });
        nav.insertBefore(navLink('menu', 'Menu'), nav.querySelector('[data-panel="images"]'));
        panels.insertBefore(menuPanel, panels.querySelector('[data-panel="images"]'));
        addNav('protection', 'Bot protection');
        panels.appendChild(turnstilePanel());
        if (session.mode === 'password') {
          addNav('account', 'Admin password');
          panels.appendChild(accountPanel());
        }
        var wanted = (location.hash || '').slice(1);
        show(nav.querySelector('[data-panel="' + wanted + '"]') ? wanted : 'couple');
      })
      .catch(function (err) {
        panels.textContent = '';
        panels.appendChild(el('p', 'dialog-error', 'Could not load settings: ' + err.message));
      });
  });
})();
