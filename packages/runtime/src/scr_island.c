/* The dynamic island: an embedded QuickJS-ng engine, compiled and linked
 * ONLY under -DSCR_DYNAMIC (the --dynamic build mode). Static builds see an
 * empty translation unit — nothing here may leak into them.
 *
 * Model:
 * - ONE JSRuntime + JSContext per process, created lazily on the first
 *   island entry and torn down at exit BEFORE the RC audit (atexit is LIFO;
 *   scr_init registered the audit at startup, so a handler registered at
 *   first entry runs earlier). Teardown asserts the engine's live-allocation
 *   count is zero in the audit lane — the counting allocator passed to
 *   JS_NewRuntime2 is the leak oracle (Apple ASan has no LeakSanitizer on
 *   macOS arm64).
 * - NOT reentrant: island entry points must not be called from inside an
 *   engine callback (host function, finalizer). Single-threaded by design;
 *   there is no engine TLS, so migrating between ucontext fibers is safe
 *   BECAUSE every entry re-anchors the engine's stack-overflow check.
 * - Fiber safety: scriptc runs user code on fixed-size ucontext fibers
 *   (scr_async.c; 256KB, 1MB under ASan). The engine checks stack overflow
 *   against a stack top
 *   captured at runtime creation, so isl_entry() calls JS_UpdateStackTop on
 *   EVERY entry (unconditionally — it is cheap) and init budgets the stack
 *   well inside the fiber size (see ISL_STACK_BUDGET below for the ASan
 *   measurement). Skipping the re-anchor does not fail gracefully — it
 *   SIGBUSes.
 * - Ownership rules of the C API, encapsulated here so callers never see
 *   them: JS_SetPropertyStr CONSUMES its value; JS_GetPropertyStr returns
 *   OWNED; after any JS_IsException hit, JS_GetException must be called
 *   (owned; clears the pending state) or the next engine call misbehaves;
 *   JS_ToCStringLen pairs with JS_FreeCString; JS_NewStringLen takes UTF-8
 *   (ScrStr storage is UTF-8 — direct).
 */
#ifdef SCR_DYNAMIC

#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

#if defined(__APPLE__)
#include <malloc/malloc.h>
#define isl_malloc_size malloc_size
#elif defined(_WIN32)
#include <malloc.h>
/* The CRT's usable-size probe (vendored cutils.h makes the same choice);
 * _msize takes a non-const pointer, hence the cast. */
#define isl_malloc_size(p) _msize((void *)(p))
#else
#include <malloc.h>
#define isl_malloc_size malloc_usable_size
#endif

/* Engine stack budget FOR FIBER ENTRIES: HALF the fiber stack size
 * (scr_async.c SCR_FIBER_STACK), leaving the other half as margin for the
 * C excursion past the engine's last overflow check. Under ASan both
 * scale up together (8MB fibers, 4MB budget): measured on the
 * Debug+ASan engine, ONE function call costs 64–96KB of C stack and a
 * host→JS callback chain (Array.prototype.map + arrow) overruns even
 * 128KB — a small ASan budget cannot execute anything real, and a real
 * embedded graph entered from a fiber (a CLI action awaiting
 * generateText — zod parses inside promise chains) nests dozens of
 * engine frames. Entries from
 * the MAIN stack get ISL_MAIN_STACK_BUDGET instead (see isl_entry) —
 * embedded npm package call chains need more than a fiber can offer.
 * Overridable for experiments (-DSCR_ISLAND_STACK_BUDGET=...). */
#ifndef SCR_ISLAND_STACK_BUDGET
#if defined(__SANITIZE_ADDRESS__)
#define SCR_ISLAND_STACK_BUDGET (4 * 1024 * 1024)
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_ISLAND_STACK_BUDGET (4 * 1024 * 1024)
#endif
#endif
#endif
#ifndef SCR_ISLAND_STACK_BUDGET
#define SCR_ISLAND_STACK_BUDGET (128 * 1024)
#endif
#define ISL_STACK_BUDGET SCR_ISLAND_STACK_BUDGET

/* Node's default stream highWaterMark is platform-split at the source
 * (lib/internal/streams/state.js: `process.platform === 'win32' ?
 * 16 * 1024 : 64 * 1024`), so the island's stream shim splices the
 * target's value into its JS — the same triple-decided split as
 * scr_stream.c's SCR_STREAM_DEFAULT_HWM. */
#ifdef _WIN32
#define ISL_STREAM_DEFAULT_HWM "16384"
#else
#define ISL_STREAM_DEFAULT_HWM "65536"
#endif

/* ── counting allocator (the leak oracle) ─────────────────────────────
 * Every engine allocation goes through these; live must return to zero
 * after JS_FreeRuntime or the engine (or our wrapper layer) leaked. */
static long isl_live_allocs = 0;

static void *isl_calloc(void *opaque, size_t count, size_t size) {
  (void)opaque;
  void *p = calloc(count, size);
  if (p) isl_live_allocs++;
  return p;
}
static void *isl_malloc(void *opaque, size_t size) {
  (void)opaque;
  void *p = malloc(size);
  if (p) isl_live_allocs++;
  return p;
}
static void isl_free(void *opaque, void *ptr) {
  (void)opaque;
  if (ptr) isl_live_allocs--;
  free(ptr);
}
static void *isl_realloc_fn(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  void *p = realloc(ptr, size);
  if (!ptr && p) isl_live_allocs++;
  return p;
}
static size_t isl_usable_size(const void *ptr) { return isl_malloc_size((void *)ptr); }

static const JSMallocFunctions isl_mf = {
    isl_calloc, isl_malloc, isl_free, isl_realloc_fn, isl_usable_size,
};

/* ── the one runtime/context ──────────────────────────────────────────── */

static JSRuntime *isl_rt = NULL;
static JSContext *isl_ctx = NULL;

/* ── embedded npm module tables (emitted static data) ─────────────────── */

static const ScrIslandModule *isl_mods = NULL;
static size_t isl_nmods = 0;
static const ScrIslandEdge *isl_edges = NULL;
static size_t isl_nedges = 0;

/* Compressed embedded module text (src_raw/esm_raw > 0: raw DEFLATE, the
 * emitter's size lever) inflates LAZILY at a module's first load and the
 * inflated copy caches for the process lifetime — like the engine's own
 * module cache, so the cost is once per loaded module and a module a run
 * never loads never inflates (its pages never even fault in). The
 * inflater is installed by the emitted main exactly when some module
 * compressed at build time (scr_zlib.c links on the same predicate). */
static bool (*isl_inflate)(const unsigned char *, size_t, unsigned char *, size_t) = NULL;
static char **isl_text_cache = NULL; /* 2 slots per module: src, esm */

void scr_island_set_inflate(bool (*inflate)(const unsigned char *src, size_t src_len,
                                            unsigned char *dst, size_t dst_len)) {
  isl_inflate = inflate;
}

void scr_island_modules(const ScrIslandModule *mods, size_t nmods,
                         const ScrIslandEdge *edges, size_t nedges) {
  isl_mods = mods;
  isl_nmods = nmods;
  isl_edges = edges;
  isl_nedges = nedges;
}

/* The module's SOURCE (esm=false) or ESM-facade (esm=true) text, inflating
 * a compressed embed on first use. NULL only on inflation failure (a
 * build/runtime mismatch — the caller throws). The returned text is
 * NUL-terminated either way (the emitter's plain strings are literals). */
static const char *isl_mod_text(const ScrIslandModule *m, bool esm, size_t *len_out) {
  const char *stored = esm ? m->esm : m->src;
  size_t stored_len = esm ? m->esm_len : m->len;
  size_t raw = esm ? m->esm_raw : m->src_raw;
  if (raw == 0) {
    *len_out = stored_len;
    return stored;
  }
  if (!isl_text_cache) {
    isl_text_cache = calloc(isl_nmods * 2, sizeof(char *));
    if (!isl_text_cache) return NULL;
  }
  char **slot = &isl_text_cache[(size_t)(m - isl_mods) * 2 + (esm ? 1 : 0)];
  if (!*slot) {
    char *text = malloc(raw + 1);
    if (!text) return NULL;
    if (!isl_inflate ||
        !isl_inflate((const unsigned char *)stored, stored_len, (unsigned char *)text, raw)) {
      free(text);
      return NULL;
    }
    text[raw] = '\0';
    *slot = text;
  }
  *len_out = raw;
  return *slot;
}

static const ScrIslandModule *isl_mod_find(const char *key) {
  for (size_t i = 0; i < isl_nmods; i++) {
    if (strcmp(isl_mods[i].key, key) == 0) return &isl_mods[i];
  }
  return NULL;
}

/* `want` is the LOOKUP's edge kind — the module loader asks with 1
 * (import), the require shim with 2 (require). A dual package (an
 * "exports" map whose "import" and "require" conditions name different
 * files) embeds two edges for one (from, spec); the kind picks Node's
 * entry for the call form. An import lookup missing its own kind falls
 * back to a require edge — a build-time-invisible import() of a spec the
 * file only require()s loads the CJS entry through its facade, which is
 * the module Node's require condition serves — but a require lookup
 * NEVER falls back: import-kind edges can target real ES modules or
 * throwing import traps, and the shim's MODULE_NOT_FOUND is the honest
 * answer for a require the build never resolved. */
static const char *isl_edge_find(const char *from, const char *spec, int want) {
  const char *fallback = NULL;
  for (size_t i = 0; i < isl_nedges; i++) {
    if (strcmp(isl_edges[i].from, from) != 0 || strcmp(isl_edges[i].spec, spec) != 0) continue;
    int kind = isl_edges[i].kind;
    if (kind == 0 || kind == want) return isl_edges[i].to;
    if (want == 1 && kind == 2) fallback = isl_edges[i].to;
  }
  return fallback;
}

/* Defined with the module system below; called from isl_init. */
static void isl_install_module_loader(void);
/* Defined with the host-function machinery below; called from isl_init. */
static void isl_register_hostfn_class(void);
/* Defined with the island → static promise bridge below; called from the
 * host-function registration (both classes register together). */
static void isl_register_bridge_class(void);
/* Defined with the loop-io machinery below; registered by isl_init. */
static bool isl_io_pending(void);
static void isl_io_poll(double max_wait_ms);

/* The fetch bridge's hooks (scr_fetch.c; linked only into fetch-using
 * builds). Registered by scr_fetch_install from the emitted main, BEFORE
 * the engine's lazy boot — isl_init consults them. The native bridge
 * registers boot/teardown only (its transfers ride scr_net sockets the
 * loop's poller sleeps on); the curl reference (scr_fetch_curl.c) also
 * registers pending/poll so the loop can sleep on curl's fds. */
static void (*isl_fetch_boot)(void *jsctx) = NULL;
static bool (*isl_fetch_pending)(void) = NULL;
static void (*isl_fetch_poll)(double max_wait_ms) = NULL;
static void (*isl_fetch_teardown)(void) = NULL;

void scr_island_set_fetch(void (*boot)(void *), bool (*pending)(void),
                           void (*poll)(double), void (*teardown)(void)) {
  isl_fetch_boot = boot;
  isl_fetch_pending = pending;
  isl_fetch_poll = poll;
  isl_fetch_teardown = teardown;
}

/* The node:http/https client bridge's hooks (scr_net_island.c; linked
 * only when the socket units are). `attach` adds the bridge's host
 * functions while the module bootstrap builds its host object;
 * `teardown` frees engine values in-flight exchanges still hold. */
static void (*isl_netmod_attach)(void *jsctx, void *host_obj) = NULL;
static void (*isl_netmod_teardown)(void) = NULL;

void scr_island_set_netmod(void (*attach)(void *jsctx, void *host_obj), void (*teardown)(void)) {
  isl_netmod_attach = attach;
  isl_netmod_teardown = teardown;
}

/* ── unhandled island rejections ──────────────────────────────────────
 * JS_SetHostPromiseRejectionTracker signals BOTH directions: is_handled ==
 * false when a promise rejects with no reaction attached (tracked here,
 * promise and reason retained), is_handled == true when a handler is
 * attached to it later (the rescission: unlinked and freed — a
 * handled-later rejection never reports). At the completed microtask
 * checkpoint the ledger joins scr_report_unhandled_rejections through
 * the hook registered at boot: the FIRST never-observed rejection prints
 * in the static runtime's exact voice ("Unhandled promise rejection:
 * <String(reason)>", stderr, exit 1 — an Error reason renders "name:
 * message" through its toString, same as the static ledger). Retaining
 * the promise value keeps its identity stable for the rescission (the
 * engine cannot recycle the object while the ledger holds it). */
typedef struct IslRejection {
  JSValue promise; /* owned; identity for the rescission */
  JSValue reason;  /* owned */
  struct IslRejection *next;
} IslRejection;

static IslRejection *isl_rejections = NULL; /* insertion order (append) */
static IslRejection **isl_rejections_tail = &isl_rejections;

static void isl_rejection_free(IslRejection *r) {
  JS_FreeValue(isl_ctx, r->promise);
  JS_FreeValue(isl_ctx, r->reason);
  free(r);
}

static void isl_rejections_drop_reason(JSValueConst reason);

static void isl_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                  JSValueConst reason, bool is_handled,
                                  void *opaque) {
  (void)ctx;
  (void)opaque;
  (void)promise;
  if (is_handled) {
    /* The rescission drops the handled promise's entry AND its same-reason
     * twins: a failing module loaded by an engine-internal dynamic import()
     * leaves the INTERMEDIATE per-module promises rejected-and-unhandled
     * (only the returned top promise gets the caller's handler, but every
     * promise in the load carries the same reason object) — Node reports a
     * handled import() rejection zero times, and the importDyn boundary
     * already drops by reason for exactly this shape. */
    isl_rejections_drop_reason(reason);
    return;
  }
  /* The WebAssembly stub's rejections never ledger: real wasm SUCCEEDS
   * unobserved, so a never-awaited compile/instantiate chain must stay
   * silent at teardown (es-module-lexer's top-level `init` chain) — the
   * marker rides the reason object through derived promises, and an
   * awaited stub still rejects into its awaiter untouched. */
  if (JS_IsObject(reason)) {
    JSValue marker = JS_GetPropertyStr(ctx, reason, "__scr_wasm_stub");
    bool is_stub = JS_ToBool(ctx, marker) > 0;
    JS_FreeValue(ctx, marker);
    if (is_stub) return;
  }
  IslRejection *r = malloc(sizeof *r);
  if (!r) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  r->promise = JS_DupValue(ctx, promise);
  r->reason = JS_DupValue(ctx, reason);
  r->next = NULL;
  *isl_rejections_tail = r;
  isl_rejections_tail = &r->next;
}

/* The report hook (scr_async.c calls it inside
 * scr_report_unhandled_rejections): print the first survivor when the
 * static ledger was silent, free the whole ledger either way. */
static bool isl_report_rejections(bool print) {
  if (isl_rejections == NULL) return false;
  if (print) {
    fflush(stdout);
    fputs("Unhandled promise rejection: ", stderr);
    const char *msg = JS_ToCString(isl_ctx, isl_rejections->reason);
    if (msg) {
      fputs(msg, stderr);
      JS_FreeCString(isl_ctx, msg);
    } else {
      /* String(reason) itself threw (a symbol): clear it, keep the same
       * fallback the static printer uses for unrenderable payloads. */
      JSValue second = JS_GetException(isl_ctx);
      JS_FreeValue(isl_ctx, second);
      fputs("[object]", stderr);
    }
    fputc('\n', stderr);
  }
  while (isl_rejections) {
    IslRejection *r = isl_rejections;
    isl_rejections = r->next;
    isl_rejection_free(r);
  }
  isl_rejections_tail = &isl_rejections;
  return true;
}

/* Prelude helper closures (one per SCR_JSOP_* plus the unary/indexing
 * helpers and the promise-bridge subscription), pinned at init so
 * operations on `any` values are JS_Call invocations of real JS operators
 * — coercion semantics (ToPrimitive, NaN, string +) come from the engine,
 * never from C reimplementations. ISL_H_THEN subscribes the island →
 * static promise bridge: Promise.resolve first, so thenables and plain
 * values behave exactly like `await` would treat them. */
enum {
  ISL_H_NEG = SCR_JSOP_COUNT,
  ISL_H_PLUS,
  ISL_H_TYPEOF,
  ISL_H_GETIDX,
  ISL_H_SETIDX,
  ISL_H_THEN,
  ISL_H_DESTRCHECK,
  ISL_H_ITERN,
  ISL_H_ITER,
  ISL_H_CALLSPREAD,
  ISL_H_OBJWALK,
  ISL_H_HASOWN,
  ISL_H_ASSIGN,
  ISL_H_ITERDRAIN,
  ISL_H_COUNT,
};

static JSValue isl_helpers[ISL_H_COUNT];

/* ISL_H_DESTRCHECK / ISL_H_ITERN are the destructuring guards: the check
 * throws V8's EXACT RequireObjectCoercible TypeError text ("Cannot
 * destructure 'a' as it is undefined.", the property form when the
 * pattern's first property is passed) and passes the value through;
 * iterN is GetIterator + the pattern's width as an array (V8's exact
 * not-iterable text), spec-shaped: done padding, IteratorClose when the
 * iterator is not exhausted. Both run IN the engine, so iterator
 * protocols, Proxies, and number formatting are the engine's own. */
static const char isl_prelude[] =
    "[(a,b)=>a+b,(a,b)=>a-b,(a,b)=>a*b,(a,b)=>a/b,(a,b)=>a%b,(a,b)=>a**b,"
    "(a,b)=>a<b,(a,b)=>a<=b,(a,b)=>a>b,(a,b)=>a>=b,(a,b)=>a===b,(a,b)=>a!==b,"
    "a=>-a,a=>+a,a=>typeof a,(o,k)=>o[k],(o,k,v)=>{o[k]=v},"
    "(p,f,r)=>{Promise.resolve(p).then(f,r)},"
    "(v,s,p)=>{if(v===undefined||v===null){const k=v===undefined?\"undefined\":\"null\";"
    "throw new TypeError(p===undefined?\"Cannot destructure '\"+s+\"' as it is \"+k+\".\""
    ":\"Cannot destructure property '\"+p+\"' of '\"+s+\"' as it is \"+k+\".\")}return v},"
    "(v,n)=>{if(v===undefined||v===null||typeof v[Symbol.iterator]!==\"function\"){"
    "let d;if(v===undefined)d=\"undefined\";else if(v===null)d=\"object null\";"
    "else if(typeof v===\"number\")d=\"number \"+v;else if(typeof v===\"boolean\")d=\"boolean \"+v;"
    "else if(typeof v===\"function\")d=\"function\";else d=\"object\";"
    "throw new TypeError(d+\" is not iterable (cannot read property Symbol(Symbol.iterator))\")}"
    "const o=[];const it=v[Symbol.iterator]();let dn=false;"
    "for(let i=0;i<n;i++){if(dn){o.push(void 0);continue}const r=it.next();"
    "if(r.done){dn=true;o.push(void 0)}else o.push(r.value)}"
    "if(!dn&&typeof it.return===\"function\")it.return();return o},"
    /* ISL_H_ITER: GetIterator alone (the for-of head over an island
     * value) — the same not-iterable TypeError text as iterN; the static
     * side drives next() through callMethod. */
    "v=>{if(v===undefined||v===null||typeof v[Symbol.iterator]!==\"function\"){"
    "let d;if(v===undefined)d=\"undefined\";else if(v===null)d=\"object null\";"
    "else if(typeof v===\"number\")d=\"number \"+v;else if(typeof v===\"boolean\")d=\"boolean \"+v;"
    "else if(typeof v===\"function\")d=\"function\";else d=\"object\";"
    "throw new TypeError(d+\" is not iterable (cannot read property Symbol(Symbol.iterator))\")}"
    "return v[Symbol.iterator]()},"
    /* ISL_H_CALLSPREAD: spread application (`f(...pre, ...s)` — the
     * rest-forwarding idiom's call): REAL spread syntax, so iterator
     * protocols are the engine's own; the guards front-run V8's exact
     * spread-call TypeError texts (nullish spells the spread expression
     * `w`, everything else the generic Spread-syntax text). */
    "(f,p,s,w)=>{if(s===undefined||s===null)"
    "throw new TypeError(w+\" is not iterable (cannot read property \"+s+\")\");"
    "if(typeof s[Symbol.iterator]!==\"function\")"
    "throw new TypeError(\"Spread syntax requires ...iterable[Symbol.iterator] to be a function\");"
    "return f(...p,...s)},"
    /* ISL_H_OBJWALK / ISL_H_HASOWN / ISL_H_ASSIGN: the Object statics a
     * wrapped (SCR_DYN_JSVAL) receiver routes here — the engine's own
     * semantics (own-key order, getters running, ToObject refusals). */
    "(o,m)=>m===0?Object.keys(o):m===1?Object.values(o):Object.entries(o),"
    "(o,k)=>Object.hasOwn(o,k),"
    "(t,s)=>Object.assign(t,s),"
    /* ISL_H_ITERDRAIN: the ENGINE's own iterator protocol drained into a
     * fresh array (for-of/destructuring/spread over a wrapped value —
     * generators, Maps, Sets, Symbol.iterator implementations all step
     * exactly as Node runs them). The guard front-runs the not-iterable
     * TypeError in the CALLER's wording: m=1 is V8's spread-call text,
     * s (when defined) the compile-time source spelling verbatim, else
     * the kind wording (iterN's). */
    "(v,m,s)=>{if(v===undefined||v===null||typeof v[Symbol.iterator]!==\"function\"){"
    "if(m===1)throw new TypeError(\"Spread syntax requires ...iterable[Symbol.iterator] to be a function\");"
    "if(s!==undefined)throw new TypeError(s);"
    "let d;if(v===undefined)d=\"undefined\";else if(v===null)d=\"object null\";"
    "else if(typeof v===\"number\")d=\"number \"+v;else if(typeof v===\"boolean\")d=\"boolean \"+v;"
    "else if(typeof v===\"function\")d=\"function\";else d=\"object\";"
    "throw new TypeError(d+\" is not iterable (cannot read property Symbol(Symbol.iterator))\")}"
    "const o=[];for(const x of v)o.push(x);return o}]";

static void isl_free_boot(void);
static void isl_prom_wraps_teardown(void);
static void isl_cells_teardown(void);

static void isl_teardown_at_exit(void) {
  if (!isl_rt) return;
  /* Promise-bridge wraps whose scriptc promise never settled still hold
   * the capability's settle functions (their waiter fibers are abandoned
   * — never unwound): freed like the fetch transfers below so the
   * counting allocator returns to zero. */
  isl_prom_wraps_teardown();
  /* Transfers still live at exit hold engine values (callback objects):
   * the fetch bridge frees them first so the counting allocator returns
   * to zero. */
  if (isl_fetch_teardown) isl_fetch_teardown();
  /* In-flight island http exchanges hold engine callback objects too —
   * the net bridge frees them the same way. */
  if (isl_netmod_teardown) isl_netmod_teardown();
  /* Unfired island timers (an AbortSignal.timeout that never mattered)
   * hold engine callbacks: freed like the fetch transfers above. */
  scr_island_timers_teardown();
  /* Armed static-heap timers may hold engine callbacks too (the island's
   * setTimeout/setInterval bridge): the loop only exits with entries
   * still armed on the uncaught/unhandled paths — release them before
   * the engine dies so the audit stays zero. */
  scr_timers_teardown();
  /* A ledger the report never consumed (an exit path that skips it) still
   * holds engine values: free them before the runtime goes down so the
   * counting allocator returns to zero. */
  while (isl_rejections) {
    IslRejection *r = isl_rejections;
    isl_rejections = r->next;
    isl_rejection_free(r);
  }
  isl_rejections_tail = &isl_rejections;
  /* Cells nothing will ever release (abandoned fibers' frames — a fiber
   * parked forever on a bridged package promise holds cells) still own
   * engine values: free the values (cells stay; a later release frees
   * only the block) so the runtime and the counting allocator go down
   * clean. LAST among the value-freeing steps — the ones above may
   * release cells, which unlinks them from this registry. */
  isl_cells_teardown();
  for (int i = 0; i < ISL_H_COUNT; i++) JS_FreeValue(isl_ctx, isl_helpers[i]);
  isl_free_boot();
  JS_FreeContext(isl_ctx);
  JS_FreeRuntime(isl_rt);
  isl_ctx = NULL;
  isl_rt = NULL;
  /* Inflated embedded sources (libc-heap, not engine allocations — the
   * audit never sees them): freed so a torn-down island leaves nothing. */
  if (isl_text_cache) {
    for (size_t i = 0; i < isl_nmods * 2; i++) free(isl_text_cache[i]);
    free(isl_text_cache);
    isl_text_cache = NULL;
  }
#ifdef SCR_RC_AUDIT
  if (isl_live_allocs != 0) {
    fflush(stdout);
    fprintf(stderr,
            "scriptc ISLAND AUDIT FAILED: %ld engine allocation(s) live "
            "after teardown\n",
            isl_live_allocs);
    _Exit(99);
  }
#endif
}

static void isl_init(void) {
  isl_rt = JS_NewRuntime2(&isl_mf, NULL);
  if (!isl_rt) {
    fprintf(stderr, "scriptc: island engine runtime allocation failed\n");
    abort();
  }
  JS_SetMaxStackSize(isl_rt, ISL_STACK_BUDGET);
  isl_ctx = JS_NewContext(isl_rt);
  if (!isl_ctx) {
    fprintf(stderr, "scriptc: island engine context allocation failed\n");
    abort();
  }
  JSValue arr = JS_Eval(isl_ctx, isl_prelude, sizeof isl_prelude - 1,
                        "<scr-prelude>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(arr)) {
    fprintf(stderr, "scriptc: island prelude failed to evaluate\n");
    abort();
  }
  for (uint32_t i = 0; i < ISL_H_COUNT; i++) {
    isl_helpers[i] = JS_GetPropertyUint32(isl_ctx, arr, i); /* owned */
  }
  JS_FreeValue(isl_ctx, arr);
  /* Web-platform globals (scr_web.c): BEFORE the module system boots —
   * embedded module evaluation may subclass TransformStream (eventsource-
   * parser does, at eval time). The fetch glue (installed by main in
   * fetch-using builds) boots right after: it builds on those globals. */
  scr_island_web_boot(isl_ctx);
  if (isl_fetch_boot) isl_fetch_boot(isl_ctx);
  /* The loop's io hook: engine promise jobs (and, in fetch-linked builds,
   * live transfers) drain at loop quiescence — island async chains
   * progress exactly where Node runs its microtasks. */
  scr_loop_set_io(isl_io_pending, isl_io_poll);
  /* Unhandled island rejections: tracked as they happen (and rescinded
   * when handled later), reported at the same completed microtask
   * checkpoint as the static promise ledger — one voice, exit 1, like
   * Node. The report hook drains engine jobs first so a same-checkpoint
   * handler attachment gets its chance to rescind. */
  JS_SetHostPromiseRejectionTracker(isl_rt, isl_rejection_tracker, NULL);
  scr_loop_set_island_rejections(isl_report_rejections,
                                 scr_island_drain_jobs);
  /* Armed island timers (AbortSignal.timeout) cap the loop's idle sleep
   * so they fire on time while the poller waits on socket readiness —
   * without keeping the loop alive by themselves (Node's unref'd timer).
   * The curl fetch bridge capped its own poll instead; the native bridge
   * has no poll of its own, so the loop must know the deadline. */
  scr_loop_set_island_deadline(&scr_island_timers_deadline);
  /* Module system: the loader callbacks are always installed (inert
   * without registered tables); the bootstrap (require shim, builtin
   * shims, the process bridge) evaluates only for npm-importing programs
   * — main registered their tables before any island entry. */
  isl_install_module_loader();
  /* Host-function class (closures entering the island): registered
   * eagerly — the id must exist before any from_closure call. */
  isl_register_hostfn_class();
  /* LIFO: registered after scr_init's handlers, so teardown runs before
   * the cycle collection + RC audit — the audit sees the engine gone. */
  atexit(isl_teardown_at_exit);
}

/* Nesting depth of host-function callbacks (scriptc closures invoked BY
 * the engine): while inside one, island entries from the SAME stack must
 * NOT re-anchor the stack top or resize the budget — moving them
 * mid-execution would misplace the engine's overflow check for the frames
 * still live above the callback. Entries from a DIFFERENT stack (an async
 * callback's eagerly-run fiber, or the promise-bridge waiter fiber) must
 * re-anchor — the engine has no frames on that stack, and checking its
 * stack pointers against the host stack's anchor is meaningless. The
 * host-call wrapper re-anchors to its own stack when the callback
 * returns (isl_hostfn_invoke). */
static int isl_host_depth = 0;

/* The engine's stack budget is sized PER STACK: entries from an async
 * fiber keep the tight fiber budget (ISL_STACK_BUDGET — half the fiber),
 * while entries from the MAIN stack get real headroom — the process main
 * stack is 8MB, and embedded npm package code (a commander parse) chains
 * enough engine frames to blow the fiber-sized budget, especially under
 * ASan's inflated frames. */
/* Under ASan a single engine call costs 64–96KB of C stack, and a real
 * package graph (the AI SDK's generateText: zod parses inside promise
 * chains inside commander actions) chains enough frames to exhaust 4MB —
 * "Maximum call stack size exceeded" mid-workflow. The process main stack
 * is 8MB: budget 6MB under ASan and keep the remaining 2MB (≈ twenty
 * ASan frames) as the excursion margin past the engine's last check. */
#if defined(__SANITIZE_ADDRESS__)
#define ISL_MAIN_STACK_BUDGET (6 * 1024 * 1024)
#elif defined(__has_feature) && __has_feature(address_sanitizer)
#define ISL_MAIN_STACK_BUDGET (6 * 1024 * 1024)
#else
#define ISL_MAIN_STACK_BUDGET (4 * 1024 * 1024)
#endif
static int isl_budget_is_fiber = -1; /* tri-state: unset/main/fiber */

/* Which stack the engine's overflow check is anchored to: the fiber's
 * identity, NULL for the main stack, or the initial sentinel. `strayed`
 * flags an anchor moved by a nested stack while a host call was live —
 * the wrapper restores on its way out. */
static void *isl_anchor_fiber = (void *)&isl_anchor_fiber;
static bool isl_anchor_strayed = false;

/* Anchor the overflow check to the CURRENT stack and size the budget for
 * it (fibers tight, main roomy). */
static void isl_anchor_here(void) {
  JS_UpdateStackTop(isl_rt);
  isl_anchor_fiber = scr_fiber_self();
  int fiber = isl_anchor_fiber != NULL;
  if (fiber != isl_budget_is_fiber) {
    JS_SetMaxStackSize(isl_rt, fiber ? ISL_STACK_BUDGET : ISL_MAIN_STACK_BUDGET);
    isl_budget_is_fiber = fiber;
  }
}

/* EVERY island entry funnels through here: lazy init, then re-anchor the
 * stack-overflow check to the CURRENT stack (main or any fiber) and size
 * the budget for it — except while the engine itself is calling back
 * into static code ON THIS STACK. */
static void isl_entry(void) {
  if (!isl_rt) isl_init();
  if (isl_host_depth > 0) {
    if (scr_fiber_self() == isl_anchor_fiber) return;
    isl_anchor_strayed = true;
  }
  isl_anchor_here();
}

/* The libregexp opaque for scr_regex.c in --dynamic builds. Static regexes
 * and the island share ONE libregexp: the archive's copy, whose host hooks
 * (quickjs.c's lre_realloc & co.) interpret the opaque as a JSContext —
 * scr_regex.c defining its own hooks would be a duplicate symbol. So a
 * regex-using --dynamic program routes regex compilation/execution through
 * the island's context, booting the engine lazily on first regex use. */
void *scr_island_lre_opaque(void) {
  isl_entry();
  return isl_ctx;
}

/* Units entering the engine from loop dispatch stations (the fetch
 * bridge's net callbacks fire from scr_net's dispatch, not through an
 * emitted island op) re-anchor through here — the every-entry rule. */
void scr_island_host_enter(void) { isl_entry(); }

/* ── the loop's io hook (engine jobs at quiescence) ───────────────────
 * Island promise jobs (a .then chain inside embedded package code) have no
 * fiber to park: the loop treats a non-empty engine job queue as pending
 * work and drains it between turns — the island's microtask checkpoint,
 * placed exactly where Node runs its own. Executed on the main stack;
 * isl_entry re-anchors the engine's overflow check first. */

/* SCRIPTC_VERBOSE=1 (any value but "0"/""): the engine error's own .stack
 * (script line/column frames quickjs carries) dies in the exception bridges
 * — print it once to stderr before it does, so uncaught reports are
 * diagnosable. Default builds are byte-identical to before. */
static bool isl_verbose(void) {
  const char *v = getenv("SCRIPTC_VERBOSE");
  return v != NULL && v[0] != '\0' && !(v[0] == '0' && v[1] == '\0');
}

int scr_island_drain_jobs(void) {
  if (!isl_rt) return 0;
  isl_entry();
  int n = 0;
  for (;;) {
    JSContext *jctx;
    int r = JS_ExecutePendingJob(isl_rt, &jctx);
    if (r == 0) break;
    if (r < 0) {
      /* A job the engine itself could not complete (promise reaction
       * throws reject their derived promise instead of landing here).
       * Node dies on an uncaught microtask exception; match it. */
      JSValue exc = JS_GetException(jctx);
      const char *msg = JS_ToCString(jctx, exc);
      fflush(stdout);
      fprintf(stderr, "Uncaught %s\n", msg ? msg : "island job exception");
      if (msg) JS_FreeCString(jctx, msg);
      if (isl_verbose() && JS_IsError(exc)) {
        JSValue st = JS_GetPropertyStr(jctx, exc, "stack");
        if (!JS_IsException(st) && !JS_IsUndefined(st)) {
          size_t slen;
          const char *s = JS_ToCStringLen(jctx, &slen, st);
          if (s) fprintf(stderr, "scriptc: island stack: %.*s\n", (int)slen, s);
          if (s) JS_FreeCString(jctx, s);
        }
        JS_FreeValue(jctx, st);
      }
      JS_FreeValue(jctx, exc);
      _Exit(1);
    }
    n++;
  }
  return n;
}

static bool isl_io_pending(void) {
  if (isl_rt != NULL && JS_IsJobPending(isl_rt)) return true;
  /* A DUE island timer is pending work (fire it this turn); a merely
   * ARMED one is not — AbortSignal.timeout is unref'd like Node's and
   * must never keep the loop alive by itself. */
  if (isl_rt != NULL && scr_island_timers_due()) return true;
  return isl_fetch_pending != NULL && isl_fetch_pending();
}

static void isl_io_poll(double max_wait_ms) {
  /* Jobs first (they may start or settle transfers), then due island
   * timers (an AbortSignal.timeout firing aborts transfers and settles
   * promises — drain what it resolved), then the transfer poll — which
   * SLEEPS on curl's fds up to the loop's deadline CAPPED at the earliest
   * armed timer (a fetch timeout must fire on time mid-transfer), unless
   * this turn already made progress — then the jobs the arrived data (or
   * a timeout that elapsed during the sleep) resolved. */
  int ran = scr_island_drain_jobs();
  if (scr_island_timers_fire_due()) {
    ran += 1 + scr_island_drain_jobs();
  }
  if (isl_fetch_pending != NULL && isl_fetch_pending()) {
    double wait = ran > 0 ? 0 : max_wait_ms;
    double until = scr_island_timers_deadline() - scr_now_ms(); /* inf when none */
    if (until < 0) until = 0;
    if (until < wait) wait = until;
    isl_fetch_poll(wait);
    scr_island_drain_jobs();
    if (scr_island_timers_fire_due()) scr_island_drain_jobs();
  }
}

/* ── exception bridging ───────────────────────────────────────────────
 * Engine exception → catchable scriptc value through the pending cell
 * (scr_exception.c), so static try/catch works across the boundary.
 * Engine ERROR instances cross as real ScrError objects (name/message
 * extracted; the builtin vtable is picked by name, so `e instanceof
 * TypeError` narrows engine TypeErrors and custom names ride an
 * Error-rooted instance) — the uncaught line ("Uncaught TypeError: boom")
 * is byte-identical to the old String(e) form because toString rebuilds
 * exactly that shape. Non-Error throws keep the String(v) string payload. */

/* String(obj.prop) with a FALLBACK instead of recursion: a throwing getter
 * or unrepresentable value must not re-enter the bridge. Returns +1. */
static ScrStr *isl_prop_str(JSValueConst obj, const char *prop, const char *fallback) {
  JSValue v = JS_GetPropertyStr(isl_ctx, obj, prop);
  if (JS_IsException(v)) {
    JSValue second = JS_GetException(isl_ctx);
    JS_FreeValue(isl_ctx, second);
    return scr_str_new(fallback, strlen(fallback));
  }
  size_t len;
  const char *cs = JS_ToCStringLen(isl_ctx, &len, v);
  JS_FreeValue(isl_ctx, v);
  if (!cs) {
    JSValue second = JS_GetException(isl_ctx);
    JS_FreeValue(isl_ctx, second);
    return scr_str_new(fallback, strlen(fallback));
  }
  ScrStr *s = scr_str_new(cs, len);
  JS_FreeCString(isl_ctx, cs);
  return s;
}

/* Engine VALUE → pending scriptc exception. Borrows `exc`. The one
 * conversion both bridge directions' reasons ride: thrown engine
 * exceptions (below) and rejected engine promises crossing through the
 * promise bridge (isl_bridge_settle). */
static void isl_throw_reason(JSValueConst exc) {
  if (JS_IsError(exc)) {
    if (isl_verbose()) {
      ScrStr *stack = isl_prop_str(exc, "stack", "");
      fflush(stdout);
      fprintf(stderr, "scriptc: island stack: %.*s\n", (int)stack->len,
              stack->data);
      scr_str_release(stack);
    }
    scr_throw_error_named(isl_prop_str(exc, "name", "Error"),
                           isl_prop_str(exc, "message", ""));
    return;
  }
  size_t len;
  const char *msg = JS_ToCStringLen(isl_ctx, &len, exc);
  if (msg) {
    scr_throw_str(scr_str_new(msg, len));
    JS_FreeCString(isl_ctx, msg);
  } else {
    /* ToString itself threw (e.g. a symbol): clear that too, keep a
     * deterministic message. */
    JSValue second = JS_GetException(isl_ctx);
    JS_FreeValue(isl_ctx, second);
    const char msg2[] = "Error: unrepresentable island exception";
    scr_throw_str(scr_str_new(msg2, sizeof msg2 - 1));
  }
}

static void isl_bridge_exception(void) {
  JSValue exc = JS_GetException(isl_ctx); /* owned; clears engine pending */
  isl_throw_reason(exc);
  JS_FreeValue(isl_ctx, exc);
}

/* Exported for the island timer bridge (scr_web.c): a throwing engine
 * timer callback becomes the pending scriptc exception, so the loop's
 * uncaught path reports it exactly like a static timer callback's throw. */
void scr_island_bridge_exception(void) { isl_bridge_exception(); }

/* ── marshal helpers ──────────────────────────────────────────────────
 * The out-of-engine direction of the value boundary, with the engine's
 * ownership rules folded in — shared by scr_island_eval and the jsval
 * operation surface below. */

/* Engine value → f64 (ToNumber). Borrows v. False = the conversion threw;
 * the exception is already bridged into the scriptc pending cell. */
static bool isl_js_to_f64(JSValueConst v, double *out) {
  if (JS_ToFloat64(isl_ctx, out, v)) {
    isl_bridge_exception();
    return false;
  }
  return true;
}

/* Engine value → bool (ToBoolean; never throws). Borrows v. */
static bool isl_js_to_bool(JSValueConst v) { return JS_ToBool(isl_ctx, v) > 0; }

/* Engine value → ScrStr via String(v), UTF-8 out. Borrows v. Returns +1,
 * or NULL after bridging the exception ToString raised (symbols). */
static ScrStr *isl_js_to_str(JSValueConst v) {
  size_t len;
  const char *cs = JS_ToCStringLen(isl_ctx, &len, v);
  if (!cs) {
    isl_bridge_exception();
    return NULL;
  }
  ScrStr *s = scr_str_new(cs, len);
  JS_FreeCString(isl_ctx, cs);
  return s;
}

/* ── eval (the __island_eval intrinsic) ───────────────────────────────
 * Evaluate UTF-8 source in the island's global scope and return
 * String(result) as a scriptc string (+1). Borrows code. On an island
 * exception: bridges it (catchable via the pending cell) and returns NULL —
 * callers are compiler-emitted pending checks, like the fs.* surface. */
ScrStr *scr_island_eval(ScrStr *code) {
  isl_entry();
  JSValue r = JS_Eval(isl_ctx, code->data, code->len, "<island>",
                      JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  ScrStr *s;
  if (JS_IsNumber(r)) {
    /* Through the f64 marshal + the runtime's JS-exact formatter, keeping
     * number rendering identical to the static world's String(). */
    double d;
    if (!isl_js_to_f64(r, &d)) {
      JS_FreeValue(isl_ctx, r);
      return NULL;
    }
    s = scr_f64_to_scrstr(d);
  } else if (JS_IsBool(r)) {
    s = scr_bool_to_scrstr(isl_js_to_bool(r));
  } else {
    s = isl_js_to_str(r); /* NULL = bridged (e.g. a symbol result) */
  }
  JS_FreeValue(isl_ctx, r);
  return s;
}

/* ── ScrJsval: the refcounted cell behind the `any` static type ───────
 * Owns exactly one engine value. Not cycle-collector-traced: its internal
 * references live in the engine's GC world (cross-boundary cycles are the
 * documented uncollectable case). After engine teardown a release frees
 * only the cell — the engine already freed every value it owned, so the
 * counting allocator stays exact and nothing dangles.
 *
 * Live cells thread a registry (isl_cells) so teardown can free the
 * engine value of every cell nothing will ever release — an ABANDONED
 * fiber's frame holds cells (a fiber parked forever on a bridged package
 * promise holds at least the promise's own cell), and its stack is
 * deliberately not unwound. Without the walk those engine values leak
 * past JS_FreeRuntime, which the debug engine asserts on. */

struct ScrJsval {
  size_t rc;
  JSValue v;
  struct ScrJsval *cells_prev, *cells_next;
};

static ScrJsval *isl_cells = NULL;

static void isl_cell_unlink(ScrJsval *c) {
  if (c->cells_prev) c->cells_prev->cells_next = c->cells_next;
  else if (isl_cells == c) isl_cells = c->cells_next;
  if (c->cells_next) c->cells_next->cells_prev = c->cells_prev;
  c->cells_prev = c->cells_next = NULL;
}

/* Teardown half: free the engine value of every still-live cell. Pop from
 * the head each time — freeing a value can cascade (an engine finalizer
 * releasing a closure whose captures hold OTHER cells), and the cascade
 * unlinks from this same list. The popped cell's value is cleared BEFORE
 * the free, so a cascade releasing the cell itself (or a later post-
 * teardown release) frees only the malloc block. */
static void isl_cells_teardown(void) {
  while (isl_cells) {
    ScrJsval *c = isl_cells;
    isl_cell_unlink(c);
    JSValue v = c->v;
    c->v = JS_UNDEFINED;
    JS_FreeValue(isl_ctx, v);
  }
}

#ifdef SCR_RC_AUDIT
static long isl_live_jsvals = 0;
long scr_jsval_live_count(void) { return isl_live_jsvals; }
#endif

/* Fresh cell taking ownership of an engine value (+1 cell out). */
static ScrJsval *isl_cell_new(JSValue v) {
  ScrJsval *c = malloc(sizeof *c);
  if (!c) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  c->rc = 1;
  c->v = v;
  c->cells_prev = NULL;
  c->cells_next = isl_cells;
  if (isl_cells) isl_cells->cells_prev = c;
  isl_cells = c;
#ifdef SCR_RC_AUDIT
  isl_live_jsvals++;
#endif
  return c;
}

ScrJsval *scr_jsval_retain(ScrJsval *v) {
  if (v) v->rc++;
  return v;
}

void scr_jsval_release(ScrJsval *v) {
  if (!v) return;
  if (--v->rc == 0) {
    if (isl_rt) {
      isl_cell_unlink(v);
      JS_FreeValue(isl_ctx, v->v);
    }
    /* Post-teardown: the registry walk already freed the value (and
     * cleared the links) — only the cell block remains. */
#ifdef SCR_RC_AUDIT
    isl_live_jsvals--;
#endif
    free(v);
  }
}

void *scr_jsval_retain_v(void *v) { return scr_jsval_retain(v); }
void scr_jsval_release_v(void *v) { scr_jsval_release(v); }

/* ── marshal in ─────────────────────────────────────────────────────── */

ScrJsval *scr_jsval_from_f64(double v) {
  isl_entry();
  return isl_cell_new(JS_NewFloat64(isl_ctx, v));
}

ScrJsval *scr_jsval_from_bool(bool v) {
  isl_entry();
  return isl_cell_new(JS_NewBool(isl_ctx, v));
}

ScrJsval *scr_jsval_from_str(const ScrStr *s) {
  isl_entry();
  return isl_cell_new(JS_NewStringLen(isl_ctx, s->data, s->len));
}

/* The composite entry path: text from the emitted type-directed JSON
 * serializers, parsed by the engine — a deep copy into the island. The
 * input is machine-produced valid JSON, so a parse failure is an
 * engine-level surprise; bridge it like any exception rather than trust. */
ScrJsval *scr_jsval_from_json(const ScrStr *json) {
  isl_entry();
  JSValue v = JS_ParseJSON(isl_ctx, json->data, json->len, "<scr-marshal>");
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

/* ── marshal in: a CHECKED-DYNAMIC (dyn) value ────────────────────────
 * `unknown` flowing into 'any'-typed code (`const cfg = isJson ?
 * JSON.parse(text) : islandParser(text)`): the dyn tree rebuilds as
 * engine values — a DEEP COPY, the jsMarshal aliasing stance. Data kinds
 * only: a dyn carrying a boxed function, a native handle, or a promise
 * throws the catchable TypeError naming the kind (the box's thunk calls
 * STATIC code the engine cannot re-enter through a data copy). */
static const char *isl_dyn_unmarshalable(const ScrDyn *d) {
  switch (d->kind) {
  /* SCR_DYN_FUNC is NOT here: a boxed function crosses as the generic
   * host-function shim (isl_dynfn_new below) — the routed-call lane's
   * uniform argument conversion. */
  case SCR_DYN_HANDLE:
    return "a runtime handle";
  case SCR_DYN_PROMISE:
    return "a promise";
  case SCR_DYN_ARR:
    for (size_t i = 0; i < d->v.arr.len; i++) {
      const char *r = isl_dyn_unmarshalable(d->v.arr.items[i]);
      if (r != NULL) return r;
    }
    return NULL;
  case SCR_DYN_OBJ:
    for (size_t i = 0; i < d->v.obj.len; i++) {
      const char *r = isl_dyn_unmarshalable(d->v.obj.entries[i].value);
      if (r != NULL) return r;
    }
    return NULL;
  default:
    return NULL;
  }
}

static JSValue isl_dynfn_new(const ScrDyn *d); /* the checked-dynamic tree-function shim, below */

static JSValue isl_from_dyn(const ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_FUNC:
    /* A boxed dyn function enters as ONE generic host-function shim over
     * its uniform call thunk (ScrDynThunk): engine args wrap as dyn
     * values, the thunk runs, the dyn result converts back. Each
     * crossing mints a fresh engine function (documented). */
    return isl_dynfn_new(d);
  case SCR_DYN_UNDEF:
    return JS_UNDEFINED;
  case SCR_DYN_NULL:
    return JS_NULL;
  case SCR_DYN_BOOL:
    return JS_NewBool(isl_ctx, d->v.b);
  case SCR_DYN_NUM:
    return JS_NewFloat64(isl_ctx, d->v.num);
  case SCR_DYN_STR:
    return JS_NewStringLen(isl_ctx, d->v.str->data, d->v.str->len);
  case SCR_DYN_BYTES:
    /* Only u8 payloads reach the checked-dynamic tree today (scr_json.c's stringify note). */
    return JS_NewUint8ArrayCopy(isl_ctx, d->v.bytes->data, d->v.bytes->len);
  case SCR_DYN_ARR: {
    JSValue arr = JS_NewArray(isl_ctx);
    if (JS_IsException(arr)) return arr;
    for (size_t i = 0; i < d->v.arr.len; i++) {
      JSValue item = isl_from_dyn(d->v.arr.items[i]);
      if (JS_IsException(item) ||
          JS_SetPropertyUint32(isl_ctx, arr, (uint32_t)i, item) < 0) {
        JS_FreeValue(isl_ctx, arr);
        return JS_EXCEPTION;
      }
    }
    return arr;
  }
  case SCR_DYN_OBJ: {
    JSValue obj = JS_NewObject(isl_ctx);
    if (JS_IsException(obj)) return obj;
    for (size_t i = 0; i < d->v.obj.len; i++) {
      const ScrDynEntry *ent = &d->v.obj.entries[i];
      JSValue val = isl_from_dyn(ent->value);
      if (JS_IsException(val) ||
          JS_SetPropertyStr(isl_ctx, obj, ent->key, val) < 0) {
        JS_FreeValue(isl_ctx, obj);
        return JS_EXCEPTION;
      }
    }
    return obj;
  }
  case SCR_DYN_JSVAL:
    /* An engine value riding inside dyn data: embed the SAME engine
     * value by reference — the identity round trip, member position. */
    return JS_DupValue(isl_ctx, d->v.jsval.cell->v);
  default:
    /* Pre-scanned away — defensive. */
    return JS_ThrowTypeError(isl_ctx, "unmarshalable dynamic value");
  }
}

ScrJsval *scr_jsval_from_dyn(const ScrDyn *d) {
  /* The identity round trip: an engine value that crossed into the checked-dynamic tree
   * (scr_dyn_from_jsval) and back is the SAME engine value, by reference
   * — the one direction that used to throw (SEMANTICS.md supersedes the
   * "one unbridgeable mix"). */
  if (d->kind == SCR_DYN_JSVAL) return scr_jsval_retain(d->v.jsval.cell);
  isl_entry();
  const char *bad = isl_dyn_unmarshalable(d);
  if (bad != NULL) {
    char msg[128];
    int len = snprintf(msg, sizeof msg,
                       "an 'unknown' value holding %s cannot enter dynamically-executed code", bad);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
    return NULL;
  }
  JSValue v = isl_from_dyn(d);
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

/* ── the jsval→dyn crossing (SCR_DYN_JSVAL's constructor + ops) ───────
 * The reverse direction: an 'any'-typed engine value flowing into an
 * 'unknown'/'object'/JS-residue slot wraps BY REFERENCE as the checked-dynamic tree's
 * island kind. The dyn core (scr_json.c) stays island-free — it routes
 * the armed operations (typeof/truthy/String()/===, the narrowing
 * tests) through these installed ops; everything un-armed there keeps
 * the loud "not supported yet" ladder. */

static void isl_dynjs_release(ScrJsval *cell) { scr_jsval_release(cell); }
static ScrStr *isl_dynjs_typeof(ScrJsval *cell) { return scr_jsval_typeof(cell); }
static bool isl_dynjs_truthy(ScrJsval *cell) { return scr_jsval_truthy(cell) != 0; }
static ScrStr *isl_dynjs_to_str(ScrJsval *cell) { return scr_jsval_to_str(cell); }
static bool isl_dynjs_strict_eq(ScrJsval *a, ScrJsval *b) {
  /* The engine's === through the pinned helper (a bridged surprise
   * answers false — strict equality itself cannot throw in JS). */
  return scr_jsval_cmp(SCR_JSOP_EQ, a, b) == 1;
}
static bool isl_dynjs_is_array(ScrJsval *cell) { return JS_IsArray(cell->v); }
static bool isl_dynjs_is_error(ScrJsval *cell) { return JS_IsError(cell->v); }

static const ScrDynJsvalOps isl_dynjs_ops;

/* The jsval→dyn wrap over a RAW engine value (BORROWED) — the scalar
 * normalization the cell constructor applies, shared by the routed-op
 * result conversions (which hold a JSValue, not a cell). Composites mint
 * a fresh cell over the SAME engine value (identity is the value — the
 * engine's === and the unwrap both go through it). */
static ScrDyn *isl_dyn_from_value(JSValue v) {
  if (JS_IsUndefined(v)) return scr_dyn_retain(scr_dyn_undefined());
  if (JS_IsNull(v)) return scr_dyn_new_null();
  if (JS_IsBool(v)) return scr_dyn_new_bool(JS_ToBool(isl_ctx, v) > 0);
  if (JS_IsNumber(v)) {
    double num = 0;
    JS_ToFloat64(isl_ctx, &num, v); /* cannot fail on a number */
    return scr_dyn_new_num(num);
  }
  if (JS_IsString(v)) {
    ScrStr *s = isl_js_to_str(v); /* cannot bridge on a string */
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  return scr_dyn_alloc_jsval(isl_cell_new(JS_DupValue(isl_ctx, v)), &isl_dynjs_ops);
}

/* ── the routed operation set (the ScrDynJsvalOps rows scr_json.c and
 * scr_dyn_invoke.c dispatch through) ─────────────────────────────────
 * Keys enter as engine strings through the GETIDX/SETIDX helpers (any
 * byte content, canonical-index semantics are the engine's own); dyn
 * arguments cross through scr_jsval_from_dyn (wrapped cells by
 * reference, data as the usual deep copy, FUNC boxes through the shim);
 * results wrap back scalar-normalized. Engine throws bridge catchably
 * with the engine's message. */

static ScrDyn *isl_dynjs_key_get(ScrJsval *cell, const ScrStr *k) {
  isl_entry();
  JSValue key = JS_NewStringLen(isl_ctx, k->data, k->len);
  JSValue argv[2] = {cell->v, key};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_GETIDX], JS_UNDEFINED, 2, argv);
  JS_FreeValue(isl_ctx, key);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  ScrDyn *d = isl_dyn_from_value(r);
  JS_FreeValue(isl_ctx, r);
  return d;
}

static bool isl_dynjs_key_set(ScrJsval *cell, const ScrStr *k, const ScrDyn *v) {
  ScrJsval *vj = scr_jsval_from_dyn(v);
  if (!vj) return false; /* unmarshalable value — the catchable TypeError */
  isl_entry();
  JSValue key = JS_NewStringLen(isl_ctx, k->data, k->len);
  JSValue argv[3] = {cell->v, key, vj->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_SETIDX], JS_UNDEFINED, 3, argv);
  JS_FreeValue(isl_ctx, key);
  scr_jsval_release(vj);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return false;
  }
  JS_FreeValue(isl_ctx, r);
  return true;
}

/* Convert argc dyn arguments for a routed call; frees what it built on
 * failure. Returns false with the exception pending. */
static bool isl_dynjs_args_in(ScrDyn *const *args, size_t argc, ScrJsval **cells) {
  for (size_t i = 0; i < argc; i++) {
    cells[i] = scr_jsval_from_dyn(args[i]);
    if (!cells[i]) {
      for (size_t j = 0; j < i; j++) scr_jsval_release(cells[j]);
      return false;
    }
  }
  return true;
}

static ScrDyn *isl_dynjs_call(ScrJsval *cell, ScrDyn *const *args, size_t argc) {
  ScrJsval *stack_cells[8];
  ScrJsval **cells = argc <= 8 ? stack_cells : malloc(argc * sizeof *cells);
  if (!isl_dynjs_args_in(args, argc, cells)) {
    if (cells != stack_cells) free(cells);
    return NULL;
  }
  ScrJsval *r = scr_jsval_call(cell, (int)argc, cells);
  for (size_t i = 0; i < argc; i++) scr_jsval_release(cells[i]);
  if (cells != stack_cells) free(cells);
  if (!r) return NULL;
  ScrDyn *d = isl_dyn_from_value(r->v);
  scr_jsval_release(r);
  return d;
}

static ScrDyn *isl_dynjs_invoke(ScrJsval *cell, const char *method, ScrDyn *const *args, size_t argc, const char *what) {
  isl_entry();
  JSValue fn = JS_GetPropertyStr(isl_ctx, cell->v, method); /* owned */
  if (JS_IsException(fn)) {
    isl_bridge_exception();
    return NULL;
  }
  if (!JS_IsFunction(isl_ctx, fn)) {
    /* Node's spelled TypeError (V8's text), front-run before the
     * engine's terser "not a function". */
    JS_FreeValue(isl_ctx, fn);
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, what);
    scr_jb_puts(&b, " is not a function");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return NULL;
  }
  ScrJsval *stack_cells[8];
  ScrJsval **cells = argc <= 8 ? stack_cells : malloc(argc * sizeof *cells);
  if (!isl_dynjs_args_in(args, argc, cells)) {
    JS_FreeValue(isl_ctx, fn);
    if (cells != stack_cells) free(cells);
    return NULL;
  }
  JSValue stack_args[8];
  JSValue *argv = argc <= 8 ? stack_args : malloc(argc * sizeof(JSValue));
  for (size_t i = 0; i < argc; i++) argv[i] = cells[i]->v;
  JSValue r = JS_Call(isl_ctx, fn, cell->v, (int)argc, argv); /* this = receiver */
  if (argv != stack_args) free(argv);
  JS_FreeValue(isl_ctx, fn);
  for (size_t i = 0; i < argc; i++) scr_jsval_release(cells[i]);
  if (cells != stack_cells) free(cells);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  ScrDyn *d = isl_dyn_from_value(r);
  JS_FreeValue(isl_ctx, r);
  return d;
}

static bool isl_dynjs_is_nullish(ScrJsval *cell) {
  return JS_IsUndefined(cell->v) || JS_IsNull(cell->v);
}

static ScrDyn *isl_dynjs_obj_walk(ScrJsval *cell, int mode) {
  isl_entry();
  JSValue m = JS_NewInt32(isl_ctx, mode);
  JSValue argv[2] = {cell->v, m};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_OBJWALK], JS_UNDEFINED, 2, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  /* The engine array unpacks into a NATIVE dyn array (keys are dyn
   * strings, values wrap per element, entries become native pairs) so
   * the results iterate/index/measure at native speed. */
  int64_t len = 0;
  JSValue lv = JS_GetPropertyStr(isl_ctx, r, "length");
  JS_ToInt64(isl_ctx, &len, lv);
  JS_FreeValue(isl_ctx, lv);
  ScrDyn *out = scr_dyn_new_arr();
  for (int64_t i = 0; i < len; i++) {
    JSValue e = JS_GetPropertyUint32(isl_ctx, r, (uint32_t)i);
    if (mode == 2) {
      JSValue k = JS_GetPropertyUint32(isl_ctx, e, 0);
      JSValue v = JS_GetPropertyUint32(isl_ctx, e, 1);
      ScrDyn *pair = scr_dyn_new_arr();
      scr_dyn_arr_push(pair, isl_dyn_from_value(k));
      scr_dyn_arr_push(pair, isl_dyn_from_value(v));
      scr_dyn_arr_push(out, pair);
      JS_FreeValue(isl_ctx, k);
      JS_FreeValue(isl_ctx, v);
    } else {
      scr_dyn_arr_push(out, isl_dyn_from_value(e));
    }
    JS_FreeValue(isl_ctx, e);
  }
  JS_FreeValue(isl_ctx, r);
  return out;
}

static int isl_dynjs_has_own(ScrJsval *cell, const ScrStr *k) {
  isl_entry();
  JSValue key = JS_NewStringLen(isl_ctx, k->data, k->len);
  JSValue argv[2] = {cell->v, key};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_HASOWN], JS_UNDEFINED, 2, argv);
  JS_FreeValue(isl_ctx, key);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return -1;
  }
  int b = JS_ToBool(isl_ctx, r);
  JS_FreeValue(isl_ctx, r);
  return b > 0 ? 1 : 0;
}

static bool isl_dynjs_assign(ScrJsval *cell, const ScrDyn *src) {
  ScrJsval *sj = scr_jsval_from_dyn(src);
  if (!sj) return false;
  isl_entry();
  JSValue argv[2] = {cell->v, sj->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_ASSIGN], JS_UNDEFINED, 2, argv);
  scr_jsval_release(sj);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return false;
  }
  JS_FreeValue(isl_ctx, r);
  return true;
}

static ScrStr *isl_dynjs_to_json(ScrJsval *cell) { return scr_jsval_to_json(cell); }

static ScrDyn *isl_dynjs_iter_drain(ScrJsval *cell, bool spread, const ScrStr *spell) {
  isl_entry();
  JSValue m = JS_NewInt32(isl_ctx, spread ? 1 : 0);
  JSValue s = spell && spell->len > 0
    ? JS_NewStringLen(isl_ctx, spell->data, spell->len)
    : JS_UNDEFINED;
  JSValue argv[3] = {cell->v, m, s};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_ITERDRAIN], JS_UNDEFINED, 3, argv);
  JS_FreeValue(isl_ctx, s);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  /* The drained engine array unpacks into a fresh dyn array — elements
   * wrap back scalar-normalized (composites stay engine values by
   * reference), exactly the obj_walk unpack. */
  int64_t len = 0;
  JSValue lv = JS_GetPropertyStr(isl_ctx, r, "length");
  JS_ToInt64(isl_ctx, &len, lv);
  JS_FreeValue(isl_ctx, lv);
  ScrDyn *out = scr_dyn_new_arr();
  for (int64_t i = 0; i < len; i++) {
    JSValue e = JS_GetPropertyUint32(isl_ctx, r, (uint32_t)i);
    scr_dyn_arr_push(out, isl_dyn_from_value(e));
    JS_FreeValue(isl_ctx, e);
  }
  JS_FreeValue(isl_ctx, r);
  return out;
}

static const ScrDynJsvalOps isl_dynjs_ops = {
  isl_dynjs_release,
  isl_dynjs_typeof,
  isl_dynjs_truthy,
  isl_dynjs_to_str,
  isl_dynjs_strict_eq,
  isl_dynjs_is_array,
  isl_dynjs_is_error,
  isl_dynjs_key_get,
  isl_dynjs_key_set,
  isl_dynjs_call,
  isl_dynjs_invoke,
  isl_dynjs_is_nullish,
  isl_dynjs_obj_walk,
  isl_dynjs_has_own,
  isl_dynjs_assign,
  isl_dynjs_to_json,
  isl_dynjs_iter_drain,
};

ScrDyn *scr_dyn_from_jsval(ScrJsval *cell) {
  isl_entry();
  JSValue v = cell->v;
  /* Scalar normalization: engine-reported scalars become the NATIVE dyn
   * kinds at wrap time (the strict exits cannot fail on them), so every
   * scalar path in the dyn core — ===, typeof tests, JSON of leaves —
   * stays untouched and the JSVAL kind never competes with them. */
  if (JS_IsUndefined(v)) return scr_dyn_retain(scr_dyn_undefined());
  if (JS_IsNull(v)) return scr_dyn_new_null();
  if (JS_IsBool(v)) return scr_dyn_new_bool(JS_ToBool(isl_ctx, v) > 0);
  if (JS_IsNumber(v)) {
    double num = 0;
    JS_ToFloat64(isl_ctx, &num, v); /* cannot fail on a number */
    return scr_dyn_new_num(num);
  }
  if (JS_IsString(v)) {
    ScrStr *s = isl_js_to_str(v); /* cannot bridge on a string */
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  return scr_dyn_alloc_jsval(scr_jsval_retain(cell), &isl_dynjs_ops);
}

/* The boundary-thunk %Error extraction: an island host-call argument
 * validated as the callback's declared 'Error' parameter (the
 * EventEmitter-style boundary — dbPool.on('error', (err) => ...)). A real
 * engine Error instance reads name/message/code in the engine; the
 * %error-encoded DATA object (a native error that entered the island as
 * data) rebuilds the same way. The kind resolves from the name, so a
 * later `instanceof TypeError` still answers. Anything else throws the
 * catchable TypeError — the boundary's trust-but-verify rule. Returns +1,
 * or NULL with the exception pending. */
ScrError *scr_error_from_jsval(ScrJsval *cell) {
  isl_entry();
  JSValue v = cell->v;
  if (!JS_IsError(v)) {
    JSValue marker = JS_GetPropertyStr(isl_ctx, v, "%error");
    bool ok = !JS_IsException(marker) && !JS_IsUndefined(marker) && !JS_IsNull(marker);
    JS_FreeValue(isl_ctx, marker);
    if (!ok) {
      static const char bad[] = "expected an Error value";
      scr_throw_error_msg(SCR_ERR_TYPE, bad, sizeof bad - 1);
      return NULL;
    }
  }
  ScrStr *name = isl_prop_str(v, "name", "Error");
  ScrStr *message = isl_prop_str(v, "message", "");
  int k = SCR_ERR_ERROR;
  if (name->len == 9 && memcmp(name->data, "TypeError", 9) == 0) k = SCR_ERR_TYPE;
  else if (name->len == 10 && memcmp(name->data, "RangeError", 10) == 0) k = SCR_ERR_RANGE;
  else if (name->len == 11 && memcmp(name->data, "SyntaxError", 11) == 0) k = SCR_ERR_SYNTAX;
  ScrError *e = scr_error_new(k, message);
  scr_str_release(message); /* scr_error_new retained a copy */
  scr_str_release(e->name);
  e->name = name; /* moves */
  JSValue code = JS_GetPropertyStr(isl_ctx, v, "code");
  if (!JS_IsException(code) && !JS_IsUndefined(code) && !JS_IsNull(code)) {
    size_t cl = 0;
    const char *cs = JS_ToCStringLen(isl_ctx, &cl, code);
    if (cs) {
      e->code = scr_str_new(cs, cl);
      JS_FreeCString(isl_ctx, cs);
    }
  }
  JS_FreeValue(isl_ctx, code);
  return e;
}

/* ── operators (through the pinned prelude helpers) ───────────────────── */

ScrJsval *scr_jsval_binop(int op, ScrJsval *a, ScrJsval *b) {
  isl_entry();
  JSValue argv[2] = {a->v, b->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[op], JS_UNDEFINED, 2, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

int scr_jsval_cmp(int op, ScrJsval *a, ScrJsval *b) {
  isl_entry();
  JSValue argv[2] = {a->v, b->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[op], JS_UNDEFINED, 2, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return -1;
  }
  int b1 = JS_ToBool(isl_ctx, r);
  JS_FreeValue(isl_ctx, r);
  return b1 > 0 ? 1 : 0;
}

int scr_jsval_instance_of(ScrJsval *v, ScrJsval *c) {
  isl_entry();
  /* JS_IsInstanceOf IS the spec's InstanceofOperator — Symbol.hasInstance
   * included; a non-callable/non-object RHS throws the engine's own
   * TypeError, bridged catchably like every island op. */
  int r = JS_IsInstanceOf(isl_ctx, v->v, c->v);
  if (r < 0) {
    isl_bridge_exception();
    return -1;
  }
  return r > 0 ? 1 : 0;
}

static ScrJsval *isl_call1(int helper, ScrJsval *a) {
  isl_entry();
  JSValue r = JS_Call(isl_ctx, isl_helpers[helper], JS_UNDEFINED, 1, &a->v);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

ScrJsval *scr_jsval_neg(ScrJsval *a) { return isl_call1(ISL_H_NEG, a); }
/* GetIterator over an island value (the for-of head): the engine's own
 * protocol lookup, V8's not-iterable TypeError text on refusal. */
ScrJsval *scr_jsval_iter_new(ScrJsval *a) { return isl_call1(ISL_H_ITER, a); }
ScrJsval *scr_jsval_plus(ScrJsval *a) { return isl_call1(ISL_H_PLUS, a); }

int scr_jsval_truthy(ScrJsval *a) {
  isl_entry();
  return JS_ToBool(isl_ctx, a->v) > 0; /* ToBoolean never throws */
}

ScrStr *scr_jsval_typeof(ScrJsval *a) {
  isl_entry();
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_TYPEOF], JS_UNDEFINED, 1, &a->v);
  /* typeof cannot throw; the result is always an engine string. */
  ScrStr *s = isl_js_to_str(r);
  JS_FreeValue(isl_ctx, r);
  return s;
}

ScrStr *scr_jsval_to_str(ScrJsval *a) {
  isl_entry();
  return isl_js_to_str(a->v); /* NULL = bridged (e.g. a symbol) */
}

/* ── property/element access and calls ────────────────────────────────── */

ScrJsval *scr_jsval_get_prop(ScrJsval *o, const ScrStr *name) {
  isl_entry();
  JSValue r = JS_GetPropertyStr(isl_ctx, o->v, name->data); /* owned */
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* A member of the engine's global object by name (Math, parseFloat, ...) —
 * the receiver/callee for the island-backed ambient surface. */
ScrJsval *scr_jsval_global_get(const ScrStr *name) {
  isl_entry();
  JSValue g = JS_GetGlobalObject(isl_ctx); /* owned */
  JSValue r = JS_GetPropertyStr(isl_ctx, g, name->data); /* owned */
  JS_FreeValue(isl_ctx, g);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

int scr_jsval_set_prop(ScrJsval *o, const ScrStr *name, ScrJsval *v) {
  isl_entry();
  /* JS_SetPropertyStr CONSUMES its value argument — dup, the cell keeps
   * its own reference. */
  if (JS_SetPropertyStr(isl_ctx, o->v, name->data, JS_DupValue(isl_ctx, v->v)) < 0) {
    isl_bridge_exception();
    return 0;
  }
  return 1;
}

/* Destructuring RequireObjectCoercible (V8's exact TypeError text — see
 * the ISL_H_DESTRCHECK prelude helper): nullish throws catchably, every
 * other value passes through (+1 cell). `first` is the pattern's first
 * property name or NULL for the empty pattern's bare form. */
ScrJsval *scr_jsval_destr_check(ScrJsval *v, const char *spell, const char *first) {
  isl_entry();
  JSValue argv[3];
  argv[0] = v->v;
  argv[1] = JS_NewString(isl_ctx, spell);
  argv[2] = first ? JS_NewString(isl_ctx, first) : JS_UNDEFINED;
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_DESTRCHECK], JS_UNDEFINED, 3, argv);
  JS_FreeValue(isl_ctx, argv[1]);
  JS_FreeValue(isl_ctx, argv[2]);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* Destructuring GetIterator + the pattern's width (see ISL_H_ITERN):
 * a fresh engine array of exactly n elements, undefined-padded, with
 * IteratorClose when the iterator was not exhausted; non-iterables throw
 * V8's exact not-iterable TypeError catchably. */
ScrJsval *scr_jsval_iter_n(ScrJsval *v, double n) {
  isl_entry();
  JSValue argv[2];
  argv[0] = v->v;
  argv[1] = JS_NewFloat64(isl_ctx, n);
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_ITERN], JS_UNDEFINED, 2, argv);
  JS_FreeValue(isl_ctx, argv[1]);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

ScrJsval *scr_jsval_get_idx(ScrJsval *o, ScrJsval *key) {
  isl_entry();
  JSValue argv[2] = {o->v, key->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_GETIDX], JS_UNDEFINED, 2, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

int scr_jsval_set_idx(ScrJsval *o, ScrJsval *key, ScrJsval *v) {
  isl_entry();
  JSValue argv[3] = {o->v, key->v, v->v};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_SETIDX], JS_UNDEFINED, 3, argv);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return 0;
  }
  JS_FreeValue(isl_ctx, r);
  return 1;
}

ScrJsval *scr_jsval_call_method(ScrJsval *o, const ScrStr *name, int argc, ScrJsval **argv) {
  isl_entry();
  JSValue fn = JS_GetPropertyStr(isl_ctx, o->v, name->data); /* owned */
  if (JS_IsException(fn)) {
    isl_bridge_exception();
    return NULL;
  }
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_Call(isl_ctx, fn, o->v, argc, args); /* this = receiver */
  if (args != stack_args) free(args);
  JS_FreeValue(isl_ctx, fn);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* `o.name?.(...)` — the optional METHOD call: a nullish member answers
 * the engine's undefined (JS: exactly `o.name?.()`); anything else calls
 * with `this = o`, non-callables throwing the engine's own TypeError. */
ScrJsval *scr_jsval_opt_call_method(ScrJsval *o, const ScrStr *name, int argc, ScrJsval **argv) {
  isl_entry();
  JSValue fn = JS_GetPropertyStr(isl_ctx, o->v, name->data); /* owned */
  if (JS_IsException(fn)) {
    isl_bridge_exception();
    return NULL;
  }
  if (JS_IsUndefined(fn) || JS_IsNull(fn)) {
    JS_FreeValue(isl_ctx, fn);
    return isl_cell_new(JS_UNDEFINED);
  }
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_Call(isl_ctx, fn, o->v, argc, args); /* this = receiver */
  if (args != stack_args) free(args);
  JS_FreeValue(isl_ctx, fn);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

ScrJsval *scr_jsval_call(ScrJsval *f, int argc, ScrJsval **argv) {
  isl_entry();
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_Call(isl_ctx, f->v, JS_UNDEFINED, argc, args);
  if (args != stack_args) free(args);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* Call an already-resolved computed member with its original receiver. The
 * frontend performs GetValue before argument evaluation, then arrives here
 * after the arguments are ready; keeping callee and receiver separate avoids
 * a second getter read while preserving method `this`. */
ScrJsval *scr_jsval_call_this(ScrJsval *f, ScrJsval *receiver, int argc,
                              ScrJsval **argv) {
  isl_entry();
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_Call(isl_ctx, f->v, receiver->v, argc, args);
  if (args != stack_args) free(args);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* Spread application on an island callee (jsOp callSpread) — the prelude
 * helper's real `f(...pre, ...spread)`, so iterator protocols are the
 * engine's own and the guards front-run V8's exact spread-call TypeError
 * texts (`what` is the spread expression's source spelling). Borrows
 * everything; +1 out, or NULL with the engine exception bridged. */
ScrJsval *scr_jsval_call_spread(ScrJsval *f, ScrJsval *pre, ScrJsval *spread, const ScrStr *what) {
  isl_entry();
  JSValue argv[4] = {f->v, pre->v, spread->v, JS_NewStringLen(isl_ctx, what->data, what->len)};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_CALLSPREAD], JS_UNDEFINED, 4, argv);
  JS_FreeValue(isl_ctx, argv[3]);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* `new X(...)` on an island callee (jsOp construct). Borrows everything;
 * +1 out, or NULL with the engine exception bridged. */
ScrJsval *scr_jsval_construct(ScrJsval *f, int argc, ScrJsval **argv) {
  isl_entry();
  JSValue stack_args[8];
  JSValue *args = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof(JSValue));
  for (int i = 0; i < argc; i++) args[i] = argv[i]->v;
  JSValue r = JS_CallConstructor(isl_ctx, f->v, argc, args);
  if (args != stack_args) free(args);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(r);
}

/* ── closures entering the island (host functions) ────────────────────
 * A scriptc closure wraps as an engine function: arguments arrive as
 * BORROWED cells (padded with undefined / surplus dropped — JS call
 * semantics), the compiled adapter calls the closure through its real
 * ABI, and the +1 result value (or undefined for void) returns to the
 * engine. A scriptc exception thrown by the closure REVERSE-bridges:
 * the pending cell's payload becomes the engine's thrown value (strings
 * stay strings, so a round trip through both bridges is the identity).
 * The wrapper OWNS one reference on the closure; the engine finalizer
 * releases it — at teardown that happens before the RC audit runs. */

#define ISL_HOSTFN_MAX_ARITY 16

typedef struct {
  ScrClosure *c;
  ScrJsval *(*adapt)(ScrClosure *, ScrJsval **);
  int arity;
} IslHostFn;

static JSClassID isl_hostfn_class_id = 0;

static void isl_hostfn_finalizer(JSRuntime *rt, JSValueConst val) {
  (void)rt;
  IslHostFn *b = JS_GetOpaque(val, isl_hostfn_class_id);
  if (b) {
    scr_closure_release(b->c);
    free(b);
  }
}

static const JSClassDef isl_hostfn_class = {
    .class_name = "ScrHostFn",
    .finalizer = isl_hostfn_finalizer,
};

static JSClassID isl_dynfn_class_id;      /* the checked-dynamic tree-function shim, below */
static const JSClassDef isl_dynfn_class;

static void isl_register_hostfn_class(void) {
  JS_NewClassID(isl_rt, &isl_hostfn_class_id);
  JS_NewClass(isl_rt, isl_hostfn_class_id, &isl_hostfn_class);
  JS_NewClassID(isl_rt, &isl_dynfn_class_id);
  JS_NewClass(isl_rt, isl_dynfn_class_id, &isl_dynfn_class);
  isl_register_bridge_class();
}

/* Pending scriptc exception → engine VALUE (reverse bridge); clears the
 * cell. Shared by the host-call throw path and the promise bridge's
 * rejection path. */
static JSValue isl_pending_to_value(JSContext *ctx) {
  ScrExcCell *cell = scr_exc_current_cell();
  JSValue v;
  switch (cell->kind) {
  case SCR_EXC_F64:
    v = JS_NewFloat64(ctx, cell->f64);
    break;
  case SCR_EXC_BOOL:
    v = JS_NewBool(ctx, cell->b);
    break;
  case SCR_EXC_STR: {
    ScrStr *s = (ScrStr *)cell->payload;
    v = JS_NewStringLen(ctx, s->data, s->len);
    break;
  }
  case SCR_EXC_OBJ:
    if (scr_error_is(cell->payload)) {
      /* A scriptc Error crossing in: a real engine Error with the same
       * name/message, so package code can read e.message and String(e).
       * The BUILTIN names construct through the engine's own constructor
       * (mirroring the forward bridge, which picks the builtin vtable by
       * name) so `e instanceof TypeError` narrows in package code —
       * conversion failures at the typed-callback boundary rely on it.
       * Custom names ride an Error-rooted instance with the name set. */
      ScrError *err = (ScrError *)cell->payload;
      static const char *const builtins[] = {"Error", "TypeError", "RangeError", "SyntaxError"};
      v = JS_UNDEFINED;
      for (size_t i = 0; i < sizeof builtins / sizeof builtins[0]; i++) {
        if (strlen(builtins[i]) == err->name->len &&
            memcmp(builtins[i], err->name->data, err->name->len) == 0) {
          JSValue global = JS_GetGlobalObject(ctx);
          JSValue ctor = JS_GetPropertyStr(ctx, global, builtins[i]);
          JS_FreeValue(ctx, global);
          JSValue msg = JS_NewStringLen(ctx, err->message->data, err->message->len);
          v = JS_CallConstructor(ctx, ctor, 1, &msg);
          JS_FreeValue(ctx, msg);
          JS_FreeValue(ctx, ctor);
          if (JS_IsException(v)) v = JS_UNDEFINED; /* fall back below */
          break;
        }
      }
      if (JS_IsUndefined(v)) {
        v = JS_NewError(ctx);
        JS_SetPropertyStr(ctx, v, "name",
                          JS_NewStringLen(ctx, err->name->data, err->name->len));
        JS_SetPropertyStr(ctx, v, "message",
                          JS_NewStringLen(ctx, err->message->data, err->message->len));
      }
      /* The code property crosses too — fs/exec throw sites stamp the
       * errno name, and package code branches on err.code === 'ENOENT'. */
      if (err->code != NULL && !JS_IsUndefined(v)) {
        JS_SetPropertyStr(ctx, v, "code",
                          JS_NewStringLen(ctx, err->code->data, err->code->len));
      }
      break;
    }
    /* fall through: non-Error hierarchy objects render like other refs */
  default:
    /* Ref payloads render "[object]" like the uncaught printer. */
    v = JS_NewString(ctx, "[object]");
    break;
  }
  scr_exc_clear();
  return v;
}

/* Pending scriptc exception → engine thrown value (reverse bridge). */
static JSValue isl_throw_pending(JSContext *ctx) {
  return JS_Throw(ctx, isl_pending_to_value(ctx));
}

static JSValue isl_hostfn_invoke(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv, int magic, JSValueConst *func_data) {
  (void)this_val;
  (void)magic;
  IslHostFn *b = JS_GetOpaque(func_data[0], isl_hostfn_class_id);
  if (!b) return JS_ThrowTypeError(ctx, "detached scriptc host function");
  ScrJsval *cells[ISL_HOSTFN_MAX_ARITY];
  int ncells;
  if (b->arity < 0) {
    /* The ISLAND-REST shape (negative arity = -(leading declared + 1)):
     * leading params pad/drop like any host call; the trailing cell is a
     * fresh ENGINE ARRAY of the surplus arguments — the closure's rest
     * binding IS the engine's own arguments array. */
    int leading = -b->arity - 1;
    for (int i = 0; i < leading; i++) {
      cells[i] = isl_cell_new(i < argc ? JS_DupValue(ctx, argv[i]) : JS_UNDEFINED);
    }
    JSValue rest = JS_NewArray(ctx);
    for (int i = leading; i < argc; i++) {
      JS_SetPropertyUint32(ctx, rest, (uint32_t)(i - leading), JS_DupValue(ctx, argv[i]));
    }
    cells[leading] = isl_cell_new(rest);
    ncells = leading + 1;
  } else {
    for (int i = 0; i < b->arity; i++) {
      cells[i] = isl_cell_new(i < argc ? JS_DupValue(ctx, argv[i]) : JS_UNDEFINED);
    }
    ncells = b->arity;
  }
  bool strayed_before = isl_anchor_strayed;
  isl_host_depth++;
  ScrJsval *r = b->adapt(b->c, cells);
  isl_host_depth--;
  if (isl_anchor_strayed && !strayed_before) {
    /* A fiber the callback spawned (an async callback's eager prefix, the
     * promise-bridge waiter) re-anchored the overflow check to ITS stack;
     * the engine frames above this call live on ours. Re-anchor here —
     * deeper than the original entry by the frames already in use, which
     * loosens the budget by that depth (transient: the next top-level
     * entry re-anchors exactly). */
    isl_anchor_here();
    isl_anchor_strayed = strayed_before;
  }
  for (int i = 0; i < ncells; i++) scr_jsval_release(cells[i]);
  if (scr_exc_pending()) {
    if (r) scr_jsval_release(r);
    return isl_throw_pending(ctx);
  }
  if (!r) return JS_UNDEFINED;
  JSValue out = JS_DupValue(ctx, r->v);
  scr_jsval_release(r);
  return out;
}

ScrJsval *scr_jsval_from_closure(ScrClosure *c, int arity,
                                  ScrJsval *(*adapt)(ScrClosure *, ScrJsval **)) {
  isl_entry();
  /* Negative arity = the island-rest shape; the CELL count is the leading
   * declared params + the one rest-array slot. */
  if ((arity < 0 ? -arity : arity) > ISL_HOSTFN_MAX_ARITY) {
    fprintf(stderr, "scriptc: island callback arity %d exceeds %d\n", arity,
            ISL_HOSTFN_MAX_ARITY);
    abort(); /* the frontend fences this; reaching here is a compiler bug */
  }
  IslHostFn *b = malloc(sizeof *b);
  if (!b) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  b->c = scr_closure_retain(c);
  b->adapt = adapt;
  b->arity = arity;
  JSValue box = JS_NewObjectClass(isl_ctx, isl_hostfn_class_id);
  JS_SetOpaque(box, b);
  JSValueConst data[1] = {box};
  JSValue fn = JS_NewCFunctionData(isl_ctx, isl_hostfn_invoke, arity < 0 ? -arity - 1 : arity, 0, 1, data);
  JS_FreeValue(isl_ctx, box); /* fn's func_data holds its own reference */
  return isl_cell_new(fn);
}

/* ── the generic dyn-function shim (a boxed SCR_DYN_FUNC entering the
 * island) ─────────────────────────────────────────────────────────────
 * ONE shim serves every boxed function because the box's call thunk is a
 * single uniform C signature (ScrDynThunk): engine arguments wrap as dyn
 * values (scalar-normalizing — the jsval→dyn constructor's stance), the
 * thunk validates them against the closure's declared parameter types
 * and runs it, and the dyn result converts back through the from_dyn
 * rules (wrapped cells by reference, data as a deep copy, nested
 * functions through this same shim). OWNERSHIP: the engine function's
 * opaque box owns ONE reference on the whole ScrDyn FUNC node (closure
 * and descriptor ride inside); the engine finalizer releases it — at
 * teardown that runs before the RC audit, the isl_hostfn story. A
 * scriptc exception thrown inside reverse-bridges to an engine throw;
 * the receiver (`this`) is deliberately not forwarded (the typed
 * host-function stance — dyn thunks read the ambient receiver, which no
 * engine call site binds). Each crossing mints a FRESH engine function:
 * re-crossing identity is not preserved (SEMANTICS.md). */

static JSClassID isl_dynfn_class_id = 0;

static void isl_dynfn_finalizer(JSRuntime *rt, JSValueConst val) {
  (void)rt;
  ScrDyn *box = JS_GetOpaque(val, isl_dynfn_class_id);
  if (box) scr_dyn_release(box);
}

static const JSClassDef isl_dynfn_class = {
    .class_name = "ScrDynFn",
    .finalizer = isl_dynfn_finalizer,
};

static JSValue isl_dynfn_invoke(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv, int magic, JSValueConst *func_data) {
  (void)this_val;
  (void)magic;
  ScrDyn *box = JS_GetOpaque(func_data[0], isl_dynfn_class_id);
  if (!box) return JS_ThrowTypeError(ctx, "detached scriptc function");
  ScrDyn *stack_args[8];
  ScrDyn **dargs = argc <= 8 ? stack_args : malloc((size_t)argc * sizeof *dargs);
  for (int i = 0; i < argc; i++) dargs[i] = isl_dyn_from_value(argv[i]);
  bool strayed_before = isl_anchor_strayed;
  isl_host_depth++;
  ScrDyn *r = box->v.fn.thunk(box->v.fn.clo, dargs, (size_t)argc);
  isl_host_depth--;
  if (isl_anchor_strayed && !strayed_before) {
    /* The isl_hostfn_invoke re-anchor dance: a fiber the callback spawned
     * moved the engine's overflow anchor off this stack. */
    isl_anchor_here();
    isl_anchor_strayed = strayed_before;
  }
  for (int i = 0; i < argc; i++) scr_dyn_release(dargs[i]);
  if (dargs != stack_args) free(dargs);
  if (scr_exc_pending()) {
    if (r) scr_dyn_release(r);
    return isl_throw_pending(ctx);
  }
  if (!r) return JS_UNDEFINED;
  /* The thunk's dyn result converts back per the from_dyn rules; a kind
   * with no crossing (a handle, a promise) throws the same catchable
   * TypeError from_dyn would. */
  const char *bad = isl_dyn_unmarshalable(r);
  if (bad != NULL) {
    scr_dyn_release(r);
    return JS_ThrowTypeError(ctx, "an 'unknown' value holding %s cannot enter dynamically-executed code", bad);
  }
  JSValue out = isl_from_dyn(r);
  scr_dyn_release(r);
  return out; /* JS_EXCEPTION passes through as the engine throw */
}

/* A fresh engine function over a boxed dyn function (borrows d — the
 * opaque box retains it). */
static JSValue isl_dynfn_new(const ScrDyn *d) {
  JSValue boxv = JS_NewObjectClass(isl_ctx, isl_dynfn_class_id);
  JS_SetOpaque(boxv, scr_dyn_retain((ScrDyn *)d));
  JSValueConst data[1] = {boxv};
  JSValue fn = JS_NewCFunctionData(isl_ctx, isl_dynfn_invoke, (int)d->v.fn.arity, 0, 1, data);
  JS_FreeValue(isl_ctx, boxv); /* fn's func_data holds its own reference */
  return fn;
}

/* The typed adapters' absence test for `T | undefined` parameters. */
bool scr_jsval_is_undefined(ScrJsval *v) { return JS_IsUndefined(v->v); }

/* ── the promise bridge (async callbacks' thenable) ───────────────────
 * A typed callback with an async body returns a scriptc promise; the
 * package expects a real thenable. scr_jsval_from_promise mints an
 * engine promise capability and spawns a WAITER fiber that awaits the
 * scriptc promise — the settle notification the promise machinery
 * already has — then settles the capability: fulfillment marshals per the
 * payload tag, rejection reverse-bridges the reason (the same conversion
 * host-call throws use, so Errors arrive as engine Errors). The await
 * marks the rejection OBSERVED for the static ledger; from there the
 * engine's own rejection tracker owns the outcome — an unhandled wrapper
 * rejection reports through the island ledger, a handled one is silent.
 * One report, one voice, either way.
 *
 * Live wraps are registered so teardown can free their engine values if
 * the wrapped promise never settles (the waiter is then an abandoned
 * fiber; its stack is deliberately not unwound — the loop can only end
 * with an UNSETTLED wrap, since a settled one wakes the waiter as a
 * microtask before quiescence). */

typedef struct IslPromWrap {
  struct IslPromWrap *next;
  ScrPromise *p; /* the wrapped scriptc promise, +1 (moved in) */
  JSValue resolve, reject;
  int payload; /* SCR_ISLP_* */
} IslPromWrap;

static IslPromWrap *isl_prom_wraps = NULL;

/* Unlink + free one wrap (releases the promise, frees the capability's
 * settle functions). */
static void isl_prom_wrap_free(IslPromWrap *w) {
  for (IslPromWrap **link = &isl_prom_wraps; *link; link = &(*link)->next) {
    if (*link == w) {
      *link = w->next;
      break;
    }
  }
  JS_FreeValue(isl_ctx, w->resolve);
  JS_FreeValue(isl_ctx, w->reject);
  scr_promise_release(w->p);
  free(w);
}

/* The waiter fiber body: await, convert, settle the capability. Runs
 * eagerly at wrap time (already-settled promises deliver before the host
 * call returns — like a resolved thenable's synchronously-queued job) or
 * as a microtask when the promise settles later. isl_entry() re-anchors
 * the engine's overflow check to this fiber's stack (the stray/restore
 * dance in isl_entry/isl_hostfn_invoke keeps the host stack's anchor
 * intact around it). */
static void isl_prom_wrap_entry(ScrFiber *self, void *arg) {
  (void)self;
  IslPromWrap *w = (IslPromWrap *)arg;
  double f = 0;
  bool b = false;
  ScrStr *s = NULL;
  ScrJsval *j = NULL;
  ScrArr *ja = NULL;
  switch (w->payload) {
  case SCR_ISLP_F64: f = scr_await_f64(w->p); break;
  case SCR_ISLP_BOOL: b = scr_await_bool(w->p); break;
  case SCR_ISLP_STR: s = scr_await_str(w->p); break;
  case SCR_ISLP_JSVAL: j = (ScrJsval *)scr_await_ref(w->p); break;
  case SCR_ISLP_JSVAL_ARR: ja = (ScrArr *)scr_await_ref(w->p); break;
  default: scr_await_void(w->p); break;
  }
  bool rejected = scr_exc_pending();
  isl_entry();
  JSValue v;
  if (rejected) {
    v = isl_pending_to_value(isl_ctx);
  } else {
    switch (w->payload) {
    case SCR_ISLP_F64: v = JS_NewFloat64(isl_ctx, f); break;
    case SCR_ISLP_BOOL: v = JS_NewBool(isl_ctx, b); break;
    case SCR_ISLP_STR: v = s ? JS_NewStringLen(isl_ctx, s->data, s->len) : JS_UNDEFINED; break;
    case SCR_ISLP_JSVAL: v = j ? JS_DupValue(isl_ctx, j->v) : JS_UNDEFINED; break;
    case SCR_ISLP_JSVAL_ARR:
      /* A native array of engine cells fulfills: a fresh engine array
       * over the SAME engine values (identity crosses, spine a copy). */
      if (ja) {
        v = JS_NewArray(isl_ctx);
        for (size_t i = 0; i < ja->len; i++) {
          ScrJsval *cell = (ScrJsval *)scr_arr_get_ref(ja, (double)i); /* +1 */
          JS_SetPropertyUint32(isl_ctx, v, (uint32_t)i, JS_DupValue(isl_ctx, cell->v));
          scr_jsval_release(cell);
        }
      } else {
        v = JS_UNDEFINED;
      }
      break;
    default: v = JS_UNDEFINED; break;
    }
  }
  if (s) scr_str_release(s);
  if (j) scr_jsval_release(j);
  if (ja) scr_arr_release(ja);
  JSValue r = JS_Call(isl_ctx, rejected ? w->reject : w->resolve, JS_UNDEFINED, 1, &v);
  JS_FreeValue(isl_ctx, v);
  if (JS_IsException(r)) {
    /* Capability settle functions do not throw — defensive drop. */
    JSValue exc = JS_GetException(isl_ctx);
    JS_FreeValue(isl_ctx, exc);
  } else {
    JS_FreeValue(isl_ctx, r);
  }
  isl_prom_wrap_free(w);
}

/* Teardown half (registered path in isl_teardown_at_exit): free every
 * still-pending wrap's engine values. Their waiter fibers are abandoned
 * with the loop already over; nothing reads the nodes again. */
static void isl_prom_wraps_teardown(void) {
  while (isl_prom_wraps) isl_prom_wrap_free(isl_prom_wraps);
}

ScrJsval *scr_jsval_from_promise(ScrPromise *p, int payload) {
  isl_entry();
  JSValue funcs[2];
  JSValue prom = JS_NewPromiseCapability(isl_ctx, funcs);
  if (JS_IsException(prom)) {
    isl_bridge_exception();
    scr_promise_release(p);
    return NULL;
  }
  IslPromWrap *w = malloc(sizeof *w);
  if (!w) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  w->p = p;
  w->resolve = funcs[0];
  w->reject = funcs[1];
  w->payload = payload;
  w->next = isl_prom_wraps;
  isl_prom_wraps = w;
  ScrPromise *waiter = scr_async_spawn_after(w->p, isl_prom_wrap_entry, w);
  scr_promise_release(waiter); /* the waiter never rejects; nobody awaits it */
  return isl_cell_new(prom);
}

/* ── the promise bridge, island → static (awaiting package promises) ──
 * The reverse of scr_jsval_from_promise: a PACKAGE call's promise lives
 * in the engine, and static code awaiting (or .catch/.finally-chaining)
 * it needs a real ScrPromise. scr_jsval_bridge_promise mints a pending
 * one and subscribes through the pinned ISL_H_THEN helper —
 * Promise.resolve(p).then(onF, onR), so thenables and plain values behave
 * exactly like `await` treats them — with two engine functions sharing a
 * box that owns the static promise. Fulfillment settles it with the
 * retained value cell (or void); rejection converts the reason exactly
 * like a bridged exception (engine Errors become ScrErrors picked by
 * name) and rejects. The settle callbacks run as engine jobs, which the
 * loop drains at quiescence — parked awaiters wake through the ordinary
 * ready queue.
 *
 * Ledger one-voice: the .then marks the ENGINE promise handled (the
 * island's rejection tracker rescinds or never tracks it), and the
 * rejected static promise enters the STATIC ledger at settle — exactly
 * one world reports a never-observed rejection. The derived promise the
 * helper's .then creates is dropped unobserved, but it can never reject:
 * onR returns normally after rejecting the static side.
 *
 * Lifetime: the box is engine-owned (its finalizer releases the static
 * promise), so a bridge whose engine promise never settles frees cleanly
 * at engine teardown — before the RC audit — with no registry needed. A
 * never-settling engine promise queues no jobs, so a fiber parked on its
 * bridge does not keep the loop alive: exhaustion abandons the fiber and
 * the process exits 0, byte-identical to Node's await-forever. */

typedef struct {
  ScrPromise *p; /* the static promise this bridge settles, +1 */
  int payload;   /* SCR_ISLP_JSVAL or SCR_ISLP_VOID */
} IslBridge;

static JSClassID isl_bridge_class_id = 0;

static void isl_bridge_finalizer(JSRuntime *rt, JSValueConst val) {
  (void)rt;
  IslBridge *b = JS_GetOpaque(val, isl_bridge_class_id);
  if (b) {
    scr_promise_release(b->p);
    free(b);
  }
}

static const JSClassDef isl_bridge_class = {
    .class_name = "ScrPromiseBridge",
    .finalizer = isl_bridge_finalizer,
};

static void isl_register_bridge_class(void) {
  JS_NewClassID(isl_rt, &isl_bridge_class_id);
  JS_NewClass(isl_rt, isl_bridge_class_id, &isl_bridge_class);
}

/* onF (magic 0) / onR (magic 1). Runs as an engine job; argv[0] is the
 * settlement value/reason (borrowed). The static promise settles at most
 * once (.then invokes exactly one callback, once) — its own
 * first-settle-wins check backstops that anyway. */
static JSValue isl_bridge_settle(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv, int magic, JSValueConst *func_data) {
  (void)this_val;
  IslBridge *b = JS_GetOpaque(func_data[0], isl_bridge_class_id);
  if (!b) return JS_UNDEFINED;
  JSValueConst v = argc > 0 ? argv[0] : JS_UNDEFINED;
  if (magic == 0) {
    if (b->payload == SCR_ISLP_JSVAL) {
      /* fulfill_ref takes the +1 cell; awaiters retain their own out. */
      scr_promise_fulfill_ref(b->p, isl_cell_new(JS_DupValue(ctx, v)),
                               scr_jsval_retain_v, scr_jsval_release_v, NULL);
    } else if (b->payload == SCR_ISLP_JSVAL_ARR) {
      /* An `any[]`-declared fulfillment (the inferred loadPlugins return):
       * the engine array exits Array.isArray-gated, elements BY REFERENCE
       * (the jsval-element-array exit). A lying fulfillment (non-array)
       * REJECTS the static promise with the boundary TypeError —
       * trust-but-verify at the settle, like every dyn→static edge. */
      ScrJsval *cell = isl_cell_new(JS_DupValue(ctx, v));
      ScrArr *arr = scr_jsval_exit_jsval_arr(cell);
      scr_jsval_release(cell);
      if (!arr) {
        scr_promise_reject_pending(b->p);
      } else {
        scr_promise_fulfill_ref(b->p, arr, scr_arr_retain_v, scr_arr_release_v, NULL);
      }
    } else {
      scr_promise_fulfill_void(b->p);
    }
  } else {
    /* The reason crosses like a bridged exception, then moves out of the
     * (transiently used) current cell into the promise's rejection. */
    isl_throw_reason(v);
    scr_promise_reject_pending(b->p);
  }
  return JS_UNDEFINED;
}

ScrPromise *scr_jsval_bridge_promise(ScrJsval *v, int payload) {
  isl_entry();
  IslBridge *b = malloc(sizeof *b);
  if (!b) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  ScrPromise *p = scr_promise_new();
  b->p = scr_promise_retain(p);
  b->payload = payload;
  JSValue box = JS_NewObjectClass(isl_ctx, isl_bridge_class_id);
  JS_SetOpaque(box, b);
  JSValueConst data[1] = {box};
  JSValue on_f = JS_NewCFunctionData(isl_ctx, isl_bridge_settle, 1, 0, 1, data);
  JSValue on_r = JS_NewCFunctionData(isl_ctx, isl_bridge_settle, 1, 1, 1, data);
  JS_FreeValue(isl_ctx, box); /* each callback's func_data holds its own ref */
  JSValue args[3] = {v->v, on_f, on_r};
  JSValue r = JS_Call(isl_ctx, isl_helpers[ISL_H_THEN], JS_UNDEFINED, 3, args);
  JS_FreeValue(isl_ctx, on_f);
  JS_FreeValue(isl_ctx, on_r);
  if (JS_IsException(r)) {
    /* Promise.resolve().then on well-formed callbacks cannot throw; an
     * engine-level surprise (OOM) bridges like any exception. */
    isl_bridge_exception();
    scr_promise_release(p);
    return NULL;
  }
  JS_FreeValue(isl_ctx, r);
  return p;
}

/* Island-native literals. JS_SetProperty/JS_SetPropertyUint32 CONSUME the
 * value — dup, the caller's cells keep their own references. JS_ValueToAtom
 * borrows. */
ScrJsval *scr_jsval_obj_lit(int npairs, ScrJsval **kv) {
  isl_entry();
  JSValue o = JS_NewObject(isl_ctx);
  for (int i = 0; i < npairs; i++) {
    JSAtom k = JS_ValueToAtom(isl_ctx, kv[2 * i]->v);
    JS_SetProperty(isl_ctx, o, k, JS_DupValue(isl_ctx, kv[2 * i + 1]->v));
    JS_FreeAtom(isl_ctx, k);
  }
  return isl_cell_new(o);
}

/* The engine-native TemplateStringsArray for an island tag call: `kv`
 * carries n cooked strings then n raw strings — a fresh array whose
 * `.raw` property holds the raw spellings, exactly the object a tagged
 * template hands its tag (a JSON marshal would drop `.raw`, and tags
 * dispatch on it). */
ScrJsval *scr_jsval_tpl_strings(int n, ScrJsval **kv) {
  isl_entry();
  JSValue cooked = JS_NewArray(isl_ctx);
  JSValue raw = JS_NewArray(isl_ctx);
  for (int i = 0; i < n; i++) {
    JS_SetPropertyUint32(isl_ctx, cooked, (uint32_t)i, JS_DupValue(isl_ctx, kv[i]->v));
    JS_SetPropertyUint32(isl_ctx, raw, (uint32_t)i, JS_DupValue(isl_ctx, kv[n + i]->v));
  }
  JS_SetPropertyStr(isl_ctx, cooked, "raw", raw); /* consumes raw */
  return isl_cell_new(cooked);
}

/* Spread completion for an island-native literal: copies `src`'s own
 * enumerable properties onto `obj` — the engine's own Object.assign (the
 * spec's CopyDataProperties; null/undefined sources spread nothing) — and
 * answers the target retained (+1). NULL with the exception pending when
 * a source getter throws. */
ScrJsval *scr_jsval_obj_spread(ScrJsval *obj, ScrJsval *src) {
  isl_entry();
  if (JS_IsNull(src->v) || JS_IsUndefined(src->v)) return scr_jsval_retain(obj);
  JSValue global = JS_GetGlobalObject(isl_ctx);
  JSValue object_ctor = JS_GetPropertyStr(isl_ctx, global, "Object");
  JS_FreeValue(isl_ctx, global);
  JSValue assign = JS_GetPropertyStr(isl_ctx, object_ctor, "assign");
  JS_FreeValue(isl_ctx, object_ctor);
  JSValueConst args[2] = { obj->v, src->v };
  JSValue r = JS_Call(isl_ctx, assign, JS_UNDEFINED, 2, args);
  JS_FreeValue(isl_ctx, assign);
  if (JS_IsException(r)) {
    isl_bridge_exception();
    return NULL;
  }
  JS_FreeValue(isl_ctx, r); /* assign answers the target itself */
  return scr_jsval_retain(obj);
}

/* Getter completion for an island-native literal: defines `key` on `obj`
 * as an engine GETTER invoking `fn` (a marshaled host function), and
 * answers the object retained (+1) so builds chain. Enumerable +
 * configurable, no setter — exactly a JS object-literal `get k() {}`. */
ScrJsval *scr_jsval_define_getter(ScrJsval *obj, ScrJsval *key, ScrJsval *fn) {
  isl_entry();
  JSAtom k = JS_ValueToAtom(isl_ctx, key->v);
  JS_DefinePropertyGetSet(isl_ctx, obj->v, k, JS_DupValue(isl_ctx, fn->v), JS_UNDEFINED,
                          JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE);
  JS_FreeAtom(isl_ctx, k);
  return scr_jsval_retain(obj);
}

ScrJsval *scr_jsval_arr_lit(int n, ScrJsval **elems) {
  isl_entry();
  JSValue a = JS_NewArray(isl_ctx);
  for (int i = 0; i < n; i++) {
    JS_SetPropertyUint32(isl_ctx, a, (uint32_t)i, JS_DupValue(isl_ctx, elems[i]->v));
  }
  return isl_cell_new(a);
}

/* ── the module system (embedded npm code) ────────────────────────────
 * The engine's module loader and a CommonJS require shim, both resolving
 * exclusively from the emitted tables (isl_mods/isl_edges — no filesystem).
 * ESM sources compile natively; CJS modules run through a JS require shim
 * (new Function over the embedded source, module.exports cached) and enter
 * the ESM graph through an ESM facade SYNTHESIZED AT BUILD TIME (the
 * ScrIslandModule's esm field): default is module.exports itself and the
 * named exports are the ones the compiler's port of Node's vendored CJS
 * lexer found in the source, so `import { x } from 'cjs'` inside the
 * embedded graph links exactly like Node — including the REFUSALS: a name
 * the lexer cannot see is absent from the facade and the engine's
 * instantiate fails where Node's would. The import BOUNDARY below additionally
 * takes named exports off module.exports directly, so user-level named
 * imports of CJS-only packages work like Node too.
 * Node builtins are served as wrappers over island shims defined in the
 * bootstrap: events, path, process, os, diagnostics_channel, fs (stubs),
 * child_process (throwing stubs), module (createRequire over the embedded
 * tables), url (fileURLToPath/pathToFileURL). The process shim bridges REAL
 * argv/env/stdout/stderr/exit
 * through host functions, argv in the same ["scriptc", argv[0], ...]
 * shape as the static world's process.argv. */

/* mingw-w64 ships a unistd.h too (getcwd, isatty — scr_lib.c leans on the
 * same one); the process-surface hooks below otherwise delegate to the
 * scr_lib.c helpers, whose win32 arms already exist. winsock2.h is the
 * hostname hook's gethostname on win32. */
#include <unistd.h>
/* the fs bridge's constants hook (O_* open flags, S_IF* type bits), the
 * readlink op's errno, and os.constants' signal table */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#ifdef _WIN32
#include <winsock2.h>
#endif

#define ISL_IMPORT_BASE "<scr-import>"

static bool isl_booted = false;
static JSValue isl_cjs_import; /* (key, name) → export, CJS/JSON entries */

static char *isl_module_normalize(JSContext *ctx, const char *base,
                                  const char *name, void *opaque) {
  (void)opaque;
  const char *target = NULL;
  if (strncmp(name, "node:", 5) == 0) {
    target = name; /* builtins are their own keys */
  } else if (strcmp(base, ISL_IMPORT_BASE) == 0) {
    target = name; /* the import boundary passes resolved keys */
  } else {
    target = isl_edge_find(base, name, 1 /* import */);
  }
  if (!target) {
    JS_ThrowReferenceError(ctx,
                           "cannot resolve module '%s' from '%s' "
                           "(scriptc embeds npm code at build time)",
                           name, base);
    return NULL;
  }
  return js_strdup(ctx, target);
}

/* Named export lists for the builtin ESM wrappers. The wrapper source is
 * `const m = __scr_require("node:x"); export default m; export const
 * {…} = m;` — the shims themselves live in the bootstrap below. */
static const struct {
  const char *name;
  const char *exports;
} isl_builtins[] = {
    {"node:events",
     "EventEmitter,once,on,listenerCount,getEventListeners,setMaxListeners,"
     "defaultMaxListeners,errorMonitor,captureRejectionSymbol"},
    {"node:path",
     "sep,delimiter,basename,dirname,extname,join,resolve,normalize,relative,"
     "isAbsolute,toNamespacedPath,parse,format,posix,win32"},
    {"node:path/posix",
     "sep,delimiter,basename,dirname,extname,join,resolve,normalize,relative,"
     "isAbsolute,toNamespacedPath,parse,format,posix,win32"},
    {"node:path/win32",
     "sep,delimiter,basename,dirname,extname,join,resolve,normalize,relative,"
     "isAbsolute,toNamespacedPath,parse,format,posix,win32"},
    {"node:process",
     "argv,env,platform,execPath,execArgv,version,versions,stdout,stderr,stdin,"
     "cwd,exit,nextTick,hrtime,pid,ppid,title,argv0,release,config,"
     "allowedNodeEnvironmentFlags,emitWarning,uptime,memoryUsage,umask,"
     "exitCode,on,once,off,removeListener,emit"},
    {"node:fs",
     "readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync,"
     "mkdirSync,rmSync,rmdirSync,unlinkSync,readdirSync,statSync,lstatSync,"
     "accessSync,mkdtempSync,chmodSync,copyFileSync,renameSync,constants,"
     "Stats,Dirent,promises,readFile,writeFile,appendFile,exists,realpath,"
     "mkdir,rm,rmdir,unlink,readdir,stat,lstat,access,mkdtemp,chmod,copyFile,"
     "rename,readlink,readlinkSync,createReadStream,createWriteStream,watch,"
     "watchFile,unwatchFile,openSync,closeSync,readSync,read,open,"
     "ReadStream,WriteStream"},
    {"node:fs/promises",
     "readFile,writeFile,appendFile,realpath,mkdir,rm,rmdir,unlink,readdir,"
     "stat,lstat,access,mkdtemp,chmod,copyFile,rename,readlink,constants,open"},
    {"node:child_process", "spawn,spawnSync,exec,execSync,execFile,execFileSync,fork"},
    {"node:os",
     "EOL,platform,arch,hostname,homedir,tmpdir,type,endianness,userInfo,"
     "release,version,machine,cpus,availableParallelism,totalmem,freemem,"
     "loadavg,uptime,networkInterfaces,constants"},
    {"node:tty", "isatty,ReadStream,WriteStream"},
    {"node:http",
     "request,get,Agent,globalAgent,ClientRequest,IncomingMessage,STATUS_CODES,"
     "METHODS,createServer,Server"},
    {"node:https",
     "request,get,Agent,globalAgent,ClientRequest,IncomingMessage,STATUS_CODES,"
     "METHODS,createServer,Server"},
    {"node:net", "isIP,isIPv4,isIPv6,connect,createConnection,createServer,Socket,Server"},
    {"node:tls", "connect,createServer,createSecureContext,TLSSocket,rootCertificates"},
    {"node:diagnostics_channel", "channel,subscribe,unsubscribe,hasSubscribers,tracingChannel"},
    {"node:module",
     "createRequire,builtinModules,isBuiltin,syncBuiltinESMExports,register,"
     "findSourceMap"},
    {"node:url",
     "URL,URLSearchParams,fileURLToPath,pathToFileURL,parse,format,resolve,"
     "domainToASCII,domainToUnicode,urlToHttpOptions"},
    {"node:buffer",
     "Buffer,SlowBuffer,INSPECT_MAX_BYTES,kMaxLength,kStringMaxLength,constants,"
     "isAscii,isUtf8,atob,btoa,Blob,File,transcode,resolveObjectURL"},
    {"node:string_decoder", "StringDecoder"},
    {"node:assert",
     "AssertionError,ok,fail,equal,notEqual,strictEqual,notStrictEqual,"
     "deepEqual,notDeepEqual,deepStrictEqual,notDeepStrictEqual,throws,"
     "doesNotThrow,rejects,doesNotReject,match,doesNotMatch,ifError,strict"},
    {"node:assert/strict",
     "AssertionError,ok,fail,equal,notEqual,strictEqual,notStrictEqual,"
     "deepEqual,notDeepEqual,deepStrictEqual,notDeepStrictEqual,throws,"
     "doesNotThrow,rejects,doesNotReject,match,doesNotMatch,ifError,strict"},
    {"node:domain", "create,createDomain,Domain,active"},
    {"node:worker_threads",
     "isMainThread,parentPort,threadId,workerData,resourceLimits,"
     "MessageChannel,MessagePort,Worker,receiveMessageOnPort,SHARE_ENV,"
     "markAsUntransferable,getEnvironmentData,setEnvironmentData"},
    {"node:perf_hooks", "performance,PerformanceObserver,monitorEventLoopDelay,constants"},
    {"node:v8",
     "startupSnapshot,cachedDataVersionTag,getHeapStatistics,"
     "getHeapSpaceStatistics,getHeapCodeStatistics,getCppHeapStatistics,"
     "setFlagsFromString,takeCoverage,stopCoverage,setHeapSnapshotNearHeapLimit,"
     "serialize,deserialize,writeHeapSnapshot,getHeapSnapshot,queryObjects,"
     "startCpuProfile,isStringOneByteRepresentation,promiseHooks,"
     "Serializer,Deserializer,DefaultSerializer,DefaultDeserializer,GCProfiler"},
    {"node:dns",
     "lookup,lookupService,resolve,resolve4,resolve6,resolveCname,resolveMx,"
     "resolveNs,resolveSrv,resolveTxt,reverse,getServers,setServers,Resolver,"
     "promises,ADDRCONFIG,V4MAPPED,ALL"},
    {"node:async_hooks",
     "AsyncLocalStorage,AsyncResource,executionAsyncId,triggerAsyncId,"
     "executionAsyncResource,createHook"},
    {"node:punycode", "version,ucs2,decode,encode,toASCII,toUnicode"},
    {"node:querystring", "parse,stringify,decode,encode,escape,unescape,unescapeBuffer"},
    {"node:constants", "F_OK,R_OK,W_OK,X_OK"},
    {"node:console", "Console,log,info,debug,warn,error,trace,dir,assert,count,countReset,time,timeEnd,group,groupEnd,table,clear"},
    {"node:timers", "setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate"},
    {"node:timers/promises", "setTimeout,setImmediate,setInterval,scheduler"},
    {"node:zlib",
     "deflateSync,inflateSync,deflateRawSync,inflateRawSync,gzipSync,"
     "gunzipSync,unzipSync,deflate,inflate,deflateRaw,inflateRaw,gzip,gunzip,"
     "unzip,Deflate,Inflate,DeflateRaw,InflateRaw,Gzip,Gunzip,Unzip,"
     "BrotliCompress,BrotliDecompress,createDeflate,createInflate,"
     "createDeflateRaw,createInflateRaw,createGzip,createGunzip,createUnzip,"
     "createBrotliCompress,createBrotliDecompress,brotliCompressSync,"
     "brotliDecompressSync,constants"},
    {"node:readline",
     "Interface,createInterface,clearLine,clearScreenDown,cursorTo,moveCursor,"
     "emitKeypressEvents"},
    {"node:stream",
     "Stream,Readable,Writable,Duplex,Transform,PassThrough,pipeline,finished,"
     "addAbortSignal,promises,isErrored,isDestroyed,isReadable,isWritable"},
    {"node:stream/promises", "pipeline,finished"},
    {"node:stream/consumers", "text,buffer,arrayBuffer,json,blob"},
    {"node:stream/web",
     "ReadableStream,WritableStream,TransformStream,TextEncoderStream,"
     "TextDecoderStream,CountQueuingStrategy,ByteLengthQueuingStrategy,"
     "ReadableStreamDefaultReader,ReadableStreamDefaultController,"
     "WritableStreamDefaultWriter"},
    {"node:crypto",
     "createHash,createHmac,hash,Hash,Hmac,randomBytes,randomFillSync,randomFill,"
     "randomInt,randomUUID,getRandomValues,timingSafeEqual,pbkdf2,pbkdf2Sync,"
     "getHashes,getCiphers,getCurves,webcrypto,subtle,constants,KeyObject,"
     "createCipheriv,createDecipheriv,createSign,createVerify,"
     "createDiffieHellman,createECDH,createPublicKey,createPrivateKey,"
     "createSecretKey,diffieHellman,generateKeyPair,generateKeyPairSync,"
     "generateKey,generateKeySync,sign,verify,publicEncrypt,publicDecrypt,"
     "privateEncrypt,privateDecrypt,scrypt,scryptSync,hkdf,hkdfSync,"
     "X509Certificate,Certificate,checkPrime,checkPrimeSync,generatePrime,"
     "generatePrimeSync,secureHeapUsed,setEngine,setFips,getFips"},
    {"node:util",
     "format,formatWithOptions,inspect,inherits,promisify,callbackify,deprecate,"
     "debuglog,debug,types,isDeepStrictEqual,stripVTControlCharacters,styleText,"
     "parseArgs,toUSVString,_extend,TextEncoder,TextDecoder,isArray"},
    {"node:util/types",
     "isAnyArrayBuffer,isArrayBufferView,isArgumentsObject,isArrayBuffer,"
     "isAsyncFunction,isBigInt64Array,isBigUint64Array,isBooleanObject,"
     "isBoxedPrimitive,isBigIntObject,isCryptoKey,isDataView,isDate,isExternal,"
     "isFloat16Array,isFloat32Array,isFloat64Array,isGeneratorFunction,"
     "isGeneratorObject,isInt8Array,isInt16Array,isInt32Array,isKeyObject,isMap,"
     "isMapIterator,isModuleNamespaceObject,isNativeError,isNumberObject,"
     "isPromise,isProxy,isRegExp,isSet,isSetIterator,isSharedArrayBuffer,"
     "isStringObject,isSymbolObject,isTypedArray,isUint8Array,"
     "isUint8ClampedArray,isUint16Array,isUint32Array,isWeakMap,isWeakSet"},
};

static JSModuleDef *isl_module_load(JSContext *ctx, const char *name, void *opaque) {
  (void)opaque;
  const char *src = NULL;
  size_t len = 0;
  /* Sized for the widest wrapper: node:util/types' export list alone is
   * ~700 bytes. */
  char buf[2048];
  char *heap = NULL;
  if (strncmp(name, "node:", 5) == 0) {
    const char *exports = NULL;
    for (size_t i = 0; i < sizeof isl_builtins / sizeof isl_builtins[0]; i++) {
      if (strcmp(isl_builtins[i].name, name) == 0) {
        exports = isl_builtins[i].exports;
        break;
      }
    }
    if (!exports) {
      JS_ThrowReferenceError(ctx, "the island does not provide the '%s' builtin", name);
      return NULL;
    }
    snprintf(buf, sizeof buf,
             "const m=globalThis.__scr_require(\"%s\");export default m;"
             "export const{%s}=m;",
             name, exports);
    src = buf;
    len = strlen(buf);
  } else {
    const ScrIslandModule *m = isl_mod_find(name);
    if (!m) {
      JS_ThrowReferenceError(ctx, "module '%s' is not embedded", name);
      return NULL;
    }
    if (m->format == 0) {
      src = isl_mod_text(m, false, &len);
      if (!src) {
        JS_ThrowInternalError(ctx, "embedded module '%s' failed to inflate", name);
        return NULL;
      }
    } else if (m->esm) {
      /* CJS entering the ESM graph: the facade synthesized at BUILD time —
       * default plus the lexed named exports (Node's interop exactly). */
      src = isl_mod_text(m, true, &len);
      if (!src) {
        JS_ThrowInternalError(ctx, "embedded module '%s' failed to inflate", name);
        return NULL;
      }
    } else {
      /* JSON (or a facade-less CJS module from an older emitter) entering
       * the ESM graph: Node's default-only interop. */
      size_t n = strlen(name) + 64;
      heap = malloc(n);
      if (!heap) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
      }
      snprintf(heap, n, "const m=globalThis.__scr_require(\"%s\");export default m;", name);
      src = heap;
      len = strlen(heap);
    }
  }
  JSValue v = JS_Eval(ctx, src, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
  free(heap);
  if (JS_IsException(v)) return NULL;
  JSModuleDef *def = JS_VALUE_GET_PTR(v);
  /* import.meta.url — Node sets the module's file:// URL; embedded keys
   * are realpaths, builtins keep their node: name. Emscripten factory
   * modules read it (_scriptName, createRequire(import.meta.url)). */
  JSValue meta = JS_GetImportMeta(ctx, def);
  if (!JS_IsException(meta)) {
    JSValue url;
    if (name[0] == '/') {
      size_t n = strlen(name) + 8;
      char *buf2 = malloc(n);
      if (buf2) {
        snprintf(buf2, n, "file://%s", name);
        url = JS_NewString(ctx, buf2);
        free(buf2);
      } else {
        url = JS_NewString(ctx, name);
      }
    } else {
      url = JS_NewString(ctx, name);
    }
    JS_SetPropertyStr(ctx, meta, "url", url); /* consumed */
    JS_FreeValue(ctx, meta);
  }
  JS_FreeValue(ctx, v);
  return def;
}

/* ── host functions for the bootstrap ─────────────────────────────────
 * The engine's ownership rules: argv values are borrowed, results owned. */

static JSValue isl_host_source(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *key = JS_ToCString(ctx, argv[0]);
  if (!key) return JS_EXCEPTION;
  const ScrIslandModule *m = isl_mod_find(key);
  if (!m) {
    JS_FreeCString(ctx, key);
    return JS_UNDEFINED;
  }
  size_t len = 0;
  const char *src = isl_mod_text(m, false, &len);
  if (!src) {
    JSValue e = JS_ThrowInternalError(ctx, "embedded module '%s' failed to inflate", key);
    JS_FreeCString(ctx, key);
    return e;
  }
  JS_FreeCString(ctx, key);
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewStringLen(ctx, src, len));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, m->format));
  return arr;
}

static JSValue isl_host_resolve(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *from = JS_ToCString(ctx, argv[0]);
  const char *spec = from ? JS_ToCString(ctx, argv[1]) : NULL;
  if (!from || !spec) {
    if (from) JS_FreeCString(ctx, from);
    return JS_EXCEPTION;
  }
  /* host.resolve serves the require shim exclusively — require kind. */
  const char *to = strncmp(spec, "node:", 5) == 0 ? spec : isl_edge_find(from, spec, 2);
  JSValue r = to ? JS_NewString(ctx, to) : JS_UNDEFINED;
  JS_FreeCString(ctx, from);
  JS_FreeCString(ctx, spec);
  return r;
}

static JSValue isl_host_argv(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* The static world's shape exactly: ["scriptc", argv[0], argv[1], ...]. */
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewString(ctx, "scriptc"));
  int n = scr_lib_arg_count();
  for (int i = 0; i < n; i++) {
    JS_SetPropertyUint32(ctx, arr, (uint32_t)(i + 1), JS_NewString(ctx, scr_lib_arg(i)));
  }
  return arr;
}

static JSValue isl_host_env(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* scr_env_pairs (scr_lib.c): the SAME snapshot the static world's
   * process.env builds from — environ order on POSIX, the WIN32
   * environment block (hidden "=C:" per-drive entries skipped, exactly
   * libuv) on Windows. ScrStr data is NUL-terminated, so the key can go
   * straight into JS_SetPropertyStr. */
  JSValue obj = JS_NewObject(ctx);
  ScrArr *pairs = scr_env_pairs();
  size_t n = (size_t)scr_arr_len(pairs);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *k = scr_arr_get_ref(pairs, (double)i);
    ScrStr *v = scr_arr_get_ref(pairs, (double)(i + 1));
    JS_SetPropertyStr(ctx, obj, k->data, JS_NewStringLen(ctx, v->data, v->len));
    scr_str_release(k);
    scr_str_release(v);
  }
  scr_arr_release(pairs);
  return obj;
}

static JSValue isl_host_write(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t fd = 1;
  JS_ToInt32(ctx, &fd, argv[0]);
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, argv[1]);
  if (!s) return JS_EXCEPTION;
  scr_stdio_write(fd, s, len);
  JS_FreeCString(ctx, s);
  return JS_TRUE;
}

/* Whole-input stdin read (fd 0 to EOF), returned as an ArrayBuffer — the
 * island's process.stdin Readable pushes it as one Buffer chunk on first
 * pull. Blocking, like Node's stdin read when a pipe's writer is slow;
 * a TTY caller that never reads (get-stdin's isTTY early-return) never
 * gets here. Bytes, not text: invalid UTF-8 must round-trip. */
static JSValue isl_host_read_stdin(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  size_t cap = 65536;
  size_t len = 0;
  uint8_t *buf = malloc(cap);
  if (!buf) return JS_ThrowOutOfMemory(ctx);
  for (;;) {
    if (len == cap) {
      cap *= 2;
      uint8_t *next = realloc(buf, cap);
      if (!next) {
        free(buf);
        return JS_ThrowOutOfMemory(ctx);
      }
      buf = next;
    }
    ssize_t n = read(0, buf + len, cap - len);
    if (n < 0) {
      if (errno == EINTR) continue;
      free(buf);
      return JS_ThrowTypeError(ctx, "reading stdin failed: %s", strerror(errno));
    }
    if (n == 0) break;
    len += (size_t)n;
  }
  JSValue ab = JS_NewArrayBufferCopy(ctx, buf, len);
  free(buf);
  return ab;
}

static JSValue isl_host_exit(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t code = 0;
  JS_ToInt32(ctx, &code, argv[0]);
  /* Node's process.exit: no unwinding, no destructors — and no atexit
   * teardown here either (tearing the engine down from inside JS_Call
   * would free live frames). The RC/engine audits are documented to not
   * run on this path. */
  fflush(NULL);
  _exit(code);
}

/* The island process shim's implicit exit status (process.exitCode):
 * mirrored here by the shim's setter, read by the emitted main after the
 * loop drains — Node's a-program-that-sets-it-and-returns contract. */
static int isl_exit_code = 0;
static size_t isl_exit_code_version = 0;

int scr_island_exit_code(void) { return isl_exit_code; }
size_t scr_island_exit_code_version(void) { return isl_exit_code_version; }

static JSValue isl_host_set_exit_code(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t code = 0;
  JS_ToInt32(ctx, &code, argv[0]);
  isl_exit_code = code;
  isl_exit_code_version++;
  return JS_UNDEFINED;
}

static JSValue isl_host_isatty(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t fd = 1;
  JS_ToInt32(ctx, &fd, argv[0]);
  return JS_NewBool(ctx, isatty(fd) == 1);
}

static JSValue isl_host_columns(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t fd = 1;
  JS_ToInt32(ctx, &fd, argv[0]);
  /* scr_process_columns (scr_lib.c): ioctl(TIOCGWINSZ) on POSIX,
   * GetConsoleScreenBufferInfo on Windows — the static world's
   * process.stdout.columns source of truth; -1 (non-TTY / refused)
   * stays this hook's historical 0. */
  double cols = scr_process_columns((double)fd);
  return JS_NewInt32(ctx, cols > 0 ? (int32_t)cols : 0);
}

static JSValue isl_host_cwd(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  char buf[4096];
  if (!getcwd(buf, sizeof buf)) buf[0] = '\0';
  return JS_NewString(ctx, buf);
}

static JSValue isl_host_platform(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *p = scr_process_platform(); /* +1 interned; matches the static world */
  JSValue r = JS_NewStringLen(ctx, p->data, p->len);
  scr_str_release(p);
  return r;
}

/* os.homedir()/os.tmpdir() bridge to the SAME runtime functions the static
 * lowerings call (scr_lib.c) — one implementation, one answer. */
static JSValue isl_host_homedir(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *s = scr_os_homedir(); /* +1 */
  JSValue r = JS_NewStringLen(ctx, s->data, s->len);
  scr_str_release(s);
  return r;
}

static JSValue isl_host_tmpdir(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *s = scr_os_tmpdir(); /* +1 */
  JSValue r = JS_NewStringLen(ctx, s->data, s->len);
  scr_str_release(s);
  return r;
}

static JSValue isl_host_arch(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* Node's process.arch/os.arch() names, decided at compile time. */
#if defined(__aarch64__) || defined(__arm64__)
  return JS_NewString(ctx, "arm64");
#elif defined(__x86_64__)
  return JS_NewString(ctx, "x64");
#elif defined(__i386__)
  return JS_NewString(ctx, "ia32");
#else
  return JS_NewString(ctx, "unknown");
#endif
}

/* The fs bridge: one dispatcher over the SAME scr_fs_* implementations
 * the static lowerings call (Node-shaped errors including the errno-name
 * code cross through isl_throw_pending). String args arrive as engine
 * strings, data as Uint8Arrays; stats come back as a compact array the
 * JS shim shapes into Node's Stats. */
static ScrStr *isl_arg_str(JSContext *ctx, JSValueConst v) {
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, v);
  if (!s) return NULL;
  ScrStr *out = scr_str_new(s, len);
  JS_FreeCString(ctx, s);
  return out;
}

static JSValue isl_host_fs(JSContext *ctx, JSValueConst this_val, int argc,
                           JSValueConst *argv) {
  (void)this_val;
  const char *op = JS_ToCString(ctx, argv[0]);
  if (!op) return JS_EXCEPTION;
  JSValue ret = JS_UNDEFINED;
  ScrStr *a = NULL;
  ScrStr *b = NULL;
  if (argc > 1 && JS_IsString(argv[1])) {
    a = isl_arg_str(ctx, argv[1]);
    if (!a) {
      JS_FreeCString(ctx, op);
      return JS_EXCEPTION;
    }
  }
  if (strcmp(op, "readFile") == 0) {
    ScrBytes *data = scr_fs_read_file_bytes(a);
    if (data) {
      ret = JS_NewUint8ArrayCopy(ctx, data->data, (size_t)scr_bytes_len(data));
      scr_bytes_release(data);
    }
  } else if (strcmp(op, "writeFile") == 0 || strcmp(op, "appendFile") == 0) {
    size_t len = 0;
    uint8_t *buf = JS_GetUint8Array(ctx, &len, argv[2]);
    if (buf || len == 0) {
      ScrStr *data = scr_str_new((const char *)buf, len);
      if (strcmp(op, "writeFile") == 0) scr_fs_write_file(a, data);
      else scr_fs_append_file(a, data);
      scr_str_release(data);
    } else {
      ret = JS_EXCEPTION;
    }
  } else if (strcmp(op, "exists") == 0) {
    ret = JS_NewBool(ctx, scr_fs_exists(a));
  } else if (strcmp(op, "realpath") == 0) {
    ScrStr *r = scr_fs_realpath(a);
    if (r) {
      ret = JS_NewStringLen(ctx, r->data, r->len);
      scr_str_release(r);
    }
  } else if (strcmp(op, "mkdir") == 0) {
    int32_t recursive = 0;
    double mode = -1;
    JS_ToInt32(ctx, &recursive, argv[2]);
    JS_ToFloat64(ctx, &mode, argv[3]);
    if (mode < 0) {
      if (recursive) scr_fs_mkdir_recursive(a);
      else scr_fs_mkdir(a);
    } else {
      if (recursive) scr_fs_mkdir_recursive_mode(a, mode);
      else scr_fs_mkdir_mode(a, mode);
    }
  } else if (strcmp(op, "rm") == 0) {
    int32_t recursive = 0;
    int32_t force = 0;
    JS_ToInt32(ctx, &recursive, argv[2]);
    JS_ToInt32(ctx, &force, argv[3]);
    scr_fs_rm_opts(a, recursive != 0, force != 0);
  } else if (strcmp(op, "rmdir") == 0) {
    scr_fs_rmdir(a);
  } else if (strcmp(op, "unlink") == 0) {
    scr_fs_unlink(a);
  } else if (strcmp(op, "readdir") == 0) {
    ScrArr *names = scr_fs_readdir(a);
    if (names) {
      JSValue arr = JS_NewArray(ctx);
      size_t n = (size_t)scr_arr_len(names);
      for (size_t i = 0; i < n; i++) {
        ScrStr *name = scr_arr_get_ref(names, (double)i);
        JS_SetPropertyUint32(ctx, arr, (uint32_t)i, JS_NewStringLen(ctx, name->data, name->len));
        scr_str_release(name);
      }
      scr_arr_release(names);
      ret = arr;
    }
  } else if (strcmp(op, "scandir") == 0) {
    ScrScandir *s = scr_fs_scandir(a);
    if (s) {
      JSValue arr = JS_NewArray(ctx);
      size_t n = scr_fs_scandir_count(s);
      for (size_t i = 0; i < n; i++) {
        ScrStr *name = scr_fs_scandir_name(s, i);
        JS_SetPropertyUint32(ctx, arr, (uint32_t)(i * 2), JS_NewStringLen(ctx, name->data, name->len));
        JS_SetPropertyUint32(ctx, arr, (uint32_t)(i * 2 + 1), JS_NewFloat64(ctx, scr_fs_scandir_type(s, i)));
        scr_str_release(name);
      }
      scr_fs_scandir_free(s);
      ret = arr;
    }
  } else if (strcmp(op, "stat") == 0 || strcmp(op, "lstat") == 0) {
    ScrStats *st = strcmp(op, "stat") == 0 ? scr_fs_stat(a) : scr_fs_lstat(a);
    if (st) {
      JSValue arr = JS_NewArray(ctx);
      JS_SetPropertyUint32(ctx, arr, 0, JS_NewBool(ctx, scr_stats_is_file(st)));
      JS_SetPropertyUint32(ctx, arr, 1, JS_NewBool(ctx, scr_stats_is_dir(st)));
      JS_SetPropertyUint32(ctx, arr, 2, JS_NewBool(ctx, scr_stats_is_symlink(st)));
      JS_SetPropertyUint32(ctx, arr, 3, JS_NewFloat64(ctx, scr_stats_size(st)));
      JS_SetPropertyUint32(ctx, arr, 4, JS_NewFloat64(ctx, scr_stats_mtime_ms(st)));
      JS_SetPropertyUint32(ctx, arr, 5, JS_NewFloat64(ctx, scr_stats_blocks(st)));
      JS_SetPropertyUint32(ctx, arr, 6, JS_NewFloat64(ctx, scr_stats_nlink(st)));
      JS_SetPropertyUint32(ctx, arr, 7, JS_NewFloat64(ctx, scr_stats_atime_ms(st)));
      scr_stats_release(st);
      ret = arr;
    }
  } else if (strcmp(op, "access") == 0) {
    double mode = 0;
    JS_ToFloat64(ctx, &mode, argv[2]);
    scr_fs_access(a, mode);
  } else if (strcmp(op, "mkdtemp") == 0) {
    ScrStr *r = scr_fs_mkdtemp(a);
    if (r) {
      ret = JS_NewStringLen(ctx, r->data, r->len);
      scr_str_release(r);
    }
  } else if (strcmp(op, "chmod") == 0) {
    double mode = 0;
    JS_ToFloat64(ctx, &mode, argv[2]);
    scr_fs_chmod(a, mode);
  } else if (strcmp(op, "readlink") == 0) {
#ifdef _WIN32
    scr_fs_throw(EINVAL, "readlink", a);
#else
    char buf[4096];
    ssize_t n = readlink(a->data, buf, sizeof buf - 1);
    if (n < 0) {
      scr_fs_throw(errno, "readlink", a);
    } else {
      ret = JS_NewStringLen(ctx, buf, (size_t)n);
    }
#endif
  } else if (strcmp(op, "copyFile") == 0 || strcmp(op, "rename") == 0) {
    b = isl_arg_str(ctx, argv[2]);
    if (b) {
      if (strcmp(op, "copyFile") == 0) scr_fs_copyfile(a, b);
      else scr_fs_rename(a, b);
    } else {
      ret = JS_EXCEPTION;
    }
  } else {
    JS_FreeCString(ctx, op);
    if (a) scr_str_release(a);
    return JS_ThrowReferenceError(ctx, "unknown island fs op");
  }
  JS_FreeCString(ctx, op);
  if (a) scr_str_release(a);
  if (b) scr_str_release(b);
  if (JS_IsException(ret)) return ret;
  if (scr_exc_pending()) {
    JS_FreeValue(ctx, ret);
    return isl_throw_pending(ctx);
  }
  return ret;
}

/* The path bridge: both of Node's implementations live in scr_path.c
 * (the posix family and the byte-exact win32 port) — the island's path
 * module rides them instead of re-porting. join/resolve pass the call's
 * strings as an engine array. */
static JSValue isl_host_path(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *op = JS_ToCString(ctx, argv[0]);
  if (!op) return JS_EXCEPTION;
  int win32 = JS_ToBool(ctx, argv[1]);
  JSValue ret = JS_UNDEFINED;
  if (strcmp(op, "join") == 0 || strcmp(op, "resolve") == 0) {
    JSValue lenv = JS_GetPropertyStr(ctx, argv[2], "length");
    uint32_t n = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);
    ScrArr *parts = scr_arr_new(SCR_ELEM_STR, n);
    bool ok = true;
    for (uint32_t i = 0; i < n; i++) {
      JSValue el = JS_GetPropertyUint32(ctx, argv[2], i);
      ScrStr *s = isl_arg_str(ctx, el);
      JS_FreeValue(ctx, el);
      if (!s) {
        ok = false;
        break;
      }
      scr_arr_push_ref(parts, s);
    }
    if (ok) {
      ScrStr *r = strcmp(op, "join") == 0
                      ? (win32 ? scr_path_win32_join(parts) : scr_path_join(parts))
                      : (win32 ? scr_path_win32_resolve(parts) : scr_path_resolve(parts));
      ret = JS_NewStringLen(ctx, r->data, r->len);
      scr_str_release(r);
    } else {
      ret = JS_EXCEPTION;
    }
    scr_arr_release(parts);
  } else {
    ScrStr *a = isl_arg_str(ctx, argv[2]);
    if (!a) {
      JS_FreeCString(ctx, op);
      return JS_EXCEPTION;
    }
    if (strcmp(op, "isAbsolute") == 0) {
      ret = JS_NewBool(ctx, win32 ? scr_path_win32_is_absolute(a) : scr_path_is_absolute(a));
    } else if (strcmp(op, "basename") == 0) {
      ScrStr *suffix = isl_arg_str(ctx, argv[3]);
      if (suffix) {
        ScrStr *r = win32 ? scr_path_win32_basename(a, suffix) : scr_path_basename(a, suffix);
        ret = JS_NewStringLen(ctx, r->data, r->len);
        scr_str_release(r);
        scr_str_release(suffix);
      } else {
        ret = JS_EXCEPTION;
      }
    } else if (strcmp(op, "relative") == 0) {
      ScrStr *to = isl_arg_str(ctx, argv[3]);
      if (to) {
        ScrStr *r = win32 ? scr_path_win32_relative(a, to) : scr_path_relative(a, to);
        ret = JS_NewStringLen(ctx, r->data, r->len);
        scr_str_release(r);
        scr_str_release(to);
      } else {
        ret = JS_EXCEPTION;
      }
    } else {
      ScrStr *r = NULL;
      if (strcmp(op, "normalize") == 0) r = win32 ? scr_path_win32_normalize(a) : scr_path_normalize(a);
      else if (strcmp(op, "dirname") == 0) r = win32 ? scr_path_win32_dirname(a) : scr_path_dirname(a);
      else if (strcmp(op, "extname") == 0) r = win32 ? scr_path_win32_extname(a) : scr_path_extname(a);
      else if (strcmp(op, "toNamespacedPath") == 0) r = win32 ? scr_path_win32_to_namespaced_path(a) : scr_path_to_namespaced_path(a);
      if (r) {
        ret = JS_NewStringLen(ctx, r->data, r->len);
        scr_str_release(r);
      } else {
        ret = JS_ThrowReferenceError(ctx, "unknown island path op");
      }
    }
    scr_str_release(a);
  }
  JS_FreeCString(ctx, op);
  return ret;
}

/* The zlib bridge: function pointers scr_zlib_island.c installs (from
 * the emitted main, exactly when the embedded graph imports node:zlib —
 * the isl_fetch_boot registration precedent). The hooks always exist;
 * unlinked builds get a clear refusal at the call. */
static ScrBytes *(*isl_zlib_deflate)(const ScrBytes *, double, double) = NULL;
static ScrBytes *(*isl_zlib_inflate)(const ScrBytes *, double) = NULL;

void scr_island_set_zlib(ScrBytes *(*deflate)(const ScrBytes *, double, double),
                         ScrBytes *(*inflate)(const ScrBytes *, double)) {
  isl_zlib_deflate = deflate;
  isl_zlib_inflate = inflate;
}

static JSValue isl_host_zlib(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t deflating = 0;
  int32_t mode = 0;
  double level = -1;
  JS_ToInt32(ctx, &deflating, argv[0]);
  JS_ToInt32(ctx, &mode, argv[2]);
  JS_ToFloat64(ctx, &level, argv[3]);
  if (deflating ? isl_zlib_deflate == NULL : isl_zlib_inflate == NULL) {
    return JS_ThrowReferenceError(ctx, "zlib is not linked into this binary");
  }
  size_t len = 0;
  uint8_t *data = JS_GetUint8Array(ctx, &len, argv[1]);
  if (!data && len) return JS_EXCEPTION;
  ScrBytes *in = scr_bytes_new(SCR_BYTES_U8, (double)len);
  memcpy(in->data, data, len);
  ScrBytes *out;
  if (deflating) out = isl_zlib_deflate(in, (double)mode, level);
  else out = isl_zlib_inflate(in, (double)mode);
  scr_bytes_release(in);
  if (!out) return isl_throw_pending(ctx);
  JSValue r = JS_NewUint8ArrayCopy(ctx, out->data, (size_t)scr_bytes_len(out));
  scr_bytes_release(out);
  return r;
}

/* url.fileURLToPath / url.pathToFileURL over the static converters
 * (scr_url.c) — Node's exact percent-decoding/encoding and host rules,
 * the win32 arms on win32 targets. Failures cross as the converters'
 * catchable TypeErrors. */
static JSValue isl_host_url_to_path(JSContext *ctx, JSValueConst this_val, int argc,
                                    JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  ScrStr *s = isl_arg_str(ctx, argv[0]);
  if (!s) return JS_EXCEPTION;
#ifdef _WIN32
  ScrUrl *u = scr_url_new(s);
  ScrStr *r = u ? scr_url_to_path_w32(u) : NULL;
  if (u) scr_url_release(u);
#else
  ScrStr *r = scr_url_str_to_path(s);
#endif
  scr_str_release(s);
  if (!r) return isl_throw_pending(ctx);
  JSValue out = JS_NewStringLen(ctx, r->data, r->len);
  scr_str_release(r);
  return out;
}

static JSValue isl_host_url_from_path(JSContext *ctx, JSValueConst this_val, int argc,
                                      JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  ScrStr *s = isl_arg_str(ctx, argv[0]);
  if (!s) return JS_EXCEPTION;
#ifdef _WIN32
  ScrUrl *u = scr_url_from_path_w32(s);
#else
  ScrUrl *u = scr_url_from_path(s);
#endif
  scr_str_release(s);
  if (!u) return isl_throw_pending(ctx);
  ScrStr *href = scr_url_href(u);
  scr_url_release(u);
  JSValue out = JS_NewStringLen(ctx, href->data, href->len);
  scr_str_release(href);
  return out;
}

/* fs.constants (and the legacy `constants` module's fs half): the REAL
 * macro values of the target platform — access modes, open flags, and
 * the S_IF* type bits. */
static JSValue isl_host_fs_constants(JSContext *ctx, JSValueConst this_val, int argc,
                                     JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  JSValue o = JS_NewObject(ctx);
#define ISL_CONST(name) JS_SetPropertyStr(ctx, o, #name, JS_NewInt32(ctx, name))
  ISL_CONST(F_OK);
  ISL_CONST(R_OK);
  ISL_CONST(W_OK);
#ifdef X_OK
  ISL_CONST(X_OK);
#else /* mingw CRTs without an execute bit: Node's win32 X_OK is 1 */
  JS_SetPropertyStr(ctx, o, "X_OK", JS_NewInt32(ctx, 1));
#endif
  ISL_CONST(O_RDONLY);
  ISL_CONST(O_WRONLY);
  ISL_CONST(O_RDWR);
  ISL_CONST(O_CREAT);
  ISL_CONST(O_EXCL);
  ISL_CONST(O_TRUNC);
  ISL_CONST(O_APPEND);
#ifdef O_NONBLOCK
  ISL_CONST(O_NONBLOCK);
#endif
#ifdef O_SYMLINK
  ISL_CONST(O_SYMLINK);
#endif
#ifdef S_IFMT
  ISL_CONST(S_IFMT);
  ISL_CONST(S_IFREG);
  ISL_CONST(S_IFDIR);
  ISL_CONST(S_IFCHR);
#endif
#ifdef S_IFLNK
  ISL_CONST(S_IFLNK);
#endif
#ifdef S_IFIFO
  ISL_CONST(S_IFIFO);
#endif
#ifdef S_IFSOCK
  ISL_CONST(S_IFSOCK);
#endif
#ifdef S_IFBLK
  ISL_CONST(S_IFBLK);
#endif
  JS_SetPropertyStr(ctx, o, "COPYFILE_EXCL", JS_NewInt32(ctx, 1));
  JS_SetPropertyStr(ctx, o, "COPYFILE_FICLONE", JS_NewInt32(ctx, 2));
  JS_SetPropertyStr(ctx, o, "COPYFILE_FICLONE_FORCE", JS_NewInt32(ctx, 4));
#undef ISL_CONST
  return o;
}

/* crypto.createHash/createHmac bridge: one-shot digests over the same
 * FIPS implementations the static lowerings use (plus MD5, scr_lib.c) —
 * the shim concatenates update() chunks JS-side and asks once at
 * digest(). undefined for an unknown algorithm (the shim throws Node's
 * shape). */
static JSValue isl_host_digest(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *alg = JS_ToCString(ctx, argv[0]);
  if (!alg) return JS_EXCEPTION;
  size_t len = 0;
  uint8_t *data = JS_GetUint8Array(ctx, &len, argv[1]);
  if (!data && len) {
    JS_FreeCString(ctx, alg);
    return JS_EXCEPTION;
  }
  unsigned char out[32];
  size_t n = scr_crypto_digest_raw(alg, data, len, out);
  JS_FreeCString(ctx, alg);
  return n == 0 ? JS_UNDEFINED : JS_NewUint8ArrayCopy(ctx, out, n);
}

static JSValue isl_host_hmac(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  const char *alg = JS_ToCString(ctx, argv[0]);
  if (!alg) return JS_EXCEPTION;
  size_t keylen = 0;
  size_t len = 0;
  uint8_t *key = JS_GetUint8Array(ctx, &keylen, argv[1]);
  uint8_t *data = JS_GetUint8Array(ctx, &len, argv[2]);
  if ((!key && keylen) || (!data && len)) {
    JS_FreeCString(ctx, alg);
    return JS_EXCEPTION;
  }
  unsigned char out[32];
  size_t n = scr_crypto_hmac_raw(alg, key, keylen, data, len, out);
  JS_FreeCString(ctx, alg);
  return n == 0 ? JS_UNDEFINED : JS_NewUint8ArrayCopy(ctx, out, n);
}

static JSValue isl_host_pid(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* Node's process.pid — util.deprecate/debuglog print it in their
   * stderr prefixes. mingw-w64's process.h declares getpid too. */
  return JS_NewInt32(ctx, (int32_t)getpid());
}

/* process.version(s) — the SAME compat-target answers the static world's
 * process.versions gives (scr_lib.c), as [node, openssl]. */
static JSValue isl_host_versions(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *node = scr_process_versions_node();
  ScrStr *openssl = scr_process_versions_openssl();
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewStringLen(ctx, node->data, node->len));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewStringLen(ctx, openssl->data, openssl->len));
  scr_str_release(node);
  scr_str_release(openssl);
  return arr;
}

/* process.hrtime's monotonic nanosecond clock, as [seconds, nanos]. */
static JSValue isl_host_hrtime(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  double ms = scr_now_ms();
  JSValue arr = JS_NewArray(ctx);
  double sec = ms / 1000.0;
  double whole = (double)(int64_t)sec;
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewFloat64(ctx, whole));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewFloat64(ctx, (double)(int64_t)((sec - whole) * 1e9)));
  return arr;
}

/* os.userInfo's uid/gid halves (-1 on win32, like Node). */
static JSValue isl_host_ids(JSContext *ctx, JSValueConst this_val, int argc,
                            JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  JSValue arr = JS_NewArray(ctx);
#if defined(_WIN32) || defined(__wasi__)
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, -1));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, -1));
#else
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, (int32_t)getuid()));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, (int32_t)getgid()));
#endif
  return arr;
}

/* os.constants' signals table: the REAL signal numbers of the target. */
/* process.umask() — the read form: read-and-restore on POSIX; Node on
 * Windows answers 0 (no umask concept behind CreateFile). */
static JSValue isl_host_umask(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
#if defined(_WIN32) || defined(__wasi__)
  return JS_NewInt32(ctx, 0);
#else
  mode_t m = umask(0);
  umask(m);
  return JS_NewInt32(ctx, (int32_t)m);
#endif
}

static JSValue isl_host_signals(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  JSValue o = JS_NewObject(ctx);
#define ISL_SIG(name) JS_SetPropertyStr(ctx, o, #name, JS_NewInt32(ctx, name))
#ifdef SIGHUP
  ISL_SIG(SIGHUP);
#endif
  ISL_SIG(SIGINT);
#ifdef SIGQUIT
  ISL_SIG(SIGQUIT);
#endif
  ISL_SIG(SIGILL);
#ifdef SIGTRAP
  ISL_SIG(SIGTRAP);
#endif
  ISL_SIG(SIGABRT);
  ISL_SIG(SIGFPE);
#ifdef SIGKILL
  ISL_SIG(SIGKILL);
#endif
#ifdef SIGBUS
  ISL_SIG(SIGBUS);
#endif
  ISL_SIG(SIGSEGV);
#ifdef SIGSYS
  ISL_SIG(SIGSYS);
#endif
#ifdef SIGPIPE
  ISL_SIG(SIGPIPE);
#endif
#ifdef SIGALRM
  ISL_SIG(SIGALRM);
#endif
  ISL_SIG(SIGTERM);
#ifdef SIGURG
  ISL_SIG(SIGURG);
#endif
#ifdef SIGSTOP
  ISL_SIG(SIGSTOP);
#endif
#ifdef SIGTSTP
  ISL_SIG(SIGTSTP);
#endif
#ifdef SIGCONT
  ISL_SIG(SIGCONT);
#endif
#ifdef SIGCHLD
  ISL_SIG(SIGCHLD);
#endif
#ifdef SIGTTIN
  ISL_SIG(SIGTTIN);
#endif
#ifdef SIGTTOU
  ISL_SIG(SIGTTOU);
#endif
#ifdef SIGIO
  ISL_SIG(SIGIO);
#endif
#ifdef SIGXCPU
  ISL_SIG(SIGXCPU);
#endif
#ifdef SIGXFSZ
  ISL_SIG(SIGXFSZ);
#endif
#ifdef SIGVTALRM
  ISL_SIG(SIGVTALRM);
#endif
#ifdef SIGPROF
  ISL_SIG(SIGPROF);
#endif
#ifdef SIGWINCH
  ISL_SIG(SIGWINCH);
#endif
#ifdef SIGUSR1
  ISL_SIG(SIGUSR1);
#endif
#ifdef SIGUSR2
  ISL_SIG(SIGUSR2);
#endif
#undef ISL_SIG
  return o;
}

/* util.inspect's promise peek: [state, result] (0 pending / 1 fulfilled /
 * 2 rejected), undefined for a non-promise. JS has no synchronous view of
 * promise state; the engine does (JS_PromiseState), and Node's inspect
 * prints it — so the shim asks the host. Peeking never marks a rejection
 * handled (the tracker fired at reject time; nothing here rescinds it). */
static JSValue isl_host_promise_state(JSContext *ctx, JSValueConst this_val, int argc,
                                      JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  JSPromiseStateEnum st = JS_PromiseState(ctx, argv[0]);
  if ((int)st < 0) return JS_UNDEFINED;
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, (int32_t)st));
  JS_SetPropertyUint32(ctx, arr, 1,
                       st == JS_PROMISE_PENDING ? JS_UNDEFINED
                                                : JS_PromiseResult(ctx, argv[0]));
  return arr;
}

static JSValue isl_host_hostname(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  /* Node's os.hostname() is uv_os_gethostname — gethostname(2). On win32
   * that is winsock's gethostname, which answers WSANOTINITIALISED until
   * someone starts winsock (Node does at boot) — start it here, OS-ref-
   * counted like the socket units' own WSAStartup calls (ws2_32 is on
   * every win32 link line). */
  char buf[256];
#if defined(__wasi__)
  buf[0] = '\0';
#else
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return JS_NewString(ctx, "");
#endif
  if (gethostname(buf, sizeof buf) != 0) buf[0] = '\0';
#endif
  buf[sizeof buf - 1] = '\0';
  return JS_NewString(ctx, buf);
}

/* The bootstrap: the CommonJS require shim over the embedded map, the
 * builtin shims, and the real process bridge. Evaluated once (module boot);
 * returns the CJS import helper the boundary below pins. Everything JS
 * about the module system lives in this string — the C side only serves
 * tables and I/O. */
static const char isl_modules_bootstrap[] =
    "(host) => {\n"
    "  'use strict';\n"
    /* The WebAssembly DECISION (SEMANTICS.md, island section): the engine
     * has no wasm runtime, and pretending otherwise is banned. Embedded
     * JS that references WebAssembly (Emscripten factory modules load
     * fine — they are plain JS — and reach WebAssembly.instantiate only
     * when INVOKED) must fail honestly and catchably: a throwing stub
     * with a clear message, plus real Error subclasses for the error
     * types, so Emscripten's own abort path (`new
     * WebAssembly.RuntimeError("Aborted(...)")` inside its catch) still
     * constructs and the factory's ready promise rejects with the
     * Emscripten-shaped error carrying this message — the most
     * Node-plausible catchable failure. validate() answers false, the
     * feature-detection truth. The PROMISE-shaped members (compile/
     * instantiate/-Streaming) REJECT instead of throwing synchronously —
     * the real API's shape (invalid bytes reject, never throw), which
     * keeps eval-time compiles lazy exactly as they are under Node: a
     * module whose top level starts `WebAssembly.compile(...)` (es-module-
     * lexer's `export const init`, undici's lazyllhttp) evaluates fine
     * and fails only where the promise is AWAITED — the code path that
     * actually needed wasm, often behind a feature-detect or fallback
     * catch. The constructor-shaped members stay synchronous throws (so
     * does `new Module()` under real wasm on bad bytes). */
    "  if (typeof globalThis.WebAssembly === 'undefined') {\n"
    "    const die = (what) => () => {\n"
    "      throw new Error('WebAssembly.' + what + ' is not supported in scriptc binaries (the embedded engine has no wasm runtime)');\n"
    "    };\n"
    /* The reason carries the __scr_wasm_stub marker (non-enumerable):
     * the rejection tracker below SKIPS ledgering it, so a top-level
     * `WebAssembly.compile(...)` chain the program never awaits (es-
     * module-lexer's `export const init`, alive in real CLI
     * graph) stays silent at teardown — under real wasm the compile
     * SUCCEEDS unobserved, so silence is Node's observable — while an
     * actual await site still sees the rejection untouched. The marker
     * must ride the REASON, not the promise: .then() chains derive new
     * unhandled promises carrying the same reason object. */
    "    const dieAsync = (what) => () => {\n"
    "      const e = new Error('WebAssembly.' + what + ' is not supported in scriptc binaries (the embedded engine has no wasm runtime)');\n"
    "      Object.defineProperty(e, '__scr_wasm_stub', { value: true });\n"
    "      return Promise.reject(e);\n"
    "    };\n"
    "    class RuntimeError extends Error {}\n"
    "    class CompileError extends Error {}\n"
    "    class LinkError extends Error {}\n"
    "    RuntimeError.prototype.name = 'RuntimeError';\n"
    "    CompileError.prototype.name = 'CompileError';\n"
    "    LinkError.prototype.name = 'LinkError';\n"
    "    globalThis.WebAssembly = {\n"
    "      instantiate: dieAsync('instantiate'),\n"
    "      instantiateStreaming: dieAsync('instantiateStreaming'),\n"
    "      compile: dieAsync('compile'),\n"
    "      compileStreaming: dieAsync('compileStreaming'),\n"
    "      validate: () => false,\n"
    "      Module: die('Module'),\n"
    "      Instance: die('Instance'),\n"
    "      Memory: die('Memory'),\n"
    "      Table: die('Table'),\n"
    "      Global: die('Global'),\n"
    "      RuntimeError, CompileError, LinkError,\n"
    "    };\n"
    "  }\n"
    "  const cache = Object.create(null);\n"
    "  const builtins = Object.create(null);\n"
    /* Node's require stack: each CJS module remembers its FIRST requirer
     * (Node's module.parent / moduleParentCache — the chain is static,
     * captured at first load, not the dynamic call stack), and a failing
     * resolution reports the requiring module plus its parent chain.
     * Entry modules loaded from the compiled (ESM-like) world have no
     * parent, exactly like Node's ESM→CJS boundary. */
    "  const parents = Object.create(null);\n"
    "  const requireStackOf = (from) => {\n"
    "    const stack = [];\n"
    "    for (let m = from; m !== undefined; m = parents[m]) stack.push(m);\n"
    "    return stack;\n"
    "  };\n"
    /* Node resolves core modules unconditionally, before node_modules
     * and never through file edges — so a require the build-time walk
     * could not see (a non-literal specifier) still reaches the shims
     * here. Everything else unresolved throws Node's require-time
     * MODULE_NOT_FOUND shape, surfacing lazily at the CALL, which is the
     * only point Node would have loaded the module either: the message
     * carries the live Require stack, plus the code and requireStack
     * properties. (Unshimmed BUILTINS reached by build-time-visible lazy
     * edges resolve through the edge table to their node: keys and take
     * requireKey's does-not-provide throw below instead.) */
    "  const resolveFrom = (from, spec) => {\n"
    "    const to = host.resolve(from, spec);\n"
    "    if (to === undefined) {\n"
    "      const name = spec.startsWith('node:') ? spec.slice(5) : spec;\n"
    "      if (builtins[name]) return 'node:' + name;\n"
    "      const stack = requireStackOf(from);\n"
    "      const err = new Error(\"Cannot find module '\" + spec + \"'\" +\n"
    "        (stack.length ? '\\nRequire stack:\\n- ' + stack.join('\\n- ') : ''));\n"
    "      err.code = 'MODULE_NOT_FOUND';\n"
    "      err.requireStack = stack;\n"
    "      throw err;\n"
    "    }\n"
    "    return to;\n"
    "  };\n"
    "  const requireKey = (key, parent) => {\n"
    "    if (key.startsWith('node:')) {\n"
    "      const b = builtins[key.slice(5)];\n"
    "      if (!b) throw new Error(\"the island does not provide the '\" + key + \"' builtin\");\n"
    "      return b();\n"
    "    }\n"
    "    const hit = cache[key];\n"
    "    if (hit) return hit.exports;\n"
    "    const info = host.source(key);\n"
    "    if (info === undefined) throw new Error(\"module '\" + key + \"' is not embedded\");\n"
    "    const src = info[0], format = info[1];\n"
    "    const mod = { exports: {} };\n"
    "    cache[key] = mod;\n"
    "    if (parent !== undefined && !(key in parents)) parents[key] = parent;\n"
    "    if (format === 2) { mod.exports = JSON.parse(src); return mod.exports; }\n"
    "    if (format === 0) { delete cache[key]; throw new Error('require() of ES module ' + key); }\n"
    "    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src);\n"
    "    const req = (spec) => requireKey(resolveFrom(key, spec), key);\n"
    "    req.cache = cache;\n"
    "    const dir = key.slice(0, key.lastIndexOf('/')) || '/';\n"
    /* A module whose evaluation THROWS leaves no cache entry — Node
     * deletes it so a later require re-evaluates (and a lazy require
     * trap throws EVERY time instead of answering {} on the retry). */
    "    try {\n"
    "      fn.call(mod.exports, mod.exports, req, mod, key, dir);\n"
    "    } catch (e) {\n"
    "      delete cache[key];\n"
    "      delete parents[key];\n"
    "      throw e;\n"
    "    }\n"
    "    return mod.exports;\n"
    "  };\n"
    "  const memo = (f) => { let v; return () => (v === undefined ? (v = f()) : v); };\n"
    /* Node's events module: the emitter surface streams and CLIs drive —
     * prepend/once/remove with listener-unwrap, maxListeners bookkeeping
     * (warnings are not emitted), eventNames/rawListeners, Node's
     * unhandled-'error' throw, and the once/getEventListeners statics. */
    "  builtins.events = memo(() => {\n"
    "    class EventEmitter {\n"
    "      constructor() { this._events = Object.create(null); this._maxListeners = undefined; }\n"
    "      _add(n, f, prepend) {\n"
    "        if (typeof f !== 'function') {\n"
    "          const e = new TypeError('The \"listener\" argument must be of type function. Received ' + (f === null ? 'null' : typeof f));\n"
    "          e.code = 'ERR_INVALID_ARG_TYPE';\n"
    "          throw e;\n"
    "        }\n"
    "        this.emit('newListener', n, f.listener !== undefined ? f.listener : f);\n"
    "        const a = this._events[n] = this._events[n] || [];\n"
    "        if (prepend) a.unshift(f); else a.push(f);\n"
    "        return this;\n"
    "      }\n"
    "      on(n, f) { return this._add(n, f, false); }\n"
    "      addListener(n, f) { return this.on(n, f); }\n"
    "      prependListener(n, f) { return this._add(n, f, true); }\n"
    "      _wrapOnce(n, f) {\n"
    "        const g = (...a) => { this.removeListener(n, g); f.apply(this, a); };\n"
    "        g.listener = f;\n"
    "        return g;\n"
    "      }\n"
    "      once(n, f) { return this._add(n, this._wrapOnce(n, f), false); }\n"
    "      prependOnceListener(n, f) { return this._add(n, this._wrapOnce(n, f), true); }\n"
    "      removeListener(n, f) {\n"
    "        const a = this._events[n];\n"
    "        if (a) {\n"
    "          const i = a.findIndex((x) => x === f || x.listener === f);\n"
    "          if (i >= 0) {\n"
    "            const x = a[i];\n"
    "            a.splice(i, 1);\n"
    "            if (a.length === 0) delete this._events[n];\n"
    "            this.emit('removeListener', n, x.listener !== undefined ? x.listener : x);\n"
    "          }\n"
    "        }\n"
    "        return this;\n"
    "      }\n"
    "      off(n, f) { return this.removeListener(n, f); }\n"
    "      removeAllListeners(n) {\n"
    "        if (n === undefined) this._events = Object.create(null);\n"
    "        else delete this._events[n];\n"
    "        return this;\n"
    "      }\n"
    "      setMaxListeners(m) { this._maxListeners = m; return this; }\n"
    "      getMaxListeners() { return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners; }\n"
    "      emit(n, ...args) {\n"
    "        const a = this._events[n];\n"
    "        if (!a || a.length === 0) {\n"
    "          if (n === 'error') {\n"
    /* Node throws the unhandled error payload (or a synthetic one) —
     * inside the island this crosses the bridge like any engine throw. */
    "            const err = args[0];\n"
    "            if (err instanceof Error) throw err;\n"
    "            const e = new Error(\"Unhandled error.\" + (err === undefined ? '' : ' (' + String(err) + ')'));\n"
    "            e.code = 'ERR_UNHANDLED_ERROR';\n"
    "            e.context = err;\n"
    "            throw e;\n"
    "          }\n"
    "          return false;\n"
    "        }\n"
    "        for (const f of a.slice()) f.apply(this, args);\n"
    "        return true;\n"
    "      }\n"
    "      listenerCount(n) { const a = this._events[n]; return a ? a.length : 0; }\n"
    "      listeners(n) {\n"
    "        const a = this._events[n];\n"
    "        return a ? a.map((x) => (x.listener !== undefined ? x.listener : x)) : [];\n"
    "      }\n"
    "      rawListeners(n) { const a = this._events[n]; return a ? a.slice() : []; }\n"
    "      eventNames() { return Object.keys(this._events); }\n"
    "    }\n"
    "    EventEmitter.defaultMaxListeners = 10;\n"
    "    EventEmitter.errorMonitor = Symbol('events.errorMonitor');\n"
    "    EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');\n"
    "    EventEmitter.listenerCount = (emitter, n) => emitter.listenerCount(n);\n"
    "    EventEmitter.getEventListeners = (emitter, n) => emitter.listeners(n);\n"
    "    EventEmitter.setMaxListeners = (m, ...emitters) => { for (const e of emitters) e.setMaxListeners(m); };\n"
    "    EventEmitter.once = (emitter, name) => new Promise((resolve, reject) => {\n"
    "      const onEvent = (...args) => {\n"
    "        emitter.removeListener('error', onError);\n"
    "        resolve(args);\n"
    "      };\n"
    "      const onError = (err) => {\n"
    "        emitter.removeListener(name, onEvent);\n"
    "        reject(err);\n"
    "      };\n"
    "      emitter.once(name, onEvent);\n"
    "      if (name !== 'error') emitter.once('error', onError);\n"
    "    });\n"
    "    EventEmitter.EventEmitter = EventEmitter;\n"
    "    EventEmitter.default = EventEmitter;\n"
    "    return EventEmitter;\n"
    "  });\n"
    /* node:path — the bare module binds by TARGET (Node on Windows IS
     * path.win32) and both namespaces are always available; every
     * member except parse/format rides scr_path.c's byte-exact ports
     * through the host path hook, parse/format are Node v24's
     * algorithms ported here. */
    "  builtins.path = memo(() => {\n"
    "const CHAR_DOT = \".\";\n"
    "const isSepP = (c) => c === \"/\";\n"
    "const isSepW = (c) => c === \"/\" || c === \"\\\\\";\n"
    "const isLetter = (c) => (c >= \"a\" && c <= \"z\") || (c >= \"A\" && c <= \"Z\");\n"
    "function parsePosix(path) {\n"
    "  if (typeof path !== \"string\") {\n"
    "    const e = new TypeError('The \"path\" argument must be of type string. Received ' + (path === null ? \"null\" : typeof path === \"object\" ? \"an instance of \" + ((path.constructor && path.constructor.name) || \"Object\") : \"type \" + typeof path + \" (\" + JSON.stringify(path) + \")\"));\n"
    "    e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "    throw e;\n"
    "  }\n"
    "  const ret = { root: \"\", dir: \"\", base: \"\", ext: \"\", name: \"\" };\n"
    "  if (path.length === 0) return ret;\n"
    "  const isAbs = path[0] === \"/\";\n"
    "  let start;\n"
    "  if (isAbs) {\n"
    "    ret.root = \"/\";\n"
    "    start = 1;\n"
    "  } else {\n"
    "    start = 0;\n"
    "  }\n"
    "  let startDot = -1;\n"
    "  let startPart = 0;\n"
    "  let end = -1;\n"
    "  let matchedSlash = true;\n"
    "  let preDotState = 0;\n"
    "  for (let i = path.length - 1; i >= start; --i) {\n"
    "    const ch = path[i];\n"
    "    if (isSepP(ch)) {\n"
    "      if (!matchedSlash) {\n"
    "        startPart = i + 1;\n"
    "        break;\n"
    "      }\n"
    "      continue;\n"
    "    }\n"
    "    if (end === -1) {\n"
    "      matchedSlash = false;\n"
    "      end = i + 1;\n"
    "    }\n"
    "    if (ch === CHAR_DOT) {\n"
    "      if (startDot === -1) startDot = i;\n"
    "      else if (preDotState !== 1) preDotState = 1;\n"
    "    } else if (startDot !== -1) {\n"
    "      preDotState = -1;\n"
    "    }\n"
    "  }\n"
    "  if (end !== -1) {\n"
    "    const s = startPart === 0 && isAbs ? 1 : startPart;\n"
    "    if (startDot === -1 || preDotState === 0 ||\n"
    "        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {\n"
    "      ret.base = ret.name = path.slice(s, end);\n"
    "    } else {\n"
    "      ret.name = path.slice(s, startDot);\n"
    "      ret.base = path.slice(s, end);\n"
    "      ret.ext = path.slice(startDot, end);\n"
    "    }\n"
    "  }\n"
    "  if (startPart > 0) ret.dir = path.slice(0, startPart - 1);\n"
    "  else if (isAbs) ret.dir = \"/\";\n"
    "  return ret;\n"
    "}\n"
    "function parseWin32(path) {\n"
    "  if (typeof path !== \"string\") {\n"
    "    const e = new TypeError('The \"path\" argument must be of type string. Received ' + (path === null ? \"null\" : typeof path === \"object\" ? \"an instance of \" + ((path.constructor && path.constructor.name) || \"Object\") : \"type \" + typeof path + \" (\" + JSON.stringify(path) + \")\"));\n"
    "    e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "    throw e;\n"
    "  }\n"
    "  const ret = { root: \"\", dir: \"\", base: \"\", ext: \"\", name: \"\" };\n"
    "  if (path.length === 0) return ret;\n"
    "  const len = path.length;\n"
    "  let rootEnd = 0;\n"
    "  let ch = path[0];\n"
    "  if (len === 1) {\n"
    "    if (isSepW(ch)) {\n"
    "      ret.root = ret.dir = path;\n"
    "      return ret;\n"
    "    }\n"
    "    ret.base = ret.name = path;\n"
    "    return ret;\n"
    "  }\n"
    "  if (isSepW(ch)) {\n"
    "    rootEnd = 1;\n"
    "    if (isSepW(path[1])) {\n"
    "      let j = 2;\n"
    "      let last = j;\n"
    "      while (j < len && !isSepW(path[j])) j++;\n"
    "      if (j < len && j !== last) {\n"
    "        last = j;\n"
    "        while (j < len && isSepW(path[j])) j++;\n"
    "        if (j < len && j !== last) {\n"
    "          last = j;\n"
    "          while (j < len && !isSepW(path[j])) j++;\n"
    "          if (j === len) rootEnd = j;\n"
    "          else if (j !== last) rootEnd = j + 1;\n"
    "        }\n"
    "      }\n"
    "    }\n"
    "  } else if (isLetter(ch) && path[1] === \":\") {\n"
    "    if (len <= 2) {\n"
    "      ret.root = ret.dir = path;\n"
    "      return ret;\n"
    "    }\n"
    "    rootEnd = 2;\n"
    "    if (isSepW(path[2])) {\n"
    "      if (len === 3) {\n"
    "        ret.root = ret.dir = path;\n"
    "        return ret;\n"
    "      }\n"
    "      rootEnd = 3;\n"
    "    }\n"
    "  }\n"
    "  if (rootEnd > 0) ret.root = path.slice(0, rootEnd);\n"
    "  let startDot = -1;\n"
    "  let startPart = rootEnd;\n"
    "  let end = -1;\n"
    "  let matchedSlash = true;\n"
    "  let i = path.length - 1;\n"
    "  let preDotState = 0;\n"
    "  for (; i >= rootEnd; --i) {\n"
    "    ch = path[i];\n"
    "    if (isSepW(ch)) {\n"
    "      if (!matchedSlash) {\n"
    "        startPart = i + 1;\n"
    "        break;\n"
    "      }\n"
    "      continue;\n"
    "    }\n"
    "    if (end === -1) {\n"
    "      matchedSlash = false;\n"
    "      end = i + 1;\n"
    "    }\n"
    "    if (ch === CHAR_DOT) {\n"
    "      if (startDot === -1) startDot = i;\n"
    "      else if (preDotState !== 1) preDotState = 1;\n"
    "    } else if (startDot !== -1) {\n"
    "      preDotState = -1;\n"
    "    }\n"
    "  }\n"
    "  if (end !== -1) {\n"
    "    if (startDot === -1 || preDotState === 0 ||\n"
    "        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {\n"
    "      ret.base = ret.name = path.slice(startPart, end);\n"
    "    } else {\n"
    "      ret.name = path.slice(startPart, startDot);\n"
    "      ret.base = path.slice(startPart, end);\n"
    "      ret.ext = path.slice(startDot, end);\n"
    "    }\n"
    "  }\n"
    "  if (startPart > 0 && startPart !== rootEnd) ret.dir = path.slice(0, startPart - 1);\n"
    "  else ret.dir = ret.root;\n"
    "  return ret;\n"
    "}\n"
    "function makeFormat(sep) {\n"
    "  return (obj) => {\n"
    "    if (obj === null || typeof obj !== \"object\") {\n"
    "      const e = new TypeError('The \"pathObject\" argument must be of type object. Received ' + (obj === null ? \"null\" : \"type \" + typeof obj + \" (\" + JSON.stringify(obj) + \")\"));\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    const dir = obj.dir || obj.root;\n"
    "    const base = obj.base || ((obj.name || \"\") + (obj.ext || \"\"));\n"
    "    if (!dir) return base;\n"
    "    return dir === obj.root ? dir + base : dir + sep + base;\n"
    "  };\n"
    "}\n"
    "    const badPath = (p) => {\n"
    "      const t = p === null ? 'null' : typeof p === 'object' ? 'an instance of ' + ((p.constructor && p.constructor.name) || 'Object') : 'type ' + typeof p + ' (' + String(p) + ')';\n"
    "      const e = new TypeError('The \"path\" argument must be of type string. Received ' + t);\n"
    "      e.code = 'ERR_INVALID_ARG_TYPE';\n"
    "      return e;\n"
    "    };\n"
    "    const str = (p) => {\n"
    "      if (typeof p !== 'string') throw badPath(p);\n"
    "      return p;\n"
    "    };\n"
    "    const mkFamily = (w) => {\n"
    "      const sep = w ? '\\\\' : '/';\n"
    "      const P = {\n"
    "        sep,\n"
    "        delimiter: w ? ';' : ':',\n"
    "        join: (...parts) => host.path('join', w, parts.map(str)),\n"
    "        resolve: (...parts) => host.path('resolve', w, parts.map(str)),\n"
    "        normalize: (p) => host.path('normalize', w, str(p)),\n"
    "        dirname: (p) => host.path('dirname', w, str(p)),\n"
    "        basename: (p, suffix) => host.path('basename', w, str(p), suffix === undefined ? '' : str(suffix)),\n"
    "        extname: (p) => host.path('extname', w, str(p)),\n"
    "        isAbsolute: (p) => host.path('isAbsolute', w, str(p)),\n"
    "        relative: (from, to) => host.path('relative', w, str(from), str(to)),\n"
    "        toNamespacedPath: (p) => (typeof p === 'string' ? host.path('toNamespacedPath', w, p) : p),\n"
    "        parse: w ? parseWin32 : parsePosix,\n"
    "        format: makeFormat(sep),\n"
    "      };\n"
    "      return P;\n"
    "    };\n"
    "    const posix = mkFamily(false);\n"
    "    const win32 = mkFamily(true);\n"
    "    posix.posix = win32.posix = posix;\n"
    "    posix.win32 = win32.win32 = win32;\n"
    "    const p = host.platform() === 'win32' ? win32 : posix;\n"
    "    p.default = p;\n"
    "    return p;\n"
    "  });\n"
    /* node:path/posix and node:path/win32 are the namespaces
     * themselves. */
    "  builtins['path/posix'] = memo(() => {\n"
    "    const p = builtins.path().posix;\n"
    "    p.default = p;\n"
    "    return p;\n"
    "  });\n"
    "  builtins['path/win32'] = memo(() => {\n"
    "    const p = builtins.path().win32;\n"
    "    p.default = p;\n"
    "    return p;\n"
    "  });\n"
    /* node:fs (+ fs/promises) — the host fs bridge over the SAME
     * scr_fs_* implementations the static lowerings call: sync,
     * callback, and promises spellings (the I/O is synchronous;
     * callbacks/promises settle on the microtask queue), Stats/
     * Dirent shaping, and memory-backed create*Stream. Errors arrive
     * Node-shaped with the errno-name code. */
    "  builtins.fs = memo(() => {\n"
    "function makeFs(env) {\n"
    "  const Buffer = env.Buffer;\n"
    "  const constants = env.fsConstants();\n"
    "  const call = env.fs;\n"
    "  const pathOf = (p) => {\n"
    "    if (typeof p === \"string\") return p;\n"
    "    if (p instanceof Uint8Array) return Buffer.from(p).toString(\"utf8\");\n"
    "    if (p !== null && typeof p === \"object\" && typeof p.href === \"string\" && p.href.startsWith(\"file://\")) {\n"
    "      return decodeURIComponent(p.href.slice(7));\n"
    "    }\n"
    "    const e = new TypeError('The \"path\" argument must be of type string or an instance of Buffer or URL. Received ' + (p === null ? \"null\" : typeof p === \"object\" ? \"an instance of \" + ((p.constructor && p.constructor.name) || \"Object\") : \"type \" + typeof p + \" (\" + JSON.stringify(p) + \")\"));\n"
    "    e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "    throw e;\n"
    "  };\n"
    "  const encodingOf = (options, def) => {\n"
    "    if (options === undefined || options === null) return def;\n"
    "    if (typeof options === \"string\") return options;\n"
    "    return options.encoding !== undefined && options.encoding !== null ? options.encoding : def;\n"
    "  };\n"
    "  const dataToU8 = (data, options) => {\n"
    "    if (typeof data === \"string\") return Buffer.from(data, encodingOf(options, \"utf8\"));\n"
    "    if (data instanceof Uint8Array) return data;\n"
    "    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);\n"
    "    const e = new TypeError('The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + (data === null ? \"null\" : typeof data === \"object\" ? \"an instance of \" + ((data.constructor && data.constructor.name) || \"Object\") : \"type \" + typeof data));\n"
    "    e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "    throw e;\n"
    "  };\n"
    "  class Stats {\n"
    "    constructor(row) {\n"
    "      this._f = row[0];\n"
    "      this._d = row[1];\n"
    "      this._l = row[2];\n"
    "      this.size = row[3];\n"
    "      this.mtimeMs = row[4];\n"
    "      this.blocks = row[5];\n"
    "      this.nlink = row[6];\n"
    "      this.atimeMs = row[7];\n"
    "      this.atime = new Date(row[7]);\n"
    "      this.mtime = new Date(row[4]);\n"
    "      this.mode = (this._f ? constants.S_IFREG : this._d ? constants.S_IFDIR : this._l ? (constants.S_IFLNK || 0) : 0);\n"
    "    }\n"
    "    isFile() { return this._f; }\n"
    "    isDirectory() { return this._d; }\n"
    "    isSymbolicLink() { return this._l; }\n"
    "    isBlockDevice() { return false; }\n"
    "    isCharacterDevice() { return false; }\n"
    "    isFIFO() { return false; }\n"
    "    isSocket() { return false; }\n"
    "  }\n"
    "  class Dirent {\n"
    "    constructor(name, kind, parentPath) {\n"
    "      this.name = name;\n"
    "      this.parentPath = parentPath;\n"
    "      this.path = parentPath;\n"
    "      this._kind = kind;\n"
    "    }\n"
    "    isFile() { return this._kind === 1; }\n"
    "    isDirectory() { return this._kind === 2; }\n"
    "    isSymbolicLink() { return this._kind === 3; }\n"
    "    isFIFO() { return this._kind === 4; }\n"
    "    isSocket() { return this._kind === 5; }\n"
    "    isCharacterDevice() { return this._kind === 6; }\n"
    "    isBlockDevice() { return this._kind === 7; }\n"
    "  }\n"
    "  const readFileSync = (p, options) => {\n"
    "    const u8 = call(\"readFile\", pathOf(p));\n"
    "    const enc = encodingOf(options, null);\n"
    "    const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.length);\n"
    "    return enc === null ? buf : buf.toString(enc);\n"
    "  };\n"
    "  const writeFileSync = (p, data, options) => {\n"
    "    call(\"writeFile\", pathOf(p), dataToU8(data, options));\n"
    "  };\n"
    "  const appendFileSync = (p, data, options) => {\n"
    "    call(\"appendFile\", pathOf(p), dataToU8(data, options));\n"
    "  };\n"
    "  const existsSync = (p) => {\n"
    "    try {\n"
    "      return call(\"exists\", pathOf(p));\n"
    "    } catch (e) {\n"
    "      return false;\n"
    "    }\n"
    "  };\n"
    "  const realpathSync = (p) => call(\"realpath\", pathOf(p));\n"
    "  realpathSync.native = realpathSync;\n"
    "  const mkdirSync = (p, options) => {\n"
    "    const recursive = !!(options && options.recursive);\n"
    "    const mode = options && options.mode !== undefined ? options.mode : -1;\n"
    "    call(\"mkdir\", pathOf(p), recursive ? 1 : 0, mode);\n"
    "    return undefined;\n"
    "  };\n"
    "  const rmSync = (p, options) => {\n"
    "    call(\"rm\", pathOf(p), options && options.recursive ? 1 : 0, options && options.force ? 1 : 0);\n"
    "  };\n"
    "  const rmdirSync = (p) => call(\"rmdir\", pathOf(p));\n"
    "  const unlinkSync = (p) => call(\"unlink\", pathOf(p));\n"
    "  const readdirSync = (p, options) => {\n"
    "    const path = pathOf(p);\n"
    "    if (options && options.withFileTypes) {\n"
    "      const flat = call(\"scandir\", path);\n"
    "      const out = [];\n"
    "      for (let i = 0; i < flat.length; i += 2) out.push(new Dirent(flat[i], flat[i + 1], path));\n"
    "      return out;\n"
    "    }\n"
    "    return call(\"readdir\", path);\n"
    "  };\n"
    "  const statSync = (p, options) => {\n"
    "    try {\n"
    "      return new Stats(call(\"stat\", pathOf(p)));\n"
    "    } catch (e) {\n"
    "      if (options && options.throwIfNoEntry === false && e.code === \"ENOENT\") return undefined;\n"
    "      throw e;\n"
    "    }\n"
    "  };\n"
    "  const lstatSync = (p, options) => {\n"
    "    try {\n"
    "      return new Stats(call(\"lstat\", pathOf(p)));\n"
    "    } catch (e) {\n"
    "      if (options && options.throwIfNoEntry === false && e.code === \"ENOENT\") return undefined;\n"
    "      throw e;\n"
    "    }\n"
    "  };\n"
    "  const accessSync = (p, mode) => call(\"access\", pathOf(p), mode === undefined ? constants.F_OK : mode);\n"
    "  const mkdtempSync = (prefix) => call(\"mkdtemp\", String(prefix));\n"
    "  const chmodSync = (p, mode) => call(\"chmod\", pathOf(p), mode);\n"
    "  const readlinkSync = (p) => call(\"readlink\", pathOf(p));\n"
    "  const copyFileSync = (src, dest) => call(\"copyFile\", pathOf(src), pathOf(dest));\n"
    "  const renameSync = (src, dest) => call(\"rename\", pathOf(src), pathOf(dest));\n"
    "  const sync = {\n"
    "    readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync,\n"
    "    mkdirSync, rmSync, rmdirSync, unlinkSync, readdirSync, statSync,\n"
    "    lstatSync, accessSync, mkdtempSync, chmodSync, copyFileSync, renameSync,\n"
    "    readlinkSync,\n"
    "  };\n"
    "  const callbackify = (syncFn) => (...args) => {\n"
    "    const cb = args.pop();\n"
    "    if (typeof cb !== \"function\") {\n"
    "      const e = new TypeError('The \"cb\" argument must be of type function. Received ' + (cb === undefined ? \"undefined\" : \"type \" + typeof cb));\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    let result;\n"
    "    try {\n"
    "      result = syncFn(...args);\n"
    "    } catch (err) {\n"
    "      env.nextTick(() => cb(err));\n"
    "      return;\n"
    "    }\n"
    "    env.nextTick(() => cb(null, result));\n"
    "  };\n"
    "  const promisify = (syncFn) => (...args) => new Promise((resolve, reject) => {\n"
    "    try {\n"
    "      resolve(syncFn(...args));\n"
    "    } catch (err) {\n"
    "      reject(err);\n"
    "    }\n"
    "  });\n"
    /* fs.ReadStream/fs.WriteStream: Node's module-level constructor names
     * (the `import { ReadStream } from "node:fs"` shape and the
     * `fs.ReadStream` CJS shape). Same whole-file-backed behavior the
     * createReadStream/createWriteStream factories always had; the
     * factories now construct these so instanceof agrees. */
    "  class ReadStream extends env.Readable {\n"
    "    constructor(p, options) {\n"
    "      const enc = typeof options === \"string\" ? options : options && options.encoding;\n"
    "      super({\n"
    "        read() {\n"
    "          if (this._started) return;\n"
    "          this._started = true;\n"
    "          try {\n"
    "            const buf = readFileSync(p);\n"
    "            for (let i = 0; i < buf.length; i += 65536) this.push(buf.subarray(i, Math.min(i + 65536, buf.length)));\n"
    "            this.push(null);\n"
    "          } catch (err) {\n"
    "            this.destroy(err);\n"
    "          }\n"
    "        },\n"
    "      });\n"
    "      if (enc) this.setEncoding(enc);\n"
    "      this.path = typeof p === \"string\" ? p : pathOf(p);\n"
    "    }\n"
    "  }\n"
    "  class WriteStream extends env.Writable {\n"
    "    constructor(p, options) {\n"
    "      const chunks = [];\n"
    "      super({\n"
    "        write(chunk, e, cb) {\n"
    "          chunks.push(chunk);\n"
    "          cb();\n"
    "        },\n"
    "        final(cb) {\n"
    "          try {\n"
    "            const flags = options && options.flags;\n"
    "            const data = Buffer.concat(chunks.map((c) => (typeof c === \"string\" ? Buffer.from(c) : c)));\n"
    "            if (flags === \"a\") appendFileSync(p, data);\n"
    "            else writeFileSync(p, data);\n"
    "            cb();\n"
    "          } catch (err) {\n"
    "            cb(err);\n"
    "          }\n"
    "        },\n"
    "      });\n"
    "      this.path = typeof p === \"string\" ? p : pathOf(p);\n"
    "    }\n"
    "  }\n"
    "  const fs = {\n"
    "    ...sync,\n"
    "    constants,\n"
    "    Stats,\n"
    "    Dirent,\n"
    "    ReadStream,\n"
    "    WriteStream,\n"
    "    readFile: callbackify(readFileSync),\n"
    "    writeFile: callbackify(writeFileSync),\n"
    "    appendFile: callbackify(appendFileSync),\n"
    "    exists: (p, cb) => {\n"
    "      env.nextTick(() => cb(existsSync(p)));\n"
    "    },\n"
    "    realpath: Object.assign(callbackify(realpathSync), { native: callbackify(realpathSync) }),\n"
    "    mkdir: callbackify(mkdirSync),\n"
    "    rm: callbackify(rmSync),\n"
    "    rmdir: callbackify(rmdirSync),\n"
    "    unlink: callbackify(unlinkSync),\n"
    "    readdir: callbackify(readdirSync),\n"
    "    stat: callbackify(statSync),\n"
    "    lstat: callbackify(lstatSync),\n"
    "    access: callbackify(accessSync),\n"
    "    mkdtemp: callbackify(mkdtempSync),\n"
    "    chmod: callbackify(chmodSync),\n"
    "    copyFile: callbackify(copyFileSync),\n"
    "    rename: callbackify(renameSync),\n"
    "    readlink: callbackify(readlinkSync),\n"
    "    createReadStream: (p, options) => new ReadStream(p, options),\n"
    "    createWriteStream: (p, options) => new WriteStream(p, options),\n"
    "    watch: () => {\n"
    "      throw new Error(\"fs.watch is not available in the scriptc island\");\n"
    "    },\n"
    "    watchFile: () => {\n"
    "      throw new Error(\"fs.watchFile is not available in the scriptc island\");\n"
    "    },\n"
    "    openSync: () => {\n"
    "      throw new Error(\"fs.openSync is not available in the scriptc island (whole-file reads/writes only)\");\n"
    "    },\n"
    "    closeSync: () => undefined,\n"
    "    readSync: () => {\n"
    "      throw new Error(\"fs.readSync is not available in the scriptc island (whole-file reads/writes only)\");\n"
    "    },\n"
    "    writeSync: () => {\n"
    "      throw new Error(\"fs.writeSync is not available in the scriptc island (whole-file reads/writes only)\");\n"
    "    },\n"
    "    read: () => {\n"
    "      throw new Error(\"fs.read is not available in the scriptc island (whole-file reads/writes only)\");\n"
    "    },\n"
    "    open: () => {\n"
    "      throw new Error(\"fs.open is not available in the scriptc island (whole-file reads/writes only)\");\n"
    "    },\n"
    "    unwatchFile: () => undefined,\n"
    "  };\n"
    "  fs.promises = {\n"
    "    readFile: promisify(readFileSync),\n"
    "    writeFile: promisify(writeFileSync),\n"
    "    appendFile: promisify(appendFileSync),\n"
    "    realpath: promisify(realpathSync),\n"
    "    mkdir: promisify(mkdirSync),\n"
    "    rm: promisify(rmSync),\n"
    "    rmdir: promisify(rmdirSync),\n"
    "    unlink: promisify(unlinkSync),\n"
    "    readdir: promisify(readdirSync),\n"
    "    stat: promisify(statSync),\n"
    "    lstat: promisify(lstatSync),\n"
    "    access: promisify(accessSync),\n"
    "    mkdtemp: promisify(mkdtempSync),\n"
    "    chmod: promisify(chmodSync),\n"
    "    copyFile: promisify(copyFileSync),\n"
    "    rename: promisify(renameSync),\n"
    "    readlink: promisify(readlinkSync),\n"
    "    constants,\n"
    "    open: () => {\n"
    "      return Promise.reject(new Error(\"fs.promises.open is not available in the scriptc island (whole-file reads/writes only)\"));\n"
    "    },\n"
    "  };\n"
    "  return fs;\n"
    "}\n"
    "    const fs = makeFs({ fs: (...a) => host.fs(...a), fsConstants: () => host.fsConstants(), Buffer: builtins.buffer().Buffer, Readable: builtins.stream().Readable, Writable: builtins.stream().Writable, nextTick: (fn) => queueMicrotask(fn) });\n"
    "    fs.default = fs;\n"
    "    return fs;\n"
    "  });\n"
    "  builtins['fs/promises'] = memo(() => {\n"
    "    const p = { ...builtins.fs().promises };\n"
    "    p.default = p;\n"
    "    return p;\n"
    "  });\n"
    "  builtins.os = memo(() => {\n"
    "    const plat = host.platform();\n"
    "    const os = {\n"
    "      EOL: plat === 'win32' ? '\\r\\n' : '\\n',\n"
    "      platform: () => plat,\n"
    "      arch: () => host.arch(),\n"
    "      hostname: () => host.hostname(),\n"
    "      homedir: () => host.homedir(),\n"
    "      tmpdir: () => host.tmpdir(),\n"
    "      type: () => (plat === 'darwin' ? 'Darwin' : plat === 'win32' ? 'Windows_NT' : 'Linux'),\n"
    "      endianness: () => 'LE',\n"
    "      userInfo: () => {\n"
    "        const ids = host.ids();\n"
    "        const env = builtins.process().env;\n"
    "        return {\n"
    "          uid: ids[0],\n"
    "          gid: ids[1],\n"
    "          username: env.USER || env.USERNAME || env.LOGNAME || '',\n"
    "          homedir: host.homedir(),\n"
    "          shell: plat === 'win32' ? null : env.SHELL || null,\n"
    "        };\n"
    "      },\n"
    /* The inert half: values Node reads from the kernel that the island
     * does not carry — empty-but-typed answers, never throws. */
    "      release: () => '',\n"
    "      version: () => '',\n"
    "      machine: () => (host.arch() === 'arm64' ? 'arm64' : host.arch() === 'x64' ? 'x86_64' : host.arch()),\n"
    "      cpus: () => [],\n"
    "      availableParallelism: () => 1,\n"
    "      totalmem: () => 0,\n"
    "      freemem: () => 0,\n"
    "      loadavg: () => [0, 0, 0],\n"
    "      uptime: () => 0,\n"
    "      networkInterfaces: () => ({}),\n"
    "      constants: {\n"
    "        signals: host.signals(),\n"
    "        errno: {},\n"
    "        priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },\n"
    "      },\n"
    "    };\n"
    "    os.default = os;\n"
    "    return os;\n"
    "  });\n"
    /* tty.isatty over the same host hook process.stdout.isTTY answers
     * with; Node returns false for anything but a non-negative integer
     * fd (never throws), so the guard mirrors that before asking the
     * real isatty(3). */
    "  builtins.tty = memo(() => {\n"
    "    const isatty = (fd) => Number.isInteger(fd) && fd >= 0 && host.isatty(fd);\n"
    "    class ReadStream {\n"
    "      constructor(fd) { this.fd = fd; this.isTTY = isatty(fd); this.isRaw = false; }\n"
    "      setRawMode(mode) { this.isRaw = !!mode; return this; }\n"
    "    }\n"
    "    class WriteStream {\n"
    "      constructor(fd) {\n"
    "        this.fd = fd;\n"
    "        this.isTTY = isatty(fd);\n"
    "        const c = host.columns(fd);\n"
    "        if (c > 0) this.columns = c;\n"
    "      }\n"
    "      write(s) { return host.write(this.fd, String(s)); }\n"
    "      getColorDepth() { return this.isTTY ? 8 : 1; }\n"
    "      hasColors(n) { return this.isTTY && (n === undefined || n <= 256); }\n"
    "      getWindowSize() { return [this.columns || 0, 0]; }\n"
    "      clearLine() { return true; }\n"
    "      clearScreenDown() { return true; }\n"
    "      cursorTo() { return true; }\n"
    "      moveCursor() { return true; }\n"
    "    }\n"
    "    const tty = { isatty, ReadStream, WriteStream };\n"
    "    tty.default = tty;\n"
    "    return tty;\n"
    "  });\n"
    "  builtins.diagnostics_channel = memo(() => {\n"
    /* Real pub/sub semantics for plain channels (publish with no
     * subscribers is a no-op, matching Node); tracingChannel reports
     * hasSubscribers=false and its trace* methods run the traced function
     * without publishing lifecycle events — the AI SDK checks
     * hasSubscribers and skips tracing, exactly the Node path when nothing
     * subscribed. */
    "    const channels = Object.create(null);\n"
    "    class Channel {\n"
    "      constructor(name) { this.name = name; this._subs = []; }\n"
    "      get hasSubscribers() { return this._subs.length > 0; }\n"
    "      subscribe(fn) { this._subs.push(fn); }\n"
    "      unsubscribe(fn) {\n"
    "        const i = this._subs.indexOf(fn);\n"
    "        if (i < 0) return false;\n"
    "        this._subs.splice(i, 1);\n"
    "        return true;\n"
    "      }\n"
    "      publish(msg) { for (const f of this._subs.slice()) f(msg, this.name); }\n"
    "    }\n"
    "    const channel = (name) => channels[name] || (channels[name] = new Channel(name));\n"
    "    const tracingChannel = (name) => ({\n"
    "      get hasSubscribers() {\n"
    "        if (typeof name !== 'string') return false;\n"
    "        for (const s of ['start', 'end', 'asyncStart', 'asyncEnd', 'error']) {\n"
    "          if (channel('tracing:' + name + ':' + s).hasSubscribers) return true;\n"
    "        }\n"
    "        return false;\n"
    "      },\n"
    "      traceSync(fn, ctx, thisArg, ...args) { return fn.apply(thisArg, args); },\n"
    "      tracePromise(fn, ctx, thisArg, ...args) { return fn.apply(thisArg, args); },\n"
    "      traceCallback(fn, position, ctx, thisArg, ...args) { return fn.apply(thisArg, args); },\n"
    "    });\n"
    "    const dc = {\n"
    "      channel,\n"
    "      subscribe: (name, fn) => { channel(name).subscribe(fn); },\n"
    "      unsubscribe: (name, fn) => channel(name).unsubscribe(fn),\n"
    "      hasSubscribers: (name) => channel(name).hasSubscribers,\n"
    "      tracingChannel,\n"
    "    };\n"
    "    dc.default = dc;\n"
    "    return dc;\n"
    "  });\n"
    "  builtins.module = memo(() => {\n"
    /* createRequire over the embedded tables: the base may be a file URL
     * or a plain path (Node accepts both — embedded module keys are
     * realpaths, import.meta.url is their file:// form); resolution walks
     * the base FILE's build-time edges and "node:" specifiers go straight
     * to the shims. The Emscripten factory pattern
     * (createRequire(import.meta.url) then require("node:fs")) works
     * end-to-end. */
    "    const createRequire = (base) => {\n"
    "      let key = String(base);\n"
    "      if (key.startsWith('file://')) key = decodeURIComponent(key.slice(7));\n"
    /* The base file is the created require's parent, like Node: modules
     * it loads report it in their require stacks. */
    "      const req = (spec) => requireKey(spec.startsWith('node:') ? spec : resolveFrom(key, spec), key);\n"
    "      req.cache = cache;\n"
    "      return req;\n"
    "    };\n"
    /* builtinModules/isBuiltin answer Node's QUESTION ("is this name a
     * Node builtin?") with Node's full list — resolution of unshimmed
     * ones still fails lazily at the call, the island's documented
     * shape. */
    "    const builtinModules = ['assert','assert/strict','async_hooks','buffer','child_process','cluster','console','constants','crypto','dgram','diagnostics_channel','dns','dns/promises','domain','events','fs','fs/promises','http','http2','https','inspector','inspector/promises','module','net','os','path','path/posix','path/win32','perf_hooks','process','punycode','querystring','readline','readline/promises','repl','stream','stream/consumers','stream/promises','stream/web','string_decoder','sys','timers','timers/promises','tls','trace_events','tty','url','util','util/types','v8','vm','wasi','worker_threads','zlib'];\n"
    "    const isBuiltin = (name) => {\n"
    "      const n = String(name);\n"
    "      return n.startsWith('node:') ? builtinModules.includes(n.slice(5)) : builtinModules.includes(n);\n"
    "    };\n"
    "    const m = {\n"
    "      createRequire,\n"
    "      builtinModules,\n"
    "      isBuiltin,\n"
    "      syncBuiltinESMExports: () => {},\n"
    "      register: () => {\n"
    "        throw new Error('module.register is not available in the scriptc island');\n"
    "      },\n"
    "      findSourceMap: () => undefined,\n"
    "    };\n"
    "    m.default = m;\n"
    "    return m;\n"
    "  });\n"
    "  builtins.url = memo(() => {\n"
    /* node:url — the URL/URLSearchParams globals plus the file-path
     * converters riding the static scr_url.c implementations (Node's
     * exact rules), and the legacy parse/format/resolve trio over the
     * WHATWG parser. */
    "    const fileURLToPath = (u) => {\n"
    "      const s = typeof u === 'object' && u !== null && 'href' in u ? String(u.href) : String(u);\n"
    "      return host.urlToPath(s);\n"
    "    };\n"
    "    const pathToFileURL = (p) => new globalThis.URL(host.urlFromPath(String(p)));\n"
    "    const parse = (input, parseQuery) => {\n"
    "      const out = { protocol: null, slashes: null, auth: null, host: null, port: null,\n"
    "        hostname: null, hash: null, search: null, query: null, pathname: null, path: null, href: String(input) };\n"
    "      let u = null;\n"
    "      try { u = new globalThis.URL(String(input)); } catch (e) { u = null; }\n"
    "      if (u !== null) {\n"
    "        out.protocol = u.protocol || null;\n"
    "        out.slashes = u.href.startsWith(u.protocol + '//') ? true : null;\n"
    "        out.auth = u.username !== '' ? (u.password !== '' ? u.username + ':' + u.password : u.username) : null;\n"
    "        out.host = u.host || null;\n"
    "        out.port = u.port !== '' ? u.port : null;\n"
    "        out.hostname = u.hostname || null;\n"
    "        out.hash = u.hash !== '' ? u.hash : null;\n"
    "        out.search = u.search !== '' ? u.search : null;\n"
    "        out.query = u.search !== '' ? u.search.slice(1) : null;\n"
    "        out.pathname = u.pathname || null;\n"
    "        out.path = (u.pathname || '') + (u.search || '') || null;\n"
    "        out.href = u.href;\n"
    "      } else {\n"
    "        let rest = String(input);\n"
    "        const hashAt = rest.indexOf('#');\n"
    "        if (hashAt >= 0) { out.hash = rest.slice(hashAt); rest = rest.slice(0, hashAt); }\n"
    "        const qAt = rest.indexOf('?');\n"
    "        if (qAt >= 0) { out.search = rest.slice(qAt); out.query = rest.slice(qAt + 1); rest = rest.slice(0, qAt); }\n"
    "        out.pathname = rest || null;\n"
    "        out.path = (rest || '') + (out.search || '') || null;\n"
    "      }\n"
    "      if (parseQuery) {\n"
    "        const q = {};\n"
    "        for (const [k, v] of new globalThis.URLSearchParams(out.query || '')) {\n"
    "          if (k in q) { if (Array.isArray(q[k])) q[k].push(v); else q[k] = [q[k], v]; }\n"
    "          else q[k] = v;\n"
    "        }\n"
    "        out.query = q;\n"
    "      }\n"
    "      return out;\n"
    "    };\n"
    "    const format = (obj) => {\n"
    "      if (typeof obj === 'string') return obj;\n"
    "      if (obj !== null && typeof obj === 'object' && typeof obj.href === 'string' && obj instanceof globalThis.URL) return obj.href;\n"
    "      const protocol = obj.protocol ? (obj.protocol.endsWith(':') ? obj.protocol : obj.protocol + ':') : '';\n"
    "      const host = obj.host !== undefined && obj.host !== null ? obj.host\n"
    "        : obj.hostname ? obj.hostname + (obj.port ? ':' + obj.port : '') : '';\n"
    "      const auth = obj.auth ? obj.auth + '@' : '';\n"
    "      const slashes = obj.slashes || host !== '' ? '//' : '';\n"
    "      let pathname = obj.pathname || '';\n"
    "      if (pathname !== '' && !pathname.startsWith('/') && host !== '') pathname = '/' + pathname;\n"
    "      let search = obj.search || (obj.query && typeof obj.query === 'object' ? '?' + new globalThis.URLSearchParams(obj.query).toString() : obj.query ? '?' + obj.query : '');\n"
    "      if (search !== '' && !search.startsWith('?')) search = '?' + search;\n"
    "      let hash = obj.hash || '';\n"
    "      if (hash !== '' && !hash.startsWith('#')) hash = '#' + hash;\n"
    "      return protocol + slashes + auth + host + pathname + search + hash;\n"
    "    };\n"
    "    const resolve = (from, to) => {\n"
    "      const u = new globalThis.URL(String(to), new globalThis.URL(String(from), 'resolve://'));\n"
    "      if (u.protocol === 'resolve:') return u.pathname + u.search + u.hash;\n"
    "      return u.href;\n"
    "    };\n"
    "    const u = {\n"
    "      URL: globalThis.URL,\n"
    "      URLSearchParams: globalThis.URLSearchParams,\n"
    "      fileURLToPath, pathToFileURL, parse, format, resolve,\n"
    /* IDNA is not carried: ASCII hostnames pass through lowercased
     * (documented divergence for internationalized domains). */
    "      domainToASCII: (d) => String(d).toLowerCase(),\n"
    "      domainToUnicode: (d) => String(d).toLowerCase(),\n"
    "      urlToHttpOptions: (u2) => ({ protocol: u2.protocol, hostname: u2.hostname, hash: u2.hash, search: u2.search, pathname: u2.pathname, path: u2.pathname + (u2.search || ''), href: u2.href, port: u2.port !== '' ? Number(u2.port) : undefined, host: u2.host }),\n"
    "    };\n"
    "    u.default = u;\n"
    "    return u;\n"
    "  });\n"
    /* node:buffer — Buffer as a Uint8Array subclass carrying Node's
     * surface (from/alloc/concat, the seven encodings, read/write
     * accessors, indexOf/fill/copy/swap, the <Buffer ..> custom
     * inspect), developed standalone and differentially tested
     * against real Node. Also exposed as the Buffer GLOBAL below,
     * exactly like Node. */
    "  builtins.buffer = memo(() => {\n"
    "function makeBuffer() {\n"
    "  const K_MAX_LENGTH = 9007199254740991;\n"
    "  const K_STRING_MAX_LENGTH = 536870888;\n"
    "  const INSPECT_MAX_BYTES = 50;\n"
    "  const utf8Enc = new TextEncoder();\n"
    "  const utf8Dec = new TextDecoder();\n"
    "  const B64 = \"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\";\n"
    "  const B64U = \"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_\";\n"
    "  const b64Val = (() => {\n"
    "    const t = new Int8Array(256).fill(-1);\n"
    "    for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;\n"
    "    t[\"-\".charCodeAt(0)] = 62;\n"
    "    t[\"_\".charCodeAt(0)] = 63;\n"
    "    return t;\n"
    "  })();\n"
    "  const normEnc = (enc) => {\n"
    "    if (enc === undefined || enc === null) return \"utf8\";\n"
    "    let e = String(enc).toLowerCase();\n"
    "    if (e === \"utf8\" || e === \"utf-8\") return \"utf8\";\n"
    "    if (e === \"hex\") return \"hex\";\n"
    "    if (e === \"base64\") return \"base64\";\n"
    "    if (e === \"base64url\") return \"base64url\";\n"
    "    if (e === \"latin1\" || e === \"binary\") return \"latin1\";\n"
    "    if (e === \"ascii\") return \"ascii\";\n"
    "    if (e === \"utf16le\" || e === \"utf-16le\" || e === \"ucs2\" || e === \"ucs-2\") return \"utf16le\";\n"
    "    return null;\n"
    "  };\n"
    "  const badEnc = (enc) => {\n"
    "    const e = new TypeError(\"Unknown encoding: \" + enc);\n"
    "    e.code = \"ERR_UNKNOWN_ENCODING\";\n"
    "    return e;\n"
    "  };\n"
    "  const outOfRange = (name, range, received) => {\n"
    "    const e = new RangeError('The value of \"' + name + '\" is out of range. It must be ' + range + \". Received \" + received);\n"
    "    e.code = \"ERR_OUT_OF_RANGE\";\n"
    "    return e;\n"
    "  };\n"
    "  const invalidBufferSize = (bits) => {\n"
    "    const e = new RangeError(\"Buffer size must be a multiple of \" + bits + \"-bits\");\n"
    "    e.code = \"ERR_INVALID_BUFFER_SIZE\";\n"
    "    return e;\n"
    "  };\n"
    "  const invalidArg = (name, expected, actual) => {\n"
    "    const t = actual === null ? \"null\" : typeof actual === \"object\" ? \"an instance of \" + (actual.constructor && actual.constructor.name || \"Object\") : typeof actual === \"string\" ? \"type string ('\" + actual + \"')\" : \"type \" + typeof actual + \" (\" + String(actual) + \")\";\n"
    "    const label = name === \"first argument\" ? \"The first argument\" : 'The \"' + name + '\" argument';\n"
    "    const e = new TypeError(label + \" must be \" + expected + \". Received \" + t);\n"
    "    e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "    return e;\n"
    "  };\n"
    "  const encUtf8 = (s) => utf8Enc.encode(s);\n"
    "  const encLatin1 = (s) => {\n"
    "    const out = new Uint8Array(s.length);\n"
    "    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;\n"
    "    return out;\n"
    "  };\n"
    "  const encHex = (s) => {\n"
    "    const n = s.length >>> 1;\n"
    "    const out = new Uint8Array(n);\n"
    "    let i = 0;\n"
    "    for (; i < n; i++) {\n"
    "      const b = parseInt(s.substr(i * 2, 2), 16);\n"
    "      if (Number.isNaN(b) || !/^[0-9a-fA-F]{2}$/.test(s.substr(i * 2, 2))) break;\n"
    "      out[i] = b;\n"
    "    }\n"
    "    return i === n ? out : out.subarray(0, i);\n"
    "  };\n"
    "  const encB64 = (s) => {\n"
    "    const str = String(s);\n"
    "    const vals = [];\n"
    "    for (let i = 0; i < str.length; i++) {\n"
    "      if (str[i] === \"=\") break;\n"
    "      const v = b64Val[str.charCodeAt(i)];\n"
    "      if (v >= 0) vals.push(v);\n"
    "    }\n"
    "    const n = Math.floor((vals.length * 6) / 8);\n"
    "    const out = new Uint8Array(n);\n"
    "    let buf = 0;\n"
    "    let bits = 0;\n"
    "    let o = 0;\n"
    "    for (let i = 0; i < vals.length; i++) {\n"
    "      buf = (buf << 6) | vals[i];\n"
    "      bits += 6;\n"
    "      if (bits >= 8) {\n"
    "        bits -= 8;\n"
    "        out[o++] = (buf >> bits) & 0xff;\n"
    "      }\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  const encUtf16 = (s) => {\n"
    "    const out = new Uint8Array(s.length * 2);\n"
    "    for (let i = 0; i < s.length; i++) {\n"
    "      const c = s.charCodeAt(i);\n"
    "      out[i * 2] = c & 0xff;\n"
    "      out[i * 2 + 1] = c >>> 8;\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  const encodeStr = (s, enc) => {\n"
    "    switch (enc) {\n"
    "      case \"utf8\": return encUtf8(s);\n"
    "      case \"latin1\": case \"ascii\": return encLatin1(s);\n"
    "      case \"hex\": return encHex(s);\n"
    "      case \"base64\": case \"base64url\": return encB64(s);\n"
    "      case \"utf16le\": return encUtf16(s);\n"
    "    }\n"
    "  };\n"
    "  const hexChars = \"0123456789abcdef\";\n"
    "  const decHex = (u8, start, end) => {\n"
    "    let out = \"\";\n"
    "    for (let i = start; i < end; i++) {\n"
    "      out += hexChars[u8[i] >> 4] + hexChars[u8[i] & 0x0f];\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  const decLatin1 = (u8, start, end) => {\n"
    "    let out = \"\";\n"
    "    for (let i = start; i < end; i += 4096) {\n"
    "      out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 4096, end)));\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  const decAscii = (u8, start, end) => {\n"
    "    let out = \"\";\n"
    "    for (let i = start; i < end; i++) out += String.fromCharCode(u8[i] & 0x7f);\n"
    "    return out;\n"
    "  };\n"
    "  const decB64 = (u8, start, end, url) => {\n"
    "    const alpha = url ? B64U : B64;\n"
    "    let out = \"\";\n"
    "    for (let i = start; i < end; i += 3) {\n"
    "      const b0 = u8[i];\n"
    "      const has1 = i + 1 < end;\n"
    "      const has2 = i + 2 < end;\n"
    "      const b1 = has1 ? u8[i + 1] : 0;\n"
    "      const b2 = has2 ? u8[i + 2] : 0;\n"
    "      const v = (b0 << 16) | (b1 << 8) | b2;\n"
    "      out += alpha[(v >> 18) & 63];\n"
    "      out += alpha[(v >> 12) & 63];\n"
    "      if (has1) out += alpha[(v >> 6) & 63];\n"
    "      else if (!url) out += \"=\";\n"
    "      if (has2) out += alpha[v & 63];\n"
    "      else if (!url) out += \"=\";\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  const decUtf16 = (u8, start, end) => {\n"
    "    let out = \"\";\n"
    "    const n = start + ((end - start) & ~1);\n"
    "    for (let i = start; i < n; i += 2) {\n"
    "      out += String.fromCharCode(u8[i] | (u8[i + 1] << 8));\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  const decodeBytes = (u8, enc, start, end) => {\n"
    "    if (start < 0) start = 0;\n"
    "    if (end > u8.length) end = u8.length;\n"
    "    if (end <= start) return \"\";\n"
    "    switch (enc) {\n"
    "      case \"utf8\": return utf8Dec.decode(u8.subarray(start, end));\n"
    "      case \"latin1\": return decLatin1(u8, start, end);\n"
    "      case \"ascii\": return decAscii(u8, start, end);\n"
    "      case \"hex\": return decHex(u8, start, end);\n"
    "      case \"base64\": return decB64(u8, start, end, false);\n"
    "      case \"base64url\": return decB64(u8, start, end, true);\n"
    "      case \"utf16le\": return decUtf16(u8, start, end);\n"
    "    }\n"
    "  };\n"
    "  const checkOffset = (buf, offset, ext) => {\n"
    "    if (!Number.isInteger(offset)) throw outOfRange(\"offset\", \"an integer\", offset);\n"
    "    if (offset < 0 || offset + ext > buf.length) {\n"
    "      if (buf.length - ext < 0) {\n"
    "        const e = new RangeError(\"Attempt to access memory outside buffer bounds\");\n"
    "        e.code = \"ERR_BUFFER_OUT_OF_BOUNDS\";\n"
    "        throw e;\n"
    "      }\n"
    "      throw outOfRange(\"offset\", \">= 0 and <= \" + (buf.length - ext), offset);\n"
    "    }\n"
    "  };\n"
    "  const checkValue = (value, min, max, name) => {\n"
    "    if (value < min || value > max) {\n"
    "      throw outOfRange(name, \">= \" + min + \" and <= \" + max, value);\n"
    "    }\n"
    "  };\n"
    "  class Buffer extends Uint8Array {\n"
    "    static alloc(size, fill, encoding) {\n"
    "      if (typeof size !== \"number\" || Number.isNaN(size)) throw invalidArg(\"size\", \"of type number\", size);\n"
    "      if (size < 0 || size > K_MAX_LENGTH) throw outOfRange(\"size\", \">= 0 && <= \" + K_MAX_LENGTH, size);\n"
    "      const b = new Buffer(size);\n"
    "      if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, encoding);\n"
    "      return b;\n"
    "    }\n"
    "    static allocUnsafe(size) {\n"
    "      return Buffer.alloc(size);\n"
    "    }\n"
    "    static allocUnsafeSlow(size) {\n"
    "      return Buffer.alloc(size);\n"
    "    }\n"
    "    static from(value, encodingOrOffset, length) {\n"
    "      if (typeof value === \"string\") {\n"
    "        const enc = normEnc(encodingOrOffset);\n"
    "        if (enc === null) throw badEnc(encodingOrOffset);\n"
    "        const u8 = encodeStr(value, enc);\n"
    "        return new Buffer(u8.buffer, u8.byteOffset, u8.length);\n"
    "      }\n"
    "      if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== \"undefined\" && value instanceof SharedArrayBuffer)) {\n"
    "        return new Buffer(value, encodingOrOffset, length);\n"
    "      }\n"
    "      if (ArrayBuffer.isView(value)) {\n"
    "        if (value instanceof Uint8Array) {\n"
    "          const copy = new Buffer(value.length);\n"
    "          copy.set(value);\n"
    "          return copy;\n"
    "        }\n"
    "        return new Buffer(Uint8Array.from(value).buffer);\n"
    "      }\n"
    "      if (value === null || value === undefined) throw invalidArg(\"first argument\", \"of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object\", value);\n"
    "      if (typeof value === \"object\") {\n"
    "        if (typeof value.length === \"number\") {\n"
    "          const n = Math.max(0, Math.floor(value.length) || 0);\n"
    "          const b = new Buffer(n);\n"
    "          for (let i = 0; i < n; i++) b[i] = value[i] & 0xff;\n"
    "          return b;\n"
    "        }\n"
    "        if (value.type === \"Buffer\" && Array.isArray(value.data)) {\n"
    "          return Buffer.from(value.data);\n"
    "        }\n"
    "        const prim = value.valueOf && value.valueOf();\n"
    "        if (prim !== null && prim !== undefined && prim !== value) return Buffer.from(prim, encodingOrOffset, length);\n"
    "      }\n"
    "      throw invalidArg(\"first argument\", \"of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object\", value);\n"
    "    }\n"
    "    static isBuffer(b) {\n"
    "      return b instanceof Buffer;\n"
    "    }\n"
    "    static isEncoding(enc) {\n"
    "      return typeof enc === \"string\" && normEnc(enc) !== null;\n"
    "    }\n"
    "    static byteLength(value, encoding) {\n"
    "      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;\n"
    "      if (typeof value !== \"string\") throw invalidArg(\"string\", \"of type string or an instance of Buffer or ArrayBuffer\", value);\n"
    "      const enc = normEnc(encoding);\n"
    "      switch (enc) {\n"
    "        case \"latin1\": case \"ascii\": return value.length;\n"
    "        case \"utf16le\": return value.length * 2;\n"
    "        case \"hex\": return value.length >>> 1;\n"
    "        case \"base64\": case \"base64url\": {\n"
    "          let n = value.length;\n"
    "          while (n > 0 && (value[n - 1] === \"=\" || value[n - 1] === \" \" || value[n - 1] === \"\\n\" || value[n - 1] === \"\\r\")) n--;\n"
    "          return Math.floor((n * 6) / 8);\n"
    "        }\n"
    "        default: return encUtf8(value).length;\n"
    "      }\n"
    "    }\n"
    "    static concat(list, totalLength) {\n"
    "      if (!Array.isArray(list)) throw invalidArg(\"list\", \"an instance of Array\", list);\n"
    "      if (list.length === 0) return new Buffer(0);\n"
    "      let total = totalLength;\n"
    "      if (total === undefined) {\n"
    "        total = 0;\n"
    "        for (const b of list) total += b.length;\n"
    "      }\n"
    "      const out = new Buffer(total);\n"
    "      let o = 0;\n"
    "      for (const b of list) {\n"
    "        if (o >= total) break;\n"
    "        const chunk = b.length + o > total ? b.subarray(0, total - o) : b;\n"
    "        out.set(chunk, o);\n"
    "        o += chunk.length;\n"
    "      }\n"
    "      return out;\n"
    "    }\n"
    "    static compare(a, b) {\n"
    "      return a.compare(b);\n"
    "    }\n"
    "    toString(encoding, start, end) {\n"
    "      const enc = normEnc(encoding);\n"
    "      if (enc === null) throw badEnc(encoding);\n"
    "      return decodeBytes(this, enc, start === undefined ? 0 : Math.floor(start), end === undefined ? this.length : Math.min(Math.floor(end), this.length));\n"
    "    }\n"
    "    toJSON() {\n"
    "      return { type: \"Buffer\", data: Array.prototype.slice.call(this) };\n"
    "    }\n"
    "    equals(other) {\n"
    "      if (!(other instanceof Uint8Array)) throw invalidArg(\"otherBuffer\", \"an instance of Buffer or Uint8Array\", other);\n"
    "      if (this === other) return true;\n"
    "      if (this.length !== other.length) return false;\n"
    "      for (let i = 0; i < this.length; i++) {\n"
    "        if (this[i] !== other[i]) return false;\n"
    "      }\n"
    "      return true;\n"
    "    }\n"
    "    compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {\n"
    "      if (!(target instanceof Uint8Array)) throw invalidArg(\"target\", \"an instance of Buffer or Uint8Array\", target);\n"
    "      const ts = targetStart === undefined ? 0 : targetStart;\n"
    "      const te = targetEnd === undefined ? target.length : targetEnd;\n"
    "      const ss = sourceStart === undefined ? 0 : sourceStart;\n"
    "      const se = sourceEnd === undefined ? this.length : sourceEnd;\n"
    "      const a = this.subarray(ss, se);\n"
    "      const b = target.subarray(ts, te);\n"
    "      const n = Math.min(a.length, b.length);\n"
    "      for (let i = 0; i < n; i++) {\n"
    "        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;\n"
    "      }\n"
    "      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;\n"
    "    }\n"
    "    copy(target, targetStart, sourceStart, sourceEnd) {\n"
    "      const ts = targetStart === undefined ? 0 : targetStart;\n"
    "      const ss = sourceStart === undefined ? 0 : sourceStart;\n"
    "      let se = sourceEnd === undefined ? this.length : sourceEnd;\n"
    "      if (se > this.length) se = this.length;\n"
    "      const n = Math.min(se - ss, target.length - ts);\n"
    "      if (n <= 0) return 0;\n"
    "      target.set(this.subarray(ss, ss + n), ts);\n"
    "      return n;\n"
    "    }\n"
    "    fill(value, start, end, encoding) {\n"
    "      let s = 0;\n"
    "      let e = this.length;\n"
    "      let enc = encoding;\n"
    "      if (typeof start === \"string\") {\n"
    "        enc = start;\n"
    "      } else {\n"
    "        if (start !== undefined) s = start;\n"
    "        if (typeof end === \"string\") enc = end;\n"
    "        else if (end !== undefined) e = end;\n"
    "      }\n"
    "      if (typeof value === \"number\") {\n"
    "        Uint8Array.prototype.fill.call(this, value & 0xff, s, e);\n"
    "        return this;\n"
    "      }\n"
    "      let pattern;\n"
    "      if (typeof value === \"string\") {\n"
    "        const ne = normEnc(enc);\n"
    "        if (ne === null) throw badEnc(enc);\n"
    "        pattern = encodeStr(value, ne);\n"
    "      } else if (value instanceof Uint8Array) {\n"
    "        pattern = value;\n"
    "      } else {\n"
    "        throw invalidArg(\"value\", \"of type string or number or an instance of Buffer or Uint8Array\", value);\n"
    "      }\n"
    "      if (pattern.length === 0) {\n"
    "        Uint8Array.prototype.fill.call(this, 0, s, e);\n"
    "        return this;\n"
    "      }\n"
    "      for (let i = s; i < e; i++) this[i] = pattern[(i - s) % pattern.length];\n"
    "      return this;\n"
    "    }\n"
    "    write(string, offset, length, encoding) {\n"
    "      if (typeof string !== \"string\") throw invalidArg(\"string\", \"of type string\", string);\n"
    "      let off = 0;\n"
    "      let len;\n"
    "      let enc = \"utf8\";\n"
    "      if (offset === undefined) {\n"
    "        len = this.length;\n"
    "      } else if (typeof offset === \"string\") {\n"
    "        enc = normEnc(offset);\n"
    "        if (enc === null) throw badEnc(offset);\n"
    "        len = this.length;\n"
    "      } else {\n"
    "        off = offset;\n"
    "        if (length === undefined) {\n"
    "          len = this.length - off;\n"
    "        } else if (typeof length === \"string\") {\n"
    "          enc = normEnc(length);\n"
    "          if (enc === null) throw badEnc(length);\n"
    "          len = this.length - off;\n"
    "        } else {\n"
    "          len = length;\n"
    "          if (encoding !== undefined) {\n"
    "            enc = normEnc(encoding);\n"
    "            if (enc === null) throw badEnc(encoding);\n"
    "          }\n"
    "        }\n"
    "      }\n"
    "      if (off < 0 || off > this.length) throw outOfRange(\"offset\", \">= 0 and <= \" + this.length, off);\n"
    "      const bytes = encodeStr(string, enc);\n"
    "      let n = Math.min(bytes.length, len, this.length - off);\n"
    "      if (enc === \"utf16le\") n &= ~1;\n"
    "      if (enc === \"utf8\" && n < bytes.length) {\n"
    "        while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;\n"
    "      }\n"
    "      this.set(bytes.subarray(0, n), off);\n"
    "      return n;\n"
    "    }\n"
    "    slice(start, end) {\n"
    "      return this.subarray(start, end);\n"
    "    }\n"
    "    toLocaleString(...args) {\n"
    "      return this.toString(...args);\n"
    "    }\n"
    "    inspect() {\n"
    "      return this[Symbol.for(\"nodejs.util.inspect.custom\")]();\n"
    "    }\n"
    "    [Symbol.for(\"nodejs.util.inspect.custom\")]() {\n"
    "      const max = Math.min(this.length, INSPECT_MAX_BYTES);\n"
    "      let out = \"<Buffer \";\n"
    "      for (let i = 0; i < max; i++) {\n"
    "        out += (i ? \" \" : \"\") + hexChars[this[i] >> 4] + hexChars[this[i] & 0x0f];\n"
    "      }\n"
    "      if (this.length > max) {\n"
    "        const rest = this.length - max;\n"
    "        out += \" ... \" + rest + \" more byte\" + (rest > 1 ? \"s\" : \"\");\n"
    "      }\n"
    "      return out + \">\";\n"
    "    }\n"
    "    indexOf(needle, byteOffset, encoding) {\n"
    "      return bufIndexOf(this, needle, byteOffset, encoding, true);\n"
    "    }\n"
    "    lastIndexOf(needle, byteOffset, encoding) {\n"
    "      return bufIndexOf(this, needle, byteOffset, encoding, false);\n"
    "    }\n"
    "    includes(needle, byteOffset, encoding) {\n"
    "      return this.indexOf(needle, byteOffset, encoding) !== -1;\n"
    "    }\n"
    "    swap16() {\n"
    "      if (this.length % 2 !== 0) throw invalidBufferSize(\"16\");\n"
    "      for (let i = 0; i < this.length; i += 2) {\n"
    "        const t = this[i];\n"
    "        this[i] = this[i + 1];\n"
    "        this[i + 1] = t;\n"
    "      }\n"
    "      return this;\n"
    "    }\n"
    "    swap32() {\n"
    "      if (this.length % 4 !== 0) throw invalidBufferSize(\"32\");\n"
    "      for (let i = 0; i < this.length; i += 4) {\n"
    "        let t = this[i];\n"
    "        this[i] = this[i + 3];\n"
    "        this[i + 3] = t;\n"
    "        t = this[i + 1];\n"
    "        this[i + 1] = this[i + 2];\n"
    "        this[i + 2] = t;\n"
    "      }\n"
    "      return this;\n"
    "    }\n"
    "    swap64() {\n"
    "      if (this.length % 8 !== 0) throw invalidBufferSize(\"64\");\n"
    "      for (let i = 0; i < this.length; i += 8) {\n"
    "        for (let j = 0; j < 4; j++) {\n"
    "          const t = this[i + j];\n"
    "          this[i + j] = this[i + 7 - j];\n"
    "          this[i + 7 - j] = t;\n"
    "        }\n"
    "      }\n"
    "      return this;\n"
    "    }\n"
    "    readUInt8(offset = 0) { checkOffset(this, offset, 1); return this[offset]; }\n"
    "    readUInt16LE(offset = 0) { checkOffset(this, offset, 2); return this[offset] | (this[offset + 1] << 8); }\n"
    "    readUInt16BE(offset = 0) { checkOffset(this, offset, 2); return (this[offset] << 8) | this[offset + 1]; }\n"
    "    readUInt32LE(offset = 0) { checkOffset(this, offset, 4); return (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + this[offset + 3] * 0x1000000; }\n"
    "    readUInt32BE(offset = 0) { checkOffset(this, offset, 4); return this[offset] * 0x1000000 + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]); }\n"
    "    readInt8(offset = 0) { checkOffset(this, offset, 1); return (this[offset] << 24) >> 24; }\n"
    "    readInt16LE(offset = 0) { checkOffset(this, offset, 2); return ((this[offset] | (this[offset + 1] << 8)) << 16) >> 16; }\n"
    "    readInt16BE(offset = 0) { checkOffset(this, offset, 2); return (((this[offset] << 8) | this[offset + 1]) << 16) >> 16; }\n"
    "    readInt32LE(offset = 0) { checkOffset(this, offset, 4); return this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24); }\n"
    "    readInt32BE(offset = 0) { checkOffset(this, offset, 4); return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]; }\n"
    "    readUIntLE(offset, byteLength) {\n"
    "      checkOffset(this, offset, byteLength);\n"
    "      let v = 0;\n"
    "      let mul = 1;\n"
    "      for (let i = 0; i < byteLength; i++) {\n"
    "        v += this[offset + i] * mul;\n"
    "        mul *= 0x100;\n"
    "      }\n"
    "      return v;\n"
    "    }\n"
    "    readUIntBE(offset, byteLength) {\n"
    "      checkOffset(this, offset, byteLength);\n"
    "      let v = 0;\n"
    "      for (let i = 0; i < byteLength; i++) v = v * 0x100 + this[offset + i];\n"
    "      return v;\n"
    "    }\n"
    "    readIntLE(offset, byteLength) {\n"
    "      const v = this.readUIntLE(offset, byteLength);\n"
    "      const limit = Math.pow(2, 8 * byteLength - 1);\n"
    "      return v >= limit ? v - limit * 2 : v;\n"
    "    }\n"
    "    readIntBE(offset, byteLength) {\n"
    "      const v = this.readUIntBE(offset, byteLength);\n"
    "      const limit = Math.pow(2, 8 * byteLength - 1);\n"
    "      return v >= limit ? v - limit * 2 : v;\n"
    "    }\n"
    "    readBigUInt64LE(offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigUint64(offset, true);\n"
    "    }\n"
    "    readBigUInt64BE(offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigUint64(offset, false);\n"
    "    }\n"
    "    readBigInt64LE(offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigInt64(offset, true);\n"
    "    }\n"
    "    readBigInt64BE(offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigInt64(offset, false);\n"
    "    }\n"
    "    readFloatLE(offset = 0) {\n"
    "      checkOffset(this, offset, 4);\n"
    "      return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat32(offset, true);\n"
    "    }\n"
    "    readFloatBE(offset = 0) {\n"
    "      checkOffset(this, offset, 4);\n"
    "      return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat32(offset, false);\n"
    "    }\n"
    "    readDoubleLE(offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat64(offset, true);\n"
    "    }\n"
    "    readDoubleBE(offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat64(offset, false);\n"
    "    }\n"
    "    writeUInt8(value, offset = 0) {\n"
    "      checkOffset(this, offset, 1);\n"
    "      checkValue(value, 0, 0xff, \"value\");\n"
    "      this[offset] = value;\n"
    "      return offset + 1;\n"
    "    }\n"
    "    writeUInt16LE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 2);\n"
    "      checkValue(value, 0, 0xffff, \"value\");\n"
    "      this[offset] = value & 0xff;\n"
    "      this[offset + 1] = value >>> 8;\n"
    "      return offset + 2;\n"
    "    }\n"
    "    writeUInt16BE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 2);\n"
    "      checkValue(value, 0, 0xffff, \"value\");\n"
    "      this[offset] = value >>> 8;\n"
    "      this[offset + 1] = value & 0xff;\n"
    "      return offset + 2;\n"
    "    }\n"
    "    writeUInt32LE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 4);\n"
    "      checkValue(value, 0, 0xffffffff, \"value\");\n"
    "      this[offset] = value & 0xff;\n"
    "      this[offset + 1] = (value >>> 8) & 0xff;\n"
    "      this[offset + 2] = (value >>> 16) & 0xff;\n"
    "      this[offset + 3] = (value >>> 24) & 0xff;\n"
    "      return offset + 4;\n"
    "    }\n"
    "    writeUInt32BE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 4);\n"
    "      checkValue(value, 0, 0xffffffff, \"value\");\n"
    "      this[offset] = (value >>> 24) & 0xff;\n"
    "      this[offset + 1] = (value >>> 16) & 0xff;\n"
    "      this[offset + 2] = (value >>> 8) & 0xff;\n"
    "      this[offset + 3] = value & 0xff;\n"
    "      return offset + 4;\n"
    "    }\n"
    "    writeInt8(value, offset = 0) {\n"
    "      checkOffset(this, offset, 1);\n"
    "      checkValue(value, -0x80, 0x7f, \"value\");\n"
    "      this[offset] = value & 0xff;\n"
    "      return offset + 1;\n"
    "    }\n"
    "    writeInt16LE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 2);\n"
    "      checkValue(value, -0x8000, 0x7fff, \"value\");\n"
    "      this[offset] = value & 0xff;\n"
    "      this[offset + 1] = (value >>> 8) & 0xff;\n"
    "      return offset + 2;\n"
    "    }\n"
    "    writeInt16BE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 2);\n"
    "      checkValue(value, -0x8000, 0x7fff, \"value\");\n"
    "      this[offset] = (value >>> 8) & 0xff;\n"
    "      this[offset + 1] = value & 0xff;\n"
    "      return offset + 2;\n"
    "    }\n"
    "    writeInt32LE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 4);\n"
    "      checkValue(value, -0x80000000, 0x7fffffff, \"value\");\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setInt32(offset, value, true);\n"
    "      return offset + 4;\n"
    "    }\n"
    "    writeInt32BE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 4);\n"
    "      checkValue(value, -0x80000000, 0x7fffffff, \"value\");\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setInt32(offset, value, false);\n"
    "      return offset + 4;\n"
    "    }\n"
    "    writeBigUInt64LE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigUint64(offset, value, true);\n"
    "      return offset + 8;\n"
    "    }\n"
    "    writeBigUInt64BE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigUint64(offset, value, false);\n"
    "      return offset + 8;\n"
    "    }\n"
    "    writeBigInt64LE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigInt64(offset, value, true);\n"
    "      return offset + 8;\n"
    "    }\n"
    "    writeBigInt64BE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigInt64(offset, value, false);\n"
    "      return offset + 8;\n"
    "    }\n"
    "    writeFloatLE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 4);\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat32(offset, value, true);\n"
    "      return offset + 4;\n"
    "    }\n"
    "    writeFloatBE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 4);\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat32(offset, value, false);\n"
    "      return offset + 4;\n"
    "    }\n"
    "    writeDoubleLE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat64(offset, value, true);\n"
    "      return offset + 8;\n"
    "    }\n"
    "    writeDoubleBE(value, offset = 0) {\n"
    "      checkOffset(this, offset, 8);\n"
    "      new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat64(offset, value, false);\n"
    "      return offset + 8;\n"
    "    }\n"
    "    writeUIntLE(value, offset, byteLength) {\n"
    "      checkOffset(this, offset, byteLength);\n"
    "      let v = value;\n"
    "      for (let i = 0; i < byteLength; i++) {\n"
    "        this[offset + i] = v & 0xff;\n"
    "        v = Math.floor(v / 0x100);\n"
    "      }\n"
    "      return offset + byteLength;\n"
    "    }\n"
    "    writeUIntBE(value, offset, byteLength) {\n"
    "      checkOffset(this, offset, byteLength);\n"
    "      let v = value;\n"
    "      for (let i = byteLength - 1; i >= 0; i--) {\n"
    "        this[offset + i] = v & 0xff;\n"
    "        v = Math.floor(v / 0x100);\n"
    "      }\n"
    "      return offset + byteLength;\n"
    "    }\n"
    "    writeIntLE(value, offset, byteLength) {\n"
    "      return this.writeUIntLE(value < 0 ? value + Math.pow(2, 8 * byteLength) : value, offset, byteLength);\n"
    "    }\n"
    "    writeIntBE(value, offset, byteLength) {\n"
    "      return this.writeUIntBE(value < 0 ? value + Math.pow(2, 8 * byteLength) : value, offset, byteLength);\n"
    "    }\n"
    "  }\n"
    "  Buffer.poolSize = 8192;\n"
    "  const bufIndexOf = (buf, needle, byteOffset, encoding, first) => {\n"
    "    let enc = \"utf8\";\n"
    "    let start = first ? 0 : buf.length - 1;\n"
    "    if (typeof byteOffset === \"string\") {\n"
    "      enc = normEnc(byteOffset);\n"
    "      if (enc === null) throw badEnc(byteOffset);\n"
    "    } else if (byteOffset !== undefined) {\n"
    "      start = Math.trunc(byteOffset);\n"
    "      if (Number.isNaN(start)) start = first ? 0 : buf.length - 1;\n"
    "      if (start < 0) start = buf.length + start;\n"
    "      if (encoding !== undefined) {\n"
    "        enc = normEnc(encoding);\n"
    "        if (enc === null) throw badEnc(encoding);\n"
    "      }\n"
    "    }\n"
    "    let pat;\n"
    "    if (typeof needle === \"number\") {\n"
    "      const b = needle & 0xff;\n"
    "      if (first) {\n"
    "        for (let i = Math.max(0, start); i < buf.length; i++) {\n"
    "          if (buf[i] === b) return i;\n"
    "        }\n"
    "      } else {\n"
    "        for (let i = Math.min(start, buf.length - 1); i >= 0; i--) {\n"
    "          if (buf[i] === b) return i;\n"
    "        }\n"
    "      }\n"
    "      return -1;\n"
    "    }\n"
    "    if (typeof needle === \"string\") pat = encodeStr(needle, enc);\n"
    "    else if (needle instanceof Uint8Array) pat = needle;\n"
    "    else throw invalidArg(\"value\", \"of type string or an instance of Buffer or Uint8Array\", needle);\n"
    "    if (pat.length === 0) {\n"
    "      if (first) return start < 0 ? 0 : start > buf.length ? buf.length : start;\n"
    "      return start < 0 ? 0 : Math.min(start, buf.length);\n"
    "    }\n"
    "    const match = (i) => {\n"
    "      for (let j = 0; j < pat.length; j++) {\n"
    "        if (buf[i + j] !== pat[j]) return false;\n"
    "      }\n"
    "      return true;\n"
    "    };\n"
    "    if (first) {\n"
    "      for (let i = Math.max(0, start); i <= buf.length - pat.length; i++) {\n"
    "        if (match(i)) return i;\n"
    "      }\n"
    "    } else {\n"
    "      for (let i = Math.min(start, buf.length - pat.length); i >= 0; i--) {\n"
    "        if (match(i)) return i;\n"
    "      }\n"
    "    }\n"
    "    return -1;\n"
    "  };\n"
    "  function SlowBuffer(size) { return Buffer.alloc(size); }\n"
    "  const isAscii = (input) => {\n"
    "    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);\n"
    "    for (let i = 0; i < u8.length; i++) {\n"
    "      if (u8[i] > 0x7f) return false;\n"
    "    }\n"
    "    return true;\n"
    "  };\n"
    "  const isUtf8 = (input) => {\n"
    "    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);\n"
    "    let i = 0;\n"
    "    while (i < u8.length) {\n"
    "      const b = u8[i];\n"
    "      let n = 0;\n"
    "      let min = 0;\n"
    "      let cp = 0;\n"
    "      if (b < 0x80) { i++; continue; }\n"
    "      else if ((b & 0xe0) === 0xc0) { n = 1; min = 0x80; cp = b & 0x1f; }\n"
    "      else if ((b & 0xf0) === 0xe0) { n = 2; min = 0x800; cp = b & 0x0f; }\n"
    "      else if ((b & 0xf8) === 0xf0) { n = 3; min = 0x10000; cp = b & 0x07; }\n"
    "      else return false;\n"
    "      if (i + n >= u8.length + 1 && i + n > u8.length) return false;\n"
    "      for (let j = 1; j <= n; j++) {\n"
    "        if (i + j >= u8.length || (u8[i + j] & 0xc0) !== 0x80) return false;\n"
    "        cp = (cp << 6) | (u8[i + j] & 0x3f);\n"
    "      }\n"
    "      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;\n"
    "      i += n + 1;\n"
    "    }\n"
    "    return true;\n"
    "  };\n"
    "  return {\n"
    "    Buffer,\n"
    "    SlowBuffer,\n"
    "    INSPECT_MAX_BYTES,\n"
    "    kMaxLength: K_MAX_LENGTH,\n"
    "    kStringMaxLength: K_STRING_MAX_LENGTH,\n"
    "    constants: { MAX_LENGTH: K_MAX_LENGTH, MAX_STRING_LENGTH: K_STRING_MAX_LENGTH },\n"
    "    isAscii,\n"
    "    isUtf8,\n"
    "    atob: globalThis.atob,\n"
    "    btoa: globalThis.btoa,\n"
    /* Node re-exports the WHATWG classes here since v18 (undici's
     * fetch/file.js extends buffer.Blob at LOAD). The web prelude
     * (scr_web.c) owns the implementations. */
    "    Blob: globalThis.Blob,\n"
    "    File: globalThis.File,\n"
    "    transcode: () => {\n"
    "      throw new Error(\"buffer.transcode is not available in the scriptc island\");\n"
    "    },\n"
    "    resolveObjectURL: () => undefined,\n"
    "  };\n"
    "}\n"
    "    const mod = makeBuffer();\n"
    "    mod.default = mod;\n"
    "    return mod;\n"
    "  });\n"
    /* node:string_decoder — StringDecoder over the Buffer shim: utf8
     * rides the prelude TextDecoder's streaming state machine,
     * utf16le holds byte parity, base64 carries mod-3 remainders. */
    "  builtins.string_decoder = memo(() => {\n"
    "function makeStringDecoder(Buffer) {\n"
    "  const normEnc = (enc) => {\n"
    "    if (enc === undefined || enc === null) return \"utf8\";\n"
    "    const e = String(enc).toLowerCase();\n"
    "    if (e === \"utf8\" || e === \"utf-8\") return \"utf8\";\n"
    "    if (e === \"hex\") return \"hex\";\n"
    "    if (e === \"base64\") return \"base64\";\n"
    "    if (e === \"base64url\") return \"base64url\";\n"
    "    if (e === \"latin1\" || e === \"binary\") return \"latin1\";\n"
    "    if (e === \"ascii\") return \"ascii\";\n"
    "    if (e === \"utf16le\" || e === \"utf-16le\" || e === \"ucs2\" || e === \"ucs-2\") return \"utf16le\";\n"
    "    const err = new TypeError(\"Unknown encoding: \" + enc);\n"
    "    err.code = \"ERR_UNKNOWN_ENCODING\";\n"
    "    throw err;\n"
    "  };\n"
    "  class StringDecoder {\n"
    "    constructor(encoding) {\n"
    "      this.encoding = normEnc(encoding);\n"
    "      if (this.encoding === \"utf8\") {\n"
    "        this._dec = new TextDecoder();\n"
    "      } else if (this.encoding === \"utf16le\") {\n"
    "        this._oddByte = -1;\n"
    "      } else if (this.encoding === \"base64\" || this.encoding === \"base64url\") {\n"
    "        this._rem = null;\n"
    "      }\n"
    "    }\n"
    "    write(buf) {\n"
    "      if (typeof buf === \"string\") return buf;\n"
    "      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);\n"
    "      switch (this.encoding) {\n"
    "        case \"utf8\":\n"
    "          return this._dec.decode(u8, { stream: true });\n"
    "        case \"utf16le\": {\n"
    "          let bytes = u8;\n"
    "          if (this._oddByte >= 0) {\n"
    "            const joined = new Uint8Array(u8.length + 1);\n"
    "            joined[0] = this._oddByte;\n"
    "            joined.set(u8, 1);\n"
    "            bytes = joined;\n"
    "            this._oddByte = -1;\n"
    "          }\n"
    "          if (bytes.length % 2 !== 0) {\n"
    "            this._oddByte = bytes[bytes.length - 1];\n"
    "            bytes = bytes.subarray(0, bytes.length - 1);\n"
    "          }\n"
    "          return Buffer.from(bytes).toString(\"utf16le\");\n"
    "        }\n"
    "        case \"base64\":\n"
    "        case \"base64url\": {\n"
    "          let bytes = u8;\n"
    "          if (this._rem !== null) {\n"
    "            const joined = new Uint8Array(this._rem.length + u8.length);\n"
    "            joined.set(this._rem, 0);\n"
    "            joined.set(u8, this._rem.length);\n"
    "            bytes = joined;\n"
    "            this._rem = null;\n"
    "          }\n"
    "          const usable = bytes.length - (bytes.length % 3);\n"
    "          if (usable < bytes.length) {\n"
    "            this._rem = bytes.slice(usable);\n"
    "            bytes = bytes.subarray(0, usable);\n"
    "          }\n"
    "          return Buffer.from(bytes).toString(this.encoding);\n"
    "        }\n"
    "        default:\n"
    "          return Buffer.from(u8).toString(this.encoding);\n"
    "      }\n"
    "    }\n"
    "    end(buf) {\n"
    "      let out = buf !== undefined ? this.write(buf) : \"\";\n"
    "      switch (this.encoding) {\n"
    "        case \"utf8\":\n"
    "          out += this._dec.decode();\n"
    "          this._dec = new TextDecoder();\n"
    "          break;\n"
    "        case \"utf16le\":\n"
    "          this._oddByte = -1;\n"
    "          break;\n"
    "        case \"base64\":\n"
    "        case \"base64url\":\n"
    "          if (this._rem !== null) {\n"
    "            out += Buffer.from(this._rem).toString(this.encoding);\n"
    "            this._rem = null;\n"
    "          }\n"
    "          break;\n"
    "      }\n"
    "      return out;\n"
    "    }\n"
    "  }\n"
    "  return { StringDecoder };\n"
    "}\n"
    "    const mod = makeStringDecoder(builtins.buffer().Buffer);\n"
    "    mod.default = mod;\n"
    "    return mod;\n"
    "  });\n"
    /* node:crypto — the hashing/random slice over host bridges
     * (md5/sha1/sha256 digest + HMAC through the same C
     * implementations the static lowerings use; randomness through
     * the web prelude's CSPRNG), pbkdf2 over the HMAC bridge, and
     * honest throwing stubs for the key/cipher machinery the island
     * does not carry. Differentially tested against real Node. */
    "  builtins.crypto = memo(() => {\n"
    "function makeCrypto(env) {\n"
    "  const Buffer = env.Buffer;\n"
    "  const webcrypto = globalThis.crypto;\n"
    "  const toU8 = (data, enc, name) => {\n"
    "    if (typeof data === \"string\") return Buffer.from(data, enc === undefined ? \"utf8\" : enc);\n"
    "    if (data instanceof Uint8Array) return data;\n"
    "    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);\n"
    "    if (data instanceof ArrayBuffer) return new Uint8Array(data);\n"
    "    const e = new TypeError('The \"' + name + '\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + (data === null ? \"null\" : typeof data === \"object\" ? \"an instance of \" + ((data.constructor && data.constructor.name) || \"Object\") : typeof data === \"undefined\" ? \"undefined\" : \"type \" + typeof data + \" (\" + JSON.stringify(data) + \")\"));\n"
    "    e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "    throw e;\n"
    "  };\n"
    "  const unsupportedDigest = () => {\n"
    "    return new Error(\"Digest method not supported\");\n"
    "  };\n"
    "  const concatChunks = (chunks) => {\n"
    "    let total = 0;\n"
    "    for (const c of chunks) total += c.length;\n"
    "    const out = new Uint8Array(total);\n"
    "    let o = 0;\n"
    "    for (const c of chunks) {\n"
    "      out.set(c, o);\n"
    "      o += c.length;\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  class Hash {\n"
    "    constructor(algorithm, from) {\n"
    "      if (from === undefined) {\n"
    "        const alg = String(algorithm).toLowerCase();\n"
    "        if (env.digest(alg, new Uint8Array(0)) === undefined) throw unsupportedDigest();\n"
    "        this._alg = alg;\n"
    "        this._chunks = [];\n"
    "      } else {\n"
    "        this._alg = from._alg;\n"
    "        this._chunks = from._chunks.slice();\n"
    "      }\n"
    "      this._done = false;\n"
    "    }\n"
    "    update(data, inputEncoding) {\n"
    "      if (this._done) {\n"
    "        const e = new Error(\"Digest already called\");\n"
    "        e.code = \"ERR_CRYPTO_HASH_FINALIZED\";\n"
    "        throw e;\n"
    "      }\n"
    "      this._chunks.push(toU8(data, inputEncoding, \"data\"));\n"
    "      return this;\n"
    "    }\n"
    "    copy() {\n"
    "      return new Hash(this._alg, this);\n"
    "    }\n"
    "    digest(outputEncoding) {\n"
    "      if (this._done) {\n"
    "        const e = new Error(\"Digest already called\");\n"
    "        e.code = \"ERR_CRYPTO_HASH_FINALIZED\";\n"
    "        throw e;\n"
    "      }\n"
    "      this._done = true;\n"
    "      const raw = env.digest(this._alg, concatChunks(this._chunks));\n"
    "      const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.length);\n"
    "      return outputEncoding === undefined || outputEncoding === \"buffer\" ? buf : buf.toString(outputEncoding);\n"
    "    }\n"
    "  }\n"
    "  class Hmac {\n"
    "    constructor(algorithm, key) {\n"
    "      const alg = String(algorithm).toLowerCase();\n"
    "      if (env.digest(alg, new Uint8Array(0)) === undefined) throw unsupportedDigest();\n"
    "      this._alg = alg;\n"
    "      this._key = toU8(key, \"utf8\", \"key\");\n"
    "      this._chunks = [];\n"
    "      this._done = false;\n"
    "    }\n"
    "    update(data, inputEncoding) {\n"
    "      this._chunks.push(toU8(data, inputEncoding, \"data\"));\n"
    "      return this;\n"
    "    }\n"
    "    digest(outputEncoding) {\n"
    "      this._done = true;\n"
    "      const raw = env.hmac(this._alg, this._key, concatChunks(this._chunks));\n"
    "      const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.length);\n"
    "      return outputEncoding === undefined || outputEncoding === \"buffer\" ? buf : buf.toString(outputEncoding);\n"
    "    }\n"
    "  }\n"
    "  const createHash = (algorithm) => new Hash(algorithm);\n"
    "  const createHmac = (algorithm, key) => new Hmac(algorithm, key);\n"
    "  const hash = (algorithm, data, outputEncoding) => {\n"
    "    const h = new Hash(algorithm);\n"
    "    h.update(typeof data === \"string\" ? Buffer.from(data, \"utf8\") : data);\n"
    "    return h.digest(outputEncoding === undefined ? \"hex\" : outputEncoding);\n"
    "  };\n"
    "  const fillRandom = (u8) => {\n"
    "    for (let i = 0; i < u8.length; i += 65536) {\n"
    "      webcrypto.getRandomValues(u8.subarray(i, Math.min(i + 65536, u8.length)));\n"
    "    }\n"
    "    return u8;\n"
    "  };\n"
    "  const randomBytes = (size, callback) => {\n"
    "    if (typeof size !== \"number\" || Number.isNaN(size) || size < 0) {\n"
    "      const e = new RangeError('The value of \"size\" is out of range. It must be >= 0 && <= 2147483647. Received ' + size);\n"
    "      e.code = \"ERR_OUT_OF_RANGE\";\n"
    "      throw e;\n"
    "    }\n"
    "    const buf = fillRandom(Buffer.alloc(size));\n"
    "    if (typeof callback === \"function\") {\n"
    "      queueMicrotask(() => callback(null, buf));\n"
    "      return undefined;\n"
    "    }\n"
    "    return buf;\n"
    "  };\n"
    "  const randomFillSync = (buf, offset, size) => {\n"
    "    const off = offset === undefined ? 0 : offset;\n"
    "    const n = size === undefined ? buf.byteLength - off : size;\n"
    "    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);\n"
    "    fillRandom(u8.subarray(off, off + n));\n"
    "    return buf;\n"
    "  };\n"
    "  const randomFill = (buf, ...rest) => {\n"
    "    const callback = rest.pop();\n"
    "    if (typeof callback !== \"function\") {\n"
    "      const e = new TypeError('The \"callback\" argument must be of type function. Received ' + (callback === undefined ? \"undefined\" : \"type \" + typeof callback));\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    randomFillSync(buf, ...rest);\n"
    "    queueMicrotask(() => callback(null, buf));\n"
    "  };\n"
    "  const randomInt = (min, max, callback) => {\n"
    "    if (max === undefined || typeof max === \"function\") {\n"
    "      callback = max;\n"
    "      max = min;\n"
    "      min = 0;\n"
    "    }\n"
    "    if (!Number.isSafeInteger(min)) {\n"
    "      const e = new TypeError('The \"min\" argument must be a safe integer. Received ' + min);\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    if (max <= min) {\n"
    "      const e = new RangeError('The value of \"max\" is out of range. It must be greater than the value of \"min\" (' + min + \"). Received \" + max);\n"
    "      e.code = \"ERR_OUT_OF_RANGE\";\n"
    "      throw e;\n"
    "    }\n"
    "    const range = max - min;\n"
    "    const draw = () => {\n"
    "      const bytes = fillRandom(new Uint8Array(6));\n"
    "      let v = 0;\n"
    "      for (let i = 0; i < 6; i++) v = v * 256 + bytes[i];\n"
    "      return v;\n"
    "    };\n"
    "    const limit = Math.floor(Math.pow(2, 48) / range) * range;\n"
    "    let v = draw();\n"
    "    while (v >= limit) v = draw();\n"
    "    const result = min + (v % range);\n"
    "    if (typeof callback === \"function\") {\n"
    "      queueMicrotask(() => callback(null, result));\n"
    "      return undefined;\n"
    "    }\n"
    "    return result;\n"
    "  };\n"
    "  const randomUUID = () => webcrypto.randomUUID();\n"
    "  const timingSafeEqual = (a, b) => {\n"
    "    const ua = toU8(a, undefined, \"buf1\");\n"
    "    const ub = toU8(b, undefined, \"buf2\");\n"
    "    if (ua.byteLength !== ub.byteLength) {\n"
    "      const e = new RangeError(\"Input buffers must have the same byte length\");\n"
    "      e.code = \"ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH\";\n"
    "      throw e;\n"
    "    }\n"
    "    let diff = 0;\n"
    "    for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];\n"
    "    return diff === 0;\n"
    "  };\n"
    "  const pbkdf2Sync = (password, salt, iterations, keylen, digestAlg) => {\n"
    "    const alg = String(digestAlg).toLowerCase();\n"
    "    if (env.digest(alg, new Uint8Array(0)) === undefined) throw unsupportedDigest();\n"
    "    const pw = toU8(password, undefined, \"password\");\n"
    "    const st = toU8(salt, undefined, \"salt\");\n"
    "    const hLen = env.digest(alg, new Uint8Array(0)).length;\n"
    "    const blocks = Math.ceil(keylen / hLen);\n"
    "    const dk = new Uint8Array(blocks * hLen);\n"
    "    for (let i = 1; i <= blocks; i++) {\n"
    "      const block = new Uint8Array(st.length + 4);\n"
    "      block.set(st, 0);\n"
    "      block[st.length] = (i >>> 24) & 0xff;\n"
    "      block[st.length + 1] = (i >>> 16) & 0xff;\n"
    "      block[st.length + 2] = (i >>> 8) & 0xff;\n"
    "      block[st.length + 3] = i & 0xff;\n"
    "      let u = env.hmac(alg, pw, block);\n"
    "      const t = new Uint8Array(u);\n"
    "      for (let j = 1; j < iterations; j++) {\n"
    "        u = env.hmac(alg, pw, u);\n"
    "        for (let k = 0; k < hLen; k++) t[k] ^= u[k];\n"
    "      }\n"
    "      dk.set(t, (i - 1) * hLen);\n"
    "    }\n"
    "    return Buffer.from(dk.buffer, 0, keylen);\n"
    "  };\n"
    "  const pbkdf2 = (password, salt, iterations, keylen, digestAlg, callback) => {\n"
    "    if (typeof callback !== \"function\") {\n"
    "      const e = new TypeError('The \"callback\" argument must be of type function. Received undefined');\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    let derived;\n"
    "    try {\n"
    "      derived = pbkdf2Sync(password, salt, iterations, keylen, digestAlg);\n"
    "    } catch (err) {\n"
    "      queueMicrotask(() => callback(err));\n"
    "      return;\n"
    "    }\n"
    "    queueMicrotask(() => callback(null, derived));\n"
    "  };\n"
    "  const die = (name) => function unsupported() {\n"
    "    throw new Error(\"crypto.\" + name + \" is not available in the scriptc island (the embedded runtime carries the hashing/random slice only)\");\n"
    "  };\n"
    "  class KeyObject {\n"
    "    constructor() {\n"
    "      throw new Error(\"crypto.KeyObject is not available in the scriptc island (the embedded runtime carries the hashing/random slice only)\");\n"
    "    }\n"
    "  }\n"
    "  const constants = {\n"
    "    RSA_PKCS1_PADDING: 1,\n"
    "    RSA_NO_PADDING: 3,\n"
    "    RSA_PKCS1_OAEP_PADDING: 4,\n"
    "    RSA_PKCS1_PSS_PADDING: 6,\n"
    "    RSA_PSS_SALTLEN_DIGEST: -1,\n"
    "    RSA_PSS_SALTLEN_MAX_SIGN: -2,\n"
    "    RSA_PSS_SALTLEN_AUTO: -2,\n"
    "    defaultCoreCipherList: \"TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256\",\n"
    "  };\n"
    "  constants.defaultCipherList = constants.defaultCoreCipherList;\n"
    "  const crypto = {\n"
    "    createHash, createHmac, hash, Hash, Hmac,\n"
    "    randomBytes, randomFillSync, randomFill, randomInt, randomUUID,\n"
    "    getRandomValues: (ta) => webcrypto.getRandomValues(ta),\n"
    "    timingSafeEqual, pbkdf2, pbkdf2Sync,\n"
    "    getHashes: () => [\"md5\", \"sha1\", \"sha256\"],\n"
    "    getCiphers: () => [],\n"
    "    getCurves: () => [],\n"
    "    webcrypto,\n"
    "    constants,\n"
    "    KeyObject,\n"
    "    createCipheriv: die(\"createCipheriv\"),\n"
    "    createDecipheriv: die(\"createDecipheriv\"),\n"
    "    createSign: die(\"createSign\"),\n"
    "    createVerify: die(\"createVerify\"),\n"
    "    createDiffieHellman: die(\"createDiffieHellman\"),\n"
    "    createECDH: die(\"createECDH\"),\n"
    "    createPublicKey: die(\"createPublicKey\"),\n"
    "    createPrivateKey: die(\"createPrivateKey\"),\n"
    "    createSecretKey: die(\"createSecretKey\"),\n"
    "    diffieHellman: die(\"diffieHellman\"),\n"
    "    generateKeyPair: die(\"generateKeyPair\"),\n"
    "    generateKeyPairSync: die(\"generateKeyPairSync\"),\n"
    "    generateKey: die(\"generateKey\"),\n"
    "    generateKeySync: die(\"generateKeySync\"),\n"
    "    sign: die(\"sign\"),\n"
    "    verify: die(\"verify\"),\n"
    "    publicEncrypt: die(\"publicEncrypt\"),\n"
    "    publicDecrypt: die(\"publicDecrypt\"),\n"
    "    privateEncrypt: die(\"privateEncrypt\"),\n"
    "    privateDecrypt: die(\"privateDecrypt\"),\n"
    "    scrypt: die(\"scrypt\"),\n"
    "    scryptSync: die(\"scryptSync\"),\n"
    "    hkdf: die(\"hkdf\"),\n"
    "    hkdfSync: die(\"hkdfSync\"),\n"
    "    X509Certificate: die(\"X509Certificate\"),\n"
    "    Certificate: die(\"Certificate\"),\n"
    "    checkPrime: die(\"checkPrime\"),\n"
    "    checkPrimeSync: die(\"checkPrimeSync\"),\n"
    "    generatePrime: die(\"generatePrime\"),\n"
    "    generatePrimeSync: die(\"generatePrimeSync\"),\n"
    "    secureHeapUsed: die(\"secureHeapUsed\"),\n"
    "    setEngine: die(\"setEngine\"),\n"
    "    setFips: () => {},\n"
    "    getFips: () => 0,\n"
    "  };\n"
    "  crypto.subtle = webcrypto ? webcrypto.subtle : undefined;\n"
    "  return crypto;\n"
    "}\n"
    "    const mod = makeCrypto({ digest: (a, d) => host.digest(a, d), hmac: (a, k, d) => host.hmac(a, k, d), Buffer: builtins.buffer().Buffer });\n"
    "    mod.default = mod;\n"
    "    return mod;\n"
    "  });\n"
    /* node:stream (+ stream/promises, stream/consumers, stream/web) —
     * the five stream classes over the events shim, with Node's
     * observable ordering (state.sync deferral, prefinish ticks,
     * finish/end per final-hook presence), pipe chains with
     * drain-based backpressure, pipeline/finished both spellings,
     * and async iteration — differentially pinned against Node. */
    "  builtins.stream = memo(() => {\n"
    "function makeStream(env) {\n"
    "  const EventEmitter = env.EventEmitter;\n"
    "  const Buffer = env.Buffer;\n"
    "  const StringDecoder = env.StringDecoder;\n"
    "  const nextTick = env.nextTick;\n"
    "  const ERR_PREMATURE = () => {\n"
    "    const e = new Error(\"Premature close\");\n"
    "    e.code = \"ERR_STREAM_PREMATURE_CLOSE\";\n"
    "    return e;\n"
    "  };\n"
    "  const ERR_PUSH_AFTER_EOF = () => {\n"
    "    const e = new Error(\"stream.push() after EOF\");\n"
    "    e.code = \"ERR_STREAM_PUSH_AFTER_EOF\";\n"
    "    return e;\n"
    "  };\n"
    "  const ERR_WRITE_AFTER_END = () => {\n"
    "    const e = new Error(\"write after end\");\n"
    "    e.code = \"ERR_STREAM_WRITE_AFTER_END\";\n"
    "    return e;\n"
    "  };\n"
    "  const ERR_DESTROYED = (what) => {\n"
    "    const e = new Error(\"Cannot call \" + what + \" after a stream was destroyed\");\n"
    "    e.code = \"ERR_STREAM_DESTROYED\";\n"
    "    return e;\n"
    "  };\n"
    "  const ERR_METHOD_NOT_IMPLEMENTED = (name) => {\n"
    "    const e = new Error(\"The \" + name + \" method is not implemented\");\n"
    "    e.code = \"ERR_METHOD_NOT_IMPLEMENTED\";\n"
    "    return e;\n"
    "  };\n"
    "  class Stream extends EventEmitter {\n"
    "    constructor(opts) {\n"
    "      super();\n"
    "      void opts;\n"
    "    }\n"
    "    pipe(dest, options) {\n"
    "      return pipeImpl(this, dest, options);\n"
    "    }\n"
    "  }\n"
    "  const chunkOf = (stream, chunk, encoding) => {\n"
    "    if (stream._objectMode) return chunk;\n"
    "    if (typeof chunk === \"string\") return Buffer.from(chunk, encoding === undefined || encoding === null || encoding === \"buffer\" ? \"utf8\" : encoding);\n"
    "    return chunk;\n"
    "  };\n"
    "  class Readable extends Stream {\n"
    "    constructor(options) {\n"
    "      super();\n"
    "      const opts = options || {};\n"
    "      this._objectMode = !!(opts.objectMode || opts.readableObjectMode);\n"
    "      this._hwm = opts.highWaterMark !== undefined ? opts.highWaterMark\n"
    "        : opts.readableHighWaterMark !== undefined ? opts.readableHighWaterMark\n"
    "        : this._objectMode ? 16 : " ISL_STREAM_DEFAULT_HWM ";\n"
    "      if (typeof opts.read === \"function\") this._read = opts.read;\n"
    "      if (typeof opts.destroy === \"function\") this._destroy = opts.destroy;\n"
    "      this._rBuf = [];\n"
    "      this._rLen = 0;\n"
    "      this._sync = true; /* Node's state.sync: true at start and during _read */\n"
    "      this._flowing = null;\n"
    "      this._rEnded = false; /* push(null) seen */\n"
    "      this._rEmittedEnd = false;\n"
    "      this._reading = false;\n"
    "      this._readRequested = false;\n"
    "      this.destroyed = false;\n"
    "      this._rErrored = null;\n"
    "      this._decoder = null;\n"
    "      this._encoding = null;\n"
    "      this._closeEmitted = false;\n"
    "      if (opts.encoding) this.setEncoding(opts.encoding);\n"
    "      if (typeof opts.signal === \"object\" && opts.signal !== null && typeof opts.signal.addEventListener === \"function\") {\n"
    "        opts.signal.addEventListener(\"abort\", () => {\n"
    "          const e = new Error(\"The operation was aborted\");\n"
    "          e.code = \"ABORT_ERR\";\n"
    "          e.name = \"AbortError\";\n"
    "          this.destroy(e);\n"
    "        });\n"
    "      }\n"
    "    }\n"
    "    get readableEnded() { return this._rEmittedEnd; }\n"
    "    get readableFlowing() { return this._flowing; }\n"
    "    get readableLength() { return this._rLen; }\n"
    "    get readableHighWaterMark() { return this._hwm; }\n"
    "    get readableObjectMode() { return this._objectMode; }\n"
    "    get readable() {\n"
    "      return !this._rEmittedEnd && !this.destroyed && this._rErrored === null;\n"
    "    }\n"
    "    get errored() { return this._rErrored; }\n"
    "    get closed() { return this._closeEmitted; }\n"
    "    _read() {\n"
    "      throw ERR_METHOD_NOT_IMPLEMENTED(\"_read()\");\n"
    "    }\n"
    "    setEncoding(enc) {\n"
    "      this._decoder = new StringDecoder(enc);\n"
    "      this._encoding = this._decoder.encoding;\n"
    "      if (this._rBuf.length) {\n"
    "        const chunks = this._rBuf;\n"
    "        this._rBuf = [];\n"
    "        this._rLen = 0;\n"
    "        for (const c of chunks) {\n"
    "          const s = typeof c === \"string\" ? c : this._decoder.write(c);\n"
    "          if (s.length) {\n"
    "            this._rBuf.push(s);\n"
    "            this._rLen += s.length;\n"
    "          }\n"
    "        }\n"
    "      }\n"
    "      return this;\n"
    "    }\n"
    "    push(chunk, encoding) {\n"
    "      if (chunk === null) {\n"
    "        this._rEnded = true;\n"
    "        this._maybeEmitEnd();\n"
    "        return false;\n"
    "      }\n"
    "      if (this._rEmittedEnd || (this._rEnded && !this._objectMode)) {\n"
    "        this.emit(\"error\", ERR_PUSH_AFTER_EOF());\n"
    "        return false;\n"
    "      }\n"
    "      let c = chunkOf(this, chunk, encoding);\n"
    "      if (this._decoder && typeof c !== \"string\") {\n"
    "        c = this._decoder.write(c);\n"
    "        if (c.length === 0) return !this._rEnded && this._rLen < this._hwm;\n"
    "      }\n"
    "      this._rBuf.push(c);\n"
    "      this._rLen += this._objectMode ? 1 : c.length;\n"
    "      this._pushed = true;\n"
    "      if (this._flowing === true && this._rLen === (this._objectMode ? 1 : c.length) && !this._sync && !this._reading) {\n"
    "        this._takeChunk();\n"
    "        this.emit(\"data\", c);\n"
    "      } else if (this._flowing === true) {\n"
    "        if (!this._reading) nextTick(() => this._emitData());\n"
    "      } else {\n"
    "        nextTick(() => this.emit(\"readable\"));\n"
    "      }\n"
    "      return !this._rEnded && this._rLen < this._hwm;\n"
    "    }\n"
    "    unshift(chunk, encoding) {\n"
    "      if (chunk === null || chunk === undefined) return;\n"
    "      let c = chunkOf(this, chunk, encoding);\n"
    "      if (this._decoder && typeof c !== \"string\") c = this._decoder.write(c);\n"
    "      this._rBuf.unshift(c);\n"
    "      this._rLen += this._objectMode ? 1 : c.length;\n"
    "    }\n"
    "    _callRead() {\n"
    "      while (!this._reading && !this._rEnded && !this.destroyed) {\n"
    "        this._reading = true;\n"
    "        this._pushed = false;\n"
    "        this._sync = true;\n"
    "        try {\n"
    "          this._read(this._hwm);\n"
    "        } catch (err) {\n"
    "          this.destroy(err);\n"
    "        }\n"
    "        this._sync = false;\n"
    "        this._reading = false;\n"
    "        if (this._flowing === true) this._drainData();\n"
    "        else this._maybeEmitEnd();\n"
    "        if (!(this._flowing === true && this._pushed && !this._rEnded && !this.destroyed)) break;\n"
    "      }\n"
    "    }\n"
    "    _drainData() {\n"
    "      while (this._flowing === true && this._rBuf.length > 0 && !this.destroyed) {\n"
    "        const c = this._takeChunk();\n"
    "        this.emit(\"data\", c);\n"
    "      }\n"
    "      this._maybeEmitEnd();\n"
    "    }\n"
    "    _emitData() {\n"
    "      this._drainData();\n"
    "      if (this._flowing === true && !this._rEnded && !this.destroyed) {\n"
    "        this._callRead();\n"
    "      }\n"
    "    }\n"
    "    _takeChunk() {\n"
    "      const c = this._rBuf.shift();\n"
    "      this._rLen -= this._objectMode ? 1 : c.length;\n"
    "      return c;\n"
    "    }\n"
    "    _maybeEmitEnd() {\n"
    "      if (this._rEnded && this._rBuf.length === 0 && !this._rEmittedEnd && !this.destroyed) {\n"
    "        this._rEmittedEnd = true;\n"
    "        if (this._decoder) {\n"
    "          const tail = this._decoder.end();\n"
    "          if (tail.length) {\n"
    "            this._rEmittedEnd = false;\n"
    "            this._rBuf.push(tail);\n"
    "            this._rLen += tail.length;\n"
    "            if (this._flowing === true) this._emitData();\n"
    "            return;\n"
    "          }\n"
    "        }\n"
    "        nextTick(() => {\n"
    "          this.emit(\"end\");\n"
    "          this._maybeClose();\n"
    "        });\n"
    "      }\n"
    "    }\n"
    "    _maybeClose() {\n"
    "      if (this._closeEmitted || this.destroyed) return;\n"
    "      this._closeEmitted = true;\n"
    "      nextTick(() => this.emit(\"close\"));\n"
    "    }\n"
    "    read(n) {\n"
    "      if (this._rBuf.length === 0) {\n"
    "        this._callRead();\n"
    "      }\n"
    "      if (this._rBuf.length === 0) {\n"
    "        this._maybeEmitEnd();\n"
    "        return null;\n"
    "      }\n"
    "      if (n === undefined || n === null) {\n"
    "        if (this._objectMode) return this._takeChunk();\n"
    "        let out;\n"
    "        if (typeof this._rBuf[0] === \"string\") {\n"
    "          out = this._rBuf.join(\"\");\n"
    "        } else {\n"
    "          out = Buffer.concat(this._rBuf);\n"
    "        }\n"
    "        this._rBuf = [];\n"
    "        this._rLen = 0;\n"
    "        this._maybeEmitEnd();\n"
    "        return out;\n"
    "      }\n"
    "      if (this._objectMode) return this._takeChunk();\n"
    "      if (n <= 0) return null;\n"
    "      if (this._rLen === 0) return null;\n"
    "      if (n >= this._rLen) return this.read();\n"
    "      let out;\n"
    "      if (typeof this._rBuf[0] === \"string\") {\n"
    "        let s = \"\";\n"
    "        while (s.length < n && this._rBuf.length) {\n"
    "          const c = this._takeChunk();\n"
    "          if (s.length + c.length <= n) {\n"
    "            s += c;\n"
    "          } else {\n"
    "            const take = n - s.length;\n"
    "            s += c.slice(0, take);\n"
    "            this._rBuf.unshift(c.slice(take));\n"
    "            this._rLen += c.length - take;\n"
    "          }\n"
    "        }\n"
    "        out = s;\n"
    "      } else {\n"
    "        const parts = [];\n"
    "        let got = 0;\n"
    "        while (got < n && this._rBuf.length) {\n"
    "          const c = this._takeChunk();\n"
    "          if (got + c.length <= n) {\n"
    "            parts.push(c);\n"
    "            got += c.length;\n"
    "          } else {\n"
    "            const take = n - got;\n"
    "            parts.push(c.subarray(0, take));\n"
    "            this._rBuf.unshift(c.subarray(take));\n"
    "            this._rLen += c.length - take;\n"
    "            got = n;\n"
    "          }\n"
    "        }\n"
    "        out = Buffer.concat(parts);\n"
    "      }\n"
    "      this._maybeEmitEnd();\n"
    "      return out;\n"
    "    }\n"
    "    on(name, fn) {\n"
    "      super.on(name, fn);\n"
    "      if (name === \"data\") {\n"
    "        if (this._flowing !== false) {\n"
    "          this._flowing = true;\n"
    "          nextTick(() => this._emitData());\n"
    "        }\n"
    "      } else if (name === \"readable\") {\n"
    "        if (this._rBuf.length > 0 || this._rEnded) {\n"
    "          nextTick(() => this.emit(\"readable\"));\n"
    "        } else {\n"
    "          nextTick(() => this._callRead());\n"
    "        }\n"
    "      }\n"
    "      return this;\n"
    "    }\n"
    "    addListener(name, fn) { return this.on(name, fn); }\n"
    "    pause() {\n"
    "      this._flowing = false;\n"
    "      return this;\n"
    "    }\n"
    "    resume() {\n"
    "      if (this._flowing !== true) {\n"
    "        this._flowing = true;\n"
    "        nextTick(() => this._emitData());\n"
    "      }\n"
    "      return this;\n"
    "    }\n"
    "    isPaused() { return this._flowing === false; }\n"
    "    _destroy(err, cb) { cb(err); }\n"
    "    destroy(err) {\n"
    "      if (this.destroyed) return this;\n"
    "      this.destroyed = true;\n"
    "      this._rErrored = err || null;\n"
    "      this._destroy(err || null, (er) => {\n"
    "        if (er) nextTick(() => this.emit(\"error\", er));\n"
    "        else if (err) nextTick(() => this.emit(\"error\", err));\n"
    "        if (!this._closeEmitted) {\n"
    "          this._closeEmitted = true;\n"
    "          nextTick(() => this.emit(\"close\"));\n"
    "        }\n"
    "      });\n"
    "      return this;\n"
    "    }\n"
    "    unpipe(dest) {\n"
    "      unpipeImpl(this, dest);\n"
    "      return this;\n"
    "    }\n"
    "    wrap() { throw ERR_METHOD_NOT_IMPLEMENTED(\"wrap()\"); }\n"
    "    [Symbol.asyncIterator]() {\n"
    "      const stream = this;\n"
    "      let done = false;\n"
    "      return {\n"
    "        next() {\n"
    "          return new Promise((resolve, reject) => {\n"
    "            if (done || stream._rEmittedEnd) {\n"
    "              done = true;\n"
    "              resolve({ value: undefined, done: true });\n"
    "              return;\n"
    "            }\n"
    "            const tryRead = () => {\n"
    "              const c = stream.read();\n"
    "              if (c !== null) {\n"
    "                cleanup();\n"
    "                resolve({ value: c, done: false });\n"
    "                return true;\n"
    "              }\n"
    "              if (stream._rEmittedEnd || (stream._rEnded && stream._rBuf.length === 0)) {\n"
    "                cleanup();\n"
    "                done = true;\n"
    "                resolve({ value: undefined, done: true });\n"
    "                return true;\n"
    "              }\n"
    "              return false;\n"
    "            };\n"
    "            const onReadable = () => { tryRead(); };\n"
    "            const onEnd = () => {\n"
    "              cleanup();\n"
    "              done = true;\n"
    "              resolve({ value: undefined, done: true });\n"
    "            };\n"
    "            const onError = (err) => {\n"
    "              cleanup();\n"
    "              done = true;\n"
    "              reject(err);\n"
    "            };\n"
    "            const cleanup = () => {\n"
    "              stream.removeListener(\"readable\", onReadable);\n"
    "              stream.removeListener(\"end\", onEnd);\n"
    "              stream.removeListener(\"error\", onError);\n"
    "            };\n"
    "            if (tryRead()) return;\n"
    "            stream.on(\"readable\", onReadable);\n"
    "            stream.on(\"end\", onEnd);\n"
    "            stream.on(\"error\", onError);\n"
    "          });\n"
    "        },\n"
    "        return() {\n"
    "          done = true;\n"
    "          stream.destroy();\n"
    "          return Promise.resolve({ value: undefined, done: true });\n"
    "        },\n"
    "        [Symbol.asyncIterator]() { return this; },\n"
    "      };\n"
    "    }\n"
    "    static from(iterable) {\n"
    "      const r = new Readable({ objectMode: true, read() {} });\n"
    "      (async () => {\n"
    "        try {\n"
    "          if (typeof iterable === \"string\" || iterable instanceof Buffer || iterable instanceof Uint8Array) {\n"
    "            r.push(iterable);\n"
    "          } else {\n"
    "            for await (const chunk of iterable) r.push(chunk);\n"
    "          }\n"
    "          r.push(null);\n"
    "        } catch (err) {\n"
    "          r.destroy(err);\n"
    "        }\n"
    "      })();\n"
    "      return r;\n"
    "    }\n"
    "  }\n"
    "  const pipeImpl = (src, dest, options) => {\n"
    "    const endOnFinish = !options || options.end !== false;\n"
    "    const onData = (chunk) => {\n"
    "      const ok = dest.write(chunk);\n"
    "      if (ok === false) src.pause();\n"
    "    };\n"
    "    const onDrain = () => src.resume();\n"
    "    const onEnd = () => {\n"
    "      if (endOnFinish) dest.end();\n"
    "    };\n"
    "    src.on(\"data\", onData);\n"
    "    dest.on(\"drain\", onDrain);\n"
    "    src.on(\"end\", onEnd);\n"
    "    const cleanup = () => {\n"
    "      src.removeListener(\"data\", onData);\n"
    "      dest.removeListener(\"drain\", onDrain);\n"
    "      src.removeListener(\"end\", onEnd);\n"
    "    };\n"
    "    if (!src._pipes) src._pipes = [];\n"
    "    src._pipes.push({ dest, cleanup });\n"
    "    dest.emit(\"pipe\", src);\n"
    "    return dest;\n"
    "  };\n"
    "  const unpipeImpl = (src, dest) => {\n"
    "    if (!src._pipes) return;\n"
    "    for (let i = src._pipes.length - 1; i >= 0; i--) {\n"
    "      if (dest === undefined || src._pipes[i].dest === dest) {\n"
    "        src._pipes[i].cleanup();\n"
    "        const d = src._pipes[i].dest;\n"
    "        src._pipes.splice(i, 1);\n"
    "        d.emit(\"unpipe\", src);\n"
    "      }\n"
    "    }\n"
    "  };\n"
    "  class Writable extends Stream {\n"
    "    constructor(options) {\n"
    "      super();\n"
    "      const opts = options || {};\n"
    "      this._objectMode = !!(opts.objectMode || opts.writableObjectMode);\n"
    "      this._wom = this._objectMode;\n"
    "      this._whwm = opts.highWaterMark !== undefined ? opts.highWaterMark\n"
    "        : opts.writableHighWaterMark !== undefined ? opts.writableHighWaterMark\n"
    "        : this._wom ? 16 : " ISL_STREAM_DEFAULT_HWM ";\n"
    "      if (typeof opts.write === \"function\") this._write = opts.write;\n"
    "      if (typeof opts.writev === \"function\") this._writev = opts.writev;\n"
    "      if (typeof opts.final === \"function\") this._final = opts.final;\n"
    "      if (typeof opts.destroy === \"function\") this._destroy = opts.destroy;\n"
    "      this._decodeStrings = opts.decodeStrings !== false;\n"
    "      this._wQueue = [];\n"
    "      this._wLen = 0;\n"
    "      this._writing = false;\n"
    "      this._wEnded = false;\n"
    "      this._wFinished = false;\n"
    "      this._needDrain = false;\n"
    "      this.destroyed = false;\n"
    "      this._wErrored = null;\n"
    "      this._wCloseEmitted = false;\n"
    "      this._defaultEncoding = opts.defaultEncoding || \"utf8\";\n"
    "    }\n"
    "    get writableEnded() { return this._wEnded; }\n"
    "    get writableFinished() { return this._wFinished; }\n"
    "    get writableLength() { return this._wLen; }\n"
    "    get writableHighWaterMark() { return this._whwm; }\n"
    "    get writableObjectMode() { return this._wom; }\n"
    "    get writable() {\n"
    "      return !this._wEnded && !this.destroyed && this._wErrored === null;\n"
    "    }\n"
    "    get errored() { return this._wErrored; }\n"
    "    get closed() { return this._wCloseEmitted; }\n"
    "    _write(chunk, encoding, callback) {\n"
    "      if (this._writev) {\n"
    "        this._writev([{ chunk, encoding }], callback);\n"
    "        return;\n"
    "      }\n"
    "      throw ERR_METHOD_NOT_IMPLEMENTED(\"_write()\");\n"
    "    }\n"
    "    write(chunk, encoding, callback) {\n"
    "      if (typeof encoding === \"function\") {\n"
    "        callback = encoding;\n"
    "        encoding = null;\n"
    "      }\n"
    "      if (this._wEnded) {\n"
    "        const err = ERR_WRITE_AFTER_END();\n"
    "        nextTick(() => {\n"
    "          if (typeof callback === \"function\") callback(err);\n"
    "          this.emit(\"error\", err);\n"
    "        });\n"
    "        return false;\n"
    "      }\n"
    "      if (this.destroyed) {\n"
    "        const err = ERR_DESTROYED(\"write\");\n"
    "        nextTick(() => {\n"
    "          if (typeof callback === \"function\") callback(err);\n"
    "          this.emit(\"error\", err);\n"
    "        });\n"
    "        return false;\n"
    "      }\n"
    "      let c = chunk;\n"
    "      let enc = encoding || this._defaultEncoding;\n"
    "      if (!this._wom && typeof chunk === \"string\" && this._decodeStrings) {\n"
    "        c = Buffer.from(chunk, enc);\n"
    "        enc = \"buffer\";\n"
    "      } else if (!this._wom && typeof chunk !== \"string\") {\n"
    "        enc = \"buffer\";\n"
    "      }\n"
    "      this._wQueue.push({ chunk: c, encoding: enc, callback });\n"
    "      this._wLen += this._wom ? 1 : (c.length !== undefined ? c.length : 1);\n"
    "      const ret = this._wLen < this._whwm;\n"
    "      if (!ret) this._needDrain = true;\n"
    "      this._processWrites();\n"
    "      return ret;\n"
    "    }\n"
    "    _processWrites() {\n"
    "      if (this._writing || this.destroyed) return;\n"
    "      const entry = this._wQueue.shift();\n"
    "      if (entry === undefined) {\n"
    "        if (this._wEnded && !this._wFinished && !this._finalCalled) {\n"
    "          this._finalCalled = true;\n"
    "          if (this._final) nextTick(() => this._runFinal());\n"
    "          else this._runFinal();\n"
    "        }\n"
    "        if (this._needDrain && !this._wEnded) {\n"
    "          this._needDrain = false;\n"
    "          nextTick(() => this.emit(\"drain\"));\n"
    "        }\n"
    "        return;\n"
    "      }\n"
    "      this._runWrite(entry);\n"
    "    }\n"
    "    _runFinal() {\n"
    "      const finish = (err) => {\n"
    "        if (err) {\n"
    "          this.destroy(err);\n"
    "          return;\n"
    "        }\n"
    "        this._wFinished = true;\n"
    "        nextTick(() => {\n"
    "          this.emit(\"finish\");\n"
    "          this._maybeCloseW();\n"
    "        });\n"
    "      };\n"
    "      if (this._final) {\n"
    "        try {\n"
    "          this._final.call(this, finish);\n"
    "        } catch (err) {\n"
    "          finish(err);\n"
    "        }\n"
    "      } else {\n"
    "        finish();\n"
    "      }\n"
    "    }\n"
    "    _runWrite(entry) {\n"
    "      this._writing = true;\n"
    "      const done = (err) => {\n"
    "        this._writing = false;\n"
    "        this._wLen -= this._wom ? 1 : (entry.chunk.length !== undefined ? entry.chunk.length : 1);\n"
    "        if (typeof entry.callback === \"function\") {\n"
    "          nextTick(() => entry.callback(err || null));\n"
    "        }\n"
    "        if (err) {\n"
    "          this.destroy(err);\n"
    "          return;\n"
    "        }\n"
    "        nextTick(() => this._processWrites());\n"
    "      };\n"
    "      try {\n"
    "        this._write.call(this, entry.chunk, entry.encoding, done);\n"
    "      } catch (err) {\n"
    "        done(err);\n"
    "      }\n"
    "    }\n"
    "    end(chunk, encoding, callback) {\n"
    "      if (typeof chunk === \"function\") {\n"
    "        callback = chunk;\n"
    "        chunk = null;\n"
    "        encoding = null;\n"
    "      } else if (typeof encoding === \"function\") {\n"
    "        callback = encoding;\n"
    "        encoding = null;\n"
    "      }\n"
    "      if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);\n"
    "      this._wEnded = true;\n"
    "      if (typeof callback === \"function\") {\n"
    "        if (this._wFinished) nextTick(callback);\n"
    "        else if (typeof this.prependOnceListener === \"function\") this.prependOnceListener(\"finish\", () => callback());\n"
    "        else this.once(\"finish\", () => callback());\n"
    "      }\n"
    "      this._processWrites();\n"
    "      return this;\n"
    "    }\n"
    "    cork() {}\n"
    "    uncork() {}\n"
    "    setDefaultEncoding(enc) {\n"
    "      this._defaultEncoding = enc;\n"
    "      return this;\n"
    "    }\n"
    "    _destroy(err, cb) { cb(err); }\n"
    "    destroy(err) {\n"
    "      if (this.destroyed) return this;\n"
    "      this.destroyed = true;\n"
    "      this._wErrored = err || null;\n"
    "      this._destroy(err || null, (er) => {\n"
    "        const finalErr = er || err;\n"
    "        if (finalErr) nextTick(() => this.emit(\"error\", finalErr));\n"
    "        this._maybeCloseW();\n"
    "      });\n"
    "      return this;\n"
    "    }\n"
    "    _maybeCloseW() {\n"
    "      if (this._wCloseEmitted) return;\n"
    "      this._wCloseEmitted = true;\n"
    "      nextTick(() => this.emit(\"close\"));\n"
    "    }\n"
    "  }\n"
    "  class Duplex extends Readable {\n"
    "    constructor(options) {\n"
    "      super(options);\n"
    "      const opts = options || {};\n"
    "      const w = new Writable(opts);\n"
    "      this._wSide = w;\n"
    "      this._whwm = w._whwm;\n"
    "      this._wQueue = w._wQueue;\n"
    "      if (typeof opts.write === \"function\") this._write = opts.write;\n"
    "      if (typeof opts.writev === \"function\") this._writev = opts.writev;\n"
    "      if (typeof opts.final === \"function\") this._final = opts.final;\n"
    "      this._wObjectMode = !!(opts.objectMode || opts.writableObjectMode);\n"
    "      this._decodeStrings = opts.decodeStrings !== false;\n"
    "      this._wLen = 0;\n"
    "      this._writing = false;\n"
    "      this._wEnded = false;\n"
    "      this._wFinished = false;\n"
    "      this._needDrain = false;\n"
    "      this._wErrored = null;\n"
    "      this._wCloseEmitted = false;\n"
    "      this._finalCalled = false;\n"
    "      this._defaultEncoding = opts.defaultEncoding || \"utf8\";\n"
    "      this.allowHalfOpen = opts.allowHalfOpen !== false;\n"
    "    }\n"
    "    get writableEnded() { return this._wEnded; }\n"
    "    get writableFinished() { return this._wFinished; }\n"
    "    get writableLength() { return this._wLen; }\n"
    "    get writableHighWaterMark() { return this._whwm; }\n"
    "    get writableObjectMode() { return this._wom; }\n"
    "    get writable() {\n"
    "      return !this._wEnded && !this.destroyed && this._wErrored === null;\n"
    "    }\n"
    "  }\n"
    "  for (const m of [\"_write\", \"write\", \"_processWrites\", \"_runFinal\", \"_runWrite\", \"end\", \"cork\", \"uncork\", \"setDefaultEncoding\", \"_maybeCloseW\"]) {\n"
    "    Duplex.prototype[m] = Writable.prototype[m];\n"
    "  }\n"
    "  Duplex.prototype._maybeCloseW = function () {\n"
    "    this._maybeClose();\n"
    "  };\n"
    "  class Transform extends Duplex {\n"
    "    constructor(options) {\n"
    "      super(options);\n"
    "      const opts = options || {};\n"
    "      if (typeof opts.transform === \"function\") this._transform = opts.transform;\n"
    "      if (typeof opts.flush === \"function\") this._flush = opts.flush;\n"
    "    }\n"
    "    _read() {}\n"
    "    _transform() {\n"
    "      throw ERR_METHOD_NOT_IMPLEMENTED(\"_transform()\");\n"
    "    }\n"
    "    _write(chunk, encoding, callback) {\n"
    "      try {\n"
    "        this._transform.call(this, chunk, encoding, (err, data) => {\n"
    "          if (err) {\n"
    "            callback(err);\n"
    "            return;\n"
    "          }\n"
    "          if (data !== undefined && data !== null) this.push(data);\n"
    "          callback();\n"
    "        });\n"
    "      } catch (err) {\n"
    "        callback(err);\n"
    "      }\n"
    "    }\n"
    "    _final(callback) {\n"
    "      if (this._flushCalled) {\n"
    "        callback();\n"
    "        return;\n"
    "      }\n"
    "      this._flushCalled = true;\n"
    "      if (this._flush) {\n"
    "        try {\n"
    "          this._flush.call(this, (err, data) => {\n"
    "            if (err) {\n"
    "              callback(err);\n"
    "              return;\n"
    "            }\n"
    "            if (data !== undefined && data !== null) this.push(data);\n"
    "            this.push(null);\n"
    "            callback();\n"
    "          });\n"
    "        } catch (err) {\n"
    "          callback(err);\n"
    "        }\n"
    "      } else {\n"
    "        this.push(null);\n"
    "        callback();\n"
    "      }\n"
    "    }\n"
    "  }\n"
    "  class PassThrough extends Transform {\n"
    "    _transform(chunk, encoding, callback) {\n"
    "      callback(null, chunk);\n"
    "    }\n"
    "  }\n"
    "  const isReadableLike = (s) => s instanceof Readable || (s && typeof s.on === \"function\" && typeof s.read === \"function\" && typeof s.write !== \"function\");\n"
    "  const finished = (stream, opts, callback) => {\n"
    "    if (typeof opts === \"function\") {\n"
    "      callback = opts;\n"
    "      opts = {};\n"
    "    }\n"
    "    let called = false;\n"
    "    const done = (err) => {\n"
    "      if (called) return;\n"
    "      called = true;\n"
    "      cleanup();\n"
    "      callback.call(stream, err);\n"
    "    };\n"
    "    const readable = typeof stream.push === \"function\" || typeof stream.read === \"function\";\n"
    "    const writable = typeof stream.write === \"function\";\n"
    "    let readableEnded = !readable || stream._rEmittedEnd === true;\n"
    "    let writableFinished = !writable || stream._wFinished === true;\n"
    "    const onEnd = () => {\n"
    "      readableEnded = true;\n"
    "      if (writableFinished) done(null);\n"
    "    };\n"
    "    const onFinish = () => {\n"
    "      writableFinished = true;\n"
    "      if (readableEnded) done(null);\n"
    "    };\n"
    "    const onError = (err) => done(err);\n"
    "    const onClose = () => {\n"
    "      if (readableEnded && writableFinished) {\n"
    "        done(null);\n"
    "      } else if (stream.destroyed && stream.errored) {\n"
    "        done(stream.errored);\n"
    "      } else {\n"
    "        done(ERR_PREMATURE());\n"
    "      }\n"
    "    };\n"
    "    const cleanup = () => {\n"
    "      stream.removeListener(\"end\", onEnd);\n"
    "      stream.removeListener(\"finish\", onFinish);\n"
    "      stream.removeListener(\"error\", onError);\n"
    "      stream.removeListener(\"close\", onClose);\n"
    "    };\n"
    "    if (readableEnded && writableFinished) {\n"
    "      nextTick(() => done(null));\n"
    "      return () => {};\n"
    "    }\n"
    "    if (stream.destroyed) {\n"
    "      nextTick(() => onClose());\n"
    "      return () => {};\n"
    "    }\n"
    "    stream.on(\"end\", onEnd);\n"
    "    stream.on(\"finish\", onFinish);\n"
    "    stream.on(\"error\", onError);\n"
    "    stream.on(\"close\", onClose);\n"
    "    return cleanup;\n"
    "  };\n"
    "  const pipeline = (...args) => {\n"
    "    const callback = args.pop();\n"
    "    if (typeof callback !== \"function\") {\n"
    "      const e = new TypeError('The \"callback\" argument must be of type function');\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    let streams = Array.isArray(args[0]) && args.length === 1 ? args[0] : args;\n"
    "    if (streams.length < 2) {\n"
    "      const e = new TypeError(\"The `streams` argument must be specified\");\n"
    "      e.code = \"ERR_MISSING_ARGS\";\n"
    "      throw e;\n"
    "    }\n"
    "    if (typeof streams[0][Symbol.asyncIterator] === \"function\" && typeof streams[0].pipe !== \"function\") {\n"
    "      streams = [Readable.from(streams[0]), ...streams.slice(1)];\n"
    "    } else if (typeof streams[0][Symbol.iterator] === \"function\" && typeof streams[0].pipe !== \"function\" && typeof streams[0] !== \"string\") {\n"
    "      streams = [Readable.from(streams[0]), ...streams.slice(1)];\n"
    "    }\n"
    "    let settled = false;\n"
    "    const tail = streams[streams.length - 1];\n"
    "    const settle = (err) => {\n"
    "      if (settled) return;\n"
    "      settled = true;\n"
    "      if (err) {\n"
    "        for (const s of streams) {\n"
    "          if (typeof s.destroy === \"function\" && !s.destroyed) s.destroy(err);\n"
    "        }\n"
    "      }\n"
    "      callback(err || null);\n"
    "    };\n"
    "    for (let i = 0; i < streams.length; i++) {\n"
    "      streams[i].on(\"error\", (err) => settle(err));\n"
    "    }\n"
    "    finished(tail, (err) => settle(err));\n"
    "    for (let i = 0; i < streams.length - 1; i++) {\n"
    "      streams[i].pipe(streams[i + 1]);\n"
    "    }\n"
    "    return tail;\n"
    "  };\n"
    "  const promises = {\n"
    "    pipeline: (...streams) => new Promise((resolve, reject) => {\n"
    "      pipeline(...streams, (err) => (err ? reject(err) : resolve()));\n"
    "    }),\n"
    "    finished: (stream, opts) => new Promise((resolve, reject) => {\n"
    "      finished(stream, opts || {}, (err) => (err ? reject(err) : resolve()));\n"
    "    }),\n"
    "  };\n"
    "  const consumers = {\n"
    "    text: async (stream) => {\n"
    "      let out = \"\";\n"
    "      const dec = new StringDecoder(\"utf8\");\n"
    "      for await (const chunk of stream) {\n"
    "        out += typeof chunk === \"string\" ? chunk : dec.write(chunk);\n"
    "      }\n"
    "      out += dec.end();\n"
    "      return out;\n"
    "    },\n"
    "    buffer: async (stream) => {\n"
    "      const parts = [];\n"
    "      for await (const chunk of stream) {\n"
    "        parts.push(typeof chunk === \"string\" ? Buffer.from(chunk) : Buffer.from(chunk.buffer === undefined ? chunk : chunk));\n"
    "      }\n"
    "      return Buffer.concat(parts);\n"
    "    },\n"
    "    arrayBuffer: async (stream) => {\n"
    "      const buf = await consumers.buffer(stream);\n"
    "      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);\n"
    "    },\n"
    "    json: async (stream) => JSON.parse(await consumers.text(stream)),\n"
    "    blob: async () => {\n"
    "      throw new Error(\"stream.consumers.blob is not available in the scriptc island\");\n"
    "    },\n"
    "  };\n"
    "  const addAbortSignal = (signal, stream) => {\n"
    "    if (signal && typeof signal.addEventListener === \"function\") {\n"
    "      signal.addEventListener(\"abort\", () => {\n"
    "        const e = new Error(\"The operation was aborted\");\n"
    "        e.code = \"ABORT_ERR\";\n"
    "        e.name = \"AbortError\";\n"
    "        stream.destroy(e);\n"
    "      });\n"
    "    }\n"
    "    return stream;\n"
    "  };\n"
    "  Stream.Stream = Stream;\n"
    "  Stream.Readable = Readable;\n"
    "  Stream.Writable = Writable;\n"
    "  Stream.Duplex = Duplex;\n"
    "  Stream.Transform = Transform;\n"
    "  Stream.PassThrough = PassThrough;\n"
    "  Stream.pipeline = pipeline;\n"
    "  Stream.finished = finished;\n"
    "  Stream.addAbortSignal = addAbortSignal;\n"
    "  Stream.promises = promises;\n"
    "  Stream.isErrored = (s) => !!(s && s.errored);\n"
    "  Stream.isDestroyed = (s) => !!(s && s.destroyed);\n"
    "  Stream.isReadable = (s) => !!(s && s.readable);\n"
    "  Stream.isWritable = (s) => !!(s && s.writable);\n"
    "  void isReadableLike;\n"
    "  return { Stream, Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, addAbortSignal, promises, consumers };\n"
    "}\n"
    "    const mod = makeStream({ EventEmitter: builtins.events(), Buffer: builtins.buffer().Buffer, StringDecoder: builtins.string_decoder().StringDecoder, nextTick: (fn) => queueMicrotask(fn) });\n"
    "    const s = mod.Stream;\n"
    "    s.default = s;\n"
    "    return s;\n"
    "  });\n"
    "  builtins['stream/promises'] = memo(() => {\n"
    "    const p = { ...builtins.stream().promises };\n"
    "    p.default = p;\n"
    "    return p;\n"
    "  });\n"
    /* stream/consumers lives on the shim factory result; the stream
     * module itself does not re-export it (Node's layout). */
    "  builtins['stream/consumers'] = memo(() => {\n"
    "    const Buffer = builtins.buffer().Buffer;\n"
    "    const SD = builtins.string_decoder().StringDecoder;\n"
    "    const text = async (stream) => {\n"
    "      let out = '';\n"
    "      const d = new SD('utf8');\n"
    "      for await (const chunk of stream) out += typeof chunk === 'string' ? chunk : d.write(chunk);\n"
    "      return out + d.end();\n"
    "    };\n"
    "    const buffer = async (stream) => {\n"
    "      const parts = [];\n"
    "      for await (const chunk of stream) parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));\n"
    "      return Buffer.concat(parts);\n"
    "    };\n"
    "    const arrayBuffer = async (stream) => {\n"
    "      const b = await buffer(stream);\n"
    "      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);\n"
    "    };\n"
    "    const json = async (stream) => JSON.parse(await text(stream));\n"
    "    const blob = async () => { throw new Error('stream.consumers.blob is not available in the scriptc island'); };\n"
    "    const c = { text, buffer, arrayBuffer, json, blob };\n"
    "    c.default = c;\n"
    "    return c;\n"
    "  });\n"
    /* stream/web re-exports the web prelude's classes; names the
     * prelude does not carry stay undefined (honest absence). */
    "  builtins['stream/web'] = memo(() => {\n"
    "    const g = globalThis;\n"
    "    const w = {\n"
    "      ReadableStream: g.ReadableStream, WritableStream: g.WritableStream,\n"
    "      TransformStream: g.TransformStream, TextEncoderStream: g.TextEncoderStream,\n"
    "      TextDecoderStream: g.TextDecoderStream,\n"
    "      CountQueuingStrategy: g.CountQueuingStrategy, ByteLengthQueuingStrategy: g.ByteLengthQueuingStrategy,\n"
    "      ReadableStreamDefaultReader: g.ReadableStreamDefaultReader,\n"
    "      ReadableStreamDefaultController: g.ReadableStreamDefaultController,\n"
    "      WritableStreamDefaultWriter: g.WritableStreamDefaultWriter,\n"
    "    };\n"
    "    w.default = w;\n"
    "    return w;\n"
    "  });\n"
    /* node:assert (+ assert/strict) — the assertion surface over
     * util's deep-equality machinery, matching Node's codes,
     * operators, and simple generated-message forms (rich diff
     * bodies and call-source introspection are not carried —
     * documented divergence). */
    "  builtins.assert = memo(() => {\n"
    "function makeAssert(env) {\n"
    "  const isDeepStrictEqual = env.isDeepStrictEqual;\n"
    "  const inspect = env.inspect;\n"
    "  class AssertionError extends Error {\n"
    "    constructor(options) {\n"
    "      const opts = options || {};\n"
    "      let message = opts.message;\n"
    "      let generated = false;\n"
    "      if (message === undefined || message === null) {\n"
    "        generated = true;\n"
    "        const a = inspect(opts.actual, { depth: 2 });\n"
    "        const b = inspect(opts.expected, { depth: 2 });\n"
    "        switch (opts.operator) {\n"
    "          case \"strictEqual\":\n"
    "            message = \"Expected values to be strictly equal:\\n\\n\" + a + \" !== \" + b + \"\\n\";\n"
    "            break;\n"
    "          case \"notStrictEqual\":\n"
    "            message = \"Expected \\\"actual\\\" to be strictly unequal to: \" + b;\n"
    "            break;\n"
    "          case \"deepStrictEqual\":\n"
    "            message = \"Expected values to be strictly deep-equal:\\n\\n\" + a + \" !== \" + b + \"\\n\";\n"
    "            break;\n"
    "          case \"notDeepStrictEqual\":\n"
    "            message = \"Expected \\\"actual\\\" not to be strictly deep-equal to:\\n\\n\" + b + \"\\n\";\n"
    "            break;\n"
    "          case \"==\":\n"
    "            message = \"Expected values to be loosely equal:\\n\\n\" + a + \" != \" + b + \"\\n\";\n"
    "            break;\n"
    "          case \"!=\":\n"
    "            message = \"Expected \\\"actual\\\" to be loosely unequal to:\\n\\n\" + b + \"\\n\";\n"
    "            break;\n"
    "          case \"fail\":\n"
    "            message = \"Failed\";\n"
    "            break;\n"
    "          default:\n"
    "            message = a + \" \" + (opts.operator || \"==\") + \" \" + b;\n"
    "        }\n"
    "      } else if (message instanceof Error) {\n"
    "        throw message;\n"
    "      }\n"
    "      super(String(message));\n"
    "      this.name = \"AssertionError\";\n"
    "      this.code = \"ERR_ASSERTION\";\n"
    "      this.actual = opts.actual;\n"
    "      this.expected = opts.expected;\n"
    "      this.operator = opts.operator;\n"
    "      this.generatedMessage = opts.generatedMessage !== undefined ? opts.generatedMessage : generated;\n"
    "    }\n"
    "  }\n"
    "  function fail(actual, expected, message, operator) {\n"
    "    const argsLen = arguments.length;\n"
    "    if (argsLen === 0) {\n"
    "      throw new AssertionError({ message: \"Failed\", operator: \"fail\", generatedMessage: true });\n"
    "    }\n"
    "    if (argsLen === 1) {\n"
    "      throw new AssertionError({ message: actual === undefined ? \"Failed\" : actual, operator: \"fail\", generatedMessage: actual === undefined });\n"
    "    }\n"
    "    if (argsLen === 2) operator = \"!=\";\n"
    "    throw new AssertionError({ message, actual, expected, operator: operator || \"fail\" });\n"
    "  }\n"
    "  const innerOk = (value, message) => {\n"
    "    if (!value) {\n"
    "      if (message instanceof Error) throw message;\n"
    "      throw new AssertionError({\n"
    "        message: message !== undefined ? message\n"
    "          : \"The expression evaluated to a falsy value\",\n"
    "        actual: value,\n"
    "        expected: true,\n"
    "        operator: \"==\",\n"
    "        generatedMessage: message === undefined,\n"
    "      });\n"
    "    }\n"
    "  };\n"
    "  function ok(value, message) {\n"
    "    innerOk(value, message);\n"
    "  }\n"
    "  const looseDeep = (a, b, seen) => {\n"
    "    if (a == b) return true;\n"
    "    if (typeof a === \"number\" && typeof b === \"number\") return Number.isNaN(a) && Number.isNaN(b);\n"
    "    if (a === null || b === null || typeof a !== \"object\" || typeof b !== \"object\") return false;\n"
    "    const tagA = Object.prototype.toString.call(a);\n"
    "    if (tagA !== Object.prototype.toString.call(b)) return false;\n"
    "    if (tagA === \"[object Date]\") return a.getTime() == b.getTime(); // eslint-disable-line eqeqeq\n"
    "    if (tagA === \"[object RegExp]\") return String(a) === String(b);\n"
    "    seen = seen || new Set();\n"
    "    const key = null;\n"
    "    void key;\n"
    "    if (seen.has(a)) return true;\n"
    "    seen.add(a);\n"
    "    if (Array.isArray(a)) {\n"
    "      if (!Array.isArray(b) || a.length !== b.length) return false;\n"
    "      for (let i = 0; i < a.length; i++) {\n"
    "        if (!looseDeep(a[i], b[i], seen)) return false;\n"
    "      }\n"
    "      return true;\n"
    "    }\n"
    "    if (a instanceof Map) {\n"
    "      if (a.size !== b.size) return false;\n"
    "      for (const [k, v] of a) {\n"
    "        if (!b.has(k) || !looseDeep(v, b.get(k), seen)) return false;\n"
    "      }\n"
    "      return true;\n"
    "    }\n"
    "    if (a instanceof Set) {\n"
    "      if (a.size !== b.size) return false;\n"
    "      for (const v of a) {\n"
    "        if (!b.has(v)) return false;\n"
    "      }\n"
    "      return true;\n"
    "    }\n"
    "    const ka = Object.keys(a);\n"
    "    const kb = Object.keys(b);\n"
    "    if (ka.length !== kb.length) return false;\n"
    "    for (const k of ka) {\n"
    "      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;\n"
    "      if (!looseDeep(a[k], b[k], seen)) return false;\n"
    "    }\n"
    "    return true;\n"
    "  };\n"
    "  const checkExpected = (actual, expected, message, fnName) => {\n"
    "    if (typeof expected === \"function\") {\n"
    "      if (expected.prototype !== undefined && actual instanceof expected) return true;\n"
    "      if (Error.isPrototypeOf ? Object.getPrototypeOf(expected) === null : false) return false;\n"
    "      if (!(expected === Error || Error.prototype.isPrototypeOf(expected.prototype || {}))) {\n"
    "        return expected(actual) === true;\n"
    "      }\n"
    "      return actual instanceof expected;\n"
    "    }\n"
    "    if (expected instanceof RegExp) {\n"
    "      return expected.test(actual instanceof Error ? actual.message : String(actual));\n"
    "    }\n"
    "    if (expected !== null && typeof expected === \"object\") {\n"
    "      for (const k of Object.keys(expected)) {\n"
    "        const want = expected[k];\n"
    "        const got = actual[k];\n"
    "        if (want instanceof RegExp) {\n"
    "          if (!want.test(got)) return false;\n"
    "        } else if (!isDeepStrictEqual(got, want)) {\n"
    "          return false;\n"
    "        }\n"
    "      }\n"
    "      return true;\n"
    "    }\n"
    "    void message;\n"
    "    void fnName;\n"
    "    return false;\n"
    "  };\n"
    "  const mismatchError = (thrown, expected, operator) => {\n"
    "    if (typeof expected === \"function\" && (expected === Error || Error.prototype.isPrototypeOf(expected.prototype || {}))) {\n"
    "      return new AssertionError({\n"
    "        message: 'The error is expected to be an instance of \"' + expected.name + '\". Received \"' + (thrown && thrown.constructor && thrown.constructor.name) + '\"\\n\\nError message:\\n\\n' + (thrown && thrown.message),\n"
    "        actual: thrown,\n"
    "        expected,\n"
    "        operator,\n"
    "        generatedMessage: true,\n"
    "      });\n"
    "    }\n"
    "    if (expected instanceof RegExp) {\n"
    "      return new AssertionError({\n"
    "        message: \"The input did not match the regular expression \" + expected + \". Input:\\n\\n\" + inspect(thrown instanceof Error ? String(thrown) : thrown) + \"\\n\",\n"
    "        actual: thrown,\n"
    "        expected,\n"
    "        operator,\n"
    "        generatedMessage: true,\n"
    "      });\n"
    "    }\n"
    "    return new AssertionError({\n"
    "      message: \"Expected values to be strictly deep-equal:\\n+ actual - expected\\n\",\n"
    "      actual: thrown,\n"
    "      expected,\n"
    "      operator,\n"
    "      generatedMessage: true,\n"
    "    });\n"
    "  };\n"
    "  const assert = Object.assign(ok, {\n"
    "    AssertionError,\n"
    "    ok,\n"
    "    fail,\n"
    "    equal(actual, expected, message) {\n"
    "      if (actual != expected && !(Number.isNaN(actual) && Number.isNaN(expected))) {\n"
    "        throw new AssertionError({ message, actual, expected, operator: \"==\" });\n"
    "      }\n"
    "    },\n"
    "    notEqual(actual, expected, message) {\n"
    "      if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {\n"
    "        throw new AssertionError({ message, actual, expected, operator: \"!=\" });\n"
    "      }\n"
    "    },\n"
    "    strictEqual(actual, expected, message) {\n"
    "      if (!Object.is(actual, expected)) {\n"
    "        throw new AssertionError({ message, actual, expected, operator: \"strictEqual\" });\n"
    "      }\n"
    "    },\n"
    "    notStrictEqual(actual, expected, message) {\n"
    "      if (Object.is(actual, expected)) {\n"
    "        throw new AssertionError({ message, actual, expected, operator: \"notStrictEqual\" });\n"
    "      }\n"
    "    },\n"
    "    deepEqual(actual, expected, message) {\n"
    "      if (!looseDeep(actual, expected)) {\n"
    "        throw new AssertionError({ message, actual, expected, operator: \"deepEqual\" });\n"
    "      }\n"
    "    },\n"
    "    notDeepEqual(actual, expected, message) {\n"
    "      if (looseDeep(actual, expected)) {\n"
    "        throw new AssertionError({ message, actual, expected, operator: \"notDeepEqual\" });\n"
    "      }\n"
    "    },\n"
    "    deepStrictEqual(actual, expected, message) {\n"
    "      if (!isDeepStrictEqual(actual, expected)) {\n"
    "        throw new AssertionError({ message, actual, expected, operator: \"deepStrictEqual\" });\n"
    "      }\n"
    "    },\n"
    "    notDeepStrictEqual(actual, expected, message) {\n"
    "      if (isDeepStrictEqual(actual, expected)) {\n"
    "        throw new AssertionError({ message, actual, expected, operator: \"notDeepStrictEqual\" });\n"
    "      }\n"
    "    },\n"
    "    throws(fn, expected, message) {\n"
    "      if (typeof expected === \"string\") {\n"
    "        message = expected;\n"
    "        expected = undefined;\n"
    "      }\n"
    "      let thrown = null;\n"
    "      let did = false;\n"
    "      try {\n"
    "        fn();\n"
    "      } catch (e) {\n"
    "        did = true;\n"
    "        thrown = e;\n"
    "      }\n"
    "      if (!did) {\n"
    "        throw new AssertionError({\n"
    "          message: \"Missing expected exception\" + (message ? \": \" + message : \".\"),\n"
    "          operator: \"throws\",\n"
    "        });\n"
    "      }\n"
    "      if (expected !== undefined && !checkExpected(thrown, expected, message, \"throws\")) {\n"
    "        throw mismatchError(thrown, expected, \"throws\");\n"
    "      }\n"
    "    },\n"
    "    doesNotThrow(fn, expected, message) {\n"
    "      if (typeof expected === \"string\") {\n"
    "        message = expected;\n"
    "        expected = undefined;\n"
    "      }\n"
    "      try {\n"
    "        fn();\n"
    "      } catch (e) {\n"
    "        if (expected === undefined || checkExpected(e, expected, message, \"doesNotThrow\")) {\n"
    "          throw new AssertionError({\n"
    "            message: \"Got unwanted exception\" + (message ? \": \" + message : \".\") + \"\\nActual message: \\\"\" + (e && e.message) + \"\\\"\",\n"
    "            operator: \"doesNotThrow\",\n"
    "          });\n"
    "        }\n"
    "        throw e;\n"
    "      }\n"
    "    },\n"
    "    async rejects(promiseOrFn, expected, message) {\n"
    "      if (typeof expected === \"string\") {\n"
    "        message = expected;\n"
    "        expected = undefined;\n"
    "      }\n"
    "      let rejection = null;\n"
    "      let did = false;\n"
    "      try {\n"
    "        await (typeof promiseOrFn === \"function\" ? promiseOrFn() : promiseOrFn);\n"
    "      } catch (e) {\n"
    "        did = true;\n"
    "        rejection = e;\n"
    "      }\n"
    "      if (!did) {\n"
    "        throw new AssertionError({\n"
    "          message: \"Missing expected rejection\" + (message ? \": \" + message : \".\"),\n"
    "          operator: \"rejects\",\n"
    "        });\n"
    "      }\n"
    "      if (expected !== undefined && !checkExpected(rejection, expected, message, \"rejects\")) {\n"
    "        throw mismatchError(rejection, expected, \"rejects\");\n"
    "      }\n"
    "    },\n"
    "    async doesNotReject(promiseOrFn, expected, message) {\n"
    "      if (typeof expected === \"string\") {\n"
    "        message = expected;\n"
    "        expected = undefined;\n"
    "      }\n"
    "      try {\n"
    "        await (typeof promiseOrFn === \"function\" ? promiseOrFn() : promiseOrFn);\n"
    "      } catch (e) {\n"
    "        if (expected === undefined || checkExpected(e, expected, message, \"doesNotReject\")) {\n"
    "          throw new AssertionError({\n"
    "            message: \"Got unwanted rejection\" + (message ? \": \" + message : \".\") + \"\\nActual message: \\\"\" + (e && e.message) + \"\\\"\",\n"
    "            operator: \"doesNotReject\",\n"
    "          });\n"
    "        }\n"
    "        throw e;\n"
    "      }\n"
    "    },\n"
    "    match(string, regexp, message) {\n"
    "      if (!(regexp instanceof RegExp)) {\n"
    "        const e = new TypeError('The \"regexp\" argument must be an instance of RegExp. Received ' + (regexp === null ? \"null\" : \"type \" + typeof regexp + \" ('\" + String(regexp) + \"')\"));\n"
    "        e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "        throw e;\n"
    "      }\n"
    "      if (typeof string !== \"string\" || !regexp.test(string)) {\n"
    "        throw new AssertionError({\n"
    "          message: message !== undefined ? message\n"
    "            : typeof string !== \"string\"\n"
    "              ? 'The \"string\" argument must be of type string. Received type ' + typeof string + \" (\" + inspect(string) + \")\"\n"
    "              : \"The input did not match the regular expression \" + regexp + \". Input:\\n\\n\" + inspect(string) + \"\\n\",\n"
    "          actual: string,\n"
    "          expected: regexp,\n"
    "          operator: \"match\",\n"
    "          generatedMessage: message === undefined,\n"
    "        });\n"
    "      }\n"
    "    },\n"
    "    doesNotMatch(string, regexp, message) {\n"
    "      if (!(regexp instanceof RegExp)) {\n"
    "        const e = new TypeError('The \"regexp\" argument must be an instance of RegExp. Received ' + (regexp === null ? \"null\" : \"type \" + typeof regexp + \" ('\" + String(regexp) + \"')\"));\n"
    "        e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "        throw e;\n"
    "      }\n"
    "      if (typeof string === \"string\" && regexp.test(string)) {\n"
    "        throw new AssertionError({\n"
    "          message: message !== undefined ? message\n"
    "            : \"The input was expected to not match the regular expression \" + regexp + \". Input:\\n\\n\" + inspect(string) + \"\\n\",\n"
    "          actual: string,\n"
    "          expected: regexp,\n"
    "          operator: \"doesNotMatch\",\n"
    "          generatedMessage: message === undefined,\n"
    "        });\n"
    "      }\n"
    "    },\n"
    "    ifError(value) {\n"
    "      if (value !== null && value !== undefined) {\n"
    "        const e = new AssertionError({\n"
    "          message: \"ifError got unwanted exception: \" + (value instanceof Error && typeof value.message === \"string\" ? (value.message === \"\" ? value.constructor.name : value.message) : inspect(value)),\n"
    "          actual: value,\n"
    "          expected: null,\n"
    "          operator: \"ifError\",\n"
    "        });\n"
    "        throw e;\n"
    "      }\n"
    "    },\n"
    "  });\n"
    "  const strict = Object.assign(\n"
    "    function strictOk(...args) {\n"
    "      return ok(...args);\n"
    "    },\n"
    "    assert,\n"
    "    {\n"
    "      equal: assert.strictEqual,\n"
    "      notEqual: assert.notStrictEqual,\n"
    "      deepEqual: assert.deepStrictEqual,\n"
    "      notDeepEqual: assert.notDeepStrictEqual,\n"
    "    },\n"
    "  );\n"
    "  strict.strict = strict;\n"
    "  assert.strict = strict;\n"
    "  return assert;\n"
    "}\n"
    "    const u = builtins.util();\n"
    "    const a = makeAssert({ isDeepStrictEqual: u.isDeepStrictEqual, inspect: u.inspect });\n"
    "    a.default = a;\n"
    "    return a;\n"
    "  });\n"
    "  builtins['assert/strict'] = memo(() => {\n"
    "    const s = builtins.assert().strict;\n"
    "    s.default = s;\n"
    "    return s;\n"
    "  });\n"
    /* node:util — the full JS shim, developed standalone and
     * differentially tested against real Node (inspect, format,
     * promisify, callbackify, inherits, deprecate, debuglog, types,
     * isDeepStrictEqual, stripVTControlCharacters, styleText,
     * parseArgs, toUSVString). The host supplies what JS cannot see:
     * promise state (JS_PromiseState), the pid, and fd writes. */
    "  builtins.util = memo(() => {\n"
    "function makeUtil(env) {\n"
    "  const inspectCustom = Symbol.for(\"nodejs.util.inspect.custom\");\n"
    "  const idRe = /^[a-zA-Z_][a-zA-Z_0-9]*$/; /* Node's keyStrRegExp: no $ */\n"
    "  const strEsc = (s, q) => {\n"
    "    let out = \"\";\n"
    "    for (let i = 0; i < s.length; i++) {\n"
    "      const c = s.charCodeAt(i);\n"
    "      const ch = s[i];\n"
    "      if (ch === q || ch === \"\\\\\") out += \"\\\\\" + ch;\n"
    "      else if (c === 10) out += \"\\\\n\";\n"
    "      else if (c === 9) out += \"\\\\t\";\n"
    "      else if (c === 13) out += \"\\\\r\";\n"
    "      else if (c === 8) out += \"\\\\b\";\n"
    "      else if (c === 12) out += \"\\\\f\";\n"
    "      else if (c === 11) out += \"\\\\v\";\n"
    "      else if (c < 32 || c === 127) out += \"\\\\x\" + c.toString(16).toUpperCase().padStart(2, \"0\");\n"
    "      else out += ch;\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  const quoteStr = (s) => {\n"
    "    if (!s.includes(\"'\")) return \"'\" + strEsc(s, \"'\") + \"'\";\n"
    "    if (!s.includes('\"')) return '\"' + strEsc(s, '\"') + '\"';\n"
    "    if (!s.includes(\"`\") && !s.includes(\"${\")) return \"`\" + strEsc(s, \"`\") + \"`\";\n"
    "    return \"'\" + strEsc(s, \"'\") + \"'\";\n"
    "  };\n"
    "  const fmtNumber = (n) => (Object.is(n, -0) ? \"-0\" : String(n));\n"
    "  const fmtBigInt = (n) => String(n) + \"n\";\n"
    "  const fmtPrimitive = (ctx, v) => {\n"
    "    const t = typeof v;\n"
    "    if (t === \"string\") {\n"
    "      if (v.length > ctx.maxStringLength) {\n"
    "        const rest = v.length - ctx.maxStringLength;\n"
    "        return quoteStr(v.slice(0, ctx.maxStringLength)) +\n"
    "          \"... \" + rest + \" more character\" + (rest > 1 ? \"s\" : \"\");\n"
    "      }\n"
    "      return quoteStr(v);\n"
    "    }\n"
    "    if (t === \"number\") return fmtNumber(v);\n"
    "    if (t === \"bigint\") return fmtBigInt(v);\n"
    "    if (t === \"boolean\") return v ? \"true\" : \"false\";\n"
    "    if (t === \"undefined\") return \"undefined\";\n"
    "    return String(v); /* symbol */\n"
    "  };\n"
    "  const constructorNameOf = (v) => {\n"
    "    let p = v;\n"
    "    while (p !== null) {\n"
    "      const d = Object.getOwnPropertyDescriptor(p, \"constructor\");\n"
    "      if (d !== undefined && typeof d.value === \"function\" && d.value.name !== \"\") {\n"
    "        return d.value.name;\n"
    "      }\n"
    "      p = Object.getPrototypeOf(p);\n"
    "    }\n"
    "    return null;\n"
    "  };\n"
    "  const fnBase = (v) => {\n"
    "    const s = Function.prototype.toString.call(v);\n"
    "    let kind = \"Function\";\n"
    "    if (s.startsWith(\"class\")) {\n"
    "      let base = \"class \" + (v.name || \"(anonymous)\");\n"
    "      const proto = Object.getPrototypeOf(v);\n"
    "      if (typeof proto === \"function\" && proto.name !== \"\") base += \" extends \" + proto.name;\n"
    "      return \"[\" + base + \"]\";\n"
    "    }\n"
    "    if (s.startsWith(\"async function\") || (s.startsWith(\"async\") && !s.startsWith(\"async function*\"))) kind = \"AsyncFunction\";\n"
    "    if (s.startsWith(\"function*\") || /^async function\\*/.test(s)) kind = s.startsWith(\"async\") ? \"AsyncGeneratorFunction\" : \"GeneratorFunction\";\n"
    "    if (/^async\\s*(\\*|function\\*)/.test(s)) kind = \"AsyncGeneratorFunction\";\n"
    "    return v.name === \"\" ? \"[\" + kind + \" (anonymous)]\" : \"[\" + kind + \": \" + v.name + \"]\";\n"
    "  };\n"
    "  const kindTA = (v) => {\n"
    "    const tag = Object.prototype.toString.call(v).slice(8, -1);\n"
    "    return /^(Ui|I|Fl|Big)/.test(tag) && tag.endsWith(\"Array\") ? tag : null;\n"
    "  };\n"
    "  const keyOf = (k) => {\n"
    "    if (typeof k === \"symbol\") return String(k);\n"
    "    return idRe.test(k) ? k : quoteStr(k);\n"
    "  };\n"
    "  const ownKeysOf = (ctx, v) => {\n"
    "    const keys = [];\n"
    "    for (const k of Object.keys(v)) keys.push(k);\n"
    "    for (const s of Object.getOwnPropertySymbols(v)) {\n"
    "      const d = Object.getOwnPropertyDescriptor(v, s);\n"
    "      if (d && d.enumerable) keys.push(s);\n"
    "    }\n"
    "    return keys;\n"
    "  };\n"
    "  const fmtProperty = (ctx, v, k, depth) => {\n"
    "    const d = Object.getOwnPropertyDescriptor(v, k) ||\n"
    "      { value: v[k], enumerable: true };\n"
    "    let val;\n"
    "    if (d.value !== undefined || (\"value\" in d)) {\n"
    "      val = fmtValue(ctx, d.value, depth + 1);\n"
    "    } else if (d.get !== undefined) {\n"
    "      val = d.set !== undefined ? \"[Getter/Setter]\" : \"[Getter]\";\n"
    "    } else if (d.set !== undefined) {\n"
    "      val = \"[Setter]\";\n"
    "    } else {\n"
    "      val = \"undefined\";\n"
    "    }\n"
    "    return keyOf(k) + \": \" + val;\n"
    "  };\n"
    "  const belowBreakLength = (ctx, output, start, base) => {\n"
    "    let total = output.length + start;\n"
    "    if (total + output.length > ctx.breakLength) return false;\n"
    "    for (let i = 0; i < output.length; i++) total += output[i].length;\n"
    "    return total <= ctx.breakLength && base.length + total <= ctx.breakLength;\n"
    "  };\n"
    "  const groupArrayElements = (ctx, output, value) => {\n"
    "    let totalLength = 0;\n"
    "    let maxLength = 0;\n"
    "    let i = 0;\n"
    "    let outputLength = output.length;\n"
    "    if (ctx.maxArrayLength < output.length) outputLength = output.length - 1;\n"
    "    const dataLen = new Array(outputLength);\n"
    "    for (; i < outputLength; i++) {\n"
    "      const len = output[i].length;\n"
    "      dataLen[i] = len;\n"
    "      totalLength += len + 2;\n"
    "      if (maxLength < len) maxLength = len;\n"
    "    }\n"
    "    const actualMax = maxLength + 2;\n"
    "    if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&\n"
    "        (totalLength / actualMax > 5 || maxLength <= 6)) {\n"
    "      const approxCharHeights = 2.5;\n"
    "      const averageBias = Math.sqrt(actualMax - totalLength / output.length);\n"
    "      const biasedMax = Math.max(actualMax - 3 - averageBias, 1);\n"
    "      const columns = Math.min(\n"
    "        Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),\n"
    "        Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),\n"
    "        ctx.compact * 4,\n"
    "        15,\n"
    "      );\n"
    "      if (columns <= 1) return output;\n"
    "      const tmp = [];\n"
    "      const maxLineLength = [];\n"
    "      for (let ii = 0; ii < columns; ii++) {\n"
    "        let lineLength = 0;\n"
    "        for (let j = ii; j < output.length; j += columns) {\n"
    "          if (dataLen[j] > lineLength) lineLength = dataLen[j];\n"
    "        }\n"
    "        maxLineLength[ii] = lineLength + 2;\n"
    "      }\n"
    "      let order = String.prototype.padStart;\n"
    "      if (value !== undefined) {\n"
    "        for (let ii = 0; ii < output.length; ii++) {\n"
    "          if (typeof value[ii] !== \"number\" && typeof value[ii] !== \"bigint\") {\n"
    "            order = String.prototype.padEnd;\n"
    "            break;\n"
    "          }\n"
    "        }\n"
    "      }\n"
    "      for (let ii = 0; ii < outputLength; ii += columns) {\n"
    "        const max = Math.min(ii + columns, outputLength);\n"
    "        let str = \"\";\n"
    "        let j = ii;\n"
    "        for (; j < max - 1; j++) {\n"
    "          const padding = maxLineLength[j - ii] + output[j].length - dataLen[j];\n"
    "          str += order.call(output[j] + \", \", padding, \" \");\n"
    "        }\n"
    "        if (order === String.prototype.padStart) {\n"
    "          const padding = maxLineLength[j - ii] + output[j].length - dataLen[j] - 2;\n"
    "          str += output[j].padStart(padding, \" \");\n"
    "        } else {\n"
    "          str += output[j];\n"
    "        }\n"
    "        tmp.push(str);\n"
    "      }\n"
    "      if (ctx.maxArrayLength < output.length) tmp.push(output[outputLength]);\n"
    "      output = tmp;\n"
    "    }\n"
    "    return output;\n"
    "  };\n"
    "  const reduceToSingleString = (ctx, output, base, braces, isArrayLike, depth, value) => {\n"
    "    if (ctx.compact >= 1 && typeof ctx.compact === \"number\") {\n"
    "      const entries = output.length;\n"
    "      if (isArrayLike && entries > 6) output = groupArrayElements(ctx, output, value);\n"
    "      if (ctx.currentDepth - depth < ctx.compact && entries === output.length) {\n"
    "        const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;\n"
    "        if (belowBreakLength(ctx, output, start, base)) {\n"
    "          const joined = output.join(\", \");\n"
    "          if (!joined.includes(\"\\n\")) {\n"
    "            return (base ? base + \" \" : \"\") + braces[0] + \" \" + joined + \" \" + braces[1];\n"
    "          }\n"
    "        }\n"
    "      }\n"
    "    }\n"
    "    const indentation = \"\\n\" + \" \".repeat(ctx.indentationLvl);\n"
    "    return (base ? base + \" \" : \"\") + braces[0] + indentation + \"  \" +\n"
    "      output.join(\",\" + indentation + \"  \") + indentation + braces[1];\n"
    "  };\n"
    "  const fmtList = (ctx, v, depth) => {\n"
    "    const output = [];\n"
    "    const max = Math.min(ctx.maxArrayLength, v.length);\n"
    "    let i = 0;\n"
    "    while (i < max) {\n"
    "      if (!Object.prototype.hasOwnProperty.call(v, i)) {\n"
    "        let j = i;\n"
    "        while (j < v.length && !Object.prototype.hasOwnProperty.call(v, j)) j++;\n"
    "        const n = Math.min(j, max) === j ? j - i : j - i;\n"
    "        output.push(\"<\" + n + \" empty item\" + (n > 1 ? \"s\" : \"\") + \">\");\n"
    "        i = j;\n"
    "        continue;\n"
    "      }\n"
    "      output.push(fmtValue(ctx, v[i], depth + 1));\n"
    "      i++;\n"
    "    }\n"
    "    if (v.length > max) {\n"
    "      const rest = v.length - max;\n"
    "      output.push(\"... \" + rest + \" more item\" + (rest > 1 ? \"s\" : \"\"));\n"
    "    }\n"
    "    return output;\n"
    "  };\n"
    "  const fmtTypedArray = (ctx, v, depth) => {\n"
    "    const max = Math.min(ctx.maxArrayLength, v.length);\n"
    "    const output = new Array(max);\n"
    "    for (let i = 0; i < max; i++) {\n"
    "      output[i] = typeof v[i] === \"bigint\" ? fmtBigInt(v[i]) : fmtNumber(v[i]);\n"
    "    }\n"
    "    if (v.length > max) {\n"
    "      const rest = v.length - max;\n"
    "      output.push(\"... \" + rest + \" more item\" + (rest > 1 ? \"s\" : \"\"));\n"
    "    }\n"
    "    return output;\n"
    "  };\n"
    "  const hexSlice = (u8, n) => {\n"
    "    let s = \"\";\n"
    "    for (let i = 0; i < n; i++) s += (i ? \" \" : \"\") + u8[i].toString(16).padStart(2, \"0\");\n"
    "    return s;\n"
    "  };\n"
    "  const fmtValue = (ctx, value, depth, typedArray) => {\n"
    "    if (typeof value !== \"object\" && typeof value !== \"function\") {\n"
    "      return fmtPrimitive(ctx, value);\n"
    "    }\n"
    "    if (value === null) return \"null\";\n"
    "    if (ctx.customInspect) {\n"
    "      const maybe = value[inspectCustom];\n"
    "      if (typeof maybe === \"function\" && maybe !== inspect &&\n"
    "          !(value.constructor && value.constructor.prototype === value)) {\n"
    "        const depthRemaining = ctx.depth === null ? null : ctx.depth - depth;\n"
    "        const opts = {\n"
    "          depth: ctx.depth, colors: ctx.colors, showHidden: ctx.showHidden,\n"
    "          breakLength: ctx.breakLength, compact: ctx.compact,\n"
    "          maxArrayLength: ctx.maxArrayLength, maxStringLength: ctx.maxStringLength,\n"
    "          customInspect: ctx.customInspect, sorted: ctx.sorted, getters: ctx.getters,\n"
    "          numericSeparator: ctx.numericSeparator, stylize: (s) => s,\n"
    "        };\n"
    "        const ret = maybe.call(value, depthRemaining, opts, inspect);\n"
    "        if (ret !== value) {\n"
    "          return typeof ret !== \"string\" ? fmtValue(ctx, ret, depth) : ret;\n"
    "        }\n"
    "      }\n"
    "    }\n"
    "    if (ctx.seen.includes(value)) {\n"
    "      let index = 1;\n"
    "      if (ctx.circular === undefined) {\n"
    "        ctx.circular = new Map();\n"
    "        ctx.circular.set(value, index);\n"
    "      } else {\n"
    "        const seenIndex = ctx.circular.get(value);\n"
    "        if (seenIndex === undefined) {\n"
    "          index = ctx.circular.size + 1;\n"
    "          ctx.circular.set(value, index);\n"
    "        } else {\n"
    "          index = seenIndex;\n"
    "        }\n"
    "      }\n"
    "      return \"[Circular *\" + index + \"]\";\n"
    "    }\n"
    "    return fmtRaw(ctx, value, depth, typedArray);\n"
    "  };\n"
    "  const fmtRaw = (ctx, value, depth, typedArray) => {\n"
    "    let keys = ownKeysOf(ctx, value);\n"
    "    const protoOf = Object.getPrototypeOf(value);\n"
    "    const ctorName = protoOf === null ? null : constructorNameOf(value);\n"
    "    let base = \"\";\n"
    "    let braces;\n"
    "    let formatter = null;\n"
    "    let isArrayLike = false;\n"
    "    const taKind = kindTA(value);\n"
    "    if (Array.isArray(value)) {\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return \"[Array]\";\n"
    "      const prefix = ctorName !== \"Array\" || protoOf === null\n"
    "        ? (ctorName === null ? \"[Array(\" + value.length + \"): null prototype] \" : ctorName + \"(\" + value.length + \") \")\n"
    "        : \"\";\n"
    "      keys = keys.filter((k) => !(typeof k === \"string\" && /^\\d+$/.test(k) && +k < value.length));\n"
    "      braces = [prefix + \"[\", \"]\"];\n"
    "      if (value.length === 0 && keys.length === 0) return braces[0] + \"]\";\n"
    "      formatter = fmtList;\n"
    "      isArrayLike = true;\n"
    "    } else if (value instanceof Map) {\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return \"[Map]\";\n"
    "      const size = value.size;\n"
    "      const prefix = (ctorName !== \"Map\" ? ctorName + \" [Map]\" : \"Map\") + \"(\" + size + \") \";\n"
    "      if (size === 0 && keys.length === 0) return prefix + \"{}\";\n"
    "      braces = [prefix + \"{\", \"}\"];\n"
    "      formatter = (c, v, d) => {\n"
    "        const out = [];\n"
    "        for (const [k, val] of v) {\n"
    "          out.push(fmtValue(c, k, d + 1) + \" => \" + fmtValue(c, val, d + 1));\n"
    "        }\n"
    "        return out;\n"
    "      };\n"
    "    } else if (value instanceof Set) {\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return \"[Set]\";\n"
    "      const size = value.size;\n"
    "      const prefix = (ctorName !== \"Set\" ? ctorName + \" [Set]\" : \"Set\") + \"(\" + size + \") \";\n"
    "      if (size === 0 && keys.length === 0) return prefix + \"{}\";\n"
    "      braces = [prefix + \"{\", \"}\"];\n"
    "      formatter = (c, v, d) => {\n"
    "        const out = [];\n"
    "        for (const val of v) out.push(fmtValue(c, val, d + 1));\n"
    "        return out;\n"
    "      };\n"
    "    } else if (taKind !== null) {\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return \"[\" + taKind + \"]\";\n"
    "      const prefix = (ctorName !== taKind && ctorName !== null ? ctorName + \"(\" + value.length + \") [\" + taKind + \"] \" : taKind + \"(\" + value.length + \") \");\n"
    "      braces = [prefix + \"[\", \"]\"];\n"
    "      if (value.length === 0 && keys.length === 0) return braces[0] + \"]\";\n"
    "      keys = keys.filter((k) => !(typeof k === \"string\" && /^\\d+$/.test(k) && +k < value.length));\n"
    "      formatter = fmtTypedArray;\n"
    "      isArrayLike = true;\n"
    "    } else if (typeof value === \"function\") {\n"
    "      base = fnBase(value);\n"
    "      if (keys.length === 0) return base;\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return base;\n"
    "      braces = [\"{\", \"}\"];\n"
    "      formatter = () => [];\n"
    "    } else if (value instanceof RegExp) {\n"
    "      base = RegExp.prototype.toString.call(value);\n"
    "      if (keys.length === 0) return base;\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return base;\n"
    "      braces = [\"{\", \"}\"];\n"
    "      formatter = () => [];\n"
    "    } else if (value instanceof Date) {\n"
    "      const t = Date.prototype.getTime.call(value);\n"
    "      base = Number.isNaN(t) ? \"Invalid Date\" : Date.prototype.toISOString.call(value);\n"
    "      if (keys.length === 0) return base;\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return base;\n"
    "      braces = [\"{\", \"}\"];\n"
    "      formatter = () => [];\n"
    "    } else if (value instanceof Error) {\n"
    "      base = value.stack;\n"
    "      if (typeof base !== \"string\" || base === \"\") {\n"
    "        const name = value.name === undefined ? \"Error\" : String(value.name);\n"
    "        const msg = value.message === undefined || value.message === \"\" ? \"\" : \": \" + String(value.message);\n"
    "        base = \"[\" + name + msg + \"]\";\n"
    "      }\n"
    "      keys = keys.filter((k) => k !== \"message\" && k !== \"stack\");\n"
    "      if (keys.length === 0) return base;\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return base;\n"
    "      braces = [\"{\", \"}\"];\n"
    "      formatter = () => [];\n"
    "    } else if (value instanceof Promise) {\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return \"[Promise]\";\n"
    "      const st = env.promiseState(value);\n"
    "      braces = [\"Promise {\", \"}\"];\n"
    "      formatter = (c, v, d) => {\n"
    "        if (st === undefined || st[0] === 0) return [\"<pending>\"];\n"
    "        if (st[0] === 1) return [fmtValue(c, st[1], d + 1)];\n"
    "        return [\"<rejected> \" + fmtValue(c, st[1], d + 1)];\n"
    "      };\n"
    "    } else if (value instanceof ArrayBuffer) {\n"
    "      if (depth > ctx.depth && ctx.depth !== null) return \"[ArrayBuffer]\";\n"
    "      const u8 = new Uint8Array(value);\n"
    "      const n = Math.min(ctx.maxArrayLength, u8.length);\n"
    "      let contents = \"<\" + hexSlice(u8, n);\n"
    "      if (u8.length > n) {\n"
    "        const rest = u8.length - n;\n"
    "        contents += (n > 0 ? \" \" : \"\") + \"... \" + rest + \" more byte\" + (rest > 1 ? \"s\" : \"\");\n"
    "      }\n"
    "      contents += \">\";\n"
    "      braces = [\"ArrayBuffer {\", \"}\"];\n"
    "      const bl = value.byteLength;\n"
    "      formatter = () => [\"[Uint8Contents]: \" + contents, \"[byteLength]: \" + fmtNumber(bl)];\n"
    "    } else {\n"
    "      const boxed = (() => {\n"
    "        const tag = Object.prototype.toString.call(value).slice(8, -1);\n"
    "        if (tag === \"String\") return \"[String: \" + quoteStr(String.prototype.valueOf.call(value)) + \"]\";\n"
    "        if (tag === \"Number\") return \"[Number: \" + fmtNumber(Number.prototype.valueOf.call(value)) + \"]\";\n"
    "        if (tag === \"Boolean\") return \"[Boolean: \" + Boolean.prototype.valueOf.call(value) + \"]\";\n"
    "        if (tag === \"Symbol\") return \"[Symbol: \" + String(Symbol.prototype.valueOf.call(value)) + \"]\";\n"
    "        if (tag === \"BigInt\") return \"[BigInt: \" + fmtBigInt(BigInt.prototype.valueOf.call(value)) + \"]\";\n"
    "        return null;\n"
    "      })();\n"
    "      if (boxed !== null) {\n"
    "        base = boxed;\n"
    "        if (Object.prototype.toString.call(value).slice(8, -1) === \"String\") {\n"
    "          const len = String.prototype.valueOf.call(value).length;\n"
    "          keys = keys.filter((k) => !(typeof k === \"string\" && /^\\d+$/.test(k) && +k < len));\n"
    "        }\n"
    "        if (keys.length === 0) return base;\n"
    "        braces = [\"{\", \"}\"];\n"
    "        formatter = () => [];\n"
    "      } else {\n"
    "        if (depth > ctx.depth && ctx.depth !== null) {\n"
    "          return \"[\" + (ctorName === null ? \"Object: null prototype\" : ctorName) + \"]\";\n"
    "        }\n"
    "        if (protoOf === null) {\n"
    "          base = \"[Object: null prototype]\";\n"
    "          braces = [\"{\", \"}\"];\n"
    "        } else if (ctorName !== \"Object\" && ctorName !== null) {\n"
    "          braces = [ctorName + \" {\", \"}\"];\n"
    "        } else {\n"
    "          braces = [\"{\", \"}\"];\n"
    "        }\n"
    "        if (keys.length === 0) {\n"
    "          if (base !== \"\") return base + \" {}\";\n"
    "          return braces[0] === \"{\" ? \"{}\" : braces[0] + \"}\";\n"
    "        }\n"
    "        formatter = () => [];\n"
    "      }\n"
    "    }\n"
    "    ctx.seen.push(value);\n"
    "    ctx.currentDepth = depth;\n"
    "    let output;\n"
    "    try {\n"
    "      output = formatter(ctx, value, depth);\n"
    "      for (const k of keys) {\n"
    "        output.push(fmtProperty(ctx, value, k, depth));\n"
    "      }\n"
    "    } finally {\n"
    "      ctx.seen.pop();\n"
    "    }\n"
    "    if (ctx.sorted) output.sort();\n"
    "    const res = reduceToSingleString(ctx, output, base, braces, isArrayLike, depth, value);\n"
    "    if (ctx.circular !== undefined) {\n"
    "      const index = ctx.circular.get(value);\n"
    "      if (index !== undefined) return \"<ref *\" + index + \"> \" + res;\n"
    "    }\n"
    "    return res;\n"
    "  };\n"
    "  function inspect(value, showHiddenOrOpts, depthArg, colorsArg) {\n"
    "    const ctx = {\n"
    "      showHidden: false, depth: 2, colors: false, customInspect: true,\n"
    "      maxArrayLength: 100, maxStringLength: 10000, breakLength: 128,\n"
    "      compact: 3, sorted: false, getters: false, numericSeparator: false,\n"
    "      seen: [], circular: undefined, indentationLvl: 0, currentDepth: 0,\n"
    "    };\n"
    "    if (arguments.length > 1) {\n"
    "      if (typeof showHiddenOrOpts === \"boolean\") {\n"
    "        ctx.showHidden = showHiddenOrOpts;\n"
    "        if (depthArg !== undefined) ctx.depth = depthArg;\n"
    "        if (colorsArg !== undefined) ctx.colors = colorsArg;\n"
    "      } else if (showHiddenOrOpts !== null && typeof showHiddenOrOpts === \"object\") {\n"
    "        for (const k of Object.keys(showHiddenOrOpts)) {\n"
    "          if (showHiddenOrOpts[k] !== undefined || k in ctx) ctx[k] = showHiddenOrOpts[k];\n"
    "        }\n"
    "      }\n"
    "    }\n"
    "    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;\n"
    "    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;\n"
    "    if (ctx.breakLength === null) ctx.breakLength = Infinity;\n"
    "    if (ctx.compact === false) ctx.compact = 0;\n"
    "    return fmtValue(ctx, value, 0);\n"
    "  }\n"
    "  inspect.custom = inspectCustom;\n"
    "  inspect.defaultOptions = {\n"
    "    showHidden: false, depth: 2, colors: false, customInspect: true,\n"
    "    showProxy: false, maxArrayLength: 100, maxStringLength: 10000,\n"
    "    breakLength: 128, compact: 3, sorted: false, getters: false,\n"
    "    numericSeparator: false,\n"
    "  };\n"
    "  inspect.colors = {\n"
    "    reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23],\n"
    "    underline: [4, 24], blink: [5, 25], inverse: [7, 27], hidden: [8, 28],\n"
    "    strikethrough: [9, 29], doubleunderline: [21, 24], black: [30, 39],\n"
    "    red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39],\n"
    "    magenta: [35, 39], cyan: [36, 39], white: [37, 39], bgBlack: [40, 49],\n"
    "    bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49], bgBlue: [44, 49],\n"
    "    bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49],\n"
    "    framed: [51, 54], overlined: [53, 55], gray: [90, 39], redBright: [91, 39],\n"
    "    greenBright: [92, 39], yellowBright: [93, 39], blueBright: [94, 39],\n"
    "    magentaBright: [95, 39], cyanBright: [96, 39], whiteBright: [97, 39],\n"
    "    bgGray: [100, 49], bgRedBright: [101, 49], bgGreenBright: [102, 49],\n"
    "    bgYellowBright: [103, 49], bgBlueBright: [104, 49],\n"
    "    bgMagentaBright: [105, 49], bgCyanBright: [106, 49], bgWhiteBright: [107, 49],\n"
    "  };\n"
    "  const formatWithOptions = (opts, ...args) => {\n"
    "    let first = args[0];\n"
    "    let a = 0;\n"
    "    let str = \"\";\n"
    "    let joined = \"\";\n"
    "    if (typeof first === \"string\" && first.includes(\"%\")) {\n"
    "      a = 1;\n"
    "      let lastPos = 0;\n"
    "      for (let i = 0; i < first.length - 1; i++) {\n"
    "        if (first[i] !== \"%\") continue;\n"
    "        const next = first[++i];\n"
    "        let tempStr;\n"
    "        if (next === \"%\") {\n"
    "          str += first.slice(lastPos, i - 1) + \"%\";\n"
    "          lastPos = i + 1;\n"
    "          continue;\n"
    "        }\n"
    "        if (a >= args.length) continue;\n"
    "        switch (next) {\n"
    "          case \"s\": {\n"
    "            const arg = args[a];\n"
    "            if (typeof arg === \"number\") tempStr = fmtNumber(arg);\n"
    "            else if (typeof arg === \"bigint\") tempStr = fmtBigInt(arg);\n"
    "            else if (typeof arg !== \"object\" || arg === null) tempStr = String(arg);\n"
    "            else tempStr = inspect(arg, { ...opts, compact: 3, colors: false, depth: 0 });\n"
    "            break;\n"
    "          }\n"
    "          case \"j\":\n"
    "            try { tempStr = JSON.stringify(args[a]); }\n"
    "            catch (e) { tempStr = \"[Circular]\"; }\n"
    "            break;\n"
    "          case \"d\": {\n"
    "            const arg = args[a];\n"
    "            if (typeof arg === \"bigint\") tempStr = fmtBigInt(arg);\n"
    "            else if (typeof arg === \"symbol\") tempStr = \"NaN\";\n"
    "            else tempStr = fmtNumber(Number(arg));\n"
    "            break;\n"
    "          }\n"
    "          case \"O\":\n"
    "            tempStr = inspect(args[a], { ...opts });\n"
    "            break;\n"
    "          case \"o\":\n"
    "            tempStr = inspect(args[a], { ...opts, showHidden: true, showProxy: true, depth: 4 });\n"
    "            break;\n"
    "          case \"i\": {\n"
    "            const arg = args[a];\n"
    "            if (typeof arg === \"bigint\") tempStr = fmtBigInt(arg);\n"
    "            else if (typeof arg === \"symbol\") tempStr = \"NaN\";\n"
    "            else tempStr = fmtNumber(parseInt(arg));\n"
    "            break;\n"
    "          }\n"
    "          case \"f\": {\n"
    "            const arg = args[a];\n"
    "            if (typeof arg === \"symbol\") tempStr = \"NaN\";\n"
    "            else tempStr = fmtNumber(parseFloat(arg));\n"
    "            break;\n"
    "          }\n"
    "          case \"c\":\n"
    "            a += 1;\n"
    "            lastPos = i + 1;\n"
    "            continue;\n"
    "          default:\n"
    "            continue;\n"
    "        }\n"
    "        if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);\n"
    "        str += tempStr;\n"
    "        lastPos = i + 1;\n"
    "        a++;\n"
    "      }\n"
    "      if (lastPos !== 0) {\n"
    "        if (lastPos < first.length) str += first.slice(lastPos);\n"
    "        first = str;\n"
    "        str = \"\";\n"
    "      } else {\n"
    "        str = \"\";\n"
    "      }\n"
    "      joined = first;\n"
    "    }\n"
    "    while (a < args.length) {\n"
    "      const value = args[a];\n"
    "      joined += a > 0 || typeof first !== \"string\" && a === 0 ? \"\" : \"\";\n"
    "      if (joined !== \"\" || a > 0) joined += \" \";\n"
    "      joined += typeof value !== \"string\" ? inspect(value, opts) : value;\n"
    "      a++;\n"
    "    }\n"
    "    return joined;\n"
    "  };\n"
    "  const format = (...args) => formatWithOptions({}, ...args);\n"
    "  const inherits = (ctor, superCtor) => {\n"
    "    if (ctor === undefined || ctor === null) {\n"
    "      const e = new TypeError('The \"ctor\" argument must be of type function. Received ' + (ctor === null ? \"null\" : \"undefined\"));\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    if (superCtor === undefined || superCtor === null) {\n"
    "      const e = new TypeError('The \"superCtor\" argument must be of type function. Received ' + (superCtor === null ? \"null\" : \"undefined\"));\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    if (superCtor.prototype === undefined) {\n"
    "      const e = new TypeError('The \"superCtor.prototype\" argument must be of type object. Received undefined');\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    Object.defineProperty(ctor, \"super_\", { value: superCtor, writable: true, configurable: true });\n"
    "    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);\n"
    "  };\n"
    "  const kCustomPromisified = Symbol.for(\"nodejs.util.promisify.custom\");\n"
    "  const kCustomPromisifyArgs = Symbol(\"customPromisifyArgs\");\n"
    "  const promisify = (original) => {\n"
    "    if (typeof original !== \"function\") {\n"
    "      const e = new TypeError('The \"original\" argument must be of type function. Received ' + (original === null ? \"null\" : typeof original === \"object\" ? \"an instance of Object\" : typeof original === \"undefined\" ? \"undefined\" : \"type \" + typeof original + \" (\" + JSON.stringify(original) + \")\"));\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    if (original[kCustomPromisified]) {\n"
    "      const fn = original[kCustomPromisified];\n"
    "      if (typeof fn !== \"function\") {\n"
    "        const e = new TypeError('The \"util.promisify.custom\" property must be of type function');\n"
    "        e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "        throw e;\n"
    "      }\n"
    "      return Object.defineProperty(fn, kCustomPromisified, { value: fn, enumerable: false, writable: false, configurable: true });\n"
    "    }\n"
    "    const argumentNames = original[kCustomPromisifyArgs];\n"
    "    function fn(...args) {\n"
    "      return new Promise((resolve, reject) => {\n"
    "        args.push((err, ...values) => {\n"
    "          if (err) return reject(err);\n"
    "          if (argumentNames !== undefined && values.length > 1) {\n"
    "            const obj = {};\n"
    "            for (let i = 0; i < argumentNames.length; i++) obj[argumentNames[i]] = values[i];\n"
    "            resolve(obj);\n"
    "          } else {\n"
    "            resolve(values[0]);\n"
    "          }\n"
    "        });\n"
    "        Reflect.apply(original, this, args);\n"
    "      });\n"
    "    }\n"
    "    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));\n"
    "    Object.defineProperty(fn, kCustomPromisified, { value: fn, enumerable: false, writable: false, configurable: true });\n"
    "    const descriptors = Object.getOwnPropertyDescriptors(original);\n"
    "    delete descriptors.name;\n"
    "    delete descriptors.length;\n"
    "    return Object.defineProperties(fn, descriptors);\n"
    "  };\n"
    "  promisify.custom = kCustomPromisified;\n"
    "  const callbackify = (original) => {\n"
    "    if (typeof original !== \"function\") {\n"
    "      const e = new TypeError('The \"original\" argument must be of type function');\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    function callbackified(...args) {\n"
    "      const maybeCb = args.pop();\n"
    "      if (typeof maybeCb !== \"function\") {\n"
    "        const e = new TypeError(\"The last argument must be of type function\");\n"
    "        e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "        throw e;\n"
    "      }\n"
    "      const cb = (...cbArgs) => Reflect.apply(maybeCb, this, cbArgs);\n"
    "      Reflect.apply(original, this, args).then(\n"
    "        (ret) => queueMicrotask(() => cb(null, ret)),\n"
    "        (rej) => queueMicrotask(() => {\n"
    "          if (rej === null || (typeof rej !== \"object\" && typeof rej !== \"function\")) {\n"
    "            const wrapped = new Error(\"Promise was rejected with a falsy value\");\n"
    "            wrapped.code = \"ERR_FALSY_VALUE_REJECTION\";\n"
    "            wrapped.reason = rej;\n"
    "            return cb(wrapped);\n"
    "          }\n"
    "          return cb(rej);\n"
    "        }),\n"
    "      );\n"
    "    }\n"
    "    Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));\n"
    "    const descriptors = Object.getOwnPropertyDescriptors(original);\n"
    "    Object.defineProperties(callbackified, descriptors);\n"
    "    return callbackified;\n"
    "  };\n"
    "  const deprecate = (fn, msg, code) => {\n"
    "    if (typeof fn !== \"function\") {\n"
    "      const e = new TypeError('The \"fn\" argument must be of type function');\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    let warned = false;\n"
    "    function deprecated(...args) {\n"
    "      if (!warned) {\n"
    "        warned = true;\n"
    "        const prefix = code !== undefined ? \"[\" + code + \"] DeprecationWarning\" : \"DeprecationWarning\";\n"
    "        env.writeErr(\"(node:\" + env.pid + \") \" + prefix + \": \" + msg + \"\\n\");\n"
    "      }\n"
    "      if (new.target) return Reflect.construct(fn, args, new.target);\n"
    "      return Reflect.apply(fn, this, args);\n"
    "    }\n"
    "    return deprecated;\n"
    "  };\n"
    "  let debugEnvSet;\n"
    "  const debuglog = (set, cb) => {\n"
    "    if (debugEnvSet === undefined) {\n"
    "      debugEnvSet = new Set(\n"
    "        String(env.env.NODE_DEBUG || \"\").toLowerCase().split(\",\").map((s) => s.trim()).filter((s) => s !== \"\"),\n"
    "      );\n"
    "    }\n"
    "    set = String(set).toLowerCase();\n"
    "    const enabled = debugEnvSet.has(set) || [...debugEnvSet].some((p) =>\n"
    "      p.includes(\"*\") && new RegExp(\"^\" + p.replace(/[.+?^${}()|[\\]\\\\]/g, \"\\\\$&\").replace(/\\*/g, \".*\") + \"$\").test(set));\n"
    "    let fn;\n"
    "    if (enabled) {\n"
    "      const setUpper = set.toUpperCase();\n"
    "      fn = (...args) => {\n"
    "        env.writeErr(setUpper + \" \" + env.pid + \": \" + format(...args) + \"\\n\");\n"
    "      };\n"
    "    } else {\n"
    "      fn = () => {};\n"
    "    }\n"
    "    Object.defineProperty(fn, \"enabled\", { get: () => enabled, configurable: true });\n"
    "    if (typeof cb === \"function\") cb(fn);\n"
    "    return fn;\n"
    "  };\n"
    "  const tagOf = (v) => Object.prototype.toString.call(v).slice(8, -1);\n"
    "  const taggedTest = (tag) => (v) => tagOf(v) === tag && typeof v === \"object\";\n"
    "  const taTagGetter = Object.getOwnPropertyDescriptor(\n"
    "    Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0))), Symbol.toStringTag).get;\n"
    "  const brandTA = (v) => {\n"
    "    try {\n"
    "      return taTagGetter.call(v) !== undefined;\n"
    "    } catch (e) {\n"
    "      return false;\n"
    "    }\n"
    "  };\n"
    "  const types = {\n"
    "    isAnyArrayBuffer: (v) => tagOf(v) === \"ArrayBuffer\" || tagOf(v) === \"SharedArrayBuffer\",\n"
    "    isArrayBufferView: (v) => ArrayBuffer.isView(v),\n"
    "    isArgumentsObject: taggedTest(\"Arguments\"),\n"
    "    isArrayBuffer: (v) => {\n"
    "      try { Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, \"byteLength\").get.call(v); return true; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isAsyncFunction: (v) => typeof v === \"function\" && tagOf(v) === \"AsyncFunction\",\n"
    "    isBigInt64Array: (v) => tagOf(v) === \"BigInt64Array\",\n"
    "    isBigUint64Array: (v) => tagOf(v) === \"BigUint64Array\",\n"
    "    isBooleanObject: (v) => {\n"
    "      try { Boolean.prototype.valueOf.call(v); return typeof v === \"object\"; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isBoxedPrimitive: (v) =>\n"
    "      types.isStringObject(v) || types.isNumberObject(v) || types.isBooleanObject(v) ||\n"
    "      types.isSymbolObject(v) || types.isBigIntObject(v),\n"
    "    isBigIntObject: (v) => {\n"
    "      try { BigInt.prototype.valueOf.call(v); return typeof v === \"object\"; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isCryptoKey: () => false,\n"
    "    isDataView: (v) => {\n"
    "      try { Object.getOwnPropertyDescriptor(DataView.prototype, \"byteLength\").get.call(v); return true; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isDate: (v) => {\n"
    "      try { Date.prototype.getTime.call(v); return true; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isExternal: () => false,\n"
    "    isFloat16Array: (v) => tagOf(v) === \"Float16Array\",\n"
    "    isFloat32Array: (v) => tagOf(v) === \"Float32Array\",\n"
    "    isFloat64Array: (v) => tagOf(v) === \"Float64Array\",\n"
    "    isGeneratorFunction: (v) => typeof v === \"function\" && tagOf(v) === \"GeneratorFunction\",\n"
    "    isGeneratorObject: (v) => typeof v === \"object\" && v !== null && tagOf(v) === \"Generator\",\n"
    "    isInt8Array: (v) => tagOf(v) === \"Int8Array\",\n"
    "    isInt16Array: (v) => tagOf(v) === \"Int16Array\",\n"
    "    isInt32Array: (v) => tagOf(v) === \"Int32Array\",\n"
    "    isKeyObject: () => false,\n"
    "    isMap: (v) => {\n"
    "      try { Object.getOwnPropertyDescriptor(Map.prototype, \"size\").get.call(v); return true; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isMapIterator: (v) => tagOf(v) === \"Map Iterator\",\n"
    "    isModuleNamespaceObject: (v) => typeof v === \"object\" && v !== null && tagOf(v) === \"Module\",\n"
    "    isNativeError: (v) => v instanceof Error && (\n"
    "      [\"Error\", \"EvalError\", \"RangeError\", \"ReferenceError\", \"SyntaxError\", \"TypeError\", \"URIError\", \"AggregateError\", \"SuppressedError\"].includes(tagOf(v))\n"
    "    ),\n"
    "    isNumberObject: (v) => {\n"
    "      try { Number.prototype.valueOf.call(v); return typeof v === \"object\"; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isPromise: (v) => v instanceof Promise,\n"
    "    isProxy: () => false,\n"
    "    isRegExp: (v) => tagOf(v) === \"RegExp\",\n"
    "    isSet: (v) => {\n"
    "      try { Object.getOwnPropertyDescriptor(Set.prototype, \"size\").get.call(v); return true; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isSetIterator: (v) => tagOf(v) === \"Set Iterator\",\n"
    "    isSharedArrayBuffer: (v) => tagOf(v) === \"SharedArrayBuffer\",\n"
    "    isStringObject: (v) => {\n"
    "      try { String.prototype.valueOf.call(v); return typeof v === \"object\"; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isSymbolObject: (v) => {\n"
    "      try { Symbol.prototype.valueOf.call(v); return typeof v === \"object\"; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isTypedArray: brandTA,\n"
    "    isUint8Array: (v) => tagOf(v) === \"Uint8Array\",\n"
    "    isUint8ClampedArray: (v) => tagOf(v) === \"Uint8ClampedArray\",\n"
    "    isUint16Array: (v) => tagOf(v) === \"Uint16Array\",\n"
    "    isUint32Array: (v) => tagOf(v) === \"Uint32Array\",\n"
    "    isWeakMap: (v) => {\n"
    "      try { WeakMap.prototype.has.call(v, {}); return true; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "    isWeakSet: (v) => {\n"
    "      try { WeakSet.prototype.has.call(v, {}); return true; }\n"
    "      catch (e) { return false; }\n"
    "    },\n"
    "  };\n"
    "  const deepEquals = (a, b, memos) => {\n"
    "    if (Object.is(a, b)) return true;\n"
    "    const ta = typeof a;\n"
    "    const tb = typeof b;\n"
    "    if (ta !== tb) return false;\n"
    "    if (ta === \"number\") return Number.isNaN(a) && Number.isNaN(b);\n"
    "    if (ta !== \"object\" && ta !== \"function\") return false;\n"
    "    if (a === null || b === null) return false;\n"
    "    const tagA = tagOf(a);\n"
    "    if (tagA !== tagOf(b)) return false;\n"
    "    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;\n"
    "    if (tagA === \"Date\") return Object.is(Date.prototype.getTime.call(a), Date.prototype.getTime.call(b));\n"
    "    if (tagA === \"RegExp\") return String(a) === String(b);\n"
    "    if (Array.isArray(a) && a.length !== b.length) return false;\n"
    "    if (types.isTypedArray(a)) {\n"
    "      if (a.length !== b.length) return false;\n"
    "      if (tagA === \"Float32Array\" || tagA === \"Float64Array\" || tagA === \"Float16Array\") {\n"
    "        for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;\n"
    "      } else {\n"
    "        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;\n"
    "      }\n"
    "      return true;\n"
    "    }\n"
    "    if (tagA === \"ArrayBuffer\") {\n"
    "      const ua = new Uint8Array(a);\n"
    "      const ub = new Uint8Array(b);\n"
    "      if (ua.length !== ub.length) return false;\n"
    "      for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;\n"
    "      return true;\n"
    "    }\n"
    "    if (a instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;\n"
    "    if (types.isBoxedPrimitive(a)) {\n"
    "      return Object.is(\n"
    "        (tagA === \"String\" ? String.prototype.valueOf : tagA === \"Number\" ? Number.prototype.valueOf\n"
    "          : tagA === \"Boolean\" ? Boolean.prototype.valueOf : tagA === \"BigInt\" ? BigInt.prototype.valueOf\n"
    "          : Symbol.prototype.valueOf).call(a),\n"
    "        (tagA === \"String\" ? String.prototype.valueOf : tagA === \"Number\" ? Number.prototype.valueOf\n"
    "          : tagA === \"Boolean\" ? Boolean.prototype.valueOf : tagA === \"BigInt\" ? BigInt.prototype.valueOf\n"
    "          : Symbol.prototype.valueOf).call(b));\n"
    "    }\n"
    "    memos = memos || { a: new Map(), b: new Map(), position: 0 };\n"
    "    const memoA = memos.a.get(a);\n"
    "    if (memoA !== undefined) {\n"
    "      const memoB = memos.b.get(b);\n"
    "      if (memoB !== undefined) return memoA === memoB;\n"
    "    }\n"
    "    memos.position++;\n"
    "    memos.a.set(a, memos.position);\n"
    "    memos.b.set(b, memos.position);\n"
    "    try {\n"
    "      if (tagA === \"Map\") {\n"
    "        if (a.size !== b.size) return false;\n"
    "        outer: for (const [k, v] of a) {\n"
    "          if (b.has(k)) {\n"
    "            if (deepEquals(v, b.get(k), memos)) continue;\n"
    "          }\n"
    "          for (const [k2, v2] of b) {\n"
    "            if (deepEquals(k, k2, memos) && deepEquals(v, v2, memos)) continue outer;\n"
    "          }\n"
    "          return false;\n"
    "        }\n"
    "        return true;\n"
    "      }\n"
    "      if (tagA === \"Set\") {\n"
    "        if (a.size !== b.size) return false;\n"
    "        outer2: for (const v of a) {\n"
    "          if (b.has(v)) continue;\n"
    "          for (const v2 of b) {\n"
    "            if (deepEquals(v, v2, memos)) continue outer2;\n"
    "          }\n"
    "          return false;\n"
    "        }\n"
    "        return true;\n"
    "      }\n"
    "      const keysA = Object.keys(a);\n"
    "      const keysB = Object.keys(b);\n"
    "      if (keysA.length !== keysB.length) return false;\n"
    "      for (const k of keysA) {\n"
    "        if (!Object.prototype.propertyIsEnumerable.call(b, k)) return false;\n"
    "        if (!deepEquals(a[k], b[k], memos)) return false;\n"
    "      }\n"
    "      const symsA = Object.getOwnPropertySymbols(a).filter((s) => Object.prototype.propertyIsEnumerable.call(a, s));\n"
    "      const symsB = Object.getOwnPropertySymbols(b).filter((s) => Object.prototype.propertyIsEnumerable.call(b, s));\n"
    "      if (symsA.length !== symsB.length) return false;\n"
    "      for (const s of symsA) {\n"
    "        if (!Object.prototype.propertyIsEnumerable.call(b, s)) return false;\n"
    "        if (!deepEquals(a[s], b[s], memos)) return false;\n"
    "      }\n"
    "      return true;\n"
    "    } finally {\n"
    "      memos.a.delete(a);\n"
    "      memos.b.delete(b);\n"
    "    }\n"
    "  };\n"
    "  const isDeepStrictEqual = (a, b) => deepEquals(a, b, undefined);\n"
    "  const ansiRe = /[\\u001b][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\\\#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\\\#&.:=?%@~_]*)*)?(?:|\\u001b\\|))|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))/g;\n"
    "  const stripVTControlCharacters = (str) => {\n"
    "    if (typeof str !== \"string\") {\n"
    "      const e = new TypeError('The \"str\" argument must be of type string. Received ' + (str === null ? \"null\" : typeof str === \"object\" ? \"an instance of Object\" : typeof str === \"undefined\" ? \"undefined\" : \"type \" + typeof str));\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    return str.replace(ansiRe, \"\");\n"
    "  };\n"
    "  const styleText = (fmt, text, options) => {\n"
    "    if (typeof text !== \"string\") {\n"
    "      const e = new TypeError('The \"text\" argument must be of type string. Received ' + (text === null ? \"null\" : typeof text === \"object\" ? \"an instance of Object\" : typeof text === \"undefined\" ? \"undefined\" : \"type \" + typeof text));\n"
    "      e.code = \"ERR_INVALID_ARG_TYPE\";\n"
    "      throw e;\n"
    "    }\n"
    "    const stream = options !== undefined && options !== null && options.stream !== undefined\n"
    "      ? options.stream : env.stdout;\n"
    "    let colorize = !!(stream && stream.isTTY);\n"
    "    if (env.env.NO_COLOR !== undefined || env.env.NODE_DISABLE_COLORS !== undefined) colorize = false;\n"
    "    if (env.env.FORCE_COLOR !== undefined && env.env.FORCE_COLOR !== \"0\") colorize = true;\n"
    "    const formats = Array.isArray(fmt) ? fmt : [fmt];\n"
    "    let left = \"\";\n"
    "    let right = \"\";\n"
    "    for (const f of formats) {\n"
    "      const pair = inspect.colors[f];\n"
    "      if (pair === undefined) {\n"
    "        const e = new TypeError(\"The value \\\"\" + String(f) + \"\\\" is invalid for argument 'format'. Reason: must be one of: \" + Object.keys(inspect.colors).join(\", \"));\n"
    "        e.code = \"ERR_INVALID_ARG_VALUE\";\n"
    "        throw e;\n"
    "      }\n"
    "      left += \"\\u001b[\" + pair[0] + \"m\";\n"
    "      right = \"\\u001b[\" + pair[1] + \"m\" + right;\n"
    "    }\n"
    "    return colorize ? left + text + right : text;\n"
    "  };\n"
    "  const parseArgs = (config) => {\n"
    "    config = config === undefined ? {} : config;\n"
    "    const args = config.args !== undefined ? config.args : env.argv.slice(2);\n"
    "    const strict = config.strict !== undefined ? !!config.strict : true;\n"
    "    const allowPositionals = config.allowPositionals !== undefined ? !!config.allowPositionals : !strict;\n"
    "    const allowNegative = !!config.allowNegative;\n"
    "    const returnTokens = !!config.tokens;\n"
    "    const options = config.options !== undefined ? config.options : {};\n"
    "    const result = { values: { __proto__: null }, positionals: [] };\n"
    "    const tokens = [];\n"
    "    const shortOf = (ch) => {\n"
    "      for (const name of Object.keys(options)) {\n"
    "        if (options[name].short === ch) return name;\n"
    "      }\n"
    "      return undefined;\n"
    "    };\n"
    "    const unknownError = (raw) => {\n"
    "      const e = new TypeError(\"Unknown option '\" + raw + \"'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \\\"\" + raw + \"\\\"\");\n"
    "      e.code = \"ERR_PARSE_ARGS_UNKNOWN_OPTION\";\n"
    "      throw e;\n"
    "    };\n"
    "    const store = (name, value, raw) => {\n"
    "      const cfg = options[name] || {};\n"
    "      const type = cfg.type;\n"
    "      if (strict) {\n"
    "        if (options[name] === undefined) unknownError(raw);\n"
    "        if (type === \"string\" && value === undefined) {\n"
    "          const e = new TypeError(\"Option '\" + raw + (cfg.short && raw.startsWith(\"--\") === false ? \"\" : \"\") + \" <value>' argument missing\");\n"
    "          e.code = \"ERR_PARSE_ARGS_INVALID_OPTION_VALUE\";\n"
    "          throw e;\n"
    "        }\n"
    "        if (type === \"boolean\" && value !== undefined) {\n"
    "          const e = new TypeError(\"Option '\" + raw + \"' does not take an argument\");\n"
    "          e.code = \"ERR_PARSE_ARGS_INVALID_OPTION_VALUE\";\n"
    "          throw e;\n"
    "        }\n"
    "      }\n"
    "      const finalValue = value === undefined ? true : value;\n"
    "      tokens.push({ kind: \"option\", name, rawName: raw, index: tokenIndex, value: value === undefined ? undefined : value, inlineValue: inline });\n"
    "      if (cfg.multiple) {\n"
    "        if (result.values[name] === undefined) result.values[name] = [];\n"
    "        result.values[name].push(finalValue);\n"
    "      } else {\n"
    "        result.values[name] = finalValue;\n"
    "      }\n"
    "    };\n"
    "    let tokenIndex = -1;\n"
    "    let inline;\n"
    "    let afterDashDash = false;\n"
    "    for (let i = 0; i < args.length; i++) {\n"
    "      const arg = args[i];\n"
    "      tokenIndex = i;\n"
    "      inline = undefined;\n"
    "      if (afterDashDash) {\n"
    "        tokens.push({ kind: \"positional\", index: i, value: arg });\n"
    "        result.positionals.push(arg);\n"
    "        continue;\n"
    "      }\n"
    "      if (arg === \"--\") {\n"
    "        afterDashDash = true;\n"
    "        tokens.push({ kind: \"option-terminator\", index: i });\n"
    "        continue;\n"
    "      }\n"
    "      if (arg.startsWith(\"--\")) {\n"
    "        const eq = arg.indexOf(\"=\");\n"
    "        if (eq !== -1) {\n"
    "          const name = arg.slice(2, eq);\n"
    "          inline = true;\n"
    "          store(name, arg.slice(eq + 1), \"--\" + name);\n"
    "        } else {\n"
    "          const name = arg.slice(2);\n"
    "          const cfg = options[name];\n"
    "          if (cfg !== undefined && cfg.type === \"string\" && i + 1 < args.length) {\n"
    "            inline = false;\n"
    "            store(name, args[++i], arg);\n"
    "          } else if (allowNegative && name.startsWith(\"no-\") && (options[name.slice(3)] || {}).type === \"boolean\") {\n"
    "            const positive = name.slice(3);\n"
    "            tokens.push({ kind: \"option\", name: positive, rawName: arg, index: i, value: undefined, inlineValue: undefined });\n"
    "            result.values[positive] = false;\n"
    "          } else {\n"
    "            if (strict && cfg === undefined) unknownError(arg);\n"
    "            if (strict && cfg.type === \"string\") {\n"
    "              const e = new TypeError(\"Option '--\" + name + \" <value>' argument missing\");\n"
    "              e.code = \"ERR_PARSE_ARGS_INVALID_OPTION_VALUE\";\n"
    "              throw e;\n"
    "            }\n"
    "            store(name, undefined, arg);\n"
    "          }\n"
    "        }\n"
    "        continue;\n"
    "      }\n"
    "      if (arg.length > 1 && arg[0] === \"-\") {\n"
    "        const chars = arg.slice(1);\n"
    "        let consumed = false;\n"
    "        for (let c = 0; c < chars.length; c++) {\n"
    "          const ch = chars[c];\n"
    "          const name = shortOf(ch);\n"
    "          const raw = \"-\" + ch;\n"
    "          const cfg = name !== undefined ? options[name] : undefined;\n"
    "          if (cfg !== undefined && cfg.type === \"string\") {\n"
    "            if (c < chars.length - 1) {\n"
    "              inline = true;\n"
    "              store(name, chars.slice(c + 1), raw);\n"
    "            } else if (i + 1 < args.length) {\n"
    "              inline = false;\n"
    "              store(name, args[++i], raw);\n"
    "            } else if (strict) {\n"
    "              const e = new TypeError(\"Option '\" + raw + \", --\" + name + \" <value>' argument missing\");\n"
    "              e.code = \"ERR_PARSE_ARGS_INVALID_OPTION_VALUE\";\n"
    "              throw e;\n"
    "            } else {\n"
    "              store(name, undefined, raw);\n"
    "            }\n"
    "            consumed = true;\n"
    "            break;\n"
    "          }\n"
    "          if (name === undefined) {\n"
    "            if (strict) unknownError(raw);\n"
    "            store(ch, undefined, raw);\n"
    "          } else {\n"
    "            store(name, undefined, raw);\n"
    "          }\n"
    "        }\n"
    "        void consumed;\n"
    "        continue;\n"
    "      }\n"
    "      if (strict && !allowPositionals) {\n"
    "        const e = new TypeError(\"Unexpected argument '\" + arg + \"'. This command does not take positional arguments\");\n"
    "        e.code = \"ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL\";\n"
    "        throw e;\n"
    "      }\n"
    "      tokens.push({ kind: \"positional\", index: i, value: arg });\n"
    "      result.positionals.push(arg);\n"
    "    }\n"
    "    for (const name of Object.keys(options)) {\n"
    "      const cfg = options[name];\n"
    "      if (cfg.default !== undefined && !(name in result.values)) {\n"
    "        result.values[name] = cfg.default;\n"
    "      }\n"
    "    }\n"
    "    if (returnTokens) result.tokens = tokens;\n"
    "    return result;\n"
    "  };\n"
    "  const toUSVString = (s) => String(s).replace(/[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/g, \"�\");\n"
    "  const _extend = (target, source) => {\n"
    "    if (source === null || typeof source !== \"object\") return target;\n"
    "    for (const k of Object.keys(source)) target[k] = source[k];\n"
    "    return target;\n"
    "  };\n"
    "  const util = {\n"
    "    format, formatWithOptions, inspect, inherits, promisify, callbackify,\n"
    "    deprecate, debuglog, debug: debuglog, types, isDeepStrictEqual,\n"
    "    stripVTControlCharacters, styleText, parseArgs, toUSVString, _extend,\n"
    "    TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,\n"
    "    isArray: (v) => Array.isArray(v),\n"
    "  };\n"
    "  return util;\n"
    "}\n"
    "    const util = makeUtil({\n"
    "      promiseState: (p) => host.promiseState(p),\n"
    "      writeErr: (s) => host.write(2, s),\n"
    "      env: builtins.process().env,\n"
    "      pid: host.pid(),\n"
    "      argv: builtins.process().argv,\n"
    "      stdout: builtins.process().stdout,\n"
    "    });\n"
    "    util.default = util;\n"
    "    return util;\n"
    "  });\n"
    /* node:util/types IS util.types (Node aliases the module to the
     * same object; require('util/types') === require('util').types). */
    "  builtins['util/types'] = memo(() => {\n"
    "    const t = builtins.util().types;\n"
    "    t.default = t;\n"
    "    return t;\n"
    "  });\n"
    "  builtins.child_process = memo(() => {\n"
    "    const die = (name) => () => {\n"
    "      throw new Error('child_process.' + name + ' is not available in the scriptc island');\n"
    "    };\n"
    "    const cp = {};\n"
    "    for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[n] = die(n);\n"
    "    cp.default = cp;\n"
    "    return cp;\n"
    "  });\n"
    /* node:async_hooks — the two classes CLIs actually construct
     * (AsyncLocalStorage, AsyncResource) with SYNC-FRAME semantics:
     * run() scopes the store for the synchronous call (plus anything
     * it calls); the store does NOT survive across engine awaits the
     * way Node's continuation tracking preserves it (documented
     * divergence — the island has no promise-hook machinery). The
     * hook/id surface is inert: createHook returns a disabled hook,
     * ids are constants. */
    "  builtins.async_hooks = memo(() => {\n"
    "    class AsyncLocalStorage {\n"
    "      constructor() { this._stack = []; this._entered = undefined; }\n"
    "      run(store, fn, ...args) {\n"
    "        this._stack.push(store);\n"
    "        try { return fn(...args); }\n"
    "        finally { this._stack.pop(); }\n"
    "      }\n"
    "      exit(fn, ...args) { return this.run(undefined, fn, ...args); }\n"
    "      getStore() {\n"
    "        if (this._stack.length > 0) return this._stack[this._stack.length - 1];\n"
    "        return this._entered;\n"
    "      }\n"
    "      enterWith(store) { this._entered = store; }\n"
    "      disable() { this._stack = []; this._entered = undefined; }\n"
    "      static bind(fn) { return fn; }\n"
    "      static snapshot() { return (cb, ...args) => cb(...args); }\n"
    "    }\n"
    "    class AsyncResource {\n"
    "      constructor(type, opts) { this.type = String(type); void opts; }\n"
    "      runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); }\n"
    "      bind(fn, thisArg) {\n"
    "        const res = this;\n"
    "        return function bound(...args) { return res.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args); };\n"
    "      }\n"
    "      static bind(fn, type, thisArg) { return new AsyncResource(type || 'bound-anonymous-fn').bind(fn, thisArg); }\n"
    "      emitDestroy() { return this; }\n"
    "      asyncId() { return 1; }\n"
    "      triggerAsyncId() { return 0; }\n"
    "    }\n"
    "    const ah = {\n"
    "      AsyncLocalStorage, AsyncResource,\n"
    "      executionAsyncId: () => 1,\n"
    "      triggerAsyncId: () => 0,\n"
    "      executionAsyncResource: () => ({}),\n"
    "      createHook: () => ({ enable() { return this; }, disable() { return this; } }),\n"
    "    };\n"
    "    ah.default = ah;\n"
    "    return ah;\n"
    "  });\n"
    /* node:domain — the deprecated legacy module, shimmed because
     * @sentry/node (inside a real CLI's graph) REQUIRES it at load
     * on every path (async/domain.js's top level) while only DRIVING it
     * on Node < 14, which never happens here. The shim keeps the module
     * loadable with the real synchronous surface: create()/Domain,
     * enter/exit maintaining the active stack, run/bind/intercept
     * catching sync throws into 'error' listeners (re-thrown when nobody
     * listens, Node's fatal path). Async error TRAPPING does not
     * propagate (no async_hooks machinery) — the documented limit of the
     * island's domain, same family as the async_hooks shim above. */
    "  builtins.domain = memo(() => {\n"
    "    const EventEmitter = builtins.events();\n"
    "    const stack = [];\n"
    "    const d = { _stack: stack, active: null };\n"
    "    class Domain extends EventEmitter {\n"
    "      constructor() { super(); this.members = []; }\n"
    "      enter() { stack.push(this); d.active = this; }\n"
    "      exit() {\n"
    "        const i = stack.lastIndexOf(this);\n"
    "        if (i === -1) return;\n"
    "        stack.splice(i);\n"
    "        d.active = stack.length > 0 ? stack[stack.length - 1] : null;\n"
    "      }\n"
    /* run/bind do NOT catch: Node's sync throws propagate to the caller
     * (the domain traps only errors that reach the fatal/async layers —
     * machinery the island does not carry). And they exit the domain only
     * on the NON-throw path — Node's own bind runs enter → cb → exit with
     * no finally, so a throw leaves the domain ENTERED (oracle-pinned:
     * domain.active stays the domain after a throwing run). intercept's
     * error arm is the one documented emit path: decorate and emit
     * 'error' (an unhandled 'error' throws through the EventEmitter
     * contract, like Node). */
    "      run(fn, ...args) {\n"
    "        this.enter();\n"
    "        const ret = fn.apply(this, args);\n"
    "        this.exit();\n"
    "        return ret;\n"
    "      }\n"
    "      add(ee) { if (this.members.indexOf(ee) === -1) this.members.push(ee); if (ee) ee.domain = this; }\n"
    "      remove(ee) { const i = this.members.indexOf(ee); if (i !== -1) this.members.splice(i, 1); if (ee && ee.domain === this) ee.domain = undefined; }\n"
    "      bind(cb) {\n"
    "        const self = this;\n"
    "        function bound(...args) {\n"
    "          self.enter();\n"
    "          const ret = cb.apply(this, args);\n"
    "          self.exit();\n"
    "          return ret;\n"
    "        }\n"
    "        bound.domain = this;\n"
    "        return bound;\n"
    "      }\n"
    "      intercept(cb) {\n"
    "        const self = this;\n"
    "        return this.bind(function intercepted(err, ...rest) {\n"
    "          if (err) {\n"
    "            if (typeof err === 'object' && err !== null) { err.domain = self; err.domainThrown = false; }\n"
    "            self.emit('error', err);\n"
    "            return undefined;\n"
    "          }\n"
    "          return cb.apply(this, rest);\n"
    "        });\n"
    "      }\n"
    "      dispose() { this.exit(); this.removeAllListeners(); return this; }\n"
    "    }\n"
    "    const create = () => new Domain();\n"
    "    d.Domain = Domain;\n"
    "    d.create = create;\n"
    "    d.createDomain = create;\n"
    "    d.default = d;\n"
    "    return d;\n"
    "  });\n"
    /* node:worker_threads — the MAIN-THREAD surface, loadable because
     * undici (proxy-agent's dispatcher, in a real CLI's graph when
     * proxy env vars exist) requires it UNGUARDED at load: fetch/
     * constants.js destructures MessageChannel/receiveMessageOnPort for
     * its structuredClone fallback, websocket/events.js MessagePort.
     * Ports are a REAL in-process pair (postMessage queues on the peer,
     * receiveMessageOnPort drains) with one documented divergence:
     * messages pass by REFERENCE, not structured clone — the island has
     * no serializer, and the only in-graph consumer clones-and-reads
     * immediately. Worker itself fences loudly at construction: there is
     * no worker runtime. */
    "  builtins.worker_threads = memo(() => {\n"
    "    /* The pair IS the web prelude's global classes (Node exposes the\n"
    "     * same identities as globals and module members), so instanceof\n"
    "     * agrees across both spellings; postMessage delivers\n"
    "     * structuredClone copies through the prelude's serializer. */\n"
    "    const MessagePort = globalThis.MessagePort;\n"
    "    const MessageChannel = globalThis.MessageChannel;\n"
    "    const receiveMessageOnPort = (port) => (port._queue.length > 0 ? port._queue.shift() : undefined);\n"
    "    class Worker {\n"
    "      constructor() { throw new Error(\"node:worker_threads 'Worker' is not supported in the scriptc island (the embedded engine has no worker runtime)\"); }\n"
    "    }\n"
    "    const wt = {\n"
    "      isMainThread: true, parentPort: null, threadId: 0, workerData: null, resourceLimits: {},\n"
    "      MessageChannel, MessagePort, Worker, receiveMessageOnPort,\n"
    "      markAsUntransferable: () => {}, isMarkedAsUntransferable: () => false,\n"
    "      getEnvironmentData: () => undefined, setEnvironmentData: () => {},\n"
    "      SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'),\n"
    "    };\n"
    "    wt.default = wt;\n"
    "    return wt;\n"
    "  });\n"
    /* node:perf_hooks — performance with a real monotonic-ish clock
     * (Date.now against the module's load origin; the island has no
     * hrtime source) and inert mark/measure bookkeeping. undici's
     * fetch/util.js destructures { performance } UNGUARDED at load. */
    "  builtins.perf_hooks = memo(() => {\n"
    "    const timeOrigin = Date.now();\n"
    "    const performance = {\n"
    "      timeOrigin,\n"
    "      now: () => Date.now() - timeOrigin,\n"
    "      mark: () => ({}),\n"
    "      measure: () => ({}),\n"
    "      clearMarks: () => {},\n"
    "      clearMeasures: () => {},\n"
    "      getEntries: () => [],\n"
    "      getEntriesByName: () => [],\n"
    "      getEntriesByType: () => [],\n"
    "      eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),\n"
    "    };\n"
    "    class PerformanceObserver {\n"
    "      constructor() {}\n"
    "      observe() {}\n"
    "      disconnect() {}\n"
    "      takeRecords() { return []; }\n"
    "    }\n"
    "    PerformanceObserver.supportedEntryTypes = [];\n"
    "    const ph = {\n"
    "      performance, PerformanceObserver,\n"
    "      monitorEventLoopDelay: () => ({ enable: () => {}, disable: () => {}, reset: () => {}, min: 0, max: 0, mean: 0, stddev: 0, percentile: () => 0 }),\n"
    "      constants: {},\n"
    "    };\n"
    "    ph.default = ph;\n"
    "    return ph;\n"
    "  });\n"
    /* node:v8 — LOADABLE with Node's surface shape. Prettier's bundled
     * error helpers call startupSnapshot.isBuildingSnapshot() (inside a
     * try/catch) on every CLI start, so the module must import cleanly
     * and that one question must answer for real: the island is never a
     * snapshot build, so false — and the snapshot mutators throw Node's
     * ERR_NOT_BUILDING_SNAPSHOT exactly as a regular Node process does.
     * Heap statistics follow the os-shim's inert-half rule (all of
     * Node's keys, zero values — the embedded engine has no V8 heap to
     * report), flag/coverage entries are Node's own no-op paths, and the
     * V8-specific serialization wire format (serialize/deserialize and
     * the (De)Serializer classes) fences loudly at the call — the
     * embedded engine cannot produce or consume V8 serialization data. */
    "  builtins.v8 = memo(() => {\n"
    "    const fence = (what) => () => { throw new Error(\"node:v8 '\" + what + \"' is not supported in the scriptc island (the embedded engine has no V8 heap or serialization format)\"); };\n"
    "    const notBuilding = () => {\n"
    "      const e = new Error('Operation cannot be invoked when not building startup snapshot');\n"
    "      e.code = 'ERR_NOT_BUILDING_SNAPSHOT';\n"
    "      throw e;\n"
    "    };\n"
    "    const startupSnapshot = {\n"
    "      isBuildingSnapshot: () => false,\n"
    "      addSerializeCallback: notBuilding,\n"
    "      addDeserializeCallback: notBuilding,\n"
    "      setDeserializeMainFunction: notBuilding,\n"
    "    };\n"
    "    class FencedClass { constructor() { fence(new.target.name)(); } }\n"
    "    class Serializer extends FencedClass {}\n"
    "    class Deserializer extends FencedClass {}\n"
    "    class DefaultSerializer extends FencedClass {}\n"
    "    class DefaultDeserializer extends FencedClass {}\n"
    "    class GCProfiler extends FencedClass {}\n"
    "    const v8 = {\n"
    "      startupSnapshot,\n"
    "      cachedDataVersionTag: () => 0,\n"
    "      getHeapStatistics: () => ({ total_heap_size: 0, total_heap_size_executable: 0, total_physical_size: 0, total_available_size: 0, used_heap_size: 0, heap_size_limit: 0, malloced_memory: 0, peak_malloced_memory: 0, does_zap_garbage: 0, number_of_native_contexts: 0, number_of_detached_contexts: 0, total_global_handles_size: 0, used_global_handles_size: 0, external_memory: 0 }),\n"
    "      getHeapSpaceStatistics: () => [],\n"
    "      getHeapCodeStatistics: () => ({ code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }),\n"
    "      getCppHeapStatistics: () => ({}),\n"
    "      setFlagsFromString: () => undefined,\n"
    "      takeCoverage: () => undefined,\n"
    "      stopCoverage: () => undefined,\n"
    "      setHeapSnapshotNearHeapLimit: () => undefined,\n"
    "      serialize: fence('serialize'),\n"
    "      deserialize: fence('deserialize'),\n"
    "      writeHeapSnapshot: fence('writeHeapSnapshot'),\n"
    "      getHeapSnapshot: fence('getHeapSnapshot'),\n"
    "      queryObjects: fence('queryObjects'),\n"
    "      startCpuProfile: fence('startCpuProfile'),\n"
    "      isStringOneByteRepresentation: fence('isStringOneByteRepresentation'),\n"
    "      promiseHooks: { onInit: fence('promiseHooks.onInit'), onSettled: fence('promiseHooks.onSettled'), onBefore: fence('promiseHooks.onBefore'), onAfter: fence('promiseHooks.onAfter'), createHook: fence('promiseHooks.createHook') },\n"
    "      Serializer, Deserializer, DefaultSerializer, DefaultDeserializer, GCProfiler,\n"
    "    };\n"
    "    v8.default = v8;\n"
    "    return v8;\n"
    "  });\n"
    /* node:dns — LOADABLE with Node's surface shape, answers fenced at
     * the call. proxy-agent's pac-resolver (in a real CLI's graph
     * whenever proxy env vars exist) requires dns at LOAD and only calls
     * lookup when a PAC proxy actually resolves — so the module must
     * import cleanly, and the callback-taking members deliver their
     * refusal THROUGH the callback (Node's error channel for dns), which
     * keeps a caller's own error handling alive instead of crashing the
     * call site. promises members reject. No resolver ships: the island
     * has no DNS client — the fence text says so at the only point Node
     * would have queried. */
    "  builtins.dns = memo(() => {\n"
    "    const fenceErr = (what) => {\n"
    "      const e = new Error(\"node:dns '\" + what + \"' is not supported in the scriptc island yet\");\n"
    "      e.code = 'ENOTFOUND';\n"
    "      e.syscall = what;\n"
    "      return e;\n"
    "    };\n"
    "    const cbFence = (what) => (...args) => {\n"
    "      const cb = args[args.length - 1];\n"
    "      if (typeof cb === 'function') { queueMicrotask(() => cb(fenceErr(what))); return; }\n"
    "      throw fenceErr(what);\n"
    "    };\n"
    "    const pFence = (what) => (...args) => Promise.reject(fenceErr(what));\n"
    "    const promises = {\n"
    "      lookup: pFence('lookup'), lookupService: pFence('lookupService'),\n"
    "      resolve: pFence('resolve'), resolve4: pFence('resolve4'), resolve6: pFence('resolve6'),\n"
    "      resolveCname: pFence('resolveCname'), resolveMx: pFence('resolveMx'),\n"
    "      resolveNs: pFence('resolveNs'), resolveSrv: pFence('resolveSrv'),\n"
    "      resolveTxt: pFence('resolveTxt'), reverse: pFence('reverse'),\n"
    "      getServers: () => [], setServers: () => {},\n"
    "    };\n"
    "    class Resolver {\n"
    "      constructor() {}\n"
    "      getServers() { return []; }\n"
    "      setServers() {}\n"
    "    }\n"
    "    for (const m of ['resolve', 'resolve4', 'resolve6', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse']) {\n"
    "      Resolver.prototype[m] = cbFence(m);\n"
    "    }\n"
    "    const d = {\n"
    "      lookup: cbFence('lookup'), lookupService: cbFence('lookupService'),\n"
    "      resolve: cbFence('resolve'), resolve4: cbFence('resolve4'), resolve6: cbFence('resolve6'),\n"
    "      resolveCname: cbFence('resolveCname'), resolveMx: cbFence('resolveMx'),\n"
    "      resolveNs: cbFence('resolveNs'), resolveSrv: cbFence('resolveSrv'),\n"
    "      resolveTxt: cbFence('resolveTxt'), reverse: cbFence('reverse'),\n"
    "      getServers: () => [], setServers: () => {},\n"
    "      Resolver, promises,\n"
    "      ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256,\n"
    "      NODATA: 'ENODATA', FORMERR: 'EFORMERR', SERVFAIL: 'ESERVFAIL',\n"
    "      NOTFOUND: 'ENOTFOUND', NOTIMP: 'ENOTIMP', REFUSED: 'EREFUSED',\n"
    "    };\n"
    "    d.default = d;\n"
    "    return d;\n"
    "  });\n"
    /* node:readline — createInterface over any Readable-ish input
     * (data-event line splitting, question/line/close, async
     * iteration) and the cursor-control writers (the ANSI sequences
     * Node writes). Terminal echo/keypress machinery is inert. */
    "  builtins.readline = memo(() => {\n"
    "    const EventEmitter = builtins.events();\n"
    "    class Interface extends EventEmitter {\n"
    "      constructor(input, output, completer, terminal) {\n"
    "        super();\n"
    "        let opts = input;\n"
    "        if (!opts || typeof opts.on === 'function') opts = { input, output, completer, terminal };\n"
    "        this.input = opts.input;\n"
    "        this.output = opts.output;\n"
    "        this.terminal = opts.terminal !== undefined ? !!opts.terminal : !!(this.output && this.output.isTTY);\n"
    "        this._prompt = opts.prompt !== undefined ? opts.prompt : '> ';\n"
    "        this._buf = '';\n"
    "        this.closed = false;\n"
    "        this.line = '';\n"
    "        this.cursor = 0;\n"
    "        this._onData = (chunk) => {\n"
    "          this._buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');\n"
    "          let i;\n"
    "          while ((i = this._buf.indexOf('\\n')) >= 0) {\n"
    "            let line = this._buf.slice(0, i);\n"
    "            if (line.endsWith('\\r')) line = line.slice(0, -1);\n"
    "            this._buf = this._buf.slice(i + 1);\n"
    /* a pending question consumes the line — Node's Interface answers
     * the question without emitting 'line' for that row */
    "            const q = this._questions && this._questions.shift();\n"
    "            if (q !== undefined) q(line);\n"
    "            else this.emit('line', line);\n"
    "          }\n"
    "        };\n"
    "        this._onEnd = () => this.close();\n"
    "        if (this.input && typeof this.input.on === 'function') {\n"
    "          this.input.on('data', this._onData);\n"
    "          this.input.on('end', this._onEnd);\n"
    "        }\n"
    "      }\n"
    "      question(query, optionsOrCb, maybeCb) {\n"
    "        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;\n"
    "        if (this.output && typeof this.output.write === 'function') this.output.write(String(query));\n"
    "        if (typeof cb === 'function') {\n"
    "          if (this._questions === undefined) this._questions = [];\n"
    "          this._questions.push(cb);\n"
    "        }\n"
    "      }\n"
    "      setPrompt(p) { this._prompt = String(p); }\n"
    "      getPrompt() { return this._prompt; }\n"
    "      prompt() {\n"
    "        if (this.output && typeof this.output.write === 'function') this.output.write(this._prompt);\n"
    "      }\n"
    "      write(data) {\n"
    "        if (data !== undefined && data !== null && this.output && typeof this.output.write === 'function') this.output.write(String(data));\n"
    "      }\n"
    "      pause() { if (this.input && this.input.pause) this.input.pause(); return this; }\n"
    "      resume() { if (this.input && this.input.resume) this.input.resume(); return this; }\n"
    "      close() {\n"
    "        if (this.closed) return;\n"
    "        this.closed = true;\n"
    "        if (this.input && typeof this.input.removeListener === 'function') {\n"
    "          this.input.removeListener('data', this._onData);\n"
    "          this.input.removeListener('end', this._onEnd);\n"
    "        }\n"
    "        this.emit('close');\n"
    "      }\n"
    "      [Symbol.asyncIterator]() {\n"
    "        const lines = [];\n"
    "        let notify = null;\n"
    "        let done = false;\n"
    "        this.on('line', (l) => { lines.push(l); if (notify) { const n = notify; notify = null; n(); } });\n"
    "        this.on('close', () => { done = true; if (notify) { const n = notify; notify = null; n(); } });\n"
    "        return {\n"
    "          next: async () => {\n"
    "            while (lines.length === 0 && !done) await new Promise((res) => { notify = res; });\n"
    "            if (lines.length > 0) return { value: lines.shift(), done: false };\n"
    "            return { value: undefined, done: true };\n"
    "          },\n"
    "          [Symbol.asyncIterator]() { return this; },\n"
    "        };\n"
    "      }\n"
    "    }\n"
    "    const wr = (stream, s, cb) => {\n"
    "      if (stream && typeof stream.write === 'function') stream.write(s);\n"
    "      if (typeof cb === 'function') queueMicrotask(cb);\n"
    "      return true;\n"
    "    };\n"
    "    const rl = {\n"
    "      Interface,\n"
    "      createInterface: (input, output, completer, terminal) => new Interface(input, output, completer, terminal),\n"
    "      clearLine: (stream, dir, cb) => wr(stream, dir < 0 ? '\\u001b[1K' : dir > 0 ? '\\u001b[0K' : '\\u001b[2K', cb),\n"
    "      clearScreenDown: (stream, cb) => wr(stream, '\\u001b[0J', cb),\n"
    "      cursorTo: (stream, x, y, cb) => {\n"
    "        if (typeof y === 'function') { cb = y; y = undefined; }\n"
    "        return wr(stream, y === undefined ? '\\u001b[' + (x + 1) + 'G' : '\\u001b[' + (y + 1) + ';' + (x + 1) + 'H', cb);\n"
    "      },\n"
    "      moveCursor: (stream, dx, dy, cb) => {\n"
    "        let s = '';\n"
    "        if (dx < 0) s += '\\u001b[' + (-dx) + 'D'; else if (dx > 0) s += '\\u001b[' + dx + 'C';\n"
    "        if (dy < 0) s += '\\u001b[' + (-dy) + 'A'; else if (dy > 0) s += '\\u001b[' + dy + 'B';\n"
    "        return wr(stream, s, cb);\n"
    "      },\n"
    "      emitKeypressEvents: () => {},\n"
    "    };\n"
    "    rl.default = rl;\n"
    "    return rl;\n"
    "  });\n"
    /* node:punycode — Node's vendored userland punycode (RFC 3492),
     * ported and differentially tested (tr46/whatwg-url require it). */
    "  builtins.punycode = memo(() => {\n"
    "function makePunycode() {\n"
    "  const maxInt = 2147483647;\n"
    "  const base = 36;\n"
    "  const tMin = 1;\n"
    "  const tMax = 26;\n"
    "  const skew = 38;\n"
    "  const damp = 700;\n"
    "  const initialBias = 72;\n"
    "  const initialN = 128;\n"
    "  const delimiter = \"-\";\n"
    "  const regexNonASCII = /[^\\0-\\x7F]/;\n"
    "  const regexSeparators = /[\\x2E。．｡]/g;\n"
    "  const error = (type) => {\n"
    "    const messages = {\n"
    "      \"overflow\": \"Overflow: input needs wider integers to process\",\n"
    "      \"not-basic\": \"Illegal input >= 0x80 (not a basic code point)\",\n"
    "      \"invalid-input\": \"Invalid input\",\n"
    "    };\n"
    "    throw new RangeError(messages[type]);\n"
    "  };\n"
    "  const ucs2decode = (string) => {\n"
    "    const output = [];\n"
    "    let counter = 0;\n"
    "    const length = string.length;\n"
    "    while (counter < length) {\n"
    "      const value = string.charCodeAt(counter++);\n"
    "      if (value >= 0xd800 && value <= 0xdbff && counter < length) {\n"
    "        const extra = string.charCodeAt(counter++);\n"
    "        if ((extra & 0xfc00) === 0xdc00) {\n"
    "          output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);\n"
    "        } else {\n"
    "          output.push(value);\n"
    "          counter--;\n"
    "        }\n"
    "      } else {\n"
    "        output.push(value);\n"
    "      }\n"
    "    }\n"
    "    return output;\n"
    "  };\n"
    "  const ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);\n"
    "  const basicToDigit = (codePoint) => {\n"
    "    if (codePoint >= 0x30 && codePoint < 0x3a) return 26 + (codePoint - 0x30);\n"
    "    if (codePoint >= 0x41 && codePoint < 0x5b) return codePoint - 0x41;\n"
    "    if (codePoint >= 0x61 && codePoint < 0x7b) return codePoint - 0x61;\n"
    "    return base;\n"
    "  };\n"
    "  const digitToBasic = (digit, flag) => digit + 22 + 75 * (digit < 26) - ((flag !== 0) << 5);\n"
    "  const adapt = (delta, numPoints, firstTime) => {\n"
    "    let k = 0;\n"
    "    delta = firstTime ? Math.floor(delta / damp) : delta >> 1;\n"
    "    delta += Math.floor(delta / numPoints);\n"
    "    for (; delta > ((base - tMin) * tMax) >> 1; k += base) {\n"
    "      delta = Math.floor(delta / (base - tMin));\n"
    "    }\n"
    "    return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));\n"
    "  };\n"
    "  const decode = (input) => {\n"
    "    const output = [];\n"
    "    const inputLength = input.length;\n"
    "    let i = 0;\n"
    "    let n = initialN;\n"
    "    let bias = initialBias;\n"
    "    let basic = input.lastIndexOf(delimiter);\n"
    "    if (basic < 0) basic = 0;\n"
    "    for (let j = 0; j < basic; ++j) {\n"
    "      if (input.charCodeAt(j) >= 0x80) error(\"not-basic\");\n"
    "      output.push(input.charCodeAt(j));\n"
    "    }\n"
    "    for (let index = basic > 0 ? basic + 1 : 0; index < inputLength;) {\n"
    "      const oldi = i;\n"
    "      for (let w = 1, k = base; ; k += base) {\n"
    "        if (index >= inputLength) error(\"invalid-input\");\n"
    "        const digit = basicToDigit(input.charCodeAt(index++));\n"
    "        if (digit >= base) error(\"invalid-input\");\n"
    "        if (digit > Math.floor((maxInt - i) / w)) error(\"overflow\");\n"
    "        i += digit * w;\n"
    "        const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);\n"
    "        if (digit < t) break;\n"
    "        const baseMinusT = base - t;\n"
    "        if (w > Math.floor(maxInt / baseMinusT)) error(\"overflow\");\n"
    "        w *= baseMinusT;\n"
    "      }\n"
    "      const out = output.length + 1;\n"
    "      bias = adapt(i - oldi, out, oldi === 0);\n"
    "      if (Math.floor(i / out) > maxInt - n) error(\"overflow\");\n"
    "      n += Math.floor(i / out);\n"
    "      i %= out;\n"
    "      output.splice(i++, 0, n);\n"
    "    }\n"
    "    return String.fromCodePoint(...output);\n"
    "  };\n"
    "  const encode = (input) => {\n"
    "    const output = [];\n"
    "    const decoded = ucs2decode(String(input));\n"
    "    const inputLength = decoded.length;\n"
    "    let n = initialN;\n"
    "    let delta = 0;\n"
    "    let bias = initialBias;\n"
    "    for (const currentValue of decoded) {\n"
    "      if (currentValue < 0x80) output.push(String.fromCharCode(currentValue));\n"
    "    }\n"
    "    const basicLength = output.length;\n"
    "    let handledCPCount = basicLength;\n"
    "    if (basicLength) output.push(delimiter);\n"
    "    while (handledCPCount < inputLength) {\n"
    "      let m = maxInt;\n"
    "      for (const currentValue of decoded) {\n"
    "        if (currentValue >= n && currentValue < m) m = currentValue;\n"
    "      }\n"
    "      const handledCPCountPlusOne = handledCPCount + 1;\n"
    "      if (m - n > Math.floor((maxInt - delta) / handledCPCountPlusOne)) error(\"overflow\");\n"
    "      delta += (m - n) * handledCPCountPlusOne;\n"
    "      n = m;\n"
    "      for (const currentValue of decoded) {\n"
    "        if (currentValue < n && ++delta > maxInt) error(\"overflow\");\n"
    "        if (currentValue === n) {\n"
    "          let q = delta;\n"
    "          for (let k = base; ; k += base) {\n"
    "            const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);\n"
    "            if (q < t) break;\n"
    "            const qMinusT = q - t;\n"
    "            const baseMinusT = base - t;\n"
    "            output.push(String.fromCharCode(digitToBasic(t + (qMinusT % baseMinusT), 0)));\n"
    "            q = Math.floor(qMinusT / baseMinusT);\n"
    "          }\n"
    "          output.push(String.fromCharCode(digitToBasic(q, 0)));\n"
    "          bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);\n"
    "          delta = 0;\n"
    "          ++handledCPCount;\n"
    "        }\n"
    "      }\n"
    "      ++delta;\n"
    "      ++n;\n"
    "    }\n"
    "    return output.join(\"\");\n"
    "  };\n"
    "  const mapDomain = (domain, callback) => {\n"
    "    const parts = String(domain).split(\"@\");\n"
    "    let result = \"\";\n"
    "    if (parts.length > 1) {\n"
    "      result = parts[0] + \"@\";\n"
    "      domain = parts[1];\n"
    "    }\n"
    "    domain = domain.replace(regexSeparators, \"\\x2E\");\n"
    "    const labels = domain.split(\".\");\n"
    "    const encoded = labels.map(callback).join(\".\");\n"
    "    return result + encoded;\n"
    "  };\n"
    "  const toUnicode = (input) => mapDomain(input, (string) =>\n"
    "    /^xn--/.test(string) ? decode(string.slice(4).toLowerCase()) : string);\n"
    "  const toASCII = (input) => mapDomain(input, (string) =>\n"
    "    regexNonASCII.test(string) ? \"xn--\" + encode(string) : string);\n"
    "  return {\n"
    "    version: \"2.1.0\",\n"
    "    ucs2: { decode: ucs2decode, encode: ucs2encode },\n"
    "    decode,\n"
    "    encode,\n"
    "    toASCII,\n"
    "    toUnicode,\n"
    "  };\n"
    "}\n"
    "    const p = makePunycode();\n"
    "    p.default = p;\n"
    "    return p;\n"
    "  });\n"
    /* node:querystring — Node's parse/stringify semantics ('+' is a
     * space on parse, %20 on stringify, arrays expand, null-proto
     * results), differentially tested. */
    "  builtins.querystring = memo(() => {\n"
    "function makeQuerystring() {\n"
    "  const unescapeBuffer = (s) => {\n"
    "    try {\n"
    "      return decodeURIComponent(s);\n"
    "    } catch (e) {\n"
    "      const bytes = [];\n"
    "      for (let i = 0; i < s.length; i++) {\n"
    "        if (s[i] === \"%\" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {\n"
    "          bytes.push(parseInt(s.slice(i + 1, i + 3), 16));\n"
    "          i += 2;\n"
    "        } else {\n"
    "          const enc = new TextEncoder().encode(s[i]);\n"
    "          for (const b of enc) bytes.push(b);\n"
    "        }\n"
    "      }\n"
    "      return new TextDecoder().decode(new Uint8Array(bytes));\n"
    "    }\n"
    "  };\n"
    "  const qsUnescape = (s) => unescapeBuffer(String(s));\n"
    "  const hexTable = [];\n"
    "  for (let i = 0; i < 256; i++) hexTable[i] = \"%\" + i.toString(16).toUpperCase().padStart(2, \"0\");\n"
    "  const noEscape = new Set(\n"
    "    \"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._!'()*~\".split(\"\"),\n"
    "  );\n"
    "  const qsEscape = (str) => {\n"
    "    const s = String(str);\n"
    "    let out = \"\";\n"
    "    for (const ch of s) {\n"
    "      if (noEscape.has(ch)) {\n"
    "        out += ch;\n"
    "        continue;\n"
    "      }\n"
    "      const cp = ch.codePointAt(0);\n"
    "      if (cp < 0x80) {\n"
    "        out += hexTable[cp];\n"
    "      } else if (cp < 0x800) {\n"
    "        out += hexTable[0xc0 | (cp >> 6)] + hexTable[0x80 | (cp & 0x3f)];\n"
    "      } else if (cp < 0x10000) {\n"
    "        out += hexTable[0xe0 | (cp >> 12)] + hexTable[0x80 | ((cp >> 6) & 0x3f)] + hexTable[0x80 | (cp & 0x3f)];\n"
    "      } else {\n"
    "        out += hexTable[0xf0 | (cp >> 18)] + hexTable[0x80 | ((cp >> 12) & 0x3f)] + hexTable[0x80 | ((cp >> 6) & 0x3f)] + hexTable[0x80 | (cp & 0x3f)];\n"
    "      }\n"
    "    }\n"
    "    return out;\n"
    "  };\n"
    "  const stringifyPrimitive = (v) => {\n"
    "    if (typeof v === \"string\") return v;\n"
    "    if (typeof v === \"number\" && Number.isFinite(v)) return String(v);\n"
    "    if (typeof v === \"bigint\") return String(v);\n"
    "    if (typeof v === \"boolean\") return v ? \"true\" : \"false\";\n"
    "    return \"\";\n"
    "  };\n"
    "  const stringify = (obj, sep, eq, options) => {\n"
    "    sep = sep || \"&\";\n"
    "    eq = eq || \"=\";\n"
    "    let escape = qsEscape;\n"
    "    if (options !== undefined && options !== null && typeof options.encodeURIComponent === \"function\") {\n"
    "      escape = options.encodeURIComponent;\n"
    "    }\n"
    "    if (obj === null || typeof obj !== \"object\") return \"\";\n"
    "    const parts = [];\n"
    "    for (const k of Object.keys(obj)) {\n"
    "      const v = obj[k];\n"
    "      const ek = escape(stringifyPrimitive(k));\n"
    "      if (Array.isArray(v)) {\n"
    "        for (const item of v) parts.push(ek + eq + escape(stringifyPrimitive(item)));\n"
    "      } else {\n"
    "        parts.push(ek + eq + escape(stringifyPrimitive(v)));\n"
    "      }\n"
    "    }\n"
    "    return parts.join(sep);\n"
    "  };\n"
    "  const parse = (qs, sep, eq, options) => {\n"
    "    sep = sep || \"&\";\n"
    "    eq = eq || \"=\";\n"
    "    const obj = Object.create(null);\n"
    "    if (typeof qs !== \"string\" || qs.length === 0) return obj;\n"
    "    let decode = qsUnescape;\n"
    "    let maxKeys = 1000;\n"
    "    if (options !== undefined && options !== null) {\n"
    "      if (typeof options.decodeURIComponent === \"function\") decode = options.decodeURIComponent;\n"
    "      if (typeof options.maxKeys === \"number\") maxKeys = options.maxKeys;\n"
    "    }\n"
    "    let pairs = qs.split(sep);\n"
    "    if (maxKeys > 0) pairs = pairs.slice(0, maxKeys);\n"
    "    for (const pair of pairs) {\n"
    "      if (pair.length === 0) continue;\n"
    "      const eqAt = pair.indexOf(eq);\n"
    "      let k;\n"
    "      let v;\n"
    "      if (eqAt < 0) {\n"
    "        k = decode(pair.split(\"+\").join(\" \"));\n"
    "        v = \"\";\n"
    "      } else {\n"
    "        k = decode(pair.slice(0, eqAt).split(\"+\").join(\" \"));\n"
    "        v = decode(pair.slice(eqAt + eq.length).split(\"+\").join(\" \"));\n"
    "      }\n"
    "      if (k in obj) {\n"
    "        if (Array.isArray(obj[k])) obj[k].push(v);\n"
    "        else obj[k] = [obj[k], v];\n"
    "      } else {\n"
    "        obj[k] = v;\n"
    "      }\n"
    "    }\n"
    "    return obj;\n"
    "  };\n"
    "  return {\n"
    "    parse,\n"
    "    stringify,\n"
    "    decode: parse,\n"
    "    encode: stringify,\n"
    "    escape: qsEscape,\n"
    "    unescape: qsUnescape,\n"
    "    unescapeBuffer,\n"
    "  };\n"
    "}\n"
    "    const q = makeQuerystring();\n"
    "    q.default = q;\n"
    "    return q;\n"
    "  });\n"
    /* node:constants — the deprecated flat merge (os signals + fs
     * flags + the crypto slice), same numbers the platform hooks
     * answer everywhere else. */
    "  builtins.constants = memo(() => {\n"
    "    const c = { ...host.signals(), ...host.fsConstants(), ...builtins.crypto().constants };\n"
    "    c.default = c;\n"
    "    return c;\n"
    "  });\n"
    /* node:console — the Console class over any write streams plus
     * the global console (which the bootstrap upgrades below to
     * Node's format semantics for npm builds). */
    "  builtins.console = memo(() => {\n"
    "    const format = (...a) => builtins.util().formatWithOptions({}, ...a);\n"
    "    class Console {\n"
    "      constructor(stdout, stderr) {\n"
    "        const opts = stdout !== null && typeof stdout === 'object' && stdout.stdout !== undefined ? stdout : { stdout, stderr };\n"
    "        this._out = opts.stdout;\n"
    "        this._err = opts.stderr || opts.stdout;\n"
    "        this._counts = new Map();\n"
    "        this._times = new Map();\n"
    "        for (const m of ['log', 'info', 'debug']) this[m] = (...a) => { this._out.write(format(...a) + '\\n'); };\n"
    "        for (const m of ['error', 'warn', 'trace']) this[m] = (...a) => { this._err.write((m === 'trace' ? 'Trace: ' : '') + format(...a) + '\\n'); };\n"
    "        this.dir = (obj, o) => { this._out.write(builtins.util().inspect(obj, { customInspect: false, ...o }) + '\\n'); };\n"
    "        this.assert = (v, ...a) => { if (!v) this.error('Assertion failed' + (a.length ? ': ' + format(...a) : '')); };\n"
    "        this.count = (label) => { const l = label === undefined ? 'default' : String(label); const n = (this._counts.get(l) || 0) + 1; this._counts.set(l, n); this._out.write(l + ': ' + n + '\\n'); };\n"
    "        this.countReset = (label) => { this._counts.delete(label === undefined ? 'default' : String(label)); };\n"
    "        this.time = (label) => { this._times.set(label === undefined ? 'default' : String(label), Date.now()); };\n"
    "        this.timeEnd = (label) => { const l = label === undefined ? 'default' : String(label); const t = this._times.get(l); if (t !== undefined) { this._times.delete(l); this._out.write(l + ': ' + (Date.now() - t) + 'ms\\n'); } };\n"
    "        this.group = (...a) => { if (a.length) this.log(...a); };\n"
    "        this.groupEnd = () => {};\n"
    "        this.table = (data) => { this.log(data); };\n"
    "        this.clear = () => {};\n"
    "      }\n"
    "    }\n"
    "    const c = globalThis.console;\n"
    "    c.Console = Console;\n"
    "    c.default = c;\n"
    "    return c;\n"
    "  });\n"
    /* node:timers (+ timers/promises) over the island's timer
     * bridge; setImmediate rides a zero-delay timer (Node's check
     * phase does not exist here — documented divergence). */
    "  builtins.timers = memo(() => {\n"
    "    const t = {\n"
    "      setTimeout: globalThis.setTimeout,\n"
    "      clearTimeout: globalThis.clearTimeout,\n"
    "      setInterval: globalThis.setInterval,\n"
    "      clearInterval: globalThis.clearInterval,\n"
    "      setImmediate: globalThis.setImmediate,\n"
    "      clearImmediate: globalThis.clearImmediate,\n"
    "    };\n"
    "    t.default = t;\n"
    "    return t;\n"
    "  });\n"
    "  builtins['timers/promises'] = memo(() => {\n"
    "    const delay = (ms, value, options) => new Promise((resolve, reject) => {\n"
    "      const t = globalThis.setTimeout(() => resolve(value), ms);\n"
    "      if (options !== undefined && options !== null && options.signal !== undefined && typeof options.signal.addEventListener === 'function') {\n"
    "        options.signal.addEventListener('abort', () => {\n"
    "          globalThis.clearTimeout(t);\n"
    "          const e = new Error('The operation was aborted');\n"
    "          e.name = 'AbortError';\n"
    "          e.code = 'ABORT_ERR';\n"
    "          reject(e);\n"
    "        });\n"
    "      }\n"
    "    });\n"
    "    const tp = {\n"
    "      setTimeout: delay,\n"
    "      setImmediate: (value) => delay(0, value),\n"
    "      setInterval: (ms, value, options) => ({\n"
    "        async *[Symbol.asyncIterator]() {\n"
    "          for (;;) {\n"
    "            await delay(ms, undefined, options);\n"
    "            yield value;\n"
    "          }\n"
    "        },\n"
    "      }),\n"
    "      scheduler: { wait: (ms) => delay(ms), yield: () => delay(0) },\n"
    "    };\n"
    "    tp.default = tp;\n"
    "    return tp;\n"
    "  });\n"
    /* node:zlib — one-shot sync/callback codecs over the zlib bridge
     * (zlib/raw/gzip modes; inflate auto-detects for unzip), plus
     * BUFFERING stream classes: a Transform that collects its input
     * and converts at flush (no incremental output — documented
     * divergence). Brotli is not carried; its names exist and throw
     * at the call. */
    "  builtins.zlib = memo(() => {\n"
    "    const Buffer = builtins.buffer().Buffer;\n"
    "    const Transform = builtins.stream().Transform;\n"
    "    const toU8 = (data) => {\n"
    "      if (typeof data === 'string') return Buffer.from(data, 'utf8');\n"
    "      if (data instanceof Uint8Array) return data;\n"
    "      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);\n"
    "      if (data instanceof ArrayBuffer) return new Uint8Array(data);\n"
    "      const e = new TypeError('The \"buffer\" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer. Received ' + (data === null ? 'null' : typeof data === 'object' ? 'an instance of ' + ((data.constructor && data.constructor.name) || 'Object') : 'type ' + typeof data));\n"
    "      e.code = 'ERR_INVALID_ARG_TYPE';\n"
    "      throw e;\n"
    "    };\n"
    "    const codec = (deflating, mode) => (data, options) => {\n"
    "      const level = options !== undefined && options !== null && options.level !== undefined ? options.level : -1;\n"
    "      const raw = host.zlib(deflating ? 1 : 0, toU8(data), mode, level);\n"
    "      return Buffer.from(raw.buffer, raw.byteOffset, raw.length);\n"
    "    };\n"
    "    const asyncify = (syncFn) => (data, optionsOrCb, maybeCb) => {\n"
    "      const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;\n"
    "      const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;\n"
    "      if (typeof cb !== 'function') {\n"
    "        const e = new TypeError('The \"callback\" argument must be of type function');\n"
    "        e.code = 'ERR_INVALID_ARG_TYPE';\n"
    "        throw e;\n"
    "      }\n"
    "      let out;\n"
    "      try { out = syncFn(data, options); }\n"
    "      catch (err) { queueMicrotask(() => cb(err)); return; }\n"
    "      queueMicrotask(() => cb(null, out));\n"
    "    };\n"
    "    const mkStreamClass = (name, syncFn) => {\n"
    "      const cls = class extends Transform {\n"
    "        constructor(options) {\n"
    "          super({});\n"
    "          this._zopts = options;\n"
    "          this._zchunks = [];\n"
    "          this.bytesWritten = 0;\n"
    "        }\n"
    "        _transform(chunk, enc, cb) {\n"
    "          this._zchunks.push(toU8(chunk));\n"
    "          this.bytesWritten += chunk.length;\n"
    "          cb();\n"
    "        }\n"
    "        _flush(cb) {\n"
    "          try {\n"
    "            cb(null, syncFn(Buffer.concat(this._zchunks), this._zopts));\n"
    "          } catch (err) {\n"
    "            cb(err);\n"
    "          }\n"
    "        }\n"
    "        close(cb) { if (typeof cb === 'function') queueMicrotask(cb); }\n"
    "        reset() { this._zchunks = []; }\n"
    "        flush(k, cb) { const f = typeof k === 'function' ? k : cb; if (typeof f === 'function') queueMicrotask(f); }\n"
    "      };\n"
    "      Object.defineProperty(cls, 'name', { value: name, configurable: true });\n"
    "      return cls;\n"
    "    };\n"
    "    const die = (name) => class { constructor() { throw new Error('zlib.' + name + ' is not available in the scriptc island (brotli/zstd are not linked)'); } };\n"
    "    const deflateSync = codec(true, 0), inflateSync = codec(false, 0);\n"
    "    const deflateRawSync = codec(true, 1), inflateRawSync = codec(false, 1);\n"
    "    const gzipSync = codec(true, 2), gunzipSync = codec(false, 2);\n"
    "    const unzipSync = codec(false, 3);\n"
    "    const Deflate = mkStreamClass('Deflate', deflateSync), Inflate = mkStreamClass('Inflate', inflateSync);\n"
    "    const DeflateRaw = mkStreamClass('DeflateRaw', deflateRawSync), InflateRaw = mkStreamClass('InflateRaw', inflateRawSync);\n"
    "    const Gzip = mkStreamClass('Gzip', gzipSync), Gunzip = mkStreamClass('Gunzip', gunzipSync);\n"
    "    const Unzip = mkStreamClass('Unzip', unzipSync);\n"
    "    const BrotliCompress = die('BrotliCompress'), BrotliDecompress = die('BrotliDecompress');\n"
    "    const constants = {\n"
    "      Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,\n"
    "      Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,\n"
    "      Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,\n"
    "      Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,\n"
    "      Z_DEFAULT_WINDOWBITS: 15, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15,\n"
    "      Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384,\n"
    "      Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8,\n"
    "      Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,\n"
    "      ZLIB_VERNUM: 4865,\n"
    "      BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,\n"
    "      BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_SIZE_HINT: 3,\n"
    "      BROTLI_MAX_QUALITY: 11, BROTLI_MIN_QUALITY: 0, BROTLI_DEFAULT_QUALITY: 11,\n"
    "    };\n"
    "    const z = {\n"
    "      deflateSync, inflateSync, deflateRawSync, inflateRawSync, gzipSync, gunzipSync, unzipSync,\n"
    "      deflate: asyncify(deflateSync), inflate: asyncify(inflateSync),\n"
    "      deflateRaw: asyncify(deflateRawSync), inflateRaw: asyncify(inflateRawSync),\n"
    "      gzip: asyncify(gzipSync), gunzip: asyncify(gunzipSync), unzip: asyncify(unzipSync),\n"
    "      Deflate, Inflate, DeflateRaw, InflateRaw, Gzip, Gunzip, Unzip, BrotliCompress, BrotliDecompress,\n"
    "      createDeflate: (o) => new Deflate(o), createInflate: (o) => new Inflate(o),\n"
    "      createDeflateRaw: (o) => new DeflateRaw(o), createInflateRaw: (o) => new InflateRaw(o),\n"
    "      createGzip: (o) => new Gzip(o), createGunzip: (o) => new Gunzip(o), createUnzip: (o) => new Unzip(o),\n"
    "      createBrotliCompress: () => new BrotliCompress(), createBrotliDecompress: () => new BrotliDecompress(),\n"
    "      brotliCompressSync: () => { throw new Error('zlib.brotliCompressSync is not available in the scriptc island'); },\n"
    "      brotliDecompressSync: () => { throw new Error('zlib.brotliDecompressSync is not available in the scriptc island'); },\n"
    "      constants,\n"
    "    };\n"
    "    z.default = z;\n"
    "    return z;\n"
    "  });\n"
    /* node:http/node:https — the CLIENT slice over the socket units
     * (scr_net_island.c's host functions; registered only when that
     * bridge is linked, so bridge-less builds keep the does-not-provide
     * refusal). request/get drive real sockets: scr_net + scr_tls +
     * scr_http's client parser — node:http semantics (no redirects, no
     * decompression, Node's error messages off the net layer). The
     * exchange starts LAZILY at first write/end/flushHeaders so
     * setHeader-after-construction works (divergence: Node dials at
     * construction; same events, later dial). Servers and raw sockets
     * are loud fences — node:net/node:tls below load (eval-time requires
     * succeed, Node's shape) and fence at the call. */
    "  if (host.httpStart) {\n"
    "    const makeHttpMod = (secure) => {\n"
    "      const { EventEmitter } = builtins.events();\n"
    "      const { Buffer } = builtins.buffer();\n"
    "      const toU8 = (chunk, enc) => {\n"
    "        if (typeof chunk === 'string') return Buffer.from(chunk, enc || 'utf8');\n"
    "        if (chunk instanceof Uint8Array) return chunk;\n"
    "        const e = new TypeError('The \"chunk\" argument must be of type string or an instance of Buffer or Uint8Array');\n"
    "        e.code = 'ERR_INVALID_ARG_TYPE';\n"
    "        throw e;\n"
    "      };\n"
    /* Node's IncomingMessage header fold: set-cookie collects an array,
     * repeats of everything else join ', ' (approximation of Node's
     * singleton-discard list — divergence noted in the lane report). */
    "      const foldHeaders = (raw) => {\n"
    "        const h = {};\n"
    "        for (let i = 0; i + 1 < raw.length; i += 2) {\n"
    "          const k = raw[i].toLowerCase();\n"
    "          const v = raw[i + 1];\n"
    "          if (k === 'set-cookie') { if (h[k] === undefined) h[k] = []; h[k].push(v); }\n"
    "          else if (h[k] === undefined) h[k] = v;\n"
    "          else h[k] += ', ' + v;\n"
    "        }\n"
    "        return h;\n"
    "      };\n"
    /* Agent is construction-compat only: island requests go through
     * host.httpStart and never consult an agent, but npm subclasses
     * (agentkeepalive — openai's default agent) extend Agent and wire
     * EventEmitter listeners in their constructors, so it must BE an
     * EventEmitter carrying Node's option/shape surface. */
    "      class Agent extends EventEmitter {\n"
    "        constructor(options) {\n"
    "          super();\n"
    "          const o = options || {};\n"
    "          this.options = o;\n"
    "          this.keepAlive = o.keepAlive === undefined ? true : !!o.keepAlive;\n"
    "          this.keepAliveMsecs = Number(o.keepAliveMsecs) || 1000;\n"
    "          this.maxSockets = o.maxSockets === undefined ? Infinity : o.maxSockets;\n"
    "          this.maxFreeSockets = o.maxFreeSockets === undefined ? 256 : o.maxFreeSockets;\n"
    "          this.sockets = [];\n"
    "          this.freeSockets = [];\n"
    "          this.requests = [];\n"
    "          this.destroyed = false;\n"
    "        }\n"
    "        destroy() { this.destroyed = true; return this; }\n"
    "      }\n"
    "      class IncomingMessage extends EventEmitter {\n"
    "        constructor(req, status, statusText, raw) {\n"
    "          super();\n"
    "          this.req = req;\n"
    "          this.statusCode = status;\n"
    "          this.statusMessage = statusText;\n"
    "          this.rawHeaders = raw;\n"
    "          this.headers = foldHeaders(raw);\n"
    "          this.httpVersion = '1.1';\n"
    "          this.httpVersionMajor = 1;\n"
    "          this.httpVersionMinor = 1;\n"
    "          this.complete = false;\n"
    "          this.aborted = false;\n"
    "          this._enc = null;\n"
    "        }\n"
    "        setEncoding(enc) { this._enc = enc; return this; }\n"
    "        resume() { return this; }\n"
    "        pause() { return this; }\n"
    "        destroy() { this.req.destroy(); return this; }\n"
    "      }\n"
    "      class ClientRequest extends EventEmitter {\n"
    "        constructor(options, cb) {\n"
    "          super();\n"
    "          if (cb) this.once('response', cb);\n"
    "          this._o = options;\n"
    "          this._headers = Object.create(null);\n"
    "          this._id = 0;\n"
    "          this._started = false;\n"
    "          this._timeoutMs = options.timeout !== undefined ? Number(options.timeout) : 0;\n"
    "          this.destroyed = false;\n"
    "          this.writableEnded = false;\n"
    "          this.res = null;\n"
    "          const h = options.headers || {};\n"
    "          for (const k of Object.keys(h)) { if (h[k] !== undefined) this.setHeader(k, h[k]); }\n"
    "        }\n"
    "        setHeader(name, value) { this._headers[String(name).toLowerCase()] = { name: String(name), value }; return this; }\n"
    "        getHeader(name) { const e = this._headers[String(name).toLowerCase()]; return e === undefined ? undefined : e.value; }\n"
    "        removeHeader(name) { delete this._headers[String(name).toLowerCase()]; }\n"
    "        setTimeout(ms, cb) {\n"
    "          if (cb) this.once('timeout', cb);\n"
    "          this._timeoutMs = Number(ms) || 0;\n"
    "          if (this._started && this._id) host.httpSetTimeout(this._id, this._timeoutMs);\n"
    "          return this;\n"
    "        }\n"
    "        _start() {\n"
    "          if (this._started || this.destroyed) return;\n"
    "          this._started = true;\n"
    "          const o = this._o;\n"
    "          const self = this;\n"
    "          const flat = [];\n"
    "          for (const k of Object.keys(this._headers)) {\n"
    "            const e = this._headers[k];\n"
    "            if (Array.isArray(e.value)) { for (const v of e.value) flat.push(e.name, String(v)); }\n"
    "            else flat.push(e.name, String(e.value));\n"
    "          }\n"
    "          let hostn = o.hostname !== undefined && o.hostname !== null && o.hostname !== '' ? o.hostname : (o.host || 'localhost');\n"
    "          hostn = String(hostn);\n"
    "          let port = o.port !== undefined && o.port !== null && o.port !== '' ? Number(o.port) : (secure ? 443 : 80);\n"
    "          if ((o.hostname === undefined || o.hostname === null || o.hostname === '') && hostn.lastIndexOf(':') > hostn.lastIndexOf(']')) {\n"
    "            const i = hostn.lastIndexOf(':');\n"
    "            if (o.port === undefined || o.port === null || o.port === '') port = Number(hostn.slice(i + 1)) || port;\n"
    "            hostn = hostn.slice(0, i);\n"
    "          }\n"
    "          if (hostn.startsWith('[') && hostn.endsWith(']')) hostn = hostn.slice(1, -1);\n"
    "          this._id = host.httpStart(secure, hostn, port, String(o.path || '/'), String(o.method || 'GET').toUpperCase(), this._timeoutMs, flat, {\n"
    "            onResponse(status, statusText, raw) {\n"
    "              const res = new IncomingMessage(self, status, statusText, raw);\n"
    "              self.res = res;\n"
    "              self.emit('response', res);\n"
    "            },\n"
    "            onData(u8) {\n"
    "              const res = self.res;\n"
    "              if (res === null) return;\n"
    "              const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.length);\n"
    "              res.emit('data', res._enc ? buf.toString(res._enc) : buf);\n"
    "            },\n"
    "            onEnd() { const res = self.res; if (res !== null) { res.complete = true; res.emit('end'); } },\n"
    "            onError(msg) {\n"
    "              const e = new Error(msg);\n"
    "              const m = /^(connect|getaddrinfo) (E[A-Z]+)/.exec(msg);\n"
    "              if (m) { e.code = m[2]; e.syscall = m[1]; }\n"
    "              else if (msg === 'socket hang up') e.code = 'ECONNRESET';\n"
    "              self.emit('error', e);\n"
    "            },\n"
    "            onResError(msg) {\n"
    "              const res = self.res;\n"
    "              if (res !== null) { res.aborted = true; res.emit('error', new Error(msg)); }\n"
    "            },\n"
    "            onTimeout() { self.emit('timeout'); },\n"
    "            onClose() { self.emit('close'); if (self.res !== null) self.res.emit('close'); },\n"
    "          });\n"
    "        }\n"
    "        flushHeaders() { this._start(); }\n"
    "        write(chunk, enc, cb) {\n"
    "          if (typeof enc === 'function') { cb = enc; enc = undefined; }\n"
    "          this._start();\n"
    "          if (this._id && !this.writableEnded) host.httpWrite(this._id, toU8(chunk, enc));\n"
    "          if (cb) queueMicrotask(cb);\n"
    "          return true;\n"
    "        }\n"
    "        end(chunk, enc, cb) {\n"
    "          if (typeof chunk === 'function') { cb = chunk; chunk = undefined; enc = undefined; }\n"
    "          else if (typeof enc === 'function') { cb = enc; enc = undefined; }\n"
    "          this._start();\n"
    "          if (this._id && !this.writableEnded) {\n"
    "            this.writableEnded = true;\n"
    "            host.httpEnd(this._id, chunk === undefined || chunk === null ? undefined : toU8(chunk, enc));\n"
    "          }\n"
    "          if (cb) queueMicrotask(cb);\n"
    "          return this;\n"
    "        }\n"
    /* Node's destroy() mid-flight lets the socket teardown speak: 'socket
     * hang up' then 'close' (the natural premature path — oracle-pinned);
     * a request destroyed before it ever started just closes. */
    "        destroy(_err) {\n"
    "          if (this.destroyed) return this;\n"
    "          this.destroyed = true;\n"
    "          if (this._started && this._id) { host.httpDestroy(this._id); }\n"
    "          else { const self = this; queueMicrotask(() => self.emit('close')); }\n"
    "          return this;\n"
    "        }\n"
    "        abort() { this.destroy(); }\n"
    "      }\n"
    /* request(url|options[, options][, cb]) — Node's overloads: URL
     * fields merge under an options bag's explicit keys. */
    "      const normalize = (input, options, cb) => {\n"
    "        if (typeof options === 'function') { cb = options; options = undefined; }\n"
    "        let o = {};\n"
    "        if (typeof input === 'string' || (input !== null && typeof input === 'object' && typeof input.href === 'string')) {\n"
    "          const u = typeof input === 'string' ? new globalThis.URL(input) : input;\n"
    "          if (secure && u.protocol === 'http:') throw new TypeError('Protocol \"http:\" not supported. Expected \"https:\"');\n"
    "          if (!secure && u.protocol === 'https:') throw new TypeError('Protocol \"https:\" not supported. Expected \"http:\"');\n"
    "          o.hostname = u.hostname;\n"
    "          if (u.port) o.port = u.port;\n"
    "          o.path = (u.pathname || '/') + (u.search || '');\n"
    "        } else if (input !== null && typeof input === 'object') {\n"
    "          o = Object.assign(o, input);\n"
    "        }\n"
    "        if (options !== undefined && options !== null) o = Object.assign(o, options);\n"
    "        return [o, cb];\n"
    "      };\n"
    "      const request = (input, options, cb) => {\n"
    "        const [o, cb2] = normalize(input, options, cb);\n"
    "        return new ClientRequest(o, cb2);\n"
    "      };\n"
    "      const get = (input, options, cb) => { const r = request(input, options, cb); r.end(); return r; };\n"
    "      const die = (what) => () => {\n"
    "        throw new Error(\"node:http\" + (secure ? 's' : '') + \" '\" + what + \"' is not supported in the scriptc island yet (the client — request/get — is)\");\n"
    "      };\n"
    "      const STATUS_CODES = { 100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints', 200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used', 300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: \"I'm a Teapot\", 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected', 509: 'Bandwidth Limit Exceeded', 510: 'Not Extended', 511: 'Network Authentication Required' };\n"
    "      const METHODS = ['ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'];\n"
    "      const mod = {\n"
    "        request, get, Agent, globalAgent: new Agent({ keepAlive: true }),\n"
    "        ClientRequest, IncomingMessage, STATUS_CODES, METHODS,\n"
    "        createServer: die('createServer'), Server: class Server { constructor() { die('new Server')(); } },\n"
    "      };\n"
    "      mod.default = mod;\n"
    "      return mod;\n"
    "    };\n"
    "    builtins.http = memo(() => makeHttpMod(false));\n"
    "    builtins.https = memo(() => makeHttpMod(true));\n"
    /* node:net/node:tls — enough to LOAD (eval-time requires succeed,
     * Node's shape); the socket surfaces fence loudly at the call. isIP
     * and friends are real (address validation is common eval-adjacent
     * work). */
    "    builtins.net = memo(() => {\n"
    "      const isIPv4 = (s) => {\n"
    "        if (typeof s !== 'string') return false;\n"
    "        const parts = s.split('.');\n"
    "        if (parts.length !== 4) return false;\n"
    "        for (const p of parts) {\n"
    "          if (!/^\\d{1,3}$/.test(p)) return false;\n"
    "          if (p.length > 1 && p[0] === '0') return false;\n"
    "          if (Number(p) > 255) return false;\n"
    "        }\n"
    "        return true;\n"
    "      };\n"
    "      const isIPv6 = (s) => {\n"
    "        if (typeof s !== 'string' || s.indexOf(':') < 0) return false;\n"
    "        let body = s;\n"
    "        let v4tail = false;\n"
    "        const lastColon = s.lastIndexOf(':');\n"
    "        if (s.indexOf('.') >= 0) {\n"
    "          if (!isIPv4(s.slice(lastColon + 1))) return false;\n"
    "          v4tail = true;\n"
    "          body = s.slice(0, lastColon + 1) + '0:0';\n"
    "        }\n"
    "        const dbl = body.indexOf('::');\n"
    "        if (dbl >= 0 && body.indexOf('::', dbl + 1) >= 0) return false;\n"
    "        const groups = body.split(':');\n"
    "        if (dbl < 0 && groups.length !== 8) return false;\n"
    "        if (dbl >= 0 && groups.length > 8) return false;\n"
    "        for (const g of groups) {\n"
    "          if (g === '') continue;\n"
    "          if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;\n"
    "        }\n"
    "        return true;\n"
    "      };\n"
    "      const isIP = (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);\n"
    "      const die = (what) => () => {\n"
    "        throw new Error(\"node:net '\" + what + \"' is not supported in the scriptc island yet (the http/https client is)\");\n"
    "      };\n"
    "      const mod = {\n"
    "        isIP, isIPv4, isIPv6,\n"
    "        connect: die('connect'), createConnection: die('createConnection'), createServer: die('createServer'),\n"
    "        Socket: class Socket { constructor() { die('new Socket')(); } },\n"
    "        Server: class Server { constructor() { die('new Server')(); } },\n"
    "      };\n"
    "      mod.default = mod;\n"
    "      return mod;\n"
    "    });\n"
    "    builtins.tls = memo(() => {\n"
    "      const die = (what) => () => {\n"
    "        throw new Error(\"node:tls '\" + what + \"' is not supported in the scriptc island yet (the https client is)\");\n"
    "      };\n"
    "      const mod = {\n"
    "        connect: die('connect'), createServer: die('createServer'), createSecureContext: die('createSecureContext'),\n"
    "        TLSSocket: class TLSSocket { constructor() { die('new TLSSocket')(); } },\n"
    "        rootCertificates: [],\n"
    "      };\n"
    "      mod.default = mod;\n"
    "      return mod;\n"
    "    });\n"
    "  }\n"
    "  builtins.process = memo(() => {\n"
    "    const argv = host.argv();\n"
    "    const stream = (fd) => {\n"
    "      const s = { fd, write: (str) => host.write(fd, String(str)) };\n"
    "      if (host.isatty(fd)) {\n"
    "        s.isTTY = true;\n"
    "        const c = host.columns(fd);\n"
    "        if (c > 0) s.columns = c;\n"
    "      }\n"
    /* listener surface, accepted-and-inert (the epipebomb shape:
     * stream.on('error', ...) + stream.listeners('error') at module
     * evaluation) — island stdio writes are synchronous host writes, so
     * these events never fire; registration must still succeed. */
    "      s.on = () => s;\n"
    "      s.once = () => s;\n"
    "      s.addListener = () => s;\n"
    "      s.off = () => s;\n"
    "      s.removeListener = () => s;\n"
    "      s.removeAllListeners = () => s;\n"
    "      s.listeners = () => [];\n"
    "      s.listenerCount = () => 0;\n"
    "      s.emit = () => false;\n"
    "      return s;\n"
    "    };\n"
    "    const p = {\n"
    "      argv,\n"
    "      env: host.env(),\n"
    "      platform: host.platform(),\n"
    "      execPath: argv[0],\n"
    "      execArgv: [],\n"
    /* the compat target's versions, same answers as the static world's
     * process.versions (scr_lib.c) */
    "      version: 'v' + host.versions()[0],\n"
    "      versions: { node: host.versions()[0], openssl: host.versions()[1] },\n"
    "      pid: host.pid(),\n"
    "      ppid: 0,\n"
    "      title: 'scriptc',\n"
    "      argv0: 'scriptc',\n"
    "      release: { name: 'node' },\n"
    "      config: { variables: {} },\n"
    "      allowedNodeEnvironmentFlags: new Set(),\n"
    "      exitCode: undefined,\n"
    "      stdout: stream(1),\n"
    "      stderr: stream(2),\n"
    /* stdin: a REAL Readable over a whole-input host read (the formatter idiom's
     * get-stdin async-iterates it when no file arguments arrive). The
     * host read happens lazily on the first pull — a program that only
     * probes isTTY or registers listeners never blocks on a silent pipe,
     * and get-stdin's isTTY early-return keeps interactive terminals
     * away from the read entirely. One chunk, then EOF: the island's
     * stdio is whole-value like its fs (no partial-read backpressure to
     * report). setRawMode stays accepted-and-inert — there is no raw
     * TTY bridge. */
    "      stdin: (() => {\n"
    "        const { Readable } = builtins.stream();\n"
    "        const Buffer = builtins.buffer().Buffer;\n"
    "        let pulled = false;\n"
    "        const s = new Readable({\n"
    "          read() {\n"
    "            if (pulled) return;\n"
    "            pulled = true;\n"
    "            const data = host.readStdin();\n"
    "            if (data.byteLength > 0) this.push(Buffer.from(data));\n"
    "            this.push(null);\n"
    "          },\n"
    "        });\n"
    "        s.fd = 0;\n"
    /* Node's process.stdin is a tty.ReadStream only when fd 0 IS a tty
     * — pipes get a socket with NO setRawMode, and packages probe with
     * `process.stdin.setRawMode?.()`. Mirror the shape, not a stub. */
    "        if (host.isatty(0)) { s.isTTY = true; s.setRawMode = () => s; }\n"
    "        s.unref = () => s;\n"
    "        s.ref = () => s;\n"
    "        return s;\n"
    "      })(),\n"
    "      cwd: () => host.cwd(),\n"
    "      exit: (code) => {\n"
    "        host.exit(code === undefined || code === null ? Number(p.exitCode ?? 0) : Number(code));\n"
    "      },\n"
    /* Node's nextTick rides the island's microtask queue — ordering
     * against promise jobs is the engine's, not Node's dedicated
     * nextTick queue (divergence: documented in the shim report). */
    "      nextTick: (fn, ...args) => { queueMicrotask(() => fn(...args)); },\n"
    "      hrtime: Object.assign(\n"
    "        (prev) => {\n"
    "          const now = host.hrtime();\n"
    "          if (prev === undefined) return now;\n"
    "          let sec = now[0] - prev[0];\n"
    "          let ns = now[1] - prev[1];\n"
    "          if (ns < 0) { sec -= 1; ns += 1e9; }\n"
    "          return [sec, ns];\n"
    "        },\n"
    "        { bigint: () => { const t = host.hrtime(); return BigInt(t[0]) * 1000000000n + BigInt(t[1]); } },\n"
    "      ),\n"
    "      uptime: () => host.hrtime()[0],\n"
    /* umask(): the read form only (Node's no-arg getter — make-dir and
     * friends call it at module evaluation for their mode defaults); the
     * setter form is a loud fence, not a silent lie. */
    "      umask: (mask) => {\n"
    "        if (mask !== undefined) throw new Error('process.umask(mask) is not supported in the scriptc island (the read-only form works)');\n"
    "        return host.umask();\n"
    "      },\n"
    "      memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),\n"
    "      emitWarning: (warning, type) => {\n"
    "        const name = typeof type === 'string' ? type : 'Warning';\n"
    "        const msg = warning instanceof Error ? warning.message : String(warning);\n"
    "        host.write(2, '(node:' + host.pid() + ') ' + name + ': ' + msg + '\\n');\n"
    "      },\n"
    "      on: () => p,\n"
    "      once: () => p,\n"
    "      off: () => p,\n"
    "      removeListener: () => p,\n"
    "      emit: () => false,\n"
    "    };\n"
    /* process.exitCode is Node's IMPLICIT exit status: a program that
     * sets it and returns normally exits with it. The setter mirrors the
     * value into the C side (isl_exit_code), which the emitted main
     * returns after the loop drains — delete p.exitCode first so the
     * accessor pair replaces the literal's plain `undefined` slot. */
    "    delete p.exitCode;\n"
    "    let exitCodeSlot;\n"
    "    Object.defineProperty(p, 'exitCode', {\n"
    "      enumerable: true,\n"
    "      get: () => exitCodeSlot,\n"
    "      set: (v) => {\n"
    "        exitCodeSlot = v;\n"
    "        const n = v === undefined || v === null ? 0 : Number(v);\n"
    "        host.setExitCode(Number.isFinite(n) ? n : 0);\n"
    "      },\n"
    "    });\n"
    "    p.default = p;\n"
    "    return p;\n"
    "  });\n"
    "  globalThis.process = builtins.process();\n"
    /* Node's Buffer global (and `global` itself) — embedded CJS
     * reaches both without requiring anything. */
    "  globalThis.Buffer = builtins.buffer().Buffer;\n"
    /* setImmediate/clearImmediate globals (zero-delay timers — no
     * check phase in the island; documented divergence), and the
     * global console upgraded to Node's util.format semantics for
     * npm builds (the web prelude's String() console stays for
     * non-npm islands). */
    "  if (globalThis.setImmediate === undefined) {\n"
    "    globalThis.setImmediate = (fn, ...args) => globalThis.setTimeout(fn, 0, ...args);\n"
    "    globalThis.clearImmediate = (t) => globalThis.clearTimeout(t);\n"
    "  }\n"
    "  {\n"
    "    const fmt = (...a) => builtins.util().formatWithOptions({}, ...a);\n"
    "    const to = (fd, prefix) => (...a) => { host.write(fd, (prefix || '') + fmt(...a) + '\\n'); };\n"
    "    const c = globalThis.console;\n"
    "    c.log = to(1);\n"
    "    c.info = to(1);\n"
    "    c.debug = to(1);\n"
    "    c.warn = to(2);\n"
    "    c.error = to(2);\n"
    "    c.trace = to(2, 'Trace: ');\n"
    "  }\n"
    /* V8 stack-inspection surface: Error.captureStackTrace(obj, ctor?)
     * materializes obj.stack as a getter over parsed engine frames, so
     * Error.prepareStackTrace consumers (depd — express/body-parser's
     * deprecation logger) receive CallSite objects with the V8 method
     * surface while default consumers keep the engine's string form.
     * prepareStackTrace is honored at capture time AND first access
     * (depd sets it before and restores it after captureStackTrace, so
     * the capture-time read is the load-bearing one). Divergence: the
     * shim's own frame is trimmed instead of honoring ctor? exactly. */
    "  class IslCallSite {\n"
    "    constructor(name, file, line, col) {\n"
    "      this._n = name;\n"
    "      this._f = file;\n"
    "      this._l = line;\n"
    "      this._c = col;\n"
    "    }\n"
    "    getFileName() { return this._f; }\n"
    "    getLineNumber() { return this._l; }\n"
    "    getColumnNumber() { return this._c; }\n"
    "    getFunctionName() { return this._n; }\n"
    "    getThis() { return undefined; }\n"
    "    getTypeName() { return undefined; }\n"
    "    getFunction() { return undefined; }\n"
    "    getEvalOrigin() { return undefined; }\n"
    "    isEval() { return false; }\n"
    "    isNative() { return false; }\n"
    "    isToplevel() { return true; }\n"
    "    isConstructor() { return false; }\n"
    "    toString() { return this._n ? 'at ' + this._n + ' (' + this._f + ':' + this._l + ':' + this._c + ')' : 'at ' + this._f + ':' + this._l + ':' + this._c; }\n"
    "  }\n"
    "  const islParseFrame = (line) => {\n"
    "    const m = /^\\s*at\\s+(.*?)\\s+\\((.*):(\\d+):(\\d+)\\)$/.exec(line) || /^\\s*at\\s+(.*):(\\d+):(\\d+)$/.exec(line);\n"
    "    if (!m) return null;\n"
    "    if (m.length === 5) return new IslCallSite(m[1], m[2], Number(m[3]), Number(m[4]));\n"
    "    return new IslCallSite(undefined, m[1], Number(m[2]), Number(m[3]));\n"
    "  };\n"
    "  Error.captureStackTrace = (obj) => {\n"
    "    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) {\n"
    "      const e = new TypeError('The \"target\" argument must be of type object');\n"
    "      e.code = 'ERR_INVALID_ARG_TYPE';\n"
    "      throw e;\n"
    "    }\n"
    "    const prepAtCapture = typeof Error.prepareStackTrace === 'function' ? Error.prepareStackTrace : null;\n"
    "    const rawErr = new Error();\n"
    "    const raw = typeof rawErr.stack === 'string' ? rawErr.stack : '';\n"
    "    const lines = raw.split('\\n');\n"
    "    const frames = [];\n"
    "    for (let i = 0; i < lines.length; i++) {\n"
    "      const cs = islParseFrame(lines[i]);\n"
    "      if (cs !== null) frames.push(cs);\n"
    "    }\n"
    "    if (frames.length > 0) frames.shift(); /* the shim's own new Error frame */\n"
    "    if (builtins.process().env.SCRIPTC_VERBOSE === '1') {\n"
    "      host.write(2, 'scriptc: captureTrace raw=' + JSON.stringify(raw) + '\\n');\n"
    "      host.write(2, 'scriptc: captureTrace parsed=' + frames.length + ' prep=' + (prepAtCapture === null ? 'null' : 'fn') + '\\n');\n"
    "      for (const f of frames) host.write(2, 'scriptc:   pf ' + JSON.stringify(String(f)) + '\\n');\n"
    "    }\n"
    "    let materialized;\n"
    "    let hasMaterialized = false;\n"
    "    Object.defineProperty(obj, 'stack', {\n"
    "      configurable: true,\n"
    "      enumerable: false,\n"
    "      get() {\n"
    "        const prep = prepAtCapture !== null ? prepAtCapture : (typeof Error.prepareStackTrace === 'function' ? Error.prepareStackTrace : null);\n"
    "        if (prep === null) return raw;\n"
    "        if (!hasMaterialized) { materialized = prep(obj, frames); hasMaterialized = true; }\n"
    "        return materialized;\n"
    "      },\n"
    "      set(v) {\n"
    "        Object.defineProperty(obj, 'stack', { value: v, writable: true, configurable: true, enumerable: false });\n"
    "      },\n"
    "    });\n"
    "  };\n"
    "  try {\n"
    "    if (builtins.process().env.SCRIPTC_VERBOSE === '1') {\n"
    "      const probeFrames = () => {\n"
    "        const e = new Error();\n"
    "        host.write(2, 'scriptc: probe raw=' + JSON.stringify(typeof e.stack === 'string' ? e.stack : String(e.stack)) + '\\n');\n"
    "        const p = {};\n"
    "        Error.captureStackTrace(p);\n"
    "        const st = p.stack;\n"
    "        host.write(2, 'scriptc: probe captured typeof=' + typeof st + ' arr=' + Array.isArray(st) + (Array.isArray(st) ? ' len=' + st.length + ' f0=' + JSON.stringify(st.length > 0 ? String(st[0]) : '') + ' f1=' + JSON.stringify(st.length > 1 ? String(st[1]) : '') : ' raw=' + JSON.stringify(st)) + '\\n');\n"
    "      };\n"
    "      probeFrames();\n"
    "    }\n"
    "  } catch (pe) {\n"
    "    host.write(2, 'scriptc: probe failed ' + String(pe) + '\\n');\n"
    "  }\n"
    "  if (globalThis.global === undefined) globalThis.global = globalThis;\n"
    "  globalThis.__scr_require = requireKey;\n"
    "  return (key, name) => {\n"
    "    const exports = requireKey(key);\n"
    "    if (name === 'default') return exports;\n"
    "    if (name === '*') {\n"
    "      const ns = { default: exports };\n"
    "      for (const k in exports) {\n"
    "        if (Object.prototype.hasOwnProperty.call(exports, k)) ns[k] = exports[k];\n"
    "      }\n"
    "      return ns;\n"
    "    }\n"
    "    return exports[name];\n"
    "  };\n"
    "}\n";

/* Boots the module system: evaluates the bootstrap with the host bridge
 * and pins the CJS import helper. Called from isl_init when embedded
 * tables are registered — before any user code can import. */
/* Defined with the URL machinery below; embedded loaders construct URLs
 * (`new URL("x.wasm", import.meta.url)`) without any URL ever marshaling. */
static void isl_install_url_class(void);

static void isl_modules_boot(void) {
  isl_install_url_class();
  JSValue fn = JS_Eval(isl_ctx, isl_modules_bootstrap, sizeof isl_modules_bootstrap - 1,
                       "<scr-modules>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(fn)) {
    fprintf(stderr, "scriptc: island module bootstrap failed to evaluate\n");
    abort();
  }
  JSValue host = JS_NewObject(isl_ctx);
  /* JS_SetPropertyStr consumes the function values. */
  JS_SetPropertyStr(isl_ctx, host, "source", JS_NewCFunction(isl_ctx, isl_host_source, "source", 1));
  JS_SetPropertyStr(isl_ctx, host, "resolve", JS_NewCFunction(isl_ctx, isl_host_resolve, "resolve", 2));
  JS_SetPropertyStr(isl_ctx, host, "argv", JS_NewCFunction(isl_ctx, isl_host_argv, "argv", 0));
  JS_SetPropertyStr(isl_ctx, host, "env", JS_NewCFunction(isl_ctx, isl_host_env, "env", 0));
  JS_SetPropertyStr(isl_ctx, host, "write", JS_NewCFunction(isl_ctx, isl_host_write, "write", 2));
  JS_SetPropertyStr(isl_ctx, host, "readStdin",
                    JS_NewCFunction(isl_ctx, isl_host_read_stdin, "readStdin", 0));
  JS_SetPropertyStr(isl_ctx, host, "exit", JS_NewCFunction(isl_ctx, isl_host_exit, "exit", 1));
  JS_SetPropertyStr(isl_ctx, host, "setExitCode",
                    JS_NewCFunction(isl_ctx, isl_host_set_exit_code, "setExitCode", 1));
  JS_SetPropertyStr(isl_ctx, host, "isatty", JS_NewCFunction(isl_ctx, isl_host_isatty, "isatty", 1));
  JS_SetPropertyStr(isl_ctx, host, "columns", JS_NewCFunction(isl_ctx, isl_host_columns, "columns", 1));
  JS_SetPropertyStr(isl_ctx, host, "cwd", JS_NewCFunction(isl_ctx, isl_host_cwd, "cwd", 0));
  JS_SetPropertyStr(isl_ctx, host, "platform", JS_NewCFunction(isl_ctx, isl_host_platform, "platform", 0));
  JS_SetPropertyStr(isl_ctx, host, "homedir", JS_NewCFunction(isl_ctx, isl_host_homedir, "homedir", 0));
  JS_SetPropertyStr(isl_ctx, host, "tmpdir", JS_NewCFunction(isl_ctx, isl_host_tmpdir, "tmpdir", 0));
  JS_SetPropertyStr(isl_ctx, host, "arch", JS_NewCFunction(isl_ctx, isl_host_arch, "arch", 0));
  JS_SetPropertyStr(isl_ctx, host, "hostname", JS_NewCFunction(isl_ctx, isl_host_hostname, "hostname", 0));
  JS_SetPropertyStr(isl_ctx, host, "pid", JS_NewCFunction(isl_ctx, isl_host_pid, "pid", 0));
  JS_SetPropertyStr(isl_ctx, host, "promiseState", JS_NewCFunction(isl_ctx, isl_host_promise_state, "promiseState", 1));
  JS_SetPropertyStr(isl_ctx, host, "digest", JS_NewCFunction(isl_ctx, isl_host_digest, "digest", 2));
  JS_SetPropertyStr(isl_ctx, host, "hmac", JS_NewCFunction(isl_ctx, isl_host_hmac, "hmac", 3));
  JS_SetPropertyStr(isl_ctx, host, "fs", JS_NewCFunction(isl_ctx, isl_host_fs, "fs", 4));
  JS_SetPropertyStr(isl_ctx, host, "fsConstants", JS_NewCFunction(isl_ctx, isl_host_fs_constants, "fsConstants", 0));
  JS_SetPropertyStr(isl_ctx, host, "path", JS_NewCFunction(isl_ctx, isl_host_path, "path", 4));
  JS_SetPropertyStr(isl_ctx, host, "urlToPath", JS_NewCFunction(isl_ctx, isl_host_url_to_path, "urlToPath", 1));
  JS_SetPropertyStr(isl_ctx, host, "urlFromPath", JS_NewCFunction(isl_ctx, isl_host_url_from_path, "urlFromPath", 1));
  JS_SetPropertyStr(isl_ctx, host, "hrtime", JS_NewCFunction(isl_ctx, isl_host_hrtime, "hrtime", 0));
  JS_SetPropertyStr(isl_ctx, host, "versions", JS_NewCFunction(isl_ctx, isl_host_versions, "versions", 0));
  JS_SetPropertyStr(isl_ctx, host, "ids", JS_NewCFunction(isl_ctx, isl_host_ids, "ids", 0));
  JS_SetPropertyStr(isl_ctx, host, "signals", JS_NewCFunction(isl_ctx, isl_host_signals, "signals", 0));
  JS_SetPropertyStr(isl_ctx, host, "umask", JS_NewCFunction(isl_ctx, isl_host_umask, "umask", 0));
  JS_SetPropertyStr(isl_ctx, host, "zlib", JS_NewCFunction(isl_ctx, isl_host_zlib, "zlib", 4));
  /* The net bridge's host functions (scr_net_island.c, linked only when
   * the socket units are): httpStart/httpWrite/httpEnd/httpDestroy/
   * httpSetTimeout. The bootstrap's http/https shims register exactly
   * when host.httpStart exists — without the bridge the builtins table
   * keeps the "does not provide" refusal. */
  if (isl_netmod_attach) isl_netmod_attach(isl_ctx, &host);
  isl_cjs_import = JS_Call(isl_ctx, fn, JS_UNDEFINED, 1, &host);
  JS_FreeValue(isl_ctx, host);
  JS_FreeValue(isl_ctx, fn);
  if (JS_IsException(isl_cjs_import)) {
    fprintf(stderr, "scriptc: island module bootstrap failed to run\n");
    abort();
  }
  isl_booted = true;
}

static void isl_install_module_loader(void) {
  JS_SetModuleLoaderFunc(isl_rt, isl_module_normalize, isl_module_load, NULL);
  if (isl_mods) isl_modules_boot();
}

static void isl_free_boot(void) {
  if (!isl_booted) return;
  JS_FreeValue(isl_ctx, isl_cjs_import);
  isl_booted = false;
}

/* The import boundary (libCall island.import). Borrows all args; +1 out. */
ScrJsval *scr_jsval_import(const ScrStr *key, const ScrStr *name, const ScrStr *specifier) {
  isl_entry();
  const ScrIslandModule *m = isl_mod_find(key->data);
  if (!m || !isl_booted) {
    char buf[512];
    int n = snprintf(buf, sizeof buf, "module '%s' is not embedded", key->data);
    scr_throw_error_msg(SCR_ERR_ERROR, buf, (size_t)n);
    return NULL;
  }
  if (m->format != 0) {
    /* CJS/JSON entry: through the require shim — named exports come off
     * module.exports directly (like Node's lexer-driven interop, but by
     * property access), default IS module.exports. */
    JSValue args[2] = {JS_NewStringLen(isl_ctx, key->data, key->len),
                       JS_NewStringLen(isl_ctx, name->data, name->len)};
    JSValue r = JS_Call(isl_ctx, isl_cjs_import, JS_UNDEFINED, 2, args);
    JS_FreeValue(isl_ctx, args[0]);
    JS_FreeValue(isl_ctx, args[1]);
    if (JS_IsException(r)) {
      isl_bridge_exception();
      return NULL;
    }
    return isl_cell_new(r);
  }
  /* ESM entry: the engine loads the graph through the module loader; the
   * promise resolves with the namespace. Commander-class packages have no
   * top-level await, so draining the job queue settles it synchronously. */
  JSValue promise = JS_LoadModule(isl_ctx, ISL_IMPORT_BASE, key->data);
  if (JS_IsException(promise)) {
    isl_bridge_exception();
    return NULL;
  }
  JSContext *jctx;
  while (JS_ExecutePendingJob(isl_rt, &jctx) > 0) {
  }
  JSPromiseStateEnum state = JS_PromiseState(isl_ctx, promise);
  if (state == JS_PROMISE_REJECTED) {
    JSValue err = JS_PromiseResult(isl_ctx, promise);
    JS_FreeValue(isl_ctx, promise);
    JS_Throw(isl_ctx, err); /* consumed */
    isl_bridge_exception();
    return NULL;
  }
  if (state != JS_PROMISE_FULFILLED) {
    JS_FreeValue(isl_ctx, promise);
    char buf[512];
    int n = snprintf(buf, sizeof buf,
                     "module '%s' did not finish evaluating "
                     "(top-level await is not supported in embedded packages)",
                     key->data);
    scr_throw_error_msg(SCR_ERR_ERROR, buf, (size_t)n);
    return NULL;
  }
  JSValue ns = JS_PromiseResult(isl_ctx, promise);
  JS_FreeValue(isl_ctx, promise);
  if (name->len == 1 && name->data[0] == '*') {
    return isl_cell_new(ns);
  }
  /* Node validates named imports at LINK time: a name the module's
   * namespace does not provide is a SyntaxError naming the specifier as
   * written, and nothing runs. The namespace object holds exactly the
   * module's export names (star re-exports included), so a presence
   * check here IS Node's check — thrown after the graph evaluated
   * (Node's link phase precedes evaluation; a package with top-level
   * output would have printed first — the documented approximation),
   * but with the exact message and the same nonzero exit. */
  JSAtom prop = JS_NewAtomLen(isl_ctx, name->data, name->len);
  int has = JS_HasProperty(isl_ctx, ns, prop);
  JS_FreeAtom(isl_ctx, prop);
  if (has < 0) {
    JS_FreeValue(isl_ctx, ns);
    isl_bridge_exception();
    return NULL;
  }
  if (has == 0) {
    JS_FreeValue(isl_ctx, ns);
    char buf[512];
    int n = snprintf(buf, sizeof buf,
                     "The requested module '%s' does not provide an export named '%s'",
                     specifier->data, name->data);
    scr_throw_error_msg(SCR_ERR_SYNTAX, buf, (size_t)(n < 0 ? 0 : (size_t)n < sizeof buf ? (size_t)n : sizeof buf - 1));
    return NULL;
  }
  JSValue v = JS_GetPropertyStr(isl_ctx, ns, name->data);
  JS_FreeValue(isl_ctx, ns);
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

/* Dynamic import() (libCall island.importDyn). Borrows the key; +1 out —
 * ALWAYS an engine promise: JS_LoadModule's own for a loadable key, a
 * REJECTED one for load/normalize/compile failures (Node rejects dynamic
 * imports, it never throws synchronously) — the frontend's
 * jsBridgePromise turns settlement into the static promise's. Boots the
 * module system on demand: a program whose ONLY module use is a dynamic
 * builtin import ("node:fs") registers no embedded tables, but the
 * builtin wrappers require the bootstrap's __scr_require. */
/* Drop ledger entries carrying `reason` — the INTERMEDIATE module
 * promises QuickJS leaves rejected-and-unhandled when a dynamically
 * imported module throws at evaluation (each module in the graph has its
 * own promise; only the returned top one gets a handler). Node reports a
 * handled import() rejection zero times; without this we would report
 * the inner twin once. The RETURNED promise's own entry drops too — the
 * bridge subscribes to it, and an unobserved STATIC promise is the
 * static ledger's report (one voice, like everywhere else). */
static void isl_rejections_drop_reason(JSValueConst reason) {
  for (IslRejection **link = &isl_rejections; *link;) {
    if (JS_IsSameValue(isl_ctx, (*link)->reason, reason)) {
      IslRejection *r = *link;
      *link = r->next;
      isl_rejection_free(r);
    } else {
      link = &(*link)->next;
    }
  }
  isl_rejections_tail = &isl_rejections;
  while (*isl_rejections_tail) isl_rejections_tail = &(*isl_rejections_tail)->next;
}

ScrJsval *scr_jsval_import_dyn(const ScrStr *key) {
  isl_entry();
  if (!isl_booted) isl_modules_boot();
  JSValue promise = JS_LoadModule(isl_ctx, ISL_IMPORT_BASE, key->data);
  if (!JS_IsException(promise)) {
    /* Settlement flows through reaction jobs (each module's own promise
     * feeds the returned one) — drain them so a rejection is visible NOW,
     * then drop the intermediates' ledger twins. Embedded packages have
     * no top-level await (island.import documents the same rule), so the
     * drain either settles the promise or leaves genuinely-async work to
     * the loop. */
    JSContext *jctx;
    while (JS_ExecutePendingJob(isl_rt, &jctx) > 0) {
    }
    if (JS_PromiseState(isl_ctx, promise) == JS_PROMISE_REJECTED) {
      JSValue reason = JS_PromiseResult(isl_ctx, promise);
      isl_rejections_drop_reason(reason);
      JS_FreeValue(isl_ctx, reason);
    }
  }
  if (JS_IsException(promise)) {
    /* Wrap the pending exception into a rejected promise — Node's shape
     * for EVERY dynamic-import failure. */
    JSValue reason = JS_GetException(isl_ctx);
    JSValue global = JS_GetGlobalObject(isl_ctx);
    JSValue ctor = JS_GetPropertyStr(isl_ctx, global, "Promise");
    JSValue reject = JS_GetPropertyStr(isl_ctx, ctor, "reject");
    JSValue rejected = JS_Call(isl_ctx, reject, ctor, 1, &reason);
    JS_FreeValue(isl_ctx, reject);
    JS_FreeValue(isl_ctx, ctor);
    JS_FreeValue(isl_ctx, global);
    JS_FreeValue(isl_ctx, reason);
    if (JS_IsException(rejected)) { /* engine-level surprise only */
      isl_bridge_exception();
      return NULL;
    }
    return isl_cell_new(rejected);
  }
  return isl_cell_new(promise);
}

/* ── marshal out (validated exits) ────────────────────────────────────
 * STRICT extraction, mirroring the dynCheck walkers' no-coercion rule:
 * the failure is a real, catchable TypeError instance naming both types. */

/* The deferred boundary failure (libCall island.castFail): a checked cast
 * of an island value to a type with no validated exit (a Promise of a
 * function-carrying interface — the Node-typed async-API shape). The
 * value was evaluated by the caller; the cast throws a catchable
 * TypeError naming the target, exactly when the impossible conversion is
 * attempted — typed-but-never-executed code (a wasm decode path behind a
 * rejecting import) still compiles. */
void scr_jsval_cast_fail(ScrJsval *v, const ScrStr *target) {
  (void)v;
  char buf[512];
  int n = snprintf(buf, sizeof buf,
                   "island value cannot be validated as '%s' (the type has no "
                   "island exit — functions and promises cannot cross the boundary)",
                   target->data);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)(n < 0 ? 0 : (size_t)n < sizeof buf ? (size_t)n : sizeof buf - 1));
}

static void isl_exit_fail(const char *want, ScrJsval *v) {
  ScrStr *got = scr_jsval_typeof(v);
  char buf[128];
  int n = snprintf(buf, sizeof buf, "expected %s, got %s", want,
                   got ? got->data : "unknown");
  if (got) scr_str_release(got);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
}

int scr_jsval_exit_f64(ScrJsval *v, double *out) {
  isl_entry();
  if (!JS_IsNumber(v->v)) {
    isl_exit_fail("number", v);
    return 0;
  }
  return JS_ToFloat64(isl_ctx, out, v->v) == 0;
}

int scr_jsval_exit_bool(ScrJsval *v, bool *out) {
  isl_entry();
  if (!JS_IsBool(v->v)) {
    isl_exit_fail("boolean", v);
    return 0;
  }
  *out = JS_ToBool(isl_ctx, v->v) > 0;
  return 1;
}

ScrStr *scr_jsval_exit_str(ScrJsval *v) {
  isl_entry();
  if (!JS_IsString(v->v)) {
    isl_exit_fail("string", v);
    return NULL;
  }
  return isl_js_to_str(v->v);
}

/* Validated Uint8Array exit: the engine value must be a Uint8Array
 * (engine Buffers are Uint8Array subclasses and pass — matching the
 * static world, where Buffer IS bytes<u8>); the payload COPIES out as a
 * fresh u8 bytes value, the boundary's aliasing stance. NULL = the
 * boundary TypeError was thrown (lying declaration). */
ScrBytes *scr_jsval_exit_bytes(ScrJsval *v) {
  isl_entry();
  if (JS_GetTypedArrayType(v->v) != JS_TYPED_ARRAY_UINT8) {
    isl_exit_fail("a Uint8Array", v);
    return NULL;
  }
  size_t n = 0;
  uint8_t *data = JS_GetUint8Array(isl_ctx, &n, v->v);
  if (!data) {
    if (JS_HasException(isl_ctx)) { /* detached buffer and friends */
      isl_bridge_exception();
      return NULL;
    }
    n = 0; /* an empty view */
  }
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)n);
  if (n > 0) memcpy(b->data, data, n);
  return b;
}

/* Validated exit of an engine value into an `any[]`-declared slot (the
 * jsval-element-array spelling — withPlugins' `loadPlugins(plugins)`
 * boundary): the engine's Array.isArray gates (a non-array refuses with
 * the catchable boundary TypeError), then elements copy BY REFERENCE
 * into a native array of engine cells — identity preserved, length a
 * snapshot (the exit's aliasing stance: element IDENTITY crosses, the
 * spine is a copy). +1, or NULL with the exception pending. */
ScrArr *scr_jsval_exit_jsval_arr(ScrJsval *v) {
  isl_entry();
  if (JS_IsArray(v->v) <= 0) {
    isl_exit_fail("an array", v);
    return NULL;
  }
  JSValue lv = JS_GetPropertyStr(isl_ctx, v->v, "length");
  int64_t len = 0;
  JS_ToInt64(isl_ctx, &len, lv);
  JS_FreeValue(isl_ctx, lv);
  ScrArr *out = scr_arr_new_ref(&scr_jsval_retain_v, &scr_jsval_release_v, NULL,
                                len > 0 ? (size_t)len : 0);
  for (int64_t i = 0; i < len; i++) {
    JSValue e = JS_GetPropertyUint32(isl_ctx, v->v, (uint32_t)i); /* getters run */
    if (JS_IsException(e)) {
      isl_bridge_exception();
      scr_arr_release(out);
      return NULL;
    }
    scr_arr_push_ref(out, isl_cell_new(e)); /* ownership moves in */
  }
  return out;
}

/* Composite exit: engine JSON.stringify, feeding the existing
 * json.parse + dynCheck walker pipeline on the static side. A value
 * JSON cannot represent (function, undefined, symbol at the top) comes
 * back undefined — refused here so the walker sees real JSON. */
ScrStr *scr_jsval_to_json(ScrJsval *v) {
  isl_entry();
  JSValue j = JS_JSONStringify(isl_ctx, v->v, JS_UNDEFINED, JS_UNDEFINED);
  if (JS_IsException(j)) { /* cyclic value, throwing toJSON, ... */
    isl_bridge_exception();
    return NULL;
  }
  if (JS_IsUndefined(j)) {
    isl_exit_fail("a JSON-representable value", v);
    return NULL;
  }
  ScrStr *s = isl_js_to_str(j);
  JS_FreeValue(isl_ctx, j);
  return s;
}

/* ── optional chains on island values ─────────────────────────────────
 * `x?.y` on an 'any' receiver: the compiler emits the nullish test on the
 * HANDLE and, on the unit path, the engine's own undefined. Both are
 * infallible. */

bool scr_jsval_is_nullish(ScrJsval *v) {
  isl_entry();
  return JS_IsUndefined(v->v) || JS_IsNull(v->v);
}

ScrJsval *scr_jsval_undefined(void) {
  isl_entry();
  return isl_cell_new(JS_UNDEFINED);
}

ScrJsval *scr_jsval_null(void) {
  isl_entry();
  return isl_cell_new(JS_NULL);
}

/* ── typed arrays and URLs marshaling IN ──────────────────────────────
 * The union lift's non-JSON arms (and bare bytes/URL values in 'any'
 * slots): a typed array crosses as an engine typed array of the same
 * element kind — a COPY, the boundary's copy-marshal stance — and a URL
 * crosses as an engine URL instance built from its href. */

ScrJsval *scr_jsval_from_bytes(const ScrBytes *b) {
  isl_entry();
  if (b->elem == SCR_BYTES_U8) {
    JSValue v = JS_NewUint8ArrayCopy(isl_ctx, b->data, b->len);
    if (JS_IsException(v)) {
      isl_bridge_exception();
      return NULL;
    }
    return isl_cell_new(v);
  }
  JSValue buf = JS_NewArrayBufferCopy(isl_ctx, b->data,
                                      b->len * scr_bytes_elem_size(b->elem));
  if (JS_IsException(buf)) {
    isl_bridge_exception();
    return NULL;
  }
  /* The engine's constructor reads the offset/length slots unconditionally
   * — pad them with undefined like a real JS call would. */
  JSValueConst argv[3] = {buf, JS_UNDEFINED, JS_UNDEFINED};
  JSValue v = JS_NewTypedArray(isl_ctx, 3, argv,
                               b->elem == SCR_BYTES_U32   ? JS_TYPED_ARRAY_UINT32
                               : b->elem == SCR_BYTES_I32 ? JS_TYPED_ARRAY_INT32
                                                          : JS_TYPED_ARRAY_FLOAT32);
  JS_FreeValue(isl_ctx, buf);
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

/* The engine has no URL global of its own (QuickJS ships none; scr_web.c
 * defines the streams/fetch subset only), so the first URL marshal
 * installs a minimal class: construction re-parses through the SAME
 * WHATWG parser the static URL uses (scr_url.c, via a host function), so
 * a marshaled URL and `new URL(href)` in embedded code agree exactly.
 * href/protocol/pathname are the components the native accessors expose;
 * the other component reads and ALL component writes throw a clear
 * TypeError instead of silently diverging from the live re-serializing
 * accessors a real URL has (SEMANTICS.md). If a URL global already exists
 * (a future web-prelude one, or embedded code's own), it wins — the
 * marshal constructs through whatever globalThis.URL is. */
static JSValue isl_url_parse_host(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
  (void)this_val;
  if (argc < 1) return JS_ThrowTypeError(ctx, "Invalid URL");
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
  if (!s) return JS_EXCEPTION;
  ScrStr *in = scr_str_new(s, len);
  JS_FreeCString(ctx, s);
  ScrUrl *u = scr_url_new(in);
  scr_str_release(in);
  if (!u) return isl_throw_pending(ctx); /* the parser's catchable TypeError */
  ScrStr *href = scr_url_href(u);
  ScrStr *protocol = scr_url_protocol(u);
  ScrStr *pathname = scr_url_pathname(u);
  ScrStr *host = scr_url_host(u);
  ScrStr *hostname = scr_url_hostname(u);
  ScrStr *search = scr_url_search(u);
  scr_url_release(u);
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewStringLen(ctx, href->data, href->len));
  JS_SetPropertyUint32(ctx, arr, 1, JS_NewStringLen(ctx, protocol->data, protocol->len));
  JS_SetPropertyUint32(ctx, arr, 2, JS_NewStringLen(ctx, pathname->data, pathname->len));
  JS_SetPropertyUint32(ctx, arr, 3, JS_NewStringLen(ctx, host->data, host->len));
  JS_SetPropertyUint32(ctx, arr, 4, JS_NewStringLen(ctx, hostname->data, hostname->len));
  JS_SetPropertyUint32(ctx, arr, 5, JS_NewStringLen(ctx, search->data, search->len));
  scr_str_release(href);
  scr_str_release(protocol);
  scr_str_release(pathname);
  scr_str_release(host);
  scr_str_release(hostname);
  scr_str_release(search);
  return arr;
}

static const char isl_url_src[] =
    "(function (parse) {\n"
    "  'use strict';\n"
    "  const def = (o, n, v) => Object.defineProperty(o, n, { value: v, enumerable: true });\n"
    "  class URL {\n"
    /* The (input, base) form supports RELATIVE resolution — the Emscripten
     * loader's `new URL("x.wasm", import.meta.url)` — with RFC 3986
     * dot-segment removal over the base's path. Inputs that carry their
     * own scheme ignore the base (per spec); protocol-relative inputs
     * keep a narrow fence. */
    "    constructor(input, base) {\n"
    "      let s = String(input);\n"
    "      const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;\n"
    "      if (base !== undefined && !hasScheme.test(s)) {\n"
    "        const b = String(base !== null && typeof base === 'object' && 'href' in base ? base.href : base);\n"
    "        const m = hasScheme.test(b) && b.match(/^([A-Za-z][A-Za-z0-9+.-]*:)(\\/\\/[^\\/?#]*)?([^?#]*)/);\n"
    "        if (!m) throw new TypeError('Invalid base URL');\n"
    "        if (s.startsWith('//')) {\n"
    "          throw new TypeError('protocol-relative URLs are not supported in the scriptc island yet');\n"
    "        }\n"
    "        let path = s.startsWith('/') ? s : (m[3] || '/').replace(/[^\\/]*$/, '') + s;\n"
    "        const out = [];\n"
    "        for (const seg of path.split('/')) {\n"
    "          if (seg === '.') continue;\n"
    "          if (seg === '..') { if (out.length > 1) out.pop(); continue; }\n"
    "          out.push(seg);\n"
    "        }\n"
    "        s = m[1] + (m[2] || '') + out.join('/');\n"
    "      }\n"
    "      const c = parse(s);\n"
    /* href and search are LIVE-COUPLED (the one WHATWG mutation loop the
     * a real CLI's API client drives: url.searchParams.set('teamId', …)
     * then fetch(url)): both live in writable slots, the search setter
     * recomposes href around the old query, and the searchParams getter
     * hands out ONE URLSearchParams whose mutators write back through
     * it. The other components stay parse-time snapshots. */
    "      Object.defineProperty(this, '_href', { value: c[0], writable: true });\n"
    "      Object.defineProperty(this, '_search', { value: c[5], writable: true });\n"
    "      const self = this;\n"
    "      Object.defineProperty(this, 'href', { enumerable: true, get: () => self._href });\n"
    "      Object.defineProperty(this, 'search', {\n"
    "        enumerable: true,\n"
    "        get: () => self._search,\n"
    "        set: (v) => {\n"
    "          self._applySearch(String(v));\n"
    "          if (self._sp !== undefined) {\n"
    "            self._sp._pairs.length = 0;\n"
    "            for (const [k, val] of new globalThis.URLSearchParams(self._search)) self._sp._pairs.push([k, val]);\n"
    "          }\n"
    "        },\n"
    "      });\n"
    "      def(this, 'protocol', c[1]);\n"
    "      def(this, 'pathname', c[2]);\n"
    "      def(this, 'host', c[3]);\n"
    "      def(this, 'hostname', c[4]);\n"
    "      def(this, 'port', c[3].length > c[4].length ? c[3].slice(c[4].length + 1) : '');\n"
    "      const hashAt = c[0].indexOf('#');\n"
    "      def(this, 'hash', hashAt < 0 ? '' : c[0].slice(hashAt));\n"
    "      const cred = c[3] !== '' && c[0].startsWith(c[1] + '//')\n"
    "        ? c[0].slice(c[1].length + 2, c[0].indexOf(c[3], c[1].length + 2)) : '';\n"
    "      const at = cred.lastIndexOf('@');\n"
    "      const userinfo = at < 0 ? '' : cred.slice(0, at);\n"
    "      const colon = userinfo.indexOf(':');\n"
    "      def(this, 'username', colon < 0 ? userinfo : userinfo.slice(0, colon));\n"
    "      def(this, 'password', colon < 0 ? '' : userinfo.slice(colon + 1));\n"
    "      def(this, 'origin', (c[1] === 'http:' || c[1] === 'https:' || c[1] === 'ws:' || c[1] === 'wss:' || c[1] === 'ftp:')\n"
    "        ? c[1] + '//' + c[3] : 'null');\n"
    "    }\n"
    /* The search half of the live coupling: normalize the assigned
     * query, splice it into href between the pre-query part and the
     * fragment. */
    "    _applySearch(v) {\n"
    "      let s = String(v);\n"
    "      if (s !== '' && !s.startsWith('?')) s = '?' + s;\n"
    "      if (s === '?') s = '';\n"
    "      const base = this._href.split('#')[0].split('?')[0];\n"
    "      this._search = s;\n"
    "      this._href = base + s + this.hash;\n"
    "    }\n"
    /* searchParams: ONE URLSearchParams per URL (identity stable, like
     * the spec) whose mutators — append/set/delete/sort — write the
     * serialized list back into search/href. Reads AND writes agree with
     * Node for the query component; the other components stay parse-time
     * snapshots. */
    "    get searchParams() {\n"
    "      if (this._sp === undefined) {\n"
    "        const sp = new globalThis.URLSearchParams(this.search);\n"
    "        const sync = () => {\n"
    "          const q = sp.toString();\n"
    "          this._applySearch(q === '' ? '' : '?' + q);\n"
    "        };\n"
    "        for (const m of ['append', 'set', 'delete', 'sort']) {\n"
    "          const orig = sp[m].bind(sp);\n"
    "          Object.defineProperty(sp, m, {\n"
    "            value: (...args) => { const r = orig(...args); sync(); return r; },\n"
    "          });\n"
    "        }\n"
    "        Object.defineProperty(this, '_sp', { value: sp });\n"
    "      }\n"
    "      return this._sp;\n"
    "    }\n"
    "    toString() { return this.href; }\n"
    "    toJSON() { return this.href; }\n"
    "    static canParse(input, base) {\n"
    "      try { new URL(input, base); return true; } catch (e) { return false; }\n"
    "    }\n"
    "    static parse(input, base) {\n"
    "      try { return new URL(input, base); } catch (e) { return null; }\n"
    "    }\n"
    "  }\n"
    "  globalThis.URL = URL;\n"
    "})\n";

/* Install the minimal URL class if the global is still missing. Called on
 * first URL marshal AND at module boot (embedded loaders do
 * `new URL("x.wasm", import.meta.url)` without any URL ever crossing). */
static void isl_install_url_class(void) {
  JSValue g = JS_GetGlobalObject(isl_ctx);
  JSValue ctor = JS_GetPropertyStr(isl_ctx, g, "URL");
  if (JS_IsUndefined(ctor)) {
    JSValue installer = JS_Eval(isl_ctx, isl_url_src, sizeof isl_url_src - 1,
                                "<scr-url>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(installer)) {
      fprintf(stderr, "scriptc: island URL prelude failed to evaluate\n");
      abort(); /* fixed source; failing to parse is a build defect */
    }
    JSValue parse = JS_NewCFunction(isl_ctx, isl_url_parse_host, "__scr_url_parse", 1);
    JSValue r = JS_Call(isl_ctx, installer, JS_UNDEFINED, 1, &parse);
    JS_FreeValue(isl_ctx, parse);
    JS_FreeValue(isl_ctx, installer);
    if (JS_IsException(r)) {
      fprintf(stderr, "scriptc: island URL prelude failed to install\n");
      abort();
    }
    JS_FreeValue(isl_ctx, r);
  }
  JS_FreeValue(isl_ctx, ctor);
  JS_FreeValue(isl_ctx, g);
}

ScrJsval *scr_jsval_from_url(ScrUrl *u) {
  isl_entry();
  isl_install_url_class();
  JSValue g = JS_GetGlobalObject(isl_ctx);
  JSValue ctor = JS_GetPropertyStr(isl_ctx, g, "URL");
  JS_FreeValue(isl_ctx, g);
  ScrStr *href = scr_url_href(u);
  JSValue hrefv = JS_NewStringLen(isl_ctx, href->data, href->len);
  scr_str_release(href);
  JSValue v = JS_CallConstructor(isl_ctx, ctor, 1, &hrefv);
  JS_FreeValue(isl_ctx, hrefv);
  JS_FreeValue(isl_ctx, ctor);
  if (JS_IsException(v)) {
    isl_bridge_exception();
    return NULL;
  }
  return isl_cell_new(v);
}

#endif /* SCR_DYNAMIC */
