// Builds data/swedish-audio/NNN.json: the Swedish reading of the translation,
// one recording per sura, with where every verse starts and ends in it.
//
// The recordings live in the Hidayah project's public Supabase Storage bucket
// `quran-audio-sv` (folder v1/). Their verified verse timestamps and the
// registry of file names and checksums live in the Hidayah repository; this
// tool copies what the player needs out of them:
//
//   services/swedishRecitation/swedishAudioRegistry.ts   file, bytes, sha256
//   data/quranSwedishAudio/NNN_Name_timestamps.json      verse start/end (s)
//
// Every file is checked before it is written: status "verified", the right
// sura, exactly as many verses as this book has (data/quran-data.js), in
// order, and no verse overlapping the next. One failure stops the build.
//
// Run:  node tools/build-swedish-audio.mjs [path to Hidayah]
//       (default ../Hidayah next to this project)
//
// After a recording is replaced in Hidayah (new sha256), run this again: the
// address carries the first 8 characters of the sha256, so browsers fetch the
// new recording instead of a stored copy of the old one.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURAH_DATA } from '../data/quran-data.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HIDAYAH = resolve(process.argv[2] || join(ROOT, '..', 'Hidayah'));
const BASE = 'https://yqtnwgezqbznbpeooott.supabase.co/storage/v1/object/public/quran-audio-sv';
const OUT = join(ROOT, 'data', 'swedish-audio');

const registry = readFileSync(join(HIDAYAH, 'services/swedishRecitation/swedishAudioRegistry.ts'), 'utf8');
const ENTRY = /^\s*(\d+):\s*\{\s*enabled:\s*(true|false),\s*audio:\s*\{\s*file:\s*'([^']+)',\s*version:\s*(\d+),\s*bytes:\s*(\d+),\s*sha256:\s*'([0-9a-f]{64})'/gm;
const entries = new Map();
for (const m of registry.matchAll(ENTRY)) {
  const [, surah, enabled, file, version, bytes, sha256] = m;
  if (enabled === 'true') entries.set(Number(surah), { file, version: Number(version), bytes: Number(bytes), sha256 });
}

const stampDir = join(HIDAYAH, 'data/quranSwedishAudio');
const stampFiles = new Map(readdirSync(stampDir)
  .filter((f) => /^\d{3}_.*_timestamps\.json$/.test(f))
  .map((f) => [Number(f.slice(0, 3)), f]));

const fail = (msg) => { console.error(`build-swedish-audio: ${msg}`); process.exit(1); };
const round = (s) => Math.round(s * 1000) / 1000;

mkdirSync(OUT, { recursive: true });
let verses = 0;
SURAH_DATA.forEach(([name, ayahs], i) => {
  const surah = i + 1;
  const entry = entries.get(surah);
  if (!entry) fail(`sura ${surah} (${name}) has no enabled recording in the registry`);
  const stampFile = stampFiles.get(surah);
  if (!stampFile) fail(`sura ${surah} (${name}) has no timestamp file`);
  const t = JSON.parse(readFileSync(join(stampDir, stampFile), 'utf8'));
  if (t.status !== 'verified') fail(`${stampFile}: status is ${t.status}, not verified`);
  if (t.surah !== surah) fail(`${stampFile}: is for sura ${t.surah}`);
  if (t.audio !== entry.file) fail(`${stampFile}: is for ${t.audio}, the registry has ${entry.file}`);
  if (!Array.isArray(t.verses) || t.verses.length !== ayahs) fail(`${stampFile}: ${t.verses?.length} verses, the book has ${ayahs}`);
  let previousEnd = 0;
  const out = t.verses.map((v, k) => {
    if (v.ayah !== k + 1 || v.key !== `${surah}:${k + 1}`) fail(`${stampFile}: verse ${k + 1} is ${v.key}`);
    if (!(v.start >= previousEnd && v.end > v.start && v.end <= t.duration + 0.05)) fail(`${stampFile}: ${v.key} has bad times`);
    previousEnd = v.end;
    return [round(v.start), round(v.end)];
  });
  const data = {
    surah,
    audio: `${BASE}/v${entry.version}/${entry.file}?v=${entry.sha256.slice(0, 8)}`,
    bytes: entry.bytes,
    duration: round(t.duration),
    // Before verse 1: the basmala (suras 2–8, 10–114), read as part of verse 1.
    ...(t.bismillah ? { basmala: [round(t.bismillah.start), round(t.bismillah.end)] } : {}),
    // [start, end] in seconds; verse n is at index n - 1.
    verses: out
  };
  writeFileSync(join(OUT, `${String(surah).padStart(3, '0')}.json`), JSON.stringify(data) + '\n');
  verses += out.length;
});
console.log(`data/swedish-audio: ${SURAH_DATA.length} suras, ${verses} verses`);
