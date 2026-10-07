/* ============================================================
   ARG Desk — model constants (window.ARG_MODEL)
   These are app vocabulary, not game data: every game uses them.
   ============================================================ */
window.ARG_MODEL = {
  version: 3,

  /* Three reality layers. Every claim in a game sits on one. */
  layers: [
    { id: 'record',  label: 'Record',         short: 'REC', color: 'teal',
      desc: 'Documented history. Players can look it up and it checks out.' },
    { id: 'pseudo',  label: 'Pseudo-history', short: 'PSE', color: 'purple',
      desc: 'Real-world mysteries, contested explanations and fringe claims. They exist outside the game but are not settled fact.' },
    { id: 'fiction', label: 'Our fiction',    short: 'FIC', color: 'pink',
      desc: 'Invented for the game.' },
  ],

  /* Puzzle design pipeline, in order. */
  statuses: [
    { id: 'idea',   label: 'Idea' },
    { id: 'draft',  label: 'Draft' },
    { id: 'built',  label: 'Built' },
    { id: 'tested', label: 'Tested' },
    { id: 'ready',  label: 'Ready' },
  ],

  puzzleKinds: [
    { id: 'research', label: 'Research' },
    { id: 'cipher',   label: 'Cipher' },
    { id: 'stego',    label: 'Hidden data' },
    { id: 'logic',    label: 'Logic' },
    { id: 'geo',      label: 'Geolocation' },
    { id: 'audio',    label: 'Audio' },
    { id: 'physical', label: 'Physical' },
    { id: 'meta',     label: 'Meta' },
  ],

  /* Design checks every puzzle should pass before it is Ready. */
  designChecks: [
    { id: 'single',     label: 'Has exactly one answer' },
    { id: 'verifiable', label: 'Real facts it relies on check out online' },
    { id: 'contained',  label: 'Solvable from the trail alone (no insider knowledge)' },
    { id: 'phone',      label: 'Works for a player on a phone' },
    { id: 'people',     label: 'Respects the guard on every real person' },
  ],
};
