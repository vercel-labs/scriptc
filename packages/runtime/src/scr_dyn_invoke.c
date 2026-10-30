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
#include <stdlib.h>
#include <string.h>

/* ── checked-dynamic METHOD DISPATCH (scr_dyn_invoke) ──────────────────
 *
 * `recv.m(args)` where recv is a dyn value and `m` is a name a
 * dyn-representable prototype declares (Array/String/Function shared
 * names — push, slice, forEach, apply, ...): a stored-member read would
 * return wrong results for real methods, so the dispatch runs HERE, over the
 * receiver's runtime kind. test/common's mustCall internals are the
 * canonical caller (mustCallChecks.push/filter/forEach, fn.apply).
 *
 * Honesty ladder, per (kind, name):
 *   - implemented: JS-exact semantics below;
 *   - the name exists on that kind's JS prototype but has no
 *     implementation here: a "not supported yet" Error instead of a
 *     wrong result;
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
    scr_jb_write(b, s->data, s->len);
    scr_str_release(s);
    return;
  }
  case SCR_DYN_NUM: {
    ScrStr *s = scr_f64_to_scrstr(d->v.num);
    scr_jb_write(b, s->data, s->len);
    scr_str_release(s);
    return;
  }
  case SCR_DYN_STR:
    scr_jb_write(b, d->v.str->data, d->v.str->len);
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
      if (ens) scr_jb_write(b, ens->data, ens->len);
      if (ens && ens->len && ems && ems->len) scr_jb_puts(b, ": ");
      if (ems) scr_jb_write(b, ems->data, ems->len);
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
      scr_jb_write(b, txt->data, txt->len);
      scr_str_release(txt);
      return;
    }
    for (size_t i = 0; i < d->v.bytes->len; i++) {
      if (i > 0) scr_jb_putc(b, ',');
      ScrStr *n = scr_f64_to_scrstr(scr_bytes_get(d->v.bytes, (double)i));
      scr_jb_write(b, n->data, n->len);
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
    scr_jb_write(b, s->data, s->len);
    scr_str_release(s);
    return;
  }
  case SCR_DYN_PROMISE:
    /* Object.prototype.toString — promises carry no own toString, and
     * their @@toStringTag is not modeled here; Node's String() answer
     * for a bare promise is "[object Promise]". */
    scr_jb_puts(b, "[object Promise]");
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
    ScrDyn *own = scr_dyn_typed_ref_key_get(recv, key);
    if (own || scr_exc_pending()) return own;
    ScrDyn *snapshot = scr_dyn_typed_ref_materialize(recv);
    if (scr_exc_pending()) { scr_dyn_release(snapshot); return NULL; }
    ScrDyn *result;
    if (snapshot->kind == SCR_DYN_OBJ || snapshot->kind == SCR_DYN_ARR ||
        snapshot->kind == SCR_DYN_FUNC || snapshot->kind == SCR_DYN_PROXY) {
      /* The view supplies descriptors, but inherited getters still receive
       * the capsule. Primitive and byte views retain their indexed readers. */
      ScrDyn *name = scr_dyn_new_str((ScrStr *)key);
      result = scr_dyn_reflect_get(snapshot, name, recv);
      scr_dyn_release(name);
    } else result = dyn_borrow_get(snapshot, key);
    scr_dyn_release(snapshot);
    return result;
  }
  if (recv->kind == SCR_DYN_OBJ) return scr_dyn_obj_read(recv, key->data, key->len);
  if (recv->kind == SCR_DYN_PROXY) return scr_dyn_proxy_get(recv, key);

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
    if (recv->kind == SCR_DYN_ARR)
      return scr_dyn_arr_has_index(recv, index) ? scr_dyn_retain(recv->v.arr.items[index])
          : scr_dyn_arr_named_get(recv, key);
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

/* Generic lengths can describe no allocated storage at all. Admit each scan
 * after its coercions, before growing a result or walking a fabricated range;
 * backed arrays retain their existing supported storage size. */
static bool dyn_array_scan(ScrDyn *recv, size_t count) {
  return recv->kind == SCR_DYN_ARR ||
    (recv->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(recv)) ||
    count == 0 || dyn_borrow_iteration(count - 1);
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

/* Each property operation reaches the current owner and checks its result.
 * A later failure must keep earlier writes; a detached method-wide snapshot
 * cannot preserve that order or mutations made by getters and coercions. */
static bool dyn_borrow_set(ScrDyn *recv, size_t index, ScrDyn *value) {
  ScrStr *key = dyn_borrow_key(index);
  scr_dyn_key_set(recv, key, value);
  scr_str_release(key);
  return !scr_exc_pending();
}

static bool dyn_borrow_delete(ScrDyn *recv, size_t index) {
  ScrStr *key = dyn_borrow_key(index);
  scr_dyn_key_delete(recv, key, true);
  scr_str_release(key);
  return !scr_exc_pending();
}

static bool dyn_borrow_set_length(ScrDyn *recv, size_t length) {
  ScrStr *key = scr_str_new("length", 6);
  ScrDyn *value = scr_dyn_new_num((double)length);
  scr_dyn_key_set(recv, key, value);
  scr_dyn_release(value);
  scr_str_release(key);
  return !scr_exc_pending();
}

static bool dyn_borrow_move(ScrDyn *recv, size_t from, size_t to) {
  bool present = dyn_borrow_present(recv, from);
  if (scr_exc_pending()) return false;
  if (!present) return dyn_borrow_delete(recv, to);
  ScrDyn *value = dyn_borrow_item(recv, from);
  if (!value) return false;
  bool ok = dyn_borrow_set(recv, to, value);
  scr_dyn_release(value);
  return ok;
}

static bool dyn_arr_proto_mutates(const char *method);
static ScrDyn *dyn_array_mutate(ScrDyn *recv, const char *method,
                               ScrDyn *const *args, size_t argc);

ScrDyn *scr_dyn_array_proto_call(ScrDyn *recv, ScrStr *method, ScrDyn *args) {
  if (!args || args->kind != SCR_DYN_ARR) scr_trap("scriptc: invalid Array.prototype arguments\n");
  if (strlen(method->data) == method->len && dyn_arr_proto_mutates(method->data))
    return dyn_array_mutate(recv, method->data, args->v.arr.items, args->v.arr.len);
  if (recv->kind == SCR_DYN_NULL || recv->kind == SCR_DYN_UNDEF) {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
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

/* Sort owns its work list across callbacks. Get/Has happen before sorting;
 * writes and hole deletions happen afterwards against the original receiver,
 * even if a comparator resized or restricted it in the meantime. */
static bool dyn_sort_less(void *ctx, uint64_t xs, uint64_t ys, bool *failed) {
  ScrDyn *cmp = ctx;
  ScrDyn *x = (ScrDyn *)(uintptr_t)xs, *y = (ScrDyn *)(uintptr_t)ys;
  if (cmp) {
    ScrDyn *argv[2] = { x, y };
    scr_dyn_this_push_dyn(NULL);
    ScrDyn *r = scr_dyn_call(cmp, argv, 2, "comparefn");
    scr_dyn_this_pop();
    if (!r) { *failed = true; return false; }
    double v = 0;
    bool ok = scr_dyn_number_coerce_js(r, &v);
    scr_dyn_release(r);
    if (!ok || scr_exc_pending()) { *failed = true; return false; }
    return v < 0;
  }
  ScrStr *xstr = scr_dyn_string_coerce_js(x);
  if (!xstr) { *failed = true; return false; }
  ScrStr *ystr = scr_dyn_string_coerce_js(y);
  if (!ystr) { scr_str_release(xstr); *failed = true; return false; }
  int c = scr_str_cmp_u16(xstr, ystr);
  scr_str_release(xstr);
  scr_str_release(ystr);
  return c < 0;
}

static bool dyn_arr_sort(ScrDyn *recv, ScrDyn *cmp, size_t len) {
  if (!dyn_array_scan(recv, len)) return false;
  uint64_t *work = NULL;
  size_t count = 0, capacity = 0, undefined = 0;
  bool ok = false;
  for (size_t i = 0; i < len; i++) {
    bool present = dyn_borrow_present(recv, i);
    if (scr_exc_pending()) goto done;
    if (!present) continue;
    ScrDyn *item = dyn_borrow_item(recv, i);
    if (!item) goto done;
    if (item->kind == SCR_DYN_UNDEF) { undefined++; scr_dyn_release(item); }
    else {
      if (count == capacity) {
        if (capacity > SIZE_MAX / 2 / sizeof *work) scr_trap("scriptc: sort capacity overflow\n");
        capacity = capacity ? capacity * 2 : 16;
        work = scr_mem_realloc(work, capacity * sizeof *work);
        if (!work) scr_trap("scriptc: out of memory\n");
      }
      work[count++] = (uint64_t)(uintptr_t)item;
    }
  }
  if (!scr_sort_slots_with(work, count, dyn_sort_less, cmp)) goto done;
  for (size_t i = 0; i < count + undefined; i++) {
    ScrDyn *value = i < count ? (ScrDyn *)(uintptr_t)work[i] : scr_dyn_undefined();
    if (!dyn_borrow_set(recv, i, value)) goto done;
  }
  for (size_t i = count + undefined; i < len; i++)
    if (!dyn_borrow_delete(recv, i)) goto done;
  ok = true;
done:
  for (size_t i = 0; i < count; i++) scr_dyn_release((ScrDyn *)(uintptr_t)work[i]);
  scr_mem_free(work);
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
    if (depth > 0 && item->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(item)) {
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
 * throw the "not supported yet" Error instead of mis-answering "is not a
 * function". */
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
static bool dyn_array_growth(size_t length, size_t added) {
  if (added <= 9007199254740991ULL - length && added <= SIZE_MAX - length) return true;
  static const char message[] = "Array-like length exceeds the maximum supported length";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  return false;
}

static ScrDyn *dyn_array_mutate(ScrDyn *recv, const char *method,
                               ScrDyn *const *args, size_t argc) {
  ScrDyn *cmp = argc ? args[0] : scr_dyn_undefined();
  bool sort = dyn_name_is(method, "sort");
  /* Sort validates the comparator before ToObject and the length getter. */
  if (sort && cmp->kind != SCR_DYN_UNDEF && !scr_dyn_is_callable(cmp)) {
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "The comparison function must be either a function or undefined: ");
    scr_dyn_display_buf(&message, cmp);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return NULL;
  }
  if (recv->kind == SCR_DYN_NULL || recv->kind == SCR_DYN_UNDEF) {
    static const char message[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  if (recv->kind != SCR_DYN_ARR && recv->kind != SCR_DYN_TYPED_REF &&
      recv->kind != SCR_DYN_OBJ && recv->kind != SCR_DYN_FUNC && recv->kind != SCR_DYN_PROXY) {
    dyn_throw_unsupported("Array", method);
    return NULL;
  }
  size_t len;
  if (!dyn_borrow_length(recv, &len)) return NULL;
  /* Node returns before visiting indexed properties for length zero or one,
   * including frozen receivers; comparator validation still runs first. */
  if (sort) return len < 2 || dyn_arr_sort(recv, cmp->kind == SCR_DYN_UNDEF ? NULL : cmp, len)
      ? scr_dyn_retain(recv) : NULL;
  if (dyn_name_is(method, "push") || dyn_name_is(method, "unshift")) {
    if (!dyn_array_growth(len, argc)) return NULL;
    if (argc && dyn_name_is(method, "unshift")) {
      if (!dyn_array_scan(recv, len)) return NULL;
      for (size_t i = len; i > 0; i--)
        if (!dyn_borrow_move(recv, i - 1, i + argc - 1)) return NULL;
    }
    size_t first = dyn_name_is(method, "push") ? len : 0;
    for (size_t i = 0; i < argc; i++)
      if (!dyn_borrow_set(recv, first + i, args[i])) return NULL;
    return dyn_borrow_set_length(recv, len + argc) ? scr_dyn_new_num((double)(len + argc)) : NULL;
  }
  if (dyn_name_is(method, "pop") || dyn_name_is(method, "shift")) {
    if (!len) return dyn_borrow_set_length(recv, 0) ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
    bool shift = dyn_name_is(method, "shift");
    ScrDyn *result = dyn_borrow_item(recv, shift ? 0 : len - 1);
    if (!result) return NULL;
    if (shift && !dyn_array_scan(recv, len - 1)) { scr_dyn_release(result); return NULL; }
    if (shift) for (size_t i = 1; i < len; i++)
      if (!dyn_borrow_move(recv, i, i - 1)) { scr_dyn_release(result); return NULL; }
    if (!dyn_borrow_delete(recv, len - 1) || !dyn_borrow_set_length(recv, len - 1)) {
      scr_dyn_release(result);
      return NULL;
    }
    return result;
  }
  if (dyn_name_is(method, "reverse")) {
    if (!dyn_array_scan(recv, len / 2)) return NULL;
    for (size_t lower = 0; lower < len / 2; lower++) {
      size_t upper = len - lower - 1;
      bool lower_has = dyn_borrow_present(recv, lower);
      if (scr_exc_pending()) return NULL;
      ScrDyn *lower_value = lower_has ? dyn_borrow_item(recv, lower) : NULL;
      if (lower_has && !lower_value) return NULL;
      bool upper_has = dyn_borrow_present(recv, upper);
      if (scr_exc_pending()) { scr_dyn_release(lower_value); return NULL; }
      ScrDyn *upper_value = upper_has ? dyn_borrow_item(recv, upper) : NULL;
      if (upper_has && !upper_value) { scr_dyn_release(lower_value); return NULL; }
      bool ok = true;
      if (lower_has && upper_has)
        ok = dyn_borrow_set(recv, lower, upper_value) && dyn_borrow_set(recv, upper, lower_value);
      else if (upper_has)
        ok = dyn_borrow_set(recv, lower, upper_value) && dyn_borrow_delete(recv, upper);
      else if (lower_has)
        ok = dyn_borrow_delete(recv, lower) && dyn_borrow_set(recv, upper, lower_value);
      scr_dyn_release(lower_value);
      scr_dyn_release(upper_value);
      if (!ok) return NULL;
    }
    return scr_dyn_retain(recv);
  }
  if (dyn_name_is(method, "fill")) {
    double start = dyn_index_arg(args, argc, 1, 0, method);
    if (scr_exc_pending()) return NULL;
    double end = dyn_index_arg(args, argc, 2, (double)len, method);
    if (scr_exc_pending()) return NULL;
    size_t first = dyn_rel_index(start, len), final = dyn_rel_index(end, len);
    if (!dyn_array_scan(recv, final > first ? final - first : 0)) return NULL;
    for (size_t i = first; i < final; i++)
      if (!dyn_borrow_set(recv, i, argc ? args[0] : scr_dyn_undefined())) return NULL;
    return scr_dyn_retain(recv);
  }
  if (dyn_name_is(method, "copyWithin")) {
    double target = dyn_index_arg(args, argc, 0, 0, method);
    if (scr_exc_pending()) return NULL;
    double start = dyn_index_arg(args, argc, 1, 0, method);
    if (scr_exc_pending()) return NULL;
    double end = dyn_index_arg(args, argc, 2, (double)len, method);
    if (scr_exc_pending()) return NULL;
    size_t to = dyn_rel_index(target, len), from = dyn_rel_index(start, len);
    size_t final = dyn_rel_index(end, len);
    size_t count = final > from ? final - from : 0;
    if (count > len - to) count = len - to;
    if (!dyn_array_scan(recv, count)) return NULL;
    bool backward = from < to && to < from + count;
    for (size_t step = 0; step < count; step++) {
      size_t offset = backward ? count - step - 1 : step;
      if (!dyn_borrow_move(recv, from + offset, to + offset)) return NULL;
    }
    return scr_dyn_retain(recv);
  }
  if (dyn_name_is(method, "splice")) {
    double start_value = dyn_index_arg(args, argc, 0, 0, method);
    if (scr_exc_pending()) return NULL;
    size_t start = dyn_rel_index(start_value, len);
    size_t removed = argc ? len - start : 0;
    if (argc > 1) {
      double count = dyn_index_arg(args, argc, 1, 0, method);
      if (scr_exc_pending()) return NULL;
      removed = count <= 0 ? 0 : count >= (double)(len - start) ? len - start : (size_t)count;
    }
    size_t inserted = argc > 2 ? argc - 2 : 0;
    if (!dyn_array_growth(len - removed, inserted)) return NULL;
    if (!dyn_array_scan(recv, removed)) return NULL;
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t i = 0; i < removed; i++) {
      bool present = dyn_borrow_present(recv, start + i);
      if (scr_exc_pending()) goto splice_failed;
      if (!present) scr_dyn_arr_push_hole(out);
      else {
        ScrDyn *value = dyn_borrow_item(recv, start + i);
        if (!value) goto splice_failed;
        scr_dyn_arr_push(out, value);
      }
    }
    if (inserted != removed && !dyn_array_scan(recv, len - start - removed)) goto splice_failed;
    if (inserted < removed) {
      for (size_t i = start; i < len - removed; i++)
        if (!dyn_borrow_move(recv, i + removed, i + inserted)) goto splice_failed;
      for (size_t i = len; i > len - removed + inserted; i--)
        if (!dyn_borrow_delete(recv, i - 1)) goto splice_failed;
    } else if (inserted > removed) {
      for (size_t i = len - removed; i > start; i--)
        if (!dyn_borrow_move(recv, i + removed - 1, i + inserted - 1)) goto splice_failed;
    }
    for (size_t i = 0; i < inserted; i++)
      if (!dyn_borrow_set(recv, start + i, args[i + 2])) goto splice_failed;
    if (!dyn_borrow_set_length(recv, len - removed + inserted)) goto splice_failed;
    return out;
splice_failed:
    scr_dyn_release(out);
    return NULL;
  }
  scr_trap("scriptc: invalid array mutator\n");
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

/* A numeric at() needs no snapshot. Mutators use the shared ordered
 * property executor so prototype effects and the final length Set run. */
static ScrDyn *dyn_live_array_method(ScrDyn *recv, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what, bool *handled) {
  const ScrDynTypedArrayOps *ops = scr_dyn_typed_ref_array_ops(recv);
  if (!ops) return NULL;
  ScrArr *arr = recv->v.typed_ref.ptr;
  size_t len = arr->len;
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
   * main()); the ladder inside throws the "not supported yet" Error for
   * real-but-unimplemented members. */
  if (recv->kind == SCR_DYN_HANDLE) {
    return scr_dynh_dispatch(recv, method, args, argc, what);
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

  /* Capsule shape selects the prototype. Mutations stay on the capsule;
   * read-only dispatch can still use its view and translate result identity. */
  if (recv->kind == SCR_DYN_TYPED_REF) {
    if (dyn_arr_proto_mutates(method) && scr_dyn_typed_ref_array_ops(recv))
      return dyn_array_mutate(recv, method, args, argc);
    bool handled = false;
    ScrDyn *fast = dyn_live_array_method(recv, method, args, argc, what, &handled);
    if (handled) return fast;
    if (scr_event_ref_hooks &&
        scr_event_ref_hooks->invoke(recv, method, args, argc, what, &fast))
      return fast;
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(recv);
    if (scr_exc_pending()) {
      scr_dyn_release(materialized);
      return NULL;
    }
    if (materialized->kind == SCR_DYN_ARR && dyn_arr_proto_mutates(method)) {
      scr_dyn_release(materialized);
      return dyn_array_mutate(recv, method, args, argc);
    }
    ScrDyn *result = scr_dyn_invoke_impl(
        materialized, method, args, argc, what, recv);
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
    if (m && (scr_dyn_is_callable(m))) {
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
        if (own->kind == SCR_DYN_FUNC) {
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
    if (dyn_arr_proto_mutates(method)) return dyn_array_mutate(recv, method, args, argc);
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
      }
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
        if (i > 0) scr_jb_write(&b, separator->data, separator->len);
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
        ScrDyn *view = args[a]->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(args[a])
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
        if (r->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(r)) {
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
        } else {
          scr_dyn_arr_push(out, r); /* ownership moves in */
        }
      }
      return out;
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
      if (!dyn_arr_sort(out, cmp->kind == SCR_DYN_FUNC ? cmp : NULL, len)) {
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

static void dyn_array_prototype_init(ScrDyn *prototype) {
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
}

ScrDyn *scr_dyn_array_prototype(void) {
  return scr_dyn_array_prototype_base(dyn_array_prototype_init);
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
