import esbuild from 'esbuild';
await esbuild.build({
  entryPoints: ['test/browser/entry.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'test/browser/out.js',
  platform: 'browser',
  mainFields: ['module', 'browser', 'main'],
  logLevel: 'error',
});
