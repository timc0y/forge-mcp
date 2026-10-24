import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{
    name: 'markdown-text-modules',
    enforce: 'pre',
    async load(id) {
      // Match Wrangler's Text modules; Markdown stays literal source in tests too.
      if (id.endsWith('.md')) return `export default ${JSON.stringify(await readFile(id, 'utf8'))};`;
      if (id.endsWith('.ttf')) return `export default new Uint8Array(${JSON.stringify([...await readFile(id)])}).buffer;`;
    }
  }]
});
