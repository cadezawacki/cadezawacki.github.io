/* Shared part-of-speech tags for Prose EKG and Word Echoes (window.__cadeNlp).
 *
 * The tags come from the compromise NLP library running in nlp-worker.js.
 * Both widgets ask for the same thing — the tags of a prepared paragraph
 * (ekg-core's nlpPrep of the masked text) — so one worker and one cache
 * serve both:
 *
 *   var off = __cadeNlp.acquire(onTags);   // a panel opens: start the worker
 *   __cadeNlp.get(text)                    // → tags | null (none: use the word
 *                                          //   lists) | undefined (asked for;
 *                                          //   onTags fires when some arrive)
 *   off();                                 // the panel closes
 *
 * Everything is optional by design: while the library loads, without a
 * connection on the first use, or if it fails, get() answers undefined and
 * then null, and the widgets keep their own rules. The worker is terminated
 * once no panel holds it, and it is fed nothing while the page is hidden.
 * Results are kept in a bounded LRU keyed by the paragraph text, so a
 * re-analysis after an edit only tags the edited paragraph. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__cadeNlp) return;
  var SRC = (document.currentScript && document.currentScript.src) || '';
  var WORKER_URL = SRC ? new URL('nlp-worker.js', SRC).href : './txt/widgets/ekg/nlp-worker.js';
  var MAX = 6000, BATCH_CHARS = 16000, BATCH_N = 40, READY_TIMEOUT = 45000, NOTIFY_MS = 120, NOTIFY_BULK_MS = 1000, RETRY_MS = 30000;

  var cache = new Map(), queue = [], queued = new Set(), listeners = [];
  var worker = null, state = 'idle', inflight = 0, seq = 0, readyTimer = 0, notifyTimer = 0, flushTimer = 0, failedAt = 0, lastNotify = 0;

  function remember(text, r) {
    cache.set(text, r);
    if (cache.size > MAX) { var it = cache.keys(); while (cache.size > MAX) cache.delete(it.next().value); }
  }
  // The first answers (what's on screen) are passed on quickly; while a whole note streams
  // through, at most about once a second, so the panels don't re-render for every batch.
  function notify() {
    if (notifyTimer) return;
    var quiet = Date.now() - lastNotify > 2 * NOTIFY_BULK_MS;
    notifyTimer = setTimeout(function () {
      notifyTimer = 0;
      lastNotify = Date.now();
      listeners.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
    }, quiet ? NOTIFY_MS : NOTIFY_BULK_MS);
  }
  function stop(next) {
    clearTimeout(readyTimer); readyTimer = 0;
    clearTimeout(flushTimer); flushTimer = 0;
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    queue = []; queued.clear(); inflight = 0;
    state = next;
  }
  function fail() {
    if (state === 'failed') return;
    failedAt = Date.now();
    stop('failed');
    notify();                       // pending paragraphs now settle on the word lists
  }
  function start() {
    if (worker || typeof Worker !== 'function') { if (!worker) state = 'failed'; return; }
    try { worker = new Worker(WORKER_URL); } catch (e) { worker = null; state = 'failed'; return; }
    state = 'loading';
    worker.onmessage = onMessage;
    worker.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); fail(); };
    readyTimer = setTimeout(fail, READY_TIMEOUT);
  }
  function onMessage(e) {
    var d = e.data || {};
    if (d.type === 'ready') { clearTimeout(readyTimer); readyTimer = 0; state = 'ready'; schedule(); return; }
    if (d.type === 'fail') { fail(); return; }
    if (d.type !== 'tags') return;
    inflight = 0;
    for (var i = 0; i < d.texts.length; i++) { remember(d.texts[i], d.out[i] || null); queued.delete(d.texts[i]); }
    notify();
    schedule();
  }
  function schedule() {
    if (flushTimer || inflight || state !== 'ready' || !queue.length) return;
    flushTimer = setTimeout(flush, 0);
  }
  function flush() {
    flushTimer = 0;
    if (inflight || state !== 'ready' || !worker || document.hidden) return;
    // newest first: what the reader is looking at was asked for last
    var batch = [], chars = 0;
    while (queue.length && batch.length < BATCH_N && chars < BATCH_CHARS) {
      var t = queue.pop();
      if (!queued.has(t) || cache.has(t)) continue;
      batch.push(t); chars += t.length;
    }
    if (!batch.length) return;
    inflight = ++seq;
    try { worker.postMessage({ id: seq, texts: batch }); } catch (e) { fail(); }
  }
  function onVisible() { if (!document.hidden) schedule(); }

  window.__cadeNlp = {
    // Start (or keep) the worker for a panel; returns its release function.
    acquire: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
      if (listeners.length === 1 || !worker) {
        // (after a failure, another panel opening retries — at most every RETRY_MS)
        if (state === 'idle' || (state === 'failed' && Date.now() - failedAt > RETRY_MS)) { state = 'idle'; start(); }
        document.addEventListener('visibilitychange', onVisible);
      }
      var done = false;
      return function release() {
        if (done) return;
        done = true;
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
        if (!listeners.length) {
          document.removeEventListener('visibilitychange', onVisible);
          clearTimeout(notifyTimer); notifyTimer = 0;
          stop('idle');
        }
      };
    },
    get: function (text) {
      var r = cache.get(text);
      if (r !== undefined) { cache.delete(text); cache.set(text, r); return r; }
      if (state !== 'loading' && state !== 'ready') return null;
      if (!queued.has(text)) {
        queued.add(text); queue.push(text);
        if (queue.length > MAX) queued.delete(queue.shift());     // long-gone versions of edited paragraphs
      }
      schedule();
      return undefined;
    },
    status: function () { return state; },
    // paragraphs still waiting for the worker (0 = caught up)
    pending: function () { return state === 'ready' || state === 'loading' ? queued.size : 0; },
    size: function () { return cache.size; },
    WORKER_URL: WORKER_URL
  };
})();
