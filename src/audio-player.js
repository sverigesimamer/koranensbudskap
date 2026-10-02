// Recitation playback, one audio file per sura.
//
// Nothing is bundled with the app. The first time a sura is played its file
// is streamed straight from the CDN, and at the same time a copy is fetched
// into the browser's own storage (Cache Storage); from then on the sura is
// played from that copy. The verse timings (where each verse — and each
// word — starts and ends in the file) are fetched and stored the same way.
//
// The player knows nothing about pages. It reports which verse is being
// recited through `onVerse`, and its state through `onState`.

const pad3 = (n) => String(n).padStart(3, '0');
const fill = (template, surah) => template.replace('{surah3}', pad3(surah)).replace('{surah}', String(surah));

/**
 * @typedef {{ayah: number, from: number, to: number, words: number[][]}} VerseTiming  times in seconds
 * @typedef {{status: 'idle'|'loading'|'playing'|'paused'|'error', surah: number|null, ayah: number|null, stored: boolean}} PlayerState
 */

export class QuranPlayer {
  /**
   * @param {Object} o
   * @param {{surahUrl: string, timingsUrl: string, cacheName: string}} o.config
   * @param {number} o.surahCount
   * @param {(surah: number, ayah: number) => void} o.onVerse  a new verse is being recited
   * @param {(state: PlayerState) => void} o.onState
   */
  constructor({ config, surahCount, onVerse, onState }) {
    this.config = config;
    this.surahCount = surahCount;
    this.onVerse = onVerse;
    this.onState = onState;

    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.surah = null;
    this.ayah = null;
    /** @type {VerseTiming[]} */
    this.timings = [];
    this.status = 'idle';
    this.stored = false;
    this.objectUrl = null;
    this.request = 0;
    this.ticker = 0;
    /** @type {Map<string, Promise<void>>} downloads into the browser's storage in progress */
    this.storing = new Map();

    this.audio.addEventListener('playing', () => this.#setStatus('playing'));
    this.audio.addEventListener('pause', () => {
      if (this.status === 'playing') this.#setStatus('paused');
    });
    this.audio.addEventListener('waiting', () => {
      if (this.status === 'playing') this.#setStatus('loading');
    });
    this.audio.addEventListener('ended', () => this.#surahEnded());
    this.audio.addEventListener('error', () => {
      if (this.audio.src) this.#setStatus('error');
    });
    this.audio.addEventListener('timeupdate', () => this.#track());

    // Ask the browser not to evict the stored recitations when space runs low.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  get state() {
    return { status: this.status, surah: this.surah, ayah: this.ayah, stored: this.stored };
  }

  #setStatus(status) {
    this.status = status;
    clearInterval(this.ticker);
    // timeupdate only fires a few times a second; follow the verses more closely.
    if (status === 'playing') this.ticker = setInterval(() => this.#track(), 80);
    this.onState(this.state);
  }

  // ---- storage ------------------------------------------------------------

  /** The browser's store for the recitations, or null where there is none (non-secure pages). */
  async #store() {
    if (!('caches' in window)) return null;
    try {
      return await caches.open(this.config.cacheName);
    } catch {
      return null;
    }
  }

  /** Fetch a file into the browser's storage, once. */
  #storeCopy(url) {
    if (!this.storing.has(url)) {
      const job = (async () => {
        const store = await this.#store();
        if (!store || await store.match(url)) return;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await store.put(url, response);
      })().catch((err) => console.warn('Could not store', url, err)).finally(() => this.storing.delete(url));
      this.storing.set(url, job);
    }
    return this.storing.get(url);
  }

  /** @returns {Promise<VerseTiming[]>} */
  async #loadTimings(surah) {
    const url = fill(this.config.timingsUrl, surah);
    const store = await this.#store();
    let response = store ? await store.match(url) : null;
    if (!response) {
      response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (store) store.put(url, response.clone()).catch(() => {});
    }
    const data = await response.json();
    const file = data.audio_files && data.audio_files[0];
    if (!file) throw new Error('No timings for sura ' + surah);
    return file.verse_timings.map((t) => ({
      ayah: Number(t.verse_key.split(':')[1]),
      from: t.timestamp_from / 1000,
      to: t.timestamp_to / 1000,
      // [word, start, end] in seconds — kept for word-by-word highlighting later.
      words: (t.segments || []).filter((s) => s.length === 3).map(([w, a, b]) => [w, a / 1000, b / 1000])
    }));
  }

  /** Point the audio element at a sura: the stored copy if there is one, else the CDN. */
  async #loadSurah(surah) {
    const request = ++this.request;
    this.#setStatus('loading');
    this.audio.pause();
    const url = fill(this.config.surahUrl, surah);
    const store = await this.#store();
    const [timings, stored] = await Promise.all([
      this.#loadTimings(surah),
      store ? store.match(url) : null
    ]);
    if (request !== this.request) return false;

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    if (stored) {
      this.objectUrl = URL.createObjectURL(await stored.blob());
      if (request !== this.request) return false;
      this.audio.src = this.objectUrl;
    } else {
      // Play from the CDN now; keep a copy for next time.
      this.audio.src = url;
      this.#storeCopy(url).then(() => {
        if (this.surah === surah) {
          this.stored = true;
          this.onState(this.state);
        }
      });
    }
    this.stored = !!stored;
    this.surah = surah;
    this.timings = timings;
    return true;
  }

  // ---- playback -----------------------------------------------------------

  /** Recite from this verse on. */
  async play(surah, ayah = 1) {
    try {
      if (this.surah !== surah || !this.audio.src) {
        this.ayah = ayah;
        this.surah = surah;
        this.onState({ ...this.state, status: 'loading' });
        if (!await this.#loadSurah(surah)) return;
      }
      const timing = this.timings.find((t) => t.ayah === ayah) || this.timings[0];
      // The first verse starts at the very beginning of the file, with the basmala.
      const start = timing.ayah === 1 ? 0 : timing.from;
      this.#announce(timing.ayah);
      await this.#seek(start);
      await this.audio.play();
    } catch (err) {
      if (err && err.name === 'AbortError') return; // superseded by another play()
      console.error(err);
      this.#setStatus('error');
    }
  }

  #seek(seconds) {
    const audio = this.audio;
    if (audio.readyState >= 1) {
      audio.currentTime = seconds;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      audio.addEventListener('loadedmetadata', () => {
        audio.currentTime = seconds;
        resolve();
      }, { once: true });
    });
  }

  pause() {
    this.audio.pause();
  }

  resume() {
    if (this.surah && this.audio.src) this.audio.play().catch(() => this.#setStatus('error'));
  }

  get isPlaying() {
    return this.status === 'playing' || this.status === 'loading';
  }

  /** Step to the next / previous verse (across sura boundaries). */
  step(delta) {
    if (!this.surah) return;
    const index = this.timings.findIndex((t) => t.ayah === this.ayah) + delta;
    if (index >= 0 && index < this.timings.length) {
      this.play(this.surah, this.timings[index].ayah);
    } else if (index < 0 && this.surah > 1) {
      this.play(this.surah - 1, 1);
    } else if (index >= this.timings.length && this.surah < this.surahCount) {
      this.play(this.surah + 1, 1);
    }
  }

  stop() {
    this.request++;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.surah = null;
    this.ayah = null;
    this.#setStatus('idle');
  }

  #announce(ayah) {
    if (this.ayah === ayah && this.announced === `${this.surah}:${ayah}`) return;
    this.ayah = ayah;
    this.announced = `${this.surah}:${ayah}`;
    this.onVerse(this.surah, ayah);
    this.onState(this.state);
  }

  /** Which verse is being recited right now? */
  #track() {
    if (!this.timings.length || this.audio.paused) return;
    const t = this.audio.currentTime;
    // Before the first verse's own start there is the basmala: count it to verse 1.
    let current = this.timings[0];
    for (const timing of this.timings) {
      if (timing.from <= t) current = timing; else break;
    }
    this.#announce(current.ayah);
  }

  #surahEnded() {
    if (this.surah && this.surah < this.surahCount) this.play(this.surah + 1, 1);
    else this.#setStatus('paused');
  }
}
