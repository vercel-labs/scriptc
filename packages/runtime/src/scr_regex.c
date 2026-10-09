/* Regular expressions (see scr_runtime.h for the API contract).
 *
 * The engine is quickjs-ng's libregexp — the exact ECMAScript regex
 * implementation the dynamic island uses — compiled standalone (libregexp.c
 * + libunicode.c; cutils is header-only) and linked ONLY into programs that
 * contain a regex literal. This file is likewise regex-only: it is NOT in
 * the always-compiled runtime source list (see native-toolchain.ts), so regex-free
 * programs keep a byte-identical link line.
 *
 * - Each literal evaluation creates a refcounted regex with fresh state.
 *   Instances share an immortal template per (pattern, flags) pair. The
 *   template compiles and caches bytecode LAZILY on first use; a pattern
 *   lre_compile rejects aborts with a clear
 *   message (Node throws SyntaxError at parse time — documented divergence;
 *   rare, since tsc's parser has already syntax-checked the literal).
 * - ASCII subjects borrow their existing bytes; other subjects use a
 *   per-call UTF-16 conversion (exec/test keep the last long subject's
 *   decoding, see scr_regex_input_init_cached). Both engine representations report UTF-16
 *   code-unit indices, matching .length/slice/charCodeAt.
 * - Match loops mirror quickjs.c's own (JS_RegExpDelete /
 *   js_regexp_Symbol_replace): capture buffers are sized by
 *   lre_get_alloc_count (NOT capture_count*2 — the executor writes
 *   temporary registers past the capture slots), unmatched groups leave
 *   NULL pointers, and zero-length matches advance by one code unit — or by
 *   a whole surrogate pair under /u (AdvanceStringIndex).
 * - Global and sticky exec/test use numeric lastIndex and update or reset
 *   it after matching. String matching/replacement follows its own state
 *   rules; matchAll, search, and split preserve the original regex state.
 * - One-byte (ASCII) subjects run a native matcher translated from the same
 *   bytecode when the pattern stays inside its subset (scr_regex_native.h);
 *   it reports lre_exec's exact captures, so every loop below is shared.
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "libregexp.h"
#include "scr_regex_native.h"

static void scr_regex_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* ── libregexp host hooks ─────────────────────────────────────────────
 * Static builds provide the minimal hooks (malloc-backed, no interrupt,
 * no stack guard — patterns come from source literals and the executor's
 * backtrack stack is heap-allocated). --dynamic builds MUST NOT define
 * them: the engine archive's quickjs.c already does, with the opaque
 * interpreted as the island's JSContext — so under SCR_DYNAMIC every
 * lre_compile/lre_exec call here passes the island's context instead
 * (forcing lazy engine init on first regex use).
 */
#ifdef SCR_DYNAMIC
static void *lre_opaque(void) { return scr_island_lre_opaque(); }
#else
static void *lre_opaque(void) { return NULL; }

bool lre_check_stack_overflow(void *opaque, size_t alloca_size) {
  (void)opaque;
  (void)alloca_size;
  return false;
}

int lre_check_timeout(void *opaque) {
  (void)opaque;
  return 0;
}

void *lre_realloc(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  if (size == 0) {
    free(ptr);
    return NULL;
  }
  return realloc(ptr, size);
}
#endif /* SCR_DYNAMIC */

/* ── lazy compilation ─────────────────────────────────────────────────
 * Compiled bytecodes are cached on the immortal ScrRegex statics and freed
 * at exit through lre_realloc (registered AFTER the first compile, so under
 * --dynamic it runs before the LIFO-later island teardown and the island's
 * allocation audit sees the bytecode gone).
 */

static SCR_TL ScrRegex **scr_compiled = NULL;
static SCR_TL size_t scr_compiled_len = 0, scr_compiled_cap = 0;

static void scr_regex_free_bytecodes(void) {
  for (size_t i = 0; i < scr_compiled_len; i++) {
    lre_realloc(lre_opaque(), scr_compiled[i]->bc, 0);
    scr_compiled[i]->bc = NULL;
    scr_re_native_free(scr_compiled[i]->native);
    scr_compiled[i]->native = NULL;
  }
  free(scr_compiled);
  scr_compiled = NULL;
  scr_compiled_len = scr_compiled_cap = 0;
}

static void scr_note_compiled(ScrRegex *re) {
  if (scr_compiled_len == scr_compiled_cap) {
    scr_compiled_cap = scr_compiled_cap ? scr_compiled_cap * 2 : 8;
    scr_compiled = realloc(scr_compiled, scr_compiled_cap * sizeof *scr_compiled);
    if (!scr_compiled) scr_regex_oom();
  }
  if (scr_compiled_len == 0) scr_atexit(scr_regex_free_bytecodes);
  scr_compiled[scr_compiled_len++] = re;
}

/* Flags string → LRE_FLAG_* mask. The frontend fences the flag alphabet to
 * g/i/m/s/u/y, so anything else here is a compiler bug. */
static int scr_lre_flags(const ScrStr *flags) {
  int mask = 0;
  for (size_t i = 0; i < flags->len; i++) {
    switch (flags->data[i]) {
      case 'g': mask |= LRE_FLAG_GLOBAL; break;
      case 'i': mask |= LRE_FLAG_IGNORECASE; break;
      case 'm': mask |= LRE_FLAG_MULTILINE; break;
      case 's': mask |= LRE_FLAG_DOTALL; break;
      case 'u': mask |= LRE_FLAG_UNICODE; break;
      case 'y': mask |= LRE_FLAG_STICKY; break;
      default:
        scr_trap_fmt("scriptc: internal error: unexpected regex flag '%c'\n",
                     flags->data[i]);
    }
  }
  return mask;
}

/* Without /u, JS treats the pattern itself as UTF-16 code units: an astral
 * character in the pattern SOURCE is two separate surrogate units.
 * libregexp expects that spelled as CESU-8 (quickjs feeds it
 * JS_ToCStringLen2(cesu8=true) for non-unicode patterns), so a non-/u
 * pattern containing a 4-byte UTF-8 sequence is re-encoded: each astral
 * code point becomes two 3-byte surrogate encodings. Returns NULL when the
 * pattern needs no re-encoding (the common case — no copy). */
static char *scr_pattern_cesu8(const ScrStr *src, size_t *plen) {
  bool has_astral = false;
  for (size_t i = 0; i < src->len; i++) {
    if ((unsigned char)src->data[i] >= 0xF0) {
      has_astral = true;
      break;
    }
  }
  if (!has_astral) return NULL;
  char *out = malloc(src->len / 2 * 3 + src->len + 1); /* 4 bytes → 6 worst case */
  if (!out) scr_regex_oom();
  size_t o = 0;
  for (size_t i = 0; i < src->len;) {
    unsigned char c = (unsigned char)src->data[i];
    if (c < 0xF0) {
      out[o++] = src->data[i++];
      continue;
    }
    uint32_t cp = ((uint32_t)(c & 0x07) << 18) |
                  ((uint32_t)((unsigned char)src->data[i + 1] & 0x3F) << 12) |
                  ((uint32_t)((unsigned char)src->data[i + 2] & 0x3F) << 6) |
                  ((unsigned char)src->data[i + 3] & 0x3F);
    i += 4;
    uint32_t hi = 0xD800 + ((cp - 0x10000) >> 10);
    uint32_t lo = 0xDC00 + ((cp - 0x10000) & 0x3FF);
    out[o++] = (char)(0xE0 | (hi >> 12));
    out[o++] = (char)(0x80 | ((hi >> 6) & 0x3F));
    out[o++] = (char)(0x80 | (hi & 0x3F));
    out[o++] = (char)(0xE0 | (lo >> 12));
    out[o++] = (char)(0x80 | ((lo >> 6) & 0x3F));
    out[o++] = (char)(0x80 | (lo & 0x3F));
  }
  /* lre_compile needs the NUL sentinel in ADDITION to buf_len: quickjs
   * always hands it NUL-terminated C strings, and the parser reads *p
   * against '\0' at end-of-pattern (found the hard way — an unterminated
   * buffer reports "extraneous characters at the end"). */
  out[o] = '\0';
  *plen = o;
  return out;
}

/* The compiled bytecode, compiling (and caching) on first use. */
static uint8_t *scr_regex_bc(ScrRegex *re) {
  if (re->bc) return re->bc;
  if (re->literal) {
    re->bc = scr_regex_bc(re->literal);
    re->native = re->literal->native;
    return re->bc;
  }
  int flags = scr_lre_flags(re->flags);
  const char *pat = re->source->data;
  size_t pat_len = re->source->len;
  char *cesu = NULL;
  if (!(flags & LRE_FLAG_UNICODE)) {
    cesu = scr_pattern_cesu8(re->source, &pat_len);
    if (cesu) pat = cesu;
  }
  char error_msg[64];
  int bc_len;
  uint8_t *bc = lre_compile(&bc_len, error_msg, sizeof error_msg, pat, pat_len,
                            flags, lre_opaque());
  free(cesu);
  if (!bc) {
    /* Node rejects the pattern with a SyntaxError at PARSE time; scriptc
     * compiles lazily, so the failure lands here (documented divergence —
     * tsc's parser has already caught plain syntax errors, so this is
     * rare). */
    fflush(stdout);
    scr_trap_fmt("scriptc: SyntaxError: Invalid regular expression: /%s/%s: %s\n",
                 re->source->data, re->flags->data, error_msg);
  }
  re->bc = bc;
  re->native = scr_re_native_build(bc);
  scr_note_compiled(re);
  return bc;
}

/* ── RC entry points ──────────────────────────────────────────────────
 * Literal instances borrow bytecode from their immortal templates;
 * constructed regexes own their compiled bytecode. */

void scr_regex_release(ScrRegex *re) {
  if (!re || re->rc == SIZE_MAX) return;
  if (--re->rc == 0) {
    scr_str_release(re->source);
    scr_str_release(re->flags);
    if (re->bc && !re->literal) {
      lre_realloc(lre_opaque(), re->bc, 0);
      scr_re_native_free(re->native);
    }
    free(re);
  }
}

void *scr_regex_retain_v(void *re) { return scr_regex_retain(re); }
void scr_regex_release_v(void *re) { scr_regex_release(re); }

ScrRegex *scr_regex_literal(ScrRegex *literal) {
  ScrRegex *re = calloc(1, sizeof *re);
  if (!re) scr_regex_oom();
  re->rc = 1;
  re->source = scr_str_retain(literal->source);
  re->flags = scr_str_retain(literal->flags);
  re->literal = literal;
  return re;
}

double scr_regex_last_index(ScrRegex *re) { return re->last_index; }

ScrStr *scr_regex_source(ScrRegex *re) { return scr_str_retain(re->source); }
ScrStr *scr_regex_flags(ScrRegex *re) { return scr_str_retain(re->flags); }
ScrStr *scr_regex_to_string(ScrRegex *re) {
  const char *source = re->source->data;
  size_t len = re->source->len;
  size_t escaped = 0;
  bool in_class = false;
  bool quoted = false;
  for (size_t i = 0; i < len; i++) {
    char c = source[i];
    bool line_separator = i + 2 < len && (unsigned char)c == 0xE2 &&
                          (unsigned char)source[i + 1] == 0x80 &&
                          ((unsigned char)source[i + 2] == 0xA8 ||
                           (unsigned char)source[i + 2] == 0xA9);
    if (!quoted && c == '/' && !in_class) escaped++;
    if (!quoted && (c == '\n' || c == '\r')) escaped++;
    if (!quoted && line_separator) escaped += 3;
    if (!quoted && c == '[') in_class = true;
    else if (!quoted && c == ']') in_class = false;
    if (c == '\\') quoted = !quoted;
    else quoted = false;
  }
  size_t total = 2 + len + escaped + re->flags->len;
  char *buf = malloc(total + 1);
  if (!buf) scr_regex_oom();
  size_t pos = 0;
  buf[pos++] = '/';
  in_class = false;
  quoted = false;
  for (size_t i = 0; i < len; i++) {
    char c = source[i];
    bool line_separator = i + 2 < len && (unsigned char)c == 0xE2 &&
                          (unsigned char)source[i + 1] == 0x80 &&
                          ((unsigned char)source[i + 2] == 0xA8 ||
                           (unsigned char)source[i + 2] == 0xA9);
    if (!quoted && c == '/' && !in_class) buf[pos++] = '\\';
    if (!quoted && line_separator) {
      buf[pos++] = '\\';
      buf[pos++] = 'u';
      buf[pos++] = '2';
      buf[pos++] = '0';
      buf[pos++] = '2';
      buf[pos++] = source[i + 2] == (char)0xA8 ? '8' : '9';
      i += 2;
      quoted = false;
      continue;
    }
    if (!quoted && (c == '\n' || c == '\r')) {
      buf[pos++] = '\\';
      c = c == '\n' ? 'n' : 'r';
    }
    buf[pos++] = c;
    if (!quoted && c == '[') in_class = true;
    else if (!quoted && c == ']') in_class = false;
    if (source[i] == '\\') quoted = !quoted;
    else quoted = false;
  }
  buf[pos++] = '/';
  memcpy(buf + pos, re->flags->data, re->flags->len);
  pos += re->flags->len;
  buf[pos] = '\0';
  ScrStr *out = scr_str_new(buf, pos);
  free(buf);
  return out;
}

/* ── UTF-8 ⇄ UTF-16 (the exec buffer strategy) ──────────────────────── */

/* Subject as freshly-malloc'd UTF-16 code units (strings are well-formed
 * UTF-8, so no validation). Unit count ≤ byte count. */
static uint16_t *scr_to_utf16(const ScrStr *s, int *plen) {
  if (s->len > (size_t)INT32_MAX - 1 || s->len > SIZE_MAX / sizeof(uint16_t))
    scr_regex_oom();
  uint16_t *u = malloc((s->len ? s->len : 1) * sizeof(uint16_t));
  if (!u) scr_regex_oom();
  int n = 0;
  for (size_t i = 0; i < s->len;) {
    unsigned char c = (unsigned char)s->data[i];
    uint32_t cp;
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if (c < 0xE0) {
      cp = ((uint32_t)(c & 0x1F) << 6) | ((unsigned char)s->data[i + 1] & 0x3F);
      i += 2;
    } else if (c < 0xF0) {
      cp = ((uint32_t)(c & 0x0F) << 12) |
           ((uint32_t)((unsigned char)s->data[i + 1] & 0x3F) << 6) |
           ((unsigned char)s->data[i + 2] & 0x3F);
      i += 3;
    } else {
      cp = ((uint32_t)(c & 0x07) << 18) |
           ((uint32_t)((unsigned char)s->data[i + 1] & 0x3F) << 12) |
           ((uint32_t)((unsigned char)s->data[i + 2] & 0x3F) << 6) |
           ((unsigned char)s->data[i + 3] & 0x3F);
      i += 4;
    }
    if (cp >= 0x10000) {
      u[n++] = (uint16_t)(0xD800 + ((cp - 0x10000) >> 10));
      u[n++] = (uint16_t)(0xDC00 + ((cp - 0x10000) & 0x3FF));
    } else {
      u[n++] = (uint16_t)cp;
    }
  }
  *plen = n;
  return u;
}

/* Decode one UTF-16 code point. A boundary that splits a surrogate pair
 * produces U+FFFD, as in the runtime's string slicing contract. */
static uint32_t scr_regex_codepoint(const uint16_t *units, int *index, int end) {
  uint32_t cp = units[(*index)++];
  if (cp >= 0xD800 && cp < 0xDC00 && *index < end &&
      units[*index] >= 0xDC00 && units[*index] < 0xE000)
    return 0x10000 + ((cp - 0xD800) << 10) + (units[(*index)++] - 0xDC00);
  return cp >= 0xD800 && cp < 0xE000 ? 0xFFFD : cp;
}

static size_t scr_regex_encode(char *out, uint32_t cp) {
  if (cp < 0x80) {
    out[0] = (char)cp;
    return 1;
  }
  if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6));
    out[1] = (char)(0x80 | (cp & 0x3F));
    return 2;
  }
  if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
  }
  out[0] = (char)(0xF0 | (cp >> 18));
  out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
  out[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

static void scr_jb_put_utf16(ScrJsonBuf *b, const uint16_t *u, int start, int end) {
  char bytes[256];
  size_t used = 0;
  for (int i = start; i < end;) {
    if (used > sizeof bytes - 4) {
      scr_jb_write(b, bytes, used);
      used = 0;
    }
    used += scr_regex_encode(bytes + used, scr_regex_codepoint(u, &i, end));
  }
  scr_jb_write(b, bytes, used);
}

/* Matching owns only the converted subject and oversized register buffer.
 * The caller keeps the original immutable string alive. ASCII bytes are
 * already the engine's one-byte representation, even under /u or /i. */
typedef struct ScrRegexInput {
  const uint8_t *data;
  uint16_t *utf16;
  const ScrReNative *native; /* one-byte subjects of translated patterns */
  int len;
  int wide;
  bool borrowed_utf16; /* utf16 belongs to the subject cache below */
  uint8_t **capture;
  uint8_t *registers[32];
} ScrRegexInput;

static bool scr_text_ascii(const ScrStr *s) {
  size_t i = 0;
  for (; s->len - i >= sizeof(uint64_t); i += sizeof(uint64_t)) {
    uint64_t word;
    memcpy(&word, s->data + i, sizeof word);
    if (word & UINT64_C(0x8080808080808080)) return false;
  }
  for (; i < s->len; i++) {
    if ((unsigned char)s->data[i] >= 0x80) return false;
  }
  return true;
}

static void scr_regex_input_registers(ScrRegexInput *input, const uint8_t *bc) {
  /* The executor writes temporary registers beyond the capture pairs. */
  int count = lre_get_alloc_count(bc);
  input->capture = count <= 32 ? input->registers : malloc((size_t)count * sizeof(uint8_t *));
  if (!input->capture) scr_regex_oom();
}

static void scr_regex_input_init(ScrRegexInput *input, const ScrRegex *re,
                                  const uint8_t *bc, const ScrStr *s) {
  if (s->len > (size_t)INT32_MAX - 1) scr_regex_oom();
  input->wide = !scr_text_ascii(s);
  input->native = input->wide ? NULL : (const ScrReNative *)re->native;
  input->utf16 = input->wide ? scr_to_utf16(s, &input->len) : NULL;
  input->borrowed_utf16 = false;
  input->data = input->wide ? (const uint8_t *)input->utf16 : (const uint8_t *)s->data;
  if (!input->wide) input->len = (int)s->len;
  scr_regex_input_registers(input, bc);
}

/* Single-entry decoding cache for exec/test subjects. A lastIndex-driven
 * loop (`while ((m = re.exec(s)) !== null)`, sticky tokenizers, repeated
 * tests of one document) calls into the engine once per match on the same
 * immutable string. Rescanning it for ASCII on every call, and converting
 * a non-ASCII subject to UTF-16 again, made those loops quadratic in the
 * subject length. The cache retains its subject: the address cannot be
 * recycled, and a retained string is never appended in place (only rc == 1
 * strings mutate). Only exec and test use it. They run no user code while
 * their input is live, so a nested regex call cannot evict a buffer that
 * is still in use; the draining entry points convert once per call. Short
 * subjects skip the cache: their scan is cheaper than the bookkeeping. */
enum { SCR_REGEX_SUBJECT_CACHE_MIN = 256 };
static SCR_TL ScrStr *scr_subject_str;
static SCR_TL uint16_t *scr_subject_utf16;
static SCR_TL int scr_subject_len;
static SCR_TL bool scr_subject_wide;
static SCR_TL bool scr_subject_armed;

static void scr_regex_subject_clear(void) {
  ScrStr *old = scr_subject_str;
  free(scr_subject_utf16);
  scr_subject_str = NULL;
  scr_subject_utf16 = NULL;
  scr_str_release(old);
}

static void scr_regex_input_init_cached(ScrRegexInput *input, const ScrRegex *re,
                                         const uint8_t *bc, ScrStr *s) {
  if (s->len < SCR_REGEX_SUBJECT_CACHE_MIN) {
    scr_regex_input_init(input, re, bc, s);
    return;
  }
  if (s != scr_subject_str) {
    if (s->len > (size_t)INT32_MAX - 1) scr_regex_oom();
    bool wide = !scr_text_ascii(s);
    int len = (int)s->len;
    uint16_t *utf16 = wide ? scr_to_utf16(s, &len) : NULL;
    scr_regex_subject_clear();
    if (!scr_subject_armed) {
      scr_subject_armed = true;
      scr_atexit(scr_regex_subject_clear);
    }
    scr_subject_str = scr_str_retain(s);
    scr_subject_utf16 = utf16;
    scr_subject_len = len;
    scr_subject_wide = wide;
  }
  input->wide = scr_subject_wide;
  input->native = input->wide ? NULL : (const ScrReNative *)re->native;
  input->utf16 = scr_subject_utf16;
  input->borrowed_utf16 = true;
  input->data = input->wide ? (const uint8_t *)input->utf16 : (const uint8_t *)s->data;
  input->len = scr_subject_len;
  scr_regex_input_registers(input, bc);
}

static void scr_regex_input_dispose(ScrRegexInput *input) {
  if (input->capture != input->registers) free(input->capture);
  if (!input->borrowed_utf16) free(input->utf16);
}

static int scr_exec(ScrRegexInput *input, const uint8_t *bc, int index) {
  int rc = input->native
    ? scr_re_native_exec(input->native, input->capture, input->data, index, input->len)
    : lre_exec(input->capture, bc, input->data, index, input->len, input->wide, lre_opaque());
  if (rc < 0) {
    fflush(stdout);
    scr_trap("scriptc: regular expression execution failed\n");
  }
  return rc;
}

static int scr_capture_index(const ScrRegexInput *input, const uint8_t *capture) {
  return (int)((capture - input->data) >> input->wide);
}

static void scr_regex_put_span(ScrJsonBuf *b, const ScrRegexInput *input,
                                int start, int end) {
  if (input->wide) scr_jb_put_utf16(b, input->utf16, start, end);
  else scr_jb_write(b, (const char *)input->data + start, (size_t)(end - start));
}

static ScrStr *scr_regex_span(const ScrRegexInput *input, int start, int end) {
  if (!input->wide)
    return scr_str_new((const char *)input->data + start, (size_t)(end - start));
  /* Captures have a known span: allocate its exact UTF-8 length instead
   * of inheriting a general builder's size hint from an earlier document. */
  size_t bytes = 0;
  for (int i = start; i < end;) {
    uint32_t cp = scr_regex_codepoint(input->utf16, &i, end);
    size_t width = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (width > SIZE_MAX - sizeof(ScrStr) - 1 - bytes) scr_regex_oom();
    bytes += width;
  }
  ScrStr *out = scr_str_alloc_raw(bytes, bytes);
  size_t offset = 0;
  for (int i = start; i < end;)
    offset += scr_regex_encode(out->data + offset, scr_regex_codepoint(input->utf16, &i, end));
  out->data[bytes] = '\0';
  return out;
}

/* ECMA-262 AdvanceStringIndex: past a whole surrogate pair under /u, one
 * code unit otherwise. ASCII cannot contain a surrogate pair. */
static int scr_advance(const ScrRegexInput *input, int i, bool unicode) {
  const uint16_t *u = input->utf16;
  if (unicode && input->wide && i + 1 < input->len &&
      u[i] >= 0xD800 && u[i] < 0xDC00 && u[i + 1] >= 0xDC00 && u[i + 1] < 0xE000)
    return i + 2;
  return i + 1;
}

/* ── test ─────────────────────────────────────────────────────────────── */

void scr_regex_reset_last_index(ScrRegex *re, double index) {
  re->last_index = index;
}

static int scr_regex_start(ScrRegex *re, int len) {
  double index = re->last_index;
  if (isnan(index) || index <= 0) return 0;
  if (index > len) return -1;
  return (int)floor(index);
}

/* A predicate needs only boundaries; it never materializes result strings. */
bool scr_regex_test(ScrRegex *re, ScrStr *s) {
  uint8_t *bc = scr_regex_bc(re);
  ScrRegexInput input;
  scr_regex_input_init_cached(&input, re, bc, s);
  bool stateful = (lre_get_flags(bc) & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) != 0;
  int pos = stateful ? scr_regex_start(re, input.len) : 0;
  int rc = pos < 0 ? 0 : scr_exec(&input, bc, pos);
  if (stateful) re->last_index = rc == 1
    ? (double)scr_capture_index(&input, input.capture[1]) : 0;
  scr_regex_input_dispose(&input);
  return rc == 1;
}

/* ── match ────────────────────────────────────────────────────────────── */

/* re.exec(s): a fresh string[] of [whole match, ...captures], or NULL
 * for no match (the compiler wraps the `string[] | null` union). Global
 * and sticky regexes start at lastIndex, set it to the match end, and
 * reset it on failure. Nonparticipating captures are present undefined
 * elements, distinct from participating empty captures and array holes. */
ScrArr *scr_regex_exec(ScrStr *s, ScrRegex *re) {
  uint8_t *bc = scr_regex_bc(re);
  bool stateful = (lre_get_flags(bc) & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) != 0;
  ScrRegexInput input;
  scr_regex_input_init_cached(&input, re, bc, s);
  int len = input.len;
  uint8_t **capture = input.capture;
  int pos = stateful ? scr_regex_start(re, len) : 0;
  int rc = pos < 0 ? 0 : scr_exec(&input, bc, pos);
  if (stateful) re->last_index = rc == 1
    ? (double)scr_capture_index(&input, capture[1]) : 0;
  ScrArr *out = NULL;
  if (rc == 1) {
    int count = lre_get_capture_count(bc);
    out = scr_arr_new(SCR_ELEM_STR, (size_t)count);
    out->metadata = scr_dyn_new_obj();
    scr_dyn_obj_set(out->metadata, "index", 5, scr_dyn_new_num((double)scr_capture_index(&input, capture[0])));
    scr_dyn_obj_set(out->metadata, "input", 5, scr_dyn_new_str(s));
    for (int k = 0; k < count; k++) {
      const uint8_t *cs = capture[2 * k], *ce = capture[2 * k + 1];
      if (cs == NULL || ce == NULL) {
        scr_arr_set_undefined(out, (double)out->len);
      } else {
        scr_arr_push_ref(
            out, scr_regex_span(&input, scr_capture_index(&input, cs), scr_capture_index(&input, ce)));
      }
    }
  }
  scr_regex_input_dispose(&input);
  return out; /* +1, or NULL (no match) */
}

/* Global Symbol.match always starts at zero and drains whole matches,
 * ignoring capture groups. Its terminating failed exec resets lastIndex
 * to zero, so no state escapes this internal iteration. Sticky globals
 * stop at the first gap; empty matches advance by a Unicode code point
 * under /u and by one UTF-16 unit otherwise. */
ScrArr *scr_regex_match(ScrStr *s, ScrRegex *re) {
  uint8_t *bc = scr_regex_bc(re);
  int flags = lre_get_flags(bc);
  if (!(flags & LRE_FLAG_GLOBAL)) return scr_regex_exec(s, re);
  re->last_index = 0;
  bool unicode = (flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  ScrRegexInput input;
  scr_regex_input_init(&input, re, bc, s);
  int len = input.len;
  uint8_t **capture = input.capture;
  ScrArr *out = NULL;
  int pos = scr_regex_start(re, len);
  if (pos < 0) pos = len + 1;
  while (pos <= len && scr_exec(&input, bc, pos) == 1) {
    int start = scr_capture_index(&input, capture[0]);
    int end = scr_capture_index(&input, capture[1]);
    if (!out) out = scr_arr_new(SCR_ELEM_STR, 4);
    scr_arr_push_ref(out, scr_regex_span(&input, start, end));
    pos = start == end ? scr_advance(&input, end, unicode) : end;
  }
  scr_regex_input_dispose(&input);
  return out;
}

/* ── search ───────────────────────────────────────────────────────────── */

/* s.search(re): the first match's UTF-16 index, or -1 — Symbol.search's
 * fresh exec from position 0. lastIndex is neither read nor written in JS
 * (the spec saves and restores it): /g is irrelevant and /y anchors at 0
 * (libregexp's sticky
 * bytecode omits the implicit forward scan) — exactly Node. */
double scr_regex_search(ScrStr *s, ScrRegex *re) {
  uint8_t *bc = scr_regex_bc(re);
  ScrRegexInput input;
  scr_regex_input_init(&input, re, bc, s);
  uint8_t **capture = input.capture;
  int rc = scr_exec(&input, bc, 0);
  double out = -1;
  if (rc == 1) out = (double)scr_capture_index(&input, capture[0]);
  scr_regex_input_dispose(&input);
  return out;
}

/* matchAll(re): every match as its honest slice string[] (whole match +
 * captures, nonparticipating = undefined — match()'s rule) drained EAGERLY into
 * a fresh string[][]. The lazy iterator is unobservable across the
 * lowered surface: strings are immutable and the spec clones the regex at
 * the call, so nothing can perturb the drain. Non-global regexes throw
 * Node's exact TypeError (catchable — replaceAll's stance). Empty matches
 * advance one unit, unicode-aware (AdvanceStringIndex). `indices`, when
 * non-NULL, receives each match's UTF-16 start index (the row's .index —
 * the companion array the for-of-over-matchAll desugar reads). */
static ScrArr *scr_regex_match_all_core(ScrStr *s, ScrRegex *re, ScrArr *indices) {
  uint8_t *bc = scr_regex_bc(re);
  int re_flags = lre_get_flags(bc);
  if (!(re_flags & LRE_FLAG_GLOBAL)) {
    static const char msg[] =
        "String.prototype.matchAll called with a non-global RegExp argument";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL; /* callers are compiler-emitted pending checks */
  }
  bool unicode = (re_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  int capture_count = lre_get_capture_count(bc);
  ScrRegexInput input;
  scr_regex_input_init(&input, re, bc, s);
  int len = input.len;
  uint8_t **capture = input.capture;
  ScrArr *out = scr_arr_new(SCR_ELEM_ARR, 4);
  int pos = scr_regex_start(re, len);
  if (pos < 0) pos = len + 1;
  while (pos <= len) {
    if (scr_exec(&input, bc, pos) != 1) break;
    int start = scr_capture_index(&input, capture[0]);
    int end = scr_capture_index(&input, capture[1]);
    ScrArr *row = scr_arr_new(SCR_ELEM_STR, (size_t)capture_count);
    for (int k = 0; k < capture_count; k++) {
      const uint8_t *cs = capture[2 * k], *ce = capture[2 * k + 1];
      if (cs == NULL || ce == NULL) {
        scr_arr_set_undefined(row, (double)row->len);
      } else {
        scr_arr_push_ref(
            row, scr_regex_span(&input, scr_capture_index(&input, cs), scr_capture_index(&input, ce)));
      }
    }
    scr_arr_push_ref(out, row);
    if (indices != NULL) scr_arr_push_f64(indices, (double)start);
    pos = end == start ? scr_advance(&input, end, unicode) : end;
  }
  scr_regex_input_dispose(&input);
  return out; /* +1 (possibly empty — Node's no-match drain is []) */
}

ScrArr *scr_regex_match_all(ScrStr *s, ScrRegex *re) {
  return scr_regex_match_all_core(s, re, NULL);
}

ScrArr *scr_regex_match_all_into(ScrStr *s, ScrRegex *re, ScrArr *indices) {
  return scr_regex_match_all_core(s, re, indices);
}

/* ── replace / replaceAll ─────────────────────────────────────────────── */

/* ECMA-262 GetSubstitution over the replacement TEMPLATE (function
 * replacements are frontend-fenced): $$, $&, $` and $', $1..$99 (two digits
 * win when in range — the refined ES2019 rule quickjs implements), with
 * out-of-range references left literal and unmatched groups substituting
 * empty. $<name> resolves against the pattern's named capture groups
 * (lre_get_groupnames — one NUL-terminated name per capture, "" for
 * unnamed): the first PARTICIPATING capture with that name substitutes
 * (ES2025 duplicates live in distinct alternatives, so at most one
 * participates); a nonexistent or nonparticipating name substitutes
 * empty (the spec's Get→undefined→"" path, Node-exact). When the pattern
 * has NO named groups, namedCaptures is undefined and '$<' stays literal
 * — also Node's unterminated-'$<name' answer either way. The template is
 * scanned byte-wise: every '$' directive is ASCII, and UTF-8 continuation
 * bytes can never alias it. */
static void scr_put_substitution(ScrJsonBuf *b, const ScrRegexInput *input,
                                  int start, int end, uint8_t **capture,
                                  int capture_count, const char *groupnames,
                                  const ScrStr *rep) {
  size_t i = 0;
  while (i < rep->len) {
    char c = rep->data[i];
    if (c != '$' || i + 1 >= rep->len) {
      const char *next = memchr(rep->data + i + 1, '$', rep->len - i - 1);
      size_t end = next ? (size_t)(next - rep->data) : rep->len;
      scr_jb_write(b, rep->data + i, end - i);
      i = end;
      continue;
    }
    char c1 = rep->data[i + 1];
    if (c1 == '$') {
      scr_jb_putc(b, '$');
      i += 2;
    } else if (c1 == '&') {
      scr_regex_put_span(b, input, start, end);
      i += 2;
    } else if (c1 == '`') {
      scr_regex_put_span(b, input, 0, start);
      i += 2;
    } else if (c1 == '\'') {
      scr_regex_put_span(b, input, end, input->len);
      i += 2;
    } else if (c1 >= '0' && c1 <= '9') {
      int k = c1 - '0';
      size_t adv = 2;
      if (i + 2 < rep->len && rep->data[i + 2] >= '0' && rep->data[i + 2] <= '9') {
        int k1 = k * 10 + (rep->data[i + 2] - '0');
        if (k1 >= 1 && k1 < capture_count) {
          k = k1;
          adv = 3;
        }
      }
      if (k >= 1 && k < capture_count) {
        const uint8_t *cs = capture[2 * k], *ce = capture[2 * k + 1];
        if (cs && ce) {
          scr_regex_put_span(b, input, scr_capture_index(input, cs), scr_capture_index(input, ce));
        }
        i += adv;
      } else {
        /* Out of range: the '$' is literal (the digits re-scan verbatim). */
        scr_jb_putc(b, '$');
        i++;
      }
    } else if (c1 == '<' && groupnames != NULL) {
      /* $<name>: scan for '>'; absent, the '$' is literal (the rest
       * re-scans verbatim — GetSubstitution's not-found answer). */
      size_t gt = i + 2;
      while (gt < rep->len && rep->data[gt] != '>') gt++;
      if (gt >= rep->len) {
        scr_jb_putc(b, '$');
        i++;
        continue;
      }
      const char *name = rep->data + i + 2;
      size_t name_len = gt - (i + 2);
      const char *p = groupnames; /* capture_count-1 entries: name NUL scope */
      for (int k = 1; k < capture_count; k++) {
        size_t glen = strlen(p);
        if (glen == name_len && memcmp(p, name, name_len) == 0) {
          const uint8_t *cs = capture[2 * k], *ce = capture[2 * k + 1];
          if (cs && ce) {
            scr_regex_put_span(b, input, scr_capture_index(input, cs), scr_capture_index(input, ce));
            break; /* at most one duplicate participates */
          }
        }
        p += glen + LRE_GROUP_NAME_TRAILER_LEN;
      }
      i = gt + 1;
    } else {
      scr_jb_putc(b, '$');
      i++;
    }
  }
}

/* The shared match loop (the shape of quickjs's JS_RegExpDelete): search
 * from `pos`, copy the gap, emit the substitution, continue from the match
 * end when global — advancing zero-length matches per AdvanceStringIndex. */
static ScrStr *scr_replace_impl(ScrStr *s, ScrRegex *re, ScrStr *rep) {
  uint8_t *bc = scr_regex_bc(re);
  int re_flags = lre_get_flags(bc);
  bool global = (re_flags & LRE_FLAG_GLOBAL) != 0;
  bool sticky = (re_flags & LRE_FLAG_STICKY) != 0;
  bool unicode = (re_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  int capture_count = lre_get_capture_count(bc);
  const char *groupnames = lre_get_groupnames(bc);
  ScrRegexInput input;
  scr_regex_input_init(&input, re, bc, s);
  int len = input.len;
  uint8_t **capture = input.capture;
  ScrJsonBuf b;
  scr_jb_init(&b);
  if (global) re->last_index = 0;
  int next = 0, pos = sticky ? scr_regex_start(re, len) : 0;
  if (pos < 0) pos = len + 1;
  if (sticky && !global) re->last_index = 0;
  bool matched = false;
  bool literal = memchr(rep->data, '$', rep->len) == NULL;
  while (pos <= len) {
    if (scr_exec(&input, bc, pos) != 1) break;
    matched = true;
    int start = scr_capture_index(&input, capture[0]);
    int end = scr_capture_index(&input, capture[1]);
    if (sticky && !global) re->last_index = end;
    scr_regex_put_span(&b, &input, next, start);
    if (literal) scr_jb_put_str(&b, rep);
    else scr_put_substitution(&b, &input, start, end, capture, capture_count, groupnames, rep);
    next = end;
    if (!global) break;
    pos = end == start ? scr_advance(&input, end, unicode) : end;
  }
  if (matched) scr_regex_put_span(&b, &input, next, len);
  scr_regex_input_dispose(&input);
  return matched ? scr_jb_finish(&b) : scr_str_retain(s);
}

ScrStr *scr_regex_replace(ScrStr *s, ScrRegex *re, ScrStr *rep) {
  return scr_replace_impl(s, re, rep);
}

typedef struct {
  ScrDyn *arguments;
  int start, end;
} ScrReplacementMatch;

static ScrDyn *scr_regex_capture_value(const ScrRegexInput *input,
                                       const uint8_t *start, const uint8_t *end) {
  if (!start || !end) return scr_dyn_retain(scr_dyn_undefined());
  ScrStr *span = scr_regex_span(input, scr_capture_index(input, start),
                                scr_capture_index(input, end));
  ScrDyn *value = scr_dyn_new_str(span);
  scr_str_release(span);
  return value;
}

/* Symbol.replace collects matches before invoking any replacement. A callback
 * can execute the same regex, change lastIndex, or throw; none of those actions
 * may affect which matches were collected. Capture values and groups therefore
 * belong to each snapshot, not to the engine's reused capture buffer. */
ScrStr *scr_regex_replace_callback(ScrStr *s, ScrRegex *re, ScrDyn *callback, bool all) {
  uint8_t *bc = scr_regex_bc(re);
  int flags = lre_get_flags(bc);
  bool global = (flags & LRE_FLAG_GLOBAL) != 0;
  if (all && !global) {
    static const char message[] = "String.prototype.replaceAll called with a non-global RegExp argument";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  if (!scr_dyn_is_callable(callback)) {
    ScrStr *template = scr_dyn_string_coerce_js(callback);
    if (!template) return NULL;
    ScrStr *result = scr_replace_impl(s, re, template);
    scr_str_release(template);
    return result;
  }
  bool sticky = (flags & LRE_FLAG_STICKY) != 0;
  bool unicode = (flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  int capture_count = lre_get_capture_count(bc);
  const char *groupnames = lre_get_groupnames(bc);
  ScrRegexInput input;
  scr_regex_input_init(&input, re, bc, s);
  int len = input.len;
  ScrReplacementMatch *matches = NULL;
  size_t count = 0, capacity = 0;
  ScrDyn *subject = scr_dyn_new_str(s);
  if (global) re->last_index = 0;
  int position = sticky ? scr_regex_start(re, len) : 0;
  if (position < 0) position = len + 1;
  if (sticky && !global) re->last_index = 0;
  while (position <= len && scr_exec(&input, bc, position) == 1) {
    uint8_t **capture = input.capture;
    int start = scr_capture_index(&input, capture[0]);
    int end = scr_capture_index(&input, capture[1]);
    if (sticky && !global) re->last_index = end;
    ScrDyn *arguments = scr_dyn_new_arr();
    for (int group = 0; group < capture_count; group++)
      scr_dyn_arr_push(arguments, scr_regex_capture_value(&input, capture[group * 2], capture[group * 2 + 1]));
    scr_dyn_arr_push(arguments, scr_dyn_new_num((double)start));
    scr_dyn_arr_push(arguments, scr_dyn_retain(subject));
    if (groupnames) {
      ScrDyn *groups = scr_dyn_new_obj_null_proto();
      const char *name = groupnames;
      for (int group = 1; group < capture_count; group++) {
        size_t length = strlen(name);
        if (length && (capture[group * 2] || !scr_dyn_obj_get(groups, name, length)))
          scr_dyn_obj_set(groups, name, length,
            scr_regex_capture_value(&input, capture[group * 2], capture[group * 2 + 1]));
        name += length + LRE_GROUP_NAME_TRAILER_LEN;
      }
      scr_dyn_arr_push(arguments, groups);
    }
    if (count == capacity) {
      size_t next = capacity ? capacity * 2 : 8;
      if (next < capacity || next > SIZE_MAX / sizeof(*matches)) scr_regex_oom();
      ScrReplacementMatch *grown = realloc(matches, next * sizeof(*matches));
      if (!grown) scr_regex_oom();
      matches = grown;
      capacity = next;
    }
    matches[count++] = (ScrReplacementMatch){ arguments, start, end };
    if (!global) break;
    position = start == end ? scr_advance(&input, end, unicode) : end;
  }
  scr_dyn_release(subject);
  ScrJsonBuf output;
  scr_jb_init(&output);
  int next = 0;
  for (size_t i = 0; i < count; i++) {
    ScrReplacementMatch *match = &matches[i];
    ScrDyn *arguments = match->arguments;
    scr_dyn_this_push_dyn(NULL);
    ScrDyn *raw = scr_dyn_call(callback, arguments->v.arr.items, arguments->v.arr.len, "replacement");
    scr_dyn_this_pop();
    ScrStr *replacement = scr_exc_pending() ? NULL : scr_dyn_string_coerce_js(raw);
    scr_dyn_release(raw);
    if (!replacement) break;
    scr_regex_put_span(&output, &input, next, match->start);
    scr_jb_put_str(&output, replacement);
    scr_str_release(replacement);
    next = match->end;
  }
  for (size_t i = 0; i < count; i++) scr_dyn_release(matches[i].arguments);
  free(matches);
  if (scr_exc_pending()) {
    free(output.data);
    scr_regex_input_dispose(&input);
    return NULL;
  }
  scr_regex_put_span(&output, &input, next, len);
  scr_regex_input_dispose(&input);
  return scr_jb_finish(&output);
}


/* The pinned Node ANSI matcher derives from ansi-regex, copyright (c)
 * Sindre Sorhus <sindresorhus@gmail.com>, used under the MIT license:
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 * Keep the pattern equivalent to Node v24.15.0 internal/util/inspect.js. */
#define SCR_VT_PATTERN "[\\u001B\\u009B][[\\]()#;?]*" \
  "(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*" \
  "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?" \
  "(?:\\u0007|\\u001B\\u005C|\\u009C))" \
  "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))"

ScrStr *scr_util_strip_vt(const ScrDyn *input) {
  if (!input || input->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("str", "of type string", input ? input : scr_dyn_undefined());
    return NULL;
  }
  ScrStr *subject = input->v.str;
  bool escape = false;
  for (size_t i = 0; i < subject->len; i++) {
    if (subject->data[i] == '\x1b' || ((unsigned char)subject->data[i] == 0xc2 &&
        i + 1 < subject->len && (unsigned char)subject->data[i + 1] == 0x9b)) {
      escape = true;
      break;
    }
  }
  if (!escape) return scr_str_retain(subject);
  static const struct { size_t rc, len, cap; char data[sizeof SCR_VT_PATTERN]; }
    source = { SIZE_MAX, sizeof SCR_VT_PATTERN - 1, sizeof SCR_VT_PATTERN - 1, SCR_VT_PATTERN };
  static const struct { size_t rc, len, cap; char data[2]; }
    flags = { SIZE_MAX, 1, 1, "g" };
  static SCR_TL ScrRegex template = { SIZE_MAX, (ScrStr *)&source, (ScrStr *)&flags, NULL, 0, NULL };
  ScrRegex *regex = scr_regex_literal(&template);
  ScrStr *empty = scr_str_new("", 0);
  ScrStr *result = scr_regex_replace(subject, regex, empty);
  scr_str_release(empty);
  scr_regex_release(regex);
  return result;
}
#undef SCR_VT_PATTERN

ScrStr *scr_regex_replace_all(ScrStr *s, ScrRegex *re, ScrStr *rep) {
  if (!(lre_get_flags(scr_regex_bc(re)) & LRE_FLAG_GLOBAL)) {
    /* Node's exact TypeError — a real instance now: catch bindings narrow
     * it and e.message carries V8's text byte-for-byte. */
    static const char msg[] =
        "String.prototype.replaceAll called with a non-global RegExp argument";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL; /* callers are compiler-emitted pending checks */
  }
  return scr_replace_impl(s, re, rep);
}

/* ── split ────────────────────────────────────────────────────────────── */

ScrArr *scr_regex_split_limit(ScrStr *s, ScrRegex *re, double limit_num) {
  uint8_t *bc = scr_regex_bc(re);
  uint32_t limit = scr_to_uint32(limit_num);
  if (limit == 0) return scr_arr_new(SCR_ELEM_STR, 0);
  int capture_count = lre_get_capture_count(bc);
  int re_flags = lre_get_flags(bc);
  bool unicode = (re_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  bool sticky = (re_flags & LRE_FLAG_STICKY) != 0;
  ScrRegexInput input;
  scr_regex_input_init(&input, re, bc, s);
  int len = input.len;
  uint8_t **capture = input.capture;
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);

  /* ECMA-262 22.2.6.14 (Symbol.split). The spec probes every
   * position with a sticky matcher; for non-sticky patterns a forward
   * SEARCH from q is equivalent (the earliest match position >= q is the
   * first probe that would succeed) and one exec replaces the per-position
   * loop. A genuinely sticky pattern keeps the spec's probe-and-advance. */
  if (len == 0) {
    /* Empty subject: one probe — a match yields [], no match yields [""]. */
    if (scr_exec(&input, bc, 0) != 1) {
      scr_arr_push_ref(out, scr_str_new("", 0));
    }
    scr_regex_input_dispose(&input);
    return out;
  }
  int p = 0, q = 0;
  while (q < len) {
    if (scr_exec(&input, bc, q) != 1) {
      if (!sticky) break; /* no match anywhere right of q */
      q = scr_advance(&input, q, unicode);
      continue;
    }
    int start = scr_capture_index(&input, capture[0]);
    int end = scr_capture_index(&input, capture[1]);
    /* The sticky algorithm never probes the position after the subject.
     * A forward search can find a zero-width match there; exclude it. */
    if (start == len) break;
    if (end == p) {
      /* Zero-length match adjacent to the previous split point: advance
       * (start == q == p here — the search cannot skip a match). */
      q = scr_advance(&input, start, unicode);
    } else {
      scr_arr_push_ref(out, scr_regex_span(&input, p, start));
      if (out->len == limit) goto done;
      for (int group = 1; group < capture_count; group++) {
        const uint8_t *from = capture[2 * group];
        const uint8_t *to = capture[2 * group + 1];
        if (from == NULL || to == NULL) {
          // Nonparticipating captures are present undefined elements,
          // distinct from both empty strings and holes.
          scr_arr_set_undefined(out, (double)out->len);
        } else {
          scr_arr_push_ref(out, scr_regex_span(&input,
              scr_capture_index(&input, from), scr_capture_index(&input, to)));
        }
        if (out->len == limit) goto done;
      }
      p = end;
      q = p;
    }
  }
  scr_arr_push_ref(out, scr_regex_span(&input, p, len));
done:
  scr_regex_input_dispose(&input);
  return out;
}

ScrArr *scr_regex_split(ScrStr *s, ScrRegex *re) {
  return scr_regex_split_limit(s, re, 4294967295.0);
}

/* ── String.prototype.toLowerCase / toUpperCase (the static path) ──────
 * ECMA-262 Default Case Conversion via the vendored libunicode's
 * lre_case_conv — the exact tables and algorithm the engine's own
 * String.prototype methods run (quickjs.c's js_string_toLowerCase), the
 * context-sensitive Greek final-sigma rule included. Lives HERE, not in
 * scr_string.c, because it needs libunicode: the compiler sets the lre
 * link flag for case-conversion sites exactly like regex nodes, so
 * case-free (and regex-free) programs keep their historical link line.
 * Node runs full ICU case mapping, but for the locale-independent
 * toLowerCase/toUpperCase the two agree — ICU's locale tailorings
 * (Turkish/Azeri dotted I, Lithuanian accent handling) apply only to
 * toLocaleLowerCase with an explicit locale, which stays fenced. The
 * receiver is BORROWED; the result is a fresh +1 string. */

/* Decode the code point at p (well-formed UTF-8); *adv gets the length. */
static uint32_t scr_case_decode(const char *p, size_t *adv) {
  unsigned char c = (unsigned char)p[0];
  if (c < 0x80) {
    *adv = 1;
    return c;
  }
  if (c < 0xE0) {
    *adv = 2;
    return ((uint32_t)(c & 0x1F) << 6) | ((unsigned char)p[1] & 0x3F);
  }
  if (c < 0xF0) {
    *adv = 3;
    return ((uint32_t)(c & 0x0F) << 12) |
           ((uint32_t)((unsigned char)p[1] & 0x3F) << 6) |
           ((unsigned char)p[2] & 0x3F);
  }
  *adv = 4;
  return ((uint32_t)(c & 0x07) << 18) |
         ((uint32_t)((unsigned char)p[1] & 0x3F) << 12) |
         ((uint32_t)((unsigned char)p[2] & 0x3F) << 6) |
         ((unsigned char)p[3] & 0x3F);
}

/* Step back one code point from *off (> 0) and decode it. */
static uint32_t scr_case_prev(const ScrStr *s, size_t *off) {
  size_t i = *off;
  do {
    i--;
  } while (i > 0 && ((unsigned char)s->data[i] & 0xC0) == 0x80);
  *off = i;
  size_t adv;
  return scr_case_decode(s->data + i, &adv);
}

/* Unicode Final_Sigma: Σ is preceded by a cased letter (after skipping
 * case-ignorable characters) and NOT followed by one — quickjs.c's
 * test_final_sigma over the UTF-8 storage. `next_off` is the byte offset
 * just past the sigma. */
static bool scr_final_sigma(const ScrStr *s, size_t sigma_off, size_t next_off) {
  size_t k = sigma_off;
  uint32_t c1;
  for (;;) {
    if (k == 0) return false; /* nothing cased before C */
    c1 = scr_case_prev(s, &k);
    if (!lre_is_case_ignorable(c1)) break;
  }
  if (!lre_is_cased(c1)) return false;
  k = next_off;
  for (;;) {
    if (k >= s->len) return true;
    size_t adv;
    c1 = scr_case_decode(s->data + k, &adv);
    k += adv;
    if (!lre_is_case_ignorable(c1)) break;
  }
  return !lre_is_cased(c1);
}

/* Append one code point as UTF-8 (case results never mint surrogates). */
static void scr_case_put_cp(ScrJsonBuf *b, uint32_t cp) {
  if (cp < 0x80) {
    scr_jb_putc(b, (char)cp);
  } else if (cp < 0x800) {
    scr_jb_putc(b, (char)(0xC0 | (cp >> 6)));
    scr_jb_putc(b, (char)(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    scr_jb_putc(b, (char)(0xE0 | (cp >> 12)));
    scr_jb_putc(b, (char)(0x80 | ((cp >> 6) & 0x3F)));
    scr_jb_putc(b, (char)(0x80 | (cp & 0x3F)));
  } else {
    scr_jb_putc(b, (char)(0xF0 | (cp >> 18)));
    scr_jb_putc(b, (char)(0x80 | ((cp >> 12) & 0x3F)));
    scr_jb_putc(b, (char)(0x80 | ((cp >> 6) & 0x3F)));
    scr_jb_putc(b, (char)(0x80 | (cp & 0x3F)));
  }
}

static ScrStr *scr_str_case_conv(const ScrStr *s, int to_lower) {
  unsigned char first = to_lower ? 'A' : 'a';
  unsigned char last = to_lower ? 'Z' : 'z';
  if (scr_text_ascii(s)) {
    size_t changed = 0;
    while (changed < s->len &&
           ((unsigned char)s->data[changed] < first || (unsigned char)s->data[changed] > last))
      changed++;
    if (changed == s->len) return scr_str_retain((ScrStr *)s);
    ScrStr *out = scr_str_alloc_raw(s->len, s->len);
    memcpy(out->data, s->data, changed);
    for (size_t i = changed; i < s->len; i++) {
      unsigned char c = (unsigned char)s->data[i];
      out->data[i] = (char)(c >= first && c <= last ? c ^ 0x20 : c);
    }
    out->data[s->len] = '\0';
    return out;
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  uint32_t res[LRE_CC_RES_LEN_MAX];
  for (size_t i = 0; i < s->len;) {
    if ((unsigned char)s->data[i] < 0x80) {
      size_t start = i;
      while (i < s->len && (unsigned char)s->data[i] < 0x80) i++;
      size_t output = b.len;
      scr_jb_write(&b, s->data + start, i - start);
      for (size_t j = output; j < b.len; j++) {
        unsigned char c = (unsigned char)b.data[j];
        if (c >= first && c <= last) b.data[j] = (char)(c ^ 0x20);
      }
      continue;
    }
    size_t adv;
    uint32_t c = scr_case_decode(s->data + i, &adv);
    int l;
    if (c == 0x3a3 && to_lower && scr_final_sigma(s, i, i + adv)) {
      res[0] = 0x3c2; /* final sigma */
      l = 1;
    } else {
      l = lre_case_conv(res, c, to_lower);
    }
    i += adv;
    for (int j = 0; j < l; j++) scr_case_put_cp(&b, res[j]);
  }
  return scr_jb_finish(&b);
}

ScrStr *scr_str_to_lower(const ScrStr *s) { return scr_str_case_conv(s, 1); }
ScrStr *scr_str_to_upper(const ScrStr *s) { return scr_str_case_conv(s, 0); }

static void *scr_normalize_realloc(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  if (!size) { free(ptr); return NULL; }
  return realloc(ptr, size);
}

ScrStr *scr_str_normalize(const ScrStr *s, const ScrStr *form) {
  UnicodeNormalizationEnum mode;
  if (form->len == 3 && !memcmp(form->data, "NFC", 3)) mode = UNICODE_NFC;
  else if (form->len == 3 && !memcmp(form->data, "NFD", 3)) mode = UNICODE_NFD;
  else if (form->len == 4 && !memcmp(form->data, "NFKC", 4)) mode = UNICODE_NFKC;
  else if (form->len == 4 && !memcmp(form->data, "NFKD", 4)) mode = UNICODE_NFKD;
  else {
    static const char message[] = "The normalization form should be one of NFC, NFD, NFKC, NFKD.";
    scr_throw_error(SCR_ERR_RANGE, scr_str_new(message, sizeof message - 1));
    return NULL;
  }
  /* Every ASCII string is already normalized in all four forms. Validate
   * the form first: even an empty subject must reject an invalid form. */
  if (scr_text_ascii(s)) return scr_str_retain((ScrStr *)s);
  if (s->len > INT32_MAX / sizeof(uint32_t)) scr_regex_oom();
  uint32_t *input = malloc((s->len + 1) * sizeof(uint32_t));
  if (!input) scr_regex_oom();
  int length = 0;
  for (size_t offset = 0; offset < s->len;) {
    size_t step;
    input[length++] = scr_case_decode(s->data + offset, &step);
    offset += step;
  }
  uint32_t *output = NULL;
  int count = unicode_normalize(&output, input, length, mode, NULL, scr_normalize_realloc);
  free(input);
  if (count < 0) scr_regex_oom();
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  for (int i = 0; i < count; i++) scr_case_put_cp(&buffer, output[i]);
  free(output);
  return scr_jb_finish(&buffer);
}

/* ── assert.match / assert.doesNotMatch ──────────────────────────────────
 * Lives here because it needs the matcher. Assertion matching follows
 * RegExp.test, including global and sticky lastIndex transitions. */
static bool scr_assert_regex_hits(ScrRegex *re, ScrStr *s) {
  return scr_regex_test(re, s);
}

/* The regex's own inspection — /source/ + FLAGS IN GETTER ORDER
 * (dgimsuvy), not source order. +1. */
static ScrStr *scr_assert_regex_render(ScrRegex *re) {
  size_t cap = re->source->len + re->flags->len + 2;
  char *buf = malloc(cap);
  if (!buf) scr_trap("scriptc: out of memory\n");
  size_t n = 0;
  buf[n++] = '/';
  memcpy(buf + n, re->source->data, re->source->len);
  n += re->source->len;
  buf[n++] = '/';
  for (const char *f = "dgimsuvy"; *f; f++) {
    for (size_t i = 0; i < re->flags->len; i++) {
      if (re->flags->data[i] == *f) buf[n++] = *f;
    }
  }
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

/* Node's regex-mismatch AssertionError: 'The input did not match the
 * regular expression /re/flags. Input:\n\n<inspect(input)>\n' (the
 * was-expected-to-not-match head when negated). Always throws. */
static void scr_assert_regex_input_fail(bool negated, ScrRegex *re, ScrStr *input) {
  ScrStr *insp = scr_assert_inspect_str(input);
  ScrStr *rre = scr_assert_regex_render(re);
  const char *head = negated
      ? "The input was expected to not match the regular expression "
      : "The input did not match the regular expression ";
  const char *mid = ". Input:\n\n";
  size_t cap = strlen(head) + rre->len + strlen(mid) + insp->len + 1;
  char *buf = malloc(cap);
  if (!buf) scr_trap("scriptc: out of memory\n");
  size_t n = 0;
  memcpy(buf + n, head, strlen(head));
  n += strlen(head);
  memcpy(buf + n, rre->data, rre->len);
  n += rre->len;
  memcpy(buf + n, mid, strlen(mid));
  n += strlen(mid);
  memcpy(buf + n, insp->data, insp->len);
  n += insp->len;
  buf[n++] = '\n';
  scr_str_release(insp);
  scr_str_release(rre);
  ScrStr *message = scr_str_new(buf, n);
  free(buf);
  scr_assert_fail_msg(message);
}

void scr_assert_match(ScrStr *s, ScrRegex *re, bool negated, ScrStr *msg,
                      bool has_msg) {
  bool matched = scr_assert_regex_hits(re, s);
  if (negated ? !matched : matched) return;
  if (has_msg) {
    scr_assert_fail_msg(scr_str_retain(msg));
    return;
  }
  scr_assert_regex_input_fail(negated, re, s);
}

/* assert.throws(fn, /re/) whose thrown Error did not satisfy the regex:
 * Node tests String(actual) — Error.prototype.toString's "Name: message"
 * — and reports the mismatch with that string inspected. */
void scr_assert_throws_regex(ScrRegex *re, ScrError *err, ScrStr *msg, bool has_msg) {
  ScrStr *str = scr_error_to_string(err);
  bool matched = scr_assert_regex_hits(re, str);
  if (matched) {
    scr_str_release(str);
    return;
  }
  if (has_msg) {
    scr_str_release(str);
    scr_assert_fail_msg(scr_str_retain(msg));
    return;
  }
  scr_assert_regex_input_fail(false, re, str);
  scr_str_release(str);
}

/* assert.doesNotReject's regex predicate: does String(error) satisfy the
 * regex? Never throws — the caller inverts the verdict into either the
 * unwanted-rejection AssertionError or a rethrow of the original. */
bool scr_assert_regex_err_test(ScrRegex *re, ScrError *err) {
  ScrStr *str = scr_error_to_string(err);
  bool matched = scr_assert_regex_hits(re, str);
  scr_str_release(str);
  return matched;
}

bool scr_assert_regex_dyn_test(ScrRegex *re, ScrDyn *actual) {
  // String(symbol) accepts a direct Symbol; object conversion uses the
  // string hint, including Symbol.toPrimitive and custom Error formatters.
  ScrStr *str = actual->kind == SCR_DYN_SYMBOL
    ? scr_dyn_string_constructor(actual) : scr_util_to_usv_string(actual);
  if (!str) return false;
  bool matched = scr_assert_regex_hits(re, str);
  scr_str_release(str);
  return matched;
}

/* The regex-valued shape slot (assert.throws(fn, {message: /re/})):
 * test the stashed actual key eagerly and store verdict + rendering, so
 * scr_assert.c's comparison and diff stay libregexp-free. An absent
 * actual key (NULL code) is a mismatch — Node's `key in actual` test. */
void scr_assert_shape_re(int key, ScrRegex *re) {
  ScrStr *actual = scr_assert_shape_actual(key);
  bool matched = actual != NULL && scr_assert_regex_hits(re, actual);
  scr_assert_shape_slot_re(key, matched, scr_assert_regex_render(re));
}

/* ── new RegExp(pattern, flags) — runtime construction ────────────────
 * A heap ScrRegex (rc 1) over the same engine the literals use. The
 * pattern compiles EAGERLY so an invalid pattern throws Node's catchable
 * SyntaxError at construction (Node: "Invalid regular expression:
 * /pat/: detail" — the detail text is libregexp's, approximate fidelity
 * by design; e.name is exact). Unknown flag letters throw Node's
 * "Invalid flags supplied to RegExp constructor 'x'". An empty pattern
 * stores the spec's "(?:)" source, like Node. Borrows both; +1. */
/* Compiled-pattern cache for the RegExp constructor. Code that builds the
 * same pattern repeatedly (`new RegExp(word, "i")` inside a per-item
 * helper) recompiled it on every construction. Valid patterns compile to
 * immutable bytecode, so instances share it exactly as literal instances
 * share their template's: an immortal template owns the bytecode (freed at
 * exit with the literal templates) and each instance borrows it through
 * `literal`. Entries are never evicted, because live instances borrow
 * them; past the entry budget, or for long sources, constructions compile
 * privately as before. Invalid patterns are never cached, so each one
 * still throws its SyntaxError.
 *
 * Worker executables (SCR_WORKERS) leave the cache empty: their templates
 * would be thread-local, and a worker's context teardown has no point at
 * which the never-evicted templates could be released after every borrowing
 * instance. Constructions there compile privately. */
enum { SCR_REGEX_CTOR_CAP = 512, SCR_REGEX_CTOR_MAX = 256, SCR_REGEX_CTOR_SOURCE_MAX = 1024 };
typedef struct {
  ScrRegex *shared; /* NULL = empty slot */
  uint64_t hash;
  char *key; /* flags, NUL, source */
  size_t key_len;
} ScrRegexCtorEntry;
static SCR_TL ScrRegexCtorEntry *scr_regex_ctor_table;
static SCR_TL size_t scr_regex_ctor_count;

static uint64_t scr_regex_ctor_hash(const ScrStr *source, const ScrStr *flags) {
  uint64_t h = UINT64_C(1469598103934665603);
  for (size_t i = 0; i < flags->len; i++) h = (h ^ (unsigned char)flags->data[i]) * UINT64_C(1099511628211);
  h = (h ^ 0xFF) * UINT64_C(1099511628211);
  for (size_t i = 0; i < source->len; i++) h = (h ^ (unsigned char)source->data[i]) * UINT64_C(1099511628211);
  return h;
}

static bool scr_regex_ctor_matches(const ScrRegexCtorEntry *e, uint64_t hash,
                                   const ScrStr *source, const ScrStr *flags) {
  return e->hash == hash && e->key_len == flags->len + 1 + source->len &&
         memcmp(e->key, flags->data, flags->len) == 0 && e->key[flags->len] == '\0' &&
         memcmp(e->key + flags->len + 1, source->data, source->len) == 0;
}

static ScrRegex *scr_regex_ctor_lookup(const ScrStr *source, const ScrStr *flags) {
  if (!scr_regex_ctor_table || source->len > SCR_REGEX_CTOR_SOURCE_MAX) return NULL;
  uint64_t hash = scr_regex_ctor_hash(source, flags);
  for (size_t i = hash & (SCR_REGEX_CTOR_CAP - 1);; i = (i + 1) & (SCR_REGEX_CTOR_CAP - 1)) {
    ScrRegexCtorEntry *e = &scr_regex_ctor_table[i];
    if (!e->shared) return NULL;
    /* bc is NULL after the exit-time teardown: compile privately then. */
    if (scr_regex_ctor_matches(e, hash, source, flags)) return e->shared->bc ? e->shared : NULL;
  }
}

/* Move a freshly compiled constructor regex's bytecode into a shared
 * template when the cache has room; the instance then borrows it. */
static void scr_regex_ctor_remember(ScrRegex *re) {
#ifdef SCR_WORKERS
  (void)re;
#else
  if (re->source->len > SCR_REGEX_CTOR_SOURCE_MAX || scr_regex_ctor_count >= SCR_REGEX_CTOR_MAX)
    return;
  if (!scr_regex_ctor_table) {
    scr_regex_ctor_table = calloc(SCR_REGEX_CTOR_CAP, sizeof *scr_regex_ctor_table);
    if (!scr_regex_ctor_table) return;
  }
  size_t key_len = re->flags->len + 1 + re->source->len;
  char *key = malloc(key_len);
  ScrRegex *shared = calloc(1, sizeof *shared);
  if (!key || !shared) {
    free(key);
    free(shared);
    return;
  }
  memcpy(key, re->flags->data, re->flags->len);
  key[re->flags->len] = '\0';
  memcpy(key + re->flags->len + 1, re->source->data, re->source->len);
  shared->rc = SIZE_MAX;
  shared->bc = re->bc;
  shared->native = re->native;
  scr_note_compiled(shared);
  uint64_t hash = scr_regex_ctor_hash(re->source, re->flags);
  size_t i = hash & (SCR_REGEX_CTOR_CAP - 1);
  while (scr_regex_ctor_table[i].shared) i = (i + 1) & (SCR_REGEX_CTOR_CAP - 1);
  scr_regex_ctor_table[i] = (ScrRegexCtorEntry){shared, hash, key, key_len};
  scr_regex_ctor_count++;
  re->literal = shared;
#endif
}

ScrRegex *scr_regex_new(ScrStr *pattern, ScrStr *flags) {
  unsigned seen_flags = 0;
  for (size_t i = 0; i < flags->len; i++) {
    unsigned flag = 0;
    switch (flags->data[i]) {
    case 'g': flag = 1u << 0; break;
    case 'i': flag = 1u << 1; break;
    case 'm': flag = 1u << 2; break;
    case 's': flag = 1u << 3; break;
    case 'u': flag = 1u << 4; break;
    case 'y': flag = 1u << 5; break;
    default: break;
    }
    if (!flag || (seen_flags & flag)) {
      char msg[80];
      int n = snprintf(msg, sizeof msg,
                       "Invalid flags supplied to RegExp constructor '%.20s'",
                       flags->data);
      scr_throw_error_msg(SCR_ERR_SYNTAX, msg, (size_t)n);
      return NULL;
    }
    seen_flags |= flag;
  }
  ScrRegex *re = calloc(1, sizeof *re);
  if (!re) {
    scr_trap("scriptc: out of memory\n");
  }
  re->rc = 1;
  re->source = pattern->len > 0 ? scr_str_retain(pattern) : scr_str_new("(?:)", 4);
  /* Public flags use getter order, independently of constructor spelling.
   * Validate first so duplicates and invalid flags retain their errors. */
  char canonical[6];
  size_t flag_count = 0;
  const char *order = "gimsuy";
  for (unsigned i = 0; i < 6; i++) {
    if (seen_flags & (1u << i)) canonical[flag_count++] = order[i];
  }
  re->flags = flag_count == flags->len && memcmp(canonical, flags->data, flag_count) == 0
    ? scr_str_retain(flags) : scr_str_new(canonical, flag_count);
  ScrRegex *shared = scr_regex_ctor_lookup(re->source, re->flags);
  if (shared) {
    re->literal = shared;
    re->bc = shared->bc;
    re->native = shared->native;
    return re;
  }
  /* Eager compile — the literal path stays lazy (its failure is an
   * abort; tsc already parsed those patterns). */
  int lre_flags = scr_lre_flags(re->flags);
  const char *pat = re->source->data;
  size_t pat_len = re->source->len;
  char *cesu = NULL;
  if (!(lre_flags & LRE_FLAG_UNICODE)) {
    cesu = scr_pattern_cesu8(re->source, &pat_len);
    if (cesu) pat = cesu;
  }
  char error_msg[64];
  int bc_len;
  uint8_t *bc = lre_compile(&bc_len, error_msg, sizeof error_msg, pat, pat_len,
                            lre_flags, lre_opaque());
  free(cesu);
  if (!bc) {
    char msg[192];
    int n = snprintf(msg, sizeof msg, "Invalid regular expression: /%.64s/%.8s: %s",
                     re->source->data, re->flags->data, error_msg);
    scr_str_release(re->source);
    scr_str_release(re->flags);
    free(re);
    scr_throw_error_msg(SCR_ERR_SYNTAX, msg, (size_t)n);
    return NULL;
  }
  re->bc = bc;
  re->native = scr_re_native_build(bc);
  scr_regex_ctor_remember(re);
  return re;
}

/* Decode the code point at p (well-formed UTF-8 by the string
 * invariant); *adv gets the byte length of the sequence. */
static uint32_t scr_re_utf8_decode(const char *p, size_t *adv) {
  unsigned char c = (unsigned char)p[0];
  if (c < 0x80) { *adv = 1; return c; }
  if (c < 0xE0) { *adv = 2; return ((uint32_t)(c & 0x1F) << 6) | ((unsigned char)p[1] & 0x3F); }
  if (c < 0xF0) {
    *adv = 3;
    return ((uint32_t)(c & 0x0F) << 12) | ((uint32_t)((unsigned char)p[1] & 0x3F) << 6) | ((unsigned char)p[2] & 0x3F);
  }
  *adv = 4;
  return ((uint32_t)(c & 0x07) << 18) | ((uint32_t)((unsigned char)p[1] & 0x3F) << 12) |
         ((uint32_t)((unsigned char)p[2] & 0x3F) << 6) | ((unsigned char)p[3] & 0x3F);
}

/* ── RegExp.escape ────────────────────────────────────────────────────
 * ECMA-262 (ES2025) RegExp.escape over the UTF-8 storage. Per-code-point
 * EncodeForRegExpEscape: a LEADING ASCII letter/digit hex-escapes (so a
 * concatenation can't extend a token), SyntaxCharacters and '/' take a
 * backslash, the "other punctuators" ∪ WhiteSpace ∪ LineTerminator set
 * hex-escapes (\xNN below U+0100, \uNNNN above — lowercase hex, per
 * spec), and everything else passes through. The spec's surrogate arm is
 * unreachable over well-formed storage (SEMANTICS.md 2). Borrows s;
 * result +1. */
static bool scr_regexp_syntax_char(uint32_t cp) {
  switch (cp) {
    case '^': case '$': case '\\': case '.': case '*': case '+': case '?':
    case '(': case ')': case '[': case ']': case '{': case '}': case '|':
    case '/':
      return true;
    default:
      return false;
  }
}

/* The ControlEscape arm: TAB/LF/VT/FF/CR escape as \t \n \v \f \r (the
 * spec maps them through ControlEscape before the hex arm). Returns the
 * escape letter, or 0 when cp isn't one of the five. */
static char scr_regexp_control_escape(uint32_t cp) {
  switch (cp) {
    case 0x09: return 't';
    case 0x0A: return 'n';
    case 0x0B: return 'v';
    case 0x0C: return 'f';
    case 0x0D: return 'r';
    default: return 0;
  }
}

static bool scr_regexp_hex_escaped(uint32_t cp) {
  switch (cp) {
    /* other punctuators */
    case ',': case '-': case '=': case '<': case '>': case '#': case '&':
    case '!': case '%': case ':': case ';': case '@': case '~': case '\'':
    case '`': case '"':
      return true;
    /* WhiteSpace ∪ LineTerminator less the ControlEscape five */
    case 0x20: case 0xA0: case 0x1680: case 0x2028: case 0x2029:
    case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
      return true;
    default:
      return cp >= 0x2000 && cp <= 0x200A;
  }
}

/* Encoded byte length of cp at position `first` (raw = its UTF-8 length). */
static size_t scr_regexp_escape_len(uint32_t cp, bool first, size_t raw) {
  if (first && ((cp >= '0' && cp <= '9') || (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z'))) return 4;
  if (scr_regexp_syntax_char(cp) || scr_regexp_control_escape(cp) != 0) return 2;
  if (scr_regexp_hex_escaped(cp)) return cp < 0x100 ? 4 : 6;
  return raw;
}

ScrStr *scr_regexp_escape(ScrStr *s) {
  static const char hex[] = "0123456789abcdef";
  size_t out_len = 0;
  bool first = true;
  for (size_t i = 0; i < s->len;) {
    size_t adv;
    uint32_t cp = scr_re_utf8_decode(s->data + i, &adv);
    out_len += scr_regexp_escape_len(cp, first, adv);
    first = false;
    i += adv;
  }
  if (out_len == s->len) return scr_str_retain(s); /* nothing escapes — share */
  ScrStr *out = scr_str_alloc_raw(out_len, out_len);
  char *w = out->data;
  first = true;
  for (size_t i = 0; i < s->len;) {
    size_t adv;
    uint32_t cp = scr_re_utf8_decode(s->data + i, &adv);
    size_t enc = scr_regexp_escape_len(cp, first, adv);
    if (enc == adv) { /* pass-through: an escape's length never matches raw */
      memcpy(w, s->data + i, adv);
      w += adv;
    } else if (enc == 2) {
      char ctl = scr_regexp_control_escape(cp);
      *w++ = '\\';
      *w++ = ctl != 0 ? ctl : (char)cp;
    } else if (enc == 4) {
      *w++ = '\\';
      *w++ = 'x';
      *w++ = hex[(cp >> 4) & 0xF];
      *w++ = hex[cp & 0xF];
    } else {
      *w++ = '\\';
      *w++ = 'u';
      *w++ = hex[(cp >> 12) & 0xF];
      *w++ = hex[(cp >> 8) & 0xF];
      *w++ = hex[(cp >> 4) & 0xF];
      *w++ = hex[cp & 0xF];
    }
    first = false;
    i += adv;
  }
  out->len = out_len;
  out->data[out_len] = '\0';
  return out;
}

/* Checked storage retains the native pattern; no JavaScript engine is needed. */
bool scr_dyn_native_regex_is(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_REGEXP;
}

ScrRegex *scr_dyn_native_regex_check(const ScrDyn *value, const ScrDynPath *path) {
  if (!scr_dyn_native_regex_is(value)) { scr_dyn_check_fail(path, "RegExp", value); return NULL; }
  return scr_regex_retain(value->v.handle.ptr);
}

static ScrDyn *scr_native_regex_string(ScrStr *text) {
  if (!text) return NULL;
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}

static ScrDyn *scr_native_regex_get(void *ptr, const char *key, size_t len) {
  ScrRegex *re = ptr;
  if (len == 6 && memcmp(key, "source", 6) == 0) return scr_native_regex_string(scr_regex_source(re));
  if (len == 5 && memcmp(key, "flags", 5) == 0) return scr_native_regex_string(scr_regex_flags(re));
  if (len == 9 && memcmp(key, "lastIndex", 9) == 0) return scr_dyn_new_num(re->last_index);
  static const struct { const char *name; char flag; } flags[] = {
    {"global", 'g'}, {"ignoreCase", 'i'}, {"multiline", 'm'}, {"dotAll", 's'},
    {"unicode", 'u'}, {"sticky", 'y'}, {"hasIndices", 'd'}, {"unicodeSets", 'v'},
  };
  for (size_t i = 0; i < sizeof flags / sizeof flags[0]; i++) {
    if (strlen(flags[i].name) == len && memcmp(key, flags[i].name, len) == 0)
      return scr_dyn_new_bool(memchr(re->flags->data, flags[i].flag, re->flags->len) != NULL);
  }
  static const char *const methods[] = {"test", "exec", "toString", "compile"};
  for (size_t i = 0; i < sizeof methods / sizeof methods[0]; i++) {
    if (strlen(methods[i]) == len && memcmp(key, methods[i], len) == 0) {
      static const char message[] = "Native RegExp method values have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      break;
    }
  }
  return NULL;
}

static bool scr_native_regex_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  if (len == 9 && memcmp(key, "lastIndex", 9) == 0) {
    if (value->kind != SCR_DYN_NUM) {
      static const char message[] = "Non-numeric RegExp.lastIndex values have no native lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return true;
    }
    ((ScrRegex *)ptr)->last_index = value->v.num;
    return true;
  }
  return false;
}

static ScrDyn *scr_native_regex_invoke(void *ptr, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  (void)self; (void)what;
  ScrRegex *re = ptr;
  if (strcmp(method, "toString") == 0) return scr_native_regex_string(scr_regex_to_string(re));
  if (strcmp(method, "test") == 0) {
    ScrStr *subject = scr_dyn_string_coerce_js(argc ? args[0] : scr_dyn_undefined());
    if (!subject) return NULL;
    bool matches = scr_regex_test(re, subject);
    scr_str_release(subject);
    return scr_exc_pending() ? NULL : scr_dyn_new_bool(matches);
  }
  static const char message[] = "Native RegExp method has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

ScrDyn *scr_dyn_native_regex(ScrRegex *value) {
  static const ScrDynHandleOps ops = {
    "RegExp", &scr_regex_retain_v, &scr_regex_release_v, &scr_native_regex_invoke,
    &scr_native_regex_get, &scr_native_regex_set, NULL, NULL,
  };
  scr_dyn_handle_install(SCR_DYNH_REGEXP, &ops);
  return scr_dyn_new_handle(value, SCR_DYNH_REGEXP);
}

ScrRegex *scr_regex_new_checked(const ScrDyn *pattern, const ScrDyn *flags) {
  ScrRegex *original = scr_dyn_native_regex_is(pattern) ? pattern->v.handle.ptr : NULL;
  ScrStr *source = original ? scr_regex_source(original)
    : pattern->kind == SCR_DYN_UNDEF ? scr_str_new("", 0) : scr_dyn_string_coerce_js(pattern);
  if (!source) return NULL;
  ScrStr *options = flags->kind == SCR_DYN_UNDEF
    ? original ? scr_regex_flags(original) : scr_str_new("", 0)
    : scr_dyn_string_coerce_js(flags);
  ScrRegex *result = options ? scr_regex_new(source, options) : NULL;
  scr_str_release(source);
  scr_str_release(options);
  return result;
}
