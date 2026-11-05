// Seed the LOCAL development database with fake households in mixed states,
// for development and screenshots.
//
//   npm run db:seed:local
//   npm run db:seed:local -- --persist-to ./some/dir   (extra args go to wrangler)
//
// Safety: this only ever runs `wrangler d1 ... --local`. It refuses to run if
// any argument mentions --remote or --preview, and it wipes and replaces the
// local data for the default wedding.
//
// Every name and detail below is invented.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const extra = process.argv.slice(2);
if (extra.some((a) => /remote|preview/i.test(a))) {
  console.error('seed-local: refusing to run against anything but the local database.');
  process.exit(1);
}

const W = 'default';
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const json = (v) => q(JSON.stringify(v));
const sql = [];

// --- wipe ------------------------------------------------------------------
for (const table of ['invites', 'meal_courses', 'images', 'security_events', 'admin_sessions']) {
  sql.push(`DELETE FROM ${table} WHERE wedding_id = '${W}';`);
}
sql.push(`DELETE FROM settings WHERE wedding_id = '${W}' AND key != '_turnstile';`);
sql.push('DELETE FROM rate_limits;');

// --- settings --------------------------------------------------------------
const nextYear = new Date().getUTCFullYear() + 1;
const settings = {
  couple: { name_one: 'Alex', name_two: 'Sam', joiner: '&' },
  event: {
    date: `${nextYear}-06-12`,
    timezone: 'Europe/London',
    locale: 'en-GB',
    ceremony_time: '13:00',
    reception_time: '19:30',
  },
  venue: {
    name: 'The Old Orchard',
    address: 'Somewhere Lane',
    map_url: 'https://www.openstreetmap.org/',
  },
  rsvp: { deadline: `${nextYear}-05-01`, contact: 'Message us if anything changes.' },
  evening: {
    enabled: true,
    day_label: 'The whole day',
    evening_label: 'Evening only',
    evening_note: "We'll see you at the reception from {reception_time}.",
  },
  features: { meals: true, dietary: true, song_request: true, message: true },
};
for (const [key, value] of Object.entries(settings)) {
  sql.push(
    `INSERT INTO settings (wedding_id, key, value) VALUES ('${W}', ${q(key)}, ${json(value)});`,
  );
}
sql.push(`UPDATE weddings SET setup_completed_at = datetime('now') WHERE id = '${W}';`);

// --- menu ------------------------------------------------------------------
sql.push(
  `INSERT INTO meal_courses (id, wedding_id, name, sort_order) VALUES ('c-main', '${W}', 'Main', 0);`,
  `INSERT INTO meal_options (id, wedding_id, course_id, name, description, sort_order) VALUES
     ('m-chicken', '${W}', 'c-main', 'Roast chicken', 'With seasonal vegetables', 0),
     ('m-risotto', '${W}', 'c-main', 'Mushroom risotto', 'Vegetarian', 1),
     ('m-salmon',  '${W}', 'c-main', 'Baked salmon', NULL, 2);`,
);

// --- households --------------------------------------------------------------
// state: pending | opened | accepted | declined | evening-choice
const households = [
  {
    code: 'GUEST2',
    name: 'The Example Family',
    max: 4,
    state: 'accepted',
    guests: [
      ['Pat Example', false, 'm-chicken', null],
      ['Chris Example', true, 'm-risotto', 'No nuts'],
      ['Jamie Example', false, 'm-chicken', null],
    ],
    plusOne: { host: 1, name: 'Sam Guest', meal: 'm-salmon' },
    song: 'September',
    message: 'So happy for you both!',
  },
  {
    code: 'GUEST3',
    name: 'Robin Sample',
    max: 2,
    state: 'pending',
    guests: [['Robin Sample', true]],
  },
  {
    code: 'GUEST4',
    name: 'Taylor & Morgan Placeholder',
    max: 2,
    state: 'declined',
    guests: [
      ['Taylor Placeholder', false],
      ['Morgan Placeholder', false],
    ],
    message: 'Sorry we can’t make it, have a wonderful day.',
  },
  {
    code: 'GUEST5',
    name: 'Casey Demo',
    max: 1,
    state: 'accepted',
    evening: true,
    guests: [['Casey Demo', false, 'm-risotto', 'Vegan']],
  },
  {
    code: 'GUEST6',
    name: 'The Test Household',
    max: 3,
    state: 'opened',
    guests: [
      ['Drew Test', false],
      ['Jordan Test', false],
      ['Riley Test', false],
    ],
  },
  {
    code: 'GUEST7',
    name: 'Quinn Fictional',
    max: 2,
    state: 'evening-choice',
    guests: [['Quinn Fictional', true, 'm-chicken', null]],
    plusOne: { host: 0, name: 'Avery Friend', meal: 'm-chicken' },
    song: 'Mr. Brightside',
  },
  {
    code: 'GUEST8',
    name: 'Sky & Rowan Invented',
    max: 2,
    state: 'pending',
    evening: true,
    guests: [
      ['Sky Invented', false],
      ['Rowan Invented', false],
    ],
  },
  {
    code: 'GUEST9',
    name: 'Frankie Madeup',
    max: 1,
    state: 'accepted',
    guests: [['Frankie Madeup', false, 'm-salmon', null]],
  },
];

households.forEach((h, i) => {
  const inv = `inv-${i + 1}`;
  const opened = h.state !== 'pending';
  sql.push(
    `INSERT INTO invites (id, wedding_id, code, household_name, max_party_size, reception_only, open_count, first_opened_at, last_opened_at)
     VALUES ('${inv}', '${W}', ${q(h.code)}, ${q(h.name)}, ${h.max}, ${h.evening ? 1 : 0}, ${opened ? 1 : 0},
             ${opened ? "datetime('now', '-3 days')" : 'NULL'}, ${opened ? "datetime('now', '-3 days')" : 'NULL'});`,
  );
  h.guests.forEach(([name, plus], gi) => {
    sql.push(
      `INSERT INTO invite_guests (id, wedding_id, invite_id, name, allows_plus_one, sort_order)
       VALUES ('${inv}-g${gi}', '${W}', '${inv}', ${q(name)}, ${plus ? 1 : 0}, ${gi});`,
    );
  });

  if (!['accepted', 'declined', 'evening-choice'].includes(h.state)) return;
  const attending = h.state !== 'declined';
  const rsvp = `${inv}-r`;
  sql.push(
    `INSERT INTO rsvps (id, wedding_id, invite_id, attending, attending_reception_only, song_request, message, submitted_at)
     VALUES ('${rsvp}', '${W}', '${inv}', ${attending ? 1 : 0}, ${h.state === 'evening-choice' ? 1 : 0},
             ${q(attending ? h.song : null)}, ${q(h.message)}, datetime('now', '-${i + 1} days'));`,
  );
  h.guests.forEach(([, , meal, dietary], gi) => {
    const rg = `${rsvp}-g${gi}`;
    sql.push(
      `INSERT INTO rsvp_guests (id, wedding_id, rsvp_id, invite_guest_id, attending, dietary_notes)
       VALUES ('${rg}', '${W}', '${rsvp}', '${inv}-g${gi}', ${attending ? 1 : 0}, ${q(attending ? dietary : null)});`,
    );
    if (attending && meal) {
      sql.push(
        `INSERT INTO rsvp_guest_meals (id, wedding_id, rsvp_guest_id, course_id, meal_option_id)
         VALUES ('${rg}-m', '${W}', '${rg}', 'c-main', ${q(meal)});`,
      );
    }
  });
  if (attending && h.plusOne) {
    const rg = `${rsvp}-p`;
    sql.push(
      `INSERT INTO rsvp_guests (id, wedding_id, rsvp_id, host_guest_id, plus_one_name, attending)
       VALUES ('${rg}', '${W}', '${rsvp}', '${inv}-g${h.plusOne.host}', ${q(h.plusOne.name)}, 1);`,
      `INSERT INTO rsvp_guest_meals (id, wedding_id, rsvp_guest_id, course_id, meal_option_id)
       VALUES ('${rg}-m', '${W}', '${rg}', 'c-main', ${q(h.plusOne.meal)});`,
    );
  }
});

// --- run -----------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'rsvper-seed-'));
const file = join(dir, 'seed.sql');
writeFileSync(file, sql.join('\n') + '\n');
const wrangler = (args) =>
  execFileSync('npx', ['wrangler', 'd1', ...args, '--local', ...extra], { stdio: 'inherit' });

try {
  wrangler(['migrations', 'apply', 'DB']);
  wrangler(['execute', 'DB', `--file=${file}`]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`
Seeded ${households.length} fake households into the LOCAL database.
Run "npm run dev" and open:
  http://localhost:8787/admin        (password from your .dev.vars)
  http://localhost:8787/GUEST3       (a household that hasn't replied)
  http://localhost:8787/GUEST8       (an evening household that hasn't replied)
`);
