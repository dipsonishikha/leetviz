# LeetViz

A Chrome extension that adds a panel next to LeetCode's editor and helps you:

1. **Step through** your solution line by line. It draws arrays with pointer
   labels (`i`, `left`, `right`…), hashmaps, sets, grids, linked lists, trees,
   and the recursion stack. It also counts how many times each line has run.
   The current line and the live variable values are shown inside LeetCode's
   own editor, like a debugger.
2. **Compare approaches** (brute, better, optimal). Each approach runs on inputs
   that double in size. The panel measures time, lines executed and extra
   memory, fits each approach to a Big-O class, estimates the runtime at the
   problem's real limit (read from its constraints), and charts the growth.
   It also warns about **hidden work**: a line that looks O(1) but is O(n),
   like `x in list`, slicing or `.index()`.
3. **Find bugs.** It runs your code against a reference on hundreds of small
   random inputs, stops at the smallest input where they disagree (or where
   one crashes or loops forever), and opens it in the step-through view.

The panel has two views, and the header button switches between them:

- **Simple view** (the default) explains each step with pictures and plain
  sentences that use the real numbers ("Is 1 × 5 ≥ 7? That's 5 ≥ 7 → No").
  - Arrays are blocks, and index variables are markers that hop between them.
  - Hashmaps are notebooks, sets are bags, stacks are piles of plates,
    linked lists are trains, and recursive calls are "helpers" that wait
    for an answer.
  - When comparing approaches, it shows a race at the problem's real input
    size and a dot picture of how many checks each approach needs.
- **Detailed view** shows raw values, the call stack, and the Big-O charts.

It works in every language LeetCode offers: C++, Java, Python, Python3, C, C#,
JavaScript, TypeScript, PHP, Swift, Kotlin, Dart, Go, Ruby, Scala, Rust, Racket,
Erlang and Elixir. You can even compare approaches written in different
languages.

- **Python** runs right in the browser through [Pyodide](https://pyodide.org)
  (CPython compiled to WebAssembly). Nothing needs installing, and the code
  never leaves your machine.
- **Every other language** runs on the **LeetViz server** (`server/`). You run
  it yourself, on your own machine or in Docker. It compiles your solution,
  steps through it with each language's debugger, and times it. Code goes only
  to the server address set in the panel (`127.0.0.1` by default).

## Install (developer mode)

```bash
./scripts/fetch-pyodide.sh       # downloads the ~14 MB Python runtime into vendor/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `leetviz/` folder.
3. Open any `leetcode.com/problems/...` page, then click the **LeetViz** tab on
   the right edge or press **Alt+V**. The panel uses whatever language
   LeetCode's editor is set to.

### The language server (for everything except Python)

You need Node.js 20 or newer. The install script downloads every compiler,
runtime and debugger into `server/.toolchains` (about 11 GB). It doesn't need
root and doesn't touch the rest of the system.

```bash
cd server
./scripts/install-toolchains.sh          # all languages; or e.g. `... swift dart` for some
npm start                                # http://127.0.0.1:8787
npm test                                 # trace + measure + stress on every language
```

Downloads sometimes fail on flaky networks. Re-running the script only fetches
what's missing.

Or run it in Docker (build from the `leetviz/` folder):

```bash
docker build -t leetviz-server -f server/Dockerfile .
docker run --rm -p 127.0.0.1:8787:8787 --memory 4g --pids-limit 512 --cpus 2 leetviz-server
```

The panel's status pill shows whether the server is reachable. Click the pill
to change the server address, set a token, or see which languages the server
can run.

**Security.** The server compiles and runs whatever code it receives, so:

- it only accepts requests from Chrome extensions (add other origins with
  `LEETVIZ_ORIGINS`), which stops websites you visit from using it;
- it listens on `127.0.0.1` unless you pass `--host`;
- `LEETVIZ_TOKEN=...` makes it require that token, which you then enter in
  the panel.

Don't expose it to a network without a sandbox such as the Docker container
above.

To try the panel without LeetCode, open
`chrome-extension://<extension id>/panel/panel.html`. It loads a Two Sum demo
with three approaches already filled in.

## How it works

```
LeetCode page
 ├─ content/main-world.js   runs in the page; reads Monaco, draws line/value decorations
 ├─ content/content.js      docks the panel iframe, fetches problem data (GraphQL), relays messages
 └─ panel/ (iframe)         the UI: step player, visualizers, chart
      ├─ engine/worker.js   Web Worker running Pyodide + engine/tracer.py   (Python)
      └─ panel/remote.js    client for the LeetViz server                   (every other language)

server/
 ├─ index.js                HTTP server: POST /run streams progress, then the result (NDJSON)
 ├─ lib/runner.js           trace / measure / stress, the same for every language
 └─ langs/<language>.js     one adapter per language: build a driver, run it, trace it
```

Each language adapter does two things:

- **The driver** wraps the solution so it can be run with typed inputs. Inputs
  travel in a small token format (`lib/types.js`), and the driver turns them
  into that language's types (`vector<int>`, `List<Integer>`, `[Int]`,
  `Option<Box<ListNode>>`, …). It calls the solution and prints the result as
  JSON. In serve mode it repeats each size to time it, and measures memory where
  the language allows. The input generator stays in Python for every language.
- **The tracer** steps through the user's own file line by line, so every
  language produces the same trace format the panel draws. Your code is never
  moved, so line numbers always match the editor:

| Language | How it is stepped through |
|---|---|
| C, C++ | gdb with its Python API (libstdc++ pretty printers for STL containers) |
| Rust | gdb with Rust's own pretty printers (`Vec`, `HashMap`, `Option<Box<…>>`, `Rc<RefCell<…>>`) |
| Swift | lldb with its Python API and Swift's data formatters |
| Java, Kotlin, Scala | a JDI (Java Debug Interface) tracer that reads collections straight from their fields |
| JavaScript, TypeScript | the V8 inspector, from a worker thread inside the traced process (TypeScript through Node's type stripping) |
| Go | Delve's JSON-RPC API |
| C# | Roslyn instrumentation: probes record exactly the variables that are definitely assigned |
| Ruby | `TracePoint` |
| PHP | `phpdbg` |
| Dart | the Dart VM service |
| Python, Python 2 | `sys.settrace` (engine/tracer.py) |
| Racket, Erlang, Elixir | call by call: each call with its arguments, each return with its result |

- **Tracing** uses `sys.settrace`. Every `call`, `line`, `return` and
  `exception` event saves a snapshot of the stack's locals. The UI then
  scrubs back and forth through those snapshots.
- **Complexity** takes three measurements per approach:
  - *Lines executed*: traced, stopped once it passes a budget, so exponential
    code can't hang the tab.
  - *Wall-clock time*: untraced, so built-in calls are counted fairly.
  - *Peak extra memory*: `tracemalloc` after the inputs are built, plus
    recursion depth for stack space.

  Each curve is fitted against O(1) … O(n³). Exponential growth is detected
  separately (its log-log slope keeps increasing), so naive Fibonacci shows up
  as O(1.62ⁿ).
- **Input generator**: `gen(n, stress=False)` is written automatically from
  the problem's parameter types and examples, and you can edit it in the
  panel. Compare mode aims for the worst case, for example a target that can't
  be found. Stress mode uses small values with lots of duplicates.

## Limitations / next steps

- Racket, Erlang and Elixir are traced per function call (with arguments and
  results), not line by line.
- Python's simple view explains each line with real numbers ("Is 1 × 5 ≥ 7?").
  The other languages describe what changed instead ("`i` goes up by 1",
  "Write in the notebook `seen`: 2 ➜ 0").
- Memory use is measured differently in each language:
  - C, C++ and Rust track peak heap use.
  - Java, Kotlin, Scala, C#, Go and Ruby count allocated bytes, which shows
    in the panel as "allocated".
  - Swift, Dart, Racket, Erlang and Elixir don't measure it.
- For languages other than Python, the Big-O comes from timing alone. Python
  also counts executed lines, which catches "hidden work" such as `x in list`.
- Python 2 code runs as Python 3.
- Design-style problems (`class LRUCache`) aren't supported yet. The engine
  expects a single function or method.
- Big-O is *measured*, so it's only as good as the generator's inputs. If the
  worst case needs a special input (sorted, all equal, …), edit `gen`.
- The editor integration relies on LeetCode's page structure (Monaco, the
  GraphQL `question` query), so a LeetCode redesign can break it.
  `content/main-world.js` and `fetchQuestion()` are the places to fix.
