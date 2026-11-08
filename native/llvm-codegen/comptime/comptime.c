/* The comptime evaluator: one JavaScript file in, one line of tagged JSON out.
 * Both compilers run this executable, so a callback has one behaviour
 * whichever compiler builds the program. The guest context holds the
 * ECMAScript built-ins and nothing of the host: no filesystem, process,
 * module loader, timer or console binding, and no object of the compiler. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#include "quickjs.h"
#include "scr_ieee754.h"
#include <errno.h>
#include <math.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <malloc.h>
#include <windows.h>
#else
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
/* <malloc/malloc.h> does not compile under _POSIX_C_SOURCE (its typed
 * allocation declarations need Darwin's extensions), and this is the one
 * function wanted from it. */
extern size_t malloc_size(const void *ptr);
#else
#include <malloc.h>
#endif
#endif

/* Math.hypot below must round each operation as V8 does. */
#pragma STDC FP_CONTRACT OFF

static uint64_t now_ms(void) {
#ifdef _WIN32
  return GetTickCount64();
#else
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
#endif
}

/* Rejected promises that no reaction handles. */
static void track_rejection(JSContext *ctx, JSValueConst promise, JSValueConst reason, bool is_handled, void *opaque) {
  (void)ctx; (void)promise; (void)reason;
  *(int *)opaque += is_handled ? -1 : 1;
}

/* The memory limit, enforced where the engine asks the C library for memory.
 * `refused` records that a request was turned down: the engine then throws
 * an error the callback could catch, or null when it has no memory left for
 * the error object, and either one reaching the top is the limit. */
typedef struct { size_t used, limit; int refused; } Heap;
static size_t heap_usable_size(const void *ptr) {
#if defined(__APPLE__)
  return malloc_size(ptr);
#elif defined(_WIN32)
  return _msize((void *)ptr);
#else
  return malloc_usable_size((void *)ptr);
#endif
}
static int heap_has(Heap *heap, size_t size) {
  if (heap->used <= heap->limit && size <= heap->limit - heap->used) return 1;
  heap->refused = 1;
  return 0;
}
static void *heap_calloc(void *opaque, size_t count, size_t size) {
  Heap *heap = opaque;
  if (size != 0 && count > SIZE_MAX / size) return NULL;
  void *ptr = heap_has(heap, count * size) ? calloc(count, size) : NULL;
  if (ptr) heap->used += heap_usable_size(ptr);
  return ptr;
}
static void *heap_malloc(void *opaque, size_t size) {
  Heap *heap = opaque;
  void *ptr = heap_has(heap, size) ? malloc(size) : NULL;
  if (ptr) heap->used += heap_usable_size(ptr);
  return ptr;
}
static void heap_free(void *opaque, void *ptr) {
  Heap *heap = opaque;
  if (ptr) heap->used -= heap_usable_size(ptr);
  free(ptr);
}
static void *heap_realloc(void *opaque, void *ptr, size_t size) {
  Heap *heap = opaque;
  size_t old = ptr ? heap_usable_size(ptr) : 0;
  if (size > old && !heap_has(heap, size - old)) return NULL;
  void *moved = realloc(ptr, size);
  if (moved) heap->used = heap->used - old + heap_usable_size(moved);
  return moved;
}
static const JSMallocFunctions heap_functions = { heap_calloc, heap_malloc, heap_free, heap_realloc, heap_usable_size };

typedef struct { uint64_t deadline; int interrupted; } Budget;
static int interrupt(JSRuntime *rt, void *opaque) {
  (void)rt;
  Budget *budget = opaque;
  if (now_ms() >= budget->deadline) budget->interrupted = 1;
  return budget->interrupted;
}

/* The engine polls the budget between bytecode instructions. A builtin that
 * runs long without returning to bytecode (sorting or joining a large array)
 * is not polled, so a second thread ends the process once the budget is past
 * by WATCHDOG_GRACE_MS. Whichever thread claims the output writes it; the
 * other never does. */
#define WATCHDOG_GRACE_MS 500
static const char timeout_line[] = "[\"error\",\"timeout\",\"\"]\n";
static atomic_flag output_claimed = ATOMIC_FLAG_INIT;

#ifdef _WIN32
static DWORD WINAPI watchdog(LPVOID opaque) {
  Sleep((DWORD)(uintptr_t)opaque);
  if (!atomic_flag_test_and_set(&output_claimed)) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), timeout_line, sizeof(timeout_line) - 1, &written, NULL);
    ExitProcess(0);
  }
  return 0;
}
static int start_watchdog(long ms) {
  HANDLE thread = CreateThread(NULL, 0, watchdog, (LPVOID)(uintptr_t)ms, 0, NULL);
  if (!thread) return -1;
  CloseHandle(thread);
  return 0;
}
static void wait_forever(void) { for (;;) Sleep(INFINITE); }
#else
static void *watchdog(void *opaque) {
  uint64_t end = now_ms() + (uint64_t)(uintptr_t)opaque;
  for (uint64_t now = now_ms(); now < end; now = now_ms()) {
    struct timespec rest = { (time_t)((end - now) / 1000), (long)((end - now) % 1000) * 1000000 };
    nanosleep(&rest, NULL);
  }
  if (!atomic_flag_test_and_set(&output_claimed)) {
    ssize_t written = write(STDOUT_FILENO, timeout_line, sizeof(timeout_line) - 1);
    (void)written;
    _exit(0);
  }
  return NULL;
}
static int start_watchdog(long ms) {
  pthread_t thread;
  if (pthread_create(&thread, NULL, watchdog, (void *)(uintptr_t)ms) != 0) return -1;
  pthread_detach(thread);
  return 0;
}
static void wait_forever(void) { for (;;) pause(); }
#endif

/* V8's Math.hypot: every argument is converted first, Infinity wins over
 * NaN, and the squares are summed scaled by the largest magnitude with a
 * compensated sum. */
static JSValue node_hypot(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  double scale = 0, sum = 0, compensation = 0;
  int nan = 0;
  double *values = argc > 0 ? js_malloc(ctx, sizeof(double) * (size_t)argc) : NULL;
  if (argc > 0 && !values) return JS_EXCEPTION;
  for (int i = 0; i < argc; i++) {
    if (JS_ToFloat64(ctx, &values[i], argv[i]) < 0) { js_free(ctx, values); return JS_EXCEPTION; }
    values[i] = fabs(values[i]);
    if (isnan(values[i])) nan = 1;
    else if (values[i] > scale) scale = values[i];
  }
  if (isinf(scale) || nan || scale == 0) {
    js_free(ctx, values);
    return JS_NewFloat64(ctx, isinf(scale) ? INFINITY : nan ? NAN : 0);
  }
  for (int i = 0; i < argc; i++) {
    double term = values[i] / scale;
    double summand = term * term - compensation;
    double next = sum + summand;
    compensation = (next - sum) - summand;
    sum = next;
  }
  js_free(ctx, values);
  return JS_NewFloat64(ctx, sqrt(sum) * scale);
}

/* Node computes these Math members with V8's port of fdlibm on every
 * platform, and the C library's versions differ from it in the last digit.
 * scr_ieee754.c is the runtime's port of V8's file, so a value computed at
 * compile time is the value the same expression gives at run time. */
static const JSCFunctionListEntry node_math[] = {
  JS_CFUNC_SPECIAL_DEF("acos", 1, f_f, scr_ieee754_acos),
  JS_CFUNC_SPECIAL_DEF("acosh", 1, f_f, scr_ieee754_acosh),
  JS_CFUNC_SPECIAL_DEF("asin", 1, f_f, scr_ieee754_asin),
  JS_CFUNC_SPECIAL_DEF("asinh", 1, f_f, scr_ieee754_asinh),
  JS_CFUNC_SPECIAL_DEF("atan", 1, f_f, scr_ieee754_atan),
  JS_CFUNC_SPECIAL_DEF("atan2", 2, f_f_f, scr_ieee754_atan2),
  JS_CFUNC_SPECIAL_DEF("atanh", 1, f_f, scr_ieee754_atanh),
  JS_CFUNC_SPECIAL_DEF("cbrt", 1, f_f, scr_ieee754_cbrt),
  JS_CFUNC_SPECIAL_DEF("cos", 1, f_f, scr_ieee754_cos),
  JS_CFUNC_SPECIAL_DEF("cosh", 1, f_f, scr_ieee754_cosh),
  JS_CFUNC_SPECIAL_DEF("exp", 1, f_f, scr_ieee754_exp),
  JS_CFUNC_SPECIAL_DEF("expm1", 1, f_f, scr_ieee754_expm1),
  JS_CFUNC_SPECIAL_DEF("log", 1, f_f, scr_ieee754_log),
  JS_CFUNC_SPECIAL_DEF("log10", 1, f_f, scr_ieee754_log10),
  JS_CFUNC_SPECIAL_DEF("log1p", 1, f_f, scr_ieee754_log1p),
  JS_CFUNC_SPECIAL_DEF("log2", 1, f_f, scr_ieee754_log2),
  JS_CFUNC_SPECIAL_DEF("sin", 1, f_f, scr_ieee754_sin),
  JS_CFUNC_SPECIAL_DEF("sinh", 1, f_f, scr_ieee754_sinh),
  JS_CFUNC_SPECIAL_DEF("tan", 1, f_f, scr_ieee754_tan),
  JS_CFUNC_SPECIAL_DEF("tanh", 1, f_f, scr_ieee754_tanh),
  JS_CFUNC_DEF("hypot", 2, node_hypot),
};

/* Members whose result in Node comes from locale data this engine does not
 * have. They would answer something else without saying so; a thrown error
 * reaches the build as a diagnostic. */
static const char *const refused[] = {
  "String.prototype.localeCompare", "String.prototype.toLocaleLowerCase",
  "String.prototype.toLocaleUpperCase", "Number.prototype.toLocaleString",
  "BigInt.prototype.toLocaleString", "Date.prototype.toString", "Date.prototype.toTimeString",
  "Date.prototype.toLocaleString", "Date.prototype.toLocaleDateString",
  "Date.prototype.toLocaleTimeString",
};
static JSValue refuse(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
  (void)this_val; (void)argc; (void)argv;
  return JS_ThrowTypeError(ctx, "%s is not available at compile time: its result depends on locale data", refused[magic]);
}
static const JSCFunctionListEntry string_refusals[] = {
  JS_CFUNC_MAGIC_DEF("localeCompare", 1, refuse, 0),
  JS_CFUNC_MAGIC_DEF("toLocaleLowerCase", 0, refuse, 1),
  JS_CFUNC_MAGIC_DEF("toLocaleUpperCase", 0, refuse, 2),
};
static const JSCFunctionListEntry bigint_refusals[] = {
  JS_CFUNC_MAGIC_DEF("toLocaleString", 0, refuse, 4),
};
static const JSCFunctionListEntry date_refusals[] = {
  JS_CFUNC_MAGIC_DEF("toString", 0, refuse, 5),
  JS_CFUNC_MAGIC_DEF("toTimeString", 0, refuse, 6),
  JS_CFUNC_MAGIC_DEF("toLocaleString", 0, refuse, 7),
  JS_CFUNC_MAGIC_DEF("toLocaleDateString", 0, refuse, 8),
  JS_CFUNC_MAGIC_DEF("toLocaleTimeString", 0, refuse, 9),
};

/* Number.prototype.toString with a radix: exact for safe integers, and V8
 * uses its own digit generation for every other value, which this engine
 * does not reproduce. Radix 10 is the shortest round-trip form in both. */
static JSValue engine_number_to_string;
static JSValue node_number_to_string(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  if (argc == 0 || JS_IsUndefined(argv[0])) return JS_Call(ctx, engine_number_to_string, this_val, 0, NULL);
  double radix;
  if (JS_ToFloat64(ctx, &radix, argv[0]) < 0) return JS_EXCEPTION;
  JSValue converted = JS_NewFloat64(ctx, radix);
  JSValue text = JS_Call(ctx, engine_number_to_string, this_val, 1, &converted);
  double value = 0;
  if (JS_IsException(text) || trunc(radix) == 10) return text;
  if (JS_ToFloat64(ctx, &value, this_val) < 0) { JS_FreeValue(ctx, text); return JS_EXCEPTION; }
  if (!isfinite(value) || (value == trunc(value) && fabs(value) <= 9007199254740991.0)) return text;
  JS_FreeValue(ctx, text);
  return JS_ThrowRangeError(ctx, "Number.prototype.toString with a radix other than 10 is available at compile time only for safe integers");
}
static const JSCFunctionListEntry number_members[] = {
  JS_CFUNC_DEF("toString", 1, node_number_to_string),
  JS_CFUNC_MAGIC_DEF("toLocaleString", 0, refuse, 3),
};

/* QuickJS-ng 0.15.1 answers BigInt.asUintN with the two's complement reading
 * of the low bits whenever the top bit of the width is set or the width
 * reaches the value's own size: asUintN(64, -1n) is -1n. The answer is
 * always congruent to the right one, so adding 2^bits to a negative answer
 * corrects it. */
static const char as_uint_n[] =
  "(() => { const engine = BigInt.asUintN, big = BigInt, number = Number, trunc = Math.trunc;"
  " Object.defineProperty(BigInt, 'asUintN', { writable: true, configurable: true,"
  " value: function asUintN(bits, bigint) { const answer = engine(bits, bigint);"
  " return answer < 0n ? answer + (1n << big(trunc(number(bits)) || 0)) : answer; } }); })()";

/* Replaces members of `object` (the engine's own definitions are deleted
 * first: its list installer refuses a name that exists). */
static int replace(JSContext *ctx, JSValueConst object, const JSCFunctionListEntry *members, int count) {
  if (!JS_IsObject(object)) return -1;
  for (int i = 0; i < count; i++) {
    JSAtom name = JS_NewAtom(ctx, members[i].name);
    int deleted = name == JS_ATOM_NULL ? -1 : JS_DeleteProperty(ctx, object, name, 0);
    JS_FreeAtom(ctx, name);
    if (deleted < 0) return -1;
  }
  return JS_SetPropertyFunctionList(ctx, object, members, count);
}
static int replace_on_prototype(JSContext *ctx, JSValueConst global, const char *constructor, const JSCFunctionListEntry *members, int count) {
  JSValue owner = JS_GetPropertyStr(ctx, global, constructor);
  JSValue prototype = JS_GetPropertyStr(ctx, owner, "prototype");
  int status = replace(ctx, prototype, members, count);
  JS_FreeValue(ctx, prototype);
  JS_FreeValue(ctx, owner);
  return status;
}
#define MEMBERS(list) list, (int)(sizeof(list) / sizeof(list[0]))
static int install_node_semantics(JSContext *ctx) {
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue math = JS_GetPropertyStr(ctx, global, "Math");
  int status = replace(ctx, math, MEMBERS(node_math));
  JS_FreeValue(ctx, math);
  JSValue number = JS_GetPropertyStr(ctx, global, "Number");
  JSValue prototype = JS_GetPropertyStr(ctx, number, "prototype");
  engine_number_to_string = JS_GetPropertyStr(ctx, prototype, "toString");
  JS_FreeValue(ctx, prototype);
  JS_FreeValue(ctx, number);
  if (!JS_IsFunction(ctx, engine_number_to_string)) status = -1;
  if (status == 0) status = replace_on_prototype(ctx, global, "Number", MEMBERS(number_members));
  if (status == 0) status = replace_on_prototype(ctx, global, "String", MEMBERS(string_refusals));
  if (status == 0) status = replace_on_prototype(ctx, global, "BigInt", MEMBERS(bigint_refusals));
  if (status == 0) status = replace_on_prototype(ctx, global, "Date", MEMBERS(date_refusals));
  JS_FreeValue(ctx, global);
  if (status == 0) {
    JSValue fixed = JS_Eval(ctx, as_uint_n, sizeof(as_uint_n) - 1, "comptime", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(fixed)) status = -1;
    JS_FreeValue(ctx, fixed);
  }
  return status;
}

typedef struct {
  char *data;
  size_t length, capacity;
  void *active[512];
  size_t depth;
  /* Why the result cannot be written, when the callback itself did not throw. */
  const char *refusal;
} Output;

#define OUTPUT_LIMIT ((size_t)64 * 1024 * 1024)
#define OUTPUT_REFUSAL "the result is larger than 64 MB"

static int append(Output *out, const char *text) {
  size_t size = strlen(text);
  if (size > OUTPUT_LIMIT - out->length) { out->refusal = OUTPUT_REFUSAL; return -1; }
  size_t required = out->length + size + 1;
  if (required > out->capacity) {
    size_t capacity = out->capacity ? out->capacity : 1024;
    while (capacity < required) capacity *= 2;
    char *data = realloc(out->data, capacity);
    if (!data) { out->refusal = "the result is larger than the evaluator's memory"; return -1; }
    out->data = data;
    out->capacity = capacity;
  }
  memcpy(out->data + out->length, text, size + 1);
  out->length += size;
  return 0;
}

static int quote(JSContext *ctx, Output *out, JSValueConst value) {
  size_t length;
  const uint16_t *text = JS_ToCStringLenUTF16(ctx, &length, value);
  if (!text) return -1;
  /* Every unit is at least one byte of output: refuse before copying. */
  if (length > OUTPUT_LIMIT) { out->refusal = OUTPUT_REFUSAL; JS_FreeCStringUTF16(ctx, text); return -1; }
  int status = append(out, "\"");
  for (size_t i = 0; status == 0 && i < length; i++) {
    char escaped[7];
    unsigned ch = text[i];
    if (ch >= 32 && ch < 127 && ch != '"' && ch != '\\') {
      escaped[0] = (char)ch; escaped[1] = 0;
    } else snprintf(escaped, sizeof(escaped), "\\u%04x", ch);
    status = append(out, escaped);
  }
  JS_FreeCStringUTF16(ctx, text);
  return status == 0 ? append(out, "\"") : status;
}

/* ECMAScript's IsArray: an array, or a proxy whose target, through any
 * number of proxies, is one. A revoked proxy throws, as Array.isArray does. */
static int is_array(JSContext *ctx, JSValueConst value) {
  JSValue current = JS_DupValue(ctx, value);
  while (JS_IsProxy(current)) {
    JSValue target = JS_GetProxyTarget(ctx, current);
    JS_FreeValue(ctx, current);
    if (JS_IsException(target)) return -1;
    current = target;
  }
  int result = JS_IsArray(current);
  JS_FreeValue(ctx, current);
  return result;
}

/* Serialize through engine APIs, outside the callback's mutable globals.
 * The guest cannot replace JSON.stringify or install a toJSON hook that
 * changes the value the compiler validates. Getters and proxy traps of the
 * result run here, inside the budget. */
static int encode(JSContext *ctx, Output *out, JSValueConst value) {
  if (JS_IsException(value)) return -1;
  if (JS_IsUndefined(value)) return append(out, "[\"undefined\"]");
  if (JS_IsNull(value)) return append(out, "[\"null\"]");
  if (JS_IsBool(value)) return append(out, JS_ToBool(ctx, value) ? "[\"boolean\",true]" : "[\"boolean\",false]");
  if (JS_IsFunction(ctx, value)) return append(out, "[\"function\"]");
  if (JS_IsSymbol(value)) { out->refusal = "the result contains a symbol"; return -1; }
  if (JS_IsString(value) || JS_IsNumber(value) || JS_IsBigInt(value)) {
    const char *tag = JS_IsString(value) ? "[\"string\"," : JS_IsNumber(value) ? "[\"number\"," : "[\"bigint\",";
    if (append(out, tag) != 0) return -1;
    double number = 1;
    if (JS_IsNumber(value) && JS_ToFloat64(ctx, &number, value) < 0) return -1;
    int status = number == 0 && signbit(number) ? append(out, "\"-0\"") : quote(ctx, out, value);
    return status == 0 ? append(out, "]") : status;
  }
  if (out->depth == 512) { out->refusal = "the result is nested more than 512 levels deep"; return -1; }
  void *identity = JS_VALUE_GET_PTR(value);
  for (size_t i = 0; i < out->depth; i++) {
    if (out->active[i] == identity) { out->refusal = "the result contains itself"; return -1; }
  }
  out->active[out->depth++] = identity;
  int array = is_array(ctx, value);
  int status = array < 0 ? -1 : 0;
  if (array > 0) {
    int64_t length = 0;
    if (JS_GetLength(ctx, value, &length) < 0) status = -1;
    else if (length > 1000000) { out->refusal = "the result has an array of more than 1000000 elements"; status = -1; }
    if (status == 0) status = append(out, "[\"array\",[");
    for (int64_t i = 0; status == 0 && i < length; i++) {
      if (i != 0) status = append(out, ",");
      JSValue item = JS_GetPropertyUint32(ctx, value, (uint32_t)i);
      if (status == 0) status = encode(ctx, out, item);
      JS_FreeValue(ctx, item);
    }
  } else if (array == 0) {
    JSPropertyEnum *properties = NULL;
    uint32_t length = 0;
    status = JS_GetOwnPropertyNames(ctx, &properties, &length, value, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY);
    if (status == 0) status = append(out, "[\"object\",[");
    for (uint32_t i = 0; status == 0 && i < length; i++) {
      if (i != 0) status = append(out, ",");
      if (status == 0) status = append(out, "[");
      JSValue key = JS_AtomToString(ctx, properties[i].atom);
      if (status == 0) status = quote(ctx, out, key);
      JS_FreeValue(ctx, key);
      if (status == 0) status = append(out, ",");
      JSValue item = JS_GetProperty(ctx, value, properties[i].atom);
      if (status == 0) status = encode(ctx, out, item);
      JS_FreeValue(ctx, item);
      if (status == 0) status = append(out, "]");
    }
    JS_FreePropertyEnum(ctx, properties, length);
  }
  out->depth--;
  return status == 0 ? append(out, "]]") : status;
}

/* An error line. `text` is plain ASCII with nothing to escape. */
static int fail(Output *out, const char *kind, const char *text) {
  out->length = 0;
  return append(out, "[\"error\",\"") == 0 && append(out, kind) == 0 && append(out, "\",\"") == 0 &&
    append(out, text) == 0 && append(out, "\"]") == 0 ? 0 : -1;
}

static int has_text(JSContext *ctx, JSValueConst value, const char *expected) {
  const char *text = JS_IsString(value) ? JS_ToCString(ctx, value) : NULL;
  int result = text && strcmp(text, expected) == 0;
  if (text) JS_FreeCString(ctx, text);
  return result;
}

/* What the callback threw: an error's message, or the value as a string. */
static int fail_thrown(JSContext *ctx, Output *out, JSValueConst exception, int out_of_memory) {
  JSValue message = JS_IsObject(exception) ? JS_GetPropertyStr(ctx, exception, "message") : JS_UNDEFINED;
  if (out_of_memory && (JS_IsNull(exception) || (JS_IsError(exception) && has_text(ctx, message, "out of memory")))) {
    JS_FreeValue(ctx, message);
    return fail(out, "memory", "");
  }
  JSValue text = JS_IsString(message) ? JS_DupValue(ctx, message) : JS_ToString(ctx, exception);
  out->length = 0;
  int status = JS_IsString(text) && append(out, "[\"error\",\"thrown\",") == 0 && quote(ctx, out, text) == 0 ? append(out, "]") : -1;
  JS_FreeValue(ctx, text);
  JS_FreeValue(ctx, message);
  return status;
}

int main(int argc, char **argv) {
  if (argc != 4) { fputs("usage: scriptc-comptime <javascript> <timeout-ms> <memory-mb>\n", stderr); return 2; }
  char *end = NULL;
  errno = 0;
  long timeout = strtol(argv[2], &end, 10);
  if (errno || !end || *end || timeout < 1 || timeout > 60000) {
    fputs("invalid compile-time budget\n", stderr); return 2;
  }
  long memory = strtol(argv[3], &end, 10);
  if (errno || !end || *end || memory < 1 || memory > 4096) {
    fputs("invalid compile-time memory limit\n", stderr); return 2;
  }
  FILE *file = fopen(argv[1], "rb");
  if (!file) { perror("compile-time input"); return 2; }
  if (fseek(file, 0, SEEK_END) != 0) { fclose(file); return 2; }
  long size = ftell(file);
  if (size < 0 || size > 16 * 1024 * 1024 || fseek(file, 0, SEEK_SET) != 0) { fclose(file); return 2; }
  char *source = malloc((size_t)size + 1);
  if (!source) { fclose(file); return 2; }
  if (fread(source, 1, (size_t)size, file) != (size_t)size) { free(source); fclose(file); return 2; }
  fclose(file);
  source[size] = 0;
  Heap heap = { 0, SIZE_MAX, 0 };
  JSRuntime *rt = JS_NewRuntime2(&heap_functions, &heap);
  JSContext *ctx = rt ? JS_NewContext(rt) : NULL;
  if (!ctx || install_node_semantics(ctx) != 0 || start_watchdog(timeout + WATCHDOG_GRACE_MS) != 0) {
    fputs("the compile-time evaluator could not start\n", stderr); return 2;
  }
  heap.limit = (size_t)memory * 1024 * 1024;
  JS_SetMaxStackSize(rt, 2 * 1024 * 1024);
  Budget budget = { now_ms() + (uint64_t)timeout, 0 };
  JS_SetInterruptHandler(rt, interrupt, &budget);
  int unhandled = 0;
  JS_SetHostPromiseRejectionTracker(rt, track_rejection, &unhandled);
  JSValue result = JS_Eval(ctx, source, (size_t)size, "comptime", JS_EVAL_TYPE_GLOBAL);
  Output out = {0};
  int status;
  int encoded = !JS_IsException(result) && encode(ctx, &out, result) == 0;
  /* Promise reactions never run here. Node runs them, and reports an
   * unhandled rejection, after the callback has returned, which no value
   * computed at compile time can reflect. The result's accessors and proxy
   * traps are the callback's code too, so the check follows the encoding. */
  if (encoded && JS_IsJobPending(rt)) status = fail(&out, "refused", "the callback left promise reactions pending, and they never run at compile time");
  else if (encoded && unhandled > 0) status = fail(&out, "refused", "the callback left a rejected promise unhandled");
  else if (encoded) status = 0;
  else if (budget.interrupted) status = fail(&out, "timeout", "");
  else if (out.refusal) status = fail(&out, "refused", out.refusal);
  else {
    /* The memory the callback filled may still be held, and reading what it
     * threw needs a little. */
    int out_of_memory = heap.refused;
    heap.limit += 1024 * 1024;
    JSValue exception = JS_GetException(ctx);
    status = fail_thrown(ctx, &out, exception, out_of_memory);
    /* Reading it ran the callback's code again: an accessor, a toString. */
    if (budget.interrupted) status = fail(&out, "timeout", "");
    else if (status != 0) status = fail(&out, "thrown", "a value that has no string form");
  }
  /* The process ends here, and its memory goes back with it. */
  if (atomic_flag_test_and_set(&output_claimed)) wait_forever();
  if (status != 0 || fwrite(out.data, 1, out.length, stdout) != out.length || fputc('\n', stdout) == EOF || fflush(stdout) != 0) return 2;
  return 0;
}
