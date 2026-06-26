/* Dungeon Crawler — a tiny roguelike. Explore procedurally-generated floors,
 * fight monsters (move into them), grab potions/gold/weapons, find the stairs >
 * and descend. It gets harder the deeper you go. Permadeath; best score persists.
 * Move: arrows / WASD / swipe. Wait (heal a little): Space / tap. Esc closes.
 * Self-contained offline module. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('crawler.css');

  var GW = 24, GH = 16, CELL = 16;
  var W = GW * CELL, H = GH * CELL, TORCH = 6;
  var map, explored, visible, rooms, stairs, player, monsters, items, depth, best0, msgs, dead, raf = 0, state = null, stepCount = 0;

  function bestScore() { try { return parseInt(Cade.store.get('cade-game-crawler-best') || '0', 10) || 0; } catch (e) { return 0; } }
  function setBest(v) { try { Cade.store.set('cade-game-crawler-best', String(v)); } catch (e) {} }
  function score() { return depth * 100 + player.gold + player.level * 20; }
  function rnd(n) { return (Math.random() * n) | 0; }
  function log(m) { msgs.push(m); if (msgs.length > 3) msgs.shift(); }

  // ---- dungeon generation ----------------------------------------------------
  function center(r) { return { x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) }; }
  function carve(x, y) { if (x > 0 && x < GW - 1 && y > 0 && y < GH - 1) map[y][x] = 1; }
  function corridor(a, b) {
    var x = a.x, y = a.y;
    if (rnd(2)) { while (x !== b.x) { carve(x, y); x += x < b.x ? 1 : -1; } while (y !== b.y) { carve(x, y); y += y < b.y ? 1 : -1; } }
    else { while (y !== b.y) { carve(x, y); y += y < b.y ? 1 : -1; } while (x !== b.x) { carve(x, y); x += x < b.x ? 1 : -1; } }
    carve(b.x, b.y);
  }
  function freeFloorIn(r, taken) {
    for (var t = 0; t < 30; t++) {
      var x = r.x + 1 + rnd(Math.max(1, r.w - 2)), y = r.y + 1 + rnd(Math.max(1, r.h - 2));
      if (map[y] && map[y][x] === 1 && !taken(x, y)) return { x: x, y: y };
    }
    return null;
  }
  function occupied(x, y) {
    if (player && player.x === x && player.y === y) return true;
    if (stairs && stairs.x === x && stairs.y === y) return true;
    for (var i = 0; i < monsters.length; i++) if (monsters[i].x === x && monsters[i].y === y) return true;
    for (var j = 0; j < items.length; j++) if (items[j].x === x && items[j].y === y) return true;
    return false;
  }
  var MTYPES = [
    { ch: 'r', name: 'rat', hp: 3, atk: 1, minD: 1 },
    { ch: 'k', name: 'kobold', hp: 6, atk: 2, minD: 1 },
    { ch: 'g', name: 'goblin', hp: 10, atk: 3, minD: 2 },
    { ch: 'o', name: 'orc', hp: 16, atk: 5, minD: 4 },
    { ch: 'T', name: 'troll', hp: 26, atk: 8, minD: 6 }
  ];
  function genLevel() {
    map = []; explored = []; visible = [];
    for (var y = 0; y < GH; y++) { map.push(new Array(GW).fill(0)); explored.push(new Array(GW).fill(false)); visible.push(new Array(GW).fill(false)); }
    rooms = []; monsters = []; items = [];
    var tries = 0;
    while (rooms.length < 7 && tries++ < 90) {
      var w = 4 + rnd(5), h = 3 + rnd(3);
      var x = 1 + rnd(GW - w - 2), y = 1 + rnd(GH - h - 2);
      var nr = { x: x, y: y, w: w, h: h }, ok = true;
      for (var i = 0; i < rooms.length; i++) {
        var o = rooms[i];
        if (x - 1 < o.x + o.w && x + w + 1 > o.x && y - 1 < o.y + o.h && y + h + 1 > o.y) { ok = false; break; }
      }
      if (ok) { for (var ry = y; ry < y + h; ry++) for (var rx = x; rx < x + w; rx++) carve(rx, ry); rooms.push(nr); }
    }
    for (var k = 1; k < rooms.length; k++) corridor(center(rooms[k - 1]), center(rooms[k]));
    var p0 = center(rooms[0]);
    if (!player) player = { x: p0.x, y: p0.y, hp: 24, mhp: 24, atk: 4, gold: 0, level: 1, xp: 0 };
    else { player.x = p0.x; player.y = p0.y; }
    stairs = center(rooms[rooms.length - 1]);
    // monsters
    var avail = MTYPES.filter(function (m) { return m.minD <= depth; });
    var mcount = 3 + depth;
    for (var mi = 0; mi < mcount; mi++) {
      var rm = rooms[1 + rnd(rooms.length - 1)];
      var sp = freeFloorIn(rm, occupied);
      if (!sp) continue;
      var t = avail[rnd(avail.length)];
      monsters.push({ x: sp.x, y: sp.y, ch: t.ch, name: t.name, hp: t.hp, mhp: t.hp, atk: t.atk });
    }
    // items
    var pots = 2 + rnd(2);
    for (var pi = 0; pi < pots; pi++) { var s1 = freeFloorIn(rooms[rnd(rooms.length)], occupied); if (s1) items.push({ x: s1.x, y: s1.y, ch: '!', type: 'potion' }); }
    var golds = 3 + rnd(3);
    for (var gi = 0; gi < golds; gi++) { var s2 = freeFloorIn(rooms[rnd(rooms.length)], occupied); if (s2) items.push({ x: s2.x, y: s2.y, ch: '$', type: 'gold', amt: 5 + rnd(10) * depth }); }
    if (rnd(2) === 0) { var s3 = freeFloorIn(rooms[1 + rnd(rooms.length - 1)], occupied); if (s3) items.push({ x: s3.x, y: s3.y, ch: '/', type: 'weapon' }); }
    computeVisible();
  }
  function newGame() { player = null; depth = 1; msgs = []; dead = false; stepCount = 0; genLevel(); log('Floor 1. Find the > stairs.'); }

  // ---- visibility (torch radius) ---------------------------------------------
  function computeVisible() {
    for (var y = 0; y < GH; y++) for (var x = 0; x < GW; x++) {
      var d = Math.max(Math.abs(x - player.x), Math.abs(y - player.y));
      var vis = d <= TORCH;
      visible[y][x] = vis;
      if (vis) explored[y][x] = true;
    }
  }

  // ---- turns -----------------------------------------------------------------
  function monsterAt(x, y) { for (var i = 0; i < monsters.length; i++) if (monsters[i].x === x && monsters[i].y === y) return monsters[i]; return null; }
  function attack(att, def, attName) {
    var dmg = Math.max(1, att.atk - rnd(2));
    def.hp -= dmg;
    if (def === player) { log(att.name + ' hits you (' + dmg + ').'); }
    else { log('You hit the ' + def.name + ' (' + dmg + ').'); }
  }
  function killMonster(m) {
    var idx = monsters.indexOf(m); if (idx >= 0) monsters.splice(idx, 1);
    player.xp += m.mhp; player.gold += m.mhp;
    log('The ' + m.name + ' dies.');
    if (player.xp >= player.level * 12) { player.xp -= player.level * 12; player.level++; player.mhp += 6; player.hp = player.mhp; player.atk += 1; log('You reach level ' + player.level + '!'); }
  }
  function tryMove(dx, dy) {
    if (dead) return;
    if (dx === 0 && dy === 0) { if (player.hp < player.mhp && rnd(2) === 0) player.hp++; monstersAct(); afterTurn(); return; }
    var nx = player.x + dx, ny = player.y + dy;
    if (nx < 0 || nx >= GW || ny < 0 || ny >= GH || map[ny][nx] !== 1) return; // wall — free, no turn
    var m = monsterAt(nx, ny);
    if (m) { attack(player, m, 'You'); if (m.hp <= 0) killMonster(m); }
    else {
      player.x = nx; player.y = ny;
      var it = null; for (var i = 0; i < items.length; i++) if (items[i].x === nx && items[i].y === ny) { it = items[i]; break; }
      if (it) {
        if (it.type === 'potion') { player.hp = Math.min(player.mhp, player.hp + 10); log('You quaff a potion (+10 HP).'); }
        else if (it.type === 'gold') { player.gold += it.amt; log('You find ' + it.amt + ' gold.'); }
        else if (it.type === 'weapon') { player.atk += 2; log('A better weapon! (+2 ATK).'); }
        items.splice(items.indexOf(it), 1);
      }
      if (player.x === stairs.x && player.y === stairs.y) { descend(); return; }
    }
    stepCount++;
    if (stepCount % 6 === 0 && player.hp < player.mhp) player.hp++;
    monstersAct();
    afterTurn();
  }
  function descend() { depth++; log('You descend to floor ' + depth + '.'); player.hp = Math.min(player.mhp, player.hp + 4); genLevel(); }
  function monstersAct() {
    for (var i = 0; i < monsters.length; i++) {
      var m = monsters[i];
      var dist = Math.max(Math.abs(m.x - player.x), Math.abs(m.y - player.y));
      if (dist === 1) { attack(m, player, m.name); continue; }
      if (dist > TORCH + 1) continue; // asleep until you're near
      var sx = m.x + (player.x > m.x ? 1 : player.x < m.x ? -1 : 0);
      var sy = m.y + (player.y > m.y ? 1 : player.y < m.y ? -1 : 0);
      // try diagonal toward player, then axis steps
      var opts = [[sx, sy], [m.x + Math.sign(player.x - m.x), m.y], [m.x, m.y + Math.sign(player.y - m.y)]];
      for (var o = 0; o < opts.length; o++) {
        var tx = opts[o][0], ty = opts[o][1];
        if (tx === m.x && ty === m.y) continue;
        if (tx < 0 || tx >= GW || ty < 0 || ty >= GH || map[ty][tx] !== 1) continue;
        if (tx === player.x && ty === player.y) break;
        if (monsterAt(tx, ty)) continue;
        m.x = tx; m.y = ty; break;
      }
    }
  }
  function afterTurn() {
    computeVisible();
    if (player.hp <= 0) {
      dead = true;
      if (score() > bestScore()) setBest(score());
      log('You die on floor ' + depth + '. Score ' + score() + '.');
    }
  }

  // ---- render ----------------------------------------------------------------
  var GLYPH = {
    '@': '#f7f4ef', 'r': '#c98b6b', 'k': '#d0b45a', 'g': '#7fae5b', 'o': '#9b7fd8', 'T': '#e85d5d',
    '!': '#e05dc0', '$': '#e0c34a', '/': '#5bc0de', '>': '#7fe08a'
  };
  function draw(ctx, ch, x, y, color, dim) {
    ctx.fillStyle = dim ? 'rgba(120,128,140,0.5)' : color;
    ctx.fillText(ch, x * CELL + CELL / 2, y * CELL + CELL / 2 + 1);
  }
  function render() {
    if (!state || !state.canvas.isConnected) return;
    var ctx = state.ctx;
    ctx.fillStyle = '#0a0b0e'; ctx.fillRect(0, 0, W, H);
    ctx.font = '14px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var y = 0; y < GH; y++) for (var x = 0; x < GW; x++) {
      if (!explored[y][x]) continue;
      var vis = visible[y][x];
      if (map[y][x] === 1) draw(ctx, '·', x, y, 'rgba(120,128,140,0.55)', !vis);
      else draw(ctx, '#', x, y, vis ? '#3a4150' : 'rgba(58,65,80,0.5)', false);
    }
    if (explored[stairs.y][stairs.x]) draw(ctx, '>', stairs.x, stairs.y, GLYPH['>'], !visible[stairs.y][stairs.x]);
    for (var ii = 0; ii < items.length; ii++) { var it = items[ii]; if (visible[it.y][it.x]) draw(ctx, it.ch, it.x, it.y, GLYPH[it.ch], false); }
    for (var mi = 0; mi < monsters.length; mi++) { var m = monsters[mi]; if (visible[m.y][m.x]) draw(ctx, m.ch, m.x, m.y, GLYPH[m.ch] || '#e85d5d', false); }
    draw(ctx, '@', player.x, player.y, GLYPH['@'], false);
    if (dead) {
      ctx.fillStyle = 'rgba(10,11,14,0.82)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e85d5d'; ctx.font = 'bold 20px ui-monospace, monospace'; ctx.fillText('You died', W / 2, H / 2 - 18);
      ctx.fillStyle = '#cbd2dc'; ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('Floor ' + depth + ' · Score ' + score(), W / 2, H / 2 + 4);
      ctx.fillText('Space / tap to descend again', W / 2, H / 2 + 24);
    }
    var hud = document.getElementById('crawler-hud');
    if (hud) hud.innerHTML = '<span>♥ ' + Math.max(0, player.hp) + '/' + player.mhp + '</span><span>⚔ ' + player.atk + '</span><span>Lv ' + player.level + '</span><span>⌄ ' + depth + '</span><span>$ ' + player.gold + '</span>';
    var lg = document.getElementById('crawler-log'); if (lg) lg.textContent = msgs[msgs.length - 1] || '';
  }
  function loop() { raf = 0; if (!state || !state.canvas.isConnected) { state = null; return; } render(); raf = requestAnimationFrame(loop); }

  function close() { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (state && state._key) document.removeEventListener('keydown', state._key, true); state = null; var p = document.getElementById('crawler-panel'); if (p) p.remove(); try { Cade.editor.focus(); } catch (e) {} }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('crawler-panel')) { close(); return; }
    var body = '<canvas id="crawler-canvas" class="crawler-canvas" width="' + W + '" height="' + H + '"></canvas>' +
      '<div id="crawler-hud" class="crawler-hud"></div>' +
      '<div id="crawler-log" class="crawler-log"></div>' +
      '<div class="crawler-help">Move: arrows / WASD / swipe · Wait: Space / tap · Esc: close</div>';
    var p = Cade.mkPanel('crawler-panel', '⚔ Dungeon Crawler', body);
    var canvas = document.getElementById('crawler-canvas');
    newGame();
    state = { canvas: canvas, ctx: canvas.getContext('2d') };
    p._onClose = function () { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (state && state._key) document.removeEventListener('keydown', state._key, true); state = null; };
    state._key = function (e) {
      if (!document.getElementById('crawler-panel')) return;
      var k = e.key;
      if (k === 'Escape') { e.preventDefault(); close(); return; }
      if (dead && (k === ' ' || e.code === 'Space')) { e.preventDefault(); newGame(); return; }
      if (k === ' ' || e.code === 'Space') { e.preventDefault(); tryMove(0, 0); return; }
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); tryMove(-1, 0); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); tryMove(1, 0); }
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); tryMove(0, -1); }
      else if (k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); tryMove(0, 1); }
    };
    document.addEventListener('keydown', state._key, true);
    var sx = 0, sy = 0, tracking = false;
    canvas.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; tracking = true; });
    canvas.addEventListener('pointerup', function (e) {
      if (!tracking) return; tracking = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) { if (dead) newGame(); else tryMove(0, 0); return; }
      if (Math.abs(dx) > Math.abs(dy)) tryMove(dx > 0 ? 1 : -1, 0); else tryMove(0, dy > 0 ? 1 : -1);
    });
    canvas.style.touchAction = 'none';
    raf = requestAnimationFrame(loop);
  }

  Cade.registerWidget({ name: 'Dungeon Crawler', description: 'A tiny roguelike — explore, fight, descend', icon: '⚔', tags: 'game,roguelike,dungeon,crawler,rpg,adventure,train,fun', open: open });
})();
