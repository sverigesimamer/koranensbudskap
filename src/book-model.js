// Which PDF page sits where. Pure data — no rendering.
//
// The book is a row of "slots": slot 0 is the right-hand side of the first
// spread, slot 1 its left-hand side, slot 2 the right-hand side of the second
// spread, and so on (Arabic reading order). `leadingBlanks` empty slots come
// before PDF page 1.
//
// A leaf is one physical sheet: its front lies on the left of a spread, its
// back shows up on the right of the following spread once it has been turned.

export class BookModel {
  /**
   * @param {number} pageCount     pages in the PDF
   * @param {number} leadingBlanks empty slots before page 1 (0 or 1)
   */
  constructor(pageCount, leadingBlanks = 1) {
    this.pageCount = pageCount;
    this.leadingBlanks = leadingBlanks;
    this.spreadCount = Math.ceil((pageCount + leadingBlanks) / 2);
  }

  /** PDF page number in a slot, or null when the slot is empty. */
  pageAtSlot(slot) {
    const page = slot - this.leadingBlanks + 1;
    return page >= 1 && page <= this.pageCount ? page : null;
  }

  /** @returns {{index: number, right: number|null, left: number|null}} */
  spread(index) {
    return {
      index,
      right: this.pageAtSlot(index * 2),
      left: this.pageAtSlot(index * 2 + 1)
    };
  }

  spreadOfPage(page) {
    const clamped = Math.max(1, Math.min(this.pageCount, Math.round(page) || 1));
    return Math.floor((clamped - 1 + this.leadingBlanks) / 2);
  }

  hasSpread(index) {
    return index >= 0 && index < this.spreadCount;
  }

  /**
   * Describes turning one leaf away from spread `index`.
   * 'next' moves on in reading order (left page travels to the right),
   * 'prev' goes back (right page travels to the left).
   * @param {number} index
   * @param {'next'|'prev'} dir
   */
  turn(index, dir) {
    const target = index + (dir === 'next' ? 1 : -1);
    if (!this.hasSpread(target)) return null;
    const from = this.spread(index);
    const to = this.spread(target);
    return dir === 'next'
      ? { dir, target, side: -1, front: from.left, back: to.right, under: to.left }
      : { dir, target, side: 1, front: from.right, back: to.left, under: to.right };
  }

  /** Every PDF page on the spreads from index - radius to index + radius. */
  pagesAround(index, radius) {
    const pages = [];
    for (let i = index - radius; i <= index + radius; i++) {
      if (!this.hasSpread(i)) continue;
      const s = this.spread(i);
      if (s.right) pages.push(s.right);
      if (s.left) pages.push(s.left);
    }
    return pages;
  }
}
