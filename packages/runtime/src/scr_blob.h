/* scriptc runtime — Blob and File (scr_blob.c), and module namespace
 * objects as checked-dynamic values (scr_module_namespace.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_BLOB_H
#define SCR_BLOB_H

#include "scr_dyn.h"

/* ── Blob / File (scr_blob.c) ──────────────────────────────────────────
 * Node 24's lib/internal/blob.js and file.js: immutable bytes copied from
 * the sources at construction, shared by slices and structured clones.
 * The constructors take the argument vector as one dyn array (borrowed)
 * and validate it like Node; +1 handle, or NULL with the exception
 * pending. slice takes its (start, end, contentType) vector the same way.
 * The readers answer +1 promises (string, u8 bytes, and an ArrayBuffer
 * dyn value) that settle on Node's microtask turn for the Blob's part
 * count. scr_blob_is answers `v instanceof Blob` (kind 0) or `File` (1). */
ScrDyn *scr_blob_new(ScrDyn *args);
ScrDyn *scr_file_new(ScrDyn *args);
ScrDyn *scr_blob_slice(ScrDyn *self, ScrDyn *args);
ScrPromise *scr_blob_text(ScrDyn *self);
ScrPromise *scr_blob_bytes(ScrDyn *self);
ScrPromise *scr_blob_array_buffer(ScrDyn *self);
bool scr_blob_is(const ScrDyn *value, double kind);

ScrDyn *scr_intl_segmenter_new(void);
/* A word or sentence Intl.Segmenter whose segment() throws `refusal`
 * (borrowed), the compiler's SC2020 message. */
ScrDyn *scr_intl_segmenter_refusing(ScrStr *refusal);
ScrStr *scr_process_builtin_id(ScrDyn *id, ScrArr *known);
ScrDyn *scr_process_builtin_module(ScrStr *id, ScrDyn *getter);
ScrDyn *scr_process_builtin_unsupported(ScrStr *id, ScrStr *member);
/* A module namespace object as a checked-dynamic value (scr_module_namespace.c):
 * one handle per module `id`, whose reads call `getter` with the export
 * name when `keys` lists it. Borrows all three; +1 handle. */
ScrDyn *scr_module_namespace_value(ScrStr *id, ScrArr *keys, ScrDyn *getter);
ScrDyn *scr_global_native(ScrArr *known);
ScrDyn *scr_global_native_init(ScrArr *known, ScrDyn *(*console_get)(void));
ScrDyn *scr_console_native(void);
/* node:console Console instances: a native handle over the stdout/stderr
 * targets — process stdio (fd 1/2) or a writable stream bound by
 * scr_console_bind (scr_stream.c, which also installs the stream writer so
 * console-only programs never link the stream unit) — and the
 * ignoreErrors flag. new answers a +1 handle with both targets set to
 * the given fds (0 = a stream is bound next); bind retains the stream.
 * write prints `text\n` to the selected target: a stream receives ONE
 * write, wrapped in Node's ignoreErrors handling (a noop 'error' listener
 * around the call, a completion handler that swallows the write's own
 * error, synchronous throws discarded); the global console handle writes
 * the process streams like console.log/error. */
typedef struct ScrConsoleInst {
  size_t rc;
  double fd[2];                /* 1/2 process stdio targets; 0 when stream[i] is bound */
  ScrStream *stream[2];        /* owned */
  ScrClosure *on_written[2];   /* owned: the per-stream completion handlers */
  bool ignore_errors;
  void (*stream_write)(struct ScrConsoleInst *, int which, ScrStr *line);
  void (*stream_drop)(struct ScrConsoleInst *); /* releases the bound streams */
} ScrConsoleInst;
ScrDyn *scr_console_new(double out_fd, double err_fd, bool ignore_errors);
void scr_console_bind(ScrDyn *console, double which, ScrStream *stream);
void scr_console_inst_write(ScrDyn *console, ScrStr *text, bool to_stderr);
ScrDyn *scr_process_stdio(double fd);
bool scr_dyn_process_stdio_is(const ScrDyn *value);
double scr_dyn_process_stdio_fd(const ScrDyn *value, const ScrDynPath *path);

void scr_dyn_handle_install(ScrDynHandleTag tag, const ScrDynHandleOps *ops);
void scr_file_handle_dyn_install(void);
/* The tag's class display name ("IncomingMessage") — error texts across
 * units; answers "object" for an uninstalled tag (error paths only). */
const char *scr_dyn_handle_cls(const ScrDyn *d);
/* The installed ops for a HANDLE box (aborts on a missing install — an
 * internal error: emitted programs install a unit's ops whenever they
 * can box its handles). The dispatch unit's entry into the registry. */
const ScrDynHandleOps *scr_dyn_handle_ops_of(const ScrDyn *d);
/* Boxes a handle by reference (+1 box; retains h through the tag's ops).
 * The tag MUST be installed — emitted programs install a unit's ops
 * whenever they can box its handles. */
ScrDyn *scr_dyn_new_handle(void *h, ScrDynHandleTag tag);
/* dynCheck extraction (`u as IncomingMessage`, a boxed listener's typed
 * parameter): tag match answers the RETAINED pointer (+1 — reference
 * identity, no copy); anything else throws the path-annotated catchable
 * TypeError and returns NULL. */
void *scr_dyn_handle_unbox(const ScrDyn *d, ScrDynHandleTag tag, const ScrDynPath *path, const char *want);
/* Keyed read on a HANDLE box (the emitted sc_dyn_key_get's arm): the
 * tag's modeled properties answer boxed values; everything else answers
 * the undefined singleton (the checked-dynamic tree's own-property stance — SEMANTICS.md)
 * unless the ops throw "not supported yet" for it. +1, or NULL with a pending exception. */
ScrDyn *scr_dyn_handle_key_get(const ScrDyn *d, const ScrStr *k);

#endif /* SCR_BLOB_H */
