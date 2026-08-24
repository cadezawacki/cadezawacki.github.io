/* Exercises the REAL project/ide.js ingestion against a stub State — the same
   principle as decrypt.js: no second copy of the logic to drift.

     node ingest.test.js

   Covers the parts that are easy to get wrong and impossible to notice:
   the sub-minute floor, the background-time switch, dedupe across two tabs
   racing the same record, and a session that runs past midnight. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); return; }
  failures++;
  console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
}

// ── a State stub with the same contracts ide.js relies on ───────────────
function makeState(settings) {
  const data = { entries: [], projects: [], logs: [], planner: [] };
  let n = 0;
  const uid = () => 'uid' + (++n);
  const dateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    data,
    dateStr,
    getSettings: () => settings,
    // Real getProjects() hides archived unless asked, and returns copies.
    getProjects: (opts = {}) => data.projects
      .filter(p => opts.includeArchived || !p.archived)
      .map(p => ({ ...p })),
    getEntries: (f = {}) => data.entries.filter(e => {
      if (f.type && e.type !== f.type) return false;
      if (!f.includeArchived && e.archived) return false;
      return true;
    }),
    getLogs: (f = {}) => data.logs.filter(l => !f.type || l.type === f.type),
    createProject: (p) => { const x = { id: uid(), color: 'teal', ...p }; data.projects.push(x); return x; },
    createEntry: (p) => { const x = { id: uid(), ...p }; data.entries.push(x); return x; },
    createLog: (p) => { const x = { id: uid(), ...p }; data.logs.push(x); return x; },
    createPlannerBlock: (p) => { const x = { id: uid(), ...p }; data.planner.push(x); return x; },
  };
}

function loadIdeLink(State) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../project/ide.js'), 'utf8');
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    crypto: globalThis.crypto, TextEncoder, setTimeout, clearTimeout,
    State,
    Sync: { isConfigured: () => false, isReconciled: () => true, decrypt: async () => null },
    window: { addEventListener() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Top-level `const IdeLink` never lands on the global object; take it as the
  // script's completion value.
  return vm.runInContext(source + '\n;IdeLink;', sandbox);
}

function record(over = {}) {
  return {
    id: 'rec-1',
    device: 'cade-mbp',
    ide: 'IntelliJ IDEA 2024.3',
    projectName: 'cadezawacki.github.io',
    projectPath: '/Users/cade/dev/cadezawacki.github.io',
    branch: 'claude/ide-activity-tracker',
    startedAt: '2026-08-24T09:14:03.221Z',
    endedAt: '2026-08-24T09:44:03.221Z',
    activeSeconds: 1544,
    readingSeconds: 390,
    backgroundSeconds: 118,
    files: [{ path: 'project/sync.js', seconds: 840, edits: 312 }],
    runs: { run: 2, test: 4 },
    closedBy: 'idle',
    ...over,
  };
}

console.log('ide.js ingestion');

// 1 — a normal session becomes a log, a planner block, a project and a task.
{
  const State = makeState({ ideCountBackground: false });
  const Ide = loadIdeLink(State);
  const changed = Ide._test.ingest(record());
  const log = State.data.logs[0];
  const blk = State.data.planner[0];
  check('ingests one session', changed === true);
  check('one log, one block, one project, one task',
    State.data.logs.length === 1 && State.data.planner.length === 1 &&
    State.data.projects.length === 1 && State.data.entries.length === 1);
  check('active + reading, background excluded by default', log.value === 1934,
    'value=' + log.value);
  check('log carries the raw split for later tuning',
    log.activeSeconds === 1544 && log.readingSeconds === 390 &&
    log.backgroundSeconds === 118 && log.closedBy === 'idle');
  check('log is a time_session attributed to the task',
    log.type === 'time_session' && log.entryId === State.data.entries[0].id);
  check('files ride along', Array.isArray(log.files) && log.files[0].edits === 312);
  check('block is tracked kind, on the session date',
    blk.kind === 'tracked' && blk.date === log.date && blk.sourceId === 'rec-1');
  check('task and project are linked by path',
    State.data.entries[0].ideProjectPath === record().projectPath &&
    State.data.projects[0].ideProjectPath === record().projectPath);
}

// 2 — background time counts only when the setting says so.
{
  const State = makeState({ ideCountBackground: true });
  const Ide = loadIdeLink(State);
  Ide._test.ingest(record());
  check('background counted when enabled', State.data.logs[0].value === 2052,
    'value=' + State.data.logs[0].value);
}

// 3 — the sub-minute floor.
{
  const State = makeState({ ideCountBackground: false });
  const Ide = loadIdeLink(State);
  const changed = Ide._test.ingest(record({ activeSeconds: 30, readingSeconds: 20 }));
  check('under a minute is dropped', changed === false && State.data.logs.length === 0);
  check('and does not create a project for nothing', State.data.projects.length === 0);
}

// 4 — dedupe: the same record twice, and the ids two racing tabs would agree on.
{
  const State = makeState({ ideCountBackground: false });
  const Ide = loadIdeLink(State);
  Ide._test.ingest(record());
  const again = Ide._test.ingest(record());
  check('the same record twice is ingested once',
    again === false && State.data.logs.length === 1);
  check('log and block ids are derived from the record, not random',
    State.data.logs[0].id === 'ide-log-rec-1' && State.data.planner[0].id === 'ide-blk-rec-1');

  // A second, independent tab: same record, its own State. The ids must match
  // the first tab's, or sync's merge keeps both copies.
  const State2 = makeState({ ideCountBackground: false });
  const Ide2 = loadIdeLink(State2);
  Ide2._test.ingest(record());
  check('a second tab computes the same ids',
    State2.data.logs[0].id === State.data.logs[0].id &&
    State2.data.projects[0].id === State.data.projects[0].id &&
    State2.data.entries[0].id === State.data.entries[0].id);
}

// 5 — a second session on the same project reuses the project and the task.
{
  const State = makeState({ ideCountBackground: false });
  const Ide = loadIdeLink(State);
  Ide._test.ingest(record());
  Ide._test.ingest(record({ id: 'rec-2' }));
  check('reuses the project and task', State.data.projects.length === 1 &&
    State.data.entries.length === 1 && State.data.logs.length === 2);
}

// 6 — an archived project is still THE project.
{
  const State = makeState({ ideCountBackground: false });
  const Ide = loadIdeLink(State);
  Ide._test.ingest(record());
  State.data.projects[0].archived = true;
  State.data.entries[0].archived = true;
  Ide._test.ingest(record({ id: 'rec-3' }));
  check('archived project is not duplicated',
    State.data.projects.length === 1 && State.data.entries.length === 1);
}

// 7 — a session that runs past midnight is clamped, not left backwards.
{
  const State = makeState({ ideCountBackground: false });
  const Ide = loadIdeLink(State);
  const start = new Date(2026, 7, 24, 23, 40, 0);
  const end = new Date(2026, 7, 25, 0, 20, 0);
  Ide._test.ingest(record({
    id: 'rec-mid', startedAt: start.toISOString(), endedAt: end.toISOString(),
  }));
  const blk = State.data.planner[0];
  check('block stays on the start date', blk.date === '2026-08-24');
  check('block end does not precede its start', blk.end > blk.start,
    blk.start + '→' + blk.end);
}

// 8 — a missing endedAt is derived rather than producing an invalid block.
{
  const State = makeState({ ideCountBackground: false });
  const Ide = loadIdeLink(State);
  Ide._test.ingest(record({ id: 'rec-noend', endedAt: undefined }));
  const blk = State.data.planner[0];
  check('derives an end from the duration', !!blk && blk.end > blk.start,
    blk && blk.start + '→' + blk.end);
}

// 9 — a record with no usable start is dropped, not turned into NaN.
{
  const State = makeState({ ideCountBackground: false });
  const Ide = loadIdeLink(State);
  const changed = Ide._test.ingest(record({ id: 'rec-bad', startedAt: 'not a date' }));
  check('an unparseable start is dropped', changed === false && State.data.logs.length === 0);
}

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
