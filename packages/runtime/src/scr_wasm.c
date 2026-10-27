/* The JavaScript WebAssembly API over modules translated to native code
 * when the program was built (scr_wasm_abi.h is the contract with the
 * translator).
 *
 * WebAssembly.compile, instantiate, validate and new Module hash the bytes
 * they are given and look the module up by SHA-256 and length in
 * scr_wasm_registry, which the compiler emits; bytes that were not
 * translated at build time reject with a CompileError that says so, and
 * that names the reason for modules the build saw but does not translate
 * (scr_wasm_untranslated).
 * Nothing is interpreted or compiled at run time, and a translated
 * module's bytes were validated when the program was built.
 *
 * Values: Module, Instance, Memory, Table and Global are native handles in
 * the checked-dynamic representation (the SCR_DYNH_WASM_* tags, installed
 * per thread on first use). An instance's exports object is a frozen
 * null-prototype object whose functions call the translated code through
 * its thunks under a trap guard; imports are checked-dynamic callables
 * called with `this` undefined, ToJSValue arguments and ToWebAssemblyValue
 * results.
 *
 * Traps. Translated code calls scr_wasm_trap, which siglongjmps to the
 * innermost export entry (scr_wasm_enter); the entry throws Node's
 * WebAssembly.RuntimeError. With guard pages, an out-of-bounds access
 * faults inside the memory's reservation and stack exhaustion faults near
 * the stack pointer: the SIGSEGV/SIGBUS handler (installed when the first
 * guarded instance is created, on a per-thread alternate stack, chaining
 * to the previous handler for every other fault) moves the interrupted
 * context to a trampoline that traps the same way, so the handler itself
 * returns normally. Async fibers' stacks have no guard page of their own,
 * so the first export call on one protects the lowest page of its mapping
 * (scr_wasm_guard_fiber). An exception thrown by an import unwinds the
 * translated frames the same way and propagates unchanged. Translated
 * frames own nothing, so abandoning them leaks nothing; the module's own
 * shadow stack pointer is not restored, exactly as in V8.
 *
 * The error classes are Errors whose inherited name is CompileError,
 * LinkError or RuntimeError (not an own property, as in Node), which is
 * the brand instanceof tests.
 *
 * The Memory, Table and Global constructors build the same objects an
 * instance exports, so either kind can be imported; WebAssembly.Module.
 * imports, exports and customSections read the descriptor.
 *
 * Gaps (results/opt-wasm-design/DESIGN.md, stages W6-W9): Memory.grow
 * does not detach the previous ArrayBuffer (the memory never moves with
 * guard pages, and explicit-bounds memories keep their previous blocks, so
 * old views stay valid with their old length); shared memories are not
 * constructed; instances, their imports and exports are never freed (the
 * cycle collector does not trace them yet). */
#if !defined(_GNU_SOURCE) && defined(__linux__)
#define _GNU_SOURCE /* REG_RIP and friends in <ucontext.h> */
#endif
#include "scr_runtime.h"
#include "scr_wasm_abi.h"

#include <math.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

#if !defined(_WIN32)
#define SCR_WASM_SIGNALS 1
#include <pthread.h>
#include <signal.h>
#include <sys/mman.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/ucontext.h>
#else
#include <ucontext.h>
#endif
#endif

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_WASM_ASAN 1
#endif
#endif
#if !defined(SCR_WASM_ASAN) && defined(__SANITIZE_ADDRESS__)
#define SCR_WASM_ASAN 1
#endif

/* Entry points of translated code. */
/* Sanitized builds do not declare it noreturn: AddressSanitizer would
 * call __asan_handle_no_return before every call, which warns on the
 * runtime's async fibers. */
#ifdef SCR_WASM_ASAN
void scr_wasm_trap(int32_t code);
#else
_Noreturn void scr_wasm_trap(int32_t code);
#endif
void scr_wasm_import_call(void *host, int32_t index, const uint64_t *args, uint64_t *results);
int32_t scr_wasm_memory_grow(void *inst, int32_t delta);
void scr_wasm_memory_fill(void *inst, int32_t d, int32_t value, int32_t n);
void scr_wasm_memory_copy(void *inst, int32_t d, int32_t s, int32_t n);
void scr_wasm_memory_init(void *inst, int32_t seg, int32_t d, int32_t s, int32_t n);
void scr_wasm_data_drop(void *inst, int32_t seg);
void *scr_wasm_table_get(void *inst, int32_t t, int32_t i);
void scr_wasm_table_set(void *inst, int32_t t, int32_t i, void *value);
int32_t scr_wasm_table_grow(void *inst, int32_t t, void *init, int32_t n);
void scr_wasm_table_fill(void *inst, int32_t t, int32_t i, void *value, int32_t n);
void scr_wasm_table_copy(void *inst, int32_t dt, int32_t st, int32_t d, int32_t s, int32_t n);
void scr_wasm_table_init(void *inst, int32_t t, int32_t seg, int32_t d, int32_t s, int32_t n);
void scr_wasm_elem_drop(void *inst, int32_t seg);
void scr_wasm_global_set_ref(void *cell, void *value);

#define SCR_WASM_PAGE 65536u
#define SCR_WASM_MAX_PAGES 65536u
#define SCR_WASM_MAX_TABLE 10000000u
/* Every `base + zext(i32) + offset(u32) + size` the translated code can
 * form stays inside this reservation, so an access past the memory faults
 * on a PROT_NONE page instead of reaching other mappings. */
#define SCR_WASM_GUARD_RESERVATION ((uint64_t)8 << 30 | (uint64_t)SCR_WASM_PAGE)

/* ── instance state ──────────────────────────────────────────────────── */

typedef struct ScrWasmInst {
  size_t rc;
  const ScrWasmModuleDesc *desc;
  void **inst; /* the translated code's instance (layout in scr_wasm_abi.h) */
  ScrDyn **funcs; /* imported function values, by function index */
  ScrWasmMemory *memory;
  ScrWasmTable **tables;
  ScrWasmGlobal **globals;
  ScrWasmFuncRef *funcrefs;
  ScrDyn **export_fns; /* exported function values, by function index (lazy) */
  char **export_names;
  bool *data_dropped;
  bool *elem_dropped;
  ScrDyn *exports;
  /* The Memory, Table and Global objects of the instance, by index: the
   * imported object itself, or the one created when the module exports it,
   * so every export of the same index is the same object, as in V8. */
  ScrDyn *memory_obj;
  ScrDyn **table_objs;
  ScrDyn **global_objs;
} ScrWasmInst;

static ScrWasmInst *scr_wasm_host_of(void *inst) { return ((ScrWasmInst **)inst)[0]; }

#ifdef SCR_RC_AUDIT
/* Instances are never freed yet (stage W6), so the sanitized lane's RC
 * audit would report everything they hold. Audited builds tear every
 * instance down at exit instead. */
static SCR_TL ScrWasmInst **scr_wasm_hosts;
static SCR_TL size_t scr_wasm_host_count, scr_wasm_host_cap;
static void scr_wasm_teardown(void);

static void scr_wasm_note_host(ScrWasmInst *host) {
  if (scr_wasm_host_count == 0 && scr_wasm_host_cap == 0) scr_atexit(scr_wasm_teardown);
  if (scr_wasm_host_count == scr_wasm_host_cap) {
    size_t cap = scr_wasm_host_cap ? scr_wasm_host_cap * 2 : 8;
    ScrWasmInst **grown = realloc(scr_wasm_hosts, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    scr_wasm_hosts = grown;
    scr_wasm_host_cap = cap;
  }
  scr_wasm_hosts[scr_wasm_host_count++] = host;
}
#endif

/* ── SHA-256 (FIPS 180-4) ────────────────────────────────────────────── */

typedef struct {
  uint32_t h[8];
} ScrWasmSha;

static const uint32_t scr_wasm_sha_k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

static uint32_t scr_wasm_rotr(uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }

static void scr_wasm_sha_block(ScrWasmSha *s, const uint8_t *p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = scr_wasm_rotr(w[i - 15], 7) ^ scr_wasm_rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = scr_wasm_rotr(w[i - 2], 17) ^ scr_wasm_rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3], e = s->h[4], f = s->h[5], g = s->h[6], h = s->h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = h + (scr_wasm_rotr(e, 6) ^ scr_wasm_rotr(e, 11) ^ scr_wasm_rotr(e, 25)) + ((e & f) ^ (~e & g)) +
                  scr_wasm_sha_k[i] + w[i];
    uint32_t t2 = (scr_wasm_rotr(a, 2) ^ scr_wasm_rotr(a, 13) ^ scr_wasm_rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  s->h[0] += a;
  s->h[1] += b;
  s->h[2] += c;
  s->h[3] += d;
  s->h[4] += e;
  s->h[5] += f;
  s->h[6] += g;
  s->h[7] += h;
}

static void scr_wasm_sha256(const uint8_t *data, size_t len, uint8_t out[32]) {
  ScrWasmSha s = {{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19}};
  size_t i = 0;
  for (; i + 64 <= len; i += 64) scr_wasm_sha_block(&s, data + i);
  uint8_t tail[128] = {0};
  size_t rest = len - i;
  if (rest) memcpy(tail, data + i, rest);
  tail[rest] = 0x80;
  size_t total = rest + 1 + 8 <= 64 ? 64 : 128;
  uint64_t bits = (uint64_t)len * 8;
  for (int k = 0; k < 8; k++) tail[total - 1 - k] = (uint8_t)(bits >> (8 * k));
  scr_wasm_sha_block(&s, tail);
  if (total == 128) scr_wasm_sha_block(&s, tail + 64);
  for (int k = 0; k < 8; k++) {
    out[4 * k] = (uint8_t)(s.h[k] >> 24);
    out[4 * k + 1] = (uint8_t)(s.h[k] >> 16);
    out[4 * k + 2] = (uint8_t)(s.h[k] >> 8);
    out[4 * k + 3] = (uint8_t)s.h[k];
  }
}

/* ── errors ──────────────────────────────────────────────────────────── */

enum { SCR_WASM_COMPILE_ERROR, SCR_WASM_LINK_ERROR, SCR_WASM_RUNTIME_ERROR };
static const char *const scr_wasm_error_names[] = {"CompileError", "LinkError", "RuntimeError"};

/* A WebAssembly error: an Error whose inherited (not own) name is the
 * class's. Borrows message. +1. */
static ScrError *scr_wasm_error_make(int which, ScrStr *message) {
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(e->name);
  const char *name = scr_wasm_error_names[which];
  e->name = scr_str_new(name, strlen(name));
  e->name_present = false;
  return e;
}

static void scr_wasm_throw_kind(int which, const char *msg) {
  ScrStr *s = scr_str_new(msg, strlen(msg));
  ScrError *e = scr_wasm_error_make(which, s);
  scr_str_release(s);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

static int scr_wasm_error_brand(const ScrError *e) {
  if (!e || e->vt != &scr_error_vts[SCR_ERR_ERROR] || e->name_present || !e->name) return -1;
  for (int i = 0; i < 3; i++) {
    size_t n = strlen(scr_wasm_error_names[i]);
    if (e->name->len == n && !memcmp(e->name->data, scr_wasm_error_names[i], n)) return i;
  }
  return -1;
}

static void scr_wasm_type_error(const char *msg) { scr_throw_error_msg(SCR_ERR_TYPE, msg, strlen(msg)); }
static void scr_wasm_range_error(const char *msg) { scr_throw_error_msg(SCR_ERR_RANGE, msg, strlen(msg)); }

static const char *scr_wasm_trap_message(int code) {
  switch (code) {
    case SCR_WASM_TRAP_MEMORY_OOB: return "memory access out of bounds";
    case SCR_WASM_TRAP_DIV_BY_ZERO: return "divide by zero";
    case SCR_WASM_TRAP_DIV_UNREPRESENTABLE: return "divide result unrepresentable";
    case SCR_WASM_TRAP_REM_BY_ZERO: return "remainder by zero";
    case SCR_WASM_TRAP_FLOAT_UNREPRESENTABLE: return "float unrepresentable in integer range";
    case SCR_WASM_TRAP_TABLE_OOB: return "table index is out of bounds";
    case SCR_WASM_TRAP_SIGNATURE: return "null function or function signature mismatch";
    case SCR_WASM_TRAP_NULL: return "dereferencing a null pointer";
    case SCR_WASM_TRAP_ELEM_SEGMENT: return "element segment out of bounds";
    default: return "unreachable";
  }
}

/* Throws the JavaScript error for a trap code (nothing for HOST: its
 * exception is already pending). */
static void scr_wasm_throw_trap(int code) {
  if (code == SCR_WASM_TRAP_HOST) return;
  if (code == SCR_WASM_TRAP_EXHAUSTION) {
    scr_wasm_range_error("Maximum call stack size exceeded");
    return;
  }
  scr_wasm_throw_kind(SCR_WASM_RUNTIME_ERROR, scr_wasm_trap_message(code));
}

/* ── the trap guard ──────────────────────────────────────────────────── */

/* AddressSanitizer intercepts siglongjmp and warns when it cannot tell the
 * extent of the running stack, as on the runtime's async fibers. Sanitized
 * builds therefore jump with a pair no runtime intercepts and unpoison the
 * abandoned frames themselves: the compiler's builtin pair, or on AArch64,
 * where the compiler has no builtin setjmp lowering, the pair below. */
#if defined(SCR_WASM_ASAN) && defined(__aarch64__)
void __asan_unpoison_memory_region(void const volatile *addr, size_t size);
/* x19-x28, the frame and link registers, sp and d8-d15: the registers the
 * AArch64 procedure call standard has a callee preserve. */
typedef uint64_t ScrWasmJmp[21];
__attribute__((naked, noinline, returns_twice)) static int scr_wasm_setjmp(ScrWasmJmp buf) {
  __asm__ volatile("stp x19, x20, [x0, #0]\n"
                   "stp x21, x22, [x0, #16]\n"
                   "stp x23, x24, [x0, #32]\n"
                   "stp x25, x26, [x0, #48]\n"
                   "stp x27, x28, [x0, #64]\n"
                   "stp x29, x30, [x0, #80]\n"
                   "mov x16, sp\n"
                   "str x16, [x0, #96]\n"
                   "stp d8, d9, [x0, #104]\n"
                   "stp d10, d11, [x0, #120]\n"
                   "stp d12, d13, [x0, #136]\n"
                   "stp d14, d15, [x0, #152]\n"
                   "mov w0, #0\n"
                   "ret\n");
}
/* Returns 1 from the scr_wasm_setjmp call that filled buf. */
__attribute__((naked, noinline, noreturn)) static void scr_wasm_longjmp(ScrWasmJmp buf) {
  __asm__ volatile("ldp x19, x20, [x0, #0]\n"
                   "ldp x21, x22, [x0, #16]\n"
                   "ldp x23, x24, [x0, #32]\n"
                   "ldp x25, x26, [x0, #48]\n"
                   "ldp x27, x28, [x0, #64]\n"
                   "ldp x29, x30, [x0, #80]\n"
                   "ldr x16, [x0, #96]\n"
                   "mov sp, x16\n"
                   "ldp d8, d9, [x0, #104]\n"
                   "ldp d10, d11, [x0, #120]\n"
                   "ldp d12, d13, [x0, #136]\n"
                   "ldp d14, d15, [x0, #152]\n"
                   "mov w0, #1\n"
                   "ret\n");
}
#define SCR_WASM_SETJMP(buf) scr_wasm_setjmp(buf)
#define SCR_WASM_LONGJMP(buf) scr_wasm_longjmp(buf)
#elif defined(SCR_WASM_ASAN)
void __asan_unpoison_memory_region(void const volatile *addr, size_t size);
typedef void *ScrWasmJmp[5];
#define SCR_WASM_SETJMP(buf) __builtin_setjmp(buf)
#define SCR_WASM_LONGJMP(buf) __builtin_longjmp(buf, 1)
#elif defined(_WIN32)
typedef jmp_buf ScrWasmJmp;
#define SCR_WASM_SETJMP(buf) setjmp(buf)
#define SCR_WASM_LONGJMP(buf) longjmp(buf, 1)
#else
typedef sigjmp_buf ScrWasmJmp;
#define SCR_WASM_SETJMP(buf) sigsetjmp(buf, 0)
#define SCR_WASM_LONGJMP(buf) siglongjmp(buf, 1)
#endif

typedef struct ScrWasmEntry {
  ScrWasmJmp jmp;
  struct ScrWasmEntry *prev;
  uintptr_t frame; /* the entry's frame address: exhaustion resumes below it */
} ScrWasmEntry;

/* Thread-local in every build: each thread runs its own instances, and
 * the fault handler reads them. */
static _Thread_local ScrWasmEntry *scr_wasm_top;
static _Thread_local bool scr_wasm_running; /* translated code (not an import) is on top */
static _Thread_local int scr_wasm_trap_code;

/* Externref values an import returned: translated code holds them without
 * a reference, so they stay alive until the outermost export call
 * returns. */
static _Thread_local ScrDyn **scr_wasm_kept;
static _Thread_local size_t scr_wasm_kept_count, scr_wasm_kept_cap;

static void scr_wasm_keep(ScrDyn *d) {
  if (scr_wasm_kept_count == scr_wasm_kept_cap) {
    size_t cap = scr_wasm_kept_cap ? scr_wasm_kept_cap * 2 : 16;
    ScrDyn **grown = realloc(scr_wasm_kept, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    scr_wasm_kept = grown;
    scr_wasm_kept_cap = cap;
  }
  scr_wasm_kept[scr_wasm_kept_count++] = scr_dyn_retain(d);
}

static void scr_wasm_release_kept(void) {
  while (scr_wasm_kept_count) scr_dyn_release(scr_wasm_kept[--scr_wasm_kept_count]);
}

#ifdef SCR_WASM_ASAN
/* Uninstrumented, so the sanitizer inserts no __asan_handle_no_return
 * before the jump; the abandoned frames are unpoisoned below. */
__attribute__((no_sanitize("address")))
#else
_Noreturn
#endif
void scr_wasm_trap(int32_t code) {
  ScrWasmEntry *top = scr_wasm_top;
  if (!top) scr_trap("scriptc: WebAssembly trap outside an export call\n");
  scr_wasm_running = false;
  scr_wasm_trap_code = code;
#ifdef SCR_WASM_ASAN
  /* The real frame address: a local's address may be on the sanitizer's
   * fake stack. */
  uintptr_t low = ((uintptr_t)__builtin_frame_address(0) & ~(uintptr_t)15) - 256;
  if (top->frame > low && top->frame - low < ((uintptr_t)256 << 20))
    __asan_unpoison_memory_region((void *)low, top->frame - low);
#endif
  SCR_WASM_LONGJMP(top->jmp);
}

#if SCR_WASM_SIGNALS
static void scr_wasm_thread_init(void);
static void scr_wasm_guard_fiber(uintptr_t frame);
#endif

/* Code with explicit bounds checks: the lowest stack address translated
 * code may use before it traps with stack exhaustion (translate.ts checks
 * it in the entry of every function through which the stack can grow
 * without bound): the runtime's own stack guard for the running stack
 * (thread or async fiber), read at each outermost export call. */
_Thread_local uint64_t scr_wasm_stack_limit;

static void scr_wasm_set_stack_limit(void) {
#if !defined(_WIN32) && !defined(__wasi__)
  if (!scr_stack_guard) scr_stack_guard_init();
  scr_wasm_stack_limit = scr_stack_guard;
#endif
}

/* Calls a thunk (or `call` on `code`, a function reference's code) with
 * traps caught; answers a SCR_WASM_TRAP_* code. */
static __attribute__((noinline)) int scr_wasm_enter_ref(ScrWasmThunk fn, ScrWasmCallThunk call, void *ref_code,
                                                        void *inst, const uint64_t *args, uint64_t *results) {
#if SCR_WASM_SIGNALS
  scr_wasm_thread_init();
#endif
  ScrWasmEntry entry;
  entry.prev = scr_wasm_top;
  entry.frame = (uintptr_t)__builtin_frame_address(0);
  if (!entry.prev) {
    scr_wasm_set_stack_limit();
#if SCR_WASM_SIGNALS
    scr_wasm_guard_fiber(entry.frame);
#endif
  }
  bool was_running = scr_wasm_running;
  scr_wasm_top = &entry;
  int code = 0;
  if (SCR_WASM_SETJMP(entry.jmp) == 0) {
    scr_wasm_running = true;
    if (call) call(ref_code, inst, args, results);
    else fn(inst, args, results);
  } else {
    code = scr_wasm_trap_code;
  }
  scr_wasm_running = was_running;
  scr_wasm_top = entry.prev;
  return code;
}

static int scr_wasm_enter(ScrWasmThunk fn, void *inst, const uint64_t *args, uint64_t *results) {
  return scr_wasm_enter_ref(fn, NULL, NULL, inst, args, results);
}

/* Called by each caller of scr_wasm_enter once it has converted the
 * call's results: after the outermost call, the references kept for it
 * (import results, and references a table or global replaced while the
 * guest could still hold them) are released. The results' externrefs are
 * borrowed from that list until then. */
static void scr_wasm_leave(void) {
  if (!scr_wasm_top && scr_wasm_kept_count) scr_wasm_release_kept();
}

static void scr_wasm_init_thunk(void *inst, const uint64_t *args, uint64_t *results) {
  (void)args;
  (void)results;
  scr_wasm_host_of(inst)->desc->init(inst);
}

static void scr_wasm_start_thunk(void *inst, const uint64_t *args, uint64_t *results) {
  (void)args;
  (void)results;
  scr_wasm_host_of(inst)->desc->start(inst);
}

/* ── memories and the fault handler ──────────────────────────────────── */

#if SCR_WASM_SIGNALS
/* Reservations of this thread's guarded memories, read by the fault
 * handler (faults are synchronous, so nothing changes under it). */
typedef struct {
  uintptr_t start, end;
} ScrWasmRange;
static _Thread_local ScrWasmRange *scr_wasm_ranges;
static _Thread_local size_t scr_wasm_range_count, scr_wasm_range_cap;
static _Thread_local bool scr_wasm_altstack_ready;

static struct sigaction scr_wasm_prev_segv, scr_wasm_prev_bus;
static pthread_once_t scr_wasm_handler_once = PTHREAD_ONCE_INIT;
static bool scr_wasm_handler_installed;

static void scr_wasm_range_add(uint8_t *base, uint64_t len) {
  if (scr_wasm_range_count == scr_wasm_range_cap) {
    size_t cap = scr_wasm_range_cap ? scr_wasm_range_cap * 2 : 8;
    ScrWasmRange *grown = realloc(scr_wasm_ranges, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    scr_wasm_ranges = grown;
    scr_wasm_range_cap = cap;
  }
  scr_wasm_ranges[scr_wasm_range_count++] = (ScrWasmRange){(uintptr_t)base, (uintptr_t)base + len};
}

static void scr_wasm_range_remove(uint8_t *base) {
  for (size_t i = 0; i < scr_wasm_range_count; i++) {
    if (scr_wasm_ranges[i].start == (uintptr_t)base) {
      scr_wasm_ranges[i] = scr_wasm_ranges[--scr_wasm_range_count];
      return;
    }
  }
}

static _Noreturn __attribute__((noinline, used)) void scr_wasm_fault_trampoline(int32_t code) {
  scr_wasm_trap(code);
  __builtin_unreachable();
}

/* Moves the interrupted context to scr_wasm_fault_trampoline(code). With
 * `stack` nonzero the trampoline runs at that stack address (exhaustion);
 * otherwise below the interrupted stack pointer. */
static bool scr_wasm_redirect(void *context, int32_t code, uintptr_t stack) {
  ucontext_t *uc = context;
  uintptr_t target = (uintptr_t)&scr_wasm_fault_trampoline;
#if defined(__APPLE__) && defined(__x86_64__)
  uintptr_t sp = stack ? stack : (uintptr_t)uc->uc_mcontext->__ss.__rsp - 256;
  sp = (sp & ~(uintptr_t)15) - 8; /* as after a call */
  uc->uc_mcontext->__ss.__rsp = sp;
  uc->uc_mcontext->__ss.__rdi = (uint64_t)(uint32_t)code;
  uc->uc_mcontext->__ss.__rip = target;
  return true;
#elif defined(__APPLE__) && defined(__aarch64__)
  uintptr_t sp = stack ? stack : (uintptr_t)__darwin_arm_thread_state64_get_sp(uc->uc_mcontext->__ss) - 256;
  sp &= ~(uintptr_t)15;
  __darwin_arm_thread_state64_set_sp(uc->uc_mcontext->__ss, sp);
  uc->uc_mcontext->__ss.__x[0] = (uint64_t)(uint32_t)code;
  __darwin_arm_thread_state64_set_lr_fptr(uc->uc_mcontext->__ss, (void *)target);
  __darwin_arm_thread_state64_set_pc_fptr(uc->uc_mcontext->__ss, (void *)target);
  return true;
#elif defined(__linux__) && defined(__x86_64__)
  uintptr_t sp = stack ? stack : (uintptr_t)uc->uc_mcontext.gregs[REG_RSP] - 256;
  sp = (sp & ~(uintptr_t)15) - 8;
  uc->uc_mcontext.gregs[REG_RSP] = (greg_t)sp;
  uc->uc_mcontext.gregs[REG_RDI] = (greg_t)(uint32_t)code;
  uc->uc_mcontext.gregs[REG_RIP] = (greg_t)target;
  return true;
#elif defined(__linux__) && defined(__aarch64__)
  uintptr_t sp = stack ? stack : (uintptr_t)uc->uc_mcontext.sp - 256;
  sp &= ~(uintptr_t)15;
  uc->uc_mcontext.sp = sp;
  uc->uc_mcontext.regs[0] = (uint64_t)(uint32_t)code;
  uc->uc_mcontext.regs[30] = target;
  uc->uc_mcontext.pc = target;
  return true;
#else
  (void)uc;
  (void)target;
  (void)code;
  (void)stack;
  return false;
#endif
}

static uintptr_t scr_wasm_context_sp(void *context) {
  ucontext_t *uc = context;
#if defined(__APPLE__) && defined(__x86_64__)
  return (uintptr_t)uc->uc_mcontext->__ss.__rsp;
#elif defined(__APPLE__) && defined(__aarch64__)
  return (uintptr_t)__darwin_arm_thread_state64_get_sp(uc->uc_mcontext->__ss);
#elif defined(__linux__) && defined(__x86_64__)
  return (uintptr_t)uc->uc_mcontext.gregs[REG_RSP];
#elif defined(__linux__) && defined(__aarch64__)
  return (uintptr_t)uc->uc_mcontext.sp;
#else
  (void)uc;
  return 0;
#endif
}

static void scr_wasm_chain(int sig, siginfo_t *info, void *context) {
  struct sigaction *prev = sig == SIGBUS ? &scr_wasm_prev_bus : &scr_wasm_prev_segv;
  if (prev->sa_flags & SA_SIGINFO) {
    if (prev->sa_sigaction) {
      prev->sa_sigaction(sig, info, context);
      return;
    }
  } else if (prev->sa_handler != SIG_DFL && prev->sa_handler != SIG_IGN) {
    prev->sa_handler(sig);
    return;
  }
  /* The default action: restore it and let the faulting instruction run
   * again, so the process dies of the original signal. */
  sigaction(sig, prev, NULL);
}

static void scr_wasm_fault(int sig, siginfo_t *info, void *context) {
  if (scr_wasm_running && scr_wasm_top) {
    uintptr_t addr = (uintptr_t)info->si_addr;
    for (size_t i = 0; i < scr_wasm_range_count; i++) {
      if (addr >= scr_wasm_ranges[i].start && addr < scr_wasm_ranges[i].end) {
        if (scr_wasm_redirect(context, SCR_WASM_TRAP_MEMORY_OOB, 0)) return;
      }
    }
    uintptr_t sp = scr_wasm_context_sp(context);
    if (sp && addr + 65536 >= sp && addr <= sp + 65536) {
      /* Stack exhaustion: resume below the export entry's frame, over the
       * abandoned translated frames. */
      uintptr_t below = scr_wasm_top->frame - 4096;
      if (scr_wasm_redirect(context, SCR_WASM_TRAP_EXHAUSTION, below)) return;
    }
  }
  scr_wasm_chain(sig, info, context);
}

static void scr_wasm_install_handler(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = scr_wasm_fault;
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
  sigemptyset(&sa.sa_mask);
  if (sigaction(SIGSEGV, &sa, &scr_wasm_prev_segv) == 0 && sigaction(SIGBUS, &sa, &scr_wasm_prev_bus) == 0)
    scr_wasm_handler_installed = true;
}

/* The thread's own stack, which the system ends with a guard page. */
static _Thread_local uintptr_t scr_wasm_thread_low, scr_wasm_thread_high;
/* The stack guard of the last stack an outermost export call ran on. */
static _Thread_local uintptr_t scr_wasm_guarded_stack;

/* Async fibers run on SCR_FIBER_STACK-byte mappings without a guard page
 * (compiled code checks scr_stack_guard instead), so recursion in
 * translated code there would run past the mapping. The first export call
 * on a fiber therefore protects the lowest page of its mapping, which the
 * fault handler then reports as stack exhaustion; scr_stack_guard, which
 * sits scr_stack_guard_for's reserve above that page, locates it. The
 * page stays protected while the runtime reuses the stack. A stack that
 * does not match the fiber layout is left alone. */
static void scr_wasm_guard_fiber(uintptr_t frame) {
  if (!scr_wasm_handler_installed) return;
  uintptr_t guard = scr_stack_guard;
  if (!guard || guard == scr_wasm_guarded_stack) return;
  scr_wasm_guarded_stack = guard;
  if (!scr_wasm_thread_high) {
#if defined(__APPLE__)
    pthread_t self = pthread_self();
    scr_wasm_thread_high = (uintptr_t)pthread_get_stackaddr_np(self);
    scr_wasm_thread_low = scr_wasm_thread_high - pthread_get_stacksize_np(self);
#else
    pthread_attr_t attr;
    if (pthread_getattr_np(pthread_self(), &attr) == 0) {
      void *addr;
      size_t size;
      if (pthread_attr_getstack(&attr, &addr, &size) == 0) {
        scr_wasm_thread_low = (uintptr_t)addr;
        scr_wasm_thread_high = (uintptr_t)addr + size;
      }
      pthread_attr_destroy(&attr);
    }
#endif
  }
  if (frame >= scr_wasm_thread_low && frame < scr_wasm_thread_high) return;
  uintptr_t low = guard - (scr_stack_guard_for(0, SCR_FIBER_STACK));
  long page = sysconf(_SC_PAGESIZE);
  if (page <= 0 || (low & ((uintptr_t)page - 1)) != 0) return;
  if (frame <= low + (uintptr_t)page || frame >= low + SCR_FIBER_STACK) return;
  (void)mprotect((void *)low, (size_t)page, PROT_NONE);
}

/* Per thread: an alternate signal stack, so exhaustion faults can be
 * handled. A thread that already has one keeps it. */
static void scr_wasm_thread_init(void) {
  if (scr_wasm_altstack_ready || !scr_wasm_handler_installed) return;
  scr_wasm_altstack_ready = true;
  stack_t current;
  if (sigaltstack(NULL, &current) == 0 && !(current.ss_flags & SS_DISABLE) && current.ss_size >= 32768) return;
  size_t size = 65536;
  void *mem = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (mem == MAP_FAILED) return;
  stack_t ss = {.ss_sp = mem, .ss_size = size, .ss_flags = 0};
  sigaltstack(&ss, NULL);
}
#endif

/* Checked memories (explicit bounds checks, no guard pages) keep one base
 * address for their whole life: the ArrayBuffer of `memory.buffer` and
 * every view of it alias the storage, so growing must not move it. The
 * address space for the memory's largest size is reserved once and pages
 * are committed as the memory grows. Hosts without address-space
 * reservation (WASI) move the storage only while no buffer has been
 * handed out; after that, growth that would move it fails (-1, a
 * RangeError for Memory.prototype.grow). */
#if defined(_WIN32)
#define SCR_WASM_STABLE_RESERVE 1
static uint8_t *scr_wasm_reserve(uint64_t bytes) {
  return VirtualAlloc(NULL, (SIZE_T)bytes, MEM_RESERVE, PAGE_NOACCESS);
}
static bool scr_wasm_commit(uint8_t *base, uint64_t from, uint64_t to) {
  return to == from || VirtualAlloc(base + from, (SIZE_T)(to - from), MEM_COMMIT, PAGE_READWRITE) != NULL;
}
static void scr_wasm_unreserve(ScrWasmMemory *m) {
  if (m->base) VirtualFree(m->base, 0, MEM_RELEASE);
}
#elif !defined(__wasi__)
#define SCR_WASM_STABLE_RESERVE 1
static uint8_t *scr_wasm_reserve(uint64_t bytes) {
#if !defined(MAP_NORESERVE)
#define MAP_NORESERVE 0
#endif
  void *base = mmap(NULL, bytes, PROT_NONE, MAP_PRIVATE | MAP_ANON | MAP_NORESERVE, -1, 0);
  return base == MAP_FAILED ? NULL : base;
}
static bool scr_wasm_commit(uint8_t *base, uint64_t from, uint64_t to) {
  return to == from || mprotect(base + from, to - from, PROT_READ | PROT_WRITE) == 0;
}
static void scr_wasm_unreserve(ScrWasmMemory *m) {
  if (m->base) munmap(m->base, m->reserved);
}
#else
static void scr_wasm_unreserve(ScrWasmMemory *m) { free(m->base); }
#endif

static ScrWasmMemory *scr_wasm_memory_retain(ScrWasmMemory *m) {
  m->rc++;
  return m;
}

/* True when JavaScript holds none of the memory's ArrayBuffers or views
 * over them: each byte store's only reference is the memory's own. */
static bool scr_wasm_memory_unexposed(const ScrWasmMemory *m) {
  for (size_t i = 0; i < m->exposed_count; i++)
    if (m->exposed[i]->rc != 1) return false;
  return true;
}

static void scr_wasm_memory_free(ScrWasmMemory *m) {
  for (size_t i = 0; i < m->exposed_count; i++) scr_bytes_release(m->exposed[i]);
  free(m->exposed);
#if SCR_WASM_SIGNALS
  if (m->guarded) {
    scr_wasm_range_remove(m->base);
    munmap(m->base, m->reserved);
  } else
#endif
    scr_wasm_unreserve(m);
  free(m);
}

/* Released memories whose storage JavaScript still reaches through a
 * buffer; freed once it no longer does (checked whenever a memory is
 * created or released). */
static _Thread_local ScrWasmMemory *scr_wasm_parked;

static void scr_wasm_sweep_parked(void) {
  for (ScrWasmMemory **p = &scr_wasm_parked; *p;) {
    ScrWasmMemory *m = *p;
    if (scr_wasm_memory_unexposed(m)) {
      *p = m->next_parked;
      scr_wasm_memory_free(m);
    } else {
      p = &m->next_parked;
    }
  }
}

static void scr_wasm_memory_release(ScrWasmMemory *m) {
  if (!m || --m->rc) return;
  scr_dyn_release(m->buffer);
  m->buffer = NULL;
  scr_wasm_sweep_parked();
  if (scr_wasm_memory_unexposed(m)) {
    scr_wasm_memory_free(m);
  } else {
    m->next_parked = scr_wasm_parked;
    scr_wasm_parked = m;
  }
}

/* A memory of `min` pages growing to at most `max` pages (UINT64_MAX:
 * no declared maximum); NULL with Node's RangeError pending when the
 * address space or memory is short. */
static ScrWasmMemory *scr_wasm_memory_new(uint64_t min, uint64_t max, bool guarded, const char *what) {
  if (scr_wasm_parked) scr_wasm_sweep_parked();
  ScrWasmMemory *m = calloc(1, sizeof *m);
  if (!m) scr_trap("scriptc: out of memory\n");
  m->rc = 1;
  m->declared_max = max;
  m->max_pages = max > SCR_WASM_MAX_PAGES ? SCR_WASM_MAX_PAGES : max;
  m->size = min * SCR_WASM_PAGE;
#if SCR_WASM_SIGNALS
  if (guarded) {
#if !defined(MAP_NORESERVE)
#define MAP_NORESERVE 0
#endif
    void *base = mmap(NULL, SCR_WASM_GUARD_RESERVATION, PROT_NONE, MAP_PRIVATE | MAP_ANON | MAP_NORESERVE, -1, 0);
    if (base == MAP_FAILED ||
        (m->size && mprotect(base, m->size, PROT_READ | PROT_WRITE) != 0)) {
      if (base != MAP_FAILED) munmap(base, SCR_WASM_GUARD_RESERVATION);
      free(m);
      char msg[200];
      snprintf(msg, sizeof msg, "%s: Out of memory: Cannot allocate Wasm memory for new instance", what);
      scr_wasm_range_error(msg);
      return NULL;
    }
    m->base = base;
    m->reserved = SCR_WASM_GUARD_RESERVATION;
    m->guarded = true;
    scr_wasm_range_add(m->base, m->reserved);
    return m;
  }
#else
  (void)guarded;
#endif
#if SCR_WASM_STABLE_RESERVE
  uint64_t reserve = m->max_pages * SCR_WASM_PAGE;
  m->base = reserve ? scr_wasm_reserve(reserve) : NULL;
  if (reserve && (!m->base || !scr_wasm_commit(m->base, 0, m->size))) {
    if (m->base) {
      m->reserved = reserve;
      scr_wasm_unreserve(m);
    }
#else
  m->base = m->size ? calloc(1, m->size) : NULL;
  if (m->size && !m->base) {
#endif
    free(m);
    char msg[200];
    snprintf(msg, sizeof msg, "%s: Out of memory: Cannot allocate Wasm memory for new instance", what);
    scr_wasm_range_error(msg);
    return NULL;
  }
#if SCR_WASM_STABLE_RESERVE
  m->reserved = reserve;
#else
  m->reserved = m->size;
#endif
  return m;
}

/* Grows by `delta` pages; answers the previous page count or -1. */
static int64_t scr_wasm_memory_grow_by(ScrWasmMemory *m, uint64_t delta) {
  uint64_t old = m->size / SCR_WASM_PAGE;
  if (delta > m->max_pages || old + delta > m->max_pages) return -1;
  if (delta == 0) return (int64_t)old;
  uint64_t size = (old + delta) * SCR_WASM_PAGE;
#if SCR_WASM_SIGNALS
  if (m->guarded) {
    if (mprotect(m->base + m->size, size - m->size, PROT_READ | PROT_WRITE) != 0) return -1;
    m->size = size;
    return (int64_t)old;
  }
#endif
#if SCR_WASM_STABLE_RESERVE
  /* Committed pages read as zero; the base never moves. */
  if (size > m->reserved || !scr_wasm_commit(m->base, m->size, size)) return -1;
  m->size = size;
#else
  /* A buffer handed out aliases the storage: moving it would leave the
   * buffer's views reading freed memory. */
  if (m->buffer_exposed) return -1;
  uint8_t *grown = realloc(m->base, size);
  if (!grown) return -1;
  memset(grown + m->size, 0, size - m->size);
  m->base = grown;
  m->reserved = size;
  m->size = size;
#endif
  return (int64_t)old;
}

static ScrWasmMemory *scr_wasm_inst_memory(void *inst) { return ((ScrWasmMemory **)inst)[2]; }

int32_t scr_wasm_memory_grow(void *inst, int32_t delta) {
  ScrWasmMemory *m = scr_wasm_inst_memory(inst);
  int64_t old = scr_wasm_memory_grow_by(m, (uint32_t)delta);
  ((void **)inst)[1] = m->base;
  return (int32_t)old;
}

static void scr_wasm_check_memory(ScrWasmMemory *m, uint32_t at, uint32_t n) {
  if ((uint64_t)at + n > m->size) scr_wasm_trap(SCR_WASM_TRAP_MEMORY_OOB);
}

void scr_wasm_memory_fill(void *inst, int32_t d, int32_t value, int32_t n) {
  ScrWasmMemory *m = scr_wasm_inst_memory(inst);
  scr_wasm_check_memory(m, (uint32_t)d, (uint32_t)n);
  if (n) memset(m->base + (uint32_t)d, value & 0xff, (uint32_t)n);
}

void scr_wasm_memory_copy(void *inst, int32_t d, int32_t s, int32_t n) {
  ScrWasmMemory *m = scr_wasm_inst_memory(inst);
  scr_wasm_check_memory(m, (uint32_t)d, (uint32_t)n);
  scr_wasm_check_memory(m, (uint32_t)s, (uint32_t)n);
  if (n) memmove(m->base + (uint32_t)d, m->base + (uint32_t)s, (uint32_t)n);
}

/* Instantiation reports an active data segment's failure with its
 * details (V8's "data segment N is out of bounds (offset ...)"). */
static _Thread_local bool scr_wasm_instantiating;
static _Thread_local struct {
  uint32_t seg, offset, length;
  uint64_t size;
} scr_wasm_segment_failure;

void scr_wasm_memory_init(void *inst, int32_t seg, int32_t d, int32_t s, int32_t n) {
  ScrWasmInst *host = scr_wasm_host_of(inst);
  const ScrWasmDataDesc *data = &host->desc->datas[seg];
  uint64_t len = host->data_dropped[seg] ? 0 : data->len;
  ScrWasmMemory *m = scr_wasm_inst_memory(inst);
  if ((uint64_t)(uint32_t)s + (uint32_t)n > len || (uint64_t)(uint32_t)d + (uint32_t)n > m->size) {
    if (scr_wasm_instantiating) {
      scr_wasm_segment_failure.seg = (uint32_t)seg;
      scr_wasm_segment_failure.offset = (uint32_t)d;
      scr_wasm_segment_failure.length = (uint32_t)n;
      scr_wasm_segment_failure.size = m->size;
      scr_wasm_trap(SCR_WASM_TRAP_DATA_SEGMENT);
    }
    scr_wasm_trap(SCR_WASM_TRAP_MEMORY_OOB);
  }
  if (n) memcpy(m->base + (uint32_t)d, data->data + (uint32_t)s, (uint32_t)n);
}

void scr_wasm_data_drop(void *inst, int32_t seg) { scr_wasm_host_of(inst)->data_dropped[seg] = true; }

/* ── tables ──────────────────────────────────────────────────────────── */

static ScrWasmTable *scr_wasm_table_new(char elem, uint64_t min, uint64_t max) {
  ScrWasmTable *t = calloc(1, sizeof *t);
  if (!t) scr_trap("scriptc: out of memory\n");
  t->rc = 1;
  t->elem = elem;
  t->size = (uint32_t)min;
  t->declared_max = max;
  t->max = max > SCR_WASM_MAX_TABLE ? SCR_WASM_MAX_TABLE : (uint32_t)max;
  t->elems = calloc(min ? min : 1, sizeof *t->elems);
  if (!t->elems) scr_trap("scriptc: out of memory\n");
  return t;
}

static ScrWasmTable *scr_wasm_table_retain(ScrWasmTable *t) {
  t->rc++;
  return t;
}

static void scr_wasm_table_release(ScrWasmTable *t) {
  if (!t || --t->rc) return;
  if (t->elem == 'x')
    for (uint32_t i = 0; i < t->size; i++) scr_dyn_release(t->elems[i]);
  free(t->elems);
  free(t);
}

static void *scr_wasm_ref_retain(char elem, void *v) {
  if (elem == 'x' && v) scr_dyn_retain(v);
  return v;
}

/* The reference a table or global slot drops: while a call runs, the guest
 * may still hold it in a local or on its operand stack (it read the slot
 * before the store), so it stays alive until the outermost call returns. */
static void scr_wasm_drop_ref(ScrDyn *old) {
  if (!old) return;
  if (scr_wasm_top) scr_wasm_keep(old);
  scr_dyn_release(old);
}

static void scr_wasm_table_store(ScrWasmTable *t, uint32_t i, void *v) {
  void *old = t->elems[i];
  t->elems[i] = scr_wasm_ref_retain(t->elem, v);
  if (t->elem == 'x') scr_wasm_drop_ref(old);
}

static ScrWasmTable *scr_wasm_inst_table(void *inst, int32_t t) { return ((ScrWasmTable **)inst)[4 + t]; }

void *scr_wasm_table_get(void *inst, int32_t ti, int32_t i) {
  ScrWasmTable *t = scr_wasm_inst_table(inst, ti);
  if ((uint32_t)i >= t->size) scr_wasm_trap(SCR_WASM_TRAP_TABLE_OOB);
  return t->elems[(uint32_t)i];
}

void scr_wasm_table_set(void *inst, int32_t ti, int32_t i, void *value) {
  ScrWasmTable *t = scr_wasm_inst_table(inst, ti);
  if ((uint32_t)i >= t->size) scr_wasm_trap(SCR_WASM_TRAP_TABLE_OOB);
  scr_wasm_table_store(t, (uint32_t)i, value);
}

static int64_t scr_wasm_table_grow_by(ScrWasmTable *t, uint32_t n, void *init) {
  uint32_t old = t->size;
  if ((uint64_t)old + n > t->max) return -1;
  if (n == 0) return old;
  void **grown = realloc(t->elems, ((size_t)old + n) * sizeof *grown);
  if (!grown) return -1;
  t->elems = grown;
  for (uint32_t i = 0; i < n; i++) grown[old + i] = scr_wasm_ref_retain(t->elem, init);
  t->size = old + n;
  return old;
}

int32_t scr_wasm_table_grow(void *inst, int32_t ti, void *init, int32_t n) {
  return (int32_t)scr_wasm_table_grow_by(scr_wasm_inst_table(inst, ti), (uint32_t)n, init);
}

void scr_wasm_table_fill(void *inst, int32_t ti, int32_t i, void *value, int32_t n) {
  ScrWasmTable *t = scr_wasm_inst_table(inst, ti);
  if ((uint64_t)(uint32_t)i + (uint32_t)n > t->size) scr_wasm_trap(SCR_WASM_TRAP_TABLE_OOB);
  for (uint32_t k = 0; k < (uint32_t)n; k++) scr_wasm_table_store(t, (uint32_t)i + k, value);
}

void scr_wasm_table_copy(void *inst, int32_t dti, int32_t sti, int32_t d, int32_t s, int32_t n) {
  ScrWasmTable *dt = scr_wasm_inst_table(inst, dti), *st = scr_wasm_inst_table(inst, sti);
  uint32_t ud = (uint32_t)d, us = (uint32_t)s, un = (uint32_t)n;
  if ((uint64_t)ud + un > dt->size || (uint64_t)us + un > st->size) scr_wasm_trap(SCR_WASM_TRAP_TABLE_OOB);
  if (ud <= us) {
    for (uint32_t k = 0; k < un; k++) scr_wasm_table_store(dt, ud + k, st->elems[us + k]);
  } else {
    for (uint32_t k = un; k-- > 0;) scr_wasm_table_store(dt, ud + k, st->elems[us + k]);
  }
}

static void *scr_wasm_elem_item(ScrWasmInst *host, int64_t item) {
  if (item >= 0) return &host->funcrefs[item];
  if (item == -1) return NULL;
  return (void *)(uintptr_t)host->globals[-(item + 2)]->value;
}

void scr_wasm_table_init(void *inst, int32_t ti, int32_t seg, int32_t d, int32_t s, int32_t n) {
  ScrWasmInst *host = scr_wasm_host_of(inst);
  ScrWasmTable *t = scr_wasm_inst_table(inst, ti);
  const ScrWasmElemDesc *e = &host->desc->elems[seg];
  uint64_t len = host->elem_dropped[seg] ? 0 : e->count;
  uint32_t ud = (uint32_t)d, us = (uint32_t)s, un = (uint32_t)n;
  if ((uint64_t)ud + un > t->size) scr_wasm_trap(SCR_WASM_TRAP_TABLE_OOB);
  if ((uint64_t)us + un > len) scr_wasm_trap(SCR_WASM_TRAP_ELEM_SEGMENT);
  for (uint32_t k = 0; k < un; k++) scr_wasm_table_store(t, ud + k, scr_wasm_elem_item(host, e->items[us + k]));
}

void scr_wasm_elem_drop(void *inst, int32_t seg) { scr_wasm_host_of(inst)->elem_dropped[seg] = true; }

/* ── globals ─────────────────────────────────────────────────────────── */

static ScrWasmGlobal *scr_wasm_global_new(char type, bool mutable_) {
  ScrWasmGlobal *g = calloc(1, sizeof *g);
  if (!g) scr_trap("scriptc: out of memory\n");
  g->rc = 1;
  g->type = type;
  g->mutable_ = mutable_;
  return g;
}

static ScrWasmGlobal *scr_wasm_global_retain(ScrWasmGlobal *g) {
  g->rc++;
  return g;
}

static void scr_wasm_global_release(ScrWasmGlobal *g) {
  if (!g || --g->rc) return;
  if (g->type == 'x') scr_dyn_release((ScrDyn *)(uintptr_t)g->value);
  free(g);
}

void scr_wasm_global_set_ref(void *cell, void *value) {
  ScrWasmGlobal *g = cell;
  ScrDyn *old = (ScrDyn *)(uintptr_t)g->value;
  if (value) scr_dyn_retain(value);
  g->value = (uint64_t)(uintptr_t)value;
  scr_wasm_drop_ref(old);
}

/* ── handles ─────────────────────────────────────────────────────────── */

enum { SCR_WASM_K_MODULE, SCR_WASM_K_INSTANCE, SCR_WASM_K_MEMORY, SCR_WASM_K_TABLE, SCR_WASM_K_GLOBAL };

typedef struct ScrWasmObj {
  size_t rc;
  int kind;
  const ScrWasmModuleDesc *desc; /* Module */
  ScrWasmInst *inst;             /* Instance; the owner of exported objects */
  ScrWasmMemory *memory;
  ScrWasmTable *table;
  ScrWasmGlobal *global;
} ScrWasmObj;

/* Instances are never freed yet (stage W6 traces them for the cycle
 * collector), so the references their handles and exported functions hold
 * are not counted. */
static void *scr_wasm_inst_retain(void *p) { return p; }

static void scr_wasm_inst_release(void *p) { (void)p; }

static void *scr_wasm_obj_retain(void *p) {
  ((ScrWasmObj *)p)->rc++;
  return p;
}

static void scr_wasm_obj_release(void *p) {
  ScrWasmObj *o = p;
  if (--o->rc) return;
  if (o->inst) scr_wasm_inst_release(o->inst);
  scr_wasm_memory_release(o->memory);
  scr_wasm_table_release(o->table);
  scr_wasm_global_release(o->global);
  free(o);
}

static ScrWasmObj *scr_wasm_obj_new(int kind) {
  ScrWasmObj *o = calloc(1, sizeof *o);
  if (!o) scr_trap("scriptc: out of memory\n");
  o->rc = 1;
  o->kind = kind;
  return o;
}

static ScrDyn *scr_wasm_empty_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

static const ScrDynHandleTag scr_wasm_tags[] = {SCR_DYNH_WASM_MODULE, SCR_DYNH_WASM_INSTANCE, SCR_DYNH_WASM_MEMORY,
                                                SCR_DYNH_WASM_TABLE, SCR_DYNH_WASM_GLOBAL};

static void scr_wasm_install(void);

static ScrDyn *scr_wasm_box(ScrWasmObj *o) {
  scr_wasm_install();
  ScrDyn *d = scr_dyn_new_handle(o, scr_wasm_tags[o->kind]);
  scr_wasm_obj_release(o);
  return d;
}

static ScrWasmObj *scr_wasm_unbox(const ScrDyn *v, int kind) {
  if (!v || v->kind != SCR_DYN_HANDLE || v->v.handle.tag != scr_wasm_tags[kind]) return NULL;
  return v->v.handle.ptr;
}

/* ── values ──────────────────────────────────────────────────────────── */

static ScrDyn *scr_wasm_function_value(ScrWasmInst *host, uint32_t func);

/* ToJSValue (+1; NULL with an exception pending). */
static ScrDyn *scr_wasm_to_js(char t, uint64_t v) {
  switch (t) {
    case 'i': return scr_dyn_new_num((double)(int32_t)(uint32_t)v);
    case 'I': {
      ScrBigInt *b = scr_bigint_from_i64((int64_t)v);
      ScrDyn *d = scr_dyn_new_bigint(b);
      scr_bigint_release(b);
      return d;
    }
    case 'f': {
      uint32_t bits = (uint32_t)v;
      float f;
      memcpy(&f, &bits, 4);
      return scr_dyn_new_num((double)f);
    }
    case 'F': {
      double d;
      memcpy(&d, &v, 8);
      return scr_dyn_new_num(d);
    }
    case 'r': {
      ScrWasmFuncRef *ref = (ScrWasmFuncRef *)(uintptr_t)v;
      if (!ref) return scr_dyn_new_null();
      ScrWasmInst *host = scr_wasm_host_of(ref->inst);
      return scr_wasm_function_value(host, (uint32_t)(ref - host->funcrefs));
    }
    default: {
      ScrDyn *d = (ScrDyn *)(uintptr_t)v;
      return d ? scr_dyn_retain(d) : scr_dyn_new_null();
    }
  }
}

static uint32_t scr_wasm_to_int32(double n) {
  if (!isfinite(n)) return 0;
  double t = trunc(n);
  double m = fmod(t, 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (uint32_t)m;
}

static ScrWasmFuncRef *scr_wasm_funcref_of(const ScrDyn *v);

/* V8's message for a value that is neither null nor an exported
 * WebAssembly function where a funcref is expected (behind a prefix that
 * names the operation). */
#define SCR_WASM_FUNCREF_EXPECTED "function-typed object must be null (if nullable) or a Wasm function object"

/* ToWebAssemblyValue: false with an exception pending. References are
 * borrowed from `v`. A funcref mismatch throws a TypeError with
 * `funcref_error` (the export-call message when NULL). */
static bool scr_wasm_from_js_as(char t, const ScrDyn *v, uint64_t *out, const char *funcref_error) {
  if (!v) v = scr_dyn_undefined();
  switch (t) {
    case 'i': {
      double n;
      if (!scr_dyn_number_coerce_js(v, &n)) return false;
      *out = scr_wasm_to_int32(n);
      return true;
    }
    case 'f': {
      double n;
      if (!scr_dyn_number_coerce_js(v, &n)) return false;
      float f = (float)n;
      uint32_t b;
      memcpy(&b, &f, 4);
      *out = b;
      return true;
    }
    case 'F': {
      double n;
      if (!scr_dyn_number_coerce_js(v, &n)) return false;
      memcpy(out, &n, 8);
      return true;
    }
    case 'I': {
      ScrBigInt *b = scr_dyn_bigint_coerce(v);
      if (!b) return false;
      *out = (uint64_t)scr_bigint_to_i64(b);
      scr_bigint_release(b);
      return true;
    }
    case 'r': {
      if (v->kind == SCR_DYN_NULL) {
        *out = 0;
        return true;
      }
      ScrWasmFuncRef *ref = scr_wasm_funcref_of(v);
      if (!ref) {
        scr_wasm_type_error(funcref_error ? funcref_error : "type incompatibility when transforming from/to JS");
        return false;
      }
      *out = (uint64_t)(uintptr_t)ref;
      return true;
    }
    default:
      if (v->kind == SCR_DYN_NULL) {
        *out = 0;
        return true;
      }
      *out = (uint64_t)(uintptr_t)v;
      return true;
  }
}

static bool scr_wasm_from_js(char t, const ScrDyn *v, uint64_t *out) { return scr_wasm_from_js_as(t, v, out, NULL); }

/* DefaultValue(type): what a missing initial value of a constructed
 * global or table, or a missing table.grow/set value, stands for. */
static uint64_t scr_wasm_default_value(char t) {
  return t == 'x' ? (uint64_t)(uintptr_t)scr_dyn_undefined() : 0;
}

static size_t scr_wasm_params(const char *sig) {
  size_t n = 0;
  while (sig[n] && sig[n] != ':') n++;
  return n;
}

/* ── exported functions ──────────────────────────────────────────────── */

typedef struct {
  ScrWasmInst *host;
  uint32_t func;
  ScrWasmThunk thunk;
} ScrWasmExportCtx;

static ScrDyn *scr_wasm_export_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrWasmInst *host = scr_box_get_ref(clo->caps[0]);
  uint32_t func = (uint32_t)scr_box_get_f64(clo->caps[1]);
  const char *sig = host->desc->func_sigs[func];
  ScrWasmThunk thunk = NULL;
  for (uint64_t i = 0; i < host->desc->export_count; i++) {
    const ScrWasmExportDesc *ex = &host->desc->exports[i];
    if (ex->kind == SCR_WASM_FUNC && ex->index == func) {
      thunk = ex->call;
      break;
    }
  }
  size_t np = scr_wasm_params(sig);
  const char *res = sig[np] == ':' ? sig + np + 1 : "";
  size_t nr = strlen(res);
  uint64_t stack_args[16], stack_res[8] = {0};
  uint64_t *a = np <= 16 ? stack_args : malloc(np * sizeof *a);
  uint64_t *r = nr <= 8 ? stack_res : calloc(nr, sizeof *r);
  if (!a || !r) scr_trap("scriptc: out of memory\n");
  ScrDyn *result = NULL;
  bool ok = true;
  for (size_t i = 0; i < np && ok; i++) ok = scr_wasm_from_js(sig[i], i < argc ? args[i] : NULL, &a[i]);
  if (ok) {
    /* A function the module does not export runs through its signature's
     * call thunk, on the code its reference record names. */
    int trap = thunk ? scr_wasm_enter(thunk, host->inst, a, r)
                     : scr_wasm_enter_ref(NULL, host->desc->func_call_thunks[func], host->funcrefs[func].code,
                                          host->inst, a, r);
    if (trap) {
      scr_wasm_throw_trap(trap);
    } else if (nr == 0) {
      result = scr_dyn_retain(scr_dyn_undefined());
    } else if (nr == 1) {
      result = scr_wasm_to_js(res[0], r[0]);
    } else {
      result = scr_dyn_new_arr();
      for (size_t i = 0; i < nr; i++) scr_dyn_arr_push(result, scr_wasm_to_js(res[i], r[i]));
    }
    scr_wasm_leave();
  }
  if (a != stack_args) free(a);
  if (r != stack_res) free(r);
  scr_wasm_inst_release(host);
  return result;
}

/* The function value of function `func` (+1), created once per instance
 * and function: exported functions call through their export thunk, other
 * referenced functions through their signature's call thunk. */
static ScrDyn *scr_wasm_function_value(ScrWasmInst *host, uint32_t func) {
  if (host->export_fns[func]) return scr_dyn_retain(host->export_fns[func]);
  bool callable = host->desc->func_call_thunks[func] != NULL && host->funcrefs[func].code != NULL;
  for (uint64_t i = 0; i < host->desc->export_count && !callable; i++) {
    const ScrWasmExportDesc *ex = &host->desc->exports[i];
    if (ex->kind == SCR_WASM_FUNC && ex->index == func) callable = true;
  }
  if (!callable) {
    /* Unreachable for valid modules: every function a reference can name
     * is exported or has a call thunk. */
    scr_wasm_type_error("type incompatibility when transforming from/to JS");
    return NULL;
  }
  char name[24];
  snprintf(name, sizeof name, "%u", func);
  size_t name_len = strlen(name) + 1;
  host->export_names[func] = malloc(name_len);
  if (!host->export_names[func]) scr_trap("scriptc: out of memory\n");
  memcpy(host->export_names[func], name, name_len);
  ScrClosure *closure = scr_closure_new(NULL, 2);
  closure->caps[0] = scr_box_new_obj(scr_wasm_inst_retain, scr_wasm_inst_release, NULL);
  scr_box_set_ref(closure->caps[0], scr_wasm_inst_retain(host));
  closure->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[1], (double)func);
  uint32_t arity = (uint32_t)scr_wasm_params(host->desc->func_sigs[func]);
  host->export_fns[func] = scr_dyn_new_func(closure, scr_wasm_export_call, arity, "", host->export_names[func]);
  return scr_dyn_retain(host->export_fns[func]);
}

static ScrWasmFuncRef *scr_wasm_funcref_of(const ScrDyn *v) {
  if (!v || v->kind != SCR_DYN_FUNC || v->v.fn.thunk != scr_wasm_export_call) return NULL;
  ScrClosure *clo = v->v.fn.clo;
  ScrWasmInst *host = scr_box_get_ref(clo->caps[0]);
  uint32_t func = (uint32_t)scr_box_get_f64(clo->caps[1]);
  scr_wasm_inst_release(host);
  return &host->funcrefs[func];
}

/* ── imported functions ──────────────────────────────────────────────── */

void scr_wasm_import_call(void *hostp, int32_t index, const uint64_t *args, uint64_t *results) {
  ScrWasmInst *host = hostp;
  const char *sig = host->desc->func_sigs[index];
  size_t np = scr_wasm_params(sig);
  ScrDyn *stack_argv[16];
  ScrDyn **argv = np <= 16 ? stack_argv : malloc(np * sizeof *argv);
  if (!argv) scr_trap("scriptc: out of memory\n");
  bool ok = true;
  size_t made = 0;
  for (; made < np; made++) {
    argv[made] = scr_wasm_to_js(sig[made], args[made]);
    if (!argv[made]) {
      ok = false;
      break;
    }
  }
  scr_wasm_running = false;
  ScrDyn *res = NULL;
  if (ok) {
    scr_dyn_this_push_dyn(scr_dyn_undefined());
    res = scr_dyn_call(host->funcs[index], argv, np, "WebAssembly import");
    scr_dyn_this_pop();
  }
  for (size_t i = 0; i < made; i++) scr_dyn_release(argv[i]);
  if (argv != stack_argv) free(argv);
  if (res) {
    const char *want = sig[np] == ':' ? sig + np + 1 : "";
    size_t nr = strlen(want);
    if (nr == 1) {
      ok = scr_wasm_from_js(want[0], res, &results[0]);
      if (ok && want[0] == 'x' && results[0]) scr_wasm_keep((ScrDyn *)(uintptr_t)results[0]);
    } else if (nr > 1) {
      for (size_t i = 0; ok && i < nr; i++) {
        ScrDyn *item = scr_dyn_index_get(res, (double)i);
        ok = item && scr_wasm_from_js(want[i], item, &results[i]);
        if (ok && want[i] == 'x' && results[i]) scr_wasm_keep((ScrDyn *)(uintptr_t)results[i]);
        scr_dyn_release(item);
      }
    }
    scr_dyn_release(res);
  } else {
    ok = false;
  }
  if (!ok) scr_wasm_trap(SCR_WASM_TRAP_HOST);
  scr_wasm_running = true;
}

/* ── handle members ──────────────────────────────────────────────────── */

static ScrDyn *scr_wasm_memory_buffer(ScrWasmMemory *m) {
  /* memory.grow in translated code changes the size without telling the
   * cached buffer. */
  if (m->buffer && m->buffer_size != m->size) {
    scr_dyn_release(m->buffer);
    m->buffer = NULL;
  }
  if (!m->buffer) {
    m->buffer_exposed = true;
    m->buffer_size = m->size;
    ScrBytes *bytes = scr_bytes_from_external(m->base, (size_t)m->size);
    /* Earlier buffers JavaScript no longer holds need no tracking. */
    size_t kept = 0;
    for (size_t i = 0; i < m->exposed_count; i++) {
      if (m->exposed[i]->rc == 1) scr_bytes_release(m->exposed[i]);
      else m->exposed[kept++] = m->exposed[i];
    }
    m->exposed_count = kept;
    ScrBytes **grown = realloc(m->exposed, (m->exposed_count + 1) * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    m->exposed = grown;
    m->exposed[m->exposed_count++] = bytes; /* the memory's reference */
    m->buffer = scr_array_buffer_from_bytes(bytes);
  }
  return scr_dyn_retain(m->buffer);
}

static ScrDyn *scr_wasm_global_value(ScrWasmGlobal *g) { return scr_wasm_to_js(g->type, g->value); }

static ScrDyn *scr_wasm_get(void *h, const char *key, size_t len) {
  ScrWasmObj *o = h;
  switch (o->kind) {
    case SCR_WASM_K_INSTANCE:
      if (len == 7 && !memcmp(key, "exports", 7)) return scr_dyn_retain(o->inst->exports);
      return NULL;
    case SCR_WASM_K_MEMORY:
      if (len == 6 && !memcmp(key, "buffer", 6)) return scr_wasm_memory_buffer(o->memory);
      return NULL;
    case SCR_WASM_K_TABLE:
      if (len == 6 && !memcmp(key, "length", 6)) return scr_dyn_new_num(o->table->size);
      return NULL;
    case SCR_WASM_K_GLOBAL:
      if (len == 5 && !memcmp(key, "value", 5)) return scr_wasm_global_value(o->global);
      return NULL;
    default:
      return NULL;
  }
}

static bool scr_wasm_global_assign(ScrWasmGlobal *g, const ScrDyn *value) {
  if (!g->mutable_) {
    scr_wasm_type_error("set WebAssembly.Global.value): Can't set the value of an immutable global.");
    return false;
  }
  uint64_t v;
  if (!scr_wasm_from_js_as(g->type, value, &v, "set WebAssembly.Global.value): " SCR_WASM_FUNCREF_EXPECTED))
    return false;
  if (g->type == 'x') scr_wasm_global_set_ref(g, (void *)(uintptr_t)v);
  else g->value = v;
  return true;
}

static bool scr_wasm_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  ScrWasmObj *o = h;
  if (o->kind == SCR_WASM_K_GLOBAL && len == 5 && !memcmp(key, "value", 5)) {
    scr_wasm_global_assign(o->global, value);
    return true;
  }
  return false;
}

/* V8's EnforceUint32: ToNumber (its own TypeError for symbols and
 * BigInts), then finite, non-negative and at most 2^32-1, truncated.
 * `what` names the value ("WebAssembly.Memory.grow(): Argument 0",
 * "WebAssembly.Memory(): Property 'initial'"). */
static bool scr_wasm_u32_arg(const ScrDyn *v, const char *what, uint32_t *out) {
  double n;
  if (!scr_dyn_number_coerce_js(v ? v : scr_dyn_undefined(), &n)) return false;
  const char *problem = !isfinite(n)              ? "must be convertible to a valid number"
                        : n < 0                   ? "must be non-negative"
                        : trunc(n) > 4294967295.0 ? "must be in the unsigned long range"
                                                  : NULL;
  if (problem) {
    char msg[200];
    snprintf(msg, sizeof msg, "%s %s", what, problem);
    scr_wasm_type_error(msg);
    return false;
  }
  *out = (uint32_t)trunc(n);
  return true;
}

static ScrDyn *scr_wasm_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                               const char *what) {
  (void)self;
  ScrWasmObj *o = h;
  if (o->kind == SCR_WASM_K_MEMORY && !strcmp(method, "grow")) {
    uint32_t delta;
    if (!scr_wasm_u32_arg(argc ? args[0] : NULL, "WebAssembly.Memory.grow(): Argument 0", &delta)) return NULL;
    int64_t old = scr_wasm_memory_grow_by(o->memory, delta);
    if (old < 0) {
      scr_wasm_range_error("WebAssembly.Memory.grow(): Maximum memory size exceeded");
      return NULL;
    }
    if (o->inst && o->inst->memory == o->memory) o->inst->inst[1] = o->memory->base;
    /* The previous buffer keeps its length (no detachment). */
    scr_dyn_release(o->memory->buffer);
    o->memory->buffer = NULL;
    return scr_dyn_new_num((double)old);
  }
  if (o->kind == SCR_WASM_K_TABLE) {
    ScrWasmTable *t = o->table;
    uint32_t index = 0;
    uint64_t value = 0;
    if (!strcmp(method, "get")) {
      if (!scr_wasm_u32_arg(argc ? args[0] : NULL, "WebAssembly.Table.get(): Argument 0", &index)) return NULL;
      if (index >= t->size) {
        char msg[160];
        snprintf(msg, sizeof msg, "WebAssembly.Table.get(): invalid address %u in %s table of size %u", index,
                 t->elem == 'x' ? "externref" : "funcref", t->size);
        scr_wasm_range_error(msg);
        return NULL;
      }
      return scr_wasm_to_js(t->elem, (uint64_t)(uintptr_t)t->elems[index]);
    }
    if (!strcmp(method, "set")) {
      if (!scr_wasm_u32_arg(argc ? args[0] : NULL, "WebAssembly.Table.set(): Argument 0", &index)) return NULL;
      if (index >= t->size) {
        char msg[160];
        snprintf(msg, sizeof msg, "WebAssembly.Table.set(): invalid address %u in %s table of size %u", index,
                 t->elem == 'x' ? "externref" : "funcref", t->size);
        scr_wasm_range_error(msg);
        return NULL;
      }
      if (argc > 1) {
        if (!scr_wasm_from_js_as(t->elem, args[1], &value,
                                 "WebAssembly.Table.set(): Argument 1 is invalid for table: " SCR_WASM_FUNCREF_EXPECTED))
          return NULL;
      } else {
        value = scr_wasm_default_value(t->elem);
      }
      scr_wasm_table_store(t, index, (void *)(uintptr_t)value);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    if (!strcmp(method, "grow")) {
      uint32_t delta;
      if (!scr_wasm_u32_arg(argc ? args[0] : NULL, "WebAssembly.Table.grow(): Argument 0", &delta)) return NULL;
      if (argc > 1) {
        if (!scr_wasm_from_js_as(t->elem, args[1], &value,
                                 "WebAssembly.Table.grow(): Argument 1 is invalid: " SCR_WASM_FUNCREF_EXPECTED))
          return NULL;
      } else {
        value = scr_wasm_default_value(t->elem);
      }
      int64_t old = scr_wasm_table_grow_by(t, delta, (void *)(uintptr_t)value);
      if (old < 0) {
        char msg[160];
        snprintf(msg, sizeof msg, "WebAssembly.Table.grow(): failed to grow table by %u", delta);
        scr_wasm_range_error(msg);
        return NULL;
      }
      return scr_dyn_new_num((double)old);
    }
  }
  if (o->kind == SCR_WASM_K_GLOBAL && !strcmp(method, "valueOf")) return scr_wasm_global_value(o->global);
  char msg[200];
  snprintf(msg, sizeof msg, "%s is not a function", what ? what : method);
  scr_wasm_type_error(msg);
  return NULL;
}

/* Module transfer between threads (postMessage, workerData): a module is
 * immutable code plus its descriptor, so the payload is the descriptor
 * itself, which every thread of the executable shares. */
static void *scr_wasm_module_share(void *h) { return (void *)((ScrWasmObj *)h)->desc; }

static ScrDyn *scr_wasm_module_adopt(void *payload) {
  ScrWasmObj *o = scr_wasm_obj_new(SCR_WASM_K_MODULE);
  o->desc = payload;
  return scr_wasm_box(o);
}

static void scr_wasm_module_drop(void *payload) { (void)payload; }

static const ScrDynHandleTransfer scr_wasm_module_transfer = {
    .share = scr_wasm_module_share, .adopt = scr_wasm_module_adopt, .drop = scr_wasm_module_drop};

#define SCR_WASM_OPS(name, tag, xfer)                                                           \
  static const ScrDynHandleOps scr_wasm_ops_##name = {                                         \
      .cls = #name, .retain = scr_wasm_obj_retain, .release = scr_wasm_obj_release,            \
      .invoke = scr_wasm_invoke, .get = scr_wasm_get, .set = scr_wasm_set,                     \
      .inspect_view = scr_wasm_empty_view, .json_empty_object = true,                          \
      .to_string_tag = tag, .inspect_view_empty = true, .transfer = xfer,                      \
  };
SCR_WASM_OPS(Module, "WebAssembly.Module", &scr_wasm_module_transfer)
SCR_WASM_OPS(Instance, "WebAssembly.Instance", NULL)
SCR_WASM_OPS(Memory, "WebAssembly.Memory", NULL)
SCR_WASM_OPS(Table, "WebAssembly.Table", NULL)
SCR_WASM_OPS(Global, "WebAssembly.Global", NULL)

static void scr_wasm_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_WASM_MODULE, &scr_wasm_ops_Module);
  scr_dyn_handle_install(SCR_DYNH_WASM_INSTANCE, &scr_wasm_ops_Instance);
  scr_dyn_handle_install(SCR_DYNH_WASM_MEMORY, &scr_wasm_ops_Memory);
  scr_dyn_handle_install(SCR_DYNH_WASM_TABLE, &scr_wasm_ops_Table);
  scr_dyn_handle_install(SCR_DYNH_WASM_GLOBAL, &scr_wasm_ops_Global);
}

/* ── modules ─────────────────────────────────────────────────────────── */

/* The bytes of a BufferSource, or false with Node's TypeError pending. */
static bool scr_wasm_bytes_of(const ScrDyn *v, const char *what, const char *expected, const uint8_t **data,
                              size_t *len) {
  if (v && v->kind == SCR_DYN_BYTES) {
    *data = v->v.bytes->data;
    *len = (size_t)scr_bytes_byte_len(v->v.bytes);
    return true;
  }
  if (v && v->kind == SCR_DYN_HANDLE && scr_array_buffer_is(v)) {
    ScrBytes *b = v->v.handle.ptr;
    *data = b->data;
    *len = (size_t)scr_bytes_byte_len(b);
    return true;
  }
  char msg[200];
  snprintf(msg, sizeof msg, "%s: Argument 0 must be %s", what, expected);
  scr_wasm_type_error(msg);
  return false;
}

static const ScrWasmModuleDesc *scr_wasm_lookup(const uint8_t *data, size_t len) {
  uint8_t digest[32];
  bool hashed = false;
  for (uint64_t i = 0; i < scr_wasm_registry.count; i++) {
    const ScrWasmModuleDesc *d = scr_wasm_registry.modules[i];
    if (d->byte_length != len || d->abi_version != SCR_WASM_ABI_VERSION) continue;
    if (!hashed) {
      scr_wasm_sha256(data, len, digest);
      hashed = true;
    }
    if (!memcmp(d->sha256, digest, 32)) return d;
  }
  return NULL;
}

/* The CompileError for bytes the registry does not hold: the reason the
 * build recorded for a module it saw but does not translate, or the
 * message for bytes it did not see. */
static void scr_wasm_not_translated(const char *what, const uint8_t *data, size_t len) {
  const ScrWasmUntranslatedDesc *found = NULL;
  uint8_t digest[32];
  bool hashed = false;
  for (uint64_t i = 0; i < scr_wasm_untranslated.count && !found; i++) {
    const ScrWasmUntranslatedDesc *d = &scr_wasm_untranslated.modules[i];
    if (d->byte_length != len) continue;
    if (!hashed) {
      scr_wasm_sha256(data, len, digest);
      hashed = true;
    }
    if (!memcmp(d->sha256, digest, 32)) found = d;
  }
  char msg[800];
  if (found) {
    int reason_len = found->reason_len > 600 ? 600 : (int)found->reason_len;
    snprintf(msg, sizeof msg,
             "%s: this module was found when the program was built but not translated (%.*s; see "
             "https://scriptc.dev/limitations)",
             what, reason_len, found->reason);
  } else {
    snprintf(msg, sizeof msg,
             "%s: this module was not translated when the program was built (scriptc compiles WebAssembly ahead of "
             "time and cannot compile modules whose bytes it did not see; see https://scriptc.dev/limitations)",
             what);
  }
  scr_wasm_throw_kind(SCR_WASM_COMPILE_ERROR, msg);
}

static ScrDyn *scr_wasm_module_from(ScrDyn *bytes, const char *what, const char *expected) {
  const uint8_t *data;
  size_t len;
  if (!scr_wasm_bytes_of(bytes, what, expected, &data, &len)) return NULL;
  const ScrWasmModuleDesc *desc = scr_wasm_lookup(data, len);
  if (!desc) {
    scr_wasm_not_translated(what, data, len);
    return NULL;
  }
  ScrWasmObj *o = scr_wasm_obj_new(SCR_WASM_K_MODULE);
  o->desc = desc;
  return scr_wasm_box(o);
}

ScrDyn *scr_wasm_module_new(ScrDyn *bytes) {
  return scr_wasm_module_from(bytes, "WebAssembly.Module()", "a buffer source");
}

bool scr_wasm_validate(ScrDyn *bytes) {
  const uint8_t *data;
  size_t len;
  if (!scr_wasm_bytes_of(bytes, "WebAssembly.validate()", "a buffer source", &data, &len)) return false;
  return scr_wasm_lookup(data, len) != NULL;
}

/* ── instances ───────────────────────────────────────────────────────── */

/* A member of an import object (+1, NULL when absent or undefined, or with
 * an exception pending from a getter). */
static ScrDyn *scr_wasm_member(const ScrDyn *obj, const char *key, size_t len) {
  ScrDyn *v = NULL;
  switch (obj->kind) {
    case SCR_DYN_OBJ:
    case SCR_DYN_FUNC:
    case SCR_DYN_ARR:
    case SCR_DYN_PROXY:
      v = scr_dyn_obj_read(obj, key, len);
      break;
    case SCR_DYN_TYPED_REF: {
      ScrStr *k = scr_str_new(key, len);
      v = scr_dyn_typed_ref_key_get(obj, k);
      scr_str_release(k);
      break;
    }
    case SCR_DYN_HANDLE: {
      ScrStr *k = scr_str_new(key, len);
      v = scr_dyn_handle_key_get(obj, k);
      scr_str_release(k);
      break;
    }
    default:
      break;
  }
  if (v && v->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(v);
    v = NULL;
  }
  return v;
}

static bool scr_wasm_is_object(const ScrDyn *v) {
  return v && (v->kind == SCR_DYN_OBJ || v->kind == SCR_DYN_TYPED_REF || v->kind == SCR_DYN_HANDLE ||
               v->kind == SCR_DYN_PROXY || v->kind == SCR_DYN_FUNC || v->kind == SCR_DYN_ARR);
}

static void scr_wasm_link_error(const char *what, uint64_t i, const ScrWasmImportDesc *im, const char *reason) {
  char msg[600];
  snprintf(msg, sizeof msg, "%s: Import #%llu \"%.*s\" \"%.*s\": %s", what, (unsigned long long)i,
           (int)im->module_len, im->module, (int)im->name_len, im->name, reason);
  scr_wasm_throw_kind(SCR_WASM_LINK_ERROR, msg);
}

static bool scr_wasm_guarded(const ScrWasmModuleDesc *desc) {
#if SCR_WASM_SIGNALS
  return !(desc->flags & SCR_WASM_DESC_BOUNDS_CHECKS);
#else
  (void)desc;
  return false;
#endif
}

static ScrDyn *scr_wasm_instance_from(const ScrWasmModuleDesc *desc, ScrDyn *imports, const char *what) {
  scr_wasm_install();
  char msg[400];
  bool have_imports = imports && imports->kind != SCR_DYN_UNDEF;
  if (have_imports && !scr_wasm_is_object(imports)) {
    snprintf(msg, sizeof msg, "%s: Argument 1 must be an object", what);
    scr_wasm_type_error(msg);
    return NULL;
  }
  if (desc->import_count && !have_imports) {
    snprintf(msg, sizeof msg, "%s: Imports argument must be present and must be an object", what);
    scr_wasm_type_error(msg);
    return NULL;
  }
  /* Read every import value first (V8's order), then check memories, then
   * the rest in order. */
  uint64_t n = desc->import_count;
  ScrDyn **values = calloc(n ? n : 1, sizeof *values);
  if (!values) scr_trap("scriptc: out of memory\n");
  bool ok = true;
  for (uint64_t i = 0; ok && i < n; i++) {
    const ScrWasmImportDesc *im = &desc->imports[i];
    ScrDyn *ns = scr_wasm_member(imports, im->module, (size_t)im->module_len);
    if (scr_exc_pending()) {
      ok = false;
    } else if (!scr_wasm_is_object(ns)) {
      snprintf(msg, sizeof msg, "%s: Import #%llu \"%.*s\": module is not an object or function", what,
               (unsigned long long)i, (int)im->module_len, im->module);
      scr_wasm_type_error(msg);
      ok = false;
    } else {
      values[i] = scr_wasm_member(ns, im->name, (size_t)im->name_len);
      if (scr_exc_pending()) ok = false;
    }
    scr_dyn_release(ns);
  }
  for (uint64_t i = 0; ok && i < n; i++) {
    const ScrWasmImportDesc *im = &desc->imports[i];
    if (im->kind != SCR_WASM_MEMORY) continue;
    ScrWasmObj *mo = scr_wasm_unbox(values[i], SCR_WASM_K_MEMORY);
    if (!mo) {
      scr_wasm_link_error(what, i, im, "memory import must be a WebAssembly.Memory object");
      ok = false;
      break;
    }
    /* V8's limit checks, with its messages (a missing maximum prints as
     * the unsigned -1). */
    char reason[200];
    uint64_t pages = mo->memory->size / SCR_WASM_PAGE;
    if (pages < desc->memory_min) {
      snprintf(reason, sizeof reason, "memory import has %llu pages which is smaller than the declared initial of %llu",
               (unsigned long long)pages, (unsigned long long)desc->memory_min);
    } else if (desc->memory_max != UINT64_MAX && mo->memory->declared_max == UINT64_MAX) {
      snprintf(reason, sizeof reason, "memory import has no maximum limit, expected at most 4294967295");
    } else if (desc->memory_max != UINT64_MAX && mo->memory->declared_max > desc->memory_max) {
      snprintf(reason, sizeof reason, "memory import has a larger maximum size %llu than the module's declared maximum %llu",
               (unsigned long long)mo->memory->declared_max, (unsigned long long)desc->memory_max);
    } else {
      continue;
    }
    scr_wasm_link_error(what, i, im, reason);
    ok = false;
  }
  for (uint64_t i = 0; ok && i < n; i++) {
    const ScrWasmImportDesc *im = &desc->imports[i];
    const ScrDyn *v = values[i];
    if (im->kind == SCR_WASM_FUNC && !(v && scr_dyn_is_callable(v))) {
      scr_wasm_link_error(what, i, im, "function import requires a callable");
      ok = false;
    } else if (im->kind == SCR_WASM_FUNC && scr_wasm_funcref_of(v) &&
               scr_wasm_funcref_of(v)->type != desc->func_types[im->index]) {
      /* An exported WebAssembly function keeps its signature. */
      scr_wasm_link_error(what, i, im, "imported function does not match the expected type");
      ok = false;
    } else if (im->kind == SCR_WASM_TABLE) {
      ScrWasmObj *t = scr_wasm_unbox(v, SCR_WASM_K_TABLE);
      const ScrWasmTableDesc *td = &desc->tables[im->index];
      if (!t) {
        scr_wasm_link_error(what, i, im, "table import requires a WebAssembly.Table");
        ok = false;
      } else if (t->table->size < td->min || (td->max != UINT64_MAX && t->table->declared_max > td->max)) {
        /* V8's size checks name the import by number only; the imported
         * maximum prints in hexadecimal. */
        char msg[300];
        if (t->table->size < td->min)
          snprintf(msg, sizeof msg, "%s: table import %llu is smaller than initial %llu, got %u", what,
                   (unsigned long long)i, (unsigned long long)td->min, t->table->size);
        else if (t->table->declared_max == UINT64_MAX)
          snprintf(msg, sizeof msg, "%s: table import %llu has no maximum length; required: %llu", what,
                   (unsigned long long)i, (unsigned long long)td->max);
        else
          snprintf(msg, sizeof msg, "%s: table import %llu has a larger maximum size %llx than the module's declared maximum %llu",
                   what, (unsigned long long)i, (unsigned long long)t->table->declared_max,
                   (unsigned long long)td->max);
        scr_wasm_throw_kind(SCR_WASM_LINK_ERROR, msg);
        ok = false;
      } else if (t->table->elem != im->type[0]) {
        scr_wasm_link_error(what, i, im, "imported table does not match the expected type");
        ok = false;
      }
    } else if (im->kind == SCR_WASM_GLOBAL) {
      ScrWasmObj *g = scr_wasm_unbox(v, SCR_WASM_K_GLOBAL);
      bool mutable_ = desc->globals[im->index].mutable_ != 0;
      char type = im->type[0];
      if (g) {
        if (g->global->mutable_ != mutable_) {
          scr_wasm_link_error(what, i, im, "imported global does not match the expected mutability");
          ok = false;
        } else if (g->global->type != type) {
          scr_wasm_link_error(what, i, im, "imported global does not match the expected type");
          ok = false;
        }
      } else if (mutable_) {
        scr_wasm_link_error(what, i, im, "imported mutable global must be a WebAssembly.Global object");
        ok = false;
      } else if (type == 'r') {
        if (!v || (v->kind != SCR_DYN_NULL && !scr_wasm_funcref_of(v))) {
          scr_wasm_link_error(what, i, im, SCR_WASM_FUNCREF_EXPECTED);
          ok = false;
        }
      } else if (type == 'I' ? !(v && v->kind == SCR_DYN_BIGINT)
                 : type == 'x' ? false
                               : !(v && v->kind == SCR_DYN_NUM)) {
        scr_wasm_link_error(what, i, im,
                            "global import must be a number, valid Wasm reference, or WebAssembly.Global object");
        ok = false;
      }
    }
  }
  if (!ok) {
    for (uint64_t k = 0; k < n; k++) scr_dyn_release(values[k]);
    free(values);
    return NULL;
  }

  ScrWasmInst *host = calloc(1, sizeof *host);
  if (!host) scr_trap("scriptc: out of memory\n");
  host->rc = 1;
  host->desc = desc;
  size_t nf = (size_t)desc->func_count;
  size_t slots = 4 + (size_t)desc->table_count + (size_t)desc->global_count;
  host->inst = calloc(slots, sizeof(void *));
  host->funcs = calloc(nf ? nf : 1, sizeof *host->funcs);
  host->funcrefs = calloc(nf ? nf : 1, sizeof *host->funcrefs);
  host->export_fns = calloc(nf ? nf : 1, sizeof *host->export_fns);
  host->export_names = calloc(nf ? nf : 1, sizeof *host->export_names);
  host->tables = calloc(desc->table_count ? desc->table_count : 1, sizeof *host->tables);
  host->globals = calloc(desc->global_count ? desc->global_count : 1, sizeof *host->globals);
  host->data_dropped = calloc(desc->data_count ? desc->data_count : 1, 1);
  host->elem_dropped = calloc(desc->elem_count ? desc->elem_count : 1, 1);
  host->table_objs = calloc(desc->table_count ? desc->table_count : 1, sizeof *host->table_objs);
  host->global_objs = calloc(desc->global_count ? desc->global_count : 1, sizeof *host->global_objs);
  if (!host->inst || !host->funcs || !host->funcrefs || !host->export_fns || !host->export_names ||
      !host->tables || !host->globals || !host->data_dropped || !host->elem_dropped || !host->table_objs ||
      !host->global_objs)
    scr_trap("scriptc: out of memory\n");
  void **inst = host->inst;
  inst[0] = host;
#ifdef SCR_RC_AUDIT
  scr_wasm_note_host(host);
#endif
  for (size_t f = 0; f < nf; f++) {
    host->funcrefs[f].code = desc->func_codes[f];
    host->funcrefs[f].type = desc->func_types[f];
    host->funcrefs[f].inst = inst;
  }
  inst[3] = host->funcrefs;
  for (uint64_t i = 0; i < n; i++) {
    const ScrWasmImportDesc *im = &desc->imports[i];
    ScrDyn *v = values[i];
    switch (im->kind) {
      case SCR_WASM_FUNC:
        host->funcs[im->index] = v;
        values[i] = NULL;
        break;
      case SCR_WASM_MEMORY:
        host->memory = scr_wasm_memory_retain(scr_wasm_unbox(v, SCR_WASM_K_MEMORY)->memory);
        host->memory_obj = v;
        values[i] = NULL;
        break;
      case SCR_WASM_TABLE:
        host->tables[im->index] = scr_wasm_table_retain(scr_wasm_unbox(v, SCR_WASM_K_TABLE)->table);
        host->table_objs[im->index] = v;
        values[i] = NULL;
        break;
      default: {
        ScrWasmObj *g = scr_wasm_unbox(v, SCR_WASM_K_GLOBAL);
        if (g) {
          host->globals[im->index] = scr_wasm_global_retain(g->global);
          host->global_objs[im->index] = v;
          values[i] = NULL;
        } else {
          char type = im->type[0];
          ScrWasmGlobal *cell = scr_wasm_global_new(type, false);
          uint64_t value = 0;
          scr_wasm_from_js(type, v, &value);
          if (type == 'x') scr_wasm_global_set_ref(cell, (void *)(uintptr_t)value);
          else cell->value = value;
          host->globals[im->index] = cell;
        }
        break;
      }
    }
    scr_dyn_release(values[i]);
  }
  free(values);
  if (desc->memory_count && !host->memory) {
    host->memory = scr_wasm_memory_new(desc->memory_min, desc->memory_max, scr_wasm_guarded(desc), what);
    if (!host->memory) return NULL;
  }
  if (host->memory) {
    inst[1] = host->memory->base;
    inst[2] = host->memory;
  }
  for (uint64_t t = 0; t < desc->table_count; t++) {
    const ScrWasmTableDesc *td = &desc->tables[t];
    if (!host->tables[t]) host->tables[t] = scr_wasm_table_new((char)td->elem, td->min, td->max);
    inst[4 + t] = host->tables[t];
  }
  for (uint64_t g = 0; g < desc->global_count; g++) {
    const ScrWasmGlobalDesc *gd = &desc->globals[g];
    if (!host->globals[g]) host->globals[g] = scr_wasm_global_new((char)gd->type, gd->mutable_ != 0);
    inst[4 + desc->table_count + g] = host->globals[g];
  }
#if SCR_WASM_SIGNALS
  if (scr_wasm_guarded(desc)) pthread_once(&scr_wasm_handler_once, scr_wasm_install_handler);
#endif
  /* Globals and segments, then the start function. */
  bool was = scr_wasm_instantiating;
  scr_wasm_instantiating = true;
  int trap = scr_wasm_enter(scr_wasm_init_thunk, inst, NULL, NULL);
  scr_wasm_leave();
  scr_wasm_instantiating = was;
  if (trap) {
    if (trap == SCR_WASM_TRAP_DATA_SEGMENT) {
      snprintf(msg, sizeof msg, "%s: data segment %u is out of bounds (offset %u, length %u, memory size %llu)", what,
               scr_wasm_segment_failure.seg, scr_wasm_segment_failure.offset, scr_wasm_segment_failure.length,
               (unsigned long long)scr_wasm_segment_failure.size);
      scr_wasm_throw_kind(SCR_WASM_RUNTIME_ERROR, msg);
    } else if (trap == SCR_WASM_TRAP_TABLE_OOB) {
      snprintf(msg, sizeof msg, "%s: table index is out of bounds", what);
      scr_wasm_throw_kind(SCR_WASM_RUNTIME_ERROR, msg);
    } else {
      scr_wasm_throw_trap(trap);
    }
    return NULL;
  }
  if (desc->start) {
    trap = scr_wasm_enter(scr_wasm_start_thunk, inst, NULL, NULL);
    scr_wasm_leave();
    if (trap) {
      scr_wasm_throw_trap(trap);
      return NULL;
    }
  }

  ScrDyn *exports = scr_dyn_new_obj_null_proto();
  for (uint64_t i = 0; i < desc->export_count; i++) {
    const ScrWasmExportDesc *ex = &desc->exports[i];
    ScrDyn *value;
    if (ex->kind == SCR_WASM_FUNC) {
      value = scr_wasm_function_value(host, (uint32_t)ex->index);
    } else {
      int kind = ex->kind == SCR_WASM_MEMORY  ? SCR_WASM_K_MEMORY
                 : ex->kind == SCR_WASM_TABLE ? SCR_WASM_K_TABLE
                                              : SCR_WASM_K_GLOBAL;
      /* V8 exports an imported object itself, and one object per memory
       * and table; a defined global gets a new object per export. */
      ScrDyn **slot = kind == SCR_WASM_K_MEMORY  ? &host->memory_obj
                      : kind == SCR_WASM_K_TABLE ? &host->table_objs[ex->index]
                                                 : &host->global_objs[ex->index];
      if (*slot) {
        value = scr_dyn_retain(*slot);
      } else {
        ScrWasmObj *o = scr_wasm_obj_new(kind);
        o->inst = scr_wasm_inst_retain(host);
        if (kind == SCR_WASM_K_MEMORY) o->memory = scr_wasm_memory_retain(host->memory);
        else if (kind == SCR_WASM_K_TABLE) o->table = scr_wasm_table_retain(host->tables[ex->index]);
        else o->global = scr_wasm_global_retain(host->globals[ex->index]);
        value = scr_wasm_box(o);
        if (kind != SCR_WASM_K_GLOBAL) *slot = scr_dyn_retain(value);
      }
    }
    scr_dyn_obj_set(exports, ex->name, (size_t)ex->name_len, value);
  }
  ScrDyn *frozen = scr_dyn_freeze_data(exports);
  scr_dyn_release(frozen);
  host->exports = exports;
  ScrWasmObj *o = scr_wasm_obj_new(SCR_WASM_K_INSTANCE);
  o->inst = host; /* takes the creation reference */
  return scr_wasm_box(o);
}

ScrDyn *scr_wasm_instance_new(ScrDyn *module, ScrDyn *imports) {
  scr_wasm_install();
  ScrWasmObj *m = scr_wasm_unbox(module, SCR_WASM_K_MODULE);
  if (!m) {
    scr_wasm_type_error("WebAssembly.Instance(): Argument 0 must be a WebAssembly.Module");
    return NULL;
  }
  return scr_wasm_instance_from(m->desc, imports, "WebAssembly.Instance()");
}

/* ── constructors and Module's static functions ────────────────────── */

/* Memories the program constructs are guarded exactly when the translated
 * modules are (every module of a build shares the mode), so any of them
 * can import one. */
static bool scr_wasm_build_guarded(void) {
#if SCR_WASM_SIGNALS
  return scr_wasm_registry.count > 0 && !(scr_wasm_registry.modules[0]->flags & SCR_WASM_DESC_BOUNDS_CHECKS);
#else
  return false;
#endif
}

/* V8's GetOptionalIntegerProperty: the descriptor's `name` property as an
 * unsigned 32-bit integer within [lower, upper]. An absent or undefined
 * property leaves *out unchanged, or throws "is required" when
 * `required`. False with an exception pending. */
static bool scr_wasm_limit(const ScrDyn *descriptor, const char *name, bool required, const char *what,
                           uint64_t lower, uint64_t upper, uint64_t *out) {
  ScrDyn *v = scr_wasm_member(descriptor, name, strlen(name));
  if (scr_exc_pending()) return false;
  char msg[240];
  if (!v) {
    if (!required) return true;
    snprintf(msg, sizeof msg, "%s: Property '%s' is required", what, name);
    scr_wasm_type_error(msg);
    return false;
  }
  char label[120];
  snprintf(label, sizeof label, "%s: Property '%s'", what, name);
  uint32_t n;
  bool ok = scr_wasm_u32_arg(v, label, &n);
  scr_dyn_release(v);
  if (!ok) return false;
  /* V8 prints the lower bound in hexadecimal. */
  if (n < lower) {
    snprintf(msg, sizeof msg, "%s: Property '%s': value %u is below the lower bound %llx", what, name, n,
             (unsigned long long)lower);
    scr_wasm_range_error(msg);
    return false;
  }
  if (n > upper) {
    snprintf(msg, sizeof msg, "%s: Property '%s': value %u is above the upper bound %llu", what, name, n,
             (unsigned long long)upper);
    scr_wasm_range_error(msg);
    return false;
  }
  *out = n;
  return true;
}

/* ToString of a descriptor's type property (+1; NULL with an exception
 * pending). An absent property reads as "undefined". */
static ScrStr *scr_wasm_type_name(const ScrDyn *descriptor, const char *name) {
  ScrDyn *v = scr_wasm_member(descriptor, name, strlen(name));
  if (scr_exc_pending()) return NULL;
  if (!v) return scr_str_new("undefined", 9);
  ScrStr *s = scr_dyn_string_coerce_js(v);
  scr_dyn_release(v);
  return s;
}

static bool scr_wasm_str_is(const ScrStr *s, const char *text) {
  size_t n = strlen(text);
  return s->len == n && !memcmp(s->data, text, n);
}

/* A descriptor's boolean property (ToBoolean; false when absent). */
static bool scr_wasm_flag(const ScrDyn *descriptor, const char *name, bool *out) {
  ScrDyn *v = scr_wasm_member(descriptor, name, strlen(name));
  if (scr_exc_pending()) return false;
  *out = v && scr_dyn_truthy(v);
  scr_dyn_release(v);
  return true;
}

static bool scr_wasm_absent(const ScrDyn *v) { return !v || v->kind == SCR_DYN_UNDEF; }

ScrDyn *scr_wasm_memory_construct(ScrDyn *descriptor) {
  scr_wasm_install();
  const char *what = "WebAssembly.Memory()";
  if (!scr_wasm_is_object(descriptor)) {
    scr_wasm_type_error("WebAssembly.Memory(): Argument 0 must be a memory descriptor");
    return NULL;
  }
  uint64_t initial = 0, maximum = UINT64_MAX;
  bool shared;
  if (!scr_wasm_limit(descriptor, "initial", true, what, 0, SCR_WASM_MAX_PAGES, &initial) ||
      !scr_wasm_limit(descriptor, "maximum", false, what, initial, SCR_WASM_MAX_PAGES, &maximum) ||
      !scr_wasm_flag(descriptor, "shared", &shared))
    return NULL;
  if (shared && maximum == UINT64_MAX) {
    scr_wasm_type_error("WebAssembly.Memory(): If shared is true, maximum property should be defined.");
    return NULL;
  }
  if (shared) {
    scr_wasm_type_error("WebAssembly.Memory(): shared memories are not supported yet (scriptc does not translate "
                        "WebAssembly threads; see https://scriptc.dev/limitations)");
    return NULL;
  }
  ScrWasmMemory *m = scr_wasm_memory_new(initial, maximum, scr_wasm_build_guarded(), what);
  if (!m) return NULL;
  ScrWasmObj *o = scr_wasm_obj_new(SCR_WASM_K_MEMORY);
  o->memory = m;
  return scr_wasm_box(o);
}

ScrDyn *scr_wasm_table_construct(ScrDyn *descriptor, ScrDyn *value) {
  scr_wasm_install();
  const char *what = "WebAssembly.Table()";
  if (!scr_wasm_is_object(descriptor)) {
    scr_wasm_type_error("WebAssembly.Table(): Argument 0 must be a table descriptor");
    return NULL;
  }
  ScrStr *type = scr_wasm_type_name(descriptor, "element");
  if (!type) return NULL;
  char elem = scr_wasm_str_is(type, "anyfunc") ? 'r' : scr_wasm_str_is(type, "externref") ? 'x' : 0;
  scr_str_release(type);
  if (!elem) {
    scr_wasm_type_error("WebAssembly.Table(): Descriptor property 'element' must be a WebAssembly reference type");
    return NULL;
  }
  uint64_t initial = 0, maximum = UINT64_MAX;
  if (!scr_wasm_limit(descriptor, "initial", true, what, 0, SCR_WASM_MAX_TABLE, &initial) ||
      !scr_wasm_limit(descriptor, "maximum", false, what, initial, 4294967295u, &maximum))
    return NULL;
  uint64_t init = scr_wasm_default_value(elem);
  if (!scr_wasm_absent(value) &&
      !scr_wasm_from_js_as(elem, value, &init,
                           "WebAssembly.Table(): Argument 2 must be undefined or a value of type compatible with the "
                           "type of the new table: " SCR_WASM_FUNCREF_EXPECTED "."))
    return NULL;
  ScrWasmTable *t = scr_wasm_table_new(elem, initial, maximum);
  for (uint32_t i = 0; i < t->size; i++) t->elems[i] = scr_wasm_ref_retain(elem, (void *)(uintptr_t)init);
  ScrWasmObj *o = scr_wasm_obj_new(SCR_WASM_K_TABLE);
  o->table = t;
  return scr_wasm_box(o);
}

ScrDyn *scr_wasm_global_construct(ScrDyn *descriptor, ScrDyn *value) {
  scr_wasm_install();
  if (!scr_wasm_is_object(descriptor)) {
    scr_wasm_type_error("WebAssembly.Global(): Argument 0 must be a global descriptor");
    return NULL;
  }
  bool mutable_;
  if (!scr_wasm_flag(descriptor, "mutable", &mutable_)) return NULL;
  ScrStr *name = scr_wasm_type_name(descriptor, "value");
  if (!name) return NULL;
  static const char *const names[] = {"i32", "i64", "f32", "f64", "externref", "anyfunc"};
  static const char letters[] = {'i', 'I', 'f', 'F', 'x', 'r'};
  char type = 0;
  for (size_t i = 0; i < sizeof letters; i++)
    if (scr_wasm_str_is(name, names[i])) type = letters[i];
  bool v128 = scr_wasm_str_is(name, "v128");
  scr_str_release(name);
  if (v128) {
    scr_wasm_type_error("WebAssembly.Global(): A global of type 'v128' cannot be created in JavaScript");
    return NULL;
  }
  if (!type) {
    scr_wasm_type_error("WebAssembly.Global(): Descriptor property 'value' must be a WebAssembly type");
    return NULL;
  }
  uint64_t v = scr_wasm_default_value(type);
  if (!scr_wasm_absent(value) &&
      !scr_wasm_from_js_as(type, value, &v, "WebAssembly.Global(): " SCR_WASM_FUNCREF_EXPECTED))
    return NULL;
  ScrWasmGlobal *g = scr_wasm_global_new(type, mutable_);
  if (type == 'x') scr_wasm_global_set_ref(g, (void *)(uintptr_t)v);
  else g->value = v;
  ScrWasmObj *o = scr_wasm_obj_new(SCR_WASM_K_GLOBAL);
  o->global = g;
  return scr_wasm_box(o);
}

/* `WebAssembly.Module(...)` and the other classes called without new. */
ScrDyn *scr_wasm_construct_without_new(double kind, ScrDyn *arg0, ScrDyn *arg1) {
  (void)arg0;
  (void)arg1;
  static const char *const names[] = {"Module", "Instance", "Memory", "Table", "Global"};
  const char *name = names[(int)kind];
  char msg[160];
  snprintf(msg, sizeof msg, "WebAssembly.%s(): WebAssembly.%s must be invoked with 'new'", name, name);
  scr_wasm_type_error(msg);
  return NULL;
}

static const ScrWasmModuleDesc *scr_wasm_module_arg(const ScrDyn *v, const char *what) {
  ScrWasmObj *m = scr_wasm_unbox(v, SCR_WASM_K_MODULE);
  if (m) return m->desc;
  char msg[160];
  snprintf(msg, sizeof msg, "%s: Argument 0 must be a WebAssembly.Module", what);
  scr_wasm_type_error(msg);
  return NULL;
}

static void scr_wasm_set_text(ScrDyn *obj, const char *key, const char *text, size_t len) {
  ScrStr *s = scr_str_new(text, len);
  scr_dyn_obj_set(obj, key, strlen(key), scr_dyn_new_str(s));
  scr_str_release(s);
}

static const char *const scr_wasm_kind_names[] = {"function", "table", "memory", "global"};

ScrDyn *scr_wasm_module_imports(ScrDyn *module) {
  const ScrWasmModuleDesc *desc = scr_wasm_module_arg(module, "WebAssembly.Module.imports()");
  if (!desc) return NULL;
  ScrDyn *out = scr_dyn_new_arr();
  for (uint64_t i = 0; i < desc->import_count; i++) {
    const ScrWasmImportDesc *im = &desc->imports[i];
    ScrDyn *row = scr_dyn_new_obj();
    scr_wasm_set_text(row, "module", im->module, (size_t)im->module_len);
    scr_wasm_set_text(row, "name", im->name, (size_t)im->name_len);
    scr_wasm_set_text(row, "kind", scr_wasm_kind_names[im->kind], strlen(scr_wasm_kind_names[im->kind]));
    scr_dyn_arr_push(out, row);
  }
  return out;
}

ScrDyn *scr_wasm_module_exports(ScrDyn *module) {
  const ScrWasmModuleDesc *desc = scr_wasm_module_arg(module, "WebAssembly.Module.exports()");
  if (!desc) return NULL;
  ScrDyn *out = scr_dyn_new_arr();
  for (uint64_t i = 0; i < desc->export_count; i++) {
    const ScrWasmExportDesc *ex = &desc->exports[i];
    ScrDyn *row = scr_dyn_new_obj();
    scr_wasm_set_text(row, "name", ex->name, (size_t)ex->name_len);
    scr_wasm_set_text(row, "kind", scr_wasm_kind_names[ex->kind], strlen(scr_wasm_kind_names[ex->kind]));
    scr_dyn_arr_push(out, row);
  }
  return out;
}

/* A fresh ArrayBuffer per matching custom section, in module order. */
ScrDyn *scr_wasm_module_custom_sections(ScrDyn *module, ScrDyn *name) {
  const ScrWasmModuleDesc *desc = scr_wasm_module_arg(module, "WebAssembly.Module.customSections()");
  if (!desc) return NULL;
  if (scr_wasm_absent(name)) {
    scr_wasm_type_error("WebAssembly.Module.customSections(): Argument 1 is required");
    return NULL;
  }
  ScrStr *wanted = scr_dyn_string_coerce_js(name);
  if (!wanted) return NULL;
  ScrDyn *out = scr_dyn_new_arr();
  for (uint64_t i = 0; i < desc->custom_count; i++) {
    const ScrWasmCustomDesc *c = &desc->customs[i];
    if (c->name_len != wanted->len || memcmp(c->name, wanted->data, wanted->len) != 0) continue;
    ScrBytes *bytes = scr_bytes_from_data(c->data, (size_t)c->len);
    scr_dyn_arr_push(out, scr_array_buffer_from_bytes(bytes));
    scr_bytes_release(bytes);
  }
  scr_str_release(wanted);
  return out;
}

/* `v.valueOf()` on a WebAssembly-typed receiver: a Global's value; any
 * other value answers what the generic valueOf answers. */
ScrDyn *scr_wasm_value_of(ScrDyn *value) {
  ScrWasmObj *g = scr_wasm_unbox(value, SCR_WASM_K_GLOBAL);
  if (g) return scr_wasm_global_value(g->global);
  ScrStr *what = scr_str_new("valueOf", 7);
  ScrDyn *out = scr_dyn_value_of(value, what);
  scr_str_release(what);
  return out;
}

/* ── promises ────────────────────────────────────────────────────────── */

/* A promise settled now: fulfilled with value, or rejected with the
 * pending exception. */
static ScrPromise *scr_wasm_settled(ScrDyn *value) {
  if (value) {
    ScrPromise *p = scr_promise_settled_ref(value, &scr_dyn_retain_v, &scr_dyn_release_v, &scr_dyn_trace_v);
    return p;
  }
  ScrPromise *p = scr_promise_new();
  scr_promise_reject_pending(p);
  return p;
}

/* compile and instantiate over bytes settle on a later loop turn, after
 * the current microtasks, as V8's compile task does. */
enum { SCR_WASM_JOB_COMPILE, SCR_WASM_JOB_INSTANTIATE };

static void scr_wasm_job_fire(ScrClosure *clo) {
  ScrPromise *p = scr_box_get_ref(clo->caps[0]);
  ScrDyn *source = scr_box_get_ref(clo->caps[1]);
  ScrDyn *imports = scr_box_get_ref(clo->caps[2]);
  int job = (int)scr_box_get_f64(clo->caps[3]);
  const char *what = job == SCR_WASM_JOB_COMPILE ? "WebAssembly.compile()" : "WebAssembly.instantiate()";
  ScrDyn *module = scr_wasm_module_from(source, what, "a buffer source");
  ScrDyn *result = module;
  if (module && job == SCR_WASM_JOB_INSTANTIATE) {
    ScrDyn *instance = scr_wasm_instance_from(scr_wasm_unbox(module, SCR_WASM_K_MODULE)->desc, imports, what);
    if (instance) {
      result = scr_dyn_new_obj();
      scr_dyn_obj_set(result, "module", 6, module);
      scr_dyn_obj_set(result, "instance", 8, instance);
    } else {
      scr_dyn_release(module);
      result = NULL;
    }
  }
  if (result) {
    scr_promise_resolve_dyn(p, result); /* moves result in */
  } else {
    scr_promise_reject_pending(p);
  }
  scr_dyn_release(source);
  scr_dyn_release(imports);
  scr_promise_release(p);
}

static ScrPromise *scr_wasm_defer(int job, ScrDyn *source, ScrDyn *imports) {
  ScrPromise *p = scr_promise_new();
  ScrClosure *clo = scr_closure_new((void *)scr_wasm_job_fire, 4);
  clo->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, NULL);
  scr_box_set_ref(clo->caps[0], scr_promise_retain(p));
  clo->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(clo->caps[1], scr_dyn_retain(source ? source : scr_dyn_undefined()));
  clo->caps[2] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(clo->caps[2], scr_dyn_retain(imports ? imports : scr_dyn_undefined()));
  clo->caps[3] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(clo->caps[3], (double)job);
  scr_loop_defer(clo);
  return p;
}

static bool scr_wasm_is_buffer_source(const ScrDyn *v) {
  return v && (v->kind == SCR_DYN_BYTES || (v->kind == SCR_DYN_HANDLE && scr_array_buffer_is(v)));
}

ScrPromise *scr_wasm_compile(ScrDyn *bytes) {
  scr_wasm_install();
  if (!scr_wasm_is_buffer_source(bytes)) {
    scr_wasm_type_error("WebAssembly.compile(): Argument 0 must be a buffer source");
    return scr_wasm_settled(NULL);
  }
  return scr_wasm_defer(SCR_WASM_JOB_COMPILE, bytes, NULL);
}

ScrPromise *scr_wasm_instantiate(ScrDyn *source, ScrDyn *imports) {
  scr_wasm_install();
  ScrWasmObj *m = scr_wasm_unbox(source, SCR_WASM_K_MODULE);
  if (m) return scr_wasm_settled(scr_wasm_instance_from(m->desc, imports, "WebAssembly.instantiate()"));
  if (!scr_wasm_is_buffer_source(source)) {
    scr_wasm_type_error("WebAssembly.instantiate(): Argument 0 must be a buffer source or a WebAssembly.Module object");
    return scr_wasm_settled(NULL);
  }
  if (imports && imports->kind != SCR_DYN_UNDEF && !scr_wasm_is_object(imports)) {
    scr_wasm_type_error("WebAssembly.instantiate(): Argument 1 must be an object");
    return scr_wasm_settled(NULL);
  }
  return scr_wasm_defer(SCR_WASM_JOB_INSTANTIATE, source, imports);
}

/* ── instanceof and the error constructors ───────────────────────────── */

bool scr_wasm_is(const ScrDyn *value, double kind) {
  int k = (int)kind;
  if (k <= SCR_WASM_K_GLOBAL) return scr_wasm_unbox(value, k) != NULL;
  ScrError *e = value ? scr_errdyn_err_of(value) : NULL;
  if (!e) return false;
  int brand = scr_wasm_error_brand(e);
  scr_error_release(e);
  return brand == k - 5;
}

ScrDyn *scr_wasm_error_new(double kind, ScrDyn *message, ScrDyn *options) {
  ScrStr *text = NULL;
  if (message && message->kind != SCR_DYN_UNDEF) {
    text = scr_dyn_string_coerce_js(message);
    if (!text) return NULL;
  }
  ScrError *e = scr_wasm_error_make((int)kind - 5, text);
  if (!text) e->message_present = false;
  scr_str_release(text);
  if (options && scr_wasm_is_object(options)) {
    ScrDyn *cause = scr_wasm_member(options, "cause", 5);
    if (cause) {
      scr_error_define_cause(e, cause);
      scr_dyn_release(cause);
    }
  }
  ScrDyn *d = scr_dyn_from_error(e);
  scr_error_release(e);
  return d;
}

/* ── the namespace and its functions as values ───────────────────────── */

enum { SCR_WASM_FN_COMPILE, SCR_WASM_FN_INSTANTIATE, SCR_WASM_FN_VALIDATE };
static const char *const scr_wasm_fn_names[] = {"compile", "instantiate", "validate"};

static ScrDyn *scr_wasm_fn_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  int kind = (int)scr_box_get_f64(clo->caps[0]);
  ScrDyn *a0 = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrDyn *a1 = argc > 1 ? args[1] : scr_dyn_undefined();
  if (kind == SCR_WASM_FN_VALIDATE) {
    bool ok = scr_wasm_validate(a0);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_new_bool(ok);
  }
  ScrPromise *p = kind == SCR_WASM_FN_COMPILE ? scr_wasm_compile(a0) : scr_wasm_instantiate(a0, a1);
  ScrDyn *boxed = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return boxed;
}

/* WebAssembly.compile, instantiate and validate as function values (+1),
 * one per thread and function, as in Node. */
static SCR_TL ScrDyn *scr_wasm_fns[3];
static SCR_TL ScrDyn *scr_wasm_ns;

ScrDyn *scr_wasm_function(double kind) {
  ScrDyn **fns = scr_wasm_fns;
  int k = (int)kind;
  if (!fns[k]) {
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(closure->caps[0], (double)k);
    fns[k] = scr_dyn_new_func(closure, scr_wasm_fn_call, k == SCR_WASM_FN_INSTANTIATE ? 1 : 1, "",
                              scr_wasm_fn_names[k]);
  }
  return scr_dyn_retain(fns[k]);
}

/* globalThis.WebAssembly as a value (+1): an object with the namespace's
 * functions. The classes are not values yet: their constructors and
 * instanceof lower at their use sites. */
ScrDyn *scr_wasm_namespace(void) {
  if (!scr_wasm_ns) {
    scr_wasm_ns = scr_dyn_new_obj();
    for (int k = 0; k < 3; k++)
      scr_dyn_obj_set(scr_wasm_ns, scr_wasm_fn_names[k], strlen(scr_wasm_fn_names[k]), scr_wasm_function(k));
  }
  return scr_dyn_retain(scr_wasm_ns);
}

/* The global object seen through a cast to a type with a `WebAssembly`
 * member (`globalThis as unknown as { WebAssembly: ... }`): an object
 * whose WebAssembly member is the namespace (+1). */
ScrDyn *scr_wasm_global_view(void) {
  ScrDyn *view = scr_dyn_new_obj();
  scr_dyn_obj_set(view, "WebAssembly", 11, scr_wasm_namespace());
  return view;
}

#ifdef SCR_RC_AUDIT
static void scr_wasm_teardown(void) {
  for (size_t i = 0; i < scr_wasm_host_count; i++) {
    ScrWasmInst *host = scr_wasm_hosts[i];
    const ScrWasmModuleDesc *desc = host->desc;
    scr_dyn_release(host->exports);
    scr_dyn_release(host->memory_obj);
    for (uint64_t t = 0; t < desc->table_count; t++) scr_dyn_release(host->table_objs[t]);
    for (uint64_t g = 0; g < desc->global_count; g++) scr_dyn_release(host->global_objs[g]);
    free(host->table_objs);
    free(host->global_objs);
    for (uint64_t f = 0; f < desc->func_count; f++) {
      scr_dyn_release(host->export_fns[f]);
      scr_dyn_release(host->funcs[f]);
      free(host->export_names[f]);
    }
    scr_wasm_memory_release(host->memory);
    for (uint64_t t = 0; t < desc->table_count; t++) scr_wasm_table_release(host->tables[t]);
    for (uint64_t g = 0; g < desc->global_count; g++) scr_wasm_global_release(host->globals[g]);
    free(host->funcs);
    free(host->funcrefs);
    free(host->export_fns);
    free(host->export_names);
    free(host->tables);
    free(host->globals);
    free(host->data_dropped);
    free(host->elem_dropped);
    free(host->inst);
    free(host);
  }
  free(scr_wasm_hosts);
  scr_wasm_hosts = NULL;
  scr_wasm_host_count = scr_wasm_host_cap = 0;
  for (int k = 0; k < 3; k++) {
    scr_dyn_release(scr_wasm_fns[k]);
    scr_wasm_fns[k] = NULL;
  }
  scr_dyn_release(scr_wasm_ns);
  scr_wasm_ns = NULL;
}
#endif
