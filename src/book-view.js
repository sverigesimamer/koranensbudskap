// The resting book: two DOM pages, each holding the PDF.js canvas for one page
// plus the interaction layers. The turning sheet is drawn elsewhere
// (flip/flip-renderer.js); this class only swaps which page lies where.

import { CONFIG } from './config.js';
import { renderHotspots, renderHighlights } from './layers/interaction-layers.js';
import { VerseRegions } from './verse-regions.js';

function shadeGradient(stops, rgb, towards) {
  const parts = stops.map(([x, a]) => `rgba(${rgb},${a}) ${(x * 100).toFixed(2)}%`);
  return `linear-gradient(${towards}, ${parts.join(', ')})`;
}

export class BookView {
  /**
   * @param {HTMLElement} bookEl
   * @param {HTMLElement} stageEl
   * @param {import('./pdf-source.js').PdfSource} source
   * @param {import('./book-model.js').BookModel} model
   */
  constructor(bookEl, stageEl, source, model) {
    this.bookEl = bookEl;
    this.stageEl = stageEl;
    this.source = source;
    this.model = model;
    this.index = 0;
    this.showRequest = 0;
    /** One page at a time (narrow upright screens) instead of the spread. */
    this.single = false;
    /** In one-page mode: the page of the spread that is in view. */
    this.focus = 'right';
    /** Spread whose pages are kept rendered while the book jumps to it. */
    this.pinnedSpread = null;
    this.debugHotspots = false;
    /** Verse keys ("2:17") currently highlighted. */
    this.highlighted = new Set();
    /** Called when the verse areas of a shown page have been loaded. */
    this.onRegions = () => {};

    this.slots = {
      left: this.#slot(bookEl.querySelector('.page-left'), 'to left'),
      right: this.#slot(bookEl.querySelector('.page-right'), 'to right')
    };
    this.pageW = 0;
    this.pageH = 0;
  }

  #slot(el, towards) {
    const { dark, light } = CONFIG.pageShade;
    // Dark layer on top of the light layer — the WebGL sheet applies them in
    // the same order.
    el.querySelector('.page-shade').style.background = [
      shadeGradient(dark, '0,0,0', towards),
      shadeGradient(light, '255,255,255', towards)
    ].join(', ');
    return {
      el,
      page: null,
      hotspots: el.querySelector('.hotspot-layer'),
      highlights: el.querySelector('.highlight-layer')
    };
  }

  /** Size the book to the stage and tell the PDF source how big to render. */
  layout() {
    const stage = this.stageEl.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
    const { maxWidth, maxHeight } = CONFIG.layout;
    const aspect = this.source.aspect;

    // On a narrow upright screen one page fills the stage; the book is then
    // moved sideways to bring the other page of the spread into view.
    this.single = window.innerWidth < CONFIG.layout.singlePageBelow && window.innerHeight > window.innerWidth;
    this.bookEl.classList.toggle('single', this.single);
    const across = this.single ? 1 : 2;

    let pageH = stage.height * maxHeight;
    let pageW = pageH * aspect;
    if (pageW * across > stage.width * maxWidth) {
      pageW = (stage.width * maxWidth) / across;
      pageH = pageW / aspect;
    }
    // Snap to whole device pixels so the canvases are shown 1:1.
    const pixelW = Math.max(1, Math.round(pageW * dpr));
    const pixelH = Math.max(1, Math.round(pageH * dpr));
    this.pageW = pixelW / dpr;
    this.pageH = pixelH / dpr;
    this.dpr = dpr;

    const snap = (v) => Math.round(v * dpr) / dpr;
    const style = this.bookEl.style;
    style.setProperty('--page-w', `${this.pageW}px`);
    style.setProperty('--page-h', `${this.pageH}px`);
    /** Position of the book inside the stage (CSS px, unzoomed). */
    this.left = snap((stage.width - this.pageW * 2) / 2);
    this.top = snap((stage.height - this.pageH) / 2);
    style.left = `${this.left}px`;
    style.top = `${this.top}px`;

    // The hard cover: a board a little larger than the pages (same
    // proportions, growing out from the spine) and clearly thicker.
    const overhang = snap(Math.max(8, this.pageW * CONFIG.book.coverOverhang));
    const scale = (this.pageW + overhang) / this.pageW;
    this.board = {
      scale,
      overhangX: overhang,
      overhangY: ((scale - 1) * this.pageH) / 2,
      thickness: Math.max(4, Math.round(this.pageW * CONFIG.book.coverThickness))
    };
    style.setProperty('--board-scale', scale.toFixed(5));
    style.setProperty('--board-x', `${this.board.overhangX}px`);
    style.setProperty('--board-y', `${this.board.overhangY.toFixed(2)}px`);
    style.setProperty('--board-t', `${this.board.thickness}px`);

    // The pages are rendered finer than they are shown (at least
    // minPixelRatio canvas pixels per CSS pixel) and scaled down by the
    // browser: the thin strokes of the script and the ornaments come out far
    // smoother than when PDF.js draws them straight at the small size.
    const renderRatio = Math.min(Math.max(dpr, CONFIG.render.minPixelRatio), CONFIG.render.maxPixelRatio);
    this.source.setTargetSize(Math.round(this.pageW * renderRatio), Math.round(this.pageH * renderRatio));
    this.#applyFocus(false);
  }

  /**
   * One-page mode: which page of the spread is in view.
   * @param {'left'|'right'} side
   */
  setFocus(side, animate = true) {
    // An empty side (beside the cover) is never shown on its own.
    this.focus = this.slots[side].page ? side : side === 'left' ? 'right' : 'left';
    this.#applyFocus(animate);
  }

  /** Bring the page with this number into view if it is on the spread. */
  focusPage(page, animate = true) {
    if (this.slots.left.page === page) this.setFocus('left', animate);
    else if (this.slots.right.page === page) this.setFocus('right', animate);
  }

  #applyFocus(animate) {
    const book = this.bookEl;
    // Two pages: no shift. One page: half a page to the side, so that the
    // focused page is in the middle of the stage.
    const pan = !this.single ? 0 : this.focus === 'left' ? this.pageW / 2 : -this.pageW / 2;
    clearTimeout(this.panTimer);
    book.classList.toggle('panning', animate && this.single);
    book.style.setProperty('--pan', `${pan}px`);
    if (animate) this.panTimer = setTimeout(() => book.classList.remove('panning'), 360);
  }

  /** Where the pages are in the viewport (CSS px). */
  metrics() {
    const rect = this.slots.right.el.getBoundingClientRect();
    return { spineX: rect.left, top: rect.top, pageW: this.pageW, pageH: this.pageH };
  }

  #setSlot(side, page) {
    const slot = this.slots[side];
    slot.page = page;
    const canvas = page ? this.source.peek(page) : null;
    const current = slot.el.querySelector('.pdf-canvas');
    if (canvas) {
      if (current !== canvas) {
        if (current) current.replaceWith(canvas); else slot.el.prepend(canvas);
      }
    } else if (current) {
      current.remove();
    }
    slot.el.classList.toggle('is-empty', !canvas);
    // A cover seen from outside: the front one lies on the left, the back
    // one on the right.
    const outside = (this.hasCover && side === 'left' && page === 1) ||
      (this.hasBackCover && side === 'right' && page === this.model.pageCount);
    slot.el.classList.toggle('is-cover', outside && !!canvas);
    slot.el.dataset.pdfPage = page ? String(page) : '';
    this.#refreshLayers(side);
    // The verse areas of this page arrive with its juz; draw them when they do.
    const where = page ? this.source.locate(page) : null;
    if (where) {
      VerseRegions.load(where.index + 1).then(() => {
        if (this.slots[side].page === page) this.#refreshLayers(side);
        this.onRegions();
      });
    }
  }

  #refreshLayers(side) {
    const slot = this.slots[side];
    // Verse regions are stored per page of the PDF files.
    const pdfPage = slot.page ? this.source.pdfPageOf(slot.page) : null;
    renderHotspots(slot.hotspots, pdfPage, { debug: this.debugHotspots });
    renderHighlights(slot.highlights, pdfPage, this.highlighted);
  }

  /** Show another rendering of the same page in a slot (reading zoom). */
  setSlotCanvas(side, canvas) {
    const current = this.slots[side].el.querySelector('.pdf-canvas');
    if (current && current !== canvas) current.replaceWith(canvas);
  }

  /** Put the regular rendering of the slot's page back. */
  restoreSlot(side) {
    this.#setSlot(side, this.slots[side].page);
  }

  refreshLayers() {
    this.#refreshLayers('left');
    this.#refreshLayers('right');
  }

  /** Render (if needed) and show a spread without animation. */
  async showSpread(index) {
    const request = ++this.showRequest;
    const spread = this.model.spread(index);
    const pages = [spread.left, spread.right].filter(Boolean);
    // A resize while rendering changes the target size; render again then.
    for (;;) {
      const token = this.source.token;
      await Promise.all(pages.map((p) => this.source.render(p)));
      if (request !== this.showRequest) return; // a newer request took over
      if (token === this.source.token) break;
    }
    this.index = index;
    this.pinnedSpread = null;
    this.#setSlot('left', spread.left);
    this.#setSlot('right', spread.right);
    this.#updateStack();
    this.setFocus(this.focus, false);
    this.preload();
  }

  /** Render the neighbouring spreads in the background and free distant ones. */
  preload() {
    const { preloadSpreads, keepSpreads } = CONFIG.render;
    const keep = this.model.pagesAround(this.index, keepSpreads);
    // A spread being jumped to is far away but must not be thrown out again.
    if (this.pinnedSpread != null) keep.push(...this.model.pagesAround(this.pinnedSpread, 0));
    this.source.prune(keep);
    for (const page of this.model.pagesAround(this.index, preloadSpreads)) {
      this.source.render(page, { background: true }).catch(() => {});
    }
  }

  /**
   * Where the book is between closed and open. `side` is the cover that is
   * (or would be) up when closed; `open` runs from 0 = closed, lying centred
   * with only that cover showing, to 1 = open spread.
   * @param {'front'|'back'} side
   * @param {number} open
   */
  setCoverPose(side, open) {
    const o = Math.max(0, Math.min(1, open));
    const closed = 1 - o;
    const style = this.bookEl.style;
    style.setProperty('--cf', side === 'front' ? closed.toFixed(4) : '0');
    style.setProperty('--cb', side === 'back' ? closed.toFixed(4) : '0');
    style.setProperty('--closed', closed.toFixed(4));
    // While a cover is in the air it *is* the board of the side it leaves or
    // lands on, so the resting board there (and what lies on it) only shows
    // while the book is fully open.
    style.setProperty('--right-open', side === 'front' && o < 1 ? '0' : '1');
    style.setProperty('--left-open', side === 'back' && o < 1 ? '0' : '1');
    this.bookEl.classList.toggle('is-closed', o === 0);
  }

  /** Pose for the spread that is showing, with nothing in the air. */
  restPose() {
    const side = this.closedSide;
    this.setCoverPose(side || 'front', side ? 0 : 1);
  }

  /** Page 1 lies alone on the left: it is the outside of the front cover. */
  get hasCover() {
    return this.model.leadingBlanks === 1;
  }

  /** The last page lies alone on the right: the outside of the back cover. */
  get hasBackCover() {
    if (!this.source.cover) return false;
    const last = this.model.spread(this.model.spreadCount - 1);
    return !!last.right && !last.left;
  }

  /** Which cover is up if the book is closed at the current spread. */
  get closedSide() {
    if (this.hasCover && this.index === 0) return 'front';
    if (this.hasBackCover && this.index === this.model.spreadCount - 1) return 'back';
    return null;
  }

  get isClosed() {
    return this.closedSide !== null;
  }

  /** The thickness of the page blocks follows how far into the book we are. */
  #updateStack() {
    this.restPose();
    const total = Math.max(1, this.model.spreadCount - 1);
    const turned = this.index / total;
    this.bookEl.style.setProperty('--stack-right', `${(2 + turned * 7).toFixed(1)}px`);
    this.bookEl.style.setProperty('--stack-left', `${(2 + (1 - turned) * 7).toFixed(1)}px`);
  }

  /**
   * Everything needed to turn a leaf, or null if there is no leaf to turn or
   * its pages are not rendered yet (they are requested in that case).
   * @param {'next'|'prev'} dir
   */
  prepareTurn(dir) {
    const turn = this.model.turn(this.index, dir);
    if (!turn) return null;
    const pages = [turn.front, turn.back, turn.under].filter(Boolean);
    if (pages.some((p) => !this.source.peek(p))) {
      pages.forEach((p) => this.source.render(p).catch(() => {}));
      return null;
    }
    return {
      ...turn,
      frontCanvas: turn.front ? this.source.peek(turn.front) : null,
      backCanvas: turn.back ? this.source.peek(turn.back) : null
    };
  }

  #withCanvases(turn) {
    return {
      ...turn,
      frontCanvas: turn.front ? this.source.peek(turn.front) : null,
      backCanvas: turn.back ? this.source.peek(turn.back) : null
    };
  }

  /**
   * One sheet that turns over and lands on a spread any distance away (used
   * when jumping through the book). Null until that spread's pages are
   * rendered — see whenSpreadReady().
   */
  prepareJump(target) {
    if (!this.model.hasSpread(target) || target === this.index) return null;
    const from = this.model.spread(this.index);
    const to = this.model.spread(target);
    const turn = target > this.index
      ? { dir: 'next', target, side: -1, front: from.left, back: to.right, under: to.left }
      : { dir: 'prev', target, side: 1, front: from.right, back: to.left, under: to.right };
    const pages = [turn.front, turn.back, turn.under].filter(Boolean);
    if (pages.some((page) => !this.source.peek(page))) return null;
    return this.#withCanvases(turn);
  }

  /**
   * A sheet flicked past without changing the spread: it carries the pages
   * that are already showing, so nothing new has to be rendered for it.
   */
  prepareRiffle(dir) {
    const here = this.model.spread(this.index);
    const turn = dir === 'next'
      ? { dir, target: this.index, side: -1, front: here.left, back: here.right, under: here.left }
      : { dir, target: this.index, side: 1, front: here.right, back: here.left, under: here.right };
    if (!turn.front || !turn.back) return null;
    return this.#withCanvases(turn);
  }

  /** Renders the pages of a spread; resolves when they are ready. */
  async whenSpreadReady(index) {
    this.pinnedSpread = index;
    const { left, right } = this.model.spread(index);
    await Promise.all([left, right].filter(Boolean).map((page) => this.source.render(page)));
  }

  /** Resolves once prepareTurn(dir) can succeed (or immediately if it never can). */
  async whenTurnReady(dir) {
    const turn = this.model.turn(this.index, dir);
    if (!turn) return;
    await Promise.all([turn.front, turn.back, turn.under].filter(Boolean).map((p) => this.source.render(p)));
  }

  /** The leaf has lifted: reveal the page that was underneath it. */
  liftLeaf(turn) {
    this.bookEl.classList.add('is-turning');
    this.#setSlot(turn.side < 0 ? 'left' : 'right', turn.under);
  }

  /** The leaf has landed on the other side. */
  commitTurn(turn) {
    this.index = turn.target;
    if (this.pinnedSpread === this.index) this.pinnedSpread = null;
    this.#setSlot(turn.side < 0 ? 'right' : 'left', turn.back);
    this.bookEl.classList.remove('is-turning');
    this.#updateStack();
    this.preload();
  }

  /** The leaf fell back to where it came from. */
  revertTurn(turn) {
    this.#setSlot(turn.side < 0 ? 'left' : 'right', turn.front);
    this.bookEl.classList.remove('is-turning');
    this.restPose();
  }
}
