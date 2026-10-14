// Language registry. Keys are LeetCode's language slugs (what the editor's language picker uses).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Pick up toolchains installed by scripts/install-toolchains.sh (no-op inside Docker, where
// they are on PATH already).
const ENV_SH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.toolchains', 'env.sh');
if (existsSync(ENV_SH)) {
  const out = execFileSync('bash', ['-c', `source "${ENV_SH}" && env -0`]);
  for (const kv of out.toString().split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) process.env[kv.slice(0, i)] = kv.slice(i + 1);
  }
}

const modules = {
  cpp: () => import('./cpp.js').then((m) => m.cpp),
  c: () => import('./cpp.js').then((m) => m.c),
  java: () => import('./jvm.js').then((m) => m.java),
  kotlin: () => import('./jvm.js').then((m) => m.kotlin),
  scala: () => import('./jvm.js').then((m) => m.scala),
  javascript: () => import('./js.js').then((m) => m.javascript),
  typescript: () => import('./js.js').then((m) => m.typescript),
  python3: () => import('./python.js').then((m) => m.python3),
  python: () => import('./python.js').then((m) => m.python),
  csharp: () => import('./csharp.js').then((m) => m.csharp),
  golang: () => import('./go.js').then((m) => m.golang),
  rust: () => import('./rust.js').then((m) => m.rust),
  swift: () => import('./swift.js').then((m) => m.swift),
  ruby: () => import('./ruby.js').then((m) => m.ruby),
  php: () => import('./php.js').then((m) => m.php),
  dart: () => import('./dart.js').then((m) => m.dart),
  racket: () => import('./racket.js').then((m) => m.racket),
  erlang: () => import('./beam.js').then((m) => m.erlang),
  elixir: () => import('./beam.js').then((m) => m.elixir),
};

export const LANGS = Object.fromEntries(Object.keys(modules).map((k) => [k, true]));
const loaded = {};

for (const [id, load] of Object.entries(modules)) {
  try {
    loaded[id] = await load();
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') console.error(`language ${id}:`, e.message);
  }
}

export function adapter(lang) {
  const a = loaded[lang];
  if (!a) throw new Error(`${lang} isn't supported by this server yet.`);
  return a;
}

/** Is a command on PATH? */
export function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && existsSync(path.join(dir, cmd))) return path.join(dir, cmd);
  }
  return null;
}

/** {lang: {name, available, reason?}} — a language is available when its tools are on PATH. */
export async function availability() {
  const out = {};
  for (const id of Object.keys(modules)) {
    const a = loaded[id];
    if (!a) { out[id] = { available: false, reason: 'not implemented' }; continue; }
    const missing = (a.requires || []).filter((c) => !which(c));
    out[id] = { name: a.name, available: !missing.length, ...(missing.length ? { reason: `missing ${missing.join(', ')}` } : {}) };
  }
  return out;
}
