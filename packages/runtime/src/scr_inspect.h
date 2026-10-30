/* scriptc runtime — util.inspect (scr_inspect.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_INSPECT_H
#define SCR_INSPECT_H

#include "scr_bytes.h"

/* ── util.inspect (scr_inspect.c — linked ONLY when the program calls
 * util.inspect/format; see native-toolchain.ts) ─────────────────────────────────────
 * The runtime half of the static inspect rendering: the compiler
 * synthesizes one traversal helper per static type; these entries own
 * Node's exact scalar formatting and the layout engine (frames,
 * break-length, grid grouping) for the DEFAULT options. All arguments
 * BORROWED; ScrStr results +1. Nothing here throws.
 *
 * The frame protocol, mirroring Node's formatRaw: a non-empty composite
 * calls begin(recurse+1) (indentation +2, currentDepth), renders each
 * child to a string and entry()s it (is_num drives the grid's
 * padStart/padEnd order), then end(base, brace0, brace1, recurse+1,
 * array_extras, trailing_more) reduces to one string at the parent
 * indentation. Empty composites and depth placeholders never touch the
 * stack (the frontend emits their literals directly). */
ScrStr *scr_insp_f64(double x);   /* JS ToString, except -0 → "-0" */
ScrStr *scr_insp_str(ScrStr *s);  /* the quoting ladder + line splitting */
ScrStr *scr_insp_regex(ScrRegex *re);  /* /source/flags */
/* A Date (its time value): toISOString(), or "Invalid Date" for NaN (+1). */
ScrStr *scr_insp_date(double ms);
ScrStr *scr_insp_buffer(ScrBytes *b);  /* <Buffer aa bb ...>, 50-byte cap */
/* The stackless error form: [Name: message] / [Name], then a runtime
 * error's own properties through its checked-dynamic node, or another
 * error's stamped code slot as its one extra property ({ code: 'X' });
 * [Name] beyond depth when a code makes it composite. */
ScrStr *scr_insp_error(ScrError *e, double recurse, double depth);
/* A runtime error rendered through its checked-dynamic node (the cached
 * one, or one built from its fields), so Node's own properties follow the
 * bracket form. */
ScrStr *scr_insp_error_node(ScrError *e, double recurse, double depth);
bool scr_insp_error_bag_has_properties(ScrDyn *bag);
bool scr_insp_error_has_cause(ScrError *e);
ScrStr *scr_insp_error_cause(ScrError *e, double recurse, double depth);
/* The checked-dynamic tree: shape lives in the value, so the whole
 * traversal is here. dyn-boxed bytes render in the checked-dynamic tree's documented
 * Uint8Array identity. */
ScrStr *scr_insp_dyn(ScrDyn *d, double recurse, double depth);
/* A numeric typed array that is not a Buffer: `Uint8Array(n) [ ... ]`,
 * `[Uint8Array]` past the depth limit. Borrows b; +1. */
ScrStr *scr_insp_typed_array(ScrBytes *b, double recurse, double depth);
/* A u8 byte view whose static type does not say which one it is (a union
 * arm, an element or field): a DataView, a Buffer (<Buffer ..>) or a
 * Uint8Array, by the view's own flags. */
ScrStr *scr_insp_bytes(ScrBytes *b, double recurse, double depth);
/* format's %s / rest-args twin: dyn strings pass verbatim. */
ScrStr *scr_insp_dyn_s(ScrDyn *d, double depth);
/* util.format over checked-dynamic arguments (formatWithOptionsInternal):
 * the options an inspect of each argument takes, and the API name the
 * SC2020 refusals name. These entries call program code, so they answer
 * NULL with the exception pending when it throws. */
typedef struct ScrInspFormatOptions {
  const char *surface;
  double depth; /* Infinity for null, undefined and NaN */
  /* The depth as the options gave it, which custom inspect functions
   * receive when the depth is unbounded: 0 a number (depth_number,
   * Infinity or NaN), 1 null, 2 undefined. */
  int depth_kind;
  double depth_number;
  bool colors;
  bool custom_inspect;
  double break_length;
  double compact; /* -1 for false */
  bool sorted;
  /* The options object, when it holds keys inspect does not read: custom
   * inspect functions receive them (borrowed; NULL otherwise). */
  const ScrDyn *user_options;
} ScrInspFormatOptions;
void scr_insp_format_defaults(ScrInspFormatOptions *o, const char *surface);
/* Reads inspect's options from an options object into o; false with the
 * SC2020 refusal pending for values that have no lowering. */
bool scr_insp_format_read_options(const ScrDyn *options, ScrInspFormatOptions *o);
ScrStr *scr_insp_format(ScrDyn *const *args, size_t argc, const ScrInspFormatOptions *o);
/* util.format(...pack) and util.formatWithOptions(options, ...pack) over a
 * dyn array of the arguments (+1). */
ScrStr *scr_insp_format_pack(ScrDyn *pack);
/* util.format over a native list of checked values, the compiled calls'
 * held arguments (+1). */
struct ScrArr;
ScrStr *scr_insp_format_list(struct ScrArr *list);
/* scr_insp_format_list when every argument is a string, number, boolean,
 * null or undefined, without the checked-dynamic walk (+1). */
ScrStr *scr_insp_format_primitives(struct ScrArr *list);
ScrStr *scr_insp_format_with_options(ScrDyn *options, ScrDyn *pack);
/* util.inspect(value, options, depth, colors) over checked-dynamic
 * arguments with Node's legacy-argument rules; argc is the call's
 * argument count (+1, or NULL with the exception pending). */
ScrStr *scr_insp_inspect(ScrDyn *value, ScrDyn *options, ScrDyn *depth, ScrDyn *colors,
                         double argc);
/* Whether a format string has a '%' before its last character, the only
 * strings whose substitutions can change the output. */
bool scr_insp_format_specifies(ScrStr *first);
bool scr_insp_format_specifies_dyn(ScrDyn *first);
/* format's %s over a dyn value: scr_insp_dyn_s, except that values whose
 * class defines its own toString print String(value). */
ScrStr *scr_insp_dyn_format_s(ScrDyn *d, double depth);
ScrStr *scr_insp_dyn_hidden(ScrDyn *d, double depth); /* %o: showHidden */
void scr_insp_begin(double recurse);
/* util.inspect's breakLength, compact (-1 for false) and sorted for the
 * renders that follow; the call site restores the defaults (80, 3, false)
 * afterwards. */
void scr_insp_layout(double break_length, double compact, bool sorted);
void scr_insp_entry(ScrStr *s, bool is_num);
/* Circular references, Node-exact (<ref *N> / [Circular *N]): the
 * compiler-emitted helpers over CYCLE-CAPABLE composites call circ_check
 * FIRST (a value already on the traversal stack answers its circular id,
 * assigned in discovery order — the caller renders scr_insp_circular and
 * descends no further), seen_push after begin, and ref_wrap around end's
 * result (pops the stack; scr_insp_end gives values in the circular map
 * the "<ref *N> " prefix). State resets at each top-level value's first frame
 * (scr_insp_begin(1)). ref_wrap BORROWS s and returns +1. */
double scr_insp_circ_check(const void *v);
void scr_insp_seen_push(const void *v);
ScrStr *scr_insp_circular(double id);
ScrStr *scr_insp_ref_wrap(const void *v, ScrStr *s);
ScrStr *scr_insp_more_items(double remaining); /* "... N more items" */
ScrStr *scr_insp_key(ScrStr *k); /* bare-or-quoted property-name ladder; +1 */
ScrStr *scr_insp_end(ScrStr *base, ScrStr *b0, ScrStr *b1, double recurse,
                     bool array_extras, bool trailing_more);
/* A nested util.inspect inside a custom rendering (PerformanceEntry's):
 * begin sets a fresh inspect context aside the caller's; end restores it
 * and answers `prefix inner` with inner's newlines re-indented at the
 * caller's level (+1; borrows both). */
void scr_insp_nested_begin(void);
ScrStr *scr_insp_nested_end(ScrStr *prefix, ScrStr *inner);
/* nested_end's restore without its text: the caller's context returns. */
void scr_insp_nested_restore(void);
/* ctx.customInspect for the renders that follow; answers the previous
 * value for the caller to restore. */
bool scr_insp_custom_inspect(bool enabled);
/* Around a custom inspect function's call: begin gives the calls it makes
 * a fresh inspect context with the default options and answers a token;
 * end(token) restores the caller's, also after calls that threw. */
double scr_insp_custom_call_begin(void);
void scr_insp_custom_call_end(double token);
/* How the unbounded depth of the renders that follow was given, for custom
 * inspect functions: 0 Infinity, 1 null, 2 undefined. Answers the
 * previous kind for the caller to restore. */
double scr_insp_depth_kind(double kind);
/* A custom inspect function's string result re-indented at the current
 * level (+1; borrows text). */
ScrStr *scr_insp_custom_text(ScrStr *text);
/* The compiled [util.inspect.custom] calls: ctx.customInspect, the depth
 * argument at recursion `recurse` of `depth` and the options object (+1
 * dyn values; options NULL with an exception pending), util.inspect as a
 * function value (+1), whether a dyn result is the instance itself, and a
 * dyn result's rendering at the instance's level (+1). */
bool scr_insp_custom_enabled(void);
/* Registers a class's compiled custom inspect function under the type key
 * of its instances' typed refs: fn(self, depth, options, inspect) answers
 * the method's result (borrows both). */
void scr_insp_register_custom(ScrStr *type_key, ScrDyn *fn);
ScrDyn *scr_insp_custom_depth(double recurse, double depth);
ScrDyn *scr_insp_custom_options(double depth);
ScrDyn *scr_insp_inspect_function(void);
bool scr_insp_custom_is_self(ScrDyn *result, ScrDyn *self);
ScrStr *scr_insp_custom_result(ScrDyn *result, double recurse, double depth);
/* Mark the inspector's state before a top-level render, and return to the
 * mark when the render ends, normally or by an inspection refusal. */
void scr_insp_mark(void);
void scr_insp_unwind(void);

/* The buf.read* / buf.write* numeric families on u8 bytes, Node-exact:
 * boundsError's ladder (non-integer offset → 'It must be an integer', a
 * buffer shorter than the width → 'Attempt to access memory outside
 * buffer bounds', otherwise the '>= 0 and <= max' render — big Received
 * values carry Node's underscore separators) and checkInt's value gate
 * for the integer writes (range first, widths past 4 bytes in the
 * '2 ** N' form; NaN passes and writes zeros). All catchable. Fixed
 * widths take a kind + littleEndian flag; the variable-width family
 * (read/writeUIntLE-style) validates byteLength (1-6) first, then value
 * (writes), then offset. Writes return offset + width; float kinds skip
 * the value gate entirely (any double stores, f32 rounds to nearest). */
typedef enum {
  SCR_BN_U8,
  SCR_BN_I8,
  SCR_BN_U16,
  SCR_BN_I16,
  SCR_BN_U32,
  SCR_BN_I32,
  SCR_BN_F32,
  SCR_BN_F64,
} ScrBytesNumKind;
double scr_bytes_read_num(const ScrBytes *b, double offset, ScrBytesNumKind kind, bool le);
double scr_bytes_write_num(ScrBytes *b, double value, double offset, ScrBytesNumKind kind, bool le);
double scr_bytes_read_var(const ScrBytes *b, double offset, double byte_length, bool sign, bool le);
double scr_bytes_write_var(ScrBytes *b, double value, double offset, double byte_length, bool sign, bool le);
bool scr_bytes_read_u64_raw(const ScrBytes *b, double offset, bool le, uint64_t *out);
bool scr_bytes_write_u64_raw(ScrBytes *b, double offset, bool le, uint64_t value);
bool scr_dataview_read_u64_raw(const ScrBytes *b, double offset, bool le, uint64_t *out);
bool scr_dataview_write_u64_raw(ScrBytes *b, double offset, bool le, uint64_t value);

/* fs.readFileSync(path) [no encoding] / writeFileSync(path, buf) — the
 * Buffer forms of scr_lib.c's utf8 pair, byte-exact and NUL-safe.
 * Failures THROW catchably (scr_fs_throw, Node-shaped messages). */
ScrBytes *scr_fs_read_file_bytes(ScrStr *path); /* +1 */
/* readFileSync's runtime-encoding form (scr_bytes_io.c's note): +1 dyn
 * value — a Buffer box for nullish/empty encodings, a decoded string otherwise — or NULL
 * with the exception pending. */
ScrDyn *scr_fs_read_file_sync_dyn(ScrStr *path, const ScrDyn *enc);
ScrStr *scr_fs_read_file_encoded(ScrStr *path, ScrStr *encoding);
/* readFileSync's encoding check (ERR_INVALID_ARG_VALUE), on its own: the
 * check Node runs before it converts a URL path. */
void scr_fs_check_read_encoding(ScrStr *encoding);
ScrStr *scr_fs_read_fd_encoded(double fd, ScrStr *encoding);
ScrDyn *scr_fs_callback_value(ScrStr *member);
ScrDyn *scr_fs_callback_call(ScrStr *member, const ScrDyn *args);
/* The error-first callback queue (scr_bytes_io.c): a pending exception
 * becomes [err], otherwise [null, result(, buffer)]; the callback runs on
 * a later loop turn. result moves in. */
void scr_fs_cb_schedule(const ScrDyn *callback, ScrDyn *result, const ScrDyn *buffer);
/* getValidatedPath(value, name): a string, Buffer or file: URL path
 * without NUL bytes (+1), or NULL with Node's TypeError pending. */
ScrStr *scr_fs_validated_path(const ScrDyn *value, const char *name);
/* options[name] for an options object (+1; undefined when options is
 * nullish), or NULL with an exception pending. */
ScrDyn *scr_fs_option_get(const ScrDyn *options, const char *name);
ScrBytes *scr_fs_read_fd_bytes(double fd);      /* +1; the fd form (scr_lib.c) */
void scr_fs_write_file_bytes(ScrStr *path, const ScrBytes *data);
void scr_fs_append_file_bytes(ScrStr *path, const ScrBytes *data);

/* fs/promises readFile(path) [no encoding]: the same read behind an
 * already-settled promise — failure REJECTS (catchable at the await). */
ScrPromise *scr_fsp_read_file_bytes(ScrStr *path); /* +1 */

/* crypto.randomBytes(n) → a real u8 Buffer. Out-of-range n THROWS Node's
 * RangeError catchably (same check as scr_crypto_random_string). */
ScrBytes *scr_crypto_random_bytes(double n); /* +1 */

/* process.stdout/stderr.write(buf[, encoding]): the raw byte writes' Buffer
 * overloads (same streams and buffering as the string forms). The encoding
 * is evaluated by the caller and ignored here, as Node does for bytes.
 * Constantly true. */
bool scr_process_stdout_write_bytes(const ScrBytes *b, const ScrStr *encoding);
bool scr_process_stderr_write_bytes(const ScrBytes *b, const ScrStr *encoding);

/* The Node-shaped fs error thrower (scr_lib.c): formats "ENOENT: no such
 * file or directory, open 'x'" and throws it catchably. Shared with
 * scr_bytes.c's fs forms. */
void scr_fs_throw(int e, const char *op, const ScrStr *path);
/* The same error, returned +1 instead of thrown (async completions). */
ScrError *scr_fs_error(int e, const char *op, const ScrStr *path);

#endif /* SCR_INSPECT_H */
