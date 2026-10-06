// The reciters the player can use.
//
// They come from the same place as the verse timings: the Quran.com audio
// API (api.qurancdn.com). It lists its reciters, and for each reciter and
// sura it gives the audio file together with the verse (and word) timings
// made for exactly that file — so every reciter works the same way and the
// verse marks follow whoever is reciting.
//
// The list is fetched once and kept in the browser; without a connection the
// last list kept is used, and failing that the default reciter alone.

/**
 * @typedef {Object} Reciter
 * @property {number} id            the API's recitation id (timings and files are asked for with it)
 * @property {number} [reciterId]   the person (one person can have several styles)
 * @property {string} name          as the API writes it, in English
 * @property {string} [arabicName]
 * @property {string} [style]       Murattal, Mujawwad, Muallim …
 * @property {string} [qirat]       Hafs …
 * @property {string} [surahUrl]    our own file address ({surah3}, {surah}); else the API's file is played
 */

const API = 'https://api.qurancdn.com/api/qdc/audio/reciters';
const STORE_KEY = 'kb-reciters-v1';

export const DEFAULT_RECITER_ID = 7;

/**
 * Mishary Rashid al-Afasy is played from the Tarteel CDN, as before (the
 * same recording as the API's, so its timings fit).
 */
const OWN_FILES = {
  7: 'https://audio-cdn.tarteel.ai/quran/surah/alafasy/murattal/mp3/{surah3}.mp3'
};

/**
 * Left out of the list, and why (checked against the API, Oct 2026):
 * 168  Minshawi "Kids repeat": every verse recited twice for learning by
 *      heart, and some of its verse timings are broken (sura 36).
 * 173  Mishary al-Afasy "streaming": the same recording as 7 again, in a
 *      streaming format without a file type.
 */
const LEFT_OUT = new Set([168, 173]);

/** Used when nothing can be fetched and nothing is kept. */
const FALLBACK = [{
  id: 7, reciterId: 6, name: 'Mishari Rashid al-`Afasy', arabicName: 'مشاري راشد العفاسي',
  style: 'Murattal', qirat: 'Hafs', surahUrl: OWN_FILES[7]
}];

const keep = (list) => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), list })); } catch { /* private mode */ } };
const kept = () => {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return data && Array.isArray(data.list) && data.list.length ? data.list : null;
  } catch {
    return null;
  }
};

/** Whatever is at hand right away: the kept list, or the default reciter. */
export function recitersAtHand() {
  return kept() || FALLBACK;
}

/** The API's list, made into Reciters (kept for next time). Falls back quietly. */
export async function fetchReciters() {
  try {
    const [en, ar] = await Promise.all(['en', 'ar'].map(async (locale) => {
      const response = await fetch(`${API}?locale=${locale}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()).reciters || [];
    }));
    const arabic = new Map(ar.map((r) => [r.id, r.translated_name?.name]));
    const list = en
      .filter((r) => !LEFT_OUT.has(r.id))
      .map((r) => ({
        id: r.id,
        reciterId: r.reciter_id,
        name: r.translated_name?.name || r.name,
        arabicName: arabic.get(r.id) || undefined,
        style: r.style?.name,
        qirat: r.qirat?.name,
        surahUrl: OWN_FILES[r.id]
      }))
      // By name; the styles of one reciter together, the usual one (Murattal) first.
      .sort((a, b) => a.name.localeCompare(b.name, 'en') || (a.style === 'Murattal' ? -1 : b.style === 'Murattal' ? 1 : (a.style || '').localeCompare(b.style || '')));
    if (!list.length) throw new Error('empty list');
    keep(list);
    return list;
  } catch (err) {
    console.warn('Reciter list not available', err);
    return recitersAtHand();
  }
}

/** "Murattal" is the usual style; anything else is worth saying. */
export const styleNote = (reciter) => (reciter.style && reciter.style !== 'Murattal' ? reciter.style : '');
