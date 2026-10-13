# Model mirror scaffolding

Contents for the GitHub Pages repos that self-host the on-device translation
models (Mozilla Firefox Translations / Bergamot, MPL-2.0) used by the Translate
widget, Decode Lab and the inline ```Spanish chips, so the app fetches them from
`https://cadezawacki.github.io/txt-models-{a,b,c}/` instead of third-party hosts
(`txt/widgets/decodelab/decodelab-translate.js`):

- X -> English (`SELF`): copies of what two Hugging Face mirrors serve; the original
  URL is only a fallback and stays the cache key.
- English -> X (`TO_BASES`, `en-x/<lang>/`): copied from Mozilla's attachment CDN,
  which sends no CORS headers, so the mirror is the only source.

| Folder | Repo | Files |
| --- | --- | --- |
| `txt-models-a/` | `cadezawacki/txt-models-a` | 100 files, ~812 MB (X -> English) |
| `txt-models-b/` | `cadezawacki/txt-models-b` | 71 files, ~942 MB (X -> English for 9 languages; English -> X for the 15 most used) |
| `txt-models-c/` | `cadezawacki/txt-models-c` | 94 files, ~908 MB (English -> X for the other 31 languages) |

A GitHub Pages site may be at most 1 GB, hence three repos.

Each folder is the repo's whole initial content: `files.json` (path, source url,
size, sha256), `fetch.py` + `.github/workflows/fetch.yml` (the "Fetch models" Action:
download, verify, commit in batches), `README.md`, `LICENSE` (MPL-2.0), `.nojekyll`.

Setup: create each repo (public), push the folder's contents to `main` — the Action
starts on that push and commits the models (~10 min) — then Settings → Pages →
Deploy from a branch → `main` / root. (The workflow in these folders doesn't run
from this repo: GitHub only runs workflows at the repository root.)

The Read Aloud HD voices are deliberately NOT mirrored: every Piper voice is
fine-tuned from the Lessac voice, whose dataset is under a restrictive research
licence (Blizzard 2013), so they stay on Hugging Face.
