/* Type-directed dispatch tables of the C emitter: the C spelling of every IR
 * type and the per-type runtime entry points (retain/release, box kinds,
 * array element kinds, map key/value kinds), plus C literal spelling. Pure
 * functions of IrType/values — every emission module leans on these, so they
 * live in ONE place with no emitter state. */
import type { IrType } from "../../ir/nodes.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES } from "../../ir/nodes.js";
import {
  mangleClassRelease,
  mangleClassRetain,
  mangleClassStruct,
  mangleRecordRelease,
  mangleRecordRetain,
  mangleRecordStruct,
} from "../mangle.js";

export function cType(t: IrType): string {
  switch (t.kind) {
    case "f64":
    case "date":
      return "double";
    case "bool":
      return "bool";
    case "string":
      return "ScrStr *";
    case "array":
      return "ScrArr *";
    case "map":
    case "set":
      // Sets ARE the map runtime with the value slot unused (SCR_MAP_VAL_F64
      // storing a constant 0) — one struct, one RC family, one allocator.
      return "ScrMap *";
    case "regex":
      return "ScrRegex *";
    case "bytes":
      // One struct for every element kind (the runtime dispatches on the
      // stored elem tag) — exactly the ScrArr pattern.
      return "ScrBytes *";
    case "url":
      return "ScrUrl *";
    case "searchParams":
      return "ScrSearchParams *";
    case "symbol":
      return "ScrSym *";
    case "stats":
      return "ScrStats *";
    case "fileHandle":
      return "ScrFileHandle *";
    case "spawnRes":
      return "ScrSpawnRes *";
    case "child":
      return "ScrChild *";
    case "netServer":
      return "ScrNetServer *";
    case "netSocket":
      return "ScrNetSocket *";
    case "http2Session":
      return "ScrH2Session *";
    case "http2Stream":
      return "ScrH2Stream *";
    case "dgramSocket":
      return "ScrDgramSocket *";
    case "midiInput":
      return "ScrMidiInput *";
    case "midiOutput":
      return "ScrMidiOutput *";
    case "testCtx":
      return "ScrTestCtx *";
    case "httpReq":
      return "ScrHttpReq *";
    case "httpRes":
      return "ScrHttpRes *";
    case "httpClientReq":
      return "ScrHttpClientReq *";
    case "secureCtx":
      return "ScrSecureCtx *";
    case "fsWatcher":
      return "ScrWatcher *";
    case "childStream":
      return "ScrChildStream *";
    case "procStream":
      // A SCALAR kind: the stream value IS its fd (1 = stdout, 2 =
      // stderr) — no heap, no refcount.
      return "double";
    case "func":
      return "ScrClosure *";
    case "classval":
      // ONE struct type for every class (the fields are class-independent).
      return "ScrClassObj *";
    case "object":
      // Runtime-provided error classes share the runtime's ScrError struct
      // (all four builtins have the same layout; user subclasses embed it
      // as their emitted struct's prefix).
      if (RUNTIME_ERROR_CLASSES.has(t.className)) return "ScrError *";
      // The runtime emitter class shares the runtime's ScrEmitter struct
      // (user subclasses embed its prefix in their emitted structs).
      if (t.className === RUNTIME_EMITTER_CLASS) return "ScrEmitter *";
      // The five runtime stream classes share ONE runtime struct (the
      // emitter prefix plus the stream-state pointer) — upcasts among
      // them and to ScrEmitter are pointer reinterprets.
      if (RUNTIME_STREAM_CLASSES.has(t.className)) return "ScrStream *";
      return `${mangleClassStruct(t.className)} *`;
    case "record":
      return `${mangleRecordStruct(t.shapeId)} *`;
    case "union":
      return "ScrUnion *";
    case "dyn":
      return "ScrDyn *";
    case "jsval":
      return "ScrJsval *";
    case "caught":
      return "ScrCaught *";
    case "promise":
      return "ScrPromise *";
    case "generator":
      return "ScrGen *";
    case "void":
      return "void";
    case "undefinedT":
    case "nullT":
      // Unit kinds have no C value form: they exist only as union arms
      // (the box carries the tag and nothing else) — a unit type asked to
      // declare a C value is an emitter bug.
      throw new Error(`emitter bug: ${t.kind} has no C value form`);
    default: {
      const _exhaustive: never = t;
      void _exhaustive;
      throw new Error("unreachable");
    }
  }
}

/** The retain call (+1, returns the value) for one refcounted type. */
export function retainCallC(type: IrType, expr: string): string {
  switch (type.kind) {
    case "string":
      return `scr_str_retain(${expr})`;
    case "array":
      return `scr_arr_retain(${expr})`;
    case "map":
    case "set":
      return `scr_map_retain(${expr})`;
    case "regex":
      return `scr_regex_retain(${expr})`;
    case "bytes":
      return `scr_bytes_retain(${expr})`;
    case "url":
      return `scr_url_retain(${expr})`;
    case "searchParams":
      return `scr_sp_retain(${expr})`;
    case "symbol":
      return `scr_sym_retain(${expr})`;
    case "stats":
      return `scr_stats_retain(${expr})`;
    case "fileHandle":
      return `scr_file_handle_retain(${expr})`;
    case "spawnRes":
      return `scr_spawn_res_retain(${expr})`;
    case "child":
      return `scr_child_retain(${expr})`;
    case "netServer":
      return `scr_net_server_retain(${expr})`;
    case "netSocket":
      return `scr_net_sock_retain(${expr})`;
    case "http2Session":
      return `scr_http2_session_retain(${expr})`;
    case "http2Stream":
      return `scr_http2_stream_retain(${expr})`;
    case "dgramSocket":
      return `scr_dgram_retain(${expr})`;
    case "midiInput":
      return `scr_midi_input_retain(${expr})`;
    case "midiOutput":
      return `scr_midi_output_retain(${expr})`;
    case "testCtx":
      return `scr_testctx_retain(${expr})`;
    case "httpReq":
      return `scr_http_req_retain(${expr})`;
    case "httpRes":
      return `scr_http_res_retain(${expr})`;
    case "httpClientReq":
      return `scr_http_client_retain(${expr})`;
    case "secureCtx":
      return `scr_secure_ctx_retain(${expr})`;
    case "fsWatcher":
      return `scr_watcher_retain(${expr})`;
    case "childStream":
      return `scr_child_stream_retain(${expr})`;
    case "func":
      return `scr_closure_retain(${expr})`;
    case "classval":
      // A no-op on the immortal static — kept for ownership uniformity.
      return `scr_classobj_retain(${expr})`;
    case "object":
      if (RUNTIME_ERROR_CLASSES.has(type.className)) return `scr_error_retain(${expr})`;
      if (type.className === RUNTIME_EMITTER_CLASS) return `scr_emitter_retain(${expr})`;
      if (RUNTIME_STREAM_CLASSES.has(type.className)) return `scr_stream_retain(${expr})`;
      return `${mangleClassRetain(type.className)}(${expr})`;
    case "record":
      return `${mangleRecordRetain(type.shapeId)}(${expr})`;
    case "promise":
      return `scr_promise_retain(${expr})`;
    case "generator":
      return `scr_gen_retain(${expr})`;
    case "union":
      return `scr_union_retain(${expr})`;
    case "dyn":
      return `scr_dyn_retain(${expr})`;
    case "jsval":
      return `scr_jsval_retain(${expr})`;
    case "caught":
      return `scr_caught_retain(${expr})`;
    default:
      throw new Error(`emitter bug: retain of non-refcounted type ${type.kind}`);
  }
}

/** The release call for one owned refcounted value (all NULL-tolerant). */
export function releaseCallC(type: IrType, expr: string): string {
  switch (type.kind) {
    case "string":
      return `scr_str_release(${expr})`;
    case "array":
      return `scr_arr_release(${expr})`;
    case "map":
    case "set":
      return `scr_map_release(${expr})`;
    case "regex":
      return `scr_regex_release(${expr})`;
    case "bytes":
      return `scr_bytes_release(${expr})`;
    case "url":
      return `scr_url_release(${expr})`;
    case "searchParams":
      return `scr_sp_release(${expr})`;
    case "symbol":
      return `scr_sym_release(${expr})`;
    case "stats":
      return `scr_stats_release(${expr})`;
    case "fileHandle":
      return `scr_file_handle_release(${expr})`;
    case "spawnRes":
      return `scr_spawn_res_release(${expr})`;
    case "child":
      return `scr_child_release(${expr})`;
    case "netServer":
      return `scr_net_server_release(${expr})`;
    case "netSocket":
      return `scr_net_sock_release(${expr})`;
    case "http2Session":
      return `scr_http2_session_release(${expr})`;
    case "http2Stream":
      return `scr_http2_stream_release(${expr})`;
    case "dgramSocket":
      return `scr_dgram_release(${expr})`;
    case "midiInput":
      return `scr_midi_input_release(${expr})`;
    case "midiOutput":
      return `scr_midi_output_release(${expr})`;
    case "testCtx":
      return `scr_testctx_release(${expr})`;
    case "httpReq":
      return `scr_http_req_release(${expr})`;
    case "httpRes":
      return `scr_http_res_release(${expr})`;
    case "httpClientReq":
      return `scr_http_client_release(${expr})`;
    case "secureCtx":
      return `scr_secure_ctx_release(${expr})`;
    case "fsWatcher":
      return `scr_watcher_release(${expr})`;
    case "childStream":
      return `scr_child_stream_release(${expr})`;
    case "func":
      return `scr_closure_release(${expr})`;
    case "classval":
      return `scr_classobj_release(${expr})`;
    case "object":
      if (RUNTIME_ERROR_CLASSES.has(type.className)) return `scr_error_release(${expr})`;
      if (type.className === RUNTIME_EMITTER_CLASS) return `scr_emitter_release(${expr})`;
      if (RUNTIME_STREAM_CLASSES.has(type.className)) return `scr_stream_release(${expr})`;
      return `${mangleClassRelease(type.className)}(${expr})`;
    case "record":
      return `${mangleRecordRelease(type.shapeId)}(${expr})`;
    case "promise":
      return `scr_promise_release(${expr})`;
    case "generator":
      return `scr_gen_release(${expr})`;
    case "union":
      return `scr_union_release(${expr})`;
    case "dyn":
      return `scr_dyn_release(${expr})`;
    case "jsval":
      return `scr_jsval_release(${expr})`;
    case "caught":
      return `scr_caught_release(${expr})`;
    default:
      throw new Error(`emitter bug: release of non-refcounted type ${type.kind}`);
  }
}

/** The runtime's box-kind tag for a boxed (captured) variable's type. */
export function boxKindC(t: IrType): string {
  switch (t.kind) {
    case "f64":
    case "date":
      return "SCR_BOX_F64";
    case "bool":
      return "SCR_BOX_BOOL";
    case "string":
      return "SCR_BOX_STR";
    case "array":
      return "SCR_BOX_ARR";
    case "func":
      return "SCR_BOX_FUNC";
    case "object":
    case "classval":
    case "record":
    case "union":
    case "map":
    case "set":
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
    case "midiInput":
    case "midiOutput":
    case "testCtx":
    case "httpReq":
    case "httpRes":
    case "httpClientReq":
    case "secureCtx":
    case "fsWatcher":
    case "childStream":
    case "bytes":
      throw new Error(`emitter bug: ${t.kind} boxes go through boxNewC, not boxKindC`);
    case "procStream":
      // Scalar (the fd double) — the f64 box carries it.
      return "SCR_BOX_F64";
    case "dyn":
      // dyn never rides capture boxes (frontend rejects dyn captures).
      throw new Error("emitter bug: box of dyn");
    case "jsval":
      throw new Error("emitter bug: jsval boxes go through boxNewC, not boxKindC");
    case "promise":
      // promises ride obj-boxes (boxNewC), never plain kind boxes
      throw new Error("emitter bug: promise boxes go through boxNewC");
    case "generator":
      // generators ride obj-boxes too (boxNewC — vAdapters carries the
      // ScrGen RC entry points; no trace, like child).
      throw new Error("emitter bug: generator boxes go through boxNewC");
    case "undefinedT":
    case "nullT":
    case "caught":
      // unit kinds never stand alone (and catch bindings never box), so
      // nothing to box
      throw new Error(`emitter bug: box of ${t.kind}`);
    case "void":
      throw new Error("emitter bug: box of void");
    default: {
      const _exhaustive: never = t;
      void _exhaustive;
      throw new Error("unreachable");
    }
  }
}

/** The runtime `_v` (void*-signature) RC entry points for one refcounted
 * type — the currency of every generic container that must retain/release
 * payloads whose concrete struct it cannot know: union values, capture
 * boxes, promises, and the exception cell. Classes and records use their
 * emitted per-shape adapters; everything else has runtime-provided ones.
 * Bare symbol names — call sites prefix `&` where a fn ptr is passed. */
export function vAdapters(t: IrType): { retain: string; release: string } {
  switch (t.kind) {
    case "string":
      return { retain: "scr_str_retain_v", release: "scr_str_release_v" };
    case "array":
      return { retain: "scr_arr_retain_v", release: "scr_arr_release_v" };
    case "map":
    case "set":
      return { retain: "scr_map_retain_v", release: "scr_map_release_v" };
    case "regex":
      return { retain: "scr_regex_retain_v", release: "scr_regex_release_v" };
    case "bytes":
      return { retain: "scr_bytes_retain_v", release: "scr_bytes_release_v" };
    case "url":
      return { retain: "scr_url_retain_v", release: "scr_url_release_v" };
    case "searchParams":
      return { retain: "scr_sp_retain_v", release: "scr_sp_release_v" };
    case "symbol":
      return { retain: "scr_sym_retain_v", release: "scr_sym_release_v" };
    case "stats":
      return { retain: "scr_stats_retain_v", release: "scr_stats_release_v" };
    case "fileHandle":
      return { retain: "scr_file_handle_retain_v", release: "scr_file_handle_release_v" };
    case "spawnRes":
      return { retain: "scr_spawn_res_retain_v", release: "scr_spawn_res_release_v" };
    case "child":
      return { retain: "scr_child_retain_v", release: "scr_child_release_v" };
    case "netServer":
      return { retain: "scr_net_server_retain_v", release: "scr_net_server_release_v" };
    case "netSocket":
      return { retain: "scr_net_sock_retain_v", release: "scr_net_sock_release_v" };
    case "http2Session":
      return { retain: "scr_http2_session_retain_v", release: "scr_http2_session_release_v" };
    case "http2Stream":
      return { retain: "scr_http2_stream_retain_v", release: "scr_http2_stream_release_v" };
    case "dgramSocket":
      return { retain: "scr_dgram_retain_v", release: "scr_dgram_release_v" };
    case "midiInput":
      return { retain: "scr_midi_input_retain_v", release: "scr_midi_input_release_v" };
    case "midiOutput":
      return { retain: "scr_midi_output_retain_v", release: "scr_midi_output_release_v" };
    case "testCtx":
      return { retain: "scr_testctx_retain_v", release: "scr_testctx_release_v" };
    case "httpReq":
      return { retain: "scr_http_req_retain_v", release: "scr_http_req_release_v" };
    case "httpRes":
      return { retain: "scr_http_res_retain_v", release: "scr_http_res_release_v" };
    case "httpClientReq":
      return { retain: "scr_http_client_retain_v", release: "scr_http_client_release_v" };
    case "secureCtx":
      return { retain: "scr_secure_ctx_retain_v", release: "scr_secure_ctx_release_v" };
    case "fsWatcher":
      return { retain: "scr_watcher_retain_v", release: "scr_watcher_release_v" };
    case "childStream":
      return { retain: "scr_child_stream_retain_v", release: "scr_child_stream_release_v" };
    case "func":
      return { retain: "scr_closure_retain_v", release: "scr_closure_release_v" };
    case "classval":
      // No-ops on the immortal class object; the container machinery
      // stays uniform.
      return { retain: "scr_classobj_retain_v", release: "scr_classobj_release_v" };
    case "union":
      return { retain: "scr_union_retain_v", release: "scr_union_release_v" };
    case "object":
      if (RUNTIME_ERROR_CLASSES.has(t.className)) {
        return { retain: "scr_error_retain_v", release: "scr_error_release_v" };
      }
      if (t.className === RUNTIME_EMITTER_CLASS) {
        return { retain: "scr_emitter_retain_v", release: "scr_emitter_release_v" };
      }
      if (RUNTIME_STREAM_CLASSES.has(t.className)) {
        return { retain: "scr_stream_retain_v", release: "scr_stream_release_v" };
      }
      return { retain: `${mangleClassRetain(t.className)}_v`, release: `${mangleClassRelease(t.className)}_v` };
    case "record":
      return { retain: `${mangleRecordRetain(t.shapeId)}_v`, release: `${mangleRecordRelease(t.shapeId)}_v` };
    case "promise":
      return { retain: "scr_promise_retain_v", release: "scr_promise_release_v" };
    case "generator":
      return { retain: "scr_gen_retain_v", release: "scr_gen_release_v" };
    case "dyn":
      return { retain: "scr_dyn_retain_v", release: "scr_dyn_release_v" };
    case "jsval":
      return { retain: "scr_jsval_retain_v", release: "scr_jsval_release_v" };
    default:
      throw new Error(`emitter bug: no RC adapters for ${t.kind}`);
  }
}

/** Box accessor suffix: scalars stored unboxed, ref kinds as pointers. */
export function boxAccess(t: IrType): "f64" | "bool" | "ref" {
  // procStream is a scalar (the stream's fd double — boxKindC agrees with
  // SCR_BOX_F64), so its captures ride the f64 slot like any number.
  return t.kind === "f64" || t.kind === "date" || t.kind === "procStream" ? "f64" : t.kind === "bool" ? "bool" : "ref";
}

/** C function-pointer cast for calling through a closure: the callee
 * receives its own ScrClosure first, then the declared params. */
export function cFnPtrCast(ft: IrType & { kind: "func" }): string {
  const params = ["ScrClosure *", ...ft.params.map((p) => cType(p).trim())].join(", ");
  return `(${cType(ft.ret).trim()} (*)(${params}))`;
}

/** The runtime's element-kind tag for an array's element type. Record/
 * object/union elements are SCR_ELEM_REF (void* slots + per-array RC entry
 * points); array elements answer SCR_ELEM_ARR here, but a CYCLE-CAPABLE
 * inner array rides SCR_ELEM_REF instead so the outer array's trace can
 * reach it — that answer needs emitter state, so construction goes through
 * CEmitter.arrNewC, which overrides this for traced-array elements. */
export function elemKindC(elem: IrType): string {
  switch (elem.kind) {
    case "f64":
      return "SCR_ELEM_F64";
    case "bool":
      return "SCR_ELEM_BOOL";
    case "string":
      return "SCR_ELEM_STR";
    case "array":
      return "SCR_ELEM_ARR";
    case "bytes":
      return "SCR_ELEM_BYTES";
    case "record":
    case "object":
    case "union":
    // Island handles are ordinary refcounted pointers (scr_jsval_retain/
    // release adapters) — `any[]` under --dynamic is a native array of
    // handles, one element per island value.
    case "jsval":
    // Spawned child handles (ChildProcess[] — the running-apps list):
    // ordinary refcounted pointers, no trace (they drop their closures at
    // reap, so never part of a cycle).
    case "child":
    // Server handles (ProxyServer[] — the [...set] drain of the auxiliary
    // registries): same refcounted-pointer story; listeners drop at close,
    // so a handle-in-array cycle is temporary like child's.
    case "netServer":
    // Symbols (symbol[] — heterogeneous sentinel lists): refcounted
    // identity pointers holding only strings — no trace, no cycles ever.
    case "symbol":
    // Class objects ((typeof Shape)[] — the registry idiom): immortal
    // statics behind no-op RC adapters — no trace, no cycles ever;
    // indexOf/includes/=== are the REF kind's pointer identity, exactly
    // JS class identity.
    case "classval":
      return "SCR_ELEM_REF";
    // Closures: refcounted, cycle-headered (captures can reach back
    // through boxes), scr_closure_* `_v` adapters + scr_closure_trace_v.
    // Identity semantics (indexOf/includes/===) are the REF kind's
    // pointer identity — exactly JS function identity.
    case "func":
      return "SCR_ELEM_REF";
    case "map":
    case "set":
    case "regex":
    case "date":
    case "url":
    case "searchParams":
    case "stats":
    case "fileHandle":
    case "spawnRes":
    case "netSocket":
    case "http2Session":
    case "http2Stream":
    case "dgramSocket":
    case "midiInput":
    case "midiOutput":
    case "testCtx":
    case "httpReq":
    case "httpRes":
    case "httpClientReq":
    case "secureCtx":
    case "fsWatcher":
    case "childStream":
    case "procStream":
    case "dyn":
    case "caught":
    case "promise":
    case "generator":
    case "undefinedT":
    case "nullT":
      throw new Error(`emitter bug: array of ${elem.kind} (frontend rejects these)`);
    case "void":
      throw new Error("emitter bug: array of void");
    default: {
      const _exhaustive: never = elem;
      void _exhaustive;
      throw new Error("unreachable");
    }
  }
}

/** The runtime's element-kind tag for a bytes (typed array) type. */
export function bytesElemKindC(elem: "u8" | "u32" | "i32" | "f32"): string {
  return elem === "u8" ? "SCR_BYTES_U8" : elem === "u32" ? "SCR_BYTES_U32" : elem === "i32" ? "SCR_BYTES_I32" : "SCR_BYTES_F32";
}

/** The runtime's ScrBytesNumKind tag + littleEndian flag per readNum/
 * writeNum kind token (the strLit args[0] the frontend mints). The
 * variable-width family's tokens map to sign + endian flags instead. */
export const BYTES_NUM_KIND_C: Record<string, { kind: string; le: boolean } | undefined> = {
  u8: { kind: "SCR_BN_U8", le: false },
  i8: { kind: "SCR_BN_I8", le: false },
  u16be: { kind: "SCR_BN_U16", le: false },
  u16le: { kind: "SCR_BN_U16", le: true },
  i16be: { kind: "SCR_BN_I16", le: false },
  i16le: { kind: "SCR_BN_I16", le: true },
  u32be: { kind: "SCR_BN_U32", le: false },
  u32le: { kind: "SCR_BN_U32", le: true },
  i32be: { kind: "SCR_BN_I32", le: false },
  i32le: { kind: "SCR_BN_I32", le: true },
  f32be: { kind: "SCR_BN_F32", le: false },
  f32le: { kind: "SCR_BN_F32", le: true },
  f64be: { kind: "SCR_BN_F64", le: false },
  f64le: { kind: "SCR_BN_F64", le: true },
};

/** The variable-width (read/writeUIntLE-style) kind tokens: sign + endian. */
export const BYTES_NUM_VAR_C: Record<string, { sign: boolean; le: boolean } | undefined> = {
  ube: { sign: false, le: false },
  ule: { sign: false, le: true },
  ibe: { sign: true, le: false },
  ile: { sign: true, le: true },
};

/** The runtime's ScrDataViewGet tag per dvGet* bytesIntrinsic method. */
export const DV_GET_KIND_C: Record<string, string> = {
  dvGetUint8: "SCR_DV_U8",
  dvGetInt8: "SCR_DV_I8",
  dvGetUint16: "SCR_DV_U16",
  dvGetInt16: "SCR_DV_I16",
  dvGetUint32: "SCR_DV_U32",
  dvGetInt32: "SCR_DV_I32",
  dvGetFloat32: "SCR_DV_F32",
  dvGetFloat64: "SCR_DV_F64",
  dvGetBigUint64Number: "SCR_DV_BIGU64",
  dvGetBigInt64Number: "SCR_DV_BIGI64",
};

/** The runtime's ScrDataViewGet tag per dvSet* bytesIntrinsic method (the
 * setters reuse the getter kinds; no BIG setters exist). */
export const DV_SET_KIND_C: Record<string, string> = {
  dvSetUint8: "SCR_DV_U8",
  dvSetInt8: "SCR_DV_I8",
  dvSetUint16: "SCR_DV_U16",
  dvSetInt16: "SCR_DV_I16",
  dvSetUint32: "SCR_DV_U32",
  dvSetInt32: "SCR_DV_I32",
  dvSetFloat32: "SCR_DV_F32",
  dvSetFloat64: "SCR_DV_F64",
};

/** Runtime accessor suffix for an element type: arrays store f64 and bool
 * unboxed and everything refcounted as a pointer (`_ref`). */
export function elemAccess(elem: IrType): "f64" | "bool" | "ref" {
  return elem.kind === "f64" ? "f64" : elem.kind === "bool" ? "bool" : "ref";
}

/** Runtime suffix for a map's KEY kind (f64 with SameValueZero, or string
 * content) — the first suffix of the scr_map_* two-suffix family. */
export function mapKeyAccess(key: IrType): "f64" | "str" | "ref" {
  if (key.kind === "f64") return "f64";
  if (key.kind === "string") return "str";
  // Handle-kind SET elements (identity hashing — isSupportedSetElem);
  // Map keys proper stay f64/string.
  if (key.kind === "netServer" || key.kind === "symbol") return "ref";
  throw new Error(`emitter bug: map key of ${key.kind} (frontend rejects these)`);
}

/** The runtime's key-kind/value-kind tags for scr_map_new. */
export function mapKeyKindC(key: IrType): string {
  const acc = mapKeyAccess(key);
  return acc === "str" ? "SCR_MAP_KEY_STR" : acc === "ref" ? "SCR_MAP_KEY_REF" : "SCR_MAP_KEY_F64";
}

export function mapValKindC(value: IrType): string {
  return value.kind === "f64"
    ? "SCR_MAP_VAL_F64"
    : value.kind === "bool"
      ? "SCR_MAP_VAL_BOOL"
      : "SCR_MAP_VAL_REF";
}

/** UTF-8 bytes as an unambiguous C string literal (octal escapes are always
 * three digits, so a following digit can never extend them — unlike \xHH). */
export function cStringLiteral(bytes: Buffer): string {
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    // '?' escapes to defuse TRIGRAPHS: under -std=c11 the preprocessor
    // rewrites `??=` (and the other eight `??x` sequences) INSIDE string
    // literals — an embedded JS `wasmBinaryFile ??= f()` would reach the
    // engine as `wasmBinaryFile #` and die as a SyntaxError. `\?` is
    // standard C, exactly for this.
    else if (b === 0x3f) out += "\\?";
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += "\\" + b.toString(8).padStart(3, "0");
  }
  return out + '"';
}

/** JS shortest-roundtrip decimal re-parses to the identical double in C
 * (strtod is correctly rounded), so String(value) is a faithful C literal. */
export function cNumberLiteral(value: number): string {
  // ±Infinity and NaN numLits are real (the globals `Infinity`/`NaN`); C
  // spells them with math.h's INFINITY/NAN macros (the emitted unit always
  // includes math.h).
  if (value === Infinity) return "INFINITY";
  if (value === -Infinity) return "-INFINITY";
  if (Number.isNaN(value)) return "NAN";
  if (Object.is(value, -0)) return "-0.0"; // String(-0) is "0", which would lose the sign
  const text = String(value);
  // Integral shortest-roundtrip text ("118059162071741140000") would be a
  // C INTEGER literal — invalid beyond unsigned long long's range, and in
  // [2^63, 2^64) clang's unsigned-interpretation extension would let a
  // NEGATED literal wrap modulo 2^64, a silent wrong value; the ".0" keeps
  // every numLit a double literal (decimal parsing is correctly rounded
  // either way).
  return /[.eE]/.test(text) ? text : text + ".0";
}

/** `<type> <name>` with pointer types spaced C-style (`ScrStr *x`). */
export function cDecl(type: IrType, name: string): string {
  const t = cType(type);
  return t.endsWith("*") ? t + name : `${t} ${name}`;
}
