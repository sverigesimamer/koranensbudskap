// Drives a page turn: pointer / keyboard input -> where the grabbed edge of
// the sheet should be -> curl-solver -> FlipRenderer.
//
// One "session" is one leaf in the air. It moves through these modes:
//   peek    the pointer hovers over a page edge; the edge lifts a little
//   drag    the edge follows the finger / mouse
//   settle  released: a spring carries the sheet to the other side or back
//   auto    keyboard or click: the sheet follows a timed arc to the other side
//
// All positions are in canonical page space (see curl-solver.js), so the
// same code turns the left and the right page.

import { CONFIG } from '../config.js';
import { solveCurl, PROFILE_SAMPLES } from './curl-solver.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Within this angle of lying flat the sheet stops following a position and
// settles by its angle instead (see #land).
const LAND_ANGLE = 0.55;
const FADE_MS = 170;

export class FlipController {
  /**
   * @param {Object} o
   * @param {import('../book-view.js').BookView} o.view
   * @param {import('./flip-renderer.js').FlipRenderer} o.renderer
   * @param {HTMLCanvasElement} o.canvas  overlay the renderer draws into
   * @param {(dir: 'next'|'prev') => void} [o.onBlocked] no leaf left in that direction
   * @param {(turn: object) => void} [o.onTurned] a leaf has landed (turn.dir, turn.riffle)
   */
  constructor({ view, renderer, canvas, onBlocked, onTurned }) {
    this.view = view;
    this.renderer = renderer;
    this.canvas = canvas;
    this.onBlocked = onBlocked || (() => {});
    this.onTurned = onTurned || (() => {});
    this.session = null;
    this.enabled = true;
    this.profile = new Float32Array(PROFILE_SAMPLES * 3);
    this.raf = 0;
    this.lastTime = 0;
    this.suppressClick = false;
    /** Turns asked for while a sheet was still in the air ('next' | 'prev'). */
    this.queue = [];
    this.starting = false;
    /** A jump through the book in progress (see jumpTo). */
    this.jump = null;

    const book = view.bookEl;
    book.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.#onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.#onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.#onPointerUp(e, true));
    book.addEventListener('dragstart', (e) => e.preventDefault());
    // A drag that ends over a hotspot must not also count as a click on it.
    book.addEventListener('click', (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  get busy() {
    return !!this.jump || (!!this.session && this.session.mode !== 'peek');
  }

  // ---- geometry helpers -------------------------------------------------

  /** Which page edge (if any) a viewport point grabs. */
  #hitZone(clientX, clientY, pointerType) {
    const m = this.view.metrics();
    const zone = m.pageW * (pointerType === 'touch' ? CONFIG.flip.grabZoneTouch : CONFIG.flip.grabZone);
    const y = clientY - m.top;
    if (y < -8 || y > m.pageH + 8) return null;
    const dx = clientX - m.spineX;
    const fromEdge = m.pageW - Math.abs(dx);
    if (fromEdge < -8 || fromEdge > zone) return null;
    // RTL: the left page turns to go forward, the right page to go back.
    const dir = dx < 0 ? 'next' : 'prev';
    // An edge with no leaf to turn (e.g. beside the closed book) grabs nothing.
    return this.view.model.turn(this.view.index, dir) ? dir : null;
  }

  /**
   * Turning away from / back to the closed book moves a cover board.
   * @returns {'front'|'back'|null} which one
   */
  #isCoverTurn(dir) {
    const { view } = this;
    const turn = view.model.turn(view.index, dir);
    if (!turn) return null;
    if (view.hasCover && Math.min(view.index, turn.target) === 0) return 'front';
    const last = view.model.spreadCount - 1;
    if (view.hasBackCover && Math.max(view.index, turn.target) === last) return 'back';
    return null;
  }

  /** Does this cover turn open the book (rather than close it)? */
  #opens(s) {
    return (s.cover === 'front') === (s.turn.dir === 'next');
  }

  #toPage(s, clientX, clientY) {
    return { x: s.side * (clientX - s.m.spineX), y: clientY - s.m.top };
  }

  #peekTarget(s, y) {
    const { pageW: W, pageH: H } = s.m;
    const lift = CONFIG.flip.peek * W;
    const e = (2 * y) / H - 1; // -1 top .. +1 bottom
    return { x: W - lift * (0.75 + 0.25 * Math.abs(e)), y: y - e * lift * 0.9 };
  }

  // ---- session lifecycle ------------------------------------------------

  /**
   * @param {'next'|'prev'} dir
   * @param {number} gy    where on the outer edge the sheet is held (px from the top)
   * @param {string} mode
   * @param {object} [prepared] a turn from view.prepareJump / prepareRiffle
   *   instead of the ordinary turn to the neighbouring spread
   */
  #begin(dir, gy, mode, prepared) {
    const turn = prepared || this.view.prepareTurn(dir);
    if (!turn) return null;
    const m = this.view.metrics();
    const s = {
      turn,
      side: turn.side,
      m,
      gy: clamp(gy, 0, m.pageH),
      mode,
      pos: { x: m.pageW, y: clamp(gy, 0, m.pageH) },
      vel: { x: 0, y: 0 },
      target: { x: m.pageW, y: clamp(gy, 0, m.pageH) },
      outcome: null,
      pointerId: null,
      down: null,
      pointerVel: { x: 0, y: 0 },
      lastMove: null,
      auto: null,
      // Turning the cover opens or closes the book.
      // A jump away from the closed book swings the cover open as well.
      cover: prepared ? (turn.riffle ? null : this.view.closedSide) : this.#isCoverTurn(dir)
    };
    this.session = s;
    // The animation comes first: preloading of other pages waits until the sheet is down.
    this.view.source.hold(true);

    // A previous sheet may still be fading out; this one takes over the canvas.
    clearTimeout(this.fadeTimer);
    this.canvas.classList.remove('fading');

    this.renderer.resize(window.innerWidth, window.innerHeight, this.view.dpr);
    this.renderer.setSheet(turn.frontCanvas, turn.backCanvas);
    this.#draw();
    this.canvas.classList.add('active');
    // Only now swap the DOM page for the one underneath: the sheet already
    // covers it, so nothing flickers.
    this.view.liftLeaf(turn);

    this.lastTime = performance.now();
    this.#cancelFrame();
    this.#requestFrame();
    return s;
  }

  #hide() {
    this.view.source.hold(false);
    clearTimeout(this.fadeTimer);
    this.renderer.clear();
    this.canvas.classList.remove('active', 'fading');
  }

  #end(completed, instant = false) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.#cancelFrame();
    clearTimeout(this.fadeTimer);

    if (instant) {
      if (completed) this.view.commitTurn(s.turn); else this.view.revertTurn(s.turn);
      this.#hide();
    } else {
      // Hand over without a visible cut: draw the sheet lying exactly flat,
      // put the real page underneath, then let the sheet fade away over it.
      s.landing = { theta: completed ? Math.PI : 0, vel: 0 };
      if (completed) s.pos = { x: -s.m.pageW, y: s.gy };
      s.grabZ = 0;
      this.#draw(s);
      if (completed) this.view.commitTurn(s.turn); else this.view.revertTurn(s.turn);
      this.canvas.classList.add('fading');
      this.fadeTimer = setTimeout(() => this.#hide(), FADE_MS);
    }
    if (completed) this.onTurned(s.turn);
    // Carry on with the turns that were clicked in the meantime — once this
    // frame is done, so the new sheet starts its own animation loop.
    if (!this.jump && this.queue.length) Promise.resolve().then(() => this.#runQueue());
  }

  /**
   * Go to a spread anywhere in the book the way one leafs through a book:
   * a run of sheets is flicked over in quick succession — several in the air
   * at once, more of them the further away the target is, and for as long as
   * its pages are still being rendered — and a last sheet turns over and
   * settles softly on the target spread.
   * @returns {boolean} false if the jump cannot be animated (the caller
   *   should then just show the spread)
   */
  jumpTo(target) {
    const view = this.view;
    if (!this.enabled || !view.model.hasSpread(target)) return false;
    this.queue.length = 0;
    this.jump = null;
    if (this.session) this.#end(this.session.outcome === 'complete' && !!this.session.landing, true);
    if (target === view.index) return true;

    const { riffleNear, riffleFar, riffleCounts } = CONFIG.flip;
    const distance = Math.abs(target - view.index);
    const dir = target > view.index ? 'next' : 'prev';
    // The flicked sheets carry the pages that are showing now. None out of the
    // closed book (its cover opens straight onto the target) or to a neighbour.
    const fan = view.isClosed || distance <= 1 ? null : view.prepareRiffle(dir);
    const now = performance.now();
    const jump = {
      target,
      dir,
      side: dir === 'next' ? -1 : 1,
      started: now,
      m: view.metrics(),
      fan: !!fan,
      /** @type {{start: number, end: number, gy: number, arc: number, profile: Float32Array, curl: object|null}[]} */
      sheets: [],
      spawned: 0,
      min: fan ? riffleCounts[distance <= riffleNear ? 0 : distance <= riffleFar ? 1 : 2] : 0,
      nextSpawn: now,
      ready: !!view.prepareJump(target),
      finalStarted: false
    };
    this.jump = jump;
    view.source.hold(true);
    view.whenSpreadReady(target).then(() => {
      jump.ready = true;
    }, () => {
      if (this.jump === jump) this.jump = null;
    });

    if (fan) {
      this.renderer.resize(window.innerWidth, window.innerHeight, view.dpr);
      this.renderer.setSheet(fan.frontCanvas, fan.backCanvas, 'fan');
      clearTimeout(this.fadeTimer);
      this.canvas.classList.remove('fading');
      this.canvas.classList.add('active');
    }
    this.lastTime = now;
    this.#cancelFrame();
    this.#requestFrame();
    return true;
  }

  /** Spawn and retire the sheets of a jump; start its final turn when it is time. */
  #stepJump(now) {
    const jump = this.jump;
    const { riffleMs, riffleGapMs, riffleMax } = CONFIG.flip;
    jump.sheets = jump.sheets.filter((sheet) => now < sheet.end);

    if (jump.finalStarted) {
      // The final sheet is an ordinary session; the jump is over once the
      // last flicked sheet has come down.
      if (!jump.sheets.length) this.jump = null;
      return;
    }
    if (now < jump.nextSpawn) return;

    if (jump.ready && jump.spawned >= jump.min) {
      const final = this.view.prepareJump(jump.target);
      if (!final) {
        this.jump = null;
        return;
      }
      jump.finalStarted = true;
      const s = this.#begin(jump.dir, jump.m.pageH * 0.5, 'auto', final);
      if (!s) {
        this.jump = null;
        return;
      }
      this.#startAuto(s);
      // The whole jump is to be over within jumpMaxMs. If the leafing (or the
      // rendering of the target) has used up much of that, the last sheet
      // turns faster to still land in time.
      const { jumpMaxMs, jumpLandSpeed, jumpLandSpeedMax, autoDuration } = CONFIG.flip;
      const left = jump.started + jumpMaxMs - now;
      const unhurried = autoDuration + 560; // a turn plus its soft landing, at speed 1
      s.speed = clamp(unhurried / Math.max(left, 1), jumpLandSpeed, jumpLandSpeedMax);
      return;
    }

    if (jump.fan && jump.spawned < riffleMax) {
      // No two sheets alike: held at different heights, lifted more or less
      // on the skew, a little faster or slower.
      const { pageW, pageH } = jump.m;
      const duration = riffleMs * (0.85 + Math.random() * 0.3);
      const gy = pageH * (0.2 + Math.random() * 0.6);
      jump.sheets.push({
        start: now,
        end: now + duration,
        gy,
        arc: (gy > pageH / 2 ? -1 : 1) * pageW * (0.04 + Math.random() * 0.2),
        profile: new Float32Array(PROFILE_SAMPLES * 3),
        curl: null
      });
      jump.spawned++;
      jump.nextSpawn = now + riffleGapMs;
    }
  }

  /** Where each flicked sheet is right now. */
  #fanFrames(now) {
    const jump = this.jump;
    if (!jump) return [];
    const { pageW, pageH } = jump.m;
    const { spineX, top } = this.view.metrics();
    const cameraZ = pageW * CONFIG.flip.cameraHeight;
    return jump.sheets.map((sheet) => {
      const u = clamp((now - sheet.start) / (sheet.end - sheet.start), 0, 1);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * u);
      const curl = solveCurl({
        W: pageW,
        H: pageH,
        gy: sheet.gy,
        px: pageW - 2 * pageW * ease,
        py: sheet.gy + sheet.arc * Math.sin(Math.PI * u) ** 2,
        tuning: CONFIG.flip.curl,
        profile: sheet.profile
      });
      return { side: jump.side, spineX, top, pageW, pageH, cameraZ, curl, board: null, set: 'fan' };
    });
  }

  #runQueue() {
    if (this.session || this.starting || this.jump || !this.queue.length) return;
    this.turn(this.queue.shift(), true);
  }

  /** Drop any sheet in the air immediately (used on resize / jumps). */
  abort() {
    this.queue.length = 0;
    this.jump = null;
    this.#end(false, true);
    this.#hide();
    this.renderer.invalidateSheet();
  }

  #startAuto(s) {
    const { pageW: W, pageH: H } = s.m;
    // Lift towards the middle of the page so the nearer corner rises first.
    const towardsCentre = s.gy > H / 2 ? -1 : 1;
    s.mode = 'auto';
    s.outcome = 'complete';
    s.landing = null;
    s.lastTheta = null;
    s.auto = {
      t: 0,
      from: { ...s.pos },
      to: { x: -W, y: s.gy },
      arc: towardsCentre * W * (0.1 + 0.16 * Math.abs((2 * s.gy) / H - 1))
    };
  }

  /**
   * A sheet that is only floating down its last few degrees does not hold up
   * the next turn: it is put down at once so quick page-flipping stays quick.
   */
  #skipTail() {
    const s = this.session;
    if (!s || !s.landing) return;
    const goal = s.outcome === 'complete' ? Math.PI : 0;
    if (Math.abs(goal - s.landing.theta) < 0.14) this.#end(s.outcome === 'complete', true);
  }

  /**
   * Turn a leaf by itself (keyboard, buttons, programmatic).
   *
   * Asked for again while a sheet is still in the air, the turn is queued:
   * every click counts, and the sheets hurry up for as long as more are
   * waiting (see #step), so quick clicking pages through quickly.
   * @param {'next'|'prev'} dir
   * @param {boolean} [queued] internal: this turn comes out of the queue
   */
  async turn(dir, queued = false) {
    if (!this.enabled) return;
    this.#skipTail();
    if (this.busy || this.starting) {
      const last = this.queue[this.queue.length - 1];
      // A click the other way takes back a waiting turn instead of adding one.
      if (last && last !== dir) this.queue.pop();
      else if (this.queue.length < CONFIG.flip.maxQueued) this.queue.push(dir);
      return;
    }
    if (this.session && this.session.turn.dir !== dir) this.#end(false, true);
    if (!this.session) {
      if (!this.view.model.turn(this.view.index, dir)) {
        this.queue.length = 0;
        this.onBlocked(dir);
        return;
      }
      if (!this.view.prepareTurn(dir)) {
        // The pages are still being rendered; clicks meanwhile are queued.
        this.starting = true;
        try {
          await this.view.whenTurnReady(dir);
        } finally {
          this.starting = false;
        }
        if (this.session || !this.enabled) return;
      }
      const m = this.view.metrics();
      // Taken by the middle of its outer edge.
      if (!this.#begin(dir, m.pageH * 0.5, 'auto')) return;
    }
    this.#startAuto(this.session);
    // The last of a quick series still moves a little faster than a single turn.
    if (queued) this.session.speed = CONFIG.flip.queuedSpeed;
  }

  // ---- pointer input ----------------------------------------------------

  #onPointerDown(e) {
    if (!this.enabled || e.button !== 0) return;
    if (this.#hitZone(e.clientX, e.clientY, e.pointerType)) this.#skipTail();
    if (this.busy) return;
    const dir = this.#hitZone(e.clientX, e.clientY, e.pointerType);
    if (!dir) return;

    let s = this.session;
    if (s && s.turn.dir !== dir) {
      this.#end(false, true);
      s = null;
    }
    if (!s) {
      const m = this.view.metrics();
      s = this.#begin(dir, e.clientY - m.top, 'drag');
      if (!s) {
        if (!this.view.model.turn(this.view.index, dir)) this.onBlocked(dir);
        return;
      }
    }
    s.mode = 'drag';
    s.pointerId = e.pointerId;
    s.down = { x: e.clientX, y: e.clientY, time: performance.now(), moved: 0, target: e.target };
    s.target = this.#toPage(s, e.clientX, e.clientY);
    s.lastMove = { x: s.target.x, y: s.target.y, time: performance.now() };
    s.pointerVel = { x: 0, y: 0 };
    if (e.pointerType !== 'touch') e.preventDefault();
  }

  #onPointerMove(e) {
    const s = this.session;

    if (s && s.mode === 'drag') {
      if (e.pointerId !== s.pointerId) return;
      const p = this.#toPage(s, e.clientX, e.clientY);
      const now = performance.now();
      const dt = Math.max(1, now - s.lastMove.time) / 1000;
      const k = 0.35;
      s.pointerVel.x += ((p.x - s.lastMove.x) / dt - s.pointerVel.x) * k;
      s.pointerVel.y += ((p.y - s.lastMove.y) / dt - s.pointerVel.y) * k;
      s.lastMove = { x: p.x, y: p.y, time: now };
      s.down.moved = Math.max(s.down.moved, Math.hypot(e.clientX - s.down.x, e.clientY - s.down.y));
      s.target = p;
      return;
    }

    // Hover peek (mouse / pen only — touch has no hover).
    if (!this.enabled || this.jump || e.pointerType === 'touch' || e.buttons !== 0) return;
    if (s && s.mode !== 'peek') return;
    const dir = this.#hitZone(e.clientX, e.clientY, e.pointerType);

    if (s) {
      if (dir === s.turn.dir) {
        s.gy = clamp(e.clientY - s.m.top, 0, s.m.pageH);
        s.target = this.#peekTarget(s, s.gy);
      } else {
        // Let the edge drop back like a released page.
        s.vel = { x: 0, y: 0 };
        this.#release(s, false);
      }
      return;
    }
    // A stiff cover does not flutter up under the pointer like a page does.
    if (dir && !this.#isCoverTurn(dir)) {
      const m = this.view.metrics();
      const started = this.#begin(dir, e.clientY - m.top, 'peek');
      if (started) started.target = this.#peekTarget(started, started.gy);
    }
  }

  #onPointerUp(e, cancelled = false) {
    const s = this.session;
    if (!s || s.mode !== 'drag' || e.pointerId !== s.pointerId) return;
    const { pageW: W } = s.m;
    const held = performance.now() - s.down.time;
    const isClick = !cancelled && s.down.moved < 6 && held < 450;

    if (isClick) {
      const onHotspot = s.down.target instanceof Element && s.down.target.closest('.hotspot');
      if (onHotspot) {
        this.#release(s, false);
      } else {
        this.#startAuto(s);
      }
      return;
    }

    this.suppressClick = s.down.moved >= 6;
    setTimeout(() => { this.suppressClick = false; }, 0);

    const flick = CONFIG.flip.flickSpeed * W;
    // If the pointer stopped before release there is no flick.
    const stale = performance.now() - s.lastMove.time > 90;
    const vx = stale ? 0 : s.pointerVel.x;
    let complete = s.pos.x < 0; // past the spine = more than half way
    if (vx < -flick) complete = true;
    if (vx > flick) complete = false;
    if (cancelled) complete = false;

    s.vel = stale ? { x: 0, y: 0 } : {
      x: clamp(s.pointerVel.x, -6 * W, 6 * W),
      y: clamp(s.pointerVel.y, -6 * W, 6 * W)
    };
    this.#release(s, complete);
  }

  #release(s, complete) {
    s.mode = 'settle';
    s.landing = null;
    s.lastTheta = null;
    s.outcome = complete ? 'complete' : 'cancel';
    s.target = complete ? { x: -s.m.pageW, y: s.gy } : { x: s.m.pageW, y: s.gy };
  }

  // ---- animation --------------------------------------------------------

  /** Ask for the next animation step (at most one is ever pending). */
  #requestFrame() {
    this.#cancelFrame();
    this.raf = requestAnimationFrame((t) => this.#tick(t));
  }

  #cancelFrame() {
    cancelAnimationFrame(this.raf);
  }

  #tick(time) {
    if (!this.session && !this.jump) {
      if (!this.canvas.classList.contains('fading')) this.#hide();
      return;
    }
    // While the page is not being shown, frame callbacks arrive as fast as
    // they can be delivered (see pdf-source.js). Do nothing until a frame's
    // worth of time has passed, so the page rendering gets the processor.
    if (time - this.lastTime < 12) {
      this.#requestFrame();
      return;
    }
    // Real elapsed time, so a turn takes as long as it should even when
    // frames come slowly; a long gap is taken in small steps to keep the
    // springs steady.
    const dt = clamp((time - this.lastTime) / 1000, 0.001, 0.25);
    this.lastTime = time;
    if (this.jump) this.#stepJump(performance.now());
    const steps = Math.ceil(dt / (1 / 60));
    for (let i = 0; i < steps && this.session; i++) this.#step(dt / steps);
    if (!this.session && !this.jump) return;
    this.#draw();
    // One loop only — starting a session from within this tick asked for a frame too.
    this.#cancelFrame();
    this.#requestFrame();
  }

  /**
   * Run the animation forward without waiting for display frames
   * (automated tests, tooling). Normal playback is driven by #tick.
   */
  advance(ms) {
    for (let t = 0; t < ms && this.session; t += 1000 / 60) this.#step(1 / 60);
    if (this.session) this.#draw();
  }

  /** Move the session forward by dt seconds; ends it when it has landed. */
  #step(dt) {
    const s = this.session;
    const W = s.m.pageW;
    let arrived = false;

    if (s.mode === 'auto' || s.mode === 'settle') {
      // More turns waiting: this one hurries, the more the longer the queue.
      const { hurrySpeed, hurryPerQueued, hurryMax } = CONFIG.flip;
      const waiting = this.queue.length;
      const speed = waiting
        ? Math.min(hurryMax, hurrySpeed + hurryPerQueued * (waiting - 1))
        : s.speed || 1;
      dt *= speed;
    }

    if (s.mode === 'drag' || s.mode === 'peek') {
      const rate = s.mode === 'drag' ? CONFIG.flip.followRate : 13;
      const k = 1 - Math.exp(-rate * dt);
      s.pos.x += (s.target.x - s.pos.x) * k;
      s.pos.y += (s.target.y - s.pos.y) * k;
      return;
    }

    if (s.mode === 'settle' && s.landing && s.outcome === 'cancel') {
      // Falling back: the fold stays where it is, only the angle closes.
    } else if (s.mode === 'settle') {
      // Critically damped spring: no overshoot, keeps the release velocity.
      const w = CONFIG.flip.settleRate;
      for (const axis of ['x', 'y']) {
        const a = w * w * (s.target[axis] - s.pos[axis]) - 2 * w * s.vel[axis];
        s.vel[axis] += a * dt;
        s.pos[axis] += s.vel[axis] * dt;
      }
      s.pos.x = clamp(s.pos.x, -W, W);
      const dist = Math.hypot(s.target.x - s.pos.x, s.target.y - s.pos.y);
      if (dist < 1.2 && Math.hypot(s.vel.x, s.vel.y) < 40) arrived = true;
    } else if (s.mode === 'auto') {
      const a = s.auto;
      const duration = CONFIG.flip.autoDuration * (s.cover ? CONFIG.flip.coverSlowdown : 1);
      a.t = Math.min(1, a.t + (dt * 1000) / duration);
      // The heavy cover starts gently; a page is flicked.
      const t = s.cover ? a.t * a.t * (3 - 2 * a.t) : a.t;
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
      const arc = Math.sin(Math.PI * t) ** 2;
      s.pos.x = a.from.x + (a.to.x - a.from.x) * ease;
      s.pos.y = a.from.y + (a.to.y - a.from.y) * ease + a.arc * arc;
      if (a.t >= 1) arrived = true;
    }

    this.#land(s, dt, arrived);
  }

  /**
   * The last part of a turn. The position of the page edge changes very
   * little while the sheet closes its final degrees, so a sheet that only
   * follows a position slaps down and stops dead. Instead, once it is within
   * LAND_ANGLE of lying flat, a critically damped spring takes over the bend
   * angle itself — it carries on at the speed the sheet arrived with and
   * slows down smoothly until the sheet rests on the page.
   */
  #land(s, dt, arrived) {
    const goal = s.outcome === 'complete' ? Math.PI : 0;
    const w = CONFIG.flip.landRate;

    if (!s.landing) {
      const theta = this.#solve(s).thetaMax;
      const speed = s.lastTheta == null ? 0 : (theta - s.lastTheta) / dt;
      s.lastTheta = theta;
      const rest = goal - theta;
      if (Math.abs(rest) > LAND_ANGLE && !arrived) return;
      // Keep the approach speed, but never so much that the spring overshoots.
      const dir = rest < 0 ? -1 : 1;
      s.landing = { theta, vel: dir * clamp(speed * dir, 0, w * Math.abs(rest) * 0.9) };
      return;
    }

    const l = s.landing;
    l.vel += (w * w * (goal - l.theta) - 2 * w * l.vel) * dt;
    l.theta = clamp(l.theta + l.vel * dt, 0, Math.PI);
    const rest = Math.abs(goal - l.theta);
    // With more turns waiting the sheet does not float down its last degrees.
    // A sheet that is only flicked past is gone before it has quite landed.
    if (s.riffle) {
      if (rest < 0.5) this.#end(true, true);
      return;
    }
    if (this.queue.length ? rest < 0.16 : rest < 0.004 && Math.abs(l.vel) < 0.1) {
      this.#end(s.outcome === 'complete', this.queue.length > 0);
    }
  }

  /** Shape of the sheet for the session's current state. */
  #solve(s) {
    if (s.cover) return this.#solveBoard(s);
    const { pageW, pageH } = s.m;
    const cameraZ = pageW * CONFIG.flip.cameraHeight;
    // s.pos is where the grabbed point should *appear*. A raised point looks
    // further from the middle of the book than it is, so pull the target in
    // by the perspective factor at its height (two passes converge closely).
    let curl;
    let grabZ = s.grabZ || 0;
    for (let pass = 0; pass < 2; pass++) {
      const k = 1 - grabZ / cameraZ;
      curl = solveCurl({
        W: pageW,
        H: pageH,
        gy: s.gy,
        px: Math.min(s.pos.x * k, pageW),
        py: pageH / 2 + (s.pos.y - pageH / 2) * k,
        tuning: CONFIG.flip.curl,
        profile: this.profile,
        theta: s.landing ? s.landing.theta : undefined
      });
      grabZ = curl.grabZ;
    }
    s.grabZ = grabZ;
    return curl;
  }

  /**
   * The cover is a stiff board hinged at the spine: no bending, just the
   * opening angle, taken from how far across the grabbed edge has come.
   */
  #solveBoard(s) {
    const W = s.m.pageW;
    const theta = s.landing ? s.landing.theta : Math.acos(clamp(s.pos.x / W, -1, 1));
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const out = this.profile;
    for (let i = 0; i < PROFILE_SAMPLES; i++) {
      const u = i / (PROFILE_SAMPLES - 1);
      out[i * 3] = u * cos;
      out[i * 3 + 1] = u * sin;
      out[i * 3 + 2] = theta;
    }
    s.grabZ = W * sin;
    return {
      nx: 1, ny: 0, l0: 0, D: W * this.view.board.scale,
      thetaMax: theta, progress: theta / Math.PI, grabZ: s.grabZ, profile: out
    };
  }

  #draw(s = this.session) {
    const frames = this.#fanFrames(performance.now());
    if (s) frames.push(this.#sessionFrame(s));
    if (frames.length) this.renderer.draw(frames);
    else if (this.jump && this.jump.fan) this.renderer.clear();
  }

  #sessionFrame(s) {
    const { pageW, pageH } = s.m;
    const cameraZ = pageW * CONFIG.flip.cameraHeight;
    const curl = this.#solve(s);
    if (s.cover) {
      // The book slides between its closed (centred cover) and open position
      // in step with the cover, so the sheet has to follow where it is now.
      const t = curl.thetaMax / Math.PI;
      const eased = t * t * (3 - 2 * t);
      this.view.setCoverPose(s.cover, this.#opens(s) ? eased : 1 - eased);
      const now = this.view.metrics();
      s.m.spineX = now.spineX;
      s.m.top = now.top;
    }
    // The book may be sliding (one-page mode): follow it.
    if (!s.cover) {
      const now = this.view.metrics();
      s.m.spineX = now.spineX;
      s.m.top = now.top;
    }
    const { spineX, top } = s.m;
    return {
      side: s.side,
      spineX,
      top,
      pageW,
      pageH,
      cameraZ,
      curl,
      board: s.cover
        // Closing, the face that starts up is the inside of the board.
        ? { scale: this.view.board.scale, thickness: this.view.board.thickness, upInset: !this.#opens(s) }
        : null
    };
  }
}
