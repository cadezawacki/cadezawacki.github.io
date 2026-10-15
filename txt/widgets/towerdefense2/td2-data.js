/* Tower Defense V2 (Glyph Defense) — the catalog: 74 enemies (10 of them bosses), 40 towers, the
 * per-map rules (levels, enemy pools, bosses, traits, catalogs, unlocks) and the
 * Armory perks. Pure data, shared by td2-engine.js, td2.js and the node tests.
 * Numbers follow the Glyph Defense design workbook (prototype v0.1); a few
 * mechanics are streamlined so every one can be shown and read in play. */
(function (root) {
  'use strict';

  // ---------------- damage types ----------------
  // index order is used in typed arrays: phys fire frost shock acid sonic arcane
  var DT = ['phys', 'fire', 'frost', 'shock', 'acid', 'sonic', 'arcane'];
  var DT_NAME = ['Physical', 'Fire', 'Frost', 'Shock', 'Acid', 'Sonic', 'Arcane'];
  var DTI = {}; for (var di = 0; di < DT.length; di++) DTI[DT[di]] = di;

  // ---------------- enemies ----------------
  // glyph: [name, hp, armor, speed, lives, bounty, threat, split, size, air, weakness, {resist}, note]
  // size: S M L XL (capitals) B (boss). Capitals split into `split` of their
  // lowercase on death. Specific behaviour lives in the engine, keyed by glyph.
  var E = {
    'a': ['Amble', 100, 0, 1, 1, 4, 10, 0, 'S', 0, '', {}, 'Plain marcher — no tricks.'],
    'A': ['Greater Amble', 400, 0, 1, 3, 18, 50, 1, 'XL', 0, '', {}, 'Plain and tough. Splits into 1 a.'],
    'b': ['Bulwark', 124, 4, 0.7, 1, 5, 12, 0, 'S', 0, 'acid', {}, 'Front shield: +18 armor vs direct physical hits from ahead. Flank it.'],
    'B': ['Greater Bulwark', 496, 8, 0.7, 4, 24, 60, 2, 'XL', 0, 'acid', {}, 'Front shield +36 armor. Splits into 2 b.'],
    'c': ['Cinder', 152, 0, 1.05, 1, 7, 13, 0, 'S', 0, 'frost', { fire: 0.75 }, 'Resists fire 75%; any frost hit strips that for 3s. Burn-proof.'],
    'C': ['Greater Cinder', 608, 3, 1.05, 4, 32, 65, 2, 'XL', 0, 'frost', { fire: 0.9 }, 'Fire 90%; frost exposes it for 2s. Splits into 2 c.'],
    'd': ['Dodger', 184, 0, 1.2, 1, 8, 16, 0, 'S', 0, 'frost', {}, 'Sidesteps projectiles 1s of every 4s. A 30% slow stops it.'],
    'D': ['Greater Dodger', 736, 2, 1.2, 5, 38, 80, 3, 'XL', 0, 'frost', {}, 'Sidesteps 1.4s of every 3s. Splits into 3 d.'],
    'e': ['Escapist', 220, 1, 1.05, 1, 10, 18, 0, 'S', 0, 'shock', {}, 'Stuns last half as long; it dashes off when freed.'],
    'E': ['Greater Escapist', 880, 4, 1.05, 4, 44, 90, 2, 'XL', 0, 'shock', {}, 'Stuns last a quarter. Splits into 2 e.'],
    'f': ['Flier', 260, 0, 1.25, 1, 11, 21, 0, 'S', 1, 'shock', {}, 'Flies its own route over everything. Needs anti-air.'],
    'F': ['Greater Flier', 1040, 2, 1.25, 4, 48, 105, 2, 'XL', 1, 'shock', {}, 'Big flier. Splits into 2 f.'],
    'g': ['Goliath', 304, 12, 0.5, 1, 13, 24, 0, 'S', 0, 'acid', {}, 'Armor 12. Slows capped at 25%, stuns halved, can\'t be pushed.'],
    'G': ['Greater Goliath', 1216, 20, 0.5, 5, 58, 120, 3, 'XL', 0, 'acid', {}, 'Armor 20, slows capped at 15%. Splits into 3 g.'],
    'h': ['Herbalist', 352, 0, 0.85, 1, 14, 28, 0, 'S', 0, 'fire', {}, 'Every 3s heals 3 nearby allies 6% — snipe or silence it.'],
    'H': ['Greater Herbalist', 1408, 3, 0.85, 5, 62, 140, 3, 'XL', 0, 'fire', {}, 'Heals 4 allies 10% every 2.5s. Splits into 3 h.'],
    'i': ['Insulator', 404, 3, 0.9, 1, 16, 33, 0, 'S', 0, 'acid', { shock: 0.75 }, 'Shock 75% resist; chains stop at it. Acid opens it 3s.'],
    'I': ['Greater Insulator', 1616, 7, 0.9, 6, 72, 165, 4, 'XL', 0, 'acid', { shock: 0.9 }, 'Shock 90%; acid opens it 2s. Splits into 4 i.'],
    'j': ['Jammer', 460, 2, 0.85, 2, 18, 38, 0, 'M', 0, 'arcane', {}, 'Every 4s cuts the nearest tower\'s range 35% for 2s.'],
    'J': ['Greater Jammer', 1840, 6, 0.85, 10, 80, 190, 4, 'XL', 0, 'arcane', {}, 'Jams 2 towers 50%. Splits into 4 j.'],
    'k': ['Kinetic', 520, 1, 0.9, 2, 20, 44, 0, 'M', 0, 'frost', {}, 'Each direct hit speeds it up 5% (to +40%). Big hits beat it.'],
    'K': ['Greater Kinetic', 2080, 4, 0.9, 10, 88, 220, 4, 'XL', 0, 'frost', {}, 'Speeds up to +70%. Splits into 4 k.'],
    'l': ['Lattice', 584, 0, 0.9, 2, 22, 51, 0, 'M', 0, 'fire', {}, 'No single hit takes more than 20% of its HP. Burns bypass.'],
    'L': ['Greater Lattice', 2336, 2, 0.9, 10, 96, 255, 4, 'XL', 0, 'fire', {}, 'Hit cap 12%. Splits into 4 l.'],
    'm': ['Minesweeper', 652, 4, 0.8, 2, 24, 59, 0, 'M', 0, 'shock', {}, 'Every 4s disarms mines within 1 tile for 2s.'],
    'M': ['Greater Minesweeper', 2608, 9, 0.8, 10, 104, 295, 4, 'XL', 0, 'shock', {}, 'Disarms mines in 1.5 tiles for 3s. Splits into 4 m.'],
    'n': ['Nullifier', 724, 1, 0.85, 2, 26, 69, 0, 'M', 0, 'arcane', {}, 'Every 4s pauses a nearby support tower\'s bonuses.'],
    'N': ['Greater Nullifier', 2896, 5, 0.85, 10, 112, 345, 4, 'XL', 0, 'arcane', {}, 'Pauses 2 supports. Splits into 4 n.'],
    'o': ['Ooze', 800, 2, 0.7, 2, 28, 80, 0, 'M', 0, 'fire', { acid: 0.75 }, 'Leaves a slick that gives followers +8 armor.'],
    'O': ['Greater Ooze', 3200, 6, 0.7, 12, 122, 400, 5, 'XL', 0, 'fire', { acid: 0.75 }, 'Slick gives +12 armor. Splits into 5 o.'],
    'p': ['Purifier', 880, 0, 0.9, 2, 31, 93, 0, 'M', 0, 'arcane', {}, 'Every 4s cleanses slows and burns from 3 allies.'],
    'P': ['Greater Purifier', 3520, 3, 0.9, 12, 134, 465, 5, 'XL', 0, 'arcane', {}, 'Cleanses 4 allies. Splits into 5 p.'],
    'q': ['Quicksand', 964, 2, 0.8, 2, 33, 107, 0, 'M', 0, 'shock', {}, 'Projectiles crawl at half speed within 1 tile of it.'],
    'Q': ['Greater Quicksand', 3856, 6, 0.8, 12, 142, 535, 5, 'XL', 0, 'shock', {}, '75% drag in 1.3 tiles. Splits into 5 q.'],
    'r': ['Regenerator', 1052, 0, 0.8, 2, 35, 125, 0, 'M', 0, 'fire', {}, 'After 3s untouched it regrows 8% HP a second.'],
    'R': ['Greater Regenerator', 4208, 3, 0.8, 12, 150, 625, 5, 'XL', 0, 'fire', {}, '12%/s after 2s. Splits into 5 r.'],
    's': ['Sprinter', 1144, 0, 0.95, 3, 38, 145, 0, 'L', 0, 'frost', {}, 'Sprints at 2.4 tiles/s for 1.2s every 5s.'],
    'S': ['Greater Sprinter', 4576, 1, 0.95, 20, 164, 725, 6, 'XL', 0, 'frost', {}, 'Sprints at 2.7. Splits into 6 s.'],
    't': ['Tunneler', 1240, 3, 0.85, 3, 40, 168, 0, 'L', 0, 'sonic', {}, 'Burrows 2s of every 5s — only revealed, it can be hit.'],
    'T': ['Greater Tunneler', 4960, 7, 0.85, 20, 172, 840, 6, 'XL', 0, 'sonic', {}, 'Buried half the time. Splits into 6 t.'],
    'u': ['Umbrella', 1340, 3, 0.75, 3, 43, 195, 0, 'L', 0, 'sonic', {}, 'Allies within 1.2 take 40% less splash.'],
    'U': ['Greater Umbrella', 5360, 7, 0.75, 20, 184, 975, 6, 'XL', 0, 'sonic', {}, '55% less splash. Splits into 6 u.'],
    'v': ['Vanguard', 1444, 0, 1, 3, 46, 226, 0, 'L', 0, 'shock', {}, 'Allies within 1 tile move 20% faster.'],
    'V': ['Greater Vanguard', 5776, 2, 1, 20, 196, 1130, 6, 'XL', 0, 'shock', {}, '+30% haste in 1.5 tiles. Splits into 6 v.'],
    'w': ['Wavewing', 1552, 0, 1.1, 3, 48, 262, 0, 'L', 1, 'shock', {}, 'Flier. While high (3s of 6) only anti-air can hit it.'],
    'W': ['Greater Wavewing', 6208, 3, 1.1, 20, 204, 1310, 6, 'XL', 1, 'shock', {}, 'High 4s of every 6s. Splits into 6 w.'],
    'x': ['Crosswalker', 1664, 5, 0.85, 3, 51, 304, 0, 'L', 0, 'arcane', { phys: 0.2 }, 'Ignores slow fields and barricades. 20% physical resist.'],
    'X': ['Greater Crosswalker', 6656, 10, 0.85, 20, 216, 1520, 6, 'XL', 0, 'arcane', { phys: 0.35 }, '35% physical resist. Splits into 6 x.'],
    'y': ['Yowler', 1780, 2, 0.8, 3, 54, 352, 0, 'L', 0, 'sonic', {}, 'Every 5s slows the 2 nearest towers\' firing 25% for 2s.'],
    'Y': ['Greater Yowler', 7120, 6, 0.8, 20, 228, 1760, 6, 'XL', 0, 'sonic', {}, 'Slows 3 towers 40%. Splits into 6 y.'],
    'z': ['Zealot', 1900, 1, 0.95, 3, 57, 409, 0, 'L', 0, 'frost', {}, 'Under 35% HP: +75% speed and stun-proof.'],
    'Z': ['Greater Zealot', 7600, 4, 0.95, 20, 240, 2045, 6, 'XL', 0, 'frost', {}, 'Under 50% HP: double speed. Splits into 6 z.'],
    '0': ['Null Shell', 200, 2, 0.8, 2, 12, 35, 0, 'M', 0, '', {}, 'Starts behind a 250 shield. Shock and sonic tear shields.'],
    '1': ['Lone Strider', 260, 0, 1, 2, 12, 45, 0, 'M', 0, '', {}, 'With no ally within 2 tiles it runs at 1.8.'],
    '2': ['Bonded Pair', 340, 0, 1, 2, 14, 60, 0, 'M', 0, '', {}, 'Comes in pairs: +8 armor while together; the survivor dashes.'],
    '3': ['Ternary Guard', 440, 3, 0.95, 2, 16, 75, 0, 'M', 0, '', {}, 'Every 3rd direct hit raises a 60% guard for 1s. DoT sneaks by.'],
    '4': ['Corner Marshal', 560, 6, 0.85, 2, 18, 95, 0, 'M', 0, 'sonic', {}, 'Gives the 4 nearest allies +8 armor.'],
    '5': ['Escrow Thief', 720, 0, 1.15, 2, 20, 120, 0, 'M', 0, 'frost', {}, 'Halfway, steals up to 20 credits — kill it to get them back.'],
    '6': ['Adaptive Die', 900, 4, 0.85, 2, 24, 155, 0, 'M', 0, '', {}, 'Every 4s, resists the first damage type that hits it 65%.'],
    '7': ['Stepper', 1150, 5, 0.9, 2, 28, 195, 0, 'M', 0, 'shock', {}, 'Every 7 tiles it warns, then blinks 1 tile ahead (twice).'],
    '8': ['Second Loop', 1450, 8, 0.8, 3, 32, 250, 0, 'M', 0, 'fire', {}, 'Comes back once at half HP. Silence stops it.'],
    '9': ['Countdown Carrier', 1800, 10, 0.75, 3, 38, 330, 0, 'M', 0, 'sonic', {}, 'Counts 9→0 (1.5s a tick), then releases three a.'],
    '?': ['Ghost', 360, 0, 1, 2, 14, 85, 0, 'M', 0, 'arcane', { phys: 0.25 }, 'Hidden: only true sight or reveal can hit it. Some are disguised letters.'],
    '!': ['Alarm Bell', 600, 4, 0.9, 2, 20, 125, 0, 'M', 0, 'sonic', {}, 'Rings every 8s: allies within 3 get +30% speed for 3s.'],
    '@': ['Spiral Regent', 2200, 12, 0.5, 10, 150, 600, 0, 'B', 0, 'acid', {}, 'Pulls allies in every 10s; at half HP summons four b.'],
    'Ω': ['Gate Colossus', 4200, 20, 0.45, 12, 220, 1000, 0, 'B', 0, 'acid', {}, 'Front guard −60% direct damage; opens 2s every 9s.'],
    '₩': ['Weather Engine', 6800, 14, 0.65, 14, 300, 1500, 0, 'B', 0, 'frost', {}, 'Every 12s takes flight for 4s (30% shock resist aloft).'],
    '₼': ['Mirror Auditor', 9500, 16, 0.55, 16, 400, 2100, 0, 'B', 0, '', {}, 'Guards physical, then elemental, 60%; 1s gaps take +50%.'],
    '₷': ['Root Archivist', 13500, 18, 0.5, 18, 520, 2800, 0, 'B', 0, 'fire', {}, 'Summons healers at 75/50/25%; heals beside them.'],
    '&': ['Conjunction', 18500, 18, 0.6, 20, 650, 3600, 0, 'B', 0, 'sonic', {}, 'Links 3 allies: they take 30% of its damage. Silence breaks it.'],
    '%': ['Threshold Judge', 24500, 8, 0.55, 22, 800, 4500, 0, 'B', 0, 'acid', {}, 'Hits over 1% of its HP are dampened; opens 2s every 10s.'],
    '¶': ['Paragraph Breaker', 32000, 22, 0.5, 24, 950, 5500, 0, 'B', 0, 'shock', {}, 'Every 14s jumps to another road (or surges 30%).'],
    '¤': ['Phantom Treasury', 41000, 18, 0.6, 26, 1150, 6700, 0, 'B', 0, 'arcane', {}, 'Hides 4s of every 12s behind a 1200 shield; summons ghosts.'],
    '※': ['The Redactor', 52000, 20, 0.5, 30, 1400, 8000, 0, 'B', 0, '', {}, 'Cycles Armor, Chorus (summons m) and Veil modes.']
  };
  var ENEMIES = {}, EORDER = [];
  (function () {
    for (var g in E) {
      var a = E[g], res = [0, 0, 0, 0, 0, 0, 0];
      for (var r in a[11]) res[DTI[r]] = a[11][r];
      ENEMIES[g] = {
        g: g, name: a[0], hp: a[1], ar: a[2], spd: a[3], lives: a[4], bounty: a[5], threat: a[6], split: a[7],
        size: a[8], air: !!a[9], weak: a[10] ? DTI[a[10]] : -1, res: res, note: a[12],
        cap: /[A-Z]/.test(g), boss: a[8] === 'B', lower: /[A-Z]/.test(g) ? g.toLowerCase() : ''
      };
      EORDER.push(g);
    }
  })();
  // What each family "is" in the codex, by glyph group.
  var EGROUPS = [
    { name: 'Letters', g: 'abcdefghijklmnopqrstuvwxyz' },
    { name: 'Capitals', g: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    { name: 'Digits', g: '0123456789' },
    { name: 'Specials', g: '?!' },
    { name: 'Bosses', g: '@Ω₩₼₷&%¶¤※' }
  ];

  // ---------------- towers ----------------
  // Stats merge base → U1 → U2 → U3, then exactly one final branch A or B.
  // Vocabulary (engine): dmg int range minR pspd pierce maxT splash flight multi sec
  // burst burstGap focusT focusB resPen det revealHit slow slowDur freezeN freezeDur
  // brittle brittleDur burn burnDur regenCut corrode corrodeDur armRed armRedDur resCut
  // stun stunCd silence silenceCd chain chainR keep chains cone pen lineW lines retMul fan
  // drones xfer orbitW blades mines mineLife trigR groundMul shieldMul execute ghostB
  // after afterT crater craterDur wake wakeDur cluster every5 tgt shape …support/eco keys.
  var CAT = { atk: 'Attack', ctl: 'Control', sup: 'Support', eco: 'Economy' };
  var TOWERS = [], TKEY = {};
  function tw(key, glyph, name, cat, col, cost, type, tgt, land, shape, role, base, ups, brs) {
    TOWERS.push({ key: key, g: glyph, name: name, cat: cat, col: col, cost: cost, type: type, tgt: tgt, land: land, shape: shape,
      role: role, base: base, ups: ups, brs: brs });
  }
  // ---- attack ----
  tw('arrow', '↑', 'Quill Arrow', 'atk', '#c0901f', 60, 'phys', 'both', 'GH', 'bolt', 'cheap, flexible single target',
    { dmg: 20, int: 1, range: 3, pspd: 12 },
    [[45, { dmg: 27, int: 0.95, range: 3.2 }], [75, { dmg: 37, int: 0.9, range: 3.5 }], [115, { dmg: 50, int: 0.85, range: 3.8 }]],
    [['Longbow', 180, 'range 6, ignores half of armor', { dmg: 92, int: 1.2, range: 6, pierce: 0.5 }],
      ['Forked Quill', 230, 'three arrows at three targets', { dmg: 43, int: 0.75, range: 4.2, multi: 3 }]]);
  tw('cannon', '◎', 'Full Stop Cannon', 'atk', '#cf6a24', 120, 'phys', 'ground', 'GHS', 'arc', 'splash for packed ground groups',
    { dmg: 48, int: 2.4, range: 3.3, splash: 0.65, maxT: 6, flight: 0.55 },
    [[65, { dmg: 66, int: 2.3, range: 3.5, splash: 0.75 }], [105, { dmg: 90, int: 2.15, range: 3.7, splash: 0.85, maxT: 7 }], [155, { dmg: 120, int: 2, range: 4, splash: 1, maxT: 8 }]],
    [['Siege Period', 245, '240 blast, r1.3, ignores half armor', { dmg: 240, int: 2.8, range: 5, splash: 1.3, maxT: 10, pierce: 0.5 }],
      ['Crater Maker', 300, 'leaves a crater: 35% slow for 3s', { dmg: 140, range: 4.2, splash: 1.15, crater: 0.35, craterDur: 3 }]]);
  tw('frost', '*', 'Asterisk Frost', 'atk', '#3a9fd8', 90, 'frost', 'both', 'GHSW', 'bolt', 'steady slowing shots',
    { dmg: 12, int: 1, range: 3, pspd: 10, slow: 0.25, slowDur: 2 },
    [[50, { dmg: 17, int: 0.95, range: 3.2, slow: 0.3, slowDur: 2.2 }], [85, { dmg: 24, int: 0.9, range: 3.4, slow: 0.35, slowDur: 2.5 }], [130, { dmg: 33, int: 0.85, range: 3.7, slow: 0.4, slowDur: 3 }]],
    [['Deep Freeze', 210, 'slow 50%; every 3rd hit freezes 0.8s', { dmg: 52, int: 0.9, range: 4, slow: 0.5, freezeN: 3, freezeDur: 0.8 }],
      ['Hailstorm', 235, 'four shards at four targets', { dmg: 26, int: 0.65, range: 4, multi: 4, slow: 0.35 }]]);
  tw('sonic', '≈', 'Resonance Sonic', 'atk', '#8b5cf0', 150, 'sonic', 'both', 'GHS', 'ring', 'pulse that sees ghosts, tears shields',
    { dmg: 28, int: 1.7, range: 2.8, maxT: 6, shieldMul: 1.5, det: 1 },
    [[80, { dmg: 39, int: 1.6, range: 3, maxT: 7 }], [130, { dmg: 53, int: 1.5, range: 3.2, maxT: 8 }], [190, { dmg: 71, int: 1.4, range: 3.4, maxT: 9 }]],
    [['Grand Chord', 300, '12 targets, double shield damage', { dmg: 110, int: 1.5, range: 4.3, maxT: 12, shieldMul: 2 }],
      ['Mute Button', 350, 'silences struck foes 1.5s', { dmg: 84, int: 1.2, range: 3.6, silence: 1.5, silenceCd: 5 }]]);
  tw('flame', '§', 'Section Flame', 'atk', '#dc3c46', 110, 'fire', 'ground', 'GHS', 'cone', 'burning cone; stops regeneration',
    { dmg: 8, int: 0.5, range: 2.5, cone: 60, maxT: 5, burn: 4, burnDur: 3, regenCut: 0.25 },
    [[60, { dmg: 11, range: 2.7, burn: 6 }], [100, { dmg: 15, int: 0.45, range: 2.9, burn: 8, maxT: 6, regenCut: 0.35 }], [150, { dmg: 20, int: 0.4, range: 3.1, burn: 11, regenCut: 0.4 }]],
    [['Wildfire', 240, '80° cone, 8 targets, burn 18/s', { dmg: 26, range: 3.8, cone: 80, maxT: 8, burn: 18, burnDur: 4, regenCut: 0.5 }],
      ['White Heat', 265, 'narrow 35°, burn 24/s', { dmg: 42, range: 3.2, cone: 35, maxT: 3, burn: 24, regenCut: 0.75 }]]);
  tw('sniper', '⇈', 'Ascender Sniper', 'atk', '#b8552e', 180, 'phys', 'both', 'GH', 'hitscan', 'long-range heavy hits through armor',
    { dmg: 92, int: 3.2, range: 6, pierce: 0.5, minR: 1.2 },
    [[95, { dmg: 128, int: 3.1, range: 6.3 }], [150, { dmg: 177, int: 2.9, range: 6.6, pierce: 0.6 }], [220, { dmg: 240, int: 2.7, range: 7 }]],
    [['Horizon Needle', 340, '440 damage, range 9, ignores 80% armor', { dmg: 440, int: 3.1, range: 9, pierce: 0.8 }],
      ['Double Tap', 375, 'two shots 0.2s apart', { dmg: 190, int: 2.2, burst: 2, burstGap: 0.2 }]]);
  tw('diamond', '♦', 'Diamond Arcane', 'atk', '#14a596', 120, 'arcane', 'both', 'GHSW', 'bolt', 'ghost hunter (true sight)',
    { dmg: 28, int: 1.1, range: 3.2, pspd: 9, resPen: 0.15, det: 1 },
    [[65, { dmg: 38, int: 1.05, range: 3.4 }], [105, { dmg: 52, int: 1, range: 3.7, resPen: 0.2 }], [155, { dmg: 70, int: 0.95, range: 4 }]],
    [['Soulglass', 245, 'struck foes revealed to all for 4s', { dmg: 122, range: 4.5, resPen: 0.35, revealHit: 4 }],
      ['Diamond Fan', 270, 'three bolts at three targets', { dmg: 58, int: 0.8, range: 4.2, multi: 3 }]]);
  tw('gatling', '→', 'Cursor Gatling', 'atk', '#72ad22', 200, 'phys', 'both', 'GHS', 'bolt', 'rapid fire; ramps on one target',
    { dmg: 7, int: 0.2, range: 3, pspd: 18, focusT: 2, focusB: 0.2 },
    [[100, { dmg: 10, range: 3.2 }], [160, { dmg: 14, int: 0.18, range: 3.4 }], [230, { dmg: 19, int: 0.17, range: 3.7, focusB: 0.25 }]],
    [['Armor Drill', 395, 'ignores 70% of armor', { dmg: 35, int: 0.2, range: 4, pierce: 0.7 }],
      ['Twin Cursor', 430, 'two streams at two targets', { dmg: 22, range: 4.2, multi: 2 }]]);
  tw('mortar', '↗', 'Comma Mortar', 'atk', '#d6a014', 220, 'phys', 'ground', 'GHS', 'arc', 'long-range artillery (min range 2)',
    { dmg: 96, int: 3.6, range: 6, minR: 2, splash: 1.25, maxT: 8, flight: 0.9 },
    [[110, { dmg: 132, int: 3.4, range: 6.2, splash: 1.35, maxT: 9 }], [175, { dmg: 181, int: 3.2, range: 6.5, splash: 1.45, maxT: 10 }], [255, { dmg: 245, int: 3, range: 6.8, splash: 1.55, maxT: 11 }]],
    [['Paragraph Bomb', 395, '460 blast, radius 2', { dmg: 460, int: 3.8, range: 8, splash: 2, maxT: 16, flight: 1.1 }],
      ['Airburst', 430, 'also hits flyers', { dmg: 210, int: 2.6, range: 7, splash: 1.7, maxT: 12, flight: 0.75, tgt: 'both' }]]);
  tw('flak', '⊙', 'Bullseye Flak', 'atk', '#4a8fe0', 130, 'phys', 'air', 'GHSW', 'flak', 'cheap anti-air splash',
    { dmg: 20, int: 0.8, range: 4, splash: 0.7, maxT: 5, pspd: 10 },
    [[70, { dmg: 28, int: 0.75, range: 4.2, splash: 0.75 }], [115, { dmg: 39, int: 0.7, range: 4.4, splash: 0.8, maxT: 6 }], [170, { dmg: 53, int: 0.65, range: 4.7, splash: 0.9 }]],
    [['Sky Fence', 270, 'wide flak that slows flyers 30%', { dmg: 78, int: 0.55, range: 5.8, splash: 1.2, maxT: 8, slow: 0.3, slowDur: 2 }],
      ['Harpoon Lock', 295, 'one heavy shot, ignores 60% armor', { dmg: 140, int: 1, range: 5.2, splash: 0, maxT: 1, pierce: 0.6 }]]);
  tw('rail', '#', 'Hash Rail', 'atk', '#4f7fb0', 280, 'phys', 'both', 'GH', 'line', 'piercing line; loves straight roads',
    { dmg: 80, int: 2.8, range: 5.5, lineW: 0.25, pen: 4, keep: 0.75, pierce: 0.4 },
    [[140, { dmg: 112, int: 2.65, range: 5.8 }], [215, { dmg: 154, int: 2.5, range: 6.1, pen: 5, pierce: 0.5 }], [310, { dmg: 210, int: 2.35, range: 6.5, pen: 6, keep: 0.8 }]],
    [['Unbroken Line', 470, 'pierces 10, no falloff', { dmg: 290, int: 2.3, range: 7.5, lineW: 0.3, pen: 10, keep: 1 }],
      ['Boss Stapler', 510, 'one 620 bolt, ignores 90% armor', { dmg: 620, int: 3.2, range: 7, pen: 1, pierce: 0.9 }]]);
  tw('drone', '∴', 'Triad Drone', 'atk', '#2fb08c', 240, 'phys', 'both', 'GHSW', 'drones', 'three drones, three targets',
    { dmg: 14, int: 1, range: 4, multi: 3, pspd: 14 },
    [[120, { dmg: 19, int: 0.95, range: 4.2 }], [185, { dmg: 26, int: 0.9, range: 4.4 }], [270, { dmg: 35, int: 0.85, range: 4.6 }]],
    [['Drone Cloud', 420, 'five drones', { dmg: 32, int: 0.8, range: 4.8, multi: 5 }],
      ['Heavy Triad', 455, 'heavy rounds ignore half armor', { dmg: 68, int: 0.95, range: 5.2, pierce: 0.5 }]]);
  tw('lightning', '⌁', 'Tilde Lightning', 'atk', '#4470e8', 180, 'shock', 'both', 'GHSW', 'chain', 'chain lightning through groups',
    { dmg: 34, int: 1.5, range: 3.3, chain: 3, chainR: 1.4, keep: 0.75 },
    [[90, { dmg: 47, int: 1.4, range: 3.5, chainR: 1.5 }], [145, { dmg: 65, int: 1.3, range: 3.7, chain: 4, chainR: 1.6 }], [210, { dmg: 88, int: 1.2, range: 4, chainR: 1.7, keep: 0.8 }]],
    [['Storm Sentence', 330, 'seven jumps', { dmg: 120, int: 1.15, range: 4.4, chain: 7, chainR: 2, keep: 0.85 }],
      ['Capacitor', 360, 'stuns 0.35s', { dmg: 235, int: 1.8, range: 4.5, chain: 2, chainR: 1.8, keep: 0.9, stun: 0.35, stunCd: 4 }]]);
  tw('mine', '⊗', 'Crossmark Mine', 'atk', '#7d7d86', 100, 'phys', 'ground', 'GHS', 'mine', 'lays mines on the road',
    { dmg: 80, int: 3.5, range: 3, trigR: 0.35, splash: 0.8, maxT: 6, mines: 3, mineLife: 12 },
    [[55, { dmg: 110, int: 3.3, range: 3.2, splash: 0.9 }], [90, { dmg: 150, int: 3.1, range: 3.4, splash: 1, maxT: 7, mines: 4 }], [140, { dmg: 205, int: 2.9, range: 3.6, splash: 1.1, maxT: 8 }]],
    [['Deep Charge', 225, '420 mines, ignore half armor', { dmg: 420, int: 3.2, range: 4, splash: 1.3, maxT: 10, pierce: 0.5 }],
      ['Minefield', 250, 'up to 7 mines, laid fast', { dmg: 155, int: 1.5, range: 4.2, splash: 1, maxT: 7, mines: 7, mineLife: 16 }]]);
  tw('beam', '∿', 'Sine Beam', 'atk', '#d4588a', 250, 'arcane', 'both', 'GHS', 'beam', 'sustained beam that focuses',
    { dmg: 14, int: 0.4, range: 4, focusT: 2, focusB: 0.2 },
    [[125, { dmg: 19, int: 0.38, range: 4.2 }], [195, { dmg: 26, int: 0.36, range: 4.4, focusB: 0.25 }], [280, { dmg: 35, int: 0.34, range: 4.6, focusB: 0.3 }]],
    [['Hyperfocus', 435, 'focus +50%', { dmg: 54, int: 0.32, range: 5, focusB: 0.5 }],
      ['Sweep Beam', 470, 'wide beam through five foes', { dmg: 30, int: 0.3, range: 4.8, pen: 5, lineW: 0.45, focusB: 0 }]]);
  tw('boomer', '⌘', 'Command Boomerang', 'atk', '#bb7a3e', 140, 'phys', 'both', 'GHS', 'boomer', 'hits a line going out and back',
    { dmg: 25, int: 1.6, range: 3.6, lineW: 0.35, pen: 3, keep: 0.8 },
    [[75, { dmg: 34, int: 1.5, range: 3.8 }], [120, { dmg: 46, int: 1.4, range: 4, pen: 4 }], [175, { dmg: 62, int: 1.3, range: 4.2, keep: 0.85 }]],
    [['Wide Brackets', 280, 'wide; seven per pass', { dmg: 86, int: 1.25, range: 5, lineW: 0.6, pen: 7, keep: 0.9 }],
      ['Round Trip', 305, 'the return pass hits double', { dmg: 72, int: 1.2, range: 4.4, retMul: 2 }]]);
  tw('blade', '∩', 'Arch Chainblade', 'atk', '#9aa4ae', 160, 'phys', 'ground', 'GHS', 'orbit', 'orbiting blade (blind inside the ring)',
    { dmg: 70, int: 2, range: 2.5, orbitW: 0.5, maxT: 6, pierce: 0.25 },
    [[85, { dmg: 96, int: 1.9, range: 2.6, orbitW: 0.55, maxT: 7 }], [135, { dmg: 132, int: 1.8, range: 2.7, orbitW: 0.6, maxT: 8, pierce: 0.35 }], [200, { dmg: 180, int: 1.7, range: 2.8, orbitW: 0.65, maxT: 9 }]],
    [['Saturn Blade', 315, 'wide ring, 12 hits a turn', { dmg: 265, int: 1.6, range: 3.3, orbitW: 1, maxT: 12, pierce: 0.5 }],
      ['Pendulum Cut', 375, '120° sweeping cone, no blind spot', { dmg: 220, int: 1.3, range: 3, shape: 'cone', cone: 120, maxT: 9, pierce: 0.45 }]]);
  tw('swarm', '⌂', 'Hive Swarm', 'atk', '#d9a71e', 260, 'phys', 'both', 'GHSW', 'swarm', 'five drones swarm one foe',
    { dmg: 8, int: 0.8, range: 3.2, drones: 5, pspd: 8 },
    [[130, { dmg: 11, int: 0.75, range: 3.4 }], [200, { dmg: 15, int: 0.7, range: 3.6, pspd: 9 }], [290, { dmg: 20, int: 0.65, range: 3.8, pspd: 10 }]],
    [['Overhive', 450, 'eight drones', { dmg: 19, int: 0.6, range: 4.2, drones: 8, pspd: 12 }],
      ['Metal Mites', 485, 'drones ignore 60% armor', { dmg: 32, range: 4, pierce: 0.6 }]]);
  tw('prism', '⏣', 'Hex Prism', 'atk', '#c8489e', 300, 'arcane', 'both', 'GHSW', 'prism', 'three rays; you pick the element',
    { dmg: 30, sec: 15, int: 1, range: 3.8, multi: 3 },
    [[150, { dmg: 42, sec: 21, int: 0.95, range: 4 }], [230, { dmg: 58, sec: 29, int: 0.9, range: 4.2 }], [330, { dmg: 79, sec: 39.5, int: 0.85, range: 4.4 }]],
    [['Convergence', 540, 'one 210 ray, ignores 20 resist', { dmg: 210, int: 0.9, range: 5, multi: 1, sec: 0, resPen: 0.2 }],
      ['Kaleidoscope', 580, 'five rays', { dmg: 82, sec: 41, int: 0.8, range: 4.8, multi: 5 }]]);
  tw('acid', '⌖', 'Crosshair Acid', 'atk', '#8fb81e', 150, 'acid', 'both', 'GHSW', 'bolt', 'corrodes and strips armor',
    { dmg: 8, int: 1, range: 3.2, pspd: 10, corrode: 10, corrodeDur: 3, armRed: 3, armRedDur: 4 },
    [[80, { dmg: 11, int: 0.95, range: 3.4, corrode: 14, armRed: 5 }], [125, { dmg: 15, int: 0.9, range: 3.6, corrode: 20, armRed: 7 }], [185, { dmg: 21, int: 0.85, range: 3.9, corrode: 28, armRed: 10 }]],
    [['Etching Needle', 295, 'corrode 42/s, armor −18', { dmg: 35, int: 0.75, range: 4.4, corrode: 42, corrodeDur: 4, armRed: 18, armRedDur: 5 }],
      ['Caustic Cloud', 320, 'lobbed acid splash (7 targets)', { dmg: 20, int: 1.2, range: 4.1, shape: 'arc', splash: 1.1, maxT: 7, flight: 0.8, corrode: 30, corrodeDur: 4, tgt: 'both' }]]);
  // ---- support ----
  tw('lantern', '◈', 'Lantern', 'sup', '#d6a321', 120, 'none', 'both', 'GHS', 'reveal', 'reveals ghosts and burrowers nearby',
    { range: 3, linger: 1 },
    [[90, { range: 3.3, linger: 1.5 }], [150, { range: 3.6, linger: 2 }], [240, { range: 4, linger: 2.5 }]],
    [['Lighthouse', 360, 'reveal radius 5', { range: 5 }],
      ['Exorcist', 400, 'revealed ghosts slowed 20% inside', { exSlow: 0.2 }]]);
  tw('relay', '⊕', 'Signal Relay', 'sup', '#1e9a93', 140, 'none', 'ally', 'GHS', 'relay', 'shields towers from jams and yowls',
    { range: 2.5, cap: 3, supRed: 0.3 },
    [[100, { range: 2.8, supRed: 0.4 }], [170, { range: 3.1, cap: 4, supRed: 0.5 }], [260, { range: 3.5, cap: 5, supRed: 0.6 }]],
    [['Broadcaster', 390, 'radius 5, eight towers', { range: 5, cap: 8 }],
      ['Firewall', 410, 'jams and yowls −75%', { supRed: 0.75 }]]);
  tw('metronome', '+', 'Metronome', 'sup', '#18a088', 120, 'none', 'ally', 'GHS', 'haste', 'nearby towers fire faster',
    { range: 2.5, cap: 3, haste: 0.15 },
    [[90, { range: 2.7, haste: 0.22 }], [150, { range: 3, cap: 4, haste: 0.3 }], [240, { range: 3.3, haste: 0.38 }]],
    [['Double Time', 360, '+50% fire rate', { haste: 0.5 }],
      ['Orchestra', 380, 'radius 4.5, eight towers', { range: 4.5, cap: 8 }]]);
  tw('amp', '⊣', 'Amplifier', 'sup', '#c03c68', 160, 'none', 'ally', 'GHS', 'amp', 'nearby towers hit harder',
    { range: 2.5, cap: 2, dmgB: 0.18 },
    [[110, { range: 2.8, dmgB: 0.25 }], [180, { range: 3.1, cap: 3, dmgB: 0.32 }], [280, { range: 3.5, cap: 4, dmgB: 0.4 }]],
    [['Overdrive', 420, '+50% damage', { dmgB: 0.5 }],
      ['War Choir', 440, 'radius 4.5, seven towers', { range: 4.5, cap: 7 }]]);
  tw('surveyor', '⌛', 'Surveyor', 'sup', '#3a74b4', 130, 'none', 'ally', 'GHS', 'survey', 'nearby towers reach further',
    { range: 2.5, cap: 3, rangeB: 0.12 },
    [[100, { range: 2.8, rangeB: 0.18 }], [160, { range: 3.1, cap: 4, rangeB: 0.25 }], [250, { range: 3.5, cap: 5, rangeB: 0.32 }]],
    [['Horizon', 380, '+40% range', { rangeB: 0.4 }],
      ['Map Room', 400, 'radius 5, eight towers', { range: 5, cap: 8 }]]);
  tw('echo', '⌬', 'Echo Chamber', 'sup', '#9160cc', 230, 'none', 'ally', 'GHS', 'echo', 'repeats a tower\'s big hit',
    { range: 3, cap: 1, echo: 0.25, echoCd: 4 },
    [[160, { range: 3.2, echo: 0.3 }], [250, { range: 3.4, echo: 0.35, echoCd: 3.5 }], [360, { range: 3.6, echo: 0.4, echoCd: 3 }]],
    [['Refrain', 540, 'echo 50% every 2s', { echo: 0.5, echoCd: 2 }],
      ['Duet', 560, 'two towers echo', { range: 4, cap: 2 }]]);
  tw('terra', '∑', 'Terraformer', 'sup', '#7a9646', 220, 'none', 'ally', 'GHS', 'terra', 'raises build pads beside the road',
    { range: 3, pads: 2 },
    [[150, { range: 3.5, pads: 3 }], [240, { range: 4, pads: 4 }], [350, { range: 4.5, pads: 5 }]],
    [['Causeway', 520, 'eight pads, radius 6', { range: 6, pads: 8 }],
      ['Biome Workshop', 540, 'pads hold any attack tower', { anyPad: 1 }]]);
  // ---- control ----
  tw('etcher', '⊞', 'Etcher', 'ctl', '#6f9f25', 150, 'acid', 'both', 'GHS', 'etch', 'pulses that strip armor',
    { range: 3, int: 3, pulseR: 1, maxT: 6, armBreak: 8, armBreakDur: 5 },
    [[110, { range: 3.2, pulseR: 1.1, armBreak: 12 }], [180, { range: 3.4, int: 2.7, pulseR: 1.2, maxT: 8, armBreak: 18 }], [280, { range: 3.6, int: 2.5, pulseR: 1.3, maxT: 10, armBreak: 24, armBreakDur: 6 }]],
    [['Deep Etch', 420, 'armor −45', { armBreak: 45 }],
      ['Acid Fog', 440, 'radius 2, 18 foes', { range: 4, pulseR: 2, maxT: 18 }]]);
  tw('mute', '⊟', 'Mute', 'ctl', '#7a58ad', 180, 'sonic', 'both', 'GHS', 'mute', 'silences enemy abilities',
    { range: 3, int: 7, pulseR: 1.2, maxT: 5, silence: 1.5 },
    [[130, { range: 3.2, pulseR: 1.3, maxT: 6, silence: 1.8 }], [210, { range: 3.4, int: 6.5, pulseR: 1.4, maxT: 7, silence: 2.1 }], [320, { range: 3.6, int: 6, pulseR: 1.5, maxT: 8, silence: 2.4 }]],
    [['Dead Air', 480, '3s silence', { silence: 3 }],
      ['Broadcast Ban', 500, 'radius 2.3, 15 foes', { range: 4, pulseR: 2.3, maxT: 15 }]]);
  tw('gravity', '⊠', 'Gravity Well', 'ctl', '#5c56b4', 190, 'arcane', 'both', 'GHS', 'grav', 'drops a slowing field',
    { range: 3, int: 6, field: 1.5, fieldDur: 3, maxT: 10, slow: 0.25 },
    [[130, { range: 3.2, field: 1.7, maxT: 12, slow: 0.3 }], [220, { range: 3.4, field: 1.9, fieldDur: 3.5, maxT: 14, slow: 0.35 }], [330, { range: 3.6, field: 2.1, fieldDur: 4, maxT: 16, slow: 0.4 }]],
    [['Event Horizon', 500, '55% slow', { slow: 0.55 }],
      ['Singularity', 540, 'pulls foes 0.75 back', { int: 8, pull: 0.75 }]]);
  tw('gate', '⊚', 'Return Gate', 'ctl', '#b84aa8', 240, 'arcane', 'both', 'GHS', 'gate', 'teleports a foe back down the road',
    { range: 3, int: 8, tele: 1, maxT: 1 },
    [[160, { range: 3.2, tele: 1.5 }], [250, { range: 3.4, int: 7, tele: 2 }], [360, { range: 3.6, int: 6, tele: 2.5 }]],
    [['Full Recall', 540, '3 tiles back', { range: 4.2, tele: 3 }],
      ['Group Return', 560, 'four foes, 1.5 back', { tele: 1.5, maxT: 4, pulseR: 1 }]]);
  tw('barricade', '⊥', 'Barricade', 'ctl', '#977548', 100, 'none', 'ground', 'GHS', 'barr', 'projects a slowing strip on the road',
    { range: 2.5, int: 7, strip: 2, stripDur: 3, maxT: 8, slow: 0.3 },
    [[80, { range: 2.8, strip: 2.5, stripDur: 3.5, maxT: 10, slow: 0.35 }], [140, { range: 3, strip: 3, stripDur: 4, maxT: 12, slow: 0.4 }], [220, { range: 3.3, strip: 3.5, stripDur: 4.5, maxT: 14, slow: 0.45 }]],
    [['Roadworks', 330, '5-tile strip', { strip: 5, maxT: 20 }],
      ['Hard Stop', 350, '60% slow', { slow: 0.6 }]]);
  tw('tide', '∆', 'Tide Gate', 'ctl', '#1b8fae', 130, 'none', 'ground', 'SW', 'tide', 'soaks foes: +shock damage (water/shore)',
    { range: 3, int: 6, pulseR: 1.3, maxT: 8, wet: 0.2, wetDur: 4 },
    [[100, { range: 3.2, pulseR: 1.4, maxT: 10, wet: 0.25, wetDur: 5 }], [160, { range: 3.4, int: 5.5, pulseR: 1.5, maxT: 12, wet: 0.3 }], [250, { range: 3.6, int: 5, pulseR: 1.7, maxT: 14, wet: 0.35 }]],
    [['Conductor', 380, 'wet: +50% shock', { wet: 0.5 }],
      ['Steam Cloud', 400, 'radius 2.3, flyers too', { range: 4, pulseR: 2.3, maxT: 20, tgt: 'both' }]]);
  tw('wind', '√', 'Crosswind', 'ctl', '#459dbb', 140, 'none', 'air', 'GHS', 'wind', 'gusts that slow flyers',
    { range: 3.2, int: 6, cone: 60, maxT: 8, slow: 0.2, slowDur: 3 },
    [[100, { range: 3.4, cone: 65, maxT: 10, slow: 0.25, slowDur: 3.5 }], [170, { range: 3.6, cone: 70, maxT: 12, slow: 0.3, slowDur: 4 }], [260, { range: 4, cone: 75, maxT: 14, slow: 0.35 }]],
    [['Headwind', 390, '90° gust, 45% slow', { range: 4.5, cone: 90, maxT: 20, slow: 0.45 }],
      ['Landing Window', 430, 'grounds flyers 2s: anything can hit them', { land: 2 }]]);
  tw('drain', '∞', 'Null Battery', 'ctl', '#4a78d4', 170, 'shock', 'both', 'GHS', 'drain', 'drains shields (no health damage)',
    { range: 3, int: 2.5, drain: 120, pspd: 8 },
    [[120, { range: 3.2, int: 2.3, drain: 180 }], [200, { range: 3.4, int: 2, drain: 280, pspd: 9 }], [300, { range: 3.6, int: 1.8, drain: 420, pspd: 10 }]],
    [['Deep Discharge', 450, 'drains 800', { range: 4, drain: 800 }],
      ['Parallel', 470, 'three shields at once', { multi: 3 }]]);
  tw('chrono', '↔', 'Chronostat', 'ctl', '#a07cc0', 260, 'arcane', 'both', 'GHS', 'chrono', 'stops time for a moment',
    { range: 3, int: 6, pulseR: 1.2, maxT: 5, stun: 0.35, bossSlow: 0.2, bossSlowDur: 1 },
    [[170, { range: 3.2, pulseR: 1.3, maxT: 6, stun: 0.45, bossSlowDur: 1.2 }], [270, { range: 3.4, pulseR: 1.4, maxT: 7, stun: 0.55, bossSlow: 0.25, bossSlowDur: 1.4 }], [390, { range: 3.6, pulseR: 1.5, maxT: 8, stun: 0.65, bossSlowDur: 1.6 }]],
    [['Held Moment', 590, '0.9s stop', { stun: 0.9, bossSlowDur: 2 }],
      ['Wide Pause', 610, 'radius 2.4, 16 foes', { range: 4.2, pulseR: 2.4, maxT: 16 }]]);
  // ---- economy ----
  tw('mint', '$', 'Mint', 'eco', '#2f8c50', 120, 'none', 'none', 'GHS', 'mint', 'pays after every wave',
    { income: 20 },
    [[100, { income: 32 }], [170, { income: 52 }], [260, { income: 82 }]],
    [['Treasury', 390, '+130 a wave', { income: 130 }],
      ['Victory Bonds', 430, '+420 after each boss wave', { bonds: 420 }]]);
  tw('bank', '≡', 'Bank', 'eco', '#2c7046', 160, 'none', 'none', 'GHS', 'bank', 'locks credits for a wave, pays interest',
    { bankCap: 250, bankRate: 0.08, bankMax: 20 },
    [[120, { bankCap: 400, bankMax: 32 }], [190, { bankCap: 600, bankRate: 0.1, bankMax: 60 }], [290, { bankCap: 800, bankMax: 80 }]],
    [['Grand Vault', 440, 'holds 1500, pays up to 150', { bankCap: 1500, bankMax: 150 }],
      ['High Yield', 460, '18% interest', { bankCap: 600, bankRate: 0.18, bankMax: 108 }]]);
  tw('bounty', '⊓', 'Bounty Office', 'eco', '#8a9a38', 160, 'none', 'both', 'GHS', 'bounty', 'marks foes; marked kills pay extra',
    { range: 4, markEvery: 2, markDur: 8, marks: 2, markPay: 8, markMax: 3 },
    [[110, { range: 4.2, markPay: 10, markMax: 4 }], [180, { range: 4.5, markEvery: 1.8, markDur: 9, marks: 3, markPay: 14, markMax: 5 }], [280, { range: 4.8, markEvery: 1.5, markDur: 10, markPay: 18, markMax: 6 }]],
    [['Big Game', 420, 'capitals and bosses only: 38 each', { markElite: 1, markPay: 38, markMax: 5 }],
      ['Open Contracts', 440, 'six marks, ten paid kills', { range: 6, markEvery: 1, marks: 6, markMax: 10 }]]);
  tw('salvage', '⊔', 'Salvage Yard', 'eco', '#b0783c', 140, 'none', 'both', 'GHS', 'salvage', 'kills nearby pay extra',
    { range: 3, salvage: 2, salvageMax: 10 },
    [[100, { range: 3.3, salvage: 3, salvageMax: 11 }], [160, { range: 3.6, salvage: 4, salvageMax: 15 }], [250, { range: 4, salvage: 5, salvageMax: 18 }]],
    [['Industrial', 380, '8 a kill', { salvage: 8, salvageMax: 20 }],
      ['Wide Haul', 400, 'radius 6, 28 kills', { range: 6, salvageMax: 28 }]]);
  for (var ti = 0; ti < TOWERS.length; ti++) TKEY[TOWERS[ti].key] = ti;

  var START_TOWERS = ['arrow', 'cannon', 'frost', 'diamond', 'sonic', 'flak', 'lantern', 'mint'];

  // ---------------- map rules ----------------
  // Traits a map can carry (shown on its card and briefing).
  var TRAITS = {
    fog: { name: 'Fog', desc: 'attack range −15%' },
    tailwind: { name: 'Tailwind', desc: 'flyers +25% speed' },
    mud: { name: 'Mud', desc: 'ground foes −15% speed, +15% HP' },
    rich: { name: 'Rich Vein', desc: 'bounties +25%' },
    heat: { name: 'Heat', desc: 'fire −25% damage, frost +25%' },
    cold: { name: 'Cold Snap', desc: 'frost −25% damage, fire +25%' },
    static: { name: 'Static', desc: 'shock +25% damage' },
    swarm: { name: 'Swarm', desc: 'half again as many foes, 30% less HP' },
    elite: { name: 'Elite', desc: 'capitals come more often' },
    austerity: { name: 'Austerity', desc: 'start gold −25%, wave pay +30%' },
    night: { name: 'Night', desc: 'ghosts walk among them' },
    rush: { name: 'Rush', desc: 'waves come 40% sooner' },
    hardcore: { name: 'Last Stand', desc: 'only 10 lives' },
    noeco: { name: 'Embargo', desc: 'no economy towers' }
  };
  // id: [waves, level at wave 1, level gained per wave, lives, pool, bosses, traits, unlock, slots, base]
  // pool: the enemies this map sends, in order of arrival (the first `base` of them from wave 1);
  // each map ends harder than the ordinary map before it, and each ULTRA is its region's peak.
  var PLAY = {
    'ruled-lines': [12, 1, 0.7, 30, 'a b c 0', '', '', 'flame', 0, 1],
    'dog-ear': [15, 2, 0.7, 30, 'a b c d 0 1 A', '@', '', 'sniper', 0, 2],
    'inkwell': [18, 3, 0.7, 30, 'a b c d e 0 1 A B', '@', 'rich', 'metronome', 0, 2],
    'gutter': [20, 4, 0.7, 30, 'a b d e f 0 1 A B', '@', 'tailwind', 'acid', 0, 3],
    'long-margin': [25, 4, 0.75, 30, 'a b c d e f 0 1 A B C', '@', '', 'mine', 0, 3],
    'oasis-loop': [18, 6, 0.7, 30, 'a c d e g h 0 2 B C', '@', 'rich', 'mortar', 0, 3],
    'dune-sea': [20, 7, 0.7, 30, 'b d e g h i 1 2 3 C D', '@', 'fog', 'gatling', 0, 3],
    'caravan-road': [22, 8, 0.7, 30, 'a e f g h i j 2 3 D E', 'Ω', '', 'etcher', 0, 3],
    'twin-mesa': [24, 9, 0.7, 30, 'b c g h i j ? 3 D E G', 'Ω', 'night', 'surveyor', 0, 3],
    'sandscript': [30, 9, 0.75, 30, 'a b c d e f g h i j ? 2 3 A B C D E', '@ Ω', '', 'rail', 0, 4],
    'permafrost': [20, 11, 0.77, 30, 'd e f g k l 3 4 E F', 'Ω', 'cold', 'lightning', 0, 3],
    'icebreaker-bay': [22, 12, 0.67, 30, 'f g h k l m ! 4 F G', 'Ω', '', 'tide', 0, 3],
    'tollgate': [22, 13, 0.65, 30, 'g h i m n 4 5 ! G H', '₩', 'austerity', 'bank', 0, 3],
    'whiteout': [25, 14, 0.65, 30, 'f k l m n ? ! 5 F H I', '₩', 'fog', 'gravity', 0, 3],
    'long-winter': [30, 14, 0.7, 30, 'e f g h i j k l m n ! 4 5 F G H I', 'Ω ₩', '', 'drone', 0, 4],
    'reedway': [22, 16, 0.67, 30, 'h k m n o p 4 6 I J', '₩', 'mud', 'amp', 0, 3],
    'sunken-script': [24, 17, 0.6, 30, 'f l o p q 6 7 J K', '₼', 'static', 'beam', 0, 3],
    'wisp-hollow': [24, 18, 0.6, 30, '? o p q 6 ! J K', '₼', 'night', 'mute', 0, 3],
    'mangrove-knot': [26, 19, 0.6, 30, 'k l m o p q 7 ? K L', '₼', '', 'boomer', 0, 3],
    'great-bog': [32, 19, 0.65, 30, 'h i j k l m n o p q ? ! 6 7 I J K L', '₼ ₷', '', 'salvage', 0, 4],
    'forge-row': [24, 21, 0.6, 30, 'n o p r s 8 L M', '₷', 'heat', 'blade', 0, 3],
    'lava-lanes': [26, 22, 0.6, 30, 'o q r s t 8 9 M N', '₷', '', 'barricade', 0, 3],
    'smelter-spiral': [26, 23, 0.6, 30, 'p r s t u 9 N O', '&', 'swarm', 'relay', 0, 3],
    'ashfall': [28, 24, 0.6, 30, 'q r s t u ! 8 9 O P', '&', 'elite', 'swarm', 0, 3],
    'cinder-press': [35, 24, 0.65, 30, 'l m n o p q r s t u 8 9 ! M N O P', '& %', '', 'bounty', 0, 4],
    'updraft': [26, 26, 0.6, 30, 'f s u v w F Q', '%', 'tailwind', 'wind', 0, 3],
    'cloud-bridges': [28, 27, 0.6, 30, 'r t v w x Q R', '%', '', 'drain', 0, 3],
    'pinnacle': [28, 28, 0.6, 30, 'u v w x ? R S', '¶', 'elite', 'gate', 0, 3],
    'jetstream': [30, 29, 0.6, 30, 's v w x ! S T', '¶', '', 'echo', 0, 3],
    'spires': [36, 29, 0.65, 30, 'q r s t u v w x ? ! P Q R S T', '¶ ¤', '', 'prism', 0, 4],
    'stacks': [30, 31, 0.6, 30, 'u v x y U V', '¤', '', 'chrono', 6, 3],
    'card-index': [30, 32, 0.6, 30, 'w x y z V W', '¤', 'rush', 'terra', 0, 3],
    'palimpsest': [32, 33, 0.6, 30, 'x y z ? ! W X Y', '¶', 'noeco', '', 0, 3],
    'errata': [34, 34, 0.6, 10, 'y z 8 9 X Y Z', '¤', 'hardcore', '', 0, 3],
    'redacted-archive': [40, 34, 0.6, 30, 'r s t u v w x y z ? ! 6 7 8 9 R S T U V W X Y Z', '¤ ※', '', '', 0, 4]
  };
  // Per-map catalog limits (beyond Embargo): only these categories / keys.
  var ONLY = {
    'gutter': { cats: ['atk', 'sup', 'eco'], note: 'no control towers' },
    'dune-sea': { types: ['phys', 'none'], note: 'physical and support only' },
    'wisp-hollow': { types: ['arcane', 'sonic', 'none', 'acid'], note: 'arcane, sonic and acid only' },
    'lava-lanes': { ban: ['flame'], note: 'no flame towers' },
    'pinnacle': { cats: ['atk', 'eco'], note: 'attack and economy only' },
    'stacks': { note: 'six loadout slots' },
    'card-index': { ban: ['mine', 'barricade'], note: 'no mines or barricades' }
  };

  // ---------------- Armory perks (stars) ----------------
  var PERKS = [
    { id: 'chest', name: 'War Chest', max: 3, cost: 1, desc: '+8% starting gold' },
    { id: 'steel', name: 'Sharpened Glyphs', max: 3, cost: 2, desc: '+5% tower damage' },
    { id: 'optics', name: 'Optics', max: 2, cost: 2, desc: '+5% attack range' },
    { id: 'walls', name: 'Fortify', max: 2, cost: 2, desc: '+5 lives (+1 on Last Stand)' },
    { id: 'plunder', name: 'Plunder', max: 2, cost: 2, desc: '+8% bounty per kill' },
    { id: 'eng', name: 'Engineering', max: 2, cost: 2, desc: '−6% upgrade costs' },
    { id: 'salvage', name: 'Scrap Rights', max: 2, cost: 1, desc: 'sell for +8% more' },
    { id: 'early', name: 'Early Bird', max: 1, cost: 1, desc: '+50% bonus for calling waves early' },
    { id: 'scouts', name: 'Scouts', max: 1, cost: 3, desc: 'attack towers see hidden foes within 1.2' },
    { id: 'slot', name: 'Quartermaster', max: 2, cost: 3, desc: '+1 loadout slot' }
  ];

  var api = {
    DT: DT, DT_NAME: DT_NAME, DTI: DTI, ENEMIES: ENEMIES, EORDER: EORDER, EGROUPS: EGROUPS, CAT: CAT,
    TOWERS: TOWERS, TKEY: TKEY, START_TOWERS: START_TOWERS, TRAITS: TRAITS, PLAY: PLAY, ONLY: ONLY, PERKS: PERKS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__TD2Data = api;
})(typeof window !== 'undefined' ? window : this);
