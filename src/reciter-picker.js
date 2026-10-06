// "Välj recitatör": a sheet (small screens) or a panel above the player
// (desktop) listing the reciters, with a search field. It only reports the
// choice; the player itself changes voice (QuranPlayer.setReciter).

import { styleNote } from './reciters.js';

const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '');
const CHECK = '<svg class="icon reciter-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4.2 4.2 8.8-9.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class ReciterPicker {
  /**
   * @param {Object} o
   * @param {HTMLElement} o.el     the #reciterSheet element
   * @param {(reciter: import('./reciters.js').Reciter) => void} o.onPick
   */
  constructor({ el, onPick }) {
    this.el = el;
    this.onPick = onPick;
    this.list = el.querySelector('.reciter-list');
    this.search = el.querySelector('.reciter-search');
    this.reciters = [];
    this.current = null;
    el.querySelector('.reciter-close').addEventListener('click', () => this.close());
    this.search.addEventListener('input', () => this.#render());
    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing here must not turn pages
      if (e.key === 'Escape') this.close();
      if (e.key === 'Enter' && e.target === this.search) this.list.querySelector('.reciter-item')?.click();
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !el.contains(e.target) && !e.target.closest('[data-opens-reciters]')) this.close();
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /**
   * @param {import('./reciters.js').Reciter[]} reciters
   * @param {number} currentId
   */
  open(reciters, currentId) {
    this.reciters = reciters;
    this.current = currentId;
    this.search.value = '';
    // A short list needs no search field.
    this.search.hidden = reciters.length < 9;
    this.el.hidden = false;
    this.#render();
    this.list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    (this.search.hidden ? this.list.querySelector('[aria-selected="true"]') : this.search)?.focus({ preventScroll: true });
  }

  close() {
    this.el.hidden = true;
  }

  #render() {
    const q = fold(this.search.value);
    const shown = this.reciters.filter((r) => !q || [r.name, r.arabicName, r.style].some((t) => fold(t).includes(q)));
    this.list.replaceChildren(...shown.map((r) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'reciter-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(r.id === this.current));
      row.innerHTML = `${CHECK}<span class="reciter-name"></span><span class="reciter-style"></span><span class="reciter-ar" dir="rtl" lang="ar"></span>`;
      row.querySelector('.reciter-name').textContent = r.name;
      row.querySelector('.reciter-style').textContent = styleNote(r);
      row.querySelector('.reciter-ar').textContent = r.arabicName || '';
      row.addEventListener('click', () => {
        this.close();
        if (r.id !== this.current) this.onPick(r);
      });
      return row;
    }));
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'nav-empty';
      empty.textContent = 'Ingen recitatör hittades';
      this.list.append(empty);
    }
  }
}
