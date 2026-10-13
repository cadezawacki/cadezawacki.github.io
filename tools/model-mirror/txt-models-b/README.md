# txt-models-b

Offline translation models for **Cade.txt**'s Translate widget and Decode Lab
(on-device translation to and from English). Served by GitHub Pages at `https://cadezawacki.github.io/txt-models-b/<path>`,
so the app doesn't need to contact third-party hosts.

- **What:** Mozilla's Firefox Translations (Bergamot) int8 models — 71 files, ~942 MB.
  - Into English (`base-memory/`): ar, bs, ca, cs, ja, ko, th, zh-Hans, zh-Hant.
  - From English (`en-x/<lang>/`): es, fr, de, it, pt, nl, ja, zh-Hans, ru, ko, pl, uk,
    ar, tr, sv.
- **Source:** Mozilla Remote Settings, collection `translations-models`. The into-English
  files were copied from the mirror https://huggingface.co/TiberiuCristianLeon/Bergamot
  (commit 18008da9); the from-English files straight from Mozilla's attachment CDN.
- **Integrity:** every file is checked against the size and SHA-256 Mozilla publishes
  (`files.json`) when it is mirrored here, and again by the app before it is used.
- **License:** MPL-2.0 (see `LICENSE`) — © Mozilla and the Bergamot / browsermt
  contributors. These are unmodified copies; the originals are available from Mozilla's
  Remote Settings and the Firefox Translations project.

## Updating

Edit `files.json` (path, url, size, sha256) and push — or run
**Actions → Fetch models → Run workflow**. `fetch.py` downloads, verifies and commits.
