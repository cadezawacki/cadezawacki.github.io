/* Node harness for the Text Adventure engine (not shipped: not in the
 * manifest). Loads adventure.js with a stub window.Cade and the story data,
 * and returns a fresh Engine with an in-memory save store. */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var DIR = path.join(__dirname, '..');

function load() {
  var widget = null;
  var sandbox = {
    console: console,
    window: {
      Cade: {
        loadCSS: function () {},
        asset: function (p) { return p; },
        registerWidget: function (w) { widget = w; }
      }
    }
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'adventure.js'), 'utf8'), sandbox, { filename: 'adventure.js' });
  vm.runInContext('var window = this.window;' + fs.readFileSync(path.join(DIR, 'adventure-data.js'), 'utf8'), sandbox, { filename: 'adventure-data.js' });
  return { widget: widget, data: sandbox.window.__cadeAdventureData };
}

function memStore() {
  var o = {};
  return {
    list: function () { return Object.keys(o).map(function (k) { return { name: k, t: o[k].t, room: o[k].room, score: o[k].score, moves: o[k].moves }; }); },
    get: function (n) { return o[n] || null; },
    put: function (n, r) { o[n] = JSON.parse(JSON.stringify(r)); },
    del: function (n) { delete o[n]; }
  };
}

// Walkthrough files: one command per line, '#' comments, optional
// "command => text the output must contain".
function readScript(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(function (l) { return l.replace(/^\s*#.*$/, '').trim(); }).filter(Boolean).map(function (l) {
    var at = l.indexOf('=>');
    return at === -1 ? { cmd: l, expect: '' } : { cmd: l.slice(0, at).trim(), expect: l.slice(at + 2).trim() };
  });
}

function newGame() {
  var L = load();
  var E = L.widget._engine;
  var eng = new E.Engine(L.data, { store: memStore() });
  var intro = eng.start();
  return { eng: eng, E: E, data: L.data, widget: L.widget, intro: intro,
    // run a command and return its plain text
    say: function (cmd) { return eng.exec(cmd).map(function (b) { return b.t === 'exits' ? b.s : E.plain(b.s); }).join('\n'); },
    blocks: function (cmd) { return eng.exec(cmd); }
  };
}

module.exports = { load: load, newGame: newGame, memStore: memStore, readScript: readScript };

// `node harness.js "cmd1" "cmd2" ...` or `node harness.js -f file` plays commands and prints the transcript.
if (require.main === module) {
  var G = newGame();
  var args = process.argv.slice(2), steps = args.map(function (c) { return { cmd: c, expect: '' }; });
  if (args[0] === '-f') steps = readScript(args[1]);
  console.log(G.intro.map(function (b) { return G.E.plain(b.s); }).join('\n'));
  steps.forEach(function (st) {
    var out = G.say(st.cmd);
    console.log('\n> ' + st.cmd);
    console.log(out);
    if (st.expect && out.indexOf(st.expect) === -1) console.log('!!! EXPECTED: ' + st.expect);
  });
  var st = G.eng.status();
  console.log('\n[score ' + st.score + '/' + st.max + ', moves ' + st.moves + ', ' + st.time + ', ended=' + st.ended + ']');
}
