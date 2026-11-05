/* RSVPer admin — Cloudflare Turnstile (bot protection) keys.
 *
 * Keys saved here are stored in your database. If the TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY secrets are set on the Worker, those win and this form
 * is read-only. The secret key is never sent back to the browser.
 */
(function () {
  'use strict';

  var R = window.RSVPer;
  var el = R.el;

  function field(id, label, hint, type) {
    var wrap = el('div', 'field');
    var l = el('label', null, label);
    l.htmlFor = id;
    var input = document.createElement('input');
    input.type = type || 'text';
    input.id = id;
    input.autocomplete = 'off';
    input.spellcheck = false;
    wrap.appendChild(l);
    wrap.appendChild(input);
    if (hint) wrap.appendChild(el('p', 'field-hint', hint));
    return { wrap: wrap, input: input };
  }

  function steps() {
    var ol = el('ol', 'how-to');
    [
      'Open the Cloudflare dashboard and go to Turnstile (in the left menu, or search “Turnstile”).',
      'Choose “Add widget”. Give it any name, and add the hostname guests use (for example rsvp.example.com, or your-worker.your-name.workers.dev).',
      'Leave the widget mode as “Managed” and create it.',
      'Copy the Site Key and the Secret Key into the boxes below, then save.',
    ].forEach(function (t) {
      ol.appendChild(el('li', null, t));
    });
    var link = el('a', null, 'Open Turnstile in the Cloudflare dashboard');
    link.href = 'https://dash.cloudflare.com/?to=/:account/turnstile';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    var box = el('div');
    box.appendChild(ol);
    box.appendChild(link);
    return box;
  }

  /**
   * Render the form. opts.onSaved(status) is called after a save or removal.
   */
  function renderTurnstile(container, opts) {
    opts = opts || {};
    var root = el('div', 'settings-form');
    if (!opts.hideTitle) root.appendChild(el('h2', 'section-title', 'Bot protection'));
    root.appendChild(
      el(
        'p',
        'section-help',
        'Cloudflare Turnstile checks that replies come from people, usually without them noticing. It is free. Without it, RSVPer still rate limits replies and code guesses, but Turnstile is recommended.',
      ),
    );
    var status = el('p', 'banner');
    root.appendChild(status);

    var body = el('div');
    root.appendChild(body);
    container.appendChild(root);

    function render(state) {
      body.textContent = '';
      if (state.source === 'deploy') {
        status.className = 'banner banner-info';
        status.textContent =
          'Turnstile is on, using keys set as secrets on your Worker. Change them in the Cloudflare dashboard (Worker → Settings → Variables and secrets).';
        return;
      }
      status.className = state.source ? 'banner banner-info' : 'banner';
      status.textContent = state.source ? 'Turnstile is on.' : 'Turnstile is off.';

      body.appendChild(steps());
      var site = field('tsSite', 'Site key', null);
      var secret = field(
        'tsSecret',
        'Secret key',
        state.secret_set
          ? 'A secret key is saved. Leave this blank to keep it.'
          : 'Kept private: it is never shown again after saving.',
        'password',
      );
      site.input.value = state.site_key || '';
      body.appendChild(site.wrap);
      body.appendChild(secret.wrap);

      var error = el('p', 'dialog-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      body.appendChild(error);

      var actions = el('div', 'form-actions');
      var save = el('button', 'btn btn-primary', 'Save keys');
      save.type = 'button';
      actions.appendChild(save);
      if (state.source === 'settings') {
        var remove = el('button', 'btn btn-ghost', 'Turn off Turnstile');
        remove.type = 'button';
        remove.addEventListener('click', function () {
          R.api('/turnstile', { method: 'DELETE' }).then(function (s) {
            R.notify('Turnstile turned off');
            render(s);
            if (opts.onSaved) opts.onSaved(s);
          });
        });
        actions.appendChild(remove);
      }
      if (opts.extraButton) actions.appendChild(opts.extraButton);
      body.appendChild(actions);

      save.addEventListener('click', function () {
        error.hidden = true;
        save.disabled = true;
        R.api('/turnstile', {
          method: 'PUT',
          json: { site_key: site.input.value.trim(), secret_key: secret.input.value.trim() },
        })
          .then(function (s) {
            R.notify('Turnstile is on');
            render(s);
            R.refreshSession();
            if (opts.onSaved) opts.onSaved(s);
          })
          .catch(function (err) {
            error.hidden = false;
            error.textContent = err.message;
          })
          .then(function () {
            save.disabled = false;
          });
      });
    }

    R.api('/turnstile').then(render, function (err) {
      status.textContent = 'Could not load: ' + err.message;
    });
    return root;
  }

  R.renderTurnstile = renderTurnstile;
})();
