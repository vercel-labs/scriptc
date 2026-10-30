/* scriptc runtime — class hierarchies, class objects, and the Error,
 * DOMException and AggregateError objects (scr_error.c, scr_object.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_ERROR_H
#define SCR_ERROR_H

#include "scr_string.h"

/* ── class hierarchies (single inheritance) ───────────────────────────
 * Classes in an `extends` hierarchy share a two-word object prefix: the
 * usual `size_t rc`, then a pointer to the class's static vtable (emitted
 * per class by the compiler; standalone classes carry no vtable word and
 * none of this applies). A derived class embeds its base's fields as a
 * layout PREFIX, so an upcast is a pointer reinterpret and base-field
 * offsets agree through any static type.
 *
 * The vtable begins with this header; the compiler-emitted concrete
 * per-hierarchy struct appends one member per virtual method slot (only
 * methods actually overridden somewhere get slots — never-overridden
 * methods keep direct static calls). `pre`/`post` are the class's preorder
 * interval in the whole-program class forest: `x instanceof C` is the O(1)
 * range check `C.pre <= x->vt->pre && x->vt->pre <= C.post`. `release` is
 * the class's own whole-object release: releasing through a base-typed
 * pointer must tear down the DERIVED object's fields, so the emitted
 * release of every hierarchy class dispatches through the stored vtable
 * (retain needs no dispatch — rc is at offset 0 in every layout). The
 * cycle collector needs no vtable involvement: a cycle-capable hierarchy
 * object's header trace/teardown are stamped with the concrete class's
 * functions at allocation, which already is dynamic dispatch. */
typedef struct ScrVt {
  size_t pre, post;
  void (*release)(void *obj);
} ScrVt;

/* ── class objects (classes as first-class values) ────────────────────
 * Top-level classes use immortal templates. Evaluating a function-local
 * class creates a fresh, traced object that owns its captured binding boxes.
 * Every construct thunk takes the borrowed class object before source
 * arguments. Instances of a local class retain that object for identity and
 * method captures. `pre`/`post` still describe the compiled class hierarchy;
 * local-class instanceof additionally compares the fresh object identity. */
typedef struct ScrClassObj {
  size_t rc;
  size_t pre, post;
  void *ctor;
  const ScrStr *name;
  size_t ncaps;
  size_t length;
  struct ScrBox *prototype_data;
  struct ScrBox *static_data;
  /* The base class's name, which util.inspect prints as
   * `[class C extends B]`; NULL without a named base. */
  const ScrStr *base_name;
  /* Nonzero when the class declares public static fields, which the
   * class object does not carry without static_data. */
  size_t own_static_fields;
  struct ScrBox *caps[];
} ScrClassObj;

static inline ScrClassObj *scr_classobj_retain(ScrClassObj *c) {
  if (c && c->rc != SIZE_MAX) {
    c->rc++;
  }
  return c;
}
void scr_classobj_release(ScrClassObj *c);
void scr_classobj_clear_properties(ScrClassObj *c);
ScrClassObj *scr_classobj_new(const ScrClassObj *template, size_t ncaps);
void scr_classobj_trace_v(void *c, ScrTraceVisit visit, void *ctx);
/* void*-signature RC adapters (container slots) — scr_object.c. */
void *scr_classobj_retain_v(void *c);
void scr_classobj_release_v(void *c);
/* `X.name` (+1 — a no-op retain on the interned immortal). */
ScrStr *scr_classobj_name(ScrClassObj *c);
struct ScrDyn *scr_dyn_class_prototype(struct ScrDyn *value, struct ScrDyn *base);
struct ScrDyn *scr_dyn_class_base_prototype(struct ScrDyn *constructor);
struct ScrDyn *scr_dyn_class_inherit(struct ScrDyn *constructor, struct ScrDyn *base);
void scr_dyn_class_super(struct ScrDyn *constructor, struct ScrDyn *receiver, struct ScrDyn *arguments);
struct ScrDyn *scr_dyn_assign_prototype(struct ScrDyn *target, struct ScrDyn *sources, struct ScrDyn *protected_keys);
struct ScrDyn *scr_dyn_bag_get(struct ScrDyn *bag, ScrStr *key, struct ScrDyn *receiver);
struct ScrDyn *scr_dyn_reflect_get(struct ScrDyn *target, struct ScrDyn *key, struct ScrDyn *receiver);
bool scr_dyn_reflect_set(struct ScrDyn *target, struct ScrDyn *key, struct ScrDyn *value, struct ScrDyn *receiver);
bool scr_dyn_reflect_define(struct ScrDyn *receiver, struct ScrDyn *key, struct ScrDyn *value);
bool scr_dyn_abstract_eq(const struct ScrDyn *left, const struct ScrDyn *right);
int scr_dyn_function_kind(const struct ScrDyn *value);
void scr_dyn_bag_set(struct ScrDyn *bag, ScrStr *key, struct ScrDyn *value, struct ScrDyn *receiver);
/* The keyed-write miss on a fixed-shape record: throws the catchable
 * TypeError naming the key (JS would add the property — the documented
 * monomorphic-struct divergence). scr_object.c. */
void scr_record_key_miss(ScrStr *k);

typedef struct ScrError {
  size_t rc;
  const ScrVt *vt;
  ScrStr *name;    /* "TypeError", or whatever the user assigned */
  ScrStr *message; /* "" when constructed without one, like Node */
  ScrStr *code;    /* NULL = absent (Node: no `code` property); fs/exec
                    * throw sites stamp the errno name ("ENOENT"). Part of
                    * the layout prefix: the compiler's %Error class defs
                    * carry a matching third field, so user subclasses
                    * embed the slot and release it NULL-guarded. */
  struct ScrDyn *error_cause; /* NULL = absent; dyn undefined = present */
  bool cause_enumerable; /* assignment creates an enumerable own property */
  bool message_present; /* super() leaves the inherited message property visible */
  bool message_enumerable; /* assignment creates an enumerable own property */
  bool name_present;
  bool name_enumerable;
  ScrStr *stack_frames; /* captured native source frames */
  ScrStr *stack; /* lazily formatted, cached stack */
  double system_errno; /* present when system_call is non-NULL or this is
                        * nonzero (zlib errors carry errno without syscall) */
  ScrStr *system_call;
  ScrStr *system_path;
  ScrStr *system_dest;
  /* Node's SystemError (internal/errors.js): the context message and errno
   * name behind `info`; NULL for every other error. */
  ScrStr *system_message;
  ScrStr *system_code;
  bool native_plain; /* a native binding's coded Error: "Name: message", no "[code]" */
  bool errno_order;  /* ErrnoException key order: errno, code, path, syscall */
} ScrError;

enum {
  SCR_ERR_ERROR = 0,
  SCR_ERR_TYPE = 1,
  SCR_ERR_RANGE = 2,
  SCR_ERR_SYNTAX = 3,
  SCR_ERR_DOMEX = 4, /* DOMException — ScrDomException, the wider layout */
  SCR_ERR_REFERENCE = 5,
  SCR_ERR_EVAL = 6,
  SCR_ERR_URI = 7,
  SCR_ERR_AGGREGATE = 8, /* AggregateError — ScrAggregateError, the wider layout */
  SCR_ERR_ASSERTION = 9, /* node:assert's AssertionError — the Error layout */
  SCR_ERR_SUPPRESSED = 10, /* SuppressedError — the Error layout; error and suppressed are view properties */
  SCR_ERR_COUNT = 11,
};

extern SCR_TL ScrVt scr_error_vts[SCR_ERR_COUNT]; /* indexed by SCR_ERR_*; main() stamps pre/post */

struct ScrDyn; /* full declaration below (the checked-dynamic tree section) */

/* DOMException: the ScrError prefix (identical member order — an upcast is
 * a pointer reinterpret) plus the WebIDL slots. The extra slots are HIDDEN
 * from the compiler's IR field list (user `extends DOMException` is fenced
 * so no subclass layout ever overlaps them); reads go through the
 * scr_domex_* accessors. */
typedef struct ScrDomException {
  size_t rc;
  const ScrVt *vt;
  ScrStr *name;    /* "Error" default, or the resolved WebIDL name */
  ScrStr *message; /* "" when constructed without one */
  ScrStr *code;    /* the Node string-code slot (stays NULL here) */
  struct ScrDyn *error_cause; /* shared ScrError prefix; unused by DOMException */
  bool cause_enumerable;
  bool message_present;
  bool message_enumerable;
  bool name_present;
  bool name_enumerable;
  ScrStr *stack_frames;
  ScrStr *stack;
  double system_errno;
  ScrStr *system_call;
  ScrStr *system_path;
  ScrStr *system_dest;
  ScrStr *system_message;
  ScrStr *system_code;
  bool native_plain;
  bool errno_order;
  double dom_code; /* the WebIDL legacy code (0 when the name is off-table) */
  bool has_cause;  /* the options form carried a `cause` member */
  struct ScrDyn *cause; /* owned; NULL when has_cause is false */
} ScrDomException;

/* new DOMException(message?, nameOrOptions?) — both dyn args borrowed,
 * NULL-tolerant (NULL = absent = the dyn undefined). Returns +1. Never
 * throws (dyn ToString is total). Lives in scr_json.c (the args are dyn
 * values); the dyn-free half below stays in scr_error.c so the error
 * unit links without the checked-dynamic tree. */
ScrError *scr_domex_new(const struct ScrDyn *message, const struct ScrDyn *name_or_options);
/* scr_error.c's dyn-free DOMException half: the blank allocation the
 * constructors fill, the WebIDL name→legacy-code table, and the cause
 * teardown hook scr_json.c installs before any cause can exist. */
ScrError *scr_domex_alloc(void);
double scr_domex_code_of(const ScrStr *name);
void scr_domex_install_cause_drop(void (*fn)(void *obj));
double scr_domex_code(ScrError *e);           /* borrowed receiver */
bool scr_domex_has_cause(ScrError *e);        /* borrowed receiver */
struct ScrDyn *scr_domex_cause(ScrError *e);  /* +1 (dyn undefined when absent) */
/* structuredClone of a DOMException: WebIDL serialization — name/message
 * copy, the code re-derives, cause does not serialize. Borrowed receiver
 * and options (validated; throws on bad options / non-empty transfer).
 * +1, NULL after a throw. */
ScrError *scr_domex_clone(ScrError *e, const struct ScrDyn *options);
/* Throw a fresh DOMException through the exception cell (atob/btoa's
 * InvalidCharacterError sites). Copies both C strings; the _str form
 * takes ownership of the message. */
SCR_COLD void scr_throw_domex(const char *name, const char *message);
SCR_COLD void scr_throw_domex_str(const char *name, ScrStr *message);

/* AggregateError: the ScrError prefix plus the `errors` list (a dyn
 * array; NULL until set). Like DOMException's slots it is HIDDEN from
 * the compiler's IR field list (user `extends AggregateError` is fenced)
 * and read through scr_aggregate_errors. The dyn half (construction from
 * an iterable's elements, the list itself) lives in scr_json.c; the
 * teardown drops the list through the hook it installs. */
typedef struct ScrAggregateError {
  ScrError base;
  struct ScrDyn *errors;
} ScrAggregateError;
ScrError *scr_aggregate_alloc(void);
void scr_aggregate_install_errors_drop(void (*fn)(void *obj));
/* new AggregateError(errors, message?, options?) runs in spec order:
 * scr_aggregate_new installs the message and cause (both borrowed, dyn
 * undefined when absent; +1, NULL with an exception pending when the
 * message conversion throws), then the caller iterates `errors` and
 * hands the list to scr_aggregate_set_errors. */
ScrError *scr_aggregate_new(const struct ScrDyn *message, const struct ScrDyn *options);
void scr_aggregate_set_errors(ScrError *e, struct ScrDyn *errors); /* both borrowed */
struct ScrDyn *scr_aggregate_errors(ScrError *e); /* +1 */

/* new SuppressedError(error, suppressed, message) (scr_json.c): the message
 * as in scr_error_new_options, then `error` and `suppressed` as
 * non-enumerable properties of the error's dyn view. All arguments are
 * borrowed (dyn undefined when absent). Returns +1, or NULL with an
 * exception pending when the message conversion throws. */
ScrError *scr_suppressed_new(const struct ScrDyn *error, const struct ScrDyn *suppressed,
                             const struct ScrDyn *message);

/* Switch runtime-side error allocation to collector-headered (called from
 * main() when the compiler's cycle fixpoint marks the hierarchy). */
void scr_error_set_traced(void);

/* Allocate + initialize (name = the kind's builtin name, message retained
 * from the borrowed argument; NULL means ""). Returns +1. */
SCR_COLD ScrError *scr_error_new(int kind, ScrStr *message);
/* Initialize the error prefix of an already-allocated (zeroed) object —
 * the super(message) call of a compiled `extends Error` constructor. Both
 * arguments are borrowed. */
void scr_error_init(void *obj, int kind, ScrStr *message);
/* ECMAScript constructor arguments: dyn undefined defaults the message
 * to ""; an options object's present cause is retained. All args borrowed.
 * Message conversion can throw; new returns NULL with an exception pending.
 * Kept separate so runtime-only throw sites need not link scr_json.c. */
ScrError *scr_error_new_options(int kind, const struct ScrDyn *message, const struct ScrDyn *options);
void scr_error_init_options(void *obj, int kind, const struct ScrDyn *message, const struct ScrDyn *options);
void scr_error_install_cause_drop(void (*fn)(void *obj));
bool scr_error_has_cause(ScrError *e);
struct ScrDyn *scr_error_cause(ScrError *e); /* +1, undefined when absent */
void scr_error_define_cause(ScrError *e, struct ScrDyn *value);
ScrError *scr_error_abort(struct ScrDyn *reason /*borrowed, NULL = undefined*/); /* +1 */
extern SCR_TL ScrError *scr_event_error_payload;
void scr_error_set_cause(ScrError *e, struct ScrDyn *value); /* borrowed operands */
void scr_error_delete_cause(ScrError *e);
/* ECMA Error.prototype.toString: "", name, message, or "name: message".
 * Borrows e, returns +1. */
ScrStr *scr_error_to_string(ScrError *e);
void scr_error_install_message_reader(ScrStr *(*reader)(ScrError *));
void scr_error_install_name_reader(ScrStr *(*reader)(ScrError *));
ScrStr *scr_error_default_name(const ScrError *e);
ScrStr *scr_error_stack(ScrError *e);
/* Replaces the error's stack string, as an assignment to `stack` does.
 * Borrowed operands. */
void scr_error_set_stack(ScrError *e, ScrStr *stack);

ScrError *scr_error_retain(ScrError *e);
void scr_error_release(ScrError *e); /* dispatches through e->vt */
void *scr_error_retain_v(void *e);
void scr_error_release_v(void *e);
void scr_error_trace(void *e, ScrTraceVisit visit, void *ctx); /* no headered children */
ScrTraceFn scr_error_trace_arg(void); /* &scr_error_trace when traced, else NULL */

/* True when a thrown hierarchy object (SCR_EXC_OBJ payload) is an Error —
 * its vtable's preorder lies inside Error's stamped interval. */
bool scr_error_is(const void *obj);

/* Throw a fresh builtin error through the exception cell. scr_throw_error
 * takes ownership of message; the _msg form copies the C string. The _named
 * form takes ownership of both strings and picks the
 * builtin vtable whose class name matches `name` (Error otherwise). */
SCR_COLD void scr_throw_error(int kind, ScrStr *message);
SCR_COLD void scr_throw_error_msg(int kind, const char *message, size_t len);
SCR_COLD void scr_throw_error_named(ScrStr *name, ScrStr *message);
/* A read of a declare-d const nothing defines: throws Node's catchable
 * ReferenceError "<name> is not defined". Borrows name; always throws. */
SCR_COLD void scr_undef_global_read(ScrStr *name);
/* The `code` slot (NodeJS.ErrnoException's .code): set stamps a fresh
 * string from the C literal (replacing any previous value); get answers
 * +1 or NULL when absent (the compiler's undefined arm). The _msg_code
 * thrower is scr_throw_error_msg with the code stamped on the payload. */
void scr_error_set_code(ScrError *e, const char *code);
/* The program's `err.code = s` write into the same slot (and the error's
 * checked-dynamic node, when it has one). Borrows both (scr_json.c). */
void scr_error_set_code_value(ScrError *e, ScrStr *code);
/* `err.code = v` with a value that is not statically a string: a string
 * takes the slot as above; anything else clears the slot and lands on the
 * error's checked-dynamic node, as a dynamic property write would.
 * Borrows both (scr_json.c). */
void scr_error_set_code_dyn(ScrError *e, struct ScrDyn *value);
/* Object.assign(err, ...sources): the copy onto the error's checked-dynamic
 * node, then the typed slots re-read from it. Borrows both (scr_json.c). */
void scr_error_assign_dyn(ScrError *e, const struct ScrDyn *sources);
/* `key in err` for a key no compiled class declares: a runtime-set own
 * property or an Object.prototype member. Borrows both (scr_json.c). */
bool scr_error_has_key(ScrError *e, const ScrStr *key);
bool scr_error_own_accessor(ScrError *e, const ScrStr *key);
struct ScrDyn *scr_error_accessor_get(ScrError *e, const ScrStr *key);
void scr_error_accessor_set(ScrError *e, const ScrStr *key, struct ScrDyn *value);
bool scr_error_has_code(ScrError *e);
const char *scr_error_message_code(const ScrStr *msg);
ScrStr *scr_error_code(ScrError *e);
SCR_COLD void scr_throw_error_msg_code(int kind, const char *message, size_t len, const char *code);
/* The compiler-resolved Node-parity throw (error.nodeThrow): builtin
 * error of `kind`, `code` stamped when non-empty. Borrows both. */
SCR_COLD void scr_throw_node_coded(double kind, const ScrStr *code, const ScrStr *msg);

#endif /* SCR_ERROR_H */
