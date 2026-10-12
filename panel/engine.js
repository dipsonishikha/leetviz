// Client for engine/worker.js. `stop()` kills a runaway computation by restarting the worker.

export class Engine {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.seq = 0;
    this.spawn();
  }

  spawn() {
    this.pending = new Map();
    this.worker = new Worker('../engine/worker.js');
    this.onStatus('loading');
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') return this.onStatus('ready');
      if (data.type === 'fatal') return this.onStatus('error', data.error);
      if (data.type === 'progress') return this.progress?.(data.data);
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (this.pending.size === 0) this.onStatus('ready');
      data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
    };
    this.worker.onerror = (e) => this.onStatus('error', e.message);
  }

  call(cmd, payload, onProgress) {
    const id = ++this.seq;
    this.progress = onProgress;
    this.onStatus('busy');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, payload });
    });
  }

  get busy() {
    return this.pending.size > 0;
  }

  stop() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Stopped'));
    this.spawn();
  }
}
