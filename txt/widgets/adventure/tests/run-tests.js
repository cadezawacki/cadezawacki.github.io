/* Unit tests for the Text Adventure engine + story data.
 *   node txt/widgets/adventure/tests/run-tests.js
 * Not shipped (the manifest never lists this folder). */
'use strict';
var path = require('path');
var H = require('./harness');

var fails = 0, passes = 0;
function ok(cond, msg) { if (cond) passes++; else { fails++; console.log('FAIL: ' + msg); } }
function has(out, needle, msg) { ok(out.indexOf(needle) !== -1, (msg || '') + ' — expected “' + needle + '” in:\n' + out + '\n'); }
function lacks(out, needle, msg) { ok(out.indexOf(needle) === -1, (msg || '') + ' — did not expect “' + needle + '” in:\n' + out + '\n'); }
function play(G, cmds) { var out = ''; cmds.forEach(function (c) { out = G.say(c); }); return out; }
// Fast-forward a fresh game through a prefix of the walkthrough.
var WALK = H.readScript(path.join(__dirname, 'walkthrough.txt'));
function upTo(G, cmd) { for (var i = 0; i < WALK.length && WALK[i].cmd !== cmd; i++) G.say(WALK[i].cmd); }

// ---------------------------------------------------------------------------
// 1. The walkthrough reaches the best ending with a perfect score.
// ---------------------------------------------------------------------------
(function walkthrough() {
  var G = H.newGame();
  WALK.forEach(function (st, i) {
    var out = G.say(st.cmd);
    if (st.expect) has(out, st.expect, 'walkthrough step ' + (i + 1) + ' (' + st.cmd + ')');
    ok(out.indexOf('I don’t know the word') === -1 && out.indexOf('I didn’t understand') === -1, 'walkthrough step parses: ' + st.cmd + '\n' + out);
  });
  var s = G.eng.status();
  ok(s.ended === 'best', 'ends with the best ending (got ' + s.ended + ')');
  ok(s.score === 100 && s.max === 100, 'perfect score 100/100 (got ' + s.score + ')');
  ok(s.rank === 'Astronomer of Wrenhallow', 'top rank');
  ok(s.moves < 200, 'walkthrough is efficient (' + s.moves + ' moves)');
  // After the end only meta commands work.
  has(G.say('n'), 'The story is over');
  has(G.say('score'), '100 out of a possible 100');
  // UNDO steps back from the ending.
  G.say('undo');
  ok(!G.eng.status().ended, 'undo un-ends the story');
})();

// Every point source is reachable: the awards in a perfect run sum to max.
(function scoreTable() {
  var G = H.newGame();
  WALK.forEach(function (st) { G.say(st.cmd); });
  var aw = G.eng.s.aw, sum = Object.keys(aw).reduce(function (a, k) { return a + aw[k]; }, 0);
  ok(sum === G.data.meta.maxScore, 'awards sum to maxScore (' + sum + ')');
  ok(Object.keys(aw).length === 23, '23 scored moments (' + Object.keys(aw).length + ')');
})();

// ---------------------------------------------------------------------------
// 2. World / content sanity
// ---------------------------------------------------------------------------
(function content() {
  var G = H.newGame(), D = G.data, eng = G.eng;
  var rooms = Object.keys(D.rooms), objs = Object.keys(D.objects);
  ok(rooms.length >= 25 && rooms.length <= 35, '25–35 rooms (' + rooms.length + ')');
  ok(objs.length >= 40, '40+ objects (' + objs.length + ')');
  ok(D.puzzles.length >= 8, '8+ hinted puzzles');
  ok(D.puzzles.some(function (p) { return p.optional; }), 'an optional side puzzle');
  ok(Object.keys(D.endings).length >= 2, '2+ endings');
  ok(objs.filter(function (id) { return D.objects[id].npc; }).length >= 3, '3+ NPCs');
  // Every exit leads to a real room; every door object exists.
  rooms.forEach(function (r) {
    var ex = D.rooms[r].exits || {};
    Object.keys(ex).forEach(function (k) {
      var e = ex[k], to = typeof e === 'string' ? e : e.to;
      ok(!!D.rooms[to], r + '.' + k + ' → ' + to + ' exists');
      if (e.door) ok(!!D.objects[e.door] && D.objects[e.door].door, r + '.' + k + ' door ' + e.door + ' exists');
    });
  });
  // Every [tappable noun] in every room description resolves in that room.
  rooms.forEach(function (r) {
    eng.s.room = r;
    var desc = D.rooms[r].desc, text = typeof desc === 'function' ? desc(eng.g) : desc;
    // also the room's own objects' initial / describe texts
    Object.keys(D.objects).forEach(function (id) {
      var d = D.objects[id];
      if (d.loc === r) ['initial', 'describe'].forEach(function (k) { if (d[k]) text += ' ' + (typeof d[k] === 'function' ? d[k](eng.g) : d[k]); });
    });
    var lights = eng.s.p.lantern.lit; eng.s.p.lantern.lit = true; eng.s.loc.lantern = 'player';
    (text.match(/\[[^\]]+\]/g) || []).forEach(function (m) {
      var inner = m.slice(1, -1);
      if (inner.indexOf('>') !== -1) return;
      var noun = inner.indexOf('|') !== -1 ? inner.split('|')[1] : inner;
      var cc = { v: 'examine' };
      var res = eng.resolve(H.load().widget._engine.tokenize(noun), cc, 'd');
      ok(res.ids && res.ids.length >= 1 || res.ask, 'room ' + r + ': [' + inner + '] resolves (' + (res.err || '') + ')');
    });
    eng.s.p.lantern.lit = lights; eng.s.loc.lantern = 'boathouse';
  });
  // No raw U+2028/2029 in shipped sources.
  var fs = require('fs');
  ['adventure.js', 'adventure-data.js', 'adventure.css'].forEach(function (f) {
    var src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(!/[\u2028\u2029]/.test(src), f + ' has no U+2028/2029');
  });
})();

// ---------------------------------------------------------------------------
// 3. Parser edge cases
// ---------------------------------------------------------------------------
(function parser() {
  var G = H.newGame(), E = G.E;
  ok(E.tokenize('Take the brass key.').join(' ') === 'take brass key', 'articles dropped');
  ok(E.tokenize('go north-east').join(' ') === 'go northeast', 'north-east normalised');
  ok(E.tokenize('give letter to Mrs. Thorne').join(' ') === 'give letter to mrs thorne', 'Mrs. kept whole');
  ok(E.splitCommands('n. e then take lamp').length === 3, 'command chaining');
  ok(E.splitCommands('ask mrs. thorne about key').length === 1, 'Mrs. does not split');
  ok(E.near('lantren', 'lantern') && E.near('kye', 'key') && !E.near('bog', 'box') && E.near('secatuers', 'secateurs') && !E.near('lamp', 'lantern'), 'edit-distance-1 matcher');

  has(G.say('exmaine bicycel'), 'trusty bicycle', 'typo in verb and noun');
  has(G.say('x it'), 'trusty bicycle', 'it pronoun');
  has(G.say('x lantren'), 'You can’t see any lantern here', 'typo of something absent');
  has(G.say('frobnicate lamp'), 'I don’t know the word “frobnicate”', 'unknown verb');
  has(G.say('take zorkmid'), 'I don’t know the word “zorkmid”', 'unknown noun');
  has(G.say('bicycle'), 'not a verb', 'noun without verb');
  has(G.say(''), 'beg your pardon', 'empty input');
  has(G.say('take'), 'What do you want to take?', 'missing noun asks');
  has(G.say('bicycle'), 'seen quite enough of each other', 'answer completes the command');
  has(G.say('n'), 'locked', 'locked gate');
  has(G.say('unlock gates'), 'What do you want to unlock the iron gates with?', 'missing indirect object asks');
  has(G.say('w'), 'Gatehouse Kitchen', 'a direction reply is a new command');
  has(G.say('ask about comet'), 'eighty-one years', 'ask with implicit NPC');
  has(G.say('ask her about professer'), 'extra socks', 'her pronoun + topic typo');
  has(G.say('ask thorne about xyzzy'), 'Couldn’t tell you', 'unknown topic → default reply');
  has(G.say('talk to mrs thorne'), 'great-niece', 'talk to');
  has(G.say('give letter to thorne'), 'gate key', 'give');
  has(G.say('i'), 'gate key', 'inventory');
  has(G.say('drop all'), 'letter: Dropped', 'drop all');
  has(G.say('take all except letter'), 'gate key: Taken', 'all except');
  lacks(G.say('i'), 'letter', 'except excluded the letter');
  has(G.say('take letter'), 'Taken', 'take');
  has(G.say('take letter'), 'already have', 'already held');
  has(G.say('take mrs thorne'), 'not luggage', 'NPC hook');
  has(G.say('take rocking chair'), 'not something you can carry', 'scenery');
  has(G.say('sit in rocking chair'), 'she is in it', 'scenery hook');
  G.say('e');
  has(G.say('north'), 'first unlocking the iron gates with the gate key', 'auto-unlock with held key');
  has(G.say('g'), 'Front Porch', 'again repeats the last command (north again: drive → porch)');
})();

(function parser2() {
  var G = H.newGame();
  upTo(G, 'take watering can');
  G.say('take watering can');
  var q = G.say('drop can');
  ok(q === 'Which can do you mean, the watering can or the oil can?' || q === 'Which can do you mean, the oil can or the watering can?', 'disambiguation question: ' + q);
  has(G.say('watering'), 'Dropped', 'answer by adjective');
  has(G.say('take can'), 'Taken', 'take prefers the one not held');
  has(G.say('drop can'), 'Which can', 'ask again');
  has(G.say('the second one'), 'Dropped', 'ordinal answer');
  G.say('take all');
  has(G.say('drop can'), 'Which can', 'ask');
  has(G.say('look'), 'Glasshouse', 'a command instead of an answer');
  has(G.say('drop cans'), 'oil can: Dropped', 'plural = both');
  has(G.say('take them'), 'Taken', 'them pronoun');
  has(G.say('put letter in watering can'), 'can’t put things in', 'non-container');
  has(G.say('put the oil can on the moonflower'), 'isn’t a shelf', 'rcv hook');
  has(G.say('look under moonflower'), 'nothing of interest', 'look under');
  has(G.say('smell'), 'Night air', 'smell');
  has(G.say('xyzzy'), 'hollow voice', 'easter egg');
  has(G.say('pick up all'), 'nothing here to take', 'take all with nothing');
  has(G.say('fill watering can with oil'), 'no water here', 'fill elsewhere');
})();

// ---------------------------------------------------------------------------
// 4. Light and darkness; the timed sluice; puzzles' failure paths
// ---------------------------------------------------------------------------
(function darkness() {
  var G = H.newGame();
  upTo(G, 'take matches and poker');
  G.say('w'); G.say('w'); G.say('oil bolt'); G.say('pull bolt');
  has(G.say('d'), 'Darkness', 'cellar is dark without a lit lantern');
  has(G.say('look'), 'pitch dark', 'look in the dark');
  has(G.say('x racks'), 'too dark', 'cannot examine in the dark');
  has(G.say('n'), 'Darkness', 'can still move');
  has(G.say('s'), 'Darkness', 'and back');
  has(G.say('light lantern'), 'You have nothing to light it with', 'no matches yet');
  G.say('u');
  has(G.say('e'), 'Dining Room');
  G.say('e'); G.say('take matches');
  has(G.say('light lantern with matches'), 'golden glow', 'light with');
  G.say('w'); G.say('w');
  has(G.say('d'), 'vaulted cellar', 'cellar visible with light');
  has(G.say('extinguish lantern'), 'Darkness rushes in', 'blow out');
  has(G.say('relight lantern'), 'golden glow', 'relight');
})();

(function sluiceTimer() {
  var G = H.newGame();
  upTo(G, 'turn crank');
  has(G.say('turn crank'), 'begins to turn');
  has(G.say('x counterweight'), 'sinking');
  has(G.say('turn crank'), 'already open');
  has(G.say('wait'), 'sluice gate thumps shut', 'counterweight closes the sluice after a few turns');
  G.say('turn crank'); G.say('s'); G.say('wait');
  has(G.say('wait'), 'heavy thump', 'heard from the cellar');
  G.say('n');
  has(G.say('wedge sluice with poker'), 'shut, so there’s nothing to wedge', 'cannot wedge a shut gate');
  G.say('turn crank');
  has(G.say('wedge sluice'), 'What do you want to wedge it with?', 'two possible wedges: ask');
  has(G.say('the poker'), 'stays open', 'answer the question');
  G.say('wait'); G.say('wait'); G.say('wait'); G.say('wait');
  has(G.say('look'), 'Water thunders', 'wedged sluice stays open');
  has(G.say('take poker'), 'slams shut', 'taking the wedge closes it');
  G.say('turn crank');
  has(G.say('put poker in sluice'), 'stays open', 'put X in sluice = wedge');
  has(G.say('take poker'), 'slams shut', 'unwedge the poker');
  G.say('turn crank');
  has(G.say('wedge sluice with boathook'), 'stays open', 'boathook works as a wedge too');
  has(G.say('take boathook out of sluice'), 'slams shut', 'taking the boathook back closes the gate (no soft-lock)');
  ok(G.eng.s.loc.boathook === 'player', 'boathook back in hand');
})();

(function puzzlesFail() {
  var G = H.newGame();
  upTo(G, 'set dials to 2841');
  has(G.say('set dials to 1234'), 'Nothing.', 'wrong code');
  has(G.say('x dials'), '1-2-3-4', 'dials remember');
  has(G.say('set dials to 12'), 'four digits', 'short code');
  has(G.say('dial 2841'), 'swings open', 'DIAL n');
  G = H.newGame();
  upTo(G, 'turn crank');
  G.say('s'); G.say('u'); G.say('u'); G.say('e');
  has(G.say('talk to owl'), 'run down', 'owl silent before winding');
  has(G.say('take iron key'), 'locked tight', 'key held in talons');
  has(G.say('open hatch'), 'ladder', 'holding the boathook, OPEN HATCH pulls it down');
  G.say('u');
  has(G.say('give birdseed to pim'), 'You can’t see any birdseed here', 'no birdseed');
  has(G.say('give letter to pim'), 'withering contempt', 'Pim refuses dull gifts');
  has(G.say('show spoon to pim'), 'wants it', 'show shiny');
  has(G.say('put spoon in nest'), 'fair trade', 'put shiny in nest = trade');
  G.say('d'); G.say('w');
  has(G.say('n'), 'locked', 'dome door locked without its key');
})();

(function domeFail() {
  var G = H.newGame();
  upTo(G, 'put eyepiece in telescope');
  G.say('put eyepiece in telescope');
  has(G.say('look through telescope'), 'inside of the dome shutter', 'shutter closed');
  // power off: disengage the clutch remotely? Simplest: set state directly.
  G.eng.s.p.clutch.engaged = false;
  has(G.say('turn dial to east'), 'won’t turn by muscle alone', 'no power');
  G.eng.s.p.clutch.engaged = true;
  has(G.say('turn dial to east'), 'facing east', 'turns with power');
  has(G.say('turn dial to sideways'), 'eight points', 'bad bearing');
  has(G.say('point telescope at comet'), 'facing north-east', 'aim at comet → NE');
  has(G.say('write in logbook'), 'haven’t observed anything', 'logbook needs an observation');
})();

// ---------------------------------------------------------------------------
// 5. Other endings, hints, save/restore/undo, restart
// ---------------------------------------------------------------------------
(function endings() {
  var G = H.newGame();
  G.say('n'); // something
  G.eng.s.moves = G.data.meta.dawn - 2;
  G.say('x comet');
  var out = G.say('wait');
  has(out, 'THE END — Dawn', 'dawn ending');
  has(out, 'with your own eyes', 'dawn ending remembers the naked-eye sighting');
  ok(G.eng.status().ended === 'dawn', 'ended=dawn');

  G = H.newGame();
  upTo(G, 'take iron key');
  G.say('w'); G.say('w');
  has(G.say('lie on bed'), 'Lie down anyway?', 'bed asks');
  has(G.say('no'), 'Just as well', 'no cancels');
  ok(!G.eng.status().ended, 'not ended');
  G.say('sleep');
  has(G.say('yes'), 'THE END — Fast asleep', 'sleep ending');
})();

(function hints() {
  var G = H.newGame();
  has(G.say('hint'), 'Getting through the gates (1 of 3)', 'first hint');
  has(G.say('hint'), '(2 of 3)', 'second hint');
  has(G.say('hint'), 'SHOW LETTER TO THORNE', 'spoiler hint');
  ok(G.eng.status().moves === 0, 'hints take no time');
  upTo(G, 'pull hatch with boathook');
  has(G.say('hint'), 'The attic hatch', 'hint follows the current room');
  G = H.newGame();
  upTo(G, 'put eyepiece in telescope');
  G.say('hint'); var out = G.say('hint');
  ok(/Turning the dome|stuck shutter|Seeing the comet/.test(out), 'dome hints available');
})();

(function saving() {
  var G = H.newGame();
  play(G, ['w', 'show letter to thorne', 'e']);
  has(G.say('save gate'), 'Saved as “gate”');
  play(G, ['n', 'n']);
  ok(G.eng.s.room === 'porch', 'moved on');
  has(G.say('restore'), 'gate', 'lists saves');
  has(G.say('restore GATE'), 'Restored “gate”', 'case-insensitive restore');
  ok(G.eng.s.room === 'lane', 'back at the lane');
  has(G.say('restore nothing'), 'no saved game called', 'missing slot');
  has(G.say('undo'), 'Taken back', 'undo a restore');
  ok(G.eng.s.room === 'porch', 'undo restore');
  has(G.say('undo'), 'Taken back: “n”', 'undo a move');
  ok(G.eng.s.room === 'drive', 'undo one move');
  // Serialise / load round-trip (autosave)
  var json = G.eng.serialize();
  var G2 = H.newGame();
  G2.eng.loadState(json);
  ok(G2.eng.s.room === 'drive' && G2.eng.s.score === 5, 'state round-trips');
  has(G.say('restart'), 'Restart the story', 'restart asks');
  has(G.say('yes'), 'Lane’s End', 'restart');
  ok(G.eng.s.score === 0 && G.eng.s.moves === 0, 'fresh state after restart');
  // Determinism: two runs of the walkthrough give identical transcripts.
  var A = H.newGame(), B = H.newGame(), ta = '', tb = '';
  WALK.forEach(function (st) { ta += A.say(st.cmd); tb += B.say(st.cmd); });
  ok(ta === tb, 'deterministic');
})();

(function misc() {
  var G = H.newGame();
  has(G.say('verbose'), 'Verbose mode');
  has(G.say('brief'), 'Brief mode');
  G.say('w');
  var out = G.say('e');
  lacks(out, 'turning circle', 'brief mode skips revisited descriptions');
  has(G.say('look'), 'turning circle', 'look always describes');
  has(G.say('time'), '8:0', 'time');
  has(G.say('help'), 'TAKE LANTERN', 'help');
  has(G.say('n. n'), 'locked', 'chain stops nowhere bad');
  has(G.say('climb gates'), 'pointy', 'climb hook');
  has(G.say('go to gatehouse'), 'Gatehouse Kitchen', 'go to an adjacent room by name');
  has(G.say('kiss thorne'), 'Get away with you');
  has(G.say('exits'), 'Exits: east', 'exits');
})();

console.log((fails ? 'FAILED ' + fails : 'OK') + ' — ' + passes + ' passed');
process.exit(fails ? 1 : 0);
