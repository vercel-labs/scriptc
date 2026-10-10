/* Prototype-method dispatch on checked-dynamic receivers (scr_dyn_invoke)
 * and its companions: JS String() over the checked-dynamic tree (scr_dyn_display — join
 * and the error texts need it standalone) and Object.defineProperties
 * over dyn values (scr_dyn_define_props). Linked only when the IR
 * carries dynInvoke nodes or dyn.defineProps calls (native-toolchain.ts gates on
 * moduleUsesDynInvoke — the scr_assert.c precedent), so dispatch-free
 * binaries keep their exact size class. The checked-dynamic tree itself lives in
 * scr_json.c; this unit uses only its public surface plus ScrJsonBuf.
 */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h> /* malloc/free in the sort snapshot */
#include <string.h>

/* ── checked-dynamic METHOD DISPATCH (scr_dyn_invoke) ──────────────────
 *
 * `recv.m(args)` where recv is a dyn value and `m` is a name a
 * dyn-representable prototype declares (Array/String/Function shared
 * names — push, slice, forEach, apply, ...): a stored-member read would
 * silently mis-answer real methods, so the dispatch runs HERE, over the
 * receiver's runtime kind. test/common's mustCall internals are the
 * canonical caller (mustCallChecks.push/filter/forEach, fn.apply).
 *
 * Honesty ladder, per (kind, name):
 *   - implemented: JS-exact semantics below;
 *   - the name exists on that kind's JS prototype but has no
 *     implementation here: a LOUD "not supported yet" Error — never a
 *     silent wrong answer;
 *   - the name does not exist on that kind's prototype: Node's own
 *     TypeError ("<spelling> is not a function"), because that IS the
 *     JS answer;
 *   - OBJ receivers: the own member calls (own properties shadow the
 *     prototype in JS too), otherwise "<spelling> is not a function";
 *   - undefined/null receivers: Node's "Cannot read properties of ...".
 *
 * recv/args are BORROWED; the result is owned (+1). MAY THROW (returns
 * NULL with the exception pending). */

/* JS String() over a dyn value, runtime-side (join needs it standalone —
 * the emitted sc_ds walker exists only in programs that spell
 * String(unknown) themselves). Same rules: arrays join with "," and
 * null/undefined elements print empty, the checked-dynamic tree's error encoding renders
 * "name: message", functions render the native-code form, plain objects
 * are [object Object]. */
static void scr_dyn_display_buf(ScrJsonBuf *b, const ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_SYMBOL: {
    ScrStr *s = scr_dyn_string_coerce(d);
    scr_str_release(s);
    return;
  }
  case SCR_DYN_UNDEF: scr_jb_puts(b, "undefined"); return;
  case SCR_DYN_NULL: scr_jb_puts(b, "null"); return;
  case SCR_DYN_BOOL: scr_jb_puts(b, d->v.b ? "true" : "false"); return;
  case SCR_DYN_BIGINT: {
    ScrStr *s = scr_bigint_to_string(d->v.bigint, 10);
    for (size_t i = 0; i < s->len; i++) scr_jb_putc(b, s->data[i]);
    scr_str_release(s);
    return;
  }
  case SCR_DYN_NUM: {
    ScrStr *s = scr_f64_to_scrstr(d->v.num);
    for (size_t i = 0; i < s->len; i++) scr_jb_putc(b, s->data[i]);
    scr_str_release(s);
    return;
  }
  case SCR_DYN_STR:
    for (size_t i = 0; i < d->v.str->len; i++) scr_jb_putc(b, d->v.str->data[i]);
    return;
  case SCR_DYN_ARR:
    for (size_t i = 0; i < d->v.arr.len; i++) {
      if (i > 0) scr_jb_putc(b, ',');
      ScrDyn *e = scr_dyn_arr_at(d, (double)i);
      if (!e) return;
      if (e->kind != SCR_DYN_UNDEF && e->kind != SCR_DYN_NULL) scr_dyn_display_buf(b, e);
      scr_dyn_release(e);
      if (scr_exc_pending()) return;
    }
    return;
  case SCR_DYN_OBJ: {
    const ScrDyn *marker = scr_dyn_obj_get(d, "%error", 6);
    if (marker) {
      const ScrDyn *en = scr_dyn_obj_get(d, "name", 4);
      const ScrDyn *em = scr_dyn_obj_get(d, "message", 7);
      const ScrStr *ens = (en && en->kind == SCR_DYN_STR) ? en->v.str : NULL;
      const ScrStr *ems = (em && em->kind == SCR_DYN_STR) ? em->v.str : NULL;
      if (ens) for (size_t i = 0; i < ens->len; i++) scr_jb_putc(b, ens->data[i]);
      if (ens && ens->len && ems && ems->len) scr_jb_puts(b, ": ");
      if (ems) for (size_t i = 0; i < ems->len; i++) scr_jb_putc(b, ems->data[i]);
      return;
    }
    scr_jb_puts(b, "[object Object]");
    return;
  }
  case SCR_DYN_BYTES:
    if (d->buffer) {
      /* Buffer-flavored values (stream chunks) coerce utf8 (Node's
       * Buffer.toString); plain Uint8Array joins its elements. */
      ScrStr *enc = scr_str_new("utf8", 4);
      ScrStr *txt = scr_bytes_to_str(d->v.bytes, enc);
      scr_str_release(enc);
      for (size_t i = 0; i < txt->len; i++) scr_jb_putc(b, txt->data[i]);
      scr_str_release(txt);
      return;
    }
    for (size_t i = 0; i < d->v.bytes->len; i++) {
      if (i > 0) scr_jb_putc(b, ',');
      ScrStr *n = scr_f64_to_scrstr(scr_bytes_get(d->v.bytes, (double)i));
      for (size_t j = 0; j < n->len; j++) scr_jb_putc(b, n->data[j]);
      scr_str_release(n);
    }
    return;
  case SCR_DYN_FUNC:
    scr_jb_puts(b, "function ");
    if (d->v.fn.name) scr_jb_puts(b, d->v.fn.name);
    scr_jb_puts(b, "() { [native code] }");
    return;
  case SCR_DYN_HANDLE: {
    ScrStr *s = scr_dyn_to_string(d, NULL);
    for (size_t i = 0; i < s->len; i++) scr_jb_putc(b, s->data[i]);
    scr_str_release(s);
    return;
  }
  case SCR_DYN_PROMISE:
    /* Object.prototype.toString — promises carry no own toString, and
     * their @@toStringTag is not modeled here; Node's String() answer
     * for a bare promise is "[object Promise]". */
    scr_jb_puts(b, "[object Promise]");
    return;
  case SCR_DYN_JSVAL:
    /* The engine's own ToString (a bridged failure leaves the exception
     * pending and appends nothing — the loud path). */
    scr_dyn_isl_tostr_buf(b, d);
    return;
  case SCR_DYN_TYPED_REF: {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(d);
    scr_dyn_display_buf(b, materialized);
    scr_dyn_release(materialized);
    return;
  }
  case SCR_DYN_PROXY:
    scr_dyn_proxy_unsupported("string conversion");
    return;
  }
}

ScrStr *scr_dyn_display(const ScrDyn *d) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_dyn_display_buf(&b, d);
  return scr_jb_finish(&b);
}

static void dyn_throw_not_fn(const char *what) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

static void dyn_throw_unsupported(const char *proto, const char *method) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_putc(&b, '\'');
  scr_jb_puts(&b, proto);
  scr_jb_puts(&b, ".prototype.");
  scr_jb_puts(&b, method);
  scr_jb_puts(&b, "' on a dynamic value is not supported yet");
  scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
}

/* ToIntegerOrInfinity over an optional index argument. Missing and
 * undefined use the operation's default; present values run ToNumber once. */
static double dyn_index_arg(ScrDyn *const *args, size_t argc, size_t i, double dflt, const char *what) {
  (void)what;
  if (i >= argc || args[i]->kind == SCR_DYN_UNDEF) return dflt;
  double number;
  if (!scr_dyn_number_coerce_js(args[i], &number)) return 0;
  return isnan(number) ? 0 : trunc(number);
}

static double dyn_bytes_index_arg(ScrDyn *const *args, size_t argc, size_t index, double fallback) {
  if (index >= argc || args[index]->kind == SCR_DYN_UNDEF) return fallback;
  double value;
  if (!scr_dyn_number_coerce_js(args[index], &value)) return 0;
  return isnan(value) ? 0 : trunc(value);
}

/* JS relative-index normalization (slice's rule). */
static size_t dyn_rel_index(double rel, size_t len) {
  if (rel < 0) {
    double r = (double)len + rel;
    return r < 0 ? 0 : (size_t)r;
  }
  return rel > (double)len ? len : (size_t)rel;
}

static bool dyn_arr_length_unchanged(const ScrDyn *recv, size_t length) {
  if (recv->v.arr.len == length) return true;
  static const char message[] = "Array method after an argument changes the receiver length is not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return false;
}

/* The array callback runner (forEach/map/filter/some/every/find/
 * findIndex): calls cb(item, i, recv) per element through the boxed
 * thunk. Returns the owned result or NULL with the exception pending. */
static ScrDyn *dyn_call_cb(ScrDyn *cb, ScrDyn *item, size_t i, ScrDyn *recv) {
  ScrDyn *idx = scr_dyn_new_num((double)i);
  ScrDyn *cbargs[3] = { item, idx, recv };
  ScrDyn *r = scr_dyn_call(cb, cbargs, 3, "callback");
  scr_dyn_release(idx);
  return r;
}

/* The callable-callback gate: JS's "<String(cb)> is not a function". */
static bool dyn_cb_check(ScrDyn *const *args, size_t argc) {
  ScrDyn *cb = argc > 0 ? args[0] : scr_dyn_undefined();
  if (scr_dyn_is_callable(cb)) return true;
  /* An ENGINE function is callable — scr_dyn_call's JSVAL arm routes it
   * (the loops below call through scr_dyn_call, which converts the checked-dynamic tree
   * element arguments per the uniform crossing). A wrapped NON-function
   * falls through to the display path: String(cb) renders through the
   * engine, exactly Node's message. */
  if (cb->kind == SCR_DYN_JSVAL && scr_dyn_isl_typeof_is(cb, "function")) return true;
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_dyn_display_buf(&b, cb);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return false;
}

static bool dyn_borrow_is(const ScrStr *method, const char *name) {
  size_t len = strlen(name);
  return method->len == len && memcmp(method->data, name, len) == 0;
}

static bool dyn_borrow_index(const ScrStr *key, size_t *out) {
  if (!key->len || (key->len > 1 && key->data[0] == '0')) return false;
  size_t n = 0;
  for (size_t i = 0; i < key->len; i++) {
    unsigned digit = (unsigned)(key->data[i] - '0');
    if (digit > 9 || n > (SIZE_MAX - digit) / 10) return false;
    n = n * 10 + digit;
  }
  *out = n;
  return true;
}

static ScrDyn *dyn_borrow_get(ScrDyn *recv, const ScrStr *key) {
  if (recv->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *snapshot = scr_dyn_typed_ref_materialize(recv);
    if (!snapshot) return NULL;
    ScrDyn *result = dyn_borrow_get(snapshot, key);
    scr_dyn_release(snapshot);
    return result;
  }
  if (recv->kind == SCR_DYN_OBJ) return scr_dyn_obj_read(recv, key->data, key->len);
  if (recv->kind == SCR_DYN_PROXY) return scr_dyn_proxy_get(recv, key);
  if (recv->kind == SCR_DYN_JSVAL) return scr_dyn_isl_key_get(recv, key);
  if (recv->kind == SCR_DYN_FUNC) {
    ScrDyn *value = scr_dyn_fn_get(recv, key->data, key->len);
    return value ? value : scr_dyn_retain(scr_dyn_undefined());
  }
  if (recv->kind == SCR_DYN_ARR || recv->kind == SCR_DYN_STR || recv->kind == SCR_DYN_BYTES) {
    if (key->len == 6 && memcmp(key->data, "length", 6) == 0) {
      double length = recv->kind == SCR_DYN_ARR ? (double)recv->v.arr.len
        : recv->kind == SCR_DYN_STR ? scr_str_utf16_len(recv->v.str)
        : (double)recv->v.bytes->len;
      return scr_dyn_new_num(length);
    }
    size_t index;
    if (!dyn_borrow_index(key, &index)) {
      if (recv->kind == SCR_DYN_ARR && recv->v.arr.properties)
        return scr_dyn_arr_named_get(recv, key);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    if (recv->kind == SCR_DYN_ARR && index >= recv->v.arr.len && recv->v.arr.properties)
      return scr_dyn_arr_named_get(recv, key);
    if (recv->kind == SCR_DYN_ARR) return scr_dyn_arr_at(recv, (double)index);
    if (recv->kind == SCR_DYN_BYTES) {
      return index < recv->v.bytes->len
        ? scr_dyn_new_num(scr_bytes_get(recv->v.bytes, (double)index))
        : scr_dyn_retain(scr_dyn_undefined());
    }
    if ((double)index >= scr_str_utf16_len(recv->v.str)) return scr_dyn_retain(scr_dyn_undefined());
    ScrStr *unit = scr_str_slice(recv->v.str, (double)index, (double)index + 1);
    ScrDyn *value = scr_dyn_new_str(unit);
    scr_str_release(unit);
    return value;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static bool dyn_borrow_has(ScrDyn *recv, const ScrStr *key) {
  if (recv->kind == SCR_DYN_STR || recv->kind == SCR_DYN_BYTES) {
    size_t index;
    return dyn_borrow_index(key, &index) &&
      (recv->kind == SCR_DYN_STR
        ? (double)index < scr_str_utf16_len(recv->v.str)
        : index < recv->v.bytes->len);
  }
  if (recv->kind == SCR_DYN_FUNC) {
    ScrDyn *value = scr_dyn_fn_get(recv, key->data, key->len);
    bool present = value != NULL;
    scr_dyn_release(value);
    return present;
  }
  if (recv->kind == SCR_DYN_JSVAL) return scr_dyn_isl_fence(recv, "Array.prototype borrowed property presence");
  return scr_dyn_has_key(recv, key);
}

static ScrStr *dyn_borrow_key(size_t index) {
  char text[32];
  int n = snprintf(text, sizeof text, "%zu", index);
  return scr_str_new(text, (size_t)n);
}

static bool dyn_borrow_length(ScrDyn *recv, size_t *out) {
  ScrStr *key = scr_str_new("length", 6);
  ScrDyn *value = dyn_borrow_get(recv, key);
  scr_str_release(key);
  if (!value) return false;
  double number;
  bool ok = scr_dyn_number_coerce_js(value, &number);
  scr_dyn_release(value);
  if (!ok) return false;
  if (isnan(number) || number <= 0) { *out = 0; return true; }
  number = fmin(trunc(number), 9007199254740991.0);
  if (number > (double)SIZE_MAX) {
    static const char msg[] = "array-like length exceeds the native index range";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return false;
  }
  *out = (size_t)number;
  return true;
}

static bool dyn_borrow_iteration(size_t step) {
  if (step < 1000000) return true;
  static const char msg[] = "array-like iteration over one million entries is not supported yet";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  return false;
}

static bool dyn_borrow_number(const ScrDyn *value, double *out) {
  if (!scr_dyn_number_coerce_js(value, out)) return false;
  if (isnan(*out)) *out = 0;
  else if (isfinite(*out)) *out = trunc(*out);
  return true;
}

static bool dyn_borrow_present(ScrDyn *recv, size_t index) {
  ScrStr *key = dyn_borrow_key(index);
  bool found = dyn_borrow_has(recv, key);
  scr_str_release(key);
  return found;
}

static ScrDyn *dyn_borrow_item(ScrDyn *recv, size_t index) {
  ScrStr *key = dyn_borrow_key(index);
  ScrDyn *value = dyn_borrow_get(recv, key);
  scr_str_release(key);
  return value;
}

ScrDyn *scr_dyn_array_proto_call(ScrDyn *recv, ScrStr *method, ScrDyn *args) {
  if (recv->kind == SCR_DYN_NULL || recv->kind == SCR_DYN_UNDEF) {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  if (!args || args->kind != SCR_DYN_ARR) scr_trap("scriptc: invalid Array.prototype arguments\n");
  ScrDyn *const *argv = args->v.arr.items;
  size_t argc = args->v.arr.len;
  size_t len;
  if (!dyn_borrow_length(recv, &len)) return NULL;

  bool index_of = dyn_borrow_is(method, "indexOf");
  bool last_index_of = dyn_borrow_is(method, "lastIndexOf");
  bool includes = dyn_borrow_is(method, "includes");
  if (index_of || last_index_of || includes) {
    if (len == 0) return includes ? scr_dyn_new_bool(false) : scr_dyn_new_num(-1);
    ScrDyn *needle = argc ? argv[0] : scr_dyn_undefined();
    double from = last_index_of ? (double)len - 1 : 0;
    if (argc > 1 && !dyn_borrow_number(argv[1], &from)) return NULL;
    if (isnan(from)) from = 0;
    else from = trunc(from);
    double first = from < 0 ? (double)len + from : from;
    if (last_index_of) {
      if (from >= 0) first = fmin(from, (double)len - 1);
      if (first >= (double)len) first = (double)len - 1;
      for (size_t step = 0; first >= 0 && step <= (size_t)first; step++) {
        if (len > 1000000 && !dyn_borrow_iteration(step)) return NULL;
        size_t i = (size_t)first - step;
        if (!dyn_borrow_present(recv, i)) { if (scr_exc_pending()) return NULL; continue; }
        ScrDyn *item = dyn_borrow_item(recv, i);
        if (!item) return NULL;
        bool found = scr_dyn_strict_eq(item, needle);
        scr_dyn_release(item);
        if (found) return scr_dyn_new_num((double)i);
      }
      return scr_dyn_new_num(-1);
    }
    if (first < 0) first = 0;
    if (first >= (double)len) return includes ? scr_dyn_new_bool(false) : scr_dyn_new_num(-1);
    for (size_t i = (size_t)first; i < len; i++) {
      if (len > 1000000 && !dyn_borrow_iteration(i - (size_t)first)) return NULL;
      if (!includes && !dyn_borrow_present(recv, i)) { if (scr_exc_pending()) return NULL; continue; }
      ScrDyn *item = dyn_borrow_item(recv, i);
      if (!item) return NULL;
      bool found = scr_dyn_strict_eq(item, needle) ||
        (includes && item->kind == SCR_DYN_NUM && needle->kind == SCR_DYN_NUM &&
         isnan(item->v.num) && isnan(needle->v.num));
      scr_dyn_release(item);
      if (found) return includes ? scr_dyn_new_bool(true) : scr_dyn_new_num((double)i);
    }
    return includes ? scr_dyn_new_bool(false) : scr_dyn_new_num(-1);
  }
  if (dyn_borrow_is(method, "at")) {
    double offset = 0;
    if (argc && !dyn_borrow_number(argv[0], &offset)) return NULL;
    double index = offset < 0 ? (double)len + offset : offset;
    return index >= 0 && index < (double)len
      ? dyn_borrow_item(recv, (size_t)index)
      : scr_dyn_retain(scr_dyn_undefined());
  }
  if (dyn_borrow_is(method, "slice")) {
    if (recv->kind == SCR_DYN_PROXY) {
      scr_dyn_proxy_unsupported("Array.prototype.slice");
      return NULL;
    }
    double startD = 0;
    double endD = (double)len;
    if (argc && !dyn_borrow_number(argv[0], &startD)) return NULL;
    if (argc > 1 && argv[1]->kind != SCR_DYN_UNDEF && !dyn_borrow_number(argv[1], &endD)) return NULL;
    if (isnan(startD)) startD = 0;
    if (isnan(endD)) endD = 0;
    size_t start = dyn_rel_index(trunc(startD), len);
    size_t end = dyn_rel_index(trunc(endD), len);
    if (end > start && end - start > 1000000) {
      static const char message[] = "Array.prototype.slice exceeds the native iteration limit";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t i = start; i < end; i++) {
      if (!dyn_borrow_iteration(i - start)) { scr_dyn_release(out); return NULL; }
      bool present = dyn_borrow_present(recv, i);
      if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
      if (!present) {
        scr_dyn_arr_push_hole(out);
        continue;
      }
      ScrDyn *item = dyn_borrow_item(recv, i);
      if (!item) { scr_dyn_release(out); return NULL; }
      scr_dyn_arr_push(out, item);
    }
    return out;
  }

  bool each = dyn_borrow_is(method, "forEach");
  bool map = dyn_borrow_is(method, "map");
  bool filter = dyn_borrow_is(method, "filter");
  bool some = dyn_borrow_is(method, "some");
  bool every = dyn_borrow_is(method, "every");
  bool find = dyn_borrow_is(method, "find");
  bool find_index = dyn_borrow_is(method, "findIndex");
  bool find_last = dyn_borrow_is(method, "findLast");
  bool find_last_index = dyn_borrow_is(method, "findLastIndex");
  bool reduce = dyn_borrow_is(method, "reduce");
  bool reduce_right = dyn_borrow_is(method, "reduceRight");
  if (!(each || map || filter || some || every || find || find_index || find_last || find_last_index || reduce || reduce_right)) {
    static const char msg[] = "Array.prototype method is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return NULL;
  }
  if (!dyn_cb_check(argv, argc)) return NULL;
  ScrDyn *cb = argv[0];
  if (reduce || reduce_right) {
    ScrDyn *acc = argc > 1 ? scr_dyn_retain(argv[1]) : NULL;
    for (size_t step = 0; step < len; step++) {
      if (len > 1000000 && !dyn_borrow_iteration(step)) { scr_dyn_release(acc); return NULL; }
      size_t i = reduce_right ? len - 1 - step : step;
      if (!dyn_borrow_present(recv, i)) { if (scr_exc_pending()) { scr_dyn_release(acc); return NULL; } continue; }
      ScrDyn *item = dyn_borrow_item(recv, i);
      if (!item) { scr_dyn_release(acc); return NULL; }
      if (!acc) { acc = item; continue; }
      ScrDyn *idx = scr_dyn_new_num((double)i);
      ScrDyn *cbargs[4] = { acc, item, idx, recv };
      ScrDyn *next = scr_dyn_call(cb, cbargs, 4, "callback");
      scr_dyn_release(idx);
      scr_dyn_release(item);
      scr_dyn_release(acc);
      if (!next) return NULL;
      acc = next;
    }
    if (acc) return acc;
    static const char msg[] = "Reduce of empty array with no initial value";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }

  ScrDyn *out = (map || filter) ? scr_dyn_new_arr() : NULL;
  ScrDyn *this_arg = argc > 1 ? argv[1] : scr_dyn_undefined();
  for (size_t i = 0; i < len; i++) {
    if (len > 1000000 && !dyn_borrow_iteration(i)) { scr_dyn_release(out); return NULL; }
    size_t index = find_last || find_last_index ? len - 1 - i : i;
    bool present = find || find_index || find_last || find_last_index || dyn_borrow_present(recv, index);
    if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
    if (!present) {
      if (map) {
        scr_dyn_arr_push_hole(out);
      }
      continue;
    }
    ScrDyn *item = dyn_borrow_item(recv, index);
    if (!item) { scr_dyn_release(out); return NULL; }
    scr_dyn_this_push_dyn(this_arg);
    ScrDyn *result = dyn_call_cb(cb, item, index, recv);
    scr_dyn_this_pop();
    if (!result) { scr_dyn_release(item); scr_dyn_release(out); return NULL; }
    if (map) {
      scr_dyn_arr_push(out, result);
    } else {
      bool truthy = scr_dyn_truthy(result);
      scr_dyn_release(result);
      if (filter && truthy) scr_dyn_arr_push(out, scr_dyn_retain(item));
      if (some && truthy) { scr_dyn_release(item); return scr_dyn_new_bool(true); }
      if (every && !truthy) { scr_dyn_release(item); return scr_dyn_new_bool(false); }
      if ((find || find_last) && truthy) return item;
      if ((find_index || find_last_index) && truthy) { scr_dyn_release(item); return scr_dyn_new_num((double)index); }
    }
    scr_dyn_release(item);
  }
  if (out) return out;
  if (some) return scr_dyn_new_bool(false);
  if (every) return scr_dyn_new_bool(true);
  if (find || find_last) return scr_dyn_retain(scr_dyn_undefined());
  if (find_index || find_last_index) return scr_dyn_new_num(-1);
  return scr_dyn_retain(scr_dyn_undefined());
}

static bool dyn_name_is(const char *m, const char *n) { return strcmp(m, n) == 0; }

/* Handle receivers: hand the whole call to the tag's ops (installed by
 * the owning unit at main() — a missing install is an internal error the
 * accessor reports). */
static ScrDyn *scr_dynh_dispatch(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc, const char *what) {
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(recv);
  if (ops->invoke) return ops->invoke(recv->v.handle.ptr, recv, method, args, argc, what);
  ScrDyn *callable = ops->get ? ops->get(recv->v.handle.ptr, method, strlen(method)) : NULL;
  if (scr_exc_pending()) { scr_dyn_release(callable); return NULL; }
  if (!callable) callable = scr_dyn_retain(scr_dyn_undefined());
  scr_dyn_this_push_dyn(recv);
  ScrDyn *result = scr_dyn_call(callable, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(callable);
  return result;
}

/* JS Array.prototype.sort over a dyn array: the spec's snapshot-sort —
 * elements copy (retained) into a work list, a stable merge sort orders
 * it (undefined elements sink to the end before any comparator runs),
 * and the ordered list writes back index by index, so a comparator that
 * mutates the receiver mid-sort never dangles the items being ordered.
 * The default comparator compares ToString images (scr_dyn_display_buf —
 * join's conversion) bytewise: code-POINT order, where JS orders UTF-16
 * code units — identical through the BMP, divergent only across the
 * surrogate boundary (SEMANTICS.md). A comparator result converts
 * loosely to number; NaN and non-numeric answers count as 0 (ToNumber's
 * common cases; exotic ToString-of-object coercions stay 0). */
static ScrStr *dyn_sort_str(const ScrDyn *e) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_dyn_display_buf(&b, e);
  return scr_jb_finish(&b);
}
static int dyn_sort_compare(ScrDyn *x, ScrDyn *y, ScrDyn *cmp, bool *failed) {
  bool xu = x->kind == SCR_DYN_UNDEF, yu = y->kind == SCR_DYN_UNDEF;
  if (xu || yu) return (xu && yu) ? 0 : xu ? 1 : -1;
  if (cmp) {
    ScrDyn *argv[2] = { x, y };
    ScrDyn *r = scr_dyn_call(cmp, argv, 2, "comparefn");
    if (!r) { *failed = true; return 0; }
    double v = r->kind == SCR_DYN_NUM ? r->v.num : r->kind == SCR_DYN_BOOL ? (r->v.b ? 1 : 0) : 0;
    scr_dyn_release(r);
    return v < 0 ? -1 : v > 0 ? 1 : 0;
  }
  ScrStr *xs = dyn_sort_str(x);
  ScrStr *ys = dyn_sort_str(y);
  int c = scr_str_cmp(xs, ys);
  scr_str_release(xs);
  scr_str_release(ys);
  return c < 0 ? -1 : c > 0 ? 1 : 0;
}
/* Merge sort work[lo, hi) stably (ties keep first-seen order — `<=`
 * takes the left run's element). False when a comparator threw. */
static bool dyn_arr_sort_range(ScrDyn **work, ScrDyn **tmp, size_t lo, size_t hi, ScrDyn *cmp) {
  if (hi - lo < 2) return true;
  size_t mid = lo + (hi - lo) / 2;
  if (!dyn_arr_sort_range(work, tmp, lo, mid, cmp)) return false;
  if (!dyn_arr_sort_range(work, tmp, mid, hi, cmp)) return false;
  size_t i = lo, j = mid, k = lo;
  bool failed = false;
  while (i < mid && j < hi) {
    int c = dyn_sort_compare(work[i], work[j], cmp, &failed);
    if (failed) return false;
    tmp[k++] = c <= 0 ? work[i++] : work[j++];
  }
  while (i < mid) tmp[k++] = work[i++];
  while (j < hi) tmp[k++] = work[j++];
  memcpy(work + lo, tmp + lo, (hi - lo) * sizeof(ScrDyn *));
  return true;
}
static bool dyn_arr_sort(ScrDyn *recv, ScrDyn *cmp) {
  size_t len = recv->v.arr.len;
  ScrDyn **buf = (ScrDyn **)malloc(2 * len * sizeof(ScrDyn *));
  if (!buf) return true; /* OOM: answer the array unsorted over crashing */
  ScrDyn **work = buf, **tmp = buf + len;
  for (size_t i = 0; i < len; i++) work[i] = scr_dyn_retain(recv->v.arr.items[i]);
  bool ok = dyn_arr_sort_range(work, tmp, 0, len, cmp);
  if (ok) {
    /* Write back into whatever the array holds NOW (a mutating comparator
     * may have replaced entries): the work list's +1 moves in, the
     * displaced entry releases. Elements beyond the current length (a
     * shrinking comparator) just release. */
    for (size_t i = 0; i < len; i++) {
      if (i < recv->v.arr.len) {
        ScrDyn *old = recv->v.arr.items[i];
        recv->v.arr.items[i] = work[i];
        scr_dyn_release(old);
      } else {
        scr_dyn_release(work[i]);
      }
    }
  } else {
    for (size_t i = 0; i < len; i++) scr_dyn_release(work[i]);
  }
  free(buf);
  return ok;
}

static bool dyn_arr_flatten(ScrDyn *out, const ScrDyn *source, double depth, size_t *visits) {
  for (size_t i = 0; i < source->v.arr.len; i++) {
    if (++*visits > 1000000) {
      static const char message[] = "Array.prototype.flat exceeds the native iteration limit";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return false;
    }
    if (!dyn_borrow_present((ScrDyn *)source, i)) { if (scr_exc_pending()) return false; continue; }
    ScrDyn *item = dyn_borrow_item((ScrDyn *)source, i);
    if (!item) return false;
    if (depth > 0 && item->kind == SCR_DYN_TYPED_REF && scr_dyn_isl_is_array(item)) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(item);
      if (!view || scr_exc_pending()) { scr_dyn_release(view); scr_dyn_release(item); return false; }
      bool ok = dyn_arr_flatten(out, view, depth - 1, visits);
      scr_dyn_release(view);
      scr_dyn_release(item);
      if (!ok) return false;
      continue;
    }
    if (depth > 0 && item->kind == SCR_DYN_ARR) {
      bool ok = dyn_arr_flatten(out, item, depth - 1, visits);
      scr_dyn_release(item);
      if (!ok) return false;
    } else {
      scr_dyn_arr_push(out, item);
    }
  }
  return true;
}

static bool dyn_arr_copy_item(ScrDyn *out, const ScrDyn *source, size_t index, bool preserve_hole) {
  if (preserve_hole && !dyn_borrow_present((ScrDyn *)source, index)) {
    if (scr_exc_pending()) return false;
    scr_dyn_arr_push_hole(out);
    return true;
  }
  ScrDyn *item = scr_dyn_arr_at(source, (double)index);
  if (!item) return false;
  scr_dyn_arr_push(out, item);
  return true;
}

static bool dyn_arr_reversed_copy(ScrDyn *out, const ScrDyn *source) {
  for (size_t i = source->v.arr.len; i > 0; i--)
    if (!dyn_arr_copy_item(out, source, i - 1, false)) return false;
  return true;
}

/* Names each prototype declares BEYOND what's implemented here — these
 * fence loudly instead of mis-answering "is not a function". */
static bool dyn_arr_proto_unimpl(const char *m) {
  static const char *names[] = { "toString", "toLocaleString", NULL };
  for (size_t i = 0; names[i]; i++) if (dyn_name_is(m, names[i])) return true;
  return false;
}
static bool dyn_arr_proto_mutates(const char *m) {
  static const char *names[] = {
    "push", "pop", "shift", "unshift", "reverse", "sort", "fill", "copyWithin", "splice", NULL
  };
  for (size_t i = 0; names[i]; i++) if (dyn_name_is(m, names[i])) return true;
  return false;
}
static bool dyn_bytes_proto_real(const char *m) {
  static const char *names[] = { "slice", "at", "indexOf", "lastIndexOf", "includes", "join",
    "forEach", "map", "filter", "some", "every", "find", "findIndex", "reverse", "fill", "set",
    "subarray", "sort", "keys", "values", "entries", "reduce", "reduceRight", "copyWithin",
    "toString", "toLocaleString", NULL };
  for (size_t i = 0; names[i]; i++) if (dyn_name_is(m, names[i])) return true;
  return false;
}

static ScrDyn *scr_dyn_invoke_impl(
    ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc,
    const char *what, ScrDyn *callback_recv);

/* Live native arrays: the constant-time methods that loops call once per
 * element. Each mirrors the checked-array dispatch below (which consults
 * neither own properties nor the prototype for these builtins) but touches
 * one native element instead of materializing and recommitting the whole
 * array. Anything that could observe more — a hole, argument coercion, a
 * multi-value push, a value the element type rejects — sets *handled false
 * and takes the snapshot path. */
static ScrDyn *dyn_live_array_method(ScrDyn *recv, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what, bool *handled) {
  const ScrDynTypedArrayOps *ops = recv->v.typed_ref.array;
  if (!ops) return NULL;
  ScrArr *arr = recv->v.typed_ref.ptr;
  size_t len = arr->len;
  if (dyn_name_is(method, "push") && argc == 1 && ops->set) {
    if (!ops->set(arr, (double)len, args[0])) return NULL;
    *handled = true;
    return scr_exc_pending() ? NULL : scr_dyn_new_num((double)arr->len);
  }
  if (dyn_name_is(method, "pop")) {
    if (len == 0) {
      *handled = true;
      return scr_dyn_retain(scr_dyn_undefined());
    }
    ScrDyn *last = scr_dyn_typed_ref_element(recv, len - 1);
    if (!last) return NULL;
    scr_arr_set_len(arr, (double)(len - 1));
    *handled = true;
    return last;
  }
  if (dyn_name_is(method, "at") && (argc == 0 || args[0]->kind == SCR_DYN_NUM || args[0]->kind == SCR_DYN_UNDEF)) {
    double index = dyn_index_arg(args, argc, 0, 0, what);
    if (index < 0) index += (double)len;
    if (index < 0 || index >= (double)len) {
      *handled = true;
      return scr_dyn_retain(scr_dyn_undefined());
    }
    ScrDyn *value = scr_dyn_typed_ref_element(recv, (size_t)index);
    if (value) *handled = true;
    return value;
  }
  return NULL;
}

ScrDyn *scr_dyn_prepare_method(ScrDyn *recv, const char *method) {
  if (recv->kind == SCR_DYN_UNDEF || recv->kind == SCR_DYN_NULL)
    return scr_dyn_invoke(recv, method, NULL, 0, method);
  if (recv->kind == SCR_DYN_OBJ)
    return scr_dyn_obj_read(recv, method, strlen(method));
  if (recv->kind == SCR_DYN_PROXY) {
    ScrStr *key = scr_str_new(method, strlen(method));
    ScrDyn *result = scr_dyn_proxy_get(recv, key);
    scr_str_release(key);
    return result;
  }
  return NULL;
}

ScrDyn *scr_dyn_invoke_prepared(ScrDyn *recv, ScrDyn *callee, const char *method,
                               ScrDyn *const *args, size_t argc, const char *what) {
  if (!callee) return scr_dyn_invoke(recv, method, args, argc, what);
  scr_dyn_this_push_dyn(recv);
  ScrDyn *result = scr_dyn_call(callee, args, argc, what);
  scr_dyn_this_pop();
  return result;
}

ScrDyn *scr_dyn_invoke(ScrDyn *recv, const char *method,
                       ScrDyn *const *args, size_t argc,
                       const char *what) {
  return scr_dyn_invoke_impl(recv, method, args, argc, what, NULL);
}

static ScrDyn *scr_dyn_invoke_impl(
    ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc,
    const char *what, ScrDyn *callback_recv) {
  if (recv->kind == SCR_DYN_UNDEF || recv->kind == SCR_DYN_NULL) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "Cannot read properties of ");
    scr_jb_puts(&b, recv->kind == SCR_DYN_UNDEF ? "undefined" : "null");
    scr_jb_puts(&b, " (reading '");
    scr_jb_puts(&b, method);
    scr_jb_puts(&b, "')");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return NULL;
  }

  /* Native handles dispatch through the tag's ops onto the same entry
   * points the static lowerings use (scr_http/scr_net register them at
   * main()); the ladder inside covers real-but-unimplemented members
   * loudly. */
  if (recv->kind == SCR_DYN_HANDLE) {
    return scr_dynh_dispatch(recv, method, args, argc, what);
  }

  /* Island-held receivers: the ENGINE runs its own prototypes (JS-exact
   * flatMap/map/forEach/filter — Array.prototype is the engine's) through
   * scr_jsval_call_method; arguments cross per the uniform conversion
   * (wrapped cells by reference, dyn data deep-copied, FUNC boxes through
   * the host shim), a missing member throws the engine's own TypeError,
   * and the result wraps back scalar-normalized. `what` is unused — the
   * engine's message names the failure. */
  if (recv->kind == SCR_DYN_JSVAL) {
    return scr_dyn_jsval_ops()->invoke(recv->v.jsval.cell, method, args, argc, what);
  }
  if (recv->kind == SCR_DYN_PROXY) {
    ScrStr *key = scr_str_new(method, strlen(method));
    ScrDyn *callable = scr_dyn_proxy_get(recv, key);
    scr_str_release(key);
    if (!callable) return NULL;
    scr_dyn_this_push_dyn(recv);
    ScrDyn *result = scr_dyn_call(callable, args, argc, what);
    scr_dyn_this_pop();
    scr_dyn_release(callable);
    return result;
  }

  /* Live Web-boundary capsules expose the prototype of their materialized
   * value. Run the ordinary dispatch against the stable snapshot, then
   * commit successful mutations back into the original static value.
   * Mutators such as reverse/sort return their receiver, so translate that
   * snapshot identity back to the externally visible capsule. */
  if (recv->kind == SCR_DYN_TYPED_REF) {
    bool handled = false;
    ScrDyn *fast = dyn_live_array_method(recv, method, args, argc, what, &handled);
    if (handled) return fast;
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(recv);
    if (scr_exc_pending()) {
      scr_dyn_release(materialized);
      return NULL;
    }
    bool mutates = materialized->kind == SCR_DYN_ARR &&
                   dyn_arr_proto_mutates(method);
    ScrDyn *result = scr_dyn_invoke_impl(
        materialized, method, args, argc, what, recv);
    if (mutates && !scr_exc_pending()) scr_dyn_typed_ref_commit(recv);
    if (result == materialized) {
      scr_dyn_release(result);
      result = scr_dyn_retain(recv);
    }
    scr_dyn_release(materialized);
    return result;
  }

  /* OBJ method calls follow the native prototype chain while binding the
   * original receiver as `this`. */
  if (recv->kind == SCR_DYN_OBJ || recv->kind == SCR_DYN_PROXY) {
    ScrDyn *m = scr_dyn_obj_read(recv, method, strlen(method));
    if (m && (scr_dyn_is_callable(m) ||
              /* a WRAPPED engine function stored as a dyn member: the
               * routed call (scr_dyn_call's JSVAL arm) runs it. */
              (m->kind == SCR_DYN_JSVAL && scr_dyn_isl_typeof_is(m, "function")))) {
      /* JS binds the receiver for the call (`obj.method()` — this === obj):
       * the ambient-receiver window (scr_runtime.h). */
      scr_dyn_this_push_dyn(callback_recv ? callback_recv : recv);
      ScrDyn *r = scr_dyn_call(m, args, argc, what);
      scr_dyn_this_pop();
      scr_dyn_release(m);
      return r;
    }
    scr_dyn_release(m);
    dyn_throw_not_fn(what);
    return NULL;
  }

  if (recv->kind == SCR_DYN_FUNC) {
    if (dyn_name_is(method, "apply")) {
      return scr_dyn_apply_array_like(recv, argc ? args[0] : scr_dyn_undefined(),
        argc > 1 ? args[1] : scr_dyn_undefined(), what);
    }
    if (dyn_name_is(method, "call")) {
      scr_dyn_this_push_dyn(argc >= 1 ? args[0] : scr_dyn_undefined());
      ScrDyn *r = scr_dyn_call(recv, argc > 1 ? args + 1 : NULL, argc > 1 ? argc - 1 : 0, what);
      scr_dyn_this_pop();
      return r;
    }
    if (dyn_name_is(method, "bind")) return scr_dyn_bind(recv, args, argc);
    if (dyn_name_is(method, "toString")) {
      ScrDyn *member = scr_dyn_fn_get(recv, method, strlen(method));
      if (member && member->kind != SCR_DYN_UNDEF) {
        scr_dyn_this_push_dyn(recv);
        ScrDyn *result = scr_dyn_call(member, args, argc, what);
        scr_dyn_this_pop();
        scr_dyn_release(member);
        return result;
      }
      scr_dyn_release(member);
      dyn_throw_unsupported("Function", method);
      return NULL;
    }
    /* An OWN property on the FUNC box (defineProperties writes — the
     * mustCall-wrapper expando family): a callable member runs with the
     * box bound (JS's o.m() receiver), everything else keeps Node's
     * is-not-a-function. */
    {
      ScrDyn *own = scr_dyn_fn_get(recv, method, strlen(method));
      if (own) {
        if (own->kind == SCR_DYN_FUNC || own->kind == SCR_DYN_JSVAL) {
          scr_dyn_this_push_dyn(recv);
          ScrDyn *r = scr_dyn_call(own, args, argc, what);
          scr_dyn_this_pop();
          scr_dyn_release(own);
          return r;
        }
        scr_dyn_release(own);
      }
    }
    dyn_throw_not_fn(what);
    return NULL;
  }

  if ((recv->kind == SCR_DYN_SYMBOL || recv->kind == SCR_DYN_BIGINT || recv->kind == SCR_DYN_NUM || recv->kind == SCR_DYN_BOOL || recv->kind == SCR_DYN_STR) &&
      dyn_name_is(method, "valueOf")) return scr_dyn_retain(recv);

  if (recv->kind == SCR_DYN_NUM && dyn_name_is(method, "toFixed")) {
    double digits = dyn_index_arg(args, argc, 0, 0, what);
    if (scr_exc_pending()) return NULL;
    ScrStr *text = scr_num_to_fixed(recv->v.num, digits);
    if (scr_exc_pending()) { scr_str_release(text); return NULL; }
    ScrDyn *result = scr_dyn_new_str(text);
    scr_str_release(text);
    return result;
  }
  if (recv->kind == SCR_DYN_NUM && dyn_name_is(method, "toExponential")) {
    if (argc && args[0]->kind != SCR_DYN_UNDEF) {
      dyn_throw_unsupported("Number", method);
      return NULL;
    }
    ScrStr *text = scr_num_to_exponential(recv->v.num);
    ScrDyn *result = scr_dyn_new_str(text);
    scr_str_release(text);
    return result;
  }

  if (recv->kind == SCR_DYN_STR) {
    ScrStr *s = recv->v.str;
    if (dyn_name_is(method, "slice")) {
      double start = dyn_index_arg(args, argc, 0, 0, what);
      if (scr_exc_pending()) return NULL;
      double end = dyn_index_arg(args, argc, 1, scr_str_utf16_len(s), what);
      if (scr_exc_pending()) return NULL;
      ScrStr *piece = scr_str_slice(s, start, end);
      ScrDyn *r = scr_dyn_new_str(piece); /* retains */
      scr_str_release(piece);
      return r;
    }
    if (dyn_name_is(method, "at") || dyn_name_is(method, "concat") ||
        dyn_name_is(method, "indexOf") || dyn_name_is(method, "lastIndexOf") ||
        dyn_name_is(method, "includes")) {
      if ((dyn_name_is(method, "indexOf") || dyn_name_is(method, "lastIndexOf") ||
           dyn_name_is(method, "includes")) &&
          argc >= 1 && args[0]->kind == SCR_DYN_STR) {
        double position = dyn_index_arg(args, argc, 1, dyn_name_is(method, "lastIndexOf") ? INFINITY : 0, what);
        if (scr_exc_pending()) return NULL;
        if (dyn_name_is(method, "includes")) return scr_dyn_new_bool(scr_str_index_of(s, args[0]->v.str, position) >= 0);
        if (dyn_name_is(method, "indexOf")) return scr_dyn_new_num(scr_str_index_of(s, args[0]->v.str, position));
        return scr_dyn_new_num(scr_str_last_index_of_from(s, args[0]->v.str, position));
      }
      dyn_throw_unsupported("String", method);
      return NULL;
    }
    dyn_throw_not_fn(what);
    return NULL;
  }

  if (recv->kind == SCR_DYN_ARR) {
    if (dyn_name_is(method, "keys") || dyn_name_is(method, "values") || dyn_name_is(method, "entries"))
      return scr_dyn_native_handle_iterator(callback_recv ? callback_recv : recv,
        dyn_name_is(method, "keys") ? 1 : dyn_name_is(method, "entries") ? 2 : 0);
    size_t len = recv->v.arr.len;
    if (recv->v.arr.presence) {
      bool sparse = false;
      for (size_t i = 0; i < len; i++) if (!recv->v.arr.presence[i]) { sparse = true; break; }
      if (!sparse) { free(recv->v.arr.presence); recv->v.arr.presence = NULL; }
      else if (dyn_name_is(method, "forEach") || dyn_name_is(method, "map") || dyn_name_is(method, "filter") ||
          dyn_name_is(method, "some") || dyn_name_is(method, "every") || dyn_name_is(method, "find") ||
          dyn_name_is(method, "findIndex") || dyn_name_is(method, "findLast") || dyn_name_is(method, "findLastIndex") ||
          dyn_name_is(method, "reduce") || dyn_name_is(method, "reduceRight") || dyn_name_is(method, "slice") ||
          dyn_name_is(method, "indexOf") || dyn_name_is(method, "lastIndexOf") || dyn_name_is(method, "includes")) {
        ScrDyn *pack = scr_dyn_new_arr();
        for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(pack, scr_dyn_retain(args[i]));
        ScrStr *name = scr_str_new(method, strlen(method));
        ScrDyn *result = scr_dyn_array_proto_call(callback_recv ? callback_recv : recv, name, pack);
        scr_str_release(name);
        scr_dyn_release(pack);
        return result;
      } else if (dyn_arr_proto_mutates(method) && !dyn_name_is(method, "fill") && !dyn_name_is(method, "push") && !dyn_name_is(method, "pop") && !dyn_name_is(method, "shift")) {
        static const char message[] = "This checked array mutation over holes is not supported yet";
        scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
        return NULL;
      }
    }
    size_t splice_start = 0;
    size_t splice_removed = 0;
    if (dyn_arr_proto_mutates(method)) {
      bool grows = dyn_name_is(method, "push") && argc > 0;
      grows = grows || (dyn_name_is(method, "unshift") && argc > 0);
      bool shrinks = (dyn_name_is(method, "pop") || dyn_name_is(method, "shift")) && len > 0;
      if (dyn_name_is(method, "splice")) {
        double startD = dyn_index_arg(args, argc, 0, 0, what);
        if (scr_exc_pending()) return NULL;
        splice_start = dyn_rel_index(startD, len);
        splice_removed = len - splice_start;
        if (argc > 1) {
          double countD = dyn_index_arg(args, argc, 1, 0, what);
          if (scr_exc_pending()) return NULL;
          splice_removed = countD <= 0 ? 0 : countD >= (double)splice_removed ? splice_removed : (size_t)countD;
        }
        if (recv->v.arr.len != len) {
          static const char message[] = "Array.prototype.splice after an argument changes the receiver length is not supported yet";
          scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
          return NULL;
        }
        size_t inserted = argc > 2 ? argc - 2 : 0;
        if (inserted > splice_removed && inserted - splice_removed > 1000000) {
          static const char message[] = "Array.prototype.splice exceeds the native array growth limit";
          scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
          return NULL;
        }
        grows = grows || inserted > splice_removed;
        shrinks = shrinks || splice_removed > inserted;
        if (splice_removed > inserted && recv->v.arr.sealed && !recv->v.arr.frozen) {
          for (size_t i = splice_start; i < len - splice_removed + inserted; i++) {
            size_t source = i < splice_start + inserted ? i : i + splice_removed - inserted;
            ScrDyn *replacement = i < splice_start + inserted ? args[i - splice_start + 2] : recv->v.arr.items[source];
            ScrDyn *old = recv->v.arr.items[i];
            recv->v.arr.items[i] = scr_dyn_retain(replacement);
            scr_dyn_release(old);
          }
          static const char message[] = "Cannot delete non-configurable property";
          scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
          return NULL;
        }
      }
      if (recv->v.arr.frozen && (dyn_name_is(method, "push") ||
          dyn_name_is(method, "pop") || dyn_name_is(method, "shift") ||
          dyn_name_is(method, "unshift") || dyn_name_is(method, "splice"))) {
        static const char message[] = "Cannot assign to read only property 'length'";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return NULL;
      }
      if ((grows && recv->non_extensible) || (shrinks && recv->v.arr.sealed && !dyn_name_is(method, "shift")) ||
          (recv->v.arr.frozen && ((dyn_name_is(method, "sort") && len > 1) ||
            (dyn_name_is(method, "reverse") && len > 1)))) {
        static const char message[] = "Cannot modify a sealed or frozen array";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return NULL;
      }
    }
    if (dyn_name_is(method, "push")) {
      for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(recv, scr_dyn_retain(args[i]));
      return scr_dyn_new_num((double)recv->v.arr.len);
    }
    if (dyn_name_is(method, "pop")) {
      if (len == 0) return scr_dyn_retain(scr_dyn_undefined());
      ScrDyn *result = scr_dyn_arr_at(recv, (double)(len - 1));
      if (!result) return NULL;
      scr_dyn_release(recv->v.arr.items[--recv->v.arr.len]);
      return result;
    }
    if (dyn_name_is(method, "shift")) {
      if (len == 0) return scr_dyn_retain(scr_dyn_undefined());
      if (recv->v.arr.sealed) {
        if (recv->v.arr.frozen) {
          static const char message[] = "Cannot assign to read only property";
          scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
          return NULL;
        }
        for (size_t i = 1; i < len; i++) {
          scr_dyn_release(recv->v.arr.items[i - 1]);
          recv->v.arr.items[i - 1] = scr_dyn_retain(recv->v.arr.items[i]);
        }
        static const char message[] = "Cannot delete non-configurable property";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return NULL;
      }
      ScrDyn *first = recv->v.arr.items[0];
      memmove(recv->v.arr.items, recv->v.arr.items + 1, (len - 1) * sizeof(ScrDyn *));
      if (recv->v.arr.presence) memmove(recv->v.arr.presence, recv->v.arr.presence + 1, len - 1);
      recv->v.arr.len = len - 1;
      return first; /* ownership moves out */
    }
    if (dyn_name_is(method, "unshift")) {
      /* Grow the backing store before shifting the old elements. The
       * appended placeholders are immortal, so overwriting them does not
       * abandon retained argument references. */
      for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(recv, scr_dyn_retain(scr_dyn_undefined()));
      memmove(recv->v.arr.items + argc, recv->v.arr.items, len * sizeof(ScrDyn *));
      for (size_t i = 0; i < argc; i++) recv->v.arr.items[i] = scr_dyn_retain(args[i]);
      return scr_dyn_new_num((double)recv->v.arr.len);
    }
    if (dyn_name_is(method, "splice")) {
      size_t start = splice_start;
      size_t removed = splice_removed;
      size_t inserted = argc > 2 ? argc - 2 : 0;
      ScrDyn *out = scr_dyn_new_arr();
      for (size_t i = start; i < start + removed; i++)
        scr_dyn_arr_push(out, scr_dyn_retain(recv->v.arr.items[i]));
      size_t next_len = len - removed + inserted;
      if (next_len > recv->v.arr.cap) {
        size_t capacity = recv->v.arr.cap ? recv->v.arr.cap : 4;
        while (capacity < next_len) {
          if (capacity > SIZE_MAX / 2) scr_trap("scriptc: array capacity overflow\n");
          capacity *= 2;
        }
        ScrDyn **items = scr_mem_realloc(recv->v.arr.items, capacity * sizeof *items);
        if (!items) scr_trap("scriptc: out of memory\n");
        recv->v.arr.items = items;
        recv->v.arr.cap = capacity;
      }
      for (size_t i = start; i < start + removed; i++) scr_dyn_release(recv->v.arr.items[i]);
      memmove(recv->v.arr.items + start + inserted,
              recv->v.arr.items + start + removed,
              (len - start - removed) * sizeof(ScrDyn *));
      for (size_t i = 0; i < inserted; i++)
        recv->v.arr.items[start + i] = scr_dyn_retain(args[i + 2]);
      recv->v.arr.len = next_len;
      return out;
    }
    if (dyn_name_is(method, "slice")) {
      double startD = dyn_index_arg(args, argc, 0, 0, what);
      if (scr_exc_pending()) return NULL;
      double endD = dyn_index_arg(args, argc, 1, (double)len, what);
      if (scr_exc_pending()) return NULL;
      if (!dyn_arr_length_unchanged(recv, len)) return NULL;
      size_t start = dyn_rel_index(startD, len);
      size_t end = dyn_rel_index(endD, len);
      ScrDyn *out = scr_dyn_new_arr();
      for (size_t i = start; i < end; i++) scr_dyn_arr_push(out, scr_dyn_retain(recv->v.arr.items[i]));
      return out;
    }
    if (dyn_name_is(method, "at")) {
      double iD = dyn_index_arg(args, argc, 0, 0, what);
      if (scr_exc_pending()) return NULL;
      if (!dyn_arr_length_unchanged(recv, len)) return NULL;
      double idx = iD < 0 ? (double)len + iD : iD;
      if (idx < 0 || idx >= (double)len) return scr_dyn_retain(scr_dyn_undefined());
      return scr_dyn_arr_at(recv, idx);
    }
    if (dyn_name_is(method, "indexOf") || dyn_name_is(method, "lastIndexOf") ||
        dyn_name_is(method, "includes")) {
      if (len == 0) return dyn_name_is(method, "includes") ? scr_dyn_new_bool(false) : scr_dyn_new_num(-1);
      ScrDyn *needle = argc > 0 ? args[0] : scr_dyn_undefined();
      double from = dyn_name_is(method, "lastIndexOf") ? (double)len - 1 : 0;
      if (argc > 1) {
        from = dyn_index_arg(args, argc, 1, 0, what);
        if (scr_exc_pending()) return NULL;
      }
      if (!dyn_arr_length_unchanged(recv, len)) return NULL;
      if (dyn_name_is(method, "lastIndexOf")) {
        double first = from < 0 ? (double)len + from : from;
        if (first >= (double)len) first = (double)len - 1;
        for (size_t i = first < 0 ? 0 : (size_t)first + 1; i > 0; i--) {
          if (scr_dyn_strict_eq(recv->v.arr.items[i - 1], needle)) return scr_dyn_new_num((double)(i - 1));
        }
        return scr_dyn_new_num(-1);
      }
      double first = from < 0 ? (double)len + from : from;
      if (first < 0) first = 0;
      for (size_t i = first >= (double)len ? len : (size_t)first; i < len; i++) {
        const ScrDyn *item = recv->v.arr.items[i];
        bool nan_match = dyn_name_is(method, "includes") &&
          item->kind == SCR_DYN_NUM && needle->kind == SCR_DYN_NUM &&
          item->v.num != item->v.num && needle->v.num != needle->v.num;
        if (nan_match || scr_dyn_strict_eq(item, needle)) {
          return dyn_name_is(method, "includes") ? scr_dyn_new_bool(true) : scr_dyn_new_num((double)i);
        }
      }
      return dyn_name_is(method, "includes") ? scr_dyn_new_bool(false) : scr_dyn_new_num(-1);
    }
    if (dyn_name_is(method, "findLast") || dyn_name_is(method, "findLastIndex")) {
      if (!dyn_cb_check(args, argc)) return NULL;
      ScrDyn *visible_recv = callback_recv ? callback_recv : recv;
      for (size_t i = len; i > 0; i--) {
        size_t index = i - 1;
        ScrDyn *item = index < recv->v.arr.len
          ? scr_dyn_retain(recv->v.arr.items[index])
          : scr_dyn_retain(scr_dyn_undefined());
        ScrDyn *result = dyn_call_cb(args[0], item, index, visible_recv);
        if (!result) { scr_dyn_release(item); return NULL; }
        bool matched = scr_dyn_truthy(result);
        scr_dyn_release(result);
        if (matched) {
          if (dyn_name_is(method, "findLast")) return item;
          scr_dyn_release(item);
          return scr_dyn_new_num((double)index);
        }
        scr_dyn_release(item);
      }
      return dyn_name_is(method, "findLast")
        ? scr_dyn_retain(scr_dyn_undefined()) : scr_dyn_new_num(-1);
    }
    if (dyn_name_is(method, "join")) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      ScrStr *separator = argc > 0 && args[0]->kind != SCR_DYN_UNDEF
        ? scr_dyn_string_coerce_js(args[0]) : scr_str_new(",", 1);
      if (!separator) { free(b.data); return NULL; }
      for (size_t i = 0; i < len; i++) {
        if (i > 0) for (size_t j = 0; j < separator->len; j++) scr_jb_putc(&b, separator->data[j]);
        ScrDyn *e = scr_dyn_arr_at(recv, (double)i);
        if (e) {
          if (e->kind != SCR_DYN_UNDEF && e->kind != SCR_DYN_NULL) scr_dyn_display_buf(&b, e);
          scr_dyn_release(e);
        }
        if (!e || scr_exc_pending()) { scr_str_release(separator); free(b.data); return NULL; }
      }
      scr_str_release(separator);
      ScrStr *joined = scr_jb_finish(&b);
      ScrDyn *r = scr_dyn_new_str(joined); /* retains */
      scr_str_release(joined);
      return r;
    }
    if (dyn_name_is(method, "concat")) {
      ScrDyn *out = scr_dyn_new_arr();
      for (size_t i = 0; i < len; i++) {
        if (!dyn_arr_copy_item(out, recv, i, true)) { scr_dyn_release(out); return NULL; }
      }
      for (size_t a = 0; a < argc; a++) {
        ScrDyn *view = args[a]->kind == SCR_DYN_TYPED_REF && scr_dyn_isl_is_array(args[a])
            ? scr_dyn_typed_ref_materialize(args[a]) : NULL;
        if (scr_exc_pending()) { scr_dyn_release(view); scr_dyn_release(out); return NULL; }
        const ScrDyn *source = view ? view : args[a];
        if (source->kind == SCR_DYN_ARR) {
          for (size_t i = 0; i < source->v.arr.len; i++) {
            if (!dyn_arr_copy_item(out, source, i, true)) { scr_dyn_release(view); scr_dyn_release(out); return NULL; }
          }
        } else {
          scr_dyn_arr_push(out, scr_dyn_retain(args[a]));
        }
        scr_dyn_release(view);
      }
      return out;
    }
    if (dyn_name_is(method, "flat")) {
      double depth = dyn_index_arg(args, argc, 0, 1, what);
      if (scr_exc_pending()) return NULL;
      if (!dyn_arr_length_unchanged(recv, len)) return NULL;
      ScrDyn *out = scr_dyn_new_arr();
      size_t visits = 0;
      if (!dyn_arr_flatten(out, recv, depth < 0 ? 0 : depth, &visits)) {
        scr_dyn_release(out);
        return NULL;
      }
      return out;
    }
    if (dyn_name_is(method, "reverse")) {
      for (size_t i = 0; i < len / 2; i++) {
        ScrDyn *tmp = recv->v.arr.items[i];
        recv->v.arr.items[i] = recv->v.arr.items[len - 1 - i];
        recv->v.arr.items[len - 1 - i] = tmp;
      }
      return scr_dyn_retain(recv);
    }
    if (dyn_name_is(method, "toReversed")) {
      ScrDyn *out = scr_dyn_new_arr();
      if (!dyn_arr_reversed_copy(out, recv)) { scr_dyn_release(out); return NULL; }
      return out;
    }
    if (dyn_name_is(method, "with")) {
      double indexD = dyn_index_arg(args, argc, 0, 0, what);
      if (scr_exc_pending()) return NULL;
      if (!dyn_arr_length_unchanged(recv, len)) return NULL;
      double index = indexD < 0 ? (double)len + indexD : indexD;
      if (index < 0 || index >= (double)len) {
        static const char message[] = "Invalid index";
        scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
        return NULL;
      }
      ScrDyn *replacement = argc > 1 ? args[1] : scr_dyn_undefined();
      ScrDyn *out = scr_dyn_new_arr();
      for (size_t i = 0; i < len; i++) {
        if ((size_t)index == i) scr_dyn_arr_push(out, scr_dyn_retain(replacement));
        else if (!dyn_arr_copy_item(out, recv, i, false)) { scr_dyn_release(out); return NULL; }
      }
      return out;
    }
    if (dyn_name_is(method, "toSpliced")) {
      double startD = dyn_index_arg(args, argc, 0, 0, what);
      if (scr_exc_pending()) return NULL;
      size_t start = dyn_rel_index(startD, len);
      size_t delete_count = argc == 0 ? 0 : len - start;
      if (argc > 1) {
        double countD = dyn_index_arg(args, argc, 1, 0, what);
        if (scr_exc_pending()) return NULL;
        delete_count = countD <= 0 ? 0 : countD >= (double)delete_count ? delete_count : (size_t)countD;
      }
      if (!dyn_arr_length_unchanged(recv, len)) return NULL;
      ScrDyn *out = scr_dyn_new_arr();
      for (size_t i = 0; i < start; i++) if (!dyn_arr_copy_item(out, recv, i, false)) { scr_dyn_release(out); return NULL; }
      for (size_t i = 2; i < argc; i++) scr_dyn_arr_push(out, scr_dyn_retain(args[i]));
      for (size_t i = start + delete_count; i < len; i++) if (!dyn_arr_copy_item(out, recv, i, false)) { scr_dyn_release(out); return NULL; }
      return out;
    }
    if (dyn_name_is(method, "fill")) {
      double startD = dyn_index_arg(args, argc, 1, 0, what);
      if (scr_exc_pending()) return NULL;
      double endD = dyn_index_arg(args, argc, 2, (double)len, what);
      if (scr_exc_pending()) return NULL;
      if (!dyn_arr_length_unchanged(recv, len)) return NULL;
      size_t start = dyn_rel_index(startD, len);
      size_t end = dyn_rel_index(endD, len);
      if (recv->v.arr.frozen && start < end) {
        static const char message[] = "Cannot assign to read only array index";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return NULL;
      }
      ScrDyn *fill = argc ? args[0] : scr_dyn_undefined();
      for (size_t i = start; i < end; i++) {
        if (recv->non_extensible && !scr_dyn_arr_has_index(recv, i)) {
          static const char message[] = "Cannot add property, object is not extensible";
          scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
          return NULL;
        }
        ScrDyn *old = recv->v.arr.items[i];
        recv->v.arr.items[i] = scr_dyn_retain(fill);
        if (recv->v.arr.presence) recv->v.arr.presence[i] = 1;
        scr_dyn_release(old);
      }
      return scr_dyn_retain(recv);
    }
    if (dyn_name_is(method, "copyWithin")) {
      double targetD = dyn_index_arg(args, argc, 0, 0, what);
      if (scr_exc_pending()) return NULL;
      double startD = dyn_index_arg(args, argc, 1, 0, what);
      if (scr_exc_pending()) return NULL;
      double endD = dyn_index_arg(args, argc, 2, (double)len, what);
      if (scr_exc_pending()) return NULL;
      if (!dyn_arr_length_unchanged(recv, len)) return NULL;
      size_t target = dyn_rel_index(targetD, len);
      size_t start = dyn_rel_index(startD, len);
      size_t end = dyn_rel_index(endD, len);
      size_t count = end > start ? end - start : 0;
      if (count > len - target) count = len - target;
      if (recv->v.arr.frozen && count > 0) {
        static const char message[] = "Cannot assign to read only array index";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return NULL;
      }
      if (start < target && target < start + count) {
        for (size_t i = count; i > 0; i--) {
          ScrDyn *old = recv->v.arr.items[target + i - 1];
          recv->v.arr.items[target + i - 1] = scr_dyn_retain(recv->v.arr.items[start + i - 1]);
          scr_dyn_release(old);
        }
      } else {
        for (size_t i = 0; i < count; i++) {
          ScrDyn *old = recv->v.arr.items[target + i];
          recv->v.arr.items[target + i] = scr_dyn_retain(recv->v.arr.items[start + i]);
          scr_dyn_release(old);
        }
      }
      return scr_dyn_retain(recv);
    }
    if (dyn_name_is(method, "forEach") || dyn_name_is(method, "map") ||
        dyn_name_is(method, "filter") || dyn_name_is(method, "some") ||
        dyn_name_is(method, "every") || dyn_name_is(method, "find") ||
        dyn_name_is(method, "findIndex")) {
      if (!dyn_cb_check(args, argc)) return NULL;
      ScrDyn *cb = args[0];
      ScrDyn *out = (dyn_name_is(method, "map") || dyn_name_is(method, "filter")) ? scr_dyn_new_arr() : NULL;
      /* Array iteration methods snapshot length before the first callback.
       * A shrinking callback can remove a later dense entry; an expanding
       * callback must not make the new tail observable to this pass. Live
       * Web-boundary capsules are the externally visible receiver, so pass
       * that capsule as callback arg 3: mutations through the callback's
       * array argument then commit directly to the original static array. */
      size_t n = len;
      ScrDyn *visible_recv = callback_recv ? callback_recv : recv;
      for (size_t step = 0; step < n; step++) {
        size_t i = step;
        if (i >= recv->v.arr.len) continue;
        ScrDyn *item = scr_dyn_retain(recv->v.arr.items[i]);
        ScrDyn *r = dyn_call_cb(cb, item, i, visible_recv);
        if (!r) { scr_dyn_release(item); scr_dyn_release(out); return NULL; }
        if (dyn_name_is(method, "map")) {
          scr_dyn_arr_push(out, r); /* ownership moves in */
          r = NULL;
        } else {
          bool truthy = scr_dyn_truthy(r);
          scr_dyn_release(r);
          if (dyn_name_is(method, "filter") && truthy) scr_dyn_arr_push(out, scr_dyn_retain(item));
          if (dyn_name_is(method, "some") && truthy) { scr_dyn_release(item); return scr_dyn_new_bool(true); }
          if (dyn_name_is(method, "every") && !truthy) { scr_dyn_release(item); return scr_dyn_new_bool(false); }
          if (dyn_name_is(method, "find") && truthy) return item; /* +1 moves out */
          if (dyn_name_is(method, "findIndex") && truthy) { scr_dyn_release(item); return scr_dyn_new_num((double)i); }
        }
        scr_dyn_release(item);
      }
      if (out) return out;
      if (dyn_name_is(method, "some")) return scr_dyn_new_bool(false);
      if (dyn_name_is(method, "every")) return scr_dyn_new_bool(true);
      if (dyn_name_is(method, "find")) return scr_dyn_retain(scr_dyn_undefined());
      if (dyn_name_is(method, "findIndex")) return scr_dyn_new_num(-1);
      return scr_dyn_retain(scr_dyn_undefined()); /* forEach */
    }
    if (dyn_name_is(method, "reduce") || dyn_name_is(method, "reduceRight")) {
      if (!dyn_cb_check(args, argc)) return NULL;
      bool backward = dyn_name_is(method, "reduceRight");
      ScrDyn *acc = argc > 1 ? scr_dyn_retain(args[1]) : NULL;
      ScrDyn *visible_recv = callback_recv ? callback_recv : recv;
      for (size_t step = 0; step < len; step++) {
        size_t i = backward ? len - 1 - step : step;
        if (i >= recv->v.arr.len) continue;
        ScrDyn *item = scr_dyn_retain(recv->v.arr.items[i]);
        if (!acc) { acc = item; continue; }
        ScrDyn *index = scr_dyn_new_num((double)i);
        ScrDyn *call_args[] = { acc, item, index, visible_recv };
        ScrDyn *next = scr_dyn_call(args[0], call_args, 4, "callback");
        scr_dyn_release(index);
        scr_dyn_release(item);
        scr_dyn_release(acc);
        if (!next) return NULL;
        acc = next;
      }
      if (acc) return acc;
      static const char message[] = "Reduce of empty array with no initial value";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    if (dyn_name_is(method, "flatMap")) {
      /* JS Array.prototype.flatMap over a dyn array: map + a depth-1
       * flatten. Native dyn-array results flatten element-by-element; a
       * WRAPPED engine array flattens through the routed keyed reads
       * (elements wrap back scalar-normalized); everything else pushes
       * as a single element (JS keeps non-array callback results whole).
       * JS's spec snapshots the length up front (elements appended by
       * the callback are not visited). */
      if (!dyn_cb_check(args, argc)) return NULL;
      ScrDyn *cb = args[0];
      ScrDyn *out = scr_dyn_new_arr();
      size_t n = recv->v.arr.len;
      for (size_t i = 0; i < n && i < recv->v.arr.len; i++) {
        if (!dyn_borrow_present(recv, i)) { if (scr_exc_pending()) { scr_dyn_release(out); return NULL; } continue; }
        ScrDyn *item = dyn_borrow_item(recv, i);
        if (!item) { scr_dyn_release(out); return NULL; }
        ScrDyn *r = dyn_call_cb(
            cb, item, i, callback_recv ? callback_recv : recv);
        scr_dyn_release(item);
        if (!r) { scr_dyn_release(out); return NULL; }
        if (r->kind == SCR_DYN_TYPED_REF && scr_dyn_isl_is_array(r)) {
          ScrDyn *view = scr_dyn_typed_ref_materialize(r);
          scr_dyn_release(r);
          r = view;
          if (!r) { scr_dyn_release(out); return NULL; }
        }
        if (r->kind == SCR_DYN_ARR) {
          for (size_t j = 0; j < r->v.arr.len; j++) {
            if (dyn_borrow_present(r, j)) scr_dyn_arr_push(out, dyn_borrow_item(r, j));
            if (scr_exc_pending()) { scr_dyn_release(r); scr_dyn_release(out); return NULL; }
          }
          scr_dyn_release(r);
        } else if (scr_dyn_isl_is_array(r)) {
          /* An engine-array result: length + element reads through the
           * routed engine ops (a bridged surprise unwinds). */
          ScrStr *lk = scr_str_new("length", 6);
          ScrDyn *lenv = scr_dyn_isl_key_get(r, lk);
          scr_str_release(lk);
          if (!lenv) { scr_dyn_release(r); scr_dyn_release(out); return NULL; }
          size_t rn = lenv->kind == SCR_DYN_NUM ? (size_t)lenv->v.num : 0;
          scr_dyn_release(lenv);
          for (size_t j = 0; j < rn; j++) {
            char idx[24];
            int ilen = snprintf(idx, sizeof idx, "%zu", j);
            ScrStr *jk = scr_str_new(idx, (size_t)ilen);
            ScrDyn *el = scr_dyn_isl_key_get(r, jk);
            scr_str_release(jk);
            if (!el) { scr_dyn_release(r); scr_dyn_release(out); return NULL; }
            scr_dyn_arr_push(out, el); /* ownership moves in */
          }
          scr_dyn_release(r);
        } else {
          scr_dyn_arr_push(out, r); /* ownership moves in */
        }
      }
      return out;
    }
    if (dyn_name_is(method, "sort")) {
      ScrDyn *cmp = argc > 0 ? args[0] : scr_dyn_undefined();
      if (cmp->kind != SCR_DYN_UNDEF && cmp->kind != SCR_DYN_FUNC) {
        /* V8 appends the received value's string image. */
        ScrJsonBuf b;
        scr_jb_init(&b);
        scr_jb_puts(&b, "The comparison function must be either a function or undefined: ");
        scr_dyn_display_buf(&b, cmp);
        scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
        return NULL;
      }
      if (len > 1 && !dyn_arr_sort(recv, cmp->kind == SCR_DYN_FUNC ? cmp : NULL)) return NULL;
      return scr_dyn_retain(recv);
    }
    if (dyn_name_is(method, "toSorted")) {
      ScrDyn *cmp = argc > 0 ? args[0] : scr_dyn_undefined();
      if (cmp->kind != SCR_DYN_UNDEF && cmp->kind != SCR_DYN_FUNC) {
        static const char message[] = "The comparison function must be either a function or undefined";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return NULL;
      }
      ScrDyn *out = scr_dyn_new_arr();
      for (size_t i = 0; i < len; i++) if (!dyn_arr_copy_item(out, recv, i, false)) { scr_dyn_release(out); return NULL; }
      if (len > 1 && !dyn_arr_sort(out, cmp->kind == SCR_DYN_FUNC ? cmp : NULL)) {
        scr_dyn_release(out);
        return NULL;
      }
      return out;
    }
    if (dyn_arr_proto_unimpl(method)) {
      dyn_throw_unsupported("Array", method);
      return NULL;
    }
    dyn_throw_not_fn(what);
    return NULL;
  }

  /* PROMISE receivers: the then/catch/finally reactions ride the fiber
   * machinery (scr_dyn_promise_then — microtask-exact ordering); every
   * other Promise.prototype name is `then`-adjacent sugar JS doesn't
   * have, so the not-a-function answer IS the JS answer. */
  if (recv->kind == SCR_DYN_PROMISE) {
#ifdef SCR_LIB
    scr_trap("scriptc: promise dispatch is unavailable in library mode\n");
#else
    if (dyn_name_is(method, "then")) {
      return scr_dyn_promise_then(recv->v.promise, argc >= 1 ? args[0] : NULL,
                                  argc >= 2 ? args[1] : NULL, NULL);
    }
    if (dyn_name_is(method, "catch")) {
      return scr_dyn_promise_then(recv->v.promise, NULL, argc >= 1 ? args[0] : NULL, NULL);
    }
    if (dyn_name_is(method, "finally")) {
      return scr_dyn_promise_then(recv->v.promise, NULL, NULL, argc >= 1 ? args[0] : NULL);
    }
    dyn_throw_not_fn(what);
    return NULL;
#endif
  }

  if (recv->kind == SCR_DYN_BYTES) {
    ScrBytes *bytes = recv->v.bytes;
    if (bytes->is_data_view) {
      static const char *const kinds[] = { "Uint8", "Int8", "Uint16", "Int16", "Uint32", "Int32", "Float32", "Float64", "BigUint64", "BigInt64" };
      const bool get = !strncmp(method, "get", 3);
      const bool set = !strncmp(method, "set", 3);
      for (size_t kind = 0; (get || set) && kind < sizeof kinds / sizeof kinds[0]; kind++) {
        if (strcmp(method + 3, kinds[kind])) continue;
        double offset = 0;
        if (argc && !scr_dyn_number_coerce_js(args[0], &offset)) return NULL;
        /* ToIndex precedes value coercion; the view bounds check follows
         * it. Keep these stages distinct for observable valueOf calls. */
        offset = isnan(offset) ? 0 : trunc(offset);
        if (!(offset >= 0) || offset > 9007199254740991.0) {
          static const char message[] = "Offset is outside the bounds of the DataView";
          scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
          return NULL;
        }
        const bool le = argc > (get ? 1 : 2) && scr_dyn_truthy(args[get ? 1 : 2]);
        if (get) {
          if (kind >= SCR_DV_BIGU64) {
            ScrBigInt *value = scr_bigint_dataview_get(bytes, offset, kind == SCR_DV_BIGI64, le);
            if (scr_exc_pending()) return NULL;
            ScrDyn *result = scr_dyn_new_bigint(value);
            scr_bigint_release(value);
            return result;
          }
          double value = scr_dataview_get(bytes, offset, (ScrDataViewGet)kind, le);
          return scr_exc_pending() ? NULL : scr_dyn_new_num(value);
        }
        if (kind >= SCR_DV_BIGU64) {
          ScrBigInt *value = scr_dyn_bigint_coerce(argc > 1 ? args[1] : scr_dyn_undefined());
          if (scr_exc_pending()) return NULL;
          scr_bigint_dataview_set(bytes, offset, value, le);
          scr_bigint_release(value);
        } else {
          double value;
          if (!scr_dyn_number_coerce_js(argc > 1 ? args[1] : scr_dyn_undefined(), &value)) return NULL;
          scr_dataview_set(bytes, offset, value, (ScrDataViewGet)kind, le);
        }
        return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
      }
    }
    size_t blen = bytes->len;
    if (dyn_name_is(method, "at")) {
      double iD = dyn_bytes_index_arg(args, argc, 0, 0);
      if (scr_exc_pending()) return NULL;
      double idx = iD < 0 ? (double)blen + iD : iD;
      if (idx < 0 || idx >= (double)blen) return scr_dyn_retain(scr_dyn_undefined());
      return scr_dyn_new_num(scr_bytes_get(bytes, idx));
    }
    if (dyn_name_is(method, "slice") || dyn_name_is(method, "subarray")) {
      /* subarray and Buffer.slice alias their source. TypedArray.slice
       * owns an independent copy; all keep the receiver's Buffer flavor. */
      double startD = dyn_bytes_index_arg(args, argc, 0, 0);
      if (scr_exc_pending()) return NULL;
      double endD = dyn_bytes_index_arg(args, argc, 1, (double)blen);
      if (scr_exc_pending()) return NULL;
      ScrBytes *out = recv->buffer || dyn_name_is(method, "subarray")
        ? scr_bytes_subarray(bytes, startD, endD) : scr_bytes_slice(bytes, startD, endD);
      ScrDyn *d = recv->buffer ? scr_dyn_new_buffer(out) : scr_dyn_new_bytes(out);
      scr_bytes_release(out);
      return d;
    }
    if (dyn_name_is(method, "set")) {
      double offset = dyn_bytes_index_arg(args, argc, 1, 0);
      if (scr_exc_pending()) return NULL;
      scr_bytes_set_from_dyn(bytes, argc ? args[0] : scr_dyn_undefined(), offset);
      return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
    }
    if (dyn_name_is(method, "copyWithin")) {
      double target = dyn_bytes_index_arg(args, argc, 0, 0);
      if (scr_exc_pending()) return NULL;
      double start = dyn_bytes_index_arg(args, argc, 1, 0);
      if (scr_exc_pending()) return NULL;
      double end = dyn_bytes_index_arg(args, argc, 2, (double)blen);
      if (scr_exc_pending()) return NULL;
      scr_bytes_release(scr_bytes_copy_within(bytes, target, start, end));
      return scr_dyn_retain(recv);
    }
    if (dyn_name_is(method, "fill") && !recv->buffer) {
      double value;
      if (!scr_dyn_number_coerce_js(argc ? args[0] : scr_dyn_undefined(), &value)) return NULL;
      double start = dyn_bytes_index_arg(args, argc, 1, 0);
      if (scr_exc_pending()) return NULL;
      double end = dyn_bytes_index_arg(args, argc, 2, (double)blen);
      if (scr_exc_pending()) return NULL;
      scr_bytes_release(scr_bytes_fill_elem(bytes, value, start, end));
      return scr_dyn_retain(recv);
    }
    if (dyn_name_is(method, "join") || (dyn_name_is(method, "toString") && !recv->buffer)) {
      ScrStr *separator = dyn_name_is(method, "join") && argc && args[0]->kind != SCR_DYN_UNDEF
        ? scr_dyn_string_coerce_js(args[0]) : scr_str_new(",", 1);
      if (scr_exc_pending()) { scr_str_release(separator); return NULL; }
      ScrStr *joined = scr_bytes_join(bytes, separator);
      scr_str_release(separator);
      ScrDyn *out = scr_dyn_new_str(joined);
      scr_str_release(joined);
      return out;
    }
    if (dyn_bytes_proto_real(method)) {
      dyn_throw_unsupported(scr_bytes_elem_name(bytes->elem), method);
      return NULL;
    }
  }

  /* NUM/BOOL/BYTES-remainder: the name is no method of this kind — JS's
   * own answer. */
  dyn_throw_not_fn(what);
  return NULL;
}

static ScrDyn *dyn_array_method_value_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStr *method = scr_box_get_ref(closure->caps[0]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result;
  if (receiver->kind == SCR_DYN_ARR) {
    result = scr_dyn_invoke(receiver, method->data, args, argc, method->data);
  } else {
    ScrDyn *pack = scr_dyn_new_arr();
    for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(pack, scr_dyn_retain(args[i]));
    result = scr_dyn_array_proto_call(receiver, method, pack);
    scr_dyn_release(pack);
  }
  scr_dyn_release(receiver);
  scr_str_release(method);
  return result;
}

static SCR_TL ScrDyn *dyn_builtin_methods;

static void dyn_builtin_methods_cleanup(void) {
  scr_dyn_release(dyn_builtin_methods);
  dyn_builtin_methods = NULL;
}

static ScrDyn *dyn_builtin_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStr *prototype = scr_box_get_ref(closure->caps[0]);
  ScrStr *method = scr_box_get_ref(closure->caps[1]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (!strcmp(prototype->data, "Object")) {
    ScrDyn *key = argc ? args[0] : scr_dyn_undefined();
    if (!strcmp(method->data, "toString")) {
      ScrStr *tag = scr_dyn_object_tag(receiver);
      if (tag) { result = scr_dyn_new_str(tag); scr_str_release(tag); }
    } else if (!strcmp(method->data, "hasOwnProperty")) {
      bool own = scr_dyn_has_own_computed(receiver, key);
      if (!scr_exc_pending()) result = scr_dyn_new_bool(own);
    } else if (!strcmp(method->data, "propertyIsEnumerable")) {
      bool enumerable = scr_dyn_property_is_enumerable_computed(receiver, key);
      if (!scr_exc_pending()) result = scr_dyn_new_bool(enumerable);
    } else if (receiver->kind == SCR_DYN_NULL || receiver->kind == SCR_DYN_UNDEF) {
      static const char message[] = "Cannot convert undefined or null to object";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    } else if (receiver->kind == SCR_DYN_OBJ || receiver->kind == SCR_DYN_ARR ||
        receiver->kind == SCR_DYN_FUNC || receiver->kind == SCR_DYN_HANDLE ||
        receiver->kind == SCR_DYN_TYPED_REF || receiver->kind == SCR_DYN_PROXY) result = scr_dyn_retain(receiver);
    else dyn_throw_unsupported("Object", method->data);
  } else {
    bool compatible = false;
    if (!strcmp(prototype->data, "String")) compatible = receiver->kind != SCR_DYN_UNDEF && receiver->kind != SCR_DYN_NULL;
    else if (!strcmp(prototype->data, "Number")) compatible = receiver->kind == SCR_DYN_NUM;
    else if (receiver->kind == SCR_DYN_HANDLE) {
      const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(receiver);
      compatible = !strcmp(ops->cls, prototype->data);
    }
    if (!compatible) {
      static const char message[] = "Builtin prototype method called on incompatible receiver";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    } else if (!strcmp(method->data, "toString") && receiver->kind == SCR_DYN_NUM) {
      ScrStr *value = scr_dyn_to_string_argument(receiver, argc ? args[0] : scr_dyn_undefined(), method);
      if (value) { result = scr_dyn_new_str(value); scr_str_release(value); }
    } else if (!strcmp(prototype->data, "String")) {
      bool strict = !strcmp(method->data, "toString") || !strcmp(method->data, "valueOf");
      if (strict && receiver->kind != SCR_DYN_STR) {
        static const char message[] = "String.prototype method requires a string receiver";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      } else if (strict) result = scr_dyn_retain(receiver);
      else {
        ScrStr *text = scr_dyn_string_coerce_js(receiver);
        if (text) {
          ScrDyn *string = scr_dyn_new_str(text);
          scr_str_release(text);
          if (!strcmp(method->data, "slice")) result = scr_dyn_invoke(string, method->data, args, argc, method->data);
          else dyn_throw_unsupported("String", method->data);
          scr_dyn_release(string);
        }
      }
    } else result = scr_dyn_invoke(receiver, method->data, args, argc, method->data);
  }
  scr_dyn_release(receiver);
  scr_str_release(prototype);
  scr_str_release(method);
  return result;
}

ScrDyn *scr_dyn_builtin_method(const ScrStr *prototype, const ScrStr *method) {
  if (!dyn_builtin_methods) {
    dyn_builtin_methods = scr_dyn_new_obj_null_proto();
    scr_atexit(dyn_builtin_methods_cleanup);
  }
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  scr_jb_puts(&buffer, prototype->data);
  scr_jb_putc(&buffer, '.');
  scr_jb_puts(&buffer, method->data);
  ScrStr *key = scr_jb_finish(&buffer);
  ScrDyn *value = scr_dyn_obj_get(dyn_builtin_methods, key->data, key->len);
  if (!value) {
    ScrClosure *closure = scr_closure_new(NULL, 2);
    closure->caps[0] = scr_box_new(SCR_BOX_STR);
    closure->caps[1] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(closure->caps[0], scr_str_retain((ScrStr *)prototype));
    scr_box_set_ref(closure->caps[1], scr_str_retain((ScrStr *)method));
    size_t arity = (!strcmp(method->data, "set") || !strcmp(method->data, "substring") ||
      !strcmp(method->data, "slice") ||
      !strcmp(method->data, "replace") || !strcmp(method->data, "split")) ? 2 :
      (!strcmp(method->data, "get") || !strcmp(method->data, "add") || !strcmp(method->data, "has") ||
       !strcmp(method->data, "delete") || !strcmp(method->data, "forEach") || !strcmp(method->data, "startsWith") ||
       !strcmp(method->data, "endsWith") || !strcmp(method->data, "padStart") || !strcmp(method->data, "toJSON") ||
       !strcmp(method->data, "charCodeAt") || !strcmp(method->data, "hasOwnProperty") ||
       !strcmp(method->data, "propertyIsEnumerable") || (!strcmp(prototype->data, "Number") && !strcmp(method->data, "toString"))) ? 1 : 0;
    value = scr_dyn_new_func(closure, dyn_builtin_method_call, arity, "native:prototype", method->data);
    scr_dyn_obj_set(dyn_builtin_methods, key->data, key->len, value);
  }
  scr_str_release(key);
  return scr_dyn_retain(value);
}

ScrDyn *scr_dyn_array_prototype(void) {
  static SCR_TL bool initialized;
  ScrDyn *prototype = scr_dyn_array_prototype_base();
  if (initialized) return prototype;
  initialized = true;
  static const struct { const char *name; size_t arity; } methods[] = {
    {"at", 1}, {"concat", 1}, {"copyWithin", 2}, {"fill", 1}, {"find", 1}, {"findIndex", 1},
    {"findLast", 1}, {"findLastIndex", 1}, {"lastIndexOf", 1}, {"pop", 0}, {"push", 1},
    {"reverse", 0}, {"shift", 0}, {"unshift", 1}, {"slice", 2}, {"sort", 1}, {"splice", 2},
    {"includes", 1}, {"indexOf", 1}, {"join", 1}, {"keys", 0}, {"entries", 0}, {"values", 0},
    {"forEach", 1}, {"filter", 1}, {"flat", 0}, {"flatMap", 1}, {"map", 1}, {"every", 1},
    {"some", 1}, {"reduce", 1}, {"reduceRight", 1}, {"toReversed", 0}, {"toSorted", 1},
    {"toSpliced", 2}, {"with", 2}, {"toLocaleString", 0}, {"toString", 0},
  };
  for (size_t i = 0; i < sizeof methods / sizeof methods[0]; i++) {
    ScrStr *name = scr_str_new(methods[i].name, strlen(methods[i].name));
    ScrDyn *method;
    if (!strcmp(methods[i].name, "values")) method = scr_dyn_array_values_function();
    else {
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_STR);
      scr_box_set_ref(closure->caps[0], scr_str_retain(name));
      method = scr_dyn_new_func(closure, dyn_array_method_value_call, methods[i].arity,
        "native:Array.prototype", methods[i].name);
    }
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "value", 5, method);
    scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    ScrDyn *key = scr_dyn_new_str(name);
    ScrDyn *defined = scr_dyn_define_property(prototype, key, descriptor);
    scr_dyn_release(defined);
    scr_dyn_release(key);
    scr_dyn_release(descriptor);
    scr_str_release(name);
  }
  return prototype;
}

/* Object.defineProperties over dyn values (see scr_runtime.h). */
static ScrDyn *scr_dyn_define_props_internal(ScrDyn *target, ScrDyn *descs, ScrDyn *protected_keys) {
  /* Island-held operands ARE objects to Node — the non-object TypeError
   * below would be a wrong claim. Loud fence (lane dyn-routing-ops). */
  scr_dyn_isl_fence(target, "Object.defineProperties");
  if (!scr_exc_pending()) scr_dyn_isl_fence(descs, "Object.defineProperties");
  if (scr_exc_pending()) return NULL;
  if (target->kind != SCR_DYN_OBJ && target->kind != SCR_DYN_FUNC && target->kind != SCR_DYN_ARR) {
    scr_throw_error_msg(SCR_ERR_TYPE, "Object.defineProperties called on non-object",
                        strlen("Object.defineProperties called on non-object"));
    return NULL;
  }
  if (descs->kind != SCR_DYN_OBJ) {
    scr_throw_error_msg(SCR_ERR_TYPE, "Object.defineProperties called on non-object",
                        strlen("Object.defineProperties called on non-object"));
    return NULL;
  }
  ScrDyn *keys = scr_dyn_obj_own_keys(descs);
  ScrDyn *pending = scr_dyn_new_arr();
  static const char *const names[] = {"enumerable", "configurable", "value", "writable", "get", "set"};
  static const size_t lengths[] = {10, 12, 5, 8, 3, 3};
  for (size_t i = 0; i < keys->v.arr.len; i++) {
    ScrDyn *key = keys->v.arr.items[i];
    ScrStr *name = key->v.str;
    if (!scr_dyn_obj_enumerable(descs, name->data, name->len)) continue;
    ScrDyn *descriptor = scr_dyn_obj_read(descs, name->data, name->len);
    if (!descriptor) goto fail;
    if (descriptor->kind != SCR_DYN_OBJ) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "Property description must be an object: ");
      scr_dyn_display_buf(&b, descriptor);
      scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
      scr_dyn_release(descriptor);
      goto fail;
    }
    ScrDyn *snapshot = scr_dyn_new_obj();
    for (size_t field = 0; field < 6; field++) {
      if (!scr_dyn_obj_get(descriptor, names[field], lengths[field])) continue;
      ScrDyn *value = scr_dyn_obj_read(descriptor, names[field], lengths[field]);
      if (!value) {
        scr_dyn_release(snapshot);
        scr_dyn_release(descriptor);
        goto fail;
      }
      scr_dyn_obj_set(snapshot, names[field], lengths[field], value);
    }
    scr_dyn_release(descriptor);
    ScrDyn *get = scr_dyn_obj_get(snapshot, "get", 3);
    ScrDyn *set = scr_dyn_obj_get(snapshot, "set", 3);
    if ((get || set) && (scr_dyn_obj_get(snapshot, "value", 5) ||
                         scr_dyn_obj_get(snapshot, "writable", 8))) {
      static const char msg[] = "Invalid property descriptor. Cannot both specify accessors and a value or writable attribute";
      scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      scr_dyn_release(snapshot);
      goto fail;
    }
    if ((get && get->kind != SCR_DYN_UNDEF && get->kind != SCR_DYN_FUNC) ||
        (set && set->kind != SCR_DYN_UNDEF && set->kind != SCR_DYN_FUNC)) {
      static const char msg[] = "Getter and setter must be functions";
      scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      scr_dyn_release(snapshot);
      goto fail;
    }
    ScrDyn *pair = scr_dyn_new_arr();
    scr_dyn_arr_push(pair, scr_dyn_retain(key));
    scr_dyn_arr_push(pair, snapshot);
    scr_dyn_arr_push(pending, pair);
  }
  scr_dyn_release(keys);
  for (size_t i = 0; i < pending->v.arr.len; i++) {
    ScrDyn *pair = pending->v.arr.items[i];
    ScrDyn *key = pair->v.arr.items[0];
    ScrDyn *descriptor = pair->v.arr.items[1];
    if (protected_keys) {
      for (size_t k = 0; k < protected_keys->v.arr.len; k++) {
        if (!scr_dyn_strict_eq(key, protected_keys->v.arr.items[k])) continue;
        static const char message[] = "Replacing compiled class prototype members has no native lowering [SC1090]";
        scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
        scr_dyn_release(pending);
        return NULL;
      }
    }
    ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
    if (!defined) {
      scr_dyn_release(pending);
      return NULL;
    }
    scr_dyn_release(defined);
  }
  scr_dyn_release(pending);
  return scr_dyn_retain(target);
fail:
  scr_dyn_release(keys);
  scr_dyn_release(pending);
  return NULL;
}

ScrDyn *scr_dyn_define_props(ScrDyn *target, ScrDyn *descs) {
  return scr_dyn_define_props_internal(target, descs, NULL);
}

ScrDyn *scr_dyn_define_prototype_props(ScrDyn *target, ScrDyn *descs, ScrDyn *protected_keys) {
  return scr_dyn_define_props_internal(target, descs, protected_keys);
}

ScrDyn *scr_dyn_obj_create_with_properties(ScrDyn *prototype, ScrDyn *descriptors) {
  ScrDyn *object = scr_dyn_obj_create(prototype);
  if (!object) return NULL;
  if (descriptors->kind == SCR_DYN_UNDEF) return object;
  ScrDyn *defined = scr_dyn_define_props(object, descriptors);
  if (!defined) { scr_dyn_release(object); return NULL; }
  scr_dyn_release(defined);
  return object;
}
