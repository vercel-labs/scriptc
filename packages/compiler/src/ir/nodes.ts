import { InternalCompilerError } from "../errors.js";
/* scriptc IR — the only interface between frontend and backends.
 *
 * Design rules (see docs/ir.md for node-by-node semantics):
 * - Plain JSON-safe discriminated unions: no classes, no parent pointers,
 *   no cycles. Cross-references are by string id.
 * - Every node carries `loc` (source span) and every expression carries its
 *   computed `type` — backends never re-derive types.
 * - Structured control flow (statement tree), not basic blocks: the only
 * current backend is C and there are no optimization passes yet. When a mid-end
 *   arrives, a structured→CFG lowering pass slots in after validation.
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

/** The typed-array element kinds with a runtime representation: exactly
 * the constructors real CLI code reaches (Uint8Array/Buffer, Uint32Array,
 * Int32Array — the Atomics.wait sleep idiom's array — Float32Array). The
 * other TypedArray flavors stay frontend-fenced. */
export type IrBytesElem = "u8" | "u32" | "i32" | "f32";

export type IrType =
  | { kind: "f64" }
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
   * exactly the array pattern (never per-instantiation structs). Keys are
   * f64 or string (SameValueZero); values are f64, string, bool, record,
   * object, union, or array — anything isRefCounted or scalar EXCEPT
   * func/promise/dyn/jsval/map (frontend-fenced, validator-checked). */
  | { kind: "map"; key: IrType; value: IrType }
  /** ES `Set<T>` — heap, refcounted, insertion-ordered. Map's sibling with
   * the value slot removed: ONE runtime representation (the backend lowers
   * sets onto the map runtime with a constant unit value), elements are
   * exactly Map's KEY types — f64 or string, SameValueZero. Same container
   * fences as map (no union arms, no array elements, no map values, no sets
   * of sets, not JSON-safe) and never cycle-capable: elements are scalars
   * or strings, which cannot point back. */
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
  /** A typed array / Node Buffer (Uint8Array, Uint32Array, Float32Array;
   * Buffer IS a Uint8Array subclass and shares the u8 kind) — heap,
   * refcounted, MUTABLE, fixed-length, with ONE runtime representation
   * (ScrBytes) that OWNS its storage: no views exist — subarray()/slice()
   * both COPY (documented divergence for subarray), `.buffer`/
   * `.byteOffset`/DataView are frontend-fenced. Element reads widen to
   * f64; writes coerce JS-exactly (ToUint8/ToUint32 modular truncation,
   * double→float rounding). OOB element access traps like arrays. Allowed
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
  /** Heap, refcounted closure. `rest` marks a VARIADIC JS function (a
   * `...args` rest parameter, or a zero-param function body reading
   * `arguments` — test/common's mustCall wrapper): the lifted function
   * takes one extra trailing `ScrDyn *` param — a dyn ARRAY carrying the
   * call's arguments from index params.length on — which the dyn call
   * thunk builds per call. `params` stays the DECLARED (non-rest) list
   * (fn.length semantics). Rest-marked values are only ever CALLED
   * through the dyn boundary (boxed thunks); direct static calls box
   * first (lower-calls). */
  | { kind: "func"; params: IrType[]; ret: IrType; rest?: true; restAbi?: "jsval" }
  | { kind: "object"; className: string } // heap, refcounted class instance
  /** The class STATIC side as a value — `typeof C`, the type of the class
   * name itself and of `new (…) => T` constructor-typed slots. Runtime
   * representation is the per-class IMMORTAL class object (ScrClassObj:
   * preorder interval, construct thunk, .name string) emitted once per
   * classRef-referenced class — so identity `===` is one pointer compare
   * and retains/releases are no-ops on the immortal (the regex-literal
   * discipline; isRefCounted says true for container/RC uniformity).
   * Values of `classval:C` are C's class object or a STRICT DESCENDANT's —
   * the object kind's nominal, upcast-only story — and every legal flow
   * preserves the constructor ABI (upcast requires the descendant's
   * completed ctor signature to equal C's), which is what makes `newValue`
   * completion against C's one signature sound. Allowed in locals,
   * globals, params, returns, class/record fields, capture boxes, array
   * elements, Map VALUES, and union arms; fenced out of Map keys, Set
   * elements, JSON, dyn/jsval conversion, and ToString. */
  | { kind: "classval"; className: string }
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
   * engine value. Same deliberate NARROWNESS as dyn (locals/globals/
   * params/args/returns only — never record/class fields, array elements,
   * union arms, or capture boxes), but the OPPOSITE operational stance:
   * where every operation on dyn is frontend-rejected, operations on
   * jsval compile to engine calls (jsOp) with JS-exact semantics, and
   * exits back to static types are validated (jsExit). Exists only when
   * the frontend runs with the dynamic option; static builds never see
   * this kind. */
  | { kind: "jsval" }
  /** A catch binding — the type of `catch (e)`'s local, and NOTHING else
   * (never params, returns, fields, arms, elements, globals, captures).
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
  | { kind: "generator"; yieldT: IrType; retT: IrType; nextT: IrType }
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

/** The ref kinds whose values are JS OBJECTS for truthiness: always true
 * ([] and {} included) — toBool accepts them (the operand still evaluates;
 * the test is constant), and per-union truthiness helpers answer their
 * arms with `true`. */
export const REF_TRUTHY_KINDS: ReadonlySet<string> = new Set([
  // symbol is not a JS object, but every symbol is truthy — the same
  // constant-true answer.
  "symbol",
  "date", "array", "map", "set", "regex", "url", "searchParams", "stats", "fileHandle", "spawnRes", "child",
  "netServer", "netSocket", "http2Session", "http2Stream", "dgramSocket", "testCtx", "httpReq", "httpRes", "httpClientReq",
  "secureCtx", "fsWatcher", "childStream", "procStream", "bytes", "func", "object", "record", "promise",
  // A generator object is a JS object: always truthy.
  "generator",
  // A class object is a JS object (constructors are functions): always truthy.
  "classval",
]);

export const F64: IrType = { kind: "f64" };
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
export const FSWATCHER_T: IrType = { kind: "fsWatcher" };
export const CHILDSTREAM_T: IrType = { kind: "childStream" };
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

/** Element kinds with a real ScrArr storage/RC representation in BOTH
 * backends. Array-producing lowerings can learn their result element from
 * a callback rather than through mapType's ordinary T[] gate, so they must
 * share this predicate instead of reconstructing an array around an
 * otherwise-valid standalone type (Map, Set, dyn, opaque handles, ...). */
export function isSupportedArrayElem(t: IrType): boolean {
  switch (t.kind) {
    case "f64":
    case "bool":
    case "string":
    case "array":
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

/** The Map KEY fence: string (content) or number (SameValueZero) — the two
 * kinds a hash of the VALUE is honest for. Booleans, objects, and the rest
 * of JS's anything-goes keys stay out. Shared by the frontend's
 * type mapping/diagnostics and the validator. Set ELEMENTS use the same
 * fence: a set is hashed storage of its elements exactly as a map is of
 * its keys (isSupportedSetElem is this predicate under its own name). */
export function isSupportedMapKey(t: IrType): boolean {
  return t.kind === "f64" || t.kind === "string";
}

/** The Set ELEMENT fence — Map's key fence plus the refcounted HANDLE
 * kinds stored under identity hashing (SameValueZero for JS objects IS
 * reference identity, so a Set of server handles — portless's auxiliary-
 * server registry — is honest hashed storage; SCR_MAP_KEY_REF in the
 * runtime). netServer is the one handle admitted so far: it drops its
 * listener closures at close, so a set-in-listener cycle is temporary —
 * the child precedent's story. Symbols are identity values by DESIGN —
 * SameValueZero on a symbol IS pointer identity, so a Set of symbols (the
 * sentinel-registry idiom) is the same honest hashed storage with no
 * cycle risk at all (symbols hold only strings). */
export function isSupportedSetElem(t: IrType): boolean {
  return isSupportedMapKey(t) || t.kind === "netServer" || t.kind === "symbol";
}

/** The Map VALUE fence: scalars plus every refcounted kind EXCEPT
 * func/promise/dyn/jsval (and map itself — no maps of maps).
 * Record/object/union values can point back at the map holding them, which
 * is exactly why ref-valued maps are cycle-capable (see the backend's
 * cycle analysis and docs/memory.md). Shared frontend/validator. */
export function isSupportedMapValue(t: IrType): boolean {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "record":
    case "object":
    case "union":
    case "array":
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
 * dyn values validated by the usual checked casts) and three kinds the
 * overflow store carries that user Maps don't admit yet:
 *   func — `Record<string, () => void>`, the command-registry pattern
 *          (scr_closure adapters; closures are cycle-headered and traced,
 *          so a handler capturing its own registry collects)
 *   map/set — `Record<string, Map<K, V>>`/`Record<string, Set<T>>`
 *          nested-container tables (scr_map adapters; a map value's own
 *          cycle capability propagates through the trace fixpoint)
 * Nested index-signature RECORDS ride the record kind like any other.
 * Shared frontend (mapType) / validator. */
export function isSupportedIndexValue(t: IrType): boolean {
  return (
    t.kind === "dyn" ||
    t.kind === "func" ||
    t.kind === "map" ||
    t.kind === "set" ||
    isSupportedMapValue(t)
  );
}

export function funcOf(params: IrType[], ret: IrType): IrType {
  return { kind: "func", params, ret };
}

/** The union FUNC/SET-arm sibling rule, shared by the frontend's union
 * builders and the validator: FUNC arms are valid beside ANY sibling —
 * `typeof x === "function"` narrows against data arms, unit tag tests
 * cover the nullable-callback shape, and between func arms closures
 * compare by pointer identity per tag (unionEq), so `x === String` is the
 * narrowing (the primitive-constructor tables' `StringConstructor |
 * NumberConstructor` field, and LinkOptions' `false | ((s: string) =>
 * string)`). A SET arm keeps the unit-only rule (no narrowing test
 * against data arms). */
export function unionFuncSetArmsOk(arms: IrType[]): boolean {
  return arms.every(
    (a, i) => a.kind !== "set" || arms.every((b, j) => j === i || isUnitType(b)),
  );
}

/** Canonical, injective text form of an IrType — the building block of
 * shape/union identity keys, generic-function instantiation keys, and the
 * backend's per-type helper interning (jsonStringify/dynCheck walkers).
 * Nested records/unions are represented by their (already interned, already
 * canonical) shapeId/unionId, so keys stay finite and comparable. Lives in
 * the IR (not the frontend) because both ends need it. */
export function typeKey(t: IrType): string {
  switch (t.kind) {
    case "f64":
    case "date":
    case "string":
    case "bool":
    case "regex":
    case "url":
    case "searchParams":
    case "symbol":
    case "stats":
    case "fileHandle":
    case "spawnRes":
    case "child":
    case "netServer":
    case "netSocket":
    case "http2Session":
    case "http2Stream":
    case "dgramSocket":
    case "testCtx":
    case "httpReq":
    case "httpRes":
    case "httpClientReq":
    case "secureCtx":
    case "fsWatcher":
    case "childStream":
    case "procStream":
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
      return `func(${[...t.params.map(typeKey), ...(t.rest ? [t.restAbi === "jsval" ? "...jsval[]" : "...dyn[]"] : [])].join(",")})=>${typeKey(t.ret)}`;
    case "object":
      return `object:${t.className}`;
    case "classval":
      return `classval:${t.className}`;
    case "record":
      return `record:${t.shapeId}`;
    case "union":
      return `union:${t.unionId}`;
    case "promise":
      return `promise<${typeKey(t.inner)}>`;
    case "generator":
      return `generator<${typeKey(t.yieldT)},${typeKey(t.retT)},${typeKey(t.nextT)}>`;
    default: {
      const _exhaustive: never = t;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

export function typeEquals(a: IrType, b: IrType): boolean {
  if (a.kind === "array") return b.kind === "array" && typeEquals(a.elem, b.elem);
  if (a.kind === "bytes") return b.kind === "bytes" && a.elem === b.elem;
  if (a.kind === "map") {
    return b.kind === "map" && typeEquals(a.key, b.key) && typeEquals(a.value, b.value);
  }
  if (a.kind === "set") return b.kind === "set" && typeEquals(a.elem, b.elem);
  if (a.kind === "func") {
    return (
      b.kind === "func" &&
      a.params.length === b.params.length &&
      (a.rest === true) === (b.rest === true) &&
      a.params.every((p, i) => typeEquals(p, b.params[i]!)) &&
      typeEquals(a.ret, b.ret)
    );
  }
  if (a.kind === "object") return b.kind === "object" && a.className === b.className;
  if (a.kind === "classval") return b.kind === "classval" && a.className === b.className;
  // The frontend deduplicates shapes structurally (one shapeId per canonical
  // field list), so id equality IS structural equality.
  if (a.kind === "record") return b.kind === "record" && a.shapeId === b.shapeId;
  // Unions are interned like shapes: one unionId per canonical arm list.
  if (a.kind === "union") return b.kind === "union" && a.unionId === b.unionId;
  if (a.kind === "promise") return b.kind === "promise" && typeEquals(a.inner, b.inner);
  if (a.kind === "generator") {
    return (
      b.kind === "generator" &&
      typeEquals(a.yieldT, b.yieldT) &&
      typeEquals(a.retT, b.retT) &&
      typeEquals(a.nextT, b.nextT)
    );
  }
  return a.kind === b.kind;
}

/** True for types whose values are heap-allocated and reference-counted.
 * The single dispatch point for the backend's RC machinery: retains,
 * releases, frame/scope tracking, and NULL-initialized locals all key off
 * this — adding a refcounted kind must not grow new per-kind checks outside
 * the type-directed helpers. */
export function isRefCounted(t: IrType): boolean {
  return (
    t.kind === "string" ||
    t.kind === "array" ||
    t.kind === "map" ||
    t.kind === "set" ||
    // Every regex value is an immortal interned literal today, so its
    // retains/releases are no-ops — riding the uniform machinery anyway
    // means dynamic construction can arrive without a redesign.
    t.kind === "regex" ||
    // URL, Stats, and spawnSync-result instances are ordinary refcounted
    // heap values (immutable, no cycles — strings/scalars inside only).
    t.kind === "url" ||
    // URLSearchParams lists are ordinary refcounted heap values (strings
    // plus at most the owning-URL edge — no cycles).
    t.kind === "searchParams" ||
    // Symbols are the same story: immutable identity values holding at
    // most two strings.
    t.kind === "symbol" ||
    t.kind === "stats" ||
    t.kind === "fileHandle" ||
    t.kind === "spawnRes" ||
    t.kind === "child" ||
    // net handles are refcounted like child (listeners drop at settle,
    // so lean allocation — see the IrType comment).
    t.kind === "netServer" ||
    t.kind === "netSocket" ||
    // h2 sessions/streams are refcounted like the net pair (listeners
    // drop at settlement; the session→stream↔session cycle breaks there).
    t.kind === "http2Session" ||
    t.kind === "http2Stream" ||
    t.kind === "dgramSocket" ||
    // TestContext handles are refcounted like dgramSocket (the runner
    // tree owns children; no cycles through the handle).
    t.kind === "testCtx" ||
    t.kind === "httpReq" ||
    t.kind === "httpRes" ||
    t.kind === "httpClientReq" ||
    // SecureContext handles are refcounted like url/stats (immutable, no
    // cycles — parsed cert/key material inside only).
    t.kind === "secureCtx" ||
    // FSWatcher handles are refcounted like child (listeners drop at
    // close, so lean allocation — see the IrType comment).
    t.kind === "fsWatcher" ||
    // Child-output streams are refcounted like child (listeners drop at
    // EOF — see the IrType comment).
    t.kind === "childStream" ||
    // Typed arrays / Buffers are ordinary refcounted heap values (mutable,
    // no cycles — raw bytes inside only).
    t.kind === "bytes" ||
    t.kind === "func" ||
    t.kind === "object" ||
    // Every class object is an immortal emitted static, so its
    // retains/releases are no-ops — riding the uniform machinery (the
    // regex-literal stance) keeps every container and box path unchanged.
    t.kind === "classval" ||
    t.kind === "record" ||
    // The union CONTAINER is heap/refcounted regardless of which arm it
    // holds (uniform representation keeps the RC discipline simple).
    t.kind === "union" ||
    t.kind === "promise" ||
    // A generator object is a refcounted handle over its paused fiber and
    // typed channel slots (ScrGen — lean allocation, no cycle header).
    t.kind === "generator" ||
    // A dyn value is a refcounted JSON dyn tree (ScrDyn).
    t.kind === "dyn" ||
    // An island value is a refcounted cell owning one engine value.
    t.kind === "jsval" ||
    // A catch binding is a refcounted snapshot box (ScrCaught).
    t.kind === "caught"
  );
}

/* ── module ────────────────────────────────────────────────────────────── */

export interface IrModule {
  /** Bumped on any breaking IR change; serialize.ts refuses mismatches. */
  irVersion: 6;
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
   * mode-provided symbol names, landed ON the IR so both backends emit the
   * external-linkage wrappers and entries from the same facts — the two
   * emissions stay conformance-identical by construction. Absent on every
   * executable build (the backends emit main() exactly as always). */
  lib?: IrLibSection;
}

export type IrFfiValueParamClass = "f64" | "bool" | "u8" | "u32" | "i32" | "string" | "bytes";
export type IrFfiCallbackParamClass =
  | "f64"
  | "bool"
  | "u8"
  | "u32"
  | "i32"
  | "cstring"
  | "string"
  | "bytes";
export type IrFfiReturnClass = "f64" | "bool" | "u8" | "u32" | "i32" | "void";

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
    case "bool":
      return BOOL;
    case "cstring":
    case "string":
      return STRING;
    case "bytes":
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
  return {
    kind: "func",
    params: callback.params
      .filter((param): param is IrFfiCallbackParamClass => !isFfiContextParam(param))
      .map(ffiClassType),
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
 * lower as ffiCall nodes carrying the channel name, and both backends emit
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
  returns: "f64" | "bool" | "u8" | "u32" | "i32" | "void";
  /** The unregistered-call trap text (a DETECTED trap: plain bytes the
   * library funnel classifies SC4025 and assembles with the current
   * entry's symbol — unlike the SC4012 wrapper traps, the entry is only
   * known at runtime). Built once at export resolution so both backends
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
  /** The JS-observable `.name` of the class (the runtime class object's
   * name string, and what `C.name` folds to). Differs from `name` because
   * IR names are program-qualified (`%m1.C`, `%cx…` for class
   * expressions); jsName follows NamedEvaluation — the declared name, the
   * binding name for `const x = class {}`, or "" for truly anonymous
   * expressions. Absent on the runtime-provided defs (never valuable). */
  jsName?: string;
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
  /** GENERIC-CLASS INSTANTIATIONS only (`Box%0` for `Box<number>` — the
   * generic-fn mangle): the FAMILY class's IR name — the synthetic,
   * never-constructed ancestor registered under the generic class's own
   * name that every instantiation extends. JS has ONE `Box` at runtime, so
   * the instantiation's emitted CLASS OBJECT carries the family's preorder
   * interval (instanceof through a class value answers for the whole
   * family, exactly Node); everything else about the instantiation is an
   * ordinary class. The validator checks the family is an ancestor. */
  genericOf?: string;
  loc: SrcLoc;
}

/** The runtime-provided error classes, keyed by IR class name. The names
 * are '%'-prefixed ('%' cannot appear in a TS identifier, so a user's own
 * `class Error` can never collide). `lib` is the standard-library name the
 * frontend recognizes; `kind` is the runtime's SCR_ERR_* index (backends
 * stamp scr_error_vts[kind] and pick constructor kinds by it). Every
 * emitted module carries all four class defs (flagged `runtime`) so the
 * program's preorder numbering always covers them — the runtime's own
 * throws (JSON/dynCheck/regex) mint instances of these classes whether or
 * not user code mentions Error. */
export const RUNTIME_ERROR_CLASSES: ReadonlyMap<string, { lib: string; kind: number; base: string | null }> =
  new Map([
    ["%Error", { lib: "Error", kind: 0, base: null }],
    ["%TypeError", { lib: "TypeError", kind: 1, base: "%Error" }],
    ["%RangeError", { lib: "RangeError", kind: 2, base: "%Error" }],
    ["%SyntaxError", { lib: "SyntaxError", kind: 3, base: "%Error" }],
    // DOMException — the web-standard error shape (a Node global since
    // v17). Its extra state (the legacy numeric code, the options form's
    // cause) lives in runtime-side slots BEYOND the ScrError prefix the IR
    // fields describe, reached only through the error.dom* libCalls — so
    // user `extends DOMException` is fenced (the subclass layout would
    // overlap the hidden slots), where the other four extend freely.
    ["%DOMException", { lib: "DOMException", kind: 4, base: "%Error" }],
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

export interface IrUnionDef {
  /** Frontend-assigned union id (`u0`, `u1`, ...). */
  id: string;
  /** ≥2 pairwise-distinct arm types in canonical (typeKey-sorted) order;
   * an arm's index here is its runtime tag. Never void/func/union; the
   * unit kinds (undefinedT/nullT) are payload-less arms. */
  arms: IrType[];
}

export interface IrFunction {
  /** Original TS name (mangling is a backend concern). Lifted lambdas get
   * synthetic '%'-prefixed names ('%' can't appear in a TS identifier). */
  name: string;
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
  /** Async: the body runs on a fiber; `returnType` is the INNER type T (a
   * `return v` fulfills with v) while call sites receive Promise<T>. */
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
  /** Generator (`function*`): the body runs on a fiber created SUSPENDED
   * (nothing runs until the first `.next()`); `returnType` is the
   * generator's TReturn (VOID when it carries no value — `return;`
   * completes with the undefined arm) while call sites receive the
   * generator type `{ yieldT, retT: returnType, nextT }` from an emitted
   * spawn wrapper that only allocates. `yieldT` is what `yield e` sends
   * out, `nextT` what `.next(v)` sends in (the yield expression's result
   * type). Mutually exclusive with `async` (async generators are fenced). */
  generator?: { yieldT: IrType; nextT: IrType };
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
}

export interface IrLocal {
  id: string;
  name: string;
  type: IrType;
  mutable: boolean;
  /** Captured by a nested function: the variable lives in a refcounted box
   * (a shared binding — mutations are visible through every capture). All
   * access, including in the declaring function, goes through the box. */
  boxed?: true;
  /** A forward-captured const (a function declared BEFORE the const it
   * captures): the box is allocated TDZ-empty at scope entry (a `varDecl`
   * with `init: null`) so earlier closures can capture it, and the source
   * declaration initializes it via `assign`. Every read tests the box —
   * empty throws JS's catchable ReferenceError ("Cannot access 'name'
   * before initialization"), exactly Node's temporal dead zone. Always
   * paired with `boxed`; restricted to pointer-backed types (the NULL slot
   * IS the TDZ sentinel). Capture entries inherit the flag. */
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
  | { kind: "assign"; localId: string; value: IrExpr; loc: SrcLoc }
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
   * are [0, length]; i == length appends (JS would create a hole past that —
   * scriptc traps instead, see SEMANTICS.md). Ownership of a refcounted
   * value MOVES into the array; the replaced element is released. */
  | { kind: "arraySet"; arr: IrExpr; index: IrExpr; value: IrExpr; loc: SrcLoc }
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
  | { kind: "forOf"; localId: string; iterable: IrExpr; body: IrStmt[]; labels?: string[]; loc: SrcLoc }
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
  | { kind: "recordKeySet"; obj: IrExpr; shapeId: string; key: IrExpr; value: IrExpr; overflowOnly?: true; loc: SrcLoc }
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
   * A `return` inside tryBody/catchBody additionally runs the finally on
   * its way out (the backend's PENDING-RETURN path: the value is computed
   * and snapshotted FIRST, every crossed finally runs inner-to-outer, then
   * the function returns — finally mutations of returned locals are
   * invisible, Node-exact; a throw inside such a finally replaces the
   * pending return, releasing the snapshot). The frontend still rejects
   * break/continue crossing a try-with-finally and ANY jump out of a
   * finally body, so normal, exception, and pending-return are the only
   * completions a finally sees; plain try/catch has no such restriction
   * (jumps out release the try scopes like any other jump). Each body is
   * its own lexical scope. */
  | {
      kind: "tryCatch";
      tryBody: IrStmt[];
      catchBody: IrStmt[] | null;
      catchLocalId: string | null;
      finallyBody: IrStmt[] | null;
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
  | "length"
  | "push"
  | "pushSpread"
  | "unshift"
  | "unshiftSpread"
  | "pop"
  | "indexOf"
  | "includes"
  | "join"
  | "slice"
  | "shift"
  | "splice"
  | "reverse"
  /** ES2023 copying methods. `toSpliced` receives [start, deleteCount,
   * itemsArray], with omitted arguments completed by the frontend;
   * `with` receives [index, value] and throws Node's catchable RangeError
   * when the relative index is out of range. */
  | "toReversed"
  | "toSpliced"
  | "with";

/** Array intrinsics whose runtime implementation can raise a catchable
 * exception (rather than the static tier's deliberate index traps). */
export const MAY_THROW_ARR_METHODS: ReadonlySet<IrArrIntrinsicMethod> = new Set([
  "with",
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
  | "length"
  | "byteLength"
  | "get"
  | "slice"
  | "subarray"
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
/** `match` takes a STRING receiver with args[0] the regex (non-g/y — the
 * frontend fences literal g/y flags; a g-flagged value reaching the
 * runtime aborts like test()) and produces the PROGRAM-DEPENDENT
 * `string[] | null` union: the matched slice [whole, ...captures] wrapped
 * into the array arm, or the interned null-arm instance for no match. A
 * NONPARTICIPATING capture holds "" where Node's slot is undefined
 * (SEMANTICS.md divergence). Never throws. */
export type IrRegexIntrinsicMethod =
  | "test"
  | "match"
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
  | "replace"
  | "replaceAll"
  | "split";

/** The complete standard-library surface (mirrors ambient/scriptc.d.ts: the
 * `process` and `JSON` globals and `declare module "node:fs"`). A closed
 * union — every member has a signature in the validator's LIB_FN_SIGS and a
 * scr_* implementation in the runtime (scr_lib.c / scr_json.c). fs.*
 * failures and json.parse syntax errors THROW (catchable, via the runtime
 * exception cell); process.* members never throw. JSON.stringify is NOT a
 * libCall — it lowers to the type-directed `jsonStringify` node below.
 * island.eval (the internal __island_eval testing hook) exists only in
 * --dynamic builds — the frontend rejects it otherwise, so backends may
 * assume the island runtime is linked when they see it; island exceptions
 * bridge into the exception cell as catchable strings (may-throw). */
export type IrLibFn =
  /** Native static fetch and its Web-platform companions. fetch.start
   * answers once the response head arrives; the response body readers
   * consume the native body stream. AbortSignal and ReadableStream values
   * are opaque checked-dynamic handles. */
  | "fetch.start"
  | "fetch.responseNew"
  | "fetch.responseJson"
  | "fetch.responseText"
  | "fetch.responseBytes"
  | "fetch.abortControllerNew"
  | "fetch.abortTimeout"
  | "fetch.abortNow"
  | "fetch.abortAny"
  | "fetch.streamNew"
  | "fetch.streamFrom"
  | "fetch.readerRead"
  | "island.eval"
  /** Load an embedded npm package's runtime entry in the island (cached by
   * the engine's module registry) and take one export: args are the entry
   * KEY (an embedded module's key, from IrModule.embedded) and the export
   * name — "default" for default imports, "*" for the namespace object.
   * --dynamic only, like island.eval; result is an owned jsval. May throw
   * (a package's top-level code can), bridged catchably. */
  | "island.import"
  /** Dynamic `import(spec)`: load a module through the island's module
   * system — an embedded module's key or a builtin shim's "node:x" key —
   * and answer an ENGINE promise of its namespace object (always a
   * promise, never a throw: load and evaluation failures REJECT it,
   * Node's shape). The frontend wraps the result in jsBridgePromise, so
   * awaiting parks the fiber and a rejection crosses catchably. --dynamic
   * only; result is an owned jsval holding the engine promise. */
  | "island.importDyn"
  /** A checked cast the boundary can never satisfy, DEFERRED to runtime:
   * `islandValue as Promise<T>` — the value is an ENGINE promise and T
   * has no validated exit (Node-typed async APIs put class-shaped
   * interfaces there), so instead of refusing the build the cast throws a
   * catchable TypeError AT THE CAST naming the target type (args: the
   * island value — evaluated, borrowed — and the type name). The result
   * type is the cast's mapped target (a typed dummy; the exception is
   * pending). Documented divergence: JS `as` never checks — like the dyn
   * boundary, a conversion that cannot happen throws instead of lying.
   * --dynamic only. */
  | "island.castFail"
  | "json.parse"
  /** Keyed WRITE on a dyn value — `h.onDone = cb` / `h["k"] = v` on a
   * checked-dynamic object (args: receiver, key string, value — all
   * borrowed; the runtime copies the key and retains the value in). An
   * OBJ receiver sets the member (later writes win, insertion order
   * preserved — JS exactly); undefined/null throws Node's catchable
   * "Cannot set properties of undefined (setting 'k')"; every other kind
   * throws Node's STRICT-mode "Cannot create property 'k' on <kind>" —
   * primitives quoting their rendering, V8's "on number '5'"
   * (sloppy mode would silently ignore — suite tests are 'use strict';
   * SEMANTICS.md notes the sloppy divergence: loud, never silent). Void
   * result; in the may-throw seed set. */
  | "dyn.keySet"
  /** Destructuring pack over a dyn source — `const [a, b] = d`, a
   * destructured dyn callback param (args: the source and the STATIC
   * TypeError spelling, "" when the source has none — both borrowed;
   * result: a fresh dyn array, +1). Iterable kinds collect like spread
   * (arrays element-by-element, strings by code point, bytes by byte);
   * every other kind throws V8's destructuring TypeError — the spelling
   * verbatim when non-empty, else the runtime kind wording ("number 5 is
   * not iterable (cannot read property Symbol(Symbol.iterator))"). In the
   * may-throw seed set. */
  | "dyn.iterPack"
  /** The for-of-over-dyn pack accessors — the emitted index loop drives
   * them over a dyn.iterPack result (ARR by construction). arrLen: the
   * ARR length as f64 (0 for non-ARR kinds; arg borrowed). arrAt: the
   * element at index (+1; the undefined singleton past the end). Neither
   * throws. */
  | "dyn.arrLen"
  | "dyn.arrAt"
  /** `key in v` with a RUNTIME (string) key on a checked-dynamic
   * receiver (args: value dyn, key string; result bool): OBJ answers
   * own-member presence, ARR answers 'length'/a valid index — exactly
   * the compile-time dynHasKey fold, per value. Never throws. */
  | "dyn.hasKey"
  /** Object.defineProperties over dyn values (args: target, descriptors —
   * both borrowed dyn; result: the target, +1 — JS's return value).
   * Value descriptors become plain own properties on OBJ and FUNC targets
   * (writable/enumerable/configurable accepted and IGNORED — dyn
   * properties are plain data properties, SEMANTICS.md); get/set
   * descriptors and non-object targets/descriptors throw catchably
   * (Node's TypeError texts; accessors the loud unsupported Error). In
   * the may-throw seed set. */
  | "dyn.defineProps"
  /** Bare `typeof v` on a dyn value AS A STRING (arg: the dyn value,
   * borrowed; result: an owned string) — the dyn kind's JS answer:
   * undefined→"undefined", null/object/array/bytes→"object" (JS's oldest
   * wart preserved), boolean/number/string by kind, function→"function".
   * Never throws. */
  | "dyn.typeof"
  /** toString() on a checked-dynamic receiver: runtime kind dispatch
   * (bytes decode per the literal encoding — utf8 default; strings,
   * numbers, booleans, arrays, objects answer JS-exactly; undefined and
   * null throw the catchable TypeError). */
  | "dyn.toString"
  | "fs.readFileSync"
  /** readFileSync(path) — the Buffer read (+1 bytes); throws catchably
   * like the utf8 form. */
  | "fs.readFileSyncBuf"
  /** readFileSync(path, enc) with a RUNTIME encoding (an untyped JS
   * parameter): undefined/null answer Buffers, utf8 a string, other real
   * encodings fence loudly, unknown names throw ERR_UNKNOWN_ENCODING. */
  | "fs.readFileSyncDyn"
  | "fs.writeFileSync"
  | "fs.appendFileSync"
  | "fs.existsSync"
  | "fs.mkdirSync"
  | "fs.rmSync"
  | "fs.rmdirSync"
  | "fs.readdirSync"
  /** node:path (scr_path.c ports BOTH of Node's implementations
   * function-by-function): the `path.*` family is posix, the
   * `path.win32*` family is Node v24's path.win32 byte-for-byte — the
   * frontend binds the bare module to the TARGET platform's family
   * (Node on Windows IS path.win32) and the path.posix / path.win32
   * namespaces to their own family everywhere. join and resolve take ONE
   * string[] arg — the frontend packs the variadic call's arguments into
   * an array literal. basename always receives its suffix (the frontend
   * completes an omitted one with "", a Node no-op). toNamespacedPath is
   * the posix identity and the win32 \\?\-prefixer. None of these throw;
   * the resolves consult the process cwd like Node's. */
  | "path.join"
  | "path.resolve"
  | "path.normalize"
  | "path.dirname"
  | "path.basename"
  | "path.extname"
  | "path.isAbsolute"
  | "path.relative"
  | "path.toNamespacedPath"
  | "path.win32Join"
  | "path.win32Resolve"
  | "path.win32Normalize"
  | "path.win32Dirname"
  | "path.win32Basename"
  | "path.win32Extname"
  | "path.win32IsAbsolute"
  | "path.win32Relative"
  | "path.win32ToNamespacedPath"
  /** node:os: homedir is $HOME else getpwuid(3); tmpdir is Node's env
   * cascade ($TMPDIR/$TMP/$TEMP else /tmp, one trailing slash trimmed).
   * os.platform() lowers to process.platform — one implementation. */
  | "os.homedir"
  /** os.release(): uname(2)'s release field — Node's own implementation
   * (the kernel version string, e.g. "24.6.0" on macOS 15). Interned; +1
   * per read. Never throws. */
  | "os.release"
  /** The os.userInfo() field trio (uv_os_get_passwd's slices): pw_name,
   * pw_shell, pw_dir — the PASSWD homedir, not os.homedir's $HOME-first
   * cascade (Node's own split). The frontend assembles the UserInfo
   * record from these plus getuid/getgid. +1 fresh strings; a passwd
   * lookup failure aborts (Node throws a system error there — no
   * compiled program path reaches it for the running uid). */
  | "os.userName"
  | "os.userShell"
  | "os.userHomedir"
  | "os.tmpdir"
  /** os.networkInterfaces(): getifaddrs(3) → the Dict<NetworkInterfaceInfo[]>
   * record, built inline by the emitter from a runtime snapshot (scr_lib.c).
   * The result type is the CALL SITE's mapped @types/node shape — a pure
   * index-signature record whose value is `Info[] | undefined`, Info a
   * two-record union (IPv4: scopeid `number | undefined` holding undefined;
   * IPv6: scopeid number) — verified structurally by the frontend. Rows
   * match libuv's filter (IFF_UP && IFF_RUNNING, AF_INET/AF_INET6; loopback
   * = internal; MACs from the interface's link-level sibling entry, zeros
   * when absent; cidr from the netmask's contiguous prefix, the null arm
   * when it is missing or non-contiguous). Key/row order follows the OS's
   * getifaddrs enumeration — Node itself does not guarantee an order.
   * Fresh +1 record; never throws (a getifaddrs failure yields {}). */
  | "os.networkInterfaces"
  /** `Math.max(...xs)` / `Math.min(...xs)` over one spread number[]
   * (scr_number.c): the JS fold exactly — any NaN element poisons the
   * result, ±0 order by the JS comparison (max prefers +0, min prefers
   * -0), and the empty array yields -Infinity / +Infinity like the
   * zero-argument calls. Borrows the array; never throws. */
  | "math.maxArr"
  | "math.minArr"
  /** `fs.readdirSync(path, { withFileTypes: true })` — Dirent rows over
   * one readdir pass (scr_lib.c's scandir snapshot; DT_UNKNOWN falls back
   * to lstat, Node's getDirents rule). The result type is the call site's
   * interned Dirent record array (name, parentPath, hidden %dtype in
   * libuv's UV_DIRENT encoding) — verified by the frontend; the emitter
   * assembles the rows from the snapshot. OS order, no "."/"..". Throws
   * Node's scandir errno error (may-throw seed set); fresh +1 array. */
  | "fs.readdirTypesSync"
  /** `Math.floor(x)` — C floor() IS the JS operation (NaN/±0/±Infinity
   * pass through bit-exactly). Never throws. */
  | "math.floor"
  /** `Math.min(a, b)` / `Math.max(a, b)` — the two-argument scalar forms
   * (scr_lib.c), JS-exact like the Arr folds: NaN poisons, max prefers +0
   * over -0 (min the reverse). C fmin/fmax are NOT these (they drop NaN).
   * Never throw. */
  | "math.min"
  | "math.max"
  /** `Math.random()` — a uniform double in [0,1) with the spec's 53-bit
   * granularity, drawn from arc4random_buf (the CSPRNG behind the crypto
   * lowerings). Same distribution as Node, NECESSARILY different sequence
   * (SEMANTICS.md 62 — no seeded sequence exists to match). Never throws. */
  | "math.random"
  /** Math.abs (C fabs — IS the JS operation) and Math.round (scr_lib.c:
   * ECMA half-toward-+Infinity with the exact-fraction comparison — C
   * round() is half-away-from-zero and floor(x+0.5) drifts at the
   * epsilon boundary). Borrow nothing; never throw. */
  | "math.abs"
  | "math.round"
  /** Math.trunc / Math.ceil — C trunc()/ceil() ARE the JS operations
   * (NaN/±0/±Infinity pass through bit-exactly; ceil(-0.5) is -0 in IEEE
   * round-toward-+Infinity exactly as ECMA says). Static like floor —
   * they are ask-4's wholeness-discharge operators, so the library
   * inference needs them compiled, not island-served. Never throw. */
  | "math.trunc"
  | "math.ceil"
  /** The static global parsers/tests (scr_string.c). num.parseInt is
   * ECMA-262 19.2.5 exactly — JS whitespace, sign, ToInt32 radix (the
   * frontend completes an omitted radix to 0 = the spec's "undefined":
   * base 10 with the 0x hex escape), longest digit prefix, and the exact
   * mathematical value correctly rounded (u64 fast path, bignum beyond —
   * overflow is ±Infinity). num.isNaN is the NaN self-test on an
   * already-number argument (tsc pins the argument to number, so no
   * ToNumber coercion exists to model). Borrow; never throw. */
  | "num.parseInt"
  | "num.isNaN"
  /** ES parseFloat (scr_string.c): the longest StrDecimalLiteral prefix
   * of the trimmed input (no hex, "Infinity" exact-case), NaN when none —
   * ECMA-262 19.2.4 over a string argument (non-string arguments keep the
   * fence: Node would ToNumber-coerce). Borrows; never throws. */
  | "num.parseFloat"
  /* ToNumber(string) — ECMA-262 7.1.4.1 StringToNumber (scr_string.c):
   * trim the JS StrWhiteSpace set, empty/whitespace-only → +0, then the
   * whole span must be one StrNumericLiteral — signed decimal (Infinity
   * included, strtod-over-validated-span correct rounding) or unsigned
   * 0x/0o/0b (exact value, nearest-even; signed forms are NaN) — with
   * any trailing garbage answering NaN. Number(aString), unary + on
   * strings, and util.format %d over strings lower here. Borrows; never
   * throws. */
  | "num.fromString"
  /** The static URI component codecs (scr_string.c), ECMA-262 Encode/
   * Decode with the component sets over the runtime's UTF-8 strings.
   * str.encodeUriComponent percent-encodes every byte outside the
   * unreserved component set (ALPHA/DIGIT/- _ . ! ~ * ' ( )) as uppercase
   * %XX — the spec's per-code-point UTF-8 encoding IS a byte scan here —
   * and never throws (the spec's URIError case is an unpaired surrogate,
   * which cannot exist in well-formed UTF-8). str.decodeUriComponent
   * decodes %XX escapes bytewise (raw non-escape bytes copy through) and
   * requires the escaped bytes to form strictly valid UTF-8 (overlong
   * forms, surrogate code points, and >U+10FFFF refused, per UTF8-decode
   * without replacement); bad hex or an invalid sequence THROWS the
   * spec's URIError ("URI malformed"), catchable. Borrow; results +1. */
  | "str.encodeUriComponent"
  | "str.decodeUriComponent"
  /** RegExp.escape (ES2025): per-code-point EncodeForRegExpEscape —
   * leading ASCII alphanumeric hex-escapes, syntax characters and '/'
   * take a backslash, other punctuators/whitespace/line terminators
   * hex-escape, the rest passes through. Total; borrows; result +1. */
  | "regexp.escape"
  /** encodeURI: the same Encode() keeping the reserved set and '#'
   * unescaped — total like the component encoder. Borrow; result +1. */
  | "str.encodeUri"
  /** The WHATWG base64 globals (scr_string.c), Node-global since v16.
   * Arguments are borrowed dyn values — WebIDL ToString runs in the
   * runtime over the dyn kind (String(null) is "null": the html spec's
   * coercion, which Node's atob(null) exercises). str.atob decodes
   * forgiving-base64 (ASCII whitespace stripped, %4==0 strips up to two
   * '=', %4==1 refuses, leftover bits discarded) into the latin1 code
   * points as a string; a malformed input THROWS the catchable
   * DOMException InvalidCharacterError ("The string to be decoded is not
   * correctly encoded."). str.btoa encodes the string's code points as
   * base64; any code point over U+00FF THROWS InvalidCharacterError
   * ("Invalid character"). str.b64Missing is the zero-argument call of
   * either: always throws Node's TypeError [ERR_MISSING_ARGS] "The
   * \"input\" argument must be specified". Results +1. */
  | "str.atob"
  | "str.btoa"
  | "str.b64Missing"
  /** Number.prototype formatters (scr_lib.c), JS-exact:
   * num.toExponential is toExponential() with the spec's "as many digits
   * as necessary"; num.toFixed0 is the non-throwing omitted-argument
   * toFixed() fast path; num.toFixed implements an explicit fractionDigits
   * with exact binary-value rounding and THROWS RangeError outside 0..100.
   * Successful results +1. */
  | "num.toExponential"
  | "num.toFixed0"
  | "num.toFixed"
  /** Object.is over two numbers — the spec's SameValue on doubles: NaN
   * equals NaN, +0 differs from -0, everything else is `===`. Plain bool
   * result; never throws. (Union-armed operands take unionEq's sameValue
   * flag instead — this is the both-f64 fast path.) */
  | "num.sameValue"
  /** `new Intl.NumberFormat("en-US").format(x)` and
   * `x.toLocaleString("en-US")` with DEFAULT options — the one locale
   * whose data the runtime embeds (Node's default-build locale): decimal
   * notation, 0–3 fraction digits rounded half-up on the SHORTEST
   * round-tripping decimal (ICU's rounding input, probed vs Node —
   * format(1.0005) is "1.001" though toFixed(3) answers "1.000"), ","
   * grouping every three integer digits, "∞"/"NaN" texts, and "-0" for
   * negative inputs rounding to zero. Result +1; never throws. */
  | "intl.numFormatEnUs"
  /** `delete process.env[NAME]` — unsetenv(3): the mutation is visible to
   * every later read (process.envGet asks getenv fresh) and inherited by
   * spawned children, exactly Node. Statement position only (JS's boolean
   * result is constant true there). Borrows the name; never throws. */
  | "process.envUnset"
  /** node:url + the URL class (scr_url.c). url.new parses one absolute
   * URL string into an immutable URL value (+1) — invalid input THROWS a
   * catchable TypeError ("Invalid URL"), like Node's constructor. The
   * getters (borrowed receiver, +1 string) never throw; url.href doubles
   * as toString(). fileURLToPath has one libFn per receiver form (URL
   * value / string) — both THROW Node's TypeErrors on non-file schemes,
   * encoded slashes, and non-empty hosts. url.pathToFileURL resolves the
   * path (getcwd) and never throws. */
  | "url.new"
  | "url.protocol"
  | "url.host"
  | "url.hostname"
  | "url.pathname"
  | "url.href"
  | "url.fileURLToPathUrl"
  | "url.fileURLToPathStr"
  | "url.pathToFileURL"
  /** pathToFileURL under a win32 TARGET: the same scr_url_from_path call
   * (the runtime selects the win32 arm by _WIN32), but a distinct IR name
   * because that arm THROWS for malformed UNC inputs — may-throw seeds on
   * it while posix pathToFileURL emission stays byte-identical. */
  | "url.pathToFileURLWin32"
  /** URLSearchParams (scr_url.c — always linked with the url unit).
   * Construction: sp.new (empty), sp.parse (one borrowed init string —
   * a single leading '?' strips, Node's constructor), sp.copy (snapshot
   * of another list), sp.fromPairs (a string[][] value — THROWS Node's
   * ERR_INVALID_TUPLE TypeError on a non-[name, value] row; the one
   * throwing entry in the family), sp.with (the record-literal init
   * desugar: append one pair, answer the same list +1 — chains fold
   * `new URLSearchParams({...})` into nested calls). url.searchParams
   * answers the URL's LIVE cached view (+1, one identity per URL);
   * url.search is the WHATWG search getter ("" for no/empty query).
   * Methods mirror the WHATWG surface: sp.get answers +1-or-NULL (the
   * sym.desc union pattern, null arm), sp.getAll a fresh string[];
   * sp.append/sp.set/sp.delete/sp.deleteValue/sp.sort mutate and
   * re-serialize a live view's URL query; sp.has/sp.hasValue answer
   * bools; sp.size/sp.toString are pure reads. sp.keyAt/sp.valAt are
   * the for-of/forEach desugar's index reads (live — the loop re-reads
   * sp.size each pass). */
  | "sp.new"
  | "sp.parse"
  | "sp.copy"
  | "sp.fromPairs"
  | "sp.with"
  | "url.searchParams"
  | "url.search"
  | "sp.get"
  | "sp.getAll"
  | "sp.append"
  | "sp.set"
  | "sp.delete"
  | "sp.deleteValue"
  | "sp.has"
  | "sp.hasValue"
  | "sp.sort"
  | "sp.size"
  | "sp.toString"
  | "sp.keyAt"
  | "sp.valAt"
  /** node:querystring (scr_qs.c — link-gated by moduleUsesQs; NOT
   * URLSearchParams: the legacy codec's escaping and '+' rules differ).
   * qs.escape is Node's qsEscape, which encodes exactly the component
   * unreserved set — it emits the always-linked
   * scr_str_encode_uri_component, so escape-only programs never pull the
   * unit. qs.unescape is Node's qsUnescape: strict decodeURIComponent
   * first, the lenient legacy unescapeBuffer fallback on failure (never
   * throws). qs.parse takes (str, sep, eq, maxKeys) — the frontend
   * completes omitted/null sep/eq to "&"/"=" and the omitted maxKeys
   * option to Node's 1000 (0 and negatives mean unlimited, Node's rule) —
   * and its result type is the CALL SITE's mapped ParsedUrlQuery shape (a
   * pure index-signature record over `string | string[]`, an undefined
   * arm tolerated — @types/node's Dict), verified structurally by the
   * frontend (lowerQuerystringParseCall); the emitters construct the
   * record and hand its overflow map to scr_qs_parse_into with the two
   * union tags. qs.stringify takes (obj, sep, eq) with obj a dyn value
   * (the frontend dynFroms the typed record; JS-world dyn values pass
   * through) — Node's encodeStringified rules run in the runtime, so
   * arrays expand to repeated keys and null/undefined/nested objects are
   * empty values. Custom encoder/decoder options fence at compile time.
   * All borrow; string results +1; none throw. */
  | "qs.parse"
  | "qs.stringify"
  | "qs.escape"
  | "qs.unescape"
  /** node:util.parseArgs: one checked-dynamic config object in, one
   * checked-dynamic ParsedResults tree out. Statically typed member reads
   * validate their values when leaving that tree. The native parser may
   * throw Node's coded validation/grammar TypeErrors. */
  | "util.parseArgs"
  /** ES Symbol values (scr_symbol.c — link-gated by moduleUsesSymbol).
   * sym.new: `Symbol(desc)` — a fresh runtime-unique identity (+1) whose
   * one arg is the description string (borrowed); sym.newAnon is the
   * description-less `Symbol()` form. sym.for: the Symbol.for global
   * registry — one interned symbol per key (borrowed), +1 on every call.
   * sym.toString: "Symbol(desc)" (+1 string; "Symbol()" when absent).
   * sym.desc / sym.keyFor answer the interned `string | undefined` union
   * (the runtime returns +1-or-NULL; the backend builds the union arms —
   * the child.stdout pattern). None of these throw. */
  | "sym.new"
  | "sym.newAnon"
  | "sym.for"
  | "sym.keyFor"
  | "sym.desc"
  | "sym.toString"
  /** fs.statSync → a Stats value (may throw, like the other sync fs
   * calls); the stats.* getters are pure reads on it. */
  | "fs.statSync"
  | "stats.isFile"
  | "stats.isDirectory"
  | "stats.size"
  /** child_process.spawnSync (scr_child.c): posix_spawn + waitpid + piped
   * utf8 capture — cmd borrowed, args one borrowed string[] (the frontend
   * completes an omitted list to an empty literal), result an owned (+1)
   * spawnRes. NEVER throws: spawn failure (nonexistent binary, EACCES) is
   * data, like Node's error property — status null and empty outputs
   * (SEMANTICS.md documents the divergence from Node's null stdout).
   * The getters are pure reads: status is the interned `number | null`
   * union (null = spawn failure or signal death, type-directed
   * construction in the backend like process.envGet); stdout/stderr are
   * +1 strings. */
  | "cp.spawnSync"
  | "spawnRes.status"
  | "spawnRes.stdout"
  | "spawnRes.stderr"
  /** Node's spawn-failure carrier `error?: Error`: a fresh +1 %Error
   * ("spawnSync <file> ENOENT", `code` stamped) when the spawn itself
   * failed, the interned undefined arm otherwise — the result type is the
   * call site's `Error | undefined` union, constructed type-directedly in
   * the backend (the envGet convention). Never throws. */
  | "spawnRes.error"
  /** child_process.spawn (scr_child.c + the scr_async.c loop): posix_spawnp
   * with stdio "ignore" (all three fds on /dev/null — the only supported
   * stdio; "pipe"/"inherit" are frontend-fenced), the child registered
   * with the event loop, which polls waitpid(WNOHANG) at quiescence like
   * timers (kqueue is the follow-up; SEMANTICS.md documents the polling).
   * NEVER throws: spawn failure defers to the "error" event, Node-exact
   * (the error message is Node's "spawn <cmd> <ERRNO-NAME>"; an "error"
   * event with no listener prints it and exits 1 like an EventEmitter).
   * cmd/args borrowed; result an owned (+1) child handle. The loop will
   * not exhaust while any spawned child is unreaped — Node's keep-alive.
   *
   * child.onExit / child.onError — `child.on("exit"|"error", cb)`: the
   * receiver is borrowed, the CALLBACK MOVES into the child's listener
   * registry (released after the terminal event fires, or at reap for
   * the event that never fires). Both are void (chaining is fenced).
   * onExit's third emitted ingredient is an ADAPTER the backend interns
   * per callback shape: the runtime invokes adapter(cb, has_code, code)
   * and the adapter builds the `number | null` union (tags are program-
   * dependent) or ignores the code for a zero-param callback. onError's
   * adapters are runtime-provided (zero-param, or the %Error one-param
   * shape — scr_error_new needs no program types). "exit" fires once
   * with the code (f64 arm) or null (signal death); "error" fires only
   * for spawn failure, exactly Node's split. */
  | "cp.spawn"
  | "child.onExit"
  | "child.onError"
  /** The ChildProcess lifecycle members (scr_child.c), Node's shapes
   * exactly (SEMANTICS.md has the pinned matrix). child.pid is the
   * checker's `number | undefined` (undefined = spawn failure) and
   * child.exitCode its `number | null` (null while running and after a
   * signal death; -errno once a spawn failure settled) — both unions are
   * type-directed constructions in the backend over a has/get runtime
   * pair, the spawnRes.status pattern. child.killed is Node's
   * sent-a-signal flag. child.kill sends while the child is un-reaped
   * (false after — Node's null-handle answer) and THROWS the
   * Unknown-signal TypeError on bad names (may-throw); killNum passes
   * numbers through (0 probes; never throws). child.unref drops the
   * child from the loop's keep-alive set — it is still reaped while the
   * loop runs for other reasons, and one the loop never reaps is left to
   * the OS at exit. All receivers borrowed. */
  | "child.pid"
  | "child.exitCode"
  | "child.killed"
  | "child.kill"
  | "child.killNum"
  | "child.unref"
  /** The piped-output streams (stdio mode 3 — scr_child.c's stream
   * slice). child.stdout/child.stderr answer the checker's
   * `Readable | null` union (type-directed construction in the backend
   * over the +1-or-NULL runtime pair — the child.pid pattern with a ref
   * arm). stream.onData/onEnd register 'data'/'end' listeners (receiver
   * borrowed, CALLBACK MOVES, trailing once-flag, void — chaining
   * fenced): 'data' fires one Buffer chunk per read (zero-param and
   * Buffer-param adapters are runtime-provided; a union-param listener —
   * ngrok's `Buffer | string` — gets a compiler-emitted adapter wrapping
   * the chunk at its Buffer arm), 'end' fires once at EOF, always BEFORE
   * the child's 'exit' (the pinned ordering). A flowing stream keeps the
   * loop alive: usesTimers. */
  | "child.stdout"
  | "child.stderr"
  | "stream.onData"
  | "stream.onEnd"
  /** The first-class WritableStream write (`output.write(line)` — the
   * prefixStream idiom): the receiver IS the fd scalar (process.stdout/
   * stderr reads mint 1/2), dispatched onto the exact stdoutWrite/
   * stderrWrite paths so buffering and ordering stay identical. Data
   * borrowed; the bool is Node's always-true backpressure signal. */
  | "procStream.write"
  /** node:net (scr_net.c — linked, and scr_net_install() emitted, only
   * when one of these appears on the IR; moduleUsesNet is the switch).
   * Receivers are borrowed; CALLBACKS MOVE into the handle's listener
   * registry and are released at settlement (the child.onExit story).
   * All listener registrations carry a trailing BOOL once-flag (`on` vs
   * `once`) and are void — chaining is fenced. None of these throw:
   * listen/connect failures are the async 'error' event, like Node.
   *
   * net.createServer's optional connection handler and the
   * serverOnConnection listeners take the runtime-provided adapters
   * (zero-param, or the one-param socket shape); sockOnData's adapters
   * are the stdin pair's shapes (zero-param / bytes chunk); the error
   * events reuse the child %Error adapters. net.listen/net.listenCb bind
   * NOW and defer 'listening' to the next loop turn (Node's next-tick
   * emit); net.serverPort is the composed `server.address().port` read.
   * net.connect's host argument is a string ("localhost" pins to
   * 127.0.0.1 — SEMANTICS.md); the connect callback is once('connect'). */
  | "net.createServer"
  | "net.createServerCb"
  | "net.listen"
  | "net.listenCb"
  /** listen({ port, host, ipv6Only }[, cb]) — the explicit-interface bind
   * (portless's listenOnProxyInterface): args [server, port, host,
   * ipv6Only]. host is an IP literal string ("" = the host-less
   * dual-stack any default); ipv6Only sets IPV6_V6ONLY before the bind.
   * Failures are the async 'error', message in Node's listen shape with
   * the requested host. Never throws. */
  | "net.listenOpts"
  | "net.listenOptsCb"
  | "net.serverPort"
  /** server.address() as the full AddressInfo record (the dgram.address
   * materialization pattern: the emitter builds the record from the three
   * runtime reads; the frontend pinned the shape). Never throws — before
   * listen it answers the any-form defaults with port 0 where Node
   * answers null (the serverPort stance). */
  | "net.serverAddress"
  | "net.serverClose"
  | "net.serverCloseCb"
  /** The close-override pair (the portless close-proxy idiom).
   * serverCloseBind is `wrapper.close.bind(wrapper)` as a VALUE: a
   * compiler-emitted closure over the server whose invocation runs the
   * REAL close (scr_net_server_close_direct — never the override), so
   * the override body's `origClose(cb)` cannot recurse; its callback
   * argument (the `((err?: Error) => void) | undefined` union) registers
   * as a once-'close' listener, a one-param callback wrapped by an
   * emitted zero-arg trampoline firing the undefined arm (a clean close
   * carries no error). serverSetCloseOverride is `wrapper.close = fn`:
   * the override MOVES in behind an emitted zero-arg wrapper (it invokes
   * the user function with the undefined-arm callback — tags are program
   * data), and server.close() consults it before closing. */
  | "net.serverCloseBind"
  | "net.serverSetCloseOverride"
  | "net.serverOnError"
  | "net.serverOnClose"
  | "net.serverOnConnection"
  /** 'secureConnection' — the TLS server's deferred 'connection' list
   * (handshake-completion timing); on a server without deferred
   * connections (a plain net server) the registration never fires,
   * exactly Node's split. */
  | "net.serverOnSecureConnection"
  | "net.connect"
  /** connect with a validated autoSelectFamilyAttemptTimeout option (the
   * budget runs Node's validateInt32-from-1 ladder and is then inert —
   * the single dial has nothing to time). May-throw. */
  | "net.connectAttempt"
  /** net.connect/createConnection over a RUNTIME option bag (computed
   * keys — the invalid-input probes): Node-order validation (the
   * objectMode trio's ERR_INVALID_ARG_VALUE, validatePort, host string,
   * autoSelectFamily boolean, the attempt budget), then the trailing
   * compiler-rendered fence — ALWAYS THROWS (the error.nodeThrow
   * polymorphic-result carve-out). May-throw seed. */
  | "net.connectOptsChk"
  | "net.connectCb"
  /** connect({ port, host, autoSelectFamily: true, lookup }) — the
   * caller-resolver dial (portless's createLoopbackConnection): args
   * [port, host, lookup]. The runtime creates the (connecting) socket
   * handle, invokes the lookup as Node does — lookup(hostname, options,
   * callback), options crossing as the dyn undefined — and the answer
   * closure (an emitter-synthesized per-shape thunk over a boxed socket,
   * the SNI-answer pattern) dials the answered addresses IN ORDER: each
   * connect failure tries the next, the LAST failure's message is the
   * socket's 'error' (Node's autoSelectFamily aggregate is a documented
   * divergence), and a lookup error surfaces as the deferred socket
   * 'error'. A synchronous throw INSIDE the lookup propagates out of the
   * connect call (may-throw seed). */
  | "net.connectLookup"
  | "net.sockWrite"
  | "net.sockWriteBytes"
  | "net.sockEnd"
  | "net.sockEndStr"
  | "net.sockEndBytes"
  /** write/end with a CHECKED-DYNAMIC chunk (an untyped JS payload into a
   * typed socket): the runtime dispatches STR/BYTES and throws Node's
   * ERR_INVALID_ARG_TYPE chunk TypeError on any other kind. */
  | "net.sockWriteDyn"
  | "net.sockEndDyn"
  | "net.sockDestroy"
  | "net.sockPipe"
  /** socket.pipe(res) — raw socket chunks into a ServerResponse body
   * (the extended-CONNECT bridge leg): each chunk is a body write (the
   * response's own framing applies); source EOF end()s the response,
   * pipe's default. Borrows both. Never throws. */
  | "net.sockPipeRes"
  | "net.sockOnData"
  | "net.sockOnEnd"
  | "net.sockOnClose"
  | "net.sockOnError"
  | "net.sockOnConnect"
  /** node:dgram + node:dns (scr_dgram.c — linked, and
   * scr_dgram_install() emitted, only when one of these appears on the
   * IR; moduleUsesDgram is the switch — dns.lookup rides the same unit).
   * The net listener discipline verbatim: receivers borrowed, CALLBACKS
   * MOVE into the handle's registry and release at settlement, `on` vs
   * `once` is the trailing bool, registrations are void. bind/connect
   * bind NOW and defer 'listening'/'connect' to the next loop turn (the
   * net.listen story); their optional-host completions are ""
   * (bind → 0.0.0.0) and "127.0.0.1" (connect — udp4's Node default).
   * bind/connect/send/close/address THROW Node's state errors ("Socket
   * is already bound", "Already connected", "Not running") — may-throw
   * seeded. dgram.address returns the AddressInfo RECORD (the frontend
   * pins the {address, family, port} shape; the emitter builds it from
   * runtime parts). onMessage adapters are emitted per rinfo record
   * shape (the child.onExit precedent); onError reuses the child %Error
   * adapters. dns.lookup resolves via getaddrinfo AT CALL TIME and
   * defers the callback to the next turn (SEMANTICS.md documents the
   * blocking divergence); its per-union adapter builds the
   * `Error | null` first argument. */
  | "dgram.createSocket"
  | "dgram.bind"
  | "dgram.bindCb"
  | "dgram.connect"
  | "dgram.connectCb"
  | "dgram.sendStr"
  | "dgram.sendBytes"
  /** The send argument-validation ladder over dyn arguments (Node's
   * signature shuffle: slice bounds, list/type contracts, port/address
   * validation, connected-state errors) — a fully-validated unconnected
   * single-payload send RUNS; callback/list/connected forms meet the
   * trailing fence. May-throw. */
  | "dgram.sendChk"
  | "dgram.address"
  | "dgram.close"
  | "dgram.closeCb"
  | "dgram.unref"
  | "dgram.ref"
  | "dgram.onMessage"
  | "dgram.onError"
  | "dgram.onListening"
  | "dgram.onClose"
  | "dgram.onConnect"
  | "dns.lookup"
  /** node:test (scr_test.c — linked only when one of these appears on
   * the IR; moduleUsesNodeTest is the switch, and the main epilogue asks
   * scr_test_exit_code() for the process's exit status). Strings are
   * BORROWED, callbacks MOVE. register/suite/hook attach to the runner
   * tree (register: name, mode 0|1|2 run/skip/todo, directive message ""
   * = none, cb or absent via registerEmpty, flags 1 async | 2 takes-ctx
   * | 4 only, "file:line:col"); suite runs its body AT registration
   * (Node's collection phase). sub is t.test — runs the subtest INLINE
   * on the runner fiber and returns the settled promise the await
   * consumes. ctxSkip/ctxTodo mark the running test; ctxDiagnostic
   * queues an ℹ line; ctxName reads t.name. Every registration keeps
   * the loop-run emitted (usesTimers) so the runner fiber drains. */
  | "test.register"
  | "test.registerEmpty"
  | "test.suite"
  | "test.hook"
  | "test.sub"
  | "test.subEmpty"
  | "test.ctxSkip"
  | "test.ctxTodo"
  | "test.ctxDiagnostic"
  | "test.ctxName"
  /** node:http, the server slice (scr_http.c over scr_net.c — linked
   * only when these appear on the IR; moduleUsesHttpServer is the
   * switch, and any http.* libCall also counts as net use so scr_net.c
   * links and installs). http.createServer's handler MOVES in and takes
   * the runtime adapters for its (req, res) / (req) / () shapes; req
   * body listeners follow the net.sockOnData story (bytes chunks, once
   * flags); reqHeader answers the interned `string | undefined` union
   * exactly like process.envGet; the res writers are borrowed-argument
   * voids with Node's framing decided in the runtime (Content-Length
   * for end-before-head, chunked after an explicit writeHead/write). */
  | "http.createServer"
  /** http.createServer() / http.Server() with no handler — the
   * on("request") route; createServerOpts is the (options[, listener])
   * overload's twin carrying the two lowered parser flags
   * (requireHostHeader: false is already this parser's behavior;
   * joinDuplicateHeaders joins repeated request-header reads ", "). */
  | "http.createServerEmpty"
  | "http.serverJoinDupHeaders"
  /** The five writable numeric http.Server timeout fields use one
   * selector ABI: 0 timeout, 1 keepAliveTimeout, 2 headersTimeout,
   * 3 requestTimeout, 4 keepAliveTimeoutBuffer. These calls store/read
   * the property values; timer enforcement remains outside this surface.
   * The constructor-option setter takes dyn so explicit undefined remains
   * distinguishable from a numeric value until its Node validation ladder. */
  | "http.serverTimeoutGet"
  | "http.serverTimeoutSet"
  | "http.serverTimeoutOptionSet"
  /** server.on("listening", cb) — the deferred listen-callback list. */
  | "net.serverOnListening"
  /** The ServerResponse member surface: statusCode/statusMessage reads
   * and assignments (Node's writable properties), the header CRUD trio
   * (getHeader answers `string | undefined` like reqHeader), and
   * end(cb)'s finish slot (resOnFinish registers, the end call follows —
   * the callback fires deferred, Node's 'finish' emit). writeHead's
   * statusMessage forms compose in interned helpers: resStatusMsgSet
   * then the ordinary writeHead entry. */
  | "http.resStatusGet"
  | "http.resStatusSet"
  | "http.resStatusMsgGet"
  | "http.resStatusMsgSet"
  | "http.resGetHeader"
  | "http.resHasHeader"
  | "http.resRemoveHeader"
  | "http.resOnFinish"
  | "http.reqUrl"
  | "http.reqMethod"
  | "http.reqHeader"
  | "http.reqOnData"
  | "http.reqOnEnd"
  | "http.resSetHeader"
  | "http.resWriteHead"
  | "http.resWriteHeadN"
  | "http.resWrite"
  | "http.resWriteBytes"
  | "http.resEnd"
  | "http.resEndStr"
  | "http.resEndBytes"
  /** The checked-dynamic chunk twins (the net.sockWriteDyn story). */
  | "http.resWriteDyn"
  | "http.resEndDyn"
  | "http.resHeadersSent"
  /** The server-surface member follow-ups: reqStatusCode answers the
   * interned `number | undefined` union (negative = the undefined arm —
   * a SERVER request, where Node's statusCode is undefined; every client
   * response carries a real status); reqSocket is the underlying
   * connection (+1, the same handle net.connect would give);
   * sockRemoteAddress answers `string | undefined` (NULL after the fd
   * closed, Node's destroyed-socket undefined; a dual-stack accept of an
   * IPv4 peer reads "::ffff:a.b.c.d" like Node). reqResume/reqDestroy and
   * the req error/close listener slots complete the IncomingMessage
   * surface portless's client responses use; resDestroy/resOnClose and
   * resWriteHeadPairs ([k0,v0,k1,v1,...] — the env.pairs helper's flat
   * shape) complete ServerResponse. sockSetTimeout arms the idle
   * EVFILT_TIMER ('timeout' fires after ms of inactivity, once per idle
   * period, never destroying the socket — Node's semantics). */
  | "http.reqStatusCode"
  | "http.reqSocket"
  | "http.reqH2Stream"
  | "http.reqH2StreamOrThrow"
  | "http.reqResume"
  /** req.rawHeaders — [name, value, name, value, ...] in arrival order,
   * names in their ORIGINAL case (Node's shape); a fresh string[] per
   * read. reqStatusMessage answers the interned `string | undefined`
   * union — the reason phrase on client responses ("" when the status
   * line carried none), the undefined arm on server requests (the
   * statusCode split). sockDestroyed is socket.destroyed — true once the
   * fd is gone (destroy() or full close). */
  | "http.reqRawHeaders"
  | "http.reqStatusMessage"
  /** The `{ ...req.headers }` snapshot feed: [lowercased name, value,
   * ...] pairs in arrival order — the interned %headers.snapshot helper
   * builds the record over it, exactly the process.envPairs pattern. */
  | "http.reqHeaderPairs"
  | "net.sockDestroyed"
  /** socket.writable — the write half is open: no end() yet, no FIN sent,
   * fd alive (connecting sockets answer true; writes queue). Node's
   * stream flag. Borrows; never throws. */
  | "net.sockWritable"
  /** The 'upgrade' events, both sides (SEMANTICS.md — the WebSocket
   * proxying surface): serverOnUpgrade registers (req, socket, head)
   * listeners fired INSTEAD of 'request' for Connection: upgrade
   * requests (the parser steps aside; the socket is raw; `head` carries
   * bytes past the request head; no listener = the socket destroys,
   * Node's default). clientOnUpgrade is the client twin: a 101 response
   * fires (res, socket, head) INSTEAD of 'response'. */
  | "http.serverOnUpgrade"
  | "http.clientOnUpgrade"
  /** server.on("connect", ...) — HTTP CONNECT tunneling, the 'upgrade'
   * machinery's twin: (req, socket, head) fired INSTEAD of 'request' for
   * CONNECT-method requests (no listener = the socket destroys, Node's
   * default). The h2 compat server's 'connect' (portless's RFC 8441
   * handler) only ever sees the HTTP/1.1 arm under the allowHTTP1
   * lowering, so a listener whose second parameter is a UNION with a
   * netSocket arm takes the socket wrapped at that arm (an emitted
   * per-shape adapter — the tags are program data). */
  | "http.serverOnConnect"
  /** req.pipe(dest) — the IncomingMessage body streaming into a
   * ServerResponse (the proxy's response leg), a ClientRequest (the
   * request-body forward), or a raw socket (the upgrade-rejection leg);
   * chunk-for-chunk, natural end ends the destination (Node's pipe
   * default; no backpressure — divergence 54's stream model). */
  | "http.reqPipeRes"
  | "http.reqPipeClient"
  | "http.reqPipeSock"
  | "http.reqDestroy"
  | "http.reqOnError"
  | "http.reqOnClose"
  | "http.reqOnAborted"
  | "http.reqHttpVersion"
  | "http.reqHttpVersionMajor"
  | "http.reqHttpVersionMinor"
  | "http.reqAborted"
  | "http.reqComplete"
  | "http.resDestroy"
  | "http.resOnClose"
  | "http.resWriteHeadPairs"
  /** writeHead(status, headers) with a checked-dynamic headers value —
   * the runtime OBJ walk (string/number values; loud fences otherwise;
   * may throw). */
  | "http.resWriteHeadDyn"
  | "net.sockSetTimeout"
  /** setEncoding('utf8') — 'data' delivers strings inside the chunk-encoding window; other real encodings fence loudly, unknown names throw ERR_UNKNOWN_ENCODING (may throw). */
  | "net.sockSetEncoding"
  | "http.reqSetEncoding"
  | "net.sockOnTimeout"
  | "net.sockRemoteAddress"
  /** The paused-mode demux surface (portless's first-byte TLS peek:
   * once('readable') + read(1) + unshift + emit('connection')).
   * sockOnReadable registers a zero-param listener (a consumer: arrived
   * bytes buffer instead of flowing, and EOF announces too); sockRead
   * answers `Buffer | null` (exactly n buffered bytes, or null — Node's
   * less-than-n answer; n <= 0 drains everything); sockUnshift returns
   * bytes to the front of the stream; serverEmitConnection routes a
   * socket into another server's protocol layer (a TLS target's
   * 'connection' waits for its handshake). */
  | "net.sockOnReadable"
  | "net.sockRead"
  | "net.sockUnshift"
  /** Socket flow control and the compat surface: pause/resume (reads
   * gate off/on — kernel backpressure holds paused bytes; resume flows
   * and discards sans listeners) and setNoDelay answer the SOCKET (+1,
   * Node's chaining); destroySoon ends now and destroys once the FIN
   * flushed; bytesWritten counts accepted bytes; readable is true until
   * the read half ends. */
  | "net.sockPause"
  | "net.sockResume"
  | "net.sockSetNoDelay"
  | "net.sockDestroySoon"
  | "net.sockBytesWritten"
  | "net.sockReadable"
  /** socket.on('finish', cb) / end(cb): fires once when the FIN goes out
   * (sweep-deferred, never the registering stack). */
  | "net.sockOnFinish"
  | "net.serverEmitConnection"
  /** node:http, the CLIENT slice (http.request/http.get over the net
   * client machinery): request/requestCb take (host, port, path, method,
   * timeoutMs, headerPairs, autoEnd[, responseCb]) — headerPairs is the
   * flat [k0,v0,...] array (empty for none), autoEnd true is http.get's
   * eager end(). The handle owns one dialed connection (NO pooling — the
   * wire still carries Node's exact head: user headers, then Host,
   * Connection: keep-alive, and the framing header; the socket closes
   * when the response completes). The response delivered to responseCb /
   * 'response' listeners IS an httpReq (IncomingMessage), status and
   * headers parsed from the wire, body via reqOnData/reqOnEnd. Errors are
   * Node-shaped ('connect ECONNREFUSED ip:port', 'socket hang up') and
   * fire 'error' then 'close'; an unhandled 'error' exits 1 like every
   * net handle. clientWrite before end commits to chunked framing unless
   * the caller set content-length; clientEnd(data) before any write sends
   * Content-Length exactly like Node. */
  | "http.request"
  | "http.requestCb"
  /** new http.Agent(opts) / new https.Agent(opts): (secure, keepAlive,
   * keepAliveMsecs, maxSockets, maxFreeSockets, timeoutMs, port) — the
   * numeric options arrive < 0 for "unset" (Infinity/256/none; port
   * seeds the settable defaultPort, Node's option merge). Returns the
   * Agent as a checked-dynamic HANDLE (getName/destroy and the
   * sockets/requests/freeSockets counters dispatch through the dyn
   * handle ops). keepAlive: true THROWS the named construction fence —
   * socket POOLING is not modeled (one dial per request); maxSockets
   * accounting is real: over-limit requests defer their dial and queue.
   * MAY THROW. */
  | "http.agentNew"
  /** The agent-threaded request rows: the http.request/https.request
   * shape with a trailing `agent` dyn argument (an Agent handle, false —
   * the one-shot Connection: close dial — or null/undefined for the
   * default path). port < 0 means "no port option": the agent's settable
   * defaultPort, then the scheme's. MAY THROW (a non-Agent value is
   * Node's ERR_INVALID_ARG_TYPE). */
  | "http.requestAgent"
  | "http.requestAgentCb"
  | "https.requestAgent"
  | "https.requestAgentCb"
  /** The createConnection form (the proxy's own dialer): args are
   * (connCb, path, method, timeout, headers, autoEnd[, cb]) — connCb is
   * a `() => net.Socket` closure the runtime invokes ONCE, synchronously
   * (Node's onSocket timing); everything else matches http.request. The
   * Host header defaults to "localhost" — a headers.host entry wins
   * verbatim, the proxy shape. */
  | "http.requestConn"
  | "http.requestConnCb"
  /** node:tls + node:https (scr_tls.c over scr_net.c/scr_http.c, with
   * the vendored mbedTLS archive — linked only when one of these appears
   * on the IR; moduleUsesTls is the switch, and every tls/https libCall
   * also counts as net AND http use so both units link and install).
   * tls.createServer takes (cert, key[, handler]) — cert/key are PEM
   * strings or Buffers (the emitter passes data+len for either); the
   * handler is Node's 'secureConnection' (fires post-handshake with a
   * socket that behaves exactly like a net socket, the same adapters as
   * net.createServer). https.createServer is (cert, key, handler) with
   * the http request-handler adapters. https.request/requestCb extend
   * the http client row with (…, rejectUnauthorized: bool, ca: PEM
   * string/Buffer — "" for none) and default port 443; everything else
   * (write/end/destroy/events, the response surface) IS the http client
   * surface — the handles are the same kinds. */
  | "tls.createServer"
  | "tls.createServerCb"
  /** RUNTIME options records (the divergence-66 stance): the *Dyn
   * creators take a checked-dynamic (dyn) options value whose members
   * read at runtime — cert/key extract like the literal path, members
   * whose literal forms fence THROW the catchable fence at runtime, and
   * undocumented keys drop like Node drops them. tls.pemDyn is the
   * literal walk's runtime-valued cert/key extraction: (value, whatLit)
   * → PEM bytes (strings/Buffers/one-element arrays of those) or the
   * thrown fence. All of them may throw. */
  | "tls.pemDyn"
  | "tls.createServerDyn"
  | "tls.createServerDynCb"
  | "https.createServerDyn"
  | "https.createServerDynCb"
  /** tls.connect — the TLS client socket: (port, host, opts[, cb]) where
   * port -1 reads options.port, host "" reads options.host, and opts is
   * the runtime (dyn) options record (rejectUnauthorized/ca/servername
   * implemented; other documented members throw the runtime fence). The
   * callback fires post-handshake — Node's secureConnect timing. */
  | "tls.connect"
  | "tls.connectCb"
  /** The TLSSocket member surface on the socket kind: authorized (bool —
   * Node's verify verdict), authorizationError (the verify-failure CODE
   * STRING or null), the 'secureConnect' registration (a TLS socket's
   * conn list fires at establishment; plain sockets never fire it), and
   * the 'session' registration (fires once with the serialized session —
   * a Buffer; the received-ticket event). */
  | "tls.sockAuthorized"
  | "tls.sockAuthError"
  | "tls.sockOnSecureConnect"
  | "tls.sockOnSession"
  /** tls.createSecureContext({ cert, key }) — parses the PEM pair into an
   * opaque SecureContext handle (secureCtx kind) for SNI callbacks to
   * answer with; cert/key are PEM strings or Buffers like createServer's. */
  | "tls.createSecureContext"
  /** createSecureContext over a RUNTIME options record (the checked-
   * dynamic lane): Node's typed option validations first (the ciphers/
   * passphrase/engine/version/timeout/ticketKeys ladders), then the pem
   * walk — a validated { cert, key } bag builds the real context.
   * May-throw. */
  | "tls.createSecureContextDyn"
  /** tls.getCACertificates(type): validateString + the documented name
   * set, then the trailing compiler-rendered fence — ALWAYS THROWS (the
   * error.nodeThrow polymorphic-result carve-out). May-throw seed. */
  | "tls.caCertsChk"
  /** The CA-store introspection surface (scr_tls_ca.c — its own unit and
   * link gate, "tlsca." NOT "tls.", so a getCACertificates-only binary
   * never pulls mbedTLS): tlsca.get is tls.getCACertificates(type) — the
   * cached per-type string[] of PEM blocks (identity-stable across calls,
   * Node's caching; an unknown type throws Node's ERR_INVALID_ARG_VALUE
   * TypeError); tlsca.root is the tls.rootCertificates value read;
   * tlsca.set is tls.setDefaultCACertificates(certs) — replaces the
   * default set (deduped) and the anchors the TLS client verifies
   * against, throwing Node's ERR_CRYPTO_OPERATION_FAILED when no entry
   * carries a certificate block. */
  | "tlsca.get"
  | "tlsca.root"
  | "tlsca.set"
  | "https.createServer"
  | "https.request"
  | "https.requestCb"
  /** The URL-string first argument, the http.requestUrl row over TLS:
   * no options means Node's defaults (verification on, default trust
   * anchors), and a non-https scheme is ERR_INVALID_PROTOCOL. */
  | "https.requestUrl"
  | "https.requestUrlCb"
  /** A call through a `const requestFn = tls ? https.request :
   * http.request` binding — the module-function-as-value ternary between
   * the two known clients: the https.request row with a leading `secure`
   * bool that picks the dial at RUNTIME (true = the TLS client, exactly
   * https.request; false = the plain client, exactly http.request —
   * rejectUnauthorized/ca ignored there like Node ignores TLS options on
   * http.request). The "https." prefix keeps the TLS unit linked. */
  | "https.requestFn"
  | "https.requestFnCb"
  /** node:http2 allowHTTP1: one TLS server advertises h2 + http/1.1 and
   * dispatches to the matching parser after ALPN. Request listeners mirror
   * into both compatibility lists; the remaining session/req.stream rows
   * below retain their explicitly limited behavior. */
  | "http2.createSecureServer"
  /** createSecureServer(options, handler) — the eager COMPAT handler as
   * the first 'request' listener (Node's exact route), on both literal
   * flavors: Req is the dual ALPN allowHTTP1 server, H2Req the ALPN=h2-only
   * server (both use compat handles over h2 streams). Args are
   * (cert, key, cb, enableConnectProtocol). */
  | "http2.createSecureServerReq"
  | "http2.createSecureServerH2Req"
  /** createSecureServer with a RUNTIME options record (the divergence-66
   * stance): allowHTTP1/cert/key read at runtime — allowHTTP1 picks the
   * flavor, the TLS server walk fences its out-of-bounds members with
   * the catchable runtime fence, and h2 session-tuning keys drop exactly
   * like the literal walk ignores them. May throw. The Cb form carries
   * the eager compat handler. */
  | "http2.createSecureServerDyn"
  | "http2.createSecureServerDynCb"
  /** createSecureServer with an SNI callback: args are (cert, key, sniCb)
   * where sniCb is the JS SNICallback — a `(servername, cb) => void`
   * closure, or the `SNICallback | undefined` union from the conditional-
   * spread spelling (`...(x ? { SNICallback: x } : {})`; the emitter
   * unwraps the union — the undefined arm means "no callback", exactly
   * the no-SNI server). The runtime parses each connection's ClientHello
   * for the server_name extension BEFORE the TLS handshake begins, calls
   * the callback with (servername, answer-closure), and resumes the
   * handshake when the answer arrives — cb(err) tears the socket down
   * silently (Node's 'tlsClientError' default), cb(null, ctx) serves
   * ctx's cert/key, cb(null, undefined) serves the default pair. */
  | "http2.createSecureServerSni"
  /** The REAL h2-over-TLS server (createSecureServer WITHOUT allowHTTP1):
   * scr_http2_create_secure_server — the h2c session machinery behind an
   * mbedTLS handshake whose ALPN advertises h2 alone (an http/1.1-only
   * client fails the handshake with no_application_protocol, Node's
   * h2-only split). args are (cert, key) — PEM strings or Buffers. */
  | "http2.createSecureServerH2"
  | "http.serverOnRequest"
  | "http2.serverOnSessionError"
  /** The guarded absent-session compatibility call remains a no-op. */
  | "http2.streamNoop"
  /** The UNGUARDED h2-only stream call (`req.stream.on(...)`): stream is
   * undefined on every connection the allowHTTP1 lowering accepts — and
   * on every HTTP/1.1 connection of Node's own allowHTTP1 server — so the
   * call IS Node's member read on undefined: throws the exact catchable
   * TypeError ("Cannot read properties of undefined (reading 'on')").
   * One arg: the read member's name (a string literal). Never returns. */
  | "http2.streamUndefCall"
  /** node:http2, the REAL h2c surface (scr_http2.c — frame codec + HPACK
   * over the net loop; the design note atop that file has the story).
   * Sessions and streams are first-class handle kinds; 'stream'/'response'
   * payloads cross as flat [name, value, ...] pairs arrays and an EMITTED
   * adapter closure builds the program-side headers record (the response
   * :status rides separately as a number). */
  | "http2.createServer"
  | "http2.createServerReq"
  | "http2.serverOnStream"
  | "http2.serverOnSession"
  /** connect(authority[, listener]) — h2c prior knowledge; the listener
   * closure (if any) is the 'connect' once-listener. */
  | "http2.connect"
  | "http2.connectCb"
  /** session.request(pairs?, endStream) — endStream is a tri-state f64:
   * -1 the method's payload-meaningless default, 0/1 explicit. */
  | "http2.sessionRequest"
  | "http2.sessionClose"
  | "http2.sessionCloseCb"
  | "http2.sessionDestroy"
  | "http2.sessionOnClose"
  | "http2.sessionOnError"
  | "http2.sessionOnConnect"
  | "http2.sessionOnStream"
  | "http2.sessionOnGoaway"
  | "http2.sessionSettings0"
  | "http2.sessionSettings"
  | "http2.sessionSettingsDynCb"
  | "http2.sessionSettingsCb0"
  | "http2.sessionOnSettingsDyn"
  | "http2.sessionOnSettings0"
  | "http2.sessionSettingsGet"
  | "http2.sessionPendingSettingsAck"
  | "http2.getDefaultSettings"
  | "http2.sessionClosed"
  | "http2.sessionDestroyed"
  | "http2.sessionEncrypted"
  | "http2.sessionType"
  | "http2.sessionAlpn"
  | "http2.sessionSocket"
  /** stream.respond(pairs?, endStream) — the server answer. */
  | "http2.streamRespond"
  | "http2.streamWrite"
  | "http2.streamWriteBytes"
  | "http2.streamEnd"
  | "http2.streamEndStr"
  | "http2.streamEndBytes"
  | "http2.streamClose"
  | "http2.streamCloseCb"
  | "http2.streamDestroy"
  | "http2.streamSetEncoding"
  | "http2.streamSetEncodingRet"
  | "http2.streamResume"
  | "http2.streamPause"
  | "http2.streamOnData"
  | "http2.streamOnEnd"
  | "http2.streamOnClose"
  | "http2.streamOnAborted"
  | "http2.streamOnError"
  | "http2.streamOnResponse"
  | "http2.streamId"
  | "http2.streamRstCode"
  | "http2.streamDestroyed"
  | "http2.streamClosed"
  | "http2.streamAborted"
  | "http2.streamPending"
  | "http2.streamSession"
  /** socket.encrypted — `boolean | undefined`: the true arm iff the
   * socket carries a TLS transport (Node types `encrypted: true` on
   * TLSSocket; plain sockets answer undefined — the proxy.ts isEncrypted
   * idiom reads it through a cast). */
  | "net.sockEncrypted"
  | "http.clientWrite"
  | "http.clientWriteBytes"
  | "http.clientEnd"
  | "http.clientEndStr"
  | "http.clientEndBytes"
  /** The checked-dynamic chunk twins (the net.sockWriteDyn story). */
  | "http.clientWriteDyn"
  | "http.clientEndDyn"
  /** request/get with a URL-STRING first argument: the runtime parses it
   * (WHATWG) and dials — throws catchably on an unparsable input or a
   * non-http scheme. */
  | "http.requestUrl"
  | "http.requestUrlCb"
  | "http.clientDestroy"
  | "http.clientDestroyed"
  | "http.clientOnResponse"
  | "http.clientOnError"
  | "http.clientOnTimeout"
  | "http.clientOnClose"
  /** fs/promises (scr_lib.c over scr_async.c's settled minting): the SAME
   * sync syscalls, wrapped in an ALREADY-SETTLED promise — failure
   * REJECTS (catchable at the await) instead of throwing, so none of
   * these are in the may-throw seed. readFile is utf8-fenced like
   * readFileSync. The non-interleaving divergence is documented in
   * SEMANTICS.md. */
  /** node:crypto, the string-producing slice: randomUUID (never throws)
   * and the COMPOSED randomBytes(n).toString("hex"|"base64") — one
   * libCall, the Buffer never escapes (bare randomBytes is fenced).
   * randomBytesToString THROWS Node's RangeError on out-of-range sizes. */
  | "crypto.randomUUID"
  | "crypto.randomBytesToString"
  /** The COMPOSED hash chain createHash(alg).update(data).digest(enc)
   * fused into one call — the Hash handle never materializes. Args are
   * (alg, data, enc); alg is "sha256" | "sha1" and enc "hex" | "base64",
   * both compile-time literals (frontend-fenced). Strings hash their
   * UTF-8 bytes (Node's default input encoding); the bytes form hashes a
   * Buffer/typed array's bytes. Pure; never throw. */
  | "crypto.hashDigestStr"
  | "crypto.hashDigestBytes"
  /** crypto.randomBytes(n) → a real u8 Buffer (+1). THROWS Node's
   * RangeError on out-of-range sizes, exactly like the composed
   * randomBytesToString (which keeps its one-libCall lowering — the two
   * coexist: the composed form never materializes the Buffer). */
  | "crypto.randomBytes"
  /** The Buffer statics with fixed (always-u8) signatures. fromStr is
   * `Buffer.from(string, enc)` — the frontend completes an omitted
   * encoding to "utf8" and fences non-literal/unsupported ones; hex and
   * base64 decode Node-leniently, so it never throws. concat takes ONE
   * bytes<u8>[] arg (the list) and returns a fresh copy. `Buffer.from(u8)`
   * and `Buffer.alloc(n)` need no libFn — they lower to bytesNew. */
  | "buffer.fromStr"
  | "buffer.concat"
  /** Buffer.byteLength(string, enc) — enc a NORMALIZED literal like
   * fromStr's — and Buffer.isEncoding(name) over a runtime string
   * (case-insensitive against Node's alias set). Pure; never throw. */
  | "buffer.byteLenStr"
  | "buffer.isEncoding"
  /** Buffer.concat(list, totalLength): the concatenation truncated or
   * zero-padded to the total. THROWS Node's 'length' RangeError on a
   * negative/non-integer total (may-throw seed). */
  | "buffer.concatLen"
  /** The checked-dynamic compare/equals validators (scr_bytes_io.c) —
   * the lowered form when an argument is NOT statically bytes<u8> (the
   * invalid-input probes; a dyn from an untyped JS helper): Node's own
   * argument ladders run at runtime — ERR_INVALID_ARG_TYPE with the
   * API's argument name ("buf1"/"buf2", "otherBuffer", "target"; offsets
   * "of type number"), validateOffset's ERR_OUT_OF_RANGE for bad
   * numbers, undefined offsets taking their Node defaults — and a
   * well-typed value still computes the real answer. All args borrowed
   * dyn; compareChk's four offset slots pass the undefined dyn when
   * syntactically absent. May-throw seeds. */
  | "buffer.compareChk"
  | "bytes.equalsChk"
  | "bytes.compareChk"
  /** The deprecated `new Buffer(number, 'enc')` string-arm rejection:
   * always throws Node's ERR_INVALID_ARG_TYPE ("The \"string\" argument
   * must be of type string. Received ..."). Borrowed dyn; may-throw. */
  | "buffer.newStringFail"
  /** fs._toUnixTimestamp(time) over a dyn value: numeric strings and
   * finite numbers coerce (negatives answer now/1000, Node's shape);
   * everything else throws Node's ERR_INVALID_ARG_TYPE. May-throw. */
  | "fs.toUnixTimestamp"
  /** The fs argument-validation ladders (checked-dynamic lane): each Chk
   * replicates its API's Node-order validation over dyn values (Node's
   * exact typed errors — ERR_INVALID_ARG_TYPE/VALUE, ERR_OUT_OF_RANGE),
   * and a full pass meets the trailing compiler-rendered SC2020 fence
   * string — so the ALWAYS-THROW forms take the error.nodeThrow
   * polymorphic-result carve-out. mkdtempSyncChk and the lchmod sync/
   * promise pair run the REAL operation on a validated pass instead
   * (macOS lchmod(2); non-APPLE answers Node's not-a-function /
   * ERR_METHOD_NOT_IMPLEMENTED shapes). May-throw seeds, all of them. */
  | "fs.existsChk"
  | "fs.mkdtempChk"
  | "fs.mkdtempSyncChk"
  | "fs.readFileChk"
  | "fs.opendirChk"
  | "fs.watchFileChk"
  | "fs.lchmodChk"
  | "fs.lchmodSyncChk"
  | "fsp.lchmodChk"
  | "fs.readChk"
  | "fs.streamOptsChk"
  /** The compiler-resolved ERR_INVALID_ARG_TYPE throw with a RUNTIME-
   * rendered Received tail: args [argname, "of type ..." clause, the
   * offending dyn value]. ALWAYS THROWS; polymorphic result (the
   * error.nodeThrow pattern). May-throw seed. */
  | "error.argTypeThrow"
  /** The property flavor of argTypeThrow ("The \"options.x\" property
   * must be ..."): the option-bag ladders' provably-invalid arms. ALWAYS
   * THROWS; polymorphic result. May-throw seed. */
  | "error.propTypeThrow"
  /** The checked-dynamic max-listeners ladders: setMaxChk is the
   * instance form over a dyn n (non-numbers ERR_INVALID_ARG_TYPE,
   * negatives/NaN ERR_OUT_OF_RANGE; +1 receiver back — chaining);
   * setDefaultMaxChk is the static/property form, its second argument
   * naming the message slot ("setMaxListeners" for the static call,
   * "defaultMaxListeners" for the module-property assignment). */
  | "emitter.setMaxChk"
  | "emitter.setDefaultMaxChk"
  /** The Buffer forms of the fs quartet: readFileSync(path) with NO
   * encoding → bytes<u8> (+1), writeFileSync(path, bytes), and the
   * fs/promises readFile(path) no-encoding form (an already-settled
   * promise, rejecting on failure like the other fsp members). The sync
   * pair THROWS catchably on failure exactly like the utf8 forms. */
  | "fs.readFileSyncBytes"
  | "fs.writeFileSyncBytes"
  | "fsp.readFileBytes"
  /** node:zlib (scr_zlib.c — cc.ts compiles/links it ONLY when these
   * appear on the IR, the regex/libcurl gating precedent): deflateSync/
   * inflateSync over u8 bytes with Node's default options. deflate never
   * throws (OOM aborts); inflate of corrupt input THROWS Node's error
   * catchably. */
  | "zlib.deflateSync"
  | "zlib.inflateSync"
  /** The Buffer overloads of the raw stream writes — same promptly
   * submitted streams as process.stdoutWrite/stderrWrite, constantly true.
   * The encoding arg is evaluated but ignored for bytes, like Node. The Cb
   * forms move their program-shaped completion callback to the tick queue. */
  | "process.stdoutWriteBytes"
  | "process.stderrWriteBytes"
  | "process.stdoutWriteBytesCb"
  | "process.stderrWriteBytesCb"
  | "fsp.readFile"
  | "fsp.writeFile"
  /** fs.promises.writeFile(path, data, { mode }): the settled-promise
   * twin of fs.writeFileModeSync. */
  | "fsp.writeFileMode"
  | "fsp.mkdir"
  /** The fs/promises option/member tail the certs pipeline uses: mkdir's
   * literal { recursive?, mode? } options (the mkdirSync matrix behind
   * settled promises), unlink, chmod. Failures REJECT (catchable at the
   * await), like the rest of the fsp family. */
  | "fsp.mkdirMode"
  | "fsp.mkdirRecursive"
  | "fsp.mkdirRecursiveMode"
  | "fsp.unlink"
  | "fsp.chmod"
  | "fsp.rename"
  | "fsp.readdir"
  | "fsp.rm"
  | "fsp.stat"
  /** fs/promises.open and the statically represented FileHandle surface.
   * Every operation returns an already-settled promise; syscall failures
   * become rejections rather than escaping synchronously. read/write
   * results are call-site record shapes ({ bytesRead/bytesWritten,
   * buffer }) assembled by the backends around the fixed runtime ABI. */
  | "fsp.open"
  | "fileHandle.fd"
  | "fileHandle.close"
  | "fileHandle.read"
  | "fileHandle.writeBytes"
  | "fileHandle.writeStr"
  | "fileHandle.readFile"
  | "fileHandle.readFileBytes"
  | "fileHandle.writeFile"
  | "fileHandle.writeFileBytes"
  | "fileHandle.stat"
  | "process.argv"
  | "process.platform"
  /** getenv(3): one string key arg → the interned `string | undefined`
   * union (present: +1 string wrapped into the string arm; absent: the
   * interned undefined-arm instance). BOTH source forms — `process.env.FOO`
   * and `process.env[expr]` — lower here. Purely static; never throws. */
  | "process.envGet"
  /** setenv(3): (name, value) string args → void. Later envGet reads and
   * spawned children observe the write, like Node (values are strings —
   * the frontend fences non-string RHS). Never throws. */
  | "process.envSet"
  /** The whole environment as alternating [k0, v0, k1, v1, ...] strings in
   * environ order — the raw material of the process.env SNAPSHOT record
   * (the frontend's interned %env.snapshot helper keyed-writes the pairs
   * into a fresh `{ [k: string]: string | undefined }` record). Fresh +1
   * array; never throws. */
  | "process.envPairs"
  | "process.exit"
  | "process.cwd"
  /** getpid(2) / getuid(2): zero args → f64. POSIX-only target, so both
   * always answer (the checker's `getuid?` optionality covers Windows —
   * `process.getuid?.()` lowers as the plain call). Never throw. */
  | "process.pid"
  | "process.getuid"
  | "process.getgid"
  /** The ambient receiver — JS `this` in a plain (non-method) function
   * body: the innermost binding the current firing/dispatch window
   * pushed (Node's listener receiver, a dyn OBJ method's object, an
   * apply/call thisArg), or the undefined dyn singleton with none bound
   * (the strict-mode plain-call answer, the old constant). Zero args →
   * dyn (+1). Never throws. */
  | "dyn.this"
  /** process.execPath: the compiled binary's own resolved absolute path
   * (one interned string, +1 per read) — the honest answer where Node's
   * is the node executable's (SEMANTICS.md divergence 12). Never throws. */
  | "process.execPath"
  /** process.arch: the compiled binary's OWN architecture ("arm64",
   * "x64") — Node's answer for its own build on the same machine.
   * Interned; +1 per read. Never throws. */
  | "process.arch"
  /** process.versions.node: the runtime's Node COMPATIBILITY TARGET —
   * there is no Node under the binary, so this reports the version whose
   * semantics the runtime implements (SEMANTICS.md divergence 60, the
   * execPath stance). Interned; +1 per read. Never throws. */
  | "process.versionsNode"
  | "process.versionsOpenssl"
  /** umask(2): arg < 0 reads without setting (umask has no read-only form
   * — set 0, restore); otherwise sets and answers the PREVIOUS mask.
   * Never throws. */
  | "process.umask"
  /** chdir(2) — throws Node's fs-shaped error (ENOENT/EACCES/ENOTDIR,
   * syscall "chdir") on failure. */
  | "process.chdir"
  /** process._exiting: true once the exit sequence began (exit listeners
   * running) — the runtime flag scr_run_exit_listeners/process.exit set.
   * Never throws. */
  | "process.exiting"
  /** os.type(): uname(2)'s sysname ("Darwin", "Linux"; "Windows_NT" on
   * win32) — Node's uv_os_uname answer. Interned per call; never throws. */
  | "os.type"
  /** os.totalmem(): total physical memory in bytes. Never throws. */
  | "os.totalmem"
  /** net's process-wide happy-eyeballs attempt budget (Node's default
   * 250ms): one runtime double in the core unit, so reading/writing it
   * never forces the net unit into the link. Never throw. */
  | "net.getAutoSelTimeout"
  | "net.setAutoSelTimeout"
  /** realpath(3) with Node's error shape (syscall "lstat" in the message,
   * Node's own spelling for realpathSync failures). +1 fresh string. */
  | "fs.realpathSync"
  /** kill(2) with Node's exact semantics and error shapes: the pid must be
   * an int32 (else the ERR_INVALID_ARG_TYPE TypeError text), the named
   * form resolves Node's signal-name table (unknown names throw the
   * ERR_UNKNOWN_SIGNAL TypeError), an omitted signal completes to
   * "SIGTERM" in the frontend, signal 0 probes, and a kill(2) failure
   * throws Node's `kill ESRCH`/`kill EPERM` Error. Result is Node's
   * constant true. */
  | "process.kill"
  | "process.killNum"
  /** execFileSync/execSync as ONE entry (args: cmd, argv, shell, input,
   * cwd, hasEnv, envPairs, timeoutMs, stdoutMode, stderrMode — see
   * scr_runtime.h). Throws Node's exact errors: "Command failed: <cmd>"
   * (+ captured stderr) on non-zero exit or signal death, "spawnSync
   * <file> ENOENT" on spawn failure, "spawnSync <file> ETIMEDOUT" after
   * the SIGTERM timeout. Result is the captured utf8 stdout (+1). */
  | "cp.execSync"
  /** The promisified-execFile capture (args: cmd, argv, cwd, hasEnv,
   * envPairs, timeoutMs): the same exec core in the async shape — both
   * streams captured, no echo, Node's ASYNC messages on the throw paths
   * ("Command failed: <cmd>\n<stderr>" with the unconditional newline,
   * "spawn <file> ENOENT" with .code, timeouts reporting as ordinary
   * SIGTERM command failures — never ETIMEDOUT). Result reuses the
   * ScrSpawnRes container (+1; stdout/stderr strings, status unused).
   * Called only from the frontend's interned %execFileAsync ASYNC helper,
   * whose fiber turns the throw into the rejection. */
  | "cp.execCapture"
  /** The raw byte writes: one borrowed string arg → bool (constantly true
   * — this synchronous runtime never queues backpressure). stdoutWrite
   * shares console.log's stream, each call is submitted promptly, and
   * interleaved output keeps source order. No newline, no formatting,
   * never throws. */
  | "process.stdoutWrite"
  | "process.stderrWrite"
  | "timers.setTimeout"
  /** The repeating timer pair. setInterval takes (callback, ms) like
   * setTimeout and RETURNS the f64 handle the fallback declarations
   * promise (ids start at 1, so truthiness narrowing works); the loop
   * owns the callback until clearInterval removes the entry (eagerly — a
   * live interval keeps the loop alive, a cleared one releases it, like
   * Node). Neither throws; a throw ESCAPING an interval callback ends the
   * program like a setTimeout throw. */
  | "timers.setInterval"
  | "timers.clearInterval"
  /** setTimeout WITH a clear handle (the f64 id) — the clearable/unref-able
   * one-shot; clearTimeout cancels it, .unref() drops it from loop
   * liveness. The plain timers.setTimeout stays the handle-less
   * fire-and-forget. */
  | "timers.setTimeoutHandle"
  | "timers.clearTimeout"
  /** Timeout.unref()/ref()/hasRef() — loop-liveness bookkeeping over the
   * handle id. unref/ref RETURN the handle (f64) for chaining; hasRef
   * returns bool. */
  | "timers.unref"
  | "timers.ref"
  | "timers.hasRef"
  /** Timeout.refresh() — re-arm to now + the original delay (from the
   * heap or from inside the firing callback; a one-shot that fired on an
   * earlier turn is gone and no-ops — documented divergence). Returns
   * the handle for chaining like unref/ref. */
  | "timers.refresh"
  /** setImmediate/clearImmediate — Node's check phase: callbacks run
   * once per loop turn AFTER due timers, FIFO, and immediates queued
   * mid-phase wait for the next turn. setImmediate returns the f64
   * handle (its own id space — clearTimeout of an Immediate no-ops,
   * like Node); the Immediate ref trio mirrors the Timeout one (an
   * unref'd pending immediate neither keeps the loop alive nor fires
   * once nothing reffed remains). */
  | "timers.setImmediate"
  | "timers.clearImmediate"
  | "timers.immediateUnref"
  | "timers.immediateRef"
  | "timers.immediateHasRef"
  /** queueMicrotask (scr_async.c): the callback enters the SAME FIFO
   * promise continuations ride — one microtask order, like V8's queue —
   * and a throw is an UNCAUGHT exception (never a rejection).
   * timers.queueMicrotask takes an owned zero-param closure and never
   * throws; the Dyn form (checked-dynamic arguments — the mustCall
   * wrapper, the suite's invalid-input probes) throws Node's
   * ERR_INVALID_ARG_TYPE synchronously on a non-function value and calls
   * the function with zero arguments at drain. */
  | "timers.queueMicrotask"
  | "timers.queueMicrotaskDyn"
  /** The tolerated non-handle clear (`clearTimeout(null)`,
   * `clearInterval({})`, zero-argument forms): Node silently ignores
   * anything that is not a live handle — a VOID no-op the emitter drops
   * (only syntactically side-effect-free arguments take this path). */
  | "timers.clearNoop"
  /** process.nextTick(cb, ...args) — the user tick queue. args: [cb
   * (() => void; trailing call arguments ride the timer surface's
   * interned dyn thunk)]. Ticks drain BEFORE promise jobs at every loop
   * checkpoint, to joint exhaustion with them (Node's tick-then-
   * microtask order); ticks enqueued by station listeners run at the
   * NEXT checkpoint (the stream-tick station divergence, SEMANTICS.md).
   * Pending ticks are always-ready work — the loop neither sleeps nor
   * exits while any exist; ticks scheduled from 'exit' listeners never
   * run (Node). The enqueue itself never throws. */
  | "process.nextTick"
  /** The process introspection statics. uptime: seconds since the
   * binary's own start (fractional — a load-time monotonic anchor).
   * availableMemory/constrainedMemory: libuv's numbers (free-ish bytes;
   * the cgroup cap or 0). cpuUser/cpuSystem (+ threadCpu twins): the
   * process/thread CPU clocks in microseconds — the frontend composes
   * the {user, system} records. The *Diff forms answer current − prev
   * for one field; cpuPrevValidate throws Node's ERR_INVALID_ARG_VALUE
   * RangeError for negative/non-finite prev fields (user first, then
   * system — Node's order; MAY THROW). rusage(idx): one
   * process.resourceUsage() field by canonical index (Node's units).
   * activeResources: the loop's own bookkeeping — 'Timeout' per armed
   * (or firing, uncleared) timer, 'Immediate' per queued unfired
   * immediate; unmodeled resource kinds are absent (SEMANTICS.md). */
  | "process.uptime"
  /** perf_hooks performance.now(): fractional ms since process start. */
  | "perf.now"
  | "process.availableMemory"
  | "process.constrainedMemory"
  | "process.cpuUser"
  | "process.cpuSystem"
  | "process.cpuUserDiff"
  | "process.cpuSystemDiff"
  | "process.threadCpuUser"
  | "process.threadCpuSystem"
  | "process.threadCpuUserDiff"
  | "process.threadCpuSystemDiff"
  | "process.cpuPrevValidate"
  | "process.rusage"
  | "process.activeResources"
  /** Process signal events — process.on/once/off("SIGINT" | "SIGTERM").
   * args: [signo f64 (the frontend bakes the POSIX number), cb, once
   * bool] for on; [signo, cb] for off (cb borrowed, removed by pointer
   * identity — Node's removeListener contract). Handlers run as
   * macrotasks at loop turns; watching replaces the default disposition
   * and removing the last listener restores it; signal listeners never
   * keep the loop alive (Node). Zero-param callbacks only (the ambient
   * shape). Never throw. */
  | "process.onSignal"
  | "process.offSignal"
  /** The process 'exit' event — process.on/once/off("exit"). args: [cb,
   * once bool] / [cb]. Listeners run SYNCHRONOUSLY at termination
   * (normal exit, process.exit(), the uncaught/unhandled exit-1 paths)
   * with the exit code; anything they schedule never runs, like Node.
   * Callback shapes: () => void or (code: number) => void — the emitter
   * picks the runtime adapter. Never throw. */
  | "process.onExit"
  | "process.offExit"
  /** process.stdin listener registration — stdin.on/once("data" | "end" |
   * "error", cb). args: [cb, once bool]. data callbacks: () => void or
   * (chunk: Uint8Array) => void; end: () => void; error: () => void or
   * (err: Error) => void (the child error adapters are reused). While a
   * data listener (or a parked for-await chunk promise) exists, stdin
   * keeps the loop alive — Node's flowing-stdin keep-alive. Never
   * throw. */
  | "stdin.onData"
  | "stdin.onEnd"
  | "stdin.onError"
  /** The for-await chunk source over process.stdin: no args, result
   * Promise<Uint8Array> (+1). Fulfills with the next arrived chunk; the
   * EMPTY bytes value is the done sentinel (POSIX reads never deliver
   * empty data chunks), which the for-await desugar turns into loop
   * exit. Never throws itself; awaiting it re-throws nothing (stdin
   * errors surface through 'error' listeners, not the iterator). */
  | "stdin.nextChunk"
  /** The runtime-provided Error hierarchy's entry points (scr_error.c).
   * error.new: one borrowed string arg (the message), result an owned (+1)
   * builtin error instance — the result TYPE names which builtin class
   * (backends derive the runtime kind from it). error.ctor: the
   * super(message) call of an `extends Error` constructor — borrowed
   * receiver (already allocated by the derived class's new) + borrowed
   * message, void; the receiver's type names the builtin class whose name
   * field to stamp. error.toString: borrowed `%Error`-typed receiver, +1
   * string in Node's "name: message" shape. None of the three throws. */
  | "error.new"
  /** The compiler-resolved Node-parity throw for always-throwing lowered
   * arms (ERR_INVALID_THIS receivers, ERR_MISSING_ARGS arity ladders,
   * the symbol-to-string TypeError): args are [error-kind f64 (the
   * SCR_ERR_* index: 0 Error, 1 TypeError, 2 RangeError), code (empty =
   * no code slot), message]. ALWAYS THROWS catchably; the result type is
   * the replaced expression's own (never materialized — the
   * global.undefRead pattern). May-throw seed. */
  | "error.nodeThrow"
  /** JS ToString over a dyn value WITH the object protocol (a user
   * toString/valueOf member is CALLED and its throw propagates;
   * exhaustion throws "Cannot convert object to primitive value"; units
   * render "null"/"undefined") — the WHATWG USVString conversions
   * (URLSearchParams names/values). Borrowed dyn; +1 string. May-throw. */
  | "dyn.toStringCoerce"
  /** A read of a `declare`d const NOTHING defines (the bundler-define
   * pattern — __VERSION__): always throws the catchable ReferenceError
   * Node raises at the access ("<name> is not defined"). args[0] is the
   * name; the result type is the read's declared type (a typed dummy the
   * unwind abandons — the value never exists). */
  | "global.undefRead"
  /** `X.name` through a class VALUE (scr_object.c): args[0] is a borrowed
   * classval; the result is the class object's stored .name string,
   * retained (+1 — the string is an interned immortal, so the retain is a
   * no-op, kept for ownership uniformity). Never throws. A direct
   * `C.name` on the class name itself folds to a strLit instead. */
  | "class.name"
  | "error.ctor"
  | "error.toString"
  /** `new DOMException(message?, nameOrOptions?)` (scr_error.c): both args
   * are borrowed dyn values (the lowering passes the dyn undefined for an
   * absent argument, so WebIDL's optionality lives in one place). The
   * runtime ToStrings the message ("" for absent/undefined), resolves the
   * name — absent/undefined → "Error", a non-null object → ToString of its
   * `name` member plus the `cause` own-property record, anything else →
   * ToString — and stamps the legacy code from the WebIDL name table (0
   * off-table). Result is an owned (+1) %DOMException. Never throws (dyn
   * ToString is total). */
  | "error.newDom"
  /** DOMException's own read surface (scr_error.c; %DOMException receivers
   * only — borrowed). domCode: the legacy numeric code. domHasCause: the
   * options form's own-property record (`'cause' in e`). domCause: the
   * cause value, +1 (the dyn undefined when absent — matching Node's
   * undefined read). None throws. */
  | "error.domCode"
  | "error.domHasCause"
  | "error.domCause"
  /** structuredClone of a %DOMException receiver (scr_error.c): WebIDL
   * serialization — name/message copy, the legacy code re-derives, cause
   * does not serialize. args are the borrowed receiver and the borrowed
   * options dyn value (the dyn undefined when absent — the shared
   * validation throws Node's exact option errors; any non-empty transfer
   * list throws DataCloneError, nothing static is transferable). Result
   * +1 %DOMException. */
  | "error.domClone"
  /** `d instanceof TypeError` (and the other BUILTIN error classes) on a
   * checked-dynamic value (scr_json.c): the from_error cache holds the
   * dyn↔error identity edge, so the test resolves the runtime error and
   * asks its vtable's stamped preorder interval — exact for every error
   * that crossed the boundary. A dyn object that never came from an
   * error (a hand-built {%error} literal) answers false: subclass
   * identity is unknowable there (the root keeps dynTest's marker
   * answer). args are the borrowed dyn and the SCR_ERR_* kind literal.
   * Never throws. */
  | "dyn.errInstanceof"
  /** Object.keys/values/entries over a CHECKED-DYNAMIC receiver
   * (scr_json.c): the runtime walks the dyn node's own members in JS
   * own-key order (array-index keys ascending first, then insertion
   * order) and answers a dyn array (entries: an array of [key, value]
   * pairs; values RETAIN the member nodes — reference semantics, like
   * JS). Strings/arrays/bytes answer their index keys; other scalars an
   * empty array; null/undefined throw Node's catchable TypeError
   * ("Cannot convert undefined or null to object"). */
  | "dyn.objKeys"
  | "dyn.hasOwn"
  | "dyn.assign"
  /** Variadic Object.assign over CHECKED-DYNAMIC targets (`Object.assign(
   * {}, ...arr.map(f), tail)` — the option-table merge): the lowering
   * builds one fresh dyn pack of sources (packPush retains a plain source
   * in; packPushSpread flattens a spread source through the spread-call
   * walk — V8's exact TypeError texts, the string arg spelling the spread
   * expression for the nullish form), so every source evaluates and
   * flattens BEFORE any copying (JS's ArgumentListEvaluation), then
   * assignAll copies each pack element's own enumerable keys onto the
   * target left to right and answers the TARGET (+1) — identity, like JS.
   * assignAll throws Node's ToObject TypeError on a nullish target. */
  | "dyn.packPush"
  | "dyn.packPushSpread"
  /** The iterated-path spread twin: V8 spells the optimized apply-path
   * texts (packPushSpread's — the expression named for nullish sources)
   * only for the SINGLE LAST argument's spread; any other spread position
   * drives the real iterator protocol, whose failure describes the VALUE
   * ("object null is not iterable (cannot read property
   * Symbol(Symbol.iterator))"). The frontend picks by position. */
  | "dyn.packPushSpreadIter"
  | "dyn.assignAll"
  /** `Object.create(null)` (scr_json.c): a fresh NULL-PROTOTYPE dyn
   * dictionary. The checked-dynamic tree's OBJ dispatch is already own-member-only —
   * Node's null-proto answer — so the flag's whole job is the observations
   * that SEE the prototype: inspect's "[Object: null prototype]" prefix
   * and deepStrictEqual's prototype gate. Never throws. Static builds
   * only; --dynamic routes Object.create through the engine instead. */
  | "dyn.objCreateNullProto"
  | "dyn.objValues"
  | "dyn.objEntries"
  /** structuredClone over the checked-dynamic tree (scr_json.c): the JSON-safe subset plus
   * bytes (a fresh copy — a Buffer clones as a plain Uint8Array, like
   * Node), deep. Functions and handle kinds throw the spec's catchable
   * DataCloneError; CYCLES throw the scriptc fence (the checked-dynamic tree cannot
   * represent them — Node clones cycles; documented divergence). The
   * options dyn value validates with Node's exact errors (dictionary
   * conversion, the transfer-sequence member; any non-empty transfer
   * list throws DataCloneError). dyn.cloneMissing is the zero-argument
   * call: always throws Node's TypeError [ERR_MISSING_ARGS] with Node's
   * own (verbatim, doubly-wrapped) message. */
  | "dyn.structuredClone"
  | "dyn.cloneMissing"
  /** `new RegExp(pattern, flags?)` (scr_regex.c): a heap regex over the
   * same libregexp engine the literals use. The pattern compiles EAGERLY
   * so an invalid pattern (or an unknown flag letter) throws Node's
   * catchable SyntaxError at construction — Node's message shape with
   * libregexp's detail text (approximate fidelity; e.name exact). An
   * empty pattern stores the spec's "(?:)" source. Both args borrowed
   * strings (the lowering completes an absent flags to ""); result +1.
   * The result TYPE is the regex kind, so the link switch pulls the
   * engine exactly like a literal. */
  | "regex.new"
  /** structuredClone with a NON-EMPTY transfer array of static values:
   * nothing static is transferable, so the call always throws Node's
   * catchable DataCloneError ("Found invalid value in transferList.") —
   * lowered directly (the list's values need no dyn representation to
   * fail). */
  | "dyn.cloneTransferFail"
  /** node:events EventEmitter (scr_events_emitter.c, link-gated by
   * moduleUsesEmitter). The receiver of every instance form is a borrowed
   * emitter-hierarchy object (`%EventEmitter` or a user subclass — the
   * backend reinterprets to ScrEmitter*, the identical prefix); event
   * names are borrowed strings (compile-time literals — the frontend
   * fences non-literals and unifies each event's argument tuple program-
   * wide). The chaining forms (on/off/removeAll/setMax) return the
   * receiver +1 typed as its static class, Node's `return this`.
   *
   * emitter.new: `new EventEmitter()` → a +1 bare emitter. emitter.ctor:
   * super() into the prefix of an emitted subclass (borrowed receiver,
   * void — allocation already initialized the prefix). emitter.on:
   * (recv, name, cb /moves/, once, prepend) — the backend synthesizes the
   * per-signature va_list invoke adapter from the cb's func type.
   * emitter.emit: (recv, name, ...tuple) — VARIADIC, the one libCall
   * whose arg count exceeds its signature; args are borrowed, result is
   * the had-listeners bool. emitter.emitError: emit('error', err) —
   * throws err when unhandled. count/countFn/names/listeners/getMax/
   * setMax/setDefaultMax/getDefaultMax are the introspection surface. */
  | "emitter.new"
  | "emitter.ctor"
  | "emitter.on"
  | "emitter.off"
  | "emitter.checkListener"
  | "emitter.onDyn"
  | "emitter.offDyn"
  | "emitter.removeAll"
  | "emitter.emit"
  | "emitter.emitError"
  | "emitter.count"
  | "emitter.countFn"
  | "emitter.names"
  | "emitter.listeners"
  | "emitter.setMax"
  | "emitter.getMax"
  /** Stream-'data' registration twins of emitter.on/onDyn (same args):
   * chosen at registration sites whose receiver is stream-rooted, so the
   * backend emits DATA thunks — the runtime's 'data' emission carries
   * BOTH payload slots (bytes, string; exactly one non-NULL — encoded
   * streams deliver strings), and the thunk unwraps the listener's
   * declared side (typed) or boxes by tag (dyn). emitter.emitData is the
   * user-emit form: (recv, name, chunk) with a bytes OR string chunk. */
  | "emitter.onData"
  | "emitter.onDataDyn"
  | "emitter.emitData"
  | "emitter.setDefaultMax"
  | "emitter.getDefaultMax"
  /** node:stream (scr_stream.c, link-gated by moduleUsesStream — which
   * implies the emitter unit: stream events dispatch through the embedded
   * ScrEmitter registry). Receivers are borrowed stream-class objects
   * (`%Readable`/`%Writable`/`%Duplex`/`%Transform`/`%PassThrough` — one
   * runtime layout, reinterpreted by side).
   *
   * Constructors (`readable.new` et al): args are [hwmR, hwmW, flags]
   * followed by the PRESENT user callbacks in canonical order (read,
   * write, final, destroy, transform, flush — the flags f64 is a bitmask
   * naming which follow; absent ones emit NULL). Every callback closure
   * MOVES and carries a leading `this` param (the stream), invoked
   * through compiler-emitted adapters. Results are +1.
   *
   * readable.push / readable.pushStr / readable.pushNull: Node's push —
   * buffers or delivers (bytes chunk borrowed; string converted utf8);
   * returns the below-hwm answer. readable.read: (recv, size — -1 for
   * absent) → Buffer|null union. pause/resume return recv +1 (`this`);
   * isPaused answers the flag. readable.pipe: (recv, dst, end) → dst +1,
   * fires 'pipe' on dst; readable.unpipe (recv[, dst]) → recv +1.
   * writable.write/writeStr: (recv, chunk[, cb]) → below-hwm bool (cb
   * MOVES when present, called after the user write completes).
   * writable.end: (recv, flags[, chunk][, cb]) → recv +1. cork/uncork are
   * void. stream.destroy/destroyErr: (recv[, err]) → recv +1.
   * stream.prop: (recv, name-literal) → the flag/number the name asks
   * for; stream.errored → Error|null union; readable.flowing →
   * bool|null union. All may leave a listener's exception pending
   * (dispatch runs user code synchronously, like emit). */
  | "readable.new"
  | "writable.new"
  | "duplex.new"
  | "transform.new"
  | "passthrough.new"
  /** Subclass initialization (`super(options?)` in a user `extends
   * Readable` constructor): same tail as the `.new` forms, prefixed with
   * the BORROWED receiver (the emitted subclass allocation — vtable and
   * display name stamped, state NULL until here). Overridden underscore
   * methods arrive as synthesized wrapper closures dispatching through
   * the vtable. Void result. */
  | "readable.init"
  | "writable.init"
  | "duplex.init"
  | "transform.init"
  | "passthrough.init"
  /** The dyn-options twins (a checked-dynamic options record — the JS
   * lane's `super(options)` forwarding and `new Readable(dynVar)`): the
   * option walk runs at RUNTIME with Node's reading rules. newDyn:
   * (optsDyn) → the fresh stream; initDyn: (recv, optsDyn, flags,
   * ...fallback wrapper closures in canonical order — the flags literal
   * names which ride, exactly the .init callback ABI). MAY THROW (a
   * consumed-but-unlowered option is the compile fence's runtime twin). */
  /** stream.finished(s, cb) — the callback form: the watcher fires once
   * at the terminal point with the finish status; the result is the +1
   * cleanup closure. stream.pipeline(count, s1..sn, cb): chains pipes,
   * propagates the first error by destroying the rest, calls cb after the
   * last 'close'; answers the destination +1. The Dyn twins take the
   * callback as a checked-dynamic VALUE (mustCall wrappers). */
  | "stream.finished"
  | "stream.finishedDyn"
  | "stream.pipeline"
  | "stream.pipelineDyn"
  /** node:stream/promises — the promise forms over the same machinery:
   * sp.finished: (s) → a pending void promise the terminal watcher
   * settles; sp.pipeline: (count, s1..sn) → the callback pipeline's
   * chaining/destroyer semantics settling a void promise (fulfilled on a
   * clean finish, rejected with the finish status otherwise). */
  | "sp.finished"
  | "sp.pipeline"
  /** node:stream/consumers — the promise consumers over the readable
   * machinery: (s) → a pending promise settled at the terminal point
   * with the accumulated result (sc.text: the utf8 decode, sc.json: the
   * parsed dyn — malformed input rejects with the parse's SyntaxError,
   * sc.buffer: the concatenated bytes) or rejected with the stream's
   * error / ERR_STREAM_PREMATURE_CLOSE. */
  | "sc.text"
  | "sc.json"
  | "sc.buffer"
  | "readable.newDyn"
  | "writable.newDyn"
  | "duplex.newDyn"
  | "transform.newDyn"
  | "passthrough.newDyn"
  | "readable.initDyn"
  | "writable.initDyn"
  | "duplex.initDyn"
  | "transform.initDyn"
  | "passthrough.initDyn"
  | "readable.push"
  | "readable.pushStr"
  | "readable.pushNull"
  | "readable.pushU"
  | "readable.pushDyn"
  | "readable.unshift"
  | "readable.unshiftStr"
  | "readable.read"
  | "readable.pause"
  | "readable.resume"
  | "readable.setEncoding"
  /** push(chunk, enc) with a literal non-utf8 encoding, and the
   * defaultEncoding option's push side (how push(string) decodes —
   * Buffer.from(chunk, enc)); both carry the CANONICAL literal. */
  | "readable.pushStrEnc"
  | "readable.pushEncoding"
  /** for-await over a readable (the desugared loop's per-pass promise):
   * +1 promise of the next chunk — buffered content, the EOF sentinel
   * (empty Buffer / dyn undefined), or a rejection with the stream's
   * error. The Dyn twin boxes chunks by runtime tag (the JS lane).
   * readable.fromArr is Readable.from(array): a fully-seeded object-
   * entry stream (one whole chunk per element; strings per the flag). */
  | "readable.nextChunk"
  | "readable.nextChunkDyn"
  | "readable.fromArr"
  | "readable.isPaused"
  | "readable.pipe"
  | "readable.unpipe"
  | "readable.flowing"
  | "writable.write"
  | "writable.writeStr"
  | "writable.writeU"
  | "writable.writeDyn"
  | "writable.end"
  | "writable.cork"
  | "writable.uncork"
  | "stream.destroy"
  | "stream.destroyErr"
  | "stream.prop"
  | "stream.errored"
  /** The underscore-method assignment surface (`r._read = fn` after
   * construction — Node's own-property shadow of the prototype method):
   * args [stream receiver (borrowed), callback closure (+1 moves)]. The
   * runtime slot the matching option callback fills swaps its closure
   * and invoke thunk; the next dispatch uses it (Node's timing). The
   * setters themselves never throw. */
  | "stream.setRead"
  | "stream.setWrite"
  | "stream.setFinal"
  | "stream.setDestroy"
  | "stream.setTransform"
  | "stream.setFlush"
  /** NodeJS.ErrnoException's `.code` read: borrowed error-hierarchy
   * receiver → the interned `string | undefined` union (type-directed
   * construction in the backend, the process.envGet pattern) — the errno
   * name where a throw site stamped one (fs, exec spawn/timeout,
   * process.kill, the spawn 'error' event), the undefined arm everywhere
   * else. Never throws. */
  | "error.code"
  /** node:assert (scr_assert.c; assert.match in scr_regex.c — every call
   * site carries a regex value, so the regex link switch is already on).
   * Failures throw a catchable AssertionError — a runtime %Error whose
   * name is "AssertionError" and whose code slot is "ERR_ASSERTION" — so
   * `instanceof Error`, `.name`, `.message`, and `.code` all answer like
   * Node's. Generated messages are Node's assertion_error.js scalar forms
   * byte-exactly (the short `a !== b` form, the stacked `+ actual
   * - expected` diff with the string `^` indicator, the inline-vs-block
   * not-equal split); composite deep failures carry the header line
   * without the rendered inspect diff (documented divergence).
   *
   * assert.ok: (pass, message) — the frontend computed the truthiness AND
   * the full message (the user's, or the compile-time source-text form —
   * assert.fail lowers here too with pass=false). assert.eqF64/eqStr/
   * eqBool: (a, b, negated, deep, msg, hasMsg) — Object.is comparison,
   * covering strictEqual/notStrictEqual and the scalar deepStrictEqual
   * pair; msg is a typed dummy ("" literal) when hasMsg is false (Node
   * distinguishes an omitted message from an empty one per operator).
   * assert.deepResult: (equal, negated, msg, hasMsg) — the verdict of a
   * frontend-synthesized structural comparison, turned into Node's throw.
   * assert.sameValue: Object.is over doubles (the deep-equal helpers'
   * number leaf; never throws). assert.match: (s, regex, negated, msg,
   * hasMsg) — a fresh exec from index 0. assert.throwsNone: (rejection,
   * ename, hasEname, msg, hasMsg) — the "Missing expected
   * exception|rejection" throw of assert.throws/rejects whose callback
   * returned (fulfilled) normally, with Node's ` (${expected.name})`
   * detail when the expected class or shape carries a name.
   * assert.throwsMismatch: (expectedName, error) — the wrong-class throw
   * of the assert.throws(fn, ErrorClass) form. assert.eqSym:
   * (a, b, negated, deep, msg, hasMsg) — strict equality over symbol
   * values, pointer identity with v24's "Symbol(desc)" stacked-diff
   * messages (scr_symbol.c, the assert.match pattern — symbol-typed
   * slots already flip the symbol link switch). assert.eqDyn:
   * (a, b, negated, deep, msg, hasMsg) — the whole quartet over
   * checked-dynamic operands (both slots dyn; the frontend boxes a
   * static side with dynFrom first): SameValue for the strict pair over
   * the dyn kinds (boxed-closure identity for functions), the structural
   * dyn walk for the deep pair, with assertion_error.js's messages —
   * scalar forms byte-exact, composites rendered compact:false/sorted
   * through the checked-dynamic tree and diffed with the real myers line printer.
   *
   * The assert.throws(fn, {name/code/message}) shape check
   * (expectedException over the static error surface): shapeBegin
   * stashes the caught error, shapeStr/shapeRe add one expected key each
   * (key ids 0 code / 1 message / 2 name; shapeRe lives in scr_regex.c —
   * its regex argument flips the regex link switch — and tests eagerly
   * so scr_assert.c stays libregexp-free), then shapeEnd throws Node's
   * deep-equal Comparison diff BYTE-EXACTLY (the bounded key set makes
   * the rendering enumerable) or the custom message.
   * assert.throwsRegex: (regex, error, msg, hasMsg) — the
   * assert.throws(fn, /re/) check over String(error), Node's
   * regex-mismatch message. assert.regexErrTest: doesNotReject's silent
   * regex predicate over String(error) (never throws).
   * assert.unwantedRejection: (error, msg, hasMsg) — doesNotReject's
   * "Got unwanted rejection" throw.
   * assert.ifErrorErr/F64/Str/Bool: assert.ifError's per-type throws
   * ("ifError got unwanted exception: " + the error's message/name or
   * the value's inspection) — the frontend routes null/undefined to a
   * no-op and everything else here (Node throws for falsy values too).
   * All arguments are borrowed. */
  | "assert.ok"
  | "assert.eqF64"
  | "assert.eqStr"
  | "assert.eqBool"
  | "assert.eqSym"
  | "assert.eqDyn"
  | "assert.deepResult"
  | "assert.sameValue"
  /* deepStrictEqual's pair memo over cycle-capable types: enter answers
   * true for a pair already being compared (Node's memo — equal cyclic
   * structures compare true); leave pops. */
  | "assert.deqEnter"
  | "assert.deqLeave"
  | "assert.match"
  | "assert.throwsNone"
  | "assert.throwsMismatch"
  | "assert.throwsRegex"
  | "assert.shapeBegin"
  | "assert.shapeStr"
  | "assert.shapeRe"
  | "assert.shapeEnd"
  | "assert.regexErrTest"
  | "assert.unwantedRejection"
  /** Node's expectsError over an error-INSTANCE expected (assert.throws/
   * rejects second argument): walk the expected dyn error's keys (name,
   * message, code — the %error marker skipped) and deep-compare each
   * against the caught value's; a mismatch throws the deep-equal
   * AssertionError (scr_assert.c). MAY THROW by design. */
  | "assert.expectsErrDyn"
  | "assert.ifErrorErr"
  | "assert.ifErrorF64"
  | "assert.ifErrorStr"
  | "assert.ifErrorBool"
  | "assert.ifErrorDyn"
  | "assert.refEqBytes"
  | "assert.refEqFn"
  | "assert.bytesDeepEq"
  /** util.inspect (scr_inspect.c — its own link switch, moduleUsesInspect):
   * the runtime half of the static rendering. Scalar formatters return +1
   * strings (insp.f64: JS ToString except -0; insp.str: the quoting
   * ladder + line splitting; insp.regex: /source/flags; insp.buffer:
   * <Buffer aa ..>). insp.error renders the STACKLESS [Name: message]
   * form with the code slot as its one property. insp.dyn walks the
   * checked-dynamic tree entirely in the runtime (its shape lives in the
   * value); insp.dynS is format's %s twin (dyn strings pass verbatim).
   * insp.jsval ([value, recurse, depth], --dynamic only) renders the
   * island scalars and THROWS a catchable TypeError on composites (the
   * may-throw seed set). begin/entry/moreItems/end drive the frame
   * engine from the compiler-synthesized per-type traversal helpers
   * (%util.insp.N — the deepStrictEqual precedent). */
  | "insp.f64"
  /** util.format %j over a checked-dynamic argument: the runtime dyn
   * walk (JS-exact stringify; root undefined/function prints
   * "undefined"; a handle in the tree throws the loud fence). */
  | "insp.jsonDyn"
  | "insp.str"
  | "insp.regex"
  | "insp.buffer"
  | "insp.error"
  | "insp.dyn"
  | "insp.dynS"
  | "insp.jsval"
  | "insp.begin"
  | "insp.entry"
  | "insp.key"
  | "insp.moreItems"
  /* Circular references over cycle-capable composites (recursive record/
   * class types): circCheck answers a value's circular id when it is
   * already on the traversal stack (0 otherwise), seenPush/refWrap
   * bracket the frame (refWrap adds Node's "<ref *N> " prefix to values
   * the walk found circular), circular renders "[Circular *N]". */
  | "insp.circCheck"
  | "insp.seenPush"
  | "insp.refWrap"
  | "insp.circular"
  | "insp.end"
  /** node:string_decoder's utf8 StringDecoder (scr_string.c): the decoder
   * value is a one-field record whose f64 PACKS the pending partial
   * sequence (count + up to 3 raw bytes — Node buffers at most 3 for
   * every encoding); the frontend's interned %strdec helpers thread it,
   * with the decoder's CANONICAL encoding name first, through these pure
   * functions. write: (enc, pending, chunk) → the decoded complete
   * prefix of pending+chunk (+1); next: (enc, pending, chunk) → the
   * packed NEW pending; end: (enc, pending) → the buffered partial's
   * flush (+1). Node-exact per encoding (oracle-pinned); none throws. */
  | "strdec.write"
  | "strdec.next"
  | "strdec.end"
  /** node:readline's question/close slice (scr_readline.c, linked under
   * the events gate — these fns imply moduleUsesProcessEvents). The
   * interface value is an f64 handle (the Timeout-id precedent).
   * rl.create: [] → f64 — createInterface({ input: process.stdin,
   * output: process.stdout }), registering the unit's shared stdin
   * consumer (an OPEN interface keeps the loop alive until close/EOF,
   * Node's semantics). rl.question: [handle, query, cb] — writes the
   * query to stdout (Node writes under pipes too) and delivers the next
   * line's text through a backend-picked adapter (zero-param or
   * (answer: string)); THROWS Node's "readline was closed" on a closed
   * interface (may-throw). rl.close: [handle] — fires 'close' listeners
   * SYNCHRONOUSLY (Node's inline emit) and detaches the consumer (the
   * loop stops waiting on fd 0). rl.onClose: [handle, cb] — a zero-arg
   * listener (moves); stdin EOF closes every open interface with the
   * buffered partial line DISCARDED, like Node. */
  | "rl.create"
  | "rl.question"
  | "rl.close"
  | "rl.onClose"
  /** node:timers/promises — the promisified pair (scr_async.c, beside
   * the timer heap they ride): tp.setTimeout: [ms] → a pending void
   * promise a one-shot heap timer fulfills (the loop's timer phase, FIFO
   * against equal deadlines like Node); tp.setImmediate: [] → the same
   * through the immediate queue (fires before due timers of later loop
   * turns, Node's check phase). Neither throws. */
  | "tp.setTimeout"
  | "tp.setImmediate"
  /** node:diagnostics_channel (scr_dc.c, linked when any dc.* appears —
   * the zlib gating precedent): a process-global name→channel registry;
   * channel values are f64 handles (types.ts maps Channel to F64, the
   * readline.Interface pattern). Subscribers are dyn function values —
   * identity-compared by unsubscribe, called (message, name) by publish
   * over a SNAPSHOT of the list (a subscriber unsubscribing itself
   * mid-publish still lets its siblings fire, Node's behavior). dc.publish
   * MAY THROW: a subscriber's throw propagates out of publish (catchable
   * there) where Node routes it to triggerUncaughtException — the
   * documented divergence. subscribe/unsubscribe throw Node's
   * ERR_INVALID_ARG_TYPE TypeError for non-function subscribers. */
  | "dc.channel"
  | "dc.subscribe"
  | "dc.unsubscribe"
  | "dc.hasSubscribers"
  | "dc.publish"
  | "dc.chanSubscribe"
  | "dc.chanUnsubscribe"
  | "dc.chanHasSubscribers"
  | "dc.chanName"
  /** TracingChannel (dc.tracingChannel): a registry entry of the five
   * event channels, an f64 handle like Channel (types.ts). tcSubscribe/
   * tcUnsubscribe walk a dyn handlers object's five event keys (truthy
   * non-function slots throw the per-channel ERR_INVALID_ARG_TYPE);
   * tcTraceSync/tcTraceCallback/tcTracePromise run Node's publish choreography in C over
   * dyn values (fn, ctx, thisArg, args-array) with thisArg bound as the
   * ambient receiver — the traced call's throw and any subscriber throw
   * both propagate (MAY THROW). tcTraceCallback wraps args[position] in a
   * native error/result + asyncStart/asyncEnd publisher and throws Node's
   * TypeError when that slot is not callable. tracingChannelOf is the
   * five-Channel collection form of the constructor. */
  /** setImmediate as a first-class dyn value (scr_async.c): a minted dyn
   * callable scheduling args[0](args[1..]) on the immediate queue — the
   * Node-suite traceCallback shape (`traceCallback(setImmediate, ...)`).
   * Calling it validates the callback (the dyn call machinery); minting
   * never throws. */
  | "timers.setImmediateFnValue"
  /** `new Promise(setImmediate)` (the Node-suite early-exit shape): a
   * fresh promise an immediate fulfills with the undefined dyn value —
   * the executor IS setImmediate, so resolve rides the immediate queue
   * (scr_async.c). Never throws. */
  | "timers.immediatePromise"
  | "dc.tracingChannel"
  | "dc.tracingChannelOf"
  | "dc.tcChannel"
  | "dc.tcHasSubscribers"
  | "dc.tcSubscribe"
  | "dc.tcUnsubscribe"
  | "dc.tcTraceSync"
  | "dc.tcTraceCallback"
  /** tracePromise (scr_dc.c): start publish, the traced call, a wrap of
   * non-promise results, the end publish, and a REACTION FIBER that
   * awaits the traced promise and publishes asyncStart/asyncEnd (error
   * first on rejection) before settling the returned promise<dyn> with
   * the passed-through outcome. MAY THROW (the traced call and the
   * synchronous publishes). */
  | "dc.tcTracePromise"
  /** AsyncLocalStorage (node:async_hooks — scr_async.c): stores are f64
   * handles; contexts are immutable fiber-carried snapshots (spawned
   * fibers inherit the spawner's — Node's init-time capture). run/exit
   * enter (or clear) the store, call the dyn function with forwarded
   * arguments, and restore (the finally); getStore answers the current
   * dyn value or undefined; enterWith installs with no restore point.
   * run/exit MAY THROW (the callback's own throws propagate). */
  /** `await v` over a checked-dynamic VALUE (scr_async.c): a dyn promise
   * adopts (rejections re-throw — MAY THROW), anything else takes JS's
   * one-microtask non-thenable await and answers itself. Only emitted
   * inside async bodies (the frontend's isAsync gate). */
  | "async.awaitDyn"
  /** The bare one-microtask hop (scr_await_hop): `await v` over a typed
   * NON-promise value — JS awaits non-thenables through exactly one
   * microtask turn and yields the value itself. Never throws. */
  | "async.hop"
  | "als.new"
  | "als.get"
  | "als.run"
  | "als.exitRun"
  | "als.enterWith"
  | "als.disable"
  /** Channel.bindStore/unbindStore/runStores (scr_dc.c): the
   * AsyncLocalStorage integration — set-semantics bindings per store,
   * runStores entering every bound store with transform(data) around the
   * publish and the callback (MAY THROW: transforms, subscribers, and
   * the callback all run). */
  | "dc.chanBindStore"
  | "dc.chanUnbindStore"
  | "dc.chanRunStores"
  /** process warnings (scr_lib.c): onWarning/offWarning register dyn
   * listeners; emitWarning applies Node's full argument grammar over the
   * call's dyn argument vector (ERR_INVALID_ARG_TYPE TypeErrors — MAY
   * THROW; a listener throw propagates too) and always prints Node's
   * stderr report. Emission is synchronous (SEMANTICS.md). */
  | "process.onWarning"
  | "process.offWarning"
  | "process.emitWarning"
  /** process.on/once('unhandledRejection', fn): registers a dyn listener
   * the checkpoint report dispatches per never-observed rejection —
   * (reason, promise) — instead of printing and exiting 1 (scr_async.c).
   * The bool second arg is `once` (auto-removed after one delivery,
   * Node's once); off/removeListener remove by closure identity, the
   * offWarning stance. Throws Node's ERR_INVALID_ARG_TYPE on a
   * non-function. */
  | "process.onUnhandledRejection"
  | "process.offUnhandledRejection"
  /** process.on/once/off('rejectionHandled', fn): the sibling registry.
   * A handler attached after unhandledRejection delivery fires the event
   * once. Dispatch is synchronous at the attach, with the promise,
   * Node's payload. */
  | "process.onRejectionHandled"
  | "process.offRejectionHandled"
  /** The Number statics with a static C implementation (scr_lib.c): one
   * f64 arg → bool, JS-exact BY CONSTRUCTION — Number.isFinite/isNaN/
   * isInteger/isSafeInteger never coerce, and the frontend routes only
   * f64-typed arguments here (other static types fence). None throws. */
  | "number.isFinite"
  | "number.isNaN"
  | "number.isInteger"
  | "number.isSafeInteger"
  /** Date (scr_lib.c). Values are TimeClip'd epoch-millisecond scalars:
   * construction/store/pass/getters are exact while identity and mutation
   * remain fenced. date.now is Node's integer milliseconds since epoch;
   * date.toISOString formats one raw f64 millisecond time value and
   * date.toISOStringValue formats a stored Date, both with Node's rules (UTC,
   * YYYY-MM-DDTHH:mm:ss.sssZ, expanded ±YYYYYY years outside 0–9999,
   * ToInteger truncation of fractional ms) and THROWS Node's "Invalid
   * time value" RangeError on NaN / out-of-range input (may-throw seed).
   * Results: f64 / owned (+1) string. */
  | "date.now"
  | "date.newNow"
  | "date.newMs"
  | "date.newString"
  | "date.getTime"
  | "date.valueOf"
  | "date.toISOString"
  | "date.toISOStringValue"
  | "date.getFullYear"
  | "date.getUTCFullYear"
  | "date.getMonth"
  | "date.getUTCMonth"
  | "date.getDate"
  | "date.getUTCDate"
  | "date.getDay"
  | "date.getUTCDay"
  | "date.getHours"
  | "date.getUTCHours"
  | "date.getMinutes"
  | "date.getUTCMinutes"
  | "date.getSeconds"
  | "date.getUTCSeconds"
  | "date.getMilliseconds"
  | "date.getUTCMilliseconds"
  | "date.getTimezoneOffset"
  /** The composed `new Date(dateString).getTime()` read: one borrowed
   * string, f64 milliseconds since epoch. The parsed grammar is BOUNDED
   * (documented divergence — V8's parser accepts far more): the ASN.1
   * validity shape X509Certificate.validFrom/validTo answer ("Jul  1
   * 00:00:00 2026 GMT" — the portless cert-expiry read), and ECMA's own
   * date-time string format (YYYY-MM-DD[THH:mm[:ss[.sss]]][Z|±HH:MM] —
   * date-only forms are UTC, exactly the spec). Anything else is NaN,
   * Node's invalid-date getTime. Never throws. */
  | "date.parseGetTime"
  /** `Date.UTC(...)` — seven f64 arguments (the frontend completes the
   * spec's defaults for omitted trailing parts: month 0, date 1, time
   * parts 0), the spec's MakeDay/MakeTime/TimeClip exactly: 0–99 years
   * map to 1900+year, out-of-range months/dates roll over, non-finite
   * parts and out-of-range results answer NaN. Never throws. */
  | "date.utc"
  /** The fs option forms and friends (scr_lib.c), all throwing catchably
   * like the rest of sync fs. mkdirRecursiveSync is Node's recursive
   * algorithm (try mkdir, EEXIST-dir is fine, ENOENT creates the parent
   * first — errors report Node's errno at Node's path, EEXIST at a file
   * target, ENOTDIR at the full path past a file); the first-created-dir
   * return value has no lowering (statement position only, frontend-
   * fenced). rmOptsSync is rmSync with (recursive, force) bools: force
   * swallows ENOENT, recursive removes trees post-order, a directory
   * without recursive throws the EISDIR-worded error (divergence 13's
   * wording note). mkdtempSync appends the six X's and returns the
   * created path (+1). accessSync takes the F_OK/R_OK/W_OK/X_OK bits as
   * one f64 (the frontend bakes fs.constants.* as literals and completes
   * an omitted mode to 0). readFdSync/readFdSyncBytes are the
   * readFileSync(fd[, "utf8"]) forms — a read(2) loop to EOF on the fd
   * (the stdin path); errors carry Node's no-path message shape. */
  | "fs.mkdirRecursiveSync"
  | "fs.rmOptsSync"
  /** rmOptsSync's maxRetries/retryDelay form (path, recursive, force,
   * maxRetries, retryDelay): Node's linear-backoff retry on
   * EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM — the tmpdir-harness shape
   * rmSync(p, { maxRetries: 3, recursive: true, force: true }). */
  | "fs.rmRetrySync"
  | "fs.mkdtempSync"
  | "fs.accessSync"
  | "fs.readFdSync"
  | "fs.readFdSyncBytes"
  /** isatty(3) over an fd literal (0/1/2 — process.stdin/stdout/stderr
   * .isTTY reads). A real boolean: false where Node's non-TTY streams
   * expose undefined (documented divergence). Never throws. */
  | "process.isTTY"
  /** process.stdin.destroy(): a deliberate no-op (no stream machinery
   * exists to tear down; documented in SEMANTICS.md). */
  | "process.stdinDestroy"
  /** process.stdin.setRawMode(mode) — one borrowed bool arg, void. On a
   * TTY stdin: termios raw mode on/off (libuv's UV_TTY_MODE_RAW flag set,
   * the mode Node's setRawMode(true) applies; false restores the entry
   * state). On a NON-TTY stdin Node's process.stdin has no such method at
   * all, so the call throws Node's exact catchable TypeError
   * ("process.stdin.setRawMode is not a function") — the may-throw seed
   * carries it. */
  | "process.stdinSetRawMode"
  /** Terminal width over an fd literal (1/2 — process.stdout/stderr
   * .columns): ioctl(TIOCGWINSZ). The result is the module's interned
   * `number | undefined` union — a non-TTY stream (or an ioctl refusal)
   * yields the undefined arm, exactly Node's missing `.columns`. Never
   * throws. */
  | "process.columns"
  /** String surface with scr_lib.c implementations. fromCharCode takes
   * ONE f64[] arg (the frontend packs plain arguments into an array
   * literal, or forwards a whole-array spread — the path.join
   * convention) and builds the string from UTF-16 code units: each code
   * goes through ToUint16, adjacent surrogate pairs combine into one
   * code point, and LONE surrogates become U+FFFD (divergence 1's
   * storage policy — printed output still matches Node byte-for-byte).
   * lastIndexOf is the one-argument form: the LAST occurrence as a
   * UTF-16 index (-1 when absent; the empty needle finds the length,
   * per spec). Borrowed args; +1 string / plain f64; neither throws. */
  | "string.fromCharCode"
  | "string.lastIndexOf"
  /** String.raw(template, ...subs): the raw literals array (a string[]
   * read off the template record) interleaved with the PRE-STRINGIFIED
   * substitutions (the frontend applies the static ToString and packs
   * them into one string[] literal) — extra substitutions drop, missing
   * ones skip, the spec's loop exactly (scr_array.c). Borrowed args;
   * +1 string; never throws. */
  | "string.raw"
  /** WHATWG TextDecoder.decode over u8 bytes (scr_bytes.c): utf-8 with
   * default options — the same maximal-subpart replacement decode as
   * Buffer.toString("utf8"), with the leading BOM stripped (the one
   * behavioral difference; ignoreBOM defaults to false). The composed
   * `new TextDecoder().decode(bytes)` form and its same-scope const
   * store-then-call twin lower — decoder values still have no general
   * representation. TextEncoder.encode needs no libFn: its matching forms
   * lower to buffer.fromStr(s, "utf8") (identical bytes — ScrStr storage
   * is well-formed UTF-8). Borrowed arg; owned (+1) string; never throws. */
  | "text.decode"
  /** TextDecoder.decode for a compile-time non-UTF-8 WHATWG label. The
   * second f64 is the frontend-owned encoding id consumed by scr_bytes.c;
   * label aliases/case/ASCII whitespace are canonicalized before IR. The
   * mapping tables are generated from the pinned Node 24 oracle, keeping
   * output portable without an ICU/iconv dependency. Borrowed args; owned
   * (+1) string; never throws. */
  | "text.decodeLegacy"
  /** The wider sync fs slice (scr_lib.c), all throwing catchably with
   * Node's errno message shapes and `.code` stamped like the rest of
   * sync fs. unlink/chmod/chown wrap the syscalls 1:1 (Node reports the
   * syscall's own name). copyFileSync copies contents into a fresh (or
   * truncated) destination carrying the SOURCE's mode (libuv's
   * uv_fs_copyfile behavior); its errors carry BOTH paths — Node's
   * "copyfile 'src' -> 'dest'". lstatSync is statSync without following
   * a trailing symlink (Node reports lstat); stats.isSymbolicLink /
   * stats.blocks / nlink / atimeMs / mtimeMs are pure reads on the widened
   * snapshot (blocks is allocated 512-byte units; the times are milliseconds
   * with their sub-second fractions, Node's arithmetic).
   * writeFileModeSync is writeFileSync(path, data, { mode }): the mode
   * applies at CREATION only (open(2) with O_CREAT, umask applying),
   * exactly Node — an existing file keeps its permissions. mkdirModeSync
   * / mkdirRecursiveModeSync are the mkdirSync option forms with an
   * explicit mode (the recursive walk passes it to every directory it
   * creates, like Node's). */
  | "fs.unlinkSync"
  | "fs.chmodSync"
  | "fs.chownSync"
  | "fs.copyFileSync"
  /** renameSync is the direct two-path syscall wrapper. renameCb defers
   * the operation to the loop and fires a program-shaped Error | null
   * callback through a backend-emitted adapter. */
  | "fs.renameSync"
  | "fs.renameCb"
  | "fs.lstatSync"
  /** fs.openSync(path, flags) → the raw fd as f64; fs.readSync/fs.writeSync
   * over Buffer windows perform sequential I/O when position is -1 and
   * offset-preserving positioned I/O otherwise; fs.writeStrSync is the
   * utf8 string twin; and fs.closeSync(fd) closes the descriptor. This is
   * the fd slice behind spawn/log-processing forms.
   * flags is Node's string
   * grammar ("r", "w", "a" and the +/x variants; unknown flags throw
   * Node's ERR_INVALID_ARG_VALUE TypeError text). All throw Node-shaped
   * fs errors (openSync ENOENT/EACCES..., readSync EBADF/range errors,
   * closeSync EBADF). */
  | "fs.openSync"
  | "fs.readSync"
  | "fs.writeSync"
  | "fs.writeStrSync"
  | "fs.closeSync"
  /** fs.watch(path, listener?) → an FSWatcher handle (scr_watch.c —
   * linked, and scr_watch_install() emitted, only when these appear on
   * the IR; moduleUsesFsWatch is the switch). The path opens NOW —
   * failure throws Node's fs error synchronously ("ENOENT: ..., watch
   * 'x'", the polling-fallback catch shape) — and the unit's kqueue
   * (EVFILT_VNODE) delivers "rename"/"change" through the loop's watch
   * hook. The callback (nullable) MOVES in with an adapter per listener
   * shape (zero-param, or the (eventType: string) form — runtime-
   * provided); an open watcher keeps the loop alive until watcher.close()
   * (idempotent, receiver borrowed, statement position only). */
  | "fs.watch"
  | "fs.watchCb"
  | "watcher.close"
  /** The composed `new crypto.X509Certificate(data).fingerprint` read
   * (scr_lib.c — no certificate handle exists): the SHA-1 of the DER,
   * uppercase colon-separated, over PEM or raw-DER Buffer input; other
   * inputs throw Node's ERR_OSSL_PEM_NO_START_LINE Error (may-throw). */
  | "crypto.x509Fingerprint"
  | "crypto.x509FingerprintStr"
  /** The certificate's Validity window (validFrom / validTo reads —
   * scr_lib.c's minimal ASN.1 walk to the TBSCertificate validity
   * SEQUENCE): UTCTime and GeneralizedTime render in Node's exact
   * ASN1_TIME_print shape ("Jul  1 00:00:00 2026 GMT" — %2d space-padded
   * day). Same input contract and PEM error as the fingerprint pair
   * (may-throw). */
  | "crypto.x509ValidFrom"
  | "crypto.x509ValidFromStr"
  | "crypto.x509ValidTo"
  | "crypto.x509ValidToStr"
  | "stats.isSymbolicLink"
  | "stats.blocks"
  | "stats.nlink"
  | "stats.atimeMs"
  | "stats.mtimeMs"
  | "fs.writeFileModeSync"
  | "fs.mkdirModeSync"
  | "fs.mkdirRecursiveModeSync"
  /** spawnSync with options (scr_child.c): the cp.spawnSync core plus the
   * option slice portless-class CLIs pass — timeout (killSignal fires at
   * the deadline and the result carries error: ETIMEDOUT + the signal,
   * Node's shape), killSignal (a signal NAME; "" = the SIGTERM default),
   * and per-fd stdio modes (in: 0 /dev/null, 1 ignore, 2 inherit; out/
   * err: 0 capture, 1 ignore → "", 2 inherit → ""). NEVER throws — spawn
   * failure and timeout are data on the result, like Node's error
   * property. spawnRes.signal is the result's termination signal as the
   * call site's `Signals | null` union (null = exited normally or spawn
   * failure), constructed type-directedly like spawnRes.status. */
  | "cp.spawnSyncOpts"
  /** cp.spawnSyncOpts with the stdio carried as a RUNTIME string —
   * "pipe" | "ignore" | "inherit", proven by the call site's TYPE (the
   * defaultRunner idiom `stdio: options?.stdio ?? "pipe"`); the runtime
   * maps the value to the three modes. Args (cmd, argv, timeout,
   * killSignal, stdio). Never throws, like the other spawnSync forms. */
  | "cp.spawnSyncStdioStr"
  | "spawnRes.signal"
  /** spawn with options (scr_child.c): the cp.spawn core plus PER-SLOT
   * stdio — args are (cmd, argv, inMode, outMode, errMode, outFd, errFd,
   * detached, hasEnv, envPairs, cwd); modes 0 ignore (/dev/null), 1
   * inherit, 2 fd (out/err only — the fd dup2s into the child's slot,
   * Node's stdio fd form; the daemon-log idiom ["ignore", logFd, logFd]).
   * detached is POSIX_SPAWN_SETSID (the child gets its own session and
   * process group, Node's semantics), env is a REPLACEMENT ([k,v,...]
   * pairs like cp.execSync's), cwd ""=inherit. Same event/loop story as
   * cp.spawn. */
  | "cp.spawnOpts"
  /** Atomics.wait(int32Array, idx, expected, timeoutMs) → "not-equal"
   * when the element differs from `expected`, else a real nanosleep for
   * the timeout and "timed-out" (scr_lib.c). scriptc has no threads —
   * no other agent can ever notify, so for every compilable program this
   * IS the spec's behavior, and "ok" is unreachable; the frontend
   * REQUIRES the timeout argument (an infinite wait here is a certain
   * deadlock, fenced). The SharedArrayBuffer the lib types demand exists
   * only syntactically (new Int32Array(new SharedArrayBuffer(n)) lowers
   * to a plain i32 typed array — sharing is unobservable without
   * threads; SEMANTICS.md documents the stance). Never throws; +1 string
   * result. */
  | "atomics.wait";

/** Numeric binary ops. The bitwise six (`&`/`|`/`^`/`<<`/`>>`/`>>>`) have
 * JS ToInt32/ToUint32 semantics — operands convert (NaN/±Infinity → 0,
 * truncate, wrap mod 2^32), the operation runs in 32-bit space (shift
 * counts mask to 5 bits), and the result returns to f64 (`>>>` as Uint32,
 * the rest as Int32) — backends emit the scr_bit_* runtime helpers. */
export type IrNumBinOp =
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "&" | "|" | "^" | "<<" | ">>" | ">>>"
  | "<" | "<=" | ">" | ">=" | "===" | "!==";
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
   * the pointer compare IS class identity (one immortal object per
   * class). */
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
  | { kind: "fieldIncDec"; op: "+" | "-"; prefix: boolean; obj: IrExpr; className: string; field: string; fieldDyn: boolean; type: IrType; loc: SrcLoc }
  /** `x = e` in EXPRESSION position over a local or module global: evaluates
   * `value` once, writes the binding, and yields the assigned value — JS
   * evaluation order (`while ((idx = s.indexOf("\n")) !== -1)`). The type is
   * the binding's type (the frontend coerces the RHS into it, exactly like
   * statement-position `assign`). Statement position keeps the `assign`
   * statement; this node exists for value positions. */
  | { kind: "assignExpr"; localId: string; value: IrExpr; type: IrType; loc: SrcLoc }
  /** JS ToBoolean: f64 is false iff 0, -0, or NaN; string is false iff empty.
   * Operand is f64|string (bool needs no conversion) or a UNION — the ARM
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
  | { kind: "strCmp"; op: IrStrCmpOp; left: IrExpr; right: IrExpr; utf16?: boolean; type: IrType; loc: SrcLoc }
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
   * `nullish` test inverted: `receiver` is a unit-armed union with exactly
   * ONE non-unit arm, evaluated exactly once; when its runtime tag is a
   * unit arm the result is the interned undefined arm of `type` (JS-exact:
   * a null receiver still yields undefined) and `body` never evaluates —
   * argument side effects included. Otherwise the narrowed receiver binds
   * to `id` (read via chainRecv inside `body`, +1 per read for ref kinds)
   * and `body` produces the result: `type` when non-void (an
   * undefined-armed union; the frontend pre-wraps the member value into
   * it), or nothing (`type` void — the `cb?.()` statement form, where the
   * checker's `void | undefined` maps to void). */
  | { kind: "optChain"; id: string; receiver: IrExpr; body: IrExpr; type: IrType; loc: SrcLoc }
  /** The narrowed receiver inside an enclosing optChain's `body`, by the
   * chain's `id` — typed as the union's single non-unit arm; each read is
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
  /** Element read `a[i]`. Index is f64; a non-integer or out-of-bounds index
   * traps at runtime (JS returns undefined — documented divergence). For
   * refcounted elements the result is a fresh owned (+1) reference. */
  | { kind: "arrayGet"; arr: IrExpr; index: IrExpr; type: IrType; loc: SrcLoc }
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
   * with self-spread snapshot semantics), `pop` (returns elem — traps on an
   * empty array; ownership moves OUT to the caller), `indexOf` (one
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
   * - bytes (same elem — frontend-fenced) — an independent COPY. Never
   *   throws.
   * - array of f64 — a per-element-coerced copy (ToUint8/ToUint32/float).
   *   Never throws.
   * The source is BORROWED; the result is owned (+1). */
  | { kind: "bytesNew"; source: IrExpr | null; type: IrType; loc: SrcLoc }
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
   * (+1). `seed` carries the SUPPORTED seeded form — `new Set(values)`
   * where values is any T[]-typed expression (literal or variable; T
   * already a legal element type) — one borrowed array whose elements
   * add() in order (duplicates collapse, first insertion position wins,
   * SameValueZero — exactly JS). Non-array seeds (another Set, general
   * iterables) stay frontend-fenced. */
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
   * ordinary owned temp, released at statement end. */
  | { kind: "callValue"; callee: IrExpr; args: IrExpr[]; type: IrType; loc: SrcLoc }
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
  | { kind: "yieldExpr"; value: IrExpr | null; type: IrType; loc: SrcLoc }
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
   * MAY-THROW SEED: a body exception (or the injected throw) propagates
   * into the caller synchronously. */
  | { kind: "genResume"; mode: "next" | "return" | "throw"; gen: IrExpr; arg: IrExpr | null; type: IrType; loc: SrcLoc }
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
  /** The class itself as a value: a pointer to `className`'s immortal
   * class object (type `classval:className`, +1 — a no-op retain on the
   * immortal, kept for the uniform owned-temp discipline, the regexLit
   * pattern). The frontend notes an edge to `%className.constructor` at
   * every classRef, so a value's construct thunk always has a constructor
   * to call; backends emit class objects (and thunks) for exactly the
   * classes some classRef in the module names. */
  | { kind: "classRef"; className: string; type: IrType; loc: SrcLoc }
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
  | { kind: "virtualCall"; className: string; method: string; args: IrExpr[]; type: IrType; loc: SrcLoc }
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
  | { kind: "recordLit"; fields: { name: string; value: IrExpr; overflow?: true; drop?: true }[]; type: IrType; loc: SrcLoc }
  /** Same-shape object spread with explicit overrides: `{ ...source,
   * field: value }`. `source` is evaluated first and borrowed by one
   * per-shape clone helper; `overrides` then evaluate in source order and
   * replace the cloned slots. Refcounted override values MOVE in and the
   * replaced cloned values release after unlinking. Restricted to plain
   * declared-field records (no tuple/index/accessor shapes), so every
   * omitted field is copied exactly once by the helper. */
  | { kind: "recordClone"; source: IrExpr; overrides: { name: string; value: IrExpr }[]; type: IrType; loc: SrcLoc }
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
  | { kind: "recordKeyGet"; obj: IrExpr; shapeId: string; key: IrExpr; overflowOnly?: true; type: IrType; loc: SrcLoc }
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
   * borrowed; the result is owned (+1). Never throws. `liveRef` is the
   * narrow Web-platform exception for record/array/bytes values (including
   * mutable arms selected at runtime from a union) whose API contract
   * exposes the same reference again (stream chunks and abort reasons): it
   * emits a typed capsule with a live materializer instead of the ordinary
   * deep copy. */
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
  | { kind: "dynCall"; callee: IrExpr; calleeName: string; args: IrExpr[]; spreads?: { arg: number; what: string }[]; type: IrType; loc: SrcLoc }
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
  | { kind: "dynInvoke"; recv: IrExpr; method: string; calleeName: string; args: IrExpr[]; type: IrType; loc: SrcLoc }
  /** A dyn ARRAY built element-by-element (JS mixed-element literals —
   * `['pwd', []]` — and evolving `[]` declarations): each element is
   * already a dyn value; the result owns them. Never throws. */
  | { kind: "dynArrLit"; elems: IrExpr[]; type: IrType; loc: SrcLoc }
  /** A dyn OBJECT built member-by-member. With no `fields` it is the empty
   * object (the JS stand-in for opaque container values — `new WeakMap()`
   * in harness code: the value exists for identity; every reached METHOD
   * use meets its own fence). With `fields` it is a JS object literal whose
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
   * undefined or null in one test), and `v instanceof Uint8Array`
   * (`"bytes"` — the checked-dynamic tree's bytes kind; Node's Buffer IS a Uint8Array
   * subclass and both worlds answer true for it, SEMANTICS.md 45), plus
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
  | { kind: "dynTest"; test: "string" | "number" | "boolean" | "undefined" | "null" | "nullish" | "bytes" | "object" | "array" | "truthy" | "error" | "function"; negated?: true; value: IrExpr; type: IrType; loc: SrcLoc }
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
   * straight-line (varDecl/assign/exprStmt/field-and-record writes — no
   * control flow, no jumps; the validator enforces the subset), and any
   * varDecl-introduced local is a function local like every hidden temp. */
  | { kind: "seqExpr"; stmts: IrStmt[]; result: IrExpr; type: IrType; loc: SrcLoc }
  /** RequireObjectCoercible with V8's destructuring TypeError: throws
   * "Cannot destructure 'SPELLING' as it is undefined." (or "…null.") on
   * a nullish value — the property form "Cannot destructure property
   * 'FIRSTPROP' of 'SPELLING' …" when `firstProp` is set (V8 names the
   * pattern's first property) — and yields the value unchanged otherwise.
   * `spelling` is the RHS's compile-time source spelling. Value and type
   * are dyn (the dyn helper) or jsval (the island's prelude guard —
   * engine-thrown, catchable like every boundary throw). */
  | { kind: "dynDestrCheck"; value: IrExpr; spelling: string; firstProp?: string; type: IrType; loc: SrcLoc }
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
  | { kind: "dynIterN"; value: IrExpr; count: number; type: IrType; loc: SrcLoc }
  /** The OVERFLOW key list of an index-signature record, in JS OWN-KEY
   * order (canonical array indices ascending first, then insertion order —
   * the runtime's scr_map_keys_js_order): a fresh string[] snapshot, the
   * iteration surface behind Object.keys/values/entries over hybrid
   * shapes. `obj` must be a record whose shape carries an indexValue; the
   * receiver is borrowed, the array is owned (+1). Declared fields are NOT
   * listed (they never live in the overflow map — the lowering prepends
   * them from the shape). Never throws. */
  | { kind: "recordOvfKeys"; obj: IrExpr; shapeId: string; type: IrType; loc: SrcLoc }
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
  | { kind: "unionFuncEq"; unionId: string; tag: number; union: IrExpr; func: IrExpr; negated: boolean; type: IrType; loc: SrcLoc }
  /** Runtime test on a catch binding (`value` is a caught-typed varRef,
   * borrowed). The primitive tests ("string"/"number"/"boolean") compare
   * the snapshot's kind tag — exactly what `typeof e === "..."` observes;
   * "instanceof" requires `className` (a hierarchy class) and tests an OBJ
   * payload's vtable preorder against its interval (false for every other
   * payload kind). `negated` flips the result (the `!==` spelling). */
  | {
      kind: "caughtTest";
      value: IrExpr;
      test: "string" | "number" | "boolean" | "instanceof";
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
  | { kind: "intrinsic"; name: "console.log" | "console.error" | "promise.race" | "promise.all" | "promise.reject" | "promise.resolve" | "module.await"; args: IrExpr[]; type: IrType; loc: SrcLoc }
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
  | { kind: "libCall"; fn: IrLibFn; args: IrExpr[]; type: IrType; loc: SrcLoc }
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
  | { kind: "jsonStringify"; value: IrExpr; type: IrType; loc: SrcLoc }
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
   * corrupting memory). */
  | { kind: "dynCheck"; value: IrExpr; type: IrType; loc: SrcLoc }
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
  | "add" | "sub" | "mul" | "div" | "mod" | "pow"
  | "neg" | "plus"
  | "lt" | "le" | "gt" | "ge" | "eq" | "neq"
  /** `v instanceof C` where BOTH sides are island values (a package-
   * exported class as the RHS): the spec's InstanceofOperator in the
   * engine, Symbol.hasInstance included; a non-object RHS throws the
   * engine's own TypeError, bridged catchably. */
  | "instanceOf"
  | "truthy" | "not" | "typeof" | "toStr"
  | "getProp" | "setProp" | "getIdx" | "setIdx"
  | "callMethod" | "callFn"
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
  | "objLit" | "arrLit"
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
  | "undefLit" | "nullLit"
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
    case "add": case "sub": case "mul": case "div": case "mod": case "pow":
    case "neg": case "plus":
    case "getProp": case "getIdx": case "callMethod": case "callFn": case "callFnThis":
    case "callSpread":
    case "construct":
    case "globalGet":
    case "objLit": case "arrLit": case "defineGetter": case "tplStrings": case "objSpread":
    case "undefLit": case "nullLit":
    case "iterNew": case "optCallMethod":
      return "jsval";
    case "lt": case "le": case "gt": case "ge": case "eq": case "neq":
    case "instanceOf":
    case "truthy": case "not":
      return "bool";
    case "typeof": case "toStr":
      return "string";
    case "setProp": case "setIdx":
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
  return isJsonSafeAt(t, getRecord, getUnion, false, new Set());
}

/** The recursion behind isJsonSafeType. `inRecordField` is the ONE position
 * where an undefined arm is JSON-representable: an undefined-armed union as
 * a record field (the `a?: T` spelling) serializes by DROPPING the field
 * when it holds undefined and validates a MISSING key as the undefined arm
 * — both exactly Node. Everywhere else (a bare `T | undefined` value,
 * stringified whole or cast to) exactness is unreachable: Node's stringify
 * of bare undefined is not a string at all, and JSON text can never contain
 * a value that matches the arm. */
function isJsonSafeAt(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  inRecordField: boolean,
  visiting: Set<string>,
): boolean {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
      return true;
    case "array":
      return isJsonSafeAt(t.elem, getRecord, getUnion, false, visiting);
    case "record": {
      const shape = getRecord(t.shapeId);
      if (!shape) return false;
      // The recursive knot: answer true and let the rest of the graph
      // decide (any unsafe constituent is found on its own path; a false
      // short-circuits every `every` up the walk).
      if (visiting.has(t.shapeId)) return true;
      visiting.add(t.shapeId);
      // TUPLE positions are array slots, not droppable object keys: an
      // undefined-armed position would stringify as `null` in JS (not
      // drop), so tuples keep the array rule for their fields.
      if (!shape.fields.every((f) => isJsonSafeAt(f.type, getRecord, getUnion, !shape.tuple, visiting))) {
        return false;
      }
      // Overflow values sit in record-key position too: dyn is JSON-safe
      // HERE (the checked-dynamic tree serializes itself; undefined-valued entries drop
      // like any undefined-valued key), everything else follows the
      // record-field rule.
      if (shape.indexValue && shape.indexValue.kind !== "dyn") {
        return isJsonSafeAt(shape.indexValue, getRecord, getUnion, true, visiting);
      }
      return true;
    }
    case "union": {
      const def = getUnion(t.unionId);
      if (!def) return false;
      const key = `${t.unionId}:${inRecordField}`;
      if (visiting.has(key)) return true; // the recursive knot, union-flavored
      visiting.add(key);
      return def.arms.every((a) => isJsonSafeAt(a, getRecord, getUnion, inRecordField, visiting));
    }
    case "func":
    case "object":
    // Class values stringify as "{}" husks in Node (own enumerable statics
    // aside — not representable type-directedly); rejected like Maps.
    case "classval":
    // Maps are not JSON (JSON.stringify(new Map()) is "{}" in Node — an
    // empty-object husk nobody wants; stringify/dynCheck reject instead).
    case "map":
    // Sets stringify as the same "{}" husk — rejected like Maps.
    case "set":
    // Regexes are not JSON (JSON.stringify(/a/) is "{}" in Node — the same
    // empty-object husk as Maps; stringify/dynCheck reject instead).
    case "regex":
    case "date":
    // URLs stringify as "{}" husks in Node too (data properties live on
    // internal slots) — rejected the same way; use url.href instead.
    case "url":
    // URLSearchParams stringifies as the same "{}" husk — rejected; use
    // sp.toString() instead.
    case "searchParams":
    // Symbols are DROPPED by Node's stringify (undefined at the top level,
    // omitted as object values) — silent divergence banned; rejected.
    case "symbol":
    // Typed arrays stringify as index-keyed objects ({"0":1,...}) and
    // Buffers as {type:"Buffer",data:[...]} in Node — neither shape is
    // representable type-directedly; rejected like Maps.
    case "bytes":
    case "stats":
    case "fileHandle":
    case "spawnRes":
    case "child":
    case "netServer":
    case "netSocket":
    case "http2Session":
    case "http2Stream":
    case "dgramSocket":
    case "testCtx":
    case "httpReq":
    case "httpRes":
    case "httpClientReq":
    case "secureCtx":
    case "fsWatcher":
    case "childStream":
    case "procStream":
    case "dyn":
    case "jsval":
    case "caught":
    case "promise":
    case "generator":
    case "void":
      return false;
    // Representable exactly as a union arm in record-field position (the
    // optional-field story above); bare undefined-armed unions stay fenced
    // out of both stringify and dynCheck (narrow with '!== undefined'
    // first, or model absence with a null arm).
    case "undefinedT":
      return inRecordField;
    // JSON null ↔ the nullT arm: null-armed unions stringify (`null`) and
    // validate (a JSON null matches exactly the nullT arm).
    case "nullT":
      return true;
    default: {
      const _exhaustive: never = t;
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
    (t.ret.kind === "jsval" || t.ret.kind === "void" ||
      t.ret.kind === "f64" || t.ret.kind === "bool" || t.ret.kind === "string")
  );
}

/** Parameter types a TYPED closure may declare when it crosses INTO the
 * island as a host function: jsval params take the engine argument as a
 * handle (the all-'any' shape above); every other admitted type converts
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
  if (t.kind === "jsval") return true;
  if (isJsonSafeType(t, getRecord, getUnion)) return true;
  if (t.kind === "union") {
    // A bare undefined-armed union: every non-undefined arm must be
    // JSON-safe (arms never nest unions, so plain isJsonSafeType applies).
    const def = getUnion(t.unionId);
    return !!def && def.arms.every((a) => a.kind === "undefinedT" || isJsonSafeType(a, getRecord, getUnion));
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
    r.kind === "void" || r.kind === "jsval" || r.kind === "f64" || r.kind === "bool" || r.kind === "string"
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
 * buffer. Closures taking closures and 'unknown'-typed params stay fenced
 * (no per-type extraction exists for them inside a host call). */
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
 * return) but do not check OUT (`u as Promise<T>` stays fenced).
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
  ["httpReq", { tag: "SCR_DYNH_HTTP_REQ", cls: "IncomingMessage" }],
  ["httpRes", { tag: "SCR_DYNH_HTTP_RES", cls: "ServerResponse" }],
  ["netSocket", { tag: "SCR_DYNH_NET_SOCKET", cls: "Socket" }],
  ["netServer", { tag: "SCR_DYNH_NET_SERVER", cls: "Server" }],
  ["http2Session", { tag: "SCR_DYNH_H2_SESSION", cls: "Http2Session" }],
  ["http2Stream", { tag: "SCR_DYNH_H2_STREAM", cls: "Http2Stream" }],
  ["httpClientReq", { tag: "SCR_DYNH_HTTP_CLIENT", cls: "ClientRequest" }],
]);

/** A static type that CONVERTS into a dyn value — the dynFrom domain:
 * JSON-safe data, bytes<u8> (payload copied), undefined-armed unions of
 * JSON-safe arms, boxable function types, and the runtime HANDLE kinds
 * (boxed by reference — DYN_HANDLE_KINDS). */
export function canConvertToDyn(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  if (isJsonSafeType(t, getRecord, getUnion)) return true;
  // bytes<u8> and boxable functions are dyn kinds the walker boxes
  // ANYWHERE (bytes copied, functions held by identity), including nested
  // in records/arrays/unions. isJsonSafeType rejects them, but dynFrom
  // needs only that the walker can build the dyn value, so this composite
  // fold extends the JSON-safe core.
  if (canBoxDynComposite(t, getRecord, getUnion)) return true;
  if (t.kind === "bytes" && t.elem === "u8") return true;
  // %Error converts as the checked-dynamic tree's error encoding ({%error, name, message,
  // code?} — the caughtToDyn shape, scr_dyn_from_error): the dyn 'error'
  // listener boundary (a mustCall-wrapped handler receiving the payload).
  if (t.kind === "object" && t.className === "%Error") return true;
  if (t.kind === "func") return canBoxFuncIntoDyn(t, getRecord, getUnion);
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
      canConvertToDyn(t.inner, getRecord, getUnion)
    );
  }
  if (t.kind === "union") {
    const def = getUnion(t.unionId);
    // JSON-safe arms box as before; BOXABLE FUNCTION arms join them (the
    // invalid-input probes iterate `[1, null, () => {}, true]` — the
    // union's func arm crosses through the checked-dynamic function
    // boundary exactly like a bare func dynFrom).
    return !!def && def.arms.every((a) =>
      a.kind === "undefinedT" || isJsonSafeType(a, getRecord, getUnion) ||
      (a.kind === "func" && canBoxFuncIntoDyn(a, getRecord, getUnion)),
    );
  }
  return false;
}

/** The composite extension of the dynFrom domain: JSON-safe scalars plus
 * bytes<u8> and boxable functions anywhere, recursing through records
 * (fields + index value), arrays, and unit-armed unions — exactly the
 * sc_td_* walker's capability. Returns false for a composite carrying a
 * kind the walker cannot box (Maps or handles nested in a record); those
 * still fence. */
function canBoxDynComposite(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
  visiting: Set<string> = new Set(),
): boolean {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "dyn":
    case "undefinedT":
    case "nullT":
      return true;
    case "bytes":
      return t.elem === "u8";
    case "func":
      return canBoxFuncIntoDyn(t, getRecord, getUnion);
    case "array":
      return canBoxDynComposite(t.elem, getRecord, getUnion, visiting);
    case "record": {
      const shape = getRecord(t.shapeId);
      if (!shape) return false;
      // Recursive shapes answer coinductively, like isJsonSafeType.
      if (visiting.has(t.shapeId)) return true;
      visiting.add(t.shapeId);
      if (!shape.fields.every((f) => canBoxDynComposite(f.type, getRecord, getUnion, visiting))) return false;
      return !shape.indexValue || canBoxDynComposite(shape.indexValue, getRecord, getUnion, visiting);
    }
    case "union": {
      const def = getUnion(t.unionId);
      if (!def) return false;
      if (visiting.has(t.unionId)) return true;
      visiting.add(t.unionId);
      return def.arms.every((a) => canBoxDynComposite(a, getRecord, getUnion, visiting));
    }
    default:
      return false;
  }
}

/** A type a dyn value can be VALIDATED into — the dynCheck domain:
 * JSON-safe data, bytes<u8> (a fresh copy out), the %Error extraction,
 * undefined-armed unions of JSON-safe arms, adaptable function types,
 * and the runtime HANDLE kinds (a tag-checked reference unwrap —
 * DYN_HANDLE_KINDS). */
export function canDynCheckTo(
  t: IrType,
  getRecord: (shapeId: string) => IrRecordShape | undefined,
  getUnion: (unionId: string) => IrUnionDef | undefined,
): boolean {
  if (isJsonSafeType(t, getRecord, getUnion)) return true;
  if (t.kind === "bytes" && t.elem === "u8") return true;
  if (t.kind === "object" && t.className === "%Error") return true;
  if (t.kind === "func") return canAdaptDynFuncTo(t, getRecord, getUnion);
  if (DYN_HANDLE_KINDS.has(t.kind)) return true;
  if (t.kind === "union") {
    const def = getUnion(t.unionId);
    return !!def && def.arms.every((a) => a.kind === "undefinedT" || isJsonSafeType(a, getRecord, getUnion));
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
): boolean {
  return (
    t.kind === "func" &&
    // A jsval (island) param converts through scr_jsval_from_dyn in the
    // thunk (wrapped cells unwrap by reference, dyn data deep-copies) —
    // the checker-'any' callback params of the routed-dispatch lane
    // (`bag.list.map((x) => ...)` with x typed any).
    t.params.every((p) => p.kind === "dyn" || p.kind === "jsval" || canDynCheckTo(p, getRecord, getUnion)) &&
    // A jsval return converts through the by-reference wrap
    // (dynFromJsval — the thunk's result conversion), so engine-returning
    // callbacks box too: the routed-dispatch lane's flatMap shape.
    (t.ret.kind === "void" || t.ret.kind === "dyn" || t.ret.kind === "jsval" || canConvertToDyn(t.ret, getRecord, getUnion))
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
): boolean {
  return (
    t.kind === "func" &&
    // A variadic (rest-marked) target would need the trailing rest-array
    // param synthesized by the adapter — no adapter models that; variadic
    // values live boxed and are called through their own thunks.
    t.rest !== true &&
    t.params.every((p) => p.kind === "dyn" || canConvertToDyn(p, getRecord, getUnion)) &&
    (t.ret.kind === "void" || t.ret.kind === "dyn" || canDynCheckTo(t.ret, getRecord, getUnion))
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
    case "void": return "void";
    case "f64": return "f64";
    case "bool": return "bool";
    case "string": return "string";
    case "jsval": return "jsval";
    case "array": return inner.elem.kind === "jsval" ? "jsvalArr" : null;
    default: return null;
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
    return dataArms.length === 1 && dataArms[0]!.kind === "array" && dataArms[0]!.elem.kind === "jsval";
  }
  return false;
}

/** True when the module contains any regex construct — a regexLit /
 * regexIntrinsic node or a regex-typed slot anywhere. This is the link
 * switch that pulls scr_regex.c + the vendored libregexp into the binary
 * (cc.ts); regex-free programs keep the historical command line. A generic
 * JSON walk: `kind` discriminants live only on IR objects, so user string
 * VALUES can never false-positive. */
export function moduleUsesRegex(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const kind = (v as { kind?: unknown }).kind;
    if (kind === "regex" || kind === "regexLit" || kind === "regexIntrinsic") {
      found = true;
      return;
    }
    // The lre-backed case conversions live in scr_regex.c (libunicode's
    // case tables): they ride the same link switch as regex nodes.
    if (kind === "strIntrinsic") {
      const method = (v as { method?: unknown }).method;
      if (method === "toLowerCase" || method === "toUpperCase") {
        found = true;
        return;
      }
    }
    // RegExp.escape lives in scr_regex.c too (needing no engine — it
    // keeps the always-linked string TU out of hello-world's size class).
    if (kind === "libCall" && (v as { fn?: unknown }).fn === "regexp.escape") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains an intrinsic whose implementation lives
 * in scr_copying.c. This is the link switch that keeps the optional
 * Array-copying and typed-array bridge TU out of unrelated binaries. */
export function moduleUsesCopying(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; method?: unknown };
    if (
      node.kind === "arrIntrinsic" &&
      (node.method === "toReversed" ||
        node.method === "toSpliced" ||
        node.method === "with")
    ) {
      found = true;
      return;
    }
    if (
      node.kind === "bytesIntrinsic" &&
      (node.method === "toReversed" ||
        node.method === "with" ||
        node.method === "join" ||
        node.method === "toArray")
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when a non-UTF-8 TextDecoder call survives lowering. This gates the
 * generated legacy mapping tables inside scr_bytes.c; the default UTF-8
 * decoder and unrelated Buffer users keep their prior runtime object. */
export function moduleUsesLegacyTextDecoder(mod: IrModule): boolean {
  let found = false;
  const visit = (value: unknown): void => {
    if (found || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && node.fn === "text.decodeLegacy") {
      found = true;
      return;
    }
    for (const key of Object.keys(value)) visit((value as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when a FileHandle type survives in the module. This is the link
 * switch for scr_file_handle.c; fs/promises.open carries the type inside its
 * promise result even when no handle method is called. */
export function moduleUsesFileHandle(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if ((v as { kind?: unknown }).kind === "fileHandle") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when user code lowers static fetch or the embedded npm graph
 * reaches the engine's global fetch — the link switch that pulls scr_fetch.c +
 * its socket/tls/zlib dependencies into the binary (cc.ts) and has the
 * emitted main call scr_fetch_install. The npm graph records the embedded
 * source fact with a parser + binder, so comments, strings, property names,
 * and local `fetch` bindings do not change the link or target capability.
 * Fetch-free graphs keep their exact historical link lines. */
export function moduleUsesFetch(mod: IrModule): boolean {
  const embedded = mod.embedded;
  if (embedded && embedded.modules.some((m) => m.usesFetch === true)) return true;
  // User-code fetch is either the engine global or the static libCall pair.
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; op?: unknown; name?: unknown; fn?: unknown };
    if (
      (node.kind === "jsOp" && node.op === "globalGet" && node.name === "fetch") ||
      (node.kind === "libCall" &&
        typeof node.fn === "string" && node.fn.startsWith("fetch."))
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** The libCall fns served by the OPTIONAL events unit (scr_events.c):
 * process signal/exit listeners and the piped-stdin surface. */
const PROCESS_EVENT_LIB_FNS: ReadonlySet<string> = new Set([
  "process.onSignal",
  "process.offSignal",
  "process.onExit",
  "process.offExit",
  "stdin.onData",
  "stdin.onEnd",
  "stdin.onError",
  "stdin.nextChunk",
  // node:readline rides the stdin unit (scr_readline.c links beside
  // scr_events.c under the same gate).
  "rl.create",
  "rl.question",
  "rl.close",
  "rl.onClose",
]);

/** True when the module uses the process-events surface — the link switch
 * that pulls scr_events.c into the binary and has the emitted main call
 * scr_events_install (cc.ts + emitter; the scr_regex/scr_fetch/scr_zlib
 * gating precedent). Event-free programs pay zero bytes and keep their
 * exact link line. Same generic-walk shape as moduleUsesRegex. */
export function moduleUsesProcessEvents(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && PROCESS_EVENT_LIB_FNS.has(node.fn)) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module uses the node:events EventEmitter surface — the
 * link switch that pulls scr_events_emitter.c into the binary (cc.ts; the
 * scr_events.c gating precedent, but pure data structure: no install, no
 * loop hooks). Two signals: the `%EventEmitter` class def rides the
 * module (any emitter-typed value or `extends EventEmitter` subclass
 * references it, and the emitted RC/trace helpers call scr_emitter_*),
 * or an emitter.* libCall survived (the defaultMaxListeners statics carry
 * no emitter-typed value). Emitter-free programs pay zero bytes and keep
 * their exact link line. */
export function moduleUsesEmitter(mod: IrModule): boolean {
  if ((mod.classes ?? []).some((c) => c.name === RUNTIME_EMITTER_CLASS)) return true;
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("emitter.")) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the program touches the node:stream surface (scr_stream.c —
 * the moduleUsesEmitter story: the class defs ride the module whenever a
 * stream-typed value exists, and every stream libCall names its unit).
 * Stream programs always use the emitter unit too — the stream class
 * defs pull `%EventEmitter` through their base chain, so
 * moduleUsesEmitter answers true whenever this does. Stream-free
 * programs pay zero bytes and keep their exact link line. */
export function moduleUsesStream(mod: IrModule): boolean {
  if ((mod.classes ?? []).some((c) => RUNTIME_STREAM_CLASSES.has(c.name))) return true;
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (
      node.kind === "libCall" &&
      typeof node.fn === "string" &&
      (node.fn.startsWith("readable.") || node.fn.startsWith("writable.") ||
        node.fn.startsWith("duplex.") || node.fn.startsWith("transform.") ||
        node.fn.startsWith("passthrough.") ||
        node.fn === "stream.destroy" || node.fn === "stream.destroyErr" ||
        node.fn === "stream.prop" || node.fn === "stream.errored" ||
        node.fn === "sp.finished" || node.fn === "sp.pipeline" ||
        node.fn.startsWith("sc.") ||
        node.fn.startsWith("stream.set"))
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the embedded npm graph has an edge into `builtin` — the
 * island shim needs the corresponding native bridge linked (zlib's is
 * the first; the emitted main installs it before any island entry). */
export function moduleEmbedsBuiltin(mod: IrModule, builtin: string): boolean {
  return mod.embedded !== undefined && mod.embedded.edges.some((e) => e.to === builtin);
}

/** Embedded module texts at least this long are DEFLATE-compressed into
 * the emitted C (emit-island.ts; each stays plain when deflate does not
 * shrink it) and inflated lazily by the island's module loader at first
 * load. Below it the zlib round trip cannot pay for itself. */
export const NPM_COMPRESS_MIN = 1024;

/** True when the emitted npm tables will carry compressed module text —
 * the SAME candidate test emit-island.ts compresses by, so index.ts's
 * zlib link switch and emitter.ts's inflater installation stay in
 * lockstep with the emission (a candidate whose deflate happens not to
 * shrink stays plain; the installed inflater is then just unused). */
export function moduleEmbedsCompressedNpm(mod: IrModule): boolean {
  return (
    mod.embedded !== undefined &&
    mod.embedded.modules.some(
      (m) => m.source.length >= NPM_COMPRESS_MIN || (m.esm ?? "").length >= NPM_COMPRESS_MIN,
    )
  );
}

/** True when the module contains any zlib libCall (the static lowering)
 * OR the embedded npm graph imports node:zlib (the island shim) — the
 * link switch that pulls scr_zlib.c + the system libz into the binary
 * (cc.ts); zlib-free programs keep their exact link line. Same
 * generic-walk shape as moduleUsesRegex: `kind`/`fn` discriminants live
 * only on IR objects. */
export function moduleUsesZlib(mod: IrModule): boolean {
  if (moduleEmbedsBuiltin(mod, "node:zlib")) return true;
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("zlib.")) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any dc.* libCall — the link switch that
 * pulls scr_dc.c (the diagnostics_channel registry and pub/sub) into the
 * binary (cc.ts). Channel-free binaries keep their exact size class.
 * Same walk shape as moduleUsesZlib. */
export function moduleUsesDc(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("dc.")) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any assert libCall — the link switch
 * that pulls scr_assert.c into the binary (cc.ts). scr_regex.c calls the
 * assert throw/inspect helpers (assert.match lives there), so the regex
 * switch also pulls scr_assert.c; assert-free, regex-free binaries keep
 * the historical command line and size. Same walk shape as
 * moduleUsesZlib. */
export function moduleUsesAssert(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("assert.")) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any dynInvoke node or dyn.defineProps
 * libCall — the link switch that pulls scr_dyn_invoke.c (the prototype-
 * method dispatch on dyn receivers, plus scr_dyn_display and
 * scr_dyn_define_props) into the binary (cc.ts; the assert gating
 * precedent — dispatch-free binaries keep their exact size class). Same
 * walk shape as moduleUsesZlib. */
export function moduleUsesDynInvoke(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "dynInvoke" || (node.kind === "libCall" && node.fn === "dyn.defineProps")) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any insp libCall — the link switch that
 * pulls scr_inspect.c into the binary (cc.ts; the assert gating
 * precedent — inspect-free binaries keep the historical command line and
 * size class). Same walk shape as moduleUsesZlib. */
/** True when the module needs scr_async_dyn.c — the checked-dynamic
 * async surfaces (dyn-promise then/catch/finally reactions, await of a
 * dyn value, `new Promise(setImmediate)`, AsyncLocalStorage, the
 * unhandledRejection/warning process events). Also pulled by the
 * dynInvoke and dc gates (their TUs call into this one) — cc.ts. Same
 * walk shape as moduleUsesZlib. */
export function moduleUsesDynAsync(mod: IrModule): boolean {
  const fns = new Set([
    "async.awaitDyn", "timers.immediatePromise",
    "process.onUnhandledRejection", "process.offUnhandledRejection",
    "process.onRejectionHandled", "process.offRejectionHandled",
    "process.onWarning", "process.offWarning", "process.emitWarning",
    "als.new", "als.get", "als.run", "als.exitRun", "als.enterWith", "als.disable",
    "dc.chanBindStore", "dc.chanUnbindStore", "dc.chanRunStores",
  ]);
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown; type?: { kind?: unknown } };
    if (node.kind === "libCall" && typeof node.fn === "string" && fns.has(node.fn)) {
      found = true;
      return;
    }
    // A DYN-typed await reads through scr_await_dyn (the checked-dynamic tree-crossing
    // await lives in the gated TU) — promise<dyn> receivers' awaits and
    // the lifted then/catch helpers alike.
    if (node.kind === "awaitExpr" && node.type !== undefined && node.type.kind === "dyn") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

export function moduleUsesInspect(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("insp.")) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any net libCall — the link switch that
 * pulls scr_net.c into the binary and has the emitted main call
 * scr_net_install (cc.ts + emitter; the scr_events gating precedent).
 * Net-free programs pay zero bytes and keep their exact link line. Same
 * generic-walk shape as moduleUsesZlib. */
export function moduleUsesNet(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" &&
        (node.fn.startsWith("net.") || node.fn.startsWith("http.") ||
         node.fn.startsWith("tls.") || node.fn.startsWith("https.") ||
         node.fn.startsWith("http2."))) {
      // http/tls/https/http2 all ride ON net: their libCalls need scr_net.c
      // linked and installed too, so the net switch answers for every
      // server-family prefix.
      found = true;
      return;
    }
    // A net-family HANDLE TYPE anywhere in the IR (a global or local whose
    // initializing statement compiled to a runtime fence still carries the
    // type): its emitted release call needs the unit linked even when no
    // libCall survived the fencing.
    if (node.kind === "netServer" || node.kind === "netSocket" ||
        node.kind === "http2Session" || node.kind === "http2Stream" ||
        node.kind === "httpReq" || node.kind === "httpRes" ||
        node.kind === "httpClientReq" || node.kind === "secureCtx") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any sym.* libCall or a symbol-kind type
 * anywhere in the IR — the link switch that pulls scr_symbol.c into the
 * binary (cc.ts; the scr_net gating precedent — no install call, the
 * Symbol.for registry initializes lazily). The TYPE check matters like
 * net's: a symbol-typed local whose initializer compiled to a runtime
 * fence still emits release calls that need the unit linked. Symbol-free
 * programs pay zero bytes and keep their exact link line. */
export function moduleUsesSymbol(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("sym.")) {
      found = true;
      return;
    }
    if (node.kind === "symbol") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module uses the URLSearchParams surface — sp.* libCalls,
 * the url.searchParams getter, or a searchParams-kind type anywhere on
 * the IR (a fenced statement can leave a typed local whose release call
 * still needs the unit linked) — the link switch that pulls
 * scr_url_params.c into the binary (the moduleUsesSymbol precedent: pure
 * data structure, no loop hooks, cross-compiles everywhere). sp-free
 * programs keep their exact link line; scr_url.c itself stays
 * always-linked and never references the unit. */
export function moduleUsesSearchParams(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" &&
        (node.fn.startsWith("sp.") || node.fn === "url.searchParams")) {
      found = true;
      return;
    }
    if (node.kind === "searchParams") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module uses the node:querystring surface — the qs.*
 * libCalls that live in scr_qs.c (parse/stringify/unescape; qs.escape
 * emits the always-linked component encoder and deliberately does NOT
 * flip this switch) — the link switch that pulls scr_qs.c into the
 * binary (the moduleUsesSearchParams precedent: pure data transforms, no
 * loop hooks, cross-compiles everywhere). qs-free programs keep their
 * exact link line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesQs(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" &&
        (node.fn === "qs.parse" || node.fn === "qs.stringify" || node.fn === "qs.unescape")) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module uses native util.parseArgs — the link switch for
 * scr_util.c. The implementation is a pure checked-dynamic data transform,
 * cross-platform and independent of the island's node:util shim. */
export function moduleUsesParseArgs(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && node.fn === "util.parseArgs") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any fs.watch/watcher.* libCall — the
 * link switch that pulls scr_watch.c into the binary and has the emitted
 * main call scr_watch_install (cc.ts + emitter; the scr_net gating
 * precedent). Watch-free programs pay zero bytes and keep their exact
 * link line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesFsWatch(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" &&
        (node.fn.startsWith("fs.watch") || node.fn.startsWith("watcher."))) {
      found = true;
      return;
    }
    // A watcher HANDLE TYPE left behind by a fenced statement still emits
    // scr_watcher_release — the unit must link.
    if (node.kind === "fsWatcher") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any test.* libCall or a testCtx handle
 * type — the link switch that pulls scr_test.c into the binary and has
 * the emitted main return scr_test_exit_code() after the loop drains
 * (cc.ts + emitter; the moduleUsesDgram shape). Test-free programs pay
 * zero bytes and keep their exact link line. */
export function moduleUsesNodeTest(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("test.")) {
      found = true;
      return;
    }
    // A TestContext HANDLE TYPE left behind by a fenced statement still
    // emits a release call — the unit must link (the dgram type story).
    if (node.kind === "testCtx") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any dgram.* or dns.* libCall — the
 * link switch that pulls scr_dgram.c into the binary and has the emitted
 * main call scr_dgram_install (cc.ts + emitter; the scr_net gating
 * precedent — dns.lookup lives in the same unit, so either prefix
 * answers). Dgram-free programs pay zero bytes and keep their exact link
 * line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesDgram(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" &&
        (node.fn.startsWith("dgram.") || node.fn.startsWith("dns."))) {
      found = true;
      return;
    }
    // A dgram HANDLE TYPE left behind by a fenced statement still emits a
    // release call — the unit must link (the moduleUsesNet type story).
    if (node.kind === "dgramSocket") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any http.* libCall — the link switch
 * that pulls scr_http.c into the binary (cc.ts; moduleUsesNet already
 * answers true for these, so scr_net.c comes along). */
export function moduleUsesHttpServer(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" &&
        (node.fn.startsWith("http.") || node.fn.startsWith("tls.") || node.fn.startsWith("https.") ||
         node.fn.startsWith("http2."))) {
      // scr_tls.c calls into scr_http.c unconditionally (the https server
      // and client are the http ones over a transport), so any tls/https
      // use pulls the http unit too.
      found = true;
      return;
    }
    // An http-family HANDLE TYPE left behind by a fenced statement still
    // emits its release call — the unit must link (the moduleUsesNet type
    // story; secureCtx rides here because scr_tls.c calls into scr_http.c).
    if (node.kind === "httpReq" || node.kind === "httpRes" ||
        node.kind === "httpClientReq" || node.kind === "secureCtx") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** The legacy http2.* libCalls implemented by scr_http.c/scr_tls.c (the
 * allowHTTP1 compatibility slice) — they must NOT pull scr_http2.c, so
 * divergence-57 binaries keep their exact link line. */
const HTTP2_LEGACY_FNS = new Set([
  "http2.streamNoop", "http2.streamUndefCall",
]);

/** True when the module uses the REAL h2 surface (scr_http2.c): any core
 * http2.* libCall, or an h2 handle type left behind by a fenced statement
 * (its emitted release call needs the unit — the moduleUsesNet story). */
export function moduleUsesHttp2(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" &&
        node.fn.startsWith("http2.") && !HTTP2_LEGACY_FNS.has(node.fn)) {
      found = true;
      return;
    }
    if (node.kind === "http2Session" || node.kind === "http2Stream") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any tls.* or https.* libCall — the link
 * switch that pulls scr_tls.c and the vendored mbedTLS archive into the
 * binary (cc.ts; moduleUsesNet and moduleUsesHttpServer already answer
 * true for these, so scr_net.c and scr_http.c come along). TLS-free
 * programs keep their exact link line and never build mbedTLS. */
export function moduleUsesTls(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" &&
        (node.fn.startsWith("tls.") || node.fn.startsWith("https.") ||
         node.fn.startsWith("http2."))) {
      found = true;
      return;
    }
    // A secureCtx HANDLE TYPE left behind by a fenced statement still
    // emits scr_secure_ctx_release — the unit must link.
    if (node.kind === "secureCtx") {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** True when the module contains any tlsca.* libCall — the link switch
 * for scr_tls_ca.c, the CA-store introspection unit (getCACertificates /
 * rootCertificates / setDefaultCACertificates). Deliberately SEPARATE
 * from moduleUsesTls: the unit is plain PEM-block bookkeeping, so a
 * program that only inspects the CA store never pulls mbedTLS. cc.ts
 * also compiles the unit whenever TLS itself links — scr_tls.c consults
 * the unit's default-set override for its trust anchors. */
export function moduleUsesTlsCa(mod: IrModule): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("tlsca.")) {
      found = true;
      return;
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/* ── library mode's async_free gate ──────────────────────────────────────
 * v1 library mode REQUIRES an async_free module graph (ratified): no async
 * functions, no generators, no timers, no event-loop or ambient-process
 * surface anywhere the entry reaches — a static fact of the graph, never a
 * runtime observation. The detector below answers "what does this graph
 * reach that a library artifact cannot link?", first offender with its source anchor;
 * the structural consequence (scr_async.c / scr_child.c and every
 * loop-hooked unit never join a library link) is safe exactly because this
 * refusal ran first. */

/** libCall families a v1 library artifact refuses, with the surface name the SC4005
 * teaching uses. Prefix match over IrLibFn spellings. */
const LIB_MODE_REFUSED_PREFIXES: readonly [string, string][] = [
  // fs.exists is the one CALLBACK-async fs op with a real implementation:
  // its fire rides the timer queue (scr_bytes_io.c), which library links
  // exclude — refuse the surface like the rest of the event-loop family.
  ["fs.existsChk", "the async fs callback surface (fs.exists)"],
  ["fs.renameCb", "the async fs callback surface (fs.rename)"],
  ["process.stdoutWriteBytesCb", "process.stdout.write completion callbacks"],
  ["process.stderrWriteBytesCb", "process.stderr.write completion callbacks"],
  ["timers.", "the timers surface (setTimeout family)"],
  ["tp.", "the timers/promises surface"],
  ["cp.", "the child_process surface"],
  ["child.", "the child_process surface"],
  ["spawnRes.", "the child_process surface"],
  ["process.on", "process signal/exit listeners"],
  ["process.off", "process signal/exit listeners"],
  ["stdin.", "the stdin event surface"],
  ["rl.", "the node:readline surface"],
  ["net.", "the node:net surface"],
  ["http.", "the node:http surface"],
  ["https.", "the node:https surface"],
  ["http2.", "the node:http2 surface"],
  ["h2.", "the node:http2 surface"],
  ["dgram.", "the node:dgram surface"],
  ["dns.", "the node:dns surface"],
  ["tls.", "the node:tls surface"],
  ["fs.watch", "fs.watch"],
  ["watcher.", "fs.watch"],
  ["test.", "the node:test surface"],
  ["readable.", "the node:stream surface"],
  ["writable.", "the node:stream surface"],
  ["duplex.", "the node:stream surface"],
  ["transform.", "the node:stream surface"],
  ["passthrough.", "the node:stream surface"],
  ["stream.", "the node:stream surface"],
  ["als.", "AsyncLocalStorage"],
  ["urj.", "unhandled-rejection tracking"],
  ["dc.", "the diagnostics_channel surface"],
  // NOT the whole "dyn." family: the checked-dynamic tree (ScrDyn) is
  // static-tier surface hosted by always-linked units; only defineProps
  // drags the prototype-dispatch unit (scr_dyn_invoke.c → scr_async_dyn.c).
  ["dyn.defineProps", "checked-dynamic prototype dispatch"],
];

/** Value/type kinds whose mere presence means an excluded unit's code (or
 * a fiber) would have to link. */
const LIB_MODE_REFUSED_KINDS: ReadonlyMap<string, string> = new Map([
  ["promise", "promise values"],
  ["generator", "generator values"],
  ["awaitExpr", "await"],
  ["awaitUnionExpr", "await"],
  ["yieldExpr", "yield"],
  ["child", "the child_process surface"],
  ["spawnRes", "the child_process surface"],
  ["childStream", "the child_process surface"],
  ["netServer", "the node:net surface"],
  ["netSocket", "the node:net surface"],
  ["http2Session", "the node:http2 surface"],
  ["http2Stream", "the node:http2 surface"],
  ["dgramSocket", "the node:dgram surface"],
  ["fsWatcher", "fs.watch"],
  ["testCtx", "the node:test surface"],
  ["httpReq", "the node:http surface"],
  ["httpRes", "the node:http surface"],
  ["httpClientReq", "the node:http surface"],
  ["secureCtx", "the node:tls surface"],
  ["dynInvoke", "checked-dynamic prototype dispatch"],
]);

/** First async/event-loop/ambient-process surface the module graph
 * reaches, or null when the graph is async_free (the v1 library requirement).
 * The generic-walk shape of moduleUsesRegex, tracking the nearest
 * enclosing `loc` so the refusal anchors at the reaching construct; the
 * coarse moduleUses* predicates are the safety net behind the fine-grained
 * table (a surface reached only through a spelling the table misses still
 * refuses, anchored at the entry). */
export function moduleLibAsyncSurface(mod: IrModule): { surface: string; loc: SrcLoc } | null {
  for (const fn of mod.functions) {
    if (fn.async === true) return { surface: `an async function ('${fn.name.replace(/^%/, "")}')`, loc: fn.loc };
    if (fn.generator !== undefined) {
      return { surface: `a generator function ('${fn.name.replace(/^%/, "")}')`, loc: fn.loc };
    }
  }
  const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  let found: { surface: string; loc: SrcLoc } | null = null;
  const visit = (v: unknown, loc: SrcLoc): void => {
    if (found !== null || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, loc);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown; loc?: SrcLoc };
    const here = node.loc ?? loc;
    if (typeof node.kind === "string") {
      const bad = LIB_MODE_REFUSED_KINDS.get(node.kind);
      if (bad !== undefined) {
        found = { surface: bad, loc: here };
        return;
      }
      if (node.kind === "libCall" && typeof node.fn === "string") {
        for (const [prefix, surface] of LIB_MODE_REFUSED_PREFIXES) {
          if (node.fn.startsWith(prefix)) {
            found = { surface, loc: here };
            return;
          }
        }
      }
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key], here);
  };
  visit(mod, entryLoc);
  if (found !== null) return found;
  // Safety net: the coarse unit predicates, entry-anchored. Every one of
  // these units is excluded from library links, so a true answer that the
  // fine-grained table missed must still refuse.
  const coarse: [boolean, string][] = [
    [moduleUsesProcessEvents(mod), "process signal/exit listeners or the stdin event surface"],
    [moduleUsesNet(mod), "the node:net surface"],
    [moduleUsesHttpServer(mod), "the node:http surface"],
    [moduleUsesHttp2(mod), "the node:http2 surface"],
    [moduleUsesDgram(mod), "the node:dgram surface"],
    [moduleUsesFsWatch(mod), "fs.watch"],
    [moduleUsesStream(mod), "the node:stream surface"],
    [moduleUsesTls(mod), "the node:tls surface"],
    [moduleUsesFetch(mod), "fetch"],
    [moduleUsesNodeTest(mod), "the node:test surface"],
    [moduleUsesDynAsync(mod), "the checked-dynamic async surface"],
    [moduleUsesDc(mod), "the diagnostics_channel surface"],
    [moduleUsesDynInvoke(mod), "checked-dynamic prototype dispatch"],
  ];
  for (const [on, surface] of coarse) {
    if (on) return { surface, loc: entryLoc };
  }
  return null;
}

/* ── the sidecar's determinism attestation ───────────────────────────────
 * `deterministic` is true exactly when the compiled module graph reaches
 * no ambient-nondeterminism or ambient-authority surface (random, live
 * clock, environment, filesystem, machine identity) — a static fact of
 * the graph, proven at compile time, never a runtime hope. Network,
 * timers, scheduling, and child processes are already impossible here:
 * the SC4005 async_free gate refused them before any library artifact
 * emitted. The scan is CONSERVATIVE by design: an ambient family reached
 * anywhere in the graph demotes the attestation even when a finer
 * analysis might prove the specific call pure (e.g. date formatting of a
 * stored value) — the attestation may honestly under-claim, never
 * over-claim (schema rule V14: computed, never defaulted). */

/** libCall families that demote `deterministic` (prefix match over
 * IrLibFn spellings). process.stdout/stderr writes are deliberately NOT
 * here: output is an effect, not a nondeterminism input, and console
 * policy is the profile's ask-5 business. process.platform/arch and the
 * version constants fold at compile time, so they are per-binary
 * constants, not ambient reads. Exported for the attestation-parity test
 * (tests/harness/surface-manifest.test.ts): every spelling this table
 * demotes on must be deniable by a manifest-id fence, or the ask-5 §4
 * invariant (compiles under full fences ⇒ deterministic) cannot be
 * stated. */
export const LIB_NONDETERMINISTIC_PREFIXES: readonly [string, string][] = [
  ["math.random", "Math.random"],
  ["crypto.random", "crypto randomness"],
  ["date.", "the live clock (Date)"],
  ["perf.", "the live clock (performance)"],
  ["process.env", "environment reads"],
  ["process.argv", "process.argv"],
  ["process.cwd", "process.cwd"],
  ["process.chdir", "process.chdir"],
  ["process.pid", "process identity"],
  ["process.getuid", "process identity"],
  ["process.getgid", "process identity"],
  ["process.execPath", "process identity"],
  ["process.uptime", "the live clock (process.uptime)"],
  ["process.availableMemory", "machine memory state"],
  ["process.constrainedMemory", "machine memory state"],
  // process.memoryUsage carries NO row: nothing lowers it — no IrLibFn
  // spelling exists for it, so a prefix here would be dead. If a lowering
  // ever lands, its spellings must join this table AND the manifest's
  // ambient projection (the parity test fails until both agree).
  ["process.rusage", "machine resource usage (process.resourceUsage)"],
  ["process.cpu", "the process CPU clock (process.cpuUsage)"],
  ["process.threadCpu", "the thread CPU clock (process.threadCpuUsage)"],
  ["process.isTTY", "terminal attachment (isTTY)"],
  ["process.columns", "terminal geometry (columns)"],
  ["process.kill", "process authority (kill)"],
  ["process.umask", "process authority (umask)"],
  ["process.exit", "process authority (exit)"],
  ["fs.", "the filesystem"],
  ["os.", "machine/OS identity"],
  // The CA-store surface reads the host's certificate bundle (and the
  // NODE_EXTRA_CA_CERTS environment) — machine identity by another name.
  ["tlsca.", "the host CA store"],
];

/** First ambient-nondeterminism or ambient-authority surface the module
 * graph reaches, or null when the graph is clean (the sidecar then
 * attests `deterministic: true`). */
export function moduleLibNondeterministicSurface(mod: IrModule): string | null {
  let found: string | null = null;
  const visit = (v: unknown): void => {
    if (found !== null || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const node = v as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string") {
      for (const [prefix, surface] of LIB_NONDETERMINISTIC_PREFIXES) {
        if (node.fn.startsWith(prefix)) {
          found = surface;
          return;
        }
      }
    }
    for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
  };
  visit(mod);
  return found;
}

/** The may-throw seed: libCall members that can raise. Every fs.* member
 * EXCEPT existsSync (which, like Node's, swallows errors and returns false)
 * throws a catchable error on failure; json.parse throws a catchable
 * SyntaxError-shaped string on malformed input; process.* members never
 * throw. Backends' may-throw analyses must treat a function containing one
 * of these as throwing, exactly like a `throw` statement (and must ALSO
 * seed on `dynCheck` and `awaitExpr` nodes, which throw on validation
 * failure / promise rejection). */
export const MAY_THROW_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "fetch.responseNew",
  "fetch.abortTimeout",
  "fetch.abortAny",
  "fetch.streamNew",
  "fetch.streamFrom",
  "num.toFixed",
  "insp.jsonDyn",
  // diagnostics_channel: publish runs subscribers synchronously (a throw
  // propagates — the documented divergence from triggerUncaughtException);
  // the subscribe/unsubscribe forms throw Node's ERR_INVALID_ARG_TYPE for
  // non-function subscribers.
  "dc.publish",
  "dc.subscribe",
  "dc.unsubscribe",
  "dc.chanSubscribe",
  "dc.chanUnsubscribe",
  "dc.tcSubscribe",
  "dc.tcUnsubscribe",
  "dc.tcTraceSync",
  "dc.tcTraceCallback",
  "dc.tcTracePromise",
  "process.onUnhandledRejection",
  "process.onRejectionHandled",
  "async.awaitDyn",
  "als.run",
  "als.exitRun",
  "dc.chanBindStore",
  "dc.chanRunStores",
  "http.resWriteHeadDyn",
  "http.serverTimeoutGet",
  "http.serverTimeoutOptionSet",
  "net.sockSetEncoding",
  "http.reqSetEncoding",
  "fs.readFileSyncBuf",
  "fs.readFileSyncDyn",
  // tls/https runtime options records: the walks throw the catchable
  // runtime fence for out-of-bounds members and non-PEM values (the
  // divergence-66 stance).
  "tls.pemDyn",
  "tls.createServerDyn",
  "tls.createSecureContextDyn",
  "tls.caCertsChk",
  "tls.createServerDynCb",
  "https.createServerDyn",
  "https.createServerDynCb",
  "http2.createSecureServerDyn",
  "http2.createSecureServerDynCb",
  "tls.connect",
  "tls.connectCb",
  // The CA-store surface: an unknown getCACertificates type throws
  // Node's ERR_INVALID_ARG_VALUE TypeError; setDefaultCACertificates
  // throws Node's ERR_CRYPTO_OPERATION_FAILED on a certificate-free
  // array.
  "tlsca.get",
  "tlsca.set",
  // EventEmitter dispatch runs user listeners synchronously (emit), and
  // the mutation forms fire the newListener/removeListener meta events —
  // any of them can throw. emitError additionally THROWS its payload when
  // 'error' has no listener, Node's unhandled-'error' contract.
  "emitter.emit",
  "emitter.emitError",
  "emitter.on",
  "emitter.off",
  "emitter.checkListener",
  "emitter.onDyn",
  "emitter.offDyn",
  "emitter.onData",
  "emitter.onDataDyn",
  "emitter.emitData",
  "readable.nextChunk",
  "readable.nextChunkDyn",
  // The checked-dynamic chunk forms throw Node's ERR_INVALID_ARG_TYPE
  // chunk TypeError on a non-string/Buffer dyn kind.
  "net.sockWriteDyn",
  "net.sockEndDyn",
  "http.resWriteDyn",
  "http.resEndDyn",
  "http.clientWriteDyn",
  "http.clientEndDyn",
  // The URL-string client form throws catchably on an unparsable input
  // ("Invalid URL") or a non-http scheme (ERR_INVALID_PROTOCOL).
  "http.requestUrl",
  "http.requestUrlCb",
  // The h2 client's throwing entries: connect on a bad/non-http
  // authority (ERR_INVALID_URL / ERR_INVALID_PROTOCOL), request on a
  // closed/destroyed session (ERR_HTTP2_INVALID_SESSION), setEncoding on
  // an unknown name (ERR_UNKNOWN_ENCODING). Event fires run user code
  // synchronously (the stream-operations stance below), so the data/
  // write paths that can fire inline join too.
  "http2.connect",
  "http2.connectCb",
  "http2.sessionRequest",
  "http2.streamSetEncoding",
  "http2.streamRespond",
  "http2.streamWrite",
  "http2.streamWriteBytes",
  "http2.streamEnd",
  "http2.streamEndStr",
  "http2.streamEndBytes",
  "emitter.removeAll",
  // Stream operations run user code synchronously (option callbacks and
  // 'data'/'drain'/... listeners on the caller's stack, like emit) — any
  // of them may leave a listener's throw pending. destroy with no 'error'
  // listener throws the payload itself (the emitter.emitError contract).
  // The dyn-options constructors walk the record at runtime: a consumed-
  // but-unlowered option (objectMode, construct, ...) throws the compile
  // fence's runtime twin; a bad encoding throws ERR_UNKNOWN_ENCODING.
  "stream.finished",
  "stream.finishedDyn",
  "stream.pipeline",
  "stream.pipelineDyn",
  "sp.finished",
  "sp.pipeline",
  "sc.text",
  "sc.json",
  "sc.buffer",
  "readable.newDyn",
  "writable.newDyn",
  "duplex.newDyn",
  "transform.newDyn",
  "passthrough.newDyn",
  "readable.initDyn",
  "writable.initDyn",
  "duplex.initDyn",
  "transform.initDyn",
  "passthrough.initDyn",
  "readable.push",
  "readable.pushStr",
  "readable.pushStrEnc",
  "readable.pushNull",
  "readable.pushU",
  "readable.pushDyn",
  "readable.unshift",
  "readable.unshiftStr",
  "readable.read",
  "readable.resume",
  "readable.pipe",
  "readable.unpipe",
  "writable.write",
  "writable.writeStr",
  "writable.writeU",
  "writable.writeDyn",
  "writable.end",
  "writable.uncork",
  "stream.destroy",
  "stream.destroyErr",
  // setMaxListeners(n) throws Node's ERR_OUT_OF_RANGE RangeError for
  // negative/NaN arguments; the static form's default-max write validates
  // identically (Node's validateNumber(n, "setMaxListeners", 0)).
  "emitter.setMax",
  "emitter.setDefaultMax",
  // The createConnection request forms run the caller's dialer closure
  // synchronously — a throw there propagates like Node's.
  "http.requestConn",
  "http.requestConnCb",
  "process.kill",
  "process.killNum",
  // cpuUsage(prev)'s field validation: negative/non-finite prev fields
  // throw Node's ERR_INVALID_ARG_VALUE RangeError, catchably.
  "process.cpuPrevValidate",
  // Non-TTY stdin: Node's stdin has no setRawMode member, so the call is
  // the exact catchable TypeError.
  "process.stdinSetRawMode",
  // The unguarded h2-only stream call: always throws Node's TypeError.
  "http2.streamUndefCall",
  "http.reqH2StreamOrThrow",
  // A read of a declare-d const nothing defines: always throws Node's
  // catchable ReferenceError.
  "global.undefRead",
  // The compiler-resolved Node-parity throw: always throws, catchably.
  "error.nodeThrow",
  // USVString coercion runs user toString/valueOf — throws propagate.
  "dyn.toStringCoerce",
  "child.kill",
  // The caller's lookup runs synchronously inside the connect call — a
  // throw there propagates like Node's.
  "net.connectLookup",
  "cp.execSync",
  "cp.execCapture",
  // The client request constructors validate the method token
  // synchronously (Node's ClientRequest ctor throw:
  // ERR_INVALID_HTTP_TOKEN).
  "http.request",
  "http.requestCb",
  "http.requestConn",
  "http.requestConnCb",
  // The agent rows add the runtime agent-value gates (a non-Agent value
  // is Node's ERR_INVALID_ARG_TYPE); agentNew's keepAlive: true throws
  // the named pooling fence.
  "http.agentNew",
  "http.requestAgent",
  "http.requestAgentCb",
  "https.requestAgent",
  "https.requestAgentCb",
  "https.request",
  "https.requestCb",
  // The URL-string form's parse, exactly http.requestUrl's (an
  // unparsable input, or a scheme that is not https).
  "https.requestUrl",
  "https.requestUrlCb",
  "https.requestFn",
  "https.requestFnCb",
  "rl.question",
  "island.eval",
  "island.import",
  "island.castFail",
  "json.parse",
  "util.parseArgs",
  // decodeURIComponent throws the spec's URIError on bad hex/invalid
  // UTF-8 octets (encodeURIComponent never throws — see the IrLibFn doc).
  "str.decodeUriComponent",
  // The base64 globals: atob/btoa throw the catchable DOMException
  // InvalidCharacterError on malformed input; the zero-argument form
  // always throws Node's TypeError [ERR_MISSING_ARGS].
  "str.atob",
  "str.btoa",
  "str.b64Missing",
  // queueMicrotask's checked-dynamic form throws ERR_INVALID_ARG_TYPE
  // synchronously on a non-function argument (the closure form never
  // throws — the callback's own throw surfaces at drain, uncaught).
  "timers.queueMicrotaskDyn",
  // structuredClone: option validation throws Node's TypeErrors,
  // functions/handles the spec's DataCloneError, cycles the scriptc
  // fence; the zero-argument form always throws ERR_MISSING_ARGS. The
  // DOMException clone shares the option validation.
  "dyn.structuredClone",
  "dyn.cloneMissing",
  "dyn.cloneTransferFail",
  // the dyn Object walks throw on null/undefined receivers
  "dyn.objKeys",
  "dyn.hasOwn",
  "dyn.assign",
  // variadic Object.assign: spread flattening throws V8's spread-call
  // TypeErrors; the final copy throws ToObject on a nullish target
  "dyn.packPushSpread",
  "dyn.packPushSpreadIter",
  "dyn.assignAll",
  "dyn.objValues",
  "dyn.objEntries",
  "error.domClone",
  // new RegExp compiles the pattern eagerly: an invalid pattern or flag
  // throws Node's catchable SyntaxError at construction.
  "regex.new",
  "dyn.keySet",
  // the destructuring pack throws V8's TypeError on non-iterable dyn kinds
  "dyn.iterPack",
  "dyn.toString",
  "dyn.defineProps",
  "process.chdir",
  "fs.realpathSync",
  "fs.readFileSync",
  "fs.writeFileSync",
  "fs.appendFileSync",
  "fs.mkdirSync",
  "fs.rmSync",
  "fs.rmdirSync",
  "fs.readdirSync",
  "fs.readdirTypesSync",
  "url.new",
  "url.fileURLToPathUrl",
  "url.fileURLToPathStr",
  // The win32-target flavor of pathToFileURL (same runtime entry point —
  // the bridge dispatches by the binary's platform): Node's win32 arm
  // raises ERR_INVALID_ARG_VALUE TypeErrors for malformed UNC inputs, so
  // only THIS flavor seeds may-throw — posix emission stays untouched.
  "url.pathToFileURLWin32",
  // URLSearchParams from a string[][]: Node's ERR_INVALID_TUPLE TypeError
  // on a row that is not a [name, value] pair. The rest of the sp family
  // never throws.
  "sp.fromPairs",
  "fs.statSync",
  "crypto.randomBytesToString",
  "crypto.randomBytes",
  "buffer.concatLen",
  // The checked-dynamic compare/equals validators: Node's argument
  // ladders throw ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE catchably.
  "buffer.compareChk",
  "bytes.equalsChk",
  "bytes.compareChk",
  "buffer.newStringFail",
  "fs.toUnixTimestamp",
  "fs.existsChk",
  "fs.mkdtempChk",
  "fs.mkdtempSyncChk",
  "fs.readFileChk",
  "fs.opendirChk",
  "fs.watchFileChk",
  "fs.lchmodChk",
  "fs.lchmodSyncChk",
  "fsp.lchmodChk",
  "fs.readChk",
  "fs.streamOptsChk",
  "net.connectAttempt",
  "net.connectOptsChk",
  "net.setAutoSelTimeout",
  "error.argTypeThrow",
  "error.propTypeThrow",
  "emitter.setMaxChk",
  "emitter.setDefaultMaxChk",
  "fs.readFileSyncBytes",
  "fs.writeFileSyncBytes",
  "zlib.inflateSync",
  "date.toISOString",
  "date.toISOStringValue",
  "fs.mkdirRecursiveSync",
  "fs.rmOptsSync",
  "fs.rmRetrySync",
  "fs.mkdtempSync",
  "fs.accessSync",
  "fs.readFdSync",
  "fs.readFdSyncBytes",
  // node:dgram state errors (Node throws synchronously): bind on a bound
  // socket, connect on a connected one, send/close/address on a closed or
  // never-bound one.
  "dgram.bind",
  "dgram.bindCb",
  "dgram.connect",
  "dgram.connectCb",
  "dgram.sendStr",
  "dgram.sendBytes",
  "dgram.sendChk",
  "dgram.address",
  "dgram.close",
  "dgram.closeCb",
  // The assert surface: every entry point except sameValue, bytesDeepEq,
  // and the shape accumulator's begin/slot/test calls throws the
  // catchable AssertionError on failure.
  "assert.ok",
  "assert.eqF64",
  "assert.eqStr",
  "assert.eqBool",
  "assert.eqSym",
  "assert.eqDyn",
  "assert.deepResult",
  "assert.match",
  "assert.refEqBytes",
  "assert.refEqFn",
  "assert.throwsNone",
  "assert.throwsMismatch",
  "assert.throwsRegex",
  "assert.shapeEnd",
  "assert.unwantedRejection",
  "assert.expectsErrDyn",
  "assert.ifErrorErr",
  "assert.ifErrorF64",
  "assert.ifErrorStr",
  "assert.ifErrorBool",
  "assert.ifErrorDyn",
  // util.inspect of an island `any` composite: the runtime tag is all
  // there is, so the honest answer is a catchable TypeError.
  "insp.jsval",
  // The wider sync fs slice: same catchable errno throws as the rest.
  "fs.unlinkSync",
  "fs.chmodSync",
  "fs.chownSync",
  "fs.copyFileSync",
  "fs.renameSync",
  "fs.lstatSync",
  "fs.writeFileModeSync",
  "fs.mkdirModeSync",
  "fs.mkdirRecursiveModeSync",
  "fs.openSync",
  "fs.readSync",
  "fs.writeSync",
  "fs.writeStrSync",
  "fs.closeSync",
  "fs.watch",
  "fs.watchCb",
  "crypto.x509Fingerprint",
  "crypto.x509FingerprintStr",
  "crypto.x509ValidFrom",
  "crypto.x509ValidFromStr",
  "crypto.x509ValidTo",
  "crypto.x509ValidToStr",
]);
