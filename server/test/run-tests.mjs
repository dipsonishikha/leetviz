// End-to-end check of every language adapter: trace, measure and stress on Two Sum.
//   node test/run-tests.mjs [lang ...]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { trace, measure, stress } from '../lib/runner.js';
import { availability } from '../langs/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (f) => readFileSync(path.join(HERE, 'fixtures', f), 'utf8');
const EXT = {
  cpp: 'cpp', c: 'c', java: 'java', kotlin: 'kt', scala: 'scala', javascript: 'js', typescript: 'ts', python3: 'py', python: 'py',
  csharp: 'cs', golang: 'go', rust: 'rs', swift: 'swift', ruby: 'rb', php: 'php', dart: 'dart', racket: 'rkt', erlang: 'erl', elixir: 'ex',
};
const meta = { name: 'twoSum', params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }], return: { type: 'integer[]', size: 2 } };
const gen = FIX('two_sum_gen.py');
const only = process.argv.slice(2);
const avail = await availability();
let failed = 0;

for (const lang of Object.keys(EXT)) {
  if (only.length && !only.includes(lang)) continue;
  if (!avail[lang]?.available) { console.log(`${lang.padEnd(11)} SKIP  ${avail[lang]?.reason}`); continue; }
  const code = FIX(`two_sum.${EXT[lang]}`);
  const t0 = Date.now();
  const problems = [];
  try {
    const tr = await trace({ lang, code, meta, args: [[2, 7, 11, 15], 9], maxSteps: 5000 });
    if (tr.error) problems.push(`trace error: ${tr.error}`);
    if (!tr.steps?.length) problems.push('trace: no steps');
    if (tr.returnPlain?.replace(/\s/g, '') !== '[0,1]') problems.push(`trace returned ${tr.returnPlain}`);
    const tTrace = Date.now() - t0;
    const [m] = await measure({ lang, approaches: [{ name: 'A', code }], meta, gen, ignoreOrder: false }, () => {});
    if (m.error) problems.push(`measure error: ${m.error}`);
    if (!m.timeClass) problems.push('measure: no time class');
    const tMeasure = Date.now() - t0 - tTrace;
    const st = await stress({ lang, a: { code }, b: { code }, meta, gen, trials: 60, maxN: 8 }, () => {});
    if (st.error || st.mismatch) problems.push(`stress: ${st.error || JSON.stringify(st.mismatch)}`);
    const summary = `${tr.steps?.length ?? 0} steps ${tTrace}ms · ${m.timeClass?.label ?? '?'} ${tMeasure}ms · stress ${st.passed}/${st.trials}`;
    console.log(`${lang.padEnd(11)} ${problems.length ? 'FAIL' : 'ok  '}  ${summary}${problems.length ? `\n            ${problems.join('\n            ')}` : ''}`);
  } catch (e) {
    problems.push(e.message);
    console.log(`${lang.padEnd(11)} FAIL  ${e.message}`);
  }
  if (problems.length) failed++;
}
process.exit(failed ? 1 : 0);
