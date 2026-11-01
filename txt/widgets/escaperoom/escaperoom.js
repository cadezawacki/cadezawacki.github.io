/* Escape Room — point-and-click escape rooms drawn in ASCII, for Cade.txt.
 * Three original rooms (The Clockmaker's Study, The Glasshouse, The Observatory),
 * each with four walls to turn between, things to inspect, an inventory with
 * item combining, locks of every kind (combination dials, keypads, colour and
 * symbol wheels, a directional lock, letter wheels), hidden compartments and
 * notes, and a final door. Every puzzle is a fair logic puzzle: the answer is
 * always somewhere in the room. A progressive hint system (three hints per
 * puzzle, +30 s each), a running timer with best times, and progress saved per
 * room (leave mid-room and continue later).
 * The rooms are pure data walked by a tiny rule engine (no DOM, unit-checked in
 * node): objects have look / use rules with conditions on flags and items.
 * The scene is a monospace glyph grid; hotspots are real buttons laid over it,
 * so mouse, touch and keyboard (Tab / Enter) all work, and typing works in the
 * keypads and wheels. Persists in Cade.store (cade-escaperoom-*). Offline. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var COLS = 46, ROWS = 16, HINT_PEN = 30, MAX_T = 359999;

  // Symbols / colours shown on the wheel locks. Values are ids; the UI draws them.
  var COLOURS = ['red', 'yellow', 'green', 'blue', 'violet'];
  var CLR = { red: 'R', yellow: 'Y', green: 'G', blue: 'B', violet: 'V' };
  var DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var WEATHER = ['sun', 'moon', 'star', 'clover', 'heart'];
  var SHAPES = ['circle', 'triangle', 'square', 'diamond', 'star'];
  var GLYPH = { sun: '☼', moon: '☾', star: '★', clover: '♣', heart: '♥', circle: '○', triangle: '△', square: '□', diamond: '◇' };
  var SHAPE_GLYPH = { circle: '○', triangle: '△', square: '□', diamond: '◇', star: '☆' };

  // ---------------- the rooms ----------------
  // Conditions: space-separated tokens, all must hold: 'flag', '!flag', '@item' (held), '!@item'.
  // Actions: 'set:f clr:f give:item take:item lock:id zoom:id view:id sfx:name'.
  // Patches overwrite the art when their condition holds ('$' = see-through).
  // paint: [x, y, w, h, colour]; at: [x, y, w, h] hotspot in grid cells.
  var ROOMS = [
    {
      id: 'study', name: "The Clockmaker's Study", short: 'Study', level: 1, par: 15 * 60,
      intro: 'The door clicks shut behind you. Ticking somewhere... no — silence. Every clock in the study has stopped. Find a way out.',
      outro: 'The bolt slides back and the door swings open onto a cool hallway. Somewhere behind you, the old clock ticks on.',
      exit: 'door_code door_key',
      views: [
        { id: 'desk', name: 'Desk', art: [
          '          .------------------.     ___     ',
          '          |      .     *     |    /   \\    ',
          '          |  *     /\\    .   |   /_____\\   ',
          '          |    /\\ /  \\/\\     |      |      ',
          '          | __/  \\/   /  \\__ |      |      ',
          "          '------------------'     _|_     ",
          '  ________________________________/___\\__  ',
          ' | .-----.   ____                         | ',
          ' | |~~~~~|  [____]>          o====        | ',
          " |_'-----'________________________________| ",
          ' | .--------------. |    | .--------------. ',
          ' | |     (#)      | |    | |      ( )     | ',
          " | '--------------' |    | '--------------' ",
          ' |__________________|    |__________________| ',
          ' ||                ||    ||                || ',
          " ''                ''    ''                '' "],
          paint: [[10, 0, 20, 6, 'w'], [12, 2, 16, 3, 'b'], [1, 6, 44, 10, 'w'], [3, 7, 7, 3, 't'], [35, 0, 7, 6, 'y']],
          patches: [
            { if: 'lamp_on', x: 33, y: 0, l: ['$$___$$', '$/   \\$', '/_____\\', ' \\ | / ', '-  |  -'], c: 'y' },
            { if: 'open:drawer', x: 3, y: 10, l: ['.--------------.', '|   (empty)    |', "'--------------'"] }
          ] },
        { id: 'shelf', name: 'Bookshelf', art: [
          '  ______________________________________   ',
          ' |                                      |  ',
          ' |        .-.                   ,;,     |  ',
          ' |  .-.   |G|                  (\\|/)    |  ',
          ' |  |R|.-.| |                  _\\|/_    |  ',
          ' |  | ||B|| |                 |_____|   |  ',
          ' |  | || || |.-.               \\___/    |  ',
          ' |  | || || ||Y|                        |  ',
          ' |======================================|  ',
          ' |   ______ ______  ____ _____  _____   |  ',
          ' |  |______|______||____|_____|]_____|  |  ',
          ' |======================================|  ',
          ' |   .------------------------------.   |  ',
          ' |   |   [ ]  [ ]  [ ]  [ ]   (o)   |   |  ',
          " |   '------------------------------'   |  ",
          ' |______________________________________|  '],
          paint: [[1, 0, 40, 16, 'w'], [4, 3, 3, 5, 'r'], [7, 4, 3, 4, 'b'], [10, 2, 3, 6, 'g'], [13, 6, 3, 2, 'y'], [30, 2, 7, 3, 'g'], [3, 9, 35, 2, 'm']],
          patches: [
            { if: 'book_pulled', x: 31, y: 9, l: ['       ', '[     ]'], c: 'f' },
            { if: 'open:cabinet', x: 5, y: 13, l: ['|     (the doors hang open)    |'], c: 'g' }
          ] },
        { id: 'door', name: 'Door', art: [
          '        .-----------------.                ',
          '        |  .-----------.  |        __      ',
          '        |  |           |  |       (__)     ',
          '        |  |           |  |       /||\\     ',
          '        |  |           |  |      / || \\    ',
          "        |  '-----------'  |     |  ||  |   ",
          '        |  .-----------.  |     |  ||  |   ',
          '        |  |           |  |     |__||__|   ',
          '        |  |         .-|  |  .-----.       ',
          '        |  |        (o)|  |  |1 2 3|       ',
          "        |  |         '-|  |  |4 5 6|       ",
          "        |  '-----------'  |  |7 8 9|       ",
          '        |                 |  |* 0 #|       ',
          "        |                 |  '-----'       ",
          '  ______|_________________|______________  ',
          '                                           '],
          paint: [[8, 0, 19, 14, 'w'], [30, 1, 12, 7, 'v'], [29, 8, 7, 6, 't']],
          patches: [
            { if: 'door_key', x: 20, y: 9, l: ['(-)'], c: 'a' },
            { if: 'door_code', x: 29, y: 8, l: ['.--*--.'], c: 'g' }
          ] },
        { id: 'clock', name: 'Clock & fireplace', art: [
          '    .-----.                                ',
          '   /  XII  \\    ______ ______ ______ ______ ',
          '  |9   o   3|  |  II  | VII  |  IX  |  I   |',
          '   \\  VI   /   |  •   | •••  | •••• |  ••  |',
          "    |-----|    '------'------'------'------'",
          '    | .-. |   ============================== ',
          '    | | | |    |   _______________________ | ',
          '    | | | |    |  |     (    )   (  )     || ',
          '    | |O| |    |  |   (   )  ) (  )  (    || ',
          "    | '-' |    |  |   _)(__)(___)(__)(_   || ",
          '    |     |    |  |__/_________________\\__|| ',
          '    | [_] |    |___________________________| ',
          '    |_____|                                ',
          '   /_______\\     .:::::::::::::::::::::.   ',
          '                .:::::::::::::::::::::::.  ',
          '                                           '],
          paint: [[2, 0, 11, 14, 'w'], [14, 1, 30, 4, 'm'], [14, 3, 30, 1, 'a'], [20, 7, 20, 3, 'o'], [13, 5, 31, 7, 'w'], [16, 13, 25, 2, 'r']],
          patches: [
            { if: 'clock_wound', x: 4, y: 5, l: ['| .-. |', '| |\\| |', '| | \\ |', '| | O |'], c: 'a' },
            { if: 'clock_wound', x: 4, y: 11, l: ['|[___]|'], c: 'y' }
          ] }
      ],
      objects: {
        painting: { view: 'desk', at: [10, 0, 20, 6], name: 'Painting', look: [
          { say: 'A small oil painting of mountains under stars. Signed in the corner: "E. Halloway, clockmaker".' }] },
        lamp: { view: 'desk', at: [34, 0, 8, 6], name: 'Desk lamp', look: [
          { if: '!lamp_on', say: 'You switch the lamp on. Warm light pools across the desk.', do: 'set:lamp_on sfx:click' },
          { say: 'You switch the lamp off again.', do: 'clr:lamp_on sfx:click' }] },
        inkpot: { view: 'desk', at: [3, 7, 7, 3], name: 'Ink blotter', look: [
          { say: 'An ink blotter, covered in backwards scribbles of gears. Nothing you can read.' }] },
        note: { view: 'desk', at: [12, 7, 7, 2], name: 'Note', look: [
          { say: 'A note in a hurried hand.', do: 'zoom:note_desk' }] },
        pen: { view: 'desk', at: [27, 7, 7, 2], name: 'Pen', look: [
          { say: 'A fountain pen, bone dry.' }] },
        drawer: { view: 'desk', at: [3, 10, 16, 3], name: 'Left drawer', look: [
          { if: '!open:drawer', say: 'The drawer is held shut by a three-digit combination dial.', do: 'lock:drawer' },
          { say: 'The drawer is empty now.' }] },
        drawer2: { view: 'desk', at: [25, 10, 16, 3], name: 'Right drawer', look: [
          { say: 'Pencil shavings and a dried-up pot of ink. Nothing useful.' }] },

        books: { view: 'shelf', at: [3, 2, 13, 6], name: 'Four books', look: [
          { say: 'Four tall books in red, blue, green and yellow, each a different height. Left to right: red, blue, green, yellow.' }] },
        plant: { view: 'shelf', at: [29, 2, 9, 5], name: 'Potted fern', look: [
          { say: 'A thirsty fern in a pot. You check the soil — just soil.' }] },
        rowbooks: { view: 'shelf', at: [3, 9, 27, 2], name: 'Row of books', look: [
          { say: 'Dusty volumes on gears, springs and escapements. None of them budge.' }] },
        oddbook: { view: 'shelf', at: [30, 9, 8, 2], name: 'Protruding book', look: [
          { if: '!book_pulled', say: 'One book sticks out further than the rest. You pull it — it is hollow! Inside: a torn scrap of paper.', do: 'set:book_pulled give:note_b sfx:find' },
          { say: 'The hollow book is empty now.' }] },
        cabinet: { view: 'shelf', at: [4, 12, 34, 3], name: 'Cabinet', look: [
          { if: '!open:cabinet', say: 'A cabinet with a lock of four coloured wheels. A brass plate sits above them.', do: 'lock:cabinet' },
          { say: 'The cabinet is open and empty.' }],
          use: { loupe: [
            { if: '!plate_read', say: 'Through the loupe the tiny engraving on the plate reads: "SHORTEST TO TALLEST".', do: 'set:plate_read sfx:find' },
            { say: 'The plate reads: "SHORTEST TO TALLEST".' }] } },

        door: { view: 'door', at: [8, 0, 19, 14], name: 'Door', look: [
          { if: '!door_code !door_key', say: 'A heavy oak door. It has a keypad beside it AND a keyhole: both will be needed.' },
          { if: '!door_code', say: 'The key has turned, but the bolt is still held by the keypad.' },
          { if: '!door_key', say: 'The keypad has released its bolt, but the keyhole is still locked.' },
          { say: 'The door is open.' }],
          use: { brass_key: [{ say: 'The brass key turns with a satisfying clunk.', do: 'set:door_key take:brass_key sfx:unlock' }] } },
        keypad: { view: 'door', at: [29, 8, 7, 6], name: 'Keypad', look: [
          { if: '!open:keypad', say: 'A brass keypad. Four digits, it seems.', do: 'lock:keypad' },
          { say: 'The keypad glows green.' }] },
        coat: { view: 'door', at: [32, 1, 10, 7], name: 'Coat', look: [
          { if: '!got_frame', say: 'An old coat on a hook. In the pocket: an empty brass frame — a loupe without its glass.', do: 'set:got_frame give:frame sfx:find' },
          { say: 'The pockets are empty now.' }] },

        face: { view: 'clock', at: [2, 0, 11, 5], name: 'Clock face', look: [
          { if: '!clock_wound', say: 'The grandfather clock has stopped. The short hand rests on the 4; the long hand points at the 7.' },
          { say: 'The clock is running again: tick... tock...' }] },
        clockbody: { view: 'clock', at: [4, 5, 7, 6], name: 'Clock case', look: [
          { if: '!clock_wound', say: 'Behind the glass, a still pendulum. There is a square winding hole in the case — it needs a crank.' },
          { say: 'The pendulum swings steadily.' }],
          use: { crank: [{ say: 'You wind the clock. It shudders, ticks, then strikes — and a little drawer in its base springs open! Inside: a brass key.', do: 'set:clock_wound take:crank give:brass_key sfx:chime' }] } },
        clockbase: { view: 'clock', at: [4, 11, 7, 2], name: 'Clock base', look: [
          { if: '!clock_wound', say: 'The base of the clock. There seems to be a thin seam, like a tiny drawer — but no handle.' },
          { say: 'The little drawer in the base is empty.' }] },
        tiles: { view: 'clock', at: [14, 1, 30, 4], name: 'Tiles', look: [
          { say: 'Four painted tiles above the mantel.', do: 'zoom:tiles' }] },
        fire: { view: 'clock', at: [16, 6, 27, 5], name: 'Fireplace', look: [
          { say: 'Cold ashes. Whatever burned here burned long ago.' }] },
        rug: { view: 'clock', at: [16, 13, 25, 2], name: 'Rug', look: [
          { say: 'You lift the corner of the rug. Just floorboards, and a lot of dust.' }] }
      },
      items: {
        lens: { name: 'Glass lens', glyph: '()', desc: 'A small round magnifying lens with no frame.' },
        frame: { name: 'Brass frame', glyph: '[]', desc: 'A brass loupe frame. The glass is missing.' },
        loupe: { name: 'Loupe', glyph: 'Q', desc: 'A jeweller\'s loupe. Perfect for reading tiny engravings.' },
        note_a: { name: 'Torn note (left)', glyph: '=', desc: 'The left half of a torn note.', zoom: 'note_a' },
        note_b: { name: 'Torn note (right)', glyph: '=', desc: 'The right half of a torn note.', zoom: 'note_b' },
        note_full: { name: 'Mended note', glyph: '#', desc: 'Both halves of the note, pressed together.', zoom: 'note_full' },
        crank: { name: 'Crank handle', glyph: 'L', desc: 'A brass crank with a square end.' },
        brass_key: { name: 'Brass key', glyph: 'o-', desc: 'A heavy brass key.' }
      },
      combos: [
        { a: 'lens', b: 'frame', say: 'The lens clicks into the frame: a working loupe!', do: 'take:lens take:frame give:loupe sfx:find' },
        { a: 'note_a', b: 'note_b', say: 'The torn edges match perfectly.', do: 'take:note_a take:note_b give:note_full zoom:note_full sfx:find' }
      ],
      locks: {
        drawer: { kind: 'wheels', style: 'digit', n: 3, title: 'Drawer dial', plate: 'Three brass wheels, 0 to 9.', answer: ['4', '3', '5'],
          open: { say: 'Click! The drawer slides open. Inside: a glass lens and half of a torn note.', do: 'give:lens give:note_a' } },
        cabinet: { kind: 'wheels', style: 'colour', n: 4, title: 'Colour lock', plate: 'The engraving on the plate is far too small to read.',
          plates: [{ if: 'plate_read', text: 'Engraved: "SHORTEST TO TALLEST".' }],
          answer: ['yellow', 'blue', 'red', 'green'],
          open: { say: 'The colour wheels click into place and the cabinet opens. Inside: a brass crank handle.', do: 'give:crank' } },
        keypad: { kind: 'keypad', n: 4, title: 'Door keypad', plate: 'Enter the four-digit code.', answer: '2179',
          open: { say: 'Beep-beep! The keypad turns green and a bolt slides back.', do: 'set:door_code' } }
      },
      zooms: {
        note_desk: { title: 'Note on the desk', art: [
          '  Lost track of time again!',
          '',
          '  I set the drawer to the very moment',
          '  the old clock stopped.',
          '                              -- E.H.'] },
        tiles: { title: 'Tiles above the mantel', art: [
          '  .------.------.------.------.',
          '  |  II  | VII  |  IX  |  I   |',
          '  |  •   | •••  | •••• |  ••  |',
          "  '------'------'------'------'"],
          text: 'Roman numerals, each with a few painted dots.' },
        note_a: { title: 'Torn note (left half)', art: [
          '  The way out is wri~',
          '  counted by its d~',
          '                 ~'] },
        note_b: { title: 'Torn note (right half)', art: [
          '  ~tten above the fire,',
          '  ~ots, fewest first.',
          '  ~           -- E.H.'] },
        note_full: { title: 'The mended note', art: [
          '  The way out is written above the fire,',
          '  counted by its dots, fewest first.',
          '                               -- E.H.'] }
      },
      puzzles: [
        { id: 'drawer', name: 'The desk drawer', avail: '', done: 'open:drawer', hints: [
          'The note on the desk talks about the drawer. Read it carefully.',
          'The "moment the old clock stopped" is a time. Look at the clock on the west wall.',
          'The clock stopped at 4:35 (long hand on the 7 = 35 minutes). Dial 4-3-5.'] },
        { id: 'loupe', name: 'Something to read tiny print', avail: 'open:drawer', done: '@loupe', hints: [
          'The lens from the drawer is useless on its own. Something needs to hold it.',
          'Check the coat hanging by the door.',
          'Take the brass frame from the coat pocket and combine it with the lens.'] },
        { id: 'cabinet', name: 'The colour cabinet', avail: '', done: 'open:cabinet', hints: [
          'The plate above the wheels has a message, but it is tiny. You need a loupe.',
          'The plate says "shortest to tallest". Which coloured things in the room have different heights?',
          'The four books: yellow is shortest, then blue, then red, then green. Set Y-B-R-G.'] },
        { id: 'clock', name: 'The stopped clock', avail: 'open:cabinet', done: 'clock_wound', hints: [
          'The clock case has a square winding hole.',
          'The crank from the cabinet has a square end.',
          'Select the crank and tap the clock case to wind it.'] },
        { id: 'note', name: 'The torn note', avail: 'open:drawer', done: '@note_full', hints: [
          'You have one half of a note. Where might the other half be hidden?',
          'On the bookshelf, one book sticks out further than the others.',
          'Pull the protruding book on the lower shelf, then combine the two halves.'] },
        { id: 'keypad', name: 'The door keypad', avail: '', done: 'open:keypad', hints: [
          'The mended note says the way out is "written above the fire".',
          'Look at the tiles above the fireplace and count the dots on each.',
          'Order the tiles by dots: II (1), I (2), VII (3), IX (4). The code is 2179.'] },
        { id: 'key', name: 'The keyhole', avail: '', done: 'door_key', hints: [
          'The door needs a key as well as the code.',
          'Something in the room locked away a key. The clock base has a hidden drawer.',
          'Wind the clock with the crank to get the brass key, then use it on the door.'] }
      ]
    },

    {
      id: 'glass', name: 'The Glasshouse', short: 'Glasshouse', level: 2, par: 20 * 60,
      intro: 'Warm, damp air and the smell of soil. The glasshouse gate has swung shut and locked behind you. The gardener left in a hurry...',
      outro: 'The padlock drops open and the iron gate creaks wide. Fresh air! The ferns wave you goodbye.',
      exit: 'gate_word gate_key',
      views: [
        { id: 'pots', name: 'Pot shelf', art: [
          '   /\\     /\\     /\\     /\\     /\\     /\\    ',
          '  /  \\   /  \\   /  \\   /  \\   /  \\   /  \\   ',
          '',
          '         \\|/      .       \\|/      \\ /',
          '         (|)     (|)      )|(      (|)',
          '        .---.   .---.    .---.    .---.',
          '        |III|   | I |    | IV|    |II |',
          "        '---'   '---'    '---'    '---'",
          '        [   ]   [   ]    [   ]    [   ]',
          '      ===================================',
          '       ||                             ||',
          '       ||    .--------------------.   ||',
          '       ||   /  . . . . . . . . . . \\  ||',
          '       ||  |::::::::::::::::::::::::| ||',
          '           |::::::::::::::::::::::::|',
          "           '------------------------'"],
          paint: [[0, 0, 44, 2, 'f'], [8, 3, 30, 2, 'g'], [8, 5, 30, 3, 'o'], [6, 9, 34, 7, 'w']],
          patches: [
            { if: 'pots_wet', x: 8, y: 8, l: ['[ ☾ ]   [ ★ ]    [ ☼ ]    [ ♣ ]'], c: 'a' },
            { if: 'planter_wet', x: 15, y: 12, l: ['~ ~ ~ ~ ~ ~ ~ ~ ~ ~'], c: 'b' },
            { if: 'dug', x: 19, y: 12, l: ['\\__/'], c: 'w' }
          ] },
        { id: 'sink', name: 'Sink', art: [
          '   /\\     /\\     /\\     /\\     /\\     /\\    ',
          '  /  \\   /  \\   /  \\   /  \\   /  \\   /  \\   ',
          '                         .----------------. ',
          '        ___              | ☼ ☾ ★ ♣ ♥      | ',
          '       |   |-.           | [_][_][_][_]   | ',
          '            _|_          |   SEEDS        | ',
          '           (   )         |                | ',
          "   .--------------------.'----------------' ",
          '   |\\                  /|                   ',
          '   | \\________________/ |      __           ',
          '   |____________________|    _/  \\____      ',
          '    |                  |    | \\__/   _\\     ',
          '    |                  |    |       |       ',
          '    |__________________|    \'-------\'       ',
          '                                            ',
          '                                            '],
          paint: [[0, 0, 44, 2, 'f'], [3, 7, 22, 7, 'm'], [7, 3, 9, 4, 't'], [25, 2, 18, 6, 'w'], [27, 3, 14, 1, 'a'], [28, 9, 12, 5, 'g']],
          patches: [
            { if: 'tap_fixed', x: 8, y: 2, l: ['_+_'], c: 'a' },
            { if: 'got_can', x: 28, y: 9, l: ['            ', '            ', '            ', '            ', '            '] },
            { if: 'open:seeds', x: 27, y: 4, l: ['(open)        '], c: 'g' }
          ] },
        { id: 'gate', name: 'Gate', art: [
          '   /\\     /\\     /\\     /\\     /\\     /\\    ',
          '  /  \\   /  \\   /  \\   /  \\   /  \\   /  \\   ',
          '     _    _    _    _    _    _    _        ',
          '    | |  | |  | |  | |  | |  | |  | |       ',
          '    | |  | |  | |  | |  | |  | |  | |       ',
          '    | |  | |  | |  | |  | |  | |  | |       ',
          '  ==|=|==|=|==|=|==|=|==|=|==|=|==|=|==     ',
          '    | |  | |  | |  .-----.  | |  | |        ',
          '    | |  | |  | | |? ? ? ? ?| |  | |        ',
          "    | |  | |  | |  '-----'  | |  | |        ",
          '    | |  | |  | |  |  o  |  | |  | |        ',
          '  ==|=|==|=|==|=|==|=|==|=|==|=|==|=|==     ',
          '    | |  | |  | |  | |  | |  | |  | |       ',
          '    |_|  |_|  |_|  |_|  |_|  |_|  |_|       ',
          '  ,,;,,,;;,,,,,;,,,;,,,,,;;,,,,;,,,;,,,     ',
          '                                            '],
          paint: [[0, 0, 44, 2, 'f'], [2, 2, 38, 12, 'm'], [18, 7, 11, 3, 'y'], [19, 10, 7, 1, 't'], [2, 14, 38, 1, 'g']],
          patches: [
            { if: 'gate_word', x: 19, y: 8, l: ['F E R N S'], c: 'g' },
            { if: 'gate_key', x: 19, y: 10, l: ['|  -  |'], c: 'g' }
          ] },
        { id: 'bench', name: 'Potting bench', art: [
          '   /\\     /\\     /\\     /\\     /\\     /\\    ',
          '  /  \\   /  \\   /  \\   /  \\   /  \\   /  \\   ',
          '    .-----------------.                     ',
          '    | . . . . . X     |       .---.         ',
          '    | . o o o . o     |       |   |         ',
          '    | . o . o o o     |       | ~ |         ',
          '    | . o . . . .     |       |___|         ',
          '    | . S . . . .     |                     ',
          "    '-----------------'   .------------.    ",
          '                          |[^][v][<][>]|    ',
          '  ________________________|____________|__  ',
          ' |________________________________________| ',
          '   ||                                  ||   ',
          '   ||    .-.  .-.                      ||   ',
          '   ||   (   )(   )                     ||   ',
          '   ||                                  ||   '],
          paint: [[0, 0, 44, 2, 'f'], [4, 2, 19, 7, 'y'], [29, 3, 5, 4, 't'], [26, 8, 14, 3, 'r'], [1, 10, 42, 6, 'w'], [8, 13, 10, 2, 'o']],
          patches: [
            { if: 'open:toolbox', x: 26, y: 8, l: ['.---(open)---.', '|            |'], c: 'r' }
          ] }
      ],
      objects: {
        potsrow: { view: 'pots', at: [7, 3, 32, 6], name: 'Four pots', look: [
          { if: '!pots_wet', say: 'Four pots, numbered on their rims III, I, IV, II. Each has a blank chalk tag... the chalk looks faint, as if it only shows when wet.' },
          { say: 'The wet chalk tags show a symbol under each pot.', do: 'zoom:tags' }],
          use: { can_full: [{ if: '!pots_wet', say: 'You water the pots. As the chalk tags get wet, a symbol darkens on each one!', do: 'set:pots_wet zoom:tags sfx:water' },
            { say: 'They have had plenty of water.' }], can: [{ say: 'The watering can is empty.' }] } },
        planter: { view: 'pots', at: [11, 11, 26, 5], name: 'Big planter', look: [
          { if: '!planter_wet', say: 'A big planter full of soil, baked hard as brick.' },
          { if: '!dug', say: 'The soil is soft and damp now. You could dig in it.' },
          { say: 'Just a hole where the tin was.' }],
          use: { can_full: [{ if: '!planter_wet', say: 'You soak the planter. The hard soil darkens and softens.', do: 'set:planter_wet sfx:water' }, { say: 'It is wet enough.' }],
            can: [{ say: 'The watering can is empty.' }],
            trowel: [{ if: '!planter_wet', say: 'The trowel just scrapes the rock-hard soil. If only it were softer...' },
              { if: '!dug', say: 'You dig into the damp soil and hit metal: an old tin! Inside is a heavy iron key.', do: 'set:dug give:gate_key sfx:find' },
              { say: 'Nothing else is buried here.' }] } },
        roof: { view: 'pots', at: [0, 0, 44, 2], name: 'Glass roof', look: [{ say: 'Panes of fogged glass. Far too high to climb.' }] },

        tap: { view: 'sink', at: [7, 3, 9, 4], name: 'Tap', look: [
          { if: '!tap_fixed', say: 'The tap is missing its handle. Just a bare square spindle.' },
          { say: 'Water splashes into the sink. You turn it off again.', do: 'sfx:water' }],
          use: { tap_handle: [{ say: 'The handle slots onto the spindle. The tap works!', do: 'set:tap_fixed take:tap_handle sfx:click' }],
            can: [{ if: '!tap_fixed', say: 'No handle, no water.' }, { say: 'You fill the watering can to the brim.', do: 'take:can give:can_full sfx:water' }],
            can_full: [{ say: 'It is already full.' }] } },
        sinkbowl: { view: 'sink', at: [3, 7, 22, 7], name: 'Sink', look: [{ say: 'A deep stone sink. A dead spider and a lot of soil.' }] },
        seeds: { view: 'sink', at: [25, 2, 18, 6], name: 'Seed cabinet', look: [
          { if: '!open:seeds', say: 'A seed cabinet locked by four symbol wheels. A painted line above them: ☼ ☾ ★ ♣ ♥.', do: 'lock:seeds' },
          { say: 'The seed cabinet stands open. Only seed dust left.' }] },
        can: { view: 'sink', at: [28, 9, 12, 5], name: 'Watering can', show: '!got_can', look: [
          { say: 'You pick up the watering can. It is empty.', do: 'set:got_can give:can sfx:find' }] },

        gatebars: { view: 'gate', at: [2, 2, 15, 12], name: 'Iron gate', look: [
          { say: 'The gate is padlocked AND has an old keyhole. You will need to deal with both.' }] },
        padlock: { view: 'gate', at: [18, 7, 11, 3], name: 'Letter padlock', look: [
          { if: '!open:padlock', say: 'A padlock with five letter wheels.', do: 'lock:padlock' },
          { say: 'The padlock hangs open.' }] },
        keyhole: { view: 'gate', at: [19, 10, 7, 2], name: 'Keyhole', look: [
          { if: '!gate_key', say: 'A big old keyhole in the gate\'s lock box.' },
          { say: 'The key has turned.' }],
          use: { gate_key: [{ say: 'The iron key turns with a grinding clank.', do: 'set:gate_key take:gate_key sfx:unlock' }] } },
        weeds: { view: 'gate', at: [2, 14, 38, 1], name: 'Weeds', look: [{ say: 'Weeds poke through the gravel. One of them looks like a tiny fern.' }] },

        map: { view: 'bench', at: [4, 2, 19, 7], name: 'Garden map', look: [
          { say: 'A garden plan pinned above the bench.', do: 'zoom:map' }] },
        jar: { view: 'bench', at: [29, 3, 5, 4], name: 'Jar', look: [{ say: 'A jar of murky water with a single tadpole. It ignores you.' }] },
        toolbox: { view: 'bench', at: [26, 8, 14, 3], name: 'Toolbox', look: [
          { if: '!open:toolbox', say: 'A red toolbox with a directional lock: up, down, left, right.', do: 'lock:toolbox' },
          { say: 'The toolbox is open and empty.' }] },
        sacks: { view: 'bench', at: [8, 13, 10, 2], name: 'Sacks', look: [{ say: 'Sacks of compost. You rummage — nothing but compost.' }] }
      },
      items: {
        tap_handle: { name: 'Tap handle', glyph: '+', desc: 'A cross-shaped tap handle with a square hole.' },
        trowel: { name: 'Trowel', glyph: '/', desc: 'A small garden trowel.' },
        can: { name: 'Empty can', glyph: 'U', desc: 'An empty watering can.' },
        can_full: { name: 'Full can', glyph: 'U~', desc: 'A watering can full of water.' },
        envelope: { name: 'Envelope', glyph: '@', desc: 'An envelope with a poem inside.', zoom: 'poem' },
        gate_key: { name: 'Iron key', glyph: 'o=', desc: 'A heavy old iron key, gritty with soil.' }
      },
      combos: [],
      locks: {
        toolbox: { kind: 'dir', n: 16, title: 'Directional lock', plate: 'Engraved: "THE GARDEN PATH, ONE STONE PER PUSH"',
          answer: 'UUURRDRRUU',
          open: { say: 'The shackle pops! Inside the toolbox: a tap handle and a trowel.', do: 'give:tap_handle give:trowel' } },
        seeds: { kind: 'wheels', style: 'weather', n: 4, title: 'Symbol lock', plate: 'Painted: "SOW BY THE NUMBERS — I · II · III · IV"',
          answer: ['star', 'clover', 'moon', 'sun'],
          open: { say: 'The wheels line up and the cabinet door swings open. Inside, an envelope.', do: 'give:envelope zoom:poem' } },
        padlock: { kind: 'wheels', style: 'letter', n: 5, title: 'Letter padlock', plate: 'Five letter wheels, A to Z.',
          answer: ['F', 'E', 'R', 'N', 'S'],
          open: { say: 'F-E-R-N-S. The padlock springs open!', do: 'set:gate_word' } }
      },
      zooms: {
        map: { title: 'Garden map', art: [
          '   N                      ',
          '   ^   . . . . . X        ',
          '       . o o o . o        ',
          '       . o . o o o        ',
          '       . o . . . .        ',
          '       . S . . . .        ',
          '',
          '   S = shed      X = tree',
          '   o = stepping stones'],
          text: 'Stepping stones lead from the shed (S) to the old tree (X).' },
        tags: { title: 'The wet chalk tags', art: [
          '    .---.   .---.    .---.    .---.',
          '    |III|   | I |    | IV|    |II |',
          "    '---'   '---'    '---'    '---'",
          '    [ ☾ ]   [ ★ ]    [ ☼ ]    [ ♣ ]'],
          text: 'Pots left to right: III, I, IV, II.' },
        poem: { title: 'A poem in the envelope', art: [
          '  Find me where the shadows creep,',
          '  Every frond unrolled from sleep,',
          '  Rain is all I ask of you,',
          '  Not the sun — just morning dew.',
          '  Say my name and walk on through.'] }
      },
      puzzles: [
        { id: 'toolbox', name: 'The toolbox', avail: '', done: 'open:toolbox', hints: [
          'The lock wants a series of directions. Is there a path drawn anywhere?',
          'The garden map above the bench shows stepping stones from S to X — one push per stone.',
          'From S: up, up, up, right, right, down, right, right, up, up.'] },
        { id: 'water', name: 'Getting water', avail: 'open:toolbox', done: '@can_full', hints: [
          'The tap has no handle, but you found one.',
          'Use the tap handle on the tap. Is there anything to carry water in?',
          'Pick up the watering can by the sink, then use it on the working tap.'] },
        { id: 'seeds', name: 'The seed cabinet', avail: '', done: 'open:seeds', hints: [
          'The cabinet says "sow by the numbers". Which things in the glasshouse are numbered?',
          'The pots are numbered III, I, IV, II. Their chalk tags only show when wet — water the pots.',
          'Pot I has ★, II has ♣, III has ☾, IV has ☼. Set ★ ♣ ☾ ☼.'] },
        { id: 'padlock', name: 'The letter padlock', avail: 'open:seeds', done: 'open:padlock', hints: [
          'Read the poem from the envelope. "Say my name".',
          'The poem is an acrostic: read the first letter of each line.',
          'F-E-R-N-S. Set the padlock to FERNS.'] },
        { id: 'key', name: 'The gate key', avail: 'open:toolbox', done: 'gate_key', hints: [
          'The gate has a keyhole. Something might be buried.',
          'The big planter\'s soil is too hard to dig. Water it first.',
          'Water the planter with the full can, then dig with the trowel. Use the key on the gate keyhole.'] }
      ]
    },

    {
      id: 'observatory', name: 'The Observatory', short: 'Observatory', level: 3, par: 25 * 60,
      intro: 'A dome of stars above, a dark room below. The astronomer locked the roof hatch and left you a riddle. The comet passes tonight — get out and see it.',
      outro: 'The hatch swings up and cold night air rushes in. Above you, the comet streaks across the Ring. You made it.',
      exit: 'hatch_code hatch_crank',
      views: [
        { id: 'scope', name: 'Telescope', art: [
          '     .     *         .          *     .     ',
          '  *     .--------------------------.    .   ',
          '        |  .     *    .      .     |        ',
          '   .    |     .     .     *     .  |   *    ',
          "        '--------------------------'        ",
          '                  ___                       ',
          '                 /   \\===========           ',
          '                |     |==========|          ',
          '                 \\___/===========           ',
          '                   ||                       ',
          "              .----''----.     .-------.    ",
          '              |   AIM:   |     | () () |    ',
          "              '----..----'     '-------'    ",
          '                  /  \\                      ',
          '                 /    \\                     ',
          '  ______________/______\\_________________   '],
          paint: [[0, 0, 44, 5, 'f'], [8, 1, 28, 4, 'b'], [16, 5, 19, 5, 'a'], [14, 10, 12, 3, 't'], [32, 10, 9, 3, 'w'], [2, 13, 40, 3, 'm']],
          patches: [
            { if: 'eyepiece', x: 15, y: 7, l: ['=|  o  |'], c: 'a' },
            { if: 'open:aim', x: 14, y: 11, l: ['|AIM: RING |'], c: 'g' }
          ] },
        { id: 'chart', name: 'Star chart', art: [
          "  .--------------------------------------.  ",
          "  |     *                                |  ",
          "  |    / \\       *      .*'*.     *---*  |  ",
          "  |   *   *     / \\    *     *    |   |  |  ",
          "  |    \\ /     *---*    '*.*'     *---*  |  ",
          "  |     *                                |  ",
          "  |   KITE   LANTERN    RING      TOWER  |  ",
          "  |   9 pm    11 pm    10 pm      8 pm   |  ",
          "  '--------------------------------------'  ",
          '                                            ',
          '       .-----------------------.            ',
          '       |  [ ] [ ] [ ] [ ]      |            ',
          '       |                       |            ',
          '       |_______________________|            ',
          '       |_______________________|            ',
          '                                            '],
          paint: [[2, 0, 40, 9, 'b'], [3, 1, 38, 5, 'y'], [3, 6, 38, 2, 't'], [7, 10, 25, 5, 'w']],
          patches: [
            { if: 'open:cabinet', x: 7, y: 11, l: ['|  (open, and empty)    |'], c: 'g' }
          ] },
        { id: 'hatch', name: 'Roof hatch', art: [
          '   ____________________         .-----.      ',
          '  |  ________________  |        |1 2 3|      ',
          '  | |  ROOF   HATCH  | |  [ ]   |4 5 6|      ',
          '  | |________________| |        |7 8 9|      ',
          '  |____________________|        |* 0 #|      ',
          "       |H|                      '-----'      ",
          '       |H|                                   ',
          '       |H|                    █████████████ ',
          '       |H|                    █████████████ ',
          '       |H|                    █████████████ ',
          '       |H|                    █████████████ ',
          '       |H|                    █████████████ ',
          '       |H|                    █████████████ ',
          '       |H|                    █████████████ ',
          '  _____|H|____________________█████████████_ ',
          '                                            '],
          paint: [[2, 0, 22, 5, 'w'], [7, 5, 3, 10, 'w'], [25, 2, 5, 1, 'a'], [32, 0, 7, 6, 't'], [30, 7, 14, 8, 'k']],
          patches: [
            { if: 'corner_lit', x: 30, y: 7, l: ['_|___|___|__|', '___|___|___|_', '_|___|___|__|', '___|___|___|_', '_|___|___|__|', '___|___|___|_', '_|___|___|__|', ',.,.,.,.,.,.,'], c: 'o' },
            { if: 'corner_lit !got_ball', x: 36, y: 9, l: ['[  ]'], c: 'a' }, { if: 'got_ball', x: 36, y: 9, l: ['    '] },
            { if: 'hatch_crank', x: 26, y: 2, l: ['[L]'], c: 'g' },
            { if: 'hatch_code', x: 32, y: 0, l: ['.--*--.'], c: 'g' }
          ] },
        { id: 'desk', name: 'Desk & orrery', art: [
          '                 o                            ',
          '          o       \\          .                ',
          '           \\       \\        .                 ',
          '            \\     .---.    .                  ',
          '     o-------)---( SUN )--:                   ',
          "                  '---'                       ",
          '                   _|_              _         ',
          '                  /___\\            [*]        ',
          '  _______________________________|___|_____   ',
          ' |   .------.        ____                  |  ',
          ' |   |~~~~~~|       |____|                 |  ',
          " |___'------'______________________________|  ",
          ' | .------------------. |                 |   ',
          ' | |       (#)        | |                 |   ',
          " | '------------------' |                 |   ",
          ' |______________________|_________________|   '],
          paint: [[4, 0, 26, 6, 'y'], [16, 3, 7, 3, 'o'], [17, 6, 6, 2, 'w'], [33, 6, 5, 3, 'o'], [1, 8, 43, 8, 'w'], [4, 9, 9, 3, 't'], [19, 9, 8, 2, 'r']],
          patches: [
            { if: 'got_lantern', x: 33, y: 6, l: ['     ', '     ', '_____'] },
            { if: 'orrery_set', x: 26, y: 0, l: ['$$$$O', '$$$.', '$$.', '$.'], c: 'a' },
            { if: 'open:drawer', x: 3, y: 12, l: ['.------------------.', '|      (empty)     |'] }
          ] }
      ],
      objects: {
        sky: { view: 'scope', at: [8, 0, 28, 5], name: 'Dome window', look: [{ say: 'Through the dome window: a thin slice of sky. Not enough to see the whole Ring.' }] },
        telescope: { view: 'scope', at: [16, 5, 19, 5], name: 'Telescope', look: [
          { if: '!eyepiece', say: 'A fine brass telescope — but the eyepiece is missing. You can\'t see a thing through it.' },
          { if: '!open:aim', say: 'The eyepiece is in. Now set where the telescope is aimed: the knob below has the names of the constellations.', do: 'lock:aim' },
          { say: 'You look through the eyepiece.', do: 'zoom:eyepiece' }],
          use: { eyepiece: [{ say: 'The eyepiece slides into the telescope. Now it needs aiming.', do: 'set:eyepiece take:eyepiece sfx:click' }] } },
        aimknob: { view: 'scope', at: [14, 10, 12, 3], name: 'Aim knob', look: [
          { if: '!open:aim', say: 'A knob that swings the telescope to a named constellation.', do: 'lock:aim' },
          { say: 'The telescope is aimed at the Ring.' }] },
        logbook: { view: 'scope', at: [32, 10, 9, 3], name: 'Spectacles case', look: [{ say: 'An empty spectacles case. The astronomer must have taken them.' }] },

        starchart: { view: 'chart', at: [2, 0, 40, 9], name: 'Star chart', look: [
          { say: 'A star chart with four constellations and the hour each one rises.', do: 'zoom:chart' }] },
        cabinet: { view: 'chart', at: [7, 10, 25, 5], name: 'Cabinet', look: [
          { if: '!open:cabinet', say: 'A cabinet locked by four shape wheels.', do: 'lock:cabinet' },
          { say: 'Open and empty.' }] },

        ladder: { view: 'hatch', at: [7, 6, 3, 9], name: 'Ladder', look: [{ say: 'A ladder up to the roof hatch.' }] },
        hatch: { view: 'hatch', at: [2, 0, 22, 5], name: 'Roof hatch', look: [
          { if: '!hatch_code !hatch_crank', say: 'The roof hatch is bolted. A keypad controls the bolt, and a crank socket opens the hatch itself.' },
          { if: '!hatch_crank', say: 'The bolt is open. The hatch needs cranking open — the socket is empty.' },
          { if: '!hatch_code', say: 'The crank is fitted, but the bolt is still held by the keypad.' },
          { say: 'Open!' }],
          use: { crank: [{ say: 'The crank fits the socket. You crank it until it clicks.', do: 'set:hatch_crank take:crank sfx:unlock' }] } },
        socket: { view: 'hatch', at: [25, 2, 5, 1], name: 'Crank socket', look: [
          { if: '!hatch_crank', say: 'A square crank socket for opening the hatch.' }, { say: 'The crank is fitted.' }],
          use: { crank: [{ say: 'The crank fits the socket. You crank it until it clicks.', do: 'set:hatch_crank take:crank sfx:unlock' }] } },
        hkeypad: { view: 'hatch', at: [32, 0, 7, 6], name: 'Keypad', look: [
          { if: '!open:keypad', say: 'A keypad for the hatch bolt. A label: "THE SKY HOLDS THE CODE".', do: 'lock:keypad' },
          { say: 'The keypad glows green.' }] },
        corner: { view: 'hatch', at: [30, 7, 14, 8], name: 'Dark corner', look: [
          { if: '!corner_lit !@lantern_lit', say: 'Pitch black. You can\'t see a thing in that corner.' },
          { if: '!corner_lit', say: 'You hold up the lantern. A brick wall... and one brick sits loose!', do: 'set:corner_lit sfx:find' },
          { if: '!got_ball', say: 'You pull out the loose brick. Behind it: a small brass ball.', do: 'set:got_ball give:ball sfx:find' },
          { say: 'Just bricks now.' }],
          use: { lantern_lit: [{ if: '!corner_lit', say: 'You hold up the lantern. A brick wall... and one brick sits loose!', do: 'set:corner_lit sfx:find' },
            { if: '!got_ball', say: 'You pull out the loose brick. Behind it: a small brass ball.', do: 'set:got_ball give:ball sfx:find' },
            { say: 'Just bricks now.' }], lantern: [{ say: 'The lantern is not lit.' }] } },

        orrery: { view: 'desk', at: [4, 0, 28, 8], name: 'Orrery', look: [
          { if: '!orrery_set', say: 'A brass orrery: a sun with planets on arms. One arm is empty — a planet is missing. A lever sits on its base.' },
          { say: 'The arm points at a small engraving on the rim: "RING".' }],
          use: { ball: [{ say: 'The brass ball fits the empty arm. The orrery whirs, the planets sweep round and the arm stops on an engraving: "RING". A drawer pops out of the base — inside, an eyepiece!', do: 'set:orrery_set take:ball give:eyepiece sfx:chime' }] } },
        lantern: { view: 'desk', at: [32, 5, 7, 4], name: 'Lantern', show: '!got_lantern', look: [
          { say: 'You pick up the oil lantern. It is not lit.', do: 'set:got_lantern give:lantern sfx:find' }] },
        riddle: { view: 'desk', at: [4, 9, 9, 3], name: 'Riddle', look: [{ say: 'A card propped on the desk.', do: 'zoom:riddle' }] },
        book: { view: 'desk', at: [19, 9, 8, 2], name: 'Book', look: [{ say: '"A Field Guide to the Night Sky". A page is folded: "Constellations rise in the east, one after another, as the night goes on."' }] },
        drawer: { view: 'desk', at: [3, 12, 20, 3], name: 'Drawer', look: [
          { if: '!open:drawer', say: 'The desk drawer has a three-digit dial.', do: 'lock:drawer' },
          { say: 'The drawer is empty.' }] }
      },
      items: {
        matches: { name: 'Matchbox', glyph: '[]', desc: 'A box of long matches.' },
        lantern: { name: 'Lantern', glyph: 'A', desc: 'An unlit oil lantern.' },
        lantern_lit: { name: 'Lit lantern', glyph: 'A*', desc: 'A lantern burning bright.' },
        ball: { name: 'Brass ball', glyph: 'O', desc: 'A small brass ball — like a planet from a model.' },
        eyepiece: { name: 'Eyepiece', glyph: 'o|', desc: 'A brass telescope eyepiece.' },
        crank: { name: 'Hatch crank', glyph: 'L', desc: 'A long crank handle with a square end.' }
      },
      combos: [
        { a: 'matches', b: 'lantern', say: 'You strike a match and light the lantern. Warm light!', do: 'take:lantern give:lantern_lit sfx:find' }
      ],
      locks: {
        drawer: { kind: 'wheels', style: 'digit', n: 3, title: 'Drawer dial', plate: 'Three wheels, 0 to 9.', answer: ['4', '6', '2'],
          open: { say: 'The drawer opens. Inside: a box of matches.', do: 'give:matches' } },
        cabinet: { kind: 'wheels', style: 'shape', n: 4, title: 'Shape lock', plate: 'Engraved: "IN THE ORDER THEY RISE"', answer: ['square', 'diamond', 'circle', 'triangle'],
          open: { say: 'The shapes align and the cabinet opens. Inside: a long crank handle.', do: 'give:crank' } },
        aim: { kind: 'wheels', style: 'word', n: 1, words: ['KITE', 'LANTERN', 'RING', 'TOWER'], title: 'Aim the telescope', plate: 'Swing the telescope to a constellation, then look.', answer: ['RING'],
          wrong: 'You look through the eyepiece: just ordinary stars. Nothing special there tonight.',
          open: { say: 'The telescope swings round to the Ring. You look through...', do: 'zoom:eyepiece' } },
        keypad: { kind: 'keypad', n: 4, title: 'Hatch keypad', plate: '"THE SKY HOLDS THE CODE"', answer: '3715',
          open: { say: 'Beep! The bolt on the hatch slides back.', do: 'set:hatch_code' } }
      },
      zooms: {
        riddle: { title: 'The astronomer\'s riddle', art: [
          '  My drawer has three digits.',
          '',
          '  - No two are alike, and none is zero.',
          '  - The first is twice the last.',
          '  - The middle is the other two, added.',
          '  - All three add up to twelve.'] },
        chart: { title: 'Star chart', art: [
          "     *                                ",
          "    / \\       *      .*'*.     *---*  ",
          "   *   *     / \\    *     *    |   |  ",
          "    \\ /     *---*    '*.*'     *---*  ",
          "     *                                ",
          "   KITE   LANTERN    RING      TOWER  ",
          "   9 pm    11 pm    10 pm      8 pm   ",
          "",
          "     ◇        △        ○         □    "],
          text: 'Each constellation\'s stars make a shape, and each rises at its own hour.' },
        eyepiece: { title: 'Through the eyepiece', art: [
          '  .            .                   .    ',
          '      *       * *                *   *  ',
          '     *  *    *   *        *        *    ',
          '             * * *               *   *  ',
          '  .                     .               ',
          '    ~~~~=====O                    .     ',
          '        .             .                 '],
          text: 'The comet blazes through the Ring. Around it the stars sit in tight clusters, left to right.' }
      },
      puzzles: [
        { id: 'drawer', name: 'The riddle drawer', avail: '', done: 'open:drawer', hints: [
          'Read the riddle on the desk. Each line rules out numbers.',
          'If the last digit is L, the first is 2L and the middle is 3L. All three add to 6L = 12.',
          'L = 2, so the code is 4-6-2.'] },
        { id: 'light', name: 'Some light', avail: 'open:drawer', done: '@lantern_lit', hints: [
          'Matches are for lighting something.',
          'There is an oil lantern on the desk.',
          'Pick up the lantern and combine it with the matchbox.'] },
        { id: 'corner', name: 'The dark corner', avail: '@lantern_lit', done: 'got_ball', hints: [
          'Somewhere in the observatory is too dark to see.',
          'By the roof hatch, the corner is pitch black.',
          'Use the lit lantern on the dark corner, then take the loose brick.'] },
        { id: 'orrery', name: 'The orrery', avail: 'got_ball', done: 'orrery_set', hints: [
          'The brass ball looks like a planet.',
          'The orrery on the desk is missing a planet.',
          'Use the brass ball on the orrery.'] },
        { id: 'aim', name: 'The telescope', avail: 'orrery_set', done: 'open:aim', hints: [
          'The telescope needs its eyepiece, then aiming.',
          'The orrery\'s arm pointed at a constellation name.',
          'Fit the eyepiece, then aim the telescope at RING.'] },
        { id: 'cabinet', name: 'The shape cabinet', avail: '', done: 'open:cabinet', hints: [
          '"In the order they rise." The star chart lists rising times.',
          'Each constellation\'s stars form a shape. Order them from earliest to latest rising.',
          'Tower (8 pm) □, Kite (9 pm) ◇, Ring (10 pm) ○, Lantern (11 pm) △.'] },
        { id: 'keypad', name: 'The hatch keypad', avail: 'open:aim', done: 'open:keypad', hints: [
          '"The sky holds the code." Look through the telescope at the Ring again.',
          'The stars sit in four clusters. Count the stars in each, left to right.',
          'The clusters have 3, 7, 1 and 5 stars. The code is 3715.'] },
        { id: 'crank', name: 'The hatch crank', avail: 'open:cabinet', done: 'hatch_crank', hints: [
          'The hatch has a square socket.',
          'The crank from the shape cabinet fits it.',
          'Use the hatch crank on the roof hatch.'] }
      ]
    }
  ];

  var ROOM = {};
  ROOMS.forEach(function (r) { ROOM[r.id] = r; });

  // ---------------- rules ----------------
  function toks(s) { return Array.isArray(s) ? s : String(s || '').split(/\s+/).filter(Boolean); }
  function cond(g, c) {
    var t = toks(c);
    for (var i = 0; i < t.length; i++) {
      var k = t[i], neg = k.charAt(0) === '!';
      if (neg) k = k.slice(1);
      var v = k.charAt(0) === '@' ? g.inv.indexOf(k.slice(1)) >= 0 : !!g.flags[k];
      if (v === neg) return false;
    }
    return true;
  }
  function roomOf(g) { return ROOM[g.room]; }
  function viewIndex(R, id) { for (var i = 0; i < R.views.length; i++) if (R.views[i].id === id) return i; return -1; }

  function newGame(roomId) {
    var R = ROOM[roomId] || ROOMS[0];
    return { v: 1, room: R.id, view: R.views[0].id, inv: [], flags: {}, hints: {}, lv: {}, t: 0, pen: 0, acts: 0, tries: 0, done: false, sel: null };
  }
  function newRes() { return { say: '', ui: null, got: [], lost: [], sfx: '', win: false, hit: false, ok: false }; }

  function doActs(g, acts, res) {
    toks(acts).forEach(function (a) {
      var i = a.indexOf(':'), op = i < 0 ? a : a.slice(0, i), arg = i < 0 ? '' : a.slice(i + 1);
      if (op === 'set') g.flags[arg] = true;
      else if (op === 'clr') delete g.flags[arg];
      else if (op === 'give') { if (g.inv.indexOf(arg) < 0) { g.inv.push(arg); res.got.push(arg); } }
      else if (op === 'take') { var j = g.inv.indexOf(arg); if (j >= 0) { g.inv.splice(j, 1); res.lost.push(arg); } if (g.sel === arg) g.sel = null; }
      else if (op === 'lock') res.ui = { lock: arg };
      else if (op === 'zoom') res.ui = { zoom: arg };
      else if (op === 'view') g.view = arg;
      else if (op === 'sfx') res.sfx = arg;
    });
  }
  function runRules(g, rules, res) {
    if (!rules) return false;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (cond(g, r.if)) { res.say = r.say || ''; doActs(g, r.do, res); res.hit = true; return true; }
    }
    return false;
  }
  function checkExit(g, res) {
    var R = roomOf(g);
    if (!g.done && cond(g, R.exit)) { g.done = true; res.win = true; res.sfx = 'win'; }
  }
  function visible(g, o) { return !!o && cond(g, o.show); }
  // Objects drawn in a view (in hotspot order: big first, so small ones sit on top).
  function objectsIn(g, viewId) {
    var R = roomOf(g), out = [];
    for (var id in R.objects) {
      var o = R.objects[id];
      if (o.view === viewId && visible(g, o)) out.push(id);
    }
    out.sort(function (a, b) { var A = R.objects[a].at, B = R.objects[b].at; return B[2] * B[3] - A[2] * A[3]; });
    return out;
  }
  var NOPE = ['Nothing happens.', 'That doesn\'t seem to do anything.', 'No, that won\'t work.', 'That isn\'t going to help.'];
  // Tap an object (optionally with a held item).
  function interact(g, objId, itemId) {
    var R = roomOf(g), o = R.objects[objId], res = newRes();
    if (!o || !visible(g, o) || g.done) return res;
    g.acts++;
    if (itemId) {
      if (g.inv.indexOf(itemId) < 0) return res;
      var rules = o.use && o.use[itemId];
      if (!runRules(g, rules, res)) {
        res.say = 'The ' + R.items[itemId].name.toLowerCase() + ' doesn\'t help with the ' + o.name.toLowerCase() + '. ' + NOPE[g.acts % NOPE.length];
        res.sfx = 'nope';
      }
    } else runRules(g, o.look, res);
    if (res.ui && res.ui.lock && g.flags['open:' + res.ui.lock]) res.ui = null;
    checkExit(g, res);
    return res;
  }
  function combine(g, a, b) {
    var R = roomOf(g), res = newRes();
    if (g.done || a === b || g.inv.indexOf(a) < 0 || g.inv.indexOf(b) < 0) return res;
    g.acts++;
    for (var i = 0; i < R.combos.length; i++) {
      var c = R.combos[i];
      if (((c.a === a && c.b === b) || (c.a === b && c.b === a)) && cond(g, c.if)) {
        res.say = c.say; doActs(g, c.do, res); res.hit = true; res.ok = true;
        g.sel = null;
        checkExit(g, res);
        return res;
      }
    }
    res.say = 'The ' + R.items[a].name.toLowerCase() + ' and the ' + R.items[b].name.toLowerCase() + ' don\'t go together.';
    res.sfx = 'nope';
    return res;
  }
  function examine(g, itemId) {
    var R = roomOf(g), it = R.items[itemId], res = newRes();
    if (!it || g.inv.indexOf(itemId) < 0) return res;
    res.say = it.desc; res.hit = true;
    if (it.zoom) res.ui = { zoom: it.zoom };
    return res;
  }

  // ---------------- locks ----------------
  function wheelOpts(L) {
    if (L.style === 'digit') return DIGITS;
    if (L.style === 'colour') return COLOURS;
    if (L.style === 'letter') return LETTERS;
    if (L.style === 'weather') return WEATHER;
    if (L.style === 'shape') return SHAPES;
    if (L.style === 'word') return L.words;
    return DIGITS;
  }
  function lockPlate(g, L) {
    var p = L.plate;
    (L.plates || []).forEach(function (v) { if (cond(g, v.if)) p = v.text; });
    return p;
  }
  // Wheel positions remembered per lock (the dial stays where you left it).
  function lockVal(g, id) {
    var L = roomOf(g).locks[id];
    if (!L) return null;
    if (L.kind === 'wheels') {
      var o = wheelOpts(L), v = g.lv[id], out = [];
      for (var i = 0; i < L.n; i++) out.push(v && v[i] >= 0 && v[i] < o.length ? v[i] | 0 : 0);
      return out;
    }
    return typeof g.lv[id] === 'string' ? g.lv[id] : '';
  }
  function setWheel(g, id, i, idx) {
    var L = roomOf(g).locks[id], o = wheelOpts(L), v = lockVal(g, id);
    if (i < 0 || i >= v.length) return v;
    v[i] = ((idx % o.length) + o.length) % o.length;
    g.lv[id] = v;
    return v;
  }
  // value: wheel indices (wheels), digits (keypad) or 'UDLR' moves (dir).
  function tryLock(g, id, value) {
    var R = roomOf(g), L = R.locks[id], res = newRes();
    if (!L || g.done) return res;
    if (g.flags['open:' + id]) { res.ok = true; return res; }
    var ok;
    if (L.kind === 'wheels') {
      var o = wheelOpts(L);
      ok = Array.isArray(value) && value.length === L.n && L.answer.every(function (a, i) { return o[value[i]] === a; });
      g.lv[id] = Array.isArray(value) ? value.slice() : g.lv[id];
    } else if (L.kind === 'keypad') ok = String(value) === L.answer;
    else ok = String(value).toUpperCase() === L.answer;
    g.acts++;
    if (!ok) {
      g.tries++;
      res.say = L.wrong || (L.kind === 'keypad' ? 'Bzzt. Wrong code.' : L.kind === 'dir' ? 'You yank the shackle. It doesn\'t budge.' : 'You tug at it. Still locked.');
      res.sfx = 'wrong';
      return res;
    }
    g.flags['open:' + id] = true;
    res.ok = true; res.hit = true;
    res.say = L.open.say; res.sfx = 'unlock';
    doActs(g, L.open.do, res);
    if (!res.sfx || res.sfx === 'find') res.sfx = 'unlock';
    checkExit(g, res);
    return res;
  }

  // ---------------- art ----------------
  function padLine(s) {
    s = String(s || '');
    var a = Array.from ? Array.from(s) : s.split('');
    while (a.length < COLS) a.push(' ');
    return a.slice(0, COLS);
  }
  // The view's glyph grid with state patches, plus a colour code per cell.
  function renderView(g, viewId) {
    var R = roomOf(g), V = R.views[viewIndex(R, viewId)], ch = [], col = [], y, x;
    if (!V) return null;
    for (y = 0; y < ROWS; y++) { ch.push(padLine(V.art[y])); col.push(new Array(COLS).fill('m')); }
    function paint(r) {
      for (y = r[1]; y < r[1] + r[3] && y < ROWS; y++) for (x = r[0]; x < r[0] + r[2] && x < COLS; x++) col[y][x] = r[4];
    }
    (V.paint || []).forEach(paint);
    (V.patches || []).forEach(function (p) {
      if (!cond(g, p.if)) return;
      p.l.forEach(function (line, dy) {
        var a = Array.from ? Array.from(line) : line.split('');
        for (var dx = 0; dx < a.length; dx++) {
          var yy = p.y + dy, xx = p.x + dx;
          if (yy < 0 || yy >= ROWS || xx < 0 || xx >= COLS || a[dx] === '$') continue;
          ch[yy][xx] = a[dx];
          if (p.c) col[yy][xx] = p.c;
        }
      });
    });
    return { ch: ch, col: col };
  }

  // ---------------- hints & progress ----------------
  function puzzlesOpen(g) {
    var R = roomOf(g);
    return R.puzzles.filter(function (p) { return cond(g, p.avail) && !cond(g, p.done); });
  }
  function progress(g) {
    var R = roomOf(g), n = 0;
    R.puzzles.forEach(function (p) { if (cond(g, p.done)) n++; });
    return { done: n, total: R.puzzles.length };
  }
  function hintsUsed(g) { var n = 0; for (var k in g.hints) n += g.hints[k]; return n; }
  // Reveal the next hint for a puzzle (+30 s). Returns the text or null.
  function takeHint(g, pid) {
    var R = roomOf(g), p = null;
    for (var i = 0; i < R.puzzles.length; i++) if (R.puzzles[i].id === pid) p = R.puzzles[i];
    if (!p || g.done) return null;
    var lv = g.hints[pid] || 0;
    if (lv >= p.hints.length) return null;
    g.hints[pid] = lv + 1;
    g.pen += HINT_PEN;
    return p.hints[lv];
  }
  function tick(g, dt) { if (!g.done && dt > 0 && dt < 5) g.t = Math.min(MAX_T, g.t + dt); }
  function finalTime(g) { return Math.round(g.t + g.pen); }
  function stars(g) {
    var R = roomOf(g), h = hintsUsed(g), t = finalTime(g);
    if (h === 0 && t <= R.par) return 3;
    if (h <= 3 && t <= R.par * 2) return 2;
    return 1;
  }

  // ---------------- save ----------------
  function newSave() { return { v: 1, games: {}, best: {}, seen: false }; }
  function normGame(o, roomId) {
    var R = ROOM[roomId];
    if (!R || !o || typeof o !== 'object') return null;
    var g = newGame(roomId);
    if (viewIndex(R, o.view) >= 0) g.view = o.view;
    if (Array.isArray(o.inv)) o.inv.forEach(function (id) { if (R.items[id] && g.inv.indexOf(id) < 0) g.inv.push(id); });
    if (o.flags && typeof o.flags === 'object') for (var k in o.flags) if (o.flags[k] === true && /^[\w:]{1,40}$/.test(k)) g.flags[k] = true;
    if (o.hints && typeof o.hints === 'object') R.puzzles.forEach(function (p) {
      var n = o.hints[p.id] | 0;
      if (n > 0) g.hints[p.id] = Math.min(p.hints.length, n);
    });
    if (o.lv && typeof o.lv === 'object') for (var id in R.locks) {
      var L = R.locks[id], v = o.lv[id];
      if (L.kind === 'wheels' && Array.isArray(v) && v.length === L.n) {
        var n2 = wheelOpts(L).length;
        g.lv[id] = v.map(function (x) { x = x | 0; return x >= 0 && x < n2 ? x : 0; });
      } else if (L.kind !== 'wheels' && typeof v === 'string') g.lv[id] = v.replace(L.kind === 'keypad' ? /[^0-9]/g : /[^UDLR]/g, '').slice(0, L.kind === 'keypad' ? L.n : L.n);
    }
    g.t = Math.min(MAX_T, Math.max(0, +o.t || 0));
    g.pen = Math.min(MAX_T, Math.max(0, +o.pen || 0));
    g.acts = Math.max(0, o.acts | 0); g.tries = Math.max(0, o.tries | 0);
    g.done = o.done === true;
    if (typeof o.sel === 'string' && g.inv.indexOf(o.sel) >= 0) g.sel = o.sel;
    return g;
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.seen = o.seen === true;
    ROOMS.forEach(function (R) {
      var g = o.games && normGame(o.games[R.id], R.id);
      if (g && !g.done) s.games[R.id] = g;
      var b = o.best && o.best[R.id];
      if (b && typeof b === 'object' && +b.t > 0) {
        s.best[R.id] = { t: Math.min(MAX_T, Math.round(+b.t)), hints: Math.max(0, b.hints | 0), stars: Math.min(3, Math.max(1, b.stars | 0)), n: Math.max(1, b.n | 0) };
      }
    });
    return s;
  }
  // A finished room → records. Returns { best, isNew }.
  function record(save, g) {
    var t = finalTime(g), h = hintsUsed(g), b = save.best[g.room], st = stars(g);
    var isNew = !b || t < b.t;
    var nb = { t: isNew ? t : b.t, hints: isNew ? h : b.hints, stars: Math.max(st, b ? b.stars : 0), n: (b ? b.n : 0) + 1 };
    save.best[g.room] = nb;
    delete save.games[g.room];
    return { best: nb, isNew: isNew, t: t, hints: h, stars: st };
  }

  var ENGINE = {
    COLS: COLS, ROWS: ROWS, HINT_PEN: HINT_PEN, ROOMS: ROOMS, ROOM: ROOM, COLOURS: COLOURS, CLR: CLR, WEATHER: WEATHER, SHAPES: SHAPES,
    GLYPH: GLYPH, SHAPE_GLYPH: SHAPE_GLYPH, LETTERS: LETTERS, DIGITS: DIGITS,
    cond: cond, toks: toks, newGame: newGame, interact: interact, combine: combine, examine: examine, objectsIn: objectsIn,
    wheelOpts: wheelOpts, lockPlate: lockPlate, lockVal: lockVal, setWheel: setWheel, tryLock: tryLock,
    renderView: renderView, viewIndex: viewIndex, puzzlesOpen: puzzlesOpen, progress: progress, hintsUsed: hintsUsed, takeHint: takeHint,
    tick: tick, finalTime: finalTime, stars: stars, newSave: newSave, normSave: normSave, normGame: normGame, record: record
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('escaperoom.css');

  var PANEL_ID = 'escaperoom-panel', NAME = 'Escape Room';
  var KEY = 'cade-escaperoom-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound', HOT_KEY = KEY + 'hot';
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.escaperoom = { live: function () { return S; }, draw: function () { drawScene(); drawInv(); } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return normSave(o);
  }
  function persist() {
    if (!S) return;
    if (S.g && !S.g.done) S.save.games[S.g.room] = S.g;
    sset(SAVE_KEY, JSON.stringify(S.save));
    S.dirtyT = 0;
  }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtT(t) {
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function starStr(n) { var s = ''; for (var i = 0; i < 3; i++) s += i < n ? '★' : '☆'; return s; }
  function coarse() { return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches); }
  function txt(s) { return esc(s).replace(/([☼☾★♣♥○△□◇☆])/g, '$1︎'); }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  function sfx(name) {
    if (!S || !S.snd.on) return;
    var s = S.snd;
    s.ensure();
    if (name === 'tap') s.tone(660, 0.04, 'triangle', 0.025);
    else if (name === 'click') { s.tone(1400, 0.025, 'square', 0.02); s.tone(900, 0.03, 'square', 0.015, 0, 0.03); }
    else if (name === 'turn') s.tone(320, 0.08, 'triangle', 0.03, 260);
    else if (name === 'wheel') s.tone(1800, 0.018, 'square', 0.012);
    else if (name === 'key') s.tone(1100, 0.05, 'square', 0.02);
    else if (name === 'find') { s.tone(660, 0.08, 'triangle', 0.04); s.tone(880, 0.08, 'triangle', 0.04, 0, 0.07); s.tone(1320, 0.14, 'triangle', 0.035, 0, 0.14); }
    else if (name === 'nope') s.tone(220, 0.12, 'triangle', 0.04, 180);
    else if (name === 'wrong') { s.tone(140, 0.18, 'sawtooth', 0.035); s.tone(110, 0.2, 'sawtooth', 0.03, 0, 0.12); }
    else if (name === 'unlock') { s.tone(1200, 0.03, 'square', 0.03); s.tone(800, 0.04, 'square', 0.03, 0, 0.05); s.tone(1046, 0.18, 'sine', 0.05, 0, 0.12); s.tone(1568, 0.25, 'sine', 0.04, 0, 0.2); }
    else if (name === 'chime') { [784, 659, 523, 392].forEach(function (f, i) { s.tone(f, 0.6, 'sine', 0.05, 0, i * 0.35); }); }
    else if (name === 'water') s.tone(500, 0.35, 'sine', 0.03, 1400);
    else if (name === 'hint') s.tone(990, 0.12, 'sine', 0.03, 1320);
    else if (name === 'win') { [523, 659, 784, 1046, 784, 1046].forEach(function (f, i) { s.tone(f, i === 5 ? 0.5 : 0.16, 'triangle', 0.05, 0, i * 0.13); }); }
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_SPOT = svg('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="1.5"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');

  // ---- art: the glyph grid as coloured runs; non-ASCII glyphs sit in a 1ch box so the grid never drifts ----
  function artHtml(ch, col) {
    var out = '';
    for (var y = 0; y < ch.length; y++) {
      var run = '', rc = null, row = ch[y];
      for (var x = 0; x < row.length; x++) {
        var c = col ? col[y][x] : 'm', g = row[x];
        if (c !== rc) { if (rc !== null) out += '<span class="c-' + rc + '">' + run + '</span>'; run = ''; rc = c; }
        run += g.charCodeAt(0) > 126 ? '<i class="w">' + esc(g) + '︎</i>' : esc(g);
      }
      out += '<span class="c-' + rc + '">' + run + '</span>' + (y < ch.length - 1 ? '\n' : '');
    }
    return out;
  }
  function plainArt(lines) {
    return lines.map(function (l) { return Array.from(l).map(function (g) { return g.charCodeAt(0) > 126 ? '<i class="w">' + esc(g) + '︎</i>' : esc(g); }).join(''); }).join('\n');
  }

  // ---- layout: fit the 46 x 16 grid to the panel's width ----
  // width of one glyph per px of font size, measured in the art's own font (no caching:
  // the stylesheet and the web font may arrive after the panel opens)
  function measure() {
    var sp = document.createElement('span'), cs = window.getComputedStyle ? getComputedStyle(S.art) : null;
    sp.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre;font-size:100px;line-height:1;letter-spacing:0;' +
      'font-weight:' + (cs ? cs.fontWeight : '600') + ';font-family:' + (cs ? cs.fontFamily : 'monospace');
    sp.textContent = new Array(47).join('M');
    S.root.appendChild(sp);
    var w = sp.getBoundingClientRect().width;
    sp.remove();
    var r = w > 0 ? w / 46 / 100 : 0.6;
    return r > 0.3 && r < 1 ? r : 0.6;
  }
  function layout() {
    if (!S) return;
    var W = S.root.clientWidth || 600;
    var vh = window.innerHeight || 700, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var r = measure();
    var fs = W / (COLS * r);
    // keep room under the stage for the nav, message and inventory on short screens
    var maxH = Math.max(150, vh - (coarse() ? 330 : 300));
    fs = Math.min(fs, maxH / (ROWS * 1.18), 19);
    fs = Math.max(6.5, Math.floor(fs * 4) / 4);
    var lh = Math.round(fs * 1.18 * 4) / 4, cw = fs * r;
    S.fs = fs; S.lh = lh; S.cw = cw;
    S.art.style.fontSize = fs + 'px';
    S.art.style.lineHeight = lh + 'px';
    S.stage.style.width = Math.ceil(cw * COLS) + 'px';
    S.stage.style.height = Math.ceil(lh * ROWS) + 'px';
    placeHots();
  }

  // ---- scene ----
  function R() { return ROOM[S.g.room]; }
  function drawScene() {
    if (!S || !S.g) return;
    var g = S.g, V = R().views[viewIndex(R(), g.view)];
    var r = renderView(g, g.view);
    S.art.innerHTML = artHtml(r.ch, r.col);
    // hotspots
    var ids = objectsIn(g, g.view), h = '';
    ids.forEach(function (id) {
      var o = R().objects[id];
      h += '<button type="button" class="er-hot" data-o="' + id + '" aria-label="' + esc(o.name) + '"><span class="er-tag">' + esc(o.name) + '</span></button>';
    });
    S.hots.innerHTML = h;
    placeHots();
    // nav
    var vi = viewIndex(R(), g.view), dots = '';
    R().views.forEach(function (v, i) { dots += '<i class="' + (i === vi ? 'on' : '') + '"></i>'; });
    S.vname.innerHTML = '<b>' + esc(V.name) + '</b><span class="er-dots">' + dots + '</span>';
    S.where.innerHTML = '<span class="er-long">' + esc(R().name) + '</span><span class="er-short">' + esc(R().short) + '</span>';
    syncTime();
  }
  function placeHots() {
    if (!S || !S.g || !S.cw) return;
    var min = coarse() ? 38 : 26, cw = S.cw, lh = S.lh, R0 = R();
    Array.prototype.forEach.call(S.hots.children, function (b) {
      var a = R0.objects[b.getAttribute('data-o')].at;
      var x = a[0] * cw, y = a[1] * lh, w = a[2] * cw, hh = a[3] * lh;
      if (w < min) { x -= (min - w) / 2; w = min; }
      if (hh < min) { y -= (min - hh) / 2; hh = min; }
      b.style.left = Math.round(x) + 'px'; b.style.top = Math.round(y) + 'px';
      b.style.width = Math.round(w) + 'px'; b.style.height = Math.round(hh) + 'px';
      b.classList.toggle('low', a[1] < 2);
    });
  }
  function say(t, kind) {
    if (!S) return;
    S.msg.innerHTML = t ? '<span class="er-q">»</span> ' + txt(t) : '';
    S.msg.className = 'er-msg' + (kind ? ' ' + kind : '');
    void S.msg.offsetWidth;
    S.msg.classList.add('in');
    if (t && S.live) S.live.textContent = t;
  }
  function drawInv() {
    var g = S.g, h = '';
    if (!g.inv.length) h = '<div class="er-empty">Your pockets are empty.</div>';
    g.inv.forEach(function (id, i) {
      var it = R().items[id];
      h += '<button type="button" class="er-item' + (g.sel === id ? ' on' : '') + (S.newItems[id] ? ' new' : '') + '" data-i="' + id + '" title="' + esc(it.name) + (coarse() ? '' : ' (' + (i + 1) + ')') + '">' +
        '<span class="er-ig">' + esc(it.glyph) + '</span><span class="er-in">' + esc(it.name) + '</span></button>';
    });
    S.inv.innerHTML = h;
    S.newItems = {};
    var it2 = g.sel && R().items[g.sel];
    S.selBar.innerHTML = it2 ? '<span>Using <b>' + esc(it2.name) + '</b> — tap something to use it on, or another item to combine.</span>' +
      '<button type="button" class="er-lnk" data-a="exam">look</button><button type="button" class="er-lnk" data-a="desel">put away</button>' :
      '<span>' + (g.inv.length ? 'Tap an item to pick it up and use it.' : 'Tap anything that looks interesting.') + '</span>';
    S.selBar.classList.toggle('on', !!it2);
    S.root.classList.toggle('holding', !!it2);
  }
  function syncTime() {
    if (!S || !S.g) return;
    var pr = progress(S.g), pen = S.g.pen;
    S.time.innerHTML = '<b>' + fmtT(S.g.t) + '</b>' + (pen ? '<i>+' + fmtT(pen) + '</i>' : '');
    S.prog.textContent = pr.done + '/' + pr.total;
  }
  function fx(kind, el) {
    if (!S || S.rm) return;
    var box = S.fxEl, r0 = box.getBoundingClientRect(), x = r0.width / 2, y = r0.height / 2;
    if (el && el.getBoundingClientRect) { var r = el.getBoundingClientRect(); x = r.left - r0.left + r.width / 2; y = r.top - r0.top + r.height / 2; }
    var glyphs = kind === 'win' ? '*+o.★*#@' : kind === 'unlock' ? '*+.' : '.+';
    var n = kind === 'win' ? 36 : kind === 'unlock' ? 14 : 6;
    for (var i = 0; i < n; i++) {
      var s = document.createElement('i'), a = Math.random() * Math.PI * 2, d = (kind === 'win' ? 60 : 25) + Math.random() * (kind === 'win' ? 140 : 50);
      s.textContent = glyphs[i % glyphs.length];
      s.style.left = x + 'px'; s.style.top = y + 'px';
      s.style.setProperty('--dx', Math.round(Math.cos(a) * d) + 'px');
      s.style.setProperty('--dy', Math.round(Math.sin(a) * d) + 'px');
      s.style.animationDelay = Math.round(Math.random() * 120) + 'ms';
      if (i % 3 === 0) s.className = 'a';
      box.appendChild(s);
      (function (sp) { setTimeout(function () { sp.remove(); }, 1100); })(s);
    }
  }
  function flashHot(id) {
    var b = S.hots.querySelector('[data-o="' + id + '"]');
    if (!b) return;
    b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
    return b;
  }

  // apply an engine result: message, sound, inventory, cards, the win
  function apply(res, srcEl) {
    if (!res) return;
    res.got.forEach(function (id) { S.newItems[id] = 1; });
    if (res.say) say(res.say, res.sfx === 'nope' || res.sfx === 'wrong' ? 'bad' : res.got.length ? 'good' : '');
    var snd = res.sfx || (res.got.length ? 'find' : res.hit ? 'tap' : 'nope');
    if (!res.win) sfx(snd);
    if (res.got.length && Cade.haptic) Cade.haptic(10);
    if (res.got.length || res.sfx === 'unlock' || res.sfx === 'chime') fx(res.sfx === 'unlock' || res.sfx === 'chime' ? 'unlock' : 'find', srcEl);
    drawScene(); drawInv();
    S.dirty = true;
    if (res.win) { win(); return; }
    if (res.ui && res.ui.lock) openLock(res.ui.lock);
    else if (res.ui && res.ui.zoom) showZoom(res.ui.zoom);
    persist();
  }
  function tapObject(id, el) {
    if (!S || !S.g || S.card) return;
    S.snd.ensure();
    var g = S.g, item = g.sel;
    var res = interact(g, id, item);
    if (item) { g.sel = null; }
    flashHot(id);
    apply(res, el);
  }
  function tapItem(id, el) {
    var g = S.g;
    S.snd.ensure();
    if (!g.sel) { g.sel = id; sfx('tap'); drawInv(); say('You take out the ' + R().items[id].name.toLowerCase() + '.'); return; }
    if (g.sel === id) { g.sel = null; apply(examine(g, id), el); return; }
    var res = combine(g, g.sel, id);
    if (!res.ok) g.sel = null;
    apply(res, el);
  }
  function turn(d) {
    if (!S || !S.g || S.card) return;
    var Rr = R(), i = viewIndex(Rr, S.g.view), n = Rr.views.length;
    S.g.view = Rr.views[(i + d + n) % n].id;
    sfx('turn');
    S.art.classList.remove('slide-l', 'slide-r'); void S.art.offsetWidth;
    S.art.classList.add(d > 0 ? 'slide-l' : 'slide-r');
    drawScene();
    say('');
    S.dirty = true;
  }

  // ---- cards (overlays over the whole game) ----
  function showCard(kind, html) {
    S.card = kind;
    S.ovl.innerHTML = html || '';
    S.ovl.style.display = kind ? '' : 'none';
    S.root.classList.toggle('dim', !!kind);
    S.root.classList.toggle('hidden-art', kind === 'pause');
    S.ovl.scrollTop = 0;
    syncHead();
    if (kind && !coarse()) {
      var f = S.ovl.querySelector('[data-focus]') || S.ovl.querySelector('button');
      if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    }
  }
  function closeCard() {
    if (S.card === 'lock' && flushLock()) return;
    var k = S.card;
    showCard(null);
    S.lock = null;
    if (k === 'lock' || k === 'zoom' || k === 'hints') drawScene();
  }
  function homeHtml() {
    var h = '<div class="er-card er-home"><div class="er-title">ESCAPE ROOM</div>' +
      '<pre class="er-logo">' + plainArt(['   .--------.', '   |  ____  |    o-==', '   | |    | |', "   | |  o | |", '   |_|____|_|']) + '</pre>' +
      '<p class="er-sub">Three locked rooms. Every answer is in the room.</p><div class="er-rooms">';
    ROOMS.forEach(function (Rr, i) {
      var g = S.save.games[Rr.id], b = S.save.best[Rr.id], pr = g ? progress(g) : null;
      var status = ['', 'easy', 'medium', 'hard'][Rr.level] + ' · ' + (g ? 'in progress · ' + pr.done + '/' + pr.total + ' · ' + fmtT(g.t + g.pen) : b ? 'escaped' + (b.n > 1 ? ' ' + b.n + '×' : '') : 'not tried yet');
      h += '<div class="er-room"><button type="button" class="er-rbtn" data-room="' + Rr.id + '">' +
        '<span class="er-rn">' + (i + 1) + '</span><span class="er-rt"><b>' + esc(Rr.name) + '</b><small>' + esc(status) +
        (b ? ' · best ' + fmtT(b.t) + ' <span class="er-stars">' + starStr(b.stars) + '</span>' : '') + '</small></span>' +
        '<span class="er-rgo">' + (g ? 'Continue' : b ? 'Replay' : 'Play') + '</span></button>' +
        (g ? (S.resetArm === Rr.id ? '<div class="er-confirm">Start over? Progress and time are lost. <button type="button" class="er-lnk danger" data-restart="' + Rr.id + '">yes, restart</button><button type="button" class="er-lnk" data-a="noreset">keep</button></div>' :
          '<button type="button" class="er-lnk er-rs" data-arm="' + Rr.id + '">restart</button>') : '') +
        '</div>';
    });
    h += '</div><div class="er-foot"><span>Hints cost +30 s · progress saves</span><button type="button" class="er-lnk" data-a="help">how to play</button></div></div>';
    return h;
  }
  function helpHtml() {
    var k = !coarse();
    return '<div class="er-card"><div class="er-title">HOW TO PLAY</div>' +
      '<p>You are locked in. Find the clues, solve the locks and get out.</p>' +
      '<div class="er-keys">' +
      '<span><b>Tap</b> anything in the scene to inspect it' + (k ? ' (hover to see names; <b>Tab</b> + <b>Enter</b> works too)' : '') + '.</span>' +
      '<span><b>‹ ›</b> turn to another wall' + (k ? ' (or <b>←</b> <b>→</b>)' : ' (or swipe)') + '.</span>' +
      '<span><b>Tap an item</b> to hold it, then tap something in the room to use it on — or tap another item to combine them.</span>' +
      '<span>Tap a held item again to <b>look</b> at it closely.</span>' +
      '<span><b>Locks</b>: ' + (k ? 'type digits or letters, <b>↑ ↓</b> to turn a wheel, <b>Enter</b> to try.' : 'tap the wheels and keys.') + '</span>' +
      '<span><b>Hints</b>: three per puzzle, each one adds <b>+30 s</b> to your time.</span>' +
      '<span>Stuck finding things? The <b>dashed-box</b> button outlines everything you can tap.</span>' +
      '</div>' +
      '<p>Your progress and time are saved: leave any time and continue later.</p>' +
      (k ? '<p class="er-note">Keys: 1-9 pick an item · H hints · P pause · Esc back</p>' : '') +
      '<button type="button" class="er-go" data-a="close" data-focus>Got it</button></div>';
  }
  function introHtml() {
    var Rr = R();
    return '<div class="er-card"><div class="er-title">' + esc(Rr.short.toUpperCase()) + '</div><p class="er-sub">' + esc(Rr.name) + ' · ' + ['', 'easy', 'medium', 'hard'][Rr.level] + '</p>' +
      '<p>' + esc(Rr.intro) + '</p><p class="er-note">The clock starts when you do.</p>' +
      '<button type="button" class="er-go" data-a="begin" data-focus>Begin</button></div>';
  }
  function pauseHtml() {
    return '<div class="er-card"><div class="er-title">PAUSED</div><div class="er-big">' + fmtT(S.g.t) + '</div>' +
      '<p class="er-sub">The clock is stopped and the room hidden.</p>' +
      '<div class="er-btns"><button type="button" class="er-go" data-a="resume" data-focus>Resume</button><button type="button" class="er-go alt" data-a="rooms">Rooms</button></div></div>';
  }
  function showZoom(id) {
    var z = R().zooms[id];
    if (!z) return;
    var w = 0;
    z.art.forEach(function (l) { w = Math.max(w, Array.from(l).length); });
    S.zoomW = w;
    showCard('zoom', '<div class="er-card er-zoom"><div class="er-title">' + esc(z.title.toUpperCase()) + '</div>' +
      '<div class="er-paper"><pre class="er-zart">' + plainArt(z.art) + '</pre></div>' + (z.text ? '<p>' + txt(z.text) + '</p>' : '') +
      '<button type="button" class="er-go" data-a="close" data-focus>Close</button></div>');
    fitZoom();
  }
  function fitZoom() {
    var pre = S.ovl.querySelector('.er-zart');
    if (!pre) return;
    var avail = pre.parentNode.clientWidth - 16, r = measure();
    var fs = Math.max(8, Math.min(15, avail / ((S.zoomW + 1) * r)));
    pre.style.fontSize = fs + 'px';
  }
  function hintsHtml() {
    var g = S.g, open = puzzlesOpen(g), h = '<div class="er-card er-hints"><div class="er-title">HINTS</div>';
    if (!open.length) h += '<p>Nothing to hint at just now. Inspect everything on every wall — something will turn up.</p>';
    else h += '<p class="er-sub">Each hint adds <b>+30 s</b>. Used: ' + hintsUsed(g) + '</p>';
    open.forEach(function (p) {
      var lv = g.hints[p.id] || 0;
      h += '<div class="er-hp"><div class="er-hn"><b>' + esc(p.name) + '</b><span>' + ['○○○', '●○○', '●●○', '●●●'][lv] + '</span></div>';
      for (var i = 0; i < lv; i++) h += '<div class="er-ht"><i>' + (i + 1) + '</i> ' + txt(p.hints[i]) + '</div>';
      if (lv < 3) h += '<button type="button" class="er-lnk" data-hint="' + p.id + '">' + (lv === 2 ? 'show the answer' : 'show hint ' + (lv + 1)) + ' (+30 s)</button>';
      h += '</div>';
    });
    return h + '<button type="button" class="er-go" data-a="close" data-focus>Back to the room</button></div>';
  }
  function winHtml(rec) {
    var Rr = R(), next = ROOMS[(ROOMS.indexOf(Rr) + 1) % ROOMS.length];
    return '<div class="er-card"><div class="er-title">ESCAPED</div><p>' + esc(Rr.outro) + '</p>' +
      '<div class="er-big">' + fmtT(rec.t) + '</div><div class="er-stars big">' + starStr(rec.stars) + '</div>' +
      '<p class="er-sub">' + fmtT(S.g.t) + ' in the room' + (rec.hints ? ' + ' + rec.hints + ' hint' + (rec.hints > 1 ? 's' : '') + ' (' + fmtT(S.g.pen) + ')' : ', no hints') + '</p>' +
      (rec.isNew ? '<div class="er-new">NEW BEST TIME!</div>' : '<p class="er-note">Best: ' + fmtT(rec.best.t) + '</p>') +
      '<div class="er-btns"><button type="button" class="er-go" data-room="' + next.id + '" data-focus>' + (S.save.best[next.id] ? 'Replay ' : 'Next: ') + esc(next.short) + '</button>' +
      '<button type="button" class="er-go alt" data-a="rooms">Rooms</button></div></div>';
  }

  // ---- locks ----
  function openLock(id) {
    var L = R().locks[id];
    if (!L) return;
    S.lock = { id: id, focus: 0, entry: L.kind === 'wheels' ? null : '', busy: false };
    S.lock.entry = L.kind === 'wheels' ? lockVal(S.g, id) : '';
    showCard('lock', '<div class="er-card er-lockc"></div>');
    drawLock();
  }
  function faceHtml(L, v) {
    var o = wheelOpts(L)[v];
    if (L.style === 'colour') return '<span class="er-sw sw-' + o + '"></span><small>' + CLR[o] + '</small>';
    if (L.style === 'weather') return '<span class="er-sym">' + GLYPH[o] + '︎</span>';
    if (L.style === 'shape') return '<span class="er-sym">' + SHAPE_GLYPH[o] + '︎</span>';
    return '<span>' + esc(o) + '</span>';
  }
  function drawLock(state) {
    var lk = S.lock, L = R().locks[lk.id], card = S.ovl.querySelector('.er-lockc'), h = '';
    if (!card) return;
    var k = !coarse();
    h += '<div class="er-title">' + esc(L.title.toUpperCase()) + '</div><p class="er-plate">' + txt(lockPlate(S.g, L)) + '</p>';
    if (L.kind === 'wheels') {
      h += '<div class="er-wheels st-' + L.style + '">';
      lk.entry.forEach(function (v, i) {
        h += '<div class="er-wheel' + (i === lk.focus && k ? ' on' : '') + '"><button type="button" class="er-wb" data-w="' + i + '" data-d="-1" aria-label="Wheel ' + (i + 1) + ' up">▲</button>' +
          '<div class="er-face" data-wf="' + i + '">' + faceHtml(L, v) + '</div>' +
          '<button type="button" class="er-wb" data-w="' + i + '" data-d="1" aria-label="Wheel ' + (i + 1) + ' down">▼</button></div>';
      });
      h += '</div><div class="er-btns"><button type="button" class="er-go" data-a="try"' + (k ? ' data-focus' : '') + '>Try it</button><button type="button" class="er-go alt" data-a="close">Close</button></div>';
      if (k) h += '<p class="er-note">Type to set · ← → pick a wheel · ↑ ↓ turn · Enter tries</p>';
    } else if (L.kind === 'keypad') {
      var disp = '';
      for (var i = 0; i < L.n; i++) disp += '<i>' + (lk.entry[i] || '·') + '</i>';
      h += '<div class="er-disp' + (state ? ' ' + state : '') + '">' + (state === 'bad' ? '<i>E</i><i>R</i><i>R</i>' : disp) + '</div><div class="er-pad">';
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].forEach(function (c) {
        h += '<button type="button" class="er-key' + (c === 'C' || c === '⌫' ? ' alt' : '') + '" data-key="' + c + '">' + c + '</button>';
      });
      h += '</div><div class="er-btns"><button type="button" class="er-go alt" data-a="close">Close</button></div>';
      if (k) h += '<p class="er-note">Type the digits · Backspace · Esc closes</p>';
    } else {
      var ar = { U: '↑', D: '↓', L: '←', R: '→' }, seq = lk.entry.split('').map(function (c) { return ar[c]; }).join('');
      h += '<div class="er-disp dir' + (state ? ' ' + state : '') + '">' + (seq || '<span>no moves yet</span>') + '</div>' +
        '<div class="er-cross"><button type="button" class="er-key" data-dir="U" aria-label="Up">↑</button><button type="button" class="er-key" data-dir="L" aria-label="Left">←</button>' +
        '<button type="button" class="er-key" data-dir="R" aria-label="Right">→</button><button type="button" class="er-key" data-dir="D" aria-label="Down">↓</button></div>' +
        '<div class="er-btns"><button type="button" class="er-go" data-a="try">Pull the shackle</button><button type="button" class="er-go alt" data-a="clear">Clear</button><button type="button" class="er-go alt" data-a="close">Close</button></div>';
      if (k) h += '<p class="er-note">Arrow keys push · Enter pulls · Backspace clears</p>';
    }
    card.innerHTML = h;
  }
  function lockSubmit() {
    var lk = S.lock;
    if (!lk || lk.busy) return;
    var L = R().locks[lk.id], card = S.ovl.querySelector('.er-lockc');
    var res = tryLock(S.g, lk.id, lk.entry);
    if (!res.ok) {
      sfx('wrong');
      if (Cade.haptic) Cade.haptic(30);
      say(res.say, 'bad');
      if (L.kind === 'dir') lk.entry = '';
      if (L.kind === 'keypad') { lk.busy = true; drawLock('bad'); setTimeout(function () { if (S && S.lock === lk) { lk.busy = false; lk.entry = ''; drawLock(); } }, 650); }
      else drawLock();
      card = S.ovl.querySelector('.er-lockc');
      if (card) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
      S.dirty = true;
      return;
    }
    lk.busy = true; lk.res = res;
    if (L.kind === 'keypad') drawLock('good');
    if (card) card.classList.add('opened');
    sfx('unlock');
    fx('unlock', card);
    setTimeout(function () { if (S && S.lock === lk) flushLock(); }, 650);
  }
  // The engine has already opened the lock; show its result now (the unlock animation was
  // cut short by a pause, Rooms, Esc or closing the panel) so nothing found — or the escape — is lost.
  function flushLock() {
    var lk = S && S.lock;
    if (!lk || !lk.res) return false;
    var res = lk.res;
    lk.res = null; S.lock = null;
    if (S.card === 'lock') showCard(null);
    apply(res);
    return true;
  }
  function lockWheel(i, d) {
    var lk = S.lock;
    if (!lk || lk.busy) return;
    lk.focus = i;
    lk.entry = setWheel(S.g, lk.id, i, lk.entry[i] + d);
    sfx('wheel');
    drawLock();
    var f = S.ovl.querySelector('[data-wf="' + i + '"]');
    if (f) { f.classList.add(d > 0 ? 'roll-d' : 'roll-u'); }
    S.dirty = true;
  }
  function lockKey(c) {
    var lk = S.lock;
    if (!lk || lk.busy) return;
    var L = R().locks[lk.id];
    sfx('key');
    if (L.kind === 'keypad') {
      if (c === 'C') lk.entry = '';
      else if (c === '⌫') lk.entry = lk.entry.slice(0, -1);
      else if (lk.entry.length < L.n) lk.entry += c;
      drawLock();
      if (lk.entry.length === L.n) { lk.busy = true; setTimeout(function () { if (S && S.lock === lk) { lk.busy = false; lockSubmit(); } }, 180); }
    } else if (L.kind === 'dir') {
      if (lk.entry.length < L.n) lk.entry += c;
      drawLock();
    }
  }

  // ---- flow ----
  function toHome() {
    flushLock();
    if (S.g) persist();
    S.phase = 'home'; S.g = null; S.paused = false; S.lock = null; S.resetArm = null;
    S.root.classList.add('at-home');
    // a backdrop: the first room's door, still
    var bg = newGame('study'); bg.view = 'door';
    var r = renderView(bg, 'door');
    S.art.innerHTML = artHtml(r.ch, r.col);
    S.hots.innerHTML = ''; S.inv.innerHTML = ''; S.selBar.innerHTML = ''; S.msg.innerHTML = '';
    S.where.textContent = NAME; S.time.innerHTML = ''; S.prog.textContent = ''; S.vname.innerHTML = '';
    showCard('home', homeHtml());
  }
  function startRoom(id, fresh) {
    if (S.g) persist();
    var g = !fresh && S.save.games[id];
    var isNew = !g;
    if (!g) { g = newGame(id); S.save.games[id] = g; }
    S.g = g; S.phase = 'play'; S.paused = false; S.newItems = {};
    S.root.classList.remove('at-home');
    drawScene(); drawInv();
    say(isNew ? '' : 'Welcome back. ' + progress(g).done + ' of ' + progress(g).total + ' puzzles solved.');
    S.last = 0;
    if (isNew) showCard('intro', introHtml()); else showCard(null);
    persist();
  }
  function win() {
    var rec = record(S.save, S.g);
    sset(SAVE_KEY, JSON.stringify(S.save));
    sfx('win');
    if (Cade.haptic) Cade.haptic(40);
    setTimeout(function () { if (S && S.g) fx('win'); }, 200);
    S.phase = 'won';
    syncTime();
    setTimeout(function () { if (S && S.phase === 'won') showCard('win', winHtml(rec)); }, 700);
  }
  function pause() {
    if (S) flushLock();
    if (!S || S.phase !== 'play' || S.paused || S.card === 'intro' || S.card === 'win') return;
    S.paused = true; S.lock = null;
    showCard('pause', pauseHtml());
    persist();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false; S.last = 0;
    showCard(null);
    drawScene();
  }
  function running() {
    return !!S && S.phase === 'play' && !S.paused && S.card !== 'intro' && S.card !== 'win' && !document.hidden &&
      !(Cade.isMinimized && Cade.isMinimized(S.panel)) && S.panel.isConnected;
  }
  function onTick() {
    if (!S) return;
    var now = (window.performance && performance.now()) || Date.now();
    if (running()) {
      if (S.last) { tick(S.g, (now - S.last) / 1000); syncTime(); }
      S.last = now;
      if (S.dirty || ++S.saveN > 20) { S.saveN = 0; S.dirty = false; persist(); }
    } else S.last = 0;
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'play' || S.card === 'intro';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }

  // ---- input ----
  function keyFor(e) { return e.key || ''; }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target, inPanel = t && S.panel.contains(t);
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !inPanel) return;
    if (!inPanel && !S.engaged) return;                            // the user is typing elsewhere
    if (!inPanel && t && t.isContentEditable) return;               // the note editor has focus
    var k = keyFor(e), card = S.card;
    if (k === 'Escape') {
      e.preventDefault();
      if (card === 'lock' || card === 'zoom' || card === 'hints' || card === 'help') { if (card === 'help' && S.phase === 'home') showCard('home', homeHtml()); else closeCard(); }
      else if (card === 'pause') resume();
      else if (S.phase === 'play' && S.g.sel) { S.g.sel = null; drawInv(); }
      else if (S.phase === 'play' && !card) pause();
      return;
    }
    if (card === 'lock' && S.lock) {
      var L = R().locks[S.lock.id], lk = S.lock;
      if (L.kind === 'wheels') {
        var opts = wheelOpts(L);
        if (k === 'ArrowLeft') { e.preventDefault(); lk.focus = (lk.focus + L.n - 1) % L.n; drawLock(); return; }
        if (k === 'ArrowRight' || k === 'Tab' && false) { e.preventDefault(); lk.focus = (lk.focus + 1) % L.n; drawLock(); return; }
        if (k === 'ArrowUp') { e.preventDefault(); lockWheel(lk.focus, -1); return; }
        if (k === 'ArrowDown') { e.preventDefault(); lockWheel(lk.focus, 1); return; }
        if (k === 'Enter') { if (t && t.tagName === 'BUTTON' && S.ovl.contains(t) && t.getAttribute('data-a') !== 'try') return; e.preventDefault(); lockSubmit(); return; }
        if (k.length === 1) {
          var up = k.toUpperCase(), idx = -1, cur = lk.entry[lk.focus], n0 = opts.length;
          for (var st = 1; st <= n0 && idx < 0; st++) {                // start after the current face: S, S picks sun then star
            var j = (cur + st) % n0, o = opts[j];
            if (o === up || (L.style !== 'digit' && L.style !== 'letter' && o.charAt(0).toUpperCase() === up) || (L.style === 'colour' && CLR[o] === up)) idx = j;
          }
          var multi = L.style !== 'digit' && L.style !== 'letter' && opts.filter(function (o) { return o.charAt(0).toUpperCase() === up; }).length > 1;
          if (idx >= 0) {
            e.preventDefault();
            lk.entry = setWheel(S.g, lk.id, lk.focus, idx);
            sfx('wheel');
            if (L.n > 1 && !multi) lk.focus = Math.min(L.n - 1, lk.focus + 1);
            drawLock(); S.dirty = true;
          }
        }
        if (k === 'Backspace') { e.preventDefault(); lk.focus = Math.max(0, lk.focus - 1); drawLock(); }
        return;
      }
      if (L.kind === 'keypad') {
        if (/^[0-9]$/.test(k)) { e.preventDefault(); lockKey(k); press('[data-key="' + k + '"]'); }
        else if (k === 'Backspace') { e.preventDefault(); lockKey('⌫'); press('[data-key="⌫"]'); }
        else if (k === 'Delete') { e.preventDefault(); lockKey('C'); }
        return;
      }
      var dm = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R', w: 'U', s: 'D', a: 'L', d: 'R' }[k];
      if (dm) { e.preventDefault(); lockKey(dm); press('[data-dir="' + dm + '"]'); return; }
      if (k === 'Enter') { if (t && t.tagName === 'BUTTON' && S.ovl.contains(t) && t.getAttribute('data-a') !== 'try') return; e.preventDefault(); lockSubmit(); return; }
      if (k === 'Backspace') { e.preventDefault(); lk.entry = ''; drawLock(); }
      return;
    }
    if (card) {
      if ((k === 'Enter' || k === ' ') && !(t && t.tagName === 'BUTTON' && S.ovl.contains(t))) {
        var f = S.ovl.querySelector('[data-focus]');
        if (f) { e.preventDefault(); f.click(); }
      }
      if ((k === 'p' || k === 'P') && card === 'pause') { e.preventDefault(); resume(); }
      return;
    }
    if (S.phase !== 'play') return;
    if (k === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); turn(1); }
    else if (k === 'h' || k === 'H') { e.preventDefault(); showCard('hints', hintsHtml()); }
    else if (k === 'p' || k === 'P') { e.preventDefault(); pause(); }
    else if (/^[1-9]$/.test(k)) {
      var id = S.g.inv[+k - 1];
      if (id) { e.preventDefault(); tapItem(id, S.inv.querySelector('[data-i="' + id + '"]')); }
    }
  }
  function press(sel) {
    var b = S.ovl.querySelector(sel);
    if (!b) return;
    b.classList.add('down');
    setTimeout(function () { b.classList.remove('down'); }, 110);
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    try { flushLock(); } catch (e) {}
    try { persist(); } catch (e) {}
    S = null;
    clearInterval(s.tickT); clearTimeout(s.repT); clearInterval(s.repI);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('pointerdown', s.onDocDown, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.ro) s.ro.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="er">' +
      '<div class="er-top"><span class="er-where"></span><span class="er-prog" title="Puzzles solved"></span><span class="er-time" title="Time (+ hint penalty)"></span>' +
      '<button type="button" class="er-tb er-hs" data-a="hotsw" title="Outline everything you can tap" aria-label="Outline everything you can tap">' + IC_SPOT + '</button>' +
      '<button type="button" class="er-tb" data-a="hints" title="Hints (H)">Hint</button><button type="button" class="er-tb" data-a="rooms" title="All rooms">Rooms</button></div>' +
      '<div class="er-stagewrap"><div class="er-stage"><pre class="er-art" aria-hidden="true" style="margin:0;white-space:pre;font-family:var(--font-mono, ui-monospace, monospace)"></pre><div class="er-hots"></div><div class="er-fx"></div></div></div>' +
      '<div class="er-nav"><button type="button" class="er-turn" data-a="left" aria-label="Turn left">‹</button><div class="er-vname"></div>' +
      '<button type="button" class="er-turn" data-a="right" aria-label="Turn right">›</button></div>' +
      '<div class="er-msg"></div><div class="er-inv"></div><div class="er-selbar"></div>' +
      '<div class="er-ovl" style="display:none"></div><div class="er-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🗝️ Escape Room', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'er-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.er'), stage: p.querySelector('.er-stage'), art: p.querySelector('.er-art'),
      hots: p.querySelector('.er-hots'), fxEl: p.querySelector('.er-fx'), ovl: p.querySelector('.er-ovl'), msg: p.querySelector('.er-msg'),
      inv: p.querySelector('.er-inv'), selBar: p.querySelector('.er-selbar'), vname: p.querySelector('.er-vname'), where: p.querySelector('.er-where'),
      time: p.querySelector('.er-time'), prog: p.querySelector('.er-prog'), live: p.querySelector('.er-live'),
      save: loadSave(), snd: new Snd(sget(SOUND_KEY) === '1'), rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches),
      phase: 'home', g: null, card: null, lock: null, paused: false, engaged: true, last: 0, saveN: 0, dirty: false, newItems: {}, resetArm: null
    };
    S.root.classList.toggle('show-hots', sget(HOT_KEY) === '1');
    p.querySelector('.er-hs').classList.toggle('on', sget(HOT_KEY) === '1');
    p._onClose = teardown;
    layout();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onDocDown = function (e) { if (S) S.engaged = S.panel.contains(e.target); };
    document.addEventListener('pointerdown', S.onDocDown, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { pause(); persist(); } });
    p.addEventListener('cade-panel-restore', function () { requestAnimationFrame(function () { if (S && S.panel === p) layout(); }); });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); fitZoom(); } }, 100);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      var lastW = 0;
      S.ro = new ResizeObserver(function () { if (S && S.root.clientWidth !== lastW) { lastW = S.root.clientWidth; S.onResize(); } });
      S.ro.observe(S.root);
    } catch (e) {}
    S.tickT = setInterval(onTick, 250);

    // header: help / sound / pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); sfx('tap');
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.card === 'help') { if (S.phase === 'home') showCard('home', homeHtml()); else closeCard(); }
        else if (!S.paused && S.card !== 'win') showCard('help', helpHtml());
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout. CSS does most
    // of it; the scene cancels its touches outright (taps are read from pointer events)
    // and the panel swallows gesture / dblclick events.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.stage.addEventListener('touchstart', noTouch, { passive: false });
    S.stage.addEventListener('touchend', noTouch, { passive: false });
    S.stage.addEventListener('touchmove', noTouch, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    p.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('.er-stage, .er-key, .er-wb, .er-item')) e.preventDefault(); });

    // the scene: tap a hotspot, swipe to turn
    var down = null;
    S.stage.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, hot: e.target.closest ? e.target.closest('.er-hot') : null };
      S.snd.ensure();
    });
    S.stage.addEventListener('pointerup', function (e) {
      if (!S || !down || down.id !== e.pointerId) return;
      var dx = e.clientX - down.x, dy = e.clientY - down.y, d = down;
      down = null;
      if (S.phase !== 'play' || S.card) return;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { turn(dx < 0 ? 1 : -1); return; }
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14 && d.hot) tapObject(d.hot.getAttribute('data-o'), d.hot);
    });
    S.stage.addEventListener('pointercancel', function () { down = null; });
    S.stage.addEventListener('click', function (e) {     // keyboard (Enter / Space on a focused hotspot)
      var b = e.target.closest ? e.target.closest('.er-hot') : null;
      if (b && e.detail === 0 && S && S.phase === 'play' && !S.card) tapObject(b.getAttribute('data-o'), b);
    });
    S.hots.addEventListener('focusin', function (e) { var b = e.target.closest && e.target.closest('.er-hot'); if (b) b.classList.add('kf'); });
    S.hots.addEventListener('focusout', function (e) { var b = e.target.closest && e.target.closest('.er-hot'); if (b) b.classList.remove('kf'); });

    // everything else is a button
    S.root.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.classList.contains('er-hot')) return;
      S.snd.ensure();
      var a = b.getAttribute('data-a'), room = b.getAttribute('data-room'), it = b.getAttribute('data-i');
      if (it && S.phase === 'play' && !S.card) { tapItem(it, b); return; }
      if (room) { sfx('click'); startRoom(room, false); return; }
      if (b.hasAttribute('data-arm')) { S.resetArm = b.getAttribute('data-arm'); showCard('home', homeHtml()); return; }
      if (b.hasAttribute('data-restart')) {
        var rid = b.getAttribute('data-restart');
        delete S.save.games[rid]; persist();
        startRoom(rid, true); return;
      }
      if (b.hasAttribute('data-hint')) {
        var tx = takeHint(S.g, b.getAttribute('data-hint'));
        if (tx) { sfx('hint'); syncTime(); persist(); }
        var sc = S.ovl.scrollTop;
        showCard('hints', hintsHtml());
        S.ovl.scrollTop = sc;
        return;
      }
      if (b.hasAttribute('data-w')) { if (e.detail === 0) lockWheel(+b.getAttribute('data-w'), +b.getAttribute('data-d')); return; }
      if (b.hasAttribute('data-key')) { lockKey(b.getAttribute('data-key')); return; }
      if (b.hasAttribute('data-dir')) { lockKey(b.getAttribute('data-dir')); return; }
      if (!a) return;
      if (a === 'left') turn(-1);
      else if (a === 'right') turn(1);
      else if (a === 'hints') { if (S.phase === 'play' && !S.paused && S.card !== 'intro') { sfx('tap'); showCard(S.card === 'hints' ? null : 'hints', S.card === 'hints' ? '' : hintsHtml()); } }
      else if (a === 'rooms') { sfx('tap'); toHome(); }
      else if (a === 'close') { if (S.phase === 'home') showCard('home', homeHtml()); else closeCard(); }
      else if (a === 'help') showCard('help', helpHtml());
      else if (a === 'begin') { sfx('click'); S.last = 0; showCard(null); say(R().intro); }
      else if (a === 'resume') resume();
      else if (a === 'noreset') { S.resetArm = null; showCard('home', homeHtml()); }
      else if (a === 'try') lockSubmit();
      else if (a === 'clear') { if (S.lock) { S.lock.entry = ''; drawLock(); } }
      else if (a === 'exam') { if (S.g.sel) tapItem(S.g.sel, null); }
      else if (a === 'desel') { S.g.sel = null; drawInv(); }
      else if (a === 'hotsw') {
        var on = !S.root.classList.contains('show-hots');
        S.root.classList.toggle('show-hots', on); sset(HOT_KEY, on ? '1' : '0');
        b.classList.toggle('on', on);
      }
    });
    // wheel arrows turn on press and repeat while held (a letter wheel has 26 stops)
    function stopRep() { if (S) { clearTimeout(S.repT); clearInterval(S.repI); S.repT = S.repI = 0; } }
    S.ovl.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-w]') : null;
      if (!b || e.button > 0 || !S) return;
      e.preventDefault();
      S.snd.ensure();
      var w = +b.getAttribute('data-w'), d = +b.getAttribute('data-d');
      stopRep();
      lockWheel(w, d);
      S.repT = setTimeout(function () { S.repI = setInterval(function () { if (S && S.lock) lockWheel(w, d); else stopRep(); }, 95); }, 380);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { S.ovl.addEventListener(t, stopRep); });
    // a tap on the dimmed backdrop (outside a card) closes a zoom / lock / hints card
    S.ovl.addEventListener('pointerdown', function (e) {
      if (e.target === S.ovl && (S.card === 'zoom' || S.card === 'lock' || S.card === 'hints')) { e.preventDefault(); closeCard(); }
    });

    syncHead();
    toHome();
    if (!S.save.seen) { S.save.seen = true; persist(); showCard('help', helpHtml()); }
    requestAnimationFrame(function () { if (S && S.panel === p) layout(); });
    [300, 1200].forEach(function (ms) { setTimeout(function () { if (S && S.panel === p && !(Cade.isMinimized && Cade.isMinimized(p))) layout(); }, ms); });   // the stylesheet may land late
    try {
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S && S.panel === p) layout(); });
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Point-and-click escape rooms in ASCII — inspect, combine items, crack dials, keypads and symbol locks; hints, timer and best times',
    icon: '🗝️',
    tags: 'game,puzzle,escape room,adventure,codes,point and click,locks,riddles,logic,ascii',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
