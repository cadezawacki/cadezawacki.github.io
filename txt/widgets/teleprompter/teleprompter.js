/* Teleprompter — full-screen scrolling script from the selection (or the whole
 * note when nothing is selected).
 *
 * TEXT: Markdown is reduced to readable text: headings stay as bigger lines,
 * list items keep their bullet / number, quotes are set apart, emphasis /
 * links / highlight sentinels / images are stripped, code blocks are shown
 * dimmed. Every source line is one block (this app writes one paragraph per
 * line); ←/→ jump block to block.
 *
 * MOTION: one requestAnimationFrame loop with delta time (clamped, so a
 * backgrounded tab never lurches) accumulating a fractional scroll position,
 * applied as a translate3d — smooth at 60 and 120 Hz (ProMotion) alike. The
 * loop runs only while playing or easing a jump; it stops otherwise.
 * Speed is in words per minute: px/s = wpm / 60 x (text height / words), so
 * changing the size or width keeps the reading pace; the remaining-time
 * estimate uses the same rate. The end is where the last line sits on the
 * reading line; a ResizeObserver re-measures when the text re-wraps after
 * opening (e.g. the web font arriving late on iOS), so the end stays reachable.
 *
 * CONTROLS: play / pause (Space, Enter, K, tap or click), speed (↑/↓, slider),
 * paragraph back / forward (←/→, PageUp/PageDown — Bluetooth page-turner
 * pedals send these), restart (Home), text size (+/−), width, mirror
 * horizontally / vertically for teleprompter glass, a reading-line band with
 * the text around it dimmed to a set opacity, a 3-2-1 countdown before the
 * first start, progress and time left. Drag (or the wheel) nudges the position. Controls fade out
 * while playing and come back on pause / mouse move.
 *
 * SCREEN: fixed overlay (safe-area aware) + Fullscreen API where available;
 * Screen Wake Lock keeps the display awake while open (feature-detected).
 * Settings are remembered. Everything (listeners, loop, timers, wake lock) is
 * released on close. Pure helpers are exposed as widget._lib for node checks. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('teleprompter.css');
  var esc = Cade.escapeHtml;

  var OV_ID = 'teleprompter-overlay';
  var PREFS_KEY = 'cade-teleprompter-prefs';
  var MAX_CHARS = 300000;
  var WPM_MIN = 40, WPM_MAX = 400;
  var DEF = { wpm: 140, font: 0, width: 82, guideY: 30, others: 45, mx: false, my: false, guide: true, countdown: true, light: false };
  var P = {};
  var S = null;

  // ======================================================================
  // Pure helpers
  // ======================================================================
  function cleanInline(s) {
    s = String(s || '')
      .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
      .replace(/!\[(?:img|file):[^\]\n]*\]/g, '')
      .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g, '$1')
      .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
      .replace(/\[\^[^\]\s]+\]/g, '')
      .replace(/%%[^|%\n]{1,32}\|([^\n]+?)%%/g, '$1')
      .replace(/==[a-zA-Z]{3,10}\|([^\n]+?)==/g, '$1')
      .replace(/<\/?(?:u|b|i|em|strong|br|s|del|ins|sub|sup|mark|span|kbd|small|big|code|p|div)\b[^>\n]*>/gi, '')
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
      .replace(/__([^_\n]+?)__/g, '$1')
      .replace(/~~([^~\n]+?)~~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\*([^*\s][^*\n]*?)\*/g, '$1')
      .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1$2')
      .replace(/\\([\\`*_{}[\]()#+\-.!|~%=>])/g, '$1');
    return s.replace(/\s+/g, ' ').trim();
  }
  var RE_WORD = /[\p{L}\p{N}]/u; // a token with a letter or digit, any script
  function countWords(s) {
    var n = 0, parts = String(s || '').split(/\s+/);
    for (var i = 0; i < parts.length; i++) if (RE_WORD.test(parts[i])) n++;
    return n;
  }
  // Source text -> [{t: 'h'|'p'|'li'|'q'|'code'|'hr', s, lvl, mk, gap, w}]
  function toBlocks(text) {
    var lines = String(text || '').split(/\r?\n/), out = [], gap = false, code = false;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i], m;
      if (/^\s{0,3}(```|~~~)/.test(raw)) { code = !code; gap = true; continue; }
      if (code) {
        if (raw.trim()) { out.push({ t: 'code', s: raw.replace(/\t/g, '  ').replace(/\s+$/, ''), gap: gap, w: countWords(raw) }); gap = false; }
        continue;
      }
      if (!raw.trim()) { gap = true; continue; }
      if (raw.length > 2000 && !/\s/.test(raw.slice(0, 2000))) continue;          // embedded data
      if (/^\s*(?:\[table(?::[^\]]*)?\]|@complete)\s*$/i.test(raw)) continue;     // core table / macro markers
      if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(raw)) continue;      // table separator
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) { out.push({ t: 'hr', s: '', gap: false, w: 0 }); gap = false; continue; }
      var t = 'p', lvl = 0, mk = '';
      var l = raw.replace(/^\s*%%(?:center|right)%%\s?/, '');
      if ((m = /^\s{0,3}(#{1,6})\s+/.exec(l))) { t = 'h'; lvl = m[1].length; l = l.slice(m[0].length).replace(/\s+#+\s*$/, ''); }
      else if (/^\s{0,3}>/.test(l)) { t = 'q'; l = l.replace(/^\s{0,3}(?:>\s?)+/, ''); }
      else if ((m = /^\s*([-*+\u2022]|\d{1,3}[.)]|[A-Za-z][.)])\s+(?:\[[ xX]\]\s+)?/.exec(l))) {
        t = 'li'; mk = /^[-*+\u2022]$/.test(m[1]) ? '\u2022' : m[1]; l = l.slice(m[0].length);
      }
      if (/^\s*\|.*\|\s*$/.test(l)) {
        l = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
          .map(function (c) { return c.trim(); }).filter(Boolean).join(' · ');
      }
      var s = cleanInline(l);
      if (!s) continue;
      out.push({ t: t, s: s, lvl: lvl, mk: mk, gap: gap, w: countWords(s) });
      gap = false;
    }
    return out;
  }
  function clampWpm(v) { return Math.max(WPM_MIN, Math.min(WPM_MAX, Math.round(v))); }
  // Scroll speed for a reading pace: pixels of text per word x words per second.
  function pxPerSec(wpm, textPx, words) { return words > 0 ? wpm / 60 * (textPx / words) : 0; }
  function fmtTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  // Index of the last stop whose position is <= y (binary search; -1 if none).
  function stopAt(stops, y) {
    var lo = 0, hi = stops.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (stops[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  // Paragraph jump target from position `cur` (stops sorted ascending).
  // Back goes to the start of the current paragraph first unless already
  // (nearly) there, like a media player's previous button.
  function jumpTarget(stops, cur, dir, tol, max) {
    var i;
    if (dir > 0) {
      for (i = 0; i < stops.length; i++) if (stops[i] > cur + 1) return Math.min(max, stops[i]);
      return max;
    }
    for (i = stops.length - 1; i >= 0; i--) if (stops[i] < cur - tol) return Math.max(0, stops[i]);
    return 0;
  }

  // ======================================================================
  // Platform: wake lock + fullscreen (feature-detected)
  // ======================================================================
  function wakeAcquire() {
    if (!S || !navigator.wakeLock || !navigator.wakeLock.request || S.wake || document.visibilityState !== 'visible') return;
    var s = S;
    try {
      navigator.wakeLock.request('screen').then(function (lock) {
        if (S !== s) { try { lock.release(); } catch (e) {} return; }
        s.wake = lock;
        lock.addEventListener('release', function () { if (s.wake === lock) s.wake = null; });
      }, function () {});
    } catch (e) {}
  }
  function wakeRelease(s) {
    if (s && s.wake) { var l = s.wake; s.wake = null; try { var r = l.release(); if (r && r.catch) r.catch(function () {}); } catch (e) {} }
  }
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function canFs() { return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled); }
  function enterFs(el) {
    var fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return;
    try { var r = fn.call(el); if (r && r.catch) r.catch(function () {}); } catch (e) {}
  }
  function exitFs() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn || !fsEl()) return;
    try { var r = fn.call(document); if (r && r.catch) r.catch(function () {}); } catch (e) {}
  }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  function reducedMotion() { return false; }

  // ======================================================================
  // Prefs
  // ======================================================================
  function loadPrefs() {
    var p = {};
    try { p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {}; } catch (e) { p = {}; }
    for (var k in DEF) P[k] = p[k] !== undefined && typeof p[k] === typeof DEF[k] ? p[k] : DEF[k];
    P.wpm = clampWpm(P.wpm);
    P.width = Math.max(40, Math.min(100, P.width));
    P.guideY = Math.max(15, Math.min(60, P.guideY));
    P.others = Math.max(5, Math.min(100, Math.round(P.others)));
    if (P.font) P.font = Math.max(18, Math.min(140, P.font));
  }
  var saveT = 0;
  function savePrefs() {
    clearTimeout(saveT);
    saveT = setTimeout(function () { try { Cade.store.set(PREFS_KEY, JSON.stringify(P)); } catch (e) {} }, 250);
  }

  // ======================================================================
  // Overlay
  // ======================================================================
  var I = function (d) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  };
  var ICON = {
    close: I('<path d="M6 6l12 12M18 6L6 18"/>'),
    restart: I('<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/>'),
    back: I('<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>'),
    fwd: I('<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>'),
    play: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/></svg>',
    gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    fs: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  };
  function btn(act, title, icon, cls) {
    return '<button type="button" class="tp-b' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" title="' + title +
      '" aria-label="' + title + '">' + icon + '</button>';
  }
  function tog(k, label) { return '<button type="button" class="tp-tog" data-tog="' + k + '" aria-pressed="false">' + label + '</button>'; }
  function slider(k, label, min, max, step) {
    return '<label class="tp-sl"><span>' + label + '</span><input type="range" data-k="' + k + '" min="' + min + '" max="' + max +
      '" step="' + step + '"><b data-v="' + k + '"></b></label>';
  }

  function blocksHtml(blocks) {
    var h = '';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var cls = 'tp-blk tp-' + b.t + (b.t === 'h' ? ' tp-h' + Math.min(b.lvl, 3) : '') + (b.gap && i ? ' tp-gap' : '');
      h += '<div class="' + cls + '">' + (b.mk ? '<span class="tp-mk">' + esc(b.mk) + '</span>' : '') + esc(b.s) + '</div>';
    }
    return h;
  }

  function fontPx() {
    if (P.font) return P.font;
    var w = S ? S.view.clientWidth : window.innerWidth;
    return Math.max(28, Math.min(72, Math.round(w / 14)));
  }
  function lineH() { return fontPx() * 1.4; }

  // Lay out at the current size / width / reading line and record block
  // positions. Keeps the reading position proportionally.
  function measure() {
    if (!S) return;
    var ratio = S.maxPos > 0 ? S.pos / S.maxPos : 0;
    var vh = S.view.clientHeight, fs = fontPx(), lh = lineH();
    var c = S.content;
    c.style.fontSize = fs + 'px';
    c.style.width = P.width + '%';
    S.guideY = vh * P.guideY / 100;
    S.padTop = Math.max(0, S.guideY - lh / 2);
    c.style.paddingTop = S.padTop + 'px';
    c.style.paddingBottom = Math.max(0, vh - S.guideY - lh / 2) + 'px';
    var els = c.children, stops = [], first = null, last = 0, lastEl = null;
    for (var i = 0; i < els.length; i++) {
      var top = els[i].offsetTop;
      if (first === null) first = top;
      last = top + els[i].offsetHeight;
      lastEl = els[i];
      if (S.blocks[i].t !== 'hr') stops.push(top - S.padTop);
    }
    S.stops = stops;
    S.textH = first === null ? 0 : last - first;
    // The end: the middle of the last line on the reading line.
    var lastLh = lastEl ? parseFloat(getComputedStyle(lastEl).lineHeight) || lh : lh;
    S.maxPos = Math.max(0, last - lastLh / 2 - S.guideY);
    S.measuredH = c.offsetHeight;
    S.pos = Math.min(S.maxPos, ratio * S.maxPos);
    S.guide.style.top = (S.guideY - lh * 0.62) + 'px';
    S.guide.style.height = (lh * 1.24) + 'px';
    S.shadeTop.style.height = Math.max(0, S.guideY - lh * 0.62) + 'px';
    S.shadeBot.style.top = (S.guideY + lh * 0.62) + 'px';
    S.measuredVh = vh;
    S.lastSecs = -1; S.lastPct = -1;
    render();
  }
  function speed() { return S ? pxPerSec(P.wpm, S.textH, S.totalWords) : 0; }

  function render() {
    if (!S) return;
    S.content.style.transform = 'translate3d(0,' + (-S.pos).toFixed(2) + 'px,0)';
    var frac = S.maxPos > 0 ? S.pos / S.maxPos : 1;
    S.prog.style.transform = 'scaleX(' + frac.toFixed(4) + ')';
    var v = speed(), secs = v > 0 ? Math.ceil((S.maxPos - S.pos) / v) : 0, pct = Math.round(frac * 100);
    if (secs !== S.lastSecs) { S.lastSecs = secs; S.left.textContent = fmtTime(secs) + ' left'; }
    if (pct !== S.lastPct) { S.lastPct = pct; S.pct.textContent = pct + '%'; }
    // Brighten the line block under the reading line.
    var y = S.pos >= S.maxPos - 0.5 ? Infinity : S.pos + 1, ci = stopAt(S.stops, y), stopEls = S.stopEls;
    if (ci !== S.cur) {
      if (S.cur >= 0 && stopEls[S.cur]) stopEls[S.cur].classList.remove('cur');
      if (ci >= 0 && stopEls[ci]) stopEls[ci].classList.add('cur');
      S.cur = ci;
    }
  }

  function kick() { if (S && !S.raf) S.raf = requestAnimationFrame(frame); }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    var dt = S.lastTs ? Math.min(0.1, (ts - S.lastTs) / 1000) : 0;
    S.lastTs = ts;
    if (S.jump) {
      var j = S.jump, k = j.dur > 0 ? Math.min(1, Math.max(0, (ts - j.t0) / j.dur)) : 1;
      S.pos = j.from + (j.to - j.from) * (1 - Math.pow(1 - k, 3));
      if (k >= 1) S.jump = null;
    } else if (S.playing) {
      S.pos += speed() * dt; // fractional pixels accumulate; translate3d renders them smoothly
      if (S.pos >= S.maxPos) { S.pos = S.maxPos; render(); pause(); return; }
    }
    render();
    if (S.playing || S.jump) S.raf = requestAnimationFrame(frame);
    else S.lastTs = 0;
  }

  function setPos(p) { if (!S) return; S.jump = null; S.pos = Math.max(0, Math.min(S.maxPos, p)); render(); }
  function jumpTo(p) {
    if (!S) return;
    p = Math.max(0, Math.min(S.maxPos, p));
    S.jump = { from: S.pos, to: p, t0: performance.now(), dur: reducedMotion() ? 0 : 300 };
    kick();
  }
  function para(dir) {
    if (!S) return;
    var cur = S.jump ? S.jump.to : S.pos; // repeated presses chain
    jumpTo(jumpTarget(S.stops, cur, dir, lineH() * 0.6, S.maxPos));
  }

  function updatePlayUi() {
    if (!S) return;
    var b = S.ov.querySelector('[data-act="play"]');
    var on = S.playing || S.cd;
    b.innerHTML = on ? ICON.pause : ICON.play;
    b.title = on ? 'Pause (Space)' : 'Play (Space)';
    b.setAttribute('aria-label', b.title);
    S.ov.classList.toggle('tp-playing', !!S.playing);
  }
  function play() {
    if (!S || S.playing || S.cd) return;
    if (!S.totalWords) return;
    if (S.pos >= S.maxPos - 0.5) setPos(0); // at the end: start over
    if (P.countdown && S.needCd) { countdown(); return; }
    S.needCd = false;
    S.playing = true;
    S.lastTs = 0;
    updatePlayUi();
    poke();
    kick();
  }
  function pause() {
    if (!S) return;
    cancelCountdown();
    S.playing = false;
    updatePlayUi();
    poke();
  }
  function toggle() { if (!S) return; if (S.playing || S.cd) pause(); else play(); }
  function countdown() {
    var n = 3, el = S.cdEl;
    S.cd = true;
    updatePlayUi();
    var tick = function () {
      if (!S || !S.cd) return;
      if (n === 0) { S.cd = false; el.hidden = true; S.needCd = false; play(); return; }
      el.hidden = false;
      el.textContent = n;
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); // restart the pop animation
      n--;
      S.cdT = setTimeout(tick, 900);
    };
    tick();
  }
  function cancelCountdown() {
    if (!S || !S.cd) return;
    clearTimeout(S.cdT);
    S.cd = false;
    S.cdEl.hidden = true;
  }
  function restart() { if (!S) return; pause(); S.needCd = true; jumpTo(0); }

  function setWpm(v) {
    P.wpm = clampWpm(v);
    S.wpmIn.value = P.wpm;
    S.wpmV.textContent = P.wpm + ' wpm';
    S.lastSecs = -1;
    render();
    savePrefs();
  }
  function setFont(v) {
    P.font = Math.max(18, Math.min(140, Math.round(v)));
    syncSheet();
    measure();
    savePrefs();
  }

  function applyLook() {
    if (!S) return;
    S.view.style.transform = (P.mx || P.my) ? 'scale(' + (P.mx ? -1 : 1) + ',' + (P.my ? -1 : 1) + ')' : '';
    S.ov.classList.toggle('tp-noguide', !P.guide);
    S.ov.classList.toggle('tp-light', !!P.light);
    // Text outside the reading line shows at P.others % opacity (a veil of the background colour).
    S.ov.style.setProperty('--tp-veil', (1 - P.others / 100).toFixed(2));
  }
  function syncSheet() {
    if (!S) return;
    var sh = S.sheet;
    sh.querySelector('[data-k="font"]').value = fontPx();
    sh.querySelector('[data-v="font"]').textContent = fontPx() + 'px';
    sh.querySelector('[data-k="width"]').value = P.width;
    sh.querySelector('[data-v="width"]').textContent = P.width + '%';
    sh.querySelector('[data-k="guideY"]').value = P.guideY;
    sh.querySelector('[data-v="guideY"]').textContent = P.guideY + '%';
    sh.querySelector('[data-k="others"]').value = P.others;
    sh.querySelector('[data-v="others"]').textContent = P.others + '%';
    sh.querySelectorAll('[data-tog]').forEach(function (b) {
      var on = !!P[b.getAttribute('data-tog')];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function toggleSheet(force) {
    if (!S) return;
    var show = force == null ? S.sheet.hidden : force;
    S.sheet.hidden = !show;
    S.ov.querySelector('[data-act="settings"]').classList.toggle('on', show);
    if (show) syncSheet();
    poke();
  }

  // Controls fade while playing; any pointer movement / key brings them back.
  function poke() {
    if (!S) return;
    S.ov.classList.remove('tp-idle');
    clearTimeout(S.idleT);
    if (S.playing && S.sheet.hidden) {
      S.idleT = setTimeout(function () { if (S && S.playing && S.sheet.hidden) S.ov.classList.add('tp-idle'); }, 2200);
    }
  }

  function act(a) {
    switch (a) {
      case 'close': close(); break;
      case 'restart': restart(); break;
      case 'back': para(-1); break;
      case 'fwd': para(1); break;
      case 'play': toggle(); break;
      case 'slower': setWpm(P.wpm - 10); break;
      case 'faster': setWpm(P.wpm + 10); break;
      case 'settings': toggleSheet(); break;
      case 'smaller': setFont(fontPx() - 4); break;
      case 'bigger': setFont(fontPx() + 4); break;
      case 'fs':
        if (fsEl()) { S.fsOurs = false; exitFs(); } else { S.fsOurs = true; enterFs(S.ov); }
        break;
    }
  }

  function onKey(e) {
    if (!S) return;
    var k = e.key, handled = true;
    // Enter / Space on a keyboard-focused button activate that button.
    if ((k === 'Enter' || k === ' ') && e.target.closest && e.target.closest('button')) { e.stopPropagation(); poke(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) { e.stopPropagation(); return; }
    switch (k) {
      case ' ': case 'Enter': case 'k': case 'K': case 'MediaPlayPause':
        if (!e.repeat) toggle();
        break;
      case 'ArrowUp': setWpm(P.wpm + (e.shiftKey ? 1 : 10)); break;
      case 'ArrowDown': setWpm(P.wpm - (e.shiftKey ? 1 : 10)); break;
      case 'ArrowRight': case 'PageDown': para(1); break;
      case 'ArrowLeft': case 'PageUp': para(-1); break;
      case 'Home': restart(); break;
      case 'End': pause(); jumpTo(S.maxPos); break;
      case '+': case '=': setFont(fontPx() + 4); break;
      case '-': case '_': setFont(fontPx() - 4); break;
      case 'm': P.mx = !P.mx; applyLook(); syncSheet(); savePrefs(); break;
      case 'M': case 'v': case 'V': P.my = !P.my; applyLook(); syncSheet(); savePrefs(); break;
      case 'g': case 'G': P.guide = !P.guide; applyLook(); syncSheet(); savePrefs(); break;
      case 'Escape':
        if (!S.sheet.hidden) toggleSheet(false); else close();
        break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
    e.stopPropagation(); // modal: nothing reaches the editor behind
    poke();
  }

  function onVis() {
    if (!S) return;
    if (document.visibilityState === 'hidden') pause();
    else wakeAcquire();
  }
  function onFsChange() {
    if (!S) return;
    if (!fsEl() && S.fsOurs) { close(); return; } // Esc out of browser fullscreen = done
    onResize();
  }
  var resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () { resizeRaf = 0; measure(); });
  }

  function close() {
    if (!S) return;
    var s = S;
    S = null;
    clearTimeout(s.cdT); clearTimeout(s.idleT);
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.ro) s.ro.disconnect();
    if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    wakeRelease(s);
    if (fsEl() === s.ov) exitFs();
    s.ov.remove();
    clearTimeout(saveT);
    try { Cade.store.set(PREFS_KEY, JSON.stringify(P)); } catch (e) {}
    if (!coarse()) { try { Cade.editor.focus(); } catch (e) {} }
  }

  function pickSource() {
    try {
      var st = Cade.editor.state, sel = st.selection.main;
      var t = sel.empty ? st.doc.sliceString(0, Math.min(st.doc.length, MAX_CHARS)) : st.sliceDoc(sel.from, Math.min(sel.to, sel.from + MAX_CHARS));
      return { text: t, sel: !sel.empty };
    } catch (e) { return { text: '', sel: false }; }
  }

  function open() {
    Cade.closeAllMenus();
    if (S) { close(); return; }
    loadPrefs();
    var src = pickSource();
    var blocks = toBlocks(src.text);
    var words = 0;
    blocks.forEach(function (b) { words += b.w; });
    if (!words) { Cade.showToast('Nothing to prompt — write or select a script first', 'info', 2600); return; }

    var ov = document.createElement('div');
    ov.id = OV_ID;
    ov.className = 'tp-ov';
    ov.tabIndex = -1;
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Teleprompter');
    ov.innerHTML =
      '<div class="tp-view">' +
        '<div class="tp-content">' + blocksHtml(blocks) + '</div>' +
        '<div class="tp-shade top"></div><div class="tp-shade bot"></div>' +
        '<div class="tp-guide"></div>' +
        '<div class="tp-cd" hidden></div>' +
      '</div>' +
      '<div class="tp-hud"><div class="tp-prog"><i></i></div>' +
        '<div class="tp-meta"><span class="tp-src">' + (src.sel ? 'Selection' : 'Whole note') + ' · ' + words + ' words</span>' +
        '<span class="tp-pct"></span><span class="tp-left"></span></div></div>' +
      '<div class="tp-bar" role="toolbar" aria-label="Teleprompter controls">' +
        '<div class="tp-sheet" hidden>' +
          '<div class="tp-srow">' + slider('font', 'Text size', 18, 140, 1) +
            '<span class="tp-pair">' + btn('smaller', 'Smaller (−)', '<b>A−</b>', 'sm') + btn('bigger', 'Bigger (+)', '<b>A+</b>', 'sm') + '</span></div>' +
          slider('width', 'Line width', 40, 100, 1) +
          slider('guideY', 'Reading line', 15, 60, 1) +
          slider('others', 'Other lines', 5, 100, 5) +
          '<div class="tp-togs">' + tog('mx', '⇋ Mirror') + tog('my', '⇅ Flip') + tog('guide', 'Reading line') +
          tog('countdown', '3-2-1') + tog('light', 'Light') + '</div>' +
          '<div class="tp-help">Space / tap: play · ↑↓ speed · ←→ or PgUp/PgDn: paragraph (page-turner pedals) · ' +
            'Home: restart · +/− size · M mirror · V flip · G line · drag to nudge · Esc close</div>' +
        '</div>' +
        '<div class="tp-speed">' +
          btn('slower', 'Slower (↓)', I('<path d="M5 12h14"/>'), 'sm') +
          '<input class="tp-wpm" type="range" min="' + WPM_MIN + '" max="' + WPM_MAX + '" step="5" aria-label="Speed, words per minute">' +
          btn('faster', 'Faster (↑)', I('<path d="M12 5v14M5 12h14"/>'), 'sm') +
          '<span class="tp-wpmv"></span>' +
        '</div>' +
        '<div class="tp-main">' +
          btn('close', 'Close (Esc)', ICON.close) + btn('restart', 'Restart (Home)', ICON.restart) +
          btn('back', 'Previous paragraph (←)', ICON.back) + btn('play', 'Play (Space)', ICON.play, 'play') +
          btn('fwd', 'Next paragraph (→)', ICON.fwd) + btn('settings', 'Settings', ICON.gear) +
          (canFs() ? btn('fs', 'Full screen', ICON.fs) : '') +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    var content = ov.querySelector('.tp-content');
    var stopEls = [];
    for (var i = 0; i < content.children.length; i++) if (blocks[i].t !== 'hr') stopEls.push(content.children[i]);
    S = {
      ov: ov, view: ov.querySelector('.tp-view'), content: content, guide: ov.querySelector('.tp-guide'),
      shadeTop: ov.querySelector('.tp-shade.top'), shadeBot: ov.querySelector('.tp-shade.bot'),
      cdEl: ov.querySelector('.tp-cd'), prog: ov.querySelector('.tp-prog i'),
      left: ov.querySelector('.tp-left'), pct: ov.querySelector('.tp-pct'), sheet: ov.querySelector('.tp-sheet'),
      wpmIn: ov.querySelector('.tp-wpm'), wpmV: ov.querySelector('.tp-wpmv'),
      blocks: blocks, stopEls: stopEls, stops: [], totalWords: words, textH: 0,
      pos: 0, maxPos: 0, guideY: 0, padTop: 0, cur: -1, lastSecs: -1, lastPct: -1,
      playing: false, cd: false, needCd: true, cdT: 0, raf: 0, lastTs: 0, jump: null,
      idleT: 0, wake: null, fsOurs: false, drag: null, ro: null, measuredH: -1, measuredVh: -1,
    };

    // ---- pointer: tap toggles play, drag nudges the position ----
    var view = S.view;
    view.addEventListener('pointerdown', function (e) {
      if (!S || (e.pointerType === 'mouse' && e.button !== 0)) return;
      S.drag = { y: e.clientY, pos0: S.pos, moved: false, id: e.pointerId };
      try { view.setPointerCapture(e.pointerId); } catch (err) {}
    });
    view.addEventListener('pointermove', function (e) {
      if (!S) return;
      if (e.pointerType === 'mouse') poke();
      var d = S.drag;
      if (!d || d.id !== e.pointerId) return;
      var dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dy) > 8) { d.moved = true; S.jump = null; }
      // Follow the finger as the text appears on screen (flipped when mirrored vertically).
      if (d.moved) setPos(d.pos0 - dy * (P.my ? -1 : 1));
    });
    var endDrag = function (e) {
      if (!S || !S.drag || S.drag.id !== e.pointerId) return;
      var d = S.drag;
      S.drag = null;
      if (d.moved || e.type !== 'pointerup') return;
      if (!S.sheet.hidden) toggleSheet(false); // first tap just dismisses the settings
      else toggle();
    };
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);
    view.addEventListener('wheel', function (e) {
      if (!S) return;
      e.preventDefault();
      var d = e.deltaY * (e.deltaMode === 1 ? lineH() : e.deltaMode === 2 ? view.clientHeight : 1);
      setPos(S.pos + d);
      poke();
    }, { passive: false });

    ov.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act], [data-tog]');
      if (!b || !S) return;
      // A pointer click leaves focus on the overlay, so Space keeps meaning play/pause.
      if (e.detail > 0) { try { b.blur(); ov.focus({ preventScroll: true }); } catch (err) {} }
      if (b.hasAttribute('data-tog')) {
        var k = b.getAttribute('data-tog');
        P[k] = !P[k];
        if (k === 'countdown' && P[k]) S.needCd = S.pos < 1;
        applyLook(); syncSheet(); savePrefs();
      } else act(b.getAttribute('data-act'));
      poke();
    });
    S.wpmIn.addEventListener('input', function () { setWpm(+S.wpmIn.value); poke(); });
    ov.addEventListener('change', function (e) {
      if (e.target.type === 'range') { try { e.target.blur(); ov.focus({ preventScroll: true }); } catch (err) {} }
    });
    S.sheet.addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-k');
      if (k === 'font') setFont(+e.target.value);
      else if (k === 'width' || k === 'guideY') { P[k] = +e.target.value; syncSheet(); measure(); savePrefs(); }
      else if (k === 'others') { P.others = +e.target.value; applyLook(); syncSheet(); savePrefs(); }
    });
    ov.querySelector('.tp-bar').addEventListener('pointermove', function () { poke(); });

    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    // Re-measure when the text re-wraps on its own (late web font) or the
    // view changes size without a window resize. measure() records the
    // height it laid out, so its own style writes don't loop back here.
    if (window.ResizeObserver) {
      S.ro = new ResizeObserver(function () {
        if (S && (S.content.offsetHeight !== S.measuredH || S.view.clientHeight !== S.measuredVh)) onResize();
      });
      S.ro.observe(content);
      S.ro.observe(S.view);
    }
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    try { Cade.editor.contentDOM.blur(); } catch (e) {}
    ov.focus();
    applyLook();
    S.wpmIn.value = P.wpm;
    S.wpmV.textContent = P.wpm + ' wpm';
    updatePlayUi();
    measure();
    wakeAcquire();
    if (canFs()) { S.fsOurs = true; enterFs(ov); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S) measure(); });
  }

  Cade.registerWidget({
    name: 'Teleprompter',
    description: 'Scroll the selection or note full-screen at a set words-per-minute — mirror, pedal & countdown',
    icon: '🎬',
    tags: 'teleprompter,prompter,autocue,script,speech,presentation,scroll,read,video,record,mirror,wpm,pedal,speaker',
    open: open,
    _lib: { toBlocks: toBlocks, cleanInline: cleanInline, countWords: countWords, pxPerSec: pxPerSec, fmtTime: fmtTime,
      stopAt: stopAt, jumpTarget: jumpTarget, clampWpm: clampWpm },
  });
})();
