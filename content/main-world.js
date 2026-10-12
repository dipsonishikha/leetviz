// Runs in LeetCode's own JS context so it can reach the Monaco editor.
// Talks to content.js through window.postMessage, tagged with `source`.
(() => {
  if (window.__leetvizMain) return;
  window.__leetvizMain = true;

  let decorations = null;

  // LeetCode can have several Monaco editors (code, testcase input); the code one is the
  // editable editor holding the most code.
  function codeEditor() {
    const m = window.monaco;
    if (!m?.editor?.getEditors) return null;
    let best = null;
    for (const ed of m.editor.getEditors()) {
      const model = ed.getModel();
      if (!model) continue;
      const text = model.getValue();
      const score = (/\bclass\s+Solution\b|\bdef\s|\bfunction\b/.test(text) ? 1e7 : 0) + text.length;
      if (!best || score > best.score) best = { ed, score };
    }
    return best?.ed ?? null;
  }

  function reply(id, data) {
    window.postMessage({ source: 'leetviz-main', id, ...data }, location.origin);
  }

  function decorate({ line, inline, error }) {
    const ed = codeEditor();
    if (!ed) return;
    decorations?.clear();
    decorations = null;
    if (!line) return;
    const model = ed.getModel();
    if (line > model.getLineCount()) return;
    const { Range } = window.monaco;
    const end = model.getLineMaxColumn(line);
    const decs = [{
      range: new Range(line, 1, line, 1),
      options: { isWholeLine: true, className: error ? 'leetviz-err-line' : 'leetviz-cur-line',
                 linesDecorationsClassName: error ? 'leetviz-err-gutter' : 'leetviz-cur-gutter' },
    }];
    if (inline) {
      decs.push({
        range: new Range(line, 1, line, end), // injected text is dropped on empty ranges
        options: { showIfCollapsed: true, after: { content: `   ${inline}`, inlineClassName: error ? 'leetviz-inline-err' : 'leetviz-inline' } },
      });
    }
    decorations = ed.createDecorationsCollection(decs);
    ed.revealLineInCenterIfOutsideViewport(line);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.source !== 'leetviz-cs') return;
    const msg = ev.data;
    if (msg.type === 'getCode') {
      const ed = codeEditor();
      const model = ed?.getModel();
      reply(msg.id, {
        code: model ? model.getValue() : null,
        lang: model ? model.getLanguageId() : null,
        hasMonaco: !!window.monaco,
      });
    } else if (msg.type === 'decorate') {
      decorate(msg);
    }
  });
})();
