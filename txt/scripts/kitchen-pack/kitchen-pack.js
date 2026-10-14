/* Kitchen Pack — recipe and grocery helpers for Cade.txt.
   Script-pack module: one file registering 3 palette scripts.

   - Scale Recipe…  asks for a factor ("2", "0.5", "x1.5", "1/2", "half") or
     servings ("4 to 6", or just "6" when the recipe says "Serves 4") and
     scales every quantity in the selection, or the whole note: integers,
     decimals, fractions (1/2, ¾), mixed numbers (1 1/2, 1-1/2), ranges
     (2-3, 2–3, 2 to 3), quantities with units (200g, 1.5 cups, 2 tbsp, 1 lb),
     counts ("x2 eggs", "2 large eggs", "1 onion") and "a cup" / "a pinch".
     Results are kitchen-friendly: cups / tbsp / tsp to the nearest 1/8 or 1/3
     as fractions (switching unit when that reads better: 1/8 cup → 2 tbsp,
     6 tsp → 2 tbsp), grams / ml rounded by size (and to kg / l past 1000),
     oz ↔ lb, whole eggs with a "(~1.5)" note when the exact amount isn't
     whole, servings / yields as whole numbers. Left alone: step numbers
     ("1.", "Step 2"), temperatures (350°F, 180 °C, "oven to 350"), times
     (10 minutes, 1-2 hrs), years, sizes (9x13, 8-inch, 2 cm), percentages,
     package sizes ("1 (14 oz) can", "2 x 400g tins"), per-item amounts
     ("1/4 cup for each pancake", "per serving"), nutrition lines, code fences
     and URLs.
   - Sort Shopping List by Aisle  groups the selected list (or the note) under
     aisle headings — Produce, Bakery, Dairy & Eggs, Meat & Seafood, Deli,
     Pantry, Spices & Baking, Frozen, Snacks, Beverages, Household, Personal
     Care, Baby & Pets, Other — from a built-in dictionary of ~1,700 grocery
     terms (plurals, US/UK synonyms, "frozen …" / "canned …" modifiers). Keeps
     bullets and "- [ ]" / "- [x]" state, merges duplicates (summing
     compatible quantities: "2 apples" + "3 apples" → "5 apples", "1 kg" +
     "500 g" → "1.5 kg"), keeps each aisle in your original order but moves
     CHECKED items to the end of their aisle (what's left to buy stays on top),
     keeps other headings as store sections, and is idempotent (run it again
     after adding items).
   - Convert Recipe Units  US cups / oz / lb / °F ↔ metric g / ml / °C, picking
     the direction from what the recipe mostly uses. Cups of common
     ingredients (flour, sugar, butter, rice, oats, milk…) become grams via a
     density table; the rest become ml.

   The core evaluates every script source in isolation, so the logic lives on
   window.__cadeKitchen (set when this pack loads) and each palette script is a
   thin main(). Every edit is ONE transaction (one Undo). The pure model (K)
   is unit-tested in node by kitchen-pack.test.js. */
(function () {
  'use strict';

  var K = (function () {
    // =========================================================================
    // Numbers
    // =========================================================================
    var UNI = {
      '\u00bd': [1, 2], '\u2153': [1, 3], '\u2154': [2, 3], '\u00bc': [1, 4], '\u00be': [3, 4], '\u2155': [1, 5], '\u2156': [2, 5],
      '\u2157': [3, 5], '\u2158': [4, 5], '\u2159': [1, 6], '\u215a': [5, 6], '\u2150': [1, 7], '\u215b': [1, 8], '\u215c': [3, 8],
      '\u215d': [5, 8], '\u215e': [7, 8], '\u2151': [1, 9], '\u2152': [1, 10],
    };
    var UNI_FOR = {};
    for (var uc in UNI) UNI_FOR[UNI[uc][0] + '/' + UNI[uc][1]] = uc;
    var UC = Object.keys(UNI).join('');
    var NUM_SRC = '(?:\\d+(?:[ \\u00a0]+|-)\\d+[/\\u2044]\\d+|\\d+[ \\u00a0]?[' + UC + ']|\\d+[/\\u2044]\\d+|[' + UC + ']|\\d{1,3}(?:,\\d{3})+(?![\\d,])|\\d+(?:[.,]\\d+)?|\\.\\d+)';
    var RANGE_SEP = '(?:[ \\u00a0]*[-\\u2013\\u2014][ \\u00a0]*|[ \\u00a0]+(?:to|or)[ \\u00a0]+)';
    var QTY_RE = new RegExp(NUM_SRC + '(?:(' + RANGE_SEP + ')(' + NUM_SRC + '))?', 'g');
    var NUM_HEAD_RE = new RegExp('^' + NUM_SRC);
    var FRAC_DENOMS = { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 8: 1, 10: 1, 12: 1, 16: 1 };

    // "1 1/2" → {v: 1.5, style: 'frac'}; null when it isn't a plausible quantity.
    function parseNum(s) {
      s = String(s).replace(/\u00a0/g, ' ').trim();
      var m;
      if ((m = /^(\d+)(?: +|-)(\d+)[/\u2044](\d+)$/.exec(s))) {
        var d = +m[3], n = +m[2];
        if (!d || n >= d || !FRAC_DENOMS[d]) return null;
        return { v: +m[1] + n / d, style: 'frac' };
      }
      if ((m = new RegExp('^(\\d+) ?([' + UC + '])$').exec(s))) return { v: +m[1] + UNI[m[2]][0] / UNI[m[2]][1], style: 'uni' };
      if ((m = /^(\d+)[/\u2044](\d+)$/.exec(s))) {
        var dd = +m[2], nn = +m[1];
        if (!dd || !FRAC_DENOMS[dd] || nn > 3 * dd || !nn) return null; // 10/14 is a date, not a fraction
        return { v: nn / dd, style: 'frac' };
      }
      if (UNI[s]) return { v: UNI[s][0] / UNI[s][1], style: 'uni' };
      if (/^\d{1,3}(,\d{3})+$/.test(s)) return { v: +s.replace(/,/g, ''), style: 'int' };
      if ((m = /^(\d+),(\d+)$/.exec(s))) return { v: +(m[1] + '.' + m[2]), style: 'dec', comma: true };
      if (/^\d+\.\d+$/.test(s) || /^\.\d+$/.test(s)) return { v: +s, style: 'dec' };
      if (/^\d+$/.test(s)) return { v: +s, style: 'int', lead0: s.length > 1 && s.charAt(0) === '0' };
      return null;
    }
    function gcd(a, b) { while (b) { var t = b; b = a % b; a = t; } return a; }
    // Nearest whole + k/d with d from `denoms`; never rounds a positive amount to 0.
    function nearestFrac(v, denoms) {
      var w = Math.floor(v + 1e-9), f = v - w, bn = 0, bd = 1, err = f;
      if (1 - f < err) { err = 1 - f; bn = 1; bd = 1; }
      for (var i = 0; i < denoms.length; i++) {
        var d = denoms[i];
        for (var n = 1; n < d; n++) {
          var e = Math.abs(f - n / d);
          if (e < err - 1e-9) { err = e; bn = n; bd = d; }
        }
      }
      if (bd === 1) { w += bn; bn = 0; }
      if (!w && !bn && v > 0) { var md = Math.max.apply(null, denoms); bn = 1; bd = md; }
      if (bn) { var g = gcd(bn, bd); bn /= g; bd /= g; }
      return { w: w, n: bn, d: bd, v: w + (bn ? bn / bd : 0) };
    }
    function fmtFrac(fr, uni) {
      if (!fr.n) return String(fr.w);
      var key = fr.n + '/' + fr.d, u = uni && UNI_FOR[key];
      if (!fr.w) return u || key;
      return u ? fr.w + u : fr.w + ' ' + key;
    }
    function fmtDec(v, maxDec, comma) {
      var p = Math.pow(10, maxDec);
      var s = String(Math.round(v * p) / p);
      if (/e/.test(s)) s = v.toFixed(maxDec);
      return comma ? s.replace('.', ',') : s;
    }
    // \u00d72, \u00d71.5, \u00d71/3 (thirds would print as 0.333)
    function fmtFactor(f) {
      var fr = nearestFrac(f, [3]);
      if (f < 1 && fr.n && !fr.w && Math.abs(fr.v - f) < 1e-6) return fmtFrac(fr, false);
      return fmtDec(f, 3, false);
    }

    // =========================================================================
    // Units
    // =========================================================================
    // cls: usvol, uswt, mwt, mvol, pinch, count (containers / pieces), and the
    // classes that are never scaled: time, temp, dim, pct, cal, clock.
    var UNITS = {
      cup: { cls: 'usvol', ml: 236.588, forms: ['cup', 'cups'], abbr: [] },
      tbsp: { cls: 'usvol', ml: 14.787, forms: ['tablespoon', 'tablespoons'], abbr: ['tbsp', 'tbsps', 'tbsp.', 'tbs', 'tbs.', 'tbl', 'tbl.', 'tbls', 'tb'] },
      tsp: { cls: 'usvol', ml: 4.929, forms: ['teaspoon', 'teaspoons'], abbr: ['tsp', 'tsps', 'tsp.', 'ts'] },
      floz: { cls: 'usvol', ml: 29.574, forms: ['fluid ounce', 'fluid ounces'], abbr: ['fl oz', 'fl. oz', 'fl. oz.', 'fl oz.', 'fl.oz', 'fl.oz.', 'floz'] },
      pint: { cls: 'usvol', ml: 473.176, forms: ['pint', 'pints'], abbr: ['pt', 'pt.', 'pts'] },
      quart: { cls: 'usvol', ml: 946.353, forms: ['quart', 'quarts'], abbr: ['qt', 'qt.', 'qts'] },
      gallon: { cls: 'usvol', ml: 3785.41, forms: ['gallon', 'gallons'], abbr: ['gal', 'gal.', 'gals'] },
      oz: { cls: 'uswt', g: 28.3495, forms: ['ounce', 'ounces'], abbr: ['oz', 'oz.', 'ozs'] },
      lb: { cls: 'uswt', g: 453.592, forms: ['pound', 'pounds'], abbr: ['lb', 'lb.', 'lbs', 'lbs.'] },
      g: { cls: 'mwt', g: 1, forms: ['gram', 'grams', 'gramme', 'grammes'], abbr: ['gr', 'gr.', 'grs'] },
      kg: { cls: 'mwt', g: 1000, forms: ['kilogram', 'kilograms', 'kilogramme', 'kilogrammes', 'kilo', 'kilos'], abbr: ['kg', 'kg.', 'kgs'] },
      mg: { cls: 'mwt', g: 0.001, forms: ['milligram', 'milligrams'], abbr: ['mg'] },
      ml: { cls: 'mvol', ml: 1, forms: ['millilitre', 'millilitres', 'milliliter', 'milliliters'], abbr: ['ml', 'mls', 'ml.', 'cc'] },
      l: { cls: 'mvol', ml: 1000, forms: ['litre', 'litres', 'liter', 'liters'], abbr: ['ltr', 'ltrs', 'lt'] },
      cl: { cls: 'mvol', ml: 10, forms: ['centilitre', 'centilitres', 'centiliter', 'centiliters'], abbr: ['cl'] },
      dl: { cls: 'mvol', ml: 100, forms: ['decilitre', 'decilitres', 'deciliter', 'deciliters'], abbr: ['dl'] },
      pinch: { cls: 'pinch', forms: ['pinch', 'pinches', 'dash', 'dashes', 'drop', 'drops', 'smidgen', 'smidgens', 'splash', 'splashes'], abbr: [] },
      piece: { cls: 'count', forms: ['stick', 'sticks', 'clove', 'cloves', 'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'package', 'packages', 'packet', 'packets', 'pack', 'packs', 'bag', 'bags', 'box', 'boxes', 'bottle', 'bottles', 'carton', 'cartons', 'container', 'containers', 'envelope', 'envelopes', 'piece', 'pieces', 'slice', 'slices', 'sprig', 'sprigs', 'stalk', 'stalks', 'rib', 'ribs', 'head', 'heads', 'bunch', 'bunches', 'leaf', 'leaves', 'sheet', 'sheets', 'cube', 'cubes', 'fillet', 'fillets', 'filet', 'filets', 'rasher', 'rashers', 'knob', 'knobs', 'scoop', 'scoops', 'ear', 'ears', 'strip', 'strips', 'loaf', 'loaves', 'wedge', 'wedges', 'handful', 'handfuls', 'serving', 'servings', 'portion', 'portions', 'dozen', 'bulb', 'bulbs', 'block', 'blocks', 'link', 'links', 'chunk', 'chunks', 'thumb', 'thumbs', 'shot', 'shots', 'glass', 'glasses', 'mug', 'mugs', 'bowl', 'bowls', 'tub', 'tubs', 'pot', 'pots', 'sachet', 'sachets', 'square', 'squares', 'bar', 'bars', 'pod', 'pods', 'stem', 'stems', 'spear', 'spears', 'floret', 'florets', 'round', 'rounds', 'pkg', 'pkgs', 'pc', 'pcs'], abbr: [] },
      time: { cls: 'time', forms: ['second', 'seconds', 'sec', 'secs', 'minute', 'minutes', 'min', 'mins', 'hour', 'hours', 'hr', 'hrs', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'night', 'nights', 'time', 'times', 'turn', 'turns', 'batch', 'batches', 'more'], abbr: [] },
      temp: { cls: 'temp', forms: ['degrees', 'degree', 'deg', 'degrees f', 'degrees c', 'degrees fahrenheit', 'degrees celsius', 'fahrenheit', 'celsius', 'centigrade'], abbr: [] },
      dim: { cls: 'dim', forms: ['inch', 'inches', 'in.', 'cm', 'mm', 'centimetre', 'centimetres', 'centimeter', 'centimeters', 'millimetre', 'millimetres', 'millimeter', 'millimeters', 'foot', 'feet', 'ft', 'metre', 'metres', 'meter', 'meters'], abbr: [] },
      pct: { cls: 'pct', forms: ['percent', 'per cent'], abbr: [] },
      cal: { cls: 'cal', forms: ['kcal', 'cal', 'cals', 'calorie', 'calories', 'kj'], abbr: [] },
      clock: { cls: 'clock', forms: ['am', 'pm', 'a.m.', 'p.m.', 'a.m', 'p.m', "o'clock"], abbr: [] },
    };
    var SKIP_CLS = { time: 1, temp: 1, dim: 1, pct: 1, cal: 1, clock: 1 };
    // alias (lower case) → unit id, for aliases matched case-insensitively
    var ALIAS = {};
    Object.keys(UNITS).forEach(function (id) {
      var u = UNITS[id];
      u.forms.concat(u.abbr).forEach(function (a) { ALIAS[a.toLowerCase()] = id; });
    });
    // Short aliases whose case matters (t = tsp, T = tbsp, C = cups / Celsius…).
    var CS_ALIAS = { t: 'tsp', 't.': 'tsp', T: 'tbsp', 'T.': 'tbsp', Tb: 'tbsp', c: 'cup', 'c.': 'cup', C: 'cup', 'C.': 'cup', g: 'g', 'g.': 'g', l: 'l', 'l.': 'l', L: 'l', F: 'temp', s: 'time', h: 'time' };
    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    var ciList = Object.keys(ALIAS).filter(function (a) { return a.length >= 2; }).sort(function (a, b) { return b.length - a.length; });
    var CI_RE = new RegExp('^(?:' + ciList.map(function (a) { return esc(a).replace(/ /g, '[ \\u00a0]'); }).join('|') + ')(?![A-Za-z0-9\\u00c0-\\u024f])', 'i');
    var CS_RE = /^(?:T\.|t\.|c\.|C\.|g\.|l\.|Tb|[tTcCglLFsh])(?![A-Za-z0-9\u00c0-\u024f])/;
    // "in" only reads as inches before a pan / piece word or punctuation.
    var IN_RE = /^in(?=[ \u00a0]*(?:[.,;:)]|$)|[ \u00a0]+(?:pan|dish|skillet|pieces?|cubes?|chunks?|lengths?|thick|long|wide|deep|round|square|springform|cake|tin|ramekins?|baking|cast|slices?|strips?|rounds?|squares?)\b)/i;
    var TEMP_SYM_RE = /^(?:[°º][ \u00a0]?[FfCc]?|\u2109|\u2103)/;
    var ADJ_RE = /^((?:(?:heaping|heaped|level|scant|generous|rounded|good|large|small|medium|big|full|extra[- ]large|firmly packed|lightly packed|loosely packed|packed|well[- ]packed|lightly heaped|slightly heaped|tightly packed)[ \u00a0]+){1,2})/i;

    // Unit right after a number: {id, alias, start, end, sepText, adj, hyphen} (offsets in `line`).
    function unitAt(line, p, v) {
      var rest = line.slice(p), sm = /^(-|[ \u00a0\u202f]?)/.exec(rest), sep = sm[0], q = sep.length;
      var hyphen = sep === '-', adj = '';
      if (sep && sep !== '-') {
        var am = ADJ_RE.exec(rest.slice(q));
        if (am) { adj = am[1]; q += adj.length; }
      }
      var r = rest.slice(q), m, id, alias;
      if (!sep || sep === ' ' || sep === '\u00a0' || sep === '\u202f') {
        if ((m = TEMP_SYM_RE.exec(r))) return { id: 'temp', alias: m[0], start: p, end: p + q + m[0].length, sep: sep, adj: adj, hyphen: false };
        if (r.charAt(0) === '%') return { id: 'pct', alias: '%', start: p, end: p + q + 1, sep: sep, adj: adj, hyphen: false };
        if (!sep && /^["\u2033\u201d]/.test(r)) return { id: 'dim', alias: r.charAt(0), start: p, end: p + q + 1, sep: sep, adj: adj, hyphen: false };
      }
      if ((m = CI_RE.exec(r))) { alias = m[0]; id = ALIAS[alias.toLowerCase().replace(/\u00a0/g, ' ')]; }
      else if ((m = IN_RE.exec(r))) { alias = m[0]; id = 'dim'; }
      else if ((m = CS_RE.exec(r))) {
        alias = m[0]; id = CS_ALIAS[alias];
        if ((alias === 's' || alias === 'h') && sep) id = null;             // "30s", "2h" only when attached
        if ((alias === 'C' || alias === 'C.') && v >= 30) id = 'temp';      // 180C is Celsius, 2 C is cups
      }
      if (!id) return null;
      return { id: id, alias: alias, start: p, end: p + q + alias.length, sep: sep, adj: adj, hyphen: hyphen };
    }

    // =========================================================================
    // Scanning a line for quantities
    // =========================================================================
    var MARKER_RE = /^([ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+)?(?:[-*+][ \t]+)?(?:\[[ xX]\][ \t]+)?)(\d{1,3})([.)])(?=[ \t]|$)/;
    var STEPWORD_RE = /(?:^|[^A-Za-z])(?:steps?|day|days|part|parts|phase|stage|round|no\.?|number|nr\.?|option|method|version|v|batch|page|chapter|tip|note|level|gas(?:[ \u00a0]*mark)?(?:[ \u00a0]*no\.?)?|mark|setting|speed|power|size|sizes|room|table|line|row|figure|fig\.?|item|week|weeks|year|years|ages?|aged|model|route|track|episode|lesson|class|grade|apartment|apt\.?|suite|floor|flat|unit|zone)[ \u00a0]*:?[ \u00a0]*#?[ \u00a0]*$/i;
    var TEMPCTX_RE = /(?:oven|preheat(?:ed)?|heat(?:ed)?(?:[ \u00a0]+the[ \u00a0]+oven)?[ \u00a0]+to|temperature|temp|degrees|bake[ \u00a0]+at|roast[ \u00a0]+at|fry[ \u00a0]+at|cook[ \u00a0]+at|at|reaches|registers|thermometer)[^.;\n]{0,12}$/i;
    var TIMECTX_RE = /(?:(?:prep|preparation|cook|cooking|bake|baking|total|rest|resting|chill|chilling|marinate|marinating|soak|soaking|rise|rising|proof|proofing|active|inactive|hands[- ]on|ready[ \u00a0]+in)(?:[ \u00a0]+time)?[ \u00a0]*:|\btime[ \u00a0]*:?)[ \u00a0]*$/i;
    var SERVCTX_RE = /(?:^|[^A-Za-z])(?:serves|serving|servings|yields?|makes|portions?|feeds|quantity|qty)[ \u00a0]*:?[ \u00a0]*(?:about|approx\.?|approximately|around|roughly|~|up[ \u00a0]+to)?[ \u00a0]*$/i;
    var SERVAFTER_RE = /^[ \u00a0]*(?:people|persons|servings|serving|portions|guests|adults|kids|children)\b/i;
    var PER_RE = /^[^.;,\n(]{0,40}?\b(?:each|per|apiece|at[ \u00a0]+a[ \u00a0]+time|a[ \u00a0]+piece)\b/i;
    var EGG_RE = /^[ \u00a0]+((?:(?:large|small|medium|extra[- ]large|jumbo|whole|fresh|free[- ]range|organic|pasture[- ]raised|room[- ]temperature|cold|beaten|lightly[ \u00a0]+beaten|hard[- ]boiled|soft[- ]boiled|raw)[ \u00a0,]+){0,3})(egg[ \u00a0]+yolks?|egg[ \u00a0]+whites?|eggs?|yolks?)(?![A-Za-z])/i;
    var NOTE_RE = /^[ \u00a0]*\(~[ \u00a0]*(\d+(?:\.\d+)?)\)/;
    // Nutrition lines are per serving: never scaled. A line counts when it starts
    // that way or lists two or more nutrient amounts ("12 g fat, 4 g protein").
    var NUTRI_START_RE = /^[\s>*_#\-\u2022]*(?:nutrition(?:al)?(?:[ \u00a0]+(?:facts|info(?:rmation)?))?|per[ \u00a0]+(?:serving|portion)|calories)\b/i;
    var NUTRI_AMT_RE = /\d+(?:\.\d+)?[ \u00a0]*(?:k?cal|kj|g|mg)?[ \u00a0]+(?:of[ \u00a0]+)?(?:calories|fat|protein|carbs?|carbohydrates?|fib(?:er|re)|sodium|sugars?|cholesterol)\b|\b(?:calories|fat|protein|carbs?|carbohydrates?|fib(?:er|re)|sodium|sugars?|cholesterol)[ \u00a0]*:[ \u00a0]*\d/gi;
    function nutritionLine(L) {
      if (NUTRI_START_RE.test(L)) return true;
      var m = L.match(NUTRI_AMT_RE);
      return !!m && m.length >= 2;
    }
    var CONTAINER_RE = /^(?:cans?|tins?|jars?|bags?|packages?|packets?|packs?|box(?:es)?|bottles?|cartons?|containers?|tubs?|pots?|sachets?|envelopes?|blocks?|pkgs?)$/i;
    var WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5 };
    var WORD_RE = /(^|[^A-Za-z])(half[ \u00a0]+(?:a|an)|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?=[ \u00a0])/gi;

    // Hide what must never be scaled: URLs, link targets, inline code, HTML tags.
    function maskLine(line) {
      var blank = function (m) { return new Array(m.length + 1).join('\u0001'); };
      return line
        .replace(/`[^`]*`/g, blank)
        .replace(/\]\([^)]*\)/g, blank)
        .replace(/\b(?:https?:\/\/|www\.)\S+/gi, blank)
        .replace(/<[^>\n]{1,200}>/g, blank)
        .replace(/!\[[^\]]*\]/g, blank)
        .replace(/\u00a7\d+/g, blank);
    }

    // Every quantity candidate in a line, with the reason it is skipped (if so).
    function scanLine(line) {
      var masked = maskLine(line), out = [], m;
      var mk = MARKER_RE.exec(line), markerAt = mk ? mk[1].length : -1;
      QTY_RE.lastIndex = 0;
      while ((m = QTY_RE.exec(masked))) {
        var q = analyze(line, masked, m, markerAt);
        if (!q) continue;
        out.push(q);
        if (q.consumed > QTY_RE.lastIndex) QTY_RE.lastIndex = q.consumed;
      }
      // word amounts: "a cup", "two tablespoons", "half a cup", "a pinch"
      WORD_RE.lastIndex = 0;
      while ((m = WORD_RE.exec(masked))) {
        var start = m.index + m[1].length, word = m[2], end = start + word.length;
        if (out.some(function (o) { return start < o.consumed && end > o.start; })) continue;
        var v = /^half/i.test(word) ? 0.5 : WORD_NUM[word.toLowerCase()];
        var u = unitAt(line, end, v);
        if (!u) { // "One 15-ounce can beans": count the cans
          var pm2 = /^[ \u00a0]+(\d+(?:[.,]\d+)?)(?=[- \u00a0]?[A-Za-z])/.exec(line.slice(end));
          var pu = pm2 ? unitAt(line, end + pm2[0].length, +pm2[1]) : null;
          var cu2 = pu && /^(?:mwt|mvol|uswt|usvol)$/.test(UNITS[pu.id].cls) ? unitAt(line, pu.end, 2) : null;
          if (cu2 && cu2.sep && !cu2.adj && CONTAINER_RE.test(cu2.alias)) u = cu2;
        }
        if (!u || u.hyphen || !u.sep || u.adj && /large|small|medium|big/i.test(u.adj)) continue;
        var cls = UNITS[u.id].cls;
        if (cls !== 'usvol' && cls !== 'uswt' && cls !== 'mwt' && cls !== 'mvol' && cls !== 'pinch' && !(cls === 'count' && /^(?:stick|clove|can|tin|jar|package|packet|bag|box|bottle|bunch|handful|head|slice|sprig)s?$/i.test(u.alias))) continue;
        if (/^(?:serving|servings|portion|portions|dozen)$/i.test(u.alias)) continue;
        var q2 = { start: start, end: end, consumed: u.end, text: word, a: { v: v, style: v === 0.5 ? 'frac' : 'int', word: true }, b: null, sep: '', unit: u, cls: cls };
        if (PER_RE.test(line.slice(u.end))) q2.skip = 'per';
        out.push(q2);
      }
      out.sort(function (x, y) { return x.start - y.start; });
      return out;
    }

    function analyze(line, masked, m, markerAt) {
      var start = m.index, numText = m[0], end = start + numText.length;
      var before = masked.slice(0, start), after = masked.slice(end);
      var q = { start: start, end: end, consumed: end, text: numText, a: null, b: null, sep: m[1] || '', unit: null, cls: 'count' };
      var aText = m[1] ? numText.slice(0, numText.length - m[1].length - m[2].length) : numText;
      q.a = parseNum(aText);
      if (m[1]) { q.b = parseNum(m[2]); if (!q.b) { // "2-" + something that isn't a number: drop the range part
        end = start + aText.length; q.end = q.consumed = end; q.text = aText; q.sep = ''; after = masked.slice(end);
      } }
      if (!q.a) return null;
      var skip = function (why) { q.skip = why; return q; };
      if (q.a.lead0) return skip('code');
      // left boundary: no letters / digits / dots glued to the front ("B12", "v1.2")
      var pc = before.charAt(before.length - 1);
      if (pc && /[A-Za-z0-9\u00c0-\u024f.\u0001_]/.test(pc)) {
        if (/[x\u00d7]/i.test(pc) && /(?:^|[\s(])$/.test(before.slice(0, -1))) q.prefixX = true; // "x2 eggs"
        else return skip('glued');
      }
      if (pc === '/' && !/[A-Za-z]\/$/.test(before)) return skip('glued');
      if (/\d[:]$/.test(before)) return skip('glued'); // the 30 of 10:30, the 2 of 1:2
      if (/[$\u20ac\u00a3\u00a5#]$/.test(before)) return skip('money');
      if (start === markerAt) return skip('step');
      if (STEPWORD_RE.test(before)) return skip('step');
      // right boundary
      if (/^[:][0-9]/.test(after) || /^\.\d/.test(after) || /^\/\d/.test(after) || /^,\d/.test(after)) return skip('glued');
      if (/^(?:st|nd|rd|th)\b/i.test(after)) return skip('ordinal');
      if (/^'?s\b/.test(after) && q.a.v >= 1900) return skip('year');
      if (/^[x\u00d7][ \u00a0]*\d/i.test(after) || /^[ \u00a0]+[x\u00d7][ \u00a0]*\d/i.test(after)) {
        // "9x13" is a size; "2 x 400g tins" is a count of packs
        var mm = /^[ \u00a0]*[x\u00d7][ \u00a0]*/i.exec(after), p2 = end + mm[0].length;
        var nm = NUM_HEAD_RE.exec(masked.slice(p2));
        var u2 = nm ? unitAt(line, p2 + nm[0].length, +nm[0]) : null;
        if (u2 && !u2.hyphen && /^(?:uswt|usvol|mwt|mvol)$/.test(UNITS[u2.id].cls)) {
          q.consumed = u2.end;
          var cu = unitAt(line, u2.end, 2); // the container after it: "tins", "cans"
          if (cu && cu.sep && !cu.adj && UNITS[cu.id].cls === 'count') { q.container = cu; q.consumed = cu.end; }
          return q;
        }
        q.consumed = p2 + (nm ? nm[0].length : 0);
        return skip('size');
      }
      if (/^[x\u00d7](?![A-Za-z0-9])/i.test(after)) { q.suffixX = true; return q; } // "2x eggs"
      // a package size: "1 (14 oz) can", "2 x 400 g"
      if (/\d[ \u00a0]*\([ \u00a0]*$/.test(before) || /\d[ \u00a0]*[x\u00d7][ \u00a0]*$/i.test(before)) return skip('package');
      // unit (possibly behind a "(14 oz)" package note: "1 (14 oz) can tomatoes")
      var u = unitAt(line, end, q.a.v), paren = null;
      if (!u) {
        var pm = /^[ \u00a0]*\([^()\n]{1,30}\)[ \u00a0]*/.exec(line.slice(end));
        if (pm) {
          var u3 = unitAt(line, end + pm[0].length - 1, q.a.v);
          if (u3 && UNITS[u3.id].cls === 'count' && u3.sep) { u = u3; paren = pm[0]; }
        }
      }
      if (u) {
        q.unit = u; q.cls = UNITS[u.id].cls; q.paren = paren; q.consumed = u.end;
        if (SKIP_CLS[q.cls]) return skip(q.cls);
        if (u.hyphen) return skip('adjectival'); // "15-ounce can", "2-pound chicken"
        if (!q.b && !paren && /^(?:mwt|mvol|uswt|usvol)$/.test(q.cls)) {
          // "400g can tomatoes" is ONE can of 400 g: scaling makes "1 1/2 x 400g cans"
          var pk = unitAt(line, u.end, 2);
          if (pk && pk.sep && !pk.adj && CONTAINER_RE.test(pk.alias)) { q.pkg = pk; q.consumed = pk.end; }
        }
        if (q.a.comma && q.cls === 'count') return skip('list');
      } else {
        if (/^-[A-Za-z]/.test(after)) return skip('adjectival'); // "3-ingredient"
        if (/^[A-Za-z\u00c0-\u024f]/.test(after)) return skip('glued'); // "4K", "7up"
        if (/^[ \u00a0]*(?:%|percent\b|per cent\b)/i.test(after)) return skip('pct');
        if (/^[ \u00a0]*(?:a\.?m\.?|p\.?m\.?)(?![A-Za-z])/i.test(after)) return skip('clock');
        if (q.a.comma) return skip('list');
        if (q.a.style === 'int' && q.a.v >= 1900 && q.a.v <= 2100 && !q.b) return skip('year');
        if (Math.max(q.a.v, q.b ? q.b.v : 0) >= 1000) return skip('big'); // codes, phone numbers, ids
        if (q.a.v >= 90 && TEMPCTX_RE.test(before)) return skip('temp');
        if (TIMECTX_RE.test(before)) return skip('time');
        var em = EGG_RE.exec(line.slice(end));
        if (em) {
          q.cls = 'egg';
          q.noun = { start: end + em[0].length - em[2].length, end: end + em[0].length, word: em[2] };
          q.consumed = q.noun.end;
          var nt = NOTE_RE.exec(line.slice(q.noun.end));
          if (nt) { q.note = { start: q.noun.end, end: q.noun.end + nt[0].length, v: +nt[1] }; q.consumed = q.note.end; }
        } else if (SERVCTX_RE.test(before) || SERVAFTER_RE.test(after)) {
          q.cls = 'serv';
        } else {
          var hn = headNoun(line, end);
          if (hn) q.noun = hn;
        }
      }
      if (PER_RE.test(line.slice(q.consumed))) return skip('per');
      return q;
    }

    // =========================================================================
    // Plural / singular for the noun after a count ("1 onion" → "2 onions")
    // =========================================================================
    var IRREG = { leaf: 'leaves', loaf: 'loaves', half: 'halves', knife: 'knives', potato: 'potatoes', tomato: 'tomatoes', mango: 'mangoes', hero: 'heroes', mouse: 'mice', goose: 'geese', tooth: 'teeth', foot: 'feet', child: 'children', person: 'people', cactus: 'cacti', shelf: 'shelves', calf: 'calves', wolf: 'wolves' };
    var IRREG_REV = {};
    for (var ik in IRREG) IRREG_REV[IRREG[ik]] = ik;
    var UNCOUNT = ' rice flour salt pepper water milk butter sugar oil garlic ginger fish sheep deer cheese bread chocolate broccoli spinach lettuce celery cilantro parsley basil thyme rosemary oregano dill mint sage honey yeast cream yogurt yoghurt juice zest beef pork lamb tofu pasta spaghetti quinoa oats corn kale arugula asparagus hummus couscous tea coffee wine beer vinegar mayonnaise mustard ketchup syrup stock broth sauce dough batter jam jelly ice meat salmon tuna shrimp cod trout seafood fruit produce bacon ham chili chilli paprika cumin cinnamon nutmeg cocoa vanilla baking soda powder cornstarch gelatin rum vodka gin brandy whiskey lemonade granola cereal popcorn molasses mozzarella parmesan cheddar feta ricotta mascarpone buttermilk kefir ghee lard shortening margarine sriracha tahini miso pesto salsa guacamole quiche risotto oatmeal porridge muesli wheat barley bulgur polenta grits sesame flax chia stuffing gravy ';
    var STOP_WORDS = ' and or of for to in into with from at plus on per each cut about approximately as if until then but not divided optional like such the a an ';
    function pluralize(w) {
      var lo = w.toLowerCase(), p;
      if (IRREG[lo]) p = IRREG[lo];
      else if (/[^aeiou]y$/.test(lo)) p = lo.slice(0, -1) + 'ies';
      else if (/(?:s|x|z|ch|sh)$/.test(lo)) p = lo + 'es';
      else p = lo + 's';
      return matchCase(w, p);
    }
    function singularize(w) {
      var lo = w.toLowerCase(), s;
      if (IRREG_REV[lo]) s = IRREG_REV[lo];
      else if (/ies$/.test(lo) && lo.length > 4 && !/^(?:pies|ties|lies|dies)$/.test(lo)) s = lo.slice(0, -3) + 'y';
      else if (/(?:ches|shes|xes|zes|sses)$/.test(lo)) s = lo.slice(0, -2);
      else if (/[^su]s$/.test(lo) && !/(?:is|us|ss)$/.test(lo)) s = lo.slice(0, -1);
      else s = lo;
      return matchCase(w, s);
    }
    function matchCase(src, w) {
      if (src === src.toUpperCase() && src.length > 1) return w.toUpperCase();
      if (src.charAt(0) === src.charAt(0).toUpperCase()) return w.charAt(0).toUpperCase() + w.slice(1);
      return w;
    }
    function isPlural(w) {
      var lo = w.toLowerCase();
      return !!IRREG_REV[lo] || (/s$/.test(lo) && !/(?:ss|us|is)$/.test(lo));
    }
    // The last word of the noun phrase after a bare count: "1 small red onion,
    // diced" → onion. Leading adjectives may end in -ed / -ly ("2 dried figs").
    function headNoun(line, p) {
      var re = /[ \u00a0]+([A-Za-z\u00c0-\u024f]+(?:['\u2019][A-Za-z]+)?)/y, m, last = null, pos = p, n = 0;
      if (!re.sticky) return null;
      while (n < 4) {
        re.lastIndex = pos;
        m = re.exec(line);
        if (!m) break;
        var w = m[1], lo = w.toLowerCase();
        if (STOP_WORDS.indexOf(' ' + lo + ' ') >= 0) break;
        if (last && lo.length >= 5 && /(?:ed|ly)$/.test(lo)) break; // "diced", "finely" (not "red")
        if (ALIAS[lo] || CS_ALIAS[w]) {
          // "1 bay leaf", "2 garlic cloves": a piece word ends the phrase as its noun
          if (!last || UNITS[ALIAS[lo] || CS_ALIAS[w]].cls !== 'count') return null;
          last = { start: m.index + m[0].length - w.length, end: m.index + m[0].length, word: w, unit: true };
          break;
        }
        last = { start: m.index + m[0].length - w.length, end: m.index + m[0].length, word: w };
        pos = re.lastIndex;
        n++;
        if (/^[,;:()]/.test(line.slice(pos)) || pos >= line.length) break;
      }
      if (!last || last.word.length < 3 || UNCOUNT.indexOf(' ' + last.word.toLowerCase() + ' ') >= 0) return null;
      if (!last.unit && last.word.length >= 5 && /(?:ed|ly|ing)$/i.test(last.word)) return null;
      return last;
    }

    // =========================================================================
    // Rounding to kitchen-friendly amounts
    // =========================================================================
    var VOL_DENOMS = [2, 3, 4, 8];
    function roundMetric(v) {
      if (v < 1) return Math.max(0.05, Math.round(v * 20) / 20);
      if (v < 20) return Math.max(0.5, Math.round(v * 2) / 2); // yeast, salt, spices: half grams
      if (v < 100) return Math.round(v);
      if (v < 500) return Math.round(v / 5) * 5;
      return Math.round(v / 10) * 10;
    }
    function near(x, step, tol) { return Math.abs(x / step - Math.round(x / step)) * step <= tol; }
    // A value in unit `id` → the friendliest {v, id} (same family).
    function fit(v, id) {
      switch (id) {
        case 'cup':
          if (v < 0.24) return fit(v * 16, 'tbsp');
          return { v: nearestFrac(v, VOL_DENOMS).v, id: 'cup', frac: VOL_DENOMS, forceFrac: true };
        case 'tbsp':
          if (v < 0.49) return fit(v * 3, 'tsp');
          if (v >= 3.99 && (near(v / 16, 0.25, 0.004) || near(v / 16, 1 / 3, 0.004))) return fit(v / 16, 'cup');
          return { v: nearestFrac(v, VOL_DENOMS).v, id: 'tbsp', frac: VOL_DENOMS, forceFrac: true };
        case 'tsp':
          if (v >= 2.99 && near(v / 3, 0.5, 0.02)) return fit(v / 3, 'tbsp');
          return { v: nearestFrac(v, VOL_DENOMS).v, id: 'tsp', frac: VOL_DENOMS, forceFrac: true };
        case 'floz': case 'pint': case 'quart': case 'gallon':
          return { v: nearestFrac(v, [2, 3, 4]).v, id: id, frac: [2, 3, 4], forceFrac: true };
        case 'oz':
          if (v >= 15.99 && near(v / 16, 0.25, 0.01)) return fit(v / 16, 'lb');
          return { v: nearestFrac(v, [2, 4]).v, id: 'oz', frac: [2, 4] };
        case 'lb':
          if (v < 0.24) return fit(v * 16, 'oz');
          return { v: nearestFrac(v, [2, 3, 4]).v, id: 'lb', frac: [2, 3, 4] };
        case 'g': case 'ml':
          var r = roundMetric(v);
          if (r >= 1000) return { v: Math.round(r / 50) / 20, id: id === 'g' ? 'kg' : 'l', dec: 2 };
          return { v: r, id: id, dec: 2 };
        case 'kg': case 'l':
          if (v < 0.995) return fit(v * 1000, id === 'kg' ? 'g' : 'ml');
          return { v: Math.round(v * 20) / 20, id: id, dec: 2 };
        case 'mg': return { v: v < 10 ? Math.round(v * 2) / 2 : Math.round(v), id: id, dec: 1 };
        case 'cl': case 'dl': return { v: Math.round(v * 2) / 2, id: id, dec: 1 };
        case 'pinch': return { v: Math.max(1, Math.round(v)), id: id, whole: true };
        default: // counts / pieces / containers / bare numbers
          if (v >= 10) return { v: Math.round(v), id: id, whole: true };
          return { v: nearestFrac(v, [2, 4]).v, id: id, frac: [2, 4] };
      }
    }
    // The word for unit `id` in the style of the alias the recipe used:
    // "teaspoons" → "tablespoons", "tsp" → "tbsp", "Tbsp" → "Cup".
    function unitWord(id, plural, likeAlias) {
      var la = likeAlias || '', lo = la.toLowerCase(), w;
      var full = la.length > 3 && !/\./.test(la) && !!ALIAS[lo] && UNITS[ALIAS[lo]].forms.indexOf(lo) >= 0 && UNITS[ALIAS[lo]].cls !== 'count';
      if (full) {
        var er = /er/.test(lo);
        var pair = {
          cup: ['cup', 'cups'], tbsp: ['tablespoon', 'tablespoons'], tsp: ['teaspoon', 'teaspoons'], oz: ['ounce', 'ounces'], lb: ['pound', 'pounds'],
          g: ['gram', 'grams'], kg: ['kilogram', 'kilograms'], ml: er ? ['milliliter', 'milliliters'] : ['millilitre', 'millilitres'], l: er ? ['liter', 'liters'] : ['litre', 'litres'],
        }[id];
        w = pair ? pair[plural ? 1 : 0] : id;
      } else {
        w = { cup: plural ? 'cups' : 'cup', tbsp: 'tbsp', tsp: 'tsp', oz: 'oz', lb: /lbs/.test(lo) && plural ? 'lbs' : 'lb', g: 'g', kg: 'kg', ml: la === 'mL' ? 'mL' : 'ml', l: la === 'mL' || la === 'L' ? 'L' : 'l' }[id] || id;
        if (id === 'tbsp' && (la === 'T' || la === 'T.')) w = la;
        if (id === 'tsp' && (la === 't' || la === 't.')) w = la;
      }
      if (la.length > 1 && la === la.toUpperCase() && /[A-Z]{2}/.test(la) && w !== 'mL' && w !== 'L') w = w.toUpperCase();
      else if (/^[A-Z][a-z]/.test(la)) w = w.charAt(0).toUpperCase() + w.slice(1);
      return w;
    }
    // A unit alias with its number adjusted (cup ↔ cups, leaf ↔ leaves).
    var ABBR_PL = { lbs: 1, tbsps: 1, tsps: 1, ozs: 1, pts: 1, qts: 1, kgs: 1, gals: 1, mls: 1, pcs: 1, pkgs: 1, grs: 1, ltrs: 1, tbls: 1 };
    function inflect(alias, plural) {
      var lo = alias.toLowerCase();
      var id = ALIAS[lo];
      if (!id) return alias;
      var bare = lo.replace(/\.$/, '');
      if (ABBR_PL[bare] && !plural) return alias.replace(/[sS](\.?)$/, '$1'); // "2 lbs" → "1 lb"
      var u = UNITS[id];
      if (u.forms.indexOf(lo) < 0 || /\./.test(alias)) return alias; // abbreviations stay as written
      if (lo === 'dozen' || lo.length < 3) return alias;
      var isPl = isPlural(lo) && u.forms.indexOf(singularize(lo).toLowerCase()) >= 0;
      if (plural && !isPl && u.forms.indexOf(pluralize(lo).toLowerCase()) >= 0) return matchCase(alias, pluralize(lo));
      if (!plural && isPl) return matchCase(alias, singularize(lo));
      return alias;
    }
    function fmtVal(v, r, style) {
      if (r.dec != null) return fmtDec(v, r.dec, style.comma);
      if (r.whole) return String(Math.round(v));
      if (style.style === 'dec' && !r.forceFrac) return fmtDec(v, 2, style.comma);
      return fmtFrac(nearestFrac(v, r.frac || [2, 4]), style.style === 'uni');
    }

    // =========================================================================
    // Scaling
    // =========================================================================
    // One quantity × f → {num, id, plural, noteV, changedUnit}
    function scaleOne(q, f) {
      var a = (q.note && !q.b ? q.note.v : q.a.v) * f, b = q.b ? q.b.v * f : null; // re-scaling starts from a noted exact amount
      var style = { style: q.a.style === 'uni' || (q.b && q.b.style === 'uni') ? 'uni' : q.a.style, comma: !!q.a.comma };
      if (q.a.word) style.style = 'frac';
      var ra, rb = null, noteV = null;
      if (q.cls === 'egg' || q.cls === 'serv') {
        var whole = function (x) { return { v: Math.max(1, Math.round(x + 1e-9)), id: q.cls, whole: true }; };
        ra = whole(a);
        if (b != null) rb = whole(b);
        else if (q.cls === 'egg' && Math.abs(ra.v - a) > 0.01) noteV = a;
      } else {
        var id = q.unit ? q.unit.id : 'piece';
        ra = fit(a, id);
        if (b != null) {
          rb = fit(b, id);
          // a range keeps one unit: switch only when both ends read well in it
          // ("4-6 tbsp" → "1/4-3/8 cup" no; "8-12 tbsp" → "1/2-3/4 cup" yes)
          if (ra.id !== rb.id) { ra = refit(a, id); rb = refit(b, id); }
        }
      }
      var aStr = fmtVal(ra.v, ra, style), bStr = rb ? fmtVal(rb.v, rb, style) : null;
      if (bStr === aStr) bStr = null; // "1/8–1/8" collapses
      var hi = bStr != null ? rb.v : ra.v;
      return {
        num: aStr + (bStr != null ? q.sep + bStr : ''), id: ra.id, plural: hi > 1 + 1e-9,
        noteV: noteV, changedUnit: !!q.unit && ra.id !== q.unit.id,
      };
    }
    function toUnit(v, from, to) {
      var a = UNITS[from], b = UNITS[to];
      if (a.ml && b.ml) return v * a.ml / b.ml;
      if (a.g && b.g) return v * a.g / b.g;
      return v;
    }
    // Round in a unit chosen already (no further unit switch).
    function refit(v, id) {
      var r = fit(v, id);
      if (r.id === id) return r;
      if (id === 'cup' || id === 'tbsp' || id === 'tsp') return { v: nearestFrac(v, VOL_DENOMS).v, id: id, frac: VOL_DENOMS, forceFrac: true };
      if (id === 'oz') return { v: nearestFrac(v, [2, 4]).v, id: id, frac: [2, 4] };
      if (id === 'lb') return { v: nearestFrac(v, [2, 3, 4]).v, id: id, frac: [2, 3, 4] };
      if (id === 'g' || id === 'ml') return { v: roundMetric(v), id: id, dec: 2 };
      return { v: Math.round(v * 20) / 20, id: id, dec: 2 };
    }

    function scaleLine(line, f) {
      var qs = scanLine(line), out = '', last = 0, n = 0, eggs = 0;
      for (var i = 0; i < qs.length; i++) {
        var q = qs[i];
        if (q.skip || q.start < last) continue;
        var r = scaleOne(q, f);
        var seg = r.num;
        var segEnd = q.end;
        if (q.a.word && q.a.v === 1 && seg === '1') seg = q.text; // "a pinch" stays "a pinch"
        if (q.pkg) { // one "400g can" × 1.5 → "1 1/2 x 400g cans" (the pack size stays)
          seg = fmtFrac(nearestFrac(f, [2, 4]), false) + ' x ' + line.slice(q.start, q.pkg.end - q.pkg.alias.length) + inflect(q.pkg.alias, f > 1 + 1e-9);
          segEnd = q.pkg.end;
        } else if (q.container) {
          seg += line.slice(q.end, q.container.end - q.container.alias.length) + inflect(q.container.alias, r.plural);
          segEnd = q.container.end;
        } else if (q.unit) {
          var u = q.unit;
          var between = line.slice(q.end, u.end - u.alias.length);
          var alias = r.changedUnit ? unitWord(r.id, r.plural, u.alias) : inflect(u.alias, r.plural);
          seg += between + alias;
          segEnd = u.end;
        } else if (q.noun) {
          var mid = line.slice(q.end, q.noun.start), word = q.noun.word;
          // Only fix the noun when it agreed with the old amount ("1 onion" →
          // "2 onions"); "2 Granny Smith" is left as written.
          var origPl = q.b ? true : (q.note ? q.note.v : q.a.v) > 1 + 1e-9;
          var lastW = /([A-Za-z]+)$/.exec(word);
          if (lastW && isPlural(lastW[1]) === origPl && r.plural !== origPl) word = r.plural ? pluralizeHead(word) : singularizeHead(word);
          seg += mid + word;
          segEnd = q.noun.end;
          if (q.note) segEnd = q.note.end;
          if (r.noteV != null) { seg += ' (~' + fmtDec(r.noteV, 2, false) + ')'; eggs++; }
        }
        out += line.slice(last, q.start) + seg;
        last = segEnd;
        n++;
      }
      return { text: out + line.slice(last), n: n, eggs: eggs };
    }
    // Egg words are phrases ("egg yolks"): inflect the last word only.
    function pluralizeHead(phrase) { var m = /^(.*?)([A-Za-z]+)$/.exec(phrase); return m ? m[1] + pluralize(m[2]) : phrase; }
    function singularizeHead(phrase) { var m = /^(.*?)([A-Za-z]+)$/.exec(phrase); return m ? m[1] + singularize(m[2]) : phrase; }

    // Scale every quantity in `text` by f. → {text, changed, eggs}
    function scaleText(text, f) {
      var lines = String(text).split('\n'), fence = null, changed = 0, eggs = 0;
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i], fm = /^[ \t]*(`{3,}|~{3,})/.exec(L);
        if (fm) { if (!fence) fence = fm[1].charAt(0); else if (fm[1].charAt(0) === fence) fence = null; continue; }
        if (fence || L.length > 2000 || !/\d|[\u00bd\u2153-\u215e\u00bc\u00be\u2150-\u2152]|\b(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half)\b/i.test(L)) continue;
        if (nutritionLine(L)) continue;
        var r = scaleLine(L, f);
        lines[i] = r.text; changed += r.n; eggs += r.eggs;
      }
      return { text: lines.join('\n'), changed: changed, eggs: eggs };
    }

    // "Serves 4" / "Servings: 4-6" / "Yield: 12 cookies" / "Makes 24" → 4 / 4 / 12 / 24
    function findServings(text) {
      var m = /\b(?:serves|servings?|yields?|makes|portions?|feeds)\b[ \u00a0]*:?[ \u00a0]*(?:about|approx\.?|approximately|around|up to|~)?[ \u00a0]*(\d+(?:\.\d+)?)/i.exec(String(text || ''));
      if (!m) m = /\b(?:for|to serve)[ \u00a0]+(\d+)[ \u00a0]+(?:people|persons|servings|guests)\b/i.exec(String(text || ''));
      return m ? +m[1] : null;
    }
    // The user's answer → {factor} | {error}. `serves` = the recipe's servings, if known.
    function parseFactor(input, serves) {
      var s = String(input == null ? '' : input).trim().toLowerCase().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
      var num = function (t) { t = t.trim(); var p = parseNum(t.replace(/^0+(?=\d)/, '')); if (p) return p.v; var x = parseFloat(t); return /^\d*\.?\d+$/.test(t) && isFinite(x) ? x : NaN; };
      var ok = function (f) { return isFinite(f) && f > 0 && f <= 1000 ? { factor: f } : { error: 'That gives a factor of ' + (isFinite(f) ? fmtDec(f, 3) : '?') + ' \u2014 use something between 0.01 and 1000' }; };
      if (!s) return { error: 'Enter a factor like 2 or 0.5, or servings like 4 to 6' };
      var words = { half: 0.5, halve: 0.5, halved: 0.5, double: 2, doubled: 2, twice: 2, triple: 3, tripled: 3, quadruple: 4, third: 1 / 3, quarter: 0.25 };
      if (words[s]) return { factor: words[s] };
      var m;
      if ((m = /^(\d+(?:\.\d+)?)\s*%$/.exec(s))) return ok(+m[1] / 100);
      if ((m = /^(?:\/|÷)\s*(\d+(?:\.\d+)?)$/.exec(s))) return ok(1 / +m[1]);
      // servings: "4 to 6", "4->6", "from 4 to 6 servings", "serves 4 → 6"
      var t = s.replace(/\b(?:servings?|serves|people|persons|portions|guests|from|for|scale|recipe)\b/g, ' ').replace(/\s+/g, ' ').trim();
      if ((m = /^(\d+(?:\.\d+)?)\s*(?:to|->|\u2192|=>|>|:|-|\u2013|\u2014)\s*(\d+(?:\.\d+)?)$/.exec(t))) {
        if (+m[1] === 0) return { error: 'The original servings can\u2019t be 0' };
        return ok(+m[2] / +m[1]);
      }
      // "6 servings" / "serves 6" / "for 6" / "to 6": target servings
      if (/\b(?:servings?|serves|people|persons|portions|guests|for)\b|^to\s/.test(s) && (m = /^(?:to\s+)?(\d+(?:\.\d+)?)$/.exec(t))) {
        if (!serves) return { error: 'Couldn\u2019t find \u201cServes N\u201d in the recipe \u2014 enter it like \u201c4 to ' + m[1] + '\u201d or a factor' };
        return ok(+m[1] / serves);
      }
      t = s.replace(/^(?:x|\u00d7|\*|times)\s*/, '').replace(/\s*(?:x|\u00d7|times)$/, '').trim();
      var f = num(t);
      if (isNaN(f)) return { error: 'Couldn\u2019t read \u201c' + String(input).trim() + '\u201d \u2014 try 2, 0.5, 1/2, x1.5 or 4 to 6' };
      return ok(f);
    }

    // =========================================================================
    // Shopping list: aisles
    // =========================================================================
    var AISLES = ['Produce', 'Bakery', 'Dairy & Eggs', 'Meat & Seafood', 'Deli', 'Pantry', 'Spices & Baking', 'Frozen', 'Snacks', 'Beverages', 'Household', 'Personal Care', 'Baby & Pets', 'Other'];
    var DICT_SRC = {
      'Produce': 'apple, apples, garlic clove, garlic cloves, banana, orange, lemon, lime, grapefruit, clementine, mandarin, tangerine, satsuma, grape, strawberry, blueberry, raspberry, blackberry, cranberry, cherry, peach, nectarine, plum, apricot, pear, mango, pineapple, papaya, kiwi, kiwifruit, watermelon, cantaloupe, honeydew, melon, pomegranate, fig, persimmon, passion fruit, dragon fruit, guava, lychee, coconut, plantain, rhubarb, avocado, tomato, cherry tomato, grape tomato, roma tomato, potato, sweet potato, yam, russet, onion, red onion, yellow onion, white onion, sweet onion, shallot, scallion, green onion, spring onion, leek, garlic, garlic bulb, ginger, ginger root, turmeric root, carrot, baby carrot, celery, broccoli, broccolini, cauliflower, cabbage, red cabbage, napa cabbage, savoy cabbage, bok choy, pak choi, brussels sprout, brussel sprout, sprouts, bean sprout, spinach, baby spinach, kale, lacinato kale, chard, swiss chard, collard, collard greens, greens, mixed greens, spring mix, salad, salad mix, bagged salad, lettuce, romaine, iceberg, butter lettuce, little gem, arugula, rocket, watercress, endive, radicchio, frisee, cucumber, english cucumber, zucchini, courgette, squash, butternut squash, acorn squash, spaghetti squash, pumpkin, eggplant, aubergine, bell pepper, peppers, red pepper, green pepper, yellow pepper, orange pepper, jalapeno, serrano, habanero, poblano, chile, chili pepper, chilli, chillies, chilies, mushroom, button mushroom, cremini, portobello, shiitake, oyster mushroom, corn on the cob, sweet corn, corn, green bean, string bean, runner bean, snap pea, snow pea, sugar snap pea, edamame, asparagus, artichoke, beet, beetroot, radish, turnip, parsnip, rutabaga, swede, celeriac, fennel, kohlrabi, okra, jicama, daikon, horseradish, cilantro, coriander leaves, fresh coriander, parsley, flat leaf parsley, basil, fresh basil, mint, dill, chives, fresh herbs, herbs, lemongrass, microgreens, alfalfa, tofu, tempeh, berries, fruit, vegetables, veggies, veg, produce, potatoes, onions, apples, limes, lemons, avocados, salad leaves, kumquat, starfruit, quince, gooseberry, currant, red currant, elderberry, mulberry, pluot, jackfruit, tomatillo, cassava, taro, water chestnut, bamboo shoot, sprout, pea shoots, garlic scape, ramps, sunchoke, lime leaves, banana leaves, galangal',
      'Bakery': 'bread, loaf, sandwich bread, white bread, wheat bread, whole wheat bread, multigrain bread, rye bread, sourdough, baguette, french bread, italian bread, ciabatta, focaccia, brioche, challah, bagel, english muffin, muffin, croissant, roll, dinner roll, bun, hamburger bun, burger bun, hot dog bun, slider bun, pita, pita bread, naan, flatbread, tortilla, flour tortilla, corn tortilla, wrap, wraps, lavash, crumpet, scone, biscuit, danish, pastry, pastries, donut, doughnut, cake, birthday cake, cupcake, pie, tart, cheesecake, brownie, cookie dough, cinnamon roll, pretzel roll, garlic bread, breadsticks, bread rolls, rolls, pizza base, pizza crust, pizza dough, dough, puff pastry, phyllo, filo, baked goods, matzo, pound cake, angel food cake, coffee cake, banana bread, rye, pumpernickel, teacake, hot cross bun, waffle cone, cake cones, ice cream cones',
      'Dairy & Eggs': 'milk, whole milk, skim milk, 2% milk, semi skimmed milk, skimmed milk, lactose free milk, oat milk, almond milk, soy milk, rice milk, cashew milk, coconut beverage, chocolate milk, buttermilk, cream, heavy cream, whipping cream, double cream, single cream, half and half, half & half, sour cream, creme fraiche, whipped cream, cool whip, coffee creamer, creamer, butter, salted butter, unsalted butter, margarine, ghee, egg, eggs, egg white, egg whites, egg yolk, cheese, cheddar, mozzarella, parmesan, parmigiano, pecorino, gruyere, swiss cheese, provolone, monterey jack, pepper jack, colby, brie, camembert, feta, goat cheese, chevre, blue cheese, gorgonzola, ricotta, cottage cheese, cream cheese, mascarpone, halloumi, paneer, string cheese, cheese sticks, shredded cheese, sliced cheese, american cheese, cheese slices, yogurt, yoghurt, greek yogurt, kefir, skyr, pudding, custard, dairy, quark, fromage frais, oat cream, vegan butter, vegan cheese, burrata, manchego, havarta, havarti, edam, gouda, emmental, babybel',
      'Meat & Seafood': 'chicken, whole chicken, chicken breast, chicken thigh, chicken leg, chicken wing, wings, drumstick, drumsticks, chicken tenders, chicken mince, ground chicken, turkey, ground turkey, turkey mince, turkey breast, beef, ground beef, beef mince, mince, minced beef, steak, ribeye, sirloin, filet mignon, flank steak, skirt steak, brisket, chuck roast, pot roast, roast beef joint, stew meat, short ribs, ribs, spare ribs, baby back ribs, pork, pork chop, pork chops, pork loin, pork tenderloin, pork shoulder, pork belly, ground pork, pork mince, ham hock, bacon, streaky bacon, pancetta, sausage, sausages, bratwurst, italian sausage, chorizo, kielbasa, hot dog, hot dogs, frankfurter, lamb, lamb chop, leg of lamb, ground lamb, lamb mince, veal, venison, duck, duck breast, goose, quail, rabbit, bison, meatball, meatballs, burger, burgers, hamburger, hamburger patty, patties, fish, salmon, salmon fillet, smoked salmon, cod, haddock, halibut, tilapia, trout, sea bass, snapper, mahi mahi, catfish, swordfish, tuna steak, sole, flounder, mackerel, sardine fillets, shrimp, prawn, prawns, scallop, scallops, crab, crab legs, lobster, mussel, mussels, clam, clams, oyster, oysters, squid, calamari, octopus, seafood, meat, poultry, cutlet, cutlets, tenderloin, roast, joint, gammon, oxtail, liver, chicken livers, giblets, mince meat, lamb shank, pork ribs, beef ribs, ground meat, wagyu, t-bone, porterhouse, new york strip',
      'Deli': 'deli meat, lunch meat, cold cuts, sliced turkey, deli turkey, sliced ham, ham, salami, pepperoni, prosciutto, mortadella, bologna, pastrami, corned beef, roast beef, capicola, soppressata, liverwurst, pate, rotisserie chicken, hummus, guacamole, tzatziki, dip, dips, potato salad, pasta salad, coleslaw, chicken salad, egg salad, tuna salad, macaroni salad, olives bar, sushi, sandwich, sandwiches, wrap sandwich, deli, prepared meals, ready meal, quiche, spring rolls, dolmades, antipasto, charcuterie, sliced chicken, chicken slices, turkey slices, ham slices, rotisserie, fresh pasta, ravioli, tortellini, gnocchi, fresh salsa, pico de gallo, smoked fish',
      'Pantry': 'pasta, spaghetti, penne, fusilli, rigatoni, linguine, fettuccine, macaroni, lasagna, lasagne, orzo, egg noodles, noodles, ramen, udon, soba, rice noodles, vermicelli, rice, white rice, brown rice, basmati, jasmine rice, arborio, wild rice, quinoa, couscous, bulgur, barley, farro, polenta, grits, oats, rolled oats, porridge oats, oatmeal, instant oatmeal, cereal, granola, muesli, cornflakes, corn flakes, cheerios, bran flakes, beans, black beans, kidney beans, pinto beans, cannellini beans, navy beans, white beans, baked beans, refried beans, butter beans, chickpeas, garbanzo beans, lentils, red lentils, split peas, canned tomatoes, tinned tomatoes, diced tomatoes, crushed tomatoes, chopped tomatoes, tomato sauce, tomato paste, tomato puree, passata, pasta sauce, marinara, pizza sauce, salsa, enchilada sauce, curry paste, pesto, soup, chicken soup, tomato soup, chicken broth, beef broth, vegetable broth, broth, stock, chicken stock, vegetable stock, beef stock, bouillon, stock cubes, bouillon cubes, gravy, gravy granules, peanut butter, almond butter, nut butter, nutella, jam, jelly, preserves, marmalade, honey, maple syrup, syrup, golden syrup, agave, molasses, ketchup, mustard, dijon, mayonnaise, mayo, relish, bbq sauce, barbecue sauce, hot sauce, sriracha, soy sauce, tamari, worcestershire sauce, fish sauce, oyster sauce, hoisin, teriyaki sauce, sweet chili sauce, sauce, vinegar, balsamic vinegar, apple cider vinegar, red wine vinegar, rice vinegar, white vinegar, olive oil, extra virgin olive oil, vegetable oil, canola oil, sunflower oil, coconut oil, sesame oil, avocado oil, cooking spray, oil, salad dressing, dressing, ranch, vinaigrette, coconut milk, coconut cream, evaporated milk, condensed milk, sweetened condensed milk, powdered milk, tuna, canned tuna, tinned tuna, sardines, anchovies, canned salmon, spam, canned corn, canned beans, canned fruit, applesauce, apple sauce, fruit cup, pickles, gherkins, olives, capers, sun dried tomatoes, roasted peppers, artichoke hearts, jalapenos jar, breadcrumbs, bread crumbs, panko, croutons, stuffing, stuffing mix, taco shells, tortilla wraps, taco seasoning, mac and cheese, macaroni and cheese, instant noodles, cup noodles, ramen packets, rice cakes, crispbread, tahini, miso, kimchi, sauerkraut, chutney, salsa verde, harissa, gochujang, lemon juice, lime juice, coconut water carton, nuts butter, chia seeds, flaxseed, flax seeds, hemp seeds, pumpkin seeds, sunflower seeds, sesame seeds, dried beans, canned goods, tins, pantry, condiments, seaweed, nori, rice paper, wonton wrappers, pasta shells, tortellini dried, cous cous, risotto rice, pudding rice, semolina, hominy, canned soup, chili beans, ramen noodles',
      'Spices & Baking': 'salt, sea salt, kosher salt, table salt, pepper, black pepper, white pepper, peppercorns, cinnamon, ground cinnamon, cinnamon sticks, nutmeg, cloves, ground cloves, allspice, ginger powder, ground ginger, cumin, ground cumin, coriander, ground coriander, coriander seeds, paprika, smoked paprika, cayenne, cayenne pepper, chili powder, chilli powder, chili flakes, red pepper flakes, chilli flakes, curry powder, garam masala, turmeric, ground turmeric, oregano, dried oregano, thyme, dried thyme, rosemary, dried rosemary, sage, dried sage, bay leaf, bay leaves, marjoram, tarragon, dried basil, dried parsley, dried dill, italian seasoning, herbes de provence, za\'atar, sumac, cardamom, star anise, fennel seeds, mustard seeds, celery salt, garlic powder, onion powder, garlic salt, seasoning, spice, spices, spice mix, everything bagel seasoning, old bay, cajun seasoning, chinese five spice, five spice, saffron, vanilla, vanilla extract, vanilla bean, almond extract, extract, flour, all purpose flour, all-purpose flour, plain flour, self raising flour, self-rising flour, bread flour, whole wheat flour, cake flour, almond flour, coconut flour, cornmeal, cornstarch, corn starch, cornflour, arrowroot, sugar, white sugar, granulated sugar, caster sugar, brown sugar, light brown sugar, dark brown sugar, powdered sugar, icing sugar, confectioners sugar, demerara, coconut sugar, sweetener, stevia, splenda, baking soda, bicarbonate of soda, bicarb, baking powder, yeast, dry yeast, instant yeast, active dry yeast, cream of tartar, gelatin, gelatine, pectin, cocoa, cocoa powder, cacao, chocolate chips, chocolate chip, choc chips, baking chocolate, dark chocolate chips, white chocolate chips, cooking chocolate, sprinkles, food coloring, food colouring, frosting, icing, cake mix, brownie mix, muffin mix, pancake mix, waffle mix, bisquick, pie crust, pie filling, shortening, crisco, marshmallow fluff, condensed milk tin, powder, msg, bouillon powder, nutritional yeast, matcha, vanilla pod, poppy seeds, caraway seeds, dried chillies, chipotle powder, ancho chili powder, ras el hanout, peppercorn, salt and pepper, lemon pepper, garlic granules, onion flakes, desiccated coconut, shredded coconut, coconut flakes, slivered almonds, ground almonds, chopped nuts, pecans baking, candied fruit, glace cherries, raisins baking, xanthan gum, marzipan, fondant, almond meal, oat flour, rice flour, buckwheat flour, spelt flour, rye flour, semolina flour, polenta flour, sugar cubes',
      'Frozen': 'frozen pizza, pizza, ice cream, gelato, sorbet, sherbet, frozen yogurt, popsicle, popsicles, ice pop, ice lolly, ice cream sandwich, ice cream bar, ice cream cone, frozen vegetables, frozen peas, peas, frozen corn, frozen spinach, frozen broccoli, frozen fruit, frozen berries, frozen mango, frozen meals, frozen dinner, tv dinner, frozen lasagna, frozen burritos, burritos, frozen waffles, waffles, eggo, frozen pancakes, frozen fries, fries, french fries, chips frozen, oven chips, tater tots, hash browns, potato wedges, onion rings, fish sticks, fish fingers, fish cakes, chicken nuggets, nuggets, popcorn chicken, chicken strips frozen, frozen shrimp, frozen fish, dumplings, potstickers, gyoza, frozen dumplings, egg rolls, pierogi, frozen pie, pie shells, cool whip tub, ice, ice cubes, bag of ice, frozen dessert, edamame frozen, frozen edamame, veggie burgers, frozen meatballs, pizza rolls, bagel bites, hot pockets, frozen yorkshire puddings, yorkshire puddings, frozen garlic bread, frozen pastry, frozen puff pastry, frozen breakfast, frozen smoothie, smoothie packs, mochi, frozen custard, ice cream cake',
      'Snacks': 'chips, potato chips, tortilla chips, crisps, corn chips, pita chips, veggie chips, pretzels, popcorn, microwave popcorn, crackers, graham crackers, goldfish, cheez-its, ritz, rice crackers, cookies, biscuits, oreos, wafers, candy, sweets, chocolate, chocolate bar, candy bar, gummies, gummy bears, licorice, jelly beans, marshmallows, mints, gum, chewing gum, granola bar, granola bars, protein bar, cereal bar, energy bar, bar, bars, fruit snacks, fruit leather, trail mix, nuts, mixed nuts, almonds, cashews, peanuts, walnuts, pecans, pistachios, macadamia, hazelnuts, brazil nuts, pine nuts, dried fruit, raisins, dried cranberries, craisins, dates, prunes, dried apricots, dried mango, banana chips, beef jerky, jerky, meat sticks, snack, snacks, dip chips, salsa chips, popcorn kernels, peanut butter cups, peanut butter cup, chocolate chip cookies, chocolate chip cookie, rice krispie treats, pop tarts, snack cakes, twinkies, puffs, cheese puffs, cheetos, doritos, pringles, nachos, seaweed snacks, veggie straws, pork rinds, cracker, popchips, kettle chips, m&ms, skittles, kit kat, snickers, reeses, hershey, toblerone, fudge, toffee, brittle, halva, nougat, lollipop, lollipops, caramel, caramels, chocolate covered almonds, yogurt raisins, sunflower seed snacks',
      'Beverages': 'water, bottled water, sparkling water, mineral water, seltzer, club soda, tonic, tonic water, la croix, soda, pop, soft drink, soft drinks, coke, diet coke, pepsi, sprite, ginger ale, root beer, lemonade, iced tea, juice, orange juice, apple juice, cranberry juice, grape juice, grapefruit juice, pineapple juice, tomato juice, vegetable juice, v8, fruit juice, smoothie, smoothies, kombucha, energy drink, energy drinks, red bull, monster, sports drink, gatorade, powerade, electrolyte, coconut water, coffee, ground coffee, coffee beans, instant coffee, espresso, cold brew, k cups, coffee pods, nespresso pods, tea, tea bags, green tea, black tea, herbal tea, chamomile, earl grey, chai, matcha tea, hot chocolate, cocoa mix, drinking chocolate, beer, ale, lager, ipa, cider, hard cider, wine, red wine, white wine, rose, prosecco, champagne, sparkling wine, vodka, gin, rum, tequila, whiskey, whisky, bourbon, brandy, liqueur, vermouth, mixer, mixers, cordial, squash drink, syrup drink, drink mix, drinks, beverages, milkshake, protein shake, almond milk carton, oat milk barista, sake, soju, hard seltzer, white claw, non alcoholic beer, sparkling juice, ginger beer, bitters, grenadine, ice tea',
      'Household': 'paper towels, paper towel, kitchen roll, toilet paper, toilet roll, loo roll, tissues, kleenex, facial tissue, napkins, paper napkins, paper plates, plastic cups, paper cups, plastic cutlery, plastic forks, straws, aluminum foil, aluminium foil, tin foil, foil, plastic wrap, cling film, cling wrap, saran wrap, wax paper, parchment paper, baking paper, baking parchment, zip lock bags, ziploc bags, ziplock bags, sandwich bags, freezer bags, storage bags, food bags, trash bags, garbage bags, bin bags, bin liners, trash can liners, dish soap, washing up liquid, dishwashing liquid, dishwasher tablets, dishwasher pods, dishwasher detergent, rinse aid, laundry detergent, detergent, washing powder, laundry pods, tide pods, fabric softener, dryer sheets, stain remover, bleach, all purpose cleaner, cleaner, cleaning spray, disinfectant, disinfecting wipes, lysol, clorox, windex, glass cleaner, bathroom cleaner, toilet cleaner, toilet bowl cleaner, oven cleaner, floor cleaner, wood polish, furniture polish, sponge, sponges, scrubber, steel wool, scouring pad, rubber gloves, mop, broom, dustpan, duster, swiffer, swiffer pads, vacuum bags, air freshener, febreze, candles, matches, lighter, batteries, aa batteries, aaa batteries, light bulb, light bulbs, lightbulbs, extension cord, tape, duct tape, scotch tape, glue, super glue, pens, pencils, notebook, envelopes, stamps, printer paper, printer ink, coffee filters, filters, water filter, brita filter, cleaning wipes, kitchen wipes, wipes, microfiber cloths, cloths, dish cloth, tea towel, trash bag, garbage bag, bin bag, zip bags, cling, plastic bags, gift wrap, wrapping paper, cards, birthday card, firewood, charcoal, lighter fluid, bug spray, insect repellent, mouse traps, ant traps, pest control, plant food, potting soil, compost bags, laundry, softener, drain cleaner, descaler, limescale remover, washing soda, borax, vinegar cleaner, toothpicks, skewers, cupcake liners, muffin cases, birthday candles, party supplies, balloons, ice packs, lunch bags, food containers, tupperware',
      'Personal Care': 'shampoo, conditioner, dry shampoo, hair spray, hairspray, hair gel, mousse, hair dye, hair ties, bobby pins, soap, bar soap, hand soap, liquid soap, body wash, shower gel, bubble bath, bath salts, lotion, body lotion, hand cream, moisturizer, moisturiser, face cream, face wash, cleanser, toner, serum, sunscreen, sunblock, spf, after sun, aloe vera gel, lip balm, chapstick, vaseline, petroleum jelly, deodorant, antiperspirant, perfume, cologne, body spray, toothpaste, toothbrush, toothbrushes, electric toothbrush heads, floss, dental floss, mouthwash, whitening strips, razor, razors, razor blades, shaving cream, shaving gel, aftershave, cotton balls, cotton pads, cotton buds, q-tips, qtips, cotton swabs, makeup, mascara, eyeliner, lipstick, foundation, concealer, nail polish, nail polish remover, nail file, nail clippers, tweezers, makeup remover, makeup wipes, face wipes, tampons, pads, sanitary pads, panty liners, menstrual cup, condoms, lube, pregnancy test, contact lens solution, contact solution, eye drops, vitamins, multivitamin, vitamin c, vitamin d, fish oil, supplements, probiotics, melatonin, protein powder, painkillers, ibuprofen, advil, tylenol, acetaminophen, paracetamol, aspirin, aleve, allergy medicine, antihistamine, claritin, zyrtec, benadryl, cold medicine, cough syrup, cough drops, throat lozenges, nyquil, dayquil, decongestant, antacid, tums, pepto, imodium, laxative, band aids, band-aid, bandaids, plasters, bandages, first aid, antiseptic, neosporin, hydrocortisone, thermometer, hand sanitizer, hand sanitiser, sanitizer, face masks, masks, tissues travel, comb, hairbrush, hair brush, shower cap, loofah, bath sponge, epsom salt, foot cream, insoles, deodorant spray, medicine, meds, prescription, pharmacy, toiletries, dental picks, retainer cleaner, denture tablets, hearing aid batteries, reading glasses, beard oil, body butter, self tanner, hair oil, leave in conditioner, dry skin cream',
      'Baby & Pets': 'diapers, diaper, nappies, nappy, pull ups, pull-ups, baby wipes, baby wipe, wet wipes baby, baby formula, formula, infant formula, baby food, baby cereal, baby snacks, puffs baby, teething biscuits, baby bottle, bottles baby, pacifier, dummy, sippy cup, baby shampoo, baby wash, baby lotion, baby powder, diaper cream, nappy cream, rash cream, baby oil, bibs, burp cloths, baby, dog food, dry dog food, wet dog food, puppy food, dog treats, dog treat, dog chews, rawhide, dental chews, dog biscuits, cat food, dry cat food, wet cat food, kitten food, cat treats, cat treat, cat litter, kitty litter, litter, litter bags, poop bags, dog bags, pet food, pet treats, bird seed, birdseed, fish food, hamster food, rabbit food, guinea pig food, hay, pet shampoo, flea treatment, flea collar, tick treatment, flea and tick, dewormer, pet toys, dog toy, cat toy, chew toy, catnip, scratching post, pee pads, puppy pads, training pads, pet wipes, leash, collar, harness, pet bed, aquarium, fish tank, kibble',
    };
    var DICT = {}, DICT_N = 0;
    Object.keys(DICT_SRC).forEach(function (aisle) {
      DICT_SRC[aisle].split(/\s*,\s*/).forEach(function (t) {
        t = normName(t);
        if (!t) return;
        if (!DICT[t]) DICT_N++;
        DICT[t] = aisle;
      });
    });
    // Modifiers that decide the aisle on their own.
    var MOD_FROZEN = /\b(?:frozen|freezer)\b/;
    var MOD_CANNED = /\b(?:canned|tinned|cans?|tins?|jarred|jars?)\b/;
    var CANNABLE = { 'Produce': 1, 'Meat & Seafood': 1, 'Deli': 1, 'Dairy & Eggs': 1, 'Other': 1 };
    var MOD_DELI = /\b(?:deli|sliced|shaved|cold cut)\b/;
    var MOD_DRIED = /\b(?:dried|dry)\b/;
    var MOD_FRESH = /\bfresh\b/;
    // lower case, no accents (jalape\u00f1o \u2192 jalapeno), hyphens as spaces, no punctuation
    function normName(s) {
      s = String(s || '').toLowerCase();
      if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return s.replace(/\u2019/g, '\'').replace(/[^a-z0-9%&'+ ]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function lookupPhrase(words, i, n) {
      var ph = words.slice(i, i + n).join(' ');
      if (DICT[ph]) return DICT[ph];
      var last = words[i + n - 1], head = words.slice(i, i + n - 1).join(' ');
      var cands = [];
      if (/ies$/.test(last)) cands.push(last.slice(0, -3) + 'y');
      if (/oes$/.test(last)) cands.push(last.slice(0, -2));
      if (/ves$/.test(last)) cands.push(last.slice(0, -3) + 'f', last.slice(0, -3) + 'fe');
      if (/(?:ches|shes|xes|sses|zes)$/.test(last)) cands.push(last.slice(0, -2));
      if (/s$/.test(last)) cands.push(last.slice(0, -1));
      if (!/s$/.test(last)) cands.push(last + 's', last + 'es');
      for (var c = 0; c < cands.length; c++) {
        var p = (head ? head + ' ' : '') + cands[c];
        if (DICT[p]) return DICT[p];
      }
      return null;
    }
    // Item name → aisle. Phrases ending at the last word (the head noun) win,
    // longest first ("chocolate chip cookies" → Snacks, "peanut butter" →
    // Pantry); otherwise the longest phrase anywhere, rightmost first.
    function classify(name) {
      var base = stripQty(name).name, all = normName(name); // modifiers may sit in the quantity: "2 tins tomatoes"
      var bare = base.replace(/\([^)]*\)/g, ' ').replace(/\s[-–—]\s.*$/, ''); // notes: "milk (oat)", "eggs - free range"
      var r = classifyName(normName(bare), all);
      return r === 'Other' && bare !== base ? classifyName(normName(base), all) : r;
    }
    function classifyName(t, all) {
      if (!t) return 'Other';
      var words = t.split(' ').filter(function (w) { return w && !/^\d/.test(w); });
      if (!words.length) return 'Other';
      var found = null, n, i;
      for (n = Math.min(4, words.length); n >= 1 && !found; n--) found = lookupPhrase(words, words.length - n, n);
      for (n = Math.min(4, words.length - 1); n >= 1 && !found; n--) {
        for (i = words.length - 1 - n; i >= 0 && !found; i--) found = lookupPhrase(words, i, n);
      }
      var food = found !== 'Household' && found !== 'Personal Care' && found !== 'Baby & Pets';
      if (MOD_FROZEN.test(all) && food) return 'Frozen'; // (but freezer bags stay in Household)
      if (MOD_CANNED.test(all) && (!found || CANNABLE[found])) return 'Pantry'; // canned tomatoes, a tin of tuna (not tin foil / a can of soda)
      if (found === 'Meat & Seafood' && MOD_DELI.test(t)) return 'Deli';
      if (MOD_DRIED.test(t) && found === 'Produce') return /\b(?:basil|parsley|dill|mint|chives|cilantro|coriander|herbs?|chil(?:e|i|li)e?s?|peppers?|ginger|garlic)\b/.test(t) ? 'Spices & Baking' : 'Snacks';
      if (MOD_FRESH.test(t) && found === 'Spices & Baking' && /\b(?:oregano|thyme|rosemary|sage|bay|tarragon|marjoram|coriander|ginger|turmeric)\b/.test(t)) return 'Produce';
      return found || 'Other';
    }

    // ---- quantities in list items ------------------------------------------------
    var SHOP_UNITS = {
      g: ['g', 1, 'w'], gram: ['g', 1, 'w'], grams: ['g', 1, 'w'], kg: ['kg', 1000, 'w'], kgs: ['kg', 1000, 'w'], kilo: ['kg', 1000, 'w'], kilos: ['kg', 1000, 'w'],
      oz: ['oz', 1, 'iw'], ounce: ['oz', 1, 'iw'], ounces: ['oz', 1, 'iw'], lb: ['lb', 16, 'iw'], lbs: ['lb', 16, 'iw'], pound: ['lb', 16, 'iw'], pounds: ['lb', 16, 'iw'],
      ml: ['ml', 1, 'v'], l: ['l', 1000, 'v'], litre: ['l', 1000, 'v'], litres: ['l', 1000, 'v'], liter: ['l', 1000, 'v'], liters: ['l', 1000, 'v'],
      gallon: ['gal', 1, 'gal'], gallons: ['gal', 1, 'gal'], gal: ['gal', 1, 'gal'],
      dozen: ['dozen', 12, 'n'], doz: ['dozen', 12, 'n'],
    };
    var CONTAINERS = 'bag bags pack packs packet packets box boxes can cans tin tins jar jars bottle bottles carton cartons tub tubs bunch bunches head heads loaf loaves bar bars roll rolls case cases block blocks punnet punnets tray trays container containers pkg pkgs package packages piece pieces';
    var CONT_RE = new RegExp('^(?:' + CONTAINERS.split(' ').join('|') + ')$', 'i');
    // "2 x milk", "milk x2", "500g mince", "1 bag of rice", "a dozen eggs" →
    // {qty, unit: {key, factor, family}|null, name, fmt} ; qty null when none.
    function stripQty(text) {
      var s = String(text || '').trim(), m, unit = null, qty = null, fmt = null;
      var NUM = '(\\d+(?:[.,]\\d+)?|\\d+ \\d+/\\d+|\\d+/\\d+|[' + UC + '])';
      var unitOf = function (u) {
        if (!u) return null;
        var lo = u.toLowerCase().replace(/\.$/, '');
        if (SHOP_UNITS[lo]) return { key: SHOP_UNITS[lo][0], factor: SHOP_UNITS[lo][1], family: SHOP_UNITS[lo][2], text: u };
        if (CONT_RE.test(lo)) { var sg = singularize(lo).toLowerCase(); return { key: sg === 'loafe' ? 'loaf' : sg, factor: 1, family: 'c:' + (sg === 'loafe' ? 'loaf' : sg), text: u }; }
        return null;
      };
      var val = function (t) { var p = parseNum(t); return p ? p.v : null; };
      // prefix: "2 x milk", "2x milk", "x2 milk", "2 milk", "500g mince", "1 bag of rice"
      if ((m = new RegExp('^(?:[x\u00d7] ?)' + NUM + '[ \\u00a0]+(.+)$', 'i').exec(s))) {
        qty = val(m[1]); fmt = { kind: 'xpre', num: m[1] }; s = m[2];
      } else if ((m = new RegExp('^' + NUM + ' ?[x\u00d7][ \\u00a0]+(.+)$', 'i').exec(s))) {
        qty = val(m[1]); fmt = { kind: 'prex', num: m[1], sep: /x /i.test(s.slice(m[1].length).trim().slice(0, 2)) ? ' x ' : 'x ' }; s = m[2];
        fmt.raw = text.trim().slice(0, text.trim().length - m[2].length);
      } else if ((m = new RegExp('^' + NUM + '([ \\u00a0]?)([A-Za-z]+\\.?)(?:[ \\u00a0]+of)?[ \\u00a0]+(.+)$').exec(s)) && unitOf(m[3])) {
        qty = val(m[1]); unit = unitOf(m[3]); fmt = { kind: 'pre', num: m[1], gap: m[2], ofText: s.slice(m[1].length + m[2].length + m[3].length, s.length - m[4].length) }; s = m[4];
      } else if ((m = new RegExp('^' + NUM + '[ \\u00a0]+(.+)$').exec(s))) {
        qty = val(m[1]); fmt = { kind: 'pre', num: m[1], gap: '', ofText: ' ' }; s = m[2];
      } else if ((m = /^(?:a|an|one)[ \u00a0]+(dozen)[ \u00a0]+(.+)$/i.exec(s))) {
        qty = 1; unit = unitOf('dozen'); fmt = { kind: 'word' }; s = m[2];
      } else if ((m = new RegExp('^(.+?)[ \\u00a0]*(?:[x\u00d7][ \\u00a0]?' + NUM + '|\\(' + NUM + '\\)|[-\u2013:][ \\u00a0]*' + NUM + ')$', 'i').exec(s))) {
        qty = val(m[2] || m[3] || m[4]); fmt = { kind: 'suf', tail: s.slice(m[1].length) , num: m[2] || m[3] || m[4] }; s = m[1];
      } else if ((m = new RegExp('^(.+?)[ \\u00a0]+' + NUM + '([ \\u00a0]?)([A-Za-z]+)$').exec(s)) && unitOf(m[4])) {
        qty = val(m[2]); unit = unitOf(m[4]); fmt = { kind: 'sufu', num: m[2], gap: m[3] }; s = m[1];
      }
      if (qty === null) fmt = null;
      return { qty: qty, unit: unit, name: s.trim(), fmt: fmt };
    }
    function shopKey(name) {
      return normName(name).split(' ').map(function (w) {
        if (w.length > 3 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
        if (w.length > 3 && /(?:ches|shes|xes|oes)$/.test(w)) return w.slice(0, -2);
        if (w.length > 3 && /[^su]s$/.test(w)) return w.slice(0, -1);
        return w;
      }).join(' ');
    }
    function fmtShopNum(v, like) {
      if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
      if (like && /\//.test(like)) return fmtFrac(nearestFrac(v, [2, 3, 4]), false);
      if (like && new RegExp('[' + UC + ']').test(like)) return fmtFrac(nearestFrac(v, [2, 3, 4]), true);
      return fmtDec(v, 2, like && /,/.test(like));
    }
    // Sum b into a when the quantities are compatible → new body text or null.
    function mergeQty(a, b) {
      var qa = a.q, qb = b.q;
      if (qa.qty === null || qb.qty === null) return qa.qty === null && qb.qty === null ? a.body : (qa.qty !== null ? a.body : b.body);
      var ua = qa.unit, ub = qb.unit, total, unitText = ua ? ua.text : '';
      if (!ua && !ub) total = qa.qty + qb.qty;
      else if (ua && ub && ua.key === ub.key) total = qa.qty + qb.qty;
      else if (ua && ub && ua.family === ub.family && ua.family !== 'gal' && !/^c:/.test(ua.family)) {
        total = qa.qty + qb.qty * ub.factor / ua.factor;
        if (ua.family === 'w' && ua.key === 'g' && total >= 1000) { total /= 1000; unitText = 'kg'; }
        if (ua.family === 'v' && ua.key === 'ml' && total >= 1000) { total /= 1000; unitText = 'l'; }
      } else if (ua && !ub && ua.key === 'dozen') total = qa.qty + qb.qty / 12;
      else if (!ua && ub && ub.key === 'dozen') total = qa.qty + qb.qty * 12;
      else return null;
      var f = qa.fmt, num = fmtShopNum(total, f.num), name = qa.name;
      if (ua && /^c:/.test(ua.family) && ua.text.length > 2) unitText = inflectCont(ua.text, total);
      switch (f.kind) {
        case 'xpre': return 'x' + num + ' ' + name;
        case 'prex': return f.raw.replace(f.num, num) + name;
        case 'pre': return ua ? num + f.gap + unitText + f.ofText + name : num + ' ' + (total > 1 ? pluralName(name) : name);
        case 'suf': return name + f.tail.replace(f.num, num);
        case 'sufu': return name + ' ' + num + f.gap + unitText;
        case 'word': return num + ' dozen ' + name;
      }
      return null;
    }
    function inflectCont(w, n) { return n > 1 ? (isPlural(w) ? w : pluralize(w)) : (isPlural(w) ? singularize(w) : w); }
    function pluralName(name) {
      var m = /^(.*?)([A-Za-z]+)$/.exec(name);
      if (!m || isPlural(m[2]) || UNCOUNT.indexOf(' ' + m[2].toLowerCase() + ' ') >= 0 || m[2].length < 3) return name;
      return m[1] + pluralize(m[2]);
    }

    // ---- the list itself --------------------------------------------------------------
    var ITEM_RE = /^([ \t]*)((?:[-*+\u2022]|\d{1,3}[.)])[ \t]+)?(\[[ xX]\][ \t]+)?(.*)$/;
    var AISLE_ALIASES = {
      'produce': 'Produce', 'fruit & veg': 'Produce', 'fruit and veg': 'Produce', 'fruit & vegetables': 'Produce', 'fruits & vegetables': 'Produce', 'fruit and vegetables': 'Produce', 'fruits and vegetables': 'Produce', 'vegetables': 'Produce', 'fruit': 'Produce', 'veg': 'Produce',
      'bakery': 'Bakery', 'bread': 'Bakery', 'dairy & eggs': 'Dairy & Eggs', 'dairy and eggs': 'Dairy & Eggs', 'dairy': 'Dairy & Eggs', 'eggs & dairy': 'Dairy & Eggs',
      'meat & seafood': 'Meat & Seafood', 'meat and seafood': 'Meat & Seafood', 'meat': 'Meat & Seafood', 'seafood': 'Meat & Seafood', 'meat & fish': 'Meat & Seafood', 'butcher': 'Meat & Seafood',
      'deli': 'Deli', 'pantry': 'Pantry', 'dry goods': 'Pantry', 'canned goods': 'Pantry', 'spices & baking': 'Spices & Baking', 'spices and baking': 'Spices & Baking', 'baking': 'Spices & Baking', 'spices': 'Spices & Baking',
      'frozen': 'Frozen', 'frozen foods': 'Frozen', 'freezer': 'Frozen', 'snacks': 'Snacks', 'beverages': 'Beverages', 'drinks': 'Beverages', 'household': 'Household', 'cleaning': 'Household',
      'personal care': 'Personal Care', 'health & beauty': 'Personal Care', 'toiletries': 'Personal Care', 'pharmacy': 'Personal Care', 'baby & pets': 'Baby & Pets', 'baby and pets': 'Baby & Pets', 'baby': 'Baby & Pets', 'pets': 'Baby & Pets', 'pet': 'Baby & Pets', 'other': 'Other', 'misc': 'Other', 'miscellaneous': 'Other',
    };
    function aisleOf(heading) {
      var t = heading.replace(/[*_`~]/g, '').replace(/\(\d+\)\s*$/, '').replace(/^[^A-Za-z]+/, '').replace(/[:\s]+$/, '').toLowerCase().trim();
      return AISLE_ALIASES[t] || null;
    }
    // Sort a shopping list. opts.baseLevel: heading level the text sits under
    // (aisle headings go one deeper); 0 = none. → {text, items, groups, merged}
    function sortShoppingList(text, opts) {
      opts = opts || {};
      var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
      var sections = [], cur = { head: null, level: opts.baseLevel || 0, notes: [], items: [] };
      sections.push(cur);
      var lastItem = null, items = 0, fence = false;
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i];
        if (/^[ \t]*(?:```|~~~)/.test(L)) fence = !fence;
        if (fence || /^[ \t]*(?:```|~~~)/.test(L)) { cur.notes.push(L); lastItem = null; continue; }
        if (!L.trim()) { lastItem = null; continue; }
        var h = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(L), bold = /^\*\*([^*]+)\*\*:?[ \t]*$/.exec(L);
        if (h || bold) {
          var label = h ? h[2] : bold[1];
          if (aisleOf(label)) { lastItem = null; continue; } // regenerated below
          if (h) { cur = { head: L, level: h[1].length, notes: [], items: [] }; sections.push(cur); lastItem = null; continue; }
        }
        if (/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(L)) { cur = { head: L, level: cur.level, notes: [], items: [], rule: true }; sections.push(cur); lastItem = null; continue; }
        var m = ITEM_RE.exec(L), ind = m[1], marker = m[2] || '', box = m[3] || '', body = m[4];
        // a deeper-indented line belongs to the item above it
        if (lastItem && ind.length > lastItem.ind.length) { lastItem.children.push(L); continue; }
        // prose ("Buy at the market on Saturday.") and labels ("Groceries:")
        // stay put as notes
        if (!marker && !box && (body.length > 70 || /:$/.test(body) || /[.!?]$/.test(body) && /\s\S+\s\S+\s/.test(body))) { cur.notes.push(L); lastItem = null; continue; }
        // a plain first line above a bulleted list is its title ("Shopping 🛒")
        if (!marker && !box && !items && !cur.notes.length && classify(body) === 'Other') {
          var nx = i + 1;
          while (nx < lines.length && (!lines[nx].trim() || /^(?:#{1,6}[ \t]|\*\*[^*]+\*\*:?[ \t]*$)/.test(lines[nx]))) nx++;
          var nm2 = nx < lines.length ? ITEM_RE.exec(lines[nx]) : null;
          if (nm2 && (nm2[2] || nm2[3])) { cur.notes.push(L); lastItem = null; continue; }
        }
        if (!body.trim()) continue;
        var it = { ind: ind, marker: marker, box: box, checked: /\[[xX]\]/.test(box), body: body, children: [], q: stripQty(body), order: items++ };
        it.aisle = classify(body);
        it.key = shopKey(it.q.name) + '\u0000' + it.checked;
        cur.items.push(it);
        lastItem = it;
      }
      var out = [], groups = 0, merged = 0;
      var seen = 0;
      sections.forEach(function (sec) {
        if (sec.head == null && !sec.items.length && !sec.notes.length) return;
        if (seen++ && out.length && out[out.length - 1] !== '') out.push('');
        if (sec.head != null) out.push(sec.head);
        if (sec.notes.length) { if (sec.head != null && !sec.rule) out.push(''); Array.prototype.push.apply(out, sec.notes); }
        // merge duplicates (same name, same checked state)
        var byKey = {}, kept = [];
        sec.items.forEach(function (it) {
          var prev = byKey[it.key];
          if (prev && !it.children.length) {
            var body = mergeQty(prev, it);
            if (body !== null) { prev.body = body; prev.q = stripQty(body); merged++; return; }
          }
          if (!prev) byKey[it.key] = it;
          kept.push(it);
        });
        var level = Math.min(6, (sec.head != null && !sec.rule ? sec.level : sec.level || 1) + 1);
        if (sec.head == null && !opts.baseLevel) level = 2;
        var hashes = new Array(level + 1).join('#');
        AISLES.forEach(function (aisle) {
          var g = kept.filter(function (it) { return it.aisle === aisle; });
          if (!g.length) return;
          g = g.filter(function (it) { return !it.checked; }).concat(g.filter(function (it) { return it.checked; }));
          if (out.length && out[out.length - 1] !== '') out.push('');
          out.push(hashes + ' ' + aisle);
          groups++;
          var num = 1;
          g.forEach(function (it) {
            var mk = it.marker;
            if (/^\d/.test(mk)) mk = mk.replace(/^\d+/, String(num++));
            out.push(it.ind + mk + it.box + it.body);
            Array.prototype.push.apply(out, it.children);
          });
        });
      });
      while (out.length && out[out.length - 1] === '') out.pop();
      var trail = /\n$/.test(text) ? '\n' : '';
      return { text: out.join('\n') + trail, items: items, groups: groups, merged: merged };
    }
    // Level of the closest markdown heading in `before` (0 if none).
    function headingLevelAbove(before) {
      var lines = String(before || '').split('\n'), fence = false, level = 0;
      for (var i = 0; i < lines.length; i++) {
        if (/^[ \t]*(?:```|~~~)/.test(lines[i])) { fence = !fence; continue; }
        var h = !fence && /^(#{1,6})[ \t]+\S/.exec(lines[i]);
        if (h && !aisleOf(lines[i].replace(/^#+[ \t]+/, ''))) level = h[1].length;
      }
      return level;
    }

    // =========================================================================
    // Convert Recipe Units (US ↔ metric)
    // =========================================================================
    // grams per US cup for common ingredients (most specific phrase first)
    var DENSITY = [
      ['all-purpose flour|all purpose flour|plain flour|flour', 125], ['bread flour', 130], ['cake flour', 115], ['whole wheat flour|wholemeal flour', 120], ['almond flour|ground almonds|almond meal', 96], ['coconut flour', 112],
      ['brown sugar', 213], ['powdered sugar|icing sugar|confectioners', 120], ['granulated sugar|caster sugar|white sugar|sugar', 200],
      ['butter', 227], ['oil|olive oil|vegetable oil|canola oil|coconut oil', 218], ['honey|maple syrup|golden syrup|molasses|corn syrup', 340],
      ['rolled oats|oats', 90], ['uncooked rice|basmati|jasmine rice|arborio|rice', 185], ['quinoa', 170], ['couscous', 175], ['lentils', 190],
      ['cocoa', 85], ['cornstarch|cornflour|corn starch', 128], ['cornmeal|polenta', 160], ['breadcrumbs|bread crumbs|panko', 108],
      ['chocolate chips|choc chips', 170], ['raisins', 150], ['walnuts|pecans', 110], ['almonds', 143], ['peanut butter', 258], ['shredded cheese|grated cheese|cheddar|mozzarella', 113], ['parmesan', 100],
      ['milk|buttermilk|cream|water|stock|broth|juice|yogurt|yoghurt', 240], ['salt', 288], ['baking soda', 220], ['baking powder', 192],
    ].map(function (r) { return { re: new RegExp('\\b(?:' + r[0] + ')\\b', 'i'), g: r[1] }; });
    var LIQUID_RE = /\b(?:milk|buttermilk|cream|water|stock|broth|juice|wine|vinegar|beer|coffee|tea|sauce|syrup)\b/i;
    function densityFor(rest) {
      var t = rest.slice(0, 60).split(/[,;(]/)[0];
      for (var i = 0; i < DENSITY.length; i++) if (DENSITY[i].re.test(t)) return DENSITY[i];
      return null;
    }
    function fToC(f) { var c = (f - 32) * 5 / 9; return c >= 100 ? Math.round(c / 10) * 10 : Math.round(c / 5) * 5; }
    function cToF(c) { var f = c * 9 / 5 + 32; return f >= 250 ? Math.round(f / 25) * 25 : Math.round(f / 5) * 5; }
    // Which way? Count US vs metric quantities.
    function unitSystem(text) {
      var us = 0, metric = 0;
      String(text).split('\n').forEach(function (L) {
        scanLine(L).forEach(function (q) {
          if (!q.unit) return;
          var c = UNITS[q.unit.id].cls;
          if (c === 'usvol' || c === 'uswt') us++;
          else if (c === 'mwt' || c === 'mvol') metric++;
          else if (c === 'temp') { if (/[Ff]|fahrenheit/i.test(q.unit.alias)) us++; else if (/[Cc]|celsius|centigrade/i.test(q.unit.alias)) metric++; }
        });
      });
      return { us: us, metric: metric, to: us >= metric ? 'metric' : 'us' };
    }
    function convertLine(line, to) {
      var qs = scanLine(line), out = '', last = 0, n = 0;
      for (var i = 0; i < qs.length; i++) {
        var q = qs[i];
        if (!q.unit || q.start < last) continue;
        if (q.skip && q.skip !== 'temp' && q.skip !== 'per' && q.skip !== 'package') continue;
        var id = q.unit.id, cls = UNITS[id].cls, rest = line.slice(q.unit.end), rep = null;
        var vals = [q.a.v].concat(q.b ? [q.b.v] : []);
        if (cls === 'temp') {
          var isF = /[Ff]|fahrenheit/i.test(q.unit.alias), isC = /[Cc]|celsius|centigrade/i.test(q.unit.alias);
          if (!isF && !isC) { isF = q.a.v >= 250; isC = !isF; }
          if (to === 'metric' && isF) rep = vals.map(fToC).join(q.sep || '') + (q.unit.sep || '') + (/^°/.test(q.unit.alias) || /^º/.test(q.unit.alias) ? '\u00b0C' : /deg/i.test(q.unit.alias) ? 'degrees C' : 'C');
          if (to === 'us' && isC) rep = vals.map(cToF).join(q.sep || '') + (q.unit.sep || '') + (/^°/.test(q.unit.alias) || /^º/.test(q.unit.alias) ? '\u00b0F' : /deg/i.test(q.unit.alias) ? 'degrees F' : 'F');
        } else if (to === 'metric' && (cls === 'usvol' || cls === 'uswt') && id !== 'tsp' && id !== 'tbsp') {
          // (teaspoons and tablespoons are the same 5 / 15 ml spoons everywhere: kept)
          var ml = cls === 'usvol' ? UNITS[id].ml : 0, g = cls === 'uswt' ? UNITS[id].g : 0;
          var dens = cls === 'usvol' && id === 'cup' ? densityFor(rest) : null;
          if (dens && LIQUID_RE.test(rest.slice(0, 30)) && !/butter|yogurt|yoghurt/i.test(rest.slice(0, 30))) dens = null;
          var tid, conv;
          if (cls === 'uswt') { tid = 'g'; conv = vals.map(function (v) { return v * g; }); }
          else if (dens) { tid = 'g'; conv = vals.map(function (v) { return v * ml / UNITS.cup.ml * dens.g; }); }
          else { tid = 'ml'; conv = vals.map(function (v) { return v * ml; }); }
          var r = conv.map(function (v) { return fit(v, tid); });
          var outId = r[r.length - 1].id;
          r = conv.map(function (v) { return outId === tid ? fit(v, tid) : refit(v / (UNITS[outId].g || UNITS[outId].ml) * (UNITS[tid].g || UNITS[tid].ml), outId); });
          rep = r.map(function (x) { return fmtDec(x.v, 2, false); }).join(q.sep || '') + ' ' + outId;
        } else if (to === 'us' && (cls === 'mwt' || cls === 'mvol')) {
          var base = cls === 'mwt' ? UNITS[id].g : UNITS[id].ml, dens2 = cls === 'mwt' ? densityFor(rest) : null, tid2, conv2;
          if (cls === 'mwt' && dens2) { tid2 = 'cup'; conv2 = vals.map(function (v) { return v * base / dens2.g; }); }
          else if (cls === 'mwt') { tid2 = 'oz'; conv2 = vals.map(function (v) { return v * base / UNITS.oz.g; }); }
          else { tid2 = 'cup'; conv2 = vals.map(function (v) { return v * base / UNITS.cup.ml; }); }
          if (tid2 === 'oz' && conv2[conv2.length - 1] >= 16) { tid2 = 'lb'; conv2 = conv2.map(function (v) { return v / 16; }); }
          var top = fit(conv2[conv2.length - 1], tid2), oid = top.id;
          var r2 = conv2.map(function (v) { return refit(toUnit(v, tid2, oid), oid); });
          var pl = r2[r2.length - 1].v > 1 || r2.length > 1;
          rep = r2.map(function (x) { return fmtVal(x.v, x, { style: 'frac' }); }).join(q.sep || '') + ' ' + unitWord(oid, pl, oid === 'cup' ? 'cup' : 'x');
        }
        if (rep == null) continue;
        out += line.slice(last, q.start) + rep;
        last = q.unit.end;
        n++;
      }
      return { text: out + line.slice(last), n: n };
    }
    function convertText(text, to) {
      var lines = String(text).split('\n'), fence = null, n = 0;
      to = to || unitSystem(text).to;
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i], fm = /^[ \t]*(`{3,}|~{3,})/.exec(L);
        if (fm) { if (!fence) fence = fm[1].charAt(0); else if (fm[1].charAt(0) === fence) fence = null; continue; }
        if (fence || L.length > 2000 || !/\d/.test(L) || nutritionLine(L)) continue;
        var r = convertLine(L, to);
        lines[i] = r.text; n += r.n;
      }
      return { text: lines.join('\n'), changed: n, to: to };
    }

    // Smallest single replacement turning a into b (keeps the caret and scroll).
    function minimalChange(a, b) {
      var p = 0, max = Math.min(a.length, b.length);
      while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
      var s = 0;
      while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
      return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
    }

    return {
      parseNum: parseNum, nearestFrac: nearestFrac, fmtFrac: fmtFrac, fmtDec: fmtDec, fmtFactor: fmtFactor,
      scanLine: scanLine, scaleLine: scaleLine, scaleText: scaleText, findServings: findServings, parseFactor: parseFactor, fit: fit,
      pluralize: pluralize, singularize: singularize,
      AISLES: AISLES, DICT: DICT, DICT_SIZE: DICT_N, classify: classify, stripQty: stripQty, sortShoppingList: sortShoppingList, headingLevelAbove: headingLevelAbove,
      unitSystem: unitSystem, convertText: convertText, minimalChange: minimalChange,
    };
  })();

  if (typeof window === 'undefined') { // node: expose the model to kitchen-pack.test.js
    if (typeof module === 'object' && module && module.exports) module.exports = K;
    return;
  }
  if (typeof window.Cade === 'undefined') return;

  // ---------------------------------------------------------------------------
  // Palette scripts. The core runs each source in isolation, so they reach the
  // model through window.__cadeKitchen and edit the editor directly: ONE
  // minimal transaction (caret and scroll stay put; one Undo reverts it).
  // ---------------------------------------------------------------------------
  var api = {};
  for (var k in K) if (Object.prototype.hasOwnProperty.call(K, k)) api[k] = K[k];
  // The text to work on: the selection, else the whole note.
  api.target = function () {
    var ed = window.Cade && window.Cade.editor;
    if (!ed) return null;
    var st = ed.state, sel = st.selection.main;
    if (st.readOnly) { window.Cade.showToast('Read-only mode \u2014 editing is locked', 'error', 2500); return null; }
    var from = sel.empty ? 0 : sel.from, to = sel.empty ? st.doc.length : sel.to;
    return { ed: ed, from: from, to: to, text: st.sliceDoc(from, to), selection: !sel.empty, before: st.sliceDoc(Math.max(0, from - 20000), from) };
  };
  api.apply = function (t, next) {
    if (t.ed.state.readOnly || next === t.text) return false;
    var c = K.minimalChange(t.text, next);
    t.ed.dispatch({ changes: { from: t.from + c.from, to: t.from + c.to, insert: c.insert }, userEvent: 'input.kitchen', scrollIntoView: false });
    return true;
  };
  api.say = function (msg, type, ms) { setTimeout(function () { window.Cade.showToast(msg, type || 'success', ms || 3200); }, 0); };
  window.__cadeKitchen = api;

  function reg(meta, main) {
    window.Cade.registerScript('/**\n' + JSON.stringify(meta, null, 2) + '\n**/\n' + String(main));
  }

  reg({
    name: 'Scale Recipe\u2026',
    description: 'Scale every quantity by a factor (2, 0.5, x1.5) or servings (4 to 6) \u2014 kitchen-friendly fractions, skips steps, temperatures and times',
    author: 'Cade',
    icon: '\u2696\ufe0f',
    tags: 'scale,recipe,servings,double,halve,triple,multiply,portions,ingredients,cooking,kitchen,baking,quantities,fractions,resize recipe',
  }, function main(ctx) {
    var K = window.__cadeKitchen, t = K && K.target();
    if (!t) return;
    if (!t.text.trim()) { showToast('Nothing to scale \u2014 put a recipe in the note or select one', 'info', 2800); return; }
    var serves = K.findServings(t.text) || (t.selection ? K.findServings(t.before) : null);
    var hint = 'Scale the recipe by\u2026\n\u2022 a factor: 2, 0.5, x1.5, 1/2\n\u2022 servings: 4 to 6' + (serves ? '  (it serves ' + serves + ' \u2014 or just type the new number of servings, e.g. "' + (serves * 2) + ' servings")' : '');
    var ans = prompt(hint, K.lastScale || '2');
    if (ans === null) return;
    var f = K.parseFactor(ans, serves);
    if (f.error) { showToast(f.error, 'error', 4000); return; }
    K.lastScale = String(ans).trim();
    var r = K.scaleText(t.text, f.factor);
    if (!r.changed || !K.apply(t, r.text)) { showToast('No quantities found to scale' + (t.selection ? ' in the selection' : ''), 'info', 3000); return; }
    K.say('Scaled \u00d7' + K.fmtFactor(f.factor) + ' \u2014 ' + r.changed + ' quantit' + (r.changed === 1 ? 'y' : 'ies') + (r.eggs ? ' (eggs rounded to whole, exact amount noted)' : ''));
  });

  reg({
    name: 'Sort Shopping List by Aisle',
    description: 'Group the list (or note) under Produce, Dairy, Meat, Pantry\u2026 headings \u2014 keeps checkboxes, merges duplicates, checked items last',
    author: 'Cade',
    icon: '\ud83d\uded2',
    tags: 'shopping,grocery,groceries,list,aisle,sort,group,supermarket,store,produce,dairy,checklist,errands,food shopping,organize',
  }, function main(ctx) {
    var K = window.__cadeKitchen, t = K && K.target();
    if (!t) return;
    if (!t.text.trim()) { showToast('Nothing to sort \u2014 write a list or select one', 'info', 2800); return; }
    var r = K.sortShoppingList(t.text, { baseLevel: t.selection ? K.headingLevelAbove(t.before) : 0 });
    if (!r.items) { showToast('No list items found', 'info', 2500); return; }
    K.apply(t, r.text);
    K.say('Sorted ' + r.items + ' item' + (r.items === 1 ? '' : 's') + ' into ' + r.groups + ' aisle' + (r.groups === 1 ? '' : 's') + (r.merged ? ' \u00b7 merged ' + r.merged + ' duplicate' + (r.merged === 1 ? '' : 's') : ''));
  });

  reg({
    name: 'Convert Recipe Units',
    description: 'US cups / oz / lb / \u00b0F \u2194 metric g / ml / \u00b0C (picks the direction; cups of flour, sugar, butter\u2026 become grams)',
    author: 'Cade',
    icon: '\ud83e\udd44',
    tags: 'convert,units,recipe,metric,imperial,us,cups,grams,ml,ounces,pounds,fahrenheit,celsius,oven,temperature,kitchen,baking,measurements',
  }, function main(ctx) {
    var K = window.__cadeKitchen, t = K && K.target();
    if (!t) return;
    if (!t.text.trim()) { showToast('Nothing to convert \u2014 put a recipe in the note or select one', 'info', 2800); return; }
    var r = K.convertText(t.text);
    if (!r.changed || !K.apply(t, r.text)) { showToast('No US or metric quantities found to convert', 'info', 3000); return; }
    K.say('Converted ' + r.changed + ' quantit' + (r.changed === 1 ? 'y' : 'ies') + ' to ' + (r.to === 'metric' ? 'metric (g / ml / \u00b0C)' : 'US units (cups / oz / \u00b0F)'));
  });
})();
