/* scriptc runtime — dynamic-tier values (scr_js.h): reference counting,
 * the dyn boundary conversions, and the generic operators over jsvals.
 *
 * Linked only into programs with dynamic-tier operations (the dynTier
 * runtime feature). The compiler inlines the number cases of every
 * operator and calls these entry points for the rest, so the generic
 * paths reuse the checked-dynamic operators of scr_json.c: operands are
 * lent to them as cells (an immediate is boxed for the call) and a number
 * result comes back as an immediate. Every JS-visible behavior (ToPrimitive
 * order, the object protocol, error messages) is therefore the dyn
 * operator's own. */
#include "scr_js.h"

/* ── reference counting ──────────────────────────────────────────────── */

ScrJsVal scr_js_retain(ScrJsVal v) {
  if (!scr_js_is_heap(v)) return v;
#if SCR_JS_IMMEDIATES
  if (scr_js_is_str(v)) {
    scr_str_retain(scr_js_str(v));
    return v;
  }
  if (scr_js_is_bigint(v)) {
    scr_bigint_retain(scr_js_bigint(v));
    return v;
  }
#endif
  ScrDyn *d = scr_js_cell(v);
  if (d) scr_dyn_retain(d);
  return v;
}

void scr_js_release(ScrJsVal v) {
  if (!scr_js_is_heap(v)) return;
#if SCR_JS_IMMEDIATES
  if (scr_js_is_str(v)) {
    scr_str_release(scr_js_str(v));
    return;
  }
  if (scr_js_is_bigint(v)) {
    scr_bigint_release(scr_js_bigint(v));
    return;
  }
#endif
  scr_dyn_release(scr_js_cell(v));
}

void *scr_js_retain_v(void *v) { return scr_js_retain(v); }

void scr_js_release_v(void *v) { scr_js_release(v); }

/* ── boundary conversions ────────────────────────────────────────────── */

ScrJsVal scr_js_from_str(ScrStr *s) {
#if SCR_JS_IMMEDIATES
  return scr_js_of_str(scr_str_retain(s));
#else
  return scr_dyn_new_str(s);
#endif
}

ScrJsVal scr_js_from_bigint(ScrBigInt *b) {
#if SCR_JS_IMMEDIATES
  return scr_js_of_bigint(scr_bigint_retain(b));
#else
  return scr_dyn_new_bigint(b);
#endif
}

ScrJsVal scr_js_from_dyn(ScrDyn *d) { return scr_js_of_cell(d); }

ScrDyn *scr_js_to_dyn(ScrJsVal v) {
#if SCR_JS_IMMEDIATES
  if (scr_js_is_double(v)) return scr_dyn_new_num(scr_js_double(v));
  switch (scr_js_tag(v)) {
  case SCR_JS_TAG_CELL: return scr_js_cell(v);
  case SCR_JS_TAG_STR: {
    ScrStr *s = scr_js_str(v);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  case SCR_JS_TAG_BIGINT: {
    ScrBigInt *b = scr_js_bigint(v);
    ScrDyn *d = scr_dyn_new_bigint(b);
    scr_bigint_release(b);
    return d;
  }
  default:
    switch (scr_js_bits(v)) {
    case SCR_JS_NULL_BITS: return scr_dyn_new_null();
    case SCR_JS_FALSE_BITS: return scr_dyn_new_bool(false);
    case SCR_JS_TRUE_BITS: return scr_dyn_new_bool(true);
    default: return scr_dyn_undefined();
    }
  }
#else
  return scr_js_cell(v);
#endif
}

ScrDyn *scr_js_to_dyn_borrow(ScrJsVal v) { return scr_js_to_dyn(scr_js_retain(v)); }

/* An owned operator result as a jsval: a number, boolean or unit cell
 * without own properties becomes its immediate (number results stay
 * allocation-free downstream); every other cell keeps its identity. NULL
 * (a pending throw) becomes undefined, which the caller's pending check
 * discards. */
static ScrJsVal scr_js_adopt(ScrDyn *d) {
  if (!d) return scr_js_undefined();
#if SCR_JS_IMMEDIATES
  if (!d->prototype && !d->symbol_properties && !d->symbol_keys) {
    ScrJsVal out;
    switch (d->kind) {
    case SCR_DYN_NUM: out = scr_js_from_double(d->v.num); break;
    case SCR_DYN_BOOL: out = scr_js_bool(d->v.b); break;
    case SCR_DYN_NULL: out = scr_js_null(); break;
    case SCR_DYN_UNDEF: out = scr_js_undefined(); break;
    default: return scr_js_of_cell(d);
    }
    scr_dyn_release(d);
    return out;
  }
#endif
  return scr_js_of_cell(d);
}

/* ── operators ───────────────────────────────────────────────────────── */

#if SCR_JS_IMMEDIATES
/* The string a jsval is (a string or a STR cell), borrowed; NULL otherwise. */
static ScrStr *scr_js_string_of(ScrJsVal v) {
  if (scr_js_is_str(v)) return scr_js_str(v);
  if (scr_js_is_cell(v)) {
    const ScrDyn *d = scr_js_cell(v);
    if (d && d->kind == SCR_DYN_STR) return d->v.str;
  }
  return NULL;
}

/* ToString of a primitive that ToPrimitive leaves unchanged (number,
 * boolean, undefined, null, string): +1, or NULL for every other value
 * (objects take the dyn operator's protocol, BigInts and symbols too). */
static ScrStr *scr_js_primitive_string(ScrJsVal v) {
  ScrStr *s = scr_js_string_of(v);
  if (s) return scr_str_retain(s);
  double n;
  if (scr_js_number(v, &n)) return scr_f64_to_scrstr(n);
  switch (scr_js_bits(v)) {
  case SCR_JS_UNDEFINED_BITS: return scr_str_new("undefined", 9);
  case SCR_JS_NULL_BITS: return scr_str_new("null", 4);
  case SCR_JS_FALSE_BITS: return scr_str_new("false", 5);
  case SCR_JS_TRUE_BITS: return scr_str_new("true", 4);
  default: return NULL;
  }
}

/* The BigInt a jsval is (a BigInt or a BIGINT cell), borrowed; NULL
 * otherwise. */
static ScrBigInt *scr_js_bigint_of(ScrJsVal v) {
  if (scr_js_is_bigint(v)) return scr_js_bigint(v);
  if (scr_js_is_cell(v)) {
    const ScrDyn *d = scr_js_cell(v);
    if (d && d->kind == SCR_DYN_BIGINT) return d->v.bigint;
  }
  return NULL;
}

/* A +1 BigInt result as a jsval, or undefined when the operation threw. */
static ScrJsVal scr_js_adopt_bigint(ScrBigInt *b) {
  return b ? scr_js_of_bigint(b) : scr_js_undefined();
}
#endif

ScrJsVal scr_js_add(ScrJsVal left, ScrJsVal right) {
  double a, b;
  if (scr_js_number(left, &a) && scr_js_number(right, &b)) return scr_js_from_double(a + b);
#if SCR_JS_IMMEDIATES
  /* A string with a primitive concatenates without boxing either side:
   * ToPrimitive leaves both unchanged, so no user code can run. */
  if (scr_js_string_of(left) || scr_js_string_of(right)) {
    ScrStr *ls = scr_js_primitive_string(left);
    ScrStr *rs = ls ? scr_js_primitive_string(right) : NULL;
    if (ls && rs) {
      ScrStr *joined = scr_str_concat(ls, rs);
      scr_str_release(ls);
      scr_str_release(rs);
      return scr_js_of_str(joined);
    }
    scr_str_release(ls);
  }
  ScrBigInt *lb = scr_js_bigint_of(left), *rb = scr_js_bigint_of(right);
  if (lb && rb) return scr_js_adopt_bigint(scr_bigint_add(lb, rb));
#endif
  ScrDyn *l = scr_js_to_dyn_borrow(left);
  ScrDyn *r = scr_js_to_dyn_borrow(right);
  ScrDyn *out = scr_dyn_add(l, r);
  scr_dyn_release(l);
  scr_dyn_release(r);
  return scr_js_adopt(out);
}

/* The number case of scr_dyn_arithmetic: the compiler inlines - * / %, so
 * this mostly serves `**` (ECMAScript differs from libm for ±1 ** ±Infinity
 * and 1 ** NaN). */
static double scr_js_number_arithmetic(double a, double b, const ScrStr *operation) {
  switch (operation->data[0]) {
  case '-': return a - b;
  case '/': return a / b;
  case '%': return fmod(a, b);
  default:
    if (operation->len == 2) return scr_math_pow(a, b);
    return a * b;
  }
}

ScrJsVal scr_js_arithmetic(ScrJsVal left, ScrJsVal right, const ScrStr *operation) {
  double a, b;
  if (scr_js_number(left, &a) && scr_js_number(right, &b))
    return scr_js_from_double(scr_js_number_arithmetic(a, b, operation));
#if SCR_JS_IMMEDIATES
  ScrBigInt *lb = scr_js_bigint_of(left), *rb = scr_js_bigint_of(right);
  if (lb && rb) {
    switch (operation->data[0]) {
    case '-': return scr_js_adopt_bigint(scr_bigint_sub(lb, rb));
    case '/': return scr_js_adopt_bigint(scr_bigint_div(lb, rb));
    case '%': return scr_js_adopt_bigint(scr_bigint_mod(lb, rb));
    default:
      return scr_js_adopt_bigint(operation->len == 2 ? scr_bigint_pow(lb, rb)
                                                     : scr_bigint_mul(lb, rb));
    }
  }
#endif
  ScrDyn *l = scr_js_to_dyn_borrow(left);
  ScrDyn *r = scr_js_to_dyn_borrow(right);
  ScrDyn *out = scr_dyn_arithmetic(l, r, operation);
  scr_dyn_release(l);
  scr_dyn_release(r);
  return scr_js_adopt(out);
}

ScrJsVal scr_js_bitwise(ScrJsVal left, ScrJsVal right, const ScrStr *operation) {
  /* The number case of scr_dyn_bitwise; unary `~` ignores its right
   * operand (undefined). */
  double a, b = 0;
  bool unary = operation->len == 1 && operation->data[0] == '~';
  if (scr_js_number(left, &a) && (unary || scr_js_number(right, &b))) {
    double result;
    char op = operation->data[0];
    if (unary) result = scr_bit_not(a);
    else if (op == '&') result = scr_bit_and(a, b);
    else if (op == '|') result = scr_bit_or(a, b);
    else if (op == '^') result = scr_bit_xor(a, b);
    else if (op == '<') result = scr_bit_shl(a, b);
    else if (operation->len == 2) result = scr_bit_shr(a, b);
    else result = scr_bit_ushr(a, b);
    return scr_js_from_double(result);
  }
  ScrDyn *l = scr_js_to_dyn_borrow(left);
  ScrDyn *r = scr_js_to_dyn_borrow(right);
  ScrDyn *out = scr_dyn_bitwise(l, r, operation);
  scr_dyn_release(l);
  scr_dyn_release(r);
  return scr_js_adopt(out);
}

bool scr_js_compare(ScrJsVal left, ScrJsVal right, const ScrStr *operation) {
  ScrDyn *l = scr_js_to_dyn_borrow(left);
  ScrDyn *r = scr_js_to_dyn_borrow(right);
  bool out = scr_dyn_compare(l, r, operation);
  scr_dyn_release(l);
  scr_dyn_release(r);
  return out;
}

ScrJsVal scr_js_to_numeric(ScrJsVal value) {
  double n;
  if (scr_js_number(value, &n)) return scr_js_from_double(n);
  ScrDyn *d = scr_js_to_dyn_borrow(value);
  ScrDyn *out = scr_dyn_to_numeric(d);
  scr_dyn_release(d);
  return scr_js_adopt(out);
}

ScrJsVal scr_js_increment(ScrJsVal value, bool increment) {
  double n;
  if (scr_js_number(value, &n)) return scr_js_from_double(n + (increment ? 1 : -1));
  ScrDyn *d = scr_js_to_dyn_borrow(value);
  ScrDyn *out = scr_dyn_increment(d, increment);
  scr_dyn_release(d);
  return scr_js_adopt(out);
}

double scr_js_to_number(ScrJsVal value) {
  double n;
  if (scr_js_number(value, &n)) return n;
  ScrDyn *d = scr_js_to_dyn_borrow(value);
  double out = scr_dyn_number_coerce(d);
  scr_dyn_release(d);
  return out;
}

bool scr_js_truthy(ScrJsVal value) {
#if SCR_JS_IMMEDIATES
  if (scr_js_is_double(value)) {
    double d = scr_js_double(value);
    return d == d && d != 0;
  }
  switch (scr_js_tag(value)) {
  case SCR_JS_TAG_CELL: return scr_dyn_truthy(scr_js_cell(value));
  case SCR_JS_TAG_STR: return scr_js_str(value)->len != 0;
  case SCR_JS_TAG_BIGINT: return scr_bigint_truthy(scr_js_bigint(value));
  default: return scr_js_bits(value) == SCR_JS_TRUE_BITS;
  }
#else
  return scr_dyn_truthy(scr_js_cell(value));
#endif
}
