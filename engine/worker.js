// Runs the Python engine (Pyodide + tracer.py) off the UI thread.
// Protocol: postMessage({id, cmd, payload}) -> {id, ok, result} | {id, ok:false, error}
//           progress updates arrive as {type: 'progress', data}.

const PYODIDE_URL = new URL('../vendor/pyodide/', self.location).href;
importScripts(PYODIDE_URL + 'pyodide.js');

const ready = (async () => {
  const py = await loadPyodide({ indexURL: PYODIDE_URL });
  const src = await (await fetch(new URL('tracer.py', self.location))).text();
  py.runPython(src);
  // Browser stacks are smaller than CPython's; keep deep recursion from crashing the worker.
  py.runPython('sys.setrecursionlimit(1800)');
  py.globals.set('_emit', (s) => postMessage({ type: 'progress', data: JSON.parse(s) }));
  return py;
})();

ready.then(
  () => postMessage({ type: 'ready' }),
  (e) => postMessage({ type: 'fatal', error: String(e) }),
);

const COMMANDS = {
  signature: 'api_signature',
  trace: 'api_trace',
  measure: 'api_measure',
  stress: 'api_stress',
  predict: 'api_predict',
};

self.onmessage = async ({ data: { id, cmd, payload } }) => {
  try {
    const py = await ready;
    const fn = py.globals.get(COMMANDS[cmd]);
    if (!fn) throw new Error(`unknown command ${cmd}`);
    const out = fn(JSON.stringify(payload));
    fn.destroy();
    postMessage({ id, ok: true, result: JSON.parse(out) });
  } catch (e) {
    // Python exceptions arrive as PythonError with the traceback in .message; keep the last line.
    const msg = String(e.message || e).trim().split('\n').pop();
    postMessage({ id, ok: false, error: msg });
  }
};
