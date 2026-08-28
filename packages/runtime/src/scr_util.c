/* node:util's engine-free static surface. parseArgs crosses the typed
 * frontend through the checked-dynamic tree: the config is JSON-safe data,
 * and the result is the ordinary Node-shaped { values, positionals,
 * tokens? } tree. This keeps the parser independent of every emitted
 * record/union layout while the frontend's dynCheck restores the precise
 * ParsedResults<T> type at the call site.
 *
 * The grammar follows Node 24's util.parseArgs/tokenizeArgs: long options,
 * grouped shorts, inline/separate string values, strict=false unknowns,
 * -- termination, negative booleans, multiple/default accumulation, and
 * token metadata. All input nodes are borrowed; the result owns fresh or
 * retained children. Validation/grammar failures leave a coded TypeError
 * pending and return NULL. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const ScrDyn *pa_own_member(const ScrDyn *obj, const char *key) {
  if (!obj || obj->kind != SCR_DYN_OBJ) return NULL;
  return scr_dyn_obj_get(obj, key, strlen(key));
}

/* The ordinary optional-member read: absent and explicit undefined both
 * answer no value. Descriptor fields whose validation depends on own
 * presence use pa_own_member directly. */
static const ScrDyn *pa_member(const ScrDyn *obj, const char *key) {
  const ScrDyn *v = pa_own_member(obj, key);
  return v && v->kind != SCR_DYN_UNDEF ? v : NULL;
}

static bool pa_str_eq_bytes(const ScrStr *s, const char *p, size_t n) {
  return s && s->len == n && memcmp(s->data, p, n) == 0;
}

static bool pa_str_eq_c(const ScrStr *s, const char *p) {
  return pa_str_eq_bytes(s, p, strlen(p));
}

static ScrStr *pa_str_bytes(const char *p, size_t n) {
  return scr_str_new(p, n);
}

static ScrDyn *pa_dyn_str(const ScrStr *s) {
  return scr_dyn_new_str((ScrStr *)s);
}

static ScrDyn *pa_dyn_str_bytes(const char *p, size_t n) {
  ScrStr *s = pa_str_bytes(p, n);
  ScrDyn *d = pa_dyn_str(s);
  scr_str_release(s);
  return d;
}

static char *pa_path(const char *prefix, const char *name, size_t name_len,
                     const char *suffix) {
  size_t pn = strlen(prefix), sn = strlen(suffix);
  char *out = malloc(pn + name_len + sn + 1);
  if (!out) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  memcpy(out, prefix, pn);
  memcpy(out + pn, name, name_len);
  memcpy(out + pn + name_len, suffix, sn + 1);
  return out;
}

static void pa_throw_text(ScrJsonBuf *b, const char *code) {
  ScrStr *msg = scr_jb_finish(b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len, code);
  scr_str_release(msg);
}

static void pa_unknown(const ScrStr *raw, bool allow_positionals) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Unknown option '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, "'");
  if (allow_positionals) {
    scr_jb_puts(&b, ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"");
    scr_jb_put_str(&b, raw);
    scr_jb_putc(&b, '"');
  }
  pa_throw_text(&b, "ERR_PARSE_ARGS_UNKNOWN_OPTION");
}

static void pa_option_label(ScrJsonBuf *b, const ScrDyn *desc,
                            const ScrStr *name) {
  const ScrDyn *shortv = pa_member(desc, "short");
  if (shortv && shortv->kind == SCR_DYN_STR && shortv->v.str->len > 0) {
    scr_jb_putc(b, '-');
    scr_jb_put_str(b, shortv->v.str);
    scr_jb_puts(b, ", ");
  }
  scr_jb_puts(b, "--");
  scr_jb_put_str(b, name);
}

static void pa_missing_value(const ScrDyn *desc, const ScrStr *name) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Option '");
  pa_option_label(&b, desc, name);
  scr_jb_puts(&b, " <value>' argument missing");
  pa_throw_text(&b, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
}

static void pa_ambiguous(const ScrStr *raw, const ScrStr *name,
                         bool is_short) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Option '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, "' argument is ambiguous.\nDid you forget to specify the option argument for '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, "'?\nTo specify an option argument starting with a dash use '--");
  scr_jb_put_str(&b, name);
  scr_jb_puts(&b, "=-XYZ'");
  if (is_short) {
    scr_jb_puts(&b, " or '");
    scr_jb_put_str(&b, raw);
    scr_jb_puts(&b, "-XYZ'");
  }
  scr_jb_puts(&b, ".");
  pa_throw_text(&b, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
}

static void pa_takes_no_value(const ScrDyn *desc, const ScrStr *name) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Option '");
  pa_option_label(&b, desc, name);
  scr_jb_puts(&b, "' does not take an argument");
  pa_throw_text(&b, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
}

static void pa_unexpected(const ScrStr *arg) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Unexpected argument '");
  scr_jb_put_str(&b, arg);
  scr_jb_puts(&b, "'. This command does not take positional arguments");
  pa_throw_text(&b, "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
}

static void pa_unexpected_dyn(const ScrDyn *arg) {
  if (arg->kind == SCR_DYN_STR) {
    pa_unexpected(arg->v.str);
    return;
  }
  ScrStr *shown = scr_dyn_format_j(arg);
  if (!shown) return;
  pa_unexpected(shown);
  scr_str_release(shown);
}

static void pa_nullish_arg_length(const ScrDyn *arg) {
  const char *kind = arg->kind == SCR_DYN_NULL ? "null" : "undefined";
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Cannot read properties of ");
  scr_jb_puts(&b, kind);
  scr_jb_puts(&b, " (reading 'length')");
  ScrStr *msg = scr_jb_finish(&b);
  scr_throw_error_msg(SCR_ERR_TYPE, msg->data, msg->len);
  scr_str_release(msg);
}

/* A config boolean with Node's default/validation rule. */
static bool pa_config_bool(const ScrDyn *config, const char *name,
                           bool fallback, bool *ok) {
  const ScrDyn *v = pa_member(config, name);
  if (!v || v->kind == SCR_DYN_NULL) return fallback;
  if (v->kind == SCR_DYN_BOOL) return v->v.b;
  scr_dyn_arg_type_fail(name, "of type boolean", v);
  *ok = false;
  return fallback;
}

/* Descriptor type: 1 string, 0 boolean, -1 malformed. Descriptors were
 * validated once before parsing, so parsing calls only see 0/1. */
static int pa_desc_type(const ScrDyn *desc) {
  const ScrDyn *v = pa_member(desc, "type");
  if (!v || v->kind != SCR_DYN_STR) return -1;
  if (pa_str_eq_c(v->v.str, "string")) return 1;
  if (pa_str_eq_c(v->v.str, "boolean")) return 0;
  return -1;
}

static bool pa_desc_multiple(const ScrDyn *desc) {
  const ScrDyn *v = pa_member(desc, "multiple");
  return v && v->kind == SCR_DYN_BOOL && v->v.b;
}

static bool pa_default_value_ok(const ScrDyn *v, int type) {
  return type == 1 ? v->kind == SCR_DYN_STR : v->kind == SCR_DYN_BOOL;
}

static ScrDyn *pa_materialize_js_array(const ScrDyn *value);

static bool pa_validate_option(const ScrStr *name, const ScrDyn *desc) {
  char *base = pa_path("options.", name->data, name->len, "");
  if (desc->kind != SCR_DYN_OBJ) {
    scr_dyn_prop_type_fail(base, "of type object", desc);
    free(base);
    return false;
  }
  const ScrDyn *typev = pa_member(desc, "type");
  int type = pa_desc_type(desc);
  if (type < 0) {
    char *path = pa_path(base, "", 0, ".type");
    scr_dyn_prop_type_fail(path, "('string|boolean')",
                           typev ? typev : scr_dyn_undefined());
    free(path);
    free(base);
    return false;
  }
  const ScrDyn *shortv = pa_own_member(desc, "short");
  if (shortv) {
    char *path = pa_path(base, "", 0, ".short");
    if (shortv->kind != SCR_DYN_STR) {
      scr_dyn_prop_type_fail(path, "of type string", shortv);
      free(path);
      free(base);
      return false;
    }
    if (scr_str_utf16_len(shortv->v.str) != 1) {
      scr_dyn_arg_value_fail(path, "must be a single character", shortv);
      free(path);
      free(base);
      return false;
    }
    free(path);
  }
  const ScrDyn *multiplev = pa_own_member(desc, "multiple");
  if (multiplev && multiplev->kind != SCR_DYN_BOOL) {
    char *path = pa_path(base, "", 0, ".multiple");
    scr_dyn_prop_type_fail(path, "of type boolean", multiplev);
    free(path);
    free(base);
    return false;
  }
  const ScrDyn *def = pa_member(desc, "default");
  if (def) {
    char *path = pa_path(base, "", 0, ".default");
    if (pa_desc_multiple(desc)) {
      /* A live typed/island array stays in the descriptor so phase 3 can
       * return that exact reference. Validate against a temporary snapshot. */
      ScrDyn *items = pa_materialize_js_array(def);
      if (!items) {
        free(path);
        free(base);
        return false;
      }
      if (items->kind != SCR_DYN_ARR) {
        scr_dyn_prop_type_fail(path, "an instance of Array", def);
        scr_dyn_release(items);
        free(path);
        free(base);
        return false;
      }
      for (size_t j = 0; j < items->v.arr.len; j++) {
        if (!pa_default_value_ok(items->v.arr.items[j], type)) {
          char suffix[48];
          snprintf(suffix, sizeof suffix, "[%zu]", j);
          char *item_path = pa_path(path, "", 0, suffix);
          scr_dyn_prop_type_fail(item_path,
                                 type ? "of type string" : "of type boolean",
                                 items->v.arr.items[j]);
          free(item_path);
          scr_dyn_release(items);
          free(path);
          free(base);
          return false;
        }
      }
      scr_dyn_release(items);
    } else if (!pa_default_value_ok(def, type)) {
      scr_dyn_prop_type_fail(path,
                             type ? "of type string" : "of type boolean", def);
      free(path);
      free(base);
      return false;
    }
    free(path);
  }
  free(base);
  return true;
}

/* Validate the option schema up front, as Node does even when args is
 * empty. Object.entries supplies JS own-key order (array-index names first),
 * which controls both validation precedence and duplicate-short lookup. */
static bool pa_validate_options(const ScrDyn *options) {
  if (!options) return true; /* null/undefined mean {} */
  if (options->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return false;
  }
  ScrDyn *entries = scr_dyn_obj_entries(options);
  for (size_t i = 0; i < entries->v.arr.len; i++) {
    const ScrDyn *pair = entries->v.arr.items[i];
    const ScrStr *name = pair->v.arr.items[0]->v.str;
    const ScrDyn *desc = pair->v.arr.items[1];
    if (!pa_validate_option(name, desc)) {
      scr_dyn_release(entries);
      return false;
    }
  }
  scr_dyn_release(entries);
  return true;
}

static const ScrDyn *pa_find_long(const ScrDyn *options, const ScrStr *name) {
  if (!options) return NULL;
  return scr_dyn_obj_get(options, name->data, name->len);
}

static bool pa_is_negative_name(const ScrStr *name) {
  return name->len >= 3 && memcmp(name->data, "no-", 3) == 0;
}

/* Node recognizes an inline long-option value only when an '=' occurs
 * after at least one name code unit, then splits at the first '='. */
static size_t pa_long_eq(const ScrStr *arg) {
  bool has_inline_value = false;
  for (size_t j = 3; j < arg->len; j++) {
    if (arg->data[j] == '=') { has_inline_value = true; break; }
  }
  if (!has_inline_value) return arg->len;
  for (size_t j = 2; j < arg->len; j++) {
    if (arg->data[j] == '=') return j;
  }
  return arg->len;
}

static const ScrDyn *pa_find_short(const ScrDyn *options,
                                   const ScrStr *short_name,
                                   ScrStr **long_name) {
  if (!options) {
    *long_name = pa_str_bytes(short_name->data, short_name->len);
    return NULL;
  }
  ScrDyn *entries = scr_dyn_obj_entries(options);
  for (size_t i = 0; i < entries->v.arr.len; i++) {
    const ScrDyn *pair = entries->v.arr.items[i];
    const ScrStr *name = pair->v.arr.items[0]->v.str;
    const ScrDyn *desc = pair->v.arr.items[1];
    const ScrDyn *shortv = pa_member(desc, "short");
    if (shortv && shortv->kind == SCR_DYN_STR &&
        shortv->v.str->len == short_name->len &&
        memcmp(shortv->v.str->data, short_name->data, short_name->len) == 0) {
      *long_name = pa_str_bytes(name->data, name->len);
      const ScrDyn *found = pa_find_long(options, name);
      scr_dyn_release(entries);
      return found;
    }
  }
  scr_dyn_release(entries);
  *long_name = pa_str_bytes(short_name->data, short_name->len);
  /* Node falls back to the short spelling itself as the long option name.
   * Thus `{ x: { type: "boolean" } }` accepts both `--x` and `-x` even
   * without an explicit `short: "x"` descriptor. */
  return pa_find_long(options, short_name);
}

static ScrDyn *pa_option_token(const ScrStr *name, const ScrStr *raw,
                               size_t index, const ScrDyn *value, int inline_value) {
  ScrDyn *token = scr_dyn_new_obj();
  scr_dyn_obj_set(token, "kind", 4, pa_dyn_str_bytes("option", 6));
  scr_dyn_obj_set(token, "name", 4, pa_dyn_str(name));
  scr_dyn_obj_set(token, "rawName", 7, pa_dyn_str(raw));
  scr_dyn_obj_set(token, "index", 5, scr_dyn_new_num((double)index));
  scr_dyn_obj_set(token, "value", 5,
                  value ? scr_dyn_retain((ScrDyn *)value)
                        : scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(token, "inlineValue", 11,
                  inline_value < 0 ? scr_dyn_retain(scr_dyn_undefined())
                                   : scr_dyn_new_bool(inline_value != 0));
  return token;
}

static void pa_store(ScrDyn *values, ScrDyn *tokens, const ScrDyn *desc,
                     const ScrStr *name, const ScrStr *raw, size_t index,
                     const ScrDyn *value, bool flag_value, int inline_value,
                     bool withhold_proto) {
  /* Node deliberately withholds this key from the null-prototype values
   * dictionary when it was the ORIGINAL option name. A normalized
   * `--no-__proto__` passes this check before normalization in Node and is
   * therefore stored safely on the null-prototype dictionary. */
  if (withhold_proto && pa_str_eq_c(name, "__proto__")) {
    if (tokens) {
      scr_dyn_arr_push(tokens,
                       pa_option_token(name, raw, index, value, inline_value));
    }
    return;
  }
  ScrDyn *stored = value ? scr_dyn_retain((ScrDyn *)value)
                         : scr_dyn_new_bool(flag_value);
  if (desc && pa_desc_multiple(desc)) {
    ScrDyn *arr = scr_dyn_obj_get(values, name->data, name->len);
    if (!arr) {
      arr = scr_dyn_new_arr();
      scr_dyn_obj_set(values, name->data, name->len, arr);
    }
    scr_dyn_arr_push(arr, stored);
  } else {
    scr_dyn_obj_set(values, name->data, name->len, stored);
  }
  if (tokens) {
    scr_dyn_arr_push(tokens,
                     pa_option_token(name, raw, index, value, inline_value));
  }
}

static void pa_store_flag(ScrDyn *values, ScrDyn *tokens,
                          const ScrDyn *options, const ScrDyn *desc,
                          const ScrStr *name, const ScrStr *raw, size_t index,
                          bool allow_negative) {
  if (allow_negative && pa_is_negative_name(name)) {
    ScrStr *positive = pa_str_bytes(name->data + 3, name->len - 3);
    const ScrDyn *positive_desc = pa_find_long(options, positive);
    pa_store(values, tokens, positive_desc, positive, raw, index,
             NULL, false, -1, false);
    scr_str_release(positive);
    return;
  }
  pa_store(values, tokens, desc, name, raw, index, NULL, true, -1, true);
}

static void pa_positional(ScrDyn *positionals, ScrDyn *tokens,
                          const ScrDyn *value, size_t index) {
  scr_dyn_arr_push(positionals, scr_dyn_retain((ScrDyn *)value));
  if (!tokens) return;
  ScrDyn *token = scr_dyn_new_obj();
  scr_dyn_obj_set(token, "kind", 4, pa_dyn_str_bytes("positional", 10));
  scr_dyn_obj_set(token, "index", 5, scr_dyn_new_num((double)index));
  scr_dyn_obj_set(token, "value", 5, scr_dyn_retain((ScrDyn *)value));
  scr_dyn_arr_push(tokens, token);
}

static ScrDyn *pa_default_args(void) {
  ScrDyn *args = scr_dyn_new_arr();
  ScrArr *argv = scr_process_argv();
  /* Read the ONE live interned process.argv array: user pushes, pops, and
   * replacements before parseArgs() are observable exactly as slice(2). */
  for (size_t i = 2; i < argv->len; i++) {
    ScrStr *arg = scr_arr_get_ref(argv, (double)i);
    scr_dyn_arr_push(args, pa_dyn_str(arg));
    scr_str_release(arg);
  }
  scr_arr_release(argv);
  return args;
}

/* Copy an engine-backed array into the native dyn alphabet without using
 * its iterator. Node's parseArgs takes args with Array.prototype.slice,
 * so indexed Gets (including holes -> undefined) and the live length are
 * the relevant semantics; an overridden Symbol.iterator is not. */
static ScrDyn *pa_materialize_js_array(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    return scr_dyn_typed_ref_materialize(value);
  }
  if (value->kind != SCR_DYN_JSVAL ||
      !scr_dyn_jsval_ops()->is_array(value->v.jsval.cell)) {
    return scr_dyn_retain((ScrDyn *)value);
  }
  ScrStr *length_key = scr_str_new("length", 6);
  ScrDyn *length = scr_dyn_jsval_ops()->key_get(value->v.jsval.cell,
                                                length_key);
  scr_str_release(length_key);
  if (!length) return NULL;
  if (length->kind != SCR_DYN_NUM || !isfinite(length->v.num) ||
      length->v.num < 0) {
    scr_dyn_release(length);
    return scr_dyn_retain((ScrDyn *)value); /* defensive: real arrays cannot */
  }
  size_t len = (size_t)length->v.num;
  scr_dyn_release(length);
  ScrDyn *out = scr_dyn_new_arr();
  for (size_t i = 0; i < len; i++) {
    char index[32];
    int n = snprintf(index, sizeof index, "%zu", i);
    ScrStr *key = scr_str_new(index, (size_t)n);
    ScrDyn *item = scr_dyn_jsval_ops()->key_get(value->v.jsval.cell, key);
    scr_str_release(key);
    if (!item) {
      scr_dyn_release(out);
      return NULL;
    }
    scr_dyn_arr_push(out, item);
  }
  return out;
}

/* Own-member read with an owned answer. Native config objects are already
 * inert dyn data; engine-backed configs route Object.hasOwn + Get through
 * the island so a normal `any` config can enter the native parser. */
static ScrDyn *pa_owned_member(const ScrDyn *obj, const char *key) {
  if (obj->kind == SCR_DYN_OBJ) {
    const ScrDyn *value = pa_own_member(obj, key);
    return value ? scr_dyn_retain((ScrDyn *)value) : NULL;
  }
  if (obj->kind != SCR_DYN_JSVAL) return NULL;
  ScrStr *name = scr_str_new(key, strlen(key));
  int own = scr_dyn_jsval_ops()->has_own(obj->v.jsval.cell, name);
  if (own != 1) {
    scr_str_release(name);
    return NULL;
  }
  ScrDyn *value = scr_dyn_jsval_ops()->key_get(obj->v.jsval.cell, name);
  scr_str_release(name);
  return value;
}

static ScrDyn *pa_materialize_descriptor(const ScrDyn *desc) {
  if (desc->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(desc);
    ScrDyn *out = pa_materialize_descriptor(view);
    scr_dyn_release(view);
    return out;
  }
  if (desc->kind == SCR_DYN_JSVAL &&
      scr_dyn_jsval_ops()->is_array(desc->v.jsval.cell)) {
    return pa_materialize_js_array(desc);
  }
  if (desc->kind != SCR_DYN_OBJ && desc->kind != SCR_DYN_JSVAL) {
    return scr_dyn_retain((ScrDyn *)desc);
  }
  if (desc->kind == SCR_DYN_JSVAL &&
      !scr_dyn_isl_typeof_is(desc, "object")) {
    return scr_dyn_retain((ScrDyn *)desc);
  }
  static const char *const fields[] = {"type", "short", "multiple", "default"};
  ScrDyn *out = scr_dyn_new_obj();
  for (size_t i = 0; i < sizeof fields / sizeof fields[0]; i++) {
    ScrDyn *value = pa_owned_member(desc, fields[i]);
    if (!value) {
      if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
      continue;
    }
    /* Node assigns a descriptor default directly into result.values. Keep
     * typed array defaults as their original static reference; island arrays
     * still need the ordinary native snapshot so dynCheck can consume them. */
    ScrDyn *native = strcmp(fields[i], "default") == 0 &&
                             value->kind == SCR_DYN_TYPED_REF
                         ? scr_dyn_retain(value)
                         : pa_materialize_js_array(value);
    scr_dyn_release(value);
    if (!native) { scr_dyn_release(out); return NULL; }
    scr_dyn_obj_set(out, fields[i], strlen(fields[i]), native);
  }
  return out;
}

static ScrDyn *pa_materialize_options(const ScrDyn *options) {
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(options);
    ScrDyn *out = pa_materialize_options(view);
    scr_dyn_release(view);
    return out;
  }
  if (options->kind == SCR_DYN_JSVAL &&
      scr_dyn_jsval_ops()->is_array(options->v.jsval.cell)) {
    return pa_materialize_js_array(options);
  }
  if (options->kind != SCR_DYN_OBJ && options->kind != SCR_DYN_JSVAL) {
    return scr_dyn_retain((ScrDyn *)options);
  }
  if (options->kind == SCR_DYN_JSVAL &&
      !scr_dyn_isl_typeof_is(options, "object")) {
    return scr_dyn_retain((ScrDyn *)options);
  }
  ScrDyn *entries = scr_dyn_obj_entries(options);
  if (!entries) return NULL;
  ScrDyn *out = scr_dyn_new_obj();
  for (size_t i = 0; i < entries->v.arr.len; i++) {
    const ScrDyn *pair = entries->v.arr.items[i];
    const ScrStr *name = pair->v.arr.items[0]->v.str;
    ScrDyn *desc = pa_materialize_descriptor(pair->v.arr.items[1]);
    if (!desc) {
      scr_dyn_release(out);
      scr_dyn_release(entries);
      return NULL;
    }
    scr_dyn_obj_set(out, name->data, name->len, desc);
  }
  scr_dyn_release(entries);
  return out;
}

/* Normalize the documented config members only. This is intentionally a
 * snapshot, matching parseArgs's synchronous reads, while preserving own
 * property presence (including explicit undefined) across the island. */
static ScrDyn *pa_materialize_config(const ScrDyn *config) {
  if (config->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(config);
    ScrDyn *out = pa_materialize_config(view);
    scr_dyn_release(view);
    return out;
  }
  if (config->kind != SCR_DYN_OBJ && config->kind != SCR_DYN_JSVAL) {
    return scr_dyn_retain((ScrDyn *)config);
  }
  static const char *const fields[] = {
    "args", "strict", "allowPositionals", "tokens", "allowNegative", "options",
  };
  ScrDyn *out = scr_dyn_new_obj();
  for (size_t i = 0; i < sizeof fields / sizeof fields[0]; i++) {
    ScrDyn *value = pa_owned_member(config, fields[i]);
    if (!value) {
      if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
      continue;
    }
    ScrDyn *native = strcmp(fields[i], "options") == 0
                         ? pa_materialize_options(value)
                         : pa_materialize_js_array(value);
    scr_dyn_release(value);
    if (!native) { scr_dyn_release(out); return NULL; }
    scr_dyn_obj_set(out, fields[i], strlen(fields[i]), native);
  }
  return out;
}

/* Whether tokenizing this string argument consumes the next array item as
 * a separate value. This mirrors the greedy string-option cases only; the
 * processing pass below still owns usage validation and token storage. */
static bool pa_consumes_next(const ScrDyn *options, const ScrStr *arg) {
  if (arg->len >= 2 && arg->data[0] == '-' && arg->data[1] == '-') {
    size_t eq = pa_long_eq(arg);
    if (eq < arg->len) return false;
    ScrStr *name = pa_str_bytes(arg->data + 2, eq - 2);
    const ScrDyn *desc = pa_find_long(options, name);
    bool consumes = desc && pa_desc_type(desc) == 1;
    scr_str_release(name);
    return consumes;
  }
  if (arg->len <= 1 || arg->data[0] != '-') return false;
  double units = scr_str_utf16_len((ScrStr *)arg);
  for (double at = 1; at < units; at++) {
    ScrStr *short_name = scr_str_char_at((ScrStr *)arg, at);
    ScrStr *name = NULL;
    const ScrDyn *desc = pa_find_short(options, short_name, &name);
    scr_str_release(name);
    scr_str_release(short_name);
    if (desc && pa_desc_type(desc) == 1) return at + 1 >= units;
  }
  return false;
}

ScrDyn *scr_util_parse_args(const ScrDyn *config) {
  /* Omitted config is lowered as {}, while an explicit undefined takes the
   * default parameter just as Node does. Null keeps Object(null)'s useful
   * failure; other primitive/array wrappers have no config members. */
  if (!config || config->kind == SCR_DYN_NULL) {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  ScrDyn *owned_config = pa_materialize_config(config);
  if (!owned_config) return NULL;
  const ScrDyn *cfg = owned_config->kind == SCR_DYN_OBJ ? owned_config : NULL;
  /* Node validates the args container before every flag and before the
   * option schema. Its element values are intentionally not prevalidated:
   * non-string values can still become loose-mode positional tokens. */
  ScrDyn *owned_args = NULL;
  const ScrDyn *args = pa_member(cfg, "args");
  if (!args || args->kind == SCR_DYN_NULL) {
    owned_args = pa_default_args();
    args = owned_args;
  } else if (args->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("args", "an instance of Array", args);
    scr_dyn_release(owned_config);
    return NULL;
  }

  bool ok = true;
  bool strict = pa_config_bool(cfg, "strict", true, &ok);
  if (!ok) { scr_dyn_release(owned_args); scr_dyn_release(owned_config); return NULL; }
  bool allow_positionals = pa_config_bool(cfg, "allowPositionals", !strict, &ok);
  if (!ok) { scr_dyn_release(owned_args); scr_dyn_release(owned_config); return NULL; }
  bool return_tokens = pa_config_bool(cfg, "tokens", false, &ok);
  if (!ok) { scr_dyn_release(owned_args); scr_dyn_release(owned_config); return NULL; }
  bool allow_negative = pa_config_bool(cfg, "allowNegative", false, &ok);
  if (!ok) { scr_dyn_release(owned_args); scr_dyn_release(owned_config); return NULL; }

  const ScrDyn *options = pa_member(cfg, "options");
  if (options && options->kind == SCR_DYN_NULL) options = NULL;
  if (!pa_validate_options(options)) {
    scr_dyn_release(owned_args);
    scr_dyn_release(owned_config);
    return NULL;
  }

  /* Node tokenizes the complete input before applying strict usage checks.
   * In the checked-dynamic alphabet, the only tokenizer-time exception is
   * a nullish argument before `--` (other non-strings become positionals),
   * so preflight that failure before the processing pass below. */
  bool scan_after_terminator = false;
  for (size_t i = 0; i < args->v.arr.len; i++) {
    const ScrDyn *arg_value = args->v.arr.items[i];
    if (scan_after_terminator) continue;
    if (arg_value->kind == SCR_DYN_NULL ||
        arg_value->kind == SCR_DYN_UNDEF) {
      pa_nullish_arg_length(arg_value);
      scr_dyn_release(owned_args);
      scr_dyn_release(owned_config);
      return NULL;
    }
    if (arg_value->kind != SCR_DYN_STR) continue;
    if (pa_str_eq_c(arg_value->v.str, "--")) {
      scan_after_terminator = true;
      continue;
    }
    if (pa_consumes_next(options, arg_value->v.str) &&
        i + 1 < args->v.arr.len &&
        args->v.arr.items[i + 1]->kind != SCR_DYN_NULL &&
        args->v.arr.items[i + 1]->kind != SCR_DYN_UNDEF) {
      i++;
    }
  }

  ScrDyn *result = scr_dyn_new_obj();
  ScrDyn *values = scr_dyn_new_obj_null_proto();
  ScrDyn *positionals = scr_dyn_new_arr();
  ScrDyn *tokens = return_tokens ? scr_dyn_new_arr() : NULL;
  bool after_terminator = false;

  for (size_t i = 0; i < args->v.arr.len; i++) {
    const ScrDyn *arg_value = args->v.arr.items[i];
    if (after_terminator) {
      if (!allow_positionals) {
        pa_unexpected_dyn(arg_value);
        goto fail;
      }
      pa_positional(positionals, tokens, arg_value, i);
      continue;
    }
    if (arg_value->kind == SCR_DYN_NULL || arg_value->kind == SCR_DYN_UNDEF) {
      pa_nullish_arg_length(arg_value);
      goto fail;
    }
    if (arg_value->kind != SCR_DYN_STR) {
      if (!allow_positionals) {
        pa_unexpected_dyn(arg_value);
        goto fail;
      }
      pa_positional(positionals, tokens, arg_value, i);
      continue;
    }
    const ScrStr *arg = arg_value->v.str;
    if (pa_str_eq_c(arg, "--")) {
      after_terminator = true;
      if (tokens) {
        ScrDyn *token = scr_dyn_new_obj();
        scr_dyn_obj_set(token, "kind", 4,
                        pa_dyn_str_bytes("option-terminator", 17));
        scr_dyn_obj_set(token, "index", 5, scr_dyn_new_num((double)i));
        scr_dyn_arr_push(tokens, token);
      }
      continue;
    }

    if (arg->len >= 2 && arg->data[0] == '-' && arg->data[1] == '-') {
      size_t eq = pa_long_eq(arg);
      /* The presence test starts after one name byte, so `--=x` stays the
       * lone option "=x". Once present, Node splits at the FIRST equals:
       * `--==x` therefore has the empty name and value "=x". */
      ScrStr *name = pa_str_bytes(arg->data + 2, eq - 2);
      ScrStr *raw = pa_str_bytes(arg->data, eq);
      const ScrDyn *desc = pa_find_long(options, name);
      if (eq < arg->len) {
        ScrStr *checked_name = NULL;
        const ScrDyn *checked_desc = desc;
        if (strict && !checked_desc && allow_negative &&
            pa_is_negative_name(name)) {
          checked_name = pa_str_bytes(name->data + 3, name->len - 3);
          const ScrDyn *positive_desc = pa_find_long(options, checked_name);
          if (positive_desc && pa_desc_type(positive_desc) == 0) {
            checked_desc = positive_desc;
          }
        }
        if (strict && !checked_desc) {
          pa_unknown(raw, allow_positionals);
          scr_str_release(checked_name);
          scr_str_release(raw);
          scr_str_release(name);
          goto fail;
        }
        if (strict && pa_desc_type(checked_desc) == 0) {
          pa_takes_no_value(checked_desc,
                            checked_name ? checked_name : name);
          scr_str_release(checked_name);
          scr_str_release(raw);
          scr_str_release(name);
          goto fail;
        }
        scr_str_release(checked_name);
        ScrStr *value = pa_str_bytes(arg->data + eq + 1, arg->len - eq - 1);
        ScrDyn *dyn_value = pa_dyn_str(value);
        pa_store(values, tokens, desc, name, raw, i, dyn_value, true, 1, true);
        scr_dyn_release(dyn_value);
        scr_str_release(value);
      } else if (desc && pa_desc_type(desc) == 1) {
        const ScrDyn *next = i + 1 < args->v.arr.len
                                 ? args->v.arr.items[i + 1] : NULL;
        if (next && next->kind != SCR_DYN_NULL && next->kind != SCR_DYN_UNDEF) {
          i++;
          if (strict && next->kind != SCR_DYN_STR) {
            pa_missing_value(desc, name);
            scr_str_release(raw);
            scr_str_release(name);
            goto fail;
          }
          if (strict && next->kind == SCR_DYN_STR &&
              next->v.str->len > 1 && next->v.str->data[0] == '-') {
            pa_ambiguous(raw, name, false);
            scr_str_release(raw);
            scr_str_release(name);
            goto fail;
          }
          pa_store(values, tokens, desc, name, raw, i - 1, next, true, 0, true);
        } else if (strict) {
          pa_missing_value(desc, name);
          scr_str_release(raw);
          scr_str_release(name);
          goto fail;
        } else {
          if (allow_negative && pa_is_negative_name(name)) {
            ScrStr *positive = pa_str_bytes(name->data + 3, name->len - 3);
            const ScrDyn *positive_desc = pa_find_long(options, positive);
            pa_store(values, tokens, positive_desc, positive, raw, i,
                     NULL, false, -1, false);
            scr_str_release(positive);
          } else {
            pa_store(values, tokens, desc, name, raw, i, NULL, true, -1, true);
          }
        }
      } else {
        ScrStr *positive = NULL;
        const ScrDyn *positive_desc = NULL;
        const bool negative = allow_negative && pa_is_negative_name(name);
        if (negative) {
          positive = pa_str_bytes(name->data + 3, name->len - 3);
          positive_desc = pa_find_long(options, positive);
        }
        if (strict && !desc &&
            (!negative || !positive_desc || pa_desc_type(positive_desc) != 0)) {
          pa_unknown(raw, allow_positionals);
          scr_str_release(positive);
          scr_str_release(raw);
          scr_str_release(name);
          goto fail;
        }
        if (negative) {
          pa_store(values, tokens, positive_desc, positive, raw, i,
                   NULL, false, -1, false);
          scr_str_release(positive);
        } else {
          pa_store(values, tokens, desc, name, raw, i, NULL, true, -1, true);
        }
      }
      scr_str_release(raw);
      scr_str_release(name);
      continue;
    }

    if (arg->len > 1 && arg->data[0] == '-') {
      double units = scr_str_utf16_len((ScrStr *)arg);
      for (double at = 1; at < units; at++) {
        ScrStr *short_name = scr_str_char_at((ScrStr *)arg, at);
        ScrStr *name = NULL;
        const ScrDyn *desc = pa_find_short(options, short_name, &name);
        char *raw_bytes = malloc(short_name->len + 1);
        if (!raw_bytes) {
          fputs("scriptc: out of memory\n", stderr);
          abort();
        }
        raw_bytes[0] = '-';
        memcpy(raw_bytes + 1, short_name->data, short_name->len);
        ScrStr *raw = pa_str_bytes(raw_bytes, short_name->len + 1);
        free(raw_bytes);
        if (strict && !desc) {
          pa_unknown(raw, allow_positionals);
          scr_str_release(raw);
          scr_str_release(name);
          scr_str_release(short_name);
          goto fail;
        }
        if (desc && pa_desc_type(desc) == 1) {
          if (at + 1 < units) {
            ScrStr *value = scr_str_slice((ScrStr *)arg, at + 1, INFINITY);
            ScrDyn *dyn_value = pa_dyn_str(value);
            pa_store(values, tokens, desc, name, raw, i, dyn_value, true, 1, true);
            scr_dyn_release(dyn_value);
            scr_str_release(value);
          } else if (i + 1 < args->v.arr.len &&
                     args->v.arr.items[i + 1]->kind != SCR_DYN_NULL &&
                     args->v.arr.items[i + 1]->kind != SCR_DYN_UNDEF) {
            const ScrDyn *value = args->v.arr.items[++i];
            if (strict && value->kind != SCR_DYN_STR) {
              pa_missing_value(desc, name);
              scr_str_release(raw);
              scr_str_release(name);
              scr_str_release(short_name);
              goto fail;
            }
            if (strict && value->kind == SCR_DYN_STR &&
                value->v.str->len > 1 && value->v.str->data[0] == '-') {
              pa_ambiguous(raw, name, true);
              scr_str_release(raw);
              scr_str_release(name);
              scr_str_release(short_name);
              goto fail;
            }
            pa_store(values, tokens, desc, name, raw, i - 1, value, true, 0, true);
          } else if (strict) {
            pa_missing_value(desc, name);
            scr_str_release(raw);
            scr_str_release(name);
            scr_str_release(short_name);
            goto fail;
          } else {
            pa_store_flag(values, tokens, options, desc, name, raw, i,
                          allow_negative);
          }
          scr_str_release(raw);
          scr_str_release(name);
          scr_str_release(short_name);
          break;
        }
        pa_store_flag(values, tokens, options, desc, name, raw, i,
                      allow_negative);
        scr_str_release(raw);
        scr_str_release(name);
        scr_str_release(short_name);
      }
      continue;
    }

    if (!allow_positionals) {
      pa_unexpected(arg);
      goto fail;
    }
    pa_positional(positionals, tokens, arg_value, i);
  }

  if (options) {
    ScrDyn *entries = scr_dyn_obj_entries(options);
    for (size_t i = 0; i < entries->v.arr.len; i++) {
      const ScrDyn *pair = entries->v.arr.items[i];
      const ScrStr *name = pair->v.arr.items[0]->v.str;
      const ScrDyn *desc = pair->v.arr.items[1];
      if (pa_str_eq_c(name, "__proto__")) continue;
      if (scr_dyn_obj_get(values, name->data, name->len)) continue;
      const ScrDyn *def = pa_member(desc, "default");
      if (def) {
        scr_dyn_obj_set(values, name->data, name->len,
                        scr_dyn_retain((ScrDyn *)def));
      }
    }
    scr_dyn_release(entries);
  }

  scr_dyn_obj_set(result, "values", 6, values);
  scr_dyn_obj_set(result, "positionals", 11, positionals);
  if (tokens) scr_dyn_obj_set(result, "tokens", 6, tokens);
  scr_dyn_release(owned_args);
  scr_dyn_release(owned_config);
  return result;

fail:
  scr_dyn_release(tokens);
  scr_dyn_release(positionals);
  scr_dyn_release(values);
  scr_dyn_release(result);
  scr_dyn_release(owned_args);
  scr_dyn_release(owned_config);
  return NULL;
}
