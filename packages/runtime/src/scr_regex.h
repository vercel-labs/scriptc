/* scriptc runtime — regular expressions (scr_regex.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_REGEX_H
#define SCR_REGEX_H

#include "scr_array.h"

typedef int32_t (*ScrRegexMatcherFn)(const uint8_t *s, int32_t len, int32_t start,
                                     uint8_t **capture);

typedef struct ScrRegex {
  size_t rc;      /* SIZE_MAX = immortal literal template */
  ScrStr *source; /* pattern text between the slashes */
  ScrStr *flags;  /* flags text, source order (alphabet fenced to gimsuy) */
  uint8_t *bc;    /* lazily compiled libregexp bytecode; NULL until first use */
  double last_index;
  struct ScrRegex *literal; /* immutable bytecode owner for literal instances */
  void *native;   /* one-byte-subject matcher built with bc (NULL: lre_exec only) */
  /* Build-time matcher of a literal template (NULL: none). Searches the
   * ASCII bytes s[0..len) from start (one anchored attempt when sticky);
   * on a match stores 2 * ncap pointers into s (NULL when unset) and
   * returns 1, otherwise 0. A negative len returns ncap. */
  ScrRegexMatcherFn matcher;
} ScrRegex;

/* Backtrack stack of build-time regex matchers: grow *stack (initially the
 * matcher's inline buffer) to at least `need` words; traps on OOM. */
void scr_regex_stack_grow(int32_t **stack, int32_t *cap, int32_t *inline_buf, int32_t need);
void scr_regex_stack_free(int32_t *stack);

static inline ScrRegex *scr_regex_retain(ScrRegex *re) {
  if (re->rc != SIZE_MAX) re->rc++;
  return re;
}

void scr_regex_release(ScrRegex *re); /* NULL-tolerant */
void *scr_regex_retain_v(void *re);
void scr_regex_release_v(void *re);
ScrRegex *scr_regex_literal(ScrRegex *literal); /* fresh state, shared cached bytecode */
double scr_regex_last_index(ScrRegex *re);

/* new RegExp(pattern, flags): a heap ScrRegex over the same engine. The
 * pattern compiles EAGERLY — an invalid pattern or flag throws Node's
 * catchable SyntaxError at construction (detail text is libregexp's,
 * approximate fidelity; e.name exact). An empty pattern stores the
 * spec's "(?:)" source. Borrows both; +1, NULL after a throw. */
ScrRegex *scr_regex_new(ScrStr *pattern, ScrStr *flags);

bool scr_regex_test(ScrRegex *re, ScrStr *s); /* exec state transitions */
/* s.match(re): +1 string[] of whole matches under /g, otherwise
 * [whole, ...captures] (nonparticipating captures hold ""), or NULL for
 * no match. Non-global /y uses exec state transitions. Borrows both. */
ScrArr *scr_regex_match(ScrStr *s, ScrRegex *re);
/* re.exec(s), string-first ABI: match slice with global/sticky lastIndex
 * transitions. Borrows both; +1 or NULL. */
ScrArr *scr_regex_exec(ScrStr *s, ScrRegex *re);
/* exec for a result read only through constant indices and null tests:
 * bit k of `mask` (k < 53) selects the captures that are materialized; the
 * rest, and the index/input properties, are left out. Same lastIndex
 * transitions and NULL result as scr_regex_exec. Borrows both; +1 or NULL. */
ScrArr *scr_regex_exec_groups(ScrStr *s, ScrRegex *re, double mask);
/* scr_regex_exec_groups whose captures in `lazy` (a subset of `mask`) are
 * read only through scr_regex_group_eq/_number/_parse_int: they may stay
 * spans of the subject instead of strings. */
ScrArr *scr_regex_exec_spans(ScrStr *s, ScrRegex *re, double mask, double lazy);
/* s.match(re) read only through constant indices and null tests: a global
 * regex answers scr_regex_match; otherwise scr_regex_exec_spans. */
ScrArr *scr_regex_match_groups(ScrStr *s, ScrRegex *re, double mask, double lazy);
/* Reads of a lazy capture k of such a result (borrowed): `capture === lit`,
 * Number(capture) and parseInt(capture, radix). */
bool scr_regex_group_eq(ScrArr *m, double k, ScrStr *lit);
double scr_regex_group_number(ScrArr *m, double k);
double scr_regex_group_parse_int(ScrArr *m, double k, double radix);
/* s.search(re): the first match's UTF-16 index, or -1 — a fresh exec from
 * position 0 (Symbol.search never touches lastIndex, so no flag fence:
 * /g is irrelevant, /y anchors at 0). Borrows both; never throws. */
double scr_regex_search(ScrStr *s, ScrRegex *re);
ScrStr *scr_regex_source(ScrRegex *re);       /* +1 */
ScrStr *scr_regex_flags(ScrRegex *re);        /* +1 */
ScrStr *scr_regex_to_string(ScrRegex *re);    /* +1 */
/* replace: first match without /g, every match with it. */
ScrStr *scr_regex_replace(ScrStr *s, ScrRegex *re, ScrStr *rep);
/* The output of a build-time replacer (regex-matchers.ts): the replacer
 * appends each gap and the replacement at data[len] after reserving room,
 * and leaves in `next` the subject index the unmatched tail starts at. */
typedef struct {
  int64_t len;
  int64_t cap;
  int64_t next;
  char *data; /* at offset 24 on every target */
  ScrStr *str;
} ScrReReplaceOut;
/* Grows o->str so that `need` more bytes fit at o->data[o->len]. */
void scr_re_replace_out_reserve(ScrReReplaceOut *o, int64_t need);
/* A global substitution with a literal ASCII replacement, through the
 * replacer built for that pattern and replacement. Borrows all. */
ScrStr *scr_regex_replace_with(ScrStr *s, ScrRegex *re, ScrStr *rep,
                               ScrRegexMatcherFn replacer);
/* replace/replaceAll with a replacer closure of `arity` (at most
 * SCR_REPLACER_MAX_ARITY) parameters. Parameter i receives what Node passes
 * at position i: the match and captures below the capture count n, the
 * match offset at n, the subject at n + 1, the groups object at n + 2 when
 * the pattern has named groups, and undefined after that. Bit i of
 * `kinds` makes parameter i a checked-dynamic value, and bit
 * SCR_REPLACER_OPTIONAL << i a capture held as a string or NULL for
 * undefined; otherwise it is a string, or a number at n.
 * SCR_REPLACER_BOXED_RESULT makes the result a checked-dynamic value,
 * converted with ToString. The compiler admits a closure only when every
 * typed position it declares is one of those with the declared kind, and
 * every capture a string parameter reads is set in every match
 * (scr_regex_replace_callback handles the rest). Borrows all. */
#define SCR_REPLACER_MAX_ARITY 6
#define SCR_REPLACER_BOXED_PARAMS 0xffu
#define SCR_REPLACER_OPTIONAL (1u << 8)
#define SCR_REPLACER_BOXED_RESULT (1u << 31)
struct ScrClosure;
ScrStr *scr_regex_replace_fn(ScrStr *s, ScrRegex *re, struct ScrClosure *f, uint32_t arity,
                             uint32_t kinds, bool all);
/* replaceAll: throws Node's TypeError when /g is missing (may-throw). */
ScrStr *scr_regex_replace_all(ScrStr *s, ScrRegex *re, ScrStr *rep);
/* split: captured substrings are interleaved with the split pieces;
 * unmatched groups become present undefined elements, not holes.
 * limit uses ToUint32; the no-limit wrapper supplies 2^32-1. */
ScrArr *scr_regex_split(ScrStr *s, ScrRegex *re);
ScrArr *scr_regex_split_limit(ScrStr *s, ScrRegex *re, double limit);
/* matchAll drained eagerly: +1 string[][] of honest match slices; throws
 * Node's TypeError on a non-global regex (catchable). Each row carries its
 * index, input and groups properties. */
ScrArr *scr_regex_match_all(ScrStr *s, ScrRegex *re);
/* scr_regex_match_all for rows read only through their elements: the rows
 * carry no index, input or groups properties. */
ScrArr *scr_regex_match_all_captures(ScrStr *s, ScrRegex *re);
/* matchAll + the companion-index drain: also pushes each match's UTF-16
 * start index (f64) onto `indices` — the .index the for-of-over-matchAll
 * desugar reads. Same throw/result contract as scr_regex_match_all. */
ScrArr *scr_regex_match_all_into(ScrStr *s, ScrRegex *re, ScrArr *indices);
/* scr_regex_match_all_into for rows read only through their elements and
 * the companion index: the rows carry no index, input or groups
 * properties. */
ScrArr *scr_regex_match_all_captures_into(ScrStr *s, ScrRegex *re, ScrArr *indices);
/* `.index` / `.input` of a match result: its pending match source or its
 * metadata answers, without building the metadata object; undefined when
 * neither has the key. Borrows both; +1. */
struct ScrDyn *scr_regex_result_prop(ScrArr *a, ScrStr *key);

#endif /* SCR_REGEX_H */
