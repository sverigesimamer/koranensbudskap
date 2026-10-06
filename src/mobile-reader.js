// Phones and narrow tablets: one page at a time, as large as the screen
// allows.
//
// This is another way of showing the same book, not a second reader: the
// pages come from the same PdfSource (the untouched PDF pages, rendered by
// PDF.js), the verse marks from the same layers, and main.js keeps using one
// position in the book. Only the current page and its two neighbours are kept
// rendered.
//
// Gestures (all on the page):
//   swipe sideways      next / previous page (right-to-left book: a swipe to
//                       the right moves on), the page lands with a short slide
//   pinch               zoom, around the fingers
//   double tap          zoom in at that spot / back out
//   drag while zoomed   pan — never turns the page by accident
//   tap                 onTap (main.js shows or hides the controls)
//   long press          onLongPress with the spot on the page (recite from there)

import { CONFIG } from './config.js';
import { renderHighlights } from './layers/interaction-layers.js';
import { VerseRegions } from './verse-regions.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class MobileReader {
  /**
   * @param {Object} o
   * @param {HTMLElement} o.el                      the .m-reader element
   * @param {import('./pdf-source.js').PdfSource} o.source
   * @param {number} o.firstPage                    first and last book page shown
   * @param {number} o.lastPage
   * @param {(page: number) => void} [o.onPage]     the page in view has changed
   * @param {() => void} [o.onTap]
   * @param {(at: {pdfPage: number, x: number, y: number}) => void} [o.onLongPress]  x, y: 0..1 of the page
   * @param {(dir: 'next'|'prev') => void} [o.onBlocked]
   */
  constructor({ el, source, firstPage, lastPage, onPage, onTap, onLongPress, onBlocked }) {
    this.el = el;
    this.source = source;
    this.firstPage = firstPage;
    this.lastPage = lastPage;
    this.onPage = onPage || (() => {});
    this.onTap = onTap || (() => {});
    this.onLongPress = onLongPress || (() => {});
    this.onBlocked = onBlocked || (() => {});
    this.track = el.querySelector('.m-track');
    /** The three panels, by role. */
    const panels = [...el.querySelectorAll('.m-panel')].map((panelEl) => ({
      el: panelEl,
      page: null,
      pageEl: panelEl.querySelector('.m-page'),
      highlights: panelEl.querySelector('.highlight-layer'),
      canvas: null
    }));
    this.panels = { next: panels[0], cur: panels[1], prev: panels[2] };
    this.page = null;
    this.active = false;
    this.highlighted = new Set();
    /** Zoom of the current page (1 = fitted) and its offset (CSS px). */
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.moving = false;
    this.pointers = new Map();
    this.gesture = null;
    this.lastTap = null;
    this.sharpToken = 0;

    el.addEventListener('pointerdown', (e) => this.#down(e));
    el.addEventListener('pointermove', (e) => this.#move(e));
    el.addEventListener('pointerup', (e) => this.#up(e));
    el.addEventListener('pointercancel', (e) => this.#up(e, true));
    el.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    // Safari's own pinch gestures would zoom the whole site.
    el.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  // ---- showing -------------------------------------------------------------

  activate(page) {
    this.active = true;
    this.el.hidden = false;
    this.layout();
    this.#show(page);
  }

  deactivate() {
    this.active = false;
    this.el.hidden = true;
    clearTimeout(this.tapTimer);
    clearTimeout(this.pressTimer);
    // The canvases belong to the PdfSource cache; let the book take them back.
    for (const panel of Object.values(this.panels)) this.#empty(panel);
  }

  /** Fit the page to the screen and tell the PDF source how big to render. */
  layout() {
    const style = getComputedStyle(this.el);
    const inset = {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0
    };
    const { sideMargin, endMargin, landscapeMaxWidth } = CONFIG.mobile;
    const vw = this.el.clientWidth;
    const vh = this.el.clientHeight;
    const availW = vw - inset.left - inset.right - sideMargin * 2;
    const availH = vh - inset.top - inset.bottom - endMargin * 2;
    const aspect = this.source.aspect;
    // Upright: the whole page, as wide as it fits. On its side the screen is
    // too low for a whole page to be readable, so the page takes the width
    // and is read by moving it up and down.
    const upright = vh >= vw;
    let pageW = upright ? Math.min(availW, availH * aspect) : Math.min(availW, landscapeMaxWidth);
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
    pageW = Math.round(pageW * dpr) / dpr;
    const pageH = Math.round((pageW / aspect) * dpr) / dpr;
    this.box = { vw, vh, inset, availW, availH, pageW, pageH, dpr };
    // Pages a little larger than the screen shows them, as on the desktop.
    const ratio = Math.min(Math.max(dpr, CONFIG.mobile.minPixelRatio), CONFIG.render.maxPixelRatio);
    this.source.setTargetSize(Math.round(pageW * ratio), Math.round(pageH * ratio));

    for (const panel of Object.values(this.panels)) {
      panel.pageEl.style.width = `${pageW}px`;
      panel.pageEl.style.height = `${pageH}px`;
      panel.pageEl.style.left = `${this.#baseX()}px`;
      panel.pageEl.style.top = `${this.#baseY()}px`;
    }
    this.#placePanels();
    if (this.page) {
      // A new size drops the renderings: render the pages again.
      const page = this.page;
      this.page = null;
      this.#show(page);
    }
  }

  /** Where the fitted page lies (CSS px from the screen's top left). */
  #baseX() {
    const { vw, pageW } = this.box;
    return Math.round((vw - pageW) / 2);
  }

  #baseY() {
    const { vh, pageH, inset, availH } = this.box;
    const { endMargin } = CONFIG.mobile;
    return pageH <= availH ? Math.round(inset.top + endMargin + (availH - pageH) / 2) : Math.round(inset.top + endMargin);
  }

  #placePanels() {
    const { vw } = this.box;
    // Right-to-left: the next page waits on the left, the previous on the right.
    this.panels.next.el.style.transform = `translate3d(${-vw}px, 0, 0)`;
    this.panels.cur.el.style.transform = 'translate3d(0, 0, 0)';
    this.panels.prev.el.style.transform = `translate3d(${vw}px, 0, 0)`;
  }

  #pageAt(role) {
    const p = role === 'cur' ? this.page : role === 'next' ? this.page + 1 : this.page - 1;
    return p >= this.firstPage && p <= this.lastPage ? p : null;
  }

  /** Show a page (no animation) with its neighbours ready beside it. */
  #show(page) {
    this.page = clamp(page, this.firstPage, this.lastPage);
    this.#resetZoom(false);
    // A page may move to another panel: take every canvas out first.
    for (const panel of Object.values(this.panels)) this.#empty(panel);
    for (const role of ['cur', 'next', 'prev']) this.#fill(this.panels[role], this.#pageAt(role), role !== 'cur');
    this.source.prune([this.page - 1, this.page, this.page + 1]);
  }

  #empty(panel) {
    panel.sharp?.remove();
    panel.sharp = null;
    panel.canvas?.remove();
    panel.canvas = null;
    panel.page = null;
  }

  #fill(panel, page, background) {
    if (panel.page === page && panel.canvas) return;
    panel.page = page;
    panel.sharp?.remove();
    panel.sharp = null;
    panel.canvas?.remove();
    panel.canvas = null;
    panel.el.classList.toggle('is-empty', !page);
    panel.el.classList.add('is-loading');
    panel.highlights.replaceChildren();
    if (!page) return;
    const put = (canvas) => {
      if (panel.page !== page || !this.active) return;
      panel.canvas?.remove();
      panel.canvas = canvas;
      panel.pageEl.prepend(canvas);
      panel.el.classList.remove('is-loading');
    };
    const ready = this.source.peek(page);
    if (ready) put(ready);
    else this.source.render(page, { background }).then(put, () => {});
    this.#refresh(panel);
    const where = this.source.locate(page);
    if (where) VerseRegions.load(where.index + 1).then(() => { if (panel.page === page) this.#refresh(panel); });
  }

  #refresh(panel) {
    renderHighlights(panel.highlights, panel.page ? this.source.pdfPageOf(panel.page) : null, this.highlighted);
  }

  refreshLayers() {
    for (const panel of Object.values(this.panels)) this.#refresh(panel);
  }

  // ---- moving between pages ---------------------------------------------------

  /** One page on ('next') or back ('prev'), with the slide. */
  step(dir) {
    if (this.moving) return false;
    const target = this.page + (dir === 'next' ? 1 : -1);
    if (target < this.firstPage || target > this.lastPage) {
      this.onBlocked(dir);
      this.#slideTo(0);
      return false;
    }
    this.#land(dir);
    return true;
  }

  /** Go to any page: a neighbour slides in, anything further cross-fades. */
  goTo(page, { animate = true } = {}) {
    page = clamp(page, this.firstPage, this.lastPage);
    if (page === this.page) return;
    if (animate && !this.moving && Math.abs(page - this.page) === 1) {
      this.step(page > this.page ? 'next' : 'prev');
      return;
    }
    if (!animate || reducedMotion()) {
      this.#show(page);
      this.onPage(this.page);
      return;
    }
    this.el.classList.add('m-fading');
    setTimeout(() => {
      this.#show(page);
      this.onPage(this.page);
      this.el.classList.remove('m-fading');
    }, 160);
  }

  #slideTo(x, done) {
    const ms = reducedMotion() ? 0 : CONFIG.mobile.slideMs;
    this.track.style.transition = ms ? `transform ${ms}ms cubic-bezier(.22, .8, .3, 1)` : 'none';
    this.track.style.transform = `translate3d(${x}px, 0, 0)`;
    clearTimeout(this.slideTimer);
    this.slideTimer = setTimeout(() => {
      this.track.style.transition = 'none';
      if (done) done();
    }, ms + 20);
  }

  /** Finish a turn: the neighbour slides into place, then the panels move round. */
  #land(dir) {
    this.moving = true;
    const { vw } = this.box;
    this.#slideTo(dir === 'next' ? vw : -vw, () => {
      const { next, cur, prev } = this.panels;
      this.#restoreCanvas(cur);
      this.panels = dir === 'next' ? { next: prev, cur: next, prev: cur } : { next: cur, cur: prev, prev: next };
      this.page += dir === 'next' ? 1 : -1;
      this.track.style.transform = 'translate3d(0, 0, 0)';
      this.#placePanels();
      this.#resetZoom(false);
      // The panel that came round from the far side gets the new neighbour.
      const far = dir === 'next' ? 'next' : 'prev';
      this.#fill(this.panels[far], this.#pageAt(far), true);
      const current = this.panels.cur;
      if (!current.canvas) this.#fill(current, this.page, false);
      this.source.prune([this.page - 1, this.page, this.page + 1]);
      this.moving = false;
      this.onPage(this.page);
    });
  }

  // ---- zoom and pan -----------------------------------------------------------

  get zoomed() {
    return this.scale > 1.01;
  }

  /** Limits of the offset for a zoom: the page never leaves a gap at an edge it could fill. */
  #bounds(scale) {
    const { vw, vh, inset, pageW, pageH } = this.box;
    const { sideMargin, endMargin } = CONFIG.mobile;
    const x0 = this.#baseX();
    const y0 = this.#baseY();
    const w = pageW * scale;
    const h = pageH * scale;
    const left = inset.left + sideMargin;
    const right = vw - inset.right - sideMargin;
    const top = inset.top + endMargin;
    const bottom = vh - inset.bottom - endMargin;
    // Narrower than the screen: centred. Wider: no gap at either side.
    const tx = w <= right - left ? [(vw - w) / 2 - x0, (vw - w) / 2 - x0] : [right - w - x0, left - x0];
    const ty = h <= bottom - top ? [(top + bottom - h) / 2 - y0, (top + bottom - h) / 2 - y0] : [bottom - h - y0, top - y0];
    return { tx, ty, canPanX: tx[0] < tx[1] - 0.5, canPanY: ty[0] < ty[1] - 0.5 };
  }

  #apply(animate = false) {
    const pageEl = this.panels.cur.pageEl;
    pageEl.style.transition = animate && !reducedMotion() ? 'transform .26s cubic-bezier(.22, .8, .3, 1)' : 'none';
    pageEl.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
    this.el.classList.toggle('is-zoomed', this.zoomed);
  }

  #clampOffset() {
    const b = this.#bounds(this.scale);
    this.tx = clamp(this.tx, b.tx[0], b.tx[1]);
    this.ty = clamp(this.ty, b.ty[0], b.ty[1]);
  }

  #resetZoom(animate) {
    if (this.zoomed) this.#restoreCanvas(this.panels.cur);
    this.scale = 1;
    // Fitted: the top of the page (a page taller than the screen is read downwards).
    const b = this.#bounds(1);
    this.tx = b.tx[1];
    this.ty = b.ty[1];
    this.#apply(animate);
    // The other panels never keep a zoom.
    for (const role of ['next', 'prev']) this.panels[role].pageEl.style.transform = '';
  }

  /** Zoom to `scale`, keeping the page point under (x, y) where it is. */
  #zoomAt(scale, x, y, animate) {
    const s = clamp(scale, 1, CONFIG.mobile.maxZoom);
    const x0 = this.#baseX();
    const y0 = this.#baseY();
    const u = (x - x0 - this.tx) / this.scale;
    const v = (y - y0 - this.ty) / this.scale;
    this.scale = s;
    this.tx = x - x0 - u * s;
    this.ty = y - y0 - v * s;
    this.#clampOffset();
    this.#apply(animate);
    this.#sharpenSoon();
  }

  /** Once the zoom has settled, render the page again at that size so it stays crisp. */
  #sharpenSoon() {
    clearTimeout(this.sharpTimer);
    const token = ++this.sharpToken;
    if (!this.zoomed) {
      this.#restoreCanvas(this.panels.cur);
      return;
    }
    this.sharpTimer = setTimeout(async () => {
      const panel = this.panels.cur;
      const { pageW, pageH, dpr } = this.box;
      let w = pageW * this.scale * Math.max(dpr, 1.5);
      let h = pageH * this.scale * Math.max(dpr, 1.5);
      const max = CONFIG.mobile.maxZoomPixels;
      if (w * h > max) {
        const k = Math.sqrt(max / (w * h));
        w *= k;
        h *= k;
      }
      const page = panel.page;
      try {
        const canvas = await this.source.renderSized(page, Math.round(w), Math.round(h));
        if (token !== this.sharpToken || panel !== this.panels.cur || panel.page !== page || !this.zoomed) return;
        canvas.classList.add('pdf-canvas');
        (panel.sharp || panel.canvas)?.replaceWith(canvas);
        panel.sharp = canvas;
      } catch { /* the regular rendering stays */ }
    }, 260);
  }

  /** Put the regular rendering back in place of a sharper zoomed one. */
  #restoreCanvas(panel) {
    if (!panel.sharp) return;
    if (panel.canvas) panel.sharp.replaceWith(panel.canvas);
    else panel.sharp.remove();
    panel.sharp = null;
  }

  /**
   * Make sure a part of the current page is on screen (recitation follows the
   * verse when the page is zoomed or taller than the screen).
   * @param {[number, number, number, number][]} areas x, y, w, h (0..1 of the page)
   */
  showAreas(areas) {
    if (!this.active || !areas.length || this.gesture || this.moving) return;
    const b = this.#bounds(this.scale);
    if (!b.canPanY) return;
    const { pageH, vh } = this.box;
    const y0 = this.#baseY();
    const top = y0 + this.ty + Math.min(...areas.map((a) => a[1])) * pageH * this.scale;
    const bottom = y0 + this.ty + Math.max(...areas.map((a) => a[1] + a[3])) * pageH * this.scale;
    if (top >= vh * 0.14 && bottom <= vh * 0.8) return;
    this.ty = clamp(this.ty + vh * 0.3 - top, b.ty[0], b.ty[1]);
    this.#apply(true);
  }

  // ---- gestures ---------------------------------------------------------------

  #down(e) {
    if (!this.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clearTimeout(this.pressTimer);
    if (this.pointers.size === 2) {
      clearTimeout(this.tapTimer);
      this.#startPinch();
      return;
    }
    if (this.pointers.size > 2) return;
    this.momentum && cancelAnimationFrame(this.momentum);
    this.gesture = {
      type: 'pending',
      x: e.clientX,
      y: e.clientY,
      time: performance.now(),
      tx: this.tx,
      ty: this.ty,
      samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }]
    };
    this.pressTimer = setTimeout(() => {
      if (this.gesture && this.gesture.type === 'pending') {
        this.gesture.type = 'press';
        const at = this.#pagePoint(this.gesture.x, this.gesture.y);
        if (at) this.onLongPress(at);
      }
    }, CONFIG.mobile.longPressMs);
  }

  #startPinch() {
    const [a, b] = [...this.pointers.values()];
    if (this.gesture?.type === 'swipe') this.#slideTo(0);
    this.gesture = {
      type: 'pinch',
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      scale: this.scale,
      tx: this.tx,
      ty: this.ty
    };
  }

  #move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.gesture) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const g = this.gesture;

    if (g.type === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // A little give below the fitted size, none above the largest.
      let s = g.scale * (dist / g.dist);
      if (s < 1) s = 1 - (1 - s) * 0.35;
      s = Math.min(s, CONFIG.mobile.maxZoom);
      const x0 = this.#baseX();
      const y0 = this.#baseY();
      const u = (g.mid.x - x0 - g.tx) / g.scale;
      const v = (g.mid.y - y0 - g.ty) / g.scale;
      this.scale = s;
      this.tx = mid.x - x0 - u * s;
      this.ty = mid.y - y0 - v * s;
      this.#apply(false);
      return;
    }
    if (this.pointers.size !== 1) return;

    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (g.samples.length > 6) g.samples.shift();

    if (g.type === 'pending') {
      if (Math.hypot(dx, dy) < CONFIG.mobile.dragSlop) return;
      clearTimeout(this.pressTimer);
      const b = this.#bounds(this.scale);
      // Zoomed in: a drag always moves the page around, it never turns it.
      if (this.zoomed) g.type = 'pan';
      else if (Math.abs(dx) > Math.abs(dy) * 1.1) g.type = 'swipe';
      else g.type = b.canPanY ? 'pan' : 'none';
    }
    if (g.type === 'pan') {
      const b = this.#bounds(this.scale);
      const rubber = (value, [lo, hi]) => (value < lo ? lo - (lo - value) * 0.35 : value > hi ? hi + (value - hi) * 0.35 : value);
      this.tx = rubber(g.tx + dx, b.tx);
      this.ty = rubber(g.ty + dy, b.ty);
      this.#apply(false);
    } else if (g.type === 'swipe' && !this.moving) {
      const dir = dx > 0 ? 'next' : 'prev';
      const room = this.#pageAt(dir) ? 1 : 0.25; // first / last page: a little give only
      this.track.style.transition = 'none';
      this.track.style.transform = `translate3d(${dx * room}px, 0, 0)`;
    }
  }

  #velocity(g) {
    const s = g.samples;
    if (s.length < 2) return { x: 0, y: 0 };
    const a = s[0];
    const b = s[s.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }

  #up(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    clearTimeout(this.pressTimer);
    const g = this.gesture;
    if (!g) return;

    if (g.type === 'pinch') {
      if (this.pointers.size === 1) {
        // One finger stays down: carry on as a pan from here.
        const [p] = [...this.pointers.values()];
        this.gesture = { type: 'pan', x: p.x, y: p.y, time: performance.now(), tx: this.tx, ty: this.ty, samples: [{ ...p, t: performance.now() }] };
        return;
      }
      this.gesture = null;
      if (this.scale < 1.04) this.#resetZoom(true);
      else {
        this.#clampOffset();
        this.#apply(true);
        this.#sharpenSoon();
      }
      return;
    }
    if (this.pointers.size) return;
    this.gesture = null;

    if (g.type === 'swipe') {
      const dx = e.clientX - g.x;
      const v = this.#velocity(g).x;
      const dir = dx > 0 ? 'next' : 'prev';
      const far = Math.abs(dx) > this.box.vw * 0.22;
      const flick = Math.abs(v) > 0.45 && Math.abs(dx) > 24 && Math.sign(v) === Math.sign(dx);
      if (!cancelled && (far || flick) && this.#pageAt(dir)) this.#land(dir);
      else {
        if (!cancelled && (far || flick)) this.onBlocked(dir);
        this.#slideTo(0);
      }
      return;
    }
    if (g.type === 'pan') {
      this.#glide(this.#velocity(g));
      return;
    }
    if (g.type === 'pending' && !cancelled) this.#tap(e.clientX, e.clientY);
  }

  /** After a pan: carry on a little and come to rest inside the limits. */
  #glide(v) {
    if (reducedMotion() || Math.hypot(v.x, v.y) < 0.05) {
      this.#clampOffset();
      this.#apply(true);
      return;
    }
    let { x, y } = v;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last);
      last = now;
      this.tx += x * dt;
      this.ty += y * dt;
      const decay = Math.pow(0.992, dt);
      x *= decay;
      y *= decay;
      const b = this.#bounds(this.scale);
      const outside = this.tx < b.tx[0] || this.tx > b.tx[1] || this.ty < b.ty[0] || this.ty > b.ty[1];
      if (outside || Math.hypot(x, y) < 0.02) {
        this.momentum = null;
        this.#clampOffset();
        this.#apply(true);
        return;
      }
      this.#apply(false);
      this.momentum = requestAnimationFrame(step);
    };
    this.momentum = requestAnimationFrame(step);
  }

  #tap(x, y) {
    const now = performance.now();
    const last = this.lastTap;
    if (last && now - last.time < 320 && Math.hypot(x - last.x, y - last.y) < 36) {
      // Double tap: in to read closely, or back out.
      this.lastTap = null;
      clearTimeout(this.tapTimer);
      if (this.zoomed) {
        this.#resetZoom(true);
        this.#sharpenSoon();
      } else {
        this.#zoomAt(CONFIG.mobile.doubleTapZoom, x, y, true);
      }
      return;
    }
    this.lastTap = { time: now, x, y };
    clearTimeout(this.tapTimer);
    // Wait a moment: it may become a double tap.
    this.tapTimer = setTimeout(() => this.onTap(), 330);
  }

  #wheel(e) {
    if (!this.active) return;
    e.preventDefault();
    if (e.ctrlKey) {
      // Trackpad pinch (and Ctrl + wheel).
      this.#zoomAt(this.scale * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY, false);
      return;
    }
    const b = this.#bounds(this.scale);
    if (!b.canPanX && !b.canPanY) return;
    this.tx = clamp(this.tx - e.deltaX, b.tx[0], b.tx[1]);
    this.ty = clamp(this.ty - e.deltaY, b.ty[0], b.ty[1]);
    this.#apply(false);
  }

  /** The point on the current page under a screen position (0..1), or null. */
  #pagePoint(x, y) {
    const { pageW, pageH } = this.box;
    const u = (x - this.#baseX() - this.tx) / (pageW * this.scale);
    const v = (y - this.#baseY() - this.ty) / (pageH * this.scale);
    if (u < 0 || u > 1 || v < 0 || v > 1 || !this.page) return null;
    return { pdfPage: this.source.pdfPageOf(this.page), x: u, y: v };
  }
}
