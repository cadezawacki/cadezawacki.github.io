# txt-models-b

Offline translation models for **Cade.txt**'s Decode Lab (translate into English on
the device). Served by GitHub Pages at `https://cadezawacki.github.io/txt-models-b/<path>`,
so the app doesn't need to contact third-party hosts.

- **What:** Mozilla's Firefox Translations (Bergamot) int8 models — 24 files, ~368 MB.
  Languages: ar, bs, ca, cs, ja, ko, th, zh-Hans, zh-Hant.
- **Source:** Mozilla Remote Settings, collection `translations-models`; copied from the
  mirror https://huggingface.co/TiberiuCristianLeon/Bergamot (commit 18008da9).
- **Integrity:** every file is checked against the size and SHA-256 Mozilla publishes
  (`files.json`) when it is mirrored here, and again by the app before it is used.
- **License:** MPL-2.0 (see `LICENSE`) — © Mozilla and the Bergamot / browsermt
  contributors. These are unmodified copies; the originals are available from Mozilla's
  Remote Settings and the Firefox Translations project.

## Updating

Edit `files.json` (path, url, size, sha256) and push — or run
**Actions → Fetch models → Run workflow**. `fetch.py` downloads, verifies and commits.
