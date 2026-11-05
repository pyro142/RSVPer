/* RSVPer admin — colour picker.
 *
 * A wedding stores two colours: background and brand. Premade themes are
 * shortcuts that set both; only the two hex values are saved, never a theme
 * name, so this list can change without affecting anyone's site.
 *
 * Every tap updates the screen first (opts.onChange, used by the live
 * preview) and then saves in the background, sending only the colour that
 * changed so the other is never overwritten.
 */
(function () {
  'use strict';

  var R = window.RSVPer;
  var el = R.el;

  // [name, background, brand]
  var THEMES = {
    Light: [
      ['Blush & linen', '#FFF8EF', '#E66C78'],
      ['Sage garden', '#F7F7F2', '#5F7A55'],
      ['Coastal blue', '#F8FAFC', '#2B6CB0'],
      ['Terracotta', '#FAF7F2', '#B5503A'],
      ['Lavender', '#FAF8FC', '#7C5CBF'],
      ['Golden hour', '#FFFDF7', '#B7791F'],
      ['Classic ink', '#FFFFFF', '#1F2D3A'],
    ],
    Dark: [
      ['Midnight rose', '#1A1418', '#F0808C'],
      ['Navy & gold', '#0F1B2D', '#E0A526'],
      ['Forest', '#121A15', '#8FBF7A'],
      ['Charcoal & coral', '#1C1C1E', '#FF7A59'],
      ['Slate & sky', '#1E293B', '#38BDF8'],
      ['Noir & champagne', '#0A0A0A', '#D8C3A5'],
      ['Plum', '#21142A', '#C9A9D1'],
    ],
  };

  var BACKGROUNDS = {
    Light: ['#FFFFFF', '#FAFAF9', '#F8FAFC', '#F5F5F4', '#F3F4F6', '#FAF7F2', '#F7F3E8'],
    Dark: ['#0A0A0A', '#171717', '#1C1C1E', '#262626', '#111827', '#0F1B2D', '#1E293B'],
  };

  var BRANDS = [
    ['#1F2D3A', '#177AED', '#1B6068', '#2E6238', '#7A5227', '#B06A10', '#8C1518'],
    ['#1A1A1C', '#DC2626', '#EA580C', '#E0A526', '#84CC16', '#0EA5E9', '#7C3AED'],
  ];

  // RSVPer's own colours, used when a colour isn't set.
  var TEMPLATE = { background: '#FFF8EF', brand: '#E66C78' };

  var HEX = /^#[0-9a-fA-F]{6}$/;

  function valid(hex) {
    return typeof hex === 'string' && HEX.test(hex) ? hex.toUpperCase() : null;
  }

  function same(a, b) {
    return !!a && !!b && a.toUpperCase() === b.toUpperCase();
  }

  // --- OKLab distance (for the low-contrast hint only) -----------------------
  function lin(c) {
    var v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function oklab(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = lin((n >> 16) & 255);
    var g = lin((n >> 8) & 255);
    var b = lin(n & 255);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }
  function distance(a, b) {
    var x = oklab(a);
    var y = oklab(b);
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  }

  function swatchButton(label, background, cls) {
    var b = el('button', 'swatch ' + (cls || ''));
    b.type = 'button';
    b.style.background = background;
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  }

  /**
   * Render the picker. opts.value = { background, brand } (either may be
   * null); opts.onChange(colours) fires on every change, before saving.
   */
  function renderColours(container, opts) {
    opts = opts || {};
    var state = {
      background: valid(opts.value && opts.value.background),
      brand: valid(opts.value && opts.value.brand),
      font: (opts.value && opts.value.font) || 'classic',
    };
    var fontPairs = opts.fontPairs || [];

    var root = el('div', 'colours');
    if (!opts.hideTitle) root.appendChild(el('h2', 'section-title', 'Colours and fonts'));
    root.appendChild(
      el(
        'p',
        'section-help',
        'Pick a theme with one tap, or choose your own background and brand colour. Text, buttons and lines adjust automatically so everything stays readable.',
      ),
    );

    // 1. Themes ------------------------------------------------------------
    var themeButtons = [];
    var themes = el('section', 'colour-block');
    themes.appendChild(el('h3', 'colour-heading', 'Colour themes'));
    Object.keys(THEMES).forEach(function (group) {
      themes.appendChild(el('p', 'swatch-label', group));
      var row = el('div', 'swatch-row');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', group + ' themes');
      THEMES[group].forEach(function (t) {
        var b = swatchButton(
          t[0],
          'linear-gradient(135deg, ' + t[1] + ' 50%, ' + t[2] + ' 50%)',
          'swatch-theme',
        );
        b.addEventListener('click', function () {
          set({ background: t[1], brand: t[2] });
        });
        themeButtons.push({ button: b, background: t[1], brand: t[2] });
        row.appendChild(b);
      });
      themes.appendChild(row);
    });
    root.appendChild(themes);

    // 2. Background --------------------------------------------------------
    var bgBlock = el('section', 'colour-block');
    bgBlock.appendChild(el('h3', 'colour-heading', 'Background colour'));
    var bgPicker = picker('Background colour');
    bgBlock.appendChild(bgPicker.node);
    var bgSwatches = [];
    Object.keys(BACKGROUNDS).forEach(function (group) {
      bgBlock.appendChild(el('p', 'swatch-label', group));
      var row = el('div', 'swatch-row');
      BACKGROUNDS[group].forEach(function (hex) {
        var b = swatchButton(group + ' background ' + hex, hex);
        b.addEventListener('click', function () {
          set({ background: hex });
        });
        bgSwatches.push({ button: b, hex: hex });
        row.appendChild(b);
      });
      bgBlock.appendChild(row);
    });
    var reset = el('button', 'btn btn-ghost btn-small', 'Reset to the default background');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      set({ background: '' });
    });
    bgBlock.appendChild(reset);
    root.appendChild(bgBlock);

    // 3. Brand ---------------------------------------------------------------
    var brandBlock = el('section', 'colour-block');
    brandBlock.appendChild(el('h3', 'colour-heading', 'Brand colour'));
    var brandPicker = picker('Brand colour');
    brandBlock.appendChild(brandPicker.node);
    var brandSwatches = [];
    BRANDS.forEach(function (rowColours) {
      var row = el('div', 'swatch-row');
      rowColours.forEach(function (hex) {
        var b = swatchButton('Brand colour ' + hex, hex);
        b.addEventListener('click', function () {
          set({ brand: hex });
        });
        brandSwatches.push({ button: b, hex: hex });
        row.appendChild(b);
      });
      brandBlock.appendChild(row);
    });
    var hint = el('p', 'field-hint');
    hint.setAttribute('aria-live', 'polite');
    brandBlock.appendChild(hint);
    root.appendChild(brandBlock);

    // 4. Fonts ---------------------------------------------------------------
    var fontButtons = [];
    if (fontPairs.length) {
      var fontBlock = el('section', 'colour-block');
      fontBlock.appendChild(el('h3', 'colour-heading', 'Fonts'));
      var grid = el('div', 'font-grid');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Font pairings');
      fontPairs.forEach(function (pair) {
        var b = el('button', 'font-card');
        b.type = 'button';
        b.setAttribute('aria-label', pair.label + ' fonts: ' + pair.heading + ' and ' + pair.body);
        var heading = el('span', 'font-sample-heading', 'Alex & Sam');
        heading.style.fontFamily = "'" + pair.heading + "', serif";
        var body = el('span', 'font-sample-body', 'We’d love you to join us');
        body.style.fontFamily = "'" + pair.body + "', sans-serif";
        b.appendChild(heading);
        b.appendChild(body);
        b.appendChild(el('span', 'font-name', pair.label));
        b.addEventListener('click', function () {
          set({ font: pair.id });
        });
        fontButtons.push({ button: b, id: pair.id });
        grid.appendChild(b);
      });
      fontBlock.appendChild(grid);
      root.appendChild(fontBlock);
    }

    var status = el('p', 'field-hint colour-status');
    status.setAttribute('aria-live', 'polite');
    root.appendChild(status);

    container.appendChild(root);

    function picker(label) {
      var wrap = el('div', 'colour-picker');
      var input = document.createElement('input');
      input.type = 'color';
      input.setAttribute('aria-label', label);
      var text = document.createElement('input');
      text.type = 'text';
      text.maxLength = 7;
      text.spellcheck = false;
      text.setAttribute('aria-label', label + ' (hex)');
      wrap.appendChild(input);
      wrap.appendChild(text);
      return { node: wrap, input: input, text: text };
    }

    bgPicker.input.addEventListener('input', function () {
      set({ background: bgPicker.input.value }, { debounce: true });
    });
    brandPicker.input.addEventListener('input', function () {
      set({ brand: brandPicker.input.value }, { debounce: true });
    });
    bgPicker.text.addEventListener('change', function () {
      if (valid(bgPicker.text.value)) set({ background: bgPicker.text.value });
      else paint();
    });
    brandPicker.text.addEventListener('change', function () {
      if (valid(brandPicker.text.value)) set({ brand: brandPicker.text.value });
      else paint();
    });

    function paint() {
      var bg = state.background || TEMPLATE.background;
      var brand = state.brand || TEMPLATE.brand;
      bgPicker.input.value = bg.toLowerCase();
      bgPicker.text.value = state.background || '';
      bgPicker.text.placeholder = TEMPLATE.background + ' (default)';
      brandPicker.input.value = brand.toLowerCase();
      brandPicker.text.value = state.brand || '';
      brandPicker.text.placeholder = TEMPLATE.brand + ' (default)';
      reset.hidden = !state.background;

      fontButtons.forEach(function (f) {
        var on = f.id === state.font;
        f.button.classList.toggle('selected', on);
        f.button.setAttribute('aria-pressed', String(on));
      });
      themeButtons.forEach(function (t) {
        var on = same(t.background, state.background) && same(t.brand, state.brand);
        t.button.classList.toggle('selected', on);
        t.button.setAttribute('aria-pressed', String(on));
      });
      bgSwatches.forEach(function (s) {
        var on = same(s.hex, state.background);
        s.button.classList.toggle('selected', on);
        s.button.setAttribute('aria-pressed', String(on));
      });
      brandSwatches.forEach(function (s) {
        var on = same(s.hex, state.brand);
        s.button.classList.toggle('selected', on);
        s.button.setAttribute('aria-pressed', String(on));
      });

      var low = distance(brand, bg) < 0.2;
      hint.textContent = low
        ? 'This colour is hard to see on your background, so buttons may not stand out.'
        : 'Buttons and highlights pick this up across the whole site.';
      hint.classList.toggle('field-warning', low);
    }

    // Save only what changed, so the other colour is never overwritten.
    var pendingSave = {};
    var saveTimer = null;
    function save() {
      var body = pendingSave;
      pendingSave = {};
      status.textContent = 'Saving…';
      R.api('/settings/theme', { method: 'PUT', json: body })
        .then(function (result) {
          status.textContent = 'Saved';
          if (opts.onSaved) opts.onSaved(result.value);
        })
        .catch(function (err) {
          status.textContent = 'Couldn’t save: ' + err.message;
        });
    }

    function set(change, setOpts) {
      if (change.background !== undefined) {
        state.background = change.background === '' ? null : valid(change.background);
        pendingSave.background = change.background === '' ? '' : state.background;
      }
      if (change.font !== undefined) {
        state.font = change.font;
        pendingSave.font = change.font;
      }
      if (change.brand !== undefined) {
        state.brand = change.brand === '' ? null : valid(change.brand);
        pendingSave.brand = change.brand === '' ? '' : state.brand;
      }
      paint();
      applyToPage(state);
      if (opts.onChange) {
        opts.onChange({ background: state.background, brand: state.brand, font: state.font });
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, setOpts && setOpts.debounce ? 500 : 0);
    }

    paint();
    return root;
  }

  /** Show the colours on this admin page straight away (server derives the CSS). */
  var pageRequest = 0;
  function applyToPage(colours) {
    // A chosen background decides light/dark; hide the admin's own toggle.
    if (colours.background) document.documentElement.setAttribute('data-fixed-theme', '');
    else document.documentElement.removeAttribute('data-fixed-theme');
    var params = new URLSearchParams();
    if (colours.background) params.set('background', colours.background);
    if (colours.brand) params.set('brand', colours.brand);
    if (colours.font) params.set('font', colours.font);
    var id = ++pageRequest;
    // v= gives a fresh address, skipping any copy cached by an older version.
    params.set('v', '2');
    fetch('/admin/theme.css?' + params.toString(), {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(function (res) {
        return res.ok ? res.text() : null;
      })
      .then(function (css) {
        if (css === null || id !== pageRequest) return;
        var style = document.getElementById('rsvper-theme');
        if (!style) {
          style = document.createElement('style');
          style.id = 'rsvper-theme';
          document.head.appendChild(style);
        }
        style.textContent = css;
      })
      .catch(function () {
        /* cosmetic only */
      });
  }

  R.renderColours = renderColours;
  R.COLOUR_THEMES = THEMES;
})();
