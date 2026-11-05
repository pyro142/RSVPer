/* RSVPer — guest RSVP flow.
 *
 * Three states in one page, no reloads:
 *   1  code entry          — skipped entirely when the URL carries a code
 *   2  the reply           — who's coming, plus ones, accept or decline
 *   3  confirmation        — thank you, with confetti for an acceptance
 *
 * Couple-specific text is rendered into the page by the server. What this
 * script needs beyond that arrives in <body data-config> (base64 JSON).
 *
 * Guest and household names come from the admin, so every string that reaches
 * the DOM goes through textContent. Nothing here builds markup from strings.
 */

(function () {
  'use strict';

  var API_LOOKUP = '/api/rsvp/lookup';
  var API_SUBMIT = '/api/rsvp/submit';
  var CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;

  var config = readConfig();
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function readConfig() {
    try {
      var raw = atob(document.body.getAttribute('data-config') || '');
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { ready: false };
    }
  }

  // ---------------------------------------------------------------------
  // Element handles
  // ---------------------------------------------------------------------
  var $ = function (id) {
    return document.getElementById(id);
  };

  var stateUnready = $('stateUnready');
  var stateCode = $('stateCode');
  var stateRsvp = $('stateRsvp');
  var stateDone = $('stateDone');
  var announce = $('stateAnnounce');

  var codeForm = $('codeForm');
  var codeInput = $('codeInput');
  var codeError = $('codeError');
  var codeSubmit = $('codeSubmit');
  var codeTurnstile = $('codeTurnstile');

  var rsvpForm = $('rsvpForm');
  var householdName = $('householdName');
  var attendingToggle = $('attendingToggle');
  var attendYes = $('attendYes');
  var attendNo = $('attendNo');
  var acceptBranch = $('acceptBranch');
  var declineBranch = $('declineBranch');
  var scopeChoice = $('scopeChoice');
  var scopeDay = $('scopeDay');
  var scopeEvening = $('scopeEvening');
  var scopeNote = $('scopeNote');
  var guestList = $('guestList');
  var partyCount = $('partyCount');
  var capacityError = $('capacityError');
  var extras = $('extras');
  var songField = $('songField');
  var songInput = $('songInput');
  var messageField = $('messageField');
  var messageInput = $('messageInput');
  var submitError = $('submitError');
  var rsvpSubmit = $('rsvpSubmit');
  var turnstileHolder = $('turnstileHolder');

  var doneHeading = $('doneHeading');
  var doneMessage = $('doneMessage');

  // ---------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------
  var invite = null; // the looked-up household
  var inviteCode = null; // normalised code we'll submit with
  var guestRows = []; // one entry per named guest, with its controls
  var submitting = false;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function show(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function hide(node) {
    node.hidden = true;
    node.textContent = '';
  }

  function say(message) {
    announce.textContent = message;
  }

  function features() {
    return (invite && invite.features) || {};
  }

  // Must stay in step with the .leaving / .entering durations in rsvp.css.
  var LEAVE_MS = 240;
  var ENTER_MS = 420;

  /**
   * Run `job` when the element's animation ends — or when the clock says it
   * must have. Background tabs suspend animation frames, so animationend
   * alone can leave the card frozen mid-transition.
   */
  function afterAnimation(node, fallbackMs, job) {
    var done = false;
    var timer;

    function finish() {
      if (done) return;
      done = true;
      node.removeEventListener('animationend', finish);
      clearTimeout(timer);
      job();
    }

    node.addEventListener('animationend', finish);
    timer = setTimeout(finish, fallbackMs);
  }

  /** Cross-fade between states, or swap instantly when motion is reduced. */
  function goToState(next, announcement, onRevealed) {
    var current = document.querySelector('.state:not([hidden])');
    if (announcement) say(announcement);
    if (current === next) {
      if (onRevealed) onRevealed();
      return;
    }

    function reveal() {
      next.hidden = false;

      if (!reducedMotion) {
        next.classList.add('entering');
        afterAnimation(next, ENTER_MS + 80, function () {
          next.classList.remove('entering');
        });
      }

      var focusTarget = next.querySelector('h1, .confirm-display');
      if (focusTarget) {
        focusTarget.setAttribute('tabindex', '-1');
        focusTarget.focus({ preventScroll: true });
      }

      if (onRevealed) onRevealed();
    }

    if (!current || reducedMotion) {
      if (current) current.hidden = true;
      reveal();
      return;
    }

    current.classList.add('leaving');
    afterAnimation(current, LEAVE_MS + 80, function () {
      current.classList.remove('leaving');
      current.hidden = true;
      reveal();
    });
  }

  function setBusy(button, busy, busyLabel, idleLabel) {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
    button.textContent = busy ? busyLabel : idleLabel;
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { status: res.status, data: data };
        });
    });
  }

  // ---------------------------------------------------------------------
  // Turnstile (optional — only when the site has it configured)
  // ---------------------------------------------------------------------

  function Challenge(holder) {
    this.holder = holder;
    this.token = null;
    this.widgetId = null;
  }

  Challenge.prototype.mount = function (siteKey) {
    var self = this;
    if (!siteKey || self.widgetId !== null) return;
    turnstileReady().then(function (ok) {
      if (!ok || self.widgetId !== null) return;
      self.widgetId = window.turnstile.render(self.holder, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        callback: function (token) {
          self.token = token;
        },
        'error-callback': function () {
          self.token = null;
        },
        'expired-callback': function () {
          self.token = null;
        },
      });
    });
  };

  /** Tokens are single use — after any attempt the widget needs resetting. */
  Challenge.prototype.reset = function () {
    this.token = null;
    if (this.widgetId !== null && window.turnstile) {
      try {
        window.turnstile.reset(this.widgetId);
      } catch {
        /* already gone */
      }
    }
  };

  Challenge.prototype.awaitToken = function (timeoutMs) {
    var self = this;
    var deadline = Date.now() + (timeoutMs || 12000);
    return new Promise(function (resolve) {
      (function poll() {
        if (self.token) return resolve(self.token);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(poll, 120);
      })();
    });
  };

  /** Resolve once the Turnstile script has landed, or give up after 8s. */
  function turnstileReady() {
    return new Promise(function (resolve) {
      if (window.turnstile) return resolve(true);
      var waited = 0;
      var poll = setInterval(function () {
        waited += 60;
        if (window.turnstile) {
          clearInterval(poll);
          resolve(true);
        } else if (waited >= 8000) {
          clearInterval(poll);
          resolve(false);
        }
      }, 60);
    });
  }

  var codeChallenge = new Challenge(codeTurnstile);
  var replyChallenge = new Challenge(turnstileHolder);
  var codeChallengeRequired = false;

  // ---------------------------------------------------------------------
  // State 1 — code entry
  // ---------------------------------------------------------------------

  function cleanCode(value) {
    return value.replace(/[\s-]/g, '').toUpperCase();
  }

  codeInput.addEventListener('input', function () {
    var cleaned = cleanCode(codeInput.value);
    if (cleaned !== codeInput.value) {
      var atEnd = codeInput.selectionStart === codeInput.value.length;
      codeInput.value = cleaned;
      if (atEnd) codeInput.setSelectionRange(cleaned.length, cleaned.length);
    }
    if (!codeError.hidden) hide(codeError);
  });

  codeForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var value = cleanCode(codeInput.value);
    var len = config.code_length || { min: 5, max: 8 };

    if (value.length < len.min || value.length > len.max || !CODE_RE.test(value)) {
      show(codeError, "That doesn't look like an invite code. Please check your invitation.");
      codeInput.focus();
      return;
    }

    lookup(value, { fromForm: true });
  });

  function lookup(code, opts) {
    opts = opts || {};
    if (opts.fromForm) setBusy(codeSubmit, true, 'Checking…', 'Continue');

    var tokenPromise = codeChallengeRequired ? codeChallenge.awaitToken() : Promise.resolve(null);

    tokenPromise
      .then(function (token) {
        return postJson(API_LOOKUP, { code: code, turnstile_token: token });
      })
      .then(function (result) {
        if (opts.fromForm) setBusy(codeSubmit, false, 'Checking…', 'Continue');
        if (codeChallengeRequired) codeChallenge.reset();

        if (result.status === 403 && result.data && result.data.turnstile_required) {
          // The site is under unusual load; prove you're human, then retry.
          codeChallengeRequired = true;
          codeChallenge.mount(result.data.turnstile_site_key);
          goToState(stateCode, 'Please complete the check below');
          show(codeError, 'Please complete the check below, then press Continue.');
          if (!codeInput.value) codeInput.value = code;
          return;
        }

        if (result.status !== 200) {
          var message =
            (result.data && result.data.error) ||
            "We couldn't find that code. Please check your invitation.";
          if (!opts.fromForm) goToState(stateCode, 'Enter your invite code');
          show(codeError, message);
          codeInput.focus();
          if (opts.fromForm) codeInput.select();
          return;
        }

        inviteCode = code;
        invite = result.data;
        applyTheme();

        // Keep the address bar in step so a refresh lands in the same place.
        if (opts.fromForm && window.history && window.history.replaceState) {
          window.history.replaceState({}, '', '/' + code);
        }

        if (invite.already_submitted) {
          var acceptedBefore = !!(invite.previous_rsvp && invite.previous_rsvp.attending);
          showConfirmation('already', acceptedBefore);
          return;
        }

        if (invite.closed) {
          showConfirmation('closed');
          return;
        }

        buildRsvpForm();
        replyChallenge.mount(invite.turnstile_site_key);
        goToState(stateRsvp, 'Reply for ' + invite.household_name);
      })
      .catch(function () {
        if (opts.fromForm) setBusy(codeSubmit, false, 'Checking…', 'Continue');
        if (!opts.fromForm) goToState(stateCode, 'Enter your invite code');
        show(
          codeError,
          "We couldn't reach the server. Please check your connection and try again.",
        );
      });
  }

  // ---------------------------------------------------------------------
  // State 2 — the reply
  // ---------------------------------------------------------------------

  /**
   * Is this card currently an evening one? Either the household was only
   * invited to the reception, or they've just chosen the evening.
   */
  function isEvening() {
    if (!invite || !features().evening) return false;
    if (invite.reception_only) return true;
    if (scopeEvening.checked && attendYes.checked) return true;
    if (invite.already_submitted && invite.previous_rsvp) {
      return !!invite.previous_rsvp.reception_only;
    }
    return false;
  }

  function applyTheme() {
    var evening = isEvening();
    var photo = $('venuePhoto');
    var themeColor = document.querySelector('meta[name="theme-color"]');
    var times = config.times || {};
    var hero = config.hero || {};

    if (evening) document.documentElement.setAttribute('data-theme', 'evening');
    else document.documentElement.removeAttribute('data-theme');

    var timeNode = $('eventTime');
    var time = evening ? times.evening : times.day;
    if (timeNode) timeNode.textContent = time ? '· ' + time : '';

    var src = evening ? hero.evening || hero.day : hero.day;
    if (photo && src) photo.src = src;

    if (themeColor) themeColor.setAttribute('content', evening ? '#201A24' : '#FFF8EF');
  }

  function buildRsvpForm() {
    householdName.textContent = invite.household_name;

    // A household already invited to the reception has nothing to choose.
    scopeChoice.hidden = !features().evening || !!invite.reception_only;

    songField.hidden = !features().song_request;
    messageField.hidden = !features().message;
    extras.hidden = true; // shown once they pick accept / decline

    guestList.querySelectorAll('.guest-row').forEach(function (n) {
      n.remove();
    });
    guestRows = [];

    invite.guests.forEach(function (guest, index) {
      guestRows.push(buildGuestRow(guest, index));
    });

    updatePartyCount();
  }

  function dietaryField(id, label) {
    var field = el('div', 'dietary field');
    var lab = el('label', null, label);
    lab.htmlFor = id;
    var input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.maxLength = 300;
    input.autocomplete = 'off';
    input.placeholder = 'Allergies or dietary needs (optional)';
    field.appendChild(lab);
    field.appendChild(input);
    return { field: field, input: input };
  }

  /**
   * One <select> per course for one person. get() returns {course_id:
   * option_id} or null if any course is unanswered.
   */
  function mealFields(prefix, who) {
    var menu = (invite && invite.menu) || [];
    if (!features().meals || !menu.length) return null;
    var wrap = el('div', 'meals');
    var selects = [];
    menu.forEach(function (course, ci) {
      var field = el('div', 'field meal-field');
      var id = prefix + '-meal-' + ci;
      var label = el('label', null, course.name + (who ? ' for ' + who : ''));
      label.htmlFor = id;
      var select = document.createElement('select');
      select.id = id;
      var placeholder = el('option', null, 'Choose…');
      placeholder.value = '';
      select.appendChild(placeholder);
      course.options.forEach(function (o) {
        var option = el('option', null, o.description ? o.name + ' — ' + o.description : o.name);
        option.value = o.id;
        select.appendChild(option);
      });
      field.appendChild(label);
      field.appendChild(select);
      wrap.appendChild(field);
      selects.push({ course: course, select: select });
    });
    return {
      node: wrap,
      reset: function () {
        selects.forEach(function (s) {
          s.select.value = '';
        });
      },
      get: function () {
        var out = {};
        for (var i = 0; i < selects.length; i++) {
          if (!selects[i].select.value) return null;
          out[selects[i].course.id] = selects[i].select.value;
        }
        return out;
      },
    };
  }

  function buildGuestRow(guest, index) {
    var row = el('div', 'guest-row');

    var main = el('label', 'guest-main');
    var check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'guest-check';
    check.checked = true; // everyone's assumed coming until told otherwise
    main.appendChild(check);

    var label = el('span', 'guest-label');
    label.appendChild(el('span', 'guest-name', guest.name));
    main.appendChild(label);

    if (guest.allows_plus_one) {
      var tag = el('span', 'plus-one-tag', '+1');
      tag.setAttribute('aria-hidden', 'true');
      main.appendChild(tag);
    }

    row.appendChild(main);

    var entry = {
      guest: guest,
      checkbox: check,
      plusOneWanted: null,
      plusOneInput: null,
      dietaryInput: null,
      plusOneDietaryInput: null,
      meals: null,
      plusOneMeals: null,
    };

    if (features().dietary) {
      var diet = dietaryField('diet-' + index, 'Dietary needs for ' + guest.name);
      diet.field.querySelector('label').className = 'sr-only';
      row.appendChild(diet.field);
      entry.dietaryField = diet.field;
      entry.dietaryInput = diet.input;
    }

    entry.meals = mealFields('guest-' + index, guest.name);
    if (entry.meals) {
      entry.meals.node.classList.add('guest-meals');
      row.appendChild(entry.meals.node);
    }

    if (guest.allows_plus_one) {
      var block = el('div', 'plus-one');
      block.hidden = false;

      var ask = el('div', 'plus-one-ask');
      ask.appendChild(el('span', 'ask-label', 'Bringing a plus one?'));

      var group = el('fieldset', 'mini-toggle');
      group.appendChild(el('legend', 'sr-only', 'Is ' + guest.name + ' bringing a plus one?'));

      var name = 'plus-one-' + index;
      var yes = radio(name, name + '-yes', 'Yes', 'mini-toggle-btn', false);
      var no = radio(name, name + '-no', 'No', 'mini-toggle-btn', true);
      group.appendChild(yes.input);
      group.appendChild(yes.label);
      group.appendChild(no.input);
      group.appendChild(no.label);
      ask.appendChild(group);
      block.appendChild(ask);

      var nameField = el('div', 'plus-one-name field');
      nameField.hidden = true;
      var nameLabel = el('label', null, "Plus one's name");
      nameLabel.htmlFor = name + '-name';
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.id = name + '-name';
      nameInput.maxLength = 80;
      nameInput.autocomplete = 'off';
      nameInput.placeholder = 'Their name';
      nameField.appendChild(nameLabel);
      nameField.appendChild(nameInput);

      if (features().dietary) {
        var pdiet = dietaryField(name + '-diet', "Plus one's dietary needs");
        pdiet.field.querySelector('label').className = 'sr-only';
        nameField.appendChild(pdiet.field);
        entry.plusOneDietaryInput = pdiet.input;
      }

      entry.plusOneMeals = mealFields('plus-one-' + index, 'their plus one');
      if (entry.plusOneMeals) nameField.appendChild(entry.plusOneMeals.node);

      block.appendChild(nameField);
      row.appendChild(block);

      entry.plusOneBlock = block;
      entry.plusOneWanted = yes.input;
      entry.plusOneDeclined = no.input;
      entry.plusOneField = nameField;
      entry.plusOneInput = nameInput;

      yes.input.addEventListener('change', function () {
        nameField.hidden = false;
        nameInput.focus();
        updatePartyCount();
      });

      no.input.addEventListener('change', function () {
        nameField.hidden = true;
        nameInput.value = '';
        if (entry.plusOneDietaryInput) entry.plusOneDietaryInput.value = '';
        if (entry.plusOneMeals) entry.plusOneMeals.reset();
        updatePartyCount();
      });
    }

    check.addEventListener('change', function () {
      if (entry.dietaryField) entry.dietaryField.hidden = !check.checked;
      if (entry.meals) entry.meals.node.hidden = !check.checked;
      if (entry.plusOneBlock) {
        entry.plusOneBlock.hidden = !check.checked;
        if (!check.checked) {
          // Someone who isn't coming can't bring anyone.
          entry.plusOneWanted.checked = false;
          entry.plusOneDeclined.checked = true;
          entry.plusOneField.hidden = true;
          entry.plusOneInput.value = '';
        }
      }
      updatePartyCount();
    });

    guestList.appendChild(row);
    return entry;
  }

  function radio(groupName, id, labelText, labelClass, checked) {
    var input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.id = id;
    input.className = 'toggle-input';
    input.checked = !!checked;

    var label = el('label', labelClass, labelText);
    label.htmlFor = id;

    return { input: input, label: label };
  }

  function headCount() {
    return guestRows.reduce(function (total, entry) {
      if (!entry.checkbox.checked) return total;
      var plusOne = entry.plusOneWanted && entry.plusOneWanted.checked ? 1 : 0;
      return total + 1 + plusOne;
    }, 0);
  }

  function capacityMessage(max) {
    return (
      'This invite is for up to ' +
      max +
      ' guest' +
      (max === 1 ? '' : 's') +
      '. Please contact us if you need to make changes.'
    );
  }

  function updatePartyCount() {
    var count = headCount();
    var max = invite.max_party_size;
    var over = count > max;

    partyCount.textContent = count + ' of ' + max + ' attending';
    partyCount.classList.toggle('over', over);

    if (over) show(capacityError, capacityMessage(max));
    else hide(capacityError);

    refreshSubmitState();
  }

  function refreshSubmitState() {
    if (submitting) return;

    if (attendNo.checked) {
      rsvpSubmit.disabled = false;
      return;
    }

    if (attendYes.checked) {
      var count = headCount();
      rsvpSubmit.disabled = count === 0 || count > invite.max_party_size;
      return;
    }

    rsvpSubmit.disabled = true;
  }

  function refreshExtras() {
    var song = features().song_request && attendYes.checked;
    var message = features().message && (attendYes.checked || attendNo.checked);
    songField.hidden = !song;
    messageField.hidden = !message;
    extras.hidden = !song && !message;
  }

  attendYes.addEventListener('change', function () {
    acceptBranch.hidden = false;
    declineBranch.hidden = true;
    attendingToggle.classList.remove('invalid');
    hide(submitError);
    refreshExtras();
    applyTheme();
    updatePartyCount();
  });

  attendNo.addEventListener('change', function () {
    acceptBranch.hidden = true;
    declineBranch.hidden = false;
    attendingToggle.classList.remove('invalid');
    hide(submitError);
    hide(capacityError);
    refreshExtras();
    applyTheme();
    refreshSubmitState();
  });

  scopeDay.addEventListener('change', function () {
    scopeNote.hidden = true;
    applyTheme();
  });

  scopeEvening.addEventListener('change', function () {
    scopeNote.hidden = !scopeNote.textContent;
    applyTheme();
  });

  rsvpForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (submitting) return;

    hide(submitError);

    if (!attendYes.checked && !attendNo.checked) {
      attendingToggle.classList.add('invalid');
      show(submitError, 'Please let us know whether you can join us.');
      return;
    }

    var attending = attendYes.checked;
    var guests = [];

    if (attending) {
      var count = headCount();
      if (count === 0) {
        show(submitError, "Please select at least one guest, or let us know you can't make it.");
        return;
      }
      if (count > invite.max_party_size) {
        show(submitError, capacityMessage(invite.max_party_size));
        return;
      }

      var namelessPlusOne = guestRows.some(function (entry) {
        return (
          entry.checkbox.checked &&
          entry.plusOneWanted &&
          entry.plusOneWanted.checked &&
          !entry.plusOneInput.value.trim()
        );
      });
      if (namelessPlusOne) {
        show(submitError, "Please add your plus one's name so we can put it on their place card.");
        return;
      }

      var missingMeal = guestRows.some(function (entry) {
        if (!entry.checkbox.checked) return false;
        if (entry.meals && !entry.meals.get()) return true;
        var bringing = entry.plusOneWanted && entry.plusOneWanted.checked;
        return !!(bringing && entry.plusOneMeals && !entry.plusOneMeals.get());
      });
      if (missingMeal) {
        show(submitError, 'Please choose a meal for everyone who is coming.');
        return;
      }

      guests = guestRows.map(function (entry) {
        var coming = entry.checkbox.checked;
        var wantsPlusOne = coming && !!(entry.plusOneWanted && entry.plusOneWanted.checked);
        return {
          invite_guest_id: entry.guest.id,
          attending: coming,
          plus_one: wantsPlusOne,
          plus_one_name: wantsPlusOne ? entry.plusOneInput.value.trim() : null,
          dietary_notes: coming && entry.dietaryInput ? entry.dietaryInput.value.trim() : null,
          plus_one_dietary_notes:
            wantsPlusOne && entry.plusOneDietaryInput
              ? entry.plusOneDietaryInput.value.trim()
              : null,
          meals: coming && entry.meals ? entry.meals.get() : null,
          plus_one_meals: wantsPlusOne && entry.plusOneMeals ? entry.plusOneMeals.get() : null,
        };
      });
    }

    sendRsvp(attending, guests);
  });

  function sendRsvp(attending, guests) {
    if (config.preview) {
      // Admin preview: nothing is sent or saved.
      showConfirmation(attending ? 'accepted' : 'declined');
      return;
    }
    submitting = true;
    setBusy(rsvpSubmit, true, 'Sending…', 'Send RSVP');

    var needsToken = !!invite.turnstile_site_key;
    var tokenPromise = needsToken ? replyChallenge.awaitToken() : Promise.resolve(null);

    tokenPromise.then(function (token) {
      if (needsToken && !token) {
        submitting = false;
        setBusy(rsvpSubmit, false, 'Sending…', 'Send RSVP');
        show(
          submitError,
          "We couldn't verify that you're human. Please refresh the page and try again.",
        );
        replyChallenge.reset();
        return;
      }

      postJson(API_SUBMIT, {
        code: inviteCode,
        attending: attending,
        reception_only: attending && scopeEvening.checked,
        guests: guests,
        song_request: attending && features().song_request ? songInput.value.trim() : null,
        message: features().message ? messageInput.value.trim() : null,
        turnstile_token: token,
      })
        .then(function (result) {
          submitting = false;

          if (result.status === 200) {
            showConfirmation(attending ? 'accepted' : 'declined');
            return;
          }

          setBusy(rsvpSubmit, false, 'Sending…', 'Send RSVP');
          replyChallenge.reset();

          if (result.status === 409) {
            showConfirmation('already');
            return;
          }

          show(
            submitError,
            (result.data && result.data.error) || 'Something went wrong. Please try again.',
          );
          refreshSubmitState();
        })
        .catch(function () {
          submitting = false;
          setBusy(rsvpSubmit, false, 'Sending…', 'Send RSVP');
          replyChallenge.reset();
          show(
            submitError,
            "We couldn't reach the server. Please check your connection and try again.",
          );
          refreshSubmitState();
        });
    });
  }

  // ---------------------------------------------------------------------
  // State 3 — confirmation
  // ---------------------------------------------------------------------

  /**
   * @param {'accepted'|'declined'|'already'|'closed'} kind
   * @param {boolean} [acceptedBefore] for 'already': was that reply a yes?
   */
  function showConfirmation(kind, acceptedBefore) {
    var copy = config.copy || {};
    var title;
    var body;
    if (kind === 'accepted') {
      title = copy.accepted_title;
      body = copy.accepted_message;
    } else if (kind === 'declined') {
      title = copy.declined_title;
      body = copy.declined_message;
    } else if (kind === 'closed') {
      title = 'RSVPs have closed';
      body = copy.closed_message;
    } else {
      title = copy.already_title;
      body = copy.already_message;
    }
    doneHeading.textContent = title || 'Thank you';
    doneMessage.textContent = body || '';

    var isCelebration = kind === 'accepted' || (kind === 'already' && acceptedBefore);

    // The burst fires when the thank-you screen is actually revealed.
    goToState(
      stateDone,
      doneHeading.textContent + ' ' + doneMessage.textContent,
      isCelebration ? celebrate : null,
    );
  }

  var cannon = null;

  /**
   * Our own confetti instance on a main-thread canvas. The default worker /
   * OffscreenCanvas path can silently draw nothing, and useWorker is only
   * honoured at create() time.
   */
  function confettiCannon() {
    if (cannon) return cannon;
    if (typeof window.confetti !== 'function' || typeof window.confetti.create !== 'function') {
      return null;
    }

    var canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);

    cannon = window.confetti.create(canvas, { resize: true, useWorker: false });
    return cannon;
  }

  function cssColor(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function celebrate() {
    if (reducedMotion) return;

    var fire = confettiCannon();
    if (!fire) return;

    var burst = function (opts) {
      fire(Object.assign({ disableForReducedMotion: true }, opts));
    };

    if (isEvening()) eveningStars(burst);
    else daytimeConfetti(burst);
  }

  /** Paper confetti in the card's palette — the daytime celebration. */
  function daytimeConfetti(burst) {
    var colors = [
      cssColor('--rose', '#E66C78'),
      cssColor('--rose-deep', '#C6505F'),
      cssColor('--gold', '#D9A441'),
      cssColor('--sage', '#9CAF88'),
      cssColor('--bg', '#FFF8EF'),
    ];

    burst({
      colors: colors,
      particleCount: 130,
      spread: 85,
      origin: { y: 0.6 },
      startVelocity: 44,
      scalar: 1.05,
    });

    setTimeout(function () {
      burst({
        colors: colors,
        particleCount: 75,
        angle: 62,
        spread: 64,
        origin: { x: 0, y: 0.72 },
        startVelocity: 48,
      });
    }, 170);
    setTimeout(function () {
      burst({
        colors: colors,
        particleCount: 75,
        angle: 118,
        spread: 64,
        origin: { x: 1, y: 0.72 },
        startVelocity: 48,
      });
    }, 320);

    drift(
      burst,
      {
        colors: colors,
        particleCount: 4,
        spread: 78,
        startVelocity: 22,
        gravity: 0.5,
        scalar: 0.85,
        ticks: 420,
      },
      5500,
      140,
    );
  }

  /** Stars for evening guests: calmer, slower, gold and candlelight. */
  function eveningStars(burst) {
    var colors = [
      cssColor('--gold', '#E5B65C'),
      '#F5E9C8',
      '#FFFDF9',
      cssColor('--rose', '#F0808C'),
      '#C9A9D1',
    ];
    var shapes = ['star'];

    burst({
      colors: colors,
      shapes: shapes,
      particleCount: 55,
      spread: 110,
      origin: { y: 0.62 },
      startVelocity: 26,
      gravity: 0.32,
      scalar: 1.2,
      ticks: 460,
    });

    setTimeout(function () {
      burst({
        colors: colors,
        shapes: shapes,
        particleCount: 30,
        angle: 70,
        spread: 70,
        origin: { x: 0.08, y: 0.78 },
        startVelocity: 30,
        gravity: 0.32,
        scalar: 1.1,
        ticks: 460,
      });
    }, 260);

    setTimeout(function () {
      burst({
        colors: colors,
        shapes: shapes,
        particleCount: 30,
        angle: 110,
        spread: 70,
        origin: { x: 0.92, y: 0.78 },
        startVelocity: 30,
        gravity: 0.32,
        scalar: 1.1,
        ticks: 460,
      });
    }, 470);

    drift(
      burst,
      {
        colors: colors,
        shapes: shapes,
        particleCount: 2,
        spread: 90,
        startVelocity: 12,
        gravity: 0.24,
        scalar: 1,
        ticks: 620,
      },
      7000,
      200,
    );
  }

  /** Drop particles in from above the viewport, repeatedly, for a while. */
  function drift(burst, options, durationMs, intervalMs) {
    var until = Date.now() + durationMs;

    (function step() {
      burst(Object.assign({ origin: { x: Math.random(), y: -0.12 } }, options));
      if (Date.now() < until) setTimeout(step, intervalMs);
    })();
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Admin preview (only when the server rendered /admin/preview)
  // ---------------------------------------------------------------------

  /** A made-up household that shows every option the couple has turned on. */
  function sampleInvite(eveningGuest) {
    var p = config.preview || {};
    var s = p.settings || {};
    var f = s.features || {};
    var evening = !!(s.evening && s.evening.enabled);
    var menu = (p.menu || []).filter(function (c) {
      return c.options && c.options.length;
    });
    return {
      household_name: 'The Example Family',
      max_party_size: 3,
      reception_only: evening && !!eveningGuest,
      turnstile_site_key: null,
      closed: false,
      already_submitted: false,
      previous_rsvp: null,
      features: {
        evening: evening,
        dietary: !!f.dietary,
        song_request: !!f.song_request,
        message: !!f.message,
        meals: !!f.meals && menu.length > 0,
      },
      menu: menu,
      guests: [
        { id: 'preview-1', name: 'Pat Example', allows_plus_one: false },
        { id: 'preview-2', name: 'Chris Example', allows_plus_one: true },
      ],
    };
  }

  var previewEvening = false;

  /** Re-show the reply form with the latest settings, keeping it interactive. */
  function refreshPreview(newConfig, opts) {
    opts = opts || {};
    if (newConfig) config = newConfig;
    if (opts.evening !== undefined) previewEvening = !!opts.evening;
    if (invite && !opts.rebuild && opts.evening === undefined) {
      // Text-only change: keep whatever the couple has clicked in the preview.
      applyTheme();
      return;
    }
    invite = sampleInvite(previewEvening);
    inviteCode = 'PREVIEW';
    attendYes.checked = false;
    attendNo.checked = false;
    scopeDay.checked = true;
    acceptBranch.hidden = true;
    declineBranch.hidden = true;
    scopeNote.hidden = true;
    buildRsvpForm();
    refreshExtras();
    applyTheme();
    var current = document.querySelector('.state:not([hidden])');
    if (current !== stateRsvp) {
      [stateUnready, stateCode, stateDone].forEach(function (n) {
        n.hidden = true;
      });
      stateRsvp.hidden = false;
    }
  }

  if (config.preview) {
    window.RSVPerCard = {
      config: function () {
        return config;
      },
      refresh: refreshPreview,
    };
  }

  (function init() {
    if (config.preview) {
      refreshPreview(null, { rebuild: true });
      return;
    }
    if (!config.ready) {
      goToState(stateUnready, "This invitation isn't ready yet");
      return;
    }

    var fromUrl = cleanCode(window.location.pathname.replace(/^\/+|\/+$/g, ''));
    var len = config.code_length || { min: 5, max: 8 };

    if (fromUrl.length >= len.min && fromUrl.length <= len.max && CODE_RE.test(fromUrl)) {
      // Personalised link: go straight to the reply, no code entry.
      say('Loading your invitation');
      lookup(fromUrl, { fromForm: false });
      return;
    }

    goToState(stateCode, 'Enter your invite code');
    codeInput.focus({ preventScroll: true });
  })();
})();
