// Runs in LeetCode's own JS context so it can reach the Monaco editor.
// Talks to content.js through window.postMessage, tagged with `source`.
(() => {
  if (window.__leetvizMain) return;
  window.__leetvizMain = true;

  let decorations = null;
  let tracing = false;      // the panel has a run on screen: line-number clicks jump to that line
  const hooked = new WeakSet();

  function hookClicks(ed) {
    if (hooked.has(ed)) return;
    hooked.add(ed);
    ed.onMouseDown((e) => {
      const T = window.monaco.editor.MouseTargetType;
      if (!tracing || !e.target.position) return;
      if (e.target.type !== T.GUTTER_LINE_NUMBERS && e.target.type !== T.GUTTER_LINE_DECORATIONS) return;
      window.postMessage({ source: 'leetviz-main', type: 'lineClick', line: e.target.position.lineNumber }, location.origin);
    });
  }

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
      const score = (/\bclass\s+Solution\b|\bdef\s|\bfunction\b|\bfunc\s|\bfn\s|\bimpl\s+Solution\b|\bdefmodule\b|\(define|-spec\s|^\w[\w\s\*]*\(.*\)\s*\{/m.test(text) ? 1e7 : 0) + text.length;
      if (!best || score > best.score) best = { ed, score };
    }
    return best?.ed ?? null;
  }

  // LeetCode remembers the picked language in localStorage ("global_lang": "\"cpp\""). Monaco's
  // own language id can't tell Python 2 from Python 3, so prefer LeetCode's slug.
  function leetcodeLang() {
    try {
      const raw = localStorage.getItem('global_lang');
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    } catch {
      return null;
    }
  }

  function reply(id, data) {
    window.postMessage({ source: 'leetviz-main', id, ...data }, location.origin);
  }

  function decorate({ line, inline, error }) {
    const ed = codeEditor();
    if (!ed) return;
    decorations?.clear();
    decorations = null;
    tracing = !!line;
    if (!line) return;
    hookClicks(ed);
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
        lcLang: leetcodeLang(),
        hasMonaco: !!window.monaco,
      });
    } else if (msg.type === 'decorate') {
      decorate(msg);
    }
  });
})();
