# Model mirror scaffolding

Contents for the two GitHub Pages repos that self-host Decode Lab's translation
models (Mozilla Firefox Translations / Bergamot, MPL-2.0), so the app fetches them
from `https://cadezawacki.github.io/txt-models-a/` and `/txt-models-b/` instead of
Hugging Face (`txt/widgets/decodelab/decodelab-translate.js`, `SELF`; the original
URL is only a fallback and stays the cache key).

| Folder | Repo | Files |
| --- | --- | --- |
| `txt-models-a/` | `cadezawacki/txt-models-a` | 100 files, ~812 MB |
| `txt-models-b/` | `cadezawacki/txt-models-b` | 24 files, ~368 MB |

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
