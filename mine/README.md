# mine/ — assets for mine.html (Minesweeper)

Everything the board draws that isn't paint-by-code lives here so it can be
swapped without touching mine.html.

```
mine/
  assets/
    modern/   ← default pack (minimal / neumorphic themes, light + dark)
      flag.svg
      mine.svg
      boom.svg      (the mine you actually hit)
      question.svg  (the "?" mark)
    retro/    ← classic Windows 3.1/XP nostalgia pack
      flag.svg
      mine.svg
      boom.svg
      question.svg
```

## Swapping assets

Drop a replacement file with the same name into the pack folder. Any square
SVG (or PNG — keep the `.svg` name or update `ASSET_FILES` in mine.html)
works; art is drawn centered at ~72% of the cell size. Transparent
backgrounds — the cell paints its own background.

- The **modern** pack is used by the Minimal light and dark themes.
- The **retro** pack is used by the Retro theme.
- Add a whole new pack by creating a sibling folder and registering it in
  `ASSET_PACKS` in mine.html (§10 RENDERER).

If a file is missing or fails to load, mine.html falls back to built-in
vector drawing, so the game never breaks from a bad swap.

## Cache note

sw.js precaches these files for offline play. After swapping an asset, bump
`CACHE_VERSION` in sw.js (or use the in-game Settings → "Refresh offline
cache") so installed clients pick up the new art.
