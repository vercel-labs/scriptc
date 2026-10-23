/* JSON + dynamic values (see scr_runtime.h for the API contract).
 *
 * - The ScrDyn dyn is the runtime shape of `unknown`: refcounted, owning
 *   its children; releasing the root frees the tree recursively.
 * - scr_json_parse is a full RFC 8259 recursive-descent parser: null/
 *   true/false, numbers (strtod after a strict grammar check — doubles
 *   only, like JS), strings with every escape including \uXXXX (encoded to
 *   WTF-8; surrogate pairs combine, lone surrogates stay lone, like JS),
 *   arrays, objects (later duplicate keys win, like JS), and the
 *   four JSON whitespace characters. Syntax errors THROW catchable
 *   SyntaxError instances (the depth cap a RangeError, like V8's) whose
 *   messages are shaped like Node's V8 texts ("Unexpected end of JSON
 *   input", "Unexpected token 'x', \"...\" is not valid JSON") —
 *   APPROXIMATE message fidelity by design (SEMANTICS.md; e.name is exact,
 *   e.message is ours), pinned by the runtime C tests.
 * - scr_dyn_check_fail is the shared failure path of the compiler-emitted
 *   dynCheck builders: a TypeError instance carrying "expected <want> at
 *   <path>, got <kind>", thrown through the exception cell.
 *   scriptc-specific — JS `as` never checks anything (the headline
 *   divergence in SEMANTICS.md).
 * - ScrJsonBuf backs the compiler-emitted type-directed stringify
 *   serializers (and the error messages here).
 */
#include "scr_runtime.h"
#include "scr_key.h"

/* Programs with dynamic-tier code link the SCR_JS_TIER build of this unit:
 * its object nodes carry the tier's hidden class (ScrDyn.v.obj.shape), and
 * every allocation and change to an object's key set resets it so the
 * tier recomputes it on its next cache miss. Other programs link the
 * ordinary build, where this expands to nothing. */
#ifdef SCR_JS_TIER
#define SCR_JS_SHAPE_RESET(d) ((d)->v.obj.shape = NULL)
#else
#define SCR_JS_SHAPE_RESET(d) ((void)0)
#endif

static SCR_TL ScrDyn *scr_builtin_object_prototype;

const ScrDateClassHooks *scr_date_class_hooks = NULL;

/* The checked-dynamic Error.prototype (scr_dyn_error_prototype) is not the
 * prototype of scriptc's Error instances, so a change to it would not reach
 * them: every mutation throws. */
static SCR_TL ScrDyn *scr_builtin_error_prototype;
static bool scr_dyn_error_prototype_fence(const ScrDyn *value) {
  if (!value || value != scr_builtin_error_prototype) return false;
  static const char message[] = "Error.prototype mutation is not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return true;
}

SCR_TL const ScrHandleStreamHooks *scr_handle_stream_hooks = NULL;

/* Constructor capsules expose identity and name/length, but do not model
 * per-class static property tables yet. Never report a fabricated empty view. */
static bool scr_dyn_class_reflection_fence(const ScrDyn *value) {
  if (value && value == scr_builtin_object_prototype) {
    static const char message[] = "scriptc: Object.prototype reflection and mutation are not supported yet";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return true;
  }
  if (!value || value->kind != SCR_DYN_FUNC || !value->v.fn.class_obj || value->v.fn.class_obj->static_data) return false;
  static const char message[] = "scriptc: class reflection through unknown is not supported";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  return true;
}

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Live dyn-node count for the RC audit lane (-DSCR_RC_AUDIT); same contract
 * as scr_str_live_count in scr_string.c. */
#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_dyns = 0;
long scr_dyn_live_count(void) { return scr_live_dyns; }
/* A published dyn value is immortal: it is never freed, so it leaves the count. */
void scr_dyn_live_forget(void) { scr_live_dyns--; }
#endif

static void scr_json_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

static SCR_TL ScrDyn *scr_iterator_symbol;
static SCR_TL ScrDyn *scr_async_iterator_symbol;
static SCR_TL ScrDyn *scr_to_primitive_symbol;
static bool scr_dyn_generator(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_TYPED_REF &&
    (value->v.typed_ref.type_key[0] == 'g' || value->v.typed_ref.type_key[0] == 'a') &&
    (!strncmp(value->v.typed_ref.type_key, "generator<", 10) || !strncmp(value->v.typed_ref.type_key, "async-generator<", 16));
}
static bool scr_dyn_generator_symbol(const ScrDyn *value, const ScrDyn *key) {
  const ScrDyn *symbol = value->v.typed_ref.type_key[0] == 'a' ? scr_async_iterator_symbol : scr_iterator_symbol;
  return symbol && key->v.symbol.value == symbol->v.symbol.value;
}
static ScrDyn *scr_builtin_iterator_method(const ScrDyn *value);
static bool scr_builtin_iterable(const ScrDyn *value) {
  return value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_STR || value->kind == SCR_DYN_BYTES ||
    (scr_dyn_generator(value) && value->v.typed_ref.type_key[0] != 'a') ||
    (value->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(value)) ||
    (value->kind == SCR_DYN_HANDLE && (value->v.handle.tag == SCR_DYNH_ITERATOR || value->v.handle.tag == SCR_DYNH_ITERATOR_HELPER || value->v.handle.tag == SCR_DYNH_MAP || value->v.handle.tag == SCR_DYNH_SET ||
      scr_dyn_handle_ops_of(value)->iter_pack || scr_dyn_handle_ops_of(value)->iter_step));
}
static bool scr_iterator_object(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_OBJ: case SCR_DYN_ARR: case SCR_DYN_BYTES:
  case SCR_DYN_FUNC: case SCR_DYN_HANDLE: case SCR_DYN_PROMISE:
  case SCR_DYN_TYPED_REF: case SCR_DYN_PROXY:
    return true;

  default: return false;
  }
}

ScrDyn *scr_dyn_iterator_result(ScrDyn *value) {
  if (!scr_iterator_object(value)) {
    /* V8 names a primitive result: "Iterator result 5 is not an object". */
    bool primitive = value->kind == SCR_DYN_NUM || value->kind == SCR_DYN_STR || value->kind == SCR_DYN_BOOL ||
                     value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL ||
                     value->kind == SCR_DYN_BIGINT || value->kind == SCR_DYN_SYMBOL;
    ScrStr *text = primitive ? scr_dyn_string_constructor(value) : NULL;
    if (!text) {
      static const char message[] = "Iterator result is not an object";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    static const char head[] = "Iterator result ", tail[] = " is not an object";
    ScrStr *a = scr_str_new(head, sizeof head - 1);
    ScrStr *b = scr_str_concat(a, text);
    ScrStr *c = scr_str_new(tail, sizeof tail - 1);
    ScrStr *message = scr_str_concat(b, c);
    scr_str_release(a);
    scr_str_release(b);
    scr_str_release(c);
    scr_str_release(text);
    scr_throw_error(SCR_ERR_TYPE, message);
    return NULL;
  }
  return scr_dyn_retain(value);
}

static void scr_iterator_symbol_cleanup(void) {
  scr_dyn_release(scr_iterator_symbol);
  scr_iterator_symbol = NULL;
}

static void scr_async_iterator_symbol_cleanup(void) {
  scr_dyn_release(scr_async_iterator_symbol);
  scr_async_iterator_symbol = NULL;
}

static SCR_TL ScrDyn *scr_async_dispose_symbol;

static void scr_async_dispose_symbol_cleanup(void) {
  scr_dyn_release(scr_async_dispose_symbol);
  scr_async_dispose_symbol = NULL;
}

/* Symbol.asyncDispose, registered by the symbol unit when the program
 * first names it, for handle classes outside that unit (a Worker). */
void scr_dyn_install_async_dispose_symbol(ScrDyn *key) {
  if (scr_async_dispose_symbol) return;
  scr_async_dispose_symbol = scr_dyn_retain(key);
  scr_atexit(scr_async_dispose_symbol_cleanup);
}

bool scr_dyn_is_async_dispose_symbol(const ScrDyn *key) {
  return scr_async_dispose_symbol && key->kind == SCR_DYN_SYMBOL &&
         key->v.symbol.value == scr_async_dispose_symbol->v.symbol.value;
}

static void scr_to_primitive_symbol_cleanup(void) {
  scr_dyn_release(scr_to_primitive_symbol);
  scr_to_primitive_symbol = NULL;
}

void scr_dyn_install_to_primitive_symbol(ScrDyn *key) {
  if (scr_to_primitive_symbol) return;
  scr_to_primitive_symbol = scr_dyn_retain(key);
  scr_atexit(scr_to_primitive_symbol_cleanup);
}

void scr_dyn_install_async_iterator_symbol(ScrDyn *key) {
  if (scr_async_iterator_symbol) return;
  scr_async_iterator_symbol = scr_dyn_retain(key);
  scr_atexit(scr_async_iterator_symbol_cleanup);
}

/* Symbol.hasInstance, installed when the program first evaluates it: a
 * function can only define a hook after reading the symbol. */
static SCR_TL ScrDyn *scr_has_instance_symbol;
static void scr_has_instance_symbol_cleanup(void) {
  scr_dyn_release(scr_has_instance_symbol);
  scr_has_instance_symbol = NULL;
}
void scr_dyn_install_has_instance_symbol(ScrDyn *key) {
  if (scr_has_instance_symbol) return;
  scr_has_instance_symbol = scr_dyn_retain(key);
  scr_atexit(scr_has_instance_symbol_cleanup);
}

void scr_dyn_install_iterator_symbol(ScrDyn *key) {
  if (scr_iterator_symbol) return;
  scr_iterator_symbol = scr_dyn_retain(key);
  scr_atexit(scr_iterator_symbol_cleanup);
  ScrDyn *prototype = scr_dyn_array_prototype_base();
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_array_values_function());
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *defined = scr_dyn_define_property(prototype, key, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(descriptor);
  scr_dyn_release(prototype);
}

/* ── output buffer ─────────────────────────────────────────────────────
 * The buffer IS a growing ScrStr allocation (data points at its data[]),
 * so scr_jb_finish hands the bytes over without a copy. A size hint
 * remembers the last finished capacity: a stringify loop allocates once
 * per document instead of doubling its way up every round.
 */

/* The ScrStr block behind a non-empty buffer. */
#define SCR_JB_STR(b) ((ScrStr *)((char *)(b)->data - offsetof(ScrStr, data)))

static SCR_TL size_t scr_jb_hint = 64;

void scr_jb_init(ScrJsonBuf *b) {
  b->data = NULL;
  b->len = 0;
  b->cap = 0;
  b->seen = NULL;
  b->seen_len = 0;
  b->seen_cap = 0;
}

static void scr_jb_grow(ScrJsonBuf *b, size_t need) {
  if (need > SIZE_MAX - sizeof(ScrStr) - 1 - b->len) scr_json_oom();
  size_t required = b->len + need;
  if (required <= b->cap) return;
  if (!b->data) { /* first allocation: len == 0 */
    size_t cap = scr_jb_hint >= need ? scr_jb_hint : need;
    ScrStr *s = scr_str_alloc_raw(0, cap);
    b->data = s->data;
    b->cap = s->cap; /* a reused spare block may be larger */
    return;
  }
  size_t cap = b->cap;
  while (cap < required) {
    if (cap > (SIZE_MAX - sizeof(ScrStr) - 1) / 2) {
      cap = required;
      break;
    }
    cap *= 2;
  }
  ScrStr *s = scr_str_regrow(SCR_JB_STR(b), cap);
  b->data = s->data;
  b->cap = cap;
}

/* Abandon a buffer (parser error paths). */
static void scr_jb_dispose(ScrJsonBuf *b) {
  if (b->data) scr_str_release(SCR_JB_STR(b));
  free(b->seen);
  scr_jb_init(b);
}

void scr_jb_abandon(ScrJsonBuf *b) { scr_jb_dispose(b); }

void scr_jb_putc(ScrJsonBuf *b, char c) {
  scr_jb_grow(b, 1);
  b->data[b->len++] = c;
}

/* A span that may start with a lone low surrogate: after a lone high one,
 * the pair becomes one 4-byte character (canonical storage, scr_runtime.h). */
static __attribute__((noinline, cold)) void scr_jb_write_lead_ed(ScrJsonBuf *b, const char *s,
                                                                 size_t n) {
  bool joins = scr_wtf8_joins(b->data, b->len, s, n);
  scr_jb_grow(b, n);
  memcpy(b->data + b->len, s, n);
  if (!joins) {
    b->len += n;
    return;
  }
  size_t seam = b->len - 3;
  b->len = seam + scr_wtf8_fuse(b->data + seam, n + 3);
}

void scr_jb_write(ScrJsonBuf *b, const char *s, size_t n) {
  if (n == 0) return;
  if (__builtin_expect((unsigned char)s[0] == 0xED, 0) && scr_wtf8_any()) {
    scr_jb_write_lead_ed(b, s, n);
    return;
  }
  scr_jb_grow(b, n);
  memcpy(b->data + b->len, s, n);
  b->len += n;
}

void scr_jb_write_utf8(ScrJsonBuf *b, const char *s, size_t n) {
  if (n == 0) return;
  scr_jb_grow(b, n);
  memcpy(b->data + b->len, s, n);
  b->len += n;
}

void scr_jb_put_str(ScrJsonBuf *b, const ScrStr *s) {
  scr_jb_write(b, s->data, s->len);
}

void scr_jb_puts(ScrJsonBuf *b, const char *s) { scr_jb_write(b, s, strlen(s)); }

void scr_jb_put_number(ScrJsonBuf *b, double v) {
  /* scr_f64_to_str writes at most 31 ASCII bytes and a NUL into the
   * buffer's spare capacity; the NUL is not counted. */
  scr_jb_grow(b, 32);
  b->len += scr_f64_to_str(v, b->data + b->len);
}

void scr_jb_put_f64(ScrJsonBuf *b, double v) {
  /* JSON.stringify number rules: non-finite → null, -0 → "0" (String(-0)
   * is "0" too, so scr_f64_to_str would agree — the zero test just makes
   * the rule explicit), else shortest-roundtrip digits. */
  if (!isfinite(v)) {
    scr_jb_puts(b, "null");
    return;
  }
  if (v == 0) {
    scr_jb_putc(b, '0');
    return;
  }
  scr_jb_put_number(b, v);
}

/* Find the next quote, backslash or control byte. memcpy keeps the word
 * loads unaligned-safe, and the length guard never reads past the input.
 * Borrow propagation can mark extra lanes, but only above a lane that
 * holds a special byte, so on little-endian hosts the lowest marked lane
 * is the answer; other hosts inspect the marked word byte by byte. High
 * UTF-8 bytes are ordinary data. */
static size_t scr_json_plain_bytes(const char *data, size_t len) {
  const uint64_t ones = UINT64_C(0x0101010101010101);
  const uint64_t high = UINT64_C(0x8080808080808080);
  size_t i = 0;
  while (len - i >= sizeof(uint64_t)) {
    uint64_t word;
    memcpy(&word, data + i, sizeof word);
    uint64_t quotes = word ^ (ones * '"');
    uint64_t slashes = word ^ (ones * '\\');
    uint64_t special = ((quotes - ones) & ~quotes) |
                       ((slashes - ones) & ~slashes) |
                       ((word - ones * 0x20) & ~word);
    special &= high;
    if (special) {
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
      /* A borrow only marks lanes above a lane that really matched, so
       * the lowest marked lane is the first special byte. */
      return i + (size_t)__builtin_ctzll(special) / 8;
#else
      break;
#endif
    }
    i += sizeof word;
  }
  /* The last 1..7 bytes as one word: two overlapping 4-byte loads, or the
   * first, middle and last byte of a shorter rest with the remaining lanes
   * filled with a plain byte. A plain rest (the common case: most strings
   * are short) ends the scan; otherwise the bytes are inspected one by one. */
  size_t rest = len - i;
  if (rest) {
    uint64_t word;
    if (rest >= 4) {
      uint32_t lo, hi;
      memcpy(&lo, data + i, sizeof lo);
      memcpy(&hi, data + len - 4, sizeof hi);
      word = (uint64_t)lo | (uint64_t)hi << 32;
    } else {
      word = (uint64_t)(unsigned char)data[i] | (uint64_t)(unsigned char)data[i + rest / 2] << 8 |
             (uint64_t)(unsigned char)data[len - 1] << 16 | UINT64_C(0x4141414141000000);
    }
    uint64_t quotes = word ^ (ones * '"');
    uint64_t slashes = word ^ (ones * '\\');
    uint64_t special = ((quotes - ones) & ~quotes) |
                       ((slashes - ones) & ~slashes) |
                       ((word - ones * 0x20) & ~word);
    if (!(special & high)) return len;
  }
  while (i < len) {
    unsigned char c = (unsigned char)data[i];
    if (c < 0x20 || c == '"' || c == '\\') break;
    i++;
  }
  return i;
}

/* JSON string text: the quotes (when `quoted`) around data with every
 * escape applied. */
static inline __attribute__((always_inline)) void scr_jb_put_json_chars(ScrJsonBuf *b,
                                                                      const char *data,
                                                                      size_t len, bool quoted) {
  if (len > SIZE_MAX - 2) scr_json_oom();
  size_t run = scr_json_plain_bytes(data, len);
  /* The overwhelmingly common unescaped string needs one capacity check,
   * including both quotes, and no per-byte builder calls. */
  scr_jb_grow(b, run + 2);
  if (quoted) b->data[b->len++] = '"';
  if (run) memcpy(b->data + b->len, data, run);
  b->len += run;
  size_t i = run;
  while (i < len) {
    unsigned char c = (unsigned char)data[i++];
    char escaped[6] = {'\\', 0, '0', '0', 0, 0};
    size_t count = 2;
    switch (c) {
    case '"': escaped[1] = '"'; break;
    case '\\': escaped[1] = '\\'; break;
    case '\n': escaped[1] = 'n'; break;
    case '\r': escaped[1] = 'r'; break;
    case '\t': escaped[1] = 't'; break;
    case '\b': escaped[1] = 'b'; break;
    case '\f': escaped[1] = 'f'; break;
    default: {
      static const char hex[] = "0123456789abcdef";
      escaped[1] = 'u';
      escaped[4] = hex[c >> 4];
      escaped[5] = hex[c & 15];
      count = 6;
    }
    }
    run = scr_json_plain_bytes(data + i, len - i);
    if (run > SIZE_MAX - count) scr_json_oom();
    scr_jb_grow(b, count + run);
    memcpy(b->data + b->len, escaped, count);
    b->len += count;
    if (run) memcpy(b->data + b->len, data + i, run);
    b->len += run;
    i += run;
  }
  if (quoted) {
    scr_jb_grow(b, 1);
    b->data[b->len++] = '"';
  }
}

static void scr_jb_put_json_text(ScrJsonBuf *b, const char *data, size_t len) {
  scr_jb_put_json_chars(b, data, len, true);
}

/* Text that may hold lone surrogates: JSON.stringify writes each as a
 * lowercase \udXXX escape. */
static __attribute__((noinline)) void scr_jb_put_json_lone(ScrJsonBuf *b, const char *data,
                                                           size_t len) {
  const char *end = data + len, *hit = scr_wtf8_find_surrogate(data, len);
  if (!hit) {
    scr_jb_put_json_text(b, data, len);
    return;
  }
  static const char hex[] = "0123456789abcdef";
  scr_jb_putc(b, '"');
  for (const char *p = data;; p = hit + 3, hit = scr_wtf8_find_surrogate(p, (size_t)(end - p))) {
    scr_jb_put_json_chars(b, p, (size_t)((hit ? hit : end) - p), false);
    if (!hit) break;
    unsigned unit = ((unsigned char)hit[1] & 0x3Fu) << 6 | ((unsigned char)hit[2] & 0x3Fu);
    char escaped[6] = {'\\', 'u', 'd', hex[unit >> 8], hex[(unit >> 4) & 15], hex[unit & 15]};
    scr_jb_write(b, escaped, sizeof escaped);
  }
  scr_jb_putc(b, '"');
}

static void scr_jb_put_json_span(ScrJsonBuf *b, const char *data, size_t len) {
  if (__builtin_expect(scr_wtf8_any(), 0)) scr_jb_put_json_lone(b, data, len);
  else scr_jb_put_json_text(b, data, len);
}

void scr_jb_put_json_str(ScrJsonBuf *b, const ScrStr *s) {
  if (__builtin_expect(scr_wtf8_any(), 0) && !s->ascii) scr_jb_put_json_lone(b, s->data, s->len);
  else scr_jb_put_json_chars(b, s->data, s->len, true);
}

ScrStr *scr_jb_finish(ScrJsonBuf *b) {
  free(b->seen);
  b->seen = NULL;
  b->seen_len = 0;
  b->seen_cap = 0;
  if (!b->data) return scr_str_new("", 0);
  ScrStr *s = SCR_JB_STR(b);
  s->len = b->len;
  s->data[b->len] = '\0';
  /* Remember the size class for the next buffer (bounded so one giant
   * document cannot pin big allocations forever). */
  if (s->cap > scr_jb_hint) scr_jb_hint = s->cap < (1 << 16) ? s->cap : (1 << 16);
  scr_jb_init(b);
  return s;
}

/* Write newline and a repeated gap with one reservation. Copies never
 * overlap: each doubling reads only the already initialized prefix. */
static void scr_jb_indent(ScrJsonBuf *b, const char *gap, size_t gap_len, size_t depth) {
  if (gap_len && depth > (SIZE_MAX - 1) / gap_len) scr_json_oom();
  size_t count = gap_len * depth;
  scr_jb_grow(b, count + 1);
  b->data[b->len++] = '\n';
  if (!count) return;
  memcpy(b->data + b->len, gap, gap_len);
  size_t filled = gap_len;
  while (filled < count) {
    size_t take = filled < count - filled ? filled : count - filled;
    memcpy(b->data + b->len + filled, b->data + b->len, take);
    filled += take;
  }
  b->len += count;
}

ScrStr *scr_json_indent(const ScrStr *compact, const char *gap, size_t gap_len) {
  if (!gap_len) return scr_str_retain((ScrStr *)compact);
  /* Node stops copying the gap at its first NUL but still inserts breaks
   * and colon spaces when the original gap is nonempty. */
  const char *end = memchr(gap, 0, gap_len);
  if (end) gap_len = (size_t)(end - gap);
  ScrJsonBuf b;
  scr_jb_init(&b);
  size_t depth = 0, start = 0, i = 0;
  while (i < compact->len) {
    char c = compact->data[i];
    if (c == '"') {
      /* Quoted punctuation is data. Scan ordinary runs and skip the byte
       * after each backslash so an escaped quote cannot end this string. */
      i++;
      while (i < compact->len) {
        i += scr_json_plain_bytes(compact->data + i, compact->len - i);
        if (i == compact->len) break;
        if (compact->data[i] == '\\') {
          i += compact->len - i >= 2 ? 2 : 1;
        } else {
          i++;
          break;
        }
      }
      continue;
    }
    if (c == '{' || c == '[') {
      char closer = c == '{' ? '}' : ']';
      if (i + 1 < compact->len && compact->data[i + 1] == closer) {
        i += 2;
        continue;
      }
      scr_jb_write(&b, compact->data + start, i + 1 - start);
      scr_jb_indent(&b, gap, gap_len, ++depth);
      start = ++i;
      continue;
    }
    if (c == '}' || c == ']') {
      scr_jb_write(&b, compact->data + start, i - start);
      scr_jb_indent(&b, gap, gap_len, --depth);
      start = i++;
      continue;
    }
    if (c == ',' || c == ':') {
      scr_jb_write(&b, compact->data + start, i + 1 - start);
      if (c == ',') scr_jb_indent(&b, gap, gap_len, depth);
      else scr_jb_putc(&b, ' ');
      start = ++i;
      continue;
    }
    i++;
  }
  scr_jb_write(&b, compact->data + start, compact->len - start);
  return scr_jb_finish(&b);
}

/* ── circular-structure detection ──────────────────────────────────────
 * RECURSIVE record types permit runtime reference cycles; JSON.stringify
 * of a cyclic value throws V8's exact TypeError. The compiler-emitted
 * walkers over cycle-CAPABLE containers (records whose shape carries a
 * collector header, arrays of them, tuple shapes alike) bracket their
 * bodies with enter/leave and stamp the current member edge before each
 * cycle-capable member write; everything acyclic pays nothing. Detection
 * is STACK membership (a DAG serializes the shared subtree twice, exactly
 * like Node — only a path back to an ancestor is circular).
 *
 * The message mirrors V8's ConstructCircularStructureErrorMessage byte
 * for byte: the starting object (where the repeat lands), one line per
 * hop from it to the top of the stack ("property 'x' -> object with
 * constructor 'Y'" / "index N -> ..."), the middle elided as "..." when
 * there are more than three hops (first two + last one shown), and the
 * closing edge. Constructor names are exactly 'Object'/'Array' — the only
 * containers JSON-safe types admit. */
typedef struct ScrJsonSeenEnt {
  const void *ptr;
  bool is_array;
  const char *prop;       /* static property edge (emitted C literal) */
  size_t prop_len;        /* its length, or SIZE_MAX for a NUL-terminated name */
  const ScrStr *prop_str; /* overflow-key edge (borrowed for the write) */
  size_t index;           /* array/tuple index edge */
} ScrJsonSeenEnt;

static void scr_jb_put_edge(ScrJsonBuf *m, const ScrJsonSeenEnt *e) {
  if (e->prop || e->prop_str) {
    scr_jb_puts(m, "property '");
    if (e->prop) scr_jb_write(m, e->prop, e->prop_len == SIZE_MAX ? strlen(e->prop) : e->prop_len);
    else scr_jb_write(m, e->prop_str->data, e->prop_str->len);
    scr_jb_putc(m, '\'');
    return;
  }
  scr_jb_puts(m, "index ");
  scr_jb_put_f64(m, (double)e->index);
}

static void scr_jb_put_ctor(ScrJsonBuf *m, bool is_array) {
  scr_jb_puts(m, is_array ? "object with constructor 'Array'" : "object with constructor 'Object'");
}

bool scr_jb_enter(ScrJsonBuf *b, const void *v, bool is_array) {
  for (size_t i = 0; i < b->seen_len; i++) {
    if (b->seen[i].ptr != v) continue;
    ScrJsonBuf m;
    scr_jb_init(&m);
    scr_jb_puts(&m, "Converting circular structure to JSON\n    --> starting at ");
    scr_jb_put_ctor(&m, b->seen[i].is_array);
    const size_t n = b->seen_len;
    const size_t hops = n - 1 - i; /* intermediate lines (j = i+1 .. n-1) */
    for (size_t j = i + 1; j < n; j++) {
      if (hops > 3 && j - (i + 1) == 2) {
        scr_jb_puts(&m, "\n    |     ...");
        j = n - 2; /* the loop increment lands on the LAST hop */
        continue;
      }
      scr_jb_puts(&m, "\n    |     ");
      scr_jb_put_edge(&m, &b->seen[j - 1]);
      scr_jb_puts(&m, " -> ");
      scr_jb_put_ctor(&m, b->seen[j].is_array);
    }
    scr_jb_puts(&m, "\n    --- ");
    scr_jb_put_edge(&m, &b->seen[n - 1]);
    scr_jb_puts(&m, " closes the circle");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&m));
    return false;
  }
  if (b->seen_len == b->seen_cap) {
    size_t cap = b->seen_cap ? b->seen_cap * 2 : 8;
    ScrJsonSeenEnt *grown = realloc(b->seen, cap * sizeof *grown);
    if (!grown) scr_json_oom();
    b->seen = grown;
    b->seen_cap = cap;
  }
  ScrJsonSeenEnt *e = &b->seen[b->seen_len++];
  e->ptr = v;
  e->is_array = is_array;
  e->prop = NULL;
  e->prop_len = SIZE_MAX;
  e->prop_str = NULL;
  e->index = 0;
  return true;
}

void scr_jb_leave(ScrJsonBuf *b) {
  if (b->seen_len > 0) b->seen_len--;
}

void scr_jb_edge_prop(ScrJsonBuf *b, const char *name) {
  ScrJsonSeenEnt *e = &b->seen[b->seen_len - 1];
  e->prop = name;
  e->prop_len = SIZE_MAX;
  e->prop_str = NULL;
}

/* A property edge whose name is not NUL-terminated (a declared field name
 * from a record source's strided table). */
static void scr_jb_edge_span(ScrJsonBuf *b, const char *name, size_t len) {
  ScrJsonSeenEnt *e = &b->seen[b->seen_len - 1];
  e->prop = name;
  e->prop_len = len;
  e->prop_str = NULL;
}

void scr_jb_edge_key(ScrJsonBuf *b, const ScrStr *key) {
  ScrJsonSeenEnt *e = &b->seen[b->seen_len - 1];
  e->prop = NULL;
  e->prop_str = key;
}

void scr_jb_edge_idx(ScrJsonBuf *b, size_t i) {
  ScrJsonSeenEnt *e = &b->seen[b->seen_len - 1];
  e->prop = NULL;
  e->prop_str = NULL;
  e->index = i;
}

/* ── circular guard for the typed→dyn converters (sc_td_*) ────────────
 * A recursive-typed value crossing into a checked-dynamic slot DEEP-
 * COPIES into the checked-dynamic tree; a cyclic value has no finite copy. Node never
 * copies (an unknown-typed binding shares the reference), so there is no
 * Node-exact error to throw — the conversion traps instead
 * (SEMANTICS.md documents the divergence). The emitted converters over
 * cycle-capable containers bracket their walks with enter/leave; the
 * stack is global (conversions never interleave). */
static SCR_TL const void **g_td_seen;
static SCR_TL size_t g_td_nseen;
static SCR_TL size_t g_td_cap;

void scr_dyn_from_enter(const void *v) {
  for (size_t i = 0; i < g_td_nseen; i++) {
    if (g_td_seen[i] == v) {
      scr_trap("scriptc: cannot convert a circular structure into a checked-dynamic value "
               "(unknown-typed slots deep-copy; break the cycle first)\n");
    }
  }
  if (g_td_nseen == g_td_cap) {
    g_td_cap = g_td_cap ? g_td_cap * 2 : 8;
    const void **grown = realloc(g_td_seen, g_td_cap * sizeof *grown);
    if (!grown) scr_json_oom();
    g_td_seen = grown;
  }
  g_td_seen[g_td_nseen++] = v;
}

void scr_dyn_from_leave(void) {
  if (g_td_nseen > 0) g_td_nseen--;
}

/* ── dyn lifecycle ─────────────────────────────────────────────────────
 * Parse/release churn (a JSON round-trip loop allocates and frees every
 * node each iteration) runs on freelists instead of calloc/free: one list
 * per shape so arr/obj nodes keep their items/entries buffer across
 * reuse — a loop re-parsing the same document shape stops calling malloc
 * altogether. The freelist link overlays v.arr.len (first union word), so
 * a recycled arr/obj node's buffer and capacity survive intact. Disabled
 * in the audit lane so ASan sees real frees and the live count stays a
 * strict alloc/free balance.
 */
static SCR_TL ScrDyn *scr_builtin_array_prototype;

bool scr_dyn_is_array_prototype(const ScrDyn *d) {
  return d && d == scr_builtin_array_prototype;
}

bool scr_dyn_array_prototype_element_fence(const ScrDyn *recv) {
  if (!scr_dyn_is_array_prototype(recv)) return false;
  static const char message[] = "Elements on Array.prototype are not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return true;
}

/* Property names are immutable and often repeated across simultaneously live
 * objects. Entries own references to their bytes; this fixed weak table owns
 * none. Collisions only reduce sharing, and the final release removes a weak
 * entry before freeing storage. Long keys bypass lookup entirely. */
#define SCR_DYN_KEY_SHARE_SLOTS 256
#define SCR_DYN_KEY_SHARE_LENGTH 64
typedef struct {
  size_t rc;
  char bytes[];
} ScrDynKey;
typedef struct {
  ScrDynKey *key;
  size_t length;
} ScrDynKeySlot;
static SCR_TL ScrDynKeySlot scr_dyn_keys[SCR_DYN_KEY_SHARE_SLOTS];
#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_dyn_keys;
long scr_dyn_key_live_count(void) { return scr_live_dyn_keys; }
#endif

static size_t scr_dyn_key_slot(const char *key, size_t length) {
  size_t hash = length;
  for (size_t i = 0; i < length; i++) hash = hash * 31 + (unsigned char)key[i];
  return hash % SCR_DYN_KEY_SHARE_SLOTS;
}

static char *scr_dyn_key_copy(const char *key, size_t length) {
  ScrDynKeySlot *slot = length <= SCR_DYN_KEY_SHARE_LENGTH
    ? &scr_dyn_keys[scr_dyn_key_slot(key, length)] : NULL;
  if (slot && slot->key && slot->length == length &&
      !memcmp(slot->key->bytes, key, length)) {
    slot->key->rc++;
    return slot->key->bytes;
  }
  if (length > SIZE_MAX - sizeof(ScrDynKey) - 1) scr_json_oom();
  ScrDynKey *owned = malloc(sizeof *owned + length + 1);
  if (!owned) scr_json_oom();
#ifdef SCR_RC_AUDIT
  scr_live_dyn_keys++;
#endif
  owned->rc = 1;
  memcpy(owned->bytes, key, length);
  owned->bytes[length] = '\0';
  if (slot) *slot = (ScrDynKeySlot){owned, length};
  return owned->bytes;
}

static void scr_dyn_key_release(char *key, size_t length) {
  if (!key) return;
  ScrDynKey *owned = (ScrDynKey *)(key - offsetof(ScrDynKey, bytes));
  if (--owned->rc) return;
  if (length <= SCR_DYN_KEY_SHARE_LENGTH) {
    ScrDynKeySlot *slot = &scr_dyn_keys[scr_dyn_key_slot(key, length)];
    if (slot->key == owned) slot->key = NULL;
  }
#ifdef SCR_RC_AUDIT
  scr_live_dyn_keys--;
#endif
  free(owned);
}

#ifndef SCR_RC_AUDIT
static SCR_TL ScrDyn *scr_dyn_free_arr, *scr_dyn_free_obj, *scr_dyn_free_misc;
static SCR_TL size_t scr_dyn_free_count;
/* Sized for whole documents: a parse/serialize loop over a 100k-record
 * document frees ~400k nodes per round, and a pool capped below that sent
 * most of them back through zeroing allocation and entry-buffer regrowth.
 * The pool only keeps blocks the thread already allocated (the small-object
 * arena never returns them to the system either), at the cost of reserving
 * them, with their item/entry buffers, for dyn nodes. */
#define SCR_DYN_FREE_MAX ((size_t)1 << 20)
/* Recycled small objects may retain key bytes, but never values or an
 * unbounded document's keys. This budget applies across the whole pool. */
static SCR_TL size_t scr_dyn_cached_key_bytes;
#define SCR_DYN_KEY_CACHE_MAX ((size_t)64 * 1024)
#define SCR_DYN_KEY_CACHE_SLOTS 16
#define SCR_DYN_KEY_CACHE_LENGTH 64
#endif

static void scr_dyn_obj_drop_keys(ScrDyn *d, bool cache) {
  for (size_t i = 0; i < d->v.obj.cap; i++) {
    ScrDynEntry *entry = &d->v.obj.entries[i];
    if (!entry->key) continue;
#ifndef SCR_RC_AUDIT
    if (cache && d->v.obj.cap <= SCR_DYN_KEY_CACHE_SLOTS &&
        entry->key_len <= SCR_DYN_KEY_CACHE_LENGTH &&
        sizeof(ScrDynKey) + entry->key_len + 1 <= SCR_DYN_KEY_CACHE_MAX - scr_dyn_cached_key_bytes) {
      scr_dyn_cached_key_bytes += sizeof(ScrDynKey) + entry->key_len + 1;
      continue;
    }
#else
    (void)cache;
#endif
    scr_dyn_key_release(entry->key, entry->key_len);
    entry->key = NULL;
    entry->key_len = 0;
  }
}

/* Primitive kinds cannot acquire properties or change kind while live, so
 * an object property edge to one cannot participate in a cycle. Keep its RC edge
 * out of trial deletion and release it in collected teardown instead. Other
 * owners may still trace the same primitive through the uniform header ABI;
 * our untraced reference keeps it alive until that teardown releases it.
 * Entry metadata snapshots this decision during trace, before any white node
 * can be freed. Teardown must never inspect the child's kind again. */
static bool scr_dyn_member_is_traced(const ScrDyn *value) {
  return value && value->kind > SCR_DYN_STR && value->kind != SCR_DYN_UNDEF;
}

/* Checked objects and functions can close over one another. All heap dyn
 * nodes carry a collector header so a captured unknown value has one uniform
 * tracing ABI, including when it currently contains a scalar. Opaque native
 * capsules keep their conservative ownership edges. */
void scr_dyn_trace_v(void *ptr, ScrTraceVisit visit, void *ctx) {
  ScrDyn *d = ptr;
  if (d->prototype) visit(d->prototype, ctx);
  if (d->symbol_properties) visit(d->symbol_properties, ctx);
  if (d->symbol_keys) visit(d->symbol_keys, ctx);
  switch (d->kind) {
  case SCR_DYN_ARR:
    for (size_t i = 0; i < d->v.arr.len; i++) visit(d->v.arr.items[i], ctx);
    if (d->v.arr.properties) visit(d->v.arr.properties, ctx);
    break;
  case SCR_DYN_OBJ:
    for (size_t i = 0; i < d->v.obj.len; i++) {
      ScrDynEntry *entry = &d->v.obj.entries[i];
      entry->value_traced = scr_dyn_member_is_traced(entry->value);
      if (entry->value_traced) visit(entry->value, ctx);
      if (entry->getter) visit(entry->getter, ctx);
      if (entry->setter) visit(entry->setter, ctx);
    }
    break;
  case SCR_DYN_FUNC: visit(d->v.fn.clo, ctx); break;
  case SCR_DYN_PROXY:
    visit(d->v.proxy.target, ctx);
    visit(d->v.proxy.handler, ctx);
    break;
  case SCR_DYN_TYPED_REF:
    visit(d->v.typed_ref.materialized, ctx);
    if (d->v.typed_ref.traced) visit(d->v.typed_ref.ptr, ctx);
    for (ScrDynTypedCast *cast = d->v.typed_ref.casts; cast; cast = cast->next)
      if (cast->traced) visit(cast->ptr, ctx);
    break;
  case SCR_DYN_HANDLE:
    if (d->v.handle.traced) visit(d->v.handle.ptr, ctx);
    break;
  default: break;
  }
}

/* Live typed capsules by referent: one capsule per (referent, adapter)
 * while it is alive, so repeated conversions of one static value return
 * the same dyn reference. Open addressing with linear probing, at most
 * half full; slots hold weak capsule pointers, removed before disposal.
 * The table stays allocated while its context runs, so converting and
 * dropping one value at a time does not allocate a table per crossing.
 * The context's exit hook (a library's session reset) frees it, or, when
 * capsules are still alive then, the last capsule's disposal does. */
static SCR_TL ScrDyn **scr_typed_ref_slots;
static SCR_TL size_t scr_typed_ref_capacity, scr_typed_ref_count;
static SCR_TL bool scr_typed_ref_exit_registered, scr_typed_ref_exited;
static size_t scr_typed_ref_bucket(void *ptr) {
  uintptr_t hash = (uintptr_t)ptr >> 4;
  hash ^= hash >> 17;
  hash *= (uintptr_t)0x9e3779b1u;
  hash ^= hash >> 13;
  return hash & (scr_typed_ref_capacity - 1);
}
static void scr_typed_ref_free_slots(void) {
  free(scr_typed_ref_slots);
  scr_typed_ref_slots = NULL;
  scr_typed_ref_capacity = 0;
}
static void scr_typed_ref_exit(void);
static void scr_typed_ref_reserve(void) {
  if (scr_typed_ref_capacity && scr_typed_ref_count < scr_typed_ref_capacity / 2) return;
  if (!scr_typed_ref_exit_registered) {
    scr_typed_ref_exit_registered = true;
    scr_atexit(scr_typed_ref_exit);
  }
  size_t old_capacity = scr_typed_ref_capacity;
  ScrDyn **old = scr_typed_ref_slots;
  scr_typed_ref_capacity = old_capacity ? old_capacity * 2 : 1024;
  scr_typed_ref_slots = calloc(scr_typed_ref_capacity, sizeof *scr_typed_ref_slots);
  if (!scr_typed_ref_slots) scr_json_oom();
  for (size_t i = 0; i < old_capacity; i++) {
    if (!old[i]) continue;
    size_t slot = scr_typed_ref_bucket(old[i]->v.typed_ref.ptr);
    while (scr_typed_ref_slots[slot]) slot = (slot + 1) & (scr_typed_ref_capacity - 1);
    scr_typed_ref_slots[slot] = old[i];
  }
  free(old);
}
static void scr_typed_ref_forget(ScrDyn *value) {
  if (!scr_typed_ref_capacity) return;
  size_t mask = scr_typed_ref_capacity - 1;
  size_t hole = scr_typed_ref_bucket(value->v.typed_ref.ptr);
  while (scr_typed_ref_slots[hole] != value) {
    if (!scr_typed_ref_slots[hole]) return;
    hole = (hole + 1) & mask;
  }
  /* Backward-shift deletion: move later members of the probe run into
   * the hole when the hole lies between their home slot and their slot. */
  for (size_t slot = (hole + 1) & mask; scr_typed_ref_slots[slot]; slot = (slot + 1) & mask) {
    size_t home = scr_typed_ref_bucket(scr_typed_ref_slots[slot]->v.typed_ref.ptr);
    if (((slot - home) & mask) >= ((slot - hole) & mask)) {
      scr_typed_ref_slots[hole] = scr_typed_ref_slots[slot];
      hole = slot;
    }
  }
  scr_typed_ref_slots[hole] = NULL;
  if (--scr_typed_ref_count == 0 && scr_typed_ref_exited) {
    scr_typed_ref_exited = false;
    scr_typed_ref_free_slots();
  }
}

static void scr_typed_ref_exit(void) {
  if (scr_typed_ref_count == 0) scr_typed_ref_free_slots();
  else scr_typed_ref_exited = true;
}

static void scr_dyn_gcfree(void *ptr);

/* Intact parse regions (scr_runtime.h, ScrDynRegion). */
static ScrDynRegion *scr_dyn_region_new(void) {
  ScrDynRegion *region = malloc(sizeof *region);
  if (!region) scr_json_oom();
  region->refs = 1;
  region->intact = true;
  return region;
}

static void scr_dyn_region_unref(ScrDynRegion *region) {
  if (region && --region->refs == 0) free(region);
}

/* Tag a container the parser has just completed. Its members were stored
 * while it had no region, so construction never trips the barrier. */
static void scr_dyn_region_join(ScrDyn *d, ScrDynRegion *region) {
  if (!region || (d->kind != SCR_DYN_ARR && d->kind != SCR_DYN_OBJ)) return;
  region->refs++;
  if (d->kind == SCR_DYN_ARR) d->v.arr.region = region;
  else d->v.obj.region = region;
}

ScrDynRegion *scr_dyn_region_open(void) { return scr_dyn_region_new(); }
void scr_dyn_region_tag(ScrDyn *d, ScrDynRegion *region) { scr_dyn_region_join(d, region); }
void scr_dyn_region_close(ScrDynRegion *region) { scr_dyn_region_unref(region); }

static void scr_dyn_region_leave(ScrDyn *d) {
  ScrDynRegion **slot = d->kind == SCR_DYN_ARR ? &d->v.arr.region : &d->v.obj.region;
  scr_dyn_region_unref(*slot);
  *slot = NULL;
}

static ScrDyn *scr_dyn_alloc(ScrDynKind kind) {
#ifndef SCR_RC_AUDIT
  ScrDyn **list = kind == SCR_DYN_ARR   ? &scr_dyn_free_arr
                  : kind == SCR_DYN_OBJ ? &scr_dyn_free_obj
                                        : &scr_dyn_free_misc;
  ScrDyn *d = *list;
  if (d) {
    *list = (ScrDyn *)d->v.str; /* freelist link */
    scr_dyn_free_count--;
    ScrCycHdr *header = scr_cyc_hdr(d);
    scr_cyc_set_color(header, SCR_CYC_BLACK);
    scr_cyc_set_gen(header, SCR_CYC_NURSERY);
    d->rc = 1;
    d->kind = kind;
    d->buffer = false;
    d->null_proto = false;
    d->prototype = NULL;
    d->symbol_properties = NULL;
    d->symbol_keys = NULL;
    d->copied_from_native = false;
    d->non_extensible = false;
    if (kind == SCR_DYN_ARR) {
      d->v.arr.len = 0; /* cap/items preserved from the node's last life */
      d->v.arr.properties = NULL;
      d->v.arr.sealed = false;
      d->v.arr.frozen = false;
      d->v.arr.presence = NULL;
      d->v.arr.region = NULL;
    } else if (kind == SCR_DYN_OBJ) {
      d->v.obj.len = 0; /* cap/entries preserved */
      d->v.obj.region = NULL;
      d->v.obj.class_name = NULL; /* a released class prototype's name */
      SCR_JS_SHAPE_RESET(d);
      if (d->v.obj.cap <= SCR_DYN_KEY_CACHE_SLOTS) {
        for (size_t i = 0; i < d->v.obj.cap; i++) {
          ScrDynEntry *entry = &d->v.obj.entries[i];
          if (entry->key) scr_dyn_cached_key_bytes -= sizeof(ScrDynKey) + entry->key_len + 1;
        }
      }
      d->v.obj.source_identity = NULL;
      d->v.obj.source_access = NULL;
    } else if (kind != SCR_DYN_NUM && kind != SCR_DYN_STR) {
      /* Number and string boxes set their one payload word. */
      memset(&d->v, 0, sizeof d->v);
    }
    return d;
  }
#endif
  static ScrCycType cyc_type = { &scr_dyn_trace_v, &scr_dyn_gcfree, SCR_CYC_KIND_DYN };
  ScrDyn *fresh = scr_cyc_alloc_inline(sizeof *fresh, &cyc_type);
  if (!fresh) scr_json_oom();
  fresh->rc = 1;
  fresh->kind = kind;
  fresh->non_extensible = false;
  fresh->prototype = NULL;
  fresh->symbol_properties = NULL;
  fresh->symbol_keys = NULL;
#ifdef SCR_JS_TIER
  if (kind == SCR_DYN_OBJ) SCR_JS_SHAPE_RESET(fresh);
#endif
#ifdef SCR_RC_AUDIT
  scr_live_dyns++;
#endif
  return fresh;
}

/* Number and string nodes are most of the checked-dynamic churn: numbers
 * boxed by dyn expressions and the leaves of parsed documents. They own no
 * dyn edges, are never cycle candidates or weak keys, and never acquire a
 * prototype or symbol table (only objects and arrays do), so they recycle
 * through the misc pool without the generic disposal and reset. Every
 * pooled node has a NULL prototype and symbol tables. */
static inline ScrDyn *scr_dyn_leaf_alloc(ScrDynKind kind) {
#ifndef SCR_RC_AUDIT
  ScrDyn *d = scr_dyn_free_misc;
  if (d) {
    scr_dyn_free_misc = (ScrDyn *)d->v.str; /* freelist link */
    scr_dyn_free_count--;
    ScrCycHdr *header = scr_cyc_hdr(d);
    scr_cyc_set_color(header, SCR_CYC_BLACK);
    scr_cyc_set_gen(header, SCR_CYC_NURSERY);
    d->rc = 1;
    d->kind = kind;
    d->buffer = false;
    d->null_proto = false;
    d->copied_from_native = false;
    d->non_extensible = false;
    return d;
  }
#endif
  return scr_dyn_alloc(kind);
}

static void scr_dyn_handle_release(void *h, ScrDynHandleTag tag);
static bool scr_dyn_to_primitive_result_is_object(const ScrDyn *d);

/* Pooled dyn nodes report their disposal to weak collections only: they
 * are never the native records the kept-source table is keyed by. */
static SCR_TL bool scr_weak_observing;
static void scr_weak_disposed(void *key);
static inline void scr_dyn_weak_dispose(ScrDyn *d) {
  if (scr_weak_observing) scr_weak_disposed(d);
}

static void scr_dyn_dispose(ScrDyn *d, bool collected) {
#ifndef SCR_RC_AUDIT
  /* A capsule with nothing but its referent and adapters: the common end
   * of a value that crossed into a dyn slot for one call. */
  if (d->kind == SCR_DYN_TYPED_REF && !collected && !d->prototype && !d->symbol_properties &&
      !d->symbol_keys && !d->v.typed_ref.materialized && !d->v.typed_ref.casts &&
      scr_dyn_free_count < SCR_DYN_FREE_MAX) {
    scr_typed_ref_forget(d);
    d->v.typed_ref.release(d->v.typed_ref.ptr);
    scr_dyn_weak_dispose(d);
    d->v.str = (ScrStr *)scr_dyn_free_misc;
    scr_dyn_free_misc = d;
    scr_dyn_free_count++;
    return;
  }
#endif
  if (d->kind == SCR_DYN_OBJ) {
    free(d->v.obj.index);
    d->v.obj.index = NULL;
  }
  if (d->kind == SCR_DYN_ARR || d->kind == SCR_DYN_OBJ) scr_dyn_region_leave(d);
  if (!collected) scr_dyn_release(d->prototype);
  if (!collected) scr_dyn_release(d->symbol_properties);
  if (!collected) scr_dyn_release(d->symbol_keys);
  /* Pooled nodes keep all three NULL (scr_dyn_leaf_alloc relies on it). */
  d->prototype = d->symbol_properties = d->symbol_keys = NULL;
  switch (d->kind) {
  case SCR_DYN_SYMBOL:
    d->v.symbol.release(d->v.symbol.value);
    break;
  case SCR_DYN_BIGINT:
    scr_bigint_release(d->v.bigint);
    break;
  case SCR_DYN_STR:
    scr_str_release(d->v.str);
    break;
  case SCR_DYN_BYTES:
    scr_bytes_release(d->v.bytes);
    break;
  case SCR_DYN_ARR:
    free(d->v.arr.presence);
    d->v.arr.presence = NULL;
    if (!collected) {
      for (size_t i = 0; i < d->v.arr.len; i++) scr_dyn_release(d->v.arr.items[i]);
      scr_dyn_release(d->v.arr.properties);
    }
    break;
  case SCR_DYN_OBJ:
    for (size_t i = 0; i < d->v.obj.len; i++) {
      ScrDyn *value = d->v.obj.entries[i].value;
      if (!collected || !d->v.obj.entries[i].value_traced) scr_dyn_release(value);
      if (!collected) {
        scr_dyn_release(d->v.obj.entries[i].getter);
        scr_dyn_release(d->v.obj.entries[i].setter);
      }
      d->v.obj.entries[i].value = NULL;
      d->v.obj.entries[i].getter = NULL;
      d->v.obj.entries[i].setter = NULL;
    }
    if (d->v.obj.source_identity) {
      d->v.obj.source_access(d->v.obj.source_identity, false);
    }
    break;
  case SCR_DYN_FUNC:
    if (!collected) scr_closure_release(d->v.fn.clo); /* sig/name are static literals */
    break;
  case SCR_DYN_HANDLE:
    if (!collected || !d->v.handle.traced)
      scr_dyn_handle_release(d->v.handle.ptr, d->v.handle.tag);
    break;
  case SCR_DYN_PROMISE:
    /* Installed by scr_dyn_alloc_promise (the gated boxes are the only
     * constructors) — a promise-free link (the runtime unit tests bind
     * scr_json.c without the fiber machinery) never references it. */
    scr_dyn_promise_release_fn(d->v.promise);
    break;

  case SCR_DYN_TYPED_REF:
    scr_typed_ref_forget(d);
    if (!collected) scr_dyn_release(d->v.typed_ref.materialized);
    while (d->v.typed_ref.casts) {
      ScrDynTypedCast *cast = d->v.typed_ref.casts;
      d->v.typed_ref.casts = cast->next;
      if (!collected || !cast->traced) cast->release(cast->ptr);
      free(cast);
    }
    if (!collected || !d->v.typed_ref.traced) d->v.typed_ref.release(d->v.typed_ref.ptr);
    break;
  case SCR_DYN_PROXY:
    if (!collected) {
      scr_dyn_release(d->v.proxy.target);
      scr_dyn_release(d->v.proxy.handler);
    }
    break;
  default:
    break; /* null/bool/num have no children */
  }
#ifdef SCR_RC_AUDIT
  scr_live_dyns--;
#endif
#ifndef SCR_RC_AUDIT
  if (!collected && scr_dyn_free_count < SCR_DYN_FREE_MAX) {
    if (d->kind == SCR_DYN_OBJ) scr_dyn_obj_drop_keys(d, true);
    /* Pooled blocks retain their headers and count toward the bounded
     * allocated heap, but never remain in a candidate buffer. */
    scr_dyn_weak_dispose(d);
    ScrDyn **list = d->kind == SCR_DYN_ARR   ? &scr_dyn_free_arr
                    : d->kind == SCR_DYN_OBJ ? &scr_dyn_free_obj
                                             : &scr_dyn_free_misc;
    d->v.str = (ScrStr *)*list; /* overlays arr/obj len; buffer survives */
    *list = d;
    scr_dyn_free_count++;
    return;
  }
#endif
  if (d->kind == SCR_DYN_ARR) scr_mem_free(d->v.arr.items);
  else if (d->kind == SCR_DYN_OBJ) {
    scr_dyn_obj_drop_keys(d, false);
    scr_mem_free(d->v.obj.entries);
  }
  scr_cyc_free_inline(d);
}

static void scr_dyn_gcfree(void *ptr) { scr_dyn_dispose(ptr, true); }

static void scr_dyn_destroy(void *ptr) { scr_dyn_dispose(ptr, false); }

/* The cycle bookkeeping of a value that survives a release. Compiled
 * release fast paths decrement first and call this for the kinds whose
 * candidacy depends on per-value state, matching scr_dyn_release: arrays
 * and objects not yet buffered (skipped while their document is intact,
 * ScrDynRegion), capsules and handles. */
void scr_dyn_release_survivor(ScrDyn *d) {
  if (d->kind == SCR_DYN_ARR || d->kind == SCR_DYN_OBJ) {
    const ScrDynRegion *region = scr_dyn_region_of(d);
    if (!region || !region->intact) scr_cyc_released(d);
    return;
  }
  if ((d->kind == SCR_DYN_TYPED_REF &&
       (d->v.typed_ref.materialized || d->v.typed_ref.casts || d->v.typed_ref.traced ||
        d->prototype || d->symbol_properties || d->symbol_keys)) ||
      (d->kind == SCR_DYN_HANDLE && d->v.handle.traced))
    scr_cyc_released(d);
}

void scr_dyn_release(ScrDyn *d) {
  if (!d || d->rc == SIZE_MAX) return;
  if (--d->rc != 0) {
    /* A container of an intact parse region cannot lie on a cycle
     * (ScrDynRegion). */
    if (d->kind == SCR_DYN_ARR || d->kind == SCR_DYN_OBJ) {
      ScrDynRegion *region = d->kind == SCR_DYN_ARR ? d->v.arr.region : d->v.obj.region;
      if (!region || !region->intact) scr_cyc_released(d);
      return;
    }
    /* A capsule without a snapshot, casts or a traced referent has no
     * outgoing edge, so it cannot be part of a cycle until it gains one. */
    if (d->kind == SCR_DYN_FUNC || d->kind == SCR_DYN_PROXY ||
        (d->kind == SCR_DYN_TYPED_REF &&
         (d->v.typed_ref.materialized || d->v.typed_ref.casts || d->v.typed_ref.traced ||
          d->prototype || d->symbol_properties || d->symbol_keys)) ||
        (d->kind == SCR_DYN_HANDLE && d->v.handle.traced))
      scr_cyc_released(d);
    return;
  }
#ifndef SCR_RC_AUDIT
  /* Number and string boxes own at most one string, are never cycle
   * candidates and cannot be weak keys: return them to the free list. */
  if ((d->kind == SCR_DYN_NUM || d->kind == SCR_DYN_STR) && !d->prototype &&
      !d->symbol_properties && !d->symbol_keys && scr_dyn_free_count < SCR_DYN_FREE_MAX) {
    if (d->kind == SCR_DYN_STR) scr_str_release(d->v.str);
    d->v.str = (ScrStr *)scr_dyn_free_misc;
    scr_dyn_free_misc = d;
    scr_dyn_free_count++;
    return;
  }
#endif
  scr_cyc_dead(d);
#ifndef SCR_RC_AUDIT
  if ((d->kind == SCR_DYN_NUM || d->kind == SCR_DYN_STR) && scr_dyn_free_count < SCR_DYN_FREE_MAX) {
    if (d->kind == SCR_DYN_STR) scr_str_release(d->v.str);
    d->v.str = (ScrStr *)scr_dyn_free_misc; /* see scr_dyn_leaf_alloc */
    scr_dyn_free_misc = d;
    scr_dyn_free_count++;
    return;
  }
#endif
  scr_rc_destroy(d, scr_dyn_destroy);
}

/* Small objects retain their compact linear representation. A wide object
 * owns a bucket index of entry positions; entries remain insertion ordered.
 * No key/value ownership lives here, and callbacks never retain its slots. */
#define SCR_DYN_OBJECT_INDEX_MIN 32
typedef struct ScrDynObjectIndex {
  size_t buckets;
  size_t slots[]; /* zero is empty; occupied slots store entry + 1 */
} ScrDynObjectIndex;

static void scr_dyn_index_insert(ScrDynObjectIndex *index, const ScrDynEntry *entry, size_t position) {
  size_t slot = scr_key_hash(entry->key, entry->key_len) & (index->buckets - 1);
  while (index->slots[slot]) slot = (slot + 1) & (index->buckets - 1);
  index->slots[slot] = position + 1;
}

/* Keep index allocation/probing outside compact object insertion and reads. */
static __attribute__((noinline)) void scr_dyn_index_append(ScrDyn *object) {
  size_t count = object->v.obj.len;
  ScrDynObjectIndex *index = object->v.obj.index;
  if (!index || count > index->buckets / 2) {
    size_t buckets = index ? index->buckets : 64;
    while (count > buckets / 2) {
      if (buckets > (SIZE_MAX - sizeof *index) / sizeof(size_t) / 2) scr_json_oom();
      buckets *= 2;
    }
    free(index);
    index = calloc(1, sizeof *index + buckets * sizeof(size_t));
    if (!index) scr_json_oom();
    index->buckets = buckets;
    object->v.obj.index = index;
    for (size_t i = 0; i < count; i++) scr_dyn_index_insert(index, &object->v.obj.entries[i], i);
  } else {
    scr_dyn_index_insert(index, &object->v.obj.entries[count - 1], count - 1);
  }
}

/* A checked hint avoids repeating a linear walk for recurring property
 * names. Slots store indices only, never object/key pointers. Every hit
 * checks the current entry, so different shapes, deletion and reordering
 * need no invalidation and collisions fall back to the ordinary search. */
#define SCR_DYN_PROPERTY_HINTS 64
static SCR_TL size_t scr_dyn_property_hints[SCR_DYN_PROPERTY_HINTS];

static ScrDynEntry *scr_dyn_find_linear_entry(const ScrDyn *object, const char *key, size_t length) {
  for (size_t i = 0; i < object->v.obj.len; i++) {
    ScrDynEntry *entry = &object->v.obj.entries[i];
    if (entry->key_len == length && scr_key_equal(entry->key, key, length)) return entry;
  }
  return NULL;
}

static __attribute__((noinline)) ScrDynEntry *scr_dyn_find_indexed_entry(
    const ScrDyn *object, const char *key, size_t length) {
  const ScrDynObjectIndex *index = object->v.obj.index;
  size_t slot = scr_key_hash(key, length) & (index->buckets - 1);
  while (index->slots[slot]) {
    ScrDynEntry *entry = &object->v.obj.entries[index->slots[slot] - 1];
    if (entry->key_len == length && scr_key_equal(entry->key, key, length)) return entry;
    slot = (slot + 1) & (index->buckets - 1);
  }
  return NULL;
}

static ScrDynEntry *scr_dyn_find_entry(const ScrDyn *object, const char *key, size_t length) {
  if (object->kind != SCR_DYN_OBJ) return NULL;
  if (object->v.obj.index) return scr_dyn_find_indexed_entry(object, key, length);
  size_t slot = (length + (length ? (unsigned char)key[0] * 7u : 0)) % SCR_DYN_PROPERTY_HINTS;
  size_t hint = scr_dyn_property_hints[slot];
  if (hint < object->v.obj.len) {
    ScrDynEntry *entry = &object->v.obj.entries[hint];
    if (entry->key_len == length && scr_key_equal(entry->key, key, length)) return entry;
  }
  ScrDynEntry *entry = scr_dyn_find_linear_entry(object, key, length);
  if (entry) scr_dyn_property_hints[slot] = (size_t)(entry - object->v.obj.entries);
  return entry;
}

ScrDyn *scr_dyn_obj_get(const ScrDyn *d, const char *key, size_t key_len) {
  if (d->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("raw object inspection");
    return NULL;
  }
  ScrDynEntry *entry = scr_dyn_find_entry(d, key, key_len);
  return entry ? entry->value : NULL;
}

bool scr_dyn_obj_enumerable(const ScrDyn *d, const char *key, size_t key_len) {
  ScrDynEntry *entry = scr_dyn_find_entry(d, key, key_len);
  return entry && entry->enumerable;
}

static const ScrDyn *scr_dyn_property_owner(const ScrDyn *object, const char *key, size_t length);
static ScrDyn *scr_dyn_obj_read_receiver(const ScrDyn *d, const char *key, size_t key_len, const ScrDyn *receiver);
static ScrDyn *scr_dyn_fn_properties(const ScrDyn *function);
static ScrDyn *scr_native_map_pack(void *ptr);

/* Read through a typed capsule without exposing its native layout to a
 * matcher for another type. The returned member owns its reference after
 * the materialized view is released. */
static ScrDyn *scr_dyn_discriminant(const ScrDyn *d, const ScrStr *key) {
  if (d && d->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_visit_view(d);
    ScrDyn *out = scr_dyn_discriminant(view, key);
    scr_dyn_release(view);
    return out;
  }
  if (!d || d->kind != SCR_DYN_OBJ) return NULL;
  return scr_dyn_property_owner(d, key->data, key->len)
    ? scr_dyn_obj_read(d, key->data, key->len) : NULL;
}

bool scr_dyn_field_eq_str(const ScrDyn *d, const ScrStr *key, const ScrStr *value) {
  ScrDyn *member = scr_dyn_discriminant(d, key);
  bool matches = member && member->kind == SCR_DYN_STR && scr_str_eq(member->v.str, (ScrStr *)value);
  scr_dyn_release(member);
  return matches;
}

bool scr_dyn_field_eq_num(const ScrDyn *d, const ScrStr *key, double value) {
  ScrDyn *member = scr_dyn_discriminant(d, key);
  bool matches = member && member->kind == SCR_DYN_NUM && member->v.num == value;
  scr_dyn_release(member);
  return matches;
}

bool scr_dyn_field_eq_bool(const ScrDyn *d, const ScrStr *key, bool value) {
  ScrDyn *member = scr_dyn_discriminant(d, key);
  bool matches = member && member->kind == SCR_DYN_BOOL && member->v.b == value;
  scr_dyn_release(member);
  return matches;
}

/* Public: the compiler-emitted static→dyn converters push through this
 * too. Ownership of the item moves in. */
void scr_dyn_arr_push(ScrDyn *arr, ScrDyn *item) {
  scr_dyn_region_store(arr, item);
  if (arr->v.arr.len == arr->v.arr.cap) {
    size_t cap = arr->v.arr.cap ? arr->v.arr.cap * 2 : 4;
    ScrDyn **items = scr_mem_realloc(arr->v.arr.items, cap * sizeof *items);
    if (!items) scr_json_oom();
    arr->v.arr.items = items;
    if (arr->v.arr.presence) {
      unsigned char *presence = realloc(arr->v.arr.presence, cap);
      if (!presence) scr_json_oom();
      arr->v.arr.presence = presence;
    }
    arr->v.arr.cap = cap;
  }
  if (arr->v.arr.presence) arr->v.arr.presence[arr->v.arr.len] = 1;
  arr->v.arr.items[arr->v.arr.len++] = item; /* ownership moves in */
}

/* Room for `cap` items in a fresh dyn array, so a walk that knows its
 * length pushes without regrowing. */
static void scr_dyn_arr_reserve(ScrDyn *arr, size_t cap) {
  if (cap <= arr->v.arr.cap || arr->v.arr.presence) return;
  ScrDyn **items = scr_mem_realloc(arr->v.arr.items, cap * sizeof *items);
  if (!items) scr_json_oom();
  arr->v.arr.items = items;
  arr->v.arr.cap = cap;
}

bool scr_dyn_arr_has_index(const ScrDyn *arr, size_t index) {
  return index < arr->v.arr.len && (!arr->v.arr.presence || arr->v.arr.presence[index]);
}

void scr_dyn_arr_push_hole(ScrDyn *arr) {
  scr_dyn_arr_push(arr, scr_dyn_retain(scr_dyn_undefined()));
  if (!arr->v.arr.presence) {
    arr->v.arr.presence = malloc(arr->v.arr.cap);
    if (!arr->v.arr.presence) scr_json_oom();
    memset(arr->v.arr.presence, 1, arr->v.arr.len);
  }
  arr->v.arr.presence[arr->v.arr.len - 1] = 0;
}

/* Spread completion for a runtime-arity argument list (`f(...xs)` in the
 * checked-dynamic tier): JS's spread over the checked-dynamic tree's iterable kinds —
 * arrays element-by-element (retained), strings by code POINT (the string
 * iterator; astral chars arrive unsplit), bytes by byte; every other kind
 * throws V8's exact SPREAD-CALL TypeError (catchable, pending — callers
 * check): nullish sources spell the spread expression (`what`) — "v is
 * not iterable (cannot read property undefined)" — and everything else is
 * the generic "Spread syntax requires ...iterable[Symbol.iterator] to be
 * a function". Borrows src. */
void scr_dyn_arr_push_spread(ScrDyn *arr, const ScrDyn *src, const char *what) {
  if (src->kind == SCR_DYN_HANDLE && scr_dyn_handle_ops_of(src)->iter_pack) {
    ScrDyn *pack = scr_dyn_handle_ops_of(src)->iter_pack(src->v.handle.ptr);
    if (!pack) return;
    scr_dyn_arr_push_spread(arr, pack, what);
    scr_dyn_release(pack);
    return;
  }
  if (src->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(src);
    scr_dyn_arr_push_spread(arr, materialized, what);
    scr_dyn_release(materialized);
    return;
  }
  if (src->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < src->v.arr.len; i++) {
      scr_dyn_arr_push(arr, scr_dyn_retain(src->v.arr.items[i]));
    }
    return;
  }
  if (src->kind == SCR_DYN_BYTES) {
    for (size_t i = 0; i < src->v.bytes->len; i++) {
      scr_dyn_arr_push(arr, scr_dyn_new_num(scr_bytes_get(src->v.bytes, (double)i)));
    }
    return;
  }
  if (src->kind == SCR_DYN_STR) {
    double len = scr_str_utf16_len(src->v.str);
    for (double at = 0; at < len;) {
      ScrStr *cp = scr_str_cp_at(src->v.str, at);
      at += scr_str_utf16_len(cp);
      scr_dyn_arr_push(arr, scr_dyn_new_str(cp));
      scr_str_release(cp);
    }
    return;
  }
  if (src->kind == SCR_DYN_UNDEF || src->kind == SCR_DYN_NULL) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, what);
    scr_jb_puts(&b, " is not iterable (cannot read property ");
    scr_jb_puts(&b, src->kind == SCR_DYN_UNDEF ? "undefined" : "null");
    scr_jb_puts(&b, ")");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return;
  }

  static const char msg[] = "Spread syntax requires ...iterable[Symbol.iterator] to be a function";
  scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
}

/* Destructuring pack over a dyn source (`const [a, b] = d`, a destructured
 * dyn callback param): the spread walk's iterable kinds collect into a
 * FRESH array — arrays element-by-element (retained), strings by code
 * point, bytes by byte — and every other kind throws V8's DESTRUCTURING
 * TypeError: `msg` verbatim when non-empty (the compile-time spelling —
 * "v is not iterable" for identifier sources, "f is not a function or its
 * return value is not iterable" for identifier-callee calls), else the
 * runtime kind wording ("number 5 is not iterable (cannot read property
 * Symbol(Symbol.iterator))"; objects and functions carry no value text,
 * undefined no kind prefix, null V8's "object null"). Borrows both; +1 or
 * NULL with the TypeError pending. */
static ScrDyn *scr_dyn_not_iterable(const ScrDyn *src, const ScrStr *msg) {
  if (msg != NULL && msg->len > 0) {
    scr_throw_error(SCR_ERR_TYPE, scr_str_new(msg->data, msg->len));
    return NULL;
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  switch (src->kind) {
  case SCR_DYN_UNDEF: scr_jb_puts(&b, "undefined"); break;
  case SCR_DYN_NULL: scr_jb_puts(&b, "object null"); break;
  case SCR_DYN_BOOL: scr_jb_puts(&b, src->v.b ? "boolean true" : "boolean false"); break;
  case SCR_DYN_NUM: {
    char buf[32];
    scr_jb_puts(&b, "number ");
    size_t n = scr_f64_to_str(src->v.num, buf);
    scr_jb_write(&b, buf, n);
    break;
  }
  case SCR_DYN_FUNC: scr_jb_puts(&b, "function"); break;
  default: scr_jb_puts(&b, "object"); break;
  }
  scr_jb_puts(&b, " is not iterable (cannot read property Symbol(Symbol.iterator))");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

static ScrDyn *scr_native_iterator_drain(const ScrDyn *src);

/* Math.max(...src) / Math.min(...src) over an untyped iterable: every
 * value's ToNumber runs in order, then NaN poisons and ±0 orders as in
 * Node. A non-iterable source throws V8's call-spread TypeError: `what`
 * names the source for null and undefined, every other kind gets the
 * Symbol.iterator wording. NaN with the exception pending when packing or
 * a coercion throws. */
double scr_dyn_math_fold(const ScrDyn *src, bool max, const ScrStr *what) {
  if (src->kind == SCR_DYN_UNDEF || src->kind == SCR_DYN_NULL) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_write(&b, what->data, what->len);
    scr_jb_puts(&b, src->kind == SCR_DYN_NULL ? " is not iterable (cannot read property null)"
                                              : " is not iterable (cannot read property undefined)");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return NAN;
  }
  static const char spread_msg[] = "Spread syntax requires ...iterable[Symbol.iterator] to be a function";
  ScrStr *msg = scr_str_new(spread_msg, sizeof spread_msg - 1);
  /* The spread takes every value before the call: arrays, strings, bytes
   * and collections pack, a native iterator (a Map's keys()) drains, and
   * other iterables (a generator, an object with a Symbol.iterator method)
   * step their iterator to the end. */
  ScrDyn *pack = src->kind == SCR_DYN_HANDLE && (src->v.handle.tag == SCR_DYNH_ITERATOR ||
                                                 scr_dyn_handle_ops_of(src)->iter_step)
                     ? scr_native_iterator_drain(src)
                     : scr_dyn_destructure_rest(src, msg);
  scr_str_release(msg);
  if (!pack) return NAN;
  double best = max ? -INFINITY : INFINITY;
  bool nan = false;
  for (size_t i = 0; i < pack->v.arr.len; i++) {
    double v = scr_dyn_number_coerce(pack->v.arr.items[i]);
    if (scr_exc_pending()) break;
    if (isnan(v)) nan = true;
    else if (max ? (v > best || (v == 0.0 && best == 0.0 && !signbit(v)))
                 : (v < best || (v == 0.0 && best == 0.0 && signbit(v))))
      best = v;
  }
  scr_dyn_release(pack);
  return nan ? NAN : best;
}

ScrDyn *scr_dyn_iter_pack(const ScrDyn *src, const ScrStr *msg) {
  if (src->kind == SCR_DYN_HANDLE && scr_dyn_handle_ops_of(src)->iter_pack)
    return scr_dyn_handle_ops_of(src)->iter_pack(src->v.handle.ptr);
  if (src->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(src);
    ScrDyn *out = scr_dyn_iter_pack(materialized, msg);
    scr_dyn_release(materialized);
    return out;
  }
  if (src->kind == SCR_DYN_ARR || src->kind == SCR_DYN_BYTES || src->kind == SCR_DYN_STR) {
    ScrDyn *out = scr_dyn_new_arr();
    scr_dyn_arr_push_spread(out, src, ""); /* iterable kinds never consult `what` */
    return out;
  }


  return scr_dyn_not_iterable(src, msg);
}

static ScrDyn *scr_native_iterator_drain(const ScrDyn *src);

/* The values a collection constructor's iterable seed gives, in order: +1
 * array, or NULL with the exception pending. A native iterator (a Map's
 * keys(), a Set's values()) drains, which runs no program code; arrays,
 * strings, typed arrays and collections pack; other iterables (a
 * generator, an object with a Symbol.iterator method) step their
 * iterator to the end, so their values are all taken before the
 * constructor adds the first one. */
static ScrDyn *scr_dyn_seed_values(const ScrDyn *src) {
  if (src->kind == SCR_DYN_HANDLE &&
      (src->v.handle.tag == SCR_DYNH_ITERATOR || scr_dyn_handle_ops_of(src)->iter_step))
    return scr_native_iterator_drain(src);
  return scr_dyn_destructure_rest(src, NULL);
}

/* The for-of-over-dyn pack accessors: the emitted index loop drives them
 * over a scr_dyn_iter_pack result (ARR by construction — the defensive
 * arms cover nothing reachable from that lowering). Never throw. */
ScrDyn *scr_dyn_map_seed_entries(const ScrDyn *src) {
  if (src->kind == SCR_DYN_ARR) return scr_dyn_retain((ScrDyn *)src);
  if (src->kind == SCR_DYN_NULL || src->kind == SCR_DYN_UNDEF) return scr_dyn_new_arr();
  if (src->kind == SCR_DYN_HANDLE && src->v.handle.tag == SCR_DYNH_MAP)
    return scr_native_map_pack(src->v.handle.ptr);
  if (src->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(src)) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(src);
    if (!scr_exc_pending() && view->kind == SCR_DYN_ARR) return view;
    scr_dyn_release(view);
    if (scr_exc_pending()) return NULL;
  }
  /* A native iterator (sp.entries(), a Map's entries()) or a handle that
   * steps through live entries (URLSearchParams) drains; a Set, a
   * generator or another iterable gives its values in order
   * (scr_dyn_seed_values). */
  return scr_dyn_seed_values(src);
}

ScrDyn *scr_dyn_map_seed_entry(const ScrDyn *entry) {
  if (entry->kind == SCR_DYN_NULL || entry->kind == SCR_DYN_UNDEF ||
      entry->kind == SCR_DYN_NUM || entry->kind == SCR_DYN_BOOL ||
      entry->kind == SCR_DYN_STR || entry->kind == SCR_DYN_BIGINT) {
    ScrStr *value = scr_dyn_string_coerce_js(entry);
    if (scr_exc_pending()) { scr_str_release(value); return NULL; }
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "Iterator value ");
    scr_jb_write(&b, value->data, value->len);
    scr_jb_puts(&b, " is not an entry object");
    scr_str_release(value);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return NULL;
  }
  return scr_dyn_retain((ScrDyn *)entry);
}

double scr_dyn_arr_len(const ScrDyn *d) {
  return d->kind == SCR_DYN_ARR ? (double)d->v.arr.len : 0;
}
ScrDyn *scr_dyn_arr_at(const ScrDyn *d, double i) {
  if (d->kind != SCR_DYN_ARR || i < 0 || i >= (double)d->v.arr.len) {
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (scr_dyn_arr_has_index(d, (size_t)i)) return scr_dyn_retain(d->v.arr.items[(size_t)i]);
  char text[32];
  int length = snprintf(text, sizeof text, "%zu", (size_t)i);
  ScrStr *key = scr_str_new(text, (size_t)length);
  ScrDyn *result = scr_dyn_arr_named_get(d, key);
  scr_str_release(key);
  return result;
}

ScrDyn *scr_dyn_arr_named_get(const ScrDyn *d, const ScrStr *key) {
  if (d->v.arr.properties && scr_dyn_obj_get(d->v.arr.properties, key->data, key->len))
    return scr_dyn_obj_read_receiver(d->v.arr.properties, key->data, key->len, d);
  const ScrDyn *prototype = d->prototype ? d->prototype :
    d != scr_builtin_array_prototype ? scr_builtin_array_prototype : NULL;
  ScrDyn *value = prototype ? scr_dyn_obj_read_receiver(prototype, key->data, key->len, d)
    : scr_dyn_retain(scr_dyn_undefined());
  if (value && value->kind == SCR_DYN_UNDEF && !d->null_proto && key->len == 11 && !memcmp(key->data, "constructor", 11)) {
    scr_dyn_release(value);
    return scr_dyn_array_constructor();
  }
  return value;
}

/* Borrows key and takes ownership of value. Duplicate keys retain their
 * original spelling/storage and insertion position; the later value wins.
 * A recycled entry can reuse equal key bytes without a malloc/free pair. */
static void scr_dyn_obj_put(ScrDyn *obj, const char *key, size_t key_len, ScrDyn *value) {
  scr_dyn_region_store(obj, value);
  /* Construction usually appends an absent name. Avoid a read hint that
   * repeats comparisons on compact objects; wide objects use their index. */
  ScrDynEntry *existing = obj->v.obj.index ? scr_dyn_find_entry(obj, key, key_len)
                                          : scr_dyn_find_linear_entry(obj, key, key_len);
  if (existing) {
    if (existing->accessor || !existing->writable) {
      scr_dyn_release(value);
      static const char message[] = "Cannot assign to read only property";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return;
    }
    ScrDyn *old = existing->value;
    existing->value = value;
    scr_dyn_release(old);
    return;
  }
  if (obj->non_extensible) {
    scr_dyn_release(value);
    ScrJsonBuf buffer;
    scr_jb_init(&buffer);
    scr_jb_puts(&buffer, "Cannot add property ");
    scr_jb_write(&buffer, key, key_len);
    scr_jb_puts(&buffer, ", object is not extensible");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&buffer));
    return;
  }
  if (obj->v.obj.len == obj->v.obj.cap) {
    size_t cap = obj->v.obj.cap ? obj->v.obj.cap * 2 : 4;
    ScrDynEntry *entries = scr_mem_realloc(obj->v.obj.entries, cap * sizeof *entries);
    if (!entries) scr_json_oom();
    memset(entries + obj->v.obj.cap, 0, (cap - obj->v.obj.cap) * sizeof *entries);
    obj->v.obj.entries = entries;
    obj->v.obj.cap = cap;
  }
  SCR_JS_SHAPE_RESET(obj);
  ScrDynEntry *e = &obj->v.obj.entries[obj->v.obj.len++];
  if (!e->key || e->key_len != key_len || !scr_key_equal(e->key, key, key_len)) {
    char *owned = scr_dyn_key_copy(key, key_len);
    scr_dyn_key_release(e->key, e->key_len);
    e->key = owned;
  }
  e->key_len = key_len;
  e->value = value;
  e->getter = NULL;
  e->setter = NULL;
  e->accessor = false;
  e->writable = true;
  e->enumerable = true;
  e->configurable = true;
  if (obj->v.obj.len >= SCR_DYN_OBJECT_INDEX_MIN) scr_dyn_index_append(obj);
}

/* ── dyn construction (compiler-emitted converters & overflow reads) ───── */

/* THE undefined value: one immortal node (rc == SIZE_MAX skips every
 * retain/release and the freelists never see it). */
ScrDyn *scr_dyn_undefined(void) {
  static ScrDyn undef = { .rc = SIZE_MAX, .kind = SCR_DYN_UNDEF };
  return &undef;
}

/* Primitive nodes have no mutable properties or observable box identity.
 * As with undefined, SIZE_MAX keeps them out of RC and cycle bookkeeping;
 * callers retain the ordinary owned-result and ownership-transfer contracts. */
ScrDyn *scr_dyn_new_null(void) {
  static ScrDyn value = { .rc = SIZE_MAX, .kind = SCR_DYN_NULL };
  return &value;
}

ScrDyn *scr_dyn_new_bool(bool b) {
  static ScrDyn values[2] = {
    { .rc = SIZE_MAX, .kind = SCR_DYN_BOOL, .v.b = false },
    { .rc = SIZE_MAX, .kind = SCR_DYN_BOOL, .v.b = true },
  };
  return &values[b ? 1 : 0];
}

ScrDyn *scr_dyn_new_bigint(ScrBigInt *value) {
  ScrDyn *d = scr_dyn_alloc(SCR_DYN_BIGINT);
  d->v.bigint = scr_bigint_retain(value);
  return d;
}

ScrDyn *scr_dyn_symbol_ref(ScrSym *value, void (*release)(ScrSym *), ScrStr *(*render)(ScrSym *), ScrStr *(*description)(ScrSym *)) {
  ScrDyn *d = scr_dyn_alloc(SCR_DYN_SYMBOL);
  d->v.symbol.value = value;
  d->v.symbol.release = release;
  d->v.symbol.render = render;
  d->v.symbol.description = description;
  return d;
}

ScrDyn *scr_dyn_symbol_get(const ScrDyn *value, const ScrStr *key) {
  if (key->len == 11 && !memcmp(key->data, "description", 11)) {
    ScrStr *description = value->v.symbol.description(value->v.symbol.value);
    ScrDyn *out = description ? scr_dyn_new_str(description) : scr_dyn_retain(scr_dyn_undefined());
    scr_str_release(description);
    return out;
  }
  if ((key->len == 8 && !memcmp(key->data, "toString", 8)) ||
      (key->len == 7 && !memcmp(key->data, "valueOf", 7)) ||
      (key->len == 11 && !memcmp(key->data, "constructor", 11))) {
    static const char message[] = "Native Symbol prototype member values have no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

/* Small integers are immutable primitives, just like the boolean and null
 * singletons. The table is process-wide, like those: a published graph
 * (scr_message.c, scr_publish.c) may hold these nodes after the thread that
 * created them has exited. It is filled before main, so no thread writes it
 * later, and it neither grows nor owns heap references. */
static ScrDyn scr_dyn_small_ints[384];

const char *(*scr_gen_tag_reader)(const ScrGen *g) = NULL;

__attribute__((constructor)) static void scr_dyn_small_ints_init(void) {
  for (int i = 0; i < 384; i++) {
    scr_dyn_small_ints[i].rc = SIZE_MAX;
    scr_dyn_small_ints[i].kind = SCR_DYN_NUM;
    scr_dyn_small_ints[i].v.num = (double)(i - 128);
  }
}

ScrDyn *scr_dyn_new_num(double n) {
  /* Preserve negative zero as a distinct payload. */
  if (n >= -128 && n <= 255) {
    int value = (int)n;
    if ((double)value == n && (value != 0 || !signbit(n))) return &scr_dyn_small_ints[value + 128];
  }
  ScrDyn *d = scr_dyn_leaf_alloc(SCR_DYN_NUM);
  d->v.num = n;
  return d;
}

ScrDyn *scr_dyn_new_str(ScrStr *s) {
  ScrDyn *d = scr_dyn_leaf_alloc(SCR_DYN_STR);
  d->v.str = scr_str_retain(s);
  return d;
}

static void scr_builtin_array_prototype_cleanup(void) {
  ScrDyn *prototype = scr_builtin_array_prototype;
  scr_builtin_array_prototype = NULL;
  scr_dyn_release(prototype);
}

static void scr_builtin_object_prototype_cleanup(void) {
  ScrDyn *prototype = scr_builtin_object_prototype;
  scr_builtin_object_prototype = NULL;
  scr_dyn_release(prototype);
}

/* The error constructors as values (an error's `constructor`, and the
 * globals in JavaScript): one interned function per constructor and thread,
 * indexed like scr_error_vts, with the constructor's name and length.
 * Calling one through the value is not supported yet, as for the other
 * interned constructors (scr_dyn_global_constructor). */
static const char *const scr_error_ctor_names[] = {
    "Error", "TypeError", "RangeError", "SyntaxError", NULL,
    "ReferenceError", "EvalError", "URIError", "AggregateError",
};
#define SCR_ERROR_CTORS (sizeof scr_error_ctor_names / sizeof scr_error_ctor_names[0])
static SCR_TL ScrDyn *scr_error_ctor_values[SCR_ERROR_CTORS];
static SCR_TL bool scr_error_ctors_registered;

static void scr_error_ctors_cleanup(void) {
  for (size_t i = 0; i < SCR_ERROR_CTORS; i++) {
    scr_dyn_release(scr_error_ctor_values[i]);
    scr_error_ctor_values[i] = NULL;
  }
}

static ScrDyn *scr_error_ctor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  char message[128];
  int length = snprintf(message, sizeof message,
                        "calling the %s constructor through a stored value is not supported yet",
                        (const char *)closure->fn);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)length, "SC2020");
  return NULL;
}

ScrDyn *scr_dyn_error_constructor(const char *name) {
  for (size_t i = 0; i < SCR_ERROR_CTORS; i++) {
    if (!scr_error_ctor_names[i] || strcmp(scr_error_ctor_names[i], name) != 0) continue;
    if (!scr_error_ctors_registered) {
      scr_error_ctors_registered = true;
      scr_atexit(scr_error_ctors_cleanup);
    }
    if (!scr_error_ctor_values[i]) {
      uint32_t length = strcmp(name, "AggregateError") == 0 ? 2 : 1;
      scr_error_ctor_values[i] =
          scr_dyn_new_func(scr_closure_new((void *)scr_error_ctor_names[i], 0), scr_error_ctor_call, length,
                           "native:constructor", scr_error_ctor_names[i]);
    }
    return scr_dyn_retain(scr_error_ctor_values[i]);
  }
  return NULL;
}

/* `Error.stackTraceLimit` read or written through the Error constructor
 * held as a value (zod's `const E = Error; E.stackTraceLimit = 0`): the
 * same limit the static member reads and stack capture honors. */
static bool scr_dyn_is_stack_limit(const ScrDyn *d, const char *key, size_t key_len) {
  return key_len == 15 && memcmp(key, "stackTraceLimit", 15) == 0 && d->kind == SCR_DYN_FUNC &&
      scr_error_ctor_values[0] && d->v.fn.clo == scr_error_ctor_values[0]->v.fn.clo;
}

/* An own `stackTraceLimit` on the Error value, assigned a non-number or
 * defined with Object.defineProperty, replaces the limit for reads and
 * writes through the value; writes to it keep its descriptor. */
static bool scr_dyn_stack_limit_shadowed(const ScrDyn *d) {
  ScrClosure *owner = scr_closure_identity(d->v.fn.clo);
  ScrDyn *table = owner->props ? (ScrDyn *)scr_box_get_ref(owner->props) : NULL;
  bool own = table && scr_dyn_find_entry(table, "stackTraceLimit", 15);
  scr_dyn_release(table);
  return own;
}

ScrDyn *scr_dyn_object_prototype(void) {
  if (!scr_builtin_object_prototype) {
    scr_builtin_object_prototype = scr_dyn_alloc(SCR_DYN_OBJ);
    scr_builtin_object_prototype->null_proto = true;
    scr_atexit(scr_builtin_object_prototype_cleanup);
  }
  return scr_dyn_retain(scr_builtin_object_prototype);
}

ScrDyn *scr_dyn_array_prototype_base(void) {
  if (!scr_builtin_array_prototype) {
    scr_builtin_array_prototype = scr_dyn_alloc(SCR_DYN_ARR);
    scr_atexit(scr_builtin_array_prototype_cleanup);
  }
  return scr_dyn_retain(scr_builtin_array_prototype);
}

/* Error.prototype as a checked-dynamic object, for JavaScript constructor
 * functions that inherit from it (`F.prototype =
 * Object.create(Error.prototype)`): non-enumerable `constructor`, `name`
 * ("Error"), `message` ("") and `toString`, on Object.prototype. The Error
 * constructor has no checked-dynamic value, so `constructor` is a function
 * named Error that throws when called. */
static const ScrDyn *scr_dyn_proto_next(const ScrDyn *object);
static void scr_builtin_error_prototype_cleanup(void) {
  ScrDyn *prototype = scr_builtin_error_prototype;
  scr_builtin_error_prototype = NULL;
  scr_dyn_release(prototype);
}
static ScrDyn *scr_error_prototype_to_string(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind == SCR_DYN_OBJ || self->kind == SCR_DYN_ARR || self->kind == SCR_DYN_FUNC) {
    ScrStr *text = scr_dyn_error_string(self);
    if (text) {
      result = scr_dyn_new_str(text);
      scr_str_release(text);
    }
  } else {
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "Method Error.prototype.toString called on incompatible receiver ");
    ScrStr *shown = self->kind == SCR_DYN_SYMBOL ? self->v.symbol.render(self->v.symbol.value)
                                                 : scr_dyn_string_coerce_js(self);
    if (shown) {
      scr_jb_put_str(&message, shown);
      scr_str_release(shown);
    }
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  }
  scr_dyn_release(self);
  return result;
}
static ScrDyn *scr_error_prototype_constructor(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  static const char message[] = "calling Error.prototype.constructor is not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}
static void scr_error_prototype_hide(ScrDyn *object, const char *key, size_t key_len) {
  ScrDynEntry *entry = scr_dyn_find_entry(object, key, key_len);
  entry->enumerable = false;
}
ScrDyn *scr_dyn_error_prototype(void) {
  if (!scr_builtin_error_prototype) {
    ScrDyn *prototype = scr_dyn_alloc(SCR_DYN_OBJ);
    scr_dyn_obj_set(prototype, "constructor", 11,
        scr_dyn_new_func(scr_closure_new(NULL, 0), scr_error_prototype_constructor, 1, "native:Error", "Error"));
    scr_error_prototype_hide(prototype, "constructor", 11);
    ScrStr *name = scr_str_new("Error", 5);
    scr_dyn_obj_set(prototype, "name", 4, scr_dyn_new_str(name));
    scr_str_release(name);
    scr_error_prototype_hide(prototype, "name", 4);
    ScrStr *empty = scr_str_new("", 0);
    scr_dyn_obj_set(prototype, "message", 7, scr_dyn_new_str(empty));
    scr_str_release(empty);
    scr_error_prototype_hide(prototype, "message", 7);
    scr_dyn_obj_set(prototype, "toString", 8,
        scr_dyn_new_func(scr_closure_new(NULL, 0), scr_error_prototype_to_string, 0, "native:Error", "toString"));
    scr_error_prototype_hide(prototype, "toString", 8);
    scr_builtin_error_prototype = prototype;
    scr_atexit(scr_builtin_error_prototype_cleanup);
  }
  return scr_dyn_retain(scr_builtin_error_prototype);
}

/* Error.captureStackTrace(target): defines a non-enumerable own `stack`
 * on target. Node's value is the Error.prototype.toString text of target
 * (read without calling an overriding toString) followed by stack frames;
 * here, as for scriptc's own Error instances, it is the text alone.
 * Answers undefined, or NULL with the exception pending. */
ScrDyn *scr_dyn_error_capture_stack_trace(ScrDyn *target) {
  /* An instance of a class that extends Error derives its stack from its
   * name and message when the stack is read. */
  if (target->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(target);
    bool error = view && view->kind == SCR_DYN_OBJ && scr_dyn_obj_get(view, "%error", 6) != NULL;
    scr_dyn_release(view);
    if (scr_exc_pending()) return NULL;
    if (error) return scr_dyn_retain(scr_dyn_undefined());
  }
  if (target->kind != SCR_DYN_OBJ) {
    if (target->kind == SCR_DYN_ARR || target->kind == SCR_DYN_FUNC || target->kind == SCR_DYN_TYPED_REF ||
        target->kind == SCR_DYN_HANDLE || target->kind == SCR_DYN_PROXY) {
      static const char message[] = "Error.captureStackTrace on this object is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    } else {
      static const char message[] = "invalid_argument";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    }
    return NULL;
  }
  ScrDynEntry *existing = scr_dyn_find_entry(target, "stack", 5);
  if (existing ? existing->accessor || !existing->configurable : target->non_extensible) {
    static const char message[] = "Cannot redefine property: stack";
    static const char extensible[] = "Cannot define property stack, object is not extensible";
    if (existing) scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    else scr_throw_error_msg(SCR_ERR_TYPE, extensible, sizeof extensible - 1);
    return NULL;
  }
  ScrStr *text = scr_dyn_error_string(target);
  if (!text) return NULL;
  scr_dyn_obj_set_field(target, "stack", 5, scr_dyn_new_str(text));
  scr_str_release(text);
  ScrDynEntry *entry = scr_dyn_find_entry(target, "stack", 5);
  entry->enumerable = false;
  entry->writable = entry->configurable = true;
  return scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *scr_error_capture_stack_trace_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return scr_dyn_error_capture_stack_trace(argc > 0 ? args[0] : scr_dyn_undefined());
}
/* Error.captureStackTrace read as a value: one function per thread. */
static SCR_TL ScrDyn *scr_error_capture_stack_trace_fn;
static void scr_error_capture_stack_trace_fn_cleanup(void) {
  ScrDyn *function = scr_error_capture_stack_trace_fn;
  scr_error_capture_stack_trace_fn = NULL;
  scr_dyn_release(function);
}
ScrDyn *scr_dyn_error_capture_stack_trace_function(void) {
  if (!scr_error_capture_stack_trace_fn) {
    scr_error_capture_stack_trace_fn = scr_dyn_new_func(scr_closure_new(NULL, 0),
        scr_error_capture_stack_trace_call, 2, "native:Error", "captureStackTrace");
    scr_atexit(scr_error_capture_stack_trace_fn_cleanup);
  }
  return scr_dyn_retain(scr_error_capture_stack_trace_fn);
}

/* `value instanceof Error` for a value that is not an Error instance: true
 * when Error.prototype is on its prototype chain. */
bool scr_dyn_inherits_error_prototype(const ScrDyn *value) {
  if (!scr_builtin_error_prototype || !value || value->kind != SCR_DYN_OBJ) return false;
  for (const ScrDyn *current = scr_dyn_proto_next(value); current; current = scr_dyn_proto_next(current)) {
    if (current == scr_builtin_error_prototype) return true;
  }
  return false;
}

ScrDyn *scr_dyn_new_arr(void) { return scr_dyn_alloc(SCR_DYN_ARR); }
ScrDyn *scr_dyn_new_obj(void) { return scr_dyn_alloc(SCR_DYN_OBJ); }
ScrDyn *scr_dyn_new_obj_with_identity(
    void *source, void *(*source_retain)(void *),
    ScrDyn *(*source_access)(void *, bool materialize)) {
  ScrDyn *d = scr_dyn_alloc(SCR_DYN_OBJ);
  d->v.obj.source_identity = source_retain(source);
  d->v.obj.source_access = source_access;
  return d;
}

bool scr_dyn_obj_same_source(const ScrDyn *a, const ScrDyn *b) {
  return a && b && a->kind == SCR_DYN_OBJ && b->kind == SCR_DYN_OBJ &&
         a->v.obj.source_identity && b->v.obj.source_identity &&
         a->v.obj.source_identity == b->v.obj.source_identity;
}

void *scr_dyn_obj_source_cast(const ScrDyn *d,
    ScrDyn *(*source_access)(void *, bool), void *(*source_retain)(void *)) {
  if (!d || d->kind != SCR_DYN_OBJ || !d->v.obj.source_identity ||
      d->v.obj.source_access != source_access) return NULL;
  return source_retain(d->v.obj.source_identity);
}

ScrDyn *scr_dyn_new_obj_null_proto(void) {
  ScrDyn *d = scr_dyn_alloc(SCR_DYN_OBJ);
  d->null_proto = true;
  return d;
}

static const ScrDyn *scr_dyn_chain_link(const ScrDyn *link);

/* A typed capsule can be a prototype when its checked view is an object. */
static bool scr_dyn_typed_ref_prototype(const ScrDyn *value) {
  if (value->kind != SCR_DYN_TYPED_REF || scr_dyn_generator(value)) return false;
  const ScrDyn *view = scr_dyn_chain_link(value);
  return view && (view->kind == SCR_DYN_OBJ || view->kind == SCR_DYN_ARR);
}

/* True when `prototype` is null or an object or function, the values
 * Object.create and Object.setPrototypeOf accept. Otherwise throws Node's
 * TypeError, whose message ends with the value's string form. */
static bool scr_dyn_prototype_valid(const ScrDyn *prototype) {
  if (scr_dyn_is_object(prototype) || scr_dyn_is_callable(prototype)) return true;
  if (scr_exc_pending()) return false;
  ScrStr *text = prototype->kind == SCR_DYN_SYMBOL
    ? prototype->v.symbol.render(prototype->v.symbol.value) : scr_dyn_string_coerce_js(prototype);
  if (!text) return false;
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Object prototype may only be an Object or null: ");
  scr_jb_put_str(&b, text);
  scr_str_release(text);
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return false;
}

/* A valid receiver or prototype whose kind this operation does not handle. */
static void scr_dyn_prototype_unsupported(const char *operation) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, operation);
  scr_jb_puts(&b, " with this value is not supported yet");
  scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
}

ScrDyn *scr_dyn_obj_create(ScrDyn *prototype) {
  if (!scr_dyn_prototype_valid(prototype)) return NULL;
  if (prototype != scr_builtin_object_prototype && scr_dyn_class_reflection_fence(prototype)) return NULL;
  bool typed = scr_dyn_typed_ref_prototype(prototype);
  if (scr_exc_pending()) return NULL;
  if (prototype->kind != SCR_DYN_OBJ && prototype->kind != SCR_DYN_ARR && prototype->kind != SCR_DYN_NULL && !typed) {
    scr_dyn_prototype_unsupported("Object.create");
    return NULL;
  }
  ScrDyn *object = prototype->kind == SCR_DYN_NULL ? scr_dyn_new_obj_null_proto() : scr_dyn_new_obj();
  if (prototype->kind != SCR_DYN_NULL) object->prototype = scr_dyn_retain(prototype);
  return object;
}

ScrDyn *scr_dyn_get_prototype(ScrDyn *object) {
  if (object == scr_builtin_object_prototype) return scr_dyn_new_null();
  if (scr_dyn_class_reflection_fence(object)) return NULL;
  if (object->kind == SCR_DYN_TYPED_REF && strncmp(object->v.typed_ref.type_key, "object:", 7)) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    if (!view) return NULL;
    ScrDyn *result = scr_dyn_get_prototype(view);
    scr_dyn_release(view);
    return result;
  }
  if (object->kind == SCR_DYN_FUNC && scr_closure_identity(object->v.fn.clo)->props) {
    ScrDyn *table = scr_dyn_fn_properties(object);
    ScrDyn *result = table->prototype ? scr_dyn_retain(table->prototype)
      : table->null_proto ? scr_dyn_new_null() : NULL;
    scr_dyn_release(table);
    if (result) return result;
  }
  if (object->kind == SCR_DYN_ARR && object != scr_builtin_array_prototype) {
    if (object->prototype) return scr_dyn_retain(object->prototype);
    return scr_dyn_array_prototype_base();
  }
  if (object->kind == SCR_DYN_OBJ) {
    if (object->prototype) return scr_dyn_retain(object->prototype);
    if (object->null_proto) return scr_dyn_new_null();
    return scr_dyn_object_prototype();
  }
  if (object == scr_builtin_array_prototype) return scr_dyn_object_prototype();
#ifdef SCR_NODE_ISLANDS
  /* An island object: its V8 prototype, through the __proto__ accessor
   * (undefined for an object without Object.prototype: null). */
  if (scr_ni_is_handle(object)) {
    ScrDyn *proto = scr_ni_get_str(object, "__proto__", 9);
    if (proto != NULL && proto->kind == SCR_DYN_UNDEF) {
      scr_dyn_release(proto);
      return scr_dyn_new_null();
    }
    return proto;
  }
#endif
  if (object->kind == SCR_DYN_NULL || object->kind == SCR_DYN_UNDEF) {
    static const char message[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  static const char message[] = "Object.getPrototypeOf on this value is not supported yet";
  scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
  return NULL;
}

/* scr_dyn_get_prototype for a walk that compares each prototype with a
 * program class's prototype (instanceof against a class value): a native
 * Date, RegExp, Map, Set, WeakMap or WeakSet, or a promise, has only builtin
 * prototypes on its chain, and no program class extends these (a class
 * extending Date makes instances of its own), so the walk ends there with
 * null. */
ScrDyn *scr_dyn_get_prototype_for_identity(ScrDyn *object) {
  if (object->kind == SCR_DYN_PROMISE) return scr_dyn_new_null();
  if (object->kind == SCR_DYN_HANDLE) {
    switch (object->v.handle.tag) {
    case SCR_DYNH_DATE: case SCR_DYNH_REGEXP: case SCR_DYNH_MAP: case SCR_DYNH_SET:
    case SCR_DYNH_WEAK_MAP: case SCR_DYNH_WEAK_SET:
      return scr_dyn_new_null();
    default:
      break;
    }
  }
  return scr_dyn_get_prototype(object);
}

ScrDyn *scr_dyn_set_prototype(ScrDyn *object, ScrDyn *prototype) {
  /* A primitive receiver is returned unchanged when the prototype is null or
   * any object or function; nothing is mutated, so the prototype's kind is the
   * only check. */
  if (object->kind == SCR_DYN_BOOL || object->kind == SCR_DYN_NUM || object->kind == SCR_DYN_STR ||
      object->kind == SCR_DYN_BIGINT || object->kind == SCR_DYN_SYMBOL) {
    return scr_dyn_prototype_valid(prototype) ? scr_dyn_retain(object) : NULL;
  }
  if (scr_dyn_class_reflection_fence(object) || scr_dyn_error_prototype_fence(object) || scr_dyn_class_reflection_fence(prototype)) return NULL;
  if (object->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    if (scr_exc_pending()) { scr_dyn_release(view); return NULL; }
    ScrDyn *result = scr_dyn_set_prototype(view, prototype);
    scr_dyn_release(view);
    if (!result) return NULL;
    scr_dyn_release(result);
    return scr_dyn_retain(object);
  }
  if (object->kind == SCR_DYN_FUNC) {
    if (prototype->kind == SCR_DYN_FUNC && scr_closure_identity_equal(object->v.fn.clo, prototype->v.fn.clo)) {
      static const char message[] = "Cyclic __proto__ value";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    ScrDyn *table = scr_dyn_fn_properties(object);
    ScrDyn *result = scr_dyn_set_prototype(table, prototype);
    scr_dyn_release(table);
    if (!result) return NULL;
    scr_dyn_release(result);
    return scr_dyn_retain(object);
  }
  if (object->kind == SCR_DYN_NULL || object->kind == SCR_DYN_UNDEF) {
    static const char message[] = "Object.setPrototypeOf called on null or undefined";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  if (!scr_dyn_prototype_valid(prototype)) return NULL;
  bool typed = scr_dyn_typed_ref_prototype(prototype);
  if (scr_exc_pending()) return NULL;
  if ((object->kind != SCR_DYN_OBJ && object->kind != SCR_DYN_ARR) ||
      (prototype->kind != SCR_DYN_OBJ && prototype->kind != SCR_DYN_ARR && prototype->kind != SCR_DYN_FUNC && prototype->kind != SCR_DYN_NULL && !typed)) {
    scr_dyn_prototype_unsupported("Object.setPrototypeOf");
    return NULL;
  }
  for (const ScrDyn *current = scr_dyn_chain_link(prototype); current;) {
    if (current->kind == SCR_DYN_FUNC) {
      ScrDyn *table = scr_dyn_fn_properties(current);
      current = table;
      scr_dyn_release(table); /* the function owns the table */
    }
    if (current == object) {
      static const char message[] = "Cyclic __proto__ value";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    current = scr_dyn_proto_next(current);
  }
  if (object->non_extensible && (prototype->kind == SCR_DYN_NULL ? object->prototype != NULL || !object->null_proto : object->prototype != prototype)) {
    static const char message[] = "Cannot set prototype of a non-extensible object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *replacement = prototype->kind == SCR_DYN_NULL ? NULL : scr_dyn_retain(prototype);
  scr_dyn_region_store(object, replacement ? replacement : scr_dyn_undefined());
  scr_dyn_release(object->prototype);
  object->prototype = replacement;
  object->null_proto = replacement ? false : true;
  return scr_dyn_retain(object);
}

/* A class instance's integrity state lives in its native layout, which only
 * statically typed calls can reach (the compiler adds the state to the
 * hierarchies they name). Through an untyped value the operation throws. */
static bool scr_dyn_class_integrity_fence(const ScrDyn *object, const char *operation) {
  if (object->kind != SCR_DYN_TYPED_REF) return false;
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  scr_jb_puts(&buffer, operation);
  scr_jb_puts(&buffer, " of a class instance held in an untyped value is not supported yet");
  ScrStr *message = scr_jb_finish(&buffer);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
  return true;
}

/* Integrity queries on a class instance answer from its checked view, which
 * carries the instance's attributes (scr_dyn_class_view_attributes). */
static bool scr_dyn_typed_ref_view_answer(ScrDyn *object, bool (*query)(const ScrDyn *),
                                          bool *answer) {
  if (object->kind != SCR_DYN_TYPED_REF) return false;
  ScrDyn *view = scr_dyn_typed_ref_materialize(object);
  *answer = scr_exc_pending() ? false : query(view);
  scr_dyn_release(view);
  return true;
}

static bool scr_dyn_is_extensible_view(const ScrDyn *view) {
  return (view->kind == SCR_DYN_OBJ || view->kind == SCR_DYN_ARR) && !view->non_extensible;
}

/* A plain function's own properties (name, length, prototype, and the ones
 * a program adds) live in its property table, which carries the function's
 * integrity state too: freezing or sealing the function freezes or seals
 * the table. Class constructors are not plain functions: their statics keep
 * their own fences. */
static bool scr_dyn_plain_fn(const ScrDyn *object) {
  return object->kind == SCR_DYN_FUNC && !object->v.fn.class_obj;
}

/* The table of a plain function for an integrity operation, created on
 * first use. +1, or NULL for other values. */
static ScrDyn *scr_dyn_fn_integrity_table(const ScrDyn *object) {
  return scr_dyn_plain_fn(object) ? scr_dyn_fn_properties(object) : NULL;
}

/* The table a plain function already has, for the integrity queries: one
 * without a table has never been frozen, sealed or made non-extensible.
 * +1, or NULL. */
static ScrDyn *scr_dyn_fn_existing_table(const ScrDyn *function) {
  ScrClosure *owner = scr_closure_identity(function->v.fn.clo);
  return owner->props ? (ScrDyn *)scr_box_get_ref(owner->props) : NULL;
}

ScrDyn *scr_dyn_prevent_extensions(ScrDyn *object) {
  if (scr_dyn_class_reflection_fence(object) || scr_dyn_error_prototype_fence(object)) return NULL;
  if (object->kind == SCR_DYN_PROXY) { scr_dyn_proxy_unsupported("Object.preventExtensions"); return NULL; }
  if (scr_dyn_class_integrity_fence(object, "Object.preventExtensions")) return NULL;
  ScrDyn *table = scr_dyn_fn_integrity_table(object);
  if (table) {
    table->non_extensible = true;
    scr_dyn_release(table);
  }
  if (object->kind == SCR_DYN_OBJ || object->kind == SCR_DYN_ARR) {
    object->non_extensible = true;
    if (object->kind == SCR_DYN_ARR && object->v.arr.properties)
      object->v.arr.properties->non_extensible = true;
  }
  return scr_dyn_retain(object);
}

bool scr_dyn_is_extensible(ScrDyn *object) {
  if (scr_dyn_class_reflection_fence(object)) return false;
  if (object->kind == SCR_DYN_PROXY) { scr_dyn_proxy_unsupported("Object.isExtensible"); return false; }
  bool answer;
  if (scr_dyn_typed_ref_view_answer(object, scr_dyn_is_extensible_view, &answer)) return answer;
  if (scr_dyn_plain_fn(object)) {
    ScrDyn *table = scr_dyn_fn_existing_table(object);
    answer = !table || !table->non_extensible;
    scr_dyn_release(table);
    return answer;
  }
  return scr_dyn_is_extensible_view(object);
}

ScrDyn *scr_dyn_seal(ScrDyn *object) {
  if (scr_dyn_class_reflection_fence(object) || scr_dyn_error_prototype_fence(object)) return NULL;
  if (object->kind == SCR_DYN_PROXY) { scr_dyn_proxy_unsupported("Object.seal"); return NULL; }
  if (scr_dyn_class_integrity_fence(object, "Object.seal")) return NULL;
  if (object->symbol_properties) scr_dyn_release(scr_dyn_seal(object->symbol_properties));
  ScrDyn *table = scr_dyn_fn_integrity_table(object);
  if (table) {
    scr_dyn_release(scr_dyn_seal(table));
    scr_dyn_release(table);
  }
  if (object->kind == SCR_DYN_OBJ) {
    object->non_extensible = true;
    for (size_t i = 0; i < object->v.obj.len; i++) object->v.obj.entries[i].configurable = false;
  }
  if (object->kind == SCR_DYN_ARR) {
    object->non_extensible = true;
    object->v.arr.sealed = true;
    if (object->v.arr.properties) scr_dyn_release(scr_dyn_seal(object->v.arr.properties));
  }
  return scr_dyn_retain(object);
}

bool scr_dyn_is_sealed(const ScrDyn *object) {
  if (scr_dyn_class_reflection_fence(object)) return false;
  if (object->kind == SCR_DYN_PROXY) { scr_dyn_proxy_unsupported("Object.isSealed"); return false; }
  bool answer;
  if (scr_dyn_typed_ref_view_answer((ScrDyn *)object, scr_dyn_is_sealed, &answer)) return answer;
  if (object->symbol_properties && !scr_dyn_is_sealed(object->symbol_properties)) return false;
  if (scr_dyn_plain_fn(object)) {
    ScrDyn *table = scr_dyn_fn_existing_table(object);
    answer = table && scr_dyn_is_sealed(table);
    scr_dyn_release(table);
    return answer;
  }
  if (object->kind == SCR_DYN_ARR)
    return object->non_extensible && (object->v.arr.len == 0 || object->v.arr.sealed) &&
      (!object->v.arr.properties || scr_dyn_is_sealed(object->v.arr.properties));
  if (object->kind != SCR_DYN_OBJ) return true;
  if (!object->non_extensible) return false;
  for (size_t i = 0; i < object->v.obj.len; i++) if (object->v.obj.entries[i].configurable) return false;
  return true;
}

/* A typed record, array or class instance used as a prototype stays a
 * capsule on the chain, so later native writes to it stay visible. Walks
 * consult it through its refreshed checked view (owned by the capsule),
 * whose own prototype continues the chain. */
static const ScrDyn *scr_dyn_chain_link(const ScrDyn *link) {
  if (!link || link->kind != SCR_DYN_TYPED_REF) return link;
  ScrDyn *view = scr_dyn_typed_ref_materialize(link);
  bool cached = view == link->v.typed_ref.materialized;
  scr_dyn_release(view);
  return cached ? view : NULL;
}

static const ScrDyn *scr_dyn_proto_next(const ScrDyn *object) {
  return scr_dyn_chain_link(object->prototype);
}

static const ScrDyn *scr_dyn_property_owner(const ScrDyn *object, const char *key, size_t length) {
  for (const ScrDyn *current = object; current; current = scr_dyn_proto_next(current)) {
    if (current->kind == SCR_DYN_FUNC) {
      ScrDyn *table = scr_dyn_fn_properties(current);
      const ScrDyn *owner = scr_dyn_property_owner(table, key, length);
      scr_dyn_release(table);
      return owner;
    }
    if (current->kind != SCR_DYN_OBJ) continue;
    for (size_t i = 0; i < current->v.obj.len; i++) {
      const ScrDynEntry *entry = &current->v.obj.entries[i];
      if (entry->key_len == length && memcmp(entry->key, key, length) == 0) return current;
    }
  }
  return NULL;
}

static bool scr_dyn_has_object_prototype(const ScrDyn *object) {
  const ScrDyn *current = object;
  for (const ScrDyn *next; (next = scr_dyn_proto_next(current));) current = next;
  return current == scr_builtin_object_prototype || !current->null_proto;
}

void scr_dyn_proxy_unsupported(const char *operation) {
  ScrJsonBuf msg;
  scr_jb_init(&msg);
  scr_jb_puts(&msg, operation);
  scr_jb_puts(&msg, " on a native Proxy is not supported yet");
  scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&msg));
}

static ScrDynEntry *scr_dyn_entry(ScrDyn *obj, const ScrStr *key);
static bool scr_dyn_property_same_value(const ScrDyn *a, const ScrDyn *b);

static void scr_dyn_proxy_invariant(void) {
  static const char msg[] = "Proxy trap violated a target property invariant";
  scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
}

ScrDyn *scr_dyn_proxy_new(const ScrDyn *target, const ScrDyn *handler) {
  if (!scr_dyn_to_primitive_result_is_object(target) || !scr_dyn_to_primitive_result_is_object(handler)) {
    static const char msg[] = "Cannot create proxy with a non-object as target or handler";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  bool native_record = target->kind == SCR_DYN_TYPED_REF &&
    strncmp(target->v.typed_ref.type_key, "record:", 7) == 0;
  if (native_record) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(target);
    bool plain = view && view->kind == SCR_DYN_OBJ;
    if (plain) for (size_t i = 0; i < view->v.obj.len; i++) {
      ScrDynEntry *entry = &view->v.obj.entries[i];
      if (entry->accessor || !entry->configurable || !entry->writable) plain = false;
    }
    scr_dyn_release(view);
    if (scr_exc_pending()) return NULL;
    native_record = plain;
  }
  if ((target->kind != SCR_DYN_OBJ && target->kind != SCR_DYN_FUNC && !native_record) || handler->kind != SCR_DYN_OBJ) {
    scr_dyn_proxy_unsupported("non-plain targets or handlers");
    return NULL;
  }
  ScrDyn *out = scr_dyn_alloc(SCR_DYN_PROXY);
  out->v.proxy.target = scr_dyn_retain((ScrDyn *)target);
  out->v.proxy.handler = scr_dyn_retain((ScrDyn *)handler);
  return out;
}

/* GetMethod observes handler mutations on every operation. Retain the
 * callable across invocation, since a trap may replace itself. */
static ScrDyn *scr_dyn_proxy_trap(const ScrDyn *proxy, const char *name) {
  ScrDyn *method = scr_dyn_obj_read(proxy->v.proxy.handler, name, strlen(name));
  if (!method || method->kind == SCR_DYN_UNDEF || method->kind == SCR_DYN_NULL) {
    scr_dyn_release(method);
    return NULL;
  }
  if (!scr_dyn_is_callable(method)) {
    ScrJsonBuf msg;
    scr_jb_init(&msg);
    scr_jb_puts(&msg, "Proxy handler '");
    scr_jb_puts(&msg, name);
    scr_jb_puts(&msg, "' is not callable");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&msg));
    scr_dyn_release(method);
    return NULL;
  }
  if (proxy->v.proxy.target->kind == SCR_DYN_TYPED_REF) {
    scr_dyn_release(method);
    scr_dyn_proxy_unsupported("traps over typed native targets");
    return NULL;
  }
  return method;
}

static ScrDyn *scr_dyn_proxy_call(const ScrDyn *proxy, ScrDyn *trap, ScrDyn *const *args, size_t argc) {
  scr_dyn_this_push_dyn(proxy->v.proxy.handler);
  ScrDyn *result = scr_dyn_call(trap, args, argc, "Proxy trap");
  scr_dyn_this_pop();
  scr_dyn_release(trap);
  return result;
}

static bool scr_dyn_name_in(const ScrStr *key, const char *const *names, size_t count) {
  for (size_t i = 0; i < count; i++) {
    if (key->len == strlen(names[i]) && memcmp(key->data, names[i], key->len) == 0) return true;
  }
  return false;
}

/* Own string keys of Object.prototype. Most misses stop at the length
 * and first-character filter. */
static bool scr_dyn_object_proto_name(const ScrStr *key) {
  if (key->len < 7 || key->len > 20) return false;
  switch (key->data[0]) {
  case 'c': case '_': case 'h': case 'i': case 'p': case 't': case 'v': break;
  default: return false;
  }
  static const char *const names[] = {
    "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty",
    "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable",
    "toString", "valueOf", "__proto__", "toLocaleString"
  };
  return scr_dyn_name_in(key, names, sizeof names / sizeof names[0]);
}

/* Own string keys of Array.prototype. */
static bool scr_dyn_array_proto_name(const ScrStr *key) {
  static const char *const names[] = {
    "length", "constructor", "at", "concat", "copyWithin", "fill", "find", "findIndex",
    "findLast", "findLastIndex", "lastIndexOf", "pop", "push", "reverse", "shift",
    "unshift", "slice", "sort", "splice", "includes", "indexOf", "join", "keys",
    "entries", "values", "forEach", "filter", "flat", "flatMap", "map", "every", "some",
    "reduce", "reduceRight", "toReversed", "toSorted", "toSpliced", "with",
    "toLocaleString", "toString"
  };
  return scr_dyn_name_in(key, names, sizeof names / sizeof names[0]);
}

/* Own string keys of %TypedArray%.prototype, plus BYTES_PER_ELEMENT from
 * each typed array's own prototype. */
static bool scr_dyn_typed_array_proto_name(const ScrStr *key) {
  static const char *const names[] = {
    "constructor", "buffer", "byteLength", "byteOffset", "length", "entries", "keys", "values",
    "at", "copyWithin", "every", "fill", "filter", "find", "findIndex", "findLast",
    "findLastIndex", "forEach", "includes", "indexOf", "join", "lastIndexOf", "map", "reverse",
    "reduce", "reduceRight", "set", "slice", "some", "sort", "subarray", "toReversed", "toSorted",
    "with", "toLocaleString", "toString", "BYTES_PER_ELEMENT"
  };
  return scr_dyn_name_in(key, names, sizeof names / sizeof names[0]);
}

/* Own string keys of Buffer.prototype that %TypedArray%.prototype lacks. */
static bool scr_dyn_buffer_proto_name(const ScrStr *key) {
  static const char *const names[] = {
    "readBigUInt64LE", "readBigUInt64BE", "readBigUint64LE", "readBigUint64BE", "readBigInt64LE",
    "readBigInt64BE", "writeBigUInt64LE", "writeBigUInt64BE", "writeBigUint64LE",
    "writeBigUint64BE", "writeBigInt64LE", "writeBigInt64BE", "readUIntLE", "readUInt32LE",
    "readUInt16LE", "readUInt8", "readUIntBE", "readUInt32BE", "readUInt16BE", "readUintLE",
    "readUint32LE", "readUint16LE", "readUint8", "readUintBE", "readUint32BE", "readUint16BE",
    "readIntLE", "readInt32LE", "readInt16LE", "readInt8", "readIntBE", "readInt32BE",
    "readInt16BE", "writeUIntLE", "writeUInt32LE", "writeUInt16LE", "writeUInt8", "writeUIntBE",
    "writeUInt32BE", "writeUInt16BE", "writeUintLE", "writeUint32LE", "writeUint16LE",
    "writeUint8", "writeUintBE", "writeUint32BE", "writeUint16BE", "writeIntLE", "writeInt32LE",
    "writeInt16LE", "writeInt8", "writeIntBE", "writeInt32BE", "writeInt16BE", "readFloatLE",
    "readFloatBE", "readDoubleLE", "readDoubleBE", "writeFloatLE", "writeFloatBE", "writeDoubleLE",
    "writeDoubleBE", "asciiSlice", "base64Slice", "base64urlSlice", "latin1Slice", "hexSlice",
    "ucs2Slice", "utf8Slice", "asciiWrite", "base64Write", "base64urlWrite", "latin1Write",
    "hexWrite", "ucs2Write", "utf8Write", "parent", "offset", "copy", "equals", "inspect",
    "compare", "write", "toJSON", "swap16", "swap32", "swap64"
  };
  return scr_dyn_name_in(key, names, sizeof names / sizeof names[0]);
}

/* Own string keys of DataView.prototype. */
static bool scr_dyn_data_view_proto_name(const ScrStr *key) {
  static const char *const names[] = {
    "constructor", "buffer", "byteLength", "byteOffset", "getInt8", "setInt8", "getUint8",
    "setUint8", "getInt16", "setInt16", "getUint16", "setUint16", "getInt32", "setInt32",
    "getUint32", "setUint32", "getFloat32", "setFloat32", "getFloat64", "setFloat64",
    "getBigInt64", "setBigInt64", "getBigUint64", "setBigUint64", "getFloat16", "setFloat16"
  };
  return scr_dyn_name_in(key, names, sizeof names / sizeof names[0]);
}

/* `in` on a typed array, Buffer or DataView. On a typed array, a canonical
 * numeric key (one that ToString(ToNumber(key)) reproduces, or "-0")
 * answers by bounds alone: an integral index, not -0, below the length.
 * Other keys name members of %TypedArray%.prototype, Buffer.prototype for a
 * Buffer, or Object.prototype. A DataView has no indexed elements: its keys
 * name members of DataView.prototype or Object.prototype. */
static bool scr_dyn_bytes_in(const ScrDyn *v, const ScrStr *key) {
  if (v->v.bytes->is_data_view) return scr_dyn_data_view_proto_name(key) || scr_dyn_object_proto_name(key);
  if (key->len == 2 && memcmp(key->data, "-0", 2) == 0) return false;
  double index = scr_string_to_number(key);
  ScrStr *canonical = scr_f64_to_scrstr(index);
  bool numeric = canonical->len == key->len && memcmp(canonical->data, key->data, key->len) == 0;
  scr_str_release(canonical);
  if (numeric) return index >= 0 && index == floor(index) && index < (double)v->v.bytes->len;
  return scr_dyn_typed_array_proto_name(key) || (v->buffer && scr_dyn_buffer_proto_name(key)) ||
         scr_dyn_object_proto_name(key);
}

static bool scr_dyn_object_proto_key(const ScrDyn *target, const ScrStr *key) {
  return !target->null_proto && scr_dyn_object_proto_name(key);
}

/* Whether `key` is inherited from the builtin prototype that ends the
 * chain of a plain object: Object.prototype, or Array.prototype and then
 * Object.prototype when the chain ends in an array. */
static bool scr_dyn_builtin_inherited(const ScrDyn *object, const ScrStr *key) {
  const ScrDyn *tail = object;
  for (const ScrDyn *next; (next = scr_dyn_proto_next(tail));) tail = next;
  if (scr_exc_pending()) return false;
  if (tail == scr_builtin_object_prototype) return scr_dyn_object_proto_name(key);
  if (tail->kind == SCR_DYN_FUNC || (tail->kind == SCR_DYN_ARR && tail != object))
    return scr_dyn_in(tail, key);
  return !tail->null_proto && scr_dyn_object_proto_name(key);
}

static ScrDyn *scr_dyn_proxy_get_receiver(const ScrDyn *proxy, const ScrStr *key, const ScrDyn *receiver) {
  ScrDyn *trap = scr_dyn_proxy_trap(proxy, "get");
  if (scr_exc_pending()) return NULL;
  if (!trap) {
    ScrDyn *target = proxy->v.proxy.target;
    if (target->kind == SCR_DYN_TYPED_REF) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(target);
      ScrDyn *result = scr_exc_pending() ? NULL : scr_dyn_obj_read_receiver(view, key->data, key->len, receiver);
      scr_dyn_release(view);
      return result;
    }
    if (!scr_dyn_obj_get(target, key->data, key->len) && scr_dyn_object_proto_key(target, key)) {
      scr_dyn_proxy_unsupported("inherited Object.prototype member reads");
      return NULL;
    }
    return scr_dyn_obj_read_receiver(target, key->data, key->len, receiver);
  }
  ScrDyn *property = scr_dyn_new_str((ScrStr *)key);
  ScrDyn *args[] = { proxy->v.proxy.target, property, (ScrDyn *)receiver };
  ScrDyn *result = scr_dyn_proxy_call(proxy, trap, args, 3);
  scr_dyn_release(property);
  ScrDynEntry *entry = scr_dyn_entry(proxy->v.proxy.target, key);
  if (result && entry && !entry->configurable &&
      ((entry->accessor && !entry->getter && result->kind != SCR_DYN_UNDEF) ||
       (!entry->accessor && !entry->writable && !scr_dyn_property_same_value(entry->value, result)))) {
    scr_dyn_release(result);
    scr_dyn_proxy_invariant();
    return NULL;
  }
  return result;
}

ScrDyn *scr_dyn_proxy_get(const ScrDyn *proxy, const ScrStr *key) {
  return scr_dyn_proxy_get_receiver(proxy, key, proxy);
}

bool scr_dyn_proxy_has(const ScrDyn *proxy, const ScrStr *key) {
  ScrDyn *trap = scr_dyn_proxy_trap(proxy, "has");
  if (scr_exc_pending()) return false;
  if (!trap) return scr_dyn_in(proxy->v.proxy.target, key);
  ScrDyn *property = scr_dyn_new_str((ScrStr *)key);
  ScrDyn *args[] = { proxy->v.proxy.target, property };
  ScrDyn *result = scr_dyn_proxy_call(proxy, trap, args, 2);
  scr_dyn_release(property);
  bool has = result && scr_dyn_truthy(result);
  scr_dyn_release(result);
  ScrDynEntry *entry = scr_dyn_entry(proxy->v.proxy.target, key);
  if (!scr_exc_pending() && !has && entry && !entry->configurable) scr_dyn_proxy_invariant();
  return has;
}

static bool scr_dyn_canonical_own_index(const ScrStr *key, size_t length);

ScrDyn *scr_dyn_own_descriptor(const ScrDyn *value, const ScrStr *key) {
  if (scr_dyn_class_reflection_fence(value)) return NULL;
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    ScrDyn *result = scr_exc_pending() ? NULL : scr_dyn_own_descriptor(view, key);
    scr_dyn_release(view);
    return result;
  }
  if (value->kind == SCR_DYN_FUNC) {
    if (scr_closure_identity(value->v.fn.clo)->props) {
      ScrDyn *table = (ScrDyn *)scr_box_get_ref(scr_closure_identity(value->v.fn.clo)->props);
      ScrDyn *desc = table ? scr_dyn_own_descriptor(table, key) : NULL;
      scr_dyn_release(table);
      return desc;
    }
    bool name = key->len == 4 && memcmp(key->data, "name", 4) == 0;
    bool length = key->len == 6 && memcmp(key->data, "length", 6) == 0;
    if (!name && !length) return scr_dyn_retain(scr_dyn_undefined());
    ScrDyn *out = scr_dyn_new_obj();
    ScrDyn *member = scr_dyn_fn_get(value, key->data, key->len);
    scr_dyn_obj_set(out, "value", 5, member);
    scr_dyn_obj_set(out, "writable", 8, scr_dyn_new_bool(false));
    scr_dyn_obj_set(out, "enumerable", 10, scr_dyn_new_bool(false));
    scr_dyn_obj_set(out, "configurable", 12, scr_dyn_new_bool(true));
    return out;
  }
  if (value->kind == SCR_DYN_ARR && key->len == 6 && memcmp(key->data, "length", 6) == 0) {
    ScrDyn *out = scr_dyn_new_obj();
    scr_dyn_obj_set(out, "value", 5, scr_dyn_new_num((double)value->v.arr.len));
    scr_dyn_obj_set(out, "writable", 8, scr_dyn_new_bool(!value->v.arr.frozen));
    scr_dyn_obj_set(out, "enumerable", 10, scr_dyn_new_bool(false));
    scr_dyn_obj_set(out, "configurable", 12, scr_dyn_new_bool(false));
    return out;
  }
  if (value->kind == SCR_DYN_ARR) {
    if (value->v.arr.properties &&
        scr_dyn_obj_get(value->v.arr.properties, key->data, key->len))
      return scr_dyn_own_descriptor(value->v.arr.properties, key);
    if (scr_dyn_canonical_own_index(key, value->v.arr.len)) {
      size_t index = 0;
      for (size_t i = 0; i < key->len; i++) index = index * 10 + (size_t)(key->data[i] - '0');
      if (!scr_dyn_arr_has_index(value, index)) return scr_dyn_retain(scr_dyn_undefined());
      ScrDyn *out = scr_dyn_new_obj();
      scr_dyn_obj_set(out, "value", 5, scr_dyn_retain(value->v.arr.items[index]));
      scr_dyn_obj_set(out, "writable", 8, scr_dyn_new_bool(!value->v.arr.frozen));
      scr_dyn_obj_set(out, "enumerable", 10, scr_dyn_new_bool(true));
      scr_dyn_obj_set(out, "configurable", 12, scr_dyn_new_bool(!value->v.arr.sealed));
      return out;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (value->kind == SCR_DYN_STR) {
    size_t length = (size_t)scr_str_utf16_len(value->v.str);
    bool length_key = key->len == 6 && memcmp(key->data, "length", 6) == 0;
    size_t index = 0;
    bool index_key = !length_key && scr_dyn_canonical_own_index(key, length);
    if (!length_key && !index_key) return scr_dyn_retain(scr_dyn_undefined());
    if (index_key) {
      for (size_t i = 0; i < key->len; i++) index = index * 10 + (size_t)(key->data[i] - '0');
    }
    ScrDyn *out = scr_dyn_new_obj();
    if (length_key) {
      scr_dyn_obj_set(out, "value", 5, scr_dyn_new_num((double)length));
    } else {
      ScrStr *character = scr_str_char_at(value->v.str, (double)index);
      scr_dyn_obj_set(out, "value", 5, scr_dyn_new_str(character));
      scr_str_release(character);
    }
    scr_dyn_obj_set(out, "writable", 8, scr_dyn_new_bool(false));
    scr_dyn_obj_set(out, "enumerable", 10, scr_dyn_new_bool(index_key));
    scr_dyn_obj_set(out, "configurable", 12, scr_dyn_new_bool(false));
    return out;
  }
  if (value->kind == SCR_DYN_BOOL || value->kind == SCR_DYN_NUM) {
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (value->kind == SCR_DYN_OBJ) {
    ScrDynEntry *entry = scr_dyn_entry((ScrDyn *)value, key);
    if (!entry) return scr_dyn_retain(scr_dyn_undefined());
    ScrDyn *out = scr_dyn_new_obj();
    if (entry->accessor) {
      scr_dyn_obj_set(out, "get", 3, scr_dyn_retain(entry->getter ? entry->getter : scr_dyn_undefined()));
      scr_dyn_obj_set(out, "set", 3, scr_dyn_retain(entry->setter ? entry->setter : scr_dyn_undefined()));
    } else {
      scr_dyn_obj_set(out, "value", 5, scr_dyn_retain(entry->value));
      scr_dyn_obj_set(out, "writable", 8, scr_dyn_new_bool(entry->writable));
    }
    scr_dyn_obj_set(out, "enumerable", 10, scr_dyn_new_bool(entry->enumerable));
    scr_dyn_obj_set(out, "configurable", 12, scr_dyn_new_bool(entry->configurable));
    return out;
  }
  if (value->kind != SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("property descriptors for this receiver kind");
    return NULL;
  }
  ScrDyn *trap = scr_dyn_proxy_trap(value, "getOwnPropertyDescriptor");
  if (scr_exc_pending()) return NULL;
  if (!trap) return scr_dyn_own_descriptor(value->v.proxy.target, key);
  ScrDyn *property = scr_dyn_new_str((ScrStr *)key);
  ScrDyn *args[] = { value->v.proxy.target, property };
  ScrDyn *desc = scr_dyn_proxy_call(value, trap, args, 2);
  scr_dyn_release(property);
  if (!desc) return NULL;
  ScrDynEntry *entry = scr_dyn_entry(value->v.proxy.target, key);
  if (desc->kind == SCR_DYN_UNDEF) {
    if (entry && !entry->configurable) { scr_dyn_release(desc); scr_dyn_proxy_invariant(); return NULL; }
    return desc;
  }
  if (desc->kind != SCR_DYN_OBJ) {
    if (scr_dyn_to_primitive_result_is_object(desc)) scr_dyn_proxy_unsupported("non-plain descriptors");
    else {
      static const char msg[] = "'getOwnPropertyDescriptor' on proxy: trap returned neither object nor undefined";
      scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    }
    scr_dyn_release(desc);
    return NULL;
  }
  ScrDyn *getter = scr_dyn_obj_get(desc, "get", 3);
  ScrDyn *setter = scr_dyn_obj_get(desc, "set", 3);
  ScrDyn *data = scr_dyn_obj_get(desc, "value", 5);
  ScrDyn *writable = scr_dyn_obj_get(desc, "writable", 8);
  ScrDyn *enumerable = scr_dyn_obj_get(desc, "enumerable", 10);
  ScrDyn *configurable = scr_dyn_obj_get(desc, "configurable", 12);
  const char *error = NULL;
  if (getter && getter->kind != SCR_DYN_FUNC && getter->kind != SCR_DYN_UNDEF) error = "Getter must be a function";
  else if (setter && setter->kind != SCR_DYN_FUNC && setter->kind != SCR_DYN_UNDEF) error = "Setter must be a function";
  else if ((getter || setter) && (data || writable)) error = "Invalid property descriptor. Cannot both specify accessors and a value or writable attribute";
  bool c = configurable && scr_dyn_truthy(configurable);
  bool e = enumerable && scr_dyn_truthy(enumerable);
  bool w = writable && scr_dyn_truthy(writable);
  bool accessor = getter || setter;
  if (!error && ((!c && (!entry || entry->configurable)) ||
      (entry && !entry->configurable &&
       (c || e != entry->enumerable || accessor != entry->accessor ||
        (accessor
          ? (!scr_dyn_property_same_value(entry->getter ? entry->getter : scr_dyn_undefined(),
                                          getter ? getter : scr_dyn_undefined()) ||
             !scr_dyn_property_same_value(entry->setter ? entry->setter : scr_dyn_undefined(),
                                          setter ? setter : scr_dyn_undefined()))
          : (w != entry->writable ||
             (!w && !scr_dyn_property_same_value(entry->value, data ? data : scr_dyn_undefined())))))))) {
    scr_dyn_release(desc);
    scr_dyn_proxy_invariant();
    return NULL;
  }
  if (error) {
    scr_throw_error_msg(SCR_ERR_TYPE, error, strlen(error));
    scr_dyn_release(desc);
    return NULL;
  }
  ScrDyn *out = scr_dyn_new_obj();
  if (getter || setter) {
    scr_dyn_obj_set(out, "get", 3, scr_dyn_retain(getter ? getter : scr_dyn_undefined()));
    scr_dyn_obj_set(out, "set", 3, scr_dyn_retain(setter ? setter : scr_dyn_undefined()));
  } else {
    scr_dyn_obj_set(out, "value", 5, scr_dyn_retain(data ? data : scr_dyn_undefined()));
    scr_dyn_obj_set(out, "writable", 8, scr_dyn_new_bool(writable && scr_dyn_truthy(writable)));
  }
  scr_dyn_obj_set(out, "enumerable", 10, scr_dyn_new_bool(enumerable && scr_dyn_truthy(enumerable)));
  scr_dyn_obj_set(out, "configurable", 12, scr_dyn_new_bool(c));
  scr_dyn_release(desc);
  return out;
}

void scr_dyn_proxy_set(ScrDyn *proxy, ScrStr *key, ScrDyn *value) {
  ScrDyn *trap = scr_dyn_proxy_trap(proxy, "set");
  if (scr_exc_pending()) return;
  if (!trap) {
    if (proxy->v.proxy.target->kind == SCR_DYN_TYPED_REF) {
      scr_dyn_key_set(proxy->v.proxy.target, key, value);
      return;
    }
    /* OrdinarySet uses the Proxy receiver's [[GetOwnProperty]] and
     * [[DefineOwnProperty]]. Keep that boundary explicit for now. */
    scr_dyn_proxy_unsupported("assignment without a set trap");
    return;
  }
  ScrDyn *property = scr_dyn_new_str(key);
  ScrDyn *args[] = { proxy->v.proxy.target, property, value, proxy };
  ScrDyn *result = scr_dyn_proxy_call(proxy, trap, args, 4);
  scr_dyn_release(property);
  if (result && !scr_dyn_truthy(result)) {
    /* The keyed-write ABI does not carry lexical strictness yet. A
     * falsish trap is an ignored write in sloppy code and a TypeError
     * in strict code; retain an explicit boundary instead of guessing. */
    scr_dyn_proxy_unsupported("falsish set traps");
  }
  ScrDynEntry *entry = scr_dyn_entry(proxy->v.proxy.target, key);
  if (!scr_exc_pending() && entry && !entry->configurable &&
      ((entry->accessor && !entry->setter) ||
       (!entry->accessor && !entry->writable && !scr_dyn_property_same_value(entry->value, value)))) scr_dyn_proxy_invariant();
  scr_dyn_release(result);
}

void scr_dyn_proxy_delete(ScrDyn *proxy, const ScrStr *key) {
  ScrDyn *trap = scr_dyn_proxy_trap(proxy, "deleteProperty");
  if (scr_exc_pending()) return;
  if (!trap) {
    ScrDynEntry *entry = scr_dyn_entry(proxy->v.proxy.target, key);
    if (entry && !entry->configurable) { scr_dyn_proxy_unsupported("deletion of non-configurable properties"); return; }
    scr_dyn_key_delete(proxy->v.proxy.target, key, true);
    return;
  }
  ScrDyn *property = scr_dyn_new_str((ScrStr *)key);
  ScrDyn *args[] = { proxy->v.proxy.target, property };
  ScrDyn *result = scr_dyn_proxy_call(proxy, trap, args, 2);
  scr_dyn_release(property);
  if (result && !scr_dyn_truthy(result)) {
    scr_dyn_proxy_unsupported("falsish deleteProperty traps");
  }
  ScrDynEntry *entry = scr_dyn_entry(proxy->v.proxy.target, key);
  if (!scr_exc_pending() && entry && !entry->configurable) scr_dyn_proxy_invariant();
  scr_dyn_release(result);
}

ScrDyn *scr_dyn_new_bytes(const ScrBytes *b) {
  ScrDyn *d = scr_dyn_alloc(SCR_DYN_BYTES);
  d->v.bytes = scr_bytes_retain((ScrBytes *)b);
  d->buffer = b->is_buffer;
  return d;
}

ScrDyn *scr_dyn_new_buffer(const ScrBytes *b) {
  if (b->is_buffer) return scr_dyn_new_bytes(b);
  // Converting a Uint8Array chunk to Buffer creates a distinct view while
  // retaining the same allocation; the source keeps its Uint8Array brand.
  ScrBytes *view = scr_bytes_subarray((ScrBytes *)b, 0, (double)b->len);
  view->is_buffer = true;
  ScrDyn *d = scr_dyn_new_bytes(view);
  scr_bytes_release(view);
  return d;
}

/* ── Undeclared properties of checked records ──────────────────────────
 * A checked conversion from an ordinary object into a closed record layout
 * stores only the declared fields natively. In Node the other own
 * properties stay on the same object, where JSON.stringify, untyped reads,
 * Object.keys and util.inspect still observe them in insertion order. When
 * the source carries undeclared keys, the conversion keeps a shallow copy of
 * the source's own properties here, keyed by the native record and released
 * when the record is freed (the native dispose hook). The copy fixes the
 * own-key order; declared keys hold placeholders, because the record stays
 * the source of truth for their values. It is also the record's checked
 * view: every capsule for the record adopts it, so properties written
 * through untyped references persist after the capsule is gone, and the
 * typed serializers of such a record go through its capsule. */
typedef struct {
  void *rec;
  ScrDyn *view;
  /* The shape's declared names in declaration order, as static strided
   * tables: the compiler's name/length arrays, or a JSON schema's fields. */
  const char *names;
  const char *lens;
  size_t name_stride, len_stride, count;
} ScrRecordSource;
static SCR_TL ScrRecordSource *scr_record_sources;
static SCR_TL size_t scr_record_source_capacity, scr_record_source_count;
/* Deleted slots keep this marker so probe runs stay intact without moving
 * entries (records free in conversion order, so a backward shift would
 * rescan the same run on every deletion); insertion reuses them and the
 * rehash drops them. */
#define SCR_RECORD_SOURCE_DELETED ((void *)1)
static SCR_TL size_t scr_record_source_deleted;
/* Every native object free reports to the dispose hook, and most freed
 * objects have no entry: a bit filter over the entry keys (cleared when the
 * table empties) answers those without probing the table. */
#define SCR_RECORD_SOURCE_FILTER_BITS 20
static SCR_TL uint64_t *scr_record_source_filter;

static size_t scr_record_source_filter_bit(const void *rec) {
  return (size_t)(((uint64_t)(uintptr_t)rec >> 4) * UINT64_C(0x9E3779B97F4A7C15) >>
                  (64 - SCR_RECORD_SOURCE_FILTER_BITS));
}

/* Records converted together are usually allocated together, and are
 * then serialized and freed in that order: keys within one 1 KiB region
 * keep their order in a 64-slot run, and the runs scatter by a mix of the
 * region, so sequential work touches neighboring slots. */
static size_t scr_record_source_bucket(const void *rec) {
  uint64_t key = (uint64_t)(uintptr_t)rec >> 4;
  uint64_t run = (key >> 6) * UINT64_C(0x9E3779B97F4A7C15);
  run ^= run >> 29;
  return (size_t)((run << 6) | (key & 63)) & (scr_record_source_capacity - 1);
}

static ScrRecordSource *scr_record_source_find(const void *rec) {
  if (!scr_record_source_count) return NULL;
  size_t mask = scr_record_source_capacity - 1;
  for (size_t slot = scr_record_source_bucket(rec); scr_record_sources[slot].rec;
       slot = (slot + 1) & mask) {
    if (scr_record_sources[slot].rec == rec) return &scr_record_sources[slot];
  }
  return NULL;
}

/* The retained view of a record with undeclared keys (borrowed), or NULL. */
ScrDyn *scr_record_source_view(const void *rec) {
  ScrRecordSource *entry = scr_record_source_find(rec);
  return entry ? entry->view : NULL;
}

bool scr_record_source_has(const void *rec) {
  return scr_record_source_count && scr_record_source_find(rec) != NULL;
}

/* Drops the entry at `found` from the table, releasing its view. The table
 * no longer refers to the view first, so a nested disposal that re-enters
 * the dispose hook sees a consistent table. */
static void scr_record_source_drop(ScrRecordSource *found) {
  ScrDyn *view = found->view;
  *found = (ScrRecordSource){ .rec = SCR_RECORD_SOURCE_DELETED };
  scr_record_source_count--;
  scr_record_source_deleted++;
  scr_dyn_release(view);
}

static void scr_record_source_disposed(void *rec) {
  size_t bit = scr_record_source_filter_bit(rec);
  if (!(scr_record_source_filter[bit >> 6] & (UINT64_C(1) << (bit & 63)))) return;
  ScrRecordSource *found = scr_record_source_find(rec);
  if (found) scr_record_source_drop(found);
}

/* The single native dispose hook serves weak collections and the table
 * above; each observer runs only while it has entries to forget. */
static void scr_dispose_observers(void *object) {
  if (scr_weak_observing) scr_weak_disposed(object);
  if (scr_record_source_count) scr_record_source_disposed(object);
}

/* Keeps live entries plus deleted markers at most half the table: grows
 * when live entries fill a quarter, otherwise rehashes in place to drop the
 * markers. A large rehash also rebuilds the dispose filter, so stale bits
 * of freed records stop costing probes (amortized over the deletions). */
static void scr_record_source_reserve(void) {
  size_t used = scr_record_source_count + scr_record_source_deleted;
  if (scr_record_source_capacity && used < scr_record_source_capacity / 2) return;
  size_t old_capacity = scr_record_source_capacity;
  ScrRecordSource *old = scr_record_sources;
  scr_record_source_capacity =
      !old_capacity ? 256
      : scr_record_source_count >= old_capacity / 4 ? old_capacity * 2
                                                    : old_capacity;
  scr_record_sources = calloc(scr_record_source_capacity, sizeof *scr_record_sources);
  if (!scr_record_sources) scr_json_oom();
  bool refilter = scr_record_source_filter && old_capacity >= 16384;
  if (refilter) {
    memset(scr_record_source_filter, 0, ((size_t)1 << SCR_RECORD_SOURCE_FILTER_BITS) / 8);
  }
  for (size_t i = 0; i < old_capacity; i++) {
    if (!old[i].rec || old[i].rec == SCR_RECORD_SOURCE_DELETED) continue;
    size_t slot = scr_record_source_bucket(old[i].rec);
    while (scr_record_sources[slot].rec) slot = (slot + 1) & (scr_record_source_capacity - 1);
    scr_record_sources[slot] = old[i];
    if (refilter) {
      size_t bit = scr_record_source_filter_bit(old[i].rec);
      scr_record_source_filter[bit >> 6] |= UINT64_C(1) << (bit & 63);
    }
  }
  scr_record_source_deleted = 0;
  free(old);
}

/* The key's position in the shape's declaration order, or count. */
static size_t scr_record_source_index(const ScrRecordSource *source, const char *key,
                                      size_t key_len) {
  for (size_t i = 0; i < source->count; i++) {
    size_t len;
    memcpy(&len, source->lens + i * source->len_stride, sizeof len);
    if (len != key_len) continue;
    const char *name;
    memcpy(&name, source->names + i * source->name_stride, sizeof name);
    if (memcmp(name, key, key_len) == 0) return i;
  }
  return source->count;
}

static bool scr_record_source_declared(const ScrRecordSource *source, const char *key,
                                       size_t key_len) {
  return scr_record_source_index(source, key, key_len) < source->count;
}

/* Frees the table at thread exit (a worker's table dies with its thread):
 * the storage is detached before any remaining view is released. */
static void scr_record_source_teardown(void) {
  ScrRecordSource *table = scr_record_sources;
  size_t capacity = scr_record_source_capacity;
  scr_record_sources = NULL;
  scr_record_source_capacity = scr_record_source_count = scr_record_source_deleted = 0;
  free(scr_record_source_filter);
  scr_record_source_filter = NULL;
  for (size_t i = 0; i < capacity; i++) {
    if (table[i].rec && table[i].rec != SCR_RECORD_SOURCE_DELETED) scr_dyn_release(table[i].view);
  }
  free(table);
}

/* Inserts the entry of a record the caller just built; the table takes
 * the entry's view. A fresh record has no entry: the previous owner of its
 * address left the table when it was freed (the dispose hook). */
static void scr_record_source_put(const ScrRecordSource *entry) {
  if (!scr_record_sources) scr_atexit(scr_record_source_teardown);
  scr_record_source_reserve();
  if (!scr_record_source_filter) {
    scr_record_source_filter = calloc(((size_t)1 << SCR_RECORD_SOURCE_FILTER_BITS) / 64,
                                      sizeof *scr_record_source_filter);
    if (!scr_record_source_filter) scr_json_oom();
  }
  size_t bit = scr_record_source_filter_bit(entry->rec);
  scr_record_source_filter[bit >> 6] |= UINT64_C(1) << (bit & 63);
  /* Take the first deleted slot of the key's probe run, or the empty slot
   * that ends it. */
  size_t mask = scr_record_source_capacity - 1;
  size_t slot = scr_record_source_bucket(entry->rec);
  while (scr_record_sources[slot].rec && scr_record_sources[slot].rec != SCR_RECORD_SOURCE_DELETED)
    slot = (slot + 1) & mask;
  if (scr_record_sources[slot].rec == SCR_RECORD_SOURCE_DELETED) scr_record_source_deleted--;
  scr_record_sources[slot] = *entry;
  scr_record_source_count++;
  scr_weak_dispose_hook = &scr_dispose_observers;
}

/* Called by the checked record builder after it filled `rec` from `src`;
 * `names` lists the shape's fields in declaration order. Keeps nothing
 * unless the source has an own property the shape does not declare, or
 * holds the declared ones in another order than the record serializes
 * them. Borrows both. */
void scr_record_source_note(void *rec, const ScrDyn *src, const char *const *names,
                            const size_t *lens, size_t count) {
  if (!rec || !src || src->kind != SCR_DYN_OBJ || src->v.obj.source_identity) return;
  ScrRecordSource probe = { rec, NULL, (const char *)names, (const char *)lens,
                            sizeof *names, sizeof *lens, count };
  bool keep = false;
  size_t next = 0;
  for (size_t i = 0; i < src->v.obj.len && !keep; i++) {
    const ScrDynEntry *entry = &src->v.obj.entries[i];
    size_t index = scr_record_source_index(&probe, entry->key, entry->key_len);
    keep = index == count || index < next;
    next = index + 1;
  }
  if (!keep) return;
  ScrDyn *view = scr_dyn_new_obj();
  for (size_t i = 0; i < src->v.obj.len; i++) {
    const ScrDynEntry *entry = &src->v.obj.entries[i];
    if (scr_record_source_declared(&probe, entry->key, entry->key_len)) {
      scr_dyn_obj_set(view, entry->key, entry->key_len, scr_dyn_retain(scr_dyn_undefined()));
    } else if (!entry->accessor && entry->writable && entry->enumerable && entry->configurable) {
      scr_dyn_obj_set(view, entry->key, entry->key_len, scr_dyn_retain(entry->value));
    } else {
      ScrStr *name = scr_str_new(entry->key, entry->key_len);
      ScrDyn *key = scr_dyn_new_str(name);
      ScrDyn *descriptor = scr_dyn_own_descriptor(src, name);
      ScrDyn *defined = descriptor ? scr_dyn_define_property(view, key, descriptor) : NULL;
      scr_dyn_release(defined);
      scr_dyn_release(descriptor);
      scr_dyn_release(key);
      scr_str_release(name);
    }
  }
  probe.view = view;
  scr_record_source_put(&probe);
}

void scr_record_source_move(void *from, void *to) {
  if (!scr_record_source_count) return;
  ScrRecordSource *old = scr_record_source_find(to);
  if (old) scr_record_source_drop(old);
  ScrRecordSource *found = scr_record_source_find(from);
  if (!found) return;
  ScrRecordSource moved = *found;
  *found = (ScrRecordSource){ .rec = SCR_RECORD_SOURCE_DELETED };
  scr_record_source_count--;
  scr_record_source_deleted++;
  moved.rec = to;
  scr_record_source_put(&moved);
}

/* Refreshes a retained record view: the view's own-key order, declared
 * values from the native snapshot (a declared key the record no longer has
 * drops), every other property as the view holds it, then declared fields
 * the view had not seen yet. Returns a fresh object (+1). */
static ScrDyn *scr_record_source_merge(const ScrRecordSource *source, const ScrDyn *cached,
                                       const ScrDyn *fresh) {
  ScrDyn *out = scr_dyn_new_obj();
  for (size_t i = 0; i < cached->v.obj.len; i++) {
    const ScrDynEntry *entry = &cached->v.obj.entries[i];
    ScrDyn *value = scr_dyn_obj_get(fresh, entry->key, entry->key_len);
    if (value) {
      scr_dyn_obj_set(out, entry->key, entry->key_len, scr_dyn_retain(value));
      continue;
    }
    if (scr_record_source_declared(source, entry->key, entry->key_len)) continue;
    if (!entry->accessor && entry->writable && entry->enumerable && entry->configurable) {
      scr_dyn_obj_set(out, entry->key, entry->key_len, scr_dyn_retain(entry->value));
      continue;
    }
    ScrStr *name = scr_str_new(entry->key, entry->key_len);
    ScrDyn *key = scr_dyn_new_str(name);
    ScrDyn *descriptor = scr_dyn_own_descriptor(cached, name);
    ScrDyn *defined = descriptor ? scr_dyn_define_property(out, key, descriptor) : NULL;
    scr_dyn_release(defined);
    scr_dyn_release(descriptor);
    scr_dyn_release(key);
    scr_str_release(name);
  }
  for (size_t i = 0; i < fresh->v.obj.len; i++) {
    const ScrDynEntry *entry = &fresh->v.obj.entries[i];
    if (scr_dyn_obj_get(out, entry->key, entry->key_len)) continue;
    scr_dyn_obj_set(out, entry->key, entry->key_len, scr_dyn_retain(entry->value));
  }
  return out;
}

/* A fresh, unshared record→dyn snapshot from the copying converter:
 * consumes it and returns the snapshot merged through the record's
 * retained view (+1), or the snapshot itself when there is none. */
ScrDyn *scr_record_source_apply(ScrDyn *snapshot, const void *rec) {
  ScrRecordSource *source = scr_record_source_find(rec);
  if (!source || !snapshot || snapshot->kind != SCR_DYN_OBJ) return snapshot;
  ScrDyn *merged = scr_record_source_merge(source, source->view, snapshot);
  scr_dyn_release(snapshot);
  return merged;
}

static ScrDyn *scr_json_member(const ScrDyn *holder, const ScrStr *key);
static bool scr_jb_try_pure_member(ScrJsonBuf *b, const char *key, size_t key_len,
                                   const ScrStr *key_str, const ScrDyn *value, bool *first);
static bool scr_jb_put_member(ScrJsonBuf *b, const ScrStr *key, ScrDyn *value, bool *first,
                              void *rec);

/* JSON for a record that kept a source: the view's own-key order, declared
 * fields through the compiled writer (`field` writes the separator, key
 * and value of field `index` unless the record lacks it, and answers
 * whether it wrote), every other enumerable property with JSON.stringify's
 * member rules (accessors read, toJSON called with the key, undefined,
 * function and symbol results dropped, circular structures rejected), then
 * declared fields the view had not seen. May leave an exception pending
 * (a BigInt property, a throwing toJSON or getter, a circular structure). */
void scr_jb_put_record_source(ScrJsonBuf *b, void *rec,
                              bool (*field)(ScrJsonBuf *, void *, size_t, bool)) {
  if (!scr_jb_try_record_source(b, rec, field)) scr_jb_puts(b, "{}");
}

/* Writes declared field `index`; when the record is on the circular-
 * structure stack, the field's name becomes its edge first. */
static bool scr_jb_put_source_field(ScrJsonBuf *b, void *rec, const ScrRecordSource *source,
                                    size_t index, bool first, bool on_stack,
                                    bool (*field)(ScrJsonBuf *, void *, size_t, bool)) {
  if (on_stack) {
    size_t len;
    memcpy(&len, source->lens + index * source->len_stride, sizeof len);
    const char *name;
    memcpy(&name, source->names + index * source->name_stride, sizeof name);
    scr_jb_edge_span(b, name, len);
  }
  return field(b, rec, index, first);
}

/* The same in one lookup: writes the record and answers true when it kept
 * a source, otherwise writes nothing and answers false. */
static bool scr_dyn_key_is_index(const char *key, size_t len, double *out);

typedef struct {
  double index;
  size_t entry;
} ScrRecordSourceIntegerKey;

static int scr_record_source_integer_cmp(const void *a, const void *b) {
  double x = ((const ScrRecordSourceIntegerKey *)a)->index;
  double y = ((const ScrRecordSourceIntegerKey *)b)->index;
  return (x > y) - (x < y);
}

/* The entry indexes of `view` in JavaScript's own-key order: integer keys
 * ascending, then the other keys in insertion order. `out` holds len. */
static void scr_record_source_key_order(const ScrDyn *view, size_t *out) {
  size_t len = view->v.obj.len;
  ScrRecordSourceIntegerKey small[64];
  ScrRecordSourceIntegerKey *keys = len <= 64 ? small : malloc(len * sizeof *keys);
  if (!keys) scr_json_oom();
  size_t integers = 0, next = 0;
  for (size_t i = 0; i < len; i++) {
    const ScrDynEntry *entry = &view->v.obj.entries[i];
    double index;
    if (scr_dyn_key_is_index(entry->key, entry->key_len, &index))
      keys[integers++] = (ScrRecordSourceIntegerKey){ index, i };
  }
  /* Integer keys are distinct, so the order is total. */
  qsort(keys, integers, sizeof *keys, scr_record_source_integer_cmp);
  for (size_t i = 0; i < integers; i++) out[next++] = keys[i].entry;
  for (size_t i = 0; i < len; i++) {
    const ScrDynEntry *entry = &view->v.obj.entries[i];
    double index;
    if (!scr_dyn_key_is_index(entry->key, entry->key_len, &index)) out[next++] = i;
  }
  if (keys != small) free(keys);
}

bool scr_jb_try_record_source(ScrJsonBuf *b, void *rec,
                              bool (*field)(ScrJsonBuf *, void *, size_t, bool)) {
  ScrRecordSource *found = scr_record_source_find(rec);
  if (!found) return false;
  /* Program code run by a member can add record sources and move the
   * table's entries, so the walk keeps its own copy. */
  const ScrRecordSource source = *found;
  /* Walkers over cycle-capable shapes have pushed the record already.
   * Others push it before the first member that needs the protocol walk,
   * so a member leading back to the record closes the circle at the
   * record. */
  bool on_stack = b->seen_len && b->seen[b->seen_len - 1].ptr == rec;
  bool entered = false;
  ScrDyn *view = scr_dyn_retain(source.view);
  scr_jb_putc(b, '{');
  bool first = true;
  size_t count = source.count;
  bool small[64] = { false };
  bool *seen = count <= 64 ? small : calloc(count, sizeof *seen);
  if (!seen) scr_json_oom();
  /* Integer keys come first in JavaScript's own-key order; a view without
   * any walks in insertion order. */
  size_t order_small[64];
  size_t *order = NULL;
  for (size_t k = 0; k < view->v.obj.len && !order; k++) {
    double index;
    if (!scr_dyn_key_is_index(view->v.obj.entries[k].key, view->v.obj.entries[k].key_len, &index)) continue;
    order = view->v.obj.len <= 64 ? order_small : malloc(view->v.obj.len * sizeof *order);
    if (!order) scr_json_oom();
    scr_record_source_key_order(view, order);
  }
  /* Members whose writing cannot run program code are written in place.
   * The first member that can (an accessor, a toJSON method, a getter below
   * it) ends that loop: the remaining keys are taken first, as
   * SerializeJSONObject takes them before reading any value. */
  size_t i = 0;
  for (; i < view->v.obj.len && !scr_exc_pending(); i++) {
    const ScrDynEntry *entry = &view->v.obj.entries[order ? order[i] : i];
    size_t index = scr_record_source_index(&source, entry->key, entry->key_len);
    if (index < count) {
      if (!seen[index] && scr_jb_put_source_field(b, rec, &source, index, first, on_stack, field))
        first = false;
      seen[index] = true;
      continue;
    }
    if (!entry->enumerable) continue;
    if (entry->accessor ||
        !scr_jb_try_pure_member(b, entry->key, entry->key_len, NULL, entry->value, &first))
      break;
  }
  if (i < view->v.obj.len && !scr_exc_pending() && !on_stack) {
    entered = scr_jb_enter(b, rec, false);
    on_stack = entered;
  }
  if (i < view->v.obj.len && !scr_exc_pending()) {
    ScrDyn *rest = scr_dyn_new_arr();
    for (size_t j = i; j < view->v.obj.len; j++) {
      const ScrDynEntry *entry = &view->v.obj.entries[order ? order[j] : j];
      if (!entry->enumerable && !scr_record_source_declared(&source, entry->key, entry->key_len)) continue;
      ScrStr *name = scr_str_new(entry->key, entry->key_len);
      scr_dyn_arr_push(rest, scr_dyn_new_str(name));
      scr_str_release(name);
    }
    for (size_t j = 0; j < rest->v.arr.len && !scr_exc_pending(); j++) {
      const ScrStr *key = rest->v.arr.items[j]->v.str;
      size_t index = scr_record_source_index(&source, key->data, key->len);
      if (index < count) {
        if (!seen[index] && scr_jb_put_source_field(b, rec, &source, index, first, on_stack, field))
        first = false;
        seen[index] = true;
        continue;
      }
      ScrDyn *value = scr_json_member(view, key);
      if (!value || !scr_jb_put_member(b, key, value, &first, NULL)) break;
    }
    scr_dyn_release(rest);
  }
  for (size_t index = 0; index < count && !scr_exc_pending(); index++) {
    if (!seen[index] && scr_jb_put_source_field(b, rec, &source, index, first, on_stack, field))
      first = false;
  }
  if (seen != small) free(seen);
  if (order && order != order_small) free(order);
  scr_dyn_release(view);
  scr_jb_putc(b, '}');
  if (entered) scr_jb_leave(b);
  return true;
}

/* The flags are written with the rest of the capsule: setting a flag bit
 * afterwards is a byte store that the next read of the flag word (the
 * live-view bind right after construction) cannot forward from. */
static ScrDyn *scr_dyn_typed_ref_new(
    void *ptr, void *(*retain)(void *), void (*release)(void *),
    const char *type_key, size_t type_key_len,
    ScrDyn *(*materialize)(void *),
    void (*commit)(void *, const ScrDyn *), bool traced, bool observed) {
  scr_typed_ref_reserve();
  size_t slot = scr_typed_ref_bucket(ptr);
  for (ScrDyn *value; (value = scr_typed_ref_slots[slot]); slot = (slot + 1) & (scr_typed_ref_capacity - 1)) {
    if (value->v.typed_ref.ptr == ptr && value->v.typed_ref.retain == retain &&
        value->v.typed_ref.materialize == materialize && value->v.typed_ref.commit == commit &&
        value->v.typed_ref.type_key_len == type_key_len && !memcmp(value->v.typed_ref.type_key, type_key, type_key_len)) {
      if (traced) value->v.typed_ref.traced = true;
      if (observed) value->v.typed_ref.observed = true;
      return scr_dyn_retain(value);
    }
  }
  if (type_key_len >= (size_t)1 << 27) scr_trap("scriptc: typed reference key too long\n");
  ScrDyn *d = scr_dyn_alloc(SCR_DYN_TYPED_REF);
  d->v.typed_ref.ptr = retain(ptr);
  d->v.typed_ref.retain = retain;
  d->v.typed_ref.release = release;
  d->v.typed_ref.type_key = type_key;
  d->v.typed_ref.type_key_len = (uint32_t)type_key_len;
  d->v.typed_ref.materialize = materialize;
  d->v.typed_ref.commit = commit;
  d->v.typed_ref.array = NULL;
  d->v.typed_ref.materialized = NULL;
  /* A record with undeclared properties starts from its retained view
   * (refreshed on first use), which also keeps the declared-field fast
   * paths off for it. */
  if (scr_record_source_count && type_key_len >= 7 && memcmp(type_key, "record:", 7) == 0) {
    ScrDyn *view = scr_record_source_view(ptr);
    if (view) d->v.typed_ref.materialized = scr_dyn_retain(view);
  }
  d->v.typed_ref.casts = NULL;
  d->v.typed_ref.traced = traced;
  d->v.typed_ref.observed = observed;
  d->v.typed_ref.record = false;
  d->v.typed_ref.klass = false;
  d->v.typed_ref.bag_class = false;
  scr_typed_ref_slots[slot] = d; /* the empty slot that ended the probe */
  scr_typed_ref_count++;
  return d;
}

ScrDyn *scr_dyn_new_typed_ref(
    void *ptr, void *(*retain)(void *), void (*release)(void *),
    const char *type_key, size_t type_key_len,
    ScrDyn *(*materialize)(void *),
    void (*commit)(void *, const ScrDyn *)) {
  return scr_dyn_typed_ref_new(ptr, retain, release, type_key, type_key_len, materialize, commit,
                               false, false);
}

ScrDyn *scr_dyn_new_typed_ref_traced(
    void *ptr, void *(*retain)(void *), void (*release)(void *),
    const char *type_key, size_t type_key_len,
    ScrDyn *(*materialize)(void *),
    void (*commit)(void *, const ScrDyn *)) {
  return scr_dyn_typed_ref_new(ptr, retain, release, type_key, type_key_len, materialize, commit,
                               true, true);
}

ScrDyn *scr_dyn_new_typed_ref_observed(
    void *ptr, void *(*retain)(void *), void (*release)(void *),
    const char *type_key, size_t type_key_len,
    ScrDyn *(*materialize)(void *), void (*commit)(void *, const ScrDyn *)) {
  return scr_dyn_typed_ref_new(ptr, retain, release, type_key, type_key_len, materialize, commit,
                               false, true);
}

bool scr_dyn_typed_ref_is(
    const ScrDyn *d, const char *type_key, size_t type_key_len) {
  return d && d->kind == SCR_DYN_TYPED_REF &&
         d->v.typed_ref.type_key_len == type_key_len &&
         memcmp(d->v.typed_ref.type_key, type_key, type_key_len) == 0;
}

bool scr_dyn_typed_ref_is_key(const ScrDyn *d, const ScrStr *type_key) {
  return scr_dyn_typed_ref_is(d, type_key->data, type_key->len);
}

void *scr_dyn_typed_ref_unbox(const ScrDyn *d) {
  return d->v.typed_ref.retain(d->v.typed_ref.ptr);
}

static void scr_dyn_typed_ref_preserve_child(
    ScrDyn **fresh_slot, ScrDyn *cached_child) {
  ScrDyn *fresh_child = *fresh_slot;
  if (!cached_child || !fresh_child ||
      cached_child->kind != SCR_DYN_TYPED_REF ||
      fresh_child->kind != SCR_DYN_TYPED_REF ||
      !scr_dyn_strict_eq(cached_child, fresh_child)) {
    return;
  }
  *fresh_slot = scr_dyn_retain(cached_child);
  scr_dyn_release(fresh_child);
}

/* A live record/array materializer creates typed capsules for mutable
 * children. Preserve an existing child capsule when the fresh view points
 * at the same static source, so retaining `value.child` across parent
 * refreshes keeps JavaScript reference identity as well as liveness. */
static void scr_dyn_typed_ref_preserve_children(
    ScrDyn *cached, ScrDyn *fresh) {
  if (cached->kind != fresh->kind) return;
  if (cached->kind == SCR_DYN_ARR) {
    size_t n = cached->v.arr.len < fresh->v.arr.len
        ? cached->v.arr.len
        : fresh->v.arr.len;
    for (size_t i = 0; i < n; i++) {
      scr_dyn_typed_ref_preserve_child(
          &fresh->v.arr.items[i], cached->v.arr.items[i]);
    }
    return;
  }
  if (cached->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < fresh->v.obj.len; i++) {
      ScrDynEntry *entry = &fresh->v.obj.entries[i];
      ScrDyn *cached_child = scr_dyn_obj_get(
          cached, entry->key, entry->key_len);
      scr_dyn_typed_ref_preserve_child(&entry->value, cached_child);
    }
  }
}

ScrDyn *scr_dyn_class_view_unavailable(void *ptr) {
  (void)ptr;
  static const char message[] = "class fields cannot be represented as checked-dynamic properties";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  return scr_dyn_retain(scr_dyn_undefined());
}

void scr_dyn_copy_entry(ScrDyn *target, const ScrDyn *source, const ScrDynEntry *entry) {
  ScrStr *key = scr_str_new(entry->key, entry->key_len);
  if (!entry->accessor && entry->writable && entry->enumerable && entry->configurable) {
    scr_dyn_key_set(target, key, entry->value);
  } else {
    /* Properties defined through a view keep their attributes. */
    ScrDyn *name = scr_dyn_new_str(key);
    ScrDyn *descriptor = scr_dyn_own_descriptor(source, key);
    if (descriptor) scr_dyn_release(scr_dyn_define_property(target, name, descriptor));
    scr_dyn_release(descriptor);
    scr_dyn_release(name);
  }
  scr_str_release(key);
}

static ScrDyn *scr_typed_ref_numeric_property(const ScrDyn *d, double key);

/* A live array's view lists the native numeric properties first, then the
 * named properties the snapshot copied from the array's metadata. */
static void scr_typed_ref_view_numeric_properties(const ScrDyn *capsule, ScrDyn *view) {
  const ScrDynTypedArrayOps *ops = scr_dyn_typed_ref_array_ops(capsule);
  ScrArr *arr = capsule->v.typed_ref.ptr;
  const ScrArrExt *x = ops ? scr_arr_ext_of(arr) : NULL;
  if (!x || x->prop_len == 0 || view->kind != SCR_DYN_ARR) return;
  ScrDyn *named = view->v.arr.properties;
  view->v.arr.properties = NULL;
  for (size_t i = 0; i < x->prop_len; i++) {
    double number;
    if (!scr_arr_numeric_key(x->props[i].key, x->props[i].key_len, &number)) continue;
    ScrDyn *value = scr_typed_ref_numeric_property(capsule, number);
    if (value) scr_dyn_arr_named_put(view, x->props[i].key, x->props[i].key_len, value);
  }
  if (!named) return;
  for (size_t i = 0; i < named->v.obj.len; i++) scr_dyn_copy_entry(view, named, &named->v.obj.entries[i]);
  scr_dyn_release(named);
}

ScrDyn *scr_dyn_typed_ref_materialize(const ScrDyn *d) {
  ScrDyn *capsule = (ScrDyn *)d;
  ScrDyn *fresh = capsule->v.typed_ref.materialize(capsule->v.typed_ref.ptr);
  if (scr_exc_pending()) {
    scr_dyn_release(fresh);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  scr_typed_ref_view_numeric_properties(capsule, fresh);
  if (!capsule->v.typed_ref.materialized) {
    capsule->v.typed_ref.materialized = fresh;
  } else {
    /* Keep the stable dyn object identity while refreshing its contents
     * from the live typed source. The fresh snapshot owns exactly one
     * reference; swapping payloads lets its release dispose the old
     * detached contents without changing the cached node's address. */
    scr_dyn_typed_ref_preserve_children(
        capsule->v.typed_ref.materialized, fresh);
    /* Record layouts cannot store properties added through a checked
     * view. Keep those descriptors in the view across native refreshes. */
    ScrDyn *cached = capsule->v.typed_ref.materialized;
    bool record_view = fresh->kind == SCR_DYN_OBJ && cached->kind == SCR_DYN_OBJ &&
                       capsule->v.typed_ref.type_key_len >= 7 &&
                       memcmp(capsule->v.typed_ref.type_key, "record:", 7) == 0;
    ScrRecordSource *source = record_view ? scr_record_source_find(capsule->v.typed_ref.ptr) : NULL;
    if (source) {
      /* Undeclared source properties keep their own-key position. */
      ScrDyn *ordered = scr_record_source_merge(source, cached, fresh);
      scr_dyn_release(fresh);
      fresh = ordered;
    } else if (record_view) {
      for (size_t i = 0; i < cached->v.obj.len; i++) {
        ScrDynEntry *entry = &cached->v.obj.entries[i];
        if (scr_dyn_obj_get(fresh, entry->key, entry->key_len)) continue;
        ScrStr *name = scr_str_new(entry->key, entry->key_len);
        ScrDyn *key = scr_dyn_new_str(name);
        ScrDyn *descriptor = scr_dyn_own_descriptor(cached, name);
        ScrDyn *defined = scr_dyn_define_property(fresh, key, descriptor);
        scr_dyn_release(defined);
        scr_dyn_release(descriptor);
        scr_dyn_release(key);
        scr_str_release(name);
      }
    }
    /* A native record stores its own fields, while its checked view owns
     * prototype changes. Refreshing fields must preserve that prototype. */
    scr_dyn_release(fresh->prototype);
    fresh->prototype = capsule->v.typed_ref.materialized->prototype ? scr_dyn_retain(capsule->v.typed_ref.materialized->prototype) : NULL;
    fresh->null_proto = capsule->v.typed_ref.materialized->null_proto;
    scr_dyn_release(fresh->symbol_properties);
    scr_dyn_release(fresh->symbol_keys);
    fresh->symbol_properties = capsule->v.typed_ref.materialized->symbol_properties ? scr_dyn_retain(capsule->v.typed_ref.materialized->symbol_properties) : NULL;
    fresh->symbol_keys = capsule->v.typed_ref.materialized->symbol_keys ? scr_dyn_retain(capsule->v.typed_ref.materialized->symbol_keys) : NULL;
    size_t cached_rc = capsule->v.typed_ref.materialized->rc;
    size_t fresh_rc = fresh->rc;
    ScrDyn old = *capsule->v.typed_ref.materialized;
    *capsule->v.typed_ref.materialized = *fresh;
    capsule->v.typed_ref.materialized->rc = cached_rc;
    *fresh = old;
    fresh->rc = fresh_rc;
    scr_dyn_release(fresh);
  }
  return scr_dyn_retain(capsule->v.typed_ref.materialized);
}

void scr_dyn_typed_ref_commit(ScrDyn *d) {
  if (d && d->kind == SCR_DYN_TYPED_REF && d->v.typed_ref.commit &&
      d->v.typed_ref.materialized) {
    d->v.typed_ref.commit(d->v.typed_ref.ptr,
                          d->v.typed_ref.materialized);
  }
}

/* ── live native arrays: per-element access ──────────────────────────────
 * Materializing rebuilds the whole array, so doing it for every `xs[i]`,
 * `xs.length`, or iteration step makes a loop over a live array quadratic.
 * The native array is the source of truth (every refresh rebuilds the view
 * from it and keeps only the prototype and symbol properties), so element
 * reads, presence, and in-range writes can consult it directly. Anything
 * whose answer may come from the prototype chain — holes and out-of-range
 * indexes — or needs the snapshot's diagnostics still takes the snapshot. */
void scr_dyn_typed_ref_bind_array(ScrDyn *d, const ScrDynTypedArrayOps *ops) {
  if (d && d->kind == SCR_DYN_TYPED_REF) {
    d->v.typed_ref.array = ops;
    d->v.typed_ref.record = false;
    d->v.typed_ref.klass = false;
    d->v.typed_ref.bag_class = false;
  }
}

/* ── live native records: per-field access ───────────────────────────────
 * A record's snapshot is a fresh ordinary object holding exactly its
 * present fields, in `names` order, with no prototype, symbols or extra
 * properties. Until something creates the capsule's cached view (a write,
 * a property definition, a prototype change, or any operation without a
 * field path), that snapshot is fully determined by the native record, so
 * reads, presence and key walks answer from the record directly and
 * convert only the field values they return. Once the view exists it may
 * hold state the record cannot (added properties, a prototype, changed
 * attributes), and every operation goes through it as before. */
void scr_dyn_typed_ref_bind_record(ScrDyn *d, const ScrDynTypedRecordOps *ops) {
  if (d && d->kind == SCR_DYN_TYPED_REF) {
    d->v.typed_ref.array = (const ScrDynTypedArrayOps *)(const void *)ops;
    d->v.typed_ref.record = true;
    d->v.typed_ref.klass = false;
    d->v.typed_ref.bag_class = false;
  }
}

void scr_dyn_typed_ref_bind_class(ScrDyn *d, const ScrDynTypedClassOps *ops) {
  if (d && d->kind == SCR_DYN_TYPED_REF) {
    d->v.typed_ref.array = (const ScrDynTypedArrayOps *)(const void *)ops;
    d->v.typed_ref.record = false;
    d->v.typed_ref.klass = true;
    d->v.typed_ref.bag_class = false;
  }
}

void scr_dyn_typed_ref_bind_bag_class(ScrDyn *d, const ScrDynTypedBagClassOps *ops) {
  if (d && d->kind == SCR_DYN_TYPED_REF) {
    d->v.typed_ref.array = (const ScrDynTypedArrayOps *)(const void *)ops;
    d->v.typed_ref.record = false;
    d->v.typed_ref.klass = false;
    d->v.typed_ref.bag_class = true;
  }
}

/* The view's own string keys are the bag's (ScrDynTypedBagClassOps). An
 * own data property answers as the view would hold it: a declared field
 * from its native slot (the materializer's ordinary write of that value,
 * which a read-only or accessor entry would refuse, so those take the
 * view), another property with the bag's value. A key the bag lacks is
 * looked up on the prototype the view has: the cached view's, which keeps
 * prototype changes made through the view, or for a capsule without one,
 * the prototype a fresh view takes. The walk is scr_dyn_obj_read_receiver's
 * from the view's prototype on, answering only when it meets an ordinary
 * data property before anything that needs more (an accessor, a function,
 * array or capsule link, Object.prototype). */
ScrDyn *scr_dyn_typed_ref_bag_method(const ScrDyn *d, const char *key, size_t key_len) {
  if (d->kind != SCR_DYN_TYPED_REF || !d->v.typed_ref.bag_class || d->prototype) return NULL;
  const ScrDynTypedBagClassOps *ops = (const ScrDynTypedBagClassOps *)(const void *)d->v.typed_ref.array;
  void *instance = d->v.typed_ref.ptr;
  const ScrDyn *bag = ops->bag(instance);
  if (bag && bag->kind != SCR_DYN_UNDEF) {
    if (bag->kind != SCR_DYN_OBJ) return NULL;
    const ScrDynEntry *own = scr_dyn_find_entry(bag, key, key_len);
    if (own) {
      for (size_t i = 0; i < ops->count; i++) {
        const ScrStr *name = ops->names[i];
        if (name->len != key_len || memcmp(name->data, key, key_len) != 0) continue;
        return own->accessor || !own->writable ? NULL : ops->field(instance, i);
      }
      return own->accessor ? NULL : scr_dyn_retain(own->value);
    }
  }
  ScrDyn *prototype;
  const ScrDyn *cached = d->v.typed_ref.materialized;
  if (cached) {
    if (cached->kind != SCR_DYN_OBJ || !cached->prototype) return NULL;
    prototype = scr_dyn_retain(cached->prototype);
  } else {
    prototype = ops->prototype(instance);
    if (scr_exc_pending()) {
      scr_dyn_release(prototype);
      return NULL;
    }
    if (!prototype) return NULL;
  }
  ScrDyn *found = NULL;
  for (const ScrDyn *current = prototype; current; current = current->prototype) {
    if (current == scr_builtin_object_prototype || current->kind == SCR_DYN_FUNC ||
        current->kind == SCR_DYN_ARR || current->kind == SCR_DYN_TYPED_REF)
      break;
    if (current->kind != SCR_DYN_OBJ) continue;
    ScrDynEntry *entry = scr_dyn_find_entry(current, key, key_len);
    if (!entry) continue;
    if (!entry->accessor) found = scr_dyn_retain(entry->value);
    break;
  }
  scr_dyn_release(prototype);
  return found;
}

static const ScrDynTypedClassOps *scr_typed_ref_class_ops(const ScrDyn *d) {
  if (!d->v.typed_ref.klass) return NULL;
  const ScrDynTypedClassOps *ops = (const ScrDynTypedClassOps *)(const void *)d->v.typed_ref.array;
  return ops->exact ? ops->exact(d->v.typed_ref.ptr) : ops;
}

const ScrStr *scr_dyn_typed_ref_class_name(const ScrDyn *d) {
  if (!d || d->kind != SCR_DYN_TYPED_REF || d->prototype) return NULL;
  const ScrDynTypedClassOps *ops = scr_typed_ref_class_ops(d);
  return ops ? ops->class_name : NULL;
}


static bool scr_dyn_name_in_strs(const ScrStr *key, ScrStr *const *names, size_t count) {
  for (size_t i = 0; i < count; i++) {
    if (names[i] == key || scr_str_eq(names[i], (ScrStr *)key)) return true;
  }
  return false;
}

bool scr_dyn_typed_ref_class_has(const ScrDyn *d, const ScrStr *key) {
  if (!d || d->kind != SCR_DYN_TYPED_REF || d->prototype) return false;
  const ScrDynTypedClassOps *ops = scr_typed_ref_class_ops(d);
  return ops && scr_dyn_name_in_strs(key, ops->names, ops->count);
}

static const ScrDynTypedRecordOps *scr_typed_ref_record_ops(const ScrDyn *d) {
  if (!d->v.typed_ref.record || d->v.typed_ref.materialized) return NULL;
  const ScrDynTypedRecordOps *ops = (const ScrDynTypedRecordOps *)(const void *)d->v.typed_ref.array;
  return ops && ops->select ? ops->select(d->v.typed_ref.ptr) : ops;
}

const ScrDynTypedRecordOps *scr_dyn_typed_ref_live_record(const ScrDyn *d) {
  return d->kind == SCR_DYN_TYPED_REF ? scr_typed_ref_record_ops(d) : NULL;
}

static bool scr_typed_ref_record_field(const ScrDynTypedRecordOps *ops, const ScrStr *key,
                                       size_t *out) {
  /* Compiled reads pass the interned literal the field names also use. */
  for (size_t i = 0; i < ops->count; i++) {
    if (ops->names[i] == key) {
      *out = i;
      return true;
    }
  }
  for (size_t i = 0; i < ops->count; i++) {
    const ScrStr *name = ops->names[i];
    if (name->len == key->len && memcmp(name->data, key->data, key->len) == 0) {
      *out = i;
      return true;
    }
  }
  return false;
}

/* +1 own field value, or NULL when `key` is not a present field. */
static ScrDyn *scr_typed_ref_record_get(const ScrDyn *d, const ScrStr *key) {
  const ScrDynTypedRecordOps *ops = scr_typed_ref_record_ops(d);
  size_t index;
  if (!ops || !scr_typed_ref_record_field(ops, key, &index)) return NULL;
  if (!ops->fixed && !ops->has(d->v.typed_ref.ptr, index)) return NULL;
  return ops->get(d->v.typed_ref.ptr, index);
}

/* The snapshot's own keys/values/entries walk, answered from the record. */
static ScrDyn *scr_typed_ref_record_walk(const ScrDyn *d, const ScrDynTypedRecordOps *ops,
                                         int mode /* ScrObjWalk */);

static bool scr_typed_ref_canonical_index(const char *data, size_t len, size_t *out) {
  if (len == 0 || len > 10 || (len > 1 && data[0] == '0')) return false;
  uint64_t index = 0;
  for (size_t i = 0; i < len; i++) {
    if (data[i] < '0' || data[i] > '9') return false;
    index = index * 10 + (uint64_t)(data[i] - '0');
  }
  if (index >= 4294967295ULL) return false;
  *out = (size_t)index;
  return true;
}

static bool scr_typed_ref_is_length(const ScrStr *key) {
  return key->len == 6 && memcmp(key->data, "length", 6) == 0;
}

ScrDyn *scr_dyn_typed_ref_element(const ScrDyn *d, size_t index) {
  ScrArr *arr = d->v.typed_ref.ptr;
  if (index >= arr->len) return NULL;
  double state = scr_arr_state(arr, (double)index);
  if (state == (double)SCR_ARR_VALUE) return scr_dyn_typed_ref_array_ops(d)->get(arr, (double)index);
  if (state == (double)SCR_ARR_UNDEFINED) return scr_dyn_retain(scr_dyn_undefined());
  return NULL;
}

SCR_TL const ScrEventRefHooks *scr_event_ref_hooks = NULL;

/* d[index] for a numeric index without forming the key string (see the
 * header): dyn arrays answer in-range elements, and live array capsules
 * their present and explicitly undefined elements. */
ScrDyn *scr_dyn_index_get(const ScrDyn *d, double index) {
  if (!(index >= 0 && index < 4294967295.0)) return NULL;
  size_t i = (size_t)index;
  if ((double)i != index) return NULL;
  if (d->kind == SCR_DYN_ARR) return i < d->v.arr.len ? scr_dyn_retain(d->v.arr.items[i]) : NULL;
  if (d->kind != SCR_DYN_TYPED_REF || scr_event_ref_hooks || !scr_dyn_typed_ref_array_ops(d))
    return NULL;
  return scr_dyn_typed_ref_element(d, i);
}

ScrDyn *scr_dyn_typed_ref_string_view(const ScrDyn *d) {
  /* An instance of a class declared `extends Date` converts through its
   * toString, declared or inherited. With an exception pending the view is
   * the empty string. */
  double time;
  if (scr_dyn_date_class_time(d, &time)) {
    ScrDyn *text = scr_dyn_date_class_to_string(d);
    if (text) return text;
    ScrStr *empty = scr_str_new("", 0);
    ScrDyn *out = scr_dyn_new_str(empty);
    scr_str_release(empty);
    return out;
  }
  ScrDyn *view = scr_dyn_typed_ref_materialize(d);
  const char *tag = scr_event_ref_hooks ? scr_event_ref_hooks->string_tag(d) : NULL;
  if (!tag || view->kind != SCR_DYN_OBJ || scr_dyn_property_owner(view, "toString", 8)) return view;
  scr_dyn_release(view);
  ScrStr *text = scr_str_new(tag, strlen(tag));
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}

/* A numeric property of a live array ("-1", "1.5"): +1, or NULL when the
 * native array has none. */
static ScrDyn *scr_typed_ref_numeric_property(const ScrDyn *d, double key) {
  ScrArr *arr = d->v.typed_ref.ptr;
  double state = scr_arr_state(arr, key);
  if (state == (double)SCR_ARR_VALUE) return scr_dyn_typed_ref_array_ops(d)->get(arr, key);
  if (state == (double)SCR_ARR_UNDEFINED) return scr_dyn_retain(scr_dyn_undefined());
  return NULL;
}

/* An inherited Date method of an instance of a class declared `extends
 * Date`, when the instance's own members do not define `key`: +1, or
 * NULL. */
ScrDyn *scr_dyn_date_class_member(const ScrDyn *d, const char *key, size_t key_len) {
  ScrDyn *method = scr_dyn_date_class_method(d, key, key_len);
  if (!method) return NULL;
  ScrDyn *view = scr_dyn_typed_ref_materialize(d);
  bool declared = view && !scr_exc_pending() && scr_dyn_property_owner(view, key, key_len);
  scr_dyn_release(view);
  if (!declared) return method;
  scr_dyn_release(method);
  return NULL;
}

ScrDyn *scr_dyn_typed_ref_key_get(const ScrDyn *d, const ScrStr *key) {
  if (d->v.typed_ref.record) return scr_typed_ref_record_get(d, key);
  if (scr_event_ref_hooks) {
    ScrDyn *inherited = scr_event_ref_hooks->get(d, key);
    if (inherited) return inherited;
  }
  ScrDyn *date_method = scr_dyn_date_class_member(d, key->data, key->len);
  if (date_method) return date_method;
  if (!scr_dyn_typed_ref_array_ops(d)) return NULL;
  if (scr_typed_ref_is_length(key)) return scr_dyn_new_num((double)((ScrArr *)d->v.typed_ref.ptr)->len);
  double number;
  if (scr_arr_numeric_key(key->data, key->len, &number)) return scr_typed_ref_numeric_property(d, number);
  size_t index;
  if (!scr_typed_ref_canonical_index(key->data, key->len, &index)) return NULL;
  return scr_dyn_typed_ref_element(d, index);
}

/* An own `length` or element answers `in`/hasOwn without the snapshot. */
static bool scr_typed_ref_array_has_own(const ScrDyn *d, const ScrStr *key) {
  if (!scr_dyn_typed_ref_array_ops(d)) return false;
  if (scr_typed_ref_is_length(key)) return true;
  double number;
  if (scr_arr_numeric_key(key->data, key->len, &number))
    return scr_arr_state(d->v.typed_ref.ptr, number) != (double)SCR_ARR_HOLE;
  size_t index;
  if (!scr_typed_ref_canonical_index(key->data, key->len, &index)) return false;
  ScrArr *arr = d->v.typed_ref.ptr;
  return index < arr->len && scr_arr_state(arr, (double)index) != (double)SCR_ARR_HOLE;
}

/* Writes an element in place or appends at `length`. False (nothing done)
 * when the value does not fit the element type or the write could grow the
 * array by more than one element: the snapshot path owns those outcomes. */
static bool scr_typed_ref_array_set(ScrDyn *d, const ScrStr *key, const ScrDyn *value) {
  const ScrDynTypedArrayOps *ops = scr_dyn_typed_ref_array_ops(d);
  if (!ops || !ops->set) return false;
  /* Numeric properties live in the native array's property table, which
   * holds values of the element type. */
  double number;
  if (scr_arr_numeric_key(key->data, key->len, &number)) {
    if (ops->set(d->v.typed_ref.ptr, number, value)) return true;
    ScrStr *kind = scr_dyn_typeof(value);
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "expected the array's element type at $[");
    scr_jb_write(&message, key->data, key->len);
    scr_jb_puts(&message, "], got ");
    scr_jb_write(&message, kind->data, kind->len);
    scr_str_release(kind);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return true;
  }
  size_t index;
  if (!scr_typed_ref_canonical_index(key->data, key->len, &index)) return false;
  ScrArr *arr = d->v.typed_ref.ptr;
  if (index > arr->len) return false;
  return ops->set(arr, (double)index, value);
}

void *scr_dyn_typed_ref_cached_cast(
    const ScrDyn *d, const char *type_key, size_t type_key_len) {
  for (ScrDynTypedCast *cast = d->v.typed_ref.casts; cast;
       cast = cast->next) {
    if (cast->type_key_len == type_key_len &&
        memcmp(cast->type_key, type_key, type_key_len) == 0) {
      return cast->retain(cast->ptr);
    }
  }
  return NULL;
}

void scr_dyn_typed_ref_cache_cast(
    ScrDyn *d, const char *type_key, size_t type_key_len, void *ptr,
    void *(*retain)(void *), void (*release)(void *), bool traced) {
  if (!ptr) return;
  ScrDynTypedCast *cast = malloc(sizeof *cast);
  if (!cast) scr_trap("scriptc: out of memory\n");
  cast->type_key = type_key;
  cast->type_key_len = type_key_len;
  cast->ptr = retain(ptr);
  cast->retain = retain;
  cast->release = release;
  cast->traced = traced;
  cast->next = d->v.typed_ref.casts;
  d->v.typed_ref.casts = cast;
}

bool scr_dyn_typed_array_is(const ScrDyn *d, int elem) {
  return d && d->kind == SCR_DYN_BYTES && !d->v.bytes->is_data_view && d->v.bytes->elem == (ScrBytesElem)elem;
}

static bool scr_native_iterator_over(const ScrDyn *value, unsigned kind);

/* Node util.types reads internal brands, never user properties or prototypes. */
bool scr_dyn_util_type_is(const ScrDyn *value, const ScrStr *probe) {
  if (!value) return false;

#define PROBE(name) (probe->len == sizeof(name) - 1 && memcmp(probe->data, name, sizeof(name) - 1) == 0)
  if (PROBE("isAnyArrayBuffer")) return scr_buffer_storage_is(value);
  if (PROBE("isArrayBuffer")) return scr_array_buffer_is(value);
  if (PROBE("isSharedArrayBuffer")) return scr_shared_array_buffer_is(value);
  if (PROBE("isArrayBufferView")) return value->kind == SCR_DYN_BYTES;
  if (PROBE("isDataView")) return value->kind == SCR_DYN_BYTES && value->v.bytes->is_data_view;
  if (PROBE("isTypedArray")) return value->kind == SCR_DYN_BYTES && !value->v.bytes->is_data_view;
  if (PROBE("isUint8Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_U8);
  if (PROBE("isUint8ClampedArray")) return scr_dyn_typed_array_is(value, SCR_BYTES_U8C);
  if (PROBE("isUint16Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_U16);
  if (PROBE("isUint32Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_U32);
  if (PROBE("isInt8Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_I8);
  if (PROBE("isInt16Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_I16);
  if (PROBE("isInt32Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_I32);
  if (PROBE("isFloat16Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_F16);
  if (PROBE("isFloat32Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_F32);
  if (PROBE("isFloat64Array")) return scr_dyn_typed_array_is(value, SCR_BYTES_F64);
  if (PROBE("isMap")) return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_MAP;
  if (PROBE("isSet")) return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_SET;
  if (PROBE("isWeakMap")) return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WEAK_MAP;
  if (PROBE("isWeakSet")) return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WEAK_SET;
  if (PROBE("isRegExp")) return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_REGEXP;
  if (PROBE("isPromise")) return value->kind == SCR_DYN_PROMISE;
  if (PROBE("isProxy")) return value->kind == SCR_DYN_PROXY;
  if (PROBE("isAsyncFunction")) return value->kind == SCR_DYN_FUNC && (scr_closure_identity(value->v.fn.clo)->function_kind & 2) != 0;
  if (PROBE("isGeneratorFunction")) return value->kind == SCR_DYN_FUNC && (scr_closure_identity(value->v.fn.clo)->function_kind & 1) != 0;
  if (PROBE("isGeneratorObject")) return scr_dyn_generator(value);
  if (PROBE("isDate")) return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_DATE;
  if (PROBE("isMapIterator")) return scr_native_iterator_over(value, 2);
  if (PROBE("isSetIterator")) return scr_native_iterator_over(value, 3);
  if (PROBE("isKeyObject")) return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_KEY_OBJECT;
  /* Boxed primitives, BigInt64Array, BigUint64Array, CryptoKey and external
   * values cannot be created here, so no value has these brands. */
  if (PROBE("isNumberObject") || PROBE("isStringObject") || PROBE("isBooleanObject") ||
      PROBE("isBigIntObject") || PROBE("isSymbolObject") || PROBE("isBoxedPrimitive") ||
      PROBE("isBigInt64Array") || PROBE("isBigUint64Array") || PROBE("isCryptoKey") || PROBE("isExternal"))
    return false;
  if (PROBE("isNativeError")) {
    ScrError *error = scr_errdyn_err_of(value);
    if (!error) return false;
    scr_error_release(error);
    return true;
  }
#undef PROBE
  return false;
}

/* Node's JavaScript wrappers have names/arity; engine-native probes are
 * anonymous with length zero. Keep their native closure identity intact. */
ScrDyn *scr_dyn_util_type_value(const ScrDyn *value, const ScrStr *probe) {
  static const char *const named[] = { "isDataView", "isTypedArray", "isUint8Array", "isUint8ClampedArray", "isUint16Array", "isUint32Array",
    "isInt8Array", "isInt16Array", "isInt32Array", "isFloat16Array", "isFloat32Array", "isFloat64Array" };
  const char *name = "";
  if (probe->len == 17 && memcmp(probe->data, "isArrayBufferView", 17) == 0) name = "isView";
  for (size_t i = 0; i < sizeof named / sizeof named[0]; i++)
    if (probe->len == strlen(named[i]) && memcmp(probe->data, named[i], probe->len) == 0) name = named[i];
  return scr_dyn_new_func(scr_closure_retain(value->v.fn.clo), value->v.fn.thunk, *name ? 1 : 0, value->v.fn.sig, name);
}

bool scr_dyn_bytes_is(const ScrDyn *d, int elem) {
  return d && d->kind == SCR_DYN_BYTES && d->v.bytes->elem == (ScrBytesElem)elem;
}

ScrBytes *scr_dyn_bytes_unbox(const ScrDyn *d) {
  return scr_bytes_retain(d->v.bytes);
}

/* Numeric typed-array constructor values share native function identity.
 * The cache owns one reference until runtime cleanup; arbitrary strings or
 * functions cannot impersonate one of these constructors. */
static SCR_TL ScrDyn *scr_bytes_ctors[SCR_BYTES_ELEM_COUNT];
static void scr_bytes_ctors_cleanup(void) {
  for (size_t i = 0; i < SCR_BYTES_ELEM_COUNT; i++) {
    scr_dyn_release(scr_bytes_ctors[i]);
    scr_bytes_ctors[i] = NULL;
  }
}
static ScrDyn *scr_bytes_ctor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args; (void)argc;
  for (size_t i = 0; i < SCR_BYTES_ELEM_COUNT; i++) {
    if (!scr_bytes_ctors[i] || scr_bytes_ctors[i]->v.fn.clo != closure) continue;
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "Constructor ");
    scr_jb_puts(&message, scr_bytes_elem_name((ScrBytesElem)i));
    scr_jb_puts(&message, " requires 'new'");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return NULL;
  }
  scr_trap("scriptc: invalid typed array constructor\n");
}
static ScrDyn *scr_dyn_fn_properties(const ScrDyn *function);
static ScrDyn *scr_bytes_constructor_for(ScrBytesElem elem) {
  if (!scr_bytes_ctors[elem]) {
    bool initialized = false;
    for (size_t i = 0; i < SCR_BYTES_ELEM_COUNT; i++) if (scr_bytes_ctors[i]) initialized = true;
    if (!initialized) scr_atexit(scr_bytes_ctors_cleanup);
    scr_bytes_ctors[elem] = scr_dyn_new_func(scr_closure_new(NULL, 0),
        scr_bytes_ctor_call, 3, "typed-array-constructor", scr_bytes_elem_name(elem));
    ScrDyn *properties = scr_dyn_fn_properties(scr_bytes_ctors[elem]);
    scr_dyn_obj_set(properties, "BYTES_PER_ELEMENT", 17, scr_dyn_new_num((double)scr_bytes_elem_size(elem)));
    ScrDynEntry *entry = &properties->v.obj.entries[properties->v.obj.len - 1];
    entry->writable = entry->enumerable = entry->configurable = false;
    scr_dyn_release(properties);
  }
  return scr_dyn_retain(scr_bytes_ctors[elem]);
}
ScrDyn *scr_bytes_constructor(const ScrStr *name) {
  for (size_t i = 0; i < SCR_BYTES_ELEM_COUNT; i++) {
    const char *candidate = scr_bytes_elem_name((ScrBytesElem)i);
    if (strlen(candidate) == name->len && memcmp(candidate, name->data, name->len) == 0)
      return scr_bytes_constructor_for((ScrBytesElem)i);
  }
  scr_trap("scriptc: invalid typed array constructor name\n");
}
static SCR_TL ScrDyn *scr_array_buffer_ctor;
static SCR_TL ScrDyn *scr_array_ctor;
static void scr_array_ctor_cleanup(void) {
  scr_dyn_release(scr_array_ctor);
  scr_array_ctor = NULL;
}
static ScrDyn *scr_array_ctor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *result = scr_dyn_new_arr();
  if (argc == 1 && args[0]->kind == SCR_DYN_NUM) {
    double length = args[0]->v.num;
    if (!isfinite(length) || length < 0 || length > 4294967295.0 || trunc(length) != length) {
      scr_dyn_release(result);
      static const char message[] = "Invalid array length";
      scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
      return NULL;
    }
    if (length > 1000000) {
      scr_dyn_release(result);
      static const char message[] = "Checked array construction exceeds the native allocation limit";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    for (size_t i = 0; i < (size_t)length; i++) scr_dyn_arr_push_hole(result);
  } else for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(result, scr_dyn_retain(args[i]));
  return result;
}
ScrDyn *scr_dyn_array_constructor(void) {
  if (!scr_array_ctor) {
    scr_array_ctor = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_array_ctor_call, 1, "native:Array", "Array");
    scr_atexit(scr_array_ctor_cleanup);
  }
  return scr_dyn_retain(scr_array_ctor);
}
static void scr_array_buffer_ctor_cleanup(void) {
  scr_dyn_release(scr_array_buffer_ctor);
  scr_array_buffer_ctor = NULL;
}
static ScrDyn *scr_array_buffer_ctor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  static const char message[] = "Constructor ArrayBuffer requires 'new'";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  return NULL;
}
ScrDyn *scr_array_buffer_constructor(void) {
  if (!scr_array_buffer_ctor) {
    scr_array_buffer_ctor = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_array_buffer_ctor_call, 1, "native:ArrayBuffer", "ArrayBuffer");
    scr_atexit(scr_array_buffer_ctor_cleanup);
  }
  return scr_dyn_retain(scr_array_buffer_ctor);
}

/* `value instanceof C` for C a global constructor held as a value
 * (`{ instanceOf: Date }`, scr_dyn_global_constructor): 1 or 0 by the
 * value's native kind, or -1 when callee is not one of them, or for Object.
 * A typed record or array is none of these kinds, and neither is an
 * instance of a program class: a class can extend Date (answered through
 * scr_dyn_date_instance_is), and extending RegExp, Map, Set, WeakMap,
 * WeakSet or Promise refuses where the class is defined. The error
 * constructors (scr_dyn_error_constructor) answer -1. */
static int scr_dyn_global_constructor_instanceof(const ScrDyn *value, const ScrDyn *callee) {
  if (!callee->v.fn.sig || !callee->v.fn.name || strcmp(callee->v.fn.sig, "native:constructor") != 0 ||
      strcmp(callee->v.fn.name, "Object") == 0)
    return -1;
  /* A native Date, or an instance of a class declared `extends Date`. */
  if (strcmp(callee->v.fn.name, "Date") == 0) return scr_dyn_date_instance_is(value);
  static const struct { const char *name; int tag; } kinds[] = {
    {"RegExp", SCR_DYNH_REGEXP}, {"Map", SCR_DYNH_MAP}, {"Set", SCR_DYNH_SET},
    {"WeakMap", SCR_DYNH_WEAK_MAP}, {"WeakSet", SCR_DYNH_WEAK_SET},
    {"FinalizationRegistry", SCR_DYNH_FINALIZATION_REGISTRY},
  };
  bool promise = strcmp(callee->v.fn.name, "Promise") == 0;
  int tag = -1;
  for (size_t i = 0; i < sizeof kinds / sizeof kinds[0]; i++)
    if (strcmp(callee->v.fn.name, kinds[i].name) == 0) tag = kinds[i].tag;
  if (value->kind == SCR_DYN_TYPED_REF) {
    if (strncmp(value->v.typed_ref.type_key, "record:", 7) == 0 || scr_dyn_ref_is_array(value)) return 0;
    return (promise || tag >= 0) && strncmp(value->v.typed_ref.type_key, "object:", 7) == 0 ? 0 : -1;
  }
  if (promise) return value->kind == SCR_DYN_PROMISE;
  if (tag >= 0) return value->kind == SCR_DYN_HANDLE && (int)value->v.handle.tag == tag;
  return -1;
}

/* `value instanceof callee` for an untyped constructor value. `refusal`, when
 * given, is the site's SC1090 message for a runtime constructor with no
 * instance test. */
/* A function whose own-property table defines Symbol.hasInstance
 * (`Object.defineProperty(F, Symbol.hasInstance, { value })`): 1 or 0 by the
 * truthiness of the method's answer with `this` bound to F, -1 when F
 * defines none, or 0 with the exception pending. Functions without a table
 * use the ordinary prototype test. */
int scr_dyn_has_instance_hook(const ScrDyn *value, const ScrDyn *callee) {
  if (!scr_has_instance_symbol || callee->kind != SCR_DYN_FUNC || !scr_closure_identity(callee->v.fn.clo)->props)
    return -1;
  ScrDyn *hook = scr_dyn_symbol_key_get(callee, scr_has_instance_symbol, true);
  if (scr_exc_pending()) {
    scr_dyn_release(hook);
    return 0;
  }
  if (!hook || hook->kind != SCR_DYN_FUNC) {
    scr_dyn_release(hook);
    return -1;
  }
  scr_dyn_this_push_dyn((ScrDyn *)callee);
  ScrDyn *argument = (ScrDyn *)value;
  ScrDyn *result = scr_dyn_call(hook, &argument, 1, "Symbol.hasInstance");
  scr_dyn_this_pop();
  scr_dyn_release(hook);
  if (!result) return 0;
  bool truthy = scr_dyn_truthy(result);
  scr_dyn_release(result);
  return truthy ? 1 : 0;
}

bool scr_bytes_instanceof_at(const ScrDyn *value, const ScrDyn *callee, const ScrStr *refusal) {
#ifdef SCR_NODE_ISLANDS
  if (scr_ni_is_handle(callee)) return scr_ni_instanceof((ScrDyn *)value, (ScrDyn *)callee) == 1;
#endif
  if (!callee || callee->kind != SCR_DYN_FUNC) {
    static const char message[] = "Right-hand side of 'instanceof' is not callable";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  int hooked = scr_dyn_has_instance_hook(value, callee);
  if (hooked >= 0) return hooked == 1;
  /* An error constructor held as a value (`inst instanceof params.Parent`
   * with Parent === Error): the error kind's interval, and for Error itself
   * objects inheriting Error.prototype. */
  for (size_t i = 0; i < SCR_ERROR_CTORS; i++) {
    if (!scr_error_ctor_values[i] || callee->v.fn.clo != scr_error_ctor_values[i]->v.fn.clo) continue;
    return scr_dyn_err_instanceof(value, (double)i) || (i == 0 && scr_dyn_inherits_error_prototype(value));
  }
  if (scr_array_buffer_ctor && callee->v.fn.clo == scr_array_buffer_ctor->v.fn.clo) return scr_array_buffer_is(value);
  if (scr_array_ctor && callee->v.fn.clo == scr_array_ctor->v.fn.clo) return value->kind == SCR_DYN_ARR || scr_dyn_ref_is_array(value);
  for (size_t i = 0; i < SCR_BYTES_ELEM_COUNT; i++) {
    if (scr_bytes_ctors[i] && callee->v.fn.clo == scr_bytes_ctors[i]->v.fn.clo)
      return scr_dyn_typed_array_is(value, (int)i);
  }
  int global = scr_dyn_global_constructor_instanceof(value, callee);
  if (global >= 0) return global;
  /* An ordinary constructor function (an untyped JavaScript function whose
   * prototype is an object): OrdinaryHasInstance walks the value's
   * prototype chain for callee.prototype. */
  {
    ScrStr *name = scr_str_new("prototype", 9);
    ScrDyn *key = scr_dyn_new_str(name);
    scr_str_release(name);
    ScrDyn *prototype = scr_dyn_reflect_get((ScrDyn *)callee, key, (ScrDyn *)callee);
    scr_dyn_release(key);
    if (!prototype) return false; /* the read threw: pending */
    if (prototype->kind == SCR_DYN_OBJ) {
      bool found = false;
      if (value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_FUNC) {
        ScrDyn *current = scr_dyn_get_prototype((ScrDyn *)value);
        while (current && current->kind != SCR_DYN_NULL) {
          if (current == prototype) {
            found = true;
            break;
          }
          ScrDyn *next = scr_dyn_get_prototype(current);
          scr_dyn_release(current);
          current = next;
        }
        if (current) scr_dyn_release(current);
      }
      scr_dyn_release(prototype);
      return found;
    }
    bool undefined_prototype = prototype->kind == SCR_DYN_UNDEF;
    scr_dyn_release(prototype);
    /* A function the program compiled with no prototype (an arrow function
     * or a method): false for a primitive, and Node's TypeError for every
     * object, typed arrays, native handles, promises and typed references
     * included. The runtime's own constructors carry "native:" signatures. */
    if (undefined_prototype && (!callee->v.fn.sig || strncmp(callee->v.fn.sig, "native:", 7) != 0)) {
      if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_BOOL ||
          value->kind == SCR_DYN_NUM || value->kind == SCR_DYN_STR || value->kind == SCR_DYN_BIGINT ||
          value->kind == SCR_DYN_SYMBOL)
        return false;
      static const char message[] = "Function has non-object prototype 'undefined' in instanceof check";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return false;
    }
  }
  if (refusal) {
    scr_throw_error_msg_code(SCR_ERR_ERROR, refusal->data, refusal->len, "SC1090");
    return false;
  }
  static const char message[] = "instanceof against this native constructor is not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC1090");
  return false;
}
bool scr_bytes_instanceof(const ScrDyn *value, const ScrDyn *callee) {
  return scr_bytes_instanceof_at(value, callee, NULL);
}
SCR_TL bool (*scr_dyn_global_construct_fn)(const ScrDyn *callee, const ScrDyn *args, ScrDyn **result) = NULL;

ScrDyn *scr_bytes_construct(const ScrDyn *callee, const ScrDyn *args, const ScrStr *what) {
  if (callee->kind == SCR_DYN_FUNC && scr_array_ctor && callee->v.fn.clo == scr_array_ctor->v.fn.clo)
    return scr_array_ctor_call(callee->v.fn.clo, args->v.arr.items, args->v.arr.len);
  if (callee->kind == SCR_DYN_FUNC && scr_array_buffer_ctor && callee->v.fn.clo == scr_array_buffer_ctor->v.fn.clo)
    return scr_array_buffer_new(args->v.arr.len ? args->v.arr.items[0] : scr_dyn_undefined());
  for (size_t i = 0; i < SCR_BYTES_ELEM_COUNT; i++) {
    if (callee->kind != SCR_DYN_FUNC || !scr_bytes_ctors[i] || callee->v.fn.clo != scr_bytes_ctors[i]->v.fn.clo) continue;
    const ScrDyn *input = args->v.arr.len > 0 ? args->v.arr.items[0] : scr_dyn_undefined();
    const ScrDyn *offset = args->v.arr.len > 1 ? args->v.arr.items[1] : scr_dyn_undefined();
    const ScrDyn *length = args->v.arr.len > 2 ? args->v.arr.items[2] : scr_dyn_undefined();
    ScrBytes *bytes = scr_array_buffer_view((ScrBytesElem)i, input, offset, length);
    if (!bytes) return NULL;
    ScrDyn *result = scr_dyn_new_bytes(bytes);
    scr_bytes_release(bytes);
    return result;
  }
  ScrDyn *constructed = NULL;
  if (scr_dyn_global_construct_fn && scr_dyn_global_construct_fn(callee, args, &constructed))
    return constructed;
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_write(&message, what->data, what->len);
  scr_jb_puts(&message, " is not a supported native constructor");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

/* Shared view metadata and indexed reads for both compiler backends. */
ScrDyn *scr_dyn_bytes_key_get(const ScrDyn *value, const ScrStr *key) {
  ScrBytes *bytes = value->v.bytes;
  if (key->len == 10 && memcmp(key->data, "byteLength", 10) == 0) return scr_dyn_new_num(scr_bytes_byte_len(bytes));
  if (key->len == 10 && memcmp(key->data, "byteOffset", 10) == 0) return scr_dyn_new_num(scr_bytes_byte_offset(bytes));
  if (key->len == 6 && memcmp(key->data, "buffer", 6) == 0) return scr_array_buffer_from_bytes(bytes);
  if (bytes->is_data_view) {
    /* A DataView has no length or indexed elements. */
    if (key->len == 11 && memcmp(key->data, "constructor", 11) == 0) {
      static const char message[] = "DataView's constructor through unknown is not supported yet";
      scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
      return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (key->len == 6 && memcmp(key->data, "length", 6) == 0) return scr_dyn_new_num(scr_bytes_len(bytes));
  /* Each typed array kind's prototype carries its element size. */
  if (key->len == 17 && memcmp(key->data, "BYTES_PER_ELEMENT", 17) == 0)
    return scr_dyn_new_num((double)scr_bytes_elem_size(bytes->elem));
  if (key->len == 11 && memcmp(key->data, "constructor", 11) == 0) {
    if (!value->buffer) return scr_bytes_constructor_for(bytes->elem);
    /* Buffer retains its separate builtin identity. */
    char token[64];
    int length = snprintf(token, sizeof token, "[builtin %s]", value->buffer ? "Buffer" : scr_bytes_elem_name(bytes->elem));
    ScrStr *name = scr_str_new(token, (size_t)length);
    ScrDyn *result = scr_dyn_new_str(name);
    scr_str_release(name);
    return result;
  }
  if (key->len && !(key->len > 1 && key->data[0] == '0')) {
    size_t index = 0;
    bool digits = true;
    for (size_t i = 0; i < key->len; i++) {
      if (key->data[i] < '0' || key->data[i] > '9' || index > (SIZE_MAX - 9) / 10) { digits = false; break; }
      index = index * 10 + (size_t)(key->data[i] - '0');
    }
    if (digits && index < bytes->len) return scr_dyn_new_num(scr_bytes_get(bytes, (double)index));
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

/* ── the data-chunk encoding window (setEncoding) ─────────────────────
 * Node's readable setEncoding turns 'data' payloads into strings. The
 * delivery ABI carries bytes; the FIRING site (which owns the handle and
 * its encoding flag) opens a window around the listener pass and the
 * boxing helpers below answer string-flavored chunks inside it — the
 * ambient-receiver pattern, one flag instead of a threaded parameter.
 * Per-chunk utf8 decode: a multibyte character split across chunks does
 * not re-join (Node's StringDecoder holds the partial byte); ASCII-clean
 * bodies — the overwhelming test shape — are exact. */
static SCR_TL bool scr_dyn_chunk_utf8;
void scr_dyn_chunk_enc(bool utf8) { scr_dyn_chunk_utf8 = utf8; }

/* One 'data' payload as the dyn value the current window dictates:
 * a Buffer-flavored bytes box, or a string inside a setEncoding window. */
ScrDyn *scr_dyn_new_chunk(const ScrBytes *b) {
  if (scr_dyn_chunk_utf8) {
    ScrStr *s = scr_bytes_string(b, 0, b->len);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  return scr_dyn_new_buffer(b);
}

/* A boxed static function value (the compiler's static→dyn converters).
 * Ownership of the closure MOVES in; sig/name are static literals. */
ScrDyn *scr_dyn_new_func(ScrClosure *clo, ScrDynThunk thunk, uint32_t arity, const char *sig, const char *name) {
  if (clo->function_kind & 8) {
    ScrDyn *original = scr_box_get_ref(clo->caps[0]);
    scr_closure_release(clo);
    return original;
  }
  ScrDyn *d = scr_dyn_alloc(SCR_DYN_FUNC);
  d->v.fn.clo = clo;
  d->v.fn.thunk = thunk;
  d->v.fn.sig = sig;
  d->v.fn.name = name;
  /* A signature adapter reports the length of the function it adapts. */
  d->v.fn.arity = clo->identity != NULL ? clo->identity_length : arity;
  d->v.fn.class_obj = NULL;
  d->v.fn.message = NULL;
  return d;
}

void scr_dyn_func_set_message(ScrDyn *fn, ScrDynThunk thunk, ScrDynMessageListener listener) {
  /* scr_dyn_new_func answers an adapted function's original box, whose
   * closure has other parameter types. */
  if (fn && fn->kind == SCR_DYN_FUNC && fn->v.fn.thunk == thunk) fn->v.fn.message = listener;
}

/* A class is function-shaped for typeof and identity, but calling it without
 * new always throws. The closure owns the class object and its lexical boxes. */
static ScrDyn *scr_dyn_class_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrClassObj *cls = scr_box_get_ref(closure->caps[0]);
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "Class constructor ");
  scr_jb_write(&message, cls->name->data, cls->name->len);
  scr_jb_puts(&message, " cannot be invoked without 'new'");
  scr_classobj_release(cls);
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

ScrDyn *scr_dyn_new_class(ScrClassObj *cls, const char *type_key) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  if (cls->static_data) closure->props = scr_box_retain(cls->static_data);
  closure->caps[0] = scr_box_new_obj(scr_classobj_retain_v, scr_classobj_release_v, scr_classobj_trace_v);
  scr_box_set_ref(closure->caps[0], scr_classobj_retain(cls));
  ScrDyn *value = scr_dyn_new_func(closure, scr_dyn_class_call, (uint32_t)cls->length, type_key, cls->name->data);
  value->v.fn.class_obj = cls; /* borrowed from the closure */
  return value;
}

bool scr_dyn_class_is(const ScrDyn *value, const char *type_key) {
  return value && value->kind == SCR_DYN_FUNC && value->v.fn.class_obj &&
      strcmp(value->v.fn.sig, type_key) == 0;
}

bool scr_dyn_class_is_key(const ScrDyn *value, const ScrStr *type_key) {
  return scr_dyn_class_is(value, type_key->data);
}

ScrClassObj *scr_dyn_class_check(const ScrDyn *value, const char *type_key, const ScrDynPath *path) {
  if (!scr_dyn_class_is(value, type_key)) {
    scr_dyn_check_fail(path, "class constructor", value);
    return NULL;
  }
  return scr_classobj_retain(value->v.fn.class_obj);
}

/* The compiler exposes this data view only for named data accesses and
 * guarded writes. Compiled method reflection remains an explicit fence. */
ScrDyn *scr_dyn_class_prototype(ScrDyn *value, ScrDyn *base) {
  if (value->kind != SCR_DYN_FUNC || !value->v.fn.class_obj) {
    static const char message[] = "Native class prototype requires a class constructor";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrClassObj *cls = value->v.fn.class_obj;
  if (!cls->prototype_data) {
    ScrDyn *data = base->kind == SCR_DYN_UNDEF ? scr_dyn_new_obj() : scr_dyn_obj_create(base);
    if (!data) return NULL;
    /* util.inspect prints an instance with its class's name: the class
     * object's interned name, which is immortal. The prototype is owned by
     * the class object and no registry keeps it alive, so evaluating a
     * function-local class again releases the previous one's prototype. */
    if (cls->name && cls->name->len) data->v.obj.class_name = cls->name->data;
    /* Like every class prototype, it starts with its own non-enumerable
     * `constructor`: the class value. The cycle it closes through the class
     * object is one the collector traces. */
    scr_dyn_obj_set(data, "constructor", 11, scr_dyn_retain(value));
    data->v.obj.entries[data->v.obj.len - 1].enumerable = false;
    cls->prototype_data = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(cls->prototype_data, data);
  }
  return scr_box_get_ref(cls->prototype_data);
}

/* Calling a dyn value: kind check (Node's "<what> is not a function"
 * TypeError, catchable), then the boxed thunk — per-argument validation
 * into the closure's declared parameter types lives THERE (the thunk is
 * compiled per signature). Args borrowed; result owned (+1) or NULL with
 * the exception pending. */
ScrDyn *scr_dyn_call(const ScrDyn *d, ScrDyn *const *args, size_t argc, const char *what) {
#ifdef SCR_NODE_ISLANDS
  /* An island function: called in Node with the ambient receiver. */
  if (scr_ni_is_handle(d) && scr_ni_is_function(d)) {
    ScrDyn *receiver = scr_dyn_this_get();
    ScrDyn *result = scr_ni_call((ScrDyn *)d, receiver, args, argc);
    scr_dyn_release(receiver);
    return result;
  }
#endif
  if (d->kind == SCR_DYN_PROXY && scr_dyn_is_callable(d->v.proxy.target)) {
    ScrDyn *trap = scr_dyn_proxy_trap(d, "apply");
    if (scr_exc_pending()) return NULL;
    if (!trap) return scr_dyn_call(d->v.proxy.target, args, argc, what);
    ScrDyn *receiver = scr_dyn_this_get();
    ScrDyn *arguments = scr_dyn_new_arr();
    for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(arguments, scr_dyn_retain(args[i]));
    ScrDyn *trap_args[] = { d->v.proxy.target, receiver, arguments };
    ScrDyn *result = scr_dyn_proxy_call(d, trap, trap_args, 3);
    scr_dyn_release(arguments);
    scr_dyn_release(receiver);
    return result;
  }

  if (d->kind != SCR_DYN_FUNC) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, what);
    scr_jb_puts(&b, " is not a function");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return NULL;
  }
  return d->v.fn.thunk(d->v.fn.clo, args, argc);
}

/* scr_dyn_call over a dyn ARRAY's elements — the spread-application form
 * (`f(...args)` after the emitted argument array is built). Borrows both;
 * result owned (+1), or NULL with the exception pending. */
ScrDyn *scr_dyn_apply(const ScrDyn *d, const ScrDyn *args, const char *what) {
  return scr_dyn_call(d, args->v.arr.items, args->v.arr.len, what);
}

static ScrDyn *scr_dyn_bound_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *target = scr_box_get_ref(closure->caps[0]);
  ScrDyn *receiver = scr_box_get_ref(closure->caps[1]);
  ScrDyn *bound = scr_box_get_ref(closure->caps[2]);
  ScrDyn *all = scr_dyn_new_arr();
  for (size_t i = 0; i < bound->v.arr.len; i++) scr_dyn_arr_push(all, scr_dyn_retain(bound->v.arr.items[i]));
  for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(all, scr_dyn_retain(args[i]));
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_apply(target, all, "bound function");
  scr_dyn_this_pop();
  scr_dyn_release(all);
  scr_dyn_release(bound);
  scr_dyn_release(receiver);
  scr_dyn_release(target);
  return result;
}

ScrDyn *scr_dyn_bind(ScrDyn *target, ScrDyn *const *args, size_t argc) {
  ScrDyn *bound = scr_dyn_new_arr();
  for (size_t i = 1; i < argc; i++) scr_dyn_arr_push(bound, scr_dyn_retain(args[i]));
  ScrStr *prefix = scr_str_new("bound ", 6);
  const char *original = target->v.fn.name ? target->v.fn.name : "";
  ScrStr *suffix = scr_str_new(original, strlen(original));
  ScrStr *name = scr_str_concat(prefix, suffix);
  scr_str_release(prefix);
  scr_str_release(suffix);
  ScrClosure *closure = scr_closure_new(NULL, 4);
  closure->function_kind = scr_closure_identity(target->v.fn.clo)->function_kind & 3;
  for (size_t i = 0; i < 3; i++) closure->caps[i] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  closure->caps[3] = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(closure->caps[0], scr_dyn_retain(target));
  scr_box_set_ref(closure->caps[1], scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()));
  scr_box_set_ref(closure->caps[2], bound);
  scr_box_set_ref(closure->caps[3], name);
  size_t bound_count = argc ? argc - 1 : 0;
  uint32_t arity = bound_count < target->v.fn.arity ? target->v.fn.arity - (uint32_t)bound_count : 0;
  return scr_dyn_new_func(closure, &scr_dyn_bound_call, arity, "%bound", name->data);
}

/* ── native handles in the checked-dynamic tree (SCR_DYN_HANDLE) ───────────────────────
 * Per-tag ops stamped by the owning units at main() (scr_http_dyn_install
 * / scr_net_dyn_install — the scr_net_install hook story), so this
 * always-linked core never references gated units. A missing tag at use
 * is an internal error: emitted programs install a unit's ops whenever
 * they can box its handles. */
static SCR_TL const ScrDynHandleOps *scr_dynh_ops[SCR_DYNH_CAPACITY];

/* BroadcastChannel's EventTarget table (scr_et_broadcast_install). */
SCR_TL const ScrEtBroadcastOps *scr_et_broadcast_ops = NULL;

void scr_dyn_handle_install(ScrDynHandleTag tag, const ScrDynHandleOps *ops) {
  scr_dynh_ops[tag] = ops;
}

static const ScrDynHandleOps *scr_dyn_handle_ops(ScrDynHandleTag tag) {
  const ScrDynHandleOps *ops = scr_dynh_ops[tag];
  if (!ops) {
    scr_trap("scriptc: internal error: dyn handle ops not installed\n");
  }
  return ops;
}

/* The class display name for error texts ("IncomingMessage"); safe on
 * uninstalled tags (error paths render before anyone dispatches). */
const char *scr_dyn_handle_cls(const ScrDyn *d) {
  const ScrDynHandleOps *ops = scr_dynh_ops[d->v.handle.tag];
  return ops ? ops->cls : "object";
}

const ScrDynHandleOps *scr_dyn_handle_ops_of(const ScrDyn *d) {
  return scr_dyn_handle_ops(d->v.handle.tag);
}

/* errors.js's determineSpecificType over a dyn value — the "Received
 * ..." tail of Node's ERR_INVALID_ARG_TYPE messages. Renders into buf
 * when the shape needs a payload; returns the text either way. Lives
 * beside the dyn core (not the gated handle unit) because the always-
 * linked argument validators (bytes, fs) render through it too. */
const char *scr_dyn_specific_type(const ScrDyn *cb, char *detail, size_t cap) {
  const char *d = detail;
  switch (cb->kind) {
  case SCR_DYN_NULL: d = "null"; break;
  case SCR_DYN_UNDEF: d = "undefined"; break;
  case SCR_DYN_OBJ:
    if (cb->null_proto) {
      /* No constructor name: Node renders inspect(value, { depth: -1 }). */
      bool keys = false;
      for (size_t i = 0; i < cb->v.obj.len && !keys; i++) keys = cb->v.obj.entries[i].enumerable;
      d = keys ? "[Object: null prototype]" : "[Object: null prototype] {}";
    } else {
      d = "an instance of Object";
    }
    break;
  case SCR_DYN_ARR: d = "an instance of Array"; break;
  case SCR_DYN_BYTES:
    snprintf(detail, cap, "an instance of %s", cb->buffer ? "Buffer" : cb->v.bytes->is_data_view ? "DataView" : scr_bytes_elem_name(cb->v.bytes->elem));
    break;
  case SCR_DYN_FUNC:
    /* determineSpecificType: `function ${value.name}` — anonymous
     * functions keep Node's trailing space. */
    snprintf(detail, cap, "function %s", cb->v.fn.name != NULL ? cb->v.fn.name : "");
    break;
  case SCR_DYN_HANDLE:
    snprintf(detail, cap, "an instance of %s", scr_dyn_handle_cls(cb));
    break;
  case SCR_DYN_PROMISE: d = "an instance of Promise"; break;

  case SCR_DYN_TYPED_REF: {
    /* A class instance's view has no prototype; Node names its class. */
    const ScrStr *class_name = scr_dyn_typed_ref_class_name(cb);
    if (class_name && class_name->len) {
      snprintf(detail, cap, "an instance of %.*s", (int)class_name->len, class_name->data);
      break;
    }
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(cb);
    const char *specific = scr_dyn_specific_type(materialized, detail, cap);
    if (specific != detail) snprintf(detail, cap, "%s", specific);
    scr_dyn_release(materialized);
    d = detail;
    break;
  }
  case SCR_DYN_BOOL:
    snprintf(detail, cap, "type boolean (%s)", cb->v.b ? "true" : "false");
    break;
  case SCR_DYN_BIGINT: {
    ScrStr *value = scr_bigint_inspect(cb->v.bigint);
    snprintf(detail, cap, "type bigint (%.*s)", (int)value->len, value->data);
    scr_str_release(value);
    break;
  }
  case SCR_DYN_SYMBOL: {
    ScrStr *value = cb->v.symbol.render(cb->v.symbol.value);
    snprintf(detail, cap, "type symbol (%.*s)", (int)value->len, value->data);
    scr_str_release(value);
    break;
  }
  case SCR_DYN_NUM: {
    char num[32];
    size_t n;
    if (cb->v.num == 0 && signbit(cb->v.num)) { memcpy(num, "-0", 3); n = 2; }
    else n = scr_f64_to_str(cb->v.num, num);
    snprintf(detail, cap, "type number (%.*s)", (int)n, num);
    break;
  }
  case SCR_DYN_STR: {
    ScrStr *value = scr_str_retain(cb->v.str);
    if (scr_str_utf16_len(value) > 28) {
      ScrStr *prefix = scr_str_slice(value, 0, 25);
      ScrStr *dots = scr_str_new("...", 3);
      scr_str_release(value);
      value = scr_str_concat(prefix, dots);
      scr_str_release(prefix);
      scr_str_release(dots);
    }
    ScrJsonBuf shown;
    scr_jb_init(&shown);
    scr_jb_puts(&shown, "type string (");
    if (memchr(value->data, '\'', value->len)) {
      scr_jb_put_json_str(&shown, value);
    } else {
      scr_jb_putc(&shown, '\'');
      scr_jb_put_str(&shown, value);
      scr_jb_putc(&shown, '\'');
    }
    scr_jb_putc(&shown, ')');
    ScrStr *text = scr_jb_finish(&shown);
    snprintf(detail, cap, "%.*s", (int)text->len, text->data);
    scr_str_release(text);
    scr_str_release(value);
    break;
  }
  default: d = "an instance of Object"; break;
  }
  return d;
}

/* Node's ERR_INVALID_ARG_TYPE thrower ("The \"chunk\" argument must be
 * of type string or an instance of Buffer or Uint8Array. Received type
 * number (5)") — the handle dispatchers' and argument validators'
 * per-arg gates. `expected` is the full "of type ..."/"an instance of
 * ..." clause. */
/* The compiler-resolved ERR_INVALID_ARG_TYPE throw with a RUNTIME-
 * rendered Received tail (error.argTypeThrow — the always-throwing
 * lowered arms whose offending value is not a literal). Borrows all
 * three; always throws catchably. */
void scr_throw_arg_type(const ScrStr *argname, const ScrStr *expected, const ScrDyn *got) {
  scr_dyn_arg_type_fail(argname->data, expected->data, got);
}

void scr_dyn_arg_type_fail(const char *argname, const char *expected, const ScrDyn *got) {
  char detail[256];
  const char *d = scr_dyn_specific_type(got, detail, sizeof detail);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The \"");
  scr_jb_puts(&b, argname);
  /* Node names a dotted name (options.mode) a property. */
  scr_jb_puts(&b, strchr(argname, '.') ? "\" property must be " : "\" argument must be ");
  scr_jb_puts(&b, expected);
  scr_jb_puts(&b, ". Received ");
  scr_jb_puts(&b, d);
  ScrStr *msg = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len,
                           "ERR_INVALID_ARG_TYPE");
  scr_str_release(msg);
}

/* The property flavor of the same ladder — Node renders option-bag
 * members as "The \"options.x\" property must be ..." (errors.js keys the
 * wording on the name, but every property-path caller here knows it is
 * one). Same runtime-rendered Received tail; always throws catchably. */
void scr_dyn_prop_type_fail(const char *name, const char *expected, const ScrDyn *got) {
  char detail[256];
  const char *d = scr_dyn_specific_type(got, detail, sizeof detail);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The \"");
  scr_jb_puts(&b, name);
  scr_jb_puts(&b, "\" property must be ");
  scr_jb_puts(&b, expected);
  scr_jb_puts(&b, ". Received ");
  scr_jb_puts(&b, d);
  ScrStr *msg = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len,
                           "ERR_INVALID_ARG_TYPE");
  scr_str_release(msg);
}

/* The compiler-resolved property-typed throw (error.propTypeThrow —
 * argTypeThrow's option-bag sibling). Borrows all three; always throws. */
void scr_throw_prop_type(const ScrStr *name, const ScrStr *expected, const ScrDyn *got) {
  scr_dyn_prop_type_fail(name->data, expected->data, got);
}

/* ERR_INVALID_ARG_VALUE's "Received" tail — util.inspect where ARG_TYPE
 * renders determineSpecificType: strings quote, scalars print plain.
 * Deep shapes render their bracket sketch (enough for the validators'
 * ladders; nothing observable pins the deep forms). */
const char *scr_dyn_inspect_lite(const ScrDyn *v, char *buf, size_t cap) {
  switch (v->kind) {
  case SCR_DYN_NULL: return "null";
  case SCR_DYN_UNDEF: return "undefined";
  case SCR_DYN_BOOL: return v->v.b ? "true" : "false";
  case SCR_DYN_NUM: {
    scr_f64_to_str(v->v.num, buf);
    return buf;
  }
  case SCR_DYN_STR: {
    const ScrStr *s = v->v.str;
    size_t n = 0;
    buf[n++] = '\'';
    for (size_t i = 0; i < s->len && n + 5 < cap; i++) buf[n++] = s->data[i];
    if (s->len + 2 + 5 > cap) {
      memcpy(buf + n, "...", 3);
      n += 3;
    }
    buf[n++] = '\'';
    buf[n] = 0;
    return buf;
  }
  case SCR_DYN_ARR: return "[ ... ]";
  case SCR_DYN_OBJ: return "{ ... }";
  case SCR_DYN_BYTES: return "<Buffer ...>";
  default: return "[object]";
  }
}

/* util.inspect's string rendering (inspect.js strEscape): single quotes
 * unless the string contains one, then double quotes or backticks when the
 * string has none of those; C0 controls, the active quote, backslashes,
 * U+007F-U+009F, and unpaired surrogates are escaped. The ERR_INVALID_ARG_*
 * messages print it truncated to 128 UTF-16 units plus "...". Lives in the
 * dyn core so validators in optional units can render without the inspect
 * unit. */
ScrStr *scr_str_inspect_quoted(const ScrStr *s, bool truncate) {
  static const char *const c0[32] = {
    "\\x00", "\\x01", "\\x02", "\\x03", "\\x04", "\\x05", "\\x06", "\\x07",
    "\\b",   "\\t",   "\\n",   "\\x0B", "\\f",   "\\r",   "\\x0E", "\\x0F",
    "\\x10", "\\x11", "\\x12", "\\x13", "\\x14", "\\x15", "\\x16", "\\x17",
    "\\x18", "\\x19", "\\x1A", "\\x1B", "\\x1C", "\\x1D", "\\x1E", "\\x1F",
  };
  const unsigned char *p = (const unsigned char *)s->data;
  size_t n = s->len;
  char quote = '\'';
  if (memchr(p, '\'', n) != NULL) {
    bool brace = false;
    for (size_t i = 0; i + 1 < n && !brace; i++) brace = p[i] == '$' && p[i + 1] == '{';
    if (memchr(p, '"', n) == NULL) quote = '"';
    else if (memchr(p, '`', n) == NULL && !brace) quote = '`';
  }
  ScrJsonBuf out;
  scr_jb_init(&out);
  scr_jb_putc(&out, quote);
  for (size_t i = 0; i < n;) {
    unsigned char c = p[i];
    char hex[8];
    if (c < 0x20) {
      scr_jb_puts(&out, c0[c]);
      i++;
    } else if (c == '\\') {
      scr_jb_puts(&out, "\\\\");
      i++;
    } else if (c == '\'' && quote == '\'') {
      scr_jb_puts(&out, "\\'");
      i++;
    } else if (c == 0x7f) {
      scr_jb_puts(&out, "\\x7F");
      i++;
    } else if (c == 0xc2 && i + 1 < n && p[i + 1] >= 0x80 && p[i + 1] <= 0x9f) {
      snprintf(hex, sizeof hex, "\\x%02X", p[i + 1]);
      scr_jb_puts(&out, hex);
      i += 2;
    } else if (c == 0xed && i + 2 < n && p[i + 1] >= 0xa0 && p[i + 1] <= 0xbf) {
      /* a WTF-8 surrogate code unit: paired surrogates arrive as one
       * four-byte sequence, so this one is unpaired */
      unsigned unit = 0xd000u | ((unsigned)(p[i + 1] & 0x3f) << 6) | (p[i + 2] & 0x3f);
      snprintf(hex, sizeof hex, "\\u%04x", unit);
      scr_jb_puts(&out, hex);
      i += 3;
    } else {
      scr_jb_putc(&out, (char)c);
      i++;
    }
  }
  scr_jb_putc(&out, quote);
  ScrStr *text = scr_jb_finish(&out);
  if (truncate && scr_str_utf16_len(text) > 128) {
    ScrStr *head = scr_str_slice(text, 0, 128);
    ScrStr *dots = scr_str_new("...", 3);
    scr_str_release(text);
    text = scr_str_concat(head, dots);
    scr_str_release(head);
    scr_str_release(dots);
  }
  return text;
}

/* Node's ERR_INVALID_ARG_VALUE thrower: "The <argument|property> '<name>'
 * <reason>. Received <inspected>" — the argument/property choice follows
 * errors.js (a dotted name is a property path). `reason` defaults to
 * "is invalid" when NULL. TypeError, like Node's default. */
void scr_dyn_arg_value_fail(const char *name, const char *reason, const ScrDyn *got) {
  char insp[64];
  const char *d = scr_dyn_inspect_lite(got, insp, sizeof insp);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The ");
  scr_jb_puts(&b, strchr(name, '.') != NULL ? "property '" : "argument '");
  scr_jb_puts(&b, name);
  scr_jb_puts(&b, "' ");
  scr_jb_puts(&b, reason != NULL ? reason : "is invalid");
  scr_jb_puts(&b, ". Received ");
  scr_jb_puts(&b, d);
  ScrStr *msg = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len,
                           "ERR_INVALID_ARG_VALUE");
  scr_str_release(msg);
}

/* The deferred JS lowering fence, thrown from a ladder's post-validation
 * tail: the compiler renders the message (the statement fence's own text,
 * "[SC2020 at file:line]" included) and the ladder throws it verbatim
 * AFTER its Node-order validations pass — Node's validation errors come
 * first, the honest refuse second. Borrowed; always throws catchably. */
void scr_throw_lowering_fence(const ScrStr *msg) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg->data, msg->len, "SC2020");
}

static void scr_dyn_handle_release(void *h, ScrDynHandleTag tag) {
  scr_dyn_handle_ops(tag)->release(h);
}

ScrDyn *scr_dyn_new_handle(void *h, ScrDynHandleTag tag) {
  ScrDyn *d = scr_dyn_alloc(SCR_DYN_HANDLE);
  d->v.handle.ptr = scr_dyn_handle_ops(tag)->retain(h);
  d->v.handle.tag = tag;
  d->v.handle.traced = tag == SCR_DYNH_WEAK_MAP || tag == SCR_DYNH_WEAK_SET ||
      tag == SCR_DYNH_WORKER || tag == SCR_DYNH_MESSAGE_PORT || tag == SCR_DYNH_DISPOSABLE_STACK ||
      tag == SCR_DYNH_CIPHER || tag == SCR_DYNH_DECIPHER ||
      ((tag == SCR_DYNH_SET || tag == SCR_DYNH_MAP) &&
       ((ScrMap *)h)->traced != 0);
  return d;
}

/* The gated promise boxes (scr_async_dyn.c) build through this thin
 * allocator view; the freelist stays private, and the release arm's
 * scr_promise_release edge installs HERE — a promise-free link never
 * references the fiber machinery (the unit-test subset links). */
SCR_TL void (*scr_dyn_promise_release_fn)(ScrPromise *p) = NULL;
SCR_TL bool (*scr_dyn_promise_identity_fn)(ScrPromise *a, ScrPromise *b) = NULL;

ScrDyn *scr_dyn_alloc_promise(void (*release_fn)(ScrPromise *p)) {
  scr_dyn_promise_release_fn = release_fn;
  return scr_dyn_alloc(SCR_DYN_PROMISE);
}

bool scr_dyn_ref_typeof_is(const ScrDyn *d, const char *name) {
  if (scr_dyn_generator(d)) return strcmp(name, "object") == 0;
  if (d->kind == SCR_DYN_TYPED_REF) {
    /* Bound records and arrays always view as an ordinary object/array. */
    if ((d->v.typed_ref.type_key_len >= 7 &&
         memcmp(d->v.typed_ref.type_key, "object:", 7) == 0) ||
        scr_typed_ref_record_ops(d) || scr_dyn_typed_ref_array_ops(d))
      return strcmp(name, "object") == 0;
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
    bool out;
    {
      bool object =
          materialized->kind == SCR_DYN_NULL ||
          materialized->kind == SCR_DYN_OBJ ||
          materialized->kind == SCR_DYN_ARR ||
          materialized->kind == SCR_DYN_BYTES ||
          materialized->kind == SCR_DYN_HANDLE ||
          materialized->kind == SCR_DYN_PROMISE;
      out = (strcmp(name, "object") == 0 && object) ||
            (strcmp(name, "function") == 0 &&
             materialized->kind == SCR_DYN_FUNC);
    }
    scr_dyn_release(materialized);
    return out;
  }
  return false;
}

bool scr_dyn_ref_is_array(const ScrDyn *d) {
  if (scr_dyn_generator(d)) return false;
  if (d->kind == SCR_DYN_TYPED_REF) {
    if (d->v.typed_ref.type_key_len >= 7 &&
        memcmp(d->v.typed_ref.type_key, "object:", 7) == 0) return false;
    if (scr_typed_ref_record_ops(d)) return false;
    if (scr_dyn_typed_ref_array_ops(d)) return true;
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
    if (!materialized) return false;
    bool out = materialized->kind == SCR_DYN_ARR ||
               scr_dyn_ref_is_array(materialized);
    scr_dyn_release(materialized);
    return out;
  }
  return false;
}

bool scr_dyn_ref_is_error(const ScrDyn *d) {
  if (scr_dyn_generator(d)) return false;
  /* Registered native Error capsules retain their brand even when their
   * public property view omits the internal error marker. */
  ScrError *error = scr_errdyn_err_of(d);
  if (error) {
    scr_error_release(error);
    return true;
  }
  if (d->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
    bool out =
        (materialized->kind == SCR_DYN_OBJ &&
         scr_dyn_obj_get(materialized, "%error", 6) != NULL) ||
        scr_dyn_ref_is_error(materialized);
    scr_dyn_release(materialized);
    return out;
  }
  return false;
}

bool scr_dyn_is_nullish(const ScrDyn *d) {
  if (d->kind == SCR_DYN_UNDEF || d->kind == SCR_DYN_NULL) return true;


  return false;
}

void *scr_dyn_handle_unbox(const ScrDyn *d, ScrDynHandleTag tag, const ScrDynPath *path, const char *want) {
  if (d->kind != SCR_DYN_HANDLE || d->v.handle.tag != tag) {
    scr_dyn_check_fail(path, want, d);
    return NULL;
  }
  return scr_dyn_handle_ops(tag)->retain(d->v.handle.ptr);
}

SCR_TL ScrDyn *(*scr_dyn_promise_member_fn)(const char *key, size_t len) = NULL;

ScrDyn *scr_dyn_promise_key_get(const ScrDyn *d, const ScrStr *k) {
  (void)d;
  ScrDyn *method = scr_dyn_promise_member_fn ? scr_dyn_promise_member_fn(k->data, k->len) : NULL;
  return method ? method : scr_dyn_retain(scr_dyn_undefined());
}

/* ── handle methods as values (ScrDynHandleMethod) ──────────────────
 * One function per (tag, method), as Node's prototype methods are shared
 * by every instance. The function calls invoke on its `this` when that is
 * a handle of its tag, and otherwise raises the class's ERR_INVALID_THIS
 * TypeError (or answers a promise rejected with it), as the WebIDL brand
 * checks do. closure->fn holds the method entry, caps[0] the tag. */
static SCR_TL ScrDyn **scr_dynh_method_values[SCR_DYNH_CAPACITY];
static SCR_TL bool scr_dynh_method_values_registered;

static void scr_dynh_method_values_cleanup(void) {
  for (size_t tag = 0; tag < SCR_DYNH_CAPACITY; tag++) {
    ScrDyn **values = scr_dynh_method_values[tag];
    if (!values) continue;
    scr_dynh_method_values[tag] = NULL;
    const ScrDynHandleMethod *methods = scr_dynh_ops[tag]->methods;
    for (size_t i = 0; methods[i].name; i++)
      if (values[i]) scr_dyn_release(values[i]);
    free(values);
  }
}

static ScrDyn *scr_dynh_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  const ScrDynHandleMethod *method = closure->fn;
  ScrDynHandleTag tag = (ScrDynHandleTag)scr_box_get_f64(closure->caps[0]);
  const ScrDynHandleOps *ops = scr_dyn_handle_ops(tag);
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result;
  if (self->kind == SCR_DYN_HANDLE && self->v.handle.tag == tag) {
    result = ops->invoke(self->v.handle.ptr, self, method->name, args, argc, method->name);
  } else {
    const char *message = method->invalid_this ? method->invalid_this
                          : ops->invalid_this  ? ops->invalid_this
                                               : "Illegal invocation";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), "ERR_INVALID_THIS");
    result = method->rejects && ops->rejected ? ops->rejected() : NULL;
  }
  scr_dyn_release(self);
  return result;
}

/* The method `key` of the handle's class as a function value (+1), or NULL
 * when the class has no such method. */
static ScrDyn *scr_dynh_method_value(ScrDynHandleTag tag, const ScrDynHandleOps *ops, const char *key, size_t len) {
  const ScrDynHandleMethod *methods = ops->methods;
  if (!methods || !ops->invoke) return NULL;
  for (size_t i = 0; methods[i].name; i++) {
    if (strlen(methods[i].name) != len || memcmp(methods[i].name, key, len) != 0) continue;
    if (!scr_dynh_method_values[tag]) {
      size_t count = i + 1;
      while (methods[count].name) count++;
      scr_dynh_method_values[tag] = calloc(count, sizeof(ScrDyn *));
      if (!scr_dynh_method_values[tag]) scr_trap("scriptc: out of memory\n");
      if (!scr_dynh_method_values_registered) {
        scr_dynh_method_values_registered = true;
        scr_atexit(scr_dynh_method_values_cleanup);
      }
    }
    ScrDyn **slot = &scr_dynh_method_values[tag][i];
    if (!*slot) {
      ScrClosure *closure = scr_closure_new((void *)&methods[i], 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], (double)tag);
      *slot = scr_dyn_new_func(closure, scr_dynh_method_call, methods[i].length, "", methods[i].name);
    }
    return scr_dyn_retain(*slot);
  }
  return NULL;
}

ScrDyn *scr_dyn_handle_key_get(const ScrDyn *d, const ScrStr *k) {
  ScrDynHandleTag tag = d->v.handle.tag;
  const ScrDynHandleOps *ops = scr_dyn_handle_ops(tag);
  ScrDyn *r = ops->get(d->v.handle.ptr, k->data, k->len);
  if (scr_exc_pending()) {
    scr_dyn_release(r);
    return NULL;
  }
  if (!r) r = scr_dynh_method_value(tag, ops, k->data, k->len);
  /* Unmodeled names answer undefined — the checked-dynamic tree's own-property stance
   * (real-but-unmodeled members throw "not supported yet" inside ops->get instead;
   * SEMANTICS.md documents the remainder). */
  return r ? r : scr_dyn_retain(scr_dyn_undefined());
}

/* `key in handle`: the class's methods, and the properties its get models. */
static bool scr_dyn_handle_in(const ScrDyn *d, const ScrStr *k) {
  const ScrDynHandleOps *ops = scr_dyn_handle_ops(d->v.handle.tag);
  const ScrDynHandleMethod *methods = ops->invoke ? ops->methods : NULL;
  for (size_t i = 0; methods && methods[i].name; i++)
    if (strlen(methods[i].name) == k->len && memcmp(methods[i].name, k->data, k->len) == 0) return true;
  if (!methods) return false;
  ScrDyn *value = ops->get(d->v.handle.ptr, k->data, k->len);
  if (!value) return scr_dyn_object_proto_name(k);
  scr_dyn_release(value);
  return true;
}

/* ── the ambient receiver (scr_runtime.h's design note) ───────────────
 * A strictly nested push/pop stack: firing sites bind the owner around
 * each listener call, dyn OBJ method dispatch binds the object, and the
 * emitted dyn.this read answers the innermost binding. Handle entries
 * are BORROWED (the firing site retains the owner across the call);
 * dyn entries are retained for the window. */
typedef struct {
  void *ptr;            /* handle entry (borrowed); NULL when dv or undefined */
  ScrDynHandleTag tag;
  ScrDyn *dv;           /* dyn entry (+1); NULL for handle/undefined entries */
  /* A deferred typed-ref entry (scr_dyn_this_push_typed): the borrowed
   * instance in `ptr` boxes with this recipe on the first read, and dv
   * caches the box. */
  const ScrDynTypedRefRecipe *recipe;
} ScrDynThisEnt;

static SCR_TL ScrDynThisEnt *scr_dyn_this_stack;
static SCR_TL size_t scr_dyn_this_n, scr_dyn_this_cap;

static void scr_dyn_this_cleanup(void) {
  while (scr_dyn_this_n) scr_dyn_this_pop();
  free(scr_dyn_this_stack);
  scr_dyn_this_stack = NULL;
  scr_dyn_this_cap = 0;
}

static ScrDynThisEnt *scr_dyn_this_grow(void) {
  if (!scr_dyn_this_stack) scr_atexit(scr_dyn_this_cleanup);
  if (scr_dyn_this_n == scr_dyn_this_cap) {
    size_t cap = scr_dyn_this_cap ? scr_dyn_this_cap * 2 : 8;
    ScrDynThisEnt *s = realloc(scr_dyn_this_stack, cap * sizeof *s);
    if (!s) {
      scr_trap("scriptc: out of memory\n");
    }
    scr_dyn_this_stack = s;
    scr_dyn_this_cap = cap;
  }
  return &scr_dyn_this_stack[scr_dyn_this_n++];
}

void scr_dyn_this_push(void *h, ScrDynHandleTag tag) {
  ScrDynThisEnt *e = scr_dyn_this_grow();
  e->ptr = h;
  e->tag = tag;
  e->dv = NULL;
  e->recipe = NULL;
}

void scr_dyn_this_push_dyn(const ScrDyn *v) {
  ScrDynThisEnt *e = scr_dyn_this_grow();
  e->ptr = NULL;
  e->tag = 0;
  e->dv = v ? scr_dyn_retain((ScrDyn *)v) : NULL;
  e->recipe = NULL;
}

void scr_dyn_this_push_typed(void *ptr, const ScrDynTypedRefRecipe *recipe) {
  ScrDynThisEnt *e = scr_dyn_this_grow();
  e->ptr = ptr;
  e->tag = 0;
  e->dv = NULL;
  e->recipe = recipe;
}

void scr_dyn_this_pop(void) {
  if (scr_dyn_this_n == 0) {
    scr_trap("scriptc: internal error: receiver stack underflow\n");
  }
  ScrDynThisEnt *e = &scr_dyn_this_stack[--scr_dyn_this_n];
  if (e->dv) scr_dyn_release(e->dv);
}

ScrDyn *scr_dyn_this_get(void) {
  if (scr_dyn_this_n > 0) {
    ScrDynThisEnt *e = &scr_dyn_this_stack[scr_dyn_this_n - 1];
    if (!e->dv && e->recipe) {
      const ScrDynTypedRefRecipe *r = e->recipe;
      e->dv = r->kind == 2
          ? scr_dyn_new_typed_ref_traced(e->ptr, r->retain, r->release, r->type_key,
                                         r->type_key_len, r->materialize, r->commit)
          : r->kind == 1
              ? scr_dyn_new_typed_ref_observed(e->ptr, r->retain, r->release, r->type_key,
                                               r->type_key_len, r->materialize, r->commit)
              : scr_dyn_new_typed_ref(e->ptr, r->retain, r->release, r->type_key,
                                      r->type_key_len, r->materialize, r->commit);
      if (r->view == 1)
        scr_dyn_typed_ref_bind_array(e->dv, (const ScrDynTypedArrayOps *)r->ops);
      else if (r->view == 2)
        scr_dyn_typed_ref_bind_record(e->dv, (const ScrDynTypedRecordOps *)r->ops);
      else if (r->view == 3)
        scr_dyn_typed_ref_bind_class(e->dv, (const ScrDynTypedClassOps *)r->ops);
      else if (r->view == 4)
        scr_dyn_typed_ref_bind_bag_class(e->dv, (const ScrDynTypedBagClassOps *)r->ops);
    }
    if (e->dv) return scr_dyn_retain(e->dv);
    /* An uninstalled tag never binds: a unit that fires without its dyn
     * half (no boxes can exist there) keeps the undefined answer. */
    if (e->ptr && scr_dynh_ops[e->tag]) return scr_dyn_new_handle(e->ptr, e->tag);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The keyed-write arm (see scr_dyn_key_set): modeled setters land on the
 * handle; everything else throws "not supported yet" — Node would add an
 * expando, but expandos per BOX would break handle identity. */
static void scr_dyn_handle_key_set(ScrDyn *recv, ScrStr *key, ScrDyn *value) {
  const ScrDynHandleOps *ops = scr_dyn_handle_ops(recv->v.handle.tag);
  if (ops->set && ops->set(recv->v.handle.ptr, key->data, key->len, value)) return;
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "setting '");
  scr_jb_write(&b, key->data, key->len);
  scr_jb_puts(&b, "' on a dynamic ");
  scr_jb_puts(&b, ops->cls);
  scr_jb_puts(&b, " is not supported yet");
  scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
}

/* Public obj insertion copies a new key only when needed, owns the value,
 * and preserves the existing entry for duplicate keys. */
void scr_dyn_obj_set(ScrDyn *obj, const char *key, size_t key_len, ScrDyn *value) {
  scr_dyn_obj_put(obj, key, key_len, value);
}

/* The getter (or, with `setter`, the setter) of the own accessor property
 * `key`: +1, or the undefined value when the property is not an accessor
 * or has none. */
ScrDyn *scr_dyn_obj_accessor_fn(const ScrDyn *obj, const char *key, size_t key_len, bool setter) {
  const ScrDynEntry *entry = obj->kind == SCR_DYN_OBJ ? scr_dyn_find_entry(obj, key, key_len) : NULL;
  ScrDyn *fn = entry && entry->accessor ? (setter ? entry->setter : entry->getter) : NULL;
  return scr_dyn_retain(fn ? fn : scr_dyn_undefined());
}

/* An object literal's get/set accessor property on a fresh copy:
 * enumerable and configurable, with the given getter and setter functions
 * (either NULL when the literal declares none). Moves both. */
void scr_dyn_obj_set_accessor(ScrDyn *obj, const char *key, size_t key_len, ScrDyn *getter, ScrDyn *setter) {
  scr_dyn_obj_put(obj, key, key_len, scr_dyn_retain(scr_dyn_undefined()));
  ScrDynEntry *entry = scr_dyn_find_entry(obj, key, key_len);
  if (!entry) {
    scr_dyn_release(getter);
    scr_dyn_release(setter);
    return;
  }
  entry->accessor = true;
  entry->getter = getter;
  entry->setter = setter;
}

/* A class instance's view takes its native field values whatever the
 * attributes copied into it (a frozen instance's view is built the same way
 * as any other). Consumes value. */
void scr_dyn_obj_set_field(ScrDyn *obj, const char *key, size_t key_len, ScrDyn *value) {
  ScrDynEntry *existing = obj->v.obj.index ? scr_dyn_find_entry(obj, key, key_len)
                                           : scr_dyn_find_linear_entry(obj, key, key_len);
  if (existing && !existing->accessor) {
    scr_dyn_region_store(obj, value);
    ScrDyn *old = existing->value;
    existing->value = value;
    scr_dyn_release(old);
    return;
  }
  bool non_extensible = obj->non_extensible;
  obj->non_extensible = false;
  scr_dyn_obj_put(obj, key, key_len, value);
  obj->non_extensible = non_extensible;
}

static ScrStr *scr_dyn_property_key(const ScrDyn *key) {
  return scr_dyn_string_coerce_js(key);
}

static ScrDynEntry *scr_dyn_entry(ScrDyn *obj, const ScrStr *key) {
  return scr_dyn_find_entry(obj, key->data, key->len);
}

static bool scr_dyn_property_same_value(const ScrDyn *a, const ScrDyn *b) {
  if (a->kind == SCR_DYN_NUM && b->kind == SCR_DYN_NUM) {
    double left = a->v.num;
    double right = b->v.num;
    if (isnan(left)) return isnan(right);
    if (left == 0 && right == 0) return signbit(left) == signbit(right);
    return left == right;
  }
  return scr_dyn_strict_eq(a, b);
}

bool scr_dyn_same_value(const ScrDyn *left, const ScrDyn *right) {
  return scr_dyn_property_same_value(left, right);
}

static void scr_dyn_descriptor_fields_drop(ScrDyn **fields) {
  for (size_t i = 0; i < 6; i++) scr_dyn_release(fields[i]);
}
static void scr_error_sync_cause(ScrDyn *view, const ScrStr *key);
static void scr_error_sync_slots(const ScrDyn *view, ScrDyn *obj, const ScrStr *key);

/* Property tables belong to closures, not temporary checked wrappers. Seed
 * the configurable, non-writable builtin members once so redefinitions and
 * deletions retain the same behavior through every alias. Returns +1. */
static ScrDyn *scr_dyn_fn_properties(const ScrDyn *function) {
  /* A signature adapter shares the table of the function it adapts. */
  ScrClosure *owner = scr_closure_identity(function->v.fn.clo);
  if (!owner->props && function->v.fn.class_obj && function->v.fn.class_obj->static_data)
    owner->props = scr_box_retain(function->v.fn.class_obj->static_data);
  if (!owner->props) {
    ScrDyn *table = scr_dyn_new_obj();
    const char *name = function->v.fn.name ? function->v.fn.name : "";
    ScrStr *name_string = scr_str_new(name, strlen(name));
    scr_dyn_obj_set(table, "name", 4, scr_dyn_new_str(name_string));
    scr_str_release(name_string);
    scr_dyn_obj_set(table, "length", 6, scr_dyn_new_num((double)function->v.fn.arity));
    for (size_t i = 0; i < table->v.obj.len; i++) {
      table->v.obj.entries[i].writable = false;
      table->v.obj.entries[i].enumerable = false;
    }
    ScrBox *box = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, &scr_dyn_trace_v);
    scr_box_set_ref(box, table);
    owner->props = box;
    if (function->v.fn.class_obj) function->v.fn.class_obj->static_data = scr_box_retain(box);
    if (owner->function_kind & 4) {
      ScrDyn *prototype = scr_dyn_new_obj();
      scr_dyn_obj_set(prototype, "constructor", 11, scr_dyn_retain((ScrDyn *)function));
      prototype->v.obj.entries[0].enumerable = false;
      scr_dyn_obj_set(table, "prototype", 9, prototype);
      ScrDynEntry *entry = &table->v.obj.entries[table->v.obj.len - 1];
      entry->enumerable = false;
      entry->configurable = false;
    }
  }
  return (ScrDyn *)scr_box_get_ref(owner->props);
}

ScrDyn *scr_dyn_class_inherit(ScrDyn *constructor, ScrDyn *base) {
  if (constructor->kind != SCR_DYN_FUNC || !constructor->v.fn.class_obj || (base->kind != SCR_DYN_FUNC && base->kind != SCR_DYN_UNDEF)) {
    static const char message[] = "Class inheritance requires native constructors";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *table = scr_dyn_fn_properties(constructor);
  if (base->kind == SCR_DYN_FUNC) scr_dyn_release(scr_dyn_fn_properties(base));
  ScrClassObj *cls = constructor->v.fn.class_obj;
  if (!cls->static_data) cls->static_data = scr_box_retain(scr_closure_identity(constructor->v.fn.clo)->props);
  ScrDyn *result = base->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_set_prototype(table, base);
  scr_dyn_release(table);
  scr_dyn_release(result);
  return scr_exc_pending() ? NULL : scr_dyn_retain(constructor);
}

/* Defines `key` on target as a writable, configurable, non-enumerable data
 * property holding value (borrowed), as Error's constructor installs its
 * message and cause. */
static void scr_dyn_define_hidden(ScrDyn *target, const ScrStr *key, ScrDyn *value) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *name = scr_dyn_new_str((ScrStr *)key);
  ScrDyn *defined = scr_dyn_define_property(target, name, descriptor);
  scr_dyn_release(name);
  scr_dyn_release(descriptor);
  scr_dyn_release(defined);
}

/* A builtin constructor a class expression's runtime heritage can name:
 * 1 for Object, 2 for Error, 0 otherwise. */
static int scr_dyn_builtin_base_kind(const ScrDyn *constructor) {
  if (constructor->kind != SCR_DYN_FUNC || constructor->v.fn.class_obj || !constructor->v.fn.sig ||
      !constructor->v.fn.name || strcmp(constructor->v.fn.sig, "native:constructor") != 0)
    return 0;
  if (strcmp(constructor->v.fn.name, "Object") == 0) return 1;
  if (strcmp(constructor->v.fn.name, "Error") == 0 && constructor->v.fn.clo->fn == (void *)scr_error_ctor_names[0])
    return 2;
  return 0;
}

ScrDyn *scr_dyn_class_base_prototype(ScrDyn *constructor) {
  /* `class extends (Base ?? Object)`: Object's instances are ordinary
   * objects, laid out like a class without heritage (undefined); Error's
   * inherit Error.prototype. */
  switch (scr_dyn_builtin_base_kind(constructor)) {
  case 1: return scr_dyn_retain(scr_dyn_undefined());
  case 2: return scr_dyn_error_prototype();
  default: break;
  }
  if (constructor->kind != SCR_DYN_FUNC || constructor->v.fn.class_obj ||
      scr_closure_identity(constructor->v.fn.clo)->function_kind != 4) {
    static const char message[] = "Class extends value is not a native ordinary constructor";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *prototype = scr_dyn_fn_get(constructor, "prototype", 9);
  if (!prototype) return NULL;
  if (prototype->kind == SCR_DYN_OBJ || prototype->kind == SCR_DYN_NULL) return prototype;
  scr_dyn_release(prototype);
  static const char message[] = "This constructor prototype has no native class lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

void scr_dyn_class_super(ScrDyn *constructor, ScrDyn *receiver, ScrDyn *arguments) {
  switch (scr_dyn_builtin_base_kind(constructor)) {
  case 1:
    /* super() through Object keeps the receiver the derived constructor
     * created (OrdinaryCreateFromConstructor). */
    return;
  case 2: {
    /* super(message, options) through Error: the message and cause become
     * non-enumerable own properties, then the stack (its text alone, as for
     * scriptc's other errors). */
    size_t argc = arguments->v.arr.len;
    ScrDyn *const *argv = arguments->v.arr.items;
    if (argc > 0 && argv[0]->kind != SCR_DYN_UNDEF) {
      ScrStr *text = scr_dyn_string_coerce_js(argv[0]);
      if (!text) return;
      ScrDyn *value = scr_dyn_new_str(text);
      scr_str_release(text);
      ScrStr *key = scr_str_new("message", 7);
      scr_dyn_define_hidden(receiver, key, value);
      scr_str_release(key);
      scr_dyn_release(value);
      if (scr_exc_pending()) return;
    }
    /* InstallErrorCause: an options object with a `cause` property, own or
     * inherited, defines the value its getter or data property reads. */
    ScrDyn *options = argc > 1 ? argv[1] : NULL;
    if (options && options->kind != SCR_DYN_NULL &&
        (options->kind == SCR_DYN_FUNC || scr_dyn_is_object(options))) {
      ScrStr *key = scr_str_new("cause", 5);
      if (scr_dyn_in(options, key) && !scr_exc_pending()) {
        ScrDyn *cause = scr_dyn_obj_read(options, "cause", 5);
        if (cause && !scr_exc_pending()) scr_dyn_define_hidden(receiver, key, cause);
        scr_dyn_release(cause);
      }
      scr_str_release(key);
      if (scr_exc_pending()) return;
    }
    ScrStr *text = scr_dyn_error_string(receiver);
    if (!text) return;
    ScrDyn *stack = scr_dyn_new_str(text);
    scr_str_release(text);
    ScrStr *key = scr_str_new("stack", 5);
    scr_dyn_define_hidden(receiver, key, stack);
    scr_str_release(key);
    scr_dyn_release(stack);
    return;
  }
  default:
    break;
  }
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(constructor, arguments->v.arr.items, arguments->v.arr.len, "super");
  scr_dyn_this_pop();
  if (!result) return;
  if (scr_iterator_object(result) && !scr_dyn_strict_eq(result, receiver)) {
    static const char message[] = "Replacing a native class instance from its base constructor has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  scr_dyn_release(result);
}

bool scr_dyn_data_view_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_BYTES && value->v.bytes->is_data_view;
}

/* util.inspect names an object after the function held by the first own
 * `constructor` data property on its prototype chain (Node's
 * getConstructorName). The dyn printer reads runtime class names
 * (v.obj.class_name, set only on prototypes that stay alive), so a
 * construction through a plain function stamps that prototype with a copy
 * of the function's name and keeps it alive. The copy is the stamp's own: a
 * function's name can live in storage the function owns (a bound
 * function's "bound <name>"), and the function is released when the
 * writable `constructor` property is replaced. The stamps are cleared and
 * their copies freed before release at exit, so freelist reuse never sees
 * them. */
typedef struct {
  ScrDyn *prototype;
  char *name;
} ScrDynNamedPrototype;
static SCR_TL ScrDynNamedPrototype *scr_dyn_named_prototypes;
static SCR_TL size_t scr_dyn_named_count, scr_dyn_named_cap;

static void scr_dyn_named_prototypes_cleanup(void) {
  for (size_t i = 0; i < scr_dyn_named_count; i++) {
    scr_dyn_named_prototypes[i].prototype->v.obj.class_name = NULL;
    scr_dyn_release(scr_dyn_named_prototypes[i].prototype);
    free(scr_dyn_named_prototypes[i].name);
  }
  free(scr_dyn_named_prototypes);
  scr_dyn_named_prototypes = NULL;
  scr_dyn_named_count = scr_dyn_named_cap = 0;
}

/* Stamps prototype `p` with a copy of `name` (len bytes) and keeps it alive. */
static void scr_dyn_stamp_prototype_name(ScrDyn *p, const char *name, size_t len) {
  if (scr_dyn_named_count == scr_dyn_named_cap) {
    if (scr_dyn_named_cap == 0) scr_atexit(scr_dyn_named_prototypes_cleanup);
    size_t cap = scr_dyn_named_cap ? scr_dyn_named_cap * 2 : 8;
    ScrDynNamedPrototype *grown = realloc(scr_dyn_named_prototypes, cap * sizeof *grown);
    if (!grown) scr_json_oom();
    scr_dyn_named_prototypes = grown;
    scr_dyn_named_cap = cap;
  }
  char *copy = malloc(len + 1);
  if (!copy) scr_json_oom();
  memcpy(copy, name, len);
  copy[len] = '\0';
  p->v.obj.class_name = copy;
  scr_dyn_named_prototypes[scr_dyn_named_count++] = (ScrDynNamedPrototype){ scr_dyn_retain(p), copy };
}

static void scr_dyn_name_prototype_chain(const ScrDyn *object) {
  for (ScrDyn *p = object->prototype; p; p = p->prototype) {
    if (p->kind != SCR_DYN_OBJ || p->v.obj.class_name) return;
    ScrDynEntry *entry = scr_dyn_find_entry(p, "constructor", 11);
    if (!entry || entry->accessor || !entry->value || entry->value->kind != SCR_DYN_FUNC) continue;
    const char *name = entry->value->v.fn.name;
    if (!name || !name[0]) continue;
    scr_dyn_stamp_prototype_name(p, name, strlen(name));
    return;
  }
}

void scr_dyn_name_class_prototype(ScrDyn *prototype, const ScrStr *name) {
  if (prototype->kind != SCR_DYN_OBJ || prototype->v.obj.class_name || name->len == 0) return;
  scr_dyn_stamp_prototype_name(prototype, name->data, name->len);
}

/* Ordinary native function constructors retain their live prototype table.
 * A constructor may replace the fresh receiver with another object. */
ScrDyn *scr_dyn_construct(const ScrDyn *callee, const ScrDyn *args, const ScrStr *what) {
#ifdef SCR_NODE_ISLANDS
  if (scr_ni_is_handle(callee))
    return scr_ni_construct((ScrDyn *)callee, args->v.arr.items, args->v.arr.len);
#endif
  if (callee->kind != SCR_DYN_FUNC || callee->v.fn.class_obj || scr_closure_identity(callee->v.fn.clo)->function_kind != 4)
    return scr_bytes_construct(callee, args, what);
  ScrDyn *prototype = scr_dyn_fn_get(callee, "prototype", 9);
  if (!prototype) return NULL;
  ScrDyn *receiver = scr_iterator_object(prototype) ? scr_dyn_obj_create(prototype) : scr_dyn_new_obj();
  scr_dyn_release(prototype);
  if (!receiver) return NULL;
  scr_dyn_name_prototype_chain(receiver);
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(callee, args->v.arr.items, args->v.arr.len, what->data);
  scr_dyn_this_pop();
  if (!result) {
    scr_dyn_release(receiver);
    return NULL;
  }
  if (scr_iterator_object(result)) {
    scr_dyn_release(receiver);
    return result;
  }
  scr_dyn_release(result);
  return receiver;
}

/* Symbol descriptors use the ordinary descriptor implementation in an
 * inaccessible table. Keep a retained key list so identities cannot be
 * recycled while properties exist, and reflection returns real symbols. */
static ScrStr *scr_dyn_symbol_storage_key(const ScrDyn *key) {
  char buffer[2 * sizeof(void *) + 4];
  int length = snprintf(buffer, sizeof buffer, "%p", (void *)key->v.symbol.value);
  return scr_str_new(buffer, (size_t)length);
}

static ScrDyn *scr_dyn_symbol_receiver(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) return scr_dyn_typed_ref_materialize(value);
  if (value->kind == SCR_DYN_FUNC) return scr_dyn_fn_properties(value);
  if (value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_HANDLE)
    return scr_dyn_retain((ScrDyn *)value);
  if (value->kind == SCR_DYN_PROXY) {
    static const char message[] = "Symbol properties on this native value have no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  return NULL;
}

static ScrDynEntry *scr_dyn_symbol_entry(const ScrDyn *receiver, const ScrDyn *key, bool own) {
  ScrStr *name = scr_dyn_symbol_storage_key(key);
  ScrDynEntry *entry = NULL;
  for (const ScrDyn *current = receiver; current; current = own ? NULL : current->prototype ? scr_dyn_proto_next(current)
      : current->kind == SCR_DYN_ARR && current != scr_builtin_array_prototype && !current->null_proto ? scr_builtin_array_prototype : NULL) {
    if (current->kind == SCR_DYN_FUNC) {
      ScrDyn *table = scr_dyn_fn_properties(current);
      entry = scr_dyn_symbol_entry(table, key, own);
      scr_dyn_release(table);
      break;
    }
    if (current->symbol_properties) entry = scr_dyn_entry(current->symbol_properties, name);
    if (entry) break;
  }
  scr_str_release(name);
  return entry;
}

ScrDynEntry *scr_dyn_own_symbol_entry(const ScrDyn *object, const ScrDyn *key) {
  return object->symbol_properties ? scr_dyn_symbol_entry(object, key, true) : NULL;
}

ScrStr *scr_dyn_symbol_storage_name(const ScrDyn *key) { return scr_dyn_symbol_storage_key(key); }

void scr_dyn_symbol_init_own(ScrDyn *object, ScrDyn *key, const ScrStr *storage, ScrDyn *value) {
  scr_dyn_region_store(object, NULL); /* intact containers have no symbol tables */
  object->symbol_properties = scr_dyn_new_obj_null_proto();
  scr_dyn_obj_set(object->symbol_properties, storage->data, storage->len, scr_dyn_retain(value));
  object->symbol_keys = scr_dyn_new_arr();
  scr_dyn_arr_push(object->symbol_keys, scr_dyn_retain(key));
}

static void scr_dyn_symbol_table(ScrDyn *receiver) {
  /* The tables are separate nodes that later hold arbitrary values. */
  scr_dyn_region_store(receiver, NULL);
  if (!receiver->symbol_properties) receiver->symbol_properties = scr_dyn_new_obj_null_proto();
  if (!receiver->symbol_keys) receiver->symbol_keys = scr_dyn_new_arr();
  receiver->symbol_properties->non_extensible = receiver->non_extensible;
}

typedef struct {
  size_t rc;
  ScrDyn *source;
  double index;
  unsigned kind; /* 0: array, 1: string, 2: Map, 3: Set */
  unsigned selection; /* 0: values, 1: keys, 2: entries */
  bool array_like;
  bool step_done; /* completion of the last compiler-consumed step */
  double limit;
} ScrNativeIterator;

static ScrDyn *scr_iterator_read(const ScrDyn *value, const char *key, size_t len);

/* A Map (kind 2) or Set (kind 3) iterator: util.types.isMapIterator and
 * isSetIterator. */
static bool scr_native_iterator_over(const ScrDyn *value, unsigned kind) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_ITERATOR &&
         ((const ScrNativeIterator *)value->v.handle.ptr)->kind == kind;
}

static SCR_TL ScrDyn *scr_iterator_functions[11];
static SCR_TL bool scr_iterator_functions_registered;

static void scr_iterator_functions_cleanup(void) {
  for (size_t i = 0; i < 11; i++) {
    ScrDyn *function = scr_iterator_functions[i];
    scr_iterator_functions[i] = NULL;
    scr_dyn_release(function);
  }
}

static ScrDyn *scr_iterator_function(size_t index, ScrDynThunk thunk, const char *name) {
  if (!scr_iterator_functions_registered) {
    scr_iterator_functions_registered = true;
    scr_atexit(scr_iterator_functions_cleanup);
  }
  if (!scr_iterator_functions[index])
    scr_iterator_functions[index] = scr_dyn_new_func(scr_closure_new(NULL, 0), thunk, 0, "native:iterator", name);
  return scr_dyn_retain(scr_iterator_functions[index]);
}

static void *scr_native_iterator_retain(void *ptr) {
  ScrNativeIterator *iterator = ptr;
  iterator->rc++;
  return ptr;
}

static void scr_native_iterator_release(void *ptr) {
  ScrNativeIterator *iterator = ptr;
  if (--iterator->rc) return;
  scr_weak_dispose(iterator);
  if (iterator->source && (iterator->kind == 2 || iterator->kind == 3)) scr_map_iter_exit(iterator->source->v.handle.ptr);
  scr_dyn_release(iterator->source);
  free(iterator);
}

/* Produce an owned value without allocating the protocol result. The
 * compiler uses this only after checking the captured next function; public
 * next() calls still receive a fresh, independently mutable result object. */
static ScrDyn *scr_native_iterator_value(ScrNativeIterator *iterator, bool *done_out) {
  ScrDyn *source = iterator->source;
  /* An inherited indexed getter can advance this same iterator recursively.
   * Keep the source alive even if that nested call exhausts the iterator. */
  if (source) scr_dyn_retain(source);
  /* A live native array answers an in-range own element directly. Holes
   * (prototype lookups) and completion fall through to the view below. */
  if (source && source->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(source) &&
      iterator->kind == 0 && !iterator->array_like &&
      iterator->index < (double)((ScrArr *)source->v.typed_ref.ptr)->len) {
    double index = iterator->index;
    ScrDyn *value = iterator->selection == 1 ? scr_dyn_new_num(index)
                                             : scr_dyn_typed_ref_element(source, (size_t)index);
    if (value) {
      if (iterator->selection == 2) {
        ScrDyn *entry = scr_dyn_new_arr();
        scr_dyn_arr_push(entry, scr_dyn_new_num(index));
        scr_dyn_arr_push(entry, value);
        value = entry;
      }
      iterator->index++;
      scr_dyn_release(source);
      *done_out = false;
      return value;
    }
  }
  /* Completion depends only on the live length, which the view would copy. */
  if (source && source->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(source) &&
      iterator->kind == 0 && !iterator->array_like &&
      iterator->index >= (double)((ScrArr *)source->v.typed_ref.ptr)->len) {
    iterator->source = NULL;
    scr_dyn_release(source);
    scr_dyn_release(source);
    *done_out = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  /* Native array capsules retain the live array, so refresh its view at each
   * step rather than iterating a snapshot taken when the iterator opened. */
  ScrDyn *view = source && source->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(source) : NULL;
  if (scr_exc_pending()) { scr_dyn_release(view); scr_dyn_release(source); return NULL; }
  ScrDyn *items = view ? view : source;
  ScrMap *map = source && (iterator->kind == 2 || iterator->kind == 3) ? source->v.handle.ptr : NULL;
  if (map) iterator->index = scr_map_iter_skip(map, iterator->index);
  double length = !items ? 0 : iterator->array_like ? iterator->limit : map ? scr_map_iter_count(map) : items->kind == SCR_DYN_ARR ? (double)items->v.arr.len
    : items->kind == SCR_DYN_BYTES ? (double)items->v.bytes->len : scr_str_utf16_len(items->v.str);
  bool done = !source || iterator->index >= length;
  ScrDyn *value;
  if (done) {
    value = scr_dyn_retain(scr_dyn_undefined());
    iterator->source = NULL;
    if (map) scr_map_iter_exit(map);
    scr_dyn_release(source);
  } else if (iterator->array_like) {
    char key[32];
    int size = snprintf(key, sizeof key, "%.0f", iterator->index++);
    value = scr_iterator_read(items, key, (size_t)size);
  } else if (map) {
    double index = iterator->index++;
    if (iterator->selection == 2) {
      value = scr_dyn_new_arr();
      scr_dyn_arr_push(value, scr_map_dyn_key(map, index));
      scr_dyn_arr_push(value, iterator->kind == 3 ? scr_map_dyn_key(map, index) : scr_map_dyn_value(map, index));
    } else value = iterator->selection == 1 || iterator->kind == 3
      ? scr_map_dyn_key(map, index) : scr_map_dyn_value(map, index);
  } else if (items->kind == SCR_DYN_ARR) {
    double index = iterator->index++;
    if (iterator->selection == 1) value = scr_dyn_new_num(index);
    else {
      value = scr_dyn_arr_at(items, index);
      if (value && iterator->selection == 2) {
        ScrDyn *entry = scr_dyn_new_arr();
        scr_dyn_arr_push(entry, scr_dyn_new_num(index));
        scr_dyn_arr_push(entry, value);
        value = entry;
      }
    }
  } else if (items->kind == SCR_DYN_BYTES) {
    value = scr_dyn_new_num(scr_bytes_get(items->v.bytes, iterator->index++));
  } else {
    ScrStr *point = scr_str_cp_at(items->v.str, iterator->index);
    iterator->index += scr_str_utf16_len(point);
    value = scr_dyn_new_str(point);
    scr_str_release(point);
  }
  scr_dyn_release(view);
  scr_dyn_release(source);
  *done_out = done;
  return value;
}

static ScrDyn *scr_native_iterator_next(ScrNativeIterator *iterator) {
  ScrDyn *source = iterator->source;
  if (source && iterator->kind == 4) {
    ScrDyn *result = scr_dyn_handle_ops_of(source)->iter_step(source->v.handle.ptr, &iterator->index, iterator->selection);
    if (!result) return NULL;
    if (scr_dyn_truthy(scr_dyn_obj_get(result, "done", 4))) {
      iterator->source = NULL;
      scr_dyn_release(source);
    }
    return result;
  }
  bool done;
  ScrDyn *value = scr_native_iterator_value(iterator, &done);
  if (!value) return NULL;
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, value);
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

static ScrDyn *scr_native_iterator_next_checked(unsigned kind) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_ITERATOR &&
      ((ScrNativeIterator *)self->v.handle.ptr)->kind == kind)
    result = scr_native_iterator_next(self->v.handle.ptr);
  else {
    const char *message = kind == 3 ? "Method Set Iterator.prototype.next called on incompatible receiver"
      : kind == 2 ? "Method Map Iterator.prototype.next called on incompatible receiver" : kind == 1
      ? "Method String Iterator.prototype.next called on incompatible receiver"
      : "Method Array Iterator.prototype.next called on incompatible receiver";
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_native_array_iterator_next_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_native_iterator_next_checked(0);
}

static ScrDyn *scr_native_string_iterator_next_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_native_iterator_next_checked(1);
}

static ScrDyn *scr_native_map_iterator_next_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_native_iterator_next_checked(2);
}

static ScrDyn *scr_native_set_iterator_next_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_native_iterator_next_checked(3);
}

static ScrDyn *scr_native_handle_iterator_next_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_native_iterator_next_checked(4);
}

bool scr_dyn_iterator_can_step(const ScrDyn *iterator, const ScrDyn *next) {
  if (iterator->kind != SCR_DYN_HANDLE || iterator->v.handle.tag != SCR_DYNH_ITERATOR) return false;
  unsigned kind = ((ScrNativeIterator *)iterator->v.handle.ptr)->kind;
  if (kind > 3) return false;
  size_t index = kind == 3 ? 8 : kind == 2 ? 7 : kind == 1 ? 5 : 0;
  return next == scr_iterator_functions[index];
}

ScrDyn *scr_dyn_iterator_step(const ScrDyn *value) {
  ScrNativeIterator *iterator = value->v.handle.ptr;
  bool done = false;
  ScrDyn *item = scr_native_iterator_value(iterator, &done);
  /* Publish after getters finish, so recursive steps cannot overwrite this
   * step's completion. No user code runs between step and step_done. */
  iterator->step_done = done;
  return item;
}

bool scr_dyn_iterator_step_done(const ScrDyn *value) {
  return ((ScrNativeIterator *)value->v.handle.ptr)->step_done;
}

void scr_dyn_native_iterator_state(const ScrDyn *value, unsigned *kind, unsigned *selection,
                                   ScrMap **collection, double *index) {
  const ScrNativeIterator *iterator = value->v.handle.ptr;
  *kind = iterator->kind;
  *selection = iterator->selection;
  *collection = (iterator->kind == 2 || iterator->kind == 3) && iterator->source
    ? iterator->source->v.handle.ptr : NULL;
  *index = iterator->index;
}

double scr_dyn_collection_iterator_index(const ScrDyn *value) {
  ScrNativeIterator *iterator = value->v.handle.ptr;
  ScrDyn *source = iterator->source;
  if (!source) return -1;
  ScrMap *map = source->v.handle.ptr;
  iterator->index = scr_map_iter_skip(map, iterator->index);
  if (iterator->index >= scr_map_iter_count(map)) {
    iterator->source = NULL;
    scr_map_iter_exit(map);
    scr_dyn_release(source);
    return -1;
  }
  return iterator->index++;
}

static int scr_ih_method_index(const char *name, size_t len);
static ScrDyn *scr_iterator_helper_method(ScrDyn *self, int index, ScrDyn *const *args, size_t argc);
static ScrDyn *scr_ih_method_function(int index);

static bool scr_dyn_sync_generator(const ScrDyn *value);
extern SCR_TL ScrDyn *(*scr_generator_member_hook)(const ScrDyn *, const char *, size_t);

/* scr_iterator_read of an iterator's own next or return method: a
 * compiled generator answers through the program's registered getters. */
static ScrDyn *scr_iterator_member(const ScrDyn *iterator, const char *key, size_t len) {
  if (scr_generator_member_hook && scr_dyn_sync_generator(iterator)) {
    ScrDyn *member = scr_generator_member_hook(iterator, key, len);
    if (member) return member;
  }
  return scr_iterator_read(iterator, key, len);
}

static ScrDyn *scr_native_iterator_get(void *ptr, const char *key, size_t len) {
  if (len != 4 || memcmp(key, "next", 4)) {
    /* The Iterator.prototype helper methods. */
    int index = scr_ih_method_index(key, len);
    return index >= 0 ? scr_ih_method_function(index) : NULL;
  }
  unsigned kind = ((ScrNativeIterator *)ptr)->kind;
  if (kind == 4) return scr_iterator_function(10, &scr_native_handle_iterator_next_call, "next");
  return kind == 3 ? scr_iterator_function(8, &scr_native_set_iterator_next_call, "next")
    : kind == 2 ? scr_iterator_function(7, &scr_native_map_iterator_next_call, "next") : kind == 1
    ? scr_iterator_function(5, &scr_native_string_iterator_next_call, "next")
    : scr_iterator_function(0, &scr_native_array_iterator_next_call, "next");
}

static ScrDyn *scr_native_iterator_invoke(void *ptr, ScrDyn *self, const char *method,
                                         ScrDyn *const *args, size_t argc, const char *what) {
  if (!strcmp(method, "next")) return scr_native_iterator_next(ptr);
  int index = scr_ih_method_index(method, strlen(method));
  if (index >= 0) return scr_iterator_helper_method(self, index, args, argc);
  ScrDyn *missing = scr_dyn_undefined();
  return scr_dyn_call(missing, args, argc, what);
}

static ScrDyn *scr_native_iterator_new(ScrDyn *source) {
  static const ScrDynHandleOps ops = {
    "Array Iterator", &scr_native_iterator_retain, &scr_native_iterator_release,
    &scr_native_iterator_invoke, &scr_native_iterator_get, NULL, NULL, NULL,
  };
  scr_dyn_handle_install(SCR_DYNH_ITERATOR, &ops);
  ScrNativeIterator *iterator = malloc(sizeof *iterator);
  if (!iterator) scr_json_oom();
  *iterator = (ScrNativeIterator){ .rc = 1, .source = scr_dyn_retain(source), .index = 0,
    .kind = source->kind == SCR_DYN_STR ? 1 : source->kind == SCR_DYN_HANDLE && source->v.handle.tag == SCR_DYNH_MAP ? 2
      : source->kind == SCR_DYN_HANDLE && source->v.handle.tag == SCR_DYNH_SET ? 3
      : source->kind == SCR_DYN_HANDLE && scr_dyn_handle_ops_of(source)->iter_step ? 4 : 0,
    .selection = source->kind == SCR_DYN_HANDLE && (source->v.handle.tag == SCR_DYNH_MAP || scr_dyn_handle_ops_of(source)->iter_step) ? 2 : 0 };
  if (iterator->kind == 2 || iterator->kind == 3) scr_map_iter_enter(source->v.handle.ptr);
  ScrDyn *result = scr_dyn_new_handle(iterator, SCR_DYNH_ITERATOR);
  scr_native_iterator_release(iterator);
  return result;
}

static ScrDyn *scr_native_collection_iterator(ScrDyn *source, unsigned selection) {
  ScrDyn *result = scr_native_iterator_new(source);
  ((ScrNativeIterator *)result->v.handle.ptr)->selection = selection;
  return result;
}

/* ── iterator helpers on checked iterators (ES2025) ─────────────────────────
 * The Iterator.prototype methods over a checked iterator object: a native
 * array, string, Map or Set iterator, or a helper object made here. Typed
 * code lowers its helpers statically; these answer untyped JavaScript
 * receivers. The stages (map, filter, take, drop, flatMap) make helper
 * objects that pull lazily; the consuming methods (toArray, forEach, reduce,
 * some, every, find) drive the iterator to completion or to their answer.
 * Closing follows IteratorClose: a helper closes the iterator it was made
 * from when a callback throws, when its budget is spent, and on return();
 * an error from a close that runs because of another error is dropped. */

static ScrDyn *scr_iterator_call(const ScrDyn *method, const ScrDyn *receiver, const char *name);
static ScrDyn *scr_iterator_method(const ScrDyn *source);

enum { SCR_IH_MAP, SCR_IH_FILTER, SCR_IH_TAKE, SCR_IH_DROP, SCR_IH_FLATMAP };
enum { SCR_IH_START, SCR_IH_YIELDED, SCR_IH_RUNNING, SCR_IH_DONE };

typedef struct {
  size_t rc;
  unsigned kind;
  unsigned state;
  ScrDyn *iterated; /* the iterator the helper was made from */
  ScrDyn *next;     /* its next method, read when the helper was made */
  ScrDyn *fn;       /* the map, filter or flatMap callback */
  double remaining; /* the take or drop budget */
  double counter;
  ScrDyn *inner;    /* flatMap's current inner iterator */
  ScrDyn *inner_next;
} ScrIterHelper;

static const char *const scr_ih_method_names[] = {
  "map", "filter", "take", "drop", "flatMap", "reduce", "toArray", "forEach", "some", "every", "find",
};
#define SCR_IH_METHOD_COUNT (sizeof scr_ih_method_names / sizeof scr_ih_method_names[0])

/* The index of an Iterator.prototype helper method name, or -1. */
static int scr_ih_method_index(const char *name, size_t len) {
  for (size_t i = 0; i < SCR_IH_METHOD_COUNT; i++) {
    if (strlen(scr_ih_method_names[i]) == len && !memcmp(scr_ih_method_names[i], name, len)) return (int)i;
  }
  return -1;
}

/* V8's description of a value in "<value> is not a function": the type,
 * with the value for primitives that print one. */
static void scr_ih_describe_type(ScrJsonBuf *b, const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_UNDEF: scr_jb_puts(b, "undefined"); return;
  case SCR_DYN_NULL: scr_jb_puts(b, "object null"); return;
  case SCR_DYN_BOOL: scr_jb_puts(b, v->v.b ? "boolean true" : "boolean false"); return;
  case SCR_DYN_NUM: {
    scr_jb_puts(b, "number ");
    ScrStr *n = scr_f64_to_scrstr(v->v.num);
    scr_jb_write(b, n->data, n->len);
    scr_str_release(n);
    return;
  }
  case SCR_DYN_STR:
    scr_jb_puts(b, "string \"");
    scr_jb_write(b, v->v.str->data, v->v.str->len);
    scr_jb_putc(b, '"');
    return;
  case SCR_DYN_SYMBOL: scr_jb_puts(b, "symbol"); return;
  case SCR_DYN_BIGINT: scr_jb_puts(b, "bigint"); return;
  default: scr_jb_puts(b, "object"); return;
  }
}

static bool scr_ih_require_callable(const ScrDyn *fn) {
  if (scr_dyn_is_callable(fn)) return true;
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_ih_describe_type(&b, fn);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return false;
}

/* V8's text for the value in "<value> must be positive": numbers, strings
 * raw, undefined by name,
 * arrays and objects by their default string or constructor name. */
static void scr_ih_describe_value(ScrJsonBuf *b, const ScrDyn *v) {
  if (v->kind == SCR_DYN_ARR) {
    scr_jb_puts(b, "[object Array]");
    return;
  }
  if (v->kind == SCR_DYN_OBJ) {
    scr_jb_puts(b, "#<Object>");
    return;
  }
  if (v->kind == SCR_DYN_HANDLE) {
    scr_jb_puts(b, "#<");
    scr_jb_puts(b, scr_dyn_handle_ops_of(v)->cls);
    scr_jb_putc(b, '>');
    return;
  }
  if (v->kind == SCR_DYN_STR) {
    scr_jb_write(b, v->v.str->data, v->v.str->len);
    return;
  }
  if (v->kind == SCR_DYN_NUM) {
    ScrStr *n = scr_f64_to_scrstr(v->v.num);
    scr_jb_write(b, n->data, n->len);
    scr_str_release(n);
    return;
  }
  scr_jb_puts(b, v->kind == SCR_DYN_UNDEF ? "undefined" : "NaN");
}

/* ToIntegerOrInfinity of a take/drop budget with Node's RangeError for NaN
 * and negative budgets. Answers false with the exception pending. */
static bool scr_ih_budget(const ScrDyn *limit, double *out) {
  double n = scr_dyn_number_coerce(limit);
  if (scr_exc_pending()) return false;
  if (n != n) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_ih_describe_value(&b, limit);
    scr_jb_puts(&b, " must be positive");
    scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&b));
    return false;
  }
  double t = n < 9007199254740992.0 && n > -9007199254740992.0 ? n - fmod(n, 1.0) : n;
  if (t < 0) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_ih_describe_value(&b, limit);
    scr_jb_puts(&b, " must be positive");
    scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&b));
    return false;
  }
  *out = t == 0 ? 0 : t;
  return true;
}

/* IteratorClose(iterator, completion). `abrupt` is a throw completion: the
 * pending error stays and anything the return() call raises is dropped.
 * Otherwise errors from return() propagate, and a non-object result is
 * Node's TypeError. Answers false when an exception is pending after. */
static bool scr_ih_close(ScrDyn *iterator, bool abrupt) {
  ScrCaught *first = abrupt ? scr_exc_take() : NULL;
  ScrDyn *method = scr_iterator_member(iterator, "return", 6);
  bool ok = method != NULL;
  if (ok && method->kind != SCR_DYN_UNDEF && method->kind != SCR_DYN_NULL) {
    ScrDyn *result = scr_iterator_call(method, iterator, "return");
    if (!result) ok = false;
    else {
      if (!abrupt && !scr_iterator_object(result)) {
        static const char message[] = "Iterator result is not an object";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        ok = false;
      }
      scr_dyn_release(result);
    }
  }
  scr_dyn_release(method);
  if (first) {
    if (scr_exc_pending()) {
      ScrCaught *dropped = scr_exc_take();
      if (dropped) scr_caught_release(dropped);
    }
    scr_rethrow(first);
    scr_caught_release(first);
    return false;
  }
  return ok && !scr_exc_pending();
}

/* IteratorStepValue over (iterator, next): +1 value with *done false, or
 * *done true (the answer is then undefined); NULL with the exception
 * pending when next() throws or answers a non-object. */
static ScrDyn *scr_ih_step(ScrDyn *iterator, ScrDyn *next, bool *done) {
  *done = false;
  if (scr_dyn_iterator_can_step(iterator, next)) {
    ScrDyn *value = scr_dyn_iterator_step(iterator);
    if (!value) return NULL;
    *done = scr_dyn_iterator_step_done(iterator);
    return value;
  }
  ScrDyn *raw = scr_iterator_call(next, iterator, "next");
  if (!raw) return NULL;
  ScrDyn *result = scr_dyn_iterator_result(raw);
  scr_dyn_release(raw);
  if (!result) return NULL;
  ScrDyn *finished = scr_iterator_read(result, "done", 4);
  if (!finished) {
    scr_dyn_release(result);
    return NULL;
  }
  *done = scr_dyn_truthy(finished);
  scr_dyn_release(finished);
  ScrDyn *value = *done ? scr_dyn_retain(scr_dyn_undefined()) : scr_iterator_read(result, "value", 5);
  scr_dyn_release(result);
  return value;
}

/* GetIteratorDirect: the receiver must be an object; its next method is
 * read once. +1 next, or NULL with the TypeError pending. */
static ScrDyn *scr_ih_direct(const ScrDyn *self, const char *method) {
  if (!scr_iterator_object(self)) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "Iterator.prototype.");
    scr_jb_puts(&b, method);
    scr_jb_puts(&b, " called on non-object");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return NULL;
  }
  return scr_iterator_member(self, "next", 4);
}

static ScrDyn *scr_ih_result(ScrDyn *value, bool done) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, value);
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

static void *scr_ih_retain(void *ptr) {
  ((ScrIterHelper *)ptr)->rc++;
  return ptr;
}

static void scr_ih_release(void *ptr) {
  ScrIterHelper *h = ptr;
  if (--h->rc) return;
  scr_dyn_release(h->iterated);
  scr_dyn_release(h->next);
  if (h->fn) scr_dyn_release(h->fn);
  if (h->inner) scr_dyn_release(h->inner);
  if (h->inner_next) scr_dyn_release(h->inner_next);
  free(h);
}

static void scr_ih_clear_inner(ScrIterHelper *h) {
  if (h->inner) scr_dyn_release(h->inner);
  if (h->inner_next) scr_dyn_release(h->inner_next);
  h->inner = NULL;
  h->inner_next = NULL;
}

/* GetIteratorFlattenable(value, reject-primitives) for flatMap's callback
 * result: +1 iterator with *next_out +1, or NULL with the TypeError pending. */
static ScrDyn *scr_ih_flattenable(ScrDyn *value, ScrDyn **next_out) {
  if (!scr_iterator_object(value)) {
    static const char message[] = "Iterator.prototype.flatMap called on non-object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *method = scr_iterator_method(value);
  if (!method) return NULL;
  ScrDyn *iterator;
  if (method->kind == SCR_DYN_UNDEF || method->kind == SCR_DYN_NULL) {
    iterator = scr_dyn_retain(value);
  } else {
    iterator = scr_iterator_call(method, value, "value[Symbol.iterator]");
    if (iterator && !scr_iterator_object(iterator)) {
      scr_dyn_release(iterator);
      static const char message[] = "Iterator result is not an object";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      iterator = NULL;
    }
  }
  scr_dyn_release(method);
  if (!iterator) return NULL;
  ScrDyn *next = scr_iterator_member(iterator, "next", 4);
  if (!next) {
    scr_dyn_release(iterator);
    return NULL;
  }
  *next_out = next;
  return iterator;
}

/* Calls a stage callback with (value, counter); +1 result or NULL. */
static ScrDyn *scr_ih_callback(ScrDyn *fn, ScrDyn *value, double counter) {
  ScrDyn *index = scr_dyn_new_num(counter);
  ScrDyn *args[2] = { value, index };
  ScrDyn *undefined = scr_dyn_retain(scr_dyn_undefined());
  scr_dyn_this_push_dyn(undefined);
  ScrDyn *result = scr_dyn_call(fn, args, 2, "callback");
  scr_dyn_this_pop();
  scr_dyn_release(undefined);
  scr_dyn_release(index);
  return result;
}

/* The helper's next value: +1 value with *done false, *done true, or NULL
 * with the exception pending (the helper is then done). */
static ScrDyn *scr_ih_advance(ScrIterHelper *h, bool *done) {
  *done = false;
  for (;;) {
    if (h->kind == SCR_IH_FLATMAP && h->inner) {
      bool inner_done;
      ScrDyn *value = scr_ih_step(h->inner, h->inner_next, &inner_done);
      if (!value) {
        scr_ih_close(h->iterated, true);
        return NULL;
      }
      if (!inner_done) return value;
      scr_dyn_release(value);
      scr_ih_clear_inner(h);
      continue;
    }
    if (h->kind == SCR_IH_TAKE) {
      if (h->remaining == 0) {
        *done = true;
        if (!scr_ih_close(h->iterated, false)) return NULL;
        return scr_dyn_retain(scr_dyn_undefined());
      }
      if (h->remaining != INFINITY) h->remaining--;
    }
    if (h->kind == SCR_IH_DROP) {
      while (h->remaining > 0) {
        if (h->remaining != INFINITY) h->remaining--;
        bool skipped_done;
        ScrDyn *skipped = scr_ih_step(h->iterated, h->next, &skipped_done);
        if (!skipped) return NULL;
        scr_dyn_release(skipped);
        if (skipped_done) {
          *done = true;
          return scr_dyn_retain(scr_dyn_undefined());
        }
      }
    }
    bool source_done;
    ScrDyn *value = scr_ih_step(h->iterated, h->next, &source_done);
    if (!value) return NULL;
    if (source_done) {
      *done = true;
      return value;
    }
    if (h->kind == SCR_IH_TAKE || h->kind == SCR_IH_DROP) return value;
    ScrDyn *mapped = scr_ih_callback(h->fn, value, h->counter);
    if (!mapped) {
      scr_dyn_release(value);
      scr_ih_close(h->iterated, true);
      return NULL;
    }
    h->counter++;
    if (h->kind == SCR_IH_MAP) {
      scr_dyn_release(value);
      return mapped;
    }
    if (h->kind == SCR_IH_FILTER) {
      bool keep = scr_dyn_truthy(mapped);
      scr_dyn_release(mapped);
      if (keep) return value;
      scr_dyn_release(value);
      continue;
    }
    /* flatMap */
    scr_dyn_release(value);
    ScrDyn *inner_next = NULL;
    ScrDyn *inner = scr_ih_flattenable(mapped, &inner_next);
    scr_dyn_release(mapped);
    if (!inner) {
      scr_ih_close(h->iterated, true);
      return NULL;
    }
    h->inner = inner;
    h->inner_next = inner_next;
  }
}

static void scr_ih_running_error(void) {
  static const char message[] = "Generator is already running";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
}

static ScrDyn *scr_ih_next(ScrIterHelper *h) {
  if (h->state == SCR_IH_RUNNING) {
    scr_ih_running_error();
    return NULL;
  }
  if (h->state == SCR_IH_DONE) return scr_ih_result(scr_dyn_retain(scr_dyn_undefined()), true);
  h->state = SCR_IH_RUNNING;
  scr_ih_retain(h);
  bool done;
  ScrDyn *value = scr_ih_advance(h, &done);
  ScrDyn *result = NULL;
  if (!value || done) {
    h->state = SCR_IH_DONE;
    scr_ih_clear_inner(h);
    if (value) {
      scr_dyn_release(value);
      result = scr_ih_result(scr_dyn_retain(scr_dyn_undefined()), true);
    }
  } else {
    h->state = SCR_IH_YIELDED;
    result = scr_ih_result(value, false);
  }
  scr_ih_release(h);
  return result;
}

/* %IteratorHelperPrototype%.return: an unstarted or suspended helper
 * completes and closes the iterator it was made from (flatMap closes its
 * inner iterator first). */
static ScrDyn *scr_ih_return(ScrIterHelper *h) {
  if (h->state == SCR_IH_RUNNING) {
    scr_ih_running_error();
    return NULL;
  }
  if (h->state != SCR_IH_DONE) {
    h->state = SCR_IH_DONE;
    scr_ih_retain(h);
    bool ok = true;
    if (h->inner) {
      ScrDyn *inner = scr_dyn_retain(h->inner);
      scr_ih_clear_inner(h);
      if (!scr_ih_close(inner, false)) {
        scr_ih_close(h->iterated, true);
        ok = false;
      }
      scr_dyn_release(inner);
    }
    if (ok) ok = scr_ih_close(h->iterated, false);
    scr_ih_release(h);
    if (!ok) return NULL;
  }
  return scr_ih_result(scr_dyn_retain(scr_dyn_undefined()), true);
}

static ScrDyn *scr_iterator_helper_method(ScrDyn *self, int index, ScrDyn *const *args, size_t argc);

static ScrDyn *scr_ih_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what) {
  if (!strcmp(method, "next")) return scr_ih_next(ptr);
  if (!strcmp(method, "return")) return scr_ih_return(ptr);
  int index = scr_ih_method_index(method, strlen(method));
  if (index >= 0) return scr_iterator_helper_method(self, index, args, argc);
  return scr_dyn_call(scr_dyn_undefined(), args, argc, what);
}

static ScrDyn *scr_ih_method_function(int index);

static ScrDyn *scr_ih_next_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_ITERATOR_HELPER) {
    result = scr_ih_next(self->v.handle.ptr);
  } else {
    static const char message[] = "Method Iterator Helper.prototype.next called on incompatible receiver";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_ih_return_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_ITERATOR_HELPER) {
    result = scr_ih_return(self->v.handle.ptr);
  } else {
    static const char message[] = "Method Iterator Helper.prototype.return called on incompatible receiver";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  }
  scr_dyn_release(self);
  return result;
}

static SCR_TL ScrDyn *scr_ih_functions[SCR_IH_METHOD_COUNT + 2];
static SCR_TL bool scr_ih_functions_registered;

static void scr_ih_functions_cleanup(void) {
  for (size_t i = 0; i < SCR_IH_METHOD_COUNT + 2; i++) {
    scr_dyn_release(scr_ih_functions[i]);
    scr_ih_functions[i] = NULL;
  }
}

static ScrDyn *scr_ih_function(size_t slot, ScrDynThunk thunk, const char *name) {
  if (!scr_ih_functions_registered) {
    scr_ih_functions_registered = true;
    scr_atexit(scr_ih_functions_cleanup);
  }
  if (!scr_ih_functions[slot])
    scr_ih_functions[slot] = scr_dyn_new_func(scr_closure_new(NULL, 0), thunk, 0, "native:iterator", name);
  return scr_dyn_retain(scr_ih_functions[slot]);
}

static ScrDyn *scr_ih_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  if (len == 4 && !memcmp(key, "next", 4)) return scr_ih_function(SCR_IH_METHOD_COUNT, &scr_ih_next_call, "next");
  if (len == 6 && !memcmp(key, "return", 6))
    return scr_ih_function(SCR_IH_METHOD_COUNT + 1, &scr_ih_return_call, "return");
  int index = scr_ih_method_index(key, len);
  return index >= 0 ? scr_ih_method_function(index) : NULL;
}

static ScrDyn *scr_ih_inspect_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

static ScrDyn *scr_ih_new(unsigned kind, ScrDyn *iterated, ScrDyn *next, ScrDyn *fn, double remaining) {
  static const ScrDynHandleOps ops = {
    .cls = "Object",
    .retain = &scr_ih_retain,
    .release = &scr_ih_release,
    .invoke = &scr_ih_invoke,
    .get = &scr_ih_get,
    .inspect_view = &scr_ih_inspect_view,
    .to_string_tag = "Iterator Helper",
    .inspect_view_empty = true,
  };
  scr_dyn_handle_install(SCR_DYNH_ITERATOR_HELPER, &ops);
  ScrIterHelper *h = malloc(sizeof *h);
  if (!h) scr_json_oom();
  *h = (ScrIterHelper){ .rc = 1, .kind = kind, .state = SCR_IH_START, .iterated = scr_dyn_retain(iterated),
    .next = next, .fn = fn ? scr_dyn_retain(fn) : NULL, .remaining = remaining };
  ScrDyn *result = scr_dyn_new_handle(h, SCR_DYNH_ITERATOR_HELPER);
  scr_ih_release(h);
  return result;
}

/* The consuming methods: drive (self, next) with `fn`. */
static ScrDyn *scr_ih_consume(ScrDyn *self, ScrDyn *next, int index, ScrDyn *fn, ScrDyn *const *args,
                              size_t argc) {
  const char *name = scr_ih_method_names[index];
  bool reduce = !strcmp(name, "reduce");
  ScrDyn *out = !strcmp(name, "toArray") ? scr_dyn_new_arr() : NULL;
  ScrDyn *acc = NULL;
  double counter = 0;
  if (reduce && argc >= 2) acc = scr_dyn_retain(args[1]);
  else if (reduce) {
    bool done;
    ScrDyn *first = scr_ih_step(self, next, &done);
    if (!first) return NULL;
    if (done) {
      scr_dyn_release(first);
      static const char message[] = "Reduce of a done iterator with no initial value";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    acc = first;
    counter = 1;
  }
  for (;;) {
    bool done;
    ScrDyn *value = scr_ih_step(self, next, &done);
    if (!value) {
      if (out) scr_dyn_release(out);
      if (acc) scr_dyn_release(acc);
      return NULL;
    }
    if (done) {
      scr_dyn_release(value);
      break;
    }
    if (out) {
      scr_dyn_arr_push(out, value);
      continue;
    }
    ScrDyn *answer;
    if (reduce) {
      ScrDyn *index_value = scr_dyn_new_num(counter);
      ScrDyn *call_args[3] = { acc, value, index_value };
      ScrDyn *undefined = scr_dyn_retain(scr_dyn_undefined());
      scr_dyn_this_push_dyn(undefined);
      answer = scr_dyn_call(fn, call_args, 3, "callback");
      scr_dyn_this_pop();
      scr_dyn_release(undefined);
      scr_dyn_release(index_value);
    } else {
      answer = scr_ih_callback(fn, value, counter);
    }
    counter++;
    if (!answer) {
      scr_dyn_release(value);
      if (acc) scr_dyn_release(acc);
      scr_ih_close(self, true);
      return NULL;
    }
    if (reduce) {
      scr_dyn_release(acc);
      acc = answer;
      scr_dyn_release(value);
      continue;
    }
    bool truthy = scr_dyn_truthy(answer);
    scr_dyn_release(answer);
    if (!strcmp(name, "forEach")) {
      scr_dyn_release(value);
      continue;
    }
    bool stop = !strcmp(name, "every") ? !truthy : truthy;
    if (!stop) {
      scr_dyn_release(value);
      continue;
    }
    if (!scr_ih_close(self, false)) {
      scr_dyn_release(value);
      return NULL;
    }
    if (!strcmp(name, "find")) return value;
    scr_dyn_release(value);
    return scr_dyn_new_bool(!strcmp(name, "some"));
  }
  if (out) return out;
  if (reduce) return acc;
  if (!strcmp(name, "some") || !strcmp(name, "every")) return scr_dyn_new_bool(!strcmp(name, "every"));
  return scr_dyn_retain(scr_dyn_undefined());
}

/* An Iterator.prototype helper method called on `self` (borrowed). */
static ScrDyn *scr_iterator_helper_method(ScrDyn *self, int index, ScrDyn *const *args, size_t argc) {
  const char *name = scr_ih_method_names[index];
  ScrDyn *next = scr_ih_direct(self, name);
  if (!next) return NULL;
  ScrDyn *arg = argc > 0 ? args[0] : scr_dyn_undefined();
  if (!strcmp(name, "take") || !strcmp(name, "drop")) {
    double budget;
    if (!scr_ih_budget(arg, &budget)) {
      scr_dyn_release(next);
      scr_ih_close(self, true);
      return NULL;
    }
    return scr_ih_new(!strcmp(name, "take") ? SCR_IH_TAKE : SCR_IH_DROP, self, next, NULL, budget);
  }
  if (!strcmp(name, "toArray")) {
    ScrDyn *result = scr_ih_consume(self, next, index, NULL, args, argc);
    scr_dyn_release(next);
    return result;
  }
  if (!scr_ih_require_callable(arg)) {
    scr_dyn_release(next);
    scr_ih_close(self, true);
    return NULL;
  }
  if (index < 5) {
    unsigned kind = !strcmp(name, "map") ? SCR_IH_MAP : !strcmp(name, "filter") ? SCR_IH_FILTER : SCR_IH_FLATMAP;
    return scr_ih_new(kind, self, next, arg, 0);
  }
  ScrDyn *result = scr_ih_consume(self, next, index, arg, args, argc);
  scr_dyn_release(next);
  return result;
}

static ScrDyn *scr_ih_method_call(int index, ScrDyn *const *args, size_t argc) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = scr_iterator_helper_method(self, index, args, argc);
  scr_dyn_release(self);
  return result;
}

#define SCR_IH_THUNK(i)                                                                     \
  static ScrDyn *scr_ih_method_call_##i(ScrClosure *clo, ScrDyn *const *args, size_t argc) { \
    (void)clo;                                                                              \
    return scr_ih_method_call(i, args, argc);                                               \
  }
SCR_IH_THUNK(0)
SCR_IH_THUNK(1)
SCR_IH_THUNK(2)
SCR_IH_THUNK(3)
SCR_IH_THUNK(4)
SCR_IH_THUNK(5)
SCR_IH_THUNK(6)
SCR_IH_THUNK(7)
SCR_IH_THUNK(8)
SCR_IH_THUNK(9)
SCR_IH_THUNK(10)

static ScrDyn *scr_ih_method_function(int index) {
  static const ScrDynThunk thunks[SCR_IH_METHOD_COUNT] = {
    &scr_ih_method_call_0, &scr_ih_method_call_1, &scr_ih_method_call_2, &scr_ih_method_call_3,
    &scr_ih_method_call_4, &scr_ih_method_call_5, &scr_ih_method_call_6, &scr_ih_method_call_7,
    &scr_ih_method_call_8, &scr_ih_method_call_9, &scr_ih_method_call_10,
  };
  return scr_ih_function((size_t)index, thunks[index], scr_ih_method_names[index]);
}

ScrDyn *scr_dyn_native_handle_iterator(ScrDyn *source, unsigned selection) {
  return scr_native_collection_iterator(source, selection);
}

/* The values a native iterator (or a live-stepping handle's entries
 * iterator) produces from its current position, into a fresh array; NULL
 * with the exception pending. */
static ScrDyn *scr_native_iterator_drain(const ScrDyn *src) {
  ScrDyn *iterator = src->v.handle.tag == SCR_DYNH_ITERATOR
                         ? scr_dyn_retain((ScrDyn *)src)
                         : scr_dyn_native_handle_iterator((ScrDyn *)src, 2);
  ScrDyn *out = scr_dyn_new_arr();
  for (;;) {
    ScrDyn *step = scr_native_iterator_next(iterator->v.handle.ptr);
    if (!step) {
      scr_dyn_release(out);
      out = NULL;
      break;
    }
    bool done = scr_dyn_truthy(scr_dyn_obj_get(step, "done", 4));
    if (!done) {
      const ScrDyn *value = scr_dyn_obj_get(step, "value", 5);
      scr_dyn_arr_push(out, scr_dyn_retain((ScrDyn *)(value ? value : scr_dyn_undefined())));
    }
    scr_dyn_release(step);
    if (done) break;
  }
  scr_dyn_release(iterator);
  return out;
}

static ScrDyn *scr_builtin_iterator_checked(int kind) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind == kind || (kind == SCR_DYN_ARR && self->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(self)))
    result = scr_native_iterator_new(self);
  else {
    static const char message[] = "Borrowing this native iterator factory has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_builtin_array_iterator_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_builtin_iterator_checked(SCR_DYN_ARR);
}

static ScrDyn *scr_builtin_bytes_iterator_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_builtin_iterator_checked(SCR_DYN_BYTES);
}

static ScrDyn *scr_builtin_string_iterator_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_builtin_iterator_checked(SCR_DYN_STR);
}

static ScrDyn *scr_iterator_self_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_dyn_this_get();
}

static ScrDyn *scr_handle_iterator_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  if (self->kind == SCR_DYN_HANDLE && (self->v.handle.tag == SCR_DYNH_MAP || self->v.handle.tag == SCR_DYNH_SET || scr_dyn_handle_ops_of(self)->iter_step)) {
    ScrDyn *result = scr_native_iterator_new(self);
    scr_dyn_release(self);
    return result;
  }
  ScrDyn *items = scr_dyn_iter_pack(self, NULL);
  ScrDyn *result = items ? scr_native_iterator_new(items) : NULL;
  scr_dyn_release(items);
  scr_dyn_release(self);
  return result;
}

ScrDyn *scr_dyn_array_values_function(void) {
  return scr_iterator_function(1, &scr_builtin_array_iterator_call, "values");
}

static ScrDyn *scr_builtin_iterator_method(const ScrDyn *value) {
  if (scr_dyn_generator(value)) return scr_iterator_function(4, &scr_iterator_self_call, "[Symbol.iterator]");
  if (value->kind == SCR_DYN_ARR || (value->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(value))) return scr_dyn_array_values_function();
  if (value->kind == SCR_DYN_BYTES) return scr_iterator_function(2, &scr_builtin_bytes_iterator_call, "values");
  if (value->kind == SCR_DYN_STR) return scr_iterator_function(3, &scr_builtin_string_iterator_call, "[Symbol.iterator]");
  if (value->kind == SCR_DYN_HANDLE && (value->v.handle.tag == SCR_DYNH_MAP || value->v.handle.tag == SCR_DYNH_SET || scr_dyn_handle_ops_of(value)->iter_pack || scr_dyn_handle_ops_of(value)->iter_step))
    return scr_iterator_function(6, &scr_handle_iterator_call, "[Symbol.iterator]");
  return scr_iterator_function(4, &scr_iterator_self_call, "[Symbol.iterator]");
}

static ScrDyn *scr_iterator_call(const ScrDyn *method, const ScrDyn *receiver, const char *name) {
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(method, NULL, 0, name);
  scr_dyn_this_pop();
  return result;
}

static ScrDyn *scr_iterator_method(const ScrDyn *source) {
  if (source->kind == SCR_DYN_NULL || source->kind == SCR_DYN_UNDEF) {
    const char *message = source->kind == SCR_DYN_NULL
      ? "object null is not iterable (cannot read property Symbol(Symbol.iterator))"
      : "undefined is not iterable (cannot read property Symbol(Symbol.iterator))";
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return NULL;
  }
  if (scr_iterator_symbol) return scr_dyn_symbol_key_get(source, scr_iterator_symbol, false);
  return scr_builtin_iterable(source) ? scr_builtin_iterator_method(source) : scr_dyn_retain(scr_dyn_undefined());
}

int scr_dyn_iterable_kind(const ScrDyn *value) {
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) return 0;
  if (scr_dyn_generator(value)) return value->v.typed_ref.type_key[0] == 'a' ? 2 : 1;
  if (scr_async_iterator_symbol) {
    ScrDyn *method = scr_dyn_symbol_key_get(value, scr_async_iterator_symbol, false);
    if (!method) return -1;
    bool set = method->kind != SCR_DYN_UNDEF && method->kind != SCR_DYN_NULL;
    scr_dyn_release(method);
    if (set) return 2;
  }
  ScrDyn *method = scr_iterator_method(value);
  if (!method) return -1;
  bool set = method->kind != SCR_DYN_UNDEF && method->kind != SCR_DYN_NULL;
  scr_dyn_release(method);
  return set ? 1 : 0;
}

ScrDyn *scr_dyn_from_iterator(const ScrDyn *value, int *kind) {
  return scr_dyn_open_iterator(value, kind, false);
}

ScrDyn *scr_dyn_open_iterator(const ScrDyn *value, int *kind, bool generators) {
  *kind = 0;
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) return NULL;
  ScrDyn *method = NULL;
  if (scr_async_iterator_symbol) {
    method = scr_dyn_symbol_key_get(value, scr_async_iterator_symbol, false);
    if (!method) {
      *kind = -1;
      return NULL;
    }
    if (method->kind != SCR_DYN_UNDEF && method->kind != SCR_DYN_NULL) {
      *kind = 2;
    } else {
      scr_dyn_release(method);
      method = NULL;
    }
  }
  if (!method) {
    method = scr_iterator_method(value);
    if (!method) {
      *kind = -1;
      return NULL;
    }
    if (method->kind == SCR_DYN_UNDEF || method->kind == SCR_DYN_NULL) {
      scr_dyn_release(method);
      return NULL;
    }
    *kind = 1;
  }
  ScrDyn *iterator = scr_iterator_call(
      method, value, *kind == 2 ? "iterable[SymbolAsyncIterator]" : "iterable[SymbolIterator]");
  scr_dyn_release(method);
  if (iterator && !generators && scr_dyn_generator(iterator)) {
    /* a compiled generator is stepped through typed helpers only */
    scr_dyn_release(iterator);
    iterator = NULL;
    static const char msg[] =
        "Readable.from over an object whose iterator method is a generator method is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  }
  if (!iterator) *kind = -1;
  return iterator;
}

ScrDyn *scr_dyn_iterator_result_get(const ScrDyn *result, const char *key, size_t len) {
  return scr_iterator_read(result, key, len);
}

/* Compiled class methods are dispatched before this checked-object path. */
ScrDyn *scr_dyn_iterator_optional(const ScrDyn *source) {
  ScrDyn *method = scr_iterator_method(source);
  if (!method) return NULL;
  if (method->kind == SCR_DYN_UNDEF || method->kind == SCR_DYN_NULL) {
    scr_dyn_release(method);
    return NULL;
  }
  ScrDyn *iterator = scr_iterator_call(method, source, "value[Symbol.iterator]");
  scr_dyn_release(method);
  if (!iterator) return NULL;
  ScrDyn *checked = scr_dyn_iterator_result(iterator);
  scr_dyn_release(iterator);
  return checked;
}

ScrDyn *scr_dyn_iterator(const ScrDyn *source, const ScrStr *spell) {

  if (source->kind == SCR_DYN_NULL || source->kind == SCR_DYN_UNDEF) return scr_dyn_not_iterable(source, spell);
  ScrDyn *method = scr_iterator_method(source);
  if (!method) return NULL;
  if (method->kind != SCR_DYN_FUNC) {
    scr_dyn_release(method);
    return scr_dyn_not_iterable(source, spell);
  }
  ScrDyn *iterator = scr_iterator_call(method, source, "value[Symbol.iterator]");
  scr_dyn_release(method);
  if (!iterator) return NULL;
  ScrDyn *checked = scr_dyn_iterator_result(iterator);
  scr_dyn_release(iterator);
  return checked;
}

static ScrDyn *scr_iterator_read(const ScrDyn *value, const char *key, size_t len) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    if (!view) return NULL;
    ScrDyn *result = scr_iterator_read(view, key, len);
    scr_dyn_release(view);
    return result;
  }
  if (value->kind == SCR_DYN_PROXY) return scr_dyn_obj_read(value, key, len);
  if (value->kind == SCR_DYN_HANDLE) {
    ScrStr *name = scr_str_new(key, len);
    ScrDyn *result = scr_dyn_handle_key_get(value, name);
    scr_str_release(name);
    return result;
  }
  if (value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR) return scr_dyn_obj_read(value, key, len);
  if (value->kind == SCR_DYN_FUNC) {
    ScrDyn *result = scr_dyn_fn_get(value, key, len);
    return result ? result : scr_dyn_retain(scr_dyn_undefined());
  }
  static const char message[] = "Reading this native iterator result has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

ScrDyn *scr_dyn_array_from_iterator(const ScrDyn *source) {

  ScrDyn *method = scr_iterator_method(source);
  if (!method) return NULL;
  bool iterable = method->kind != SCR_DYN_UNDEF && method->kind != SCR_DYN_NULL;
  ScrDyn *out = scr_dyn_new_arr();
  if (!iterable) {
    scr_dyn_release(method);
    if (!scr_iterator_object(source)) {
      ScrDyn *iterator = scr_native_iterator_new(out);
      scr_dyn_release(out);
      return iterator;
    }
    ScrDyn *length = scr_iterator_read(source, "length", 6);
    if (!length) { scr_dyn_release(out); return NULL; }
    double n;
    bool numeric = scr_dyn_number_coerce_js(length, &n);
    scr_dyn_release(length);
    if (numeric && n >= 4294967296.0) {
      scr_throw_error_msg(SCR_ERR_RANGE, "Invalid array length", 20);
      numeric = false;
    }
    if (!numeric) { scr_dyn_release(out); return NULL; }
    ScrDyn *iterator = scr_native_iterator_new((ScrDyn *)source);
    ScrNativeIterator *state = iterator->v.handle.ptr;
    state->array_like = true;
    state->limit = isnan(n) || n < 0 ? 0 : floor(n);
    scr_dyn_release(out);
    return iterator;
  }
  scr_dyn_release(out);
  ScrDyn *iterator = scr_iterator_call(method, source, "value[Symbol.iterator]");
  scr_dyn_release(method);
  if (!iterator) return NULL;
  ScrDyn *checked = scr_dyn_iterator_result(iterator);
  scr_dyn_release(iterator);
  return checked;
}

ScrDyn *scr_dyn_symbol_key_get(const ScrDyn *value, const ScrDyn *key, bool optional) {
  if (scr_dyn_generator(value)) return scr_dyn_generator_symbol(value, key)
    ? scr_iterator_function(4, &scr_iterator_self_call, "[Symbol.iterator]") : scr_dyn_retain(scr_dyn_undefined());
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    ScrDyn *result = scr_exc_pending() ? NULL : scr_dyn_symbol_key_get(view, key, optional);
    scr_dyn_release(view);
    return result;
  }
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) {
    if (optional) return scr_dyn_retain(scr_dyn_undefined());
    ScrStr *name = key->v.symbol.render(key->v.symbol.value);
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, value->kind == SCR_DYN_NULL ? "Cannot read properties of null (reading '" : "Cannot read properties of undefined (reading '");
    scr_jb_write(&message, name->data, name->len);
    scr_jb_puts(&message, "')");
    scr_str_release(name);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return NULL;
  }
  bool builtin = scr_iterator_symbol && key->v.symbol.value == scr_iterator_symbol->v.symbol.value && scr_builtin_iterable(value);
  if (builtin && value->kind != SCR_DYN_ARR) return scr_builtin_iterator_method(value);
  if (value->kind == SCR_DYN_HANDLE) {
    const ScrDynHandleOps *ops = scr_dyn_handle_ops(value->v.handle.tag);
    ScrDyn *member = ops->symbol_get ? ops->symbol_get(value->v.handle.ptr, key) : NULL;
    if (member || scr_exc_pending()) return member;
  }
  ScrDyn *receiver = scr_dyn_symbol_receiver(value);
  if (!receiver) return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  ScrDynEntry *entry = scr_dyn_symbol_entry(receiver, key, false);
  ScrDyn *out;
  if (!entry) out = scr_dyn_retain(scr_dyn_undefined());
  else if (!entry->accessor) out = scr_dyn_retain(entry->value);
  else if (!entry->getter) out = scr_dyn_retain(scr_dyn_undefined());
  else {
    ScrDyn *getter = scr_dyn_retain(entry->getter);
    scr_dyn_this_push_dyn(value);
    out = scr_dyn_call(getter, NULL, 0, "symbol getter");
    scr_dyn_this_pop();
    scr_dyn_release(getter);
  }
  scr_dyn_release(receiver);
  return out;
}

/* Native field tables retain presence and attributes without owning a second
 * copy of the field's value. This internal update bypasses writable flags. */
void scr_dyn_symbol_key_placeholder(ScrDyn *value, ScrDyn *key) {
  ScrDynEntry *entry = scr_dyn_symbol_entry(value, key, true);
  if (!entry || entry->accessor) return;
  scr_dyn_release(entry->value);
  entry->value = scr_dyn_retain(scr_dyn_undefined());
}

void scr_dyn_symbol_key_set(ScrDyn *value, ScrDyn *key, ScrDyn *stored) {
  if (scr_dyn_error_prototype_fence(value)) return;
  ScrDyn *receiver = scr_dyn_symbol_receiver(value);
  if (!receiver) {
    if (!scr_exc_pending()) {
      static const char message[] = "Cannot assign a symbol property to a primitive value";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    }
    return;
  }
  ScrDynEntry *prior = scr_dyn_symbol_entry(receiver, key, false);
  if (prior && prior->accessor && prior->setter) {
    ScrDyn *setter = scr_dyn_retain(prior->setter);
    ScrDyn *arguments[] = {stored};
    scr_dyn_this_push_dyn(value);
    ScrDyn *result = scr_dyn_call(setter, arguments, 1, "symbol setter");
    scr_dyn_this_pop();
    scr_dyn_release(result);
    scr_dyn_release(setter);
  } else if (prior && (prior->accessor || !prior->writable)) {
    static const char message[] = "Cannot assign to a read only symbol property";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  } else {
    bool present = scr_dyn_symbol_entry(receiver, key, true) != NULL;
    scr_dyn_symbol_table(receiver);
    ScrStr *name = scr_dyn_symbol_storage_key(key);
    scr_dyn_key_set(receiver->symbol_properties, name, stored);
    if (!scr_exc_pending() && !present) scr_dyn_arr_push(receiver->symbol_keys, scr_dyn_retain(key));
    scr_str_release(name);
  }
  scr_dyn_release(receiver);
}

static ScrDyn *scr_dyn_define_symbol(ScrDyn *target, ScrDyn *key, ScrDyn *descriptor) {
  ScrDyn *receiver = scr_dyn_symbol_receiver(target);
  if (!receiver) {
    if (!scr_exc_pending()) {
      static const char message[] = "Object.defineProperty called on non-object";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    }
    return NULL;
  }
  bool present = scr_dyn_symbol_entry(receiver, key, true) != NULL;
  scr_dyn_symbol_table(receiver);
  ScrStr *name = scr_dyn_symbol_storage_key(key);
  ScrDyn *encoded = scr_dyn_new_str(name);
  ScrDyn *defined = scr_dyn_define_property(receiver->symbol_properties, encoded, descriptor);
  if (defined && !present) scr_dyn_arr_push(receiver->symbol_keys, scr_dyn_retain(key));
  scr_dyn_release(defined);
  scr_dyn_release(encoded);
  scr_str_release(name);
  scr_dyn_release(receiver);
  return scr_exc_pending() ? NULL : scr_dyn_retain(target);
}

static bool scr_dyn_key_probe_computed(const ScrDyn *value, const ScrDyn *raw_key, int mode) {
  ScrDyn *key = scr_dyn_property_key_value(raw_key);
  if (!key) return false;
  if (key->kind != SCR_DYN_SYMBOL) {
    bool out = mode == 0 ? scr_dyn_in(value, key->v.str)
      : mode == 1 ? scr_dyn_has_own(value, key->v.str) : scr_dyn_property_is_enumerable(value, key->v.str);
    scr_dyn_release(key);
    return out;
  }
  if (scr_dyn_generator(value)) {
    bool found = mode == 0 && scr_dyn_generator_symbol(value, key);
    scr_dyn_release(key);
    return found;
  }
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    bool out = !scr_exc_pending() && scr_dyn_key_probe_computed(view, key, mode);
    scr_dyn_release(view);
    scr_dyn_release(key);
    return out;
  }
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF ||
      (mode == 0 && !scr_dyn_to_primitive_result_is_object(value))) {
    ScrStr *name = key->v.symbol.render(key->v.symbol.value);
    bool out = mode == 0 ? scr_dyn_has_key(value, name) : scr_dyn_has_own(value, name);
    scr_str_release(name);
    scr_dyn_release(key);
    return out;
  }
  if (scr_iterator_symbol && key->v.symbol.value == scr_iterator_symbol->v.symbol.value && scr_builtin_iterable(value)) {
    if (value->kind != SCR_DYN_ARR) {
      scr_dyn_release(key);
      return mode == 0;
    }
  }
  ScrDyn *receiver = scr_dyn_symbol_receiver(value);
  ScrDynEntry *entry = receiver ? scr_dyn_symbol_entry(receiver, key, mode != 0) : NULL;
  bool found = entry && (mode != 2 || entry->enumerable);
  scr_dyn_release(receiver);
  scr_dyn_release(key);
  return found;
}

bool scr_dyn_has_key_computed(const ScrDyn *value, const ScrDyn *key) { return scr_dyn_key_probe_computed(value, key, 0); }
bool scr_dyn_has_own_computed(const ScrDyn *value, const ScrDyn *key) { return scr_dyn_key_probe_computed(value, key, 1); }
bool scr_dyn_property_is_enumerable_computed(const ScrDyn *value, const ScrDyn *key) { return scr_dyn_key_probe_computed(value, key, 2); }

void scr_dyn_key_delete_computed(ScrDyn *value, const ScrDyn *raw_key, bool strict) {
  ScrDyn *key = scr_dyn_property_key_value(raw_key);
  if (!key) return;
  if (key->kind != SCR_DYN_SYMBOL) {
    scr_dyn_key_delete(value, key->v.str, strict);
    scr_dyn_release(key);
    return;
  }
  ScrDyn *receiver = scr_dyn_symbol_receiver(value);
  if (!receiver && !scr_exc_pending() && (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF)) {
    ScrStr *name = key->v.symbol.render(key->v.symbol.value);
    scr_dyn_key_delete(value, name, strict);
    scr_str_release(name);
  }
  if (receiver && receiver->symbol_properties) {
    ScrStr *name = scr_dyn_symbol_storage_key(key);
    scr_dyn_key_delete(receiver->symbol_properties, name, strict);
    if (!scr_exc_pending() && !scr_dyn_entry(receiver->symbol_properties, name)) {
      for (size_t i = 0; i < receiver->symbol_keys->v.arr.len; i++) {
        if (!scr_dyn_strict_eq(receiver->symbol_keys->v.arr.items[i], key)) continue;
        scr_dyn_release(receiver->symbol_keys->v.arr.items[i]);
        size_t remaining = --receiver->symbol_keys->v.arr.len - i;
        memmove(&receiver->symbol_keys->v.arr.items[i], &receiver->symbol_keys->v.arr.items[i + 1], remaining * sizeof(ScrDyn *));
        break;
      }
    }
    scr_str_release(name);
  }
  scr_dyn_release(receiver);
  scr_dyn_release(key);
}

/* Native call/apply/bind lowering still owns these prototype operations.
 * Refuse overrides until every typed call site observes the property table. */
static bool scr_dyn_fn_property_fence(const ScrStr *key) {
  static const char *const reserved[] = {
    "call", "apply", "bind", "valueOf", "toLocaleString",
    "hasOwnProperty", "propertyIsEnumerable", "isPrototypeOf",
    "constructor", "caller", "arguments", "__proto__",
  };
  for (size_t i = 0; i < sizeof reserved / sizeof reserved[0]; i++) {
    if (key->len != strlen(reserved[i]) || memcmp(key->data, reserved[i], key->len) != 0) continue;
    static const char message[] = "scriptc: overriding builtin function properties is not supported";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return true;
  }
  return false;
}

ScrDyn *scr_dyn_define_property(ScrDyn *target, ScrDyn *key, ScrDyn *descriptor) {
  if (scr_dyn_error_prototype_fence(target)) return NULL;
  if (target->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(target) &&
      (key->kind == SCR_DYN_STR || key->kind == SCR_DYN_NUM)) {
    /* A native array's numeric properties ("-1", "1.5") live in its
     * property table, which holds values without attributes. A number key
     * names one unless it is an array index. */
    double number = key->kind == SCR_DYN_NUM ? key->v.num : 0;
    bool numeric = key->kind == SCR_DYN_NUM
                       ? !(number >= 0 && number < 4294967295.0 && number == trunc(number))
                       : scr_arr_numeric_key(key->v.str->data, key->v.str->len, &number);
    if (numeric) {
      static const char message[] = "Object.defineProperty on a numeric property of a native array is not supported yet";
      scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
      return NULL;
    }
  }
  if (target->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(target);
    ScrDyn *defined = scr_exc_pending() ? NULL : scr_dyn_define_property(view, key, descriptor);
    if (!scr_exc_pending()) scr_dyn_typed_ref_commit(target);
    scr_dyn_release(defined);
    scr_dyn_release(view);
    return scr_exc_pending() ? NULL : scr_dyn_retain(target);
  }
  if (descriptor->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(descriptor);
    ScrDyn *result = scr_exc_pending() ? NULL : scr_dyn_define_property(target, key, view);
    scr_dyn_release(view);
    return result;
  }
  if (key->kind == SCR_DYN_SYMBOL) return scr_dyn_define_symbol(target, key, descriptor);
  if (target->kind == SCR_DYN_PROXY || descriptor->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("Object.defineProperty");
    return NULL;
  }



  if (scr_exc_pending()) return NULL;
  /* Values, accessors and array property tables: any of them may close a
   * cycle, and definitions are rare enough to invalidate conservatively. */
  scr_dyn_region_store(target, NULL);
  if (target->kind == SCR_DYN_FUNC) {
    if (scr_dyn_class_reflection_fence(target)) return NULL;
    ScrStr *name = scr_dyn_property_key(key);
    if (!name) return NULL;
    if (scr_dyn_fn_property_fence(name)) { scr_str_release(name); return NULL; }
    ScrDyn *property = scr_dyn_new_str(name);
    scr_str_release(name);
    ScrDyn *table = scr_dyn_fn_properties(target);
    ScrDyn *defined = scr_dyn_define_property(table, property, descriptor);
    scr_dyn_release(property);
    scr_dyn_release(table);
    if (!defined) return NULL;
    scr_dyn_release(defined);
    return scr_dyn_retain(target);
  }
  if (target->kind == SCR_DYN_ARR) {
    ScrStr *name = scr_dyn_property_key(key);
    if (!name) return NULL;
    double index;
    bool special = name->len == 6 && memcmp(name->data, "length", 6) == 0;
    special = special || scr_dyn_key_is_index(name->data, name->len, &index);
    scr_str_release(name);
    if (special) {
      static const char message[] = "Object.defineProperty on an array index or length is not supported yet";
      scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
      return NULL;
    }
    if (!target->v.arr.properties) target->v.arr.properties = scr_dyn_new_obj();
    target->v.arr.properties->non_extensible = target->non_extensible;
    ScrDyn *defined = scr_dyn_define_property(target->v.arr.properties, key, descriptor);
    if (!defined) return NULL;
    scr_dyn_release(defined);
    return scr_dyn_retain(target);
  }
  if (target->kind != SCR_DYN_OBJ) {
    static const char msg[] = "Object.defineProperty called on non-object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  ScrStr *name = scr_dyn_property_key(key);
  if (!name) return NULL;
  if (descriptor->kind != SCR_DYN_OBJ) {
    scr_str_release(name);
    static const char msg[] = "Property description must be an object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  static const char *const names[] = {"enumerable", "configurable", "value", "writable", "get", "set"};
  static const size_t lengths[] = {10, 12, 5, 8, 3, 3};
  ScrDyn *fields[6] = {NULL};
  for (size_t i = 0; i < 6; i++) {
    if (!scr_dyn_obj_get(descriptor, names[i], lengths[i])) continue;
    fields[i] = scr_dyn_obj_read(descriptor, names[i], lengths[i]);
    if (!fields[i]) {
      scr_dyn_descriptor_fields_drop(fields);
      scr_str_release(name);
      return NULL;
    }
  }
  ScrDyn *e = fields[0], *c = fields[1], *value = fields[2];
  ScrDyn *w = fields[3], *get = fields[4], *set = fields[5];
  ScrDynEntry *prior = scr_dyn_entry(target, name);
  bool accessor_descriptor = get || set;
  bool data_descriptor = value || w;
  if (accessor_descriptor && data_descriptor) {
    scr_dyn_descriptor_fields_drop(fields);
    scr_str_release(name);
    static const char msg[] = "Invalid property descriptor. Cannot both specify accessors and a value or writable attribute";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  if ((get && get->kind != SCR_DYN_UNDEF && get->kind != SCR_DYN_FUNC) ||
      (set && set->kind != SCR_DYN_UNDEF && set->kind != SCR_DYN_FUNC)) {
    scr_dyn_descriptor_fields_drop(fields);
    scr_str_release(name);
    static const char msg[] = "Getter and setter must be functions";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  bool accessor = accessor_descriptor || (!data_descriptor && prior && prior->accessor);
  bool writable = w ? scr_dyn_truthy(w) : prior && !prior->accessor && !accessor ? prior->writable : false;
  bool enumerable = e ? scr_dyn_truthy(e) : prior ? prior->enumerable : false;
  bool configurable = c ? scr_dyn_truthy(c) : prior ? prior->configurable : false;
  if (!prior && target->non_extensible) {
    ScrJsonBuf buffer;
    scr_jb_init(&buffer);
    scr_jb_puts(&buffer, "Cannot define property ");
    scr_jb_write(&buffer, name->data, name->len);
    scr_jb_puts(&buffer, ", object is not extensible");
    scr_dyn_descriptor_fields_drop(fields);
    scr_str_release(name);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&buffer));
    return NULL;
  }
  if (prior && !prior->configurable &&
      (configurable || enumerable != prior->enumerable ||
       accessor != prior->accessor ||
       (accessor && ((get && !scr_dyn_property_same_value(get, prior->getter ? prior->getter : scr_dyn_undefined())) ||
                     (set && !scr_dyn_property_same_value(set, prior->setter ? prior->setter : scr_dyn_undefined())))) ||
       (!accessor && ((!prior->writable && writable) ||
                     (!prior->writable && value && !scr_dyn_property_same_value(prior->value, value)))))) {
    scr_dyn_descriptor_fields_drop(fields);
    ScrJsonBuf buffer;
    scr_jb_init(&buffer);
    scr_jb_puts(&buffer, "Cannot redefine property: ");
    scr_jb_write(&buffer, name->data, name->len);
    scr_str_release(name);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&buffer));
    return NULL;
  }
  if (prior) {
    if (accessor != prior->accessor) {
      ScrDyn *old_value = prior->value, *old_getter = prior->getter, *old_setter = prior->setter;
      prior->value = scr_dyn_retain(scr_dyn_undefined());
      prior->getter = prior->setter = NULL;
      scr_dyn_release(old_value);
      scr_dyn_release(old_getter);
      scr_dyn_release(old_setter);
    }
    if (value && !accessor) {
      ScrDyn *replacement = scr_dyn_retain(value);
      ScrDyn *old = prior->value;
      prior->value = replacement;
      scr_dyn_release(old);
    }
    if (get) {
      ScrDyn *replacement = get->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_retain(get);
      ScrDyn *old = prior->getter;
      prior->getter = replacement;
      scr_dyn_release(old);
    }
    if (set) {
      ScrDyn *replacement = set->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_retain(set);
      ScrDyn *old = prior->setter;
      prior->setter = replacement;
      scr_dyn_release(old);
    }
    prior->accessor = accessor;
    prior->writable = writable;
    prior->enumerable = enumerable;
    prior->configurable = configurable;
  } else {
    scr_dyn_obj_set(target, name->data, name->len, scr_dyn_retain(value ? value : scr_dyn_undefined()));
    ScrDynEntry *entry = scr_dyn_entry(target, name);
    entry->accessor = accessor;
    if (get && get->kind != SCR_DYN_UNDEF) entry->getter = scr_dyn_retain(get);
    if (set && set->kind != SCR_DYN_UNDEF) entry->setter = scr_dyn_retain(set);
    entry->writable = writable;
    entry->enumerable = enumerable;
    entry->configurable = configurable;
  }
  scr_dyn_descriptor_fields_drop(fields);
  scr_error_sync_cause(target, name);
  scr_str_release(name);
  return scr_dyn_retain(target);
}

ScrDyn *scr_dyn_get_own_property_descriptor(ScrDyn *target, ScrDyn *key) {
  if (key->kind == SCR_DYN_SYMBOL) {
    ScrDyn *receiver = scr_dyn_symbol_receiver(target);
    if (!receiver) {
      if (target->kind == SCR_DYN_NULL || target->kind == SCR_DYN_UNDEF) {
        static const char message[] = "Cannot convert undefined or null to object";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      }
      return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
    }
    ScrStr *name = scr_dyn_symbol_storage_key(key);
    ScrDyn *out = receiver->symbol_properties ? scr_dyn_own_descriptor(receiver->symbol_properties, name) : scr_dyn_retain(scr_dyn_undefined());
    scr_str_release(name);
    scr_dyn_release(receiver);
    return out;
  }


  if (scr_exc_pending()) return NULL;
  if (target->kind == SCR_DYN_NULL || target->kind == SCR_DYN_UNDEF) {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  if (target->kind != SCR_DYN_OBJ && target->kind != SCR_DYN_PROXY && target->kind != SCR_DYN_FUNC && target->kind != SCR_DYN_ARR && target->kind != SCR_DYN_STR && target->kind != SCR_DYN_BOOL && target->kind != SCR_DYN_NUM && target->kind != SCR_DYN_TYPED_REF) {
    static const char msg[] = "Object.getOwnPropertyDescriptor on this value is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return NULL;
  }
  ScrStr *name = scr_dyn_property_key(key);
  if (!name) return NULL;
  ScrDyn *out = scr_dyn_own_descriptor(target, name);
  scr_str_release(name);
  return out;
}

/* ToBoolean over a dyn value (`v || dflt`, `if (v)` on a dyn operand):
 * bool by value; number falsy exactly for 0, -0, and NaN; string falsy
 * exactly when empty; obj/arr/bytes/func always true; undefined and null
 * always false — JS-exact for every kind. Borrowed; never throws. */
bool scr_dyn_truthy(const ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_SYMBOL: return true;
  case SCR_DYN_BOOL: return d->v.b;
  case SCR_DYN_BIGINT: return scr_bigint_truthy(d->v.bigint);
  case SCR_DYN_NUM: return d->v.num == d->v.num && d->v.num != 0;
  case SCR_DYN_STR: return d->v.str->len != 0;
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_BYTES:
  case SCR_DYN_FUNC:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_TYPED_REF: return true;
  case SCR_DYN_PROXY: return true;

  default: return false; /* undefined, null */
  }
}

/* Bare `typeof v` on a dyn value: the dyn kind's JS answer (+1 string).
 * null answers "object" — JS's oldest wart, preserved. */
ScrStr *scr_dyn_typeof(const ScrDyn *d) {
  const char *s;
#ifdef SCR_NODE_ISLANDS
  if (scr_ni_is_handle(d)) return scr_ni_typeof((ScrDyn *)d);
#endif
  if (d->kind == SCR_DYN_PROXY) return scr_dyn_typeof(d->v.proxy.target);
  if (d->kind == SCR_DYN_TYPED_REF) {
    if ((d->v.typed_ref.type_key_len >= 7 &&
         memcmp(d->v.typed_ref.type_key, "object:", 7) == 0) ||
        scr_typed_ref_record_ops(d) || scr_dyn_typed_ref_array_ops(d))
      return scr_str_new("object", 6);
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
    ScrStr *out = scr_dyn_typeof(materialized);
    scr_dyn_release(materialized);
    return out;
  }


  switch (d->kind) {
  case SCR_DYN_UNDEF: s = "undefined"; break;
  case SCR_DYN_NULL:
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_PROXY:
  case SCR_DYN_TYPED_REF: s = "object"; break; /* handled above */
  case SCR_DYN_BOOL: s = "boolean"; break;
  case SCR_DYN_BIGINT: s = "bigint"; break;
  case SCR_DYN_SYMBOL: s = "symbol"; break;
  case SCR_DYN_NUM: s = "number"; break;
  case SCR_DYN_STR: s = "string"; break;
  case SCR_DYN_FUNC: s = "function"; break;
  default: s = "undefined"; break;
  }
  return scr_str_new(s, strlen(s));
}

bool scr_dyn_is_callable(const ScrDyn *value) {
  while (value->kind == SCR_DYN_PROXY) value = value->v.proxy.target;
#ifdef SCR_NODE_ISLANDS
  if (scr_ni_is_handle(value)) return scr_ni_is_function(value);
#endif
  return value->kind == SCR_DYN_FUNC || scr_dyn_ref_typeof_is(value, "function");
}

int scr_dyn_function_kind(const ScrDyn *value) {
  while (value->kind == SCR_DYN_PROXY) value = value->v.proxy.target;
  return value->kind == SCR_DYN_FUNC ? scr_closure_identity(value->v.fn.clo)->function_kind : 0;
}

void scr_dyn_adopt_identity(ScrClosure *adapter, const ScrDyn *value) {
  if (value->kind == SCR_DYN_FUNC && value->v.fn.class_obj == NULL)
    scr_closure_adopt_identity(adapter, value->v.fn.clo, value->v.fn.arity);
}

bool scr_dyn_is_object(const ScrDyn *d) {
  ScrStr *type = scr_dyn_typeof(d);
  bool object = type->len == 6 && memcmp(type->data, "object", 6) == 0;
  scr_str_release(type);
  return object;
}

void scr_dyn_throw(ScrDyn *d) {
  /* Only actual boxed Errors qualify: a user object's name or properties
   * cannot manufacture an Error instance. The cache preserves identity
   * when a caught native Error is boxed again. */
  ScrError *error = scr_errdyn_err_of(d);
  if (error) {
    scr_throw_obj(error, scr_error_retain_v, scr_error_release_v, scr_error_trace_arg());
    scr_dyn_release(d);
    return;
  }
  /* A checked-dynamic primitive throws as the primitive itself, as a
   * statically typed `throw 5` does: catch bindings test and extract the
   * same snapshot kinds (`typeof e === "number"`), and a primitive has no
   * identity to keep. */
  if (d->kind == SCR_DYN_NUM) {
    double value = d->v.num;
    scr_dyn_release(d);
    scr_throw_f64(value);
    return;
  }
  if (d->kind == SCR_DYN_BOOL) {
    bool value = d->v.b;
    scr_dyn_release(d);
    scr_throw_bool(value);
    return;
  }
  if (d->kind == SCR_DYN_STR) {
    ScrStr *value = scr_str_retain(d->v.str);
    scr_dyn_release(d);
    scr_throw_str(value);
    return;
  }
  scr_throw_ref_classified(d, scr_dyn_retain_v, scr_dyn_release_v,
                          scr_dyn_trace_v, scr_dyn_is_object(d));
}

ScrStr *scr_dyn_object_tag(const ScrDyn *d) {
  if (d->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("Symbol.toStringTag lookup");
    return NULL;
  }
  if (d->kind == SCR_DYN_TYPED_REF) {
    if (scr_dyn_ref_is_error(d)) return scr_str_new("[object Error]", 14);
    if (scr_dyn_generator(d)) {
      const char *gen_tag = scr_gen_tag_reader(d->v.typed_ref.ptr);
      if (gen_tag[0] == '!') {
        static const char message[] = "Object.prototype.toString of this iterator is not supported yet";
        scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
        return NULL;
      }
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "[object ");
      scr_jb_puts(&b, gen_tag);
      scr_jb_putc(&b, ']');
      return scr_jb_finish(&b);
    }
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
    ScrStr *out = scr_dyn_object_tag(materialized);
    scr_dyn_release(materialized);
    return out;
  }

  const char *tag;
  switch (d->kind) {
  case SCR_DYN_UNDEF: tag = "[object Undefined]"; break;
  case SCR_DYN_NULL: tag = "[object Null]"; break;
  case SCR_DYN_BOOL: tag = "[object Boolean]"; break;
  case SCR_DYN_BIGINT: tag = "[object BigInt]"; break;
  case SCR_DYN_SYMBOL: tag = "[object Symbol]"; break;
  case SCR_DYN_NUM: tag = "[object Number]"; break;
  case SCR_DYN_STR: tag = "[object String]"; break;
  case SCR_DYN_ARR: tag = "[object Array]"; break;
  case SCR_DYN_OBJ: tag = "[object Object]"; break;
  case SCR_DYN_HANDLE:
    if ((d->v.handle.tag >= SCR_DYNH_ABORT_SIGNAL &&
         d->v.handle.tag <= SCR_DYNH_ABORT_CONTROLLER) || d->v.handle.tag == SCR_DYNH_EVENT_TARGET ||
        d->v.handle.tag == SCR_DYNH_CUSTOM_EVENT || d->v.handle.tag == SCR_DYNH_ARRAY_BUFFER || d->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER ||
        d->v.handle.tag == SCR_DYNH_WEAK_MAP || d->v.handle.tag == SCR_DYNH_WEAK_SET ||
        d->v.handle.tag == SCR_DYNH_FINALIZATION_REGISTRY ||
        d->v.handle.tag == SCR_DYNH_SET || d->v.handle.tag == SCR_DYNH_MAP || d->v.handle.tag == SCR_DYNH_REGEXP ||
        d->v.handle.tag == SCR_DYNH_DATE || d->v.handle.tag == SCR_DYNH_BLOB ||
        d->v.handle.tag == SCR_DYNH_FILE || d->v.handle.tag == SCR_DYNH_DISPOSABLE_STACK) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "[object ");
      scr_jb_puts(&b, scr_dyn_handle_cls(d));
      scr_jb_putc(&b, ']');
      return scr_jb_finish(&b);
    }
    if (d->v.handle.tag == SCR_DYNH_ITERATOR && ((const ScrNativeIterator *)d->v.handle.ptr)->kind < 4) {
      static const char *const tags[] = {
        "[object Array Iterator]", "[object String Iterator]", "[object Map Iterator]", "[object Set Iterator]",
      };
      const char *it_tag = tags[((const ScrNativeIterator *)d->v.handle.ptr)->kind];
      return scr_str_new(it_tag, strlen(it_tag));
    }
    if (scr_dyn_handle_ops_of(d)->to_string_tag) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "[object ");
      scr_jb_puts(&b, scr_dyn_handle_ops_of(d)->to_string_tag);
      scr_jb_putc(&b, ']');
      return scr_jb_finish(&b);
    }
    tag = "[object Object]";
    break;
  case SCR_DYN_BYTES: {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "[object ");
    scr_jb_puts(&b, d->v.bytes->is_data_view ? "DataView" : scr_bytes_elem_name(d->v.bytes->elem));
    scr_jb_putc(&b, ']');
    return scr_jb_finish(&b);
  }
  case SCR_DYN_FUNC: tag = "[object Function]"; break;
  case SCR_DYN_PROMISE: tag = "[object Promise]"; break;
  default: {
    const char *msg = "Object.prototype.toString.call on this checked-dynamic kind is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, strlen(msg));
    return NULL;
  }
  }
  return scr_str_new(tag, strlen(tag));
}

/* ── JSON.stringify over a dyn value (util.format's %j) ───────────────
 * The RUNTIME walk the type-directed serializers deliberately avoid for
 * static values — a dyn value has no static type, so the checked-dynamic tree's own kinds
 * drive it, JS-exactly: objects in OrdinaryOwnPropertyKeys order (array
 * indices ascending, then other strings in insertion order) with undefined/function
 * members OMITTED, arrays rendering those as null, Buffer's toJSON shape
 * ({"type":"Buffer","data":[...]}), shortest-roundtrip numbers, escaped
 * strings. HANDLE values throw "not supported yet" (Node walks own enumerable props
 * this runtime does not model). Returns false when the VALUE ITSELF is
 * absent under stringify (root undefined/function — %j prints
 * "undefined" there, Node's tryStringify tail). */
static bool scr_dyn_json_write(ScrJsonBuf *b, const ScrDyn *d) {
  if (d->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("JSON.stringify");
    return false;
  }
  switch (d->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_SYMBOL:
  case SCR_DYN_FUNC:
    return false;
  case SCR_DYN_NULL: scr_jb_puts(b, "null"); return true;
  case SCR_DYN_BOOL: scr_jb_puts(b, d->v.b ? "true" : "false"); return true;
  case SCR_DYN_BIGINT: {
    static const char message[] = "Do not know how to serialize a BigInt";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return true;
  }
  case SCR_DYN_NUM: scr_jb_put_f64(b, d->v.num); return true;
  case SCR_DYN_STR: scr_jb_put_json_str(b, d->v.str); return true;
  case SCR_DYN_ARR: {
    scr_jb_putc(b, '[');
    for (size_t i = 0; i < d->v.arr.len; i++) {
      if (i > 0) scr_jb_putc(b, ',');
      if (!scr_dyn_json_write(b, d->v.arr.items[i])) scr_jb_puts(b, "null");
    }
    scr_jb_putc(b, ']');
    return true;
  }
  case SCR_DYN_OBJ: {
    scr_jb_putc(b, '{');
    bool first = true;
    ScrDyn *keys = scr_dyn_obj_keys(d);
    if (!keys) return false;
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      const ScrDyn *key = keys->v.arr.items[i];
      ScrDyn *value = scr_dyn_obj_read(d, key->v.str->data, key->v.str->len);
      if (!value) {
        scr_dyn_release(keys);
        return false;
      }
      ScrJsonBuf probe;
      scr_jb_init(&probe);
      if (!scr_dyn_json_write(&probe, value)) {
        scr_jb_dispose(&probe);
        scr_dyn_release(value);
        if (scr_exc_pending()) {
          scr_dyn_release(keys);
          return false;
        }
        continue; /* undefined/function members drop, like Node */
      }
      if (!first) scr_jb_putc(b, ',');
      first = false;
      scr_jb_put_json_str(b, key->v.str);
      scr_jb_putc(b, ':');
      ScrStr *body = scr_jb_finish(&probe);
      scr_jb_write(b, body->data, body->len);
      scr_str_release(body);
      scr_dyn_release(value);
    }
    scr_dyn_release(keys);
    scr_jb_putc(b, '}');
    return true;
  }
  case SCR_DYN_BYTES: {
    /* Buffer/typed-array toJSON — Node's {"type":"Buffer","data":[...]}
     * for the Buffer flavor; a plain Uint8Array stringifies index-keyed
     * ({"0":1,...}), also Node. */
    const ScrBytes *bytes = d->v.bytes;
    if (d->buffer) scr_jb_puts(b, "{\"type\":\"Buffer\",\"data\":[");
    else scr_jb_putc(b, '{');
    for (size_t i = 0; i < bytes->len; i++) {
      if (i > 0) scr_jb_putc(b, ',');
      if (!d->buffer) {
        char idx[32];
        int n = snprintf(idx, sizeof idx, "\"%zu\":", i);
        scr_jb_write(b, idx, (size_t)n);
      }
      scr_jb_put_f64(b, scr_bytes_get(bytes, (double)i));
    }
    scr_jb_puts(b, d->buffer ? "]}" : "}");
    return true;
  }
  case SCR_DYN_PROMISE:
    /* No own enumerable properties — Node stringifies a promise as {}. */
    scr_jb_puts(b, "{}");
    return true;

  case SCR_DYN_TYPED_REF: {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
    bool present = scr_dyn_json_write(b, materialized);
    scr_dyn_release(materialized);
    return present;
  }
  case SCR_DYN_HANDLE:
    if (scr_dyn_handle_ops_of(d)->json_empty_object) {
      /* No own enumerable properties (Blob, File). */
      scr_jb_puts(b, "{}");
      return true;
    }
    /* fall through */
  default: {
    const char *msg = "JSON.stringify of a runtime handle is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, strlen(msg));
    return true; /* pending exception; caller checks */
  }
  }
}

/* The JSON text of a dyn value (+1): the stringify text, "undefined" for
 * a root the stringify drops, or NULL with a pending exception (a handle
 * inside the tree). */
ScrStr *scr_dyn_format_j(const ScrDyn *d) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  bool present = scr_dyn_json_write(&b, d);
  if (scr_exc_pending()) {
    scr_jb_dispose(&b);
    return NULL;
  }
  if (!present) {
    scr_jb_dispose(&b);
    return scr_str_new("undefined", 9);
  }
  return scr_jb_finish(&b);
}

/* An %Error instance as a dyn object ({name, message[, code]}) — the
 * checked-dynamic boundary's error shape (the exception-snapshot
 * convention emit-walkers uses). Borrows e; +1 result.
 *
 * IDENTITY-CACHED: one error instance boxes to ONE dyn node, however many
 * times it crosses (Node passes the error OBJECT through, so `found.error
 * === thrown` and re-crossings compare reference-equal — the tracing
 * suite's shape). The cache retains both sides; an entry lives while
 * either side is referenced elsewhere, and a sweep releases the entries
 * whose error and node only the cache still references (the rest are
 * released atexit before the RC audit). The node also holds the error's
 * extra own properties (scr_error_set_prop) and SNAPSHOTS name/message/
 * code at first crossing — a later mutation of the error is invisible
 * through it (SEMANTICS.md). Two pointer-keyed hash
 * indexes find an entry by either side: Promise.allSettled and
 * Promise.any cross every rejection reason. Both sides are unique per
 * entry (an error boxes once; an alien view enters once). */
typedef struct {
  ScrError *err; /* retained (pins the address — no pointer reuse) */
  ScrDyn *dyn;   /* retained */
  /* An own `code` that is not a string (`err.code = undefined`), retained,
   * or NULL. The code slot holds only strings, and a subclass's typed view
   * rebuilds its properties from the slots on every read. */
  ScrDyn *code;
} ScrErrDynEnt;

static SCR_TL ScrErrDynEnt *scr_errdyn_cache = NULL;
static SCR_TL size_t scr_errdyn_n = 0, scr_errdyn_cap = 0;
static SCR_TL bool scr_errdyn_teardown_registered = false;
/* Open-addressed indexes holding entry index + 1 (0 = empty slot). */
static SCR_TL size_t *scr_errdyn_by_err = NULL, *scr_errdyn_by_dyn = NULL;
static SCR_TL size_t scr_errdyn_slots = 0; /* a power of two */
/* The entry count that triggers the next sweep: twice the entries the
 * previous sweep kept, so sweeping costs amortized O(1) per entry. */
static SCR_TL size_t scr_errdyn_sweep_at = 64;

static size_t scr_errdyn_hash(const void *p) {
  size_t x = (size_t)(uintptr_t)p >> 4;
  x ^= x >> 16;
  x *= 0x45d9f3bu;
  x ^= x >> 16;
  return x;
}

static void scr_errdyn_index_put(size_t *table, const void *key, size_t index, bool by_err) {
  size_t mask = scr_errdyn_slots - 1;
  for (size_t at = scr_errdyn_hash(key) & mask;; at = (at + 1) & mask) {
    if (table[at] == 0) {
      table[at] = index + 1;
      return;
    }
    const ScrErrDynEnt *ent = &scr_errdyn_cache[table[at] - 1];
    if ((by_err ? (const void *)ent->err : (const void *)ent->dyn) == key) return;
  }
}

/* The entry index for an error (by_err) or a view, or SIZE_MAX. */
static size_t scr_errdyn_find(const void *key, bool by_err) {
  if (scr_errdyn_slots == 0) return SIZE_MAX;
  const size_t *table = by_err ? scr_errdyn_by_err : scr_errdyn_by_dyn;
  size_t mask = scr_errdyn_slots - 1;
  for (size_t at = scr_errdyn_hash(key) & mask; table[at] != 0; at = (at + 1) & mask) {
    const ScrErrDynEnt *ent = &scr_errdyn_cache[table[at] - 1];
    if ((by_err ? (const void *)ent->err : (const void *)ent->dyn) == key) return table[at] - 1;
  }
  return SIZE_MAX;
}

static void scr_errdyn_teardown(void);

/* The entries of a node that hold the node itself (a spawnSync error's
 * `error`): references the node makes to itself, not reachability. */
static size_t scr_errdyn_self_refs(const ScrDyn *d) {
  if (d->kind != SCR_DYN_OBJ) return 0;
  size_t n = 0;
  for (size_t i = 0; i < d->v.obj.len; i++) n += d->v.obj.entries[i].value == d;
  return n;
}

/* Releases a node the cache owned, dropping its references to itself
 * first so the release frees it. */
static void scr_errdyn_release_node(ScrDyn *d) {
  for (size_t i = 0; d->kind == SCR_DYN_OBJ && i < d->v.obj.len; i++) {
    ScrDynEntry *entry = &d->v.obj.entries[i];
    if (entry->value != d) continue;
    entry->value = scr_dyn_retain(scr_dyn_undefined());
    scr_dyn_release(d);
  }
  scr_dyn_release(d);
}

/* Releases the entries nothing but the cache references. A field node
 * holds no reference to its error and a registered subclass box holds
 * one, so an entry whose node has only the cache's reference and whose
 * error has no reference beyond the cache's and its box's is
 * unreachable. The indexes are rebuilt over the
 * kept entries before anything is released (a teardown never sees a
 * stale entry); an entry a released node kept alive goes in a later
 * sweep. */
static void scr_errdyn_sweep(void) {
  ScrErrDynEnt *dead = NULL;
  size_t n_dead = 0, kept = 0;
  for (size_t i = 0; i < scr_errdyn_n; i++) {
    ScrErrDynEnt ent = scr_errdyn_cache[i];
    size_t boxed = ent.dyn->kind == SCR_DYN_TYPED_REF && ent.dyn->v.typed_ref.ptr == (void *)ent.err;
    if (ent.dyn->rc == 1 + scr_errdyn_self_refs(ent.dyn) && ent.err->rc == 1 + boxed) {
      if (dead == NULL) {
        dead = malloc((scr_errdyn_n - i) * sizeof *dead);
        if (!dead) scr_trap("scriptc: out of memory\n");
      }
      dead[n_dead++] = ent;
    } else {
      scr_errdyn_cache[kept++] = ent;
    }
  }
  scr_errdyn_n = kept;
  scr_errdyn_sweep_at = kept * 2 > 64 ? kept * 2 : 64;
  if (n_dead == 0) return;
  memset(scr_errdyn_by_err, 0, scr_errdyn_slots * sizeof *scr_errdyn_by_err);
  memset(scr_errdyn_by_dyn, 0, scr_errdyn_slots * sizeof *scr_errdyn_by_dyn);
  for (size_t i = 0; i < scr_errdyn_n; i++) {
    scr_errdyn_index_put(scr_errdyn_by_err, scr_errdyn_cache[i].err, i, true);
    scr_errdyn_index_put(scr_errdyn_by_dyn, scr_errdyn_cache[i].dyn, i, false);
  }
  for (size_t i = 0; i < n_dead; i++) {
    scr_error_release(dead[i].err);
    scr_errdyn_release_node(dead[i].dyn);
    scr_dyn_release(dead[i].code);
  }
  free(dead);
}

/* Appends an entry (both sides retained) and indexes it. */
static void scr_errdyn_append(ScrError *e, ScrDyn *d) {
  if (scr_errdyn_n >= scr_errdyn_sweep_at) scr_errdyn_sweep();
  if (scr_errdyn_n == scr_errdyn_cap) {
    scr_errdyn_cap = scr_errdyn_cap ? scr_errdyn_cap * 2 : 8;
    scr_errdyn_cache = realloc(scr_errdyn_cache, scr_errdyn_cap * sizeof *scr_errdyn_cache);
    if (!scr_errdyn_cache) {
      scr_trap("scriptc: out of memory\n");
    }
  }
  if (!scr_errdyn_teardown_registered) {
    scr_errdyn_teardown_registered = true;
    scr_atexit(scr_errdyn_teardown);
  }
  scr_errdyn_cache[scr_errdyn_n].err = scr_error_retain(e);
  scr_errdyn_cache[scr_errdyn_n].dyn = scr_dyn_retain(d);
  scr_errdyn_cache[scr_errdyn_n].code = NULL;
  scr_errdyn_n++;
  if (scr_errdyn_n * 2 > scr_errdyn_slots) {
    free(scr_errdyn_by_err);
    free(scr_errdyn_by_dyn);
    scr_errdyn_slots = scr_errdyn_slots ? scr_errdyn_slots * 2 : 16;
    scr_errdyn_by_err = calloc(scr_errdyn_slots, sizeof *scr_errdyn_by_err);
    scr_errdyn_by_dyn = calloc(scr_errdyn_slots, sizeof *scr_errdyn_by_dyn);
    if (!scr_errdyn_by_err || !scr_errdyn_by_dyn) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < scr_errdyn_n; i++) {
      scr_errdyn_index_put(scr_errdyn_by_err, scr_errdyn_cache[i].err, i, true);
      scr_errdyn_index_put(scr_errdyn_by_dyn, scr_errdyn_cache[i].dyn, i, false);
    }
  } else {
    scr_errdyn_index_put(scr_errdyn_by_err, e, scr_errdyn_n - 1, true);
    scr_errdyn_index_put(scr_errdyn_by_dyn, d, scr_errdyn_n - 1, false);
  }
}

typedef struct {
  const ScrVt *vt;
  ScrDyn *(*box)(void *);
} ScrErrorDynType;
static SCR_TL ScrErrorDynType *scr_error_dyn_types = NULL;
static SCR_TL size_t scr_error_dyn_type_count = 0;

static void scr_error_dyn_types_drop(void) {
  free(scr_error_dyn_types);
  scr_error_dyn_types = NULL;
  scr_error_dyn_type_count = 0;
}

void scr_error_register_dyn(const ScrVt *vt, ScrDyn *(*box)(void *)) {
  for (size_t i = 0; i < scr_error_dyn_type_count; i++) {
    if (scr_error_dyn_types[i].vt == vt) return;
  }
  if (!scr_error_dyn_type_count) scr_atexit(scr_error_dyn_types_drop);
  scr_error_dyn_types = realloc(scr_error_dyn_types, (scr_error_dyn_type_count + 1) * sizeof *scr_error_dyn_types);
  if (!scr_error_dyn_types) scr_json_oom();
  scr_error_dyn_types[scr_error_dyn_type_count++] = (ScrErrorDynType){vt, box};
}

static void scr_errdyn_teardown(void) {
  /* Detach the storage first: no release below sees a half-torn cache. */
  ScrErrDynEnt *cache = scr_errdyn_cache;
  size_t n = scr_errdyn_n;
  scr_errdyn_cache = NULL;
  scr_errdyn_n = scr_errdyn_cap = 0;
  free(scr_errdyn_by_err);
  free(scr_errdyn_by_dyn);
  scr_errdyn_by_err = scr_errdyn_by_dyn = NULL;
  scr_errdyn_slots = 0;
  scr_errdyn_sweep_at = 64;
  for (size_t i = 0; i < n; i++) {
    scr_error_release(cache[i].err);
    scr_errdyn_release_node(cache[i].dyn);
    scr_dyn_release(cache[i].code);
  }
  free(cache);
}

/* An error's own `stack`: a non-enumerable accessor shared by every error,
 * as V8 defines it. The getter formats the stack on first access, so its
 * heading is the name and message at that point, and later reads answer
 * the same string. Both functions find the error through the receiver or
 * its prototype chain; on any other receiver the getter answers undefined
 * and the setter changes nothing but the receiver's own accessor. */
static SCR_TL ScrDyn *scr_error_stack_accessors[2];
static SCR_TL bool scr_error_stack_accessors_registered;

static void scr_error_stack_accessors_cleanup(void) {
  for (size_t i = 0; i < 2; i++) {
    scr_dyn_release(scr_error_stack_accessors[i]);
    scr_error_stack_accessors[i] = NULL;
  }
  scr_error_stack_accessors_registered = false;
}

/* The native error behind an accessor receiver. +1 or NULL. */
static ScrError *scr_error_stack_holder(const ScrDyn *receiver) {
  for (const ScrDyn *current = receiver; current; current = scr_dyn_proto_next(current)) {
    ScrError *error = scr_errdyn_err_of(current);
    if (error) return error;
    if (current->kind != SCR_DYN_OBJ) return NULL;
  }
  return NULL;
}

static ScrDyn *scr_error_stack_get_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrError *error = scr_error_stack_holder(self);
  scr_dyn_release(self);
  if (!error) return scr_dyn_retain(scr_dyn_undefined());
  ScrStr *stack = scr_error_stack(error);
  scr_error_release(error);
  /* A name or message getter that throws leaves its exception pending. */
  if (!stack) return NULL;
  ScrDyn *out = scr_dyn_new_str(stack);
  scr_str_release(stack);
  return out;
}

static ScrDyn *scr_error_stack_set_call(ScrClosure *closure, ScrDyn *const *args, size_t argc);

/* Whether an own property is an error's `stack` accessor. */
static bool scr_dyn_entry_is_error_stack(const ScrDynEntry *entry) {
  return entry->accessor && entry->setter && entry->setter->kind == SCR_DYN_FUNC &&
         entry->setter->v.fn.thunk == scr_error_stack_set_call;
}

static ScrDyn *scr_error_stack_set_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *self = scr_dyn_this_get();
  ScrError *error = scr_error_stack_holder(self);
  ScrDyn *value = argc > 0 ? args[0] : scr_dyn_undefined();
  if (error && value->kind == SCR_DYN_STR) {
    scr_error_set_stack(error, value->v.str);
  } else if (self->kind == SCR_DYN_OBJ) {
    /* The native slot holds strings only, and a typed reference's
     * snapshot names no error: the receiver's own accessor becomes a data
     * property holding the value, which a snapshot's commit stores. */
    ScrStr *key = scr_str_new("stack", 5);
    ScrDynEntry *entry = scr_dyn_entry(self, key);
    scr_str_release(key);
    if (entry && scr_dyn_entry_is_error_stack(entry)) {
      ScrDyn *old_value = entry->value, *old_getter = entry->getter, *old_setter = entry->setter;
      entry->value = scr_dyn_retain(value);
      entry->getter = entry->setter = NULL;
      entry->accessor = false;
      entry->writable = true;
      scr_dyn_release(old_value);
      scr_dyn_release(old_getter);
      scr_dyn_release(old_setter);
    }
  }
  scr_error_release(error);
  scr_dyn_release(self);
  return scr_dyn_retain(scr_dyn_undefined());
}

static void scr_error_dyn_add_stack(ScrDyn *d) {
  if (!scr_error_stack_accessors_registered) {
    scr_error_stack_accessors_registered = true;
    scr_atexit(scr_error_stack_accessors_cleanup);
  }
  if (!scr_error_stack_accessors[0]) {
    scr_error_stack_accessors[0] =
        scr_dyn_new_func(scr_closure_new(NULL, 0), scr_error_stack_get_call, 0, "native:error.stack", NULL);
    scr_error_stack_accessors[1] =
        scr_dyn_new_func(scr_closure_new(NULL, 0), scr_error_stack_set_call, 1, "native:error.stack", NULL);
  }
  scr_dyn_obj_set(d, "stack", 5, scr_dyn_retain(scr_dyn_undefined()));
  ScrDynEntry *entry = &d->v.obj.entries[d->v.obj.len - 1];
  entry->accessor = true;
  entry->getter = scr_dyn_retain(scr_error_stack_accessors[0]);
  entry->setter = scr_dyn_retain(scr_error_stack_accessors[1]);
  entry->enumerable = false;
}

ScrDyn *scr_error_dyn_fields(const ScrError *e) {
  ScrDyn *d = scr_dyn_new_obj();
  scr_dyn_obj_set(d, "%error", 6, scr_dyn_new_bool(true)); /* the checked-dynamic tree's error marker */
  d->v.obj.entries[d->v.obj.len - 1].enumerable = false;
  /* Node lists `stack` first among an error's own properties. */
  scr_error_dyn_add_stack(d);
  if (!e->name_present || !e->message_present) {
    ScrDyn *prototype = scr_dyn_new_obj();
    if (!e->name_present) {
      scr_dyn_obj_set(prototype, "name", 4, scr_dyn_new_str(e->name));
      prototype->v.obj.entries[prototype->v.obj.len - 1].enumerable = false;
    }
    if (!e->message_present) {
      scr_dyn_obj_set(prototype, "message", 7, scr_dyn_new_str(e->message));
      prototype->v.obj.entries[prototype->v.obj.len - 1].enumerable = false;
    }
    scr_dyn_release(scr_dyn_set_prototype(d, prototype));
    scr_dyn_release(prototype);
  }
  if (e->message_present) {
    scr_dyn_obj_set(d, "message", 7, scr_dyn_new_str(e->message));
    d->v.obj.entries[d->v.obj.len - 1].enumerable = e->message_enumerable;
  }
  if (e->system_message) {
    /* SystemError: code, the read-only `info` context ({ message, path,
     * syscall, errno, code }), then errno, syscall, path and dest. */
    if (e->code) scr_dyn_obj_set(d, "code", 4, scr_dyn_new_str(e->code));
    ScrDyn *info = scr_dyn_new_obj();
    scr_dyn_obj_set(info, "message", 7, scr_dyn_new_str(e->system_message));
    if (e->system_path) scr_dyn_obj_set(info, "path", 4, scr_dyn_new_str(e->system_path));
    if (e->system_dest) scr_dyn_obj_set(info, "dest", 4, scr_dyn_new_str(e->system_dest));
    if (e->system_call) scr_dyn_obj_set(info, "syscall", 7, scr_dyn_new_str(e->system_call));
    scr_dyn_obj_set(info, "errno", 5, scr_dyn_new_num(e->system_errno));
    if (e->system_code) scr_dyn_obj_set(info, "code", 4, scr_dyn_new_str(e->system_code));
    scr_dyn_obj_set(d, "info", 4, info);
    d->v.obj.entries[d->v.obj.len - 1].writable = false;
    scr_dyn_obj_set(d, "errno", 5, scr_dyn_new_num(e->system_errno));
    if (e->system_call) scr_dyn_obj_set(d, "syscall", 7, scr_dyn_new_str(e->system_call));
  } else if (e->errno_order) {
    /* ErrnoException: errno, code, path, syscall. */
    if (e->system_call) scr_dyn_obj_set(d, "errno", 5, scr_dyn_new_num(e->system_errno));
    if (e->code) scr_dyn_obj_set(d, "code", 4, scr_dyn_new_str(e->code));
    if (e->system_path) scr_dyn_obj_set(d, "path", 4, scr_dyn_new_str(e->system_path));
    if (e->system_call) scr_dyn_obj_set(d, "syscall", 7, scr_dyn_new_str(e->system_call));
  } else {
    /* errno rides fs errors (with syscall) and zlib errors (without). */
    if (e->system_call || e->system_errno != 0)
      scr_dyn_obj_set(d, "errno", 5, scr_dyn_new_num(e->system_errno));
    if (e->code) {
      scr_dyn_obj_set(d, "code", 4, scr_dyn_new_str(e->code));
    } else {
      size_t hit = scr_errdyn_find(e, true);
      if (hit != SIZE_MAX && scr_errdyn_cache[hit].code != NULL)
        scr_dyn_obj_set(d, "code", 4, scr_dyn_retain(scr_errdyn_cache[hit].code));
    }
    if (e->system_call) scr_dyn_obj_set(d, "syscall", 7, scr_dyn_new_str(e->system_call));
  }
  if (!e->errno_order && e->system_path) scr_dyn_obj_set(d, "path", 4, scr_dyn_new_str(e->system_path));
  if (e->system_dest) scr_dyn_obj_set(d, "dest", 4, scr_dyn_new_str(e->system_dest));
  if (e->error_cause) {
    scr_dyn_obj_set(d, "cause", 5, scr_dyn_retain(e->error_cause));
    d->v.obj.entries[d->v.obj.len - 1].enumerable = e->cause_enumerable;
  }
  /* DOMException: `code` is the WebIDL legacy NUMBER (never the errno
   * string slot), and the options form's cause crosses as itself. */
  if (e->vt == &scr_error_vts[SCR_ERR_DOMEX]) {
    scr_dyn_obj_set(d, "code", 4, scr_dyn_new_num(scr_domex_code(( ScrError *)e)));
    if (scr_domex_has_cause((ScrError *)e)) {
      scr_dyn_obj_set(d, "cause", 5, scr_domex_cause((ScrError *)e));
    }
  }
  /* A disposal SuppressedError's non-enumerable `error` and `suppressed`
   * (scr_exc_suppress); a constructed one sets them on its view. */
  const ScrCaught *suppressed_error = NULL, *suppressed_value = NULL;
  if (e->vt == &scr_error_vts[SCR_ERR_SUPPRESSED] &&
      scr_exc_suppressed_values(e, &suppressed_error, &suppressed_value)) {
    scr_dyn_obj_set(d, "error", 5, scr_caught_to_dyn(suppressed_error));
    d->v.obj.entries[d->v.obj.len - 1].enumerable = false;
    scr_dyn_obj_set(d, "suppressed", 10, scr_caught_to_dyn(suppressed_value));
    d->v.obj.entries[d->v.obj.len - 1].enumerable = false;
  }
  /* AggregateError's own non-enumerable `errors` list, shared with the
   * typed read so both spellings answer the same array. */
  if (e->vt == &scr_error_vts[SCR_ERR_AGGREGATE]) {
    scr_dyn_obj_set(d, "errors", 6, scr_aggregate_errors((ScrError *)e));
    d->v.obj.entries[d->v.obj.len - 1].enumerable = false;
  }
  /* An own `name` is assigned after construction defines the others. */
  if (e->name_present) {
    scr_dyn_obj_set(d, "name", 4, scr_dyn_new_str(e->name));
    d->v.obj.entries[d->v.obj.len - 1].enumerable = e->name_enumerable;
  }
  return d;
}

/* Moves an Error subclass view's own `name` to follow the property
 * `after`, or every other property when `after` is NULL: the position
 * the class's construction creates it at. Nothing changes when the view
 * has no own `name` or no `after` property. */
void scr_error_dyn_place_name(ScrDyn *view, const char *after, size_t after_len) {
  if (view->kind != SCR_DYN_OBJ) return;
  ScrDynEntry *entries = view->v.obj.entries;
  size_t n = view->v.obj.len, from = n, to = n;
  for (size_t i = 0; i < n; i++) {
    if (entries[i].key_len == 4 && memcmp(entries[i].key, "name", 4) == 0) from = i;
    else if (after && entries[i].key_len == after_len && memcmp(entries[i].key, after, after_len) == 0) to = i;
  }
  if (from == n || (after && to == n)) return;
  size_t at = after ? (to > from ? to : to + 1) : n - 1;
  if (at == from) return;
  ScrDynEntry name = entries[from];
  memmove(&entries[from], &entries[from + 1], (n - from - 1) * sizeof *entries);
  memmove(&entries[at + 1], &entries[at], (n - 1 - at) * sizeof *entries);
  entries[at] = name;
  SCR_JS_SHAPE_RESET(view);
  free(view->v.obj.index);
  view->v.obj.index = NULL;
}

ScrDyn *scr_dyn_from_error(const ScrError *e) {
  size_t hit = scr_errdyn_find(e, true);
  if (hit != SIZE_MAX) return scr_dyn_retain(scr_errdyn_cache[hit].dyn);
  ScrDyn *d = NULL;
  for (size_t i = 0; i < scr_error_dyn_type_count; i++) {
    if (scr_error_dyn_types[i].vt == e->vt) {
      d = scr_error_dyn_types[i].box((void *)e);
      break;
    }
  }
  if (!d) d = scr_error_dyn_fields(e);
  scr_errdyn_append((ScrError *)e, d);
  return d;
}

/* An own property on an error, as a throw site attaches Node's extra
 * fields (a dns error's hostname, an exec error's status): set on the
 * error's checked-dynamic node, which casts, the checked-dynamic surface
 * and util.inspect read. Moves value. */
void scr_error_set_prop(ScrError *e, const char *key, size_t key_len, ScrDyn *value) {
  ScrDyn *view = scr_dyn_from_error(e);
  scr_dyn_obj_set(view, key, key_len, value);
  scr_dyn_release(view);
}

/* The error's checked-dynamic node when it has one (borrowed), else NULL:
 * util.inspect reads its extra own properties. */
ScrDyn *scr_errdyn_view_of(const ScrError *e) {
  size_t hit = scr_errdyn_find(e, true);
  return hit == SIZE_MAX ? NULL : scr_errdyn_cache[hit].dyn;
}

/* The %Error EXTRACTION (dynCheck of `u as Error` / an instanceof-Error
 * narrow, and the dyn-boxed thunk's Error-typed parameters): the REVERSE
 * of scr_dyn_from_error, riding the same identity cache — a dyn error
 * that came from a runtime ScrError answers THAT instance (+1), so an
 * error crossing out and back compares reference-equal (the tracing
 * suite's shape); an alien %error object rebuilds a runtime error from
 * its name/message/code (the vtable kind resolves from the name so a
 * later `instanceof TypeError` still answers) and ENTERS the cache, so
 * its next boxing answers the same dyn node. The dyn node is borrowed. */
static void scr_error_cause_drop_impl(void *obj);

void scr_error_commit_dyn(ScrError *e, const ScrDyn *view) {
  ScrDynEntry *name_entry = scr_dyn_find_entry(view, "name", 4);
  ScrDynEntry *message_entry = scr_dyn_find_entry(view, "message", 7);
  /* An own accessor over `name` or `message` (zod's lazy error message)
   * has no value to snapshot: the slot keeps its last value, and the
   * property reads as absent so typed reads take the accessor path
   * (scr_error_own_accessor) and toString asks the installed reader. */
  ScrDyn *name = name_entry && !name_entry->accessor ? name_entry->value : NULL;
  if (name && name->kind != SCR_DYN_STR) {
    scr_dyn_check_fail(NULL, "string", name);
    return;
  }
  ScrDyn *message = message_entry && !message_entry->accessor ? message_entry->value : NULL;
  if (message && message->kind != SCR_DYN_STR) {
    scr_dyn_check_fail(NULL, "string", message);
    return;
  }
  if (!name_entry || !name_entry->accessor) {
    ScrStr *next_name = name ? scr_str_retain(name->v.str) : scr_error_default_name(e);
    scr_str_release(e->name);
    e->name = next_name;
  }
  e->name_present = name != NULL;
  e->name_enumerable = name_entry && name_entry->enumerable;
  if (!message_entry || !message_entry->accessor) {
    ScrStr *next_message = message ? scr_str_retain(message->v.str) : scr_str_new("", 0);
    scr_str_release(e->message);
    e->message = next_message;
  }
  e->message_present = message != NULL;
  e->message_enumerable = message_entry && message_entry->enumerable;
  ScrDyn *stack = scr_dyn_obj_get(view, "stack", 5);
  if (stack && stack->kind == SCR_DYN_STR) {
    ScrStr *replacement = scr_str_retain(stack->v.str);
    scr_str_release(e->stack);
    e->stack = replacement;
  }
  ScrDyn *cause = scr_dyn_obj_get(view, "cause", 5);
  scr_error_install_cause_drop(&scr_error_cause_drop_impl);
  ScrDyn *replacement = cause ? scr_dyn_retain(cause) : NULL;
  scr_dyn_release(e->error_cause);
  e->error_cause = replacement;
  e->cause_enumerable = false;
  for (size_t i = 0; cause && i < view->v.obj.len; i++) {
    const ScrDynEntry *entry = &view->v.obj.entries[i];
    if (entry->key_len == 5 && memcmp(entry->key, "cause", 5) == 0) e->cause_enumerable = entry->enumerable;
  }
}

ScrError *scr_error_from_dyn(const ScrDyn *d) {
  ScrError *hit = scr_errdyn_err_of(d);
  if (hit) return hit;
  const ScrDyn *en = scr_dyn_obj_get(d, "name", 4);
  const ScrDyn *em = scr_dyn_obj_get(d, "message", 7);
  const ScrDyn *ec = scr_dyn_obj_get(d, "code", 4);
  int k = SCR_ERR_ERROR;
  if (en && en->kind == SCR_DYN_STR) {
    const ScrStr *n = en->v.str;
    if (n->len == 9 && memcmp(n->data, "TypeError", 9) == 0) k = SCR_ERR_TYPE;
    else if (n->len == 10 && memcmp(n->data, "RangeError", 10) == 0) k = SCR_ERR_RANGE;
    else if (n->len == 11 && memcmp(n->data, "SyntaxError", 11) == 0) k = SCR_ERR_SYNTAX;
    else if (n->len == 14 && memcmp(n->data, "ReferenceError", 14) == 0) k = SCR_ERR_REFERENCE;
    else if (n->len == 9 && memcmp(n->data, "EvalError", 9) == 0) k = SCR_ERR_EVAL;
    else if (n->len == 8 && memcmp(n->data, "URIError", 8) == 0) k = SCR_ERR_URI;
  }
  ScrError *e = scr_error_new(k, (em && em->kind == SCR_DYN_STR) ? em->v.str : NULL);
  if (en && en->kind == SCR_DYN_STR) {
    scr_str_release(e->name);
    e->name = scr_str_retain(en->v.str);
    e->name_present = true;
    e->name_enumerable = true;
  }
  if (ec && ec->kind == SCR_DYN_STR) e->code = scr_str_retain(ec->v.str);
  ScrDyn *cause = scr_dyn_obj_get(d, "cause", 5);
  if (cause) {
    scr_error_install_cause_drop(&scr_error_cause_drop_impl);
    e->error_cause = scr_dyn_retain(cause);
    for (size_t i = 0; i < d->v.obj.len; i++) {
      const ScrDynEntry *entry = &d->v.obj.entries[i];
      if (entry->key_len == 5 && memcmp(entry->key, "cause", 5) == 0) e->cause_enumerable = entry->enumerable;
    }
  }
  scr_errdyn_put(e, (ScrDyn *)d);
  return e;
}

/* Identity-cache access for the tracing/dc surfaces (the cache storage
 * stays private here). Reverse lookup answers +1 or NULL; put retains
 * both sides for the process. */
ScrError *scr_errdyn_err_of(const ScrDyn *d) {
  size_t hit = scr_errdyn_find(d, false);
  return hit == SIZE_MAX ? NULL : scr_error_retain(scr_errdyn_cache[hit].err);
}

void scr_errdyn_put(ScrError *e, ScrDyn *d) { scr_errdyn_append(e, d); }

/* An Error's slots (name, message, stack, cause, code) have one live value
 * even when the Error already crossed a checked-value boundary: writes and
 * deletes of those own properties through its checked-dynamic node update
 * the slots typed reads use. `view` is the error's node; `obj` holds the
 * properties (the node itself, or a typed view's materialized object). */
static void scr_error_sync_slots(const ScrDyn *view, ScrDyn *obj, const ScrStr *key) {
  bool cause = key->len == 5 && memcmp(key->data, "cause", 5) == 0;
  bool stack = key->len == 5 && memcmp(key->data, "stack", 5) == 0;
  bool name = key->len == 4 && memcmp(key->data, "name", 4) == 0;
  bool message = key->len == 7 && memcmp(key->data, "message", 7) == 0;
  bool code = key->len == 4 && memcmp(key->data, "code", 4) == 0;
  if (!cause && !stack && !name && !message && !code) return;
  if (obj == NULL || obj->kind != SCR_DYN_OBJ) return;
  size_t hit = scr_errdyn_find(view, false);
  if (hit == SIZE_MAX) return;
  ScrDynEntry *entry = scr_dyn_entry(obj, key);
  ScrError *e = scr_errdyn_cache[hit].err;
  if (code) {
    /* A string takes the slot; any other value clears it and stays an own
     * property, which the entry keeps for views rebuilt from the slots. */
    bool string = entry && !entry->accessor && entry->value->kind == SCR_DYN_STR;
    ScrStr *next = string ? scr_str_retain(entry->value->v.str) : NULL;
    scr_str_release(e->code);
    e->code = next;
    ScrDyn *other = entry && !string && !entry->accessor ? scr_dyn_retain(entry->value) : NULL;
    scr_dyn_release(scr_errdyn_cache[hit].code);
    scr_errdyn_cache[hit].code = other;
    return;
  }
  if (name || message) {
    /* The native error's toString and inspect read these fields. An own
     * accessor leaves the slot, which then reads as absent: typed reads
     * call it (scr_error_own_accessor). */
    if (entry && entry->accessor) {
      if (name) {
        e->name_present = false;
        e->name_enumerable = entry->enumerable;
      } else {
        e->message_present = false;
        e->message_enumerable = entry->enumerable;
      }
      return;
    }
    if (!entry || entry->value->kind != SCR_DYN_STR) return;
    ScrStr **field = name ? &e->name : &e->message;
    scr_str_release(*field);
    *field = scr_str_retain(entry->value->v.str);
    if (name) {
      e->name_present = true;
      e->name_enumerable = entry->enumerable;
    } else {
      e->message_present = true;
      e->message_enumerable = entry->enumerable;
    }
    return;
  }
  if (stack) {
    if (entry && entry->value->kind == SCR_DYN_STR) {
      scr_str_release(e->stack);
      e->stack = scr_str_retain(entry->value->v.str);
    }
    return;
  }
  if (e->vt == &scr_error_vts[SCR_ERR_DOMEX]) return;
  ScrDyn *replacement = entry ? scr_dyn_retain(entry->value) : NULL;
  scr_error_install_cause_drop(&scr_error_cause_drop_impl);
  scr_dyn_release(e->error_cause);
  e->error_cause = replacement;
  e->cause_enumerable = entry && entry->enumerable;
}

static void scr_error_sync_cause(ScrDyn *view, const ScrStr *key) {
  scr_error_sync_slots(view, view, key);
}

/* Error.prototype.toString over the checked-dynamic error encoding (an
 * object carrying the reserved "%error" marker): `name` defaults to "Error"
 * and `message` to "", both read through the prototype; either empty leaves
 * the other alone, otherwise "name: message". NULL with a pending exception
 * when a member's string conversion throws. */
ScrStr *scr_dyn_error_string(const ScrDyn *d) {
  ScrStr *parts[2] = { NULL, NULL };
  static const char *const keys[2] = { "name", "message" };
  for (int i = 0; i < 2; i++) {
    ScrDyn *member = scr_dyn_obj_read(d, keys[i], strlen(keys[i]));
    if (!member || member->kind == SCR_DYN_UNDEF) {
      parts[i] = i == 0 ? scr_str_new("Error", 5) : scr_str_new("", 0);
    } else {
      parts[i] = scr_dyn_string_coerce_js(member);
    }
    scr_dyn_release(member);
    if (!parts[i]) {
      scr_str_release(parts[0]);
      return NULL;
    }
  }
  if (parts[0]->len == 0 || parts[1]->len == 0) {
    ScrStr *out = parts[0]->len == 0 ? parts[1] : parts[0];
    scr_str_release(out == parts[0] ? parts[1] : parts[0]);
    return out;
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_put_str(&b, parts[0]);
  scr_jb_puts(&b, ": ");
  scr_jb_put_str(&b, parts[1]);
  scr_str_release(parts[0]);
  scr_str_release(parts[1]);
  return scr_jb_finish(&b);
}

static bool scr_dyn_error_encoding(const ScrDyn *d) {
  return d->kind == SCR_DYN_OBJ && scr_dyn_obj_get(d, "%error", 6) != NULL;
}

static bool scr_dyn_is_date(const ScrDyn *d) {
  return d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_DATE;
}

/* A Date's valueOf(): its time value as a number. +1. */
static ScrDyn *scr_dyn_date_value_of(const ScrDyn *d) {
  return scr_dyn_handle_ops_of(d)->invoke(d->v.handle.ptr, (ScrDyn *)d, "valueOf", NULL, 0, "valueOf");
}

/* Receiver-kind-dispatched toString() on a checked-dynamic value (the
 * dyn method surface — a stream's 'data'/for-await chunk is the common
 * receiver): bytes decode per the encoding (Node's Buffer.toString,
 * utf8 default), strings answer themselves, numbers/booleans format
 * JS-exactly, arrays join their dyn elements with ',' (recursively via
 * JS's Array.prototype.toString), plain objects answer
 * "[object Object]", and undefined/null throw Node's TypeError. Borrows
 * both; +1 result. */
ScrStr *scr_dyn_to_string(const ScrDyn *d, const ScrStr *enc) {
  if (d->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("string conversion");
    /* Match this helper's existing exception-plus-dummy contract; its
     * recursive array walker and native callers still consume a string. */
    return scr_str_new("", 0);
  }
  switch (d->kind) {
  case SCR_DYN_SYMBOL:
    return d->v.symbol.render(d->v.symbol.value);
  case SCR_DYN_BYTES:
    if (d->buffer) return scr_bytes_to_str(d->v.bytes, enc);
    /* DataView has no toString of its own: Object.prototype.toString. */
    if (d->v.bytes->is_data_view) return scr_str_new("[object DataView]", 17);
    {
      ScrStr *separator = scr_str_new(",", 1);
      ScrStr *out = scr_bytes_join(d->v.bytes, separator);
      scr_str_release(separator);
      return out;
    }
  case SCR_DYN_STR:
    return scr_str_retain(d->v.str);
  case SCR_DYN_BIGINT:
    return scr_bigint_to_string(d->v.bigint, 10);
  case SCR_DYN_NUM:
    return scr_f64_to_scrstr(d->v.num);
  case SCR_DYN_BOOL:
    return d->v.b ? scr_str_new("true", 4) : scr_str_new("false", 5);
  case SCR_DYN_OBJ:
    if (scr_dyn_error_encoding(d) && !scr_dyn_property_owner(d, "toString", 8)) return scr_dyn_error_string(d);
    return scr_str_new("[object Object]", 15);
  case SCR_DYN_HANDLE:
    if (d->v.handle.tag == SCR_DYNH_REGEXP || d->v.handle.tag == SCR_DYNH_URL || d->v.handle.tag == SCR_DYNH_DATE) {
      ScrDyn *text = scr_dyn_handle_ops_of(d)->invoke(d->v.handle.ptr, (ScrDyn *)d, "toString", NULL, 0, "RegExp.toString");
      if (!text) return NULL;
      ScrStr *out = scr_str_retain(text->v.str);
      scr_dyn_release(text);
      return out;
    }
    if ((d->v.handle.tag >= SCR_DYNH_ABORT_SIGNAL &&
         d->v.handle.tag <= SCR_DYNH_ABORT_CONTROLLER) || d->v.handle.tag == SCR_DYNH_EVENT_TARGET ||
        d->v.handle.tag == SCR_DYNH_CUSTOM_EVENT || d->v.handle.tag == SCR_DYNH_ARRAY_BUFFER || d->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER || d->v.handle.tag == SCR_DYNH_SET || d->v.handle.tag == SCR_DYNH_MAP ||
        d->v.handle.tag == SCR_DYNH_BLOB || d->v.handle.tag == SCR_DYNH_FILE ||
        d->v.handle.tag == SCR_DYNH_DISPOSABLE_STACK) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "[object ");
      scr_jb_puts(&b, scr_dyn_handle_cls(d));
      scr_jb_putc(&b, ']');
      return scr_jb_finish(&b);
    }
    if (scr_dyn_handle_ops_of(d)->to_string_tag) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "[object ");
      scr_jb_puts(&b, scr_dyn_handle_ops_of(d)->to_string_tag);
      scr_jb_putc(&b, ']');
      return scr_jb_finish(&b);
    }
    /* IncomingMessage/ServerResponse/Socket and the other Node handles
     * inherit Object.prototype.toString without a @@toStringTag. */
    return scr_str_new("[object Object]", 15);
  case SCR_DYN_PROMISE:
    /* Object.prototype.toString with the Promise @@toStringTag. */
    return scr_str_new("[object Promise]", 16);
  case SCR_DYN_ARR: {
    /* Array.prototype.join reads the length once and each element by index:
     * an element's toString can append to or shrink the array, so an index
     * past the current length reads undefined, and the element stays
     * retained while it converts. */
    size_t len = d->v.arr.len;
    ScrStr *out = scr_str_new("", 0);
    for (size_t i = 0; i < len; i++) {
      if (i > 0) {
        ScrStr *comma = scr_str_new(",", 1);
        ScrStr *joined = scr_str_concat(out, comma);
        scr_str_release(out);
        scr_str_release(comma);
        out = joined;
      }
      ScrDyn *e = scr_dyn_arr_at(d, (double)i);
      if (!e) { /* an inherited getter threw: the exception is pending */
        scr_str_release(out);
        return NULL;
      }
      if (e->kind == SCR_DYN_UNDEF || e->kind == SCR_DYN_NULL) { /* JS join: empty */
        scr_dyn_release(e);
        if (scr_exc_pending()) {
          scr_str_release(out);
          return NULL;
        }
        continue;
      }
      /* ToString with the object protocol: an element's own or inherited
       * toString/valueOf runs, as in Array.prototype.join. */
      ScrStr *piece = NULL;
      if (e->kind == SCR_DYN_PROXY) scr_dyn_proxy_unsupported("string conversion");
      else piece = scr_dyn_string_coerce_js(e);
      scr_dyn_release(e);
      if (!piece || scr_exc_pending()) {
        scr_str_release(piece);
        scr_str_release(out);
        return NULL;
      }
      ScrStr *joined = scr_str_concat(out, piece);
      scr_str_release(out);
      scr_str_release(piece);
      out = joined;
    }
    return out;
  }
  case SCR_DYN_FUNC: {
    /* The interned builtin constructors print with their names, as in Node
     * (function Map() { [native code] }); other functions without a source
     * text print the anonymous native form. */
    if (d->v.fn.sig && strcmp(d->v.fn.sig, "native:constructor") == 0 && d->v.fn.name) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "function ");
      scr_jb_puts(&b, d->v.fn.name);
      scr_jb_puts(&b, "() { [native code] }");
      return scr_jb_finish(&b);
    }
    static const char f[] = "function () { [native code] }";
    return scr_str_new(f, sizeof f - 1);
  }

  case SCR_DYN_TYPED_REF: {
    ScrDyn *materialized = scr_dyn_typed_ref_string_view(d);
    ScrStr *s = scr_dyn_to_string(materialized, enc);
    scr_dyn_release(materialized);
    return s;
  }
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
  default: {
    static const char msg[] = "Cannot read properties of undefined (reading 'toString')";
    static const char msgn[] = "Cannot read properties of null (reading 'toString')";
    if (d->kind == SCR_DYN_NULL) scr_throw_error_msg(SCR_ERR_TYPE, msgn, sizeof msgn - 1);
    else scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return scr_str_new("", 0);
  }
  }
}

static ScrStr *scr_dyn_to_string_method_args(const ScrDyn *d, const ScrStr *enc, const ScrStr *what,
    ScrDyn *const *args, size_t argc);

/* The METHOD-CALL spelling `d.toString(enc?)` — scr_dyn_to_string with
 * the one receiver whose prototype LACKS the method carved out: a
 * null-prototype dictionary (Object.create(null)) has no toString at
 * all, so Node throws "<spelling> is not a function" where every other
 * OBJ answers "[object Object]". `what` carries the source spelling. */
ScrStr *scr_dyn_to_string_argument(const ScrDyn *d, const ScrDyn *argument, const ScrStr *what) {
  if (d->kind == SCR_DYN_BIGINT) {
    double radix = 10;
    if (argument->kind != SCR_DYN_UNDEF && !scr_dyn_number_coerce_js(argument, &radix)) return NULL;
    return scr_bigint_to_string(d->v.bigint, radix);
  }
  if (d->kind == SCR_DYN_BYTES && d->buffer) {
    if (d->v.bytes->len == 0) return scr_str_new("", 0);
    ScrStr *encoding = argument->kind == SCR_DYN_UNDEF || (argument->kind == SCR_DYN_STR && argument->v.str->len == 0)
      ? scr_str_new("utf8", 4) : scr_dyn_string_coerce_js(argument);
    if (!encoding) return NULL;
    ScrStr *result = scr_bytes_to_str_checked(d->v.bytes, encoding);
    scr_str_release(encoding);
    return result;
  }
  if (d->kind == SCR_DYN_NUM) return scr_num_to_string_radix(d->v.num, argument);
  if (d->kind == SCR_DYN_OBJ && !scr_dyn_property_owner(d, "toString", 8) && !scr_dyn_has_object_prototype(d)) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_write(&b, what->data, what->len);
    scr_jb_puts(&b, " is not a function");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return scr_str_new("", 0);
  }
  /* A toString the program defines receives the argument
   * (`error.toString(compact)`); undefined passes none. */
  ScrDyn *args[1] = {(ScrDyn *)argument};
  return scr_dyn_to_string_method_args(d, NULL, what, args, argument->kind == SCR_DYN_UNDEF ? 0 : 1);
}

/* The METHOD-CALL spelling `d.valueOf()`: a primitive answers itself (the
 * primitive prototypes' valueOf), a Date its time value, an object with a
 * valueOf member the member's result with the object as receiver, and any
 * other object itself (Object.prototype.valueOf). A null-prototype
 * dictionary has no valueOf; it throws "<spelling> is not a function", and
 * null and undefined throw Node's property-read TypeError. `what` carries
 * the source spelling. Returns +1. */
ScrDyn *scr_dyn_value_of(const ScrDyn *d, const ScrStr *what) {
  if (d->kind == SCR_DYN_NULL || d->kind == SCR_DYN_UNDEF) {
    static const char msg[] = "Cannot read properties of undefined (reading 'valueOf')";
    static const char msgn[] = "Cannot read properties of null (reading 'valueOf')";
    if (d->kind == SCR_DYN_NULL) scr_throw_error_msg(SCR_ERR_TYPE, msgn, sizeof msgn - 1);
    else scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  if (d->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("valueOf");
    return NULL;
  }
  if (d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_DATE) {
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(d);
    return ops->invoke(d->v.handle.ptr, (ScrDyn *)d, "valueOf", NULL, 0, "valueOf");
  }
  if (d->kind == SCR_DYN_OBJ && scr_dyn_property_owner(d, "valueOf", 7)) {
    ScrDyn *member = scr_dyn_obj_read(d, "valueOf", 7);
    if (!member) return NULL;
    if (member->kind != SCR_DYN_FUNC) {
      scr_dyn_release(member);
    } else {
      scr_dyn_this_push_dyn(d);
      ScrDyn *value = scr_dyn_call(member, NULL, 0, what->data);
      scr_dyn_this_pop();
      scr_dyn_release(member);
      return value;
    }
  } else if (d->kind != SCR_DYN_OBJ || scr_dyn_has_object_prototype(d)) {
    return scr_dyn_retain((ScrDyn *)d);
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_write(&b, what->data, what->len);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

/* JS String() over the dyn kind — the WebIDL ToString the web globals
 * (atob/btoa, DOMException's name resolution) run on their arguments:
 * the unit kinds RENDER ("null"/"undefined") where the .toString() twin
 * above throws Node's property-read TypeError; every other kind matches
 * scr_dyn_to_string. Borrows d; returns +1. */
ScrStr *scr_dyn_string_coerce(const ScrDyn *d) {
  if (d->kind == SCR_DYN_SYMBOL) {
    static const char message[] = "Cannot convert a Symbol value to a string";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  if (d->kind == SCR_DYN_NULL) return scr_str_new("null", 4);
  if (d->kind == SCR_DYN_UNDEF) return scr_str_new("undefined", 9);
  return scr_dyn_to_string(d, NULL);
}

ScrStr *scr_dyn_string_constructor(const ScrDyn *value) {
  if (value->kind == SCR_DYN_SYMBOL) return value->v.symbol.render(value->v.symbol.value);
  if (value->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("string conversion");
    return NULL;
  }
  return scr_dyn_string_coerce_js(value);
}

ScrDyn *scr_dyn_property_key_value(const ScrDyn *value) {
  if (value->kind == SCR_DYN_SYMBOL || value->kind == SCR_DYN_STR) return scr_dyn_retain((ScrDyn *)value);
  ScrStr *name = scr_dyn_string_coerce_js(value);
  if (!name) return NULL;
  ScrDyn *out = scr_dyn_new_str(name);
  scr_str_release(name);
  return out;
}

static bool scr_dyn_to_primitive_result_is_object(const ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_BYTES:
  case SCR_DYN_FUNC:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_TYPED_REF:
  case SCR_DYN_PROXY:
    return true;

  default:
    return false;
  }
}

/* JS ToString over a dyn value WITH the object protocol (the WHATWG
 * USVString conversions — URLSearchParams names/values): an OBJ whose
 * own 'toString' member is callable is invoked with zero arguments (its
 * throw propagates, catchably); without an own member, an ordinary object
 * inherits Object.prototype.toString and answers "[object Object]". A
 * non-primitive answer falls through to 'valueOf' (ToPrimitive's string
 * hint); exhaustion is the spec's
 * "Cannot convert object to primitive value" TypeError. Every other
 * kind matches scr_dyn_string_coerce (units RENDER — ToString(null) is
 * "null"). Borrows; +1, or NULL with the exception pending. */
ScrStr *scr_dyn_string_coerce_js(const ScrDyn *d) {
  if (d->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("Symbol.toPrimitive lookup");
    return NULL;
  }
  if (d->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_string_view(d);
    ScrStr *out = scr_dyn_string_coerce_js(materialized);
    scr_dyn_release(materialized);
    return out;
  }
  if (d->kind == SCR_DYN_OBJ) {
    static const char *const hint[2] = { "toString", "valueOf" };
    for (int i = 0; i < 2; i++) {
      const ScrDyn *owner = scr_dyn_property_owner(d, hint[i], strlen(hint[i]));
      ScrDyn *m = owner ? scr_dyn_obj_read(d, hint[i], strlen(hint[i])) : NULL;
      if (scr_exc_pending()) { scr_dyn_release(m); return NULL; }
      if (!m && i == 0 && scr_dyn_has_object_prototype(d)) {
        // Checked Error values retain their Error.prototype formatter even
        // when their fields are exposed through the cached object view.
        ScrError *error = scr_errdyn_err_of(d);
        if (error) {
          ScrStr *text = scr_error_to_string(error);
          scr_error_release(error);
          return text;
        }
        return scr_str_new("[object Object]", 15);
      }
      if (!m || m->kind != SCR_DYN_FUNC) { scr_dyn_release(m); continue; }
      /* OrdinaryToPrimitive performs a method call, not a bare function
       * call: an own coercion hook observes the source object as `this`. */
      scr_dyn_this_push_dyn(d);
      ScrDyn *r = scr_dyn_call(m, NULL, 0, hint[i]);
      scr_dyn_this_pop();
      scr_dyn_release(m);
      if (!r) return NULL; /* the method threw — pending */
      if (scr_dyn_to_primitive_result_is_object(r)) {
        scr_dyn_release(r); /* non-primitive answer: try the next method */
        continue;
      }
      ScrStr *s = scr_dyn_string_coerce(r);
      scr_dyn_release(r);
      return s;
    }
    static const char msg[] = "Cannot convert object to primitive value";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  return scr_dyn_string_coerce(d);
}

/* ToString, then each lone surrogate becomes U+FFFD. */
ScrStr *scr_util_to_usv_string(const ScrDyn *input) {
  ScrStr *text = scr_util_to_string(input);
  if (!text) return NULL;
  ScrStr *usv = scr_str_to_well_formed(text);
  scr_str_release(text);
  return usv;
}

/* ToString, preserving the object protocol. */
ScrStr *scr_util_to_string(const ScrDyn *input) {
  const ScrDyn *value = input ? input : scr_dyn_undefined();
  if (scr_to_primitive_symbol && scr_iterator_object(value)) {
    ScrDyn *method = scr_dyn_reflect_get((ScrDyn *)value, scr_to_primitive_symbol, (ScrDyn *)value);
    if (!method) return NULL;
    if (method->kind != SCR_DYN_UNDEF && method->kind != SCR_DYN_NULL) {
      if (!scr_dyn_is_callable(method)) {
        ScrJsonBuf buffer;
        scr_jb_init(&buffer);
        if (scr_iterator_object(method)) scr_jb_puts(&buffer, "object");
        else {
          ScrStr *type = scr_dyn_typeof(method);
          scr_jb_put_str(&buffer, type);
          scr_str_release(type);
          if (method->kind != SCR_DYN_SYMBOL && method->kind != SCR_DYN_BIGINT) scr_jb_puts(&buffer, " ");
          if (method->kind == SCR_DYN_STR) {
            scr_jb_puts(&buffer, "\"");
            scr_jb_put_str(&buffer, method->v.str);
            scr_jb_puts(&buffer, "\"");
          }
          else if (method->kind != SCR_DYN_SYMBOL && method->kind != SCR_DYN_BIGINT) {
            ScrStr *text = scr_dyn_string_coerce(method);
            scr_jb_put_str(&buffer, text);
            scr_str_release(text);
          }
        }
        scr_jb_puts(&buffer, " is not a function");
        ScrStr *message = scr_jb_finish(&buffer);
        scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
        scr_str_release(message);
        scr_dyn_release(method);
        return NULL;
      }
      ScrStr *hint = scr_str_new("string", 6);
      ScrDyn *argument = scr_dyn_new_str(hint);
      scr_str_release(hint);
      scr_dyn_this_push_dyn(value);
      ScrDyn *primitive = scr_dyn_call(method, &argument, 1, "Symbol.toPrimitive");
      scr_dyn_this_pop();
      scr_dyn_release(argument);
      scr_dyn_release(method);
      if (!primitive) return NULL;
      if (scr_dyn_to_primitive_result_is_object(primitive)) {
        static const char message[] = "Cannot convert object to primitive value";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        scr_dyn_release(primitive);
        return NULL;
      }
      ScrStr *text = scr_dyn_string_coerce(primitive);
      scr_dyn_release(primitive);
      return text;
    }
    scr_dyn_release(method);
  }
  return scr_dyn_string_coerce_js(value);
}

/* JS ToNumber over a checked-dynamic value, including OrdinaryToPrimitive's
 * NUMBER hint for object snapshots. This is the numeric twin of
 * scr_dyn_string_coerce_js above: valueOf precedes toString, inherited
 * Object.prototype.valueOf returns the receiver (so conversion continues),
 * and the inherited toString fallback supplies "[object Object]". Borrows d;
 * false means an object hook threw or no primitive value could be produced. */
bool scr_dyn_number_coerce_js(const ScrDyn *d, double *out) {
  if (d->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("Symbol.toPrimitive lookup");
    return false;
  }
  if (d->kind == SCR_DYN_TYPED_REF) {
    /* An instance of a class declared `extends Date` converts through its
     * valueOf, declared or inherited. */
    double time;
    ScrDyn *materialized = scr_dyn_date_class_time(d, &time) ? scr_dyn_date_class_value_of(d)
                                                              : scr_dyn_typed_ref_materialize(d);
    if (!materialized) return false;
    bool ok = scr_dyn_number_coerce_js(materialized, out);
    scr_dyn_release(materialized);
    return ok;
  }
  switch (d->kind) {
  case SCR_DYN_SYMBOL: {
    static const char message[] = "Cannot convert a Symbol value to a number";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  case SCR_DYN_NULL:
    *out = 0.0;
    return true;
  case SCR_DYN_BOOL:
    *out = d->v.b ? 1.0 : 0.0;
    return true;
  case SCR_DYN_BIGINT: {
    static const char message[] = "Cannot convert a BigInt value to a number";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  case SCR_DYN_NUM:
    *out = d->v.num;
    return true;
  case SCR_DYN_STR:
    *out = scr_string_to_number(d->v.str);
    return true;
  case SCR_DYN_UNDEF:
    *out = NAN;
    return true;
  case SCR_DYN_OBJ: {
    static const char *const hint[2] = { "valueOf", "toString" };
    for (int i = 0; i < 2; i++) {
      const ScrDyn *owner = scr_dyn_property_owner(d, hint[i], strlen(hint[i]));
      ScrDyn *m = owner ? scr_dyn_obj_read(d, hint[i], strlen(hint[i])) : NULL;
      if (!m) {
        if (scr_dyn_has_object_prototype(d) && i == 0) {
          /* Inherited Object.prototype.valueOf returns the object, so the
           * number-hint protocol advances to toString. */
          continue;
        }
        if (i == 1 && scr_dyn_error_encoding(d)) {
          ScrStr *text = scr_dyn_error_string(d);
          if (!text) return false;
          *out = scr_string_to_number(text);
          scr_str_release(text);
          return true;
        }
        if (scr_dyn_has_object_prototype(d) && i == 1) {
          *out = NAN; /* Number("[object Object]") */
          return true;
        }
        continue;
      }
      if (m->kind != SCR_DYN_FUNC) { scr_dyn_release(m); continue; }
      scr_dyn_this_push_dyn(d);
      ScrDyn *r = scr_dyn_call(m, NULL, 0, hint[i]);
      scr_dyn_this_pop();
      scr_dyn_release(m);
      if (!r) return false;
      if (scr_dyn_to_primitive_result_is_object(r)) {
        scr_dyn_release(r);
        continue;
      }
      bool ok = scr_dyn_number_coerce_js(r, out);
      scr_dyn_release(r);
      return ok;
    }
    static const char msg[] = "Cannot convert object to primitive value";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return false;
  }
  default: {
    /* A Date's valueOf answers its time value. */
    if (scr_dyn_is_date(d)) {
      ScrDyn *time = scr_dyn_date_value_of(d);
      if (!time) return false;
      *out = time->v.num;
      scr_dyn_release(time);
      return true;
    }
    /* Arrays, byte views, functions, promises, and native handles inherit a
     * valueOf that returns the receiver, then use their existing JS-exact
     * string rendering for the numeric conversion. */
    ScrStr *text = scr_dyn_string_coerce(d);
    if (!text) return false;
    *out = scr_string_to_number(text);
    scr_str_release(text);
    return true;
  }
  }
}

double scr_dyn_number_coerce(const ScrDyn *d) {
  double out = NAN;
  (void)scr_dyn_number_coerce_js(d, &out);
  return out;
}

static ScrDyn *scr_dyn_add_primitive(const ScrDyn *d);

/* ToPrimitive with the number hint, which differs from the default hint
 * only for a Date: its time value, or the valueOf of an instance of a class
 * declared `extends Date`. */
static ScrDyn *scr_dyn_number_primitive(const ScrDyn *d) {
  if (scr_dyn_is_date(d)) return scr_dyn_date_value_of(d);
  double time;
  if (d->kind == SCR_DYN_TYPED_REF && scr_dyn_date_class_time(d, &time)) {
    ScrDyn *value = scr_dyn_date_class_value_of(d);
    ScrDyn *out = value ? scr_dyn_add_primitive(value) : NULL;
    scr_dyn_release(value);
    return out;
  }
  return scr_dyn_add_primitive(d);
}

double scr_dyn_number_constructor(const ScrDyn *d) {
  ScrDyn *primitive = scr_dyn_number_primitive(d);
  if (!primitive) return NAN;
  double result = primitive->kind == SCR_DYN_BIGINT
    ? scr_bigint_to_f64(primitive->v.bigint) : scr_dyn_number_coerce(primitive);
  scr_dyn_release(primitive);
  return result;
}

static ScrBigInt *scr_dyn_bigint_convert(const ScrDyn *d, bool allow_number) {
  ScrDyn *primitive = scr_dyn_number_primitive(d);
  if (!primitive) return NULL;
  ScrBigInt *result = NULL;
  switch (primitive->kind) {
  case SCR_DYN_BIGINT: result = scr_bigint_retain(primitive->v.bigint); break;
  case SCR_DYN_STR: result = scr_bigint_parse(primitive->v.str); break;
  case SCR_DYN_NUM:
    if (allow_number) result = scr_bigint_from_f64(primitive->v.num);
    else {
      ScrStr *text = scr_dyn_string_coerce_js(primitive);
      ScrJsonBuf message;
      scr_jb_init(&message);
      scr_jb_puts(&message, "Cannot convert ");
      scr_jb_write(&message, text->data, text->len);
      scr_jb_puts(&message, " to a BigInt");
      scr_str_release(text);
      scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    }
    break;
  case SCR_DYN_BOOL: result = scr_bigint_from_i64(primitive->v.b ? 1 : 0); break;
  default: {
    const char *message = primitive->kind == SCR_DYN_NULL ? "Cannot convert null to a BigInt"
      : primitive->kind == SCR_DYN_UNDEF ? "Cannot convert undefined to a BigInt" : "Cannot convert Symbol() to a BigInt";
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    break;
  }
  }
  scr_dyn_release(primitive);
  return result;
}

ScrBigInt *scr_dyn_bigint_constructor(const ScrDyn *d) {
  return scr_dyn_bigint_convert(d, true);
}

ScrBigInt *scr_dyn_bigint_coerce(const ScrDyn *d) {
  return scr_dyn_bigint_convert(d, false);
}

/* OrdinaryToPrimitive's default hint is numeric for the represented
 * ordinary objects. Retain the primitive itself: addition must choose
 * string concatenation before either side is converted to a number. */
static ScrDyn *scr_dyn_add_primitive(const ScrDyn *d) {
  if (d->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("Symbol.toPrimitive lookup");
    return NULL;
  }
  if (d->kind == SCR_DYN_TYPED_REF) {
    /* A Date's default hint is string: an instance of a class declared
     * `extends Date` adds through its toString. */
    double time;
    if (scr_dyn_date_class_time(d, &time)) {
      ScrDyn *text = scr_dyn_date_class_to_string(d);
      ScrDyn *out = text ? scr_dyn_add_primitive(text) : NULL;
      scr_dyn_release(text);
      return out;
    }
    ScrDyn *view = scr_dyn_typed_ref_materialize(d);
    ScrDyn *out = scr_exc_pending() ? NULL : scr_dyn_add_primitive(view);
    scr_dyn_release(view);
    return out;
  }

  if (d->kind == SCR_DYN_OBJ) {
    static const char *const methods[] = { "valueOf", "toString" };
    for (size_t i = 0; i < 2; i++) {
      const ScrDyn *owner = scr_dyn_property_owner(d, methods[i], strlen(methods[i]));
      ScrDyn *method = owner ? scr_dyn_obj_read(d, methods[i], strlen(methods[i])) : NULL;
      if (!method) {
        if (i == 1 && scr_dyn_error_encoding(d)) {
          ScrStr *str = scr_dyn_error_string(d);
          if (!str) return NULL;
          ScrDyn *out = scr_dyn_new_str(str);
          scr_str_release(str);
          return out;
        }
        if (i == 1 && scr_dyn_has_object_prototype(d)) {
          ScrStr *str = scr_str_new("[object Object]", 15);
          ScrDyn *out = scr_dyn_new_str(str);
          scr_str_release(str);
          return out;
        }
        continue;
      }
      if (method->kind != SCR_DYN_FUNC) { scr_dyn_release(method); continue; }
      scr_dyn_this_push_dyn(d);
      ScrDyn *out = scr_dyn_call(method, NULL, 0, methods[i]);
      scr_dyn_this_pop();
      scr_dyn_release(method);
      if (!out) return NULL;
      if (!scr_dyn_to_primitive_result_is_object(out)) return out;
      scr_dyn_release(out);
    }
    static const char msg[] = "Cannot convert object to primitive value";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  if (!scr_dyn_to_primitive_result_is_object(d)) return scr_dyn_retain((ScrDyn *)d);
  ScrStr *str = scr_dyn_string_coerce(d);
  if (!str) return NULL;
  ScrDyn *out = scr_dyn_new_str(str);
  scr_str_release(str);
  return out;
}

ScrDyn *scr_dyn_add(const ScrDyn *left, const ScrDyn *right) {
  ScrDyn *l = scr_dyn_add_primitive(left);
  if (!l || scr_exc_pending()) { scr_dyn_release(l); return NULL; }
  ScrDyn *r = scr_dyn_add_primitive(right);
  if (!r || scr_exc_pending()) { scr_dyn_release(l); scr_dyn_release(r); return NULL; }
  ScrDyn *out = NULL;
  if (l->kind == SCR_DYN_STR || r->kind == SCR_DYN_STR) {
    ScrStr *ls = scr_dyn_string_coerce(l);
    ScrStr *rs = ls ? scr_dyn_string_coerce(r) : NULL;
    if (ls && rs) {
      ScrStr *joined = scr_str_concat(ls, rs);
      out = scr_dyn_new_str(joined);
      scr_str_release(joined);
    }
    scr_str_release(ls);
    scr_str_release(rs);
  } else if (l->kind == SCR_DYN_BIGINT || r->kind == SCR_DYN_BIGINT) {
    if (l->kind == SCR_DYN_BIGINT && r->kind == SCR_DYN_BIGINT) {
      ScrBigInt *sum = scr_bigint_add(l->v.bigint, r->v.bigint);
      out = scr_dyn_new_bigint(sum);
      scr_bigint_release(sum);
    } else {
      static const char message[] = "Cannot mix BigInt and other types, use explicit conversions";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    }
  } else {
    double ln, rn;
    if (scr_dyn_number_coerce_js(l, &ln) && scr_dyn_number_coerce_js(r, &rn)) {
      out = scr_dyn_new_num(ln + rn);
    }
  }
  scr_dyn_release(l);
  scr_dyn_release(r);
  return out;
}

ScrDyn *scr_dyn_to_numeric(const ScrDyn *value) {
  ScrDyn *primitive = scr_dyn_number_primitive(value);
  if (!primitive) return NULL;
  if (primitive->kind == SCR_DYN_BIGINT) return primitive;
  double number;
  bool converted = scr_dyn_number_coerce_js(primitive, &number);
  scr_dyn_release(primitive);
  return converted ? scr_dyn_new_num(number) : NULL;
}

ScrDyn *scr_dyn_increment(const ScrDyn *value, bool increment) {
  if (value->kind == SCR_DYN_BIGINT) {
    ScrBigInt *one = scr_bigint_from_i64(1);
    ScrBigInt *next = increment ? scr_bigint_add(value->v.bigint, one) : scr_bigint_sub(value->v.bigint, one);
    ScrDyn *out = scr_dyn_new_bigint(next);
    scr_bigint_release(next);
    scr_bigint_release(one);
    return out;
  }
  return scr_dyn_new_num(value->v.num + (increment ? 1 : -1));
}

bool scr_dyn_compare(const ScrDyn *left, const ScrDyn *right, const ScrStr *operation) {
  // ToPrimitive is observable and always visits the original left operand
  // first, including the > and <= spellings of relational comparison.
  ScrDyn *l = scr_dyn_number_primitive(left);
  if (!l) return false;
  ScrDyn *r = scr_dyn_number_primitive(right);
  if (!r) { scr_dyn_release(l); return false; }
  double order = 2;
  if (l->kind == SCR_DYN_STR && r->kind == SCR_DYN_STR) {
    int compared = scr_str_cmp_u16(l->v.str, r->v.str);
    order = compared < 0 ? -1 : compared > 0 ? 1 : 0;
  } else if (l->kind == SCR_DYN_BIGINT && r->kind == SCR_DYN_STR) {
    order = scr_bigint_cmp_string(l->v.bigint, r->v.str);
  } else if (l->kind == SCR_DYN_STR && r->kind == SCR_DYN_BIGINT) {
    double opposite = scr_bigint_cmp_string(r->v.bigint, l->v.str);
    order = opposite == 2 ? 2 : -opposite;
  } else if (l->kind == SCR_DYN_BIGINT && r->kind == SCR_DYN_BIGINT) {
    order = scr_bigint_cmp_f64(l->v.bigint, r->v.bigint);
  } else {
    double a = 0, b = 0;
    bool valid = (l->kind == SCR_DYN_BIGINT || scr_dyn_number_coerce_js(l, &a)) &&
      (r->kind == SCR_DYN_BIGINT || scr_dyn_number_coerce_js(r, &b));
    if (valid) {
      if (l->kind == SCR_DYN_BIGINT) order = scr_bigint_cmp_number(l->v.bigint, b);
      else if (r->kind == SCR_DYN_BIGINT) {
        double opposite = scr_bigint_cmp_number(r->v.bigint, a);
        order = opposite == 2 ? 2 : -opposite;
      } else if (!isnan(a) && !isnan(b)) order = a < b ? -1 : a > b ? 1 : 0;
    }
  }
  scr_dyn_release(l);
  scr_dyn_release(r);
  if (scr_exc_pending() || order == 2) return false;
  return operation->data[0] == '<'
    ? (operation->len == 2 ? order <= 0 : order < 0)
    : (operation->len == 2 ? order >= 0 : order > 0);
}

ScrDyn *scr_dyn_arithmetic(const ScrDyn *left, const ScrDyn *right, const ScrStr *operation) {
  ScrDyn *l = scr_dyn_to_numeric(left);
  if (!l) return NULL;
  ScrDyn *r = scr_dyn_to_numeric(right);
  if (!r) { scr_dyn_release(l); return NULL; }
  ScrDyn *out = NULL;
  char op = operation->data[0];
  if (l->kind != r->kind) {
    static const char message[] = "Cannot mix BigInt and other types, use explicit conversions";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  } else if (l->kind == SCR_DYN_BIGINT) {
    ScrBigInt *result = op == '-' ? scr_bigint_sub(l->v.bigint, r->v.bigint)
      : op == '/' ? scr_bigint_div(l->v.bigint, r->v.bigint)
      : op == '%' ? scr_bigint_mod(l->v.bigint, r->v.bigint)
      : operation->len == 2 ? scr_bigint_pow(l->v.bigint, r->v.bigint)
      : scr_bigint_mul(l->v.bigint, r->v.bigint);
    if (result) { out = scr_dyn_new_bigint(result); scr_bigint_release(result); }
  } else {
    double a = l->v.num, b = r->v.num;
    // ECMAScript differs from libm for ±1 ** ±Infinity and 1 ** NaN.
    double result = op == '-' ? a - b : op == '/' ? a / b : op == '%' ? fmod(a, b)
      : operation->len == 2 ? ((fabs(a) == 1 && !isfinite(b)) ? NAN : pow(a, b)) : a * b;
    out = scr_dyn_new_num(result);
  }
  scr_dyn_release(l);
  scr_dyn_release(r);
  return out;
}

ScrDyn *scr_dyn_bitwise(const ScrDyn *left, const ScrDyn *right, const ScrStr *operation) {
  bool unary = operation->len == 1 && operation->data[0] == '~';
  ScrDyn *l = scr_dyn_to_numeric(left);
  if (!l) return NULL;
  ScrDyn *r = unary ? NULL : scr_dyn_to_numeric(right);
  if (!unary && !r) { scr_dyn_release(l); return NULL; }
  ScrDyn *out = NULL;
  char op = operation->data[0];
  if (!unary && l->kind != r->kind) {
    static const char message[] = "Cannot mix BigInt and other types, use explicit conversions";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  } else if (l->kind == SCR_DYN_BIGINT) {
    ScrBigInt *result = NULL;
    if (unary) result = scr_bigint_not(l->v.bigint);
    else if (op == '&') result = scr_bigint_and(l->v.bigint, r->v.bigint);
    else if (op == '|') result = scr_bigint_or(l->v.bigint, r->v.bigint);
    else if (op == '^') result = scr_bigint_xor(l->v.bigint, r->v.bigint);
    else if (op == '<') result = scr_bigint_shl(l->v.bigint, r->v.bigint);
    else if (operation->len == 2) result = scr_bigint_shr(l->v.bigint, r->v.bigint);
    else {
      static const char message[] = "BigInts have no unsigned right shift, use >> instead";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    }
    if (result) { out = scr_dyn_new_bigint(result); scr_bigint_release(result); }
  } else {
    double result;
    if (unary) result = scr_bit_not(l->v.num);
    else if (op == '&') result = scr_bit_and(l->v.num, r->v.num);
    else if (op == '|') result = scr_bit_or(l->v.num, r->v.num);
    else if (op == '^') result = scr_bit_xor(l->v.num, r->v.num);
    else if (op == '<') result = scr_bit_shl(l->v.num, r->v.num);
    else if (operation->len == 2) result = scr_bit_shr(l->v.num, r->v.num);
    else result = scr_bit_ushr(l->v.num, r->v.num);
    out = scr_dyn_new_num(result);
  }
  scr_dyn_release(l);
  scr_dyn_release(r);
  return out;
}

/* The checked-dynamic keyed WRITE (`h.k = v` on a dyn receiver): OBJ sets
 * the member (later writes win, insertion order — JS); undefined/null
 * throws Node's "Cannot set properties of ..."; every other kind throws
 * Node's strict-mode "Cannot create property ..." (sloppy mode would
 * ignore the write; this runtime throws in both, SEMANTICS.md). Receiver, key, and
 * value are all BORROWED (the member retains the value in). */
static const char *scr_dyn_kind_name(const ScrDyn *d);
/* `key in v` with a RUNTIME key (the compile-time dynHasKey fold, per
 * value): OBJ answers own-member presence, ARR answers 'length' or a
 * valid dense index, every other kind false (tsc admits `in` only on
 * object-typed operands). Proxy traps may throw. Borrows both. */
bool scr_dyn_has_key(const ScrDyn *v, const ScrStr *key) {
  if (scr_dyn_generator(v)) {
    static const char *const inherited[] = { "next", "return", "throw", "constructor", "toString", "valueOf", "hasOwnProperty", "propertyIsEnumerable", "isPrototypeOf", "toLocaleString", "__proto__" };
    for (size_t i = 0; i < sizeof inherited / sizeof inherited[0]; i++)
      if (key->len == strlen(inherited[i]) && memcmp(key->data, inherited[i], key->len) == 0) return true;
    return false;
  }
  if (scr_dyn_class_reflection_fence(v)) return false;
  if (v->kind == SCR_DYN_PROXY) return scr_dyn_proxy_has(v, key);

  if (v->kind == SCR_DYN_TYPED_REF) {
    if (scr_typed_ref_array_has_own(v, key)) return true;
    const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
    if (record) {
      /* With no checked view, the snapshot holds exactly the present fields. */
      size_t field;
      return scr_typed_ref_record_field(record, key, &field) && record->has(v->v.typed_ref.ptr, field);
    }
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(v);
    bool out = scr_dyn_has_key(materialized, key);
    scr_dyn_release(materialized);
    return out;
  }
  if (v->kind == SCR_DYN_OBJ) {
    return scr_dyn_property_owner(v, key->data, key->len) != NULL;
  }
  if (v->kind == SCR_DYN_FUNC) {
    if (scr_dyn_property_owner(v, key->data, key->len)) return true;
    ScrDyn *descriptor = scr_dyn_own_descriptor(v, key);
    bool present = descriptor && descriptor->kind != SCR_DYN_UNDEF;
    scr_dyn_release(descriptor);
    if (!present && !scr_exc_pending()) {
      static const char *const inherited[] = {
        "name", "length", "call", "apply", "bind", "toString", "valueOf", "toLocaleString",
        "hasOwnProperty", "propertyIsEnumerable", "isPrototypeOf", "constructor", "__proto__",
        "caller", "arguments",
      };
      for (size_t i = 0; i < sizeof inherited / sizeof inherited[0]; i++) {
        if (key->len == strlen(inherited[i]) && memcmp(key->data, inherited[i], key->len) == 0) return true;
      }
    }
    return present;
  }
  if (v->kind == SCR_DYN_ARR) {
    if (key->len == 6 && memcmp(key->data, "length", 6) == 0) return true;
    if (v->v.arr.properties && scr_dyn_obj_get(v->v.arr.properties, key->data, key->len)) return true;
    const ScrDyn *prototype = v->prototype ? v->prototype : !v->null_proto && v != scr_builtin_array_prototype ? scr_builtin_array_prototype : NULL;
    if (prototype && scr_dyn_has_key(prototype, key)) return true;
    if (key->len == 0 || key->len > 10) return false;
    size_t idx = 0;
    for (size_t i = 0; i < key->len; i++) {
      char c = key->data[i];
      if (c < '0' || c > '9') return false;
      if (i > 0 && idx == 0) return false; /* a leading zero is no canonical index */
      if (idx > (4294967294ULL - (size_t)(c - '0')) / 10) return false;
      idx = idx * 10 + (size_t)(c - '0');
    }
    return scr_dyn_arr_has_index(v, idx);
  }
  if (v->kind == SCR_DYN_STR)
    return scr_dyn_canonical_own_index(key, (size_t)scr_str_utf16_len(v->v.str));
  return false;
}

/* The `in` operator: scr_dyn_has_key's own-chain answer, plus the members
 * every chain inherits from its builtin prototype (Object.prototype, and
 * Array.prototype before it for arrays) and, for a class instance seen as
 * `unknown`, its class's compiled methods and accessors. */
bool scr_dyn_in(const ScrDyn *v, const ScrStr *key) {
#ifdef SCR_NODE_ISLANDS
  if (scr_ni_is_handle(v)) {
    ScrDyn *k = scr_dyn_new_str((ScrStr *)key);
    int found = scr_ni_has((ScrDyn *)v, k);
    scr_dyn_release(k);
    return found == 1;
  }
#endif
  /* Generator objects have no checked view; scr_dyn_has_key answers their
   * prototype members. */
  if (v->kind == SCR_DYN_TYPED_REF && !scr_dyn_generator(v)) {
    if (scr_typed_ref_array_has_own(v, key)) return true;
    const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
    if (record) {
      /* With no checked view, the snapshot's prototype is Object.prototype. */
      return scr_dyn_has_key(v, key) || scr_dyn_object_proto_name(key);
    }
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(v);
    if (scr_exc_pending()) { scr_dyn_release(materialized); return false; }
    const ScrDynTypedClassOps *klass = scr_typed_ref_class_ops(v);
    bool out;
    if (klass && materialized->kind == SCR_DYN_OBJ && !materialized->prototype && !materialized->null_proto) {
      /* An instance view keeps only own fields; its class prototype chain
       * contributes the compiled methods and accessors. */
      out = scr_dyn_property_owner(materialized, key->data, key->len) ||
            scr_dyn_name_in_strs(key, klass->names, klass->count) || scr_dyn_object_proto_name(key);
    } else {
      out = scr_dyn_in(materialized, key);
    }
    scr_dyn_release(materialized);
    return out;
  }
  if (v->kind == SCR_DYN_PROXY) return scr_dyn_proxy_has(v, key);
  if (v->kind == SCR_DYN_BYTES) return scr_dyn_bytes_in(v, key);
  if (v->kind == SCR_DYN_HANDLE) return scr_dyn_handle_in(v, key);
  if (scr_dyn_has_key(v, key)) return true;
  if (scr_exc_pending()) return false;
  if (v->kind == SCR_DYN_OBJ) return scr_dyn_builtin_inherited(v, key);
  if (v->kind == SCR_DYN_ARR) {
    if (v->prototype) return scr_dyn_in(v->prototype, key);
    return !v->null_proto && (scr_dyn_array_proto_name(key) || scr_dyn_object_proto_name(key));
  }
  if (v->kind == SCR_DYN_PROMISE) {
    /* Promise.prototype's methods, then Object.prototype's names. */
    static const char *const names[] = {"then", "catch", "finally"};
    for (size_t i = 0; i < 3; i++)
      if (strlen(names[i]) == key->len && memcmp(names[i], key->data, key->len) == 0) return true;
    return scr_dyn_object_proto_name(key);
  }
  return false;
}

static void scr_dyn_object_key_set(ScrDyn *recv, ScrStr *key, ScrDyn *value, const ScrDyn *receiver) {
  for (size_t i = 0; i < recv->v.obj.len; i++) {
    ScrDynEntry *entry = &recv->v.obj.entries[i];
    if (entry->key_len != key->len || memcmp(entry->key, key->data, key->len) != 0) continue;
    if (entry->accessor && entry->setter) {
      ScrDyn *args[] = {value};
      ScrDyn *setter = scr_dyn_retain(entry->setter);
      scr_dyn_this_push_dyn(receiver);
      ScrDyn *result = scr_dyn_call(setter, args, 1, "setter");
      scr_dyn_this_pop();
      scr_dyn_release(setter);
      scr_dyn_release(result);
      return;
    }
    if (entry->accessor || !entry->writable) {
      static const char msg[] = "Cannot assign to read only property";
      scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      return;
    }
  }
  if (!scr_dyn_entry(recv, key)) {
    for (const ScrDyn *current = scr_dyn_proto_next(recv); current;) {
      ScrDyn *table = current->kind == SCR_DYN_FUNC ? scr_dyn_fn_properties(current) : NULL;
      const ScrDyn *object = table ? table : current;
      if (object->kind != SCR_DYN_OBJ) { scr_dyn_release(table); break; }
      ScrDynEntry *inherited = scr_dyn_entry((ScrDyn *)object, key);
      if (!inherited) {
        current = scr_dyn_proto_next(object);
        scr_dyn_release(table);
        continue;
      }
      if (inherited->accessor && inherited->setter) {
        ScrDyn *args[] = {value};
        ScrDyn *setter = scr_dyn_retain(inherited->setter);
        scr_dyn_this_push_dyn(receiver);
        ScrDyn *result = scr_dyn_call(setter, args, 1, "setter");
        scr_dyn_this_pop();
        scr_dyn_release(setter);
        scr_dyn_release(result);
        scr_dyn_release(table);
        return;
      }
      if (inherited->accessor || !inherited->writable) {
        static const char message[] = "Cannot assign to read only property";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        scr_dyn_release(table);
        return;
      }
      scr_dyn_release(table);
      break;
    }
  }
  if (recv->non_extensible && !scr_dyn_entry(recv, key)) {
    ScrJsonBuf buffer;
    scr_jb_init(&buffer);
    scr_jb_puts(&buffer, "Cannot add property ");
    scr_jb_write(&buffer, key->data, key->len);
    scr_jb_puts(&buffer, ", object is not extensible");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&buffer));
    return;
  }
  bool created = scr_dyn_entry(recv, key) == NULL;
  scr_dyn_obj_set(recv, key->data, key->len, scr_dyn_retain(value));
  if (created && key->len == 5 && memcmp(key->data, "stack", 5) == 0 &&
      scr_errdyn_find(recv, false) != SIZE_MAX) {
    /* An error's own `stack` exists from construction as a non-enumerable
     * data property, so assigning it adds no enumerable key. */
    ScrDynEntry *entry = scr_dyn_entry(recv, key);
    if (entry) entry->enumerable = false;
  }
  scr_error_sync_cause(recv, key);
  return;
}

void scr_dyn_arr_named_put(ScrDyn *arr, const char *key, size_t key_len, ScrDyn *value) {
  if (!arr->v.arr.properties) {
    scr_dyn_region_store(arr, NULL); /* a table that later holds anything */
    arr->v.arr.properties = scr_dyn_new_obj();
  }
  scr_dyn_obj_set(arr->v.arr.properties, key, key_len, value);
}

void scr_dyn_key_set(ScrDyn *recv, ScrStr *key, ScrDyn *value) {
  if (scr_dyn_class_reflection_fence(recv) || scr_dyn_error_prototype_fence(recv)) return;
  if (recv->kind == SCR_DYN_PROXY) { scr_dyn_proxy_set(recv, key, value); return; }
  if (recv->kind == SCR_DYN_TYPED_REF) {
    if (scr_typed_ref_array_set(recv, key, value)) return;
    if (scr_event_ref_hooks && scr_event_ref_hooks->set(recv, key, value)) return;
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(recv);
    scr_dyn_key_set(materialized, key, value);
    if (!scr_exc_pending()) {
      scr_dyn_typed_ref_commit(recv);
      /* An Error subclass's class commit writes its declared fields; the
       * slots it inherits from Error take the write here. */
      scr_error_sync_slots(recv, materialized, key);
    }
    scr_dyn_release(materialized);
    return;
  }
  if (recv->kind == SCR_DYN_OBJ) {
    scr_dyn_object_key_set(recv, key, value, recv);
    return;
  }
  if (recv->kind == SCR_DYN_FUNC) {
    if (scr_dyn_fn_property_fence(key)) return;
    bool limit = scr_dyn_is_stack_limit(recv, key->data, key->len);
    /* A frozen Error keeps the limit read-only. */
    if (limit && value->kind == SCR_DYN_NUM && !scr_dyn_stack_limit_shadowed(recv) && !scr_dyn_is_frozen(recv)) {
      scr_stack_limit_set(value->v.num);
      return;
    }
    ScrDyn *table = scr_dyn_fn_properties(recv);
    scr_dyn_object_key_set(table, key, value, recv);
    /* A number the own data property takes also sets the limit. */
    ScrDynEntry *own = limit && value->kind == SCR_DYN_NUM && !scr_exc_pending()
        ? scr_dyn_find_entry(table, key->data, key->len)
        : NULL;
    if (own && own->value == value) scr_stack_limit_set(value->v.num);
    scr_dyn_release(table);
    return;
  }
  if (recv->kind == SCR_DYN_ARR) {
    if (key->len == 6 && memcmp(key->data, "length", 6) == 0) {
      if (recv->v.arr.frozen) {
        static const char message[] = "Cannot assign to read only property";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return;
      }
      double number;
      if (!scr_dyn_number_coerce_js(value, &number)) return;
      if (!isfinite(number) || number < 0 || number > 4294967295.0 || trunc(number) != number) {
        static const char message[] = "Invalid array length";
        scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
        return;
      }
      size_t length = (size_t)number;
      if (length > recv->v.arr.len + 1000000) {
        static const char message[] = "Checked array growth exceeds the native allocation limit";
        scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
        return;
      }
      while (recv->v.arr.len < length) scr_dyn_arr_push_hole(recv);
      while (recv->v.arr.len > length) {
        if (recv->v.arr.sealed && scr_dyn_arr_has_index(recv, recv->v.arr.len - 1)) {
          static const char message[] = "Cannot delete non-configurable property";
          scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
          return;
        }
        scr_dyn_release(recv->v.arr.items[--recv->v.arr.len]);
      }
      return;
    }
    /* Canonical indexes extend the dense portion; other names live in the
     * array's own property table. */
    size_t idx = 0;
    int is_index = key->len > 0 && !(key->len > 1 && key->data[0] == '0');
    for (size_t i = 0; is_index && i < key->len; i++) {
      if (key->data[i] < '0' || key->data[i] > '9') is_index = 0;
      else if (idx > (4294967295ULL - (size_t)(key->data[i] - '0')) / 10) is_index = 0;
      else idx = idx * 10 + (size_t)(key->data[i] - '0');
    }
    if (is_index && idx < 4294967295ULL) {
      if (scr_dyn_array_prototype_element_fence(recv)) return;
      if (recv->v.arr.frozen && idx < recv->v.arr.len) {
        static const char message[] = "Cannot assign to read only property";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return;
      }
      if (recv->non_extensible && !scr_dyn_arr_has_index(recv, idx)) {
        static const char message[] = "Cannot add property, object is not extensible";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return;
      }
      if (idx > recv->v.arr.len + 1000000) {
        static const char message[] = "Sparse array writes are not supported yet";
        scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
        return;
      }
      while (recv->v.arr.len <= idx) {
        scr_dyn_arr_push_hole(recv);
      }
      scr_dyn_region_store(recv, value);
      ScrDyn *old = recv->v.arr.items[idx];
      recv->v.arr.items[idx] = scr_dyn_retain(value);
      if (recv->v.arr.presence) recv->v.arr.presence[idx] = 1;
      scr_dyn_release(old);
      return;
    }
    if (!recv->v.arr.properties) {
      scr_dyn_region_store(recv, NULL); /* a table that later holds anything */
      recv->v.arr.properties = scr_dyn_new_obj();
    }
    recv->v.arr.properties->non_extensible = recv->non_extensible;
    scr_dyn_key_set(recv->v.arr.properties, key, value);
    return;
  }
  if (recv->kind == SCR_DYN_HANDLE) {
    scr_dyn_handle_key_set(recv, key, value);
    return;
  }
  if (recv->kind == SCR_DYN_BYTES) {
    /* Integer-indexed exotic writes coerce even for an invalid canonical
     * numeric index, then ignore an out-of-range index without an error. */
    double index = scr_string_to_number(key);
    char spelling[32];
    size_t length = scr_f64_to_str(index, spelling);
    bool negative_zero = key->len == 2 && memcmp(key->data, "-0", 2) == 0;
    if (negative_zero || (length == key->len && memcmp(spelling, key->data, length) == 0)) {
      double number;
      if (!scr_dyn_number_coerce_js(value, &number)) return;
      if (!negative_zero && index >= 0 && index < (double)recv->v.bytes->len && trunc(index) == index) {
        scr_bytes_set(recv->v.bytes, index, number);
      }
      return;
    }
  }

  ScrJsonBuf b;
  scr_jb_init(&b);
  if (recv->kind == SCR_DYN_UNDEF || recv->kind == SCR_DYN_NULL) {
    scr_jb_puts(&b, "Cannot set properties of ");
    scr_jb_puts(&b, recv->kind == SCR_DYN_UNDEF ? "undefined" : "null");
    scr_jb_puts(&b, " (setting '");
    scr_jb_write(&b, key->data, key->len);
    scr_jb_puts(&b, "')");
  } else {
    scr_jb_puts(&b, "Cannot create property '");
    scr_jb_write(&b, key->data, key->len);
    scr_jb_puts(&b, "' on ");
    scr_jb_puts(&b, scr_dyn_kind_name(recv));
    /* V8 quotes the primitive's own rendering after the kind — "on number
     * '5'", "on string 'abc'", "on boolean 'true'". Other kinds stop at
     * the kind word. */
    if (recv->kind == SCR_DYN_NUM) {
      char buf[32];
      size_t n = scr_f64_to_str(recv->v.num, buf);
      scr_jb_puts(&b, " '");
      scr_jb_write(&b, buf, n);
      scr_jb_putc(&b, '\'');
    } else if (recv->kind == SCR_DYN_STR) {
      scr_jb_puts(&b, " '");
      scr_jb_write(&b, recv->v.str->data, recv->v.str->len);
      scr_jb_putc(&b, '\'');
    } else if (recv->kind == SCR_DYN_BOOL) {
      scr_jb_puts(&b, recv->v.b ? " 'true'" : " 'false'");
    }
  }
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

void scr_dyn_key_set_computed(ScrDyn *recv, ScrDyn *key, ScrDyn *value) {
  if (key->kind == SCR_DYN_SYMBOL) {
    scr_dyn_symbol_key_set(recv, key, value);
    return;
  }
  /* A nullish receiver fails before object-key coercion. V8 includes a
   * primitive key in the error, but never calls user code to describe it. */
  if ((recv->kind == SCR_DYN_UNDEF || recv->kind == SCR_DYN_NULL) &&
      scr_dyn_to_primitive_result_is_object(key)) {
    const char *message = recv->kind == SCR_DYN_NULL
      ? "Cannot set properties of null" : "Cannot set properties of undefined";
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return;
  }
  ScrStr *name = scr_dyn_string_coerce_js(key);
  if (!name) return;
  scr_dyn_key_set(recv, name, value);
  scr_str_release(name);
}

/* ── dynCheck failure path ─────────────────────────────────────────────── */

static void scr_dyn_path_render(ScrJsonBuf *b, const ScrDynPath *p) {
  if (!p) {
    scr_jb_putc(b, '$');
    return;
  }
  scr_dyn_path_render(b, p->parent);
  if (p->key) {
    scr_jb_putc(b, '.');
    scr_jb_puts(b, p->key);
  } else {
    char idx[32];
    snprintf(idx, sizeof idx, "[%zu]", p->index);
    scr_jb_puts(b, idx);
  }
}

static const char *scr_dyn_kind_name(const ScrDyn *d) {
  if (!d) return "undefined"; /* a missing object member */
  switch (d->kind) {
  case SCR_DYN_NULL: return "null";
  case SCR_DYN_BOOL: return "boolean";
  case SCR_DYN_BIGINT: return "bigint";
  case SCR_DYN_SYMBOL: return "symbol";
  case SCR_DYN_NUM: return "number";
  case SCR_DYN_STR: return "string";
  case SCR_DYN_ARR: return "array";
  case SCR_DYN_OBJ: return "object";
  case SCR_DYN_UNDEF: return "undefined";
  case SCR_DYN_BYTES: return d->v.bytes->is_data_view ? "DataView" : scr_bytes_elem_name(d->v.bytes->elem);
  case SCR_DYN_FUNC: return "function";
  case SCR_DYN_HANDLE: return scr_dyn_handle_cls(d); /* "got IncomingMessage" */
  case SCR_DYN_PROMISE: return "Promise"; /* "got Promise" */

  case SCR_DYN_TYPED_REF:
  case SCR_DYN_PROXY: return "object";
  }
  return "unknown";
}

void scr_dyn_check_fail(const ScrDynPath *path, const char *want, const ScrDyn *got) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "expected ");
  scr_jb_puts(&b, want);
  scr_jb_puts(&b, " at ");
  scr_dyn_path_render(&b, path);
  scr_jb_puts(&b, ", got ");
  scr_jb_puts(&b, scr_dyn_kind_name(got));
  /* A real TypeError instance: catch bindings narrow it with instanceof
   * and read the path off e.message; the uncaught line ("Uncaught
   * TypeError: expected ...") is byte-identical to the old string form. */
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

/* ── recursive shapes: cycle-aware dynMatch and the dynCheck memo ──────
 * The tables are open-addressed sets keyed by a dyn value's address and a
 * generated helper's address. A visit session lasts while any matcher or
 * builder of a type holding a recursive shape runs; the memo and the
 * capsule views are dropped when the outermost one returns. */
typedef struct {
  ScrDyn *d; /* NULL marks an empty slot */
  const void *helper;
  void *value;
} ScrDynVisit;

typedef struct {
  ScrDynVisit *slots;
  size_t cap; /* zero or a power of two */
  size_t count;
} ScrDynVisitSet;

/* Entries in the order they were added; each holds a reference to its dyn
 * value, so the address cannot be reused by another value before the
 * session ends. */
typedef struct {
  ScrDynVisit *items;
  size_t len;
  size_t cap;
} ScrDynVisitLog;

static SCR_TL size_t scr_dyn_visit_depth;
/* The (value, matcher) pairs being checked further up the stack. */
static SCR_TL ScrDynVisitSet scr_dyn_matching;
/* The records and arrays built so far in this session (borrowed: the
 * conversion's result owns them). */
static SCR_TL ScrDynVisitSet scr_dyn_built;
static SCR_TL ScrDynVisitLog scr_dyn_built_log;
/* Whether the next scr_dyn_build_add records its value (set by enter). */
static SCR_TL bool scr_dyn_build_track;
/* The capsules materialized in this session. Their views are not
 * refreshed again until it ends: a refresh replaces the view's contents,
 * which an outer visit may still be reading. */
static SCR_TL ScrDynVisitSet scr_dyn_viewed;
static SCR_TL ScrDynVisitLog scr_dyn_viewed_log;
/* The member value a matcher or builder read last and holds one
 * reference to until it calls scr_dyn_release_held. */
static SCR_TL const ScrDyn *scr_dyn_visit_held;

/* Tables up to this many slots stay allocated for the next session. */
#define SCR_DYN_VISIT_KEEP 4096

static size_t scr_dyn_visit_slot(const ScrDynVisitSet *s, const ScrDyn *d, const void *helper) {
  uint64_t h = (uint64_t)(uintptr_t)d * 0x9E3779B97F4A7C15ull;
  h ^= (uint64_t)(uintptr_t)helper * 0xC2B2AE3D27D4EB4Full;
  h ^= h >> 29;
  return (size_t)h & (s->cap - 1);
}

static ScrDynVisit *scr_dyn_visit_find(const ScrDynVisitSet *s, const ScrDyn *d,
                                       const void *helper) {
  if (s->count == 0) return NULL;
  for (size_t i = scr_dyn_visit_slot(s, d, helper);; i = (i + 1) & (s->cap - 1)) {
    ScrDynVisit *e = &s->slots[i];
    if (!e->d) return NULL;
    if (e->d == d && e->helper == helper) return e;
  }
}

static void scr_dyn_visit_put(ScrDynVisitSet *s, ScrDynVisit v) {
  if ((s->count + 1) * 2 > s->cap) {
    size_t cap = s->cap ? s->cap * 2 : 64;
    ScrDynVisit *slots = calloc(cap, sizeof *slots);
    if (!slots) scr_json_oom();
    ScrDynVisitSet grown = {slots, cap, 0};
    for (size_t i = 0; i < s->cap; i++)
      if (s->slots[i].d) scr_dyn_visit_put(&grown, s->slots[i]);
    free(s->slots);
    *s = grown;
  }
  size_t i = scr_dyn_visit_slot(s, v.d, v.helper);
  while (s->slots[i].d) i = (i + 1) & (s->cap - 1);
  s->slots[i] = v;
  s->count++;
}

/* Removes an entry and shifts the following run back over its slot, so
 * lookups never need tombstones. */
static void scr_dyn_visit_remove(ScrDynVisitSet *s, ScrDynVisit *e) {
  size_t mask = s->cap - 1;
  size_t i = (size_t)(e - s->slots);
  for (size_t j = (i + 1) & mask; s->slots[j].d; j = (j + 1) & mask) {
    size_t home = scr_dyn_visit_slot(s, s->slots[j].d, s->slots[j].helper);
    bool stays = i <= j ? (i < home && home <= j) : (i < home || home <= j);
    if (stays) continue;
    s->slots[i] = s->slots[j];
    i = j;
  }
  s->slots[i].d = NULL;
  s->count--;
}

/* Adds a logged entry; the log takes a reference to its dyn value. */
static void scr_dyn_visit_record(ScrDynVisitSet *s, ScrDynVisitLog *log, const ScrDyn *d,
                                 const void *helper, void *value) {
  if (log->len == log->cap) {
    size_t cap = log->cap ? log->cap * 2 : 32;
    ScrDynVisit *grown = realloc(log->items, cap * sizeof *grown);
    if (!grown) scr_json_oom();
    log->items = grown;
    log->cap = cap;
  }
  ScrDynVisit v = {scr_dyn_retain((ScrDyn *)d), helper, value};
  log->items[log->len++] = v;
  scr_dyn_visit_put(s, v);
}

/* Empties a logged set and releases the log's references. */
static void scr_dyn_visit_clear(ScrDynVisitSet *s, ScrDynVisitLog *log) {
  size_t len = log->len;
  if (len == 0) return;
  log->len = 0;
  if (s->cap > SCR_DYN_VISIT_KEEP) {
    free(s->slots);
    *s = (ScrDynVisitSet){NULL, 0, 0};
  } else if (len * 8 < s->cap) {
    /* Find every slot before clearing any, so each lookup still sees the
     * probe run it was inserted into. */
    for (size_t i = 0; i < len; i++)
      log->items[i].value = scr_dyn_visit_find(s, log->items[i].d, log->items[i].helper);
    for (size_t i = 0; i < len; i++) ((ScrDynVisit *)log->items[i].value)->d = NULL;
    s->count = 0;
  } else {
    memset(s->slots, 0, s->cap * sizeof *s->slots);
    s->count = 0;
  }
  for (size_t i = 0; i < len; i++) scr_dyn_release(log->items[i].d);
  if (log->cap > SCR_DYN_VISIT_KEEP) {
    free(log->items);
    *log = (ScrDynVisitLog){NULL, 0, 0};
  }
}

static void scr_dyn_visit_exit(void) {
  if (--scr_dyn_visit_depth != 0) return;
  scr_dyn_visit_clear(&scr_dyn_built, &scr_dyn_built_log);
  scr_dyn_visit_clear(&scr_dyn_viewed, &scr_dyn_viewed_log);
}

/* Getters and proxy traps run user code, which may start conversions of
 * its own and catch their failures. It runs with the session set aside,
 * so its conversions use their own tables and leave the session's
 * entries alone. */
typedef struct {
  size_t depth;
  ScrDynVisitSet matching, built, viewed;
  ScrDynVisitLog built_log, viewed_log;
  bool track;
  const ScrDyn *held;
} ScrDynVisitState;

static void scr_dyn_visit_suspend(ScrDynVisitState *saved) {
  *saved = (ScrDynVisitState){scr_dyn_visit_depth, scr_dyn_matching, scr_dyn_built,
                              scr_dyn_viewed, scr_dyn_built_log, scr_dyn_viewed_log,
                              scr_dyn_build_track, scr_dyn_visit_held};
  scr_dyn_visit_depth = 0;
  scr_dyn_matching = scr_dyn_built = scr_dyn_viewed = (ScrDynVisitSet){NULL, 0, 0};
  scr_dyn_built_log = scr_dyn_viewed_log = (ScrDynVisitLog){NULL, 0, 0};
  scr_dyn_visit_held = NULL;
}

static void scr_dyn_visit_resume(const ScrDynVisitState *saved) {
  free(scr_dyn_matching.slots);
  free(scr_dyn_built.slots);
  free(scr_dyn_viewed.slots);
  free(scr_dyn_built_log.items);
  free(scr_dyn_viewed_log.items);
  scr_dyn_visit_depth = saved->depth;
  scr_dyn_matching = saved->matching;
  scr_dyn_built = saved->built;
  scr_dyn_viewed = saved->viewed;
  scr_dyn_built_log = saved->built_log;
  scr_dyn_viewed_log = saved->viewed_log;
  scr_dyn_build_track = saved->track;
  scr_dyn_visit_held = saved->held;
}

/* Calls a getter for a member read, outside any visit session. */
static ScrDyn *scr_dyn_visit_call_getter(ScrDyn *getter) {
  if (scr_dyn_visit_depth == 0) return scr_dyn_call(getter, NULL, 0, "getter");
  ScrDynVisitState saved;
  scr_dyn_visit_suspend(&saved);
  ScrDyn *result = scr_dyn_call(getter, NULL, 0, "getter");
  scr_dyn_visit_resume(&saved);
  return result;
}

/* A proxy's get trap for a member read, outside any visit session. */
static ScrDyn *scr_dyn_visit_proxy_get(const ScrDyn *d, ScrStr *name) {
  if (scr_dyn_visit_depth == 0) return scr_dyn_proxy_get(d, name);
  ScrDynVisitState saved;
  scr_dyn_visit_suspend(&saved);
  ScrDyn *result = scr_dyn_proxy_get(d, name);
  scr_dyn_visit_resume(&saved);
  return result;
}

ScrDyn *scr_dyn_obj_read_held(const ScrDyn *d, const char *key, size_t key_len) {
  ScrDyn *value = scr_dyn_obj_read(d, key, key_len);
  scr_dyn_visit_held = value;
  return value;
}

void scr_dyn_release_held(ScrDyn *d) {
  if (scr_dyn_visit_held == d) scr_dyn_visit_held = NULL;
  scr_dyn_release(d);
}

/* Whether a visit can reach d again. A dyn value with a single reference,
 * not counting the one a member read holds, is reached once: that
 * reference is the edge or holder this visit came through. Reaching a
 * value twice takes two references. */
static bool scr_dyn_visit_shared(const ScrDyn *d) {
  if (!d) return false;
  if (d->rc == SIZE_MAX) return true;
  return d->rc - (scr_dyn_visit_held == d ? 1 : 0) >= 2;
}

bool scr_dyn_match_visit(const ScrDyn *d, const void *matcher, bool (*body)(const ScrDyn *)) {
  bool shared = matcher && scr_dyn_visit_shared(d);
  /* Inside an open session, an untracked visit needs no bookkeeping: the
   * outer visit ends the session. */
  if (!shared && scr_dyn_visit_depth > 0) return body(d);
  bool tracked = false;
  if (shared) {
    if (scr_dyn_visit_find(&scr_dyn_matching, d, matcher)) return true;
    scr_dyn_visit_put(&scr_dyn_matching, (ScrDynVisit){(ScrDyn *)d, matcher, NULL});
    tracked = true;
  }
  scr_dyn_visit_depth++;
  bool ok = body(d);
  if (tracked)
    scr_dyn_visit_remove(&scr_dyn_matching, scr_dyn_visit_find(&scr_dyn_matching, d, matcher));
  scr_dyn_visit_exit();
  return ok;
}

void *scr_dyn_build_visit(const ScrDyn *d, const ScrDynPath *path, const void *builder,
                          void *(*body)(const ScrDyn *, const ScrDynPath *),
                          void *(*retain)(void *)) {
  if (builder) {
    ScrDynVisit *e = scr_dyn_visit_find(&scr_dyn_built, d, builder);
    if (e) return retain(e->value);
  }
  scr_dyn_build_track = builder && scr_dyn_visit_shared(d);
  /* Inside an open session, an untracked visit needs no bookkeeping: a
   * failure reaches the outer visit, which drops what was recorded. */
  if (!scr_dyn_build_track && scr_dyn_visit_depth > 0) return body(d, path);
  scr_dyn_visit_depth++;
  size_t mark = scr_dyn_built_log.len;
  void *built = body(d, path);
  /* A failed build has released what it built: forget those values. */
  if (scr_exc_pending()) {
    while (scr_dyn_built_log.len > mark) {
      ScrDynVisit v = scr_dyn_built_log.items[--scr_dyn_built_log.len];
      scr_dyn_visit_remove(&scr_dyn_built, scr_dyn_visit_find(&scr_dyn_built, v.d, v.helper));
      scr_dyn_release(v.d);
    }
  }
  scr_dyn_visit_exit();
  return built;
}

void scr_dyn_build_add(const ScrDyn *d, const void *builder, void *value) {
  if (!scr_dyn_build_track) return;
  scr_dyn_build_track = false;
  scr_dyn_visit_record(&scr_dyn_built, &scr_dyn_built_log, d, builder, value);
}

void scr_dyn_build_note(const ScrDyn *d, const void *builder, void *value) {
  if (!value || scr_dyn_visit_find(&scr_dyn_built, d, builder)) return;
  scr_dyn_visit_record(&scr_dyn_built, &scr_dyn_built_log, d, builder, value);
}

void scr_dyn_build_rekey(const ScrDyn *d, const void *builder, void *value) {
  ScrDynVisit *e = scr_dyn_visit_find(&scr_dyn_built, d, builder);
  if (e) e->value = value;
}

ScrDyn *scr_dyn_visit_view(const ScrDyn *capsule) {
  if (capsule->v.typed_ref.materialized && scr_dyn_visit_find(&scr_dyn_viewed, capsule, NULL))
    return scr_dyn_retain(capsule->v.typed_ref.materialized);
  ScrDyn *view = scr_dyn_typed_ref_materialize(capsule);
  if (scr_dyn_visit_depth > 0 && !scr_exc_pending())
    scr_dyn_visit_record(&scr_dyn_viewed, &scr_dyn_viewed_log, capsule, NULL, NULL);
  return view;
}

/* ── parser ────────────────────────────────────────────────────────────── */

#define SCR_JSON_MAX_DEPTH 1000

typedef struct {
  const char *s;
  size_t len;
  size_t pos;
  int depth;
  bool quiet; /* schema fast path: report failure without throwing */
  ScrDynRegion *region; /* tags completed containers (ScrDynRegion); may be NULL */
  struct ScrJsonShape *shapes; /* key-sequence transitions (scr_json_object) */
  uint32_t nshapes, shape_cap;
  /* Schema records whose plain field names are known (scr_jschema_plain):
   * bit i of the mask is set when field i's name holds no byte JSON text
   * would escape. */
  const struct ScrJsonSchema *plain_schema[4];
  uint64_t plain_mask[4];
} ScrJsonP;

static void scr_json_throw(const ScrJsonP *p, const char *msg) {
  if (p->quiet) return;
  scr_throw_error_msg(SCR_ERR_SYNTAX, msg, strlen(msg));
}

/* Errors stay out of line so the scanners that report them keep their
 * registers for the common path. */
static __attribute__((noinline, cold)) void scr_json_throw_pos(const ScrJsonP *p, const char *what,
                                                               size_t pos) {
  if (p->quiet) return;
  char buf[128];
  int n = snprintf(buf, sizeof buf, "%s in JSON at position %zu", what, pos);
  scr_throw_error_msg(SCR_ERR_SYNTAX, buf, (size_t)n);
}

/* V8-flavored bad-token message with a short snippet of the input around
 * the offending character. Approximate fidelity (documented). */
static void scr_json_throw_token(const ScrJsonP *p) {
  if (p->quiet) return;
  size_t start = p->pos > 8 ? p->pos - 8 : 0;
  size_t take = p->len - start < 16 ? p->len - start : 16;
  char buf[192];
  int n = snprintf(buf, sizeof buf, "Unexpected token '%c', %s\"%.*s\"%s is not valid JSON",
                   p->s[p->pos], start > 0 ? "..." : "", (int)take, p->s + start,
                   start + take < p->len ? "..." : "");
  scr_throw_error_msg(SCR_ERR_SYNTAX, buf, (size_t)n);
}

static void scr_json_ws(ScrJsonP *p) {
  /* A local cursor, as in scr_json_number_value. */
  const char *s = p->s;
  size_t pos = p->pos;
  while (pos < p->len) {
    char c = s[pos];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
    else break;
  }
  p->pos = pos;
}

/* Append the WTF-8 encoding of a code point or lone surrogate unit; a low
 * surrogate after a lone high one completes the pair (scr_jb_write). */
static void scr_json_put_cp(ScrJsonBuf *b, uint32_t cp) {
  char bytes[4];
  scr_jb_write(b, bytes, scr_wtf8_put(bytes, cp));
}

/* Four hex digits at pos, or -1 (throws). */
static int32_t scr_json_hex4(ScrJsonP *p) {
  if (p->len - p->pos < 4) {
    scr_json_throw(p, "Unexpected end of JSON input");
    return -1;
  }
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) {
    char c = p->s[p->pos + (size_t)i];
    uint32_t digit;
    if (c >= '0' && c <= '9') digit = (uint32_t)(c - '0');
    else if (c >= 'a' && c <= 'f') digit = (uint32_t)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') digit = (uint32_t)(c - 'A' + 10);
    else {
      scr_json_throw_pos(p, "Bad Unicode escape", p->pos + (size_t)i);
      return -1;
    }
    v = v * 16 + digit;
  }
  p->pos += 4;
  return (int32_t)v;
}

/* Fast scan of the string literal at p->pos (the opening quote): when it
 * contains no escapes, sets *span and *span_len to the raw bytes inside the
 * quotes, consumes the literal and returns 1. An escape returns 0 with
 * p->pos still at the opening quote (the slow path re-parses). A control
 * character or missing close quote throws (same message and position the
 * slow path would produce) and returns -1. */
static int scr_json_string_span(ScrJsonP *p, const char **span,
                                 size_t *span_len) {
  *span = p->s + p->pos + 1;
  *span_len = scr_json_plain_bytes(*span, p->len - p->pos - 1);
  size_t i = p->pos + 1 + *span_len;
  if (i < p->len) {
    unsigned char c = (unsigned char)p->s[i];
    if (c == '"') {
      *span = p->s + p->pos + 1;
      *span_len = i - (p->pos + 1);
      p->pos = i + 1;
      return 1;
    }
    if (c == '\\') return 0;
    if (c < 0x20) {
      scr_json_throw_pos(p, "Bad control character in string literal", i);
      return -1;
    }
  }
  scr_json_throw_pos(p, "Unterminated string", p->pos);
  return -1;
}

/* Slow path: parses the string literal at p->pos (the opening quote),
 * decoding escapes, into a +1 ScrStr. NULL on error (thrown). */
static ScrStr *scr_json_string_slow(ScrJsonP *p, size_t prefix) {
  size_t open = p->pos;
  p->pos++; /* opening quote */
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_write(&b, p->s + p->pos, prefix);
  p->pos += prefix;
  for (;;) {
    if (p->pos >= p->len) {
      scr_jb_dispose(&b);
      scr_json_throw_pos(p, "Unterminated string", open);
      return NULL;
    }
    unsigned char c = (unsigned char)p->s[p->pos];
    if (c == '"') {
      p->pos++;
      return scr_jb_finish(&b);
    }
    if (c < 0x20) {
      scr_jb_dispose(&b);
      scr_json_throw_pos(p, "Bad control character in string literal", p->pos);
      return NULL;
    }
    if (c != '\\') {
      size_t run = scr_json_plain_bytes(p->s + p->pos, p->len - p->pos);
      scr_jb_write(&b, p->s + p->pos, run);
      p->pos += run;
      continue;
    }
    p->pos++; /* backslash */
    if (p->pos >= p->len) {
      scr_jb_dispose(&b);
      scr_json_throw(p, "Unexpected end of JSON input");
      return NULL;
    }
    char e = p->s[p->pos];
    switch (e) {
    case '"': scr_jb_putc(&b, '"'); p->pos++; break;
    case '\\': scr_jb_putc(&b, '\\'); p->pos++; break;
    case '/': scr_jb_putc(&b, '/'); p->pos++; break;
    case 'b': scr_jb_putc(&b, '\b'); p->pos++; break;
    case 'f': scr_jb_putc(&b, '\f'); p->pos++; break;
    case 'n': scr_jb_putc(&b, '\n'); p->pos++; break;
    case 'r': scr_jb_putc(&b, '\r'); p->pos++; break;
    case 't': scr_jb_putc(&b, '\t'); p->pos++; break;
    case 'u': {
      p->pos++;
      int32_t cp = scr_json_hex4(p);
      if (cp < 0) {
        scr_jb_dispose(&b);
        return NULL;
      }
      /* Each escape is one UTF-16 unit: a surrogate stays lone unless it
       * meets its other half, which scr_json_put_cp fuses into the pair. */
      scr_json_put_cp(&b, (uint32_t)cp);
      break;
    }
    default:
      scr_jb_dispose(&b);
      scr_json_throw_pos(p, "Bad escaped character", p->pos);
      return NULL;
    }
  }
}

/* String literal at p->pos as a +1 ScrStr (span fast path, escapes via the
 * slow path). NULL on error (thrown). */
static ScrStr *scr_json_string_scr(ScrJsonP *p) {
  const char *span;
  size_t span_len;
  int r = scr_json_string_span(p, &span, &span_len);
  if (r < 0) return NULL;
  if (r > 0) return scr_str_new(span, span_len);
  return scr_json_string_slow(p, span_len);
}

static ScrDyn *scr_json_value(ScrJsonP *p);

/* Exact powers of ten: 10^k is an exact double for k <= 22. */
static const double scr_json_pow10[23] = {
    1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,  1e8,  1e9,  1e10, 1e11,
    1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};

/* Scans the number token at p->pos into *out. false on a grammar error
 * (thrown unless quiet). Shared by the dyn tree and the schema parser so
 * both produce bit-identical values. */
static bool scr_json_number_value(ScrJsonP *p, double *out) {
  /* The cursor and text stay in locals: the runtime builds without strict
   * aliasing, so a byte read through p->s could alias p->pos, and a loop
   * on p->pos would store it on every digit. p->pos is written once, when
   * the token ends. */
  const char *s = p->s;
  const size_t len = p->len;
  const size_t start = p->pos;
  size_t pos = start;
  /* Grammar validation and value accumulation in one pass. Clinger's fast
   * path: with at most 15 significant digits the mantissa is exact in a
   * double, and scaling by an exact power of ten (|exp| <= 22) rounds
   * once — bit-identical to strtod. Everything else falls back. */
  uint64_t mant = 0;
  int ndig = 0;   /* significant digits folded into mant */
  int exp10 = 0;  /* decimal exponent (fraction shift + explicit exponent) */
  bool neg = false, precise = true;
  if (s[pos] == '-') {
    neg = true;
    pos++;
    if (pos >= len || s[pos] < '0' || s[pos] > '9') {
      p->pos = pos;
      scr_json_throw_pos(p, "No number after minus sign", pos);
      return false;
    }
  }
  if (s[pos] == '0') {
    pos++;
  } else {
    while (pos < len && s[pos] >= '0' && s[pos] <= '9') {
      if (ndig < 15) {
        mant = mant * 10 + (uint64_t)(s[pos] - '0');
        ndig++;
      } else {
        precise = false;
      }
      pos++;
    }
  }
  if (pos < len && s[pos] == '.') {
    pos++;
    if (pos >= len || s[pos] < '0' || s[pos] > '9') {
      p->pos = pos;
      scr_json_throw_pos(p, "Unterminated fractional number", pos);
      return false;
    }
    while (pos < len && s[pos] >= '0' && s[pos] <= '9') {
      unsigned digit = (unsigned)(s[pos] - '0');
      if (mant == 0 && digit == 0) {
        exp10--; /* leading fractional zeros scale without a digit */
      } else if (ndig < 15) {
        mant = mant * 10 + digit;
        ndig++;
        exp10--;
      } else {
        precise = false;
      }
      pos++;
    }
  }
  if (pos < len && (s[pos] == 'e' || s[pos] == 'E')) {
    pos++;
    bool eneg = false;
    if (pos < len && (s[pos] == '+' || s[pos] == '-')) {
      eneg = s[pos] == '-';
      pos++;
    }
    if (pos >= len || s[pos] < '0' || s[pos] > '9') {
      p->pos = pos;
      scr_json_throw_pos(p, "Exponent part is missing a number", pos);
      return false;
    }
    int ev = 0;
    while (pos < len && s[pos] >= '0' && s[pos] <= '9') {
      if (ev < 100000) ev = ev * 10 + (s[pos] - '0');
      pos++;
    }
    exp10 += eneg ? -ev : ev;
  }
  p->pos = pos;
  if (precise && exp10 >= -22 && exp10 <= 22) {
    /* exact: mant < 10^15 < 2^53; the signed conversion is one
     * instruction on x86-64, the unsigned one a sequence */
    double v = (double)(int64_t)mant;
    if (exp10 > 0) v *= scr_json_pow10[exp10];
    else if (exp10 < 0) v /= scr_json_pow10[-exp10];
    *out = neg ? -v : v;
    return true;
  }
  /* The validated span re-parses with strtod (correctly rounded, and the
   * grammar above is a strict subset of what strtod accepts). The ScrStr
   * data is NUL-terminated, and strtod stops at the first non-number char,
   * so parsing from `start` reads exactly the validated token. */
  *out = strtod(s + start, NULL);
  return true;
}

static ScrDyn *scr_json_number(ScrJsonP *p) {
  double v;
  if (!scr_json_number_value(p, &v)) return NULL;
  return scr_dyn_new_num(v);
}

static bool scr_json_lit(ScrJsonP *p, const char *word, size_t n) {
  if (p->len - p->pos >= n && scr_key_equal(p->s + p->pos, word, n)) {
    p->pos += n;
    return true;
  }
  scr_json_throw_token(p);
  return false;
}

/* JSON.parse builds arrays and objects by appending, which leaves up to
 * half of their storage unused; the parsed tree is usually kept as it is.
 * When an array or object closes, its storage moves to a block of its
 * length (shrinking in place would keep the block's size class). A table
 * recycled from the free list may hold keys past its length; they are
 * released first. */
static void *scr_json_fit_block(void *block, size_t bytes) {
  void *fitted = scr_mem_alloc(bytes);
  if (!fitted) return NULL;
  memcpy(fitted, block, bytes);
  scr_mem_free(block);
  return fitted;
}

static void scr_json_fit_array(ScrDyn *arr) {
  size_t len = arr->v.arr.len;
  if (len == 0 || len == arr->v.arr.cap || arr->v.arr.presence) return;
  ScrDyn **items = scr_json_fit_block(arr->v.arr.items, len * sizeof *items);
  if (!items) return; /* keep the larger block */
  arr->v.arr.items = items;
  arr->v.arr.cap = len;
}

static void scr_json_fit_object(ScrDyn *obj) {
  size_t len = obj->v.obj.len, cap = obj->v.obj.cap;
  if (len == 0 || len == cap) return;
  for (size_t i = len; i < cap; i++) {
    ScrDynEntry *entry = &obj->v.obj.entries[i];
    scr_dyn_key_release(entry->key, entry->key_len);
    entry->key = NULL;
    entry->key_len = 0;
  }
  ScrDynEntry *entries = scr_json_fit_block(obj->v.obj.entries, len * sizeof *entries);
  if (!entries) return; /* keep the larger block; its tail holds no keys */
  obj->v.obj.entries = entries;
  obj->v.obj.cap = len;
}

static ScrDyn *scr_json_array(ScrJsonP *p) {
  p->pos++; /* '[' */
  ScrDyn *arr = scr_dyn_alloc(SCR_DYN_ARR);
  scr_json_ws(p);
  if (p->pos < p->len && p->s[p->pos] == ']') {
    p->pos++;
    return arr;
  }
  for (;;) {
    ScrDyn *item = scr_json_value(p);
    if (!item) {
      scr_dyn_release(arr);
      return NULL;
    }
    scr_dyn_arr_push(arr, item);
    scr_json_ws(p);
    if (p->pos >= p->len) {
      scr_dyn_release(arr);
      scr_json_throw(p, "Unexpected end of JSON input");
      return NULL;
    }
    if (p->s[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->s[p->pos] == ']') {
      p->pos++;
      scr_json_fit_array(arr);
      return arr;
    }
    scr_dyn_release(arr);
    scr_json_throw_pos(p, "Expected ',' or ']' after array element", p->pos);
    return NULL;
  }
}

/* ── key-sequence transitions ──────────────────────────────────────────
 * Parsed documents repeat object layouts: every record of an array usually
 * spells the same keys in the same order. Like V8's JSON parser following a
 * map's expected transition, the parser remembers the key sequences it has
 * built as a tree whose root is the empty object. A member whose raw text is
 * exactly `"<expected key>"` then needs no string scan, no duplicate search
 * and no key copy: the object holds the path's keys and nothing else, every
 * transition was recorded when a put appended a key that was not yet
 * present, so the matched key is new too, and the entry shares the tree's
 * key bytes. Transitions are recorded only for keys that needed no unescaping
 * (raw text equals the key), so a byte match proves the decoded key. The
 * tree belongs to one parse and holds one reference to each key. */
typedef struct ScrJsonShape {
  char *key;
  size_t key_len;
  uint32_t child;   /* first transition; 0 = none (the root is never a child) */
  uint32_t sibling; /* next transition from the same layout; 0 = none */
} ScrJsonShape;

#define SCR_JSON_SHAPE_MAX 4096u   /* transitions per parse */
#define SCR_JSON_SHAPE_PROBES 4    /* transitions tried per member */

static void scr_json_shapes_free(ScrJsonP *p) {
  for (uint32_t i = 1; i < p->nshapes; i++) scr_dyn_key_release(p->shapes[i].key, p->shapes[i].key_len);
  free(p->shapes);
  p->shapes = NULL;
  p->nshapes = p->shape_cap = 0;
}

/* The transition from `shape` whose key the input spells next, consuming
 * its quoted text; 0 when none of the first few transitions matches. */
static inline uint32_t scr_json_shape_follow(ScrJsonP *p, uint32_t shape) {
  if (!p->shapes) return 0;
  uint32_t next = p->shapes[shape].child;
  const char *text = p->s + p->pos + 1; /* past the opening quote */
  size_t room = p->len - p->pos - 1;
  for (int probe = 0; next && probe < SCR_JSON_SHAPE_PROBES; probe++) {
    const ScrJsonShape *candidate = &p->shapes[next];
    size_t n = candidate->key_len;
    if (n < room && text[n] == '"' && scr_key_equal(text, candidate->key, n)) {
      p->pos += n + 2;
      return next;
    }
    next = candidate->sibling;
  }
  return 0;
}

/* Record `entry`'s key as a transition from `shape`; 0 when the budget is
 * spent (the object then finishes on the ordinary path). */
static uint32_t scr_json_shape_add(ScrJsonP *p, uint32_t shape, const ScrDynEntry *entry) {
  if (!p->shapes) {
    p->shapes = malloc(16 * sizeof *p->shapes);
    if (!p->shapes) scr_json_oom();
    p->shapes[0] = (ScrJsonShape){0};
    p->nshapes = 1;
    p->shape_cap = 16;
  }
  if (p->nshapes == SCR_JSON_SHAPE_MAX) return 0;
  if (p->nshapes == p->shape_cap) {
    ScrJsonShape *grown = realloc(p->shapes, 2 * p->shape_cap * sizeof *grown);
    if (!grown) scr_json_oom();
    p->shapes = grown;
    p->shape_cap *= 2;
  }
  uint32_t added = p->nshapes++;
  ((ScrDynKey *)(entry->key - offsetof(ScrDynKey, bytes)))->rc++;
  p->shapes[added] = (ScrJsonShape){entry->key, entry->key_len, 0, p->shapes[shape].child};
  p->shapes[shape].child = added;
  return added;
}

/* scr_dyn_obj_put for a fresh parser object and a key it does not hold yet,
 * sharing the transition's key bytes. */
static void scr_dyn_obj_append_shared(ScrDyn *obj, char *key, size_t key_len, ScrDyn *value) {
  scr_dyn_region_store(obj, value);
  if (obj->v.obj.len == obj->v.obj.cap) {
    size_t cap = obj->v.obj.cap ? obj->v.obj.cap * 2 : 4;
    ScrDynEntry *entries = scr_mem_realloc(obj->v.obj.entries, cap * sizeof *entries);
    if (!entries) scr_json_oom();
    memset(entries + obj->v.obj.cap, 0, (cap - obj->v.obj.cap) * sizeof *entries);
    obj->v.obj.entries = entries;
    obj->v.obj.cap = cap;
  }
  SCR_JS_SHAPE_RESET(obj);
  ScrDynEntry *e = &obj->v.obj.entries[obj->v.obj.len++];
  if (e->key != key) {
    ((ScrDynKey *)(key - offsetof(ScrDynKey, bytes)))->rc++;
    scr_dyn_key_release(e->key, e->key_len);
    e->key = key;
  }
  e->key_len = key_len;
  e->value = value;
  e->getter = NULL;
  e->setter = NULL;
  e->accessor = false;
  e->writable = true;
  e->enumerable = true;
  e->configurable = true;
  if (obj->v.obj.len >= SCR_DYN_OBJECT_INDEX_MIN) scr_dyn_index_append(obj);
}

static ScrDyn *scr_json_object(ScrJsonP *p) {
  p->pos++; /* '{' */
  ScrDyn *obj = scr_dyn_alloc(SCR_DYN_OBJ);
  scr_json_ws(p);
  if (p->pos < p->len && p->s[p->pos] == '}') {
    p->pos++;
    return obj;
  }
  uint32_t shape = 0; /* the empty layout */
  bool shaped = true;  /* obj holds exactly the keys on shape's path */
  for (;;) {
    scr_json_ws(p);
    if (p->pos >= p->len) {
      scr_dyn_release(obj);
      scr_json_throw(p, "Unexpected end of JSON input");
      return NULL;
    }
    if (p->s[p->pos] != '"') {
      scr_dyn_release(obj);
      scr_json_throw_pos(p, "Expected property name or '}'", p->pos);
      return NULL;
    }
    /* Keep the key borrowed until insertion determines whether it already
     * exists or can reuse a recycled slot. Escaped keys own their decoded
     * string until the value has been parsed and inserted. */
    size_t key_len = 0;
    const char *key;
    ScrStr *decoded_key = NULL;
    uint32_t follow = shaped ? scr_json_shape_follow(p, shape) : 0;
    char *shared_key = NULL;
    if (follow) {
      shared_key = p->shapes[follow].key;
      key = shared_key;
      key_len = p->shapes[follow].key_len;
    } else {
      const char *span;
      size_t span_len;
      int r = scr_json_string_span(p, &span, &span_len);
      if (r < 0) {
        scr_dyn_release(obj);
        return NULL;
      }
      if (r > 0) {
        key = span;
        key_len = span_len;
      } else {
        decoded_key = scr_json_string_slow(p, span_len);
        if (!decoded_key) {
          scr_dyn_release(obj);
          return NULL;
        }
        key = decoded_key->data;
        key_len = decoded_key->len;
      }
    }
    scr_json_ws(p);
    if (p->pos >= p->len || p->s[p->pos] != ':') {
      scr_str_release(decoded_key);
      scr_dyn_release(obj);
      if (p->pos >= p->len) scr_json_throw(p, "Unexpected end of JSON input");
      else scr_json_throw_pos(p, "Expected ':' after property name", p->pos);
      return NULL;
    }
    p->pos++; /* ':' */
    ScrDyn *value = scr_json_value(p);
    if (!value) {
      scr_str_release(decoded_key);
      scr_dyn_release(obj);
      return NULL;
    }
    if (shared_key) {
      scr_dyn_obj_append_shared(obj, shared_key, key_len, value);
      shape = follow;
    } else {
      size_t before = obj->v.obj.len;
      scr_dyn_obj_put(obj, key, key_len, value); /* later duplicate keys win */
      if (shaped) {
        uint32_t added = !decoded_key && obj->v.obj.len == before + 1
            ? scr_json_shape_add(p, shape, &obj->v.obj.entries[before]) : 0;
        if (added) shape = added;
        else shaped = false;
      }
    }
    scr_str_release(decoded_key);
    scr_json_ws(p);
    if (p->pos >= p->len) {
      scr_dyn_release(obj);
      scr_json_throw(p, "Unexpected end of JSON input");
      return NULL;
    }
    if (p->s[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->s[p->pos] == '}') {
      p->pos++;
      scr_json_fit_object(obj);
      return obj;
    }
    scr_dyn_release(obj);
    scr_json_throw_pos(p, "Expected ',' or '}' after property value", p->pos);
    return NULL;
  }
}

static ScrDyn *scr_json_value(ScrJsonP *p) {
  scr_json_ws(p);
  if (p->pos >= p->len) {
    scr_json_throw(p, "Unexpected end of JSON input");
    return NULL;
  }
  char c = p->s[p->pos];
  if (c == '{' || c == '[') {
    if (++p->depth > SCR_JSON_MAX_DEPTH) {
      /* JS overflows the engine stack here (RangeError); a native recursive
       * descent must cap instead. Same message and kind, catchable. */
      const char msg[] = "Maximum call stack size exceeded";
      scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
      return NULL;
    }
    ScrDyn *d = c == '{' ? scr_json_object(p) : scr_json_array(p);
    p->depth--;
    if (d) scr_dyn_region_join(d, p->region);
    return d;
  }
  if (c == '"') {
    ScrStr *sv = scr_json_string_scr(p);
    if (!sv) return NULL;
    ScrDyn *d = scr_dyn_leaf_alloc(SCR_DYN_STR);
    d->v.str = sv;
    return d;
  }
  if (c == 't') {
    if (!scr_json_lit(p, "true", 4)) return NULL;
    return scr_dyn_new_bool(true);
  }
  if (c == 'f') {
    if (!scr_json_lit(p, "false", 5)) return NULL;
    return scr_dyn_new_bool(false);
  }
  if (c == 'n') {
    if (!scr_json_lit(p, "null", 4)) return NULL;
    return scr_dyn_new_null();
  }
  if (c == '-' || (c >= '0' && c <= '9')) return scr_json_number(p);
  scr_json_throw_token(p);
  return NULL;
}

ScrDyn *scr_json_parse(ScrStr *text) {
  ScrJsonP p = { text->data, text->len, 0, 0 };
  scr_json_ws(&p);
  if (p.pos >= p.len) {
    scr_json_throw(&p, "Unexpected end of JSON input");
    return NULL;
  }
  /* Documents with a container start intact (ScrDynRegion). */
  if (p.s[p.pos] == '{' || p.s[p.pos] == '[') p.region = scr_dyn_region_new();
  ScrDyn *d = scr_json_value(&p);
  scr_json_shapes_free(&p);
  scr_dyn_region_unref(p.region); /* the parser's own reference */
  if (!d) return NULL;
  scr_json_ws(&p);
  if (p.pos < p.len) {
    scr_dyn_release(d);
    char buf[96];
    int n = snprintf(buf, sizeof buf,
                     "Unexpected non-whitespace character after JSON at position %zu", p.pos);
    scr_throw_error_msg(SCR_ERR_SYNTAX, buf, (size_t)n);
    return NULL;
  }
  return d;
}

/* ── Schema-directed parse (JSON.parse(text) as T) ─────────────────────
 * An optimistic one-pass parser that writes straight into the native
 * layout the compiler describes in a ScrJsonSchema. It accepts only input
 * for which the checked-dynamic route (scr_json_parse + the generated
 * dynCheck builder) would succeed with the same value: every declared key
 * present exactly once with a value of its declared kind, except that a
 * missing undefined-armed union member takes its ABSENT state (the checked
 * route's missing key reads undefined: parsed objects have no prototype
 * chain to inherit from); undeclared keys,
 * or declared keys out of declaration order, are kept beside the record in
 * source order (scr_record_source_note's contract). Anything else — a
 * syntax error, a kind mismatch, a missing or repeated key, excessive
 * nesting —
 * releases the partial value and returns NULL WITHOUT throwing; the
 * compiler-emitted caller then reruns the checked-dynamic route, which
 * produces the exact SyntaxError/TypeError/RangeError. JSON.parse without
 * a reviver is pure, so the rerun is unobservable. The lexer helpers are
 * the ones the dyn parser uses (quiet mode), so strings and numbers decode
 * identically. */

typedef union {
  double f;
  bool b;
  void *ptr;
} ScrJsonSlot;

static bool scr_jschema_read(ScrJsonP *p, const ScrJsonSchema *s, ScrJsonSlot *out);

static void scr_jschema_drop(const ScrJsonSchema *s, ScrJsonSlot *v) {
  if (s->kind == SCR_JSCHEMA_STR) scr_str_release(v->ptr);
  else if (s->kind == SCR_JSCHEMA_REC || s->kind == SCR_JSCHEMA_ARR) s->release(v->ptr);
}

static bool scr_jschema_string_skip(ScrJsonP *p) {
  const char *span;
  size_t span_len;
  int r = scr_json_string_span(p, &span, &span_len);
  if (r > 0) return true;
  if (r < 0) return false;
  ScrStr *decoded = scr_json_string_slow(p, span_len);
  if (!decoded) return false;
  scr_str_release(decoded);
  return true;
}

/* Validates and skips one value (undeclared members). */
static bool scr_jschema_skip(ScrJsonP *p) {
  scr_json_ws(p);
  if (p->pos >= p->len) return false;
  char c = p->s[p->pos];
  if (c == '"') return scr_jschema_string_skip(p);
  if (c == '-' || (c >= '0' && c <= '9')) {
    double ignored;
    return scr_json_number_value(p, &ignored);
  }
  if (c == 't') return scr_json_lit(p, "true", 4);
  if (c == 'f') return scr_json_lit(p, "false", 5);
  if (c == 'n') return scr_json_lit(p, "null", 4);
  if (c != '{' && c != '[') return false;
  if (++p->depth > SCR_JSON_MAX_DEPTH) return false;
  char close = c == '{' ? '}' : ']';
  p->pos++;
  scr_json_ws(p);
  if (p->pos < p->len && p->s[p->pos] == close) {
    p->pos++;
    p->depth--;
    return true;
  }
  for (;;) {
    if (c == '{') {
      scr_json_ws(p);
      if (p->pos >= p->len || p->s[p->pos] != '"' || !scr_jschema_string_skip(p)) return false;
      scr_json_ws(p);
      if (p->pos >= p->len || p->s[p->pos] != ':') return false;
      p->pos++;
    }
    if (!scr_jschema_skip(p)) return false;
    scr_json_ws(p);
    if (p->pos >= p->len) return false;
    if (p->s[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->s[p->pos] != close) return false;
    p->pos++;
    p->depth--;
    return true;
  }
}

/* A number, boolean or string value at p->pos (whitespace already
 * skipped and p->pos < p->len); false when the text does not hold that
 * kind. Inlined into the record and array loops so scalar members do not
 * re-enter scr_jschema_read. */
static inline __attribute__((always_inline)) bool scr_jschema_scalar(ScrJsonP *p, size_t kind,
                                                                     ScrJsonSlot *out) {
  char c = p->s[p->pos];
  switch (kind) {
  case SCR_JSCHEMA_F64:
    if (c != '-' && (c < '0' || c > '9')) return false;
    return scr_json_number_value(p, &out->f);
  case SCR_JSCHEMA_BOOL:
    if (c == 't' && scr_json_lit(p, "true", 4)) {
      out->b = true;
      return true;
    }
    if (c == 'f' && scr_json_lit(p, "false", 5)) {
      out->b = false;
      return true;
    }
    return false;
  default:
    if (c != '"') return false;
    out->ptr = scr_json_string_scr(p);
    return out->ptr != NULL;
  }
}

static bool scr_jschema_is_scalar(size_t kind) {
  return kind == SCR_JSCHEMA_F64 || kind == SCR_JSCHEMA_BOOL || kind == SCR_JSCHEMA_STR;
}

/* A member value: scalars inline, records and arrays through the
 * recursive reader. */
static inline __attribute__((always_inline)) bool scr_jschema_member(ScrJsonP *p,
                                                                     const ScrJsonSchema *type,
                                                                     ScrJsonSlot *out) {
  if (!scr_jschema_is_scalar(type->kind)) return scr_jschema_read(p, type, out);
  scr_json_ws(p);
  if (p->pos >= p->len) return false;
  return scr_jschema_scalar(p, type->kind, out);
}

/* An inline union field slot (INLINE_UNION_FIELD in the backend). */
typedef struct {
  uint32_t tag;
  uint64_t bits;
} ScrJsonInlineUnion;

static void scr_jschema_inline_store(char *slot, size_t tag, uint64_t bits) {
  ScrJsonInlineUnion pair = { (uint32_t)tag, bits };
  memcpy(slot, &pair, sizeof pair);
}

/* A union member value written into its field slot. Each JSON value kind
 * selects at most one arm (the compiler admits no two arms one kind could
 * both match), so the checked route's first full match is that arm, and
 * any other value declines. */
static __attribute__((noinline)) bool scr_jschema_union(ScrJsonP *p, const ScrJsonUnion *u,
                                                         char *slot) {
  scr_json_ws(p);
  if (p->pos >= p->len) return false;
  char c = p->s[p->pos];
  size_t arm;
  if (c == 'n') arm = SCR_JARM_NULL;
  else if (c == '"') arm = SCR_JARM_STR;
  else if (c == '{') arm = SCR_JARM_OBJ;
  else if (c == '[') arm = SCR_JARM_ARR;
  else if (c == 't' || c == 'f') arm = SCR_JARM_BOOL;
  else if (c == '-' || (c >= '0' && c <= '9')) arm = SCR_JARM_NUM;
  else return false;
  size_t tag = u->tags[arm];
  if (tag == SCR_JSCHEMA_NO_ARM) return false;
  if (arm == SCR_JARM_NULL) {
    if (!scr_json_lit(p, "null", 4)) return false;
    if (u->repr == SCR_JUNION_INLINE) scr_jschema_inline_store(slot, tag, 0);
    else memcpy(slot, &u->null_value, sizeof u->null_value); /* immortal */
    return true;
  }
  ScrJsonSlot v;
  if (!scr_jschema_read(p, u->arms[arm], &v)) return false;
  uint64_t bits = 0;
  if (arm == SCR_JARM_NUM) memcpy(&bits, &v.f, sizeof bits);
  else if (arm == SCR_JARM_BOOL) bits = v.b ? 1 : 0;
  else bits = (uint64_t)(uintptr_t)v.ptr;
  switch (u->repr) {
  case SCR_JUNION_NULLABLE: memcpy(slot, &v.ptr, sizeof v.ptr); break; /* moves in */
  case SCR_JUNION_INLINE: scr_jschema_inline_store(slot, tag, bits); break;
  default: {
    void *box = u->box((uint32_t)tag, bits); /* the payload moves in */
    memcpy(slot, &box, sizeof box);
  }
  }
  return true;
}

/* A declared member value written into its (zeroed) slot of `rec`. */
static inline __attribute__((always_inline)) bool scr_jschema_field(ScrJsonP *p,
                                                                    const ScrJsonSchemaField *f,
                                                                    char *rec) {
  char *slot = rec + f->offset;
  const size_t kind = f->type->kind;
  ScrJsonSlot v;
  if (scr_jschema_is_scalar(kind)) {
    scr_json_ws(p);
    if (p->pos >= p->len || !scr_jschema_scalar(p, kind, &v)) return false;
    switch (kind) {
    case SCR_JSCHEMA_F64: memcpy(slot, &v.f, sizeof v.f); break;
    case SCR_JSCHEMA_BOOL: *(uint8_t *)slot = v.b ? 1 : 0; break;
    default: memcpy(slot, &v.ptr, sizeof v.ptr); break; /* zeroed slot; moves in */
    }
    return true;
  }
  if (kind == SCR_JSCHEMA_UNION) return scr_jschema_union(p, f->type->uni, slot);
  if (!scr_jschema_read(p, f->type, &v)) return false;
  memcpy(slot, &v.ptr, sizeof v.ptr); /* zeroed slot; moves in */
  return true;
}

/* The declared members a record's text omitted (`missing`, by field
 * index): each undefined-armed union member takes its ABSENT state, as the
 * checked route's missing key does. Any other omitted member declines. */
static __attribute__((noinline)) bool scr_jschema_absent(const ScrJsonSchema *s, char *rec,
                                                          uint64_t missing) {
  while (missing) {
    const ScrJsonSchemaField *f = &s->fields[__builtin_ctzll(missing)];
    missing &= missing - 1;
    if (f->type->kind != SCR_JSCHEMA_UNION) return false;
    const ScrJsonUnion *u = f->type->uni;
    size_t tag = u->tags[SCR_JARM_ABSENT];
    if (tag == SCR_JSCHEMA_NO_ARM) return false;
    char *slot = rec + f->offset;
    if (u->repr == SCR_JUNION_INLINE) scr_jschema_inline_store(slot, tag, 1); /* ABSENT_FIELD_PAYLOAD */
    else memcpy(slot, &u->absent_value, sizeof u->absent_value); /* immortal */
  }
  return true;
}

/* Bit i set when field i's name (at most eight bytes) holds no quote,
 * backslash or control byte, so text that spells it unescaped is exactly
 * that key. Names are schema constants: each record schema computes its
 * mask once per parse, in a four-entry table. */
static uint64_t scr_jschema_plain(ScrJsonP *p, const ScrJsonSchema *s) {
  size_t slot = ((uintptr_t)s >> 4) & 3;
  if (p->plain_schema[slot] == s) return p->plain_mask[slot];
  uint64_t mask = 0;
  for (size_t i = 0; i < s->nfields && i < 64; i++) {
    const ScrJsonSchemaField *f = &s->fields[i];
    bool plain = f->name_len > 0 && f->name_len <= 8;
    for (size_t k = 0; plain && k < f->name_len; k++) {
      unsigned char c = (unsigned char)f->name[k];
      plain = c >= 0x20 && c != '"' && c != '\\';
    }
    if (plain) mask |= (uint64_t)1 << i;
  }
  p->plain_schema[slot] = s;
  p->plain_mask[slot] = mask;
  return mask;
}

/* The quoted key at p->pos when it is exactly `f`'s name, a plain name of
 * at most eight bytes (scr_jschema_plain): the bytes consumed (name
 * length + 2), else 0. Other names take the general key scan. */
static inline size_t scr_jschema_key_direct(const ScrJsonP *p, const ScrJsonSchemaField *f) {
  size_t len = f->name_len;
  size_t at = p->pos + 1;
  if (len >= p->len - at) return 0;
  const char *text = p->s + at;
  if (text[len] != '"' || scr_key_short_word(text, len) != scr_key_short_word(f->name, len)) return 0;
  return len + 2;
}

/* An undeclared member of a record with an index signature, after its
 * key: the value, read as the index value type, joins the overflow map in
 * source order, as the checked route copies the parsed object's entries.
 * A repeated key (last value, first position) and `__proto__` decline. */
static __attribute__((noinline)) bool scr_jschema_overflow(ScrJsonP *p, const ScrJsonSchema *s,
                                                            char *rec, const char *key,
                                                            size_t key_len) {
  scr_json_ws(p);
  if (p->pos >= p->len || p->s[p->pos] != ':') return false;
  p->pos++;
  if (key_len == 9 && memcmp(key, "__proto__", 9) == 0) return false;
  ScrJsonSlot v;
  if (!scr_jschema_member(p, s->elem, &v)) return false;
  ScrMap *map;
  memcpy(&map, rec + s->ovf_offset, sizeof map);
  uint32_t before = map->nlive;
  ScrStr *name = scr_str_new(key, key_len);
  switch (s->elem->kind) {
  case SCR_JSCHEMA_F64: scr_map_set_str_f64(map, name, v.f); break;
  case SCR_JSCHEMA_BOOL: scr_map_set_str_bool(map, name, v.b); break;
  default: scr_map_set_str_ref(map, name, v.ptr); break; /* moves in */
  }
  scr_str_release(name);
  return map->nlive != before;
}

/* A record's own-key view, started at the first member that leaves the
 * layout's declaration order: placeholders for the declared members read so
 * far, which arrived in that order. */
static ScrDyn *scr_jschema_view(const ScrJsonSchema *s, uint64_t seen) {
  ScrDyn *view = scr_dyn_new_obj();
  for (size_t i = 0; i < s->nfields; i++) {
    if (!(seen & ((uint64_t)1 << i))) continue;
    scr_dyn_obj_set(view, s->fields[i].name, s->fields[i].name_len,
                    scr_dyn_retain(scr_dyn_undefined()));
  }
  return view;
}

/* The rest of a record whose source the record keeps (scr_record_source_note's
 * contract): entered at the member after `key` when that member is undeclared
 * (idx == nfields) or arrives before the previous match. Declared values still
 * parse into the layout; the view holds the source's own keys in order, with
 * placeholders for the declared ones. Takes `rec` and `decoded`. */
static __attribute__((noinline, cold)) bool scr_jschema_record_kept(
    ScrJsonP *p, const ScrJsonSchema *s, ScrJsonSlot *out, char *rec, uint64_t seen,
    size_t guess, size_t idx, const char *key, size_t key_len, ScrStr *decoded) {
  const size_t n = s->nfields;
  const uint64_t all = n == 64 ? ~(uint64_t)0 : (((uint64_t)1 << n) - 1);
  ScrDyn *view = scr_jschema_view(s, seen);
  for (;;) {
    scr_json_ws(p);
    if (p->pos >= p->len || p->s[p->pos] != ':') goto fail;
    p->pos++;
    if (idx < n) {
      const ScrJsonSchemaField *f = &s->fields[idx];
      uint64_t bit = (uint64_t)1 << idx;
      if (seen & bit) goto fail; /* duplicate: last-wins stays on the checked route */
      seen |= bit;
      guess = idx + 1;
      if (!scr_jschema_field(p, f, rec)) goto fail;
      scr_dyn_obj_set(view, key, key_len, scr_dyn_retain(scr_dyn_undefined()));
    } else {
      /* A repeated undeclared key stays on the checked route too. */
      if (scr_dyn_obj_get(view, key, key_len)) goto fail;
      /* Validate quietly first: the dyn parser throws past the depth cap. */
      scr_json_ws(p);
      size_t start = p->pos;
      int depth = p->depth;
      if (!scr_jschema_skip(p)) goto fail;
      p->pos = start;
      p->depth = depth;
      ScrDyn *value = scr_json_value(p);
      if (!value) goto fail;
      scr_dyn_obj_set(view, key, key_len, value);
    }
    scr_str_release(decoded);
    decoded = NULL;
    scr_json_ws(p);
    if (p->pos >= p->len) goto fail;
    if (p->s[p->pos] == '}') {
      p->pos++;
      break;
    }
    if (p->s[p->pos] != ',') goto fail;
    p->pos++;
    scr_json_ws(p);
    if (p->pos >= p->len || p->s[p->pos] != '"') goto fail;
    int r = scr_json_string_span(p, &key, &key_len);
    if (r < 0) goto fail;
    if (r == 0) {
      decoded = scr_json_string_slow(p, key_len);
      if (!decoded) goto fail;
      key = decoded->data;
      key_len = decoded->len;
    }
    idx = n;
    for (size_t i = 0; i < n; i++) {
      if (s->fields[i].name_len == key_len && scr_key_equal(s->fields[i].name, key, key_len)) {
        idx = i;
        break;
      }
    }
  }
  if (seen != all && !scr_jschema_absent(s, rec, all & ~seen)) goto fail;
  ScrRecordSource entry = { rec, view, (const char *)&s->fields[0].name,
                            (const char *)&s->fields[0].name_len, sizeof *s->fields,
                            sizeof *s->fields, n };
  scr_record_source_put(&entry);
  out->ptr = rec;
  return true;
fail:
  scr_str_release(decoded);
  scr_dyn_release(view);
  s->release(rec);
  return false;
}

static bool scr_jschema_record(ScrJsonP *p, const ScrJsonSchema *s, ScrJsonSlot *out) {
  p->pos++; /* '{' */
  char *rec = s->rec_new();
  const size_t n = s->nfields;
  const uint64_t all = n == 64 ? ~(uint64_t)0 : (((uint64_t)1 << n) - 1);
  uint64_t seen = 0;
  size_t guess = 0;
  const uint64_t plain = scr_jschema_plain(p, s);
  scr_json_ws(p);
  if (p->pos < p->len && p->s[p->pos] == '}') {
    p->pos++;
    goto close;
  }
  for (;;) {
    scr_json_ws(p);
    if (p->pos >= p->len || p->s[p->pos] != '"') goto fail;
    /* Members usually arrive in declaration order: try the successor of
     * the previous match, directly against the text, before scanning. */
    size_t idx = n;
    size_t direct =
        guess < n && (plain >> guess & 1) ? scr_jschema_key_direct(p, &s->fields[guess]) : 0;
    if (direct) {
      idx = guess;
      p->pos += direct;
    } else {
      const char *key;
      size_t key_len;
      ScrStr *decoded = NULL;
      int r = scr_json_string_span(p, &key, &key_len);
      if (r < 0) goto fail;
      if (r == 0) {
        decoded = scr_json_string_slow(p, key_len);
        if (!decoded) goto fail;
        key = decoded->data;
        key_len = decoded->len;
      }
      for (size_t i = 0; i < n; i++) {
        if (s->fields[i].name_len == key_len && scr_key_equal(s->fields[i].name, key, key_len)) {
          idx = i;
          break;
        }
      }
      /* An undeclared member, or one before the previous match, keeps the
       * source beside the record: the rest of the object parses there.
       * Records with an index signature keep no source; their undeclared
       * members join the overflow map. */
      if (s->elem) {
        if (idx == n) {
          bool joined = scr_jschema_overflow(p, s, rec, key, key_len);
          scr_str_release(decoded);
          if (!joined) goto fail;
          goto separator;
        }
      } else if (idx == n || idx + 1 < guess) {
        return scr_jschema_record_kept(p, s, out, rec, seen, guess, idx, key, key_len, decoded);
      }
      scr_str_release(decoded);
    }
    scr_json_ws(p);
    if (p->pos >= p->len || p->s[p->pos] != ':') goto fail;
    p->pos++;
    {
      const ScrJsonSchemaField *f = &s->fields[idx];
      uint64_t bit = (uint64_t)1 << idx;
      if (seen & bit) goto fail; /* duplicate: last-wins stays on the checked route */
      seen |= bit;
      guess = idx + 1;
      if (!scr_jschema_field(p, f, rec)) goto fail;
    }
  separator:
    scr_json_ws(p);
    if (p->pos >= p->len) goto fail;
    if (p->s[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->s[p->pos] != '}') goto fail;
    p->pos++;
    break;
  }
close:
  if (seen != all && !scr_jschema_absent(s, rec, all & ~seen)) goto fail;
  out->ptr = rec;
  return true;
fail:
  s->release(rec);
  return false;
}

static bool scr_jschema_array(ScrJsonP *p, const ScrJsonSchema *s, ScrJsonSlot *out) {
  p->pos++; /* '[' */
  ScrArr *arr = s->arr_new(0);
  const ScrJsonSchema *elem = s->elem;
  scr_json_ws(p);
  if (p->pos < p->len && p->s[p->pos] == ']') {
    p->pos++;
    out->ptr = arr;
    return true;
  }
  /* Elements gather in a local run and append in bulk (scr_arr_push_many,
   * which moves references in as scr_arr_push_ref does). */
  uint64_t run[32];
  size_t n = 0;
  for (;;) {
    ScrJsonSlot v;
    if (!scr_jschema_member(p, elem, &v)) goto fail;
    switch (elem->kind) {
    case SCR_JSCHEMA_F64: memcpy(&run[n++], &v.f, sizeof v.f); break;
    case SCR_JSCHEMA_BOOL: run[n++] = v.b ? 1 : 0; break;
    default: run[n++] = (uint64_t)(uintptr_t)v.ptr; break;
    }
    if (n == sizeof run / sizeof run[0]) {
      scr_arr_push_many(arr, n, run);
      n = 0;
    }
    scr_json_ws(p);
    if (p->pos >= p->len) goto fail;
    if (p->s[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->s[p->pos] != ']') goto fail;
    p->pos++;
    scr_arr_push_many(arr, n, run);
    out->ptr = arr;
    return true;
  }
fail:
  scr_arr_push_many(arr, n, run); /* the array releases what it holds */
  s->release(arr);
  return false;
}

static bool scr_jschema_read(ScrJsonP *p, const ScrJsonSchema *s, ScrJsonSlot *out) {
  scr_json_ws(p);
  if (p->pos >= p->len) return false;
  char c = p->s[p->pos];
  switch (s->kind) {
  case SCR_JSCHEMA_F64:
  case SCR_JSCHEMA_BOOL:
  case SCR_JSCHEMA_STR:
    return scr_jschema_scalar(p, s->kind, out);
  case SCR_JSCHEMA_REC:
  case SCR_JSCHEMA_ARR: {
    if (c != (s->kind == SCR_JSCHEMA_REC ? '{' : '[')) return false;
    if (++p->depth > SCR_JSON_MAX_DEPTH) return false;
    bool ok = s->kind == SCR_JSCHEMA_REC ? scr_jschema_record(p, s, out)
                                         : scr_jschema_array(p, s, out);
    p->depth--;
    return ok;
  }
  }
  return false;
}

void *scr_json_parse_schema(const ScrStr *text, const ScrJsonSchema *schema) {
  ScrJsonP p = { text->data, text->len, 0, 0, true };
  ScrJsonSlot v;
  bool read = scr_jschema_read(&p, schema, &v);
  scr_json_shapes_free(&p); /* undeclared members parse as checked values */
  if (!read) return NULL;
  scr_json_ws(&p);
  if (p.pos < p.len) {
    scr_jschema_drop(schema, &v);
    return NULL;
  }
  return v.ptr;
}

/* ── Native JSON callback walks ──────────────────────────────────────
 * Keep these walks separate from the type-directed fast serializer. The
 * replacer observes the original value BEFORE number normalization, and
 * a reviver observes children AFTER their replacements. Neither protocol
 * can be implemented as a callback over already-serialized JSON text.
 *
 * Each frame owns its value and its key snapshot. A callback may mutate
 * siblings, recurse into JSON, or throw; no pointer into an object's
 * reallocatable entry storage survives a callback. Receiver binding is
 * scoped to the call and unwound even when an exception is pending. */
static ScrDyn *scr_json_callback(const ScrDyn *callback, const ScrDyn *holder,
                                 const ScrStr *key, ScrDyn *value) {
  /* The same traversal serves records containing unknown values without a
   * user callback. Keep toJSON, omission, and cycle handling in that walk. */
  if (callback->kind == SCR_DYN_UNDEF) return scr_dyn_retain(value);
  ScrDyn *name = scr_dyn_new_str((ScrStr *)key);
  ScrDyn *args[] = { name, value };
  scr_dyn_this_push_dyn(holder);
  ScrDyn *result = scr_dyn_call(callback, args, 2, "JSON callback");
  scr_dyn_this_pop();
  scr_dyn_release(name);
  return result;
}

static bool scr_json_callback_depth(size_t depth) {
  if (depth <= SCR_JSON_MAX_DEPTH) return true;
  const char *message = "Maximum call stack size exceeded";
  scr_throw_error_msg(SCR_ERR_RANGE, message, strlen(message));
  return false;
}

static ScrStr *scr_json_index_key(size_t index) {
  char bytes[32];
  /* array indexes are below 2^32: exact doubles, printed as integers */
  size_t length = scr_f64_to_str((double)index, bytes);
  return scr_str_new(bytes, length);
}

/* Keys passed here come from our own index formatter or own-key walk. */
static ScrDyn *scr_json_member(const ScrDyn *holder, const ScrStr *key) {
  if (holder->kind == SCR_DYN_TYPED_REF) {
    /* Bound records and arrays answer present members from the native value. */
    ScrDyn *live = scr_dyn_typed_ref_key_get(holder, key);
    if (live) return live;
    ScrDyn *view = scr_dyn_typed_ref_materialize(holder);
    ScrDyn *member = scr_exc_pending() ? NULL : scr_json_member(view, key);
    scr_dyn_release(view);
    return member;
  }
  if (holder->kind == SCR_DYN_ARR || holder->kind == SCR_DYN_BYTES) {
    size_t index = 0;
    for (size_t i = 0; i < key->len; i++) index = index * 10 + (size_t)(key->data[i] - '0');
    if (holder->kind == SCR_DYN_BYTES) {
      return index < holder->v.bytes->len ? scr_dyn_new_num(scr_bytes_get(holder->v.bytes, (double)index))
                                         : scr_dyn_retain(scr_dyn_undefined());
    }
    return scr_dyn_retain(index < holder->v.arr.len ? holder->v.arr.items[index] : scr_dyn_undefined());
  }
  return scr_dyn_obj_read(holder, key->data, key->len);
}

static void scr_json_delete_member(ScrDyn *object, const ScrStr *key) {
  for (size_t i = 0; i < object->v.obj.len; i++) {
    ScrDynEntry *entry = &object->v.obj.entries[i];
    if (entry->key_len != key->len || memcmp(entry->key, key->data, key->len) != 0) continue;
    ScrDynEntry removed = *entry;
    memmove(entry, entry + 1, (object->v.obj.len - i - 1) * sizeof *entry);
    object->v.obj.len--;
    SCR_JS_SHAPE_RESET(object);
    free(object->v.obj.index);
    object->v.obj.index = NULL;
    /* The moved tail aliases a live entry; spare slots own only their own
     * retained key bytes, never a second pointer to a surviving property. */
    memset(&object->v.obj.entries[object->v.obj.len], 0, sizeof *entry);
    scr_dyn_key_release(removed.key, removed.key_len);
    scr_dyn_release(removed.value);
    scr_dyn_release(removed.getter);
    scr_dyn_release(removed.setter);
    return;
  }
}

/* Ordinary native objects carry removable own data properties. Dense
 * arrays, typed references and handles keep their explicit boundary;
 * deleting from a materialized snapshot would lose the mutation. */
void scr_dyn_key_delete(ScrDyn *recv, const ScrStr *key, bool strict) {
#ifdef SCR_NODE_ISLANDS
  if (scr_ni_is_handle(recv)) {
    ScrDyn *k = scr_dyn_new_str((ScrStr *)key);
    (void)scr_ni_delete(recv, k);
    scr_dyn_release(k);
    return;
  }
#endif
  if (scr_dyn_class_reflection_fence(recv) || scr_dyn_error_prototype_fence(recv)) return;
  if (recv->kind == SCR_DYN_PROXY) { scr_dyn_proxy_delete(recv, key); return; }
  if (recv->kind == SCR_DYN_TYPED_REF && recv->v.typed_ref.commit &&
      (!strncmp(recv->v.typed_ref.type_key, "record:", 7) ||
       !strncmp(recv->v.typed_ref.type_key, "object:", 7))) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(recv);
    bool own = !scr_exc_pending() && materialized->kind == SCR_DYN_OBJ &&
               scr_dyn_entry(materialized, key) != NULL;
    if (!scr_exc_pending()) scr_dyn_key_delete(materialized, key, strict);
    bool deleted = own && !scr_exc_pending();
    if (!scr_exc_pending()) {
      scr_dyn_typed_ref_commit(recv);
      scr_error_sync_slots(recv, materialized, key);
    }
    scr_dyn_release(materialized);
    if (deleted && scr_exc_pending()) {
      /* The native layout requires this field, so the commit rejected the
       * view before storing anything new. Restore the view from the native
       * value and refuse the delete like a non-configurable property. */
      scr_exc_clear();
      scr_dyn_release(scr_dyn_typed_ref_materialize(recv));
      if (strict && !scr_exc_pending()) {
        ScrJsonBuf message;
        scr_jb_init(&message);
        scr_jb_puts(&message, "Cannot delete property '");
        scr_jb_write(&message, key->data, key->len);
        scr_jb_puts(&message, "' of #<Object>");
        scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
      }
    }
    return;
  }
  /* A live native array keeps the noncanonical numeric properties written
   * natively ("-1", "1.5") in its property table, and named properties,
   * including numeric-looking keys written through a view, in its metadata,
   * which the view and its commit hold. Deleting such a key removes it from
   * both. Elements and `length` keep the boundary below. */
  size_t element;
  if (recv->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(recv) &&
      !scr_typed_ref_is_length(key) && !scr_typed_ref_canonical_index(key->data, key->len, &element)) {
    double number;
    bool numeric = scr_arr_numeric_key(key->data, key->len, &number);
    if (recv->v.typed_ref.commit) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(recv);
      if (!scr_exc_pending() && view->kind == SCR_DYN_ARR) {
        ScrDynEntry *own = view->v.arr.properties ? scr_dyn_entry(view->v.arr.properties, key) : NULL;
        /* A non-configurable property refuses the delete before either
         * store changes. */
        if (own && !own->configurable) {
          scr_dyn_key_delete(view, key, strict);
        } else {
          if (numeric) scr_arr_delete(recv->v.typed_ref.ptr, number);
          if (own) scr_dyn_key_delete(view, key, strict);
          if (own && !scr_exc_pending()) scr_dyn_typed_ref_commit(recv);
        }
        scr_dyn_release(view);
        return;
      }
      scr_dyn_release(view);
      if (scr_exc_pending()) return;
    }
    if (numeric) {
      scr_arr_delete(recv->v.typed_ref.ptr, number);
      return;
    }
  }
  if (recv->kind == SCR_DYN_FUNC) {
    if (scr_dyn_fn_property_fence(key)) return;
    ScrDyn *table = scr_dyn_fn_properties(recv);
    scr_dyn_key_delete(table, key, strict);
    scr_dyn_release(table);
    return;
  }
  if (recv->kind == SCR_DYN_OBJ) {
    ScrDynEntry *entry = scr_dyn_entry(recv, key);
    if (entry && !entry->configurable) {
      if (strict) {
        static const char message[] = "Cannot delete non-configurable property";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      }
      return;
    }
    scr_json_delete_member(recv, key);
    scr_error_sync_cause(recv, key);
    return;
  }
  if (recv->kind == SCR_DYN_ARR && scr_dyn_canonical_own_index(key, recv->v.arr.len)) {
    size_t index = 0;
    for (size_t i = 0; i < key->len; i++) index = index * 10 + (size_t)(key->data[i] - '0');
    if (!scr_dyn_arr_has_index(recv, index)) return;
    if (recv->v.arr.sealed) {
      if (strict) {
        static const char message[] = "Cannot delete non-configurable property";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      }
      return;
    }
    if (!recv->v.arr.presence) {
      recv->v.arr.presence = malloc(recv->v.arr.cap);
      if (!recv->v.arr.presence) scr_json_oom();
      memset(recv->v.arr.presence, 1, recv->v.arr.len);
    }
    recv->v.arr.presence[index] = 0;
    scr_dyn_release(recv->v.arr.items[index]);
    recv->v.arr.items[index] = scr_dyn_retain(scr_dyn_undefined());
    return;
  }
  if (recv->kind == SCR_DYN_ARR && recv->v.arr.properties &&
      scr_dyn_obj_get(recv->v.arr.properties, key->data, key->len)) {
    scr_dyn_key_delete(recv->v.arr.properties, key, strict);
    return;
  }
  if (recv->kind == SCR_DYN_UNDEF || recv->kind == SCR_DYN_NULL) {
    const char *message = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return;
  }
  const char *message = "delete on this checked-native receiver is not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
}

static ScrDyn *scr_json_revive(ScrDyn *holder, const ScrStr *key,
                              const ScrDyn *reviver, size_t depth) {
  if (!scr_json_callback_depth(depth)) return NULL;
  ScrDyn *value = scr_json_member(holder, key);
  if (!value) return NULL;
  if (value->kind == SCR_DYN_ARR) {
    /* Capture length once, but read each member at the time it is visited. */
    size_t length = value->v.arr.len;
    for (size_t i = 0; i < length; i++) {
      ScrStr *index = scr_json_index_key(i);
      ScrDyn *replacement = scr_json_revive(value, index, reviver, depth + 1);
      scr_str_release(index);
      if (!replacement) { scr_dyn_release(value); return NULL; }
      if (replacement->kind == SCR_DYN_UNDEF) {
        /* The checked-dynamic array ABI is dense. Do not pretend that an
         * undefined element is a hole: hasOwn/keys would be observably wrong. */
        const char *message = "JSON.parse reviver deleting array elements is not supported yet";
        scr_throw_error_msg(SCR_ERR_ERROR, message, strlen(message));
        scr_dyn_release(replacement);
        scr_dyn_release(value);
        return NULL;
      }
      while (value->v.arr.len <= i) scr_dyn_arr_push(value, scr_dyn_retain(scr_dyn_undefined()));
      ScrDyn *old = value->v.arr.items[i];
      if (replacement != old) scr_dyn_region_store(value, replacement);
      value->v.arr.items[i] = replacement;
      scr_dyn_release(old);
    }
  } else if (value->kind == SCR_DYN_OBJ) {
    ScrDyn *keys = scr_dyn_obj_keys(value);
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      const ScrStr *name = keys->v.arr.items[i]->v.str;
      ScrDyn *replacement = scr_json_revive(value, name, reviver, depth + 1);
      if (!replacement) { scr_dyn_release(keys); scr_dyn_release(value); return NULL; }
      if (replacement->kind == SCR_DYN_UNDEF) {
        scr_json_delete_member(value, name);
        scr_dyn_release(replacement);
      } else {
        ScrDynEntry *entry = scr_dyn_entry(value, name);
        if (entry) {
          ScrDyn *old = entry->value;
          if (replacement != old) scr_dyn_region_store(value, replacement);
          entry->value = replacement;
          scr_dyn_release(old);
        } else {
          scr_dyn_obj_set(value, name->data, name->len, replacement);
        }
      }
    }
    scr_dyn_release(keys);
  }
  ScrDyn *result = scr_json_callback(reviver, holder, key, value);
  scr_dyn_release(value);
  return result;
}

ScrDyn *scr_json_parse_reviver(ScrStr *text, const ScrDyn *reviver) {
  ScrDyn *parsed = scr_json_parse(text);
  if (!parsed) return NULL; /* No callback runs on invalid input. */
  if (reviver->kind != SCR_DYN_FUNC) return parsed;
  ScrDyn *holder = scr_dyn_new_obj();
  scr_dyn_obj_set(holder, "", 0, parsed);
  ScrStr *key = scr_str_new("", 0);
  ScrDyn *result = scr_json_revive(holder, key, reviver, 0);
  scr_str_release(key);
  scr_dyn_release(holder);
  return result;
}

/* Buffer's toJSON happens before the replacer. The returned data object
 * is owned by this walk; a replacer-returned Buffer is never sent here. */
static ScrDyn *scr_json_buffer_view(const ScrDyn *value) {
  ScrDyn *view = scr_dyn_new_obj();
  const ScrBytes *bytes = value->v.bytes;
  ScrStr *name = scr_str_new("Buffer", 6);
  scr_dyn_obj_set(view, "type", 4, scr_dyn_new_str(name));
  scr_str_release(name);
  ScrDyn *data = scr_dyn_new_arr();
  for (size_t i = 0; i < bytes->len; i++) scr_dyn_arr_push(data, scr_dyn_new_num(scr_bytes_get(bytes, (double)i)));
  scr_dyn_obj_set(view, "data", 4, data);
  return view;
}

/* A capsule whose JSON walk needs no checked view: a bound live array
 * (never converted by toJSON), or a bound live record without a cached view
 * and, when `inspect`ing for conversion, without a present `toJSON` field. */
static bool scr_json_live_container(const ScrDyn *value, bool inspect) {
  if (scr_dyn_typed_ref_array_ops(value)) return true;
  const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(value);
  if (!record) return false;
  if (!inspect) return true;
  for (size_t i = 0; i < record->count; i++) {
    const ScrStr *name = record->names[i];
    if (name->len == 6 && memcmp(name->data, "toJSON", 6) == 0 && record->has(value->v.typed_ref.ptr, i))
      return false;
  }
  return true;
}

/* SerializeJSONProperty's toJSON step over a member value (consumed): Date,
 * URL and net handles convert through their toJSON, a Buffer through its
 * { type, data } view, and an object with a callable toJSON through that
 * method, called with the key. Returns the value to serialize (+1), or NULL
 * with an exception pending. */
/* The toJSON key argument: `key`, or the decimal spelling of array index
 * `index` when `key` is NULL (formed only for a call that receives it). */
static ScrDyn *scr_json_key_arg(const ScrStr *key, size_t index) {
  if (key) return scr_dyn_new_str((ScrStr *)key);
  ScrStr *text = scr_json_index_key(index);
  ScrDyn *name = scr_dyn_new_str(text);
  scr_str_release(text);
  return name;
}

static ScrDyn *scr_json_to_json_at(ScrDyn *value, const ScrStr *key, size_t index) {
  /* An instance of a class declared `extends Date` converts through its
   * toJSON, declared or inherited. */
  double time;
  if (value->kind == SCR_DYN_TYPED_REF && scr_dyn_date_class_time(value, &time)) {
    ScrDyn *name = scr_json_key_arg(key, index);
    ScrDyn *converted = scr_dyn_date_class_to_json(value, name);
    scr_dyn_release(name);
    scr_dyn_release(value);
    return converted;
  }
  /* Inspect a typed reference without replacing its live identity. Later
   * members must read the source again after a callback mutates it. A live
   * array, or a live record without a `toJSON` field, needs no conversion. */
  ScrDyn *view = value->kind == SCR_DYN_TYPED_REF && !scr_json_live_container(value, true)
      ? scr_dyn_typed_ref_materialize(value) : NULL;
  const ScrDyn *inspected = view ? view : value;
  if (scr_exc_pending()) { scr_dyn_release(view); scr_dyn_release(value); return NULL; }
  if (inspected->kind == SCR_DYN_HANDLE && (inspected->v.handle.tag == SCR_DYNH_DATE || inspected->v.handle.tag == SCR_DYNH_URL ||
                                             inspected->v.handle.tag == SCR_DYNH_NET_SOCKET_ADDRESS ||
                                             inspected->v.handle.tag == SCR_DYNH_NET_BLOCK_LIST)) {
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(inspected);
    ScrDyn *converted = ops->invoke(inspected->v.handle.ptr, value, "toJSON", NULL, 0, "toJSON");
    scr_dyn_release(value);
    value = converted;
  } else if (inspected->kind == SCR_DYN_BYTES && inspected->buffer) {
    ScrDyn *converted = scr_json_buffer_view(inspected);
    scr_dyn_release(value);
    value = converted;
  } else if (inspected->kind == SCR_DYN_OBJ) {
    ScrDyn *method = scr_dyn_obj_read(inspected, "toJSON", 6);
    if (!method) { scr_dyn_release(view); scr_dyn_release(value); return NULL; }
    if (method->kind == SCR_DYN_FUNC) {
      ScrDyn *name = scr_json_key_arg(key, index);
      ScrDyn *args[] = { name };
      scr_dyn_this_push_dyn(value);
      ScrDyn *converted = scr_dyn_call(method, args, 1, "toJSON");
      scr_dyn_this_pop();
      scr_dyn_release(method);
      scr_dyn_release(name);
      scr_dyn_release(value);
      value = converted;
    } else scr_dyn_release(method);
  }
  scr_dyn_release(view);
  return value;
}

static ScrDyn *scr_json_to_json(ScrDyn *value, const ScrStr *key) {
  return scr_json_to_json_at(value, key, 0);
}

static ScrDyn *scr_json_replace(const ScrDyn *holder, const ScrStr *key, const ScrDyn *replacer) {
  ScrDyn *value = scr_json_member(holder, key);
  if (!value) return NULL;
  value = scr_json_to_json(value, key);
  if (!value) return NULL;
  ScrDyn *result = scr_json_callback(replacer, holder, key, value);
  scr_dyn_release(value);
  return result;
}

static bool scr_json_omitted(const ScrDyn *value) {
  return value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_FUNC || value->kind == SCR_DYN_SYMBOL;
}

static void scr_json_gap(ScrJsonBuf *buffer, const ScrStr *gap, size_t depth) {
  if (!gap->len) return;
  const char *end = memchr(gap->data, 0, gap->len);
  size_t length = end ? (size_t)(end - gap->data) : gap->len;
  scr_jb_indent(buffer, gap->data, length, depth);
}

/* These primitive values cannot invoke toJSON or mutate a containing frame.
 * BigInts, functions and every reference kind keep the protocol walk. */
static bool scr_json_plain_value(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_NULL: case SCR_DYN_UNDEF: case SCR_DYN_SYMBOL:
  case SCR_DYN_BOOL: case SCR_DYN_NUM: case SCR_DYN_STR: return true;
  default: return false;
  }
}

/* Prove the whole immediate container before writing any of it. Without a
 * replacer or executable children, entries cannot change and borrowed names
 * need neither a key snapshot nor repeated lookups. Numeric property names
 * keep the ordinary sorted-key walk; sparse/accessor arrays keep Get. This
 * proof is repeated per call, so later mutations never leave a stale fact.
 *
 * A container of an intact parse region (ScrDynRegion) holds only JSON
 * primitives, undefined and containers of its own region, which have no
 * prototype, accessors or toJSON function (a toJSON member there is never
 * callable, which SerializeJSONProperty ignores). So its members need no
 * inspection, which also keeps the proof from touching every member node:
 * writing a member subtree runs no program code that could mutate this
 * container mid-walk, and no cycle passes through it (the circular-structure
 * check has nothing to find). Each member container is still written through
 * scr_json_replaced_write, which proves it afresh. */
static bool scr_json_plain_container(const ScrDyn *value) {
  const ScrDynRegion *region = scr_dyn_region_of(value);
  bool intact = region && region->intact;
  if (value->kind == SCR_DYN_ARR) {
    if (value->v.arr.presence || value->v.arr.properties) return false;
    if (intact) return true;
    for (size_t i = 0; i < value->v.arr.len; i++)
      if (!scr_json_plain_value(value->v.arr.items[i])) return false;
    return true;
  }
  if (value->kind != SCR_DYN_OBJ) return false;
  for (size_t i = 0; i < value->v.obj.len; i++) {
    const ScrDynEntry *entry = &value->v.obj.entries[i];
    if (!entry->enumerable) continue;
    double index;
    if (entry->accessor || (!intact && !scr_json_plain_value(entry->value)) ||
        scr_dyn_key_is_index(entry->key, entry->key_len, &index)) return false;
  }
  return true;
}

static bool scr_json_replaced_write(ScrJsonBuf *buffer, const ScrDyn *value,
                                   const ScrDyn *replacer, const ScrDyn *properties,
                                   const ScrStr *gap, size_t depth);

/* Out of line so the protocol walk's frame stays as small as it was: deep
 * documents recurse through one of the two, and plain nesting recurses
 * here directly, one small frame per level. */
static __attribute__((noinline)) bool scr_json_plain_write(ScrJsonBuf *buffer, const ScrDyn *value,
                                                           const ScrStr *gap, size_t depth) {
  bool array = value->kind == SCR_DYN_ARR;
  size_t length = array ? value->v.arr.len : value->v.obj.len;
  scr_jb_putc(buffer, array ? '[' : '{');
  bool first = true;
  for (size_t i = 0; i < length; i++) {
    const ScrDynEntry *entry = array ? NULL : &value->v.obj.entries[i];
    if (entry && !entry->enumerable) continue;
    const ScrDyn *child = array ? value->v.arr.items[i] : entry->value;
    bool omitted = scr_json_omitted(child);
    if (!array && omitted) continue;
    if (!omitted && !scr_json_callback_depth(depth + 1)) return false;
    if (!first) scr_jb_putc(buffer, ',');
    first = false;
    scr_json_gap(buffer, gap, depth + 1);
    if (entry) {
      scr_jb_put_json_span(buffer, entry->key, entry->key_len);
      scr_jb_putc(buffer, ':');
      if (gap->len) scr_jb_putc(buffer, ' ');
    }
    if (omitted) scr_jb_puts(buffer, "null");
    else if (child->kind == SCR_DYN_ARR || child->kind == SCR_DYN_OBJ) {
      /* Only an intact region admits these (scr_json_plain_container); its
       * members are never capsules, so a member that is not plain itself
       * (holes, index-like names) only needs the protocol walk. */
      bool ok = scr_json_plain_container(child)
          ? scr_json_plain_write(buffer, child, gap, depth + 1)
          : scr_json_replaced_write(buffer, child, scr_dyn_undefined(), NULL, gap, depth + 1);
      if (!ok) return false;
    } else scr_dyn_json_write(buffer, child);
  }
  if (!first) scr_json_gap(buffer, gap, depth);
  scr_jb_putc(buffer, array ? ']' : '}');
  return true;
}

/* An array replacer's PropertyList: its string and number elements, in
 * order, as strings, with later duplicates dropped. Other elements (and
 * holes) contribute nothing. */
static ScrDyn *scr_json_property_list(const ScrDyn *replacer) {
  ScrDyn *view = replacer->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(replacer) : NULL;
  if (scr_exc_pending()) { scr_dyn_release(view); return NULL; }
  const ScrDyn *items = view ? view : replacer;
  ScrDyn *list = scr_dyn_new_arr();
  for (size_t i = 0; items->kind == SCR_DYN_ARR && i < items->v.arr.len; i++) {
    if (!scr_dyn_arr_has_index(items, i)) continue;
    const ScrDyn *item = items->v.arr.items[i];
    ScrStr *name = item->kind == SCR_DYN_STR ? scr_str_retain(item->v.str)
        : item->kind == SCR_DYN_NUM ? scr_f64_to_scrstr(item->v.num) : NULL;
    if (!name) continue;
    bool seen = false;
    for (size_t j = 0; j < list->v.arr.len && !seen; j++) seen = scr_str_eq(list->v.arr.items[j]->v.str, name);
    if (!seen) scr_dyn_arr_push(list, scr_dyn_new_str(name));
    scr_str_release(name);
  }
  scr_dyn_release(view);
  return list;
}

/* The protocol walk over a live record or array capsule without a replacer
 * (the caller entered it on the circular-structure stack). Members are read
 * from the native value exactly as scr_json_member reads them, but the walk
 * needs no key list: a record's present fields are snapshotted by index (its
 * keys are the immortal field names) and an array's indexes are counted, so
 * an index key string is formed only for a toJSON call that receives it. */
static bool scr_json_live_write(ScrJsonBuf *buffer, const ScrDyn *value, bool array,
                                const ScrStr *gap, size_t depth) {
  const ScrDynTypedRecordOps *record = array ? NULL : scr_typed_ref_record_ops(value);
  /* EnumerableOwnProperties runs once, before any member's toJSON (the
   * caller sends records of more than 64 fields down the key-list walk). */
  uint64_t present = 0;
  size_t length;
  if (array) {
    length = ((ScrArr *)value->v.typed_ref.ptr)->len;
  } else {
    length = record->count;
    for (size_t i = 0; i < length; i++)
      if (record->fixed || record->has(value->v.typed_ref.ptr, i)) present |= (uint64_t)1 << i;
  }
  scr_jb_putc(buffer, array ? '[' : '{');
  bool first = true;
  for (size_t i = 0; i < length; i++) {
    if (!array && !(present & ((uint64_t)1 << i))) continue;
    const ScrStr *key = array ? NULL : record->names[i];
    ScrDyn *child;
    if (array) {
      scr_jb_edge_idx(buffer, i);
      /* scr_json_member's index read, minus the key: a present element
       * answers directly; holes, a length a callback shrank, a capsule a
       * callback materialized and inherited event members take the keyed
       * read */
      child = !scr_event_ref_hooks && scr_dyn_typed_ref_array_ops(value) ? scr_dyn_typed_ref_element(value, i)
                                                                        : NULL;
      if (!child) {
        ScrStr *index = scr_json_index_key(i);
        child = scr_json_member(value, index);
        scr_str_release(index);
      }
    } else {
      scr_jb_edge_key(buffer, key);
      child = scr_json_member(value, key);
    }
    if (child) child = scr_json_to_json_at(child, key, i);
    if (!child) return false;
    if (!array && scr_json_omitted(child)) {
      scr_dyn_release(child);
      continue;
    }
    if (!first) scr_jb_putc(buffer, ',');
    first = false;
    scr_json_gap(buffer, gap, depth + 1);
    if (!array) {
      scr_jb_put_json_str(buffer, key);
      scr_jb_putc(buffer, ':');
      if (gap->len) scr_jb_putc(buffer, ' ');
    }
    bool ok = true;
    if (scr_json_omitted(child)) scr_jb_puts(buffer, "null");
    else if (scr_json_plain_value(child)) {
      /* the protocol walk's depth check, then the primitive itself */
      ok = scr_json_callback_depth(depth + 1);
      if (ok) {
        scr_dyn_json_write(buffer, child);
        ok = !scr_exc_pending();
      }
    } else ok = scr_json_replaced_write(buffer, child, scr_dyn_undefined(), NULL, gap, depth + 1);
    scr_dyn_release(child);
    if (!ok) return false;
  }
  if (!first) scr_json_gap(buffer, gap, depth);
  scr_jb_putc(buffer, array ? ']' : '}');
  return true;
}

/* `properties`, when present, is an array replacer's PropertyList: objects
 * serialize exactly those keys, own or inherited, in that order; arrays
 * keep all their indexes. */
static bool scr_json_replaced_write(ScrJsonBuf *buffer, const ScrDyn *value,
                                   const ScrDyn *replacer, const ScrDyn *properties,
                                   const ScrStr *gap, size_t depth) {
  if (!scr_json_callback_depth(depth)) return false;
  /* A live record or array is walked through the capsule itself: its keys
   * and members come from the native value, one member at a time. */
  bool live = value->kind == SCR_DYN_TYPED_REF && scr_json_live_container(value, false);
  ScrDyn *view = value->kind == SCR_DYN_TYPED_REF && !live ? scr_dyn_typed_ref_materialize(value) : NULL;
  const ScrDyn *observed = view ? view : value;
  if (scr_exc_pending()) { scr_dyn_release(view); return false; }
  if (!view && !live && replacer->kind == SCR_DYN_UNDEF && !properties && scr_json_plain_container(value))
    return scr_json_plain_write(buffer, value, gap, depth);
  ScrDynKind kind = !live ? observed->kind : scr_dyn_typed_ref_array_ops(value) ? SCR_DYN_ARR : SCR_DYN_OBJ;
  if (kind != SCR_DYN_OBJ && kind != SCR_DYN_ARR && kind != SCR_DYN_BYTES) {


    scr_dyn_json_write(buffer, observed);
    scr_dyn_release(view);
    return !scr_exc_pending();
  }
  bool array = kind == SCR_DYN_ARR;
  /* Different capsules may refer to the same native container. Detect
   * cycles by the original payload, while sibling references remain legal
   * after the current frame leaves the traversal stack. */
  const void *identity = view || live ? value->v.typed_ref.ptr : (const void *)value;
  if (!scr_jb_enter(buffer, identity, array)) { scr_dyn_release(view); return false; }
  if (live && replacer->kind == SCR_DYN_UNDEF && !properties &&
      (array || scr_typed_ref_record_ops(value)->count <= 64)) {
    bool ok = scr_json_live_write(buffer, value, array, gap, depth);
    scr_jb_leave(buffer);
    return ok;
  }
  scr_jb_putc(buffer, array ? '[' : '{');
  ScrDyn *keys = array ? NULL : properties ? scr_dyn_retain((ScrDyn *)properties) : scr_dyn_obj_keys(observed);
  if (scr_exc_pending()) { scr_dyn_release(keys); scr_dyn_release(view); scr_jb_leave(buffer); return false; }
  size_t length = !array ? keys->v.arr.len
      : live ? ((ScrArr *)value->v.typed_ref.ptr)->len : observed->v.arr.len;
  bool first = true;
  bool ok = true;
  for (size_t i = 0; i < length; i++) {
    ScrStr *key = array ? scr_json_index_key(i) : scr_str_retain(keys->v.arr.items[i]->v.str);
    if (array) scr_jb_edge_idx(buffer, i);
    else scr_jb_edge_key(buffer, key);
    ScrDyn *child = scr_json_replace(value, key, replacer);
    if (!child) { scr_str_release(key); ok = false; break; }
    if (!array && scr_json_omitted(child)) {
      scr_dyn_release(child);
      scr_str_release(key);
      continue;
    }
    if (!first) scr_jb_putc(buffer, ',');
    first = false;
    scr_json_gap(buffer, gap, depth + 1);
    if (!array) {
      scr_jb_put_json_str(buffer, key);
      scr_jb_putc(buffer, ':');
      if (gap->len) scr_jb_putc(buffer, ' ');
    }
    if (scr_json_omitted(child)) scr_jb_puts(buffer, "null");
    else ok = scr_json_replaced_write(buffer, child, replacer, properties, gap, depth + 1);
    scr_dyn_release(child);
    scr_str_release(key);
    if (!ok) break;
  }
  scr_dyn_release(keys);
  scr_dyn_release(view);
  scr_jb_leave(buffer);
  if (!ok) return false;
  if (!first) scr_json_gap(buffer, gap, depth);
  scr_jb_putc(buffer, array ? ']' : '}');
  return true;
}

static ScrDyn *scr_json_stringify_with(const ScrDyn *value, const ScrDyn *replacer,
                                       const ScrDyn *properties, const ScrStr *gap) {
  ScrDyn *holder = scr_dyn_new_obj();
  scr_dyn_obj_set(holder, "", 0, scr_dyn_retain((ScrDyn *)value));
  ScrStr *key = scr_str_new("", 0);
  ScrDyn *replaced = scr_json_replace(holder, key, replacer);
  scr_str_release(key);
  scr_dyn_release(holder);
  if (!replaced) return NULL;
  if (scr_json_omitted(replaced)) {
    scr_dyn_release(replaced);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  bool ok = scr_json_replaced_write(&buffer, replaced, replacer, properties, gap, 0);
  scr_dyn_release(replaced);
  if (!ok) { scr_jb_dispose(&buffer); return NULL; }
  ScrStr *text = scr_jb_finish(&buffer);
  ScrDyn *result = scr_dyn_new_str(text);
  scr_str_release(text);
  return result;
}

ScrDyn *scr_json_stringify_replacer(const ScrDyn *value, const ScrDyn *replacer, const ScrStr *gap) {
  if (replacer->kind == SCR_DYN_ARR || (replacer->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(replacer))) {
    ScrDyn *properties = scr_json_property_list(replacer);
    if (!properties) return NULL;
    ScrDyn *result = scr_json_stringify_with(value, scr_dyn_undefined(), properties, gap);
    scr_dyn_release(properties);
    return result;
  }
  return scr_json_stringify_with(value, replacer, NULL, gap);
}

ScrDyn *scr_json_stringify_value(const ScrDyn *value, const ScrDyn *replacer, const ScrDyn *space) {
  ScrStr *gap;
  if (space->kind == SCR_DYN_STR) gap = scr_str_slice(space->v.str, 0, 10);
  else if (space->kind == SCR_DYN_NUM) {
    double count = space->v.num;
    size_t length = isnan(count) || count <= 0 ? 0 : count >= 10 ? 10 : (size_t)count;
    gap = scr_str_new("          ", length);
  } else gap = scr_str_new("", 0);
  bool list = replacer->kind == SCR_DYN_ARR || (replacer->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(replacer));
  ScrDyn *result = scr_json_stringify_replacer(value, replacer->kind == SCR_DYN_FUNC || list ? replacer : scr_dyn_undefined(), gap);
  scr_str_release(gap);
  return result;
}

/* util.format's %j over a pending stringify exception (Node's
 * tryStringify): a TypeError whose first message line is "Converting
 * circular structure to JSON" is cleared and the result is the text
 * "[Circular]" (+1). Any other exception is put back and the result is
 * NULL. */
static ScrStr *scr_json_circular_or_rethrow(void) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *thrown = scr_caught_to_dyn(caught);
  ScrError *error = scr_errdyn_err_of(thrown);
  scr_dyn_release(thrown);
  static const char circular[] = "Converting circular structure to JSON";
  bool is_circular = false;
  if (error && error->name && error->message) {
    const ScrStr *message = error->message;
    const char *newline = memchr(message->data, '\n', message->len);
    size_t first_line = newline ? (size_t)(newline - message->data) : message->len;
    is_circular = error->name->len == 9 && memcmp(error->name->data, "TypeError", 9) == 0 &&
        first_line == sizeof circular - 1 && memcmp(message->data, circular, first_line) == 0;
  }
  scr_error_release(error);
  if (!is_circular) scr_rethrow(caught);
  scr_caught_release(caught);
  return is_circular ? scr_str_new("[Circular]", 10) : NULL;
}

/* util.format's %j over a dynamic value (+1): JSON.stringify(d), the text
 * "undefined" when the stringify returns undefined, and "[Circular]" for a
 * circular structure. NULL with any other exception pending. */
ScrStr *scr_util_format_j(const ScrDyn *d) {
  ScrStr *gap = scr_str_new("", 0);
  ScrDyn *result = scr_json_stringify_replacer(d, scr_dyn_undefined(), gap);
  scr_str_release(gap);
  if (!result) return scr_exc_pending() ? scr_json_circular_or_rethrow() : NULL;
  ScrStr *text = result->kind == SCR_DYN_STR ? scr_str_retain(result->v.str) : scr_str_new("undefined", 9);
  scr_dyn_release(result);
  return text;
}

/* util.format's %j over a typed value whose serializer can throw (+1): the
 * serialized text when no exception is pending, "[Circular]" for a circular
 * structure, NULL with any other exception pending. Borrows text. */
ScrStr *scr_util_format_j_text(ScrStr *text) {
  if (!scr_exc_pending()) return scr_str_retain(text);
  return scr_json_circular_or_rethrow();
}

/* The gap of a compact walk; the walks read only its length. */
static const ScrStr scr_json_compact_gap = { .rc = SIZE_MAX, .len = 0 };

#define SCR_JSON_PURE_DEPTH 32

/* Writes `value` when writing it runs no program code and meets no cycle:
 * JSON primitives, and objects and dense arrays with the default prototype
 * whose members are such values, where objects hold only data properties
 * under names that are neither array indexes nor "toJSON" (so their own
 * key order is their insertion order and no toJSON step applies). Answers
 * false, having written part of the value, for anything else, including
 * nesting deeper than SCR_JSON_PURE_DEPTH; the caller then truncates the
 * buffer and runs the protocol walk. */
static bool scr_jb_put_pure(ScrJsonBuf *b, const ScrDyn *value, size_t depth) {
  switch (value->kind) {
  case SCR_DYN_NULL: scr_jb_puts(b, "null"); return true;
  case SCR_DYN_BOOL: scr_jb_puts(b, value->v.b ? "true" : "false"); return true;
  case SCR_DYN_NUM: scr_jb_put_f64(b, value->v.num); return true;
  case SCR_DYN_STR: scr_jb_put_json_str(b, value->v.str); return true;
  case SCR_DYN_ARR:
    if (value->prototype || value->v.arr.presence || value->v.arr.properties ||
        depth == SCR_JSON_PURE_DEPTH)
      return false;
    scr_jb_putc(b, '[');
    for (size_t i = 0; i < value->v.arr.len; i++) {
      if (i > 0) scr_jb_putc(b, ',');
      const ScrDyn *item = value->v.arr.items[i];
      if (scr_json_omitted(item)) scr_jb_puts(b, "null");
      else if (!scr_jb_put_pure(b, item, depth + 1)) return false;
    }
    scr_jb_putc(b, ']');
    return true;
  case SCR_DYN_OBJ: {
    if (value->prototype || depth == SCR_JSON_PURE_DEPTH) return false;
    scr_jb_putc(b, '{');
    bool first = true;
    for (size_t i = 0; i < value->v.obj.len; i++) {
      const ScrDynEntry *entry = &value->v.obj.entries[i];
      if (!entry->enumerable) continue;
      double index;
      if (entry->accessor || (entry->key_len == 6 && memcmp(entry->key, "toJSON", 6) == 0) ||
          (entry->key_len && (unsigned char)(entry->key[0] - '0') < 10 &&
           scr_dyn_key_is_index(entry->key, entry->key_len, &index)))
        return false;
      if (scr_json_omitted(entry->value)) continue;
      if (!first) scr_jb_putc(b, ',');
      first = false;
      scr_jb_put_json_span(b, entry->key, entry->key_len);
      scr_jb_putc(b, ':');
      if (!scr_jb_put_pure(b, entry->value, depth + 1)) return false;
    }
    scr_jb_putc(b, '}');
    return true;
  }
  default:
    return false;
  }
}

/* Writes the separator, key and value of an object member whose value
 * scr_jb_put_pure can write, or drops a member holding undefined, a
 * function or a symbol. `key_str`, when not NULL, is the key as a string.
 * Answers false, with the buffer and `first` as they were, for a value
 * that needs the protocol walk. */
static inline __attribute__((always_inline)) bool scr_jb_try_pure_member(
    ScrJsonBuf *b, const char *key, size_t key_len, const ScrStr *key_str, const ScrDyn *value,
    bool *first) {
  if (scr_json_omitted(value)) return true;
  size_t mark = b->len;
  if (!*first) scr_jb_putc(b, ',');
  if (key_str) scr_jb_put_json_str(b, key_str);
  else scr_jb_put_json_span(b, key, key_len);
  scr_jb_putc(b, ':');
  if (scr_jb_put_pure(b, value, 0)) {
    *first = false;
    return true;
  }
  b->len = mark;
  return false;
}

/* Writes one object member of a typed container: `value` (consumed) goes
 * through its toJSON step, an undefined, function or symbol result drops
 * the member, and any other result is written after the separator and the
 * key through the protocol walk, whose circular-structure checks share the
 * buffer's stack. The container is the top of that stack, or `rec` is
 * pushed for the walk when it is not; the key becomes the container's
 * edge. Answers false with an exception pending. */
static bool scr_jb_put_member_walk(ScrJsonBuf *b, const ScrStr *key, ScrDyn *value,
                                   bool *first, void *rec) {
  ScrDyn *child = scr_json_to_json(value, key);
  if (!child) return false;
  if (scr_json_omitted(child)) {
    scr_dyn_release(child);
    return true;
  }
  bool entered = rec && !(b->seen_len && b->seen[b->seen_len - 1].ptr == rec);
  if (entered && !scr_jb_enter(b, rec, false)) {
    scr_dyn_release(child);
    return false;
  }
  if (!*first) scr_jb_putc(b, ',');
  *first = false;
  scr_jb_put_json_str(b, key);
  scr_jb_putc(b, ':');
  scr_jb_edge_key(b, key);
  bool ok = scr_json_replaced_write(b, child, scr_dyn_undefined(), NULL, &scr_json_compact_gap,
                                    b->seen_len);
  if (entered) scr_jb_leave(b);
  scr_dyn_release(child);
  return ok;
}

/* scr_jb_put_member_walk, writing the member directly when scr_jb_put_pure
 * can write its value. */
static bool scr_jb_put_member(ScrJsonBuf *b, const ScrStr *key, ScrDyn *value, bool *first,
                              void *rec) {
  if (scr_jb_try_pure_member(b, key->data, key->len, key, value, first)) {
    scr_dyn_release(value);
    return true;
  }
  return scr_jb_put_member_walk(b, key, value, first, rec);
}

/* An entry of a record's `unknown` index signature, written after the
 * record's earlier members with JSON.stringify's member rules
 * (scr_jb_put_member). Walkers over cycle-capable shapes have pushed the
 * record already; others push it for an entry that needs the protocol
 * walk. May leave an exception pending. */
static void scr_jb_put_dyn_entry(ScrJsonBuf *b, void *rec, const ScrStr *key,
                                 const ScrDyn *value, bool *first) {
  if (scr_jb_try_pure_member(b, key->data, key->len, key, value, first)) return;
  scr_jb_put_member_walk(b, key, scr_dyn_retain((ScrDyn *)value), first, rec);
}

/* The entries of record `rec`'s `unknown` index signature (`map`: string
 * keys, checked-dynamic values) in JS own-key order, each with
 * scr_jb_put_dyn_entry's rules. Without array-index keys that order is the
 * map's insertion order, walked in place: the walk holds the map's
 * iteration count so no compaction moves entries, rereads each entry by
 * position, and stops at the entries present when it started, so a toJSON
 * call that adds or deletes entries sees Node's result (keys taken first,
 * deleted ones read as undefined). With array-index keys the walk takes the
 * ordered key list first. May leave an exception pending. */
void scr_jb_put_dyn_entries(ScrJsonBuf *b, void *rec, ScrMap *map, bool *first) {
  uint32_t count = map->nentries;
  bool indexed = false;
  for (uint32_t i = 0; i < count && !indexed; i++) {
    if (!scr_map_entry_live(map, i)) continue;
    const ScrStr *key = (const ScrStr *)(uintptr_t)scr_map_entry_at(map, i)->key;
    uint32_t index;
    indexed = scr_key_array_index(key->data, key->len, &index);
  }
  if (indexed) {
    ScrArr *keys = scr_map_keys_js_order(map);
    for (size_t i = 0; i < keys->len && !scr_exc_pending(); i++) {
      ScrStr *key = scr_arr_get_ref(keys, (double)i);
      ScrDyn *value = scr_map_get_str_ref(map, key);
      if (value) {
        scr_jb_put_dyn_entry(b, rec, key, value, first);
        scr_dyn_release(value);
      }
      scr_str_release(key);
    }
    scr_arr_release(keys);
    return;
  }
  map->iter_depth++;
  for (uint32_t i = 0; i < count && !scr_exc_pending(); i++) {
    const ScrMapEntry *entry = &map->entries[i];
    if (!entry->hash) continue;
    const ScrStr *key = (const ScrStr *)(uintptr_t)entry->key;
    const ScrDyn *value = (const ScrDyn *)(uintptr_t)entry->val;
    if (scr_jb_try_pure_member(b, key->data, key->len, key, value, first)) continue;
    /* The walk can run program code, which may replace this entry. */
    ScrStr *held_key = scr_str_retain((ScrStr *)key);
    scr_jb_put_member_walk(b, held_key, scr_dyn_retain((ScrDyn *)value), first, rec);
    scr_str_release(held_key);
  }
  map->iter_depth--;
}

/* Writes a dyn value whose toJSON step has run through the protocol walk:
 * undefined, functions and symbols as null (an array slot's rule), and
 * containers with toJSON, accessor and circular-structure handling. May
 * leave an exception pending. */
void scr_jb_put_dyn(ScrJsonBuf *b, const ScrDyn *d) {
  if (scr_json_omitted(d)) scr_jb_puts(b, "null");
  else scr_json_replaced_write(b, d, scr_dyn_undefined(), NULL, &scr_json_compact_gap, b->seen_len);
}

/* Untyped RC adapters (box/promise/exception-cell currency). */
void *scr_dyn_retain_v(void *d) { return scr_dyn_retain((ScrDyn *)d); }
void scr_dyn_release_v(void *d) { scr_dyn_release((ScrDyn *)d); }

/* JS === over two dyn values: scalars by value (NaN false, ±0 equal via
 * C ==; strings bytewise), units by kind, references by node identity or
 * by their retained static record source when one exists. Never throws. */
bool scr_dyn_strict_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a->kind != b->kind) {
    if (a->kind == SCR_DYN_TYPED_REF && b->kind == SCR_DYN_OBJ)
      return b->v.obj.source_identity && a->v.typed_ref.ptr == b->v.obj.source_identity;
    if (a->kind == SCR_DYN_OBJ && b->kind == SCR_DYN_TYPED_REF)
      return a->v.obj.source_identity && a->v.obj.source_identity == b->v.typed_ref.ptr;
    return false;
  }
  switch (a->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL: return true;
  case SCR_DYN_BOOL: return a->v.b == b->v.b;
  case SCR_DYN_BIGINT: return scr_bigint_eq(a->v.bigint, b->v.bigint);
  case SCR_DYN_SYMBOL: return a->v.symbol.value == b->v.symbol.value;
  case SCR_DYN_NUM: return a->v.num == b->v.num;
  case SCR_DYN_STR:
    return a->v.str->len == b->v.str->len &&
           memcmp(a->v.str->data, b->v.str->data, a->v.str->len) == 0;
  case SCR_DYN_OBJ:
    return a == b || scr_dyn_obj_same_source(a, b);
  case SCR_DYN_FUNC:
    /* The ScrDyn box is a boundary artifact — one closure crossing the
     * dyn boundary twice is still ONE JS function value, so identity
     * lives in the boxed closure, not the box. */
    if (a->v.fn.class_obj || b->v.fn.class_obj) return a->v.fn.class_obj == b->v.fn.class_obj;
    return a == b || scr_closure_identity_equal(a->v.fn.clo, b->v.fn.clo);
  case SCR_DYN_BYTES:
    return a->v.bytes == b->v.bytes;
  case SCR_DYN_HANDLE:
    /* Same story: identity is the HANDLE — one req boxed into two
     * listeners is still one JS object. */
    return a->v.handle.tag == b->v.handle.tag && a->v.handle.ptr == b->v.handle.ptr;
  case SCR_DYN_PROMISE:
    /* And the PROMISE: one promise crossing twice is one JS value. */
    return a->v.promise == b->v.promise || (scr_dyn_promise_identity_fn && scr_dyn_promise_identity_fn(a->v.promise, b->v.promise));

  case SCR_DYN_TYPED_REF:
    /* A base-class view and a derived view still name the same object.
     * The compiler's type key governs checked extraction, not identity. */
    return a->v.typed_ref.ptr == b->v.typed_ref.ptr;
  default: return a == b;
  }
}

bool scr_dyn_abstract_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a->kind == b->kind) return scr_dyn_strict_eq(a, b);
  bool an = a->kind == SCR_DYN_NULL || a->kind == SCR_DYN_UNDEF;
  bool bn = b->kind == SCR_DYN_NULL || b->kind == SCR_DYN_UNDEF;
  if (an || bn) return an && bn;
  if (a->kind == SCR_DYN_BOOL || b->kind == SCR_DYN_BOOL) {
    ScrDyn *numeric = scr_dyn_new_num(a->kind == SCR_DYN_BOOL ? (a->v.b ? 1 : 0) : (b->v.b ? 1 : 0));
    bool equal = a->kind == SCR_DYN_BOOL ? scr_dyn_abstract_eq(numeric, b) : scr_dyn_abstract_eq(a, numeric);
    scr_dyn_release(numeric);
    return equal;
  }
  if (scr_dyn_to_primitive_result_is_object(a) || scr_dyn_to_primitive_result_is_object(b)) {
    if (scr_dyn_to_primitive_result_is_object(a) && scr_dyn_to_primitive_result_is_object(b)) return scr_dyn_strict_eq(a, b);
    const ScrDyn *object = scr_dyn_to_primitive_result_is_object(a) ? a : b;
    ScrDyn *primitive = scr_dyn_add_primitive(object);
    bool equal = primitive && (object == a ? scr_dyn_abstract_eq(primitive, b) : scr_dyn_abstract_eq(a, primitive));
    scr_dyn_release(primitive);
    return equal;
  }
  if (a->kind == SCR_DYN_SYMBOL || b->kind == SCR_DYN_SYMBOL) return false;
  if (a->kind == SCR_DYN_BIGINT || b->kind == SCR_DYN_BIGINT) {
    const ScrDyn *integer = a->kind == SCR_DYN_BIGINT ? a : b;
    const ScrDyn *other = integer == a ? b : a;
    return other->kind == SCR_DYN_STR ? scr_bigint_eq_string(integer->v.bigint, other->v.str)
      : other->kind == SCR_DYN_NUM && scr_bigint_cmp_number(integer->v.bigint, other->v.num) == 0;
  }
  double left, right;
  return scr_dyn_number_coerce_js(a, &left) && scr_dyn_number_coerce_js(b, &right) && left == right;
}

static SCR_TL ScrDyn *scr_function_constructors[4];
static SCR_TL bool scr_function_constructors_registered;

static void scr_function_constructors_cleanup(void) {
  for (size_t i = 0; i < 4; i++) {
    scr_dyn_release(scr_function_constructors[i]);
    scr_function_constructors[i] = NULL;
  }
}

static ScrDyn *scr_function_constructor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  static const char message[] = "constructing functions from source text is not supported in static code";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC1050");
  return NULL;
}

static ScrDyn *scr_function_constructor(uint32_t kind) {
  kind &= 3;
  static const char *const names[] = {"Function", "GeneratorFunction", "AsyncFunction", "AsyncGeneratorFunction"};
  if (!scr_function_constructors_registered) {
    scr_atexit(scr_function_constructors_cleanup);
    scr_function_constructors_registered = true;
  }
  if (!scr_function_constructors[kind]) {
    ScrClosure *closure = scr_closure_new(NULL, 0);
    scr_function_constructors[kind] = scr_dyn_new_func(closure, scr_function_constructor_call, 1,
      "native:function-constructor", names[kind]);
  }
  return scr_dyn_retain(scr_function_constructors[kind]);
}

/* Keyed read on a FUNC node (see scr_runtime.h): own props first, then
 * the function-instance built-ins name/length. +1 or NULL. */
ScrDyn *scr_dyn_fn_get(const ScrDyn *d, const char *key, size_t key_len) {
  if (scr_dyn_is_stack_limit(d, key, key_len) && !scr_dyn_stack_limit_shadowed(d))
    return scr_dyn_new_num(scr_stack_limit_get());
  ScrClosure *owner = scr_closure_identity(d->v.fn.clo);
  if (d->v.fn.class_obj && d->v.fn.class_obj->static_data && !owner->props)
    owner->props = scr_box_retain(d->v.fn.class_obj->static_data);
  if (!d->v.fn.class_obj && key_len == 9 && !memcmp(key, "prototype", 9) && !owner->props) {
    if (owner->function_kind & 1) {
      static const char message[] = "Native generator function prototypes have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    ScrDyn *table = scr_dyn_fn_properties(d);
    scr_dyn_release(table);
  }
  if (owner->props) {
    ScrDyn *table = (ScrDyn *)scr_box_get_ref(owner->props); /* +1 */
    ScrDyn *m = table ? scr_dyn_obj_get(table, key, key_len) : NULL;
    ScrDyn *r = m ? scr_dyn_obj_read_receiver(table, key, key_len, d) : NULL;
    bool custom_prototype = table && (table->prototype || table->null_proto);
    if (!m && !scr_exc_pending() && custom_prototype)
      r = table->prototype ? scr_dyn_obj_read_receiver(table->prototype, key, key_len, d)
        : scr_dyn_retain(scr_dyn_undefined());
    scr_dyn_release(table);
    if (m || custom_prototype || scr_exc_pending()) return r;
    /* Deleted own name/length reveal Function.prototype's defaults. */
    if (key_len == 4 && memcmp(key, "name", 4) == 0) {
      ScrStr *empty = scr_str_new("", 0);
      r = scr_dyn_new_str(empty);
      scr_str_release(empty);
      return r;
    }
    if (key_len == 6 && memcmp(key, "length", 6) == 0) return scr_dyn_new_num(0);
  }
  if (!d->v.fn.class_obj && key_len == 11 && memcmp(key, "constructor", 11) == 0)
    return scr_function_constructor(owner->function_kind);
  if (key_len == 4 && memcmp(key, "name", 4) == 0) {
    const char *n = d->v.fn.name ? d->v.fn.name : "";
    ScrStr *s = scr_str_new(n, strlen(n));
    ScrDyn *r = scr_dyn_new_str(s); /* retains */
    scr_str_release(s);
    return r;
  }
  if (key_len == 6 && memcmp(key, "length", 6) == 0) {
    return scr_dyn_new_num((double)d->v.fn.arity);
  }
  if (key_len == 5 && memcmp(key, "apply", 5) == 0) return scr_dyn_function_apply();
  if (d->v.fn.class_obj && !d->v.fn.class_obj->static_data) {
    static const char message[] = "scriptc: class properties through unknown other than name and length are not supported";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  }
  return NULL;
}

/* ── structuredClone over the checked-dynamic tree ─────────────────────────────────────
 * The JSON-safe subset plus bytes, deep. Handle kinds with a clone hook
 * (Blob, File) clone through it; functions and other handle kinds
 * throw the spec's catchable DataCloneError; cycles throw the scriptc
 * fence (the checked-dynamic tree cannot represent them — Node clones cycles; documented
 * divergence). Option validation throws Node's exact TypeErrors and is
 * shared with scr_domex_clone. */

void scr_sc_validate_options(const ScrDyn *options) {
  if (options == NULL || options->kind == SCR_DYN_UNDEF || options->kind == SCR_DYN_NULL) return;
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(options);
    if (view && !scr_exc_pending()) scr_sc_validate_options(view);
    scr_dyn_release(view);
    return;
  }


  if (options->kind != SCR_DYN_OBJ) {
    static const char msg[] =
        "Failed to execute 'structuredClone': Options cannot be converted to a dictionary";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return;
  }
  ScrDyn *tr = scr_dyn_obj_get(options, "transfer", 8); /* borrowed */
  if (tr == NULL || tr->kind == SCR_DYN_UNDEF) return;
  ScrDyn *transferView = tr->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(tr) : NULL;
  if (scr_exc_pending()) { scr_dyn_release(transferView); return; }
  if (transferView) tr = transferView;
  if (tr->kind != SCR_DYN_ARR) {
    static const char msg[] =
        "Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    scr_dyn_release(transferView);
    return;
  }
  if (tr->v.arr.len > 0) {
    /* Nothing in the static world is transferable — Node's own error for
     * a non-transferable list member. A Buffer pool slab's ArrayBuffer is
     * marked untransferable in Node, which reports it differently. */
    const ScrDyn *first = tr->v.arr.items[0];
    if (first && scr_array_buffer_is(first) && ((ScrBytes *)first->v.handle.ptr)->untransferable)
      scr_throw_domex("DataCloneError", "Cannot transfer object of unsupported type.");
    else
      scr_throw_domex("DataCloneError", "Found invalid value in transferList.");
  }
  scr_dyn_release(transferView);
}

/* ── markAsUncloneable ─────────────────────────────────────────────── */

/* The plain objects, errors and class instances marked with
 * markAsUncloneable (node:worker_threads): structuredClone and
 * postMessage throw DataCloneError for them. Node's mark has no effect on
 * primitives, arrays, Maps, Sets, Dates, typed arrays and ArrayBuffers.
 * The marked values are retained until the thread exits, so an identity
 * is never reused while marked. */
static SCR_TL ScrDyn **scr_uncloneable;
SCR_TL size_t scr_uncloneable_count = 0;
static SCR_TL size_t scr_uncloneable_capacity;

static void scr_uncloneable_cleanup(void) {
  for (size_t i = 0; i < scr_uncloneable_count; i++) scr_dyn_release(scr_uncloneable[i]);
  free(scr_uncloneable);
  scr_uncloneable = NULL;
  scr_uncloneable_count = scr_uncloneable_capacity = 0;
}

/* The identity a mark is kept under: a class instance's or a record's
 * object, or a plain object's source (its own box otherwise); NULL for
 * values Node does not mark. */
static const void *scr_uncloneable_identity(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF &&
      ((value->v.typed_ref.type_key_len > 7 && !memcmp(value->v.typed_ref.type_key, "object:", 7)) ||
       (value->v.typed_ref.type_key_len > 7 && !memcmp(value->v.typed_ref.type_key, "record:", 7))))
    return value->v.typed_ref.ptr;
  if (value->kind == SCR_DYN_OBJ)
    return value->v.obj.source_identity ? value->v.obj.source_identity : (const void *)value;
  return NULL;
}

void scr_mark_uncloneable(ScrDyn *value) {
  const void *identity = scr_uncloneable_identity(value);
  if (!identity || scr_uncloneable_marked(value)) return;
  if (scr_uncloneable_count == scr_uncloneable_capacity) {
    if (!scr_uncloneable_capacity) scr_atexit(scr_uncloneable_cleanup);
    size_t capacity = scr_uncloneable_capacity ? scr_uncloneable_capacity * 2 : 8;
    ScrDyn **values = realloc(scr_uncloneable, capacity * sizeof *values);
    if (!values) scr_trap("scriptc: out of memory\n");
    scr_uncloneable = values;
    scr_uncloneable_capacity = capacity;
  }
  scr_uncloneable[scr_uncloneable_count++] = scr_dyn_retain(value);
}

bool scr_uncloneable_marked(const ScrDyn *value) {
  if (scr_uncloneable_count == 0) return false;
  const void *identity = scr_uncloneable_identity(value);
  if (!identity) return false;
  for (size_t i = 0; i < scr_uncloneable_count; i++)
    if (scr_uncloneable_identity(scr_uncloneable[i]) == identity) return true;
  return false;
}

/* The parent chain rides the C stack: a revisit is a cycle. */
typedef struct ScrScParent {
  const ScrDyn *node;
  const struct ScrScParent *up;
} ScrScParent;

/* The clone is a fresh tree (shared inputs are copied per path, cycles
 * throw), so it is tagged like a parse result (ScrDynRegion); a leaf the
 * region may not hold clears it. */
static ScrDyn *scr_sc_clone(const ScrDyn *v, const ScrScParent *up, ScrDynRegion *region) {
  if (scr_uncloneable_count && scr_uncloneable_marked(v)) {
    scr_throw_domex("DataCloneError", "Cannot clone object of unsupported type.");
    return NULL;
  }
  if (v->kind == SCR_DYN_PROXY) {
    scr_throw_domex("DataCloneError", "#<Object> could not be cloned.");
    return NULL;
  }
  switch (v->kind) {
  case SCR_DYN_SYMBOL: {
    ScrStr *text = v->v.symbol.render(v->v.symbol.value);
    static const char tail[] = " could not be cloned.";
    ScrStr *suffix = scr_str_new(tail, sizeof tail - 1);
    ScrStr *message = scr_str_concat(text, suffix);
    scr_throw_domex("DataCloneError", message->data);
    scr_str_release(message);
    scr_str_release(suffix);
    scr_str_release(text);
    return NULL;
  }
  case SCR_DYN_UNDEF:
    return scr_dyn_retain(scr_dyn_undefined());
  case SCR_DYN_NULL:
    return scr_dyn_new_null();
  case SCR_DYN_BOOL:
    return scr_dyn_new_bool(v->v.b);
  case SCR_DYN_BIGINT:
    region->intact = false;
    return scr_dyn_new_bigint(v->v.bigint);
  case SCR_DYN_NUM:
    return scr_dyn_new_num(v->v.num);
  case SCR_DYN_STR:
    return scr_dyn_new_str(v->v.str);
  case SCR_DYN_BYTES: {
    /* A fresh byte copy; the Buffer flavor drops (Node: structuredClone
     * of a Buffer answers a plain Uint8Array). A typed array view over a
     * larger ArrayBuffer, such as a pooled Buffer, clones the whole
     * ArrayBuffer and keeps its offset and length, as Node does. */
    region->intact = false;
    ScrBytes *src = v->v.bytes;
    ScrBytes *copy;
    if (src->backing && !src->is_data_view && !src->shared) {
      ScrBytes *storage = scr_bytes_copy(src->backing);
      copy = scr_bytes_buffer_view(storage, src->elem, scr_bytes_byte_offset(src), true,
                                   (double)src->len);
      scr_bytes_release(storage);
    } else {
      copy = scr_bytes_copy(src);
    }
    ScrDyn *result = scr_dyn_new_bytes(copy);
    scr_bytes_release(copy);
    return result;
  }
  case SCR_DYN_ARR:
  case SCR_DYN_OBJ: {
    for (const ScrScParent *p = up; p != NULL; p = p->up) {
      if (p->node == v) {
        static const char msg[] =
            "structuredClone of cyclic values (the checked-dynamic tree cannot represent cycles) is not supported yet";
        scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
        return NULL;
      }
    }
    ScrScParent self = {v, up};
    if (v->kind == SCR_DYN_ARR) {
      ScrDyn *out = scr_dyn_new_arr();
      for (size_t i = 0; i < v->v.arr.len; i++) {
        if (!scr_dyn_arr_has_index(v, i)) { scr_dyn_arr_push_hole(out); continue; }
        ScrDyn *c = scr_sc_clone(v->v.arr.items[i], &self, region);
        if (c == NULL) { /* threw */
          scr_dyn_release(out);
          return NULL;
        }
        scr_dyn_arr_push(out, c); /* ownership moves */
      }
      scr_dyn_region_join(out, region);
      return out;
    }
    ScrDyn *out = scr_dyn_new_obj();
    for (size_t i = 0; i < v->v.obj.len; i++) {
      const ScrDynEntry *e = &v->v.obj.entries[i];
      if (scr_dyn_entry_is_error_stack(e)) {
        /* A stack that was already formatted copies as a non-enumerable
         * data property; an unformatted one has nothing to copy. */
        ScrError *error = scr_errdyn_err_of(v);
        if (error && error->stack) {
          scr_dyn_obj_set(out, "stack", 5, scr_dyn_new_str(error->stack));
          out->v.obj.entries[out->v.obj.len - 1].enumerable = false;
        }
        scr_error_release(error);
        continue;
      }
      ScrDyn *c = scr_sc_clone(e->value, &self, region);
      if (c == NULL) {
        scr_dyn_release(out);
        return NULL;
      }
      scr_dyn_obj_set(out, e->key, e->key_len, c); /* ownership moves */
    }
    scr_dyn_region_join(out, region);
    return out;
  }

  case SCR_DYN_TYPED_REF: {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(v);
    ScrDyn *out = scr_sc_clone(materialized, up, region);
    scr_dyn_release(materialized);
    return out;
  }
  case SCR_DYN_HANDLE:
    if (scr_dyn_handle_ops_of(v)->clone) {
      region->intact = false; /* a handle is not a leaf the region may hold */
      return scr_dyn_handle_ops_of(v)->clone(v->v.handle.ptr);
    }
    /* fall through */
  case SCR_DYN_FUNC:
  default: {
    /* Node renders the value's source text; the checked-dynamic tree has none — the
     * String() rendering stands in ("function () { [native code] } could
     * not be cloned."). */
    ScrStr *what = scr_dyn_string_coerce(v);
    static const char suffix[] = " could not be cloned.";
    size_t len = what->len + sizeof suffix - 1;
    char *msg = malloc(len + 1);
    if (!msg) {
      scr_trap("scriptc: out of memory\n");
    }
    memcpy(msg, what->data, what->len);
    memcpy(msg + what->len, suffix, sizeof suffix);
    scr_str_release(what);
    ScrStr *m = scr_str_new(msg, len);
    free(msg);
    scr_throw_domex_str("DataCloneError", m); /* takes ownership of m */
    return NULL;
  }
  }
}

ScrDyn *scr_structured_clone(const ScrDyn *value, const ScrDyn *options) {
  scr_sc_validate_options(options);
  if (scr_exc_pending()) return NULL;
  ScrDynRegion *region = scr_dyn_region_new();
  ScrDyn *out = scr_sc_clone(value, NULL, region);
  scr_dyn_region_unref(region); /* the clone's own reference */
  return out;
}

ScrDyn *scr_structured_clone_transfer_fail(void) {
  scr_throw_domex("DataCloneError", "Found invalid value in transferList.");
  return NULL;
}

/* A literal transfer list whose first member is `first`: a Buffer pool
 * slab's ArrayBuffer is untransferable in Node. Borrowed. */
ScrDyn *scr_structured_clone_transfer_fail_with(const ScrDyn *first) {
  if (scr_array_buffer_is(first) && ((ScrBytes *)first->v.handle.ptr)->untransferable) {
    scr_throw_domex("DataCloneError", "Cannot transfer object of unsupported type.");
    return NULL;
  }
  return scr_structured_clone_transfer_fail();
}

ScrDyn *scr_structured_clone_missing(void) {
  /* Node's message, verbatim (its own template double-wraps the text). */
  static const char msg[] =
      "The \"The value argument must be specified\" argument must be specified";
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_MISSING_ARGS");
  return NULL;
}

bool scr_dyn_err_instanceof(const ScrDyn *d, double kind) {
  size_t hit = scr_errdyn_find(d, false);
  if (hit == SIZE_MAX) return false;
  const ScrVt *vt = scr_errdyn_cache[hit].err->vt;
  int k = (int)kind;
  return scr_error_vts[k].pre <= vt->pre && vt->pre <= scr_error_vts[k].post;
}

static ScrDyn *scr_dyn_obj_read_receiver(const ScrDyn *d, const char *key, size_t key_len, const ScrDyn *receiver) {
  for (const ScrDyn *current = d; current; current = scr_dyn_proto_next(current)) {
    if (current == scr_builtin_object_prototype) {
      scr_dyn_class_reflection_fence(current);
      return NULL;
    }
    if (current->kind == SCR_DYN_FUNC) {
      ScrDyn *table = scr_dyn_fn_properties(current);
      ScrDyn *result = scr_dyn_obj_read_receiver(table, key, key_len, receiver);
      scr_dyn_release(table);
      return result;
    }
    if (current->kind == SCR_DYN_ARR) {
      if (key_len == 6 && memcmp(key, "length", 6) == 0) return scr_dyn_new_num((double)current->v.arr.len);
      double index;
      if (scr_dyn_key_is_index(key, key_len, &index) && scr_dyn_arr_has_index(current, (size_t)index))
        return scr_dyn_retain(current->v.arr.items[(size_t)index]);
      if (current->v.arr.properties && scr_dyn_obj_get(current->v.arr.properties, key, key_len))
        return scr_dyn_obj_read_receiver(current->v.arr.properties, key, key_len, receiver);
      continue;
    }
    if (current->kind != SCR_DYN_OBJ) continue;
    ScrDynEntry *entry = scr_dyn_find_entry(current, key, key_len);
    if (entry) {
      if (!entry->accessor) return scr_dyn_retain(entry->value);
      if (!entry->getter) return scr_dyn_retain(scr_dyn_undefined());
      ScrDyn *getter = scr_dyn_retain(entry->getter);
      scr_dyn_this_push_dyn(receiver);
      ScrDyn *result = scr_dyn_visit_call_getter(getter);
      scr_dyn_this_pop();
      scr_dyn_release(getter);
      return result;
    }
  }
  ScrDyn *own = scr_dyn_obj_get(d, key, key_len);
  if (own) return scr_dyn_retain(own);
  if (key_len == 11 && memcmp(key, "constructor", 11) == 0) {
    /* An error's constructor: the interned function value its global
     * reads as (scr_dyn_error_constructor). */
    static const char *const names[] = {
        "Error", "TypeError", "RangeError", "SyntaxError", NULL,
        "ReferenceError", "EvalError", "URIError", "AggregateError",
    };
    size_t hit = scr_errdyn_find(d, false);
    const ScrVt *vt = hit == SIZE_MAX ? NULL : scr_errdyn_cache[hit].err->vt;
    for (size_t kind = 0; vt && kind < sizeof names / sizeof names[0]; kind++) {
      if (!names[kind]) continue;
      if (vt != &scr_error_vts[kind]) continue;
      return scr_dyn_error_constructor(names[kind]);
    }
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static SCR_TL ScrDyn *scr_function_apply_value;

static void scr_function_apply_cleanup(void) {
  scr_dyn_release(scr_function_apply_value);
  scr_function_apply_value = NULL;
}

ScrDyn *scr_dyn_apply_array_like(const ScrDyn *target, const ScrDyn *receiver, const ScrDyn *arguments, const char *what) {
  ScrDyn *list = scr_dyn_new_arr();
  if (arguments && arguments->kind != SCR_DYN_UNDEF && arguments->kind != SCR_DYN_NULL) {
    if (!scr_iterator_object(arguments)) {
      static const char message[] = "CreateListFromArrayLike called on non-object";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    } else {
      ScrDyn *length = scr_iterator_read(arguments, "length", 6);
      double count = 0;
      bool ok = length && scr_dyn_number_coerce_js(length, &count);
      scr_dyn_release(length);
      if (ok && count > 1000000) {
        static const char message[] = "Function.prototype.apply exceeds the native argument limit";
        scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      } else if (ok) for (size_t i = 0; (double)i < floor(count); i++) {
        char key[32];
        int size = snprintf(key, sizeof key, "%zu", i);
        ScrDyn *value = scr_iterator_read(arguments, key, (size_t)size);
        if (!value) break;
        scr_dyn_arr_push(list, value);
      }
    }
  }
  ScrDyn *result = NULL;
  if (!scr_exc_pending()) {
    scr_dyn_this_push_dyn(receiver);
    result = scr_dyn_call(target, list->v.arr.items, list->v.arr.len, what);
    scr_dyn_this_pop();
  }
  scr_dyn_release(list);
  return result;
}

static ScrDyn *scr_function_apply_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *receiver = scr_dyn_this_get();
  if (receiver->kind != SCR_DYN_FUNC) {
    scr_dyn_release(receiver);
    static const char message[] = "Function.prototype.apply was called on a non-callable value";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *result = scr_dyn_apply_array_like(receiver, argc ? args[0] : scr_dyn_undefined(),
    argc > 1 ? args[1] : scr_dyn_undefined(), "Function.prototype.apply");
  scr_dyn_release(receiver);
  return result;
}

ScrDyn *scr_dyn_function_apply(void) {
  if (!scr_function_apply_value) {
    scr_function_apply_value = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_function_apply_call,
      2, "native:Function.prototype.apply", "apply");
    scr_atexit(scr_function_apply_cleanup);
  }
  return scr_dyn_retain(scr_function_apply_value);
}

ScrDyn *scr_dyn_obj_read(const ScrDyn *d, const char *key, size_t key_len) {
  if (d->kind == SCR_DYN_PROXY) {
    ScrStr *name = scr_str_new(key, key_len);
    ScrDyn *value = scr_dyn_visit_proxy_get(d, name);
    scr_str_release(name);
    return value;
  }
  return scr_dyn_obj_read_receiver(d, key, key_len, d);
}

/* Read-site caches (ScrDynReadIc). A hit is exactly the first step of
 * scr_dyn_obj_read_receiver: the receiver's own data property. The builtin
 * Object.prototype answers through its reflection fence instead, so it
 * never hits. Sites hold key references only on threads that filled them,
 * and release them with the thread's other runtime state. The audit lane
 * never fills a site, so its live-key count stays exact. */
static SCR_TL ScrDynReadIc *scr_dyn_read_ics;
static SCR_TL bool scr_dyn_read_ics_registered;

static void scr_dyn_read_ics_reset(void) {
  while (scr_dyn_read_ics) {
    ScrDynReadIc *ic = scr_dyn_read_ics;
    scr_dyn_read_ics = ic->next;
    scr_dyn_key_release(ic->key, ic->key_len);
    *ic = (ScrDynReadIc){0};
  }
  scr_dyn_read_ics_registered = false;
}

static __attribute__((noinline)) ScrDyn *scr_dyn_obj_read_ic_miss(const ScrDyn *d, const ScrStr *key,
                                                                  ScrDynReadIc *ic) {
#ifndef SCR_RC_AUDIT
  ScrDynEntry *entry = d != scr_builtin_object_prototype ? scr_dyn_find_entry(d, key->data, key->len) : NULL;
  if (entry && !entry->accessor) {
    if (ic->key != entry->key) {
      ((ScrDynKey *)(entry->key - offsetof(ScrDynKey, bytes)))->rc++;
      if (ic->key) {
        scr_dyn_key_release(ic->key, ic->key_len);
      } else {
        if (!scr_dyn_read_ics_registered) {
          scr_dyn_read_ics_registered = true;
          scr_atexit(scr_dyn_read_ics_reset);
        }
        ic->next = scr_dyn_read_ics;
        scr_dyn_read_ics = ic;
      }
      ic->key = entry->key;
      ic->key_len = entry->key_len;
    }
    ic->index = (size_t)(entry - d->v.obj.entries);
    return scr_dyn_retain(entry->value);
  }
#else
  (void)ic;
#endif
  return scr_dyn_obj_read_receiver(d, key->data, key->len, d);
}

/* Equal spellings usually share bytes; long keys and share-table collisions
 * do not, and compare their bytes at the remembered position instead. */
ScrDyn *scr_dyn_obj_read_ic(const ScrDyn *d, const ScrStr *key, ScrDynReadIc *ic) {
  size_t index = ic->index;
  if (index < d->v.obj.len) {
    const ScrDynEntry *entry = &d->v.obj.entries[index];
    if ((entry->key == ic->key ||
         (entry->key_len == key->len && scr_key_equal(entry->key, key->data, key->len))) &&
        !entry->accessor && d != scr_builtin_object_prototype)
      return scr_dyn_retain(entry->value);
  }
  return scr_dyn_obj_read_ic_miss(d, key, ic);
}

/* Compiler-owned class property tables use their native instance as the
 * receiver of inherited accessors, retaining field updates on that instance. */
ScrDyn *scr_dyn_bag_get(ScrDyn *bag, ScrStr *key, ScrDyn *receiver) {
  return scr_dyn_obj_read_receiver(bag, key->data, key->len, receiver);
}

void scr_dyn_bag_set(ScrDyn *bag, ScrStr *key, ScrDyn *value, ScrDyn *receiver) {
  scr_dyn_object_key_set(bag, key, value, receiver);
}

/* Reflect uses OrdinaryGet/OrdinarySet with an independently supplied
 * receiver. Failed descriptor writes return false; user callbacks still
 * propagate their exceptions. Keys are converted once before dispatch. */
ScrDyn *scr_dyn_reflect_get(ScrDyn *target, ScrDyn *raw_key, ScrDyn *receiver) {
  if (!scr_dyn_to_primitive_result_is_object(target)) {
    static const char message[] = "Reflect.get called on non-object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *key = scr_dyn_property_key_value(raw_key);
  if (!key) return NULL;
  ScrDyn *result = NULL;
  if (target->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(target);
    if (!scr_exc_pending()) result = scr_dyn_reflect_get(view, key, receiver);
    scr_dyn_release(view);
  } else if (key->kind == SCR_DYN_SYMBOL) {
    ScrDyn *symbols = scr_dyn_symbol_receiver(target);
    ScrDynEntry *entry = symbols ? scr_dyn_symbol_entry(symbols, key, false) : NULL;
    if (entry && entry->accessor && entry->getter) {
      ScrDyn *getter = scr_dyn_retain(entry->getter);
      scr_dyn_this_push_dyn(receiver);
      result = scr_dyn_call(getter, NULL, 0, "getter");
      scr_dyn_this_pop();
      scr_dyn_release(getter);
    } else result = scr_dyn_symbol_key_get(target, key, false);
    scr_dyn_release(symbols);
  } else if (target->kind == SCR_DYN_PROXY) result = scr_dyn_proxy_get_receiver(target, key->v.str, receiver);
  else result = scr_dyn_obj_read_receiver(target, key->v.str->data, key->v.str->len, receiver);
  scr_dyn_release(key);
  return result;
}

bool scr_dyn_reflect_define(ScrDyn *receiver, ScrDyn *raw_key, ScrDyn *value) {
  if (!scr_dyn_to_primitive_result_is_object(receiver)) return false;
  ScrDyn *key = scr_dyn_property_key_value(raw_key);
  if (!key) return false;
  bool ok = false;
  if (receiver->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(receiver);
    if (!scr_exc_pending()) ok = scr_dyn_reflect_define(view, key, value);
    if (ok) scr_dyn_typed_ref_commit(receiver);
    scr_dyn_release(view);
  } else if (receiver->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("Reflect.set receiver definition");
  } else if (receiver->kind == SCR_DYN_FUNC) {
    ScrDyn *table = scr_dyn_fn_properties(receiver);
    ok = scr_dyn_reflect_define(table, key, value);
    scr_dyn_release(table);
  } else {
    scr_dyn_region_store(receiver, value);
    ScrDyn *symbols = key->kind == SCR_DYN_SYMBOL ? scr_dyn_symbol_receiver(receiver) : NULL;
    ScrDynEntry *entry = key->kind == SCR_DYN_SYMBOL ? (symbols ? scr_dyn_symbol_entry(symbols, key, true) : NULL)
      : receiver->kind == SCR_DYN_OBJ ? scr_dyn_entry(receiver, key->v.str)
      : receiver->kind == SCR_DYN_ARR && receiver->v.arr.properties ? scr_dyn_entry(receiver->v.arr.properties, key->v.str) : NULL;
    if (!(entry && (entry->accessor || !entry->writable)) && !(receiver->non_extensible && !scr_dyn_has_own_computed(receiver, key))) {
      if (entry) {
        ScrDyn *old = entry->value;
        entry->value = scr_dyn_retain(value);
        scr_dyn_release(old);
        ok = true;
      } else if (key->kind == SCR_DYN_SYMBOL && symbols) {
        ScrDyn *descriptor = scr_dyn_new_obj();
        scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
        scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
        scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
        scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
        ScrDyn *defined = scr_dyn_define_symbol(receiver, key, descriptor);
        scr_dyn_release(defined);
        scr_dyn_release(descriptor);
        ok = !scr_exc_pending();
      } else if (receiver->kind == SCR_DYN_OBJ) {
        scr_dyn_obj_set(receiver, key->v.str->data, key->v.str->len, scr_dyn_retain(value));
        ok = true;
      } else if (receiver->kind == SCR_DYN_ARR) {
        if (!receiver->v.arr.frozen) {
          scr_dyn_key_set(receiver, key->v.str, value);
          ok = !scr_exc_pending();
        }
      }
    }
    scr_dyn_release(symbols);
  }
  scr_dyn_release(key);
  return ok && !scr_exc_pending();
}

bool scr_dyn_reflect_set(ScrDyn *target, ScrDyn *raw_key, ScrDyn *value, ScrDyn *receiver) {
  if (!scr_dyn_to_primitive_result_is_object(target)) {
    static const char message[] = "Reflect.set called on non-object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  ScrDyn *key = scr_dyn_property_key_value(raw_key);
  if (!key) return false;
  bool ok = false;
  if (target->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(target);
    if (!scr_exc_pending()) ok = scr_dyn_reflect_set(view, key, value, receiver);
    scr_dyn_release(view);
  } else if (target->kind == SCR_DYN_PROXY) {
    ScrDyn *trap = scr_dyn_proxy_trap(target, "set");
    if (!scr_exc_pending() && !trap) ok = scr_dyn_reflect_set(target->v.proxy.target, key, value, receiver);
    else if (trap) {
      ScrDyn *args[] = {target->v.proxy.target, key, value, receiver};
      ScrDyn *result = scr_dyn_proxy_call(target, trap, args, 4);
      ok = result && scr_dyn_truthy(result);
      scr_dyn_release(result);
      ScrDynEntry *entry = key->kind == SCR_DYN_STR ? scr_dyn_entry(target->v.proxy.target, key->v.str) : NULL;
      if (ok && entry && !entry->configurable && ((entry->accessor && !entry->setter) || (!entry->accessor && !entry->writable && !scr_dyn_property_same_value(entry->value, value)))) scr_dyn_proxy_invariant();
    }
  } else if (target->kind == SCR_DYN_FUNC) {
    ScrDyn *table = scr_dyn_fn_properties(target);
    ok = scr_dyn_reflect_set(table, key, value, receiver);
    scr_dyn_release(table);
  } else {
    ScrDyn *symbols = key->kind == SCR_DYN_SYMBOL ? scr_dyn_symbol_receiver(target) : NULL;
    ScrDynEntry *entry = symbols ? scr_dyn_symbol_entry(symbols, key, false) : NULL;
    if (key->kind == SCR_DYN_STR) for (const ScrDyn *current = target; current; current = scr_dyn_proto_next(current)) {
      if (current->kind == SCR_DYN_OBJ) entry = scr_dyn_entry((ScrDyn *)current, key->v.str);
      else if (current->kind == SCR_DYN_ARR && current->v.arr.properties) entry = scr_dyn_entry(current->v.arr.properties, key->v.str);
      if (entry) break;
    }
    if (entry && entry->accessor) {
      if (entry->setter) {
        ScrDyn *setter = scr_dyn_retain(entry->setter);
        scr_dyn_this_push_dyn(receiver);
        ScrDyn *result = scr_dyn_call(setter, &value, 1, "setter");
        scr_dyn_this_pop();
        scr_dyn_release(result);
        scr_dyn_release(setter);
        ok = !scr_exc_pending();
      }
    } else if (!entry || entry->writable) ok = scr_dyn_reflect_define(receiver, key, value);
    scr_dyn_release(symbols);
  }
  scr_dyn_release(key);
  return ok && !scr_exc_pending();
}

/* ── Object.keys/values/entries over the checked-dynamic tree ──────────────────────────
 * JS own-key order: array-index keys ascending first, then the rest in
 * insertion order. entries answers [key, value] pairs; values RETAIN
 * the member nodes (reference semantics, like JS). Strings/arrays/bytes
 * answer their index keys; other scalars an empty array; null/undefined
 * throw Node's catchable TypeError. */

/* The array-index test (ECMA: a canonical numeric string < 2^32-1). */
static bool scr_dyn_key_is_index(const char *key, size_t len, double *out) {
  uint32_t index;
  if (!scr_key_array_index(key, len, &index)) return false;
  *out = index;
  return true;
}

typedef enum { SCR_OBJWALK_KEYS, SCR_OBJWALK_VALUES, SCR_OBJWALK_ENTRIES } ScrObjWalk;

/* A fresh key string boxed into the checked-dynamic tree: scr_dyn_new_str RETAINS its
 * argument, so the local +1 drops right after. */
static ScrDyn *scr_dyn_objwalk_key(const char *key, size_t key_len) {
  ScrStr *k = scr_str_new(key, key_len);
  ScrDyn *d = scr_dyn_new_str(k);
  scr_str_release(k);
  return d;
}

/* A plain object's entry positions in JS own-key order: integer-like keys
 * ascending, then the rest in insertion order. NULL when that order is
 * insertion order (no integer-like key); the caller frees the array. */
static size_t *scr_dyn_obj_key_order(const ScrDyn *v) {
  size_t n = v->v.obj.len;
  ScrKeyIndex *indices = NULL;
  size_t count = 0;
  for (size_t i = 0; i < n; i++) {
    const ScrDynEntry *entry = &v->v.obj.entries[i];
    uint32_t index;
    if (!scr_key_array_index(entry->key, entry->key_len, &index)) continue;
    if (!indices) {
      if (n > SIZE_MAX / sizeof *indices) scr_json_oom();
      indices = malloc(n * sizeof *indices);
      if (!indices) scr_json_oom();
    }
    indices[count++] = (ScrKeyIndex){index, i};
  }
  if (!count) return NULL;
  scr_key_index_sort(indices, count);
  size_t *order = malloc(n * sizeof *order);
  if (!order) scr_json_oom();
  for (size_t i = 0; i < count; i++) order[i] = indices[i].entry;
  free(indices);
  for (size_t i = 0; i < n; i++) {
    const ScrDynEntry *entry = &v->v.obj.entries[i];
    uint32_t index;
    if (!scr_key_array_index(entry->key, entry->key_len, &index)) order[count++] = i;
  }
  return order;
}

/* Whether every own property of a plain object is a data property, so a
 * walk over its values runs no user code and the object cannot change
 * under it. */
static bool scr_dyn_obj_data_only(const ScrDyn *v) {
  for (size_t i = 0; i < v->v.obj.len; i++)
    if (v->v.obj.entries[i].accessor) return false;
  return true;
}

ScrDyn *scr_dyn_obj_own_keys(const ScrDyn *v) {
  size_t *order = scr_dyn_obj_key_order(v);
  ScrDyn *keys = scr_dyn_new_arr();
  scr_dyn_arr_reserve(keys, v->v.obj.len);
  for (size_t i = 0; i < v->v.obj.len; i++) {
    const ScrDynEntry *entry = &v->v.obj.entries[order ? order[i] : i];
    scr_dyn_arr_push(keys, scr_dyn_objwalk_key(entry->key, entry->key_len));
  }
  free(order);
  return keys;
}

ScrDyn *scr_dyn_get_own_property_names(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    if (scr_exc_pending()) { scr_dyn_release(view); return NULL; }
    ScrDyn *result = scr_dyn_get_own_property_names(view);
    scr_dyn_release(view);
    return result;
  }
  if (value->kind == SCR_DYN_FUNC) {
    if (scr_dyn_class_reflection_fence(value)) return NULL;
    ScrDyn *table = scr_dyn_fn_properties(value);
    ScrDyn *out = scr_dyn_get_own_property_names(table);
    scr_dyn_release(table);
    return out;
  }
  if (value->kind == SCR_DYN_OBJ) {
    ScrDyn *keys = scr_dyn_obj_own_keys(value);
    if (!scr_dyn_obj_get(value, "%error", 6)) return keys;
    /* The checked-dynamic tree's error marker is not a property. */
    ScrDyn *names = scr_dyn_new_arr();
    scr_dyn_arr_reserve(names, keys->v.arr.len);
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      const ScrStr *key = keys->v.arr.items[i]->v.str;
      if (key->len == 6 && memcmp(key->data, "%error", 6) == 0) continue;
      scr_dyn_arr_push(names, scr_dyn_retain(keys->v.arr.items[i]));
    }
    scr_dyn_release(keys);
    return names;
  }
  if (value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_STR || value->kind == SCR_DYN_BYTES) {
    ScrDyn *keys = scr_dyn_new_arr();
    size_t length = value->kind == SCR_DYN_ARR ? value->v.arr.len :
                    value->kind == SCR_DYN_BYTES ? value->v.bytes->len :
                    (size_t)scr_str_utf16_len(value->v.str);
    for (size_t i = 0; i < length; i++) {
      if (value->kind == SCR_DYN_ARR && !scr_dyn_arr_has_index(value, i)) continue;
      char name[24];
      int size = snprintf(name, sizeof name, "%zu", i);
      scr_dyn_arr_push(keys, scr_dyn_objwalk_key(name, (size_t)size));
    }
    if (value->kind != SCR_DYN_BYTES)
      scr_dyn_arr_push(keys, scr_dyn_objwalk_key("length", 6));
    if (value->kind == SCR_DYN_ARR && value->v.arr.properties) {
      ScrDyn *properties = scr_dyn_obj_own_keys(value->v.arr.properties);
      for (size_t i = 0; i < properties->v.arr.len; i++)
        scr_dyn_arr_push(keys, scr_dyn_retain(properties->v.arr.items[i]));
      scr_dyn_release(properties);
    }
    return keys;
  }
  if (value->kind == SCR_DYN_BOOL || value->kind == SCR_DYN_NUM || value->kind == SCR_DYN_BIGINT || value->kind == SCR_DYN_SYMBOL)
    return scr_dyn_new_arr();
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) {
    static const char message[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  static const char message[] = "Object.getOwnPropertyNames on this value is not supported yet";
  scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
  return NULL;
}

ScrDyn *scr_dyn_get_own_property_symbols(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    if (scr_exc_pending()) { scr_dyn_release(view); return NULL; }
    ScrDyn *result = scr_dyn_get_own_property_symbols(view);
    scr_dyn_release(view);
    return result;
  }
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) {
    static const char message[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *receiver = scr_dyn_symbol_receiver(value);
  if (scr_exc_pending()) return NULL;
  ScrDyn *out = scr_dyn_new_arr();
  if (receiver && receiver->symbol_keys) for (size_t i = 0; i < receiver->symbol_keys->v.arr.len; i++)
    scr_dyn_arr_push(out, scr_dyn_retain(receiver->symbol_keys->v.arr.items[i]));
  scr_dyn_release(receiver);
  return out;
}

ScrDyn *scr_dyn_get_own_property_descriptors(ScrDyn *object) {
  if (object->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    if (scr_exc_pending()) { scr_dyn_release(view); return NULL; }
    ScrDyn *result = scr_dyn_get_own_property_descriptors(view);
    scr_dyn_release(view);
    return result;
  }
  if (scr_dyn_class_reflection_fence(object)) return NULL;
  if (object->kind == SCR_DYN_UNDEF || object->kind == SCR_DYN_NULL) {
    static const char message[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  if (object->kind == SCR_DYN_PROXY || object->kind == SCR_DYN_HANDLE) {
    static const char message[] = "Object.getOwnPropertyDescriptors on this value is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *names = scr_dyn_get_own_property_names(object);
  if (!names) return NULL;
  ScrDyn *result = scr_dyn_new_obj();
  for (size_t i = 0; i < names->v.arr.len; i++) {
    ScrStr *name = names->v.arr.items[i]->v.str;
    ScrDyn *descriptor = scr_dyn_own_descriptor(object, name);
    if (!descriptor) { scr_dyn_release(names); scr_dyn_release(result); return NULL; }
    if (descriptor->kind != SCR_DYN_UNDEF)
      scr_dyn_obj_set(result, name->data, name->len, descriptor);
    else scr_dyn_release(descriptor);
  }
  scr_dyn_release(names);
  ScrDyn *symbols = scr_dyn_get_own_property_symbols(object);
  if (!symbols) { scr_dyn_release(result); return NULL; }
  for (size_t i = 0; i < symbols->v.arr.len; i++) {
    ScrDyn *key = symbols->v.arr.items[i];
    ScrDyn *descriptor = scr_dyn_get_own_property_descriptor(object, key);
    if (!descriptor) { scr_dyn_release(symbols); scr_dyn_release(result); return NULL; }
    if (descriptor->kind != SCR_DYN_UNDEF) scr_dyn_symbol_key_set(result, key, descriptor);
    scr_dyn_release(descriptor);
  }
  scr_dyn_release(symbols);
  return result;
}

ScrDyn *scr_dyn_own_keys(const ScrDyn *value) {
  if (!scr_dyn_to_primitive_result_is_object(value)) {
    static const char message[] = "Reflect.ownKeys called on non-object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *names = scr_dyn_get_own_property_names(value);
  if (!names) return NULL;
  ScrDyn *symbols = scr_dyn_get_own_property_symbols(value);
  if (!symbols) { scr_dyn_release(names); return NULL; }
  for (size_t i = 0; i < symbols->v.arr.len; i++) scr_dyn_arr_push(names, scr_dyn_retain(symbols->v.arr.items[i]));
  scr_dyn_release(symbols);
  return names;
}

static void scr_dyn_objwalk_push(ScrDyn *out, ScrObjWalk mode, const char *key,
                                 size_t key_len, ScrDyn *value /* borrowed */) {
  switch (mode) {
  case SCR_OBJWALK_KEYS:
    scr_dyn_arr_push(out, scr_dyn_objwalk_key(key, key_len));
    break;
  case SCR_OBJWALK_VALUES:
    scr_dyn_arr_push(out, scr_dyn_retain(value));
    break;
  case SCR_OBJWALK_ENTRIES: {
    ScrDyn *pair = scr_dyn_new_arr();
    scr_dyn_arr_push(pair, scr_dyn_objwalk_key(key, key_len));
    scr_dyn_arr_push(pair, scr_dyn_retain(value));
    scr_dyn_arr_push(out, pair);
    break;
  }
  }
}

static bool scr_dyn_objwalk_entry(ScrDyn *out, const ScrDyn *object,
                                  ScrObjWalk mode, const ScrStr *key, const ScrDyn *receiver) {
  if (!scr_dyn_obj_enumerable(object, key->data, key->len)) return true;
  ScrDyn *value = NULL;
  if (mode != SCR_OBJWALK_KEYS) {
    value = scr_dyn_obj_read_receiver(object, key->data, key->len, receiver);
    if (!value) return false;
  }
  scr_dyn_objwalk_push(out, mode, key->data, key->len, value);
  scr_dyn_release(value);
  return true;
}

/* A plain object's walk read straight from its entries: keys need no
 * reads, and data properties are read without a lookup per key. */
static ScrDyn *scr_dyn_obj_data_walk(const ScrDyn *v, ScrObjWalk mode) {
  size_t *order = scr_dyn_obj_key_order(v);
  ScrDyn *out = scr_dyn_new_arr();
  scr_dyn_arr_reserve(out, v->v.obj.len);
  for (size_t i = 0; i < v->v.obj.len; i++) {
    const ScrDynEntry *entry = &v->v.obj.entries[order ? order[i] : i];
    if (entry->enumerable)
      scr_dyn_objwalk_push(out, mode, entry->key, entry->key_len, entry->value);
  }
  free(order);
  return out;
}

static ScrDyn *scr_dyn_objwalk(const ScrDyn *v, ScrObjWalk mode) {
  if (scr_dyn_class_reflection_fence(v)) return NULL;
#ifdef SCR_NODE_ISLANDS
  /* Object.keys/values/entries of an island object: its own enumerable
   * string keys, read in Node. */
  if (scr_ni_is_handle(v)) {
    ScrDyn *keys = scr_ni_own_keys((ScrDyn *)v, 0);
    if (keys == NULL || mode == SCR_OBJWALK_KEYS) return keys;
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      ScrDyn *key = keys->v.arr.items[i];
      ScrDyn *value = scr_ni_get((ScrDyn *)v, key);
      if (value == NULL) {
        scr_dyn_release(out);
        scr_dyn_release(keys);
        return NULL;
      }
      if (mode == SCR_OBJWALK_VALUES) {
        scr_dyn_arr_push(out, value);
      } else {
        ScrDyn *pair = scr_dyn_new_arr();
        scr_dyn_arr_push(pair, scr_dyn_retain(key));
        scr_dyn_arr_push(pair, value);
        scr_dyn_arr_push(out, pair);
      }
    }
    scr_dyn_release(keys);
    return out;
  }
#endif
  if (v->kind == SCR_DYN_PROXY) {
    ScrDyn *trap = scr_dyn_proxy_trap(v, "ownKeys");
    if (scr_exc_pending()) return NULL;
    ScrDyn *raw;
    if (trap) {
      ScrDyn *args[] = { v->v.proxy.target };
      raw = scr_dyn_proxy_call(v, trap, args, 1);
    } else if (v->v.proxy.target->kind != SCR_DYN_OBJ) {
      /* Native record and function targets list their own property names. */
      raw = scr_dyn_get_own_property_names(v->v.proxy.target);
    } else {
      /* [[OwnPropertyKeys]] includes non-enumerable properties too. Use
       * the shared numeric/insertion ordering over a names-only table. */
      ScrDyn *names = scr_dyn_new_obj();
      for (size_t i = 0; i < v->v.proxy.target->v.obj.len; i++) {
        const ScrDynEntry *entry = &v->v.proxy.target->v.obj.entries[i];
        scr_dyn_obj_set(names, entry->key, entry->key_len, scr_dyn_retain(scr_dyn_undefined()));
      }
      raw = scr_dyn_obj_keys(names);
      scr_dyn_release(names);
    }
    if (!raw) return NULL;
    if (raw->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(raw)) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(raw);
      scr_dyn_release(raw);
      raw = view;
      if (scr_exc_pending()) { scr_dyn_release(raw); return NULL; }
    }
    if (raw->kind != SCR_DYN_ARR) {
      if (scr_dyn_to_primitive_result_is_object(raw)) scr_dyn_proxy_unsupported("array-like ownKeys results");
      else {
        static const char msg[] = "CreateListFromArrayLike called on non-object";
        scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      }
      scr_dyn_release(raw);
      return NULL;
    }
    /* Snapshot and validate the key list before invoking any descriptor
     * or get trap. Those callbacks may mutate the array returned above. */
    ScrDyn *keys = scr_dyn_new_arr();
    for (size_t i = 0; i < raw->v.arr.len; i++) {
      ScrDyn *key = raw->v.arr.items[i];
      const char *error = key->kind != SCR_DYN_STR ? "Proxy ownKeys result contains a non-string key" : NULL;
      for (size_t j = 0; !error && j < keys->v.arr.len; j++) {
        if (scr_str_eq(key->v.str, keys->v.arr.items[j]->v.str)) error = "'ownKeys' on proxy: trap returned duplicate entries";
      }
      if (error) {
        scr_throw_error_msg(SCR_ERR_TYPE, error, strlen(error));
        scr_dyn_release(keys);
        scr_dyn_release(raw);
        return NULL;
      }
      scr_dyn_arr_push(keys, scr_dyn_retain(key));
    }
    scr_dyn_release(raw);
    const ScrDyn *target = v->v.proxy.target;
    for (size_t i = 0; target->kind == SCR_DYN_OBJ && i < target->v.obj.len; i++) {
      const ScrDynEntry *entry = &target->v.obj.entries[i];
      if (entry->configurable) continue;
      bool found = false;
      for (size_t j = 0; j < keys->v.arr.len; j++) {
        const ScrStr *key = keys->v.arr.items[j]->v.str;
        if (key->len == entry->key_len && memcmp(key->data, entry->key, key->len) == 0) { found = true; break; }
      }
      if (!found) { scr_dyn_release(keys); scr_dyn_proxy_invariant(); return NULL; }
    }
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      ScrStr *key = keys->v.arr.items[i]->v.str;
      ScrDyn *desc = scr_dyn_own_descriptor(v, key);
      if (!desc) { scr_dyn_release(keys); scr_dyn_release(out); return NULL; }
      ScrDyn *enumerable = desc->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(desc, "enumerable", 10) : NULL;
      bool include = enumerable && scr_dyn_truthy(enumerable);
      scr_dyn_release(desc);
      if (!include) continue;
      ScrDyn *value = mode == SCR_OBJWALK_KEYS ? scr_dyn_retain(scr_dyn_undefined()) : scr_dyn_proxy_get(v, key);
      if (!value) { scr_dyn_release(keys); scr_dyn_release(out); return NULL; }
      scr_dyn_objwalk_push(out, mode, key->data, key->len, value);
      scr_dyn_release(value);
    }
    scr_dyn_release(keys);
    return out;
  }
  if (v->kind == SCR_DYN_TYPED_REF) {
    const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
    if (record) return scr_typed_ref_record_walk(v, record, (int)mode);
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(v);
    ScrDyn *out = scr_dyn_objwalk(materialized, mode);
    scr_dyn_release(materialized);
    return out;
  }
  if (v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }

  if (v->kind == SCR_DYN_OBJ && (mode == SCR_OBJWALK_KEYS || scr_dyn_obj_data_only(v)))
    return scr_dyn_obj_data_walk(v, mode);
  ScrDyn *out = scr_dyn_new_arr();
  if (v->kind == SCR_DYN_OBJ || v->kind == SCR_DYN_FUNC) {
    ScrDyn *table = v->kind == SCR_DYN_FUNC ? scr_dyn_fn_properties(v) : scr_dyn_retain((ScrDyn *)v);
    ScrDyn *keys = scr_dyn_obj_own_keys(table);
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      if (!scr_dyn_objwalk_entry(out, table, mode, keys->v.arr.items[i]->v.str, v)) {
        scr_dyn_release(keys);
        scr_dyn_release(table);
        scr_dyn_release(out);
        return NULL;
      }
    }
    scr_dyn_release(keys);
    scr_dyn_release(table);
    return out;
  }
  if (v->kind == SCR_DYN_ARR || v->kind == SCR_DYN_BYTES) {
    size_t n = v->kind == SCR_DYN_ARR ? v->v.arr.len : v->v.bytes->len;
    for (size_t i = 0; i < n; i++) {
      if (v->kind == SCR_DYN_ARR && !scr_dyn_arr_has_index(v, i)) continue;
      char key[24];
      int klen = snprintf(key, sizeof key, "%zu", i);
      ScrDyn *val = NULL;
      if (mode != SCR_OBJWALK_KEYS) {
        val = v->kind == SCR_DYN_ARR ? scr_dyn_retain(v->v.arr.items[i])
                                     : scr_dyn_new_num(scr_bytes_get(v->v.bytes, (double)i));
      }
      if (mode == SCR_OBJWALK_KEYS) {
        scr_dyn_arr_push(out, scr_dyn_objwalk_key(key, (size_t)klen));
      } else if (mode == SCR_OBJWALK_VALUES) {
        scr_dyn_arr_push(out, val);
      } else {
        ScrDyn *pair = scr_dyn_new_arr();
        scr_dyn_arr_push(pair, scr_dyn_objwalk_key(key, (size_t)klen));
        scr_dyn_arr_push(pair, val);
        scr_dyn_arr_push(out, pair);
      }
    }
    if (v->kind == SCR_DYN_ARR && v->v.arr.properties) {
      ScrDyn *names = scr_dyn_obj_own_keys(v->v.arr.properties);
      for (size_t i = 0; i < names->v.arr.len; i++) {
        if (!scr_dyn_objwalk_entry(out, v->v.arr.properties, mode, names->v.arr.items[i]->v.str, v)) {
          scr_dyn_release(names);
          scr_dyn_release(out);
          return NULL;
        }
      }
      scr_dyn_release(names);
    }
    return out;
  }
  if (v->kind == SCR_DYN_STR) {
    size_t length = (size_t)scr_str_utf16_len(v->v.str);
    for (size_t unit = 0; unit < length; unit++) {
      char key[24];
      int klen = snprintf(key, sizeof key, "%zu", unit);
      if (mode == SCR_OBJWALK_KEYS) {
        scr_dyn_arr_push(out, scr_dyn_objwalk_key(key, (size_t)klen));
      } else {
        ScrStr *character = scr_str_char_at(v->v.str, (double)unit);
        ScrDyn *val = scr_dyn_new_str(character);
        scr_str_release(character);
        if (mode == SCR_OBJWALK_VALUES) {
          scr_dyn_arr_push(out, val);
        } else {
          ScrDyn *pair = scr_dyn_new_arr();
          scr_dyn_arr_push(pair, scr_dyn_objwalk_key(key, (size_t)klen));
          scr_dyn_arr_push(pair, val);
          scr_dyn_arr_push(out, pair);
        }
      }
    }
    return out;
  }
  /* Scalars (numbers, booleans, functions, handles): no own enumerable
   * string keys. */
  return out;
}

ScrDyn *scr_dyn_obj_keys(const ScrDyn *v) { return scr_dyn_objwalk(v, SCR_OBJWALK_KEYS); }

static ScrDyn *scr_typed_ref_record_walk(const ScrDyn *d, const ScrDynTypedRecordOps *ops,
                                         int mode) {
  ScrDyn *out = scr_dyn_new_arr();
  scr_dyn_arr_reserve(out, ops->count);
  void *rec = d->v.typed_ref.ptr;
  for (size_t i = 0; i < ops->count; i++) {
    if (!ops->fixed && !ops->has(rec, i)) continue;
    ScrStr *name = ops->names[i];
    if (mode == SCR_OBJWALK_KEYS) {
      scr_dyn_arr_push(out, scr_dyn_new_str(name));
      continue;
    }
    ScrDyn *value = ops->get(rec, i);
    if (mode == SCR_OBJWALK_VALUES) {
      scr_dyn_arr_push(out, value);
    } else {
      ScrDyn *pair = scr_dyn_new_arr();
      scr_dyn_arr_push(pair, scr_dyn_new_str(name));
      scr_dyn_arr_push(pair, value);
      scr_dyn_arr_push(out, pair);
    }
  }
  return out;
}

/* Snapshot enumerable names from the receiver and each live prototype.
 * Non-enumerable own names shadow names farther up the chain. */
ScrDyn *scr_dyn_for_in_keys(const ScrDyn *v) {
  if (scr_dyn_class_reflection_fence(v)) return NULL;
  if (v->kind == SCR_DYN_TYPED_REF) {
    /* The snapshot has no prototype: for-in visits its own keys. */
    const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
    if (record) return scr_typed_ref_record_walk(v, record, SCR_OBJWALK_KEYS);
  }
  /* Generator objects own no enumerable properties. */
  if (scr_dyn_generator(v)) return scr_dyn_new_arr();
  if (v->kind == SCR_DYN_TYPED_REF) {
    /* Records, arrays and class instances walk their checked view, whose
     * prototype chain holds anything set through it. */
    ScrDyn *view = scr_dyn_typed_ref_materialize(v);
    ScrDyn *keys = scr_exc_pending() ? NULL : scr_dyn_for_in_keys(view);
    scr_dyn_release(view);
    return keys;
  }
  switch (v->kind) {
  case SCR_DYN_OBJ: {
    ScrDyn *keys = scr_dyn_new_arr();
    ScrDyn *seen = scr_dyn_new_obj_null_proto();
    for (const ScrDyn *current = v; current; current = scr_dyn_proto_next(current)) {
      ScrDyn *own = scr_dyn_obj_own_keys(current);
      for (size_t i = 0; i < own->v.arr.len; i++) {
        ScrDyn *key = own->v.arr.items[i];
        ScrStr *name = key->v.str;
        if (scr_dyn_has_own(seen, name)) continue;
        scr_dyn_obj_set(seen, name->data, name->len, scr_dyn_retain(scr_dyn_undefined()));
        if (scr_dyn_obj_enumerable(current, name->data, name->len))
          scr_dyn_arr_push(keys, scr_dyn_retain(key));
      }
      scr_dyn_release(own);
    }
    scr_dyn_release(seen);
    return keys;
  }
  case SCR_DYN_ARR:
    return scr_dyn_obj_keys(v);
  case SCR_DYN_STR: {
    ScrDyn *keys = scr_dyn_new_arr();
    size_t length = (size_t)scr_str_utf16_len(v->v.str);
    for (size_t i = 0; i < length; i++) {
      char key[24];
      int len = snprintf(key, sizeof key, "%zu", i);
      scr_dyn_arr_push(keys, scr_dyn_objwalk_key(key, (size_t)len));
    }
    return keys;
  }
  case SCR_DYN_NULL:
  case SCR_DYN_UNDEF:
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_BIGINT:
  case SCR_DYN_SYMBOL:
    return scr_dyn_new_arr();
  default: {
    static const char msg[] = "for-in over this checked-dynamic kind is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return NULL;
  }
  }
}

/* Whether for-in's key snapshot of `v` stays exact through the walk, so
 * visits need no live presence test: a typed record whose fields are all
 * required cannot lose a key. */
bool scr_dyn_for_in_stable(const ScrDyn *v) {
  if (v->kind != SCR_DYN_TYPED_REF) return false;
  const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
  return record != NULL && record->fixed;
}

/* The record shape's key array for walks that only read it: built once,
 * immortal, and shared by every thread through the ops' atomic slot. */
static ScrArr *scr_record_shared_keys(const ScrDynTypedRecordOps *record) {
  ScrArr **slot = &((ScrDynTypedRecordOps *)record)->keys;
  ScrArr *keys = __atomic_load_n(slot, __ATOMIC_ACQUIRE);
  if (keys) return keys;
  ScrArr *built = scr_arr_new(SCR_ELEM_STR, record->count);
  for (size_t i = 0; i < record->count; i++)
    scr_arr_push_ref(built, scr_str_retain(record->names[i]));
  built->rc = SIZE_MAX;
  ScrArr *expected = NULL;
  if (__atomic_compare_exchange_n(slot, &expected, built, false, __ATOMIC_ACQ_REL,
                                  __ATOMIC_ACQUIRE)) {
#ifdef SCR_RC_AUDIT
    scr_arr_live_forget(); /* immortal: outside the exit-time RC audit */
#endif
    scr_sa_thread_shares(); /* every thread reads the array */
    return built;
  }
  built->rc = 1;
  scr_arr_release(built);
  return expected;
}

/* A typed record's present field names, or a plain object's enumerable
 * own keys (integer-like keys ascending, then insertion order), as a
 * native string[] (+1); NULL for every other value. `shared`: the caller
 * only reads the array, so a record shape's cached array may serve. */
static ScrArr *scr_dyn_own_key_strs(const ScrDyn *v, bool shared) {
  if (v->kind == SCR_DYN_TYPED_REF) {
    const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
    if (!record) return NULL;
    void *rec = v->v.typed_ref.ptr;
    bool all = true;
    for (size_t i = 0; i < record->count && all; i++) all = record->has(rec, i);
    if (shared && all) return scr_record_shared_keys(record);
    ScrArr *out = scr_arr_new(SCR_ELEM_STR, record->count);
    for (size_t i = 0; i < record->count; i++)
      if (record->has(rec, i)) scr_arr_push_ref(out, scr_str_retain(record->names[i]));
    return out;
  }
  if (v->kind != SCR_DYN_OBJ) return NULL;
  size_t *order = scr_dyn_obj_key_order(v);
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, v->v.obj.len);
  for (size_t i = 0; i < v->v.obj.len; i++) {
    const ScrDynEntry *entry = &v->v.obj.entries[order ? order[i] : i];
    if (entry->enumerable) scr_arr_push_ref(out, scr_str_new(entry->key, entry->key_len));
  }
  free(order);
  return out;
}

/* A dyn string array's strings as a native string[] (+1), releasing it. */
static ScrArr *scr_dyn_key_strs_from(ScrDyn *keys) {
  if (!keys) return NULL;
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, keys->v.arr.len);
  for (size_t i = 0; i < keys->v.arr.len; i++)
    scr_arr_push_ref(out, scr_str_retain(keys->v.arr.items[i]->v.str));
  scr_dyn_release(keys);
  return out;
}

/* for-in's key snapshot as a native string[] (+1): the typed record's
 * field names, or a plain object's enumerable own keys (integer-like keys
 * ascending, then insertion order) when its prototype contributes none.
 * Every other value takes the dyn walk and converts its result. */
ScrArr *scr_dyn_for_in_key_strs(const ScrDyn *v) {
  if (scr_dyn_class_reflection_fence(v)) return NULL;
  /* A plain object's prototype adds keys unless it is Object.prototype. */
  if (v->kind != SCR_DYN_OBJ || v->prototype == NULL ||
      v->prototype == scr_builtin_object_prototype) {
    ScrArr *own = scr_dyn_own_key_strs(v, true);
    if (own) return own;
  }
  return scr_dyn_key_strs_from(scr_dyn_for_in_keys(v));
}

/* Object.keys as a native string[] (+1): a fresh array the caller owns. */
ScrArr *scr_dyn_obj_key_strs(const ScrDyn *v) {
  if (scr_dyn_class_reflection_fence(v)) return NULL;
  ScrArr *own = scr_dyn_own_key_strs(v, false);
  if (own) return own;
  return scr_dyn_key_strs_from(scr_dyn_obj_keys(v));
}

static ScrDynEntryPairs *scr_dyn_entry_pairs_new(size_t cap) {
  if (cap > (SIZE_MAX - sizeof(ScrDynEntryPairs)) / sizeof(ScrDynEntryPair)) scr_json_oom();
  ScrDynEntryPairs *out = malloc(sizeof *out + cap * sizeof out->pairs[0]);
  if (!out) scr_json_oom();
  out->count = 0;
  return out;
}

/* Object.entries' pairs for a native [string, any][] (see the header):
 * a typed record's present fields, a plain data object's enumerable own
 * entries in own-key order, or the dyn walk's pairs for every other
 * value. */
ScrDynEntryPairs *scr_dyn_obj_entry_pairs(const ScrDyn *v) {
  if (scr_dyn_class_reflection_fence(v)) return NULL;
  if (v->kind == SCR_DYN_TYPED_REF) {
    const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
    if (record) {
      void *rec = v->v.typed_ref.ptr;
      ScrDynEntryPairs *out = scr_dyn_entry_pairs_new(record->count);
      for (size_t i = 0; i < record->count; i++) {
        if (!record->fixed && !record->has(rec, i)) continue;
        out->pairs[out->count++] =
          (ScrDynEntryPair){scr_str_retain(record->names[i]), record->get(rec, i)};
      }
      return out;
    }
  } else if (v->kind == SCR_DYN_OBJ && scr_dyn_obj_data_only(v)) {
    size_t *order = scr_dyn_obj_key_order(v);
    ScrDynEntryPairs *out = scr_dyn_entry_pairs_new(v->v.obj.len);
    for (size_t i = 0; i < v->v.obj.len; i++) {
      const ScrDynEntry *entry = &v->v.obj.entries[order ? order[i] : i];
      if (!entry->enumerable) continue;
      out->pairs[out->count++] = (ScrDynEntryPair){scr_str_new(entry->key, entry->key_len),
                                                   scr_dyn_retain(entry->value)};
    }
    free(order);
    return out;
  }
  ScrDyn *entries = scr_dyn_obj_entries(v);
  if (!entries) return NULL;
  ScrDynEntryPairs *out = scr_dyn_entry_pairs_new(entries->v.arr.len);
  for (size_t i = 0; i < entries->v.arr.len; i++) {
    ScrDyn *const *pair = entries->v.arr.items[i]->v.arr.items;
    out->pairs[out->count++] =
      (ScrDynEntryPair){scr_str_retain(pair[0]->v.str), scr_dyn_retain(pair[1])};
  }
  scr_dyn_release(entries);
  return out;
}

void scr_dyn_entry_pairs_free(ScrDynEntryPairs *pairs) { free(pairs); }

static ScrArrOps scr_dyn_value_list_ops = {scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v};

/* A native array of `count` owned dyn values, moved in with one dense push.
 * Frees `values` unless it is `stack`. */
static ScrArr *scr_dyn_value_list_from(uint64_t *values, size_t count, uint64_t *stack) {
  ScrArr *out = scr_arr_new_ops(&scr_dyn_value_list_ops, count);
  scr_arr_push_many(out, count, values);
  if (values != stack) free(values);
  return out;
}

static uint64_t *scr_dyn_value_slots(size_t count, uint64_t *stack, size_t stack_len) {
  if (count <= stack_len) return stack;
  if (count > SIZE_MAX / sizeof(uint64_t)) scr_json_oom();
  uint64_t *slots = malloc(count * sizeof *slots);
  if (!slots) scr_json_oom();
  return slots;
}

/* Object.values as a native vector of checked values (see the header): a
 * typed record's present fields, a plain data object's enumerable own
 * values in own-key order, or the dyn walk's values for every other value. */
ScrArr *scr_dyn_obj_value_list(const ScrDyn *v) {
  if (scr_dyn_class_reflection_fence(v)) return NULL;
  uint64_t stack[16];
  if (v->kind == SCR_DYN_TYPED_REF) {
    const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
    if (record) {
      void *rec = v->v.typed_ref.ptr;
      uint64_t *slots = scr_dyn_value_slots(record->count, stack, 16);
      size_t count = 0;
      for (size_t i = 0; i < record->count; i++)
        if (record->fixed || record->has(rec, i))
          slots[count++] = (uint64_t)(uintptr_t)record->get(rec, i);
      return scr_dyn_value_list_from(slots, count, stack);
    }
  } else if (v->kind == SCR_DYN_OBJ && scr_dyn_obj_data_only(v)) {
    size_t *order = scr_dyn_obj_key_order(v);
    uint64_t *slots = scr_dyn_value_slots(v->v.obj.len, stack, 16);
    size_t count = 0;
    for (size_t i = 0; i < v->v.obj.len; i++) {
      const ScrDynEntry *entry = &v->v.obj.entries[order ? order[i] : i];
      if (entry->enumerable) slots[count++] = (uint64_t)(uintptr_t)scr_dyn_retain(entry->value);
    }
    free(order);
    return scr_dyn_value_list_from(slots, count, stack);
  }
  ScrDyn *values = scr_dyn_obj_values(v);
  if (!values) return NULL;
  size_t count = values->v.arr.len;
  uint64_t *slots = scr_dyn_value_slots(count, stack, 16);
  for (size_t i = 0; i < count; i++)
    slots[i] = (uint64_t)(uintptr_t)scr_dyn_retain(values->v.arr.items[i]);
  scr_dyn_release(values);
  return scr_dyn_value_list_from(slots, count, stack);
}

/* One source's own enumerable members onto an OBJ target. OBJ sources
 * snapshot their keys, then check attributes and read values in order so
 * getters can affect later entries. Arrays, strings, and bytes use their
 * index-keyed entries walk. Nullish and scalar sources copy nothing;
 * non-OBJ targets have no property table. */
static void scr_dyn_copy_property(ScrDyn *target, ScrStr *key, ScrDyn *value, bool define) {
  if (!define) { scr_dyn_key_set(target, key, value); return; }
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *name = scr_dyn_new_str(key);
  ScrDyn *result = scr_dyn_define_property(target, name, descriptor);
  scr_dyn_release(result);
  scr_dyn_release(name);
  scr_dyn_release(descriptor);
}

static void scr_dyn_assign_strings_from(ScrDyn *target, const ScrDyn *src, bool define) {
  if (target->kind == SCR_DYN_PROXY || src->kind == SCR_DYN_PROXY) {
    scr_dyn_proxy_unsupported("Object.assign");
    return;
  }
  if (target->kind != SCR_DYN_OBJ && target->kind != SCR_DYN_FUNC) return;
  if (src->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(src);
    if (materialized) scr_dyn_assign_strings_from(target, materialized, define);
    scr_dyn_release(materialized);
    return;
  }
  if (src->kind == SCR_DYN_UNDEF || src->kind == SCR_DYN_NULL) return;
  if (src->kind == SCR_DYN_OBJ) {
    ScrDyn *keys = scr_dyn_obj_own_keys(src);
    if (!keys) return;
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      ScrStr *key = keys->v.arr.items[i]->v.str;
      if (!scr_dyn_obj_enumerable(src, key->data, key->len)) continue;
      ScrDyn *value = scr_dyn_obj_read(src, key->data, key->len);
      if (!value) break;
      scr_dyn_copy_property(target, key, value, define);
      scr_dyn_release(value);
      if (scr_exc_pending()) break;
    }
    scr_dyn_release(keys);
    return;
  }
  if (src->kind != SCR_DYN_ARR && src->kind != SCR_DYN_STR &&
      src->kind != SCR_DYN_BYTES) {
    return;
  }
  ScrDyn *pairs = scr_dyn_obj_entries(src); /* +1; never throws here */
  if (pairs == NULL) return;
  if (pairs->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < pairs->v.arr.len; i++) {
      const ScrDyn *pair = pairs->v.arr.items[i];
      if (pair->kind != SCR_DYN_ARR || pair->v.arr.len != 2) continue;
      const ScrDyn *k = pair->v.arr.items[0];
      if (k->kind != SCR_DYN_STR) continue;
      scr_dyn_copy_property(target, k->v.str, pair->v.arr.items[1], define);
      if (scr_exc_pending()) break;
    }
  }
  scr_dyn_release(pairs);
}

static void scr_dyn_assign_from(ScrDyn *target, const ScrDyn *src, bool define) {
  const ScrDynTypedRecordOps *record =
      src->kind == SCR_DYN_TYPED_REF ? scr_typed_ref_record_ops(src) : NULL;
  if (record) {
    /* The record view has only enumerable string-keyed data fields. */
    void *rec = src->v.typed_ref.ptr;
    for (size_t i = 0; i < record->count && !scr_exc_pending(); i++) {
      if (!record->has(rec, i)) continue;
      ScrDyn *value = record->get(rec, i);
      scr_dyn_copy_property(target, record->names[i], value, define);
      scr_dyn_release(value);
    }
    return;
  }
  if (src->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(src);
    if (view) scr_dyn_assign_from(target, view, define);
    scr_dyn_release(view);
    return;
  }
  ScrDyn *view = src->kind == SCR_DYN_FUNC ? scr_dyn_fn_properties(src) : scr_dyn_retain((ScrDyn *)src);
  ScrDyn *symbols = scr_dyn_new_arr();
  if (view->symbol_keys) for (size_t i = 0; i < view->symbol_keys->v.arr.len; i++)
    scr_dyn_arr_push(symbols, scr_dyn_retain(view->symbol_keys->v.arr.items[i]));
  scr_dyn_assign_strings_from(target, view, define);
  for (size_t i = 0; i < symbols->v.arr.len && !scr_exc_pending(); i++) {
    ScrDyn *key = symbols->v.arr.items[i];
    ScrDynEntry *entry = scr_dyn_symbol_entry(view, key, true);
    if (!entry || !entry->enumerable) continue;
    ScrDyn *value = scr_dyn_symbol_key_get(src, key, false);
    if (!value) break;
    if (define) {
      ScrDyn *descriptor = scr_dyn_new_obj();
      scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
      scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
      scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
      scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
      ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
      scr_dyn_release(defined);
      scr_dyn_release(descriptor);
    } else scr_dyn_symbol_key_set(target, key, value);
    scr_dyn_release(value);
  }
  scr_dyn_release(symbols);
  scr_dyn_release(view);
}

/* Object.assign over dyn values: copies `src`'s own members onto `target`
 * (last write wins) and answers the target retained (+1). Nullish
 * receivers throw Node's ToObject TypeError; nullish sources copy
 * nothing; index-keyed sources (arrays/strings/bytes) copy their index
 * keys like Node; the remaining kinds have no own enumerable keys. */
ScrDyn *scr_dyn_assign(ScrDyn *target, const ScrDyn *src) {
  if (scr_dyn_class_reflection_fence(target) || scr_dyn_error_prototype_fence(target) || scr_dyn_class_reflection_fence(src)) return NULL;
  if (target->kind == SCR_DYN_UNDEF || target->kind == SCR_DYN_NULL) {
    const char *m = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, m, strlen(m));
    return NULL;
  }

  if (target->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(target);
    ScrDyn *assigned = scr_dyn_assign(materialized, src);
    if (!scr_exc_pending()) {
      scr_dyn_typed_ref_commit(target);
      /* An Error subclass's inherited slots take the copied values. */
      static const char *const slots[] = { "name", "message", "stack", "cause", "code" };
      for (size_t i = 0; i < sizeof slots / sizeof slots[0]; i++) {
        ScrStr *key = scr_str_new(slots[i], strlen(slots[i]));
        if (materialized->kind == SCR_DYN_OBJ && scr_dyn_entry(materialized, key) != NULL)
          scr_error_sync_slots(target, materialized, key);
        scr_str_release(key);
      }
    }
    scr_dyn_release(assigned);
    scr_dyn_release(materialized);
    return scr_exc_pending() ? NULL : scr_dyn_retain(target);
  }

  scr_dyn_assign_from(target, src, false);
  return scr_exc_pending() ? NULL : scr_dyn_retain(target);
}

/* Object literal spread creates data properties, bypassing existing
 * setters and replacing configurable accessors on the fresh literal. */
ScrDyn *scr_dyn_copy_data_properties(ScrDyn *target, const ScrDyn *src) {
  if (target->kind != SCR_DYN_OBJ) return NULL; /* compiler-owned literal */
  scr_dyn_assign_from(target, src, true);
  return scr_exc_pending() ? NULL : scr_dyn_retain(target);
}

ScrDyn *scr_dyn_object_rest(const ScrDyn *source, const ScrDyn *excluded) {
  ScrDyn *out = scr_dyn_new_obj();
  const ScrDynTypedRecordOps *record =
      source->kind == SCR_DYN_TYPED_REF ? scr_typed_ref_record_ops(source) : NULL;
  if (record) {
    void *rec = source->v.typed_ref.ptr;
    for (size_t i = 0; i < record->count; i++) {
      if (!record->has(rec, i)) continue;
      ScrStr *name = record->names[i];
      bool skip = false;
      for (size_t j = 0; j < excluded->v.arr.len && !skip; j++) {
        const ScrDyn *key = excluded->v.arr.items[j];
        skip = key->kind == SCR_DYN_STR && key->v.str->len == name->len &&
               memcmp(key->v.str->data, name->data, name->len) == 0;
      }
      if (!skip) scr_dyn_obj_set(out, name->data, name->len, record->get(rec, i));
    }
    return out;
  }
  ScrDyn *names = scr_dyn_get_own_property_names(source);
  if (!names) { scr_dyn_release(out); return NULL; }
  ScrDyn *symbols = scr_dyn_get_own_property_symbols(source);
  if (!symbols) { scr_dyn_release(names); scr_dyn_release(out); return NULL; }
  for (size_t i = 0; i < symbols->v.arr.len; i++) scr_dyn_arr_push(names, scr_dyn_retain(symbols->v.arr.items[i]));
  scr_dyn_release(symbols);
  for (size_t i = 0; i < names->v.arr.len && !scr_exc_pending(); i++) {
    ScrDyn *key = names->v.arr.items[i];
    bool skip = false;
    for (size_t j = 0; j < excluded->v.arr.len; j++) {
      if (scr_dyn_strict_eq(key, excluded->v.arr.items[j])) { skip = true; break; }
    }
    if (skip || !scr_dyn_key_probe_computed(source, key, 2)) continue;
    ScrDyn *value = key->kind == SCR_DYN_SYMBOL ? scr_dyn_symbol_key_get(source, key, false) : scr_iterator_read(source, key->v.str->data, key->v.str->len);
    if (!scr_exc_pending()) {
      if (key->kind == SCR_DYN_SYMBOL) scr_dyn_symbol_key_set(out, key, value);
      else scr_dyn_obj_set(out, key->v.str->data, key->v.str->len, scr_dyn_retain(value));
    }
    scr_dyn_release(value);
  }
  scr_dyn_release(names);
  if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
  return out;
}

/* Compiler-owned native class views retain every property and its flags,
 * including nonenumerable data, without invoking accessors. */
static void scr_dyn_copy_property_descriptor(ScrDyn *target, const ScrDyn *src,
                                             const ScrDynEntry *from) {
  /* Exactly scr_dyn_define_property(target, key, own descriptor of key)
   * when `target` has no such property and accepts new ones: the entry
   * takes the source's attributes, value or accessor pair. */
  ScrDynEntry *prior = scr_dyn_find_entry(target, from->key, from->key_len);
  if (prior || target->non_extensible) {
    ScrStr *name = scr_str_new(from->key, from->key_len);
    ScrDyn *key = scr_dyn_new_str(name);
    ScrDyn *descriptor = scr_dyn_own_descriptor(src, name);
    ScrDyn *result = descriptor ? scr_dyn_define_property(target, key, descriptor) : NULL;
    scr_dyn_release(descriptor);
    scr_dyn_release(result);
    scr_dyn_release(key);
    scr_str_release(name);
    return;
  }
  /* The names whose definition may move into a native Error's slots
   * (scr_error_sync_slots). */
  static const char *const slots[] = {"cause", "stack", "name", "message", "code"};
  bool slot = false;
  for (size_t i = 0; i < sizeof slots / sizeof *slots && !slot; i++)
    slot = from->key_len == strlen(slots[i]) && memcmp(from->key, slots[i], from->key_len) == 0;
  bool accessor = from->accessor, writable = !accessor && from->writable;
  bool enumerable = from->enumerable, configurable = from->configurable;
  ScrDyn *value = scr_dyn_retain(accessor ? scr_dyn_undefined() : from->value);
  ScrDyn *getter = accessor && from->getter ? scr_dyn_retain(from->getter) : NULL;
  ScrDyn *setter = accessor && from->setter ? scr_dyn_retain(from->setter) : NULL;
  ScrStr *name = slot ? scr_str_new(from->key, from->key_len) : NULL;
  scr_dyn_obj_set(target, from->key, from->key_len, value);
  ScrDynEntry *entry = &target->v.obj.entries[target->v.obj.len - 1];
  entry->accessor = accessor;
  entry->getter = getter;
  entry->setter = setter;
  entry->writable = writable;
  entry->enumerable = enumerable;
  entry->configurable = configurable;
  if (name) {
    scr_error_sync_cause(target, name);
    scr_str_release(name);
  }
}

ScrDyn *scr_dyn_copy_property_descriptors(ScrDyn *target, const ScrDyn *src) {
  if (!src || src->kind == SCR_DYN_UNDEF) return scr_dyn_retain(target);
  if (src->kind == SCR_DYN_OBJ && target->kind == SCR_DYN_OBJ && src != target &&
      src != scr_builtin_object_prototype && target != scr_builtin_error_prototype) {
    /* Plain objects on both sides: no fence, proxy trap or accessor runs,
     * so each property is copied from its entry without building the key
     * and descriptor objects the general path goes through. */
    if (src->v.obj.len) scr_dyn_region_store(target, NULL);
    size_t *order = scr_dyn_obj_key_order(src);
    for (size_t i = 0; i < src->v.obj.len && !scr_exc_pending(); i++)
      scr_dyn_copy_property_descriptor(target, src, &src->v.obj.entries[order ? order[i] : i]);
    free(order);
  } else {
    ScrDyn *keys = scr_dyn_obj_own_keys(src);
    if (!keys) return NULL;
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      ScrDyn *key = keys->v.arr.items[i];
      ScrDyn *descriptor = scr_dyn_own_descriptor(src, key->v.str);
      ScrDyn *result = descriptor ? scr_dyn_define_property(target, key, descriptor) : NULL;
      scr_dyn_release(descriptor);
      scr_dyn_release(result);
      if (scr_exc_pending()) break;
    }
    scr_dyn_release(keys);
  }
  if (!scr_exc_pending()) {
    ScrDyn *symbols = scr_dyn_get_own_property_symbols(src);
    if (!symbols) return NULL;
    for (size_t i = 0; i < symbols->v.arr.len; i++) {
      ScrDyn *key = symbols->v.arr.items[i];
      ScrDyn *descriptor = scr_dyn_get_own_property_descriptor((ScrDyn *)src, key);
      ScrDyn *result = descriptor ? scr_dyn_define_property(target, key, descriptor) : NULL;
      scr_dyn_release(descriptor);
      scr_dyn_release(result);
      if (scr_exc_pending()) break;
    }
    scr_dyn_release(symbols);
  }
  return scr_exc_pending() ? NULL : scr_dyn_retain(target);
}

/* Variadic Object.assign's argument pack (the `Object.assign({},
 * ...arr.map(f), tail)` shape): the compiler builds one fresh dyn array
 * of sources — plain arguments push borrowed (+1 in), spread arguments
 * flatten through the spread-call walk (scr_dyn_arr_push_spread's V8
 * TypeError texts, `what` spelling the spread expression for the nullish
 * form) — so every source evaluates and flattens BEFORE any copying,
 * exactly JS's ArgumentListEvaluation. */
void scr_dyn_pack_push(ScrDyn *pack, ScrDyn *v) {
  scr_dyn_arr_push(pack, scr_dyn_retain(v));
}

void scr_dyn_pack_push_spread(ScrDyn *pack, const ScrDyn *src, const ScrStr *what) {
  scr_dyn_arr_push_spread(pack, src, what->data);
}

/* The ITERATED-path spread completion: V8 only takes the optimized
 * apply-path texts (scr_dyn_arr_push_spread's — the expression spelled
 * for nullish sources) when the spread is the SINGLE LAST argument; a spread
 * followed by more arguments, or one of several spreads, drives the real
 * iterator protocol, whose failure text describes the VALUE instead —
 * "undefined", "object null", "number 5", "boolean true", "function",
 * bare "object" — + " is not iterable (cannot read property
 * Symbol(Symbol.iterator))". The compiler picks the variant by the
 * spread's syntactic position. MAY THROW (pending). Borrows src. */
void scr_dyn_pack_push_spread_iter(ScrDyn *pack, const ScrDyn *src) {
  if (src->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(src);
    if (!scr_exc_pending()) scr_dyn_pack_push_spread_iter(pack, view);
    scr_dyn_release(view);
    return;
  }
  if (src->kind == SCR_DYN_HANDLE && scr_dyn_handle_ops_of(src)->iter_pack) {
    ScrDyn *items = scr_dyn_handle_ops_of(src)->iter_pack(src->v.handle.ptr);
    if (!items) return;
    scr_dyn_pack_push_spread_iter(pack, items);
    scr_dyn_release(items);
    return;
  }
  if (src->kind == SCR_DYN_ARR || src->kind == SCR_DYN_BYTES ||
      src->kind == SCR_DYN_STR) {
    scr_dyn_arr_push_spread(pack, src, ""); /* iterable kinds never throw */
    return;
  }

  ScrJsonBuf b;
  scr_jb_init(&b);
  switch (src->kind) {
  case SCR_DYN_UNDEF: scr_jb_puts(&b, "undefined"); break;
  case SCR_DYN_NULL: scr_jb_puts(&b, "object null"); break;
  case SCR_DYN_NUM: {
    scr_jb_puts(&b, "number ");
    ScrStr *s = scr_f64_to_scrstr(src->v.num);
    scr_jb_write(&b, s->data, s->len);
    scr_str_release(s);
    break;
  }
  case SCR_DYN_BOOL: scr_jb_puts(&b, src->v.b ? "boolean true" : "boolean false"); break;
  case SCR_DYN_FUNC: scr_jb_puts(&b, "function"); break;
  default: scr_jb_puts(&b, "object"); break; /* OBJ/HANDLE/PROMISE */
  }
  scr_jb_puts(&b, " is not iterable (cannot read property Symbol(Symbol.iterator))");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

/* Object.assign(target, ...sources) over the flattened pack: the nullish
 * ToObject TypeError first (Node throws before looking at sources), then
 * each source's own-member copy left to right, answering the target
 * retained (+1) — identity, like JS. */
ScrDyn *scr_dyn_reflect_apply(ScrDyn *target, ScrDyn *receiver, ScrDyn *arguments_list) {
  return scr_dyn_apply_array_like(target, receiver, arguments_list, "Reflect.apply");
}

ScrDyn *scr_dyn_assign_all(ScrDyn *target, const ScrDyn *sources) {
  if (target->kind == SCR_DYN_UNDEF || target->kind == SCR_DYN_NULL) {
    const char *m = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, m, strlen(m));
    return NULL;
  }
  if (sources->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < sources->v.arr.len; i++) {
      ScrDyn *r = scr_dyn_assign(target, sources->v.arr.items[i]);
      if (!r) return NULL;
      scr_dyn_release(r);
    }
  }
  return scr_dyn_retain(target);
}

/* A data-only class prototype view cannot replace native compiled methods.
 * Check each key after Get, preserving getter order and partial assignments. */
ScrDyn *scr_dyn_assign_prototype(ScrDyn *target, ScrDyn *sources, ScrDyn *protected_keys) {
  for (size_t i = 0; i < sources->v.arr.len; i++) {
    ScrDyn *source = sources->v.arr.items[i];
    if (source->kind == SCR_DYN_UNDEF || source->kind == SCR_DYN_NULL) continue;
    ScrDyn *keys = scr_dyn_get_own_property_names(source);
    if (!keys) return NULL;
    ScrDyn *symbols = scr_dyn_get_own_property_symbols(source);
    if (!symbols) { scr_dyn_release(keys); return NULL; }
    for (size_t j = 0; j < symbols->v.arr.len; j++) scr_dyn_arr_push(keys, scr_dyn_retain(symbols->v.arr.items[j]));
    scr_dyn_release(symbols);
    for (size_t j = 0; j < keys->v.arr.len && !scr_exc_pending(); j++) {
      ScrDyn *key = keys->v.arr.items[j];
      if (!scr_dyn_property_is_enumerable_computed(source, key)) continue;
      ScrDyn *descriptor = scr_dyn_get_own_property_descriptor(source, key);
      if (!descriptor) break;
      ScrDyn *data = scr_dyn_obj_get(descriptor, "value", 5);
      ScrDyn *getter = scr_dyn_obj_get(descriptor, "get", 3);
      ScrDyn *value;
      if (getter && getter->kind != SCR_DYN_UNDEF) {
        scr_dyn_this_push_dyn(source);
        value = scr_dyn_call(getter, NULL, 0, "get");
        scr_dyn_this_pop();
      } else value = scr_dyn_retain(data ? data : scr_dyn_undefined());
      scr_dyn_release(descriptor);
      if (!value) break;
      bool protected = false;
      for (size_t k = 0; k < protected_keys->v.arr.len; k++) {
        if (scr_dyn_strict_eq(key, protected_keys->v.arr.items[k])) { protected = true; break; }
      }
      if (protected) {
        static const char message[] = "Replacing compiled class prototype members has no native lowering [SC1090]";
        scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
      } else scr_dyn_key_set_computed(target, key, value);
      scr_dyn_release(value);
    }
    scr_dyn_release(keys);
    if (scr_exc_pending()) return NULL;
  }
  return scr_dyn_retain(target);
}

static bool scr_dyn_canonical_own_index(const ScrStr *key, size_t length) {
  if (key->len == 0 || (key->len > 1 && key->data[0] == '0')) return false;
  size_t index = 0;
  for (size_t i = 0; i < key->len; i++) {
    if (key->data[i] < '0' || key->data[i] > '9') return false;
    size_t digit = (size_t)(key->data[i] - '0');
    if (index > (SIZE_MAX - digit) / 10) return false;
    index = index * 10 + digit;
    if (index >= length) return false;
  }
  return true;
}

bool scr_dyn_has_own(const ScrDyn *v, const ScrStr *key) {
  if (v->kind == SCR_DYN_TYPED_REF) {
    /* Own canonical indexes never consult the prototype: a hole is absent. */
    size_t index;
    const ScrDynTypedRecordOps *record = scr_typed_ref_record_ops(v);
    if (record) {
      size_t field;
      return scr_typed_ref_record_field(record, key, &field) && record->has(v->v.typed_ref.ptr, field);
    }
    if (scr_dyn_typed_ref_array_ops(v) &&
        (scr_typed_ref_is_length(key) || scr_typed_ref_canonical_index(key->data, key->len, &index)))
      return scr_typed_ref_array_has_own(v, key);
    ScrDyn *view = scr_dyn_typed_ref_materialize(v);
    if (!view) return false;
    bool result = scr_dyn_has_own(view, key);
    scr_dyn_release(view);
    return result;
  }
  if (v->kind == SCR_DYN_PROXY) {
    ScrDyn *desc = scr_dyn_own_descriptor(v, key);
    bool has = desc && desc->kind != SCR_DYN_UNDEF;
    scr_dyn_release(desc);
    return has;
  }
  if (v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) {
    const char *m = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, m, strlen(m));
    return false;
  }


  if (v->kind == SCR_DYN_OBJ) {
    return scr_dyn_obj_get(v, key->data, key->len) != NULL;
  }
  if (v->kind == SCR_DYN_ARR) {
    if (key->len == 6 && memcmp(key->data, "length", 6) == 0) return true;
    if (v->v.arr.properties && scr_dyn_obj_get(v->v.arr.properties, key->data, key->len)) return true;
    if (!scr_dyn_canonical_own_index(key, v->v.arr.len)) return false;
    size_t index = 0;
    for (size_t i = 0; i < key->len; i++) index = index * 10 + (size_t)(key->data[i] - '0');
    return scr_dyn_arr_has_index(v, index);
  }
  if (v->kind == SCR_DYN_STR) {
    if (key->len == 6 && memcmp(key->data, "length", 6) == 0) return true;
    return scr_dyn_canonical_own_index(key, (size_t)scr_str_utf16_len(v->v.str));
  }
  if (v->kind == SCR_DYN_BYTES) {
    return scr_dyn_canonical_own_index(key, v->v.bytes->len);
  }
  if (v->kind == SCR_DYN_FUNC) {
    ScrDyn *desc = scr_dyn_own_descriptor(v, key);
    bool has = desc && desc->kind != SCR_DYN_UNDEF;
    scr_dyn_release(desc);
    return has;
  }
  if (v->kind == SCR_DYN_HANDLE) {
    const char *m = "Own-property checks on this checked-dynamic kind are not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, m, strlen(m));
    return false;
  }
  return false;
}

bool scr_dyn_property_is_enumerable(const ScrDyn *value, const ScrStr *key) {
  if (scr_dyn_class_reflection_fence(value)) return false;
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    bool result = !scr_exc_pending() && scr_dyn_property_is_enumerable(view, key);
    scr_dyn_release(view);
    return result;
  }
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    static const char message[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  if (value->kind == SCR_DYN_OBJ)
    return scr_dyn_obj_enumerable(value, key->data, key->len);
  if (value->kind == SCR_DYN_STR)
    return scr_dyn_canonical_own_index(key, (size_t)scr_str_utf16_len(value->v.str));
  if (value->kind == SCR_DYN_ARR)
    return (scr_dyn_canonical_own_index(key, value->v.arr.len) && scr_dyn_has_own(value, key)) ||
      (value->v.arr.properties && scr_dyn_obj_enumerable(value->v.arr.properties, key->data, key->len));
  if (value->kind == SCR_DYN_BYTES)
    return scr_dyn_canonical_own_index(key, value->v.bytes->len);
  return false;
}
ScrDyn *scr_dyn_obj_values(const ScrDyn *v) { return scr_dyn_objwalk(v, SCR_OBJWALK_VALUES); }
ScrDyn *scr_dyn_obj_entries(const ScrDyn *v) { return scr_dyn_objwalk(v, SCR_OBJWALK_ENTRIES); }

/* ── Error and DOMException checked-dynamic constructors ──────────────
 * Construction/cause/clone live HERE (not scr_error.c) so the error unit
 * stays linkable without the checked-dynamic tree (the runtime C-unit tests link
 * subsets). The cause teardown installs through scr_error.c's hook
 * before any cause can exist. */

/* Error's cause uses the same split as DOMException: plain runtime
 * throws stay independent of the checked-dynamic implementation. A NULL
 * slot means no own property; a stored dyn undefined is a present cause.
 * Compiled subclasses release the matching hidden dyn field themselves. */
static void scr_error_cause_drop_impl(void *obj) {
  ScrError *e = (ScrError *)obj;
  scr_dyn_release(e->error_cause);
  e->error_cause = NULL;
}

void scr_error_init_options(void *obj, int kind, const ScrDyn *message, const ScrDyn *options) {
  ScrStr *text = message == NULL || message->kind == SCR_DYN_UNDEF
      ? scr_str_new("", 0) : scr_dyn_string_coerce_js(message);
  if (scr_exc_pending()) {
    scr_str_release(text);
    return;
  }
  scr_error_init(obj, kind, text);
  ((ScrError *)obj)->message_present = message && message->kind != SCR_DYN_UNDEF;
  scr_str_release(text);
  ScrDyn *view = options && options->kind == SCR_DYN_TYPED_REF
      ? scr_dyn_typed_ref_materialize(options) : NULL;
  if (view) options = view;
  if (options && options->kind == SCR_DYN_OBJ) {
    ScrDyn *cause = scr_dyn_obj_get(options, "cause", 5);
    if (cause) {
      scr_error_install_cause_drop(&scr_error_cause_drop_impl);
      ((ScrError *)obj)->error_cause = scr_dyn_retain(cause);
    }
  }
  scr_dyn_release(view);
}

ScrError *scr_error_new_options(int kind, const ScrDyn *message, const ScrDyn *options) {
  ScrError *e = scr_error_new(kind, NULL);
  /* scr_error_init_options initializes the prefix of an empty subclass;
   * discard the allocating constructor's defaults before using it here. */
  scr_str_release(e->name);
  scr_str_release(e->message);
  scr_str_release(e->stack_frames);
  e->name = e->message = e->stack_frames = NULL;
  scr_error_init_options(e, kind, message, options);
  if (scr_exc_pending()) {
    scr_error_release(e);
    return NULL;
  }
  return e;
}

/* SuppressedError's `error` and `suppressed`: non-enumerable own
 * properties of the error's dyn view. Both values move in. */
static void scr_suppressed_attach(ScrError *e, ScrDyn *error, ScrDyn *suppressed) {
  ScrDyn *view = scr_dyn_from_error(e);
  scr_dyn_obj_set(view, "error", 5, error);
  view->v.obj.entries[view->v.obj.len - 1].enumerable = false;
  scr_dyn_obj_set(view, "suppressed", 10, suppressed);
  view->v.obj.entries[view->v.obj.len - 1].enumerable = false;
  scr_dyn_release(view);
}

ScrError *scr_suppressed_new(const ScrDyn *error, const ScrDyn *suppressed, const ScrDyn *message) {
  ScrError *e = scr_error_new_options(SCR_ERR_SUPPRESSED, message, NULL);
  if (!e) return NULL;
  scr_suppressed_attach(e, scr_dyn_retain((ScrDyn *)error), scr_dyn_retain((ScrDyn *)suppressed));
  return e;
}

ScrDyn *scr_error_cause(ScrError *e) {
  size_t hit = scr_errdyn_find(e, true);
  if (hit != SIZE_MAX) {
    ScrDyn *value = scr_errdyn_cache[hit].dyn;
    if (value->kind == SCR_DYN_TYPED_REF) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(value);
      ScrDyn *cause = scr_dyn_obj_read(view, "cause", 5);
      scr_dyn_release(view);
      return cause;
    }
    return scr_dyn_obj_read(value, "cause", 5);
  }
  return e->error_cause ? scr_dyn_retain(e->error_cause) : scr_dyn_undefined();
}

void scr_error_set_cause(ScrError *e, ScrDyn *value) {
  size_t hit = scr_errdyn_find(e, true);
  if (hit != SIZE_MAX) {
    ScrStr *key = scr_str_new("cause", 5);
    scr_dyn_key_set(scr_errdyn_cache[hit].dyn, key, value);
    scr_str_release(key);
    return;
  }
  scr_error_install_cause_drop(&scr_error_cause_drop_impl);
  ScrDyn *replacement = scr_dyn_retain(value);
  if (!e->error_cause) e->cause_enumerable = true;
  scr_dyn_release(e->error_cause);
  e->error_cause = replacement;
}

void scr_error_define_cause(ScrError *e, ScrDyn *value) {
  scr_error_delete_cause(e);
  scr_error_set_cause(e, value);
}

void scr_error_delete_cause(ScrError *e) {
  size_t hit = scr_errdyn_find(e, true);
  if (hit != SIZE_MAX) {
    ScrStr *key = scr_str_new("cause", 5);
    scr_dyn_key_delete(scr_errdyn_cache[hit].dyn, key, true);
    scr_str_release(key);
    return;
  }
  scr_dyn_release(e->error_cause);
  e->error_cause = NULL;
  e->cause_enumerable = false;
}

static void scr_aggregate_errors_drop_impl(void *obj) {
  ScrAggregateError *a = (ScrAggregateError *)obj;
  scr_dyn_release(a->errors);
  a->errors = NULL;
}

ScrError *scr_aggregate_new(const ScrDyn *message, const ScrDyn *options) {
  ScrError *e = scr_aggregate_alloc();
  scr_error_init_options(e, SCR_ERR_AGGREGATE, message, options);
  if (scr_exc_pending()) {
    scr_error_release(e);
    return NULL;
  }
  return e;
}

void scr_aggregate_set_errors(ScrError *e, ScrDyn *errors) {
  ScrAggregateError *a = (ScrAggregateError *)e;
  scr_aggregate_install_errors_drop(&scr_aggregate_errors_drop_impl);
  ScrDyn *replacement = scr_dyn_retain(errors);
  scr_dyn_release(a->errors);
  a->errors = replacement;
}

/* An AggregateError minted by a runtime throw path carries no list until
 * the first read, which makes the empty one its identity. */
ScrDyn *scr_aggregate_errors(ScrError *e) {
  ScrAggregateError *a = (ScrAggregateError *)e;
  if (a->errors == NULL) {
    ScrDyn *empty = scr_dyn_new_arr();
    scr_aggregate_set_errors(e, empty);
    scr_dyn_release(empty);
  }
  return scr_dyn_retain(a->errors);
}

static void scr_domex_cause_drop_impl(void *obj) {
  ScrDomException *d = (ScrDomException *)obj;
  scr_dyn_release(d->cause);
  d->cause = NULL;
}

ScrError *scr_domex_new(const ScrDyn *message, const ScrDyn *name_or_options) {
  scr_domex_install_cause_drop(&scr_domex_cause_drop_impl);
  ScrDomException *d = (ScrDomException *)scr_domex_alloc();
  d->message = (message == NULL || message->kind == SCR_DYN_UNDEF)
                   ? scr_str_new("", 0)
                   : scr_dyn_string_coerce(message);
  const ScrDyn *no = name_or_options;
  if (no == NULL || no->kind == SCR_DYN_UNDEF) {
    d->name = scr_str_new("Error", 5);
  } else if (no->kind == SCR_DYN_OBJ) {
    /* The options form (Node's extension): name is ToString of the `name`
     * member — String(undefined) is "undefined" when absent, exactly
     * Node — and `cause` records own-property PRESENCE (undefined-valued
     * members count, like `'cause' in options`). */
    ScrDyn *nm = scr_dyn_obj_get(no, "name", 4);
    d->name = nm ? scr_dyn_string_coerce(nm) : scr_str_new("undefined", 9);
    ScrDyn *cause = scr_dyn_obj_get(no, "cause", 5); /* borrowed; NULL = absent */
    if (cause) {
      d->has_cause = true;
      d->cause = scr_dyn_retain(cause);
    }
  } else {
    /* Everything else ToStrings (Node: new DOMException('m', null) has
     * name "null", a number names its decimal rendering). */
    d->name = scr_dyn_string_coerce(no);
  }
  d->dom_code = scr_domex_code_of(d->name);
  return (ScrError *)d;
}

ScrDyn *scr_domex_cause(ScrError *e) {
  ScrDomException *d = (ScrDomException *)e;
  return d->cause ? scr_dyn_retain(d->cause) : scr_dyn_undefined();
}

ScrError *scr_domex_clone(ScrError *e, const ScrDyn *options) {
  scr_sc_validate_options(options);
  if (scr_exc_pending()) return NULL;
  ScrDomException *src = (ScrDomException *)e;
  ScrDomException *d = (ScrDomException *)scr_domex_alloc();
  d->name = scr_str_retain(src->name);
  d->message = scr_str_retain(src->message);
  /* The legacy code re-derives from the name (spec: serialization carries
   * name + message; cause does not serialize). */
  d->dom_code = scr_domex_code_of(d->name);
  return (ScrError *)d;
}

/* ── atob/btoa — the WHATWG base64 globals (Node globals since v16) ───
 * They live HERE (not scr_string.c) because the argument is a dyn value:
 * WebIDL ToString runs over the dyn kind (Node's atob(null) decodes the
 * string "null"), and the string unit must stay linkable without the
 * dyn. atob is forgiving-base64 exactly — ASCII whitespace stripped, a
 * %4==0 input sheds up to two trailing '=', %4==1 refuses, leftover
 * bits discard — decoding to the latin1 code points as a UTF-8 string;
 * btoa refuses any code point over U+00FF. Malformed input throws the
 * catchable DOMException InvalidCharacterError with Node's exact
 * message. */

static int scr_b64_val(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

ScrStr *scr_atob(const ScrDyn *data) {
  ScrStr *s = scr_dyn_string_coerce(data);
  /* Strip ASCII whitespace (the forgiving step). */
  char *buf = malloc(s->len ? s->len : 1);
  if (!buf) scr_json_oom();
  size_t n = 0;
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (c == 0x09 || c == 0x0a || c == 0x0c || c == 0x0d || c == 0x20) continue;
    buf[n++] = (char)c;
  }
  scr_str_release(s);
  /* A %4==0 input sheds one or two trailing '='. */
  if (n % 4 == 0 && n > 0) {
    if (buf[n - 1] == '=') n--;
    if (n > 0 && buf[n - 1] == '=') n--;
  }
  if (n % 4 == 1) goto invalid;
  /* Decode 6-bit groups; latin1 code points expand to UTF-8 (bytes over
   * 0x7F become two-byte sequences). */
  {
    size_t outBytes = (n / 4) * 3 + (n % 4 == 2 ? 1 : n % 4 == 3 ? 2 : 0);
    char *out = malloc(outBytes * 2 ? outBytes * 2 : 1);
    if (!out) scr_json_oom();
    size_t w = 0;
    unsigned acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
      int v = scr_b64_val((unsigned char)buf[i]);
      if (v < 0) {
        free(out);
        goto invalid;
      }
      acc = (acc << 6) | (unsigned)v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        unsigned char b = (unsigned char)((acc >> bits) & 0xff);
        if (b < 0x80) {
          out[w++] = (char)b;
        } else {
          out[w++] = (char)(0xc0 | (b >> 6));
          out[w++] = (char)(0x80 | (b & 0x3f));
        }
      }
    }
    /* Leftover bits discard (forgiving-base64's final step). */
    free(buf);
    ScrStr *result = scr_str_new(out, w);
    free(out);
    return result;
  }
invalid:
  free(buf);
  scr_throw_domex("InvalidCharacterError",
                  "The string to be decoded is not correctly encoded.");
  return NULL;
}

ScrStr *scr_btoa(const ScrDyn *data) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  ScrStr *s = scr_dyn_string_coerce(data);
  /* UTF-8 → code points, each must fit latin1 (one byte). The runtime's
   * strings are canonical WTF-8, so only C2/C3 leads can stay in range;
   * every other lead byte names a code unit over U+00FF. */
  char *bytes = malloc(s->len ? s->len : 1);
  if (!bytes) scr_json_oom();
  size_t n = 0;
  for (size_t i = 0; i < s->len;) {
    unsigned char c = (unsigned char)s->data[i];
    if (c < 0x80) {
      bytes[n++] = (char)c;
      i += 1;
    } else if ((c == 0xc2 || c == 0xc3) && i + 1 < s->len) {
      unsigned char c1 = (unsigned char)s->data[i + 1];
      bytes[n++] = (char)(((c & 0x1f) << 6) | (c1 & 0x3f));
      i += 2;
    } else {
      free(bytes);
      scr_str_release(s);
      scr_throw_domex("InvalidCharacterError", "Invalid character");
      return NULL;
    }
  }
  scr_str_release(s);
  {
    size_t cap = ((n + 2) / 3) * 4;
    char *out = malloc(cap ? cap : 1);
    if (!out) scr_json_oom();
    size_t w = 0;
    for (size_t i = 0; i < n; i += 3) {
      unsigned b0 = (unsigned char)bytes[i];
      unsigned b1 = i + 1 < n ? (unsigned char)bytes[i + 1] : 0;
      unsigned b2 = i + 2 < n ? (unsigned char)bytes[i + 2] : 0;
      unsigned triple = (b0 << 16) | (b1 << 8) | b2;
      out[w++] = alphabet[(triple >> 18) & 0x3f];
      out[w++] = alphabet[(triple >> 12) & 0x3f];
      out[w++] = i + 1 < n ? alphabet[(triple >> 6) & 0x3f] : '=';
      out[w++] = i + 2 < n ? alphabet[triple & 0x3f] : '=';
    }
    free(bytes);
    ScrStr *result = scr_str_new(out, w);
    free(out);
    return result;
  }
}

ScrStr *scr_b64_missing_arg(void) {
  static const char msg[] = "The \"input\" argument must be specified";
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1,
                           "ERR_MISSING_ARGS");
  return NULL;
}

/* Fixed-length ArrayBuffers use the same retained root allocation as native
 * typed-array views. The handle brand distinguishes storage from a view;
 * repeated .buffer reads box the same root pointer and preserve identity. */
bool scr_array_buffer_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_ARRAY_BUFFER;
}

bool scr_shared_array_buffer_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER;
}

bool scr_buffer_storage_is(const ScrDyn *value) {
  return scr_array_buffer_is(value) || scr_shared_array_buffer_is(value);
}

bool scr_array_buffer_is_view(const ScrDyn *value) {
  return value->kind == SCR_DYN_BYTES;
}

static ScrDyn *scr_array_buffer_get(void *h, const char *key, size_t len) {
  if ((len == 10 && memcmp(key, "byteLength", len) == 0) ||
      (len == 13 && memcmp(key, "maxByteLength", len) == 0))
    return scr_dyn_new_num(scr_bytes_byte_len(h));
  if (len == 8 && !memcmp(key, "growable", len) && ((ScrBytes *)h)->shared) return scr_dyn_new_bool(false);
  if (!((ScrBytes *)h)->shared && ((len == 9 && memcmp(key, "resizable", len) == 0) ||
      (len == 8 && memcmp(key, "detached", len) == 0))) return scr_dyn_new_bool(false);
  if (len == 11 && !memcmp(key, "constructor", len) && !((ScrBytes *)h)->shared)
    return scr_array_buffer_constructor();
  return NULL;
}

static bool scr_array_buffer_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h; (void)key; (void)len; (void)value;
  return false;
}

static ScrDyn *scr_array_buffer_invoke(void *h, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self; (void)what;
  if (strcmp(method, "slice") == 0) {
    double start = 0, end = scr_bytes_byte_len(h);
    if (argc && !scr_dyn_number_coerce_js(args[0], &start)) return NULL;
    if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF && !scr_dyn_number_coerce_js(args[1], &end)) return NULL;
    ScrBytes *view = scr_bytes_buffer_view(h, SCR_BYTES_U8, 0, false, 0);
    if (!view) return NULL;
    ScrBytes *copy = scr_bytes_slice(view, start, end);
    if (((ScrBytes *)h)->shared) scr_bytes_make_shared(copy);
    scr_bytes_release(view);
    ScrDyn *result = scr_array_buffer_from_bytes(copy);
    scr_bytes_release(copy);
    return result;
  }
  static const char msg[] = "ArrayBuffer method is not supported yet";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  return NULL;
}

ScrDyn *scr_array_buffer_from_bytes(ScrBytes *view) {
  static const ScrDynHandleOps ops = {
    "ArrayBuffer", &scr_bytes_retain_v, &scr_bytes_release_v,
    &scr_array_buffer_invoke, &scr_array_buffer_get, &scr_array_buffer_set, NULL,
  };
  static const ScrDynHandleOps shared_ops = {
    "SharedArrayBuffer", &scr_bytes_retain_v, &scr_bytes_release_v,
    &scr_array_buffer_invoke, &scr_array_buffer_get, &scr_array_buffer_set, NULL,
  };
  ScrDynHandleTag tag = view->shared ? SCR_DYNH_SHARED_ARRAY_BUFFER : SCR_DYNH_ARRAY_BUFFER;
  scr_dyn_handle_install(tag, view->shared ? &shared_ops : &ops);
  return scr_dyn_new_handle(view->backing ? view->backing : view, tag);
}

static ScrDyn *scr_ffi_fail(const char *message) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
  return NULL;
}

ScrDyn *scr_ffi_argument(ScrDyn *value, ScrStr *type) {
  const char *error = NULL;
  if (type->len == 3 && (!memcmp(type->data, "i64", 3) || !memcmp(type->data, "u64", 3))) {
    bool signed_value = type->data[0] == 'i';
    if (value->kind != SCR_DYN_BIGINT || !(signed_value ? scr_bigint_i64_fits(value->v.bigint) : scr_bigint_u64_fits(value->v.bigint)))
      error = signed_value ? "Native argument must be an int64" : "Native argument must be a uint64";
  } else if (type->len >= 2 && (type->data[0] == 'i' || type->data[0] == 'u')) {
    bool signed_value = type->data[0] == 'i';
    unsigned bits = type->data[1] == '8' ? 8 : type->data[1] == '1' ? 16 : 32;
    double bound = (double)(UINT64_C(1) << (signed_value ? bits - 1 : bits));
    if (value->kind != SCR_DYN_NUM || !isfinite(value->v.num) || floor(value->v.num) != value->v.num ||
        value->v.num < (signed_value ? -bound : 0) || value->v.num >= bound) error = "Native integer argument is outside its ABI range";
  } else if (type->len == 3 && type->data[0] == 'f' && value->kind != SCR_DYN_NUM) {
    error = "Native floating-point argument must be a number";
  }
  if (error) {
    scr_throw_error_msg_code(SCR_ERR_TYPE, error, strlen(error), "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  if (type->len == 7 && !memcmp(type->data, "pointer", 7)) {
    void *address = NULL;
    bool converted = value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF;
    ScrBytes *bytes = value->kind == SCR_DYN_BYTES ? value->v.bytes :
      scr_buffer_storage_is(value) ? value->v.handle.ptr : NULL;
    if (bytes && bytes->shared) return scr_ffi_fail("Shared byte storage cannot expose an unmanaged native pointer");
    if (bytes) { address = bytes->data; converted = true; }
    if (value->kind == SCR_DYN_STR) {
      if (memchr(value->v.str->data, 0, value->v.str->len)) {
        static const char message[] = "Native string argument must not contain null bytes";
        scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_VALUE");
        return NULL;
      }
      address = value->v.str->data;
      converted = true;
    }
    if (converted) {
      ScrBigInt *pointer = scr_bigint_from_pointer(address);
      ScrDyn *result = scr_dyn_new_bigint(pointer);
      scr_bigint_release(pointer);
      return result;
    }
    if (value->kind != SCR_DYN_BIGINT || !scr_bigint_pointer_fits(value->v.bigint)) {
      static const char message[] = "Native pointer argument must be a non-negative address or byte storage";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_VALUE");
      return NULL;
    }
  }
  return scr_dyn_retain(value);
}

static bool scr_ffi_text_equal(const ScrDyn *a, const ScrDyn *b);

static const char *scr_ffi_abi_name(const ScrDyn *value) {
  if (!value || value->kind != SCR_DYN_STR) return NULL;
  static const char *const names[][2] = {
    {"int8", "i8"}, {"uint8", "u8"}, {"bool", "u8"}, {"int16", "i16"}, {"uint16", "u16"},
    {"int32", "i32"}, {"uint32", "u32"}, {"int64", "i64"}, {"uint64", "u64"},
    {"float32", "f32"}, {"float", "f32"}, {"float64", "f64"}, {"double", "f64"},
  };
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
    if (value->v.str->len == strlen(names[i][0]) && !memcmp(value->v.str->data, names[i][0], value->v.str->len)) return names[i][1];
  // Never allow an embedded NUL to turn a different signature into an alias.
  if (memchr(value->v.str->data, 0, value->v.str->len)) return NULL;
  return value->v.str->data;
}

static bool scr_ffi_abi_equal(const ScrDyn *a, const ScrDyn *b) {
  const char *left = scr_ffi_abi_name(a), *right = scr_ffi_abi_name(b);
  return left && right && !strcmp(left, right);
}

static bool scr_ffi_signature_equal(const ScrDyn *entry, const ScrDyn *definition) {
  if (!definition || definition->kind != SCR_DYN_OBJ) return false;
  ScrDyn *expected = scr_dyn_obj_get(entry, "arguments", 9);
  ScrDyn *actual = scr_dyn_obj_get(definition, "arguments", 9);
  if (!actual) return false;
  // JS object properties can retain a native array by reference. Read its
  // current contents when checking the requested ABI, just like a dyn array.
  ScrDyn *view = actual->kind == SCR_DYN_TYPED_REF
    ? scr_dyn_typed_ref_materialize(actual) : scr_dyn_retain(actual);
  bool matches = view && view->kind == SCR_DYN_ARR && view->v.arr.len == expected->v.arr.len &&
    scr_ffi_abi_equal(scr_dyn_obj_get(entry, "return", 6), scr_dyn_obj_get(definition, "return", 6));
  if (matches) for (size_t i = 0; i < view->v.arr.len; i++) {
    if (!scr_ffi_abi_equal(view->v.arr.items[i], expected->v.arr.items[i])) { matches = false; break; }
  }
  scr_dyn_release(view);
  return matches;
}

static void scr_ffi_callback_remove(ScrDyn *entry, ScrDyn *catalog) {
  ScrDyn *name = scr_dyn_obj_get(entry, "name", 4);
  for (size_t i = 0; i < catalog->v.arr.len; i++) {
    ScrDyn *release = catalog->v.arr.items[i];
    if (!scr_ffi_text_equal(scr_dyn_obj_get(release, "target", 6), name)) continue;
    ScrDyn *result = scr_dyn_call(scr_dyn_obj_get(release, "call", 4), NULL, 0, "unregisterCallback");
    scr_dyn_release(result);
    scr_dyn_obj_set(entry, "owner", 5, scr_dyn_new_num(0));
    return;
  }
}

static ScrDyn *scr_ffi_checked_callback_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *callback = scr_box_get_ref(closure->caps[0]);
  ScrDyn *result = scr_dyn_call(callback, args, argc, "native callback");
  scr_dyn_release(callback);
  if (!result) return NULL;
  ScrDyn *type = scr_box_get_ref(closure->caps[1]);
  // Callback pointer returns cannot borrow temporary string/byte storage.
  bool invalid_pointer = type->v.str->len == 7 && !memcmp(type->v.str->data, "pointer", 7) &&
    result->kind != SCR_DYN_BIGINT && result->kind != SCR_DYN_NULL && result->kind != SCR_DYN_UNDEF;
  ScrDyn *converted = invalid_pointer ? scr_ffi_fail("native callback pointer return must be a bigint or nullish") : scr_ffi_argument(result, type->v.str);
  scr_dyn_release(type);
  scr_dyn_release(result);
  return converted;
}

static ScrDyn *scr_ffi_checked_callback(ScrDyn *callback, ScrDyn *type, uint32_t arity) {
  ScrClosure *closure = scr_closure_new(NULL, 2);
  for (size_t i = 0; i < 2; i++) {
    closure->caps[i] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(closure->caps[i], scr_dyn_retain(i ? type : callback));
  }
  return scr_dyn_new_func(closure, scr_ffi_checked_callback_call, arity, "", "native callback");
}

static ScrDyn *scr_ffi_callback_operation(ScrDyn *state, int operation, ScrDyn *const *args, size_t argc) {
  ScrDyn *catalog = scr_dyn_obj_get(state, "catalog", 7);
  double owner = scr_dyn_obj_get(state, "id", 2)->v.num;
  if (operation == 0 || operation == 3) {
    if (operation == 3 && (argc != 1 || args[0]->kind != SCR_DYN_BIGINT)) return scr_ffi_fail("unregisterCallback requires a pointer");
    bool removed = operation == 0;
    for (size_t i = 0; i < catalog->v.arr.len; i++) {
      ScrDyn *entry = catalog->v.arr.items[i];
      ScrDyn *registered = scr_dyn_obj_get(entry, "owner", 5);
      if (!registered || registered->v.num != owner) continue;
      ScrDyn *pointer = scr_dyn_obj_get(entry, "pointer", 7);
      if (operation == 3 && !scr_dyn_strict_eq(pointer, args[0])) continue;
      scr_ffi_callback_remove(entry, catalog);
      removed = true;
    }
    return removed ? scr_dyn_retain(scr_dyn_undefined()) : scr_ffi_fail("callback pointer is not registered with this library");
  }
  if (argc != 2 || args[1]->kind != SCR_DYN_FUNC) return scr_ffi_fail("registerCallback requires a signature and callable");
  ScrDyn *path = scr_dyn_obj_get(state, "path", 4);
  for (size_t i = 0; i < catalog->v.arr.len; i++) {
    ScrDyn *entry = catalog->v.arr.items[i];
    ScrDyn *kind = scr_dyn_obj_get(entry, "operation", 9);
    if (kind->v.str->len != 8 || memcmp(kind->v.str->data, "register", 8) ||
        !scr_ffi_text_equal(scr_dyn_obj_get(entry, "library", 7), path) || !scr_ffi_signature_equal(entry, args[0])) continue;
    ScrDyn *registered = scr_dyn_obj_get(entry, "owner", 5);
    if (registered && registered->v.num != 0) continue;
    ScrDyn *checked = scr_ffi_checked_callback(args[1], scr_dyn_obj_get(entry, "return", 6),
      (uint32_t)scr_dyn_obj_get(entry, "arguments", 9)->v.arr.len);
    ScrDyn *arguments[] = {checked};
    ScrDyn *pointer = scr_dyn_call(scr_dyn_obj_get(entry, "call", 4), arguments, 1, "registerCallback");
    scr_dyn_release(checked);
    if (!pointer) return NULL;
    scr_dyn_obj_set(entry, "owner", 5, scr_dyn_new_num(owner));
    scr_dyn_obj_set(entry, "pointer", 7, scr_dyn_retain(pointer));
    return pointer;
  }
  return scr_ffi_fail("callback signature is not compiled or its registration capacity is exhausted");
}

static ScrDyn *scr_ffi_library_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *state = scr_box_get_ref(closure->caps[0]);
  int operation = (int)scr_box_get_f64(closure->caps[1]);
  ScrDyn *closed = scr_dyn_obj_get(state, "closed", 6);
  if (operation == 0) {
    scr_dyn_obj_set(state, "closed", 6, scr_dyn_new_bool(true));
    ScrDyn *result = scr_ffi_callback_operation(state, 0, args, argc);
    scr_dyn_release(state);
    return result;
  }
  if (closed->v.b) { scr_dyn_release(state); return scr_ffi_fail("native library is closed"); }
  if (operation != 1) {
    ScrDyn *result = scr_ffi_callback_operation(state, operation, args, argc);
    scr_dyn_release(state);
    return result;
  }
  ScrDyn *call = scr_box_get_ref(closure->caps[2]);
  if (argc != call->v.fn.arity) {
    scr_dyn_release(call);
    scr_dyn_release(state);
    return scr_ffi_fail("native function argument count does not match the compiled signature");
  }
  ScrDyn *result = scr_dyn_call(call, args, argc, "native function");
  scr_dyn_release(call);
  scr_dyn_release(state);
  return result;
}

static ScrDyn *scr_ffi_library_function(ScrDyn *state, int operation, ScrDyn *call) {
  ScrClosure *closure = scr_closure_new(NULL, call ? 3 : 2);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_retain(state));
  closure->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[1], operation);
  if (call) {
    closure->caps[2] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(closure->caps[2], scr_dyn_retain(call));
  }
  return scr_dyn_new_func(closure, scr_ffi_library_call, call ? call->v.fn.arity : 0, "", "native");
}

static bool scr_ffi_text_equal(const ScrDyn *a, const ScrDyn *b) {
  return a && b && a->kind == SCR_DYN_STR && b->kind == SCR_DYN_STR &&
    a->v.str->len == b->v.str->len && !memcmp(a->v.str->data, b->v.str->data, a->v.str->len);
}

static ScrDyn *scr_ffi_open(ScrDyn *catalog, const ScrDyn *path, const ScrDyn *definitions) {
  if (path->kind != SCR_DYN_STR || !definitions || definitions->kind != SCR_DYN_OBJ)
    return scr_ffi_fail("static node:ffi.dlopen requires a library name and symbol definitions");
  ScrDyn *functions = scr_dyn_new_obj();
  ScrDyn *state = scr_dyn_new_obj();
  static SCR_TL uint64_t next_library_id;
  if (next_library_id >= UINT64_C(9007199254740991)) {
    scr_dyn_release(functions); scr_dyn_release(state);
    return scr_ffi_fail("native library identity capacity exhausted");
  }
  scr_dyn_obj_set(state, "id", 2, scr_dyn_new_num((double)++next_library_id));
  scr_dyn_obj_set(state, "catalog", 7, scr_dyn_retain(catalog));
  scr_dyn_obj_set(state, "path", 4, scr_dyn_retain((ScrDyn *)path));
  scr_dyn_obj_set(state, "closed", 6, scr_dyn_new_bool(false));
  bool found = false;
  for (size_t i = 0; i < catalog->v.arr.len; i++)
    if (scr_ffi_text_equal(scr_dyn_obj_get(catalog->v.arr.items[i], "library", 7), path)) found = true;
  if (!found) goto invalid;
  for (size_t i = 0; i < definitions->v.obj.len; i++) {
    const ScrDynEntry *requested = &definitions->v.obj.entries[i];
    if (!requested->enumerable) continue;
    if (requested->accessor || requested->value->kind != SCR_DYN_OBJ) goto invalid;
    ScrDyn *entry = NULL;
    for (size_t j = 0; j < catalog->v.arr.len; j++) {
      ScrDyn *candidate = catalog->v.arr.items[j];
      ScrDyn *name = scr_dyn_obj_get(candidate, "name", 4);
      ScrDyn *operation = scr_dyn_obj_get(candidate, "operation", 9);
      if (operation->v.str->len == 4 && !memcmp(operation->v.str->data, "call", 4) &&
          scr_ffi_text_equal(scr_dyn_obj_get(candidate, "library", 7), path) &&
          name->v.str->len == requested->key_len && !memcmp(name->v.str->data, requested->key, requested->key_len)) {
        entry = candidate;
        break;
      }
    }
    if (!entry) goto invalid;
    if (!scr_ffi_signature_equal(entry, requested->value)) goto invalid;
    scr_dyn_obj_set(functions, requested->key, requested->key_len,
      scr_ffi_library_function(state, 1, scr_dyn_obj_get(entry, "call", 4)));
  }
  ScrDyn *lib = scr_dyn_new_obj();
  scr_dyn_obj_set(lib, "close", 5, scr_ffi_library_function(state, 0, NULL));
  scr_dyn_obj_set(lib, "registerCallback", 16, scr_ffi_library_function(state, 2, NULL));
  scr_dyn_obj_set(lib, "unregisterCallback", 18, scr_ffi_library_function(state, 3, NULL));
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "lib", 3, lib);
  scr_dyn_obj_set(result, "functions", 9, functions);
  scr_dyn_release(state);
  return result;
invalid:
  scr_dyn_release(functions);
  scr_dyn_release(state);
  return scr_ffi_fail("node:ffi.dlopen library or signature does not match a static native binding");
}

static ScrDyn *scr_ffi_memory_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  int method = (int)scr_box_get_f64(closure->caps[0]);
  const ScrDyn *value = argc ? args[0] : scr_dyn_undefined();
  if (method == 0) {
    ScrBytes *bytes = value->kind == SCR_DYN_BYTES ? value->v.bytes :
      scr_array_buffer_is(value) ? value->v.handle.ptr : NULL;
    if (!bytes) {
      scr_dyn_arg_type_fail("source", "an ArrayBuffer or ArrayBufferView", value);
      return NULL;
    }
    if (bytes->shared) return scr_ffi_fail("Shared byte storage cannot expose an unmanaged native pointer");
    ScrBigInt *pointer = scr_bigint_from_pointer(bytes->data);
    ScrDyn *result = scr_dyn_new_bigint(pointer);
    scr_bigint_release(pointer);
    return result;
  }
  if (method == 1) {
    if (value->kind != SCR_DYN_BIGINT) {
      scr_dyn_arg_type_fail("pointer", "of type bigint", value);
      return NULL;
    }
    if (!scr_bigint_pointer_fits(value->v.bigint)) {
      static const char message[] = "The first argument must be a non-negative bigint";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_VALUE");
      return NULL;
    }
    const ScrDyn *size = argc > 1 ? args[1] : scr_dyn_undefined();
    if (size->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("length", "of type number", size);
      return NULL;
    }
    double length = size->v.num;
    if (!isfinite(length) || length < 0 || floor(length) != length) {
      static const char message[] = "The length must be a non-negative integer";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_VALUE");
      return NULL;
    }
    if (length >= (double)SIZE_MAX) {
      static const char message[] = "The length is too large";
      scr_throw_error_msg_code(SCR_ERR_RANGE, message, sizeof message - 1, "ERR_OUT_OF_RANGE");
      return NULL;
    }
    bool copy = argc < 3 || args[2]->kind == SCR_DYN_UNDEF || scr_dyn_truthy(args[2]);
    void *pointer = scr_bigint_to_pointer(value->v.bigint);
    if (!pointer && length != 0) {
      static const char message[] = "Cannot create an ArrayBuffer from a null pointer";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_FFI_INVALID_POINTER");
      return NULL;
    }
    if (length > 0 && (size_t)length - 1 > UINTPTR_MAX - (uintptr_t)pointer) {
      static const char message[] = "The pointer and length exceed the platform address range";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_VALUE");
      return NULL;
    }
    if (length > 9007199254740991.0) {
      static const char message[] = "Buffer is too large";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_BUFFER_TOO_LARGE");
      return NULL;
    }
    ScrBytes *bytes = copy ? scr_bytes_from_data(pointer, (size_t)length) :
      scr_bytes_from_external(pointer, (size_t)length);
    ScrDyn *result = scr_array_buffer_from_bytes(bytes);
    scr_bytes_release(bytes);
    return result;
  }
  ScrDyn *catalog = scr_box_get_ref(closure->caps[1]);
  ScrDyn *result = scr_ffi_open(catalog, value, argc > 1 ? args[1] : NULL);
  scr_dyn_release(catalog);
  return result;
}

static SCR_TL ScrDyn *scr_ffi_module_value;

static void scr_ffi_module_cleanup(void) {
  scr_dyn_release(scr_ffi_module_value);
  scr_ffi_module_value = NULL;
}

ScrDyn *scr_ffi_memory_module(ScrDyn *catalog) {
  if (scr_ffi_module_value) return scr_dyn_retain(scr_ffi_module_value);
  ScrDyn *module = scr_dyn_new_obj();
  const char *names[] = {"getRawPointer", "toArrayBuffer", "dlopen"};
  for (size_t i = 0; i < 3; i++) {
    ScrClosure *closure = scr_closure_new(NULL, 2);
    closure->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(closure->caps[0], (double)i);
    closure->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(closure->caps[1], scr_dyn_retain(catalog));
    scr_dyn_obj_set(module, names[i], strlen(names[i]),
      scr_dyn_new_func(closure, scr_ffi_memory_call, i == 0 ? 1 : i == 1 ? 3 : 2, "", names[i]));
  }
#ifdef _WIN32
  const char *suffix = "dll";
#elif defined(__APPLE__)
  const char *suffix = "dylib";
#else
  const char *suffix = "so";
#endif
  ScrStr *text = scr_str_new(suffix, strlen(suffix));
  scr_dyn_obj_set(module, "suffix", 6, scr_dyn_new_str(text));
  scr_str_release(text);
  scr_ffi_module_value = scr_dyn_retain(module);
  scr_atexit(scr_ffi_module_cleanup);
  return module;
}

ScrDyn *scr_dyn_mark_snapshot(ScrDyn *value) {
  value->copied_from_native = true;
  return value;
}

typedef struct ScrWeakMap ScrWeakMap;
typedef struct ScrWeakEntry {
  void *key; /* borrowed native identity, never retained */
  unsigned kind;
  ScrDyn *value;
  ScrWeakMap *owner;
  struct ScrWeakEntry *next, *all_next;
} ScrWeakEntry;

struct ScrWeakMap { size_t rc; ScrWeakEntry *entries; bool is_set; };
/* Weak observers borrow key identities. Values are traced strong edges;
 * value-to-key cycles require explicit deletion or container disposal. */
#define SCR_WEAK_BUCKETS 1024
static SCR_TL ScrWeakEntry *scr_weak_entries[SCR_WEAK_BUCKETS];
static size_t scr_weak_bucket(void *key) {
  uintptr_t bits = (uintptr_t)key;
  return ((bits >> 4) ^ (bits >> 14)) & (SCR_WEAK_BUCKETS - 1);
}

static void scr_weak_remove_impl(ScrWeakEntry *entry, bool collected) {
  ScrWeakEntry **slot = &entry->owner->entries;
  while (*slot != entry) slot = &(*slot)->next;
  *slot = entry->next;
  slot = &scr_weak_entries[scr_weak_bucket(entry->key)];
  while (*slot != entry) slot = &(*slot)->all_next;
  *slot = entry->all_next;
  ScrDyn *value = entry->value;
  free(entry);
  /* Unlink before release: releasing a value can dispose another key. */
  if (!collected) scr_dyn_release(value);
}

static void scr_weak_remove(ScrWeakEntry *entry) {
  scr_weak_remove_impl(entry, scr_cyc_color(scr_cyc_hdr(entry->owner)) == SCR_CYC_DOOMED);
}

static void scr_weak_map_trace(void *ptr, ScrTraceVisit visit, void *ctx) {
  for (ScrWeakEntry *entry = ((ScrWeakMap *)ptr)->entries; entry; entry = entry->next)
    visit(entry->value, ctx);
}

static void scr_weak_map_gcfree(void *ptr) {
  ScrWeakMap *map = ptr;
  while (map->entries) scr_weak_remove_impl(map->entries, true);
  scr_cyc_free(map);
}

static void scr_weak_disposed(void *key) {
  for (;;) {
    ScrWeakEntry *entry = scr_weak_entries[scr_weak_bucket(key)];
    while (entry && entry->key != key) entry = entry->all_next;
    if (!entry) return;
    scr_weak_remove(entry);
  }
}

static void *scr_weak_map_retain(void *ptr) {
  ((ScrWeakMap *)ptr)->rc++;
  return ptr;
}

static void scr_weak_map_release(void *ptr) {
  ScrWeakMap *map = ptr;
  if (--map->rc) { scr_cyc_released(map); return; }
  scr_cyc_dead(map);
  scr_weak_dispose(map);
  while (map->entries) scr_weak_remove(map->entries);
  scr_cyc_free(map);
}

/* Return 1 for an observed identity, 0 for a primitive, and -1 for a
 * reference whose native lifetime has no observer contract yet. */
static int scr_weak_key(const ScrDyn *key, void **ptr, unsigned *kind) {
  /* A view of a native object (an empty record boxed with its identity) is
   * keyed by that object, exactly like its typed reference: native frees
   * notify scr_weak_dispose with the same pointer. */
  if (key->kind == SCR_DYN_OBJ && key->v.obj.source_identity) {
    *ptr = key->v.obj.source_identity; *kind = 32; return 1;
  }
  if (key->copied_from_native) return -1;
  *kind = 0;
  switch (key->kind) {
  case SCR_DYN_OBJ:
    *ptr = (void *)key; return 1;
  case SCR_DYN_ARR: case SCR_DYN_PROXY:
    *ptr = (void *)key; return 1;
  case SCR_DYN_BYTES:
    *ptr = key->v.bytes; *kind = 1; return 1;
  case SCR_DYN_FUNC:
    *ptr = key->v.fn.class_obj ? (void *)key->v.fn.class_obj : (void *)scr_closure_identity(key->v.fn.clo);
    *kind = key->v.fn.class_obj ? 3 : 2; return 1;
  case SCR_DYN_HANDLE:
    if (key->v.handle.tag != SCR_DYNH_ARRAY_BUFFER && key->v.handle.tag != SCR_DYNH_SHARED_ARRAY_BUFFER && key->v.handle.tag != SCR_DYNH_WEAK_MAP &&
        key->v.handle.tag != SCR_DYNH_WEAK_SET && key->v.handle.tag != SCR_DYNH_FINALIZATION_REGISTRY &&
        key->v.handle.tag != SCR_DYNH_STDIO &&
        key->v.handle.tag != SCR_DYNH_FETCH_REQUEST && key->v.handle.tag != SCR_DYNH_FETCH_RESPONSE &&
        key->v.handle.tag != SCR_DYNH_MAP && key->v.handle.tag != SCR_DYNH_SET &&
        key->v.handle.tag != SCR_DYNH_NET_SOCKET && key->v.handle.tag != SCR_DYNH_NET_SERVER) return -1;
    *ptr = key->v.handle.ptr; *kind = 4 + key->v.handle.tag; return 1;
  case SCR_DYN_TYPED_REF:
    if (!key->v.typed_ref.observed) return -1;
    *ptr = key->v.typed_ref.ptr; *kind = 32; return 1;
  case SCR_DYN_PROMISE:
    *ptr = key->v.promise; *kind = 33; return 1;

  default: return 0;
  }
}

static ScrWeakEntry *scr_weak_find(ScrWeakMap *map, void *ptr, unsigned kind) {
  for (ScrWeakEntry *entry = map->entries; entry; entry = entry->next)
    if (entry->key == ptr && entry->kind == kind) return entry;
  return NULL;
}

static bool scr_weak_set(ScrWeakMap *map, ScrDyn *key, ScrDyn *value) {
  void *ptr = NULL;
  unsigned kind = 0;
  int supported = scr_weak_key(key, &ptr, &kind);
  if (supported < 0) {
    static const char message[] = "Weak collection keys of this native reference type have no weak lifetime lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return false;
  }
  if (!supported) {
    const char *message = map->is_set ? "Invalid value used in weak set" : "Invalid value used as weak map key";
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return false;
  }
  ScrWeakEntry *entry = scr_weak_find(map, ptr, kind);
  if (entry) {
    ScrDyn *old = entry->value;
    entry->value = scr_dyn_retain(value);
    scr_dyn_release(old);
    return true;
  }
  entry = calloc(1, sizeof *entry);
  if (!entry) scr_json_oom();
  entry->key = ptr;
  entry->kind = kind;
  entry->value = scr_dyn_retain(value);
  entry->owner = map;
  entry->next = map->entries;
  map->entries = entry;
  size_t bucket = scr_weak_bucket(ptr);
  entry->all_next = scr_weak_entries[bucket];
  scr_weak_entries[bucket] = entry;
  return true;
}

static ScrDyn *scr_weak_map_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)what;
  ScrWeakMap *map = ptr;
  ScrDyn *key = argc ? args[0] : scr_dyn_undefined();
  if (strcmp(method, map->is_set ? "add" : "set") == 0) {
    if (!scr_weak_set(map, key, !map->is_set && argc > 1 ? args[1] : scr_dyn_undefined())) return NULL;
    return scr_dyn_retain(self);
  }
  if ((!map->is_set && strcmp(method, "get") == 0) || strcmp(method, "has") == 0 || strcmp(method, "delete") == 0) {
    void *identity = NULL;
    unsigned kind = 0;
    int supported = scr_weak_key(key, &identity, &kind);
    if (supported < 0) {
      static const char message[] = "Weak collection keys of this native reference type have no weak lifetime lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    ScrWeakEntry *entry = supported ? scr_weak_find(map, identity, kind) : NULL;
    if (strcmp(method, "get") == 0) return scr_dyn_retain(entry ? entry->value : scr_dyn_undefined());
    bool found = entry != NULL;
    if (found && strcmp(method, "delete") == 0) scr_weak_remove(entry);
    return scr_dyn_new_bool(found);
  }
  static const char message[] = "WeakMap method has no native lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static ScrDyn *scr_weak_map_get(void *ptr, const char *key, size_t len) {
  ScrWeakMap *map = ptr;
  if ((len == 3 && (memcmp(key, "has", 3) == 0 ||
      (map->is_set ? memcmp(key, "add", 3) == 0 : (memcmp(key, "get", 3) == 0 || memcmp(key, "set", 3) == 0)))) ||
      (len == 6 && memcmp(key, "delete", 6) == 0)) {
    static const char message[] = "Weak collection method values have no native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  return NULL;
}

static bool scr_weak_map_write(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr; (void)key; (void)len; (void)value;
  return false;
}

/* Constructor entries read property 0 before property 1, including getters.
 * Entry validation has already rejected primitive values. */
static ScrDyn *scr_dyn_entry_read(const ScrDyn *entry, unsigned index) {
  if (entry->kind == SCR_DYN_ARR)
    return scr_dyn_retain(index < entry->v.arr.len ? entry->v.arr.items[index] : scr_dyn_undefined());
  char name = index ? '1' : '0';
  if (entry->kind == SCR_DYN_OBJ) return scr_dyn_obj_read(entry, &name, 1);
  if (entry->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(entry);
    if (scr_exc_pending()) { scr_dyn_release(view); return NULL; }
    ScrDyn *result = scr_dyn_entry_read(view, index);
    scr_dyn_release(view);
    return result;
  }
  ScrStr *key = scr_str_new(&name, 1);
  ScrDyn *result = NULL;
  switch (entry->kind) {
  case SCR_DYN_PROXY: result = scr_dyn_proxy_get(entry, key); break;
  case SCR_DYN_BYTES: result = scr_dyn_bytes_key_get(entry, key); break;
  case SCR_DYN_HANDLE: result = scr_dyn_handle_key_get(entry, key); break;
  case SCR_DYN_FUNC: result = scr_dyn_fn_get(entry, &name, 1); break;

  default: break;
  }
  scr_str_release(key);
  return result || scr_exc_pending() ? result : scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_weak_collection_new(ScrDyn *seed, bool is_set) {
  static const ScrDynHandleOps map_ops = {
    "WeakMap", &scr_weak_map_retain, &scr_weak_map_release, &scr_weak_map_invoke,
    &scr_weak_map_get, &scr_weak_map_write, NULL, NULL,
  };
  static const ScrDynHandleOps set_ops = {
    "WeakSet", &scr_weak_map_retain, &scr_weak_map_release, &scr_weak_map_invoke,
    &scr_weak_map_get, &scr_weak_map_write, NULL, NULL,
  };
  ScrDynHandleTag tag = is_set ? SCR_DYNH_WEAK_SET : SCR_DYNH_WEAK_MAP;
  scr_weak_observing = true;
  scr_weak_dispose_hook = &scr_dispose_observers;
  scr_dyn_handle_install(tag, is_set ? &set_ops : &map_ops);
  static ScrCycType cyc_type = { &scr_weak_map_trace, &scr_weak_map_gcfree, SCR_CYC_KIND_WEAK_MAP };
  ScrWeakMap *map = scr_cyc_alloc(sizeof *map, &cyc_type);
  if (!map) scr_json_oom();
  map->rc = 1;
  map->is_set = is_set;
  ScrDyn *entries = scr_dyn_map_seed_entries(seed);
  if (!entries) { scr_weak_map_release(map); return NULL; }
  for (size_t i = 0; i < entries->v.arr.len; i++) {
    if (is_set) {
      if (!scr_weak_set(map, entries->v.arr.items[i], scr_dyn_undefined())) break;
      continue;
    }
    ScrDyn *entry = scr_dyn_map_seed_entry(entries->v.arr.items[i]);
    if (!entry) break;
    ScrDyn *key = scr_dyn_entry_read(entry, 0);
    ScrDyn *value = scr_exc_pending() ? NULL : scr_dyn_entry_read(entry, 1);
    scr_dyn_release(entry);
    bool ok = value && scr_weak_set(map, key, value);
    scr_dyn_release(key); scr_dyn_release(value);
    if (!ok) break;
  }
  scr_dyn_release(entries);
  if (scr_exc_pending()) { scr_weak_map_release(map); return NULL; }
  ScrDyn *result = scr_dyn_new_handle(map, tag);
  scr_weak_map_release(map);
  return result;
}

bool scr_weak_map_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WEAK_MAP;
}
bool scr_weak_set_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WEAK_SET;
}
ScrDyn *scr_weak_map_new(ScrDyn *seed) { return scr_weak_collection_new(seed, false); }
ScrDyn *scr_weak_set_new(ScrDyn *seed) { return scr_weak_collection_new(seed, true); }

/* FinalizationRegistry. register() and unregister() validate and keep their
 * bookkeeping as Node does; the cleanup callback never runs, which
 * ECMAScript allows (an implementation need not collect a target or call
 * its cleanup), so the registry keeps neither the callback nor the held
 * values. The unregister tokens are keys of an internal WeakMap counting
 * each token's registrations, so the registry keeps no token alive. */
typedef struct {
  size_t rc;
  ScrDyn *tokens; /* WeakMap: token -> registration count */
} ScrFinalizationRegistry;

static void *scr_finalization_registry_retain(void *ptr) {
  ((ScrFinalizationRegistry *)ptr)->rc++;
  return ptr;
}

static void scr_finalization_registry_release(void *ptr) {
  ScrFinalizationRegistry *registry = ptr;
  if (--registry->rc) return;
  /* Weak collections keyed by the registry drop their entries. */
  scr_weak_dispose(registry);
  scr_dyn_release(registry->tokens);
  free(registry);
}

static void scr_finalization_type_error(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

/* The weak-key identity of a registration target or token, or false with
 * the TypeError (or the SC2020 refusal) pending. */
static bool scr_finalization_key(const ScrDyn *value, void **ptr, unsigned *kind,
                                 const char *invalid) {
  if (value->kind == SCR_DYN_SYMBOL) {
    static const char message[] = "FinalizationRegistry with symbol targets or tokens is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return false;
  }
  int supported = scr_weak_key(value, ptr, kind);
  if (supported < 0) {
    static const char message[] = "FinalizationRegistry targets of this native reference type have no weak lifetime lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return false;
  }
  if (!supported) {
    if (invalid) {
      scr_finalization_type_error(invalid);
    } else {
      /* Node's unregister message quotes the token as String() renders it. */
      ScrStr *text = scr_dyn_string_coerce(value);
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "Invalid unregisterToken ('");
      if (text) scr_jb_write(&b, text->data, text->len);
      scr_jb_puts(&b, "')");
      scr_str_release(text);
      ScrStr *message = scr_jb_finish(&b);
      scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
      scr_str_release(message);
    }
    return false;
  }
  return true;
}

static ScrDyn *scr_finalization_registry_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrFinalizationRegistry *registry = ptr;
  ScrWeakMap *tokens = registry->tokens->v.handle.ptr;
  ScrDyn *first = argc > 0 ? args[0] : scr_dyn_undefined();
  void *identity = NULL;
  unsigned kind = 0;
  if (strcmp(method, "register") == 0) {
    ScrDyn *held = argc > 1 ? args[1] : scr_dyn_undefined();
    ScrDyn *token = argc > 2 ? args[2] : scr_dyn_undefined();
    if (!scr_finalization_key(first, &identity, &kind, "FinalizationRegistry.prototype.register: invalid target"))
      return NULL;
    if (scr_dyn_strict_eq(first, held)) {
      scr_finalization_type_error("FinalizationRegistry.prototype.register: target and holdings must not be same");
      return NULL;
    }
    if (token->kind != SCR_DYN_UNDEF) {
      if (!scr_finalization_key(token, &identity, &kind, NULL)) return NULL;
      ScrWeakEntry *entry = scr_weak_find(tokens, identity, kind);
      double count = entry && entry->value->kind == SCR_DYN_NUM ? entry->value->v.num : 0;
      ScrDyn *next = scr_dyn_new_num(count + 1);
      bool ok = scr_weak_set(tokens, token, next);
      scr_dyn_release(next);
      if (!ok) return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "unregister") == 0) {
    if (!scr_finalization_key(first, &identity, &kind, NULL)) return NULL;
    ScrWeakEntry *entry = scr_weak_find(tokens, identity, kind);
    if (entry) scr_weak_remove(entry);
    return scr_dyn_new_bool(entry != NULL);
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what ? what : method);
  scr_jb_puts(&b, " is not a function");
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
  scr_str_release(message);
  return NULL;
}

/* A property read answers undefined for names the registry does not have.
 * Its methods read as values (`const register = registry.register`) are
 * refused, as a weak collection's are. */
static ScrDyn *scr_finalization_registry_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  if ((len == 8 && memcmp(key, "register", 8) == 0) || (len == 10 && memcmp(key, "unregister", 10) == 0)) {
    static const char message[] = "FinalizationRegistry method values have no native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  return NULL;
}

static ScrDyn *scr_finalization_registry_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

ScrDyn *scr_finalization_registry_new(ScrDyn *cleanup) {
  if (!scr_dyn_is_callable(cleanup)) {
    scr_finalization_type_error("FinalizationRegistry: cleanup must be callable");
    return NULL;
  }
  static const ScrDynHandleOps ops = {
    .cls = "FinalizationRegistry",
    .retain = &scr_finalization_registry_retain,
    .release = &scr_finalization_registry_release,
    .invoke = &scr_finalization_registry_invoke,
    .get = &scr_finalization_registry_get,
    .inspect_view = &scr_finalization_registry_view,
    .inspect_view_empty = true,
  };
  scr_dyn_handle_install(SCR_DYNH_FINALIZATION_REGISTRY, &ops);
  ScrFinalizationRegistry *registry = calloc(1, sizeof *registry);
  if (!registry) scr_json_oom();
  registry->tokens = scr_weak_collection_new(scr_dyn_undefined(), false);
  if (!registry->tokens) { free(registry); return NULL; }
  ScrDyn *result = scr_dyn_new_handle(registry, SCR_DYNH_FINALIZATION_REGISTRY);
  return result;
}

bool scr_finalization_registry_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_FINALIZATION_REGISTRY;
}

ScrDyn *scr_dyn_from_entries(ScrDyn *seed) {
  if (seed->kind == SCR_DYN_UNDEF || seed->kind == SCR_DYN_NULL) {
    static const char message[] = "undefined is not iterable";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *entries = scr_dyn_map_seed_entries(seed);
  if (!entries) return NULL;
  ScrDyn *result = scr_dyn_new_obj();
  for (size_t i = 0; i < entries->v.arr.len; i++) {
    ScrDyn *entry = scr_dyn_map_seed_entry(entries->v.arr.items[i]);
    if (!entry) break;
    ScrDyn *key = scr_dyn_entry_read(entry, 0);
    ScrDyn *value = scr_exc_pending() ? NULL : scr_dyn_entry_read(entry, 1);
    scr_dyn_release(entry);
    if (value && key && key->kind == SCR_DYN_SYMBOL) {
      scr_dyn_symbol_key_set(result, key, value);
      scr_dyn_release(key);
      scr_dyn_release(value);
      if (scr_exc_pending()) break;
      continue;
    }
    ScrStr *name = value ? scr_dyn_property_key(key) : NULL;
    scr_dyn_release(key);
    if (name && !scr_exc_pending()) {
      scr_dyn_obj_set(result, name->data, name->len, value); /* takes value */
    } else {
      scr_dyn_release(value);
    }
    scr_str_release(name);
    if (scr_exc_pending()) break;
  }
  scr_dyn_release(entries);
  if (scr_exc_pending()) { scr_dyn_release(result); return NULL; }
  return result;
}

ScrDyn *scr_array_buffer_new(ScrDyn *length) {
  double number;
  if (!scr_dyn_number_coerce_js(length, &number)) return NULL;
  double size = isnan(number) ? 0 : trunc(number);
  if (!(size >= 0) || size > 9007199254740991.0 || size > (double)(SIZE_MAX / 8)) {
    static const char msg[] = "Invalid array buffer length";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  ScrBytes *storage = scr_bytes_new(SCR_BYTES_U8, size);
  if (!storage) return NULL;
  ScrDyn *result = scr_array_buffer_from_bytes(storage);
  scr_bytes_release(storage);
  return result;
}

ScrDyn *scr_shared_array_buffer_new(ScrDyn *length) {
  ScrDyn *buffer = scr_array_buffer_new(length);
  if (!buffer) return NULL;
  ScrBytes *storage = buffer->v.handle.ptr;
  scr_bytes_make_shared(storage);
  ScrDyn *result = scr_array_buffer_from_bytes(storage);
  scr_dyn_release(buffer);
  return result;
}

double scr_array_buffer_byte_length_getter(void) {
  ScrDyn *receiver = scr_dyn_this_get();
  if (!scr_array_buffer_is(receiver)) {
    scr_dyn_release(receiver);
    static const char msg[] = "Method get ArrayBuffer.prototype.byteLength called on incompatible receiver";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return 0;
  }
  double length = scr_bytes_byte_len(receiver->v.handle.ptr);
  scr_dyn_release(receiver);
  return length;
}

ScrDyn *scr_array_buffer_byte_length_descriptor(ScrDyn *getter) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  ScrDyn *named = scr_dyn_new_func(scr_closure_retain(getter->v.fn.clo),
      getter->v.fn.thunk, 0, getter->v.fn.sig, "get byteLength");
  scr_dyn_obj_set(descriptor, "get", 3, named);
  scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  return descriptor;
}

ScrBytes *scr_array_buffer_view(ScrBytesElem elem, const ScrDyn *buffer,
    const ScrDyn *offset, const ScrDyn *length) {
  if (!scr_buffer_storage_is(buffer)) {
    // Non-buffer inputs use the length/iterable/array-like constructor.
    // Their extra arguments are evaluated by the caller, but not coerced.
    return scr_bytes_from_dyn(elem, buffer, false);
  }
  double off, count = 0;
  if (!scr_dyn_number_coerce_js(offset, &off)) return NULL;
  off = isnan(off) ? 0 : trunc(off);
  if (off < 0 || off > 9007199254740991.0 ||
      fmod(off, (double)scr_bytes_elem_size(elem)) != 0) {
    static const char msg[] = "Invalid typed array buffer range";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  bool has_len = length->kind != SCR_DYN_UNDEF;
  if (has_len && !scr_dyn_number_coerce_js(length, &count)) return NULL;
  return scr_bytes_buffer_view(buffer->v.handle.ptr, elem, off, has_len, count);
}

#define SCR_ARRAY_BUFFER_VIEW(name, elem) \
ScrBytes *scr_array_buffer_view_##name(ScrDyn *buffer, ScrDyn *offset, ScrDyn *length) { \
  return scr_array_buffer_view(elem, buffer, offset, length); \
}
SCR_ARRAY_BUFFER_VIEW(u8c, SCR_BYTES_U8C)
SCR_ARRAY_BUFFER_VIEW(i8, SCR_BYTES_I8)
SCR_ARRAY_BUFFER_VIEW(u16, SCR_BYTES_U16)
SCR_ARRAY_BUFFER_VIEW(i16, SCR_BYTES_I16)
SCR_ARRAY_BUFFER_VIEW(u8, SCR_BYTES_U8)
SCR_ARRAY_BUFFER_VIEW(u32, SCR_BYTES_U32)
SCR_ARRAY_BUFFER_VIEW(i32, SCR_BYTES_I32)
SCR_ARRAY_BUFFER_VIEW(f16, SCR_BYTES_F16)
SCR_ARRAY_BUFFER_VIEW(f32, SCR_BYTES_F32)
SCR_ARRAY_BUFFER_VIEW(f64, SCR_BYTES_F64)
#undef SCR_ARRAY_BUFFER_VIEW

ScrBytes *scr_array_buffer_view_dv(ScrDyn *buffer, ScrDyn *offset, ScrDyn *length) {
  if (!scr_buffer_storage_is(buffer)) {
    static const char msg[] = "First argument to DataView constructor must be an ArrayBuffer";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  double off, count = 0;
  if (!scr_dyn_number_coerce_js(offset, &off)) return NULL;
  off = isnan(off) ? 0 : trunc(off);
  if (off < 0 || off > 9007199254740991.0 || off > scr_bytes_byte_len(buffer->v.handle.ptr)) {
    // DataView rejects an out-of-bounds offset before coercing length.
    return scr_dataview_new(buffer->v.handle.ptr, off, false, 0);
  }
  bool has_len = length->kind != SCR_DYN_UNDEF;
  if (has_len && !scr_dyn_number_coerce_js(length, &count)) return NULL;
  return scr_dataview_new(buffer->v.handle.ptr, off, has_len, count);
}

/* Native Set<unknown> crosses generic object/factory boundaries by reference.
 * Its existing ScrMap remains authoritative for typed and untyped callers. */
static ScrDyn *scr_native_set_get(void *ptr, const char *key, size_t len) {
  if (len == 4 && memcmp(key, "size", 4) == 0) return scr_dyn_new_num(scr_map_size(ptr));
  static const char *const methods[] = {"add", "has", "delete", "clear", "forEach", "values", "keys", "entries"};
  for (size_t i = 0; i < sizeof methods / sizeof methods[0]; i++) {
    if (strlen(methods[i]) == len && memcmp(key, methods[i], len) == 0) {
      static const char message[] = "Native Set method values have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      break;
    }
  }
  return NULL;
}

static ScrDyn *scr_native_set_invoke(void *ptr, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  ScrMap *set = ptr;
  ScrDyn *value = argc ? args[0] : scr_dyn_undefined();
  if (strcmp(method, "add") == 0) {
    scr_map_dyn_set(set, value, NULL, true);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "has") == 0) return scr_dyn_new_bool(scr_map_dyn_has(set, value, false));
  if (strcmp(method, "delete") == 0) return scr_dyn_new_bool(scr_map_dyn_has(set, value, true));
  if (strcmp(method, "clear") == 0) { scr_map_clear(set); return scr_dyn_retain(scr_dyn_undefined()); }
  if (strcmp(method, "values") == 0 || strcmp(method, "keys") == 0) return scr_native_collection_iterator(self, 0);
  if (strcmp(method, "entries") == 0) return scr_native_collection_iterator(self, 2);
  if (strcmp(method, "forEach") == 0) {
    if (value->kind != SCR_DYN_FUNC) {
      ScrJsonBuf message;
      scr_jb_init(&message);
      switch (value->kind) {
      case SCR_DYN_UNDEF: scr_jb_puts(&message, "undefined"); break;
      case SCR_DYN_NULL: scr_jb_puts(&message, "object null"); break;
      case SCR_DYN_NUM: scr_jb_puts(&message, "number "); scr_jb_put_f64(&message, value->v.num); break;
      case SCR_DYN_BOOL: scr_jb_puts(&message, value->v.b ? "boolean true" : "boolean false"); break;
      case SCR_DYN_STR: scr_jb_puts(&message, "string "); scr_jb_put_json_str(&message, value->v.str); break;
      case SCR_DYN_BIGINT: scr_jb_puts(&message, "bigint"); break;
      default: scr_jb_puts(&message, "object"); break;
      }
      scr_jb_puts(&message, " is not a function");
      scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
      return NULL;
    }
    ScrDyn *this_arg = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_map_iter_enter(set);
    for (double i = 0; i < scr_map_iter_count(set); i++) {
      if (!scr_map_iter_live(set, i)) continue;
      ScrDyn *entry = scr_map_dyn_key(set, i);
      ScrDyn *callback_args[] = {entry, entry, self};
      scr_dyn_this_push_dyn(this_arg);
      ScrDyn *result = scr_dyn_call(value, callback_args, 3, "callback");
      scr_dyn_this_pop();
      scr_dyn_release(entry);
      scr_dyn_release(result);
      if (scr_exc_pending()) break;
    }
    scr_map_iter_exit(set);
    return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  }
  (void)what;
  static const char message[] = "Native Set method has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static ScrDyn *scr_native_set_pack(void *ptr) {
  ScrMap *set = ptr;
  ScrDyn *values = scr_dyn_new_arr();
  scr_map_iter_enter(set);
  for (double i = 0; i < scr_map_iter_count(set); i++) {
    if (scr_map_iter_live(set, i)) scr_dyn_arr_push(values, scr_map_dyn_key(set, i));
  }
  scr_map_iter_exit(set);
  return values;
}

ScrDyn *scr_dyn_native_set(ScrMap *value) {
  static const ScrDynHandleOps ops = {
      .cls = "Set",
      .retain = &scr_map_retain_v,
      .release = &scr_map_release_v,
      .invoke = &scr_native_set_invoke,
      .get = &scr_native_set_get,
      .set = &scr_weak_map_write,
      .iter_pack = &scr_native_set_pack,
      /* Entries live in internal slots: JSON.stringify writes {}, as Node. */
      .json_empty_object = true,
  };
  scr_dyn_handle_install(SCR_DYNH_SET, &ops);
  return scr_dyn_new_handle(value, SCR_DYNH_SET);
}

ScrDyn *scr_dyn_native_set_new(const ScrDyn *seed) {
  ScrDyn *items = NULL;
  if (seed->kind != SCR_DYN_NULL && seed->kind != SCR_DYN_UNDEF) {
    items = scr_dyn_seed_values(seed);
    if (!items) return NULL;
  }
  ScrMap *set = scr_map_new(SCR_MAP_KEY_DYN, SCR_MAP_VAL_F64, &scr_map_dyn_set_ops);
  if (items) for (size_t i = 0; i < items->v.arr.len; i++) scr_map_set_ref_f64(set, items->v.arr.items[i], 0);
  ScrDyn *result = scr_dyn_native_set(set);
  scr_map_release(set);
  scr_dyn_release(items);
  return result;
}

bool scr_dyn_native_set_is(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_SET;
}

ScrMap *scr_dyn_native_set_check(const ScrDyn *value, const ScrDynPath *path) {
  if (!scr_dyn_native_set_is(value)) { scr_dyn_check_fail(path, "Set", value); return NULL; }
  return scr_map_retain(value->v.handle.ptr);
}

/* Map<unknown, unknown> keeps its native backing across checked boundaries. */
static ScrDyn *scr_native_map_get(void *ptr, const char *key, size_t len) {
  if (len == 4 && memcmp(key, "size", 4) == 0) return scr_dyn_new_num(scr_map_size(ptr));
  static const char *const methods[] = {"get", "set", "has", "delete", "clear", "forEach", "values", "keys", "entries"};
  for (size_t i = 0; i < sizeof methods / sizeof methods[0]; i++) {
    if (strlen(methods[i]) == len && memcmp(key, methods[i], len) == 0) {
      static const char message[] = "Native Map method values have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      break;
    }
  }
  return NULL;
}

static ScrDyn *scr_native_map_invoke(void *ptr, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  ScrMap *map = ptr;
  ScrDyn *key = argc ? args[0] : scr_dyn_undefined();
  if (strcmp(method, "set") == 0) {
    scr_map_dyn_set(map, key, argc > 1 ? args[1] : scr_dyn_undefined(), false);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "get") == 0) {
    return scr_map_dyn_get(map, key);
  }
  if (strcmp(method, "has") == 0) return scr_dyn_new_bool(scr_map_dyn_has(map, key, false));
  if (strcmp(method, "delete") == 0) return scr_dyn_new_bool(scr_map_dyn_has(map, key, true));
  if (strcmp(method, "clear") == 0) { scr_map_clear(map); return scr_dyn_retain(scr_dyn_undefined()); }
  if (strcmp(method, "values") == 0) return scr_native_collection_iterator(self, 0);
  if (strcmp(method, "keys") == 0) return scr_native_collection_iterator(self, 1);
  if (strcmp(method, "entries") == 0) return scr_native_collection_iterator(self, 2);
  if (strcmp(method, "forEach") == 0) {
    if (key->kind != SCR_DYN_FUNC) {
      /* Validate even when there are no entries to visit. */
      ScrDyn *result = scr_dyn_call(key, NULL, 0, "callback");
      scr_dyn_release(result);
      return NULL;
    }
    ScrDyn *this_arg = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_map_iter_enter(map);
    for (double i = 0; i < scr_map_iter_count(map); i++) {
      if (!scr_map_iter_live(map, i)) continue;
      ScrDyn *entry_key = scr_map_dyn_key(map, i);
      ScrDyn *value = scr_map_dyn_value(map, i);
      ScrDyn *callback_args[] = {value, entry_key, self};
      scr_dyn_this_push_dyn(this_arg);
      ScrDyn *result = scr_dyn_call(key, callback_args, 3, "callback");
      scr_dyn_this_pop();
      scr_dyn_release(entry_key);
      scr_dyn_release(value);
      scr_dyn_release(result);
      if (scr_exc_pending()) break;
    }
    scr_map_iter_exit(map);
    return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  }
  (void)what;
  static const char message[] = "Native Map method has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static ScrDyn *scr_native_map_pack(void *ptr) {
  ScrMap *map = ptr;
  ScrDyn *entries = scr_dyn_new_arr();
  scr_map_iter_enter(map);
  for (double i = 0; i < scr_map_iter_count(map); i++) {
    if (!scr_map_iter_live(map, i)) continue;
    ScrDyn *pair = scr_dyn_new_arr();
    scr_dyn_arr_push(pair, scr_map_dyn_key(map, i));
    scr_dyn_arr_push(pair, scr_map_dyn_value(map, i));
    scr_dyn_arr_push(entries, pair);
  }
  scr_map_iter_exit(map);
  return entries;
}

ScrDyn *scr_dyn_native_map(ScrMap *value) {
  static const ScrDynHandleOps ops = {
      .cls = "Map",
      .retain = &scr_map_retain_v,
      .release = &scr_map_release_v,
      .invoke = &scr_native_map_invoke,
      .get = &scr_native_map_get,
      .set = &scr_weak_map_write,
      .iter_pack = &scr_native_map_pack,
      /* Entries live in internal slots: JSON.stringify writes {}, as Node. */
      .json_empty_object = true,
  };
  scr_dyn_handle_install(SCR_DYNH_MAP, &ops);
  return scr_dyn_new_handle(value, SCR_DYNH_MAP);
}

ScrDyn *scr_dyn_native_map_new(const ScrDyn *seed) {
  ScrDyn *entries = scr_dyn_map_seed_entries(seed);
  if (!entries) return NULL;
  ScrMap *map = scr_map_new(SCR_MAP_KEY_DYN, SCR_MAP_VAL_REF, &scr_map_dyn_map_ops);
  for (size_t i = 0; i < entries->v.arr.len; i++) {
    ScrDyn *entry = scr_dyn_map_seed_entry(entries->v.arr.items[i]);
    if (!entry) break;
    ScrDyn *key = scr_dyn_entry_read(entry, 0);
    ScrDyn *value = scr_exc_pending() ? NULL : scr_dyn_entry_read(entry, 1);
    scr_dyn_release(entry);
    if (value) scr_map_dyn_set(map, key, value, false);
    scr_dyn_release(key);
    scr_dyn_release(value);
    if (scr_exc_pending()) break;
  }
  scr_dyn_release(entries);
  ScrDyn *result = scr_exc_pending() ? NULL : scr_dyn_native_map(map);
  scr_map_release(map);
  return result;
}

bool scr_dyn_native_map_is(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_MAP;
}

ScrMap *scr_dyn_native_map_check(const ScrDyn *value, const ScrDynPath *path) {
  if (!scr_dyn_native_map_is(value)) { scr_dyn_check_fail(path, "Map", value); return NULL; }
  return scr_map_retain(value->v.handle.ptr);
}

bool scr_dyn_native_collection_is(const ScrDyn *value, int map, const char *type) {
  if (!(map ? scr_dyn_native_map_is(value) : scr_dyn_native_set_is(value))) return false;
  const ScrMap *storage = value->v.handle.ptr;
  // A generic checked view uses dyn_ops to box/unbox the same live storage.
  return !type || (storage->dyn_ops && strcmp(storage->dyn_ops->type, type) == 0);
}

ScrMap *scr_dyn_native_collection_check(const ScrDyn *value, int map, const char *type, const ScrDynPath *path) {
  if (!scr_dyn_native_collection_is(value, map, type)) {
    scr_dyn_check_fail(path, type ? type : map ? "Map" : "Set", value);
    return NULL;
  }
  return scr_map_retain(value->v.handle.ptr);
}

/* scr_dyn_to_string_method, passing `args` to a toString the receiver's
 * chain defines. */
static ScrStr *scr_dyn_to_string_method_args(const ScrDyn *d, const ScrStr *enc, const ScrStr *what,
    ScrDyn *const *args, size_t argc) {
  /* Object.create receivers must run their inherited formatter before the
   * default object tag; Effect shard keys use it to produce distinct hashes. */
  const bool object_method = d->kind == SCR_DYN_OBJ && scr_dyn_property_owner(d, "toString", 8);
  if (d->kind == SCR_DYN_FUNC || object_method) {
    ScrDyn *member = object_method ? scr_dyn_obj_read(d, "toString", 8) : scr_dyn_fn_get(d, "toString", 8);
    if (scr_exc_pending()) { scr_dyn_release(member); return NULL; }
    if (member && (object_method || member->kind != SCR_DYN_UNDEF)) {
      scr_dyn_this_push_dyn(d);
      ScrDyn *value = scr_dyn_call(member, args, argc, what->data);
      scr_dyn_this_pop();
      scr_dyn_release(member);
      if (!value) return NULL;
      ScrStr *result = value->kind == SCR_DYN_STR ? scr_str_retain(value->v.str) : NULL;
      if (!result) scr_dyn_check_fail(NULL, "string", value);
      scr_dyn_release(value);
      return result;
    }
    scr_dyn_release(member);
  }
  if (d->kind == SCR_DYN_OBJ && !scr_dyn_property_owner(d, "toString", 8) && !scr_dyn_has_object_prototype(d)) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_write(&b, what->data, what->len);
    scr_jb_puts(&b, " is not a function");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return scr_str_new("", 0);
  }
  return scr_dyn_to_string(d, enc);
}

ScrStr *scr_dyn_to_string_method(const ScrDyn *d, const ScrStr *enc, const ScrStr *what) {
  return scr_dyn_to_string_method_args(d, enc, what, NULL, 0);
}

ScrDyn *scr_dyn_freeze(ScrDyn *value) {
  if (scr_dyn_class_reflection_fence(value) || scr_dyn_error_prototype_fence(value)) return NULL;
  if (scr_dyn_class_integrity_fence(value, "Object.freeze")) return NULL;
  ScrDyn *table = scr_dyn_fn_integrity_table(value);
  if (!table) return scr_dyn_freeze_data(value);
  if (value->symbol_properties) scr_dyn_release(scr_dyn_freeze_data(value->symbol_properties));
  scr_dyn_release(scr_dyn_freeze_data(table));
  scr_dyn_release(table);
  return scr_dyn_retain(value);
}

ScrDyn *scr_dyn_freeze_data(ScrDyn *value) {
  if (scr_dyn_class_reflection_fence(value) || scr_dyn_error_prototype_fence(value)) return NULL;
  if (scr_dyn_class_integrity_fence(value, "Object.freeze")) return NULL;
  if (value->symbol_properties) scr_dyn_release(scr_dyn_freeze_data(value->symbol_properties));
  if (value->kind == SCR_DYN_ARR) {
    value->non_extensible = true;
    value->v.arr.sealed = true;
    value->v.arr.frozen = true;
    if (value->v.arr.properties) scr_dyn_release(scr_dyn_freeze_data(value->v.arr.properties));
    return scr_dyn_retain(value);
  }
  if (value->kind == SCR_DYN_OBJ && !value->copied_from_native) {
    value->non_extensible = true;
    for (size_t i = 0; i < value->v.obj.len; i++) {
      ScrDynEntry *entry = &value->v.obj.entries[i];
      entry->configurable = false;
      if (!entry->accessor) entry->writable = false;
    }
    return scr_dyn_retain(value);
  }
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NUM ||
      value->kind == SCR_DYN_BOOL || value->kind == SCR_DYN_STR || value->kind == SCR_DYN_BIGINT || value->kind == SCR_DYN_SYMBOL)
    return scr_dyn_retain(value);
  static const char message[] = "Object.freeze of this native value has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

bool scr_dyn_is_frozen(const ScrDyn *value) {
  if (scr_dyn_class_reflection_fence(value)) return false;
  bool answer;
  if (scr_dyn_typed_ref_view_answer((ScrDyn *)value, scr_dyn_is_frozen, &answer)) return answer;
  if (value->symbol_properties && !scr_dyn_is_frozen(value->symbol_properties)) return false;
  if (scr_dyn_plain_fn(value)) {
    ScrDyn *table = scr_dyn_fn_existing_table(value);
    answer = table && scr_dyn_is_frozen(table);
    scr_dyn_release(table);
    return answer;
  }
  if (value->kind == SCR_DYN_ARR)
    return scr_dyn_is_sealed(value) && (value->v.arr.len == 0 || value->v.arr.frozen) &&
      (!value->v.arr.properties || scr_dyn_is_frozen(value->v.arr.properties));
  if (value->kind == SCR_DYN_OBJ && !value->copied_from_native) {
    if (!value->non_extensible) return false;
    for (size_t i = 0; i < value->v.obj.len; i++) {
      const ScrDynEntry *entry = &value->v.obj.entries[i];
      if (entry->configurable || (!entry->accessor && entry->writable)) return false;
    }
    return true;
  }
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NUM ||
      value->kind == SCR_DYN_BOOL || value->kind == SCR_DYN_STR || value->kind == SCR_DYN_BIGINT || value->kind == SCR_DYN_SYMBOL) return true;
  static const char message[] = "Object.isFrozen of this native value has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return false;
}

double scr_buffer_byte_length_dyn(ScrDyn *value, ScrStr *encoding) {
  if (value->kind == SCR_DYN_STR) return scr_bytes_byte_length_str(value->v.str, encoding);
  if (value->kind == SCR_DYN_BYTES) return scr_bytes_byte_len(value->v.bytes);
  if (scr_array_buffer_is(value)) return scr_bytes_byte_len(value->v.handle.ptr);
  static const char message[] = "The string argument must be of type string or an instance of Buffer or ArrayBuffer";
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
  return 0;
}

/* toString(radix) with any radix value: undefined means 10, anything else
 * converts with ToNumber (which can run program code) first. */
ScrStr *scr_num_to_string_radix(double value, const ScrDyn *argument) {
  double requested = 10;
  if (argument && argument->kind != SCR_DYN_UNDEF &&
      !scr_dyn_number_coerce_js(argument, &requested)) return NULL;
  return scr_num_to_string_radix_f64(value, requested);
}

ScrDyn *scr_caught_to_dyn(const ScrCaught *c) {
  switch (c->kind) {
  case SCR_EXC_F64: return scr_dyn_new_num(c->f64);
  case SCR_EXC_BOOL: return scr_dyn_new_bool(c->b);
  case SCR_EXC_STR: return scr_dyn_new_str((ScrStr *)c->payload);
  case SCR_EXC_REF:
  case SCR_EXC_PRIMITIVE_REF:
    if (c->retain_fn == scr_dyn_retain_v) return scr_dyn_retain((ScrDyn *)c->payload);
    return scr_dyn_new_obj();
  case SCR_EXC_OBJ:
    if (scr_error_is(c->payload)) return scr_dyn_from_error((const ScrError *)c->payload);
    return scr_dyn_new_obj();
  default:
    return scr_dyn_new_obj();
  }
}

/* ── class instance attributes ───────────────────────────────────────────
 * A hierarchy passed to Object.freeze, Object.seal, Object.preventExtensions
 * or Object.defineProperty keeps an integrity state per instance and an
 * attribute word per redefined field (CLASS_* and FIELD_* bits in the
 * compiler's ir.ts). The checked view of an instance carries them, so
 * reflection over the view answers as Node does. */
enum {
  SCR_CLASS_NOT_EXTENSIBLE = 1,
  SCR_CLASS_SEALED = 2,
  SCR_CLASS_FROZEN = 4,
  SCR_FIELD_NOT_WRITABLE = 1,
  SCR_FIELD_NOT_ENUMERABLE = 2,
  SCR_FIELD_NOT_CONFIGURABLE = 4,
};

void scr_dyn_class_field_attributes(ScrDyn *view, ScrStr *name, double bits) {
  unsigned b = (unsigned)bits;
  if (b == 0 || view->kind != SCR_DYN_OBJ) return;
  ScrDynEntry *entry = scr_dyn_entry(view, name);
  if (!entry) return;
  if (b & SCR_FIELD_NOT_WRITABLE) entry->writable = false;
  if (b & SCR_FIELD_NOT_ENUMERABLE) entry->enumerable = false;
  if (b & SCR_FIELD_NOT_CONFIGURABLE) entry->configurable = false;
}

void scr_dyn_class_view_attributes(ScrDyn *view, double bits) {
  unsigned b = (unsigned)bits;
  if (b == 0 || view->kind != SCR_DYN_OBJ) return;
  view->non_extensible = true;
  for (size_t i = 0; i < view->v.obj.len; i++) {
    ScrDynEntry *entry = &view->v.obj.entries[i];
    if (b & (SCR_CLASS_SEALED | SCR_CLASS_FROZEN)) entry->configurable = false;
    if ((b & SCR_CLASS_FROZEN) && !entry->accessor) entry->writable = false;
  }
}

/* Object.defineProperty on a declared class field. The descriptor applies to
 * a one-property object holding the field's current value and attributes,
 * so validation and errors match ordinary objects. Answers that object (+1),
 * or NULL with a pending exception. */
ScrDyn *scr_class_define_field(ScrDyn *current, double field_bits, double object_bits, ScrStr *name,
                               ScrDyn *descriptor) {
  unsigned f = (unsigned)field_bits, o = (unsigned)object_bits;
  ScrDyn *holder = scr_dyn_new_obj();
  scr_dyn_obj_set(holder, name->data, name->len, scr_dyn_retain(current));
  ScrDynEntry *entry = scr_dyn_entry(holder, name);
  entry->writable = !(f & SCR_FIELD_NOT_WRITABLE) && !(o & SCR_CLASS_FROZEN);
  entry->enumerable = !(f & SCR_FIELD_NOT_ENUMERABLE);
  entry->configurable =
      !(f & SCR_FIELD_NOT_CONFIGURABLE) && !(o & (SCR_CLASS_SEALED | SCR_CLASS_FROZEN));
  ScrDyn *key = scr_dyn_new_str(name);
  ScrDyn *defined = scr_dyn_define_property(holder, key, descriptor);
  scr_dyn_release(key);
  if (!defined) {
    scr_dyn_release(holder);
    return NULL;
  }
  scr_dyn_release(defined);
  entry = scr_dyn_entry(holder, name);
  if (entry->accessor) {
    scr_dyn_release(holder);
    ScrJsonBuf buffer;
    scr_jb_init(&buffer);
    scr_jb_puts(&buffer, "Object.defineProperty with an accessor descriptor for the declared field '");
    scr_jb_write(&buffer, name->data, name->len);
    scr_jb_puts(&buffer, "' is not supported yet");
    ScrStr *message = scr_jb_finish(&buffer);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
    scr_str_release(message);
    return NULL;
  }
  return holder;
}

/* The field attribute word of a scr_class_define_field result. */
double scr_class_defined_bits(ScrDyn *holder, ScrStr *name) {
  const ScrDynEntry *entry = scr_dyn_entry(holder, name);
  unsigned bits = 0;
  if (!entry->writable) bits |= SCR_FIELD_NOT_WRITABLE;
  if (!entry->enumerable) bits |= SCR_FIELD_NOT_ENUMERABLE;
  if (!entry->configurable) bits |= SCR_FIELD_NOT_CONFIGURABLE;
  return (double)bits;
}

/* The value a scr_class_define_field result holds (+1). */
ScrDyn *scr_class_defined_value(ScrDyn *holder, ScrStr *name) {
  return scr_dyn_retain(scr_dyn_entry(holder, name)->value);
}

/* Whether a property descriptor names a value (Node's ToPropertyDescriptor
 * reads `value` with [[HasProperty]]). */
bool scr_class_descriptor_has_value(ScrDyn *descriptor) {
  if (descriptor->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(descriptor);
    bool has = !scr_exc_pending() && scr_class_descriptor_has_value(view);
    scr_dyn_release(view);
    return has;
  }
  return descriptor->kind == SCR_DYN_OBJ && scr_dyn_obj_get(descriptor, "value", 5) != NULL;
}

/* Node's TypeError for a write to a read-only field of a class instance. */
void scr_class_throw_read_only(ScrStr *field, ScrStr *owner) {
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  scr_jb_puts(&buffer, "Cannot assign to read only property '");
  scr_jb_write(&buffer, field->data, field->len);
  scr_jb_puts(&buffer, "' of object '#<");
  scr_jb_write(&buffer, owner->data, owner->len);
  scr_jb_puts(&buffer, ">'");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&buffer));
}

/* Node's TypeError for a class field initializer on a non-extensible
 * instance (a base constructor froze or sealed `this`). */
void scr_class_throw_not_extensible(ScrStr *field) {
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  scr_jb_puts(&buffer, "Cannot define property ");
  scr_jb_write(&buffer, field->data, field->len);
  scr_jb_puts(&buffer, ", object is not extensible");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&buffer));
}

/* ── compiled generators through untyped values ─────────────────────── */

static SCR_TL ScrDyn *scr_generator_next_getter;
static SCR_TL ScrDyn *scr_generator_return_getter;
/* Set with the getters, so only programs that register them link the
 * iterator helpers through these paths. External, so the compiler keeps
 * the calls through them indirect. */
SCR_TL ScrDyn *(*scr_generator_member_hook)(const ScrDyn *, const char *, size_t) = NULL;
SCR_TL bool (*scr_dyn_generator_helper_hook)(ScrDyn *, const char *, ScrDyn *const *, size_t,
                                             ScrDyn **) = NULL;
static ScrDyn *scr_generator_member(const ScrDyn *capsule, const char *key, size_t len);
static bool scr_generator_helper_invoke(ScrDyn *recv, const char *method, ScrDyn *const *args,
                                        size_t argc, ScrDyn **out);

static void scr_generator_members_cleanup(void) {
  scr_dyn_release(scr_generator_next_getter);
  scr_dyn_release(scr_generator_return_getter);
  scr_generator_next_getter = NULL;
  scr_generator_return_getter = NULL;
  scr_generator_member_hook = NULL;
  scr_dyn_generator_helper_hook = NULL;
}

void scr_dyn_set_generator_members(ScrDyn *next_getter, ScrDyn *return_getter) {
  if (!scr_generator_next_getter) scr_atexit(scr_generator_members_cleanup);
  scr_dyn_release(scr_generator_next_getter);
  scr_dyn_release(scr_generator_return_getter);
  scr_generator_next_getter = scr_dyn_retain(next_getter);
  scr_generator_return_getter = scr_dyn_retain(return_getter);
  scr_generator_member_hook = &scr_generator_member;
  scr_dyn_generator_helper_hook = &scr_generator_helper_invoke;
}

static bool scr_dyn_sync_generator(const ScrDyn *value) {
  return scr_dyn_generator(value) && value->v.typed_ref.type_key[0] == 'g';
}

/* A synchronous generator capsule's next or return method (+1), read
 * through the program's registered getters. NULL for other keys. */
static ScrDyn *scr_generator_member(const ScrDyn *capsule, const char *key, size_t len) {
  ScrDyn *getter = len == 4 && !memcmp(key, "next", 4) ? scr_generator_next_getter
    : len == 6 && !memcmp(key, "return", 6) ? scr_generator_return_getter : NULL;
  if (!getter) return NULL;
  ScrDyn *args[1] = { (ScrDyn *)capsule };
  return scr_dyn_call(getter, args, 1, "next");
}

static bool scr_generator_helper_invoke(ScrDyn *recv, const char *method, ScrDyn *const *args,
                                        size_t argc, ScrDyn **out) {
  if (!scr_dyn_sync_generator(recv)) return false;
  int index = scr_ih_method_index(method, strlen(method));
  if (index < 0) return false;
  *out = scr_iterator_helper_method(recv, index, args, argc);
  return true;
}

ScrDyn *scr_dyn_iterator_helper_method(const ScrStr *name) {
  int index = scr_ih_method_index(name->data, name->len);
  return index >= 0 ? scr_ih_method_function(index) : scr_dyn_retain(scr_dyn_undefined());
}

/* Destructuring over an iterable the pack walk cannot list (a compiled
 * generator, an iterator or iterator helper, a Map or Set): GetIterator,
 * then the first `n` values through the iterator protocol, or every value
 * when `all`, into a fresh array. Positions past the end read undefined,
 * and an iterator with values left closes. `spell` is the compile-time
 * not-iterable wording, or NULL. +1, or NULL with the error pending. */
static ScrDyn *scr_dyn_iter_steps(const ScrDyn *src, const ScrStr *spell, size_t n, bool all) {
  ScrDyn *iterator = scr_dyn_iterator(src, spell);
  if (!iterator) return NULL;
  ScrDyn *next = scr_iterator_member(iterator, "next", 4);
  if (!next) {
    scr_dyn_release(iterator);
    return NULL;
  }
  ScrDyn *out = scr_dyn_new_arr();
  bool done = false;
  for (size_t i = 0; all ? !done : i < n; i++) {
    ScrDyn *value = done ? scr_dyn_retain(scr_dyn_undefined()) : scr_ih_step(iterator, next, &done);
    if (!value) goto fail;
    if (all && done) scr_dyn_release(value);
    else scr_dyn_arr_push(out, value);
  }
  if (!done && !scr_ih_close(iterator, false)) goto fail;
  scr_dyn_release(next);
  scr_dyn_release(iterator);
  return out;
fail:
  scr_dyn_release(out);
  scr_dyn_release(next);
  scr_dyn_release(iterator);
  return NULL;
}

ScrDyn *scr_dyn_destructure_rest(const ScrDyn *src, const ScrStr *msg) {
  bool packs = src->kind == SCR_DYN_ARR || src->kind == SCR_DYN_STR || src->kind == SCR_DYN_BYTES ||
    (src->kind == SCR_DYN_HANDLE && scr_dyn_handle_ops_of(src)->iter_pack) ||
    (src->kind == SCR_DYN_TYPED_REF && !scr_dyn_iterates_by_protocol(src));
  return packs ? scr_dyn_iter_pack(src, msg) : scr_dyn_iter_steps(src, msg, 0, true);
}

ScrDyn *scr_dyn_iter_take(const ScrDyn *src, size_t n, const char *spell) {
  ScrStr *spelling = spell && *spell ? scr_str_new(spell, strlen(spell)) : NULL;
  ScrDyn *out = scr_dyn_iter_steps(src, spelling, n, false);
  scr_str_release(spelling);
  return out;
}

bool scr_dyn_iterates_by_protocol(const ScrDyn *value) {
  return scr_dyn_sync_generator(value);
}

#ifdef SCR_JS_TIER
/* ── dynamic-tier primitives (scr_dyn.h, SCR_JS_TIER) ─────────────────── */

const ScrDyn *scr_dyn_tier_object_prototype(void) { return scr_builtin_object_prototype; }

char *scr_dyn_tier_key_copy(const char *key, size_t key_len) { return scr_dyn_key_copy(key, key_len); }

void scr_dyn_tier_key_release(char *key, size_t key_len) { scr_dyn_key_release(key, key_len); }

void scr_dyn_tier_append(ScrDyn *obj, char *key, size_t key_len, ScrDyn *value) {
  scr_dyn_obj_append_shared(obj, key, key_len, value);
}
#endif

/* The program's writes onto compiled errors (scr_error.h). Kept at the end
 * of the file, after every function they call, so the rest of the unit
 * emits in its existing order. */

/* `err.code = s` from the program (an Error asserted to carry `code`):
 * the same slot every coded throw stamps, so reads and `'code' in err`
 * observe the write. Borrows both. */
void scr_error_set_code_value(ScrError *e, ScrStr *code) {
  scr_str_release(e->code);
  e->code = scr_str_retain(code);
  /* An error that already crossed into the checked-dynamic tree renders
   * and reads through that node, so the write lands there too. */
  ScrDyn *view = scr_errdyn_view_of(e);
  if (view != NULL && view->kind == SCR_DYN_OBJ) scr_dyn_obj_set(view, "code", 4, scr_dyn_new_str(code));
}

void scr_error_set_code_dyn(ScrError *e, ScrDyn *value) {
  if (value != NULL && value->kind == SCR_DYN_STR) {
    scr_error_set_code_value(e, value->v.str);
    return;
  }
  scr_str_release(e->code);
  e->code = NULL;
  ScrDyn *view = scr_dyn_from_error(e);
  ScrStr *key = scr_str_new("code", 4);
  scr_dyn_key_set(view, key, value);
  scr_str_release(key);
  scr_dyn_release(view);
}

/* Object.assign(err, ...sources) onto a compiled error: each source's own
 * members land on the error's checked-dynamic node, then the slots that
 * typed reads use (name, message, stack, cause, code) take the result.
 * Borrows both; throws what the copy throws (a nullish source is skipped,
 * as in JS). */
void scr_error_assign_dyn(ScrError *e, const ScrDyn *sources) {
  ScrDyn *view = scr_dyn_from_error(e);
  ScrDyn *r = scr_dyn_assign_all(view, sources);
  if (r != NULL) {
    scr_dyn_release(r);
    if (view->kind == SCR_DYN_OBJ) {
      scr_error_commit_dyn(e, view);
      if (!scr_exc_pending()) {
        ScrDyn *code = scr_dyn_obj_get(view, "code", 4);
        ScrStr *next = code != NULL && code->kind == SCR_DYN_STR ? scr_str_retain(code->v.str) : NULL;
        scr_str_release(e->code);
        e->code = next;
      }
    }
  }
  scr_dyn_release(view);
}

/* `'code' in err`: the code slot holds a string, or the error has an own
 * `code` property with another value (`err.code = undefined`), which lives
 * on its checked-dynamic node. Borrows; never throws. */
bool scr_error_has_code(ScrError *e) {
  if (e->code != NULL) return true;
  const ScrDyn *view = scr_errdyn_view_of(e);
  if (view == NULL) return false;
  ScrStr *key = scr_str_new("code", 4);
  bool own = scr_dyn_has_own(view, key);
  scr_str_release(key);
  return own;
}

/* `key in err` for a key no compiled class of the receiver declares: an own
 * property set at runtime, which lives on the error's checked-dynamic node
 * (that node exists once anything reflected or wrote through it), or a
 * member of Object.prototype. Borrows both; never throws. */
/* Whether the error's own `name` or `message` (the key) is an accessor a
 * reflective definition installed on its checked-dynamic node (the slot
 * then reads as absent): typed reads call its getter and typed writes its
 * setter through that node. A class view keeps the accessor in its last
 * materialized object. Borrows both; never throws. */
static ScrDynEntry *scr_error_accessor_entry(ScrError *e, const ScrStr *key) {
  const ScrDyn *view = scr_errdyn_view_of(e);
  if (view != NULL && view->kind == SCR_DYN_TYPED_REF) view = view->v.typed_ref.materialized;
  if (view == NULL || view->kind != SCR_DYN_OBJ) return NULL;
  ScrDynEntry *entry = scr_dyn_find_entry(view, key->data, key->len);
  return entry != NULL && entry->accessor ? entry : NULL;
}

bool scr_error_own_accessor(ScrError *e, const ScrStr *key) { return scr_error_accessor_entry(e, key) != NULL; }

/* A typed read of that accessor: its getter called on the error's node
 * (the undefined value without one). Owned result, or NULL with the
 * getter's exception pending. */
ScrDyn *scr_error_accessor_get(ScrError *e, const ScrStr *key) {
  ScrDynEntry *entry = scr_error_accessor_entry(e, key);
  if (entry == NULL || entry->getter == NULL) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *getter = scr_dyn_retain(entry->getter);
  ScrDyn *receiver = scr_dyn_from_error(e);
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(getter, NULL, 0, "getter");
  scr_dyn_this_pop();
  scr_dyn_release(receiver);
  scr_dyn_release(getter);
  return result;
}

/* A typed write of that accessor: its setter called on the error's node
 * with the value, or V8's strict-mode TypeError without one. Borrows all;
 * the setter's exception stays pending. */
void scr_error_accessor_set(ScrError *e, const ScrStr *key, ScrDyn *value) {
  ScrDynEntry *entry = scr_error_accessor_entry(e, key);
  if (entry == NULL) return;
  if (entry->setter == NULL) {
    char message[256];
    int n = snprintf(message, sizeof message, "Cannot set property %.*s of %.*s which has only a getter",
                     (int)key->len, key->data, (int)e->name->len, e->name->data);
    scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)n < sizeof message ? (size_t)n : sizeof message - 1);
    return;
  }
  ScrDyn *setter = scr_dyn_retain(entry->setter);
  ScrDyn *receiver = scr_dyn_from_error(e);
  ScrDyn *args[1] = {value};
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(setter, args, 1, "setter");
  scr_dyn_this_pop();
  scr_dyn_release(result);
  scr_dyn_release(receiver);
  scr_dyn_release(setter);
}

bool scr_error_has_key(ScrError *e, const ScrStr *key) {
  const ScrDyn *view = scr_errdyn_view_of(e);
  if (view != NULL && view->kind == SCR_DYN_OBJ && scr_dyn_find_entry(view, key->data, key->len) != NULL)
    return true;
  return scr_dyn_object_proto_name(key);
}

/* ── declaration-typed boundary: in-place capsules ─────────────────────
 * scr_decl_adopt.c (linked only into programs with boundary casts) turns a
 * shared source node into a live capsule of the native value built from
 * it. The node's old payload moves to a scratch node released here; the
 * node's weak-collection entries move to the capsule's native identity.
 * Nothing else in the runtime calls this. */
static bool scr_dyn_decl_rekey(ScrDyn *node, void *ptr) {
  bool moved = false;
  if (!scr_weak_observing) return false;
  for (;;) {
    ScrWeakEntry **slot = &scr_weak_entries[scr_weak_bucket(node)];
    while (*slot && !((*slot)->key == (void *)node && (*slot)->kind == 0)) slot = &(*slot)->all_next;
    ScrWeakEntry *entry = *slot;
    if (!entry) return moved;
    *slot = entry->all_next;
    entry->key = ptr;
    entry->kind = 32;
    ScrWeakEntry **head = &scr_weak_entries[scr_weak_bucket(ptr)];
    entry->all_next = *head;
    *head = entry;
    moved = true;
  }
}

void scr_dyn_decl_become(ScrDyn *n, const ScrDyn *capsule);
void scr_dyn_decl_become(ScrDyn *n, const ScrDyn *capsule) {
  ScrDynRegion *region = scr_dyn_region_of(n);
  if (region) region->intact = false;
  ScrDyn *old = scr_dyn_alloc(SCR_DYN_NULL);
  old->kind = n->kind;
  old->buffer = n->buffer;
  old->null_proto = n->null_proto;
  old->copied_from_native = n->copied_from_native;
  old->non_extensible = n->non_extensible;
  old->v = n->v;
  old->prototype = n->prototype;
  old->symbol_properties = n->symbol_properties;
  old->symbol_keys = n->symbol_keys;
  n->kind = SCR_DYN_TYPED_REF;
  n->buffer = false;
  n->null_proto = false;
  n->copied_from_native = false;
  n->non_extensible = false;
  n->prototype = NULL;
  n->symbol_properties = NULL;
  n->symbol_keys = NULL;
  memset(&n->v, 0, sizeof n->v);
  n->v.typed_ref = capsule->v.typed_ref;
  n->v.typed_ref.ptr = capsule->v.typed_ref.retain(capsule->v.typed_ref.ptr);
  n->v.typed_ref.materialized = NULL;
  n->v.typed_ref.casts = NULL;
  if (scr_dyn_decl_rekey(n, n->v.typed_ref.ptr)) n->v.typed_ref.observed = true;
  if (n->v.typed_ref.type_key_len >= 7 && memcmp(n->v.typed_ref.type_key, "record:", 7) == 0) {
    ScrDyn *view = scr_record_source_view(n->v.typed_ref.ptr);
    if (view) n->v.typed_ref.materialized = scr_dyn_retain(view);
  }
  scr_dyn_release(old);
}

/* A compiled class's field creation in its instance's property bag (the
 * compiler's trackClassFieldCreation): an ordinary extensible bag gains
 * `key` as a writable, enumerable, configurable data property when it
 * does not have it yet. Answers false, changing nothing, for any other bag,
 * whose creation takes the general defineProperty path. Calls only
 * exported functions. */
bool scr_dyn_bag_create_field(ScrDyn *bag, const ScrStr *key) {
  if (!bag || bag->kind != SCR_DYN_OBJ || bag->non_extensible || bag->v.obj.source_access)
    return false;
  if (scr_dyn_obj_get(bag, key->data, key->len)) return true;
  scr_dyn_obj_set(bag, key->data, key->len, scr_dyn_retain(scr_dyn_undefined()));
  return true;
}

/* Whether a value is a capsule of a compiled class instance (its type key
 * names an object type): the class tables' fast exit for every other value,
 * including record and array capsules. Calls only libc. */
bool scr_dyn_is_class_capsule(const ScrDyn *d) {
  return d && d->kind == SCR_DYN_TYPED_REF && d->v.typed_ref.type_key_len > 7 &&
         memcmp(d->v.typed_ref.type_key, "object:", 7) == 0;
}
