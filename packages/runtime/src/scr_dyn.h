/* scriptc runtime — dynamic values: the checked-dynamic tree, native handles,
 * dyn promises, the ambient receiver and listener adapters (scr_json.c,
 * scr_dyn_handle.c, scr_async_dyn.c), and the message readers of typed
 * 'message' listeners (scr_message.c). Included by scr_runtime.h, which says
 * where new declarations go. */
#ifndef SCR_DYN_H
#define SCR_DYN_H

#include "scr_regex.h"
#include "scr_url.h"
#include "scr_symbol.h"
#include "scr_bigint.h"

/* ── JSON + dynamic values (scr_json.c) ─────────────────────────────
 * A dyn value — the compiled form of `unknown` — is a refcounted JSON dyn
 * tree: the result of JSON.parse, inert until a CHECKED CAST validates it
 * against a static type. The compiler emits the validation walkers
 * (sc_dc_* builders / sc_dm_* match predicates) and the type-directed
 * stringify serializers (sc_jw_*) per program; this runtime slice provides
 * the checked-dynamic tree itself, the RFC 8259 parser, the shared failure path
 * (scr_dyn_check_fail), and the output buffer the serializers append to.
 *
 * Ownership: the checked-dynamic tree owns its children (strings, items, entry keys+values);
 * releasing the root releases the tree recursively. scr_json_parse borrows
 * the text and returns +1 — or THROWS a catchable string shaped like Node's
 * V8 messages ("Unexpected end of JSON input", "... in JSON at position
 * <n> (line <l> column <c>)") and returns NULL. scr_dyn_obj_get returns a BORROWED
 * member (the compiler's builders retain what they extract themselves).
 */

typedef enum {
  SCR_DYN_NULL,
  SCR_DYN_BOOL,
  SCR_DYN_NUM,
  SCR_DYN_STR,
  SCR_DYN_ARR,
  SCR_DYN_OBJ,
  /* The undefined VALUE. Never produced by the parser (JSON text has no
   * undefined) — it enters the checked-dynamic tree through index-signature overflow reads
   * (a missing key), optional-chain unit paths on dyn results, and the
   * compiler's static→dyn converters (an undefined-armed union's unit
   * arm). One immortal instance (scr_dyn_undefined); JSON serialization
   * drops object members holding it and prints null for array slots,
   * exactly Node. dynCheck matches it against exactly the undefined arm. */
  SCR_DYN_UNDEF,
  /* A numeric typed-array/Buffer value retained by reference. Boxing and
   * checked extraction preserve the view, exact element kind, and backing
   * allocation. typeof answers "object"; String() joins numeric elements
   * (Buffer keeps its encoding behavior); JSON writes an index-keyed object.
   * Exact-brand tests accept Buffer as Uint8Array. */
  SCR_DYN_BYTES,
  /* A FUNCTION value. Never produced by the parser — it enters the checked-dynamic tree
   * through the compiler's static→dyn converters (a typed closure flowing
   * into an `unknown` slot: `mustCall(fn)`-style untyped JS helpers). Owns
   * a ScrClosure plus a compiler-emitted CALL THUNK that validates dyn
   * arguments into the closure's declared parameter types (per-arg
   * dynCheck — JS arity semantics: extra args ignored, missing args are
   * the undefined dyn value) and converts the result back to a dyn value.
   * `sig` is the compiler's interned signature key: dynCheck against an
   * IDENTICAL function type unwraps the closure directly; any other
   * (adaptable) function target wraps the box in a per-target adapter
   * closure. typeof answers "function", truthiness is true, String()
   * renders the native-code form (source text is gone — SEMANTICS.md),
   * JSON serialization treats it like undefined (dropped from objects,
   * null in arrays), and util.inspect prints [Function: name]. */
  SCR_DYN_FUNC,
  /* A NATIVE HANDLE value (httpReq/httpRes/netSocket crossing the checked-
   * dynamic boundary — `server.on('request', mustCall((req, res) => ...))`
   * makes the listener dyn, so the event tuple must box). Never produced
   * by the parser — it enters the checked-dynamic tree through the compiler's static→dyn
   * converters and the per-target function adapters. Boxes by REFERENCE
   * (a retained pointer + a handle-type tag): handles are stateful I/O
   * objects, so identity is the HANDLE, not the box — strict equality
   * compares (tag, pointer), and dynCheck against the same handle type
   * unwraps the pointer (+1) instead of copying. Member CALLS and the
   * property reads/writes with static equivalents dispatch through a
   * per-tag ops table (scr_dyn_handle_install — scr_http.c/scr_net.c
   * register at main(), the vtable-stamp story) onto the SAME entry
   * points the static lowerings use; unknown members throw the
   * "not supported yet" Error instead of returning a wrong result. typeof
   * answers "object", truthiness is true, String() renders
   * "[object Object]" (Object.prototype.toString — Node's answer for
   * these classes), JSON serialization and util.inspect throw the
   * "not supported yet" Error. */
  SCR_DYN_HANDLE,
  /* A PROMISE value. Never produced by the parser — it enters the checked-dynamic tree
   * through the compiler's static→dyn converters (a promise flowing into
   * an `any`/`unknown` slot: the traced-function boundary of
   * dc.tracingChannel.tracePromise, a dyn-boxed async closure's return).
   * Boxes by REFERENCE (a retained ScrPromise + the boundary contract
   * that a dyn-crossing promise settles with a dyn payload: promise<dyn>
   * boxes its ScrPromise directly, other inner types box an ADAPTER
   * promise whose emitted settle callback converts the payload — see
   * scr_dyn_new_promise_adapting). Identity is the PROMISE, not the box
   * (strict equality compares the pointers; Promise.resolve identity
   * survives one crossing, a re-boxed typed promise mints a fresh
   * adapter — SEMANTICS.md). typeof answers "object", truthiness is
   * true, String() renders "[object Promise]" (Object.prototype.toString
   * — promises have no own toString), JSON serialization writes {} (no
   * own enumerable properties, exactly Node), and util.inspect throws
   * the "not supported yet" Error. The dyn→promise edge is NOT visible to
   * the cycle collector (the dyn→closure stance): a cycle THROUGH a
   * dyn-boxed promise is merely never collected. */
  SCR_DYN_PROMISE,
  /* A compiler-owned typed reference. Program class instances use this for
   * ordinary `unknown` storage; native Web streams also use it when their
   * contract must expose the exact input reference again. The capsule
   * retains the original value so an exact checked cast preserves identity;
   * `materialize` supplies the ordinary own-field/data view to generic dyn
   * consumers. LLVM hardcodes these kind numbers; append new kinds. */
  SCR_DYN_TYPED_REF = 12, /* tag 11 is retired; preserve the native ABI */
  /* Native Proxy over a checked plain object; keep new tags at the end. */
  SCR_DYN_PROXY,
  SCR_DYN_BIGINT, /* exact native integer, retained by the box */
  SCR_DYN_SYMBOL, /* native symbol identity, retained by the box */
} ScrDynKind;

/* Every per-tag table (scr_dynh_ops in scr_json.c, the message clone hooks
 * in scr_message.c) is sized by this fixed capacity, never by the number of
 * tags. Adding a tag for a link-gated unit therefore changes no
 * always-linked storage or code: a program that never boxes the new handle
 * links byte-identical objects. Raising the capacity is a program-wide
 * layout change; do it in a change of its own, measured as neutral, and
 * only when the tags outgrow it. */
#define SCR_DYNH_CAPACITY 128

/* The handle-type tags the checked-dynamic tree can carry. The set is deliberately the
 * HANDLE kinds whose member surfaces already have complete static
 * lowerings (the http/net receiver surface); new kinds join by adding a
 * tag + an ops registration in their owning unit.
 *
 * Two lists declare the tags. SCR_DYNH_TAGS holds the PINNED tags: X(NAME,
 * value) declares SCR_DYNH_NAME with an explicit, permanent value, rows
 * sorted by name. SCR_DYNH_NEW_TAGS holds tags added since the last pin, by
 * NAME ONLY: Y(NAME), rows sorted by name. A new tag goes in its sorted place
 * in SCR_DYNH_NEW_TAGS, so a branch never picks a number and two branches
 * that add tags never collide; the enum numbers the new tags after the
 * largest pinned value, in list order. Values are an ABI only between the
 * compiler and the runtime pack of one build, so a new tag added before
 * another one in name order may renumber it; nothing outside the build
 * depends on it.
 *
 * Pin a new tag (move it to SCR_DYNH_TAGS with the value it has now: the
 * largest pinned value + 1 for the first row of SCR_DYNH_NEW_TAGS, + 2 for
 * the second, and so on) only when the LLVM backend needs its number: DYN_HANDLE_TAG_NUM and
 * TEXT_CODEC_TAG_NUM in packages/compiler/src/backend/llvm/dyn.ts may only
 * name pinned tags. Pin the new tags in name order, oldest first, in a change
 * of its own, so their values do not move.
 *
 * Checks: a pinned value at or above SCR_DYNH_CAPACITY fails its
 * _Static_assert, two tags with one value are a duplicate case label in
 * scr_dynh_tags_distinct below, and the header does not compile.
 * dyn-handle-tags.test.ts checks the same properties by name, that both lists
 * are sorted, that every value below the largest pinned one is a tag or
 * listed in SCR_DYNH_UNASSIGNED, and that the backend's numbers match. */
#define SCR_DYNH_TAGS(X) \
  X(ABORT_CONTROLLER, 15) /* native static-fetch AbortController */ \
  X(ABORT_SIGNAL, 8) /* native static-fetch AbortSignal */ \
  X(ARRAY_BUFFER, 18) /* fixed-length ArrayBuffer storage */ \
  X(ASYMMETRIC_CRYPTO_KEY, 69) /* WebCrypto ECDSA and RSA CryptoKey (scr_webcrypto_pki.c) */ \
  X(BLOB, 41) /* ScrBlob — new Blob() and Blob#slice() */ \
  X(BROADCAST_CHANNEL, 51) /* worker_threads BroadcastChannel (scr_worker_events.c) */ \
  X(BUILTIN_MODULE, 21) /* native builtin export object */ \
  X(CHILD, 16) /* child_process.ChildProcess */ \
  X(CIPHER, 45) /* node:crypto Cipheriv (scr_cipher.c) */ \
  X(CONSOLE, 32) /* stored global console value */ \
  X(CONSOLE_INSTANCE, 38) /* node:console Console instance */ \
  X(CRYPTO_KEY, 56) /* WebCrypto CryptoKey (scr_webcrypto.c) */ \
  X(CUSTOM_EVENT, 40) /* ScrEvent with detail — new CustomEvent() */ \
  X(DATE, 30) /* JavaScript Date with stable native identity */ \
  X(DECIPHER, 46) /* node:crypto Decipheriv (scr_cipher.c) */ \
  X(DGRAM_SOCKET, 62) /* dgram.Socket (scr_dgram.c) */ \
  X(DIFFIE_HELLMAN, 70) /* node:crypto DiffieHellman (scr_dh.c) */ \
  X(DIFFIE_HELLMAN_GROUP, 71) /* node:crypto DiffieHellmanGroup (scr_dh.c) */ \
  X(DIR, 44) /* fs.Dir (scr_lib.c) */ \
  X(DISPOSABLE_STACK, 49) /* DisposableStack (scr_symbol.c) */ \
  X(ECDH, 64) /* node:crypto ECDH (scr_ecdh.c) */ \
  X(EVENT, 14) /* ScrEvent — new Event() and AbortSignal's abort events */ \
  X(EVENT_TARGET, 39) /* ScrEventTarget — new EventTarget() */ \
  X(FETCH_HEADERS, 13) /* native static-fetch response Headers */ \
  X(FETCH_REQUEST, 34) \
  X(FETCH_RESPONSE, 12) /* native static-fetch Response */ \
  X(FILE, 42) /* ScrBlob with a name — new File() */ \
  X(FILE_HANDLE, 17) /* fs/promises.FileHandle */ \
  X(FINALIZATION_REGISTRY, 72) /* FinalizationRegistry (bookkeeping only) */ \
  X(GLOBAL, 22) /* native global object identity */ \
  X(H2_SESSION, 4) /* ScrH2Session — Http2Session (client & server) */ \
  X(H2_STREAM, 5) /* ScrH2Stream — Http2Stream (client & server) */ \
  X(HASH, 52) /* node:crypto Hash (scr_lib.c) */ \
  X(HMAC, 53) /* node:crypto Hmac (scr_lib.c) */ \
  X(HTTP_AGENT, 7) /* ScrHttpAgent — http.Agent / https.Agent */ \
  X(HTTP_CLIENT, 6) /* ScrHttpClientReq — http.ClientRequest */ \
  X(HTTP_REQ, 0) /* ScrHttpReq — IncomingMessage (server req & client res) */ \
  X(HTTP_RES, 1) /* ScrHttpRes — ServerResponse */ \
  X(ITERATOR, 31) /* live native array/string/byte iterator */ \
  X(ITERATOR_HELPER, 54) /* an iterator helper object over a checked iterator (scr_json.c) */ \
  X(KEY_OBJECT, 43) /* node:crypto secret KeyObject (scr_lib.c) */ \
  X(MAP, 29) /* native Map<unknown, unknown>, shared backing */ \
  X(MATCH_SOURCE, 55) /* a match result's pending metadata (scr_regex.c) */ \
  X(MESSAGE_EVENT, 50) /* ScrEvent with data — BroadcastChannel's 'message' */ \
  X(MESSAGE_PORT, 36) \
  X(MIME_PARAMS, 81) /* util.MIMEParams (scr_mime.c) */ \
  X(MIME_TYPE, 82) /* util.MIMEType (scr_mime.c) */ \
  X(MODULE_NAMESPACE, 79) /* module namespace object read through its exports (scr_module_namespace.c) */ \
  X(NAVIGATOR, 83) /* Node's navigator global (scr_node_builtin.c) */ \
  X(NET_BLOCK_LIST, 48) /* net.BlockList (scr_net.c) */ \
  X(NET_SERVER, 3) /* ScrNetServer — net.Server (http.Server rides the same handle) */ \
  X(NET_SOCKET, 2) /* ScrNetSocket — net.Socket */ \
  X(NET_SOCKET_ADDRESS, 47) /* net.SocketAddress (scr_net.c) */ \
  X(PRIVATE_KEY, 65) /* node:crypto PrivateKeyObject (scr_pki.c) */ \
  X(PUBLIC_KEY, 66) /* node:crypto PublicKeyObject (scr_pki.c) */ \
  X(REGEXP, 26) /* native RegExp, shared compiled pattern */ \
  X(SEARCH_PARAMS, 33) /* live WHATWG URLSearchParams */ \
  X(SEGMENTER, 19) /* default Unicode grapheme segmentation */ \
  X(SEGMENTER_REFUSING, 80) /* word or sentence Segmenter whose segment() throws (scr_grapheme.c) */ \
  X(SEGMENTS, 20) /* iterable immutable segmentation result */ \
  X(SET, 25) /* native Set<unknown>, shared backing map */ \
  X(SHARED_ARRAY_BUFFER, 37) \
  X(SIGN, 67) /* node:crypto Sign (scr_pki.c) */ \
  X(STDIO, 27) /* stable process stdin/stdout/stderr values */ \
  X(STRING_DECODER, 78) /* compiled StringDecoder record (scr_text_codec_dyn.c) */ \
  X(TEXT_DECODER, 76) /* compiled TextDecoder record (scr_text_codec_dyn.c) */ \
  X(TEXT_ENCODER, 77) /* compiled TextEncoder record (scr_text_codec_dyn.c) */ \
  X(URL, 28) /* native WHATWG URL */ \
  X(VERIFY, 68) /* node:crypto Verify (scr_pki.c) */ \
  X(WASM_GLOBAL, 61) /* WebAssembly.Global */ \
  X(WASM_INSTANCE, 58) /* WebAssembly.Instance */ \
  X(WASM_MEMORY, 59) /* WebAssembly.Memory */ \
  X(WASM_MODULE, 57) /* WebAssembly.Module (scr_wasm.c) */ \
  X(WASM_TABLE, 60) /* WebAssembly.Table */ \
  X(WEAK_MAP, 23) /* native weak-key metadata */ \
  X(WEAK_SET, 24) /* native weak membership */ \
  X(WEB_CONTROLLER, 11) /* native ReadableStreamDefaultController */ \
  X(WEB_READER, 10) /* native ReadableStreamDefaultReader */ \
  X(WEB_STREAM, 9) /* native WHATWG ReadableStream */ \
  X(WEB_TRANSFORM, 73) /* native identity TransformStream (scr_fetch.c) */ \
  X(WEB_WRITABLE, 74) /* a TransformStream's WritableStream (scr_fetch.c) */ \
  X(WEB_WRITER, 75) /* WritableStreamDefaultWriter (scr_fetch.c) */ \
  X(WORKER, 35)

/* Tags added since the last pin, by name only (see above). */
#define SCR_DYNH_NEW_TAGS(Y)

/* Values below the largest pinned one that no tag holds, each with the
 * reason. Never reuse one without removing it here. */
#define SCR_DYNH_UNASSIGNED(Z) \
  Z(63) /* skipped: claimed by a branch that took another number */

/* One member per pinned tag, sized value + 1, so its size is the largest
 * pinned value + 1: the new tags are numbered from there. Never instantiated. */
union ScrDynhPinnedSpan {
#define SCR_DYNH_SPAN_ROW(name, value) char name[(value) + 1];
  SCR_DYNH_TAGS(SCR_DYNH_SPAN_ROW)
#undef SCR_DYNH_SPAN_ROW
};

typedef enum {
#define SCR_DYNH_ENUM_ROW(name, value) SCR_DYNH_##name = value,
  SCR_DYNH_TAGS(SCR_DYNH_ENUM_ROW)
#undef SCR_DYNH_ENUM_ROW
  SCR_DYNH__LAST_PINNED = (int)sizeof(union ScrDynhPinnedSpan) - 1,
#define SCR_DYNH_NEW_ROW(name) SCR_DYNH_##name,
  SCR_DYNH_NEW_TAGS(SCR_DYNH_NEW_ROW)
#undef SCR_DYNH_NEW_ROW
} ScrDynHandleTag;

#define SCR_DYNH_RANGE_ROW(name, value) \
  _Static_assert((value) < SCR_DYNH_CAPACITY, "SCR_DYNH_" #name " is not below SCR_DYNH_CAPACITY");
SCR_DYNH_TAGS(SCR_DYNH_RANGE_ROW)
#undef SCR_DYNH_RANGE_ROW
#define SCR_DYNH_NEW_RANGE_ROW(name) \
  _Static_assert(SCR_DYNH_##name < SCR_DYNH_CAPACITY, "SCR_DYNH_" #name " is not below SCR_DYNH_CAPACITY");
SCR_DYNH_NEW_TAGS(SCR_DYNH_NEW_RANGE_ROW)
#undef SCR_DYNH_NEW_RANGE_ROW

/* Never called: a case label per tag and per unassigned value, so two tags
 * with one value, or a tag on an unassigned value, are a duplicate case
 * value and the header does not compile. */
static inline void scr_dynh_tags_distinct(ScrDynHandleTag tag) {
  switch ((int)tag) {
#define SCR_DYNH_CASE_ROW(name, value) case SCR_DYNH_##name:
    SCR_DYNH_TAGS(SCR_DYNH_CASE_ROW)
#undef SCR_DYNH_CASE_ROW
#define SCR_DYNH_NEW_CASE_ROW(name) case SCR_DYNH_##name:
    SCR_DYNH_NEW_TAGS(SCR_DYNH_NEW_CASE_ROW)
#undef SCR_DYNH_NEW_CASE_ROW
#define SCR_DYNH_UNASSIGNED_CASE_ROW(value) case value:
    SCR_DYNH_UNASSIGNED(SCR_DYNH_UNASSIGNED_CASE_ROW)
#undef SCR_DYNH_UNASSIGNED_CASE_ROW
    break;
  }
}

typedef struct ScrDyn ScrDyn;
typedef struct ScrBytes ScrBytes; /* full definition below (C11 repeat) */
typedef struct ScrClosure ScrClosure; /* full definition below (C11 repeat) */
typedef struct ScrDynTypedCast {
  const char *type_key;
  size_t type_key_len;
  void *ptr;
  void *(*retain)(void *);
  void (*release)(void *);
  bool traced;
  struct ScrDynTypedCast *next;
} ScrDynTypedCast;

/* The compiler-emitted call glue carried by a SCR_DYN_FUNC box: checks the
 * dyn arguments against the boxed closure's declared parameter types (a
 * mismatch throws the catchable path-annotated TypeError and returns NULL
 * with the exception pending), calls through the closure, and returns the
 * result as an owned (+1) dyn value. `args` entries are BORROWED. */
typedef ScrDyn *(*ScrDynThunk)(ScrClosure *clo, ScrDyn *const *args, size_t argc);

/* A compiled 'message' listener's typed entry: builds the closure's
 * parameter from the message's nodes (the readers below) and calls
 * the closure. Answers false, without calling it, when the message does
 * not have the parameter's layout; the caller then decodes the message
 * and calls the thunk. */
struct ScrMessage;
typedef bool (*ScrDynMessageListener)(ScrClosure *clo, const struct ScrMessage *message);

/* The kinds of a message's nodes (scr_message.c). */
typedef enum {
  SCR_MESSAGE_UNDEFINED,
  SCR_MESSAGE_NULL,
  SCR_MESSAGE_BOOL,
  SCR_MESSAGE_NUMBER,
  SCR_MESSAGE_STRING,
  SCR_MESSAGE_BIGINT,
  SCR_MESSAGE_ARRAY,
  SCR_MESSAGE_OBJECT,
  SCR_MESSAGE_STORAGE,
  SCR_MESSAGE_BYTES,
  SCR_MESSAGE_ARRAY_BUFFER,
  SCR_MESSAGE_ERROR,
  /* A deeply frozen plain-data graph shared by pointer (see publication). */
  SCR_MESSAGE_PUBLISHED,
  /* A typed value published with @scriptc/threads (immortal), delivered as
   * a fresh typed-ref capsule over the same pointer. */
  SCR_MESSAGE_TYPED_REF,
  /* A transferred MessagePort: its channel end (+1) and side. */
  SCR_MESSAGE_PORT,
  /* A native handle cloned through its unit's ScrDynHandleTransfer. */
  SCR_MESSAGE_HANDLE,
} ScrMessageKind;

/* Readers for compiled 'message' listeners (ScrDynMessageListener), which
 * build their typed parameter from the nodes. Node 0 is the root, and a
 * node's values have higher numbers. scr_message_readable answers whether
 * the message can reach these listeners: no node is reached twice, and it
 * holds no ports or native handles, which the receiver adopts when it
 * decodes the message. kind answers a ScrMessageKind; number reads a
 * NUMBER or BOOL node, string a STRING node (+1). fields answers whether an
 * OBJECT node has exactly the given keys, in order, and writes their value
 * nodes. */
bool scr_message_readable(const struct ScrMessage *message);
int32_t scr_message_kind(const struct ScrMessage *message, size_t node);
double scr_message_number(const struct ScrMessage *message, size_t node);
ScrStr *scr_message_string(const struct ScrMessage *message, size_t node);
bool scr_message_fields(const struct ScrMessage *message, size_t node, const char *const *names,
                        const size_t *lengths, size_t count, size_t *values);

/* Object member. Keys own shared immutable UTF-8 bytes (NUL-terminated for
 * convenience; key_len excludes the NUL) — duplicate keys were already
 * collapsed at parse time (later wins, like JS JSON.parse). */
typedef struct {
  char *key;
  size_t key_len;
  ScrDyn *value; /* owned */
  ScrDyn *getter; /* owned when this is an accessor property */
  ScrDyn *setter; /* owned when this is an accessor property */
  bool accessor : 1;
  /* Snapshot written by trace before visiting children. Collected teardown
   * must not inspect the value: an earlier cycle member may already be freed.
   * Ordinary mutations need not maintain this collector-only decision. */
  bool value_traced : 1;
  /* A namespace object's function member (scr_dyn_namespace_define), which
   * static member calls bypass: a change to its value fences instead. */
  bool fenced : 1;
  /* Ordinary object insertion sets all three attributes true. */
  bool writable;
  bool enumerable;
  bool configurable;
} ScrDynEntry;

_Static_assert(sizeof(ScrDynEntry) == (sizeof(void *) == 8 ? 48 : 24),
               "LLVM checked-object readers use the target entry stride");
_Static_assert(offsetof(ScrDynEntry, value) == 2 * sizeof(void *),
               "LLVM checked-object readers use the third pointer-sized field");

/* Element access for a live typed reference to a native ScrArr, emitted per
 * array type by the compiler. The runtime decides presence and length from
 * the native array itself; these hooks only convert one element.
 *   get: +1 dyn view of the element at a dense index whose state is
 *        SCR_ARR_VALUE, built exactly as the whole-array snapshot builds it.
 *   set: stores `value` at index (index <= length) when it fits the element
 *        type and returns true; returns false with no side effects when it
 *        does not, so the caller can take the snapshot path and report the
 *        mismatch with its usual diagnostic. */
typedef struct ScrDynTypedArrayOps {
  ScrDyn *(*get)(void *arr, double index);
  bool (*set)(void *arr, double index, const ScrDyn *value);
} ScrDynTypedArrayOps;

/* Field access for a live typed reference to a declared-field record,
 * emitted per record shape by the compiler. `names` lists the fields in
 * the order the record's snapshot defines them; the compiler emits these
 * hooks only for shapes whose names are all ordinary (no array-index
 * spellings, no `__proto__`), so that order is also JS own-key order.
 *   has: whether field `index` is an own property (an absent optional
 *        field is not);
 *   get: +1 dyn view of field `index`, built exactly as the snapshot
 *        builds it. Callers check `has` first. */
typedef struct ScrDynTypedRecordOps {
  size_t count;
  ScrStr *const *names; /* immortal field-name strings */
  bool (*has)(void *rec, size_t index);
  ScrDyn *(*get)(void *rec, size_t index);
  /* Every field is required: `has` always answers true and no key of the
   * record can be deleted. */
  bool fixed;
  /* The field names as an immortal string[], built on first use by
   * for-in over a record with every field present (atomic slot). */
  ScrArr *keys;
  /* A shape whose values enumerate their keys in more than one order
   * (IrRecordShape.orderVariants) binds a table with only this hook: it
   * answers the table of the record's current order, which a write of an
   * optional key can change after the record is boxed. NULL in every other
   * table. */
  const struct ScrDynTypedRecordOps *(*select)(void *rec);
  /* Stores `value` into present field `index` in place when it fits the
   * field's type and answers true (also when the conversion itself threw,
   * which has then raised the write's error); answers false with no side
   * effects otherwise, leaving the snapshot path to raise its diagnostic.
   * NULL when the program never writes through a dynamic view, and for a
   * field whose storage it cannot replace (an inline union). */
  bool (*set)(void *rec, size_t index, const ScrDyn *value);
} ScrDynTypedRecordOps;
/* A record capsule's ops while it answers from the native record (no view
 * created yet), or NULL. */
const ScrDynTypedRecordOps *scr_dyn_typed_ref_live_record(const ScrDyn *d);
/* The declaration-typed boundary's adoption (scr_decl_adopt.c, linked by
 * programs with boundary casts): the nodes of `source` that something else
 * still references become live capsules of the native value `capsule`
 * holds. Both borrowed; a node that is not plain data throws the path
 * TypeError before anything changes. */
void scr_dyn_decl_adopt(ScrDyn *source, ScrDyn *capsule);
void scr_dyn_adopt_shared(ScrDyn *source, ScrDyn *capsule);
/* A checked conversion into a type an npm package declares failed
 * (scr_type_origin.c, linked by programs with such checks): the pending
 * TypeError's message gains the declaration and the type patch that would
 * admit the value. `origin` is the compiler's origin string. */
void scr_type_origin_note(const char *origin);

/* Prototype members of a compiled class seen as `unknown`, emitted per
 * class by the compiler: the string names of methods, getters and setters
 * declared on the class and its bases, and `constructor`. The checked
 * view of an instance holds only its own fields; `in` answers inherited
 * members from this table.
 *   exact: the table of the instance's own class when it may be a
 *          subclass of the capsule's static class; NULL otherwise. */
typedef struct ScrDynTypedClassOps {
  const struct ScrDynTypedClassOps *(*exact)(void *instance);
  size_t count;
  ScrStr *const *names; /* immortal member-name strings */
  ScrStr *class_name;   /* immortal constructor name; NULL for an anonymous class */
  /* The string an inherited Symbol.toStringTag getter answers for the
   * instance (+1), or NULL with a pending exception from the getter;
   * NULL when the class has no such getter. */
  ScrStr *(*string_tag)(void *instance);
} ScrDynTypedClassOps;

/* A compiled JavaScript class whose instances record their own properties
 * in a property bag and whose views inherit from the class's prototype
 * data, emitted per class by the compiler. The view of such an instance is
 * a fresh object holding exactly the bag's string-keyed properties, where
 * each declared field among them takes its value from the native slot, and
 * whose prototype is the class's. A method call can therefore resolve
 * without building the view (scr_dyn_typed_ref_bag_method).
 *   bag: the instance's bag, borrowed; NULL or undefined when it has none;
 *   prototype: +1 prototype a fresh view of the instance takes;
 *   names: the declared fields whose values come from native slots;
 *   field: +1 view value of declared field `index`. */
typedef struct ScrDynTypedBagClassOps {
  ScrDyn *(*bag)(void *instance);
  ScrDyn *(*prototype)(void *instance);
  size_t count;
  ScrStr *const *names; /* immortal field-name strings */
  ScrDyn *(*field)(void *instance, size_t index);
} ScrDynTypedBagClassOps;

struct ScrDyn {
  size_t rc; /* SIZE_MAX = immortal (unused for dyn; kept per convention) */
  ScrDynKind kind;
  /* SCR_DYN_BYTES flavor: true when the value REPRESENTS a Node Buffer
   * (stream chunks, buffer-typed boundary crossings) — Buffer's string
   * coercion and toString() decode utf8, where a plain Uint8Array joins
   * its elements ("1,2,3"). Everything else ignores it. */
  bool buffer;
  /* SCR_DYN_OBJ flavor: true for Object.create(null)'s dictionary — an
   * object with NO prototype. Method dispatch needs nothing (the checked-dynamic tree's
   * OBJ dispatch is already own-member-only, which IS Node's null-proto
   * answer); util.inspect prefixes "[Object: null prototype]", and
   * deepStrictEqual separates it from plain objects (Node compares
   * prototypes — the bytes `buffer` gate's stance). Keyed reads/writes,
   * Object.keys/entries/assign, JSON, and typeof are flag-blind, and
   * fresh copies (structuredClone) DROP the flag — Node's serialization
   * answers a plain object too. */
  bool null_proto;
  /* A deep typed-to-dyn copy has no stable native reference identity.
   * Weak collections must refuse it instead of weakly tracking its box. */
  bool copied_from_native;
  bool non_extensible; /* native objects and arrays; fits the header padding */
  union {
    bool b;
    double num;
    ScrStr *str; /* owned */
    ScrBytes *bytes; /* owned (SCR_DYN_BYTES) */
    ScrBigInt *bigint; /* owned (SCR_DYN_BIGINT) */
    /* Callbacks keep the optional symbol unit out of symbol-free binaries. */
    struct { ScrSym *value; void (*release)(ScrSym *); ScrStr *(*render)(ScrSym *); ScrStr *(*description)(ScrSym *); } symbol;
    struct { size_t len; size_t cap; ScrDyn **items; struct ScrDyn *properties; bool sealed; bool frozen; unsigned char *presence; struct ScrDynRegion *region; } arr; /* owned; NULL presence means dense; region: see ScrDynRegion */
    struct {
      size_t len; /* own string-keyed properties, in both modes */
      size_t cap; /* capacity of entries (dictionary mode) or slots (layout mode) */
      /* Layout mode (`layout` non-NULL): slots[i] holds the value of the
       * property layout->keys[i] names, a writable, enumerable,
       * configurable data property. Dictionary mode (`layout` NULL):
       * entries hold keys, values and attributes. See ScrLayout. */
      union {
        ScrDynEntry *entries;
        struct ScrDyn **slots;
      };
      /* Optional identity of the typed record that produced this ordinary
       * snapshot. Empty records and callback interfaces can retain their
       * source across repeated static-to-dynamic crossings. */
      /* Owned through source_access(source_identity, false). Callback
       * interfaces may request a fresh snapshot with the true arm. */
      void *source_identity;
      ScrDyn *(*source_access)(void *, bool materialize);
      struct ScrDynObjectIndex *index; /* dictionary mode: optional wide-object lookup; owns no values */
      /* On a runtime-built class prototype (e.g. url.Url.prototype) and
       * on a compiled class's prototype object: the constructor name
       * (static or immortal text) util.inspect prints for objects
       * inheriting from it (scr_dyn_class_name). NULL otherwise. Names
       * that are copies live on prototypes that live until their thread
       * exits, and those clear it before release; reuse of a freed object
       * resets it (scr_dyn_alloc). */
      const char *class_name;
      struct ScrDynRegion *region; /* see ScrDynRegion */
      /* The object's layout in layout mode, NULL in dictionary mode. The
       * dynamic tier's inline caches key on it. */
      const struct ScrLayout *layout;
      /* Layout mode: bit i is the collector's snapshot of whether slot i's
       * value is traced (ScrDynEntry.value_traced in dictionary mode). */
      size_t slots_traced;
    } obj; /* owned */
    /* SCR_DYN_FUNC: the boxed closure (owned) + its call descriptor. `sig`
     * and `name` are static compiler-emitted literals (never freed); name
     * may be NULL (anonymous — inspect prints [Function (anonymous)]).
     * The dyn→closure ownership edge is traced by the cycle collector. */
    struct { ScrClosure *clo; ScrDynThunk thunk; const char *sig; const char *name; uint32_t arity; ScrClassObj *class_obj; ScrDynMessageListener message; } fn;
    /* Native handles normally keep conservative ownership edges. Sets
     * backed by cycle-capable maps expose their edge to the collector.
     * Cache that allocation property: during collection the map may be
     * freed before its box, so disposal must not inspect the map again. */
    struct { void *ptr; ScrDynHandleTag tag; bool traced; } handle;
    /* SCR_DYN_TYPED_REF: original static value + its compiler-emitted
     * identity tag, RC adapters, and ordinary dyn snapshot adapter. */
    struct {
      void *ptr;
      void *(*retain)(void *);
      void (*release)(void *);
      const char *type_key;
      ScrDyn *(*materialize)(void *);
      void (*commit)(void *, const ScrDyn *);
      /* Live native arrays: per-element access that bypasses the whole-array
       * snapshot (scr_dyn_typed_ref_bind_array). Declared-field records
       * keep their ScrDynTypedRecordOps here instead, flagged by `record`
       * (scr_dyn_typed_ref_bind_record), and class instances their
       * ScrDynTypedClassOps, flagged by `klass`
       * (scr_dyn_typed_ref_bind_class), or their ScrDynTypedBagClassOps,
       * flagged by `bag_class` (scr_dyn_typed_ref_bind_bag_class). NULL for
       * other referents. */
      const ScrDynTypedArrayOps *array;
      /* Both caches belong to this capsule. ReadableStream canonicalizes
       * capsules for repeated source references, so the refreshed dyn view
       * and every structurally converted static view keep JS reference
       * identity while the source reference remains observable. */
      ScrDyn *materialized;
      ScrDynTypedCast *casts;
      /* One word keeps this, the largest payload, at its previous size.
       * Dynamic-tier inline caches read record, klass and bag_class as
       * the word's top three bits (backend/llvm/js-ic.ts nativeArray). */
      uint32_t type_key_len : 27;
      uint32_t traced : 1; /* native referent has a cycle header */
      uint32_t observed : 1; /* native release reports this identity's disposal */
      uint32_t record : 1; /* `array` holds ScrDynTypedRecordOps */
      uint32_t klass : 1; /* `array` holds ScrDynTypedClassOps */
      uint32_t bag_class : 1; /* `array` holds ScrDynTypedBagClassOps */
    } typed_ref;
    /* SCR_DYN_PROMISE: the retained promise. The boundary contract: it
     * settles with a dyn payload (SCR_EXC_REF ScrDyn fulfillment or a
     * void fulfillment awaiters read as the undefined value) — the
     * emitted converters guarantee it (direct box for promise<dyn>,
     * adapter promise otherwise). */
    ScrPromise *promise;

    struct { ScrDyn *target; ScrDyn *handler; } proxy; /* both owned */
  } v;
  /* Keep the checked value payload at its established offset: generated
   * native converters read array and object fields directly. */
  struct ScrDyn *prototype;
  /* Symbol properties have their own descriptor table. Its private string
   * keys encode native identities; symbol_keys retains the actual keys in
   * insertion order, never exposing those encodings to JavaScript. */
  struct ScrDyn *symbol_properties;
  struct ScrDyn *symbol_keys;
};
/* Compiled class dispatch reads a capsule's instance and key in place. */
_Static_assert(offsetof(ScrDyn, v.typed_ref.ptr) == 16, "typed_ref.ptr offset");
_Static_assert(offsetof(ScrDyn, null_proto) == sizeof(size_t) + sizeof(ScrDynKind) + 1,
               "dyn-to-record conversions read null_proto at byte 13 (9 on wasm32)");
_Static_assert(offsetof(ScrDyn, v.typed_ref.type_key) == 16 + 3 * sizeof(void *),
               "typed_ref.type_key offset");
/* Emitted brand probes read type_key_len as the low 27 bits of the 32-bit
 * word after `casts` (native 88, wasm32 52). */
_Static_assert(offsetof(ScrDyn, v.typed_ref.casts) == 16 + 8 * sizeof(void *),
               "typed_ref.casts offset");
/* The region links ride in payload space the capsule variant already
 * reserves, so dyn nodes keep their size (and allocation size class). */
_Static_assert(sizeof(((ScrDyn *)0)->v.arr) <= sizeof(((ScrDyn *)0)->v.typed_ref) &&
               sizeof(((ScrDyn *)0)->v.obj) <= sizeof(((ScrDyn *)0)->v.typed_ref),
               "dyn region links must not grow the node");
/* Dynamic-tier inline caches read the layout word and slots in place (64-bit). */
_Static_assert(sizeof(void *) != 8 || offsetof(ScrDyn, v.obj.layout) == 80, "v.obj.layout offset");
_Static_assert(sizeof(void *) != 8 || offsetof(ScrDyn, v.obj.slots) == 32, "v.obj.slots offset");
_Static_assert(sizeof(void *) != 8 || offsetof(ScrDyn, v.obj.region) == 72, "v.obj.region offset");

/* ── layouts ───────────────────────────────────────────────────────────
 * An ordinary object (SCR_DYN_OBJ) is in one of two modes.
 *
 * Layout mode: v.obj.layout names the object's key sequence, a node of the
 * thread's interned transition tree, and v.obj.slots holds one value per
 * key (8 bytes per property). Every property of a layout-mode object is a
 * writable, enumerable, configurable data property; objects of one key
 * sequence share one layout, so a layout pointer proves which key sits at
 * each slot and which keys the object lacks (the dynamic tier's inline
 * caches key on it). New objects start in layout mode at the thread's
 * empty layout.
 *
 * Dictionary mode: v.obj.layout is NULL and v.obj.entries holds keys,
 * values and attributes (ScrDynEntry). An object moves there, once and for
 * good, when it gets an accessor, a non-default attribute, a delete, more
 * than SCR_LAYOUT_MAX_KEYS keys, when the thread's layout budgets are
 * spent, when it is published to other threads, and whenever code that
 * reads entries directly touches it (scr_dyn_obj_dict_entries): the conversion
 * is unobservable, so code that has not been taught layouts stays correct.
 *
 * Layouts belong to one thread and live until its runtime state is torn
 * down; they are never owned by a parse region. Each holds one reference
 * to its key's bytes (scr_json.c's shared key storage). */
#define SCR_LAYOUT_MAX_KEYS (8 * sizeof(size_t))

typedef struct ScrLayoutKey {
  char *key; /* shared key bytes; one reference belongs to the layout that added it */
  uint32_t len;
  uint32_t hash; /* low bits of scr_key_hash */
} ScrLayoutKey;

typedef struct ScrLayout {
  const ScrLayoutKey *keys; /* keys[0..count); shared along a chain of layouts */
  uint32_t count;
  uint32_t lookup_mask; /* capacity - 1 of `lookup`; 0 while it has none */
  uint8_t *lookup;      /* lazily built hash index: slot + 1, 0 = empty */
  const struct ScrLayout *parent;
  struct ScrLayout *last_child; /* the most recent transition from here */
  struct ScrLayoutKeys *store;  /* the key array `keys` lives in */
  struct ScrLayout *all_next;
  bool owns_store;
} ScrLayout;

/* The index of `key` in layout `layout`, or UINT32_MAX. */
uint32_t scr_layout_find(const ScrLayout *layout, const char *key, size_t key_len);
/* The layout that appends `key` (borrowed bytes) to `layout`, created on
 * first use; NULL past SCR_LAYOUT_MAX_KEYS or the thread's budgets. */
const ScrLayout *scr_layout_add(const ScrLayout *layout, const char *key, size_t key_len);
/* The thread's empty layout. */
const ScrLayout *scr_layout_root(void);
/* Moves a layout-mode object to dictionary mode (no-op otherwise). */
void scr_dyn_to_dictionary(ScrDyn *object);

/* v.obj.entries of an object in dictionary mode, converting a layout-mode
 * object first: code that reads or writes entries directly goes through
 * this. */
static inline __attribute__((always_inline)) ScrDynEntry *scr_dyn_obj_dict_entries(const ScrDyn *object) {
  if (__builtin_expect(object->v.obj.layout != NULL, 0)) scr_dyn_to_dictionary((ScrDyn *)object);
  return object->v.obj.entries;
}

/* scr_dyn_obj_key_at and scr_dyn_obj_value_at out of line, for emitted
 * code (borrowed results). */
const char *scr_dyn_member_key(const ScrDyn *object, size_t i);
size_t scr_dyn_member_key_len(const ScrDyn *object, size_t i);
ScrDyn *scr_dyn_member_value(const ScrDyn *object, size_t i);

/* ── own properties of ordinary objects ──────────────────────────────
 * The accessors are always inlined, so a binary that never sees an
 * ordinary object links no out-of-line copies. Code outside the object core (scr_json.c and scr_js_object.c) reads and
 * adjusts an SCR_DYN_OBJ's own string-keyed properties through these
 * accessors, never through v.obj.entries or v.obj.slots, so they work in
 * both modes. Index i runs over the properties in creation order,
 * 0 <= i < scr_dyn_obj_count. Keys and values are borrowed: they stay
 * valid until the object changes. */
typedef struct {
  const char *key;
  size_t key_len;
  ScrDyn *value;  /* data property; the undefined value for an accessor */
  ScrDyn *getter; /* accessor property; NULL when absent */
  ScrDyn *setter; /* accessor property; NULL when absent */
  bool accessor;
  bool writable;
  bool enumerable;
  bool configurable;
} ScrDynProp;

static inline __attribute__((always_inline)) size_t scr_dyn_obj_count(const ScrDyn *o) {
  return o->v.obj.len;
}

static inline __attribute__((always_inline)) const char *scr_dyn_obj_key_at(const ScrDyn *o, size_t i, size_t *key_len) {
  const ScrLayout *layout = o->v.obj.layout;
  if (layout) {
    *key_len = layout->keys[i].len;
    return layout->keys[i].key;
  }
  *key_len = o->v.obj.entries[i].key_len;
  return o->v.obj.entries[i].key;
}

/* The value of data property i (borrowed); the undefined value for an
 * accessor property, whose functions scr_dyn_obj_prop_at answers. */
static inline __attribute__((always_inline)) ScrDyn *scr_dyn_obj_value_at(const ScrDyn *o, size_t i) {
  return o->v.obj.layout ? o->v.obj.slots[i] : o->v.obj.entries[i].value;
}

static inline __attribute__((always_inline)) ScrDynProp scr_dyn_obj_prop_at(const ScrDyn *o, size_t i) {
  const ScrLayout *layout = o->v.obj.layout;
  if (layout)
    return (ScrDynProp){layout->keys[i].key, layout->keys[i].len, o->v.obj.slots[i], NULL, NULL,
                        false, true, true, true};
  const ScrDynEntry *e = &o->v.obj.entries[i];
  return (ScrDynProp){e->key, e->key_len, e->value, e->getter, e->setter,
                      e->accessor, e->writable, e->enumerable, e->configurable};
}

/* The index of own property `key`, or SIZE_MAX. A linear scan in
 * dictionary mode: for code that looks up options and headers, not for hot
 * property reads. */
static inline size_t scr_dyn_obj_index_of(const ScrDyn *o, const char *key, size_t key_len) {
  if (o->v.obj.layout) {
    uint32_t i = scr_layout_find(o->v.obj.layout, key, key_len);
    return i == UINT32_MAX ? SIZE_MAX : i;
  }
  for (size_t i = 0; i < o->v.obj.len; i++) {
    const ScrDynEntry *e = &o->v.obj.entries[i];
    if (e->key_len == key_len && memcmp(e->key, key, key_len) == 0) return i;
  }
  return SIZE_MAX;
}

/* Sets the attributes of property i (`writable` is ignored for an
 * accessor property): builtin objects the runtime builds restrict their
 * members this way right after adding them. */
static inline void scr_dyn_obj_set_attrs_at(ScrDyn *o, size_t i, bool writable, bool enumerable,
                                            bool configurable) {
  if (o->v.obj.layout && writable && enumerable && configurable) return;
  ScrDynEntry *e = &scr_dyn_obj_dict_entries(o)[i];
  if (!e->accessor) e->writable = writable;
  e->enumerable = enumerable;
  e->configurable = configurable;
}

/* ── intact parse regions ─────────────────────────────────────────────
 * Every heap dyn node carries a cycle header, so an ordinary release that
 * leaves an array or object alive buffers it as a possible cycle root, and
 * reading a member of a parsed document (`parsed[i]`, JSON.stringify's
 * walk) turns every container it touches into a candidate the collector
 * must later trace. A JSON.parse result cannot lie on a cycle until the
 * program stores a reference into it, so the parser tags the containers it
 * builds with one shared region, and the region stays INTACT until the
 * first store into any of its containers that could close a cycle.
 * structuredClone and message decoding tag the documents they build the
 * same way; "the parser" below means whichever producer built the region.
 *
 * Invariant: while a region is intact, every outgoing edge of each of its
 * containers is an edge the parser created or a store of a primitive, and
 * each parser edge leads to a node the parser created later in the same
 * region (a container of the region, or a primitive). Containers have no
 * prototype, accessors, symbol or named-array tables, and every property
 * is enumerable. Following edges therefore strictly increases
 * creation order, so no node of an intact region lies on a cycle — whatever
 * points INTO the region from outside, including containers of other
 * regions. Releases of intact containers skip candidate buffering.
 *
 * Why the flag is per region and not per container: a cycle can run
 * through a container that was never written. After `child.parent = root`
 * the last outside reference to the cycle may be dropped from `root`, which
 * still has only parser edges; root's release must buffer it. Invalidating
 * the whole region on the first write makes it do so.
 *
 * Soundness of skipping: any cycle consists of non-intact nodes only, and a
 * garbage cycle becomes garbage when its last outside reference is dropped
 * — a release of one of its own (non-intact) members, which buffers as
 * before. Nodes released while their region was intact cannot have been on
 * a cycle then, and nothing intact can reach a cycle (intact containers
 * reach only their own region). A missed barrier would leak a cycle (the
 * RC audit lanes report it); it cannot free live data, because the walk and
 * teardown of every node are unchanged.
 *
 * Writers call scr_dyn_region_store(container, value) where they store a
 * reference into an existing array or object (items, entries, accessors,
 * prototype, named array properties, symbol tables). Removals, permutations
 * of a container's own items, and stores of JSON primitives or undefined
 * keep the region intact; accessor and property definitions never do.
 * Published graphs are immortal and frozen, so their releases never get
 * here and they are never written. Regions are per thread like the nodes
 * that point at them. */
typedef struct ScrDynRegion {
  size_t refs; /* containers tagged with it, plus the parser while it runs */
  bool intact;
} ScrDynRegion;

static inline ScrDynRegion *scr_dyn_region_of(const ScrDyn *d) {
  return d->kind == SCR_DYN_ARR ? d->v.arr.region : d->kind == SCR_DYN_OBJ ? d->v.obj.region : NULL;
}

/* A value that can be stored without closing a cycle or changing what the
 * region holds: the JSON primitive kinds and undefined. Everything an
 * intact container reaches is therefore a container of its region or one
 * of these, which JSON.stringify relies on (scr_json_plain_container).
 * Immortal containers (published graphs) are not inert: they may hold
 * functions, accessors or prototypes. */
static inline bool scr_dyn_region_inert(const ScrDyn *value) {
  return value && (value->kind <= SCR_DYN_STR || value->kind == SCR_DYN_UNDEF);
}

/* Write barrier: `value` (NULL when unknown) is about to be stored into
 * `container`. Immortal (published) containers are shared across threads
 * and never released, so their region is left alone. */
static inline void scr_dyn_region_store(const ScrDyn *container, const ScrDyn *value) {
  ScrDynRegion *region = scr_dyn_region_of(container);
  if (region && region->intact && container->rc != SIZE_MAX && !scr_dyn_region_inert(value))
    region->intact = false;
}

/* Other whole-document producers (structuredClone, message decoding) open
 * a region, tag each container once its members are stored, and close
 * their own reference. They must hold the same invariant as the parser:
 * fresh containers only, edges to containers created later, inert leaves
 * only (else they clear `intact`). Tagging a non-container is a no-op. */
ScrDynRegion *scr_dyn_region_open(void);
void scr_dyn_region_tag(ScrDyn *d, ScrDynRegion *region);
void scr_dyn_region_close(ScrDynRegion *region);

static inline ScrDyn *scr_dyn_retain(ScrDyn *d) {
  if (d->rc != SIZE_MAX) {
    d->rc++;
  }
  return d;
}

void scr_dyn_release(ScrDyn *d); /* releases the tree recursively; NULL-tolerant */

/* The runtime class an object inherits from (util.inspect's constructor
 * name, found on its prototype chain), or NULL. */
static inline const char *scr_dyn_class_name(const ScrDyn *d) {
  for (const ScrDyn *p = d->prototype; p; p = p->prototype)
    if (p->kind == SCR_DYN_OBJ && p->v.obj.class_name) return p->v.obj.class_name;
  return NULL;
}

/* The element hooks of a live array capsule, or NULL (including for record
 * and class capsules, which keep their hooks in the same slot). */
static inline const ScrDynTypedArrayOps *scr_dyn_typed_ref_array_ops(const ScrDyn *d) {
  return d->v.typed_ref.record || d->v.typed_ref.klass || d->v.typed_ref.bag_class
             ? NULL
             : d->v.typed_ref.array;
}

/* BORROWED member lookup on a SCR_DYN_OBJ; NULL when the key is absent. */
ScrDyn *scr_dyn_obj_get(const ScrDyn *d, const char *key, size_t key_len);
/* Own-enumerable check on a SCR_DYN_OBJ. */
bool scr_dyn_obj_enumerable(const ScrDyn *d, const char *key, size_t key_len);
/* Stores own property `entry` of `source` on `target` with its attributes:
 * plain data properties by an ordinary write, others by their descriptor. */
void scr_dyn_copy_entry(ScrDyn *target, const ScrDyn *source, const ScrDynEntry *entry);
/* Literal discriminator tests used before selecting a typed record layout.
 * Missing fields and different primitive kinds never match. Borrowed args. */
bool scr_dyn_field_eq_str(const ScrDyn *d, const ScrStr *key, const ScrStr *value);
bool scr_dyn_field_eq_num(const ScrDyn *d, const ScrStr *key, double value);
bool scr_dyn_field_eq_bool(const ScrDyn *d, const ScrStr *key, bool value);
/* The case a union's checked match takes from its string discriminant: the
 * index in `values` of the string `d`'s own data property `key` holds, or
 * -1 when every literal test above fails (`d` is not an object, or its own
 * data property `key` holds no string among `values`), or -2 when only the
 * tests themselves can tell (a typed capsule, an accessor, or a property
 * `d` does not own). Borrowed args. */
int32_t scr_dyn_discriminant_case(const ScrDyn *d, const ScrStr *key, ScrStr *const *values,
                                  size_t count);

/* Object.keys/values/entries over the checked-dynamic tree: JS own-key order (array-index
 * keys ascending first), dyn-array results (+1); values/entries RETAIN
 * member nodes. null/undefined receivers throw Node's catchable
 * TypeError. */
ScrDyn *scr_dyn_obj_keys(const ScrDyn *v);
ScrDyn *scr_dyn_for_in_keys(const ScrDyn *v);
/* for-in keys as a native string[] (+1); NULL with an exception pending. */
ScrArr *scr_dyn_for_in_key_strs(const ScrDyn *v);
bool scr_dyn_for_in_stable(const ScrDyn *v);
/* Object.keys as a native string[] (+1); NULL with an exception pending. */
ScrArr *scr_dyn_obj_key_strs(const ScrDyn *v);
/* Object.entries as owned (key, value) pairs: compiled code moves each
 * pair into a native [string, any] row, then frees the snapshot with
 * scr_dyn_entry_pairs_free. NULL with an exception pending. */
typedef struct {
  ScrStr *key;
  ScrDyn *value;
} ScrDynEntryPair;
typedef struct {
  size_t count;
  ScrDynEntryPair pairs[];
} ScrDynEntryPairs;
ScrDynEntryPairs *scr_dyn_obj_entry_pairs(const ScrDyn *v);
void scr_dyn_entry_pairs_free(ScrDynEntryPairs *pairs);
/* Object.values as a native array of owned checked values in own-key order
 * (+1), for results compiled code only iterates, indexes or reads. NULL with
 * an exception pending. */
ScrArr *scr_dyn_obj_value_list(const ScrDyn *v);
/* Snapshot all own string keys of a SCR_DYN_OBJ in JS order. Returns +1. */
ScrDyn *scr_dyn_obj_own_keys(const ScrDyn *v);
ScrDyn *scr_dyn_own_keys(const ScrDyn *value);
ScrDyn *scr_dyn_get_own_property_names(const ScrDyn *value);
ScrDyn *scr_dyn_get_own_property_symbols(const ScrDyn *value);
/* The own property stored under a symbol key on an object (borrowed), or
 * NULL when it has none. */
ScrDynEntry *scr_dyn_own_symbol_entry(const ScrDyn *object, const ScrDyn *key);
/* The own symbol-keyed property `key` of `object` as a property view
 * (scr_dyn_obj_prop_at; `key` and `key_len` name its private storage
 * key); false when there is none. */
static inline bool scr_dyn_own_symbol_prop(const ScrDyn *object, const ScrDyn *key, ScrDynProp *out) {
  const ScrDynEntry *e = scr_dyn_own_symbol_entry(object, key);
  if (!e) return false;
  *out = (ScrDynProp){e->key, e->key_len, e->value, e->getter, e->setter,
                      e->accessor, e->writable, e->enumerable, e->configurable};
  return true;
}
/* Copies own property i of `source` to `target` (scr_dyn_copy_entry). */
static inline void scr_dyn_copy_prop_at(ScrDyn *target, const ScrDyn *source, size_t i) {
  if (source->v.obj.layout) {
    ScrDynProp prop = scr_dyn_obj_prop_at(source, i);
    ScrDynEntry entry = {(char *)prop.key, prop.key_len, prop.value, NULL, NULL,
                         false, false, false, true, true, true};
    scr_dyn_copy_entry(target, source, &entry);
    return;
  }
  scr_dyn_copy_entry(target, source, &source->v.obj.entries[i]);
}
/* The private storage name of a symbol key (+1). With it,
 * scr_dyn_symbol_init_own gives an object that has no symbol properties
 * yet its first one, a writable, enumerable, configurable data property
 * (value borrowed). */
ScrStr *scr_dyn_symbol_storage_name(const ScrDyn *key);
void scr_dyn_symbol_init_own(ScrDyn *object, ScrDyn *key, const ScrStr *storage, ScrDyn *value);
/* Object.hasOwn over a dyn receiver: OBJ member presence, ARR index
 * bounds ("length" included); nullish receivers throw Node's ToObject
 * TypeError; every other kind answers false. */
bool scr_dyn_has_own(const ScrDyn *v, const ScrStr *key);
bool scr_dyn_property_is_enumerable(const ScrDyn *value, const ScrStr *key);
/* Object.assign over dyn values (+1 target back; ToObject TypeError on a
 * nullish target). Sources visit own keys in order and copy entries that
 * are enumerable when reached; ARR/STR/BYTES expose index keys. Nullish
 * and scalar/function/handle sources copy nothing. */
ScrDyn *scr_dyn_assign(ScrDyn *target, const ScrDyn *src);
ScrDyn *scr_dyn_copy_data_properties(ScrDyn *target, const ScrDyn *src);
ScrDyn *scr_dyn_object_rest(const ScrDyn *source, const ScrDyn *excluded);
ScrDyn *scr_dyn_copy_property_descriptors(ScrDyn *target, const ScrDyn *src);
/* Variadic Object.assign (the spread-source form): the compiler packs
 * every source into one fresh dyn array — pack_push retains a plain
 * source in (BORROWED), pack_push_spread flattens a spread source through
 * the spread-call walk (V8's exact TypeError texts, `what` spelling the
 * spread expression; MAY THROW pending) — then assign_all copies each
 * pack element's own members onto the target left to right and answers
 * the target retained (+1; ToObject TypeError on a nullish target). */
void scr_dyn_pack_push(ScrDyn *pack, ScrDyn *v);
void scr_dyn_pack_push_spread(ScrDyn *pack, const ScrDyn *src, const ScrStr *what);
/* The iterated-path twin — a spread that is NOT the single last argument
 * takes V8's iterator-protocol failure texts, which describe the VALUE
 * ("object null", "number 5", ...) instead of spelling the expression. */
void scr_dyn_pack_push_spread_iter(ScrDyn *pack, const ScrDyn *src);
ScrDyn *scr_dyn_assign_all(ScrDyn *target, const ScrDyn *sources);
ScrDyn *scr_dyn_obj_values(const ScrDyn *v);
ScrDyn *scr_dyn_obj_entries(const ScrDyn *v);

/* dyn construction — the compiler-emitted static→dyn converters (sc_td_*)
 * and index-signature overflow machinery build dyn values directly.
 * Constructors return +1; _new_str RETAINS the string into the node.
 * arr_push and obj_set take OWNERSHIP of the value (+1 moves in); obj_set
 * COPIES the key bytes and replaces a duplicate key's value (later wins,
 * like JS). scr_dyn_undefined returns THE immortal undefined value
 * (rc == SIZE_MAX — retains/releases are no-ops). */
ScrDyn *scr_dyn_undefined(void);
ScrDyn *scr_dyn_new_null(void);
ScrDyn *scr_dyn_new_bool(bool b);
ScrDyn *scr_dyn_new_num(double n);
ScrDyn *scr_dyn_native_set_new(const ScrDyn *seed);
ScrDyn *scr_dyn_native_set(ScrMap *value); /* borrowed backing, +1 box */
bool scr_dyn_native_set_is(const ScrDyn *value);
ScrDyn *scr_dyn_native_map(ScrMap *value); /* borrowed backing, +1 box */
/* `new Map(entries)` over a checked-dynamic seed: +1, or NULL with the
 * exception pending. */
ScrDyn *scr_dyn_native_map_new(const ScrDyn *seed);
bool scr_dyn_native_map_is(const ScrDyn *value);
void scr_regex_reset_last_index(ScrRegex *re, double index);
ScrRegex *scr_regex_new_checked(const ScrDyn *pattern, const ScrDyn *flags);
ScrDyn *scr_dyn_native_url(ScrUrl *value);
bool scr_dyn_native_url_is(const ScrDyn *value);
ScrDyn *scr_dyn_native_search_params(ScrSearchParams *value);
bool scr_dyn_native_search_params_is(const ScrDyn *value);
bool scr_dyn_native_date_is(const ScrDyn *value);
/* Instances of program classes declared `extends Date` (scr_lib.c). */
void scr_date_class_operation_install(ScrDyn *time, ScrDyn *methods);
/* Set by scr_date_class_operation_install; NULL in a program without such
 * a class, where every wrapper below answers false or NULL. */
typedef struct {
  bool (*time)(const ScrDyn *value, double *time);
  ScrDyn *(*to_json)(const ScrDyn *value, const ScrDyn *key);
  ScrDyn *(*to_string)(const ScrDyn *value);
  ScrDyn *(*value_of)(const ScrDyn *value);
  ScrStr *(*name)(const ScrDyn *value);
  ScrDyn *(*method)(const ScrDyn *value, const char *key, size_t key_len);
} ScrDateClassHooks;
extern const ScrDateClassHooks *scr_date_class_hooks;
static inline bool scr_dyn_date_class_time(const ScrDyn *value, double *time) {
  return scr_date_class_hooks && scr_date_class_hooks->time(value, time);
}
static inline ScrDyn *scr_dyn_date_class_to_json(const ScrDyn *value, const ScrDyn *key) {
  return scr_date_class_hooks->to_json(value, key);
}
static inline ScrDyn *scr_dyn_date_class_to_string(const ScrDyn *value) {
  return scr_date_class_hooks->to_string(value);
}
static inline ScrDyn *scr_dyn_date_class_value_of(const ScrDyn *value) {
  return scr_date_class_hooks->value_of(value);
}
static inline ScrStr *scr_dyn_date_class_name(const ScrDyn *value) {
  return scr_date_class_hooks ? scr_date_class_hooks->name(value) : NULL;
}
static inline ScrDyn *scr_dyn_date_class_method(const ScrDyn *value, const char *key, size_t key_len) {
  return scr_date_class_hooks ? scr_date_class_hooks->method(value, key, key_len) : NULL;
}
bool scr_dyn_date_instance_is(const ScrDyn *value);
ScrDyn *scr_dyn_date_class_member(const ScrDyn *d, const char *key, size_t key_len);
double scr_dyn_date_arguments_time(const ScrDyn *arguments);
ScrDyn *scr_dyn_native_date_new(const ScrDyn *arguments);
ScrDyn *scr_dyn_native_date_new_fields(const ScrDyn *arguments);
ScrDyn *scr_dyn_native_date_new_value(const ScrDyn *arguments);
ScrStr *scr_dyn_object_tag_of(const ScrDyn *d);
ScrDyn *scr_dyn_native_date_from_ms(double ms);
typedef struct ScrDate ScrDate;
ScrDyn *scr_dyn_native_date(ScrDate *date);
double scr_dyn_native_date_value(const ScrDyn *value);
ScrDyn *scr_dyn_native_regex(ScrRegex *value);
bool scr_dyn_native_regex_is(const ScrDyn *value);
ScrDyn *scr_dyn_freeze(ScrDyn *value);
/* scr_dyn_freeze of a value that is not a function (objects, arrays,
 * primitives), for runtime callers freezing data they built. It never
 * creates a function's property table, so it adds no dynamic-tier code to
 * the programs that link it. */
ScrDyn *scr_dyn_freeze_data(ScrDyn *value);
bool scr_dyn_is_frozen(const ScrDyn *value);
ScrDyn *scr_dyn_new_bigint(ScrBigInt *value); /* borrows and retains value */
ScrDyn *scr_dyn_new_symbol(ScrSym *value); /* borrows and retains value */
ScrSym *scr_sym_well_known(ScrStr *name);
ScrDyn *scr_dyn_symbol_get(const ScrDyn *value, const ScrStr *key);
ScrDyn *scr_dyn_symbol_key_get(const ScrDyn *value, const ScrDyn *key, bool optional);
/* `using` and `await using` with a dyn value. scr_dyn_using_method runs the
 * declaration's checks: null and undefined answer undefined (nothing to
 * dispose); any other value that is not an object or function throws
 * Node's TypeError, as does a missing or non-callable [Symbol.dispose].
 * With `async`, [Symbol.asyncDispose] is read first and [Symbol.dispose]
 * is the fallback, and the answer records which one was found.
 * scr_dyn_using_dispose calls that answer with `value` as `this` at scope
 * exit and returns the call's result (+1; undefined for a sync fallback,
 * whose result `await using` does not await). Both borrow their operands
 * and return NULL with the exception pending. */
ScrDyn *scr_dyn_using_method(const ScrDyn *value, bool async);
ScrDyn *scr_dyn_using_dispose(const ScrDyn *method, const ScrDyn *value);
/* DisposableStack (scr_symbol.c). scr_disposable_stack_new answers a new
 * stack (+1). The use, adopt and defer calls borrow their operands, throw
 * Node's ReferenceError on a disposed stack and Node's TypeError on an
 * invalid resource or callback, and return false with the exception
 * pending. scr_disposable_stack_use_callback registers `dispose(value)`
 * with the error texts of use(); the compiler passes it the disposal of a
 * class instance, whose dyn view has no methods. The stack's other members
 * are function values and getters of its dyn handle. */
ScrDyn *scr_disposable_stack_new(void);
bool scr_disposable_stack_is(const ScrDyn *value);
bool scr_disposable_stack_use(const ScrDyn *stack, const ScrDyn *value);
bool scr_disposable_stack_use_callback(const ScrDyn *stack, const ScrDyn *value, const ScrDyn *dispose);
bool scr_disposable_stack_adopt(const ScrDyn *stack, const ScrDyn *value, const ScrDyn *on_dispose);
void scr_dyn_symbol_key_set(ScrDyn *value, ScrDyn *key, ScrDyn *stored);
/* scr_dyn_obj_set_field for a symbol-keyed field of a class instance's
 * view: replaces the value whatever the attributes copied into the view.
 * Does not consume stored. */
void scr_dyn_symbol_field_set(ScrDyn *value, ScrDyn *key, ScrDyn *stored);
void scr_dyn_symbol_key_placeholder(ScrDyn *value, ScrDyn *key);
bool scr_dyn_has_key_computed(const ScrDyn *value, const ScrDyn *key);
bool scr_dyn_has_own_computed(const ScrDyn *value, const ScrDyn *key);
bool scr_dyn_property_is_enumerable_computed(const ScrDyn *value, const ScrDyn *key);
void scr_dyn_key_delete_computed(ScrDyn *value, const ScrDyn *key, bool strict);
bool scr_dyn_reflect_delete_property(ScrDyn *target, const ScrDyn *key);
ScrStr *scr_dyn_string_constructor(const ScrDyn *value);
ScrDyn *scr_dyn_property_key_value(const ScrDyn *value);
ScrDyn *scr_dyn_to_numeric(const ScrDyn *value);
ScrDyn *scr_dyn_increment(const ScrDyn *value, bool increment);
/* Internal constructor consumes a retained symbol with its native operations. */
ScrDyn *scr_dyn_symbol_ref(ScrSym *value, void (*release)(ScrSym *), ScrStr *(*render)(ScrSym *), ScrStr *(*description)(ScrSym *));
ScrDyn *scr_dyn_new_str(ScrStr *s);
ScrDyn *scr_dyn_new_arr(void);
ScrDyn *scr_dyn_array_constructor(void);
/* Gives a builtin constructor value (Object, Array, Error) its builtin
 * `prototype`: non-writable, non-enumerable, non-configurable. Takes the
 * prototype. */
void scr_dyn_fn_seed_prototype(ScrDyn *function, ScrDyn *prototype);
/* The interned builtin constructor `name` (Object, Date, RegExp, Map, Set,
 * Promise, WeakMap, WeakSet) as a dynamic function value: +1. */
ScrDyn *scr_dyn_global_constructor(const ScrStr *name);
/* The interned function value of an error constructor ("TypeError"), or
 * NULL for other names. */
ScrDyn *scr_dyn_error_constructor(const char *name);
/* A builtin global function (setTimeout, setImmediate, process.nextTick, ...)
 * as an interned dynamic function value: +1. */
ScrDyn *scr_dyn_builtin_function(const ScrStr *name);
/* A standard namespace object (Math, JSON, Reflect read as a JavaScript
 * value): an ordinary object whose Symbol.toStringTag is `tag` (+1).
 * `tag_key` is the Symbol.toStringTag key (borrowed), which the compiler
 * passes so this unit needs no symbol entry points. */
ScrDyn *scr_dyn_namespace_new(const ScrStr *tag, ScrDyn *tag_key);
/* Defines the own data property `key` of a namespace object. `attributes`
 * has bits 1 writable, 2 enumerable, 4 configurable; a function value
 * takes `length` as its length when it is not negative. */
void scr_dyn_namespace_define(ScrDyn *object, const ScrStr *key, ScrDyn *value, double attributes,
                              double length);
/* Marks the own property `key` of `object` as a fenced namespace member
 * (ScrDynEntry.fenced). */
void scr_dyn_fence_member(ScrDyn *object, const ScrStr *key);
/* A constant-key read of an Object.prototype member name: takes the
 * ordinary read's +1 result and answers the inherited member in place of
 * an undefined one (scr_dyn_invoke.c). */
ScrDyn *scr_dyn_inherited_read(const ScrDyn *d, const ScrStr *key, ScrDyn *read);
/* The member `key` read on Object.prototype itself, or NULL for any other
 * receiver (scr_dyn_invoke.c). */
ScrDyn *scr_dyn_object_prototype_member(const ScrDyn *d, const ScrStr *key);
bool scr_dyn_arr_has_index(const ScrDyn *arr, size_t index);
void scr_dyn_arr_push_hole(ScrDyn *arr);
ScrDyn *scr_dyn_new_obj(void);
ScrDyn *scr_dyn_iterator(const ScrDyn *value, const ScrStr *spell);
/* for await over a checked-dynamic value (scr_dyn_for_await.c). */
ScrDyn *scr_dyn_async_iterator_open(ScrDyn *value, ScrStr *spell);
bool scr_dyn_async_iterator_was_sync(void);
void scr_dyn_async_iterator_set_sync(bool sync);
ScrDyn *scr_dyn_iterator_optional(const ScrDyn *value);
/* from.js's probe: 2 when value[Symbol.asyncIterator] is set, 1 when
 * value[Symbol.iterator] is, 0 for neither, -1 with an error pending. */
int scr_dyn_iterable_kind(const ScrDyn *value);
/* from.js's iterator: value[Symbol.asyncIterator]() when that method is
 * set (*kind 2), else value[Symbol.iterator]() (*kind 1), reading each
 * method once. +1 iterator; NULL with *kind 0 when neither is set, or
 * with *kind -1 and the error pending (also for a compiled generator,
 * which only typed code can step). */
ScrDyn *scr_dyn_from_iterator(const ScrDyn *value, int *kind);
/* scr_dyn_from_iterator, also answering a compiled generator the method
 * returns when `generators` is set (for await steps it through its
 * checked-dynamic next/return members). */
ScrDyn *scr_dyn_open_iterator(const ScrDyn *value, int *kind, bool generators);
/* One field of an iterator result object (value, done), read the way the
 * for-of protocol reads it. +1, or NULL with the error pending. */
ScrDyn *scr_dyn_iterator_result_get(const ScrDyn *result, const char *key, size_t len);
void scr_dyn_install_iterator_symbol(ScrDyn *key);
/* Symbol.for('nodejs.util.inspect.custom'): the symbol unit installs it
 * when the registry creates it; NULL (borrowed) until then. */
void scr_dyn_install_inspect_custom_symbol(ScrDyn *key);
ScrDyn *scr_dyn_inspect_custom_symbol(void);
void scr_dyn_install_has_instance_symbol(ScrDyn *key);
void scr_dyn_install_async_iterator_symbol(ScrDyn *key);
void scr_dyn_install_async_dispose_symbol(ScrDyn *key);
void scr_dyn_install_species_symbol(ScrDyn *key);
/* Records each well-known symbol the symbol unit creates. */
void scr_dyn_install_well_known_symbol(ScrDyn *key);
void scr_dyn_install_to_string_tag_symbol(ScrDyn *key);
/* True when key is Symbol.asyncDispose (registered by the symbol unit when
 * the program names it); handle symbol_get ops outside that unit use it. */
bool scr_dyn_is_async_dispose_symbol(const ScrDyn *key);
ScrDyn *scr_dyn_array_values_function(void);
ScrDyn *scr_dyn_array_from_iterator(const ScrDyn *value);
ScrDyn *scr_dyn_iterator_result(ScrDyn *value);
/* Internal consumption of a captured builtin next method. Check can_step
 * once before entering the loop. step returns an owned ordinary value;
 * read step_done immediately afterward, before running any user code. */
bool scr_dyn_iterator_can_step(const ScrDyn *iterator, const ScrDyn *next);
ScrDyn *scr_dyn_iterator_step(const ScrDyn *iterator);
bool scr_dyn_iterator_step_done(const ScrDyn *iterator);
/* A native Map or Set iterator stepped by the compiler's typed walk: the
 * next live entry index of its collection, or -1 once the collection is
 * exhausted (the iterator then ends its iteration). */
double scr_dyn_collection_iterator_index(const ScrDyn *iterator);
/* For util.inspect: a native iterator's kind (0 array or typed array,
 * 1 string, 2 Map, 3 Set, 4 a handle's), its selection (0 values, 1 keys,
 * 2 entries), its collection (NULL once exhausted, and for kinds other
 * than 2 and 3) and the index its next step reads from. */
void scr_dyn_native_iterator_state(const ScrDyn *iterator, unsigned *kind, unsigned *selection,
                                   ScrMap **collection, double *index);
/* A compiled program that boxes generators and calls iterator helpers on
 * untyped values registers the checked functions that read a generator
 * capsule's next and return methods (each takes the capsule). The
 * iterator helpers below then drive compiled generators. */
void scr_dyn_set_generator_members(ScrDyn *next_getter, ScrDyn *return_getter);
/* An iterator helper method called on a synchronous generator capsule:
 * true with *out set (+1, or NULL with the exception pending) when
 * `method` is one. NULL until the program registers its generator
 * members. */
extern SCR_TL bool (*scr_dyn_generator_helper_hook)(ScrDyn *recv, const char *method,
                                                    ScrDyn *const *args, size_t argc,
                                                    ScrDyn **out);
/* The Iterator.prototype helper method `name` as a function value (+1),
 * the value a compiled generator's helper property reads; undefined for
 * other names. */
ScrDyn *scr_dyn_iterator_helper_method(const ScrStr *name);
/* The ordinary object snapshot plus a retained typed source. source_access
 * releases that source when materialize=false and returns a fresh snapshot
 * when true. */
ScrDyn *scr_dyn_new_obj_with_identity(
    void *source, void *(*source_retain)(void *),
    ScrDyn *(*source_access)(void *, bool materialize));
bool scr_dyn_obj_same_source(const ScrDyn *a, const ScrDyn *b);
void *scr_dyn_obj_source_cast(const ScrDyn *d,
    ScrDyn *(*source_access)(void *, bool), void *(*source_retain)(void *));
/* Object.create(null): the fresh null-prototype dictionary (see the
 * null_proto flavor flag above). */
ScrDyn *scr_dyn_new_obj_null_proto(void);
ScrDyn *scr_dyn_obj_create(ScrDyn *prototype);
ScrDyn *scr_dyn_obj_create_with_properties(ScrDyn *prototype, ScrDyn *descriptors);
ScrDyn *scr_dyn_get_prototype_for_identity(ScrDyn *object);
bool scr_dyn_bag_create_field(ScrDyn *bag, const ScrStr *key);
bool scr_dyn_is_class_capsule(const ScrDyn *d);
ScrDyn *scr_dyn_get_prototype(ScrDyn *object);
ScrDyn *scr_dyn_get_own_property_descriptors(ScrDyn *object);
ScrDyn *scr_dyn_set_prototype(ScrDyn *object, ScrDyn *prototype);
ScrDyn *scr_dyn_prevent_extensions(ScrDyn *object);
bool scr_dyn_is_extensible(ScrDyn *object);
ScrDyn *scr_dyn_seal(ScrDyn *object);
bool scr_dyn_is_sealed(const ScrDyn *object);
ScrDyn *scr_dyn_proxy_new(const ScrDyn *target, const ScrDyn *handler);
bool scr_dyn_is_callable(const ScrDyn *value);
ScrDyn *scr_dyn_proxy_get(const ScrDyn *proxy, const ScrStr *key);
bool scr_dyn_proxy_has(const ScrDyn *proxy, const ScrStr *key);
ScrDyn *scr_dyn_own_descriptor(const ScrDyn *value, const ScrStr *key);
void scr_dyn_proxy_set(ScrDyn *proxy, ScrStr *key, ScrDyn *value);
void scr_dyn_proxy_delete(ScrDyn *proxy, const ScrStr *key);
void scr_dyn_proxy_unsupported(const char *operation);
/* Retains the native view, preserving identity and its shared backing
 * allocation across the checked-dynamic boundary. Borrows b. */
ScrDyn *scr_dyn_new_bytes(const ScrBytes *b);
ScrDyn *scr_bytes_constructor(const ScrStr *name);
bool scr_bytes_instanceof(const ScrDyn *value, const ScrDyn *callee);
bool scr_bytes_instanceof_at(const ScrDyn *value, const ScrDyn *callee, const ScrStr *refusal);
bool scr_dyn_data_view_is(const ScrDyn *value);
ScrDyn *scr_dyn_construct(const ScrDyn *callee, const ScrDyn *args, const ScrStr *what);
ScrDyn *scr_bytes_construct(const ScrDyn *callee, const ScrDyn *args, const ScrStr *what);
/* Installed by scr_dyn_invoke.c when it interns a builtin constructor value
 * (scr_dyn_global_constructor): false when `callee` is not one of them;
 * otherwise true with `new callee(...args)` in *result (+1, or NULL with
 * the exception pending). */
extern SCR_TL bool (*scr_dyn_global_construct_fn)(const ScrDyn *callee, const ScrDyn *args,
                                                  ScrDyn **result);
ScrDyn *scr_dyn_bytes_key_get(const ScrDyn *value, const ScrStr *key);
/* A typed array's, Buffer's or DataView's own named property (+1), or NULL
 * without an exception when it has none. */
ScrDyn *scr_bytes_named_get(const ScrDyn *view, const char *key, size_t key_len);
/* The Buffer-flavored twin (stream chunks): string coercion/toString
 * decode utf8 instead of joining elements. */
ScrDyn *scr_dyn_new_buffer(const ScrBytes *b);
/* Identity-preserving transit capsule used by ReadableStream.from over
 * typed arrays. The constructor retains `ptr`; matching unbox returns +1.
 * materialize lazily creates and then retains one detached dyn snapshot.
 * The cast cache lets a non-exact dynCheck reuse one safe, compiler-built
 * target view instead of raw-casting structurally different layouts. */
ScrDyn *scr_dyn_new_typed_ref(
    void *ptr, void *(*retain)(void *), void (*release)(void *),
    const char *type_key, size_t type_key_len,
    ScrDyn *(*materialize)(void *),
    void (*commit)(void *, const ScrDyn *));
ScrDyn *scr_dyn_new_typed_ref_traced(
    void *ptr, void *(*retain)(void *), void (*release)(void *),
    const char *type_key, size_t type_key_len,
    ScrDyn *(*materialize)(void *),
    void (*commit)(void *, const ScrDyn *));
ScrDyn *scr_dyn_new_typed_ref_observed(
    void *ptr, void *(*retain)(void *), void (*release)(void *),
    const char *type_key, size_t type_key_len,
    ScrDyn *(*materialize)(void *),
    void (*commit)(void *, const ScrDyn *));
bool scr_dyn_typed_ref_is(
    const ScrDyn *d, const char *type_key, size_t type_key_len);
bool scr_dyn_typed_ref_is_key(const ScrDyn *d, const ScrStr *type_key);
void *scr_dyn_typed_ref_unbox(const ScrDyn *d); /* +1 */
void *scr_dyn_typed_ref_prefix_view(const ScrDyn *d); /* +1 or NULL */
ScrDyn *scr_dyn_class_view_unavailable(void *ptr);
ScrDyn *scr_dyn_typed_ref_materialize(const ScrDyn *d); /* +1 */
ScrDyn *scr_dyn_typed_ref_peek(const ScrDyn *d); /* +1 */
/* What string conversion renders for a capsule (+1): its materialized
 * view, or, for an EventTarget or Event subclass without its own
 * toString, the "[object EventTarget]" / "[object Event]" string of its
 * inherited @@toStringTag. */
ScrDyn *scr_dyn_typed_ref_string_view(const ScrDyn *d);
void scr_dyn_typed_ref_commit(ScrDyn *d);
/* Attach per-element access to a live array capsule (idempotent). Indexed
 * reads, `length`, in-range writes, `in`, own-property probes, and array
 * iteration then touch one element instead of rebuilding the snapshot. */
void scr_dyn_typed_ref_bind_array(ScrDyn *d, const ScrDynTypedArrayOps *ops);
/* Attach per-field access to a live record capsule (idempotent). While the
 * capsule has no cached checked view (nothing has added properties or
 * changed its prototype), keyed reads of declared fields, `in`/hasOwn,
 * for-in, Object.keys/values/entries, typeof and Array.isArray answer from
 * the native record, creating only the field values they return. */
void scr_dyn_typed_ref_bind_record(ScrDyn *d, const ScrDynTypedRecordOps *ops);
/* Undeclared properties of checked records (scr_json.c). The checked
 * record builder notes its source object; a record whose source had own
 * properties the shape does not declare keeps them, in own-key order, in a
 * retained view released with the record. Its capsules adopt that view, and
 * the typed serializers consult `has` to serialize through the capsule.
 * `apply` consumes a fresh copying snapshot and returns it merged (+1). */
void scr_record_source_note(void *rec, const ScrDyn *src, const char *const *names,
                            const size_t *lens, size_t count);
bool scr_record_source_has(const void *rec);
/* A literal that starts with `...src` creates src's keys first, in src's
 * order: when src kept a source, the fresh record `dst` (whose shape's
 * declared names are `names`) keeps one listing the keys it declares in
 * that order. Undeclared keys are not copied, as the literal copies none. */
void scr_record_source_spread(void *dst, const void *src, const char *const *names,
                              const size_t *lens, size_t count);
/* Object.freeze of a record a program may freeze: sets SCR_RC_FROZEN in its
 * rc word (immortal records are left as they are). */
void scr_record_freeze(void *record);
/* Node's TypeError for a write to a frozen record: operation 0 assigns the
 * existing property `key`, 1 adds it, 2 deletes it. `owner` is the object's
 * text in the message ("#<Object>"). */
void scr_record_throw_frozen(ScrStr *key, ScrStr *owner, double operation);
/* The commit of a live record view converts the view into a new record
 * `from`, whose conversion keeps the view's undeclared properties, then
 * moves its fields into `to`: this moves the kept properties to `to` too,
 * replacing any `to` had. */
void scr_record_source_move(void *from, void *to);
ScrDyn *scr_record_source_view(const void *rec);
ScrDyn *scr_record_source_apply(ScrDyn *snapshot, const void *rec);
/* Attach the prototype member names of a class instance capsule
 * (idempotent), so `in` sees its methods and accessors. */
void scr_dyn_typed_ref_bind_class(ScrDyn *d, const ScrDynTypedClassOps *ops);
/* A class instance capsule's inherited Symbol.toStringTag string from its
 * class's getter (+1); NULL when it has none or the getter threw. */
ScrStr *scr_dyn_typed_ref_class_tag(const ScrDyn *d);
/* Attach the bag and prototype hooks of a capsule of a bag-tracked class
 * instance (idempotent). */
void scr_dyn_typed_ref_bind_bag_class(ScrDyn *d, const ScrDynTypedBagClassOps *ops);
/* The method `key` that a call on a bag-tracked class instance capsule
 * reads from its view, +1, when an ordinary data property answers it: an
 * own one (a declared field's value from its native slot, or another bag
 * property's value), or else one on the view's prototype chain. NULL when
 * only the view can answer (the caller builds it), and also NULL, with the
 * exception pending, when the prototype hook threw. Never runs user
 * code. */
ScrDyn *scr_dyn_typed_ref_bag_method(const ScrDyn *d, const char *key, size_t key_len);
/* The constructor name of a class instance capsule's own class, for
 * util.inspect; NULL when the capsule is not a bound class instance, its
 * class is anonymous, or its prototype was replaced. */
const ScrStr *scr_dyn_typed_ref_class_name(const ScrDyn *d);
/* Whether a class instance capsule's class prototype chain defines a
 * method or accessor named key; false for other values. */
bool scr_dyn_typed_ref_class_has(const ScrDyn *d, const ScrStr *key);
/* Fast keyed read on a live array capsule: +1 value for `length` and for
 * present or explicitly-undefined elements; NULL when the answer needs the
 * snapshot (holes, out-of-range, non-index names, or no bound ops). */
ScrDyn *scr_dyn_typed_ref_key_get(const ScrDyn *d, const ScrStr *key);
/* +1 view of an own element of a bound live array capsule; NULL for a hole
 * or an index at or past its length. */
ScrDyn *scr_dyn_typed_ref_element(const ScrDyn *d, size_t index);
/* d[index] for a numeric index (+1) when the receiver answers it without
 * the property-key string: an in-range element of a dyn array, or a present
 * or explicitly undefined element of a live array capsule. NULL otherwise
 * (other receivers, holes, out-of-range and non-index numbers), and the
 * caller takes the keyed path. Never throws. */
ScrDyn *scr_dyn_index_get(const ScrDyn *d, double index);
void *scr_dyn_typed_ref_cached_cast(
    const ScrDyn *d, const char *type_key, size_t type_key_len); /* +1/NULL */
void scr_dyn_typed_ref_cache_cast(
    ScrDyn *d, const char *type_key, size_t type_key_len, void *ptr,
    void *(*retain)(void *), void (*release)(void *), bool traced);
/* Retains a SCR_DYN_BYTES view (+1) for checked extraction. */
ScrBytes *scr_dyn_bytes_unbox(const ScrDyn *d);
/* Exact numeric typed-array brand; elem is a ScrBytesElem tag. */
bool scr_dyn_bytes_is(const ScrDyn *d, int elem);
bool scr_dyn_typed_array_is(const ScrDyn *d, int elem);
bool scr_dyn_util_type_is(const ScrDyn *value, const ScrStr *probe);
ScrDyn *scr_dyn_util_type_value(const ScrDyn *value, const ScrStr *probe);
void scr_dyn_arr_push(ScrDyn *arr, ScrDyn *item);
/* Spread completion for a runtime-arity argument list (`f(...xs)` in the
 * checked-dynamic tier): flattens `src` into `arr` per JS's spread over the
 * dyn's iterable kinds — arrays element-by-element (retained), strings by
 * code POINT (the string iterator), bytes by byte — and throws V8's exact
 * SPREAD-CALL TypeError for every other kind (pending; callers check):
 * nullish sources spell the spread expression (`what`), everything else is
 * the generic "Spread syntax requires ..." text. Borrows src. */
void scr_dyn_arr_push_spread(ScrDyn *arr, const ScrDyn *src, const char *what);
/* Destructuring pack over a dyn source: iterable kinds (arrays, strings by
 * code point, bytes) collect into a fresh array (+1); every other kind
 * throws V8's destructuring TypeError — `msg` verbatim when non-empty (the
 * compile-time source spelling), else the runtime kind wording. Borrows
 * both; NULL with the exception pending on the throw. */
ScrDyn *scr_dyn_iter_pack(const ScrDyn *src, const ScrStr *msg);
/* A rest element's pack (`const [a, ...rest] = d`): scr_dyn_iter_pack's
 * kinds pack as there, and other iterables step through the iterator
 * protocol to the end. +1, or NULL with the error pending. */
ScrDyn *scr_dyn_destructure_rest(const ScrDyn *src, const ScrStr *msg);
/* Destructuring's first `n` values (`const [a, b] = d`) of a dyn source
 * other than an array, string or bytes (the emitted walk packs those),
 * through the iterator protocol: an iterator with values left closes.
 * `spell` is the compile-time not-iterable wording, or NULL. +1, or NULL
 * with the error pending. */
ScrDyn *scr_dyn_iter_take(const ScrDyn *src, size_t n, const char *spell);
/* True for typed capsules that iterate through the protocol (a compiled
 * synchronous generator) rather than through their materialized view. */
bool scr_dyn_iterates_by_protocol(const ScrDyn *value);
/* Map constructor seeds: retain array inputs for live iteration, accept
 * nullish inputs as empty, and validate each entry before reading 0/1. */
ScrDyn *scr_dyn_map_seed_entries(const ScrDyn *src);
ScrDyn *scr_dyn_map_seed_entry(const ScrDyn *entry);
bool scr_weak_map_is(const ScrDyn *value);
bool scr_weak_set_is(const ScrDyn *value);
ScrDyn *scr_weak_map_new(ScrDyn *entries);
ScrDyn *scr_finalization_registry_new(ScrDyn *cleanup);
bool scr_finalization_registry_is(const ScrDyn *value);
ScrDyn *scr_weak_set_new(ScrDyn *values);
ScrDyn *scr_dyn_from_entries(ScrDyn *entries);
ScrDyn *scr_dyn_mark_snapshot(ScrDyn *value); /* consumes and returns +1 */
/* Optional non-owning observers, installed by weak collections (worker
 * executables keep the hook in scr_thread_hot). */
#ifndef SCR_WORKERS
extern SCR_TL void (*scr_weak_dispose_hook)(void *);
#endif
void scr_weak_dispose(void *object);
/* The for-of-over-dyn pack accessors (the emitted index loop drives them
 * over a scr_dyn_iter_pack result, which is ARR by construction).
 * scr_dyn_arr_len answers 0 for non-ARR kinds; scr_dyn_arr_at answers the
 * undefined singleton past the end (both never throw). scr_dyn_arr_at is
 * +1. */
double scr_dyn_arr_len(const ScrDyn *d);
ScrDyn *scr_dyn_arr_at(const ScrDyn *d, double i);
ScrDyn *scr_dyn_arr_named_get(const ScrDyn *d, const ScrStr *key);
/* The member `key` of an array found before Array.prototype: an own named
 * property, or one on its custom prototype chain (Object.setPrototypeOf).
 * NULL when the chain reaches Array.prototype without it. +1. */
ScrDyn *scr_dyn_arr_custom_member(const ScrDyn *d, const char *key, size_t key_len);
void scr_dyn_obj_set(ScrDyn *obj, const char *key, size_t key_len, ScrDyn *value);
void scr_dyn_obj_set_field(ScrDyn *obj, const char *key, size_t key_len, ScrDyn *value);
ScrDyn *scr_dyn_define_property(ScrDyn *target, ScrDyn *key, ScrDyn *descriptor);
void scr_dyn_class_field_attributes(ScrDyn *view, ScrStr *name, double bits);
void scr_dyn_class_view_attributes(ScrDyn *view, double bits);
/* The integrity state of a class instance's checked view as CLASS_* bits,
 * added to `bits`. The commits of hierarchies with an integrity word store
 * it in the word, in programs that freeze, seal or prevent extensions of
 * untyped values. `bag`, the instance's new property bag or NULL, stops
 * being extensible with the view. */
double scr_dyn_class_view_integrity(const ScrDyn *view, double bits, ScrDyn *bag);
ScrDyn *scr_class_define_field(ScrDyn *current, double field_bits, double object_bits, ScrStr *name,
                               ScrDyn *descriptor);
double scr_class_defined_bits(ScrDyn *holder, ScrStr *name);
ScrDyn *scr_class_defined_value(ScrDyn *holder, ScrStr *name);
bool scr_class_descriptor_has_value(ScrDyn *descriptor);
void scr_class_throw_read_only(ScrStr *field, ScrStr *owner);
void scr_class_throw_not_extensible(ScrStr *field);
ScrDyn *scr_dyn_get_own_property_descriptor(ScrDyn *target, ScrDyn *key);
ScrDyn *scr_dyn_array_proto_call(ScrDyn *target, ScrStr *method, ScrDyn *args);
ScrDyn *scr_dyn_array_prototype(void); /* +1, installs native method adapters */
ScrDyn *scr_dyn_array_prototype_base(void); /* +1, shared native array identity */
/* Names the prototype object of a compiled class `name` for util.inspect
 * (Node prints the constructor's name), unless it already has a name. */
void scr_dyn_name_class_prototype(ScrDyn *prototype, const ScrStr *name);
/* Native arrays read their holes as undefined without consulting
 * Array.prototype, so storing an element on Array.prototype raises SC2020.
 * True (with the error pending) when `recv` is Array.prototype. */
bool scr_dyn_array_prototype_element_fence(const ScrDyn *recv);
bool scr_dyn_is_array_prototype(const ScrDyn *d);
/* The checked-dynamic keyed WRITE (`h.k = v` on a dyn receiver): OBJ sets
 * the member (JS: later writes win, insertion order); undefined/null and
 * non-object kinds throw Node's catchable TypeErrors (strict-mode
 * wording). All three operands BORROWED (the value is retained in). */
void scr_dyn_key_set(ScrDyn *recv, ScrStr *key, ScrDyn *value);
/* The same in sloppy-mode code: an assignment strict mode refuses with a
 * TypeError is ignored. */
void scr_dyn_key_set_sloppy(ScrDyn *recv, ScrStr *key, ScrDyn *value);
void scr_dyn_key_set_computed_sloppy(ScrDyn *recv, ScrDyn *key, ScrDyn *value);
/* A named (non-index) property of an extensible, unfrozen ARR, stored as
 * scr_dyn_key_set stores it. Takes ownership of value. */
void scr_dyn_arr_named_put(ScrDyn *arr, const char *key, size_t key_len, ScrDyn *value);
void scr_dyn_key_set_computed(ScrDyn *recv, ScrDyn *key, ScrDyn *value);
void scr_dyn_key_delete(ScrDyn *recv, const ScrStr *key, bool strict);
/* Removes the own property `key` of an ordinary object whatever its
 * attributes, as scr_dyn_obj_set_field replaces values. */
void scr_dyn_obj_delete_field(ScrDyn *obj, const ScrStr *key);
/* The same for the own symbol-keyed property `symbol` of an ordinary
 * object. */
void scr_dyn_obj_delete_symbol_field(ScrDyn *obj, ScrDyn *symbol);
/* This thread's global object box (borrowed). Every spelling of the global
 * object answers it; its symbol-keyed properties are the global object's
 * (scr_node_builtin.c). */
ScrDyn *scr_global_object(void);
/* The program's builtin-global lookup, a dyn function (borrowed); the first
 * installation stands. */
void scr_global_values_install(ScrDyn *lookup);
/* An object whose keys are what `for (key in globalThis)` visits (+1). */
ScrDyn *scr_global_for_in_object(void);
/* Node's navigator global (+1, one box per thread) and its members:
 * navigator.language (+1), navigator.languages (+1, one frozen array per
 * thread) and navigator.platform (+1). */
ScrDyn *scr_navigator_object(void);
ScrStr *scr_navigator_language(void);
ScrDyn *scr_navigator_languages(void);
ScrStr *scr_navigator_platform(void);
ScrDyn *scr_dyn_global_symbol_get(ScrSym *key); /* borrowed key; +1 value */
void scr_dyn_global_symbol_set(ScrSym *key, ScrDyn *value); /* both borrowed */
bool scr_dyn_global_symbol_has(ScrSym *key);
void scr_dyn_global_symbol_delete(ScrSym *key);
/* `key in v` with a runtime key (OBJ own members, ARR length/valid indices,
 * Proxy has traps). Traps and unsupported representations may throw. */
bool scr_dyn_has_key(const ScrDyn *v, const ScrStr *key);
/* The `in` operator: scr_dyn_has_key plus members inherited from builtin
 * prototypes and compiled class prototypes. */
bool scr_dyn_in(const ScrDyn *v, const ScrStr *key);
/* Bare `typeof v` on a dyn value: the dyn kind's JS answer (+1 string;
 * null answers "object"). Never throws. */
ScrStr *scr_dyn_typeof(const ScrDyn *d);
/* Object.prototype.toString.call over the native checked-dynamic tree; +1. */
ScrStr *scr_dyn_object_tag(const ScrDyn *d);
/* Receiver-kind-dispatched toString() (Buffer-flavored bytes decode per
 * enc — utf8 default; strings/numbers/booleans/arrays/objects answer
 * JS-exactly; undefined/null throw the catchable TypeError). Borrows; +1. */
ScrStr *scr_dyn_to_string(const ScrDyn *d, const ScrStr *enc);
/* The method-call spelling `d.toString(enc?)`: identical, except a
 * null-prototype dictionary throws "<what> is not a function" — its
 * prototype chain has no toString (Node's answer). */
ScrStr *scr_dyn_to_string_method(const ScrDyn *d, const ScrStr *enc, const ScrStr *what);
ScrDyn *scr_dyn_object_prototype(void);
ScrDyn *scr_dyn_error_prototype(void);
bool scr_dyn_inherits_error_prototype(const ScrDyn *value);
ScrDyn *scr_dyn_error_capture_stack_trace(ScrDyn *target);
ScrDyn *scr_dyn_error_capture_stack_trace_function(void);
ScrDyn *scr_dyn_function_apply(void);
ScrDyn *scr_dyn_reflect_apply(ScrDyn *target, ScrDyn *receiver, ScrDyn *arguments_list);
ScrDyn *scr_dyn_apply_array_like(const ScrDyn *target, const ScrDyn *receiver, const ScrDyn *arguments, const char *what);
bool scr_dyn_same_value(const ScrDyn *left, const ScrDyn *right);
ScrDyn *scr_dyn_builtin_method(const ScrStr *prototype, const ScrStr *method);
ScrStr *scr_dyn_to_string_argument(const ScrDyn *d, const ScrDyn *argument, const ScrStr *what);
ScrDyn *scr_dyn_value_of(const ScrDyn *d, const ScrStr *what);
ScrStr *scr_dyn_error_string(const ScrDyn *d);
ScrStr *scr_num_to_string_radix(double value, const ScrDyn *radix);
/* JS String() over the dyn kind (units render "null"/"undefined" where
 * scr_dyn_to_string throws) — the web globals' WebIDL ToString. +1. */
ScrStr *scr_dyn_string_coerce(const ScrDyn *d);
/* JS ToString WITH the object protocol (user toString/valueOf members
 * called, their throws propagating) — the WHATWG USVString conversions.
 * Borrows; +1 or NULL with the exception pending. */
ScrStr *scr_dyn_string_coerce_js(const ScrDyn *d);
ScrStr *scr_regex_replace_callback(ScrStr *subject, ScrRegex *regex, ScrDyn *callback, bool all);
bool scr_dyn_number_coerce_js(const ScrDyn *d, double *out);
/* Direct-return ABI wrapper for compiler libCalls: JS ToNumber, or NaN
 * with the exception pending when an object hook throws/refuses. */
double scr_dyn_number_coerce(const ScrDyn *d);
double scr_dyn_number_constructor(const ScrDyn *d);
ScrBigInt *scr_dyn_bigint_constructor(const ScrDyn *d);
ScrBigInt *scr_dyn_bigint_coerce(const ScrDyn *d);
ScrDyn *scr_dyn_add(const ScrDyn *left, const ScrDyn *right); /* borrowed; +1 or NULL/pending */
ScrDyn *scr_dyn_arithmetic(const ScrDyn *left, const ScrDyn *right, const ScrStr *operation);
bool scr_dyn_compare(const ScrDyn *left, const ScrDyn *right, const ScrStr *operation);
ScrDyn *scr_dyn_bitwise(const ScrDyn *left, const ScrDyn *right, const ScrStr *operation);

/* `d instanceof TypeError` (and the other builtin error classes) on a
 * checked-dynamic value: the from_error cache resolves the dyn encoding
 * back to its runtime error and the class's stamped preorder interval
 * answers. A dyn value that never came from an error answers false. */
bool scr_dyn_err_instanceof(const ScrDyn *d, double kind);
/* Property read on a checked-dynamic object. Own fields take precedence;
 * runtime Error instances inherit their exact builtin constructor token.
 * The result is owned. */
ScrDyn *scr_dyn_obj_read(const ScrDyn *d, const char *key, size_t key_len);
/* A compiler-emitted read site with a constant key keeps one of these in
 * zero-initialized thread-local storage: the entry position where the key
 * was last found as an own data property and a reference to the interned
 * key bytes stored there. Objects that share a key spelling share its bytes
 * (scr_dyn_key_copy), so one pointer compare at the remembered position
 * proves the property without hashing or comparing bytes. The held
 * reference keeps the bytes, and therefore the pointer's meaning, alive. */
typedef struct ScrDynReadIc {
  char *key;
  size_t key_len;
  size_t index;
  struct ScrDynReadIc *next; /* this thread's filled sites, for cleanup */
} ScrDynReadIc;
/* scr_dyn_obj_read for a SCR_DYN_OBJ receiver `d` (callers check the kind)
 * and the site's constant key; same result and ownership. */
ScrDyn *scr_dyn_obj_read_ic(const ScrDyn *d, const ScrStr *key, ScrDynReadIc *ic);
/* JS typeof comparison, including null's "object" result. */
bool scr_dyn_is_object(const ScrDyn *d);
void scr_dyn_throw(ScrDyn *d); /* moves; preserves boxed native Error classification */

/* structuredClone over the checked-dynamic tree: JSON-safe data + bytes deep-copy;
 * functions/handles throw the spec's catchable DataCloneError; cycles
 * throw the scriptc fence (the checked-dynamic tree cannot represent them). Option
 * validation (shared with scr_domex_clone) throws Node's exact
 * TypeErrors; any non-empty transfer list throws DataCloneError. The
 * _missing form is the zero-argument call: always throws Node's
 * ERR_MISSING_ARGS. Args borrowed (options NULL-tolerant); results +1. */
ScrDyn *scr_structured_clone(const ScrDyn *value, const ScrDyn *options);
ScrDyn *scr_structured_clone_missing(void);
ScrDyn *scr_structured_clone_transfer_fail(void); /* always throws DataCloneError */
/* The same, naming a Buffer pool slab's ArrayBuffer as Node does when it is
 * the transfer list's first member (borrowed). */
ScrDyn *scr_structured_clone_transfer_fail_with(const ScrDyn *first);
/* Validates a structuredClone options dyn value (throws on failure —
 * callers must check scr_exc_pending). Borrowed, NULL-tolerant. */
void scr_sc_validate_options(const ScrDyn *options);
/* markAsUncloneable(value) and the check structuredClone and postMessage
 * make (scr_json.c); both borrow the value. scr_uncloneable_count is the
 * number of marked values, so the clone paths test it inline and call
 * scr_uncloneable_marked only once something is marked. */
void scr_mark_uncloneable(ScrDyn *value);
bool scr_uncloneable_marked(const ScrDyn *value);
extern SCR_TL size_t scr_uncloneable_count;
/* An %Error as the boundary's dyn shape ({name, message[, code]}).
 * Borrows; +1. */
ScrDyn *scr_dyn_from_error(const ScrError *e);
void scr_error_register_dyn(const ScrVt *vt, ScrDyn *(*box)(void *));
ScrDyn *scr_error_dyn_fields(const ScrError *e);
void scr_error_dyn_place_name(ScrDyn *view, const char *after, size_t after_len);
/* An Error subclass view of an instance whose class keeps a property bag:
 * `name` and `message` take their committed positions, and data values
 * from the slots (scr_json.c). `name_placed`: the class's construction sets
 * `name`, and the view already has it in place. */
void scr_error_dyn_follow_bag(ScrDyn *view, const ScrDyn *bag, const ScrError *e, bool name_placed);
/* An accessor property of a fresh object: enumerable and configurable,
 * with the given getter and setter (either may be NULL). Moves both. */
void scr_dyn_obj_set_accessor(ScrDyn *obj, const char *key, size_t key_len, ScrDyn *getter, ScrDyn *setter);
/* The getter or setter of an own accessor property, +1 (undefined when none). */
ScrDyn *scr_dyn_obj_accessor_fn(const ScrDyn *obj, const char *key, size_t key_len, bool setter);
void scr_error_commit_dyn(ScrError *e, const ScrDyn *view);
/* The reverse extraction, riding the same identity cache: a dyn error
 * that came from a runtime ScrError answers THAT instance (+1;
 * out-and-back crossings compare reference-equal); alien %error objects
 * rebuild once and enter the cache. Borrows d. */
ScrError *scr_error_from_dyn(const ScrDyn *d); /* scr_async_dyn.c (gated) */
/* The cache's runtime-internal access pair (scr_json.c owns the storage;
 * the gated extraction reads/writes through these). */
ScrError *scr_errdyn_err_of(const ScrDyn *d); /* +1 or NULL */
void scr_errdyn_put(ScrError *e, ScrDyn *d);  /* retains both sides */
/* Sets an own property on an error: its checked-dynamic node, which casts
 * and util.inspect read. Moves value. */
void scr_error_set_prop(ScrError *e, const char *key, size_t key_len, ScrDyn *value);
ScrDyn *scr_errdyn_view_of(const ScrError *e); /* borrowed or NULL */
/* ToBoolean over the dyn kind (JS-exact); borrowed, never throws. */
bool scr_dyn_truthy(const ScrDyn *d);
/* Math.max/Math.min(...src) over an untyped iterable; `what` names the
 * source in V8's null/undefined spread TypeError. NaN with it pending. */
double scr_dyn_math_fold(const ScrDyn *src, bool max, const ScrStr *what);
int scr_dyn_has_instance_hook(const ScrDyn *value, const ScrDyn *callee);
/* JS String() over a dyn value (arrays join, [object Object], the error
 * encoding renders "name: message"); borrowed, result +1, never throws. */
ScrStr *scr_dyn_display(const ScrDyn *d);
/* JS === over two dyn values: scalars by value, units by kind, everything
 * reference-shaped by node identity. Borrowed; never throws. */
bool scr_dyn_strict_eq(const ScrDyn *a, const ScrDyn *b);
/* Prototype-method dispatch on a dyn receiver (`recv.m(...)` where `m` is
 * a name a dyn-representable prototype declares — push/slice/forEach/
 * apply/...): implemented (kind, name) pairs run JS-exact semantics; a
 * real-but-unimplemented method throws a "not supported yet" Error;
 * a name the kind's prototype lacks throws Node's "<what> is not a
 * function"; OBJ receivers call the own member. recv/args borrowed,
 * result owned (+1). MAY THROW (NULL with the exception pending). */
ScrDyn *scr_dyn_prepare_method(ScrDyn *recv, const char *method);
ScrDyn *scr_dyn_invoke_prepared(ScrDyn *recv, ScrDyn *callee, const char *method, ScrDyn *const *args, size_t argc, const char *what);
/* scr_dyn_invoke_prepared for a call site whose method name is a constant:
 * *mid_slot, the site's -1-initialized slot, caches the name's method id
 * after the first call, so later calls skip the name lookup. */
ScrDyn *scr_dyn_invoke_prepared_id(ScrDyn *recv, ScrDyn *callee, const char *method, int32_t *mid_slot, ScrDyn *const *args, size_t argc, const char *what);
/* scr_dyn_invoke_prepared_id for a call whose result is discarded: a plain
 * array's push appends without boxing its new length. */
void scr_dyn_invoke_discard_id(ScrDyn *recv, ScrDyn *callee, const char *method, int32_t *mid_slot, ScrDyn *const *args, size_t argc, const char *what);
/* scr_dyn_invoke_prepared_id for Buffer.prototype method names
 * (scr_bytes_dyn.c), one entry per method family: a Buffer receiver runs
 * the method, any other takes the ordinary dispatch. */
ScrDyn *scr_dyn_invoke_buffer_num(ScrDyn *recv, ScrDyn *callee, const char *method, int32_t *mid_slot, ScrDyn *const *args, size_t argc, const char *what);
ScrDyn *scr_dyn_invoke_buffer_write(ScrDyn *recv, ScrDyn *callee, const char *method, int32_t *mid_slot, ScrDyn *const *args, size_t argc, const char *what);
ScrDyn *scr_dyn_invoke_buffer_fill(ScrDyn *recv, ScrDyn *callee, const char *method, int32_t *mid_slot, ScrDyn *const *args, size_t argc, const char *what);
ScrDyn *scr_dyn_invoke_buffer_to_string(ScrDyn *recv, ScrDyn *callee, const char *method, int32_t *mid_slot, ScrDyn *const *args, size_t argc, const char *what);
ScrDyn *scr_dyn_invoke_buffer_search(ScrDyn *recv, ScrDyn *callee, const char *method, int32_t *mid_slot, ScrDyn *const *args, size_t argc, const char *what);
ScrDyn *scr_dyn_invoke_buffer(ScrDyn *recv, ScrDyn *callee, const char *method, int32_t *mid_slot, ScrDyn *const *args, size_t argc, const char *what);
ScrDyn *scr_dyn_invoke(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc, const char *what);
/* A %TypedArray%.prototype method called on a checked typed array (not a
 * DataView): its answer (+1, or NULL with the exception pending), with
 * *handled false for a name it does not implement. */
ScrDyn *scr_dyn_bytes_method(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc, bool *handled);
/* A plain object's Symbol.iterator method (+1), read once; NULL when it
 * has none, or with the exception pending from its getter. */
ScrDyn *scr_dyn_iterator_method(const ScrDyn *value);
/* The values the iterator `method` gives for `source` (+1), or NULL with
 * the exception pending. */
ScrDyn *scr_dyn_iterate_with(const ScrDyn *source, ScrDyn *method);
/* Keyed read on a FUNC node: the own-property table first (defineProperties
 * writes land there), then "name" (the box's best-effort static name; ""
 * for anonymous) and "length" (the boxed arity). Returns +1, or NULL when
 * the key answers nothing (the caller's undefined). Never throws. */
ScrDyn *scr_dyn_fn_get(const ScrDyn *d, const char *key, size_t key_len);
/* A function value's own property table, created on first use. +1. */
ScrDyn *scr_dyn_function_properties(const ScrDyn *function);
/* The table a function value already has. +1, or NULL. */
ScrDyn *scr_dyn_function_properties_existing(const ScrDyn *function);
/* Object.defineProperties over dyn values (targets: OBJ and FUNC): each
 * descriptor's `value` becomes an own data property. OBJ targets preserve
 * writable/enumerable/configurable; FUNC targets still use plain properties.
 * get/set throw the "not supported yet" Error.
 * Returns the target (+1, JS's return), or NULL with a pending catchable
 * TypeError (non-object target/descriptor — Node's messages). */
ScrDyn *scr_dyn_define_props(ScrDyn *target, ScrDyn *descs);
ScrDyn *scr_dyn_define_prototype_props(ScrDyn *target, ScrDyn *descs, ScrDyn *protected_keys);
/* Boxes a closure as a callable dyn value. Ownership of `clo` MOVES in
 * (callers retain first when they keep their own reference); `sig`/`name`
 * must be static literals (the box never frees them; name may be NULL). */
ScrDyn *scr_dyn_new_func(ScrClosure *clo, ScrDynThunk thunk, uint32_t arity, const char *sig, const char *name);
/* Gives a function box made with thunk its typed message entry (an
 * EventEmitter listener registered from it keeps the entry). */
void scr_dyn_func_set_message(ScrDyn *fn, ScrDynThunk thunk, ScrDynMessageListener listener);
/* Sets a freshly boxed function's `length` (a builtin function value whose
 * length is not its adapter's parameter count). */
void scr_dyn_function_set_length(ScrDyn *fn, uint32_t length);
ScrDyn *scr_dyn_new_class(ScrClassObj *cls, const char *type_key);
/* EventEmitter and the stream constructors as untyped constructor values,
 * and instanceof over untyped constructor functions
 * (scr_dyn_builtin_class.c, linked with the dynBuiltinClass feature). */
ScrDyn *scr_dyn_builtin_class(double kind);
bool scr_dyn_builtin_instanceof(ScrDyn *value, double kind);
bool scr_dyn_function_instanceof(ScrDyn *value, ScrDyn *callee);
/* The stream half of those constructors (scr_dyn_builtin_stream.c, linked
 * with the dynBuiltinStream feature), registered with
 * scr_dyn_builtin_class_streams before the first stream class value is
 * read: construct runs `Readable.call(this, opts)` and the other stream
 * kinds (+1 or NULL with an exception pending), prototype installs a stream
 * kind's methods, and event answers EventEmitter.prototype's methods for a
 * receiver with stream state (true when it handled the call; *result +1 or
 * NULL with an exception pending). */
enum {
  SCR_EE_M_ON, SCR_EE_M_PREPEND, SCR_EE_M_ONCE, SCR_EE_M_PREPEND_ONCE, SCR_EE_M_OFF,
  SCR_EE_M_REMOVE_ALL, SCR_EE_M_EMIT, SCR_EE_M_LISTENERS, SCR_EE_M_RAW_LISTENERS,
  SCR_EE_M_LISTENER_COUNT, SCR_EE_M_EVENT_NAMES, SCR_EE_M_SET_MAX, SCR_EE_M_GET_MAX,
};
typedef struct ScrDynStreamOps {
  ScrDyn *(*construct)(int kind, ScrDyn *self, ScrDyn *const *args, size_t argc);
  void (*prototype)(int kind, ScrDyn *prototype);
  bool (*event)(int method, ScrDyn *self, ScrDyn *const *args, size_t argc, ScrDyn **result);
} ScrDynStreamOps;
void scr_dyn_builtin_class_streams(const ScrDynStreamOps *ops);
/* A stream class value with its stream half (scr_dyn_builtin_stream.c),
 * +1; the stream a JavaScript value stands for (a constructor-function
 * stream or a boxed runtime stream), +1 or NULL; and the constructor-
 * function object of a runtime stream, +1 or NULL. */
ScrDyn *scr_dyn_builtin_stream_class(double kind);
struct ScrStream *scr_dyn_builtin_stream_of(const ScrDyn *value);
ScrDyn *scr_dyn_builtin_stream_object(struct ScrStream *s);
/* The untyped view of a runtime stream in programs that link that unit
 * (+1), a checked cast to a runtime stream class kind (+1 or NULL), and
 * the stream.unboxDyn libCall in those programs (scr_stream_unbox_dyn's
 * contract, also taking constructor-function streams). */
ScrDyn *scr_dyn_builtin_stream_view(struct ScrStream *s);
struct ScrStream *scr_dyn_builtin_stream_check(const ScrDyn *value, double kind);
struct ScrStream *scr_dyn_builtin_stream_unbox(const ScrDyn *value, const ScrStr *message);
/* stream.unboxDynStage in those programs (scr_stream_unbox_dyn_stage's
 * contract, also taking constructor-function streams). */
struct ScrStream *scr_dyn_builtin_stream_unbox_stage(const ScrDyn *value, const ScrStr *message);
/* stream.dynNative in those programs: scr_stream_dyn_native's contract,
 * also taking constructor-function streams that keep the runtime's write
 * and end (+1 or NULL). */
struct ScrStream *scr_dyn_builtin_stream_dyn_native(const ScrDyn *value, double side);
bool scr_dyn_class_is_key(const ScrDyn *value, const ScrStr *type_key);
bool scr_dyn_class_is(const ScrDyn *value, const char *type_key);
/* Calls a dyn value: a non-function kind throws the catchable TypeError
 * "<what> is not a function" (Node's wording — `what` is the call site's
 * callee spelling) and returns NULL; a function kind delegates to the
 * boxed thunk (per-arg checks live there). `args` entries are BORROWED;
 * the result is owned (+1), or NULL with the exception pending. */
ScrDyn *scr_dyn_call(const ScrDyn *d, ScrDyn *const *args, size_t argc, const char *what);
/* scr_dyn_call over a dyn ARRAY's elements (the spread-application form —
 * `f(...args)` after the emitted argument array is built): argv IS the
 * array's items. Borrows both; result owned (+1), or NULL pending. */
ScrDyn *scr_dyn_apply(const ScrDyn *d, const ScrDyn *args, const char *what);
/* Function.bind borrows its target and arguments, returns a fresh callable. */
ScrDyn *scr_dyn_bind(ScrDyn *target, ScrDyn *const *args, size_t argc);

/* Path spine for dynCheck error messages — a compile-time-shaped linked
 * list the emitted builders stack-allocate per recursion level: `key`
 * non-NULL for an object member segment, else `index` is an array index.
 * Rendered root-first as "$", "$.items[2].price", ... */
typedef struct ScrDynPath {
  const struct ScrDynPath *parent;
  const char *key;
  size_t index;
} ScrDynPath;
ScrSearchParams *scr_dyn_native_search_params_check(const ScrDyn *value, const ScrDynPath *path);
ScrSearchParams *scr_sp_new_checked(const ScrDyn *value);
ScrMap *scr_dyn_native_set_check(const ScrDyn *value, const ScrDynPath *path);
ScrMap *scr_dyn_native_map_check(const ScrDyn *value, const ScrDynPath *path);
bool scr_dyn_native_collection_is(const ScrDyn *value, int map, const char *type);
ScrMap *scr_dyn_native_collection_check(const ScrDyn *value, int map, const char *type, const ScrDynPath *path);
ScrStr *scr_url_checked_to_path(const ScrDyn *value);
ScrStr *scr_url_checked_to_path_options(const ScrDyn *value, const ScrDyn *options);
ScrBytes *scr_url_checked_to_path_buffer(const ScrDyn *value, const ScrDyn *options);
ScrUrl *scr_url_checked_from_path(const ScrDyn *value, const ScrDyn *options);
ScrUrl *scr_dyn_native_url_check(const ScrDyn *value, const ScrDynPath *path);
ScrRegex *scr_dyn_native_regex_check(const ScrDyn *value, const ScrDynPath *path);
ScrClassObj *scr_dyn_class_check(const ScrDyn *value, const char *type_key, const ScrDynPath *path);

/* The dynCheck failure path: builds "TypeError: expected <want> at <path>,
 * got <kind>" (got == NULL renders as "undefined" — a missing object
 * member) and THROWS it through the exception cell (catchable; uncaught it
 * prints as "Uncaught TypeError: ..." and exits 1). This is
 * scriptc-specific behavior — JS `as` never checks (SEMANTICS.md). */
void scr_dyn_check_fail(const ScrDynPath *path, const char *want, const ScrDyn *got);
/* The Date object a checked-dynamic Date handle holds, +1, or NULL with
 * the check failure pending. */
ScrDate *scr_dyn_native_date_check(const ScrDyn *value, const ScrDynPath *path);
/* Names the analysis-proven fact the next checked conversion checks
 * (shape inference's overlay), or NULL: its failure then reports a compiler
 * analysis bug ("<package> <file>:<line>"). */
void scr_dyn_inferred_site(const char *site);

/* Matchers and builders of recursive shapes (records and arrays whose type
 * reaches itself) track the dyn values they visit, so cyclic values match
 * and convert without unbounded recursion. Every matcher and builder of a
 * type holding a recursive shape runs its generated body through
 * scr_dyn_match_visit or scr_dyn_build_visit; the outermost call forms one
 * visit session. Only values with more than one reference are tracked: a
 * value reached twice has at least two. A member read through
 * scr_dyn_obj_read_held marks the reference it returns until
 * scr_dyn_release_held, and that reference is not counted.
 *   scr_dyn_match_visit: true without running `body` when `matcher`
 *     (non-NULL) is already checking `d` further up the stack (the outer
 *     check decides); otherwise body(d).
 *   scr_dyn_build_visit: the value `builder` (non-NULL) already built for
 *     `d` in the session, retained, so a cycle in the input is a cycle in
 *     the output and shared values stay shared; otherwise body(d, path).
 *     The body calls scr_dyn_build_add with the value it allocated for d
 *     before building its members. When the body fails (an exception is
 *     pending), the values it recorded are dropped.
 *   scr_dyn_build_note records a value for (d, builder) whatever d's
 *     reference count (a capsule's cached record, which keeps its identity
 *     when refreshed); scr_dyn_build_rekey replaces a recorded value.
 *   scr_dyn_visit_view: scr_dyn_typed_ref_materialize for a capsule, except
 *     that a capsule materialized earlier in the session answers the same
 *     view without refreshing it (+1). */
ScrDyn *scr_dyn_obj_read_held(const ScrDyn *d, const char *key, size_t key_len);
void scr_dyn_release_held(ScrDyn *d);
bool scr_dyn_match_visit(const ScrDyn *d, const void *matcher, bool (*body)(const ScrDyn *));
void *scr_dyn_build_visit(const ScrDyn *d, const ScrDynPath *path, const void *builder,
                          void *(*body)(const ScrDyn *, const ScrDynPath *),
                          void *(*retain)(void *));
void scr_dyn_build_add(const ScrDyn *d, const void *builder, void *value);
void scr_dyn_build_note(const ScrDyn *d, const void *builder, void *value);
void scr_dyn_build_rekey(const ScrDyn *d, const void *builder, void *value);
ScrDyn *scr_dyn_visit_view(const ScrDyn *capsule);

/* A union's builder converts the arm whose literal discriminator and
 * complete structure matched; every value inside that arm then matched its
 * own type too. Between scr_dyn_trust_enter and scr_dyn_trust_exit (which
 * restores the value enter returned), scr_dyn_trusted_build answers true,
 * and the builder of a nested union whose arms' literals are disjoint picks
 * a plain object's arm by its literal alone instead of matching the arm's
 * structure again (dyn.ts unionArmMatch). Code a getter or proxy trap runs
 * sees false, and so does the rest of the conversion once such code has
 * run: it can return a value the match never saw. */
bool scr_dyn_trust_enter(void);
void scr_dyn_trust_exit(bool previous);
bool scr_dyn_trusted_build(void);

/* ── native handles in the checked-dynamic tree (SCR_DYN_HANDLE) ────────────────────────
 * Per-tag dispatch ops, registered by the handle's owning unit
 * (scr_http_dyn_install / scr_net_dyn_install — emitted main() calls
 * them exactly when the unit is linked, the scr_net_install story), so
 * this always-linked core never references gated units. */
/* A method a handle class answers through invoke, read as a value
 * (`typeof req.json`, `raw[key]()`): the read answers one function per
 * (tag, method) that calls invoke on its `this`. length is the method's
 * Function.prototype.length; rejects marks a method whose call on another
 * receiver answers a rejected promise instead of throwing (the async
 * WebIDL operations: Body's json(), ReadableStream's cancel()). */
typedef struct ScrDynHandleMethod {
  const char *name;
  uint32_t length;
  bool rejects;
  const char *invalid_this; /* NULL = the class's (ScrDynHandleOps) */
} ScrDynHandleMethod;

typedef struct ScrDynHandleOps {
  const char *cls; /* Node's constructor name — error texts and dynCheck's "got ..." */
  void *(*retain)(void *h);
  void (*release)(void *h);
  /* Member CALL on a dyn handle (`res.end(...)`): dispatch (tag, method)
   * onto the static lowering's entry point with per-arg checks per the
   * static signature. `self` is the receiving box (`return this` methods
   * answer it +1). Result owned (+1) or NULL with the exception pending.
   * Real-but-unimplemented members throw the "not supported yet"
   * Error; names the class's surface never had throw Node's
   * "<what> is not a function". */
  ScrDyn *(*invoke)(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc, const char *what);
  /* Property READ with a static equivalent (req.url, res.statusCode):
   * +1 boxed value; NULL = no such modeled property (the caller answers
   * the undefined singleton — the checked-dynamic tree's own-property stance); may throw
   * the "not supported yet" Error for real-but-unmodeled names (NULL +
   * pending). */
  ScrDyn *(*get)(void *h, const char *key, size_t key_len);
  /* Property WRITE with a static equivalent (res.statusCode = 200):
   * true = handled (value borrowed); false = not a modeled property (the
   * caller throws the "not supported yet" Error — Node would take an
   * expando, but a per-box expando would break handle identity). May throw its
   * own catchable error (returns true with the exception pending). */
  bool (*set)(void *h, const char *key, size_t key_len, const ScrDyn *value);
  /* Cross-unit pipe DESTINATION hook (`socket.pipe(res)` — the source's
   * unit cannot name the destination's entry points without breaking
   * link gating): the destination accepts a source handle box, or
   * answers false for a pairing it does not model (the caller throws the
   * "not supported yet" Error). NULL when the tag accepts no pipes. */
  bool (*pipe_from)(void *dst, const ScrDyn *src);
  /* Immutable native iterables may drain into a fresh array. Mutable or
   * effectful iterators need a separate step/close protocol. NULL = not iterable. */
  ScrDyn *(*iter_pack)(void *h);
  /* A live native iterator step; index advances only when a value is emitted. */
  ScrDyn *(*iter_step)(void *h, double *index, unsigned selection);
  /* util.inspect renders `<cls> <view>` for the dyn object this answers
   * (+1); NULL = the class has no inspection, and util.inspect throws the
   * "not supported yet" Error. */
  ScrDyn *(*inspect_view)(void *h);
  /* structuredClone of the handle (+1 new box); NULL = DataCloneError. */
  ScrDyn *(*clone)(void *h);
  /* JSON.stringify writes `{}` (the class keeps its state in internal
   * slots behind prototype getters) instead of the unsupported fence. */
  bool json_empty_object;
  /* Past the depth limit util.inspect prints `[cls]` (the class's
   * inspector returns `this`) instead of the bare class name. */
  bool inspect_bracketed_past_depth;
  /* The class's inspector formats its view with a new util.inspect call
   * (URL's does): the view renders from the top level with the caller's
   * depth, and its lines take the caller's indentation. Past the depth
   * limit the inspector returns the instance, which has no own
   * properties, so util.inspect prints `cls {}`. */
  bool inspect_view_nested;
  /* The @@toStringTag when it differs from cls: String() answers
   * "[object <tag>]" and util.inspect prints `<cls> [<tag>] <view>`, or
   * `<tag> <view>` when the tag ends with "." and cls, as Node does. */
  const char *to_string_tag;
  /* The view has no properties, so util.inspect prints it in full at any
   * depth, as Node prints `{}`. */
  bool inspect_view_empty;
  /* A symbol-keyed READ (`stack[Symbol.dispose]`, the `using` method
   * lookup): +1 value, or NULL when the class has no member for `key`
   * (the read answers undefined). NULL hook = no symbol-keyed members. */
  ScrDyn *(*symbol_get)(void *h, const ScrDyn *key);
  /* Cross-thread structured clone (postMessage, workerData); NULL =
   * DataCloneError. See ScrDynHandleTransfer. */
  const struct ScrDynHandleTransfer *transfer;
  /* A handle that is also a Node Transform (Cipheriv, Decipheriv): the
   * stream unit builds the handle's Transform from these operations on its
   * first stream use. NULL = the class is not a stream. */
  const struct ScrDynHandleTransform *transform;
  /* The class's methods as values, terminated by a NULL name; NULL = a
   * property read answers no methods (member calls still reach invoke).
   * See ScrDynHandleMethod. */
  const ScrDynHandleMethod *methods;
  /* The TypeError (code ERR_INVALID_THIS) a method value called on another
   * receiver raises; NULL = WebIDL's "Illegal invocation". */
  const char *invalid_this;
  /* A promise rejected with the pending exception (+1), for the rejects
   * methods; the owning unit supplies it, since promises are a gated unit. */
  ScrDyn *(*rejected)(void);
} ScrDynHandleOps;

/* The operations a Transform handle gives the stream unit (scr_stream.c):
 * the slot where the handle keeps its stream (+1) with the stream's
 * release, update() and final() over bytes (+1 Buffer, or NULL with the
 * exception pending), and the handle's collector trace, since the
 * stream's steps hold the handle. */
typedef struct ScrDynHandleTransform {
  void *(*stream)(void *h);
  void (*set_stream)(void *h, void *stream, void (*release)(void *));
  struct ScrBytes *(*update)(void *h, struct ScrBytes *chunk);
  struct ScrBytes *(*final)(void *h);
  ScrTraceFn trace;
} ScrDynHandleTransform;

/* Checked-dynamic member calls and property reads on a Transform handle,
 * installed by the stream unit (scr_stream_install); NULL in a program
 * without it. call answers true with *result set (+1, or NULL with the
 * exception pending) for the members a native stream answers, and get
 * answers a stream property (+1), or NULL for other keys. */
typedef struct ScrHandleStreamHooks {
  bool (*call)(const ScrDynHandleOps *ops, void *h, ScrDyn *self, const char *method,
               ScrDyn *const *args, size_t argc, ScrDyn **result);
  ScrDyn *(*get)(const ScrDynHandleOps *ops, void *h, const char *key, size_t key_len);
} ScrHandleStreamHooks;
extern SCR_TL const ScrHandleStreamHooks *scr_handle_stream_hooks;

/* How a handle crosses threads, supplied by the handle's owning unit so the
 * message encoder (scr_message.c) needs no reference to gated units and no
 * per-tag registry. share runs on the sending thread: it answers a payload
 * that any thread may use, +1, or NULL when this handle cannot be cloned
 * (with an exception pending, or DataCloneError is thrown). adopt runs on
 * the receiving thread and answers a fresh box over the payload (+1; the
 * message keeps its payload reference). drop releases the payload when the
 * message is freed, whether or not it was delivered. All three must be
 * callable from any thread. */
typedef struct ScrDynHandleTransfer {
  void *(*share)(void *h);
  ScrDyn *(*adopt)(void *payload);
  void (*drop)(void *payload);
} ScrDynHandleTransfer;
ScrDyn *scr_dyn_native_handle_iterator(ScrDyn *source, unsigned selection);

/* ── promises in the checked-dynamic tree (SCR_DYN_PROMISE) ────────────────────────────
 * Boxes by REFERENCE (+1 box; retains p). The boundary contract: p
 * settles with a dyn payload — promise<dyn> boxes directly; other inner
 * types go through scr_dyn_new_promise_adapting, which parks an emitted
 * payload-converting adapter (the Promise.race cb-waiter machinery) on
 * `src` and boxes the fresh destination promise instead. Rejections copy
 * raw through the same machinery (reasons are dynamically tagged) and
 * count as HANDLED on src — the boxed destination is the tracked one,
 * like a JS .then chain. */
ScrDyn *scr_dyn_new_promise(ScrPromise *p); /* scr_async_dyn.c (gated) */
/* The allocator view the gated boxes use; installs the release arm's
 * promise-release edge (runtime-internal). */
ScrDyn *scr_dyn_alloc_promise(void (*release_fn)(ScrPromise *p));
extern SCR_TL void (*scr_dyn_promise_release_fn)(ScrPromise *p);
ScrDyn *scr_dyn_new_promise_adapting(ScrPromise *src,
                                     void (*adapt)(ScrPromise *dst, ScrPromise *src));
/* BORROWED peek at the boxed promise; NULL when d is not a promise box. */
ScrPromise *scr_dyn_promise_of(const ScrDyn *d);
/* A property read of a promise box (+1): Promise.prototype.then, catch
 * and finally as function values, and undefined for every other key
 * (promises have no own properties). The method values come from the
 * gated async unit, which installs scr_dyn_promise_member_fn when it boxes
 * a promise. */
ScrDyn *scr_dyn_promise_key_get(const ScrDyn *d, const ScrStr *k);
extern SCR_TL ScrDyn *(*scr_dyn_promise_member_fn)(const char *key, size_t len);
/* Promise.all / allSettled / any over a spread dyn array (borrowed);
 * `reader` (borrowed) reads a program class instance's `then`. +1. */
ScrPromise *scr_dyn_promise_all(const ScrDyn *entries, const ScrDyn *reader);
ScrPromise *scr_dyn_promise_all_settled(const ScrDyn *entries, const ScrDyn *reader);
ScrPromise *scr_dyn_promise_any(const ScrDyn *entries, const ScrDyn *reader);
/* PromiseResolve over one dyn value (borrowed): a native promise is
 * itself, a thenable adopts through its resolve job, a throwing `then`
 * read rejects, and any other value fulfills. +1. */
ScrPromise *scr_dyn_promise_resolve(const ScrDyn *value, const ScrDyn *reader);

/* Native predicates for typed reference capsules and boxed errors. */
bool scr_dyn_ref_typeof_is(const ScrDyn *d, const char *name);
bool scr_dyn_ref_is_array(const ScrDyn *d);
bool scr_dyn_ref_is_error(const ScrDyn *d);
bool scr_dyn_is_nullish(const ScrDyn *d);

/* ── the ambient receiver (JS `this` inside listener/callback bodies) ──
 * Node calls a handle's listeners with `this` bound to the emitting
 * handle (server.listen(0, function() { this.address().port })), and a
 * dyn OBJ method call binds the object. Compiled closures carry no
 * receiver parameter; instead the CALLING site binds the receiver for
 * the call's synchronous extent (push/pop nest strictly — the runtime is
 * single-threaded and fires listeners synchronously) and a plain-function
 * `this` read (JS entries only — TypeScript keeps the noImplicitThis
 * fence) answers the innermost binding: the emitted libCall dyn.this.
 * With no binding the read answers the strict-mode undefined singleton,
 * exactly the old stance. The receiver survives into nested plain CALLS
 * made during the window (where Node would re-bind undefined) and does
 * NOT survive a resumed async body — both are documented divergences;
 * the payoff is that test/common's mustCall wrapper (`return
 * fn.apply(this, arguments)`) forwards the receiver without extra code. */
void scr_dyn_this_push(void *h, ScrDynHandleTag tag); /* h BORROWED (the firing site holds it); NULL binds undefined */
void scr_dyn_this_push_dyn(const ScrDyn *v);          /* retained for the window */
/* A class's typed-ref construction recipe, emitted once per class as a
 * constant (kind: 0 plain, 1 observed, 2 traced capsule). `view` names the
 * live view bound to the new capsule, as eager boxing binds it: 0 none,
 * 1 array ops, 2 record ops, 3 class ops (`ops`). */
typedef struct {
  void *(*retain)(void *);
  void (*release)(void *);
  const char *type_key;
  size_t type_key_len;
  ScrDyn *(*materialize)(void *);
  void (*commit)(void *, const ScrDyn *);
  int kind;
  int view;
  const void *ops;
} ScrDynTypedRefRecipe;
/* A class instance as the window's receiver, boxed with its recipe only when
 * read. ptr is BORROWED: the caller holds the instance across the window. */
void scr_dyn_this_push_typed(void *ptr, const ScrDynTypedRefRecipe *recipe);
void scr_dyn_this_pop(void);
/* The innermost binding as a dyn value (+1): a boxed handle, the pushed
 * dyn value, or the undefined singleton (empty stack, NULL handle, or a
 * handle whose tag has no installed ops — a unit that fires without its
 * dyn half never binds). */
ScrDyn *scr_dyn_this_get(void);
ScrDyn *scr_gen_receiver(void);

/* The data-chunk encoding window (setEncoding — scr_json.c's note): the
 * firing site opens/closes it around a 'data' pass; scr_dyn_new_chunk
 * answers a Buffer-flavored bytes box, or a string inside the window. */
void scr_dyn_chunk_enc(bool utf8);
ScrDyn *scr_dyn_new_chunk(const ScrBytes *b);

/* The JSON text of a dyn value: the JSON.stringify text (+1),
 * "undefined" when the root drops (undefined/function), or NULL with a
 * pending exception (a runtime handle inside the tree throws the "not
 * supported yet" Error). */
ScrStr *scr_dyn_format_j(const ScrDyn *d);
/* util.format's %j (Node's tryStringify), +1: over a dyn value, the
 * JSON.stringify(d) text, or "undefined" when it returns undefined; over
 * the text of a typed serializer that may have thrown, the text itself.
 * A circular-structure TypeError becomes "[Circular]"; any other
 * exception stays pending and the result is NULL. */
ScrStr *scr_util_format_j(const ScrDyn *d);
ScrStr *scr_util_format_j_text(ScrStr *text); /* borrows text */
/* Node's ERR_INVALID_ARG_TYPE listener gate over a dyn value — shared by
 * the emitter unit's checked-dynamic registrations and the handle
 * dispatchers' .on(...) paths (both render errors.js's
 * determineSpecificType shapes). Throws when cb is not a function kind. */
void scr_dyn_check_listener(const ScrDyn *cb, const char *argname);
/* errors.js's determineSpecificType tail ("type number (5)", "an
 * instance of Object") rendered into buf when payload-carrying; the
 * generic ERR_INVALID_ARG_TYPE thrower over it (`expected` is the whole
 * "of type ..." clause). The handle dispatchers' per-arg gates. */
const char *scr_dyn_specific_type(const ScrDyn *v, char *buf, size_t cap);
/* ERR_INVALID_ARG_TYPE with the runtime-rendered Received tail (the
 * error.argTypeThrow libCall). Borrows all three; always throws. */
SCR_COLD void scr_throw_arg_type(const ScrStr *argname, const ScrStr *expected, const ScrDyn *got);
SCR_COLD void scr_dyn_arg_type_fail(const char *argname, const char *expected, const ScrDyn *got);
/* The property flavor ("The \"options.x\" property must be ...") — the
 * option-bag validators' gate (error.propTypeThrow). Always throws. */
SCR_COLD void scr_throw_prop_type(const ScrStr *name, const ScrStr *expected, const ScrDyn *got);
SCR_COLD void scr_dyn_prop_type_fail(const char *name, const char *expected, const ScrDyn *got);
/* Node's ERR_INVALID_ARG_VALUE ("The argument 'encoding' is invalid
 * encoding. Received 'no'") — reason NULL renders "is invalid".
 * TypeError; always throws catchably. */
SCR_COLD void scr_dyn_arg_value_fail(const char *name, const char *reason, const ScrDyn *got);
/* The ERR_INVALID_ARG_VALUE/%j "Received" renderer (inspect-lite:
 * strings quote, scalars print plain, deep shapes sketch). */
const char *scr_dyn_inspect_lite(const ScrDyn *v, char *buf, size_t cap);
ScrStr *scr_str_inspect_quoted(const ScrStr *s, bool truncate);
/* A ladder's post-validation refuse: throws the compiler-rendered SC2020
 * statement-fence text verbatim (Node's validation errors run first). */
SCR_COLD void scr_throw_lowering_fence(const ScrStr *msg);
/* ERR_OUT_OF_RANGE's "Received" number rendering (Node's
 * addNumericalSeparator underscores past 2^32) — scr_bytes.c's renderer,
 * shared by the fs/net/tls option-ladder validators. */
size_t scr_num_received(double v, char out[48]);
/* Listener-closure builders for the handle dispatchers' .on(...) paths:
 * a runtime-built ScrClosure whose capture is the boxed dyn listener and
 * whose invoke boxes the event tuple back into the checked-dynamic tree and calls through
 * the checked-dynamic machinery. The matching fn-pointer shapes are the
 * per-event thunk types the registration entries take (fire0's zero-arg
 * convention / ScrNetDataFn / ScrChildErrFn). cb borrowed; result +1. */
ScrClosure *scr_dyn_listener_closure0(const ScrDyn *cb);
ScrClosure *scr_dyn_listener_closure_data(const ScrDyn *cb);
ScrClosure *scr_dyn_listener_closure_err(const ScrDyn *cb);
/* The generic pair for fire thunks the OWNING units define (handle-boxing
 * tuples this unit cannot spell: 'connection' sockets, 'request' pairs):
 * the same one-capture closure with a caller-supplied fire, and the
 * capture read those fires start from (+1). */
ScrClosure *scr_dyn_listener_closure_fn(const ScrDyn *cb, void *fire);
ScrDyn *scr_dyn_listener_fn(ScrClosure *cb);
typedef void (*ScrDynListenerDataFn)(ScrClosure *cb, ScrBytes *chunk);
typedef void (*ScrDynListenerErrFn)(ScrClosure *cb, ScrStr *msg);
extern void scr_dyn_listener_fire0(ScrClosure *cb);
extern void scr_dyn_listener_fire_data(ScrClosure *cb, ScrBytes *chunk);
extern void scr_dyn_listener_fire_err(ScrClosure *cb, ScrStr *msg);

void *scr_dyn_retain_v(void *d);
/* After a compiled fast path decremented a surviving value of a kind that
 * can be a cycle candidate and is not one yet (scr_json.c). */
void scr_dyn_release_survivor(ScrDyn *d);
void scr_dyn_release_v(void *d);
void scr_dyn_trace_v(void *d, ScrTraceVisit visit, void *ctx);

#ifdef SCR_RC_AUDIT
long scr_dyn_live_count(void);
#endif

/* Checked-object primitives the dynamic tier's inline caches build on
 * (scr_js_object.c). They exist only in the SCR_JS_TIER build of
 * scr_json.c, which programs with dynamic-tier code link. */
/* The builtin Object.prototype node, or NULL before its first use. */
const ScrDyn *scr_dyn_tier_object_prototype(void);
/* A read site's answer for a native array's length or a native iterator's
 * next (scr_js_get_probe_native): +1, or NULL. */
ScrDyn *scr_dyn_tier_unshaped_get(const ScrDyn *receiver, const ScrStr *key);
/* Appends to a layout-mode object the property that `next`, a child of
 * its layout, adds, taking ownership of `value`, exactly as an ordinary
 * insertion would. */
void scr_dyn_tier_append(ScrDyn *obj, const ScrLayout *next, ScrDyn *value);

#endif /* SCR_DYN_H */
