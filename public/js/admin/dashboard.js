/* RSVPer admin dashboard: stats, the invite table, add/edit, CSV import,
 * view (with reset reply and new code) and delete. Helpers come from
 * common.js (window.RSVPer). No innerHTML: everything is textContent.
 */

(function () {
  'use strict';

  var R = window.RSVPer;
  var el = R.el;
  var api = R.api;
  var notify = R.notify;
  var $ = function (id) {
    return document.getElementById(id);
  };

  var state = {
    invites: [],
    stats: null,
    search: '',
    status: 'all',
    editingId: null,
    viewing: null,
    importCsv: null,
    confirmAction: null,
    session: null,
  };

  var tableStatus = $('tableStatus');
  var invitesTable = $('invitesTable');
  var invitesBody = $('invitesBody');
  var searchInput = $('search');
  var statusFilter = $('statusFilter');

  var inviteDialog = $('inviteDialog');
  var inviteDialogTitle = $('inviteDialogTitle');
  var householdInput = $('householdInput');
  var maxPartyInput = $('maxPartyInput');
  var receptionOnlyRow = $('receptionOnlyRow');
  var receptionOnlyInput = $('receptionOnlyInput');
  var notesInput = $('notesInput');
  var guestEditorRows = $('guestEditorRows');
  var inviteError = $('inviteError');

  var bulkDialog = $('bulkDialog');
  var bulkFile = $('bulkFile');
  var bulkInput = $('bulkInput');
  var bulkPreview = $('bulkPreview');
  var bulkPreviewBody = $('bulkPreviewBody');
  var bulkErrors = $('bulkErrors');
  var bulkSummary = $('bulkSummary');
  var bulkError = $('bulkError');
  var bulkCommit = $('bulkCommit');

  var viewDialog = $('viewDialog');
  var viewTitle = $('viewTitle');
  var viewBody = $('viewBody');

  var confirmDialog = $('confirmDialog');

  function closeDialogs() {
    [inviteDialog, bulkDialog, viewDialog, confirmDialog].forEach(function (d) {
      if (d.open) d.close();
    });
  }

  document.addEventListener('click', function (event) {
    if (event.target.matches('[data-close]')) {
      event.preventDefault();
      closeDialogs();
    }
  });

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function eveningOn() {
    return !!(state.session && state.session.evening_enabled);
  }

  // ---------------------------------------------------------------------
  // Load and render
  // ---------------------------------------------------------------------

  function load() {
    return Promise.all([api('/invites'), api('/stats')])
      .then(function (results) {
        state.invites = results[0].invites || [];
        state.stats = results[1];
        renderStats();
        renderTable();
      })
      .catch(function (err) {
        tableStatus.hidden = false;
        tableStatus.textContent = 'Could not load invites: ' + err.message;
        invitesTable.hidden = true;
      });
  }

  function renderStats() {
    var s = state.stats;
    var evening = eveningOn();
    document.querySelectorAll('[data-evening]').forEach(function (n) {
      n.hidden = !evening;
    });
    document.querySelectorAll('[data-split]').forEach(function (n) {
      n.classList.toggle('stat--split', evening);
    });

    $('statInvites').textContent = s.total_invites;
    $('statHeadsInvited').textContent = plural(s.total_heads_invited, 'head') + ' invited';
    $('statInvitedDay').textContent = s.day_heads_invited;
    $('statInvitedEve').textContent = s.evening_heads_invited;
    $('statAcceptedDay').textContent = s.day_heads;
    $('statAcceptedEve').textContent = s.evening_heads;
    $('statAccepted').textContent = s.accepted;
    $('statDeclined').textContent = s.declined;
    $('statOutstanding').textContent = s.outstanding;
    $('statOutstandingNote').textContent = s.outstanding
      ? s.unopened + ' not opened · ' + s.opened_no_reply + ' opened'
      : '';
    $('statRate').textContent = s.response_rate + '%';
    renderMeals(s.meals);
    var f = (state.session && state.session.features) || {};
    var parts = [];
    if (f.dietary) parts.push(plural(s.dietary_notes, 'dietary note'));
    if (f.song_request) parts.push(plural(s.song_requests, 'song request'));
    if (f.message) parts.push(plural(s.messages, 'message'));
    $('extrasSummary').hidden = !parts.length;
    $('extrasSummary').textContent =
      parts.join(' · ') + (parts.length ? ' — see each household’s View, or Export replies.' : '');
    $('statHeads').textContent =
      evening && s.evening_heads
        ? s.day_heads + ' day · ' + s.evening_heads + ' evening'
        : plural(s.total_heads, 'head') + ' confirmed';
  }

  function renderMeals(meals) {
    var box = $('mealCounts');
    var grid = $('mealGrid');
    state.optionNames = {};
    state.courseNames = {};
    box.hidden = !meals || !meals.courses.length;
    if (box.hidden) return;
    grid.textContent = '';
    meals.courses.forEach(function (course) {
      state.courseNames[course.id] = course.name;
      var card = el('div', 'stat meal-card');
      card.appendChild(el('span', 'stat-label', course.name));
      var ul = el('ul', 'meal-list');
      course.options.forEach(function (o) {
        state.optionNames[o.id] = o.name;
        if (o.retired && !o.count) return;
        var li = el('li');
        li.appendChild(el('span', null, o.name + (o.retired ? ' (retired)' : '')));
        li.appendChild(el('strong', null, String(o.count)));
        ul.appendChild(li);
      });
      card.appendChild(ul);
      grid.appendChild(card);
    });
    if (meals.without_choice) {
      grid.appendChild(
        el('p', 'stat-note', meals.without_choice + ' confirmed guest(s) have no meal choice yet.'),
      );
    }
  }

  function mealSummary(meals) {
    if (!meals || !state.optionNames) return '';
    return Object.keys(meals)
      .map(function (courseId) {
        return (
          (state.courseNames[courseId] || 'Meal') +
          ': ' +
          (state.optionNames[meals[courseId]] || '?')
        );
      })
      .join(' · ');
  }

  function visibleInvites() {
    var q = state.search.trim().toLowerCase();
    return state.invites.filter(function (invite) {
      if (state.status !== 'all' && invite.status !== state.status) return false;
      if (!q) return true;
      if (invite.household_name.toLowerCase().indexOf(q) !== -1) return true;
      if (invite.code.toLowerCase().indexOf(q) !== -1) return true;
      return invite.guests.some(function (g) {
        return (
          g.name.toLowerCase().indexOf(q) !== -1 ||
          (g.plus_one_name && g.plus_one_name.toLowerCase().indexOf(q) !== -1)
        );
      });
    });
  }

  function renderTable() {
    var rows = visibleInvites();
    invitesBody.textContent = '';

    if (state.invites.length === 0) {
      tableStatus.hidden = false;
      tableStatus.textContent = 'No invites yet. Add one, or import a CSV.';
      invitesTable.hidden = true;
      return;
    }
    if (rows.length === 0) {
      tableStatus.hidden = false;
      tableStatus.textContent = 'No invites match that search.';
      invitesTable.hidden = true;
      return;
    }

    tableStatus.hidden = false;
    tableStatus.textContent =
      rows.length === state.invites.length
        ? plural(rows.length, 'invite')
        : 'Showing ' + rows.length + ' of ' + state.invites.length + ' invites';

    invitesTable.hidden = false;
    rows.forEach(function (invite) {
      invitesBody.appendChild(inviteRow(invite));
    });
  }

  function inviteRow(invite) {
    var tr = el('tr');

    var household = el('td', 'household-cell');
    household.appendChild(el('div', 'household-name', invite.household_name));
    household.appendChild(
      el(
        'div',
        'household-guests',
        invite.guests
          .map(function (g) {
            return g.name + (g.allows_plus_one ? ' +1' : '');
          })
          .join(', '),
      ),
    );
    tr.appendChild(household);

    var codeCell = el('td', 'code-cell');
    var codeWrap = el('span', 'code-wrap');
    codeWrap.appendChild(el('span', null, invite.code));
    codeWrap.appendChild(R.copyLinkButton(invite));
    codeCell.appendChild(codeWrap);
    tr.appendChild(codeCell);

    tr.appendChild(el('td', 'num', String(invite.max_party_size)));

    var statusCell = el('td');
    statusCell.appendChild(el('span', 'pill pill-' + invite.status, invite.status));
    if (eveningOn() && invite.evening_only) {
      var label = invite.chose_reception_only ? 'evening by choice' : 'evening';
      var tag = el('span', 'pill pill-evening', label);
      if (invite.chose_reception_only) {
        tag.classList.add('pill-evening-chosen');
        tag.title = 'Invited to the whole day — replied that they can only make the evening';
      }
      statusCell.appendChild(document.createTextNode(' '));
      statusCell.appendChild(tag);
    }
    tr.appendChild(statusCell);

    tr.appendChild(el('td', 'num', invite.status === 'accepted' ? String(invite.heads) : '—'));

    var actions = el('td');
    var group = el('div', 'row-actions');
    group.appendChild(
      actionButton('View', 'icon-btn', function () {
        openView(invite);
      }),
    );
    group.appendChild(
      actionButton('Edit', 'icon-btn', function () {
        openEdit(invite);
      }),
    );
    group.appendChild(
      actionButton('Delete', 'icon-btn danger', function () {
        openDelete(invite);
      }),
    );
    actions.appendChild(group);
    tr.appendChild(actions);
    return tr;
  }

  function actionButton(label, className, onClick) {
    var button = el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  // ---------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------

  function openView(invite) {
    state.viewing = invite;
    viewTitle.textContent = invite.household_name;
    viewBody.textContent = '';

    var meta = el('dl', 'view-meta');
    var pairs = [
      ['Code', invite.code],
      ['Max party', String(invite.max_party_size)],
    ];
    if (eveningOn()) {
      pairs.push(['Invited to', invite.reception_only ? 'Evening only' : 'Whole day']);
      pairs.push([
        'Attending',
        invite.status !== 'accepted' ? '—' : invite.evening_only ? 'Evening only' : 'Whole day',
      ]);
    }
    pairs.push(['Status', invite.status]);
    pairs.push(['Heads', invite.status === 'accepted' ? String(invite.heads) : '—']);
    pairs.push([
      'Opened',
      invite.opened
        ? invite.first_opened_at + (invite.open_count > 1 ? ' (×' + invite.open_count + ')' : '')
        : 'never',
    ]);
    pairs.push(['Replied', invite.submitted_at || '—']);
    pairs.forEach(function (pair) {
      var box = el('div');
      box.appendChild(el('dt', null, pair[0]));
      box.appendChild(el('dd', null, pair[1]));
      meta.appendChild(box);
    });
    viewBody.appendChild(meta);

    var list = el('ul', 'view-guests');
    invite.guests.forEach(function (guest) {
      var li = el('li');
      var left = el('span');
      left.appendChild(el('span', null, guest.name));
      if (guest.dietary_notes) left.appendChild(el('span', 'view-note', guest.dietary_notes));
      var gm = mealSummary(guest.meals);
      if (gm) left.appendChild(el('span', 'view-note', gm));
      li.appendChild(left);

      var right = el('span');
      if (guest.plus_one_name) {
        var plus = el('span', 'view-guest-plus', '+ ' + guest.plus_one_name + '  ');
        right.appendChild(plus);
      } else if (guest.allows_plus_one && invite.status !== 'accepted') {
        right.appendChild(el('span', 'view-guest-plus', '+1 allowed  '));
      }
      var label =
        invite.status === 'outstanding'
          ? 'no reply'
          : guest.attending
            ? 'attending'
            : 'not attending';
      var pillClass =
        invite.status === 'outstanding'
          ? 'pill pill-outstanding'
          : guest.attending
            ? 'pill pill-accepted'
            : 'pill pill-declined';
      right.appendChild(el('span', pillClass, label));
      li.appendChild(right);
      list.appendChild(li);

      var pm = guest.plus_one_name ? mealSummary(guest.plus_one_meals) : '';
      if (pm) {
        var mli = el('li');
        mli.appendChild(el('span', 'view-note', guest.plus_one_name + ' — ' + pm));
        list.appendChild(mli);
      }
      if (guest.plus_one_dietary_notes) {
        var pli = el('li');
        pli.appendChild(
          el('span', 'view-note', guest.plus_one_name + ': ' + guest.plus_one_dietary_notes),
        );
        list.appendChild(pli);
      }
    });
    viewBody.appendChild(list);

    [
      ['Song request', invite.song_request],
      ['Message', invite.message],
      ['Private notes', invite.admin_notes],
    ].forEach(function (pair) {
      if (!pair[1]) return;
      var block = el('div', 'view-extra');
      block.appendChild(el('h3', null, pair[0]));
      block.appendChild(el('p', null, pair[1]));
      viewBody.appendChild(block);
    });

    var linkRow = el('div', 'link-row');
    var linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.readOnly = true;
    linkInput.value = R.inviteLink(invite);
    linkInput.setAttribute('aria-label', 'Invite link');
    linkRow.appendChild(linkInput);
    linkRow.appendChild(R.copyLinkButton(invite, 'btn btn-ghost btn-small', 'Copy link'));
    viewBody.appendChild(linkRow);

    $('resetReplyBtn').hidden = invite.status === 'outstanding';
    viewDialog.showModal();
  }

  $('resetReplyBtn').addEventListener('click', function () {
    var invite = state.viewing;
    confirm(
      'Reset reply?',
      'This deletes the reply from ' +
        invite.household_name +
        ' so they can reply again with the same link. Use it if a reply was a mistake or wasn’t really from them.',
      'Reset reply',
      function () {
        return api('/invites/' + invite.id + '/reset-reply', { method: 'POST', json: {} }).then(
          function () {
            notify('Reply reset for ' + invite.household_name);
          },
        );
      },
    );
  });

  $('regenerateBtn').addEventListener('click', function () {
    var invite = state.viewing;
    confirm(
      'Give them a new code?',
      'The old code (' +
        invite.code +
        ') and link will stop working immediately. Use this if a code was shared with the wrong people.',
      'New code',
      function () {
        return api('/invites/' + invite.id, {
          method: 'PATCH',
          json: { regenerate_code: true },
        }).then(function (result) {
          notify('New code for ' + invite.household_name + ': ' + result.code);
        });
      },
    );
  });

  // ---------------------------------------------------------------------
  // Confirm dialog (delete, reset, new code)
  // ---------------------------------------------------------------------

  function confirm(title, body, goLabel, action) {
    closeDialogs();
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    $('confirmGo').textContent = goLabel;
    state.confirmAction = action;
    confirmDialog.showModal();
  }

  $('confirmGo').addEventListener('click', function () {
    var action = state.confirmAction;
    if (!action) return;
    $('confirmGo').disabled = true;
    action()
      .then(function () {
        closeDialogs();
        return load();
      })
      .catch(function (err) {
        notify(err.message, true);
      })
      .then(function () {
        $('confirmGo').disabled = false;
      });
  });

  function openDelete(invite) {
    confirm(
      'Delete invite?',
      'This removes ' +
        invite.household_name +
        ', their ' +
        plural(invite.guests.length, 'named guest') +
        (invite.status === 'outstanding' ? '' : ', and the reply they already sent') +
        '. Their code (' +
        invite.code +
        ') will stop working. This cannot be undone.',
      'Delete',
      function () {
        return api('/invites/' + invite.id, { method: 'DELETE' }).then(function () {
          notify('Deleted ' + invite.household_name);
        });
      },
    );
  }

  // ---------------------------------------------------------------------
  // Add / edit
  // ---------------------------------------------------------------------

  function guestEditorRow(name, allowsPlusOne, disabled) {
    var row = el('div', 'guest-editor-row');

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Guest name';
    input.maxLength = 120;
    input.value = name || '';
    input.disabled = !!disabled;
    input.setAttribute('aria-label', 'Guest name');
    row.appendChild(input);

    var checkLabel = el('label', 'plus-one-check');
    var check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !!allowsPlusOne;
    check.disabled = !!disabled;
    checkLabel.appendChild(check);
    checkLabel.appendChild(el('span', null, '+1'));
    row.appendChild(checkLabel);

    var remove = el('button', 'remove-guest', '×');
    remove.type = 'button';
    remove.disabled = !!disabled;
    remove.setAttribute('aria-label', 'Remove guest');
    remove.addEventListener('click', function () {
      if (guestEditorRows.children.length > 1) row.remove();
      else {
        input.value = '';
        check.checked = false;
      }
    });
    row.appendChild(remove);
    return row;
  }

  function openAdd() {
    state.editingId = null;
    inviteDialogTitle.textContent = 'Add invite';
    householdInput.value = '';
    maxPartyInput.value = '2';
    receptionOnlyInput.checked = false;
    receptionOnlyRow.hidden = !eveningOn();
    notesInput.value = '';
    guestEditorRows.textContent = '';
    guestEditorRows.appendChild(guestEditorRow('', false, false));
    $('addGuestRow').disabled = false;
    inviteError.hidden = true;
    inviteDialog.showModal();
    householdInput.focus();
  }

  function openEdit(invite) {
    state.editingId = invite.id;
    inviteDialogTitle.textContent = 'Edit invite';
    householdInput.value = invite.household_name;
    maxPartyInput.value = String(invite.max_party_size);
    receptionOnlyInput.checked = !!invite.reception_only;
    receptionOnlyRow.hidden = !eveningOn();
    notesInput.value = invite.admin_notes || '';

    var locked = invite.status !== 'outstanding';
    guestEditorRows.textContent = '';
    invite.guests.forEach(function (g) {
      guestEditorRows.appendChild(guestEditorRow(g.name, g.allows_plus_one, locked));
    });
    $('addGuestRow').disabled = locked;

    if (locked) {
      inviteError.hidden = false;
      inviteError.textContent =
        'This household has already replied, so their guest list is locked. ' +
        'You can still change the name, cap and notes — or reset their reply from View.';
    } else {
      inviteError.hidden = true;
    }
    inviteDialog.showModal();
    householdInput.focus();
  }

  function collectGuests() {
    return [].slice
      .call(guestEditorRows.querySelectorAll('.guest-editor-row'))
      .map(function (row) {
        return {
          name: row.querySelector('input[type="text"]').value.trim(),
          allows_plus_one: row.querySelector('input[type="checkbox"]').checked,
        };
      })
      .filter(function (g) {
        return g.name;
      });
  }

  function saveInvite() {
    var household = householdInput.value.trim();
    var max = Number(maxPartyInput.value);
    var guests = collectGuests();

    if (!household) return showInviteError('Please give the household a name.');
    if (!Number.isInteger(max) || max < 1)
      return showInviteError('Max party size must be at least 1.');
    if (guests.length === 0) return showInviteError('Add at least one named guest.');

    var plusOnes = guests.filter(function (g) {
      return g.allows_plus_one;
    }).length;
    if (max < guests.length + plusOnes) {
      return showInviteError(
        'Max party size (' +
          max +
          ') is smaller than the ' +
          plural(guests.length, 'named guest') +
          (plusOnes ? ' and ' + plural(plusOnes, 'plus one') : '') +
          '.',
      );
    }

    var editing = state.editingId !== null;
    var body = {
      household_name: household,
      max_party_size: max,
      admin_notes: notesInput.value.trim() || null,
    };
    if (eveningOn()) body.reception_only = receptionOnlyInput.checked;
    if (!editing || !guestEditorRows.querySelector('input[disabled]')) body.guests = guests;

    api(editing ? '/invites/' + state.editingId : '/invites', {
      method: editing ? 'PATCH' : 'POST',
      json: body,
    })
      .then(function (result) {
        closeDialogs();
        if (!editing && result.created && result.created[0]) {
          notify('Added ' + result.created[0].household_name + ' — code ' + result.created[0].code);
        } else {
          notify('Saved');
        }
        return load();
      })
      .catch(function (err) {
        showInviteError(err.message);
      });
  }

  function showInviteError(message) {
    inviteError.hidden = false;
    inviteError.textContent = message;
  }

  // ---------------------------------------------------------------------
  // CSV import (parsed and validated on the server; all-or-nothing)
  // ---------------------------------------------------------------------

  function readImportText() {
    if (bulkFile.files && bulkFile.files[0]) {
      var file = bulkFile.files[0];
      if (file.size > 500 * 1024)
        return Promise.reject(new Error('That file is too large (max 500 KB).'));
      return file.text();
    }
    return Promise.resolve(bulkInput.value);
  }

  function previewImport() {
    bulkError.hidden = true;
    bulkCommit.disabled = true;
    readImportText()
      .then(function (text) {
        if (!text.trim()) throw new Error('Choose a file or paste your list first.');
        state.importCsv = text;
        return api('/import', { method: 'POST', json: { csv: text, dry_run: true } }).catch(
          function (err) {
            if (err.status === 422 && err.body) return err.body;
            throw err;
          },
        );
      })
      .then(renderImportPreview)
      .catch(function (err) {
        bulkError.hidden = false;
        bulkError.textContent = err.message;
        bulkPreview.hidden = true;
      });
  }

  function renderImportPreview(result) {
    bulkPreviewBody.textContent = '';
    bulkErrors.textContent = '';
    (result.households || []).forEach(function (h) {
      var tr = el('tr');
      var name = el('td', null, h.household_name);
      if (h.reception_only) {
        name.appendChild(document.createTextNode(' '));
        name.appendChild(el('span', 'pill pill-evening', 'evening'));
      }
      tr.appendChild(name);
      tr.appendChild(el('td', 'num', String(h.max_party_size)));
      tr.appendChild(
        el(
          'td',
          null,
          h.guests
            .map(function (g) {
              return g.name + (g.allows_plus_one ? ' +1' : '');
            })
            .join(', '),
        ),
      );
      tr.appendChild(el('td', 'num', h.lines.join(', ')));
      bulkPreviewBody.appendChild(tr);
    });
    (result.errors || []).forEach(function (e) {
      bulkErrors.appendChild(el('li', 'reason', (e.line ? 'Row ' + e.line + ': ' : '') + e.error));
    });
    var ok = (result.households || []).length;
    var bad = (result.errors || []).length;
    bulkSummary.textContent =
      plural(ok, 'household') +
      ' ready to import' +
      (bad ? ', ' + plural(bad, 'problem') + ' — fix those rows and preview again.' : '.');
    bulkPreview.hidden = false;
    bulkCommit.disabled = ok === 0 || bad > 0;
  }

  function commitImport() {
    if (!state.importCsv) return;
    bulkCommit.disabled = true;
    api('/import', { method: 'POST', json: { csv: state.importCsv, dry_run: false } })
      .then(function (result) {
        closeDialogs();
        bulkInput.value = '';
        bulkFile.value = '';
        bulkPreview.hidden = true;
        notify('Imported ' + plural(result.created.length, 'household'));
        return load();
      })
      .catch(function (err) {
        bulkError.hidden = false;
        bulkError.textContent = err.message;
      });
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  searchInput.addEventListener('input', function () {
    state.search = searchInput.value;
    renderTable();
  });
  statusFilter.addEventListener('change', function () {
    state.status = statusFilter.value;
    renderTable();
  });

  $('addBtn').addEventListener('click', openAdd);
  $('saveInvite').addEventListener('click', saveInvite);
  $('addGuestRow').addEventListener('click', function () {
    guestEditorRows.appendChild(guestEditorRow('', false, false));
    var inputs = guestEditorRows.querySelectorAll('input[type="text"]');
    inputs[inputs.length - 1].focus();
  });

  $('bulkBtn').addEventListener('click', function () {
    bulkError.hidden = true;
    bulkPreview.hidden = true;
    bulkCommit.disabled = true;
    bulkDialog.showModal();
  });
  $('bulkPreviewBtn').addEventListener('click', previewImport);
  bulkCommit.addEventListener('click', commitImport);
  bulkFile.addEventListener('change', function () {
    bulkCommit.disabled = true;
    bulkPreview.hidden = true;
  });
  bulkInput.addEventListener('input', function () {
    bulkCommit.disabled = true;
  });

  R.ready(function (session) {
    state.session = session;
    load();
  });
})();
