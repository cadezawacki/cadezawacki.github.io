/* Text Adventure — "The Comet at Wrenhallow", a parser interactive fiction.
 *
 * ENGINE (DOM-free, deterministic, unit-tested in node — see tests/): a
 * data-driven world model (rooms, objects, doors, containers, light/dark,
 * NPC topics, timers, scoring, endings, graduated hints) and a parser:
 * verb + noun (+ preposition + noun) from a pattern grammar, adjectives to
 * disambiguate, it/them/him/her, ALL / ALL EXCEPT, lists with AND, polite
 * "Which key do you mean…?" questions, "What do you want to take?" follow-ups,
 * typo tolerance (one edit) for nouns and verbs, UNDO, AGAIN, named saves.
 * The story itself — every room, object, rule and line of prose — lives in
 * adventure-data.js, loaded on first open (precached for offline).
 *
 * UI: a book-page transcript (General Sans prose, JetBrains Mono input) with
 * tappable nouns (tap → "examine noun"; after a typed or tapped verb it is
 * appended instead, so TAKE + tap lantern = "take lantern"), tappable exits,
 * a compass / verb pad for phones, status bar, input history (↑/↓), autosave
 * every turn, named save slots, transcript → document, text size. It is a
 * typing game, so it does NOT take the editor's pointer away (no
 * markGamePanel); it only grabs keys while you're in it, and Esc closes it.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('adventure.css');
  var DATA_URL = Cade.asset('adventure-data.js'); // resolve now, while currentScript is us

  // ===========================================================================
  // ENGINE
  // ===========================================================================
  var DIRW = {
    north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w',
    northeast: 'ne', ne: 'ne', northwest: 'nw', nw: 'nw', southeast: 'se', se: 'se', southwest: 'sw', sw: 'sw',
    up: 'u', u: 'u', upstairs: 'u', upward: 'u', upwards: 'u', down: 'd', d: 'd', downstairs: 'd', downward: 'd', downwards: 'd',
    in: 'in', inside: 'in', indoors: 'in', out: 'out', outside: 'out', outdoors: 'out'
  };
  var DIRN = { n: 'north', ne: 'northeast', e: 'east', se: 'southeast', s: 'south', sw: 'southwest', w: 'west', nw: 'northwest', u: 'up', d: 'down', in: 'in', out: 'out' };
  var DIR_ORDER = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'u', 'd', 'in', 'out'];
  // Dropped inside noun phrases ("the", "a" and "an" are dropped everywhere).
  var NPSTOP = { some: 1, my: 1, your: 1, this: 1, that: 1, these: 1, those: 1, of: 1, one: 1, piece: 1, its: 1 };
  var PRON = { it: 1, them: 1, him: 1, her: 1 };
  // Actions that never pass time, and those still allowed once the story ends.
  var META = { score: 1, hint: 1, help: 1, verbose: 1, brief: 1, save: 1, restore: 1, restart: 1, undo: 1, quit: 1, about: 1, time: 1, exits: 1, transcript: 1, yes: 1, no: 1 };
  var MULTI = { take: 1, drop: 1, putin: 1, puton: 1, remove: 1 };
  var HELDPREF = { drop: 1, putin: 1, puton: 1, give: 1, show: 1, throw: 1, throwat: 1, wear: 1, eat: 1, drink: 1, fill: 1, pour: 1, use: 1, read: 1 };
  var SIGHT = { examine: 1, read: 1, search: 1, lookthrough: 1, lookunder: 1 };

  // Grammar: "verb words * prep % => action [flags]". * = direct object,
  // % = indirect object, $ = free text (topic), # = digits, @ = direction.
  // a|b = alternatives. Lines with more literal words are tried first.
  var GRAMMAR_SRC = [
    'look|l => look', 'look|l around => look',
    'inventory|inv|i|invent => inventory', 'take|check inventory => inventory',
    'wait|z|stay|rest => wait', 'wait for $ => wait', 'wait $ => wait',
    'undo|oops => undo', 'save => save', 'save $ => save', 'restore|load => restore', 'restore|load $ => restore',
    'restart|reset => restart', 'score|points => score', 'hint|hints|clue|clues => hint', 'help|commands|instructions|info => help',
    'verbose|long => verbose', 'brief|short|superbrief => brief', 'quit|q|stop => quit', 'about|credits => about',
    'time|clock => time', 'exits|directions|where => exits', 'transcript|script => transcript',
    'yes|y|yeah|yep|sure|ok|okay => yes', 'no|nope => no', 'xyzzy|plugh|plover|frotz => xyzzy',
    // movement
    '@ => go', 'go|walk|run|head|move|travel|proceed|climb|crawl|step @ => go', 'go|walk|run|head to|towards|toward @ => go',
    'go|walk|run|head|travel to|towards|toward $ => goto',
    'go|walk|run|climb|crawl|step into|in|inside|through|thru * => enter', 'enter|board|cross * => enter',
    'enter => goin', 'exit|leave|disembark => goout', 'get|go|climb|step out => goout', 'get|go|climb|step out of * => goout',
    'climb|scale|ascend * => climb', 'climb|go|walk up|down|over|on|onto * => climb',
    'stand|rise => stand', 'stand|get|wake up => stand', 'ride|cycle * => ride',
    // looking
    'examine|x|inspect|check|study|observe|describe|view|watch|admire|scrutinize * => examine',
    'look|l at|on * => examine', 'look|l * => examine',
    'look|l in|inside|into * => search', 'search|rummage|frisk * => search', 'search|rummage in|through|inside * => search',
    'look|l through|thru * => lookthrough', 'peer|peek|gaze|squint|look through|into|in * => lookthrough',
    'look|l under|beneath|underneath|behind * => lookunder', 'look|l @ => lookdir',
    'read|peruse|consult * => read',
    // taking & dropping
    'take|get|grab|carry|hold|collect|steal|snatch|acquire * => take', 'pick|pluck * => take', 'pick up * => take', 'pick * up => take',
    'take|get|grab|remove|pull|pluck * from|off % => remove', 'take|get|remove|pull * out of % => remove',
    'take off * => takeoff', 'take * off => takeoff', 'remove|doff * => remove',
    'drop|discard|dump|abandon|leave * => drop', 'put|set|lay|place down * => drop', 'put|set|lay|place * down => drop',
    'throw|toss|hurl|chuck|fling * => throw', 'throw|toss|hurl|chuck|fling * at|to % => throwat',
    // putting
    'put|place|insert|stick|fit|slide|slip|pop|drop|lower|dip|plug * in|into|inside|through % => putin',
    'put|place|set|lay|stand|hang|rest|fit|drop * on|onto|upon|over % => puton',
    'attach|fix|fit|connect|screw|mount * to|on|onto % => puton',
    'pour|tip|empty|spill|drip|sprinkle|splash * in|into|on|onto|over|inside % => pour', 'pour|tip|empty|spill * => pour',
    'fill|refill * with|from|at|in % => fill', 'fill|refill * => fill', 'fill up * => fill', 'fill * up => fill',
    'water * => water', 'water * with % => water',
    // opening
    'open|unfasten * => open', 'open * with|using % => unlock open', 'close|shut|slam * => close',
    'unlock * with|using % => unlock', 'unlock * => unlock', 'lock * with|using % => lock', 'lock * => lock',
    'unbolt * => unbolt', 'unbolt => unbolt', 'draw|slide back * => unbolt', 'bolt * => bolt',
    // handling
    'push|press|shove|nudge|shift|move|budge|ram|barge|shoulder|force|heave|slide * => push', 'lean on|against * => push',
    'pull|tug|yank|drag|haul|jerk|draw * => pull', 'pull|tug|yank|drag|haul * down => pull', 'pull|tug|yank|drag down * => pull',
    'pull|tug|yank|drag|haul * with|using % => pull', 'pull down * with|using % => pull', 'pull * down with|using % => pull',
    'reach|hook|catch * with|using % => pull',
    'push|press|move|shove|force * down => pull', 'push|press|move|shove|force|pull * up => push',
    'raise|lift|hoist * => lift', 'lift|raise * up => lift', 'lower * => lower',
    'turn|rotate|twist|spin|crank|swivel|adjust|wheel * => turn',
    'turn|rotate|twist|spin|move|point|adjust|swing|aim|set|change|dial|face * to|toward|towards|at $ => set',
    'set|turn|rotate|spin|dial * # => set', 'set * => turn',
    'turn|rotate|spin|point|swing|move|set|aim * @ => set',
    'dial|enter|type|key|input|punch|try # => dial', 'dial|enter|type|input # on|into * => dial',
    'turn|switch on * => switchon', 'turn|switch * on => switchon', 'turn|switch off * => switchoff', 'turn|switch * off => switchoff',
    'engage|activate|start|operate|power * => switchon', 'disengage|deactivate|stop * => switchoff',
    'light|ignite|kindle|relight|burn|strike * => light', 'light|ignite|kindle|relight|burn * with|using|from % => light',
    'extinguish|douse|snuff|quench * => extinguish', 'put|blow out * => extinguish', 'put|blow * out => extinguish',
    'oil|grease|lubricate|lube * => oil', 'oil|grease|lubricate|lube * with|using % => oil',
    'wind * => wind', 'wind up * => wind', 'wind * up => wind', 'wind * with|using % => wind', 'wind up * with|using % => wind', 'wind * up with|using % => wind',
    'cut|prune|chop|clip|snip|trim|hack|slash|sever|clear * => cut', 'cut|prune|chop|clip|snip|trim|hack|slash|clear * with|using % => cut',
    'cut|chop|clip|snip|trim|hack|slash through|away * => cut', 'cut|chop|clip|snip|trim|hack|slash through|away * with|using % => cut',
    'wedge|jam|prop|block|chock|brace|hold * with|using % => wedge', 'prop|hold|wedge|jam * open with|using % => wedge', 'prop|hold|wedge|jam|block * open => wedge',
    'wedge|jam|prop|block|chock|brace * => wedge', 'wedge|jam|stick|shove|force * in|into|under|beneath|against|between % => wedgein',
    'focus|refocus * => focus', 'focus|refocus => focus',
    'write|scribble|record|jot|note $ in|on|into % => write', 'write|scribble|sign in|on|into * => write', 'sign * => write',
    'write|scribble|sign => write', 'write|scribble $ => write',
    'eat|taste|bite|chew|lick|nibble|devour|consume * => eat', 'drink|sip|swallow|gulp|quaff * => drink', 'drink from * => drink',
    // people
    'give|offer|hand|pass|feed|trade|donate|present|return * to % => give', 'give|offer|hand|feed % * => give', 'trade|swap|exchange * with % => give', 'trade|swap|exchange * for % => tradefor',
    'show|display|present|wave * to|at % => show', 'show % * => show',
    'ask * about $ => ask', 'ask * for $ => askfor', 'ask about $ => ask', 'ask for $ => askfor', 'question|quiz|consult * about|on $ => ask',
    'tell * about $ => tell', 'tell about $ => tell', 'talk|speak|chat to|with * about $ => ask', 'talk|speak|chat about $ => ask',
    'talk|speak|chat to|with * => talk', 'talk|speak|chat => talk', 'greet|hail|address * => talk', 'hello|hi|greetings|hey|howdy|evening => talk',
    'hello|hi|hey * => talk', 'ask * => talk', 'say|shout|call|whisper $ => say', 'say|shout|call|whisper $ to * => say', 'answer $ => say',
    'feed * => feed',
    // everything else
    'wear|don * => wear', 'put on * => wear', 'put * on => wear',
    'smell|sniff|inhale * => smell', 'smell|sniff => smell', 'listen => listen', 'listen to|at * => listen', 'hear * => listen',
    'touch|feel|rub|pat|stroke|pet|poke|prod|tickle|caress|tap * => touch',
    'attack|hit|kill|punch|break|smash|kick|fight|destroy|thump|whack|bash|slap|bite * => attack', 'attack|hit|kill|break|smash * with|using % => attack',
    'jump|hop|leap|skip => jump', 'jump over|off|on|into|across|onto * => jump',
    'sing|whistle|hum|chant => sing', 'dance|twirl => dance', 'yell|shout|scream|holler|shriek => yell', 'pray => pray',
    'think|ponder|contemplate|meditate|wonder => think', 'sleep|nap|snooze|doze => sleep', 'lie|lay down => sleep', 'go to sleep|bed => sleep',
    'lie|lay|sleep on|in|upon * => lieon', 'lie|lay down on|in * => lieon', 'get into|in * => enter',
    'sit => sit', 'sit down => sit', 'sit on|in|at|upon * => sit', 'sit down on|in * => sit',
    'swim|wade|dive|paddle => swim', 'swim|wade|dive in|into * => swim',
    'dig => dig', 'dig * => dig', 'dig in|with|at|up * => dig',
    'knock => knock', 'knock on|at * => knock', 'knock * => knock',
    'wave => wave', 'wave * => wave', 'wave at|to * => wave',
    'kiss|hug|embrace|cuddle * => kiss', 'count * => count',
    'fix|repair|mend|assemble * => fix', 'fix|repair|mend * with|using % => fix',
    'shake|rattle * => shake', 'play with * => touch',
    'use|employ|utilize|utilise|apply|try * => use', 'use|apply|employ|utilize|utilise|try * on|with|in|to|at|against|for|into % => use',
    'wake|awaken|rouse * => wake', 'wake up * => wake', 'wake => stand',
    'curse|swear|damn|drat|bother|blast => swear'
  ];

  var GRAMMAR = [], VERBS = {}, LITS = {}, A_NAMES = /^[a-z]+$/;
  (function compile() {
    GRAMMAR_SRC.forEach(function (line, idx) {
      var parts = line.split('=>'), lhs = parts[0].trim().split(/\s+/), rhs = parts[1].trim().split(/\s+/);
      if (!A_NAMES.test(rhs[0])) throw new Error('grammar: bad action in ' + line);
      var els = lhs.map(function (t) {
        if (t.length === 1 && '*%$#@'.indexOf(t) !== -1) return { slot: t };
        var alts = t.split('|');
        alts.forEach(function (a) { LITS[a] = 1; });
        return { lit: alts };
      });
      if (els[0].lit) els[0].lit.forEach(function (a) { VERBS[a] = 1; });
      var lits = els.filter(function (e) { return e.lit; }).length;
      GRAMMAR.push({ els: els, act: rhs[0], open: rhs.indexOf('open') !== -1, lits: lits, idx: idx });
    });
    GRAMMAR.sort(function (a, b) { return b.lits - a.lits || a.idx - b.idx; });
  })();

  // ---- text helpers -------------------------------------------------------
  function txt(v, g) { return typeof v === 'function' ? (v(g) || '') : (v == null ? '' : String(v)); }
  function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }
  // Prose markup → plain text (for transcripts and tests).
  function plain(s) { return String(s).replace(/\[([^\]|>]*)(?:[|>][^\]]*)?\]/g, '$1').replace(/\*([^*\n]+)\*/g, '$1'); }
  function isNum(w) { return /^\d+$/.test(w); }
  function joinList(arr, conj) {
    if (arr.length < 2) return arr.join('');
    return arr.slice(0, -1).join(', ') + ' ' + (conj || 'and') + ' ' + arr[arr.length - 1];
  }
  // Damerau–Levenshtein distance <= 1. Three-letter words only forgive a swap.
  function near(a, b) {
    if (a === b) return true;
    var la = a.length, lb = b.length, i;
    if (Math.abs(la - lb) > 1) return false;
    if (la === lb) {
      var diff = [];
      for (i = 0; i < la; i++) if (a.charAt(i) !== b.charAt(i)) { diff.push(i); if (diff.length > 2) return false; }
      if (diff.length === 2) return diff[1] === diff[0] + 1 && a.charAt(diff[0]) === b.charAt(diff[1]) && a.charAt(diff[1]) === b.charAt(diff[0]);
      return la > 3;
    }
    if (Math.min(la, lb) < 3) return false;
    if (la > lb) { var t = a; a = b; b = t; }
    var j = 0, skipped = false;
    for (i = 0; i < a.length && j < b.length;) {
      if (a.charAt(i) === b.charAt(j)) { i++; j++; } else { if (skipped) return false; skipped = true; j++; }
    }
    return true;
  }

  function normalize(s) {
    return String(s).toLowerCase()
      .replace(/[‘’‛`´]/g, '\'').replace(/[“”]/g, '"').replace(/[–—]/g, '-')
      .replace(/\b(mrs|mr|ms|dr|prof|st)\./g, '$1')
      .replace(/\b(north|south)[\s-]+(east|west)\b/g, '$1$2');
  }
  function tokenize(s) {
    var t = normalize(s).replace(/'s\b/g, '').replace(/,/g, ' and ').split(/[^a-z0-9]+/);
    var out = [];
    for (var i = 0; i < t.length; i++) {
      var w = t[i];
      if (!w || w === 'the' || w === 'a' || w === 'an' || w === 'please' || w === 'kindly') continue;
      out.push(w);
    }
    while (out[0] === 'and') out.shift();
    return out;
  }
  // One typed line may hold several commands: "take lamp. go north then wait".
  function splitCommands(line) {
    var s = String(line).replace(/\b(mrs|mr|ms|dr|prof|st)\./gi, '$1').replace(/(\d)\.(?=\d)/g, '$1 ');
    if (/^\s*(write|scribble|say|save|restore|load)\b/i.test(s)) return [s.trim()];
    return s.split(/[.;!?]+|\bthen\b/i).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // Match a compiled pattern against tokens; returns every way the slots fit.
  function matchPattern(els, toks) {
    var res = [];
    (function rec(ei, ti, slots) {
      if (res.length > 12) return;
      if (ei === els.length) { if (ti === toks.length) res.push(slots.slice()); return; }
      var el = els[ei];
      if (el.lit) { if (ti < toks.length && el.lit.indexOf(toks[ti]) !== -1) rec(ei + 1, ti + 1, slots); return; }
      if (el.slot === '@') {
        if (ti < toks.length && DIRW[toks[ti]]) { slots.push({ k: '@', v: [toks[ti]] }); rec(ei + 1, ti + 1, slots); slots.pop(); }
        return;
      }
      for (var end = ti + 1; end <= toks.length; end++) {
        var seg = toks.slice(ti, end);
        if (el.slot === '#' && !isNum(toks[end - 1])) break;
        slots.push({ k: el.slot, v: seg }); rec(ei + 1, end, slots); slots.pop();
      }
    })(0, 0, []);
    return res;
  }

  // ---- the Engine ------------------------------------------------------------
  // opts.store: { list() -> [{name,t,room,score,moves}], get(name) -> rec|null, put(name, rec), del(name) }
  function Engine(D, opts) {
    opts = opts || {};
    this.D = D;
    this.store = opts.store || null;
    this.rooms = D.rooms;
    this.objs = {};
    this.order = [];
    this.vocab = {};
    this.undoStack = [];
    this.pending = null;
    this.buf = [];
    this.prefix = '';
    this.awardQ = [];
    this.lastCmd = '';
    var self = this;
    function addObj(id, def) {
      def.id = id;
      def._n = {}; def._a = {};
      (def.nouns || []).forEach(function (w) { def._n[w] = 1; self.vocab[w] = 1; });
      (def.adj || []).forEach(function (w) { def._a[w] = 1; self.vocab[w] = 1; });
      if (def.loc === undefined) def.loc = null;
      self.objs[id] = def;
      self.order.push(id);
    }
    Object.keys(D.objects).forEach(function (id) { addObj(id, D.objects[id]); });
    // Room "sc" entries become light scenery objects: 'name|alias two|alias': desc
    Object.keys(D.rooms).forEach(function (rid) {
      var sc = D.rooms[rid].sc || {};
      Object.keys(sc).forEach(function (key) {
        var aliases = key.split('|'), v = sc[key], def = typeof v === 'object' ? v : { d: v };
        var nouns = [], adj = [];
        aliases.forEach(function (al) {
          var w = al.split(/[\s-]+/);
          nouns.push(w[w.length - 1]);
          w.slice(0, -1).forEach(function (a) { adj.push(a); });
        });
        addObj(rid + ':' + aliases[0], { name: aliases[0], nouns: nouns, adj: adj, loc: rid, scenery: true, decor: true, desc: def.d, on: def.on, climb: def.climb, plural: /s$/.test(aliases[0]) && !/ss$/.test(aliases[0]) });
      });
    });
    this.g = makeApi(this);
    this.newState();
  }

  Engine.prototype.newState = function () {
    var D = this.D, s = {
      v: 1, gv: D.meta.version, room: D.meta.start, loc: {}, p: {}, f: {}, score: 0, aw: {}, moves: 0, vis: {}, tm: {}, cy: {},
      it: null, them: null, him: null, her: null, end: null, hl: {}, hu: 0, verbose: true
    };
    var self = this;
    this.order.forEach(function (id) {
      var d = self.objs[id];
      s.loc[id] = d.loc;
      s.p[id] = JSON.parse(JSON.stringify(d.props || {}));
    });
    this.s = s;
    this.pending = null;
  };

  // Restore a saved state, tolerating saves from an older data version.
  Engine.prototype.loadState = function (json) {
    var st = typeof json === 'string' ? JSON.parse(json) : json;
    if (!st || !st.loc || !this.rooms[st.room]) throw new Error('bad save');
    this.newState();
    var base = this.s;
    Object.keys(base).forEach(function (k) { if (st[k] === undefined) st[k] = base[k]; });
    this.order.forEach(function (id) {
      if (!(id in st.loc)) st.loc[id] = base.loc[id];
      if (!st.p[id]) st.p[id] = base.p[id];
    });
    this.s = st;
    this.pending = null;
  };

  Engine.prototype.serialize = function () { return JSON.stringify(this.s); };

  // ---- world queries -----------------------------------------------------
  Engine.prototype.def = function (id) { return this.objs[id]; };
  Engine.prototype.p = function (id, k) { var o = this.s.p[id]; return o ? o[k] : undefined; };
  Engine.prototype.contents = function (parent) {
    var out = [], loc = this.s.loc;
    for (var i = 0; i < this.order.length; i++) if (loc[this.order[i]] === parent) out.push(this.order[i]);
    return out;
  };
  Engine.prototype.isOpen = function (id) {
    var d = this.objs[id];
    if (!d) return false;
    return (d.openable || d.door) ? !!this.p(id, 'open') : true;
  };
  Engine.prototype.contentsVisible = function (id) {
    var d = this.objs[id];
    if (d.npc) return true;
    if (d.container) return this.isOpen(id) || !!d.transparent;
    return !!d.supporter;
  };
  Engine.prototype.isHeld = function (id) {
    var x = this.s.loc[id], guard = 0;
    while (x && guard++ < 20) {
      if (x === 'player') return true;
      if (this.rooms[x] || (this.objs[x] && this.objs[x].npc)) return false;
      x = this.s.loc[x];
    }
    return false;
  };
  Engine.prototype.owner = function (id) {
    var x = this.s.loc[id], guard = 0;
    while (x && guard++ < 20) {
      if (this.objs[x] && this.objs[x].npc) return x;
      if (x === 'player' || this.rooms[x]) return null;
      x = this.s.loc[x];
    }
    return null;
  };
  Engine.prototype.portable = function (id) {
    var d = this.objs[id];
    return !(d.npc || d.fixed || d.scenery || d.decor || d.door || id === 'me');
  };
  Engine.prototype.backdropHere = function (id) {
    var b = this.objs[id].backdrop;
    if (!b) return false;
    return typeof b === 'function' ? !!b(this.g) : b.indexOf(this.s.room) !== -1;
  };
  Engine.prototype.roomDoors = function (rid) {
    var ex = (this.rooms[rid] || {}).exits || {}, out = [];
    Object.keys(ex).forEach(function (k) { var e = ex[k]; if (e && e.door && out.indexOf(e.door) === -1) out.push(e.door); });
    return out;
  };
  Engine.prototype.lightIn = function (parent, depth) {
    if (depth > 6) return false;
    var c = this.contents(parent);
    for (var i = 0; i < c.length; i++) {
      var id = c[i], d = this.objs[id];
      if (d.light || this.p(id, 'lit')) return true;
      if ((d.container || d.supporter || d.npc) && this.contentsVisible(id) && this.lightIn(id, depth + 1)) return true;
    }
    return false;
  };
  Engine.prototype.isDark = function () {
    var R = this.rooms[this.s.room], dk = R.dark;
    if (typeof dk === 'function') dk = dk(this.g);
    if (!dk) return false;
    return !(this.lightIn('player', 0) || this.lightIn(this.s.room, 0));
  };
  Engine.prototype.scope = function () {
    var self = this, out = [], seen = {}, dark = this.isDark();
    function add(id) {
      if (seen[id]) return;
      seen[id] = 1; out.push(id);
      var d = self.objs[id];
      if ((d.container || d.supporter || d.npc) && self.contentsVisible(id)) self.contents(id).forEach(add);
    }
    this.contents('player').forEach(add);
    add('me');
    if (!dark) {
      this.contents(this.s.room).forEach(add);
      this.order.forEach(function (id) { if (self.objs[id].backdrop && self.backdropHere(id)) add(id); });
    }
    this.roomDoors(this.s.room).forEach(add);
    return out;
  };
  Engine.prototype.inScope = function (id) { return this.scope().indexOf(id) !== -1; };

  // ---- naming --------------------------------------------------------------
  Engine.prototype.nm = function (id) { return this.objs[id] ? this.objs[id].name : String(id); };
  Engine.prototype.theName = function (id) { var d = this.objs[id]; return d.proper ? d.name : 'the ' + d.name; };
  Engine.prototype.aName = function (id) {
    var d = this.objs[id];
    if (d.proper) return d.name;
    var art = d.article || (d.plural ? 'some' : (/^[aeiou]/i.test(d.name) ? 'an' : 'a'));
    return art + ' ' + d.name;
  };
  Engine.prototype.mark = function (id, withArticle) {
    var d = this.objs[id], link = '[' + d.name + (d.ref ? '|' + d.ref : '') + ']';
    if (!withArticle || d.proper) return link;
    var art = d.article || (d.plural ? 'some' : (/^[aeiou]/i.test(d.name) ? 'an' : 'a'));
    return art + ' ' + link;
  };
  Engine.prototype.theMark = function (id) { return (this.objs[id].proper ? '' : 'the ') + this.mark(id); };
  Engine.prototype.isAre = function (id) { return this.objs[id].plural ? 'are' : 'is'; };
  Engine.prototype.noteOf = function (id) { var n = txt(this.objs[id].note, this.g); return n ? ' (' + n + ')' : ''; };
  Engine.prototype.listOf = function (ids) {
    var self = this;
    return joinList(ids.map(function (id) { return self.mark(id, true) + self.noteOf(id); }));
  };

  // ---- output --------------------------------------------------------------
  Engine.prototype.say = function (text, type) {
    if (text == null || text === '' || text === true) return;
    text = String(text);
    if (this.prefix) { text = this.prefix + text; this.prefix = ''; }
    this.buf.push({ t: type || 'text', s: text });
  };
  Engine.prototype.flushAwards = function () {
    var self = this;
    this.awardQ.forEach(function (n) { self.say('(Your score has gone up by ' + n + ' point' + (n === 1 ? '' : 's') + '.)', 'note'); });
    this.awardQ = [];
  };
  Engine.prototype.flush = function () { this.flushAwards(); var b = this.buf; this.buf = []; return b; };

  Engine.prototype.clock = function () {
    var m = (this.D.meta.startMinutes || 0) + this.s.moves, h = Math.floor(m / 60) % 24, mm = m % 60;
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + (mm < 10 ? '0' : '') + mm + (h < 12 ? ' am' : ' pm');
  };
  Engine.prototype.rank = function () {
    var r = '', s = this.s.score;
    (this.D.ranks || []).forEach(function (x) { if (s >= x[0]) r = x[1]; });
    return r;
  };
  Engine.prototype.status = function () {
    var dark = this.isDark();
    return { room: dark ? 'Darkness' : this.rooms[this.s.room].name, roomId: this.s.room, score: this.s.score, max: this.D.meta.maxScore,
      moves: this.s.moves, time: this.clock(), ended: this.s.end, rank: this.rank() };
  };
  Engine.prototype.exitList = function () {
    var R = this.rooms[this.s.room], ex = R.exits || {}, self = this, out = [];
    DIR_ORDER.forEach(function (k) {
      var e = ex[k];
      if (!e) return;
      if (typeof e === 'string') e = { to: e };
      if (e.hidden && e.hidden(self.g)) return;
      if ((k === 'in' || k === 'out') && DIR_ORDER.some(function (o) { var x = ex[o]; return o !== k && o !== 'in' && o !== 'out' && x && (x === e.to || x.to === e.to); })) return;
      out.push({ dir: k, label: DIRN[k], to: self.s.vis[e.to] && !self.isDark() ? self.rooms[e.to].name : '' });
    });
    return out;
  };
  Engine.prototype.allExitDirs = function () {
    var R = this.rooms[this.s.room], ex = R.exits || {}, self = this;
    return DIR_ORDER.filter(function (k) { var e = ex[k]; return e && !(typeof e === 'object' && e.hidden && e.hidden(self.g)); });
  };

  Engine.prototype.describeRoom = function (full) {
    var s = this.s, R = this.rooms[s.room], self = this, g = this.g;
    if (this.isDark()) {
      this.say('Darkness', 'title');
      this.say(txt(R.darkDesc, g) || 'It is pitch dark. You can’t see a thing.');
      this.sayExits();
      return;
    }
    this.say(R.name, 'title');
    if (full || s.verbose || !s.vis[s.room]) this.say(txt(R.desc, g));
    var paras = [], list = [];
    function walk(parent, top) {
      self.contents(parent).forEach(function (id) {
        var d = self.objs[id];
        if (d.decor || d.door) return;
        if (d.describe) { var t = txt(d.describe, g); if (t) paras.push(t); return; }
        if (d.scenery) return;
        if (!self.p(id, 'moved') && d.initial) { paras.push(txt(d.initial, g)); return; }
        if (top) list.push(id);
      });
    }
    walk(s.room, true);
    // Contents of containers and supporters standing in the room.
    function inner(id, depth) {
      var d = self.objs[id];
      if (depth > 4 || d.npc || d.hideContents || !(d.container || d.supporter) || !self.contentsVisible(id)) return;
      var rest = [];
      self.contents(id).forEach(function (c) {
        var cd = self.objs[c];
        if (cd.scenery) return;
        if (!self.p(c, 'moved') && cd.initial) paras.push(txt(cd.initial, g)); else rest.push(c);
      });
      if (rest.length) paras.push((d.supporter ? 'On ' : 'In ') + self.theMark(id) + ' you can see ' + self.listOf(rest) + '.');
      self.contents(id).forEach(function (c) { inner(c, depth + 1); });
    }
    this.contents(s.room).forEach(function (id) { inner(id, 0); });
    if (paras.length) this.say(paras.join('\n\n'));
    if (list.length) this.say((paras.length ? 'You can also see ' : 'You can see ') + this.listOf(list) + ' here.');
    this.sayExits();
  };
  Engine.prototype.sayExits = function () {
    var x = this.exitList();
    this.buf.push({ t: 'exits', s: x.length ? 'Exits: ' + x.map(function (e) { return e.label; }).join(', ') + '.' : 'No obvious exits.', x: x.map(function (e) { return [e.dir, e.label, e.to]; }) });
  };

  Engine.prototype.enterRoom = function (to) {
    this.s.room = to;
    var first = !this.s.vis[to];
    this.describeRoom(false);
    if (!this.isDark()) this.s.vis[to] = true;
    var R = this.rooms[to];
    if (R.onEnter && (first || R.onEnterAlways)) R.onEnter(this.g);
  };

  Engine.prototype.go = function (dir) {
    var R = this.rooms[this.s.room], ex = R.exits && R.exits[dir];
    if (ex && typeof ex === 'object' && ex.hidden && ex.hidden(this.g)) ex = null;
    if (!ex) {
      var ng = R.noGo && R.noGo[dir];
      if (ng) { this.say(txt(ng, this.g)); return; }
      var avail = this.exitList().map(function (e) { return e.label; });
      this.say((dir === 'in' || dir === 'out' ? 'You’ll have to say which way.' : 'You can’t go that way.') + (avail.length ? ' (Exits: ' + avail.join(', ') + '.)' : ''));
      return;
    }
    if (typeof ex === 'string') ex = { to: ex };
    if (ex.cond) {
      var r = ex.cond(this.g);
      if (r !== true) { this.say(typeof r === 'string' ? r : 'You can’t go that way.'); return; }
    }
    if (ex.door && !this.isOpen(ex.door)) {
      if (!this.p(ex.door, 'locked')) this.say('(first opening ' + this.theName(ex.door) + ')');
      this.perform({ v: 'open', d: ex.door });
      if (!this.isOpen(ex.door)) return;
    }
    if (ex.msg) this.say(txt(ex.msg, this.g));
    this.enterRoom(ex.to);
  };

  Engine.prototype.move = function (id, to) { this.s.loc[id] = to; };
  Engine.prototype.award = function (key, pts) {
    if (this.s.aw[key]) return false;
    this.s.aw[key] = pts;
    this.s.score += pts;
    this.awardQ.push(pts);
    return true;
  };
  Engine.prototype.end = function (kind) {
    if (this.s.end) return;
    var E = (this.D.endings || {})[kind] || { title: 'The end', text: '' };
    this.s.end = kind;
    this.pending = null;
    this.flushAwards();
    this.say(txt(E.text, this.g));
    this.say('THE END — ' + E.title, 'end');
    var s = this.s, max = this.D.meta.maxScore;
    this.say('You scored ' + s.score + ' out of a possible ' + max + ', in ' + (s.moves + 1) + ' moves' + (s.hu ? ', with ' + s.hu + ' hint' + (s.hu === 1 ? '' : 's') : ', without a single hint') + '. That earns you the rank of ' + this.rank() + '.' +
      (s.score >= max ? ' A perfect score — Wrenhallow is yours in every sense.' : '') +
      '\n\nType [RESTART>restart] to play again, [UNDO>undo] to step back, or [RESTORE>restore] a saved game.', 'note');
  };

  Engine.prototype.ensureHeld = function (id) {
    if (this.isHeld(id)) return true;
    if (!this.inScope(id)) { this.say('You don’t have ' + this.theName(id) + '.'); return false; }
    if (!this.portable(id)) { this.say('You can’t carry ' + this.theName(id) + '.'); return false; }
    this.say('(first taking ' + this.theName(id) + ')');
    this.perform({ v: 'take', d: id });
    return this.isHeld(id);
  };

  Engine.prototype.hook = function (tbl, c) {
    if (!tbl) return false;
    var h = tbl[c.v];
    if (h == null) return false;
    if (typeof h === 'string') { this.say(h); return true; }
    var r = h(this.g, c);
    if (typeof r === 'string') { this.say(r); return true; }
    return r === true;
  };
  // Run an action through the rules: room, then the indirect object's
  // receivers, then the direct object's hooks, then the default.
  Engine.prototype.perform = function (c) {
    var R = this.rooms[this.s.room];
    var d = c.d ? this.objs[c.d] : null, io = c.i ? this.objs[c.i] : null;
    if (this.hook(R.on, c)) return;
    if (io && this.hook(io.rcv, c)) return;
    if (d && this.hook(d.on, c)) return;
    var f = A[c.v];
    if (f) f.call(this, c); else this.say('You can’t see any obvious way to do that.');
  };

  Engine.prototype.askFor = function (c, role, q) {
    this.pending = { kind: 'missing', c: c, role: role };
    this.pendingFresh = true;
    this.say(q, 'ask');
  };
  Engine.prototype.confirm = function (q, key) {
    this.pending = { kind: 'confirm', key: key };
    this.say(String(q).replace('(yes or no)', '([yes>yes] or [no>no])'), 'ask');
  };

  Engine.prototype.pushUndo = function (label) {
    this.undoStack.push({ s: JSON.stringify(this.s), cmd: label });
    if (this.undoStack.length > 80) this.undoStack.shift();
  };

  Engine.prototype.setPronoun = function (id) {
    var d = this.objs[id];
    if (!d || id === 'me') return;
    if (d.npc) { if (d.gender === 'her') this.s.her = id; else this.s.him = id; return; }
    if (d.plural) this.s.them = id; else this.s.it = id;
  };

  Engine.prototype.endTurn = function () {
    var s = this.s, D = this.D, g = this.g;
    s.moves++;
    if (s.end) return;
    Object.keys(s.tm).forEach(function (n) {
      s.tm[n]--;
      if (s.tm[n] <= 0) { delete s.tm[n]; if (D.timers && D.timers[n]) D.timers[n](g); }
    });
    if (D.everyTurn && !s.end) D.everyTurn(g);
    if (!s.end && D.meta.dawn && s.moves >= D.meta.dawn) this.end('dawn');
  };

  // ---- noun phrase resolution ---------------------------------------------
  Engine.prototype.matchWords = function (words, scope) {
    var full = [], adjOnly = [], self = this;
    scope.forEach(function (id) {
      var d = self.objs[id], noun = false;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (d._n[w]) noun = true;
        else if (!d._a[w]) return;
      }
      (noun ? full : adjOnly).push(id);
    });
    if (full.length) return full;
    return adjOnly;
  };
  Engine.prototype.matchPhrase = function (words, scope) {
    var ids = this.matchWords(words, scope);
    if (ids.length) return { ids: ids };
    // Plurals: "keys" → every key in sight.
    var last = words[words.length - 1], stems = [];
    if (/ies$/.test(last)) stems.push(last.slice(0, -3) + 'y');
    if (/es$/.test(last)) stems.push(last.slice(0, -2));
    if (/s$/.test(last)) stems.push(last.slice(0, -1));
    for (var k = 0; k < stems.length; k++) {
      var w2 = words.slice(0, -1).concat(stems[k]);
      ids = this.matchWords(w2, scope);
      if (ids.length) return { ids: ids, plural: true };
    }
    // Typos: one edit away from a word belonging to something in sight.
    var sv = {}, self = this, fixed = words.slice(), changed = [];
    scope.forEach(function (id) { var d = self.objs[id]; Object.keys(d._n).forEach(function (w) { sv[w] = 1; }); Object.keys(d._a).forEach(function (w) { sv[w] = 1; }); });
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (sv[w] || w.length < 3 || isNum(w)) continue;
      var cands = Object.keys(sv).filter(function (v) { return Math.abs(v.length - w.length) <= 1 && near(w, v); });
      if (cands.length === 1) { fixed[i] = cands[0]; changed.push(cands[0]); }
    }
    if (changed.length) {
      ids = this.matchWords(fixed, scope);
      if (ids.length) return { ids: ids, fixed: fixed, notes: changed };
    }
    return { ids: [] };
  };
  Engine.prototype.allFor = function (cc) {
    var self = this, v = cc.v, scope = this.scope();
    if (v === 'take') {
      return scope.filter(function (id) {
        if (!self.portable(id) || self.isHeld(id) || self.owner(id)) return false;
        var l = self.s.loc[id];
        return l === self.s.room || (self.objs[l] && !self.isHeld(l));
      });
    }
    if (v === 'remove') { var from = cc.i && cc.i[0]; return from ? this.contents(from).filter(function (id) { return self.portable(id); }) : []; }
    return this.contents('player');
  };
  Engine.prototype.prefer = function (ids, cc, role, words) {
    var self = this, v = cc.v, phrase = words.join(' ');
    var dkey = role === 'i' && cc.d && cc.d.length === 1 ? this.objs[cc.d[0]].key : null;
    var scored = ids.map(function (id) {
      var d = self.objs[id], sc = 0, held = self.isHeld(id);
      if (d.decor) sc -= 2;
      if (role === 'd' && (v === 'take' || v === 'remove')) { if (held) sc -= 3; if (self.portable(id)) sc += 2; }
      else if (role === 'd' && HELDPREF[v] && held) sc += 2;
      if (role === 'd' && d.on && d.on[v] != null) sc += 1;
      if (role === 'i' && d.rcv && d.rcv[v] != null) sc += 1;
      if (dkey && id === dkey) sc += 3;
      if (phrase === d.name.toLowerCase()) sc += 3;
      return { id: id, sc: sc };
    });
    var max = -1e9;
    scored.forEach(function (x) { if (x.sc > max) max = x.sc; });
    return scored.filter(function (x) { return x.sc === max; }).map(function (x) { return x.id; });
  };
  Engine.prototype.resolveOne = function (part, cc, role, scope, multiOk) {
    var s = this.s;
    if (part.length === 1 && PRON[part[0]]) {
      var pr = part[0], ref = pr === 'it' ? s.it : pr === 'them' ? (s.them || s.it) : pr === 'him' ? s.him : s.her;
      if ((pr === 'him' || pr === 'her') && (!ref || scope.indexOf(ref) === -1)) {
        var self0 = this, ppl = scope.filter(function (id) { var d = self0.objs[id]; return d.npc && (d.gender || 'him') === pr; });
        if (ppl.length === 1) ref = ppl[0];
      }
      if (!ref) return { err: 'I’m not sure what “' + pr + '” refers to.' };
      var refs = [].concat(ref).filter(function (id) { return scope.indexOf(id) !== -1; });
      if (!refs.length) return { err: 'You can’t see ' + (Array.isArray(ref) ? 'them' : this.theName(ref)) + ' here.' };
      return { ids: multiOk ? refs : [refs[0]] };
    }
    var m = this.matchPhrase(part, scope);
    if (!m.ids.length) {
      var self = this, shown = part.slice();
      var unknown = part.filter(function (w, i) {
        if (self.vocab[w] || isNum(w) || (/s$/.test(w) && self.vocab[w.replace(/(ies|es|s)$/, function (x) { return x === 'ies' ? 'y' : ''; })]) || (/es$/.test(w) && self.vocab[w.slice(0, -1)])) return false;
        // A typo of something that isn't here: say so in its proper spelling.
        var fix = w.length >= 4 ? Object.keys(self.vocab).filter(function (v) { return Math.abs(v.length - w.length) <= 1 && near(w, v); }) : [];
        if (fix.length === 1) { shown[i] = fix[0]; return false; }
        return true;
      });
      if (unknown.length) return { err: 'I don’t know the word “' + unknown[0] + '”.' };
      if (this.isDark()) return { err: 'It’s too dark to see anything like that.' };
      return { err: 'You can’t see any ' + shown.join(' ') + ' here.' };
    }
    var notes = m.notes ? ['(I’m assuming you mean “' + m.fixed.join(' ') + '”.)'] : [];
    if (m.plural && multiOk) return { ids: m.ids, notes: notes };
    if (m.ids.length === 1) return { ids: m.ids, notes: notes };
    var best = this.prefer(m.ids, cc, role, m.fixed || part);
    if (best.length === 1) return { ids: best, notes: notes };
    return { ask: best, words: m.fixed || part, notes: notes };
  };
  Engine.prototype.resolve = function (words, cc, role) {
    var multiOk = !!MULTI[cc.v] && role === 'd';
    var w = words.filter(function (x) { return !NPSTOP[x]; });
    if (!w.length) return { err: 'You’ll need to be a little more specific.' };
    var scope = this.scope();
    if (w[0] === 'all' || w[0] === 'everything' || w[0] === 'both' || w[0] === 'each' || w[0] === 'every') {
      if (!multiOk) return { err: 'You can’t use “' + w[0] + '” with that. Try one thing at a time.' };
      var rest = w.slice(1), excl = [], pool = this.allFor(cc);
      if (rest[0] === 'except' || rest[0] === 'but') {
        var parts0 = [], cur0 = [];
        rest.slice(1).forEach(function (x) { if (x === 'and') { if (cur0.length) parts0.push(cur0); cur0 = []; } else cur0.push(x); });
        if (cur0.length) parts0.push(cur0);
        for (var e = 0; e < parts0.length; e++) {
          var r0 = this.resolveOne(parts0[e], cc, role, scope, true);
          if (r0.err) return r0;
          excl = excl.concat(r0.ids || r0.ask || []);
        }
      } else if (rest.length) {
        var r1 = this.matchPhrase(rest, pool);
        pool = r1.ids;
      }
      var ids = pool.filter(function (id) { return excl.indexOf(id) === -1; });
      if (!ids.length) return { err: cc.v === 'take' || cc.v === 'remove' ? 'There’s nothing here to take.' : 'You aren’t carrying anything.' };
      return { ids: ids, all: true };
    }
    var parts = [], cur = [];
    w.forEach(function (x) { if (x === 'and') { if (cur.length) parts.push(cur); cur = []; } else cur.push(x); });
    if (cur.length) parts.push(cur);
    if (parts.length > 1 && !multiOk) return { err: 'You can only do that to one thing at a time.' };
    var out = [], notes = [];
    for (var i = 0; i < parts.length; i++) {
      var r = this.resolveOne(parts[i], cc, role, scope, multiOk);
      if (r.err) return r;
      if (r.ask) { r.done = out; return r; }
      notes = notes.concat(r.notes || []);
      r.ids.forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });
    }
    return { ids: out, notes: notes };
  };
  // Resolve the still-unresolved slots of a command in progress.
  Engine.prototype.resolveCC = function (cc) {
    var roles = cc.v === 'remove' ? ['i', 'd'] : ['d', 'i'];
    for (var k = 0; k < roles.length; k++) {
      var role = roles[k], wk = role + 'Words';
      if (!cc[wk] || cc[role]) continue;
      var r = this.resolve(cc[wk], cc, role);
      if (r.err) return { err: r.err };
      if (r.ask) return { ask: r.ask, role: role, words: r.words, done: r.done || [] };
      cc[role] = r.ids;
      if (r.all) cc.all = true;
      cc.notes = (cc.notes || []).concat(r.notes || []);
    }
    return { ok: true };
  };

  // ---- parsing & dispatch ------------------------------------------------
  Engine.prototype.parse = function (toks) {
    var out = [];
    for (var i = 0; i < GRAMMAR.length; i++) {
      var G = GRAMMAR[i], ms = matchPattern(G.els, toks);
      for (var k = 0; k < ms.length; k++) out.push({ G: G, slots: ms[k] });
    }
    return out;
  };
  Engine.prototype.buildCC = function (it, raw) {
    var cc = { v: it.G.act, open: it.G.open, raw: raw };
    it.slots.forEach(function (sl) {
      if (sl.k === '*') cc.dWords = sl.v;
      else if (sl.k === '%') cc.iWords = sl.v;
      else if (sl.k === '@') cc.dir = DIRW[sl.v[0]];
      else cc.topic = sl.v.join(' ');
    });
    if (cc.v === 'write') {
      var m = /^\s*\S+\s+(.+?)\s+(?:in|on|into)\s+(?:the\s+)?(?:log\s*book|logbook|log|book|page)\s*$/i.exec(raw) || /^\s*(?:write|scribble)\s+(?!in\b|on\b|into\b)(.+)$/i.exec(raw);
      if (m) cc.topic = m[1].trim();
      if (cc.dWords && !cc.iWords && /^\s*(write|scribble|sign)\s+(in|on|into)\b/i.test(raw)) { cc.iWords = cc.dWords; cc.dWords = null; cc.topic = ''; }
      if (/^\s*sign\b/i.test(raw) && cc.dWords) { cc.iWords = cc.dWords; cc.dWords = null; }
    }
    if (cc.v === 'save' || cc.v === 'restore') cc.topic = raw.replace(/^\s*\S+\s*/, '').trim();
    if (cc.v === 'set' && cc.dir && !cc.topic) cc.topic = DIRN[cc.dir];
    return cc;
  };

  // Public: run one line of input; returns output blocks.
  Engine.prototype.exec = function (line) {
    this.buf = [];
    var text = String(line == null ? '' : line).trim();
    if (!text) { this.say('I beg your pardon?', 'err'); return this.flush(); }
    if (this.pending) {
      var p = this.pending;
      this.pending = null;
      if (this.answer(p, text)) return this.flush();
    }
    var cmds = splitCommands(text);
    if (!cmds.length) { this.say('I beg your pardon?', 'err'); return this.flush(); }
    for (var k = 0; k < cmds.length; k++) {
      this.failed = false;
      if (k > 0 && cmds.length > 1) this.buf.push({ t: 'sub', s: cmds[k] });
      this.runOne(cmds[k], false);
      if (this.pending || this.failed || this.s.end) break;
    }
    return this.flush();
  };

  Engine.prototype.runOne = function (text, isAgain) {
    var toks = tokenize(text);
    if (!toks.length) { this.say('I beg your pardon?', 'err'); this.failed = true; return; }
    if (toks.length === 1 && (toks[0] === 'again' || toks[0] === 'g')) {
      if (!this.lastCmd) { this.say('There’s nothing to repeat yet.', 'err'); this.failed = true; return; }
      return this.runOne(this.lastCmd, true);
    }
    var its = this.parse(toks);
    if (!its.length) {
      // A typo in the verb? ("exmaine lantern")
      if (!VERBS[toks[0]] && !this.vocab[toks[0]] && toks[0].length >= 4) {
        var v0 = toks[0], fix = Object.keys(VERBS).filter(function (v) { return v.length >= 4 && near(v0, v); });
        if (fix.length === 1) {
          var t2 = [fix[0]].concat(toks.slice(1));
          its = this.parse(t2);
          if (its.length) { this.say('(I’m assuming you mean “' + fix[0] + '”.)', 'err'); toks = t2; }
        }
      }
    }
    if (!its.length) {
      // "take" on its own → ask what.
      var joined = toks.join(' ');
      for (var gi = 0; gi < GRAMMAR.length; gi++) {
        var els = GRAMMAR[gi].els;
        if (els.length === toks.length + 1 && els[toks.length].slot === '*' && toks.every(function (t, i) { return els[i].lit && els[i].lit.indexOf(t) !== -1; })) {
          this.pending = { kind: 'complete', prefix: joined };
          this.say('What do you want to ' + joined + '?', 'ask');
          return;
        }
      }
      this.failed = true;
      var w = toks[0];
      if (DIRW[w] && toks.length > 1) this.say('To move, just give a direction, like NORTH or GO NORTH.', 'err');
      else if (VERBS[w]) this.say('I didn’t understand that sentence. I understood the verb “' + w + '”, but not the rest. (Try something like ' + this.example(w) + '.)', 'err');
      else if (this.vocab[w]) this.say('That’s not a verb I recognise. Try starting with a verb, like EXAMINE ' + w.toUpperCase() + '.', 'err');
      else this.say('I don’t know the word “' + w + '”. (Type HELP for the kinds of things you can say.)', 'err');
      return;
    }
    var chosen = null, res = null, firstErr = null;
    for (var i = 0; i < its.length; i++) {
      var cc = this.buildCC(its[i], text);
      var r = this.resolveCC(cc);
      if (r.ok || r.ask) { chosen = cc; res = r; break; }
      if (!firstErr) firstErr = r.err;
    }
    if (!chosen) { this.say(firstErr, 'err'); this.failed = true; return; }
    if (!isAgain && chosen.v !== 'undo') this.lastCmd = text;
    if (res.ask) { this.askWhich(chosen, res); return; }
    this.execute(chosen);
  };

  Engine.prototype.example = function (w) {
    var ex = { take: 'TAKE LANTERN', put: 'PUT LENS IN EYEPIECE', give: 'GIVE LETTER TO THORNE', ask: 'ASK THORNE ABOUT COMET', unlock: 'UNLOCK GATES WITH KEY', go: 'GO NORTH', look: 'LOOK AT CLOCK', turn: 'TURN DIAL TO NORTH-EAST', set: 'SET DIALS TO 1234', open: 'OPEN DOOR' };
    return ex[w] || w.toUpperCase() + ' SOMETHING';
  };

  Engine.prototype.askWhich = function (cc, r) {
    var self = this, noun = '', words = r.words;
    for (var i = words.length - 1; i >= 0 && !noun; i--) if (r.ask.every(function (id) { return self.objs[id]._n[words[i]]; })) noun = words[i];
    if (!noun) noun = words[words.length - 1];
    if (r.done && r.done.length) cc[r.role + 'Done'] = r.done;
    this.pending = { kind: 'which', cc: cc, role: r.role, cands: r.ask };
    // Each choice is a tappable answer: [the oil can>oil can]
    this.say('Which ' + noun + ' do you mean, ' + joinList(r.ask.map(function (id) { return '[' + self.theName(id) + '>' + self.nm(id).toLowerCase() + ']'; }), 'or') + '?', 'ask');
  };

  // Handle a reply to a question; false = treat the reply as a new command.
  Engine.prototype.answer = function (p, text) {
    var toks = tokenize(text), self = this;
    if (p.kind === 'confirm') {
      var yes = /^(y|yes|yeah|yep|sure|ok|okay|go on|do it)$/.test(toks.join(' '));
      var no = /^(n|no|nope|cancel|never mind|nevermind)$/.test(toks.join(' '));
      if (!yes && !no) return false;
      if (no) { this.say(p.key === 'restart' ? 'Carrying on, then.' : 'Just as well.'); return true; }
      if (p.key === 'restart') { this.pushUndo('restart'); this.newState(); this.startText(); return true; }
      this.pushUndo(p.key);
      var f = this.D.confirms && this.D.confirms[p.key];
      if (f) f(this.g);
      this.endTurn();
      return true;
    }
    if (p.kind === 'complete') {
      if (VERBS[toks[0]] && !this.vocab[toks[0]] && !DIRW[toks[0]]) return false;
      this.failed = false;
      this.runOne(p.prefix + ' ' + text, false);
      return true;
    }
    var words = toks.filter(function (w) { return !NPSTOP[w] && w !== 'with' && w !== 'to' && w !== 'in' && w !== 'on' && w !== 'into' && w !== 'using'; });
    if (!words.length) return false;
    // A reply that is itself a command ("north", "look", "take lamp") wins
    // unless it also reads as an answer naming one of the things in question.
    var looksLikeCommand = this.parse(toks).length > 0 && !(toks.length === 1 && this.vocab[toks[0]] && !DIRW[toks[0]]);
    if (p.kind === 'which') {
      var cc = p.cc, cands = p.cands, pick = null;
      var ord = { first: 0, '1st': 0, '1': 0, second: 1, '2nd': 1, '2': 1, third: 2, '3rd': 2, '3': 2, fourth: 3, last: cands.length - 1, former: 0, latter: cands.length - 1 };
      if (words.length === 1 && ord[words[0]] != null && cands[ord[words[0]]]) pick = [cands[ord[words[0]]]];
      else if (words.length === 1 && (words[0] === 'all' || words[0] === 'both') && MULTI[cc.v] && p.role === 'd') pick = cands.slice();
      else if (words.length === 1 && (words[0] === 'either' || words[0] === 'any')) pick = [cands[0]];
      else {
        var m = this.matchWords(words, cands);
        if (!m.length) {
          var fixed = words.map(function (w) {
            var all = {};
            cands.forEach(function (id) { Object.keys(self.objs[id]._n).concat(Object.keys(self.objs[id]._a)).forEach(function (x) { all[x] = 1; }); });
            if (all[w]) return w;
            var c = Object.keys(all).filter(function (x) { return near(w, x); });
            return c.length === 1 ? c[0] : w;
          });
          m = this.matchWords(fixed, cands);
        }
        if (!m.length || (looksLikeCommand && VERBS[toks[0]] && !this.vocab[toks[0]])) return false;
        if (m.length > 1) { this.askWhich(cc, { ask: m, role: p.role, words: words }); return true; }
        pick = m;
      }
      cc[p.role] = (cc[p.role + 'Done'] || []).concat(pick);
      var r = this.resolveCC(cc);
      if (r.err) { this.say(r.err, 'err'); return true; }
      if (r.ask) { this.askWhich(cc, r); return true; }
      this.execute(cc);
      return true;
    }
    if (p.kind === 'missing') {
      if (looksLikeCommand && (VERBS[toks[0]] || DIRW[toks[0]]) && !this.vocab[toks[0]]) return false;
      var r2 = this.resolve(words, { v: p.c.v, d: p.c.d ? [p.c.d] : null }, p.role);
      if (r2.err) { if (looksLikeCommand) return false; this.say(r2.err, 'err'); return true; }
      if (r2.ask) {
        var c0 = p.c, cc2 = { v: c0.v, raw: text, topic: c0.topic, dir: c0.dir, open: c0.openAfter };
        cc2.d = c0.d ? [c0.d] : null; cc2.i = c0.i ? [c0.i] : null;
        this.askWhich(cc2, { ask: r2.ask, role: p.role, words: r2.words || words });
        return true;
      }
      var c1 = p.c, cc3 = { v: c1.v, raw: text, topic: c1.topic, dir: c1.dir, open: c1.openAfter };
      cc3.d = c1.d ? [c1.d] : null; cc3.i = c1.i ? [c1.i] : null;
      cc3[p.role] = [r2.ids[0]];
      this.execute(cc3);
      return true;
    }
    return false;
  };

  Engine.prototype.execute = function (cc) {
    var v = cc.v, self = this;
    (cc.notes || []).forEach(function (n) { self.say(n, 'err'); });
    if (META[v]) { A[v].call(this, cc); return; }
    if (this.s.end) { this.say('The story is over. Type [RESTART>restart] to play again, [UNDO>undo] to step back, or [RESTORE>restore] a saved game.', 'err'); return; }
    if (SIGHT[v] && this.isDark()) { this.say('It’s too dark to see.'); this.pushUndo(cc.raw); this.endTurn(); return; }
    this.pushUndo(cc.raw);
    this.pendingFresh = false;
    var ds = cc.d && cc.d.length ? cc.d : [null], io = cc.i && cc.i.length ? cc.i[0] : null;
    var multi = ds.length > 1 || cc.all;
    for (var k = 0; k < ds.length; k++) {
      if (multi) this.prefix = this.mark(ds[k]) + ': ';
      this.perform({ v: v, d: ds[k], i: io, topic: cc.topic, dir: cc.dir, raw: cc.raw, openAfter: cc.open });
      this.prefix = '';
      if (this.s.end || this.pending) break;
    }
    if (ds.length === 1 && ds[0]) this.setPronoun(ds[0]);
    else if (ds.length > 1) this.s.them = ds.slice();
    if (io) { var iod = this.objs[io]; if (iod && iod.npc) this.setPronoun(io); }
    this.flushAwards();
    if (this.pendingFresh) { this.pendingFresh = false; this.undoStack.pop(); return; }
    this.endTurn();
  };

  Engine.prototype.startText = function () {
    var M = this.D.meta;
    this.buf.push({ t: 'banner', s: M.title, sub: M.subtitle });
    this.say(this.D.intro);
    this.say('(New to this kind of game? Type [HELP>help]. Stuck? Type [HINT>hint]. Your progress saves itself every turn.)', 'note');
    this.enterRoom(this.s.room);
  };
  Engine.prototype.start = function () { this.buf = []; this.newState(); this.undoStack = []; this.startText(); return this.flush(); };
  Engine.prototype.look = function () { this.buf = []; this.describeRoom(true); return this.flush(); };

  // ---- topics ----------------------------------------------------------------
  Engine.prototype.topicReply = function (npc, topic) {
    var d = this.objs[npc], g = this.g, words = tokenize(topic || '').filter(function (w) { return !NPSTOP[w]; });
    var best = null, bestN = 0, keys = Object.keys(d.topics || {});
    keys.forEach(function (k) {
      var kw = k.split(/\s+/), n = 0;
      words.forEach(function (w) { if (kw.indexOf(w) !== -1 || kw.some(function (x) { return x.length >= 5 && near(w, x); })) n++; });
      if (n > bestN) { bestN = n; best = k; }
    });
    return best ? txt(d.topics[best], g) : txt(d.dflt, g) || cap(this.theName(npc)) + ' has nothing to say about that.';
  };
  Engine.prototype.npcHere = function () {
    var self = this;
    return this.scope().filter(function (id) { return self.objs[id].npc; });
  };

  // ---- default actions ---------------------------------------------------
  var A = {};
  function the(e, id) { return e.theName(id); }
  function The(e, id) { return cap(e.theName(id)); }

  A.look = function () { this.describeRoom(true); };
  A.inventory = function () {
    var self = this, lines = [];
    (function walk(parent, depth) {
      self.contents(parent).forEach(function (id) {
        lines.push(new Array(depth + 1).join('    ') + self.mark(id, true) + self.noteOf(id));
        var d = self.objs[id];
        if ((d.container || d.supporter) && self.contentsVisible(id) && depth < 4) walk(id, depth + 1);
      });
    })('player', 1);
    this.say(lines.length ? 'You are carrying:\n' + lines.join('\n') : 'You are empty-handed.');
  };
  A.examine = function (c) {
    var d = this.objs[c.d], g = this.g, t = txt(d.desc, g);
    if (!t) t = d.npc ? The(this, c.d) + ' looks back at you.' : 'You see nothing special about ' + the(this, c.d) + '.';
    this.say(t);
    if ((d.container || d.supporter) && !d.hideContents && !d.npc) {
      var self = this, inside = this.contents(c.d).filter(function (x) { return !self.objs[x].scenery; });
      if (this.contentsVisible(c.d) && inside.length) this.say((d.supporter ? 'On ' : 'In ') + the(this, c.d) + ' you can see ' + this.listOf(inside) + '.');
    }
  };
  A.search = function (c) {
    var d = this.objs[c.d], self = this;
    if (!(d.container || d.supporter) || d.npc) { this.say('You find nothing of interest.'); return; }
    if (!this.contentsVisible(c.d)) { this.say(The(this, c.d) + ' ' + this.isAre(c.d) + ' closed.'); return; }
    var inside = this.contents(c.d).filter(function (x) { return !self.objs[x].scenery; });
    this.say(inside.length ? (d.supporter ? 'On ' : 'In ') + the(this, c.d) + ' you can see ' + this.listOf(inside) + '.' : 'There’s nothing ' + (d.supporter ? 'on ' : 'in ') + the(this, c.d) + '.');
  };
  A.lookunder = function (c) { this.say(this.objs[c.d].npc ? 'That would be rude.' : 'You find nothing of interest under ' + the(this, c.d) + '.'); };
  A.lookthrough = function (c) {
    var d = this.objs[c.d];
    if (/window|porthole|pane|glass/.test(Object.keys(d._n).join(' '))) { A.examine.call(this, c); return; }
    this.say('You can’t see through ' + the(this, c.d) + '.');
  };
  A.lookdir = function (c) {
    var ex = (this.rooms[this.s.room].exits || {})[c.dir];
    if (!ex || (typeof ex === 'object' && ex.hidden && ex.hidden(this.g))) { this.say('You see nothing special in that direction.'); return; }
    var to = typeof ex === 'string' ? ex : ex.to;
    this.say(this.s.vis[to] ? 'That way lies ' + this.rooms[to].name + '.' : 'There’s a way ' + DIRN[c.dir] + ' from here.');
  };
  A.read = function (c) {
    var d = this.objs[c.d], t = txt(d.text, this.g);
    if (t) this.say(t);
    else if (d.npc) this.say('You can’t read ' + d.name + ' like a book. (Try TALK TO ' + d.name.toUpperCase() + '.)');
    else this.say('There’s nothing written on ' + the(this, c.d) + '.');
  };
  A.go = function (c) { this.go(c.dir); };
  A.goto = function (c) {
    var R = this.rooms[this.s.room], ex = R.exits || {}, words = tokenize(c.topic || '').filter(function (w) { return !NPSTOP[w]; }), self = this, hit = null;
    DIR_ORDER.forEach(function (k) {
      var e = ex[k]; if (!e || hit) return;
      var to = typeof e === 'string' ? e : e.to, name = self.rooms[to].name.toLowerCase();
      if (words.length && words.every(function (w) { return name.indexOf(w) !== -1; })) hit = k;
    });
    if (hit) { this.go(hit); return; }
    this.say('You’ll need to say which way to go — for example, NORTH or GO WEST. (Exits: ' + this.exitList().map(function (e) { return e.label; }).join(', ') + '.)');
  };
  A.enter = function (c) {
    var d = this.objs[c.d];
    if (d.door) {
      var ex = this.rooms[this.s.room].exits || {}, dir = null;
      DIR_ORDER.forEach(function (k) { if (!dir && ex[k] && ex[k].door === c.d) dir = k; });
      if (dir) { this.go(dir); return; }
    }
    if (d.enter) { this.go(d.enter); return; }
    if (d.climb) { this.go(d.climb); return; }
    this.say(d.npc ? 'That would be very rude.' : 'That’s not something you can enter.');
  };
  A.goin = function () { this.go('in'); };
  A.goout = function () { this.go('out'); };
  A.climb = function (c) {
    var d = this.objs[c.d];
    if (d.climb) { this.go(d.climb); return; }
    if (d.door) { A.enter.call(this, c); return; }
    this.say(d.npc ? 'That would be a strange way to make friends.' : 'You can’t climb that.');
  };
  A.stand = function () { this.say('You are already standing — eager, even.'); };
  A.ride = function () { this.say('You can’t ride that.'); };
  A.take = function (c) {
    var id = c.d, d = this.objs[id];
    if (id === 'me') { this.say('You are always self-possessed.'); return; }
    if (this.s.loc[id] === 'player') { this.say('You already have ' + (d.plural ? 'them' : 'that') + '.'); return; }
    if (d.npc) { this.say(The(this, id) + ' wouldn’t care for that at all.'); return; }
    if (d.door) { this.say('It’s attached to its hinges, and its hinges are attached to the house.'); return; }
    if (d.decor) { this.say('That’s not something you can carry.'); return; }
    if (d.fixed || d.scenery) { this.say(txt(d.fixedMsg, this.g) || (d.scenery ? 'That’s hardly portable.' : 'That’s fixed in place.')); return; }
    var own = this.owner(id);
    if (own) { this.say('That belongs to ' + the(this, own) + '.'); return; }
    var from = this.s.loc[id];
    this.move(id, 'player');
    this.s.p[id].moved = true;
    this.say(this.isHeld(from) ? 'You take ' + the(this, id) + ' out of ' + the(this, from) + '.' : 'Taken.');
  };
  A.remove = function (c) {
    if (!c.i) { A.take.call(this, c); return; }
    if (this.s.loc[c.d] !== c.i) { this.say(The(this, c.d) + ' ' + this.isAre(c.d) + ' not in ' + the(this, c.i) + '.'); return; }
    A.take.call(this, c);
  };
  A.takeoff = function (c) { this.say('You aren’t wearing ' + the(this, c.d) + '.'); };
  A.drop = function (c) {
    if (!this.isHeld(c.d)) { this.say('You aren’t carrying ' + (this.objs[c.d].plural ? 'them' : 'that') + '.'); return; }
    this.move(c.d, this.s.room);
    this.s.p[c.d].moved = true;
    this.say('Dropped.');
  };
  A.throw = function (c) {
    if (!this.isHeld(c.d)) { this.say('You aren’t holding ' + the(this, c.d) + '.'); return; }
    this.move(c.d, this.s.room);
    this.say('You toss ' + the(this, c.d) + ' a little way. It lands on the floor, unimpressed.');
  };
  A.throwat = function (c) {
    if (!this.isHeld(c.d)) { this.say('You aren’t holding ' + the(this, c.d) + '.'); return; }
    if (this.objs[c.i].npc) { this.say('Throwing things at ' + the(this, c.i) + ' would not win you any friends.'); return; }
    this.move(c.d, this.s.room);
    this.say(The(this, c.d) + ' bounces off ' + the(this, c.i) + ' and lands on the floor.');
  };
  A.putin = function (c) {
    var T = this.objs[c.i];
    if (c.d === c.i) { this.say('You can’t put something inside itself.'); return; }
    if (T.npc) { this.say('Try GIVE ' + this.nm(c.d).toUpperCase() + ' TO ' + T.name.toUpperCase() + '.'); return; }
    if (!T.container) { if (T.supporter) { A.puton.call(this, c); return; } this.say('You can’t put things in ' + the(this, c.i) + '.'); return; }
    if (!this.isOpen(c.i)) { this.say(The(this, c.i) + ' ' + this.isAre(c.i) + ' closed.'); return; }
    var x = c.i, guard = 0;
    while (x && guard++ < 20) { if (x === c.d) { this.say('You can’t put something inside itself.'); return; } x = this.s.loc[x]; }
    if (this.s.loc[c.d] === c.i) { this.say(The(this, c.d) + ' ' + this.isAre(c.d) + ' already there.'); return; }
    if (!this.ensureHeld(c.d)) return;
    this.move(c.d, c.i);
    this.say('You put ' + the(this, c.d) + ' in ' + the(this, c.i) + '.');
  };
  A.puton = function (c) {
    var T = this.objs[c.i];
    if (c.d === c.i) { this.say('You can’t put something on itself.'); return; }
    if (T.npc) { this.say('Try GIVE ' + this.nm(c.d).toUpperCase() + ' TO ' + T.name.toUpperCase() + '.'); return; }
    if (!T.supporter) { if (T.container) { A.putin.call(this, c); return; } this.say('There’s no good surface on ' + the(this, c.i) + '.'); return; }
    if (!this.ensureHeld(c.d)) return;
    this.move(c.d, c.i);
    this.say('You put ' + the(this, c.d) + ' on ' + the(this, c.i) + '.');
  };
  A.pour = function (c) { this.say(c.i ? 'You can’t pour ' + the(this, c.d) + ' into ' + the(this, c.i) + '.' : 'You can’t pour that.'); };
  A.fill = function (c) { this.say('You can’t fill ' + the(this, c.d) + '.'); };
  A.water = function (c) { this.say(The(this, c.d) + ' ' + (this.objs[c.d].plural ? 'don’t' : 'doesn’t') + ' need watering.'); };
  A.open = function (c) {
    var id = c.d, d = this.objs[id], g = this.g;
    if (!(d.openable || d.door)) { this.say(d.npc ? 'That would hurt.' : 'That’s not something you can open.'); return; }
    if (this.isOpen(id)) { this.say(The(this, id) + ' ' + this.isAre(id) + ' already open.'); return; }
    if (this.p(id, 'locked')) {
      if (d.key && this.isHeld(d.key)) { this.say('(first unlocking ' + the(this, id) + ' with ' + the(this, d.key) + ')'); this.s.p[id].locked = false; }
      else { this.say(The(this, id) + ' ' + this.isAre(id) + ' locked.'); return; }
    }
    this.s.p[id].open = true;
    var self = this, inside = d.container ? this.contents(id).filter(function (x) { return !self.objs[x].scenery; }) : [];
    this.say(inside.length ? 'Opening ' + the(this, id) + ' reveals ' + this.listOf(inside) + '.' : 'You open ' + the(this, id) + '.');
    void g;
  };
  A.close = function (c) {
    var id = c.d, d = this.objs[id];
    if (!(d.openable || d.door)) { this.say('That’s not something you can close.'); return; }
    if (!this.isOpen(id)) { this.say(The(this, id) + ' ' + this.isAre(id) + ' already closed.'); return; }
    this.s.p[id].open = false;
    this.say('You close ' + the(this, id) + '.');
  };
  A.unlock = function (c) {
    var id = c.d, d = this.objs[id];
    if (!d.lockable) { this.say(d.npc ? 'That isn’t how people work.' : 'That doesn’t seem to have a lock.'); return; }
    if (!this.p(id, 'locked')) {
      if (c.openAfter && !this.isOpen(id)) { A.open.call(this, c); return; }
      this.say(The(this, id) + ' ' + this.isAre(id) + 'n’t locked.'); return;
    }
    var key = c.i;
    if (!key) {
      if (d.key && this.isHeld(d.key)) { key = d.key; this.say('(with ' + the(this, key) + ')'); }
      else { this.askFor(c, 'i', 'What do you want to unlock ' + the(this, id) + ' with?'); return; }
    }
    if (key !== d.key) { this.say(this.objs[key]._n.key ? The(this, key) + ' doesn’t fit the lock.' : 'You can’t unlock anything with ' + the(this, key) + '.'); return; }
    if (!this.ensureHeld(key)) return;
    this.s.p[id].locked = false;
    this.say('You unlock ' + the(this, id) + '.');
    if (c.openAfter) A.open.call(this, c);
  };
  A.lock = function (c) {
    var id = c.d, d = this.objs[id];
    if (!d.lockable) { this.say('That doesn’t seem to have a lock.'); return; }
    if (this.p(id, 'locked')) { this.say('It’s already locked.'); return; }
    if (this.isOpen(id)) { this.say('You’d have to close it first.'); return; }
    var key = c.i || (d.key && this.isHeld(d.key) ? d.key : null);
    if (!key) { this.say('You have nothing to lock it with.'); return; }
    if (key !== d.key) { this.say('That doesn’t fit the lock.'); return; }
    this.s.p[id].locked = true;
    this.say('You lock ' + the(this, id) + '.');
  };
  A.unbolt = function (c) { this.say(c.d ? 'That has no bolt.' : 'There’s nothing here to unbolt.'); };
  A.bolt = function () { this.say('There’s nothing here to bolt.'); };
  A.push = function (c) {
    var d = this.objs[c.d];
    if (d.npc) this.say(The(this, c.d) + ' would rather you didn’t.');
    else if (!this.portable(c.d)) this.say('It doesn’t budge.');
    else this.say('Pushing ' + the(this, c.d) + ' about achieves nothing in particular.');
  };
  A.pull = function (c) {
    var d = this.objs[c.d];
    if (d.npc) this.say(The(this, c.d) + ' would rather you didn’t.');
    else this.say(this.portable(c.d) ? 'Nothing happens, except that you are now holding ' + the(this, c.d) + ' at a slightly different angle.' : 'It doesn’t budge.');
  };
  A.lift = function (c) { A.pull.call(this, c); };
  A.lower = function (c) { A.push.call(this, c); };
  A.tradefor = function (c) {
    var here = this.npcHere();
    if (here.length === 1) { this.perform({ v: 'give', d: c.d, i: here[0] }); return; }
    this.say(here.length ? 'Who do you want to trade with?' : 'There’s nobody here to trade with.');
  };
  A.turn = function (c) { this.say(this.objs[c.d].npc ? 'That would be rude.' : 'Nothing obvious happens.'); };
  A.set = function (c) { this.say('You can’t set ' + the(this, c.d) + ' to anything.'); };
  A.dial = function () { this.say('There’s nothing here to dial a number on.'); };
  A.switchon = function (c) { this.say('That’s not something you can switch on.'); void c; };
  A.switchoff = function (c) { this.say('That’s not something you can switch off.'); void c; };
  A.light = function (c) { this.say('You can’t light ' + the(this, c.d) + '.'); };
  A.extinguish = function (c) {
    if (!this.p(c.d, 'lit')) { this.say('That isn’t lit.'); return; }
    this.s.p[c.d].lit = false;
    this.say('You put out ' + the(this, c.d) + '.');
  };
  A.oil = function (c) { this.say(The(this, c.d) + ' ' + (this.objs[c.d].plural ? 'don’t' : 'doesn’t') + ' need oiling.'); };
  A.wind = function (c) { this.say(this.objs[c.d].npc ? 'That isn’t how people work.' : The(this, c.d) + ' ' + (this.objs[c.d].plural ? 'don’t' : 'doesn’t') + ' need winding.'); };
  A.cut = function (c) { this.say(c.i ? 'You can’t cut ' + the(this, c.d) + ' with ' + the(this, c.i) + '.' : 'Cutting ' + the(this, c.d) + ' wouldn’t achieve anything useful.'); };
  A.wedge = function () { this.say('There’s nothing here worth wedging.'); };
  A.wedgein = function (c) { this.perform({ v: 'wedge', d: c.i, i: c.d }); };
  A.focus = function (c) {
    if (!c.d) {
      if (this.inScope('telescope')) { this.perform({ v: 'focus', d: 'telescope' }); return; }
      this.say('You focus on the task in hand.'); return;
    }
    this.say('You can’t focus ' + the(this, c.d) + '.');
  };
  A.write = function () { this.say('You have nothing here to write on.'); };
  A.eat = function (c) {
    var d = this.objs[c.d];
    if (!d.edible) { this.say(d.npc ? 'Certainly not.' : 'That’s plainly inedible.'); return; }
    this.move(c.d, null);
    this.say('You eat ' + the(this, c.d) + '. Delicious.');
  };
  A.drink = function () { this.say('You can’t drink that.'); };
  A.give = function (c) {
    var T = this.objs[c.i];
    if (!T.npc) { this.say('You can’t give things to ' + the(this, c.i) + '.'); return; }
    if (!this.isHeld(c.d)) { this.say('You aren’t holding ' + the(this, c.d) + '.'); return; }
    this.say(The(this, c.i) + ' doesn’t seem interested in ' + the(this, c.d) + '.');
  };
  A.show = function (c) {
    var T = this.objs[c.i];
    if (!T.npc) { this.say(The(this, c.i) + ' is unmoved.'); return; }
    this.say(The(this, c.i) + ' glances at ' + the(this, c.d) + ' politely.');
  };
  A.feed = function (c) { this.say(this.objs[c.d].npc ? The(this, c.d) + ' isn’t hungry.' : 'You can’t feed that.'); };
  A.ask = function (c) {
    var id = c.d;
    if (!id) {
      var here = this.npcHere();
      if (here.length !== 1) { this.say(here.length ? 'Who do you want to ask?' : 'There’s nobody here to ask.'); return; }
      id = here[0];
      this.setPronoun(id);
      this.perform({ v: c.v, d: id, topic: c.topic });
      return;
    }
    var d = this.objs[id];
    if (!d.npc) { this.say('You get no answer. ' + The(this, id) + ' ' + this.isAre(id) + ' not much of a conversationalist.'); return; }
    this.say(this.topicReply(id, c.topic));
  };
  A.askfor = A.ask;
  A.tell = A.ask;
  A.talk = function (c) {
    var id = c.d;
    if (!id) {
      var here = this.npcHere();
      if (!here.length) { this.say('You talk to yourself for a while. You are very understanding.'); return; }
      if (here.length > 1) { this.say('Who do you want to talk to?'); return; }
      this.setPronoun(here[0]);
      this.perform({ v: 'talk', d: here[0] });
      return;
    }
    var d = this.objs[id];
    if (!d.npc) { this.say('You get no answer. ' + The(this, id) + ' ' + this.isAre(id) + ' not much of a conversationalist.'); return; }
    this.say(txt(d.talk, this.g) || The(this, id) + ' nods at you.');
  };
  A.say = function (c) {
    var here = this.npcHere();
    this.say(here.length ? 'You say it out loud. (To talk to someone, try ASK ' + this.nm(here[0]).toUpperCase() + ' ABOUT something.)' : 'You say it out loud. The house listens, and keeps its own counsel.');
    void c;
  };
  A.wear = function (c) { this.say('You can’t wear ' + the(this, c.d) + '.'); };
  A.smell = function (c) { this.say(c.d ? 'It smells much as you’d expect.' : (this.isDark() ? 'Damp stone, and old dust.' : 'Night air, dust, and old secrets.')); };
  A.listen = function (c) {
    if (c.d) { this.say('You hear nothing unexpected.'); return; }
    var r = this.s.room;
    this.say(r === 'wheelpit' || r === 'cellar' ? (this.p('sluice', 'open') ? 'Rushing water, and the groan of the wheel.' : 'A slow drip, somewhere.') : 'You hear the house settling, the way old houses do, and somewhere outside an owl — a real one.');
  };
  A.touch = function (c) { this.say(this.objs[c.d].npc ? The(this, c.d) + ' tolerates this.' : 'It feels much as you’d expect.'); };
  A.attack = function (c) { this.say(this.objs[c.d].npc ? 'Violence isn’t the answer to this one. (It rarely is.)' : 'Breaking things in your aunt’s house would be a poor way to say thank you.'); };
  A.jump = function () { this.say('You jump on the spot. Nothing happens, except that you are briefly taller.'); };
  A.sing = function () { this.say('You hum a few bars of something. The house listens politely.'); };
  A.dance = function () { this.say('You dance a few steps. Nobody is watching, which is the best way to dance.'); };
  A.yell = function () { this.say('You yell. Somewhere, a rook complains.'); };
  A.pray = function () { this.say('You send a small hope skywards, which is where you’re going to be looking anyway.'); };
  A.think = function () { this.say('You think hard. It helps, a little. ([HINT>hint] helps more.)'); };
  A.sleep = function () { this.say('There’ll be time to sleep after the comet. About eighty-one years of it, if you like.'); };
  A.lieon = function (c) { this.say('You can’t lie on ' + the(this, c.d) + ' — not comfortably, anyway.'); };
  A.sit = function (c) { this.say(c.d ? 'You can’t sit on ' + the(this, c.d) + '.' : 'You sit down for a moment, then get up again. The comet won’t wait.'); };
  A.swim = function () { this.say('There’s nowhere to swim here.'); };
  A.dig = function () { this.say('The ground here isn’t for digging.'); };
  A.knock = function (c) { this.say(c.d ? (this.objs[c.d].door ? 'You knock. Nobody answers.' : 'You knock on ' + the(this, c.d) + '. It doesn’t answer.') : 'Knock on what?'); };
  A.wave = function () { this.say('You wave. Nobody waves back.'); };
  A.kiss = function (c) { this.say(this.objs[c.d].npc ? 'That isn’t the sort of night this is.' : 'You kiss ' + the(this, c.d) + '. It doesn’t kiss you back.'); };
  A.count = function (c) { this.say('You count ' + the(this, c.d) + ': one. Satisfying.'); };
  A.fix = function () { this.say('You can’t see how to mend that.'); };
  A.shake = function (c) { this.say('You shake ' + the(this, c.d) + '. Nothing happens.'); };
  A.wake = function (c) { this.say(this.objs[c.d].npc ? The(this, c.d) + ' is already awake.' : 'That isn’t asleep.'); };
  A.swear = function () { this.say('Steady on.'); };
  A.xyzzy = function () { this.say('A hollow voice says “Fool.” Then, more kindly: “Sorry — old habit. Try HINT.”'); };
  A.use = function (c) {
    if (!c.i) {
      if (this.portable(c.d)) { this.askFor(c, 'i', 'What do you want to use ' + the(this, c.d) + ' on?'); return; }
      this.say('You’ll need to be more specific about how to use ' + the(this, c.d) + '. Try a more particular verb: OPEN, PUSH, PULL, TURN, LIGHT, PUT…IN, UNLOCK…WITH.');
      return;
    }
    var T = this.objs[c.i];
    if (T.lockable && this.objs[c.d]._n.key) { this.perform({ v: 'unlock', d: c.i, i: c.d }); return; }
    if (T.npc) { this.perform({ v: 'give', d: c.d, i: c.i }); return; }
    this.say('You can’t see an obvious way to use ' + the(this, c.d) + ' on ' + the(this, c.i) + '. Try a more particular verb.');
  };
  A.wait = function () { this.say('Time passes.'); };

  // ---- meta actions --------------------------------------------------------
  A.score = function () {
    var s = this.s;
    this.say('You have scored ' + s.score + ' out of a possible ' + this.D.meta.maxScore + ', in ' + s.moves + ' move' + (s.moves === 1 ? '' : 's') + '. That gives you the rank of ' + this.rank() + '. It is ' + this.clock() + '.');
  };
  A.time = function () { this.say('It is ' + this.clock() + '. Hesper fades at dawn, around six.'); };
  A.exits = function () {
    var x = this.exitList();
    if (this.s.end) { this.say('The story is over.'); return; }
    this.sayExits();
    void x;
  };
  A.help = function () { this.say(this.D.help, 'help'); };
  A.about = function () { this.say(this.D.about, 'help'); };
  A.verbose = function () { this.s.verbose = true; this.say('Verbose mode: full room descriptions every time.'); };
  A.brief = function () { this.s.verbose = false; this.say('Brief mode: full descriptions only the first time you visit a place (LOOK shows them again).'); };
  A.quit = function () { this.say('To stop playing, just close this panel. The story saves itself every turn and will be waiting when you come back.'); };
  A.transcript = function () { this.say('Use the ⋯ menu → “Insert transcript into document” to paste this story into your document.'); };
  A.yes = function () { this.say('That was a rhetorical question.'); };
  A.no = function () { this.say('You sound very sure.'); };
  A.restart = function () { this.confirm('Restart the story from the very beginning? (yes or no)', 'restart'); };
  A.undo = function () {
    var u = this.undoStack.pop();
    if (!u) { this.say('There’s nothing to undo.', 'err'); return; }
    this.s = JSON.parse(u.s);
    this.pending = null;
    this.say('Taken back: “' + (u.cmd || 'last move') + '”.', 'note');
    var dark = this.isDark();
    this.say(dark ? 'Darkness' : this.rooms[this.s.room].name, 'title');
    this.sayExits();
  };
  A.hint = function () {
    var g = this.g, room = this.s.room, s = this.s;
    if (s.end) { this.say('The story is over. Type [RESTART>restart] to play again.', 'hint'); return; }
    var list = (this.D.puzzles || []).filter(function (p) { return p.avail(g) && !p.done(g); });
    if (!list.length) { this.say('You seem to be doing fine — there’s nothing obvious left that needs a hint. Explore, examine things, and see what happens.', 'hint'); return; }
    var here = function (p) { return (p.rooms || []).indexOf(room) !== -1; };
    var pick = list.filter(function (p) { return here(p) && !p.optional; })[0] || list.filter(function (p) { return !p.optional; })[0] || list.filter(here)[0] || list[0];
    var hints = typeof pick.hints === 'function' ? pick.hints(g) : pick.hints;
    var lvl = s.hl[pick.id] || 0;
    if (lvl >= hints.length) lvl = hints.length - 1;
    s.hl[pick.id] = lvl + 1;
    s.hu++;
    this.say('*Hint — ' + pick.title + ' (' + (lvl + 1) + ' of ' + hints.length + '):* ' + hints[lvl] + (lvl + 1 < hints.length ? '\n(Type [HINT>hint] again for a stronger nudge.)' : ''), 'hint');
  };
  A.save = function (c) {
    if (!this.store) { this.say('Saving isn’t available here.', 'err'); return; }
    var name = String(c.topic || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'quicksave';
    this.store.put(name, { state: this.serialize(), t: Date.now(), room: this.rooms[this.s.room].name, score: this.s.score, moves: this.s.moves });
    this.say('Saved as “' + name + '”. (Type RESTORE ' + name.toUpperCase() + ' to come back to this moment.)', 'note');
  };
  A.restore = function (c) {
    if (!this.store) { this.say('Restoring isn’t available here.', 'err'); return; }
    var name = String(c.topic || '').trim(), list = this.store.list();
    if (!name) {
      if (!list.length) { this.say('There are no saved games yet. Type SAVE (or SAVE and a name) to make one.'); return; }
      this.say('Saved games: ' + list.map(function (x) { return '[' + x.name + '>restore ' + x.name + '] (' + x.room + ', ' + x.moves + ' moves)'; }).join('; ') + '. Type RESTORE and a name.');
      return;
    }
    var rec = this.store.get(name);
    if (!rec) {
      var lower = name.toLowerCase(), hit = list.filter(function (x) { return x.name.toLowerCase() === lower; })[0];
      rec = hit ? this.store.get(hit.name) : null;
      if (hit) name = hit.name;
    }
    if (!rec) { this.say('There’s no saved game called “' + name + '”.', 'err'); return; }
    var before = this.serialize();
    try { this.loadState(rec.state); } catch (e) { this.s = JSON.parse(before); this.say('That saved game couldn’t be read.', 'err'); return; }
    this.undoStack.push({ s: before, cmd: 'restore ' + name });
    this.say('Restored “' + name + '”.', 'note');
    this.describeRoom(true);
  };

  // ---- the API rules see ---------------------------------------------------
  function makeApi(e) {
    return {
      say: function (t) { e.say(t); },
      p: function (id, k) { return e.p(id, k); },
      set: function (id, k, v) { (e.s.p[id] = e.s.p[id] || {})[k] = v; },
      flag: function (k) { return e.s.f[k]; },
      setFlag: function (k, v) { e.s.f[k] = v === undefined ? true : v; },
      loc: function (id) { return e.s.loc[id]; },
      move: function (id, to) { e.move(id, to); },
      has: function (id) { return e.isHeld(id); },
      here: function (id) { return e.inScope(id); },
      isOpen: function (id) { return e.isOpen(id); },
      room: function () { return e.s.room; },
      visited: function (r) { return !!e.s.vis[r]; },
      award: function (k, n) { return e.award(k, n); },
      end: function (k) { e.end(k); },
      ended: function () { return e.s.end; },
      go: function (dir) { e.go(dir); },
      act: function (v, d, i, topic) { e.perform({ v: v, d: d || null, i: i || null, topic: topic }); return true; },
      dflt: function (c) { A[c.v].call(e, c); return true; },
      ensureHeld: function (id) { return e.ensureHeld(id); },
      askFor: function (c, role, q) { e.askFor(c, role, q); },
      confirm: function (q, k) { e.confirm(q, k); },
      timer: function (n, t) { e.s.tm[n] = t; },
      stopTimer: function (n) { delete e.s.tm[n]; },
      timerLeft: function (n) { return e.s.tm[n] || 0; },
      cycle: function (k, arr) { var i = e.s.cy[k] || 0; e.s.cy[k] = i + 1; return arr[i % arr.length]; },
      the: function (id) { return e.theName(id); },
      a: function (id) { return e.aName(id); },
      name: function (id) { return e.nm(id); },
      cap: cap,
      clock: function () { return e.clock(); },
      moves: function () { return e.s.moves; },
      dark: function () { return e.isDark(); },
      score: function () { return e.s.score; },
      hintsUsed: function () { return e.s.hu; }
    };
  }

  // ===========================================================================
  // UI
  // ===========================================================================
  var PANEL_ID = 'adventure-panel';
  var AUTO_KEY = 'cade-adventure-auto', SLOTS_KEY = 'cade-adventure-saves', PREFS_KEY = 'cade-adventure-prefs';
  var MAX_SLOTS = 12, MAX_TR = 1500, MAX_DOM = 500, AUTO_TR_CHARS = 40000, MAX_HIST = 60;
  var VERB_CHIPS = ['take', 'drop', 'examine', 'open', 'close', 'push', 'pull', 'turn', 'light', 'read', 'put', 'give', 'show', 'unlock', 'use', 'ask', 'talk to', 'wind', 'cut', 'fill'];
  var WORD_CHIPS = ['in', 'on', 'with', 'to', 'about', 'all', 'it'];
  var ICON = '🔭';

  var DATA = null, loading = null, eng = null, ui = null;
  var prefs = { fs: 15, pad: null };
  var transcript = [], hist = [];

  function readJSON(k, d) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function toast(m, t) { try { Cade.showToast(m, t || 'info', 2200); } catch (e) {} }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }

  var slotStore = {
    all: function () { var o = readJSON(SLOTS_KEY, {}); return o && typeof o === 'object' ? o : {}; },
    list: function () {
      var o = this.all();
      return Object.keys(o).map(function (k) { var r = o[k] || {}; return { name: k, t: r.t || 0, room: r.room || '?', score: r.score || 0, moves: r.moves || 0 }; })
        .sort(function (a, b) { return b.t - a.t; });
    },
    get: function (n) { var o = this.all(); return o[n] || null; },
    put: function (n, rec) {
      var o = this.all();
      o[n] = rec;
      var keys = Object.keys(o).sort(function (a, b) { return (o[b].t || 0) - (o[a].t || 0); });
      keys.slice(MAX_SLOTS).forEach(function (k) { delete o[k]; });
      writeJSON(SLOTS_KEY, o);
    },
    del: function (n) { var o = this.all(); delete o[n]; writeJSON(SLOTS_KEY, o); }
  };

  function load() {
    if (DATA) return Promise.resolve();
    if (window.__cadeAdventureData) { DATA = window.__cadeAdventureData; return Promise.resolve(); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL;
      s.async = true;
      s.onload = function () {
        if (window.__cadeAdventureData && window.__cadeAdventureData.rooms) { DATA = window.__cadeAdventureData; resolve(); }
        else { loading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // ---- rendering -------------------------------------------------------------
  function markup(s) {
    var h = esc(s);
    h = h.replace(/\[([^\]\n]+)\]/g, function (_, inner) {
      var gi = inner.indexOf('&gt;'), pi = inner.indexOf('|'), shown, target, cmd = false;
      if (gi !== -1) { shown = inner.slice(0, gi); target = inner.slice(gi + 4); cmd = true; }
      else if (pi !== -1) { shown = inner.slice(0, pi); target = inner.slice(pi + 1); }
      else { shown = target = inner; }
      return '<span class="' + (cmd ? 'adv-c' : 'adv-n') + '" role="button" tabindex="-1" data-' + (cmd ? 'c' : 'n') + '="' + target + '">' + shown + '</span>';
    });
    h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return h.split(/\n\n+/).map(function (p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  function blockEl(b) {
    var el = document.createElement('div');
    el.className = 'adv-b adv-' + b.t;
    if (b.t === 'cmd' || b.t === 'sub') el.innerHTML = '<span class="adv-gt" aria-hidden="true">&gt;</span> ' + esc(b.s);
    else if (b.t === 'title' || b.t === 'end') el.textContent = b.s;
    else if (b.t === 'banner') el.innerHTML = '<div class="adv-bt">' + esc(b.s) + '</div><div class="adv-bs">' + esc(b.sub || '') + '</div>';
    else if (b.t === 'exits') {
      var x = b.x || [];
      el.innerHTML = x.length ? '<span class="adv-xl">Exits</span>' + x.map(function (e) {
        return '<button type="button" class="adv-x" data-go="' + esc(e[0]) + '"' + (e[2] ? ' title="' + esc(e[2]) + '"' : '') + '>' + esc(e[1]) + (e[2] ? '<span class="adv-xt"> · ' + esc(e[2]) + '</span>' : '') + '</button>';
      }).join('') : '<span class="adv-xl">No obvious exits</span>';
    } else el.innerHTML = markup(b.s);
    return el;
  }
  function plainBlock(b) {
    if (b.t === 'cmd') return '\n> ' + b.s;
    if (b.t === 'sub') return '> ' + b.s;
    if (b.t === 'title') return b.s;
    if (b.t === 'end') return '*** ' + b.s + ' ***';
    if (b.t === 'banner') return b.s.toUpperCase() + '\n' + (b.sub || '') + '\n';
    if (b.t === 'exits') return b.s;
    return plain(b.s);
  }
  function transcriptText() {
    var head = (DATA ? DATA.meta.title : 'Text Adventure') + ' — transcript';
    return head + '\n' + new Array(head.length + 1).join('=') + '\n\n' + transcript.map(plainBlock).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function append(blocks, scrollToFirst) {
    if (!ui) return;
    var out = ui.out, first = null;
    // Older exit chips belong to rooms you've left: grey them out.
    if (blocks.some(function (b) { return b.t === 'exits'; })) {
      var old = out.querySelectorAll('.adv-exits:not(.adv-old)');
      for (var i = 0; i < old.length; i++) old[i].classList.add('adv-old');
    }
    blocks.forEach(function (b) {
      transcript.push(b);
      var el = blockEl(b);
      out.appendChild(el);
      if (!first) first = el;
    });
    if (transcript.length > MAX_TR) transcript.splice(0, transcript.length - MAX_TR);
    while (out.childNodes.length > MAX_DOM) out.removeChild(out.firstChild);
    if (first) {
      var target = scrollToFirst ? first.offsetTop - 8 : out.scrollHeight;
      out.scrollTop = Math.max(0, target);
    }
  }

  function paintStatus() {
    if (!ui || !eng) return;
    var st = eng.status();
    ui.loc.textContent = st.room;
    ui.meta.textContent = st.time + ' · ' + st.score + '/' + st.max + ' · ' + st.moves + (st.moves === 1 ? ' move' : ' moves');
    var dirs = st.ended ? [] : eng.allExitDirs();
    var btns = ui.root.querySelectorAll('.adv-pad [data-go]');
    for (var i = 0; i < btns.length; i++) {
      var on = dirs.indexOf(btns[i].getAttribute('data-go')) !== -1;
      btns[i].classList.toggle('on', on);
      btns[i].disabled = !on;
    }
  }

  function autosave() {
    if (!eng) return;
    var tr = [], n = 0;
    for (var i = transcript.length - 1; i >= 0; i--) {
      n += (transcript[i].s || '').length + 20;
      if (n > AUTO_TR_CHARS) break;
      tr.unshift(transcript[i]);
    }
    writeJSON(AUTO_KEY, { v: 1, gv: DATA.meta.version, st: eng.serialize(), tr: tr, h: hist.slice(-MAX_HIST) });
  }

  function run(cmd, opts) {
    if (!ui || !eng) return;
    cmd = String(cmd).trim();
    if (!cmd) return;
    if (!(opts && opts.noHist)) {
      if (hist[hist.length - 1] !== cmd) hist.push(cmd);
      if (hist.length > MAX_HIST) hist.shift();
    }
    ui.histPos = -1;
    ui.draft = '';
    var blocks = [{ t: 'cmd', s: cmd }].concat(eng.exec(cmd));
    append(blocks, true);
    paintStatus();
    autosave();
    ui.auto = '';
  }

  function nounTap(noun) {
    var inp = ui.input, v = inp.value;
    var ex = 'examine ' + noun;
    if (v.trim() === ex) { submit(); return; }
    if (!v.trim() || v === ui.auto) { inp.value = ex; ui.auto = ex; }
    else inp.value = v.replace(/\s*$/, ' ') + noun;
    caretEnd();
  }
  function chipTap(word, verb) {
    var inp = ui.input, v = inp.value;
    if (verb && (!v.trim() || v === ui.auto)) inp.value = word + ' ';
    else inp.value = v.replace(/\s*$/, v.trim() ? ' ' : '') + word + ' ';
    ui.auto = '';
    caretEnd();
  }
  function caretEnd() {
    var inp = ui.input;
    ui.root.classList.toggle('adv-has', !!inp.value.trim());
    if (!coarse()) { try { inp.focus({ preventScroll: true }); inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {} }
  }
  function submit() {
    var v = ui.input.value;
    ui.input.value = '';
    ui.root.classList.remove('adv-has');
    if (v.trim()) run(v);
  }

  // ---- menu & sheets ----------------------------------------------------------
  function closeMenu() { if (ui && ui.menu) { ui.menu.hidden = true; ui.menuBtn.setAttribute('aria-expanded', 'false'); } }
  function toggleMenu() {
    if (!ui) return;
    var open = ui.menu.hidden;
    closeSheet();
    ui.menu.hidden = !open;
    ui.menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      var vb = ui.menu.querySelector('[data-act="verbose"]');
      if (vb && eng) vb.textContent = eng.s.verbose ? 'Brief descriptions' : 'Verbose descriptions';
      ui.menu.querySelector('.adv-fsv').textContent = prefs.fs + 'px';
    }
  }
  function closeSheet() { if (ui && ui.sheet && !ui.sheet.hidden) { ui.sheet.hidden = true; ui.sheet.innerHTML = ''; } }
  function openSlots(mode) {
    closeMenu();
    var list = slotStore.list(), h = '<div class="adv-sh-in"><div class="adv-sh-h"><b>' + (mode === 'save' ? 'Save game' : 'Restore game') + '</b><button type="button" class="adv-tb" data-act="sheet-x" aria-label="Close">×</button></div>';
    if (mode === 'save') {
      h += '<form class="adv-sv"><input class="adv-svn" maxlength="40" placeholder="Name this save" value="' + esc(eng ? eng.rooms[eng.s.room].name : '') + '" autocomplete="off"><button type="submit" class="adv-btn primary">Save</button></form>';
    }
    h += list.length ? '<ul class="adv-sl">' + list.map(function (x) {
      return '<li><div class="adv-sln"><b>' + esc(x.name) + '</b><span>' + esc(x.room) + ' · ' + x.score + ' pts · ' + x.moves + ' moves · ' + new Date(x.t).toLocaleDateString() + '</span></div>' +
        (mode === 'save' ? '<button type="button" class="adv-btn" data-act="slot-over" data-n="' + esc(x.name) + '">Overwrite</button>' : '<button type="button" class="adv-btn primary" data-act="slot-load" data-n="' + esc(x.name) + '">Restore</button>') +
        '<button type="button" class="adv-btn" data-act="slot-del" data-n="' + esc(x.name) + '" aria-label="Delete">✕</button></li>';
    }).join('') + '</ul>' : '<p class="adv-sh-e">No saved games yet.</p>';
    h += '</div>';
    ui.sheet.innerHTML = h;
    ui.sheet.hidden = false;
    ui.sheet.setAttribute('data-mode', mode);
    var f = ui.sheet.querySelector('.adv-sv');
    if (f) {
      f.addEventListener('submit', function (e) { e.preventDefault(); var n = ui.sheet.querySelector('.adv-svn').value.trim(); closeSheet(); run('save ' + (n || 'quicksave'), { noHist: true }); });
      if (!coarse()) { var inp = f.querySelector('input'); try { inp.focus(); inp.select(); } catch (e) {} }
    }
  }
  function showHelpSheet(which) {
    closeMenu();
    var txtS = which === 'about' ? DATA.about : DATA.help;
    ui.sheet.innerHTML = '<div class="adv-sh-in"><div class="adv-sh-h"><b>' + (which === 'about' ? 'About' : 'How to play') + '</b><button type="button" class="adv-tb" data-act="sheet-x" aria-label="Close">×</button></div><div class="adv-sh-t">' + markup(txtS) + '</div></div>';
    ui.sheet.hidden = false;
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      toast(ok ? 'Transcript copied' : 'Couldn’t copy', ok ? 'success' : 'error');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Transcript copied', 'success'); }, fallback);
    else fallback();
  }
  function insertTranscript() {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('This document is read-only', 'error'); return; }
    ed.dispatch(ed.state.replaceSelection(transcriptText()), { userEvent: 'input' });
    toast('Transcript inserted into the document', 'success');
  }
  function setFont(d) {
    prefs.fs = Math.max(12, Math.min(22, (prefs.fs || 15) + d));
    ui.root.style.setProperty('--adv-fs', prefs.fs + 'px');
    var v = ui.menu.querySelector('.adv-fsv'); if (v) v.textContent = prefs.fs + 'px';
    writeJSON(PREFS_KEY, prefs);
  }
  function setPad(on) {
    prefs.pad = !!on;
    ui.pad.hidden = !on;
    ui.padBtn.classList.toggle('on', !!on);
    ui.padBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    writeJSON(PREFS_KEY, prefs);
  }

  function onAct(a, el) {
    if (a === 'send') { submit(); return; }
    if (a === 'menu') { toggleMenu(); return; }
    if (a === 'pad') { setPad(ui.pad.hidden); return; }
    if (a === 'sheet-x') { closeSheet(); return; }
    if (!eng) return;
    closeMenu();
    if (a === 'hint' || a === 'undo' || a === 'score' || a === 'inventory' || a === 'look' || a === 'restart' || a === 'wait') { run(a, { noHist: true }); return; }
    if (a === 'verbose') { run(eng.s.verbose ? 'brief' : 'verbose', { noHist: true }); return; }
    if (a === 'save') { openSlots('save'); return; }
    if (a === 'restore') { openSlots('restore'); return; }
    if (a === 'insert') { insertTranscript(); return; }
    if (a === 'copy') { copyText(transcriptText()); return; }
    if (a === 'fs-') { setFont(-1); ui.menu.hidden = false; return; }
    if (a === 'fs+') { setFont(1); ui.menu.hidden = false; return; }
    if (a === 'help') { showHelpSheet('help'); return; }
    if (a === 'about') { showHelpSheet('about'); return; }
    if (a === 'clear') { ui.out.innerHTML = ''; transcript = []; run('look', { noHist: true }); return; }
    var n = el && el.getAttribute('data-n');
    if (a === 'slot-load') { closeSheet(); run('restore ' + n, { noHist: true }); return; }
    if (a === 'slot-over') { closeSheet(); run('save ' + n, { noHist: true }); return; }
    if (a === 'slot-del') {
      if (!window.confirm('Delete the saved game “' + n + '”?')) return;
      slotStore.del(n);
      openSlots(ui.sheet.getAttribute('data-mode') || 'restore');
    }
  }

  function panelHtml() {
    var rose = [['nw', 'NW'], ['n', 'N'], ['ne', 'NE'], ['w', 'W'], ['look', 'Look'], ['e', 'E'], ['sw', 'SW'], ['s', 'S'], ['se', 'SE']].map(function (d) {
      return d[0] === 'look' ? '<button type="button" class="adv-rb adv-look" data-act="look">Look</button>' : '<button type="button" class="adv-rb" data-go="' + d[0] + '" aria-label="Go ' + DIRN[d[0]] + '">' + d[1] + '</button>';
    }).join('');
    var ud = [['u', 'Up'], ['d', 'Down'], ['in', 'In'], ['out', 'Out']].map(function (d) { return '<button type="button" class="adv-rb" data-go="' + d[0] + '">' + d[1] + '</button>'; }).join('');
    var quick = [['inventory', 'Inventory'], ['wait', 'Wait'], ['hint', 'Hint'], ['undo', 'Undo']].map(function (d) { return '<button type="button" class="adv-chip adv-chip-q" data-act="' + d[0] + '">' + d[1] + '</button>'; }).join('');
    var verbs = VERB_CHIPS.map(function (v) { return '<button type="button" class="adv-chip" data-verb="' + v + '">' + v + '</button>'; }).join('');
    var words = WORD_CHIPS.map(function (v) { return '<button type="button" class="adv-chip adv-chip-w" data-word="' + v + '">' + v + '</button>'; }).join('');
    return '<div class="adv" tabindex="-1">' +
      '<div class="adv-status"><span class="adv-loc">Wrenhallow</span><span class="adv-meta"></span></div>' +
      '<div class="adv-out" aria-live="polite"><div class="adv-loading">Loading the story…</div></div>' +
      '<div class="adv-pad" hidden>' +
        '<div class="adv-padl"><div class="adv-rose">' + rose + '</div><div class="adv-ud">' + ud + '</div></div>' +
        '<div class="adv-padr"><div class="adv-chips">' + quick + '</div><div class="adv-chips">' + verbs + '</div><div class="adv-chips">' + words + '</div></div>' +
      '</div>' +
      '<div class="adv-inrow">' +
        '<button type="button" class="adv-tb adv-padbtn" data-act="pad" title="Compass & verb buttons" aria-label="Compass and verb buttons" aria-pressed="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.2 4.8-4.8 2.2 2.2-4.8z"/></svg></button>' +
        '<label class="adv-field"><span class="adv-gt" aria-hidden="true">&gt;</span><input class="adv-in" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" aria-label="Command" placeholder="What do you do?"></label>' +
        '<button type="button" class="adv-tb adv-send" data-act="send" aria-label="Send"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10l-4 4 4 4"/><path d="M5 14h10a4 4 0 0 0 4-4V5"/></svg></button>' +
        '<button type="button" class="adv-tb adv-menubtn" data-act="menu" aria-label="Menu" aria-haspopup="true" aria-expanded="false">⋯</button>' +
      '</div>' +
      '<div class="adv-menu" role="menu" hidden>' +
        '<button type="button" data-act="hint">Hint</button><button type="button" data-act="undo">Undo last move</button><button type="button" data-act="score">Score</button>' +
        '<hr><button type="button" data-act="save">Save game…</button><button type="button" data-act="restore">Restore game…</button><button type="button" data-act="restart">Restart</button>' +
        '<hr><button type="button" data-act="insert">Insert transcript into document</button><button type="button" data-act="copy">Copy transcript</button><button type="button" data-act="clear">Clear screen</button>' +
        '<hr><div class="adv-fs"><span>Text size</span><button type="button" data-act="fs-" aria-label="Smaller text">A−</button><span class="adv-fsv"></span><button type="button" data-act="fs+" aria-label="Larger text">A+</button></div>' +
        '<button type="button" data-act="verbose">Brief descriptions</button><button type="button" data-act="help">How to play</button><button type="button" data-act="about">About</button>' +
      '</div>' +
      '<div class="adv-sheet" hidden></div>' +
    '</div>';
  }

  // ---- open / close ---------------------------------------------------------------
  function teardown() {
    if (!ui) return;
    try { autosave(); } catch (e) {}
    document.removeEventListener('keydown', ui.onKey, true);
    document.removeEventListener('pointerdown', ui.onDocDown, true);
    document.removeEventListener('focusin', ui.onFocus, true);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', ui.onVV);
      window.visualViewport.removeEventListener('scroll', ui.onVV);
    }
    clearTimeout(ui.vvT);
    ui = null;
  }
  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    teardown();
    if (!coarse()) { try { Cade.editor.focus(); } catch (e) {} }
  }

  function startEngine() {
    eng = new Engine(DATA, { store: slotStore });
    var saved = readJSON(AUTO_KEY, null);
    var restored = false;
    if (saved && saved.st) {
      try {
        eng.loadState(saved.st);
        restored = true;
        hist = Array.isArray(saved.h) ? saved.h.slice(-MAX_HIST) : [];
        transcript = [];
        ui.out.innerHTML = '';
        if (Array.isArray(saved.tr) && saved.tr.length) append(saved.tr.filter(function (b) { return b && typeof b.s === 'string'; }), false);
        append([{ t: 'note', s: 'Welcome back. (Your story was saved where you left it.)' }].concat(eng.look()), true);
      } catch (e) { restored = false; }
    }
    if (!restored) {
      transcript = [];
      ui.out.innerHTML = '';
      append(eng.start(), false);
      ui.out.scrollTop = 0;
      autosave();
    }
    paintStatus();
  }

  function fitViewport() {
    if (!ui || !window.visualViewport) return;
    var p = ui.panel, vv = window.visualViewport;
    p.style.height = '';
    if (!coarse()) return;
    // Keep the command line above the on-screen keyboard (iOS shrinks only the
    // visual viewport), but never grow past the CSS height.
    var r = p.getBoundingClientRect(), bottom = vv.offsetTop + vv.height;
    if (r.top < vv.offsetTop) { p.style.top = (vv.offsetTop + 4) + 'px'; r = p.getBoundingClientRect(); }
    var h = Math.floor(bottom - r.top - 6);
    if (h < r.height && h > 200) p.style.height = h + 'px';
    ui.out.scrollTop = ui.out.scrollHeight;
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    var pr = readJSON(PREFS_KEY, {});
    if (pr && typeof pr === 'object') { if (pr.fs) prefs.fs = pr.fs; if (pr.pad != null) prefs.pad = pr.pad; }
    var p = Cade.mkPanel(PANEL_ID, ICON + ' The Comet at Wrenhallow', panelHtml());
    var root = p.querySelector('.adv');
    ui = {
      panel: p, root: root, out: root.querySelector('.adv-out'), input: root.querySelector('.adv-in'),
      loc: root.querySelector('.adv-loc'), meta: root.querySelector('.adv-meta'), pad: root.querySelector('.adv-pad'),
      padBtn: root.querySelector('.adv-padbtn'), menu: root.querySelector('.adv-menu'), menuBtn: root.querySelector('.adv-menubtn'),
      sheet: root.querySelector('.adv-sheet'), histPos: -1, draft: '', auto: '', active: true, openedAt: Date.now()
    };
    p._onClose = teardown;
    root.style.setProperty('--adv-fs', prefs.fs + 'px');
    setPad(prefs.pad == null ? coarse() : prefs.pad);

    var inp = ui.input;
    inp.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!hist.length) return;
        e.preventDefault();
        if (ui.histPos === -1) { ui.draft = inp.value; ui.histPos = hist.length; }
        ui.histPos += e.key === 'ArrowUp' ? -1 : 1;
        if (ui.histPos < 0) ui.histPos = 0;
        if (ui.histPos >= hist.length) { ui.histPos = -1; inp.value = ui.draft; }
        else inp.value = hist[ui.histPos];
        caretEnd();
      }
    });
    inp.addEventListener('input', function () { ui.auto = ''; root.classList.toggle('adv-has', !!inp.value.trim()); });
    // Phones: while the soft keyboard is up, give the page the room the pad would take.
    inp.addEventListener('focus', function () { if (ui && coarse()) root.classList.add('adv-typing'); });
    inp.addEventListener('blur', function () { if (ui) root.classList.remove('adv-typing'); });

    root.addEventListener('click', function (e) {
      var t = e.target, el;
      if ((el = t.closest('[data-act]'))) { onAct(el.getAttribute('data-act'), el); return; }
      if ((el = t.closest('[data-go]'))) { closeMenu(); run(DIRN[el.getAttribute('data-go')] || el.getAttribute('data-go'), { noHist: true }); return; }
      if ((el = t.closest('[data-verb]'))) { chipTap(el.getAttribute('data-verb'), true); return; }
      if ((el = t.closest('[data-word]'))) { chipTap(el.getAttribute('data-word'), false); return; }
      if ((el = t.closest('.adv-n'))) { closeMenu(); nounTap(el.getAttribute('data-n')); return; }
      if ((el = t.closest('.adv-c'))) { closeMenu(); run(el.getAttribute('data-c')); return; }
      if (ui.menu && !ui.menu.hidden && !t.closest('.adv-menu')) closeMenu();
    });
    // Buttons and tappable words must not steal focus from the input (keeps
    // the soft keyboard where it is) — except real text fields.
    root.addEventListener('mousedown', function (e) {
      if (e.target.closest('button, .adv-n, .adv-c') && !e.target.closest('input')) e.preventDefault();
    });

    ui.onDocDown = function (e) {
      if (!ui) return;
      ui.active = ui.panel.contains(e.target);
      if (ui.menu && !ui.menu.hidden && !e.target.closest('.adv-menu, .adv-menubtn')) closeMenu();
    };
    ui.onFocus = function (e) {
      if (!ui || ui.panel.contains(e.target)) return;
      // Focus settling after the Ctrl+K palette closes must not steal the input.
      if (Date.now() - ui.openedAt < 700 && !coarse()) { try { ui.input.focus({ preventScroll: true }); } catch (x) {} return; }
      ui.active = false;
    };
    ui.onKey = function (e) {
      if (!ui) return;
      var ae = document.activeElement, inside = ui.panel.contains(ae);
      if (e.key === 'Escape') {
        if (!inside && !(ui.active && (!ae || ae === document.body))) return;
        e.preventDefault(); e.stopPropagation();
        if (!ui.sheet.hidden) closeSheet();
        else if (!ui.menu.hidden) closeMenu();
        else close();
        return;
      }
      // Typing while the panel is the active thing (but focus is on a button
      // or nowhere) goes into the command line.
      if (!ui.active || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      if (ae && ae !== document.body && !inside) return;
      if (ae === ui.input || (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName))) return;
      try { ui.input.focus({ preventScroll: true }); } catch (x) {}
    };
    ui.onVV = function () { clearTimeout(ui.vvT); ui.vvT = setTimeout(fitViewport, 60); };
    document.addEventListener('keydown', ui.onKey, true);
    document.addEventListener('pointerdown', ui.onDocDown, true);
    document.addEventListener('focusin', ui.onFocus, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', ui.onVV);
      window.visualViewport.addEventListener('scroll', ui.onVV);
    }

    // A typing game: desktop gets the caret straight away; on phones we only
    // drop the editor's keyboard and let the player tap the command line.
    try { if (Cade.editor && Cade.editor.hasFocus) Cade.editor.contentDOM.blur(); } catch (e) {}
    if (!coarse()) { try { inp.focus({ preventScroll: true }); } catch (e) {} }

    var mine = ui;
    load().then(function () {
      if (ui !== mine) return;
      try { startEngine(); }
      catch (err) { ui.out.innerHTML = '<div class="adv-loading">Something went wrong starting the story.</div>'; }
    }, function () {
      if (ui !== mine) return;
      ui.out.innerHTML = '<div class="adv-loading">Couldn’t load the story' + (navigator.onLine ? '.' : ' — it needs one online visit to be cached for offline play.') + '</div>';
    });
  }

  Cade.registerWidget({
    name: 'Wrenhallow — Text Adventure',
    description: 'Interactive fiction: wake an old observatory before the comet passes. Type commands, explore, solve puzzles',
    icon: ICON,
    tags: 'game,text adventure,interactive fiction,zork,parser,story,puzzle,fun',
    open: open,
    // Pure engine, exposed for tests / tooling (no DOM).
    _engine: { Engine: Engine, tokenize: tokenize, plain: plain, near: near, splitCommands: splitCommands, GRAMMAR: GRAMMAR }
  });
})();
