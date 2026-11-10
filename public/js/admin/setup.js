/* RSVPer admin — first-run setup wizard.
 *
 * Walks through the essential settings, offers a guest import, then marks
 * setup complete (which is what opens the invitation to guests).
 */
(function () {
  'use strict';

  var R = window.RSVPer;
  var el = R.el;
  var stepsList = document.getElementById('wizardSteps');
  var panel = document.getElementById('wizardPanel');

  // Just the essentials. Everything else (options, menu, pictures, deadline,
  // wording, bot protection…) lives in Settings and is suggested at the end.
  var STEPS = [
    {
      id: 'wedding',
      title: 'Your wedding',
      forms: [
        { section: 'couple', title: 'Your names', fields: ['name_one', 'name_two'], help: '' },
        {
          section: 'event',
          title: 'When',
          fields: ['date', 'ceremony_time'],
          help: '',
          // Time zone and date format come from this browser on first setup.
          extra: function () {
            return settings.event.timezone === 'UTC' ? browserDefaults() : {};
          },
        },
        { section: 'venue', title: 'Where', fields: ['name', 'address'], help: '' },
      ],
    },
    { id: 'look', title: 'Look', custom: coloursStep },
    { id: 'guests', title: 'Guests', custom: guestsStep },
    { id: 'finish', title: 'Finish', custom: finishStep },
  ];

  function browserDefaults() {
    var out = {};
    try {
      out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      out.timezone = 'UTC';
    }
    var lang = navigator.language || 'en-GB';
    out.locale = /^en(-|$)/i.test(lang) && lang.indexOf('-') === -1 ? 'en-GB' : lang;
    return out;
  }

  var settings = null;
  var meta = null;
  var current = 0;
  var done = {};

  // Live preview of the guest card (see preview-pane.js).
  var pane = R.previewPane({
    settings: function () {
      return settings;
    },
  });
  var sendPreview = pane.send;
  var refreshEveningToggle = pane.refreshEveningToggle;
  var weddingDate = pane.weddingDate;

  function onDraft(section, payload) {
    pane.onDraft(section, payload);
  }

  function renderSteps() {
    stepsList.textContent = '';
    STEPS.forEach(function (step, i) {
      var li = el(
        'li',
        'wizard-step' + (i === current ? ' current' : '') + (done[step.id] ? ' done' : ''),
      );
      var b = el('button', null, i + 1 + '. ' + step.title);
      b.type = 'button';
      if (i === current) b.setAttribute('aria-current', 'step');
      // Only steps already reached: no skipping past one that isn't saved.
      if (!reachable(i)) {
        b.disabled = true;
        b.title = 'Finish the earlier steps first';
      }
      b.addEventListener('click', function () {
        if (reachable(i)) go(i);
      });
      li.appendChild(b);
      stepsList.appendChild(li);
    });
  }

  /** A step can be opened once every step before it is done. */
  function reachable(i) {
    for (var j = 0; j < i; j++) {
      if (!done[STEPS[j].id]) return false;
    }
    return true;
  }

  function go(i) {
    current = Math.max(0, Math.min(STEPS.length - 1, i));
    renderSteps();
    panel.textContent = '';
    var step = STEPS[current];
    if (step.custom) step.custom(panel);
    else sectionStep(step);
    var heading = panel.querySelector('h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  }

  function backButton() {
    var b = el('button', 'btn btn-ghost', 'Back');
    b.type = 'button';
    b.disabled = current === 0;
    b.addEventListener('click', function () {
      go(current - 1);
    });
    return b;
  }

  /** One or more settings forms; "Continue" saves them all, in order. */
  function sectionStep(step) {
    var forms = step.forms.map(function (f) {
      return R.renderSection(panel, f.section, settings[f.section], {
        quiet: true,
        title: f.title,
        help: f.help,
        fields: f.fields,
        extra: f.extra ? f.extra() : null,
        onChange: onDraft,
        weddingDate: weddingDate,
        onSaved: function (value) {
          settings[f.section] = value;
          pane.saved(f.section);
        },
      });
    });
    // Hide individual save buttons; one Continue saves every form on the step.
    forms.forEach(function (f) {
      f.querySelector('.form-actions').hidden = true;
    });

    var actions = el('div', 'form-actions wizard-actions');
    actions.appendChild(backButton());
    var next = el('button', 'btn btn-primary', 'Save and continue');
    next.type = 'button';
    actions.appendChild(next);
    panel.appendChild(actions);

    next.addEventListener('click', function () {
      next.disabled = true;
      saveForms(
        forms,
        step.forms.map(function (f) {
          return f.section;
        }),
      )
        .then(function (ok) {
          if (ok) {
            done[step.id] = true;
            go(current + 1);
          }
        })
        .then(function () {
          next.disabled = false;
        });
    });
  }

  function saveForms(forms, sections) {
    // Save each form in order; stop at the first one that shows an error.
    return sections.reduce(function (chain, section, i) {
      return chain.then(function (ok) {
        return ok ? forms[i].rsvperSave() : false;
      });
    }, Promise.resolve(true));
  }

  function guestsStep(container) {
    container.appendChild(el('h2', 'section-title', 'Add your guests'));
    container.appendChild(
      el(
        'p',
        'section-help',
        'Import a CSV with one row per guest (columns: household, guest, and optionally plus_one, max_party_size, evening). Or skip this and add invites one at a time from the dashboard.',
      ),
    );
    var example = el('a', 'example-link', 'Download an example CSV');
    example.href = '/vendor/examples/guests.csv';
    example.setAttribute('download', '');
    container.appendChild(example);

    var fileWrap = el('div', 'field');
    var fileLabel = el('label', null, 'CSV file');
    fileLabel.htmlFor = 'wizFile';
    var file = document.createElement('input');
    file.type = 'file';
    file.id = 'wizFile';
    file.accept = '.csv,text/csv';
    fileWrap.appendChild(fileLabel);
    fileWrap.appendChild(file);
    container.appendChild(fileWrap);

    var result = el('div', 'import-result');
    container.appendChild(result);

    var actions = el('div', 'form-actions wizard-actions');
    actions.appendChild(backButton());
    var importBtn = el('button', 'btn btn-ghost', 'Check file');
    importBtn.type = 'button';
    var skip = el('button', 'btn btn-primary', 'Skip for now');
    skip.type = 'button';
    actions.appendChild(importBtn);
    actions.appendChild(skip);
    container.appendChild(actions);

    var csvText = null;
    var ready = false;

    function show(data) {
      result.textContent = '';
      var ok = (data.households || []).length;
      var errs = data.errors || [];
      result.appendChild(
        el(
          'p',
          null,
          ok +
            ' household' +
            (ok === 1 ? '' : 's') +
            ' found' +
            (errs.length ? ', with problems:' : '.'),
        ),
      );
      if (errs.length) {
        var ul = el('ul', 'import-errors');
        errs.forEach(function (e) {
          ul.appendChild(el('li', 'reason', (e.line ? 'Row ' + e.line + ': ' : '') + e.error));
        });
        result.appendChild(ul);
      }
      ready = ok > 0 && errs.length === 0;
      importBtn.textContent = ready ? 'Import ' + ok + ' households' : 'Check file';
      importBtn.className = ready ? 'btn btn-primary' : 'btn btn-ghost';
      skip.className = ready ? 'btn btn-ghost' : 'btn btn-primary';
    }

    file.addEventListener('change', function () {
      ready = false;
      importBtn.textContent = 'Check file';
      result.textContent = '';
    });

    importBtn.addEventListener('click', function () {
      var f = file.files && file.files[0];
      if (!f) {
        R.notify('Choose a CSV file first.', true);
        return;
      }
      importBtn.disabled = true;
      (csvText && ready ? Promise.resolve(csvText) : f.text())
        .then(function (text) {
          csvText = text;
          return R.api('/import', { method: 'POST', json: { csv: text, dry_run: !ready } }).catch(
            function (err) {
              if (err.status === 422 && err.body) return err.body;
              throw err;
            },
          );
        })
        .then(function (data) {
          if (data.imported) {
            R.notify('Imported ' + data.created.length + ' households');
            done.guests = true;
            go(current + 1);
            return;
          }
          show(data);
        })
        .catch(function (err) {
          R.notify(err.message, true);
        })
        .then(function () {
          importBtn.disabled = false;
        });
    });

    skip.addEventListener('click', function () {
      go(current + 1);
    });
  }

  function coloursStep(container) {
    R.renderColours(container, {
      value: settings.theme,
      fontPairs: meta.font_pairs,
      onChange: function (colours) {
        sendPreview({ theme: colours });
      },
      onSaved: function (value) {
        settings.theme = value;
      },
    });
    var actions = el('div', 'form-actions wizard-actions');
    actions.appendChild(backButton());
    var next = el('button', 'btn btn-primary', 'Continue');
    next.type = 'button';
    next.addEventListener('click', function () {
      done.colours = true;
      go(current + 1);
    });
    actions.appendChild(next);
    container.appendChild(actions);
  }

  function finishStep(container) {
    container.appendChild(el('h2', 'section-title', 'Ready to open your invitation?'));
    container.appendChild(
      el(
        'p',
        'section-help',
        'Finishing makes the invitation live: guests with a code can reply. You can keep changing settings and adding guests afterwards.',
      ),
    );
    container.appendChild(el('h3', 'colour-heading', 'Optional extras, any time in Settings'));
    var list = el('ul', 'extras-list');
    [
      ['evening', 'Evening guests', 'on by default; add your reception time'],
      ['features', 'Optional questions', 'meal choices, dietary needs, song requests, messages'],
      ['rsvp', 'RSVP deadline and contact line', ''],
      ['venue', 'Map link for your venue', ''],
      ['images', 'Pictures', 'your own photo instead of the built-in art'],
      ['copy', 'Wording', 'every sentence guests see'],
      [
        'protection',
        'Bot protection',
        meta.turnstile_configured ? 'already on' : 'free and recommended',
      ],
    ].forEach(function (item) {
      var li = el('li');
      var link = el('a', null, item[1]);
      link.href = '/admin/settings#' + item[0];
      li.appendChild(link);
      if (item[2]) li.appendChild(el('span', 'field-hint', ': ' + item[2]));
      list.appendChild(li);
    });
    container.appendChild(list);
    var preview = el('a', 'btn btn-ghost', 'Preview the invitation');
    preview.href = '/';
    preview.target = '_blank';
    preview.rel = 'noopener';

    var error = el('p', 'dialog-error');
    error.hidden = true;
    container.appendChild(error);

    var actions = el('div', 'form-actions wizard-actions');
    actions.appendChild(backButton());
    actions.appendChild(preview);
    var finish = el('button', 'btn btn-primary', 'Finish setup');
    finish.type = 'button';
    actions.appendChild(finish);
    container.appendChild(actions);

    finish.addEventListener('click', function () {
      finish.disabled = true;
      R.api('/setup/complete', { method: 'POST', json: {} })
        .then(function () {
          window.location.href = '/admin';
        })
        .catch(function (err) {
          error.hidden = false;
          error.textContent = err.message;
          finish.disabled = false;
        });
    });
  }

  R.ready(function () {
    R.api('/settings').then(function (data) {
      settings = data.settings;
      meta = data.meta;
      if (meta.names_saved === false) {
        settings.couple = Object.assign({}, settings.couple, { name_one: '', name_two: '' });
      }
      refreshEveningToggle();
      go(0);
    });
  });
})();
