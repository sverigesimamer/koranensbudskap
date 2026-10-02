// Lookup layer between Quran references (sura / verse) and pages.
// This is the single place the app asks "where is this verse?" and "what is
// on this page?" — navigation uses it now; audio, search hits and clickable
// verses hook in here later.
//
// Pages here are numbered through the PDF files (1 = first page of JUZ1).

import { SURAH_DATA } from '../data/quran-data.js';
import { VerseRegions } from './verse-regions.js';

/** Stable key for a verse, e.g. "2:255". Matches the verse keys QUL / Tarteel use. */
export const verseKey = (surah, ayah) => `${surah}:${ayah}`;

const surahs = SURAH_DATA.map(([name, ayahs, breaks], i) => ({ number: i + 1, name, ayahs, breaks }));

// What starts on each page: [{ surah, from, to }] in reading order.
const startsOnPage = new Map();
for (const s of surahs) {
  s.breaks.forEach(([ayah, page], i) => {
    const next = s.breaks[i + 1];
    if (!startsOnPage.has(page)) startsOnPage.set(page, []);
    startsOnPage.get(page).push({ surah: s.number, from: ayah, to: next ? next[0] - 1 : s.ayahs });
  });
}
const pagesWithStarts = [...startsOnPage.keys()].sort((a, b) => a - b);

export const QuranIndex = {
  /** @type {{number: number, name: string, ayahs: number}[]} */
  surahs,

  /** Page a verse starts on, or null if there is no such verse. */
  pageOfVerse(surah, ayah) {
    const s = surahs[surah - 1];
    if (!s || ayah < 1 || ayah > s.ayahs) return null;
    let page = null;
    for (const [first, p] of s.breaks) {
      if (first > ayah) break;
      page = p;
    }
    return page;
  },

  /** Verses that start on a page: [{ surah, from, to }]. */
  versesOnPage(pdfPage) {
    return startsOnPage.get(pdfPage) || [];
  },

  /** The sura a page belongs to (the first one on it), or null outside the text. */
  surahOnPage(pdfPage) {
    if (!pdfPage || pdfPage < pagesWithStarts[0]) return null;
    const here = startsOnPage.get(pdfPage);
    if (here) return here[0].surah;
    // No verse starts here: the page continues a long verse from before.
    for (let p = pdfPage - 1; p >= pagesWithStarts[0]; p--) {
      const earlier = startsOnPage.get(p);
      if (earlier) return earlier[earlier.length - 1].surah;
    }
    return null;
  },

  /** E.g. "Al-Baqarah 2:6–16". */
  pageLabel(pdfPage) {
    const parts = this.versesOnPage(pdfPage).map(({ surah, from, to }) =>
      `${surahs[surah - 1].name} ${surah}:${from}${to > from ? `–${to}` : ''}`);
    if (parts.length) return parts.join(', ');
    const surah = this.surahOnPage(pdfPage);
    return surah ? surahs[surah - 1].name : '';
  },

  /**
   * Where the verses lie on a page (empty until that juz's regions are loaded).
   * @returns {import('./verse-regions.js').VerseRegion[]}
   */
  regionsOnPage(pdfPage) {
    return VerseRegions.onPage(pdfPage);
  }
};
