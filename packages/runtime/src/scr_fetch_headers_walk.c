/* Headers iteration for a typed `for..of` over entries(), keys() or values().
 *
 * A separate runtime unit, selected only by programs that iterate a static
 * Headers: adding these functions to scr_fetch.c changes that unit's object
 * for every fetch program, and the linker carries the difference into each
 * executable.
 *
 * Both entries read the fetch unit's OWN live list through the tag's
 * indexed hooks (iter_count, iter_at), the same entries the tag's iterator
 * steps through, so a body that appends, sets or deletes headers visits
 * exactly what Node's live iterator visits. Each entry costs one O(1)
 * read: a walk keeps no cursor, re-counts nothing and allocates no
 * iterator result.
 */
#include "scr_runtime.h"

/* The fetch unit's `iter_at` selections: 1 answers the entry's name, 0 its
 * value. */
#define SCR_FETCH_HEADERS_NAME 1u
#define SCR_FETCH_HEADERS_VALUE 0u

static void scr_fetch_headers_not_headers(void) {
  static const char message[] = "Headers iterator received a value that is not a Headers";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
}

/* The tag's indexed hooks for a Headers, or NULL (TypeError thrown) for any
 * other value. Typed code can only pass a Headers here; this guards the
 * checked-dynamic crossing and a NULL box. */
static const ScrDynHandleOps *scr_fetch_headers_walk_ops(const ScrDyn *headers) {
  if (!headers || headers->kind != SCR_DYN_HANDLE ||
      headers->v.handle.tag != SCR_DYNH_FETCH_HEADERS) {
    scr_fetch_headers_not_headers();
    return NULL;
  }
  return scr_dyn_handle_ops_of(headers);
}

/* The number of entries the headers answer right now. The lowered loop
 * re-reads this on every iteration, so a body that adds or deletes headers
 * moves the bound exactly as Node's iterator moves its own end. */
double scr_fetch_headers_count(ScrDyn *headers) {
  const ScrDynHandleOps *ops = scr_fetch_headers_walk_ops(headers);
  if (!ops || !ops->iter_count) return 0;
  return ops->iter_count(headers->v.handle.ptr);
}

/* The `index`th live entry's name (part 0) or value (part 1), +1. Past the
 * end (a body deleted entries the count had already seen) answers "". */
ScrStr *scr_fetch_headers_entry(ScrDyn *headers, double index, double part) {
  const ScrDynHandleOps *ops = scr_fetch_headers_walk_ops(headers);
  if (!ops || !ops->iter_at || !(index >= 0)) return scr_str_new("", 0);
  ScrStr *out =
      ops->iter_at(headers->v.handle.ptr, (size_t)index,
                   part == 0 ? SCR_FETCH_HEADERS_NAME : SCR_FETCH_HEADERS_VALUE);
  return out ? out : scr_str_new("", 0);
}
