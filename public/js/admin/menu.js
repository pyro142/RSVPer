/* RSVPer admin — menu editor for meal choices.
 *
 * Courses (e.g. Starter, Main, Dessert), each with options. Most weddings only
 * need one course ("Main"). Removing an option that guests already chose
 * retires it rather than deleting it, so existing replies keep their meal.
 */
(function () {
  'use strict';

  var R = window.RSVPer;
  var el = R.el;

  function textInput(value, placeholder, max, label) {
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.placeholder = placeholder;
    input.maxLength = max;
    input.setAttribute('aria-label', label);
    return input;
  }

  function renderMenuEditor(container, opts) {
    opts = opts || {};
    var root = el('div', 'menu-editor');
    root.appendChild(el('h2', 'section-title', 'Menu'));
    root.appendChild(
      el(
        'p',
        'section-help',
        'Used when “Meal choices” is on in Optional questions. Each attending guest, including plus ones, picks one option per course. Most weddings need just one course.',
      ),
    );
    var list = el('div', 'menu-courses');
    root.appendChild(list);

    var addCourse = el('button', 'btn btn-ghost btn-small', '+ Add course');
    addCourse.type = 'button';
    root.appendChild(addCourse);

    var error = el('p', 'dialog-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    root.appendChild(error);

    var actions = el('div', 'form-actions');
    var save = el('button', 'btn btn-primary', 'Save menu');
    save.type = 'button';
    actions.appendChild(save);
    root.appendChild(actions);
    container.appendChild(root);

    var usage = {};

    function optionRow(optionsBox, option) {
      var row = el('div', 'menu-option');
      row.dataset.id = (option && option.id) || '';
      var name = textInput(option && option.name, 'e.g. Roast chicken', 100, 'Option name');
      var desc = textInput(
        option && option.description,
        'Short description (optional)',
        200,
        'Option description',
      );
      var remove = el('button', 'remove-guest', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove option');
      remove.addEventListener('click', function () {
        row.remove();
      });
      row.appendChild(name);
      row.appendChild(desc);
      if (option && usage[option.id]) {
        row.appendChild(el('span', 'menu-usage', usage[option.id] + ' chosen'));
      }
      row.appendChild(remove);
      optionsBox.appendChild(row);
      return row;
    }

    function courseBlock(course) {
      var block = el('fieldset', 'menu-course');
      block.dataset.id = (course && course.id) || '';
      var head = el('div', 'menu-course-head');
      var name = textInput(course ? course.name : 'Main', 'Course name', 60, 'Course name');
      name.className = 'menu-course-name';
      var remove = el('button', 'btn btn-ghost btn-small', 'Remove course');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        block.remove();
      });
      head.appendChild(name);
      head.appendChild(remove);
      block.appendChild(head);

      var optionsBox = el('div', 'menu-options');
      block.appendChild(optionsBox);
      ((course && course.options) || [null]).forEach(function (o) {
        optionRow(optionsBox, o);
      });

      var addOption = el('button', 'btn btn-ghost btn-small', '+ Add option');
      addOption.type = 'button';
      addOption.addEventListener('click', function () {
        optionRow(optionsBox, null).querySelector('input').focus();
      });
      block.appendChild(addOption);
      list.appendChild(block);
    }

    function collect() {
      return {
        courses: [].map.call(list.querySelectorAll('.menu-course'), function (block) {
          return {
            id: block.dataset.id || null,
            name: block.querySelector('.menu-course-name').value.trim(),
            options: [].map
              .call(block.querySelectorAll('.menu-option'), function (row) {
                var inputs = row.querySelectorAll('input');
                return {
                  id: row.dataset.id || null,
                  name: inputs[0].value.trim(),
                  description: inputs[1].value.trim() || null,
                };
              })
              .filter(function (o) {
                return o.name;
              }),
          };
        }),
      };
    }

    // Live updates for the setup wizard's preview: report the menu as typed.
    var draftId = 0;
    function draftMenu() {
      return collect()
        .courses.filter(function (c) {
          return c.name && c.options.length;
        })
        .map(function (c) {
          return {
            id: c.id || 'draft-' + ++draftId,
            name: c.name,
            options: c.options.map(function (o) {
              return { id: o.id || 'draft-' + ++draftId, name: o.name, description: o.description };
            }),
          };
        });
    }
    function changed() {
      if (opts.onChange) opts.onChange(draftMenu());
    }
    root.addEventListener('input', changed);
    root.addEventListener('click', function (event) {
      if (event.target.closest('button')) setTimeout(changed, 0);
    });

    function load(courses) {
      list.textContent = '';
      courses.forEach(courseBlock);
    }

    addCourse.addEventListener('click', function () {
      courseBlock({ id: null, name: '', options: [] });
      var names = list.querySelectorAll('.menu-course-name');
      names[names.length - 1].focus();
    });

    save.addEventListener('click', function () {
      error.hidden = true;
      save.disabled = true;
      R.api('/menu', { method: 'PUT', json: collect() })
        .then(function (result) {
          load(result.courses);
          R.notify('Menu saved');
          R.refreshSession();
        })
        .catch(function (err) {
          error.hidden = false;
          error.textContent = err.message;
        })
        .then(function () {
          save.disabled = false;
        });
    });

    R.api('/menu')
      .then(function (data) {
        usage = data.usage || {};
        load(data.courses.length ? data.courses : []);
        if (!data.courses.length) courseBlock(null);
        changed();
      })
      .catch(function (err) {
        error.hidden = false;
        error.textContent = 'Could not load the menu: ' + err.message;
      });

    return root;
  }

  R.renderMenuEditor = renderMenuEditor;
})();
