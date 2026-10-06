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
const fill = (template, surah, reciter) => template
  .replace('{surah3}', pad3(surah)).replace('{surah}', String(surah)).replace('{reciter}', String(reciter));

/**
 * @typedef {{ayah: number, from: number, to: number, words: number[][]}} VerseTiming  times in seconds
 * @typedef {{status: 'idle'|'loading'|'playing'|'paused'|'error', surah: number|null, ayah: number|null, stored: boolean,
 *   repeat: boolean, rate: number, reciter: import('./reciters.js').Reciter, error: 'missing'|'network'|null}} PlayerState
 */

/** The reciter has no recording (or no timings) for a sura. */
class MissingAudio extends Error {}

export class QuranPlayer {
  /**
   * @param {Object} o
   * @param {{timingsUrl: string, cacheName: string}} o.config
   * @param {import('./reciters.js').Reciter} o.reciter
   * @param {number} o.surahCount
   * @param {(surah: number, ayah: number) => void} o.onVerse  a new verse is being recited
   * @param {(state: PlayerState) => void} o.onState
   */
  constructor({ config, reciter, surahCount, onVerse, onState }) {
    this.config = config;
    this.reciter = reciter;
    this.error = null;
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
    /** Recite the current verse again and again instead of moving on. */
    this.repeat = false;
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
      if (!this.audio.src) return;
      this.error = 'network';
      this.#setStatus('error');
    });
    this.audio.addEventListener('timeupdate', () => this.#track());

    // Ask the browser not to evict the stored recitations when space runs low.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  get state() {
    return {
      status: this.status, surah: this.surah, ayah: this.ayah, stored: this.stored,
      repeat: this.repeat, rate: this.rate, reciter: this.reciter, error: this.error
    };
  }

  /** Where in the sura's recording we are, and how long it is (seconds; 0 when unknown). */
  get time() {
    return this.audio.src ? this.audio.currentTime || 0 : 0;
  }

  get duration() {
    const d = this.audio.duration;
    return this.audio.src && Number.isFinite(d) ? d : 0;
  }

  /** Playback speed (1 = as recited). */
  get rate() {
    return this.audio.playbackRate || 1;
  }

  setRate(rate) {
    this.audio.playbackRate = rate;
    this.audio.defaultPlaybackRate = rate;
    this.onState(this.state);
  }

  /**
   * Another reciter. The verse stays: if the recitation was going on it
   * goes on from the same verse in the new voice, else that verse is where
   * play starts. The old recording is stopped first, so two voices are
   * never heard together.
   * @param {import('./reciters.js').Reciter} reciter
   */
  setReciter(reciter) {
    if (!reciter || (this.reciter && reciter.id === this.reciter.id)) return;
    const wasPlaying = this.isPlaying;
    const { surah, ayah } = this;
    this.reciter = reciter;
    this.request++;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.timings = [];
    this.stored = false;
    this.error = null;
    if (surah && wasPlaying) {
      this.play(surah, ayah || 1);
    } else {
      this.#setStatus(surah ? 'paused' : 'idle');
    }
  }

  setRepeat(on) {
    this.repeat = !!on;
    this.onState(this.state);
  }

  /** Jump to a moment of the sura's recording; the verse follows. */
  async seekTo(seconds) {
    if (!this.surah || !this.audio.src) return;
    await this.#seek(Math.max(0, Math.min(seconds, this.duration || seconds)));
    this.#track(true);
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
    const url = fill(this.config.timingsUrl, surah, this.reciter.id);
    const store = await this.#store();
    let response = store ? await store.match(url) : null;
    if (!response) {
      response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (store) store.put(url, response.clone()).catch(() => {});
    }
    const data = await response.json();
    const file = data.audio_files && data.audio_files[0];
    if (!file || !file.audio_url || !(file.verse_timings || []).length) {
      throw new MissingAudio(`${this.reciter.name}: nothing for sura ${surah}`);
    }
    this.fileUrl = file.audio_url;
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
    const store = await this.#store();
    const timings = await this.#loadTimings(surah);
    // The reciter's file: our own address for it, or the one the API gives
    // with the timings (made for exactly that file).
    const url = this.reciter.surahUrl ? fill(this.reciter.surahUrl, surah, this.reciter.id) : this.fileUrl;
    const stored = store ? await store.match(url) : null;
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
    this.error = null;
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
      this.error = err instanceof MissingAudio ? 'missing' : 'network';
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
    if (!this.surah) return;
    // After a change of reciter there is nothing loaded yet.
    if (!this.audio.src) {
      this.play(this.surah, this.ayah || 1);
      return;
    }
    this.audio.play().catch(() => this.#setStatus('error'));
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
  #track(force = false) {
    if (!this.timings.length || (this.audio.paused && !force)) return;
    const t = this.audio.currentTime;
    // Repeating: past the end of the verse, back to its start.
    if (this.repeat && !force && this.ayah) {
      const timing = this.timings.find((v) => v.ayah === this.ayah);
      if (timing && t >= timing.to - 0.05) {
        this.audio.currentTime = timing.ayah === 1 ? 0 : timing.from;
        return;
      }
    }
    // Before the first verse's own start there is the basmala: count it to verse 1.
    let current = this.timings[0];
    for (const timing of this.timings) {
      if (timing.from <= t) current = timing; else break;
    }
    this.#announce(current.ayah);
  }

  #surahEnded() {
    if (this.repeat && this.surah && this.ayah) this.play(this.surah, this.ayah);
    else if (this.surah && this.surah < this.surahCount) this.play(this.surah + 1, 1);
    else this.#setStatus('paused');
  }
}
