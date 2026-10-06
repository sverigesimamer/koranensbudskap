// Central configuration. Nothing here touches the PDF itself — it only
// describes how the untouched PDF pages are presented.

// Pages in each of the 30 files. JUZ1 starts with the cover, JUZ30 ends with
// the last page of the book; together they form one continuous book.
const pagesInJuz = (juz) => (juz === 1 ? 22 : juz === 30 ? 24 : 20);

// Where the 30 PDF files are fetched from.
//
// public/quran-web/ holds the web copies: the originals (public/quran/, 55–115
// MB each, not in the Git repository) repacked by tools/slim-pdf.mjs so that
// every file fits what Cloudflare Pages serves (25 MB per file). To show the
// originals instead, say './public/quran/' here; to fetch the files from
// somewhere else, give that address, ending with a slash.
const pdfBase = './public/quran-web/';

export const CONFIG = {
  // The PDF files, in reading order. They are shown as one book.
  volumes: Array.from({ length: 30 }, (_, i) => ({
    url: `${pdfBase}JUZ${i + 1}-SWEDEN.pdf`,
    label: `Juz ${i + 1}`,
    pages: pagesInJuz(i + 1)
  })),

  // The hard cover. The same picture is used for both boards. `crop` is the
  // part of the picture that is the cover itself ([x, y, width, height] in
  // image pixels — the picture shows the book with a white margin around it
  // and the spine on its left).
  //
  // The back board is the picture exactly as it is: its spine is on the left.
  // The front board of this right-to-left book has its spine on the right,
  // so there the picture is mirrored — the ornament ends up by the spine, on
  // the right — and the round title badge (`upright`: centre and radius in
  // image pixels) is turned the right way round again so it stays readable.
  //
  // Remove `cover` to use PDF page 1 as the cover instead.
  cover: {
    front: {
      image: './public/cover/cover.jpg',
      crop: [128, 142, 843, 1158],
      mirror: true,
      upright: [{ cx: 773, cy: 717, r: 148 }]
    },
    back: { image: './public/cover/cover.jpg', crop: [128, 142, 843, 1158] },
    // Inside of the boards (the pasted-down endpaper).
    inside: '#ece3cd'
  },

  // Recitation. Nothing is bundled or hosted by the app: each sura's audio
  // file comes from the Tarteel CDN and the verse timings from the Quran.com
  // API, and both are kept in the browser's own storage (Cache Storage)
  // after the first time, so a sura is only downloaded once.
  //   {surah3} = sura number with three digits (002), {surah} = plain (2)
  audio: {
    reciter: 'Mishary Rashid Alafasy',
    surahUrl: 'https://audio-cdn.tarteel.ai/quran/surah/alafasy/murattal/mp3/{surah3}.mp3',
    timingsUrl: 'https://api.qurancdn.com/api/qdc/audio/reciters/7/audio_files?chapter={surah}&segments=true',
    cacheName: 'koranens-budskap-recitation-v1'
  },

  // Printer's crop marks. The PDF pages are print files: outside the real
  // page (the TrimBox) they carry a margin with short crop marks in the
  // corners. Listed pages are drawn without those marks — the PDF files are
  // not changed, the mark lines are just not drawn.
  //   pages:      page numbers within the PDF files (1 = first page of JUZ1),
  //               or 'all' for every page
  //   trimMargin: distance from the edge of the PDF page to the TrimBox, in
  //               PDF points (21 in all 30 files)
  // Remove `printerMarks` to draw the pages with their marks.
  printerMarks: {
    pages: 'all',
    trimMargin: 21
  },

  // PDF.js is vendored so the app runs without an internet connection.
  pdfjs: {
    lib: '../vendor/pdfjs/pdf.min.mjs',
    worker: './vendor/pdfjs/pdf.worker.min.mjs'
  },

  book: {
    // Arabic binding: the spine is on the right of the closed book, reading
    // moves right -> left, and a leaf is turned from the left side to the right.
    direction: 'rtl',

    // How PDF pages are laid onto spreads.
    //   1 = PDF page 1 sits alone on the left (it is the front of the first
    //       leaf, like a printed book): spreads are [–|1] [2|3] [4|5] …
    //       written as right|left. The first of them is shown as the closed
    //       book with PDF page 1 as its cover.
    //   0 = PDF pages 1 and 2 share the first spread: [1|2] [3|4] …
    leadingBlanks: 1,

    // PDF page that should be visible when the app opens.
    // Book page shown at start. Page 1 is the cover: the book starts closed.
    startPage: 1,

    // The closed book stays a moment, then opens by itself on Al-Fatihah
    // (milliseconds after the cover is shown; 0 = wait for a click).
    autoOpenMs: 2000,
    // Tempo of the opening cover: 1 = as fast as a page turned by a click,
    // 0.5 = twice as long.
    openingSpeed: 0.5,

    // The number printed on a page = its page number in the PDF files + this
    // (the first PDF page is unnumbered, so the page printed "1" is PDF page 2).
    printedPageOffset: -1,

    // The hard cover, relative to the page width: how far the boards reach
    // beyond the pages and how thick they are.
    coverOverhang: 0.03,
    coverThickness: 0.014
  },

  render: {
    // Canvas pixels per CSS pixel: the screen's devicePixelRatio, but at
    // least minPixelRatio (so an ordinary screen still gets a finely rendered
    // page, scaled down) and at most maxPixelRatio.
    minPixelRatio: 2.5,
    maxPixelRatio: 3,
    // Spreads kept rendered on each side of the current one.
    preloadSpreads: 2,
    keepSpreads: 2,
    // PDF files kept open at the same time.
    openVolumes: 4
  },

  layout: {
    // Share of the stage the open book may occupy.
    maxWidth: 0.94,
    maxHeight: 0.9,
    // One page at a time (with a swipe to the next) on an upright screen
    // narrower than this; two pages side by side everywhere else. Desktop
    // windows are always two pages.
    singlePageBelow: 760
  },

  // Reading zoom (double-click a page).
  zoom: {
    maxWidth: 1280, // CSS px
    margin: 28,     // space left and right of the page
    maxPixels: 14e6 // upper bound for the zoomed canvas
  },

  flip: {
    // Share of the page width (from the outer edge) that grabs the page.
    grabZone: 0.16,
    grabZoneTouch: 0.24,
    // Hover "peek": how far the edge lifts, as a share of the page width.
    peek: 0.075,
    // Sheet shape (see curl-solver.js).
    curl: { bow: 0.78, bowExp: 0.9, minCurl: 0.45 },
    // Camera height above the book, in page widths. Lower = stronger perspective.
    cameraHeight: 4.6,
    // Pointer follow / release springs (angular frequency, 1/s).
    followRate: 34,
    settleRate: 9.5,
    // Spring that lays the sheet down over its last degrees. Lower = the page
    // floats down more slowly.
    landRate: 10,
    // Keyboard / click turn duration in ms.
    autoDuration: 950,
    // Quick clicking: turns asked for while a sheet is in the air are queued
    // (up to maxQueued) and played faster — hurrySpeed with one waiting, plus
    // hurryPerQueued for each further one, at most hurryMax. The last turn of
    // such a series runs at queuedSpeed. A single click is always speed 1.
    maxQueued: 12,
    hurrySpeed: 1.9,
    hurryPerQueued: 0.45,
    hurryMax: 3.4,
    queuedSpeed: 1.35,
    // Jumping through the book (Navigera i Koranen): the book is leafed
    // through — sheets flicked over one after the other, several in the air
    // at once — and a last sheet turns over and settles on the target.
    //   riffleCounts  sheets flicked over for a jump of up to riffleNear
    //                 spreads / up to riffleFar / further. More follow only
    //                 while the target's pages are still being rendered
    //                 (at most riffleMax).
    //   riffleMs      how long one of them takes to go over
    //   riffleGapMs   time between one sheet lifting and the next
    //   jumpMaxMs     the whole jump, landing included, aims to take no
    //                 longer than this: the last sheet lands at jumpLandSpeed
    //                 and speeds up (to at most jumpLandSpeedMax) if little
    //                 of the time is left.
    riffleNear: 10,
    riffleFar: 60,
    riffleCounts: [3, 9, 18],
    riffleMs: 460,
    riffleGapMs: 62,
    riffleMax: 44,
    jumpMaxMs: 3000,
    jumpLandSpeed: 1.3,
    jumpLandSpeedMax: 2.8,
    // The cover takes this much longer to swing open than a page takes to turn.
    coverSlowdown: 1.5,
    // How much faster than a page the cover settles once it is about to lie
    // flat (a stiff board, no long soft landing with a gap at the spine).
    coverLanding: 2.5,
    // Release speed (page widths per second) that completes a turn by itself.
    flickSpeed: 1.6
  },

  light: {
    // Direction towards the light, in screen space (x right, y down, z to viewer).
    direction: [0.48, -0.3, 0.82],
    diffuse: 0.5,
    // Extra darkening where the sheet turns away from the viewer, so the
    // bend reads even on the side facing the light.
    curveShade: 0.2,
    ambientFloor: 0.6,
    shadowStrength: 0.56,
    // Soft shadow straight below the sheet where it is close to the page.
    contactShadow: 0.38,
    shadowBlur: 16 // CSS px
  },

  // Shading of a page across its width: [position, alpha], position 0 = spine,
  // 1 = outer edge. Used both by the CSS overlay on the resting pages and by
  // the WebGL sheet, so the page looks identical when it starts to lift.
  pageShade: {
    dark: [
      [0, 0.36], [0.012, 0.24], [0.04, 0.115], [0.1, 0.04], [0.22, 0],
      [0.94, 0], [1, 0.05]
    ],
    light: [
      [0.03, 0], [0.085, 0.16], [0.2, 0]
    ]
  }
};
