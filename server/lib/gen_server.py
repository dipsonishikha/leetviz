"""Runs the panel's Python input generator `gen(n, stress)` for the server.

Reuses engine/tracer.py so inputs are identical to the in-browser engine's.
Protocol: one JSON request per stdin line, one JSON reply per stdout line.
  {"gen": code}                       -> {"ok": true}            (compile + remember)
  {"n": 8, "seed": 1, "stress": true} -> {"args": [...]} | {"error": "..."}
"""
import json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "engine"))
import tracer  # noqa: E402

_out = sys.stdout
sys.stdout = sys.stderr  # stray print()s in gen must not corrupt the protocol
gen = None
for line in sys.stdin:
    try:
        req = json.loads(line)
        if "gen" in req:
            gen = tracer.make_generator(req["gen"])
            reply = {"ok": True}
        else:
            args = tracer.gen_args(gen, req["n"], req["seed"], req.get("stress", False))
            reply = {"args": tracer.to_plain(args)}
    except Exception as e:
        reply = {"error": f"{type(e).__name__}: {e}"}
    _out.write(json.dumps(reply) + "\n")
    _out.flush()
