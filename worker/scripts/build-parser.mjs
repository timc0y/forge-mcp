import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Compile only TypeScript in browser mode: the Worker consumes syntax APIs,
// while Node CLI analysis retains the package's ordinary filesystem system.
await build({
  stdin: { contents: 'import ts from "typescript"; export default ts;', resolveDir: worker },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  define: { process: 'undefined' },
  external: ['fs', 'path', 'os', 'crypto', 'inspector', 'perf_hooks'],
  outfile: path.join(worker, '.wrangler/typescript-parser.mjs')
});
