
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

/* The plain-text form of a pattern rides on its matcher (see
 * scr_regex_plain_text): NULL when there is none. */
static inline const ScrStr *scr_regex_lit(const ScrRegex *re) {
  const ScrReNative *native = re->native;
  return native ? (const ScrStr *)native->lit : NULL;
}

static void scr_regex_native_free(void *native) {
  if (!native) return;
  free(((ScrReNative *)native)->lit);
  scr_re_native_free(native);
}

static SCR_TL ScrRegex **scr_compiled = NULL;
static SCR_TL size_t scr_compiled_len = 0, scr_compiled_cap = 0;

static void scr_regex_free_bytecodes(void) {
  for (size_t i = 0; i < scr_compiled_len; i++) {
    lre_realloc(lre_opaque(), scr_compiled[i]->bc, 0);
    scr_compiled[i]->bc = NULL;
    scr_regex_native_free(scr_compiled[i]->native);
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
      case 'v': mask |= LRE_FLAG_UNICODE_SETS; break;
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

/* A pattern that matches exactly its own text: printable ASCII with no
 * syntax characters (an escaped syntax character or '/' stands for
 * itself), no sticky anchoring, and no case folding unless it has no
 * letters. Multiline, dotAll, global and unicode do not change what such a
 * pattern matches. Every byte match of an ASCII needle in WTF-8 storage
 * is a code-unit match at the same position. Returns an immortal string
 * owned by the matcher (freed with it), or NULL. */
static ScrStr *scr_regex_plain_text(const ScrRegex *re) {
  const ScrStr *flags = re->flags;
  bool fold = false;
  for (size_t i = 0; i < flags->len; i++) {
    if (flags->data[i] == 'y') return NULL;
    if (flags->data[i] == 'i') fold = true;
  }
  const ScrStr *src = re->source;
  if (src->len == 0 || src->len > 256) return NULL;
  char text[256];
  size_t n = 0;
  for (size_t i = 0; i < src->len; i++) {
    unsigned char c = (unsigned char)src->data[i];
    if (c == '\\') {
      if (i + 1 >= src->len) return NULL;
      c = (unsigned char)src->data[++i];
      if (!strchr("^$\\.*+?()[]{}|/", c) || c == '\0') return NULL;
    } else if (c < 0x20 || c >= 0x7F || strchr("^$.*+?()[]{}|", c)) {
      return NULL;
    }
    if (fold && ((c | 0x20) >= 'a' && (c | 0x20) <= 'z')) return NULL;
    text[n++] = (char)c;
  }
  ScrStr *lit = malloc(sizeof(ScrStr) + n + 1);
  if (!lit) scr_regex_oom();
  memset(lit, 0, sizeof(ScrStr));
  lit->rc = SIZE_MAX;
  lit->len = n;
  lit->cap = (uint32_t)n;
  lit->ascii = 1;
  memcpy(lit->data, text, n);
  lit->data[n] = '\0';
  return lit;
}

static void *scr_regex_native_build(const ScrRegex *re, const uint8_t *bc) {
  ScrReNative *native = scr_re_native_build(bc);
  if (native) native->lit = scr_regex_plain_text(re);
  return native;
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
  if (!(flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS))) {
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
  re->native = scr_regex_native_build(re, bc);
  /* A build-time matcher must agree with the bytecode's capture count. */
  if (re->matcher && re->matcher(NULL, -1, 0, NULL) != lre_get_capture_count(bc))
    re->matcher = NULL;
  scr_note_compiled(re);
  return bc;
}

void scr_regex_stack_grow(int32_t **stack, int32_t *cap, int32_t *inline_buf, int32_t need) {
  size_t ncap = (size_t)*cap * 2;
  if (ncap < (size_t)need) ncap = (size_t)need;
  if (ncap > (size_t)INT32_MAX) scr_regex_oom();
  int32_t *grown;
  if (*stack == inline_buf) {
    grown = malloc(ncap * sizeof *grown);
    if (grown) memcpy(grown, *stack, (size_t)*cap * sizeof *grown);
  } else {
    grown = realloc(*stack, ncap * sizeof *grown);
  }
  if (!grown) scr_regex_oom();
  *stack = grown;
  *cap = (int32_t)ncap;
}

void scr_regex_stack_free(int32_t *stack) { free(stack); }

/* The build-time matcher of a regex (literal instances use their
 * template's). */
static inline ScrRegexMatcherFn scr_regex_matcher(const ScrRegex *re) {
  return re->literal ? re->literal->matcher : re->matcher;
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
      scr_regex_native_free(re->native);
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

/* Subject as freshly-malloc'd UTF-16 code units (strings are canonical
 * WTF-8, so no validation; a lone surrogate decodes as its unit). Unit
 * count ≤ byte count. */
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
 * keeps that half as a lone surrogate, as in the runtime's string slicing
 * contract. */
static uint32_t scr_regex_codepoint(const uint16_t *units, int *index, int end) {
  uint32_t cp = units[(*index)++];
  if (cp >= 0xD800 && cp < 0xDC00 && *index < end &&
      units[*index] >= 0xDC00 && units[*index] < 0xE000)
    return 0x10000 + ((cp - 0xD800) << 10) + (units[(*index)++] - 0xDC00);
  return cp;
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
    if (cp >= 0xD800 && cp <= 0xDFFF) scr_wtf8_note(); /* half of a split pair */
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

/* Out of line, so one-byte subjects' span writes keep a small frame. */
__attribute__((noinline)) static void scr_jb_put_utf16(ScrJsonBuf *b, const uint16_t *u, int start,
                                                       int end) {
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
  ScrRegexMatcherFn matcher; /* one-byte subjects of build-time matchers */
  int len;
  int wide;
  bool borrowed_utf16; /* utf16 belongs to the subject cache below */
  uint8_t **capture;
  uint8_t *registers[32];
} ScrRegexInput;

static bool scr_text_ascii(const ScrStr *s) {
  if (scr_str_known_ascii(s)) return true;
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
  input->matcher = input->wide ? NULL : scr_regex_matcher(re);
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
  input->matcher = input->wide ? NULL : scr_regex_matcher(re);
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

/* The bytecode engines; kept out of line so a build-time matcher call does
 * not pay their frame. */
__attribute__((noinline)) static int scr_exec_engine(ScrRegexInput *input, const uint8_t *bc,
                                                     int index) {
  int rc = input->native
    ? scr_re_native_exec(input->native, input->capture, input->data, index, input->len)
    : lre_exec(input->capture, bc, input->data, index, input->len, input->wide, lre_opaque());
  if (rc < 0) {
    fflush(stdout);
    scr_trap("scriptc: regular expression execution failed\n");
  }
  return rc;
}

/* Build-time matchers trap on allocation failure themselves. */
static inline int scr_exec(ScrRegexInput *input, const uint8_t *bc, int index) {
  if (input->matcher) return input->matcher(input->data, input->len, index, input->capture);
  return scr_exec_engine(input, bc, index);
}

static int scr_capture_index(const ScrRegexInput *input, const uint8_t *capture) {
  return (int)((capture - input->data) >> input->wide);
}

static void scr_regex_put_span(ScrJsonBuf *b, const ScrRegexInput *input,
                                int start, int end) {
  if (input->wide) scr_jb_put_utf16(b, input->utf16, start, end);
  else scr_jb_write(b, (const char *)input->data + start, (size_t)(end - start));
}

/* Captures have a known span: allocate its exact UTF-8 length instead of
 * inheriting a general builder's size hint from an earlier document. Out of
 * line, like scr_jb_put_utf16. */
__attribute__((noinline)) static ScrStr *scr_regex_span_utf16(const uint16_t *u, int start,
                                                              int end) {
  size_t bytes = 0;
  for (int i = start; i < end;) {
    uint32_t cp = scr_regex_codepoint(u, &i, end);
    size_t width = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (width > SIZE_MAX - sizeof(ScrStr) - 1 - bytes) scr_regex_oom();
    bytes += width;
  }
  ScrStr *out = scr_str_alloc_raw(bytes, bytes);
  size_t offset = 0;
  for (int i = start; i < end;)
    offset += scr_regex_encode(out->data + offset, scr_regex_codepoint(u, &i, end));
  out->data[bytes] = '\0';
  return out;
}

static ScrStr *scr_regex_span(const ScrRegexInput *input, int start, int end) {
  if (input->wide) return scr_regex_span_utf16(input->utf16, start, end);
  return scr_str_new((const char *)input->data + start, (size_t)(end - start));
}

/* ── match metadata ───────────────────────────────────────────────────── */

/* Results of one exec or matchAll call share their subject and regex
 * through one match source handle, which each result's metadata slot
 * holds with its start index until the metadata object (index, input,
 * groups) is first needed: when the result is converted to a dynamic
 * value or its groups are read. Results read only through their elements
 * never allocate it, and releasing a result releases the handle with the
 * rest of its metadata. */
typedef struct ScrRegexMatchSource {
  size_t rc;
  ScrStr *input;
  ScrRegex *re;
  ScrDyn *input_value; /* `input` as a dynamic value, built on first use */
} ScrRegexMatchSource;

static bool scr_regex_copy_pending_metadata(ScrArr *a, ScrDyn *target);

static void *scr_regex_source_retain_v(void *p) {
  ((ScrRegexMatchSource *)p)->rc++;
  return p;
}

static void scr_regex_source_release_v(void *p) {
  ScrRegexMatchSource *src = p;
  if (--src->rc != 0) return;
  scr_str_release(src->input);
  scr_regex_release(src->re);
  scr_dyn_release(src->input_value);
  free(src);
}

/* The +1 match source handle of one exec or matchAll call. */
static ScrDyn *scr_regex_source_new(ScrStr *s, ScrRegex *re) {
  static const ScrDynHandleOps ops = {
    "MatchSource", &scr_regex_source_retain_v, &scr_regex_source_release_v, NULL, NULL, NULL, NULL,
  };
  scr_dyn_handle_install(SCR_DYNH_MATCH_SOURCE, &ops);
  scr_arr_match_copy = &scr_regex_copy_pending_metadata;
  ScrRegexMatchSource *src = malloc(sizeof *src);
  if (!src) scr_regex_oom();
  src->rc = 0;
  src->input = scr_str_retain(s);
  src->re = scr_regex_retain(re);
  src->input_value = NULL;
  return scr_dyn_new_handle(src, SCR_DYNH_MATCH_SOURCE);
}

/* Records the match at UTF-16 `index` as the row's pending metadata. */
static void scr_regex_defer_metadata(ScrArr *row, ScrDyn *source, int index) {
  ScrArrExt *x = scr_arr_ext(row);
  x->metadata = scr_dyn_retain(source);
  x->match_index = (double)index;
}

/* The pending match source of a result, or NULL once its metadata exists. */
static ScrRegexMatchSource *scr_regex_pending(const ScrArr *a) {
  const ScrDyn *metadata = scr_arr_ext_of(a) ? scr_arr_ext_of(a)->metadata : NULL;
  if (!metadata || metadata->kind != SCR_DYN_HANDLE || metadata->v.handle.tag != SCR_DYNH_MATCH_SOURCE)
    return NULL;
  return metadata->v.handle.ptr;
}

/* The subject as a dynamic value, shared by the source's results. +1. */
static ScrDyn *scr_regex_source_input(ScrRegexMatchSource *src) {
  if (!src->input_value) src->input_value = scr_dyn_new_str(src->input);
  return scr_dyn_retain(src->input_value);
}

/* groups is a null-prototype object mapping each group name to its first
 * participating capture (the row's own string, shared) or undefined, and
 * undefined itself for a pattern without named groups. The row holds each
 * capture as a string or a present undefined. +1. */
static ScrDyn *scr_regex_groups_of(const ScrArr *a, uint8_t *bc) {
  const char *groupnames = lre_get_groupnames(bc);
  if (!groupnames) return scr_dyn_retain(scr_dyn_undefined());
  int capture_count = lre_get_capture_count(bc);
  ScrDyn *groups = scr_dyn_new_obj_null_proto();
  const char *name = groupnames;
  for (int k = 1; k < capture_count; k++) {
    size_t length = strlen(name);
    bool matched = (size_t)k < a->len && (size_t)k < a->cap &&
                   scr_arr_dense_state(a, (size_t)k) == SCR_ARR_VALUE;
    /* ES2025 duplicates sit in distinct alternatives: at most one
     * participates, and it wins over an earlier undefined. */
    if (length && (matched || !scr_dyn_obj_get(groups, name, length)))
      scr_dyn_obj_set(groups, name, length,
                      matched ? scr_dyn_new_str((ScrStr *)(uintptr_t)a->data[k])
                              : scr_dyn_retain(scr_dyn_undefined()));
    name += length + LRE_GROUP_NAME_TRAILER_LEN;
  }
  return groups;
}

static void scr_regex_materialize_metadata(ScrArr *a) {
  ScrRegexMatchSource *src = scr_regex_pending(a);
  if (!src) return;
  ScrArrExt *x = scr_arr_ext_of(a);
  ScrDyn *source = x->metadata;
  ScrDyn *props = scr_dyn_new_obj();
  scr_dyn_obj_set(props, "index", 5, scr_dyn_new_num(x->match_index));
  scr_dyn_obj_set(props, "input", 5, scr_regex_source_input(src));
  scr_dyn_obj_set(props, "groups", 6, scr_regex_groups_of(a, scr_regex_bc(src->re)));
  x->metadata = props;
  scr_dyn_release(source);
}

static bool scr_regex_copy_pending_metadata(ScrArr *a, ScrDyn *target) {
  ScrRegexMatchSource *src = scr_regex_pending(a);
  if (target->kind != SCR_DYN_ARR || target->v.arr.properties || target->non_extensible ||
      target->v.arr.frozen) {
    scr_regex_materialize_metadata(a);
    return false;
  }
  scr_dyn_arr_named_put(target, "index", 5, scr_dyn_new_num(scr_arr_ext_of(a)->match_index));
  scr_dyn_arr_named_put(target, "input", 5, scr_regex_source_input(src));
  scr_dyn_arr_named_put(target, "groups", 6, scr_regex_groups_of(a, scr_regex_bc(src->re)));
  return true;
}

ScrDyn *scr_regex_result_prop(ScrArr *a, ScrStr *key) {
  ScrRegexMatchSource *src = scr_regex_pending(a);
  if (src) {
    if (key->len == 5 && memcmp(key->data, "index", 5) == 0)
      return scr_dyn_new_num(scr_arr_ext_of(a)->match_index);
    if (key->len == 5 && memcmp(key->data, "input", 5) == 0) return scr_regex_source_input(src);
    scr_regex_materialize_metadata(a);
  }
  ScrDyn *metadata = scr_arr_ext_of(a) ? scr_arr_ext_of(a)->metadata : NULL;
  ScrDyn *value = metadata ? scr_dyn_obj_get(metadata, key->data, key->len) : NULL;
  return scr_dyn_retain(value ? value : scr_dyn_undefined());
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
  bool stateful = (lre_get_flags(bc) & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) != 0;
  const ScrStr *lit = scr_regex_lit(re);
  if (lit && !stateful) return scr_str_find_bytes(s->data, s->len, lit->data, lit->len) != NULL;
  ScrRegexInput input;
  scr_regex_input_init_cached(&input, re, bc, s);
  int pos = stateful ? scr_regex_start(re, input.len) : 0;
  int rc = pos < 0 ? 0 : scr_exec(&input, bc, pos);
  if (stateful) re->last_index = rc == 1
    ? (double)scr_capture_index(&input, input.capture[1]) : 0;
  scr_regex_input_dispose(&input);
  return rc == 1;
}

/* ── match ────────────────────────────────────────────────────────────── */

/* Lazily materialized captures. A capture the compiler proved is only
 * compared with a literal or converted to a number stays a span when the
 * engine matched the subject's own bytes (an ASCII subject):
 * its slot is a present undefined whose payload word packs the capture's
 * byte offsets (start << 32 | end), SCR_RE_NO_SPAN when it did not
 * participate, and the retained subject is appended after the captures.
 * The compiler reads such a result only through constant indices below
 * the capture count, so neither the extra element nor the undefined slots
 * are observable. Every other case stores lazy captures as strings, and
 * non-participating lazy captures keep SCR_RE_NO_SPAN. */
#define SCR_RE_NO_SPAN UINT64_MAX

static uint64_t scr_regex_mask_bits(double mask) {
  return mask >= 0 && mask < 18446744073709551616.0 ? (uint64_t)mask : UINT64_MAX;
}

/* Slot k of an exec result: a nonparticipating or unselected capture is a
 * present undefined (SCR_RE_NO_SPAN when lazy), a lazy capture of an ASCII
 * subject is a span word, and every other capture a fresh string. */
static inline void scr_regex_fill_slot(const ScrRegexInput *input, uint64_t *data,
                                       uint8_t *states, int k, uint64_t mask, uint64_t lazy,
                                       bool spans) {
  const uint8_t *cs = input->capture[2 * k], *ce = input->capture[2 * k + 1];
  bool deferred = k < 64 && (lazy >> k & 1);
  uint64_t word = 0;
  uint8_t state = SCR_ARR_UNDEFINED;
  if (cs == NULL || ce == NULL || (k < 64 && !(mask >> k & 1))) {
    if (deferred) word = SCR_RE_NO_SPAN;
  } else if (deferred && spans) {
    word = (uint64_t)(cs - input->data) << 32 | (uint64_t)(ce - input->data);
  } else {
    ScrStr *text =
        scr_regex_span(input, scr_capture_index(input, cs), scr_capture_index(input, ce));
    word = (uint64_t)(uintptr_t)text;
    state = SCR_ARR_VALUE;
  }
  data[k] = word;
  *scr_arr_state_in(states, (size_t)k) = state;
}

/* re.exec(s): a fresh string[] of [whole match, ...captures], or NULL
 * for no match (the compiler wraps the `string[] | null` union). Global
 * and sticky regexes start at lastIndex, set it to the match end, and
 * reset it on failure. Nonparticipating captures are present undefined
 * elements, distinct from participating empty captures and array holes. */
static ScrArr *scr_regex_exec_core(ScrStr *s, ScrRegex *re, uint64_t mask, bool metadata,
                                   uint64_t lazy) {
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
    bool spans = lazy != 0 && !input.wide && (count >= 64 || ((mask | lazy) >> count) == 0);
    out = scr_arr_new_inline(SCR_ELEM_STR, (size_t)count + spans, true);
    /* A fresh dense array: every slot is written directly, then the
     * hole-free prefix is the run of materialized captures from 0. Its
     * storage pointers are fixed (the inline block never moves here), so
     * they stay in registers across the slot stores. */
    size_t n = (size_t)count + spans;
    uint64_t *data = out->data;
    uint8_t *states = scr_arr_states_end(out);
    if (count <= 64) {
      /* Captures neither selected nor lazy are present undefined with a
       * zero payload; only the selected and lazy ones need a decision. */
      memset(data, 0, (size_t)count * sizeof *data);
      memset(states - count, SCR_ARR_UNDEFINED, (size_t)count);
      uint64_t visit = mask | lazy;
      if (count < 64) visit &= (UINT64_C(1) << count) - 1;
      while (visit) {
        int k = __builtin_ctzll(visit);
        visit &= visit - 1;
        scr_regex_fill_slot(&input, data, states, k, mask, lazy, spans);
      }
    } else {
      for (int k = 0; k < count; k++)
        scr_regex_fill_slot(&input, data, states, k, mask, lazy, spans);
    }
    if (spans) {
      data[count] = (uint64_t)(uintptr_t)scr_str_retain(s);
      *scr_arr_state_in(states, count) = SCR_ARR_VALUE;
    }
    size_t filled = 0;
    while (filled < n && *scr_arr_state_in(states, filled) == SCR_ARR_VALUE) filled++;
    out->filled = (uint32_t)filled;
    out->len = n;
    if (metadata) {
      ScrDyn *source = scr_regex_source_new(s, re);
      scr_regex_defer_metadata(out, source, scr_capture_index(&input, capture[0]));
      scr_dyn_release(source);
    }
  }
  scr_regex_input_dispose(&input);
  return out; /* +1, or NULL (no match) */
}

ScrArr *scr_regex_exec(ScrStr *s, ScrRegex *re) {
  return scr_regex_exec_core(s, re, UINT64_MAX, true, 0);
}

/* Unselected captures are present undefined elements: nothing reads them. */
ScrArr *scr_regex_exec_groups(ScrStr *s, ScrRegex *re, double mask) {
  return scr_regex_exec_core(s, re, scr_regex_mask_bits(mask), false, 0);
}

ScrArr *scr_regex_exec_spans(ScrStr *s, ScrRegex *re, double mask, double lazy) {
  return scr_regex_exec_core(s, re, scr_regex_mask_bits(mask), false, scr_regex_mask_bits(lazy));
}

/* The bytes of capture k, false when it reads as undefined. */
static bool scr_regex_group_bytes(const ScrArr *m, double k, const char **p, size_t *n) {
  /* Array lengths stay below 2^53, so signed conversions are exact. */
  if (!(k >= 0 && k < (double)(int64_t)m->len)) return false;
  size_t i = (size_t)(int64_t)k;
  uint8_t state = scr_arr_dense_state(m, i);
  if (state == SCR_ARR_VALUE) {
    const ScrStr *str = (const ScrStr *)(uintptr_t)m->data[i];
    *p = str->data;
    *n = str->len;
    return true;
  }
  uint64_t span = m->data[i];
  if (state != SCR_ARR_UNDEFINED || span == SCR_RE_NO_SPAN) return false;
  const ScrStr *subject = (const ScrStr *)(uintptr_t)m->data[m->len - 1];
  *p = subject->data + (span >> 32);
  *n = (size_t)((span & UINT32_MAX) - (span >> 32));
  return true;
}

bool scr_regex_group_eq(ScrArr *m, double k, ScrStr *lit) {
  const char *p;
  size_t n;
  return scr_regex_group_bytes(m, k, &p, &n) && n == lit->len && memcmp(p, lit->data, n) == 0;
}

double scr_regex_group_number(ScrArr *m, double k) {
  const char *p;
  size_t n;
  return scr_regex_group_bytes(m, k, &p, &n) ? scr_bytes_to_number(p, n) : NAN;
}

double scr_regex_group_parse_int(ScrArr *m, double k, double radix) {
  const char *p;
  size_t n;
  /* parseInt(undefined, radix) parses the string "undefined". */
  if (!scr_regex_group_bytes(m, k, &p, &n)) return scr_parse_int_bytes("undefined", 9, radix);
  double fast;
  if (radix == 10 && scr_parse_int_short_digits(p, n, &fast)) return fast;
  return scr_parse_int_bytes(p, n, radix);
}

/* Global Symbol.match always starts at zero and drains whole matches,
 * ignoring capture groups. Its terminating failed exec resets lastIndex
 * to zero, so no state escapes this internal iteration. Sticky globals
 * stop at the first gap; empty matches advance by a Unicode code point
 * under /u and by one UTF-16 unit otherwise. */
ScrArr *scr_regex_match_groups(ScrStr *s, ScrRegex *re, double mask, double lazy) {
  if (lre_get_flags(scr_regex_bc(re)) & LRE_FLAG_GLOBAL) return scr_regex_match(s, re);
  return scr_regex_exec_spans(s, re, mask, lazy);
}

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
  const ScrStr *lit = scr_regex_lit(re);
  if (lit) {
    const char *hit = scr_str_find_bytes(s->data, s->len, lit->data, lit->len);
    if (!hit) return -1;
    /* UTF-16 units before the match: one per UTF-8 lead byte, two for an
     * astral (4-byte) lead. */
    double units = 0;
    for (const char *p = s->data; p < hit; p++) {
      unsigned char c = (unsigned char)*p;
      if ((c & 0xC0) != 0x80) units += c >= 0xF0 ? 2 : 1;
    }
    return units;
  }
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
 * the companion array the for-of-over-matchAll desugar reads). With
 * `metadata`, each row records the match source for its index, input and
 * groups properties. */
static ScrArr *scr_regex_match_all_core(ScrStr *s, ScrRegex *re, ScrArr *indices,
                                        bool metadata) {
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
  ScrDyn *source = metadata ? scr_regex_source_new(s, re) : NULL;
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
    /* One allocation per row, like an exec result: every slot is written
     * directly, then the hole-free prefix is the run of captures from 0.
     * A row needs states only for a capture that did not participate. */
    bool all = true;
    for (int k = 0; k < capture_count; k++) all &= capture[2 * k] != NULL && capture[2 * k + 1] != NULL;
    ScrArr *row = scr_arr_new_inline(SCR_ELEM_STR, (size_t)capture_count, !all);
    uint64_t *data = row->data;
    uint8_t *states = all ? NULL : scr_arr_states_end_w(row, 8);
    for (int k = 0; k < capture_count; k++) {
      const uint8_t *cs = capture[2 * k], *ce = capture[2 * k + 1];
      if (cs == NULL || ce == NULL) {
        data[k] = 0;
        *scr_arr_state_in(states, (size_t)k) = SCR_ARR_UNDEFINED;
      } else {
        ScrStr *text =
            scr_regex_span(&input, scr_capture_index(&input, cs), scr_capture_index(&input, ce));
        data[k] = (uint64_t)(uintptr_t)text;
        if (states) *scr_arr_state_in(states, (size_t)k) = SCR_ARR_VALUE;
      }
    }
    size_t filled = 0;
    while (filled < (size_t)capture_count && (!states || *scr_arr_state_in(states, filled) == SCR_ARR_VALUE))
      filled++;
    row->filled = (uint32_t)filled;
    row->len = (size_t)capture_count;
    if (source) scr_regex_defer_metadata(row, source, start);
    scr_arr_push_ref(out, row);
    if (indices != NULL) scr_arr_push_f64(indices, (double)start);
    pos = end == start ? scr_advance(&input, end, unicode) : end;
  }
  scr_dyn_release(source);
  scr_regex_input_dispose(&input);
  return out; /* +1 (possibly empty — Node's no-match drain is []) */
}

ScrArr *scr_regex_match_all(ScrStr *s, ScrRegex *re) {
  return scr_regex_match_all_core(s, re, NULL, true);
}

ScrArr *scr_regex_match_all_captures(ScrStr *s, ScrRegex *re) {
  return scr_regex_match_all_core(s, re, NULL, false);
}

ScrArr *scr_regex_match_all_into(ScrStr *s, ScrRegex *re, ScrArr *indices) {
  return scr_regex_match_all_core(s, re, indices, true);
}

ScrArr *scr_regex_match_all_captures_into(ScrStr *s, ScrRegex *re, ScrArr *indices) {
  return scr_regex_match_all_core(s, re, indices, false);
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

/* ── direct replace over a build-time matcher ─────────────────────────
 * An ASCII subject of a regex with a build-time matcher needs no engine
 * input and no generic builder: the matcher reports byte boundaries and
 * the result string is written in place. The replacement template is
 * decoded once per call into literal runs and capture references; the
 * position-dependent directives ($`, $', $<name>) keep the general loop. */

enum { SCR_RE_TEMPLATE_MAX = 16 };

typedef struct {
  int32_t capture; /* -1: the literal run rep[off, off + len) */
  int32_t off, len;
} ScrReTemplateOp;

/* GetSubstitution's scan, restricted to $$, $& and $n/$nn; mirrors
 * scr_put_substitution's digit and out-of-range rules exactly. Returns
 * the op count, or -1 when the template needs the general loop. */
static int scr_re_template_ops(const ScrStr *rep, int capture_count, bool named,
                               ScrReTemplateOp *ops) {
  int n = 0;
  size_t i = 0, run = 0;
#define SCR_RE_OP(cap, o, l)                                                  \
  do {                                                                        \
    if (n == SCR_RE_TEMPLATE_MAX) return -1;                                  \
    ops[n++] = (ScrReTemplateOp){ (cap), (int32_t)(o), (int32_t)(l) };       \
  } while (0)
  while (i < rep->len) {
    if (rep->data[i] != '$' || i + 1 >= rep->len) {
      i++;
      continue;
    }
    char c1 = rep->data[i + 1];
    if (c1 == '$') {
      SCR_RE_OP(-1, run, i + 1 - run); /* keep one '$' */
      i += 2;
      run = i;
    } else if (c1 == '&') {
      if (i > run) SCR_RE_OP(-1, run, i - run);
      SCR_RE_OP(0, 0, 0);
      i += 2;
      run = i;
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
        if (i > run) SCR_RE_OP(-1, run, i - run);
        SCR_RE_OP(k, 0, 0);
        i += adv;
        run = i;
      } else {
        i++; /* a literal '$' */
      }
    } else if (c1 == '`' || c1 == '\'' || (c1 == '<' && named)) {
      return -1;
    } else {
      i++;
    }
  }
  if (i > run) SCR_RE_OP(-1, run, i - run);
#undef SCR_RE_OP
  return n;
}

/* The result string of the direct loop, written in place: `cap` caches
 * the block's capacity so a piece costs one compare. */
typedef struct {
  ScrStr *s;
  char *data;
  size_t len;
  size_t cap;
} ScrReOut;

static ScrReOut scr_re_out_grow(ScrReOut o, size_t n) {
  if (n > SCR_STR_MAX_CAP - o.len) scr_regex_oom();
  size_t cap = o.cap * 2;
  if (cap < o.len + n) cap = o.len + n;
  if (cap > SCR_STR_MAX_CAP) cap = SCR_STR_MAX_CAP;
  o.s->len = o.len;
  o.s = scr_str_regrow(o.s, cap);
  o.data = o.s->data;
  o.cap = o.s->cap;
  return o;
}

static inline void scr_re_out_put(ScrReOut *o, const char *p, size_t n) {
  if (n > o->cap - o->len) *o = scr_re_out_grow(*o, n);
  scr_copy_bytes(o->data + o->len, p, n);
  o->len += n;
}

/* The replace loop of scr_replace_impl for an ASCII subject and a
 * build-time matcher. NULL when the template needs the general loop. */
static ScrStr *scr_replace_matcher(ScrStr *s, ScrRegex *re, ScrStr *rep,
                                   ScrRegexInput *input, int capture_count,
                                   bool named, bool global, bool sticky) {
  ScrReTemplateOp ops[SCR_RE_TEMPLATE_MAX];
  int nops = scr_re_template_ops(rep, capture_count, named, ops);
  if (nops < 0) return NULL;
  /* A template without captures is one literal run (or none). */
  bool plain = nops == 0 || (nops == 1 && ops[0].capture < 0);
  const char *plain_text = nops ? rep->data + ops[0].off : NULL;
  size_t plain_len = nops ? (size_t)ops[0].len : 0;
  ScrRegexMatcherFn matcher = input->matcher;
  const uint8_t *data = input->data;
  const char *text = (const char *)data;
  int len = input->len;
  uint8_t **capture = input->capture;
  if (global) re->last_index = 0;
  int next = 0, pos = sticky ? scr_regex_start(re, len) : 0;
  if (pos < 0) pos = len + 1;
  if (sticky && !global) re->last_index = 0;
  ScrReOut out = { NULL, NULL, 0, 0 };
  while (pos <= len) {
    if (matcher(data, len, pos, capture) != 1) break;
    int start = (int)(capture[0] - data);
    int end = (int)(capture[1] - data);
    if (sticky && !global) re->last_index = end;
    if (!out.s) {
      out.s = scr_str_alloc_raw(0, (size_t)len + 16);
      out.data = out.s->data;
      out.cap = out.s->cap;
    }
    scr_re_out_put(&out, text + next, (size_t)(start - next));
    if (plain) {
      scr_re_out_put(&out, plain_text, plain_len);
    } else {
      for (int i = 0; i < nops; i++) {
        const ScrReTemplateOp *op = &ops[i];
        if (op->capture < 0) {
          scr_re_out_put(&out, rep->data + op->off, (size_t)op->len);
        } else {
          const uint8_t *cs = capture[2 * op->capture], *ce = capture[2 * op->capture + 1];
          if (cs && ce) scr_re_out_put(&out, (const char *)cs, (size_t)(ce - cs));
        }
      }
    }
    next = end;
    if (!global) break;
    /* ASCII holds no surrogate pair: an empty match advances one unit. */
    pos = end == start ? end + 1 : end;
  }
  if (!out.s) return scr_str_retain(s);
  scr_re_out_put(&out, text + next, (size_t)(len - next));
  out.s->len = out.len;
  out.data[out.len] = '\0';
  /* The subject is ASCII, so a surrogate pair can only form where two
   * substitutions meet: one ending in a lone high half, the next starting
   * with a lone low half. */
  if (scr_wtf8_any() && memchr(rep->data, 0xED, rep->len))
    scr_str_fuse_surrogates(out.s);
  else if (scr_str_known_ascii(rep) || scr_bytes_all_ascii(rep->data, rep->len))
    scr_str_note_ascii(out.s);
  return out.s;
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
  const ScrStr *lit = scr_regex_lit(re);
  if (lit && !sticky) {
    /* A plain-text pattern has no captures, so its substitutions are the
     * string-search ones. */
    if (global) re->last_index = 0;
    return scr_str_replace_bytes(s, lit->data, lit->len, rep, global);
  }
  int capture_count = lre_get_capture_count(bc);
  const char *groupnames = lre_get_groupnames(bc);
  ScrRegexInput input;
  scr_regex_input_init(&input, re, bc, s);
  if (input.matcher) {
    ScrStr *direct = scr_replace_matcher(s, re, rep, &input, capture_count,
                                         groupnames != NULL, global, sticky);
    if (direct) {
      scr_regex_input_dispose(&input);
      return direct;
    }
  }
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
  bool ascii = !input.wide && (scr_str_known_ascii(rep) || scr_bytes_all_ascii(rep->data, rep->len));
  scr_regex_input_dispose(&input);
  if (!matched) return scr_str_retain(s);
  ScrStr *out = scr_jb_finish(&b);
  if (ascii) scr_str_note_ascii(out);
  return out;
}

ScrStr *scr_regex_replace(ScrStr *s, ScrRegex *re, ScrStr *rep) {
  return scr_replace_impl(s, re, rep);
}

void scr_re_replace_out_reserve(ScrReReplaceOut *o, int64_t need) {
  if (need < 0 || (uint64_t)need > SCR_STR_MAX_CAP - (uint64_t)o->len) scr_regex_oom();
  size_t cap = (size_t)o->cap * 2;
  if (cap < (size_t)(o->len + need)) cap = (size_t)(o->len + need);
  if (cap > SCR_STR_MAX_CAP) cap = SCR_STR_MAX_CAP;
  o->str->len = (size_t)o->len;
  o->str = scr_str_regrow(o->str, cap);
  o->data = o->str->data;
  o->cap = (int64_t)o->str->cap;
}

/* A global substitution with a literal ASCII replacement through the
 * build-time replacer of its (pattern, replacement) pair: on an ASCII
 * subject the replacer writes each gap and the replacement into the output
 * and continues the search after every match without returning. Every
 * other subject, and a plain-text pattern (string search), takes
 * scr_replace_impl. */
ScrStr *scr_regex_replace_with(ScrStr *s, ScrRegex *re, ScrStr *rep,
                               ScrRegexMatcherFn replacer) {
  (void)scr_regex_bc(re);
  if (scr_regex_lit(re) || !scr_text_ascii(s)) return scr_replace_impl(s, re, rep);
  if (s->len > (size_t)INT32_MAX - 1) scr_regex_oom();
  re->last_index = 0;
  ScrReReplaceOut o;
  o.str = scr_str_alloc_raw(0, s->len + 64);
  o.data = o.str->data;
  o.len = 0;
  o.cap = (int64_t)o.str->cap;
  o.next = 0;
  int32_t n = replacer((const uint8_t *)s->data, (int32_t)s->len, 0, (uint8_t **)(void *)&o);
  if (n == 0) {
    o.str->len = 0;
    scr_str_release(o.str);
    return scr_str_retain(s);
  }
  size_t tail = s->len - (size_t)o.next;
  if ((int64_t)(tail + 1) > o.cap - o.len) scr_re_replace_out_reserve(&o, (int64_t)tail + 1);
  scr_copy_bytes(o.data + o.len, s->data + o.next, tail);
  o.len += (int64_t)tail;
  o.str->len = (size_t)o.len;
  o.data[o.len] = '\0';
  scr_str_note_ascii(o.str);
  return o.str;
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
    scr_jb_abandon(&output);
    scr_regex_input_dispose(&input);
    return NULL;
  }
  scr_regex_put_span(&output, &input, next, len);
  scr_regex_input_dispose(&input);
  return scr_jb_finish(&output);
}

/* The closure signature scr_regex_replace_fn calls: `arity` pointer
 * parameters, except a number at `number_at` (-1 when there is none). A
 * string and a checked-dynamic value are both pointers, and so are both
 * results. */
#define SCR_REPLACER_CALL(...) return ((void *(*)(ScrClosure *, __VA_ARGS__))fn)
static inline __attribute__((always_inline)) void *scr_regex_call_replacer(
    ScrClosure *f, uint32_t arity, int number_at, void *const *p, double offset) {
  void *fn = f->fn;
  typedef void *P;
  typedef double D;
  switch (arity * 8 + (uint32_t)(number_at < 0 ? 7 : number_at)) {
  case 0 * 8 + 7: return ((void *(*)(ScrClosure *))fn)(f);
  case 1 * 8 + 7: SCR_REPLACER_CALL(P)(f, p[0]);
  case 2 * 8 + 7: SCR_REPLACER_CALL(P, P)(f, p[0], p[1]);
  case 2 * 8 + 1: SCR_REPLACER_CALL(P, D)(f, p[0], offset);
  case 3 * 8 + 7: SCR_REPLACER_CALL(P, P, P)(f, p[0], p[1], p[2]);
  case 3 * 8 + 1: SCR_REPLACER_CALL(P, D, P)(f, p[0], offset, p[2]);
  case 3 * 8 + 2: SCR_REPLACER_CALL(P, P, D)(f, p[0], p[1], offset);
  case 4 * 8 + 7: SCR_REPLACER_CALL(P, P, P, P)(f, p[0], p[1], p[2], p[3]);
  case 4 * 8 + 1: SCR_REPLACER_CALL(P, D, P, P)(f, p[0], offset, p[2], p[3]);
  case 4 * 8 + 2: SCR_REPLACER_CALL(P, P, D, P)(f, p[0], p[1], offset, p[3]);
  case 4 * 8 + 3: SCR_REPLACER_CALL(P, P, P, D)(f, p[0], p[1], p[2], offset);
  case 5 * 8 + 7: SCR_REPLACER_CALL(P, P, P, P, P)(f, p[0], p[1], p[2], p[3], p[4]);
  case 5 * 8 + 1: SCR_REPLACER_CALL(P, D, P, P, P)(f, p[0], offset, p[2], p[3], p[4]);
  case 5 * 8 + 2: SCR_REPLACER_CALL(P, P, D, P, P)(f, p[0], p[1], offset, p[3], p[4]);
  case 5 * 8 + 3: SCR_REPLACER_CALL(P, P, P, D, P)(f, p[0], p[1], p[2], offset, p[4]);
  case 5 * 8 + 4: SCR_REPLACER_CALL(P, P, P, P, D)(f, p[0], p[1], p[2], p[3], offset);
  case 6 * 8 + 7: SCR_REPLACER_CALL(P, P, P, P, P, P)(f, p[0], p[1], p[2], p[3], p[4], p[5]);
  case 6 * 8 + 1: SCR_REPLACER_CALL(P, D, P, P, P, P)(f, p[0], offset, p[2], p[3], p[4], p[5]);
  case 6 * 8 + 2: SCR_REPLACER_CALL(P, P, D, P, P, P)(f, p[0], p[1], offset, p[3], p[4], p[5]);
  case 6 * 8 + 3: SCR_REPLACER_CALL(P, P, P, D, P, P)(f, p[0], p[1], p[2], offset, p[4], p[5]);
  case 6 * 8 + 4: SCR_REPLACER_CALL(P, P, P, P, D, P)(f, p[0], p[1], p[2], p[3], offset, p[5]);
  case 6 * 8 + 5: SCR_REPLACER_CALL(P, P, P, P, P, D)(f, p[0], p[1], p[2], p[3], p[4], offset);
  default: break;
  }
  scr_trap("scriptc: internal error: typed replacer signature\n");
}
#undef SCR_REPLACER_CALL

/* Typed replacer argument k: a capture (NULL for an unset optional one)
 * or the subject; the offset is passed separately. The compiler admits a
 * typed parameter only at those positions. Inlined with each constant k. */
static inline __attribute__((always_inline)) void scr_regex_typed_arg(
    void **p, uint32_t k, uint32_t kinds, int capture_count, ScrStr *const *caps, ScrStr *subject) {
  if ((int)k < capture_count) {
    if (!caps[k] && !(kinds & (SCR_REPLACER_OPTIONAL << k)))
      scr_trap("scriptc: internal error: typed replacer capture is unset\n");
    p[k] = caps[k] ? scr_str_retain(caps[k]) : NULL;
  } else if ((int)k == capture_count + 1) {
    p[k] = scr_str_retain(subject);
  }
}

/* One match's replacer arguments when some parameter is checked-dynamic
 * (scr_regex_replace_fn's `kinds`): typed ones +1, the rest new boxes.
 * `boxed_subject` is the subject's box; `groups` the match's groups
 * object, or NULL when no parameter reads it. */
__attribute__((noinline)) static void scr_regex_replacer_args(
    void **p, uint32_t arity, uint32_t kinds, int capture_count, ScrStr *const *caps, double offset,
    ScrStr *subject, ScrDyn *boxed_subject, ScrDyn *groups) {
  for (uint32_t k = 0; k < arity; k++) {
    int at = (int)k;
    if (kinds & (1u << k)) {
      if (at < capture_count)
        p[k] = caps[k] ? scr_dyn_new_str(caps[k]) : scr_dyn_retain(scr_dyn_undefined());
      else if (at == capture_count)
        p[k] = scr_dyn_new_num(offset);
      else if (at == capture_count + 1)
        p[k] = scr_dyn_retain(boxed_subject);
      else if (at == capture_count + 2 && groups)
        p[k] = scr_dyn_retain(groups);
      else
        p[k] = scr_dyn_retain(scr_dyn_undefined());
    } else if (at < capture_count) {
      if (!caps[k] && !(kinds & (SCR_REPLACER_OPTIONAL << k)))
        scr_trap("scriptc: internal error: typed replacer capture is unset\n");
      p[k] = caps[k] ? scr_str_retain(caps[k]) : NULL;
    } else if (at == capture_count + 1) {
      p[k] = scr_str_retain(subject);
    } else if (at != capture_count) {
      scr_trap("scriptc: internal error: typed replacer signature\n");
    }
  }
}

/* scr_regex_replace_callback's algorithm for a typed replacer: the matches
 * are collected first, keeping only the captures and groups objects the
 * replacer reads, then the replacer runs once per match in order. Typed
 * parameters receive their values +1 (the closure ABI's owned
 * parameters) and an unset optional capture NULL; checked-dynamic ones
 * receive new boxes. Inlined into one copy for kinds 0, where the boxed
 * handling folds away, and one for the other kinds. */
static inline __attribute__((always_inline)) ScrStr *
scr_regex_replace_fn_impl(ScrStr *s, ScrRegex *re, ScrClosure *f, uint32_t arity, uint32_t kinds,
                          bool all) {
  uint8_t *bc = scr_regex_bc(re);
  int flags = lre_get_flags(bc);
  bool global = (flags & LRE_FLAG_GLOBAL) != 0;
  if (all && !global) {
    static const char message[] = "String.prototype.replaceAll called with a non-global RegExp argument";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  if (arity > SCR_REPLACER_MAX_ARITY) scr_trap("scriptc: internal error: typed replacer arity\n");
  bool sticky = (flags & LRE_FLAG_STICKY) != 0;
  bool unicode = (flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  int capture_count = lre_get_capture_count(bc);
  size_t keep = arity < (uint32_t)capture_count ? arity : (size_t)capture_count;
  /* Node passes the groups object after the subject when the pattern has
   * named groups; only a checked-dynamic parameter can read it, and no
   * typed parameter follows the subject. */
  bool past_subject = (uint32_t)capture_count + 2 < arity;
  if (past_subject && !(kinds & SCR_REPLACER_BOXED_PARAMS))
    scr_trap("scriptc: internal error: typed replacer signature\n");
  const char *groupnames = past_subject ? lre_get_groupnames(bc) : NULL;
  bool groups_read = groupnames != NULL;
  if (groups_read && !(kinds & (1u << (capture_count + 2))))
    scr_trap("scriptc: internal error: typed replacer groups parameter\n");
  int number_at = capture_count < (int)arity && !(kinds & (1u << capture_count)) ? capture_count : -1;
  ScrRegexInput input;
  scr_regex_input_init(&input, re, bc, s);
  int len = input.len;
  struct { int start, end; } *matches = NULL;
  ScrStr **caps = NULL;
  ScrDyn **groups = NULL;
  size_t count = 0, capacity = 0;
  if (global) re->last_index = 0;
  int position = sticky ? scr_regex_start(re, len) : 0;
  if (position < 0) position = len + 1;
  if (sticky && !global) re->last_index = 0;
  while (position <= len && scr_exec(&input, bc, position) == 1) {
    uint8_t **capture = input.capture;
    int start = scr_capture_index(&input, capture[0]);
    int end = scr_capture_index(&input, capture[1]);
    if (sticky && !global) re->last_index = end;
    if (count == capacity) {
      size_t next = capacity ? capacity * 2 : 8;
      if (next < capacity || next > SIZE_MAX / sizeof(*matches) / (keep + 1)) scr_regex_oom();
      void *grown = realloc(matches, next * sizeof(*matches));
      if (!grown) scr_regex_oom();
      matches = grown;
      if (keep) {
        grown = realloc(caps, next * keep * sizeof(*caps));
        if (!grown) scr_regex_oom();
        caps = grown;
      }
      if (groups_read) {
        grown = realloc(groups, next * sizeof(*groups));
        if (!grown) scr_regex_oom();
        groups = grown;
      }
      capacity = next;
    }
    for (size_t group = 0; group < keep; group++) {
      const uint8_t *cs = capture[group * 2], *ce = capture[group * 2 + 1];
      caps[count * keep + group] =
          cs && ce ? scr_regex_span(&input, scr_capture_index(&input, cs), scr_capture_index(&input, ce))
                   : NULL;
    }
    if (groups_read) {
      ScrDyn *object = scr_dyn_new_obj_null_proto();
      const char *name = groupnames;
      for (int group = 1; group < capture_count; group++) {
        size_t length = strlen(name);
        if (length && (capture[group * 2] || !scr_dyn_obj_get(object, name, length)))
          scr_dyn_obj_set(object, name, length,
            scr_regex_capture_value(&input, capture[group * 2], capture[group * 2 + 1]));
        name += length + LRE_GROUP_NAME_TRAILER_LEN;
      }
      groups[count] = object;
    }
    matches[count].start = start;
    matches[count].end = end;
    count++;
    if (!global) break;
    position = start == end ? scr_advance(&input, end, unicode) : end;
  }
  ScrJsonBuf output;
  scr_jb_init(&output);
  int next = 0;
  /* One box of the subject serves every match. */
  ScrDyn *subject = NULL;
  if (kinds & SCR_REPLACER_BOXED_PARAMS) subject = scr_dyn_new_str(s);
  scr_dyn_this_push_dyn(NULL);
  for (size_t i = 0; i < count; i++) {
    void *p[SCR_REPLACER_MAX_ARITY] = { NULL };
    double offset = (double)matches[i].start;
    ScrStr *const *match_caps = caps + i * keep;
    if (kinds & SCR_REPLACER_BOXED_PARAMS) {
      scr_regex_replacer_args(p, arity, kinds, capture_count, match_caps, offset, s, subject,
                              groups_read ? groups[i] : NULL);
    } else {
      for (uint32_t k = 0; k < SCR_REPLACER_MAX_ARITY; k++)
        if (k < arity) scr_regex_typed_arg(p, k, kinds, capture_count, match_caps, s);
    }
    void *result = scr_regex_call_replacer(f, arity, number_at, p, offset);
    ScrStr *replacement = (ScrStr *)result;
    if (kinds & SCR_REPLACER_BOXED_RESULT) {
      replacement = scr_exc_pending() ? NULL : scr_dyn_string_coerce_js((ScrDyn *)result);
      scr_dyn_release((ScrDyn *)result);
    }
    if (scr_exc_pending()) {
      scr_str_release(replacement);
      break;
    }
    scr_regex_put_span(&output, &input, next, matches[i].start);
    scr_jb_put_str(&output, replacement);
    scr_str_release(replacement);
    next = matches[i].end;
  }
  scr_dyn_this_pop();
  if (subject) scr_dyn_release(subject);
  for (size_t i = 0; i < count * keep; i++) scr_str_release(caps[i]);
  if (groups_read) {
    for (size_t i = 0; i < count; i++) scr_dyn_release(groups[i]);
    free(groups);
  }
  free(caps);
  free(matches);
  if (scr_exc_pending()) {
    scr_jb_abandon(&output);
    scr_regex_input_dispose(&input);
    return NULL;
  }
  scr_regex_put_span(&output, &input, next, len);
  scr_regex_input_dispose(&input);
  return scr_jb_finish(&output);
}

__attribute__((noinline)) static ScrStr *scr_regex_replace_typed(ScrStr *s, ScrRegex *re,
                                                                ScrClosure *f, uint32_t arity,
                                                                bool all) {
  return scr_regex_replace_fn_impl(s, re, f, arity, 0, all);
}

__attribute__((noinline)) static ScrStr *scr_regex_replace_kinds(ScrStr *s, ScrRegex *re,
                                                                ScrClosure *f, uint32_t arity,
                                                                uint32_t kinds, bool all) {
  return scr_regex_replace_fn_impl(s, re, f, arity, kinds, all);
}

ScrStr *scr_regex_replace_fn(ScrStr *s, ScrRegex *re, ScrClosure *f, uint32_t arity,
                             uint32_t kinds, bool all) {
  if (kinds == 0) return scr_regex_replace_typed(s, re, f, arity, all);
  return scr_regex_replace_kinds(s, re, f, arity, kinds, all);
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
 * Node v24.22.0's pattern (internal/util/inspect.js), applied with /g:
 *   (?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))
 *   |[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?
 *    [\dA-PR-TZcf-nq-uy=><~]
 * is matched by a single pass that gives the same first match at every
 * position. The OSC branch ends at the first terminator after ESC ]; that
 * position is cached, so text with many unterminated introducers is not
 * rescanned from each one. The CSI branch is resolved without
 * backtracking: the run of [[\]()#;?] is taken whole (none of those
 * characters is a digit or a final character, so a shorter run cannot
 * match), then a final character ends the match, or digits start the
 * parameter group. */
static bool scr_vt_digit(unsigned char c) { return c >= '0' && c <= '9'; }

static bool scr_vt_final(unsigned char c) {
  return scr_vt_digit(c) || (c >= 'A' && c <= 'P') || (c >= 'R' && c <= 'T') || c == 'Z' ||
         c == 'c' || (c >= 'f' && c <= 'n') || (c >= 'q' && c <= 'u') || c == 'y' || c == '=' ||
         c == '>' || c == '<' || c == '~';
}

static bool scr_vt_intermediate(unsigned char c) {
  return c == '[' || c == ']' || c == '(' || c == ')' || c == '#' || c == ';' || c == '?';
}

/* The OSC terminator starting at i (BEL, ESC \, or U+009C as UTF-8 C2 9C):
 * its byte length, or 0. */
static size_t scr_vt_terminator(const unsigned char *d, size_t len, size_t i) {
  if (d[i] == 0x07) return 1;
  if (i + 1 < len && ((d[i] == 0x1b && d[i + 1] == '\\') || (d[i] == 0xc2 && d[i + 1] == 0x9c)))
    return 2;
  return 0;
}

static size_t scr_vt_digits(const unsigned char *d, size_t len, size_t i, size_t max) {
  size_t n = 0;
  while (n < max && i + n < len && scr_vt_digit(d[i + n])) n++;
  return n;
}

/* The CSI branch after its introducer (body starts at x): the match end,
 * or 0 when the branch does not match. */
static size_t scr_vt_csi_end(const unsigned char *d, size_t len, size_t x) {
  size_t t = x;
  while (t < len && scr_vt_intermediate(d[t])) t++;
  if (t >= len) return 0;
  if (!scr_vt_digit(d[t])) return scr_vt_final(d[t]) ? t + 1 : 0;
  /* \d{1,4}(?:[;:]\d{0,4})* taken greedily; on a non-final stop the
   * engine backtracks to the last separator iteration that read digits
   * (its last digit becomes the final character), or else to the leading
   * digits. */
  size_t lead = scr_vt_digits(d, len, t, 4);
  size_t y = t + lead, last_with_digits = 0;
  while (y < len && (d[y] == ';' || d[y] == ':')) {
    size_t b = scr_vt_digits(d, len, y + 1, 4);
    y += 1 + b;
    if (b > 0) last_with_digits = y;
  }
  if (y < len && scr_vt_final(d[y])) return y + 1;
  return last_with_digits ? last_with_digits : t + lead;
}

ScrStr *scr_util_strip_vt(const ScrDyn *input) {
  if (!input || input->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("str", "of type string", input ? input : scr_dyn_undefined());
    return NULL;
  }
  ScrStr *subject = input->v.str;
  const unsigned char *d = (const unsigned char *)subject->data;
  size_t len = subject->len;
  bool escape = false;
  for (size_t i = 0; i < len; i++) {
    if (d[i] == 0x1b || (d[i] == 0xc2 && i + 1 < len && d[i + 1] == 0x9b)) {
      escape = true;
      break;
    }
  }
  if (!escape) return scr_str_retain(subject);
  char *out = malloc(len);
  if (!out) scr_trap("scriptc: out of memory\n");
  size_t n = 0, i = 0;
  /* The first OSC terminator at or after the last search start (SIZE_MAX
   * for none). Searches start at increasing positions, and a cached
   * terminator at or after the new start is still the first one, so each
   * byte is searched once. */
  size_t term = 0, term_len = 0;
  bool searched = false;
  while (i < len) {
    if (d[i] == 0x1b && i + 1 < len && d[i + 1] == ']') {
      size_t from = i + 2;
      if (!searched || (term != SIZE_MAX && term < from)) {
        term = SIZE_MAX;
        for (size_t k = from; k < len; k++) {
          size_t tl = scr_vt_terminator(d, len, k);
          if (tl) {
            term = k;
            term_len = tl;
            break;
          }
        }
        searched = true;
      }
      if (term != SIZE_MAX) {
        i = term + term_len;
        continue;
      }
    }
    size_t intro = d[i] == 0x1b ? 1 : d[i] == 0xc2 && i + 1 < len && d[i + 1] == 0x9b ? 2 : 0;
    if (intro) {
      size_t end = scr_vt_csi_end(d, len, i + intro);
      if (end) {
        i = end;
        continue;
      }
    }
    out[n++] = (char)d[i++];
  }
  /* A removal can bring a lone high surrogate next to a lone low one;
   * canonical storage keeps them as one pair. */
  if (n != len && scr_wtf8_any()) n = scr_wtf8_fuse(out, n);
  ScrStr *result = scr_str_new(out, n);
  free(out);
  return result;
}

ScrStr *scr_regex_replace_all(ScrStr *s, ScrRegex *re, ScrStr *rep) {
  if (!(lre_get_flags(scr_regex_bc(re)) & LRE_FLAG_GLOBAL)) {
    /* Node's exact TypeError — a real instance now: catch bindings narrow
     * it and e.message carries V8's exact text. */
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
  /* Without captures or sticky probing, splitting on a plain-text pattern
   * is splitting on its text. */
  const ScrStr *lit = scr_regex_lit(re);
  if (lit) return scr_str_split_limit(s, (ScrStr *)lit, limit_num);
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

/* 0x80 in each byte of `w`, eight ASCII bytes, that lies in [first, last].
 * Every byte is below 0x80, so neither sum carries into the next byte: a
 * byte's sum with 0x80 - first has its top bit set when the byte is at
 * least `first`, and its sum with 0x7f - last when it is above `last`. */
static inline uint64_t scr_ascii_range_mask(uint64_t w, unsigned char first, unsigned char last) {
  const uint64_t ones = UINT64_C(0x0101010101010101);
  return (w + ones * (uint64_t)(0x80 - first)) & ~(w + ones * (uint64_t)(0x7f - last)) &
         (ones * 0x80);
}

static ScrStr *scr_str_case_conv(const ScrStr *s, int to_lower) {
  unsigned char first = to_lower ? 'A' : 'a';
  unsigned char last = to_lower ? 'Z' : 'z';
  if (scr_text_ascii(s)) {
    /* ASCII text converts eight bytes at a time: a letter of the other
     * case differs from its conversion only in bit 0x20. */
    size_t changed = 0;
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    for (; changed + 8 <= s->len; changed += 8) {
      uint64_t w;
      memcpy(&w, s->data + changed, 8);
      uint64_t letters = scr_ascii_range_mask(w, first, last);
      if (letters != 0) {
        changed += (size_t)__builtin_ctzll(letters) >> 3;
        break;
      }
    }
#endif
    while (changed < s->len &&
           ((unsigned char)s->data[changed] < first || (unsigned char)s->data[changed] > last))
      changed++;
    if (changed == s->len) return scr_str_retain((ScrStr *)s);
    ScrStr *out = scr_str_alloc_raw(s->len, s->len);
    memcpy(out->data, s->data, changed);
    size_t i = changed;
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    for (; i + 8 <= s->len; i += 8) {
      uint64_t w;
      memcpy(&w, s->data + i, 8);
      w ^= scr_ascii_range_mask(w, first, last) >> 2;
      memcpy(out->data + i, &w, 8);
    }
#endif
    for (; i < s->len; i++) {
      unsigned char c = (unsigned char)s->data[i];
      out->data[i] = (char)(c >= first && c <= last ? c ^ 0x20 : c);
    }
    out->data[s->len] = '\0';
    scr_str_note_ascii(out);
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

/* ── String.prototype.toLocaleLowerCase / toLocaleUpperCase ────────────
 * V8 decides the case mapping from the FIRST requested locale only
 * (probed: ["en", 5] maps like "en", [5] throws, a non-object primitive
 * requests nothing). ICU tailors case mapping for Turkic (tr, az: dotted
 * and dotless I), Lithuanian (dot above retention) and Greek uppercasing
 * (accent removal); every other language uses the default conversion.
 * The Turkic rules are SpecialCasing's: lowercase I → ı unless a
 * U+0307 follows (then I + U+0307 → i), İ → i; uppercase i → İ. Tags are
 * checked against the unicode_locale_id structure; anything this unit
 * cannot decide exactly (malformed tags, whose V8 RangeError texts vary,
 * objects, lt, el uppercasing, I before other combining marks) throws a
 * 'not supported yet' Error rather than guess. Nothing on an existing
 * path calls this. */

static bool scr_tag_alpha(const char *p, size_t n) {
  for (size_t i = 0; i < n; i++)
    if (!((p[i] >= 'a' && p[i] <= 'z') || (p[i] >= 'A' && p[i] <= 'Z'))) return false;
  return true;
}

static bool scr_tag_digit(const char *p, size_t n) {
  for (size_t i = 0; i < n; i++)
    if (!(p[i] >= '0' && p[i] <= '9')) return false;
  return true;
}

static bool scr_tag_alnum(const char *p, size_t n) {
  for (size_t i = 0; i < n; i++)
    if (!scr_tag_alpha(p + i, 1) && !scr_tag_digit(p + i, 1)) return false;
  return true;
}

static bool scr_tag_same(const char *a, size_t an, const char *b, size_t bn) {
  if (an != bn) return false;
  for (size_t i = 0; i < an; i++) {
    char x = a[i] >= 'A' && a[i] <= 'Z' ? (char)(a[i] + 32) : a[i];
    char y = b[i] >= 'A' && b[i] <= 'Z' ? (char)(b[i] + 32) : b[i];
    if (x != y) return false;
  }
  return true;
}

/* 0 default, 1 Turkic, 2 Lithuanian, 3 Greek; -1 when the tag is outside
 * the structural grammar handled here. */
static int scr_locale_case_rules(const char *tag, size_t len) {
  const char *subtags[64];
  size_t lens[64];
  size_t count = 0;
  size_t start = 0;
  for (size_t i = 0; i <= len; i++) {
    if (i < len && tag[i] != '-') continue;
    if (i == start || count == 64) return -1;
    subtags[count] = tag + start;
    lens[count++] = i - start;
    start = i + 1;
  }
  size_t k = 0;
  size_t lang = lens[0];
  if (!scr_tag_alpha(subtags[0], lang) || !((lang >= 2 && lang <= 3) || (lang >= 5 && lang <= 8)))
    return -1;
  k = 1;
  if (k < count && lens[k] == 4 && scr_tag_alpha(subtags[k], 4)) k++;
  if (k < count && ((lens[k] == 2 && scr_tag_alpha(subtags[k], 2)) ||
                    (lens[k] == 3 && scr_tag_digit(subtags[k], 3))))
    k++;
  size_t variants = k;
  while (k < count && scr_tag_alnum(subtags[k], lens[k]) &&
         ((lens[k] >= 5 && lens[k] <= 8) || (lens[k] == 4 && scr_tag_digit(subtags[k], 1)))) {
    for (size_t j = variants; j < k; j++)
      if (scr_tag_same(subtags[j], lens[j], subtags[k], lens[k])) return -1;
    k++;
  }
  size_t singletons = k;
  while (k < count) {
    if (lens[k] != 1 || !scr_tag_alnum(subtags[k], 1)) return -1;
    for (size_t j = singletons; j < k; j++)
      if (lens[j] == 1 && scr_tag_same(subtags[j], 1, subtags[k], 1)) return -1;
    bool private_use = subtags[k][0] == 'x' || subtags[k][0] == 'X';
    size_t min = private_use ? 1 : 2;
    size_t first = ++k;
    while (k < count && lens[k] >= min && lens[k] <= 8 && scr_tag_alnum(subtags[k], lens[k]) &&
           (private_use || lens[k] > 1))
      k++;
    if (k == first) return -1;
    if (private_use && k != count) return -1;
  }
  if (lang > 3) return 0;
  char l[3] = {0, 0, 0};
  for (size_t i = 0; i < lang; i++)
    l[i] = subtags[0][i] >= 'A' && subtags[0][i] <= 'Z' ? (char)(subtags[0][i] + 32) : subtags[0][i];
  bool two = lang == 2;
  if ((two && l[0] == 't' && l[1] == 'r') || (two && l[0] == 'a' && l[1] == 'z') ||
      (!two && l[0] == 't' && l[1] == 'u' && l[2] == 'r') ||
      (!two && l[0] == 'a' && l[1] == 'z' && l[2] == 'e'))
    return 1;
  if ((two && l[0] == 'l' && l[1] == 't') || (!two && l[0] == 'l' && l[1] == 'i' && l[2] == 't'))
    return 2;
  if ((two && l[0] == 'e' && l[1] == 'l') || (!two && l[0] == 'e' && l[1] == 'l' && l[2] == 'l') ||
      (!two && l[0] == 'g' && l[1] == 'r' && l[2] == 'e'))
    return 3;
  return 0;
}

static ScrStr *scr_locale_case_unsupported(bool upper) {
  static const char lower_msg[] =
      "String.prototype.toLocaleLowerCase with this locale argument is not supported yet";
  static const char upper_msg[] =
      "String.prototype.toLocaleUpperCase with this locale argument is not supported yet";
  /* The unit's existing "SC2020" literal: a separate constant array would
   * absorb it (LLVM merges identical constants) and move it out of the
   * string section every regex-linking binary keeps. */
  if (upper) scr_throw_error_msg_code(SCR_ERR_ERROR, upper_msg, sizeof upper_msg - 1, "SC2020");
  else scr_throw_error_msg_code(SCR_ERR_ERROR, lower_msg, sizeof lower_msg - 1, "SC2020");
  return NULL;
}

static ScrStr *scr_turkic_case(const ScrStr *s, bool upper) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (upper && c == 'i') {
      scr_jb_putc(&b, (char)0xC4); /* İ */
      scr_jb_putc(&b, (char)0xB0);
      continue;
    }
    if (!upper && c == 'I') {
      unsigned char n0 = i + 1 < s->len ? (unsigned char)s->data[i + 1] : 0;
      unsigned char n1 = i + 2 < s->len ? (unsigned char)s->data[i + 2] : 0;
      if (n0 == 0xCC && n1 == 0x87) { /* I + U+0307 → i */
        scr_jb_putc(&b, 'i');
        i += 2;
        continue;
      }
      /* Another combining mark (U+0300..U+036F) may precede a U+0307. */
      if ((n0 == 0xCC && n1 >= 0x80) || (n0 == 0xCD && n1 >= 0x80 && n1 <= 0xAF)) {
        scr_str_release(scr_jb_finish(&b));
        return scr_locale_case_unsupported(upper);
      }
      scr_jb_putc(&b, (char)0xC4); /* ı */
      scr_jb_putc(&b, (char)0xB1);
      continue;
    }
    if (!upper && c == 0xC4 && i + 1 < s->len && (unsigned char)s->data[i + 1] == 0xB0) {
      scr_jb_putc(&b, 'i'); /* İ → i */
      i++;
      continue;
    }
    scr_jb_putc(&b, (char)c);
  }
  ScrStr *mapped = scr_jb_finish(&b);
  ScrStr *result = scr_str_case_conv(mapped, upper ? 0 : 1);
  scr_str_release(mapped);
  return result;
}

ScrStr *scr_str_locale_case(const ScrStr *s, ScrDyn *locales, bool upper) {
  ScrDyn *owned = NULL;
  if (locales->kind == SCR_DYN_TYPED_REF) {
    owned = scr_dyn_typed_ref_materialize(locales);
    if (!owned) return NULL;
    locales = owned;
  }
  const ScrDyn *tag = NULL;
  int rules = 0;
  switch (locales->kind) {
  case SCR_DYN_NULL: {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  case SCR_DYN_UNDEF:
  case SCR_DYN_NUM:
  case SCR_DYN_BOOL:
  case SCR_DYN_SYMBOL:
  case SCR_DYN_BIGINT:
    break;
  case SCR_DYN_STR:
    tag = locales;
    break;
  case SCR_DYN_ARR:
    if (locales->v.arr.len == 0) break;
    if (locales->v.arr.presence && !locales->v.arr.presence[0]) {
      static const char msg[] = "Language ID should be string or object.";
      scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      scr_dyn_release(owned);
      return NULL;
    }
    tag = locales->v.arr.items[0];
    if (tag->kind != SCR_DYN_STR) {
      bool primitive = tag->kind == SCR_DYN_UNDEF || tag->kind == SCR_DYN_NULL ||
                       tag->kind == SCR_DYN_NUM || tag->kind == SCR_DYN_BOOL ||
                       tag->kind == SCR_DYN_BIGINT || tag->kind == SCR_DYN_SYMBOL;
      scr_dyn_release(owned);
      if (!primitive) return scr_locale_case_unsupported(upper);
      static const char msg[] = "Language ID should be string or object.";
      scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      return NULL;
    }
    break;
  default:
    scr_dyn_release(owned);
    return scr_locale_case_unsupported(upper);
  }
  if (tag) {
    rules = scr_locale_case_rules(tag->v.str->data, tag->v.str->len);
    if (rules < 0 || rules == 2 || (rules == 3 && upper)) {
      scr_dyn_release(owned);
      return scr_locale_case_unsupported(upper);
    }
  }
  scr_dyn_release(owned);
  if (rules == 1) return scr_turkic_case(s, upper);
  return scr_str_case_conv(s, upper ? 0 : 1);
}

static void *scr_normalize_realloc(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  if (!size) { free(ptr); return NULL; }
  return realloc(ptr, size);
}

/* unicode_normalize, except that U+11A7 never composes. libunicode composes
 * an LV syllable with U+11A7 as a trailing consonant (those are U+11A8 to
 * U+11C2), which drops it: "\uAC00\u11A7" became "\uAC00". U+11A7 is a
 * class-0 vowel that composes with nothing, so for the composing forms the
 * code points between occurrences of it normalize on their own and it is
 * kept as it is, as in Node. */
static int scr_unicode_normalize(uint32_t **pdst, const uint32_t *src, int len,
                                 UnicodeNormalizationEnum mode) {
  int at = 0;
  if (mode == UNICODE_NFC || mode == UNICODE_NFKC)
    while (at < len && src[at] != 0x11A7) at++;
  else
    at = len;
  if (at == len) return unicode_normalize(pdst, src, len, mode, NULL, scr_normalize_realloc);
  uint32_t *out = NULL;
  size_t count = 0, cap = 0;
  int start = 0;
  for (int i = 0; i <= len; i++) {
    if (i < len && src[i] != 0x11A7) continue;
    uint32_t *part = NULL;
    int n = 0;
    if (i > start) {
      n = unicode_normalize(&part, src + start, i - start, mode, NULL, scr_normalize_realloc);
      if (n < 0) {
        free(out);
        return -1;
      }
    }
    size_t need = count + (size_t)n + 1;
    if (need > cap) {
      size_t grown = cap ? cap * 2 : 16;
      if (grown < need) grown = need;
      uint32_t *bigger = realloc(out, grown * sizeof *out);
      if (!bigger) {
        free(part);
        free(out);
        return -1;
      }
      out = bigger;
      cap = grown;
    }
    if (n > 0) memcpy(out + count, part, (size_t)n * sizeof *out);
    count += (size_t)n;
    free(part);
    if (i < len) out[count++] = 0x11A7;
    start = i + 1;
  }
  *pdst = out;
  return (int)count;
}

/* Normalization quick check (UAX #15): a string whose every code point is
 * inert for the form is already in that form. A code point is inert when
 * normalizing it alone leaves it unchanged, its canonical combining class
 * is 0, and (for the composing forms) no composition can take it as its
 * second element. The last condition holds in the ranges below: none holds
 * a code point with combining class 0 that composes with a preceding one
 * (those are Hangul jamo vowels and trailing consonants, U+3099/U+309A,
 * and vowel signs of Indic and Southeast Asian scripts above U+0900), so a
 * code point outside them takes the full algorithm. Inert flags are
 * computed through unicode_normalize, 256 code points at a time, when a
 * block is first seen. */
#define SCR_NQC_BLOCKS 0x200
typedef struct {
  uint8_t known[4][SCR_NQC_BLOCKS];
  uint8_t inert[4][SCR_NQC_BLOCKS][32];
  uint8_t starter[4][SCR_NQC_BLOCKS][32]; /* class 0, never a second element */
  struct {
    uint32_t cp;
    uint8_t len;
    char bytes[15];
  } single[4][256]; /* a lone code point's normalized UTF-8 */
} ScrNormalizeQuick;
static SCR_TL ScrNormalizeQuick *scr_nqc;

static void scr_nqc_free(void) {
  free(scr_nqc);
  scr_nqc = NULL;
}

static bool scr_nqc_in_ranges(uint32_t c) {
  return c < 0x900 || (c >= 0x2000 && c < 0x3099) || (c >= 0x309B && c < 0xA000) ||
         (c >= 0xAC00 && c < 0xD7A4) || (c >= 0xF900 && c < 0x10000) ||
         (c >= 0x1F000 && c < 0x1FB00);
}

/* Bit 0: inert. Bit 1: a starter, with class 0 and never the second element
 * of a composition, so nothing before it reorders or composes with it. */
/* Whether c has class 0 and lies in the ranges above. U+0345 is the one
 * code point of class 240, which the reordering test cannot tell from
 * class 0; a mark of class 1..239 after U+0345 moves before it. */
static bool scr_nqc_class0(uint32_t c) {
  if (c == 0x345 || !scr_nqc_in_ranges(c)) return false;
  uint32_t pair[2] = {0x345, c};
  uint32_t *out = NULL;
  int n = unicode_normalize(&out, pair, 2, UNICODE_NFD, NULL, scr_normalize_realloc);
  bool starter = n >= 2 && out[0] == 0x345;
  free(out);
  return starter;
}

static unsigned scr_nqc_compute(uint32_t c, UnicodeNormalizationEnum mode) {
  if (!scr_nqc_class0(c)) return 0;
  uint32_t *out = NULL;
  int n = unicode_normalize(&out, &c, 1, mode, NULL, scr_normalize_realloc);
  bool same = n == 1 && out[0] == c;
  free(out);
  if (same) return 3u;
  /* A starter's decomposition must begin with one too (U+FF9E's
   * compatibility decomposition is U+3099, which composes with the code
   * point before it). */
  UnicodeNormalizationEnum decompose =
      mode == UNICODE_NFKC || mode == UNICODE_NFKD ? UNICODE_NFKD : UNICODE_NFD;
  out = NULL;
  n = unicode_normalize(&out, &c, 1, decompose, NULL, scr_normalize_realloc);
  bool leads = n >= 1 && scr_nqc_class0(out[0]);
  free(out);
  return leads ? 2u : 0u;
}

/* scr_nqc_compute's bits for c, from its block's flags. */
static unsigned scr_nqc_class(uint32_t c, UnicodeNormalizationEnum mode) {
  if (c >= (uint32_t)SCR_NQC_BLOCKS << 8) return 0;
  if (!scr_nqc) {
    scr_nqc = calloc(1, sizeof *scr_nqc);
    if (!scr_nqc) return 0;
    scr_atexit(scr_nqc_free);
  }
  uint32_t block = c >> 8;
  uint8_t *inert = scr_nqc->inert[mode][block];
  uint8_t *starter = scr_nqc->starter[mode][block];
  if (!scr_nqc->known[mode][block]) {
    for (uint32_t i = 0; i < 256; i++) {
      unsigned bits = scr_nqc_compute((block << 8) | i, mode);
      if (bits & 1) inert[i >> 3] |= (uint8_t)(1u << (i & 7));
      if (bits & 2) starter[i >> 3] |= (uint8_t)(1u << (i & 7));
    }
    scr_nqc->known[mode][block] = 1;
  }
  unsigned bit = c & 0xff;
  return ((inert[bit >> 3] >> (bit & 7)) & 1) | (((starter[bit >> 3] >> (bit & 7)) & 1) << 1);
}

/* Normalize the code points of data[from, to) and append them. */
static void scr_nqc_segment(ScrJsonBuf *b, const char *data, size_t from, size_t to,
                            UnicodeNormalizationEnum mode) {
  size_t first_step;
  uint32_t first = scr_case_decode(data + from, &first_step);
  if (first_step == to - from && scr_nqc) {
    /* One code point (a precomposed letter between inert ones): its
     * normalized bytes repeat, so they are kept per form. */
    __typeof__(scr_nqc->single[0][0]) *slot = &scr_nqc->single[mode][first & 0xff];
    if (slot->cp != first || slot->len == 0) {
      uint32_t *output = NULL;
      int count = unicode_normalize(&output, &first, 1, mode, NULL, scr_normalize_realloc);
      if (count < 0) scr_regex_oom();
      ScrJsonBuf one;
      scr_jb_init(&one);
      for (int i = 0; i < count; i++) scr_case_put_cp(&one, output[i]);
      free(output);
      ScrStr *bytes = scr_jb_finish(&one);
      if (bytes->len == 0 || bytes->len > sizeof slot->bytes) {
        scr_jb_write(b, bytes->data, bytes->len);
        scr_str_release(bytes);
        return;
      }
      slot->cp = first;
      slot->len = (uint8_t)bytes->len;
      memcpy(slot->bytes, bytes->data, bytes->len);
      scr_str_release(bytes);
    }
    scr_jb_write(b, slot->bytes, slot->len);
    return;
  }
  uint32_t local[32];
  uint32_t *input = to - from <= 32 ? local : malloc((to - from) * sizeof *input);
  if (!input) scr_regex_oom();
  int length = 0;
  for (size_t offset = from; offset < to;) {
    size_t step;
    input[length++] = scr_case_decode(data + offset, &step);
    offset += step;
  }
  uint32_t *output = NULL;
  int count = scr_unicode_normalize(&output, input, length, mode);
  if (input != local) free(input);
  if (count < 0) scr_regex_oom();
  for (int i = 0; i < count; i++) scr_case_put_cp(b, output[i]);
  free(output);
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
  bool inert = true;
  for (size_t offset = 0; offset < s->len;) {
    if ((unsigned char)s->data[offset] < 0x80) {
      offset++;
      continue;
    }
    size_t step;
    uint32_t c = scr_case_decode(s->data + offset, &step);
    offset += step;
    if (!(scr_nqc_class(c, mode) & 1)) {
      inert = false;
      break;
    }
  }
  if (inert) return scr_str_retain((ScrStr *)s);
  if (s->len > INT32_MAX / sizeof(uint32_t)) scr_regex_oom();
  /* An inert code point bounds reordering and composition, and so does any
   * other starter (class 0, never a composition's second element), so the
   * text normalizes segment by segment. A segment starts at a starter: runs
   * of inert code points copy as they are, and a segment with any other
   * code point goes through scr_unicode_normalize. */
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  size_t seg = 0, last_inert = 0;
  bool plain = true;
  for (size_t offset = 0; offset < s->len;) {
    unsigned char lead = (unsigned char)s->data[offset];
    size_t step = 1;
    unsigned kind = 3;
    if (lead >= 0x80) kind = scr_nqc_class(scr_case_decode(s->data + offset, &step), mode);
    if (kind & 1) {
      if (!plain) {
        scr_nqc_segment(&buffer, s->data, seg, offset, mode);
        seg = offset;
        plain = true;
      }
      last_inert = offset;
    } else if (kind & 2) {
      if (plain) scr_jb_write(&buffer, s->data + seg, offset - seg);
      else scr_nqc_segment(&buffer, s->data, seg, offset, mode);
      seg = offset;
      plain = false;
    } else if (plain) {
      size_t start = last_inert > seg ? last_inert : seg;
      scr_jb_write(&buffer, s->data + seg, start - seg);
      seg = start;
      plain = false;
    }
    offset += step;
  }
  if (plain) scr_jb_write(&buffer, s->data + seg, s->len - seg);
  else scr_nqc_segment(&buffer, s->data, seg, s->len, mode);
  return scr_jb_finish(&buffer);
}

uint32_t *scr_nfc_code_points(const uint32_t *input, size_t length, size_t *out_len) {
  if (length > INT32_MAX) scr_regex_oom();
  uint32_t *output = NULL;
  int count = scr_unicode_normalize(&output, input, (int)length, UNICODE_NFC);
  if (count < 0) scr_regex_oom();
  *out_len = (size_t)count;
  return output;
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
  scr_assert_record(scr_dyn_new_str(s), scr_dyn_native_regex(re), negated ? "doesNotMatch" : "match");
  if (has_msg && msg->len > 0) {
    scr_assert_fail(scr_str_retain(msg), false);
    return;
  }
  scr_assert_regex_input_fail(negated, re, s);
}

/* assert.throws(fn, /re/) whose thrown Error did not satisfy the regex:
 * Node tests String(actual) — Error.prototype.toString's "Name: message"
 * — and reports the mismatch with that string inspected. */
void scr_assert_throws_regex(ScrRegex *re, ScrError *err, ScrStr *msg, bool has_msg,
                             bool rejection) {
  ScrStr *str = scr_error_to_string(err);
  bool matched = scr_assert_regex_hits(re, str);
  if (matched) {
    scr_str_release(str);
    return;
  }
  scr_assert_record(scr_dyn_from_error(err), scr_dyn_native_regex(re),
                    rejection ? "rejects" : "throws");
  if (has_msg && msg->len > 0) {
    scr_str_release(str);
    scr_assert_fail(scr_str_retain(msg), false);
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
    ? scr_dyn_string_constructor(actual) : scr_util_to_string(actual);
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
    case 'd': flag = 1u << 6; break;
    case 'v': flag = 1u << 7; break;
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
  if ((seen_flags & (1u << 4)) && (seen_flags & (1u << 7))) {
    char msg[80];
    int n = snprintf(msg, sizeof msg, "Invalid flags supplied to RegExp constructor '%.20s'",
                     flags->data);
    scr_throw_error_msg(SCR_ERR_SYNTAX, msg, (size_t)n);
    return NULL;
  }
  /* Valid in Node, absent from the engine: name the gap rather than
   * report a flag Node accepts as invalid. */
  if (seen_flags & (1u << 6)) {
    static const char d_msg[] = "the regex 'd' flag (match indices) is not supported yet [SC1120]";
    scr_throw_error_msg(SCR_ERR_ERROR, d_msg, sizeof d_msg - 1);
    return NULL;
  }
  ScrRegex *re = calloc(1, sizeof *re);
  if (!re) {
    scr_trap("scriptc: out of memory\n");
  }
  re->rc = 1;
  re->source = pattern->len > 0 ? scr_str_retain(pattern) : scr_str_new("(?:)", 4);
  /* Public flags use getter order, independently of constructor spelling.
   * Validate first so duplicates and invalid flags retain their errors. */
  char canonical[8];
  size_t flag_count = 0;
  static const unsigned order_bits[] = {0, 1, 2, 3, 4, 7, 5};
  for (unsigned i = 0; i < sizeof order_bits / sizeof order_bits[0]; i++) {
    if (seen_flags & (1u << order_bits[i])) canonical[flag_count++] = "gimsuvy"[i];
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
  if (!(lre_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS))) {
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
  re->native = scr_regex_native_build(re, bc);
  scr_regex_ctor_remember(re);
  return re;
}

/* Decode the code point or lone surrogate at p (canonical WTF-8 by the
 * string invariant); *adv gets the byte length of the sequence. */
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
 * spec), a lone surrogate \uNNNN-escapes, and everything else passes
 * through. Borrows s; result +1. */
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
  if (cp >= 0xD800 && cp <= 0xDFFF) return 6; /* a lone surrogate: \uXXXX */
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
  if (strcmp(method, "exec") == 0) {
    /* The match array: each capture (undefined when it did not
     * participate), then index, input and groups; null without a match.
     * The exec itself reads and advances lastIndex. */
    ScrStr *subject = scr_dyn_string_coerce_js(argc ? args[0] : scr_dyn_undefined());
    if (!subject) return NULL;
    ScrArr *row = scr_regex_exec(subject, re);
    scr_str_release(subject);
    if (!row) return scr_exc_pending() ? NULL : scr_dyn_new_null();
    ScrDyn *match = scr_dyn_new_arr();
    for (size_t k = 0; k < row->len; k++)
      scr_dyn_arr_push(match, scr_arr_dense_state(row, k) == SCR_ARR_VALUE
                                  ? scr_dyn_new_str((ScrStr *)(uintptr_t)row->data[k])
                                  : scr_dyn_retain(scr_dyn_undefined()));
    scr_arr_copy_metadata(row, match);
    scr_arr_release(row);
    return match;
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
