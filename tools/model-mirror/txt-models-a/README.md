# txt-models-a

Offline translation models for **Cade.txt**'s Decode Lab (translate into English on
the device). Served by GitHub Pages at `https://cadezawacki.github.io/txt-models-a/<path>`,
so the app doesn't need to contact third-party hosts.

- **What:** Mozilla's Firefox Translations (Bergamot) int8 models — 100 files, ~812 MB.
  Languages: ar, bn, da, el, fa, fi, gu, he, hi, hr, hu, id, is, it, ja, kn, ko, lt, lv, ml, ms, nl, pl, pt, ro, ru, sk, sl, sq, sr, sv, te, tr, uk, vi, zh-Hans.
- **Source:** Mozilla Remote Settings, collection `translations-models`; copied from the
  mirror https://huggingface.co/manateelazycat/firefox-translations-93-pairs (commit 32fd180b).
- **Integrity:** every file is checked against the size and SHA-256 Mozilla publishes
  (`files.json`) when it is mirrored here, and again by the app before it is used.
- **License:** MPL-2.0 (see `LICENSE`) — © Mozilla and the Bergamot / browsermt
  contributors. These are unmodified copies; the originals are available from Mozilla's
  Remote Settings and the Firefox Translations project.

## Updating

Edit `files.json` (path, url, size, sha256) and push — or run
**Actions → Fetch models → Run workflow**. `fetch.py` downloads, verifies and commits.
