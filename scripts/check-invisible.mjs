// Lint step: no invisible or bidirectional-control characters in source files
// ("Trojan Source" style hiding). Use \u escapes in code instead.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BAD = /[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|js|mjs|json|jsonc|html|css|md|sql|yml|csv)$/.test(f));

const problems = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  text.split('\n').forEach((line, i) => {
    if (BAD.test(line)) problems.push(`${file}:${i + 1}: invisible or bidi control character`);
  });
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-invisible: no hidden characters in source files.');
