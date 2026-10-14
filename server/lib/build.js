// Build cache: each (language, code, signature, mode) compiles once into its own directory.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, stat, readdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ROOT = process.env.LEETVIZ_WORK || path.join(os.tmpdir(), 'leetviz-work');
const inflight = new Map();

export class CompileError extends Error {
  constructor(message, line = null) {
    super(message);
    this.line = line;
  }
}

export function hash(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

/**
 * Run `fn(dir)` once per key; later calls reuse the directory. A failed build is not cached,
 * except compile errors, which are remembered so retrying the same broken code is instant.
 * @returns whatever fn returned (must be JSON-serializable).
 */
export async function cached(lang, parts, fn) {
  const dir = path.join(ROOT, `${lang}-${hash(...parts)}`);
  const marker = path.join(dir, '.result.json');
  if (inflight.has(dir)) return inflight.get(dir);
  const p = (async () => {
    try {
      const saved = JSON.parse(await readFile(marker, 'utf8'));
      utimes(dir, new Date(), new Date()).catch(() => {}); // still in use: keep it past pruning
      if (saved.compileError) throw new CompileError(saved.compileError.message, saved.compileError.line);
      return saved.value;
    } catch (e) {
      if (e instanceof CompileError) throw e;
    }
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      const value = await fn(dir);
      await writeFile(marker, JSON.stringify({ value }));
      return value;
    } catch (e) {
      if (e instanceof CompileError) await writeFile(marker, JSON.stringify({ compileError: { message: e.message, line: e.line } }));
      throw e;
    }
  })();
  inflight.set(dir, p);
  try { return await p; } finally { inflight.delete(dir); }
}

/** A scratch directory for one trace run (inputs, outputs), removed by the caller. */
export async function scratch(prefix) {
  const dir = path.join(ROOT, 'runs', `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Turn compiler output into a short message + the first error line in the user's file.
 * @param file   the user's file name as the compiler prints it (e.g. "solution.cpp")
 */
export function compileError(output, file, { lineRe } = {}) {
  const lines = output.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const re = lineRe || new RegExp(`${file.replace(/\./g, '\\.')}:(\\d+)`);
  const errLines = lines.filter((l) => /error/i.test(l));
  const first = errLines.find((l) => re.test(l)) || errLines[0] || lines.find((l) => l.trim()) || 'Compilation failed';
  const m = first.match(re) || lines.join('\n').match(re);
  const cleaned = first.replace(/^.*?error(\[\w+\])?:\s*/i, '').trim() || first.trim();
  return new CompileError(`Compile error${m ? ` on line ${m[1]}` : ''}: ${cleaned}`.slice(0, 500), m ? +m[1] : null);
}

/** Drop scratch runs and builds nobody has used for a week (called at server start). */
export async function pruneCache(maxAgeDays = 7) {
  await rm(path.join(ROOT, 'runs'), { recursive: true, force: true });
  let entries = [];
  try { entries = await readdir(ROOT); } catch { return; }
  const cutoff = Date.now() - maxAgeDays * 86400000;
  for (const e of entries) {
    const p = path.join(ROOT, e);
    try {
      if ((await stat(p)).mtimeMs < cutoff) await rm(p, { recursive: true, force: true });
    } catch {}
  }
}
