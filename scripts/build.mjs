// Copies third-party browser assets out of node_modules into public/vendor/,
// so the deployed site serves them itself: no CDN, no third-party requests,
// and nothing that can change underneath you after deploy.
//
// Runs as part of `npm run deploy` (and therefore the Deploy to Cloudflare
// button). public/vendor/ is gitignored.

import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');

const copies = [
  ['node_modules/canvas-confetti/dist/confetti.browser.js', 'confetti/confetti.browser.js'],
  ['node_modules/canvas-confetti/LICENSE', 'confetti/LICENSE'],
];

rmSync(vendor, { recursive: true, force: true });

for (const [from, to] of copies) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.error(`build: missing ${from}. Did you run npm install?`);
    process.exit(1);
  }
  const dest = join(vendor, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

console.log(`build: copied ${copies.length} vendor files to public/vendor/`);
