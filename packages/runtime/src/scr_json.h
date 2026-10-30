/* scriptc runtime — JSON parsing and the JSON output buffer (scr_json.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_JSON_H
#define SCR_JSON_H

#include "scr_dyn.h"

/* RFC 8259 parse of a UTF-8 string. Borrows text; returns +1, or throws a
 * catchable Node-flavored SyntaxError string and returns NULL (callers are
 * compiler-emitted pending checks — json.parse is in the may-throw seed). */
ScrDyn *scr_json_parse(ScrStr *text);

/* Compiler-emitted description of a statically known JSON.parse target
 * (`JSON.parse(text) as T`). Constant data in the program image; the LLVM
 * backend mirrors this layout ({size, size, ptr, ptr, ptr, ptr, ptr, ptr, size},
 * {ptr, size, size, ptr}, {size, [7 x size], [7 x ptr], ptr, ptr, ptr, ptr},
 * and for discriminated unions {ptr, size, size, ptr} with {ptr, size, size,
 * ptr} cases). Records list their declared fields (at most 64), each with
 * its byte offset in the record struct; bool fields are one byte, f64
 * fields doubles, inline union fields a {uint32 tag, uint64 bits} pair,
 * every other kind a +1 pointer. Unions appear as record field types;
 * discriminated unions also as array elements and whole documents, whose
 * values are the union's box (or its pointer, for a pointer union). A
 * record with an index signature names its index value type in `elem` and
 * its overflow map's offset in `ovf_offset`. */
enum {
  SCR_JSCHEMA_F64 = 0,
  SCR_JSCHEMA_BOOL = 1,
  SCR_JSCHEMA_STR = 2,
  SCR_JSCHEMA_REC = 3,
  SCR_JSCHEMA_ARR = 4,
  SCR_JSCHEMA_UNION = 5,
};
/* A union's arms by the JSON value kind that selects them. ABSENT names
 * the undefined arm, which no JSON value selects: a missing member takes
 * the field's ABSENT state through it. */
enum {
  SCR_JARM_NULL = 0,
  SCR_JARM_NUM = 1,
  SCR_JARM_BOOL = 2,
  SCR_JARM_STR = 3,
  SCR_JARM_OBJ = 4,
  SCR_JARM_ARR = 5,
  SCR_JARM_ABSENT = 6,
  SCR_JARM_COUNT = 7,
};
#define SCR_JSCHEMA_NO_ARM SIZE_MAX
/* How a union field slot stores its value (the compiler's choice for the
 * union type): the reference payload itself (nullable unions), the tag
 * and bits in the record (scalar unions), or a tagged box. */
enum {
  SCR_JUNION_NULLABLE = 0,
  SCR_JUNION_INLINE = 1,
  SCR_JUNION_BOXED = 2,
};
typedef struct ScrJsonSchema ScrJsonSchema;
typedef struct {
  const char *name;
  size_t name_len;
  size_t offset;
  const ScrJsonSchema *type;
} ScrJsonSchemaField;
/* One string literal of a discriminated union's discriminant member and
 * the record arm (canonical tag and schema) that holds it. */
typedef struct {
  const char *value;
  size_t value_len;
  size_t tag;
  const ScrJsonSchema *record;
} ScrJsonCase;
/* A discriminated union's object arms by discriminant literal: every
 * literal names one arm. */
typedef struct {
  const char *field;
  size_t field_len;
  size_t ncases;
  const ScrJsonCase *cases;
} ScrJsonDiscriminant;
typedef struct {
  size_t repr;
  size_t tags[SCR_JARM_COUNT];               /* canonical arm tag, or SCR_JSCHEMA_NO_ARM */
  const ScrJsonSchema *arms[SCR_JARM_COUNT]; /* value arms (NUM..ARR) */
  void *null_value;                          /* nullable, boxed: the null arm's value */
  void *absent_value;                        /* nullable, boxed: the ABSENT field state */
  /* boxed: a +1 box of the value arm `tag`; bits hold its double, its
   * bool, or its +1 payload pointer (moved in). */
  void *(*box)(uint32_t tag, uint64_t bits);
  /* discriminated unions: the object arms; NULL for other unions, whose
   * object arm is arms[SCR_JARM_OBJ] */
  const ScrJsonDiscriminant *disc;
} ScrJsonUnion;
struct ScrJsonSchema {
  size_t kind;
  size_t nfields;
  const ScrJsonSchemaField *fields; /* records */
  const ScrJsonSchema *elem;        /* arrays; records: the index value type */
  void *(*rec_new)(void);           /* records: zeroed instance, rc 1 */
  ScrArr *(*arr_new)(size_t);       /* arrays: empty array of the element kind */
  void (*release)(void *);          /* records and arrays */
  const ScrJsonUnion *uni;          /* unions */
  size_t ovf_offset;                /* records with an index signature */
};

/* One-pass parse straight into the native layout. Returns the +1 record
 * or array, or NULL WITHOUT throwing whenever the checked-dynamic route
 * (scr_json_parse + dynCheck) might fail or differ; the caller then runs
 * that route, which reports the exact error. */
void *scr_json_parse_schema(const ScrStr *text, const ScrJsonSchema *schema);

/* Native JSON callbacks. All inputs borrowed, result owned (+1), NULL on
 * pending exception. Stringify returns a dyn string OR actual undefined
 * when the replacer omits the root. An array replacer selects the object
 * keys to serialize. gap has already applied space rules. */
ScrDyn *scr_json_parse_reviver(ScrStr *text, const ScrDyn *reviver);
ScrDyn *scr_json_stringify_replacer(const ScrDyn *value, const ScrDyn *replacer, const ScrStr *gap);
ScrDyn *scr_json_stringify_value(const ScrDyn *value, const ScrDyn *replacer, const ScrDyn *space);

/* Output buffer for the compiler-emitted type-directed JSON serializers.
 * Value-typed and stack-allocated by the emitted code; _finish hands the
 * bytes over as a +1 ScrStr and frees the buffer storage (including the
 * circular-detection stack below). */
struct ScrJsonSeenEnt;
typedef struct {
  char *data;
  size_t len;
  size_t cap;
  /* Circular-structure detection for RECURSIVE record types (cyclic
   * values must throw Node's exact TypeError, never recurse forever):
   * the stack of container values currently being serialized, each with
   * its outgoing edge label (the member being written). Only walkers over
   * cycle-CAPABLE types (the collector-fixpoint set) maintain it; acyclic
   * types keep the zero-cost path. */
  struct ScrJsonSeenEnt *seen;
  size_t seen_len;
  size_t seen_cap;
} ScrJsonBuf;
/* Emitted JSON writers append constant text inline (llvm/walkers.ts
 * appendBytes) through this prefix. */
_Static_assert(offsetof(ScrJsonBuf, data) == 0 && offsetof(ScrJsonBuf, len) == sizeof(char *) &&
                   offsetof(ScrJsonBuf, cap) == sizeof(char *) + sizeof(size_t),
               "LLVM backend expects ScrJsonBuf to start with { data, len, cap }");

void scr_jb_init(ScrJsonBuf *b);
/* String conversion of a class instance whose ToString is
 * Object.prototype.toString and whose class has a Symbol.toStringTag
 * getter: appends "[object Tag]" and answers true, also with the getter's
 * exception pending; false when the ordinary conversion applies. */
bool scr_dyn_typed_ref_put_tag(ScrJsonBuf *b, const ScrDyn *d);
/* Release a buffer's text without finishing it (error paths). */
void scr_jb_abandon(ScrJsonBuf *b);
/* Append a borrowed byte span verbatim, including embedded NUL bytes. */
void scr_jb_write(ScrJsonBuf *b, const char *s, size_t n);
/* scr_jb_write for text that holds no lone surrogate (fixed text, JSON
 * tokens), which cannot complete a surrogate pair at the seam. */
void scr_jb_write_utf8(ScrJsonBuf *b, const char *s, size_t n);
/* Append one borrowed runtime string verbatim (no JSON quoting). */
void scr_jb_put_str(ScrJsonBuf *b, const ScrStr *s);
/* Push a container onto the circular-detection stack before serializing
 * its members. If `v` is already ON the stack, throws V8's exact
 * "Converting circular structure to JSON" TypeError (the --> starting at /
 * |property/index hops/--- closes the circle rendering, ellipsis rules
 * included) and returns false — the caller returns immediately; the
 * emitted stringify site runs the pending check. `is_array` picks the
 * constructor name in the message ('Array' for arrays AND tuple shapes —
 * their JS values are arrays — 'Object' for records). */
bool scr_jb_enter(ScrJsonBuf *b, const void *v, bool is_array);
void scr_jb_leave(ScrJsonBuf *b);
/* Record the edge currently being serialized on the stack top: a static
 * property name (emitted C literal), an overflow key (borrowed for the
 * duration of the member write), or an array/tuple index. */
void scr_jb_edge_prop(ScrJsonBuf *b, const char *name);
void scr_jb_edge_key(ScrJsonBuf *b, const ScrStr *key);
void scr_jb_edge_idx(ScrJsonBuf *b, size_t i);

/* Circular guard for the compiler-emitted typed→dyn converters (sc_td_*
 * over cycle-capable containers): enter TRAPS on a value already being
 * converted (a cyclic value has no finite dyn copy — Node shares the
 * reference instead; SEMANTICS.md), else pushes. */
void scr_dyn_from_enter(const void *v);
void scr_dyn_from_leave(void);
void scr_jb_putc(ScrJsonBuf *b, char c);
void scr_jb_puts(ScrJsonBuf *b, const char *s);
/* Array.prototype.join's conversion of one element, appended to `b`:
 * nothing for undefined and null, ToString of anything else. */
void scr_jb_join_dyn(ScrJsonBuf *b, const ScrDyn *d);
/* JS JSON.stringify number rules: NaN/±Infinity → null, -0 → 0, else
 * shortest-roundtrip via scr_f64_to_str. */
void scr_jb_put_f64(ScrJsonBuf *b, double v);
/* Append String(number), including NaN/Infinity, without a temporary string. */
void scr_jb_put_number(ScrJsonBuf *b, double v);
/* Quoted + escaped JSON string: \" \\ \n \r \t \b \f, other control chars
 * as \u00XX, lone surrogates as \udXXX, everything else (UTF-8 included)
 * verbatim — exactly the JS JSON.stringify escape set. */
void scr_jb_put_json_str(ScrJsonBuf *b, const ScrStr *s);
/* JSON.stringify of a Date object: toJSON()'s ISO text, null if invalid
 * (scr_lib.c). */
typedef struct ScrDate ScrDate;
void scr_jb_put_date(ScrJsonBuf *b, const ScrDate *date);

/* JSON-serialize a dyn value into the buffer — the sc_jw_* walker for the
 * dyn leaves the compiler cannot type: undefined prints null (an array
 * slot's rule); containers follow JSON.stringify (toJSON, accessors,
 * circular structures). May leave an exception pending. */
void scr_jb_put_dyn(ScrJsonBuf *b, const ScrDyn *d);
/* scr_jb_put_dyn for array element `index` (a foreign element of a typed
 * array): its toJSON runs first, with the index as its key. May leave an
 * exception pending. */
void scr_jb_put_dyn_element(ScrJsonBuf *b, const ScrDyn *d, double index);
/* The entries of record `rec`'s `unknown` index signature (its overflow
 * map) after the record's earlier members: separators, keys and values in
 * JS own-key order with JSON.stringify's member rules (toJSON called with
 * the key, undefined, function and symbol results dropped). `first` is the
 * record's first-member flag. May leave an exception pending. */
void scr_jb_put_dyn_entries(ScrJsonBuf *b, void *rec, ScrMap *map, bool *first);
/* Typed JSON for a record that kept a source: the kept key order, declared
 * fields through the compiled per-field writer. `try` writes nothing and
 * answers false for a record without one. */
void scr_jb_put_record_source(ScrJsonBuf *b, void *rec,
                              bool (*field)(ScrJsonBuf *, void *, size_t, bool));
bool scr_jb_try_record_source(ScrJsonBuf *b, void *rec,
                              bool (*field)(ScrJsonBuf *, void *, size_t, bool));
ScrStr *scr_jb_finish(ScrJsonBuf *b); /* returns +1; frees the buffer */
/* Reformat compiler-produced compact JSON with an already resolved gap.
 * Borrows both inputs; gap_len is a byte length, including embedded NUL.
 * Returns a new owned string, or retains compact when the gap is empty. */
ScrStr *scr_json_indent(const ScrStr *compact, const char *gap, size_t gap_len);

#endif /* SCR_JSON_H */
