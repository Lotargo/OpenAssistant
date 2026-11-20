/** Synthetic display-only probe shared by offline tests and parent native CDP QA.
 * It never starts an assistant session or audio. The owner supplies a page.
 */
export async function recordStreamTrace(page, { mode = 'characters', native = false, gap = 45, chunks = 24, finish = true } = {}) {
  return page.evaluate(async options => {
    const h = window.__nativeContract;
    const emit = options.native
      ? (event, payload) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
        target: { kind: 'WebviewWindow', label: 'main' }, event, payload,
      })
      : (event, payload) => h.emit(event, payload);
    const samples = [];
    const begin = performance.now();
    let complete = false;
    let chars = 0;
    const resizeStart = h?.resizes.length || 0;
    const hitStart = h?.calls.filter(call => call.name === 'update_hit_rects').length || 0;
    function glyph(element) {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      if (!text?.length) return null;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, Math.min(3, text.length));
      const rect = range.getBoundingClientRect();
      const panel = document.querySelector('#text-panel').getBoundingClientRect();
      const overlay = document.querySelector('#overlay').getBoundingClientRect();
      const visibleTop = Math.max(0, panel.top, overlay.top);
      const visibleBottom = Math.min(innerHeight, panel.bottom, overlay.bottom);
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        visible: rect.bottom > visibleTop + 1 && rect.top < visibleBottom - 1 && rect.right > 0 && rect.left < innerWidth };
    }
    function sample() {
      const content = document.querySelector('#text-content');
      const panel = document.querySelector('#text-panel');
      const rect = document.querySelector('#overlay').getBoundingClientRect();
      const paragraphs = content.querySelectorAll('p');
      const overlayStyle = getComputedStyle(document.querySelector('#overlay'));
      const panelStyle = getComputedStyle(panel);
      const heightCap = parseFloat(overlayStyle.getPropertyValue('--overlay-max-height')) || 760;
      const naturalHeight = content.getBoundingClientRect().height
        + parseFloat(panelStyle.paddingTop) + parseFloat(panelStyle.paddingBottom)
        + document.querySelector('#toolbar').getBoundingClientRect().height + 2;
      samples.push({
        t: performance.now() - begin, wall: Date.now(), chars, heightCap, naturalHeight,
        first: paragraphs[0] ? glyph(paragraphs[0]) : null,
        second: paragraphs[1] ? glyph(paragraphs[1]) : null,
        anchors: [...paragraphs].map((paragraph, index) => ({ index, ...glyph(paragraph) })).filter(anchor => anchor.visible),
        contentHeight: content.getBoundingClientRect().height,
        contentWidth: content.getBoundingClientRect().width,
        overlayHeight: rect.height, overlayTop: rect.top, overlayBottom: rect.bottom,
        viewport: innerHeight, width: innerWidth, screenX, screenY, outerHeight,
        scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
        resizeCount: h ? h.resizes.length - resizeStart : null,
        hitCount: h ? h.calls.filter(call => call.name === 'update_hit_rects').length - hitStart : null,
      });
      if (!complete) requestAnimationFrame(sample);
    }
    await emit('assistant:turn-start', {});
    await emit('assistant:chunk', { text: '<mode>text</mode><text>Уже показанная строка.\n\n' });
    requestAnimationFrame(sample);
    await new Promise(resolve => setTimeout(resolve, 280));
    const text = 'Новая фраза постепенно дополняет абзац, сохраняя ранее показанные слова. '.repeat(7);
    let offset = 0;
    while (offset < (options.mode === 'paragraphs' ? options.chunks : text.length)) {
      const chunk = options.mode === 'paragraphs' ? 'Ещё одна строка ' + offset + '.\n\n' : text.slice(offset, offset + 7);
      offset += options.mode === 'paragraphs' ? 1 : 7;
      chars += chunk.length;
      await emit('assistant:chunk', { text: chunk });
      await new Promise(resolve => setTimeout(resolve, options.gap));
    }
    if (options.finish) {
      await emit('assistant:chunk', { text: '</text>' });
      await emit('assistant:turn-end', {});
    }
    await new Promise(resolve => setTimeout(resolve, 450));
    complete = true;
    return { mode: options.mode, samples, resizes: h?.resizes.slice(resizeStart) || [],
      captures: h?.captureIds.length ?? null, sessions: h?.sessionIds.length ?? null };
  }, { mode, native, gap, chunks, finish });
}

export function summarizeStreamTrace(trace) {
  function peak(field, normalized = false) {
    let best = { delta: 0, deltaPer16ms: 0, before: null, after: null };
    for (let index = 1; index < trace.samples.length; index++) {
      const a = trace.samples[index - 1], b = trace.samples[index];
      if (!a.first || !b.first || a.t < 250 || b.t - a.t > 80) continue;
      const observed = field === 'secondX' ? 'second' : 'first';
      if (['screenY', 'firstX', 'secondX'].includes(field)
        && (!a[observed]?.visible || !b[observed]?.visible)) continue;
      if (field === 'secondX' && (!a.second || !b.second)) continue;
      const value = s => field === 'screenY' ? s.first.y - s.viewport
        : field === 'firstX' ? s.first.x : field === 'secondX' ? s.second.x : s[field];
      const delta = value(b) - value(a);
      const deltaPer16ms = delta * 16.667 / (b.t - a.t);
      if (Math.abs(normalized ? deltaPer16ms : delta) > Math.abs(normalized ? best.deltaPer16ms : best.delta)) best = { delta, deltaPer16ms, before: a, after: b };
    }
    return best;
  }
  let visibleMotion = { delta: 0, deltaPer16ms: 0, index: null };
  let visibleMotionPerFrame = { ...visibleMotion };
  let capResidualMotion = { ...visibleMotion };
  for (let index = 1; index < trace.samples.length; index++) {
    const a = trace.samples[index - 1], b = trace.samples[index];
    if (a.t < 250 || b.t - a.t > 80) continue;
    const previous = new Map((a.anchors || []).map(anchor => [anchor.index, anchor]));
    for (const anchor of b.anchors || []) {
      const old = previous.get(anchor.index);
      if (!old) continue;
      const delta = anchor.y - b.viewport - old.y + a.viewport;
      const deltaPer16ms = delta * 16.667 / (b.t - a.t);
      if (a.naturalHeight >= a.heightCap && b.naturalHeight >= b.heightCap) {
        // Growth and scrolling can run together. Subtract their common motion
        // to detect an additional jump of an already visible paragraph.
        const residual = delta + b.overlayHeight - a.overlayHeight + b.scrollTop - a.scrollTop;
        if (Math.abs(residual) > Math.abs(capResidualMotion.delta)) capResidualMotion = {
          delta: residual, deltaPer16ms: residual * 16.667 / (b.t - a.t),
          index: anchor.index, before: a, after: b,
        };
      }
      if (Math.abs(deltaPer16ms) > Math.abs(visibleMotionPerFrame.deltaPer16ms)) visibleMotionPerFrame = { delta, deltaPer16ms, index: anchor.index, before: a, after: b };
      if (Math.abs(delta) > Math.abs(visibleMotion.delta)) {
        visibleMotion = { delta, deltaPer16ms: delta * 16.667 / (b.t - a.t), index: anchor.index, before: a, after: b };
      }
    }
  }
  return {
    mode: trace.mode, frames: trace.samples.length, visibleMotion, visibleMotionPerFrame, capResidualMotion, nativeRequests: trace.resizes.length,
    hitRectRequests: trace.samples.at(-1)?.hitCount,
    glyphScreenY: peak('screenY'), firstGlyphX: peak('firstX'), incomingGlyphX: peak('secondX'),
    viewportHeight: peak('viewport'), scrollTop: peak('scrollTop'),
    surfaceMotion: peak('overlayHeight', true), incomingMotion: peak('secondX', true), scrollMotion: peak('scrollTop', true),
    transientScroll: trace.samples.filter(s => s.t > 250 && s.naturalHeight < s.heightCap - 2 && s.scrollTop > 1),
    visualShrinks: trace.samples.filter((s, i) => i > 0 && s.t > 250 && s.chars > 0
      && s.chars === trace.samples[i - 1].chars && s.overlayHeight < trace.samples[i - 1].overlayHeight - 1),
  };
}
