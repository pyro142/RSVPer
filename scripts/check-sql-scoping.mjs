// Static check: every SQL statement in src/ that touches a per-wedding table
// must mention wedding_id. Catches a new query that forgets tenant scoping
// before it ever reaches review. Run by `npm run lint` and CI.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const TABLES = [
  'weddings',
  'settings',
  'admin_credentials',
  'admin_sessions',
  'invites',
  'invite_guests',
  'rsvps',
  'rsvp_guests',
  'meal_courses',
  'meal_options',
  'rsvp_guest_meals',
  'images',
  'security_events',
];
const TOUCHES = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+(${TABLES.join('|')})\\b`, 'i');
// weddings is keyed by its own id rather than a wedding_id column. A query that
// deliberately spans weddings (e.g. demo sandbox clean-up) must say so with a
// "/* tenant-admin: reason */" comment in the SQL, so it stands out in review.
const SCOPED =
  /\bwedding_id\b|\bFROM\s+weddings\s+WHERE\s+id\s*=|\bUPDATE\s+weddings\b[\s\S]*\bWHERE\s+id\s*=/i;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const problems = [];
for (const file of files('src')) {
  const source = readFileSync(file, 'utf8');
  // String and template literals that look like SQL.
  for (const match of source.matchAll(/(`[^`]*`|'[^'\n]*'|"[^"\n]*")/g)) {
    const text = match[0];
    if (!TOUCHES.test(text)) continue;
    if (!SCOPED.test(text) && !/\/\* tenant-admin: [^*]+\*\//.test(text)) {
      const line = source.slice(0, match.index).split('\n').length;
      problems.push(
        `${relative('.', file)}:${line}: query on a per-wedding table without wedding_id`,
      );
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-sql-scoping: every query on per-wedding tables is scoped by wedding_id.');
