// Reading zoom: the camera moves in on one page of the open book.
//
// Nothing is lifted out of the book — the whole book is scaled and panned so
// that the chosen page fills the stage width, and scrolling pans along it.
// The page is still the untouched PDF page: PDF.js renders it again at the
// larger size and that canvas takes the page's place while zoomed.
//
// The .zoom-view element is an invisible scroller lying over the stage. Its
// only content is a transparent stand-in with the size of the zoomed page;
// the book is moved to stay exactly under that stand-in, so native scrolling
// (wheel, touch, keyboard, scrollbar) drives the pan. The stand-in also holds
// the hotspot layer, so verses stay clickable while zoomed.

import { CONFIG } from './config.js';
import { renderHotspots } from './layers/interaction-layers.js';

const ANIMATION_MS = 460;

export class ZoomView {
  /**
   * @param {Object} o
   * @param {HTMLElement} o.el       the .zoom-view element
   * @param {HTMLElement} o.stageEl
   * @param {import('./pdf-source.js').PdfSource} o.source
   * @param {import('./book-view.js').BookView} o.view
   * @param {(open: boolean) => void} [o.onChange]
   */
  constructor({ el, stageEl, source, view, onChange }) {
    this.el = el;
    this.stageEl = stageEl;
    this.source = source;
    this.view = view;
    this.onChange = onChange || (() => {});
    this.scrollEl = el.querySelector('.zoom-scroll');
    this.pageEl = el.querySelector('.zoom-page');
    this.hotspots = this.pageEl.querySelector('.hotspot-layer');
    this.state = 'closed'; // closed | open | closing
    this.side = null;
    this.page = null;
    this.token = 0;
    this.timer = 0;

    this.scrollEl.addEventListener('scroll', () => {
      if (this.state === 'open') this.#follow();
    });
  }

  get isOpen() {
    return this.state !== 'closed';
  }

  /** Size the stand-in to the available width; returns the canvas size in device pixels. */
  #layout() {
    const { maxWidth, margin, maxPixels } = CONFIG.zoom;
    const cssW = Math.max(120, Math.min(this.scrollEl.clientWidth - margin * 2, maxWidth));
    const cssH = cssW / this.source.aspect;
    this.pageEl.style.width = `${cssW}px`;
    this.pageEl.style.height = `${cssH}px`;

    let dpr = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
    // Keep very large canvases within what browsers handle comfortably.
    dpr = Math.min(dpr, Math.sqrt(maxPixels / (cssW * cssH)));
    return { cssW, cssH, pixelW: Math.round(cssW * dpr), pixelH: Math.round(cssH * dpr) };
  }

  /** Scale and move the book so the zoomed page lies exactly under the stand-in. */
  #follow() {
    const { view } = this;
    const stage = this.stageEl.getBoundingClientRect();
    const target = this.pageEl.getBoundingClientRect();
    const scale = target.width / view.pageW;
    const pageX = this.side === 'left' ? 0 : view.pageW; // page's place inside the book
    const tx = target.left - stage.left - view.left - pageX * scale;
    const ty = target.top - stage.top - view.top;
    view.bookEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  /** Let the book glide (instead of jump) to its next transform. */
  #animate(done) {
    const book = this.view.bookEl;
    book.classList.add('zoom-anim');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      book.classList.remove('zoom-anim');
      if (done) done();
    }, ANIMATION_MS);
  }

  async #sharpen(size) {
    const token = ++this.token;
    const { page, side } = this;
    try {
      const canvas = await this.source.renderSized(page, size.pixelW, size.pixelH);
      if (token !== this.token || this.state !== 'open') return;
      if (this.view.slots[side].page !== page) return;
      this.view.setSlotCanvas(side, canvas);
    } catch (err) {
      console.error(err);
    }
  }

  /**
   * @param {'left'|'right'} side page of the current spread to zoom into
   * @param {number} focusY 0..1, the height on the page to centre on
   */
  open(side, focusY = 0) {
    const slot = this.view.slots[side];
    if (this.state !== 'closed' || !slot.page) return;
    this.side = side;
    this.page = slot.page;
    this.state = 'open';
    this.el.hidden = false;
    this.stageEl.classList.add('is-zoomed');

    const size = this.#layout();
    this.refreshLayers();
    this.scrollEl.scrollTop = Math.max(0, focusY * size.cssH - this.scrollEl.clientHeight / 2);

    this.#animate();
    this.#follow();
    this.el.classList.add('open');
    this.scrollEl.focus({ preventScroll: true });

    this.onChange(true);
    this.#sharpen(size);
  }

  close() {
    if (this.state !== 'open') return;
    this.state = 'closing';
    this.token++;
    this.el.classList.remove('open');
    this.view.bookEl.style.transform = '';
    this.#animate(() => {
      // Back to the canvas that matches the spread size 1:1.
      this.view.restoreSlot(this.side);
      this.state = 'closed';
      this.el.hidden = true;
      this.stageEl.classList.remove('is-zoomed');
      this.onChange(false);
    });
  }

  /** The window changed size (the spread has been laid out again): fit and re-render. */
  relayout() {
    if (this.state !== 'open') return;
    const size = this.#layout();
    this.#follow();
    this.#sharpen(size);
  }

  refreshLayers() {
    renderHotspots(this.hotspots, this.source.pdfPageOf(this.page), { debug: this.view.debugHotspots });
  }
}
