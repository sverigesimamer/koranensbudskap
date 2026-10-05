// Builds data/regions/juz-N.json: where every verse lies on its page(s), both
// in the Arabic text and in the translation. Nothing is read by eye — the
// positions come out of the PDF files themselves:
//
//   Arabic       The text is drawn on a grid of 15 lines. Every verse ends
//                with a blue rosette; a verse is everything from the rosette
//                before it (reading right to left, top to bottom) up to and
//                including its own. Lines with a sura heading or the basmala
//                are left out.
//   Translation  The text layer gives every word's position; a verse runs
//                from its number ("17.") to the next number.
//
// Run:  node tools/build-regions.mjs            (all 30 files, ~10 minutes)
//       node tools/build-regions.mjs 1 3        (only JUZ1..JUZ3, for testing;
//                                                verse numbering then starts
//                                                wherever JUZ1 starts)
//
// The PDF files are only read.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SURAH_DATA } from '../data/quran-data.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lib = pathToFileURL(`${ROOT}vendor/pdfjs/pdf.min.mjs`).href;
const pdfjs = await import(lib);
pdfjs.GlobalWorkerOptions.workerSrc = lib.replace('pdf.min.mjs', 'pdf.worker.min.mjs');
const OPS = pdfjs.OPS;

const AYAHS = SURAH_DATA.map(([, ayahs]) => ayahs);
const PAGE_W = 461.528;
const PAGE_H = 637.276;

// Fill colours (as the PDFs set them) of the verse-end rosettes and the text.
const MARK = '26,116,191';
const INK = '44,46,53';
// The grid of Arabic lines: centre of the first line, and the line pitch (PDF points, y up).
const LINE_TOP = 565.8;
const LINE_PITCH = 24.77;
const LINES = 15;
// The shape found for a rosette is only its centre; the ornament around the
// verse number reaches this far to each side of it (PDF points).
const ROSETTE_RADIUS = 8.5;

const firstJuz = Number(process.argv[2] || 1);
const lastJuz = Number(process.argv[3] || 30);

// --------------------------------------------------------------------------
// Filled shapes of a page: fill colour and bounding box (PDF points, y up).
// --------------------------------------------------------------------------
/** [minX, minY, maxX, maxY] of a constructPath's points, or null. */
function pathBox(ops, coords) {
  if (!ops || !coords) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  let j = 0;
  for (const op of ops) {
    if (op === OPS.moveTo || op === OPS.lineTo) { add(coords[j], coords[j + 1]); j += 2; }
    else if (op === OPS.curveTo) { for (let k = 0; k < 6; k += 2) add(coords[j + k], coords[j + k + 1]); j += 6; }
    else if (op === OPS.curveTo2 || op === OPS.curveTo3) { add(coords[j], coords[j + 1]); add(coords[j + 2], coords[j + 3]); j += 4; }
    else if (op === OPS.rectangle) { add(coords[j], coords[j + 1]); add(coords[j] + coords[j + 2], coords[j + 1] + coords[j + 3]); j += 4; }
  }
  return minX <= maxX ? [minX, minY, maxX, maxY] : null;
}

async function shapesOfPage(page) {
  const ops = await page.getOperatorList();
  const stack = [];
  let m = [1, 0, 0, 1, 0, 0];
  let fill = '0,0,0';
  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ];
  const shapes = [];
  let pending = null;
  // The clip region (as a box). The Arabic text is drawn once per line, each
  // copy clipped to its line; only what the clip lets through is on the page.
  let clip = [-Infinity, -Infinity, Infinity, Infinity];
  let clipping = false;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push([m, fill, clip]);
    else if (fn === OPS.restore) { if (stack.length) [m, fill, clip] = stack.pop(); }
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([m, fill, clip]); if (args && args[0]) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) [m, fill, clip] = stack.pop(); }
    else if (fn === OPS.clip || fn === OPS.eoClip) clipping = true;
    else if (fn === OPS.setFillRGBColor) fill = `${args[0]},${args[1]},${args[2]}`;
    else if (fn === OPS.constructPath) {
      // The box PDF.js gives along can be far too small (a single point for
      // an outline made of curves alone), so for the text take it from the
      // path's own points (curve control points included: a little
      // generous, never too small).
      // (Only for the text: the rosette's position is taken, as it always
      // was, from the box PDF.js gives.)
      const mm = (fill === INK && pathBox(args[0], args[1])) || args[2];
      if (mm) {
        const xs = [m[0] * mm[0] + m[2] * mm[1] + m[4], m[0] * mm[2] + m[2] * mm[3] + m[4],
          m[0] * mm[0] + m[2] * mm[3] + m[4], m[0] * mm[2] + m[2] * mm[1] + m[4]];
        const ys = [m[1] * mm[0] + m[3] * mm[1] + m[5], m[1] * mm[2] + m[3] * mm[3] + m[5],
          m[1] * mm[0] + m[3] * mm[3] + m[5], m[1] * mm[2] + m[3] * mm[1] + m[5]];
        pending = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }
    } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke) {
      // Rosettes, text — and large white panels (the text panel of the ornamental opening pages).
      const panel = fill === '255,255,255' && pending && pending[2] - pending[0] > 150 && pending[3] - pending[1] > 150;
      if (pending && (fill === MARK || fill === INK || panel)) {
        const box = [Math.max(pending[0], clip[0]), Math.max(pending[1], clip[1]), Math.min(pending[2], clip[2]), Math.min(pending[3], clip[3])];
        // (<=: now and then a rosette comes with a box of no size at all.)
        if (box[0] <= box[2] && box[1] <= box[3]) {
          // A white panel covers what was drawn before it (the ornament
          // pattern under the text panel of the opening pages).
          if (panel) {
            for (let k = shapes.length - 1; k >= 0; k--) {
              const b = shapes[k].box;
              if (b[0] >= box[0] && b[2] <= box[2] && b[1] >= box[1] && b[3] <= box[3]) shapes.splice(k, 1);
            }
          }
          shapes.push({ fill, box });
        }
      }
      pending = null;
      clipping = false;
    } else if (fn === OPS.stroke || fn === OPS.endPath) {
      if (clipping && pending) {
        clip = [Math.max(pending[0], clip[0]), Math.max(pending[1], clip[1]), Math.min(pending[2], clip[2]), Math.min(pending[3], clip[3])];
      }
      pending = null;
      clipping = false;
    }
  }
  return shapes;
}

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const round = (v) => Math.round(v * 10000) / 10000;
/** PDF box (y up) -> [x, y, w, h] as fractions of the page, y from the top. */
const toRect = (x0, y0, x1, y1) => [round(x0 / PAGE_W), round(1 - y1 / PAGE_H), round((x1 - x0) / PAGE_W), round((y1 - y0) / PAGE_H)];

// --------------------------------------------------------------------------
// Arabic: the lines of a page and the rosettes on them.
// --------------------------------------------------------------------------
function arabicLayout(shapes) {
  // A rosette is about 5 pt wide. Now and then its outline comes without a
  // usable size; it is then given the usual one around its position.
  const marks = shapes.filter((s) => s.fill === MARK && s.box[2] - s.box[0] < 9).map((s) => {
    const x = (s.box[0] + s.box[2]) / 2;
    const narrow = s.box[2] - s.box[0] < 2.5;
    return { x0: narrow ? x - 2.5 : s.box[0], x1: narrow ? x + 2.5 : s.box[2], y: (s.box[1] + s.box[3]) / 2 };
  });

  let top = LINE_TOP;
  let pitch = LINE_PITCH;
  let lines = LINES;
  // Pages laid out differently (the two opening pages): take the grid from
  // the rosettes themselves.
  const offGrid = marks.filter((mk) => {
    const i = (top - mk.y) / pitch;
    return Math.abs(i - Math.round(i)) > 0.22 || Math.round(i) < 0 || Math.round(i) >= lines;
  });
  let special = false;
  if (marks.length && offGrid.length > marks.length / 3) {
    special = true;
    const ys = [...new Set(marks.map((mk) => Math.round(mk.y)))].sort((a, b) => b - a);
    const gaps = ys.slice(1).map((y, i) => ys[i] - y).filter((g) => g > 8);
    pitch = gaps.length ? Math.min(...gaps) : LINE_PITCH;
    top = ys[0];
    lines = Math.round((ys[0] - ys[ys.length - 1]) / pitch) + 1;
  }

  const lineOf = (y) => Math.round((top - y) / pitch);
  // The opening pages have an ornament pattern of small squares in the text
  // colour (hidden by the panel and the frame, but still in the drawing). A
  // square that has identical neighbours at a fixed step on its row is
  // pattern, not writing.
  const isPattern = (s, all) => {
    const [x0, y0, x1, y1] = s.box;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 5 || h < 5 || Math.abs(w - h) > 1) return false;
    const twins = all.filter((o) => o !== s && Math.abs(o.box[1] - y0) < 0.3 &&
      Math.abs((o.box[2] - o.box[0]) - w) < 0.2 && Math.abs((o.box[3] - o.box[1]) - h) < 0.2);
    return twins.some((a) => twins.some((b) => a !== b &&
      Math.abs((a.box[0] - x0) + (b.box[0] - x0)) < 0.3 && Math.abs(a.box[0] - x0) > w));
  };
  const inkShapes = shapes.filter((s) => s.fill === INK);
  const squares = inkShapes.filter((s) => s.box[2] - s.box[0] >= 5 && s.box[3] - s.box[1] >= 5);
  const pattern = new Set(squares.filter((s) => isPattern(s, squares)));
  const ink = inkShapes.filter((s) => !pattern.has(s)).map((s) => ({
    x0: s.box[0], x1: s.box[2], y: (s.box[1] + s.box[3]) / 2
  })).filter((s) => {
    const i = (top - s.y) / pitch;
    return i > -0.5 && i < lines - 0.5;
  });

  // Where the text frame is: the typical left and right end of the lines.
  const perLine = Array.from({ length: lines }, () => ({ n: 0, min: Infinity, max: -Infinity, xs: [] }));
  for (const s of ink) {
    const line = perLine[lineOf(s.y)];
    if (!line) continue;
    line.n++;
    line.xs.push(s.x0, s.x1);
  }
  const typical = median(perLine.map((l) => l.n).filter((n) => n > 0)) || 1;
  // Lines of running text. A sura heading and the basmala are a handful of
  // large shapes, far fewer than a line of text has.
  const dense = perLine.map((l) => l.n > typical * 0.1);
  const ends = perLine.filter((l, i) => dense[i]).map((l) => {
    const xs = l.xs.sort((a, b) => a - b);
    // Ignore stray shapes far outside the line (page ornaments).
    return [xs[Math.floor(xs.length * 0.01)], xs[Math.floor(xs.length * 0.99)]];
  });
  let left = ends.length ? median(ends.map((e) => e[0])) : 0;
  let right = ends.length ? median(ends.map((e) => e[1])) : 0;
  if (special && marks.length) {
    // On the ornamental opening pages the ornaments around the text are drawn
    // in the same ink, so the estimate above is off. There the text sits on a
    // white panel: the smallest white panel that holds all the rosettes.
    const panels = shapes.filter((sh) => sh.fill === '255,255,255' &&
      marks.every((mk) => mk.x0 > sh.box[0] && mk.x1 < sh.box[2] && mk.y > sh.box[1] && mk.y < sh.box[3]))
      .sort((a, b) => (a.box[2] - a.box[0]) - (b.box[2] - b.box[0]));
    if (panels.length) {
      left = panels[0].box[0] + 5;
      right = panels[0].box[2] - 5;
    } else {
      const centre = (left + right) / 2;
      left = Math.min(...marks.map((mk) => mk.x0)) - 3;
      right = 2 * centre - left;
    }
  }
  if (!special && marks.length) {
    // Where most lines end with a rosette (the short verses of the last juz)
    // the text itself rarely reaches the frame; the rosettes do.
    left = Math.min(left, ...marks.map((mk) => (mk.x0 + mk.x1) / 2 - ROSETTE_RADIUS));
  }
  for (const s of ink) {
    const line = perLine[lineOf(s.y)];
    if (!line || s.x1 < left - 6 || s.x0 > right + 6) continue;
    line.inside = (line.inside || 0) + 1;
    (line.boxes = line.boxes || []).push([s.x1, s.y, s.x0]);
    line.min = Math.min(line.min, s.x0);
    line.max = Math.max(line.max, s.x1);
  }
  // A line slot that holds something (text, a sura heading, the basmala).
  const occupied = perLine.map((l) => (l.inside || 0) >= 3);

  // Reading order: line by line, right to left. Some pages draw their
  // content twice — a rosette at the same place counts once.
  const ordered = marks.map((mk) => ({ ...mk, line: lineOf(mk.y) }))
    .filter((mk) => mk.line >= 0 && mk.line < lines)
    .sort((a, b) => a.line - b.line || b.x1 - a.x1)
    .filter((mk, i, all) => i === 0 || mk.line !== all[i - 1].line || Math.abs(mk.x0 - all[i - 1].x0) > 2);
  return { top, pitch, lines, left, right, dense, occupied, perLine, marks: ordered, special };
}

// --------------------------------------------------------------------------
// Translation: the lines of the page, column by column.
// --------------------------------------------------------------------------
const isNumber = (str) => /^\d{1,3}\.$/.test(str);

/**
 * The text lines of the translation, grouped into columns (the column beside
 * the Arabic text, and what continues underneath it).
 * @returns {{x: number, lines: {y: number, size: number, x0: number, x1: number, number: number|null}[]}[]}
 */
function translationColumns(content) {
  const items = content.items.filter((it) => it.str.trim()).map((it) => ({
    str: it.str.trim(),
    font: it.fontName,
    size: Math.abs(it.transform[3]),
    x: it.transform[4],
    y: it.transform[5],
    w: it.width
  }));
  // Headings set in the translation column ("I Guds, Den Nåderikes …") use
  // the font of the page heading; they belong to no verse.
  const heading = items.find((it) => it.size > 7.7 && it.size < 8.3 && /SURA/.test(it.str));
  // Body text is 8.5 pt (7.6 pt on the two opening pages); headings and page
  // numbers are smaller or in the heading font.
  const bodySize = (it) => it.size > 7.4 && it.size < 9.3;
  const numberFont = (items.find((it) => bodySize(it) && isNumber(it.str)) || {}).font;
  const text = items.filter((it) => bodySize(it) && !/SURA/.test(it.str) &&
    (isNumber(it.str) || !heading || it.font !== heading.font || it.font === numberFont));

  // Words -> fragments: words on one baseline with only a small gap between
  // them. (Justified lines can have wide gaps, so a line may be several
  // fragments; they are joined again below, once the columns are known.)
  // (Words of one line share their baseline exactly; a neighbouring column's
  // line can be a point or two off.)
  text.sort((a, b) => (Math.abs(a.y - b.y) > 0.8 ? b.y - a.y : a.x - b.x));
  const fragments = [];
  for (const it of text) {
    const frag = fragments.find((f) => Math.abs(f.y - it.y) <= 0.8 && it.x - f.x1 < 9 && it.x >= f.x0 - 2);
    if (frag) {
      frag.x1 = Math.max(frag.x1, it.x + it.w);
      frag.text += ' ' + it.str;
    } else {
      fragments.push({ y: it.y, size: it.size, x0: it.x, x1: it.x + it.w, text: it.str, number: isNumber(it.str) ? Number(it.str.slice(0, -1)) : null });
    }
  }

  // Columns: every line of a column starts at the column's left edge. A left
  // edge is where a verse number stands, or where several fragments start.
  const edges = [];
  for (const f of [...fragments].sort((a, b) => a.x0 - b.x0)) {
    const edge = edges.find((e) => Math.abs(e.x - f.x0) < 2.5);
    if (edge) {
      edge.count++;
      edge.numbered = edge.numbered || f.number !== null;
    } else {
      edges.push({ x: f.x0, count: 1, numbered: f.number !== null });
    }
  }
  const starts = edges.filter((e) => e.numbered || e.count >= 3).map((e) => e.x).sort((a, b) => a - b);
  // Close edges are one column (a hanging number, an indent).
  const columnXs = starts.filter((x, i) => i === 0 || x - starts[i - 1] > 40);
  if (!columnXs.length && fragments.length) columnXs.push(Math.min(...fragments.map((f) => f.x0)));

  // Each fragment belongs to the nearest column edge at or left of it; the
  // fragments of one baseline in one column are one line.
  const columns = columnXs.map((x) => ({ x, lines: [] }));
  for (const f of fragments) {
    let column = columns[0];
    for (const c of columns) if (c.x <= f.x0 + 3) column = c;
    const line = column.lines.find((l) => Math.abs(l.y - f.y) <= 0.8);
    if (line) {
      if (f.x0 < line.x0 && f.number !== null) line.number = f.number;
      line.text = f.x0 < line.x0 ? f.text + ' ' + line.text : line.text + ' ' + f.text;
      line.x0 = Math.min(line.x0, f.x0);
      line.x1 = Math.max(line.x1, f.x1);
    } else {
      column.lines.push({ ...f });
    }
  }
  // The basmala printed as a heading above a sura ("I Guds, Den Nåderikes, /
  // Den Barmhärtiges Namn!") is not part of any verse. (As verse 1:1 it
  // stands after its number, on the number's line.)
  // (Compared by letters only: the PDFs spell å and ä in more than one way.)
  const letters = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z]/g, '').toLowerCase();
  const BASMALA = ['igudsdennaderikes', 'denbarmhartigesnamn', 'igudsdennaderikesdenbarmhartigesnamn'];
  const headingLine = (l) => l.number === null && BASMALA.includes(letters(l.text));
  for (const column of columns) column.lines = column.lines.filter((l) => !headingLine(l));
  const filled = columns.filter((c) => c.lines.length);
  for (const column of filled) column.lines.sort((a, b) => b.y - a.y);
  return filled;
}

/**
 * Put the columns in reading order: the order in which their verse numbers
 * give exactly the verses that start on this page.
 */
function orderColumns(columns, expected) {
  const want = expected.map(([, a]) => a).join(',');
  const numbersOf = (order) => order.flatMap((c) => c.lines.filter((l) => l.number !== null).map((l) => l.number)).join(',');
  const permutations = (list) => (list.length <= 1 ? [list]
    : list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest])));
  if (columns.length <= 5) {
    for (const order of permutations(columns)) if (numbersOf(order) === want) return { order, exact: true };
  }
  // No order fits (a number inside a verse's text, say): tallest column first.
  const height = (c) => c.lines[0].y - c.lines[c.lines.length - 1].y;
  return { order: [...columns].sort((a, b) => height(b) - height(a)), exact: false };
}

/**
 * One box per line, as wide as the line's words reach. Lines that follow on
 * meet halfway between them, so the shade has no gaps and no overlaps.
 */
function lineRects(lines) {
  const boxes = [];
  for (const line of lines) {
    const box = { column: line.column, x0: line.x0, x1: line.x1, y0: line.y - line.size * 0.28, y1: line.y + line.size * 0.9 };
    const last = boxes[boxes.length - 1];
    if (last && last.column === line.column && last.y0 - box.y1 < line.size * 0.6 && last.y0 >= box.y0) {
      last.y0 = box.y1 = (last.y0 + box.y1) / 2;
    }
    boxes.push(box);
  }
  return boxes.map((b) => toRect(b.x0 - 1.5, b.y0, b.x1 + 1.5, b.y1));
}

// --------------------------------------------------------------------------
// Walk through the book.
// --------------------------------------------------------------------------
const verseAfter = ([s, a]) => (a < AYAHS[s - 1] ? [s, a + 1] : s < 114 ? [s + 1, 1] : null);

let arabicVerse = [1, 1];        // the verse whose rosette comes next
// A sura's first verse is preceded by its heading: one line with the sura's
// name and one with the basmala (Sura 9 has no basmala; in Sura 1 the basmala
// is the first verse). Those lines are never part of a verse. This counts
// the heading lines still to be passed before the next verse's text begins —
// they may be at the foot of one page and the verse on the next.
let headingLeft = 0;
const headingLinesOf = ([sura, ayah]) => (ayah !== 1 || sura === 1 ? 0 : sura === 9 ? 1 : 2);

/** Verses whose number is printed on a page, in order: Map page -> [[sura, verse], …]. */
const startsOnPage = new Map();
SURAH_DATA.forEach(([, ayahs, breaks], i) => {
  breaks.forEach(([from, page], k) => {
    const to = breaks[k + 1] ? breaks[k + 1][0] - 1 : ayahs;
    if (!startsOnPage.has(page)) startsOnPage.set(page, []);
    for (let a = from; a <= to; a++) startsOnPage.get(page).push([i + 1, a]);
  });
});
const sameVerse = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const verseOrder = (a, b) => a.s - b.s || a.a - b.a;

/** First verse that starts on or after a page (every juz starts with a new verse). */
function firstVerseFrom(page) {
  let best = null;
  SURAH_DATA.forEach(([, , breaks], i) => {
    for (const [ayah, p] of breaks) {
      if (p >= page && (!best || p < best.page)) best = { page: p, verse: [i + 1, ayah] };
    }
  });
  return best ? best.verse : null;
}
const verseBefore = ([s2, a]) => (a > 1 ? [s2, a - 1] : s2 > 1 ? [s2 - 1, AYAHS[s2 - 2]] : null);
let pdfPage = 0;
const problems = [];
let totalMarks = 0;

mkdirSync(`${ROOT}data/regions`, { recursive: true });

const PAGES_IN = (juz) => (juz === 1 ? 22 : juz === 30 ? 24 : 20);
for (let juz = 1; juz <= lastJuz; juz++) {
  if (juz < firstJuz) {
    pdfPage += PAGES_IN(juz);
    continue;
  }
  const data = new Uint8Array(readFileSync(`${ROOT}public/quran/JUZ${juz}-SWEDEN.pdf`));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const pagesOut = {};

  if (juz === firstJuz) {
    // Starting part-way through the book: pick up at this juz's first verse.
    arabicVerse = firstVerseFrom(pdfPage + 1);
    headingLeft = headingLinesOf(arabicVerse);
  }

  for (let n = 1; n <= doc.numPages; n++) {
    pdfPage++;
    if (juz < firstJuz || juz > lastJuz) continue;
    const page = await doc.getPage(n);
    const shapes = await shapesOfPage(page);
    const content = await page.getTextContent();
    page.cleanup();
    const layout = arabicLayout(shapes);
    const expected = startsOnPage.get(pdfPage) || [];
    // The verse in progress at the top of the page is the first one that
    // starts here, or the one before it carrying over.
    if (expected.length && arabicVerse &&
      !sameVerse(arabicVerse, expected[0]) && !sameVerse(arabicVerse, verseBefore(expected[0]))) {
      problems.push(`page ${pdfPage}: Arabic count was at ${arabicVerse.join(':')}, page starts with ${expected[0].join(':')} — corrected`);
      arabicVerse = layout.marks.length > expected.length ? verseBefore(expected[0]) : expected[0];
    }
    /** @type {Map<string, {s: number, a: number, ar: number[][], sv: number[][]}>} */
    const verses = new Map();
    const entry = ([s, a]) => {
      const key = `${s}:${a}`;
      if (!verses.has(key)) verses.set(key, { s, a, ar: [], sv: [] });
      return verses.get(key);
    };

    // ---- Arabic ----
    // A page with neither rosettes nor translation text has no verses (the
    // ornamental first and last page).
    const hasTranslation = content.items.some((it) => /^\d{1,3}\.$/.test(it.str.trim()));
    if (layout.marks.length || (hasTranslation && layout.dense.some(Boolean))) {
      totalMarks += layout.marks.length;
      const { top, pitch, lines, left, right, occupied } = layout;
      const band = (line, x0, x1) => {
        if (x1 - x0 < 3) return null;
        const y = top - line * pitch;
        return toRect(x0 - 1, y - pitch * 0.46, x1 + 1, y + pitch * 0.46);
      };
      // Text between two places on the page; lines without text are skipped.
      // How far the letters (and rosettes) between x0 and x1 on a line reach:
      // the shade covers the writing, not the empty frame around it.
      const inkBetween = (line, x0, x1, opensLine) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const [bx1, , bx0] of layout.perLine[line].boxes || []) {
          const c = (bx0 + bx1) / 2;
          if (c < x0 || c > x1) continue;
          lo = Math.min(lo, bx0);
          hi = Math.max(hi, bx1);
        }
        for (const mk of layout.marks) {
          const c = (mk.x0 + mk.x1) / 2;
          // (A rosette that opens a line can stand right of the text frame.)
          if (mk.line !== line || c < x0 || (!opensLine && c > x1)) continue;
          lo = Math.min(lo, c - ROSETTE_RADIUS);
          hi = Math.max(hi, c + ROSETTE_RADIUS);
        }
        return lo < hi ? [Math.max(lo, x0), hi] : null;
      };
      const span = (from, to) => {
        const rects = [];
        for (let line = from.line; line <= to.line && line < lines; line++) {
          if (line < 0 || !occupied[line]) continue;
          const x1 = line === from.line ? from.x : right;
          const x0 = line === to.line ? to.x : left;
          const ink = inkBetween(line, Math.max(x0, left - 4), Math.min(x1, right), x1 >= right);
          const rect = ink && band(line, ink[0], ink[1]);
          if (rect) rects.push(rect);
        }
        return rects;
      };
      // Pass the heading lines that are still due, starting at `line`.
      const pastHeading = (line) => {
        let l = line;
        while (l < lines && headingLeft > 0) {
          if (occupied[l]) headingLeft--;
          l++;
        }
        return l;
      };

      // The ornamental opening pages show only their verses in this grid.
      if (layout.special) headingLeft = 0;
      let cursor = { line: pastHeading(0), x: right };

      for (const mk of layout.marks) {
        if (!arabicVerse) { problems.push(`page ${pdfPage}: rosette after the last verse`); break; }
        // The verse runs up to and including its rosette.
        const rosetteLeft = (mk.x0 + mk.x1) / 2 - ROSETTE_RADIUS;
        const end = { line: mk.line, x: rosetteLeft };
        entry(arabicVerse).ar.push(...span(cursor, end));
        // The next verse: on the same line if text follows the rosette, else on the next line.
        // (A few shapes left of it are the rosette's own ornament, not text.)
        // Only shapes on the line's own height count: marks of the lines above
        // and below reach into this one.
        const lineY = top - mk.line * pitch;
        // (Only what is visible counts, each shape once: a word can be as
        // little as two or three shapes, e.g. "إنّ".)
        const leftOfRosette = (layout.perLine[mk.line].boxes || [])
          .filter(([x1, y, x0]) => x0 < rosetteLeft - 1 && x1 < rosetteLeft + 4 && Math.abs(y - lineY) < pitch * 0.3);
        const reach = leftOfRosette.length ? rosetteLeft - Math.min(...leftOfRosette.map((b) => b[2])) : 0;
        const more = leftOfRosette.length >= 2 && reach > 5;
        arabicVerse = verseAfter(arabicVerse);
        cursor = more ? { line: mk.line, x: rosetteLeft } : { line: mk.line + 1, x: right };
        if (arabicVerse && !layout.special) {
          headingLeft = headingLinesOf(arabicVerse);
          if (headingLeft > 0) cursor = { line: pastHeading(mk.line + 1), x: right };
        }
      }

      // What is left at the foot of the page belongs to the verse that goes on
      // overleaf. (The two ornamental opening pages end with their last verse.)
      if (arabicVerse && !layout.special && headingLeft === 0 && cursor.line < lines) {
        entry(arabicVerse).ar.push(...span(cursor, { line: lines - 1, x: left }));
      }
    }

    // ---- Translation ----
    if (expected.length) {
      const columns = translationColumns(content);
      const { order, exact } = orderColumns(columns, expected);
      if (!exact) problems.push(`page ${pdfPage}: translation numbers do not match the verses starting here`);
      let verse = verseBefore(expected[0]);   // text before the first number continues this verse
      let next = 0;
      let run = [];
      const flush = () => {
        if (run.length && verse) entry(verse).sv.push(...lineRects(run));
        run = [];
      };
      order.forEach((column, c) => {
        for (const line of column.lines) {
          if (line.number !== null && next < expected.length && line.number === expected[next][1]) {
            flush();
            verse = expected[next++];
          }
          run.push({ ...line, column: c });
        }
      });
      flush();
    }

    const sorted = [...verses.values()].sort(verseOrder);
    const out = sorted.filter((v) => v.ar.length || v.sv.length)
      .map((v) => [v.s, v.a, v.ar, v.sv]);
    if (out.length) pagesOut[pdfPage] = out;
    // The two readings of the page must agree on which verses are on it.
    const withArabic = sorted.filter((v) => v.ar.length).map((v) => `${v.s}:${v.a}`);
    const withText = sorted.filter((v) => v.sv.length).map((v) => `${v.s}:${v.a}`);
    if (withArabic.length && withText.length &&
      (withArabic[withArabic.length - 1] !== withText[withText.length - 1])) {
      problems.push(`page ${pdfPage}: Arabic ends with ${withArabic[withArabic.length - 1]}, translation with ${withText[withText.length - 1]}`);
    }
    // A verse whose number is printed here must have its text here. (A verse
    // may well have only Arabic or only translation on a page it runs over to.)
    for (const [vs, va] of expected) {
      const v = verses.get(`${vs}:${va}`);
      if (!v || !v.sv.length) problems.push(`page ${pdfPage}: ${vs}:${va} has no translation area`);
    }
  }
  await doc.destroy();
  if (juz >= firstJuz && juz <= lastJuz) {
    writeFileSync(`${ROOT}data/regions/juz-${juz}.json`, JSON.stringify(pagesOut));
    console.error(`juz ${juz} written (${Object.keys(pagesOut).length} pages)`);
  }
}

console.log(`rosettes found: ${totalMarks}`);
console.log(`Arabic ended at ${arabicVerse ? arabicVerse.join(':') + ' (next expected)' : 'the last verse'}`);
console.log(`problems: ${problems.length}`);
console.log(problems.slice(0, 80).join('\n'));
