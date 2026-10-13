/* The Comet at Wrenhallow — game data for the Text Adventure widget.
 *
 * Loaded on first open by adventure.js (the engine), which never hard-codes
 * anything about this story: rooms, objects, people, rules, hints, scoring
 * and endings all live here.
 *
 * PROSE MARKUP: [words] is a tappable noun (tapping it fills the input with
 * "examine words"); [shown|noun] when the noun to examine differs from the
 * text shown; [shown>command] is a link that runs a command; *x* is emphasis.
 *
 * RULES: rooms.X.on / objects.X.on / objects.X.rcv map an action name to a
 * string (printed, action handled) or a function (g, c) where g is the engine
 * API and c = { v: action, d: direct object id, i: indirect object id, topic }.
 * `on` hooks fire when the object is the direct object, `rcv` hooks when it is
 * the indirect one ("give thimble to [Pim]"). A hook returns true or a string
 * when it handled the action, anything else to fall through to the default.
 * Everything is deterministic — no randomness — so a scripted walkthrough
 * always ends the same way (see tests/).
 */
window.__cadeAdventureData = (function () {
  'use strict';

  var OUTDOOR = ['lane', 'wallpath', 'tarn', 'drive', 'garden', 'yews', 'folly', 'porch', 'roof'];
  var BEARINGS = { n: 'north', ne: 'north-east', e: 'east', se: 'south-east', s: 'south', sw: 'south-west', w: 'west', nw: 'north-west' };
  var CODE = '2841';
  var SHINY = { thimble: 1, spoon: 1 };
  var WEDGES = { poker: 1, boathook: 1 };

  function has(arr, x) { return arr.indexOf(x) !== -1; }
  function powered(g) { return g.p('sluice', 'open') && g.p('clutch', 'engaged'); }
  function bearingOf(topic) {
    var t = String(topic || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(the |to |towards |toward |at |face |facing )+/, '').replace(/ ?(wards|ward)$/, '');
    var map = { north: 'n', n: 'n', northeast: 'ne', 'north east': 'ne', ne: 'ne', east: 'e', e: 'e', southeast: 'se', 'south east': 'se', se: 'se',
      south: 's', s: 's', southwest: 'sw', 'south west': 'sw', sw: 'sw', west: 'w', w: 'w', northwest: 'nw', 'north west': 'nw', nw: 'nw' };
    if (map[t]) return map[t];
    if (/comet|hesper/.test(t)) return 'ne';
    return '';
  }

  // ---------------------------------------------------------------------------
  // Shared rules
  // ---------------------------------------------------------------------------
  function fillLantern(g) {
    if (!g.here('oilcan')) return 'You’ve nothing to fill it with. Lamp oil would be the thing.';
    if (!g.ensureHeld('oilcan')) return true;
    if (g.p('lantern', 'oil')) return 'The lantern’s reservoir is already full.';
    g.set('lantern', 'oil', true);
    return 'You unscrew the little cap and fill the lantern’s reservoir from the oil can. It smells of paraffin and possibility.';
  }

  function lightLantern(g, c) {
    if (g.p('lantern', 'lit')) return 'The lantern is already lit.';
    if (c.i && c.i !== 'matches') return 'You can’t light the lantern with ' + g.the(c.i) + '.';
    if (!g.here('matches')) return g.p('lantern', 'oil') ? 'You have nothing to light it with.' : 'The lantern has no oil in it — and you have nothing to light it with anyway.';
    if (!g.ensureHeld('matches')) return true;
    if (!g.p('lantern', 'oil')) return 'You strike a match and hold it to the wick, which is as dry as a biscuit and refuses to take any interest. There’s no oil in the lantern.';
    g.set('lantern', 'lit', true);
    g.setFlag('litOnce');
    g.award('light', 5);
    return 'You strike a match, lift the glass, and touch the flame to the wick. It catches, gutters, and settles into a steady golden glow. Shadows leap back to a respectful distance.';
  }

  function oilBolt(g) {
    if (!g.here('oilcan')) return 'You’ve nothing to oil it with.';
    if (!g.ensureHeld('oilcan')) return true;
    if (!g.p('bolt', 'rusty')) return 'The bolt is already gleaming with oil.';
    g.set('bolt', 'rusty', false);
    return 'You dribble lamp oil over the bolt and work it in with your thumb. The rust drinks it up greedily, and the bolt gives the faintest shiver, like something waking.';
  }

  function slideBolt(g) {
    if (!g.p('cellardoor', 'bolted')) return 'The bolt is already drawn back.';
    if (g.p('bolt', 'rusty')) return 'You heave at the bolt until your fingers complain. It doesn’t move a whisker. The rust has it.';
    g.set('cellardoor', 'bolted', false);
    g.award('bolt', 5);
    return 'The oiled bolt slides back with a long, satisfied sigh.';
  }

  function waterFlower(g) {
    if (g.p('moonflower', 'bloomed')) return 'The moonflower has had all the water it wants. It is busy blooming.';
    if (!g.here('wateringcan')) return 'You have nothing to water it with.';
    if (!g.ensureHeld('wateringcan')) return true;
    if (!g.p('wateringcan', 'full')) return 'The watering can is empty. There’s a rain butt in the walled garden.';
    g.set('wateringcan', 'full', false);
    g.set('moonflower', 'bloomed', true);
    g.move('bloom', 'moonflower');
    g.award('moonflower', 3);
    return 'You tip the can, and the dry soil drinks with a long, crackling sigh. For a moment nothing happens. Then a bud trembles... and opens. And another. Then all of them at once, in a slow white applause, until the whole vine is covered in pale trumpets that seem to glow with their own light. The glasshouse fills with a scent like vanilla and rain and new books.';
  }

  function fillCan(g) {
    var r = g.room();
    if (!(r === 'tarn' || r === 'garden')) return 'There’s no water here to fill it from.';
    if (!g.ensureHeld('wateringcan')) return true;
    if (g.p('wateringcan', 'full')) return 'It’s already full to the brim.';
    g.set('wateringcan', 'full', true);
    return r === 'garden'
      ? 'You dip the can into the rain butt. It fills with a deep glug, and comes out heavy and dripping.'
      : 'You crouch at the edge of the tarn and fill the can. Ripples carry the moon away and bring it back.';
  }

  function openSluice(g) {
    if (g.p('sluice', 'open')) return 'The sluice is already open; water is thundering through.';
    g.set('sluice', 'open', true);
    g.timer('sluice', 4);
    g.award('sluice', 3);
    return 'You wind the crank. Chains clank, the counterweight rises, and the wooden gate lifts out of the channel. Water bursts through in a white rush, slaps into the paddles, and the great wheel groans, shudders, and begins to turn.' +
      (g.p('clutch', 'engaged') ? ' Beyond the wall, the gears wake with a grinding roar.' : '') +
      '\n\nBeside the gate, the [counterweight] begins — very slowly — to sink back down on its chain.';
  }

  function wedgeSluice(g, c, w) {
    if (!g.p('sluice', 'open')) return 'The sluice gate is shut, so there’s nothing to wedge. Open it first.';
    if (g.p('sluice', 'wedged')) return 'It’s already wedged open.';
    if (!w) {
      var opts = ['poker', 'boathook'].filter(function (x) { return g.has(x); });
      if (opts.length === 1) { w = opts[0]; g.say('(with ' + g.the(w) + ')'); }
      else { g.askFor(c, 'i', 'What do you want to wedge it with?'); return true; }
    }
    if (w === 'trowel') return 'You try the trowel. It bends at the very idea. Something longer and sturdier.';
    if (!WEDGES[w]) return 'That won’t hold back a counterweight.';
    if (!g.ensureHeld(w)) return true;
    g.move(w, 'sluice');
    g.set('sluice', 'wedged', true);
    g.stopTimer('sluice');
    g.award('wedge', 4);
    return 'You jam ' + g.the(w) + ' into the iron guides just below the rim of the gate. The counterweight, sinking, comes up against it with a *clunk* — and stops. The sluice stays open. The wheel thunders on.';
  }

  function closeSluiceNow(g, loud) {
    g.set('sluice', 'open', false);
    g.set('sluice', 'wedged', false);
    g.stopTimer('sluice');
    var r = g.room();
    if (r === 'wheelpit') return 'With a groan of chain, the counterweight reaches the bottom of its travel and the sluice gate thumps shut. The water dwindles to a trickle; the wheel slows, and stops.';
    if (loud && (r === 'cellar' || r === 'gears' || r === 'vault')) return 'From the wheel pit comes a heavy *thump*, and the rushing of water dies away.';
    if (loud && r === 'dome' && g.p('clutch', 'engaged')) return 'Somewhere far below, a rumble you had hardly noticed fades into silence.';
    return '';
  }

  function pullHatch(g) {
    if (g.p('hatch', 'down')) return 'The hatch is already open, its ladder reaching to the floor.';
    if (!g.here('boathook')) return 'The hatch is far above your head, well out of reach. You’d need something long — with a hook on the end, ideally.';
    if (!g.ensureHeld('boathook')) return true;
    g.set('hatch', 'down', true);
    g.move('ladder', 'gallery');
    g.award('hatch', 4);
    return 'You reach up with the boathook, catch the iron ring, and pull. The hatch swings down with a groan, and a folding wooden ladder unfolds after it, clattering to the floor at your feet. A draught that smells of dust and feathers drifts down from the dark above.';
  }

  function windOwl(g, c) {
    if (g.p('copernicus', 'wound')) return 'Copernicus is ticking happily. Any more winding and he’ll start reciting the whole star catalogue.';
    if (c.i && c.i !== 'windkey') return 'That won’t fit the winding hole.';
    if (!g.here('windkey')) return 'You’d need a winding key. The hole between his shoulders is shaped for a butterfly key.';
    if (!g.ensureHeld('windkey')) return true;
    g.set('copernicus', 'wound', true);
    g.move('domekey', 'gallery');
    g.set('domekey', 'moved', true);
    g.award('owl', 6);
    return 'You fit the butterfly key into the hole between his shoulders and turn it — once, twice, seven times, until it will go no further. For a moment, nothing. Then: *tick... tick... tick-tick-tick.* Copernicus shivers, his glass eyes kindle amber, and his head swivels right round to look at you.\n\n“Who — who — WHO has wound me?” he says, in a voice like a music box with a cold. “Ah. The great-niece. Or nephew. She said one of you would come.” His talons unclench, and the long [iron key] clatters to the floor. “The dome key. I was to keep it until someone clever enough to find my winding key came along. You may ask me anything.”';
  }

  function tradePim(g, c) {
    var d = c.d;
    if (d === 'birdseed') return 'Pim eats a single seed, out of politeness, then looks at you as if to say: *and?*';
    if (!SHINY[d]) return 'Pim looks at ' + g.the(d) + ', then at you, with withering contempt. It doesn’t shine.';
    if (!g.ensureHeld(d)) return true;
    g.move(d, 'nest');
    if (g.p('pim', 'traded')) return 'Pim snatches ' + g.the(d) + ' and stows it in the nest without so much as a thank-you. He’s already paid you once; he is a bird of business, not charity.';
    g.set('pim', 'traded', true);
    g.move('lens', 'attic');
    g.set('lens', 'moved', true);
    g.award('pim', 8);
    return 'Pim’s eyes go perfectly round. He hops closer, tilts his head this way and that, then plucks ' + g.the(d) + ' from your fingers and stows it in the nest with tremendous ceremony. Then — a magpie of his word — he hooks the glass [lens] out of the nest with his beak and flicks it onto the floor at your feet. A fair trade, his expression says. Possibly an excellent one.';
  }

  function assembleEyepiece(g) {
    if (g.p('eyepiece', 'lens')) return 'The lens is already in the eyepiece.';
    if (!g.ensureHeld('lens')) return true;
    g.move('lens', null);
    g.set('eyepiece', 'lens', true);
    g.award('eyepiece', 4);
    return 'You press the lens into the eyepiece’s empty socket. It seats itself with a tiny, perfect *click*, as if it had been waiting all these years for exactly that.';
  }

  function fitEyepiece(g, c) {
    if (c.d !== 'eyepiece') return 'That doesn’t fit the eyepiece holder.';
    if (g.loc('eyepiece') === 'telescope') return 'The eyepiece is already in place.';
    if (!g.ensureHeld('eyepiece')) return true;
    g.move('eyepiece', 'telescope');
    g.award('fit', 3);
    return 'You slide the eyepiece into the holder at the foot of the telescope. It fits with the snugness of a key in its own lock.' +
      (g.p('eyepiece', 'lens') ? '' : ' Though without its lens, it’s really just a short brass tube to look down.');
  }

  function setBearing(g, c) {
    var b = bearingOf(c.topic);
    if (!c.topic) return 'Turn it to which direction? (For example: TURN DIAL TO NORTH-EAST.)';
    if (!b) return 'The dial only knows the eight points of the compass.';
    if (!powered(g)) {
      var why = g.p('sluice', 'open') ? ' From far below you can hear water turning the wheel — but nothing seems to connect it to the dome.'
        : g.p('clutch', 'engaged') ? ' Far below, something is connected and waiting, but nothing is driving it.'
          : ' Somewhere below, the machinery that should be helping is fast asleep.';
      return 'You heave on the dial. It doesn’t move a degree: it’s geared to the dome itself, and the dome won’t turn by muscle alone.' + why;
    }
    if (g.p('bearingdial', 'bearing') === b) return 'The dome already faces ' + BEARINGS[b] + '.';
    g.set('bearingdial', 'bearing', b);
    var t = 'You turn the dial to ' + BEARINGS[b].toUpperCase() + '. With a deep, grinding rumble the whole dome begins to move: ribs slide past overhead, the shutter swings across the sky, and with a final shudder the dome settles, facing ' + BEARINGS[b] + '.';
    if (b === 'ne') { g.award('dome', 5); t += ' The almanac would approve.'; }
    return t;
  }

  function pullShutter(g) {
    if (g.p('shutter', 'open')) return 'The shutter is already open.';
    if (!g.p('ivy', 'cut')) {
      g.setFlag('sawIvy');
      return 'You haul on the lever. Chains rattle up in the dark, and the shutter grinds open a hand’s width — then jams with a jolt. Through the gap you glimpse dark leaves pressed against the track. Something outside — ivy, by the look of it — has the shutter in its grip. You let it settle back.';
    }
    g.set('shutter', 'open', true);
    g.award('shutter', 3);
    return 'You haul on the lever. Chains rattle, and with a long wooden rumble the shutter slides up and over the dome, unrolling a broad stripe of night sky from the rim to the very top. Cold air pours in, smelling of pine and stars.';
  }

  function closeShutter(g) {
    if (!g.p('shutter', 'open')) return 'The shutter is already closed.';
    g.set('shutter', 'open', false);
    return 'You push the lever up. The shutter rumbles closed, and the stars are put away.';
  }

  function focusKnob(g) {
    if (g.loc('eyepiece') !== 'telescope') return 'You turn the focus knob. The empty eyepiece holder slides in and out obligingly. There’s nothing to focus yet.';
    if (g.p('telescope', 'focused')) return 'It’s as sharp as it will get. Any more and you’d be focusing on the far side of the comet.';
    g.set('telescope', 'focused', true);
    return 'You turn the focus knob slowly. The eyepiece slides out a fraction... back a little... *there*. Whatever the telescope is pointed at should now be sharp.';
  }

  var VIEWS = {
    n: 'the Plough, tipped up on its handle, and the Pole Star sitting quietly in the middle of everything',
    e: 'the Pleiades, a tiny shivering knot of blue-white stars',
    se: 'a dim, crowded stretch of the Milky Way',
    s: 'a bright planet, steady and creamy, hanging above the southern hills',
    sw: 'the last of the summer stars sinking towards the hills',
    w: 'the Swan, flying down the Milky Way with its wings spread',
    nw: 'the W of Cassiopeia, like a crown someone dropped'
  };

  function lookThrough(g) {
    if (g.loc('eyepiece') !== 'telescope') return 'You put your eye to the empty holder and see a small brass circle of nothing. The telescope needs its eyepiece.';
    if (!g.p('eyepiece', 'lens')) return 'You look down the eyepiece and see a blur, and your own eyelashes. Without its lens, the eyepiece is just a tube.';
    if (!g.p('shutter', 'open')) return 'You see the inside of the dome shutter, magnified to an astonishing degree: every knot in the wood, every cobweb, every woodworm’s front door. Riveting. The shutter needs to be open.';
    var b = g.p('bearingdial', 'bearing');
    if (b !== 'ne') return 'You see ' + VIEWS[b] + '. Glorious — but there’s no comet. Hesper, the almanac said, hangs low in the north-east.';
    if (!g.p('telescope', 'focused')) return 'Something is there — a pale, swollen smudge with the hint of a tail — but it swims hopelessly out of focus, like a thought you can’t quite have. The [focus knob] might help.';
    if (g.flag('seenScope')) return 'Hesper is still there, pouring its light across the eyepiece. It hasn’t stopped being wonderful.';
    g.setFlag('seenScope');
    g.award('comet', 10);
    return 'You put your eye to the eyepiece — and forget, for a moment, to breathe.\n\nHesper fills the field: a head of soft, impossible light, brighter at its heart, wrapped in a glowing hood, and streaming away behind it a tail — no, *two* tails, one straight and blue-white, one curved and gold, so long they run right out of the eyepiece and on across the dark. Faint stars shine through them as if they were made of breath. It is moving, very slightly: as you watch, it creeps past a star. It has been travelling for eighty-one years to be here tonight, and so, in a way, have you.\n\nAfter a long while you straighten up. On the lectern, the [logbook] lies open, waiting.';
  }

  function writeLog(g, c) {
    if (g.room() !== 'dome') return 'You’ve nothing to write in. (The logbook is up in the dome.)';
    if (!g.flag('seenScope')) return 'You lift the pencil on its string, then pause. A logbook is for observations, and you haven’t observed anything yet — not properly.';
    var t = String(c.topic || '').replace(/^["“‘']+|["”’']+$/g, '').trim();
    if (t.length > 160) t = t.slice(0, 160) + '…';
    g.setFlag('logText', t || '');
    g.award('logbook', 5);
    g.end('best');
    return true;
  }

  // ---------------------------------------------------------------------------
  // Rooms
  // ---------------------------------------------------------------------------
  var rooms = {
    lane: {
      name: 'Lane’s End',
      desc: function (g) {
        return 'The lane gives up here, in a turning circle of moss and gravel, as if it too had cycled the last six miles uphill. To the north, a pair of tall [iron gates] ' +
          (g.isOpen('gates') ? 'stand open on the drive of Wrenhallow' : 'are shut across the drive of Wrenhallow') +
          ', and above the trees beyond them a pale [dome] catches the very last of the light. A lit window glows in the little [gatehouse] to the west, and a footpath runs east along the [garden wall].';
      },
      exits: { n: { to: 'drive', door: 'gates' }, w: 'cottage', in: 'cottage', e: 'wallpath' },
      noGo: { s: 'The lane runs back down the valley, the way you came. Not tonight — not after all those hills.' },
      sc: {
        'gatehouse|cottage|lodge': 'A cottage of grey stone with a slate roof and a crooked chimney puffing woodsmoke. Its window glows orange. The door is to the west.',
        'garden wall|wall|brick': 'A high wall of old brick, furred with ivy, running east from the gates.',
        'moss|gravel|turning circle|lane|road|tracks': 'Moss, gravel, and the tracks of your bicycle tyres. The lane goes back the way you came, which you have no intention of doing.',
        'lit window|window|light': 'A warm orange square in the gatehouse wall. Somebody’s home.',
        'trees|woods': 'Beech and pine, black against a sky the colour of ink.'
      }
    },

    cottage: {
      name: 'Gatehouse Kitchen',
      desc: 'A low, warm room that smells of woodsmoke and toast. A kettle mutters on the [hob], a [dresser] sags under a lifetime of plates, and a fire crackles in the grate beside a [rocking chair]. The door back out to the lane is east.',
      exits: { e: 'lane', out: 'lane' },
      sc: {
        'hob|kettle|stove': 'A black kettle on the hob, muttering to itself, never quite deciding to boil.',
        'dresser|plates|cups|china': 'Blue-and-white plates, cups on hooks, a jar of spills, a stack of seed catalogues, and a cat-shaped teapot with no cat in evidence.',
        'fire|grate|fireplace|flames': 'A small, cheerful fire. You warm your hands at it gratefully; the hills were cold.',
        'rocking chair|chair|rocker': { d: 'A rocking chair with a patchwork cushion, creaking gently.', on: { sit: 'That’s Mrs. Thorne’s chair, and she is in it.', enter: 'That’s Mrs. Thorne’s chair, and she is in it.' } },
        'knitting|scarf|needles|wool': 'Something long and purple, growing steadily from Mrs. Thorne’s needles. It may one day be a scarf. Or a road.'
      }
    },

    wallpath: {
      name: 'Along the Wall',
      desc: 'A narrow footpath squeezes between a bramble [hedge] and the high [garden wall] of Wrenhallow, thick with ivy and with the occasional opinion scratched into the brick by bored children long ago. The path leads west back to the lane and east, downhill, towards a glint of water.',
      exits: { w: 'lane', e: 'tarn' },
      sc: {
        'garden wall|wall|brick|ivy': { d: 'Old brick under a pelt of ivy. Scratched into it at about the height of a ten-year-old are some [carvings].', on: { climb: 'The wall is high and the ivy is thin. You’d come down a great deal faster than you went up.' } },
        'carvings|carving|scratches|initials|writing|opinion|opinions': { d: 'Initials, a lopsided heart, ‘T.B. 1962’, and in big determined capitals: MAGPIES ARE THIEVES.', on: { read: 'Initials, a lopsided heart, ‘T.B. 1962’, and in big determined capitals: MAGPIES ARE THIEVES.' } },
        'bramble hedge|hedge|brambles|blackberries': 'Brambles, armed to the teeth. A few late blackberries, but they’re in the very middle, as blackberries always are.',
        'water|glint': 'Down the slope, something wide and still catches the moonlight.'
      }
    },

    tarn: {
      name: 'Tarn Shore',
      desc: 'A small, still tarn lies black and silver under the rising moon, so calm it seems to hold a second sky. [Reeds] whisper along the shore. A stone [culvert] gulps water from the tarn’s edge and carries it away under the wall towards the house. A wooden [boathouse] squats at the water’s edge to the north; the footpath climbs back west.',
      exits: { w: 'wallpath', n: 'boathouse', in: 'boathouse' },
      on: { swim: 'Not tonight. The water looks cold enough to make your ancestors shiver.' },
      sc: {
        'reeds|rushes|shore': 'Tall reeds, rustling secrets to each other. Something small plops into the water as you look.',
        'stone culvert|culvert|channel|plate': { d: 'Water slides into the culvert with a soft, endless swallow. A rusted iron plate above it reads: WRENHALLOW ENGINE — HEAD RACE.', on: { read: 'WRENHALLOW ENGINE — HEAD RACE.', enter: 'It’s far too narrow, and full of water.' } },
        'wooden boathouse|boathouse|shed': { d: 'A boathouse of tarred planks with a mossy roof, built half over the water.', on: { enter: function (g) { g.go('n'); return true; } } },
        'second sky|reflection': 'Stars float on the water, and in the north-east, a faint smudge that is not a star.'
      }
    },

    boathouse: {
      name: 'Boathouse',
      desc: 'A boathouse of tarred planks, smelling of weed and old rope. An upturned [rowing boat] rests on trestles, its hull patched like a well-loved jumper. Moonlight falls in long thin stripes through the gaps between the boards. The only way out is south.',
      exits: { s: 'tarn', out: 'tarn' },
      sc: {
        'trestles|trestle': 'Two sturdy trestles, holding the boat up off the ground like pallbearers who’ve been told it’s only resting.',
        'old rope|rope|ropes': 'Coils of old rope, stiff with age. Nothing you need.',
        'peg|pegs': 'A wooden peg by the door, for hanging things on.',
        'planks|boards|gaps|stripes': 'Tarred planks with gaps a finger wide. The moon looks in through every one.'
      }
    },

    drive: {
      name: 'Overgrown Drive',
      desc: 'Behind the gates, the drive has given up being a drive and become a sort of polite tunnel through [rhododendrons]. It runs north towards the house, whose great [dome] rises over everything, pale as a sleeping moon. Gaps in the green lead east into a walled garden and west along a dark avenue of [yews]. The [iron gates] are south.',
      exits: { s: { to: 'lane', door: 'gates' }, n: 'porch', e: 'garden', w: 'yews' },
      sc: {
        'rhododendrons|rhododendron|bushes|tunnel|leaves': 'Glossy, gloomy and enormous. In spring they must be spectacular; tonight they just loom.',
        'yews|avenue': 'A double row of old yews, clipped into odd shapes, leading west.'
      }
    },

    garden: {
      name: 'Walled Garden',
      desc: 'Four high walls hold in a garden that has been quietly running wild. Beds of herbs have become forests of herbs; a [sundial] stands up to its knees in thyme, and a [scarecrow] keeps watch over nothing in particular. A [rain butt] squats against the wall by a downpipe. There’s a glasshouse to the north and a potting shed to the east; the drive is back west.',
      exits: { w: 'drive', n: 'glasshouse', e: 'shed' },
      on: { dig: 'You scrape at a bed. A worm looks up, aggrieved. You stop.' },
      sc: {
        'beds|herbs|thyme|mint|sage|forest|forests': 'Thyme, mint, sage and something that might have been parsley once, all grown wild and wonderful. It smells like a roast dinner in here.',
        'walls|wall': 'Old brick, warm from the day, with espaliered pears clinging to it like climbers on a rock face.',
        'glasshouse|greenhouse': 'A long glasshouse, its panes glimmering. Something pale inside catches the moonlight.',
        'potting shed|shed': 'A small wooden shed with a lean to it, as if it’s listening for something.',
        'downpipe|pipe|gutter': 'A cast-iron downpipe, feeding the rain butt.'
      }
    },

    glasshouse: {
      name: 'Glasshouse',
      desc: function (g) {
        return 'Warm air and a wet green smell. The glasshouse is a cathedral of cracked panes, and the plants have been holding services in it without anyone. Tomato vines sprawl, a grapevine has taken over the roof, and in the middle, in a great terracotta pot, grows the [moonflower] — ' +
          (g.p('moonflower', 'bloomed')
            ? 'now open in a slow white explosion of blossom that glows faintly in the moonlight.'
            : 'a twisting vine covered in tightly furled white buds. The soil in its pot is cracked and dry.') +
          ' The door is south.';
      },
      exits: { s: 'garden', out: 'garden' },
      sc: {
        'tomato vines|tomatoes|tomato|vines': 'Tomato plants gone feral, heavy with small red fruit. You eat one. It tastes of August.',
        'grapevine|grapes|vine roof': 'The grapevine has roofed the glasshouse in leaves. Small green grapes hang out of reach.',
        'cracked panes|panes|glass|roof': 'Through the panes and the leaves, stars, blurred and green.',
        'terracotta pot|pot|soil': { d: function (g) { return g.p('moonflower', 'bloomed') ? 'Damp, dark soil. The moonflower is very happy.' : 'A big terracotta pot, its soil cracked and dry as an old biscuit.'; } },
        'bench|benches': 'A slatted potting bench, crowded with seed trays.'
      }
    },

    shed: {
      name: 'Potting Shed',
      desc: 'A cramped, cobwebbed shed with a [workbench] under the window and a [shelf] of things that might be useful one day. Clay pots stand in leaning towers. The door is west.',
      exits: { w: 'garden', out: 'garden' },
      sc: {
        'workbench|bench': 'A scarred wooden workbench, covered in twine, labels and the ghosts of seedlings.',
        'shelf|shelves': 'A long shelf of tins, jars and tools.',
        'clay pots|pots|towers': 'Flowerpots in every size, stacked into towers that wouldn’t pass a building inspection.',
        'cobwebs|cobweb|spider': 'Old cobwebs, mostly abandoned. Mostly.',
        'window': 'A small, dirty window. The moon looks in, unimpressed.',
        'nail|nails': 'A big nail in the wall, for hanging things on.'
      }
    },

    yews: {
      name: 'Yew Walk',
      desc: 'An avenue of ancient [yews], clipped long ago into the shapes of planets and since allowed to grow lumpy and philosophical. One is still recognisably [Saturn|yew saturn], rings and all. The avenue leads west to a small domed folly and east back to the drive.',
      exits: { e: 'drive', w: 'folly' },
      sc: {
        'yews|yew|topiary|planets|shapes': 'Planets in yew: a lumpy Jupiter, a Mars with a bird’s nest in it, and a Saturn whose ring has slipped to a rakish angle.',
        'yew saturn|saturn|ring|rings': 'A yew clipped into Saturn, its ring now drooping like a hat brim. It looks as if it’s about to tell you a long story.',
        'folly': 'A little round summerhouse with a domed roof, glimmering white at the end of the avenue.'
      }
    },

    folly: {
      name: 'The Orrery Folly',
      desc: 'A little round summerhouse with a domed roof and six white columns, open to the night. In the middle, on a stone pedestal, stands a great brass [orrery]: a clockwork model of the sun and planets, every one on its own curving arm. A [plaque] is set into the pedestal. The yew walk is east.',
      exits: { e: 'yews', out: 'yews' },
      sc: {
        'columns|column|pillars': 'Six white columns, a little flaky. Somebody has written ‘O.V. + telescope’ inside a heart on one of them.',
        'pedestal|stone': 'A plinth of pale stone holding up the orrery, with a brass plaque set into it.',
        'moons|moon wires|wires': 'Each planet’s moons ride on fine brass wires. Examine a planet to count its moons.'
      }
    },

    porch: {
      name: 'Front Porch',
      desc: function (g) {
        return 'Stone steps climb to a deep porch between two [urns] of long-dead geraniums. The [front door] of Wrenhallow is ' +
          (g.isOpen('frontdoor') ? 'open, breathing out cold, dusty air.' : 'shut: oak, iron-studded, with a brass [knocker] in the shape of a comet.') +
          ' The drive leads south.';
      },
      exits: { s: 'drive', n: { to: 'hall', door: 'frontdoor' }, in: { to: 'hall', door: 'frontdoor' } },
      sc: {
        'urns|urn|geraniums|geranium': 'Two stone urns of geraniums that died some time ago and have been standing to attention ever since.',
        'stone steps|steps': 'Worn into gentle dips by a century of boots.',
        'doormat|mat': { d: 'A bristly doormat reading WIPE YOUR FEET, AND YOUR TELESCOPE.', on: { lookunder: 'Woodlice, who resent the intrusion. No key. (It was worth a look.)', take: 'You lift the corner of the mat. Woodlice, who resent the intrusion. No key. You put it back.' } },
        'brass knocker|knocker|comet': { d: 'A brass knocker in the shape of a comet, its tail worn bright by visitors’ fingers.', on: { push: 'You knock. The sound goes into the house and doesn’t come back. Nobody is home but the furniture.', pull: 'You knock. The sound goes into the house and doesn’t come back. Nobody is home but the furniture.', knock: 'You knock. The sound goes into the house and doesn’t come back. Nobody is home but the furniture.' } }
      }
    },

    hall: {
      name: 'The Rotunda',
      desc: function (g) {
        var cd = g.p('cellardoor', 'bolted') ? 'fastened with a heavy iron [bolt].' : g.isOpen('cellardoor') ? 'open on a breath of cold air from below.' : 'closed, its bolt drawn back.';
        return 'The heart of the house is a round hall two storeys high, with a balcony running around it overhead. The floor is a [mosaic]: a great compass rose in coloured stone. A [grandfather clock] ticks beside the [staircase], and a [portrait] watches from the wall. Doorways lead west to the library, north to a study and east to the dining room; the stairs curve up, and the front door is south.\n\nIn the curve of the wall, a low [cellar door] leads down. It is ' + cd;
      },
      exits: { s: { to: 'porch', door: 'frontdoor' }, out: { to: 'porch', door: 'frontdoor' }, w: 'library', n: 'study', e: 'dining', u: 'landing', d: { to: 'cellar', door: 'cellardoor' } },
      on: { unbolt: function (g, c) { if (!c.d || c.d === 'cellardoor' || c.d === 'bolt') return slideBolt(g); } },
      sc: {
        'staircase|stairs|stair|steps|banister': { d: 'A sweeping staircase with a banister polished by ninety years of one hand.', climb: 'u' },
        'balcony|gallery': 'A balcony runs right round the hall at the level of the first floor.'
      }
    },

    library: {
      name: 'Library',
      desc: 'Books climb every wall to the ceiling, with a wheeled [ladder] to reach the high shelves, and the air smells of vanilla and dust. A huge [celestial globe] stands in a mahogany cradle by the window, and a reading [table] holds a drift of papers. The only door is east.',
      exits: { e: 'hall', out: 'hall' },
      sc: {
        'books|shelves|shelf': { d: 'Astronomy, mostly: star atlases, catalogues, biographies of comets. Also a surprising amount of seafaring adventure and one cookbook titled ‘Cakes for Cold Nights’.', on: { read: 'You pull out a book at random: ‘Comets I Have Known (And Some I Have Merely Heard Of)’. Delightful, but it isn’t going to open any doors. You put it back.', take: 'There are thousands. You’d be here till the next comet.' } },
        'ladder|library ladder': { d: 'A wheeled ladder on a brass rail, for reaching the high shelves.', on: { climb: 'You trundle the ladder along its rail and climb to the top shelves. Up here live the books nobody reads twice: ‘Clouds I Have Disliked’, ‘A Short History of Fog’. You climb back down.', push: 'You roll the ladder along its rail. It goes with a pleasant rumble and stops at the cookery section.' } },
        'reading table|table|papers|drift': 'A drift of papers: calculations, shopping lists, and a sketch of a magpie with ‘THIEF!!’ written under it.',
        'mahogany cradle|cradle': 'A carved stand holding the globe so that it can spin.',
        'window': 'The window looks west over the yew walk. A white dome glimmers at the end of it: the folly.'
      }
    },

    study: {
      name: 'Study',
      desc: 'Your aunt’s study is small, crowded and comfortable, like a coat with full pockets. A broad [writing desk] faces the window, its top a landscape of ink blots, and a worn [armchair] slumps by the cold fireplace. Star charts are pinned to every inch of wall. The hall is south.',
      exits: { s: 'hall', out: 'hall' },
      sc: {
        'armchair|chair': { d: 'A leather armchair worn to the shape of one particular person.', on: { sit: 'You sink into the armchair, which receives you like an old friend. You could stay here for hours. Then you remember the comet, and climb out again.', enter: 'You sink into the armchair, which receives you like an old friend. Then you remember the comet, and climb out again.' } },
        'fireplace|grate|ashes': 'Cold, with a scatter of ash and a half-burnt page of sums.',
        'star charts|charts|chart|walls': 'Charts of the northern sky, covered in pencil notes. One, much handled, shows a long curve swooping in from the edge of the paper, labelled HESPER — 81 YRS.',
        'blotter|ink blots|inkwell|ink': 'Ink blots, ink rings and a ink thumbprint, signed with a flourish.'
      }
    },

    dining: {
      name: 'Dining Room',
      desc: 'A long dining table runs the length of the room under a [dust sheet], like the ghost of a dinner party lying down for a rest. A [sideboard] stands against one wall. Doors lead west to the hall and east to the kitchen.',
      exits: { w: 'hall', e: 'kitchen' },
      sc: {
        'dust sheet|sheet|table|dining table': { d: 'A long table under a white dust sheet, with the chairs tucked in beneath like children hiding.', on: { lookunder: 'Chair legs, a lost napkin ring, and a great deal of dust. Nothing shiny.', take: 'You lift a corner of the sheet. The table underneath is just a table, being patient. You let it fall.', pull: 'You lift a corner of the sheet. The table underneath is just a table, being patient. You let it fall.' } },
        'chairs|chair': 'Twelve dining chairs, tucked in under the sheet.'
      }
    },

    kitchen: {
      name: 'Kitchen',
      desc: 'A big, stone-flagged kitchen, cold now, dominated by a black iron [range] that once cooked for twenty. A [mantelpiece] runs above it. A door to the north leads to the larder; the dining room is west.',
      exits: { w: 'dining', n: 'larder' },
      sc: {
        'mantelpiece|mantel|mantle|shelf': 'A wide mantelpiece, home to a clock that stopped years ago and a china dog that has been surprised ever since.',
        'china dog|dog': 'A china dog with an expression of permanent surprise.',
        'flags|flagstones|floor': 'Big stone flags, worn smooth.',
        'sink|tap': 'A deep stone sink. The tap coughs, thinks better of it, and produces nothing.'
      }
    },

    larder: {
      name: 'Larder',
      desc: 'A narrow, chilly larder lined with [shelves]. Most of them hold jars of things that have long since become other things. The kitchen is south.',
      exits: { s: 'kitchen', out: 'kitchen' },
      sc: {
        'shelves|shelf|jars|jar': 'Pickles, preserves, and something labelled DO NOT OPEN — 1987. You respect its wishes.'
      }
    },

    cellar: {
      name: 'Cellar',
      dark: true,
      darkDesc: 'It is pitch dark. You can hear water somewhere ahead, and something that might be a mouse or might be your imagination. Stone steps lead back up.',
      desc: function (g) {
        return 'Your lantern pushes the darkness back into the corners of a long, vaulted cellar. [Wine racks] hold rows of dusty bottles, and a heap of [coal] glitters in one corner. Steps lead up to the hall. An archway opens east, breathing a smell of oil and iron, and from the north comes the sound of water.\n\nIn the west wall is a [steel door]' +
          (g.isOpen('vaultdoor') ? ', standing open.' : ', with four brass [dials] set in a row above its handle.');
      },
      exits: { u: { to: 'hall', door: 'cellardoor' }, e: 'gears', n: 'wheelpit', w: { to: 'vault', door: 'vaultdoor' }, in: { to: 'vault', door: 'vaultdoor' } },
      on: { dial: function (g, c) { return g.act('set', 'dials', null, c.topic); } },
      sc: {
        'wine racks|racks|rack|bottles|bottle|wine': { d: 'Dusty bottles with handwritten labels: ‘Elderflower 1971’, ‘Rhubarb (Dangerous)’.', on: { take: 'They’re your aunt’s, and some of them are older than you. Best left alone.' } },
        'coal|heap': 'A heap of coal, glittering in the lantern light like a pile of dark jewels. Not the kind of shiny that impresses anyone.',
        'archway|arch': 'A low brick archway to the east.'
      }
    },

    gears: {
      name: 'Gear Room',
      dark: true,
      darkDesc: 'It is pitch dark. Something huge and metallic is in here with you; you can smell the oil. The cellar is west.',
      desc: function (g) {
        var eng = g.p('clutch', 'engaged');
        return 'A room full of sleeping machinery. Iron [gears] taller than you mesh with one another in the lantern light, and a great vertical [shaft] climbs from them through the ceiling, towards the dome far above. A long [clutch lever] stands beside them, ' +
          (eng ? 'pulled down: ENGAGED.' : 'pushed up: DISENGAGED.') +
          (powered(g) ? ' The gears are turning with a deep, contented grinding, and the shaft spins.' : g.p('sluice', 'open') ? ' Through the wall you can hear the water wheel turning, but the gears here are still.' : '') +
          ' The cellar is west.';
      },
      exits: { w: 'cellar', out: 'cellar' },
      sc: {
        'gears|gear|cogs|machinery': { d: function (g) { return powered(g) ? 'The gears turn with slow, enormous patience. You keep your fingers well clear.' : 'Iron gears, oiled and waiting. The professor’s father built these to turn the dome by water power.'; }, on: { touch: 'Cold, oily and enormous.', turn: 'You lean on a gear with all your weight. It doesn’t notice.', push: 'You lean on a gear with all your weight. It doesn’t notice.' } },
        'shaft|drive shaft': 'A thick iron shaft rising through the ceiling towards the dome.'
      }
    },

    wheelpit: {
      name: 'Wheel Pit',
      dark: true,
      darkDesc: 'It is pitch dark and the air is damp. You can hear water trickling somewhere below you. The cellar is south.',
      desc: function (g) {
        var open = g.p('sluice', 'open');
        return 'A brick-lined pit, damp and echoing. A stone channel runs through it, and in the channel hangs a great iron [water wheel]. ' +
          (open ? 'Water thunders down the channel and the wheel turns, flinging spray that sparkles in the lantern light.' : 'The channel is nearly dry, and the wheel hangs still.') +
          '\n\nAt the upstream end, a wooden [sluice gate] ' + (open ? 'is raised' : 'holds back the water') + '; it is worked by an iron [crank]. A heavy iron [counterweight] hangs on a chain beside it' +
          (g.p('sluice', 'wedged') ? ', held up by ' + g.a(g.loc('poker') === 'sluice' ? 'poker' : 'boathook') + ' jammed into the gate’s guides.' : open ? ', sinking slowly.' : '.') +
          ' The cellar is south.';
      },
      exits: { s: 'cellar', out: 'cellar' },
      on: { swim: 'The channel is narrow and fast and very cold. No.' },
      sc: {
        'stone channel|channel|water|spray': { d: function (g) { return g.p('sluice', 'open') ? 'Dark water, racing.' : 'A stone channel with a sulky trickle in the bottom.'; }, on: { drink: 'It tastes of iron and moss.' } }
      }
    },

    vault: {
      name: 'Instrument Vault',
      dark: true,
      darkDesc: 'It is pitch dark, and the air is very still and dry. The cellar is east.',
      desc: 'A small, dry vault lined with velvet-padded [shelves]. Most of them hold only the dents of instruments that are no longer here — your aunt has taken her favourites travelling. The cellar is east.',
      exits: { e: { to: 'cellar', door: 'vaultdoor' }, out: { to: 'cellar', door: 'vaultdoor' } },
      sc: {
        'velvet shelves|shelves|shelf|velvet|dents': 'Faded blue velvet with neat dents in it: a sextant, a chronometer, a small telescope. All gone to sea.'
      }
    },

    landing: {
      name: 'Landing',
      desc: function (g) {
        return 'The staircase arrives at a balcony running around the top of the rotunda. A tall [window] looks out over the moonlit garden. Doors lead west to a bedroom and east to a long gallery. In the north wall, a narrow [oak door] ' +
          (g.isOpen('domedoor') ? 'stands open on a spiral stair.' : 'is marked TO THE DOME.') + ' The main staircase goes down.';
      },
      exits: { d: 'hall', w: 'bedroom', e: 'gallery', n: { to: 'stair', door: 'domedoor' }, u: { to: 'stair', door: 'domedoor' } },
      sc: {
        'tall window|window|garden': { d: 'The walled garden lies silver below, and the glasshouse glints. Beyond the wall, the tarn holds the moon.', on: { open: 'It’s painted shut. Wrenhallow has a thing about stuck doors and windows.' } },
        'balcony|railing|banister': 'A wooden railing. Below, the compass rose on the hall floor.',
        'staircase|stairs': { d: 'The main staircase, curving down to the hall.', climb: 'd' }
      }
    },

    bedroom: {
      name: 'Bedroom',
      desc: 'Your aunt’s bedroom is cosy and cluttered: a high brass [bed] with a patchwork quilt, a tall [wardrobe], a [bedside table] piled with books, and a window seat looking south. The landing is east.',
      exits: { e: 'landing', out: 'landing' },
      on: { sleep: function (g) { g.confirm('The bed is high and soft, the quilt is heaped and inviting, and you are very, very tired. If you lie down now you’ll certainly sleep through the comet. Lie down anyway? (yes or no)', 'sleep'); return true; } },
      sc: {
        'bedside table|table|pile|books': 'A tottering pile: ‘The Southern Ocean: A Traveller’s Companion’, ‘Knitting for Astronomers’, and a slim volume about magpies.',
        'window seat|seat|window': { d: 'A cushioned window seat looking down on the moonlit drive.', on: { sit: 'You sit for a moment. The rhododendrons below look like sleeping elephants. You get up again.' } },
        'patchwork quilt|quilt': 'Every patch a different fabric, and every fabric, you suspect, with a story.'
      }
    },

    gallery: {
      name: 'Instrument Gallery',
      desc: function (g) {
        return 'A long gallery lined with glass [cases] of old instruments: astrolabes, sextants, and a telescope made of cardboard and optimism. High in the ceiling at the far end is a square [hatch]' +
          (g.p('hatch', 'down') ? ', hanging open; a folding [ladder] reaches down from it to the floor.' : ' with an iron ring set into it, well out of reach.') +
          ' The landing is west.';
      },
      exits: { w: 'landing', out: 'landing', u: { to: 'attic', hidden: function (g) { return !g.p('hatch', 'down'); }, cond: function (g) { return g.p('hatch', 'down') || 'The hatch is high in the ceiling, and closed.'; } } },
      sc: {
        'glass cases|cases|case|instruments|astrolabes|astrolabe|sextants|sextant|cardboard telescope': { d: 'Brass astrolabes like intricate clocks; sextants; a quadrant; and a little cardboard telescope labelled ‘MY FIRST — O.V., AGED 7’.', on: { open: 'The cases are locked, and anyway everything in them is very old and very loved. Look, don’t touch.', attack: 'Breaking glass in your aunt’s house on your first night? No.' } }
      }
    },

    attic: {
      name: 'Attic',
      dark: true,
      darkDesc: 'It is pitch dark. Something rustles very close by, and there is a sharp, offended *chack!* The ladder is below you.',
      desc: 'Under the slope of the roof, the attic is a clutter of trunks and broken chairs. A round window in the gable has lost a pane, and something has made itself very much at home: on top of an old wardrobe sits an enormous, untidy [nest]. The ladder leads down.',
      exits: { d: 'gallery', out: 'gallery' },
      sc: {
        'trunks|trunk|chairs|clutter': 'Trunks with old shipping labels — Valparaíso, Hobart, Reykjavík — and chairs with three legs each, waiting for a fourth.',
        'round window|window|pane|gable': 'A round window with one pane missing: Pim’s front door.',
        'old wardrobe|wardrobe': 'An old wardrobe serving as Pim’s plinth.'
      }
    },

    stair: {
      name: 'Dome Stair',
      desc: 'A narrow spiral stair winds up inside the wall, lit by little round [portholes]. Every step has a brass star set into it, worn smooth by a lifetime of feet. The stair climbs to the dome; the oak door at the bottom leads south to the landing.',
      exits: { u: 'dome', s: { to: 'landing', door: 'domedoor' }, d: { to: 'landing', door: 'domedoor' } },
      sc: {
        'portholes|porthole|windows': 'Little round windows, each with its own small piece of night.',
        'brass stars|stars|star|steps': 'A brass star in every step. Your aunt climbed these every clear night for sixty years.'
      }
    },

    dome: {
      name: 'The Dome',
      desc: function (g) {
        var b = BEARINGS[g.p('bearingdial', 'bearing')];
        return 'You are inside the great dome of Wrenhallow: a vast round room ribbed with curving timber, like being inside a wooden bell. On an iron pier in the middle stands the [Great Refractor|telescope], a brass telescope as long as a rowing boat, pointing up at the dome’s [shutter]' +
          (g.p('shutter', 'open') ? ', which is open: a long slice of night sky, thick with stars, runs from the rim to the very top. The dome faces ' + b + '.' : ', which is closed. The dome faces ' + b + '.') +
          '\n\nOn a brass control stand beside the pier are a [bearing dial] and a [shutter lever]. A [logbook] lies open on a lectern, with a [pencil] tied to it on a string. A low [door|roof door] leads out onto the roof walk to the east; the stair goes down.';
      },
      exits: { d: 'stair', e: { to: 'roof', door: 'roofdoor' }, out: { to: 'roof', door: 'roofdoor' } },
      on: {
        dial: function (g, c) { return g.act('set', 'bearingdial', null, c.topic); },
        write: function (g, c) { return writeLog(g, c); }
      },
      sc: {
        'ribs|timber|timbers|ceiling': 'Curved oak ribs meeting at the top like the inside of a seashell.',
        'iron pier|pier': 'A massive iron column, bolted into the bedrock so that the telescope never feels the house tremble.',
        'control stand|stand|controls': 'A brass stand with a bearing dial for turning the dome and a lever for the shutter.',
        'lectern': 'A slanted wooden lectern holding the logbook.',
        'observing chair|chair': { d: 'A tall wooden observing chair on wheels.', on: { sit: 'You sit in the observing chair and spin round once, because you have to. Then you get up.' } }
      }
    },

    roof: {
      name: 'Roof Walk',
      desc: function (g) {
        return 'A narrow walkway with an iron [railing] circles the base of the dome, high above the garden. The wind smells of cold stone and pine, and the whole valley lies silver under the moon; the tarn is a coin dropped among the trees. Low in the north-east sky hangs the [comet].\n\n' +
          (g.p('ivy', 'cut') ? 'The shutter [track] is clear now, with a heap of ivy clippings at your feet.' : 'Thick [ivy] has climbed the wall and wound itself through the [track] that the dome’s shutter runs in, binding it like string round a parcel.') +
          ' A low door leads back west into the dome.';
      },
      exits: { w: { to: 'dome', door: 'roofdoor' }, in: { to: 'dome', door: 'roofdoor' } },
      on: { jump: 'You look over the railing at the long drop to the garden, and decide that jumping is something that happens to other people.' },
      sc: {
        'iron railing|railing|rail': 'An iron railing, cold and dewy, and reassuringly solid.',
        'track|shutter track|rail track': { d: function (g) { return g.p('ivy', 'cut') ? 'A curved iron track, clear of ivy now, for the shutter to run in.' : 'A curved iron track for the shutter to run in — choked with ivy.'; } },
        'valley|view|garden|trees|tarn': 'The world, laid out in silver and black. Somewhere down there is your bicycle.',
        'weathervane|vane': 'On top of the dome, a weathervane in the shape of a comet points patiently north-east.'
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Objects
  // ---------------------------------------------------------------------------
  var objects = {
    me: {
      name: 'yourself', proper: true, nouns: ['me', 'myself', 'self', 'yourself'], scenery: true,
      desc: 'You look like someone who has cycled six miles uphill, which you have. Otherwise: alert, curious, and only slightly windswept.'
    },

    // --- backdrops ----------------------------------------------------------
    sky: {
      name: 'sky', nouns: ['sky', 'stars', 'star', 'heavens', 'night'], scenery: true, backdrop: OUTDOOR.concat(['glasshouse']),
      desc: function (g) { return g.moves() < 40 ? 'The sky has gone the deep blue that comes just before black, pricked with the first stars.' : 'Black velvet, thick with stars. The Milky Way is a long smudge of chalk.'; }
    },
    moon: {
      name: 'moon', nouns: ['moon'], adj: ['gibbous', 'fat'], scenery: true, backdrop: OUTDOOR.concat(['glasshouse', 'tarn']),
      desc: 'A fat gibbous moon, bright enough to read by, if you squint.'
    },
    comet: {
      name: 'comet', nouns: ['comet', 'hesper', 'smudge', 'tail'], adj: ['faint', 'pale'], scenery: true, backdrop: OUTDOOR.concat(['dome']),
      desc: function (g) {
        if (g.room() === 'dome') {
          if (g.p('shutter', 'open') && g.p('bearingdial', 'bearing') === 'ne' && g.loc('eyepiece') === 'telescope') return lookThrough(g);
          return 'From in here you can only see Hesper through the telescope — with the shutter open, and the dome facing the right way.';
        }
        g.setFlag('seenNaked');
        return 'Low in the north-east, just above the hills, hangs a small smudge of light with a faint tail, like a thumbprint on the glass of the sky: Hesper. To your bare eyes it’s a promise more than a sight.' +
          (g.room() === 'roof' ? ' Through the Great Refractor, you think, it would be something else entirely.' : '');
      },
      on: { take: 'If only.', lookthrough: function (g) { return g.room() === 'dome' ? lookThrough(g) : true; } }
    },
    observatory: {
      name: 'observatory', nouns: ['observatory', 'dome', 'house', 'building', 'wrenhallow'], adj: ['pale', 'great'], scenery: true,
      backdrop: ['lane', 'wallpath', 'tarn', 'drive', 'garden', 'yews', 'porch'],
      desc: 'Wrenhallow: a tall old house of honey-coloured stone, all chimneys and ivy, wearing its great copper-green dome like a hat it is proud of.',
      on: { enter: function (g) { return g.room() === 'porch' ? (g.go('n'), true) : 'You’ll need to get to the front door first. It’s at the north end of the drive.'; } }
    },

    // --- the lane & gatehouse -----------------------------------------------
    letter: {
      name: 'letter', nouns: ['letter', 'envelope', 'invitation'], adj: ['aunt', 'ottoline', 'cream'], loc: 'player',
      desc: 'A letter on thick cream paper in your great-aunt’s spiky handwriting. You read it eleven times on the way here. (Try READ LETTER.)',
      text: '“My dear,\n\nHesper comes back tonight — the first time in eighty-one years, and very likely the last time for me, since when it next swings round I shall be a hundred and seventy-one and disinclined to climb stairs. So I have gone to watch it from a ship in the Southern Ocean, which is the sort of thing one ought to do at least once.\n\nWrenhallow is yours, if you can wake it. Mrs. Thorne at the gatehouse will let you in if you show her this letter. The rest you’ll have to puzzle out; I never could resist a puzzle, and I suspect neither can you.\n\nPoint the Great Refractor at Hesper, and write what you see in the logbook. Then the place is truly yours.\n\nWith love and a great deal of dust,\nAunt Ottoline\n\nP.S. Wind the owl.\nP.P.S. Mind the magpie.”',
      on: { eat: 'You’ve been hungry before, but not that hungry.', attack: 'You couldn’t possibly.' }
    },
    bicycle: {
      name: 'bicycle', nouns: ['bicycle', 'bike', 'cycle'], adj: ['your', 'trusty'], loc: 'lane', fixed: true,
      initial: 'Your [bicycle] leans against the wall where you dropped it.',
      desc: 'Your trusty bicycle. Its chain has opinions about hills, and has shared them for six miles.',
      on: { take: 'You and the bicycle have seen quite enough of each other for one day.', ride: 'Not now. The bicycle needs a rest, and frankly so do your knees.', enter: 'Not now. The bicycle needs a rest, and frankly so do your knees.', push: 'You wheel it a few feet and lean it back against the wall. It sighs.' }
    },
    gates: {
      name: 'iron gates', nouns: ['gates', 'gate'], adj: ['iron', 'tall', 'wrought', 'pair'], plural: true, door: true,
      openable: true, lockable: true, key: 'gatekey', props: { open: false, locked: true },
      desc: function (g) {
        return 'Tall wrought-iron gates, topped with little iron stars, with a W worked into each one. ' +
          (g.isOpen('gates') ? 'They stand open.' : g.p('gates', 'locked') ? 'They are locked, with a big old-fashioned keyhole.' : 'They are closed, but no longer locked.');
      },
      on: {
        climb: 'The gates are topped with iron stars, which are pretty and pointy in roughly equal measure. You decide against it.',
        push: function (g) { return g.isOpen('gates') ? 'They’re already open.' : g.p('gates', 'locked') ? 'They rattle, but they’re locked.' : g.act('open', 'gates'); },
        knock: 'Nobody answers from the other side. The gatehouse, though, has a light on.'
      }
    },
    gatekey: {
      name: 'gate key', nouns: ['key'], adj: ['gate', 'big', 'old'], loc: 'thorne',
      desc: 'A big old iron key, as long as your hand, with a bow shaped like a W.',
      on: { take: function (g) { if (g.loc('gatekey') === 'thorne') return '“Ask nicely,” says Mrs. Thorne, “and show me some proof of who you are, and we’ll see.”'; } }
    },
    thorne: {
      name: 'Mrs. Thorne', proper: true, npc: true, gender: 'her', loc: 'cottage',
      nouns: ['thorne', 'mrs', 'woman', 'caretaker', 'ilse', 'lady', 'housekeeper', 'ilse'],
      describe: function (g) { return '[Mrs. Thorne|Thorne] sits in the rocking chair, knitting something long and purple' + (g.flag('gaveBloom') ? ', a moonflower bloom tucked in her buttonhole.' : '.'); },
      desc: function (g) { return 'A small, sturdy woman with a face like a kind walnut and eyes that miss nothing. A bunch of keys hangs from her belt' + (g.loc('gatekey') === 'thorne' ? ', the biggest of them a great iron gate key.' : '.') + (g.flag('gaveBloom') ? ' A moonflower glows in her buttonhole.' : ''); },
      talk: function (g) {
        var t = g.flag('thorneMet') ? '“Still here, dear?” says Mrs. Thorne.' :
          '“Evening,” says Mrs. Thorne, without missing a stitch. “You’ll be the great-niece. Or nephew. One of those. She said you’d come.”' + (g.loc('gatekey') === 'thorne' ? ' She nods at the window. “Gate’s locked. I’ve the key. You’ll have something to show me, I expect.”' : '');
        g.setFlag('thorneMet');
        return t + '\n\n(You could ask her about [the professor>ask thorne about professor], [the gate>ask thorne about gate], [the comet>ask thorne about comet], [the house>ask thorne about house], [the magpie>ask thorne about magpie] or [the moonflower>ask thorne about moonflower].)';
      },
      topics: {
        'professor ottoline aunt vane great-aunt her she': '“Forty years I’ve kept house for her, and she’s kept me guessing every one of them,” says Mrs. Thorne. “Off to the Southern Ocean, if you please, to watch a comet from a boat. At ninety! I packed her extra socks.”',
        'gate gates key keys belt': function (g) { return g.loc('gatekey') === 'thorne' ? '“The gate key stays on my belt till I see proof you are who you say,” she says. “She’ll have written to you, I’ll be bound. Show it here.”' : '“You’ve the key now, dear. It’s your gate — or it will be.”'; },
        'letter proof invitation': function (g) { return g.loc('gatekey') === 'thorne' ? '“Show it here, then,” she says, holding out a hand. (Try SHOW LETTER TO THORNE.)' : '“A lovely letter. She always did write a good letter.”'; },
        'comet hesper tonight sky': '“Hesper,” says Mrs. Thorne. “Comes round every eighty-one years. Ottoline saw it last time — nine years old, up in that dome with her father. Talked about it for the rest of her life.” She glances at the window. “It’s up already, low in the north-east. Gone by dawn, mind.”',
        'observatory wrenhallow house dome home building': '“The old house is asleep, that’s all,” she says. “The front door sticks — don’t fuss with the handle, give it a good shove. And the dome hasn’t turned in years; something to do with water and wheels. I keep out of the cellar. Spiders.”',
        'door front stuck': '“Sticks in the damp. Put your shoulder to it.”',
        'cellar bolt rust rusty below downstairs': '“That bolt’s been rusted solid since I don’t know when. A drop of oil might shift it. There’s lamp oil in the potting shed.”',
        'lantern lamp light dark darkness candle torch': '“You’ll want a light if you’re poking about below stairs. There’s an old lantern in the boathouse — down the path along the wall, by the tarn. Oil’s in the potting shed.”',
        'oil paraffin shed garden': '“Shed’s in the walled garden, east off the drive. Lamp oil on the shelf, and more tools than sense.”',
        'matches match fire': '“Matches? On the kitchen mantelpiece, up at the house. She won’t have them kept anywhere else.”',
        'pim magpie bird thief thimble spoon attic': '“That magpie!” Her needles click furiously. “Pim. Ottoline’s pet, if you can call a thief a pet. Lives in the attic. Steals anything that shines — my good thimble, three teaspoons, and the glass out of her telescope, she swears. Won’t give anything back unless you give him something shinier.”',
        'copernicus owl clockwork automaton': '“The clockwork owl? Her father made him. Used to hoot the hours. Run down years ago — and the key’s locked away somewhere below stairs, I shouldn’t wonder.”',
        'moonflower flower flowers glasshouse greenhouse plant bloom': function (g) {
          return g.flag('gaveBloom') ? 'She touches the bloom in her buttonhole and says nothing at all, which from Mrs. Thorne is a speech.'
            : '“Her moonflower. Blooms once in a blue moon — well, once in a comet. Only if somebody remembers to water it, which nobody has, because I’ve had my hands full.” She looks at the fire. “I’d dearly love to see one of those flowers again.”';
        },
        'herself thorne you yourself mrs ilse': '“Me? I’m the one who knows where everything is, dear. That makes me the most important person in any house.”',
        'tarn boathouse lake water pond': '“Down the path along the wall. Mind the reeds; they’re wetter than they look.”',
        'vault code combination dials safe numbers': '“Ottoline had a code for that old vault. Forever forgetting it. Wrote it down somewhere clever, I expect, and then forgot where.”',
        'telescope refractor eyepiece lens glass': '“Biggest telescope in the county. Hasn’t been pointed at anything but dust for ten years. It would please her to have it working again.”',
        'logbook book log': '“Her father’s logbook, up in the dome. Every comet, every eclipse, every interesting cloud. She wants your name in it, you know. Said as much.”',
        'time clock dawn hour late': function (g) { return '“Getting on for ' + g.clock() + ', by my reckoning. Comet’s gone by dawn, mind — six o’clock or thereabouts.”'; },
        'knitting scarf wool': '“It’s a scarf,” she says firmly. “Mostly.”',
        'orrery folly planets moons': '“Her father’s orrery, out in the folly at the end of the yew walk. Made it for her ninth birthday. She’d sit and count the moons on it for hours.”',
        'shortbread food tea toast': '“There’s toast if you want it, but you’ll want to get up to that dome first.”'
      },
      dflt: 'Mrs. Thorne considers this. “Couldn’t tell you, dear. Ask me about something sensible — the professor, or the house.”',
      rcv: {
        show: function (g, c) {
          if (c.d === 'letter') return thorneLetter(g);
          if (c.d === 'bloom') return thorneBloom(g);
          return 'Mrs. Thorne glances at ' + g.the(c.d) + '. “Very nice, dear.”';
        },
        give: function (g, c) {
          if (c.d === 'letter') return thorneLetter(g);
          if (c.d === 'bloom') return thorneBloom(g);
          return '“That’s kind, dear, but you hang on to it.”';
        }
      },
      on: {
        take: 'Mrs. Thorne is not luggage.',
        attack: 'Mrs. Thorne gives you a look that could curdle milk at forty paces. You think better of it.',
        kiss: 'You give Mrs. Thorne a peck on the cheek. “Get away with you,” she says, pleased.',
        touch: 'You pat Mrs. Thorne on the shoulder. She pats your hand back without looking up from her knitting.'
      }
    },

    // --- the tarn & boathouse -----------------------------------------------
    tarnwater: {
      name: 'tarn', nouns: ['tarn', 'water', 'lake', 'pond'], adj: ['still', 'black', 'silver'], loc: 'tarn', scenery: true,
      desc: 'Black water, perfectly still, holding the moon and a smattering of stars. In the north-east of the reflected sky, a faint smudge.',
      on: {
        drink: 'You cup a little in your hands. It tastes of iron and moonlight. Bracing.',
        enter: 'Not tonight. The water looks cold enough to make your ancestors shiver.',
        fill: 'You can’t fill a tarn. It’s doing fine on its own.'
      },
      rcv: { putin: function (g, c) { return c.d === 'wateringcan' ? fillCan(g) : 'You’d rather not drop ' + g.the(c.d) + ' in the tarn. You’d never see it again.'; } }
    },
    boat: {
      name: 'rowing boat', nouns: ['boat', 'hull', 'rowboat'], adj: ['rowing', 'upturned'], loc: 'boathouse', scenery: true,
      desc: 'An upturned wooden rowing boat, patched in a dozen places. A name is painted on its stern: COMET II. You decide not to ask what happened to the first one.',
      on: {
        enter: 'You clamber onto the upturned hull, which is not how boats are meant to be boarded. Nothing nautical happens. You climb down again.',
        push: 'It’s heavy and upside down, and it likes it that way.', pull: 'It’s heavy and upside down, and it likes it that way.',
        take: 'It’s a boat. You are not that strong, and there is no water in here anyway.',
        lookunder: 'Spiders, a rowlock and a great deal of nothing.'
      }
    },
    lantern: {
      name: 'oil lantern', nouns: ['lantern', 'lamp', 'wick'], adj: ['oil', 'storm', 'old', 'brass', 'hurricane'], loc: 'boathouse', props: { oil: false, lit: false },
      initial: 'An old [oil lantern] hangs from a peg by the door.',
      note: function (g) { return g.p('lantern', 'lit') ? 'lit' : ''; },
      desc: function (g) {
        return 'A brass storm lantern with a glass chimney, the kind that has seen a few storms. ' +
          (g.p('lantern', 'lit') ? 'It is lit, and burns with a warm, steady flame.' : g.p('lantern', 'oil') ? 'Its reservoir is full of oil, but it isn’t lit.' : 'Its oil reservoir is bone dry.');
      },
      on: {
        light: lightLantern, switchon: lightLantern,
        fill: function (g, c) { return c.i && c.i !== 'oilcan' ? 'That won’t make it burn.' : fillLantern(g); },
        oil: function (g) { return fillLantern(g); },
        extinguish: function (g) {
          if (!g.p('lantern', 'lit')) return 'It isn’t lit.';
          g.set('lantern', 'lit', false);
          return g.dark() ? 'You blow out the lantern. Darkness rushes in, delighted.' : 'You turn down the wick, and the flame shrinks and goes out.';
        },
        switchoff: function (g) { return g.act('extinguish', 'lantern'); },
        open: 'The glass chimney lifts up for lighting, but there’s nothing to be gained by fiddling with it.'
      },
      rcv: {
        putin: function (g, c) { if (c.d === 'oilcan') return fillLantern(g); },
        pour: function (g, c) { if (c.d === 'oilcan') return fillLantern(g); },
        use: function (g, c) { if (c.d === 'oilcan') return fillLantern(g); if (c.d === 'matches') return lightLantern(g, { i: 'matches' }); }
      }
    },
    boathook: {
      name: 'boathook', nouns: ['boathook', 'pole', 'hook'], adj: ['long', 'brass', 'boat', 'wooden'], loc: 'boathouse',
      initial: 'A long [boathook] leans in the corner, its brass hook gone green with age.',
      desc: 'A long wooden pole with a brass hook on the end, for catching hold of things just out of reach.',
      on: { attack: 'You give the air a vigorous poke. The air is unharmed.' }
    },

    // --- the walled garden ----------------------------------------------------
    sundial: {
      name: 'sundial', nouns: ['sundial', 'dial', 'motto', 'gnomon'], adj: ['stone'], loc: 'garden', scenery: true,
      desc: 'A stone sundial with a bronze gnomon, its face rubbed by weather. There’s a motto round the edge. (Try READ SUNDIAL.)',
      text: 'Round the edge, in worn letters: I COUNT ONLY THE SUNNY HOURS. Underneath, someone has added in chalk: ‘and the starry ones — O.V.’',
      on: { turn: 'It is set in stone, in every sense.', set: 'It is set in stone, in every sense.', take: 'It is set in stone, in every sense.' }
    },
    raintub: {
      name: 'rain butt', nouns: ['butt', 'barrel', 'tub', 'rainwater', 'water'], adj: ['rain', 'water', 'wooden', 'fat'], loc: 'garden', scenery: true,
      desc: 'A fat wooden barrel brimming with rainwater, fed by a downpipe from the wall.',
      on: { drink: 'You’ve had more appetising drinks. You’ve also had worse.', take: 'It’s full of water and roughly the size of a pony.', enter: 'You are not that hot, and it is not that kind of night.' },
      rcv: { putin: function (g, c) { return c.d === 'wateringcan' ? fillCan(g) : 'You’d rather not drown ' + g.the(c.d) + '.'; } }
    },
    scarecrow: {
      name: 'scarecrow', nouns: ['scarecrow', 'jacket', 'hat', 'turnip'], adj: ['tweed', 'battered'], loc: 'garden', scenery: true,
      desc: 'A scarecrow in a tweed jacket and a battered hat, with a turnip for a head and an expression of mild surprise. Its buttons are missing — pecked off, by the look of the holes. Something round here is very fond of shiny things.',
      on: { take: 'He looks settled. Leave him be.', talk: 'The scarecrow keeps its own counsel.', ask: 'The scarecrow keeps its own counsel.', wear: 'The jacket smells of turnip. You decline.', attack: 'He’s been through enough.' }
    },
    moonflower: {
      name: 'moonflower', nouns: ['moonflower', 'flower', 'plant', 'vine', 'buds', 'bud', 'flowers'], adj: ['moon', 'white', 'twisting'], loc: 'glasshouse', scenery: true, supporter: true, hideContents: true,
      props: { bloomed: false },
      desc: function (g) { return g.p('moonflower', 'bloomed') ? 'The moonflower is in full, glorious bloom: dozens of white trumpets, glowing faintly, giving off a scent like vanilla and rain.' + (g.loc('bloom') === 'moonflower' ? ' You could pick a [bloom]; there are plenty.' : '') : 'A twisting vine covered in tight white buds, each one furled like an umbrella. The soil in its pot is cracked and dry. It looks thirsty.'; },
      on: {
        water: waterFlower,
        take: function (g) { if (!g.p('moonflower', 'bloomed')) return 'It’s rooted in a very large pot, and anyway it isn’t ready to be picked. It’s barely awake.'; if (g.loc('bloom') === 'moonflower') return g.act('take', 'bloom'); return 'You have a bloom already. Leave the rest for the moths.'; },
        smell: function (g) { return g.p('moonflower', 'bloomed') ? 'Vanilla, rain, and something like the smell of a brand-new book. You could stand here all night.' : 'Green, and faintly dusty.'; },
        eat: 'It’s for looking at, not eating.'
      },
      rcv: {
        pour: function (g, c) { if (c.d === 'wateringcan') return waterFlower(g); },
        use: function (g, c) { if (c.d === 'wateringcan') return waterFlower(g); },
        putin: function (g, c) { if (c.d === 'wateringcan') return waterFlower(g); },
        puton: function (g, c) { if (c.d === 'wateringcan') return waterFlower(g); }
      }
    },
    bloom: {
      name: 'moonflower bloom', nouns: ['bloom', 'blossom', 'flower', 'trumpet'], adj: ['moonflower', 'white', 'glowing'], loc: null,
      desc: 'A single white moonflower, glowing faintly, smelling of vanilla and rain.',
      on: { smell: 'Vanilla, rain, and something like a brand-new book.', eat: 'It’s far too beautiful to eat. Also, probably, not edible.', wear: 'You tuck it behind your ear for a moment, then think better of it. It’s for someone.' }
    },
    wateringcan: {
      name: 'watering can', nouns: ['can', 'wateringcan'], adj: ['watering', 'green', 'tin'], loc: 'glasshouse', props: { full: false },
      initial: 'A green [watering can] stands under a bench.',
      note: function (g) { return g.p('wateringcan', 'full') ? 'full of water' : ''; },
      desc: function (g) { return 'A green tin watering can with a long spout and a rose on the end. ' + (g.p('wateringcan', 'full') ? 'It’s full of water.' : 'It’s empty.'); },
      on: {
        fill: function (g) { return fillCan(g); },
        pour: function (g, c) {
          if (!g.p('wateringcan', 'full')) return 'It’s empty.';
          if (!c.i) return g.room() === 'glasshouse' ? waterFlower(g) : 'You’d rather not water the floor.';
          return 'Watering ' + g.the(c.i) + ' wouldn’t help anything.';
        },
        drink: 'It’s rainwater, in a watering can, that tastes of watering can. You decline.'
      }
    },

    // --- the potting shed -----------------------------------------------------
    oilcan: {
      name: 'oil can', nouns: ['can', 'oilcan', 'paraffin', 'oil'], adj: ['oil', 'lamp', 'red', 'paraffin'], loc: 'shed',
      initial: 'A red [oil can] — the kind for lamp oil — sits on the shelf.',
      desc: 'A red tin can with a long spout, half full of lamp oil: enough for a lantern, a squeaky hinge, and a good deal more besides.',
      on: {
        pour: function (g, c) { if (!c.i) return 'You’d rather not waste it on the floor. Pour it into or onto something in particular.'; return 'Oiling ' + g.the(c.i) + ' wouldn’t help.'; },
        drink: 'Absolutely not.', eat: 'Absolutely not.',
        open: 'You unscrew the cap and screw it back on. The oil smells strongly of paraffin.',
        light: 'Setting fire to a can of lamp oil is the kind of idea that ends in a very short story.'
      }
    },
    secateurs: {
      name: 'secateurs', nouns: ['secateurs', 'shears', 'clippers', 'pruners', 'scissors', 'cutters'], adj: ['sharp', 'garden', 'pair'], loc: 'shed', plural: true, article: 'a pair of',
      initial: 'A pair of [secateurs] hangs from a nail.',
      desc: 'A pair of sharp, well-oiled garden secateurs. Somebody loved these.'
    },
    trowel: {
      name: 'trowel', nouns: ['trowel'], adj: ['garden', 'rusty'], loc: 'shed',
      initial: 'A rusty [trowel] lies on the workbench.',
      desc: 'A garden trowel, rusty but game.',
      on: { dig: 'You dig a small, neat hole, admire it, and fill it in again.' }
    },

    // --- the folly ----------------------------------------------------------
    orrery: {
      name: 'orrery', nouns: ['orrery', 'model', 'machine', 'clockwork'], adj: ['brass', 'great', 'clockwork'], loc: 'folly', scenery: true,
      desc: 'A beautiful brass orrery. The sun is a polished ball at its centre, and around it on curving arms ride the planets — [Mercury], [Venus], [Earth], [Mars], [Jupiter], [Saturn], [Uranus] and [Neptune] — each with its little moons on wires. A small [crank] at the base would set the whole thing turning.',
      on: { turn: function (g) { return g.act('turn', 'crank'); }, take: 'It’s bolted to the pedestal, and it weighs as much as a piano.', count: 'Examine each planet to count its moons.' }
    },
    crank2: {
      name: 'crank', nouns: ['crank', 'handle'], adj: ['small', 'orrery'], loc: 'folly', scenery: true,
      desc: 'A little brass crank, for setting the orrery in motion.',
      on: { turn: 'You turn the crank. With a soft whirring, the whole solar system begins to move: Mercury scurries, Jupiter strolls, and Neptune barely bothers. You let it wind down, oddly moved.', push: 'It turns rather than pushes.', pull: 'It turns rather than pulls.' }
    },
    sun: { name: 'brass sun', nouns: ['sun'], adj: ['brass', 'polished'], loc: 'folly', scenery: true, desc: 'A polished brass ball, warm to the touch somehow, at the centre of everything. No moons, naturally.' },
    mercury: { name: 'Mercury', proper: true, nouns: ['mercury'], loc: 'folly', scenery: true, desc: 'Mercury: a little grey bead on the shortest arm, hurrying. No moons at all.' },
    venus: { name: 'Venus', proper: true, nouns: ['venus'], loc: 'folly', scenery: true, desc: 'Venus: a creamy pearl. No moons.' },
    earth: { name: 'Earth', proper: true, nouns: ['earth', 'world'], loc: 'folly', scenery: true, desc: 'Earth: blue and green enamel, with one silver moon on a wire. Somewhere on it, you suppose, is your bicycle.' },
    mars: { name: 'Mars', proper: true, nouns: ['mars'], adj: ['red', 'little'], loc: 'folly', scenery: true, desc: 'Mars, the little red one: a rust-coloured bead attended by *two* tiny moons no bigger than seeds.' },
    jupiter: { name: 'Jupiter', proper: true, nouns: ['jupiter'], adj: ['king'], loc: 'folly', scenery: true, desc: 'Jupiter, the king of the planets: banded in cream and tan, with a red enamel spot like a drop of jam. *Four* moons ride around it on fine wires.' },
    saturn: { name: 'Saturn', proper: true, nouns: ['saturn', 'rings'], adj: ['ringed'], loc: 'folly', scenery: true, desc: 'Saturn, lord of the rings: its brass rings tilted at a jaunty angle, and *eight* moons fanned out around it.' },
    uranus: { name: 'Uranus', proper: true, nouns: ['uranus'], loc: 'folly', scenery: true, desc: 'Uranus: pale green, tipped on its side as if it has had a long day, with *four* moons.' },
    neptune: { name: 'Neptune', proper: true, nouns: ['neptune'], adj: ['blue'], loc: 'folly', scenery: true, desc: 'Neptune, sea-blue, on the longest arm at the very edge of the orrery, with a *single* moon.' },
    plaque: {
      name: 'plaque', nouns: ['plaque', 'inscription'], adj: ['brass'], loc: 'folly', scenery: true,
      desc: 'A brass plaque set into the pedestal. (Try READ PLAQUE.)',
      text: 'MADE FOR OTTOLINE VANE ON HER NINTH BIRTHDAY BY HER FATHER — WITH EVERY MOON THEN KNOWN.'
    },

    // --- the porch & rotunda ----------------------------------------------
    frontdoor: {
      name: 'front door', nouns: ['door'], adj: ['front', 'oak', 'oaken', 'iron-studded', 'studded'], door: true, openable: true,
      props: { open: false, stuck: true },
      desc: function (g) { return 'A massive oak door, iron-studded, with a brass knocker shaped like a comet. ' + (g.isOpen('frontdoor') ? 'It stands open.' : g.p('frontdoor', 'stuck') ? 'There’s no keyhole worth the name — just an iron ring for a handle.' : 'It is closed.'); },
      on: {
        open: function (g) { if (g.p('frontdoor', 'stuck')) return 'You turn the iron ring and push. The door shifts a quarter of an inch and stops dead. It isn’t locked — it’s stuck, swollen tight in its frame by a hundred wet winters.'; },
        push: function (g) {
          if (!g.p('frontdoor', 'stuck')) return g.isOpen('frontdoor') ? 'It’s already open.' : g.act('open', 'frontdoor');
          g.set('frontdoor', 'stuck', false);
          g.set('frontdoor', 'open', true);
          g.award('door', 3);
          return 'You put your shoulder to the door and shove. For a moment nothing happens; then, with a crack like a knee straightening, it bursts open, and you stumble into a breath of cold, dusty air.';
        },
        attack: function (g) { return g.act('push', 'frontdoor'); },
        pull: function (g) { return g.p('frontdoor', 'stuck') ? 'You pull on the iron ring. The door doesn’t even pretend to consider it. It opens inwards, anyway.' : undefined; },
        knock: 'You knock. The sound goes into the house and doesn’t come back. Nobody is home but the furniture.',
        unlock: function (g) { return g.p('frontdoor', 'stuck') ? 'It isn’t locked, just stuck.' : 'It isn’t locked.'; }
      }
    },
    clock: {
      name: 'grandfather clock', nouns: ['clock', 'face', 'hands'], adj: ['grandfather', 'tall', 'walnut'], loc: 'hall', scenery: true,
      desc: function (g) { return 'A tall grandfather clock in a walnut case, its face painted with a sun and a crescent moon. It says ' + g.clock() + '. It is the only thing in the house that seems entirely sure of itself.'; },
      on: { listen: 'Tick. Tock. Tick. Tock. Comforting, with an undertone of *hurry*.', open: 'You open the case: a long brass pendulum, swinging with great seriousness. You close it again.', take: 'It weighs more than you do and has been standing there since before you were born.', set: 'It’s keeping perfect time. Best leave it.', turn: 'It’s keeping perfect time. Best leave it.' }
    },
    mosaic: {
      name: 'mosaic', nouns: ['mosaic', 'floor', 'rose', 'compass', 'tiles'], adj: ['compass', 'coloured', 'stone'], loc: 'hall', scenery: true,
      desc: 'A great compass rose in coloured stone, with the points picked out in black and gold. Between north and east, exactly on the north-east point, someone has set a tiny silver comet into the floor.'
    },
    portrait: {
      name: 'portrait', nouns: ['portrait', 'painting', 'picture'], adj: ['oil'], loc: 'hall', scenery: true,
      desc: 'Ottoline Vane as a young woman, in a tweed jacket, holding a brass telescope as if it were a cricket bat. A magpie sits on her shoulder with the expression of someone planning a theft.',
      on: { take: 'It’s firmly hung and taller than you are.', lookunder: 'Behind the frame there is only wallpaper and a spider of great age.' }
    },
    cellardoor: {
      name: 'cellar door', nouns: ['door'], adj: ['cellar', 'low'], door: true, openable: true,
      props: { open: false, bolted: true },
      desc: function (g) { return 'A low, heavy door in the curve of the wall, leading down. ' + (g.p('cellardoor', 'bolted') ? 'It is held shut by a heavy iron [bolt]' + (g.p('bolt', 'rusty') ? ', rusted solid.' : ', gleaming with oil.') : g.isOpen('cellardoor') ? 'It stands open.' : 'Its bolt is drawn back.'); },
      on: {
        open: function (g) {
          if (!g.p('cellardoor', 'bolted')) return;
          if (g.p('bolt', 'rusty')) return 'It’s fastened with a heavy iron bolt, and the bolt is rusted solid.';
          g.say('(first sliding back the bolt)');
          g.say(slideBolt(g));
          g.set('cellardoor', 'open', true);
          return 'You open the cellar door. Cold air breathes up from below.';
        },
        unbolt: function (g) { return slideBolt(g); },
        oil: function (g) { return oilBolt(g); },
        unlock: function (g) { return g.p('cellardoor', 'bolted') ? 'It isn’t locked — it’s bolted. (Try sliding the bolt.)' : 'It isn’t locked.'; }
      },
      rcv: { puton: function (g, c) { if (c.d === 'oilcan') return oilBolt(g); }, pour: function (g, c) { if (c.d === 'oilcan') return oilBolt(g); }, use: function (g, c) { if (c.d === 'oilcan') return oilBolt(g); } }
    },
    bolt: {
      name: 'bolt', nouns: ['bolt'], adj: ['iron', 'heavy', 'rusty', 'rusted'], loc: 'hall', scenery: true, props: { rusty: true },
      desc: function (g) { return g.p('bolt', 'rusty') ? 'A heavy iron bolt, furred with orange rust. It looks as though it hasn’t moved in decades.' : g.p('cellardoor', 'bolted') ? 'The bolt gleams with oil and looks ready to slide.' : 'The bolt is drawn back.'; },
      on: {
        pull: slideBolt, push: slideBolt, open: slideBolt, unbolt: slideBolt, turn: slideBolt, unlock: slideBolt,
        oil: oilBolt,
        close: function (g) { if (g.isOpen('cellardoor')) return 'You’d have to close the door first.'; if (g.p('cellardoor', 'bolted')) return 'It’s already bolted.'; g.set('cellardoor', 'bolted', true); return 'You slide the bolt home.'; },
        take: 'It’s fixed to the door.'
      },
      rcv: { puton: function (g, c) { if (c.d === 'oilcan') return oilBolt(g); }, pour: function (g, c) { if (c.d === 'oilcan') return oilBolt(g); }, use: function (g, c) { if (c.d === 'oilcan') return oilBolt(g); } }
    },

    // --- the library ----------------------------------------------------------
    globe: {
      name: 'celestial globe', nouns: ['globe', 'seam', 'catch', 'equator', 'constellations'], adj: ['celestial', 'great', 'huge', 'brass'], loc: 'library', scenery: true,
      container: true, openable: true, props: { open: false },
      desc: function (g) { return 'A great celestial globe, taller than you, painted midnight blue with gold constellations. A fine seam runs all the way round its equator, with a tiny brass catch. ' + (g.isOpen('globe') ? 'The northern hemisphere is lifted back like a lid.' : ''); },
      on: {
        turn: 'You give the globe a spin. The constellations wheel past — the Plough, the Swan, the Hunter — and something small rattles about inside.',
        push: 'You give the globe a spin. The constellations wheel past, and something small rattles about inside.',
        shake: 'It’s far too big to shake, but when you rock it, something small rattles inside.',
        open: function (g, c) { if (g.isOpen('globe')) return; g.set('globe', 'open', true); g.award('globe', 1); return 'You press the little catch and lift the northern hemisphere like a lid, revealing the inside of the sky.' + (g.loc('smallkey') === 'globe' ? ' Nestled at the south pole is a [small brass key].' : ''); },
        take: 'It’s taller than you are.'
      }
    },
    smallkey: {
      name: 'small brass key', nouns: ['key'], adj: ['small', 'brass', 'tiny', 'little', 'desk', 'drawer'], loc: 'globe',
      desc: 'A small brass key with a star-shaped bow. It looks like it belongs to a drawer.'
    },
    almanac: {
      name: 'almanac', nouns: ['almanac', 'almanack', 'page'], adj: ['fat', 'wrenhallow'], loc: 'library',
      initial: 'A fat [almanac] lies open on the reading table.',
      desc: 'The Wrenhallow Almanac: tides, moons, eclipses and comets for the next hundred years. One page is marked with a pressed violet. (Try READ ALMANAC.)',
      text: 'The marked page reads:\n\nHESPER (periodic comet; return period 81 years). TONIGHT: already risen at dusk, LOW IN THE NORTH-EAST, where it remains all night. To the naked eye a faint smudge; a large refractor will show the tails in glory. Fades before dawn (6 a.m.).\n\nIn the margin, in your aunt’s spiky hand: *Dome to NE!!*'
    },
    manual: {
      name: 'engine manual', nouns: ['manual', 'book', 'engine', 'handbook'], adj: ['engine', 'slim', 'wrenhallow'], loc: 'library',
      initial: 'Beside it lies a slim book with ‘THE WRENHALLOW ENGINE’ stamped on its cover: an [engine manual|manual].',
      desc: 'A slim, oil-stained book: ‘The Wrenhallow Engine — Its Use and Care’, by W. Vane. (Try READ MANUAL.)',
      text: '‘The dome is turned by the power of water. To turn it:\n\n1. In the WHEEL PIT, north of the cellar, open the sluice by turning the crank. Water from the tarn will drive the wheel. NOTE: a counterweight closes the sluice again after a few minutes, as a precaution against flooding. (My daughter informs me that I jam it open with the kitchen poker. I deny this.)\n\n2. In the GEAR ROOM, east of the cellar, pull down the clutch lever to connect the wheel to the dome.\n\n3. In the DOME, turn the bearing dial to the desired direction. The dome will follow.’'
    },

    // --- the study ------------------------------------------------------------
    desk: {
      name: 'writing desk', nouns: ['desk', 'top'], adj: ['writing', 'broad'], loc: 'study', scenery: true,
      desc: function (g) { return 'A broad writing desk with a single [drawer]' + (g.isOpen('drawer') ? ', now open' : g.p('drawer', 'locked') ? ' with a small keyhole' : '') + '. Its top is cluttered with a blotter, an inkwell and a silver-framed [photograph].'; },
      on: { open: function (g) { return g.act('open', 'drawer'); }, search: function (g) { return g.act('search', 'drawer'); }, take: 'It’s a desk. Desks are famously reluctant to be carried.' }
    },
    drawer: {
      name: 'desk drawer', nouns: ['drawer', 'keyhole'], adj: ['desk', 'single', 'small'], loc: 'study', scenery: true,
      container: true, openable: true, lockable: true, key: 'smallkey', props: { open: false, locked: true },
      desc: function (g) { return g.isOpen('drawer') ? 'The desk drawer is open.' : g.p('drawer', 'locked') ? 'The drawer is locked. It has a small keyhole.' : 'The drawer is closed.'; },
      on: {
        unlock: function (g, c) { if (!g.p('drawer', 'locked')) return; g.dflt(c); if (!g.p('drawer', 'locked')) g.award('drawer', 3); return true; },
        open: function (g, c) { var was = g.p('drawer', 'locked'); g.dflt(c); if (was && !g.p('drawer', 'locked')) g.award('drawer', 3); return true; },
        pull: function (g) { return g.act('open', 'drawer'); },
        attack: 'Forcing your aunt’s desk on your first night would be a poor start. There’ll be a key somewhere.'
      }
    },
    photograph: {
      name: 'photograph', nouns: ['photograph', 'photo', 'picture', 'frame'], adj: ['silver', 'framed', 'silver-framed'], loc: 'study', scenery: true,
      desc: 'Two young women laughing on the steps of Wrenhallow, arm in arm, squinting into the sun. One, all elbows and enthusiasm, is clearly your aunt. The other, unless you’re much mistaken, is a young Mrs. Thorne.',
      on: { take: 'You’d rather leave it where it is. It’s a happy photograph, and it belongs on that desk.' }
    },
    note: {
      name: 'folded note', nouns: ['note', 'riddle', 'paper'], adj: ['folded', 'small'], loc: 'drawer',
      desc: function (g) { g.setFlag('readNote'); return 'A folded note in your aunt’s handwriting. It reads:\n\n' + objects.note.text; },
      text: '“For the vault, since I always forget the numbers and nobody would ever guess them:\n\nFirst, the moons of the little red one;\nthen the moons of the lord of the rings;\nthen the moons of the king with the great red spot;\nand last, the moons of the sea-blue wanderer at the edge of everything.\n\nCount them on Father’s orrery, not in some modern book — the modern books keep finding more. — O.”',
      on: { read: function (g) { g.setFlag('readNote'); return objects.note.text; } }
    },

    // --- the dining room, kitchen & larder ------------------------------------
    sideboard: {
      name: 'sideboard', nouns: ['sideboard', 'cupboard', 'buffet'], adj: ['mahogany', 'long'], loc: 'dining', scenery: true,
      container: true, openable: true, props: { open: false },
      desc: function (g) { return 'A long mahogany sideboard with brass handles. ' + (g.isOpen('sideboard') ? 'It is open.' : 'Its doors are closed.'); },
      on: { take: 'It’s the size of a small boat.' }
    },
    spoon: {
      name: 'silver spoon', nouns: ['spoon', 'teaspoon', 'cutlery'], adj: ['silver', 'heavy'], loc: 'sideboard', shiny: true,
      desc: 'A heavy silver teaspoon with a W on the handle. It shines in the light like a small mirror.'
    },
    waxfruit: {
      name: 'bowl of wax fruit', nouns: ['fruit', 'bowl', 'apple', 'apples', 'pear'], adj: ['wax'], loc: 'dining',
      initial: 'A [bowl of wax fruit|wax fruit] gathers dust on the sideboard.',
      desc: 'A bowl of wax fruit: apples, a pear and a bunch of grapes, all very slightly too shiny to be true.',
      on: { eat: 'You bite into a wax apple. It is wax. Your teeth will be telling stories about this for days.' }
    },
    range: {
      name: 'range', nouns: ['range', 'stove', 'oven', 'cooker'], adj: ['iron', 'black'], loc: 'kitchen', scenery: true,
      desc: 'A huge black iron range, stone cold. It has the brooding look of a machine that could roast an ox, given half a chance.',
      on: { open: 'You open the oven door: nothing but ash and an ancient, fossilised roast potato. You close it.', light: 'It would take an hour to get going and you have a comet to catch.', take: 'It weighs as much as a small car.' }
    },
    matches: {
      name: 'box of matches', ref: 'matches', nouns: ['matches', 'matchbox', 'box', 'match'], adj: ['match', 'safety'], loc: 'kitchen',
      initial: 'A [box of matches|matches] sits on the mantelpiece.',
      desc: 'A small box of safety matches, with a picture of a comet on the lid. (Your aunt clearly had a type.) It rattles encouragingly.',
      on: { light: 'You strike a match. It flares, hisses, and burns down towards your fingers while you admire it. You shake it out. (Try LIGHT something WITH the matches.)', open: 'Plenty of matches inside.', eat: 'No.' }
    },
    poker: {
      name: 'poker', nouns: ['poker', 'rod'], adj: ['iron', 'heavy', 'kitchen'], loc: 'kitchen',
      initial: 'An iron [poker] leans against the range.',
      desc: 'A heavy iron poker, as long as your arm, with a brass knob on the end.',
      on: {
        take: function (g) {
          if (g.loc('poker') !== 'sluice') return;
          g.move('poker', 'player');
          var t = closeSluiceNow(g, false);
          return 'You wrench the poker free. With nothing to stop it, the counterweight sinks and the sluice gate slams shut. The wheel slows to a halt.' + (t ? '' : '');
        },
        attack: 'You swish it about menacingly. The air retreats.'
      }
    },
    honey: {
      name: 'jar of honey', ref: 'honey', nouns: ['honey', 'jar'], adj: ['honey'], loc: 'larder',
      initial: 'A [jar of honey|honey] glows amber on one shelf.',
      desc: 'A jar of honey, dark amber and probably older than you. Honey never goes off, which you find obscurely comforting.',
      on: { eat: 'You dip a finger in. It is very old honey, which is to say it is perfect. Delicious.', open: 'The lid is stuck fast with old honey. You get a finger’s worth round the edge.' }
    },
    birdseed: {
      name: 'bag of birdseed', ref: 'birdseed', nouns: ['birdseed', 'seed', 'seeds', 'bag'], adj: ['bird', 'paper'], loc: 'larder',
      initial: 'A paper [bag of birdseed|birdseed] sits on the bottom shelf.',
      desc: 'A paper bag of birdseed, labelled in your aunt’s writing: ‘For Pim, who will not eat it.’',
      on: { eat: 'You crunch a sunflower seed. Not bad, actually.' }
    },
    sardines: {
      name: 'tin of sardines', ref: 'sardines', nouns: ['sardines', 'tin', 'fish', 'sardine'], adj: ['sardine'], loc: 'larder',
      initial: 'There is also a [tin of sardines|sardines].',
      desc: 'A tin of sardines. Not, you note with some relief, a red herring.',
      on: { eat: 'You’d need a tin opener, and frankly the will.', open: 'You’d need a tin opener, and frankly the will.' }
    },

    // --- the cellar & machinery ----------------------------------------------
    vaultdoor: {
      name: 'steel door', nouns: ['door', 'vault'], adj: ['steel', 'vault', 'heavy'], door: true, openable: true,
      props: { open: false, locked: true },
      desc: function (g) { return 'A heavy steel door set into the stone. ' + (g.isOpen('vaultdoor') ? 'It stands open.' : 'Above its handle are four brass [dials].'); },
      on: {
        open: function (g) { if (g.p('vaultdoor', 'locked')) return 'It doesn’t budge. The four brass [dials] above the handle suggest a combination.'; },
        unlock: 'It has no keyhole — only the four brass dials. (Try SET DIALS TO and a four-digit number.)',
        attack: 'It’s steel, and you are not.', knock: 'A dull, very solid *dunk*.',
        set: function (g, c) { return g.act('set', 'dials', null, c.topic); }
      }
    },
    dials: {
      name: 'brass dials', nouns: ['dials', 'dial', 'combination', 'lock', 'numbers'], adj: ['brass', 'four', 'combination'], loc: 'cellar', scenery: true, plural: true,
      props: { val: '0000' },
      desc: function (g) { return 'Four brass dials, each numbered 0 to 9, set in a row above the handle of the steel door. They read ' + g.p('dials', 'val').split('').join('-') + '.'; },
      on: {
        turn: function (g, c) { return c.topic ? g.act('set', 'dials', null, c.topic) : 'Turn them to what? Try SET DIALS TO and a four-digit number (for example, SET DIALS TO 1234).'; },
        set: function (g, c) {
          var digits = String(c.topic || '').replace(/\D/g, '');
          if (!digits) return 'Set them to what? They only take numbers: SET DIALS TO and four digits.';
          if (digits.length !== 4) return 'There are four dials, so you’ll want four digits.';
          g.set('dials', 'val', digits);
          if (digits === CODE) {
            if (!g.p('vaultdoor', 'locked')) return 'The dials are already set to ' + digits.split('').join('-') + ', and the door is open.';
            g.set('vaultdoor', 'locked', false);
            g.set('vaultdoor', 'open', true);
            g.award('vault', 8);
            return 'You turn the dials to 2-8-4-1. *Click. Click. Click. Click.* Then, from deep inside the door, a heavy *clunk* — and the steel door swings open on silent, oiled hinges. Your aunt, it seems, cared rather more for this lock than for the front door.';
          }
          return 'You turn the dials to ' + digits.split('').join('-') + ' and try the handle. Nothing.';
        },
        push: 'They turn rather than push. (Try SET DIALS TO and four digits.)'
      }
    },
    clutch: {
      name: 'clutch lever', nouns: ['lever', 'clutch'], adj: ['clutch', 'long', 'iron'], loc: 'gears', scenery: true, props: { engaged: false },
      desc: function (g) { return 'A long iron lever with a wooden grip, labelled CLUTCH. It is ' + (g.p('clutch', 'engaged') ? 'pulled down: ENGAGED.' : 'pushed up: DISENGAGED.'); },
      on: {
        pull: function (g) {
          if (g.p('clutch', 'engaged')) return 'It’s already engaged.';
          g.set('clutch', 'engaged', true);
          g.award('clutch', 2);
          return g.p('sluice', 'open')
            ? 'You haul the lever down. The clutch bites with a bang, the gears lurch, catch — and begin to turn with a deep, contented grinding. The great shaft spins up into the ceiling.'
            : 'You haul the lever down. With a clank, the clutch engages. Nothing turns — yet. The gears are connected to the wheel, but the wheel isn’t moving.';
        },
        push: function (g) { if (!g.p('clutch', 'engaged')) return 'It’s already disengaged.'; g.set('clutch', 'engaged', false); return 'You push the lever up. The clutch disengages with a clunk.' + (g.p('sluice', 'open') ? ' The gears grind to a halt.' : ''); },
        switchon: function (g) { return g.act('pull', 'clutch'); },
        switchoff: function (g) { return g.act('push', 'clutch'); },
        turn: 'It moves up and down, not round. (PULL it to engage, PUSH it to disengage.)'
      }
    },
    wheel: {
      name: 'water wheel', nouns: ['wheel', 'paddles', 'paddle', 'waterwheel'], adj: ['water', 'iron', 'great'], loc: 'wheelpit', scenery: true,
      desc: function (g) { return g.p('sluice', 'open') ? 'The great iron wheel turns steadily, water piling into its paddles and spilling out below.' : 'A great iron wheel with wooden paddles, hanging still in the dry channel. It needs water.'; },
      on: { turn: 'You lean on a paddle. The wheel considers you, and decides against it. It wants water, not you.', push: 'You lean on a paddle. The wheel considers you, and decides against it. It wants water, not you.', switchon: function (g) { return openSluice(g); }, enter: 'Being turned by a water wheel is not one of your ambitions.' }
    },
    sluice: {
      name: 'sluice gate', nouns: ['sluice', 'gate', 'guides'], adj: ['sluice', 'wooden'], loc: 'wheelpit', scenery: true, container: true, hideContents: true,
      props: { open: false, wedged: false },
      desc: function (g) { return 'A heavy wooden gate in iron guides, holding back the water from the tarn. ' + (g.p('sluice', 'open') ? 'It is raised, and water is pouring under it.' : 'It is shut.') + (g.p('sluice', 'wedged') ? ' ' + g.cap(g.a(g.loc('poker') === 'sluice' ? 'poker' : 'boathook')) + ' is jammed into its guides, holding it up.' : ''); },
      on: {
        open: function (g) { return openSluice(g); },
        pull: function (g) { return openSluice(g); },
        close: function (g) {
          if (!g.p('sluice', 'open')) return 'It’s already shut.';
          if (g.p('sluice', 'wedged')) return 'It’s wedged open. You’d have to take the wedge out first.';
          return closeSluiceNow(g, false);
        },
        push: function (g) { return g.act('close', 'sluice'); },
        wedge: function (g, c) { return wedgeSluice(g, c, c.i); },
        turn: function (g) { return openSluice(g); }
      },
      rcv: {
        putin: function (g, c) { return wedgeSluice(g, { v: 'wedge', d: 'sluice', i: c.d }, c.d); },
        puton: function (g, c) { return wedgeSluice(g, { v: 'wedge', d: 'sluice', i: c.d }, c.d); },
        use: function (g, c) { return wedgeSluice(g, { v: 'wedge', d: 'sluice', i: c.d }, c.d); }
      }
    },
    crank: {
      name: 'crank', nouns: ['crank', 'handle', 'winch'], adj: ['iron', 'sluice'], loc: 'wheelpit', scenery: true,
      desc: 'An iron crank on a winch, for raising the sluice gate.',
      on: { turn: function (g) { return openSluice(g); }, pull: function (g) { return openSluice(g); }, push: function (g) { return openSluice(g); } }
    },
    counterweight: {
      name: 'counterweight', nouns: ['counterweight', 'weight', 'chain'], adj: ['iron', 'heavy'], loc: 'wheelpit', scenery: true,
      desc: function (g) {
        if (g.p('sluice', 'wedged')) return 'The counterweight hangs halfway down its chain, held by the wedge in the gate’s guides. It isn’t going anywhere.';
        if (g.p('sluice', 'open')) return 'A great iron weight on a chain, sinking slowly. When it reaches the bottom, it will drag the sluice gate shut again — unless something stops the gate from closing.';
        return 'A great iron weight on a chain, resting at the bottom of its travel. It keeps the sluice gate shut.';
      },
      on: {
        take: 'It weighs about as much as a pony.', push: 'It swings ponderously and settles back.', pull: 'It swings ponderously and settles back.',
        wedge: function (g, c) { return wedgeSluice(g, { v: 'wedge', d: 'sluice', i: c.i }, c.i); }
      },
      rcv: { use: function (g, c) { return wedgeSluice(g, { v: 'wedge', d: 'sluice', i: c.d }, c.d); }, putin: function (g, c) { return wedgeSluice(g, { v: 'wedge', d: 'sluice', i: c.d }, c.d); } }
    },

    // --- the vault ------------------------------------------------------------
    eyepiece: {
      name: 'brass eyepiece', nouns: ['eyepiece', 'tube', 'socket'], adj: ['brass', 'telescope'], loc: 'vault', props: { lens: false },
      initial: 'On one shelf lies a brass [eyepiece], engraved GREAT REFRACTOR.',
      note: function (g) { return g.loc('eyepiece') === 'telescope' ? 'in the telescope' : ''; },
      desc: function (g) { return 'A brass eyepiece about the length of your hand, engraved GREAT REFRACTOR — W.V. ' + (g.p('eyepiece', 'lens') ? 'A clear glass lens sits snugly in its socket.' : 'The socket at its end is empty: the lens is missing.'); },
      on: { lookthrough: function (g) { return g.p('eyepiece', 'lens') ? 'Through the eyepiece alone, the world is a tiny upside-down blur. It needs the telescope.' : 'You look down an empty brass tube. Without its lens, it shows nothing but a small round view of the floor.'; } },
      rcv: {
        putin: function (g, c) { if (c.d === 'lens') return assembleEyepiece(g); },
        puton: function (g, c) { if (c.d === 'lens') return assembleEyepiece(g); },
        use: function (g, c) { if (c.d === 'lens') return assembleEyepiece(g); }
      }
    },
    windkey: {
      name: 'winding key', nouns: ['key', 'tag'], adj: ['winding', 'butterfly', 'clockwork'], loc: 'vault',
      initial: 'On another shelf lies a [winding key] with a handle shaped like a butterfly.',
      desc: 'A brass key with a butterfly-shaped handle, the kind for winding clockwork. A paper tag tied to it says, simply, ‘C.’'
    },

    // --- upstairs ---------------------------------------------------------------
    domedoor: {
      name: 'oak door', nouns: ['door'], adj: ['oak', 'narrow', 'dome', 'iron-banded', 'banded'], door: true, openable: true, lockable: true, key: 'domekey',
      props: { open: false, locked: true },
      desc: function (g) { return 'A narrow oak door, banded with iron, with a large keyhole. A small painted sign reads TO THE DOME. ' + (g.isOpen('domedoor') ? 'It is open.' : g.p('domedoor', 'locked') ? 'It is locked.' : 'It is closed.'); },
      on: { knock: 'Hollow echoes spiral away upwards.', attack: 'The door is oak and iron. You are neither.' }
    },
    bed: {
      name: 'brass bed', nouns: ['bed'], adj: ['brass', 'high'], loc: 'bedroom', scenery: true,
      desc: 'A high brass bed with a patchwork quilt, piled with pillows. It looks unbelievably comfortable, which is suspicious on a night like this.',
      on: {
        lieon: function (g) { g.confirm('The bed is high and soft, the quilt is heaped and inviting, and you are very, very tired. If you lie down now you’ll certainly sleep through the comet. Lie down anyway? (yes or no)', 'sleep'); return true; },
        enter: function (g) { return g.act('lieon', 'bed'); }, sit: 'You sit on the edge of the bed. It is dangerously comfortable. You stand up again before it’s too late.',
        lookunder: 'A pair of slippers and a dust bunny the size of a rabbit.'
      }
    },
    wardrobe: {
      name: 'wardrobe', nouns: ['wardrobe', 'closet', 'coats', 'clothes'], adj: ['tall', 'oak'], loc: 'bedroom', scenery: true, container: true, openable: true, props: { open: false },
      desc: function (g) { return 'A tall oak wardrobe' + (g.isOpen('wardrobe') ? ', open: inside hang tweed jackets, a sou’wester and one extraordinary hat with a pheasant feather. It all smells of lavender and adventure.' : ', closed.'); },
      on: { open: function (g, c) { if (g.isOpen('wardrobe')) return; g.dflt(c); return 'Inside hang tweed jackets, a sou’wester and one extraordinary hat with a pheasant feather. It all smells of lavender and adventure. Nothing you need tonight.'; }, enter: 'You step inside, among the coats. No snowy forest. Just more coats. You step out again.' }
    },
    basket: {
      name: 'sewing basket', nouns: ['basket'], adj: ['sewing', 'wicker'], loc: 'bedroom', container: true, fixed: true,
      initial: 'A wicker [sewing basket] sits on the window seat, its lid thrown back.',
      fixedMsg: 'You’d rather not carry the whole basket about. Anything you need from it, you can take.',
      desc: 'A wicker sewing basket full of reels, buttons and pins.'
    },
    thimble: {
      name: 'silver thimble', nouns: ['thimble'], adj: ['silver', 'shiny'], loc: 'basket', shiny: true,
      desc: 'A silver thimble, dimpled all over and polished bright by years of use. It gleams like a tiny moon.',
      on: { wear: 'You pop it on your finger. You feel ready to darn something. You take it off again.' }
    },
    magbook: {
      name: 'book on magpies', nouns: ['book', 'volume'], adj: ['magpie', 'magpies', 'slim'], loc: 'bedroom',
      initial: 'On the bedside table, on top of the pile, is a slim [book on magpies|magpie book].',
      desc: 'A slim volume titled ‘Magpies, and How to Bargain With Them’. (Try READ BOOK.)',
      text: '‘CHAPTER ONE. Never try to take from a magpie. Always offer. A magpie will part with anything for a fair trade — and silver is the coin of his realm. Gold he considers vulgar; glass he will give up only for something brighter.’'
    },
    copernicus: {
      name: 'Copernicus', proper: true, npc: true, gender: 'him', nouns: ['copernicus', 'owl', 'automaton', 'bird', 'talons', 'talon'], adj: ['clockwork', 'brass', 'mechanical'], loc: 'gallery',
      props: { wound: false },
      describe: function (g) { return g.p('copernicus', 'wound') ? '[Copernicus], the clockwork owl, ticks gently on his perch by the window, turning his head right round to keep you in view.' : 'On a brass perch by the window sits a clockwork [owl], silent and still, his glass eyes dull. In his talons he clutches a long [iron key].'; },
      desc: function (g) { return g.p('copernicus', 'wound') ? 'Copernicus’s brass feathers rise and fall as he ticks, and his eyes glow a soft amber. He watches you with polite interest.' : 'A clockwork owl of brass and copper, every feather separately engraved. A plate on his perch reads COPERNICUS. Between his shoulders is a small winding hole. His talons are locked shut around a long iron key.'; },
      talk: function (g) {
        if (!g.p('copernicus', 'wound')) return 'Copernicus says nothing. He is clockwork, and his clockwork has run down. There’s a winding hole between his shoulders.';
        return '“Ask me anything,” says Copernicus. “I am particularly good on [the comet>ask copernicus about comet], [the dome>ask copernicus about dome], [the telescope>ask copernicus about telescope], [the sluice>ask copernicus about sluice] and [that magpie>ask copernicus about pim].”';
      },
      topics: {
        'comet hesper tail': '“Hesper! Period eighty-one years, give or take a week. Tonight it hangs low in the north-east. To see it properly you must turn the dome to face north-east, open the shutter, and look through the Great Refractor — with an eyepiece, naturally. And focus. People forget to focus.”',
        'dome turn rotate bearing power machinery engine': '“The dome turns by water power,” he says proudly. “The tarn turns the wheel, the wheel turns the gears, the gears turn the dome. Open the sluice in the wheel pit, engage the clutch in the gear room, then set the bearing dial in the dome. And mind the counterweight.”',
        'counterweight sluice wheel water crank gate': '“The sluice has a counterweight that shuts it again after a few minutes — a precaution the old master fitted after an incident involving a flooded cellar and a very wet cat. He used to jam the gate open with the kitchen poker. Tut, tut.”',
        'clutch gears lever': '“The clutch lever is in the gear room, east of the cellar. Pull it down to engage.”',
        'shutter ivy roof track': '“The shutter lever is on the control stand in the dome. But the ivy has been at the track for years, I fear. Someone will have to go out on the roof walk with something sharp.”',
        'telescope refractor eyepiece lens glass focus': '“The Great Refractor! Nine inches of the finest glass. Its eyepiece is kept in the vault below — but the eyepiece’s little lens was stolen. By a magpie.” He says *magpie* the way other people say *mildew*.',
        'pim magpie thief nest attic bird': '“Pim,” says Copernicus, with deep disapproval. “A thief and a braggart. He lives in the attic, above this very gallery — through that hatch. He will not give anything back unless you give him something shinier. Silver, preferably. He has no taste, only greed.”',
        'hatch ladder ring ceiling': '“The attic hatch has an iron ring. The professor used a boathook to pull it down. She was not tall, the professor.”',
        'vault code combination dials numbers': '“The vault code? She never told me. She would mutter about moons when she set it. Moons, moons, moons.”',
        'professor ottoline aunt vane': '“She wound me every morning for sixty years and told me everything. Then her knees made the stairs difficult, and I ran down. I don’t hold it against her. I was very well looked after.”',
        'himself copernicus owl you yourself clockwork': '“I was made by Professor Wilhelm Vane, her father, to keep time and keep watch. I hoot the hours. I know two hundred and fourteen stars by name. I was considered a marvel in my day.” He pauses. “I still am.”',
        'logbook book log write': '“Write your observation in the logbook, in the dome. Every Vane has. It makes the night official.”',
        'key iron door dome-key stair': '“The iron key opens the narrow oak door on the landing, to the dome stair.”',
        'thorne mrs housekeeper': '“Mrs. Thorne dusts me on Thursdays. She is very thorough about the ears.”',
        'moonflower flower glasshouse': '“The moonflower blooms if it is watered on a comet night. Botany is not my field. I am an owl.”',
        'winding wind butterfly': '“Seven turns, if you please. Not eight. Eight tickles.”',
        'time clock hour dawn': function (g) { return 'Copernicus hoots softly, consulting his insides. “It is ' + g.clock() + '. Hesper fades at dawn: six o’clock. Plenty of time, if you are sensible. Most people are not.”'; },
        'stars star sky': '“Two hundred and fourteen,” says Copernicus. “Would you like me to name them? No? Most people say no.”'
      },
      dflt: 'Copernicus tilts his head through a full circle and back. “I have no data on that. Ask me about the comet, the dome, the telescope, or that wretched magpie.”',
      on: {
        wind: windOwl,
        take: 'He is bolted to his perch, and has his dignity besides.',
        ask: function (g) { if (!g.p('copernicus', 'wound')) return 'Copernicus says nothing. His clockwork has run down. There’s a winding hole between his shoulders.'; },
        tell: function (g) { if (!g.p('copernicus', 'wound')) return 'Copernicus says nothing. His clockwork has run down.'; },
        turn: function (g) { return g.has('windkey') ? windOwl(g, { i: 'windkey' }) : 'You turn his head gently. It goes all the way round, which is unsettling, and back.'; },
        wake: function (g) { return g.p('copernicus', 'wound') ? '“I am awake,” says Copernicus, a little stiffly.' : 'He’s clockwork. He needs winding, not waking.'; },
        attack: 'You raise a hand against an antique clockwork owl, and then lower it, ashamed.',
        touch: 'Cold brass feathers, each one engraved by hand.'
      },
      rcv: {
        putin: function (g, c) { if (c.d === 'windkey') return windOwl(g, { i: 'windkey' }); },
        use: function (g, c) { if (c.d === 'windkey') return windOwl(g, { i: 'windkey' }); },
        give: function (g, c) { if (c.d === 'windkey') return windOwl(g, { i: 'windkey' }); return g.p('copernicus', 'wound') ? '“Thank you, but I have no pockets,” says Copernicus.' : 'Copernicus doesn’t react. He’s run down.'; },
        show: function (g, c) { return g.p('copernicus', 'wound') ? 'Copernicus examines ' + g.the(c.d) + ' with a whirr of lenses. “Fascinating,” he says, unconvincingly.' : 'Copernicus doesn’t react. He’s run down.'; }
      }
    },
    domekey: {
      name: 'iron key', nouns: ['key'], adj: ['iron', 'long', 'heavy', 'dome'], loc: 'copernicus',
      desc: 'A long iron key, heavy as a spanner, with a bow shaped like a crescent moon.',
      on: { take: function (g) { if (g.loc('domekey') === 'copernicus') return 'His talons are locked tight around it. Clockwork is stubborn when it has stopped.'; } }
    },
    hatch: {
      name: 'hatch', nouns: ['hatch', 'trapdoor', 'ring'], adj: ['square', 'attic', 'iron'], loc: 'gallery', scenery: true, props: { down: false },
      desc: function (g) { return g.p('hatch', 'down') ? 'The hatch hangs open, and a folding ladder reaches down from it to the floor.' : 'A square hatch in the ceiling, high above you, with an iron ring set into it. Far out of reach.'; },
      on: {
        open: function (g) { return pullHatch(g); }, pull: function (g) { return pullHatch(g); },
        unlock: function (g, c) { return c.i && c.i !== 'boathook' ? 'That won’t reach.' : pullHatch(g); },
        push: function (g) { return pullHatch(g); }, climb: function (g) { return g.p('hatch', 'down') ? (g.go('u'), true) : pullHatch(g); },
        close: 'You’d never get it open again without a fight. Leave it.', enter: function (g) { return g.p('hatch', 'down') ? (g.go('u'), true) : 'It’s far out of reach.'; }
      },
      rcv: { use: function (g, c) { return c.d === 'boathook' ? pullHatch(g) : 'That won’t reach.'; } }
    },
    ladder: {
      name: 'folding ladder', nouns: ['ladder'], adj: ['folding', 'wooden', 'attic'], loc: null, scenery: true,
      desc: 'A folding wooden ladder, reaching from the floor up into the attic.',
      climb: 'u', on: { take: 'It’s attached to the hatch.' }
    },
    pim: {
      name: 'Pim', proper: true, npc: true, gender: 'him', nouns: ['pim', 'magpie', 'bird'], adj: ['magpie'], loc: 'attic', props: { traded: false },
      describe: function (g) { return g.p('pim', 'traded') ? '[Pim] fusses over his new treasure in the nest, ignoring you magnificently.' : '[Pim] the magpie stands guard on the nest, black and white and glossy blue, watching you with one bright, calculating eye.'; },
      desc: 'A magpie of great size and greater self-regard, with a tail like a fan of black silk and a beak that has opened many things it shouldn’t have. He watches you the way a shopkeeper watches someone near the expensive vases.',
      talk: function (g) { return pimLine(g); },
      topics: {},
      dflt: function (g) { return pimLine(g); },
      rcv: {
        give: tradePim,
        show: function (g, c) { return SHINY[c.d] ? 'Pim’s eyes fix on ' + g.the(c.d) + ' and don’t let go. He shuffles his feathers. He wants it — but he wants it *given*, not waved about.' : 'Pim gives ' + g.the(c.d) + ' a bored look. It doesn’t shine.'; },
        throwat: function (g, c) { return SHINY[c.d] ? tradePim(g, c) : 'Pim dodges with contemptuous ease.'; }
      },
      on: {
        take: 'You reach for Pim. Pim reaches for you, beak first. You withdraw.',
        attack: 'Pim is a bird of strong opinions and a sharp beak, and this is his attic. You would lose. Better to bargain.',
        touch: 'Pim allows one finger to approach, then pecks it with great precision. Message received.',
        feed: function (g, c) { return tradePim(g, { d: c.i || 'birdseed' }); }
      }
    },
    nest: {
      name: 'nest', nouns: ['nest'], adj: ['untidy', 'enormous', 'magpie'], loc: 'attic', scenery: true, container: true,
      props: { open: true },
      desc: 'A heap of twigs, string and stolen treasure: [bottle tops], a bent fork, a doorknob, sweet wrappers, a bicycle bell, and things that were once somebody’s buttons.',
      on: { take: 'Pim would have something to say about that. Quite a lot, at volume.', search: function (g) { return g.dflt({ v: 'search', d: 'nest' }); } }
    },
    junk: {
      name: 'bottle tops', nouns: ['tops', 'junk', 'treasure', 'fork', 'doorknob', 'wrappers', 'bell', 'buttons', 'trinkets'], adj: ['bottle', 'bent', 'bicycle', 'stolen'], loc: 'nest', scenery: true, plural: true,
      desc: 'Bottle tops, a bent fork, a doorknob, a bicycle bell and assorted buttons — including, you suspect, the scarecrow’s.',
      on: { take: 'You don’t want any of that. Pim very much does.' }
    },
    lens: {
      name: 'glass lens', nouns: ['lens', 'glass', 'disc', 'disk'], adj: ['glass', 'round', 'small', 'eyepiece'], loc: 'nest',
      desc: 'A disc of perfect glass the size of a large coin, thick in the middle and thin at the edge. If ever there was an eyepiece lens, this is it.',
      on: {
        take: function (g) {
          if (g.p('pim', 'traded') || g.loc('lens') !== 'nest') return;
          return 'You reach towards the nest. Pim explodes into a shrieking, flapping fury of black and white, and you snatch your hand back with all its fingers — just. Pim settles, glaring. Perhaps a trade would go better.';
        },
        lookthrough: 'The attic swims, upside down and enormous. It is definitely a lens.'
      }
    },

    // --- the dome -------------------------------------------------------------
    telescope: {
      name: 'Great Refractor', nouns: ['telescope', 'refractor', 'scope', 'holder'], adj: ['great', 'brass', 'eyepiece'], loc: 'dome', scenery: true, container: true, hideContents: true,
      props: { open: true, focused: false },
      desc: function (g) {
        return 'The Great Refractor: a brass tube as long as a rowing boat, mounted on an iron pier with clockwork and counterweights, all dark with age but sound. ' +
          (g.loc('eyepiece') === 'telescope' ? 'The eyepiece is fitted in its holder at the lower end' + (g.p('eyepiece', 'lens') ? '' : ' (though it has no lens)') + '.' : 'At its lower end is an empty eyepiece holder.') +
          ' Beside the holder is a [focus knob].';
      },
      on: {
        lookthrough: lookThrough, search: lookThrough, use: function (g, c) { return c.i ? undefined : lookThrough(g); },
        focus: function (g) { return focusKnob(g); },
        set: function (g, c) { return g.act('set', 'bearingdial', null, c.topic); },
        turn: function (g, c) { return c.topic ? g.act('set', 'bearingdial', null, c.topic) : 'The telescope follows the sky on its own clockwork. It’s the dome you need to turn — with the bearing dial.'; },
        push: 'The telescope swings smoothly, but it can only look where the dome’s shutter lets it. It’s the dome you need to turn.',
        take: 'It weighs about a ton and is bolted to the bedrock.',
        attack: 'Never.'
      },
      rcv: { putin: fitEyepiece, puton: fitEyepiece, use: function (g, c) { if (c.d === 'eyepiece') return fitEyepiece(g, c); } }
    },
    knob: {
      name: 'focus knob', nouns: ['knob', 'focus'], adj: ['focus', 'focusing', 'brass'], loc: 'dome', scenery: true,
      desc: 'A knurled brass knob that slides the eyepiece holder in and out to bring things into focus.',
      on: { turn: function (g) { return focusKnob(g); }, focus: function (g) { return focusKnob(g); }, push: function (g) { return focusKnob(g); }, pull: function (g) { return focusKnob(g); }, set: function (g) { return focusKnob(g); } }
    },
    bearingdial: {
      name: 'bearing dial', nouns: ['dial', 'pointer', 'bearing'], adj: ['bearing', 'brass', 'compass', 'dome'], loc: 'dome', scenery: true, props: { bearing: 's' },
      desc: function (g) { return 'A brass dial marked with the eight points of the compass. Its pointer shows ' + BEARINGS[g.p('bearingdial', 'bearing')].toUpperCase() + '. Turning it turns the dome — when the dome has power to turn.'; },
      on: {
        set: setBearing,
        turn: function (g, c) { return c.topic ? setBearing(g, c) : 'Turn it to which direction? (For example: TURN DIAL TO NORTH-EAST.)'; },
        push: 'It turns rather than pushes. (Try TURN DIAL TO NORTH-EAST, or another direction.)'
      }
    },
    shutterlever: {
      name: 'shutter lever', nouns: ['lever'], adj: ['shutter', 'brass'], loc: 'dome', scenery: true,
      desc: function (g) { return 'A brass lever on the control stand, marked SHUTTER, currently ' + (g.p('shutter', 'open') ? 'pulled down: OPEN.' : 'pushed up: CLOSED.'); },
      on: { pull: pullShutter, push: closeShutter, switchon: pullShutter, switchoff: closeShutter, turn: 'It goes up and down, not round. PULL it to open the shutter, PUSH it to close.' }
    },
    shutter: {
      name: 'shutter', nouns: ['shutter', 'slit', 'slot'], adj: ['dome'], loc: 'dome', scenery: true, props: { open: false },
      desc: function (g) { return g.p('shutter', 'open') ? 'The shutter is open: a long slice of night sky, thick with stars, runs from the rim of the dome to the top.' : 'A long curved shutter in the dome, closed. It is worked by the lever on the control stand.'; },
      on: { open: pullShutter, close: closeShutter, pull: pullShutter, push: 'It’s far overhead. The shutter lever on the control stand works it.', lookthrough: function (g) { return g.p('shutter', 'open') ? 'Stars, and the cold. The telescope would show you more.' : 'It’s closed.'; } }
    },
    logbook: {
      name: 'logbook', nouns: ['logbook', 'log', 'book', 'page'], adj: ['observing', 'open'], loc: 'dome', scenery: true,
      desc: 'A huge leather-bound logbook lying open on the lectern, with a pencil tied to it on a string. (Try READ LOGBOOK.)',
      text: 'The logbook goes back more than a hundred years, in three handwritings. Your great-great-grandfather’s tidy copperplate: rain, cloud, ‘Jupiter, very fine’. Eighty-one years ago, a page in a child’s careful capitals: ‘SAW HESPER. IT IS THE MOST BEAUTIFUL THING THERE IS. I AM NINE. — O.V.’ Then decades of your aunt’s spiky hand. The last entry reads: ‘Tonight Hesper returns. I shan’t be here; someone else will. Write it down, my dear, whatever you see. — O.V.’\n\nBelow that, the page is empty.',
      on: { write: writeLog, take: 'It’s chained to the lectern, and it is an heirloom besides. It stays here.', close: 'You’d lose the page. Leave it open.' }
    },
    pencil: {
      name: 'pencil', nouns: ['pencil', 'string'], adj: ['stub'], loc: 'dome', scenery: true,
      desc: 'A stub of pencil on a length of string, for writing in the logbook.',
      on: { take: 'It’s tied to the lectern so that nobody can walk off with it. Your aunt knew her visitors. You can still WRITE IN LOGBOOK with it.', write: function (g, c) { return writeLog(g, c); } }
    },
    roofdoor: {
      name: 'roof door', nouns: ['door'], adj: ['low', 'roof', 'small'], door: true, openable: true, props: { open: false },
      desc: 'A low wooden door in the drum of the dome, leading out onto the roof walk.'
    },
    ivy: {
      name: 'ivy', nouns: ['ivy', 'leaves', 'stems', 'creeper'], adj: ['thick', 'dark'], loc: 'roof', scenery: true, props: { cut: false },
      desc: function (g) { return g.p('ivy', 'cut') ? 'Clippings, mostly. The ivy will be back, but not tonight.' : 'Ivy as thick as rope, wound through and through the shutter track. Its stems are woody and tough; you’d never tear it free by hand.'; },
      on: {
        cut: function (g, c) {
          if (g.p('ivy', 'cut')) return 'There’s nothing left to cut.';
          var t = c.i || (g.here('secateurs') ? 'secateurs' : '');
          if (!t) return 'Your fingers are no match for it. You need something sharp.';
          if (t !== 'secateurs') return g.cap(g.the(t)) + ' won’t cut ivy.';
          if (!g.ensureHeld('secateurs')) return true;
          g.set('ivy', 'cut', true);
          g.award('ivy', 4);
          return 'You set to work with the secateurs, snipping and tugging, until a great tangled heap of ivy lies at your feet and the shutter track is clear from end to end. Something small and many-legged leaves in a hurry.';
        },
        pull: function (g) { return g.p('ivy', 'cut') ? 'There’s nothing left to pull.' : 'You tug at the ivy. It tugs back. The stems are woody and tough; you need something sharp.'; },
        take: function (g) { return g.p('ivy', 'cut') ? 'You don’t need the clippings.' : 'It’s rooted in the wall and wound through the track. You need something sharp.'; },
        attack: function (g) { return g.p('ivy', 'cut') ? 'You’ve won.' : 'You need something sharp, not something angry.'; }
      },
      rcv: { use: function (g, c) { return c.d === 'secateurs' ? g.act('cut', 'ivy', 'secateurs') : undefined; } }
    }
  };

  function thorneLetter(g) {
    if (g.loc('gatekey') !== 'thorne') return '“I’ve read it, dear,” says Mrs. Thorne. “Lovely letter.”';
    g.move('gatekey', 'player');
    g.set('gatekey', 'moved', true);
    g.setFlag('gotKey');
    g.award('key', 5);
    return 'Mrs. Thorne takes the letter, holds it at arm’s length, reads it twice, and sniffs in a way that manages to be fond. “That’s her hand, all right. ‘Mind the magpie.’ Ha!” She unhooks a big [gate key] from her belt and gives it to you, along with the letter. “Go on, then. And don’t let her down.”';
  }

  function thorneBloom(g) {
    if (!g.ensureHeld('bloom')) return true;
    g.move('bloom', 'thorne');
    g.setFlag('gaveBloom');
    g.award('bloom', 2);
    return 'Mrs. Thorne’s needles stop. She takes the bloom and holds it under her nose for a long moment.\n\n“The night her father showed her that comet,” she says quietly, “Ottoline came down from the dome with one of these in her hair, and told me — I was the cook’s girl then, and eight — that one day she’d show me a comet too.” She tucks the flower into her buttonhole. “Well. Here’s the flower, anyway. Thank you, dear. Now off you go — that comet won’t wait.”';
  }

  var PIM_LINES = [
    'Pim cocks his head and says, in a perfect imitation of your aunt: “Mind the step!” Then he laughs, in Mrs. Thorne’s voice.',
    '“Shiny?” says Pim hopefully, in no voice in particular.',
    'Pim makes the noise of a kettle coming to the boil, then looks smug.',
    '“Who — who — WHO?” says Pim, in a wicked imitation of a certain clockwork owl.',
    '“Fair’s fair,” says Pim, in what is unmistakably your aunt’s voice. Then, in his own: “Shiny.”'
  ];
  function pimLine(g) { return g.cycle('pim', PIM_LINES); }

  // ---------------------------------------------------------------------------
  // Timers, per-turn events, confirmations
  // ---------------------------------------------------------------------------
  var timers = {
    sluice: function (g) { if (g.p('sluice', 'open') && !g.p('sluice', 'wedged')) { var t = closeSluiceNow(g, true); if (t) g.say(t); } }
  };

  function everyTurn(g) {
    var m = g.moves(), r = g.room();
    if (g.p('sluice', 'open') && !g.p('sluice', 'wedged') && r === 'wheelpit' && g.timerLeft('sluice') === 2) g.say('The [counterweight] is sinking steadily. When it reaches the bottom, it will drag the sluice gate shut again.');
    if (m % 60 === 0 && m > 0) {
      var hour = g.clock().replace(/:00/, '');
      if (r === 'hall') g.say('The grandfather clock clears its throat and strikes ' + hour + '.');
      else if (r === 'gallery' && g.p('copernicus', 'wound')) g.say('Copernicus hoots the hour: ' + hour + '.');
    }
    if (m === 480) g.say('Somewhere outside, a blackbird tries out a note, decides it’s far too early, and stops. It is four o’clock.');
    if (m === 540) g.say('Five o’clock. The sky in the east has begun, very faintly, to pale. Dawn is coming.');
    if (m === 580) g.say('Grey light is creeping into the sky. Hesper won’t last much longer.');
  }

  var confirms = {
    sleep: function (g) { g.end('slept'); }
  };

  // ---------------------------------------------------------------------------
  // Endings
  // ---------------------------------------------------------------------------
  var endings = {
    best: {
      title: 'Hesper, recorded',
      text: function (g) {
        var mine = g.flag('logText');
        var line = mine ? '‘' + mine + '’' : '‘Hesper, seen at last. Two tails, blue and gold. Worth every hill.’';
        var t = 'You take the pencil on its string, smooth the empty page, and write the date. Then, underneath:\n\n' + line +
          '\n\nYour handwriting looks small and new below a century of Vanes. It looks, you think, as if it belongs.\n\nAs you close the cover, an envelope slides out from the back of the logbook, addressed in spiky handwriting: *To whoever wrote in the book tonight.*\n\n“So you did it. Of course you did. Wrenhallow is yours now — the dome, the owl, the magpie (sorry), the moonflower, and every stuck door in the place. Keep the lens clean and the logbook going. Hesper will be back in eighty-one years. Be here, if you can; and if you can’t, make sure somebody is.\n\nAll my love, from somewhere on the Southern Ocean, looking at the same comet — Ottoline.”';
        if (g.flag('gaveBloom')) t += '\n\nFar below, a light still burns in the gatehouse window. You suspect Mrs. Thorne is sitting up with a moonflower in her buttonhole, watching the sky.';
        if (g.p('copernicus', 'wound')) t += ' From the gallery, faintly, Copernicus hoots the hour.';
        t += '\n\nAbove the open shutter, Hesper sails on, unhurried, towards the morning.';
        return t;
      }
    },
    dawn: {
      title: 'Dawn',
      text: function (g) {
        if (g.flag('seenScope')) return 'Grey light seeps into the sky, and Hesper fades into it like a word on the tip of your tongue. You watched it through the Great Refractor for as long as it lasted — but the page in the logbook is still empty. Some things, perhaps, you keep to yourself. Still, you can’t help feeling your aunt would have liked it written down.';
        if (g.flag('seenNaked')) return 'Dawn comes up pale and cold over the hills, and Hesper fades into it like a thought you forgot to finish. You saw it, at least, with your own eyes: a faint smudge, low in the north-east. That isn’t nothing. But somewhere on the Southern Ocean, an old astronomer will be wondering what the Great Refractor showed you.';
        return 'Dawn comes up pale and cold over the hills. Somewhere above them, unseen, Hesper slips away into the morning light, not to return for eighty-one years.';
      }
    },
    slept: {
      title: 'Fast asleep',
      text: 'You lie down “just for a minute”. The quilt is warm and smells of lavender, the pillows are a cloud, and the house creaks a lullaby...\n\nYou wake to sunshine, birdsong, and Mrs. Thorne at the door with a cup of tea. “Well?” she says. “Did you see it?”\n\nYou did not. Hesper has gone, and won’t be back for eighty-one years. Mrs. Thorne pats your hand. “Never mind, dear. There’s always next time.”\n\nThere is, technically.'
    }
  };

  // ---------------------------------------------------------------------------
  // Hints: per puzzle, graduated. `avail` = the player could be working on it
  // now; `done` = solved. HINT picks an unsolved, available puzzle (one tied
  // to the current room first) and reveals one more line each time.
  // ---------------------------------------------------------------------------
  var puzzles = [
    { id: 'gate', title: 'Getting through the gates', rooms: ['lane', 'cottage'],
      done: function (g) { return g.flag('gotKey') || !g.p('gates', 'locked'); }, avail: function () { return true; },
      hints: ['The gates are locked. Somebody close by must have the key.', 'There’s a lit window in the gatehouse, west of the lane. Go and talk to whoever is inside.', 'Mrs. Thorne wants proof of who you are: SHOW LETTER TO THORNE. Then go back east and NORTH through the gates.'] },
    { id: 'door', title: 'The front door', rooms: ['porch'],
      done: function (g) { return !g.p('frontdoor', 'stuck'); }, avail: function (g) { return g.visited('porch'); },
      hints: ['The door isn’t locked. What else keeps a door shut in an old, damp house?', 'It’s swollen in its frame. Turning the handle politely won’t do it.', 'PUSH DOOR (or SHOVE it).'] },
    { id: 'light', title: 'A light for the dark', rooms: ['cellar', 'boathouse', 'kitchen', 'shed', 'attic', 'gears', 'wheelpit', 'vault'],
      done: function (g) { return g.flag('litOnce'); }, avail: function (g) { return g.visited('hall') || g.visited('boathouse') || g.visited('cellar'); },
      hints: ['Some parts of the house are pitch dark. You’ll want a light you can carry.', 'There’s a lantern in the boathouse (east of the lane, by the tarn). It needs oil — try the potting shed — and a flame: the kitchen mantelpiece.', 'FILL LANTERN WITH OIL, then LIGHT LANTERN WITH MATCHES.'] },
    { id: 'bolt', title: 'The cellar door', rooms: ['hall'],
      done: function (g) { return !g.p('cellardoor', 'bolted'); }, avail: function (g) { return g.visited('hall'); },
      hints: ['The cellar door isn’t locked, just bolted — and the bolt has rusted solid.', 'What loosens rust? Something slippery from the potting shed.', 'OIL BOLT (holding the oil can), then PULL BOLT and OPEN CELLAR DOOR.'] },
    { id: 'drawer', title: 'The locked drawer', rooms: ['study', 'library'],
      done: function (g) { return !g.p('drawer', 'locked'); }, avail: function (g) { return g.visited('study'); },
      hints: ['The desk drawer needs a small key. Your aunt liked to hide things in astronomical places.', 'Have a closer look at the celestial globe in the library. Give it a spin.', 'OPEN GLOBE and take the small brass key, then UNLOCK DRAWER WITH SMALL KEY and OPEN DRAWER.'] },
    { id: 'vault', title: 'The vault combination', rooms: ['cellar', 'folly', 'study'],
      done: function (g) { return !g.p('vaultdoor', 'locked'); }, avail: function (g) { return g.visited('cellar') || g.flag('readNote'); },
      hints: function (g) {
        if (!g.flag('readNote')) return ['The steel door in the cellar needs a four-digit combination. Your aunt wrote it down — somewhere locked away, probably.', 'Look for a note in the desk drawer in the study.', 'Unlock the drawer (the key is in the library’s celestial globe) and READ NOTE.'];
        return ['The note talks about four planets and their moons. Where on the estate could you count a planet’s moons?', 'The orrery in the folly, at the end of the yew walk, shows every moon known when it was made. Examine Mars, Saturn, Jupiter and Neptune.', 'Mars has 2, Saturn 8, Jupiter 4 and Neptune 1. SET DIALS TO 2841.'];
      } },
    { id: 'owl', title: 'The clockwork owl', rooms: ['gallery'],
      done: function (g) { return g.p('copernicus', 'wound'); }, avail: function (g) { return g.visited('gallery'); },
      hints: ['The owl in the gallery is clockwork, and run down. Clockwork needs winding.', 'A winding key is kept somewhere very safe — somewhere with a combination.', 'Get the winding key from the vault in the cellar, then WIND OWL WITH KEY.'] },
    { id: 'hatch', title: 'The attic hatch', rooms: ['gallery'],
      done: function (g) { return g.p('hatch', 'down'); }, avail: function (g) { return g.visited('gallery'); },
      hints: ['The hatch in the gallery ceiling is far out of reach. You need something long.', 'Something long, with a hook on the end, from somewhere near water.', 'Bring the boathook from the boathouse and PULL HATCH WITH BOATHOOK.'] },
    { id: 'lens', title: 'The missing lens', rooms: ['attic', 'bedroom', 'dining'],
      done: function (g) { return g.p('pim', 'traded'); }, avail: function (g) { return g.visited('attic') || g.has('eyepiece'); },
      hints: ['The eyepiece is missing its lens, and a notorious thief lives in the attic.', 'Pim the magpie won’t let you take anything, but he respects a fair trade. What does a magpie value most?', 'Something silver: the thimble in the bedroom’s sewing basket, or the spoon in the dining-room sideboard. GIVE THIMBLE TO PIM.'] },
    { id: 'eyepiece', title: 'Mending the eyepiece', rooms: [],
      done: function (g) { return g.p('eyepiece', 'lens'); }, avail: function (g) { return g.p('pim', 'traded') && g.visited('vault'); },
      hints: ['You have a lens, and somewhere there is an eyepiece with an empty socket.', 'PUT LENS IN EYEPIECE.'] },
    { id: 'domedoor', title: 'The door to the dome', rooms: ['landing'],
      done: function (g) { return g.visited('dome'); }, avail: function (g) { return g.visited('landing'); },
      hints: ['The narrow oak door on the landing is locked. Its key is being looked after by someone who can’t let go of it.', 'The clockwork owl in the gallery is clutching an iron key. Wake him up.', 'Wind Copernicus, take the iron key, then go NORTH from the landing (you’ll unlock the door on the way).'] },
    { id: 'power', title: 'Turning the dome', rooms: ['dome', 'wheelpit', 'gears'],
      done: function (g) { return g.p('bearingdial', 'bearing') === 'ne'; }, avail: function (g) { return g.visited('dome'); },
      hints: function (g) {
        var h = ['The dome won’t turn by hand: it used to run on some kind of power. There’s a book about it in the library.'];
        if (!g.p('sluice', 'open') && !g.p('sluice', 'wedged')) h.push('Water from the tarn drives a wheel under the house. In the wheel pit, north of the cellar, TURN CRANK to open the sluice.');
        if (!g.p('sluice', 'wedged')) h.push('The counterweight shuts the sluice again after a few minutes — far too soon to climb up to the dome. Wedge it open while it’s up: WEDGE SLUICE WITH POKER (the poker is in the kitchen).');
        if (!g.p('clutch', 'engaged')) h.push('In the gear room, east of the cellar, PULL LEVER to engage the clutch.');
        h.push('With the wheel turning and the clutch engaged, go up to the dome and TURN DIAL TO NORTH-EAST — the almanac says that’s where Hesper is.');
        return h;
      } },
    { id: 'shutter', title: 'The stuck shutter', rooms: ['dome', 'roof'],
      done: function (g) { return g.p('shutter', 'open'); }, avail: function (g) { return g.visited('dome'); },
      hints: ['Try the shutter lever on the control stand and see what happens.', 'Something outside is jamming the shutter’s track. The roof walk is through the low door.', 'Bring the secateurs from the potting shed: CUT IVY WITH SECATEURS on the roof walk, then PULL SHUTTER LEVER in the dome.'] },
    { id: 'scope', title: 'Seeing the comet', rooms: ['dome'],
      done: function (g) { return g.flag('seenScope'); }, avail: function (g) { return g.visited('dome'); },
      hints: ['The Great Refractor needs its eyepiece — complete with lens — before it will show you anything.', 'The dome must face north-east and the shutter must be open. Then fit the eyepiece, and focus.', 'PUT EYEPIECE IN TELESCOPE, TURN FOCUS KNOB, then LOOK THROUGH TELESCOPE.'] },
    { id: 'logbook', title: 'Making it official', rooms: ['dome'],
      done: function (g) { return !!g.ended(); }, avail: function (g) { return g.flag('seenScope'); },
      hints: ['Your aunt’s letter said what to do after you’d seen the comet.', 'WRITE IN LOGBOOK. (You can say what you saw, too: WRITE "Two tails, blue and gold" IN LOGBOOK.)'] },
    { id: 'flower', title: 'The moonflower (optional)', optional: true, rooms: ['glasshouse', 'garden'],
      done: function (g) { return g.p('moonflower', 'bloomed'); }, avail: function (g) { return g.visited('glasshouse'); },
      hints: ['The moonflower in the glasshouse looks very thirsty.', 'There’s a watering can in the glasshouse, and a rain butt in the walled garden.', 'FILL WATERING CAN at the rain butt, then WATER MOONFLOWER.'] },
    { id: 'bloom', title: 'A flower for a friend (optional)', optional: true, rooms: ['glasshouse', 'cottage'],
      done: function (g) { return g.flag('gaveBloom'); }, avail: function (g) { return g.p('moonflower', 'bloomed'); },
      hints: ['Someone would dearly love to see one of those flowers again.', 'Ask Mrs. Thorne about the moonflower.', 'PICK BLOOM, take it to the gatehouse, and GIVE BLOOM TO THORNE.'] }
  ];

  var ranks = [
    [0, 'Lost Cyclist'], [10, 'Curious Visitor'], [25, 'Garden Wanderer'], [40, 'Lamplighter'],
    [55, 'Clockwork Mechanic'], [70, 'Keeper of the Dome'], [85, 'Assistant Astronomer'],
    [95, 'Comet Watcher'], [100, 'Astronomer of Wrenhallow']
  ];

  return {
    meta: {
      id: 'wrenhallow', version: 1,
      title: 'The Comet at Wrenhallow', subtitle: 'An interactive fiction',
      start: 'lane', startMinutes: 20 * 60, dawn: 600, maxScore: 100
    },
    intro: 'The last six miles were all uphill. Every single one of them.\n\nYour great-aunt Ottoline — astronomer, eccentric, and for ninety years the most interesting person in any room — has gone to sea, leaving you a letter, an observatory, and a puzzle. Tonight the comet Hesper returns for the first time in eighty-one years. By dawn it will be gone again.\n\nThe sun has just slipped behind the hills.',
    help: 'You play by typing short commands, like GO NORTH, TAKE LANTERN or OPEN THE DOOR, and the story tells you what happens.\n\n*Moving:* NORTH, SOUTH, EAST, WEST, NE, NW, SE, SW, UP, DOWN, IN, OUT (or just N, S, E, W, U, D).\n*Looking:* LOOK (L), EXAMINE (X) something, READ, SEARCH, LOOK UNDER, LOOK THROUGH.\n*Things:* TAKE, DROP, PUT X IN Y, OPEN, CLOSE, UNLOCK X WITH Y, PUSH, PULL, TURN, LIGHT, FILL, GIVE X TO Y, SHOW X TO Y — and others you’ll guess.\n*People:* TALK TO someone, ASK someone ABOUT something, TELL someone ABOUT something.\n*Shortcuts:* I (inventory), Z (wait), G (again), IT for the last thing you mentioned, ALL / ALL EXCEPT X.\n*The game:* UNDO, SAVE name, RESTORE name, RESTART, SCORE, HINT, VERBOSE / BRIEF, TIME.\n\nTap highlighted words to examine them, tap exits to walk, and use the compass pad and verb buttons if you’d rather not type. Everything saves itself as you go.',
    about: '*The Comet at Wrenhallow* — an original interactive fiction written for Cade.txt. One night, twenty-nine locations, a few friends, and a comet. Hommage to the parser games of the 1980s, minus the grues.',
    rooms: rooms, objects: objects, timers: timers, everyTurn: everyTurn, confirms: confirms,
    endings: endings, puzzles: puzzles, ranks: ranks
  };
})();
