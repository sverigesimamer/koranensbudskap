// Loads the original PDF with PDF.js and renders pages to canvases on demand.
// The PDF is only ever read; every canvas is a straight PDF.js rendering of
// one full, uncropped page.

import { CONFIG } from './config.js';
import { hidePrinterMarks } from './printer-marks.js';

// PDF.js paces page rendering with requestAnimationFrame, which does not
// fire while the page is not being painted (background tab, covered window) —
// pages would stay half rendered until the user comes back. So every frame
// request gets a fallback that runs the callback if no frame comes: at once
// through a message channel in a hidden tab (timers are throttled there),
// otherwise after a short timeout.
{
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const FALLBACK_MS = 80;
  /** @type {Map<number, {callback: FrameRequestCallback, native: number, timer: number}>} */
  const pending = new Map();
  const channel = new MessageChannel();
  let nextId = 0;

  const take = (id) => {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    nativeCancel(entry.native);
    clearTimeout(entry.timer);
    return entry;
  };
  const run = (id) => {
    const entry = take(id);
    if (entry) entry.callback(performance.now());
  };
  channel.port1.onmessage = (e) => run(e.data);

  window.requestAnimationFrame = (callback) => {
    const id = ++nextId;
    const entry = { callback, native: nativeRequest(() => run(id)), timer: 0 };
    pending.set(id, entry);
    if (document.hidden) channel.port2.postMessage(id);
    else entry.timer = setTimeout(() => run(id), FALLBACK_MS);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    take(id);
  };
}

/**
 * @typedef {Object} Volume
 * @property {string} url    PDF file
 * @property {string} label  shown in the UI, e.g. "Juz 7"
 * @property {number} [pages] page count; if left out the file is opened at
 *   start-up to find out (slower with many files)
 */

/**
 * The book's pages, read from one or more PDF files that follow on from each
 * other. Pages are numbered through the whole book (1 = first page of the
 * first file). A file is only opened when one of its pages is needed, and
 * only the parts of it that those pages use are fetched.
 */
export class PdfSource {
  constructor() {
    this.pdfjs = null;
    /** @type {{url: string, label: string, pages: number, first: number, doc: Promise<any>|null, busy: number, used: number}[]} */
    this.volumes = [];
    this.pageCount = 0;
    /** Width / height of a page. */
    this.aspect = 0.7;
    /** @type {Map<number, {token: number, promise: Promise<HTMLCanvasElement>, canvas: HTMLCanvasElement|null}>} */
    this.cache = new Map();
    this.pixelW = 0;
    this.pixelH = 0;
    this.token = 0;
    this.clock = 0;
    // Render scheduling (see render()).
    this.backlog = [];
    this.backgroundRunning = null;
    this.urgent = 0;
    this.held = false;
  }

  /** @param {Volume[]} volumes */
  async load(volumes) {
    this.pdfjs = await import(CONFIG.pdfjs.lib);
    this.pdfjs.GlobalWorkerOptions.workerSrc = CONFIG.pdfjs.worker;
    this.volumes = volumes.map((v) => ({ ...v, first: 0, doc: null, busy: 0, used: 0 }));

    for (const volume of this.volumes) {
      if (!volume.pages) volume.pages = (await this.#open(volume)).numPages;
    }
    let first = 1;
    for (const volume of this.volumes) {
      volume.first = first;
      first += volume.pages;
    }
    /** Pages that come from the PDF files. */
    this.pdfPageCount = first - 1;
    // A hard cover adds two pages at each end of the book: the outside of
    // the board (the cover image) and its inside.
    this.cover = CONFIG.cover || null;
    this.frontPages = this.cover ? 2 : 0;
    this.pageCount = this.pdfPageCount + this.frontPages * 2;
    if (this.cover) {
      this.coverImages = {
        front: this.#loadImage(this.cover.front.image),
        back: this.#loadImage(this.cover.back.image)
      };
    }

    const page = await (await this.#open(this.volumes[0])).getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    this.aspect = viewport.width / viewport.height;
  }

  #loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        console.error(`Cover image not found: ${url}`);
        resolve(null);
      };
      img.src = url;
    });
  }

  /** Number of this book page within the PDF files, or null for the cover boards. */
  pdfPageOf(pageNumber) {
    const n = pageNumber - this.frontPages;
    return n >= 1 && n <= this.pdfPageCount ? n : null;
  }

  /** Book page that shows the given page of the PDF files. */
  bookPageOf(pdfPage) {
    return pdfPage + this.frontPages;
  }

  /** 'front' | 'back' for the outside of a cover board, 'inside' for its inside, else null. */
  boardFace(pageNumber) {
    if (!this.cover || this.pdfPageOf(pageNumber)) return null;
    if (pageNumber === 1) return 'front';
    if (pageNumber === this.pageCount) return 'back';
    return 'inside';
  }

  /** Which file a page of the book is in (null for the cover boards). */
  locate(bookPage) {
    const pageNumber = this.pdfPageOf(bookPage);
    if (!pageNumber) return null;
    const index = this.volumes.findIndex((v) => pageNumber >= v.first && pageNumber < v.first + v.pages);
    if (index < 0) return null;
    const volume = this.volumes[index];
    return { volume, index, localPage: pageNumber - volume.first + 1 };
  }

  #open(volume) {
    volume.used = ++this.clock;
    if (!volume.doc) {
      volume.doc = this.pdfjs.getDocument({
        url: volume.url,
        // Fetch only the byte ranges the requested pages need, not the
        // whole (large) file.
        disableAutoFetch: true,
        disableStream: true
      }).promise;
      volume.doc.catch(() => { volume.doc = null; });
      this.#closeIdle();
    }
    return volume.doc;
  }

  /** Keep only the most recently used files open. */
  #closeIdle() {
    const open = this.volumes.filter((v) => v.doc).sort((a, b) => b.used - a.used);
    for (const volume of open.slice(CONFIG.render.openVolumes)) {
      if (volume.busy > 0) continue;
      const doc = volume.doc;
      volume.doc = null;
      doc.then((d) => d.destroy()).catch(() => {});
    }
  }

  /** Set the canvas size (device pixels). Drops renderings of another size. */
  setTargetSize(pixelW, pixelH) {
    if (pixelW === this.pixelW && pixelH === this.pixelH) return;
    this.pixelW = pixelW;
    this.pixelH = pixelH;
    this.token++;
    this.cache.clear();
    this.backlog.length = 0;
  }

  /** Canvas for a page if it has already been rendered at the current size. */
  peek(pageNumber) {
    const entry = this.cache.get(pageNumber);
    return entry && entry.token === this.token ? entry.canvas : null;
  }

  /**
   * Render a page at the current size (cached).
   *
   * Pages asked for in the `background` (preloading the neighbouring spreads)
   * wait in a queue and are rendered one at a time, and only while nothing
   * else is being rendered. A page that is needed now — the spread to show,
   * the target of a jump — is rendered at once; a background rendering in
   * progress is put aside for it and started again afterwards.
   *
   * @param {number} pageNumber
   * @param {{background?: boolean}} [options]
   * @returns {Promise<HTMLCanvasElement>}
   */
  render(pageNumber, { background = false } = {}) {
    let entry = this.cache.get(pageNumber);
    if (entry && entry.token === this.token) {
      // Waiting in the background queue, but needed now.
      if (!background && entry.state === 'queued') this.#start(entry);
      else if (!background && entry.state === 'running' && entry.background) this.#promote(entry);
      return entry.promise;
    }

    entry = { page: pageNumber, token: this.token, canvas: null, state: 'queued', background, cancelled: false, task: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.promise.catch(() => {
      if (this.cache.get(pageNumber) === entry) this.cache.delete(pageNumber);
    });
    this.cache.set(pageNumber, entry);
    if (background) {
      this.backlog.push(entry);
      this.#pump();
    } else {
      this.#start(entry);
    }
    return entry.promise;
  }

  /** A background rendering turned out to be needed now: let it finish undisturbed. */
  #promote(entry) {
    entry.background = false;
    this.urgent++;
    if (this.backgroundRunning === entry) this.backgroundRunning = null;
  }

  #start(entry, asBackground = false) {
    const queued = this.backlog.indexOf(entry);
    if (queued >= 0) this.backlog.splice(queued, 1);
    entry.background = asBackground;
    entry.state = 'running';
    entry.cancelled = false;

    if (asBackground) {
      this.backgroundRunning = entry;
    } else {
      this.urgent++;
      // Put the background rendering aside; it goes back to the head of the queue.
      const running = this.backgroundRunning;
      if (running) {
        running.cancelled = true;
        if (running.task) running.task.cancel();
      }
    }

    this.#render(entry.page, this.pixelW, this.pixelH, entry).then((canvas) => {
      entry.canvas = canvas;
      entry.state = 'done';
      entry.resolve(canvas);
    }, (err) => {
      if (entry.cancelled && entry.background && this.cache.get(entry.page) === entry) {
        // Set aside for something more urgent — try again later.
        entry.state = 'queued';
        entry.task = null;
        this.backlog.unshift(entry);
      } else {
        entry.state = 'failed';
        entry.reject(err);
      }
    }).finally(() => {
      if (this.backgroundRunning === entry) this.backgroundRunning = null;
      if (!entry.background) this.urgent--;
      this.#pump();
    });
  }

  /**
   * Hold back background rendering (while a page is turning, so the
   * animation gets the processor), or let it go on again.
   */
  hold(on) {
    if (this.held === on) return;
    this.held = on;
    if (on) {
      const running = this.backgroundRunning;
      if (running) {
        running.cancelled = true;
        if (running.task) running.task.cancel();
      }
    } else {
      this.#pump();
    }
  }

  /** Start the next background rendering if nothing else is going on. */
  #pump() {
    if (this.held || this.urgent > 0 || this.backgroundRunning) return;
    while (this.backlog.length) {
      const entry = this.backlog.shift();
      // Pruned or outdated in the meantime: nobody is waiting for it.
      if (this.cache.get(entry.page) !== entry || entry.token !== this.token) continue;
      this.#start(entry, true);
      return;
    }
  }

  /**
   * One-off rendering at an explicit size (reading zoom). Not cached.
   * @returns {Promise<HTMLCanvasElement>}
   */
  renderSized(pageNumber, pixelW, pixelH) {
    return this.#render(pageNumber, pixelW, pixelH);
  }

  /** A face of the cover board: the cover image, or the plain inside. */
  async #renderBoard(face, pageNumber, pixelW, pixelH) {
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = pixelW;
    canvas.height = pixelH;
    canvas.dataset.bookPage = String(pageNumber);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = this.cover.inside;
    ctx.fillRect(0, 0, pixelW, pixelH);
    if (face === 'inside') return canvas;

    const img = await this.coverImages[face];
    if (img) {
      // The part of the image that is the cover itself, fitted to the board.
      const spec = this.cover[face];
      const [sx, sy, sw, sh] = spec.crop || [0, 0, img.naturalWidth, img.naturalHeight];
      const kx = pixelW / sw;
      const ky = pixelH / sh;
      ctx.imageSmoothingQuality = 'high';
      ctx.save();
      if (spec.mirror) {
        ctx.translate(pixelW, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, pixelW, pixelH);
      ctx.restore();
      // Parts with text are drawn the right way round again, in the place
      // the mirroring moved them to.
      for (const { cx, cy, r } of spec.mirror ? spec.upright || [] : []) {
        const x = pixelW - (cx - sx) * kx;
        const y = (cy - sy) * ky;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(x, y, r * kx, r * ky, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2, x - r * kx, y - r * ky, r * 2 * kx, r * 2 * ky);
        ctx.restore();
      }
    }
    return canvas;
  }

  /**
   * @param {object} [job] cache entry this rendering belongs to; lets the
   *   scheduler cancel it (job.cancelled / job.task)
   */
  async #render(pageNumber, pixelW = this.pixelW, pixelH = this.pixelH, job = null) {
    const face = this.boardFace(pageNumber);
    if (face) return this.#renderBoard(face, pageNumber, pixelW, pixelH);
    const where = this.locate(pageNumber);
    if (!where) throw new Error(`No page ${pageNumber}`);
    where.volume.busy++;
    try {
      return await this.#renderFrom(where, pageNumber, pixelW, pixelH, job);
    } finally {
      where.volume.busy--;
    }
  }

  async #renderFrom({ volume, localPage }, pageNumber, pixelW, pixelH, job) {
    const page = await (await this.#open(volume)).getPage(localPage);
    if (job && job.cancelled) throw new Error('rendering set aside');
    const base = page.getViewport({ scale: 1 });
    // Whole page, uniformly scaled; centred if its proportions differ slightly.
    const scale = Math.min(pixelW / base.width, pixelH / base.height);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = pixelW;
    canvas.height = pixelH;
    canvas.dataset.pdfPage = String(pageNumber);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pixelW, pixelH);

    const dx = (pixelW - viewport.width) / 2;
    const dy = (pixelH - viewport.height) / 2;

    // Optionally leave out the printer's crop marks (see printer-marks.js).
    const pdfPage = this.pdfPageOf(pageNumber);
    const marks = CONFIG.printerMarks;
    if (marks && (marks.pages === 'all' || marks.pages.includes(pdfPage))) {
      const inset = marks.trimMargin * scale;
      const stats = hidePrinterMarks(ctx, {
        left: dx + inset,
        top: dy + inset,
        right: dx + viewport.width - inset,
        bottom: dy + viewport.height - inset
      }, scale);
      canvas.marksHidden = stats;
    }

    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dx || dy ? [1, 0, 0, 1, dx, dy] : undefined
    });
    if (job) job.task = task;
    await task.promise;
    return canvas;
  }

  /** Free renderings that are not in `keep`. */
  prune(keep) {
    const wanted = new Set(keep);
    for (const [page, entry] of this.cache) {
      if (entry.token !== this.token || !wanted.has(page)) this.cache.delete(page);
    }
  }
}
