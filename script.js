/* ==========================================================================
   Livotec Water Savings Calculator
   Sections:
     1. Calculation constants        (CONFIG)
     2. Default inputs               (DEFAULTS)
     3. Product data                 (LOCAL_PRODUCTS)  <- edit prices here
     4. Remote data source           (DATA_SOURCE)     <- Google Sheets hook
     5. Calculation engine           (pure, no DOM)
     6. User interface (members, refill price, model, mineral filter)
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     1. CALCULATION CONSTANTS
     ------------------------------------------------------------------------ */
  var CONFIG = {
    litersPerPersonPerDay: 3,
    litersPerGallon: 20,
    // Default lifespans. A product can override any of them (see lifespans below).
    // userPriced: the replacement price comes from the on-screen input, not product data.
    filters: [
      { key: 'prefilter',     label: 'Pre-filter',     lifespanL: 10000, optional: false, userPriced: false },
      { key: 'roMembrane',    label: 'RO membrane',    lifespanL: 30000, optional: false, userPriced: false },
      { key: 'mineralFilter', label: 'Mineral filter', lifespanL: 10000, optional: true,  userPriced: true  }
    ],
    projectionOptions: [5, 10],
    // One-time cost of a regular water dispenser, added to the refill side (Year 1)
    // for models flagged replacesDispenser. Those purifiers dispense water themselves,
    // so a refill household would need to buy a dispenser to compare like for like.
    dispenserCost: 8000
  };

  /* ------------------------------------------------------------------------
     2. DEFAULT INPUTS (used on load and by "Reset calculator")
     ------------------------------------------------------------------------ */
  var DEFAULTS = {
    members: 4,
    daysPerYear: 365,
    refillPrice: 40,
    initialContainers: 3,
    containerPrice: 150,
    productId: 'U05',
    includeMineral: false,
    mineralPrice: '',
    projectionYears: 10
  };

  /* ------------------------------------------------------------------------
     3. PRODUCT DATA
     Order here = order in the model dropdown.
     filtersConfirmed: false shows a "not yet confirmed" notice on screen.
     Only PureLite 10 Hydrogen (U05) filter prices were supplied. The other
     models carry U05 filter prices as PLACEHOLDERS until real prices are set.
     mineralFilter: null means "no default"; the user enters it on screen.
     replacesDispenser: true adds CONFIG.dispenserCost to the refill side in Year 1
     (VitaGlow and FlexTemp series). PureLite series: false.
     ------------------------------------------------------------------------ */
  var LOCAL_PRODUCTS = [
    { id: 'U05', name: 'PureLite 10 Hydrogen', replacesDispenser: false, price: 19990, filtersConfirmed: true,
      filters: { prefilter: 2535, roMembrane: 4140, mineralFilter: null }, lifespans: {} },
    { id: 'purelite-10-smart', name: 'PureLite 10 Smart', replacesDispenser: false, price: 26990, filtersConfirmed: false,
      filters: { prefilter: 2535, roMembrane: 4140, mineralFilter: null }, lifespans: {} },
    { id: 'vitaglow-11', name: 'VitaGlow 11', replacesDispenser: true, price: 27990, filtersConfirmed: false,
      filters: { prefilter: 2535, roMembrane: 4140, mineralFilter: null }, lifespans: {} },
    { id: 'flextemp-10-edge', name: 'FlexTemp 10 Edge', replacesDispenser: true, price: 37990, filtersConfirmed: false,
      filters: { prefilter: 2535, roMembrane: 4140, mineralFilter: null }, lifespans: {} },
    { id: 'flextemp-10-cozy', name: 'FlexTemp 10 Cozy', replacesDispenser: true, price: 38990, filtersConfirmed: false,
      filters: { prefilter: 2535, roMembrane: 4140, mineralFilter: null }, lifespans: {} },
    { id: 'flextemp-10-sense', name: 'FlexTemp 10 Sense', replacesDispenser: true, price: 48990, filtersConfirmed: false,
      filters: { prefilter: 2535, roMembrane: 4140, mineralFilter: null }, lifespans: {} },
    { id: 'vitaglow-11-ultra', name: 'VitaGlow 11 Ultra', replacesDispenser: true, price: 51990, filtersConfirmed: false,
      filters: { prefilter: 2535, roMembrane: 4140, mineralFilter: null }, lifespans: {} }
  ];

  /* ------------------------------------------------------------------------
     4. REMOTE DATA SOURCE (Google Sheets -> Apps Script -> here)
     Paste the Apps Script web app URL (ends in /exec). While empty, or if the
     request fails / the device is offline, LOCAL_PRODUCTS is used.
     Expected JSON: { "products": [ { id, name, price, prefilter, roMembrane,
       mineralFilter, prefilterLifespanL, roMembraneLifespanL,
       mineralFilterLifespanL, filtersConfirmed, replacesDispenser, active } ] }
     ------------------------------------------------------------------------ */
  var DATA_SOURCE = {
    productsUrl: '',
    timeoutMs: 5000
  };

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(String(value).replace(/[₱,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function isTrue(value) {
    return value === true || String(value).trim().toUpperCase() === 'TRUE';
  }

  // Converts flat spreadsheet rows into the internal product shape and drops bad rows.
  function normalizeProducts(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(function (r) { return r && !(r.active === false || String(r.active).trim().toUpperCase() === 'FALSE'); })
      .map(function (r) {
        return {
          id: String(r.id || '').trim(),
          name: String(r.name || '').trim(),
          price: toNumber(r.price),
          filtersConfirmed: isTrue(r.filtersConfirmed),
          replacesDispenser: isTrue(r.replacesDispenser),
          filters: {
            prefilter: toNumber(r.prefilter),
            roMembrane: toNumber(r.roMembrane),
            mineralFilter: toNumber(r.mineralFilter)
          },
          lifespans: {
            prefilter: toNumber(r.prefilterLifespanL),
            roMembrane: toNumber(r.roMembraneLifespanL),
            mineralFilter: toNumber(r.mineralFilterLifespanL)
          }
        };
      })
      .filter(function (p) {
        return p.id && p.name && p.price > 0 &&
          p.filters.prefilter !== null && p.filters.prefilter >= 0 &&
          p.filters.roMembrane !== null && p.filters.roMembrane >= 0;
      });
  }

  function loadRemoteProducts() {
    if (!DATA_SOURCE.productsUrl || typeof fetch !== 'function') return Promise.resolve(null);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, DATA_SOURCE.timeoutMs);
    return fetch(DATA_SOURCE.productsUrl, { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) {
        var list = normalizeProducts(data && data.products);
        return list.length ? list : null;
      })
      .catch(function (err) {
        console.warn('Livotec calculator: using local product data.', err);
        return null;
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* ------------------------------------------------------------------------
     5. CALCULATION ENGINE (pure functions, no DOM access)
     ------------------------------------------------------------------------ */

  // How many lifespan thresholds are crossed between two cumulative volumes.
  // A threshold reached exactly at year end is charged in that year.
  // Handles high-use homes that cross the same threshold more than once a year.
  function replacementsBetween(litersBefore, litersAfter, lifespanL) {
    var EPS = 1e-9;
    return Math.floor(litersAfter / lifespanL + EPS) - Math.floor(litersBefore / lifespanL + EPS);
  }

  function positiveOr(value, fallback) {
    return (typeof value === 'number' && value > 0) ? value : fallback;
  }

  /**
   * @param {object} inputs  validated: members, daysPerYear, refillPrice, initialContainers,
   *                         containerPrice, includeMineral, mineralPrice, projectionYears
   * @param {object} product one entry of the product list
   * @param {object} config  CONFIG
   */
  function calculateProjection(inputs, product, config) {
    var dailyLiters = inputs.members * config.litersPerPersonPerDay;
    var annualLiters = dailyLiters * inputs.daysPerYear;
    var annualGallons = annualLiters / config.litersPerGallon;
    // Rounded per year so every table row reconciles to the peso.
    var annualRefillCost = Math.round(annualGallons * inputs.refillPrice);
    var containerCost = Math.round(inputs.initialContainers * inputs.containerPrice);
    var dispenserCost = product.replacesDispenser ? Math.round(config.dispenserCost || 0) : 0;
    var oneTimeRefillCost = containerCost + dispenserCost;

    // The first set of filters ships with the purifier; only replacements are charged.
    var activeFilters = config.filters
      .filter(function (f) { return !f.optional || inputs.includeMineral; })
      .map(function (f) {
        var lifespanL = positiveOr(product.lifespans && product.lifespans[f.key], f.lifespanL);
        return {
          key: f.key,
          label: f.label,
          lifespanL: lifespanL,
          price: f.userPriced ? inputs.mineralPrice : (product.filters[f.key] || 0),
          yearsPerReplacement: annualLiters > 0 ? lifespanL / annualLiters : Infinity
        };
      });

    var rows = [];
    var cumulative = 0;
    var totals = { traditional: 0, livotec: 0, savings: 0 };

    for (var year = 1; year <= inputs.projectionYears; year++) {
      var litersBefore = annualLiters * (year - 1);
      var litersAfter = annualLiters * year;
      var replacements = [];
      var filterCost = 0;

      activeFilters.forEach(function (f) {
        var count = replacementsBetween(litersBefore, litersAfter, f.lifespanL);
        if (count > 0) {
          replacements.push({ key: f.key, label: f.label, count: count, cost: count * f.price });
          filterCost += count * f.price;
        }
      });

      // Year 1 refill side: containers + dispenser (if applicable) + refills.
      var traditional = annualRefillCost + (year === 1 ? oneTimeRefillCost : 0);
      var livotec = (year === 1 ? product.price : 0) + filterCost;
      var savings = traditional - livotec;
      cumulative += savings;

      totals.traditional += traditional;
      totals.livotec += livotec;
      totals.savings += savings;

      rows.push({
        year: year,
        litersToDate: litersAfter,
        traditional: traditional,
        livotec: livotec,
        savings: savings,
        cumulative: cumulative,
        replacements: replacements
      });
    }

    // Break-even: first year from which cumulative savings stay >= 0 to the end of the
    // projection. This avoids reporting a year if a later filter cost pushes it negative again.
    var breakEvenYear = null;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].cumulative >= 0) breakEvenYear = rows[i].year;
      else break;
    }

    return {
      dailyLiters: dailyLiters,
      annualLiters: annualLiters,
      annualGallons: annualGallons,
      annualRefillCost: annualRefillCost,
      containerCost: containerCost,
      dispenserCost: dispenserCost,
      activeFilters: activeFilters,
      rows: rows,
      totals: totals,
      breakEvenYear: breakEvenYear
    };
  }

  // Validation rules. "when" limits a rule to a state (e.g. mineral filter switched on).
  var FIELD_RULES = {
    members:           { min: 1, max: 50,     integer: true,  message: 'Enter 1 to 50 people.' },
    refillPrice:       { min: 1, max: 10000,  integer: false, message: 'Enter a price from ₱1 to ₱10,000.' },
    daysPerYear:       { min: 1, max: 366,    integer: true,  message: 'Enter a whole number from 1 to 366.' },
    initialContainers: { min: 0, max: 100,    integer: true,  message: 'Enter a whole number from 0 to 100.' },
    containerPrice:    { min: 0, max: 100000, integer: false, message: 'Enter ₱0 or more.' },
    mineralPrice:      { min: 1, max: 100000, integer: false, message: 'Enter the mineral filter price.',
                         when: function (s) { return s.includeMineral; } }
  };

  function validateValue(raw, rule) {
    var text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (text === '') return { ok: false, value: null };
    var n = Number(text);
    var ok = Number.isFinite(n) && n >= rule.min && n <= rule.max && (!rule.integer || Number.isInteger(n));
    return { ok: ok, value: ok ? n : null };
  }

  // Expose the engine for automated tests (Node) without touching the browser global scope.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CONFIG: CONFIG, DEFAULTS: DEFAULTS, LOCAL_PRODUCTS: LOCAL_PRODUCTS, FIELD_RULES: FIELD_RULES,
      calculateProjection: calculateProjection, replacementsBetween: replacementsBetween,
      normalizeProducts: normalizeProducts, validateValue: validateValue
    };
  }
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------------------------------
     6. USER INTERFACE
     Visible inputs: family members, refill price, model, mineral filter.
     Days per year, containers and projection length come from DEFAULTS.
     ------------------------------------------------------------------------ */
  var VISIBLE_FIELDS = ['members', 'refillPrice', 'mineralPrice'];
  var numberFmt = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 });

  function peso(v) {
    var r = Math.round(v);
    return (r < 0 ? '−' : '') + '₱' + numberFmt.format(Math.abs(r));
  }

  function init() {
    var $ = function (id) { return document.getElementById(id); };
    var form = $('calculator');
    var els = {
      members: $('members'), refillPrice: $('refillPrice'), product: $('product'),
      includeMineral: $('includeMineral'), mineralPrice: $('mineralPrice'), mineralField: $('mineralField'),
      modelNotice: $('modelNotice'), dispenserNote: $('dispenserNote'), result: $('result'), resultLabel: $('resultLabel'), resultStale: $('resultStale'),
      outSavings: $('outSavings'), outPeriod: $('outPeriod'), outBreakEven: $('outBreakEven'),
      outConsumption: $('outConsumption'), yearTrack: $('yearTrack'), liveRegion: $('liveRegion')
    };
    var products = LOCAL_PRODUCTS.slice();
    var touched = {};
    var lastResult = null;                          // latest valid calculation
    var selectedYear = DEFAULTS.projectionYears;    // year centered in the scroller
    var announceTimer = null;
    var scrollFrame = 0;

    function getProduct(id) {
      for (var i = 0; i < products.length; i++) if (products[i].id === id) return products[i];
      return products[0];
    }

    function populateProducts(selectedId) {
      els.product.innerHTML = '';
      products.forEach(function (p) {
        els.product.appendChild(new Option(p.name, p.id));
      });
      els.product.value = getProduct(selectedId).id;
    }

    function applyDefaults() {
      els.members.value = DEFAULTS.members;
      els.refillPrice.value = DEFAULTS.refillPrice;
      els.product.value = getProduct(DEFAULTS.productId).id;
      els.includeMineral.checked = DEFAULTS.includeMineral;
      els.mineralPrice.value = DEFAULTS.mineralPrice;
    }

    function readState() {
      var state = {
        daysPerYear: DEFAULTS.daysPerYear,
        initialContainers: DEFAULTS.initialContainers,
        containerPrice: DEFAULTS.containerPrice,
        projectionYears: DEFAULTS.projectionYears,
        productId: els.product.value,
        includeMineral: els.includeMineral.checked
      };
      var errors = {};
      VISIBLE_FIELDS.forEach(function (key) {
        var rule = FIELD_RULES[key];
        if (rule.when && !rule.when(state)) { state[key] = 0; return; }
        var check = validateValue(els[key].value, rule);
        if (check.ok) state[key] = check.value; else errors[key] = rule.message;
      });
      return { state: state, errors: errors };
    }

    function showErrors(errors) {
      VISIBLE_FIELDS.forEach(function (key) {
        var input = els[key];
        var visible = errors[key] && (touched[key] || input.value.trim() !== '' || input.validity.badInput);
        input.setAttribute('aria-invalid', errors[key] ? 'true' : 'false');
        $(key + '-error').textContent = visible ? errors[key] : '';
      });
    }

    /* ---- Year scroller ---- */
    function yearsText(n) { return n === 1 ? '1 year' : n + ' years'; }

    function buildChips(count) {
      if (els.yearTrack.children.length === count) return;
      els.yearTrack.innerHTML = '';
      for (var y = 1; y <= count; y++) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'year-chip';
        chip.setAttribute('data-year', y);
        chip.innerHTML = '<span class="year-chip__year">Year ' + y + '</span><span class="year-chip__amt">—</span>';
        els.yearTrack.appendChild(chip);
      }
    }

    // Shows cumulative savings as of the given year in the result card.
    function showYear(year) {
      if (!lastResult) return;
      var rows = lastResult.rows;
      year = Math.min(rows.length, Math.max(1, year));
      selectedYear = year;
      var cum = rows[year - 1].cumulative;
      var recovered = Math.round(cum) >= 0;

      els.resultLabel.textContent = recovered ? 'Your potential savings' : 'Still to recover';
      els.outSavings.textContent = peso(Math.abs(cum));
      els.outPeriod.textContent = 'after ' + yearsText(year);

      Array.prototype.forEach.call(els.yearTrack.children, function (chip) {
        var active = Number(chip.getAttribute('data-year')) === year;
        chip.classList.toggle('is-active', active);
        if (active) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
      });

      // Announce once scrolling settles, not on every frame.
      clearTimeout(announceTimer);
      announceTimer = setTimeout(function () {
        els.liveRegion.textContent = (recovered ? 'Potential savings ' : 'Still to recover ') + peso(Math.abs(cum)) + ' after ' + yearsText(year);
      }, 450);
    }

    function nearestYear() {
      var track = els.yearTrack;
      var center = track.getBoundingClientRect().left + track.clientWidth / 2;
      var best = selectedYear, bestDist = Infinity;
      Array.prototype.forEach.call(track.children, function (chip) {
        var r = chip.getBoundingClientRect();
        var d = Math.abs(r.left + r.width / 2 - center);
        if (d < bestDist) { bestDist = d; best = Number(chip.getAttribute('data-year')); }
      });
      return best;
    }

    function scrollToYear(year, instant) {
      var chip = els.yearTrack.children[year - 1];
      if (!chip) return;
      var track = els.yearTrack;
      var target = chip.offsetLeft - track.offsetLeft - (track.clientWidth - chip.offsetWidth) / 2;
      if (instant) {
        track.style.scrollBehavior = 'auto';
        track.scrollLeft = target;
        track.style.scrollBehavior = '';
      } else {
        track.scrollTo({ left: target, behavior: 'smooth' });
      }
    }

    function render(result, state) {
      var n = state.projectionYears;
      lastResult = result;
      buildChips(result.rows.length);

      els.outBreakEven.textContent = result.breakEvenYear ? 'Year ' + result.breakEvenYear : 'Not within ' + n + ' years';
      els.outConsumption.textContent = numberFmt.format(result.annualLiters) + ' L';

      result.rows.forEach(function (r, i) {
        var chip = els.yearTrack.children[i];
        var amt = chip.lastChild;
        amt.textContent = peso(r.cumulative);
        amt.classList.toggle('is-neg', Math.round(r.cumulative) < 0);
        chip.classList.toggle('is-breakeven', r.year === result.breakEvenYear);
        chip.setAttribute('aria-label', 'Year ' + r.year + ', total savings ' + peso(r.cumulative) +
          (r.year === result.breakEvenYear ? ', break-even year' : ''));
      });

      showYear(selectedYear);
    }

    function update() {
      var read = readState();
      var product = getProduct(read.state.productId);
      els.mineralField.hidden = !read.state.includeMineral;
      els.modelNotice.hidden = product.filtersConfirmed;
      els.dispenserNote.hidden = !product.replacesDispenser;
      els.dispenserNote.textContent = 'Refill cost includes a ' + peso(CONFIG.dispenserCost) + ' water dispenser, since this model dispenses water.';
      showErrors(read.errors);

      var valid = Object.keys(read.errors).length === 0;
      els.result.classList.toggle('is-stale', !valid);
      els.resultStale.hidden = valid;
      if (valid) render(calculateProjection(read.state, product, CONFIG), read.state);
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('input', update);
    form.addEventListener('change', function (e) {
      if (e.target === els.includeMineral && els.includeMineral.checked && els.mineralPrice.value.trim() === '') {
        var preset = getProduct(els.product.value).filters.mineralFilter;
        if (preset > 0) els.mineralPrice.value = preset;
      }
      update();
    });
    form.addEventListener('focusout', function (e) {
      if (VISIBLE_FIELDS.indexOf(e.target.id) > -1) { touched[e.target.id] = true; update(); }
    });
    form.querySelectorAll('.stepper__btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rule = FIELD_RULES.members;
        var current = Number(els.members.value);
        var base = els.members.value.trim() !== '' && Number.isFinite(current) ? Math.round(current) : DEFAULTS.members;
        els.members.value = Math.min(rule.max, Math.max(rule.min, base + Number(btn.getAttribute('data-step'))));
        update();
      });
    });

    // Recalculate the headline on every scroll frame while swiping left or right.
    els.yearTrack.addEventListener('scroll', function () {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(function () {
        var year = nearestYear();
        if (year !== selectedYear) showYear(year);
      });
    }, { passive: true });

    els.yearTrack.addEventListener('click', function (e) {
      var chip = e.target.closest('.year-chip');
      if (chip) scrollToYear(Number(chip.getAttribute('data-year')));
    });

    els.yearTrack.addEventListener('keydown', function (e) {
      if (!lastResult) return;
      var map = { ArrowLeft: -1, ArrowRight: 1 };
      var next = null;
      if (map[e.key]) next = selectedYear + map[e.key];
      else if (e.key === 'Home') next = 1;
      else if (e.key === 'End') next = lastResult.rows.length;
      if (next === null) return;
      e.preventDefault();
      next = Math.min(lastResult.rows.length, Math.max(1, next));
      showYear(next);
      scrollToYear(next);
    });

    // Keep the selected year centered if the card width changes (rotation, resize).
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { scrollToYear(selectedYear, true); }).observe(els.yearTrack);
    }

    populateProducts(DEFAULTS.productId);
    applyDefaults();
    update();
    // Start on the final year (full projection), centered.
    requestAnimationFrame(function () { scrollToYear(selectedYear, true); });

    loadRemoteProducts().then(function (list) {
      if (!list) return;
      var current = els.product.value;
      products = list;
      populateProducts(current);
      update();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
