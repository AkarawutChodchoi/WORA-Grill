// Bundles the API server (and shared/) into dist/server; npm packages stay external.
import { build } from 'esbuild';
import { cpSync } from 'node:fs';

await build({
  entryPoints: ['server/src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/server/index.js',
  packages: 'external',
  tsconfig: 'tsconfig.json',
  sourcemap: true,
  logLevel: 'info',
});
cpSync('server/drizzle', 'dist/server/drizzle', { recursive: true });
// Sample menu data (seed-wora.ts resolves it next to the bundle).
cpSync('server/src/db/wora', 'dist/server/wora', { recursive: true });
