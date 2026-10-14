// LeetCode's languages, keyed by the slug LeetCode uses (and the server's adapters use).

export const LANG_NAMES = {
  cpp: 'C++', java: 'Java', python3: 'Python3', python: 'Python', c: 'C', csharp: 'C#',
  javascript: 'JavaScript', typescript: 'TypeScript', php: 'PHP', swift: 'Swift', kotlin: 'Kotlin',
  dart: 'Dart', golang: 'Go', ruby: 'Ruby', scala: 'Scala', rust: 'Rust', racket: 'Racket',
  erlang: 'Erlang', elixir: 'Elixir',
};

// Monaco language ids -> LeetCode slugs (Python 2 vs 3 can't be told apart from Monaco).
const FROM_MONACO = {
  cpp: 'cpp', java: 'java', python: 'python3', c: 'c', csharp: 'csharp', javascript: 'javascript',
  typescript: 'typescript', php: 'php', swift: 'swift', kotlin: 'kotlin', dart: 'dart', go: 'golang',
  golang: 'golang', ruby: 'ruby', scala: 'scala', rust: 'rust', racket: 'racket', scheme: 'racket',
  erlang: 'erlang', elixir: 'elixir',
};

/** Python (2 or 3) runs in the browser through Pyodide; everything else on the server. */
export const isPython = (lang) => !lang || lang === 'python3' || lang === 'python';

export const langName = (lang) => LANG_NAMES[lang] || lang || 'Python3';

/** LeetCode's selected-language slug when it agrees with the editor, else the editor's language. */
export function normalizeLang(slug, monacoId) {
  const fromMonaco = FROM_MONACO[monacoId] || null;
  if (slug && LANG_NAMES[slug]) {
    if (!fromMonaco || fromMonaco === slug || (isPython(slug) && isPython(fromMonaco))) return slug;
  }
  return fromMonaco || (LANG_NAMES[slug] ? slug : null);
}
