// Every journey, added up — which is where the answer to "who is this for?"
// actually lives.
//
// A single journey says one job is awkward. Twelve of them, tallied, say
// something a journey cannot: **which ffmpeg concepts this application requires,
// ranked by how many ordinary jobs cannot be done without them.** That number is
// the audience test. A tool for people with video problems should require none
// of them for the common jobs; a tool for ffmpeg users can require all of them
// and be excellent.
//
// This does not re-run the journeys — each one needs its own process, because
// each one starts from a workspace and a timeline that must not be somebody
// else's. It reads the record each journey wrote to `out/journeys/` and adds
// them up, so the aggregate cannot drift from what the journeys actually did.
//
// Usage: <run each journey>  then
//        ffmpeg-bro-headless ui/ tests/usecases/run_all.js [-- <dir>]

import { CONCEPTS } from './journey.js';

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const fs = require('fs');
// Against `bro.appDir` for `journey.js`'s reason: a relative path here would be
// read under `ui/`.
const dir = args[0] || `${bro.appDir}/../out/journeys`;

const rows = fs.readdirSync(dir)
    .filter((n) => /\.json$/.test(n))
    .sort()
    .map((n) => JSON.parse(String(fs.readFileSync(`${dir}/${n}`, 'utf-8'))));

assert(rows.length > 0, `no journey records in ${dir}`);

const bar = (n = 74) => '─'.repeat(n);
const pad = (s, n) => String(s).padEnd(n, ' ');

console.log('');
console.log(bar());
console.log(`WHAT ${rows.length} ORDINARY JOBS COST`);
console.log(bar());
console.log('');
console.log(`  ${pad('', 6)}${pad('steps', 7)}${pad('stages', 8)}${pad('ffmpeg', 8)}` +
            `${pad('hidden', 8)}${pad('got it', 8)}job`);
for (const r of rows) {
    console.log(`  ${pad(r.id, 6)}${pad(r.steps, 7)}${pad(r.stages.length, 8)}` +
                `${pad(r.concepts.length, 8)}${pad(r.hidden, 8)}` +
                `${pad(r.outcome && r.outcome.ok ? 'yes' : 'NO', 8)}${r.title}`);
}

const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
console.log('');
console.log(`  average  ${(sum((r) => r.steps) / rows.length).toFixed(1)} steps · ` +
            `${(sum((r) => r.stages.length) / rows.length).toFixed(1)} stages · ` +
            `${(sum((r) => r.concepts.length) / rows.length).toFixed(1)} ffmpeg concepts · ` +
            `${(sum((r) => r.hidden) / rows.length).toFixed(1)} hidden`);

// ── the audience test ──────────────────────────────────────────────────────

const byConcept = new Map();
for (const r of rows)
    for (const c of r.concepts) {
        if (!byConcept.has(c)) byConcept.set(c, []);
        byConcept.get(c).push(r.id);
    }
const ranked = Array.from(byConcept.entries()).sort((a, b) => b[1].length - a[1].length);

console.log('');
console.log(bar());
console.log('WHAT YOU HAVE TO ALREADY KNOW');
console.log(bar());
console.log('');
for (const [c, ids] of ranked)
    console.log(`  ${pad(ids.length + '/' + rows.length, 7)}${pad(c, 16)}${CONCEPTS[c] || ''}\n` +
                `  ${pad('', 7)}${pad('', 16)}(${ids.join(' ')})`);

const clean = rows.filter((r) => r.concepts.length === 0);
console.log('');
console.log(`  ${clean.length} of ${rows.length} jobs need no ffmpeg vocabulary at all: ` +
            `${clean.map((r) => r.id).join(' ') || 'none'}`);

// ── the work list ──────────────────────────────────────────────────────────

console.log('');
console.log(bar());
console.log('WHAT PEOPLE ASKED FOR AND DID NOT GET');
console.log(bar());
for (const r of rows) {
    if (!r.shortfalls || !r.shortfalls.length) continue;
    console.log('');
    console.log(`  ${r.id}  ${r.title}`);
    for (const s of r.shortfalls) console.log(`    · ${s.what}`);
}

const totalShort = sum((r) => (r.shortfalls || []).length);
console.log('');
console.log(`  ${totalShort} shortfalls across ${rows.length} journeys.`);
console.log('');

// Every journey that ran had its own outcome asserted in its own process; this
// only fails if one of them reported a failed outcome into the tally.
const broken = rows.filter((r) => r.outcome && !r.outcome.ok);
assert(broken.length === 0,
       `${broken.length} journey(s) did not produce what was asked for: ` +
       broken.map((r) => r.id).join(' '));
