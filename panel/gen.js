// Turns a problem's parameter types + example values into an editable Python input generator
// `def gen(n): return [arg1, arg2, ...]` used by the Compare and Stress tabs.

const ANNOTATION_TYPES = [
  [/^(Optional\[)?ListNode\]?$/, 'ListNode'],
  [/^(Optional\[)?TreeNode\]?$/, 'TreeNode'],
  [/^List\[List\[int\]\]$/, 'integer[][]'],
  [/^List\[List\[str\]\]$/, 'character[][]'],
  [/^List\[int\]$/, 'integer[]'],
  [/^List\[float\]$/, 'double[]'],
  [/^List\[str\]$/, 'string[]'],
  [/^int$/, 'integer'],
  [/^str$/, 'string'],
  [/^bool$/, 'boolean'],
  [/^float$/, 'double'],
];

/** LeetCode metaData type for a param, falling back to its Python annotation. */
export function paramType(param) {
  if (param.type) return param.type;
  const a = (param.annotation || '').replace(/\s+/g, '').replace(/^'|'$/g, '');
  for (const [re, t] of ANNOTATION_TYPES) if (re.test(a)) return t;
  return 'unknown';
}

/** JSON value -> Python literal. */
export function pyLiteral(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`).join(', ')}}`;
  return String(v);
}

const flat = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined);
const isSorted = (a) => a.length >= 2 && a.every((x, i) => i === 0 || a[i - 1] <= x);
const isDistinct = (a) => a.length >= 3 && new Set(a).size === a.length;

function intRange(nums, name) {
  if (nums.length && nums.every((x) => x === 0 || x === 1)) return ['0', '1'];
  if (/digit/i.test(name)) return ['0', '9'];
  const neg = nums.some((x) => x < 0);
  return [neg ? '-hi' : '0', 'hi'];
}

function alphabet(strings) {
  const chars = [...new Set(strings.join(''))];
  if (!chars.length || chars.every((c) => c >= 'a' && c <= 'z')) return 'string.ascii_lowercase';
  if (chars.every((c) => c >= '0' && c <= '9')) return 'string.digits';
  if (chars.every((c) => /[a-zA-Z]/.test(c))) return 'string.ascii_letters';
  return JSON.stringify(chars.sort().join(''));
}

/**
 * @param params   [{name, type?, annotation?}]
 * @param examples array of argument arrays (JSON values)
 */
export function inferGenerator(params, examples) {
  const types = params.map(paramType);
  const sized = types.some((t) => /\[\]|^string$|ListNode|TreeNode/.test(t));
  const body = [];
  const names = [];
  let needsHi = false;

  params.forEach((p, i) => {
    const t = types[i];
    const ex = examples.map((args) => args[i]).filter((v) => v !== undefined);
    const name = /^[A-Za-z_]\w*$/.test(p.name) ? p.name : `arg${i}`;
    names.push(name);
    let expr;

    if (t === 'integer') {
      const hasIntArray = types.some((x) => /^integer\[\]|ListNode|TreeNode/.test(x));
      if (!sized || /^(n|m|num|count|size)$/i.test(name)) expr = 'n';
      else if (hasIntArray && /target|goal|sum/i.test(name)) {
        needsHi = true;
        // Searching for something that isn't there forces the worst case (no early return).
        expr = 'random.randint(-2 * hi, 2 * hi) if stress else 3 * hi + 1  # measuring: unreachable => worst case';
      } else expr = ex.length ? pyLiteral(ex[0]) : '1';
    } else if (t === 'integer[]' || t === 'ListNode' || t === 'TreeNode' || t === 'double[]') {
      const arrays = ex.filter(Array.isArray);
      const nums = flat(arrays);
      const [lo, hi] = intRange(nums, name);
      needsHi ||= hi === 'hi';
      const distinct = arrays.length && arrays.every((a) => isDistinct(a.filter((x) => x !== null)));
      const sorted = arrays.length && arrays.every((a) => isSorted(a));
      if (distinct && hi === 'hi') {
        expr = `random.sample(range(${lo}, hi + 1), n)`;
      } else {
        expr = `[random.randint(${lo}, ${hi}) for _ in range(n)]`;
      }
      if (sorted) expr = `sorted(${expr})`;
      if (t === 'TreeNode') body.push('    # level-order list; None = missing child');
    } else if (t === 'integer[][]' || t === 'character[][]') {
      const rows = ex.filter(Array.isArray).flat().filter(Array.isArray);
      const widths = new Set(rows.map((r) => r.length));
      const gridName = /grid|matrix|mat$|board|image|map|maze|heights|land/i.test(name);
      const listName = /edge|interval|pair|point|quer|meeting|range|trip|connection|prereq|times|flight|road|course/i.test(name);
      const pairs = t !== 'character[][]' && !gridName && widths.size === 1 && [...widths][0] <= 3 &&
        (listName || ex.some((g) => Array.isArray(g) && g.length !== g[0]?.length));
      const values = [...new Set(flat(rows))];
      const smallSet = values.length > 0 && values.length <= 4;
      const cell = t === 'character[][]' || smallSet
        ? `random.choice(${pyLiteral(values.length ? values : [0, 1])})`
        : (needsHi = true, `random.randint(${values.some((v) => v < 0) ? '-hi' : '0'}, hi)`);
      if (pairs) {
        const w = [...widths][0];
        const nodeParam = params.find((q, j) => j !== i && types[j] === 'integer' && /^n$/i.test(q.name));
        if (/edge/i.test(name)) {
          const N = nodeParam ? 'n' : 'n + 1';
          expr = w === 2
            ? `[[random.randrange(${N}), random.randrange(${N})] for _ in range(n)]`
            : `[[random.randrange(${N}), random.randrange(${N}), random.randint(1, 100)] for _ in range(n)]`;
        } else if (/interval|meeting|range|point/i.test(name) && w === 2) {
          needsHi = true;
          expr = `[[a, a + random.randint(0, 20)] for a in (random.randint(0, hi) for _ in range(n))]`;
        } else {
          expr = `[[${Array(w).fill(cell).join(', ')}] for _ in range(n)]`;
        }
      } else {
        body.push(`    side = max(1, isqrt(n))  # n cells in a side x side grid`);
        expr = `[[${cell} for _ in range(side)] for _ in range(side)]`;
      }
    } else if (t === 'string') {
      expr = `''.join(random.choice(${alphabet(ex.filter((s) => typeof s === 'string'))}) for _ in range(n))`;
    } else if (t === 'string[]') {
      const words = flat(ex).filter((s) => typeof s === 'string');
      const maxLen = Math.min(8, Math.max(1, ...words.map((w) => w.length)));
      expr = `[''.join(random.choice(${alphabet(words)}) for _ in range(random.randint(1, ${maxLen}))) for _ in range(n)]`;
    } else if (t === 'character') {
      expr = ex.length ? pyLiteral(ex[0]) : '"a"';
    } else {
      expr = ex.length ? pyLiteral(ex[0]) : 'None  # TODO: fill in';
    }
    body.push(`    ${name} = ${expr}`);
  });

  const head = [
    '# Builds the arguments for input size n. Auto-generated from the examples:',
    '# edit it to match the constraints.',
    '#   stress=False (Compare): big inputs that should hit the worst case',
    '#   stress=True  (Find bugs): small inputs with lots of duplicates / edge cases',
    'def gen(n, stress=False):',
  ];
  if (needsHi) head.push('    hi = max(10, n) if stress else max(100, 4 * n)  # value range');
  return [...head, ...body, `    return [${names.join(', ')}]`, ''].join('\n');
}
