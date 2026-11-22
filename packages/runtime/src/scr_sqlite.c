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

/* The amalgamation is built with these two extensions (see sqliteInputs):
 * they must be visible here too, or sqlite3.h withholds the changeset and
 * preupdate declarations the engine exports. */
#ifndef SQLITE_ENABLE_SESSION
#define SQLITE_ENABLE_SESSION 1
#endif
#ifndef SQLITE_ENABLE_PREUPDATE_HOOK
#define SQLITE_ENABLE_PREUPDATE_HOOK 1
#endif
#include "sqlite3.h"

typedef struct ScrSqliteDb ScrSqliteDb;
typedef struct ScrSqliteStmt ScrSqliteStmt;
typedef struct ScrSqliteLimits ScrSqliteLimits;
typedef struct ScrSqliteIter ScrSqliteIter;
typedef struct ScrSqliteSession ScrSqliteSession;
typedef struct ScrSqliteTagStore ScrSqliteTagStore;

/* Cycle collection: the database, its statements, sessions, tag stores and
 * limits object are nodes of the collector's graph (their first member is
 * `rc`, as every heap object it owns), so a property added to an object
 * that refers back to it -- a cached tag store, a closure, metadata -- is
 * reclaimed instead of keeping the group alive. Each trace visits exactly
 * the strong references to other collector nodes, and the teardown of a
 * freed node releases those same children; the collector's own free
 * releases only what is not traced. */
static void scr_sqlite_db_trace(void *p, ScrTraceVisit visit, void *ctx);
static void scr_sqlite_db_gcfree(void *p);
static void scr_sqlite_stmt_trace(void *p, ScrTraceVisit visit, void *ctx);
static void scr_sqlite_stmt_gcfree(void *p);
static void scr_sqlite_limits_trace(void *p, ScrTraceVisit visit, void *ctx);
static void scr_sqlite_limits_gcfree(void *p);
static void scr_sqlite_tag_trace(void *p, ScrTraceVisit visit, void *ctx);
static void scr_sqlite_tag_gcfree(void *p);
static void scr_sqlite_session_trace(void *p, ScrTraceVisit visit, void *ctx);
static void scr_sqlite_session_gcfree(void *p);
static ScrCycType scr_sqlite_db_cyc = {scr_sqlite_db_trace, scr_sqlite_db_gcfree, SCR_CYC_KIND_NONE, 0};
static ScrCycType scr_sqlite_stmt_cyc = {scr_sqlite_stmt_trace, scr_sqlite_stmt_gcfree, SCR_CYC_KIND_NONE, 0};
static ScrCycType scr_sqlite_limits_cyc = {scr_sqlite_limits_trace, scr_sqlite_limits_gcfree, SCR_CYC_KIND_NONE, 0};
static ScrCycType scr_sqlite_tag_cyc = {scr_sqlite_tag_trace, scr_sqlite_tag_gcfree, SCR_CYC_KIND_NONE, 0};
static ScrCycType scr_sqlite_session_cyc = {scr_sqlite_session_trace, scr_sqlite_session_gcfree, SCR_CYC_KIND_NONE, 0};

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
  /* Properties JavaScript added to the statement object: Node's
   * StatementSync is an ordinary object, so a write that names no member
   * lands here. NULL until the first one. */
  ScrDyn *expandos;
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
  /* The JavaScript authorizer, owned, or NULL (Node's kAuthorizerCallback). */
  ScrDyn *authorizer;
  /* Live sessions: raw, non-owning (a session owns a reference to its
   * database). */
  ScrSqliteSession **sessions;
  size_t session_n, session_cap;
  bool ignore_next_error;
  /* The limits object Node hands out for this database, owned: every read
   * of `database.limits` answers it, so properties JavaScript added to it
   * survive while the database lives. Its release clears the object's
   * borrowed database pointer, like the weak pointer Node's limits hold. */
  ScrSqliteLimits *limits_object;
  /* Properties JavaScript added to the database object, owned, NULL until
   * the first one (Node's DatabaseSync is an ordinary object). */
  ScrDyn *expandos;
};

struct ScrSqliteLimits {
  size_t rc;
  ScrSqliteDb *db; /* borrowed: the database owns this object and clears this when it goes */
  /* JavaScript-added properties: Node's limits object is an ordinary
   * object, so a write that names no limit lands here. NULL until the
   * first one. */
  ScrDyn *expandos;
};

struct ScrSqliteIter {
  size_t rc;
  ScrSqliteStmt *stmt; /* owned; NULL once done */
  bool done;
  unsigned generation;
};
/* The closed-database stand-in a finalized statement's database reference
 * becomes when its database closes: every field is the closed state (no
 * connection, no properties, no callbacks), and the immortal reference count
 * keeps a release a no-op, so a statement that a program still holds cannot
 * keep its database alive or reach a freed one. */
static ScrSqliteDb scr_sqlite_closed_db = {.rc = SIZE_MAX, .conn = NULL};

/* A changeset session (Node's Session): the SQLite session and the database
 * it observes. */
typedef struct ScrSqliteSession {
  size_t rc;
  ScrSqliteDb *db; /* owned */
  sqlite3_session *session; /* NULL once closed */
  bool generating;
} ScrSqliteSession;

/* One registered user-defined function or aggregate (Node's
 * UserDefinedFunction and CustomAggregate): the JavaScript callables and the
 * connection stay alive until SQLite destroys the registration. */
typedef struct ScrSqliteFunc {
  ScrSqliteDb *db; /* borrowed: the connection owns the registration, which
                    * dies with the connection (Node's weak BaseObjectPtr) */
  ScrDyn *fn; /* owned; the step function, or a plain function's body */
  ScrDyn *start; /* aggregates: the start value or function, owned */
  ScrDyn *inverse; /* owned, or NULL */
  ScrDyn *result; /* owned, or NULL */
  bool big_args;
  bool aggregate;
  char *name; /* owned; the function's SQL name */
} ScrSqliteFunc;

/* The bytes of a binary value Node treats as a BLOB (a view's elements, or
 * an ArrayBuffer's whole storage). */
static bool scr_sqlite_binary_bytes(const ScrDyn *value, const void **data, size_t *len);
static void scr_sqlite_db_track(ScrSqliteDb *db, ScrSqliteStmt *s);
static ScrDyn *scr_sqlite_db_box(ScrSqliteDb *db);

/* Each class's own properties, in Node's order (the accessor names, then
 * the properties JavaScript added), and the hooks reflection reads them
 * through. Implemented once the getters above exist, below their class. */
static ScrDyn *scr_sqlite_stmt_own_names(void *h);
static ScrDyn *scr_sqlite_stmt_own_enum_names(void *h);
static ScrDyn *scr_sqlite_stmt_own_view(void *h);
static ScrDyn *scr_sqlite_stmt_inspect_view(void *h);
static bool scr_sqlite_stmt_define_own(void *h, const char *key, size_t key_len, ScrDyn *descriptor);
static ScrDyn *scr_sqlite_stmt_own_descriptor(void *h, const char *key, size_t key_len);
static bool scr_sqlite_stmt_own_set(void *h, const char *key, size_t key_len, const ScrDyn *value);
static bool scr_sqlite_stmt_own_delete(void *h, const char *key, size_t key_len);
static ScrDyn *scr_sqlite_tag_own_names(void *h);
static ScrDyn *scr_sqlite_tag_own_enum_names(void *h);
static ScrDyn *scr_sqlite_tag_own_view(void *h);
static ScrDyn *scr_sqlite_tag_inspect_view(void *h);
static bool scr_sqlite_tag_define_own(void *h, const char *key, size_t key_len, ScrDyn *descriptor);
static ScrDyn *scr_sqlite_tag_own_descriptor(void *h, const char *key, size_t key_len);
static bool scr_sqlite_tag_own_set(void *h, const char *key, size_t key_len, const ScrDyn *value);
static bool scr_sqlite_tag_own_delete(void *h, const char *key, size_t key_len);
static ScrDyn *scr_sqlite_db_own_names(void *h);
static ScrDyn *scr_sqlite_db_own_enum_names(void *h);
static ScrDyn *scr_sqlite_db_own_view(void *h);
static ScrDyn *scr_sqlite_db_inspect_view(void *h);
static bool scr_sqlite_db_define_own(void *h, const char *key, size_t key_len, ScrDyn *descriptor);
static ScrDyn *scr_sqlite_db_own_descriptor(void *h, const char *key, size_t key_len);
static bool scr_sqlite_db_own_set(void *h, const char *key, size_t key_len, const ScrDyn *value);
static bool scr_sqlite_db_own_delete(void *h, const char *key, size_t key_len);
static ScrDyn *scr_sqlite_db_own_symbols(void *h);
/* Symbol.for("sqlite-type"), the brand DatabaseSync carries. */
static ScrSym *scr_sqlite_type_symbol_of(void);
/* An added property read as an ordinary object read (getters run with the
 * handle as `this`), +1 or NULL when the table has no such property. */
static ScrDyn *scr_sqlite_table_read(const ScrDyn *table, const char *key, size_t len, void *h,
                                     ScrDynHandleTag tag);
static bool scr_sqlite_table_prop(const ScrDyn *table, const char *key, size_t len,
                                  ScrDynProp *out);
static bool scr_sqlite_table_write(ScrDyn **expandos, const char *cls, void *h, ScrDynHandleTag tag,
                                   const char *key, size_t len, const ScrDyn *value);
static bool scr_sqlite_define_own(const char *const *names, size_t count, ScrDynHandleTag tag,
                                  void *h, ScrDyn **expandos, const char *key, size_t len,
                                  ScrDyn *descriptor);
static void scr_sqlite_inspect_expandos(ScrDyn *view, const ScrDyn *expandos, ScrDynHandleTag tag,
                                        void *h);
static void scr_sqlite_add_expandos(ScrDyn *view, const ScrDyn *expandos, void *h,
                                    ScrDynHandleTag tag);
/* An added property shadows a class method: true when `method` names one
 * (its call, or V8's "not a function" TypeError, is in `out`). */
static bool scr_sqlite_own_method_call(ScrDyn *expandos, void *h, ScrDynHandleTag tag,
                                       const char *method, ScrDyn *self,
                                       ScrDyn *const *args, size_t argc, const char *what,
                                       ScrDyn **out);

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

/* ERR_SQLITE_ERROR for a result code (Node's THROW_ERR_SQLITE_ERROR(isolate,
 * errcode)): the code's own text and the code, without errstr. */
static void scr_sqlite_throw_result_error(int errcode) {
  const char *text = sqlite3_errstr(errcode);
  if (text == NULL) text = "";
  ScrStr *msg = scr_str_new(text, strlen(text));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, "ERR_SQLITE_ERROR");
  scr_error_set_prop(e, "errcode", 7, scr_dyn_new_num((double)errcode));
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

/* One bound SQLite value as a JavaScript value (Node's SQLITE_VALUE_TO_JS
 * over a sqlite3_value): +1, or NULL with the exception pending. */
static ScrDyn *scr_sqlite_value_dyn(sqlite3_value *value, bool big_ints) {
  switch (sqlite3_value_type(value)) {
  case SQLITE_INTEGER: {
    sqlite3_int64 number = sqlite3_value_int64(value);
    if (big_ints) {
      ScrBigInt *big = scr_bigint_from_i64((int64_t)number);
      ScrDyn *d = scr_dyn_new_bigint(big);
      scr_bigint_release(big);
      return d;
    }
    if ((double)number >= -SCR_SQLITE_MAX_SAFE && (double)number <= SCR_SQLITE_MAX_SAFE)
      return scr_dyn_new_num((double)number);
    char msg[128];
    snprintf(msg, sizeof msg,
             "Value is too large to be represented as a JavaScript number: %lld",
             (long long)number);
    scr_sqlite_out_of_range(msg);
    return NULL;
  }
  case SQLITE_FLOAT:
    return scr_dyn_new_num(sqlite3_value_double(value));
  case SQLITE_TEXT: {
    const unsigned char *text = sqlite3_value_text(value);
    if (text == NULL) {
      scr_throw_error_msg_code(SCR_ERR_ERROR, "Memory allocation failed", 22,
                               "ERR_MEMORY_ALLOCATION_FAILED");
      return NULL;
    }
    int len = sqlite3_value_bytes(value);
    ScrStr *s = scr_str_from_utf8_lossy((const uint8_t *)text, (size_t)len);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  case SQLITE_NULL:
    return scr_dyn_new_null();
  case SQLITE_BLOB: {
    int size = sqlite3_value_bytes(value);
    const void *data = sqlite3_value_blob(value);
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

/* A JavaScript value a user function answered, as SQLite's result (Node's
 * JSValueToSQLiteResult). Borrows `value`. */
static void scr_sqlite_dyn_result(sqlite3_context *ctx, const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_NULL:
  case SCR_DYN_UNDEF:
    sqlite3_result_null(ctx);
    return;
  case SCR_DYN_NUM:
    sqlite3_result_double(ctx, value->v.num);
    return;
  case SCR_DYN_STR:
    sqlite3_result_text(ctx, value->v.str->data, (int)value->v.str->len, SQLITE_TRANSIENT);
    return;
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE: {
    const void *data = NULL;
    size_t length = 0;
    if (scr_sqlite_binary_bytes(value, &data, &length)) {
      sqlite3_result_blob(ctx, data, (int)length, SQLITE_TRANSIENT);
      return;
    }
    break;
  }
  case SCR_DYN_BIGINT:
    if (!scr_bigint_i64_fits(value->v.bigint)) {
      sqlite3_result_error(ctx, "BigInt value is too large for SQLite", -1);
      return;
    }
    sqlite3_result_int64(ctx, (sqlite3_int64)scr_bigint_to_i64(value->v.bigint));
    return;
  case SCR_DYN_PROMISE:
    sqlite3_result_error(ctx, "Asynchronous user-defined functions are not supported", -1);
    return;
  default:
    sqlite3_result_error(ctx, "Returned JavaScript value cannot be converted to a SQLite value",
                         -1);
    return;
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
static void scr_sqlite_stmt_release(void *h);

static ScrSqliteStmt *scr_sqlite_stmt_alloc(ScrSqliteDb *db, sqlite3_stmt *stmt) {
  ScrSqliteStmt *s = scr_cyc_alloc(sizeof *s, &scr_sqlite_stmt_cyc);
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
static void scr_sqlite_db_detach(ScrSqliteDb *db, ScrSqliteStmt *s) {
  for (size_t i = 0; i < db->stmt_n; i++) {
    if (db->stmts[i] == s) {
      db->stmts[i] = db->stmts[db->stmt_n - 1];
      db->stmt_n--;
      return;
    }
  }
}

/* Drops the database's reference to a live statement it tracked. */
static void scr_sqlite_db_untrack(ScrSqliteDb *db, ScrSqliteStmt *s) {
  size_t before = db->stmt_n;
  scr_sqlite_db_detach(db, s);
  if (db->stmt_n != before) scr_sqlite_stmt_release(s);
}

/* The collector's teardown of a statement: no traced child is released
 * (the collector accounts for them, and a neighbour may already be freed),
 * so the database is only detached from its list by the database itself. */
static void scr_sqlite_stmt_gcfree(void *p) {
  ScrSqliteStmt *s = p;
  if (s->stmt != NULL) sqlite3_finalize(s->stmt);
  s->stmt = NULL;
  scr_sqlite_stmt_clear_bare(s);
  scr_cyc_free(s);
}

/* A statement freed without collection: release its children, then the
 * block. The database keeps a reference to every live statement, so a
 * tracked statement cannot reach this point; the detach is defensive. */
static void scr_sqlite_stmt_destroy(ScrSqliteStmt *s) {
  ScrSqliteDb *db = s->db;
  if (s->stmt != NULL) {
    scr_sqlite_db_untrack(db, s);
    scr_sqlite_stmt_finalize(s);
  }
  scr_dyn_release(s->expandos);
  s->expandos = NULL;
  if (db != &scr_sqlite_closed_db) scr_sqlite_db_release(db);
  scr_sqlite_stmt_gcfree(s);
}

static void scr_sqlite_stmt_release(void *h) {
  ScrSqliteStmt *s = h;
  if (s == NULL) return;
  if (--s->rc > 0) {
    scr_cyc_released(s);
    return;
  }
  scr_cyc_dead(s);
  scr_rc_destroy(s, (void (*)(void *))scr_sqlite_stmt_destroy);
}

static void scr_sqlite_stmt_trace(void *p, ScrTraceVisit visit, void *ctx) {
  ScrSqliteStmt *s = p;
  if (s->db != &scr_sqlite_closed_db) visit(s->db, ctx);
  visit(s->expandos, ctx);
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

/* The statement iterator and a session carry no own properties, but
 * reflection asks the class for them: Node answers an empty key list and an
 * empty descriptor map (and serializes them as {}). */
static ScrDyn *scr_sqlite_no_own_names(void *h) {
  (void)h;
  return scr_dyn_new_arr();
}

static ScrDyn *scr_sqlite_no_own_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

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
    .inspect_view = scr_sqlite_no_own_view,
    .inspect_view_empty = true,
    .own_names = scr_sqlite_no_own_names,
    .own_view = scr_sqlite_no_own_view,
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

/* StatementSync.run's body: step once, reset, answer {changes,
 * lastInsertRowid} (bigint counters with readBigInts). Borrows the
 * statement, +1, or NULL with the exception pending. */
static ScrDyn *scr_sqlite_stmt_run_result(ScrSqliteStmt *s) {
  sqlite3_step(s->stmt);
  if (sqlite3_reset(s->stmt) != SQLITE_OK) {
    scr_sqlite_throw_db_error(s->db);
    return NULL;
  }
  sqlite3_int64 last_rowid = sqlite3_last_insert_rowid(s->db->conn);
  sqlite3_int64 changes = sqlite3_changes64(s->db->conn);
  /* Node's run result is a dictionary-template instance over the ordinary
   * object prototype (unlike its row and column objects). */
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

/* StatementSync.all's body: every row, reset, checking the final status.
 * Borrows the statement, +1, or NULL with the exception pending. */
static ScrDyn *scr_sqlite_stmt_all_result(ScrSqliteStmt *s) {
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

static ScrDyn *scr_sqlite_stmt_invoke(void *h, ScrDyn *self, const char *method,
                                      ScrDyn *const *args, size_t argc, const char *what) {
  ScrSqliteStmt *s = h;
  ScrDyn *own = NULL;
  if (scr_sqlite_own_method_call(s->expandos, h, SCR_DYNH_SQLITE_STATEMENT, method, self, args,
                                 argc, what, &own))
    return own;

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

  if (strcmp(method, "run") == 0) return scr_sqlite_stmt_run_result(s);

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

  if (strcmp(method, "all") == 0) return scr_sqlite_stmt_all_result(s);

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
  /* A property JavaScript added to the statement object. */
  return scr_sqlite_table_read(s->expandos, key, len, s, SCR_DYNH_SQLITE_STATEMENT);
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
    .set = scr_sqlite_stmt_own_set,
    .inspect_view = scr_sqlite_stmt_inspect_view,
    .symbol_get = scr_sqlite_stmt_symbol_get,
    .json_empty_object = true,
    .methods = scr_sqlite_stmt_methods,
    .own_names = scr_sqlite_stmt_own_names,
    .own_view = scr_sqlite_stmt_own_view,
    .own_descriptor = scr_sqlite_stmt_own_descriptor,
    .delete_key = scr_sqlite_stmt_own_delete,
    .own_enumerable_names = scr_sqlite_stmt_own_enum_names,
    .define_own = scr_sqlite_stmt_define_own,
    .inspect_bracketed_past_depth = true,
};

/* ── SQLTagStore ────────────────────────────────────────────────────── */

/* One cached prepared statement, keyed by the SQL the tag site built. */
typedef struct ScrSqliteTagEntry {
  ScrStr *sql; /* owned */
  ScrSqliteStmt *stmt; /* owned */
  double used; /* LRU clock, larger is more recent */
} ScrSqliteTagEntry;

typedef struct ScrSqliteTagStore {
  size_t rc;
  ScrSqliteDb *db; /* owned */
  size_t capacity;
  ScrSqliteTagEntry *entries;
  size_t count;
  double clock;
  /* Properties JavaScript added to the store object, owned, NULL until the
   * first one (Node's SQLTagStore is an ordinary object). */
  ScrDyn *expandos;
} ScrSqliteTagStore;

static void *scr_sqlite_tag_retain(void *h) {
  ((ScrSqliteTagStore *)h)->rc++;
  return h;
}

/* The collector's teardown of a tag store: the database, its cached
 * statements and its added properties are traced children. */
static void scr_sqlite_tag_gcfree(void *p) {
  ScrSqliteTagStore *store = p;
  for (size_t i = 0; i < store->count; i++) scr_str_release(store->entries[i].sql);
  free(store->entries);
  scr_cyc_free(store);
}

/* A tag store freed without collection: release its children, then the
 * block. */
static void scr_sqlite_tag_destroy(ScrSqliteTagStore *store) {
  for (size_t i = 0; i < store->count; i++) {
    /* A cached statement the program still holds (an iterator) stays
     * usable: dropping the cache's reference finalizes it only when
     * nothing else does. */
    scr_sqlite_db_untrack(store->db, store->entries[i].stmt);
    scr_sqlite_stmt_release(store->entries[i].stmt);
  }
  scr_dyn_release(store->expandos);
  store->expandos = NULL;
  ScrSqliteDb *db = store->db;
  /* Releases the SQL strings and the entries array. */
  scr_sqlite_tag_gcfree(store);
  scr_sqlite_db_release(db);
}

static void scr_sqlite_tag_release(void *h) {
  ScrSqliteTagStore *store = h;
  if (store == NULL) return;
  if (--store->rc > 0) {
    scr_cyc_released(store);
    return;
  }
  scr_cyc_dead(store);
  scr_rc_destroy(store, (void (*)(void *))scr_sqlite_tag_destroy);
}

static void scr_sqlite_tag_trace(void *p, ScrTraceVisit visit, void *ctx) {
  ScrSqliteTagStore *store = p;
  visit(store->db, ctx);
  visit(store->expandos, ctx);
  for (size_t i = 0; i < store->count; i++) visit(store->entries[i].stmt, ctx);
}

/* Drops the cache's references without touching SQLite (Node's Clear). */
static void scr_sqlite_tag_clear_entries(ScrSqliteTagStore *store) {
  for (size_t i = 0; i < store->count; i++) {
    scr_sqlite_db_untrack(store->db, store->entries[i].stmt);
    scr_sqlite_stmt_release(store->entries[i].stmt);
    scr_str_release(store->entries[i].sql);
  }
  store->count = 0;
}

/* The cached statement for `sql`, prepared on first use. Borrowed, or NULL
 * with the exception pending. */
static ScrSqliteStmt *scr_sqlite_tag_statement(ScrSqliteTagStore *store, const ScrStr *sql) {
  for (size_t i = 0; i < store->count; i++) {
    if (store->entries[i].sql->len == sql->len &&
        memcmp(store->entries[i].sql->data, sql->data, sql->len) == 0) {
      ScrSqliteStmt *stmt = store->entries[i].stmt;
      if (scr_sqlite_stmt_is_finalized(stmt)) {
        /* A finalized statement is not reusable. */
        scr_sqlite_db_untrack(store->db, stmt);
        scr_sqlite_stmt_release(stmt);
        scr_str_release(store->entries[i].sql);
        store->entries[i] = store->entries[store->count - 1];
        store->count--;
        break;
      }
      store->entries[i].used = ++store->clock;
      return stmt;
    }
  }

  sqlite3_stmt *raw = NULL;
  int r = sqlite3_prepare_v2(store->db->conn, sql->data, -1, &raw, NULL);
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(store->db);
    if (raw != NULL) sqlite3_finalize(raw);
    return NULL;
  }
  if (raw == NULL) {
    scr_sqlite_invalid_arg_value("The SQL query contains no statements.");
    return NULL;
  }
  ScrSqliteStmt *stmt = scr_sqlite_stmt_alloc(store->db, raw);
  scr_sqlite_db_track(store->db, stmt);

  if (store->count == store->capacity) {
    /* Evict the least recently used entry. */
    size_t victim = 0;
    for (size_t i = 1; i < store->count; i++)
      if (store->entries[i].used < store->entries[victim].used) victim = i;
    ScrSqliteStmt *old = store->entries[victim].stmt;
    scr_sqlite_db_untrack(store->db, old);
    scr_sqlite_stmt_release(old);
    scr_str_release(store->entries[victim].sql);
    store->entries[victim] = store->entries[store->count - 1];
    store->count--;
  }
  void *grown = realloc(store->entries, (store->count + 1) * sizeof *store->entries);
  if (grown == NULL) scr_sqlite_oom();
  store->entries = grown;
  store->entries[store->count].sql = scr_str_retain((ScrStr *)sql);
  store->entries[store->count].stmt = stmt;
  store->entries[store->count].used = ++store->clock;
  store->count++;
  return stmt;
}

/* The SQL a tag call spells: the template's parts with "?" where each bound
 * parameter goes (Node's PrepareStatement). +1, or NULL with the exception
 * pending. */
static ScrStr *scr_sqlite_tag_sql(const ScrDyn *strings, size_t params) {
  if (strings->kind != SCR_DYN_ARR) {
    scr_sqlite_invalid_arg_type("First argument must be an array of strings (template literal).");
    return NULL;
  }
  size_t count = (size_t)scr_dyn_arr_len((ScrDyn *)strings);
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  for (size_t i = 0; i < count; i++) {
    ScrDyn *part = scr_dyn_arr_at(strings, (double)i);
    if (part == NULL) {
      scr_jb_abandon(&buffer);
      return NULL;
    }
    if (part->kind != SCR_DYN_STR) {
      scr_dyn_release(part);
      scr_jb_abandon(&buffer);
      scr_sqlite_invalid_arg_type("Template literal parts must be strings.");
      return NULL;
    }
    scr_jb_write(&buffer, part->v.str->data, part->v.str->len);
    scr_dyn_release(part);
    if (i < params) scr_jb_putc(&buffer, '?');
  }
  return scr_jb_finish(&buffer);
}

/* Reset and bind a tag call's parameters (Node's ResetAndBindStatement). */
static bool scr_sqlite_tag_bind(ScrSqliteStmt *stmt, ScrDyn *const *args, size_t argc) {
  if (scr_sqlite_stmt_reset(stmt) != SQLITE_OK) {
    scr_sqlite_throw_db_error(stmt->db);
    return false;
  }
  if (sqlite3_clear_bindings(stmt->stmt) != SQLITE_OK) {
    scr_sqlite_throw_db_error(stmt->db);
    return false;
  }
  size_t params = argc > 0 ? argc - 1 : 0;
  int count = sqlite3_bind_parameter_count(stmt->stmt);
  if (count != (int)params) {
    scr_sqlite_invalid_arg_value(
        "SQLite parameters must be bound using template literal placeholders.");
    return false;
  }
  for (size_t i = 0; i < params; i++) {
    if (!scr_sqlite_bind_value(stmt, (int)i + 1, args[i + 1])) return false;
  }
  return true;
}

/* One SQLTagStore method: prepare/bind, then run the statement operation. */
static ScrDyn *scr_sqlite_tag_invoke(void *h, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  ScrSqliteTagStore *store = h;
  ScrDyn *own = NULL;
  if (scr_sqlite_own_method_call(store->expandos, h, SCR_DYNH_SQLITE_TAG_STORE, method, self, args,
                                 argc, what, &own))
    return own;
  if (strcmp(method, "clear") == 0) {
    scr_sqlite_tag_clear_entries(store);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (store->db->conn == NULL) {
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  if (store->db->callback_depth > 0) {
    scr_sqlite_invalid_state("database cannot be accessed from an authorizer callback");
    return NULL;
  }
  const ScrDyn *strings = scr_sqlite_arg(args, argc, 0);
  size_t params = argc > 0 ? argc - 1 : 0;
  ScrStr *sql = scr_sqlite_tag_sql(strings, params);
  if (sql == NULL) return NULL;
  ScrSqliteStmt *stmt = scr_sqlite_tag_statement(store, sql);
  scr_str_release(sql);
  if (stmt == NULL) return NULL;
  /* The cache's reference is not enough for the call: a user function the
   * statement runs can clear() the store, and the statement being executed
   * must stay alive until it finishes. */
  scr_sqlite_stmt_retain(stmt);
  ScrDyn *out = NULL;
  if (!scr_sqlite_tag_bind(stmt, args, argc)) {
    /* The bind's own exception is pending. */
  } else if (strcmp(method, "run") == 0) {
    out = scr_sqlite_stmt_run_result(stmt);
  } else if (strcmp(method, "all") == 0) {
    out = scr_sqlite_stmt_all_result(stmt);
  } else if (strcmp(method, "get") == 0) {
    int r = sqlite3_step(stmt->stmt);
    if (r == SQLITE_DONE || (r == SQLITE_ROW && sqlite3_column_count(stmt->stmt) == 0)) {
      out = scr_dyn_retain(scr_dyn_undefined());
      sqlite3_reset(stmt->stmt);
    } else if (r != SQLITE_ROW) {
      sqlite3_reset(stmt->stmt);
      scr_sqlite_throw_db_error(stmt->db);
    } else {
      out = scr_sqlite_row(stmt, stmt->return_arrays);
      sqlite3_reset(stmt->stmt);
    }
  } else if (strcmp(method, "iterate") == 0) {
    ScrSqliteIter *it = calloc(1, sizeof *it);
    if (it == NULL) scr_sqlite_oom();
    it->rc = 1;
    it->stmt = scr_sqlite_stmt_retain(stmt);
    it->generation = stmt->generation;
    out = scr_sqlite_iter_new(it);
  } else {
    scr_sqlite_not_a_function(what);
  }
  scr_sqlite_stmt_release(stmt);
  return out;
}

static ScrDyn *scr_sqlite_tag_get(void *h, const char *key, size_t len) {
  ScrSqliteTagStore *store = h;
  if (len == 8 && memcmp(key, "capacity", 8) == 0)
    return scr_dyn_new_num((double)store->capacity);
  if (len == 4 && memcmp(key, "size", 4) == 0) return scr_dyn_new_num((double)store->count);
  if (len == 2 && memcmp(key, "db", 2) == 0) return scr_sqlite_db_box(store->db);
  /* A property JavaScript added to the store object. */
  return scr_sqlite_table_read(store->expandos, key, len, store, SCR_DYNH_SQLITE_TAG_STORE);
}

static const ScrDynHandleMethod scr_sqlite_tag_methods[] = {
    {"run", 0, false, NULL, NULL},
    {"get", 0, false, NULL, NULL},
    {"all", 0, false, NULL, NULL},
    {"iterate", 0, false, NULL, NULL},
    {"clear", 0, false, NULL, NULL},
    {NULL, 0, false, NULL, NULL},
};

static const ScrDynHandleOps scr_sqlite_tag_ops = {
    .cls = "SQLTagStore",
    .retain = scr_sqlite_tag_retain,
    .release = scr_sqlite_tag_release,
    .invoke = scr_sqlite_tag_invoke,
    .get = scr_sqlite_tag_get,
    .set = scr_sqlite_tag_own_set,
    .inspect_view = scr_sqlite_tag_inspect_view,
    .json_empty_object = true,
    .methods = scr_sqlite_tag_methods,
    .own_names = scr_sqlite_tag_own_names,
    .own_view = scr_sqlite_tag_own_view,
    .own_descriptor = scr_sqlite_tag_own_descriptor,
    .delete_key = scr_sqlite_tag_own_delete,
    .own_enumerable_names = scr_sqlite_tag_own_enum_names,
    .define_own = scr_sqlite_tag_define_own,
    .inspect_bracketed_past_depth = true,
};

/* DatabaseSync::CreateTagStore. +1 or NULL with the exception pending. */
static ScrDyn *scr_sqlite_db_create_tag_store(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  const ScrDyn *max_size = scr_sqlite_arg(args, argc, 0);
  size_t capacity = 1000;
  if (max_size->kind != SCR_DYN_UNDEF) {
    if (max_size->kind != SCR_DYN_NUM) {
      scr_sqlite_invalid_arg_type("The \"maxSize\" argument must be a positive integer.");
      return NULL;
    }
    double value = max_size->v.num;
    if (value != floor(value) || value <= 0 || value > (double)INT_MAX) {
      scr_sqlite_out_of_range("The \"maxSize\" argument must be a positive integer.");
      return NULL;
    }
    capacity = (size_t)value;
  }
  ScrSqliteTagStore *store = scr_cyc_alloc(sizeof *store, &scr_sqlite_tag_cyc);
  store->rc = 1;
  store->db = scr_sqlite_db_retain(db);
  store->capacity = capacity;
  scr_dyn_handle_install(SCR_DYNH_SQLITE_TAG_STORE, &scr_sqlite_tag_ops);
  ScrDyn *out = scr_dyn_new_handle(store, SCR_DYNH_SQLITE_TAG_STORE);
  scr_sqlite_tag_release(store);
  return out;
}

/* ── the limits object ──────────────────────────────────────────────── */

static void scr_sqlite_db_release(void *h);

static void *scr_sqlite_limits_retain(void *h) {
  ((ScrSqliteLimits *)h)->rc++;
  return h;
}

static void scr_sqlite_limits_gcfree(void *p) {
  scr_cyc_free(p);
}

/* A limits object freed without collection: its added properties are its
 * only child (the database it reads through borrows it, and owns it). */
static void scr_sqlite_limits_destroy(ScrSqliteLimits *l) {
  scr_dyn_release(l->expandos);
  l->expandos = NULL;
  scr_sqlite_limits_gcfree(l);
}

static void scr_sqlite_limits_release(void *h) {
  ScrSqliteLimits *l = h;
  if (l == NULL) return;
  if (--l->rc > 0) {
    scr_cyc_released(l);
    return;
  }
  scr_cyc_dead(l);
  scr_rc_destroy(l, (void (*)(void *))scr_sqlite_limits_destroy);
}

static void scr_sqlite_limits_trace(void *p, ScrTraceVisit visit, void *ctx) {
  ScrSqliteLimits *l = p;
  visit(l->expandos, ctx);
}

/* Whether the limits object still reaches an open connection. A database
 * that went away (the object outlived it) answers as a closed one does. */
static bool scr_sqlite_limits_open(const ScrSqliteLimits *l) {
  return l->db != NULL && l->db->conn != NULL;
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
  if (index < 0) {
    /* Not a limit: a JavaScript-added property of this limits object. */
    return scr_sqlite_table_read(l->expandos, key, len, l, SCR_DYNH_SQLITE_LIMITS);
  }
  if (!scr_sqlite_limits_open(l)) {
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  return scr_dyn_new_num((double)sqlite3_limit(l->db->conn, index, -1));
}

static bool scr_sqlite_limits_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  ScrSqliteLimits *l = h;
  int index = scr_sqlite_limit_index(key, len);
  if (index < 0) {
    /* Not a limit: an ordinary property of this limits object, as on Node's
     * (the table hangs off the object Node would have extended, so equality
     * across reads still holds). */
    if (l->expandos == NULL) l->expandos = scr_dyn_new_obj_null_proto();
    return scr_sqlite_table_write(&l->expandos, "Object", l, SCR_DYNH_SQLITE_LIMITS, key, len,
                                  value);
  }
  if (!scr_sqlite_limits_open(l)) {
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

/* The limits object's own names in Node's order: the JavaScript-added
 * properties first (V8 lists the interceptor's names after real own
 * properties), then the limits themselves. Readable while the database is
 * closed, like the key list Node's own property interceptor enumerates. */
static ScrDyn *scr_sqlite_limits_own_names(void *h) {
  ScrSqliteLimits *l = h;
  ScrDyn *names = scr_dyn_new_arr();
  if (l->expandos != NULL) {
    ScrDyn *added = scr_dyn_obj_own_keys(l->expandos);
    for (size_t i = 0; i < added->v.arr.len; i++)
      scr_dyn_arr_push(names, scr_dyn_retain(added->v.arr.items[i]));
    scr_dyn_release(added);
  }
  for (size_t i = 0; i < SCR_SQLITE_LIMIT_COUNT; i++) {
    const char *name = scr_sqlite_limit_names[i];
    ScrStr *key = scr_str_new(name, strlen(name));
    scr_dyn_arr_push(names, scr_dyn_new_str(key));
    scr_str_release(key);
  }
  return names;
}

static ScrDyn *scr_sqlite_limits_enum_names(void *h) {
  ScrSqliteLimits *l = h;
  ScrDyn *names = scr_dyn_new_arr();
  if (l->expandos != NULL) {
    ScrDyn *added = scr_dyn_obj_own_keys(l->expandos);
    for (size_t i = 0; i < added->v.arr.len; i++) {
      const ScrStr *name = added->v.arr.items[i]->v.str;
      ScrDynProp prop;
      if (scr_sqlite_table_prop(l->expandos, name->data, name->len, &prop) && prop.enumerable)
        scr_dyn_arr_push(names, scr_dyn_retain(added->v.arr.items[i]));
    }
    scr_dyn_release(added);
  }
  for (size_t i = 0; i < SCR_SQLITE_LIMIT_COUNT; i++) {
    const char *name = scr_sqlite_limit_names[i];
    ScrStr *key = scr_str_new(name, strlen(name));
    scr_dyn_arr_push(names, scr_dyn_new_str(key));
    scr_str_release(key);
  }
  return names;
}

/* The descriptor of one own property. The limits are the connection's live
 * values (Node's data properties: writable and enumerable, not
 * configurable), so a closed database raises the read's error, while a
 * JavaScript-added property describes itself without the connection. */
static ScrDyn *scr_sqlite_limits_descriptor(void *h, const char *key, size_t len) {
  ScrSqliteLimits *l = h;
  int index = scr_sqlite_limit_index(key, len);
  ScrDyn *out = scr_dyn_new_obj();
  if (index >= 0) {
    if (!scr_sqlite_limits_open(l)) {
      scr_dyn_release(out);
      scr_sqlite_invalid_state("database is not open");
      return NULL;
    }
    scr_dyn_obj_set(out, "value", 5, scr_dyn_new_num((double)sqlite3_limit(l->db->conn, index, -1)));
    scr_dyn_obj_set(out, "writable", 8, scr_dyn_new_bool(true));
    scr_dyn_obj_set(out, "enumerable", 10, scr_dyn_new_bool(true));
    scr_dyn_obj_set(out, "configurable", 12, scr_dyn_new_bool(false));
    return out;
  }
  ScrDynProp prop;
  scr_dyn_release(out);
  if (!scr_sqlite_table_prop(l->expandos, key, len, &prop)) return scr_dyn_retain(scr_dyn_undefined());
  ScrStr *name = scr_str_new(key, len);
  out = scr_dyn_own_descriptor(l->expandos, name);
  scr_str_release(name);
  return out != NULL ? out : scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

/* `delete limits[key]`: the limits themselves are not configurable (Node's
 * own properties are non-deletable); a JavaScript-added property goes away. */
static bool scr_sqlite_limits_delete(void *h, const char *key, size_t len) {
  ScrSqliteLimits *l = h;
  if (scr_sqlite_limit_index(key, len) >= 0) return false;
  ScrDynProp prop;
  if (!scr_sqlite_table_prop(l->expandos, key, len, &prop)) return true;
  if (!prop.configurable) return false;
  ScrStr *name = scr_str_new(key, len);
  scr_dyn_obj_delete_field(l->expandos, name);
  scr_str_release(name);
  return true;
}

/* The limits object the way reflection and util.inspect read it: an ordinary
 * object whose properties hold the connection's live values with Node's
 * attributes (writable and enumerable, not configurable), followed by the
 * JavaScript-added properties. A closed database answers the error every
 * read does. */
static ScrDyn *scr_sqlite_limits_own_view(void *h) {
  ScrSqliteLimits *l = h;
  if (!scr_sqlite_limits_open(l)) {
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  /* An added getter can close or drop the database while the walk is in
   * progress: the connection is held here and checked again before the
   * limits are read. */
  ScrSqliteDb *db = scr_sqlite_db_retain(l->db);
  ScrDyn *view = scr_dyn_new_obj();
  /* The JavaScript-added properties come first, as V8 lists them. */
  scr_sqlite_add_expandos(view, l->expandos, l, SCR_DYNH_SQLITE_LIMITS);
  if (!scr_sqlite_limits_open(l)) {
    scr_dyn_release(view);
    scr_sqlite_db_release(db);
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  for (size_t i = 0; i < SCR_SQLITE_LIMIT_COUNT; i++) {
    const char *name = scr_sqlite_limit_names[i];
    size_t len = strlen(name);
    scr_dyn_obj_set(view, name, len,
                    scr_dyn_new_num((double)sqlite3_limit(l->db->conn, (int)i, -1)));
    scr_dyn_obj_set_attrs_at(view, scr_dyn_obj_index_of(view, name, len), true, true, false);
  }
  scr_sqlite_db_release(db);
  return view;
}

/* The object util.inspect shows: the added accessors stay [Getter]s. */
static ScrDyn *scr_sqlite_limits_inspect_view(void *h) {
  ScrSqliteLimits *l = h;
  if (!scr_sqlite_limits_open(l)) {
    /* Node's inspector reads the limits, so a closed database throws. */
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  ScrSqliteDb *db = scr_sqlite_db_retain(l->db);
  ScrDyn *view = scr_dyn_new_obj();
  scr_sqlite_inspect_expandos(view, l->expandos, SCR_DYNH_SQLITE_LIMITS, h);
  if (!scr_sqlite_limits_open(l)) {
    scr_dyn_release(view);
    scr_sqlite_db_release(db);
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  for (size_t i = 0; i < SCR_SQLITE_LIMIT_COUNT; i++) {
    const char *name = scr_sqlite_limit_names[i];
    size_t len = strlen(name);
    scr_dyn_obj_set(view, name, len,
                    scr_dyn_new_num((double)sqlite3_limit(l->db->conn, (int)i, -1)));
    scr_dyn_obj_set_attrs_at(view, scr_dyn_obj_index_of(view, name, len), true, true, false);
  }
  scr_sqlite_db_release(db);
  return view;
}

/* Object.defineProperty on the limits object: a limit keeps its attributes
 * (Node applies a value through the limit's setter and ignores writable),
 * while any other key is an added property. */
static bool scr_sqlite_limits_define(void *h, const char *key, size_t len, ScrDyn *descriptor) {
  ScrSqliteLimits *l = h;
  if (scr_sqlite_limit_index(key, len) < 0) {
    if (l->expandos == NULL) l->expandos = scr_dyn_new_obj_null_proto();
    return scr_sqlite_define_own(NULL, 0, SCR_DYNH_SQLITE_LIMITS, h, &l->expandos, key, len,
                                 descriptor);
  }
  ScrDyn *snapshot = scr_dyn_descriptor_snapshot(descriptor);
  if (snapshot == NULL) return true;
  ScrDyn *configurable = scr_dyn_obj_get(snapshot, "configurable", 12);
  ScrDyn *enumerable = scr_dyn_obj_get(snapshot, "enumerable", 10);
  ScrDyn *get = scr_dyn_obj_get(snapshot, "get", 3);
  ScrDyn *set = scr_dyn_obj_get(snapshot, "set", 3);
  ScrDyn *value = scr_dyn_obj_get(snapshot, "value", 5);
  bool refuse = (configurable != NULL && scr_dyn_truthy(configurable)) ||
                (enumerable != NULL && !scr_dyn_truthy(enumerable)) || get != NULL || set != NULL;
  if (refuse) {
    char message[160];
    snprintf(message, sizeof message, "Cannot redefine property: %.*s", (int)len, key);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  } else if (value != NULL) {
    (void)scr_sqlite_limits_set(h, key, len, value);
  }
  scr_dyn_release(snapshot);
  return true;
}

static const ScrDynHandleOps scr_sqlite_limits_ops = {
    /* Node's limits object is a null-prototype dictionary, which Node names
     * "Object" when a render stops at the depth limit. */
    .cls = "Object",
    .retain = scr_sqlite_limits_retain,
    .release = scr_sqlite_limits_release,
    .invoke = scr_sqlite_limits_invoke,
    .get = scr_sqlite_limits_get,
    .set = scr_sqlite_limits_set,
    .inspect_view = scr_sqlite_limits_inspect_view,
    .inspect_view_bare = true,
    .json_empty_object = true,
    .own_names = scr_sqlite_limits_own_names,
    .own_enumerable_names = scr_sqlite_limits_enum_names,
    .own_view = scr_sqlite_limits_own_view,
    .own_descriptor = scr_sqlite_limits_descriptor,
    .delete_key = scr_sqlite_limits_delete,
    .define_own = scr_sqlite_limits_define,
    .inspect_bracketed_past_depth = true,
};

/* ── sqlite.backup ──────────────────────────────────────────────────── */

static char *scr_sqlite_validate_path(const ScrDyn *path);
static ScrSqliteDb *scr_sqlite_db_of(const ScrDyn *box);

/* One backup run: the destination handle the copy writes, the source
 * connection it reads, and the state its deferred steps share. The promise
 * settles on the turn that reaches SQLITE_DONE, so the job outlives the call
 * that started it and frees itself with that turn's closure. */
typedef struct ScrSqliteBackupJob {
  size_t rc;
  ScrPromise *promise; /* owned */
  ScrSqliteDb *source; /* owned */
  ScrDyn *progress; /* owned, NULL without a callback */
  ScrStr *source_db; /* owned when options named one */
  ScrStr *dest_db; /* owned when options named one */
  sqlite3 *dest;
  sqlite3_backup *copy;
  int rate;
} ScrSqliteBackupJob;

static void *scr_sqlite_backup_job_retain(void *p) {
  ((ScrSqliteBackupJob *)p)->rc++;
  return p;
}

/* Rejects the backup's promise. A step that fails names its own code, which
 * is the error Node reports; a copy that never started (BUSY and LOCKED leave
 * the destination without one) reports the destination handle's error. That
 * text belongs to the handle, so it is copied before the job's release closes
 * it. */
static void scr_sqlite_backup_reject(ScrSqliteBackupJob *job, int code) {
  int errcode;
  const char *text;
  if (code != SQLITE_OK) {
    errcode = code;
    text = sqlite3_errstr(code);
  } else {
    errcode = job->dest == NULL ? SQLITE_ERROR : sqlite3_extended_errcode(job->dest);
    text = job->dest != NULL ? sqlite3_errmsg(job->dest) : sqlite3_errstr(errcode);
  }
  ScrStr *message = scr_str_new(text, strlen(text));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_error_set_code(e, "ERR_SQLITE_ERROR");
  const char *errtext = sqlite3_errstr(errcode);
  ScrStr *errstr = scr_str_new(errtext, strlen(errtext));
  ScrDyn *errstr_dyn = scr_dyn_new_str(errstr);
  scr_str_release(errstr);
  scr_error_set_prop(e, "errcode", 7, scr_dyn_new_num((double)errcode));
  scr_error_set_prop(e, "errstr", 6, errstr_dyn);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  scr_promise_reject_pending(job->promise);
}

static void scr_sqlite_backup_job_release(void *p) {
  ScrSqliteBackupJob *job = p;
  if (job == NULL || --job->rc > 0) return;
  if (job->copy != NULL) sqlite3_backup_finish(job->copy);
  if (job->dest != NULL) sqlite3_close_v2(job->dest);
  scr_promise_release(job->promise);
  scr_dyn_release(job->progress);
  scr_str_release(job->source_db);
  scr_str_release(job->dest_db);
  scr_sqlite_db_release(job->source);
  free(job);
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

static void scr_sqlite_backup_step(ScrClosure *self);

/* Queues the next step on a later loop turn, as Node's BackupJob schedules
 * one threadpool work item per step and settles the promise from that work's
 * completion: the loop keeps running between two steps, so a writer that
 * holds the destination (or a write transaction on the source) can release
 * it while a busy step waits, and timers and other fibers keep running
 * instead of stalling behind the copy.
 *
 * The step goes on the immediate queue rather than the deferred-callback
 * one: the immediate station snapshots the callbacks queued for this turn,
 * so a step that queues the next one runs at most once per turn in the
 * runtime's own loop, and in a hosted loop each step is handed to the host's
 * check phase, which runs it on a later host turn. The deferred queue is
 * drained to exhaustion in one host turn, which would run a busy copy's
 * whole retry chain without ever returning to the loop. */
static void scr_sqlite_backup_schedule(ScrSqliteBackupJob *job) {
  ScrClosure *step = scr_closure_new((void *)scr_sqlite_backup_step, 1);
  ScrBox *box =
      scr_box_new_obj(scr_sqlite_backup_job_retain, scr_sqlite_backup_job_release, NULL);
  scr_box_set_ref(box, scr_sqlite_backup_job_retain(job)); /* the box owns this reference */
  step->caps[0] = box;
  (void)scr_set_immediate(step); /* the queue owns the closure */
}

/* One step of the copy, then either the next turn, the rejection or the
 * page count. */
static void scr_sqlite_backup_step(ScrClosure *self) {
  ScrSqliteBackupJob *job = scr_box_get_ref(self->caps[0]);
  int status = sqlite3_backup_step(job->copy, job->rate);
  if (!(status == SQLITE_OK || status == SQLITE_DONE || status == SQLITE_BUSY ||
        status == SQLITE_LOCKED)) {
    scr_sqlite_backup_reject(job, status);
    scr_sqlite_backup_job_release(job);
    return;
  }
  int total = sqlite3_backup_pagecount(job->copy);
  int remaining = sqlite3_backup_remaining(job->copy);
  if (remaining != 0) {
    /* Pages are left, whether the step copied some or was held off by a
     * lock (BUSY and LOCKED leave the counters as the last successful step
     * set them). The progress callback runs here, between two steps. */
    if (!scr_sqlite_backup_progress(job->source, job->progress, total, remaining)) {
      scr_promise_reject_pending(job->promise); /* the callback's exception */
    } else {
      scr_sqlite_backup_schedule(job);
    }
    scr_sqlite_backup_job_release(job);
    return;
  }
  if (status != SQLITE_DONE) {
    /* A first step that could not start: Node rejects rather than retrying a
     * copy whose page count it never learned. */
    scr_sqlite_backup_reject(job, SQLITE_OK);
    scr_sqlite_backup_job_release(job);
    return;
  }
  ScrDyn *pages = scr_dyn_new_num((double)total);
  scr_promise_fulfill_ref(job->promise, pages, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_sqlite_backup_job_release(job);
}

/* sqlite.backup(sourceDb, path[, options]): copies the source database into
 * a new file and answers the promise of its page count, as Node's BackupJob
 * does. The copy is a pending promise: the destination is opened here, and
 * each step runs on its own loop turn, so the progress callbacks and every
 * other pending fiber run between steps and the loop never stalls on a
 * writer that holds a lock. All arguments are borrowed; +1, or NULL with the
 * exception pending for the validation failures Node throws. */
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

  sqlite3 *dest = NULL;
  int r = sqlite3_open_v2(destination, &dest,
                          SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, NULL);
  free(destination);
  if (r != SQLITE_OK) {
    /* The message belongs to the destination handle, so copy it before the
     * handle closes. Node rejects the promise (the destination is opened
     * before the work starts), so the error becomes the rejection. */
    int errcode = dest != NULL ? sqlite3_extended_errcode(dest) : r;
    const char *text = dest != NULL ? sqlite3_errmsg(dest) : sqlite3_errstr(r);
    ScrStr *message = scr_str_new(text, strlen(text));
    if (dest != NULL) sqlite3_close_v2(dest);
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
  sqlite3_backup *copy = sqlite3_backup_init(dest, dest_db, db->conn, source_db);
  if (copy == NULL) {
    int errcode = sqlite3_errcode(dest);
    scr_sqlite_throw_coded_error(errcode, sqlite3_errstr(errcode));
    sqlite3_close_v2(dest);
    ScrPromise *promise =
        scr_promise_settled_ref(NULL, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
    scr_dyn_release(progress);
    scr_str_release(held_source);
    scr_str_release(held_target);
    ScrDyn *box = scr_dyn_new_promise(promise);
    scr_promise_release(promise);
    return box;
  }

  ScrSqliteBackupJob *job = calloc(1, sizeof *job);
  if (job == NULL) scr_sqlite_oom();
  job->rc = 1;
  job->promise = scr_promise_new();
  job->source = scr_sqlite_db_retain(db);
  job->progress = progress; /* ownership moves */
  job->source_db = held_source; /* ownership moves */
  job->dest_db = held_target; /* ownership moves */
  job->dest = dest;
  job->copy = copy;
  job->rate = rate;
  scr_sqlite_backup_schedule(job); /* the step's box owns a reference */
  ScrDyn *box = scr_dyn_new_promise(job->promise);
  scr_sqlite_backup_job_release(job); /* the caller's reference */
  return box;
}


/* ── DatabaseSync ───────────────────────────────────────────────────── */

static void *scr_sqlite_db_retain(void *h) {
  ((ScrSqliteDb *)h)->rc++;
  return h;
}

/* The collector's teardown of a database: its statements, sessions, limits
 * object and added properties are traced children the collector frees, so
 * only untraced state (the connection, the path string, the list arrays)
 * goes here. sqlite3_close_v2 leaves the connection open until its last
 * statement is finalized, so the order the collector frees in is safe. */
static void scr_sqlite_db_gcfree(void *p) {
  ScrSqliteDb *db = p;
  if (db->conn != NULL) {
    sqlite3_close_v2(db->conn);
    db->conn = NULL;
  }
  scr_str_release(db->path);
  free(db->stmts);
  free(db->sessions);
  scr_cyc_free(db);
}

/* A database freed without collection: release every child, then the block.
 * A tracked statement or session keeps a reference to the database, so both
 * lists are empty by the time this runs. */
static void scr_sqlite_db_destroy(ScrSqliteDb *db) {
  if (db->conn != NULL) sqlite3_close_v2(db->conn);
  if (db->limits_object != NULL) {
    db->limits_object->db = NULL;
    scr_sqlite_limits_release(db->limits_object);
    db->limits_object = NULL;
  }
  scr_dyn_release(db->authorizer);
  db->authorizer = NULL;
  scr_dyn_release(db->expandos);
  db->expandos = NULL;
  scr_sqlite_db_gcfree(db);
}

static void scr_sqlite_db_release(void *h) {
  ScrSqliteDb *db = h;
  if (db == NULL) return;
  if (--db->rc > 0) {
    scr_cyc_released(db);
    return;
  }
  scr_cyc_dead(db);
  scr_rc_destroy(db, (void (*)(void *))scr_sqlite_db_destroy);
}

static void scr_sqlite_db_trace(void *p, ScrTraceVisit visit, void *ctx) {
  ScrSqliteDb *db = p;
  visit(db->limits_object, ctx);
  visit(db->expandos, ctx);
  visit(db->authorizer, ctx);
  for (size_t i = 0; i < db->stmt_n; i++) visit(db->stmts[i], ctx);
  for (size_t i = 0; i < db->session_n; i++) visit(db->sessions[i], ctx);
}

static void scr_sqlite_db_delete_sessions(ScrSqliteDb *db);
static ScrDyn *scr_sqlite_uint8_copy(const void *data, size_t size);

/* Node's FinalizeStatements: finalize every live statement without closing
 * the connection (what deserialize does before replacing the database). */
static void scr_sqlite_db_close_statements(ScrSqliteDb *db) {
  while (db->stmt_n > 0) {
    ScrSqliteStmt *s = db->stmts[db->stmt_n - 1];
    db->stmts[db->stmt_n - 1] = NULL;
    db->stmt_n--;
    scr_sqlite_stmt_finalize(s);
    /* The database owned the statement and the statement owned the
     * database: a program that stores a statement on the database object
     * would leave that pair uncollectable. A closed statement needs no
     * database, so its reference becomes the closed stand-in. */
    if (s->db != &scr_sqlite_closed_db) {
      scr_sqlite_db_release(s->db);
      s->db = &scr_sqlite_closed_db;
    }
    /* The database's own reference to the statement goes too; a program
     * that still holds the statement keeps it. */
    scr_sqlite_stmt_release(s);
  }
}

/* Node's DatabaseSync::Close body: finalize every live statement, then
 * close the connection. */
static bool scr_sqlite_db_close_all(ScrSqliteDb *db) {
  while (db->stmt_n > 0) {
    ScrSqliteStmt *s = db->stmts[db->stmt_n - 1];
    db->stmts[db->stmt_n - 1] = NULL;
    db->stmt_n--;
    scr_sqlite_stmt_finalize(s);
    /* The database owned the statement and the statement owned the
     * database: a program that stores a statement on the database object
     * would leave that pair uncollectable. A closed statement needs no
     * database, so its reference becomes the closed stand-in. */
    if (s->db != &scr_sqlite_closed_db) {
      scr_sqlite_db_release(s->db);
      s->db = &scr_sqlite_closed_db;
    }
    /* The database's own reference to the statement goes too; a program
     * that still holds the statement keeps it. */
    scr_sqlite_stmt_release(s);
  }
  scr_sqlite_db_delete_sessions(db);
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
  scr_sqlite_stmt_retain(s);
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

/* ── user-defined functions and aggregates ──────────────────────────── */

/* One aggregate's per-group state (sqlite3_aggregate_context): the running
 * accumulator the step function answered. */
typedef struct ScrSqliteAgg {
  ScrDyn *value; /* owned; NULL until the start value is evaluated */
  bool ready;
  bool window;
} ScrSqliteAgg;

static void scr_sqlite_func_release(ScrSqliteFunc *f) {
  if (f == NULL) return;
  scr_dyn_release(f->fn);
  scr_dyn_release(f->start);
  scr_dyn_release(f->inverse);
  scr_dyn_release(f->result);
  free(f->name);
  free(f);
}

static void scr_sqlite_func_destroy(void *self) { scr_sqlite_func_release(self); }

/* Calls `f`'s JavaScript callable with the aggregate accumulator (when
 * `acc`) followed by the SQLite arguments, as checked-dynamic values. All
 * arguments are borrowed; the result is +1, or NULL with the exception
 * pending. */
static ScrDyn *scr_sqlite_call_js(ScrSqliteFunc *f, const ScrDyn *fn, ScrDyn *acc,
                                  sqlite3_value **argv, int argc) {
  scr_dyn_this_push_dyn(scr_dyn_undefined());
  /* Room for the accumulator and the value arguments: a zero-argument
   * aggregate still carries the accumulator. */
  size_t capacity = (size_t)argc + (acc != NULL ? 1 : 0);
  ScrDyn **values = capacity == 0 ? NULL : malloc(capacity * sizeof *values);
  if (capacity > 0 && values == NULL) scr_sqlite_oom();
  size_t count = 0;
  ScrDyn *result = NULL;
  if (acc != NULL) values[count++] = scr_dyn_retain(acc);
  for (int i = 0; i < argc; i++) {
    ScrDyn *value = scr_sqlite_value_dyn(argv[i], f->big_args);
    if (value == NULL) goto done;
    values[count++] = value;
  }
  result = scr_dyn_call(fn, values, count, f->name);
done:
  for (size_t i = 0; i < count; i++) scr_dyn_release(values[i]);
  free(values);
  scr_dyn_this_pop();
  return result;
}

/* Reports a JavaScript exception to SQLite without replacing it: the
 * pending exception is what the program sees, so the SQLite error surface
 * is silenced (Node's SetIgnoreNextSQLiteError). */
static void scr_sqlite_callback_failed(ScrSqliteFunc *f, sqlite3_context *ctx) {
  f->db->ignore_next_error = true;
  sqlite3_result_error(ctx, "", 0);
}

static void scr_sqlite_func_xfunc(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  ScrSqliteFunc *f = sqlite3_user_data(ctx);
  f->db->callback_depth++;
  ScrDyn *result = scr_sqlite_call_js(f, f->fn, NULL, argv, argc);
  f->db->callback_depth--;
  if (result == NULL) {
    scr_sqlite_callback_failed(f, ctx);
    return;
  }
  scr_sqlite_dyn_result(ctx, result);
  scr_dyn_release(result);
}

/* The accumulator a group starts from: the start function called with no
 * arguments, or the start value itself (Node's GetAggregate). +1, or NULL
 * with the exception pending. */
static ScrDyn *scr_sqlite_agg_start(ScrSqliteFunc *f) {
  if (f->start == NULL) return scr_dyn_retain(scr_dyn_undefined());
  if (f->start->kind != SCR_DYN_FUNC) return scr_dyn_retain(f->start);
  scr_dyn_this_push_dyn(scr_dyn_undefined());
  ScrDyn *result = scr_dyn_call(f->start, NULL, 0, f->name);
  scr_dyn_this_pop();
  return result;
}

static void scr_sqlite_agg_step_base(sqlite3_context *ctx, int argc, sqlite3_value **argv,
                                     bool inverse) {
  ScrSqliteFunc *f = sqlite3_user_data(ctx);
  ScrSqliteAgg *agg = sqlite3_aggregate_context(ctx, (int)sizeof *agg);
  if (agg == NULL) {
    scr_throw_error_msg_code(SCR_ERR_ERROR, "Memory allocation failed", 22,
                             "ERR_MEMORY_ALLOCATION_FAILED");
    scr_sqlite_callback_failed(f, ctx);
    return;
  }
  f->db->callback_depth++;
  if (!agg->ready) {
    ScrDyn *start = scr_sqlite_agg_start(f);
    if (start == NULL) {
      f->db->callback_depth--;
      scr_sqlite_callback_failed(f, ctx);
      return;
    }
    agg->value = start;
    agg->ready = true;
  }
  /* A row leaving the window frame runs the inverse function, which
   * removes the row's effect from the accumulator; every other step runs
   * the step function. SQLite only calls this path with an inverse
   * registered when one was given. */
  const ScrDyn *fn = inverse ? f->inverse : f->fn;
  if (fn == NULL) fn = f->fn;
  ScrDyn *result = scr_sqlite_call_js(f, fn, agg->value, argv, argc);
  f->db->callback_depth--;
  if (result == NULL) {
    scr_sqlite_callback_failed(f, ctx);
    return;
  }
  scr_dyn_release(agg->value);
  agg->value = result;
}

static void scr_sqlite_agg_step(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  scr_sqlite_agg_step_base(ctx, argc, argv, false);
}

static void scr_sqlite_agg_inverse(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  scr_sqlite_agg_step_base(ctx, argc, argv, true);
}

/* The group's value: the result function over the accumulator, or the
 * accumulator itself. Borrows the aggregate. */
static void scr_sqlite_agg_answer(ScrSqliteFunc *f, ScrSqliteAgg *agg, sqlite3_context *ctx) {
  ScrDyn *value = scr_dyn_retain(agg->value != NULL ? agg->value : scr_dyn_undefined());
  if (f->result != NULL) {
    scr_dyn_this_push_dyn(scr_dyn_undefined());
    ScrDyn *next = scr_dyn_call(f->result, &value, 1, f->name);
    scr_dyn_this_pop();
    scr_dyn_release(value);
    if (next == NULL) {
      scr_sqlite_callback_failed(f, ctx);
      return;
    }
    value = next;
  }
  scr_sqlite_dyn_result(ctx, value);
  scr_dyn_release(value);
}

static void scr_sqlite_agg_free(ScrSqliteAgg *agg) {
  if (agg == NULL) return;
  scr_dyn_release(agg->value);
  agg->value = NULL;
  agg->ready = false;
}

static void scr_sqlite_agg_final(sqlite3_context *ctx) {
  ScrSqliteFunc *f = sqlite3_user_data(ctx);
  ScrSqliteAgg *agg = sqlite3_aggregate_context(ctx, (int)sizeof *agg);
  if (agg == NULL) {
    scr_sqlite_callback_failed(f, ctx);
    return;
  }
  f->db->callback_depth++;
  if (!agg->ready) {
    ScrDyn *start = scr_sqlite_agg_start(f);
    if (start == NULL) {
      f->db->callback_depth--;
      scr_sqlite_callback_failed(f, ctx);
      return;
    }
    agg->value = start;
    agg->ready = true;
  }
  if (agg->window) {
    /* A window function answered through xValue already. */
    f->db->callback_depth--;
    scr_sqlite_agg_free(agg);
    return;
  }
  scr_sqlite_agg_answer(f, agg, ctx);
  f->db->callback_depth--;
  scr_sqlite_agg_free(agg);
}

static void scr_sqlite_agg_value(sqlite3_context *ctx) {
  ScrSqliteFunc *f = sqlite3_user_data(ctx);
  ScrSqliteAgg *agg = sqlite3_aggregate_context(ctx, (int)sizeof *agg);
  if (agg == NULL) {
    scr_sqlite_callback_failed(f, ctx);
    return;
  }
  agg->window = true;
  f->db->callback_depth++;
  if (!agg->ready) {
    ScrDyn *start = scr_sqlite_agg_start(f);
    if (start == NULL) {
      f->db->callback_depth--;
      scr_sqlite_callback_failed(f, ctx);
      return;
    }
    agg->value = start;
    agg->ready = true;
  }
  scr_sqlite_agg_answer(f, agg, ctx);
  f->db->callback_depth--;
}

/* Node's integer option (`useBigIntArguments`, `varargs`, ...). An absent
 * member keeps *out; a present non-boolean answers false. */
static bool scr_sqlite_option_boolean_at(const ScrDyn *options, const char *key, bool *out) {
  ScrDyn *value = scr_sqlite_get(options, key);
  if (value == NULL) return false;
  bool ok = true;
  if (value->kind == SCR_DYN_BOOL) *out = value->v.b;
  else if (value->kind != SCR_DYN_UNDEF) ok = false;
  scr_dyn_release(value);
  return ok;
}

/* The `length` of a function value (Node reads fn.length to choose the
 * SQLite argument count). */
static int scr_sqlite_fn_length(const ScrDyn *fn) {
  if (fn->kind != SCR_DYN_FUNC) return 0;
  ScrDyn *length = scr_dyn_fn_get(fn, "length", 6);
  int value = 0;
  if (length != NULL) {
    if (length->kind == SCR_DYN_NUM) value = (int)length->v.num;
    scr_dyn_release(length);
  }
  return value;
}

/* DatabaseSync::CustomFunction. False with the exception pending. */
static bool scr_sqlite_db_register_function(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  ScrDyn *name = scr_dyn_retain(args[0]);
  if (name->kind != SCR_DYN_STR) {
    scr_dyn_release(name);
    scr_sqlite_invalid_arg_type("The \"name\" argument must be a string.");
    return false;
  }
  size_t fn_index = argc < 3 ? 1 : 2;
  bool big_args = false, varargs = false, deterministic = false, direct_only = false;
  if (fn_index > 1) {
    ScrDyn *options = argc > 1 ? args[1] : NULL;
    if (options == NULL || !scr_sqlite_object_like(options)) {
      scr_dyn_release(name);
      scr_sqlite_invalid_arg_type("The \"options\" argument must be an object.");
      return false;
    }
    const struct {
      const char *key;
      bool *out;
      const char *label;
    } checks[] = {
        {"useBigIntArguments", &big_args, "useBigIntArguments"},
        {"varargs", &varargs, "varargs"},
        {"deterministic", &deterministic, "deterministic"},
        {"directOnly", &direct_only, "directOnly"},
    };
    for (size_t i = 0; i < sizeof checks / sizeof checks[0]; i++) {
      bool *out = checks[i].out;
      if (!scr_sqlite_option_boolean_at(options, checks[i].key, out)) {
        char msg[128];
        snprintf(msg, sizeof msg, "The \"options.%s\" argument must be a boolean.",
                 checks[i].label);
        scr_dyn_release(name);
        scr_sqlite_invalid_arg_type(msg);
        return false;
      }
    }
  }
  ScrDyn *fn = fn_index < argc ? args[fn_index] : NULL;
  if (fn == NULL || fn->kind != SCR_DYN_FUNC) {
    scr_dyn_release(name);
    scr_sqlite_invalid_arg_type("The \"function\" argument must be a function.");
    return false;
  }
  int nargs = varargs ? -1 : scr_sqlite_fn_length(fn);
  int flags = SQLITE_UTF8;
  if (deterministic) flags |= SQLITE_DETERMINISTIC;
  if (direct_only) flags |= SQLITE_DIRECTONLY;

  ScrSqliteFunc *f = calloc(1, sizeof *f);
  if (f == NULL) scr_sqlite_oom();
  f->db = db;
  f->fn = scr_dyn_retain(fn);
  f->big_args = big_args;
  f->aggregate = false;
  f->name = malloc(name->v.str->len + 1);
  if (f->name == NULL) scr_sqlite_oom();
  memcpy(f->name, name->v.str->data, name->v.str->len);
  f->name[name->v.str->len] = 0;
  int r = sqlite3_create_function_v2(db->conn, f->name, nargs, flags, f,
                                     scr_sqlite_func_xfunc, NULL, NULL,
                                     scr_sqlite_func_destroy);
  if (r != SQLITE_OK) {
    /* SQLite invokes the destroy callback on a failed registration, so the
     * function's user data is already gone here. */
    scr_sqlite_throw_db_error(db);
    scr_dyn_release(name);
    return false;
  }
  scr_dyn_release(name);
  return true;
}

/* DatabaseSync::AggregateFunction. False with the exception pending. */
static bool scr_sqlite_db_register_aggregate(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  ScrDyn *name = scr_dyn_retain((ScrDyn *)scr_sqlite_arg(args, argc, 0));
  if (name->kind != SCR_DYN_STR) {
    scr_dyn_release(name);
    scr_sqlite_invalid_arg_type("The \"name\" argument must be a string.");
    return false;
  }
  ScrDyn *options = argc > 1 ? args[1] : NULL;
  if (options == NULL || !scr_sqlite_object_like(options)) {
    scr_dyn_release(name);
    scr_sqlite_invalid_arg_type("The \"options\" argument must be an object.");
    return false;
  }
  ScrDyn *start = scr_sqlite_get(options, "start");
  ScrDyn *step = scr_sqlite_get(options, "step");
  ScrDyn *inverse = scr_sqlite_get(options, "inverse");
  ScrDyn *result_fn = scr_sqlite_get(options, "result");
  bool ok = false;
  bool big_args = false, varargs = false, direct_only = false;
  if (start == NULL || step == NULL || inverse == NULL || result_fn == NULL) goto done;
  if (start->kind == SCR_DYN_UNDEF) {
    scr_sqlite_invalid_arg_type(
        "The \"options.start\" argument must be a function or a primitive value.");
    goto done;
  }
  if (step->kind != SCR_DYN_FUNC) {
    scr_sqlite_invalid_arg_type("The \"options.step\" argument must be a function.");
    goto done;
  }
  if (inverse->kind != SCR_DYN_UNDEF && inverse->kind != SCR_DYN_FUNC) {
    scr_sqlite_invalid_arg_type("The \"options.inverse\" argument must be a function.");
    goto done;
  }
  if (!scr_sqlite_option_boolean_at(options, "useBigIntArguments", &big_args)) {
    scr_sqlite_invalid_arg_type(
        "The \"options.useBigIntArguments\" argument must be a boolean.");
    goto done;
  }
  if (!scr_sqlite_option_boolean_at(options, "varargs", &varargs)) {
    scr_sqlite_invalid_arg_type("The \"options.varargs\" argument must be a boolean.");
    goto done;
  }
  if (!scr_sqlite_option_boolean_at(options, "directOnly", &direct_only)) {
    scr_sqlite_invalid_arg_type("The \"options.directOnly\" argument must be a boolean.");
    goto done;
  }
  {
    int nargs = -1;
    if (!varargs) {
      /* The first step argument is the accumulator. */
      nargs = scr_sqlite_fn_length(step) - 1;
      if (inverse->kind == SCR_DYN_FUNC) {
        int inverse_args = scr_sqlite_fn_length(inverse) - 1;
        if (inverse_args > nargs) nargs = inverse_args;
      }
      if (nargs < 0) nargs = 0;
    }
    int flags = SQLITE_UTF8;
    if (direct_only) flags |= SQLITE_DIRECTONLY;
    ScrSqliteFunc *f = calloc(1, sizeof *f);
    if (f == NULL) scr_sqlite_oom();
    f->db = db;
    f->fn = scr_dyn_retain(step);
    f->start = start->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_retain(start);
    f->inverse = inverse->kind == SCR_DYN_FUNC ? scr_dyn_retain(inverse) : NULL;
    f->result = result_fn->kind == SCR_DYN_FUNC ? scr_dyn_retain(result_fn) : NULL;
    f->big_args = big_args;
    f->aggregate = true;
    f->name = malloc(name->v.str->len + 1);
    if (f->name == NULL) scr_sqlite_oom();
    memcpy(f->name, name->v.str->data, name->v.str->len);
    f->name[name->v.str->len] = 0;
    int r = sqlite3_create_window_function(
        db->conn, f->name, nargs, flags, f, scr_sqlite_agg_step, scr_sqlite_agg_final,
        f->inverse != NULL ? scr_sqlite_agg_value : NULL,
        f->inverse != NULL ? scr_sqlite_agg_inverse : NULL, scr_sqlite_func_destroy);
    if (r != SQLITE_OK) {
      /* SQLite invokes the destroy callback on a failed registration. */
      scr_sqlite_throw_db_error(db);
      goto done;
    }
  }
  ok = true;
done:
  scr_dyn_release(start);
  scr_dyn_release(step);
  scr_dyn_release(inverse);
  scr_dyn_release(result_fn);
  scr_dyn_release(name);
  return ok;
}

/* ── applyChangeset ─────────────────────────────────────────────────── */

typedef struct ScrSqliteChangeset {
  ScrDyn *filter; /* owned or NULL */
  ScrDyn *conflict; /* owned or NULL */
  bool filter_failed;
} ScrSqliteChangeset;

/* sqlite3changeset_apply's table filter: the JavaScript callback's truth. */
static int scr_sqlite_changeset_filter(void *ctx, const char *table) {
  ScrSqliteChangeset *c = ctx;
  if (c->filter == NULL || c->filter_failed) return c->filter == NULL ? 1 : 0;
  ScrDyn *argument = scr_sqlite_str_dyn(table);
  scr_dyn_this_push_dyn(scr_dyn_undefined());
  ScrDyn *result = scr_dyn_call(c->filter, &argument, 1, "filter");
  scr_dyn_this_pop();
  scr_dyn_release(argument);
  if (result == NULL) {
    c->filter_failed = true;
    return 0;
  }
  bool truth = scr_dyn_truthy(result);
  scr_dyn_release(result);
  return truth ? 1 : 0;
}

/* sqlite3changeset_apply's conflict handler: the JavaScript callback's
 * conflict resolution, or ABORT without one. */
static int scr_sqlite_changeset_conflict(void *ctx, int conflict, sqlite3_changeset_iter *iter) {
  (void)iter;
  ScrSqliteChangeset *c = ctx;
  if (c->conflict == NULL) return SQLITE_CHANGESET_ABORT;
  ScrDyn *argument = scr_dyn_new_num((double)conflict);
  scr_dyn_this_push_dyn(scr_dyn_undefined());
  ScrDyn *result = scr_dyn_call(c->conflict, &argument, 1, "onConflict");
  scr_dyn_this_pop();
  scr_dyn_release(argument);
  if (result == NULL) return SQLITE_CHANGESET_ABORT;
  if (result->kind != SCR_DYN_NUM || result->v.num != trunc(result->v.num) ||
      result->v.num < (double)INT32_MIN || result->v.num > (double)INT32_MAX) {
    /* A non-int32 answer is not a conflict resolution: Node hands SQLite
     * an invalid code, which aborts the apply with SQLITE_MISUSE, so the
     * apply raises ERR_SQLITE_ERROR from SQLite's misuse text and code,
     * and the connection keeps reporting its later errors. */
    scr_dyn_release(result);
    return SQLITE_MISUSE;
  }
  int code = (int)result->v.num;
  scr_dyn_release(result);
  return code;
}

/* DatabaseSync::ApplyChangeset. Answers +1 true/false, or NULL with the
 * exception pending. */
static ScrDyn *scr_sqlite_db_apply_changeset(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  ScrDyn *input = scr_dyn_retain((ScrDyn *)scr_sqlite_arg(args, argc, 0));
  if (input->kind != SCR_DYN_BYTES || input->v.bytes->elem != SCR_BYTES_U8 ||
      input->v.bytes->is_data_view) {
    scr_dyn_release(input);
    scr_sqlite_invalid_arg_type("The \"changeset\" argument must be a Uint8Array.");
    return NULL;
  }
  ScrDyn *options = scr_dyn_retain((ScrDyn *)scr_sqlite_arg(args, argc, 1));
  ScrSqliteChangeset context = {0};
  if (options->kind != SCR_DYN_UNDEF) {
    if (!scr_sqlite_object_like(options)) {
      scr_dyn_release(options);
      scr_dyn_release(input);
      scr_sqlite_invalid_arg_type("The \"options\" argument must be an object.");
      return NULL;
    }
    ScrDyn *conflict = scr_sqlite_get(options, "onConflict");
    ScrDyn *filter = scr_sqlite_get(options, "filter");
    if (conflict == NULL || filter == NULL) {
      scr_dyn_release(conflict);
      scr_dyn_release(filter);
      scr_dyn_release(options);
      scr_dyn_release(input);
      return NULL;
    }
    if (conflict->kind != SCR_DYN_UNDEF) {
      if (conflict->kind != SCR_DYN_FUNC) {
        scr_dyn_release(conflict);
        scr_dyn_release(filter);
        scr_dyn_release(options);
        scr_dyn_release(input);
        scr_sqlite_invalid_arg_type("The \"options.onConflict\" argument must be a function.");
        return NULL;
      }
      context.conflict = scr_dyn_retain(conflict);
    }
    if (filter->kind != SCR_DYN_UNDEF) {
      if (filter->kind != SCR_DYN_FUNC) {
        scr_dyn_release(filter);
        scr_dyn_release(context.conflict);
        scr_dyn_release(conflict);
        scr_dyn_release(options);
        scr_dyn_release(input);
        scr_sqlite_invalid_arg_type("The \"options.filter\" argument must be a function.");
        return NULL;
      }
      context.filter = scr_dyn_retain(filter);
    }
    scr_dyn_release(conflict);
    scr_dyn_release(filter);
  }
  scr_dyn_release(options);

  db->callback_depth++;
  int r = sqlite3changeset_apply(
      db->conn, (int)input->v.bytes->len, input->v.bytes->data,
      context.filter != NULL ? scr_sqlite_changeset_filter : NULL,
      scr_sqlite_changeset_conflict, &context);
  db->callback_depth--;
  scr_dyn_release(context.filter);
  scr_dyn_release(context.conflict);
  scr_dyn_release(input);
  if (r == SQLITE_OK) return scr_dyn_new_bool(true);
  if (r == SQLITE_ABORT) return scr_dyn_new_bool(false);
  scr_sqlite_throw_result_error(r);
  return NULL;
}

/* ── changeset sessions ─────────────────────────────────────────────── */

static void scr_sqlite_session_untrack(ScrSqliteDb *db, ScrSqliteSession *session) {
  for (size_t i = 0; i < db->session_n; i++) {
    if (db->sessions[i] == session) {
      db->sessions[i] = db->sessions[db->session_n - 1];
      db->session_n--;
      return;
    }
  }
}

static void scr_sqlite_session_delete(ScrSqliteSession *session);

static void *scr_sqlite_session_retain(void *h) {
  ((ScrSqliteSession *)h)->rc++;
  return h;
}

/* The collector's teardown of a session: its database is a traced child. */
static void scr_sqlite_session_gcfree(void *p) {
  ScrSqliteSession *session = p;
  if (session->session != NULL) sqlite3session_delete(session->session);
  session->session = NULL;
  scr_cyc_free(session);
}

/* A session freed without collection: delete it, release the database,
 * then the block. */
static void scr_sqlite_session_destroy(ScrSqliteSession *session) {
  ScrSqliteDb *db = session->db;
  scr_sqlite_session_delete(session);
  if (db != &scr_sqlite_closed_db) scr_sqlite_db_release(db);
  scr_sqlite_session_gcfree(session);
}

static void scr_sqlite_session_release(void *h) {
  ScrSqliteSession *session = h;
  if (session == NULL) return;
  if (--session->rc > 0) {
    scr_cyc_released(session);
    return;
  }
  scr_cyc_dead(session);
  scr_rc_destroy(session, (void (*)(void *))scr_sqlite_session_destroy);
}

static void scr_sqlite_session_trace(void *p, ScrTraceVisit visit, void *ctx) {
  ScrSqliteSession *session = p;
  visit(session->db, ctx);
}

/* Node's Session::Delete: frees the SQLite session and untracks it. */
static void scr_sqlite_session_delete(ScrSqliteSession *session) {
  if (session->session == NULL) return;
  sqlite3session_delete(session->session);
  session->session = NULL;
  scr_sqlite_session_untrack(session->db, session);
}

/* Node's DatabaseSync::DeleteSessions: every session dies with its
 * connection. */
static void scr_sqlite_db_delete_sessions(ScrSqliteDb *db) {
  while (db->session_n > 0) {
    ScrSqliteSession *session = db->sessions[db->session_n - 1];
    db->sessions[db->session_n - 1] = NULL;
    db->session_n--;
    if (session->session != NULL) {
      sqlite3session_delete(session->session);
      session->session = NULL;
    }
    /* The database's reference to the session goes; a program that still
     * holds the session keeps a closed one. */
    scr_sqlite_session_release(session);
  }
}

static ScrDyn *scr_sqlite_session_changeset(ScrSqliteSession *session, bool patch) {
  if (session->db->conn == NULL) {
    scr_sqlite_invalid_state("database is not open");
    return NULL;
  }
  if (session->session == NULL) {
    scr_sqlite_invalid_state("session is not open");
    return NULL;
  }
  session->generating = true;
  int size = 0;
  void *data = NULL;
  int r = patch ? sqlite3session_patchset(session->session, &size, &data)
                : sqlite3session_changeset(session->session, &size, &data);
  session->generating = false;
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(session->db);
    sqlite3_free(data);
    return NULL;
  }
  ScrDyn *out = scr_sqlite_uint8_copy(data, (size_t)(size > 0 ? size : 0));
  sqlite3_free(data);
  return out;
}

static ScrDyn *scr_sqlite_session_dispose_call(ScrClosure *clo, ScrDyn *const *args, size_t argc);

static ScrDyn *scr_sqlite_session_invoke(void *h, ScrDyn *self, const char *method,
                                         ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  ScrSqliteSession *session = h;
  if (strcmp(method, "changeset") == 0 || strcmp(method, "patchset") == 0)
    return scr_sqlite_session_changeset(session, strcmp(method, "patchset") == 0);
  if (strcmp(method, "close") == 0) {
    if (session->db->conn == NULL) {
      scr_sqlite_invalid_state("database is not open");
      return NULL;
    }
    if (session->session == NULL) {
      scr_sqlite_invalid_state("session is not open");
      return NULL;
    }
    if (session->generating) {
      scr_sqlite_invalid_state("session is currently in use");
      return NULL;
    }
    scr_sqlite_session_delete(session);
    /* The database's reference goes with it. */
    scr_sqlite_session_release(session);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  scr_sqlite_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_sqlite_session_get(void *h, const char *key, size_t len) {
  (void)h;
  (void)key;
  (void)len;
  return NULL;
}

static ScrDyn *scr_sqlite_session_symbol_get(void *h, const ScrDyn *key) {
  (void)h;
  if (!scr_dyn_is_dispose_symbol(key)) return NULL;
  ScrClosure *clo = scr_closure_new(NULL, 0);
  return scr_dyn_new_func(clo, scr_sqlite_session_dispose_call, 0, "", "[Symbol.dispose]");
}

static const ScrDynHandleMethod scr_sqlite_session_methods[] = {
    {"changeset", 0, false, NULL, NULL},
    {"patchset", 0, false, NULL, NULL},
    {"close", 0, false, NULL, NULL},
    {NULL, 0, false, NULL, NULL},
};

static ScrDyn *scr_sqlite_session_inspect_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

static const ScrDynHandleOps scr_sqlite_session_ops = {
    .cls = "Session",
    .retain = scr_sqlite_session_retain,
    .release = scr_sqlite_session_release,
    .invoke = scr_sqlite_session_invoke,
    .get = scr_sqlite_session_get,
    .inspect_view = scr_sqlite_session_inspect_view,
    .inspect_view_empty = true,
    .json_empty_object = true,
    .symbol_get = scr_sqlite_session_symbol_get,
    .methods = scr_sqlite_session_methods,
    .own_names = scr_sqlite_no_own_names,
    .own_view = scr_sqlite_no_own_view,
};

static ScrDyn *scr_sqlite_session_dispose_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  (void)args;
  (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrSqliteSession *session =
      self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_SQLITE_SESSION
          ? self->v.handle.ptr
          : NULL;
  ScrDyn *out = NULL;
  if (session != NULL) {
    /* Disposal swallows the state errors of an already closed session. */
    if (session->db->conn != NULL && session->session != NULL && !session->generating) {
      scr_sqlite_session_delete(session);
      scr_sqlite_session_release(session);
    }
    out = scr_dyn_retain(scr_dyn_undefined());
  } else {
    scr_sqlite_not_a_function("[Symbol.dispose]");
  }
  scr_dyn_release(self);
  return out;
}

/* DatabaseSync::CreateSession. +1 or NULL with the exception pending. */
static ScrDyn *scr_sqlite_db_create_session(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  ScrDyn *options = scr_dyn_retain((ScrDyn *)scr_sqlite_arg(args, argc, 0));
  const char *table = NULL;
  const char *db_name = "main";
  ScrStr *held_table = NULL;
  ScrStr *held_db = NULL;
  if (options->kind != SCR_DYN_UNDEF) {
    if (!scr_sqlite_object_like(options)) {
      scr_dyn_release(options);
      scr_sqlite_invalid_arg_type("The \"options\" argument must be an object.");
      return NULL;
    }
    ScrDyn *table_value = scr_sqlite_get(options, "table");
    ScrDyn *db_value = scr_sqlite_get(options, "db");
    if (table_value == NULL || db_value == NULL) {
      scr_dyn_release(table_value);
      scr_dyn_release(db_value);
      scr_dyn_release(options);
      return NULL;
    }
    if (table_value->kind != SCR_DYN_UNDEF) {
      if (table_value->kind != SCR_DYN_STR) {
        scr_dyn_release(table_value);
        scr_dyn_release(db_value);
        scr_dyn_release(options);
        scr_sqlite_invalid_arg_type("The \"options.table\" argument must be a string.");
        return NULL;
      }
      held_table = scr_str_retain(table_value->v.str);
      table = held_table->data;
    }
    if (db_value->kind != SCR_DYN_UNDEF) {
      if (db_value->kind != SCR_DYN_STR) {
        scr_str_release(held_table);
        scr_dyn_release(table_value);
        scr_dyn_release(db_value);
        scr_dyn_release(options);
        scr_sqlite_invalid_arg_type("The \"options.db\" argument must be a string.");
        return NULL;
      }
      held_db = scr_str_retain(db_value->v.str);
      db_name = held_db->data;
    }
    scr_dyn_release(table_value);
    scr_dyn_release(db_value);
  }
  scr_dyn_release(options);

  sqlite3_session *raw = NULL;
  int r = sqlite3session_create(db->conn, db_name, &raw);
  if (r != SQLITE_OK) {
    scr_str_release(held_table);
    scr_str_release(held_db);
    scr_sqlite_throw_db_error(db);
    return NULL;
  }
  r = sqlite3session_attach(raw, table);
  if (r != SQLITE_OK) {
    sqlite3session_delete(raw);
    scr_str_release(held_table);
    scr_str_release(held_db);
    scr_sqlite_throw_db_error(db);
    return NULL;
  }
  scr_str_release(held_table);
  scr_str_release(held_db);

  ScrSqliteSession *session = scr_cyc_alloc(sizeof *session, &scr_sqlite_session_cyc);
  session->rc = 1;
  session->db = scr_sqlite_db_retain(db);
  session->session = raw;
  if (db->session_n == db->session_cap) {
    size_t cap = db->session_cap != 0 ? db->session_cap * 2 : 4;
    void *grown = realloc(db->sessions, cap * sizeof *db->sessions);
    if (grown == NULL) scr_sqlite_oom();
    db->sessions = grown;
    db->session_cap = cap;
  }
  scr_sqlite_session_retain(session);
  db->sessions[db->session_n++] = session;
  scr_dyn_handle_install(SCR_DYNH_SQLITE_SESSION, &scr_sqlite_session_ops);
  ScrDyn *out = scr_dyn_new_handle(session, SCR_DYNH_SQLITE_SESSION);
  scr_sqlite_session_release(session);
  return out;
}

/* ── extension loading and the authorizer ───────────────────────────── */

/* ERR_LOAD_SQLITE_EXTENSION with the extension loader's message. */
static void scr_sqlite_throw_extension_error(const char *message) {
  ScrStr *msg = scr_str_new(message != NULL ? message : "failed to load extension",
                            message != NULL ? strlen(message) : 22);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, "ERR_LOAD_SQLITE_EXTENSION");
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* DatabaseSync::EnableLoadExtension. False with the exception pending. */
static bool scr_sqlite_db_enable_load_extension(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  const ScrDyn *allow = scr_sqlite_arg(args, argc, 0);
  if (allow->kind != SCR_DYN_BOOL) {
    scr_sqlite_invalid_arg_type("The \"allow\" argument must be a boolean.");
    return false;
  }
  if (!db->allow_extension && allow->v.b) {
    scr_sqlite_invalid_state(
        "Cannot enable extension loading because it was disabled at database creation.");
    return false;
  }
  if (sqlite3_db_config(db->conn, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, allow->v.b ? 1 : 0,
                        NULL) != SQLITE_OK) {
    scr_sqlite_throw_db_error(db);
    return false;
  }
  db->extension_enabled = allow->v.b;
  return true;
}

/* DatabaseSync::LoadExtension. False with the exception pending. */
static bool scr_sqlite_db_load_extension(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  if (!db->allow_extension || !db->extension_enabled) {
    scr_sqlite_invalid_state("extension loading is not allowed");
    return false;
  }
  const ScrDyn *path = scr_sqlite_arg(args, argc, 0);
  if (path->kind != SCR_DYN_STR) {
    scr_sqlite_invalid_arg_type("The \"path\" argument must be a string.");
    return false;
  }
  const ScrDyn *entry = scr_sqlite_arg(args, argc, 1);
  const char *entry_point = NULL;
  if (entry->kind == SCR_DYN_STR) entry_point = entry->v.str->data;
  else if (entry->kind != SCR_DYN_UNDEF) {
    scr_sqlite_invalid_arg_type("The \"entryPoint\" argument must be a string.");
    return false;
  }
  char *errmsg = NULL;
  int r = sqlite3_load_extension(db->conn, path->v.str->data, entry_point, &errmsg);
  if (r != SQLITE_OK) {
    scr_sqlite_throw_extension_error(errmsg);
    sqlite3_free(errmsg);
    return false;
  }
  return true;
}

/* One string parameter of the authorizer callback: Node's
 * NullableSQLiteStringToValue. +1. */
static ScrDyn *scr_sqlite_nullable(const char *text) {
  return text != NULL ? scr_sqlite_str_dyn(text) : scr_dyn_new_null();
}

/* DatabaseSync::AuthorizerCallback: hands the callback the action code and
 * the four nullable names, and reads its authorization code back. */
static int scr_sqlite_authorizer(void *user_data, int action, const char *p1, const char *p2,
                                 const char *p3, const char *p4) {
  ScrSqliteDb *db = user_data;
  if (db->authorizer == NULL) return SQLITE_OK;
  db->callback_depth++;
  ScrDyn *argv[5] = {
      scr_dyn_new_num((double)action),
      scr_sqlite_nullable(p1),
      scr_sqlite_nullable(p2),
      scr_sqlite_nullable(p3),
      scr_sqlite_nullable(p4),
  };
  scr_dyn_this_push_dyn(scr_dyn_undefined());
  ScrDyn *result = scr_dyn_call(db->authorizer, argv, 5, "authorizer");
  scr_dyn_this_pop();
  for (size_t i = 0; i < 5; i++) scr_dyn_release(argv[i]);
  db->callback_depth--;
  if (result == NULL) {
    db->ignore_next_error = true;
    return SQLITE_DENY;
  }
  int code = SQLITE_DENY;
  if (result->kind != SCR_DYN_NUM || result->v.num != trunc(result->v.num)) {
    static const char message[] =
        "Authorizer callback must return an integer authorization code";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    db->ignore_next_error = true;
  } else {
    int value = (int)result->v.num;
    if (value != SQLITE_OK && value != SQLITE_DENY && value != SQLITE_IGNORE) {
      static const char invalid[] =
          "Authorizer callback returned a invalid authorization code";
      scr_throw_error_msg(SCR_ERR_RANGE, invalid, sizeof invalid - 1);
      db->ignore_next_error = true;
    } else {
      code = value;
    }
  }
  scr_dyn_release(result);
  return code;
}

/* DatabaseSync::SetAuthorizer. False with the exception pending. */
static bool scr_sqlite_db_set_authorizer(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  const ScrDyn *callback = scr_sqlite_arg(args, argc, 0);
  if (callback->kind == SCR_DYN_NULL) {
    sqlite3_set_authorizer(db->conn, NULL, NULL);
    scr_dyn_release(db->authorizer);
    db->authorizer = NULL;
    return true;
  }
  if (callback->kind != SCR_DYN_FUNC) {
    scr_sqlite_invalid_arg_type("The \"callback\" argument must be a function or null.");
    return false;
  }
  if (sqlite3_set_authorizer(db->conn, scr_sqlite_authorizer, db) != SQLITE_OK) {
    scr_sqlite_throw_db_error(db);
    return false;
  }
  scr_dyn_release(db->authorizer);
  db->authorizer = scr_dyn_retain((ScrDyn *)callback);
  return true;
}

/* ── serialize and deserialize ──────────────────────────────────────── */

/* A Uint8Array copied out of `data` (+1). */
static ScrDyn *scr_sqlite_uint8_copy(const void *data, size_t size) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)size);
  if (size > 0) memcpy(bytes->data, data, size);
  ScrDyn *d = scr_dyn_new_bytes(bytes);
  scr_bytes_release(bytes);
  return d;
}

/* DatabaseSync::Serialize. +1 or NULL with the exception pending. */
static ScrDyn *scr_sqlite_db_serialize(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  ScrDyn *name = scr_dyn_retain((ScrDyn *)scr_sqlite_arg(args, argc, 0));
  const char *db_name = "main";
  if (name->kind != SCR_DYN_UNDEF) {
    if (name->kind != SCR_DYN_STR) {
      scr_dyn_release(name);
      scr_sqlite_invalid_arg_type("The \"dbName\" argument must be a string.");
      return NULL;
    }
    db_name = name->v.str->data;
  }
  sqlite3_int64 size = 0;
  unsigned char *data = sqlite3_serialize(db->conn, db_name, &size, 0);
  if (data == NULL) {
    if (size == 0) {
      scr_dyn_release(name);
      return scr_sqlite_uint8_copy(NULL, 0);
    }
    scr_dyn_release(name);
    scr_sqlite_throw_db_error(db);
    return NULL;
  }
  ScrDyn *out = scr_sqlite_uint8_copy(data, (size_t)size);
  sqlite3_free(data);
  scr_dyn_release(name);
  return out;
}

/* DatabaseSync::Deserialize. False with the exception pending. */
static bool scr_sqlite_db_deserialize(ScrSqliteDb *db, ScrDyn *const *args, size_t argc) {
  ScrDyn *input = scr_dyn_retain((ScrDyn *)scr_sqlite_arg(args, argc, 0));
  if (input->kind != SCR_DYN_BYTES || input->v.bytes->elem != SCR_BYTES_U8 ||
      input->v.bytes->is_data_view) {
    scr_dyn_release(input);
    scr_sqlite_invalid_arg_type("The \"buffer\" argument must be a Uint8Array.");
    return false;
  }
  if (input->v.bytes->len == 0) {
    scr_dyn_release(input);
    scr_sqlite_invalid_arg_value("The \"buffer\" argument must not be empty.");
    return false;
  }
  ScrDyn *options = scr_dyn_retain((ScrDyn *)scr_sqlite_arg(args, argc, 1));
  ScrStr *held = NULL;
  const char *db_name = "main";
  bool ok = true;
  if (options->kind != SCR_DYN_UNDEF) {
    if (!scr_sqlite_object_like(options)) {
      scr_sqlite_invalid_arg_type("The \"options\" argument must be an object.");
      ok = false;
      goto done;
    }
    ScrDyn *name = scr_sqlite_get(options, "dbName");
    if (name == NULL) {
      ok = false;
      goto done;
    }
    if (name->kind != SCR_DYN_UNDEF) {
      if (name->kind != SCR_DYN_STR) {
        scr_dyn_release(name);
        scr_sqlite_invalid_arg_type("The \"options.dbName\" argument must be a string.");
        ok = false;
        goto done;
      }
      /* The SQLite call borrows the name; hold it through the call. */
      held = scr_str_retain(name->v.str);
      db_name = held->data;
    }
    scr_dyn_release(name);
  }
  /* Reading the options ran their getters, and one can detach or resize the
   * buffer: what is copied is the view's state now, not the length measured
   * before. A view the getter detached has no bytes left, which is the empty
   * buffer error Node answers for one that arrives detached. */
  size_t byte_length = scr_bytes_view_usable(input->v.bytes) ? input->v.bytes->len : 0;
  if (byte_length == 0) {
    scr_sqlite_invalid_arg_value("The \"buffer\" argument must not be empty.");
    ok = false;
    goto done;
  }
  unsigned char *buf = sqlite3_malloc64(byte_length);
  if (buf == NULL) {
    scr_throw_error_msg_code(SCR_ERR_ERROR, "Memory allocation failed", 22,
                             "ERR_MEMORY_ALLOCATION_FAILED");
    ok = false;
    goto done;
  }
  memcpy(buf, input->v.bytes->data, byte_length);
  scr_sqlite_db_close_statements(db);
  int r = sqlite3_deserialize(db->conn, db_name, buf, (sqlite3_int64)byte_length,
                              (sqlite3_int64)byte_length,
                              SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE);
  if (r != SQLITE_OK) {
    scr_sqlite_throw_db_error(db);
    ok = false;
  }
done:
  scr_str_release(held);
  scr_dyn_release(options);
  scr_dyn_release(input);
  return ok;
}

static ScrDyn *scr_sqlite_db_invoke(void *h, ScrDyn *self, const char *method,
                                    ScrDyn *const *args, size_t argc, const char *what) {
  ScrSqliteDb *db = h;
  ScrDyn *own = NULL;
  if (scr_sqlite_own_method_call(db->expandos, h, SCR_DYNH_SQLITE_DB, method, self, args, argc,
                                 what, &own))
    return own;

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

  if (strcmp(method, "function") == 0) {
    if (!scr_sqlite_db_register_function(db, args, argc)) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "aggregate") == 0) {
    if (!scr_sqlite_db_register_aggregate(db, args, argc)) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "serialize") == 0) return scr_sqlite_db_serialize(db, args, argc);

  if (strcmp(method, "deserialize") == 0) {
    if (!scr_sqlite_db_deserialize(db, args, argc)) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "enableLoadExtension") == 0) {
    if (!scr_sqlite_db_enable_load_extension(db, args, argc)) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "loadExtension") == 0) {
    if (!scr_sqlite_db_load_extension(db, args, argc)) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "setAuthorizer") == 0) {
    if (!scr_sqlite_db_set_authorizer(db, args, argc)) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }

  if (strcmp(method, "createSession") == 0) return scr_sqlite_db_create_session(db, args, argc);

  if (strcmp(method, "applyChangeset") == 0) return scr_sqlite_db_apply_changeset(db, args, argc);

  if (strcmp(method, "createTagStore") == 0)
    return scr_sqlite_db_create_tag_store(db, args, argc);
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
    /* Node hands out one limits object per database: the database owns it,
     * so a write through a temporary (`db.limits.extra = 1`) reaches every
     * later read, and each read boxes the same state (handle identity is
     * the native pointer). */
    ScrSqliteLimits *l = db->limits_object;
    if (l == NULL) {
      l = scr_cyc_alloc(sizeof *l, &scr_sqlite_limits_cyc);
      l->rc = 1; /* the database's reference */
      l->db = db;
      db->limits_object = l;
    }
    scr_dyn_handle_install(SCR_DYNH_SQLITE_LIMITS, &scr_sqlite_limits_ops);
    return scr_dyn_new_handle(l, SCR_DYNH_SQLITE_LIMITS);
  }
  /* A property JavaScript added to the database object. */
  return scr_sqlite_table_read(db->expandos, key, len, db, SCR_DYNH_SQLITE_DB);
}

/* ── the classes' own properties ──────────────────────────────────────
 * Node's DatabaseSync, StatementSync and SQLTagStore are ordinary objects
 * whose fixed members are class accessors. Reflection lists the accessor
 * names first as enumerable, non-configurable own accessor properties,
 * then the properties JavaScript added as ordinary data properties.
 * Reading their values reads the getters on the call, so a closed
 * database or a finalized statement answers what Node's getters do. */

static const char *const scr_sqlite_db_own[] = {"isOpen", "isTransaction", "limits"};
static const char *const scr_sqlite_stmt_own[] = {"sourceSQL", "expandedSQL"};
static const char *const scr_sqlite_tag_own[] = {"capacity", "db", "size"};
#define SCR_SQLITE_DB_OWN_COUNT ((size_t)(sizeof scr_sqlite_db_own / sizeof scr_sqlite_db_own[0]))
#define SCR_SQLITE_STMT_OWN_COUNT ((size_t)(sizeof scr_sqlite_stmt_own / sizeof scr_sqlite_stmt_own[0]))
#define SCR_SQLITE_TAG_OWN_COUNT ((size_t)(sizeof scr_sqlite_tag_own / sizeof scr_sqlite_tag_own[0]))

/* The canonical name of the class's accessor `key` names, or NULL. */
static const char *scr_sqlite_own_name(const char *const *names, size_t count, const char *key,
                                       size_t len) {
  for (size_t i = 0; i < count; i++)
    if (strlen(names[i]) == len && memcmp(names[i], key, len) == 0) return names[i];
  return NULL;
}

static bool scr_sqlite_is_own_accessor(const char *const *names, size_t count, const char *key,
                                       size_t len) {
  return scr_sqlite_own_name(names, count, key, len) != NULL;
}

/* One getter function per class and property, the one identity every
 * descriptor of that property answers (Node installs one accessor pair per
 * class definition). The functions are kept for the process; a release at
 * exit keeps the leak check quiet. */
typedef struct ScrSqliteAccessorFn {
  ScrDynHandleTag tag;
  const char *name;
  ScrDyn *fn; /* owned */
} ScrSqliteAccessorFn;
static SCR_TL ScrSqliteAccessorFn scr_sqlite_accessor_fns[8];
static SCR_TL size_t scr_sqlite_accessor_fn_count;
static SCR_TL bool scr_sqlite_accessor_fns_teardown;

static void scr_sqlite_accessor_fns_cleanup(void) {
  for (size_t i = 0; i < scr_sqlite_accessor_fn_count; i++)
    scr_dyn_release(scr_sqlite_accessor_fns[i].fn);
  scr_sqlite_accessor_fn_count = 0;
}

/* A getter: closure->fn is the property's static name, and the receiver is
 * brand-checked the way Node's class getter is. */
static ScrDyn *scr_sqlite_accessor_call(ScrDynHandleTag tag, ScrClosure *closure) {
  const char *name = closure->fn;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind == SCR_DYN_HANDLE && self->v.handle.tag == tag) {
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(self);
    if (ops->get != NULL) result = ops->get(self->v.handle.ptr, name, strlen(name));
    if (result == NULL && !scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
  } else {
    static const char message[] = "Illegal invocation";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_sqlite_db_accessor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  return scr_sqlite_accessor_call(SCR_DYNH_SQLITE_DB, closure);
}

static ScrDyn *scr_sqlite_stmt_accessor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  return scr_sqlite_accessor_call(SCR_DYNH_SQLITE_STATEMENT, closure);
}

static ScrDyn *scr_sqlite_tag_accessor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  return scr_sqlite_accessor_call(SCR_DYNH_SQLITE_TAG_STORE, closure);
}

static ScrDyn *scr_sqlite_accessor_fn(ScrDynHandleTag tag, const char *name) {
  for (size_t i = 0; i < scr_sqlite_accessor_fn_count; i++)
    if (scr_sqlite_accessor_fns[i].tag == tag && strcmp(scr_sqlite_accessor_fns[i].name, name) == 0)
      return scr_dyn_retain(scr_sqlite_accessor_fns[i].fn);
  ScrDynThunk thunk = tag == SCR_DYNH_SQLITE_DB
                           ? scr_sqlite_db_accessor_call
                           : tag == SCR_DYNH_SQLITE_STATEMENT ? scr_sqlite_stmt_accessor_call
                                                              : scr_sqlite_tag_accessor_call;
  ScrDyn *fn = scr_dyn_new_func(scr_closure_new((void *)name, 0), thunk, 0, "native:function", "");
  if (scr_sqlite_accessor_fn_count <
      sizeof scr_sqlite_accessor_fns / sizeof scr_sqlite_accessor_fns[0]) {
    ScrSqliteAccessorFn *slot = &scr_sqlite_accessor_fns[scr_sqlite_accessor_fn_count++];
    slot->tag = tag;
    slot->name = name;
    slot->fn = scr_dyn_retain(fn);
    if (!scr_sqlite_accessor_fns_teardown) {
      scr_sqlite_accessor_fns_teardown = true;
      scr_atexit(scr_sqlite_accessor_fns_cleanup);
    }
  }
  return fn;
}

/* Symbol.for("sqlite-type"), the brand DatabaseSync answers at itself. */
static SCR_TL ScrSym *scr_sqlite_type_symbol;
static SCR_TL bool scr_sqlite_type_symbol_teardown;

static void scr_sqlite_type_symbol_cleanup(void) {
  if (scr_sqlite_type_symbol != NULL && scr_sym_event_ops != NULL)
    scr_sym_event_ops->release(scr_sqlite_type_symbol);
  scr_sqlite_type_symbol = NULL;
}

static ScrSym *scr_sqlite_type_symbol_of(void) {
  if (scr_sqlite_type_symbol != NULL) return scr_sqlite_type_symbol;
  if (scr_sym_event_ops == NULL || scr_sym_event_ops->registry == NULL) return NULL;
  ScrStr *description = scr_str_new("sqlite-type", 11);
  scr_sqlite_type_symbol = scr_sym_event_ops->registry(description);
  scr_str_release(description);
  if (scr_sqlite_type_symbol != NULL && !scr_sqlite_type_symbol_teardown) {
    scr_sqlite_type_symbol_teardown = true;
    scr_atexit(scr_sqlite_type_symbol_cleanup);
  }
  return scr_sqlite_type_symbol;
}

/* The class's own names: the accessors in Node's order, then the added
 * properties in insertion order. */
static ScrDyn *scr_sqlite_own_names_of(const char *const *names, size_t count,
                                       const ScrDyn *expandos) {
  ScrDyn *out = scr_dyn_new_arr();
  for (size_t i = 0; i < count; i++) {
    ScrStr *name = scr_str_new(names[i], strlen(names[i]));
    scr_dyn_arr_push(out, scr_dyn_new_str(name));
    scr_str_release(name);
  }
  if (expandos != NULL) {
    ScrDyn *added = scr_dyn_obj_own_keys(expandos);
    for (size_t i = 0; i < added->v.arr.len; i++)
      scr_dyn_arr_push(out, scr_dyn_retain(added->v.arr.items[i]));
    scr_dyn_release(added);
  }
  return out;
}

/* An added property of a class object: the handle classes keep the
 * properties JavaScript adds in a table, so their attributes (and any
 * accessor) behave as an ordinary object's. */
static bool scr_sqlite_table_prop(const ScrDyn *table, const char *key, size_t len,
                                  ScrDynProp *out) {
  if (table == NULL) return false;
  size_t at = scr_dyn_obj_index_of(table, key, len);
  if (at == SIZE_MAX) return false;
  *out = scr_dyn_obj_prop_at(table, at);
  return true;
}

/* Calls `fn` with the handle as `this` (+1 result). */
static ScrDyn *scr_sqlite_call_with_handle(const ScrDyn *fn, ScrDyn *const *args, size_t argc,
                                           void *h, ScrDynHandleTag tag) {
  ScrDyn *receiver = scr_dyn_new_handle(h, tag);
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(fn, args, argc, "accessor");
  scr_dyn_this_pop();
  scr_dyn_release(receiver);
  return result;
}

/* Reads an added property as an ordinary object read would: its data
 * value, or its getter called with the handle as `this`. NULL when the
 * table has no such property. */
static ScrDyn *scr_sqlite_table_read(const ScrDyn *table, const char *key, size_t len, void *h,
                                     ScrDynHandleTag tag) {
  ScrDynProp prop;
  if (!scr_sqlite_table_prop(table, key, len, &prop)) return NULL;
  if (!prop.accessor) return scr_dyn_retain(prop.value);
  if (prop.getter == NULL) return scr_dyn_retain(scr_dyn_undefined());
  /* A getter may delete or replace itself; keep it alive for the call. */
  ScrDyn *getter = scr_dyn_retain(prop.getter);
  ScrDyn *value = scr_sqlite_call_with_handle(getter, NULL, 0, h, tag);
  scr_dyn_release(getter);
  return value;
}

/* The addresses of the added properties in enumeration order. */
static bool scr_sqlite_assign_added(ScrDyn **expandos, const char *key, size_t len,
                                    const ScrDyn *value) {
  if (*expandos == NULL) *expandos = scr_dyn_new_obj();
  scr_dyn_obj_set(*expandos, key, len, scr_dyn_retain((ScrDyn *)value));
  return true;
}

/* Appends the added properties to a snapshot view, the way JSON, the key
 * walks and util.inspect read them: enumerable ones, with an accessor's
 * getter run (the handle is its receiver). */
static void scr_sqlite_add_expandos(ScrDyn *view, const ScrDyn *expandos, void *h,
                                    ScrDynHandleTag tag) {
  if (expandos == NULL) return;
  ScrDyn *added = scr_dyn_obj_own_keys(expandos);
  for (size_t i = 0; i < added->v.arr.len && !scr_exc_pending(); i++) {
    const ScrStr *name = added->v.arr.items[i]->v.str;
    ScrDynProp prop;
    if (!scr_sqlite_table_prop(expandos, name->data, name->len, &prop) || !prop.enumerable) continue;
    ScrDyn *value;
    if (!prop.accessor) value = scr_dyn_retain(prop.value);
    else if (prop.getter == NULL) value = scr_dyn_retain(scr_dyn_undefined());
    else {
      /* A getter may delete or replace itself; keep it alive for the call. */
      ScrDyn *getter = scr_dyn_retain(prop.getter);
      value = scr_sqlite_call_with_handle(getter, NULL, 0, h, tag);
      scr_dyn_release(getter);
    }
    if (value != NULL) scr_dyn_obj_set(view, name->data, name->len, value);
  }
  scr_dyn_release(added);
}

/* Node's descriptor for a class accessor: the shared getter, no setter,
 * enumerable and not configurable. */
static ScrDyn *scr_sqlite_accessor_descriptor(ScrDynHandleTag tag, const char *name) {
  ScrDyn *out = scr_dyn_new_obj();
  scr_dyn_obj_set(out, "get", 3, scr_sqlite_accessor_fn(tag, name));
  scr_dyn_obj_set(out, "set", 3, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(out, "enumerable", 10, scr_dyn_new_bool(true));
  scr_dyn_obj_set(out, "configurable", 12, scr_dyn_new_bool(false));
  return out;
}

/* The descriptor of an added property, read from its table (no class
 * state, so it answers on a closed database too). */
static ScrDyn *scr_sqlite_expando_descriptor(const ScrDyn *expandos, const char *key,
                                             size_t len) {
  ScrDynProp prop;
  if (!scr_sqlite_table_prop(expandos, key, len, &prop))
    return scr_dyn_retain(scr_dyn_undefined());
  ScrStr *name = scr_str_new(key, len);
  ScrDyn *out = scr_dyn_own_descriptor(expandos, name);
  scr_str_release(name);
  return out != NULL ? out : scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

/* The class's own enumerable names: the accessors (all enumerable), then
 * the added properties that are enumerable. */
static ScrDyn *scr_sqlite_enum_names_of(const char *const *names, size_t count,
                                        const ScrDyn *expandos) {
  ScrDyn *out = scr_dyn_new_arr();
  for (size_t i = 0; i < count; i++) {
    ScrStr *name = scr_str_new(names[i], strlen(names[i]));
    scr_dyn_arr_push(out, scr_dyn_new_str(name));
    scr_str_release(name);
  }
  if (expandos != NULL) {
    ScrDyn *added = scr_dyn_obj_own_keys(expandos);
    for (size_t i = 0; i < added->v.arr.len; i++) {
      const ScrStr *name = added->v.arr.items[i]->v.str;
      ScrDynProp prop;
      if (scr_sqlite_table_prop(expandos, name->data, name->len, &prop) && prop.enumerable)
        scr_dyn_arr_push(out, scr_dyn_retain(added->v.arr.items[i]));
    }
    scr_dyn_release(added);
  }
  return out;
}

/* V8's TypeError for writing a property that has only a getter. */
static void scr_sqlite_getter_only(const char *cls, const char *key, size_t len) {
  char message[192];
  snprintf(message, sizeof message, "Cannot set property %.*s of #<%s> which has only a getter",
           (int)len, key, cls);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

/* A write of an added property: an accessor runs its setter (a getter-only
 * accessor refuses as V8 does, which sloppy code ignores), a non-writable
 * data property refuses, anything else stores. */
static bool scr_sqlite_table_write(ScrDyn **expandos, const char *cls, void *h,
                                   ScrDynHandleTag tag, const char *key, size_t len,
                                   const ScrDyn *value) {
  ScrDynProp prop;
  if (scr_sqlite_table_prop(*expandos, key, len, &prop)) {
    if (prop.accessor) {
      if (prop.setter == NULL) {
        scr_sqlite_getter_only(cls, key, len);
        scr_dyn_assign_failure_note();
        return true;
      }
      /* A setter may delete or replace itself; keep it alive for the call. */
      ScrDyn *setter = scr_dyn_retain(prop.setter);
      ScrDyn *const args[] = {(ScrDyn *)value};
      ScrDyn *result = scr_sqlite_call_with_handle(setter, args, 1, h, tag);
      scr_dyn_release(setter);
      scr_dyn_release(result);
      return true;
    }
    if (!prop.writable) {
      char message[192];
      snprintf(message, sizeof message,
               "Cannot assign to read only property %.*s of object '#<%s>'", (int)len, key, cls);
      scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
      scr_dyn_assign_failure_note();
      return true;
    }
  }
  return scr_sqlite_assign_added(expandos, key, len, value);
}

/* An added property shadows the class's method of the same name, as an own
 * property shadows a prototype method in Node: a callable runs with the
 * handle as `this`, and any other value is V8's "not a function" TypeError.
 * Answers false when `method` names no added property. */
static bool scr_sqlite_own_method_call(ScrDyn *expandos, void *h, ScrDynHandleTag tag,
                                       const char *method, ScrDyn *self,
                                       ScrDyn *const *args, size_t argc, const char *what,
                                       ScrDyn **out) {
  /* A call coming from a saved method value of this very handle and method
   * (`db.exec = db.exec`) runs the implementation: the value is the class's
   * method, not a replacement. The check runs before the property is read, so
   * an accessor written over the property is not entered for it — and a
   * function the program wrote there is dispatched as it was written. */
  if (scr_dyn_method_value_target == h && scr_dyn_method_value_name != NULL &&
      strcmp(scr_dyn_method_value_name, method) == 0)
    return false;
  ScrDynProp prop;
  if (!scr_sqlite_table_prop(expandos, method, strlen(method), &prop)) return false;
  ScrDyn *callable;
  if (prop.accessor) {
    if (prop.getter == NULL) callable = scr_dyn_retain(scr_dyn_undefined());
    else {
      ScrDyn *getter = scr_dyn_retain(prop.getter);
      callable = scr_sqlite_call_with_handle(getter, NULL, 0, h, tag);
      scr_dyn_release(getter);
    }
  } else callable = scr_dyn_retain(prop.value);
  if (callable == NULL || scr_exc_pending()) {
    scr_dyn_release(callable);
    *out = NULL;
    return true;
  }
  if (!scr_dyn_is_callable(callable)) {
    scr_dyn_release(callable);
    char message[192];
    snprintf(message, sizeof message, "%s is not a function", what != NULL ? what : method);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    *out = NULL;
    return true;
  }
  scr_dyn_this_push_dyn(self);
  *out = scr_dyn_call(callable, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(callable);
  return true;
}

/* Defines an added property with an ordinary object's rules. */
static bool scr_sqlite_define_added(ScrDyn **expandos, const char *key, size_t len,
                                    ScrDyn *snapshot) {
  if (*expandos == NULL) *expandos = scr_dyn_new_obj();
  ScrStr *name = scr_str_new(key, len);
  ScrDyn *key_value = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *defined = scr_dyn_define_property(*expandos, key_value, snapshot);
  scr_dyn_release(key_value);
  bool ok = defined != NULL && !scr_exc_pending();
  scr_dyn_release(defined);
  return ok;
}

/* Object.defineProperty on a class object: a class accessor answers only
 * its own getter and attributes (V8's identity rule for a non-configurable
 * accessor), and any other key is an added property. */
static bool scr_sqlite_define_own(const char *const *names, size_t count, ScrDynHandleTag tag,
                                  void *h, ScrDyn **expandos, const char *key, size_t len,
                                  ScrDyn *descriptor) {
  ScrDyn *snapshot = scr_dyn_descriptor_snapshot(descriptor);
  if (snapshot == NULL) return true;
  const char *accessor_name = scr_sqlite_own_name(names, count, key, len);
  if (accessor_name == NULL) {
    /* An added property: the ordinary rules (attributes, non-configurable
     * properties, accessors). A refusal leaves its TypeError pending. */
    (void)scr_sqlite_define_added(expandos, key, len, snapshot);
    scr_dyn_release(snapshot);
    return true;
  }
  ScrDyn *get = scr_dyn_obj_get(snapshot, "get", 3);
  ScrDyn *set = scr_dyn_obj_get(snapshot, "set", 3);
  ScrDyn *value = scr_dyn_obj_get(snapshot, "value", 5);
  ScrDyn *writable = scr_dyn_obj_get(snapshot, "writable", 8);
  ScrDyn *enumerable = scr_dyn_obj_get(snapshot, "enumerable", 10);
  ScrDyn *configurable = scr_dyn_obj_get(snapshot, "configurable", 12);
  ScrDyn *expected = scr_sqlite_accessor_fn(tag, accessor_name);
  /* V8's validation for a non-configurable accessor: only the fields that
   * leave it unchanged may be given (an absent field, the same getter, the
   * absent setter, the same enumerable, a false configurable). */
  bool get_unchanged =
      get == NULL || (get->kind == SCR_DYN_FUNC && scr_dyn_strict_eq(get, expected));
  bool set_unchanged = set == NULL || set->kind == SCR_DYN_UNDEF;
  bool allowed = get_unchanged && set_unchanged && value == NULL && writable == NULL &&
                 (enumerable == NULL || scr_dyn_truthy(enumerable)) &&
                 (configurable == NULL || !scr_dyn_truthy(configurable));
  scr_dyn_release(expected);
  if (!allowed) {
    char message[160];
    snprintf(message, sizeof message, "Cannot redefine property: %.*s", (int)len, key);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  }
  scr_dyn_release(snapshot);
  return true;
}

/* An inspect view: the accessors as getter properties (so the inspector
 * prints [Getter] without reading them) and the added properties. */
/* An inspect view's getters close over the handle they read, so
 * util.inspect's `getters: true` answers the class's values while the view
 * object (not the handle) is the receiver. */
static ScrDyn *scr_sqlite_inspect_getter_call(ScrClosure *closure, ScrDyn *const *args,
                                              size_t argc) {
  (void)args;
  (void)argc;
  const char *name = closure->fn;
  ScrDyn *receiver = scr_box_get_ref(closure->caps[0]);
  ScrDyn *result = NULL;
  if (receiver != NULL) {
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(receiver);
    if (ops->get != NULL) result = ops->get(receiver->v.handle.ptr, name, strlen(name));
    if (result == NULL && !scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
    scr_dyn_release(receiver);
  }
  return result;
}

static ScrDyn *scr_sqlite_inspect_getter(ScrDynHandleTag tag, const char *name, void *h) {
  ScrClosure *closure = scr_closure_new((void *)name, 1);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_new_handle(h, tag));
  return scr_dyn_new_func(closure, scr_sqlite_inspect_getter_call, 0, "native:function", "");
}

/* An added property's accessor, closed over the handle it must see as
 * `this` when util.inspect's getters run it. */
static ScrDyn *scr_sqlite_inspect_user_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *receiver = scr_box_get_ref(closure->caps[0]);
  ScrDyn *fn = scr_box_get_ref(closure->caps[1]);
  ScrDyn *result = NULL;
  if (receiver != NULL && fn != NULL) {
    scr_dyn_this_push_dyn(receiver);
    result = scr_dyn_call(fn, NULL, 0, "get");
    scr_dyn_this_pop();
  }
  scr_dyn_release(fn);
  scr_dyn_release(receiver);
  return result;
}

static ScrDyn *scr_sqlite_inspect_user_fn(ScrDynHandleTag tag, void *h, ScrDyn *fn) {
  ScrClosure *closure = scr_closure_new(NULL, 2);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_new_handle(h, tag));
  closure->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[1], scr_dyn_retain(fn));
  return scr_dyn_new_func(closure, scr_sqlite_inspect_user_call, 0, "native:function", "");
}

/* The added properties for an inspect view: enumerable ones, with accessors
 * kept as [Getter]/[Setter] rather than their values. */
static void scr_sqlite_inspect_expandos(ScrDyn *view, const ScrDyn *expandos, ScrDynHandleTag tag,
                                        void *h) {
  if (expandos == NULL) return;
  ScrDyn *added = scr_dyn_obj_own_keys(expandos);
  for (size_t i = 0; i < added->v.arr.len && !scr_exc_pending(); i++) {
    const ScrStr *name = added->v.arr.items[i]->v.str;
    ScrDynProp prop;
    if (!scr_sqlite_table_prop(expandos, name->data, name->len, &prop) || !prop.enumerable) continue;
    if (!prop.accessor) {
      scr_dyn_obj_set(view, name->data, name->len, scr_dyn_retain(prop.value));
      continue;
    }
    ScrDyn *getter = prop.getter != NULL ? scr_sqlite_inspect_user_fn(tag, h, prop.getter) : NULL;
    ScrDyn *setter = prop.setter != NULL ? scr_sqlite_inspect_user_fn(tag, h, prop.setter) : NULL;
    scr_dyn_obj_set_accessor(view, name->data, name->len, getter, setter);
  }
  scr_dyn_release(added);
}

static ScrDyn *scr_sqlite_inspect_of(ScrDynHandleTag tag, void *h, const char *const *names,
                                     size_t count, const ScrDyn *expandos) {
  ScrDyn *view = scr_dyn_new_obj();
  for (size_t i = 0; i < count; i++) {
    size_t len = strlen(names[i]);
    scr_dyn_obj_set_accessor(view, names[i], len, scr_sqlite_inspect_getter(tag, names[i], h), NULL);
  }
  scr_sqlite_inspect_expandos(view, expandos, tag, h);
  return view;
}

/* A write of a class accessor: V8's getter-only TypeError, as Node's
 * class accessors raise (no code), which sloppy-mode code ignores. Any
 * other key is an added property with an ordinary object's rules. */
static bool scr_sqlite_own_set(const char *const *names, size_t count, const char *cls,
                               ScrDynHandleTag tag, void *h, const char *key, size_t len,
                               const ScrDyn *value, ScrDyn **expandos) {
  if (scr_sqlite_is_own_accessor(names, count, key, len)) {
    scr_sqlite_getter_only(cls, key, len);
    /* The failure is noted so a sloppy-mode write drops it (V8 ignores a
     * getter-only assignment outside strict code). */
    scr_dyn_assign_failure_note();
    return true;
  }
  return scr_sqlite_table_write(expandos, cls, h, tag, key, len, value);
}

/* `delete`: the accessors are not configurable; an added property goes
 * unless its own definition made it non-configurable. */
static bool scr_sqlite_own_delete(const char *const *names, size_t count, const char *key,
                                  size_t len, ScrDyn **expandos) {
  if (scr_sqlite_is_own_accessor(names, count, key, len)) return false;
  ScrDynProp prop;
  if (!scr_sqlite_table_prop(*expandos, key, len, &prop)) return true;
  if (!prop.configurable) return false;
  ScrStr *name = scr_str_new(key, len);
  scr_dyn_obj_delete_field(*expandos, name);
  scr_str_release(name);
  return true;
}

static ScrDyn *scr_sqlite_stmt_own_names(void *h) {
  ScrSqliteStmt *s = h;
  return scr_sqlite_own_names_of(scr_sqlite_stmt_own, SCR_SQLITE_STMT_OWN_COUNT, s->expandos);
}

static ScrDyn *scr_sqlite_stmt_own_enum_names(void *h) {
  ScrSqliteStmt *s = h;
  return scr_sqlite_enum_names_of(scr_sqlite_stmt_own, SCR_SQLITE_STMT_OWN_COUNT, s->expandos);
}

static ScrDyn *scr_sqlite_stmt_inspect_view(void *h) {
  ScrSqliteStmt *s = h;
  return scr_sqlite_inspect_of(SCR_DYNH_SQLITE_STATEMENT, h, scr_sqlite_stmt_own,
                               SCR_SQLITE_STMT_OWN_COUNT, s->expandos);
}

static ScrDyn *scr_sqlite_stmt_own_view(void *h) {
  ScrSqliteStmt *s = h;
  ScrDyn *view = scr_dyn_new_obj();
  ScrDyn *source = scr_sqlite_stmt_get(h, "sourceSQL", 9);
  if (source == NULL) {
    scr_dyn_release(view);
    return NULL;
  }
  scr_dyn_obj_set(view, "sourceSQL", 9, source);
  ScrDyn *expanded = scr_sqlite_stmt_get(h, "expandedSQL", 11);
  if (expanded == NULL) {
    scr_dyn_release(view);
    return NULL;
  }
  scr_dyn_obj_set(view, "expandedSQL", 11, expanded);
  scr_sqlite_add_expandos(view, s->expandos, h, SCR_DYNH_SQLITE_STATEMENT);
  return view;
}

static ScrDyn *scr_sqlite_stmt_own_descriptor(void *h, const char *key, size_t key_len) {
  ScrSqliteStmt *s = h;
  const char *name = scr_sqlite_own_name(scr_sqlite_stmt_own, SCR_SQLITE_STMT_OWN_COUNT, key, key_len);
  if (name != NULL) return scr_sqlite_accessor_descriptor(SCR_DYNH_SQLITE_STATEMENT, name);
  return scr_sqlite_expando_descriptor(s->expandos, key, key_len);
}

static bool scr_sqlite_stmt_own_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrSqliteStmt *s = h;
  return scr_sqlite_own_set(scr_sqlite_stmt_own, SCR_SQLITE_STMT_OWN_COUNT, "StatementSync",
                            SCR_DYNH_SQLITE_STATEMENT, h, key, key_len, value, &s->expandos);
}

static bool scr_sqlite_stmt_own_delete(void *h, const char *key, size_t key_len) {
  ScrSqliteStmt *s = h;
  return scr_sqlite_own_delete(scr_sqlite_stmt_own, SCR_SQLITE_STMT_OWN_COUNT, key, key_len,
                               &s->expandos);
}

static bool scr_sqlite_stmt_define_own(void *h, const char *key, size_t key_len,
                                       ScrDyn *descriptor) {
  ScrSqliteStmt *s = h;
  return scr_sqlite_define_own(scr_sqlite_stmt_own, SCR_SQLITE_STMT_OWN_COUNT,
                               SCR_DYNH_SQLITE_STATEMENT, h, &s->expandos, key, key_len, descriptor);
}

static ScrDyn *scr_sqlite_tag_own_names(void *h) {
  ScrSqliteTagStore *store = h;
  return scr_sqlite_own_names_of(scr_sqlite_tag_own, SCR_SQLITE_TAG_OWN_COUNT, store->expandos);
}

static ScrDyn *scr_sqlite_tag_own_enum_names(void *h) {
  ScrSqliteTagStore *store = h;
  return scr_sqlite_enum_names_of(scr_sqlite_tag_own, SCR_SQLITE_TAG_OWN_COUNT, store->expandos);
}

static ScrDyn *scr_sqlite_tag_inspect_view(void *h) {
  ScrSqliteTagStore *store = h;
  return scr_sqlite_inspect_of(SCR_DYNH_SQLITE_TAG_STORE, h, scr_sqlite_tag_own,
                               SCR_SQLITE_TAG_OWN_COUNT, store->expandos);
}

static ScrDyn *scr_sqlite_tag_own_view(void *h) {
  ScrSqliteTagStore *store = h;
  ScrDyn *view = scr_dyn_new_obj();
  ScrDyn *capacity = scr_sqlite_tag_get(h, "capacity", 8);
  if (capacity == NULL) {
    scr_dyn_release(view);
    return NULL;
  }
  scr_dyn_obj_set(view, "capacity", 8, capacity);
  ScrDyn *db = scr_sqlite_tag_get(h, "db", 2);
  if (db == NULL) {
    scr_dyn_release(view);
    return NULL;
  }
  scr_dyn_obj_set(view, "db", 2, db);
  ScrDyn *size = scr_sqlite_tag_get(h, "size", 4);
  if (size == NULL) {
    scr_dyn_release(view);
    return NULL;
  }
  scr_dyn_obj_set(view, "size", 4, size);
  scr_sqlite_add_expandos(view, store->expandos, h, SCR_DYNH_SQLITE_TAG_STORE);
  return view;
}

static ScrDyn *scr_sqlite_tag_own_descriptor(void *h, const char *key, size_t key_len) {
  ScrSqliteTagStore *store = h;
  const char *name = scr_sqlite_own_name(scr_sqlite_tag_own, SCR_SQLITE_TAG_OWN_COUNT, key, key_len);
  if (name != NULL) return scr_sqlite_accessor_descriptor(SCR_DYNH_SQLITE_TAG_STORE, name);
  return scr_sqlite_expando_descriptor(store->expandos, key, key_len);
}

static bool scr_sqlite_tag_own_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrSqliteTagStore *store = h;
  return scr_sqlite_own_set(scr_sqlite_tag_own, SCR_SQLITE_TAG_OWN_COUNT, "SQLTagStore",
                            SCR_DYNH_SQLITE_TAG_STORE, h, key, key_len, value, &store->expandos);
}

static bool scr_sqlite_tag_own_delete(void *h, const char *key, size_t key_len) {
  ScrSqliteTagStore *store = h;
  return scr_sqlite_own_delete(scr_sqlite_tag_own, SCR_SQLITE_TAG_OWN_COUNT, key, key_len,
                               &store->expandos);
}

static bool scr_sqlite_tag_define_own(void *h, const char *key, size_t key_len,
                                      ScrDyn *descriptor) {
  ScrSqliteTagStore *store = h;
  return scr_sqlite_define_own(scr_sqlite_tag_own, SCR_SQLITE_TAG_OWN_COUNT,
                               SCR_DYNH_SQLITE_TAG_STORE, h, &store->expandos, key, key_len,
                               descriptor);
}

static ScrDyn *scr_sqlite_db_own_names(void *h) {
  ScrSqliteDb *db = h;
  return scr_sqlite_own_names_of(scr_sqlite_db_own, SCR_SQLITE_DB_OWN_COUNT, db->expandos);
}

static ScrDyn *scr_sqlite_db_own_enum_names(void *h) {
  ScrSqliteDb *db = h;
  return scr_sqlite_enum_names_of(scr_sqlite_db_own, SCR_SQLITE_DB_OWN_COUNT, db->expandos);
}

/* Adds DatabaseSync's Symbol(sqlite-type) brand to a view: the symbol Node
 * registers and reads as the module's name. */
static void scr_sqlite_db_add_brand(ScrDyn *view) {
  ScrSym *type = scr_sqlite_type_symbol_of();
  if (type == NULL || scr_sym_event_ops == NULL) return;
  ScrDyn *key = scr_sym_event_ops->box(type);
  /* symbol_key_set borrows the value. */
  ScrDyn *value = scr_sqlite_str_dyn("node:sqlite");
  scr_dyn_symbol_key_set(view, key, value);
  scr_dyn_release(value);
  scr_dyn_release(key);
}

static ScrDyn *scr_sqlite_db_inspect_view(void *h) {
  ScrSqliteDb *db = h;
  ScrDyn *view = scr_sqlite_inspect_of(SCR_DYNH_SQLITE_DB, h, scr_sqlite_db_own,
                                       SCR_SQLITE_DB_OWN_COUNT, db->expandos);
  scr_sqlite_db_add_brand(view);
  return view;
}

/* DatabaseSync's own symbol-keyed properties: its brand. */
static ScrDyn *scr_sqlite_db_own_symbols(void *h) {
  (void)h;
  ScrDyn *view = scr_dyn_new_obj();
  scr_sqlite_db_add_brand(view);
  return view;
}

static ScrDyn *scr_sqlite_db_own_view(void *h) {
  ScrSqliteDb *db = h;
  ScrDyn *view = scr_dyn_new_obj();
  ScrDyn *is_open = scr_sqlite_db_get(h, "isOpen", 6);
  if (is_open == NULL) {
    scr_dyn_release(view);
    return NULL;
  }
  scr_dyn_obj_set(view, "isOpen", 6, is_open);
  ScrDyn *in_transaction = scr_sqlite_db_get(h, "isTransaction", 13);
  if (in_transaction == NULL) {
    scr_dyn_release(view);
    return NULL;
  }
  scr_dyn_obj_set(view, "isTransaction", 13, in_transaction);
  ScrDyn *limits = scr_sqlite_db_get(h, "limits", 6);
  if (limits == NULL) {
    scr_dyn_release(view);
    return NULL;
  }
  scr_dyn_obj_set(view, "limits", 6, limits);
  scr_sqlite_add_expandos(view, db->expandos, h, SCR_DYNH_SQLITE_DB);
  return view;
}

static ScrDyn *scr_sqlite_db_own_descriptor(void *h, const char *key, size_t key_len) {
  ScrSqliteDb *db = h;
  const char *name = scr_sqlite_own_name(scr_sqlite_db_own, SCR_SQLITE_DB_OWN_COUNT, key, key_len);
  if (name != NULL) return scr_sqlite_accessor_descriptor(SCR_DYNH_SQLITE_DB, name);
  return scr_sqlite_expando_descriptor(db->expandos, key, key_len);
}

static bool scr_sqlite_db_own_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrSqliteDb *db = h;
  return scr_sqlite_own_set(scr_sqlite_db_own, SCR_SQLITE_DB_OWN_COUNT, "DatabaseSync",
                            SCR_DYNH_SQLITE_DB, h, key, key_len, value, &db->expandos);
}

static bool scr_sqlite_db_own_delete(void *h, const char *key, size_t key_len) {
  ScrSqliteDb *db = h;
  return scr_sqlite_own_delete(scr_sqlite_db_own, SCR_SQLITE_DB_OWN_COUNT, key, key_len,
                               &db->expandos);
}

static bool scr_sqlite_db_define_own(void *h, const char *key, size_t key_len,
                                     ScrDyn *descriptor) {
  ScrSqliteDb *db = h;
  return scr_sqlite_define_own(scr_sqlite_db_own, SCR_SQLITE_DB_OWN_COUNT, SCR_DYNH_SQLITE_DB, h,
                               &db->expandos, key, key_len, descriptor);
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
  ScrSym *type = scr_sqlite_type_symbol_of();
  if (type != NULL && key->kind == SCR_DYN_SYMBOL && key->v.symbol.value == type)
    return scr_sqlite_str_dyn("node:sqlite");
  if (!scr_dyn_is_dispose_symbol(key)) return NULL;
  ScrClosure *clo = scr_closure_new(NULL, 0);
  return scr_dyn_new_func(clo, scr_sqlite_db_dispose_call, 0, "", "[Symbol.dispose]");
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
    .set = scr_sqlite_db_own_set,
    .inspect_view = scr_sqlite_db_inspect_view,
    .symbol_get = scr_sqlite_db_symbol_get,
    .json_empty_object = true,
    .methods = scr_sqlite_db_methods,
    .own_names = scr_sqlite_db_own_names,
    .own_view = scr_sqlite_db_own_view,
    .own_descriptor = scr_sqlite_db_own_descriptor,
    .delete_key = scr_sqlite_db_own_delete,
    .own_symbols = scr_sqlite_db_own_symbols,
    .own_enumerable_names = scr_sqlite_db_own_enum_names,
    .define_own = scr_sqlite_db_define_own,
    .inspect_bracketed_past_depth = true,
};

/* A handle box around a live database (the SQLTagStore#db getter). */
static ScrDyn *scr_sqlite_db_box(ScrSqliteDb *db) {
  scr_dyn_handle_install(SCR_DYNH_SQLITE_DB, &scr_sqlite_db_ops);
  return scr_dyn_new_handle(db, SCR_DYNH_SQLITE_DB);
}

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

  ScrSqliteDb *db = scr_cyc_alloc(sizeof *db, &scr_sqlite_db_cyc);
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
    scr_cyc_free(db);                \
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
    free(db->sessions);
    scr_cyc_free(db);
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
                        : kind == 2 ? SCR_DYNH_SQLITE_ITERATOR
                                    : SCR_DYNH_SQLITE_SESSION;
  return value->v.handle.tag == want;
}
