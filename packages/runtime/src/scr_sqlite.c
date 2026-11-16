/* scriptc runtime — node:sqlite (Node's src/node_sqlite.cc) over the SQLite
 * amalgamation in packages/runtime/vendor/sqlite.
 *
 * DatabaseSync, StatementSync, their limits object and the statement
 * iterator are native handles of the checked-dynamic tree: their types map
 * to dyn, getters read through ScrDynHandleOps.get, methods dispatch through
 * .invoke (member calls reach both), and [Symbol.dispose] closes through
 * .symbol_get. `new DatabaseSync` and `v instanceof C` are lowered to the
 * entry points at the bottom of this file.
 *
 * A unit of its own, linked only by programs that name node:sqlite (the
 * compiler's `sqlite` runtime feature selects scr_sqlite.c and the vendored
 * SQLite archive), so a program that never imports the module links neither.
 */
#include "scr_runtime.h"

#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sqlite3.h"

typedef struct ScrSqliteDb ScrSqliteDb;
typedef struct ScrSqliteStmt ScrSqliteStmt;
typedef struct ScrSqliteLimits ScrSqliteLimits;
typedef struct ScrSqliteIter ScrSqliteIter;

/* Node's kLimitMapping (src/node_sqlite.h): the limits object's own names in
 * its own order, where index = the SQLITE_LIMIT_* id. */
static const char *const scr_sqlite_limit_names[] = {
    "length",     "sqlLength",    "column",     "exprDepth",
    "compoundSelect", "vdbeOp",   "functionArg", "attach",
    "likePatternLength", "variableNumber", "triggerDepth",
};
#define SCR_SQLITE_LIMIT_COUNT \
  ((size_t)(sizeof scr_sqlite_limit_names / sizeof scr_sqlite_limit_names[0]))

struct ScrSqliteStmt {
  size_t rc;
  ScrSqliteDb *db; /* owned */
  sqlite3_stmt *stmt; /* NULL once finalized */
  bool big_ints, return_arrays, allow_bare, allow_unknown;
  /* The bare-name -> full-name map allow_bare builds on first use (Node
   * caches it per statement). Both strings owned. */
  bool bare_built;
  struct {
    ScrStr *bare;
    ScrStr *full;
  } *bare_map;
  size_t bare_n;
  /* Node's reset_generation: run/get/all/iterate invalidate outstanding
   * iterators. */
  unsigned generation;
};

struct ScrSqliteDb {
  size_t rc;
  sqlite3 *conn; /* NULL once closed */
  ScrStr *path; /* the location as given, owned */
  bool open_option;
  bool allow_extension; /* the constructor's allowExtension */
  bool extension_enabled; /* the current dbconfig state */
  int timeout_ms;
  bool big_ints, return_arrays, allow_bare, allow_unknown;
  bool read_only, dqs, fkeys, defensive;
  /* Initial limits from options.limits, applied on open. */
  struct {
    int value;
    bool set;
  } limits[SCR_SQLITE_LIMIT_COUNT];
  /* Live statements: raw, non-owning (a statement owns a reference to its
   * database, never the other way around). */
  ScrSqliteStmt **stmts;
  size_t stmt_n, stmt_cap;
  /* CallbackDepthGuard: user callbacks (an authorizer, user functions,
   * aggregates) may not close or re-enter the database in barred ways. */
  int callback_depth;
  bool ignore_next_error;
};

struct ScrSqliteLimits {
  size_t rc;
  ScrSqliteDb *db; /* owned */
};

struct ScrSqliteIter {
  size_t rc;
  ScrSqliteStmt *stmt; /* owned; NULL once done */
  bool done;
  unsigned generation;
};

/* ── small helpers ──────────────────────────────────────────────────── */

static void scr_sqlite_oom(void) { scr_trap("scriptc: out of memory\n"); }

static ScrDyn *scr_sqlite_str_dyn(const char *text) {
  ScrStr *s = scr_str_new(text, strlen(text));
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

static const ScrDyn *scr_sqlite_arg(ScrDyn *const *args, size_t argc, size_t i) {
  return i < argc ? args[i] : scr_dyn_undefined();
}

static bool scr_sqlite_is_undefined(const ScrDyn *v) { return v->kind == SCR_DYN_UNDEF; }

/* JavaScript's `value[key]` over a checked-dynamic value (+1, or NULL with
 * the exception pending). A compiled program hands the runtime a typed
 * record or a class instance as a checked-dynamic capsule, so the read
 * materializes that view first; handles answer through their member get. */
static ScrDyn *scr_sqlite_get(const ScrDyn *value, const char *key) {
  size_t len = strlen(key);
  ScrDyn *result = NULL;
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    if (view == NULL || scr_exc_pending()) {
      scr_dyn_release(view);
      return NULL;
    }
    result = scr_sqlite_get(view, key);
    scr_dyn_release(view);
    return result;
  }
  if (value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_PROXY) {
    result = scr_dyn_obj_read(value, key, len);
  } else if (value->kind == SCR_DYN_HANDLE) {
    ScrStr *name = scr_str_new(key, len);
    result = scr_dyn_handle_key_get(value, name);
    scr_str_release(name);
    return result;
  } else {
    return scr_dyn_retain(scr_dyn_undefined());
  }
  return result != NULL ? result : scr_dyn_retain(scr_dyn_undefined());
}

/* Node's `IsObject()`: every value except the primitives, with a typed
 * record capsule counting as the object it views. */
static bool scr_sqlite_object_like(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_BIGINT:
  case SCR_DYN_SYMBOL:
    return false;
  case SCR_DYN_PROXY:
    return !scr_dyn_is_callable(value);
  case SCR_DYN_TYPED_REF: {
    ScrDyn *snapshot = scr_dyn_typed_ref_materialize(value);
    bool object = snapshot != NULL && scr_sqlite_object_like(snapshot);
    scr_dyn_release(snapshot);
    return object;
  }
  default:
    return true;
  }
}

/* Whether `value` is one of the binary buffers Node keeps out of the
 * named-parameter treatment (an ArrayBufferView, ArrayBuffer or
 * SharedArrayBuffer). */
static bool scr_sqlite_is_binary(const ScrDyn *value) {
  if (value->kind == SCR_DYN_BYTES) return true;
  return value->kind == SCR_DYN_HANDLE && (value->v.handle.tag == SCR_DYNH_ARRAY_BUFFER ||
                                           value->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER);
}

/* Reads a boolean option of an options object. An absent (or undefined)
 * member keeps *out; a present non-boolean answers false so the caller
 * raises Node's ERR_INVALID_ARG_TYPE. */
static bool scr_sqlite_option_bool(const ScrDyn *options, const char *key, size_t key_len,
                                   bool *out) {
  if (options == NULL || options->kind == SCR_DYN_UNDEF) return true;
  (void)key_len;
  ScrDyn *value = scr_sqlite_get(options, key);
  if (value == NULL) return true; /* an exception is pending */
  bool ok = true;
  if (value->kind == SCR_DYN_BOOL) *out = value->v.b;
  else if (value->kind != SCR_DYN_UNDEF) ok = false;
  scr_dyn_release(value);
  return ok;
}

/* ── errors ─────────────────────────────────────────────────────────── */

static void scr_sqlite_invalid_state(const char *msg) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, strlen(msg), "ERR_INVALID_STATE");
}

/* Node passes these texts straight to THROW_ERR_INVALID_ARG_TYPE, so the
 * message is the whole text rather than the standard "must be of type"
 * form. */
static void scr_sqlite_invalid_arg_type(const char *msg) {
  /* Node's ERR_INVALID_ARG_TYPE is a TypeError (node_errors.h). */
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
}

static void scr_sqlite_invalid_arg_value(const char *msg) {
  /* Node's ERR_INVALID_ARG_VALUE is a TypeError. */
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_VALUE");
}

static void scr_sqlite_out_of_range(const char *msg) {
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, strlen(msg), "ERR_OUT_OF_RANGE");
}

/* `what is not a function`, V8's TypeError for a name the class's surface
 * never had. */
static void scr_sqlite_not_a_function(const char *what) {
  char msg[192];
  int n = snprintf(msg, sizeof msg, "%s is not a function", what != NULL ? what : "");
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)(n < 0 ? 0 : n));
}

/* A member the class really has but this runtime does not model: the
 * checked-dynamic tree's ordinary "not supported yet" Error. */
static void scr_sqlite_not_supported(const char *cls, const char *method) {
  char msg[192];
  int n = snprintf(msg, sizeof msg, "'%s.prototype.%s' on a dynamic value is not supported yet",
                   cls, method);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)(n < 0 ? 0 : n), "SC2020");
}

/* One ERR_SQLITE_ERROR carrying the code's message and the extended code,
 * exactly Node's CreateSQLiteError(isolate, db). */
static void scr_sqlite_throw_coded_error(int errcode, const char *message) {
  const char *errstr = sqlite3_errstr(errcode);
  ScrStr *msg = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, "ERR_SQLITE_ERROR");
  ScrStr *str = scr_str_new(errstr != NULL ? errstr : "", strlen(errstr != NULL ? errstr : ""));
  ScrDyn *str_dyn = scr_dyn_new_str(str);
  scr_str_release(str);
  scr_error_set_prop(e, "errcode", 7, scr_dyn_new_num((double)errcode));
  scr_error_set_prop(e, "errstr", 6, str_dyn);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* ERR_SQLITE_ERROR from the connection. */
static void scr_sqlite_throw_db_error(ScrSqliteDb *db) {
  if (db->ignore_next_error) {
    db->ignore_next_error = false;
    return;
  }
  int errcode = sqlite3_extended_errcode(db->conn);
  scr_sqlite_throw_coded_error(errcode, sqlite3_errmsg(db->conn));
}

/* ERR_SQLITE_ERROR with a message only (Node's CreateSQLiteError(isolate,
 * message): no errcode or errstr). */
static void scr_sqlite_throw_message_error(const char *message) {
  ScrStr *msg = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, "ERR_SQLITE_ERROR");
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* ── value conversion: SQLite -> JavaScript ─────────────────────────── */

#define SCR_SQLITE_MAX_SAFE 9007199254740991.0

/* One column (Node's SQLITE_VALUE_TO_JS): +1, or NULL with the exception
 * pending (an integer too large for a double, ERR_OUT_OF_RANGE). */
static ScrDyn *scr_sqlite_column_value(sqlite3_stmt *stmt, int column, bool big_ints) {
  switch (sqlite3_column_type(stmt, column)) {
  case SQLITE_INTEGER: {
    sqlite3_int64 value = sqlite3_column_int64(stmt, column);
    if (big_ints) {
      ScrBigInt *big = scr_bigint_from_i64((int64_t)value);
      ScrDyn *d = scr_dyn_new_bigint(big);
      scr_bigint_release(big);
      return d;
    }
    if ((double)value >= -SCR_SQLITE_MAX_SAFE && (double)value <= SCR_SQLITE_MAX_SAFE)
      return scr_dyn_new_num((double)value);
    char msg[128];
    snprintf(msg, sizeof msg,
             "Value is too large to be represented as a JavaScript number: %lld",
             (long long)value);
    scr_sqlite_out_of_range(msg);
    return NULL;
  }
  case SQLITE_FLOAT:
    return scr_dyn_new_num(sqlite3_column_double(stmt, column));
  case SQLITE_TEXT: {
    const unsigned char *text = sqlite3_column_text(stmt, column);
    if (text == NULL) {
      scr_throw_error_msg_code(SCR_ERR_ERROR, "Memory allocation failed", 22,
                               "ERR_MEMORY_ALLOCATION_FAILED");
      return NULL;
    }
    int len = sqlite3_column_bytes(stmt, column);
    ScrStr *s = scr_str_from_utf8_lossy((const uint8_t *)text, (size_t)len);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  case SQLITE_NULL:
    return scr_dyn_new_null();
  case SQLITE_BLOB: {
    int size = sqlite3_column_bytes(stmt, column);
    const void *data = sqlite3_column_blob(stmt, column);
    ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)(size > 0 ? size : 0));
    if (size > 0 && data != NULL) memcpy(bytes->data, data, (size_t)size);
    ScrDyn *d = scr_dyn_new_bytes(bytes);
    scr_bytes_release(bytes);
    return d;
  }
  default:
    return scr_dyn_new_null();
  }
}

/* ── value conversion: JavaScript -> SQLite binds ───────────────────── */

/* The bytes of a binary value Node binds as a BLOB: a view's elements, or an
 * ArrayBuffer's (and SharedArrayBuffer's) whole storage. */
static bool scr_sqlite_binary_bytes(const ScrDyn *value, const void **data, size_t *len) {
  if (value->kind == SCR_DYN_BYTES) {
    const ScrBytes *b = value->v.bytes;
    *data = b->data;
    *len = b->len * scr_bytes_elem_size(b->elem);
    return true;
  }
  if (value->kind == SCR_DYN_HANDLE && (value->v.handle.tag == SCR_DYNH_ARRAY_BUFFER ||
                                        value->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER)) {
    const ScrBytes *b = value->v.handle.ptr;
    *data = b->data;
    *len = (size_t)scr_bytes_byte_len(b);
    return true;
  }
  return false;
}

/* Node's BindValue: binds parameter `index`, answering false with the
 * exception pending for a value SQLite cannot take. */
static bool scr_sqlite_bind_value(ScrSqliteStmt *s, int index, const ScrDyn *value) {
  int r;
  switch (value->kind) {
  case SCR_DYN_NUM:
    r = sqlite3_bind_double(s->stmt, index, value->v.num);
    break;
  case SCR_DYN_STR:
    r = sqlite3_bind_text64(s->stmt, index, value->v.str->data,
                            (sqlite3_uint64)value->v.str->len, SQLITE_TRANSIENT, SQLITE_UTF8);
    break;
  case SCR_DYN_NULL:
    r = sqlite3_bind_null(s->stmt, index);
    break;
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE: {
    const void *data = NULL;
    size_t length = 0;
    if (!scr_sqlite_binary_bytes(value, &data, &length)) {
      char msg[128];
      snprintf(msg, sizeof msg, "Provided value cannot be bound to SQLite parameter %d.", index);
      scr_sqlite_invalid_arg_type(msg);
      return false;
    }
    r = sqlite3_bind_blob64(s->stmt, index, data, (sqlite3_uint64)length, SQLITE_TRANSIENT);
    break;
  }
  case SCR_DYN_BOOL:
    r = sqlite3_bind_int(s->stmt, index, value->v.b ? 1 : 0);
    break;
  case SCR_DYN_BIGINT: {
    if (!scr_bigint_i64_fits(value->v.bigint)) {
      scr_sqlite_invalid_arg_value("BigInt value is too large to bind.");
      return false;
    }
    r = sqlite3_bind_int64(s->stmt, index, (sqlite3_int64)scr_bigint_to_i64(value->v.bigint));
    break;
  }
  default: {
    char msg[128];
    snprintf(msg, sizeof msg, "Provided value cannot be bound to SQLite parameter %d.", index);
    scr_sqlite_invalid_arg_type(msg);
    return false;
  }
  }
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(s->db);
    return false;
  }
  return true;
}

/* ── statement lifecycle ────────────────────────────────────────────── */

static void *scr_sqlite_db_retain(void *h);
static void scr_sqlite_db_release(void *h);

static ScrSqliteStmt *scr_sqlite_stmt_alloc(ScrSqliteDb *db, sqlite3_stmt *stmt) {
  ScrSqliteStmt *s = calloc(1, sizeof *s);
  if (s == NULL) scr_sqlite_oom();
  s->rc = 1;
  s->db = scr_sqlite_db_retain(db);
  s->stmt = stmt;
  s->big_ints = db->big_ints;
  s->return_arrays = db->return_arrays;
  s->allow_bare = db->allow_bare;
  s->allow_unknown = db->allow_unknown;
  return s;
}

static void *scr_sqlite_stmt_retain(void *h) {
  ((ScrSqliteStmt *)h)->rc++;
  return h;
}

static void scr_sqlite_stmt_clear_bare(ScrSqliteStmt *s) {
  for (size_t i = 0; i < s->bare_n; i++) {
    scr_str_release(s->bare_map[i].bare);
    scr_str_release(s->bare_map[i].full);
  }
  free(s->bare_map);
  s->bare_map = NULL;
  s->bare_n = 0;
  s->bare_built = false;
}

/* Finalizes the statement's SQLite handle (Node's Finalize). */
static void scr_sqlite_stmt_finalize(ScrSqliteStmt *s) {
  if (s->stmt != NULL) sqlite3_finalize(s->stmt);
  s->stmt = NULL;
  scr_sqlite_stmt_clear_bare(s);
}

/* Removes `s` from its database's live-statement list. */
static void scr_sqlite_db_untrack(ScrSqliteDb *db, ScrSqliteStmt *s) {
  for (size_t i = 0; i < db->stmt_n; i++) {
    if (db->stmts[i] == s) {
      db->stmts[i] = db->stmts[db->stmt_n - 1];
      db->stmt_n--;
      return;
    }
  }
}

static void scr_sqlite_stmt_release(void *h) {
  ScrSqliteStmt *s = h;
  if (s == NULL || --s->rc > 0) return;
  ScrSqliteDb *db = s->db;
  if (s->stmt != NULL) {
    scr_sqlite_db_untrack(db, s);
    scr_sqlite_stmt_finalize(s);
  }
  free(s);
  scr_sqlite_db_release(db);
}

static bool scr_sqlite_stmt_is_finalized(const ScrSqliteStmt *s) { return s->stmt == NULL; }

/* StatementSync::BindParams. */
static bool scr_sqlite_stmt_bind_params(ScrSqliteStmt *s, ScrDyn *const *args, size_t argc) {
  if (sqlite3_clear_bindings(s->stmt) != SQLITE_OK) {
    scr_sqlite_throw_db_error(s->db);
    return false;
  }

  int anon_idx = 1;
  size_t anon_start = 0;
  const ScrDyn *first = scr_sqlite_arg(args, argc, 0);

  /* Node treats any object outside the ArrayBuffer family as a
   * named-parameter bag (`IsObject()` minus the buffers) — arrays and
   * functions included. */
  if (scr_sqlite_object_like(first) && !scr_sqlite_is_binary(first)) {
    if (s->allow_bare && !s->bare_built) {
      s->bare_built = true;
      int param_count = sqlite3_bind_parameter_count(s->stmt);
      for (int i = 1; i <= param_count; i++) {
        const char *name = sqlite3_bind_parameter_name(s->stmt, i);
        if (name == NULL) continue;
        ScrStr *bare = scr_str_new(name + 1, strlen(name + 1));
        ScrStr *full = scr_str_new(name, strlen(name));
        bool duplicate = false;
        for (size_t k = 0; k < s->bare_n; k++) {
          if (s->bare_map[k].bare->len == bare->len &&
              memcmp(s->bare_map[k].bare->data, bare->data, bare->len) == 0) {
            duplicate = true;
            if (s->bare_map[k].full->len != full->len ||
                memcmp(s->bare_map[k].full->data, full->data, full->len) != 0) {
              char msg[512];
              snprintf(msg, sizeof msg,
                       "Cannot create bare named parameter '%.*s' because of conflicting names "
                       "'%.*s' and '%.*s'.",
                       (int)bare->len, bare->data, (int)s->bare_map[k].full->len,
                       s->bare_map[k].full->data, (int)full->len, full->data);
              scr_str_release(bare);
              scr_str_release(full);
              scr_sqlite_invalid_state(msg);
              return false;
            }
            break;
          }
        }
        if (duplicate) {
          scr_str_release(bare);
          scr_str_release(full);
          continue;
        }
        void *grown = realloc(s->bare_map, (s->bare_n + 1) * sizeof *s->bare_map);
        if (grown == NULL) scr_sqlite_oom();
        s->bare_map = grown;
        s->bare_map[s->bare_n].bare = bare;
        s->bare_map[s->bare_n].full = full;
        s->bare_n++;
      }
    }

    ScrDyn *keys = scr_dyn_obj_keys(first);
    if (keys == NULL) return false;
    double key_count = scr_dyn_arr_len(keys);
    for (double j = 0; j < key_count; j++) {
      ScrDyn *key = scr_dyn_arr_at(keys, j);
      if (key == NULL) {
        scr_dyn_release(keys);
        return false;
      }
      if (key->kind != SCR_DYN_STR) {
        scr_dyn_release(key);
        continue;
      }
      int index = sqlite3_bind_parameter_index(s->stmt, key->v.str->data);
      if (index == 0 && s->allow_bare) {
        for (size_t k = 0; k < s->bare_n; k++) {
          if (s->bare_map[k].bare->len == key->v.str->len &&
              memcmp(s->bare_map[k].bare->data, key->v.str->data, key->v.str->len) == 0) {
            index = sqlite3_bind_parameter_index(s->stmt, s->bare_map[k].full->data);
            break;
          }
        }
      }
      if (index == 0) {
        if (s->allow_unknown) {
          scr_dyn_release(key);
          continue;
        }
        char msg[256];
        snprintf(msg, sizeof msg, "Unknown named parameter '%.*s'", (int)key->v.str->len,
                 key->v.str->data);
        scr_dyn_release(key);
        scr_dyn_release(keys);
        scr_sqlite_invalid_state(msg);
        return false;
      }
      /* A ScrStr's storage is NUL-terminated, so the key is a C string. */
      ScrDyn *value = scr_sqlite_get(first, key->v.str->data);
      scr_dyn_release(key);
      if (value == NULL) {
        scr_dyn_release(keys);
        return false;
      }
      bool ok = scr_sqlite_bind_value(s, index, value);
      scr_dyn_release(value);
      if (!ok) {
        scr_dyn_release(keys);
        return false;
      }
    }
    scr_dyn_release(keys);
    anon_start = 1;
  }

  for (size_t i = anon_start; i < argc; i++) {
    while (1) {
      const char *param = sqlite3_bind_parameter_name(s->stmt, anon_idx);
      if (param == NULL || param[0] == '?') break;
      anon_idx++;
    }
    if (!scr_sqlite_bind_value(s, anon_idx, args[i])) return false;
    anon_idx++;
  }
  return true;
}

/* Node's ResetStatement: invalidates outstanding iterators. */
static int scr_sqlite_stmt_reset(ScrSqliteStmt *s) {
  s->generation++;
  return sqlite3_reset(s->stmt);
}

/* One row as an object of column name -> value, or an array with
 * returnArrays. +1, or NULL with the exception pending. */
static ScrDyn *scr_sqlite_row(ScrSqliteStmt *s, bool arrays) {
  int columns = sqlite3_column_count(s->stmt);
  ScrDyn *values = scr_dyn_new_arr();
  for (int i = 0; i < columns; i++) {
    ScrDyn *value = scr_sqlite_column_value(s->stmt, i, s->big_ints);
    if (value == NULL) {
      scr_dyn_release(values);
      return NULL;
    }
    scr_dyn_arr_push(values, value);
  }
  if (arrays) return values;
  ScrDyn *row = scr_dyn_new_obj_null_proto();
  for (int i = 0; i < columns; i++) {
    const char *name = sqlite3_column_name(s->stmt, i);
    ScrDyn *value = scr_dyn_arr_at(values, (double)i);
    if (value == NULL) {
      scr_dyn_release(values);
      scr_dyn_release(row);
      return NULL;
    }
    scr_dyn_obj_set(row, name != NULL ? name : "", name != NULL ? strlen(name) : 0, value);
  }
  scr_dyn_release(values);
  return row;
}

/* ── the statement iterator ─────────────────────────────────────────── */

static void *scr_sqlite_iter_retain(void *h) {
  ((ScrSqliteIter *)h)->rc++;
  return h;
}

static void scr_sqlite_iter_release(void *h) {
  ScrSqliteIter *it = h;
  if (it == NULL || --it->rc > 0) return;
  if (it->stmt != NULL) {
    scr_sqlite_stmt_release(it->stmt);
    it->stmt = NULL;
  }
  free(it);
}

/* Drops the statement reference once the iterator has drained. */
static void scr_sqlite_iter_finish(ScrSqliteIter *it) {
  it->done = true;
  if (it->stmt != NULL) {
    scr_sqlite_stmt_release(it->stmt);
    it->stmt = NULL;
  }
}

/* One iteration result, {done, value}, null-prototype as Node's
 * dictionary-template instances are. `value` is +1 or NULL (null). */
static ScrDyn *scr_sqlite_iter_result(bool done, ScrDyn *value) {
  ScrDyn *result = scr_dyn_new_obj_null_proto();
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  scr_dyn_obj_set(result, "value", 5, value != NULL ? value : scr_dyn_new_null());
  return result;
}

/* StatementSyncIterator::Next. */
static ScrDyn *scr_sqlite_iter_next(ScrSqliteIter *it) {
  if (it->done) return scr_sqlite_iter_result(true, NULL);
  ScrSqliteStmt *s = it->stmt;
  if (s == NULL || scr_sqlite_stmt_is_finalized(s)) {
    scr_sqlite_invalid_state("statement has been finalized");
    return NULL;
  }
  if (it->generation != s->generation) {
    scr_sqlite_invalid_state("iterator was invalidated");
    return NULL;
  }
  int r = sqlite3_step(s->stmt);
  if (r != SQLITE_ROW) {
    if (r != SQLITE_DONE) {
      scr_sqlite_throw_db_error(s->db);
      return NULL;
    }
    sqlite3_reset(s->stmt);
    scr_sqlite_iter_finish(it);
    return scr_sqlite_iter_result(true, NULL);
  }
  ScrDyn *row = scr_sqlite_row(s, s->return_arrays);
  if (row == NULL) return NULL;
  return scr_sqlite_iter_result(false, row);
}

static ScrDyn *scr_sqlite_iter_invoke(void *h, ScrDyn *self, const char *method,
                                      ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  ScrSqliteIter *it = h;
  if (strcmp(method, "next") == 0) return scr_sqlite_iter_next(it);
  if (strcmp(method, "return") == 0) {
    if (it->stmt != NULL && scr_sqlite_stmt_is_finalized(it->stmt)) {
      scr_sqlite_invalid_state("statement has been finalized");
      return NULL;
    }
    if (!it->done && it->stmt != NULL) sqlite3_reset(it->stmt->stmt);
    scr_sqlite_iter_finish(it);
    return scr_sqlite_iter_result(true, NULL);
  }
  scr_sqlite_not_a_function(what);
  return NULL;
}

/* for-of and spread over the iterator drain the remaining rows: the emitted
 * loop packs a dyn iterable first (scr_dyn_iter_pack asks this). +1 array,
 * or NULL with the exception pending. */
static ScrDyn *scr_sqlite_iter_pack(void *h) {
  ScrSqliteIter *it = h;
  ScrDyn *rows = scr_dyn_new_arr();
  while (!it->done) {
    ScrDyn *result = scr_sqlite_iter_next(it);
    if (result == NULL) {
      scr_dyn_release(rows);
      return NULL;
    }
    const ScrDyn *done_v = scr_dyn_obj_get(result, "done", 4);
    bool done = done_v != NULL && scr_dyn_truthy(done_v);
    if (!done) {
      const ScrDyn *value = scr_dyn_obj_get(result, "value", 5);
      scr_dyn_arr_push(rows, scr_dyn_retain((ScrDyn *)(value != NULL ? value : scr_dyn_undefined())));
    }
    scr_dyn_release(result);
  }
  return rows;
}

/* The iterator models no properties: every name is answered by the class's
 * method table (next, return, Symbol.iterator). scr_dyn_handle_key_get
 * requires the get hook. */
static ScrDyn *scr_sqlite_iter_get(void *h, const char *key, size_t len) {
  (void)h;
  (void)key;
  (void)len;
  return NULL;
}

static ScrDyn *scr_sqlite_iter_self_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  (void)args;
  (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  if (self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_SQLITE_ITERATOR) return self;
  scr_dyn_release(self);
  scr_sqlite_not_a_function("[Symbol.iterator]");
  return NULL;
}

static ScrDyn *scr_sqlite_iter_symbol_get(void *h, const ScrDyn *key) {
  (void)h;
  if (!scr_dyn_is_iterator_symbol(key)) return NULL;
  /* A fresh function per read: a box kept only in a C static is invisible to
   * the cycle collector, and a symbol-keyed read is a call site (the
   * compiler fences symbol members read as values), so identity is not
   * observable. */
  /* scr_dyn_new_func takes ownership of the closure. */
  ScrClosure *clo = scr_closure_new(NULL, 0);
  return scr_dyn_new_func(clo, scr_sqlite_iter_self_call, 0, "", "[Symbol.iterator]");
}

static const ScrDynHandleMethod scr_sqlite_iter_methods[] = {
    {"next", 0, false, NULL, NULL},
    {"return", 0, false, NULL, NULL},
    {NULL, 0, false, NULL, NULL},
};

static const ScrDynHandleOps scr_sqlite_iter_ops = {
    .cls = "StatementSyncIterator",
    .retain = scr_sqlite_iter_retain,
    .release = scr_sqlite_iter_release,
    .invoke = scr_sqlite_iter_invoke,
    .get = scr_sqlite_iter_get,
    .iter_pack = scr_sqlite_iter_pack,
    .json_empty_object = true,
    .symbol_get = scr_sqlite_iter_symbol_get,
    .to_string_tag = "Iterator",
    .methods = scr_sqlite_iter_methods,
};

static ScrDyn *scr_sqlite_iter_new(ScrSqliteIter *it) {
  scr_dyn_handle_install(SCR_DYNH_SQLITE_ITERATOR, &scr_sqlite_iter_ops);
  ScrDyn *d = scr_dyn_new_handle(it, SCR_DYNH_SQLITE_ITERATOR);
  scr_sqlite_iter_release(it);
  return d;
}

/* ── statement handle ops ───────────────────────────────────────────── */

static ScrDyn *scr_sqlite_stmt_dispose_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  (void)args;
  (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *out = NULL;
  ScrSqliteStmt *s =
      self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_SQLITE_STATEMENT
          ? self->v.handle.ptr
          : NULL;
  if (s != NULL) {
    if (s->stmt != NULL) {
      scr_sqlite_db_untrack(s->db, s);
      scr_sqlite_stmt_finalize(s);
    }
    out = scr_dyn_retain(scr_dyn_undefined());
  } else {
    scr_sqlite_not_a_function("[Symbol.dispose]");
  }
  scr_dyn_release(self);
  return out;
}

static ScrDyn *scr_sqlite_stmt_symbol_get(void *h, const ScrDyn *key) {
  (void)h;
  if (!scr_dyn_is_dispose_symbol(key)) return NULL;
  ScrClosure *clo = scr_closure_new(NULL, 0);
  return scr_dyn_new_func(clo, scr_sqlite_stmt_dispose_call, 0, "", "[Symbol.dispose]");
}

static ScrDyn *scr_sqlite_stmt_invoke(void *h, ScrDyn *self, const char *method,
                                      ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrSqliteStmt *s = h;

  if (strcmp(method, "run") == 0 || strcmp(method, "get") == 0 || strcmp(method, "all") == 0 ||
      strcmp(method, "iterate") == 0) {
    if (scr_sqlite_stmt_is_finalized(s)) {
      scr_sqlite_invalid_state("statement has been finalized");
      return NULL;
    }
    if (s->db->callback_depth > 0) {
      scr_sqlite_invalid_state("database cannot be accessed from an authorizer callback");
      return NULL;
    }
    if (scr_sqlite_stmt_reset(s) != SQLITE_OK) {
      scr_sqlite_throw_db_error(s->db);
      return NULL;
    }
    if (!scr_sqlite_stmt_bind_params(s, args, argc)) return NULL;
  }

  if (strcmp(method, "run") == 0) {
    sqlite3_step(s->stmt);
    if (sqlite3_reset(s->stmt) != SQLITE_OK) {
      scr_sqlite_throw_db_error(s->db);
      return NULL;
    }
    sqlite3_int64 last_rowid = sqlite3_last_insert_rowid(s->db->conn);
    sqlite3_int64 changes = sqlite3_changes64(s->db->conn);
    /* Node's run result is a dictionary-template instance over the
     * ordinary object prototype (unlike its row and column objects). */
    ScrDyn *result = scr_dyn_new_obj();
    if (s->big_ints) {
      ScrBigInt *changes_big = scr_bigint_from_i64((int64_t)changes);
      ScrBigInt *rowid_big = scr_bigint_from_i64((int64_t)last_rowid);
      scr_dyn_obj_set(result, "changes", 7, scr_dyn_new_bigint(changes_big));
      scr_dyn_obj_set(result, "lastInsertRowid", 15, scr_dyn_new_bigint(rowid_big));
      scr_bigint_release(changes_big);
      scr_bigint_release(rowid_big);
    } else {
      scr_dyn_obj_set(result, "changes", 7, scr_dyn_new_num((double)changes));
      scr_dyn_obj_set(result, "lastInsertRowid", 15, scr_dyn_new_num((double)last_rowid));
    }
    return result;
  }

  if (strcmp(method, "get") == 0) {
    int r = sqlite3_step(s->stmt);
    ScrDyn *out;
    if (r == SQLITE_DONE || (r == SQLITE_ROW && sqlite3_column_count(s->stmt) == 0)) {
      out = scr_dyn_retain(scr_dyn_undefined());
    } else if (r != SQLITE_ROW) {
      sqlite3_reset(s->stmt);
      scr_sqlite_throw_db_error(s->db);
      return NULL;
    } else {
      out = scr_sqlite_row(s, s->return_arrays);
    }
    sqlite3_reset(s->stmt);
    return out;
  }

  if (strcmp(method, "all") == 0) {
    ScrDyn *rows = scr_dyn_new_arr();
    int r;
    while ((r = sqlite3_step(s->stmt)) == SQLITE_ROW) {
      ScrDyn *row = scr_sqlite_row(s, s->return_arrays);
      if (row == NULL) {
        sqlite3_reset(s->stmt);
        scr_dyn_release(rows);
        return NULL;
      }
      scr_dyn_arr_push(rows, row);
    }
    sqlite3_reset(s->stmt);
    if (r != SQLITE_DONE) {
      scr_dyn_release(rows);
      scr_sqlite_throw_db_error(s->db);
      return NULL;
    }
    return rows;
  }

  if (strcmp(method, "iterate") == 0) {
    ScrSqliteIter *it = calloc(1, sizeof *it);
    if (it == NULL) scr_sqlite_oom();
    it->rc = 1;
    it->stmt = scr_sqlite_stmt_retain(s);
    it->generation = s->generation;
    return scr_sqlite_iter_new(it);
  }

  if (strcmp(method, "close") == 0) {
    if (scr_sqlite_stmt_is_finalized(s)) {
      scr_sqlite_invalid_state("statement has been finalized");
      return NULL;
    }
    scr_sqlite_db_untrack(s->db, s);
    scr_sqlite_stmt_finalize(s);
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "columns") == 0) {
    if (scr_sqlite_stmt_is_finalized(s)) {
      scr_sqlite_invalid_state("statement has been finalized");
      return NULL;
    }
    int columns = sqlite3_column_count(s->stmt);
    ScrDyn *out = scr_dyn_new_arr();
    for (int i = 0; i < columns; i++) {
      ScrDyn *col = scr_dyn_new_obj_null_proto();
      const char *origin = sqlite3_column_origin_name(s->stmt, i);
      const char *database = sqlite3_column_database_name(s->stmt, i);
      const char *table = sqlite3_column_table_name(s->stmt, i);
      const char *decltype = sqlite3_column_decltype(s->stmt, i);
      const char *name = sqlite3_column_name(s->stmt, i);
      scr_dyn_obj_set(col, "column", 6, origin != NULL ? scr_sqlite_str_dyn(origin) : scr_dyn_new_null());
      scr_dyn_obj_set(col, "database", 8,
                      database != NULL ? scr_sqlite_str_dyn(database) : scr_dyn_new_null());
      scr_dyn_obj_set(col, "name", 4, scr_sqlite_str_dyn(name != NULL ? name : ""));
      scr_dyn_obj_set(col, "table", 5, table != NULL ? scr_sqlite_str_dyn(table) : scr_dyn_new_null());
      scr_dyn_obj_set(col, "type", 4,
                      decltype != NULL ? scr_sqlite_str_dyn(decltype) : scr_dyn_new_null());
      scr_dyn_arr_push(out, col);
    }
    return out;
  }

  if (strcmp(method, "setReadBigInts") == 0 || strcmp(method, "setReturnArrays") == 0 ||
      strcmp(method, "setAllowBareNamedParameters") == 0 ||
      strcmp(method, "setAllowUnknownNamedParameters") == 0) {
    if (scr_sqlite_stmt_is_finalized(s)) {
      scr_sqlite_invalid_state("statement has been finalized");
      return NULL;
    }
    const ScrDyn *v = scr_sqlite_arg(args, argc, 0);
    const char *label = strcmp(method, "setReadBigInts") == 0             ? "readBigInts"
                        : strcmp(method, "setReturnArrays") == 0          ? "returnArrays"
                        : strcmp(method, "setAllowBareNamedParameters") == 0
                            ? "allowBareNamedParameters"
                            : "enabled";
    if (v->kind != SCR_DYN_BOOL) {
      char msg[128];
      snprintf(msg, sizeof msg, "The \"%s\" argument must be a boolean.", label);
      scr_sqlite_invalid_arg_type(msg);
      return NULL;
    }
    if (strcmp(method, "setReadBigInts") == 0) s->big_ints = v->v.b;
    else if (strcmp(method, "setReturnArrays") == 0) s->return_arrays = v->v.b;
    else if (strcmp(method, "setAllowBareNamedParameters") == 0) s->allow_bare = v->v.b;
    else s->allow_unknown = v->v.b;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  scr_sqlite_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_sqlite_stmt_get(void *h, const char *key, size_t len) {
  ScrSqliteStmt *s = h;
  if (len == 9 && memcmp(key, "sourceSQL", 9) == 0) {
    if (scr_sqlite_stmt_is_finalized(s)) {
      scr_sqlite_invalid_state("statement has been finalized");
      return NULL;
    }
    const char *sql = sqlite3_sql(s->stmt);
    return scr_sqlite_str_dyn(sql != NULL ? sql : "");
  }
  if (len == 11 && memcmp(key, "expandedSQL", 11) == 0) {
    if (scr_sqlite_stmt_is_finalized(s)) {
      scr_sqlite_invalid_state("statement has been finalized");
      return NULL;
    }
    char *expanded = sqlite3_expanded_sql(s->stmt);
    if (expanded == NULL) {
      scr_sqlite_throw_message_error("Expanded SQL text would exceed configured limits");
      return NULL;
    }
    ScrDyn *d = scr_sqlite_str_dyn(expanded);
    sqlite3_free(expanded);
    return d;
  }
  return NULL;
}

static ScrDyn *scr_sqlite_stmt_inspect_view(void *h) {
  (void)h;
  return scr_dyn_new_obj_null_proto();
}

static const ScrDynHandleMethod scr_sqlite_stmt_methods[] = {
    {"run", 0, false, NULL, NULL},
    {"get", 0, false, NULL, NULL},
    {"all", 0, false, NULL, NULL},
    {"iterate", 0, false, NULL, NULL},
    {"close", 0, false, NULL, NULL},
    {"columns", 0, false, NULL, NULL},
    {"setReadBigInts", 0, false, NULL, NULL},
    {"setReturnArrays", 0, false, NULL, NULL},
    {"setAllowBareNamedParameters", 0, false, NULL, NULL},
    {"setAllowUnknownNamedParameters", 0, false, NULL, NULL},
    {NULL, 0, false, NULL, NULL},
};

static const ScrDynHandleOps scr_sqlite_stmt_ops = {
    .cls = "StatementSync",
    .retain = scr_sqlite_stmt_retain,
    .release = scr_sqlite_stmt_release,
    .invoke = scr_sqlite_stmt_invoke,
    .get = scr_sqlite_stmt_get,
    .inspect_view = scr_sqlite_stmt_inspect_view,
    .inspect_view_empty = true,
    .symbol_get = scr_sqlite_stmt_symbol_get,
    .json_empty_object = true,
    .methods = scr_sqlite_stmt_methods,
};

/* ── the limits object ──────────────────────────────────────────────── */

static void scr_sqlite_db_release(void *h);

static void *scr_sqlite_limits_retain(void *h) {
  ((ScrSqliteLimits *)h)->rc++;
  return h;
}

static void scr_sqlite_limits_release(void *h) {
  ScrSqliteLimits *l = h;
  if (l == NULL || --l->rc > 0) return;
  ScrSqliteDb *db = l->db;
  free(l);
  scr_sqlite_db_release(db);
}

/* The index of a limit name, or -1. */
static int scr_sqlite_limit_index(const char *key, size_t len) {
  for (size_t i = 0; i < SCR_SQLITE_LIMIT_COUNT; i++) {
    if (strlen(scr_sqlite_limit_names[i]) == len &&
        memcmp(scr_sqlite_limit_names[i], key, len) == 0)
      return (int)i;
  }
  return -1;
}

static ScrDyn *scr_sqlite_limits_get(void *h, const char *key, size_t len) {
  ScrSqliteLimits *l = h;
  int index = scr_sqlite_limit_index(key, len);
  if (index < 0) return NULL;
  if (l->db->conn == NULL) {
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  return scr_dyn_new_num((double)sqlite3_limit(l->db->conn, index, -1));
}

static bool scr_sqlite_limits_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  ScrSqliteLimits *l = h;
  int index = scr_sqlite_limit_index(key, len);
  if (index < 0) return false;
  if (l->db->conn == NULL) {
    scr_sqlite_invalid_state("database is not open");
    return true;
  }
  if (l->db->callback_depth > 0) {
    scr_sqlite_invalid_state("database cannot be accessed from an authorizer callback");
    return true;
  }
  if (value->kind != SCR_DYN_NUM) {
    scr_sqlite_invalid_arg_type("Limit value must be a non-negative integer or Infinity.");
    return true;
  }
  double number = value->v.num;
  int new_value;
  if (isinf(number) && number > 0) {
    new_value = INT_MAX;
  } else if (number != floor(number) || number < (double)INT_MIN ||
             number > (double)INT_MAX) {
    scr_sqlite_invalid_arg_type("Limit value must be a non-negative integer or Infinity.");
    return true;
  } else {
    new_value = (int)number;
    if (new_value < 0) {
      scr_sqlite_out_of_range("Limit value must be non-negative.");
      return true;
    }
  }
  sqlite3_limit(l->db->conn, index, new_value);
  return true;
}

static ScrDyn *scr_sqlite_limits_invoke(void *h, ScrDyn *self, const char *method,
                                        ScrDyn *const *args, size_t argc, const char *what) {
  (void)h;
  (void)self;
  (void)args;
  (void)argc;
  scr_sqlite_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_sqlite_limits_inspect_view(void *h) {
  ScrSqliteLimits *l = h;
  ScrDyn *view = scr_dyn_new_obj_null_proto();
  if (l->db->conn == NULL) return view;
  for (size_t i = 0; i < SCR_SQLITE_LIMIT_COUNT; i++) {
    scr_dyn_obj_set(view, scr_sqlite_limit_names[i], strlen(scr_sqlite_limit_names[i]),
                    scr_dyn_new_num((double)sqlite3_limit(l->db->conn, (int)i, -1)));
  }
  return view;
}

static const ScrDynHandleOps scr_sqlite_limits_ops = {
    .cls = "DatabaseSyncLimits",
    .retain = scr_sqlite_limits_retain,
    .release = scr_sqlite_limits_release,
    .invoke = scr_sqlite_limits_invoke,
    .get = scr_sqlite_limits_get,
    .set = scr_sqlite_limits_set,
    .inspect_view = scr_sqlite_limits_inspect_view,
    .json_empty_object = true,
};

/* ── sqlite.backup ──────────────────────────────────────────────────── */

static char *scr_sqlite_validate_path(const ScrDyn *path);
static ScrSqliteDb *scr_sqlite_db_of(const ScrDyn *box);

/* The destination of a backup, closed after the copy: the error code it
 * left, read before the handle turns sick. */
typedef struct ScrSqliteBackup {
  sqlite3 *dest;
  int status;
} ScrSqliteBackup;

static void scr_sqlite_backup_close(ScrSqliteBackup *job) {
  if (job->dest != NULL) {
    sqlite3_close_v2(job->dest);
    job->dest = NULL;
  }
}

/* The JavaScript progress callback over { totalPages, remainingPages }. */
static bool scr_sqlite_backup_progress(ScrSqliteDb *db, const ScrDyn *progress, int total,
                                       int remaining) {
  if (progress == NULL) return true;
  ScrDyn *info = scr_dyn_new_obj_null_proto();
  scr_dyn_obj_set(info, "totalPages", 10, scr_dyn_new_num((double)total));
  scr_dyn_obj_set(info, "remainingPages", 14, scr_dyn_new_num((double)remaining));
  scr_dyn_this_push_dyn(scr_dyn_undefined());
  ScrDyn *result = scr_dyn_call(progress, &info, 1, "progress");
  scr_dyn_this_pop();
  scr_dyn_release(info);
  if (result == NULL) return false;
  scr_dyn_release(result);
  (void)db;
  return true;
}

/* sqlite.backup(sourceDb, path[, options]): copies the source database into
 * a new file and answers the promise of its page count, as Node's BackupJob
 * does. A settled promise from the synchronous copy (fs/promises' bridge):
 * awaiting sees the same count, and the progress callbacks run before it
 * settles. All arguments are borrowed; +1, or NULL with the exception
 * pending for the validation failures Node throws. */
ScrDyn *scr_sqlite_backup(ScrDyn *source, ScrDyn *path, ScrDyn *options) {
  ScrSqliteDb *db = scr_sqlite_db_of(source);
  if (db == NULL) {
    scr_sqlite_invalid_arg_type("The \"sourceDb\" argument must be an object.");
    return NULL;
  }
  if (db->conn == NULL) {
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  char *destination = scr_sqlite_validate_path(path);
  if (destination == NULL) return NULL;

  int rate = 100;
  const char *source_db = "main";
  const char *dest_db = "main";
  ScrStr *held_source = NULL;
  ScrStr *held_target = NULL;
  ScrDyn *progress = NULL;
  if (!scr_sqlite_is_undefined(options)) {
    if (!scr_sqlite_object_like(options)) {
      free(destination);
      scr_sqlite_invalid_arg_type("The \"options\" argument must be an object.");
      return NULL;
    }
    ScrDyn *rate_value = scr_sqlite_get(options, "rate");
    ScrDyn *source_value = scr_sqlite_get(options, "source");
    ScrDyn *target_value = scr_sqlite_get(options, "target");
    ScrDyn *progress_value = scr_sqlite_get(options, "progress");
    bool ok = false;
    if (rate_value == NULL || source_value == NULL || target_value == NULL ||
        progress_value == NULL)
      goto done;
    if (rate_value->kind != SCR_DYN_UNDEF) {
      if (rate_value->kind != SCR_DYN_NUM || rate_value->v.num != floor(rate_value->v.num) ||
          rate_value->v.num < (double)INT_MIN || rate_value->v.num > (double)INT_MAX) {
        scr_sqlite_invalid_arg_type("The \"options.rate\" argument must be an integer.");
        goto done;
      }
      rate = (int)rate_value->v.num;
      if (rate <= 0) {
        scr_sqlite_out_of_range("The \"options.rate\" argument must be a positive integer.");
        goto done;
      }
    }
    if (source_value->kind != SCR_DYN_UNDEF) {
      if (source_value->kind != SCR_DYN_STR) {
        scr_sqlite_invalid_arg_type("The \"options.source\" argument must be a string.");
        goto done;
      }
      held_source = scr_str_retain(source_value->v.str);
      source_db = held_source->data;
    }
    if (target_value->kind != SCR_DYN_UNDEF) {
      if (target_value->kind != SCR_DYN_STR) {
        scr_sqlite_invalid_arg_type("The \"options.target\" argument must be a string.");
        goto done;
      }
      held_target = scr_str_retain(target_value->v.str);
      dest_db = held_target->data;
    }
    if (progress_value->kind != SCR_DYN_UNDEF) {
      if (progress_value->kind != SCR_DYN_FUNC) {
        scr_sqlite_invalid_arg_type("The \"options.progress\" argument must be a function.");
        goto done;
      }
      progress = scr_dyn_retain(progress_value);
    }
    ok = true;
  done:
    scr_dyn_release(rate_value);
    scr_dyn_release(source_value);
    scr_dyn_release(target_value);
    scr_dyn_release(progress_value);
    if (!ok) {
      scr_dyn_release(progress);
      scr_str_release(held_source);
      scr_str_release(held_target);
      free(destination);
      return NULL;
    }
  }

  ScrSqliteBackup job = {.dest = NULL, .status = SQLITE_OK};
  int r = sqlite3_open_v2(destination, &job.dest,
                          SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, NULL);
  free(destination);
  if (r != SQLITE_OK) {
    /* The message belongs to the destination handle, so copy it before the
     * handle closes. Node rejects the promise (the destination is opened
     * before the work starts), so the error becomes the rejection. */
    int errcode = job.dest != NULL ? sqlite3_extended_errcode(job.dest) : r;
    const char *text = job.dest != NULL ? sqlite3_errmsg(job.dest) : sqlite3_errstr(r);
    ScrStr *message = scr_str_new(text, strlen(text));
    scr_sqlite_backup_close(&job);
    ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    scr_error_set_code(e, "ERR_SQLITE_ERROR");
    ScrStr *errstr = scr_str_new(sqlite3_errstr(errcode), strlen(sqlite3_errstr(errcode)));
    ScrDyn *errstr_dyn = scr_dyn_new_str(errstr);
    scr_str_release(errstr);
    scr_error_set_prop(e, "errcode", 7, scr_dyn_new_num((double)errcode));
    scr_error_set_prop(e, "errstr", 6, errstr_dyn);
    scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
    ScrPromise *promise =
        scr_promise_settled_ref(NULL, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
    scr_dyn_release(progress);
    scr_str_release(held_source);
    scr_str_release(held_target);
    ScrDyn *box = scr_dyn_new_promise(promise);
    scr_promise_release(promise);
    return box;
  }
  sqlite3_backup *copy = sqlite3_backup_init(job.dest, dest_db, db->conn, source_db);
  if (copy == NULL) {
    int errcode = sqlite3_errcode(job.dest);
    scr_sqlite_backup_close(&job);
    scr_sqlite_throw_coded_error(errcode, sqlite3_errstr(errcode));
    ScrPromise *promise = scr_promise_settled_ref(NULL, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
    scr_dyn_release(progress);
    scr_str_release(held_source);
    scr_str_release(held_target);
    ScrDyn *box = scr_dyn_new_promise(promise);
  scr_promise_release(promise);
  return box;
  }

  ScrPromise *promise = NULL;
  for (;;) {
    job.status = sqlite3_backup_step(copy, rate);
    if (!(job.status == SQLITE_OK || job.status == SQLITE_DONE || job.status == SQLITE_BUSY ||
          job.status == SQLITE_LOCKED)) {
      int errcode = job.status;
      sqlite3_backup_finish(copy);
      scr_sqlite_backup_close(&job);
      scr_sqlite_throw_coded_error(errcode, sqlite3_errstr(errcode));
      promise =
          scr_promise_settled_ref(NULL, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
      break;
    }
    int total = sqlite3_backup_pagecount(copy);
    int remaining = sqlite3_backup_remaining(copy);
    if (remaining != 0) {
      if (!scr_sqlite_backup_progress(db, progress, total, remaining)) {
        sqlite3_backup_finish(copy);
        scr_sqlite_backup_close(&job);
        /* The callback's exception is the rejection. */
        promise =
            scr_promise_settled_ref(NULL, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
        break;
      }
      continue;
    }
    if (job.status != SQLITE_DONE) {
      int errcode = sqlite3_errcode(job.dest);
      const char *message = sqlite3_errmsg(job.dest);
      ScrStr *msg = scr_str_new(message, strlen(message));
      sqlite3_backup_finish(copy);
      scr_sqlite_backup_close(&job);
      ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
      scr_str_release(msg);
      scr_error_set_code(e, "ERR_SQLITE_ERROR");
      ScrStr *errstr = scr_str_new(sqlite3_errstr(errcode), strlen(sqlite3_errstr(errcode)));
      ScrDyn *errstr_dyn = scr_dyn_new_str(errstr);
      scr_str_release(errstr);
      scr_error_set_prop(e, "errcode", 7, scr_dyn_new_num((double)errcode));
      scr_error_set_prop(e, "errstr", 6, errstr_dyn);
      scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
      promise =
          scr_promise_settled_ref(NULL, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
      break;
    }
    sqlite3_backup_finish(copy);
    scr_sqlite_backup_close(&job);
    ScrDyn *pages = scr_dyn_new_num((double)total);
    promise = scr_promise_settled_ref(pages, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
    break;
  }
  scr_dyn_release(progress);
  scr_str_release(held_source);
  scr_str_release(held_target);
  ScrDyn *box = scr_dyn_new_promise(promise);
  scr_promise_release(promise);
  return box;
}


/* ── DatabaseSync ───────────────────────────────────────────────────── */

static void *scr_sqlite_db_retain(void *h) {
  ((ScrSqliteDb *)h)->rc++;
  return h;
}

static void scr_sqlite_db_release(void *h) {
  ScrSqliteDb *db = h;
  if (db == NULL || --db->rc > 0) return;
  if (db->conn != NULL) {
    sqlite3_close_v2(db->conn);
    db->conn = NULL;
  }
  scr_str_release(db->path);
  free(db->stmts);
  free(db);
}

/* Node's DatabaseSync::Close body: finalize every live statement, then
 * close the connection. */
static bool scr_sqlite_db_close_all(ScrSqliteDb *db) {
  while (db->stmt_n > 0) {
    ScrSqliteStmt *s = db->stmts[db->stmt_n - 1];
    db->stmts[db->stmt_n - 1] = NULL;
    db->stmt_n--;
    scr_sqlite_stmt_finalize(s);
  }
  if (db->conn != NULL) {
    int r = sqlite3_close_v2(db->conn);
    if (r != SQLITE_OK) {
      scr_sqlite_throw_db_error(db);
      return false;
    }
    db->conn = NULL;
  }
  return true;
}

/* One initial limit from the options bag. */
static bool scr_sqlite_db_read_limits(ScrSqliteDb *db, const ScrDyn *limits) {
  for (size_t i = 0; i < SCR_SQLITE_LIMIT_COUNT; i++) {
    const char *name = scr_sqlite_limit_names[i];
    ScrDyn *value = scr_sqlite_get(limits, name);
    if (value == NULL) return false;
    if (value->kind == SCR_DYN_UNDEF) {
      scr_dyn_release(value);
      continue;
    }
    if (value->kind != SCR_DYN_NUM || value->v.num != floor(value->v.num) ||
        value->v.num < (double)INT_MIN || value->v.num > (double)INT_MAX) {
      char msg[128];
      snprintf(msg, sizeof msg, "The \"options.limits.%s\" argument must be an integer.", name);
      scr_sqlite_invalid_arg_type(msg);
      scr_dyn_release(value);
      return false;
    }
    int limit_value = (int)value->v.num;
    scr_dyn_release(value);
    if (limit_value < 0) {
      char msg[128];
      snprintf(msg, sizeof msg, "The \"options.limits.%s\" argument must be non-negative.", name);
      scr_sqlite_out_of_range(msg);
      return false;
    }
    db->limits[i].value = limit_value;
    db->limits[i].set = true;
  }
  return true;
}

/* DatabaseSync::Open. False with the exception pending. */
static bool scr_sqlite_db_open_connection(ScrSqliteDb *db) {
  if (db->conn != NULL) {
    scr_sqlite_invalid_state("database is already open");
    return false;
  }
  int flags = db->read_only ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
  int r = sqlite3_open_v2(db->path->data, &db->conn, flags | SQLITE_OPEN_URI, NULL);
  if (r != SQLITE_OK) {
    /* A failed open hands back a "sick" handle whose message is still
     * readable; read it before releasing the handle (Node's
     * reset_connection_on_failure). */
    const char *message = db->conn != NULL ? sqlite3_errmsg(db->conn) : sqlite3_errstr(r);
    ScrStr *msg = scr_str_new(message, strlen(message));
    if (db->conn != NULL) {
      sqlite3_close_v2(db->conn);
      db->conn = NULL;
    }
    ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
    scr_str_release(msg);
    scr_error_set_code(e, "ERR_SQLITE_ERROR");
    ScrStr *str = scr_str_new(sqlite3_errstr(r), strlen(sqlite3_errstr(r)));
    ScrDyn *str_dyn = scr_dyn_new_str(str);
    scr_str_release(str);
    scr_error_set_prop(e, "errcode", 7, scr_dyn_new_num((double)r));
    scr_error_set_prop(e, "errstr", 6, str_dyn);
    scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
    return false;
  }
  r = sqlite3_db_config(db->conn, SQLITE_DBCONFIG_DQS_DML, db->dqs ? 1 : 0, NULL);
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(db);
    return false;
  }
  r = sqlite3_db_config(db->conn, SQLITE_DBCONFIG_DQS_DDL, db->dqs ? 1 : 0, NULL);
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(db);
    return false;
  }
  int foreign_keys_enabled = 0;
  r = sqlite3_db_config(db->conn, SQLITE_DBCONFIG_ENABLE_FKEY, db->fkeys ? 1 : 0,
                        &foreign_keys_enabled);
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(db);
    return false;
  }
  int defensive_enabled = 0;
  r = sqlite3_db_config(db->conn, SQLITE_DBCONFIG_DEFENSIVE, db->defensive ? 1 : 0,
                        &defensive_enabled);
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(db);
    return false;
  }
  sqlite3_busy_timeout(db->conn, db->timeout_ms);
  for (size_t i = 0; i < SCR_SQLITE_LIMIT_COUNT; i++) {
    if (db->limits[i].set) sqlite3_limit(db->conn, (int)i, db->limits[i].value);
  }
  if (db->allow_extension) {
    if (sqlite3_db_config(db->conn, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1, NULL) != SQLITE_OK) {
      scr_sqlite_throw_db_error(db);
      return false;
    }
    db->extension_enabled = true;
  }
  return true;
}

/* The database behind a handle box, or NULL. */
static ScrSqliteDb *scr_sqlite_db_of(const ScrDyn *box) {
  return box != NULL && box->kind == SCR_DYN_HANDLE && box->v.handle.tag == SCR_DYNH_SQLITE_DB
             ? box->v.handle.ptr
             : NULL;
}

/* Tracks a freshly created statement on its database. */
static void scr_sqlite_db_track(ScrSqliteDb *db, ScrSqliteStmt *s) {
  if (db->stmt_n == db->stmt_cap) {
    size_t cap = db->stmt_cap != 0 ? db->stmt_cap * 2 : 8;
    void *grown = realloc(db->stmts, cap * sizeof *db->stmts);
    if (grown == NULL) scr_sqlite_oom();
    db->stmts = grown;
    db->stmt_cap = cap;
  }
  db->stmts[db->stmt_n++] = s;
}

/* Prepares `sql` with the prepare options (Node's DatabaseSync::Prepare). */
static ScrDyn *scr_sqlite_db_prepare(ScrSqliteDb *db, const ScrDyn *sql, const ScrDyn *options) {
  ScrDyn *return_arrays = NULL;
  ScrDyn *big_ints = NULL;
  ScrDyn *bare = NULL;
  ScrDyn *unknown = NULL;
  if (options != NULL && !scr_sqlite_is_undefined(options)) {
    return_arrays = scr_sqlite_get(options, "returnArrays");
    big_ints = scr_sqlite_get(options, "readBigInts");
    bare = scr_sqlite_get(options, "allowBareNamedParameters");
    unknown = scr_sqlite_get(options, "allowUnknownNamedParameters");
    const struct {
      const ScrDyn *value;
      const char *label;
    } checks[] = {
        {return_arrays, "returnArrays"},
        {big_ints, "readBigInts"},
        {bare, "allowBareNamedParameters"},
        {unknown, "allowUnknownNamedParameters"},
    };
    for (size_t i = 0; i < sizeof checks / sizeof checks[0]; i++) {
      if (checks[i].value != NULL && checks[i].value->kind != SCR_DYN_UNDEF &&
          checks[i].value->kind != SCR_DYN_BOOL) {
        char msg[128];
        snprintf(msg, sizeof msg, "The \"options.%s\" argument must be a boolean.",
                 checks[i].label);
        scr_sqlite_invalid_arg_type(msg);
        scr_dyn_release(return_arrays);
        scr_dyn_release(big_ints);
        scr_dyn_release(bare);
        scr_dyn_release(unknown);
        return NULL;
      }
    }
  }

  sqlite3_stmt *stmt = NULL;
  int r = sqlite3_prepare_v2(db->conn, sql->v.str->data, -1, &stmt, NULL);
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(db);
    return NULL;
  }
  if (stmt == NULL) {
    scr_sqlite_invalid_arg_value("The SQL query contains no statements.");
    return NULL;
  }
  ScrSqliteStmt *s = scr_sqlite_stmt_alloc(db, stmt);
  scr_sqlite_db_track(db, s);
  if (return_arrays != NULL && return_arrays->kind == SCR_DYN_BOOL)
    s->return_arrays = return_arrays->v.b;
  if (big_ints != NULL && big_ints->kind == SCR_DYN_BOOL) s->big_ints = big_ints->v.b;
  if (bare != NULL && bare->kind == SCR_DYN_BOOL) s->allow_bare = bare->v.b;
  if (unknown != NULL && unknown->kind == SCR_DYN_BOOL) s->allow_unknown = unknown->v.b;
  scr_dyn_release(return_arrays);
  scr_dyn_release(big_ints);
  scr_dyn_release(bare);
  scr_dyn_release(unknown);
  scr_dyn_handle_install(SCR_DYNH_SQLITE_STATEMENT, &scr_sqlite_stmt_ops);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_SQLITE_STATEMENT);
  scr_sqlite_stmt_release(s);
  return out;
}

static ScrDyn *scr_sqlite_db_invoke(void *h, ScrDyn *self, const char *method,
                                    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrSqliteDb *db = h;

  if (strcmp(method, "close") == 0) {
    if (db->conn == NULL) {
      scr_sqlite_invalid_state("database is not open");
      return NULL;
    }
    if (db->callback_depth > 0) {
      scr_sqlite_invalid_state("database cannot be closed while in a callback");
      return NULL;
    }
    if (!scr_sqlite_db_close_all(db)) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "open") == 0) {
    if (!scr_sqlite_db_open_connection(db)) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (db->conn == NULL) {
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  if (db->callback_depth > 0 && strcmp(method, "location") != 0) {
    scr_sqlite_invalid_state("database cannot be accessed from an authorizer callback");
    return NULL;
  }

  if (strcmp(method, "exec") == 0) {
    const ScrDyn *sql = scr_sqlite_arg(args, argc, 0);
    if (sql->kind != SCR_DYN_STR) {
      scr_sqlite_invalid_arg_type("The \"sql\" argument must be a string.");
      return NULL;
    }
    int r = sqlite3_exec(db->conn, sql->v.str->data, NULL, NULL, NULL);
    if (r != SQLITE_OK) {
      scr_sqlite_throw_db_error(db);
      return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "prepare") == 0) {
    const ScrDyn *sql = scr_sqlite_arg(args, argc, 0);
    if (sql->kind != SCR_DYN_STR) {
      scr_sqlite_invalid_arg_type("The \"sql\" argument must be a string.");
      return NULL;
    }
    const ScrDyn *options = scr_sqlite_arg(args, argc, 1);
    if (!scr_sqlite_is_undefined(options) && !scr_sqlite_object_like(options)) {
      scr_sqlite_invalid_arg_type("The \"options\" argument must be an object.");
      return NULL;
    }
    return scr_sqlite_db_prepare(db, sql, options);
  }

  if (strcmp(method, "location") == 0) {
    const ScrDyn *name = scr_sqlite_arg(args, argc, 0);
    const char *db_name = "main";
    if (!scr_sqlite_is_undefined(name)) {
      if (name->kind != SCR_DYN_STR) {
        scr_sqlite_invalid_arg_type("The \"dbName\" argument must be a string.");
        return NULL;
      }
      db_name = name->v.str->data;
    }
    const char *filename = sqlite3_db_filename(db->conn, db_name);
    if (filename == NULL || filename[0] == '\0') return scr_dyn_new_null();
    return scr_sqlite_str_dyn(filename);
  }

  if (strcmp(method, "enableDefensive") == 0) {
    const ScrDyn *active = scr_sqlite_arg(args, argc, 0);
    if (active->kind != SCR_DYN_BOOL) {
      scr_sqlite_invalid_arg_type("The \"active\" argument must be a boolean.");
      return NULL;
    }
    int defensive_enabled = 0;
    if (sqlite3_db_config(db->conn, SQLITE_DBCONFIG_DEFENSIVE, active->v.b ? 1 : 0,
                          &defensive_enabled) != SQLITE_OK) {
      scr_sqlite_throw_db_error(db);
      return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "function") == 0 || strcmp(method, "aggregate") == 0 ||
      strcmp(method, "createSession") == 0 || strcmp(method, "applyChangeset") == 0 ||
      strcmp(method, "enableLoadExtension") == 0 || strcmp(method, "loadExtension") == 0 ||
      strcmp(method, "setAuthorizer") == 0 || strcmp(method, "createTagStore") == 0 ||
      strcmp(method, "serialize") == 0 || strcmp(method, "deserialize") == 0) {
    scr_sqlite_not_supported("DatabaseSync", method);
    return NULL;
  }
  scr_sqlite_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_sqlite_db_get(void *h, const char *key, size_t len) {
  ScrSqliteDb *db = h;
  if (len == 6 && memcmp(key, "isOpen", 6) == 0) return scr_dyn_new_bool(db->conn != NULL);
  if (len == 13 && memcmp(key, "isTransaction", 13) == 0) {
    if (db->conn == NULL) {
      scr_sqlite_invalid_state("database is not open");
      return NULL;
    }
    return scr_dyn_new_bool(sqlite3_get_autocommit(db->conn) == 0);
  }
  if (len == 6 && memcmp(key, "limits", 6) == 0) {
    ScrSqliteLimits *l = calloc(1, sizeof *l);
    if (l == NULL) scr_sqlite_oom();
    l->rc = 1;
    l->db = scr_sqlite_db_retain(db);
    scr_dyn_handle_install(SCR_DYNH_SQLITE_LIMITS, &scr_sqlite_limits_ops);
    ScrDyn *box = scr_dyn_new_handle(l, SCR_DYNH_SQLITE_LIMITS);
    scr_sqlite_limits_release(l);
    return box;
  }
  return NULL;
}

static ScrDyn *scr_sqlite_db_dispose_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  (void)args;
  (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrSqliteDb *db = scr_sqlite_db_of(self);
  ScrDyn *out = NULL;
  if (db != NULL) {
    /* Node's Dispose swallows the errors of an already closed database. */
    if (db->conn != NULL && db->callback_depth == 0) scr_sqlite_db_close_all(db);
    else if (db->conn != NULL) {
      scr_sqlite_invalid_state("database cannot be closed while in a callback");
    }
    if (!scr_exc_pending()) out = scr_dyn_retain(scr_dyn_undefined());
  } else {
    scr_sqlite_not_a_function("[Symbol.dispose]");
  }
  scr_dyn_release(self);
  return out;
}

static ScrDyn *scr_sqlite_db_symbol_get(void *h, const ScrDyn *key) {
  (void)h;
  if (!scr_dyn_is_dispose_symbol(key)) return NULL;
  ScrClosure *clo = scr_closure_new(NULL, 0);
  return scr_dyn_new_func(clo, scr_sqlite_db_dispose_call, 0, "", "[Symbol.dispose]");
}

static ScrDyn *scr_sqlite_db_inspect_view(void *h) {
  (void)h;
  return scr_dyn_new_obj_null_proto();
}

static const ScrDynHandleMethod scr_sqlite_db_methods[] = {
    {"open", 0, false, NULL, NULL},
    {"close", 0, false, NULL, NULL},
    {"prepare", 0, false, NULL, NULL},
    {"exec", 0, false, NULL, NULL},
    {"location", 0, false, NULL, NULL},
    {"enableDefensive", 0, false, NULL, NULL},
    /* Node's other members: real, and refused by name until they land. */
    {"function", 0, false, NULL, NULL},
    {"aggregate", 0, false, NULL, NULL},
    {"createSession", 0, false, NULL, NULL},
    {"applyChangeset", 0, false, NULL, NULL},
    {"enableLoadExtension", 0, false, NULL, NULL},
    {"loadExtension", 0, false, NULL, NULL},
    {"setAuthorizer", 0, false, NULL, NULL},
    {"createTagStore", 0, false, NULL, NULL},
    {"serialize", 0, false, NULL, NULL},
    {"deserialize", 0, false, NULL, NULL},
    {NULL, 0, false, NULL, NULL},
};

static const ScrDynHandleOps scr_sqlite_db_ops = {
    .cls = "DatabaseSync",
    .retain = scr_sqlite_db_retain,
    .release = scr_sqlite_db_release,
    .invoke = scr_sqlite_db_invoke,
    .get = scr_sqlite_db_get,
    .inspect_view = scr_sqlite_db_inspect_view,
    .inspect_view_empty = true,
    .symbol_get = scr_sqlite_db_symbol_get,
    .json_empty_object = true,
    .methods = scr_sqlite_db_methods,
};

/* ── entry points ───────────────────────────────────────────────────── */

/* Node's ValidateDatabasePath: a string, a Uint8Array, or a file: URL, none
 * with a NUL byte. Answers the validated bytes as a malloc'd NUL-terminated
 * string (caller frees), or NULL with the error pending. */
static char *scr_sqlite_validate_path(const ScrDyn *path) {
  const char *bytes = NULL;
  size_t len = 0;
  if (path->kind == SCR_DYN_STR) {
    bytes = path->v.str->data;
    len = path->v.str->len;
  } else if (path->kind == SCR_DYN_BYTES) {
    const ScrBytes *b = path->v.bytes;
    bytes = (const char *)b->data;
    len = b->len * scr_bytes_elem_size(b->elem);
  } else if (path->kind == SCR_DYN_HANDLE && path->v.handle.tag == SCR_DYNH_URL) {
    ScrStr *href = scr_url_href(path->v.handle.ptr);
    char *result = NULL;
    if (href != NULL && memchr(href->data, 0, href->len) == NULL) {
      if (!(href->len >= 5 && memcmp(href->data, "file:", 5) == 0)) {
        scr_throw_error_msg_code(SCR_ERR_TYPE, "The URL must be of scheme file", 32,
                                 "ERR_INVALID_URL_SCHEME");
      } else {
        result = malloc(href->len + 1);
        if (result == NULL) scr_sqlite_oom();
        memcpy(result, href->data, href->len);
        result[href->len] = 0;
      }
    }
    if (href != NULL) scr_str_release(href);
    if (result != NULL || scr_exc_pending()) return result;
    scr_sqlite_invalid_arg_type(
        "The \"path\" argument must be a string, Uint8Array, or URL without null bytes.");
    return NULL;
  } else {
    scr_sqlite_invalid_arg_type(
        "The \"path\" argument must be a string, Uint8Array, or URL without null bytes.");
    return NULL;
  }
  if (memchr(bytes, 0, len) != NULL) {
    scr_sqlite_invalid_arg_type(
        "The \"path\" argument must be a string, Uint8Array, or URL without null bytes.");
    return NULL;
  }
  char *result = malloc(len + 1);
  if (result == NULL) scr_sqlite_oom();
  if (len != 0) memcpy(result, bytes, len);
  result[len] = 0;
  return result;
}

ScrDyn *scr_sqlite_db_new(ScrDyn *path, ScrDyn *options) {
  char *location = scr_sqlite_validate_path(path);
  if (location == NULL) return NULL;

  ScrSqliteDb *db = calloc(1, sizeof *db);
  if (db == NULL) scr_sqlite_oom();
  db->rc = 1;
  db->path = scr_str_new(location, strlen(location));
  free(location);
  db->open_option = true;
  db->fkeys = true;
  db->allow_bare = true;
  db->defensive = true;

#define SCR_SQLITE_DB_FAIL()         \
  do {                               \
    scr_str_release(db->path);       \
    free(db->stmts);                 \
    free(db);                        \
    return NULL;                     \
  } while (0)

  if (!scr_sqlite_is_undefined(options)) {
    if (!scr_sqlite_object_like(options)) {
      scr_sqlite_invalid_arg_type("The \"options\" argument must be an object.");
      SCR_SQLITE_DB_FAIL();
    }
#define SCR_SQLITE_OPTION(field, key, label)                                                 \
  do {                                                                                       \
    bool value_ = field;                                                                     \
    if (!scr_sqlite_option_bool(options, key, sizeof(key) - 1, &value_)) {                    \
      scr_sqlite_invalid_arg_type("The \"options." label "\" argument must be a boolean.");   \
      SCR_SQLITE_DB_FAIL();                                                                  \
    }                                                                                        \
    field = value_;                                                                          \
  } while (0)
    SCR_SQLITE_OPTION(db->open_option, "open", "open");
    SCR_SQLITE_OPTION(db->read_only, "readOnly", "readOnly");
    SCR_SQLITE_OPTION(db->fkeys, "enableForeignKeyConstraints", "enableForeignKeyConstraints");
    SCR_SQLITE_OPTION(db->dqs, "enableDoubleQuotedStringLiterals",
                      "enableDoubleQuotedStringLiterals");
    SCR_SQLITE_OPTION(db->allow_extension, "allowExtension", "allowExtension");
    SCR_SQLITE_OPTION(db->big_ints, "readBigInts", "readBigInts");
    SCR_SQLITE_OPTION(db->return_arrays, "returnArrays", "returnArrays");
    SCR_SQLITE_OPTION(db->allow_bare, "allowBareNamedParameters", "allowBareNamedParameters");
    SCR_SQLITE_OPTION(db->allow_unknown, "allowUnknownNamedParameters",
                      "allowUnknownNamedParameters");
    SCR_SQLITE_OPTION(db->defensive, "defensive", "defensive");
#undef SCR_SQLITE_OPTION
    ScrDyn *timeout = scr_sqlite_get(options, "timeout");
    if (timeout == NULL) SCR_SQLITE_DB_FAIL();
    if (timeout->kind != SCR_DYN_UNDEF) {
      if (timeout->kind != SCR_DYN_NUM || timeout->v.num != floor(timeout->v.num) ||
          timeout->v.num < (double)INT_MIN || timeout->v.num > (double)INT_MAX) {
        scr_dyn_release(timeout);
        scr_sqlite_invalid_arg_type("The \"options.timeout\" argument must be an integer.");
        SCR_SQLITE_DB_FAIL();
      }
      db->timeout_ms = (int)timeout->v.num;
    }
    scr_dyn_release(timeout);
    ScrDyn *limits = scr_sqlite_get(options, "limits");
    if (limits == NULL) SCR_SQLITE_DB_FAIL();
    if (limits->kind != SCR_DYN_UNDEF) {
      if (!scr_sqlite_object_like(limits)) {
        scr_dyn_release(limits);
        scr_sqlite_invalid_arg_type("The \"options.limits\" argument must be an object.");
        SCR_SQLITE_DB_FAIL();
      }
      if (!scr_sqlite_db_read_limits(db, limits)) {
        scr_dyn_release(limits);
        SCR_SQLITE_DB_FAIL();
      }
    }
    scr_dyn_release(limits);
  }
#undef SCR_SQLITE_DB_FAIL

  if (db->open_option && !scr_sqlite_db_open_connection(db)) {
    scr_str_release(db->path);
    free(db->stmts);
    free(db);
    return NULL;
  }

  scr_dyn_handle_install(SCR_DYNH_SQLITE_DB, &scr_sqlite_db_ops);
  ScrDyn *result = scr_dyn_new_handle(db, SCR_DYNH_SQLITE_DB);
  scr_sqlite_db_release(db);
  return result;
}

bool scr_sqlite_is(const ScrDyn *value, double kind) {
  if (value == NULL || value->kind != SCR_DYN_HANDLE) return false;
  ScrDynHandleTag want = kind == 0 ? SCR_DYNH_SQLITE_DB
                        : kind == 1 ? SCR_DYNH_SQLITE_STATEMENT
                                    : SCR_DYNH_SQLITE_ITERATOR;
  return value->v.handle.tag == want;
}
