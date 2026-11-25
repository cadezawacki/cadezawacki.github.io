/* Deepdelve — content tables for the Dungeon Crawler widget (crawler.js).
 *
 * Pure data: classes, abilities, talents, monsters, biomes, bosses, items,
 * affixes, uniques, sets, consumables, events, the story, town dialogue, lore
 * pages and bounties. No logic beyond tiny helpers, no DOM. Loaded on first
 * open by crawler.js (window.__cadeCrawlerData) and by node for the tests
 * (module.exports). crawler-engine.js gives all of it meaning.
 */
(function (root, factory) {
  var D = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
  else root.__cadeCrawlerData = D;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ===========================================================================
  //  CLASSES
  //  base: level-1 stats · grow: per level · res: the class resource
  //  res.regen: per turn · res.hit: on dealing a basic hit · res.hurt: on being hit
  //  res.kill: on a kill nearby · res.still: extra when you did not move
  // ===========================================================================
  var CLASSES = {
    warrior: {
      name: 'Warrior', icon: '⚔', glyph: '@', color: '#e0664a',
      blurb: 'A wall of iron that gets angrier the longer the fight goes.',
      play: 'Wade in. Hits build Rage; spend it on Cleave and Execute. Unbreakable turns a bad fight around.',
      res: { id: 'rage', name: 'Rage', color: '#e8553e', max: 100, start: 0, regen: 0, decay: 4, hit: 10, hurt: 6, kill: 5 },
      base: { hp: 46, pow: 6, arm: 3, crit: 0.05, dodge: 0.02 }, grow: { hp: 9, pow: 1.05, arm: 0.45 },
      weapons: ['sword', 'axe', 'mace'], kit: { weapon: 'sword', armor: 'mail', cons: { potion: 3, recall: 1 } },
      abilities: ['cleave', 'charge', 'warcry', 'execute', 'unbreakable']
    },
    rogue: {
      name: 'Rogue', icon: '🗡', glyph: '@', color: '#9a7be0',
      blurb: 'Strikes from the shadows, gone before the body drops.',
      play: 'Sleeping and stunned foes take guaranteed crits from Backstab. Shadowstep in, Smoke Bomb out. Energy refills fast.',
      res: { id: 'energy', name: 'Energy', color: '#e8c94a', max: 100, start: 100, regen: 11 },
      base: { hp: 38, pow: 6, arm: 1, crit: 0.12, dodge: 0.08 }, grow: { hp: 7, pow: 1.1, arm: 0.3 },
      weapons: ['dagger', 'sword'], kit: { weapon: 'dagger', armor: 'leather', cons: { potion: 3, recall: 1, bomb: 1 } },
      abilities: ['backstab', 'shadowstep', 'envenom', 'fan', 'smoke']
    },
    mage: {
      name: 'Mage', icon: '✦', glyph: '@', color: '#4aa8e8',
      blurb: 'Fire, frost and lightning — and very little between you and the teeth.',
      play: 'Keep your distance. Firebolt from range, Frost Nova when they close in, Blink away. Meteor wipes a pack — if they stay put.',
      res: { id: 'mana', name: 'Mana', color: '#4a8fe8', max: 60, start: 60, regen: 2, kill: 3 },
      base: { hp: 32, pow: 7, arm: 0, crit: 0.06, dodge: 0.04 }, grow: { hp: 6, pow: 1.2, arm: 0.2, res: 2.5 },
      weapons: ['staff', 'wand'], kit: { weapon: 'staff', armor: 'robe', cons: { potion: 3, recall: 1, tonic: 2 } },
      abilities: ['firebolt', 'frostnova', 'blink', 'chain', 'meteor']
    },
    ranger: {
      name: 'Ranger', icon: '➶', glyph: '@', color: '#5fbf5a',
      blurb: 'Patient as stone, deadly at forty paces, never alone.',
      play: 'Quick Shot is free and builds Focus; standing still builds more. Spend it on Aimed Shot and Rain of Arrows. Traps and a wolf keep the melee off you.',
      res: { id: 'focus', name: 'Focus', color: '#6fd06a', max: 100, start: 40, regen: 4, still: 10 },
      base: { hp: 38, pow: 6, arm: 1, crit: 0.08, dodge: 0.06 }, grow: { hp: 7, pow: 1.1, arm: 0.3 },
      weapons: ['bow'], kit: { weapon: 'bow', armor: 'leather', cons: { potion: 3, recall: 1 } },
      abilities: ['quickshot', 'aimed', 'snare', 'wolf', 'rain']
    },
    cleric: {
      name: 'Cleric', icon: '☀', glyph: '@', color: '#e8c04a',
      blurb: 'A lantern-bearer of the Sunstone. Heals, shields, and smites the restless dead.',
      play: 'Durable and steady. Smite twice as hard against undead and abyssal things. Mend and Divine Shield keep you standing; Consecrate holds a chokepoint.',
      res: { id: 'faith', name: 'Faith', color: '#f0d060', max: 100, start: 50, regen: 4, hit: 6 },
      base: { hp: 42, pow: 5.5, arm: 2.5, crit: 0.05, dodge: 0.02 }, grow: { hp: 8, pow: 1.0, arm: 0.4 },
      weapons: ['mace', 'staff'], kit: { weapon: 'mace', armor: 'mail', cons: { potion: 2, recall: 1 } },
      abilities: ['smite', 'mend', 'consecrate', 'dshield', 'judgment']
    },
    necro: {
      name: 'Necromancer', icon: '☠', glyph: '@', color: '#7fd0b0',
      blurb: 'Every corpse is a recruit. Every death, a little more power.',
      play: 'Kills fill your Essence. Raise skeletons from corpses to fight for you, spear lines of foes, drain life to stay up, and detonate the dead.',
      res: { id: 'essence', name: 'Essence', color: '#7fe0c0', max: 100, start: 30, regen: 1, kill: 15 },
      base: { hp: 34, pow: 6.5, arm: 1, crit: 0.05, dodge: 0.03 }, grow: { hp: 6.5, pow: 1.15, arm: 0.25 },
      weapons: ['scythe', 'wand', 'staff'], kit: { weapon: 'scythe', armor: 'robe', cons: { potion: 3, recall: 1 } },
      abilities: ['bonespear', 'raise', 'drain', 'corpseboom', 'army']
    }
  };
  var CLASS_ORDER = ['warrior', 'rogue', 'mage', 'ranger', 'cleric', 'necro'];
  var ABILITY_LEVELS = [1, 2, 4, 7, 11];

  // ===========================================================================
  //  ABILITIES
  //  target: self | enemy (needs a visible enemy in range) | tile (any visible
  //  tile in range) | line (a direction) · mult: × power · cost · cd: turns
  // ===========================================================================
  var ABILITIES = {
    // --- warrior
    cleave: { name: 'Cleave', icon: '🌀', cost: 30, cd: 0, target: 'self', mult: 1.15, desc: 'Strike every adjacent enemy for 115% power.' },
    charge: { name: 'Charge', icon: '➤', cost: 20, cd: 6, target: 'enemy', range: 4, straight: true, mult: 1.5, desc: 'Rush up to 4 tiles in a straight line at an enemy: 150% damage and a 1-turn stun.' },
    warcry: { name: 'War Cry', icon: '📯', cost: 0, cd: 14, target: 'self', radius: 3, gain: 40, desc: 'Gain 40 Rage. Enemies within 3 tiles are Weakened (deal 30% less) for 4 turns.' },
    execute: { name: 'Execute', icon: '🪓', cost: 40, cd: 0, target: 'enemy', range: 1, mult: 2.0, desc: 'A heavy blow for 200% — doubled again against foes under 35% health. Kills refund 20 Rage.' },
    unbreakable: { name: 'Unbreakable', icon: '🛡', cost: 50, cd: 25, target: 'self', turns: 4, desc: 'For 4 turns take 60% less damage and cannot fall below 1 health.' },
    // --- rogue
    backstab: { name: 'Backstab', icon: '🔪', cost: 30, cd: 0, target: 'enemy', range: 1, mult: 1.7, desc: '170% damage. Always critical against sleeping, stunned or frozen foes.' },
    shadowstep: { name: 'Shadowstep', icon: '👣', cost: 25, cd: 6, target: 'enemy', range: 5, desc: 'Step out of the shadows beside an enemy within 5 tiles. Your next attack is critical.' },
    envenom: { name: 'Envenom', icon: '🐍', cost: 30, cd: 6, target: 'enemy', range: 1, mult: 0.9, desc: 'A poisoned cut: 90% damage plus heavy Poison for 6 turns.' },
    fan: { name: 'Fan of Knives', icon: '✴', cost: 45, cd: 3, target: 'self', radius: 2, mult: 0.9, desc: 'Hurl knives at every enemy within 2 tiles: 90% damage and Bleed.' },
    smoke: { name: 'Smoke Bomb', icon: '💨', cost: 50, cd: 20, target: 'self', turns: 5, desc: 'Vanish for 5 turns — enemies lose you. Adjacent foes are stunned for 2 turns.' },
    // --- mage
    firebolt: { name: 'Firebolt', icon: '🔥', cost: 10, cd: 0, target: 'enemy', range: 6, mult: 1.3, desc: 'A bolt of fire: 130% damage, 50% chance to Burn.' },
    frostnova: { name: 'Frost Nova', icon: '❄', cost: 20, cd: 8, target: 'self', radius: 2, mult: 0.8, desc: 'Freeze everything within 2 tiles for 2 turns (80% damage).' },
    blink: { name: 'Blink', icon: '✧', cost: 15, cd: 7, target: 'tile', range: 5, desc: 'Teleport to a visible tile within 5.' },
    chain: { name: 'Chain Lightning', icon: '⚡', cost: 28, cd: 4, target: 'enemy', range: 6, mult: 1.15, jumps: 3, desc: 'Lightning arcs from the target to 3 more enemies (115%, −15% per jump).' },
    meteor: { name: 'Meteor', icon: '☄', cost: 45, cd: 14, target: 'tile', range: 7, radius: 1, mult: 3.4, delay: 1, desc: 'Call a meteor on a 3×3 area. It lands next turn for 340% and sets the ground ablaze.' },
    // --- ranger
    quickshot: { name: 'Quick Shot', icon: '➶', cost: 0, cd: 0, target: 'enemy', range: 7, mult: 0.95, gain: 8, desc: 'A fast arrow: 95% damage. Free, and builds 8 Focus.' },
    aimed: { name: 'Aimed Shot', icon: '🎯', cost: 40, cd: 0, target: 'enemy', range: 9, mult: 2.3, pierce: true, desc: 'A drawn-out shot for 230% that pierces through every foe in its line.' },
    snare: { name: 'Snare Trap', icon: '⚙', cost: 25, cd: 8, target: 'tile', range: 3, mult: 1.0, turns: 3, desc: 'Set a trap within 3 tiles. The first enemy to step in takes 100% and is rooted for 3 turns.' },
    wolf: { name: 'Call Wolf', icon: '🐺', cost: 50, cd: 25, target: 'self', desc: 'A loyal wolf joins you for the rest of the floor.' },
    rain: { name: 'Rain of Arrows', icon: '☔', cost: 60, cd: 10, target: 'tile', range: 7, radius: 2, mult: 1.35, desc: 'Arrows fall on a 5×5 area for 135% damage.' },
    // --- cleric
    smite: { name: 'Smite', icon: '☀', cost: 14, cd: 0, target: 'enemy', range: 5, mult: 1.2, desc: 'Holy light for 120% — double against undead and abyssal foes.' },
    mend: { name: 'Mend', icon: '✚', cost: 30, cd: 4, target: 'self', heal: 0.3, desc: 'Heal 30% of your health and cleanse poison, burn and bleed.' },
    consecrate: { name: 'Consecrate', icon: '✺', cost: 35, cd: 10, target: 'self', radius: 1, mult: 0.55, turns: 5, desc: 'Hallow the ground around you for 5 turns: enemies on it take 55% each turn, you heal while standing in it.' },
    dshield: { name: 'Divine Shield', icon: '🔰', cost: 40, cd: 16, target: 'self', shield: 0.4, turns: 6, desc: 'A barrier absorbing damage equal to 40% of your health for 6 turns.' },
    judgment: { name: 'Judgment', icon: '⚖', cost: 60, cd: 14, target: 'self', mult: 1.5, desc: 'Every enemy you can see takes 150% holy damage. Undead are stunned.' },
    // --- necromancer
    bonespear: { name: 'Bone Spear', icon: '🦴', cost: 12, cd: 0, target: 'line', range: 6, mult: 1.1, pierce: true, desc: 'A spear of bone flies 6 tiles in a line, piercing everything for 110%.' },
    raise: { name: 'Raise Dead', icon: '💀', cost: 25, cd: 2, target: 'corpse', range: 5, desc: 'Raise a skeleton warrior from a corpse within 5 tiles (up to 2 at once).' },
    drain: { name: 'Drain Life', icon: '🩸', cost: 20, cd: 0, target: 'enemy', range: 5, mult: 1.0, drain: 0.6, desc: 'Drain 100% damage from a foe, healing 60% of it.' },
    corpseboom: { name: 'Corpse Explosion', icon: '💥', cost: 25, cd: 2, target: 'corpse', range: 6, radius: 1, mult: 1.9, desc: 'Detonate a corpse: 190% to everything within 1 tile of it.' },
    army: { name: 'Army of the Dead', icon: '⚰', cost: 70, cd: 25, target: 'self', radius: 5, turns: 12, desc: 'Every corpse within 5 tiles rises for 12 turns — no limit.' }
  };

  // ===========================================================================
  //  TALENTS — five tiers per class, one pick per tier.
  //  mods: flat stat changes (pct = fractions) · flag: engine hook
  // ===========================================================================
  var TALENT_LEVELS = [3, 6, 10, 14, 18];
  var TALENTS = {
    warrior: [
      [{ id: 'w_blood', name: 'Bloodthirst', desc: 'Basic hits heal 3% of your max health.', flag: 'hitHeal' },
       { id: 'w_skin', name: 'Thick Skin', desc: '+25% armor.', mods: { armPct: 0.25 } },
       { id: 'w_brute', name: 'Brute Force', desc: '+12% power.', mods: { powPct: 0.12 } }],
      [{ id: 'w_arc', name: 'Wide Arc', desc: 'Cleave deals 40% more and makes targets Bleed.', flag: 'cleaveBleed' },
       { id: 'w_jugg', name: 'Juggernaut', desc: 'Charge reaches 6 tiles and recharges 3 turns faster.', flag: 'jugg' },
       { id: 'w_trance', name: 'Battle Trance', desc: 'Rage never decays, and every floor starts with 30.', flag: 'trance' }],
      [{ id: 'w_intim', name: 'Intimidate', desc: 'War Cry also stuns for 1 turn.', flag: 'cryStun' },
       { id: 'w_retal', name: 'Retaliation', desc: '25% chance to strike back when hit in melee.', flag: 'retaliate' },
       { id: 'w_wind', name: 'Second Wind', desc: 'Once per floor, dropping below 30% health heals 35%.', lowhp: { heal: 0.35 } }],
      [{ id: 'w_exec', name: 'Executioner', desc: 'Execute doubles below 50% health instead of 35%.', flag: 'execHi' },
       { id: 'w_ramp', name: 'Rampage', desc: 'Each kill grants +6% power for 8 turns (stacks 5).', flag: 'rampage' },
       { id: 'w_wall', name: 'Shield Wall', desc: '15% chance to block a hit completely.', mods: { block: 0.15 } }],
      [{ id: 'w_avatar', name: 'Avatar of War', desc: 'Unbreakable also grants +35% damage and doubles Rage gain.', flag: 'avatar' },
       { id: 'w_quake', name: 'Earthshaker', desc: 'Every 4th basic attack sends a shockwave hitting all adjacent foes for 80%.', flag: 'quake' },
       { id: 'w_undying', name: 'Undying', desc: 'Once per floor, a killing blow leaves you at 25% health instead.', cheat: { heal: 0.25 } }]
    ],
    rogue: [
      [{ id: 'r_leth', name: 'Lethality', desc: '+35% critical damage.', mods: { critDmg: 0.35 } },
       { id: 'r_nimble', name: 'Nimble', desc: '+8% dodge.', mods: { dodge: 0.08 } },
       { id: 'r_pockets', name: 'Deep Pockets', desc: '+30% gold found, and potions heal 25% more.', mods: { goldFind: 0.3, potionPct: 0.25 } }],
      [{ id: 'r_assn', name: 'Assassin', desc: 'Backstab deals +60% to foes under half health.', flag: 'assassin' },
       { id: 'r_dance', name: 'Shadow Dance', desc: 'Shadowstep recharges 3 turns faster; kills refund 15 Energy.', flag: 'dance' },
       { id: 'r_traps', name: 'Trapfinder', desc: 'See every trap on the floor. Disarming one pays out.', flag: 'traps' }],
      [{ id: 'r_viru', name: 'Virulence', desc: 'Your poisons and bleeds deal 50% more.', flag: 'virulence' },
       { id: 'r_ripo', name: 'Riposte', desc: 'Dodging a melee attack strikes back for 100%.', flag: 'riposte' },
       { id: 'r_adren', name: 'Adrenaline', desc: '+4 Energy per turn.', mods: { resRegen: 4 } }],
      [{ id: 'r_flurry', name: 'Blade Flurry', desc: 'Basic attacks also hit another adjacent foe for 50%.', flag: 'flurry' },
       { id: 'r_vanish', name: 'Vanishing Act', desc: 'Once per floor, dropping below 25% health throws a free Smoke Bomb.', lowhp: { invis: 4, at: 0.25 } },
       { id: 'r_exploit', name: 'Exploit Weakness', desc: '+12% critical chance.', mods: { crit: 0.12 } }],
      [{ id: 'r_mark', name: 'Death Mark', desc: 'Critical hits Mark the target: it takes 25% more damage for 4 turns.', flag: 'deathmark' },
       { id: 'r_cloak', name: 'Cloak and Dagger', desc: 'Attacks from invisibility deal triple damage.', flag: 'cloak' },
       { id: 'r_cuts', name: 'Thousand Cuts', desc: 'Fan of Knives costs 25 and reaches 3 tiles.', flag: 'cuts' }]
    ],
    mage: [
      [{ id: 'm_mind', name: 'Arcane Mind', desc: '+30% max Mana and +1 Mana per turn.', mods: { resPct: 0.3, resRegen: 1 } },
       { id: 'm_pyro', name: 'Pyromancy', desc: 'Fire spells deal 25% more; burns tick harder.', flag: 'pyro' },
       { id: 'm_mshield', name: 'Mana Shield', desc: '30% of damage taken drains Mana instead of health.', flag: 'manashield' }],
      [{ id: 'm_ignite', name: 'Ignite', desc: 'Firebolt always Burns.', flag: 'ignite' },
       { id: 'm_shatter', name: 'Shatter', desc: 'Frozen enemies take 50% more damage.', flag: 'shatter' },
       { id: 'm_phase', name: 'Phase Shift', desc: 'Blink is free and grants 50% dodge for 2 turns.', flag: 'phase' }],
      [{ id: 'm_overload', name: 'Overload', desc: 'Chain Lightning jumps 2 more times.', flag: 'overload' },
       { id: 'm_clear', name: 'Clearcasting', desc: '20% chance for a spell to cost nothing.', flag: 'clearcast' },
       { id: 'm_glacial', name: 'Glacial Armor', desc: '+20% armor; melee attackers may be frozen.', mods: { armPct: 0.2 }, flag: 'glacial' }],
      [{ id: 'm_combust', name: 'Combustion', desc: 'Burning enemies take 25% more damage from everything.', flag: 'combust' },
       { id: 'm_ley', name: 'Leyline', desc: 'Resting restores 4× Mana.', flag: 'leyline' },
       { id: 'm_blade', name: 'Spellblade', desc: 'Basic attacks deal +40% and restore 3 Mana.', flag: 'spellblade' }],
      [{ id: 'm_armag', name: 'Armageddon', desc: 'Meteor strikes a 5×5 area.', flag: 'armageddon' },
       { id: 'm_arch', name: 'Archmage', desc: 'Spells cost 25% less and deal 20% more.', flag: 'archmage' },
       { id: 'm_block', name: 'Ice Block', desc: 'Once per floor, a killing blow encases you in ice: heal 30%, immune for 2 turns.', cheat: { heal: 0.3, inv: 2 } }]
    ],
    ranger: [
      [{ id: 'g_eye', name: 'Eagle Eye', desc: '+2 range on shots and +1 light.', mods: { range: 2, light: 1 } },
       { id: 'g_steady', name: 'Steady Hands', desc: '+10% critical chance; crits restore 10 Focus.', mods: { crit: 0.1 }, flag: 'steady' },
       { id: 'g_surv', name: 'Survivalist', desc: '+20% max health.', mods: { hpPct: 0.2 } }],
      [{ id: 'g_double', name: 'Double Tap', desc: 'Quick Shot fires twice (65% each).', flag: 'doubletap' },
       { id: 'g_barbed', name: 'Barbed Traps', desc: 'Snares make victims Bleed and recharge 4 turns faster.', flag: 'barbed' },
       { id: 'g_hop', name: 'Disengage', desc: 'Stepping away from an adjacent foe grants 20 Focus.', flag: 'hop' }],
      [{ id: 'g_alpha', name: 'Alpha Wolf', desc: 'Your wolf has 60% more health and damage.', flag: 'alpha' },
       { id: 'g_mark', name: "Hunter's Mark", desc: 'Aimed Shot Marks its first target: +30% damage taken for 5 turns.', flag: 'huntmark' },
       { id: 'g_camo', name: 'Camouflage', desc: 'Standing still for 2 turns hides you from enemies more than 2 tiles away.', flag: 'camo' }],
      [{ id: 'g_split', name: 'Splinter Shot', desc: 'Quick Shot ricochets to a second enemy.', flag: 'ricochet' },
       { id: 'g_pack', name: 'Pack Tactics', desc: 'Enemies next to your wolf take 25% more from you.', flag: 'pack' },
       { id: 'g_volley', name: 'Volley', desc: 'Rain of Arrows costs 20 less and covers 7×7.', flag: 'volley' }],
      [{ id: 'g_dead', name: 'Deadeye', desc: 'Shots from 4+ tiles away have +25% critical chance.', flag: 'deadeye' },
       { id: 'g_beast', name: 'Beastmaster', desc: 'Call Wolf brings two wolves.', flag: 'twowolves' },
       { id: 'g_cheat', name: 'Last Stand', desc: 'Once per floor, a killing blow leaves you at 30% health.', cheat: { heal: 0.3 } }]
    ],
    cleric: [
      [{ id: 'c_devout', name: 'Devout', desc: '+25 max Faith and +2 Faith per turn.', mods: { res: 25, resRegen: 2 } },
       { id: 'c_crus', name: 'Crusader', desc: 'Basic attacks deal 20% more and restore 6 Faith.', flag: 'crusader' },
       { id: 'c_bulwark', name: 'Bulwark', desc: '+30% armor.', mods: { armPct: 0.3 } }],
      [{ id: 'c_rad', name: 'Radiance', desc: 'Smite strikes a second enemy.', flag: 'radiance' },
       { id: 'c_renew', name: 'Renewal', desc: 'Mend also restores 4% health per turn for 5 turns.', flag: 'renew' },
       { id: 'c_ground', name: 'Holy Ground', desc: 'Consecrate covers 5×5.', flag: 'holyground' }],
      [{ id: 'c_martyr', name: 'Martyr', desc: 'When Divine Shield breaks it explodes for 150% around you.', flag: 'martyr' },
       { id: 'c_pen', name: 'Penance', desc: 'Smite has a 35% chance to stun.', flag: 'penance' },
       { id: 'c_grace', name: 'Grace', desc: 'Potions heal 50% more.', mods: { potionPct: 0.5 } }],
      [{ id: 'c_wrath', name: 'Wrath', desc: '+30% damage against elites and bosses.', flag: 'wrath' },
       { id: 'c_aegis', name: 'Aegis', desc: 'Divine Shield recharges 6 turns faster and cleanses you.', flag: 'aegis' },
       { id: 'c_hammer', name: 'Blessed Hammer', desc: 'Basic attacks splash 35% holy damage on adjacent foes.', flag: 'hammer' }],
      [{ id: 'c_rez', name: 'Resurrection', desc: 'Once per floor, a killing blow leaves you at 50% health.', cheat: { heal: 0.5 } },
       { id: 'c_day', name: 'Day of Judgment', desc: 'Judgment heals you 4% for each enemy it hits.', flag: 'dayjudge' },
       { id: 'c_sanct', name: 'Sanctified', desc: 'Consecrated ground follows you and lasts 10 turns.', flag: 'sanctified' }]
    ],
    necro: [
      [{ id: 'n_lord', name: 'Grave Lord', desc: '+1 skeleton at once.', flag: 'gravelord' },
       { id: 'n_pact', name: 'Blood Pact', desc: '+20% max health; Drain Life heals 30% more.', mods: { hpPct: 0.2 }, flag: 'pact' },
       { id: 'n_siphon', name: 'Soul Siphon', desc: 'Kills grant 10 more Essence.', mods: { resKill: 10 } }],
      [{ id: 'n_marrow', name: 'Marrow Spear', desc: 'Bone Spear deals 40% more and Slows.', flag: 'marrow' },
       { id: 'n_bonearm', name: 'Bone Armor', desc: '+4 armor per living minion.', flag: 'bonearmor' },
       { id: 'n_wither', name: 'Withering', desc: 'Drain Life Weakens its target.', flag: 'wither' }],
      [{ id: 'n_mages', name: 'Skeletal Mages', desc: 'Raised skeletons attack from range.', flag: 'skelmages' },
       { id: 'n_chain', name: 'Chain Reaction', desc: 'Corpse Explosion reaches 2 tiles.', flag: 'chainboom' },
       { id: 'n_chill', name: 'Deathly Chill', desc: 'Your hits have a 15% chance to Freeze.', mods: { freezeOnHit: 0.15 } }],
      [{ id: 'n_frenzy', name: 'Unholy Frenzy', desc: 'Minions deal 50% more and act faster.', flag: 'frenzy' },
       { id: 'n_leech', name: 'Leech', desc: '6% of all damage you deal heals you.', mods: { lifesteal: 0.06 } },
       { id: 'n_plague', name: 'Plague', desc: 'Bone Spear poisons; poisoned foes spread poison when they die.', flag: 'plague' }],
      [{ id: 'n_lich', name: 'Lichdom', desc: 'Once per floor, a killing blow turns you to a lich: heal 40%, immune for 3 turns.', cheat: { heal: 0.4, inv: 3 } },
       { id: 'n_legion', name: 'Legion', desc: 'Army of the Dead raises at least 4, corpses or not.', flag: 'legion' },
       { id: 'n_harvest', name: 'Soul Harvest', desc: 'Each kill grants +2% power for the floor (up to 30%).', flag: 'harvest' }]
    ]
  };

  // ===========================================================================
  //  BIOMES / ACTS — five floors each; floor 5 of an act is the boss arena.
  //  hue/sat: renderer derives theme-aware tiles · light: torch radius
  // ===========================================================================
  var BIOMES = {
    crypt: { act: 1, name: 'The Sunken Crypts', short: 'Crypts', icon: '⚱', hue: 32, sat: 14, wallHue: 30, accent: '#d9b26a', light: 6,
      mons: ['rat', 'skeleton', 'skarcher', 'ghoul', 'bonepriest', 'brute', 'wisp', 'cutpurse'],
      hazards: { water: 0.25, gas: 0, lava: 0, chasm: 0, vents: 0.3, fungus: 0 }, traps: ['spike', 'dart', 'alarm', 'pit'],
      decor: ['bones', 'urn', 'coffin', 'candle'], boss: 'callum', mat: 'scrap',
      flavor: ['Dust sifts from the vaulted ceiling.', 'Somewhere, bones settle with a sigh.', 'Names have been chiselled off every tomb here.'] },
    fungal: { act: 2, name: 'The Mycelial Hollows', short: 'Hollows', icon: '🍄', hue: 150, sat: 22, wallHue: 280, accent: '#8fe08a', light: 5,
      mons: ['sporeling', 'myconid', 'spitter', 'spider', 'shaman', 'hulk', 'rat'],
      hazards: { water: 0.15, gas: 0.45, lava: 0, chasm: 0, vents: 0.25, fungus: 0.6 }, traps: ['spike', 'gas', 'net', 'alarm'],
      decor: ['shroom', 'shroom', 'spores', 'roots'], boss: 'mother', mat: 'spore',
      flavor: ['The walls breathe out a slow, sweet rot.', 'Glowcaps pulse in time with something far away.', 'Threads of white hyphae twitch toward your torch.'] },
    flooded: { act: 3, name: 'The Drowned Archive', short: 'Archive', icon: '🌊', hue: 195, sat: 26, wallHue: 210, accent: '#5fd0e0', light: 6,
      mons: ['drowned', 'lurker', 'crab', 'siren', 'tidecaller', 'specter', 'cutpurse'],
      hazards: { water: 0.9, gas: 0, lava: 0, chasm: 0, vents: 0, fungus: 0 }, traps: ['dart', 'net', 'tele', 'alarm'],
      decor: ['shelf', 'books', 'pillar', 'kelp'], boss: 'nhal', mat: 'pearl',
      flavor: ['Waterlogged pages drift past your ankles.', 'The current tugs toward the deeper stacks.', 'An inkwell bobs by, still full.'] },
    forge: { act: 4, name: 'The Cinder Forge', short: 'Forge', icon: '🌋', hue: 14, sat: 30, wallHue: 8, accent: '#ff7a3a', light: 7,
      mons: ['imp', 'magmite', 'hound', 'golem', 'salamander', 'ashpriest'],
      hazards: { water: 0, gas: 0.1, lava: 0.8, chasm: 0, vents: 0.6, fungus: 0 }, traps: ['fire', 'spike', 'dart', 'alarm'],
      decor: ['anvil', 'chain', 'ingot', 'brazier'], boss: 'brann', mat: 'cinder',
      flavor: ['The air shimmers; your armor ticks as it heats.', 'Far off, a hammer rings — slow, patient, endless.', 'Slag cools into black glass underfoot.'] },
    abyss: { act: 5, name: 'The Abyss', short: 'Abyss', icon: '🌀', hue: 265, sat: 26, wallHue: 270, accent: '#b48cff', light: 4,
      mons: ['shade', 'voidspawn', 'watcher', 'knight', 'whisperer', 'acolyte'],
      hazards: { water: 0, gas: 0.2, lava: 0, chasm: 0.8, vents: 0.2, fungus: 0 }, traps: ['tele', 'fire', 'gas', 'net'],
      decor: ['crystal', 'eye', 'rune', 'obelisk'], boss: 'aurel', mat: 'void',
      flavor: ['The dark here is not an absence. It is a presence.', 'Your torch gutters, though there is no wind.', 'Someone whispers your name in your own voice.'] }
  };
  var BIOME_ORDER = ['crypt', 'fungal', 'flooded', 'forge', 'abyss'];
  var ACT_FLOORS = 5;
  var STORY_FLOORS = 25;

  // ===========================================================================
  //  MONSTERS — baseline numbers for monster level 1 (the engine scales them by
  //  level, difficulty and New Game+ cycle).
  //  ai: melee | swarm | brute | archer | caster | charger | bomber | summoner |
  //      healer | thief | ambush | ghost | turret · fam: undead/beast/fungus/...
  // ===========================================================================
  var MONSTERS = {
    // crypts
    rat:        { name: 'Grave Rat', ch: 'r', col: '#9b8a76', fam: 'beast', ai: 'swarm', hp: 6, pow: 3, arm: 0, spd: 150, xp: 3, gold: 1, pack: [2, 4] },
    skeleton:   { name: 'Skeleton', ch: 's', col: '#e6dfc8', fam: 'undead', ai: 'melee', hp: 14, pow: 5, arm: 2, spd: 100, xp: 6, gold: 3 },
    skarcher:   { name: 'Skeleton Archer', ch: 'a', col: '#d8cfb0', fam: 'undead', ai: 'archer', hp: 10, pow: 5, arm: 1, spd: 100, xp: 7, gold: 3, range: 6 },
    ghoul:      { name: 'Ghoul', ch: 'g', col: '#8fae7a', fam: 'undead', ai: 'melee', hp: 18, pow: 5, arm: 1, spd: 100, xp: 8, gold: 3, onHit: { poison: 0.35 } },
    bonepriest: { name: 'Bone Priest', ch: 'p', col: '#c9b06a', fam: 'undead', ai: 'healer', hp: 14, pow: 4, arm: 1, spd: 100, xp: 10, gold: 6, raises: 'skeleton', minDepth: 2 },
    brute:      { name: 'Gravewarden', ch: 'B', col: '#8a7a9a', fam: 'undead', ai: 'brute', hp: 34, pow: 7, arm: 3, spd: 100, xp: 16, gold: 8, minDepth: 3 },
    wisp:       { name: 'Lantern Wisp', ch: 'w', col: '#ffd27a', fam: 'spirit', ai: 'caster', hp: 8, pow: 4, arm: 0, spd: 150, xp: 6, gold: 2, elem: 'fire', range: 5 },
    cutpurse:   { name: 'Cutpurse', ch: 't', col: '#b0a090', fam: 'human', ai: 'thief', hp: 12, pow: 3, arm: 1, spd: 150, xp: 6, gold: 12, minDepth: 2, rare: true },
    // fungal hollows
    sporeling:  { name: 'Sporeling', ch: 'o', col: '#c8a0e0', fam: 'fungus', ai: 'melee', hp: 9, pow: 4, arm: 0, spd: 100, xp: 4, gold: 2, deathGas: 1, pack: [2, 3] },
    myconid:    { name: 'Myconid', ch: 'm', col: '#d08a6a', fam: 'fungus', ai: 'melee', hp: 24, pow: 6, arm: 2, spd: 75, xp: 9, gold: 4 },
    spitter:    { name: 'Spore Spitter', ch: 'f', col: '#a0d070', fam: 'fungus', ai: 'archer', hp: 13, pow: 5, arm: 1, spd: 100, xp: 8, gold: 4, range: 5, onHit: { poison: 0.6 } },
    spider:     { name: 'Cave Spider', ch: 'x', col: '#7a6a8a', fam: 'beast', ai: 'swarm', hp: 12, pow: 5, arm: 1, spd: 150, xp: 8, gold: 3, onHit: { root: 0.25 } },
    shaman:     { name: 'Shroom Shaman', ch: 'S', col: '#e070c0', fam: 'fungus', ai: 'summoner', hp: 18, pow: 4, arm: 1, spd: 100, xp: 14, gold: 8, summons: 'sporeling', minDepth: 7 },
    hulk:       { name: 'Fungal Hulk', ch: 'H', col: '#b08060', fam: 'fungus', ai: 'brute', hp: 44, pow: 8, arm: 3, spd: 75, xp: 20, gold: 10, minDepth: 7 },
    // drowned archive
    drowned:    { name: 'Drowned Scribe', ch: 'd', col: '#6a9aa8', fam: 'undead', ai: 'melee', hp: 28, pow: 7, arm: 3, spd: 75, xp: 10, gold: 5 },
    lurker:     { name: 'Eel Lurker', ch: 'e', col: '#4ab0a0', fam: 'beast', ai: 'ambush', hp: 20, pow: 7, arm: 1, spd: 150, xp: 11, gold: 4, swim: 1, onHit: { bleed: 0.4 } },
    crab:       { name: 'Archive Crab', ch: 'c', col: '#e08a6a', fam: 'beast', ai: 'melee', hp: 22, pow: 6, arm: 9, spd: 75, xp: 10, gold: 6 },
    siren:      { name: 'Siren', ch: 'n', col: '#80d0f0', fam: 'spirit', ai: 'archer', hp: 18, pow: 6, arm: 1, spd: 100, xp: 12, gold: 6, range: 6, pull: 1 },
    tidecaller: { name: 'Tidecaller', ch: 'T', col: '#4a90d0', fam: 'human', ai: 'caster', hp: 24, pow: 7, arm: 2, spd: 100, xp: 16, gold: 9, elem: 'wave', range: 7, minDepth: 12 },
    specter:    { name: 'Ink Specter', ch: 'z', col: '#5a5a8a', fam: 'spirit', ai: 'ghost', hp: 20, pow: 6, arm: 0, spd: 100, xp: 12, gold: 5, onHit: { weaken: 0.4 } },
    // cinder forge
    imp:        { name: 'Cinder Imp', ch: 'i', col: '#ff9a4a', fam: 'demon', ai: 'archer', hp: 16, pow: 6, arm: 1, spd: 150, xp: 11, gold: 6, range: 5, onHit: { burn: 0.5 }, fireproof: 1 },
    magmite:    { name: 'Magmite', ch: 'b', col: '#ff5a2a', fam: 'elemental', ai: 'bomber', hp: 14, pow: 11, arm: 2, spd: 100, xp: 10, gold: 4, fireproof: 1 },
    hound:      { name: 'Cinder Hound', ch: 'h', col: '#d06a3a', fam: 'beast', ai: 'charger', hp: 26, pow: 7, arm: 2, spd: 125, xp: 14, gold: 6, fireproof: 1 },
    golem:      { name: 'Forge Golem', ch: 'G', col: '#9a8a7a', fam: 'construct', ai: 'brute', hp: 56, pow: 9, arm: 8, spd: 75, xp: 26, gold: 14, fireproof: 1, minDepth: 17 },
    salamander: { name: 'Salamander', ch: 'l', col: '#ff7a5a', fam: 'beast', ai: 'melee', hp: 30, pow: 7, arm: 2, spd: 100, xp: 14, gold: 6, trail: 'fire', fireproof: 1 },
    ashpriest:  { name: 'Ash Priest', ch: 'q', col: '#b0a0a0', fam: 'human', ai: 'healer', hp: 24, pow: 5, arm: 2, spd: 100, xp: 16, gold: 10, shields: 1, minDepth: 17 },
    // abyss
    shade:      { name: 'Shade', ch: 'v', col: '#6a5aa0', fam: 'abyssal', ai: 'ambush', hp: 26, pow: 8, arm: 1, spd: 150, xp: 16, gold: 7, crit: 0.25 },
    voidspawn:  { name: 'Void Spawn', ch: 'u', col: '#9a6ae0', fam: 'abyssal', ai: 'melee', hp: 34, pow: 7, arm: 2, spd: 100, xp: 14, gold: 6, splits: 1 },
    watcher:    { name: 'Watcher', ch: 'W', col: '#e0d070', fam: 'abyssal', ai: 'archer', hp: 30, pow: 8, arm: 3, spd: 75, xp: 18, gold: 9, range: 8, beam: 1 },
    knight:     { name: 'Abyssal Knight', ch: 'K', col: '#5a4a7a', fam: 'abyssal', ai: 'charger', hp: 54, pow: 9, arm: 7, spd: 100, xp: 26, gold: 14, slam: 1, minDepth: 22 },
    whisperer:  { name: 'Whisperer', ch: 'y', col: '#c08ae0', fam: 'abyssal', ai: 'caster', hp: 28, pow: 7, arm: 1, spd: 100, xp: 18, gold: 9, elem: 'void', range: 6 },
    acolyte:    { name: 'Hollow Acolyte', ch: 'A', col: '#8a7ab0', fam: 'human', ai: 'summoner', hp: 30, pow: 6, arm: 2, spd: 100, xp: 20, gold: 12, summons: 'shade', minDepth: 22 },
    // anywhere
    mimic:      { name: 'Mimic', ch: 'M', col: '#c8a050', fam: 'construct', ai: 'melee', hp: 40, pow: 9, arm: 3, spd: 100, xp: 24, gold: 40 },
    // summons (allies use these too)
    skelally:   { name: 'Risen Skeleton', ch: 's', col: '#a8e0c8', fam: 'undead', ai: 'melee', hp: 18, pow: 5, arm: 2, spd: 100, xp: 0, gold: 0 },
    skelmage:   { name: 'Risen Bonecaster', ch: 'a', col: '#a8e0c8', fam: 'undead', ai: 'archer', hp: 14, pow: 5, arm: 1, spd: 100, xp: 0, gold: 0, range: 5 },
    wolf:       { name: 'Wolf', ch: 'W', col: '#b8a88a', fam: 'beast', ai: 'melee', hp: 26, pow: 5, arm: 2, spd: 150, xp: 0, gold: 0 }
  };

  // Elite affixes — rolled onto champions (always drop magic+ loot).
  var ELITE = {
    vampiric:  { name: 'Vampiric', col: '#e04a5a', desc: 'heals itself when it hits' },
    shielded:  { name: 'Shielded', col: '#6ab0ff', desc: 'regrows a damage shield every 5 turns' },
    splitting: { name: 'Splitting', col: '#b08aff', desc: 'splits in two when slain' },
    hasted:    { name: 'Hasted', col: '#ffe06a', desc: 'moves and attacks twice as often' },
    berserk:   { name: 'Berserk', col: '#ff6a3a', desc: 'deals much more damage when wounded' },
    molten:    { name: 'Molten', col: '#ff8a2a', desc: 'burns on hit and leaves fire behind' },
    thorned:   { name: 'Thorned', col: '#8ad06a', desc: 'reflects melee damage' },
    blinking:  { name: 'Blinking', col: '#d08aff', desc: 'teleports to you' },
    venomous:  { name: 'Venomous', col: '#7ae07a', desc: 'poisons on hit' },
    warded:    { name: 'Warded', col: '#e0e0e0', desc: 'immune to stun, freeze and root' }
  };

  // ===========================================================================
  //  BOSSES — multi-phase. Each phase: at (health fraction it starts below),
  //  line (spoken), moves (the engine's boss kit for that phase).
  // ===========================================================================
  var BOSSES = {
    callum: { name: 'Ser Callum the Hollow', title: 'Last Squire of the Lantern Order', ch: 'C', col: '#d0c090', fam: 'undead', hp: 260, pow: 9, arm: 4, spd: 100, xp: 220, gold: 160,
      intro: ['A knight kneels before an empty bier, his lantern long dead.', '"Twenty years I have kept this door. My lord told me no one would come."', '"He told me, if anyone came — to make sure they never reached him."'],
      phases: [{ at: 1.0, moves: ['sweep', 'strike'] }, { at: 0.5, line: '"Rise, brothers! The Order stands its watch!"', moves: ['sweep', 'lunge', 'raise'] }],
      death: '"He went down… to listen… Tell Maren… I kept the door."' },
    mother: { name: 'The Mother of Spores', title: 'Heart of the Hollows', ch: 'Ω', col: '#d07ad0', fam: 'fungus', hp: 400, pow: 10, arm: 3, spd: 75, xp: 420, gold: 260,
      intro: ['The cavern itself is the creature — a pulsing knot of caps and threads.', '"Little warm thing. The Deep is dreaming, and we are its thoughts."', '"Its dreamer wears a crown of rust. Lie down. Become a thought too."'],
      phases: [{ at: 1.0, moves: ['spores', 'brood'] }, { at: 0.5, line: '"Bloom! BLOOM!"', moves: ['spores', 'brood', 'cloud'], spd: 100 }],
      death: 'The threads go slack. Somewhere far below, a dreamer stirs.' },
    nhal: { name: 'Archivist Nhal', title: 'Keeper of the Drowned Stacks', ch: 'N', col: '#6ac0e0', fam: 'undead', hp: 520, pow: 12, arm: 4, spd: 100, xp: 640, gold: 380,
      intro: ['A drowned scholar turns the pages of a book that has dissolved to pulp.', '"Odo sent you? Dear boy. He always skipped the footnotes."', '"I recorded everything — what Aurel drank, what it made him. You will not read it."'],
      phases: [{ at: 1.0, moves: ['wave', 'bolt', 'phase'] }, { at: 0.5, line: '"Then let the tide take the evidence — and you."', moves: ['wave', 'crosswave', 'bolt', 'phase', 'drowned'] }],
      death: '"Page… four hundred… and twelve. He drank from the Heart… to seal it… and it… sealed him."' },
    brann: { name: 'Forgemaster Brann', title: 'Smith of the Black Lantern', ch: 'F', col: '#ff8a4a', fam: 'construct', hp: 680, pow: 14, arm: 9, spd: 100, xp: 900, gold: 520, fireproof: 1,
      intro: ['A dwarf of iron and cinder hammers at an anvil that glows black.', '"Torvald\'s sending errand-runners now? My brother never could finish a job."', '"The Hollow King wants his lantern done. And I always finish a job."'],
      phases: [{ at: 1.0, moves: ['slam', 'erupt'] }, { at: 0.4, line: '"HOTTER! The forge wants MORE!"', moves: ['bigslam', 'erupt', 'erupt'], spd: 150 }],
      death: '"Tell Torvald… the black lantern… isn\'t finished. He can\'t light it… without the last… flame."' },
    aurel: { name: 'Aurel Vane, the Hollow King', title: 'Once the Lantern Knight', ch: 'Ψ', col: '#c8b0ff', fam: 'abyssal', hp: 1100, pow: 16, arm: 8, spd: 100, xp: 1600, gold: 1000, final: 1,
      intro: ['At the bottom of everything, a man in tarnished gold holds a lantern that pours out darkness.', '"Maren\'s champion. I can smell the inn\'s smoke on you."', '"I went down to seal the Deep, and it showed me the truth: it was never a prison. It is a door. And I am going home."'],
      phases: [{ at: 1.0, moves: ['lunge', 'sweep', 'strike'] }, { at: 0.66, line: '"Let the Lantern show you what I saw."', moves: ['beam', 'shades', 'darkness', 'lunge'] }, { at: 0.33, line: '"I AM THE DOOR."', moves: ['crossbeam', 'erupt', 'shades', 'lunge'], spd: 150 }],
      death: 'The Black Lantern cracks. For one heartbeat, Aurel looks up at you — just a tired man. "Tell my sister… I\'m sorry I was late."' }
  };
  // A boss for each endless milestone (every 5th floor past the story): an empowered echo.
  var ECHO_ORDER = ['callum', 'mother', 'nhal', 'brann', 'aurel'];

  // ===========================================================================
  //  ITEMS
  // ===========================================================================
  var SLOTS = ['weapon', 'armor', 'helm', 'charm'];
  var SLOT_NAMES = { weapon: 'Weapon', armor: 'Armor', helm: 'Helm', charm: 'Charm' };
  // main: the stat that grows with item level · m: multiplier on it · innate: built-in stats
  var BASES = {
    sword:   { slot: 'weapon', main: 'pow', m: 1.0, innate: { crit: 0.03 }, icon: '🗡', names: ['Rusty Sword', 'Iron Longsword', "Knight's Blade", 'Runed Greatsword', 'Sunsteel Blade', 'Starforged Brand'] },
    axe:     { slot: 'weapon', main: 'pow', m: 1.12, innate: { critDmg: 0.15 }, icon: '🪓', names: ['Hatchet', 'Bearded Axe', 'War Axe', 'Executioner Axe', 'Cinderbite Axe', 'Worldcleaver'] },
    mace:    { slot: 'weapon', main: 'pow', m: 0.98, innate: { stunOnHit: 0.06 }, icon: '🔨', names: ['Cudgel', 'Flanged Mace', 'Morning Star', 'Holy Hammer', 'Lanternmaul', 'Dawnhammer'] },
    dagger:  { slot: 'weapon', main: 'pow', m: 0.86, innate: { crit: 0.08 }, icon: '🔪', names: ['Shiv', 'Stiletto', 'Kris', 'Shadowfang', 'Nightneedle', 'Whispersteel'] },
    staff:   { slot: 'weapon', main: 'pow', m: 0.92, innate: { resPct: 0.15 }, icon: '🪄', names: ['Walking Staff', 'Oak Staff', 'Runed Staff', 'Arcanist Staff', 'Stormspire', 'Staff of Eons'] },
    wand:    { slot: 'weapon', main: 'pow', m: 0.84, innate: { abilPct: 0.12 }, icon: '✨', names: ['Twig Wand', 'Bone Wand', 'Crystal Wand', 'Ebon Wand', 'Wand of Whispers', 'Voidrod'] },
    bow:     { slot: 'weapon', main: 'pow', m: 1.0, innate: { crit: 0.04 }, icon: '🏹', names: ['Short Bow', 'Hunting Bow', 'Longbow', 'Composite Bow', 'Windrunner', 'Starshot'] },
    scythe:  { slot: 'weapon', main: 'pow', m: 0.98, innate: { lifesteal: 0.03 }, icon: '⚚', names: ['Sickle', 'Grave Scythe', 'Reaper', 'Soulreaver', 'Deathharvest', 'Eclipse Scythe'] },
    plate:   { slot: 'armor', main: 'arm', m: 1.35, innate: { dodge: -0.03 }, icon: '🛡', names: ['Patched Plate', 'Iron Plate', 'Knight Plate', 'Gothic Plate', 'Forgeguard Plate', 'Sunsteel Aegis'] },
    mail:    { slot: 'armor', main: 'arm', m: 1.0, innate: { hp: 6 }, icon: '⛓', names: ['Rusty Mail', 'Chain Mail', 'Scale Mail', 'Banded Mail', 'Wyrmscale', 'Starweave Mail'] },
    leather: { slot: 'armor', main: 'arm', m: 0.72, innate: { dodge: 0.05 }, icon: '🦺', names: ['Hide Vest', 'Leather Jerkin', 'Studded Leather', 'Shadow Leathers', 'Nightstalker Garb', 'Wraithskin'] },
    robe:    { slot: 'armor', main: 'arm', m: 0.45, innate: { resRegen: 1, resPct: 0.1 }, icon: '👘', names: ['Frayed Robe', 'Acolyte Robe', 'Mystic Robe', 'Archon Robe', 'Starwoven Robe', 'Vestments of Eons'] },
    helm:    { slot: 'helm', main: 'arm', m: 0.5, innate: { hp: 4 }, icon: '⛑', names: ['Cap', 'Iron Helm', 'Great Helm', 'Crested Helm', 'Forgeguard Helm', 'Crown of Dawn'] },
    hood:    { slot: 'helm', main: 'arm', m: 0.32, innate: { crit: 0.03 }, icon: '🎭', names: ['Cowl', 'Leather Hood', 'Shadow Hood', 'Nightmask', 'Veil of Echoes', 'Faceless Mask'] },
    circlet: { slot: 'helm', main: 'arm', m: 0.24, innate: { abilPct: 0.06 }, icon: '👑', names: ['Copper Circlet', 'Silver Circlet', 'Gem Circlet', 'Arcane Diadem', 'Starlit Diadem', 'Halo of Eons'] },
    ring:    { slot: 'charm', main: null, m: 0, innate: {}, icon: '💍', names: ['Brass Ring', 'Silver Ring', 'Gold Ring', 'Signet', 'Ring of Echoes', 'Band of Stars'] },
    amulet:  { slot: 'charm', main: null, m: 0, innate: {}, icon: '📿', names: ['Bone Charm', 'Amulet', 'Talisman', 'Sacred Amulet', 'Heartstone', 'Star Pendant'] }
  };
  var SLOT_BASES = { weapon: ['sword', 'axe', 'mace', 'dagger', 'staff', 'wand', 'bow', 'scythe'], armor: ['plate', 'mail', 'leather', 'robe'], helm: ['helm', 'hood', 'circlet'], charm: ['ring', 'amulet'] };

  var RARITIES = {
    common:    { name: 'Common', col: '#b8bcc4', n: [0, 0], w: 52, main: 1.0, val: 1 },
    magic:     { name: 'Magic', col: '#5aa8ff', n: [1, 2], w: 30, main: 1.04, val: 2 },
    rare:      { name: 'Rare', col: '#f0c83a', n: [3, 3], w: 13, main: 1.08, val: 4 },
    epic:      { name: 'Epic', col: '#c070ff', n: [4, 4], w: 4, main: 1.14, val: 8 },
    legendary: { name: 'Legendary', col: '#ff8a2a', n: [0, 0], w: 0.7, main: 1.2, val: 16 },
    set:       { name: 'Set', col: '#3ad08a', n: [0, 0], w: 0.5, main: 1.15, val: 12 }
  };
  var RARITY_ORDER = ['common', 'magic', 'rare', 'epic', 'legendary', 'set'];

  // Affixes: per-ilvl scaling value `v: [base, perLevel]` (or pct ranges).
  // slots: where it can roll · pre/suf: naming
  var AFFIXES = {
    pow:       { name: 'Power', fmt: '+{v} power', v: [1, 0.35], slots: ['weapon', 'charm', 'helm'], pre: 'Cruel', w: 10 },
    powPct:    { name: 'Power %', fmt: '+{p} power', pct: [0.05, 0.12], slots: ['weapon', 'charm'], pre: 'Vicious', w: 6 },
    arm:       { name: 'Armor', fmt: '+{v} armor', v: [1, 0.3], slots: ['armor', 'helm', 'charm'], pre: 'Sturdy', w: 10 },
    hp:        { name: 'Health', fmt: '+{v} health', v: [6, 2.2], slots: ['armor', 'helm', 'charm', 'weapon'], suf: 'of the Bear', w: 12 },
    hpPct:     { name: 'Health %', fmt: '+{p} health', pct: [0.05, 0.12], slots: ['armor', 'charm'], suf: 'of Vigor', w: 5 },
    crit:      { name: 'Crit', fmt: '+{p} crit chance', pct: [0.03, 0.08], slots: ['weapon', 'helm', 'charm'], pre: 'Keen', w: 8 },
    critDmg:   { name: 'Crit damage', fmt: '+{p} crit damage', pct: [0.12, 0.35], slots: ['weapon', 'charm'], suf: 'of Ruin', w: 6 },
    dodge:     { name: 'Dodge', fmt: '+{p} dodge', pct: [0.02, 0.06], slots: ['armor', 'helm', 'charm'], suf: 'of the Cat', w: 6 },
    lifesteal: { name: 'Lifesteal', fmt: '{p} lifesteal', pct: [0.02, 0.06], slots: ['weapon', 'charm'], pre: 'Vampiric', w: 5 },
    regen:     { name: 'Regeneration', fmt: '+{v} health every 4 turns', v: [1, 0.12], slots: ['armor', 'charm', 'helm'], suf: 'of the Troll', w: 6 },
    res:       { name: 'Resource', fmt: '+{v} max resource', v: [6, 0.4], slots: ['helm', 'charm', 'armor'], suf: 'of the Owl', w: 6 },
    resRegen:  { name: 'Resource regen', fmt: '+{v} resource per turn', v: [1, 0.04], slots: ['charm', 'helm'], suf: 'of Focus', w: 4 },
    thorns:    { name: 'Thorns', fmt: 'Reflect {p} melee damage', pct: [0.1, 0.3], slots: ['armor'], pre: 'Spiked', w: 4 },
    burnOnHit: { name: 'Burning', fmt: '{p} chance to Burn', pct: [0.08, 0.2], slots: ['weapon'], pre: 'Flaming', w: 4 },
    poisonOnHit: { name: 'Venom', fmt: '{p} chance to Poison', pct: [0.1, 0.25], slots: ['weapon'], pre: 'Venomous', w: 4 },
    stunOnHit: { name: 'Stun', fmt: '{p} chance to Stun', pct: [0.04, 0.1], slots: ['weapon'], pre: 'Brutal', w: 3 },
    freezeOnHit: { name: 'Frost', fmt: '{p} chance to Freeze', pct: [0.04, 0.1], slots: ['weapon'], pre: 'Glacial', w: 3 },
    goldFind:  { name: 'Gold find', fmt: '+{p} gold found', pct: [0.1, 0.3], slots: ['helm', 'charm'], suf: 'of Greed', w: 5 },
    magicFind: { name: 'Magic find', fmt: '+{p} better loot', pct: [0.08, 0.25], slots: ['helm', 'charm'], suf: 'of Fortune', w: 4 },
    abilPct:   { name: 'Ability damage', fmt: '+{p} ability damage', pct: [0.06, 0.16], slots: ['weapon', 'helm', 'charm'], pre: 'Arcane', w: 6 },
    light:     { name: 'Light', fmt: '+{v} light radius', v: [1, 0], max: 2, slots: ['helm', 'charm'], suf: 'of Radiance', w: 3 },
    resist:    { name: 'Resilience', fmt: '{p} shorter poison/burn/bleed', pct: [0.1, 0.3], slots: ['armor', 'helm'], suf: 'of Warding', w: 4 },
    elite:     { name: 'Slaying', fmt: '+{p} damage to elites & bosses', pct: [0.08, 0.2], slots: ['weapon', 'charm'], suf: 'of Slaying', w: 4 }
  };

  // Uniques: fixed names and stats plus a special power (flag) the engine knows.
  var UNIQUES = {
    gravecaller: { base: 'scythe', name: 'Gravecaller', lore: 'It hums a lullaby to the dead, and they get up to listen.', aff: { powPct: 0.12, lifesteal: 0.05 }, flag: 'u_gravecaller', power: 'Kills have a 20% chance to raise a skeleton ally.', minAct: 1 },
    dawnbreaker: { base: 'mace', name: 'Dawnbreaker', lore: 'Forged from the first shard of the Sunstone.', aff: { pow: 1.5, burnOnHit: 0.2 }, flag: 'u_dawn', power: 'Deals 50% more to undead and abyssal foes.', minAct: 1 },
    whisper: { base: 'dagger', name: 'Whisper', lore: 'You never hear it leave the sheath.', aff: { critDmg: 0.4, dodge: 0.04 }, flag: 'u_whisper', power: 'Your first hit on every enemy is critical.', minAct: 1 },
    stormlash: { base: 'staff', name: 'Stormlash', lore: 'Struck by lightning nine times — it liked it.', aff: { abilPct: 0.2, res: 1.5 }, flag: 'u_storm', power: 'Hits have a 15% chance to arc lightning to a nearby foe.', minAct: 2 },
    heartseeker: { base: 'bow', name: 'Heartseeker', lore: 'The arrow always knows the way.', aff: { crit: 0.08, critDmg: 0.3 }, flag: 'u_heart', power: 'Aimed Shot is always critical.', minAct: 2 },
    kingslayer: { base: 'sword', name: 'Kingslayer', lore: 'Its edge was honed on crowns.', aff: { pow: 1.6, elite: 0.25 }, flag: 'u_king', power: '+40% damage to bosses.', minAct: 2 },
    ironwall: { base: 'plate', name: 'Ironwall', lore: 'Made from the gates of a city that never fell.', aff: { hpPct: 0.12, thorns: 0.25 }, flag: 'u_ironwall', power: '+30% armor.', minAct: 1 },
    bloodmail: { base: 'mail', name: 'Bloodmail', lore: 'It drinks, so that you may too.', aff: { lifesteal: 0.06, regen: 1.5 }, flag: 'u_blood', power: 'Kills heal 5% of your health.', minAct: 2 },
    shadowhood: { base: 'hood', name: 'Hood of the Nameless', lore: 'Whoever wore it last, nobody remembers.', aff: { dodge: 0.06, crit: 0.05 }, flag: 'u_hood', power: 'You start every floor invisible for 3 turns.', minAct: 1 },
    emberheart: { base: 'amulet', name: 'Emberheart', lore: 'A coal from the Cinder Forge that never cooled.', aff: { burnOnHit: 0.2, hp: 1.5 }, flag: 'u_ember', power: 'Immune to burning; lava hurts half as much.', minAct: 3 },
    eyeofdeep: { base: 'amulet', name: 'Eye of the Deep', lore: 'It blinks when you are not looking.', aff: { light: 2, magicFind: 0.25 }, flag: 'u_eye', power: 'Reveals traps and invisible foes.', minAct: 3 },
    echoes: { base: 'ring', name: 'Ring of Echoes', lore: 'Every word spoken near it is spoken twice.', aff: { abilPct: 0.12, resRegen: 1 }, flag: 'u_echo', power: 'Abilities have a 20% chance to cost nothing.', minAct: 2 }
  };
  // Sets: three pieces (helm, armor, charm). bonus[2] / bonus[3]: mods + flag
  var SETS = {
    lantern: { name: "Lantern Order's Vigil", pieces: { helm: ['helm', 'Vigil Helm'], armor: ['plate', 'Vigil Plate'], charm: ['amulet', 'Vigil Lantern'] },
      b2: { mods: { light: 2, hpPct: 0.15 }, desc: '+2 light, +15% health' }, b3: { flag: 's_lantern', desc: 'Kills heal 4% of your health; +25% damage to undead' }, minAct: 2 },
    shadow: { name: 'Shadowweave', pieces: { helm: ['hood', 'Shadowweave Mask'], armor: ['leather', 'Shadowweave Garb'], charm: ['ring', 'Shadowweave Band'] },
      b2: { mods: { dodge: 0.1 }, desc: '+10% dodge' }, b3: { flag: 's_shadow', desc: 'After you dodge, your next attack is critical' }, minAct: 2 },
    ember: { name: 'Emberforged', pieces: { helm: ['helm', 'Emberforged Helm'], armor: ['mail', 'Emberforged Mail'], charm: ['ring', 'Emberforged Signet'] },
      b2: { mods: { burnOnHit: 0.2 }, desc: '20% chance to Burn' }, b3: { flag: 's_ember', desc: 'Burning foes take 30% more; you are immune to burning' }, minAct: 3 },
    deep: { name: 'Deepwarden', pieces: { helm: ['circlet', 'Deepwarden Diadem'], armor: ['robe', 'Deepwarden Robe'], charm: ['amulet', 'Deepwarden Eye'] },
      b2: { mods: { resPct: 0.2, abilPct: 0.1 }, desc: '+20% max resource, +10% ability damage' }, b3: { flag: 's_deep', desc: 'Abilities cost 20% less' }, minAct: 3 }
  };

  var CONSUMABLES = {
    potion:  { name: 'Health Potion', icon: '🧪', price: 30, desc: 'Restore 40% health.', key: 'q' },
    tonic:   { name: 'Resource Tonic', icon: '🧉', price: 30, desc: 'Restore 60% of your class resource.' },
    elixir:  { name: 'Cleansing Elixir', icon: '⚗', price: 45, desc: 'Cure poison, burn, bleed, root and slow.' },
    bomb:    { name: 'Fire Bomb', icon: '💣', price: 55, desc: 'Throw at a tile within 4: 3×3 blast for 150% power, breaks cracked walls.' },
    recall:  { name: 'Recall Scroll', icon: '📜', price: 40, desc: 'Return to Lanternfall with everything you carry.' },
    mapping: { name: 'Scroll of Mapping', icon: '🗺', price: 60, desc: 'Reveal this floor\'s layout, stairs and secrets.' },
    key:     { name: 'Skeleton Key', icon: '🗝', price: 70, desc: 'Opens a locked chest or sealed door without the puzzle.' }
  };
  var CONS_ORDER = ['potion', 'tonic', 'elixir', 'bomb', 'recall', 'mapping', 'key'];
  var MATERIALS = {
    scrap: { name: 'Iron Scrap', icon: '⚙', desc: 'Salvaged metal. The smith turns it into upgrades.' },
    dust:  { name: 'Arcane Dust', icon: '✨', desc: 'From rare and better gear. Used to reforge and for high upgrades.' },
    soul:  { name: 'Soul Ember', icon: '🔥', desc: 'From bosses, epics and legends. Used for the finest work.' }
  };

  // ===========================================================================
  //  BLESSINGS / CURSES — last a number of floors
  // ===========================================================================
  var BLESSINGS = {
    might:   { name: 'Blessing of Might', icon: '💪', good: 1, mods: { powPct: 0.2 }, desc: '+20% power' },
    ward:    { name: 'Blessing of Warding', icon: '🛡', good: 1, mods: { armPct: 0.3 }, desc: '+30% armor' },
    fortune: { name: 'Blessing of Fortune', icon: '🍀', good: 1, mods: { goldFind: 0.5, magicFind: 0.3 }, desc: '+50% gold, +30% better loot' },
    swift:   { name: 'Blessing of Swiftness', icon: '🪶', good: 1, mods: { dodge: 0.1 }, desc: '+10% dodge' },
    vigor:   { name: 'Blessing of Vigor', icon: '❤', good: 1, mods: { hpPct: 0.2, regen: 2 }, desc: '+20% health and regeneration' },
    clarity: { name: 'Blessing of Clarity', icon: '👁', good: 1, mods: { light: 2, resRegen: 2 }, desc: '+2 light, +2 resource per turn' },
    frailty: { name: 'Curse of Frailty', icon: '🦴', good: 0, mods: { armPct: -0.3 }, desc: '−30% armor' },
    hunger:  { name: 'Curse of Hunger', icon: '🍂', good: 0, mods: { potionPct: -0.5, regen: -99 }, desc: 'Potions heal half; no regeneration' },
    misfortune: { name: 'Curse of Misfortune', icon: '🕳', good: 0, mods: { goldFind: -0.5, magicFind: -0.3 }, desc: '−50% gold, worse loot' },
    hexed:   { name: 'Curse of the Hex', icon: '👁‍🗨', good: 0, mods: { eliteFind: 1 }, desc: 'Far more elites (and their loot)' },
    doom:    { name: 'Curse of Doom', icon: '⌛', good: 0, mods: { doom: 1 }, desc: 'Lose 10% health on each new floor' },
    dimness: { name: 'Curse of Dimness', icon: '🌑', good: 0, mods: { light: -2 }, desc: '−2 light radius' }
  };

  var TRAPS = {
    spike: { name: 'Spike Trap', ch: '^', dmg: 0.18, status: { bleed: 4 }, desc: 'Spikes!' },
    dart:  { name: 'Dart Trap', ch: '^', dmg: 0.1, status: { poison: 5 }, desc: 'A poisoned dart!' },
    alarm: { name: 'Alarm Glyph', ch: '^', dmg: 0, alarm: 1, desc: 'A shrill alarm wakes the floor!' },
    pit:   { name: 'Pit Trap', ch: '^', dmg: 0.15, status: { root: 2 }, desc: 'The floor gives way into a shallow pit.' },
    gas:   { name: 'Gas Vent', ch: '^', dmg: 0, gas: 2, desc: 'A hiss of poison gas!' },
    net:   { name: 'Net Trap', ch: '^', dmg: 0, status: { root: 3 }, desc: 'A net drops over you!' },
    fire:  { name: 'Fire Rune', ch: '^', dmg: 0.14, status: { burn: 4 }, desc: 'The rune erupts in flame!' },
    tele:  { name: 'Warp Glyph', ch: '^', dmg: 0, tele: 1, desc: 'The world lurches — you are somewhere else.' }
  };

  // ===========================================================================
  //  DUNGEON EVENTS — interact with a shrine/altar/stranger to get a choice.
  //  ops: heal (frac) · hurt (frac of max) · gold (× act scale) · pay (× scale)
  //  bless/curse (id) · item (rarity) · cons {id:n} · xp (× scale) · map ·
  //  cleanse · mats {id:n} · elite (spawn one nearby) · roll [{w, text, ops}]
  // ===========================================================================
  var EVENTS = {
    bloodaltar: { name: 'Blood Altar', ch: '†', col: '#d04a4a', biomes: null,
      text: 'A black altar slick with old blood. Carved words: GIVE, AND BE GIVEN.',
      choices: [
        { label: 'Offer your blood (−25% health)', ops: { hurt: 0.25, bless: 'might' }, text: 'The altar drinks. Strength floods your arms.' },
        { label: 'Offer gold instead', ops: { pay: 40, bless: 'ward' }, text: 'The coins melt into the stone. A pale shield settles over you.' },
        { label: 'Leave it be', ops: {}, text: 'Some gifts cost more than they show.' }] },
    gambler: { name: "Gambler's Idol", ch: '¤', col: '#f0c040', biomes: null,
      text: 'A grinning brass idol with a coin slot in its belly. Its eyes are dice.',
      choices: [
        { label: 'Feed it gold', ops: { pay: 50, roll: [
          { w: 40, text: 'The dice roll sixes! A blessing and a prize clatter out.', ops: { bless: 'fortune', item: 'rare' } },
          { w: 30, text: 'Coins pour out of its mouth — double back!', ops: { gold: 100 } },
          { w: 30, text: 'Snake eyes. The idol laughs, and you feel your luck curdle.', ops: { curse: 'misfortune' } }] } },
        { label: 'Smash it', ops: { roll: [
          { w: 50, text: 'Brass splinters. A few coins roll free.', ops: { gold: 30 } },
          { w: 50, text: 'The idol shrieks. Something answers the call…', ops: { elite: 1 } }] } },
        { label: 'Walk away', ops: {}, text: 'The house always wins.' }] },
    well: { name: 'Wishing Well', ch: 'O', col: '#5ab0e0', biomes: null,
      text: 'A mossy well. Coins glint far below, and the water smells clean.',
      choices: [
        { label: 'Toss a coin and wish', ops: { pay: 15, roll: [
          { w: 55, text: 'The water glows. You feel renewed.', ops: { heal: 1, cleanse: 1 } },
          { w: 30, text: 'Something shiny floats up to meet your hand.', ops: { item: 'magic' } },
          { w: 15, text: 'Nothing happens. Wells are like that.', ops: {} }] } },
        { label: 'Drink deeply', ops: { roll: [
          { w: 60, text: 'Cold, sweet water. Your wounds ease.', ops: { heal: 0.5 } },
          { w: 40, text: 'Brackish! Your stomach turns.', ops: { status: { poison: 6 } } }] } },
        { label: 'Leave', ops: {}, text: 'You keep your coin.' }] },
    reliquary: { name: 'Cursed Reliquary', ch: '▣', col: '#a06ad0', biomes: null,
      text: 'A reliquary bound in chains of black iron. Whatever lies inside is precious — and someone wanted it kept in.',
      choices: [
        { label: 'Break the chains', ops: { item: 'epic', curseRandom: 1 }, text: 'The lid springs open. Treasure — and a cold weight settles on your soul.' },
        { label: 'Leave it sealed', ops: {}, text: 'Wise, probably.' }] },
    wounded: { name: 'Wounded Delver', ch: '&', col: '#e0b080', biomes: null, npc: 1,
      text: '"Please… a potion… They came out of the dark and I couldn\'t…" A delver from Lanternfall, pale and bleeding.',
      choices: [
        { label: 'Give a Health Potion', ops: { needCons: 'potion', cons: { potion: -1 }, xp: 40, bless: 'vigor', lore: 1 }, text: '"Thank you. Here — I found this down here. And… be careful of the quiet ones." (+XP, Blessing of Vigor, a lore page)' },
        { label: 'Take their purse', ops: { gold: 60, curse: 'hunger' }, text: 'You take the coins. Their eyes follow you, and food tastes of ash for days.' },
        { label: 'Wish them luck', ops: {}, text: '"…Right. Luck." They close their eyes.' }] },
    merchant: { name: 'Wandering Peddler', ch: '$', col: '#f0d060', biomes: null, npc: 1, shop: 1,
      text: '"Pip\'s my cousin! Twice-removed, thrice-robbed. Prices are steep down here — you know how it is."',
      choices: [{ label: 'Browse wares', ops: { shop: 1 } }, { label: 'Leave', ops: {} }] },
    forge: { name: 'Forgotten Anvil', ch: '¶', col: '#d08a4a', biomes: ['forge', 'crypt', 'flooded'],
      text: 'An anvil still warm, a hammer leaning against it. Whoever left it meant to come back.',
      choices: [
        { label: 'Temper your weapon (+1)', ops: { temper: 'weapon' }, text: 'A few sure strokes. The edge sings.' },
        { label: 'Temper your armor (+1)', ops: { temper: 'armor' }, text: 'You hammer out the dents. It sits better already.' },
        { label: 'Leave it', ops: {} }] },
    shrooms: { name: 'Fairy Ring', ch: '*', col: '#e07ad0', biomes: ['fungal'],
      text: 'A perfect circle of glowing mushrooms. They smell like cinnamon and bad decisions.',
      choices: [
        { label: 'Eat one', ops: { roll: [
          { w: 35, text: 'Warmth spreads through you — wounds close.', ops: { heal: 0.6, res: 1 } },
          { w: 30, text: 'Visions! You understand everything for a moment.', ops: { xp: 60 } },
          { w: 35, text: 'The walls are breathing. Oh no, the walls are breathing.', ops: { curse: 'dimness' } }] } },
        { label: 'Harvest them for the smith', ops: { mats: { dust: 2 } }, text: 'You pocket a handful of glittering spores.' },
        { label: 'Step around the ring', ops: {} }] },
    drownedshrine: { name: 'Drowned Shrine', ch: '≈', col: '#5ad0e0', biomes: ['flooded'],
      text: 'A statue of the Sunstone\'s priestess, waist-deep in black water. Her lantern hand still points down.',
      choices: [
        { label: 'Pray', ops: { bless: 'clarity', map: 1 }, text: 'The water stills. You see the floor laid out as if on a map.' },
        { label: 'Take the offerings', ops: { gold: 50, curse: 'frailty' }, text: 'Coins, and a chill that won\'t leave your bones.' },
        { label: 'Leave', ops: {} }] },
    whisper: { name: 'The Whisper', ch: '?', col: '#b08aff', biomes: ['abyss', 'forge'],
      text: 'A voice that sounds like yours: "Let me in. Just a little. I can make you so strong."',
      choices: [
        { label: 'Let it in', ops: { bless: 'might', bless2: 'vigor', curse: 'doom' }, text: 'Power. So much power. And a ticking, somewhere behind your ribs.' },
        { label: 'Refuse', ops: { xp: 30 }, text: 'The voice sighs. "Later, then." You feel steadier for refusing.' }] },
    fountain: { name: 'Fountain of Renewal', ch: '♥', col: '#7ae0a0', biomes: null,
      text: 'Clear water rises from a cracked basin, glowing faintly gold.',
      choices: [
        { label: 'Drink', ops: { heal: 1, res: 1, cleanse: 1, uncurse: 1 }, text: 'Every ache, every shadow, washed away.' },
        { label: 'Fill a flask (+1 potion)', ops: { cons: { potion: 1 } }, text: 'You bottle a little of the light.' }] },
    prisoner: { name: 'Caged Prisoner', ch: '#', col: '#c0a080', biomes: ['crypt', 'forge', 'abyss'], npc: 1,
      text: 'A wiry man in a hanging cage. "Get me out and I\'ll tell you where the old Order hid their coin."',
      choices: [
        { label: 'Pick the lock (1 turn, noisy)', ops: { roll: [
          { w: 65, text: '"Bless you! Behind the third coffin, loose stone." He was telling the truth.', ops: { gold: 90, map: 1 } },
          { w: 35, text: 'The lock screams. The cage was bait — and the bait has friends.', ops: { elite: 1, gold: 30 } }] } },
        { label: 'Leave him', ops: {}, text: '"Come back! COME BACK!"' }] }
  };
  var EVENT_ORDER = ['bloodaltar', 'gambler', 'well', 'reliquary', 'wounded', 'merchant', 'forge', 'shrooms', 'drownedshrine', 'whisper', 'fountain', 'prisoner'];

  // ===========================================================================
  //  STORY — Lanternfall and the Hollow King.
  // ===========================================================================
  var STORY = {
    title: 'DEEPDELVE',
    town: 'Lanternfall',
    prologue: [
      'Lanternfall clings to the lip of the Deepdelve, a shaft that falls past root and stone into a dark with no floor.',
      'For two hundred years the Sunstone — a great lantern on the town\'s highest tower — has held that dark at bay.',
      'Twenty years ago its keeper, the Lantern Knight Aurel Vane, led his Order down to seal the Deep for good. None of them came back.',
      'Now the Sunstone is guttering. Things are crawling up the shaft. And you have come to Lanternfall with a blade, a torch, and nothing to lose.'
    ],
    // shown on arriving in town after an act's boss falls (index = act just cleared)
    acts: [
      { n: 1, name: 'Act I — The Door Kept', biome: 'crypt' },
      { n: 2, name: 'Act II — The Dreaming Rot', biome: 'fungal' },
      { n: 3, name: 'Act III — The Drowned Record', biome: 'flooded' },
      { n: 4, name: 'Act IV — The Black Lantern', biome: 'forge' },
      { n: 5, name: 'Act V — The Hollow King', biome: 'abyss' }
    ],
    cleared: {
      1: ['Ser Callum is dust. In his gauntlet you find a letter in Maren\'s handwriting, twenty years old, never opened.', 'Aurel did not die down there. He went deeper — "to listen."'],
      2: ['The Mother of Spores is silent. Her last thought lingers like a smell: the Deep is dreaming, and Aurel is its dreamer.', 'Below the Hollows, water. The old Archive of the Lantern Order lies drowned there.'],
      3: ['Nhal\'s record survives in fragments: Aurel drank from the Heart of the Deep to gain the power to seal it — and it hollowed him out.', 'He has been dimming the Sunstone from below. He wants the way open.'],
      4: ['Brann is free, and the Black Lantern is unfinished: a lantern that shines darkness, meant to snuff the Sunstone forever.', 'Aurel waits in the Abyss with what he has. It may be enough.'],
      5: ['The Black Lantern lies shattered. Above, for the first time in twenty years, the Sunstone blazes white.', 'Lanternfall will sleep tonight. The Deep remembers you — and it is very, very patient.']
    },
    ending: [
      'You climb out of the Deepdelve into a morning so bright it hurts.',
      'Maren is waiting at the rim with two cups of tea, as if she knew. She asks only one question, and you answer it honestly.',
      'She nods, and drinks, and after a while she says: "He would have liked you."',
      'The Sunstone burns. The Deep is quiet. But quiet is not empty — and somewhere far below, something has begun, very slowly, to dream again.',
      'THE END — or is it? New Game+ awaits, as does the Endless Descent.'
    ]
  };

  // Town NPCs. lines[k] = what they say once story stage k is reached
  // (stage = acts cleared, 0..5; 6 = after the ending / NG+). Lines are picked
  // from the highest stage ≤ current; `bark` lines add variety.
  var NPCS = {
    maren: { name: 'Maren', role: 'Keeper of the Lantern Inn', ch: 'M', col: '#e0a070', place: 'Lantern Inn', icon: '🏮',
      lines: {
        0: ['"Another one for the Deep, are you? Sit. Eat first. Nobody fights well hungry."', '"My brother Aurel led the Order down twenty years ago. I keep a lamp in the window. Habit."'],
        1: ['"Callum? Little Callum, his squire? He was fourteen when they left…" She is quiet a long while. "Thank you for bringing him peace."', '"A letter from me, in his glove. He kept it. All this time."'],
        2: ['"Dreaming. The Deep dreams, and my brother is the dreamer." She sets the cup down too hard. "Then wake him up."'],
        3: ['"He drank from it. Of course he did. Aurel always thought he could carry everything himself."', '"Don\'t look at me like that. Go on. I\'ve cried my twenty years already."'],
        4: ['"A lantern that shines darkness. He used to tell me stories about one when I was small, to scare me." She laughs, badly. "It worked."'],
        5: ['"…You came back. You actually came back." She pours two cups. "Sit. Tell me how he looked. Tell me everything."'],
        6: ['"The Sunstone\'s so bright I can\'t sleep. Best complaint I\'ve had in twenty years."', '"Going down again? The Deep doesn\'t stay quiet. Neither do people like you."'] },
      barks: ['"Mind the stew, it bites back."', '"Rooms are free for anyone who brings back a story."', '"Pip owes me nine silver and an apology."'] },
    torvald: { name: 'Torvald', role: 'Smith', ch: 'T', col: '#c08060', place: 'Smithy', icon: '⚒',
      lines: {
        0: ['"Bring me scrap and coin, I\'ll bring your steel up to scratch. Upgrades, reforging, salvage. No refunds."'],
        1: ['"Bone dust in your boots. Crypts, eh? I can work with what you carry back."'],
        2: ['"Spores in the bellows again. Hmph. Good scrap down there though."'],
        3: ['"My brother Brann went down with the Order. Forge-master. Best hands I ever saw."', '"If the Archive says what I think it says… find him. Whatever\'s left."'],
        4: ['"He\'s free?" Torvald stares at the anvil a long time. "Then I\'ll finish one job for him. Bring me Soul Embers and I\'ll make you something worth the name."'],
        5: ['"The Hollow King, done in by steel I sharpened. My brother would\'ve been insufferable about it."'],
        6: ['"Back for more? The Deep keeps making monsters, I keep making better hammers. Fair trade."'] },
      barks: ['"Mind the sparks."', '"Salvage gets you scrap. Rare stuff gets you dust. The good stuff gets you embers."', '"Every +1 is a promise. The higher ones are expensive promises."'] },
    pip: { name: 'Pip', role: 'Peddler', ch: 'P', col: '#f0d060', place: 'Peddler\'s Cart', icon: '🎒',
      lines: {
        0: ['"Potions! Scrolls! Bombs, lightly used! Pip\'s got everything a delver needs and several things they don\'t!"'],
        1: ['"Heard you cleaned out the crypts! Business is booming. Well, business is breathing. Same thing!"'],
        2: ['"My cousin trades down in the Hollows. You\'ll know him — he looks like me but sadder."'],
        3: ['"Wet money\'s still money! Archive coins, very collectible, very soggy."'],
        4: ['"Fire bombs from the Cinder Forge! Ironic, isn\'t it? I don\'t know what ironic means."'],
        5: ['"Saviour of Lanternfall! Same prices as everyone else, though. Principles!"'],
        6: ['"New stock every time you come back up! Pip never sleeps. Pip should probably sleep."'] },
      barks: ['"No haggling. Okay, a little haggling. No, no haggling."', '"Recall scrolls! Because dying with loot in your pockets is just rude."', '"I buy anything! Except that. Definitely not that."'] },
    ilse: { name: 'Sister Ilse', role: 'Priestess of the Sunstone', ch: 'I', col: '#f0e0a0', place: 'Sunstone Temple', icon: '☀',
      lines: {
        0: ['"The Sunstone is guttering, child. I can lift curses, bless your next descent — and if you have walked the wrong path, help you choose another."'],
        1: ['"The flame steadied the moment the crypts went quiet. You are doing real good down there."'],
        2: ['"The Sunstone burns a little brighter. The rot below was pressing on it like a hand over a candle."'],
        3: ['"Dimmed from below, deliberately… Aurel was my teacher. He lit the Sunstone every evening for thirty years."'],
        4: ['"One flame against one darkness. That is all faith ever was. Go."'],
        5: ['"Look at it. Look how it burns. I will never doubt again — well. Rarely."'],
        6: ['"The light holds. But the Deep has a long memory. Walk carefully, champion."'] },
      barks: ['"Curses are just bad luck that has learned your name."', '"Talents are paths, not prisons. For a donation, I can help you retrace your steps."'] },
    odo: { name: 'Odo', role: 'Archivist', ch: 'O', col: '#a0b0e0', place: 'Archive', icon: '📜',
      lines: {
        0: ['"Lore pages! Journals! Anything written down there, bring it to me. History is a weapon, if you know how to hold it."'],
        1: ['"Order journals from the crypts — marvellous. Their handwriting, less so."'],
        2: ['"Fungal cognition! A thinking cave! I need to sit down. I am sitting down. I need to sit down more."'],
        3: ['"Nhal was my teacher. He made me copy footnotes for three years." He wipes his glasses. "Thank you for setting him free."'],
        4: ['"The Black Lantern. There are drawings of it in the oldest books — always torn out. Now I know why."'],
        5: ['"I am writing it all down. Every word. They will know what you did."'],
        6: ['"Still pages missing from the collection. Still monsters unrecorded. A scholar\'s work is never done — and neither, apparently, is yours."'] },
      barks: ['"Every page you bring helps me piece the story together."', '"The bestiary grows! So do my nightmares."'] },
    board: { name: 'Quest Board', role: 'Bounties & errands', ch: '#', col: '#c0a070', place: 'Quest Board', icon: '📋', lines: { 0: ['Notices flap in the wind. Most are bounties; some are pleas.'] }, barks: [] }
  };
  var TOWN_ORDER = ['maren', 'torvald', 'pip', 'ilse', 'odo', 'board'];

  // Side quests: fetch an item placed on a floor in a given act, then return.
  var SIDEQUESTS = {
    locket: { giver: 'maren', act: 1, name: "Maren's Locket", item: 'Tarnished Locket', ch: '♡', text: 'Aurel took my mother\'s locket down with him. If it\'s still in the crypts… I\'d like it back.', done: '"Oh." She opens it. Two small faces, a boy and a girl. "Thank you."', reward: { gold: 120, xp: 80, item: 'rare' } },
    spores: { giver: 'odo', act: 2, name: 'A Thinking Sample', item: 'Glowing Spore Sac', ch: '◍', text: 'Bring me a living spore sac from the Hollows. Carefully. Please do not let it think at you.', done: '"It\'s humming. It\'s HUMMING. Oh, this is wonderful and terrible."', reward: { gold: 220, xp: 180, cons: { mapping: 2 } } },
    tome: { giver: 'ilse', act: 3, name: 'The Lamplighter\'s Rite', item: 'Waterlogged Rite', ch: '▤', text: 'The rite for lighting the Sunstone was kept in the Archive. If it survived the flood, we need it.', done: '"The words are faded, but I know them by heart now. The flame will listen."', reward: { gold: 320, xp: 300, bless: 'vigor' } },
    hammer: { giver: 'torvald', act: 4, name: "Brann's Hammer", item: "Brann's First Hammer", ch: 'Т', text: 'Brann\'s first hammer. He\'d never leave it. If you find it… bring it home.', done: 'Torvald holds it like a newborn. "Upgrades are cheaper for you from now on. Don\'t argue."', reward: { gold: 450, xp: 450, mats: { soul: 2 }, flag: 'smithDiscount' } }
  };

  // Lore pages: five per act, found on tablets, journals and corpses.
  var LORE = [
    { act: 1, title: 'Order Roster, Year 1', text: 'Aurel Vane, Lantern Knight. Brann Ironhand, forgemaster. Nhal of the Archive, scribe. Callum, squire (age 14, insists on coming). Thirty-one names. Thirty-one lanterns.' },
    { act: 1, title: 'A Squire\'s Diary', text: 'Lord Aurel stood at the bottom of the stair all night, listening. When I asked what he heard he said, "Someone calling my name, Callum. Isn\'t that strange? It sounds like home."' },
    { act: 1, title: 'Stone Tablet', text: 'HERE THE ORDER SET ITS FIRST WARD. LET NO LIGHT PASS DOWN, LET NO DARK PASS UP. — An addendum, scratched later: "We were wrong about which way the door opens."' },
    { act: 1, title: 'Unsent Letter', text: 'Maren — the crypts are quiet. The others want to rest, but Aurel says the deeper we go the clearer the calling becomes. I don\'t like how he says "calling". — B.' },
    { act: 1, title: 'Coffin Inscription', text: 'Sir Hollis of the Order. Died on the stair, of nothing. His lantern simply went out, and so did he.' },
    { act: 2, title: 'Fungal Growth Notes', text: 'The hyphae respond to light — not by shrinking, but by leaning toward it, like a congregation toward a pulpit. Nhal says it is learning. Learning what?' },
    { act: 2, title: 'Scratched Wall', text: 'IT DREAMS IT DREAMS IT DREAMS AND WE ARE IN THE DREAM' },
    { act: 2, title: 'Brann\'s Tally', text: 'Lanterns lit: 31. Lanterns lit today: 19. The spores eat the oil. Aurel doesn\'t seem to need his anymore. I don\'t know how he sees.' },
    { act: 2, title: 'Child\'s Drawing', text: 'Crayon on vellum: a tall knight with a lantern, a little girl beside him. Someone has drawn the lantern over in black, again and again, until the page tore.' },
    { act: 2, title: 'The Mother\'s Hymn', text: 'Root to root and cap to cap, all are one and one is all. Warm things come and warm things go, but all the warm things fall.' },
    { act: 3, title: 'Archive Ledger', text: 'Recorded by Nhal: the Order reached the Heart of the Deep on the 40th day. It is not a monster. It is a wound in the world, and it is thirsty.' },
    { act: 3, title: 'Page 411', text: 'Aurel believes that if he drinks from the Heart he can command it — close the wound from the inside. Brann called him mad. I fear he is merely brave, which is worse.' },
    { act: 3, title: 'Page 412', text: 'He drank. For a day he shone like the Sunstone itself. On the second day his shadow stopped following him. On the third, it led.' },
    { act: 3, title: 'Waterlogged Will', text: 'To my student Odo, my books. To the Order, my apologies. To whoever reads this: the tide here is not water. Do not let it reach the Sunstone.' },
    { act: 3, title: 'Siren\'s Song (transcribed)', text: 'Come down, come down where the lamps don\'t burn, where every road is a slow, sweet turn, come down to the king with the empty crown…' },
    { act: 4, title: 'Forge Requisition', text: 'BY ORDER OF THE HOLLOW KING: one lantern of black iron, to be lit with the last flame of the Sunstone. Deadline: when the Sunstone gutters. — Forgemaster, acknowledge.' },
    { act: 4, title: 'Brann\'s Last Entry', text: 'He has my hands but not my heart. I make the lantern slowly. I make it badly. Torvald would laugh at these welds. I hope he gets the chance.' },
    { act: 4, title: 'Slag-Etched Warning', text: 'THE LANTERN MUST NOT BE FINISHED. IF IT IS FINISHED, THE SUNSTONE GOES OUT. IF THE SUNSTONE GOES OUT, THE DOOR OPENS. IF THE DOOR OPENS —' },
    { act: 4, title: 'Imp Contract', text: 'We the undersigned imps agree to stoke the forge for one thousand years in exchange for one (1) interesting thing to burn. Signed: [a scorch mark], [a scorch mark], [a larger scorch mark].' },
    { act: 4, title: 'Golem Core', text: 'A brass plate inside the golem\'s chest: "Built by Brann Ironhand, for the protection of Lanternfall." Someone has scratched out Lanternfall and written THE KING.' },
    { act: 5, title: 'The Hollow Creed', text: 'There is no wall at the bottom of the world. There is a door, and behind it, everything we ever lost. The King will open it. The King will bring them home.' },
    { act: 5, title: 'Aurel\'s Journal, Last Page', text: 'Maren, if I open the door I can bring them back. Mother. Father. The Order. I can hear them, Maren. They\'re calling. I\'m sorry I\'m late.' },
    { act: 5, title: 'Obsidian Mirror', text: 'Your reflection is holding a lantern that pours out darkness. When you look away and back, it is holding nothing — and smiling.' },
    { act: 5, title: 'The Heart of the Deep', text: 'Not evil. Not good. A hunger with no mouth, using the mouths it finds. It does not want the world. It wants to be wanted.' },
    { act: 5, title: 'Final Ward', text: 'Thirty-one lanterns, set in a ring around nothing. Thirty are cold. One flickers, faintly, as you pass. Someone is still keeping watch.' }
  ];

  // Bounties on the quest board (rolled from these templates).
  var BOUNTIES = [
    { id: 'kill', name: 'Cull the {fam}', text: 'Slay {n} {famPlural} in the depths.', fams: true, n: [8, 14] },
    { id: 'elite', name: 'Champion Hunt', text: 'Defeat {n} elite champions.', n: [2, 4] },
    { id: 'depth', name: 'Deeper Still', text: 'Reach floor {d}.', depth: true },
    { id: 'puzzle', name: 'Locks and Levers', text: 'Solve {n} puzzle rooms.', n: [1, 3] },
    { id: 'lore', name: 'Lost Words', text: 'Recover {n} lore pages.', n: [1, 2] },
    { id: 'event', name: 'Strange Altars', text: 'Resolve {n} shrines or strangers.', n: [2, 4] },
    { id: 'gold', name: 'Hard Currency', text: 'Collect {n} gold in the depths.', gold: true }
  ];
  var FAMILIES = { undead: ['Undead', 'undead'], beast: ['Beasts', 'beasts'], fungus: ['Fungus', 'fungal horrors'], spirit: ['Spirits', 'spirits'], human: ['Cultists', 'cultists'], demon: ['Demons', 'demons'], elemental: ['Elementals', 'elementals'], construct: ['Constructs', 'constructs'], abyssal: ['Abyssal', 'abyssal horrors'] };

  var DIFFICULTIES = {
    relaxed:   { name: 'Relaxed', hp: 0.7, pow: 0.7, elite: 0.6, rew: 0.85, goldLoss: 0.1, keepLoot: 1, desc: 'Softer foes. Death costs a little gold and nothing else.' },
    normal:    { name: 'Normal', hp: 1.0, pow: 1.0, elite: 1.0, rew: 1.0, goldLoss: 0.25, keepLoot: 0, desc: 'The intended descent. Death drops a quarter of your gold and the unequipped loot found that trip.' },
    hard:      { name: 'Hard', hp: 1.35, pow: 1.3, elite: 1.5, rew: 1.3, goldLoss: 0.35, keepLoot: 0, desc: 'Tougher, angrier, more champions. Better rewards.' },
    nightmare: { name: 'Nightmare', hp: 1.8, pow: 1.6, elite: 2.2, rew: 1.7, goldLoss: 0.5, keepLoot: 0, desc: 'For veterans. Everything wants you dead, and most of it can.' }
  };
  var DIFF_ORDER = ['relaxed', 'normal', 'hard', 'nightmare'];

  // Daily challenge modifiers (one per day, seeded).
  var DAILY_MODS = {
    glass:   { name: 'Glass Cannon', desc: 'You deal 50% more damage — and take 50% more.' },
    swarm:   { name: 'The Swarm', desc: 'Half again as many monsters.' },
    dark:    { name: 'Lights Out', desc: 'Your torch reaches 2 tiles less.' },
    elites:  { name: 'Champions\' Day', desc: 'Elites everywhere. Loot everywhere.' },
    rich:    { name: 'Gold Rush', desc: 'Double gold — and thieves love you.' },
    frail:   { name: 'Brittle Bones', desc: 'Potions heal half, but you start with twice as many.' },
    haste:   { name: 'Hurry Up', desc: 'Every monster is a little faster.' }
  };

  var NAMES = ['Asha', 'Bram', 'Corin', 'Dessa', 'Eryk', 'Fen', 'Gwyn', 'Hale', 'Ines', 'Jory', 'Kael', 'Lio', 'Mira', 'Nox', 'Orla', 'Pell', 'Quill', 'Rook', 'Sable', 'Tamsin', 'Ulric', 'Vesna', 'Wren', 'Yara', 'Zed', 'Ember', 'Moss', 'Thorne', 'Vale', 'Ash'];
  var EPITHETS = ['the Bold', 'Lightfoot', 'of the Rim', 'Lanternborn', 'the Quiet', 'Ironheart', 'the Unlucky', 'Deepsworn', 'the Grey', 'Torchbearer'];

  return {
    CLASSES: CLASSES, CLASS_ORDER: CLASS_ORDER, ABILITY_LEVELS: ABILITY_LEVELS, ABILITIES: ABILITIES,
    TALENTS: TALENTS, TALENT_LEVELS: TALENT_LEVELS,
    BIOMES: BIOMES, BIOME_ORDER: BIOME_ORDER, ACT_FLOORS: ACT_FLOORS, STORY_FLOORS: STORY_FLOORS,
    MONSTERS: MONSTERS, ELITE: ELITE, BOSSES: BOSSES, ECHO_ORDER: ECHO_ORDER,
    SLOTS: SLOTS, SLOT_NAMES: SLOT_NAMES, BASES: BASES, SLOT_BASES: SLOT_BASES, RARITIES: RARITIES, RARITY_ORDER: RARITY_ORDER,
    AFFIXES: AFFIXES, UNIQUES: UNIQUES, SETS: SETS, CONSUMABLES: CONSUMABLES, CONS_ORDER: CONS_ORDER, MATERIALS: MATERIALS,
    BLESSINGS: BLESSINGS, TRAPS: TRAPS, EVENTS: EVENTS, EVENT_ORDER: EVENT_ORDER,
    STORY: STORY, NPCS: NPCS, TOWN_ORDER: TOWN_ORDER, SIDEQUESTS: SIDEQUESTS, LORE: LORE, BOUNTIES: BOUNTIES, FAMILIES: FAMILIES,
    DIFFICULTIES: DIFFICULTIES, DIFF_ORDER: DIFF_ORDER, DAILY_MODS: DAILY_MODS, NAMES: NAMES, EPITHETS: EPITHETS
  };
});
