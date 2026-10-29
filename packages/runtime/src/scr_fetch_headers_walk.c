/* Headers iteration for a typed `for..of` over entries(), keys() or values().
 *
 * A separate runtime unit, selected only by programs that iterate a static
 * Headers: adding these functions to scr_fetch.c changes that unit's object
 * for every fetch program, and the linker carries the difference into each
 * executable.
 *
 * Both entries drive the fetch unit's OWN live iterator (sf_headers_step,
 * through the tag's `iter_step`), so a body that appends, sets or deletes
 * headers visits exactly what Node's live iterator visits.
 */
#include "scr_runtime.h"

/* sf_headers_invoke's `entries` selection: Node's headers.entries() yields
 * a [name, value] pair. */
#define SCR_FETCH_HEADERS_ENTRIES 2u

static void scr_fetch_headers_not_headers(void) {
  static const char message[] = "Headers iterator received a value that is not a Headers";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
}

/* The tag's step entry for a Headers, or NULL (TypeError thrown) for any
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

/* One live step of `headers`' entries iterator from `*at`, or NULL with the
 * exception pending. */
static ScrDyn *scr_fetch_headers_walk_step(const ScrDynHandleOps *ops, ScrDyn *headers,
                                           double *at) {
  return ops->iter_step(headers->v.handle.ptr, at, SCR_FETCH_HEADERS_ENTRIES);
}

/* The number of entries the headers answer right now. The lowered loop
 * re-reads this on every iteration, so a body that adds or deletes headers
 * moves the bound exactly as Node's iterator moves its own end. */
double scr_fetch_headers_count(ScrDyn *headers) {
  const ScrDynHandleOps *ops = scr_fetch_headers_walk_ops(headers);
  if (!ops) return 0;
  double at = 0;
  double count = 0;
  for (;;) {
    ScrDyn *result = scr_fetch_headers_walk_step(ops, headers, &at);
    if (!result) return count;
    bool done = scr_dyn_truthy(scr_dyn_obj_get(result, "done", 4));
    scr_dyn_release(result);
    if (done) return count;
    count += 1;
  }
}

/* The `index`th live entry's name (part 0) or value (part 1), +1. An entry
 * opens its own iterator at 0 and advances `index` steps, so one walk costs
 * O(entries^2) — header lists hold a handful of names, and carrying a cursor
 * across the loop instead would need a new handle kind to open, step and
 * release on every `break`, `return` and throw out of the body. Past the end
 * (a body deleted entries the count had already seen) answers "". */
ScrStr *scr_fetch_headers_entry(ScrDyn *headers, double index, double part) {
  const ScrDynHandleOps *ops = scr_fetch_headers_walk_ops(headers);
  if (!ops) return scr_str_new("", 0);
  double at = 0;
  for (;;) {
    ScrDyn *result = scr_fetch_headers_walk_step(ops, headers, &at);
    if (!result) return scr_str_new("", 0);
    bool done = scr_dyn_truthy(scr_dyn_obj_get(result, "done", 4));
    double emitted = at - 1;
    if (done || emitted < index) {
      scr_dyn_release(result);
      if (done) return scr_str_new("", 0);
      continue;
    }
    ScrDyn *pair = scr_dyn_obj_get(result, "value", 5);
    ScrStr *out = NULL;
    if (pair && pair->kind == SCR_DYN_ARR) {
      ScrDyn *element = scr_dyn_arr_at(pair, part);
      if (element) {
        out = element->kind == SCR_DYN_STR ? scr_str_retain(element->v.str)
                                          : scr_dyn_to_string(element, NULL);
        scr_dyn_release(element);
      }
    }
    scr_dyn_release(result);
    return out ? out : scr_str_new("", 0);
  }
}
