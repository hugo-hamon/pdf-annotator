/* global acquireVsCodeApi, pdfjsLib */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const COLORS = ['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5', '#e56eee', '#f19837', '#aaaaaa'];
  const TYPE_LABEL = { highlight: 'Highlight', underline: 'Underline', note: 'Note' };
  const NOTE_SVG = '<svg viewBox="0 0 24 24"><path d="M3 3h18v14H9l-6 5z"/></svg>';

  const $ = (s) => document.querySelector(s);
  const viewerEl = $('#viewer');
  const pagesEl = $('#pages');
  const cardsEl = $('#cards');

  const saved = vscode.getState() || {};
  let scale = saved.scale || 0;
  let color = saved.color || COLORS[0];
  let tool = 'select';
  let pdfDoc = null;
  let pages = [];
  let annotations = [];
  let selectedId = null;
  let pendingSelect = null; // { id, focus }: select the annotation after host confirmation
  let justCreated = false;
  let observer = null;
  let loadId = 0;
  let zoomTimer = null;
  let zoomFrame = null;
  let displayScale = scale;
  let zoomAnchor = null;
  const palette = $('#selectionPalette');

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (s) => CSS.escape(s);

  // ------------------------------------------------------------ toolbar

  const colorsEl = $('#colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.title = 'Color ' + c;
    colorsEl.appendChild(b);
  }
  // Keep the selected text when interacting with the annotation palette.
  palette.addEventListener('mousedown', (e) => e.preventDefault());
  palette.addEventListener('pointerdown', (e) => e.stopPropagation());

  colorsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    color = b.dataset.color;
    vscode.setState({ scale, color });
    updateToolbar();
    applySelection('highlight', color);
  });
  $('#markHighlight').addEventListener('click', () => applySelection('highlight', color));
  $('#markUnderline').addEventListener('click', () => applySelection('underline', color));
  $('#noteTool').addEventListener('click', () => setTool(tool === 'note' ? 'select' : 'note'));
  $('#zoomIn').addEventListener('click', () => setScale(scale * 1.15));
  $('#zoomOut').addEventListener('click', () => setScale(scale / 1.15));
  $('#fit').addEventListener('click', () => pages[0] && setScale(fitScale(pages[0].page)));
  $('#toggleSide').addEventListener('click', () => {
    const hidden = document.body.classList.toggle('no-side');
    const button = $('#toggleSide');
    button.textContent = hidden ? 'Show annotations' : 'Hide annotations';
    button.title = hidden ? 'Open the annotations panel' : 'Close the annotations panel';
    button.setAttribute('aria-expanded', String(!hidden));
  });
  $('#export').addEventListener('click', () => {
    flush();
    vscode.postMessage({ type: 'export' });
  });
  viewerEl.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setScale(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );

  function setTool(t) {
    tool = t;
    document.body.dataset.tool = t;
    hidePalette();
    updateToolbar();
  }
  function updateToolbar() {
    $('#noteTool').classList.toggle('active', tool === 'note');
    document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === color));
    $('#zoomLabel').textContent = Math.round(scale * 100) + ' %';
  }

  // ------------------------------------------------------------ loading

  async function openPdf(msg) {
    const start = performance.now();
    const timing = (phase) => vscode.postMessage({ type: 'performance', phase, elapsed: performance.now() - start });
    const id = ++loadId;
    clearTimeout(zoomTimer);
    zoomTimer = null;
    if (zoomFrame !== null) cancelAnimationFrame(zoomFrame);
    zoomFrame = null;
    annotations = msg.annotations || [];
    selectedId = null;
    if (observer) observer.disconnect();
    if (pdfDoc) {
      try {
        await pdfDoc.destroy();
      } catch (e) {
        /* ignored */
      }
    }
    pagesEl.replaceChildren();
    pages = [];
    renderCards();

    pdfjsLib.GlobalWorkerOptions.workerSrc = window.PDFJS.worker;
    // Base64 avoids differences in Uint8Array serialization between VS Code
    // versions (some versions may otherwise produce an empty buffer).
    const bytes = typeof msg.data === 'string'
      ? Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0))
      : new Uint8Array(msg.data);
    if (!bytes.byteLength) {
      pagesEl.textContent = 'The received PDF is empty. Close and reopen this tab.';
      timing('error: zero bytes received');
      return;
    }
    timing('bytes received / converted');
    try {
      pdfDoc = await pdfjsLib.getDocument({
        data: bytes,
        isEvalSupported: false,
        cMapUrl: window.PDFJS.base + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: window.PDFJS.base + 'standard_fonts/',
      }).promise;
    } catch (err) {
      pagesEl.textContent = 'Could not open this PDF: ' + (err && err.message);
      return;
    }
    if (id !== loadId) return;
    timing('document loaded by pdf.js');

    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const p = pages[Number(e.target.dataset.index)];
          if (!p) continue;
          if (e.isIntersecting && zoomTimer === null) renderPage(p);
          else if (p.rendered) unrender(p);
        }
      },
      { root: viewerEl, rootMargin: '1200px 0px' },
    );

    // Render the first page immediately while the remaining pages are prepared.
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      if (id !== loadId) return;
      if (!scale) scale = fitScale(page);
      if (i === 1) displayScale = scale;
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.index = String(i - 1);
      div.innerHTML = '<canvas></canvas><div class="hl-layer"></div><div class="textLayer"></div><div class="note-layer"></div>';
      pagesEl.appendChild(div);
      const p = {
        index: i - 1, page, div, token: 0, rendered: false, task: null, viewport: null,
        canvas: div.children[0], hl: div.children[1], text: div.children[2], notes: div.children[3],
      };
      pages.push(p);
      sizePage(p);
      if (i === 1) {
        updateToolbar();
        updatePageInfo();
        // Start rendering before the asynchronous IntersectionObserver fires.
        void renderPage(p).then(() => timing('first page rendered'));
      }
      // Allow the browser to paint and handle scrolling between batches.
      if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    drawAll();
    updatePageInfo();
    fillQuotes();
  }

  function fitScale(page) {
    const w = page.getViewport({ scale: 1 }).width;
    return clamp((viewerEl.clientWidth - 48) / w, 0.5, 3);
  }

  function sizePage(p, observe = true) {
    const previousWidth = p.viewport?.width;
    const keepPreview = p.canvas.width > 0;
    p.viewport = p.page.getViewport({ scale });
    p.div.style.width = p.viewport.width + 'px';
    p.div.style.height = p.viewport.height + 'px';
    p.div.style.setProperty('--scale-factor', String(scale));
    // Stretch the previous image while the sharp replacement is rendered.
    unrender(p, keepPreview);
    if (keepPreview && previousWidth) {
      p.canvas.style.width = p.viewport.width + 'px';
      p.canvas.style.height = p.viewport.height + 'px';
      const factor = p.viewport.width / (p.paintedWidth || previousWidth);
      p.text.style.transform = `scale(${factor})`;
      p.text.style.transformOrigin = 'top left';
    }
    if (observe) {
      observer.unobserve(p.div);
      observer.observe(p.div);
    }
  }

  function captureZoomAnchor(point) {
    const viewerRect = viewerEl.getBoundingClientRect();
    const x = clamp(point?.x ?? viewerRect.left + viewerRect.width / 2, viewerRect.left + 1, viewerRect.right - 1);
    const y = clamp(point?.y ?? viewerRect.top + viewerRect.height / 2, viewerRect.top + 1, viewerRect.bottom - 1);
    let target = null;
    let distance = Infinity;
    for (const p of pages) {
      const r = p.div.getBoundingClientRect();
      const d = Math.max(r.top - y, y - r.bottom, 0);
      if (d < distance) { distance = d; target = { page: p, rect: r }; }
    }
    if (!target) return null;
    return {
      page: target.page, x, y,
      u: (x - target.rect.left) / target.rect.width,
      v: (y - target.rect.top) / target.rect.height,
    };
  }

  function applyZoomFrame() {
    zoomFrame = null;
    displayScale = scale;
    pages.forEach((p) => sizePage(p, false));
    drawAll();
    if (zoomAnchor) {
      const r = zoomAnchor.page.div.getBoundingClientRect();
      viewerEl.scrollLeft += r.left + zoomAnchor.u * r.width - zoomAnchor.x;
      viewerEl.scrollTop += r.top + zoomAnchor.v * r.height - zoomAnchor.y;
      zoomAnchor = null;
    }
    updatePageInfo();
  }

  function setScale(s, point) {
    s = clamp(s, 0.3, 4);
    if (!pages.length || Math.abs(s - scale) < 0.001) return;
    zoomAnchor = captureZoomAnchor(point);
    scale = s;
    vscode.setState({ scale, color });
    hidePalette();
    updateToolbar();
    clearTimeout(zoomTimer);
    // Wheel events can outpace painting; update geometry once per frame.
    if (zoomFrame === null) zoomFrame = requestAnimationFrame(applyZoomFrame);
    // A zoom gesture should trigger only one high-resolution render pass.
    zoomTimer = setTimeout(() => {
      zoomTimer = null;
      // Complete the last scaling frame before rendering.
      if (zoomFrame !== null) {
        cancelAnimationFrame(zoomFrame);
        applyZoomFrame();
      }
      const top = viewerEl.getBoundingClientRect().top;
      const bottom = viewerEl.getBoundingClientRect().bottom;
      for (const p of pages) {
        const rect = p.div.getBoundingClientRect();
        if (rect.bottom >= top - 300 && rect.top <= bottom + 300) void renderPage(p);
      }
    }, 120);
  }

  async function renderPage(p) {
    if (p.rendered) return;
    p.rendered = true;
    const token = ++p.token;
    const vp = p.viewport;
    const dpr = window.devicePixelRatio || 1;
    // Render off-screen to keep the previous canvas visible until replacement.
    const nextCanvas = document.createElement('canvas');
    nextCanvas.width = Math.floor(vp.width * dpr);
    nextCanvas.height = Math.floor(vp.height * dpr);
    nextCanvas.style.width = vp.width + 'px';
    nextCanvas.style.height = vp.height + 'px';
    try {
      p.task = p.page.render({
        canvasContext: nextCanvas.getContext('2d'),
        viewport: vp,
        transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
      });
      await p.task.promise;
      if (token !== p.token) return;
      // Replace the blurred preview with the sharp canvas.
      p.canvas.replaceWith(nextCanvas);
      p.canvas = nextCanvas;
      p.paintedWidth = vp.width;
      p.task = null;
      const content = await p.page.getTextContent();
      if (token !== p.token) return;
      // Prepare the selectable text layer before replacing the previous one.
      const nextText = document.createElement('div');
      nextText.className = 'textLayer';
      const textTask = pdfjsLib.renderTextLayer({ textContentSource: content, container: nextText, viewport: vp, textDivs: [] });
      await textTask.promise;
      if (token !== p.token) return;
      p.text.replaceChildren(...nextText.childNodes);
      p.text.style.transform = '';
    } catch (err) {
      if (!err || err.name !== 'RenderingCancelledException') console.error(err);
      if (token === p.token) p.rendered = false;
    }
  }

  function unrender(p, keepPreview = false) {
    p.token++;
    if (p.task) {
      try {
        p.task.cancel();
      } catch (e) {
        /* ignored */
      }
      p.task = null;
    }
    p.rendered = false;
    if (!keepPreview) {
      p.canvas.width = 0;
      p.canvas.height = 0;
      p.paintedWidth = 0;
      p.text.replaceChildren();
      p.text.style.transform = '';
    }
  }

  function updatePageInfo() {
    if (!pages.length) return;
    const mid = viewerEl.getBoundingClientRect().top + viewerEl.clientHeight / 3;
    let current = 1;
    for (const p of pages) {
      if (p.div.getBoundingClientRect().top <= mid) current = p.index + 1;
      else break;
    }
    $('#pageInfo').textContent = current + ' / ' + pages.length;
  }
  let raf = 0;
  viewerEl.addEventListener(
    'scroll',
    () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), updatePageInfo()));
    },
    { passive: true },
  );

  // ------------------------------------------------------ annotation overlays

  function drawOverlay(p, list) {
    p.hl.replaceChildren();
    p.notes.replaceChildren();
    if (!p.viewport) return;
    for (const a of list) {
      for (const r of a.rects) {
        const [x1, y1, x2, y2] = p.viewport.convertToViewportRectangle(r);
        const d = document.createElement('div');
        d.dataset.id = a.id;
        d.style.cssText =
          `left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;` +
          `height:${Math.abs(y2 - y1)}px;--c:${a.color}`;
        if (a.type === 'note') {
          d.className = 'note';
          d.innerHTML = NOTE_SVG;
          p.notes.appendChild(d);
        } else {
          d.className = 'hl ' + a.type;
          p.hl.appendChild(d);
        }
      }
    }
  }

  function drawAll() {
    const byPage = new Map();
    for (const a of annotations) {
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(a);
    }
    pages.forEach((p) => drawOverlay(p, byPage.get(p.index) || []));
    markSelection();
  }

  function markSelection() {
    document.querySelectorAll('.sel').forEach((el) => el.classList.remove('sel'));
    if (selectedId) document.querySelectorAll(`[data-id="${esc(selectedId)}"]`).forEach((el) => el.classList.add('sel'));
  }

  function select(id, focus) {
    selectedId = id;
    markSelection();
    if (!id) return;
    const card = cardsEl.querySelector(`.card[data-id="${esc(id)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    if (focus) card.querySelector('textarea').focus({ preventScroll: true });
  }

  function scrollToAnnotation(a) {
    const p = pages[a.page];
    if (!p || !p.viewport) return;
    const [, y1, , y2] = p.viewport.convertToViewportRectangle(a.rects[0]);
    const pageTop = p.div.getBoundingClientRect().top - viewerEl.getBoundingClientRect().top + viewerEl.scrollTop;
    viewerEl.scrollTo({ top: pageTop + Math.min(y1, y2) - 80, behavior: 'smooth' });
  }

  // ----------------------------------------------------------- sidebar

  const topOf = (a) => Math.max(...a.rects.map((r) => r[3]));
  const compare = (a, b) => a.page - b.page || topOf(b) - topOf(a) || a.rects[0][0] - b.rects[0][0];

  function renderCards() {
    const active = document.activeElement;
    const keep =
      active && active.tagName === 'TEXTAREA' && active.closest('.card')
        ? { id: active.closest('.card').dataset.id, start: active.selectionStart, end: active.selectionEnd }
        : null;
    cardsEl.replaceChildren();
    if (!annotations.length) {
      cardsEl.innerHTML = '<p class="empty">No annotations yet. Select text to highlight it, or choose the Note tool.</p>';
      return;
    }
    for (const a of [...annotations].sort(compare)) cardsEl.appendChild(makeCard(a));
    if (keep) {
      const ta = cardsEl.querySelector(`.card[data-id="${esc(keep.id)}"] textarea`);
      if (ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(keep.start, keep.end);
      }
    }
    markSelection();
  }

  function makeCard(a) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = a.id;
    el.style.setProperty('--c', a.color);

    const head = document.createElement('div');
    head.className = 'card-head';
    const label = document.createElement('span');
    label.textContent = `p. ${a.page + 1} · ${TYPE_LABEL[a.type]}`;
    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      flush();
      vscode.postMessage({ type: 'remove', id: a.id });
    });
    head.append(label, del);
    el.append(head);

    if (a.text) {
      const q = document.createElement('blockquote');
      q.textContent = a.text;
      el.append(q);
    }

    const ta = document.createElement('textarea');
    ta.placeholder = a.type === 'note' ? 'Write a note…' : 'Add a comment…';
    ta.value = a.comment || '';
    ta.rows = clamp((a.comment || '').split('\n').length + 1, 2, 8);
    ta.addEventListener('input', () => onComment(a.id, ta.value));
    ta.addEventListener('blur', flush);
    ta.addEventListener('focus', () => select(a.id, false));
    el.append(ta);

    const colors = document.createElement('div');
    colors.className = 'card-colors';
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch' + (c === a.color ? ' active' : '');
      b.style.setProperty('--c', c);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'update', id: a.id, patch: { color: c } });
      });
      colors.append(b);
    }
    el.append(colors);

    el.addEventListener('click', () => {
      select(a.id, false);
      scrollToAnnotation(a);
    });
    return el;
  }

  // Debounce comment updates; Ctrl+S and focus loss flush them immediately.
  let pending = null;
  let timer = 0;
  function onComment(id, value) {
    const a = annotations.find((x) => x.id === id);
    if (a) a.comment = value;
    pending = { id, value };
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }
  function flush() {
    clearTimeout(timer);
    if (!pending) return;
    vscode.postMessage({ type: 'update', id: pending.id, patch: { comment: pending.value } });
    pending = null;
  }

  // ------------------------------------------------- text selection and annotations

  function collectSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const groups = [];
    for (const p of pages) {
      if (!p.rendered || !range.intersectsNode(p.text)) continue;
      const box = p.div.getBoundingClientRect();
      const items = [];
      for (const span of p.text.querySelectorAll('span')) {
        const tn = span.firstChild;
        if (!tn || tn.nodeType !== Node.TEXT_NODE || !range.intersectsNode(span)) continue;
        const r = document.createRange();
        r.setStart(tn, tn === range.startContainer ? range.startOffset : 0);
        r.setEnd(tn, tn === range.endContainer ? range.endOffset : tn.length);
        const str = r.toString();
        const rc = r.getBoundingClientRect();
        if (!str.trim() || rc.width < 1 || rc.height < 1) continue;
        items.push({ x: rc.left - box.left, y: rc.top - box.top, w: rc.width, h: rc.height, str });
      }
      if (items.length) groups.push({ p, items });
    }
    return groups;
  }

  /** Merge nearby rectangles on the same line for consistent highlights. */
  function mergeRects(items) {
    const lines = [];
    for (const r of [...items].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
      const cy = r.y + r.h / 2;
      const line = lines.find((l) => Math.abs(cy - l.cy) < Math.min(l.h, r.h) * 0.5);
      if (line) line.items.push(r);
      else lines.push({ cy, h: r.h, items: [r] });
    }
    const out = [];
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      let cur = { x: l.items[0].x, y: l.items[0].y, w: l.items[0].w, h: l.items[0].h };
      for (const r of l.items.slice(1)) {
        if (r.x - (cur.x + cur.w) < 4) {
          const x2 = Math.max(cur.x + cur.w, r.x + r.w);
          const y1 = Math.min(cur.y, r.y);
          const y2 = Math.max(cur.y + cur.h, r.y + r.h);
          cur = { x: cur.x, y: y1, w: x2 - cur.x, h: y2 - y1 };
        } else {
          out.push(cur);
          cur = { x: r.x, y: r.y, w: r.w, h: r.h };
        }
      }
      out.push(cur);
    }
    return out;
  }

  function buildQuote(items) {
    let s = '';
    let prev = null;
    for (const it of items) {
      if (prev) {
        const sameLine = Math.abs(it.y + it.h / 2 - (prev.y + prev.h / 2)) < Math.min(it.h, prev.h) * 0.6;
        if (sameLine) {
          if (it.x - (prev.x + prev.w) > 1.5 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
        } else if (/[A-Za-zÀ-ÿ]-$/.test(s) && /^[a-zà-ÿ]/.test(it.str)) {
          s = s.slice(0, -1); // hyphenated line break
        } else {
          s += ' ';
        }
      }
      s += it.str;
      prev = it;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  function toPdfRect(p, r) {
    const [ax, ay] = p.viewport.convertToPdfPoint(r.x, r.y);
    const [bx, by] = p.viewport.convertToPdfPoint(r.x + r.w, r.y + r.h);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)].map((v) => +v.toFixed(2));
  }

  function hidePalette() {
    palette.hidden = true;
  }

  function showSelectionPalette() {
    if (tool === 'note') return hidePalette();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !collectSelection().length) return hidePalette();
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) return hidePalette();
    palette.hidden = false;
    const width = palette.offsetWidth;
    const height = palette.offsetHeight;
    palette.style.left = clamp(rect.left + rect.width / 2 - width / 2, 8, window.innerWidth - width - 8) + 'px';
    const above = rect.top - height - 9;
    palette.style.top = clamp(above >= 8 ? above : rect.bottom + 9, 8, window.innerHeight - height - 8) + 'px';
  }

  function applySelection(annotationType = 'highlight', annotationColor = color) {
    const groups = collectSelection();
    if (!groups.length) return false;
    justCreated = true;
    setTimeout(() => (justCreated = false), 80);
    for (const { p, items } of groups) {
      const a = {
        id: uid(), type: annotationType, page: p.index, color: annotationColor,
        rects: mergeRects(items).map((r) => toPdfRect(p, r)),
        text: buildQuote(items), comment: '',
      };
      pendingSelect = { id: a.id, focus: false };
      vscode.postMessage({ type: 'add', annotation: a });
    }
    window.getSelection().removeAllRanges();
    hidePalette();
    return true;
  }
  viewerEl.addEventListener('mouseup', () => setTimeout(showSelectionPalette, 0));
  viewerEl.addEventListener('scroll', hidePalette, { passive: true });
  viewerEl.addEventListener('mousedown', () => hidePalette());
  window.addEventListener('keyup', (e) => {
    if (e.key.startsWith('Arrow') || e.key === 'Shift') showSelectionPalette();
  });

  function addNote(p, x, y) {
    const [px, py] = p.viewport.convertToPdfPoint(x, y);
    const size = 20;
    const a = { id: uid(), type: 'note', page: p.index, color, rects: [[px, py - size, px + size, py]], text: '', comment: '' };
    pendingSelect = { id: a.id, focus: true };
    vscode.postMessage({ type: 'add', annotation: a });
    setTool('select');
  }

  viewerEl.addEventListener('click', (e) => {
    if (justCreated) return;
    const pageEl = e.target.closest('.page');
    if (!pageEl) return;
    const p = pages[Number(pageEl.dataset.index)];
    if (!p || !p.viewport) return;
    const noteEl = e.target.closest('.note');
    if (noteEl) {
      select(noteEl.dataset.id, true);
      return;
    }
    const box = pageEl.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    if (tool === 'note') {
      addNote(p, x, y);
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const [px, py] = p.viewport.convertToPdfPoint(x, y);
    const hit = [...annotations]
      .reverse()
      .find((a) => a.type !== 'note' && a.page === p.index && a.rects.some((r) => px >= r[0] && px <= r[2] && py >= r[1] && py <= r[3]));
    select(hit ? hit.id : null, !!hit);
  });

  // ------------------------------- quoted text from external annotations

  function textInRect(items, [x1, y1, x2, y2]) {
    let s = '';
    for (const it of items) {
      if (!it.str) continue;
      const [, , , d, tx, ty] = it.transform;
      const h = it.height || Math.abs(d);
      const cy = ty + h * 0.3;
      if (cy < y1 || cy > y2 || tx + it.width < x1 || tx > x2) continue;
      const n = it.str.length;
      const from = it.width > 0 ? clamp(Math.floor(((x1 - tx) / it.width) * n), 0, n) : 0;
      const to = it.width > 0 ? clamp(Math.ceil(((x2 - tx) / it.width) * n), 0, n) : n;
      s += it.str.slice(from, to) + (it.hasEOL ? ' ' : '');
    }
    return s;
  }

  async function fillQuotes() {
    const byPage = new Map();
    for (const a of annotations) {
      if (a.type === 'note' || a.text) continue;
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(a);
    }
    const updates = [];
    for (const [index, list] of byPage) {
      try {
        const content = await (await pdfDoc.getPage(index + 1)).getTextContent();
        for (const a of list) {
          const text = a.rects.map((r) => textInRect(content.items, r)).join(' ').replace(/\s+/g, ' ').trim();
          if (text) {
            a.text = text;
            updates.push({ id: a.id, text });
          }
        }
      } catch (e) {
        /* unreadable page: leave the quote empty */
      }
    }
    if (updates.length) {
      vscode.postMessage({ type: 'quotes', updates });
      renderCards();
    }
  }

  // ---------------------------------------------------------- keyboard and messages

  window.addEventListener(
    'keydown',
    (e) => {
      // Flush pending comments before VS Code handles the save shortcut.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') flush();
      if (e.target.tagName === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case 'v': setTool('select'); break;
        case 'h': applySelection('highlight'); break;
        case 'u': applySelection('underline'); break;
        case 'n': setTool('note'); break;
        case 'Escape': setTool('select'); select(null); break;
        case 'Delete':
        case 'Backspace':
          if (selectedId) vscode.postMessage({ type: 'remove', id: selectedId });
          break;
      }
    },
    true,
  );
  window.addEventListener('blur', flush);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'load') {
      openPdf(m);
    } else if (m.type === 'annotations') {
      annotations = m.annotations;
      if (selectedId && !annotations.some((a) => a.id === selectedId)) selectedId = null;
      drawAll();
      renderCards();
      if (pendingSelect) {
        const wanted = pendingSelect;
        pendingSelect = null;
        const a = annotations.find((x) => x.id === wanted.id);
        if (a) select(a.id, wanted.focus);
      }
    }
  });

  setTool('select');
  vscode.postMessage({ type: 'ready' });
})();
