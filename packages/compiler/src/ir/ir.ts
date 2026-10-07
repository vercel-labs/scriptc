import { InternalCompilerError } from "../errors.js";
import type { IrLibFn } from "./builtin-signatures.js";
export type { IrLibFn } from "./builtin-signatures.js";
/* scriptc IR — the only interface between frontend and backends.
 *
 * Design rules (see docs/ir.md for node-by-node semantics):
 * - Plain JSON-safe discriminated unions: no classes, no parent pointers,
 *   no cycles. Cross-references are by string id.
 * - Every node carries `loc` (source span) and every expression carries its
 *   computed `type` — backends never re-derive types.
 * - Structured control flow (statement tree), not basic blocks: the only
 * LLVM backend lowers these into control flow. A future IR optimization
 *   pass can run after validation.
 * - The type union is deliberately written for extension (`dyn` shipped
 *   with JSON, `promise` with async). All switches over IrType/IrExpr/
 *   IrStmt must have exhaustive `never` default arms so adding a member
 *   turns into compile errors, not silent misbehavior.
 */

/** Byte-offset span in the original source file. */
export interface SrcLoc {
  file: string;
  start: number;
  end: number;
}

/* ── types ─────────────────────────────────────────────────────────────── */

/** Numeric typed-array element kinds with a native representation. Float16
 * and BigInt typed arrays remain frontend-fenced. */
export type IrBytesElem = "u8" | "u8c" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64";

export const BYTES_ELEMENT_SIZE: Record<IrBytesElem, number> = {
  u8: 1,
  u8c: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  f64: 8,
};

export const BYTES_ELEMENT_NAME: Record<IrBytesElem, string> = {
  u8: "Uint8Array",
  u8c: "Uint8ClampedArray",
  i8: "Int8Array",
  u16: "Uint16Array",
  i16: "Int16Array",
  u32: "Uint32Array",
  i32: "Int32Array",
  f32: "Float32Array",
  f64: "Float64Array",
};

export type IrType =
  | { kind: "f64" }
  /** An ECMAScript bigint primitive. Runtime values are immutable,
   * arbitrary-precision signed integers (ScrBigInt) whose numeric value,
   * not pointer identity, defines equality. The heap representation is an
   * implementation detail: bigint remains a JS primitive for truthiness,
   * typeof, comparison, inspection, and container semantics. */
  | { kind: "bigint" }
  /** The supported ES Date value slice: a scalar TimeClip'd millisecond
   * value. Getters and toISOString observe only this slot, so copying it
   * through locals/params/fields is exact while Date mutation and object
   * identity remain frontend-fenced. It is therefore intentionally NOT
   * refcounted despite being truthy like every JS object. */
  | { kind: "date" }
  | { kind: "string" } // heap, refcounted, UTF-8
  | { kind: "bool" }
  | { kind: "array"; elem: IrType } // heap, refcounted, monomorphic elements
  /** ES `Map<K, V>` — heap, refcounted, insertion-ordered hash map with ONE
   * runtime representation (ScrMap) and type-directed key/value handling,
   * exactly the array pattern (never per-instantiation structs). Keys use
   * numeric SameValueZero, string content, or reference identity, including
   * payload identity for unions of reference keys. isSupportedMapKey and
   * isSupportedMapValue define the frontend/validator storage fences. */
  | { kind: "map"; key: IrType; value: IrType }
  /** ES `Set<T>` — heap, refcounted, insertion-ordered. Map's sibling with
   * the value slot removed: ONE runtime representation (the backend lowers
   * sets onto the map runtime with a constant unit value), elements are
   * exactly Map's KEY types and use the same equality. Reference elements
   * carry retain/release and, when cycle-capable, tracing adapters. */
  | { kind: "set"; elem: IrType }
  /** A regular expression — heap, refcounted, IMMUTABLE. No lastIndex
   * statefulness exists: /g and /y are supported only inside
   * replace/replaceAll/split (where the iteration is internal), and test()
   * on them is rejected. Every regex value today originates from a literal,
   * which backends intern as ONE immortal static per (pattern, flags) pair
   * — bytecode compiles lazily at first use, is never freed, and the RC
   * audit ignores immortals. Deliberately narrower than string: no array
   * elements, no map keys/values, no union arms (a regex arm would have no
   * narrowing test), not JSON-safe. */
  | { kind: "regex" }
  /** A typed array / Node Buffer (Uint8Array, Uint32Array, Float32Array,
   * Float64Array;
   * Buffer IS a Uint8Array subclass and shares the u8 kind) — heap,
   * refcounted, MUTABLE, fixed-length, with ONE runtime representation
   * (ScrBytes) that owns storage or borrows it for subarray and DataView
   * views. Typed-array slice copies. Element reads widen to f64; writes
   * coerce JS-exactly (ToUint8/ToUint32 modular truncation and f32
   * rounding). OOB element access traps like arrays. Allowed
   * as array elements and union arms (tag-based narrowing, like url);
   * fenced out of map keys/values, set elements, and JSON. Holds only raw
   * bytes — never part of a cycle, no trace. */
  | { kind: "bytes"; elem: IrBytesElem }
  /** A WHATWG URL instance (scr_url.c): heap, refcounted, IMMUTABLE — the
   * parsed components are frozen at construction, so getters are pure
   * reads (the mutating lib setters are fenced). Constructed by `new URL`
   * and url.pathToFileURL libCalls. Holds only strings — never part of a
   * cycle, no trace. Allowed as a union arm (narrowing is tag-based, like
   * object arms); fenced out of array elements, map keys/values, and JSON
   * like regex. */
  | { kind: "url" }
  /** A URLSearchParams instance (scr_url.c): heap, refcounted, MUTABLE —
   * an ordered list of decoded (name, value) string pairs. Standalone
   * (`new URLSearchParams(...)`) or the LIVE view of a URL's query
   * (`u.searchParams` — cached on the URL, mutations re-serialize into
   * the URL's query so href reflects immediately). Holds only strings
   * plus at most the owning-URL edge (the URL never points back
   * owningly) — never part of a cycle, no trace. Same container rules
   * as url: union arms fine, arrays/maps/JSON fenced. */
  | { kind: "searchParams" }
  /** An ES symbol value (scr_symbol.c — linked only when the IR uses the
   * symbol surface): heap, refcounted, IMMUTABLE — a runtime-unique
   * IDENTITY whose pointer is the identity (`===` is a pointer compare;
   * equal descriptions are still distinct symbols, JS exactly). Holds at
   * most two strings (description + Symbol.for registry key) — never part
   * of a cycle, no trace. Constructed by `Symbol(desc?)` and
   * `Symbol.for(key)`; typeof answers "symbol"; truthiness is constant
   * true (every symbol is truthy). Allowed as union arms (tag-based
   * narrowing — `typeof u === "symbol"` is the test, like url), array
   * elements (SCR_ELEM_REF identity semantics, the child precedent), and
   * Set elements (identity hashing, SCR_MAP_KEY_REF — the netServer
   * precedent); fenced out of map keys/values and JSON (JSON.stringify
   * drops symbols in Node — silent divergence banned, reject instead).
   * Property KEYS stay frontend-fenced: static record/class shapes have
   * no symbol-keyed storage. */
  | { kind: "symbol" }
  /** An fs.Stats instance (statSync / fs.promises.stat): heap, refcounted,
   * IMMUTABLE — a snapshot of stat(2) results. Holds no references —
   * never part of a cycle, no trace. Same container rules as url: union
   * arms fine, arrays/maps/JSON fenced. */
  | { kind: "stats" }
  /** A node:fs/promises FileHandle: heap, refcounted, MUTABLE — aliases
   * share one descriptor slot, so close() is idempotent and every alias
   * observes fd === -1 after closure. The final release closes a still-
   * open descriptor, matching Node's ownership safety without its GC
   * warning. Holds no references and cannot participate in a cycle. */
  | { kind: "fileHandle" }
  /** A child_process.spawnSync result (scr_child.c): heap, refcounted,
   * IMMUTABLE — the reaped child's status plus its captured utf8 stdout/
   * stderr. Holds only strings — never part of a cycle, no trace. Same
   * container rules as stats. */
  | { kind: "spawnRes" }
  /** A child_process.spawn handle (scr_child.c): heap, refcounted, the
   * ONE mutable builtin value kind — the event loop reaps the child and
   * fires its registered listeners (scr_async.c polls at quiescence).
   * Holds closures until the terminal event fires, then drops them (the
   * registry releases every listener at reap, so a listener capturing its
   * own child never cycles past reap — and every child IS reaped before
   * loop exit, Node's keep-alive semantics). Lean allocation, no trace:
   * the pre-reap closure edges are guaranteed dropped. Same container
   * rules as stats: union arms fine, arrays/maps/JSON fenced. */
  | { kind: "child" }
  /** A node:net server handle (scr_net.c — linked only when the IR uses
   * the net surface). Heap, refcounted, MUTABLE like child: the event
   * loop's net hook accepts connections and fires its listeners.
   * Listeners are held only until the handle settles ('close' fired, or
   * the exit-time cleanup) — the child ownership story, so lean
   * allocation, no trace header. Same container rules as child: union
   * arms fine, arrays/maps/JSON fenced. */
  | { kind: "netServer" }
  /** A node:net socket handle (accepted connection or net.connect
   * client) — the same runtime story as netServer. */
  | { kind: "netSocket" }
  | { kind: "http2Session" }
  | { kind: "http2Stream" }
  /** A node:dgram socket handle (scr_dgram.c — linked only when the IR
   * uses the dgram/dns surface). Heap, refcounted, MUTABLE like
   * netSocket: the loop's dgram hook delivers datagrams and fires its
   * listeners. Listeners are held only until the handle settles ('close'
   * fired, or the exit-time cleanup) — the netSocket ownership story, so
   * lean allocation, no trace header. Same container rules: union arms
   * fine, arrays/maps/JSON fenced. */
  | { kind: "dgramSocket" }
  /** A node:test TestContext handle (scr_test.c — linked only when the
   * IR uses the node:test surface). Heap, refcounted, no cycles (the
   * runner tree owns the children; the parent edge is a borrowed
   * back-pointer): a lean handle like dgramSocket. Test bodies receive
   * it as their parameter; t.test/t.skip/t.todo/t.diagnostic lower to
   * test.* libCalls on it. */
  | { kind: "testCtx" }
  /** A node:http server request (scr_http.c — the parsed head + the body
   * event lists; listeners drop when the body completes, the same
   * settle-releases-listeners story). http.Server itself is a netServer. */
  | { kind: "httpReq" }
  /** A node:http server response (the header list + framing state; holds
   * the socket, never listeners — lean, no trace). */
  | { kind: "httpRes" }
  /** A node:http CLIENT request handle (http.request/http.get — the
   * outbound head + body framing state over a net client socket, with the
   * response/error/timeout/close listener lists; listeners drop at
   * settlement like every other handle). The RESPONSE it delivers is an
   * httpReq — IncomingMessage is one type in Node too. */
  | { kind: "httpClientReq" }
  /** A piped child-output stream (child.stdout / child.stderr — spawn
   * with stdio ["ignore", "pipe", "pipe"]; scr_child.c). Heap, refcounted,
   * MUTABLE like child: the loop's reap pass services the pipe and fires
   * 'data'/'end' listeners, which drop at EOF (the settle-releases-
   * listeners story), so lean allocation, no trace header. Same container
   * rules as child: union arms fine (the checker's `Readable | null`),
   * arrays/maps/JSON fenced. */
  | { kind: "childStream" }
  /** A piped child-input stream (child.stdin — spawn with a piped stdin
   * slot; scr_child.c). Heap, refcounted, and mutable: writes queue into
   * the platform pipe without blocking the JavaScript thread, and
   * drain/finish/error listeners drop when the writer settles. */
  | { kind: "childWriter" }
  /** A process output stream as a FIRST-CLASS value (process.stdout /
   * process.stderr flowing into a `NodeJS.WritableStream` slot — the
   * prefixStream idiom). Representation is the raw FD as a double (1 or
   * 2): a SCALAR kind like f64 — no heap, no refcount, boxes ride
   * SCR_BOX_F64. Truthiness is object-true (Node's streams are objects).
   * The lowered surface is write(string); everything else fences. */
  | { kind: "procStream" }
  /** An fs.FSWatcher handle (scr_watch.c — linked only when the IR uses
   * fs.watch). Heap, refcounted, MUTABLE like child: the event loop's
   * watch hook drains the unit's kqueue (EVFILT_VNODE) and fires its
   * listeners. Listeners are held only until close() (or the exit-time
   * cleanup) — the child ownership story, so lean allocation, no trace
   * header. Same container rules as child: union arms fine (the
   * `FSWatcher | null` polling-fallback local), arrays/maps/JSON fenced. */
  | { kind: "fsWatcher" }
  /** A tls.SecureContext handle (scr_tls.c): heap, refcounted, IMMUTABLE —
   * a parsed cert/key pair (tls.createSecureContext({ cert, key })) that
   * an SNI callback answers per-servername. Holds no references — never
   * part of a cycle, no trace. Union arms fine (the `ctx?: SecureContext`
   * callback parameter is the `SecureContext | undefined` union); allowed
   * as a Map VALUE (the per-hostname context cache) like child; fenced out
   * of array elements and JSON like the other opaque handles. */
  | { kind: "secureCtx" }
  /** A node:crypto Hash or Hmac handle (scr_lib.c): heap, refcounted,
   * MUTABLE until digest(), then permanently finalized. The two TypeScript
   * surfaces share one runtime representation but stay distinct IR kinds so
   * Hash.copy() cannot accidentally appear on Hmac values. The incremental
   * digest state owns no script values and cannot participate in a cycle. */
  | { kind: "cryptoHash" }
  | { kind: "cryptoHmac" }
  /** Heap, refcounted closure. `rest` marks a variadic function value.
   * `restAbi: "typed"` spells one trailing typed array in `params`; static
   * call sites pack their surplus arguments into it before `callValue`.
   * `restAbi: "jsval"` similarly spells one trailing engine array for an
   * island host callback. An absent `restAbi` is the legacy checked-dynamic
   * JS form: `params` stays the declared non-rest list and the lifted
   * function has one hidden trailing ScrDyn array filled by its boxed call
   * thunk. `argumentsAll` keeps that hidden ABI but fills it with every
   * actual argument, including named positions. The backends therefore
   * still see one fixed native closure ABI;
   * only the frontend's call completion observes variadic source arity. */
  | {
      kind: "func";
      params: IrType[];
      ret: IrType;
      rest?: true;
      restAbi?: "jsval" | "typed";
      argumentsAll?: true;
    }
  | { kind: "object"; className: string } // heap, refcounted class instance
  /** The class STATIC side as a value — `typeof C`, the type of the class
   * name itself and of `new (…) => T` constructor-typed slots. Runtime
   * representation is ScrClassObj: an immortal top-level template or a fresh
   * function-local object owning captured binding boxes. Identity is one
   * pointer comparison; local instances retain their constructor object.
   * Values of `classval:C` are C's class object or a STRICT DESCENDANT's —
   * the object kind's nominal, upcast-only story — and every legal flow
   * preserves the constructor ABI (upcast requires the descendant's
   * completed ctor signature to equal C's), which is what makes `newValue`
   * completion against C's one signature sound. Allowed in locals,
   * globals, params, returns, class/record fields, capture boxes, array
   * elements, Map VALUES, and union arms; fenced out of Map keys, Set
   * elements, JSON, jsval conversion, and ToString. Unknown slots retain
   * class identity and allow an exact typed constructor round trip. */
  | { kind: "classval"; className: string }
  /** An ECMAScript module namespace object for one statically-known module.
   * `moduleId` is a canonical compiled source-file or builtin identity.
   * Runtime representation is an interned immortal string token: identity
   * is pointer identity, while member reads resolve to live module globals
   * or builtin lowering tables rather than snapshotting export values. */
  | { kind: "moduleNs"; moduleId: string }
  /** Structural record shape (object literal / interface / type alias over
   * data properties). `shapeId` indexes IrModule.records; the frontend
   * interns shapes structurally, so equal shapeId ⇔ equal shape and
   * typeEquals may compare ids alone. Heap, refcounted, monomorphic. */
  | { kind: "record"; shapeId: string }
  /** Tagged union (`A | B`). `unionId` indexes IrModule.unions; the frontend
   * interns unions structurally (canonical identity = the sorted arm list),
   * so equal unionId ⇔ equal arm set and typeEquals may compare ids alone.
   * Values are heap, refcounted, IMMUTABLE tagged boxes: a runtime tag (the
   * arm's index in the canonical order) plus one payload slot. */
  | { kind: "union"; unionId: string }
  /** A dynamic value — the type of `unknown` (JSON.parse results and
   * unknown-typed locals/params/returns). Runtime representation is a
   * refcounted JSON dyn tree (ScrDyn). Deliberately NARROW: a dyn value can
   * be stored in locals/globals, passed as a param/call arg, returned,
   * validated with a checked cast (`dynCheck`), CALLED (`dynCall` — the
   * dyn's function kind, boxed closures with per-call argument checks),
   * and captured by closures (an untraced obj-box: cycles through dyn are
   * never collected, SEMANTICS.md); it can NOT ride record/class fields,
   * array elements, union arms, or the exception cell, and every other
   * operation on it (property access, arithmetic, truthiness, `===`,
   * console.log, ...) is frontend-rejected with a "validate with 'as
   * <type>' first" hint — or, in JavaScript sources, met with per-site
   * checked lowerings (SEMANTICS.md 115-117). */
  | { kind: "dyn" }
  /** An island value handle — the type of `any` under --dynamic. Runtime
   * representation is a refcounted cell (ScrJsval) owning one embedded-
   * engine value. It can live in locals, globals, parameters, returns,
   * arrays, class fields, and ambient AbortSignal/AbortController record
   * fields. Operations on jsval compile to engine calls (jsOp) with
   * JS-exact semantics; exits back to static types are validated (jsExit).
   * This kind exists only with the dynamic option. */
  | { kind: "jsval" }
  /** A catch binding or its closure capture (never parameters, returns,
   * fields, arms, elements or globals).
   * Runtime representation is a refcounted snapshot box (ScrCaught) holding
   * the taken exception: a kind tag plus the payload. Even NARROWER than
   * dyn: the only expressions a caught value may appear in are `caughtTest`
   * (kind/instanceof tests), `caughtNarrow` (checker-trusted extraction
   * under a proven test), and the `rethrow` statement — the frontend
   * rejects every other use with the narrowing hint. */
  | { kind: "caught" }
  | { kind: "promise"; inner: IrType } // heap, refcounted, settled-once
  /** A sync generator object (`function*`'s result — scr_async.c's ScrGen):
   * heap, refcounted, MUTABLE — a paused fiber plus the typed value
   * channels. `yieldT` is what `yield e` sends OUT (never yields → the
   * frontend picks the channel off the declared/inferred Generator type;
   * a generator that never yields still carries the type's slot), `retT`
   * what `return v` completes with (VOID when the type carries no return
   * value — the done result's value is then the undefined arm), `nextT`
   * what `.next(v)` sends IN (the yield expression's result type). Lean
   * allocation, NO cycle header: a suspended fiber's stack is untraceable
   * by construction, so a generator captured into a cycle its own locals
   * hold is a documented leak (the abandoned-fiber audit note covers
   * generators still suspended at exit). Fenced out of union arms (no
   * narrowing test — the map/set rule), map keys/values, set elements,
   * array elements, and JSON. */
  | { kind: "generator"; async?: true; yieldT: IrType; retT: IrType; nextT: IrType }
  /** The `undefined` unit type — a payload-less arm kind. Representable
   * ONLY as a union arm (`string | undefined`) or as the type of a
   * `unitLit` on its way into a `unionWrap`; it can never stand alone in
   * locals, globals, record/class fields, array elements, params, or
   * returns (the frontend maps standalone `undefined` to void in return
   * position and rejects it in value position — see mapType). A union
   * instance holding a unit arm carries the tag and NO payload; backends
   * may intern ONE immortal instance per (union, tag). */
  | { kind: "undefinedT" }
  /** The `null` unit type — same fences and representation as undefinedT.
   * Unlike undefinedT it is JSON-representable: JSON `null` matches a
   * nullT arm in dynCheck, and a null-armed union stringifies as `null`. */
  | { kind: "nullT" }
  | { kind: "void" }; // return position only

const POINTER_HANDLE_KINDS = [
  "stats",
  "fileHandle",
  "spawnRes",
  "child",
  "netServer",
  "netSocket",
  "http2Session",
  "http2Stream",
  "dgramSocket",
  "testCtx",
  "httpReq",
  "httpRes",
  "httpClientReq",
  "secureCtx",
  "cryptoHash",
  "cryptoHmac",
  "fsWatcher",
  "childStream",
  "childWriter",
] as const satisfies readonly IrType["kind"][];

interface IrKindSet<K extends IrType["kind"]> extends ReadonlySet<IrType["kind"]> {
  has(kind: IrType["kind"]): kind is K;
}

function irKindSet<const K extends readonly IrType["kind"][]>(kinds: K): IrKindSet<K[number]> {
  return new Set<IrType["kind"]>(kinds) as unknown as IrKindSet<K[number]>;
}

/** The opaque runtime handle kinds. procStream is the one scalar handle;
 * every other handle has pointer representation. */
const HANDLE_KIND_LIST = [...POINTER_HANDLE_KINDS, "procStream"] as const;
export type HandleKind = (typeof HANDLE_KIND_LIST)[number];
type HandleType = Extract<IrType, { kind: HandleKind }>;
export const HANDLE_KINDS = irKindSet(HANDLE_KIND_LIST);

/** The IR kinds represented as pointers in native code. */
const POINTER_KIND_LIST = [
  "string",
  "bigint",
  "array",
  "map",
  "set",
  "regex",
  "bytes",
  "url",
  "searchParams",
  "symbol",
  ...POINTER_HANDLE_KINDS,
  "func",
  "object",
  "classval",
  "moduleNs",
  "record",
  "union",
  "dyn",
  "jsval",
  "caught",
  "promise",
  "generator",
] as const;
export type PointerKind = (typeof POINTER_KIND_LIST)[number];
export const POINTER_KINDS = irKindSet(POINTER_KIND_LIST);

/** Runtime RC symbol stem for each IR type kind. An empty stem means the
 * kind is scalar/unit or uses an emitted per-shape helper (object/record).
 * Keeping this exhaustive makes a new runtime handle kind a compile error
 * until its one retain/release family is named here. */
export const RUNTIME_RC_STEMS: Record<IrType["kind"], string> = {
  f64: "",
  bigint: "scr_bigint",
  date: "",
  string: "scr_str",
  bool: "",
  array: "scr_arr",
  map: "scr_map",
  set: "scr_map",
  regex: "scr_regex",
  bytes: "scr_bytes",
  url: "scr_url",
  searchParams: "scr_sp",
  symbol: "scr_sym",
  stats: "scr_stats",
  fileHandle: "scr_file_handle",
  spawnRes: "scr_spawn_res",
  child: "scr_child",
  netServer: "scr_net_server",
  netSocket: "scr_net_sock",
  http2Session: "scr_http2_session",
  http2Stream: "scr_http2_stream",
  dgramSocket: "scr_dgram",
  testCtx: "scr_testctx",
  httpReq: "scr_http_req",
  httpRes: "scr_http_res",
  httpClientReq: "scr_http_client",
  childStream: "scr_child_stream",
  childWriter: "scr_child_writer",
  procStream: "",
  fsWatcher: "scr_watcher",
  secureCtx: "scr_secure_ctx",
  cryptoHash: "scr_crypto_hash",
  cryptoHmac: "scr_crypto_hash",
  func: "scr_closure",
  object: "",
  classval: "scr_classobj",
  moduleNs: "scr_str",
  record: "",
  union: "scr_union",
  dyn: "scr_dyn",
  jsval: "scr_jsval",
  caught: "scr_caught",
  promise: "scr_promise",
  generator: "scr_gen",
  undefinedT: "",
  nullT: "",
  void: "",
};

/** The runtime-provided RC family for a type, or null when the backend must
 * use an emitted class/record helper (or the type is not refcounted). */
export function runtimeRcStem(t: IrType): string | null {
  if (t.kind === "object") {
    if (RUNTIME_ERROR_CLASSES.has(t.className)) return "scr_error";
    if (t.className === RUNTIME_EMITTER_CLASS) return "scr_emitter";
    if (RUNTIME_STREAM_CLASSES.has(t.className)) return "scr_stream";
    return null;
  }
  const stem = RUNTIME_RC_STEMS[t.kind];
  return stem === "" ? null : stem;
}

/** The ref kinds whose values are JS OBJECTS for truthiness: always true
 * ([] and {} included) — toBool accepts them (the operand still evaluates;
 * the test is constant), and per-union truthiness helpers answer their
 * arms with `true`. */
export const REF_TRUTHY_KINDS: ReadonlySet<string> = new Set([
  // symbol is not a JS object, but every symbol is truthy — the same
  // constant-true answer.
  "symbol",
  "date",
  "array",
  "map",
  "set",
  "regex",
  "url",
  "searchParams",
  "stats",
  "fileHandle",
  "spawnRes",
  "child",
  "netServer",
  "netSocket",
  "http2Session",
  "http2Stream",
  "dgramSocket",
  "testCtx",
  "httpReq",
  "httpRes",
  "httpClientReq",
  "secureCtx",
  "cryptoHash",
  "cryptoHmac",
  "fsWatcher",
  "childStream",
  "childWriter",
  "procStream",
  "bytes",
  "func",
  "object",
  "record",
  "promise",
  // A generator object is a JS object: always truthy.
  "generator",
  // A class object is a JS object (constructors are functions): always truthy.
  "classval",
  // A module namespace object is always truthy.
  "moduleNs",
]);

export const F64: IrType = { kind: "f64" };
export const BIGINT_T: IrType = { kind: "bigint" };
export const DATE_T: IrType = { kind: "date" };
export const BYTES_U8: IrType = { kind: "bytes", elem: "u8" };
export const STRING: IrType = { kind: "string" };
export const BOOL: IrType = { kind: "bool" };
export const REGEX: IrType = { kind: "regex" };
export const URL_T: IrType = { kind: "url" };
export const SEARCH_PARAMS_T: IrType = { kind: "searchParams" };
export const SYMBOL_T: IrType = { kind: "symbol" };
export const STATS_T: IrType = { kind: "stats" };
export const FILEHANDLE_T: IrType = { kind: "fileHandle" };
export const SPAWNRES_T: IrType = { kind: "spawnRes" };
export const CHILD_T: IrType = { kind: "child" };
export const NETSERVER_T: IrType = { kind: "netServer" };
export const NETSOCKET_T: IrType = { kind: "netSocket" };
export const HTTP2SESSION_T: IrType = { kind: "http2Session" };
export const HTTP2STREAM_T: IrType = { kind: "http2Stream" };
export const DGRAMSOCK_T: IrType = { kind: "dgramSocket" };
export const TESTCTX_T: IrType = { kind: "testCtx" };
export const HTTPREQ_T: IrType = { kind: "httpReq" };
export const HTTPRES_T: IrType = { kind: "httpRes" };
export const HTTPCLIENTREQ_T: IrType = { kind: "httpClientReq" };
export const SECURECTX_T: IrType = { kind: "secureCtx" };
export const CRYPTOHASH_T: IrType = { kind: "cryptoHash" };
export const CRYPTOHMAC_T: IrType = { kind: "cryptoHmac" };
export const FSWATCHER_T: IrType = { kind: "fsWatcher" };
export const CHILDSTREAM_T: IrType = { kind: "childStream" };
export const CHILDWRITER_T: IrType = { kind: "childWriter" };
export const PROCSTREAM_T: IrType = { kind: "procStream" };
export const VOID: IrType = { kind: "void" };
export const DYN: IrType = { kind: "dyn" };
export const JSVAL: IrType = { kind: "jsval" };
export const CAUGHT: IrType = { kind: "caught" };
export const UNDEFINED_T: IrType = { kind: "undefinedT" };
export const NULL_T: IrType = { kind: "nullT" };

/** True for the payload-less unit kinds (`undefined`/`null`). Unit values
 * exist only inside unions: a unit-armed union instance is tag-only, so
 * wrapping allocates no payload, narrowing to a unit arm produces no value
 * (the frontend never emits it), and releasing has nothing to release. */
export function isUnitType(t: IrType): boolean {
  return t.kind === "undefinedT" || t.kind === "nullT";
}

/** Element kinds with a real ScrArr storage/RC representation.
 * Array-producing lowerings can learn their result element from
 * a callback rather than through mapType's ordinary T[] gate, so they must
 * share this predicate instead of reconstructing an array around an
 * otherwise-valid standalone type (Date, opaque handles, ...). */
export function isSupportedArrayElem(t: IrType): boolean {
  switch (t.kind) {
    // Native collection seeds and drains retain checked values in a
    // temporary vector. User-facing unknown[] still maps to a dyn array.
    case "dyn":
    case "f64":
    case "bigint":
    case "bool":
    case "string":
    case "array":
    case "map":
    case "set":
    case "bytes":
    case "record":
    case "object":
    case "union":
    case "func":
    case "promise":
    case "jsval":
    case "regex":
    case "child":
    case "netServer":
    case "symbol":
    case "classval":
    case "moduleNs":
      return true;
    default:
      return false;
  }
}

export function arrayOf(elem: IrType): IrType {
  return { kind: "array", elem };
}

export function bytesOf(elem: IrBytesElem): IrType {
  return { kind: "bytes", elem };
}

export function mapOf(key: IrType, value: IrType): IrType {
  return { kind: "map", key, value };
}

export function setOf(elem: IrType): IrType {
  return { kind: "set", elem };
}

/** Values whose native reference represents JavaScript identity. Records,
 * classes and arrays can point back at their collection, so constructors
 * must carry key tracing as well as retain/release adapters. */
export function isIdentityCollectionKey(t: IrType): boolean {
  return (
    t.kind === "record" ||
    t.kind === "object" ||
    t.kind === "array" ||
    t.kind === "netServer" ||
    t.kind === "symbol"
  );
}

/** Primitive keys compare by value and reference keys by identity. Union
 * wrappers carry either domain without becoming observable key identities;
 * null and undefined are distinct tag-only keys inside a union. */
export function isPrimitiveCollectionKey(t: IrType, unionArms?: IrType[]): boolean {
  if (t.kind === "union")
    return !!unionArms?.length && unionArms.every((arm) => isPrimitiveCollectionKey(arm));
  return (
    t.kind === "f64" ||
    t.kind === "string" ||
    t.kind === "bigint" ||
    t.kind === "bool" ||
    t.kind === "symbol" ||
    isUnitType(t)
  );
}

export function isSupportedMapKey(t: IrType, unionArms?: IrType[]): boolean {
  return (
    isCollectionValueKey(t) ||
    t.kind === "dyn" ||
    (t.kind === "union" &&
      unionArms !== undefined &&
      unionArms.length > 0 &&
      unionArms.every((arm) => isCollectionValueKey(arm) || isUnitType(arm)))
  );
}

function isCollectionValueKey(t: IrType): boolean {
  return (
    t.kind === "f64" ||
    t.kind === "string" ||
    t.kind === "bigint" ||
    t.kind === "bool" ||
    isIdentityCollectionKey(t)
  );
}

/** Set elements and Map keys share storage, equality and ownership rules. */
export function isSupportedSetElem(t: IrType, unionArms?: IrType[]): boolean {
  return isSupportedMapKey(t, unionArms);
}

/** The Map VALUE fence: scalars, supported native references and checked
 * values. Functions require checked-value boxing; jsval has no native slot.
 * Record/object/union values can point back at the map holding them, which
 * is exactly why ref-valued maps are cycle-capable (see the backend's
 * cycle analysis and docs/memory.md). Shared frontend/validator. */
export function isSupportedMapValue(t: IrType): boolean {
  switch (t.kind) {
    case "dyn":
    case "f64":
    case "bigint":
    case "string":
    case "bool":
    case "record":
    case "object":
    case "union":
    case "array":
    // Nested collections use the existing ref slot and scr_map adapters.
    // Their key/value tracing participates in the cycle-analysis fixpoint.
    case "map":
    case "set":
      return true;
    // A spawned child handle (Map<string, ChildProcess> — the mdns
    // publisher registry): an ordinary refcounted pointer value (the
    // scr_child_retain/release adapters), stored and read like any ref.
    // It holds closures only until its terminal event fires (then drops
    // them), so a child in a map cannot cycle through the map; the RC
    // adapters handle its lifetime.
    case "child":
      return true;
    // A SecureContext handle (Map<string, tls.SecureContext> — the SNI
    // callback's per-hostname cache): immutable, holds no references —
    // the same ordinary refcounted pointer story as child, without even
    // the pre-settle closures.
    case "secureCtx":
      return true;
    // A promise (Map<string, Promise<SecureContext>> — the SNI callback's
    // in-flight dedupe map): refcounted, with trace/cycle support already
    // in place (scr_promise_trace_v — the race machinery's refcounting).
    // It holds reaction closures only until it settles (settled promises
    // drop them), so the child rule's temporary-cycle story applies: a
    // pending promise whose callbacks capture the map is a cycle only
    // until settlement, and the collector handles the never-settling case.
    case "promise":
      return true;
    // A class object (Map<string, typeof Shape> — the registry/factory
    // idiom): an immortal static behind no-op RC adapters — it holds no
    // references at all, so no trace, no cycles, ever.
    case "classval":
      return true;
    // A regex (Map<string, RegExp> — the per-EOL pattern table): the
    // array-element story (scr_regex retain/release adapters, no trace —
    // a regex holds no references), map form.
    case "regex":
      return true;
    default:
      return false;
  }
}

/** The INDEX-SIGNATURE value fence (`{ [k: string]: V }` shapes): the map
 * VALUE kinds — the overflow portion IS a string-keyed map — plus dyn
 * (`unknown`, an unknown-valued pricing-table shape: overflow reads surface ordinary
 * dyn values validated by the usual checked casts) and callable values:
 *   func — `Record<string, () => void>`, the command-registry pattern
 *          (scr_closure adapters; closures are cycle-headered and traced,
 *          so a handler capturing its own registry collects)
 * Nested index-signature RECORDS ride the record kind like any other.
 * Shared frontend (mapType) / validator. */
export function isSupportedIndexValue(t: IrType): boolean {
  return t.kind === "dyn" || t.kind === "func" || isSupportedMapValue(t);
}

export function funcOf(params: IrType[], ret: IrType): IrType {
  return { kind: "func", params, ret };
}

/** Maps, sets and promises may share a union with null/undefined only.
 * Unit tag tests can narrow nullable containers without losing identity;
 * arbitrary data siblings require a separate runtime narrowing operation.
 * Share this rule across checker mapping, synthesized unions and validation. */
export function unionContainerArmsOk(arms: IrType[]): boolean {
  return arms.every(
    (a, i) =>
      (a.kind !== "map" && a.kind !== "set" && a.kind !== "promise") ||
      arms.every((b, j) => j === i || isUnitType(b)),
  );
}

/** Canonical, injective text form of an IrType — the building block of
 * shape/union identity keys, generic-function instantiation keys, and the
 * backend's per-type helper interning (jsonStringify/dynCheck walkers).
 * Nested records/unions are represented by their (already interned, already
 * canonical) shapeId/unionId, so keys stay finite and comparable. Lives in
 * the IR (not the frontend) because both ends need it. */
export function typeKey(t: IrType): string {
  if (HANDLE_KINDS.has(t.kind)) return t.kind;
  switch (t.kind) {
    case "f64":
    case "bigint":
    case "date":
    case "string":
    case "bool":
    case "regex":
    case "url":
    case "searchParams":
    case "symbol":
    case "dyn":
    case "jsval":
    case "caught":
    case "void":
      return t.kind;
    case "undefinedT":
      return "undefined";
    case "nullT":
      return "null";
    case "array":
      return `array<${typeKey(t.elem)}>`;
    case "bytes":
      return `bytes<${t.elem}>`;
    case "map":
      return `map<${typeKey(t.key)},${typeKey(t.value)}>`;
    case "set":
      return `set<${typeKey(t.elem)}>`;
    case "func":
      return `func(${[...t.params.map(typeKey), ...(t.rest ? [t.restAbi === "jsval" ? "...jsval[]" : t.restAbi === "typed" ? "...typed[]" : t.argumentsAll ? "arguments[]" : "...dyn[]"] : [])].join(",")})=>${typeKey(t.ret)}`;
    case "object":
      return `object:${t.className}`;
    case "classval":
      return `classval:${t.className}`;
    case "moduleNs":
      return `moduleNs:${t.moduleId}`;
    case "record":
      return `record:${t.shapeId}`;
    case "union":
      return `union:${t.unionId}`;
    case "promise":
      return `promise<${typeKey(t.inner)}>`;
    case "generator":
      return `${t.async ? "async-generator" : "generator"}<${typeKey(t.yieldT)},${typeKey(t.retT)},${typeKey(t.nextT)}>`;
    default: {
      const _exhaustive: never = t as Exclude<typeof t, HandleType>;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

export function typeEquals(a: IrType, b: IrType): boolean {
  // Dispatch once: a chain of negative narrowing checks repeatedly retags
  // the remaining variants when this comparator runs in the native compiler.
  switch (a.kind) {
    case "array":
      return b.kind === "array" && typeEquals(a.elem, b.elem);
    case "bytes":
      return b.kind === "bytes" && a.elem === b.elem;
    case "map":
      return b.kind === "map" && typeEquals(a.key, b.key) && typeEquals(a.value, b.value);
    case "set":
      return b.kind === "set" && typeEquals(a.elem, b.elem);
    case "func":
      return (
        b.kind === "func" &&
        a.params.length === b.params.length &&
        (a.rest === true) === (b.rest === true) &&
        a.restAbi === b.restAbi &&
        a.argumentsAll === b.argumentsAll &&
        a.params.every((p, i) => typeEquals(p, b.params[i]!)) &&
        typeEquals(a.ret, b.ret)
      );
    case "object":
      return b.kind === "object" && a.className === b.className;
    case "classval":
      return b.kind === "classval" && a.className === b.className;
    case "moduleNs":
      return b.kind === "moduleNs" && a.moduleId === b.moduleId;
    // Shapes and unions are interned, so their ids determine equality.
    case "record":
      return b.kind === "record" && a.shapeId === b.shapeId;
    case "union":
      return b.kind === "union" && a.unionId === b.unionId;
    case "promise":
      return b.kind === "promise" && typeEquals(a.inner, b.inner);
    case "generator":
      return (
        b.kind === "generator" &&
        (a.async === true) === (b.async === true) &&
        typeEquals(a.yieldT, b.yieldT) &&
        typeEquals(a.retT, b.retT) &&
        typeEquals(a.nextT, b.nextT)
      );
    default:
      return a.kind === b.kind;
  }
}

/** True for types whose values are heap-allocated and reference-counted.
 * The single dispatch point for the backend's RC machinery: retains,
 * releases, frame/scope tracking, and NULL-initialized locals all key off
 * this — adding a refcounted kind must not grow new per-kind checks outside
 * the type-directed helpers. */
export function isRefCounted(t: IrType): boolean {
  return RUNTIME_RC_STEMS[t.kind] !== "" || t.kind === "object" || t.kind === "record";
}

/* ── module ────────────────────────────────────────────────────────────── */

export interface IrModule {
  /** Bumped on any breaking IR change; serialize.ts refuses mismatches. */
  irVersion: 13;
  sourceFile: string;
  functions: IrFunction[];
  /** Class shapes. Constructors and methods are ordinary module functions
   * named `%Class.constructor` / `%Class.method` whose first param is
   * `this`. Dispatch is static by default; single inheritance (`base`)
   * routes the calls that can actually reach an override through per-class
   * vtables (`virtualCall`) — everything else stays a direct `call`. */
  classes?: IrClassDef[];
  /** Module-level variables (file-scope `const`/`let` of every source
   * file). Stable storage for the whole program: cross-module live
   * bindings, and functions can reference them directly (no capture —
   * globals are never boxed). Initialized by assignments inside the
   * per-file `%init.<i>` functions; ids live in a distinct "%g." namespace so
   * they can never collide with function-local ids. */
  globals?: IrGlobal[];
  /** The embedded npm runtime graph (--dynamic builds with npm imports):
   * every reached module's SOURCE, keyed by resolved path, plus the
   * (importer, specifier) → target edges the island's module loader and
   * require shim resolve against. Emitted as static strings — binaries
   * never read node_modules at runtime. Edge targets are module keys or
   * "node:*" builtins (island-shimmed). */
  embedded?: {
    /** `esm` (CommonJS modules only) is the synthesized ESM facade the
     * island loader evaluates when an ES module imports the CJS file:
     * default plus the named exports LEXED from the source at build time
     * (cjs-lexer.ts — the compiler's port of Node's vendored CJS lexer). */
    modules: {
      key: string;
      source: string;
      format: "esm" | "cjs" | "json";
      esm?: string;
      /** Parsed/bound embedded source reaches the engine's global fetch. */
      usesFetch?: true;
    }[];
    /** `kind` picks Node's "exports" condition set per CALL FORM: one
     * (from, specifier) can name a dual package's ESM entry behind an
     * "import" edge AND its CJS entry behind a "require" edge; "any"
     * serves both lookups (relative files, builtins). */
    edges: { from: string; specifier: string; to: string; kind: "any" | "import" | "require" }[];
  };
  /** Record shapes, in first-seen (`r0`, `r1`, ...) order. Fields are in
   * CANONICAL order (sorted by name) — the shape's identity; a `recordLit`'s
   * fields stay in source order (evaluation order) independently. The
   * frontend guarantees structural dedup: no two entries share a canonical
   * field list. Backends emit one struct per shape, exactly like classes. */
  records?: IrRecordShape[];
  /** Tagged unions, in first-seen (`u0`, `u1`, ...) order. `arms` are in
   * CANONICAL order (sorted by typeKey) — the union's identity; the arm's
   * INDEX in this list is its runtime tag. The frontend guarantees
   * structural dedup and that arms are pairwise-distinct IR types, none of
   * them void/func/union (the unit kinds undefinedT/nullT ARE valid arms —
   * union membership is the only place they exist). */
  unions?: IrUnionDef[];
  /** Name of the synthetic function holding top-level statements. */
  entry: string;
  /** Outbound native FFI declarations used by `ffiCall` expressions.
   * These are link-time C ABI imports, not runtime dynamic-library handles:
   * executable builds resolve their symbols from the manifest's archive
   * and system-library inputs. Absent when the build has no FFI manifest. */
  ffiImports?: IrFfiImport[];
  /** LIBRARY mode: the profile's resolved export map plus the
   * mode-provided symbol names, landed ON the IR so the backend emits the
   * external-linkage wrappers and entries from the same facts — the two
   * emissions stay conformance-identical by construction. Absent on every
   * executable build (the backends emit main() exactly as always). */
  lib?: IrLibSection;
}

export type IrFfiValueParamClass =
  | "f64"
  | "f32"
  | "bool"
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "i64"
  | "u64"
  | "pointer"
  | "string"
  | "bytes"
  | "mutable-bytes";
export type IrFfiCallbackParamClass =
  | "f64"
  | "f32"
  | "bool"
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "i64"
  | "u64"
  | "pointer"
  | "cstring"
  | "string"
  | "bytes";
export type IrFfiReturnClass =
  | "f64"
  | "f32"
  | "bool"
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "i64"
  | "u64"
  | "pointer"
  | "void";

export interface IrFfiContextParam {
  /** Manifest-local id of the callback whose ScrClosure* occupies this ABI slot. */
  context: string;
}

export interface IrFfiCallbackParam {
  callback: {
    id: string;
    /** Exact callback ABI order; context entries consume no TS argument. */
    params: (IrFfiCallbackParamClass | IrFfiContextParam)[];
    returns: IrFfiReturnClass;
    lifetime: "call" | "retained";
    invoke: "script-thread" | "foreign";
  };
}

export interface IrFfiReleaseParam {
  callback: {
    /** `<binding>:<callback-id>` of the retained registration descriptor. */
    release: string;
    /** Resolved/inherited callback ABI. */
    params: (IrFfiCallbackParamClass | IrFfiContextParam)[];
    /** Resolved/inherited callback return ABI. */
    returns: IrFfiReturnClass;
  };
}

export type IrFfiParam =
  | IrFfiValueParamClass
  | IrFfiCallbackParam
  | IrFfiReleaseParam
  | IrFfiContextParam;

export function isFfiCallbackParam(param: IrFfiParam): param is IrFfiCallbackParam {
  return typeof param === "object" && "callback" in param && "id" in param.callback;
}

export function isFfiReleaseParam(param: IrFfiParam): param is IrFfiReleaseParam {
  return typeof param === "object" && "callback" in param && "release" in param.callback;
}

export function isFfiContextParam(
  param: IrFfiParam | IrFfiCallbackParam["callback"]["params"][number],
): param is IrFfiContextParam {
  return typeof param === "object" && "context" in param;
}

/** Script-side type represented by one scalar/span FFI class. */
export function ffiClassType(
  cls: IrFfiCallbackParamClass | IrFfiValueParamClass | IrFfiReturnClass,
): IrType {
  switch (cls) {
    case "i64":
    case "u64":
    case "pointer":
      return BIGINT_T;
    case "bool":
      return BOOL;
    case "cstring":
    case "string":
      return STRING;
    case "bytes":
    case "mutable-bytes":
      return BYTES_U8;
    case "void":
      return VOID;
    default:
      return F64;
  }
}

/** The ordinary TypeScript function type a native callback descriptor consumes. */
export function ffiCallbackType(
  callback: IrFfiCallbackParam["callback"] | IrFfiReleaseParam["callback"],
): IrType & { kind: "func" } {
  const params: IrType[] = [];
  for (const param of callback.params) {
    if (!isFfiContextParam(param)) params.push(ffiClassType(param));
  }
  return {
    kind: "func",
    params,
    ret: ffiClassType(callback.returns),
  };
}

/** Source parameters consume values; synthetic context ABI entries do not. */
export function ffiSourceParamTypes(params: readonly IrFfiParam[]): IrType[] {
  return params.flatMap((param): IrType[] => {
    if (isFfiContextParam(param)) return [];
    if (isFfiCallbackParam(param)) return [ffiCallbackType(param.callback)];
    if (isFfiReleaseParam(param)) return [ffiCallbackType(param.callback)];
    return [ffiClassType(param)];
  });
}

/** One outbound native FFI declaration. Format 1 contains only value
 * classes. Format 2 additionally carries exact-position callback/context
 * entries. Format 3 adds callback copy-in cstrings and spans. Format 4 adds
 * retained callbacks and resolved release entries. Outer string/bytes
 * values still expand to pointer+length pairs; callbacks, releases, and
 * contexts are each one native pointer slot. */
export interface IrFfiImport {
  /** The signature-only ambient TypeScript binding name. */
  name: string;
  /** The external C symbol. */
  symbol: string;
  /** Exact node:ffi.dlopen library name when exposed as a checked callable. */
  library?: string;
  callbackOperation?: "register" | "release";
  callbackTarget?: string;
  params: IrFfiParam[];
  returns: IrFfiReturnClass;
}

/** One export-map entry, resolved: the external ccc symbol, the IR
 * function it wraps, and the marshalling class of each parameter and the
 * return (already validated against the function's IR types — SC4003 ran
 * before this landed on the module). */
export interface IrLibExport {
  symbol: string;
  /** IR function name (entry-file top-level, so unqualified). */
  fnName: string;
  /** i64/u64 (ask 4): int64_t/uint64_t at the C edge — inbound values
   * range-check in the wrapper (`inboundIntTrap`), internal call sites
   * and returns are compile-time proven before this lands on the IR. */
  params: ("f64" | "bool" | "string" | "bytes" | "u8" | "u32" | "i32" | "i64" | "u64")[];
  returns: "f64" | "bool" | "string" | "bytes" | "void" | "i64" | "u64";
  /** The exact sink-message bytes this wrapper passes to the inbound-bytes
   * marshalling helper's trap — present exactly when a parameter is
   * bytes-classed. Already the assembled structured trap-teaching form
   * (library/trap-teaching.ts): 0x01, teaching text, 0x1F, SC4012, 0x1F,
   * this export's C symbol, and the profile's remediation behind one more
   * 0x1F when supplied. Assembled ONCE at export resolution so both
   * backends emit identical bytes by construction. */
  inboundBytesTrap?: string;
  /** The sibling message for the inbound INTEGER host-contract trap
   * (ask 4): present exactly when a parameter is i64/u64-classed, passed
   * to the scr_library_i64_in/u64_in helpers, which trap when the inbound
   * value cannot ride f64 exactly (|v| past 2^53−1). Same assembled
   * structured form and the same SC4012 code — one host-contract story. */
  inboundIntTrap?: string;
}

/** One runtime-trap overlay row: the profile's teaching (replaces the
 * baseline human line as field 0) and/or remediation (the optional fourth
 * field) for one runtime detected-trap code. At least one of the two is
 * present, or the row is not emitted. Text is profile-validated free of
 * the encoding's reserved bytes (SC4001). */
export interface IrLibTrapOverlay {
  code: string;
  teaching?: string;
  remediation?: string;
}

/** One resolved host-callback channel (the profile's `callbacks` entry
 * landed on the IR): compiled call sites of the channel's ambient binding
 * lower as ffiCall nodes carrying the channel name, and the backend emits
 * the same dispatch — fetch the slot's registered pointer through
 * scr_library_cb_require (which delivers `unregisteredTrap` through the
 * library funnel when the host never registered), then the typed indirect
 * call with the slot's opaque context first. */
export interface IrLibCallback {
  /** The channel name — the registration name string, the ambient
   * TypeScript binding, and the matching IrFfiImport's `name`. */
  name: string;
  /** The runtime channel slot (profile declaration order). */
  slot: number;
  params: ("f64" | "bool" | "string" | "bytes" | "u8" | "u32" | "i32")[];
  returns: "f64" | "bool" | "u8" | "u32" | "i32" | "i64" | "u64" | "pointer" | "void";
  /** The unregistered-call trap text (a DETECTED trap: plain bytes the
   * library funnel classifies SC4025 and assembles with the current
   * entry's symbol — unlike the SC4012 wrapper traps, the entry is only
   * known at runtime). Built once at export resolution so generated wrappers
   * emit identical constants by construction. */
  unregisteredTrap: string;
}

export interface IrLibSection {
  /** The profile's identity string (artifact header comments only). */
  profileName: string;
  /** Symbol-space hygiene: every external definition below carries it. */
  prefix: string;
  initSymbol: string;
  sinkRegisterSymbol: string;
  /** The mode-provided collect entry (cycle collector + arena reset), or
   * null when the profile declares none. */
  collectSymbol: string | null;
  /** The declared result-arena reset entry; null selects the auto-reset
   * posture (every entry prologue resets the arena). */
  resultResetSymbol: string | null;
  /** Thread-instanced state (the profile's abi.instance_per_thread): both
   * backends emit the program TU's mutable statics — module globals,
   * run-once guards, and the lazily-compiled regex literal caches — as
   * thread-local storage, matching the runtime objects compiled with
   * -DSCR_THREAD_INSTANCES: one full instance per embedder thread. */
  threadInstances: boolean;
  /** The host-callback registration symbol; present exactly when
   * `callbacks` is (the profile pairs them — SC4001 otherwise). Both
   * fields stay ABSENT on callback-free profiles so their serialized IR
   * and emitted TU are unchanged byte-for-byte. */
  callbackRegisterSymbol?: string;
  /** The resolved host-callback channels, slot-ordered. */
  callbacks?: IrLibCallback[];
  exports: IrLibExport[];
  /** Profile-declared teaching/remediation overlays for the runtime
   * detected-trap code family (SC4013–SC4019, diagnostics registry): both
   * backends emit these as the program TU's overlay table
   * (scr_library_trap_overlays — flat code/teaching/remediation triples)
   * that the library trap funnel consults when it assembles a detected
   * trap's structured sink message. Only declared codes appear, in the
   * registry family's order, so the two emissions' data is identical by
   * construction. */
  trapOverlays: IrLibTrapOverlay[];
  /** The ask-2 identity getters (present exactly when the profile
   * declares a sidecar): pure data returns emitted with NO entry
   * prologue — exempt from the poisoned guard and every runtime touch
   * (ratified), so a host can read them before init and after a trap. */
  identity?: IrLibIdentity;
}

/** The profile-declared identity getters' facts, landed on the IR so native
 * archive assembly emits the same constants the sidecar records (V12's
 * identity coherence is one-value-two-writes by construction). */
export interface IrLibIdentity {
  buildIdSymbol: string;
  abiVersionSymbol: string;
  /** The build_id u64 as exactly 16 lowercase hex digits (the sidecar's
   * encoding; backends parse it back to emit the integer constant). */
  buildId: string;
  abiVersion: number;
}

export interface IrClassDef {
  name: string;
  /** Present for a class evaluated inside a function. Each evaluation owns
   * fresh identity and these shared binding boxes; instance layouts carry a
   * private class-object pointer after their source fields. */
  localCaptures?: IrParam[];
  /** Capture holding the evaluated local base constructor, if any. */
  localBaseCapture?: number;
  /** Evaluated module-scope heritage constructor for a factory-produced base. */
  baseValueGlobal?: string;
  /** The JS-observable `.name` of the class (the runtime class object's
   * name string, and what `C.name` folds to). Differs from `name` because
   * IR names are program-qualified (`%m1.C`, `%cx…` for class
   * expressions); jsName follows NamedEvaluation — the declared name, the
   * binding name for `const x = class {}`, or "" for truly anonymous
   * expressions. Absent on the runtime-provided defs (never valuable). */
  jsName?: string;
  /** JavaScript constructor arity, ending before the first default or rest parameter. */
  jsLength?: number;
  /** Zero-argument native helper returning the shared prototype data object.
   * Used when materializing an instance's own-property view. */
  prototypeDataHelper?: string;
  /** Native instance to its actual prototype, including factory captures and subclasses. */
  instancePrototypeHelper?: string;
  /** Public JavaScript fields record their creation in the shared property
   * bag. Its descriptors preserve presence and insertion order independently
   * of native layout order; field values remain in their native slots. */
  tracksOwnFields?: boolean;
  /** Stable module symbol identities for public instance layout fields. */
  symbolFields?: { field: string; globalId: string }[];
  /** RUNTIME-PROVIDED class (the builtin Error hierarchy): the struct, RC
   * helpers, and vtable live in the runtime (ScrError / scr_error_*), so
   * backends emit no definitions for it — only the preorder-interval
   * stamping in main() (the intervals are program-dependent; see
   * RUNTIME_ERROR_CLASSES). User subclasses are ordinary emitted classes
   * whose layout prefix embeds ScrError's fields. */
  runtime?: true;
  /** Base class name (single inheritance, `extends`). A class is IN A
   * HIERARCHY when it has a base or is some class's base; hierarchy classes
   * carry a vtable word after `rc` (backends), standalone classes are laid
   * out exactly as before inheritance existed. */
  base?: string;
  /** ALL fields in layout order: the base chain's fields first — an
   * IDENTICAL prefix, so an upcast is a pointer reinterpret and base-field
   * offsets agree through any static type — then this class's own fields.
   * The validator enforces the prefix property. */
  fields: { name: string; type: IrType }[];
  /** Method names DECLARED on this class (not inherited), in declaration
   * order. Every entry EXCEPT the ones listed in `abstractMethods` has a
   * module function `%<name>.<method>`; the backend derives vtable layout
   * and devirtualization from these plus the base links (a method
   * overridden nowhere keeps direct static calls). Accessors appear as
   * `get:<prop>` / `set:<prop>` entries — names no user identifier can
   * spell — and behave as ordinary methods here. */
  methods?: string[];
  /** Declared `abstract class` — never instantiated (tsc rejects `new` on
   * it, including through class values), so its own vtable entries for
   * abstract slots may stay empty. */
  abstract?: true;
  /** The subset of `methods` declared `abstract` (bodies are type-world):
   * no module function exists for them. They still declare vtable slots —
   * the slot's ABI signature comes from any concrete override (the
   * frontend's override-exactness rule makes every implementation ABI-
   * identical), and tsc guarantees each instantiable class in the
   * declaring subtree implements them. */
  abstractMethods?: string[];
  /** Generic family identity, separate from the concrete layout base.
   * Type arguments specialize storage; JavaScript class identity remains
   * shared by every specialization and its derived instances. */
  genericOf?: string;
  loc: SrcLoc;
}

/** The runtime-provided error classes, keyed by IR class name. The names
 * are '%'-prefixed ('%' cannot appear in a TS identifier, so a user's own
 * `class Error` can never collide). `lib` is the standard-library name the
 * frontend recognizes; `kind` is the runtime's SCR_ERR_* index (backends
 * stamp scr_error_vts[kind] and pick constructor kinds by it). Every
 * emitted module carries the builtin class defs (flagged `runtime`) so the
 * program's preorder numbering always covers them — the runtime's own
 * throws (JSON/dynCheck/regex) mint instances of these classes whether or
 * not user code mentions Error. */
export const RUNTIME_ERROR_CLASSES: ReadonlyMap<
  string,
  { lib: string; kind: number; base: string | null }
> = new Map([
  ["%Error", { lib: "Error", kind: 0, base: null }],
  ["%TypeError", { lib: "TypeError", kind: 1, base: "%Error" }],
  ["%RangeError", { lib: "RangeError", kind: 2, base: "%Error" }],
  ["%SyntaxError", { lib: "SyntaxError", kind: 3, base: "%Error" }],
  // DOMException — the web-standard error shape (a Node global since
  // v17). Its extra state (the legacy numeric code, the options form's
  // cause) lives in runtime-side slots BEYOND the ScrError prefix the IR
  // fields describe, reached only through the error.dom* libCalls — so
  // user `extends DOMException` is fenced (the subclass layout would
  // overlap the hidden slots), while the standard Error classes extend freely.
  ["%DOMException", { lib: "DOMException", kind: 4, base: "%Error" }],
  ["%ReferenceError", { lib: "ReferenceError", kind: 5, base: "%Error" }],
  ["%EvalError", { lib: "EvalError", kind: 6, base: "%Error" }],
  ["%URIError", { lib: "URIError", kind: 7, base: "%Error" }],
]);

/** The runtime-provided node:events EventEmitter class (ScrEmitter /
 * scr_emitter_*, scr_events_emitter.c — link-gated by moduleUsesEmitter,
 * so unlike the error classes its def rides a module only when the
 * program touches the surface). The '%' name keeps it clear of user
 * identifiers, exactly like the error classes. Backends emit no struct/
 * RC/vtable for it; user subclasses embed the ScrEmitter prefix (the
 * registry pointer and the display-name slot, stamped by the emitted
 * allocation) and main() stamps the runtime vtable's preorder interval.
 * The emitter hierarchy is UNCONDITIONALLY cycle-capable: the registry
 * owns listener closures, whatever the subclass fields say. */
export const RUNTIME_EMITTER_CLASS = "%EventEmitter";

/** The runtime-provided node:stream classes (ScrStream / scr_stream_*,
 * scr_stream.c — link-gated by moduleUsesStream). They root at the
 * emitter class (base chains below), so the emitter method surface and
 * upcasts apply unchanged; every instance shares ONE runtime layout (the
 * ScrEmitter prefix plus a lazily-allocated stream-state pointer), so a
 * Duplex upcast to Readable is the usual pointer reinterpret. `sides`
 * names which halves the class carries — the lowering admits readable
 * members on "r"-siders, writable members on "w"-siders. User `extends`
 * compiles (phase 2): subclass structs embed the full ScrStream prefix
 * (registry, display name, state pointer — one slot past the emitter
 * prefix), construction runs the emitted allocation then a stream .init
 * libCall at super(options), and overridden underscore methods bind as
 * synthesized wrapper closures dispatching through the vtable; main()
 * stamps each runtime vtable's preorder interval like the emitter's. */
export const RUNTIME_STREAM_CLASSES: ReadonlyMap<
  string,
  { lib: string; base: string; sides: "r" | "w" | "rw" }
> = new Map([
  ["%Readable", { lib: "Readable", base: RUNTIME_EMITTER_CLASS, sides: "r" }],
  ["%Writable", { lib: "Writable", base: RUNTIME_EMITTER_CLASS, sides: "w" }],
  ["%Duplex", { lib: "Duplex", base: "%Readable", sides: "rw" }],
  ["%Transform", { lib: "Transform", base: "%Duplex", sides: "rw" }],
  ["%PassThrough", { lib: "PassThrough", base: "%Transform", sides: "rw" }],
]);

export interface IrRecordShape {
  /** Frontend-assigned shape id (`r0`, `r1`, ...). */
  id: string;
  /** Sorted by field name (canonical order). Types are never void. */
  fields: { name: string; type: IrType }[];
  /** A TUPLE shape (`[string, number]`): fields are exactly "0".."n-1" —
   * one per position, arity = fields.length. Same struct/RC/trace emission
   * as any record; the flag changes the SURFACE (literal-index access,
   * constant length, JSON as an array with exact-arity validation) and is
   * part of the shape's interned identity, keeping tuples distinct from
   * numeric-keyed object records (which serialize as objects). */
  tuple?: true;
  /** A STRING INDEX SIGNATURE's value type (`{ input?: string;
   * [key: string]: unknown }`, `Record<string, string>`): the shape is a
   * HYBRID — declared fields keep their static struct slots (field access
   * stays a struct read), and undeclared keys live in an OVERFLOW map the
   * struct embeds (string-keyed, insertion-ordered, values uniformly this
   * type). Part of the interned identity: `{a: string}` with and without
   * an index signature are distinct shapes. `unknown` values are `dyn`
   * (the ONE position besides locals/params where dyn rides a container —
   * internal to the shape, reads surface it as an ordinary dyn value);
   * otherwise the supported value kinds mirror map values. Never combined
   * with `tuple`. dynCheck against such a shape CAPTURES undeclared keys
   * into the overflow (width tolerance becomes width capture — see
   * dynCheck), and JSON serialization appends overflow entries after the
   * declared fields in insertion order. */
  indexValue?: IrType;
  /** Field names in FIRST-SEEN declaration order (the checker's property
   * order of the first ts.Type interned to this shape) — metadata, NOT
   * part of the interned identity: a later structurally-equal type with a
   * different member order shares the shape and the first one's order.
   * JSON.stringify, Object.keys/values/entries, record→dyn conversion,
   * and util.inspect all emit this order; JS's per-object insertion order
   * matches it whenever objects are constructed in declaration order
   * (SEMANTICS.md 36 documents the divergence when they are not).
   * Absent on tuples (positional by construction). Names the shape's
   * fields carry that declaredOrder OMITS are internal '%'-fields (Dirent's
   * %dtype) — hidden from every key-order surface, JSON included. */
  declaredOrder?: string[];
}

/** Codec records have private native state, not a structurally checkable
 * data surface. Reserve the same '%' namespace as other internal slots. */
export function recordTextCodecClass(shape: IrRecordShape): "TextEncoder" | "TextDecoder" | null {
  if (shape.fields.some((f) => f.name === "%TextEncoder")) return "TextEncoder";
  if (shape.fields.some((f) => f.name === "%TextDecoder")) return "TextDecoder";
  return null;
}

/** Object-literal ACCESSOR properties (`{ get x() {...}, set x(v) {...} }`)
 * live on the shape as reserved '%'-fields holding closures: `%get:x` a
 * `() => T` invoked once per property READ (side effects and all — JS's
 * evaluation), `%set:x` a `(v: T) => void` invoked per WRITE. The property
 * name itself has NO data slot. Like every '%'-field the slots stay out of
 * declaredOrder — and because the slot types are funcs, accessor-carrying
 * shapes are never JSON-safe or dyn-convertible; the enumeration surfaces
 * Node would answer differently (Object.keys includes accessor names,
 * values/entries and spread invoke the getters) fence by name at their
 * lowerings. */
export function accessorSlotProp(fieldName: string): { kind: "get" | "set"; prop: string } | null {
  if (fieldName.startsWith("%get:")) return { kind: "get", prop: fieldName.slice(5) };
  if (fieldName.startsWith("%set:")) return { kind: "set", prop: fieldName.slice(5) };
  return null;
}

/** True when the shape carries at least one accessor slot (see
 * accessorSlotProp) — the predicate behind every enumeration-surface
 * fence. */
export function shapeHasAccessorSlots(shape: IrRecordShape): boolean {
  return shape.fields.some((f) => accessorSlotProp(f.name) !== null);
}

/** Literal fields that select a record layout at a checked-dynamic boundary.
 * These are part of union identity: equal storage arms can have different
 * discriminator contracts. Several source variants can share one layout. */
export interface IrUnionDiscriminant {
  field: string;
  cases: { tag: number; values: (string | number | boolean)[] }[];
}

export interface IrUnionDef {
  /** Frontend-assigned union id (`u0`, `u1`, ...). */
  id: string;
  /** ≥2 pairwise-distinct arm types in canonical (typeKey-sorted) order;
   * an arm's index here is its runtime tag. Never void/func/union; the
   * unit kinds (undefinedT/nullT) are payload-less arms. */
  arms: IrType[];
  discriminant?: IrUnionDiscriminant;
}

export interface IrFunction {
  /** Original TS name (mangling is a backend concern). Lifted lambdas get
   * synthetic '%'-prefixed names ('%' can't appear in a TS identifier). */
  name: string;
  /** Generated reflection dispatch contains speculative source-member edges.
   * Target-only host operations behind those edges retain runtime refusals. */
  speculativeDispatch?: boolean;
  params: IrParam[];
  returnType: IrType;
  /** All locals including params, pre-collected and scope-flat: ids are
   * unique per function ("x.0", "x.1" for shadowing). The frontend resolves
   * lexical scoping; backends and future SSA both want exactly this. */
  locals: IrLocal[];
  /** Present on lifted functions that capture enclosing bindings: the boxed
   * variables received through the closure environment, in caps[] order.
   * Each is also listed in `locals` (with boxed: true); it is NOT a param. */
  captures?: IrParam[];
  /** Instance methods/constructors of local classes borrow captures through
   * their first (`this`) parameter. The slot indexes the class object's
   * capture array; no closure parameter is added to the method ABI. */
  classCaptures?: (IrParam & { slot: number })[];
  /** Async: the body runs on a fiber; `returnType` is the INNER type T (a
   * `return v` fulfills with v) while ordinary call sites receive
   * Promise<T>. With `generator` present, call sites receive the lazy
   * async-generator object instead. */
  async?: true;
  /** Async module initializers only: a module-global Promise<T> slot where
   * the spawn wrapper caches its first evaluation promise. Every later
   * static/dynamic import receives that same promise, including while the
   * first evaluation is suspended. */
  asyncCacheGlobal?: string;
  /** Async cyclic module initializers only: the SCC's shared Promise<T>
   * slot. Eager recursive spawning writes member promises from the inside
   * out, so the member that actually initiated evaluation writes last and
   * becomes the runtime cycle root. Dynamic imports wait on this shared
   * completion verdict instead of a build-time-selected member. */
  asyncCycleCacheGlobal?: string;
  /** Generator (`function*` / `async function*`): the body runs on a fiber created SUSPENDED
   * (nothing runs until the first `.next()`); `returnType` is the
   * generator's TReturn (VOID when it carries no value — `return;`
   * completes with the undefined arm) while call sites receive the
   * generator type `{ async?, yieldT, retT: returnType, nextT }` from an emitted
   * spawn wrapper that only allocates. `yieldT` is what `yield e` sends
   * out, `nextT` what `.next(v)` sends in (the yield expression's result
   * type). `async` alongside this field marks an async generator: its
   * resume methods queue requests and return promises. */
  generator?: { yieldT: IrType; nextT: IrType; resultType: IrType & { kind: "record" } };
  /** Source function name for native error stack frames. */
  sourceName?: string;
  /** Ordinary authored function declarations/expressions own a prototype. */
  ownsPrototype?: true;
  body: IrStmt[];
  loc: SrcLoc;
}

export interface IrParam {
  localId: string;
  name: string;
  type: IrType;
}

export interface IrGlobal {
  /** "%g.<qualifier>.<name>" — distinct namespace from local ids. */
  id: string;
  name: string;
  type: IrType;
  mutable: boolean;
  /** Lexical record/function/checked-value bindings use their initially-null
   * pointer as a TDZ sentinel. Reads and later writes throw until initializing assign. */
  tdz?: true;
  /** Original declaration and lexical scope, when this is a source binding. */
  source?: IrBindingSource;
}

export interface IrBindingSource {
  loc: SrcLoc;
  scope: SrcLoc;
}

export interface IrLocal {
  id: string;
  name: string;
  type: IrType;
  mutable: boolean;
  /** Absent for compiler temporaries and hidden ABI parameters. */
  source?: IrBindingSource;
  /** Captured by a nested function: the variable lives in a refcounted box
   * (a shared binding — mutations are visible through every capture). All
   * access, including in the declaring function, goes through the box. */
  boxed?: true;
  /** A forward-captured lexical binding (a function declared BEFORE the binding it
   * captures): the box is allocated TDZ-empty at scope entry (a `varDecl`
   * with `init: null`) so earlier closures can capture it, and the source
   * declaration initializes it via `assign` with `initializes: true`.
   * Every read and non-initializing write tests the box —
   * empty throws JS's catchable ReferenceError ("Cannot access 'name'
   * before initialization"), exactly Node's temporal dead zone. Always
   * paired with `boxed`; scalar payloads use a one-element array cell so
   * the NULL slot remains the TDZ sentinel. Capture entries inherit the flag. */
  tdz?: true;
}

/* ── statements ────────────────────────────────────────────────────────── */

export type IrStmt =
  /** First initialization of a local at its source position. `init: null`
   * means "declared, uninitialized" (`let x: number;`) — the local must be
   * `mutable`. SOUNDNESS: tsc strict-mode definite-assignment analysis
   * (TS2454 "used before being assigned") rejects any READ before an
   * assignment on every path, so backends never need a runtime
   * initialized-check; refcounted locals simply stay NULL until the first
   * `assign`. */
  | { kind: "varDecl"; localId: string; init: IrExpr | null; loc: SrcLoc }
  /** `initializes` marks a TDZ binding's declaration, whose store may
   * initialize an empty box. Ordinary assignments must check it first. */
  | { kind: "assign"; localId: string; value: IrExpr; initializes?: true; loc: SrcLoc }
  | { kind: "exprStmt"; expr: IrExpr; loc: SrcLoc }
  | { kind: "if"; cond: IrExpr; then: IrStmt[]; else_: IrStmt[] | null; loc: SrcLoc }
  /** `labels` (here and on doWhile/for/forOf/switch/block): the JS label
   * names of the enclosing `lbl:` statements, outermost first — the targets
   * a labeled `break lbl`/`continue lbl` names. A statement without labels
   * omits the field. The frontend attaches labels only to constructs a
   * labeled jump can bind to (loops, switch, and the block wrapper it puts
   * around every other labeled statement form); label RESOLUTION is done by
   * matching a jump's `label` against the innermost enclosing statement
   * whose `labels` contains it (names are unique per nesting chain — tsc
   * rejects duplicate labels). */
  | { kind: "while"; cond: IrExpr; body: IrStmt[]; labels?: string[]; loc: SrcLoc }
  /** `do { body } while (cond)`: body executes at least once; the condition
   * (bool-typed, truthiness pre-wrapped like while) evaluates after each
   * pass. `continue` jumps to the CONDITION, not the top of the body. */
  | { kind: "doWhile"; body: IrStmt[]; cond: IrExpr; labels?: string[]; loc: SrcLoc }
  /** JS-exact switch. The discriminant evaluates exactly once; case `test`
   * expressions evaluate lazily IN SOURCE ORDER (a test after the matching
   * one never evaluates), compared against the discriminant with strict
   * equality (f64/bool: `===`; string: content equality). `test: null` is
   * the default clause — it may appear in any position: it is entered only
   * after every test misses, but execution FALLS THROUGH case bodies in
   * source order (default's included) until a `break` or the end. The whole
   * case-body sequence is ONE lexical scope (a `let` in one case is visible
   * in later cases). `break` inside binds to the switch; `continue` binds to
   * the enclosing loop. Discriminant and tests share one IR kind:
   * f64, string, or bool. */
  | {
      kind: "switch";
      disc: IrExpr;
      cases: { test: IrExpr | null; body: IrStmt[] }[];
      labels?: string[];
      loc: SrcLoc;
    }
  | {
      kind: "for";
      init: IrStmt | null; // varDecl or assign
      cond: IrExpr | null;
      update: IrStmt | null; // assign or exprStmt
      body: IrStmt[];
      labels?: string[];
      loc: SrcLoc;
    }
  /** Element write `a[i] = v` — statement-only, like `assign`. Valid indices
   * are canonical array indices; writes beyond length grow the array and
   * leave the intervening positions as holes. Ownership of a refcounted value
   * MOVES into the array; the replaced element is released. */
  | { kind: "arraySet"; arr: IrExpr; index: IrExpr; value: IrExpr; loc: SrcLoc }
  /** Writable `a.length = n`: growth creates holes and truncation releases
   * removed reference elements. Invalid array lengths raise a catchable
   * RangeError from the runtime. */
  | { kind: "arraySetLength"; arr: IrExpr; length: IrExpr; loc: SrcLoc }
  /** Write an explicit present `undefined` state without shrinking length. */
  | { kind: "arraySetUndefined"; arr: IrExpr; index: IrExpr; loc: SrcLoc }
  /** Delete an indexed/property slot without changing Array.length. */
  | { kind: "arrayDelete"; arr: IrExpr; index: IrExpr; loc: SrcLoc }
  /** Typed-array element write `b[i] = v` — arraySet's sibling for bytes
   * receivers: statement-only, receiver and index like bytesIntrinsic
   * `get` (any invalid index TRAPS — JS would ignore the write, a
   * documented divergence), value an f64 coerced per the element kind
   * (ToUint8/ToUint32 modular truncation, double→float rounding). Unlike
   * arraySet there is NO append at i == len: typed arrays are
   * fixed-length. */
  | { kind: "bytesSet"; arr: IrExpr; index: IrExpr; value: IrExpr; loc: SrcLoc }
  /** `for (const x of arr)`: iterates by ascending index, re-reading the
   * length each iteration (JS-exact for arrays). `localId` is a fresh const
   * binding per iteration holding the element (for refcounted elements: an
   * owned +1 reference, released when the iteration's scope exits). */
  | {
      kind: "forOf";
      localId: string;
      iterable: IrExpr;
      body: IrStmt[];
      labels?: string[];
      loc: SrcLoc;
    }
  | { kind: "return"; value: IrExpr | null; loc: SrcLoc }
  /** Field write `obj.f = v` — statement-only, like `assign`/`arraySet`.
   * Evaluation order: obj, then value. The old value is released; ownership
   * of a refcounted new value MOVES into the object. */
  | { kind: "fieldSet"; obj: IrExpr; className: string; field: string; value: IrExpr; loc: SrcLoc }
  /** Record field write `r.f = v` — mirrors `fieldSet` exactly (evaluation
   * order obj then value; old value released; refcounted new value moved
   * in), with a shape id in place of a class name. */
  | { kind: "recordSet"; obj: IrExpr; shapeId: string; field: string; value: IrExpr; loc: SrcLoc }
  /** Dynamic-keyed record write `r[k] = v` — index-signature shapes only.
   * `value` has the index signature's value type (dyn included). Declared
   * keys write THROUGH to the struct slot: a dyn value validates against
   * the field's type first (the dynCheck walker — a mismatched write
   * throws the catchable TypeError instead of corrupting the slot; JS
   * would store anything, a documented divergence), non-dyn values store
   * directly (their type equals the field's by the index-signature
   * consistency rule). Undeclared keys insert/replace in the overflow map
   * (insertion order preserved, exactly Map). Evaluation order: obj, key,
   * value. Ownership of a refcounted value MOVES in; replaced values are
   * released. MAY THROW when the shape has dyn-valued declared fields to
   * validate (the emitted helper is in the may-throw seed set then).
   * `overflowOnly` (a LITERAL key naming no declared field): a pure
   * overflow insert — no declared collision exists, so no validation, no
   * throw, and declared fields need not take the index-value type. */
  | {
      kind: "recordKeySet";
      obj: IrExpr;
      shapeId: string;
      key: IrExpr;
      value: IrExpr;
      overflowOnly?: true;
      loc: SrcLoc;
    }
  /** Statement-position `delete obj[k]` on a PURE index-signature shape
   * (no declared fields — the frontend fences hybrids: a struct slot
   * cannot be removed): drop the overflow entry, releasing its key and
   * value — exactly a Map delete, insertion order of survivors kept.
   * Deleting an absent key is a no-op, like JS. Evaluation order: obj,
   * key; both borrowed. Never throws. */
  | { kind: "recordKeyDelete"; obj: IrExpr; shapeId: string; key: IrExpr; loc: SrcLoc }
  /** Unlabeled: `break` binds to the innermost enclosing loop OR switch
   * (labeled BLOCK targets are skipped); `continue` to the innermost
   * enclosing loop, skipping any switches in between (validated). With
   * `label`: the jump binds to the innermost enclosing statement whose
   * `labels` contains it — any labeled loop/switch/block for `break`, a
   * labeled loop for `continue` (`continue` re-enters at the loop's own
   * continue point: the condition for while/doWhile, the update for
   * for/forOf). The frontend guarantees the label resolves (tsc validates
   * label targets); the validator re-checks. */
  | { kind: "break"; label?: string; loc: SrcLoc }
  | { kind: "continue"; label?: string; loc: SrcLoc }
  /** A bare lexical block `{ ... }` — its own scope. `labels` makes it a
   * labeled-break target (`lbl: { ... break lbl; ... }` and the wrapper
   * the frontend puts around labeled non-loop statements). */
  | { kind: "block"; body: IrStmt[]; labels?: string[]; loc: SrcLoc }
  /** `throw v`. Any non-void value type can be thrown; ownership of a
   * refcounted value MOVES into the runtime's exception cell. Terminates
   * the path like `return`: control unwinds to the innermost enclosing
   * tryCatch handler, or out of the function (backends release the frames
   * and scopes the unwind exits — exactly the release-on-jump discipline). */
  | { kind: "throw"; value: IrExpr; loc: SrcLoc }
  /** A DEFERRED compile fence (JavaScript sources only): the statement's
   * construct has no static lowering, and JS carries no annotations to
   * change that — so the fence fires when the statement RUNS instead of
   * failing the build (the JS-input design: inference gaps land where
   * `any` lands — honest fences, never silent misbehavior). Executing it
   * throws a catchable Error whose message names the construct and whose
   * `code` carries the SC diagnostic code; unwinds exactly like `throw`.
   * TypeScript sources produce it only as the tsc-unreachable fallthrough
   * trap (appendImplicitUndefinedReturn's SC9002) — their construct fences
   * stay compile errors. */
  | { kind: "runtimeFence"; code: string; message: string; loc: SrcLoc }
  /** Rethrow of a catch binding (`throw e` where e is the binding):
   * re-raises the SAVED exception exactly — kind and payload preserved,
   * payload retained (the binding stays live until its scope exits).
   * Terminates the path like `throw`. */
  | { kind: "rethrow"; localId: string; loc: SrcLoc }
  /** `try { } catch (e)? { } finally { }`. At least one of
   * catchBody/finallyBody is present. `catchBody` runs iff the try body
   * raised; entering it TAKES the exception (the pending flag clears).
   * With `catchLocalId` null (bindingless `catch { }`) the payload is
   * discarded; with a binding, the payload MOVES into a fresh caught
   * snapshot box bound to that local (declared in `locals` with the
   * `caught` type), scoped to the catch body. `finallyBody` runs on normal
   * completion AND on the exception path (after catch, or with the
   * exception still pending when there is no catch — it keeps propagating
   * after the finally completes; a throw inside the finally replaces it).
   * Every abrupt completion crossing the region runs the finally
   * inner-to-outer. Return values are snapshotted first; break/continue
   * retain their resolved targets; and a completion raised inside the
   * finally replaces the pending one. Each body is its own lexical scope. */
  | {
      kind: "tryCatch";
      tryBody: IrStmt[];
      catchBody: IrStmt[] | null;
      catchLocalId: string | null;
      finallyBody: IrStmt[] | null;
      /** Resource-management cleanup: if the guarded body and cleanup both
       * throw, raise a SuppressedError instead of replacing the first error. */
      suppressFinallyErrors?: true;
      loc: SrcLoc;
    };

/* ── expressions ───────────────────────────────────────────────────────── */

/** The complete array method/property surface (mirrors ambient/scriptc.d.ts).
 * `map`/`filter`/`forEach` are NOT here: the frontend desugars them to
 * synthetic loop functions over existing nodes (see docs/ir.md). */
/** `slice` is JS-exact shallow copy (ToIntegerOrInfinity indices, negatives
 * from the end, clamping; omitted args omitted from `args` — backends fill
 * 0 / +Infinity, the strIntrinsic convention); ref elements retain into
 * the fresh array. */
export type IrArrIntrinsicMethod =
  /** Default String ordering for f64/bool/string payloads; no user callbacks. */
  | "sortPrimitive"
  | "toSortedPrimitive"
  | "length"
  /** Internal ToNumber(a[index]) for f64-backed arrays: one numeric index,
   * returning the stored number or NaN for a hole/undefined/missing key.
   * Borrows the receiver and never traps on missing values. */
  | "getNumber"
  /** Internal strict equality of two f64/bool/string array slots. Arguments
   * are [left index, right array, right index]; holes and present undefined
   * compare as undefined. Both arrays have the same primitive element type. */
  | "indexEq"
  | "push"
  | "pushSpread"
  | "concatSpread"
  | "unshift"
  | "unshiftSpread"
  | "pop"
  | "indexOf"
  | "includes"
  /** Internal sparse traversal: the first present index at/after start,
   * or length when the remaining positions are holes. */
  | "nextPresent"
  | "join"
  | "slice"
  | "shift"
  | "splice"
  /** One dense copy pass, or one level of flattening into an empty typed
   * result array. The supplied result is borrowed and returned retained. */
  | "flatCopy"
  | "flatOne"
  /** Mutating splice with evaluated insertion items; returns removed slots. */
  | "spliceInsert"
  | "reverse"
  /** Evaluated numeric bounds; same-type fill values stay borrowed. */
  | "copyWithin"
  | "fill"
  | "fillUndefined"
  /** ES2023 copying methods. `toSpliced` receives [start, deleteCount,
   * itemsArray], with omitted arguments completed by the frontend;
   * `with` receives [index, value] and throws Node's catchable RangeError
   * when the relative index is out of range. */
  | "toReversed"
  | "toSpliced"
  /** `.with()` replacement carrying present undefined while retaining the
   * scalar array payload ABI; it has the same catchable index validation as
   * the typed replacement forms. */
  | "withUndefined"
  | "with";

/** Array intrinsics whose runtime implementation can raise a catchable
 * exception (rather than the static tier's deliberate index traps). */
export const MAY_THROW_ARR_METHODS: ReadonlySet<IrArrIntrinsicMethod> = new Set([
  "with",
  "withUndefined",
]);

/** The Map method/property surface (mirrors ambient/scriptc.d.ts) plus the
 * iteration primitives behind the forEach desugar. `forEach` itself is NOT
 * here — like array map/filter/forEach it desugars in the frontend to a
 * synthetic loop function whose body walks the dense entries array with
 * `iterCount`/`iterLive`/`iterKey`/`iterValue` (indices stay stable under
 * callback mutation because the runtime never compacts between
 * `iterEnter`/`iterExit` — live-iteration semantics, Node-exact). The iter*
 * members are compiler-internal: no ambient declaration reaches them. */
export type IrMapIntrinsicMethod =
  /** Internal shallow-copy constructors over builtin collection storage. */
  | "clone"
  | "keySet"
  | "valueSet"
  | "get"
  | "set"
  | "has"
  | "delete"
  | "size"
  | "clear"
  | "iterCount"
  | "iterLive"
  | "iterKey"
  | "iterValue"
  | "iterEnter"
  | "iterExit";

/** The Set method/property surface — Map's minus get/set/iterValue (there
 * is no value slot; `add` fills set's role) plus `add`. `forEach` desugars
 * in the frontend exactly like Map's, over the same iteration primitives —
 * iterKey doubles as the element read (JS's Set forEach passes the element
 * as both `value` and `key`). */
export type IrSetIntrinsicMethod =
  | "clone"
  | "add"
  | "has"
  | "delete"
  | "size"
  | "clear"
  | "iterCount"
  | "iterLive"
  | "iterKey"
  | "iterEnter"
  | "iterExit"
  /** `[...set]` and friends: drain the live entries into a FRESH elem[]
   * in insertion order (tombstones skipped — the same walk the forEach
   * desugar does, folded into one runtime call; no user code runs during
   * the drain, so live-iteration rules are moot). Receiver borrowed;
   * the array is owned (+1), string elements retained into it. */
  | "toArray";

/** The complete string method/property surface (mirrors ambient/scriptc.d.ts).
 * toLowerCase/toUpperCase are the one lre-backed pair (ECMA Default Case
 * Conversion via libunicode's tables — scr_regex.c): their presence sets
 * the regex LINK flag like a regex literal does (moduleUsesRegex).
 * `split` is the STRING-separator form (regex separators are
 * regexIntrinsic): args[0] is the separator and args[1] the numeric limit
 * (an omitted source limit is completed to 2^32-1), result a fresh +1
 * string[] — the empty separator splits per UTF-16 code unit (astral
 * halves become U+FFFD, divergence 2). `padStart`/`padEnd` take (target
 * length, fill) — the frontend completes an omitted fill to " ", Node's
 * default. `trimStart`/`trimEnd` are trim's one-sided halves. */
export type IrStrIntrinsicMethod =
  | "length"
  | "charCodeAt"
  | "charAt"
  | "indexOf"
  | "includes"
  | "startsWith"
  | "endsWith"
  | "slice"
  | "substring"
  | "repeat"
  | "trim"
  | "trimStart"
  | "trimEnd"
  | "split"
  | "padStart"
  | "padEnd"
  | "toLowerCase"
  | "toUpperCase"
  | "normalize"
  // isWellFormed()/toWellFormed() — no-ops over the runtime's well-formed
  // storage (lone surrogates became U+FFFD at their producers): constant
  // true and the identity, per spec on well-formed input.
  | "isWellFormed"
  | "toWellFormed"
  // The string iterator's step: the full code-POINT character at a UTF-16
  // index (astral chars come back whole where charAt truncates) — for-of
  // over strings desugars onto it, advancing by the result's length.
  | "cpAt";

/** The typed-array/Buffer method surface (bytesIntrinsic). Receiver/arg
 * conventions (validated): `length`/`byteLength` are property reads → f64;
 * `get` takes one f64 index → f64 (trap on any invalid index, like
 * arrayGet — the write side is the bytesSet STATEMENT); `slice` takes
 * 0–2 f64 relative indices (omitted args are OMITTED from `args`, like
 * strIntrinsic — backends fill start 0 / end +Infinity) → a fresh
 * same-elem bytes COPY; `subarray` takes the same 0–2 f64 relative
 * indices → a same-elem VIEW aliasing the receiver's storage (JS's
 * TypedArray.prototype.subarray; Buffer's slice(), subarray's deprecated
 * Node alias, lowers here too — only plain typed arrays' slice copies);
 * `setFrom` (`dst.set(src, offset?)`) takes a
 * same-elem bytes src and an optional f64 offset (omitted = 0) → void,
 * THROWS Node's RangeError on overflow (may-throw seed); `toString` takes
 * one canonical literal encoding arg (the frontend completes omitted or
 * undefined to "utf8"; u8 receivers only) → owned +1 string, never
 * throws; `toStringVar` has the same signature for runtime-valued
 * BufferEncoding arguments, normalizes aliases/case, and throws
 * ERR_UNKNOWN_ENCODING for an invalid cast; the numeric families (u8
 * receivers only) carry their KIND as args[0], always a strLit the
 * backend maps to the runtime's tag: `readNum` [kind, offset] /
 * `writeNum` [kind, value, offset] cover the fixed widths (kind "u8",
 * "i8", then "u16be"/"u16le"-style width+endian tokens through "f64le");
 * `readNumVar` [kind, offset, byteLength] / `writeNumVar` [kind, value,
 * offset, byteLength] are the variable-width read/writeUIntLE family
 * (kind "ube"/"ule"/"ibe"/"ile"). All four THROW Node's RangeErrors on
 * bad values/offsets/byteLengths (may-throw seeds); writes return
 * offset + width. Receivers and args are BORROWED; refcounted
 * results are owned (+1).
 *
 * The DataView surface rides the same node (DataView maps to bytes<u8> —
 * at runtime a borrowed VIEW aliasing its owner's storage, so no aliasing
 * divergence exists): `byteOffset` is a property read → f64 (0 for owners,
 * the view's offset for a DataView); `dataViewNew` (`new
 * DataView(x.buffer, byteOffset?, byteLength?)`) takes the BYTES value x
 * as the receiver (the frontend peels the syntactic `.buffer`) and 0–2
 * f64 args (omitted args OMITTED, like slice) → a fresh bytes<u8> view
 * retaining x's owner, THROWS Node's RangeErrors on bad indices; the
 * `dvGet*` getters take one f64 byte offset plus, on the multi-byte kinds,
 * an optional bool littleEndian (omitted = big-endian, the JS default) →
 * f64, THROWING Node's constant "Offset is outside the bounds of the
 * DataView" RangeError on any bad offset. `dvGetBigUint64Number`/
 * `dvGetBigInt64Number` are the COMPOSED `Number(view.getBigUint64(...))`
 * lowerings — the bare bigint-returning calls are fenced, the wrapped
 * form converts the 8-byte integer to double exactly as Number(bigint).
 * The `dvSet*` setters mirror the getters: [offset, value] plus the
 * optional bool littleEndian on the multi-byte kinds → void, the same
 * constant RangeError on any bad offset; values coerce JS-exactly
 * (integer kinds by modular truncation, Float32 by double→float
 * rounding). No BIG setters exist — bigint arguments never lower. */
export type IrBytesIntrinsicMethod =
  | "buffer"
  | "length"
  | "byteLength"
  | "get"
  | "slice"
  | "subarray"
  /** In-place overlapping copy, [target, start, end] relative indices;
   * returns the receiver (+1). */
  | "copyWithin"
  /** Fresh Uint8Array copying methods. `with` takes [index, value] and
   * throws a catchable RangeError for an invalid relative index. */
  | "toReversed"
  | "with"
  /** Uint8Array.prototype.join(separator), with the omitted separator
   * completed to "," by the frontend. */
  | "join"
  /** Drain numeric typed-array elements into a fresh number[]. Used by
   * array spread and typed-array destructuring rest. */
  | "toArray"
  | "setFrom"
  | "setFromDyn"
  | "toString"
  /** Buffer.toString with a runtime-valued encoding. Same signature as
   * toString, but canonicalizes aliases/case and may throw
   * ERR_UNKNOWN_ENCODING. */
  | "toStringVar"
  | "readNum"
  | "writeNum"
  | "readNumVar"
  | "writeNumVar"
  /** The comparison/search/mutation surface (u8 receivers only; see the
   * runtime contract): `equals` [bytes] → bool (never throws);
   * `compareBuf` [bytes, 0-4 f64 index args — omitted args OMITTED,
   * Node skips their validation] → f64, THROWS; `indexOf`/`lastIndexOf`
   * [bytes needle, f64 align (2 = utf16le's even-offset stride), f64
   * byteOffset?] → f64 and `includes` → bool, never throw (byteOffset
   * coerces; omitted = Node's search-everything default); the *Num
   * flavors take [f64 value, f64 byteOffset?] (the value wraps & 0xFF);
   * `fill` [bytes pattern, 0-2 f64s] / `fillNum`
   * [f64, 0-2 f64s] / `fillStr` [string, strLit enc, 0-2 f64s] → the
   * RECEIVER (+1, chaining), THROW; `copy` [bytes target, 0-3 f64s] →
   * f64 copied count, THROWS; `swap16/32/64` [] → the receiver (+1,
   * in-place), THROW; `writeStr` [string, strLit enc, f64 offset, f64
   * length?] → f64 bytes written, THROWS. */
  | "equals"
  | "compareBuf"
  | "indexOf"
  | "lastIndexOf"
  | "includes"
  | "indexOfNum"
  | "lastIndexOfNum"
  | "includesNum"
  | "fill"
  | "fillNum"
  | "fillStr"
  /** TypedArray.prototype.fill on NON-u8 receivers: [f64 value, 0-2 f64
   * relative indices] → the RECEIVER (+1, chaining); the value coerces
   * per element kind (the scr_bytes_set discipline), indices clamp like
   * slice, never throws. u8 receivers keep the Buffer fill family above
   * (same observable number-fill result; Buffer's throwing offset
   * validation). */
  | "fillElem"
  | "copy"
  | "swap16"
  | "swap32"
  | "swap64"
  | "writeStr"
  | "byteOffset"
  | "dataViewNew"
  | "dvGetUint8"
  | "dvGetInt8"
  | "dvGetUint16"
  | "dvGetInt16"
  | "dvGetUint32"
  | "dvGetInt32"
  | "dvGetFloat32"
  | "dvGetFloat64"
  | "dvGetBigUint64Number"
  | "dvGetBigInt64Number"
  | "dvSetUint8"
  | "dvSetInt8"
  | "dvSetUint16"
  | "dvSetInt16"
  | "dvSetUint32"
  | "dvSetInt32"
  | "dvSetFloat32"
  | "dvSetFloat64";

/** The bytesIntrinsic methods that can raise a catchable error — backends'
 * may-throw analyses seed on these exactly like MAY_THROW_LIB_FNS. */
export const MAY_THROW_BYTES_METHODS: ReadonlySet<IrBytesIntrinsicMethod> = new Set([
  "toStringVar",
  "with",
  "setFrom",
  "setFromDyn",
  "readNum",
  "writeNum",
  "readNumVar",
  "writeNumVar",
  "compareBuf",
  "fill",
  "fillNum",
  "fillStr",
  "copy",
  "swap16",
  "swap32",
  "swap64",
  "writeStr",
  "dataViewNew",
  "dvGetUint8",
  "dvGetInt8",
  "dvGetUint16",
  "dvGetInt16",
  "dvGetUint32",
  "dvGetInt32",
  "dvGetFloat32",
  "dvGetFloat64",
  "dvGetBigUint64Number",
  "dvGetBigInt64Number",
  "dvSetUint8",
  "dvSetInt8",
  "dvSetUint16",
  "dvSetInt16",
  "dvSetUint32",
  "dvSetInt32",
  "dvSetFloat32",
  "dvSetFloat64",
]);

/** The regex operation surface. Receiver/arg conventions (validated):
 * `test` takes a regex receiver and one string arg (bool result); `source`
 * and `flags` are property reads on a regex receiver (owned string result);
 * `replace`/`replaceAll`/`split` take a STRING receiver with args[0] the
 * regex and (for the replaces) args[1] the replacement template — string
 * replacements only, function replacements are checker-rejected (the
 * ambient overloads accept only strings). `replaceAll` THROWS Node's
 * TypeError when the regex lacks /g. For `split`, args[1] is the numeric
 * limit (an omitted source limit is completed to 2^32-1); it THROWS on a pattern with
 * capture groups (JS would splice the captured values into the result) —
 * both catchable: backends' may-throw analyses must seed on these two
 * methods like a `throw`. */
/** `match` takes a STRING receiver with args[0] the regex and produces
 * the PROGRAM-DEPENDENT `string[] | null` union: all whole matches for a
 * global regex, otherwise [whole, ...captures], or null for no match. A
 * NONPARTICIPATING capture holds "" where Node's slot is undefined
 * (SEMANTICS.md divergence). Never throws. */
export type IrRegexIntrinsicMethod =
  | "test"
  | "match"
  /** exec uses the same string-first operands but keeps the g/y
   * lastIndex refusal, independently of global String.match iteration. */
  | "exec"
  | "lastIndex"
  /** `s.matchAll(re)` — every match as its honest string[] slice (match's
   * rule), drained EAGERLY into a fresh string[][]: the lazy iterator is
   * unobservable across the lowered surface (strings are immutable; the
   * spec clones the regex at the call, so lastIndex games can't reach the
   * drain either). Non-global regexes THROW Node's exact TypeError
   * (catchable — replaceAll's stance). */
  | "matchAll"
  /** matchAll's companion-index form (the for-of-over-matchAll desugar):
   * args[1] is a number[] the drain ALSO fills with each match's UTF-16
   * start index — the row's `.index`, always present (every drained row
   * matched). Same result and throw contract as matchAll. */
  | "matchAllInto"
  /** `s.search(re)` — the first match's UTF-16 index, or -1. Symbol.search
   * neither reads nor writes lastIndex (a fresh exec from position 0), so
   * no g/y fence applies: /g is irrelevant and /y anchors at 0 — exactly
   * Node. Never throws. */
  | "search"
  | "source"
  | "flags"
  | "toString"
  | "replace"
  | "replaceAll"
  | "split";

/** Numeric binary ops. The bitwise six (`&`/`|`/`^`/`<<`/`>>`/`>>>`) have
 * JS ToInt32/ToUint32 semantics — operands convert (NaN/±Infinity → 0,
 * truncate, wrap mod 2^32), the operation runs in 32-bit space (shift
 * counts mask to 5 bits), and the result returns to f64 (`>>>` as Uint32,
 * the rest as Int32) — backends emit the scr_bit_* runtime helpers. */
export type IrNumBinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "&"
  | "|"
  | "^"
  | "<<"
  | ">>"
  | ">>>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "==="
  | "!==";
export type IrStrCmpOp = "<" | "<=" | ">" | ">=";

export type IrExpr =
  /** `spelling` (ask 4's representability input) is the author's SOURCE
   * spelling of a decimal integer literal, present exactly when that
   * spelling does not round-trip f64 (`9007199254740993` reads back as
   * 9007199254740992) — the library integer-boundary check refuses on the
   * spelling, never on the already-rounded value. Round-tripping literals
   * and non-integer spellings carry nothing, so the IR is byte-identical
   * for every program that held its numbers. */
  | { kind: "numLit"; value: number; spelling?: string; type: IrType; loc: SrcLoc }
  | { kind: "strLit"; value: string; type: IrType; loc: SrcLoc }
  /** The singleton namespace token for one compiled or builtin module. */
  | { kind: "moduleNsRef"; moduleId: string; type: IrType; loc: SrcLoc }
  | { kind: "boolLit"; value: boolean; type: IrType; loc: SrcLoc }
  /** An `undefined` or `null` literal; `type` is the matching unit kind.
   * Valid ONLY as the immediate value of a `unionWrap` (the frontend's slot
   * coercion wraps it with the unit arm's tag) — unit types have no
   * standalone runtime value, so a bare unitLit anywhere else is a
   * validator error and an emitter bug. */
  | { kind: "unitLit"; unit: "undefined" | "null"; type: IrType; loc: SrcLoc }
  | { kind: "varRef"; localId: string; type: IrType; loc: SrcLoc }
  /** Numeric operands; comparisons yield bool. `===`/`!==` additionally
   * accept two same-typed arrays: reference identity (pointer compare),
   * matching JS object equality — and two same-typed CLASS VALUES, where
   * the pointer compare IS class identity. */
  | { kind: "bin"; op: IrNumBinOp; left: IrExpr; right: IrExpr; type: IrType; loc: SrcLoc }
  /** `~` is JS bitwise NOT: ToInt32 the operand, complement, back to f64. */
  | { kind: "unary"; op: "-" | "!" | "~"; operand: IrExpr; type: IrType; loc: SrcLoc }
  /** `x++` / `x--` / `++x` / `--x` in EXPRESSION position over an f64 local
   * or module global: reads the binding, writes the binding ±1, and yields
   * the OLD value (postfix, prefix=false) or the NEW value (prefix=true) —
   * JS-exact for typed-number receivers (no ToNumber coercion can be
   * observed). Statement-position ++/-- keeps its historic `assign`
   * desugar; this node exists for value positions (`arr[i++]`, `{ index:
   * jobIndex++ }`). Type is always f64. */
  | { kind: "incDec"; op: "+" | "-"; prefix: boolean; localId: string; type: IrType; loc: SrcLoc }
  /** `--obj.f` / `obj.f++` in EXPRESSION position over a CLASS field: one
   * receiver evaluation, read-modify-write of the field, yielding the OLD
   * (postfix) or NEW (prefix) value — countdown.js's `if (--this.limit ===
   * 0)`. f64 fields compute in place (JS-exact); fieldDyn marks a
   * CHECKED-DYNAMIC field (a JS implicit-any ctor assignment): the number
   * validates OUT of the box (dynCheck's catchable TypeError on
   * non-numbers — the documented dyn arithmetic stance, never a silent
   * ToNumber), computes, and boxes back into the slot (old box released
   * after the unlink, like fieldSet). Type is always f64. */
  | {
      kind: "fieldIncDec";
      op: "+" | "-";
      prefix: boolean;
      obj: IrExpr;
      className: string;
      field: string;
      fieldDyn: boolean;
      type: IrType;
      loc: SrcLoc;
    }
  /** `x = e` in EXPRESSION position over a local or module global: evaluates
   * `value` once, writes the binding, and yields the assigned value — JS
   * evaluation order (`while ((idx = s.indexOf("\n")) !== -1)`). The type is
   * the binding's type (the frontend coerces the RHS into it, exactly like
   * statement-position `assign`). Statement position keeps the `assign`
   * statement; this node exists for value positions. */
  | { kind: "assignExpr"; localId: string; value: IrExpr; type: IrType; loc: SrcLoc }
  /** JS ToBoolean: f64 is false iff 0, -0, or NaN; string is false iff empty;
   * dyn asks its runtime kind. The other operand form is a UNION — the ARM
   * value's ToBoolean via a per-union interned helper (unit arms false;
   * f64/string/bool arms per-value; ref arms — arrays, records, objects,
   * functions, maps, sets, promises, ... — always true; jsval arms ask the
   * engine). Result is bool. */
  | { kind: "toBool"; operand: IrExpr; type: IrType; loc: SrcLoc }
  /** Distinct from `bin`: short-circuits, and has JS value semantics — the
   * result is the deciding operand itself (`a && b` ≡ `toBool(a) ? b : a`),
   * not a bool. Operands and result share one kind: f64, string, bool, or
   * one UNION type (the deciding test is the union's per-arm ToBoolean; the
   * frontend pre-coerces plain arm operands into the union, so both sides
   * arrive union-typed). */
  | { kind: "logical"; op: "&&" | "||"; left: IrExpr; right: IrExpr; type: IrType; loc: SrcLoc }
  | { kind: "strConcat"; left: IrExpr; right: IrExpr; type: IrType; loc: SrcLoc }
  | { kind: "strEq"; negated: boolean; left: IrExpr; right: IrExpr; type: IrType; loc: SrcLoc }
  /** String ordering. Ordinary source comparisons omit `utf16` and retain
   * scriptc's documented code-point order; the default Array sort comparator
   * sets it to request ECMAScript's UTF-16 code-unit order. */
  | {
      kind: "strCmp";
      op: IrStrCmpOp;
      left: IrExpr;
      right: IrExpr;
      utf16?: boolean;
      type: IrType;
      loc: SrcLoc;
    }
  /** f64|bool → string, JS-exact (Number::toString / "true"/"false").
   * Union operands dispatch through the per-union ToString helper (arms
   * fenced to unit/string/f64/bool by the frontend); a CAUGHT operand is
   * `String(e)` over the exception snapshot (scr_caught_to_string). */
  | { kind: "toString"; operand: IrExpr; type: IrType; loc: SrcLoc }
  /** Lazily-branched conditional: exactly one arm evaluates. */
  | { kind: "ternary"; cond: IrExpr; then: IrExpr; else_: IrExpr; type: IrType; loc: SrcLoc }
  /** Nullish coalescing `a ?? b` — `logical`'s lazily-branched shape with
   * the left's runtime TAG against its unit arms as the test instead of
   * ToBoolean (JS-exact: ONLY null/undefined take the right side — 0, "",
   * and false do not). `left` is a unit-armed union; `right` evaluates
   * lazily, only when the tag IS a unit arm, and has the node's type.
   * Exactly two result shapes exist (frontend-enforced, validated):
   * pass-through — `type` equals `left.type` and the non-unit left value is
   * the result box itself — and narrowed — the union has ONE non-unit arm,
   * `type` equals it, and the payload is extracted unionNarrow-style (+1
   * for ref kinds) under the checker's proof that the tag matches. Unions
   * with several non-unit arms narrowing to a sub-union are fenced. */
  | { kind: "nullish"; left: IrExpr; right: IrExpr; type: IrType; loc: SrcLoc }
  /** `u || d` where u is a union and the checker types the RESULT as u's
   * single non-unit arm (`value || null`-style picks resolved to a plain
   * default: `marker() || "default"`): evaluate u exactly ONCE, ToBoolean
   * of the ARM value (the per-union truthy helper — unit arms falsy,
   * ""/0/NaN/false falsy, object arms truthy), extract the arm when
   * truthy (+1 for ref kinds — the only truthy values live in that arm),
   * evaluate d lazily otherwise. JS value semantics exactly; `nullish`'s
   * sibling with truthiness in place of the unit-tag test.
   *
   * `retag` widens that to the case where the checker types the result as
   * ANOTHER UNION (`process.env.X || null` is `string | null`; `||
   * 3000` is `string | number`): `type` is then that union and the truthy
   * side hands the whole left box to the named union→union retag helper
   * instead of extracting one arm, so u may have any number of non-unit
   * arms. The helper's stranded-unit-arm throw is unreachable here BY
   * CONSTRUCTION — the truthiness test has already ruled those arms out,
   * which is exactly why the left cannot be coerced eagerly into a target
   * the checker built by DROPPING them. The helper consumes its argument
   * (the ordinary call convention), so the truthy side must not also
   * release the left. */
  | { kind: "orDefault"; left: IrExpr; right: IrExpr; retag?: string; type: IrType; loc: SrcLoc }
  /** Optional chaining `a?.b` / `a?.m(...)` / `f?.()` / `a?.[i]` — the
   * `nullish` test inverted: `receiver` is a unit-armed union with at least
   * one non-unit arm, evaluated exactly once; when its runtime tag is a
   * unit arm the result is the interned undefined arm of `type` (JS-exact:
   * a null receiver still yields undefined) and `body` never evaluates —
   * argument side effects included. Otherwise the receiver binds
   * to `id` (read via chainRecv inside `body`, +1 per read for ref kinds)
   * and `body` produces the result: `type` when non-void (an
   * undefined-armed union; the frontend pre-wraps the member value into
   * it), or nothing (`type` void — the `cb?.()` statement form, where the
   * checker's `void | undefined` maps to void). */
  | { kind: "optChain"; id: string; receiver: IrExpr; body: IrExpr; type: IrType; loc: SrcLoc }
  /** The narrowed receiver inside an enclosing optChain's `body`, by the
   * chain's `id` — typed as the single non-unit arm when there is one,
   * or as the original union when there are several (the body can retag
   * it to the present sub-union). Each read is
   * +1 for ref kinds (a borrowed bind temp backs it). Valid nowhere else
   * (validated against the active-chain stack). */
  | { kind: "chainRecv"; id: string; type: IrType; loc: SrcLoc }
  /** String method/property with UTF-16 (JS-exact) index semantics. Optional
   * arguments are OMITTED from `args` (never encoded as non-finite literals —
   * the IR must stay JSON-safe); backends fill the defaults: indexOf position
   * 0, slice start 0, slice end +Infinity. */
  | {
      kind: "strIntrinsic";
      method: IrStrIntrinsicMethod;
      receiver: IrExpr;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** A regex literal `/ab+c/gi`. `pattern` is the text between the slashes
   * exactly as written (escapes UNprocessed — the regex engine parses them),
   * `flags` the trailing flags in source order (alphabet fenced to gimsuy by
   * the frontend). Backends intern ONE immortal static per (pattern, flags)
   * pair — like string literals, so repeated evaluation is free and
   * `re === re` would hold — and compile the pattern lazily at first use
   * (a pattern the engine rejects aborts with a clear message; Node throws
   * SyntaxError at parse time — documented divergence). Result is +1 (a
   * no-op retain on the immortal). */
  | { kind: "regexLit"; pattern: string; flags: string; type: IrType; loc: SrcLoc }
  /** The strings object of a tagged template `tag\`a${x}b\`` — the COOKED
   * span texts. `key` is a per-SITE identity (the spec canonicalizes the
   * template object per template-literal occurrence, so two sites with
   * identical text are DISTINCT objects while one site evaluated twice is
   * the SAME object — the memoizing-tag idiom): backends intern ONE
   * immortal static string array per key, like regex literals. `type` is
   * always string[]. Result is +1 (a no-op retain on the immortal).
   * Divergences live at the frontend: the array is not frozen (a tag
   * mutating its readonly parameter would diverge — tsc rejects the
   * spelling) and `.raw` does not exist on it (reads fence by name;
   * String.raw itself lowers separately, splicing raw text directly). */
  | { kind: "templateStrings"; key: string; cooked: string[]; type: IrType; loc: SrcLoc }
  /** A regex operation (see IrRegexIntrinsicMethod for the surface and the
   * receiver/arg conventions). The receiver and args are BORROWED;
   * string/array results are owned (+1). `replaceAll` and `split` MAY THROW
   * catchable TypeErrors (backends seed their may-throw analyses on them);
   * `test` on a g/y-flagged regex aborts at runtime (the frontend rejects
   * the literal-receiver cases it can see at compile time). */
  | {
      kind: "regexIntrinsic";
      method: IrRegexIntrinsicMethod;
      receiver: IrExpr;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** Array literal `[a, b, c]`, spreads included (`[...xs, b]`). `type` is
   * the array type; every element's type is `type.elem` EXCEPT positions
   * listed in `spreads`, whose expressions are same-typed ARRAYS copied
   * element-by-element at construction (JS-exact: a fresh array, source
   * untouched). Allocates; the result is owned (+1); ownership of
   * refcounted plain elements MOVES into the array, spread sources are
   * BORROWED (their elements copy in retained). */
  | { kind: "arrayLit"; elems: IrExpr[]; spreads?: number[]; type: IrType; loc: SrcLoc }
  /** Mapper-less `Array.from({ length: n })` — a length-n array of ABSENT
   * slots: unions carrying an undefined arm hold the interned undefined
   * instance (reads are JS-exact), every other refcounted element kind
   * holds NULL — a slot that MUST be assigned before it is read (the
   * pMap/allSettled fill-by-index pattern; reads of unassigned slots trap
   * where Node yields undefined — SEMANTICS.md 46). Scalar elements have
   * no absent value and are fenced by the frontend. The bound is ToLength
   * via the `i <= n - 1` loop form (fractions truncate; negative/NaN give
   * an empty array). Allocates; the result is owned (+1). */
  | { kind: "arrayNewLen"; length: IrExpr; type: IrType; loc: SrcLoc }
  /** Element read `a[i]`. Index is f64; the low-level accessors require a
   * proven present slot and trap on a hole. For refcounted elements the result
   * is a fresh owned (+1) reference. */
  | { kind: "arrayGet"; arr: IrExpr; index: IrExpr; type: IrType; loc: SrcLoc }
  /** Presence query for an array index. Invalid/non-index keys and holes
   * answer false without reading the slot; present undefined answers true.
   * The ordinary-read lowering must use arrayState before selecting its
   * undefined arm. */
  | { kind: "arrayHas"; arr: IrExpr; index: IrExpr; type: IrType; loc: SrcLoc }
  /** Array slot state as f64: HOLE=0, VALUE=1, UNDEFINED=2. */
  | { kind: "arrayState"; arr: IrExpr; index: IrExpr; type: IrType; loc: SrcLoc }
  /** Array method/property on an array receiver: `length` (f64), `push`
   * (VARIADIC like JS — zero or more elem-typed args; every argument
   * evaluates before any appends, then each appends in order; returns the
   * new length as f64, the unchanged length for the zero-argument call —
   * ownership of refcounted args MOVES into the array), `pushSpread` (`a.push(...src)`:
   * one arg of the RECEIVER's own array type, BORROWED — its elements
   * append in order, count snapshotted first so `a.push(...a)` duplicates
   * exactly like JS; returns the new length), `unshift` (the matching
   * variadic front insertion; all arguments evaluate before mutation and
   * ref ownership moves in), `unshiftSpread` (one borrowed same-typed array,
   * with self-spread snapshot semantics), `pop` (returns `elem | undefined`
   * and leaves an empty array unchanged; ownership moves OUT to the caller), `indexOf` (one
   * elem-typed arg, BORROWED; strict equality — NaN never matches; → f64),
   * `includes` (one elem-typed arg, borrowed; SameValueZero — NaN DOES
   * match; → bool), `join` (one string arg, borrowed; f64/bool/string
   * elements only — validated; → owned string), `shift` (zero args; JS
   * shift exactly — undefined on an empty array, else the first element
   * out with the tail sliding down; the result type is the interned
   * `elem | undefined` union — union ELEMENTS are frontend-fenced, so the
   * arms never collide; ref ownership moves out into the box), and
   * `splice` (the REMOVAL forms only — one or two f64 args, Node's
   * relative/clamped start and clamped count, an omitted count removes to
   * the end [backends fill +Infinity, the slice convention]; the result is
   * a fresh +1 array of the removed elements IN ORDER, their ownership
   * MOVED from the receiver; insertion forms are frontend-fenced), and
   * `reverse` (zero args; swaps the receiver's slots in place and returns
   * the same array identity as an owned reference). */
  | {
      kind: "arrIntrinsic";
      method: IrArrIntrinsicMethod;
      receiver: IrExpr;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** Typed-array / Buffer construction — `new Uint8Array(x)`,
   * `Buffer.from(u8 | number[])`, `Buffer.alloc(n)`. `type` is the bytes
   * type; the SOURCE's static type picks the form:
   * - null — `new Uint8Array()`: a fresh zero-length buffer. Never throws.
   * - f64 — a zero-filled buffer of that length (ToIndex: NaN → 0,
   *   truncate; a negative/huge result THROWS Node's "Invalid typed array
   *   length" RangeError catchably — backends' may-throw analyses seed on
   *   bytesNew with a non-bytes, non-array source).
   * - bytes — an independent, element-coerced COPY. Never throws.
   * - array of f64 — a per-element-coerced copy (ToUint8/ToUint32/float).
   *   Never throws.
   * - dyn — checked native input; can throw on invalid lengths/coercion.
   *   `from` selects TypedArray.from's iterable/array-like semantics instead
   *   of constructor length coercion (notably for strings and numbers).
   * The source is BORROWED; the result is owned (+1). */
  | { kind: "bytesNew"; source: IrExpr | null; from?: true; type: IrType; loc: SrcLoc }
  /** Typed-array/Buffer method or property on a bytes receiver — see
   * IrBytesIntrinsicMethod for the surface and conventions. Methods in
   * MAY_THROW_BYTES_METHODS raise catchable RangeErrors (may-throw
   * seeds); `get` traps on invalid indices instead (the array runtime's
   * discipline — never catchable). */
  | {
      kind: "bytesIntrinsic";
      method: IrBytesIntrinsicMethod;
      receiver: IrExpr;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** `new Map<K, V>()` — allocate an empty map. `type` is the map type
   * (key/value fences already enforced by the frontend); the result is
   * owned (+1). `seed` carries the entries of the SUPPORTED seeded form —
   * `new Map([[k, v], ...])`, an array literal of pair literals at the
   * construction site — lowered pairwise (each key K-typed, each value
   * V-typed, source order; a repeated key overwrites like set()). The
   * entries array itself never exists at runtime: backends construct the
   * empty map and set() each pair. Tuple-array VALUE seeds desugar in the
   * frontend to a construct-and-set loop (lowerMapSeedArrayNew) and never
   * reach this node; other argument shapes (iterables, another Map) stay
   * frontend-fenced. */
  | { kind: "mapNew"; seed?: { key: IrExpr; value: IrExpr }[]; type: IrType; loc: SrcLoc }
  /** Map method/property on a map receiver (`type` of the receiver is the
   * map; K/V below are its key/value types): `get` (one K arg, borrowed →
   * the interned `V | undefined` union, owned +1 — the undefined arm is the
   * miss; because `undefined` sorts LAST in canonical arm order, a union V
   * keeps its tags and the stored box IS the result), `set` (K borrowed,
   * V moves in; replacing releases the old value; → void — the ambient
   * declares void, not the JS `this`, so chaining is a type error), `has`
   * (K borrowed → bool, SameValueZero), `delete` (K borrowed → bool;
   * releases the entry), `size` (→ f64 live count), `clear` (→ void), and
   * the desugar-internal iteration primitives: `iterCount` (→ f64, dense
   * entries INCLUDING tombstones — re-read each pass so callback appends
   * are visited), `iterLive` (f64 index → bool), `iterKey` (f64 index → K,
   * +1 for strings), `iterValue` (f64 index → V, +1 for ref kinds),
   * `iterEnter`/`iterExit` (→ void, bracket a forEach loop: no compaction
   * while the depth is nonzero). The receiver is borrowed. */
  | {
      kind: "mapIntrinsic";
      method: IrMapIntrinsicMethod;
      receiver: IrExpr;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** `new Set<T>()` — allocate an empty set. `type` is the set type (the
   * element fence already enforced by the frontend); the result is owned
   * (+1). `seed` is one borrowed array whose elements add() in order
   * (duplicates collapse, first insertion position wins, SameValueZero).
   * The frontend materializes supported non-array seeds, including Sets,
   * strings, tuples, and collection iterators, before constructing this IR. */
  | { kind: "setNew"; seed?: IrExpr; type: IrType; loc: SrcLoc }
  /** Set method/property on a set receiver (`type` of the receiver is the
   * set; T below is its element type): `add` (one T arg, borrowed — the
   * runtime retains stored strings; → void, the JS `this` result is
   * frontend-fenced like Map set's chaining), `has`/`delete` (T borrowed →
   * bool, SameValueZero), `size` (→ f64 live count), `clear` (→ void), and
   * the desugar-internal iteration primitives with mapIntrinsic's exact
   * contract — `iterKey` reads the ELEMENT (f64 index → T, +1 for
   * strings); there is no iterValue. The receiver is borrowed. */
  | {
      kind: "setIntrinsic";
      method: IrSetIntrinsicMethod;
      receiver: IrExpr;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** Call of a user function declared in this module, by name. */
  | { kind: "call"; callee: string; args: IrExpr[]; type: IrType; loc: SrcLoc }
  /** Direct call of a manifest-bound native C symbol. Arguments are
   * borrowed (native code may inspect but never retain string/bytes
   * pointers); scalar results return by value. The import's ABI signature
   * lives once on IrModule.ffiImports and the validator checks this call
   * against it. Native code is outside scriptc's exception protocol: it
   * must return normally and must not retain or mutate borrowed storage. */
  | { kind: "ffiCall"; import: string; args: IrExpr[]; type: IrType; loc: SrcLoc }
  /** Closure creation: a function value over `fnName` (a module function),
   * capturing the listed boxed locals of the CREATING function (localIds,
   * in the callee's captures[] order). The result is owned (+1); the closure
   * itself retains each captured box. A reference to a top-level declared
   * function lowers to a zero-capture closure — backends must intern that
   * case so `f === f` is true (JS function identity). */
  | { kind: "closure"; fnName: string; captures: string[]; type: IrType; loc: SrcLoc }
  /** Indirect call of a func-typed value. Args follow `call`'s convention
   * (callee owns its params, callers pass +1). The callee expression is an
   * ordinary owned temp, released at statement end. receiver supplies the
   * call-time this value; absence means undefined. Evaluate callee, receiver,
   * then args, and restore the ambient receiver before unwinding. */
  | {
      kind: "callValue";
      callee: IrExpr;
      receiver?: IrExpr;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** The currently-executing closure, as a value (+1). Valid only inside a
   * lifted function. Exists so a named nested function can recurse on itself
   * WITHOUT capturing its own binding — a box holding its own closure would
   * be a reference cycle, which naive RC can never free. */
  | { kind: "selfRef"; type: IrType; loc: SrcLoc }
  /** `yield e` — only inside generator functions (validated). Stores the
   * operand in the generator's out-slot (moved in, typed `yieldT`; null =
   * `yield;`, the undefined arm — the frontend guarantees yieldT admits
   * it) and switches back to the resumer; the expression's value is the
   * NEXT `.next(v)` argument (typed `nextT`, +1 for refcounted kinds).
   * MAY-THROW SEED: a consumer `.throw(e)` surfaces here as the pending
   * exception (catchable by the body's own try/catch), and `.return(v)`
   * as the GENRET sentinel — pending like an exception, it unwinds
   * through finally blocks but must NOT be taken by catch handlers
   * (backends emit a sentinel re-unwind prologue at catch entry inside
   * generator bodies; scr_exc_genret_pending answers it). */
  | {
      kind: "yieldExpr";
      value: IrExpr | null;
      awaited?: true;
      captureCompletion?: { returnType: IrType };
      type: IrType;
      loc: SrcLoc;
    }
  /** One consumer resume of a generator: `g.next(arg)`, `g.return(arg)`,
   * `g.throw(arg)`, and the for-of/yield* desugars. `gen` is a borrowed
   * generator-typed temp. `arg` is the sent value (moves in): next's
   * TNext (null = valueless resume — only when nextT is the undefined
   * unit or dyn), return's TReturn (null = `.return()`, the undefined
   * done-value), throw's payload (any throwable type — the throw
   * statement's operand contract). Result is the interned IteratorResult
   * record `{ done: bool, value: V }` (+1) where V is the canonical union
   * of yieldT, retT (when it carries a value), and undefined — collapsed
   * when one member survives. Semantics per mode on an UNSTARTED /
   * SUSPENDED / DONE generator: next runs the body to its next
   * suspension or completion / return completes without running the body
   * unless suspended (then the GENRET unwind runs finallys; a finally
   * yield answers done:false and parks the return value) / throw on a
   * non-suspended generator marks it done and re-throws at the call site.
   * Sync generators return that record directly and propagate body errors
   * synchronously. Async generators return Promise<record>; requests queue,
   * and body errors reject the corresponding promise. */
  | {
      kind: "genResume";
      mode: "next" | "return" | "throw";
      gen: IrExpr;
      arg: IrExpr | null;
      type: IrType;
      loc: SrcLoc;
    }
  /** Await a promise: parks the current fiber until it settles; a rejected
   * promise re-throws into the awaiter (may-throw seed). Result is the
   * promise's inner value (+1 for refcounted kinds). Only inside async fns. */
  | { kind: "awaitExpr"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Await of a promise-or-absent union (`Promise<T> | undefined`, the
   * mapped `Promise<T> | void`): `value` is a union whose arm `promiseTag`
   * is a promise and whose other arms are all units. The promise arm awaits
   * like awaitExpr (parks, re-throws rejections — may-throw seed); a unit
   * arm takes exactly ONE microtask hop (JS: await of a non-thenable) and
   * yields itself. `type` is void when the promise's inner is void and the
   * only unit arm is undefined; otherwise the interned union of the inner
   * type and the unit arms (+1). Only inside async fns. */
  | { kind: "awaitUnionExpr"; value: IrExpr; promiseTag: number; type: IrType; loc: SrcLoc }
  /** `new Promise<T>((resolve) => ...)`: creates a pending promise and runs
   * the executor synchronously with a resolve closure; an executor throw
   * rejects the promise (JS-exact). Result +1. */
  | { kind: "newPromise"; executor: IrExpr; type: IrType; loc: SrcLoc }
  /** `Promise.withResolvers<T>()`: a pending promise plus its runtime
   * resolve/reject closures (the newPromise pieces without an executor),
   * assembled into the record `{ promise, resolve, reject }` — `type` is
   * that record; the shape's promise field carries T, resolve is
   * (T) => void (() => void for void T), reject is (%Error) => void.
   * Result +1; never throws. */
  | { kind: "promiseWithResolvers"; type: IrType; loc: SrcLoc }
  /** `new C(args)`: allocate (fields zeroed), then call `%C.constructor`
   * with the new object as arg 0 (retained — the ctor owns and releases its
   * `this` param like any callee). Result is owned (+1). */
  | { kind: "new"; className: string; args: IrExpr[]; type: IrType; loc: SrcLoc }
  /** The class itself as an owned value. `captures` creates fresh identity
   * and retains the named boxes; absent captures use an immortal template.
   * The frontend notes an edge to `%className.constructor` at
   * every classRef, so a value's construct thunk always has a constructor
   * to call; backends emit class objects (and thunks) for exactly the
   * classes some classRef in the module names. */
  | { kind: "classRef"; className: string; captures?: string[]; type: IrType; loc: SrcLoc }
  /** `new X(args)` through a class VALUE: call the class object's
   * construct thunk. `callee` is classval-typed; args are completed
   * against `%<callee.className>.constructor`'s ABI — sound because every
   * legal classval flow preserves the constructor ABI (the upcast rule) —
   * and follow `call`'s ownership (callee owns, +1 in). `type` is
   * `object:<callee.className>` (a runtime descendant rides the ordinary
   * upcast story); result owned (+1). May throw whenever constructors may
   * (backends treat it like an indirect call). */
  | { kind: "newValue"; callee: IrExpr; args: IrExpr[]; type: IrType; loc: SrcLoc }
  /** `x instanceof X` with a DYNAMIC right-hand side (a classval-typed
   * value): the preorder-interval check with the interval loaded from the
   * class object — `vt(x)->pre` within `[X->pre, X->post]`. The frontend
   * emits this only when the operand's static class and the target
   * classval's class are both hierarchy members (the operand carries a
   * vt; a standalone target has exactly one possible runtime value and
   * folds statically instead). Operands borrowed; result bool. */
  | { kind: "instanceOfValue"; value: IrExpr; classValue: IrExpr; type: IrType; loc: SrcLoc }
  /** Implicit widening of a derived-class value into a base-class slot
   * (`type` is the base; the operand's class is a strict descendant).
   * Prefix layout makes this a pointer reinterpret: SAME object, no RC
   * traffic — ownership of the operand transfers to the result. Also
   * widens CLASS VALUES (`classval:D` into `classval:C`): the identical
   * pointer, type-only — legal exactly when D strictly descends from C
   * AND the two constructors' completed ABIs are equal (param-wise
   * typeEquals; validator-enforced), the invariant `newValue` completion
   * rests on. */
  | { kind: "upcast"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Implicit widening of a promise value into a VOID-promise slot (an
   * inferred Promise<never>/Promise<void> return whose body built a
   * concrete-inner promise — `return Promise.reject(value)` typed
   * promise<dyn>). One C representation (ScrPromise*), so this is a
   * type-only reinterpret: awaiting through the slot ignores the
   * fulfillment payload (scr_await_void) and rejections flow untyped.
   * Ownership of the operand transfers to the result, like upcast. */
  | { kind: "promiseVoidWiden"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Checker-trusted narrowing of a base-class value to a subclass (`type`
   * is the subclass). The frontend emits this only where tsc's control-flow
   * narrowing has already proven the dynamic class (an `instanceof` guard)
   * — the same trust-the-checker contract as unionNarrow: no runtime check,
   * a pointer reinterpret with ownership transferring like upcast. */
  | { kind: "downcast"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** `x instanceof C` where x's static class and C are both in extends-
   * hierarchies: an O(1) preorder-interval check against the vtable the
   * value carries (`C.pre <= vt(x)->pre <= C.post`). Statically-decided
   * cases (standalone classes, and always-true/unrelated combinations)
   * never reach the IR — the frontend folds them. The operand is borrowed;
   * the result is a plain bool. */
  | { kind: "instanceOf"; value: IrExpr; className: string; type: IrType; loc: SrcLoc }
  /** Method call that must dispatch on the receiver's DYNAMIC class:
   * `className` is the receiver's static class, `args[0]` the receiver
   * (typed exactly `object:className`), and some strict subclass overrides
   * `method` — the backend calls through the vtable slot of the method's
   * root-most declaring class. Monomorphic calls (no override reachable
   * from the static class) stay ordinary `call` nodes — whole-program
   * devirtualization is the frontend's job. Ownership follows `call`:
   * callees own their params, callers pass +1. */
  | {
      kind: "virtualCall";
      className: string;
      method: string;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** Field read `obj.f`. Refcounted fields come out retained (+1). */
  | { kind: "fieldGet"; obj: IrExpr; className: string; field: string; type: IrType; loc: SrcLoc }
  /** Record literal `{ a: 1, b: "x" }`. `type` is the record type; `fields`
   * are in SOURCE order (JS evaluates property values in source order) and
   * cover the shape's fields exactly once each (validated — a source literal
   * omitting OPTIONAL fields reaches the IR already completed: the frontend
   * appends the wrapped undefined arm for each omitted one). Allocates
   * (fields zeroed) and returns owned (+1); ownership of refcounted field
   * values MOVES into the record. */
  /** Entries flagged `overflow` are UNDECLARED keys of an index-signature
   * shape (their values have the shape's indexValue type — dyn included);
   * they insert into the overflow map in list order, interleaved with the
   * declared writes (one list keeps JS source-order evaluation). */
  /** Entries flagged `drop` are fields the shape MAPPING dropped (the
   * PromiseSettledResult honest subset — SEMANTICS.md 46): the value
   * expression still evaluates in its source-order slot (the awaited
   * mapper in `{ status: "fulfilled", value: await fn(...) }` must run and
   * may throw), but nothing is stored — the emitter releases the result
   * with the statement frame. Any value type is legal here, void included
   * (an awaited Promise<void>). */
  | {
      kind: "recordLit";
      fields: { name: string; value: IrExpr; overflow?: true; drop?: true }[];
      type: IrType;
      loc: SrcLoc;
    }
  /** Same-shape object spread with explicit overrides: `{ ...source,
   * field: value }`. `source` is evaluated first and borrowed by one
   * per-shape clone helper; `overrides` then evaluate in source order and
   * replace the cloned slots. Refcounted override values MOVE in and the
   * replaced cloned values release after unlinking. Restricted to plain
   * declared-field records (no tuple/index/accessor shapes), so every
   * omitted field is copied exactly once by the helper. */
  | {
      kind: "recordClone";
      source: IrExpr;
      overrides: { name: string; value: IrExpr }[];
      type: IrType;
      loc: SrcLoc;
    }
  /** Record field read `r.f` — mirrors `fieldGet`: refcounted fields come
   * out retained (+1). */
  | { kind: "recordGet"; obj: IrExpr; shapeId: string; field: string; type: IrType; loc: SrcLoc }
  /** Dynamic-keyed record read `r[k]` (string key, evaluated at runtime).
   * Declared fields are tried FIRST (an emitted string-switch — field
   * access exactness is preserved: a declared name always answers from the
   * struct slot), then the overflow map on index-signature shapes. `type`
   * is the CHECKER's type for the access: the index signature's value type
   * (dyn for `unknown`; with noUncheckedIndexedAccess, its
   * `V | undefined` union). A MISSING key produces: the undefined dyn
   * singleton when `type` is dyn; the undefined arm when `type` is an
   * undefined-armed union; otherwise a TRAP — the checker claimed V and no
   * undefined is representable (the array OOB policy; on declared-only
   * shapes tsc's keyof check makes the trap unreachable without an `as`
   * smuggle). Declared-field values surface as `type`: V-typed fields read
   * directly, dyn results build a dyn COPY of the field value (the dynFrom
   * conversion — deep for composites, documented), union results wrap.
   * The key and object are borrowed; refcounted results are owned (+1).
   * `overflowOnly` (set when the key is a LITERAL that names no declared
   * field): the read touches only the overflow map — declared fields need
   * not surface as `type`, and the emitted helper skips the string-switch. */
  | {
      kind: "recordKeyGet";
      obj: IrExpr;
      shapeId: string;
      key: IrExpr;
      overflowOnly?: true;
      type: IrType;
      loc: SrcLoc;
    }
  /** Static value → dyn conversion (`type` is always dyn): the operand
   * (a JSON-safe type — f64/string/bool/record/array/union, validated)
   * converts to a fresh dyn tree, DEEP-COPYING composites (the jsMarshal
   * aliasing stance; a dyn value can never alias static storage). An
   * undefined-armed union's undefined arm becomes the undefined dyn
   * singleton. A FUNCTION operand (canBoxFuncIntoDyn — the mustCall shape:
   * a typed closure flowing into an untyped JS helper's implicit-any
   * param) BOXES instead of copying: the checked-dynamic tree's function kind carries the
   * retained closure, a compiled per-signature call thunk (per-argument
   * dynCheck into the declared param types, result dynFrom'd back — JS
   * arity: extras ignored, missing args are the undefined dyn value and
   * must satisfy the param's type or the thunk throws the catchable
   * TypeError), the interned signature key (dynCheck's exact-unwrap fast
   * path), and `fnName` — the best-effort static spelling for inspect
   * ([Function: name]) and Node-shaped call errors. The operand is
   * borrowed; the result is owned (+1). Never throws. Program class
   * instances always use a typed capsule so an exact checked cast recovers
   * the original identity. `liveRef` requests the same capsule form for
   * record/array/bytes values (including mutable arms selected at runtime
   * from a union) whose Web API contract exposes the reference again, such
   * as stream chunks and abort reasons; ordinary JSON-shaped values retain
   * the documented deep-copy boundary. */
  | { kind: "dynFrom"; value: IrExpr; fnName?: string; liveRef?: true; type: IrType; loc: SrcLoc }
  /** Island value → dyn conversion (`type` is always dyn; the operand
   * is always jsval): the jsval→dyn crossing — an 'any'-typed engine
   * value flowing into an 'unknown'/'object'/JS-residue slot wraps BY
   * REFERENCE as the checked-dynamic tree's SCR_DYN_JSVAL kind (scr_dyn_from_jsval).
   * Engine scalars (number/string/boolean/null/undefined) normalize to
   * the native dyn kinds at wrap time, so wrapped nodes only ever hold
   * engine objects/arrays/functions; typeof/truthiness/String()/=== on
   * the wrapped node route to the engine, un-armed dyn walks fence
   * loudly, and scr_jsval_from_dyn unwraps the SAME engine value back
   * (identity round trip). The operand is borrowed; the result is owned
   * (+1). Never throws. */
  | { kind: "dynFromJsval"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** CALLING a dyn value — `fn(a, b)` where fn is checked-dynamic (an
   * implicit-any JS binding, a dyn record member, a dynKeyGet result).
   * Arguments are ALREADY dyn-typed (typed values box through dynFrom at
   * the call's coercion — function args included); `type` is always dyn.
   * A non-function callee kind throws the catchable Node-shaped TypeError
   * "`calleeName` is not a function" BEFORE evaluating no arguments —
   * actually args evaluate first, source order, then the callee kind is
   * tested (JS evaluates callee before args, but the callee EXPRESSION
   * already evaluated; only the callability test is deferred — Node's
   * message exactly). A function callee calls through the boxed thunk:
   * per-arg validation against the boxed signature (mismatches throw the
   * path-annotated TypeError), result converted back to dyn. Callee and
   * args are borrowed; the result is owned (+1). MAY THROW.
   *
   * `spreads` (the runtime-arity form — `f(...args)`, the rest-forwarding
   * idiom): entries name indices into `args` whose dyn values FLATTEN into
   * the argument vector at the call — JS's spread over the checked-dynamic tree's iterable
   * kinds (arrays element-by-element, strings by code point, bytes by
   * byte; every other kind throws V8's exact spread-call TypeError,
   * catchably — `what` is the spread expression's source spelling, which
   * the nullish text spells), evaluated and flattened left-to-right (JS's
   * ArgumentListEvaluation). The emitters build one fresh argument array
   * and apply through it. */
  | {
      kind: "dynCall";
      callee: IrExpr;
      receiver?: IrExpr;
      calleeName: string;
      calleeNameValue?: IrExpr;
      args: IrExpr[];
      spreads?: { arg: number; what: string }[];
      type: IrType;
      loc: SrcLoc;
    }
  /** Prototype-method DISPATCH on a dyn receiver — `recv.m(...)` where `m`
   * is a name a dyn-representable prototype declares (Array/String/
   * Function shared names: push, slice, join, forEach, map, apply, ...),
   * so a stored-member read would silently mis-answer real methods. The
   * runtime (scr_dyn_invoke) dispatches on the receiver's KIND:
   * implemented (kind, name) pairs run JS-exact semantics; a real-but-
   * unimplemented method throws a LOUD "not supported yet" Error; a name
   * the kind's prototype lacks throws Node's catchable "<calleeName> is
   * not a function"; OBJ receivers call the own member (own properties
   * shadow prototypes in JS too); undefined/null receivers throw Node's
   * "Cannot read properties of ...". Arguments are already dyn.
   * `calleeName` is the source spelling for the error texts. Receiver and
   * args are borrowed; the result is owned (+1). MAY THROW. */
  | {
      kind: "dynInvoke";
      recv: IrExpr;
      method: string;
      calleeName: string;
      calleeNameValue?: IrExpr;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** A dyn ARRAY built element-by-element (JS mixed-element literals —
   * `['pwd', []]` — and evolving `[]` declarations): each element is
   * already a dyn value; the result owns them. Never throws. */
  | { kind: "dynArrLit"; elems: IrExpr[]; type: IrType; loc: SrcLoc }
  /** A dyn OBJECT built member-by-member. With no `fields` it is an empty
   * object. With `fields` it is a JS object literal whose
   * keys are RUNTIME values (the computed-key idiom `{ [field]: criteria,
   * actual: 0 }` in test/common's _mustCallInner): each entry's key is a
   * string-typed expression (identifier/string keys lower to strLits;
   * computed keys evaluate their expression and pass through ToString —
   * JS's ToPropertyKey on the string side), each value is already dyn, and
   * entries evaluate key-then-value in SOURCE order (JS's object-literal
   * evaluation order; later duplicate keys win, insertion order preserved —
   * the checked-dynamic tree's own set semantics). Keys and values are borrowed (the member
   * retains the value in). Never throws itself. */
  | { kind: "dynObjLit"; fields?: { key: IrExpr; value: IrExpr }[]; type: IrType; loc: SrcLoc }
  /** Runtime kind test on a dyn value — the narrowing tests tsc's
   * control flow understands on `unknown`: `typeof v === "string" |
   * "number" | "boolean" | "undefined"` and the unit comparisons `v ===
   * undefined` / `v === null` (`"nullish"` is the LOOSE `v == null` pair —
   * undefined or null in one test), and `v instanceof TypedArray`
   * (`"bytes"` plus bytesElem, default u8; Node's Buffer is a Uint8Array
   * subclass), plus
   * the two object-family tests: `"object"` is `typeof v === "object"`
   * exactly (true for the checked-dynamic tree's object, array, bytes, AND null kinds —
   * JS's oldest wart preserved), `"array"` is `Array.isArray(v)` (the
   * array kind alone), and `"truthy"` is ToBoolean over the whole dyn
   * (`if (v)` on unknown): undefined/null false, bool by value, number
   * falsy exactly for 0, -0, and NaN, string falsy exactly when empty,
   * object/array/bytes always true — JS-exact for every kind. A pure
   * kind-tag compare against the dyn node's kind (truthy also reads the
   * scalar payload); the operand is
   * borrowed, nothing allocates, never throws. Result is bool. Narrowed
   * READS afterwards bridge through `dynCheck` extraction
   * (trust-but-VERIFY: unlike unionNarrow, a read reached with a lying
   * kind throws instead of misreading the payload). `"error"` is
   * `v instanceof Error` on an unknown value: true exactly for the checked-dynamic tree's
   * error encoding — an object carrying the reserved "%error" key, the
   * shape caughtToDyn builds for Error payloads (SEMANTICS.md 67) — so a
   * caught Error passed through an unknown slot answers true like Node;
   * dynCheck against %Error extracts it. `"function"` is `typeof v ===
   * "function"` — true exactly for the checked-dynamic tree's function kind (boxed
   * closures); function values are truthy and answer FALSE to the
   * `"object"` test, JS-exact. */
  | {
      kind: "dynTest";
      test:
        | "promise"
        | "bigint"
        | "symbol"
        | "string"
        | "number"
        | "boolean"
        | "undefined"
        | "null"
        | "nullish"
        | "bytes"
        | "buffer"
        | "object"
        | "array"
        | "truthy"
        | "error"
        | "function";
      bytesElem?: IrBytesElem;
      negated?: true;
      value: IrExpr;
      type: IrType;
      loc: SrcLoc;
    }
  /** Keyed read on a dyn value — `pkg.name` / `pkg["k"]` / the
   * `pkg?.scripts` chain step on a JSON.parse result. `key` is
   * string-typed (a strLit for the dot form); `type` is always dyn. An
   * OBJ receiver answers the member (+1) or the undefined singleton (the
   * own-property answer — prototype members like `toString` answer
   * undefined, SEMANTICS.md); ARR answers `length` and canonical
   * in-range indices, STR answers `length` (UTF-16-exact), both
   * undefined otherwise; NUM/BOOL/BYTES answer undefined. An
   * undefined/null receiver THROWS the catchable Node-shaped TypeError
   * ("Cannot read properties of undefined (reading 'k')") — unless
   * `optional` is set (a `?.` step, or a later step of a chain whose
   * earlier `?.` guards it): then it answers the undefined singleton,
   * JS's short-circuit. Receiver and key are borrowed; the result is
   * owned (+1). */
  | { kind: "dynKeyGet"; key: IrExpr; optional?: true; value: IrExpr; type: IrType; loc: SrcLoc }
  /** `"k" in pkg` on a dyn receiver (literal keys only): OBJ answers
   * own-member presence (a member holding the undefined value still
   * answers true — the checked-dynamic tree stores presence, unlike the record form's
   * SEMANTICS.md 55 stance), ARR answers true for "length" and canonical
   * in-range indices, everything else answers false (tsc admits `in`
   * only on object-typed operands, so unit receivers — where JS throws —
   * are checker-unreachable and answer false). Borrowed operand, no
   * allocation, never throws. Result is bool. */
  | { kind: "dynHasKey"; key: string; negated?: true; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Strict equality between a dyn value and a SCALAR-typed value
   * (`v !== ""`, `v === 5` — one side `unknown`, the other f64/string/
   * bool): a guarded kind test plus payload compare — true exactly when
   * the checked-dynamic tree holds that scalar kind AND the payloads are strictly equal
   * (C == for numbers: NaN false, ±0 equal — JS-exact; bytewise for
   * strings). `left`/`right` keep SOURCE order (evaluation order is
   * JS's); at least one side is dyn-typed — BOTH-dyn compares run the
   * runtime's whole-dyn strict equality (scr_dyn_strict_eq: scalars by
   * value, units by kind, reference kinds by node identity — JS-exact
   * within the checked-dynamic tree's aliasing story). Both operands are borrowed,
   * nothing allocates, never throws. Result is bool. */
  | { kind: "dynScalarEq"; left: IrExpr; right: IrExpr; negated?: true; type: IrType; loc: SrcLoc }
  /** Statements inside an expression: `stmts` run in order, then `result`
   * is the expression's value — the lift behind assignment-as-expression
   * forms whose statement lowering needs temps and writes (destructuring
   * assignments in value position, keyed dyn writes yielding the RHS).
   * `type` IS result's type. Restricted on purpose: stmts must be
   * local statements (including blocks, branches, and loops, but no jumps;
   * the validator enforces the subset). Hidden locals retain function-wide
   * ids, but their owned values live through the enclosing expression's
   * frame: later call arguments may reuse a saved operand. Release them
   * on the same path that initialized them, not an outer lexical scope. */
  | {
      kind: "seqExpr";
      stmts: IrStmt[];
      result: IrExpr;
      generatorDelegate?: true;
      type: IrType;
      loc: SrcLoc;
    }
  /** RequireObjectCoercible with V8's destructuring TypeError: throws
   * "Cannot destructure 'SPELLING' as it is undefined." (or "…null.") on
   * a nullish value — the property form "Cannot destructure property
   * 'FIRSTPROP' of 'SPELLING' …" when `firstProp` is set (V8 names the
   * pattern's first property) — and yields the value unchanged otherwise.
   * `spelling` is the RHS's compile-time source spelling. Value and type
   * are dyn (the dyn helper) or jsval (the island's prelude guard —
   * engine-thrown, catchable like every boundary throw). */
  | {
      kind: "dynDestrCheck";
      value: IrExpr;
      spelling: string;
      firstProp?: string;
      type: IrType;
      loc: SrcLoc;
    }
  /** GetIterator + the first `count` steps, as array destructuring sees
   * it. Over a dyn value: arrays step by index, strings by code point,
   * Buffers by byte; everything else throws V8's exact "<desc> is not
   * iterable (cannot read property Symbol(Symbol.iterator))" TypeError.
   * Over an island (jsval) value the engine runs the REAL iterator
   * protocol (user iterables included, IteratorClose per spec) behind the
   * same V8 message for non-iterables. The result is a FRESH array (dyn
   * or engine, matching the operand) of exactly `count` elements
   * (undefined-padded past the end) — the empty pattern passes count 0
   * and uses only the validation. Value is borrowed; the result is owned
   * (+1). */
  | {
      kind: "dynIterN";
      value: IrExpr;
      count: number;
      notIterableMessage?: string;
      type: IrType;
      loc: SrcLoc;
    }
  /** The OVERFLOW key list of an index-signature record, in JS OWN-KEY
   * order (canonical array indices ascending first, then insertion order —
   * the runtime's scr_map_keys_js_order): a fresh string[] snapshot, the
   * iteration surface behind Object.keys/values/entries over hybrid
   * shapes. `obj` must be a record whose shape carries an indexValue; the
   * receiver is borrowed, the array is owned (+1). Declared fields are NOT
   * listed (they never live in the overflow map — the lowering prepends
   * them from the shape). Never throws. */
  | { kind: "recordOvfKeys"; obj: IrExpr; shapeId: string; type: IrType; loc: SrcLoc }
  /** Own-key presence in an index-signature record's overflow map. Unlike
   * a keyed read, this distinguishes a missing key from a stored undefined
   * value. Declared fields are handled separately by the lowering. Both
   * operands are borrowed, the key is string, the result is bool. */
  | { kind: "recordOvfHas"; obj: IrExpr; shapeId: string; key: IrExpr; type: IrType; loc: SrcLoc }
  /** Union construction: wrap an arm value into a fresh tagged box (the
   * frontend inserts these wherever a `B` flows into an `A | B` slot).
   * `tag` is the arm's index in the union's canonical arm list; `value` has
   * exactly that arm's type; `type` is the union. Allocates, returns owned
   * (+1); ownership of a refcounted payload MOVES into the union. Unions are
   * immutable once constructed. */
  | { kind: "unionWrap"; unionId: string; tag: number; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Strict identity comparison between a function arm of a union and a
   * function value with a potentially different static signature. This is
   * non-coercing: closures share one pointer representation, but the value
   * never enters the union or becomes callable through its arm type. */
  | {
      kind: "unionFuncEq";
      unionId: string;
      tag: number;
      union: IrExpr;
      func: IrExpr;
      negated: boolean;
      type: IrType;
      loc: SrcLoc;
    }
  /** Runtime test on a catch binding (`value` is a caught-typed varRef,
   * borrowed). The primitive tests ("string"/"number"/"boolean") compare
   * the snapshot's kind tag. "object" also checks reference payloads,
   * excluding callable and primitive references;
   * "instanceof" requires `className` (a hierarchy class) and tests an OBJ
   * payload's vtable preorder against its interval (false for every other
   * payload kind). `negated` flips the result (the `!==` spelling). */
  | {
      kind: "caughtTest";
      value: IrExpr;
      test: "string" | "number" | "boolean" | "object" | "instanceof";
      className?: string;
      negated?: boolean;
      type: IrType;
      loc: SrcLoc;
    }
  /** Checker-trusted extraction of a catch binding's payload as `type` —
   * the caught analog of unionNarrow: the frontend emits this only where
   * tsc's control-flow narrowing has already proven the matching test
   * (`e instanceof C` / `typeof e === "string"`), so the read is
   * kind-UNCHECKED at runtime. `type` is f64, bool, string, or a
   * hierarchy-class object; refcounted results come out retained (+1). */
  | { kind: "caughtNarrow"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** CHECKED extraction of a catch binding's payload as a hierarchy-class
   * instance — the caught analog of dynCheck, emitted for `e as C` casts
   * on catch bindings (the `(err as Error).message` idiom): an OBJ payload
   * inside C's preorder interval extracts (+1); every other payload THROWS
   * a catchable TypeError naming the class. Node's `as` is erasure — the
   * checked cast is the documented trust-but-verify stance for dynamic
   * values, extended to exception payloads. `type` is C's object type;
   * may-throw seeds like dynCheck. */
  | { kind: "caughtCheck"; value: IrExpr; className: string; type: IrType; loc: SrcLoc }
  /** A catch binding flowing into an `unknown` slot (`options.onError?.(e)`
   * — the caught snapshot converting to a dyn value, the typed→unknown
   * deep-copy stance extended to exception payloads, SEMANTICS.md 67).
   * Runtime dispatch on the snapshot's kind: string/number/boolean payloads
   * become the exact dyn scalars; an Error-family OBJ payload becomes the
   * dyn's error encoding — an object with the reserved "%error" marker key
   * plus "name"/"message" (and "code" when stamped), so `instanceof Error`
   * (dynTest "error"), the %Error dynCheck extraction, and String() answer
   * like Node; every other payload (records, arrays, closures, unions,
   * non-Error hierarchy objects — type-erased at runtime) becomes an EMPTY
   * dyn object: truthy, typeof "object", fields unreadable — the
   * "[object Object]" approximation, documented. `value` is a caught-typed
   * varRef (borrowed); `type` is dyn; the result is a fresh tree (+1),
   * never aliasing the payload. Never throws. */
  | { kind: "caughtToDyn"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Union payload extraction, tag-UNCHECKED: `value` is union-typed,
   * `type` is arms[tag], and the backend reads the payload assuming the tag
   * — SOUNDNESS RESTS ON tsc's control-flow narrowing (the frontend emits
   * this only where the checker has already narrowed the expression to that
   * arm; see docs/ir.md). Refcounted payloads come out retained (+1). */
  | { kind: "unionNarrow"; unionId: string; tag: number; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Discriminant read `r.kind` on a union receiver: every arm is a
   * record/class possessing field `field` with the SAME primitive IR type
   * (f64|string|bool — `type`). Backends switch on the runtime tag and read
   * the field from the concretely-typed payload; string results come out
   * retained (+1). Composes with existing `strEq`/`bin`/`switch` nodes for
   * the narrowing tests themselves. */
  | { kind: "unionDisc"; unionId: string; field: string; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Keyed read `r.f` / `r[k]` on a union receiver whose arms answer
   * DIFFERENT (but joinable) types — the unionDisc generalization for
   * index-signature and optional-chain shapes (`env.PORTLESS_PORT` on
   * `ProcessEnv | Record<string, string>`, the tail read of
   * `loaded?.config.script`). `key` is a string-typed expression (a strLit
   * for dot access), evaluated ONCE before the tag switch. `type` is the
   * JOIN of the per-arm answers (each arm's declared answer is `type`
   * itself or one of its arms). Per arm, the backend answers: a record arm
   * with the key as a DECLARED field (literal keys only) reads the slot
   * and wraps into `type` when needed; a record arm with an index
   * signature goes through the per-(shape, type) keyed-read helper (the
   * recordKeyGet machinery — missing keys yield the undefined arm of
   * `type`, or trap when `type` has none, the same policy as the
   * single-record read); a UNIT arm (undefined/null — reachable only
   * through optional-chain tails, where JS answers undefined) yields the
   * interned undefined arm of `type`. The receiver and key are borrowed;
   * refcounted results are owned (+1). Never throws (a smuggled miss
   * traps in the helper). */
  | { kind: "unionKeyGet"; unionId: string; key: IrExpr; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Union tag test: true iff `value`'s runtime tag equals `tag` (negated:
   * differs). The narrowing test for UNIT arms — the frontend lowers
   * `v === undefined` / `v !== null` on a union-typed v here (tsc's
   * control-flow narrowing then types the branches, and reads inside them
   * bridge via unionNarrow as usual). Composes like unionDisc: the result
   * is a plain bool for if/while/ternary/! to consume. The union operand is
   * an ordinary borrowed temp; no ownership changes. */
  | {
      kind: "unionIsTag";
      unionId: string;
      tag: number;
      negated: boolean;
      value: IrExpr;
      type: IrType;
      loc: SrcLoc;
    }
  /** `===`/`!==` between two values of the SAME union: JS-exact strict
   * equality of the ARM values via a per-union interned helper — different
   * tags are never equal (distinct types, and null !== undefined), unit
   * arms of equal tag are equal, f64 arms compare with C `==` (NaN !== NaN,
   * +0 === -0), string arms compare bytes, bool arms compare values, and
   * ref arms (arrays, records, objects, functions, maps, sets, ...) compare
   * POINTER IDENTITY — exactly JS object equality. A union-vs-plain-arm
   * comparison (`u === "text"`) arrives here after the frontend wraps the
   * plain side (payload identity is preserved by the wrap, so ref-arm
   * semantics stay JS-exact). Operands are borrowed; result is a plain
   * bool. `negated` is the `!==` spelling. `sameValue` upgrades the f64
   * arm's compare from `===` to SameValue (NaN equals NaN, +0 differs
   * from -0) — the Object.is lowering; every other arm's compare is
   * shared between the two semantics. */
  | {
      kind: "unionEq";
      unionId: string;
      negated: boolean;
      sameValue: boolean;
      left: IrExpr;
      right: IrExpr;
      type: IrType;
      loc: SrcLoc;
    }
  /** Backend-special-cased operations. console.log: f64/string/bool args,
   * void. console.error (console.warn lowers here too — Node's warn IS
   * error): the same args and formatting, written to STDERR; stdout
   * flushes first so merged (2>&1) output keeps source order.
   * promise.race: every arg is a PROMISE (the array literal's
   * entries, lowered individually — the array never materializes), the
   * type is the checker's combined result promise; the backend emits a
   * fresh promise plus one scr_promise_race_add per entry with an
   * interned per-(entry-inner → result-inner) adapter (raceAdapterFor) —
   * same-type entries share the runtime's copy adapter, arm entries wrap
   * into the result union, sub-union entries re-tag arm-wise. First
   * settle wins; rejections copy raw and count handled on the entry.
   * promise.reject: one %Error-rooted arg (the reason — rejection
   * payloads share the thrown-Error representation), type is the
   * context-named result promise; the backend mints a fresh promise and
   * rejects it through the exception cell (scr_throw_obj +
   * scr_promise_reject_pending), so the result enters the unhandled
   * ledger until observed, exactly like a reject() call.
   * promise.resolve: zero args (Promise<void>) or one PLAIN value of the
   * result's inner type (promise arguments never reach here — the
   * frontend returns them as-is, the spec's native-promise identity;
   * thenables and promise-armed unions fence); the backend mints a fresh
   * promise and fulfills it immediately per the inner kind. */
  | {
      kind: "intrinsic";
      name:
        | "console.log"
        | "console.error"
        | "promise.race"
        | "promise.all"
        | "promise.reject"
        | "promise.resolve"
        | "module.await";
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
    }
  /** Standard-library call (`process` members, node:fs functions). `fn` is a
   * closed union; arg/result types are fixed per member (validated against
   * LIB_FN_SIGS). Property READS (`process.argv`, `process.platform`) are
   * zero-arg libCalls. Args are BORROWED by the operation (frame temps
   * release at statement end); refcounted results come back owned (+1) —
   * `process.argv` returns +1 on ONE interned array (JS identity:
   * `process.argv === process.argv` is true; mutations persist across
   * reads), everything else is fresh. fs.* members can throw (catchable
   * string payloads formatted like Node's messages) — backends must consult
   * the may-throw seed set (MAY_THROW_LIB_FNS) in their analysis and emit
   * pending checks; process.* members never throw. `process.exit` flushes
   * stdout and terminates the process without running exit handlers. */
  | {
      kind: "libCall";
      fn: IrLibFn;
      args: IrExpr[];
      type: IrType;
      loc: SrcLoc;
      prototypeIdentityOnly?: true;
    }
  /** `JSON.stringify(v)` — type-DIRECTED serialization: `value`'s static IR
   * type must be JSON-safe (f64/string/bool/record/array/union of those,
   * recursively — validated), and backends emit one serializer per type used
   * in stringify position (interned, like the array-HOF desugars) instead of
   * walking any runtime tag. Output is Node-compatible byte-for-byte with
   * ONE documented divergence: record fields serialize in canonical (sorted)
   * order, not insertion order (SEMANTICS.md). NaN/±Infinity stringify as
   * `null` and -0 as `0`, exactly like JS; a record field holding the
   * undefined arm of its union (an optional field) is DROPPED from the
   * output — Node's rule for undefined-valued properties. The value is
   * BORROWED; the result string is owned (+1). Never throws. */
  | { kind: "jsonStringify"; value: IrExpr; indent?: string; type: IrType; loc: SrcLoc }
  /** The dynamic-boundary check — a CHECKED cast `dynValue as T`: validate
   * the dyn value's JSON dyn against `type` (a non-dyn, JSON-representable
   * IR type) and BUILD the typed value (+1), or THROW a catchable
   * TypeError-flavored, path-annotated string ("TypeError: expected number
   * at $.items[2].price, got string") through the exception cell. Semantics:
   * numbers/strings/bools match strictly (no coercions); records are
   * WIDTH-TOLERANT (extra JSON keys are ignored — this is check-and-extract,
   * not shape equality; missing or wrong-typed fields throw, EXCEPT that a
   * missing key for an undefined-armed union field — an optional field —
   * builds the interned undefined arm instead); arrays check every element;
   * unions try arms in canonical order and the first FULL match wins (no
   * match → throw; an undefined arm matches no dyn value); JSON null matches
   * exactly the nullT arm of a union target (bare null targets cannot
   * exist). MAY THROW:
   * backends' may-throw analyses must treat it like a `throw` statement.
   * The dyn operand is borrowed; the result is owned (+1). This is
   * scriptc-specific behavior — JS `as` never checks (SEMANTICS.md
   * documents it as the headline divergence: a lying cast throws instead of
   * corrupting memory). `preserveRefs` refuses structural copies of native
   * references, including references nested in newly materialized arrays or
   * tuples; collection seeds use it to preserve key identity. */
  | { kind: "dynCheck"; value: IrExpr; preserveRefs?: true; type: IrType; loc: SrcLoc }
  /** Static → island marshal (--dynamic builds only). `value`'s type is
   * f64/string/bool (marshaled by value) or a JSON-safe composite
   * (record/array/union — marshaled as a DEEP COPY through the emitted
   * type-directed JSON serializer and the engine's JSON parser; the
   * aliasing divergence is documented in SEMANTICS.md). Result is an
   * owned (+1) jsval; the operand is borrowed. Never throws. */
  | { kind: "jsMarshal"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** An operation on island values (--dynamic builds only), executed by
   * the embedded engine with JS-exact semantics (coercions come from
   * pinned prelude closures, not C reimplementations). `args` are
   * jsval-typed and borrowed. Result `type` per op: arithmetic
   * (add/sub/mul/div/mod/pow), unary neg/plus, getProp/getIdx,
   * callMethod/callFn/callFnThis/globalGet → jsval (+1); comparisons
   * (lt/le/gt/ge/eq/neq), truthy, not → bool; typeof, toStr → string (+1);
   * setProp/setIdx → void. `name` carries the property/method identifier
   * for getProp/setProp/callMethod/globalGet, absent otherwise. MAY THROW
   * (engine
   * exceptions bridge into the exception cell, catchably) — backends'
   * may-throw analyses must seed on every jsOp like a `throw`. */
  | { kind: "jsOp"; op: IrJsOp; name?: string; args: IrExpr[]; type: IrType; loc: SrcLoc }
  /** Island → static validated exit (--dynamic builds only): `value` is
   * jsval-typed, `type` is the static target. STRICT for primitives (a
   * non-number refuses to exit as number — no coercion); composite
   * targets round-trip through the engine's JSON.stringify and the
   * existing dynCheck walker for the target (width-tolerant records,
   * path-annotated failures — identical semantics to `dyn as T`). MAY
   * THROW a catchable TypeError-shaped string. The operand is borrowed;
   * the result is owned (+1) for refcounted targets. */
  | { kind: "jsExit"; value: IrExpr; type: IrType; loc: SrcLoc }
  /** Island → static PROMISE bridge (--dynamic builds only): `value` is a
   * jsval whose declared type is Promise<T> (a package call's promise —
   * it lives in the engine); the result is a fresh pending static promise
   * the engine promise settles. `type` is promise-of-jsval (the settled
   * engine value crosses as a retained handle; typed uses exit like any
   * jsval) or promise-of-void (T mapped to void — nothing to carry).
   * Fulfillment wakes parked awaiters through the ready queue; rejection
   * crosses like a bridged exception (engine Errors become real static
   * Errors) and re-throws at the await or enters the unhandled ledger.
   * Bridging one engine promise twice makes two independent static
   * observers of the same settlement — semantically equivalent, slightly
   * redundant (SEMANTICS.md). Operand borrowed; result +1. MAY THROW
   * only on an engine-level surprise minting the subscription — backends
   * seed may-throw and emit the pending check like other island ops. */
  | { kind: "jsBridgePromise"; value: IrExpr; type: IrType; loc: SrcLoc };

/** The island operation set. Grouped by result type — see the jsOp node
 * doc. A closed union: every member has a lowering rule in the frontend,
 * a validation rule, and a scr_jsval_* implementation in scr_island.c. */
export type IrJsOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "mod"
  | "pow"
  | "neg"
  | "plus"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "eq"
  | "neq"
  /** `v instanceof C` where BOTH sides are island values (a package-
   * exported class as the RHS): the spec's InstanceofOperator in the
   * engine, Symbol.hasInstance included; a non-object RHS throws the
   * engine's own TypeError, bridged catchably. */
  | "instanceOf"
  | "truthy"
  | "not"
  | "typeof"
  | "toStr"
  | "getProp"
  | "setProp"
  | "getIdx"
  | "setIdx"
  | "callMethod"
  | "callFn"
  /** Calls an already-resolved island function with an explicit receiver.
   * Args are (callee, receiver, ...arguments); this preserves computed
   * method evaluation order without reading a getter twice. */
  | "callFnThis"
  /** Spread application on an island callee — `f(...pre, ...s)`, the
   * rest-forwarding idiom (`(...args) => g(...args)` under --dynamic).
   * Args are exactly (callee, pre, spread): `pre` is the engine array of
   * leading fixed arguments (jsOp arrLit), `spread` the spread source;
   * `name` carries the spread expression's source spelling (V8's nullish
   * spread-call TypeError spells it). The prelude helper uses REAL spread
   * syntax, so iterator protocols are the engine's own, with guards
   * front-running V8's exact spread-call TypeError texts. May throw. */
  | "callSpread"
  /** `new X(...)` where X is jsval-typed (package-declared classes):
   * JS_CallConstructor — args are the callee then the constructor
   * arguments, mirroring callFn. */
  | "construct"
  /** A member of the engine's global object by name (Math, parseFloat, ...)
   * — the receiver/callee for the island-backed ambient surface. Zero args;
   * `name` carries the global's identifier. May-throw for uniformity with
   * the other engine entries (the emitter's pending check runs after it). */
  | "globalGet"
  /** Island-native literals: an object literal / array literal whose
   * contextual type is `any` builds directly in the engine — objLit args
   * are alternating key/value jsvals (keys are marshaled strings), arrLit
   * args are the elements. Never throw. */
  | "objLit"
  | "arrLit"
  /** The engine-native TemplateStringsArray for an ISLAND TAG call: args
   * are 2n marshaled strings — n cooked then n raw — building a fresh
   * engine array whose `.raw` carries the raw spellings (tags dispatch on
   * it). Never throws. */
  | "tplStrings"
  /** Spread completion for an island-native object literal: copies
   * args[1]'s own enumerable properties onto args[0] (the spec's
   * CopyDataProperties — the engine's own Object.assign; null/undefined
   * sources spread nothing) and answers args[0] for chaining. May throw
   * (getters run). */
  | "objSpread"
  /** Accessor completion for an island-native object literal: defines a
   * GETTER property on args[0] (the object) — args are (obj, key string
   * marshal, getter function handle) — and answers the same object (the
   * chainable spelling: `defineGetter(objLit(...), k, f)`). The
   * self-referential doc-printer root-indent shape. Never throws. */
  | "defineGetter"
  /** The engine's own undefined / null as island values (zero args, never
   * throw): the unit arms of a union marshaling IN (`string | undefined`
   * into an 'any' slot — the undefined arm IS the engine undefined), and
   * conceptually the unit path of `x?.y` on 'any' (the emitter inlines
   * that one). */
  | "undefLit"
  | "nullLit"
  /** GetIterator over an island value — the for-of head over 'any' (the
   * engine's own protocol lookup; V8's not-iterable TypeError on refusal).
   * The loop drives next() through callMethod and reads value/done with
   * getProp/truthy. */
  | "iterNew"
  /** `o.name?.(...)` — the optional METHOD call on an island receiver: a
   * nullish member answers the engine's undefined, anything else calls
   * with `this = o` (JS-exact; non-callables throw in the engine). */
  | "optCallMethod";

/** Result-type rule for each island op (the validator enforces it; the
 * frontend constructs nodes with exactly these). */
export function jsOpResultKind(op: IrJsOp): "jsval" | "bool" | "string" | "void" {
  switch (op) {
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "mod":
    case "pow":
    case "neg":
    case "plus":
    case "getProp":
    case "getIdx":
    case "callMethod":
    case "callFn":
    case "callFnThis":
    case "callSpread":
    case "construct":
    case "globalGet":
    case "objLit":
    case "arrLit":
    case "defineGetter":
    case "tplStrings":
    case "objSpread":
    case "undefLit":
    case "nullLit":
    case "iterNew":
    case "optCallMethod":
      return "jsval";
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "eq":
    case "neq":
    case "instanceOf":
    case "truthy":
    case "not":
      return "bool";
    case "typeof":
    case "toStr":
      return "string";
    case "setProp":
    case "setIdx":
      return "void";
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** True when a type is a union with an undefined arm — the optional-flavored
 * slot marker shared by the frontend (record literals may omit such fields)
 * and backends (JSON serializers DROP such fields when they hold undefined,
 * dynCheck builders produce the undefined arm for a MISSING key). Note the
 * question is about the TYPE, not a declaration's `?:` token: without
 * exactOptionalPropertyTypes, `{a?: string}` and `{a: string | undefined}`
 * are the same shape and behave identically — which is exactly Node's rule
 * (JSON.stringify drops ANY undefined-valued field, declared optional or
 * not). */
export function isUndefinedArmedUnion(
  t: IrType,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  if (t.kind !== "union") return false;
  const def = getUnion(t.unionId);
  return !!def && def.arms.some((a) => a.kind === "undefinedT");
}

/** True when a type is JSON-representable — the shared fence for
 * `jsonStringify` (what can be serialized) and `dynCheck` (what a dyn value
 * can be validated against): f64, string, bool, records, arrays, and unions
 * of those, recursively. Closures, class instances, dyn itself, and void are
 * not JSON. Registry lookups are parameters because the frontend holds
 * registries and the validator/backend hold maps. RECURSIVE shapes/unions
 * are handled COINDUCTIVELY (a revisited shape answers true — safety is
 * decided by the rest of the graph): a recursive TYPE is JSON-safe when
 * every reachable constituent is; a cyclic VALUE of such a type throws
 * Node's circular-structure TypeError at runtime instead. */
export function isJsonSafeType(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  return isJsonSafeAt(t, getRecord, getUnion, false, false, new Set());
}

/** The JSON.stringify-only domain additionally admits undefined arms in
 * array and tuple positions, where Node emits null. A bare undefined-armed
 * root remains outside the domain because JSON.stringify returns the
 * undefined value instead of a string. */
export function isJsonStringifySafeType(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  return isJsonSafeAt(t, getRecord, getUnion, true, false, new Set());
}

/** A JSON-shaped container with unknown payloads needs the runtime JSON
 * traversal. Its declared structure can be boxed, but payloads may carry
 * omitted values, toJSON methods, or cycles. This predicate does not widen
 * the type-directed serializer, checked-island boundary, or root-undefined
 * contract; callers must select the checked runtime traversal explicitly. */
export function isJsonStringifyDynamicType(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  return (
    (t.kind === "record" || t.kind === "array" || t.kind === "union") &&
    isJsonSafeAt(t, getRecord, getUnion, true, false, new Set(), true) &&
    !isJsonStringifySafeType(t, getRecord, getUnion)
  );
}

/** The recursion shared by checked JSON conversion and stringification.
 * Ordinary record fields always admit undefined by dropping the key. Array
 * and tuple slots admit it only for stringification, which writes null.
 * Direct loops avoid allocating captured callbacks at each recursive edge. */
function isJsonSafeAt(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  stringify: boolean,
  undefinedAllowed: boolean,
  visiting: Set<string>,
  nativeFields = false,
): boolean {
  if (HANDLE_KINDS.has(t.kind)) return false;
  switch (t.kind) {
    case "dyn":
      return nativeFields;
    case "f64":
    case "string":
    case "bool":
      return true;
    case "array":
      return isJsonSafeAt(
        t.elem,
        getRecord,
        getUnion,
        stringify,
        stringify,
        visiting,
        nativeFields,
      );
    case "record": {
      const shape = getRecord(t.shapeId);
      if (!shape) return false;
      if (recordTextCodecClass(shape) !== null) return false;
      // The recursive knot: answer true and let the rest of the graph
      // decide (any unsafe constituent ends the traversal immediately).
      if (visiting.has(t.shapeId)) return true;
      visiting.add(t.shapeId);
      for (const field of shape.fields) {
        if (
          !isJsonSafeAt(
            field.type,
            getRecord,
            getUnion,
            stringify,
            !shape.tuple || stringify,
            visiting,
            nativeFields,
          )
        )
          return false;
      }
      // Overflow values sit in record-key position too: dyn is JSON-safe
      // HERE (the checked-dynamic tree serializes itself; undefined-valued entries drop
      // like any undefined-valued key), everything else follows the
      // record-field rule.
      if (shape.indexValue && shape.indexValue.kind !== "dyn") {
        return isJsonSafeAt(
          shape.indexValue,
          getRecord,
          getUnion,
          stringify,
          true,
          visiting,
          nativeFields,
        );
      }
      return true;
    }
    case "union": {
      const def = getUnion(t.unionId);
      if (!def) return false;
      const key = `${t.unionId}:${stringify}:${undefinedAllowed}`;
      if (visiting.has(key)) return true; // the recursive knot, union-flavored
      visiting.add(key);
      for (const arm of def.arms) {
        if (
          !(arm.kind === "undefinedT"
            ? undefinedAllowed
            : isJsonSafeAt(
                arm,
                getRecord,
                getUnion,
                stringify,
                undefinedAllowed,
                visiting,
                nativeFields,
              ))
        )
          return false;
      }
      return true;
    }
    case "set":
      return nativeFields && !stringify && t.elem.kind === "dyn";
    case "bigint":
    case "regex":
    case "url":
      return nativeFields && !stringify;
    case "bytes":
      return nativeFields;
    case "func":
    case "object":
    // Class values stringify as "{}" husks in Node (own enumerable statics
    // aside — not representable type-directedly); rejected like Maps.
    case "classval":
    // Maps are not JSON (JSON.stringify(new Map()) is "{}" in Node — an
    // empty-object husk nobody wants; stringify/dynCheck reject instead).
    case "map":
    case "date":
    // URLSearchParams stringifies as the same "{}" husk — rejected; use
    // sp.toString() instead.
    case "searchParams":
    // Symbols are DROPPED by Node's stringify (undefined at the top level,
    // omitted as object values) — silent divergence banned; rejected.
    case "symbol":
    case "jsval":
    case "caught":
    case "promise":
    case "generator":
    case "moduleNs":
    case "void":
      return false;
    // Record fields drop undefined. Stringification also represents it in
    // array and tuple slots as null; bare roots remain fenced.
    case "undefinedT":
      return undefinedAllowed;
    // JSON null ↔ the nullT arm: null-armed unions stringify (`null`) and
    // validate (a JSON null matches exactly the nullT arm).
    case "nullT":
      return true;
    default: {
      const _exhaustive: never = t as Exclude<typeof t, HandleType>;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** THE island boundary predicate: true when a static type can cross into
 * the island (jsMarshal — primitives by value, composites as deep JSON
 * copies) and back out (jsExit — strict primitive extraction, composites
 * through the dynCheck walker). Primitives are JSON-safe, so the rule
 * coincides with isJsonSafeType; it has its own name because the boundary
 * is its own concept — the frontend's implicit coercions, the explicit-cast
 * lowering, and the validator's jsMarshal/jsExit rules all ask this ONE
 * question, and the boundary rejection messages describe exactly this set. */
export function canCrossIslandBoundary(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  return isJsonSafeType(t, getRecord, getUnion);
}

/** True for a closure type that can cross INTO the island as a host
 * function: every parameter jsval (the engine's arguments pass through as
 * handles — no per-type extraction exists inside a host call) and the
 * result jsval, void, or a primitive (which marshals back by value —
 * `(x) => x * 2` on an 'any' x infers a number return). Contextual typing
 * produces exactly this shape for callbacks passed to package APIs
 * (`.action((a, b) => ...)` against `(...args: any[]) => void`). Arity is
 * capped by the runtime's host-call argument buffer (scr_island.c). */
export const MAX_ISLAND_CALLBACK_ARITY = 16;
export function canMarshalFuncIntoIsland(t: IrType): boolean {
  return (
    t.kind === "func" &&
    t.rest !== true &&
    t.params.length <= MAX_ISLAND_CALLBACK_ARITY &&
    t.params.every((p) => p.kind === "jsval") &&
    (t.ret.kind === "jsval" ||
      t.ret.kind === "void" ||
      t.ret.kind === "f64" ||
      t.ret.kind === "bool" ||
      t.ret.kind === "string")
  );
}

/** Parameter types a TYPED closure may declare when it crosses INTO the
 * island as a host function: jsval params take the engine argument as a
 * handle (the all-'any' shape above); dyn params normalize scalars or retain
 * engine objects by reference. Every other admitted type converts
 * AT CALL TIME through the validated-exit machinery — strict primitives,
 * JSON round-trip composites (the dynCheck walker: width-tolerant records,
 * path-annotated failures). On top of the jsExit set, a bare `T | undefined`
 * union is admitted here — an absent or undefined engine argument takes the
 * undefined arm, exactly the missing-optional-field rule (and exactly the
 * commander case: `.action((text: string | undefined, opts) => ...)` sees
 * undefined when the command argument is omitted). */
export function isIslandCallbackParamType(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  if (t.kind === "jsval" || t.kind === "dyn") return true;
  if (isJsonSafeType(t, getRecord, getUnion)) return true;
  if (t.kind === "union") {
    // A bare undefined-armed union: every non-undefined arm must be
    // JSON-safe (arms never nest unions, so plain isJsonSafeType applies).
    const def = getUnion(t.unionId);
    return (
      !!def &&
      def.arms.every((a) => a.kind === "undefinedT" || isJsonSafeType(a, getRecord, getUnion))
    );
  }
  return false;
}

/** Classify a typed island callback's RETURN for adapter synthesis: sync
 * kinds marshal back by value ('void'|'jsval'|'f64'|'bool'|'string' — the
 * canMarshalFuncIntoIsland set), 'json' marshals a JSON-safe composite
 * through the type-directed serializer + engine parse (the jsMarshal
 * composite path — commander's option-argument collectors return arrays
 * this way), and a Promise of the by-value kinds wraps as an engine
 * promise settled when the scriptc promise settles (async callbacks —
 * the `.action(async ...)` case). Null for anything else (Promise of
 * composites: still fenced). */
export function islandCallbackRet(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): { async: boolean; tag: "void" | "jsval" | "f64" | "bool" | "string" | "json" | "dyn" } | null {
  const tagOf = (r: IrType) =>
    r.kind === "void" ||
    r.kind === "jsval" ||
    r.kind === "f64" ||
    r.kind === "bool" ||
    r.kind === "string"
      ? r.kind
      : null;
  if (t.kind === "promise") {
    const tag = tagOf(t.inner);
    return tag ? { async: true, tag } : null;
  }
  const tag = tagOf(t);
  if (tag) return { async: false, tag };
  // A CHECKED-DYNAMIC result (a JS getter/callback whose inferred return
  // degraded — the doc-printer root-indent getter): the dyn value deep-
  // copies into the engine on return, exactly the jsMarshal dyn rule
  // (data kinds only; boxed functions/handles throw the catchable
  // TypeError). Sync only — no engine-promise tag exists for dyn values.
  if (t.kind === "dyn") return { async: false, tag: "dyn" };
  return isJsonSafeType(t, getRecord, getUnion) ? { async: false, tag: "json" } : null;
}

/** The TYPED extension of canMarshalFuncIntoIsland (a strict superset):
 * closures whose params are per-argument-convertible at call time
 * (isIslandCallbackParamType) and whose return classifies
 * (islandCallbackRet). Same arity cap — the runtime's host-call argument
 * buffer. Statically typed closure parameters stay fenced; unknown values
 * enter as checked-dynamic values and are validated at each typed use. */
export function canMarshalTypedFuncIntoIsland(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  if (t.kind !== "func") return false;
  // The ISLAND-REST form (`async (...args) =>` in JS under --dynamic —
  // the withPlugins wrapper): the trailing ABI param is the ENGINE array
  // of the call's surplus arguments; leading params convert per argument
  // like any typed callback. Plain rest signatures (dynRest, typed
  // rests) stay out — no completed-ABI spelling exists for them here.
  if (t.rest === true) {
    return (
      t.restAbi === "jsval" &&
      t.params.length >= 1 &&
      t.params.length <= MAX_ISLAND_CALLBACK_ARITY &&
      t.params[t.params.length - 1]!.kind === "jsval" &&
      t.params.slice(0, -1).every((p) => isIslandCallbackParamType(p, getRecord, getUnion)) &&
      islandCallbackRet(t.ret, getRecord, getUnion) !== null
    );
  }
  return (
    t.params.length <= MAX_ISLAND_CALLBACK_ARITY &&
    t.params.every((p) => isIslandCallbackParamType(p, getRecord, getUnion)) &&
    islandCallbackRet(t.ret, getRecord, getUnion) !== null
  );
}

/* ── the checked-dynamic FUNCTION boundary ──────────────────────────────
 * The STATIC twin of the island's typed-function marshaling
 * (canMarshalTypedFuncIntoIsland): closures cross the dyn boundary as a
 * callable dyn kind carrying the closure + a compiled per-signature call
 * thunk. Two directions, two predicates, mutually recursive with the
 * conversion domains (function types cannot ride records/unions — jsonSafe
 * excludes them — so the recursion terminates):
 *
 * IN (canBoxFuncIntoDyn, the dynFrom domain's function arm): calling the
 * box happens with DYN arguments, so every declared param must be
 * dynCheckABLE (the thunk validates each argument into it) and the result
 * must convert BACK to dyn (dynFrom's domain, functions included — a
 * wrapper returning a wrapper boxes recursively).
 *
 * OUT (canAdaptDynFuncTo, the dynCheck domain's function arm): a dyn
 * function landing in a typed func slot either unwraps directly (the boxed
 * signature key equals the target's — same type, same ABI) or wraps in a
 * per-target ADAPTER closure that converts each typed argument INTO dyn
 * (so params must be dyn-convertible) and validates the dyn result into
 * the target's return type (so the return must be dynCheckable).
 *
 * Deliberately fenced OUT of both directions: generic signatures (no
 * concrete IR type exists), this-parameters, construct signatures (`new`
 * through a dyn value), properties ON function values, and params/results
 * outside the conversion domains (Maps, class instances, ...). Promises
 * CONVERT in (canConvertToDyn's promise arm — an async dyn-boxed closure's
 * return); checking OUT preserves the boxed Promise<unknown> payload ABI.
 */

/** The runtime HANDLE kinds that cross the checked-dynamic boundary as
 * the checked-dynamic tree's HANDLE kind (SCR_DYN_HANDLE): boxed by REFERENCE (identity —
 * stateful I/O objects never copy), unboxed by tag check, members
 * dispatched at runtime onto the same entry points the static lowerings
 * use. The set is deliberately the handles whose member surfaces have
 * complete static lowerings (the http/net receiver surface —
 * `server.on('request', mustCall((req, res) => ...))` is the canonical
 * crossing); other handle kinds keep the honest cannot-box fence. Each
 * entry carries the runtime tag spelling and the class display name
 * (dynCheck's "expected IncomingMessage ..." texts). */
export const DYN_HANDLE_KINDS: ReadonlyMap<string, { tag: string; cls: string }> = new Map([
  ["child", { tag: "SCR_DYNH_CHILD", cls: "ChildProcess" }],
  ["fileHandle", { tag: "SCR_DYNH_FILE_HANDLE", cls: "FileHandle" }],
  ["httpReq", { tag: "SCR_DYNH_HTTP_REQ", cls: "IncomingMessage" }],
  ["httpRes", { tag: "SCR_DYNH_HTTP_RES", cls: "ServerResponse" }],
  ["netSocket", { tag: "SCR_DYNH_NET_SOCKET", cls: "Socket" }],
  ["netServer", { tag: "SCR_DYNH_NET_SERVER", cls: "Server" }],
  ["http2Session", { tag: "SCR_DYNH_H2_SESSION", cls: "Http2Session" }],
  ["http2Stream", { tag: "SCR_DYNH_H2_STREAM", cls: "Http2Stream" }],
  ["httpClientReq", { tag: "SCR_DYNH_HTTP_CLIENT", cls: "ClientRequest" }],
]);

/** A class value that crosses an `unknown` slot as a compiler-owned typed
 * reference. %Error keeps its dedicated error encoding; every other class
 * preserves the original object identity and exposes a materialized own-field
 * view only when a checked-dynamic operation actually needs one. */
export function isDynTypedRefType(t: IrType): t is Extract<IrType, { kind: "object" }> {
  return t.kind === "object" && !RUNTIME_ERROR_CLASSES.has(t.className);
}

/** Whether a class layout field is an ECMAScript own enumerable property.
 * `#private` slots and `%`-prefixed compiler storage exist only in the native
 * layout; TypeScript `private`/`protected` fields keep ordinary names and are
 * observable properties at runtime. */
export function isClassOwnEnumerableFieldName(name: string): boolean {
  return !name.startsWith("#") && !name.startsWith("%");
}

/** Compiler-owned storage for properties added through untyped references. */
export const DYN_CLASS_PROPERTIES = "%dynProperties";

/** A class capsule can always preserve its exact native identity. Its
 * optional property view additionally needs converters in both directions;
 * fields such as Maps may remain opaque without preventing the round trip. */
export function classDynViewSupported(
  fields: readonly { name: string; type: IrType }[],
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  const checkable = (type: IrType): boolean => {
    if (isDynTypedRefType(type) || isUnitType(type)) return true;
    if (type.kind === "union") return getUnion(type.unionId)?.arms.every(checkable) ?? false;
    return canDynCheckTo(type, getRecord, getUnion);
  };
  return fields.every(
    (field) =>
      !isClassOwnEnumerableFieldName(field.name) ||
      (canConvertToDyn(field.type, getRecord, getUnion) && checkable(field.type)),
  );
}

/** A static type that CONVERTS into a dyn value — the dynFrom domain:
 * JSON-safe data, numeric typed arrays (retained views), identity-preserving class
 * references, undefined-armed unions of those arms, boxable function types,
 * and the runtime HANDLE kinds (boxed by reference — DYN_HANDLE_KINDS). */
export function canConvertToDyn(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  visiting: Set<string> = new Set(),
): boolean {
  if (isJsonSafeType(t, getRecord, getUnion)) return true;
  // numeric typed arrays and boxable functions are dyn kinds the walker boxes
  // ANYWHERE (bytes and functions held by identity), including nested
  // in records/arrays/unions. isJsonSafeType rejects them, but dynFrom
  // needs only that the walker can build the dyn value, so this composite
  // fold extends the JSON-safe core.
  if (canBoxDynComposite(t, getRecord, getUnion, visiting)) return true;
  if (t.kind === "bytes") return true;
  // Built-in errors convert as the checked-dynamic tree's error encoding ({%error, name, message,
  // code?} — the caughtToDyn shape, scr_dyn_from_error): the dyn 'error'
  // listener boundary (a mustCall-wrapped handler receiving the payload).
  if (t.kind === "object" && RUNTIME_ERROR_CLASSES.has(t.className)) return true;
  if (isDynTypedRefType(t)) return true;
  if (t.kind === "generator") return true;
  if (t.kind === "classval") return true;
  if (t.kind === "func") return canBoxFuncIntoDyn(t, getRecord, getUnion, visiting);
  if (DYN_HANDLE_KINDS.has(t.kind)) return true;
  // Promises box by REFERENCE (SCR_DYN_PROMISE): promise<dyn> carries its
  // ScrPromise directly (the payload is already a dyn value), any other
  // convertible-or-void inner boxes an ADAPTER promise whose emitted
  // settle callback converts the payload (rejections copy raw — reasons
  // are dynamically tagged). The dc tracePromise boundary and dyn-boxed
  // async closures are the crossings.
  if (t.kind === "promise") {
    return (
      t.inner.kind === "dyn" ||
      t.inner.kind === "void" ||
      canConvertToDyn(t.inner, getRecord, getUnion, visiting)
    );
  }
  if (t.kind === "union") {
    const def = getUnion(t.unionId);
    // JSON-safe arms box as before; BOXABLE FUNCTION and PROMISE arms join them (the
    // invalid-input probes iterate `[1, null, () => {}, true]` — the
    // union's func arm crosses through the checked-dynamic function
    // boundary exactly like a bare func dynFrom).
    return (
      !!def &&
      def.arms.every(
        (a) =>
          a.kind === "undefinedT" ||
          isJsonSafeType(a, getRecord, getUnion) ||
          isDynTypedRefType(a) ||
          a.kind === "classval" ||
          DYN_HANDLE_KINDS.has(a.kind) ||
          (a.kind === "func" && canBoxFuncIntoDyn(a, getRecord, getUnion, visiting)) ||
          (a.kind === "promise" && canConvertToDyn(a, getRecord, getUnion, visiting)),
      )
    );
  }
  return false;
}

/** The composite extension of the dynFrom domain: JSON-safe scalars plus
 * numeric typed arrays and boxable functions anywhere, recursing through records
 * (fields + index value), arrays, and unit-armed unions — exactly the
 * sc_td_* walker's capability. Map and Set payloads must also support
 * checked extraction back into native storage. Other unsupported nested
 * kinds retain their conversion fence. */
function canBoxDynComposite(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  visiting: Set<string> = new Set(),
): boolean {
  const key = `boxed:${typeKey(t)}`;
  if (visiting.has(key)) return true;
  const result = canBoxDynCompositeAt(t, getRecord, getUnion, visiting);
  if (result) visiting.add(key);
  else clearDynConversionResults(visiting);
  return result;
}

function canBoxDynCompositeAt(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  visiting: Set<string>,
): boolean {
  switch (t.kind) {
    case "procStream":
    case "f64":
    case "bigint":
    case "symbol":
    case "string":
    case "bool":
    case "dyn":
    case "undefinedT":
    case "nullT":
    case "classval":
      return true;
    case "bytes":
    case "regex":
    case "url":
    case "searchParams":
      return true;
    case "func":
      return canBoxFuncIntoDyn(t, getRecord, getUnion, visiting);
    case "set":
      return (
        canConvertToDyn(t.elem, getRecord, getUnion, visiting) &&
        canDynCheckTo(t.elem, getRecord, getUnion, visiting)
      );
    case "map":
      return (
        canConvertToDyn(t.key, getRecord, getUnion, visiting) &&
        canDynCheckTo(t.key, getRecord, getUnion, visiting) &&
        canConvertToDyn(t.value, getRecord, getUnion, visiting) &&
        canDynCheckTo(t.value, getRecord, getUnion, visiting)
      );
    case "object":
      return RUNTIME_ERROR_CLASSES.has(t.className) || isDynTypedRefType(t);
    case "array":
      // Process streams have scalar storage only in fields, closures and
      // unions. A direct procStream array has no native ScrArr layout.
      return (
        t.elem.kind !== "procStream" && canBoxDynComposite(t.elem, getRecord, getUnion, visiting)
      );
    case "record": {
      const shape = getRecord(t.shapeId);
      if (!shape) return false;
      if (recordTextCodecClass(shape) !== null) return false;
      // Recursive shapes answer coinductively, like isJsonSafeType.
      if (visiting.has(t.shapeId)) return true;
      visiting.add(t.shapeId);
      try {
        for (const field of shape.fields) {
          if (!canBoxDynComposite(field.type, getRecord, getUnion, visiting)) return false;
        }
        return (
          !shape.indexValue || canBoxDynComposite(shape.indexValue, getRecord, getUnion, visiting)
        );
      } finally {
        visiting.delete(t.shapeId);
      }
    }
    case "union": {
      const def = getUnion(t.unionId);
      if (!def) return false;
      if (visiting.has(t.unionId)) return true;
      visiting.add(t.unionId);
      try {
        for (const arm of def.arms) {
          if (!canBoxDynComposite(arm, getRecord, getUnion, visiting)) return false;
        }
        return true;
      } finally {
        visiting.delete(t.unionId);
      }
    }
    default:
      return false;
  }
}

/** A type a dyn value can be VALIDATED into — the dynCheck domain:
 * JSON-safe data, numeric typed arrays (retained views), the %Error extraction,
 * undefined-armed unions of JSON-safe arms, adaptable function types,
 * and the runtime HANDLE kinds (a tag-checked reference unwrap —
 * DYN_HANDLE_KINDS). */
export function canDynCheckTo(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  visiting: Set<string> = new Set(),
): boolean {
  const key = `checked:${typeKey(t)}`;
  if (visiting.has(key)) return true;
  const result = canDynCheckToAt(t, getRecord, getUnion, visiting);
  if (result) visiting.add(key);
  else clearDynConversionResults(visiting);
  return result;
}

/** Reuse completed subgraphs within one conversion query. A failed branch
 * invalidates successes that may depend on a coinductive back-edge to it;
 * active recursion keys remain until their owning calls unwind. */
function clearDynConversionResults(visiting: Set<string>): void {
  for (const key of visiting) {
    if (key.startsWith("boxed:") || key.startsWith("checked:")) visiting.delete(key);
  }
}

function canDynCheckToAt(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  visiting: Set<string>,
): boolean {
  if (t.kind === "procStream") return true;
  // Unknown fields keep an owned dyn subtree; checking the surrounding
  // record/array still validates its layout. This is broader than the
  // stringify/island JSON domain, which cannot assume opaque slots are
  // serializable. Backends already retain dyn fields and fill missing
  // unknown record fields with the undefined value.
  if (isJsonSafeAt(t, getRecord, getUnion, false, false, new Set(), true)) return true;
  if (t.kind === "bigint" || t.kind === "symbol" || t.kind === "date" || t.kind === "searchParams")
    return true;
  if (t.kind === "map" || t.kind === "set")
    return canBoxDynComposite(t, getRecord, getUnion, visiting);
  if (t.kind === "bytes") return true;
  if (t.kind === "classval") return true;
  if (t.kind === "generator") return true;
  if (t.kind === "promise")
    return (
      t.inner.kind === "dyn" ||
      t.inner.kind === "void" ||
      canDynCheckToAt(t.inner, getRecord, getUnion, visiting)
    );
  if (t.kind === "object" && t.className === "%Error") return true;
  // Native class capsules already support checked extraction at ordinary
  // boundaries. Callable adapters use the same identity/brand check.
  if (isDynTypedRefType(t)) return true;
  if (t.kind === "array") {
    if (t.elem.kind === "procStream") return false;
    const key = typeKey(t);
    if (visiting.has(key)) return false;
    visiting.add(key);
    const result = canDynCheckTo(t.elem, getRecord, getUnion, visiting);
    visiting.delete(key);
    return result;
  }
  if (t.kind === "record") {
    const key = typeKey(t);
    if (visiting.has(key)) return false;
    const shape = getRecord(t.shapeId);
    if (!shape || shapeHasAccessorSlots(shape)) return false;
    visiting.add(key);
    const result =
      shape.fields.every((field) => canDynCheckTo(field.type, getRecord, getUnion, visiting)) &&
      (!shape.indexValue || canDynCheckTo(shape.indexValue, getRecord, getUnion, visiting));
    visiting.delete(key);
    return result;
  }
  if (t.kind === "func") return canAdaptDynFuncTo(t, getRecord, getUnion, visiting);
  if (DYN_HANDLE_KINDS.has(t.kind)) return true;
  if (t.kind === "union") {
    const def = getUnion(t.unionId);
    // Optional native callbacks and handles retain the same checked
    // conversion as their bare value. The union matcher selects the arm
    // before its adapter/extractor runs.
    return (
      !!def &&
      def.arms.every(
        (a) =>
          isUnitType(a) || (a.kind !== "union" && canDynCheckTo(a, getRecord, getUnion, visiting)),
      )
    );
  }
  return false;
}

/** A closure type that can BOX into the checked-dynamic tree's function kind (dynFrom):
 * every param dyn or dynCheckable (the thunk validates dyn arguments into
 * them), return void, dyn, or dyn-convertible (the thunk converts it
 * back). */
export function canBoxFuncIntoDyn(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  visiting: Set<string> = new Set(),
): boolean {
  return (
    t.kind === "func" &&
    // Typed rest occupies the final native array parameter; its thunk
    // checks a fresh array containing all remaining call arguments.
    // Island rest keeps its separate engine host-callback adapter.
    (t.rest !== true ||
      t.restAbi === undefined ||
      (t.restAbi === "typed" && t.params.at(-1)?.kind === "array")) &&
    // A jsval (island) param converts through scr_jsval_from_dyn in the
    // thunk (wrapped cells unwrap by reference, dyn data deep-copies) —
    // the checker-'any' callback params of the routed-dispatch lane
    // (`bag.list.map((x) => ...)` with x typed any).
    t.params.every(
      (p) =>
        p.kind === "dyn" || p.kind === "jsval" || canDynCheckTo(p, getRecord, getUnion, visiting),
    ) &&
    // A jsval return converts through the by-reference wrap
    // (dynFromJsval — the thunk's result conversion), so engine-returning
    // callbacks box too: the routed-dispatch lane's flatMap shape.
    (t.ret.kind === "void" ||
      t.ret.kind === "dyn" ||
      t.ret.kind === "jsval" ||
      canConvertToDyn(t.ret, getRecord, getUnion, visiting))
  );
}

/** A closure type a dyn function value can ADAPT to (dynCheck): every
 * param dyn or dyn-convertible (the adapter converts typed arguments into
 * dyn), return void, dyn, or dynCheckable (the adapter validates the dyn
 * result). */
export function canAdaptDynFuncTo(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  visiting: Set<string> = new Set(),
): boolean {
  return (
    t.kind === "func" &&
    // Checked rest and arguments packs retain all actual arguments. Typed
    // and island rest ABIs still require their own conversion plan.
    (t.rest !== true || t.restAbi === undefined) &&
    t.params.every((p) => p.kind === "dyn" || canConvertToDyn(p, getRecord, getUnion, visiting)) &&
    (t.ret.kind === "void" ||
      t.ret.kind === "dyn" ||
      canDynCheckTo(t.ret, getRecord, getUnion, visiting))
  );
}

/** The MARSHAL-direction boundary (jsMarshal): everything that can cross
 * out and back (canCrossIslandBoundary) plus qualifying closures — those
 * enter as host functions but never EXIT (jsExit keeps the narrower
 * predicate). */
export function canMarshalIntoIsland(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  return isJsonSafeType(t, getRecord, getUnion) || canMarshalFuncIntoIsland(t);
}

/** The EXIT-direction boundary (jsExit): everything round-trippable
 * (canCrossIslandBoundary) plus BARE undefined/null-armed unions whose
 * data arms are all JSON-safe — the engine's undefined takes the
 * undefined arm before the JSON detour (JSON cannot spell undefined, and
 * bare undefined-armed unions are JSON-unsafe for exactly that reason),
 * null and data ride the round trip into the union's dynCheck. The
 * package-API shape `result.headers` : `Record<string, string> |
 * undefined` is the motivating case. */
/** The static-promise→engine bridge's payload domain: the fulfillment
 * types a scriptc promise may deliver INTO the island as a real engine
 * thenable (scr_jsval_from_promise — the async-callback return bridge,
 * reused by promise VALUES crossing at jsvalIn edges and the island
 * Promise.all arm). Null = outside the domain (the boundary fence). */
export function islandPromisePayloadTag(
  inner: IrType,
): "void" | "f64" | "bool" | "string" | "jsval" | "jsvalArr" | null {
  switch (inner.kind) {
    case "void":
      return "void";
    case "f64":
      return "f64";
    case "bool":
      return "bool";
    case "string":
      return "string";
    case "jsval":
      return "jsval";
    case "array":
      return inner.elem.kind === "jsval" ? "jsvalArr" : null;
    default:
      return null;
  }
}

export function canExitIslandToType(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  if (canCrossIslandBoundary(t, getRecord, getUnion)) return true;
  // Uint8Array exits with a validated kind check + copy (engine Buffers
  // pass — they ARE Uint8Arrays); other element widths stay out.
  if (t.kind === "bytes" && t.elem === "u8") return true;
  // `any[]`-declared slots (the jsval-element-array spelling): the engine
  // array exits Array.isArray-gated, elements BY REFERENCE (identity
  // crosses; the withPlugins `loadPlugins(plugins)` boundary).
  if (t.kind === "array" && t.elem.kind === "jsval") return true;
  if (t.kind === "union") {
    const def = getUnion(t.unionId);
    if (!def || !def.arms.some((a) => a.kind === "undefinedT")) return false;
    if (def.arms.every((a) => isUnitType(a) || isJsonSafeType(a, getRecord, getUnion))) return true;
    // `any[] | undefined` (the defaulted-parameter spelling): exactly one
    // jsval-element-array data arm beside units — the engine's undefined
    // takes the undefined arm, everything else the array exit.
    const dataArms = def.arms.filter((a) => !isUnitType(a));
    return (
      dataArms.length === 1 && dataArms[0]!.kind === "array" && dataArms[0]!.elem.kind === "jsval"
    );
  }
  return false;
}
