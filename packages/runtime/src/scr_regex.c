/* Regular expressions (see scr_runtime.h for the API contract).
 *
 * The engine is quickjs-ng's libregexp — the exact ECMAScript regex
 * implementation the dynamic island uses — compiled standalone (libregexp.c
 * + libunicode.c; cutils is header-only) and linked ONLY into programs that
 * contain a regex literal. This file is likewise regex-only: it is NOT in
 * the always-compiled runtime source list (see native-toolchain.ts), so regex-free
 * programs keep a byte-identical link line.
 *
 * - Every ScrRegex today is an immortal interned literal (the compiler
 *   emits one static per distinct (pattern, flags) pair, like string
 *   literals). The pattern is compiled to bytecode LAZILY on first use and
 *   cached on the struct; a pattern lre_compile rejects aborts with a clear
 *   message (Node throws SyntaxError at parse time — documented divergence;
 *   rare, since tsc's parser has already syntax-checked the literal).
 * - Subjects are matched as UTF-16: lre_exec runs over a per-call
 *   conversion of the UTF-8 subject (cbuf_type 1), so every index libregexp
 *   reports is a UTF-16 code-unit index — .length/slice/charCodeAt exact,
 *   like Node. Correctness-first: the conversion is O(n) per call.
 * - Match loops mirror quickjs.c's own (JS_RegExpDelete /
 *   js_regexp_Symbol_replace): capture buffers are sized by
 *   lre_get_alloc_count (NOT capture_count*2 — the executor writes
 *   temporary registers past the capture slots), unmatched groups leave
 *   NULL pointers, and zero-length matches advance by one code unit — or by
 *   a whole surrogate pair under /u (AdvanceStringIndex).
 * - Statefulness fence: /g regexes carry mutable lastIndex in JS. This
 *   slice supports /g (and /y) only where the iteration is internal —
 *   replace/replaceAll/split; test() on a g/y-flagged regex aborts with a
 *   clear message (the frontend already rejects the cases it can see).
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libregexp.h"

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
  scr_note_compiled(re);
  return bc;
}

/* ── RC entry points ──────────────────────────────────────────────────
 * Dead paths today (every regex value is an immortal interned literal);
 * correct anyway so dynamic construction can arrive without surprises. */

void scr_regex_release(ScrRegex *re) {
  if (!re || re->rc == SIZE_MAX) return;
  if (--re->rc == 0) {
    scr_str_release(re->source);
    scr_str_release(re->flags);
    if (re->bc) lre_realloc(lre_opaque(), re->bc, 0);
    free(re);
  }
}

void *scr_regex_retain_v(void *re) { return scr_regex_retain(re); }
void scr_regex_release_v(void *re) { scr_regex_release(re); }

ScrStr *scr_regex_source(ScrRegex *re) { return scr_str_retain(re->source); }
ScrStr *scr_regex_flags(ScrRegex *re) { return scr_str_retain(re->flags); }

/* ── UTF-8 ⇄ UTF-16 (the exec buffer strategy) ──────────────────────── */

/* Subject as freshly-malloc'd UTF-16 code units (strings are well-formed
 * UTF-8, so no validation). Unit count ≤ byte count. */
static uint16_t *scr_to_utf16(const ScrStr *s, int *plen) {
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

/* Append u[start..end) as UTF-8. A lone surrogate (a non-/u match boundary
 * split an astral pair) becomes U+FFFD — the house rule for JS results that
 * are not well-formed UTF-16 (same divergence class as charAt/slice,
 * SEMANTICS.md). */
static void scr_jb_put_utf16(ScrJsonBuf *b, const uint16_t *u, int start, int end) {
  for (int i = start; i < end; i++) {
    uint32_t cp = u[i];
    if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < end && u[i + 1] >= 0xDC00 &&
        u[i + 1] < 0xE000) {
      cp = 0x10000 + ((cp - 0xD800) << 10) + (u[i + 1] - 0xDC00);
      i++;
    } else if (cp >= 0xD800 && cp < 0xE000) {
      cp = 0xFFFD;
    }
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
}

static ScrStr *scr_str_from_utf16(const uint16_t *u, int start, int end) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_put_utf16(&b, u, start, end);
  return scr_jb_finish(&b);
}

/* ── exec plumbing ────────────────────────────────────────────────────── */

/* One lre_exec over the UTF-16 subject. Returns 1 (match), 0 (no match);
 * engine-level failures (OOM, corrupt bytecode — no timeout handler is
 * installed) abort like every runtime OOM. */
static int scr_exec(uint8_t **capture, const uint8_t *bc, const uint16_t *u,
                     int index, int len) {
  int rc = lre_exec(capture, bc, (const uint8_t *)u, index, len, 1, lre_opaque());
  if (rc < 0) {
    fflush(stdout);
    scr_trap("scriptc: regular expression execution failed\n");
  }
  return rc;
}

/* Capture buffer sized by lre_get_alloc_count: the register-based executor
 * writes temporary registers past the capture pairs (quickjs.c documents
 * sizing by capture_count*2 as a silent heap overflow). */
static uint8_t **scr_capture_alloc(const uint8_t *bc) {
  int n = lre_get_alloc_count(bc);
  uint8_t **cap = malloc((n > 0 ? (size_t)n : 1) * sizeof *cap);
  if (!cap) scr_regex_oom();
  return cap;
}

/* ECMA-262 AdvanceStringIndex: past a whole surrogate pair under /u, one
 * code unit otherwise — the rule that keeps zero-length matches from
 * looping forever. */
static int scr_advance(const uint16_t *u, int len, int i, bool unicode) {
  if (unicode && i + 1 < len && u[i] >= 0xD800 && u[i] < 0xDC00 &&
      u[i + 1] >= 0xDC00 && u[i + 1] < 0xE000) {
    return i + 2;
  }
  return i + 1;
}

/* ── test ─────────────────────────────────────────────────────────────── */

bool scr_regex_test(ScrRegex *re, ScrStr *s) {
  uint8_t *bc = scr_regex_bc(re);
  if (lre_get_flags(bc) & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) {
    /* JS test() on a g/y regex reads AND writes lastIndex — stateful
     * iteration this slice does not model (the frontend rejects the sites
     * it can see; values that flow through variables land here). */
    fflush(stdout);
    scr_trap("scriptc: test() on a regex with the 'g' or 'y' flag is not "
             "supported (stateful lastIndex); drop the flag, or use "
             "replace/replaceAll/split\n");
  }
  int len;
  uint16_t *u = scr_to_utf16(s, &len);
  uint8_t **capture = scr_capture_alloc(bc);
  int rc = scr_exec(capture, bc, u, 0, len);
  free(capture);
  free(u);
  return rc == 1;
}

/* ── match ────────────────────────────────────────────────────────────── */

/* s.match(re) for non-g/y regexes: Node's exec-shaped result reduced to
 * the honest slice — a fresh string[] of [whole match, ...captures], or
 * NULL for no match (the compiler wraps the `string[] | null` union). A
 * NONPARTICIPATING capture holds "" where Node's slot is undefined
 * (truthiness tests agree; SEMANTICS.md documents the divergence). g/y
 * regexes abort like test() — a g-flagged match returns EVERY match, a
 * different shape the frontend fences on literals. */
ScrArr *scr_regex_match(ScrStr *s, ScrRegex *re) {
  uint8_t *bc = scr_regex_bc(re);
  if (lre_get_flags(bc) & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) {
    fflush(stdout);
    scr_trap("scriptc: match() on a regex with the 'g' or 'y' flag is not "
             "supported (an every-match array is a different shape); drop the "
             "flag, or use replace/replaceAll/split\n");
  }
  int len;
  uint16_t *u = scr_to_utf16(s, &len);
  uint8_t **capture = scr_capture_alloc(bc);
  int rc = scr_exec(capture, bc, u, 0, len);
  ScrArr *out = NULL;
  if (rc == 1) {
    const uint8_t *ubase = (const uint8_t *)u;
    int count = lre_get_capture_count(bc);
    out = scr_arr_new(SCR_ELEM_STR, (size_t)count);
    for (int k = 0; k < count; k++) {
      const uint8_t *cs = capture[2 * k], *ce = capture[2 * k + 1];
      if (cs == NULL || ce == NULL) {
        scr_arr_push_ref(out, scr_str_new("", 0));
      } else {
        scr_arr_push_ref(
            out, scr_str_from_utf16(u, (int)((cs - ubase) >> 1), (int)((ce - ubase) >> 1)));
      }
    }
  }
  free(capture);
  free(u);
  return out; /* +1, or NULL (no match) */
}

/* ── search ───────────────────────────────────────────────────────────── */

/* s.search(re): the first match's UTF-16 index, or -1 — Symbol.search's
 * fresh exec from position 0. lastIndex is neither read nor written in JS
 * (the spec saves and restores it), so no flag fence applies here, unlike
 * test/match: /g is irrelevant and /y anchors at 0 (libregexp's sticky
 * bytecode omits the implicit forward scan) — exactly Node. */
double scr_regex_search(ScrStr *s, ScrRegex *re) {
  uint8_t *bc = scr_regex_bc(re);
  int len;
  uint16_t *u = scr_to_utf16(s, &len);
  uint8_t **capture = scr_capture_alloc(bc);
  int rc = scr_exec(capture, bc, u, 0, len);
  double out = -1;
  if (rc == 1) out = (double)((capture[0] - (const uint8_t *)u) >> 1);
  free(capture);
  free(u);
  return out;
}

/* matchAll(re): every match as its honest slice string[] (whole match +
 * captures, nonparticipating = "" — match()'s rule) drained EAGERLY into
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
  int len;
  uint16_t *u = scr_to_utf16(s, &len);
  uint8_t **capture = scr_capture_alloc(bc);
  const uint8_t *ubase = (const uint8_t *)u;
  ScrArr *out = scr_arr_new(SCR_ELEM_ARR, 4);
  int pos = 0;
  while (pos <= len) {
    if (scr_exec(capture, bc, u, pos, len) != 1) break;
    int start = (int)((capture[0] - ubase) >> 1);
    int end = (int)((capture[1] - ubase) >> 1);
    ScrArr *row = scr_arr_new(SCR_ELEM_STR, (size_t)capture_count);
    for (int k = 0; k < capture_count; k++) {
      const uint8_t *cs = capture[2 * k], *ce = capture[2 * k + 1];
      if (cs == NULL || ce == NULL) {
        scr_arr_push_ref(row, scr_str_new("", 0));
      } else {
        scr_arr_push_ref(
            row, scr_str_from_utf16(u, (int)((cs - ubase) >> 1), (int)((ce - ubase) >> 1)));
      }
    }
    scr_arr_push_ref(out, row);
    if (indices != NULL) scr_arr_push_f64(indices, (double)start);
    pos = end == start ? scr_advance(u, len, end, unicode) : end;
  }
  free(capture);
  free(u);
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
static void scr_put_substitution(ScrJsonBuf *b, const uint16_t *u, int len,
                                  int start, int end, uint8_t **capture,
                                  int capture_count, const char *groupnames,
                                  const ScrStr *rep) {
  const uint8_t *ubase = (const uint8_t *)u;
  size_t i = 0;
  while (i < rep->len) {
    char c = rep->data[i];
    if (c != '$' || i + 1 >= rep->len) {
      scr_jb_putc(b, c);
      i++;
      continue;
    }
    char c1 = rep->data[i + 1];
    if (c1 == '$') {
      scr_jb_putc(b, '$');
      i += 2;
    } else if (c1 == '&') {
      scr_jb_put_utf16(b, u, start, end);
      i += 2;
    } else if (c1 == '`') {
      scr_jb_put_utf16(b, u, 0, start);
      i += 2;
    } else if (c1 == '\'') {
      scr_jb_put_utf16(b, u, end, len);
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
          scr_jb_put_utf16(b, u, (int)((cs - ubase) >> 1), (int)((ce - ubase) >> 1));
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
            scr_jb_put_utf16(b, u, (int)((cs - ubase) >> 1), (int)((ce - ubase) >> 1));
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
  bool unicode = (re_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  int capture_count = lre_get_capture_count(bc);
  const char *groupnames = lre_get_groupnames(bc);
  int len;
  uint16_t *u = scr_to_utf16(s, &len);
  uint8_t **capture = scr_capture_alloc(bc);
  const uint8_t *ubase = (const uint8_t *)u;
  ScrJsonBuf b;
  scr_jb_init(&b);
  int next = 0, pos = 0;
  while (pos <= len) {
    if (scr_exec(capture, bc, u, pos, len) != 1) break;
    int start = (int)((capture[0] - ubase) >> 1);
    int end = (int)((capture[1] - ubase) >> 1);
    scr_jb_put_utf16(&b, u, next, start);
    scr_put_substitution(&b, u, len, start, end, capture, capture_count, groupnames, rep);
    next = end;
    if (!global) break;
    pos = end == start ? scr_advance(u, len, end, unicode) : end;
  }
  scr_jb_put_utf16(&b, u, next, len);
  free(capture);
  free(u);
  return scr_jb_finish(&b);
}

ScrStr *scr_regex_replace(ScrStr *s, ScrRegex *re, ScrStr *rep) {
  return scr_replace_impl(s, re, rep);
}

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
  if (lre_get_capture_count(bc) > 1) {
    /* JS splices every capture group's value into the result between the
     * pieces, changing the array's SHAPE per match — not modeled this
     * slice. Catchable, scriptc-specific. */
    static const char msg[] =
        "split() with capture groups in the pattern is not "
        "supported (JS splices the captured values into the result); use a "
        "non-capturing group (?:...)";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL; /* callers are compiler-emitted pending checks */
  }
  int re_flags = lre_get_flags(bc);
  bool unicode = (re_flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  bool sticky = (re_flags & LRE_FLAG_STICKY) != 0;
  int len;
  uint16_t *u = scr_to_utf16(s, &len);
  uint8_t **capture = scr_capture_alloc(bc);
  const uint8_t *ubase = (const uint8_t *)u;
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);

  /* ECMA-262 22.2.6.14 (Symbol.split, no limit). The spec probes every
   * position with a sticky matcher; for non-sticky patterns a forward
   * SEARCH from q is equivalent (the earliest match position >= q is the
   * first probe that would succeed) and one exec replaces the per-position
   * loop. A genuinely sticky pattern keeps the spec's probe-and-advance. */
  if (len == 0) {
    /* Empty subject: one probe — a match yields [], no match yields [""]. */
    if (scr_exec(capture, bc, u, 0, len) != 1) {
      scr_arr_push_ref(out, scr_str_new("", 0));
    }
    free(capture);
    free(u);
    return out;
  }
  int p = 0, q = 0;
  while (q < len) {
    if (scr_exec(capture, bc, u, q, len) != 1) {
      if (!sticky) break; /* no match anywhere right of q */
      q = scr_advance(u, len, q, unicode);
      continue;
    }
    int start = (int)((capture[0] - ubase) >> 1);
    int end = (int)((capture[1] - ubase) >> 1);
    if (end == p) {
      /* Zero-length match adjacent to the previous split point: advance
       * (start == q == p here — the search cannot skip a match). */
      q = scr_advance(u, len, start, unicode);
    } else {
      scr_arr_push_ref(out, scr_str_from_utf16(u, p, start));
      if (out->len == limit) {
        free(capture);
        free(u);
        return out;
      }
      p = end;
      q = p;
    }
  }
  scr_arr_push_ref(out, scr_str_from_utf16(u, p, len));
  free(capture);
  free(u);
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
  ScrJsonBuf b;
  scr_jb_init(&b);
  uint32_t res[LRE_CC_RES_LEN_MAX];
  for (size_t i = 0; i < s->len;) {
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

/* ── assert.match / assert.doesNotMatch ──────────────────────────────────
 * Lives here (not scr_assert.c) because it needs the matcher, and every
 * call site carries a regex value — the regex link switch is already on,
 * so assert-only binaries never pull libregexp. A fresh exec from index 0:
 * Node's exec on a fresh regex literal; lastIndex statefulness is not
 * modeled anywhere in this runtime, so g/y-flagged regexes test like
 * their flag-free twins here instead of aborting (assert.match(s, /x/g)
 * works in Node — matching that beats scr_regex_test's fence;
 * SEMANTICS.md 107 covers reused stateful regexes). */
/* A fresh exec from index 0 (assert.match's stance: g/y-flagged regexes
 * test like their flag-free twins here — SEMANTICS.md 107 covers reused
 * stateful regexes). */
static bool scr_assert_regex_hits(ScrRegex *re, ScrStr *s) {
  uint8_t *bc = scr_regex_bc(re);
  int len;
  uint16_t *u = scr_to_utf16(s, &len);
  uint8_t **capture = scr_capture_alloc(bc);
  bool matched = scr_exec(capture, bc, u, 0, len) == 1;
  free(capture);
  free(u);
  return matched;
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
ScrRegex *scr_regex_new(ScrStr *pattern, ScrStr *flags) {
  for (size_t i = 0; i < flags->len; i++) {
    switch (flags->data[i]) {
    case 'g': case 'i': case 'm': case 's': case 'u': case 'y':
      break;
    default: {
      char msg[80];
      int n = snprintf(msg, sizeof msg,
                       "Invalid flags supplied to RegExp constructor '%.20s'",
                       flags->data);
      scr_throw_error_msg(SCR_ERR_SYNTAX, msg, (size_t)n);
      return NULL;
    }
    }
  }
  ScrRegex *re = calloc(1, sizeof *re);
  if (!re) {
    scr_trap("scriptc: out of memory\n");
  }
  re->rc = 1;
  re->source = pattern->len > 0 ? scr_str_retain(pattern) : scr_str_new("(?:)", 4);
  re->flags = scr_str_retain(flags);
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
