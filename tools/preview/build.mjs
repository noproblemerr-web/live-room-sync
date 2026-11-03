import esbuild from 'esbuild';
import fs from 'node:fs';

fs.mkdirSync('tools/preview/out', { recursive: true });
await esbuild.build({
  entryPoints: ['tools/preview/entry.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'tools/preview/out/preview.js',
  platform: 'browser',
  alias: { obsidian: './tools/preview/shim.ts' },
  logLevel: 'error',
});
fs.copyFileSync('styles.css', 'tools/preview/out/styles.css');
fs.writeFileSync(
  'tools/preview/out/index.html',
  `<!doctype html><meta charset="utf-8"><title>Live Room Sync preview</title>
<link rel="stylesheet" href="styles.css">
<style>
  :root { --font-interface: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --font-monospace: ui-monospace, Menlo, Consolas, monospace; --font-ui-small: 13px; --font-ui-smaller: 12px; --background-modifier-hover: rgba(255,255,255,.07); --background-modifier-border: #3a3a3a; }
  body { margin: 0; background: #1e1e1e; color: #dadada; font-family: var(--font-interface); }
  #stage { width: 340px; height: 640px; margin: 24px auto; position: relative; background: #262626; }
  #stage .view-content { position: absolute; inset: 0; }
  .modal-scene #stage { display: none; }
  #modal-host { display: none; }
  .modal-scene #modal-host { display: flex; justify-content: center; align-items: flex-start; padding-top: 40px; }
  :where(.modal) { background: #262626; border-radius: 12px; padding: 24px 28px; width: 460px; box-sizing: border-box; }
  .modal-content p { margin: 0 0 12px; }
  .setting-item { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
</style>
<div id="stage"></div><div id="modal-host"></div>
<script>const z = new URLSearchParams(location.search).get("zoom"); if (z) document.documentElement.style.zoom = z;</script>
<script src="preview.js"></script>`,
);
console.log('preview built: tools/preview/out/index.html');
