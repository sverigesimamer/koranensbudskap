// The look of the recitation player: its icons, the play/pause morph and,
// on small screens, the change between the mini player and the full one.
//
// There is one player element and one QuranPlayer behind it (one audio
// element, one state). The mini and the full player are two layouts of the
// same buttons: expanding only changes a class, and the buttons glide from
// where they were to where they are now (FLIP: measure, change, measure,
// animate the difference with transforms). Nothing is created or removed,
// so the sound is never touched.

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 24 × 24 icons, one family: filled transport shapes with rounded corners,
// and the same 1.8 stroke for the line icons.
const ICONS = {
  prev: '<path d="M7 6.2v11.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17.6 6.6v10.8a.9.9 0 0 1-1.4.75L9.3 12.75a.9.9 0 0 1 0-1.5l6.9-5.4a.9.9 0 0 1 1.4.75z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  next: '<path d="M17 6.2v11.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6.4 6.6v10.8a.9.9 0 0 0 1.4.75l6.9-5.4a.9.9 0 0 0 0-1.5L7.8 5.85a.9.9 0 0 0-1.4.75z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  repeat: '<path d="M5 11.2V10a3.6 3.6 0 0 1 3.6-3.6h9.2M15.6 4.2l2.2 2.2-2.2 2.2M19 12.8V14a3.6 3.6 0 0 1-3.6 3.6H6.2M8.4 19.8l-2.2-2.2 2.2-2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  chevron: '<path d="M6.5 14.5 12 9l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'
};

// Play and pause as the same two four-cornered shapes: the triangle split
// down the middle, and the two bars. Morphing moves the corners.
const PAUSE = [[[6.6, 5.4], [10.2, 5.4], [10.2, 18.6], [6.6, 18.6]], [[13.8, 5.4], [17.4, 5.4], [17.4, 18.6], [13.8, 18.6]]];
const PLAY = [[[7.6, 5.2], [13, 8.6], [13, 15.4], [7.6, 18.8]], [[13, 8.6], [18.8, 12], [18.8, 12], [13, 15.4]]];
const shapePath = (pts) => `M${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`;

function svg(inner, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
}

const fmt = (seconds) => {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class PlayerUI {
  /**
   * @param {Object} o
   * @param {HTMLElement} o.el   the #player element
   * @param {import('./audio-player.js').QuranPlayer} o.player
   */
  constructor({ el, player }) {
    this.el = el;
    this.player = player;
    this.expanded = false;
    this.playing = false;
    this.q = (id) => el.querySelector(`#${id}`);

    this.q('playerPrev').innerHTML = svg(ICONS.prev);
    this.q('playerNext').innerHTML = svg(ICONS.next);
    this.q('playerRepeat').innerHTML = svg(ICONS.repeat);
    this.q('playerExpand').innerHTML = svg(ICONS.chevron);
    const toggle = this.q('playerToggle');
    toggle.innerHTML = svg('<path fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>', 'play-icon');
    this.halves = [...toggle.querySelectorAll('path')];
    this.shape = PLAY;
    this.#drawShape(PLAY);

    this.#scrubber();
    this.q('playerRepeat').addEventListener('click', () => player.setRepeat(!player.repeat));
    const rates = [1, 1.25, 1.5, 0.75];
    this.q('playerRate').addEventListener('click', () => {
      const next = rates[(rates.indexOf(player.rate) + 1) % rates.length] || 1;
      player.setRate(next);
    });
    this.q('playerExpand').addEventListener('click', (e) => {
      e.stopPropagation();
      this.setExpanded(!this.expanded);
    });
    // The mini player opens when it is tapped anywhere but on a button.
    el.addEventListener('click', (e) => {
      if (!this.compact || this.expanded || e.target.closest('button, .scrub')) return;
      this.setExpanded(true);
    });
    // A tap outside the full player closes it again.
    document.addEventListener('pointerdown', (e) => {
      // (Choosing a reciter from the full player keeps it open.)
      if (this.expanded && !el.contains(e.target) && !e.target.closest('.reciter-sheet')) this.setExpanded(false);
    });
  }

  /** Small-screen layout (mini / full player) or the desktop pill. */
  set compact(on) {
    this.isCompact = on;
    this.el.classList.toggle('is-compact', on);
    if (!on && this.expanded) this.setExpanded(false, false);
  }

  get compact() {
    return !!this.isCompact;
  }

  // ---- play / pause -----------------------------------------------------------

  #drawShape(shape) {
    this.halves.forEach((path, i) => path.setAttribute('d', shapePath(shape[i])));
  }

  /** Show playing or paused; the icon's corners glide to the other shape. */
  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    const target = playing ? PAUSE : PLAY;
    cancelAnimationFrame(this.morph);
    const from = this.shape;
    this.shape = target;
    if (reducedMotion()) {
      this.#drawShape(target);
      return;
    }
    const start = performance.now();
    const ms = 190;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      this.#drawShape(from.map((half, i) => half.map(([x, y], k) => [x + (target[i][k][0] - x) * e, y + (target[i][k][1] - y) * e])));
      if (t < 1) this.morph = requestAnimationFrame(frame);
    };
    this.morph = requestAnimationFrame(frame);
  }

  /** Repeat and speed as the player has them. */
  update(state) {
    const repeat = this.q('playerRepeat');
    repeat.classList.toggle('on', !!state.repeat);
    repeat.setAttribute('aria-pressed', String(!!state.repeat));
    const rate = state.rate || 1;
    this.q('playerRate').textContent = `${String(rate).replace('.', ',')}×`;
    this.#tick();
  }

  // ---- mini ↔ full ----------------------------------------------------------------

  setExpanded(open, animate = true) {
    if (open === this.expanded || (open && !this.compact)) return;
    const shared = ['playerPrev', 'playerToggle', 'playerNext', 'playerExpand'].map((id) => this.q(id));
    const texts = [this.el.querySelector('.player-text')];
    const extras = [...this.el.querySelectorAll('.player-extra-full')];
    const change = () => {
      this.expanded = open;
      this.el.classList.toggle('is-expanded', open);
      this.q('playerExpand').setAttribute('aria-label', open ? 'Minimera spelaren' : 'Visa hela spelaren');
      this.q('playerExpand').setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('player-open', open);
      if (open) this.#run(); else cancelAnimationFrame(this.ticker);
    };
    if (!animate || reducedMotion()) {
      change();
      if (animate) this.el.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 140 });
      return;
    }
    // First: where everything is now.
    const box0 = this.el.getBoundingClientRect();
    const first = new Map([...shared, ...texts].map((el) => [el, el.getBoundingClientRect()]));
    const radius0 = parseFloat(getComputedStyle(this.el).borderTopLeftRadius) || 0;
    change();
    // Last: where it all is after the change; then play the difference back.
    const box1 = this.el.getBoundingClientRect();
    const radius1 = parseFloat(getComputedStyle(this.el).borderTopLeftRadius) || 0;
    const ms = 340;
    const easing = 'cubic-bezier(.25, .8, .25, 1)';
    for (const el of [...shared, ...texts]) {
      const a = first.get(el);
      const b = el.getBoundingClientRect();
      if (!b.width || !a.width) continue;
      // Buttons keep their proportions; the text block grows with its height.
      const s = texts.includes(el) ? a.height / b.height : a.width / b.width;
      el.animate([
        { transformOrigin: '0 0', transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${s})` },
        { transformOrigin: '0 0', transform: 'none' }
      ], { duration: ms, easing });
    }
    // The player itself grows out of (or shrinks back into) the mini player.
    const inset = (t, r, b, l, radius) => `inset(${t}px ${r}px ${b}px ${l}px round ${radius}px)`;
    this.el.animate([
      { clipPath: inset(box0.top - box1.top, box1.right - box0.right, box1.bottom - box0.bottom, box0.left - box1.left, radius0) },
      { clipPath: inset(0, 0, 0, 0, radius1) }
    ], { duration: ms, easing });
    if (open) {
      extras.forEach((el, i) => el.animate([
        { opacity: 0, transform: 'translateY(10px)' },
        { opacity: 0, transform: 'translateY(10px)', offset: 0.35 },
        { opacity: 1, transform: 'none' }
      ], { duration: ms + 40 + i * 25, easing }));
    }
  }

  // ---- time and scrubber ----------------------------------------------------------

  #scrubber() {
    const scrub = this.el.querySelector('.scrub');
    this.scrub = scrub;
    let dragging = false;
    let lastSeek = 0;
    const fraction = (x) => {
      const r = scrub.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / r.width));
    };
    const show = (f) => {
      scrub.style.setProperty('--progress', f.toFixed(4));
      this.q('playerTime').textContent = fmt(f * this.player.duration);
      scrub.setAttribute('aria-valuenow', String(Math.round(f * this.player.duration)));
    };
    scrub.addEventListener('pointerdown', (e) => {
      if (!this.player.duration) return;
      e.preventDefault();
      dragging = true;
      this.dragging = true;
      scrub.setPointerCapture(e.pointerId);
      scrub.classList.add('dragging');
      show(fraction(e.clientX));
    });
    scrub.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const f = fraction(e.clientX);
      show(f);
      // Follow while dragging, but not on every pixel.
      const now = performance.now();
      if (now - lastSeek > 220) {
        lastSeek = now;
        this.player.seekTo(f * this.player.duration);
      }
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      scrub.classList.remove('dragging');
      this.player.seekTo(fraction(e.clientX) * this.player.duration);
      // Let the audio catch up before the bar follows it again.
      setTimeout(() => { this.dragging = false; }, 250);
    };
    scrub.addEventListener('pointerup', end);
    scrub.addEventListener('pointercancel', end);
    scrub.addEventListener('keydown', (e) => {
      const d = this.player.duration;
      if (!d) return;
      const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      this.player.seekTo(this.player.time + step);
    });
  }

  #tick() {
    if (this.dragging) return;
    const d = this.player.duration;
    const t = this.player.time;
    this.scrub.style.setProperty('--progress', d ? (t / d).toFixed(4) : '0');
    this.scrub.setAttribute('aria-valuemax', String(Math.round(d)));
    this.scrub.setAttribute('aria-valuenow', String(Math.round(t)));
    this.q('playerTime').textContent = fmt(t);
    this.q('playerDur').textContent = d ? fmt(d) : '–:––';
  }

  /** While the full player is open, its time follows the sound smoothly. */
  #run() {
    cancelAnimationFrame(this.ticker);
    const loop = () => {
      this.#tick();
      if (this.expanded) this.ticker = requestAnimationFrame(loop);
    };
    loop();
  }
}

