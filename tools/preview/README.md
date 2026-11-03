# Preview

Draws the plugin's real party panel and dialogs (`src/ui.ts` and `styles.css`) in an ordinary
browser page, using a tiny stand-in for Obsidian (`shim.ts`). Handy for working on the look
without opening Obsidian.

```bash
npm run css           # rebuild styles.css from styles.src.css
npm run preview       # builds tools/preview/out/ ; serve that folder and open index.html
# for example:  python3 -m http.server 8766 --directory tools/preview/out
# scenes: ?scene=empty | waiting | request | party | join | typo | profile | history | firstrun
```

It is a preview, not Obsidian: the window around the panel and the settings page are not drawn.
