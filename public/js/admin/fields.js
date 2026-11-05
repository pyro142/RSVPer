/* RSVPer admin — settings forms.
 *
 * Describes every settings section as a list of fields, and renders a form
 * for one section. Used by both the first-run setup wizard and the Settings
 * page, so the two can never disagree about what a setting means.
 *
 * Validation happens on the server; this only shapes the input.
 */

(function () {
  'use strict';

  var R = window.RSVPer;
  var el = R.el;

  var TIMEZONES;
  try {
    TIMEZONES = Intl.supportedValuesOf('timeZone');
  } catch {
    TIMEZONES = [
      'UTC',
      'Europe/London',
      'America/New_York',
      'America/Los_Angeles',
      'Australia/Sydney',
    ];
  }
  var guessedZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  var guessedLocale = navigator.language || 'en-GB';

  /**
   * Field types: text, textarea, date, time, url, toggle, select, number,
   * lines (array of strings, one per line), image.
   */
  var SECTIONS = {
    couple: {
      title: 'Your names',
      help: 'Shown at the top of the invitation.',
      fields: [
        { key: 'name_one', label: 'First name', type: 'text', max: 40, required: true },
        { key: 'name_two', label: 'Second name', type: 'text', max: 40, required: true },
        { key: 'joiner', label: 'Between the names', type: 'text', max: 8, hint: 'Usually “&”.' },
      ],
    },
    event: {
      title: 'Date and time',
      fields: [
        { key: 'date', label: 'Wedding date', type: 'date', required: true },
        { key: 'ceremony_time', label: 'Start time (ceremony)', type: 'time' },
        {
          key: 'reception_time',
          label: 'Evening reception time',
          type: 'time',
          hint: 'Shown to evening guests, if you use evening invites.',
        },
        {
          key: 'timezone',
          label: 'Time zone',
          type: 'select',
          options: TIMEZONES,
          hint: 'Used for the RSVP deadline.',
          suggest: guessedZone,
        },
        {
          key: 'locale',
          label: 'Date format',
          type: 'select',
          options: [
            'en-GB',
            'en-US',
            'en-AU',
            'en-IE',
            'en-CA',
            'en-NZ',
            'fr-FR',
            'de-DE',
            'es-ES',
            'it-IT',
            'nl-NL',
          ],
          hint: 'How dates and times are written, e.g. en-GB “12 June 2027, 13:00”.',
          suggest: guessedLocale,
        },
      ],
    },
    venue: {
      title: 'Venue',
      fields: [
        { key: 'name', label: 'Venue name', type: 'text', max: 100 },
        { key: 'address', label: 'Town or short address', type: 'text', max: 200 },
        {
          key: 'map_url',
          label: 'Map link',
          type: 'url',
          placeholder: 'https://maps.app.goo.gl/…',
          hint: 'Optional. Guests can tap the venue name to open it in their maps app.',
          mapHelp: true,
        },
      ],
    },
    rsvp: {
      title: 'Replies',
      fields: [
        {
          key: 'deadline',
          label: 'RSVP deadline',
          type: 'date',
          hint: 'Optional. Replies are refused after this day ends. Must be on or before the wedding date.',
        },
        {
          key: 'contact',
          label: 'Contact line',
          type: 'text',
          max: 200,
          hint: 'Shown to guests who need to change their reply, e.g. “Message us on 07123 456789”.',
        },
      ],
    },
    evening: {
      title: 'Evening guests',
      help: 'Invite some households to the evening reception only. Their card shows the evening time in night-time colours, and day guests can choose “evening only”.',
      fields: [
        { key: 'enabled', label: 'Use evening invites', type: 'toggle' },
        { key: 'day_label', label: '“Whole day” button', type: 'text', max: 40 },
        { key: 'evening_label', label: '“Evening only” button', type: 'text', max: 40 },
        {
          key: 'evening_note',
          label: 'Evening note',
          type: 'text',
          max: 200,
          hint: '{reception_time} is replaced with the reception time.',
        },
      ],
    },
    features: {
      title: 'Optional questions',
      help: 'Each one stays completely hidden from guests when it is off.',
      fields: [
        {
          key: 'meals',
          label: 'Meal choices (per guest)',
          type: 'toggle',
          hint: 'Each attending guest, including plus ones, picks from your menu. Set the menu below or in Settings → Menu.',
        },
        { key: 'dietary', label: 'Dietary needs (per guest)', type: 'toggle' },
        { key: 'song_request', label: 'Song request (per household)', type: 'toggle' },
        { key: 'message', label: 'Message to the couple (per household)', type: 'toggle' },
      ],
    },
    images: {
      title: 'Images',
      help: 'Use the built-in artwork, link to an image you host elsewhere, or upload a small photo (PNG, JPEG or WebP, up to 1 MB).',
      fields: [
        { key: 'hero', label: 'Main picture', type: 'image', builtin: 'arch' },
        { key: 'hero_evening', label: 'Evening picture', type: 'image', builtin: 'arch-evening' },
        {
          key: 'hero_alt',
          label: 'Picture description',
          type: 'text',
          max: 150,
          hint: 'For screen readers, e.g. “The garden at our venue”.',
        },
        {
          key: 'decoration',
          label: 'Flower border',
          type: 'select',
          options: ['botanical', 'none'],
        },
      ],
    },
    copy: {
      title: 'Wording',
      help: 'Every sentence guests see. Leave a box empty to use the default.',
      fields: [
        { key: 'headline', label: 'Under your names', type: 'text' },
        { key: 'code_prompt', label: 'Code screen heading', type: 'text' },
        { key: 'code_help', label: 'Code screen help', type: 'text' },
        {
          key: 'intro',
          label: 'Reply screen intro',
          type: 'textarea',
          hint: '{date} is replaced with your wedding date.',
        },
        { key: 'accept_label', label: 'Accept button', type: 'text' },
        { key: 'decline_label', label: 'Decline button', type: 'text' },
        { key: 'decline_note', label: 'Shown after choosing decline', type: 'text' },
        { key: 'accepted_title', label: 'Thank-you heading (accepted)', type: 'text' },
        { key: 'accepted_message', label: 'Thank-you message (accepted)', type: 'textarea' },
        { key: 'declined_title', label: 'Thank-you heading (declined)', type: 'text' },
        { key: 'declined_message', label: 'Thank-you message (declined)', type: 'textarea' },
        { key: 'already_title', label: 'Already replied heading', type: 'text' },
        { key: 'already_message', label: 'Already replied message', type: 'textarea' },
        { key: 'closed_message', label: 'After the deadline', type: 'textarea' },
      ],
    },
    privacy: {
      title: 'Privacy',
      fields: [
        {
          key: 'hide_from_search',
          label: 'Hide from search engines',
          type: 'toggle',
          hint: 'Recommended. Asks Google and others not to index your invitation.',
        },
        {
          key: 'embed_origins',
          label: 'Allow embedding on these sites',
          type: 'lines',
          hint: 'Only if you show the RSVP form inside your own wedding website. One https:// address per line, up to 5.',
        },
      ],
    },
    security: {
      title: 'Advanced: security',
      help: 'Sensible defaults are already set. Only change these if you know why.',
      fields: [
        {
          key: 'code_length',
          label: 'Length of new invite codes',
          type: 'select',
          options: [6, 5],
          hint: '6 is about 30× harder to guess. Existing codes are unaffected.',
        },
        {
          key: 'lookup_failures_per_hour',
          label: 'Wrong codes allowed per hour, per visitor',
          type: 'number',
          min: 3,
          max: 60,
        },
        {
          key: 'lookup_failures_per_day',
          label: 'Wrong codes per day before a 24-hour lockout',
          type: 'number',
          min: 5,
          max: 500,
        },
        {
          key: 'breaker_failures_per_hour',
          label: 'Site-wide wrong codes per hour before extra protection',
          type: 'number',
          min: 20,
          max: 5000,
        },
        {
          key: 'submits_per_hour',
          label: 'Replies allowed per hour, per visitor',
          type: 'number',
          min: 2,
          max: 60,
        },
      ],
    },
  };

  var uid = 0;
  function nextId(prefix) {
    uid += 1;
    return prefix + '-' + uid;
  }

  function fieldShell(field, id) {
    var wrap = el('div', 'field');
    var label = el('label', null, field.label + (field.required ? ' *' : ''));
    label.htmlFor = id;
    wrap.appendChild(label);
    return wrap;
  }

  function hint(wrap, field) {
    if (field.hint) wrap.appendChild(el('p', 'field-hint', field.hint));
  }

  function renderField(field, value) {
    var id = nextId('f-' + field.key);
    var wrap;
    var input;
    var get;

    if (field.type === 'toggle') {
      wrap = el('label', 'switch-row');
      wrap.htmlFor = id;
      input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.checked = !!value;
      wrap.appendChild(input);
      var text = el('span', 'switch-text');
      text.appendChild(el('span', 'switch-title', field.label));
      if (field.hint) text.appendChild(el('span', 'switch-hint', field.hint));
      wrap.appendChild(text);
      get = function () {
        return input.checked;
      };
      return { node: wrap, get: get, key: field.key };
    }

    if (field.type === 'image') return renderImageField(field, value);

    wrap = fieldShell(field, id);

    if (field.type === 'select') {
      input = document.createElement('select');
      input.className = 'select';
      var current = value === undefined || value === null || value === '' ? field.suggest : value;
      var options = field.options.slice();
      // Always offer the saved value, even if this browser's list lacks it
      // (e.g. Chromium's time-zone list has no plain "UTC").
      if (current !== undefined && options.map(String).indexOf(String(current)) === -1) {
        options.unshift(current);
      }
      options.forEach(function (opt) {
        var o = el('option', null, String(opt));
        o.value = String(opt);
        input.appendChild(o);
      });
      if (current !== undefined) input.value = String(current);
      get = function () {
        var v = input.value;
        return typeof field.options[0] === 'number' ? Number(v) : v;
      };
    } else if (field.type === 'textarea' || field.type === 'lines') {
      input = document.createElement('textarea');
      input.rows = field.type === 'lines' ? 3 : 2;
      input.value = field.type === 'lines' ? (value || []).join('\n') : value || '';
      get =
        field.type === 'lines'
          ? function () {
              return input.value
                .split('\n')
                .map(function (s) {
                  return s.trim();
                })
                .filter(Boolean);
            }
          : function () {
              return input.value;
            };
    } else {
      input = document.createElement('input');
      input.type =
        { date: 'date', time: 'time', url: 'url', number: 'number' }[field.type] || 'text';
      if (field.max) input.maxLength = field.max;
      if (field.min !== undefined) input.min = field.min;
      if (field.type === 'number' && field.max) input.max = field.max;
      input.value = value === null || value === undefined ? '' : String(value);
      if (field.type === 'url') input.placeholder = field.placeholder || 'https://';
      get = function () {
        if (field.type === 'number') return Number(input.value);
        if (field.type === 'date' || field.type === 'time' || field.type === 'url') {
          return input.value || null;
        }
        return input.value;
      };
    }

    input.id = id;
    input.name = field.key;
    wrap.appendChild(input);
    hint(wrap, field);
    return { node: wrap, get: get, key: field.key };
  }

  /** Image: default artwork, a link, an upload, or none. */
  function renderImageField(field, value) {
    var wrap = el('fieldset', 'field image-field');
    wrap.appendChild(el('legend', null, field.label));

    var kind = value ? value.kind : 'none';
    var current = value ? Object.assign({}, value) : null;
    var name = nextId('img-' + field.key);

    var preview = document.createElement('img');
    preview.className = 'image-preview';
    preview.alt = '';

    var urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.placeholder = 'https://…';
    urlInput.setAttribute('aria-label', field.label + ' link');
    urlInput.value = kind === 'url' ? value.url : '';

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp';
    fileInput.setAttribute('aria-label', field.label + ' upload');

    var status = el('p', 'field-hint');

    function refresh() {
      urlInput.hidden = kind !== 'url';
      fileInput.hidden = kind !== 'upload';
      var src = null;
      if (kind === 'builtin') src = '/img/' + field.builtin + '.svg';
      if (kind === 'url' && urlInput.value) src = urlInput.value;
      if (kind === 'upload' && current && current.kind === 'upload') src = '/media/' + current.id;
      preview.hidden = !src;
      if (src) preview.src = src;
    }

    var options = el('div', 'radio-row');
    [
      ['builtin', 'Built-in art'],
      ['url', 'Link'],
      ['upload', 'Upload'],
      ['none', 'None'],
    ].forEach(function (pair) {
      var id = nextId(name);
      var label = el('label', 'radio-option');
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;
      radio.id = id;
      radio.checked = kind === pair[0];
      radio.addEventListener('change', function () {
        kind = pair[0];
        refresh();
      });
      label.appendChild(radio);
      label.appendChild(el('span', null, pair[1]));
      options.appendChild(label);
    });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) {
        status.textContent = 'That image is over 1 MB. Please resize it first.';
        return;
      }
      status.textContent = 'Uploading…';
      R.api('/images', { method: 'POST', body: file, headers: { 'Content-Type': file.type } })
        .then(function (result) {
          current = { kind: 'upload', id: result.id };
          status.textContent = 'Uploaded. Remember to save.';
          wrap.dispatchEvent(new Event('change', { bubbles: true }));
          refresh();
        })
        .catch(function (err) {
          status.textContent = err.message;
        });
    });
    urlInput.addEventListener('input', refresh);

    wrap.appendChild(options);
    wrap.appendChild(urlInput);
    wrap.appendChild(fileInput);
    wrap.appendChild(status);
    wrap.appendChild(preview);
    if (field.hint) wrap.appendChild(el('p', 'field-hint', field.hint));
    refresh();

    return {
      node: wrap,
      key: field.key,
      get: function () {
        if (kind === 'builtin') return { kind: 'builtin', name: field.builtin };
        if (kind === 'url') return { kind: 'url', url: urlInput.value.trim() };
        if (kind === 'upload') return current && current.kind === 'upload' ? current : null;
        return null;
      },
    };
  }

  /**
   * Render a section form into `container`. Calls PUT /settings/:section on
   * submit. Resolves `onSaved(value)` after a successful save.
   */
  function renderSection(container, section, value, opts) {
    opts = opts || {};
    var spec = SECTIONS[section];
    var form = el('form', 'settings-form');
    form.noValidate = true;
    form.dataset.section = section;

    if (!opts.hideTitle) form.appendChild(el('h2', 'section-title', spec.title));
    if (spec.help) form.appendChild(el('p', 'section-help', spec.help));

    var controls = spec.fields.map(function (field) {
      var control = renderField(field, value ? value[field.key] : undefined);
      form.appendChild(control.node);
      return control;
    });

    function payload() {
      var out = {};
      controls.forEach(function (c) {
        out[c.key] = c.get();
      });
      return out;
    }
    function control(key) {
      return controls.filter(function (c) {
        return c.key === key;
      })[0];
    }

    // Live updates for the setup wizard's preview.
    if (opts.onChange) {
      var notify = function () {
        opts.onChange(section, payload());
      };
      form.addEventListener('input', notify);
      form.addEventListener('change', notify);
    }

    spec.fields.forEach(function (field) {
      if (field.mapHelp) mapHelp(control(field.key), control('name'), control('address'));
    });

    if (section === 'rsvp' && opts.weddingDate) {
      deadlineCheck(control('deadline'), opts.weddingDate);
    }

    var error = el('p', 'dialog-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.appendChild(error);

    var actions = el('div', 'form-actions');
    var saveButton = el('button', 'btn btn-primary', opts.saveLabel || 'Save');
    saveButton.type = 'submit';
    actions.appendChild(saveButton);
    if (opts.extraButton) actions.appendChild(opts.extraButton);
    form.appendChild(actions);

    /** Save this section. Resolves true on success, false on a shown error. */
    function save() {
      error.hidden = true;
      var payload = {};
      controls.forEach(function (c) {
        payload[c.key] = c.get();
      });
      saveButton.disabled = true;
      return R.api('/settings/' + section, { method: 'PUT', json: payload })
        .then(function (result) {
          if (!opts.quiet) R.notify('Saved');
          if (opts.onSaved) opts.onSaved(result.value);
          return true;
        })
        .catch(function (err) {
          error.hidden = false;
          var label = '';
          if (err.body && err.body.field) {
            var f = spec.fields.filter(function (x) {
              return x.key === err.body.field;
            })[0];
            if (f) label = f.label + ': ';
          }
          error.textContent = label + err.message;
          return false;
        })
        .then(function (ok) {
          saveButton.disabled = false;
          return ok;
        });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      save();
    });
    form.rsvperSave = save;

    container.appendChild(form);
    return form;
  }

  /**
   * How to get a map link, with an example and a button that builds a
   * Google Maps search link from the venue name and address.
   */
  function mapHelp(mapControl, nameControl, addressControl) {
    if (!mapControl) return;
    var input = mapControl.node.querySelector('input');
    var box = el('details', 'map-help');
    box.appendChild(el('summary', null, 'How do I get a map link?'));
    var steps = el('ol', 'how-to');
    [
      'Open Google Maps (or Apple Maps) and search for your venue.',
      'Choose Share, then Copy link.',
      'Paste it here. A Google Maps share link looks like https://maps.app.goo.gl/… ; a full link looks like https://www.google.com/maps/place/Windsor+Castle/…',
    ].forEach(function (t) {
      steps.appendChild(el('li', null, t));
    });
    box.appendChild(steps);
    box.appendChild(
      el(
        'p',
        'field-hint',
        'No link to hand? Use the button below to make one from your venue name, e.g. “Windsor Castle, Windsor” becomes a Google Maps search for it.',
      ),
    );
    var actions = el('div', 'map-help-actions');
    var make = el('button', 'btn btn-ghost btn-small', 'Make a link from the venue name');
    make.type = 'button';
    var test = el('a', 'btn btn-ghost btn-small', 'Test the link');
    test.target = '_blank';
    test.rel = 'noopener noreferrer';
    function refreshTest() {
      var ok = /^https:\/\//.test(input.value);
      test.hidden = !ok;
      if (ok) test.href = input.value;
    }
    make.addEventListener('click', function () {
      var query = [nameControl && nameControl.get(), addressControl && addressControl.get()]
        .filter(Boolean)
        .join(', ')
        .trim();
      if (!query) {
        R.notify('Type the venue name first.', true);
        return;
      }
      input.value = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      refreshTest();
    });
    input.addEventListener('input', refreshTest);
    actions.appendChild(make);
    actions.appendChild(test);
    box.appendChild(actions);
    mapControl.node.appendChild(box);
    refreshTest();
  }

  /** Warn straight away if the RSVP deadline is after the wedding date. */
  function deadlineCheck(deadlineControl, weddingDate) {
    if (!deadlineControl) return;
    var input = deadlineControl.node.querySelector('input');
    var warning = el('p', 'field-warning');
    warning.setAttribute('role', 'alert');
    warning.hidden = true;
    deadlineControl.node.appendChild(warning);
    function check() {
      var wedding = typeof weddingDate === 'function' ? weddingDate() : weddingDate;
      var late = input.value && wedding && input.value > wedding;
      warning.hidden = !late;
      warning.textContent = late
        ? 'This is after your wedding date (' + wedding + '). Pick a date on or before the wedding.'
        : '';
      if (wedding) input.max = wedding;
    }
    input.addEventListener('input', check);
    input.addEventListener('change', check);
    check();
  }

  R.SETTINGS_SECTIONS = SECTIONS;
  R.renderSection = renderSection;
})();
