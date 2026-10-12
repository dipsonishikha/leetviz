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

Everything runs locally. Python runs in the browser through
[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly), and no code
is sent anywhere.

## Install (developer mode)

```bash
./scripts/fetch-pyodide.sh       # downloads the ~14 MB Python runtime into vendor/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `leetviz/` folder.
3. Open any `leetcode.com/problems/...` page, set the language to **Python3**,
   then click the **LeetViz** tab on the right edge or press **Alt+V**.

To try the panel without LeetCode, open
`chrome-extension://<extension id>/panel/panel.html`. It loads a Two Sum demo
with three approaches already filled in.

## How it works

```
LeetCode page
 ├─ content/main-world.js   runs in the page; reads Monaco, draws line/value decorations
 ├─ content/content.js      docks the panel iframe, fetches problem data (GraphQL), relays messages
 └─ panel/ (iframe)         the UI: step player, visualizers, chart
      └─ engine/worker.js   Web Worker running Pyodide + engine/tracer.py
```

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

- Python 3 only. JavaScript would be the next language, by instrumenting the AST.
- Design-style problems (`class LRUCache`) aren't supported yet. The engine
  expects `class Solution`.
- Big-O is *measured*, so it's only as good as the generator's inputs. If the
  worst case needs a special input (sorted, all equal, …), edit `gen`.
- The editor integration relies on LeetCode's page structure (Monaco, the
  GraphQL `question` query), so a LeetCode redesign can break it.
  `content/main-world.js` and `fetchQuestion()` are the places to fix.
