// Isolated-world content script: docks the LeetViz panel next to LeetCode and bridges
// the panel iframe <-> LeetCode page (editor code via main-world.js, problem data via GraphQL).
(() => {
  if (window.__leetvizContent) return;
  window.__leetvizContent = true;

  const PANEL_URL = chrome.runtime.getURL('panel/panel.html');
  const PANEL_ORIGIN = new URL(PANEL_URL).origin;
  const WIDTH_KEY = 'leetviz:width';
  let iframe = null;
  let drawer = null;
  let open = false;

  // ------------------------------------------------------------------ UI

  const launcher = document.createElement('button');
  launcher.className = 'leetviz-launcher';
  launcher.title = 'LeetViz: step through & compare approaches (Alt+V)';
  launcher.innerHTML = '<span class="leetviz-launcher-dot"></span><span>LeetViz</span>';
  launcher.addEventListener('click', () => toggle());
  document.documentElement.appendChild(launcher);

  function buildDrawer() {
    drawer = document.createElement('div');
    drawer.className = 'leetviz-drawer';
    const handle = document.createElement('div');
    handle.className = 'leetviz-resize';
    handle.title = 'Drag to resize';
    iframe = document.createElement('iframe');
    iframe.className = 'leetviz-frame';
    iframe.src = PANEL_URL;
    iframe.allow = 'clipboard-write';
    drawer.append(handle, iframe);
    document.documentElement.appendChild(drawer);

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.documentElement.classList.add('leetviz-resizing');
      const move = (ev) => setWidth(window.innerWidth - ev.clientX);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        document.documentElement.classList.remove('leetviz-resizing');
        try { localStorage.setItem(WIDTH_KEY, String(currentWidth())); } catch {}
        window.dispatchEvent(new Event('resize')); // let LeetCode/Monaco re-layout
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
    });
  }

  function currentWidth() {
    return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--leetviz-w'), 10) || 560;
  }

  function setWidth(px) {
    const w = Math.round(Math.min(Math.max(px, 380), window.innerWidth * 0.75));
    document.documentElement.style.setProperty('--leetviz-w', `${w}px`);
  }

  function toggle(force) {
    open = force ?? !open;
    if (open && !drawer) {
      let saved = 0;
      try { saved = parseInt(localStorage.getItem(WIDTH_KEY), 10); } catch {}
      setWidth(saved || Math.max(480, window.innerWidth * 0.42));
      buildDrawer();
    }
    document.documentElement.classList.toggle('leetviz-open', open);
    launcher.classList.toggle('active', open);
    if (!open) mainCall('decorate', { line: null });
    window.dispatchEvent(new Event('resize'));
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) {
      e.preventDefault();
      toggle();
    }
  }, true);

  // ------------------------------------------------------------------ main-world bridge

  let seq = 0;
  const waiting = new Map();

  function mainCall(type, data = {}, expectReply = false) {
    const id = `m${++seq}`;
    window.postMessage({ source: 'leetviz-cs', type, id, ...data }, location.origin);
    if (!expectReply) return Promise.resolve();
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      setTimeout(() => { if (waiting.delete(id)) resolve(null); }, 1500);
    });
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source === window && d?.source === 'leetviz-main' && waiting.has(d.id)) {
      waiting.get(d.id)(d);
      waiting.delete(d.id);
      return;
    }
    if (iframe && ev.source === iframe.contentWindow && ev.origin === PANEL_ORIGIN && d?.lv) {
      handlePanel(d);
    }
  });

  // ------------------------------------------------------------------ problem data

  const slugOf = () => (location.pathname.match(/\/problems\/([^/]+)/) || [])[1] || null;
  const questionCache = new Map();

  async function fetchQuestion(slug) {
    if (!slug) return null;
    if (questionCache.has(slug)) return questionCache.get(slug);
    const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
    const query = `query leetvizQuestion($titleSlug: String!) {
      question(titleSlug: $titleSlug) { title questionFrontendId metaData exampleTestcaseList content }
    }`;
    try {
      const res = await fetch('/graphql/', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrftoken': csrf },
        body: JSON.stringify({ query, variables: { titleSlug: slug }, operationName: 'leetvizQuestion' }),
      });
      const q = (await res.json())?.data?.question;
      if (q) questionCache.set(slug, q);
      return q || null;
    } catch {
      return null;
    }
  }

  // "1 <= nums.length <= 10<sup>4</sup>" -> 10000 (the n LeetCode will test with).
  function constraintN(html) {
    if (!html) return null;
    const text = html.replace(/<sup>(\d+)<\/sup>/g, '^$1').replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
    let best = null;
    const re = /(?:\.length|\bn|\bm|\.size)\s*(?:<=|≤|<)\s*(?:(\d+)\s*\*\s*)?(\d+)(?:\^(\d+))?/g;
    for (const m of text.matchAll(re)) {
      const v = (m[1] ? +m[1] : 1) * (m[3] ? Math.pow(+m[2], +m[3]) : +m[2]);
      if (v >= 10 && v <= 1e9 && (best === null || v > best)) best = v;
    }
    return best;
  }

  function parseExamples(list, nParams) {
    return (list || []).map((tc) => {
      const lines = tc.split('\n');
      if (lines.length !== nParams) return null;
      try { return lines.map((l) => JSON.parse(l)); } catch { return null; }
    }).filter(Boolean);
  }

  // Same table as panel/langs.js (content scripts can't import modules).
  const LANGS = ['cpp', 'java', 'python3', 'python', 'c', 'csharp', 'javascript', 'typescript', 'php', 'swift', 'kotlin', 'dart', 'golang', 'ruby', 'scala', 'rust', 'racket', 'erlang', 'elixir'];
  const FROM_MONACO = { cpp: 'cpp', java: 'java', python: 'python3', c: 'c', csharp: 'csharp', javascript: 'javascript', typescript: 'typescript', php: 'php', swift: 'swift', kotlin: 'kotlin', dart: 'dart', go: 'golang', golang: 'golang', ruby: 'ruby', scala: 'scala', rust: 'rust', racket: 'racket', scheme: 'racket', erlang: 'erlang', elixir: 'elixir' };
  const isPy = (l) => l === 'python' || l === 'python3';

  function normalizeLang(slug, monacoId) {
    const fromMonaco = FROM_MONACO[monacoId] || null;
    if (LANGS.includes(slug) && (!fromMonaco || fromMonaco === slug || (isPy(slug) && isPy(fromMonaco)))) return slug;
    return fromMonaco || (LANGS.includes(slug) ? slug : null);
  }

  function isDark() {
    const html = document.documentElement;
    if (html.classList.contains('dark') || html.dataset.theme === 'dark') return true;
    if (html.classList.contains('light') || html.dataset.theme === 'light') return false;
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  async function context() {
    const slug = slugOf();
    const [editor, q] = await Promise.all([mainCall('getCode', {}, true), fetchQuestion(slug)]);
    let meta = null;
    try { meta = q?.metaData ? JSON.parse(q.metaData) : null; } catch {}
    return {
      slug,
      title: q ? `${q.questionFrontendId}. ${q.title}` : document.title.replace(/ - LeetCode.*/, ''),
      code: editor?.code ?? null,
      lang: normalizeLang(editor?.lcLang, editor?.lang),
      hasMonaco: !!editor?.hasMonaco,
      meta,
      examples: meta?.params ? parseExamples(q?.exampleTestcaseList, meta.params.length) : [],
      constraintN: constraintN(q?.content),
      dark: isDark(),
    };
  }

  // ------------------------------------------------------------------ panel requests

  function replyPanel(id, result) {
    iframe.contentWindow.postMessage({ lv: true, id, result }, PANEL_ORIGIN);
  }

  async function handlePanel(msg) {
    switch (msg.type) {
      case 'context': replyPanel(msg.id, await context()); break;
      case 'decorate': mainCall('decorate', { line: msg.line, inline: msg.inline, error: msg.error }); break;
      case 'close': toggle(false); break;
    }
  }

  // LeetCode is a single-page app: tell the panel when the problem changes.
  let lastSlug = slugOf();
  setInterval(() => {
    const s = slugOf();
    if (s !== lastSlug) {
      lastSlug = s;
      if (iframe) iframe.contentWindow.postMessage({ lv: true, type: 'navigated' }, PANEL_ORIGIN);
    }
  }, 1000);
})();
