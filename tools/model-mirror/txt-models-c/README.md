# txt-models-c

Offline translation models for **Cade.txt**'s Translate widget and Decode Lab
(on-device translation to and from English). Served by GitHub Pages at
`https://cadezawacki.github.io/txt-models-c/<path>`, so the app doesn't need to
contact third-party hosts.

- **What:** Mozilla's Firefox Translations (Bergamot) int8 models, English -> X
  (`en-x/<lang>/`) — 94 files, ~908 MB. Languages: zh-Hant, bg, bn, bs, ca, cs, da, el, et, fa, fi, gu, he, hi, hr, hu, id, is, kn, lt, lv, ml, ms, ro, sk, sl, sq, sr, te, th, vi.
- **Source:** Mozilla Remote Settings, collection `translations-models`, copied
  straight from Mozilla's attachment CDN (which sends no CORS headers, hence this
  mirror). The other 15 English -> X languages live in `txt-models-b`.
- **Integrity:** every file is checked against the size and SHA-256 Mozilla publishes
  (`files.json`) when it is mirrored here, and again by the app before it is used.
- **License:** MPL-2.0 (see `LICENSE`) — © Mozilla and the Bergamot / browsermt
  contributors. These are unmodified copies; the originals are available from Mozilla's
  Remote Settings and the Firefox Translations project.

## Updating

Edit `files.json` (path, url, size, sha256) and push — or run
**Actions → Fetch models → Run workflow**. `fetch.py` downloads, verifies and commits.
