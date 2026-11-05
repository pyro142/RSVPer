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

  var STEPS = [
    { id: 'couple', title: 'Names', sections: ['couple'] },
    { id: 'event', title: 'Date', sections: ['event'] },
    { id: 'venue', title: 'Venue & replies', sections: ['venue', 'rsvp'] },
    { id: 'features', title: 'Options', sections: ['evening', 'features'], menu: true },
    { id: 'images', title: 'Pictures', sections: ['images'] },
    { id: 'guests', title: 'Guests', custom: guestsStep },
    { id: 'finish', title: 'Finish', custom: finishStep },
  ];

  var settings = null;
  var meta = null;
  var current = 0;
  var done = {};

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
      b.addEventListener('click', function () {
        go(i);
      });
      li.appendChild(b);
      stepsList.appendChild(li);
    });
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
    var forms = step.sections.map(function (section) {
      return R.renderSection(panel, section, settings[section], {
        quiet: true,
        onSaved: function (value) {
          settings[section] = value;
        },
      });
    });
    // Hide individual save buttons; one Continue saves every form on the step.
    forms.forEach(function (f) {
      f.querySelector('.form-actions').hidden = true;
    });
    if (step.menu) {
      var menuBox = el('div', 'wizard-menu');
      menuBox.appendChild(
        el(
          'p',
          'field-hint',
          'Only needed if you turned on meal choices. Save the menu before continuing.',
        ),
      );
      R.renderMenuEditor(menuBox);
      panel.appendChild(menuBox);
    }

    var actions = el('div', 'form-actions wizard-actions');
    actions.appendChild(backButton());
    var next = el('button', 'btn btn-primary', 'Save and continue');
    next.type = 'button';
    actions.appendChild(next);
    panel.appendChild(actions);

    next.addEventListener('click', function () {
      next.disabled = true;
      saveForms(forms, step.sections)
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
    var example = el('a', null, 'Download an example CSV');
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

  function finishStep(container) {
    container.appendChild(el('h2', 'section-title', 'Ready to open your invitation?'));
    container.appendChild(
      el(
        'p',
        'section-help',
        'Finishing makes the invitation live: guests with a code can reply. You can keep changing settings and adding guests afterwards.',
      ),
    );
    if (!meta.turnstile_configured) {
      container.appendChild(
        el(
          'p',
          'banner banner-info',
          'Optional but recommended: turn on Cloudflare Turnstile for bot protection. It is free; see Settings → Bot protection for how.',
        ),
      );
    }
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
      go(0);
    });
  });
})();
