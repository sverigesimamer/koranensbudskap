// Makes a web copy of a PDF that is much smaller and draws the same.
//
//   node tools/slim-pdf.mjs <in.pdf> <out.pdf>
//   node tools/slim-pdf.mjs --all [juz …]    (public/quran -> public/quran-web)
//
// Why it works: InDesign placed the Arabic page once per text line, each time
// clipped to that line. Every word outline is therefore written out about
// fifteen times per page. Here a run of outlines that occurs more than once
// is stored once (as a Form XObject) and the places where it stood say "draw
// that one, here" instead. Nothing is rasterised, redrawn or laid out anew;
// text, fonts, colours and everything else are copied byte for byte.
//
// Not bit-exact: two copies of one outline differ in the last digit InDesign
// wrote (0.001 pt = 0.0004 mm), and the copy keeps the first one for all.
// SHAPE_TOLERANCE and SHIFT_TOLERANCE bound that; the largest difference
// actually met is printed.
//
// The original file is only read. After writing, the copy is read back, the
// stored runs are written out again where they are used, and the result is
// compared with the original page descriptions word by word.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIN_BODY = 80;              // shorter outlines are not worth storing apart
const MAX_RUN = 400;              // outlines per stored run
const SHAPE_TOLERANCE = 0.0015;   // pt, between the numbers of two copies of an outline
const SHIFT_TOLERANCE = 0.0006;   // pt, between the positions of outlines within a run
const CHECK_TOLERANCE = 0.0025;   // pt, what the final comparison accepts
const RUN_PREFIX = 'KBr';         // resource names of the stored runs …
const SHAPE_PREFIX = 'KBs';       // … and of single outlines

// --------------------------------------------------------------------------
// Reading PDF objects
// --------------------------------------------------------------------------
const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const isRegular = (c) => !WS[c] && !DELIM[c];

/** Up to len bytes of text at p (fewer at the end of the data). */
const peek = (b, p, len) => b.latin1Slice(Math.min(p, b.length), Math.min(p + len, b.length));

function skipWs(b, p) {
  for (;;) {
    while (p < b.length && WS[b[p]]) p++;
    if (b[p] !== 0x25) return p;                         // %
    while (p < b.length && b[p] !== 10 && b[p] !== 13) p++;
  }
}

/** Parse one value at p. @returns {[object, number]} the value and where it ends. */
function parseValue(b, p) {
  p = skipWs(b, p);
  const c = b[p];
  if (c === 0x2f) {                                      // /Name
    let e = p + 1;
    while (e < b.length && isRegular(b[e])) e++;
    return [{ t: 'name', v: b.latin1Slice(p + 1, e) }, e];
  }
  if (c === 0x3c && b[p + 1] === 0x3c) {                 // << dict >>
    const map = new Map();
    p += 2;
    for (;;) {
      p = skipWs(b, p);
      if (b[p] === 0x3e && b[p + 1] === 0x3e) return [{ t: 'dict', map }, p + 2];
      const [key, e1] = parseValue(b, p);
      if (key.t !== 'name') throw new Error(`dictionary key expected at ${p}`);
      const [value, e2] = parseValue(b, e1);
      map.set(key.v, value);
      p = e2;
    }
  }
  if (c === 0x3c) {                                      // <hex>
    const e = b.indexOf(0x3e, p) + 1;
    return [{ t: 'str', raw: b.latin1Slice(p, e) }, e];
  }
  if (c === 0x28) {                                      // (string)
    let e = p + 1;
    for (let depth = 1; depth > 0; e++) {
      if (b[e] === 0x5c) e++;
      else if (b[e] === 0x28) depth++;
      else if (b[e] === 0x29) depth--;
    }
    return [{ t: 'str', raw: b.latin1Slice(p, e) }, e];
  }
  if (c === 0x5b) {                                      // [array]
    const items = [];
    p++;
    for (;;) {
      p = skipWs(b, p);
      if (b[p] === 0x5d) return [{ t: 'arr', items }, p + 1];
      const [value, e] = parseValue(b, p);
      items.push(value);
      p = e;
    }
  }
  let e = p;
  while (e < b.length && isRegular(b[e])) e++;
  const word = b.latin1Slice(p, e);
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
    if (/^\d+$/.test(word)) {                            // maybe "12 0 R"
      const m = /^\s+(\d+)\s+R(?![^\s()<>\[\]{}\/%])/.exec(peek(b, e, 24));
      if (m) return [{ t: 'ref', num: Number(word), gen: Number(m[1]) }, e + m[0].length];
    }
    return [{ t: 'num', raw: word, v: Number(word) }, e];
  }
  if (!word) throw new Error(`unexpected byte ${c} at ${p}`);
  return [{ t: 'kw', v: word }, e];
}

/** A value written back as PDF text. */
function ser(v) {
  switch (v.t) {
    case 'name': return '/' + v.v;
    case 'num': return v.raw;
    case 'str': return v.raw;
    case 'kw': return v.v;
    case 'ref': return `${v.num} ${v.gen} R`;
    case 'arr': return '[' + v.items.map(ser).join(' ') + ']';
    case 'dict': return '<<' + [...v.map].map(([k, x]) => `/${k} ${ser(x)}`).join(' ') + '>>';
    default: throw new Error('cannot write ' + v.t);
  }
}
const num = (n) => ({ t: 'num', raw: String(n), v: n });
const ref = (n) => ({ t: 'ref', num: n, gen: 0 });
const name = (s) => ({ t: 'name', v: s });

/** Undo the PNG row filters that XRef and object streams are usually packed with. */
function unpredict(data, parms) {
  const predictor = parms?.map.get('Predictor')?.v ?? 1;
  if (predictor < 10) {
    if (predictor !== 1) throw new Error('unsupported predictor ' + predictor);
    return data;
  }
  const columns = parms.map.get('Columns')?.v ?? 1;
  const bpp = Math.ceil(((parms.map.get('Colors')?.v ?? 1) * (parms.map.get('BitsPerComponent')?.v ?? 8)) / 8);
  const rowLen = Math.ceil((columns * bpp * 8) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r ? out[dst - rowLen + i] : 0;
      const ul = r && i >= bpp ? out[dst - rowLen + i - bpp] : 0;
      let add = 0;
      if (type === 1) add = a;
      else if (type === 2) add = up;
      else if (type === 3) add = (a + up) >> 1;
      else if (type === 4) {
        const pa = Math.abs(up - ul), pb = Math.abs(a - ul), pc = Math.abs(a + up - 2 * ul);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      } else if (type !== 0) throw new Error('bad row filter ' + type);
      out[dst + i] = (data[src + i] + add) & 255;
    }
  }
  return out;
}

class Pdf {
  constructor(buf) {
    this.b = buf;
    /** objNum -> {type:1, offset} | {type:2, stream, index} */
    this.xref = new Map();
    this.trailer = null;
    this.cache = new Map();
    this.containers = new Map();     // decoded object streams
    this.#readXref();
    if (this.trailer.map.has('Encrypt')) throw new Error('encrypted PDF');
  }

  #readXref() {
    const tail = this.b.latin1Slice(Math.max(0, this.b.length - 2048));
    let offset = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)?.[1]);
    if (!Number.isFinite(offset)) throw new Error('startxref not found');
    const seen = new Set();
    const queue = [offset];
    while (queue.length) {
      offset = queue.shift();
      if (seen.has(offset)) continue;
      seen.add(offset);
      const b = this.b;
      let p = skipWs(b, offset);
      let dict;
      if (peek(b, p, 4) === 'xref') {
        p += 4;
        for (;;) {
          p = skipWs(b, p);
          if (peek(b, p, 7) === 'trailer') break;
          const head = /^(\d+)\s+(\d+)\s*/.exec(peek(b, p, 40));
          p += head[0].length;
          for (let i = 0; i < Number(head[2]); i++) {
            const entry = /^(\d{10}) (\d{5}) ([nf])\s*/.exec(peek(b, p, 24));
            p += entry[0].length;
            const n = Number(head[1]) + i;
            if (entry[3] === 'n' && !this.xref.has(n)) this.xref.set(n, { type: 1, offset: Number(entry[1]), gen: Number(entry[2]) });
          }
        }
        [dict] = parseValue(b, p + 7);
        if (dict.map.has('XRefStm')) queue.unshift(dict.map.get('XRefStm').v);
      } else {
        const obj = this.#readAt(offset);
        dict = obj.value;
        const data = this.decode(dict, obj.data);
        const w = dict.map.get('W').items.map((x) => x.v);
        const index = dict.map.get('Index')?.items.map((x) => x.v) ?? [0, dict.map.get('Size').v];
        let q = 0;
        const field = (len, fallback) => {
          if (!len) return fallback;
          let v = 0;
          for (let i = 0; i < len; i++) v = v * 256 + data[q++];
          return v;
        };
        for (let s = 0; s < index.length; s += 2) {
          for (let i = 0; i < index[s + 1]; i++) {
            const type = field(w[0], 1), f2 = field(w[1], 0), f3 = field(w[2], 0);
            const n = index[s] + i;
            if (this.xref.has(n)) continue;
            if (type === 1) this.xref.set(n, { type: 1, offset: f2, gen: f3 });
            else if (type === 2) this.xref.set(n, { type: 2, stream: f2, index: f3 });
          }
        }
        this.xrefStreams ??= new Set();
        this.xrefStreams.add(obj.num);
      }
      this.trailer ??= dict;
      if (dict.map.has('Prev')) queue.push(dict.map.get('Prev').v);
    }
  }

  /** The object written at a file offset: its value, its stream data and the bytes it occupies. */
  #readAt(offset) {
    const b = this.b;
    const start = skipWs(b, offset);
    const head = /^(\d+)\s+(\d+)\s+obj/.exec(peek(b, start, 40));
    if (!head) throw new Error(`no object at ${offset}`);
    let [value, p] = parseValue(b, start + head[0].length);
    p = skipWs(b, p);
    let data = null;
    if (peek(b, p, 6) === 'stream') {
      p += 6;
      if (b[p] === 13) p++;
      if (b[p] === 10) p++;
      const length = this.resolve(value.map.get('Length')).v;
      data = b.subarray(p, p + length);
      p = skipWs(b, p + length);
      if (peek(b, p, 9) !== 'endstream') throw new Error(`stream of object ${head[1]} has a wrong length`);
      p = skipWs(b, p + 9);
    }
    if (peek(b, p, 6) !== 'endobj') throw new Error(`endobj missing for object ${head[1]}`);
    return { num: Number(head[1]), gen: Number(head[2]), value, data, start, end: p + 6 };
  }

  get(n) {
    if (this.cache.has(n)) return this.cache.get(n);
    const entry = this.xref.get(n);
    let obj = null;
    if (entry?.type === 1) {
      obj = this.#readAt(entry.offset);
    } else if (entry?.type === 2) {
      let box = this.containers.get(entry.stream);
      if (!box) {
        const holder = this.get(entry.stream);
        const data = this.decode(holder.value, holder.data);
        const first = holder.value.map.get('First').v;
        const numbers = data.latin1Slice(0, first).trim().split(/\s+/).map(Number);
        box = { data, first, numbers };
        this.containers.set(entry.stream, box);
      }
      const [value] = parseValue(box.data, box.first + box.numbers[entry.index * 2 + 1]);
      obj = { num: n, gen: 0, value, data: null, packed: true };
    }
    this.cache.set(n, obj);
    return obj;
  }

  resolve(v) {
    while (v?.t === 'ref') v = this.get(v.num)?.value;
    return v;
  }

  /** Stream data with its filters undone. Throws for filters this tool does not know. */
  decode(dict, data) {
    let filter = this.resolve(dict.map.get('Filter'));
    let parms = this.resolve(dict.map.get('DecodeParms'));
    if (filter?.t === 'arr') {
      if (filter.items.length > 1) throw new Error('several filters');
      filter = filter.items[0];
      parms = parms?.t === 'arr' ? this.resolve(parms.items[0]) : parms;
    }
    if (!filter) return data;
    if (filter.v !== 'FlateDecode') throw new Error('filter ' + filter.v);
    return unpredict(zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }), parms?.t === 'dict' ? parms : null);
  }
}

// --------------------------------------------------------------------------
// Finding the shapes in a page description
// --------------------------------------------------------------------------
// Operators a shape may consist of: paths, painting, plain colours, line
// style, and nested q/cm/Q. Anything that needs a named resource is left out.
const PLAIN = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*', 'n',
  'W', 'W*', 'q', 'Q', 'cm', 'w', 'J', 'j', 'M', 'd', 'i', 'g', 'G', 'rg', 'RG', 'k', 'K']);
const PAINTS = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*', 'n', 'Q']);

/**
 * The shapes of a page description: every "q a b c d x y cm … Q" whose inside
 * is nothing but plain path drawing.
 * @returns {object[] | null} outermost shapes in order, each with the shapes
 *   inside it as `kids`: {qs, qe: the whole block, s, e: the inside, mat: the
 *   six numbers as written}. null when the stream holds inline images.
 */
function findShapes(c) {
  let found = [];
  const stack = [];
  const n = c.length;
  let p = 0;
  const taint = () => { if (stack.length) stack[stack.length - 1].dirty = true; };
  while (p < n) {
    const ch = c[p];
    if (WS[ch]) { p++; continue; }
    if (ch === 0x25) { while (p < n && c[p] !== 10 && c[p] !== 13) p++; continue; }
    if (ch === 0x28) {
      p++;
      for (let depth = 1; depth > 0 && p < n; p++) {
        if (c[p] === 0x5c) p++;
        else if (c[p] === 0x28) depth++;
        else if (c[p] === 0x29) depth--;
      }
      taint();
      continue;
    }
    if (ch === 0x3c || ch === 0x3e) {
      if (c[p + 1] === ch) p += 2;
      else if (ch === 0x3c) p = c.indexOf(0x3e, p) + 1 || n;
      else p++;
      taint();
      continue;
    }
    if (ch === 0x5b || ch === 0x5d || ch === 0x7b || ch === 0x7d) { p++; continue; }
    if (ch === 0x2f) {
      p++;
      while (p < n && isRegular(c[p])) p++;
      taint();
      continue;
    }
    const start = p;
    while (p < n && isRegular(c[p])) p++;
    const top = stack[stack.length - 1];
    if ((ch >= 0x30 && ch <= 0x39) || ch === 0x2d || ch === 0x2e || ch === 0x2b) {      // number
      if (top?.fresh) top.nums.push(c.latin1Slice(start, p));
      continue;
    }
    const op = c.latin1Slice(start, p);
    if (op === 'BI') return null;
    if (op === 'q') {
      if (top) { top.fresh = false; top.last = 'q'; }
      stack.push({ qs: start, fresh: true, nums: [], mat: null, body: -1, dirty: false, last: '', mark: found.length });
    } else if (op === 'Q') {
      const frame = stack.pop();
      if (!frame) continue;
      const parent = stack[stack.length - 1];
      if (parent) { parent.last = 'Q'; if (frame.dirty) parent.dirty = true; }
      if (frame.body < 0 || frame.dirty || !PAINTS.has(frame.last)) continue;
      let s = frame.body;
      let e = start;
      while (s < e && WS[c[s]]) s++;
      while (e > s && WS[c[e - 1]]) e--;
      if (e - s < MIN_BODY) continue;
      const kids = found.slice(frame.mark);
      found = found.slice(0, frame.mark);
      found.push({ qs: frame.qs, qe: p, s, e, mat: frame.mat, kids });
    } else if (top) {
      if (top.fresh && op === 'cm' && top.nums.length === 6) { top.body = p; top.mat = top.nums; }
      top.fresh = false;
      top.last = op;
      if (!PLAIN.has(op)) top.dirty = true;
    }
  }
  return found;
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)/g;
const digest = (buf) => crypto.createHash('sha1').update(buf).digest('latin1');
/** A number as PDF text: at most seven decimals, no exponent. */
const fmt = (v) => { const t = v.toFixed(7).replace(/\.?0+$/, ''); return t === '-0' ? '0' : t; };

/**
 * Groups shapes that are the same drawing. "The same" allows the last-digit
 * rounding differences InDesign leaves between two copies of one shape.
 */
class ShapeClasses {
  constructor() {
    this.exact = new Map();      // digest of the bytes -> class
    this.bySkeleton = new Map(); // operators without numbers -> classes
    this.list = [];
  }

  classOf(body) {
    const h = digest(body);
    let cls = this.exact.get(h);
    if (cls) return cls;
    const nums = [];
    const skeleton = body.latin1Slice().replace(NUMBER, (m) => { nums.push(Number(m)); return '#'; }).replace(/\s+/g, ' ');
    let bucket = this.bySkeleton.get(skeleton);
    if (!bucket) this.bySkeleton.set(skeleton, bucket = []);
    search: for (const candidate of bucket) {
      const other = candidate.nums;
      for (let i = 0; i < nums.length; i++) {
        if (Math.abs(nums[i] - other[i]) > SHAPE_TOLERANCE) continue search;
      }
      cls = candidate;
      break;
    }
    if (!cls) {
      cls = { id: this.list.length, body: Buffer.from(body), nums: Float64Array.from(nums), count: 0, form: null };
      this.list.push(cls);
      bucket.push(cls);
    }
    this.exact.set(h, cls);
    return cls;
  }
}

// --------------------------------------------------------------------------
// The things that hold page descriptions: pages and Form XObjects
// --------------------------------------------------------------------------
function containersOf(pdf) {
  const list = [];
  for (const n of pdf.xref.keys()) {
    let obj;
    try { obj = pdf.get(n); } catch { continue; }
    if (obj?.value?.t !== 'dict') continue;
    const d = obj.value.map;
    if (obj.data && d.get('Subtype')?.v === 'Form') {
      if (pdf.resolve(d.get('Resources'))?.t === 'dict') list.push({ kind: 'form', n, parts: [n] });
    } else if (!obj.data && d.get('Type')?.v === 'Page') {
      const parts = contentParts(pdf, obj.value);
      if (parts.length) list.push({ kind: 'page', n, parts });
    }
  }
  return list;
}

/** Object numbers of the streams that make up a page's description. */
function contentParts(pdf, pageDict) {
  const direct = pageDict.map.get('Contents');
  const value = pdf.resolve(direct);
  if (value?.t === 'arr') return value.items.map((x) => x.num);
  return direct?.t === 'ref' ? [direct.num] : [];
}

/** The page description of a container, filters undone; null if it cannot be read. */
function contentOf(pdf, container) {
  try {
    const parts = container.parts.map((n) => { const o = pdf.get(n); return pdf.decode(o.value, o.data); });
    return parts.length === 1 ? parts[0] : Buffer.concat(parts.flatMap((x, i) => (i ? [Buffer.from('\n'), x] : [x])));
  } catch {
    return null;
  }
}

/** Resources of a page: its own, or the ones it inherits from the page tree. */
function resourcesOf(pdf, dict) {
  for (let d = dict; d; d = pdf.resolve(d.map.get('Parent'))) {
    const r = pdf.resolve(d.map.get('Resources'));
    if (r?.t === 'dict') return r;
  }
  return { t: 'dict', map: new Map() };
}

// --------------------------------------------------------------------------
// Writing the slim copy
// --------------------------------------------------------------------------
function slim(input, output) {
  const buf = fs.readFileSync(input);
  const pdf = new Pdf(buf);
  const containers = containersOf(pdf);
  const classes = new ShapeClasses();

  // 1. The shapes of every page description, grouped into classes. A shape
  //    that turns out to be one of a kind is opened: the shapes inside it get
  //    their chance instead.
  let open = [];
  for (const c of containers) {
    c.content = contentOf(pdf, c);
    const shapes = c.content && findShapes(c.content);
    if (!shapes) { c.content = null; continue; }
    c.shapes = [];
    for (const shape of shapes) open.push([c, shape]);
  }
  while (open.length) {
    for (const [c, shape] of open) {
      shape.cls = classes.classOf(c.content.subarray(shape.s, shape.e));
      shape.cls.count++;
    }
    const next = [];
    for (const [c, shape] of open) {
      if (shape.cls.count === 1 && shape.kids.length) {
        shape.cls.count = 0;
        for (const kid of shape.kids) next.push([c, kid]);
      } else {
        c.shapes.push(shape);
      }
    }
    open = next;
  }

  // 2. Runs: shapes that follow each other with nothing in between. A copy of
  //    a text line is the same run of shapes, moved; such a run is stored once.
  const runsByKey = new Map();
  for (const c of containers) {
    if (!c.content) continue;
    c.shapes.sort((a, b) => a.qs - b.qs);
    c.runs = [];
    let run = null;
    for (const shape of c.shapes) {
      const m = shape.mat;
      shape.moves = m[0] === '1' && m[1] === '0' && m[2] === '0' && m[3] === '1';
      let joins = !!run && shape.moves && run.shapes.length < MAX_RUN;
      if (joins) for (let p = run.shapes[run.shapes.length - 1].qe; p < shape.qs; p++) if (!WS[c.content[p]]) { joins = false; break; }
      if (joins) run.shapes.push(shape);
      else if (shape.moves) c.runs.push(run = { shapes: [shape] });
      else run = null;
    }
    for (const r of c.runs) {
      const x0 = Math.round(Number(r.shapes[0].mat[4]) * 1e7);
      const y0 = Math.round(Number(r.shapes[0].mat[5]) * 1e7);
      r.offsets = Float64Array.from(r.shapes.flatMap((sh) => [
        (Math.round(Number(sh.mat[4]) * 1e7) - x0) / 1e7, (Math.round(Number(sh.mat[5]) * 1e7) - y0) / 1e7]));
      const key = r.shapes.map((sh) => sh.cls.id).join(',');
      let bucket = runsByKey.get(key);
      if (!bucket) runsByKey.set(key, bucket = []);
      r.same = bucket.find((other) => {
        for (let i = 0; i < r.offsets.length; i++) if (Math.abs(r.offsets[i] - other.offsets[i]) > SHIFT_TOLERANCE) return false;
        return true;
      });
      if (r.same) { r.same.count++; } else { r.count = 1; bucket.push(r); }
    }
  }

  // 3. Rewrite.
  let next = pdf.trailer.map.get('Size').v;
  const written = new Map();           // object number -> Buffer (the whole object)
  const packedDicts = [];              // [object number, text] for the new object stream
  const dropped = new Set(pdf.xrefStreams ?? []);
  const kept = new Set();
  const stats = { runForms: 0, shapeForms: 0, formBytes: 0, pageBytes: 0 };
  const stream = (n, dictMap, data) => {
    const packed = zlib.deflateSync(data, { level: 9 });
    const d = new Map(dictMap);
    d.set('Filter', name('FlateDecode'));
    d.delete('DecodeParms');
    d.set('Length', num(packed.length));
    written.set(n, Buffer.concat([Buffer.from(`${n} 0 obj\n${ser({ t: 'dict', map: d })}\nstream\n`, 'latin1'), packed, Buffer.from('\nendstream\nendobj\n')]));
    return packed.length;
  };
  const formDict = new Map([
    ['Type', name('XObject')], ['Subtype', name('Form')],
    ['BBox', { t: 'arr', items: [num(-32768), num(-32768), num(32767), num(32767)] }],
    ['Resources', { t: 'dict', map: new Map() }]
  ]);
  const runForm = (r) => {
    if (!r.form) {
      r.form = { n: next++, name: RUN_PREFIX + (stats.runForms++).toString(36) };
      const parts = [];
      r.shapes.forEach((sh, i) => {
        parts.push(Buffer.from(`q 1 0 0 1 ${fmt(r.offsets[i * 2])} ${fmt(r.offsets[i * 2 + 1])} cm\n`, 'latin1'), sh.cls.body, Buffer.from('\nQ\n'));
      });
      stats.formBytes += stream(r.form.n, formDict, Buffer.concat(parts));
    }
    return r.form;
  };
  const shapeForm = (cls) => {
    if (!cls.form) {
      cls.form = { n: next++, name: SHAPE_PREFIX + (stats.shapeForms++).toString(36) };
      stats.formBytes += stream(cls.form.n, formDict, cls.body);
    }
    return cls.form;
  };

  for (const c of containers) {
    const content = c.content;
    const edits = [];                  // {s, e, text, form}
    if (content) {
      const inSharedRun = new Set();
      for (const r of c.runs) {
        const rep = r.same ?? r;
        if (rep.count < 2) continue;
        const first = r.shapes[0];
        const form = runForm(rep);
        edits.push({ s: first.qs, e: r.shapes[r.shapes.length - 1].qe, text: `q 1 0 0 1 ${first.mat[4]} ${first.mat[5]} cm /${form.name} Do Q`, form });
        for (const sh of r.shapes) inSharedRun.add(sh);
      }
      for (const sh of c.shapes) {
        if (inSharedRun.has(sh) || sh.cls.count < 2) continue;
        const form = shapeForm(sh.cls);
        edits.push({ s: sh.s, e: sh.e, text: `/${form.name} Do`, form });
      }
    }
    c.content = c.shapes = c.runs = null;
    if (!edits.length) { if (c.kind === 'page') c.parts.forEach((n) => kept.add(n)); continue; }

    edits.sort((a, b) => a.s - b.s);
    const used = new Map();
    const pieces = [];
    let at = 0;
    for (const edit of edits) {
      used.set(edit.form.name, edit.form.n);
      pieces.push(content.subarray(at, edit.s), Buffer.from(edit.text, 'latin1'));
      at = edit.e;
    }
    pieces.push(content.subarray(at));
    const slimContent = Buffer.concat(pieces);

    const obj = pdf.get(c.n);
    const resources = c.kind === 'page' ? resourcesOf(pdf, obj.value) : pdf.resolve(obj.value.map.get('Resources'));
    const xobjects = new Map(pdf.resolve(resources.map.get('XObject'))?.map ?? []);
    for (const [k, n] of used) {
      if (xobjects.has(k)) throw new Error(`resource name ${k} is taken`);
      xobjects.set(k, ref(n));
    }
    const xobjectsAt = next++;
    packedDicts.push([xobjectsAt, ser({ t: 'dict', map: xobjects })]);
    const newResources = { t: 'dict', map: new Map(resources.map).set('XObject', ref(xobjectsAt)) };
    const dict = new Map(obj.value.map).set('Resources', newResources);

    if (c.kind === 'form') {
      stats.pageBytes += stream(c.n, dict, slimContent);
    } else {
      const contentAt = next++;
      stats.pageBytes += stream(contentAt, new Map(), slimContent);
      dict.set('Contents', ref(contentAt));
      written.set(c.n, Buffer.from(`${c.n} 0 obj\n${ser({ t: 'dict', map: dict })}\nendobj\n`, 'latin1'));
      c.parts.forEach((n) => dropped.add(n));
    }
    c.rewritten = true;
  }
  for (const n of kept) dropped.delete(n);

  // XMP packets of the placed graphics: megabytes of text nobody reads on the
  // web. The document's own packet stays.
  const ownMetadata = pdf.resolve(pdf.trailer.map.get('Root')).map.get('Metadata')?.num;
  let metadata = 0;
  for (const [n, entry] of pdf.xref) {
    if (entry.type !== 1 || n === ownMetadata || written.has(n) || dropped.has(n)) continue;
    const obj = pdf.get(n);
    if (obj?.data?.length && obj.value.map.get('Type')?.v === 'Metadata') {
      metadata += obj.data.length;
      const d = new Map(obj.value.map).set('Length', num(0));
      d.delete('Filter');
      d.delete('DecodeParms');
      written.set(n, Buffer.from(`${n} 0 obj\n${ser({ t: 'dict', map: d })}\nstream\n\nendstream\nendobj\n`, 'latin1'));
    }
  }

  // The new resource dictionaries, packed together in one object stream.
  const packedAt = next++;
  const packedIndex = new Map();
  if (packedDicts.length) {
    let head = '';
    let body = '';
    packedDicts.forEach(([n, text], i) => { head += `${n} ${body.length} `; body += text + '\n'; packedIndex.set(n, i); });
    stream(packedAt, new Map([['Type', name('ObjStm')], ['N', num(packedDicts.length)], ['First', num(head.length)]]), Buffer.from(head + body, 'latin1'));
  }

  // File: every object of the original as it stands, except the replaced ones.
  const out = [Buffer.from('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = out[0].length;
  const size = next + 1;
  const table = Buffer.alloc(size * 7);
  const setEntry = (n, type, a, b) => { table[n * 7] = type; table.writeUInt32BE(a, n * 7 + 1); table.writeUInt16BE(b, n * 7 + 5); };
  const put = (n, bytes) => { setEntry(n, 1, offset, 0); out.push(bytes); offset += bytes.length; };
  table.writeUInt16BE(65535, 5);
  for (const n of [...pdf.xref.keys()].sort((a, b) => a - b)) {
    if (n === 0 || dropped.has(n)) continue;
    const entry = pdf.xref.get(n);
    if (written.has(n)) { put(n, written.get(n)); written.delete(n); continue; }
    if (entry.type === 2) { setEntry(n, 2, entry.stream, entry.index); continue; }
    const obj = pdf.get(n);
    if (!obj) continue;
    if (obj.gen) throw new Error(`object ${n} has generation ${obj.gen}`);
    put(n, Buffer.concat([buf.subarray(obj.start, obj.end), Buffer.from('\n')]));
  }
  for (const [n, bytes] of written) put(n, bytes);
  for (const [n, i] of packedIndex) setEntry(n, 2, packedAt, i);

  const xrefAt = next;
  setEntry(xrefAt, 1, offset, 0);
  const trailer = new Map([['Type', name('XRef')], ['Size', num(size)], ['W', { t: 'arr', items: [num(1), num(4), num(2)] }]]);
  for (const key of ['Root', 'Info', 'ID']) if (pdf.trailer.map.has(key)) trailer.set(key, pdf.trailer.map.get(key));
  const packedTable = zlib.deflateSync(table, { level: 9 });
  trailer.set('Filter', name('FlateDecode')).set('Length', num(packedTable.length));
  out.push(Buffer.from(`${xrefAt} 0 obj\n${ser({ t: 'dict', map: trailer })}\nstream\n`, 'latin1'), packedTable,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.concat(out));

  const check = verify(pdf, containers, output);
  const mb = (n) => (n / 1048576).toFixed(1);
  const after = fs.statSync(output).size;
  console.log(`${path.basename(input)}: ${mb(buf.length)} MB -> ${mb(after)} MB` +
    ` | ${containers.filter((c) => c.rewritten).length} page descriptions repacked: ${stats.runForms} runs + ${stats.shapeForms} shapes stored once` +
    ` (${mb(stats.formBytes)} MB), pages ${mb(stats.pageBytes)} MB` + (metadata ? `, ${mb(metadata)} MB XMP removed` : '') +
    ` | ${check.problems.length ? 'CHECK FAILED: ' + check.problems.slice(0, 5).join('; ')
      : `check ok, ${check.numbers} numbers differ, largest difference ${check.worst.toFixed(4)} pt`}`);
  return { before: buf.length, after, ok: !check.problems.length, worst: check.worst };
}

/**
 * Read the copy back and compare it with the original. Every stored run and
 * shape is written out again where it is used; the result must be the
 * original page description, word for word, with numbers allowed to differ
 * by the rounding tolerance only.
 */
function verify(original, containers, output) {
  const copy = new Pdf(fs.readFileSync(output));
  const problems = [];
  let worst = 0;
  let numbers = 0;
  const runPattern = new RegExp(`q 1 0 0 1 (\\S+) (\\S+) cm /(${RUN_PREFIX}[0-9a-z]+) Do Q`, 'g');
  const shapePattern = new RegExp(`/(${SHAPE_PREFIX}[0-9a-z]+) Do`, 'g');
  const streams = new Map();
  const streamOf = (n) => {
    if (!streams.has(n)) { const f = copy.get(n); streams.set(n, copy.decode(f.value, f.data)); }
    return streams.get(n);
  };
  const isNumber = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

  for (const c of containers) {
    const before = contentOf(original, c);
    if (!before) continue;
    const obj = copy.get(c.n);
    const resources = c.kind === 'page' ? resourcesOf(copy, obj.value) : copy.resolve(obj.value.map.get('Resources'));
    const xobjects = copy.resolve(resources.map.get('XObject'))?.map ?? new Map();
    const after = contentOf(copy, { parts: c.kind === 'form' ? [c.n] : contentParts(copy, obj.value) });
    const lookup = (key) => {
      const n = xobjects.get(key)?.num;
      if (n === undefined) problems.push(`${c.kind} ${c.n}: ${key} is not in its resources`);
      return n;
    };
    const restored = after.latin1Slice()
      .replace(runPattern, (all, x, y, key) => {
        const n = lookup(key);
        if (n === undefined) return all;
        const form = streamOf(n);
        return findShapes(form).map((el) =>
          `q 1 0 0 1 ${fmt(Number(x) + Number(el.mat[4]))} ${fmt(Number(y) + Number(el.mat[5]))} cm\n${form.latin1Slice(el.s, el.e)}\nQ`).join('\n');
      })
      .replace(shapePattern, (all, key) => {
        const n = lookup(key);
        return n === undefined ? all : streamOf(n).latin1Slice();
      });

    // Word by word.
    const a = before.latin1Slice();
    const wa = /\S+/g;
    const wb = /\S+/g;
    for (;;) {
      const x = wa.exec(a);
      const y = wb.exec(restored);
      if (!x || !y) {
        if (x || y) problems.push(`${c.kind} ${c.n}: one description is longer than the other`);
        break;
      }
      if (x[0] === y[0]) continue;
      const d = isNumber.test(x[0]) && isNumber.test(y[0]) ? Math.abs(Number(x[0]) - Number(y[0])) : Infinity;
      numbers++;
      if (d > CHECK_TOLERANCE) {
        problems.push(`${c.kind} ${c.n}: "${x[0]}" became "${y[0]}" at ${x.index}`);
        break;
      }
      if (d > worst) worst = d;
    }
  }
  const pages = (pdf) => pdf.resolve(pdf.resolve(pdf.trailer.map.get('Root')).map.get('Pages')).map.get('Count').v;
  if (pages(copy) !== pages(original)) problems.push('page count differs');
  return { problems, worst, numbers };
}

// --------------------------------------------------------------------------
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args[0] === '--all') {
  const from = path.join(root, 'public/quran');
  const to = path.join(root, 'public/quran-web');
  const only = args.slice(1).map(Number);
  const files = fs.readdirSync(from).filter((f) => /\.pdf$/i.test(f))
    .filter((f) => !only.length || only.includes(Number(f.match(/\d+/))))
    .sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)));
  let before = 0, after = 0, failed = 0, worst = 0;
  for (const f of files) {
    const r = slim(path.join(from, f), path.join(to, f));
    before += r.before; after += r.after; failed += r.ok ? 0 : 1; worst = Math.max(worst, r.worst);
  }
  console.log(`total: ${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(0)} MB, largest difference ${worst.toFixed(4)} pt, ${failed} file(s) failed the check`);
  process.exitCode = failed ? 1 : 0;
} else if (args.length === 2) {
  process.exitCode = slim(path.resolve(args[0]), path.resolve(args[1])).ok ? 0 : 1;
} else {
  console.log('usage: node tools/slim-pdf.mjs <in.pdf> <out.pdf> | --all [juz numbers]');
}
