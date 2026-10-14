// Client for the LeetViz language server (server/index.js), used for every language except
// Python (which runs in the browser). Same interface as Engine in engine.js.

const KEY = 'leetviz:server';
export const DEFAULT_URL = 'http://127.0.0.1:8787';

export function serverSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { url: (s.url || DEFAULT_URL).replace(/\/+$/, ''), token: s.token || '' };
  } catch {
    return { url: DEFAULT_URL, token: '' };
  }
}

export function saveServerSettings(url, token) {
  try { localStorage.setItem(KEY, JSON.stringify({ url: url.trim() || DEFAULT_URL, token: token.trim() })); } catch {}
}

function headers() {
  const { token } = serverSettings();
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** {ok, langs: {slug: {name, available, reason?}}} or {ok: false, error}. */
export async function serverHealth() {
  const { url } = serverSettings();
  try {
    const res = await fetch(`${url}/health`, { headers: headers(), signal: AbortSignal.timeout(3000) });
    if (res.status === 401) return { ok: false, error: 'The server needs a token — add it in the server settings.' };
    if (!res.ok) return { ok: false, error: `Server answered ${res.status}` };
    return await res.json();
  } catch {
    return { ok: false, error: `Can't reach the LeetViz server at ${url}.` };
  }
}

export class RemoteEngine {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.jobs = new Set();
  }

  get busy() {
    return this.jobs.size > 0;
  }

  /** POST /run and read the NDJSON stream: progress lines, then a result or error line. */
  async call(cmd, payload, onProgress) {
    const ctrl = new AbortController();
    this.jobs.add(ctrl);
    this.onStatus('busy');
    try {
      const { url } = serverSettings();
      let res;
      try {
        res = await fetch(`${url}/run`, { method: 'POST', headers: headers(), body: JSON.stringify({ cmd, ...payload }), signal: ctrl.signal });
      } catch (e) {
        if (ctrl.signal.aborted) throw new Error('Stopped');
        throw new Error(`Can't reach the LeetViz server at ${url}. Start it with “npm start” in leetviz/server (see the README).`);
      }
      if (!res.ok) throw new Error((await res.text()) || `Server error ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (ctrl.signal.aborted) throw new Error('Stopped');
          throw e;
        }
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (msg.type === 'progress') onProgress?.(msg.data);
          else if (msg.type === 'result') return msg.result;
          else if (msg.type === 'error') throw Object.assign(new Error(msg.error), { line: msg.line });
        }
      }
      throw new Error('The server closed the connection without an answer.');
    } finally {
      this.jobs.delete(ctrl);
      if (!this.jobs.size) this.onStatus('ready');
    }
  }

  stop() {
    for (const c of this.jobs) c.abort();
  }
}
