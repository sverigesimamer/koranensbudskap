import { CONFIG } from './config.js';
import { PdfSource } from './pdf-source.js';
import { BookModel } from './book-model.js';
import { BookView } from './book-view.js';
import { QuranIndex } from './quran-index.js';
import { FlipRenderer } from './flip/flip-renderer.js';
import { FlipController } from './flip/flip-controller.js';
import { ZoomView } from './zoom-view.js';
import { QuranNavigator } from './navigator.js';
import { QuranPlayer } from './audio-player.js';

const $ = (sel) => document.querySelector(sel);
const toast = $('#toast');

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

async function start() {
  const source = new PdfSource();
  try {
    await source.load(CONFIG.volumes);
  } catch (err) {
    console.error(err);
    $('#loading').textContent = /^(localhost|127.0.0.1)$/.test(location.hostname)
      ? 'Kunde inte läsa PDF:en. Starta via start.cmd / node serve.mjs.'
      : 'PDF-filerna kunde inte hämtas.';
    return;
  }

  const model = new BookModel(source.pageCount, CONFIG.book.leadingBlanks);
  const view = new BookView($('#book'), $('#stage'), source, model);

  /** Page number within the PDF files (what the metadata is keyed by). */
  const pdfPage = (page) => (page ? source.pdfPageOf(page) : null);
  /** A page to bring into view once the book has got to its spread (one-page mode). */
  let pendingFocus = null;
  let following = true;
  let verseClick = 0;
  let playerRef = null;
  const pageInfo = $('#pageInfo');
  const juzSelect = $('#juzSelect');
  source.volumes.forEach((volume, i) => juzSelect.append(new Option(volume.label, String(i))));
  const hint = $('.hint');
  function updateInfo() {
    const { left, right } = model.spread(view.index);
    // Printed page numbers, as the pages lie on screen: left · right.
    const printed = (page) => {
      const pdfPage = source.pdfPageOf(page);
      const n = pdfPage ? pdfPage + CONFIG.book.printedPageOffset : 0;
      return n >= 1 && n <= source.pdfPageCount - 2 ? String(n) : null;
    };
    const numbers = [left, right].filter(Boolean).map(printed).filter(Boolean).join(' · ');
    const where = source.locate(left) || source.locate(right);
    pageInfo.textContent = [where?.volume.label, numbers && `s. ${numbers}`].filter(Boolean).join(' · ') || 'Omslag';
    if (where) juzSelect.value = String(where.index);
    // Has the reader leafed away from the verse being recited, or come back to it?
    const reciting = playerRef && playerRef.state;
    if (reciting && reciting.surah) {
      const page = QuranIndex.pageOfVerse(reciting.surah, reciting.ayah);
      following = pdfPage(left) === page || pdfPage(right) === page;
    }
    hint.textContent = view.isClosed
      ? 'Klicka på boken för att öppna den'
      : 'Dra i en sidkant för att bläddra · dubbelklicka på en sida för att zooma · ← nästa · → föregående';
    pageInfo.title = [right, left].map(pdfPage).filter(Boolean).map((p) => QuranIndex.pageLabel(p)).join(' | ');
  }

  let flip = null;
  try {
    const renderer = new FlipRenderer($('#flipCanvas'), { light: CONFIG.light, pageShade: CONFIG.pageShade });
    flip = new FlipController({
      view,
      renderer,
      canvas: $('#flipCanvas'),
      onTurned: (turned) => {
        // One page at a time: after a leaf has gone over, the page that
        // follows in reading order is the one to look at.
        if (view.single && turned && !turned.riffle) view.setFocus(turned.dir === 'next' ? 'right' : 'left');
        if (pendingFocus) {
          view.focusPage(pendingFocus);
          pendingFocus = null;
        }
        updateInfo();
      },
      onBlocked: (dir) => showToast(dir === 'next' ? 'Sista uppslaget' : 'Första uppslaget')
    });
  } catch (err) {
    console.error(err);
    showToast('WebGL2 saknas – sidvändningen visas utan animation');
  }

  // Reading zoom: while it is open the book underneath does not turn.
  const zoom = new ZoomView({
    el: $('#zoomView'),
    stageEl: $('#stage'),
    source,
    view,
    onChange: (open) => {
      if (flip) {
        if (open) flip.abort();
        flip.enabled = !open;
      }
    }
  });

  async function goToSpread(index) {
    if (!model.hasSpread(index)) return;
    flip?.abort();
    await view.showSpread(index);
    updateInfo();
  }

  /** Reading direction aware navigation: 'next' moves on, 'prev' goes back. */
  function turn(dir) {
    if (zoom.isOpen) return;
    if (view.single) {
      // One page at a time: first the other page of the spread, then the leaf.
      // (Reading order: the right-hand page comes before the left-hand one.)
      if (flip && flip.busy) return;
      const other = dir === 'next' ? 'left' : 'right';
      if (view.focus !== other && view.slots[other].page) {
        view.setFocus(other);
        return;
      }
    }
    if (flip) {
      flip.turn(dir);
    } else {
      const target = view.index + (dir === 'next' ? 1 : -1);
      if (model.hasSpread(target)) goToSpread(target);
    }
  }

  view.layout();
  await goToSpread(model.spreadOfPage(CONFIG.book.startPage));
  $('#loading').hidden = true;
  document.body.classList.add('ready');
  showToast(`${source.volumes.length} juz · ${source.pageCount} sidor`);

  // ---- input ----
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (zoom.isOpen) {
      // Arrow up/down, space and PageUp/PageDown scroll the zoomed page.
      if (e.key === 'Escape') zoom.close();
      return;
    }
    // Space / Enter on a focused button already clicks it.
    if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
    // Right-to-left book: moving on means going left.
    if (e.key === 'ArrowLeft' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); turn('next'); }
    if (e.key === 'ArrowRight' || e.key === 'PageUp') { e.preventDefault(); turn('prev'); }
  });

  // "Navigera i Koranen": sura / verse / juz / page.
  const printedOffset = CONFIG.book.printedPageOffset;
  new QuranNavigator({
    panel: $('#navPanel'),
    button: $('#navBtn'),
    data: {
      surahs: QuranIndex.surahs,
      juz: source.volumes.map((volume, i) => ({
        number: i + 1,
        label: volume.label,
        // The first juz starts on the page printed "1", after the unnumbered first page.
        pdfPage: volume.first === 1 ? 1 - printedOffset : volume.first
      })),
      pageCount: source.pdfPageCount - 2,
      pdfPageOfPrinted: (printed) => printed - printedOffset,
      pdfPageOfVerse: (surah, ayah) => QuranIndex.pageOfVerse(surah, ayah),
      currentSurah: () => {
        const { left, right } = model.spread(view.index);
        // The left page is the later one; a sura that begins on this spread wins.
        return QuranIndex.surahOnPage(pdfPage(left)) || QuranIndex.surahOnPage(pdfPage(right));
      }
    },
    onGo: async ({ pdfPage: target, label }) => {
      zoom.close();
      const spread = model.spreadOfPage(source.bookPageOf(target));
      // One page at a time: end up on the page that was asked for.
      pendingFocus = source.bookPageOf(target);
      if (spread === view.index) {
        view.focusPage(pendingFocus);
        pendingFocus = null;
      }
      // Leaf over to the spread; without the animation, just show it.
      if (zoom.isOpen || !flip || !flip.jumpTo(spread)) {
        await goToSpread(spread);
        if (pendingFocus) view.focusPage(pendingFocus, false);
        pendingFocus = null;
      }
      const printed = `sida ${target + printedOffset}`;
      showToast(label.toLowerCase() === printed ? label : `${label} · ${printed}`);
    }
  });

  // ---- phones: swipe, and full screen with the phone on its side ----
  {
    // A swipe across the page turns to the next / previous page. (A drag
    // that starts on the page's edge is the leaf being turned by hand — the
    // flip controller has that.)
    let start = null;
    const stage = $('#stage');
    stage.addEventListener('pointerdown', (e) => {
      start = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, time: performance.now() } : null;
    });
    stage.addEventListener('pointerup', (e) => {
      if (!start || !view.single || zoom.isOpen) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const quick = performance.now() - start.time < 700;
      start = null;
      if (flip && flip.session) return;
      // Right-to-left book: swiping to the right moves on, to the left goes back.
      if (quick && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx > 0 ? 'next' : 'prev');
    });

    const button = $('#fullscreenBtn');
    const coarse = window.matchMedia('(pointer: coarse)');
    const refresh = () => document.body.classList.toggle('can-rotate', coarse.matches || view.single || !!document.fullscreenElement);
    refresh();
    window.addEventListener('resize', refresh);
    document.addEventListener('fullscreenchange', () => {
      document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
      // Leaving full screen gives the phone its own orientation back.
      if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      refresh();
    });
    button.addEventListener('click', async () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
        return;
      }
      const root = document.documentElement;
      if (!root.requestFullscreen) {
        showToast('Vrid telefonen till liggande läge för att se två sidor');
        return;
      }
      try {
        await root.requestFullscreen({ navigationUI: 'hide' });
        // Two pages side by side need the wide way of the screen.
        if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
      } catch {
        showToast('Vrid telefonen till liggande läge för att se två sidor');
      }
    });
  }

  $('#nextBtn').addEventListener('click', () => turn('next'));
  $('#prevBtn').addEventListener('click', () => turn('prev'));

  let resizeTimer;
  window.addEventListener('resize', () => {
    flip?.abort();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      view.layout();
      await goToSpread(view.index);
      zoom.relayout();
    }, 160);
  });

  // Double-click / double-tap a page to read it zoomed in, and again to go back.
  const doubleTap = (el, handler) => {
    let last = null;
    el.addEventListener('click', (e) => {
      const now = performance.now();
      const isDouble = last && now - last.time < 400 &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30;
      last = isDouble ? null : { time: now, x: e.clientX, y: e.clientY };
      if (isDouble) handler(e);
    });
  };
  doubleTap($('#book'), (e) => {
    clearTimeout(verseClick);
    // A click on a page edge has already started turning the leaf.
    if (flip?.busy || view.isClosed) return;
    const pageEl = e.target.closest('.page');
    if (!pageEl || pageEl.classList.contains('is-empty')) return;
    const rect = pageEl.getBoundingClientRect();
    zoom.open(pageEl.classList.contains('page-left') ? 'left' : 'right', (e.clientY - rect.top) / rect.height);
  });
  doubleTap($('#zoomView'), () => {
    clearTimeout(verseClick);
    zoom.close();
  });

  // The closed book opens on a click anywhere on its cover. The front cover
  // swings up slowly and comes down straight onto Al-Fatihah, past the
  // title page.
  const openOnFatiha = () => {
    const fatiha = source.bookPageOf(QuranIndex.pageOfVerse(1, 1));
    const target = model.spreadOfPage(fatiha);
    pendingFocus = fatiha;
    if (!flip || !flip.jumpTo(target, { speed: CONFIG.book.openingSpeed })) {
      goToSpread(target).then(() => { view.focusPage(fatiha, false); pendingFocus = null; });
    }
  };
  if (flip) flip.onOpenCover = openOnFatiha;
  // At start the closed book opens by itself, unless someone got there first.
  if (CONFIG.book.autoOpenMs > 0) {
    setTimeout(() => {
      if (view.isClosed && view.closedSide === 'front' && !flip?.busy) openOnFatiha();
    }, CONFIG.book.autoOpenMs);
  }
  $('#book').addEventListener('click', (e) => {
    if (!view.isClosed || flip?.busy || !e.target.closest('.page.is-cover')) return;
    if (view.closedSide === 'front') openOnFatiha();
    else turn('prev');
  });
  $('#zoomClose').addEventListener('click', (e) => {
    e.stopPropagation();
    zoom.close();
  });

  // ---- recitation ----
  const playerEl = $('#player');
  const playerTitle = $('#playerTitle');
  const playerSub = $('#playerSub');
  const playerToggle = $('#playerToggle');
  playerSub.textContent = CONFIG.audio.reciter;

  /** Is the page a verse starts on part of the spread that is showing? */
  const verseShowing = (surah, ayah) => {
    const page = QuranIndex.pageOfVerse(surah, ayah);
    if (!page) return false;
    const { left, right } = model.spread(view.index);
    return pdfPage(left) === page || pdfPage(right) === page;
  };
  // While the reader stays with the recitation the book follows it; leafing
  // somewhere else stops that until they come back to the verse being read
  // (see updateInfo).

  // Zoomed in during recitation: the page scrolls along with the verse being
  // read (its Arabic text), and on to the next page when the verse is there.
  let zoomHop = null;
  const arabicOf = (bookPage, surah, ayah) => {
    const region = QuranIndex.regionsOnPage(pdfPage(bookPage)).find((r) => r.surah === surah && r.ayah === ayah);
    return region ? region.arabic : [];
  };
  const followZoomed = (surah, ayah, versePage) => {
    // The verse starts on this page, or carries over to it from the one before.
    const here = arabicOf(zoom.page, surah, ayah);
    if (zoom.page === versePage || here.length) {
      zoom.showAreas(here.length ? here : arabicOf(versePage, surah, ayah));
      return;
    }
    if (zoomHop) return;
    // On another page: out of the zoom, over to that page, and in again.
    const hop = zoomHop = { surah, ayah };
    zoom.close();
    setTimeout(async () => {
      try {
        const spread = model.spreadOfPage(versePage);
        if (spread !== view.index) {
          if (spread === view.index + 1 && flip) flip.turn('next');
          else if (!flip || !flip.jumpTo(spread)) await goToSpread(spread);
          while (flip && (flip.busy || flip.starting)) await new Promise((r) => setTimeout(r, 60));
        }
        if (!following || zoom.isOpen) return;
        const side = view.slots.left.page === versePage ? 'left' : 'right';
        const areas = arabicOf(versePage, hop.surah, hop.ayah);
        zoom.open(side, areas.length ? areas[0][1] + areas[0][3] / 2 : 0);
      } finally {
        zoomHop = null;
      }
    }, 520);
  };

  const player = new QuranPlayer({
    config: CONFIG.audio,
    surahCount: QuranIndex.surahs.length,
    onVerse: (surah, ayah) => {
      view.highlighted = new Set([`${surah}:${ayah}`]);
      view.refreshLayers();
      const versePage = source.bookPageOf(QuranIndex.pageOfVerse(surah, ayah));
      if (following && zoom.isOpen) {
        followZoomed(surah, ayah, versePage);
        return;
      }
      if (following && !verseShowing(surah, ayah)) {
        const spread = model.spreadOfPage(versePage);
        pendingFocus = versePage;
        if (spread === view.index + 1 && flip) flip.turn('next');
        else if (!flip || !flip.jumpTo(spread)) goToSpread(spread).then(() => view.focusPage(versePage, false));
      } else if (following && view.single) {
        // On the spread already, but perhaps on its other page.
        view.focusPage(versePage);
      }
    },
    onState: ({ status, surah, ayah, stored }) => {
      const playing = status === 'playing' || status === 'loading';
      playerToggle.textContent = playing ? '⏸' : '▶';
      playerToggle.setAttribute('aria-label', playing ? 'Pausa' : 'Spela upp');
      playerEl.classList.toggle('is-loading', status === 'loading');
      if (surah) {
        playerTitle.textContent = `${QuranIndex.surahs[surah - 1].name} ${surah}:${ayah}`;
        playerSub.textContent = status === 'error' ? 'Kunde inte hämta ljudet'
          : status === 'loading' ? 'Hämtar …'
            : `${CONFIG.audio.reciter}${stored ? ' · sparad i webbläsaren' : ''}`;
      } else {
        playerTitle.textContent = 'Lyssna från den här sidan';
        playerSub.textContent = CONFIG.audio.reciter;
      }
    }
  });
  playerRef = player;

  /** Start reciting at a verse the reader chose; the book then follows along. */
  const playVerse = (surah, ayah) => {
    following = true;
    player.play(surah, ayah);
  };

  playerToggle.addEventListener('click', () => {
    if (player.isPlaying) {
      player.pause();
    } else if (player.state.surah && verseShowing(player.state.surah, player.state.ayah)) {
      following = true;
      player.resume();
    } else {
      // Nothing chosen (or the reader has leafed elsewhere): start with the
      // first verse on the spread — its right-hand page comes first.
      const { left, right } = model.spread(view.index);
      const first = QuranIndex.versesOnPage(pdfPage(right))[0] || QuranIndex.versesOnPage(pdfPage(left))[0];
      if (first) playVerse(first.surah, first.from);
      else showToast('Öppna en sida med text för att lyssna');
    }
  });
  $('#playerPrev').addEventListener('click', () => { following = true; player.step(-1); });
  $('#playerNext').addEventListener('click', () => { following = true; player.step(1); });

  // A click on a verse recites from it. The click waits a moment, so that a
  // double-click (zoom) does not also start the recitation.
  $('#stage').addEventListener('verse:activate', (e) => {
    clearTimeout(verseClick);
    const { surah, ayah } = e.detail;
    verseClick = setTimeout(() => playVerse(surah, ayah), 280);
  });
  view.onRegions = () => { if (zoom.isOpen) zoom.refreshLayers(); };

  // ---- settings ----
  const panel = $('#settingsPanel');
  const setPanel = (open) => {
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', String(!open));
  };
  $('#settingsBtn').addEventListener('click', () => setPanel(!panel.classList.contains('open')));
  $('#closeSettings').addEventListener('click', () => setPanel(false));
  // Night mode (warm light, like Night Shift); remembered in this browser.
  const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
  const recall = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const nightToggle = $('#nightToggle');
  const warmth = $('#warmth');
  const setNight = (on) => {
    document.body.classList.toggle('night', on);
    $('#warmthRow').hidden = !on;
    remember('kb-night', on ? '1' : '0');
  };
  const setWarmth = (value) => {
    $('#nightShift').style.setProperty('--warmth', value);
    remember('kb-warmth', value);
  };
  if (recall('kb-warmth')) warmth.value = recall('kb-warmth');
  setWarmth(warmth.value);
  nightToggle.checked = recall('kb-night') === '1';
  setNight(nightToggle.checked);
  nightToggle.addEventListener('change', () => setNight(nightToggle.checked));
  warmth.addEventListener('input', () => setWarmth(warmth.value));
  $('#hotspotToggle').addEventListener('change', (e) => {
    view.debugHotspots = e.target.checked;
    view.refreshLayers();
    if (zoom.isOpen) zoom.refreshLayers();
    if (!QuranIndex.regionsOnPage(pdfPage(view.slots.left.page)).length && !QuranIndex.regionsOnPage(pdfPage(view.slots.right.page)).length) {
      showToast('Klicklagret är redo – inga verser är mappade ännu');
    }
  });
  const pageJump = $('#pageJump');
  pageJump.max = String(source.pdfPageCount - 2);
  $('#jumpBtn').addEventListener('click', async () => {
    zoom.close();
    const target = Number(pageJump.value) - CONFIG.book.printedPageOffset;
    await goToSpread(model.spreadOfPage(source.bookPageOf(target)));
    setPanel(false);
  });
  juzSelect.addEventListener('change', async () => {
    zoom.close();
    setPanel(false);
    const volume = source.volumes[Number(juzSelect.value)];
    // The first juz opens on its first text page (the page printed "1").
    const first = volume.first === 1 ? 1 - CONFIG.book.printedPageOffset : volume.first;
    await goToSpread(model.spreadOfPage(source.bookPageOf(first)));
  });

  // Handy while tuning from the console.
  window.quranBook = { view, model, source, flip, zoom, player, turn, goToSpread, config: CONFIG };
}

start();
