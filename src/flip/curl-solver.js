// Page-curl geometry. Pure math, no DOM / WebGL — runs in Node for testing.
//
// Canonical page space (the renderer mirrors it for the left-hand page):
//   x: 0 at the spine  ->  W at the outer edge
//   y: 0 at the top    ->  H at the bottom
//   z: height above the book, towards the viewer
//
// The sheet is modelled as an inextensible developable surface: everything on
// the spine side of a straight "fold line" stays flat on the book, everything
// beyond it bends upward. The bend angle grows along the distance from the fold
// line following a soft profile, until it reaches thetaMax, after which the
// rest of the sheet continues straight. thetaMax = 0 is a page lying flat,
// PI/2 a page standing up, PI a page lying flat on the opposite side.
//
// The fold line is always pushed as far towards the spine as the binding
// allows, which makes it pivot around the top or bottom of the spine when the
// page is pulled diagonally — so a corner lifts first and the rest follows.

export const PROFILE_SAMPLES = 33;
const INTEGRATION_STEPS = 96;

/**
 * @typedef {Object} CurlTuning
 * @property {number} bow    How much of the sheet is curved mid-turn (0..1).
 * @property {number} bowExp Shapes how quickly the bow builds up / dies out.
 * @property {number} minCurl Curved share a folded-back sheet always keeps
 *   (0..1), so it stays a soft roll instead of a flat crease. It only fades
 *   out when the whole page is about to land on the other side.
 */

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Fraction of the sheet (from the fold line) that is still bending.
 * `floor` is the share that must stay curved once the sheet folds back.
 */
function curvedFraction(thetaMax, tuning, floor) {
  const bow = tuning.bow * Math.pow(Math.max(0, Math.sin(thetaMax)), tuning.bowExp);
  return Math.max(bow, floor * smoothstep(0.3 * Math.PI, 0.7 * Math.PI, thetaMax));
}

/** Bend angle at normalised distance u (0..1) from the fold line. */
function angleAt(u, thetaMax, c) {
  if (c < 1e-5 || u >= c) return thetaMax;
  const t = 1 - u / c;
  return thetaMax * (1 - t * t);
}

/** Horizontal reach of the sheet at normalised distance uEnd. */
function reach(uEnd, thetaMax, tuning, floor) {
  const c = curvedFraction(thetaMax, tuning, floor);
  const du = uEnd / INTEGRATION_STEPS;
  let x = 0;
  for (let i = 0; i < INTEGRATION_STEPS; i++) {
    x += Math.cos(angleAt((i + 0.5) * du, thetaMax, c)) * du;
  }
  return x;
}

/** Keeps `p` inside the disc around the spine end (0, sy) that `g` lies on. */
function clampToDisc(p, g, sy) {
  const r = Math.hypot(g.x, g.y - sy);
  const dx = p.x;
  const dy = p.y - sy;
  const d = Math.hypot(dx, dy);
  if (d > r && d > 0) {
    p.x = (dx / d) * r;
    p.y = sy + (dy / d) * r;
  }
}

/**
 * Solve the sheet shape so the grabbed point lands under the pointer.
 *
 * @param {Object} o
 * @param {number} o.W  page width
 * @param {number} o.H  page height
 * @param {number} o.gy y of the grabbed point on the outer edge (x is W)
 * @param {number} o.px pointer x in canonical page space
 * @param {number} o.py pointer y in canonical page space
 * @param {CurlTuning} o.tuning
 * @param {Float32Array} [o.profile] reused output buffer (PROFILE_SAMPLES * 3)
 * @param {number} [o.theta] use this bend angle instead of solving it from the
 *   pointer (the pointer then only sets the direction of the fold). Used for
 *   the last part of a turn, where the sheet settles by its angle.
 */
export function solveCurl({ W, H, gy, px, py, tuning, profile, theta }) {
  const out = profile || new Float32Array(PROFILE_SAMPLES * 3);
  const g = { x: W, y: gy };
  const p = { x: px, y: py };

  // Paper cannot stretch: the grabbed point can never be further from either
  // end of the spine than it is when the page lies flat.
  for (let i = 0; i < 4; i++) {
    clampToDisc(p, g, 0);
    clampToDisc(p, g, H);
  }

  let vx = g.x - p.x;
  let vy = g.y - p.y;
  const disp = Math.hypot(vx, vy);

  const result = {
    nx: 1, ny: 0, l0: 0, D: W, thetaMax: 0, progress: 0, grabZ: 0,
    px: p.x, py: p.y, profile: out
  };

  if (disp < 1e-4 || vx <= 0) {
    writeProfile(out, 0, tuning, 0);
    return result;
  }

  const nx = vx / disp;
  const ny = vy / disp;

  // Fold line: dot(pos, n) = l0. Both spine ends must stay on the flat side.
  const l0 = Math.max(0, ny * H);
  const gCoord = nx * g.x + ny * g.y;
  const dG = gCoord - l0;
  // Farthest point of the page beyond the fold line (always one of the two
  // outer corners because nx > 0).
  const D = Math.max(nx * W, nx * W + ny * H) - l0;
  if (dG <= 1e-6 || D <= 1e-6) {
    writeProfile(out, 0, tuning, 0);
    return result;
  }

  // A page pressed back onto the book must not become a flat, creased
  // triangle: keep it rolled. Only when the fold runs along the spine — the
  // whole page is going over — may it flatten out completely.
  const landing = smoothstep(0.86, 1, dG / W);
  const floor = (tuning.minCurl || 0) * (1 - landing);

  const uG = dG / D;
  const target = (dG - Math.min(disp, 2 * dG)) / D;

  let thetaMax = theta;
  if (thetaMax == null) {
    // reach() falls monotonically from uG (flat) to -uG (turned over).
    let lo = 0;
    let hi = Math.PI;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      if (reach(uG, mid, tuning, floor) > target) lo = mid; else hi = mid;
    }
    thetaMax = (lo + hi) / 2;
  }

  writeProfile(out, thetaMax, tuning, floor);
  // Height of the grabbed point, so the caller can correct for perspective.
  const f = uG * (PROFILE_SAMPLES - 1);
  const i = Math.min(PROFILE_SAMPLES - 2, Math.floor(f));
  result.grabZ = (out[i * 3 + 1] + (out[i * 3 + 4] - out[i * 3 + 1]) * (f - i)) * D;
  result.nx = nx;
  result.ny = ny;
  result.l0 = l0;
  result.D = D;
  result.thetaMax = thetaMax;
  result.progress = thetaMax / Math.PI;
  return result;
}

/** Tabulates (x, z, angle) along the sheet, normalised by its length. */
function writeProfile(out, thetaMax, tuning, floor) {
  const c = curvedFraction(thetaMax, tuning, floor);
  const segments = PROFILE_SAMPLES - 1;
  const sub = 4;
  const du = 1 / (segments * sub);
  let x = 0;
  let z = 0;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let i = 1; i <= segments; i++) {
    for (let s = 0; s < sub; s++) {
      const a = angleAt(((i - 1) * sub + s + 0.5) * du, thetaMax, c);
      x += Math.cos(a) * du;
      z += Math.sin(a) * du;
    }
    out[i * 3] = x;
    out[i * 3 + 1] = z;
    out[i * 3 + 2] = angleAt(i / segments, thetaMax, c);
  }
}
