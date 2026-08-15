/* ═══════════════════════════════════════════════════════════════
   PALETTE — Command palette (Ctrl+K) + natural-language quick add
   Fuzzy search across actions, tabs, projects, and entries.
   Typing free text live-parses "#tag @project !prio ~30m tomorrow 3pm"
   into a ready-to-create entry with a chips preview.
   ═══════════════════════════════════════════════════════════════ */

const Palette = (() => {
  let items = [];       // currently rendered, in DOM order
  let sel = 0;
  let built = false;

  // ── tiny fuzzy (substring beats subsequence) ─────────────────
  function fuzzy(q, text) {
    const t = (text || '').toLowerCase();
    if (!q) return 0;
    const idx = t.indexOf(q);
    if (idx >= 0) return 200 - idx * 2 - Math.min(t.length - q.length, 40);
    let ti = 0, score = 0, streak = 0;
    for (const ch of q) {
      if (ch === ' ') continue;
      const found = t.indexOf(ch, ti);
      if (found === -1) return -1;
      streak = found === ti ? streak + 1 : 1;
      score += 4 + streak * 2 - Math.min(found - ti, 10) * 0.5;
      ti = found + 1;
    }
    return score;
  }

  // ═══════════════════════════════════════════════════════════
  // NATURAL-LANGUAGE QUICK ADD
  // "Fix login crash tomorrow 3pm #bugs @Work !high ~30m"
  // ═══════════════════════════════════════════════════════════
  const WEEKDAYS = {
    sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5, saturday: 6, sat: 6,
  };
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function dstr(d) { return State.dateStr(d); }
  function plusDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return dstr(d); }

  function parse(raw) {
    let text = ' ' + (raw || '').trim() + ' ';
    const out = {
      type: 'task', title: '', tags: [], projectId: null, projectName: null,
      priority: null, estimateMinutes: null, dueDate: null, remindTime: null,
    };

    // type prefix — "habit: drink water"
    const typeM = text.match(/^\s+(task|habit|goal|note|reminder)\s*:\s*/i);
    if (typeM) { out.type = typeM[1].toLowerCase(); text = ' ' + text.slice(typeM[0].length); }

    // #tags
    text = text.replace(/\s#([\w-]+)/g, (_, t) => { out.tags.push(t.toLowerCase()); return ' '; });

    // @project or /project — quoted for multi-word names, else single token
    text = text.replace(/\s[@/](?:"([^"]+)"|([\w&-]+))/g, (m, quoted, bare) => {
      const q = (quoted || bare).toLowerCase();
      const projects = State.getProjects();
      let best = projects.find(p => p.name.toLowerCase() === q)
        || projects.find(p => p.name.toLowerCase().startsWith(q))
        || projects.find(p => p.name.toLowerCase().includes(q));
      if (!best) {
        let bestScore = 0;
        projects.forEach(p => { const s = fuzzy(q, p.name); if (s > bestScore) { bestScore = s; best = p; } });
      }
      if (!best) return m; // no match — leave it in the title, honest
      out.projectId = best.id; out.projectName = best.name;
      return ' ';
    });

    // !priority (also p1–p4)
    text = text.replace(/\s!(urgent|high|med|medium|low)\b/i, (_, p) => {
      out.priority = p.toLowerCase() === 'med' ? 'medium' : p.toLowerCase();
      return ' ';
    }).replace(/\sp([1-4])\b/i, (m, n) => {
      if (out.priority) return m;
      out.priority = ['urgent', 'high', 'medium', 'low'][Number(n) - 1];
      return ' ';
    });

    // ~estimate: ~30m ~2h ~1h30m ~90
    text = text.replace(/\s~(\d+)h(?:(\d+)m?)?\b/i, (_, h, m) => {
      out.estimateMinutes = Number(h) * 60 + Number(m || 0); return ' ';
    }).replace(/\s~(\d+)(m|min)?\b/i, (m0, n) => {
      if (out.estimateMinutes) return m0;
      out.estimateMinutes = Number(n); return ' ';
    });

    // dates — most specific first
    text = text.replace(/\s(\d{4}-\d{2}-\d{2})\b/, (_, iso) => { out.dueDate = iso; return ' '; });
    if (!out.dueDate) {
      // "aug 12" / "august 12th" / "12 aug"
      const md = /\s(?:on\s+|by\s+|due\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
      const dm = /\s(?:on\s+|by\s+|due\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/i;
      const tryMonth = (mName, day) => {
        const mo = MONTHS[mName.slice(0, 3).toLowerCase()];
        if (mo === undefined || day < 1 || day > 31) return null;
        const now = new Date();
        let d = new Date(now.getFullYear(), mo, day);
        if (dstr(d) < State.todayStr()) d = new Date(now.getFullYear() + 1, mo, day);
        return dstr(d);
      };
      let m = text.match(md);
      if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
        const r = tryMonth(m[1], Number(m[2]));
        if (r) { out.dueDate = r; text = text.replace(md, ' '); }
      }
      if (!out.dueDate && (m = text.match(dm)) && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
        const r = tryMonth(m[2], Number(m[1]));
        if (r) { out.dueDate = r; text = text.replace(dm, ' '); }
      }
    }
    if (!out.dueDate) {
      text = text
        .replace(/\s(?:due\s+|by\s+)?(today|tonight)\b/i, () => { out.dueDate = plusDays(0); return ' '; })
        .replace(/\s(?:due\s+|by\s+|on\s+)?(tomorrow|tmrw|tmr)\b/i, () => { out.dueDate = plusDays(1); return ' '; })
        .replace(/\snext\s+week\b/i, () => { out.dueDate = plusDays(7); return ' '; })
        .replace(/\sin\s+(\d+)\s*(?:days?|d)\b/i, (_, n) => { out.dueDate = plusDays(Number(n)); return ' '; });
    }
    if (!out.dueDate) {
      const wd = /\s(?:on\s+|by\s+|due\s+|next\s+)?(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/i;
      const m = text.match(wd);
      if (m) {
        const target = WEEKDAYS[m[1].toLowerCase()];
        const todayDow = new Date().getDay();
        const diff = ((target - todayDow + 7) % 7) || 7; // always the NEXT one
        out.dueDate = plusDays(diff);
        text = text.replace(wd, ' ');
      }
    }

    // time — "3pm", "at 15:30"
    text = text.replace(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (_, h, mm, ap) => {
      let hh = Number(h) % 12;
      if (ap.toLowerCase() === 'pm') hh += 12;
      out.remindTime = `${String(hh).padStart(2, '0')}:${mm || '00'}`;
      return ' ';
    });
    if (!out.remindTime) {
      text = text.replace(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/, (_, h, mm) => {
        out.remindTime = `${String(Number(h)).padStart(2, '0')}:${mm}`;
        return ' ';
      });
    }

    out.title = text.replace(/\s+/g, ' ').trim();
    return out;
  }

  function chipsFor(p) {
    const chips = [];
    if (p.type !== 'task') chips.push({ icon: 'shapes', label: p.type });
    if (p.dueDate) {
      const d = new Date(p.dueDate + 'T00:00');
      const today = State.todayStr();
      const label = p.dueDate === today ? 'today'
        : p.dueDate === plusDays(1) ? 'tomorrow'
        : d.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
      chips.push({ icon: 'calendar', label });
    }
    if (p.remindTime) chips.push({ icon: 'clock', label: p.remindTime });
    if (p.priority) chips.push({ icon: 'flag', label: p.priority });
    if (p.estimateMinutes) {
      const h = Math.floor(p.estimateMinutes / 60), m = p.estimateMinutes % 60;
      chips.push({ icon: 'hourglass', label: h ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m` });
    }
    p.tags.forEach(t => chips.push({ icon: 'tag', label: '#' + t }));
    if (p.projectName) chips.push({ icon: 'folder', label: p.projectName, color: State.getProject(p.projectId)?.color });
    return chips;
  }

  function createFromText(raw, opts = {}) {
    const p = parse(raw);
    if (!p.title) return null;
    const type = opts.forceType || p.type;
    const partial = { type, title: p.title };
    if (p.tags.length) { p.tags.forEach(t => State.getOrCreateTag(t)); partial.tags = p.tags; }
    const pid = p.projectId || opts.defaultProjectId || null;
    if (pid) { partial.projectId = pid; partial.projectIds = [pid]; }
    if (p.priority) partial.priority = p.priority;
    if (p.estimateMinutes) partial.estimateMinutes = p.estimateMinutes;
    if (p.dueDate) partial.dueDate = p.dueDate;
    if (p.remindTime) partial.remindTime = p.remindTime;
    const entry = State.createEntry(partial);
    const summary = chipsFor({ ...p, type }).map(c => c.label).join(' · ');
    return { entry, summary };
  }

  // ═══════════════════════════════════════════════════════════
  // ITEM SOURCES
  // ═══════════════════════════════════════════════════════════
  const TAB_META = {
    today: 'layout-dashboard', projects: 'folder-kanban', habits: 'repeat',
    focus: 'crosshair', planner: 'calendar-days', scratch: 'lightbulb', tools: 'wrench',
    health: 'apple', insights: 'bar-chart-3', history: 'history', settings: 'settings',
  };
  const TYPE_ICONS = { task: 'list-checks', habit: 'repeat', goal: 'target', note: 'sticky-note', reminder: 'clock' };

  function actionItems() {
    const acts = [
      { icon: 'plus', title: 'New task', kw: 'create add task', run: () => App.openNewEntry('task') },
      { icon: 'repeat', title: 'New habit', kw: 'create add habit', run: () => App.openNewEntry('habit') },
      { icon: 'target', title: 'New goal', kw: 'create add goal', run: () => App.openNewEntry('goal') },
      { icon: 'folder-plus', title: 'New project', kw: 'create add project folder', run: () => App.openNewProject() },
      { icon: 'zap', title: 'Quick log', kw: 'mood energy journal checkin log', run: () => App.openQuickLog() },
      { icon: 'timer', title: 'Open timer window', kw: 'pomodoro stopwatch countdown clock', run: () => Timers.toggleWindow() },
      { icon: 'square', title: 'Stop all timers', kw: 'pause halt tracking', run: () => { Timers.stopAll(); App.render(); } },
      { icon: 'clipboard-copy', title: 'Copy filtered tasks for LLM', kw: 'export json clipboard ai', run: () => App.exportForLLM() },
      { icon: 'clipboard-paste', title: 'Paste / import tasks', kw: 'bulk import list markdown llm', run: () => App.openPasteImport() },
      { icon: 'list-todo', title: 'Daily review — triage overdue', kw: 'overdue reschedule sweep inbox', run: () => App.openDailyReview() },
      { icon: 'wand-2', title: 'Auto-plan today', kw: 'schedule time block planner estimates', run: () => App.openAutoPlan() },
      { icon: 'sun-moon', title: 'Toggle light/dark theme', kw: 'dark light mode appearance', run: () => App.toggleTheme() },
      { icon: 'folder-cog', title: 'Manage projects', kw: 'rename nest archive project', run: () => App.openManageProjects() },
      { icon: 'tags', title: 'Manage tags', kw: 'rename color tag', run: () => App.openManageTags() },
      { icon: 'archive', title: 'View archive', kw: 'archived hidden', run: () => App.viewArchive() },
    ];
    Object.keys(TAB_META).forEach(tab => acts.push({
      icon: TAB_META[tab],
      title: 'Go to ' + tab.charAt(0).toUpperCase() + tab.slice(1),
      kw: 'goto open tab view switch ' + tab,
      run: () => App.switchTab(tab),
    }));
    return acts.map(a => ({ ...a, kind: 'action', group: 'Actions' }));
  }

  function buildItems(q) {
    const query = q.trim().toLowerCase();
    const explicitCreate = q.trim().startsWith('>');
    const createText = explicitCreate ? q.trim().slice(1).trim() : q.trim();
    const list = [];

    if (!explicitCreate) {
      if (!query) {
        // resting state: quick actions + recent open tasks
        const acts = actionItems();
        list.push(...acts.slice(0, 6).map(a => ({ ...a, group: 'Quick actions' })));
        const recent = State.getEntries({ type: 'task', completed: false })
          .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 5);
        recent.forEach(t => list.push(entryItem(t, 'Jump back in')));
        ['today', 'focus', 'planner', 'insights'].forEach(tab => list.push({
          kind: 'action', group: 'Go to', icon: TAB_META[tab],
          title: 'Go to ' + tab.charAt(0).toUpperCase() + tab.slice(1),
          run: () => App.switchTab(tab),
        }));
      } else {
        const scored = [];
        actionItems().forEach(a => {
          const s = Math.max(fuzzy(query, a.title), fuzzy(query, a.kw) - 30);
          if (s >= 0) scored.push({ item: { ...a, group: 'Results' }, s: s + 5 });
        });
        State.getProjects().forEach(p => {
          const s = fuzzy(query, p.name);
          if (s >= 0) scored.push({
            item: {
              kind: 'project', group: 'Results', icon: 'folder-kanban', color: p.color,
              title: p.name, hint: 'project',
              // Open the project's own page, taking its workspace along so
              // the room strip shows its siblings.
              run: () => {
                if (p.parentId) App.openSubproject(p.parentId, p.id);
                else App.setWorkspace(p.id);
                App.switchTab('projects');
              },
            }, s: s + 10,
          });
        });
        State.getEntries().forEach(e => {
          const s = fuzzy(query, e.title + ' ' + (e.tags || []).join(' '));
          if (s < 0) return;
          let boost = e.type === 'task' && !e.completed ? 15 : 0;
          if (e.completed) boost -= 20;
          scored.push({ item: entryItem(e, 'Results'), s: s + boost });
        });
        scored.sort((a, b) => b.s - a.s);
        list.push(...scored.slice(0, 9).map(x => x.item));
      }
    }

    // create row — whenever there's creatable text
    if (createText) {
      const p = parse(createText);
      if (p.title) {
        // no run() — execute() special-cases 'create' to read the live input
        list.push({ kind: 'create', group: 'Create', icon: 'plus-circle', title: p.title, parsed: p });
      }
    }
    return list;
  }

  function entryItem(e, group) {
    const proj = e.projectId ? State.getProject(e.projectId) : null;
    return {
      kind: 'entry', group, icon: TYPE_ICONS[e.type] || 'list-checks',
      color: proj?.color, title: e.title, completed: e.completed,
      hint: proj ? proj.name : e.type,
      run: () => { if (e.type === 'task') App.openTaskPage(e.id); else App.editEntry(e.id); },
    };
  }

  // ═══════════════════════════════════════════════════════════
  // DOM
  // ═══════════════════════════════════════════════════════════
  function buildDom() {
    if (built) return;
    built = true;
    const root = document.createElement('div');
    root.className = 'cmdk-overlay';
    root.id = 'cmdkOverlay';
    root.innerHTML = `
      <div class="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="cmdk-input-row">
          <i data-lucide="command" style="width:16px;height:16px"></i>
          <textarea id="cmdkInput" rows="1" autocomplete="off" spellcheck="false"
            placeholder="Search, run a command, or just type a task…"></textarea>
          <kbd>esc</kbd>
        </div>
        <div class="cmdk-results" id="cmdkResults"></div>
        <div class="cmdk-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span class="cmdk-foot-hint">try: <em>Fix login tomorrow 3pm #bugs @Work !high ~30m</em></span>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    // Contain palette keys — the app's global Escape/hotkey handler must not
    // also fire while the palette is open.
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); execute(sel); }
    });
    document.getElementById('cmdkInput').addEventListener('input', (e) => {
      if (typeof App !== 'undefined') App.autoGrow(e.target); // long NL strings wrap, not scroll
      renderResults(e.target.value);
    });
  }

  function renderResults(q) {
    items = buildItems(q);
    sel = 0;
    const el = document.getElementById('cmdkResults');
    if (items.length === 0) {
      el.innerHTML = `<div class="cmdk-empty">Nothing matches “${q}”.</div>`;
      return;
    }
    let html = '';
    let lastGroup = null;
    items.forEach((it, i) => {
      if (it.group !== lastGroup) {
        html += `<div class="cmdk-group">${it.group}</div>`;
        lastGroup = it.group;
      }
      if (it.kind === 'create') {
        const chips = chipsFor(it.parsed);
        html += `
          <button class="cmdk-row cmdk-create ${i === sel ? 'active' : ''}" data-idx="${i}">
            <i data-lucide="plus-circle" style="width:15px;height:15px"></i>
            <div class="cmdk-create-main">
              <span class="cmdk-title">Create ${it.parsed.type} “${esc(it.title)}”</span>
              ${chips.length ? `<span class="cmdk-chiprow">${chips.map(c => `
                <span class="cmdk-chip" ${c.color ? `style="border-color:${c.color};"` : ''}>
                  <i data-lucide="${c.icon}" style="width:10px;height:10px"></i>${esc(c.label)}</span>`).join('')}</span>` : ''}
            </div>
            <kbd>↵</kbd>
          </button>`;
      } else {
        html += `
          <button class="cmdk-row ${i === sel ? 'active' : ''}" data-idx="${i}">
            <i data-lucide="${it.icon}" style="width:15px;height:15px"></i>
            ${it.color ? `<span class="proj-dot" style="background:${it.color}"></span>` : ''}
            <span class="cmdk-title ${it.completed ? 'completed' : ''}">${esc(it.title)}</span>
            ${it.hint ? `<span class="cmdk-hint">${esc(it.hint)}</span>` : ''}
          </button>`;
      }
    });
    el.innerHTML = html;
    el.querySelectorAll('.cmdk-row').forEach(row => {
      row.addEventListener('click', () => execute(Number(row.dataset.idx)));
      row.addEventListener('mousemove', () => setSel(Number(row.dataset.idx)));
    });
    if (window.lucide) lucide.createIcons();
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setSel(i) {
    if (i === sel || !items[i]) return;
    sel = i;
    document.querySelectorAll('.cmdk-row').forEach(r =>
      r.classList.toggle('active', Number(r.dataset.idx) === sel));
  }

  function move(delta) {
    if (!items.length) return;
    sel = (sel + delta + items.length) % items.length;
    document.querySelectorAll('.cmdk-row').forEach(r =>
      r.classList.toggle('active', Number(r.dataset.idx) === sel));
    document.querySelector('.cmdk-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function execute(i) {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'create') {
      const raw = document.getElementById('cmdkInput').value.trim();
      const text = raw.startsWith('>') ? raw.slice(1).trim() : raw;
      const r = createFromText(text);
      close();
      if (r) {
        App.render();
        const t = r.entry.type;
        App.toast(`${t.charAt(0).toUpperCase() + t.slice(1)} created${r.summary ? ' — ' + r.summary : ''}`);
      }
      return;
    }
    close();
    it.run();
  }

  function open() {
    buildDom();
    const root = document.getElementById('cmdkOverlay');
    root.classList.add('active');
    const input = document.getElementById('cmdkInput');
    input.value = '';
    input.style.height = ''; // reset any grown height from last use
    renderResults('');
    setTimeout(() => input.focus(), 30);
  }

  function close() {
    document.getElementById('cmdkOverlay')?.classList.remove('active');
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur(); // keep single-key hotkeys alive
    }
  }

  function isOpen() {
    return !!document.getElementById('cmdkOverlay')?.classList.contains('active');
  }

  return { open, close, isOpen, parse, createFromText };
})();
