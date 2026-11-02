import esbuild from 'esbuild';
import { builtinModules } from 'node:module';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2021',
  platform: 'browser',
  mainFields: ['module', 'browser', 'main'],
  conditions: ['module', 'browser', 'import'],
  outfile: 'main.js',
  logLevel: 'info',
  treeShaking: true,
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules, ...builtinModules.map((m) => 'node:' + m)],
});
