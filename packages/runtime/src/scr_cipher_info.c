/* scriptc runtime — crypto.getCipherInfo(nameOrNid[, options]) over the
 * table Node's OpenSSL ciphers generate (scr_cipher_info.h): cipher.js's
 * argument checks, then GetCipherInfo's keyLength and ivLength rules and
 * its info object, in Node's key order. Names match case-insensitively;
 * nids are OpenSSL's. Arguments are borrowed. */
#include "scr_runtime.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "scr_cipher_info.h"

#define CI_COUNT(table) (sizeof(table) / sizeof((table)[0]))

/* validateInt32(value, name): false with Node's error pending. */
static bool ci_validate_int32(const char *name, const ScrDyn *value) {
  if (value->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", value);
    return false;
  }
  double v = value->v.num;
  bool integer = isfinite(v) && trunc(v) == v;
  if (integer && v >= INT32_MIN && v <= INT32_MAX) return true;
  char received[48];
  scr_num_received(v, received);
  char text[192];
  int n = integer ? snprintf(text, sizeof text,
                             "The value of \"%s\" is out of range. It must be >= -2147483648 && <= 2147483647. "
                             "Received %s",
                             name, received)
                  : snprintf(text, sizeof text,
                             "The value of \"%s\" is out of range. It must be an integer. Received %s", name,
                             received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, text, n < 0 ? 0 : (size_t)n, "ERR_OUT_OF_RANGE");
  return false;
}

/* A plain view of a statically typed argument (+1), or NULL after a
 * throw. */
static ScrDyn *ci_plain(ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) return scr_dyn_typed_ref_materialize(value);
  return scr_dyn_retain(value);
}

static const ScCipherInfo *ci_by_name(const ScrStr *name) {
  char lower[64];
  if (name->len == 0 || name->len >= sizeof lower) return NULL;
  for (size_t i = 0; i < name->len; i++) {
    unsigned char ch = (unsigned char)name->data[i];
    lower[i] = (char)(ch >= 'A' && ch <= 'Z' ? ch + 32 : ch);
  }
  lower[name->len] = '\0';
  size_t lo = 0, hi = CI_COUNT(sc_cipher_info_names);
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    int cmp = strcmp(sc_cipher_info_names[mid].name, lower);
    if (cmp == 0) return &sc_cipher_infos[sc_cipher_info_names[mid].info];
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return NULL;
}

static const ScCipherInfo *ci_by_nid(double nid) {
  size_t lo = 0, hi = CI_COUNT(sc_cipher_info_nids);
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    double at = sc_cipher_info_nids[mid].nid;
    if (at == nid) return &sc_cipher_infos[sc_cipher_info_nids[mid].info];
    if (at < nid) lo = mid + 1;
    else hi = mid;
  }
  return NULL;
}

/* GetCipherInfo's option rules: a cipher that takes neither option (the
 * legacy provider's) answers undefined for either; keyLength must equal
 * the cipher's; ivLength must equal its IV length, or lie in 7 to 13 for
 * CCM and 1 to 15 for OCB, and GCM takes any. */
static bool ci_accepts(const ScCipherInfo *info, bool has_key, int key, bool has_iv, int iv) {
  if ((has_key || has_iv) && (info->key_rule == SC_INFO_NONE || info->iv_rule == SC_INFO_NONE)) return false;
  if (has_key && key != info->key_length) return false;
  if (!has_iv) return true;
  switch (info->iv_rule) {
  case SC_INFO_CCM: return iv >= 7 && iv <= 13;
  case SC_INFO_OCB: return iv >= 1 && iv <= 15;
  case SC_INFO_ANY: return true;
  default: return iv == (info->iv_length < 0 ? 0 : info->iv_length);
  }
}

static void ci_set_str(ScrDyn *obj, const char *key, const char *text) {
  ScrStr *s = scr_str_new(text, strlen(text));
  ScrDyn *v = scr_dyn_new_str(s);
  scr_str_release(s);
  scr_dyn_obj_set(obj, key, strlen(key), v);
}

static void ci_set_num(ScrDyn *obj, const char *key, double value) {
  scr_dyn_obj_set(obj, key, strlen(key), scr_dyn_new_num(value));
}

/* The info object: mode, name, nid, blockSize (not for stream ciphers),
 * ivLength (not when it is 0) and keyLength. */
static ScrDyn *ci_object(const ScCipherInfo *info, int iv) {
  ScrDyn *obj = scr_dyn_new_obj();
  if (info->mode) ci_set_str(obj, "mode", info->mode);
  ci_set_str(obj, "name", info->name);
  if (info->nid >= 0) ci_set_num(obj, "nid", info->nid);
  if (info->block_size >= 0) ci_set_num(obj, "blockSize", info->block_size);
  if (iv > 0) ci_set_num(obj, "ivLength", iv);
  ci_set_num(obj, "keyLength", info->key_length);
  return obj;
}

/* Whether options is a class instance whose class defines keyLength or
 * ivLength, which the runtime cannot read through the class's accessors. */
static bool ci_class_option(const ScrDyn *options) {
  if (options->kind != SCR_DYN_TYPED_REF) return false;
  bool found = false;
  static const char *const keys[] = {"keyLength", "ivLength"};
  for (size_t i = 0; i < 2 && !found; i++) {
    ScrStr *key = scr_str_new(keys[i], strlen(keys[i]));
    found = scr_dyn_typed_ref_class_has(options, key);
    scr_str_release(key);
  }
  return found;
}

/* An option as `const { keyLength, ivLength } = options` reads it: own and
 * inherited properties, through getters. +1, or NULL with the getter's
 * error pending. */
static ScrDyn *ci_option(const ScrDyn *options, const char *key) {
  if (options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_PROXY)
    return scr_dyn_obj_read(options, key, strlen(key));
  return scr_dyn_retain((ScrDyn *)scr_dyn_undefined());
}

static ScrDyn *ci_get(const ScrDyn *name_or_nid, const ScrDyn *options, bool class_option) {
  if (name_or_nid->kind != SCR_DYN_STR && name_or_nid->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("nameOrNid", "one of type string or number", name_or_nid);
    return NULL;
  }
  if (name_or_nid->kind == SCR_DYN_NUM && !ci_validate_int32("nameOrNid", name_or_nid)) return NULL;
  bool has_key = false, has_iv = false;
  int key = 0, iv = 0;
  if (options->kind != SCR_DYN_UNDEF) {
    ScrStr *type = scr_dyn_typeof(options);
    bool object = type->len == 6 && memcmp(type->data, "object", 6) == 0;
    scr_str_release(type);
    if (!object || options->kind == SCR_DYN_NULL || options->kind == SCR_DYN_ARR) {
      scr_dyn_arg_type_fail("options", "of type object", options);
      return NULL;
    }
    if (class_option) {
      static const char message[] = "getCipherInfo options whose class defines keyLength or ivLength have no "
                                    "lowering; pass an object with those properties";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    /* Both are read before either is validated, as in Node. */
    ScrDyn *key_value = ci_option(options, "keyLength");
    if (!key_value) return NULL;
    ScrDyn *iv_value = ci_option(options, "ivLength");
    if (!iv_value) {
      scr_dyn_release(key_value);
      return NULL;
    }
    bool ok = true;
    if (key_value->kind != SCR_DYN_UNDEF) {
      ok = ci_validate_int32("options.keyLength", key_value);
      has_key = true;
      key = ok ? (int)key_value->v.num : 0;
    }
    if (ok && iv_value->kind != SCR_DYN_UNDEF) {
      ok = ci_validate_int32("options.ivLength", iv_value);
      has_iv = true;
      iv = ok ? (int)iv_value->v.num : 0;
    }
    scr_dyn_release(key_value);
    scr_dyn_release(iv_value);
    if (!ok) return NULL;
  }
  const ScCipherInfo *info =
    name_or_nid->kind == SCR_DYN_STR ? ci_by_name(name_or_nid->v.str) : ci_by_nid(name_or_nid->v.num);
  if (!info || !ci_accepts(info, has_key, key, has_iv, iv)) return scr_dyn_retain((ScrDyn *)scr_dyn_undefined());
  return ci_object(info, has_iv ? iv : info->iv_length);
}

ScrDyn *scr_crypto_get_cipher_info(ScrDyn *name_or_nid, ScrDyn *options) {
  ScrDyn *name = ci_plain(name_or_nid);
  if (!name) return NULL;
  ScrDyn *opts = ci_plain(options);
  ScrDyn *result = opts ? ci_get(name, opts, ci_class_option(options)) : NULL;
  if (opts) scr_dyn_release(opts);
  scr_dyn_release(name);
  return result;
}
