// LeetCode's metaData types ("integer[]", "list<list<string>>", "TreeNode", ...) parsed into a
// small tree, plus the wire format drivers read their arguments in.
//
// Wire format: whitespace-separated tokens, one request per line.
//   integer/long/double  decimal text
//   boolean              1 | 0
//   string/character     '"' + percent-encoded UTF-8 (so it never contains whitespace; "" is `"`)
//   array/list/ListNode  length, then each item
//   TreeNode             length, then each level-order item, `#` for a missing child
// Every language's driver only needs "read next token" plus a %XX decoder.

const BASE = {
  integer: 'int', int: 'int', long: 'long', double: 'double', float: 'double',
  boolean: 'bool', bool: 'bool', string: 'string', String: 'string', str: 'string',
  character: 'char', char: 'char', void: 'void', ListNode: 'ListNode', TreeNode: 'TreeNode',
};

export class TypeError_ extends Error {}

/** "list<integer[]>" -> {k:'list', of:{k:'array', of:{k:'int'}}} */
export function parseType(text) {
  let s = String(text || '').trim();
  if (!s) throw new TypeError_('missing type');
  if (s.endsWith('[]')) return { k: 'array', of: parseType(s.slice(0, -2)) };
  const m = s.match(/^list\s*<(.*)>$/i);
  if (m) return { k: 'list', of: parseType(m[1]) };
  const k = BASE[s];
  if (!k) throw new TypeError_(`LeetCode type “${s}” isn't supported yet`);
  return { k };
}

export const isSeq = (t) => t.k === 'array' || t.k === 'list';

/** Nesting depth of sequences, e.g. integer[][] -> 2. */
export function depth(t) {
  return isSeq(t) ? 1 + depth(t.of) : 0;
}

/** Innermost element type. */
export function leaf(t) {
  return isSeq(t) ? leaf(t.of) : t;
}

export function typeName(t) {
  if (t.k === 'array') return `${typeName(t.of)}[]`;
  if (t.k === 'list') return `list<${typeName(t.of)}>`;
  return { int: 'integer', bool: 'boolean', char: 'character' }[t.k] || t.k;
}

function pct(s) {
  return '"' + Array.from(new TextEncoder().encode(s), (b) =>
    (b > 0x20 && b < 0x7f && b !== 0x25 && b !== 0x23) ? String.fromCharCode(b) : '%' + b.toString(16).padStart(2, '0')).join('');
}

function num(v, what) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError_(`expected ${what}, got ${JSON.stringify(v)}`);
  return String(v);
}

/** Encode one JSON value of type t into tokens (pushed onto out). */
export function encode(v, t, out = []) {
  switch (t.k) {
    case 'int': case 'long':
      if (typeof v === 'number' && !Number.isInteger(v)) throw new TypeError_(`expected an integer, got ${v}`);
      out.push(num(v, 'an integer')); break;
    case 'double': out.push(num(v, 'a number')); break;
    case 'bool':
      if (typeof v !== 'boolean' && v !== 0 && v !== 1) throw new TypeError_(`expected true/false, got ${JSON.stringify(v)}`);
      out.push(v ? '1' : '0'); break;
    case 'string': case 'char':
      if (typeof v !== 'string') throw new TypeError_(`expected a string, got ${JSON.stringify(v)}`);
      if (t.k === 'char' && [...v].length !== 1) throw new TypeError_(`expected a single character, got ${JSON.stringify(v)}`);
      out.push(pct(v)); break;
    case 'array': case 'list': case 'ListNode':
      if (!Array.isArray(v)) throw new TypeError_(`expected a list, got ${JSON.stringify(v)}`);
      out.push(String(v.length));
      for (const x of v) encode(x, t.k === 'ListNode' ? { k: 'int' } : t.of, out);
      break;
    case 'TreeNode':
      if (!Array.isArray(v)) throw new TypeError_(`expected a level-order list, got ${JSON.stringify(v)}`);
      out.push(String(v.length));
      for (const x of v) out.push(x === null ? '#' : num(x, 'an integer or null'));
      break;
    default:
      throw new TypeError_(`can't pass a ${typeName(t)} argument`);
  }
  return out;
}

export function encodeArgs(args, types) {
  if (args.length !== types.length) throw new TypeError_(`expected ${types.length} argument(s), got ${args.length}`);
  const out = [];
  args.forEach((a, i) => encode(a, types[i], out));
  return out.join(' ');
}

/**
 * Signature from LeetCode's metaData: {method, params:[{name, type}], ret}.
 * Throws for design problems (metaData.classname) which aren't supported yet.
 */
export function signatureFromMeta(meta) {
  if (!meta || !meta.name || !Array.isArray(meta.params)) throw new TypeError_('This problem has no function signature (design problems aren\'t supported yet).');
  if (meta.classname || meta.systemdesign) throw new TypeError_('Design-style problems (a class with several methods) aren\'t supported yet.');
  return {
    method: meta.name,
    params: meta.params.map((p) => ({ name: p.name, type: p.type, t: parseType(p.type) })),
    ret: parseType(meta.return?.type || 'void'),
  };
}

/** snake_case for languages whose LeetCode templates use it (Ruby, Rust, Elixir, ...). */
export function snake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** kebab-case for Racket. */
export function kebab(name) {
  return snake(name).replace(/_/g, '-');
}

/** A plain JSON value (a driver's printed result) -> the panel's serialized-value format. */
export function plainToSer(v) {
  if (v === null) return { t: 'prim', v: 'null', k: 'null' };
  if (typeof v === 'boolean') return { t: 'prim', v: String(v), k: 'bool' };
  if (typeof v === 'number') return { t: 'prim', v: String(v), k: 'num', num: v };
  if (typeof v === 'string') return { t: 'str', v: v.slice(0, 300), more: v.length > 300 };
  if (Array.isArray(v)) return { t: 'list', kind: 'list', id: 0, len: v.length, items: v.slice(0, 120).map(plainToSer) };
  return { t: 'dict', kind: 'object', len: Object.keys(v).length, entries: Object.entries(v).slice(0, 120).map(([k, x]) => [k, plainToSer(x)]) };
}
