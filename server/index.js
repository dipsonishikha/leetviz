#!/usr/bin/env node
// LeetViz language server: compiles, runs and traces LeetCode solutions in every language
// LeetCode offers, for the extension panel.
//
//   node index.js [--port 8787] [--host 127.0.0.1]
//
// It runs arbitrary code, so it only accepts requests whose Origin is a Chrome extension
// (or one listed in LEETVIZ_ORIGINS), and LEETVIZ_TOKEN can additionally require a bearer token.
// Don't expose it to a network without a sandbox (see Dockerfile).
import http from 'node:http';
import { trace, measure, stress } from './lib/runner.js';
import { LANGS, availability } from './langs/index.js';
import { pruneCache } from './lib/build.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = +(opt('port', process.env.PORT || 8787));
const HOST = opt('host', process.env.HOST || '127.0.0.1');
const TOKEN = process.env.LEETVIZ_TOKEN || '';
const ORIGINS = (process.env.LEETVIZ_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_JOBS = +(process.env.LEETVIZ_JOBS || 2);
const MAX_BODY = 8 * 1024 * 1024;

const COMMANDS = { trace, measure, stress };

function originAllowed(origin) {
  if (!origin) return false;
  return origin.startsWith('chrome-extension://') || ORIGINS.includes(origin) || ORIGINS.includes('*');
}

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin');
}

// A tiny semaphore so a few big Compare runs can't starve the machine.
let running = 0;
const queue = [];
async function slot() {
  if (running < MAX_JOBS) { running++; return; }
  await new Promise((r) => queue.push(r));
  running++;
}
function release() {
  running--;
  queue.shift()?.();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (!originAllowed(origin)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('LeetViz server: requests are only accepted from the extension.\n');
    return;
  }
  cors(res, origin);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Wrong or missing server token (set it in the panel settings).' }));
  }

  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, langs: await availability() }));
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/run') return res.writeHead(404).end();

  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return res.writeHead(400).end(String(e.message)); }
  const fn = COMMANDS[body.cmd];
  if (!fn) return res.writeHead(400).end(`unknown command ${body.cmd}`);
  if (!LANGS[body.lang]) return res.writeHead(400).end(`unknown language ${body.lang}`);

  // NDJSON: progress lines, then one result/error line. Closing the request aborts the job.
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (obj) => { if (!closed) res.write(JSON.stringify(obj) + '\n'); };
  const emit = (data) => {
    if (closed) throw Object.assign(new Error('Stopped'), { stopped: true });
    send({ type: 'progress', data });
  };

  await slot();
  const t0 = Date.now();
  try {
    if (closed) return;
    const result = await fn(body, emit);
    send({ type: 'result', result });
  } catch (e) {
    if (!e.stopped) {
      if (!e.line) console.error(`[${body.lang}/${body.cmd}]`, e.stack || e);
      send({ type: 'error', error: e.message || String(e), line: e.line ?? null });
    }
  } finally {
    release();
    console.log(`${new Date().toISOString()} ${body.lang} ${body.cmd} ${Date.now() - t0}ms${closed ? ' (client gone)' : ''}`);
    res.end();
  }
});

pruneCache().catch(() => {});

server.listen(PORT, HOST, () => {
  console.log(`LeetViz server on http://${HOST}:${PORT}${TOKEN ? ' (token required)' : ''}`);
  availability().then((a) => {
    const ok = Object.entries(a).filter(([, v]) => v.available).map(([k]) => k);
    const missing = Object.entries(a).filter(([, v]) => !v.available).map(([k, v]) => `${k} (${v.reason})`);
    console.log(`Languages ready: ${ok.join(', ') || 'none'}`);
    if (missing.length) console.log(`Not available: ${missing.join(', ')}`);
  });
});
