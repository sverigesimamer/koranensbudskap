// The layers that sit on top of a PDF canvas. They are ordinary DOM elements
// positioned with percentages, completely separate from the PDF rendering.
//
//   .hotspot-layer    invisible click targets (verses)
//   .highlight-layer  visible marks (playing verse, search hit)

import { QuranIndex, verseKey } from '../quran-index.js';

const pct = (v) => `${v * 100}%`;

/** @param {[number, number, number, number]} area x, y, width, height as fractions of the page */
function place(el, [x, y, w, h]) {
  el.style.left = pct(x);
  el.style.top = pct(y);
  el.style.width = pct(w);
  el.style.height = pct(h);
}

/**
 * Fill a page's hotspot layer: one invisible click target per area of each
 * verse (its Arabic lines and its translation). Clicking one dispatches a
 * bubbling `verse:activate` event with { surah, ayah, key, pdfPage }; main.js
 * starts the recitation there. Pointing at a verse shades all its areas
 * lightly, so it is clear what a click will choose.
 */
export function renderHotspots(layer, pdfPage, { debug = false } = {}) {
  layer.replaceChildren();
  layer.classList.toggle('debug', debug);
  if (!pdfPage) return;
  for (const region of QuranIndex.regionsOnPage(pdfPage)) {
    for (const area of region.areas) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hotspot';
      btn.dataset.verse = verseKey(region.surah, region.ayah);
      btn.setAttribute('aria-label', `Vers ${btn.dataset.verse}`);
      btn.tabIndex = -1;
      place(btn, area);
      const shade = (on) => {
        for (const el of layer.children) {
          if (el.dataset.verse === btn.dataset.verse) el.classList.toggle('hover', on);
        }
      };
      btn.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') shade(true); });
      btn.addEventListener('pointerleave', () => shade(false));
      btn.addEventListener('click', () => {
        layer.dispatchEvent(new CustomEvent('verse:activate', {
          bubbles: true,
          detail: {
            surah: region.surah,
            ayah: region.ayah,
            key: btn.dataset.verse,
            pdfPage
          }
        }));
      });
      layer.append(btn);
    }
  }
}

/**
 * Draw highlight marks for the given verse keys ("2:17") on a page.
 * @param {HTMLElement} layer
 * @param {number|null} pdfPage
 * @param {Set<string>} keys
 */
export function renderHighlights(layer, pdfPage, keys) {
  layer.replaceChildren();
  if (!pdfPage || !keys.size) return;
  for (const region of QuranIndex.regionsOnPage(pdfPage)) {
    if (!keys.has(verseKey(region.surah, region.ayah))) continue;
    for (const area of region.areas) {
      const mark = document.createElement('div');
      mark.className = 'highlight';
      place(mark, area);
      layer.append(mark);
    }
  }
}
