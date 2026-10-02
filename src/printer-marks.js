// Leaves out the printer's crop marks when a PDF page is drawn.
//
// The PDF file is not changed and nothing is painted over: the marks are
// simply never drawn. In these files they are short straight lines (a white
// outline first, then the black line) stroked at the very end of each page,
// lying entirely in the margin outside the TrimBox — the area a print shop
// cuts away. Artwork that bleeds into that margin is left exactly as it is.
//
// How: the canvas context PDF.js draws into is watched. A stroke is skipped
// only if its path consists of nothing but straight line segments that each
// continue an edge of the trim box out into the margin, beyond the corner —
// which is what a crop mark is. Everything else is passed through untouched,
// including other artwork in the margin.

const MAX_SEGMENTS = 32;

/**
 * @param {CanvasRenderingContext2D} ctx   context handed to PDF.js
 * @param {{left: number, top: number, right: number, bottom: number}} trim
 *   the trim box in canvas pixels
 * @param {number} scale canvas pixels per PDF point
 * @returns {{skipped: number}} live counter of strokes that were left out
 */
export function hidePrinterMarks(ctx, trim, scale) {
  // How exactly a line has to follow a trim edge: 0.4 pt, whatever the size
  // the page is drawn at.
  const tolerance = 0.4 * scale;
  const stats = { skipped: 0 };
  let onlyLines = true;
  let segments = [];
  let last = null;
  let matrix = null;

  const native = {};
  const wrap = (name, before) => {
    native[name] = ctx[name];
    ctx[name] = function (...args) {
      before(args);
      return native[name].apply(this, args);
    };
  };

  wrap('beginPath', () => {
    onlyLines = true;
    segments = [];
    last = null;
    matrix = null;
  });
  wrap('moveTo', ([x, y]) => {
    last = [x, y];
  });
  wrap('lineTo', ([x, y]) => {
    if (!last || segments.length >= MAX_SEGMENTS) {
      onlyLines = false;
    } else {
      // The transform in force while the path is built decides where it
      // lands; PDF.js may rescale the context afterwards to stroke thin lines.
      if (!matrix) matrix = ctx.getTransform();
      segments.push([last[0], last[1], x, y]);
    }
    last = [x, y];
  });
  for (const name of ['bezierCurveTo', 'quadraticCurveTo', 'rect', 'roundRect', 'arc', 'arcTo', 'ellipse', 'closePath']) {
    if (typeof ctx[name] === 'function') wrap(name, () => { onlyLines = false; });
  }

  const outsideTrim = () => {
    const m = matrix;
    return segments.every(([x0, y0, x1, y1]) => {
      const ax = m.a * x0 + m.c * y0 + m.e;
      const ay = m.b * x0 + m.d * y0 + m.f;
      const bx = m.a * x1 + m.c * y1 + m.e;
      const by = m.b * x1 + m.d * y1 + m.f;
      // A crop mark continues one edge of the trim box out into the margin:
      // it lies on the line of that edge, and beyond the corner.
      const near = (v, edge) => Math.abs(v - edge) < tolerance;
      if (Math.abs(ay - by) < tolerance) {
        const beside = Math.max(ax, bx) <= trim.left + tolerance || Math.min(ax, bx) >= trim.right - tolerance;
        return beside && (near(ay, trim.top) || near(ay, trim.bottom));
      }
      if (Math.abs(ax - bx) < tolerance) {
        const beyond = Math.max(ay, by) <= trim.top + tolerance || Math.min(ay, by) >= trim.bottom - tolerance;
        return beyond && (near(ax, trim.left) || near(ax, trim.right));
      }
      return false;
    });
  };

  native.stroke = ctx.stroke;
  ctx.stroke = function (...args) {
    // stroke(path2d) draws a separate path object — never one of the marks here.
    if (args.length === 0 && onlyLines && segments.length > 0 && outsideTrim()) {
      stats.skipped++;
      return undefined;
    }
    return native.stroke.apply(this, args);
  };

  return stats;
}
