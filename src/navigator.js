// "Navigera i Koranen": jump to a sura, a verse, a juz or a page.
//
// The panel only exists on screen while it is open — it is opened with its
// button and closed with ×, Esc, a click outside it, or by choosing something.
// It knows nothing about the book itself: it reports the choice through
// `onGo` with the page (numbered within the PDF files) to open.

/** Lower-case, without diacritics, apostrophes, hyphens or spaces — for matching what people type. */
const fold = (text) => String(text)
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '')
  // The book itself writes dj where this list has j (Al-Djumu'ah).
  .replace(/dj/g, 'j');

/**
 * @typedef {Object} NavigatorData
 * @property {{number: number, name: string, ayahs: number}[]} surahs
 * @property {{number: number, label: string, pdfPage: number}[]} juz
 * @property {number} pageCount                      printed pages (1..pageCount)
 * @property {(printedPage: number) => number} pdfPageOfPrinted
 * @property {(surah: number, ayah: number) => number|null} pdfPageOfVerse
 * @property {() => number|null} currentSurah        sura on the pages now showing
 */

export class QuranNavigator {
  /**
   * @param {Object} o
   * @param {HTMLElement} o.panel
   * @param {HTMLElement} o.button
   * @param {NavigatorData} o.data
   * @param {(target: {pdfPage: number, label: string}) => void} o.onGo
   */
  constructor({ panel, button, data, onGo }) {
    this.panel = panel;
    this.button = button;
    this.data = data;
    this.onGo = onGo;
    this.body = panel.querySelector('.nav-body');
    this.tabs = [...panel.querySelectorAll('.nav-tabs button')];
    this.tab = 'surah';
    this.verseSurah = 1;

    button.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    panel.querySelector('.nav-close').addEventListener('click', () => this.close());
    this.tabs.forEach((el) => el.addEventListener('click', () => this.show(el.dataset.tab)));

    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !panel.contains(e.target) && !button.contains(e.target)) this.close();
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
        button.focus();
      }
      // Typing in the panel must not turn pages.
      if (e.key !== 'Escape') e.stopPropagation();
    });
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  open() {
    this.panel.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.verseSurah = this.data.currentSurah() || this.verseSurah;
    this.show(this.tab);
  }

  close() {
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.body.replaceChildren();
  }

  #go(pdfPage, label) {
    if (!pdfPage) return;
    this.close();
    this.onGo({ pdfPage, label });
  }

  // ---- building blocks ----------------------------------------------------

  #search(placeholder, onInput) {
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'nav-search';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  /**
   * A scrolling list of choices.
   * @param {{key: string|number, text: string, hint?: string, active?: boolean, pick: () => void}[]} items
   */
  #list(items) {
    const list = document.createElement('div');
    list.className = 'nav-list';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'nav-empty';
      empty.textContent = 'Inga träffar';
      list.append(empty);
    }
    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'nav-item';
      if (item.active) row.classList.add('active');
      const key = document.createElement('span');
      key.className = 'nav-key';
      key.textContent = String(item.key);
      const text = document.createElement('span');
      text.className = 'nav-text';
      text.textContent = item.text;
      row.append(key, text);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'nav-hint';
        hint.textContent = item.hint;
        row.append(hint);
      }
      row.addEventListener('click', item.pick);
      list.append(row);
    }
    return list;
  }

  /** A search box above a list that is rebuilt as you type; Enter takes the first hit. */
  #searchable(placeholder, itemsFor) {
    const column = document.createElement('div');
    column.className = 'nav-column';
    let items = itemsFor('');
    let list = this.#list(items);
    const input = this.#search(placeholder, (value) => {
      items = itemsFor(value.trim());
      const next = this.#list(items);
      list.replaceWith(next);
      list = next;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && items.length) items[0].pick();
    });
    column.append(input, list);
    return { column, input, scrollToActive: () => list.querySelector('.active')?.scrollIntoView({ block: 'center' }) };
  }

  #surahsMatching(query) {
    const q = fold(query);
    if (!q) return this.data.surahs;
    return this.data.surahs.filter((s) => String(s.number).startsWith(q) || fold(s.name).includes(q));
  }

  // ---- tabs ---------------------------------------------------------------

  show(tab) {
    this.tab = tab;
    this.tabs.forEach((el) => {
      const on = el.dataset.tab === tab;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
    });
    this.body.replaceChildren();
    this.body.classList.toggle('two-columns', tab === 'verse');
    const first = this[`render_${tab}`]();
    first.focus({ preventScroll: true });
  }

  render_surah() {
    const current = this.data.currentSurah();
    const { column, input, scrollToActive } = this.#searchable('Sök sura (namn eller nummer)', (query) =>
      this.#surahsMatching(query).map((s) => ({
        key: s.number,
        text: s.name,
        hint: `${s.ayahs} verser`,
        active: s.number === current,
        pick: () => this.#go(this.data.pdfPageOfVerse(s.number, 1), `${s.number}. ${s.name}`)
      })));
    this.body.append(column);
    scrollToActive();
    return input;
  }

  render_verse() {
    const verses = document.createElement('div');
    verses.className = 'nav-column';

    const showVerses = () => {
      const surah = this.data.surahs[this.verseSurah - 1];
      const { column } = this.#searchable(`Vers 1–${surah.ayahs}`, (query) => {
        const q = query.replace(/\D/g, '');
        const items = [];
        for (let ayah = 1; ayah <= surah.ayahs; ayah++) {
          if (q && !String(ayah).startsWith(q)) continue;
          items.push({
            key: ayah,
            text: `${surah.number}:${ayah}`,
            pick: () => this.#go(this.data.pdfPageOfVerse(surah.number, ayah), `${surah.name} ${surah.number}:${ayah}`)
          });
        }
        return items;
      });
      verses.replaceChildren(...column.childNodes);
    };

    const surahs = this.#searchable('Sök sura, eller skriv t.ex. 2:255', (query) => {
      // "2:255" (or "2 255") goes straight to that verse.
      const direct = /^(\d{1,3})\s*[:\s.,]\s*(\d{1,3})$/.exec(query);
      if (direct) {
        const surah = this.data.surahs[Number(direct[1]) - 1];
        const ayah = Number(direct[2]);
        if (surah && ayah >= 1 && ayah <= surah.ayahs) {
          return [{
            key: `${surah.number}:${ayah}`,
            text: surah.name,
            pick: () => this.#go(this.data.pdfPageOfVerse(surah.number, ayah), `${surah.name} ${surah.number}:${ayah}`)
          }];
        }
        return [];
      }
      return this.#surahsMatching(query).map((s) => ({
        key: s.number,
        text: s.name,
        active: s.number === this.verseSurah,
        pick: () => {
          this.verseSurah = s.number;
          surahs.column.querySelectorAll('.nav-item').forEach((row, i, rows) => {
            row.classList.toggle('active', rows[i].querySelector('.nav-key').textContent === String(s.number));
          });
          showVerses();
          verses.querySelector('input').focus({ preventScroll: true });
        }
      }));
    });

    showVerses();
    this.body.append(surahs.column, verses);
    surahs.scrollToActive();
    return surahs.input;
  }

  render_juz() {
    const { column, input } = this.#searchable('Sök juz (1–30)', (query) => {
      const q = query.replace(/\D/g, '');
      return this.data.juz
        .filter((j) => !q || String(j.number).startsWith(q))
        .map((j) => ({ key: j.number, text: j.label, pick: () => this.#go(j.pdfPage, j.label) }));
    });
    this.body.append(column);
    return input;
  }

  render_page() {
    const { column, input } = this.#searchable(`Sök sida (1–${this.data.pageCount})`, (query) => {
      const q = query.replace(/\D/g, '');
      const items = [];
      for (let page = 1; page <= this.data.pageCount; page++) {
        if (q && !String(page).startsWith(q)) continue;
        items.push({
          key: page,
          text: `Sida ${page}`,
          pick: () => this.#go(this.data.pdfPageOfPrinted(page), `Sida ${page}`)
        });
      }
      // An exact page number first, so Enter goes where you typed.
      return q ? items.sort((a, b) => (String(a.key) === q ? -1 : String(b.key) === q ? 1 : 0)) : items;
    });
    this.body.append(column);
    return input;
  }
}
