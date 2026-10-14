// Driver generator for LeetCode's C signatures: arrays arrive as (pointer, size), 2-D arrays as
// (T** a, int aSize, int* aColSize), and returned arrays come back through returnSize /
// returnColumnSizes out-parameters.
import { CompileError } from '../../lib/build.js';

const PRELUDE = String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <limits.h>
#include <math.h>
#include <ctype.h>
#include <malloc.h>
#include <time.h>
struct ListNode { int val; struct ListNode *next; };
struct TreeNode { int val; struct TreeNode *left; struct TreeNode *right; };
#if __has_include("uthash.h")
#include "uthash.h"
#endif
static size_t lv_cur = 0, lv_peak = 0;
static int lv_depth = 0, lv_maxdepth = 0, lv_track = 0;
`;

const RUNTIME = String.raw`
void *__real_malloc(size_t); void __real_free(void *); void *__real_calloc(size_t, size_t); void *__real_realloc(void *, size_t);
#ifdef LV_TRACE
/* Requested size of each live allocation, so the debugger can show a malloc'd int* as an array. */
#define LV_TAB (1 << 16)
static struct { void *p; size_t n; } lv_tab[LV_TAB];
static size_t lv_slot(void *p) { return ((uintptr_t)p >> 4) * 2654435761u % LV_TAB; }
static void lv_note(void *p, size_t n) { if (!p) return; size_t i = lv_slot(p); for (int k = 0; k < 64; k++, i = (i + 1) % LV_TAB) if (!lv_tab[i].p || lv_tab[i].p == p || lv_tab[i].p == (void *)1) { lv_tab[i].p = p; lv_tab[i].n = n; return; } }
static void lv_forget(void *p) { if (!p) return; size_t i = lv_slot(p); for (int k = 0; k < 64; k++, i = (i + 1) % LV_TAB) if (lv_tab[i].p == p) { lv_tab[i].p = (void *)1; return; } else if (!lv_tab[i].p) return; }
__attribute__((used, noinline)) size_t lv_alloc_size(void *p) { size_t i = lv_slot(p); for (int k = 0; k < 64; k++, i = (i + 1) % LV_TAB) if (lv_tab[i].p == p) return lv_tab[i].n; else if (!lv_tab[i].p) return 0; return 0; }
#else
#define lv_note(p, n)
#define lv_forget(p)
#endif
static void lv_add(void *p) { if (p) { lv_cur += malloc_usable_size(p); if (lv_cur > lv_peak) lv_peak = lv_cur; } }
void *__wrap_malloc(size_t n) { void *p = __real_malloc(n); lv_add(p); lv_note(p, n); return p; }
void *__wrap_calloc(size_t a, size_t b) { void *p = __real_calloc(a, b); lv_add(p); lv_note(p, a * b); return p; }
void *__wrap_realloc(void *q, size_t n) { if (q) { lv_cur -= malloc_usable_size(q); lv_forget(q); } void *p = __real_realloc(q, n); lv_add(p ? p : q); lv_note(p ? p : q, p ? n : 0); return p; }
void __wrap_free(void *p) { if (p) { lv_cur -= malloc_usable_size(p); lv_forget(p); } __real_free(p); }
__attribute__((no_instrument_function)) void __cyg_profile_func_enter(void *a, void *b) { if (lv_track && ++lv_depth > lv_maxdepth) lv_maxdepth = lv_depth; }
__attribute__((no_instrument_function)) void __cyg_profile_func_exit(void *a, void *b) { if (lv_track) --lv_depth; }

typedef struct { const char *p; } LvIn;
static const char *lv_tok(LvIn *in, int *len) { while (*in->p == ' ') in->p++; const char *s = in->p; while (*in->p && *in->p != ' ') in->p++; *len = (int)(in->p - s); return s; }
static long long lv_int(LvIn *in) { int n; const char *s = lv_tok(in, &n); return strtoll(s, NULL, 10); }
static double lv_dbl(LvIn *in) { int n; const char *s = lv_tok(in, &n); return strtod(s, NULL); }
static bool lv_bool(LvIn *in) { int n; const char *s = lv_tok(in, &n); return n == 1 && s[0] == '1'; }
static char *lv_str(LvIn *in) {
  int n; const char *s = lv_tok(in, &n); char *o = malloc(n + 1); int k = 0;
  for (int i = 1; i < n; i++) {
    if (s[i] == '%' && i + 2 < n) { char h[3] = { s[i + 1], s[i + 2], 0 }; o[k++] = (char)strtol(h, NULL, 16); i += 2; }
    else o[k++] = s[i];
  }
  o[k] = 0; return o;
}
static char lv_char(LvIn *in) { char *s = lv_str(in); char c = s[0]; free(s); return c; }
static bool lv_istok(LvIn *in, const char *t) { const char *p = in->p; while (*p == ' ') p++; return strncmp(p, t, strlen(t)) == 0 && (p[strlen(t)] == ' ' || !p[strlen(t)]); }
static struct ListNode *lv_list(LvIn *in) {
  int n = (int)lv_int(in); struct ListNode d = {0, NULL}, *c = &d;
  for (int i = 0; i < n; i++) { c->next = malloc(sizeof(struct ListNode)); c = c->next; c->val = (int)lv_int(in); c->next = NULL; }
  return d.next;
}
static struct TreeNode *lv_newnode(int v) { struct TreeNode *t = malloc(sizeof(struct TreeNode)); t->val = v; t->left = t->right = NULL; return t; }
static struct TreeNode *lv_tree(LvIn *in) {
  int n = (int)lv_int(in); if (!n) return NULL;
  struct TreeNode **q = malloc(sizeof(struct TreeNode *) * (n + 1)); int head = 0, tail = 0, i = 0;
  int len; const char *s = lv_tok(in, &len); i = 1;
  if (s[0] == '#') { for (; i < n; i++) lv_tok(in, &len); free(q); return NULL; }
  struct TreeNode *root = lv_newnode(atoi(s)); q[tail++] = root;
  while (head < tail && i < n) {
    struct TreeNode *node = q[head++];
    if (i < n) { s = lv_tok(in, &len); if (s[0] != '#') { node->left = lv_newnode(atoi(s)); q[tail++] = node->left; } i++; }
    if (i < n) { s = lv_tok(in, &len); if (s[0] != '#') { node->right = lv_newnode(atoi(s)); q[tail++] = node->right; } i++; }
  }
  for (; i < n; i++) lv_tok(in, &len);
  free(q); return root;
}

typedef struct { char *b; size_t n, cap; } LvOut;
static void lv_put(LvOut *o, const char *s) { size_t k = strlen(s); if (o->n + k + 1 > o->cap) { o->cap = (o->n + k + 1) * 2; o->b = __real_realloc(o->b, o->cap); } memcpy(o->b + o->n, s, k + 1); o->n += k; }
static void lv_w_int(LvOut *o, long long x) { char b[32]; snprintf(b, sizeof b, "%lld", x); lv_put(o, b); }
static void lv_w_dbl(LvOut *o, double x) { char b[40]; if (!isfinite(x)) { lv_put(o, "null"); return; } snprintf(b, sizeof b, "%.10g", x); lv_put(o, b); }
static void lv_w_bool(LvOut *o, bool x) { lv_put(o, x ? "true" : "false"); }
static void lv_w_str(LvOut *o, const char *s) {
  lv_put(o, "\""); char b[8];
  for (; s && *s; s++) { unsigned char c = (unsigned char)*s; if (c == '"' || c == '\\') { b[0] = '\\'; b[1] = c; b[2] = 0; lv_put(o, b); } else if (c < 0x20) { snprintf(b, sizeof b, "\\u%04x", c); lv_put(o, b); } else { b[0] = c; b[1] = 0; lv_put(o, b); } }
  lv_put(o, "\"");
}
static void lv_w_char(LvOut *o, char c) { char s[2] = { c, 0 }; lv_w_str(o, s); }
static void lv_w_list(LvOut *o, struct ListNode *h) { lv_put(o, "["); for (int k = 0; h && k < 100000; h = h->next, k++) { if (k) lv_put(o, ","); lv_w_int(o, h->val); } lv_put(o, "]"); }
static void lv_w_tree(LvOut *o, struct TreeNode *root) {
  int cap = 1024, n = 0, last = 0; struct TreeNode **q = __real_malloc(sizeof(struct TreeNode *) * cap); q[n++] = root;
  LvOut tmp = {0}; lv_put(&tmp, "");
  lv_put(o, "[");
  for (int i = 0; i < n && n < 400000; i++) {
    if (i) lv_put(&tmp, ",");
    if (q[i]) {
      lv_w_int(&tmp, q[i]->val); lv_put(o, tmp.b); tmp.n = 0; tmp.b[0] = 0; last = i;
      if (n + 2 > cap) { cap *= 2; q = __real_realloc(q, sizeof(struct TreeNode *) * cap); }
      q[n++] = q[i]->left; q[n++] = q[i]->right;
    } else lv_put(&tmp, "null");
  }
  lv_put(o, "]"); __real_free(q); __real_free(tmp.b);
}
static double lv_now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }
`;

const MAIN = String.raw`int main(int argc, char **argv) {
  static char line[1 << 24];
  LvOut out = {0}; lv_put(&out, "");
  if (argc > 1 && !strcmp(argv[1], "trace")) {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (!fgets(line, sizeof line, stdin)) return 1;
    line[strcspn(line, "\n")] = 0;
    lv_run(line, &out);
    printf("\n\001LV %s\n", out.b);
    return 0;
  }
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\n")] = 0;
    LvIn in = { line };
    double minTime = lv_dbl(&in); int maxRuns = (int)lv_int(&in); lv_int(&in);
    double total = 0; int runs = 0;
    do { total += lv_run(in.p, &out); runs++; } while (runs < maxRuns && total < minTime);
    printf("\001LV {\"t\":%.9g,\"runs\":%d,\"mem\":%lld,\"depth\":%d,\"out\":%s}\n", total / runs, runs, lv_mem, lv_dep, out.b);
    fflush(stdout);
  }
  return 0;
}
`;

const ELEM = { int: 'int', long: 'long long', double: 'double', bool: 'bool', char: 'char', string: 'char*', ListNode: 'struct ListNode*', TreeNode: 'struct TreeNode*' };
const READ = { int: 'lv_int(in)', long: 'lv_int(in)', double: 'lv_dbl(in)', bool: 'lv_bool(in)', char: 'lv_char(in)', string: 'lv_str(in)', ListNode: 'lv_list(in)', TreeNode: 'lv_tree(in)' };
const WRITE = { int: 'lv_w_int', long: 'lv_w_int', double: 'lv_w_dbl', bool: 'lv_w_bool', char: 'lv_w_char', string: 'lv_w_str', ListNode: 'lv_w_list', TreeNode: 'lv_w_tree' };

const isSeq = (t) => t.k === 'array' || t.k === 'list';

function shape(t) {
  if (!isSeq(t)) {
    if (!ELEM[t.k]) throw new CompileError(`C: unsupported type ${t.k}`);
    return { dims: 0, elem: t.k };
  }
  if (!isSeq(t.of)) {
    if (!ELEM[t.of.k]) throw new CompileError(`C: unsupported type ${t.of.k}[]`);
    return { dims: 1, elem: t.of.k };
  }
  if (!isSeq(t.of.of) && ELEM[t.of.of.k]) return { dims: 2, elem: t.of.of.k };
  throw new CompileError('C: arrays nested deeper than 2 levels aren\'t supported');
}

function readParam(t, v) {
  const { dims, elem } = shape(t);
  const E = ELEM[elem];
  // A char[] (character[]) is a char* string in LeetCode's C signatures only when it's a string;
  // character[] params are passed as (char* s, int sSize) like other arrays.
  if (dims === 0) return { code: `${E} ${v} = ${READ[elem]};`, args: [v] };
  if (dims === 1) {
    return {
      code: `int ${v}Size = (int)lv_int(in); ${E}* ${v} = malloc(sizeof(${E}) * (${v}Size + (${elem === 'char'} ? 1 : 0) + !${v}Size)); for (int i = 0; i < ${v}Size; i++) ${v}[i] = ${READ[elem]};${elem === 'char' ? ` ${v}[${v}Size] = 0;` : ''}`,
      args: [v, `${v}Size`],
      size: `${v}Size`,
    };
  }
  return {
    code: `int ${v}Size = (int)lv_int(in); ${E}** ${v} = malloc(sizeof(${E}*) * (${v}Size + !${v}Size)); int* ${v}ColSize = malloc(sizeof(int) * (${v}Size + !${v}Size));
    for (int i = 0; i < ${v}Size; i++) { int m = (int)lv_int(in); ${v}ColSize[i] = m; ${v}[i] = malloc(sizeof(${E}) * (m + (${elem === 'char'} ? 1 : 0) + !m)); for (int j = 0; j < m; j++) ${v}[i][j] = ${READ[elem]};${elem === 'char' ? ` ${v}[i][m] = 0;` : ''} }`,
    args: [v, `${v}Size`, `${v}ColSize`],
    size: `${v}Size`, cols: `${v}ColSize`,
  };
}

function writeValue(t, expr, size, cols) {
  const { dims, elem } = shape(t);
  const w = WRITE[elem];
  if (dims === 0) return `${w}(o, ${expr});`;
  if (dims === 1) return `lv_put(o, "["); for (int i = 0; i < ${size}; i++) { if (i) lv_put(o, ","); ${w}(o, ${expr}[i]); } lv_put(o, "]");`;
  return `lv_put(o, "["); for (int i = 0; i < ${size}; i++) { if (i) lv_put(o, ","); lv_put(o, "["); for (int j = 0; j < (${cols} ? ${cols}[i] : 0); j++) { if (j) lv_put(o, ","); ${w}(o, ${expr}[i][j]); } lv_put(o, "]"); } lv_put(o, "]");`;
}

export function cDriver(code, sig) {
  const params = sig.params.map((p, i) => readParam(p.t, `a${i}`));
  const args = params.flatMap((p) => p.args);
  let call;
  let write;
  if (sig.ret.k === 'void') {
    call = `${sig.method}(${args.join(', ')});`;
    const first = params[0];
    write = writeValue(sig.params[0].t, 'a0', first.size, first.cols);
  } else {
    const { dims, elem } = shape(sig.ret);
    const E = ELEM[elem];
    if (dims === 0) {
      call = `${E} r = ${sig.method}(${args.join(', ')});`;
      write = writeValue(sig.ret, 'r');
    } else if (dims === 1) {
      call = `int rSize = 0; ${E}* r = ${sig.method}(${[...args, '&rSize'].join(', ')});`;
      write = writeValue(sig.ret, 'r', 'rSize');
    } else {
      call = `int rSize = 0; int* rCol = NULL; ${E}** r = ${sig.method}(${[...args, '&rSize', '&rCol'].join(', ')});`;
      write = writeValue(sig.ret, 'r', 'rSize', 'rCol');
    }
  }
  // Result writing happens inside the same block as the call (the result's variables live there).
  return `${PRELUDE}#line 1 "solution.c"
${code}
#line 1 "driver.c"
${RUNTIME}
static long long lv_mem = -1; static int lv_dep = -1;
__attribute__((noinline)) static double lv_run(const char *p, LvOut *o) {
  LvIn inv = { p }; LvIn *in = &inv;
  ${params.map((x) => x.code).join('\n  ')}
  size_t base = lv_cur; lv_peak = lv_cur; lv_depth = 0; lv_maxdepth = 0; lv_track = 1;
  double t0 = lv_now();
  ${call}
  double t1 = lv_now();
  lv_track = 0; lv_mem = (long long)(lv_peak - base); lv_dep = lv_maxdepth;
  o->n = 0; if (o->b) o->b[0] = 0;
  ${write}
  return t1 - t0;
}
${MAIN}`;
}
