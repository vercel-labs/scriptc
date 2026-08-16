/* IR → LLVM IR text (.ll). The LLVM backend consumes the SAME in-memory
 * IrModule the C backend does (never the JSON dump — see the -0 lesson in
 * the survey) and produces a textual module that rides compileC's
 * program-TU seat: clang compiles .ll on the exact command line that
 * compiles the .c, linking the same scr_* runtime with the same C ABI.
 *
 * Phase 1 was the TRIVIAL TIER: f64/bool/string locals and params, the
 * scalar operator set, structured control flow, direct calls, interned
 * string literals, and the console protocol. Phase 2 adds the VOLUME
 * TIER: module globals and locals of every in-tier ref kind (arrays,
 * record shapes, unions, function values/closures), the full array and
 * string intrinsic surfaces, per-record-shape RC helpers (cycle headers
 * included — the C emitter's fixpoint, ported in shapes.ts), tagged-union
 * construction/narrowing/equality with interned immortal unit instances,
 * capture boxes and the closure calling convention, switch/for-of
 * lowering, and the non-throwing slice of the libCall table. EVERYTHING
 * ELSE REFUSES loudly at the first unhandled node (LlvmUnsupportedError
 * naming the kind) — this backend never guesses and never emits wrong
 * code for a construct it does not model. compile() surfaces the refusal
 * as diagnostic SC3001.
 *
 * RC ownership discipline: the frame/scope release-point machinery is
 * ported from CEmitter (docs/ir.md) — every refcounted temp holds an owned
 * +1 reference; varDecl/assign/return/call-argument MOVE that ownership;
 * each statement releases its remaining refcounted temps when it ends;
 * each scope releases the refcounted locals declared in it when it exits;
 * callees own their params; return/break/continue release everything the
 * jump bypasses (releaseForJump). Releases are type-directed through
 * shapes.ts (the releaseCallC table's LLVM twin); frame entries can be
 * SLOT-based (the entry names a pointer whose CURRENT value releases —
 * conditional results like optional chains need that indirection).
 *
 * Exceptions (phase 4): the pending-flag unwind protocol, ported from the
 * C emitter. `throw` moves its payload into the runtime's exception cell
 * (scr_throw_*) and unwinds; after every call that can raise (per the
 * SAME computeMayThrow analysis the C backend runs) a pending check tests
 * scr_exc_pending() and unwinds — releasing frames/scopes down to the
 * innermost try handler's depths and branching to its label, or releasing
 * everything and returning a dummy value (never read: callers of a
 * may-throw function test the flag before using the result). No
 * setjmp/longjmp: longjmp would skip the emitted RC releases. try/catch
 * follows emit-stmts.ts's shape exactly — a compile-time tryStack entry
 * per region, the catch block taking the exception (scr_exc_take into the
 * binding's snapshot box, or scr_exc_clear for the bindingless form), the
 * finally body emitted once per path (normal, exception-with-stash,
 * pending-return) with fresh temps each time. Catch bindings ride
 * ScrCaught snapshot boxes (caughtTest/caughtNarrow/caughtCheck read
 * them); TDZ reads test the box's payload slot and throw Node's
 * ReferenceError. main() gains the uncaught epilogue when the entry
 * function may throw.
 *
 * The dyn surface (phase 5): ScrDyn dyn values are in the tier — dyn.ts
 * ports emit-walkers.ts's dyn slice (match/check/toDyn walkers, the
 * String(unknown)/caught→dyn/keyed-read singletons, the checked-dynamic
 * function boundary's thunk/box/adapter triple) and the emitter lowers
 * the dyn expression kinds (dynFrom/dynCall/dynInvoke/dynTest/dynKeyGet/
 * dynCheck/destructuring), the JSON.parse family, dyn record fields and
 * overflow maps, dyn capture boxes, and generator unknown channels.
 * The island surface (jsval/jsExit and embedded npm tables) is in the
 * tier too; the module text and resolution tables use the same compressed,
 * lazy-inflate representation as the C debugging backend.
 */
import { deflateRawSync } from "node:zlib";
import type {
  IrBytesElem,
  IrExpr,
  IrFfiCallbackParam,
  IrFfiCallbackParamClass,
  IrFfiImport,
  IrFfiReleaseParam,
  IrFfiReturnClass,
  IrFfiValueParamClass,
  IrFunction,
  IrGlobal,
  IrLocal,
  IrModule,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/nodes.js";
import { canMarshalFuncIntoIsland, CAUGHT, DYN, F64, ffiCallbackType, islandCallbackRet, islandPromisePayloadTag, isFfiCallbackParam, isFfiContextParam, isFfiReleaseParam, isRefCounted, isUnitType, MAY_THROW_LIB_FNS, moduleEmbedsBuiltin, moduleEmbedsCompressedNpm, moduleUsesDynInvoke, moduleUsesFetch, moduleUsesFsWatch, moduleUsesHttpServer, moduleUsesNet, moduleUsesNodeTest, moduleUsesProcessEvents, moduleUsesStream, moduleUsesTls, moduleUsesTlsCa, NPM_COMPRESS_MIN, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, STRING, typeEquals, typeKey, VOID } from "../../ir/nodes.js";
import { matchIntegerBytesForLoop } from "../../ir/integer-loops.js";
import { allocateFfiCallbackAdapters, type FfiCallbackAdapter } from "../ffi-callbacks.js";
import { computeMayThrow } from "../emission/may-throw.js";
import { mangleArgPack, mangleAsyncSpawn, mangleClassNew, mangleClassObj, mangleClassRetain, mangleFnClosure, mangleFunction, mangleGenDrop, mangleGenResThunk, mangleGenSpawn, mangleGlobal, mangleLocal, mangleRecordNew, mangleRecordStruct, mangleResolveThunk, mangleTrampoline, mangleVtStruct, mangleWrapper } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import {
  buildClassGraph,
  classFieldIndex,
  classStructSym,
  emitClassObjDefs,
  emitClassShapes,
  type LlClassMeta,
} from "./classes.js";
import { DK, LlDyn } from "./dyn.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import { LlWalkers } from "./walkers.js";

interface LlStreamTypedRefAdapter {
  snapshot: string;
  commit: string;
}

interface LlStreamTypedRefContext {
  prefix: string;
  adapters: Map<string, LlStreamTypedRefAdapter>;
}

function ffiNativeTypeLl(
  cls: IrFfiCallbackParamClass | IrFfiValueParamClass | IrFfiReturnClass,
): string {
  switch (cls) {
    case "f64":
      return "double";
    case "bool":
    case "u8":
      return "i8";
    case "u32":
    case "i32":
      return "i32";
    case "cstring":
      return "ptr";
    case "string":
    case "bytes":
      throw new Error(`llvm emitter bug: span class '${cls}' has no scalar LLVM type`);
    case "void":
      return "void";
  }
}

function ffiCallbackDummyLl(callback: IrFfiCallbackParam["callback"]): string {
  switch (callback.returns) {
    case "void":
      return "void";
    case "f64":
      return "double 0.0";
    case "bool":
    case "u8":
      return "i8 0";
    case "u32":
    case "i32":
      return "i32 0";
  }
}
import {
  arrNewCall,
  boxAccess,
  boxNewCall,
  computeTraced,
  elemAccess,
  emitRecordShapes,
  FN_ATTRS,
  llFieldType,
  mapKeyAccess,
  mapKeyKindNum,
  mapValKindNum,
  releaseSym,
  retainSym,
  traceAdapter,
  traceArg,
  vAdapters,
} from "./shapes.js";

export { LlvmUnsupportedError } from "./unsupported.js";

/** An emitted value: an LLVM value string (SSA name or immediate) plus its
 * IR type — frames track these so releases stay type-directed, exactly the
 * CEmitter Temp shape. `slot` entries name a POINTER instead: the release
 * loads the slot's current value first (conditional results — optional
 * chains — park their ownership in a slot). */
interface LlValue {
  name: string;
  type: IrType;
  slot?: boolean;
}

/** A scope entry: a refcounted local held in an alloca slot — releases
 * load the slot's CURRENT value first (the LLVM analogue of the C
 * emitter's release-by-variable-name). `boxed` locals hold their capture
 * BOX in the slot; the box releases (and the box frees its contents). */
interface LlScopeEntry {
  slot: string;
  type: IrType;
  boxed?: boolean;
}

export interface LlvmTargetOptions {
  /** Pointer width of the target C ABI. Native targets are 64-bit today. */
  pointerBits?: 32 | 64;
  /** Select the WASI libc entry-point convention. */
  wasi?: boolean;
}

export function emitLlvmModule(mod: IrModule, options: LlvmTargetOptions = {}): string {
  return new LlEmitter(mod, options).emit();
}

/** Exact double literal: LLVM's 16-digit hex form round-trips every f64
 * bit pattern (−0 and the full denormal range included). */
function f64Lit(n: number): string {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n);
  return `0x${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const F64_INF = f64Lit(Infinity);

/** LLVM c"..." payload for a UTF-8 literal, NUL-terminated like the C
 * emitter's flexible-array-member initializer. */
function llBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    s +=
      b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c
        ? String.fromCharCode(b)
        : `\\${b.toString(16).padStart(2, "0").toUpperCase()}`;
  }
  return `${s}\\00`;
}

function llStrBytes(text: string): string {
  return llBytes(Buffer.from(text, "utf8"));
}

/** The non-throwing libCall slice the tier claims: IrLibFn → runtime
 * symbol, called generically (LLVM arg/result types derive from the call
 * site's IR types, which is exactly the contract the C prototypes pin).
 * Throwing members (MAY_THROW_LIB_FNS) and everything unlisted refuse by
 * name. */
const LIB_FN_SYMS: Record<string, string> = {
  "util.parseArgs": "scr_util_parse_args",
  "math.maxArr": "scr_math_max_arr",
  "math.minArr": "scr_math_min_arr",
  "math.min": "scr_math_min",
  "math.max": "scr_math_max",
  "math.random": "scr_math_random",
  "num.parseInt": "scr_parse_int",
  "num.parseFloat": "scr_parse_float",
  "num.fromString": "scr_string_to_number",
  "math.round": "scr_math_round",
  // decodeUriComponent is NOT here: it throws (MAY_THROW_LIB_FNS), so it
  // refuses by name like the rest of the throwing tier.
  "str.encodeUriComponent": "scr_str_encode_uri_component",
  // DOMException: construction and the read surface never throw; the
  // WebIDL clone's option validation throws (may-throw pending check).
  "error.newDom": "scr_domex_new",
  "error.domCode": "scr_domex_code",
  "error.domHasCause": "scr_domex_has_cause",
  "error.domCause": "scr_domex_cause",
  "error.domClone": "scr_domex_clone",
  "dyn.errInstanceof": "scr_dyn_err_instanceof",
  "num.toExponential": "scr_num_to_exponential",
  "num.toFixed0": "scr_num_to_fixed0",
  "num.toFixed": "scr_num_to_fixed",
  "num.sameValue": "scr_num_same_value",
  "intl.numFormatEnUs": "scr_intl_num_format_en_us",
  "number.isFinite": "scr_num_is_finite",
  "number.isNaN": "scr_num_is_nan",
  "number.isInteger": "scr_num_is_integer",
  "number.isSafeInteger": "scr_num_is_safe_integer",
  "string.lastIndexOf": "scr_str_last_index_of",
  "string.raw": "scr_str_raw",
  "path.join": "scr_path_join",
  "path.resolve": "scr_path_resolve",
  "path.normalize": "scr_path_normalize",
  "path.dirname": "scr_path_dirname",
  "path.basename": "scr_path_basename",
  "path.extname": "scr_path_extname",
  "path.isAbsolute": "scr_path_is_absolute",
  "path.relative": "scr_path_relative",
  "path.toNamespacedPath": "scr_path_to_namespaced_path",
  "path.win32Join": "scr_path_win32_join",
  "path.win32Resolve": "scr_path_win32_resolve",
  "path.win32Normalize": "scr_path_win32_normalize",
  "path.win32Dirname": "scr_path_win32_dirname",
  "path.win32Basename": "scr_path_win32_basename",
  "path.win32Extname": "scr_path_win32_extname",
  "path.win32IsAbsolute": "scr_path_win32_is_absolute",
  "path.win32Relative": "scr_path_win32_relative",
  "path.win32ToNamespacedPath": "scr_path_win32_to_namespaced_path",
  "os.homedir": "scr_os_homedir",
  "os.type": "scr_os_type",
  "os.totalmem": "scr_os_totalmem",
  "os.release": "scr_os_release",
  "os.userName": "scr_os_user_name",
  "os.userShell": "scr_os_user_shell",
  "os.userHomedir": "scr_os_user_homedir",
  "os.tmpdir": "scr_os_tmpdir",
  "process.argv": "scr_process_argv",
  "process.platform": "scr_process_platform",
  "process.cwd": "scr_process_cwd",
  "process.pid": "scr_process_pid",
  "process.getuid": "scr_process_getuid",
  "process.getgid": "scr_process_getgid",
  "process.execPath": "scr_process_exec_path",
  "process.arch": "scr_process_arch",
  "process.versionsNode": "scr_process_versions_node",
  "process.versionsOpenssl": "scr_process_versions_openssl",
  "process.umask": "scr_process_umask",
  "process.uptime": "scr_process_uptime",
  "perf.now": "scr_perf_now",
  "process.availableMemory": "scr_available_memory",
  "process.constrainedMemory": "scr_constrained_memory",
  "process.cpuUser": "scr_cpu_user",
  "process.cpuSystem": "scr_cpu_system",
  "process.cpuUserDiff": "scr_cpu_user_diff",
  "process.cpuSystemDiff": "scr_cpu_system_diff",
  "process.threadCpuUser": "scr_thread_cpu_user",
  "process.threadCpuSystem": "scr_thread_cpu_system",
  "process.threadCpuUserDiff": "scr_thread_cpu_user_diff",
  "process.threadCpuSystemDiff": "scr_thread_cpu_system_diff",
  "process.rusage": "scr_process_rusage",
  "process.activeResources": "scr_active_resources",
  "process.exiting": "scr_process_exiting",
  "process.exit": "scr_process_exit",
  "process.envSet": "scr_env_set",
  "process.envUnset": "scr_env_unset",
  "process.envPairs": "scr_env_pairs",
  "process.stdoutWrite": "scr_process_stdout_write",
  "process.stderrWrite": "scr_process_stderr_write",
  "process.isTTY": "scr_process_is_tty",
  "date.now": "scr_date_now",
  "date.newNow": "scr_date_now",
  "date.newMs": "scr_date_new_ms",
  "date.newString": "scr_date_parse_get_time",
  "date.getTime": "scr_date_get_time",
  "date.valueOf": "scr_date_get_time",
  "date.parseGetTime": "scr_date_parse_get_time",
  "date.utc": "scr_date_utc",
  "date.getFullYear": "scr_date_get_full_year_local",
  "date.getUTCFullYear": "scr_date_get_full_year_utc",
  "date.getMonth": "scr_date_get_month_local",
  "date.getUTCMonth": "scr_date_get_month_utc",
  "date.getDate": "scr_date_get_date_local",
  "date.getUTCDate": "scr_date_get_date_utc",
  "date.getDay": "scr_date_get_day_local",
  "date.getUTCDay": "scr_date_get_day_utc",
  "date.getHours": "scr_date_get_hours_local",
  "date.getUTCHours": "scr_date_get_hours_utc",
  "date.getMinutes": "scr_date_get_minutes_local",
  "date.getUTCMinutes": "scr_date_get_minutes_utc",
  "date.getSeconds": "scr_date_get_seconds_local",
  "date.getUTCSeconds": "scr_date_get_seconds_utc",
  "date.getMilliseconds": "scr_date_get_milliseconds",
  "date.getUTCMilliseconds": "scr_date_get_milliseconds",
  "date.getTimezoneOffset": "scr_date_get_timezone_offset",
  "fs.existsSync": "scr_fs_exists",
  // ── the throwing slice (MAY_THROW_LIB_FNS members): the generic path
  // emits the standard pending check after each — emit-exprs.ts's finish.
  "process.cpuPrevValidate": "scr_cpu_prev_validate",
  "date.toISOString": "scr_date_to_iso",
  "date.toISOStringValue": "scr_date_to_iso",
  "process.chdir": "scr_process_chdir",
  "fs.writeFileSync": "scr_fs_write_file",
  "fs.appendFileSync": "scr_fs_append_file",
  "fs.mkdirSync": "scr_fs_mkdir",
  "fs.mkdirRecursiveSync": "scr_fs_mkdir_recursive",
  "fs.mkdtempSync": "scr_fs_mkdtemp",
  "fs.rmSync": "scr_fs_rm",
  "fs.rmOptsSync": "scr_fs_rm_opts",
  "fs.rmRetrySync": "scr_fs_rm_opts_retry",
  "fs.rmdirSync": "scr_fs_rmdir",
  "fs.readdirSync": "scr_fs_readdir",
  "fs.realpathSync": "scr_fs_realpath",
  "fs.unlinkSync": "scr_fs_unlink",
  "fs.chmodSync": "scr_fs_chmod",
  "fs.copyFileSync": "scr_fs_copyfile",
  "fs.renameSync": "scr_fs_rename",
  "fs.accessSync": "scr_fs_access",
  // node:assert (scr_assert.c): all args borrowed; failures throw the
  // catchable AssertionError. The never-throwing members ride along.
  "assert.ok": "scr_assert_ok",
  "assert.eqF64": "scr_assert_eq_f64",
  "assert.eqStr": "scr_assert_eq_str",
  "assert.eqBool": "scr_assert_eq_bool",
  "assert.eqSym": "scr_assert_eq_sym",
  "assert.eqDyn": "scr_assert_eq_dyn",
  "assert.deepResult": "scr_assert_deep_result",
  "assert.sameValue": "scr_assert_same_value_f64",
  "assert.deqEnter": "scr_assert_deq_enter",
  "assert.deqLeave": "scr_assert_deq_leave",
  "assert.match": "scr_assert_match",
  "assert.throwsNone": "scr_assert_throws_none",
  "assert.throwsMismatch": "scr_assert_throws_mismatch",
  "assert.throwsRegex": "scr_assert_throws_regex",
  "assert.shapeBegin": "scr_assert_shape_begin",
  // shapeStr/shapeRe take an int key — special-cased (fptosi), not generic.
  "assert.shapeEnd": "scr_assert_shape_end",
  "assert.regexErrTest": "scr_assert_regex_err_test",
  "assert.unwantedRejection": "scr_assert_unwanted_rejection",
  "assert.ifErrorErr": "scr_assert_iferror_err",
  "assert.ifErrorF64": "scr_assert_iferror_f64",
  "assert.ifErrorStr": "scr_assert_iferror_str",
  "assert.ifErrorBool": "scr_assert_iferror_bool",
  "assert.ifErrorDyn": "scr_assert_iferror_dyn",
  "assert.refEqFn": "scr_assert_ref_eq_fn",
  "assert.refEqBytes": "scr_assert_ref_eq_bytes",
  "assert.bytesDeepEq": "scr_assert_bytes_deep_eq",
  // The Buffer statics and bytes-adjacent members (scr_bytes.c /
  // scr_bytes_io.c / scr_zlib.c / scr_crypto): fromStr decodes Node-
  // leniently (never throws), concat copies its borrowed list; the sync
  // fs Buffer pair and zlib.inflateSync ride the may-throw check.
  "buffer.fromStr": "scr_bytes_from_str",
  "buffer.concat": "scr_bytes_concat",
  "buffer.concatLen": "scr_bytes_concat_len",
  "buffer.byteLenStr": "scr_bytes_byte_length_str",
  "buffer.isEncoding": "scr_bytes_is_encoding",
  // The checked-dynamic compare/equals validators (scr_bytes_io.c):
  // Node's argument ladders throw catchably (MAY_THROW_LIB_FNS).
  "dyn.toStringCoerce": "scr_dyn_string_coerce_js",
  "buffer.compareChk": "scr_buffer_compare_chk",
  "bytes.equalsChk": "scr_bytes_equals_chk",
  "bytes.compareChk": "scr_bytes_compare_chk",
  "buffer.newStringFail": "scr_buffer_new_string_fail",
  "fs.toUnixTimestamp": "scr_fs_to_unix_timestamp",
  "fs.existsChk": "scr_fs_exists_async",
  "fs.mkdtempSyncChk": "scr_fs_mkdtemp_sync_chk",
  "net.connectAttempt": "scr_net_connect_attempt",
  "fs.lchmodSyncChk": "scr_fs_lchmod_sync_chk",
  "fsp.lchmodChk": "scr_fsp_lchmod_chk",
  "fs.readFileSyncBuf": "scr_fs_read_file_bytes",
  "fs.readFileSyncBytes": "scr_fs_read_file_bytes",
  "fs.writeFileSyncBytes": "scr_fs_write_file_bytes",
  "fs.readFdSyncBytes": "scr_fs_read_fd_bytes",
  // Stats snapshots (scr_lib.c): statSync/lstatSync throw like the other
  // sync fs calls; the getters are pure reads.
  "fs.statSync": "scr_fs_stat",
  "fs.lstatSync": "scr_fs_lstat",
  "fs.openSync": "scr_fs_open",
  "fs.readSync": "scr_fs_read_sync",
  "fs.writeSync": "scr_fs_write_sync",
  "fs.writeStrSync": "scr_fs_write_str_sync",
  "fs.closeSync": "scr_fs_close",
  // string_decoder (scr_bytes.c): stateless helpers over (enc, pending,
  // chunk) — never throw.
  "strdec.write": "scr_strdec_write",
  "strdec.next": "scr_strdec_next",
  "strdec.end": "scr_strdec_end",
  "stats.isFile": "scr_stats_is_file",
  "stats.isDirectory": "scr_stats_is_dir",
  "stats.isSymbolicLink": "scr_stats_is_symlink",
  "stats.size": "scr_stats_size",
  "stats.blocks": "scr_stats_blocks",
  "stats.nlink": "scr_stats_nlink",
  "stats.atimeMs": "scr_stats_atime_ms",
  "stats.mtimeMs": "scr_stats_mtime_ms",
  "text.decode": "scr_text_decode",
  "text.decodeLegacy": "scr_text_decode_legacy",
  "zlib.deflateSync": "scr_zlib_deflate",
  "zlib.inflateSync": "scr_zlib_inflate",
  // The CA-store unit. get/set throw (an unknown type name, a
  // certificate-free set) and take the generic path's pending check.
  "tlsca.root": "scr_tls_ca_root",
  "tlsca.get": "scr_tls_ca_get",
  "tlsca.set": "scr_tls_ca_set_default",
  "crypto.randomBytes": "scr_crypto_random_bytes",
  "crypto.randomBytesToString": "scr_crypto_random_string",
  "crypto.randomUUID": "scr_crypto_random_uuid",
  "crypto.hashDigestStr": "scr_crypto_hash_digest_str",
  "crypto.hashDigestBytes": "scr_crypto_hash_digest_bytes",
  "process.stdoutWriteBytes": "scr_process_stdout_write_bytes",
  "process.stderrWriteBytes": "scr_process_stderr_write_bytes",
  "insp.buffer": "scr_insp_buffer",
  // util.inspect (scr_inspect.c): all args borrowed; string results +1;
  // the begin/entry/key/moreItems/end accumulator drives the emitted
  // container walks. None of these throw.
  "insp.f64": "scr_insp_f64",
  "insp.str": "scr_insp_str",
  "insp.regex": "scr_insp_regex",
  "insp.error": "scr_insp_error",
  "insp.begin": "scr_insp_begin",
  "insp.entry": "scr_insp_entry",
  "insp.key": "scr_insp_key",
  "insp.moreItems": "scr_insp_more_items",
  "insp.end": "scr_insp_end",
  // Circular references over cycle-capable composites (Node's
  // seen/circular machinery — none of these throw; refWrap borrows its
  // string and answers +1).
  "insp.circCheck": "scr_insp_circ_check",
  "insp.seenPush": "scr_insp_seen_push",
  "insp.refWrap": "scr_insp_ref_wrap",
  "insp.circular": "scr_insp_circular",
  // WHATWG URL + URLSearchParams (scr_url.c / scr_url_params.c):
  // constructions +1; url.new, the fileURLToPath pair, the win32
  // pathToFileURL flavor, and sp.fromPairs throw catchably (may-throw).
  "url.new": "scr_url_new",
  "url.protocol": "scr_url_protocol",
  "url.host": "scr_url_host",
  "url.hostname": "scr_url_hostname",
  "url.pathname": "scr_url_pathname",
  "url.href": "scr_url_href",
  "url.search": "scr_url_search",
  "url.searchParams": "scr_url_search_params",
  "url.fileURLToPathUrl": "scr_url_to_path",
  "url.fileURLToPathStr": "scr_url_str_to_path",
  "url.pathToFileURL": "scr_url_from_path",
  "url.pathToFileURLWin32": "scr_url_from_path",
  "sp.new": "scr_sp_new",
  "sp.parse": "scr_sp_parse",
  "sp.copy": "scr_sp_copy",
  "sp.fromPairs": "scr_sp_from_pairs",
  "sp.with": "scr_sp_with",
  "sp.getAll": "scr_sp_get_all",
  "sp.append": "scr_sp_append",
  "sp.set": "scr_sp_set",
  "sp.delete": "scr_sp_delete",
  "sp.deleteValue": "scr_sp_delete_value",
  "sp.has": "scr_sp_has",
  "sp.hasValue": "scr_sp_has_value",
  "sp.sort": "scr_sp_sort",
  "sp.size": "scr_sp_size",
  "sp.toString": "scr_sp_to_string",
  "sp.keyAt": "scr_sp_key_at",
  "sp.valAt": "scr_sp_val_at",
  // node:querystring (scr_qs.c): unescape/stringify are plain generic
  // calls (never throw; string results +1), and escape IS the component
  // encoder (Node's qsEscape set equals encodeURIComponent's) so it emits
  // the always-linked codec. qs.parse is special-cased in emitLibCall
  // (the result dictionary's construction).
  "qs.escape": "scr_str_encode_uri_component",
  "qs.unescape": "scr_qs_unescape",
  "qs.stringify": "scr_qs_stringify",
  // Timer handle bookkeeping (never throws; the comma-shaped chaining
  // forms are special-cased in emitLibCall).
  "timers.hasRef": "scr_timer_has_ref",
  "timers.immediateHasRef": "scr_immediate_has_ref",
  "timers.clearImmediate": "scr_clear_immediate",
  // Process event removals (borrowed callbacks: removal is by pointer
  // identity); registration is special-cased above (ownership moves).
  "process.offSignal": "scr_signal_off",
  "process.offExit": "scr_process_off_exit",
  // child_process (scr_child.c): spawnSync/exec forms are synchronous
  // (execSync/execCapture throw — the may-throw check); handle getters
  // are pure reads. Registration forms are special-cased (moves + per-
  // shape adapters); spawn itself is special-cased for usesTimers.
  "cp.spawnSync": "scr_spawn_sync",
  "cp.spawnSyncOpts": "scr_spawn_sync_opts",
  "cp.spawnSyncStdioStr": "scr_spawn_sync_stdio_str",
  "cp.execSync": "scr_exec_sync",
  "cp.execCapture": "scr_exec_capture",
  "spawnRes.stdout": "scr_spawn_res_stdout",
  "spawnRes.stderr": "scr_spawn_res_stderr",
  "child.killed": "scr_child_killed",
  "child.kill": "scr_child_kill",
  "child.killNum": "scr_child_kill_num",
  "child.unref": "scr_child_unref",
  "procStream.write": "scr_proc_stream_write",
  "process.kill": "scr_process_kill_named",
  "process.killNum": "scr_process_kill",
  // fs.promises (scr_bytes_io.c / scr_lib.c): the promise forms settle
  // instead of throwing — plain generic calls answering a +1 promise.
  // fsp.readFile is NOT here: it carries the ignored encoding argument,
  // so it is special-cased in emitLibCall (the fs.readFileSync pattern).
  "fsp.readFileBytes": "scr_fsp_read_file_bytes",
  "fsp.writeFile": "scr_fsp_write_file",
  "fsp.writeFileMode": "scr_fsp_write_file_mode",
  "fsp.mkdir": "scr_fsp_mkdir",
  "fsp.mkdirMode": "scr_fsp_mkdir_mode",
  "fsp.mkdirRecursive": "scr_fsp_mkdir_recursive",
  "fsp.mkdirRecursiveMode": "scr_fsp_mkdir_recursive_mode",
  "fsp.unlink": "scr_fsp_unlink",
  "fsp.chmod": "scr_fsp_chmod",
  "fsp.rename": "scr_fsp_rename",
  "fsp.readdir": "scr_fsp_readdir",
  "fsp.rm": "scr_fsp_rm",
  "fsp.stat": "scr_fsp_stat",
  "fsp.open": "scr_fsp_open",
  "fileHandle.fd": "scr_file_handle_fd",
  "fileHandle.close": "scr_file_handle_close_promise",
  "fileHandle.readFile": "scr_file_handle_read_file_promise",
  "fileHandle.readFileBytes": "scr_file_handle_read_file_bytes_promise",
  "fileHandle.writeFile": "scr_file_handle_write_file_promise",
  "fileHandle.writeFileBytes": "scr_file_handle_write_file_bytes_promise",
  "fileHandle.stat": "scr_file_handle_stat_promise",
  "sym.new": "scr_sym_new",
  "sym.for": "scr_sym_for",
  "sym.toString": "scr_sym_to_string",
  "error.toString": "scr_error_to_string",
  "class.name": "scr_classobj_name",
  // The dyn (ScrDyn dyn) surface (scr_json.c / scr_dyn_invoke.c):
  // json.parse throws the catchable SyntaxError; keySet/toString/
  // defineProps throw Node's TypeErrors (all in the may-throw seed set —
  // the generic path emits the standard pending check). typeof and the
  // ambient-this read never throw. The fs dyn read is the sync-fs story.
  "fetch.start": "scr_fetch_static",
  "fetch.responseNew": "scr_fetch_response_new",
  "fetch.responseJson": "scr_fetch_response_json",
  "fetch.responseText": "scr_fetch_response_text",
  "fetch.responseBytes": "scr_fetch_response_bytes",
  "fetch.abortControllerNew": "scr_fetch_abort_controller_new",
  "fetch.abortTimeout": "scr_fetch_abort_timeout",
  "fetch.abortNow": "scr_fetch_abort_now",
  "fetch.abortAny": "scr_fetch_abort_any",
  "fetch.streamNew": "scr_fetch_stream_new",
  "fetch.streamFrom": "scr_fetch_stream_from",
  "fetch.readerRead": "scr_fetch_reader_read",
  "json.parse": "scr_json_parse",
  "dyn.keySet": "scr_dyn_key_set",
  "dyn.iterPack": "scr_dyn_iter_pack",
  "dyn.arrLen": "scr_dyn_arr_len",
  "dyn.arrAt": "scr_dyn_arr_at",
  "dyn.hasKey": "scr_dyn_has_key",
  "dyn.defineProps": "scr_dyn_define_props",
  "dyn.typeof": "scr_dyn_typeof",
  "dyn.toString": "scr_dyn_to_string_method",
  "dyn.this": "scr_dyn_this_get",
  "insp.dyn": "scr_insp_dyn",
  "insp.dynS": "scr_insp_dyn_s",
  "fs.readFileSyncDyn": "scr_fs_read_file_sync_dyn",
  // Loose generic-shaped stragglers the burn-down surfaced alongside the
  // dyn head: the x509 PEM walks and stdin raw-mode throw catchably (the
  // may-throw seed set); the mode-carrying fs sync forms are the plain
  // sync-fs story; stdinDestroy is a deliberate no-op; atomics.wait is
  // the static sleep.
  "crypto.x509Fingerprint": "scr_crypto_x509_fingerprint",
  "crypto.x509FingerprintStr": "scr_crypto_x509_fingerprint_str",
  "crypto.x509ValidFrom": "scr_crypto_x509_valid_from",
  "crypto.x509ValidFromStr": "scr_crypto_x509_valid_from_str",
  "crypto.x509ValidTo": "scr_crypto_x509_valid_to",
  "crypto.x509ValidToStr": "scr_crypto_x509_valid_to_str",
  "fs.writeFileModeSync": "scr_fs_write_file_mode",
  "fs.chownSync": "scr_fs_chown",
  "fs.mkdirModeSync": "scr_fs_mkdir_mode",
  "fs.mkdirRecursiveModeSync": "scr_fs_mkdir_recursive_mode",
  "atomics.wait": "scr_atomics_wait",
  "process.stdinDestroy": "scr_process_stdin_destroy",
  "process.stdinSetRawMode": "scr_process_stdin_set_raw_mode",
  // node:events EventEmitter (scr_events_emitter.c): receivers borrowed,
  // chaining forms answer the receiver +1 (Node's `return this`). The
  // registration/removal family and emitError are may-throw (meta
  // listeners run inside; unhandled 'error' throws its payload) — the
  // generic path's pending check covers them. on/onDyn and the emit
  // family have non-generic shapes (adapter/variadic) — special-cased in
  // emitLibCall.
  "emitter.new": "scr_emitter_new",
  "emitter.ctor": "scr_emitter_init",
  "emitter.off": "scr_emitter_off",
  "emitter.offDyn": "scr_emitter_off_dyn",
  "emitter.checkListener": "scr_emitter_check_listener",
  "emitter.removeAll": "scr_emitter_remove_all",
  "emitter.emitError": "scr_emitter_emit_error",
  "emitter.count": "scr_emitter_listener_count",
  "emitter.countFn": "scr_emitter_listener_count_fn",
  "emitter.names": "scr_emitter_event_names",
  "emitter.listeners": "scr_emitter_listeners",
  "emitter.setMax": "scr_emitter_set_max",
  "emitter.setMaxChk": "scr_emitter_set_max_chk",
  "emitter.setDefaultMaxChk": "scr_emitter_set_default_max_chk",
  "emitter.getMax": "scr_emitter_get_max",
  "emitter.setDefaultMax": "scr_emitter_set_default_max",
  "emitter.getDefaultMax": "scr_emitter_get_default_max",
  // node:stream (scr_stream.c): receivers borrowed, chunks borrowed,
  // chaining forms answer the receiver +1. The throwing members
  // (listeners and option callbacks run synchronously inside) ride the
  // generic pending check; loop liveness rides USES_TIMERS_LIB_FNS.
  "readable.push": "scr_stream_push",
  "readable.pushStr": "scr_stream_push_str",
  "readable.pushStrEnc": "scr_stream_push_str_enc",
  "readable.pushEncoding": "scr_stream_set_push_encoding",
  "readable.pushNull": "scr_stream_push_null",
  "readable.pushDyn": "scr_stream_push_dyn",
  "readable.unshift": "scr_stream_unshift",
  "readable.unshiftStr": "scr_stream_unshift_str",
  "readable.pause": "scr_stream_pause",
  "readable.resume": "scr_stream_resume",
  "readable.isPaused": "scr_stream_is_paused",
  "readable.setEncoding": "scr_stream_set_encoding",
  "readable.nextChunk": "scr_stream_next_chunk",
  "readable.nextChunkDyn": "scr_stream_next_chunk_dyn",
  "readable.fromArr": "scr_stream_from_arr",
  "readable.pipe": "scr_stream_pipe",
  "writable.cork": "scr_stream_cork",
  "writable.uncork": "scr_stream_uncork",
  "stream.destroyErr": "scr_stream_destroy",
  "readable.newDyn": "scr_stream_new_readable_dyn",
  "writable.newDyn": "scr_stream_new_writable_dyn",
  "duplex.newDyn": "scr_stream_new_duplex_dyn",
  "transform.newDyn": "scr_stream_new_transform_dyn",
  "passthrough.newDyn": "scr_stream_new_passthrough_dyn",
  // node:net + node:http (scr_net.c / scr_http.c): receivers borrowed;
  // writes borrow their payloads; the *Dyn chunk forms and setEncoding
  // are may-throw (generic pending check). Listener registrations and
  // the client request forms have non-generic shapes — special-cased.
  "net.serverPort": "scr_net_server_port",
  "net.sockWrite": "scr_net_sock_write_str",
  "net.sockWriteBytes": "scr_net_sock_write_bytes",
  "net.sockEnd": "scr_net_sock_end",
  "net.sockEndStr": "scr_net_sock_end_str",
  "net.sockEndBytes": "scr_net_sock_end_bytes",
  "net.sockWriteDyn": "scr_net_sock_write_dynv",
  "net.sockEndDyn": "scr_net_sock_end_dynv",
  "net.sockDestroy": "scr_net_sock_destroy",
  "net.sockPipe": "scr_net_sock_pipe",
  "net.sockDestroyed": "scr_net_sock_destroyed",
  "net.sockWritable": "scr_net_sock_writable",
  "net.sockSetEncoding": "scr_net_sock_set_encoding",
  "net.sockSetTimeout": "scr_net_sock_set_timeout",
  "net.sockUnshift": "scr_net_sock_unshift_bytes",
  "net.sockPause": "scr_net_sock_pause",
  "net.sockResume": "scr_net_sock_resume",
  "net.sockSetNoDelay": "scr_net_sock_set_nodelay",
  "net.sockDestroySoon": "scr_net_sock_destroy_soon",
  "net.sockBytesWritten": "scr_net_sock_bytes_written",
  "net.sockReadable": "scr_net_sock_readable",
  "net.sockPipeRes": "scr_http_sock_pipe_res",
  "net.serverEmitConnection": "scr_net_server_emit_connection",
  "net.getAutoSelTimeout": "scr_net_get_autosel_timeout",
  "net.setAutoSelTimeout": "scr_net_set_autosel_timeout",
  "http.reqUrl": "scr_http_req_url",
  "http.reqMethod": "scr_http_req_method",
  "http.reqSocket": "scr_http_req_socket",
  "http.reqRawHeaders": "scr_http_req_raw_headers",
  "http.reqHeaderPairs": "scr_http_req_header_pairs",
  "http.reqPipeRes": "scr_http_req_pipe_res",
  "http.reqPipeClient": "scr_http_req_pipe_client",
  "http.reqPipeSock": "scr_http_req_pipe_sock",
  "http.reqResume": "scr_http_req_resume",
  "http.reqDestroy": "scr_http_req_destroy",
  "http.reqSetEncoding": "scr_http_req_set_encoding",
  "http.resSetHeader": "scr_http_res_set_header",
  "http.resWriteHead": "scr_http_res_write_head",
  "http.resWriteHeadN": "scr_http_res_write_head_n",
  "http.resWrite": "scr_http_res_write_str",
  "http.resWriteBytes": "scr_http_res_write_bytes",
  "http.resEnd": "scr_http_res_end",
  "http.resEndStr": "scr_http_res_end_str",
  "http.resEndBytes": "scr_http_res_end_bytes",
  "http.resWriteDyn": "scr_http_res_write_dynv",
  "http.resEndDyn": "scr_http_res_end_dynv",
  "http.resHeadersSent": "scr_http_res_headers_sent",
  "http.resDestroy": "scr_http_res_destroy",
  "http.resStatusGet": "scr_http_res_status_get",
  "http.resStatusSet": "scr_http_res_status_set",
  "http.resStatusMsgGet": "scr_http_res_status_msg_get",
  "http.resStatusMsgSet": "scr_http_res_status_msg_set",
  "http.resHasHeader": "scr_http_res_has_header_named",
  "http.resRemoveHeader": "scr_http_res_remove_header",
  "http.resWriteHeadPairs": "scr_http_res_write_head_pairs",
  "http.resWriteHeadDyn": "scr_http_res_write_head_dyn",
  "http.serverJoinDupHeaders": "scr_http_server_join_duplicate_headers",
  "http.serverTimeoutGet": "scr_net_server_timeout_get",
  "http.serverTimeoutSet": "scr_net_server_timeout_set",
  "http.serverTimeoutOptionSet": "scr_net_server_timeout_option_set",
  "http.clientWrite": "scr_http_client_write_str",
  "http.clientWriteBytes": "scr_http_client_write_bytes",
  "http.clientEnd": "scr_http_client_end",
  "http.clientEndStr": "scr_http_client_end_str",
  "http.clientEndBytes": "scr_http_client_end_bytes",
  "http.clientWriteDyn": "scr_http_client_write_dynv",
  "http.clientEndDyn": "scr_http_client_end_dynv",
  "http.clientDestroy": "scr_http_client_destroy",
  "http.clientDestroyed": "scr_http_client_destroyed",
  "http2.streamUndefCall": "scr_http2_stream_undef_call",
  "http.agentNew": "scr_http_agent_new",
  // The island surface (--dynamic): eval/import bridge catchably (the
  // may-throw seed's pending check); importDyn answers an engine promise
  // and never throws itself. insp.jsval throws on composite island
  // values (engine JSON.stringify inside).
  "island.eval": "scr_island_eval",
  "island.import": "scr_jsval_import",
  "island.importDyn": "scr_jsval_import_dyn",
  "insp.jsval": "scr_insp_jsval",
  // timers/promises (+1 promises; the await parks a fiber, so the async
  // loop gate already runs) and diagnostics_channel (scr_dc.c): all
  // generic shapes; the throwing members ride the pending check.
  "tp.setTimeout": "scr_tp_set_timeout",
  "tp.setImmediate": "scr_tp_set_immediate",
  // stream/promises' finished form (+1 promise; may-throw pending check;
  // the pipeline form needs the stream-array compound and emits below).
  "sp.finished": "scr_sp_finished",
  // stream/consumers' promise consumers (+1 promises; may-throw pending
  // check — the 'newListener' meta emit can run user code).
  "sc.text": "scr_sc_text",
  "sc.json": "scr_sc_json",
  "sc.buffer": "scr_sc_buffer",
  "dc.channel": "scr_dc_channel",
  "dc.subscribe": "scr_dc_subscribe",
  "dc.unsubscribe": "scr_dc_unsubscribe",
  "dc.hasSubscribers": "scr_dc_has_subscribers",
  "dc.publish": "scr_dc_publish",
  "dc.chanSubscribe": "scr_dc_chan_subscribe",
  "dc.chanUnsubscribe": "scr_dc_chan_unsubscribe",
  "dc.chanHasSubscribers": "scr_dc_chan_has_subscribers",
  "dc.chanName": "scr_dc_chan_name",
  "str.decodeUriComponent": "scr_str_decode_uri_component",
  // TracingChannel (scr_dc.c): registry handles are plain doubles; the
  // subscribe/trace forms ride the may-throw pending check, and
  // tcTracePromise marks the loop live (USES_TIMERS_LIB_FNS — the
  // reaction fiber needs the loop to drain it).
  "dc.tracingChannel": "scr_dc_tracing_channel",
  "dc.tracingChannelOf": "scr_dc_tracing_channel_of",
  "dc.tcChannel": "scr_dc_tc_channel",
  "dc.tcHasSubscribers": "scr_dc_tc_has_subscribers",
  "dc.tcSubscribe": "scr_dc_tc_subscribe",
  "dc.tcUnsubscribe": "scr_dc_tc_unsubscribe",
  "dc.tcTraceSync": "scr_dc_tc_trace_sync",
  "dc.tcTraceCallback": "scr_dc_tc_trace_callback",
  "dc.tcTracePromise": "scr_dc_tc_trace_promise",
  // AsyncLocalStorage (scr_async_dyn.c): store ids are doubles, values
  // ride the checked-dynamic tree; run/exitRun dispatch user callbacks (may-throw).
  // The dc bind-store trio shares the als id space.
  "als.new": "scr_als_new",
  "als.get": "scr_als_get",
  "als.run": "scr_als_run",
  "als.exitRun": "scr_als_exit_run",
  "als.enterWith": "scr_als_enter_with",
  "als.disable": "scr_als_disable",
  "dc.chanBindStore": "scr_dc_chan_bind_store",
  "dc.chanUnbindStore": "scr_dc_chan_unbind_store",
  "dc.chanRunStores": "scr_dc_chan_run_stores",
  // process warning/rejection events (scr_lib.c / scr_async_dyn.c):
  // dyn listeners are borrowed (the runtime retains its copy);
  // onUnhandledRejection marks the loop live (the checkpoint report
  // dispatches the listeners).
  "process.onWarning": "scr_process_on_warning",
  "process.offWarning": "scr_process_off_warning",
  "process.emitWarning": "scr_process_emit_warning",
  "process.onUnhandledRejection": "scr_process_on_unhandled_rejection",
  "process.offUnhandledRejection": "scr_process_off_unhandled_rejection",
  "process.onRejectionHandled": "scr_process_on_rejection_handled",
  "process.offRejectionHandled": "scr_process_off_rejection_handled",
  // The await lowering's loop hop and the dyn await (both park the
  // current fiber — USES_TIMERS_LIB_FNS marks the loop live).
  "async.hop": "scr_await_hop",
  "async.awaitDyn": "scr_await_dyn_value",
  // encodeURI never throws; the WHATWG base64 globals throw the
  // catchable DOMException InvalidCharacterError (may-throw), and the
  // zero-argument form always throws ERR_MISSING_ARGS.
  "str.encodeUri": "scr_encode_uri",
  "str.atob": "scr_atob",
  "str.btoa": "scr_btoa",
  "str.b64Missing": "scr_b64_missing_arg",
  "regexp.escape": "scr_regexp_escape",
  // The dyn Object walks (throw on nullish receivers), structuredClone
  // (option/DataClone/cycle errors), and new RegExp's eager compile
  // (catchable SyntaxError) — all may-throw generics over the checked-dynamic tree.
  "dyn.objKeys": "scr_dyn_obj_keys",
  "dyn.hasOwn": "scr_dyn_has_own",
  "dyn.assign": "scr_dyn_assign",
  // variadic Object.assign: the source pack (push never throws; the
  // spread flatten throws V8's spread-call TypeErrors) and the final
  // left-to-right copy (ToObject TypeError on a nullish target).
  "dyn.packPush": "scr_dyn_pack_push",
  "dyn.packPushSpread": "scr_dyn_pack_push_spread",
  "dyn.packPushSpreadIter": "scr_dyn_pack_push_spread_iter",
  "dyn.assignAll": "scr_dyn_assign_all",
  "dyn.objCreateNullProto": "scr_dyn_new_obj_null_proto",
  "dyn.objValues": "scr_dyn_obj_values",
  "dyn.objEntries": "scr_dyn_obj_entries",
  "dyn.structuredClone": "scr_structured_clone",
  "dyn.cloneMissing": "scr_structured_clone_missing",
  "dyn.cloneTransferFail": "scr_structured_clone_transfer_fail",
  "regex.new": "scr_regex_new",
  // queueMicrotask's checked-dynamic form (borrowed dyn; a non-function
  // throws synchronously), the minted setImmediate value, and the
  // timers/promises immediate — all mark the loop live.
  "timers.queueMicrotaskDyn": "scr_queue_microtask_dyn",
  "timers.setImmediateFnValue": "scr_set_immediate_dyn_value",
  "timers.immediatePromise": "scr_immediate_promise",
};

/** The canonical option-callback order per stream base — emit-exprs.ts's
 * table: the flags literal names which are PRESENT (bit i = canonical[i]);
 * absent ones pass NULL pairs. */
const STREAM_CANONICAL_CBS: Record<string, ("r" | "w" | "f" | "d" | "t" | "l")[]> = {
  readable: ["r", "d"],
  writable: ["w", "f", "d"],
  duplex: ["r", "w", "f", "d"],
  transform: ["t", "l", "d"],
  passthrough: ["t", "l", "d"],
};

/** Lib functions whose C lowering marks the loop live (E.usesTimers) —
 * the stream/emitter slice of emit-exprs.ts's markings, applied before
 * dispatch so generic and special shapes share one table. */
const USES_TIMERS_LIB_FNS = new Set<string>([
  "fetch.start",
  "fetch.abortTimeout", "fetch.streamNew", "fetch.streamFrom",
  "readable.new", "writable.new", "duplex.new", "transform.new", "passthrough.new",
  "readable.init", "writable.init", "duplex.init", "transform.init", "passthrough.init",
  "readable.newDyn", "writable.newDyn", "duplex.newDyn", "transform.newDyn", "passthrough.newDyn",
  "readable.initDyn", "writable.initDyn", "duplex.initDyn", "transform.initDyn", "passthrough.initDyn",
  "readable.push", "readable.pushStr", "readable.pushStrEnc", "readable.pushEncoding",
  "readable.pushNull", "readable.pushU", "readable.pushDyn",
  "readable.unshift", "readable.unshiftStr", "readable.read", "readable.setEncoding",
  "readable.nextChunk", "readable.nextChunkDyn", "readable.fromArr", "readable.resume",
  "readable.pipe", "readable.unpipe",
  "writable.write", "writable.writeStr", "writable.writeU", "writable.writeDyn",
  "writable.end", "writable.uncork",
  "stream.destroy", "stream.destroyErr",
  "stream.setRead", "stream.setWrite", "stream.setFinal", "stream.setDestroy",
  "stream.setTransform", "stream.setFlush",
  "process.activeResources",
  "stream.finished", "stream.finishedDyn", "stream.pipeline", "stream.pipelineDyn",
  "sp.finished", "sp.pipeline",
  "sc.text", "sc.json", "sc.buffer",
  "net.listen", "net.listenCb", "net.listenOpts", "net.listenOptsCb",
  "net.connect", "net.connectCb", "net.connectLookup", "net.connectAttempt",
  "fs.existsChk",
  "http.createServer", "http.createServerEmpty",
  "http.request", "http.requestCb", "http.requestUrl", "http.requestUrlCb",
  "https.request", "https.requestCb", "https.requestUrl", "https.requestUrlCb",
  "http.requestConn", "http.requestConnCb",
  "http.agentNew", "http.requestAgent", "http.requestAgentCb",
  // The dyn-async slice (emit-exprs.ts's markings): fiber parks, the
  // microtask/immediate mints, the tracing-promise reaction fiber, and
  // the checkpoint unhandled-rejection report.
  "async.hop", "async.awaitDyn",
  "dc.tcTracePromise",
  "process.onUnhandledRejection", "process.onRejectionHandled",
  "timers.queueMicrotaskDyn", "timers.setImmediateFnValue", "timers.immediatePromise",
]);

/** ScrBytesElem (scr_runtime.h): U8, U32, F32, I32. */
const BYTES_ELEM_NUM: Record<"u8" | "u32" | "f32" | "i32", number> = { u8: 0, u32: 1, f32: 2, i32: 3 };

/** ScrBytesNumKind + littleEndian per readNum/writeNum kind token —
 * emit-types.ts's BYTES_NUM_KIND_C with the enum values spelled out
 * (U8=0, I8=1, U16=2, I16=3, U32=4, I32=5, F32=6, F64=7). */
const BYTES_NUM_KIND: Record<string, { kind: number; le: boolean } | undefined> = {
  u8: { kind: 0, le: false },
  i8: { kind: 1, le: false },
  u16be: { kind: 2, le: false },
  u16le: { kind: 2, le: true },
  i16be: { kind: 3, le: false },
  i16le: { kind: 3, le: true },
  u32be: { kind: 4, le: false },
  u32le: { kind: 4, le: true },
  i32be: { kind: 5, le: false },
  i32le: { kind: 5, le: true },
  f32be: { kind: 6, le: false },
  f32le: { kind: 6, le: true },
  f64be: { kind: 7, le: false },
  f64le: { kind: 7, le: true },
};

/** The variable-width (read/writeUIntLE-style) kind tokens: sign + endian. */
const BYTES_NUM_VAR: Record<string, { sign: boolean; le: boolean } | undefined> = {
  ube: { sign: false, le: false },
  ule: { sign: false, le: true },
  ibe: { sign: true, le: false },
  ile: { sign: true, le: true },
};

/** ScrDataViewGet per dvGet* method (U8..BIGI64 = 0..9). */
const DV_GET_KIND: Record<string, number> = {
  dvGetUint8: 0,
  dvGetInt8: 1,
  dvGetUint16: 2,
  dvGetInt16: 3,
  dvGetUint32: 4,
  dvGetInt32: 5,
  dvGetFloat32: 6,
  dvGetFloat64: 7,
  dvGetBigUint64Number: 8,
  dvGetBigInt64Number: 9,
};

/** ScrDataViewGet per dvSet* method (the setters reuse the getter kinds;
 * no BIG setters exist). */
const DV_SET_KIND: Record<string, number> = {
  dvSetUint8: 0,
  dvSetInt8: 1,
  dvSetUint16: 2,
  dvSetInt16: 3,
  dvSetUint32: 4,
  dvSetInt32: 5,
  dvSetFloat32: 6,
  dvSetFloat64: 7,
};

class LlEmitter {
  readonly sizeType: "i32" | "i64";
  readonly cycleColorOffset: number;
  private readonly wasi: boolean;
  /** Interned string literals: UTF-8 text → { symbol, byte length } —
   * first-use order, the C emitter's determinism discipline. */
  private readonly literals = new Map<string, { sym: string; len: number }>();
  /** Interned unit-armed union instances: "unionId:tag" → symbol — one
   * immortal (rc == SIZE_MAX) static per (union, unit tag), exactly the
   * C emitter's table. RC entry points and the collector skip immortals. */
  private readonly unitInstances = new Map<string, string>();
  /** Interned regex literals: "<flags>/<pattern>" → { symbol, interned
   * source/flags literal refs } — one immortal ScrRegex per distinct
   * (pattern, flags) pair; the bytecode slot starts null and the runtime
   * compiles it lazily on first use. The source/flags strings intern at
   * REGISTRATION (bodies emit before the literal table flushes). */
  private readonly regexInstances = new Map<string, { sym: string; src: string; fl: string }>();
  /** Interned tagged-template strings objects: per-site key → { symbol,
   * interned cooked-literal refs }. One immortal ScrArr of string slots
   * per template SITE (the spec's per-occurrence identity — the C
   * emitter's templateStringsInstances discipline). */
  private readonly templateStringsInstances = new Map<string, { sym: string; slots: string[] }>();
  /** Interned NUL-terminated C-string constants (scr_jb_puts labels, the
   * stringify indent text): UTF-8 text → { symbol, byte length }. */
  private readonly cstrs = new Map<string, { sym: string; len: number }>();
  /** Type-directed walker functions (JSON serializers, the indent
   * rewriter, union ToString/join) — interned per typeKey/unionId, defs
   * flushed with the shape helpers. */
  private readonly walkers = new LlWalkers(this);
  /** The dyn (ScrDyn dyn) helper registry — dyn.ts's interned ports of
   * emit-walkers.ts's dyn slice. */
  private readonly dyn = new LlDyn(this);
  /** External declarations, in first-use order. */
  private readonly decls = new Set<string>();
  /** Declared functions referenced as values: each needs an env-signature
   * wrapper + an interned immortal closure (so `f === f` holds). */
  private readonly fnValues = new Set<string>();
  private needsOom = false;
  private needsBadTag = false;
  private needsBadKey = false;
  private needsRetainBox = false;

  private readonly fnByName = new Map<string, IrFunction>();
  /** Manifest-bound native imports, used by ffiCall emission. */
  private readonly ffiByName = new Map<string, IrFfiImport>();
  /** C-ABI callback trampolines and (for raw/no-userdata callbacks) their
   * distinct call-scoped TLS closure slots. */
  private readonly ffiCallbackAdapters: Map<string, FfiCallbackAdapter>;
  private readonly globalTypes = new Map<string, IrType>();
  /** May-throw analysis (the C emitter's computeMayThrow, shared): pending
   * checks are emitted only after calls that can actually raise. */
  private readonly mayThrow: Set<string>;
  private readonly indirectMayThrow: boolean;
  /** Method names with at least one may-throw implementation — the
   * virtualCall pending check's key (CEmitter.mayThrowMethods). */
  private readonly mayThrowMethods = new Set<string>();
  /** setTimeout and friends appeared somewhere: main must run the event
   * loop even in programs with no async functions (CEmitter.usesTimers). */
  private usesTimers = false;
  /** Emitted ref-kind resolve thunks for new Promise, interned per inner
   * typeKey → thunk symbol (CEmitter.resolveThunks). */
  private readonly resolveThunks = new Map<string, string>();
  private readonly resolveThunkDefs: string[] = [];
  /** ReadableStream.from adapters keep typed arrays by reference and box
   * one current element per pull. */
  private readonly streamFromArrayAdapters = new Map<string, string>();
  /** Identity-preserving static→dyn capsules used by Web APIs whose values
   * remain directly observable (stream chunks and AbortSignal reasons). */
  private readonly liveDynRefAdapters = new Map<
    string,
    LlStreamTypedRefAdapter
  >();
  /** Runtime-arm dispatchers for live union values. */
  private readonly liveDynUnionRefAdapters = new Map<string, string>();
  private readonly dynPromiseAdapters = new Map<string, string>();
  readonly unionsById = new Map<string, IrUnionDef>();
  readonly recordsById = new Map<string, IrRecordShape>();
  readonly tracedShapes: Set<string>;
  readonly tracedUnions: Set<string>;
  /** The class graph (buildClassGraph): preorder numbering, hierarchy
   * membership, virtual slot lists — the CEmitter classMeta, ported. */
  private readonly classMeta: Map<string, LlClassMeta>;
  /** Class objects (classes as first-class values): className → the
   * interned .name literal ref — registered during body emission, the
   * statics and construct thunks assemble around the bodies. */
  private readonly classObjs = new Map<string, { nameSym: string }>();
  /** Preorder intervals of the runtime error classes under THIS module's
   * class-forest numbering (main() stamps scr_error_vts with them, exactly
   * like the C emitter's errorVtStampLines). */
  private readonly errorIntervals: { kind: number; pre: number; post: number; lib: string }[] = [];
  /** The runtime emitter vtable's preorder interval, when the program
   * touches node:events (the class def rides the module exactly then) —
   * main() stamps scr_emitter_vt with it (emitterVtStampLines, ported). */
  private emitterInterval: { pre: number; post: number } | null = null;
  /** The runtime stream vtables' preorder intervals (streamVtStampLines,
   * ported): the defs ride every emitter-touching module (the frontend
   * collects the whole emitter-rooted tree), and scr_stream.c links on
   * the same predicate, so the stamps always have their globals. */
  private readonly streamIntervals: { vt: string; pre: number; post: number; lib: string }[] = [];

  // ── per-function state (reset in emitFunction) ─────────────────────────
  private B = new BlockBuilder();
  private frames: LlValue[][] = [];
  private scopes: LlScopeEntry[][] = [];
  /** Enclosing break/continue targets. `kind` separates loops from
   * switches and labeled blocks: an unlabeled break binds to the innermost
   * NON-BLOCK entry (loop or switch — blocks only enter the stack when
   * labeled, and only a labeled break can target one); an unlabeled
   * continue binds to the innermost LOOP; a labeled jump binds to the
   * entry whose `labels` contains its label. `contLabel` is null exactly
   * for blocks and switches. */
  private jumpTargets: {
    kind: "loop" | "block" | "switch";
    brkLabel: string;
    contLabel: string | null;
    labels?: string[];
    frameDepth: number;
    scopeDepth: number;
  }[] = [];
  private currentLocals = new Map<string, IrLocal>();
  private captureIds = new Set<string>();
  /** Active canonical byte-loop induction bindings: local id → size_t slot. */
  private integerLoopBindings = new Map<string, string>();
  /** Enclosing try-with-FINALLY regions, innermost last: a `return`
   * inside one runs every crossed finally (innermost first) before the
   * actual ret — the C emitter's pending-return path, with the finally
   * bodies emitted inline at the return site instead of behind a goto.
   * `tryDepth` snapshots tryStack.length at region entry: a throw inside
   * a pending-return finally copy propagates OUT of the completing try
   * (past its own catch), so the copies emit under the truncated stack.
   * break/continue never cross a finally (frontend fence + validator
   * backstop), so return and the two tryCatch paths are the only copies. */
  private finallyStack: { frameDepth: number; scopeDepth: number; tryDepth: number; body: IrStmt[] }[] = [];
  /** Enclosing try contexts, innermost last — the compile-time unwind
   * targets (CEmitter.tryStack): a pending check or `throw` inside a try
   * releases frames/scopes down to the recorded depths and branches to
   * `label` (the catch, or the exception-path finally) instead of
   * returning out of the function. Entering a try emits no code. */
  private tryStack: { label: string; used: boolean; frameDepth: number; scopeDepth: number }[] = [];
  /** Return type of the function being emitted — the unwind path returns
   * a dummy of this type (never read: callers check the flag first). */
  private currentReturnType: IrType = VOID;
  /** Active only while emitting a wasm32 async body lowered with LLVM's
   * switched-coroutine intrinsics. */
  private currentWasiCoro: {
    kind: "async" | "generator";
    id: string;
    handle: string;
    self: string;
    finalLabel: string;
    cleanupLabel: string;
    suspendLabel: string;
  } | null = null;
  /** The generator channels of the function being emitted (null outside
   * generator bodies): yieldExpr emission reads them, and emitTryCatch's
   * catch prologue emits the GENRET sentinel re-unwind exactly here. */
  private currentGenerator: { yieldT: IrType; nextT: IrType } | null = null;
  /** Active optional-chain bind slots, by chain id (chainRecv reads). */
  private readonly chainSlots = new Map<string, LlValue>();
  private logArgSlots = 0;

  constructor(private readonly mod: IrModule, options: LlvmTargetOptions) {
    this.sizeType = options.pointerBits === 32 ? "i32" : "i64";
    this.wasi = options.wasi === true;
    // ScrCycHdr is { ptr trace; ptr free; i32 color; i16 buffered;
    // i16 gen; size_t buf_index }. The object follows it, so color is 12
    // bytes behind a wasm32 object and 16 bytes behind a 64-bit object.
    this.cycleColorOffset = options.pointerBits === 32 ? 12 : 16;
    this.ffiCallbackAdapters = allocateFfiCallbackAdapters(mod.ffiImports ?? []);
    for (const fn of mod.functions) this.fnByName.set(fn.name, fn);
    for (const entry of mod.ffiImports ?? []) {
      this.ffiByName.set(entry.name, entry);
    }
    const mt = computeMayThrow(mod);
    this.mayThrow = mt.fns;
    this.indirectMayThrow = mt.indirect;
    for (const cls of mod.classes ?? []) {
      for (const m of cls.methods ?? []) {
        if (this.mayThrow.has(`%${cls.name}.${m}`)) this.mayThrowMethods.add(m);
      }
    }
    for (const u of mod.unions ?? []) this.unionsById.set(u.id, u);
    for (const r of mod.records ?? []) this.recordsById.set(r.id, r);
    const traced = computeTraced(mod);
    this.tracedShapes = traced.shapes;
    this.tracedUnions = traced.unions;
    for (const g of mod.globals ?? []) {
      // Module globals: scalar (f64/bool) storage is a zero-initialized
      // LLVM global, ref-kind storage a null-initialized ptr — load/store
      // like a local, assigned by the %init functions. Refcounted globals
      // are released at the end of main (the C emitter's
      // sc_release_globals), before the RC audit would run.
      try {
        this.llType(g.type); // refuses out-of-tier kinds
      } catch (err) {
        if (err instanceof LlvmUnsupportedError) throw new LlvmUnsupportedError(`global:${g.type.kind}`);
        throw err;
      }
      this.globalTypes.set(g.id, g.type);
    }
    // User classes are IN the tier (phase 3), and so are the runtime
    // error classes and the runtime EventEmitter/stream classes (phase 6
    // — subclasses embed the ScrEmitter/ScrStream prefixes, classes.ts).
    // Anything else runtime-flagged refuses by name, exactly the
    // classDef:* histogram key.
    const classes = mod.classes ?? [];
    for (const cls of classes) {
      if (
        cls.runtime &&
        !RUNTIME_ERROR_CLASSES.has(cls.name) &&
        cls.name !== RUNTIME_EMITTER_CLASS &&
        !RUNTIME_STREAM_CLASSES.has(cls.name)
      ) {
        throw new LlvmUnsupportedError(`classDef:${cls.name}`, cls.loc);
      }
    }
    // The class graph: base/children links, hierarchy membership, the
    // whole-program preorder numbering (identical to CEmitter's, so
    // runtime-made and compiled error objects agree on instanceof through
    // either backend), and the per-hierarchy virtual slot lists.
    this.classMeta = buildClassGraph(mod, this.fnByName);
    for (const [name, rec] of RUNTIME_ERROR_CLASSES) {
      const meta = this.classMeta.get(name);
      if (!meta) break; // hand-written IR without the builtin defs: no stamps
      this.errorIntervals.push({ kind: rec.kind, pre: meta.pre, post: meta.post, lib: rec.lib });
    }
    const emMeta = this.classMeta.get(RUNTIME_EMITTER_CLASS);
    if (emMeta) this.emitterInterval = { pre: emMeta.pre, post: emMeta.post };
    for (const [name, rec] of RUNTIME_STREAM_CLASSES) {
      const meta = this.classMeta.get(name);
      if (!meta) continue;
      this.streamIntervals.push({
        vt: `scr_${rec.lib.toLowerCase()}_vt`,
        pre: meta.pre,
        post: meta.post,
        lib: rec.lib,
      });
    }
  }

  private abiOffset(native64: number, wasm32: number): number {
    return this.sizeType === "i32" ? wasm32 : native64;
  }

  // ── types ───────────────────────────────────────────────────────────────

  private llType(t: IrType): string {
    switch (t.kind) {
      case "f64":
      case "date":
        return "double";
      case "bool":
        return "i1";
      case "string":
      case "array":
      case "record":
      case "union":
      case "func":
      case "map":
      case "set":
      case "symbol":
      case "regex":
      case "promise":
      case "bytes":
      case "url":
      case "searchParams":
      case "stats":
      case "fileHandle":
      case "spawnRes":
      case "child":
      case "childStream":
      case "generator":
      case "dyn":
      case "jsval":
      case "fsWatcher":
      case "netServer":
      case "netSocket":
      case "dgramSocket":
      case "httpReq":
      case "httpRes":
      case "httpClientReq":
      case "secureCtx":
      case "testCtx":
        return "ptr";
      case "procStream":
        // A SCALAR kind: the stream value IS its fd (1 = stdout, 2 =
        // stderr) — no heap, no refcount.
        return "double";
      case "object":
        return "ptr";
      case "classval":
      case "caught": // catch bindings: ScrCaught snapshot boxes
        return "ptr";
      case "void":
        return "void";
      default:
        throw new LlvmUnsupportedError(`type:${t.kind}`);
    }
  }

  // ── module assembly ─────────────────────────────────────────────────────

  private ffiCallbackAdapter(binding: string, id: string): FfiCallbackAdapter {
    const adapter = this.ffiCallbackAdapters.get(`${binding}:${id}`);
    if (!adapter) throw new Error(`llvm emitter bug: no callback adapter for ${binding}:${id}`);
    return adapter;
  }

  /** C-callable scalar callback trampolines. A callback with an explicit
   * context entry receives the closure at that exact ABI position. A raw
   * callback loads it from a call-scoped TLS slot installed around the
   * outer native call. */
  private emitFfiCallbackDefs(): { globals: string[]; defs: string[] } {
    const globals: string[] = [];
    const defs: string[] = [];
    if (this.ffiCallbackAdapters.size === 0) return { globals, defs };
    this.declare(`declare zeroext i1 @scr_exc_pending()`);
    this.declare(`declare void @scr_trap(ptr)`);
    const expired = this.cstr("scriptc: native callback invoked outside its call-scoped lifetime\n");
    const released = this.cstr("scriptc: native callback invoked outside its retained lifetime\n");
    for (const adapter of this.ffiCallbackAdapters.values()) {
      const cb = adapter.callback;
      if (adapter.tls !== null) globals.push(`@${adapter.tls} = internal thread_local global ptr null`);
      if (adapter.global !== null) globals.push(`@${adapter.global} = internal global ptr null`);
      if (adapter.table !== null) {
        globals.push(`@${adapter.table} = internal global %ScrFfiTable zeroinitializer`);
      }
      const params = cb.params.flatMap((param, i): string[] => {
        if (isFfiContextParam(param)) return [`ptr %ctx`];
        if (param === "string" || param === "bytes") {
          return [`ptr %a${i}`, `${this.sizeType} %a${i}_len`];
        }
        return [`${ffiNativeTypeLl(param)} %a${i}`];
      });
      const ret = ffiNativeTypeLl(cb.returns);
      defs.push(
        `define internal ${ret} @${adapter.symbol}(${params.join(", ")}) ${FN_ATTRS} {`,
        `entry:`,
        adapter.tls !== null
          ? `  %cb = load ptr, ptr @${adapter.tls}`
          : adapter.global !== null
            ? `  %cb = load ptr, ptr @${adapter.global}`
            : `  %cb = getelementptr inbounds i8, ptr %ctx, i64 0`,
        `  %missing = icmp eq ptr %cb, null`,
        `  br i1 %missing, label %expired, label %ready`,
        `expired:`,
        `  call void @scr_trap(ptr ${adapter.callback.lifetime === "call" ? expired : released})`,
        `  unreachable`,
        `ready:`,
        `  %pending = call zeroext i1 @scr_exc_pending()`,
        `  br i1 %pending, label %skip, label %invoke`,
        `skip:`,
        `  ret ${ffiCallbackDummyLl(cb)}`,
        `invoke:`,
      );
      // Validate every native pointer before allocating any copy-in value.
      // A later bad slot therefore cannot leak an earlier materialization.
      for (let i = 0; i < cb.params.length; i++) {
        const param = cb.params[i]!;
        if (param !== "cstring" && param !== "string" && param !== "bytes") continue;
        const invalid = `%invalid${i}`;
        defs.push(`  %null${i} = icmp eq ptr %a${i}, null`);
        if (param === "cstring") {
          defs.push(`  ${invalid} = or i1 %null${i}, false`);
        } else {
          defs.push(
            `  %nonempty${i} = icmp ne ${this.sizeType} %a${i}_len, 0`,
            `  ${invalid} = and i1 %null${i}, %nonempty${i}`,
          );
        }
        const message = param === "cstring"
          ? "scriptc: native callback passed a NULL cstring\n"
          : `scriptc: native callback passed a NULL ${param} span with nonzero length\n`;
        defs.push(
          `  br i1 ${invalid}, label %invalid_param${i}, label %param_ok${i}`,
          `invalid_param${i}:`,
          `  call void @scr_trap(ptr ${this.cstr(message)})`,
          `  unreachable`,
          `param_ok${i}:`,
        );
      }
      defs.push(
        `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
        `  %fn = load ptr, ptr %fnp`,
      );
      const scriptArgs: string[] = [];
      for (let i = 0; i < cb.params.length; i++) {
        const param = cb.params[i]!;
        if (isFfiContextParam(param)) continue;
        switch (param) {
          case "f64":
            scriptArgs.push(`double %a${i}`);
            break;
          case "bool":
            defs.push(`  %s${i} = icmp ne i8 %a${i}, 0`);
            scriptArgs.push(`i1 %s${i}`);
            break;
          case "u8":
            defs.push(`  %s${i} = uitofp i8 %a${i} to double`);
            scriptArgs.push(`double %s${i}`);
            break;
          case "u32":
            defs.push(`  %s${i} = uitofp i32 %a${i} to double`);
            scriptArgs.push(`double %s${i}`);
            break;
          case "i32":
            defs.push(`  %s${i} = sitofp i32 %a${i} to double`);
            scriptArgs.push(`double %s${i}`);
            break;
          case "cstring":
            this.declare(`declare ${this.sizeType} @strlen(ptr)`);
            this.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${this.sizeType})`);
            defs.push(
              `  %len${i} = call ${this.sizeType} @strlen(ptr %a${i})`,
              `  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %a${i}, ${this.sizeType} %len${i})`,
            );
            scriptArgs.push(`ptr %s${i}`);
            break;
          case "string":
            this.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${this.sizeType})`);
            defs.push(
              `  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %a${i}, ${this.sizeType} %a${i}_len)`,
            );
            scriptArgs.push(`ptr %s${i}`);
            break;
          case "bytes":
            this.declare(`declare ptr @scr_bytes_from_data(ptr, ${this.sizeType})`);
            defs.push(
              `  %s${i} = call ptr @scr_bytes_from_data(ptr %a${i}, ${this.sizeType} %a${i}_len)`,
            );
            scriptArgs.push(`ptr %s${i}`);
            break;
        }
      }
      const ft = ffiCallbackType(cb);
      const internalRet = this.llType(ft.ret);
      const callArgs = [`ptr %cb`, ...scriptArgs].join(", ");
      if (cb.lifetime === "retained") {
        this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
        this.declare(`declare void @scr_closure_release_v(ptr)`);
        defs.push(`  %invoke_pin = call ptr @scr_closure_retain_v(ptr %cb)`);
      }
      if (cb.returns === "void") {
        defs.push(
          `  call void %fn(${callArgs})`,
          ...(cb.lifetime === "retained" ? [`  call void @scr_closure_release_v(ptr %invoke_pin)`] : []),
          `  ret void`,
          `}`,
          ``,
        );
        continue;
      }
      defs.push(`  %result = call ${internalRet} %fn(${callArgs})`);
      if (cb.lifetime === "retained") {
        defs.push(`  call void @scr_closure_release_v(ptr %invoke_pin)`);
      }
      switch (cb.returns) {
        case "f64":
          defs.push(`  ret double %result`);
          break;
        case "bool":
          defs.push(`  %out = zext i1 %result to i8`, `  ret i8 %out`);
          break;
        case "u8":
        case "u32":
          this.declare(`declare double @scr_bit_ushr(double, double)`);
          defs.push(
            `  %coerced = call double @scr_bit_ushr(double %result, double ${f64Lit(0)})`,
            `  %wide = fptoui double %coerced to i32`,
          );
          if (cb.returns === "u8") {
            defs.push(`  %out = trunc i32 %wide to i8`, `  ret i8 %out`);
          } else {
            defs.push(`  ret i32 %wide`);
          }
          break;
        case "i32":
          this.declare(`declare double @scr_bit_or(double, double)`);
          defs.push(
            `  %coerced = call double @scr_bit_or(double %result, double ${f64Lit(0)})`,
            `  %out = fptosi double %coerced to i32`,
            `  ret i32 %out`,
          );
          break;
      }
      defs.push(`}`, ``);
    }
    return { globals, defs };
  }

  emit(): string {
    // Function bodies first (the literal/unit/fn-value tables fill as they
    // emit), then the file assembles around them — the C emitter's order.
    const fnDefs: string[] = [];
    for (const fn of this.mod.functions) fnDefs.push(this.emitFunction(fn));
    const shapes = emitRecordShapes(this, this.mod);
    const classShapes = emitClassShapes(this, this.mod, this.classMeta);
    const classObjDefs = emitClassObjDefs(this, this.classMeta, this.classObjs, this.fnByName, (t) => this.llType(t));
    const wrappers = this.emitFnValueDefs();
    const asyncDefs = this.emitAsyncScaffolding();
    const ffiCallbacks = this.emitFfiCallbackDefs();
    const embedded = this.mod.embedded;
    const usesIsland = embedded !== undefined && embedded.modules.length > 0;
    const storeNpmText = (text: string): { bytes: Buffer; raw: number } => {
      const plain = Buffer.from(text, "utf8");
      if (text.length < NPM_COMPRESS_MIN) return { bytes: plain, raw: 0 };
      const deflated = deflateRawSync(plain, { level: 9 });
      return deflated.length < plain.length
        ? { bytes: deflated, raw: plain.length }
        : { bytes: plain, raw: 0 };
    };
    const npmStored = usesIsland
      ? embedded.modules.map((m) => ({
          src: storeNpmText(m.source),
          esm: m.esm === undefined ? null : storeNpmText(m.esm),
        }))
      : [];

    // Module globals, FIRST OCCURRENCE per id: a class-expression static
    // instantiated through several mixin applications registers one global
    // id several times (2041-mixin-values) — C's tentative definitions
    // absorb the duplicates silently, LLVM rejects redefinition, so the
    // storage AND the release emit once per id here.
    const seenGlobalIds = new Set<string>();
    const globals = (this.mod.globals ?? []).filter((g) => {
      if (seenGlobalIds.has(g.id)) return false;
      seenGlobalIds.add(g.id);
      return true;
    });
    // Refcounted globals release before main returns — the C emitter's
    // sc_release_globals, keeping the RC audit's live count exact. Built
    // before the declaration table flushes (it adds the release symbols).
    // Two spellings with distinct temp names: the normal exit and the
    // uncaught-exception exit are separate blocks of the same function.
    // Interned function-value closures are IMMORTAL (rc == SIZE_MAX), so
    // an own-property table Object.defineProperties hung on one would
    // outlive the RC audit — release it with the globals (the C emitter's
    // sc_release_globals tail). Only when the dispatch unit is even
    // linked (defineProps is the only writer).
    const fnValueProps = moduleUsesDynInvoke(this.mod) ? [...this.fnValues] : [];
    if (fnValueProps.length > 0) this.declare(`declare void @scr_box_release(ptr)`);
    const globalReleaseLines = (prefix: string): string[] => {
      const lines: string[] = [];
      globals.forEach((g, i) => {
        if (!isRefCounted(g.type)) return;
        lines.push(
          `  %${prefix}${i} = load ptr, ptr @${mangleGlobal(g.id)}`,
          `  call void ${releaseSym(this, g.type)}(ptr %${prefix}${i}) ; ${g.name}`,
        );
      });
      fnValueProps.forEach((name, i) => {
        // props sits at %ScrClosure field 3; release is NULL-tolerant —
        // cleared so a second release path stays idempotent.
        lines.push(
          `  %${prefix}fp${i} = load ptr, ptr getelementptr inbounds (%ScrClosure, ptr @${mangleFnClosure(name)}, i64 0, i32 3)`,
          `  call void @scr_box_release(ptr %${prefix}fp${i}) ; ${name}.props`,
          `  store ptr null, ptr getelementptr inbounds (%ScrClosure, ptr @${mangleFnClosure(name)}, i64 0, i32 3)`,
        );
      });
      return lines;
    };
    // Exit listeners can read MODULE GLOBALS directly, so they must run
    // BEFORE the global releases (the C emitter's runExitListeners
    // ordering — the atexit half becomes an idempotent no-op).
    const usesEvents = moduleUsesProcessEvents(this.mod);
    const usesFsWatch = moduleUsesFsWatch(this.mod);
    // Stream-surface programs fill the loop's stream hook (the deferred
    // next-tick emissions) and the emitter's post-registration flow kick
    // before %main — scr_stream.c links only when the line is emitted
    // (cc.ts gates on the same predicate).
    const usesStream = moduleUsesStream(this.mod);
    // Net-surface programs fill the loop's net hooks (and the netSocket
    // handle-dispatch ops for the checked-dynamic boundary); http-surface
    // programs additionally stamp the httpReq/httpRes ops — the C main's
    // install lines, gated on the same predicates cc.ts links by.
    const usesNet = moduleUsesNet(this.mod);
    const usesHttp = moduleUsesHttpServer(this.mod);
    // Fetch-referencing programs register the native fetch bridge before
    // any island entry (the engine's lazy boot consults it) — cc.ts
    // compiles scr_fetch.c on the same predicate.
    const usesFetch = moduleUsesFetch(this.mod);
    const embedsZlib = moduleEmbedsBuiltin(this.mod, "node:zlib");
    const embedsNet =
      moduleEmbedsBuiltin(this.mod, "node:http") ||
      moduleEmbedsBuiltin(this.mod, "node:https") ||
      moduleEmbedsBuiltin(this.mod, "node:net") ||
      moduleEmbedsBuiltin(this.mod, "node:tls");
    const snapshotsTlsCa =
      moduleUsesTls(this.mod) || moduleUsesTlsCa(this.mod) ||
      moduleEmbedsBuiltin(this.mod, "node:https") ||
      moduleEmbedsBuiltin(this.mod, "node:tls");
    const hasRefGlobals = globals.some((g) => isRefCounted(g.type)) || fnValueProps.length > 0;
    // The process verdict has the same precedence as the C reference
    // emitter: node:test owns the final status when present; otherwise an
    // embedded process.exitCode owns it; ordinary programs return zero.
    const usesNodeTest = moduleUsesNodeTest(this.mod);
    const programExitUsesIsland = !usesNodeTest && usesIsland;
    // Declared NOW — the extern block flushes before main assembles.
    if (usesEvents) this.declare(`declare void @scr_events_install()`);
    if (usesFsWatch) this.declare(`declare void @scr_watch_install()`);
    if (usesStream) this.declare(`declare void @scr_stream_install()`);
    if (usesNet) {
      this.declare(`declare void @scr_net_install()`);
      this.declare(`declare void @scr_net_dyn_install()`);
    }
    if (usesHttp) this.declare(`declare void @scr_http_dyn_install()`);
    if (usesFetch) this.declare(`declare void @scr_fetch_install()`);
    if (embedsZlib) this.declare(`declare void @scr_zlib_island_install()`);
    if (embedsNet) this.declare(`declare void @scr_net_island_install()`);
    if (usesIsland) {
      this.declare(`declare void @scr_island_modules(ptr, ${this.sizeType}, ptr, ${this.sizeType})`);
      this.declare(`declare i32 @scr_island_exit_code()`);
      if (moduleEmbedsCompressedNpm(this.mod)) {
        this.declare(`declare void @scr_island_set_inflate(ptr)`);
        this.declare(`declare zeroext i1 @scr_zlib_inflate_exact(ptr, ${this.sizeType}, ptr, ${this.sizeType})`);
      }
    }
    if (usesNodeTest) this.declare(`declare i32 @scr_test_exit_code()`);
    if (snapshotsTlsCa) {
      this.declare(`declare void @scr_tls_ca_install()`);
    }
    if (usesEvents && hasRefGlobals) {
      this.declare(`declare void @scr_run_exit_listeners(double)`);
      this.declare(`declare i32 @scr_exit_code_hint_get()`);
    }
    const exitListenerLines = (prefix: string): string[] => {
      if (!usesEvents || !hasRefGlobals) return [];
      return [
        `  %${prefix}h = call i32 @scr_exit_code_hint_get()`,
        `  %${prefix}hd = sitofp i32 %${prefix}h to double`,
        `  call void @scr_run_exit_listeners(double %${prefix}hd)`,
      ];
    };
    const globalReleases = globalReleaseLines("g");
    const asyncEntry = this.fnByName.get(this.mod.entry)?.async === true;
    const entryMayThrow = this.mayThrow.has(this.mod.entry);
    // The event loop runs when timers appeared OR any async/generator
    // function exists (the C main's hasAsync || hasGenerators ||
    // usesTimers gate). Generator programs run
    // the loop too: its exit accounting notes still-suspended generator
    // fibers as abandoned, so the RC audit downgrades exactly like the
    // async loop-exhaustion story.
    const runsLoop =
      this.usesTimers ||
      usesIsland ||
      this.mod.functions.some((f) => f.async === true || f.generator !== undefined);
    const uncaughtReleases = entryMayThrow && !asyncEntry ? globalReleaseLines("gu") : [];
    const loopReleasesU = runsLoop ? globalReleaseLines("gl") : [];
    const loopReleasesR = runsLoop ? globalReleaseLines("gr") : [];
    const topRejectReleases = asyncEntry ? globalReleaseLines("gt") : [];
    const topPendingReleases = asyncEntry ? globalReleaseLines("gp") : [];
    const loopReportedReleases = runsLoop ? globalReleaseLines("gq") : [];
    // main's epilogues read the flag / the loop entry points — declared
    // HERE, before the extern block flushes (a pending check usually
    // declared the flag already; the Set dedupes).
    if (entryMayThrow || runsLoop) this.declare(`declare zeroext i1 @scr_exc_pending()`);
    if (runsLoop) {
      this.declare(`declare zeroext i1 @scr_loop_run(ptr)`);
      this.declare(`declare zeroext i1 @scr_report_unhandled_rejections()`);
      this.declare(`declare void @scr_discard_unhandled_rejections()`);
    }
    if (asyncEntry) {
      this.declare(`declare i32 @scr_promise_finish_top_level(ptr)`);
      this.declare(`declare void @scr_promise_rethrow_top_level(ptr)`);
      this.declare(`declare void @scr_promise_release(ptr)`);
      this.declare(`declare void @scr_exit_code_note(i32)`);
      if (programExitUsesIsland && usesEvents && hasRefGlobals) {
        this.declare(`declare ${this.sizeType} @scr_island_exit_code_version()`);
      }
    }
    const topPendingExitLines = (): string[] => {
      if (!asyncEntry) return [];
      const lines: string[] = [];
      if (usesNodeTest) {
        lines.push(`  %tla_program_exit = call i32 @scr_test_exit_code()`);
      } else if (usesIsland) {
        lines.push(`  %tla_program_exit = call i32 @scr_island_exit_code()`);
      }
      if (usesNodeTest || usesIsland) {
        lines.push(
          `  %tla_program_exit_zero = icmp eq i32 %tla_program_exit, 0`,
          `  %tla_exit_status = select i1 %tla_program_exit_zero, i32 %tla_status, i32 %tla_program_exit`,
        );
      }
      const exitStatus = usesNodeTest || usesIsland ? "%tla_exit_status" : "%tla_status";
      const tracksIslandExit = programExitUsesIsland && usesEvents && hasRefGlobals;
      if (tracksIslandExit) {
        lines.push(`  %tla_exit_version = call ${this.sizeType} @scr_island_exit_code_version()`);
      }
      // finish_top_level initially notes 13. Replace that hint before exit
      // listeners run when a higher-priority verdict was already selected.
      lines.push(`  call void @scr_exit_code_note(i32 ${exitStatus})`);
      lines.push(...exitListenerLines("xp"));
      if (tracksIslandExit) {
        lines.push(
          `  %tla_exit_version_after = call ${this.sizeType} @scr_island_exit_code_version()`,
          `  %tla_exit_changed = icmp ne ${this.sizeType} %tla_exit_version_after, %tla_exit_version`,
          `  br i1 %tla_exit_changed, label %tla_exit_updated, label %tla_exit_unchanged`,
          `tla_exit_updated:`,
          `  %tla_listener_exit = call i32 @scr_island_exit_code()`,
          `  call void @scr_exit_code_note(i32 %tla_listener_exit)`,
          `  br label %tla_exit_done`,
          `tla_exit_unchanged:`,
          `  br label %tla_exit_done`,
          `tla_exit_done:`,
          `  %tla_final_exit = phi i32 [ %tla_listener_exit, %tla_exit_updated ], [ ${exitStatus}, %tla_exit_unchanged ]`,
        );
      }
      lines.push(...topPendingReleases);
      lines.push(`  ret i32 ${tracksIslandExit ? "%tla_final_exit" : exitStatus}`);
      return lines;
    };
    // LIBRARY mode: the runtime entry points the generated library
    // symbols delegate to — declared before the extern block flushes.
    if (this.mod.lib !== undefined) {
      this.declare(`declare void @scr_library_entry(i1 zeroext, ptr)`);
      this.declare(`declare void @scr_library_reset()`);
      this.declare(`declare void @scr_library_check_exc()`);
      this.declare(`declare void @scr_library_set_sink(ptr, ptr)`);
      this.declare(`declare void @scr_library_arena_reset()`);
      this.declare(`declare void @scr_library_collect()`);
      if ((this.mod.lib.callbacks?.length ?? 0) > 0) {
        // Host-callback channels: the registration define's dispatch
        // (strcmp over the declared names + the runtime slot store).
        // The call-site fetch pair (scr_library_cb_require/_ctx) is
        // declared at ffiCall emission like every body-driven runtime
        // symbol.
        this.declare(`declare void @scr_library_cb_set(${this.sizeType}, ptr, ptr)`);
        this.declare(`declare i32 @strcmp(ptr, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.params.includes("string"))) {
        this.declare(`declare ptr @scr_library_str_in(ptr, ${this.sizeType})`);
      }
      if (this.mod.lib.exports.some((e) => e.params.includes("bytes"))) {
        this.declare(`declare ptr @scr_library_bytes_in(ptr, ${this.sizeType}, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.params.includes("i64"))) {
        this.declare(`declare double @scr_library_i64_in(i64, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.params.includes("u64"))) {
        this.declare(`declare double @scr_library_u64_in(i64, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.returns === "string")) {
        this.declare(`declare void @scr_library_str_out(ptr, ptr, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.returns === "bytes")) {
        this.declare(`declare void @scr_library_bytes_out(ptr, ptr, ptr)`);
      }
    }
    // Helpers assemble BEFORE the declaration table flushes (they add
    // write/abort declarations).
    const helpers = this.helperDefs();

    const out: string[] = [
      `; Generated by scriptc (LLVM backend) from ${this.mod.sourceFile}. Do not edit.`,
      ``,
      // Type shapes shared with the runtime's C ABI. ScrStr is the header
      // prefix only (the flexible-array tail is concrete per literal);
      // ScrLogArg is { i32 tag; 8-byte union } — i64 at offset 8 matches
      // the C layout (4 bytes padding after the tag). ScrUnion/ScrClosure
      // mirror scr_runtime.h field-for-field (tag reads, slot peeks, the
      // fn pointer, and the caps[] tail all address through them).
      `%ScrStr = type { ${this.sizeType}, ${this.sizeType}, ${this.sizeType} }`,
      `%ScrLogArg = type { i32, i64 }`,
      `%ScrVt = type { ${this.sizeType}, ${this.sizeType}, ptr }`,
      `%ScrUnion = type { ${this.sizeType}, i32, ptr, ptr, ptr, i64 }`,
      `%ScrClosure = type { ${this.sizeType}, ptr, ${this.sizeType}, ptr }`,
      `%ScrFfiTable = type { ptr, ${this.sizeType}, ${this.sizeType}, ptr, i8 }`,
      `%ScrRegex = type { ${this.sizeType}, ptr, ptr, ptr }`,
      // ScrArr mirror { rc, len, cap, elem(i32+pad), elem_retain,
      // elem_release, elem_trace, data } — the immortal tagged-template
      // strings objects lay out through it (nothing GEPs into live heap
      // arrays; those stay behind the runtime's own entry points).
      `%ScrArr = type { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, i32, ptr, ptr, ptr, ptr }`,
      // The runtime error prefix { rc, vt, name, message, code } and the
      // class-object shape { rc, pre, post, ctor, name } — field reads on
      // builtin errors and classval loads GEP through these.
      `%ScrError = type { ${this.sizeType}, ptr, ptr, ptr, ptr }`,
      `%ScrClassObj = type { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, ptr, ptr }`,
      // The runtime emitter prefix { rc, vt, reg, cls } — user subclasses
      // embed it (classes.ts), and bare-emitter GEPs address through it.
      `%ScrEmitter = type { ${this.sizeType}, ptr, ptr, ptr }`,
      // The runtime stream layout { rc, vt, reg, cls, st } — one struct
      // for all five stream classes; stream subclasses embed it.
      `%ScrStream = type { ${this.sizeType}, ptr, ptr, ptr, ptr }`,
      // The catch-binding snapshot box { rc, kind, f64, b, payload,
      // retain_fn, release_fn, trace_fn } — caughtTest kind reads and
      // caughtNarrow payload extraction GEP through it (offsets match
      // scr_runtime.h's natural alignment: kind at 8, f64 at 16, b at 24,
      // payload at 32).
      `%ScrCaught = type { ${this.sizeType}, i32, double, i8, ptr, ptr, ptr, ptr }`,
      // ScrBytes { rc, len, elem(i32+pad), data, backing }. Indexed
      // typed-array access GEPs through this directly: the IR type already
      // fixes elem, so the hot path needs neither a runtime kind load nor
      // the generic scr_bytes_get/set call.
      `%ScrBytes = type { ${this.sizeType}, ${this.sizeType}, i32, ptr, ptr }`,
      // The capture box { rc, kind, obj_retain, obj_release, obj_trace,
      // slot } — TDZ reads peek the payload slot (offset 40) directly.
      `%ScrBox = type { ${this.sizeType}, i32, ptr, ptr, ptr, i64 }`,
      // The stack buffer of the emitted JSON serializers { data, len, cap }.
      `%ScrJsonBuf = type { ptr, ${this.sizeType}, ${this.sizeType}, ptr, ${this.sizeType}, ${this.sizeType} }`,
      // The dynCheck error-path spine { parent, key, index } — the emitted
      // builders stack-allocate one per recursion level (dyn.ts).
      `%ScrDynPath = type { ptr, ptr, ${this.sizeType} }`,
      `%ScrIslandModule = type { ptr, ptr, ${this.sizeType}, ${this.sizeType}, i32, ptr, ${this.sizeType}, ${this.sizeType} }`,
      `%ScrIslandEdge = type { ptr, ptr, ptr, i32 }`,
    ];
    out.push(...shapes.typeDefs);
    out.push(...classShapes.typeDefs);
    // Thread-instanced library state (abi.instance_per_thread): the
    // program TU's mutable globals — module globals, run-once guards, the
    // lazily-compiled regex literal caches — and the runtime globals its
    // init stamps live in thread-local storage, matching the runtime
    // objects compiled with -DSCR_THREAD_INSTANCES. Immutable interned
    // data (string literals, unit arms, template arrays, vtables) stays
    // shared.
    const tl = this.mod.lib?.threadInstances === true ? "thread_local " : "";
    out.push(
      ``,
      `@scr_error_vts = external ${tl}global [5 x %ScrVt]`,
      `declare void @scr_init()`,
      `declare void @scr_lib_init(i32, ptr)`,
    );
    for (const d of this.decls) out.push(d);
    out.push(``);
    for (const [text, lit] of this.literals) {
      // Immortal interned ScrStr: { rc = SIZE_MAX, len, cap = len, bytes\0 } —
      // the C emitter's static table, retain/release skip rc == SIZE_MAX.
      out.push(
        `@${lit.sym} = internal global { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, [${lit.len + 1} x i8] } ` +
          `{ ${this.sizeType} -1, ${this.sizeType} ${lit.len}, ${this.sizeType} ${lit.len}, [${lit.len + 1} x i8] c"${llStrBytes(text)}" }`,
      );
    }
    if (this.literals.size > 0) out.push(``);
    for (const [key, sym] of this.unitInstances) {
      // One immortal instance per unit-armed (union, tag): tag set, payload
      // slot and RC entry points zero — retain/release/collector all skip
      // rc == SIZE_MAX, so these never join the RC audit or a trace walk.
      const [unionId, tag] = key.split(":");
      out.push(
        `@${sym} = internal global %ScrUnion { ${this.sizeType} -1, i32 ${tag}, ptr null, ptr null, ptr null, i64 0 } ; ${unionId} unit arm`,
      );
    }
    if (this.unitInstances.size > 0) out.push(``);
    for (const [key, re] of this.regexInstances) {
      // One immortal ScrRegex per (pattern, flags) literal, pointing at
      // the interned source/flags strings. The bc slot starts null (lazy
      // compile, cached by the runtime) — a mutable global, not constant.
      out.push(
        `@${re.sym} = internal ${tl}global %ScrRegex { ${this.sizeType} -1, ptr ${re.src}, ptr ${re.fl}, ptr null } ; ${key.replace(/\n/g, "\\n")}`,
      );
    }
    if (this.regexInstances.size > 0) out.push(``);
    for (const [, inst] of this.templateStringsInstances) {
      // One immortal ScrArr per tagged-template site: a [N x ptr] data
      // global of interned cooked-string literals, and the ScrArr header
      // over it (rc == SIZE_MAX, len == cap, SCR_ELEM_STR = 2, no REF
      // entry points). Reads retain immortal strings — a no-op.
      const n = inst.slots.length;
      out.push(
        `@${inst.sym}_data = internal constant [${n} x ptr] [ ${inst.slots.map((s) => `ptr ${s}`).join(", ")} ]`,
        `@${inst.sym} = internal global %ScrArr { ${this.sizeType} -1, ${this.sizeType} ${n}, ${this.sizeType} ${n}, i32 2, ptr null, ptr null, ptr null, ptr @${inst.sym}_data }`,
      );
    }
    if (this.templateStringsInstances.size > 0) out.push(``);
    for (const [text, c] of this.cstrs) {
      // NUL-terminated byte-array constants: the scr_jb_puts / indent-text
      // currency (the C emitter passes string literals; these are theirs).
      out.push(
        `@${c.sym} = internal constant [${c.len + 1} x i8] c"${llStrBytes(text)}"`,
      );
    }
    if (this.cstrs.size > 0) out.push(``);
    if (usesIsland) {
      const fmt = { esm: 0, cjs: 1, json: 2 } as const;
      const edgeKind = { any: 0, import: 1, require: 2 } as const;
      embedded.modules.forEach((m, i) => {
        const stored = npmStored[i]!;
        const key = Buffer.from(m.key, "utf8");
        out.push(
          `@sc_npm_key_${i} = internal constant [${key.length + 1} x i8] c"${llBytes(key)}"`,
          `@sc_npm_src_${i} = internal constant [${stored.src.bytes.length + 1} x i8] c"${llBytes(stored.src.bytes)}"`,
        );
        if (stored.esm !== null) {
          out.push(
            `@sc_npm_esm_${i} = internal constant [${stored.esm.bytes.length + 1} x i8] c"${llBytes(stored.esm.bytes)}"`,
          );
        }
      });
      const moduleRows = embedded.modules.map((m, i) => {
        const stored = npmStored[i]!;
        const esm = stored.esm === null
          ? `ptr null, ${this.sizeType} 0, ${this.sizeType} 0`
          : `ptr @sc_npm_esm_${i}, ${this.sizeType} ${stored.esm.bytes.length}, ${this.sizeType} ${stored.esm.raw}`;
        return `%ScrIslandModule { ptr @sc_npm_key_${i}, ptr @sc_npm_src_${i}, ` +
          `${this.sizeType} ${stored.src.bytes.length}, ${this.sizeType} ${stored.src.raw}, ` +
          `i32 ${fmt[m.format]}, ${esm} }`;
      });
      out.push(
        `@sc_npm_modules = internal constant [${moduleRows.length} x %ScrIslandModule] [ ${moduleRows.join(", ")} ]`,
      );
      embedded.edges.forEach((edge, i) => {
        for (const [part, text] of [["from", edge.from], ["spec", edge.specifier], ["to", edge.to]] as const) {
          const bytes = Buffer.from(text, "utf8");
          out.push(`@sc_npm_edge_${i}_${part} = internal constant [${bytes.length + 1} x i8] c"${llBytes(bytes)}"`);
        }
      });
      if (embedded.edges.length > 0) {
        const edgeRows = embedded.edges.map((edge, i) =>
          `%ScrIslandEdge { ptr @sc_npm_edge_${i}_from, ptr @sc_npm_edge_${i}_spec, ` +
          `ptr @sc_npm_edge_${i}_to, i32 ${edgeKind[edge.kind]} }`,
        );
        out.push(`@sc_npm_edges = internal constant [${edgeRows.length} x %ScrIslandEdge] [ ${edgeRows.join(", ")} ]`);
      }
      out.push(``);
    }
    out.push(...ffiCallbacks.globals);
    if (ffiCallbacks.globals.length > 0) out.push(``);
    for (const g of globals) {
      const ty = this.llType(g.type);
      const zero = ty === "double" ? f64Lit(0) : ty === "ptr" ? "null" : "false";
      out.push(`@${mangleGlobal(g.id)} = internal ${tl}global ${ty} ${zero} ; ${g.name}`);
    }
    if (globals.length > 0) out.push(``);
    out.push(...helpers);
    out.push(...ffiCallbacks.defs);
    out.push(...shapes.defs);
    out.push(...classShapes.defs);
    out.push(...classObjDefs);
    out.push(...this.walkers.defs);
    out.push(...this.dyn.defs);
    out.push(...wrappers);
    out.push(...asyncDefs);
    out.push(...this.resolveThunkDefs);
    out.push(fnDefs.join("\n\n"), ``);

    // main(): scr_init, the program-dependent error-vt interval stamps,
    // scr_lib_init(argc, argv), then the entry function. An uncaught
    // exception escaping top-level code prints and exits 1 (Node) — the
    // C emitter's epilogue, emitted exactly when the entry may throw.
    // No event loop yet: timers/async still refuse (phase 5).
    const stamps: string[] = [];
    for (const iv of this.errorIntervals) {
      for (const [field, value] of [[0, iv.pre], [1, iv.post]] as const) {
        stamps.push(
          `  store ${this.sizeType} ${value}, ptr getelementptr inbounds ([5 x %ScrVt], ptr @scr_error_vts, i64 0, i64 ${iv.kind}, i32 ${field})${field === 1 ? ` ; ${iv.lib}` : ""}`,
        );
      }
    }
    if (this.emitterInterval !== null) {
      // The runtime emitter vtable's interval (emitterVtStampLines): bare
      // EventEmitter instances answer instanceof and dispatch dynamic
      // teardown under THIS module's preorder numbering.
      out.push(`@scr_emitter_vt = external ${tl}global %ScrVt`, ``);
      stamps.push(
        `  store ${this.sizeType} ${this.emitterInterval.pre}, ptr getelementptr inbounds (%ScrVt, ptr @scr_emitter_vt, i64 0, i32 0)`,
        `  store ${this.sizeType} ${this.emitterInterval.post}, ptr getelementptr inbounds (%ScrVt, ptr @scr_emitter_vt, i64 0, i32 1) ; EventEmitter`,
      );
    }
    for (const iv of this.streamIntervals) {
      // The runtime stream vtables' intervals (streamVtStampLines) — the
      // emitter story: instanceof and dynamic teardown dispatch through
      // them.
      out.push(`@${iv.vt} = external global %ScrVt`);
      stamps.push(
        `  store ${this.sizeType} ${iv.pre}, ptr getelementptr inbounds (%ScrVt, ptr @${iv.vt}, i64 0, i32 0)`,
        `  store ${this.sizeType} ${iv.post}, ptr getelementptr inbounds (%ScrVt, ptr @${iv.vt}, i64 0, i32 1) ; ${iv.lib}`,
      );
    }
    if (this.streamIntervals.length > 0) out.push(``);
    if (this.errorIntervals.length > 0 && this.tracedShapes.has("object:%Error")) {
      // The cycle fixpoint marked the Error hierarchy (a user subclass
      // holds cycle-capable fields — capability is hierarchy-uniform), so
      // the runtime's own error allocations need collector headers too.
      // Declared inline: the extern block already flushed (LLVM is
      // order-free, the helper-defs precedent).
      out.push(`declare void @scr_error_set_traced()`, ``);
      stamps.push(`  call void @scr_error_set_traced()`);
    }
    if ((entryMayThrow || runsLoop) && this.mod.lib === undefined) {
      // Declared inline: the extern block already flushed (LLVM is
      // order-free — the scr_error_set_traced precedent). Only the
      // printer emits here (nothing else declares it); scr_exc_pending
      // and the loop entry points rode the Set before the flush.
      out.push(`declare void @scr_exc_print_uncaught()`, ``);
    }
    if (this.mod.lib !== undefined) {
      // LIBRARY mode: no @main — the profile-declared external
      // symbols instead, from the same IR facts the C emission consumes.
      out.push(...this.emitLibDefs(globals, globalReleaseLines, stamps));
      out.push(`attributes #0 = { sanitize_address }`);
      if (this.wasi) out.push(`attributes #1 = { sanitize_address presplitcoroutine }`);
      out.push(``);
      return out.join("\n");
    }
    out.push(
      `define i32 @${this.wasi ? "__main_argc_argv" : "main"}(i32 %argc, ptr %argv) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_init()`,
      ...stamps,
      // Event-surface programs (signal/exit listeners) fill the loop's
      // nullable event hooks before %main — scr_events.c links only when
      // this line is emitted (cc.ts gates on the same predicate).
      ...(usesEvents ? [`  call void @scr_events_install()`] : []),
      // fs.watch programs fill the loop's watch hooks the same way —
      // scr_watch.c links only when this line is emitted.
      ...(usesFsWatch ? [`  call void @scr_watch_install()`] : []),
      ...(snapshotsTlsCa ? [`  call void @scr_tls_ca_install()`] : []),
      ...(usesFetch ? [`  call void @scr_fetch_install()`] : []),
      ...(embedsZlib ? [`  call void @scr_zlib_island_install()`] : []),
      ...(embedsNet ? [`  call void @scr_net_island_install()`] : []),
      ...(usesNet ? [`  call void @scr_net_install()`, `  call void @scr_net_dyn_install()`] : []),
      ...(usesHttp ? [`  call void @scr_http_dyn_install()`] : []),
      ...(usesStream ? [`  call void @scr_stream_install()`] : []),
      `  call void @scr_lib_init(i32 %argc, ptr %argv)`,
      ...(usesIsland
        ? [
            ...(moduleEmbedsCompressedNpm(this.mod)
              ? [`  call void @scr_island_set_inflate(ptr @scr_zlib_inflate_exact)`]
              : []),
            `  call void @scr_island_modules(ptr @sc_npm_modules, ${this.sizeType} ${embedded.modules.length}, ` +
              `ptr ${embedded.edges.length > 0 ? "@sc_npm_edges" : "null"}, ${this.sizeType} ${embedded.edges.length})`,
          ]
        : []),
      ...(asyncEntry
        ? [`  %top = call ptr @${mangleAsyncSpawn(this.mod.entry)}()`]
        : [`  call void @${mangleFunction(this.mod.entry)}()`]),
      // Uncaught exception from top-level code: Node exits 1.
      ...(entryMayThrow && !asyncEntry
        ? [
            `  %exc = call zeroext i1 @scr_exc_pending()`,
            `  br i1 %exc, label %uncaught, label %ok`,
            `uncaught:`,
            `  call void @scr_exc_print_uncaught()`,
            ...exitListenerLines("xu"),
            ...uncaughtReleases,
            `  ret i32 1`,
            `ok:`,
          ]
        : []),
      // The event loop runs to exhaustion (microtasks before timers). A
      // throw escaping a timer callback and unhandled promise rejections
      // both exit 1, like Node — the C main's loop block exactly.
      ...(runsLoop
        ? [
            `  %loop_rejection = call zeroext i1 @scr_loop_run(ptr ${asyncEntry ? "%top" : "null"})`,
            `  %lexc = call zeroext i1 @scr_exc_pending()`,
            `  br i1 %lexc, label %luncaught, label %lok`,
            `luncaught:`,
            `  call void @scr_exc_print_uncaught()`,
            ...(asyncEntry ? [`  call void @scr_promise_release(ptr %top)`] : []),
            ...exitListenerLines("xl"),
            ...loopReleasesU,
            `  ret i32 1`,
            `lok:`,
            `  br i1 %loop_rejection, label %lreported, label %lclean`,
            `lreported:`,
            `  call void @scr_discard_unhandled_rejections()`,
            ...(asyncEntry ? [`  call void @scr_promise_release(ptr %top)`] : []),
            ...exitListenerLines("xq"),
            ...loopReportedReleases,
            `  ret i32 1`,
            `lclean:`,
            ...(asyncEntry
              ? [
                  `  %tla_status = call i32 @scr_promise_finish_top_level(ptr %top)`,
                  `  %tla_rejected = icmp eq i32 %tla_status, 1`,
                  `  br i1 %tla_rejected, label %tla_fail, label %tla_not_rejected`,
                  `tla_fail:`,
                  // The loop already delivered every earlier-checkpoint
                  // rejection. Drop same-checkpoint competitors before
                  // surfacing the fatal module verdict.
                  `  call void @scr_discard_unhandled_rejections()`,
                  `  call void @scr_promise_rethrow_top_level(ptr %top)`,
                  `  call void @scr_promise_release(ptr %top)`,
                  `  call void @scr_exc_print_uncaught()`,
                  ...exitListenerLines("xt"),
                  ...topRejectReleases,
                  `  ret i32 1`,
                  `tla_not_rejected:`,
                  `  call void @scr_promise_release(ptr %top)`,
                ]
              : []),
            `  %rej = call zeroext i1 @scr_report_unhandled_rejections()`,
            `  br i1 %rej, label %lrej, label %lrok`,
            `lrej:`,
            ...exitListenerLines("xr"),
            ...loopReleasesR,
            `  ret i32 1`,
            `lrok:`,
            ...(asyncEntry
              ? [
                  `  %tla_pending = icmp eq i32 %tla_status, 13`,
                  `  br i1 %tla_pending, label %tla_stuck, label %tla_ok`,
                  `tla_stuck:`,
                  ...topPendingExitLines(),
                  `tla_ok:`,
                ]
              : []),
          ]
        : []),
      ...exitListenerLines("xn"),
      ...globalReleases,
      ...(usesNodeTest
        ? [`  %test_exit = call i32 @scr_test_exit_code()`, `  ret i32 %test_exit`]
        : usesIsland
        ? [`  %island_exit = call i32 @scr_island_exit_code()`, `  ret i32 %island_exit`]
        : [`  ret i32 0`]),
      `}`,
      ``,
      // sanitize_address is inert under the plain pipeline; the sanitized
      // lane's -fsanitize=address link activates instrumentation over the
      // emitted functions too (the runtime TUs get theirs from clang).
      `attributes #0 = { sanitize_address }`,
      ...(this.wasi ? [`attributes #1 = { sanitize_address presplitcoroutine }`] : []),
      ``,
    );
    return out.join("\n");
  }

  /** LIBRARY mode: the profile-declared external definitions — the
   * export-map wrappers plus init / sink-registration / reset / collect.
   * Plain `define` (not `define internal`) — the exact linkage distinction
   * that separates the executable lane's @main from everything else. The
   * bodies delegate every runtime half to scr_library.c, mirroring the C
   * emission line for line, so the two lanes are identical by
   * construction. */
  private emitLibDefs(
    globals: IrGlobal[],
    globalReleaseLines: (prefix: string) => string[],
    stamps: string[],
  ): string[] {
    const lib = this.mod.lib!;
    const autoReset = lib.resultResetSymbol === null;
    const out: string[] = [``, `; ── library-mode entries (profile: ${lib.profileName}) ──`, ``];
    // Every entry's prologue records its external symbol in the funnel's
    // current-entry slot (structured trap-teaching field 2); the symbols
    // live as internal constants, one per entry.
    const symConst = (sym: string): string => `@sc_lib_sym_${sym}`;
    const emitSymConst = (sym: string): void => {
      out.push(`${symConst(sym)} = internal constant [${Buffer.byteLength(sym, "utf8") + 1} x i8] c"${llStrBytes(sym)}"`);
    };
    emitSymConst(lib.initSymbol);
    if (lib.resultResetSymbol !== null) emitSymConst(lib.resultResetSymbol);
    if (lib.collectSymbol !== null) emitSymConst(lib.collectSymbol);
    for (const e of lib.exports) emitSymConst(e.symbol);
    out.push(``);
    // The runtime detected-trap overlay table (scr_runtime.h declares it,
    // the library trap funnel consults it): flat code/teaching/remediation
    // triples, one per runtime trap code (SC4013–SC4019) the profile
    // declares text for — the same data the C emission defines, so the
    // funnel-assembled sink message is emission-invariant by construction.
    // The empty table still defines the symbols the funnel links against.
    const ovlCells: string[] = [];
    lib.trapOverlays.forEach((o, i) => {
      const cell = (name: string, text: string | undefined): void => {
        if (text === undefined) {
          ovlCells.push("ptr null");
          return;
        }
        const sym = `@sc_lib_ovl_${i}_${name}`;
        out.push(`${sym} = internal constant [${Buffer.byteLength(text, "utf8") + 1} x i8] c"${llStrBytes(text)}"`);
        ovlCells.push(`ptr ${sym}`);
      };
      cell("code", o.code);
      cell("teach", o.teaching);
      cell("rem", o.remediation);
    });
    out.push(
      ovlCells.length === 0
        ? `@scr_library_trap_overlays = constant [1 x ptr] zeroinitializer`
        : `@scr_library_trap_overlays = constant [${ovlCells.length} x ptr] [${ovlCells.join(", ")}]`,
      `@scr_library_trap_overlays_len = constant ${this.sizeType} ${lib.trapOverlays.length}`,
      ``,
    );
    // The init entry: full deterministic reset-and-reevaluate. Program
    // globals release and zero first (run-once guards included), then the
    // runtime session reset, the error-vt interval stamps verbatim from
    // the executable main, %main itself, and the escaped-exception check.
    const zeroStores = globals.map((g) => {
      const ty = this.llType(g.type);
      const zero = ty === "double" ? f64Lit(0) : ty === "ptr" ? "null" : "false";
      return `  store ${ty} ${zero}, ptr @${mangleGlobal(g.id)} ; ${g.name}`;
    });
    out.push(
      `define void @${lib.initSymbol}() ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_entry(i1 zeroext true, ptr ${symConst(lib.initSymbol)}) ; init always resets the result arena`,
      ...globalReleaseLines("ci"),
      ...zeroStores,
      `  call void @scr_library_reset()`,
      ...stamps,
      `  call void @${mangleFunction(this.mod.entry)}()`,
      `  call void @scr_library_check_exc()`,
      `  ret void`,
      `}`,
      ``,
      `define void @${lib.sinkRegisterSymbol}(ptr %fn, ptr %ctx) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_set_sink(ptr %fn, ptr %ctx)`,
      `  ret void`,
      `}`,
      ``,
    );
    if (lib.callbacks !== undefined && lib.callbacks.length > 0) {
      // Host-callback channels: the per-channel name constants (the
      // registration dispatch's strcmp operands), the per-channel
      // unregistered-call trap constants (the ffiCall sites'
      // scr_library_cb_require operands — same bytes as the C emission by
      // construction), and the registration define: a pure store dispatch
      // (the sink registration's rule — no entry prologue, no poison
      // guard). An unknown or NULL name is a defined -1, never a store.
      for (const cb of lib.callbacks) {
        out.push(
          `@sc_lib_cb_name_${cb.slot} = internal constant [${Buffer.byteLength(cb.name, "utf8") + 1} x i8] c"${llStrBytes(cb.name)}"`,
          `@sc_lib_cb_trap_${cb.slot} = internal constant [${Buffer.byteLength(cb.unregisteredTrap, "utf8") + 1} x i8] c"${llStrBytes(cb.unregisteredTrap)}"`,
        );
      }
      out.push(
        ``,
        `define i32 @${lib.callbackRegisterSymbol}(ptr %name, ptr %fn, ptr %ctx) ${FN_ATTRS} {`,
        `entry:`,
        `  %isnull = icmp eq ptr %name, null`,
        `  br i1 %isnull, label %miss, label %try0`,
      );
      lib.callbacks.forEach((cb, i) => {
        const next = i + 1 < lib.callbacks!.length ? `try${i + 1}` : "miss";
        out.push(
          `try${i}: ; channel '${cb.name}'`,
          `  %cmp${i} = call i32 @strcmp(ptr %name, ptr @sc_lib_cb_name_${cb.slot})`,
          `  %eq${i} = icmp eq i32 %cmp${i}, 0`,
          `  br i1 %eq${i}, label %set${i}, label %${next}`,
          `set${i}:`,
          `  call void @scr_library_cb_set(${this.sizeType} ${cb.slot}, ptr %fn, ptr %ctx)`,
          `  ret i32 0`,
        );
      });
      out.push(`miss:`, `  ret i32 -1`, `}`, ``);
    }
    if (lib.identity !== undefined) {
      // Profile-declared identity getters (the ask-2 sidecar's boot-time
      // pairing fence): pure data returns with NO entry prologue — exempt
      // from the poisoned guard and every runtime touch (ratified), so a
      // host can read them before init and after a trap. The u64 rides
      // i64 two's-complement (LLVM integer constants are signed).
      const buildId = BigInt.asIntN(64, BigInt(`0x${lib.identity.buildId}`)).toString();
      out.push(
        `define i64 @${lib.identity.buildIdSymbol}() ${FN_ATTRS} { ; identity getter build_id 0x${lib.identity.buildId}`,
        `entry:`,
        `  ret i64 ${buildId}`,
        `}`,
        ``,
        `define i32 @${lib.identity.abiVersionSymbol}() ${FN_ATTRS} { ; identity getter abi_version`,
        `entry:`,
        `  ret i32 ${lib.identity.abiVersion}`,
        `}`,
        ``,
      );
    }
    if (lib.resultResetSymbol !== null) {
      out.push(
        `define void @${lib.resultResetSymbol}() ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst(lib.resultResetSymbol)})`,
        `  call void @scr_library_arena_reset()`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    if (lib.collectSymbol !== null) {
      out.push(
        `define void @${lib.collectSymbol}() ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst(lib.collectSymbol)})`,
        `  call void @scr_library_collect() ; arena reset + a full cycle collection`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    for (const e of lib.exports) {
      const params: string[] = [];
      const body: string[] = [`  call void @scr_library_entry(i1 zeroext ${autoReset ? "true" : "false"}, ptr ${symConst(e.symbol)})`];
      const args: string[] = [];
      if (e.inboundBytesTrap !== undefined) {
        // The bytes-in helper's trap message: the compiler-assembled
        // structured trap-teaching form (0x01 text 0x1F SC4012 0x1F symbol
        // [0x1F remediation]) — the same bytes the C emission passes, so
        // the sink message is emission-invariant by construction.
        const trapBytes = Buffer.byteLength(e.inboundBytesTrap, "utf8");
        out.push(`@sc_lib_bytes_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundBytesTrap)}"`, ``);
      }
      if (e.inboundIntTrap !== undefined) {
        // The i64/u64-in helpers' host-contract trap message (ask 4): an
        // inbound integer past ±(2^53−1) cannot ride f64 exactly. Same
        // assembled structured form, same SC4012 code, same
        // emission-invariance argument as the bytes trap.
        const trapBytes = Buffer.byteLength(e.inboundIntTrap, "utf8");
        out.push(`@sc_lib_int_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundIntTrap)}"`, ``);
      }
      e.params.forEach((cls, i) => {
        switch (cls) {
          case "f64":
            params.push(`double %a${i}`);
            args.push(`double %a${i}`);
            break;
          case "bool":
            params.push(`i8 %a${i}`);
            body.push(`  %c${i} = icmp ne i8 %a${i}, 0`);
            args.push(`i1 %c${i}`);
            break;
          case "u8":
            params.push(`i8 %a${i}`);
            body.push(`  %c${i} = uitofp i8 %a${i} to double`);
            args.push(`double %c${i}`);
            break;
          case "u32":
            params.push(`i32 %a${i}`);
            body.push(`  %c${i} = uitofp i32 %a${i} to double`);
            args.push(`double %c${i}`);
            break;
          case "i32":
            params.push(`i32 %a${i}`);
            body.push(`  %c${i} = sitofp i32 %a${i} to double`);
            args.push(`double %c${i}`);
            break;
          case "i64":
            // Inbound declared-integer edge (ask 4): the helper converts
            // exactly or delivers the host-contract trap (past ±(2^53−1)
            // the value cannot ride f64 without silent rounding).
            params.push(`i64 %a${i}`);
            body.push(`  %c${i} = call double @scr_library_i64_in(i64 %a${i}, ptr @sc_lib_int_trap_${e.symbol})`);
            args.push(`double %c${i}`);
            break;
          case "u64":
            params.push(`i64 %a${i}`);
            body.push(`  %c${i} = call double @scr_library_u64_in(i64 %a${i}, ptr @sc_lib_int_trap_${e.symbol})`);
            args.push(`double %c${i}`);
            break;
          case "string":
            params.push(`ptr %a${i}_ptr`, `${this.sizeType} %a${i}_len`);
            body.push(`  %c${i} = call ptr @scr_library_str_in(ptr %a${i}_ptr, ${this.sizeType} %a${i}_len)`);
            args.push(`ptr %c${i}`);
            break;
          case "bytes":
            params.push(`ptr %a${i}_ptr`, `${this.sizeType} %a${i}_len`);
            body.push(`  %c${i} = call ptr @scr_library_bytes_in(ptr %a${i}_ptr, ${this.sizeType} %a${i}_len, ptr @sc_lib_bytes_trap_${e.symbol})`);
            args.push(`ptr %c${i}`);
            break;
        }
      });
      if (e.returns === "string" || e.returns === "bytes") {
        params.push(`ptr %out`, `ptr %out_len`);
      }
      const target = `@${mangleFunction(e.fnName)}`;
      const callArgs = args.join(", ");
      let retType = "void";
      switch (e.returns) {
        case "void":
          body.push(`  call void ${target}(${callArgs})`, `  call void @scr_library_check_exc()`, `  ret void`);
          break;
        case "f64":
          retType = "double";
          body.push(
            `  %r = call double ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  ret double %r`,
          );
          break;
        case "i64":
        case "u64":
          // The outbound declared-integer edge (ask 4): every value
          // reaching this return was PROVEN whole and inside the class's
          // range at compile time, so the fp-to-int conversion is exact
          // by construction — the crossing carries the mathematically
          // exact integer the f64 held.
          retType = "i64";
          body.push(
            `  %r = call double ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  %z = ${e.returns === "i64" ? "fptosi" : "fptoui"} double %r to i64`,
            `  ret i64 %z`,
          );
          break;
        case "bool":
          retType = "i8";
          body.push(
            `  %r = call i1 ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  %z = zext i1 %r to i8`,
            `  ret i8 %z`,
          );
          break;
        case "string":
          body.push(
            `  %r = call ptr ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  call void @scr_library_str_out(ptr %r, ptr %out, ptr %out_len)`,
            `  ret void`,
          );
          break;
        case "bytes":
          body.push(
            `  %r = call ptr ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  call void @scr_library_bytes_out(ptr %r, ptr %out, ptr %out_len)`,
            `  ret void`,
          );
          break;
      }
      out.push(
        `define ${retType} @${e.symbol}(${params.join(", ")}) ${FN_ATTRS} { ; library export ${e.fnName}`,
        `entry:`,
        ...body,
        `}`,
        ``,
      );
    }
    return out;
  }

  /** The shared abort helpers (emitted only when referenced): the OOM
   * abort of untraced shape allocation and the invalid-union-tag abort —
   * both print the C emitter's exact message on fd 2 and abort. */
  private helperDefs(): string[] {
    const defs: string[] = [];
    const msgHelper = (fnName: string, msgSym: string, msg: string): void => {
      // The message routes through the runtime's trap funnel: executable
      // builds expand to the historical bytes-on-stderr + abort; library
      // builds route to the registered panic sink (scr_runtime.h).
      const bytes = Buffer.byteLength(msg, "utf8");
      this.declare(`declare void @scr_trap(ptr)`);
      defs.push(
        `@${msgSym} = internal constant [${bytes + 1} x i8] c"${llStrBytes(msg)}"`,
        `define internal void @${fnName}() ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_trap(ptr @${msgSym})`,
        `  unreachable`,
        `}`,
        ``,
      );
    };
    if (this.needsOom) msgHelper("sc_oom", "sc_oom_msg", "scriptc: out of memory\n");
    if (this.needsBadTag) {
      msgHelper("sc_bad_tag", "sc_bad_tag_msg", "scriptc: internal error: invalid union tag\n");
    }
    if (this.needsBadKey) {
      // The keyed-read miss on a result type that cannot say `undefined`:
      // trap like an array OOB read instead of corrupting a typed slot
      // (SEMANTICS.md; the C helper's message additionally interpolates
      // the runtime key — a trap-path debugging nicety, never reachable
      // by a program whose behavior matches Node).
      msgHelper(
        "sc_bad_key",
        "sc_bad_key_msg",
        "scriptc: TypeError: record has no key (typed slot — no undefined is representable)\n",
      );
    }
    if (this.needsRetainBox) {
      // scr_box_retain is a static inline (increment-unless-immortal, then
      // mark the cycle header live — every box is collector-headered);
      // emitted once with internal linkage, like the record retains.
      defs.push(
        `define internal ptr @sc_retain_box(ptr %b) ${FN_ATTRS} {`,
        `entry:`,
        `  %rc = load ${this.sizeType}, ptr %b`,
        `  %imm = icmp eq ${this.sizeType} %rc, -1`,
        `  br i1 %imm, label %done, label %inc`,
        `inc:`,
        `  %n = add ${this.sizeType} %rc, 1`,
        `  store ${this.sizeType} %n, ptr %b`,
        `  %colorp = getelementptr i8, ptr %b, ${this.sizeType} -${this.cycleColorOffset}`,
        `  store i32 0, ptr %colorp ; mark live`,
        `  br label %done`,
        `done:`,
        `  ret ptr %b`,
        `}`,
        ``,
      );
    }
    // The declarations these helpers added must land in the extern block,
    // which already flushed — append here instead (LLVM is order-free).
    return defs.length > 0 ? [...defs] : defs;
  }

  /** Env-signature wrappers + interned immortal closures for declared
   * functions used as values (the C emitter's sc_w_/sc_fc_ pair): every
   * mention of `f` yields the same pointer, so `f === f` holds. */
  private emitFnValueDefs(): string[] {
    const out: string[] = [];
    for (const name of this.fnValues) {
      const fn = this.fnByName.get(name)!;
      const params = fn.params.map((p, i) => `${this.llType(p.type)} %a${i}`);
      const args = fn.params.map((p, i) => `${this.llType(p.type)} %a${i}`).join(", ");
      // Async/generator functions as values enter through their spawn
      // wrapper: the call answers the promise / generator object (+1),
      // never the inner return type.
      const ret = fn.async === true || fn.generator !== undefined ? "ptr" : this.llType(fn.returnType);
      const call = `call ${ret} @${this.callTarget(name)}(${args})`;
      out.push(
        `define internal ${ret} @${mangleWrapper(name)}(ptr %env${params.length ? ", " + params.join(", ") : ""}) ${FN_ATTRS} { ; ${name} as a value`,
        `entry:`,
        ret === "void" ? `  ${call}` : `  %r = ${call}`,
        ret === "void" ? `  ret void` : `  ret ${ret} %r`,
        `}`,
        `@${mangleFnClosure(name)} = internal global %ScrClosure { ${this.sizeType} -1, ptr @${mangleWrapper(name)}, ${this.sizeType} 0, ptr null }`,
        ``,
      );
    }
    return out;
  }

  /** Per-async-function machinery — emit-async.ts's scaffolding, .ll
   * flavored: an argument-pack struct type, a fiber trampoline (unpacks,
   * frees the pack, runs the ordinary compiled body, settles the
   * promise — fulfilling on clean return, leaving a pending exception
   * for the runtime to reject with), and a spawn wrapper call sites and
   * closures enter through (packs the args +1, scr_async_spawn runs the
   * fiber eagerly to its first suspension and returns the promise). */
  private emitAsyncScaffolding(): string[] {
    const out: string[] = [];
    if (this.wasi) {
      this.declare(`declare void @llvm.coro.resume(ptr)`);
      this.declare(`declare void @llvm.coro.destroy(ptr)`);
      out.push(
        `define void @scr_wasi_coro_resume(ptr %handle) ${FN_ATTRS} {`,
        `entry:`,
        `  call void @llvm.coro.resume(ptr %handle)`,
        `  ret void`,
        `}`,
        `define void @scr_wasi_coro_destroy(ptr %handle) ${FN_ATTRS} {`,
        `entry:`,
        `  call void @llvm.coro.destroy(ptr %handle)`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    for (const fn of this.mod.functions) {
      if (fn.async !== true) continue;
      const pack = mangleArgPack(fn.name);
      const lifted = fn.captures !== undefined;
      const fieldTys = [...(lifted ? ["ptr"] : []), ...fn.params.map((p) => this.llType(p.type))];
      out.push(`%${pack} = type { ${fieldTys.join(", ") || "i8"} } ; ${fn.name} args`);
      const sizeOf = `ptrtoint (ptr getelementptr (%${pack}, ptr null, i32 1) to ${this.sizeType})`;

      this.declare(`declare void @free(ptr)`);
      this.declare(`declare ptr @malloc(${this.sizeType})`);
      this.declare(`declare zeroext i1 @scr_exc_pending()`);
      this.declare(`declare ptr @scr_fiber_promise(ptr)`);
      this.declare(`declare ptr @scr_async_spawn(ptr, ptr)`);
      this.needOom();

      // Trampoline: unpack, free, run the body, settle.
      const tr: string[] = [
        `define internal void @${mangleTrampoline(fn.name)}(ptr %self, ptr %ap) ${FN_ATTRS} {`,
        `entry:`,
      ];
      const loads: string[] = [];
      fieldTys.forEach((ty, i) => {
        tr.push(
          `  %fp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
          `  %a${i} = load ${ty}, ptr %fp${i}`,
        );
        loads.push(`${ty} %a${i}`);
      });
      tr.push(`  call void @free(ptr %ap)`);
      const ret = fn.returnType;
      const retTy = this.llType(ret);
      const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${loads.join(", ")})`;
      tr.push(retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`);
      if (this.wasi) {
        // The coroutine body settles its own promise and owns the retained
        // lifted environment until final suspension. Its initial call
        // returns here at the first suspend (or final suspend).
        tr.push(`  ret void`, `}`, ``);
      } else {
        if (lifted) {
          this.declare(`declare void @scr_closure_release(ptr)`);
          tr.push(`  call void @scr_closure_release(ptr %a0)`);
        }
        tr.push(
          `  %pend = call zeroext i1 @scr_exc_pending()`,
          `  br i1 %pend, label %thrown, label %clean`,
          `clean:`,
          `  %pr = call ptr @scr_fiber_promise(ptr %self)`,
        );
        switch (ret.kind) {
          case "void":
            this.declare(`declare void @scr_promise_fulfill_void(ptr)`);
            tr.push(`  call void @scr_promise_fulfill_void(ptr %pr)`);
            break;
          case "f64":
          case "date":
            this.declare(`declare void @scr_promise_fulfill_f64(ptr, double)`);
            tr.push(`  call void @scr_promise_fulfill_f64(ptr %pr, double %r)`);
            break;
          case "bool":
            this.declare(`declare void @scr_promise_fulfill_bool(ptr, i1 zeroext)`);
            tr.push(`  call void @scr_promise_fulfill_bool(ptr %pr, i1 %r)`);
            break;
          case "string":
            this.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
            tr.push(`  call void @scr_promise_fulfill_str(ptr %pr, ptr %r) ; moves in`);
            break;
          default: {
            const v = vAdapters(this, ret);
            this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
            tr.push(
              `  call void @scr_promise_fulfill_ref(ptr %pr, ptr %r, ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(this, ret)})`,
            );
          }
        }
        tr.push(`  ret void`, `thrown:`);
        if (ret.kind !== "void" && isRefCounted(ret)) {
          // An escaping throw means %r is the never-read dummy (NULL).
          tr.push(`  call void ${releaseSym(this, ret)}(ptr %r)`);
        }
        tr.push(`  ret void`, `}`, ``);
      }
      out.push(...tr);

      // Spawn wrapper: pack the args (+1 moves in), spawn the fiber.
      const params = fieldTys.map((ty, i) => `${ty} %a${i}`);
      const cache = fn.asyncCacheGlobal !== undefined ? mangleGlobal(fn.asyncCacheGlobal) : null;
      const cycleCache =
        fn.asyncCycleCacheGlobal !== undefined ? mangleGlobal(fn.asyncCycleCacheGlobal) : null;
      if (cache !== null || cycleCache !== null) {
        this.declare(`declare ptr @scr_promise_retain_v(ptr)`);
        this.declare(`declare void @scr_promise_release(ptr)`);
      }
      if (cache !== null) {
        this.declare(`declare void @scr_promise_mark_handled(ptr)`);
      }
      const sp: string[] = [
        `define internal ptr @${mangleAsyncSpawn(fn.name)}(${params.join(", ")}) ${FN_ATTRS} { ; spawn ${fn.name}`,
        `entry:`,
        ...(cache !== null
          ? [
              `  %cached = load ptr, ptr @${cache}`,
              `  %cache_hit = icmp ne ptr %cached, null`,
              `  br i1 %cache_hit, label %cached_return, label %cache_miss`,
              `cached_return:`,
              `  %cached_owned = call ptr @scr_promise_retain_v(ptr %cached)`,
              `  ret ptr %cached_owned`,
              `cache_miss:`,
            ]
          : []),
        `  %ap = call ptr @malloc(${this.sizeType} ${sizeOf})`,
        `  %isnull = icmp eq ptr %ap, null`,
        `  br i1 %isnull, label %oom, label %ok`,
        `oom:`,
        `  call void @sc_oom()`,
        `  unreachable`,
        `ok:`,
      ];
      if (lifted) {
        // scr_closure_retain is a header static inline — the `_v` twin is
        // the exported symbol.
        this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
        sp.push(`  %env = call ptr @scr_closure_retain_v(ptr %a0)`);
      }
      fieldTys.forEach((ty, i) => {
        const src = lifted && i === 0 ? "%env" : `%a${i}`;
        sp.push(
          `  %sp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
          `  store ${ty} ${src}, ptr %sp${i}`,
        );
      });
      sp.push(
        `  %p = call ptr @scr_async_spawn(ptr @${mangleTrampoline(fn.name)}, ptr %ap)`,
        ...(cache !== null
          ? [
              // The module loader owns this evaluation promise
              // immediately. A later sibling can throw before the
              // aggregate dependency wait is built, but this rejection
              // must never become an unrelated unhandled rejection.
              `  call void @scr_promise_mark_handled(ptr %p)`,
            ]
          : []),
        ...(cache !== null
          ? [
              `  %cache_owned = call ptr @scr_promise_retain_v(ptr %p)`,
              // The eager spawn may have re-entered this guarded module
              // through an admitted async cycle and installed a temporary
              // cache entry. Drop that owned slot before replacing it
              // with the outer evaluation promise.
              `  %replaced_cache = load ptr, ptr @${cache}`,
              `  call void @scr_promise_release(ptr %replaced_cache)`,
              `  store ptr %cache_owned, ptr @${cache}`,
            ]
          : []),
        ...(cycleCache !== null
          ? [
              // Eager recursive spawns publish from the inside out. The
              // runtime-requested outermost member writes last and is the
              // SCC's actual evaluation root.
              `  %cycle_cache_owned = call ptr @scr_promise_retain_v(ptr %p)`,
              `  %replaced_cycle_cache = load ptr, ptr @${cycleCache}`,
              `  call void @scr_promise_release(ptr %replaced_cycle_cache)`,
              `  store ptr %cycle_cache_owned, ptr @${cycleCache}`,
            ]
          : []),
        `  ret ptr %p`,
        `}`,
        ``,
      );
      out.push(...sp);
    }
    out.push(...this.emitGenScaffolding());
    return out;
  }

  /** Per-generator-function machinery — the async scaffolding's lazy
   * sibling (emit-async.ts's emitGenScaffolding): the same argument pack,
   * a fiber trampoline whose epilogue stores the COMPLETION value (or
   * consumes the GENRET sentinel, promoting the parked .return value), a
   * spawn wrapper that only ALLOCATES the suspended fiber, and the
   * never-started teardown that drops the packed (+1) arguments. */
  private emitGenScaffolding(): string[] {
    const out: string[] = [];
    for (const fn of this.mod.functions) {
      if (fn.generator === undefined) continue;
      const pack = mangleArgPack(fn.name);
      const lifted = fn.captures !== undefined;
      const fieldTys = [...(lifted ? ["ptr"] : []), ...fn.params.map((p) => this.llType(p.type))];
      out.push(`%${pack} = type { ${fieldTys.join(", ") || "i8"} } ; ${fn.name} args`);
      const sizeOf = `ptrtoint (ptr getelementptr (%${pack}, ptr null, i32 1) to ${this.sizeType})`;

      this.declare(`declare void @free(ptr)`);
      this.declare(`declare ptr @malloc(${this.sizeType})`);
      this.declare(`declare zeroext i1 @scr_exc_pending()`);
      this.declare(`declare zeroext i1 @scr_exc_genret_pending()`);
      this.declare(`declare void @scr_exc_clear()`);
      this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
      this.declare(`declare void @scr_gen_ret_to_out(ptr)`);
      this.declare(`declare ptr @scr_gen_new(ptr, ptr, ptr)`);
      this.needOom();

      const tr: string[] = [
        `define internal void @${mangleTrampoline(fn.name)}(ptr %self, ptr %ap) ${FN_ATTRS} {`,
        `entry:`,
      ];
      const loads: string[] = [];
      fieldTys.forEach((ty, i) => {
        tr.push(
          `  %fp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
          `  %a${i} = load ${ty}, ptr %fp${i}`,
        );
        loads.push(`${ty} %a${i}`);
      });
      tr.push(`  call void @free(ptr %ap)`);
      const ret = fn.returnType;
      const retTy = this.llType(ret);
      const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${loads.join(", ")})`;
      tr.push(retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`);
      if (lifted && !this.wasi) {
        this.declare(`declare void @scr_closure_release(ptr)`);
        tr.push(`  call void @scr_closure_release(ptr %a0)`);
      }
      // Normal completion stores the (typed) return value; void completes
      // with the NONE slot — JS's undefined done-value. A GENRET unwind
      // consumes the sentinel and promotes the parked .return value; a
      // real exception stays pending (the consumer-side resume moves it).
      if (this.wasi) {
        tr.push(`  ret void`, `}`, ``);
      } else {
      tr.push(
        `  %g = call ptr @scr_gen_of_fiber(ptr %self)`,
        `  %pend = call zeroext i1 @scr_exc_pending()`,
        `  br i1 %pend, label %thrown, label %clean`,
        `clean:`,
      );
      switch (ret.kind) {
        case "void":
          tr.push(`  br label %done ; void body: the done value is undefined (NONE)`);
          break;
        case "f64":
        case "date":
          this.declare(`declare void @scr_gen_out_f64(ptr, double)`);
          tr.push(`  call void @scr_gen_out_f64(ptr %g, double %r)`, `  br label %done`);
          break;
        case "bool":
          this.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
          tr.push(`  call void @scr_gen_out_bool(ptr %g, i1 %r)`, `  br label %done`);
          break;
        default: {
          const v = vAdapters(this, ret);
          this.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
          tr.push(`  call void @scr_gen_out_ref(ptr %g, ptr %r, ptr ${v.release})`, `  br label %done`);
        }
      }
      tr.push(
        `thrown:`,
        `  %genret = call zeroext i1 @scr_exc_genret_pending()`,
        `  br i1 %genret, label %promote, label %dropdummy`,
        `promote:`,
        `  call void @scr_exc_clear()`,
        `  call void @scr_gen_ret_to_out(ptr %g)`,
        `  br label %dropdummy`,
        `dropdummy:`,
      );
      if (ret.kind !== "void" && isRefCounted(ret)) {
        tr.push(`  call void ${releaseSym(this, ret)}(ptr %r) ; unwound: the never-read dummy`);
      }
      tr.push(`  br label %done`, `done:`, `  ret void`, `}`, ``);
      }
      out.push(...tr);

      // The never-started teardown: drop the packed (+1) arguments.
      const dr: string[] = [
        `define internal void @${mangleGenDrop(fn.name)}(ptr %ap) ${FN_ATTRS} {`,
        `entry:`,
      ];
      fieldTys.forEach((ty, i) => {
        const pType = lifted && i === 0 ? null : fn.params[lifted ? i - 1 : i]!.type;
        const refcounted = pType === null || isRefCounted(pType);
        if (!refcounted) return;
        dr.push(
          `  %dp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
          `  %dv${i} = load ptr, ptr %dp${i}`,
        );
        if (pType === null) {
          this.declare(`declare void @scr_closure_release(ptr)`);
          dr.push(`  call void @scr_closure_release(ptr %dv${i})`);
        } else {
          dr.push(`  call void ${releaseSym(this, pType)}(ptr %dv${i})`);
        }
      });
      dr.push(`  call void @free(ptr %ap)`, `  ret void`, `}`, ``);
      out.push(...dr);

      // Spawn wrapper: pack the args (+1 moves in), allocate the
      // SUSPENDED fiber — nothing runs until the first .next().
      const params = fieldTys.map((ty, i) => `${ty} %a${i}`);
      const sp: string[] = [
        `define internal ptr @${mangleGenSpawn(fn.name)}(${params.join(", ")}) ${FN_ATTRS} { ; gen spawn ${fn.name}`,
        `entry:`,
        `  %ap = call ptr @malloc(${this.sizeType} ${sizeOf})`,
        `  %isnull = icmp eq ptr %ap, null`,
        `  br i1 %isnull, label %oom, label %ok`,
        `oom:`,
        `  call void @sc_oom()`,
        `  unreachable`,
        `ok:`,
      ];
      if (lifted) {
        this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
        sp.push(`  %env = call ptr @scr_closure_retain_v(ptr %a0)`);
      }
      fieldTys.forEach((ty, i) => {
        const src = lifted && i === 0 ? "%env" : `%a${i}`;
        sp.push(
          `  %sp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
          `  store ${ty} ${src}, ptr %sp${i}`,
        );
      });
      sp.push(
        `  %gg = call ptr @scr_gen_new(ptr @${mangleTrampoline(fn.name)}, ptr %ap, ptr @${mangleGenDrop(fn.name)})`,
        `  ret ptr %gg`,
        `}`,
        ``,
      );
      out.push(...sp);
    }
    return out;
  }

  // ── plumbing (the CEmitter frame/scope machinery, alloca-flavored) ──────

  internLiteral(text: string): string {
    let lit = this.literals.get(text);
    if (!lit) {
      lit = { sym: `sc_lit_${this.literals.size}`, len: Buffer.byteLength(text, "utf8") };
      this.literals.set(text, lit);
    }
    return `@${lit.sym}`;
  }

  /** Interned NUL-terminated C-string constant (the scr_jb_puts /
   * stringify-indent currency) — `@`-ref, first-use order. */
  cstr(text: string): string {
    let c = this.cstrs.get(text);
    if (!c) {
      c = { sym: `sc_cs_${this.cstrs.size}`, len: Buffer.byteLength(text, "utf8") };
      this.cstrs.set(text, c);
    }
    return `@${c.sym}`;
  }

  needBadTag(): void {
    this.needsBadTag = true;
  }

  /** The interned immortal instance for a UNIT arm of a union — asserts
   * the arm really is payload-less (undefined/null). Public: class
   * emission initializes undefined-admitting fields through it
   * (ClassHost). */
  unitInstanceRef(unionId: string, tag: number): string {
    const arm = this.unionsById.get(unionId)?.arms[tag];
    if (!arm || !isUnitType(arm)) {
      throw new Error(`llvm emitter bug: unit instance for non-unit arm ${tag} of ${unionId}`);
    }
    const key = `${unionId}:${tag}`;
    let sym = this.unitInstances.get(key);
    if (!sym) {
      sym = `sc_unit_${this.unitInstances.size}`;
      this.unitInstances.set(key, sym);
    }
    return `@${sym}`;
  }

  /** The undefined arm's tag of a union type, or -1 (not a union / no
   * undefined arm). */
  undefinedArmTag(t: IrType): number {
    if (t.kind !== "union") return -1;
    const def = this.unionsById.get(t.unionId);
    return def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
  }

  declare(decl: string): void {
    this.decls.add(decl);
  }

  needOom(): void {
    this.needsOom = true;
  }

  private currentFrame(): LlValue[] {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) throw new Error("llvm emitter bug: no active statement frame");
    return frame;
  }

  /** Registers an owned refcounted value on the current statement frame. */
  private own(v: LlValue): LlValue {
    if (isRefCounted(v.type)) this.currentFrame().push(v);
    return v;
  }

  /** Registers a SLOT whose current contents the frame owns (conditional
   * results: optional chains, branch joins that park ownership). */
  private ownSlot(slot: string, type: IrType): void {
    if (isRefCounted(type)) this.currentFrame().push({ name: slot, type, slot: true });
  }

  /** Strike a refcounted temp from its frame: ownership is being moved. */
  private moveTemp(v: LlValue): void {
    if (!isRefCounted(v.type)) return;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const idx = this.frames[i]!.findIndex((e) => e.name === v.name);
      if (idx >= 0) {
        this.frames[i]!.splice(idx, 1);
        return;
      }
    }
    throw new Error(`llvm emitter bug: moved temp ${v.name} not found in any frame`);
  }

  /** The retained (+1) read of a refcounted value — type-directed through
   * the `_v` table (immortals skip, exactly the C retain calls). */
  private retainValue(name: string, type: IrType): string {
    const t = this.B.tmp();
    this.B.line(`${t} = call ptr ${retainSym(this, type)}(ptr ${name})`);
    return t;
  }

  /** The release call for one owned refcounted value — type-directed like
   * releaseCallC (all runtime releases are NULL-tolerant). */
  private releaseValue(name: string, type: IrType): void {
    this.B.line(`call void ${releaseSym(this, type)}(ptr ${name})`);
  }

  private releaseFrame(frame: LlValue[]): void {
    for (const v of frame) {
      if (v.slot) {
        const t = this.B.tmp();
        this.B.line(`${t} = load ptr, ptr ${v.name}`);
        this.releaseValue(t, v.type);
      } else {
        this.releaseValue(v.name, v.type);
      }
    }
  }

  private releaseScope(scope: LlScopeEntry[]): void {
    for (const e of scope) {
      const t = this.B.tmp();
      this.B.line(`${t} = load ptr, ptr ${e.slot}`);
      if (e.boxed) {
        this.declare(`declare void @scr_box_release(ptr)`);
        this.B.line(`call void @scr_box_release(ptr ${t})`);
      } else {
        this.releaseValue(t, e.type); // runtime releases are NULL-tolerant
      }
    }
  }

  /** THE release-on-jump path (break/continue/return): pending statement
   * frames and entered scopes down to the given depths, innermost first —
   * everything whose normal fall-through releases the jump bypasses.
   * Ported verbatim from CEmitter.releaseForJump. */
  private releaseForJump(frameDepth: number, scopeDepth: number): void {
    for (let i = this.frames.length - 1; i >= frameDepth; i--) this.releaseFrame(this.frames[i]!);
    for (let i = this.scopes.length - 1; i >= scopeDepth; i--) this.releaseScope(this.scopes[i]!);
  }

  private endsWithJump(stmts: IrStmt[]): boolean {
    const last = stmts[stmts.length - 1]?.kind;
    return last === "return" || last === "break" || last === "continue" ||
      last === "throw" || last === "rethrow" || last === "runtimeFence";
  }

  /** THE unwind path at a point where an exception is pending: release
   * everything between here and the innermost try handler — or the whole
   * function — and branch to the handler / return a dummy value (never
   * read: callers of a may-throw function test the pending flag before
   * using the result). Callers own the surrounding pending branch; a
   * `throw` unwinds unconditionally. CEmitter.emitUnwind, block-flavored. */
  private emitUnwind(): void {
    const target = this.tryStack[this.tryStack.length - 1];
    if (target) {
      this.releaseForJump(target.frameDepth, target.scopeDepth);
      target.used = true;
      this.B.terminate(`br label %${target.label}`);
      return;
    }
    this.releaseForJump(0, 0);
    if (this.currentWasiCoro !== null) {
      this.B.terminate(`br label %${this.currentWasiCoro.finalLabel}`);
      return;
    }
    const t = this.currentReturnType;
    if (t.kind === "void") this.B.terminate("ret void");
    else if (t.kind === "f64" || t.kind === "date") this.B.terminate(`ret double ${f64Lit(0)}`);
    else if (t.kind === "bool") this.B.terminate("ret i1 false");
    else this.B.terminate("ret ptr null");
  }

  /** The emitter contract for exceptions: after EVERY call that can throw
   * (per the may-throw analysis), test the pending flag and unwind. The
   * call's result temp must join its frame BEFORE this runs so the unwind
   * releases the dummy (NULL for refcounted kinds) harmlessly. */
  private emitPendingCheck(): void {
    const B = this.B;
    if (B.isTerminated()) return;
    this.declare(`declare zeroext i1 @scr_exc_pending()`);
    const p = B.tmp();
    B.line(`${p} = call zeroext i1 @scr_exc_pending()`);
    const lu = B.newLabel("exc.u");
    const lk = B.newLabel("exc.k");
    B.condBr(p, lu, lk);
    B.startBlock(lu);
    this.emitUnwind();
    B.startBlock(lk);
  }

  /** Moves an already-evaluated value into the runtime's exception cell —
   * the `throw` statement's kind dispatch (emit-stmts.ts's), shared with
   * every synthetic thrower. Ownership of a refcounted payload must have
   * been moved off its frame by the caller. */
  private emitThrowValue(v: LlValue): void {
    const B = this.B;
    const t = v.type;
    if (t.kind === "date") {
      throw new Error("LLVM emitter bug: Date throw reached backend");
    } else if (t.kind === "f64") {
      this.declare(`declare void @scr_throw_f64(double)`);
      B.line(`call void @scr_throw_f64(double ${v.name})`);
    } else if (t.kind === "bool") {
      this.declare(`declare void @scr_throw_bool(i1 zeroext)`);
      B.line(`call void @scr_throw_bool(i1 ${v.name})`);
    } else if (t.kind === "string") {
      this.declare(`declare void @scr_throw_str(ptr)`);
      B.line(`call void @scr_throw_str(ptr ${v.name})`);
    } else if (t.kind === "object" && this.classMeta.get(t.className)?.hierarchy === true) {
      // Hierarchy instances carry a vtable word: the OBJ kind keeps the
      // dynamic class inspectable (catch-binding instanceof, the uncaught
      // printer's "name: message" for Error instances).
      const rc = vAdapters(this, t);
      this.declare(`declare void @scr_throw_obj(ptr, ptr, ptr, ptr)`);
      B.line(`call void @scr_throw_obj(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, t)})`);
    } else {
      const rc = vAdapters(this, t);
      this.declare(`declare void @scr_throw_ref(ptr, ptr, ptr, ptr)`);
      B.line(`call void @scr_throw_ref(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, t)})`);
    }
  }

  /** JS truthiness of a value (falsy: false, 0, -0, NaN, "", nullish
   * union arms): one fcmp for f64 (NaN and both zeros compare !one), a
   * length load for strings, an inline tag switch for unions, `!= null`
   * for the always-truthy object kinds (JS: [] and {} are truthy). */
  private truthy(v: LlValue): string {
    const B = this.B;
    switch (v.type.kind) {
      case "bool":
        return v.name;
      case "f64": {
        const t = B.tmp();
        B.line(`${t} = fcmp one double ${v.name}, ${f64Lit(0)}`);
        return t;
      }
      case "string": {
        const lenp = B.tmp();
        const len = B.tmp();
        const t = B.tmp();
        B.line(`${lenp} = getelementptr inbounds %ScrStr, ptr ${v.name}, i64 0, i32 1`);
        B.line(`${len} = load ${this.sizeType}, ptr ${lenp}`);
        B.line(`${t} = icmp ne ${this.sizeType} ${len}, 0`);
        return t;
      }
      case "date":
        return "true";
      case "array":
      case "record":
      case "object":
      case "classval":
      case "func":
      case "map":
      case "set":
      case "symbol":
      case "regex":
      case "promise":
      case "bytes":
      case "url":
      case "searchParams":
      case "stats":
      case "fileHandle":
      case "spawnRes":
      case "child":
      case "childStream":
      case "generator":
      case "fsWatcher": {
        // JS objects are ALWAYS truthy; the honest constant reads as a
        // pointer test, exactly the C emitter's `!= NULL`.
        const t = B.tmp();
        B.line(`${t} = icmp ne ptr ${v.name}, null`);
        return t;
      }
      case "procStream": {
        // A stream value is a JS object (always truthy); the scalar fd
        // representation is 1 or 2, so the honest constant reads as its
        // own non-zero test.
        const t = B.tmp();
        B.line(`${t} = fcmp one double ${v.name}, ${f64Lit(0)}`);
        return t;
      }
      case "dyn": {
        // ToBoolean over the dyn kind (scr_dyn_truthy — JS-exact for
        // every kind; borrowed, never throws): `v || dflt` and condition
        // descent on checked-dynamic values.
        this.declare(`declare zeroext i1 @scr_dyn_truthy(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_dyn_truthy(ptr ${v.name})`);
        return t;
      }
      case "jsval": {
        // Island truthiness: the engine's ToBoolean (never throws, no
        // ownership change) — jsval operands are legal in `logical`.
        this.declare(`declare i32 @scr_jsval_truthy(ptr)`);
        const r = B.tmp();
        const t = B.tmp();
        B.line(`${r} = call i32 @scr_jsval_truthy(ptr ${v.name})`);
        B.line(`${t} = icmp ne i32 ${r}, 0`);
        return t;
      }
      case "union": {
        // The ARM value's ToBoolean: an inline tag switch (the C emitter's
        // per-union interned helper, emitted at the use site instead).
        const def = this.unionsById.get(v.type.unionId);
        if (!def) throw new Error(`llvm emitter bug: truthiness of unknown union ${v.type.unionId}`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca i1`);
        const join = B.newLabel("ut.j");
        this.unionTagSwitch(v.name, def, (arm) => {
          switch (arm.kind) {
            case "undefinedT":
            case "nullT":
              B.line(`store i1 false, ptr ${slot}`);
              break;
            case "f64": {
              const x = B.tmp();
              const t = B.tmp();
              this.declare(`declare double @scr_union_get_f64(ptr)`);
              B.line(`${x} = call double @scr_union_get_f64(ptr ${v.name})`);
              B.line(`${t} = fcmp one double ${x}, ${f64Lit(0)}`);
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
            case "bool": {
              const b = B.tmp();
              this.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
              B.line(`${b} = call zeroext i1 @scr_union_get_bool(ptr ${v.name})`);
              B.line(`store i1 ${b}, ptr ${slot}`);
              break;
            }
            case "string": {
              const p = this.unionPeek(v.name);
              const lenp = B.tmp();
              const len = B.tmp();
              const t = B.tmp();
              B.line(`${lenp} = getelementptr inbounds %ScrStr, ptr ${p}, i64 0, i32 1`);
              B.line(`${len} = load ${this.sizeType}, ptr ${lenp}`);
              B.line(`${t} = icmp ne ${this.sizeType} ${len}, 0`);
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
            case "date":
              B.line(`store i1 true, ptr ${slot} ; Date objects are truthy`);
              break;
            case "array":
            case "record":
            case "object":
            case "classval":
            case "func":
            case "map":
            case "set":
            case "symbol":
            case "regex":
            case "promise":
            case "bytes":
            case "url":
            case "searchParams":
            case "stats":
            case "fileHandle":
            case "spawnRes":
            case "child":
            case "childStream":
            case "generator":
            case "fsWatcher":
              B.line(`store i1 true, ptr ${slot} ; ${arm.kind}: objects are truthy`);
              break;
            default:
              throw new LlvmUnsupportedError(`truthy:union:${arm.kind}`);
          }
          B.br(join);
        });
        B.startBlock(join);
        const t = B.tmp();
        B.line(`${t} = load i1, ptr ${slot}`);
        return t;
      }
      default:
        throw new LlvmUnsupportedError(`truthy:${v.type.kind}`);
    }
  }

  // ── union plumbing ──────────────────────────────────────────────────────

  /** Loads a union box's tag (i32). */
  private unionTag(uName: string): string {
    const p = this.B.tmp();
    const t = this.B.tmp();
    this.B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${uName}, i64 0, i32 1`);
    this.B.line(`${t} = load i32, ptr ${p}`);
    return t;
  }

  /** The BORROWED payload pointer of a ref arm (scr_union_peek inlined —
   * the runtime's is a static inline). */
  private unionPeek(uName: string): string {
    const p = this.B.tmp();
    const t = this.B.tmp();
    this.B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${uName}, i64 0, i32 5`);
    this.B.line(`${t} = load ptr, ptr ${p}`);
    return t;
  }

  /** Emits `switch` over a union's tag with one block per arm; each arm
   * body must TERMINATE its block (the callers branch to a join). The
   * default block is the C emitter's invalid-tag abort. */
  private unionTagSwitch(uName: string, def: IrUnionDef, arm: (armType: IrType, tag: number) => void): void {
    const B = this.B;
    const tag = this.unionTag(uName);
    const bad = B.newLabel("u.bad");
    const labels = def.arms.map(() => B.newLabel("u.a"));
    B.terminate(
      `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, i) => `i32 ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    def.arms.forEach((a, i) => {
      B.startBlock(labels[i]!);
      arm(a, i);
    });
    B.startBlock(bad);
    this.needsBadTag = true;
    B.line(`call void @sc_bad_tag()`);
    B.terminate(`unreachable`);
  }

  /** The +1 extraction of a union's single narrowed arm (unionNarrow /
   * the nullish-family reads): scalars via the runtime getters, ref arms
   * a retained peek. */
  private unionExtract(uName: string, arm: IrType): string {
    const B = this.B;
    if (arm.kind === "f64") {
      const t = B.tmp();
      this.declare(`declare double @scr_union_get_f64(ptr)`);
      B.line(`${t} = call double @scr_union_get_f64(ptr ${uName})`);
      return t;
    }
    if (arm.kind === "bool") {
      const t = B.tmp();
      this.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
      B.line(`${t} = call zeroext i1 @scr_union_get_bool(ptr ${uName})`);
      return t;
    }
    return this.retainValue(this.unionPeek(uName), arm);
  }

  /** Constructs a union box around an OWNED (+1, already moved) value —
   * the scr_union_new_* dispatch of unionWrap and the wrap-into-join
   * sites (shift). */
  private unionNewOwned(tag: number, v: LlValue): string {
    const B = this.B;
    const t = B.tmp();
    if (v.type.kind === "f64") {
      this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
      B.line(`${t} = call ptr @scr_union_new_f64(i32 ${tag}, double ${v.name})`);
      return t;
    }
    if (v.type.kind === "bool") {
      this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      B.line(`${t} = call ptr @scr_union_new_bool(i32 ${tag}, i1 ${v.name})`);
      return t;
    }
    const rc = vAdapters(this, v.type);
    this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    B.line(
      `${t} = call ptr @scr_union_new_ref(i32 ${tag}, ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, v.type)})`,
    );
    return t;
  }

  // ── class plumbing ──────────────────────────────────────────────────────

  private classMetaOf(className: string): LlClassMeta {
    const meta = this.classMeta.get(className);
    if (!meta) throw new Error(`llvm emitter bug: unknown class ${className}`);
    return meta;
  }

  /** True when construction through a classval of `className` can throw:
   * the runtime callee is the static class's constructor or any strict
   * descendant's (classval flows never leave the subtree). */
  private newValueMayThrow(className: string): boolean {
    const any = (m: LlClassMeta): boolean =>
      this.mayThrow.has(`%${m.def.name}.constructor`) || m.children.some(any);
    return any(this.classMetaOf(className));
  }

  /** The field-slot pointer of a class member: rc at 0, the vtable word at
   * 1 on hierarchy members, then the flattened field list. Runtime error
   * classes GEP through %ScrError (their structs live in the runtime; the
   * def's [name, message, %code] order matches the layout). */
  private classFieldPtr(objName: string, className: string, field: string): { ptr: string; type: IrType } {
    const meta = this.classMetaOf(className);
    const { index, type } = classFieldIndex(meta, field);
    const p = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${classStructSym(className)}, ptr ${objName}, i64 0, i32 ${index}`,
    );
    return { ptr: p, type };
  }

  /** `o->vt->pre` — the dynamic class's preorder number (borrowed object;
   * the static class names which struct spelling carries the vt word). */
  private loadVtPre(objName: string, staticClassName: string): string {
    const B = this.B;
    const vtp = B.tmp();
    const vt = B.tmp();
    const prep = B.tmp();
    const pre = B.tmp();
    B.line(`${vtp} = getelementptr inbounds %${classStructSym(staticClassName)}, ptr ${objName}, i64 0, i32 1`);
    B.line(`${vt} = load ptr, ptr ${vtp}`);
    B.line(`${prep} = getelementptr inbounds %ScrVt, ptr ${vt}, i64 0, i32 0`);
    B.line(`${pre} = load ${this.sizeType}, ptr ${prep}`);
    return pre;
  }

  /** The class object's static symbol (classes as values), registering it
   * for assembly on first use and interning the .name literal while the
   * table is still open (the regex-literal discipline). */
  private classObjSym(className: string): string {
    if (!this.classObjs.has(className)) {
      const meta = this.classMetaOf(className);
      this.classObjs.set(className, { nameSym: this.internLiteral(meta.def.jsName ?? "") });
    }
    return mangleClassObj(className);
  }

  // ── record plumbing ─────────────────────────────────────────────────────

  private recordShape(shapeId: string): IrRecordShape {
    const shape = this.recordsById.get(shapeId);
    if (!shape) throw new Error(`llvm emitter bug: unknown record shape ${shapeId}`);
    return shape;
  }

  /** The field-slot pointer of a record member (rc header at index 0). */
  private recordFieldPtr(objName: string, shapeId: string, field: string): { ptr: string; type: IrType } {
    const shape = this.recordShape(shapeId);
    const idx = shape.fields.findIndex((f) => f.name === field);
    if (idx < 0) throw new Error(`llvm emitter bug: unknown field ${field} on shape ${shapeId}`);
    const p = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${objName}, i64 0, i32 ${idx + 1}`,
    );
    return { ptr: p, type: shape.fields[idx]!.type };
  }

  /** The overflow map's slot pointer on an index-signature shape. */
  private recordOvfPtr(objName: string, shapeId: string): string {
    const shape = this.recordShape(shapeId);
    if (!shape.indexValue) throw new Error(`llvm emitter bug: shape ${shapeId} has no overflow map`);
    const p = this.B.tmp();
    const v = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${objName}, i64 0, i32 ${shape.fields.length + 1}`,
    );
    this.B.line(`${v} = load ptr, ptr ${p}`);
    return v;
  }

  /** Loads a record field (i8-stored bools trunc to i1). */
  private loadField(ptr: string, t: IrType): string {
    const B = this.B;
    const fieldTy = llFieldType(t);
    const raw = B.tmp();
    B.line(`${raw} = load ${fieldTy}, ptr ${ptr}`);
    if (fieldTy !== "i8") return raw;
    const b = B.tmp();
    B.line(`${b} = trunc i8 ${raw} to i1`);
    return b;
  }

  /** Stores a record field (i1 zext to the i8 storage). */
  private storeField(ptr: string, t: IrType, value: string): void {
    const B = this.B;
    const fieldTy = llFieldType(t);
    if (fieldTy !== "i8") {
      B.line(`store ${fieldTy} ${value}, ptr ${ptr}`);
      return;
    }
    const z = B.tmp();
    B.line(`${z} = zext i1 ${value} to i8`);
    B.line(`store i8 ${z}, ptr ${ptr}`);
  }

  // ── bindings ────────────────────────────────────────────────────────────

  /** A binding's storage: a module global, a plain local slot, or a boxed
   * local (the slot holds the capture BOX; access goes through it). */
  private binding(id: string): { kind: "global" | "local" | "boxed"; slot: string; type: IrType; local?: IrLocal } {
    const local = this.currentLocals.get(id);
    if (local) {
      return {
        kind: local.boxed ? "boxed" : "local",
        slot: `%${mangleLocal(id)}`,
        type: local.type,
        local,
      };
    }
    const g = this.globalTypes.get(id);
    if (!g) throw new Error(`llvm emitter bug: unknown binding ${id}`);
    return { kind: "global", slot: `@${mangleGlobal(id)}`, type: g };
  }

  /** Loads a boxed binding's box pointer out of its slot. */
  private loadBox(slot: string): string {
    const b = this.B.tmp();
    this.B.line(`${b} = load ptr, ptr ${slot}`);
    return b;
  }

  private boxGet(box: string, t: IrType): string {
    const B = this.B;
    const acc = boxAccess(t);
    const r = B.tmp();
    if (acc === "f64") {
      this.declare(`declare double @scr_box_get_f64(ptr)`);
      B.line(`${r} = call double @scr_box_get_f64(ptr ${box})`);
    } else if (acc === "bool") {
      this.declare(`declare zeroext i1 @scr_box_get_bool(ptr)`);
      B.line(`${r} = call zeroext i1 @scr_box_get_bool(ptr ${box})`);
    } else {
      this.declare(`declare ptr @scr_box_get_ref(ptr)`);
      B.line(`${r} = call ptr @scr_box_get_ref(ptr ${box})`); // returns +1
    }
    return r;
  }

  /** scr_box_set_* — the ref form takes ownership of the passed value. */
  private boxSet(box: string, t: IrType, value: string): void {
    const B = this.B;
    const acc = boxAccess(t);
    if (acc === "f64") {
      this.declare(`declare void @scr_box_set_f64(ptr, double)`);
      B.line(`call void @scr_box_set_f64(ptr ${box}, double ${value})`);
    } else if (acc === "bool") {
      this.declare(`declare void @scr_box_set_bool(ptr, i1 zeroext)`);
      B.line(`call void @scr_box_set_bool(ptr ${box}, i1 ${value})`);
    } else {
      this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
      B.line(`call void @scr_box_set_ref(ptr ${box}, ptr ${value})`);
    }
  }

  private retainBox(box: string): string {
    this.needsRetainBox = true;
    const t = this.B.tmp();
    this.B.line(`${t} = call ptr @sc_retain_box(ptr ${box})`);
    return t;
  }

  /** The initializing write of a scalar TDZ box: mint the one-element
   * array cell holding the value and move it into the ARR-kind box
   * (set_ref releases nothing — the slot was the empty sentinel). */
  private tdzScalarInit(box: string, t: IrType, value: string): void {
    const B = this.B;
    const acc = boxAccess(t);
    const cell = B.tmp();
    B.line(`${cell} = ${arrNewCall(this, t, "1")} ; TDZ cell`);
    this.arrPush(cell, acc === "bool" ? "bool" : "f64", value);
    this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
    B.line(`call void @scr_box_set_ref(ptr ${box}, ptr ${cell})`);
  }

  /** The TDZ-guarded read of a boxed binding: an empty payload slot is
   * the temporal dead zone — throw Node's exact catchable ReferenceError
   * (emit-exprs.ts's varRef guard). Scalars then peek the one-element
   * array cell; ref kinds read the box normally (+1). */
  private tdzBoxRead(box: string, t: IrType, name: string): string {
    const B = this.B;
    const slotp = B.tmp();
    const slotv = B.tmp();
    const empty = B.tmp();
    B.line(`${slotp} = getelementptr inbounds %ScrBox, ptr ${box}, i64 0, i32 5`);
    B.line(`${slotv} = load i64, ptr ${slotp}`);
    B.line(`${empty} = icmp eq i64 ${slotv}, 0`);
    const lt = B.newLabel("tdz.t");
    const lk = B.newLabel("tdz.k");
    B.condBr(empty, lt, lk);
    B.startBlock(lt);
    // Interned literals are immortal (rc SIZE_MAX), so handing them to
    // the ownership-taking thrower is safe.
    const errName = this.internLiteral("ReferenceError");
    const msg = this.internLiteral(`Cannot access '${name}' before initialization`);
    this.declare(`declare void @scr_throw_error_named(ptr, ptr)`);
    B.line(`call void @scr_throw_error_named(ptr ${errName}, ptr ${msg})`);
    this.emitUnwind();
    B.startBlock(lk);
    const acc = boxAccess(t);
    if (acc === "ref") return this.boxGet(box, t);
    // The scalar cell peek: the box keeps the array alive, so no
    // retain/release pair is needed for the copied-out scalar.
    const cell = B.tmp();
    B.line(`${cell} = inttoptr i64 ${slotv} to ptr`);
    const accTy = acc === "bool" ? "i1" : "double";
    this.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
    const v = B.tmp();
    B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr ${cell}, double ${f64Lit(0)})`);
    return v;
  }

  // ── functions ───────────────────────────────────────────────────────────

  /** The LLVM symbol a direct call or closure enters a function through:
   * async bodies are entered via their emitted spawn wrapper (which runs
   * the fiber eagerly to its first suspension and returns the promise);
   * generator bodies via theirs (which only ALLOCATES the suspended
   * fiber and returns the generator object) — CEmitter.callTargetC. */
  private callTarget(fnName: string): string {
    const fn = this.fnByName.get(fnName);
    if (fn?.async === true) return mangleAsyncSpawn(fnName);
    if (fn?.generator !== undefined) return mangleGenSpawn(fnName);
    return mangleFunction(fnName);
  }

  /** Queue the current wasm coroutine and suspend it. The runtime decides
   * whether the promise waiter list or the ready FIFO owns the continuation;
   * LLVM keeps all live locals in the coroutine frame. */
  private emitWasiSuspend(promise: string | null): void {
    const coro = this.currentWasiCoro;
    if (coro === null) throw new Error("llvm emitter bug: wasm suspension outside async body");
    if (promise === null) {
      this.declare(`declare void @scr_wasi_await_hop_prepare(ptr)`);
      this.B.line(`call void @scr_wasi_await_hop_prepare(ptr ${coro.self})`);
    } else {
      this.declare(`declare void @scr_wasi_await_prepare(ptr, ptr)`);
      this.B.line(`call void @scr_wasi_await_prepare(ptr ${coro.self}, ptr ${promise})`);
    }
    this.emitWasiSuspendPrepared();
  }

  /** Suspend after a target-specific runtime helper already queued the
   * continuation (used by module awaits, which skip the hop when settled). */
  private emitWasiSuspendPrepared(): void {
    const coro = this.currentWasiCoro;
    if (coro === null) throw new Error("llvm emitter bug: wasm suspension outside async body");
    const save = this.B.tmp();
    const state = this.B.tmp();
    const resume = this.B.newLabel("coro.resume");
    this.B.line(`${save} = call token @llvm.coro.save(ptr ${coro.handle})`);
    this.B.line(`${state} = call i8 @llvm.coro.suspend(token ${save}, i1 false)`);
    this.B.terminate(
      `switch i8 ${state}, label %${coro.suspendLabel} [ i8 0, label %${resume} i8 1, label %${coro.cleanupLabel} ]`,
    );
    this.B.startBlock(resume);
  }

  /** Move a clean async return value into the current fiber's promise. */
  private emitWasiFulfill(v: LlValue | null): void {
    const coro = this.currentWasiCoro;
    if (coro === null) throw new Error("llvm emitter bug: wasm fulfillment outside async body");
    const ret = this.currentReturnType;
    if (coro.kind === "generator") {
      this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
      const gen = this.B.tmp();
      this.B.line(`${gen} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
      switch (ret.kind) {
        case "void":
          return;
        case "f64":
        case "date":
          this.declare(`declare void @scr_gen_out_f64(ptr, double)`);
          this.B.line(`call void @scr_gen_out_f64(ptr ${gen}, double ${v!.name})`);
          return;
        case "bool":
          this.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
          this.B.line(`call void @scr_gen_out_bool(ptr ${gen}, i1 ${v!.name})`);
          return;
        default:
          this.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
          this.B.line(`call void @scr_gen_out_ref(ptr ${gen}, ptr ${v!.name}, ptr ${vAdapters(this, ret).release})`);
          return;
      }
    }
    this.declare(`declare ptr @scr_fiber_promise(ptr)`);
    const pr = this.B.tmp();
    this.B.line(`${pr} = call ptr @scr_fiber_promise(ptr ${coro.self})`);
    switch (ret.kind) {
      case "void":
        this.declare(`declare void @scr_promise_fulfill_void(ptr)`);
        this.B.line(`call void @scr_promise_fulfill_void(ptr ${pr})`);
        break;
      case "f64":
      case "date":
        this.declare(`declare void @scr_promise_fulfill_f64(ptr, double)`);
        this.B.line(`call void @scr_promise_fulfill_f64(ptr ${pr}, double ${v!.name})`);
        break;
      case "bool":
        this.declare(`declare void @scr_promise_fulfill_bool(ptr, i1 zeroext)`);
        this.B.line(`call void @scr_promise_fulfill_bool(ptr ${pr}, i1 ${v!.name})`);
        break;
      case "string":
        this.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
        this.B.line(`call void @scr_promise_fulfill_str(ptr ${pr}, ptr ${v!.name}) ; moves in`);
        break;
      default: {
        const rc = vAdapters(this, ret);
        this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
        this.B.line(
          `call void @scr_promise_fulfill_ref(ptr ${pr}, ptr ${v!.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, ret)})`,
        );
      }
    }
  }

  private emitFunction(fn: IrFunction): string {
    const B = new BlockBuilder();
    this.B = B;
    this.frames = [];
    this.scopes = [];
    this.jumpTargets = [];
    this.currentLocals = new Map(fn.locals.map((l) => [l.id, l]));
    this.captureIds = new Set((fn.captures ?? []).map((c) => c.localId));
    this.integerLoopBindings.clear();
    this.chainSlots.clear();
    this.finallyStack = [];
    this.tryStack = [];
    this.currentReturnType = fn.returnType;
    this.currentGenerator = fn.generator ?? null;
    this.currentWasiCoro = null;
    this.logArgSlots = 0;

    if (this.wasi && (fn.async === true || fn.generator !== undefined)) {
      this.declare(`declare token @llvm.coro.id(i32, ptr, ptr, ptr)`);
      this.declare(`declare ${this.sizeType} @llvm.coro.size.${this.sizeType}()`);
      this.declare(`declare ptr @llvm.coro.begin(token, ptr)`);
      this.declare(`declare token @llvm.coro.save(ptr)`);
      this.declare(`declare i8 @llvm.coro.suspend(token, i1)`);
      this.declare(`declare ptr @llvm.coro.free(token, ptr)`);
      this.declare(`declare i1 @llvm.coro.end(ptr, i1, token)`);
      this.declare(`declare ptr @malloc(${this.sizeType})`);
      this.declare(`declare void @free(ptr)`);
      this.declare(`declare void @scr_wasi_coro_started(ptr)`);
      this.declare(`declare ptr @scr_fiber_self()`);
      const id = B.tmp();
      const size = B.tmp();
      const mem = B.tmp();
      const handle = B.tmp();
      const self = B.tmp();
      B.line(`${id} = call token @llvm.coro.id(i32 0, ptr null, ptr null, ptr null)`);
      B.line(`${size} = call ${this.sizeType} @llvm.coro.size.${this.sizeType}()`);
      B.line(`${mem} = call ptr @malloc(${this.sizeType} ${size})`);
      B.line(`${handle} = call ptr @llvm.coro.begin(token ${id}, ptr ${mem})`);
      B.line(`call void @scr_wasi_coro_started(ptr ${handle})`);
      B.line(`${self} = call ptr @scr_fiber_self()`);
      this.currentWasiCoro = {
        kind: fn.async === true ? "async" : "generator",
        id,
        handle,
        self,
        finalLabel: B.newLabel("coro.final"),
        cleanupLabel: B.newLabel("coro.cleanup"),
        suspendLabel: B.newLabel("coro.suspend"),
      };
    }

    const paramIds = new Set(fn.params.map((p) => p.localId));
    for (const local of fn.locals) {
      // Boxed locals' slots hold their capture BOX (a ptr); captured
      // (env-borrowed) locals bind the incoming box below. A caught-typed
      // local is a catch binding: its slot holds the ScrCaught snapshot
      // box the catch prologue takes (scr_exc_take).
      const slotTy =
        local.boxed || this.captureIds.has(local.id) || local.type.kind === "caught"
          ? "ptr"
          : this.llType(local.type);
      B.entryAllocas.push(`%${mangleLocal(local.id)} = alloca ${slotTy} ; ${local.name}`);
      // Refcounted/boxed locals start NULL (the C prologue's `= NULL`):
      // scope-exit releases run whether or not an assign ever did.
      if (paramIds.has(local.id) || this.captureIds.has(local.id)) continue;
      if (local.boxed || isRefCounted(local.type)) {
        B.line(`store ptr null, ptr %${mangleLocal(local.id)}`);
      }
    }
    // Captured bindings come in through the environment — borrowed for the
    // whole call (the closure owns them): bound here, never released here.
    (fn.captures ?? []).forEach((c, i) => {
      const caps = B.tmp();
      const p = B.tmp();
      const box = B.tmp();
      B.line(`${caps} = getelementptr inbounds %ScrClosure, ptr %sc_env, i64 1 ; caps`);
      B.line(`${p} = getelementptr inbounds ptr, ptr ${caps}, ${this.sizeType} ${i} ; caps[${i}]`);
      B.line(`${box} = load ptr, ptr ${p}`);
      B.line(`store ptr ${box}, ptr %${mangleLocal(c.localId)} ; captured ${c.name}`);
    });
    // Params spill into their slots; the function scope owns refcounted
    // params (callees own their params — callers passed +1). Boxed params
    // allocate the shared binding and move the raw value in.
    const fnScope: LlScopeEntry[] = [];
    for (const p of fn.params) {
      const local = this.currentLocals.get(p.localId)!;
      const slot = `%${mangleLocal(p.localId)}`;
      if (local.boxed) {
        const box = B.tmp();
        B.line(`${box} = ${boxNewCall(this, p.type)} ; ${p.name} (boxed param)`);
        this.boxSet(box, p.type, `%p_${mangleLocal(p.localId)}`);
        B.line(`store ptr ${box}, ptr ${slot}`);
        fnScope.push({ slot, type: p.type, boxed: true });
        continue;
      }
      B.line(`store ${this.llType(p.type)} %p_${mangleLocal(p.localId)}, ptr ${slot}`);
      if (isRefCounted(p.type)) fnScope.push({ slot, type: p.type });
    }
    this.scopes.push(fnScope);
    this.emitStmts(fn.body);
    // Implicit exit of a void function: release the function scope unless
    // the body already terminated its final block (return, or a throw
    // whose unwind released everything down to depth 0).
    if (fn.returnType.kind === "void" && !B.isTerminated()) {
      this.releaseScope(this.scopes[0]!);
      if (this.currentWasiCoro !== null) {
        this.emitWasiFulfill(null);
        B.terminate(`br label %${this.currentWasiCoro.finalLabel}`);
      } else {
        B.terminate("ret void");
      }
    }
    this.scopes.pop();

    const coro = this.currentWasiCoro;
    if (coro !== null) {
      B.startBlock(coro.finalLabel);
      if (fn.captures !== undefined) {
        this.declare(`declare void @scr_closure_release(ptr)`);
        B.line(`call void @scr_closure_release(ptr %sc_env)`);
      }
      if (coro.kind === "generator") {
        this.declare(`declare void @scr_wasi_gen_finish(ptr)`);
        B.line(`call void @scr_wasi_gen_finish(ptr ${coro.self})`);
      } else {
        this.declare(`declare void @scr_wasi_async_finish(ptr)`);
        B.line(`call void @scr_wasi_async_finish(ptr ${coro.self})`);
      }
      const finalState = B.tmp();
      B.line(`${finalState} = call i8 @llvm.coro.suspend(token none, i1 true)`);
      B.terminate(
        `switch i8 ${finalState}, label %${coro.suspendLabel} [ i8 1, label %${coro.cleanupLabel} ]`,
      );
      B.startBlock(coro.cleanupLabel);
      const frame = B.tmp();
      B.line(`${frame} = call ptr @llvm.coro.free(token ${coro.id}, ptr ${coro.handle})`);
      B.line(`call void @free(ptr ${frame})`);
      B.br(coro.suspendLabel);
      B.startBlock(coro.suspendLabel);
      const ended = B.tmp();
      B.line(`${ended} = call i1 @llvm.coro.end(ptr ${coro.handle}, i1 false, token none)`);
      const ret = this.llType(fn.returnType);
      if (ret === "void") B.terminate(`ret void`);
      else if (ret === "double") B.terminate(`ret double ${f64Lit(0)}`);
      else if (ret === "i1") B.terminate(`ret i1 false`);
      else B.terminate(`ret ptr null`);
    }

    if (this.logArgSlots > 0) {
      B.entryAllocas.push(`%logargs = alloca [${this.logArgSlots} x %ScrLogArg]`);
    }
    const params = fn.params.map((p) => `${this.llType(p.type)} %p_${mangleLocal(p.localId)}`);
    // Lifted functions receive their closure first (the callValue ABI).
    if (fn.captures !== undefined) params.unshift("ptr %sc_env");
    const ret = this.llType(fn.returnType);
    const attrs = coro !== null ? "#1" : FN_ATTRS;
    return `define internal ${ret} @${mangleFunction(fn.name)}(${params.join(", ")}) ${attrs} { ; ${fn.name}\n${B.render()}\n}`;
  }

  // ── statements ──────────────────────────────────────────────────────────

  private emitStmts(stmts: IrStmt[]): void {
    for (const s of stmts) {
      // Statements after a terminator are unreachable (dead code after
      // return/break/continue) — the C emitter emits them as dead C; here
      // they are skipped so no dropped SSA definition can leak forward.
      if (this.B.isTerminated()) return;
      this.emitStmt(s);
    }
  }

  /** Emits a block in its own lexical scope (refcounted locals released at
   * end) — CEmitter.emitBlock without the braces. `setup` runs after the
   * scope opens, before the statements — the catch-binding hook: it may
   * emit prelude lines and register entries the scope owns (released on
   * every exit, jumps and unwinds included). */
  private emitBlock(stmts: IrStmt[], setup?: (scope: LlScopeEntry[]) => void): void {
    const scope: LlScopeEntry[] = [];
    this.scopes.push(scope);
    setup?.(scope);
    this.emitStmts(stmts);
    const ended = this.endsWithJump(stmts);
    this.scopes.pop();
    if (!ended) this.releaseScope(scope);
  }

  private emitStmt(s: IrStmt): void {
    const B = this.B;
    this.frames.push([]);
    switch (s.kind) {
      case "varDecl": {
        const b = this.binding(s.localId);
        if (b.kind === "boxed") {
          // Box FIRST, then evaluate the initializer: a named function
          // expression's closure captures this box during init evaluation.
          // A SCALAR TDZ box rides an ARR-kind box: the value lives in a
          // one-element array cell, so the empty (NULL) slot stays the
          // not-yet-initialized sentinel — a raw scalar slot has no spare
          // bit pattern to spend on it (emit-stmts.ts's varDecl).
          const boxNew =
            b.local!.tdz === true && boxAccess(b.type) !== "ref"
              ? (this.declare(`declare ptr @scr_box_new(i32)`), `call ptr @scr_box_new(i32 3)`)
              : boxNewCall(this, b.type);
          const box = B.tmp();
          B.line(`${box} = ${boxNew} ; let ${b.local!.name} (boxed)`);
          B.line(`store ptr ${box}, ptr ${b.slot}`);
          this.scopes[this.scopes.length - 1]!.push({ slot: b.slot, type: b.type, boxed: true });
          if (s.init === null) break;
          const v = this.emitExpr(s.init);
          if (isRefCounted(v.type)) this.moveTemp(v); // the box takes ownership
          if (b.local!.tdz === true && boxAccess(b.type) !== "ref") {
            this.tdzScalarInit(box, b.type, v.name);
          } else {
            this.boxSet(box, b.type, v.name);
          }
          break;
        }
        if (s.init === null) {
          // Declared, uninitialized (`let x: number;`): reset the slot —
          // inside a loop the previous iteration's scope exit released the
          // old value and left a stale pointer (NULL-tolerant releases).
          if (isRefCounted(b.type)) {
            B.line(`store ptr null, ptr ${b.slot}`);
            this.scopes[this.scopes.length - 1]!.push({ slot: b.slot, type: b.type });
          }
          break;
        }
        const v = this.emitExpr(s.init);
        this.moveTemp(v);
        B.line(`store ${this.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        if (isRefCounted(b.type)) {
          this.scopes[this.scopes.length - 1]!.push({ slot: b.slot, type: b.type });
        }
        break;
      }
      case "assign": {
        const b = this.binding(s.localId);
        const v = this.emitExpr(s.value);
        if (b.kind === "boxed") {
          if (isRefCounted(v.type)) this.moveTemp(v); // set_ref releases the old value
          // A scalar TDZ box (forward-captured const): the initializing
          // write mints the one-element array cell — set_ref moves it in
          // (and the empty-slot sentinel ends here).
          if (b.local!.tdz === true && boxAccess(b.type) !== "ref") {
            this.tdzScalarInit(this.loadBox(b.slot), b.type, v.name);
            break;
          }
          this.boxSet(this.loadBox(b.slot), b.type, v.name);
          break;
        }
        this.moveTemp(v);
        if (isRefCounted(b.type)) {
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${b.slot}`);
          this.releaseValue(old, b.type);
        }
        B.line(`store ${this.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        break;
      }
      case "exprStmt":
        this.emitExpr(s.expr);
        break;
      case "arraySet": {
        // Evaluation order matches JS: array, index, then value. Ownership
        // of a refcounted value moves into the array (the runtime releases
        // the replaced element itself).
        const arr = this.emitExpr(s.arr);
        const idx = this.emitExpr(s.index);
        const v = this.emitExpr(s.value);
        if (s.arr.type.kind !== "array") throw new Error("llvm emitter bug: arraySet on non-array");
        const acc = elemAccess(s.arr.type.elem);
        if (acc === "ref") this.moveTemp(v);
        const argTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
        this.declare(`declare void @scr_arr_set_${acc}(ptr, double, ${argTy === "i1" ? "i1 zeroext" : argTy})`);
        B.line(`call void @scr_arr_set_${acc}(ptr ${arr.name}, double ${idx.name}, ${argTy} ${v.name})`);
        break;
      }
      case "bytesSet": {
        // Typed-array element write: same evaluation order as arraySet;
        // the value is a scalar (the kind-specific inline path coerces
        // JS-exactly), so no ownership moves. Any invalid index traps — no
        // append. IrBytesElem is static, so never rediscover it through the
        // generic runtime switch in a hot loop.
        const arr = this.emitBytesReceiver(s.arr, [s.index, s.value]);
        const integerIndex = this.emitIntegerLoopIndex(s.index);
        const idx = integerIndex ?? this.emitExpr(s.index).name;
        const v = this.emitExpr(s.value);
        if (s.arr.type.kind !== "bytes") throw new Error("llvm emitter bug: bytesSet on non-bytes");
        this.emitBytesSet(s.arr.type.elem, arr.name, idx, v.name, integerIndex !== null);
        break;
      }
      case "fieldSet":
      case "recordSet": {
        // Evaluation order: obj, then value. New value moved in; the old
        // value is released AFTER the field is overwritten (unlink-then-
        // release — a release can trigger a cycle collection, which must
        // never see a heap edge whose count was already given up).
        // Classes and records share the struct layout, so one emission.
        const obj = this.emitExpr(s.obj);
        const v = this.emitExpr(s.value);
        const { ptr, type } =
          s.kind === "fieldSet"
            ? this.classFieldPtr(obj.name, s.className, s.field)
            : this.recordFieldPtr(obj.name, s.shapeId, s.field);
        if (isRefCounted(type)) {
          this.moveTemp(v);
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${ptr}`);
          this.storeField(ptr, type, v.name);
          this.releaseValue(old, type);
        } else {
          this.storeField(ptr, type, v.name);
        }
        break;
      }
      case "recordKeyDelete": {
        // `delete obj[k]` on a pure index-signature shape: a Map delete on
        // the overflow (key and value released; absent keys no-op).
        const obj = this.emitExpr(s.obj);
        const key = this.emitExpr(s.key);
        const ovf = this.recordOvfPtr(obj.name, s.shapeId);
        this.declare(`declare zeroext i1 @scr_map_delete_str(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_delete_str(ptr ${ovf}, ptr ${key.name})`);
        break;
      }
      case "recordKeySet": {
        // Dynamic-keyed record write (the C per-shape helper, inline):
        // declared keys write through (same-typed — dyn-valued shapes,
        // whose writes validate and can throw, stay refused), undeclared
        // keys insert/replace in the overflow map. Evaluation order: obj,
        // key, value; the write OWNS the value (+1 moves in).
        const obj = this.emitExpr(s.obj);
        const key = this.emitExpr(s.key);
        const v = this.emitExpr(s.value);
        if (isRefCounted(v.type)) this.moveTemp(v);
        const shape = this.recordShape(s.shapeId);
        // Signature-free shapes dispatch over their (one-typed) declared
        // fields and TRAP on a miss (scr_record_key_miss — JS would add
        // the property, which a monomorphic struct cannot); overflow
        // shapes keep the map insert tail.
        const iv = shape.indexValue ?? shape.fields[0]?.type;
        if (!iv) throw new Error(`llvm emitter bug: keyed write on field-free non-overflow shape ${s.shapeId}`);
        const vAcc = iv.kind === "f64" ? "f64" : iv.kind === "bool" ? "bool" : "ref";
        if (s.overflowOnly === true) {
          // A LITERAL key naming no declared field: a plain overflow
          // insert — no field chain.
          const ovf = this.recordOvfPtr(obj.name, s.shapeId);
          this.mapSet(ovf, "str", vAcc, key.name, v.name);
          break;
        }
        const join = B.newLabel("rks.j");
        this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        if (iv.kind === "dyn" && shape.indexValue) {
          // A dyn-valued shape (the C recordKeySetHelper's dyn arm,
          // inline): declared keys VALIDATE the dyn value against the
          // field's type first (dynCheck — a mismatched write throws the
          // catchable TypeError and leaves the field untouched; JS would
          // store anything, the documented divergence); undeclared keys
          // insert the dyn value into the overflow map as-is.
          this.declare(`declare void @scr_dyn_release(ptr)`);
          for (const f of shape.fields) {
            const lit = this.internLiteral(f.name);
            const hit = B.tmp();
            B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${key.name}, ptr ${lit}) ; ${f.name}`);
            const lh = B.newLabel("rks.h");
            const ln = B.newLabel("rks.n");
            B.condBr(hit, lh, ln);
            B.startBlock(lh);
            const pathSlot = B.slot();
            B.entryAllocas.push(`${pathSlot} = alloca %ScrDynPath`);
            const pp = B.tmp();
            const kp = B.tmp();
            const ip = B.tmp();
            B.line(`${pp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 0`);
            B.line(`store ptr null, ptr ${pp}`);
            B.line(`${kp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 1`);
            B.line(`store ptr ${this.cstr(f.name)}, ptr ${kp}`);
            B.line(`${ip} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 2`);
            B.line(`store ${this.sizeType} 0, ptr ${ip}`);
            const helper = this.dyn.dynCheckHelper(f.type);
            const fty = this.llType(f.type);
            const nv = B.tmp();
            B.line(`${nv} = call ${fty === "i1" ? "zeroext i1" : fty} @${helper}(ptr ${v.name}, ptr ${pathSlot})`);
            B.line(`call void @scr_dyn_release(ptr ${v.name})`);
            // Mismatched write: TypeError pending, field untouched — the
            // statement-level check below unwinds.
            this.declare(`declare zeroext i1 @scr_exc_pending()`);
            const pend = B.tmp();
            B.line(`${pend} = call zeroext i1 @scr_exc_pending()`);
            const lw = B.newLabel("rks.w");
            B.condBr(pend, join, lw);
            B.startBlock(lw);
            const { ptr, type } = this.recordFieldPtr(obj.name, s.shapeId, f.name);
            if (isRefCounted(type)) {
              const old = B.tmp();
              B.line(`${old} = load ptr, ptr ${ptr}`);
              this.storeField(ptr, type, nv);
              this.releaseValue(old, type);
            } else {
              this.storeField(ptr, type, nv);
            }
            B.br(join);
            B.startBlock(ln);
          }
          const ovf = this.recordOvfPtr(obj.name, s.shapeId);
          this.mapSet(ovf, "str", vAcc, key.name, v.name);
          B.br(join);
          B.startBlock(join);
          // MAY THROW exactly when a dyn value can validate against a
          // declared field (emit-stmts.ts's condition).
          if (shape.fields.length > 0) this.emitPendingCheck();
          break;
        }
        for (const f of shape.fields) {
          // typeEquals(f.type, iv) — the frontend fences everything else.
          const lit = this.internLiteral(f.name);
          const hit = B.tmp();
          B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${key.name}, ptr ${lit}) ; ${f.name}`);
          const lh = B.newLabel("rks.h");
          const ln = B.newLabel("rks.n");
          B.condBr(hit, lh, ln);
          B.startBlock(lh);
          const { ptr, type } = this.recordFieldPtr(obj.name, s.shapeId, f.name);
          if (isRefCounted(type)) {
            const old = B.tmp();
            B.line(`${old} = load ptr, ptr ${ptr}`);
            this.storeField(ptr, type, v.name);
            this.releaseValue(old, type);
          } else {
            this.storeField(ptr, type, v.name);
          }
          B.br(join);
          B.startBlock(ln);
        }
        if (!shape.indexValue) {
          // The MISS on a fixed shape: release the moved-in value, throw
          // the catchable TypeError naming the key (scr_record_key_miss —
          // JS would add the property, the documented divergence).
          if (isRefCounted(iv)) this.releaseValue(v.name, iv);
          this.declare(`declare void @scr_record_key_miss(ptr)`);
          B.line(`call void @scr_record_key_miss(ptr ${key.name})`);
          B.br(join);
          B.startBlock(join);
          this.emitPendingCheck();
          break;
        }
        const ovf = this.recordOvfPtr(obj.name, s.shapeId);
        this.mapSet(ovf, "str", vAcc, key.name, v.name);
        B.br(join);
        B.startBlock(join);
        break;
      }
      case "block": {
        if (s.labels === undefined) {
          this.emitBlock(s.body);
          break;
        }
        // A labeled block: `break lbl` inside branches to the end label.
        const le = B.newLabel("blk.e");
        this.jumpTargets.push({
          kind: "block",
          brkLabel: le,
          contLabel: null,
          labels: s.labels,
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        this.emitBlock(s.body);
        this.jumpTargets.pop();
        B.br(le);
        B.startBlock(le);
        break;
      }
      case "if": {
        const cond = this.emitCondition(s.cond);
        const lt = B.newLabel("if.t");
        const lj = B.newLabel("if.j");
        const lf = s.else_ ? B.newLabel("if.f") : lj;
        B.condBr(cond, lt, lf);
        B.startBlock(lt);
        this.emitBlock(s.then);
        B.br(lj);
        if (s.else_) {
          B.startBlock(lf);
          this.emitBlock(s.else_);
          B.br(lj);
        }
        B.startBlock(lj);
        break;
      }
      case "while": {
        const lc = B.newLabel("loop.c");
        const lb = B.newLabel("loop.b");
        const le = B.newLabel("loop.e");
        B.br(lc);
        B.startBlock(lc);
        B.condBr(this.emitCondition(s.cond), lb, le);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lc,
          ...(s.labels !== undefined && { labels: s.labels }),
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        this.emitBlock(s.body);
        this.jumpTargets.pop();
        B.br(lc);
        B.startBlock(le);
        break;
      }
      case "doWhile": {
        // Body first (runs at least once); continue jumps to the CONDITION.
        const lb = B.newLabel("loop.b");
        const lc = B.newLabel("loop.c");
        const le = B.newLabel("loop.e");
        B.br(lb);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lc,
          ...(s.labels !== undefined && { labels: s.labels }),
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        this.emitBlock(s.body);
        this.jumpTargets.pop();
        B.br(lc);
        B.startBlock(lc);
        B.condBr(this.emitCondition(s.cond), lb, le);
        B.startBlock(le);
        break;
      }
      case "for": {
        // The init's scope wraps the whole loop (break/continue must NOT
        // release it — scopeDepth captured after the push, C parity).
        const integerLoop = matchIntegerBytesForLoop(s, this.currentLocals);
        this.scopes.push([]);
        let integerSlot: string | null = null;
        if (integerLoop) {
          integerSlot = B.slot();
          B.entryAllocas.push(`${integerSlot} = alloca ${this.sizeType} ; integer induction ${this.currentLocals.get(integerLoop.localId)!.name}`);
          B.line(`store ${this.sizeType} 0, ptr ${integerSlot}`);
          this.integerLoopBindings.set(integerLoop.localId, integerSlot);
        } else if (s.init) {
          this.emitStmt(s.init);
        }
        const lc = B.newLabel("loop.c");
        const lb = B.newLabel("loop.b");
        const le = B.newLabel("loop.e");
        // JS `for (let i ...)`: each iteration gets a FRESH binding holding
        // a copy of the previous one (closures made in iteration k keep
        // seeing iteration k's value) — only observable, and only emitted,
        // when the init variable is captured (boxed). The freshening (and
        // the update) live in the continue-target block.
        const initLocal = s.init?.kind === "varDecl" ? this.currentLocals.get(s.init.localId) : undefined;
        const freshens = initLocal?.boxed === true;
        const lu = s.update || freshens ? B.newLabel("loop.u") : lc;
        B.br(lc);
        B.startBlock(lc);
        if (integerLoop && integerSlot) {
          const receiver = this.emitBytesReceiver(integerLoop.limitReceiver, []);
          const lenPtr = B.tmp();
          const len = B.tmp();
          const index = B.tmp();
          const inBounds = B.tmp();
          B.line(`${lenPtr} = getelementptr inbounds %ScrBytes, ptr ${receiver.name}, i64 0, i32 1`);
          B.line(`${len} = load ${this.sizeType}, ptr ${lenPtr}`);
          B.line(`${index} = load ${this.sizeType}, ptr ${integerSlot}`);
          B.line(`${inBounds} = icmp ult ${this.sizeType} ${index}, ${len}`);
          B.condBr(inBounds, lb, le);
        } else if (s.cond) B.condBr(this.emitCondition(s.cond), lb, le);
        else B.br(lb);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lu,
          ...(s.labels !== undefined && { labels: s.labels }),
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        this.emitBlock(s.body);
        this.jumpTargets.pop();
        B.br(lu);
        if (lu !== lc) {
          B.startBlock(lu);
          if (freshens && initLocal) {
            const slot = `%${mangleLocal(initLocal.id)}`;
            const fresh = B.tmp();
            const old = B.tmp();
            B.line(`${fresh} = ${boxNewCall(this, initLocal.type)} ; per-iteration ${initLocal.name}`);
            B.line(`${old} = load ptr, ptr ${slot}`);
            const val = this.boxGet(old, initLocal.type); // ref: +1 out
            this.boxSet(fresh, initLocal.type, val); // takes ownership
            this.declare(`declare void @scr_box_release(ptr)`);
            B.line(`call void @scr_box_release(ptr ${old})`);
            B.line(`store ptr ${fresh}, ptr ${slot}`);
            // The wrapper scope's entry releases whatever the slot points
            // to at loop exit — now the freshest binding. Nothing to fix.
          }
          if (integerLoop && integerSlot) {
            const old = B.tmp();
            const next = B.tmp();
            B.line(`${old} = load ${this.sizeType}, ptr ${integerSlot}`);
            B.line(`${next} = add nuw ${this.sizeType} ${old}, 1`);
            B.line(`store ${this.sizeType} ${next}, ptr ${integerSlot}`);
          } else if (s.update) this.emitStmt(s.update);
          B.br(lc);
        }
        B.startBlock(le);
        this.releaseScope(this.scopes.pop()!);
        if (integerLoop) this.integerLoopBindings.delete(integerLoop.localId);
        break;
      }
      case "forOf": {
        // Ascending index loop; the length is re-read every iteration
        // (JS-exact — pushes inside the body extend the iteration). The
        // iterable temp lives in this statement's frame, so it is released
        // when the whole loop ends (and by `return`'s frame sweep).
        if (s.iterable.type.kind !== "array") throw new LlvmUnsupportedError(`forOf:${s.iterable.type.kind}`, s.loc);
        const elem = s.iterable.type.elem;
        const arr = this.emitExpr(s.iterable);
        const idxSlot = B.slot();
        B.entryAllocas.push(`${idxSlot} = alloca double`);
        B.line(`store double ${f64Lit(0)}, ptr ${idxSlot}`);
        const lc = B.newLabel("fof.c");
        const lb = B.newLabel("fof.b");
        const lu = B.newLabel("fof.u");
        const le = B.newLabel("fof.e");
        B.br(lc);
        B.startBlock(lc);
        const i = B.tmp();
        const len = B.tmp();
        const inBounds = B.tmp();
        this.declare(`declare double @scr_arr_len(ptr)`);
        B.line(`${i} = load double, ptr ${idxSlot}`);
        B.line(`${len} = call double @scr_arr_len(ptr ${arr.name})`);
        B.line(`${inBounds} = fcmp olt double ${i}, ${len}`);
        B.condBr(inBounds, lb, le);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lu,
          ...(s.labels !== undefined && { labels: s.labels }),
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        // The loop variable is a fresh const per iteration: its scope opens
        // here, holds the (for ref elements: owned +1) current element, and
        // releases it at the end of each iteration.
        this.scopes.push([]);
        const localInfo = this.currentLocals.get(s.localId);
        const slot = `%${mangleLocal(s.localId)}`;
        const acc = elemAccess(elem);
        const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
        this.declare(
          `declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`,
        );
        const cur = B.tmp();
        B.line(`${cur} = call ${accTy} @scr_arr_get_${acc}(ptr ${arr.name}, double ${i})`);
        if (localInfo?.boxed) {
          // Captured loop variable: a fresh box per iteration, matching the
          // fresh const binding. The box takes ownership of a ref element's
          // +1 and is released with the iteration's scope.
          const box = B.tmp();
          B.line(`${box} = ${boxNewCall(this, elem)} ; per-iteration ${localInfo.name}`);
          this.boxSet(box, elem, cur);
          B.line(`store ptr ${box}, ptr ${slot}`);
          this.scopes[this.scopes.length - 1]!.push({ slot, type: elem, boxed: true });
        } else {
          B.line(`store ${this.llType(elem)} ${cur}, ptr ${slot}`);
          if (isRefCounted(elem)) this.scopes[this.scopes.length - 1]!.push({ slot, type: elem });
        }
        this.emitStmts(s.body);
        const endedWithJump = this.endsWithJump(s.body);
        const scope = this.scopes.pop()!;
        if (!endedWithJump) this.releaseScope(scope);
        this.jumpTargets.pop();
        B.br(lu);
        B.startBlock(lu);
        const i2 = B.tmp();
        const i3 = B.tmp();
        B.line(`${i2} = load double, ptr ${idxSlot}`);
        B.line(`${i3} = fadd double ${i2}, ${f64Lit(1)}`);
        B.line(`store double ${i3}, ptr ${idxSlot}`);
        B.br(lc);
        B.startBlock(le);
        break;
      }
      case "switch":
        this.emitSwitch(s);
        break;
      case "break": {
        // Unlabeled: the innermost loop OR switch (labeled blocks are
        // skipped); labeled: the entry carrying the label.
        let target: (typeof this.jumpTargets)[number] | undefined;
        for (let i = this.jumpTargets.length - 1; i >= 0; i--) {
          const t = this.jumpTargets[i]!;
          if (s.label !== undefined ? t.labels?.includes(s.label) : t.kind !== "block") {
            target = t;
            break;
          }
        }
        if (!target) throw new Error("llvm emitter bug: break target not found");
        this.releaseForJump(target.frameDepth, target.scopeDepth);
        B.terminate(`br label %${target.brkLabel}`);
        break;
      }
      case "continue": {
        // Unlabeled: the innermost loop; labeled: the loop carrying the
        // label (tsc + the validator guarantee it IS a loop).
        let target: (typeof this.jumpTargets)[number] | undefined;
        for (let i = this.jumpTargets.length - 1; i >= 0; i--) {
          const t = this.jumpTargets[i]!;
          if (t.kind === "loop" && (s.label === undefined || t.labels?.includes(s.label))) {
            target = t;
            break;
          }
        }
        if (!target || target.contLabel === null) throw new Error("llvm emitter bug: continue target not found");
        this.releaseForJump(target.frameDepth, target.scopeDepth);
        B.terminate(`br label %${target.contLabel}`);
        break;
      }
      case "return": {
        // The value computes FIRST (an SSA temp — finally mutations of
        // returned locals cannot change it, Node-exact), then every
        // crossed finally runs innermost-first with the frames/scopes/
        // tryStack it sees truncated to its region (its releases already
        // ran; a throw inside a copy propagates OUT of the completing
        // try, past its own catch), then the function-level releases and
        // the actual ret. The C emitter routes this through per-region
        // finally copies behind gotos with the value parked in sc_pret;
        // the inline copies here are the same code at the same depths,
        // with the parked value's ownership riding a synthetic slot-based
        // scope entry during each copy so a throwing finally releases it.
        let v: LlValue | null = null;
        if (s.value !== null) {
          v = this.emitExpr(s.value);
          this.moveTemp(v);
        }
        if (this.finallyStack.length > 0) {
          let pretSlot: string | null = null;
          if (v !== null && isRefCounted(v.type)) {
            pretSlot = B.slot();
            B.entryAllocas.push(`${pretSlot} = alloca ptr ; pending return (through finally)`);
            B.line(`store ptr ${v.name}, ptr ${pretSlot}`);
          }
          const savedFrames = this.frames;
          const savedScopes = this.scopes;
          const savedFinally = this.finallyStack;
          const savedTry = this.tryStack;
          for (let i = savedFinally.length - 1; i >= 0 && !B.isTerminated(); i--) {
            const fin = savedFinally[i]!;
            this.releaseForJump(fin.frameDepth, fin.scopeDepth);
            this.frames = this.frames.slice(0, fin.frameDepth);
            this.scopes = this.scopes.slice(0, fin.scopeDepth);
            this.finallyStack = savedFinally.slice(0, i);
            this.tryStack = savedTry.slice(0, fin.tryDepth);
            if (pretSlot !== null) this.scopes.push([{ slot: pretSlot, type: v!.type }]);
            this.emitBlock(fin.body);
            if (pretSlot !== null) this.scopes.pop();
          }
          if (!B.isTerminated()) this.releaseForJump(0, 0);
          this.frames = savedFrames;
          this.scopes = savedScopes;
          this.finallyStack = savedFinally;
          this.tryStack = savedTry;
        } else {
          this.releaseForJump(0, 0);
        }
        if (!B.isTerminated()) {
          if (this.currentWasiCoro !== null) {
            this.emitWasiFulfill(v);
            B.terminate(`br label %${this.currentWasiCoro.finalLabel}`);
          } else if (v === null) B.terminate("ret void");
          else B.terminate(`ret ${this.llType(s.value!.type)} ${v.name}`);
        }
        break;
      }
      case "throw": {
        // Evaluate, move ownership into the runtime's exception cell, then
        // unwind unconditionally (the innermost try handler, or out of the
        // function) — the same release path as return/break/continue.
        const v = this.emitExpr(s.value);
        if (isRefCounted(s.value.type)) this.moveTemp(v); // the cell takes ownership
        this.emitThrowValue({ name: v.name, type: s.value.type });
        this.emitUnwind();
        break;
      }
      case "rethrow": {
        // Re-raise the saved snapshot (payload retained — the binding
        // local releases with its scope) and unwind like `throw`.
        const c = B.tmp();
        B.line(`${c} = load ptr, ptr %${mangleLocal(s.localId)}`);
        this.declare(`declare void @scr_rethrow(ptr)`);
        B.line(`call void @scr_rethrow(ptr ${c})`);
        this.emitUnwind();
        break;
      }
      case "runtimeFence": {
        // The deferred JS compile fence: throw a catchable Error naming
        // the construct (message) with the SC code stamped on `code`,
        // then unwind exactly like `throw`. SCR_ERR_ERROR = 0.
        const bytes = Buffer.byteLength(s.message, "utf8");
        this.declare(`declare void @scr_throw_error_msg_code(i32, ptr, ${this.sizeType}, ptr)`);
        B.line(
          `call void @scr_throw_error_msg_code(i32 0, ptr ${this.cstr(s.message)}, ${this.sizeType} ${bytes}, ptr ${this.cstr(s.code)})`,
        );
        this.emitUnwind();
        break;
      }
      case "tryCatch":
        this.emitTryCatch(s);
        break;
      default: {
        // Statement coverage is now total (bytesSet closed the set) —
        // keep the loud refusal for any future IR statement kind.
        const rest: never = s;
        const k = (rest as IrStmt).kind;
        throw new LlvmUnsupportedError(`stmt:${k}`, (rest as IrStmt).loc);
      }
    }
    const frame = this.frames.pop()!;
    // return/throw already released their frames on the jump path; the
    // fall-through releases after them would be dead double-release code.
    if (s.kind !== "return" && s.kind !== "throw" && s.kind !== "rethrow" && s.kind !== "runtimeFence") {
      this.releaseFrame(frame);
    }
  }

  /** try/catch/finally via pending-flag unwinding — emit-stmts.ts's
   * emitTryCatch, block-flavored. Entering a try emits NO code: the try
   * context is compile-time state (tryStack) redirecting unwinds inside
   * the region to a label here. Shape:
   *
   *   { try body }           unwinds inside release frames/scopes down to
   *                          this statement's depths, then br the handler
   *   br after               (normal completion skips the handler)
   *   try.c:                 (emitted only when some unwind targets it)
   *     binding = scr_exc_take()   (or scr_exc_clear() when bindingless)
   *     { catch body }
   *   after: { finally body }      normal path
   *   br try.e
   *   try.fx:                exception path: the pending exception is
   *     stash = scr_exc_take()     STASHED across the finally body so the
   *     { finally body }           body's own pending checks answer for
   *     scr_rethrow(stash)         themselves; a throw inside REPLACES the
   *     <unwind>                   stash (it unwinds through the synthetic
   *   try.e:                       scope entry) — JS's semantics exactly
   *
   * Returns inside tryBody/catchBody ride the finallyStack (inline copies
   * at the return site — see `return`); break/continue never cross a
   * finally and no jump leaves a finally body (frontend fence + validator
   * backstop). */
  private emitTryCatch(s: IrStmt & { kind: "tryCatch" }): void {
    const B = this.B;
    const hasCatch = s.catchBody !== null;
    const hasFinally = s.finallyBody !== null;
    const catchLabel = B.newLabel("try.c");
    const finExcLabel = B.newLabel("try.fx");
    const endLabel = B.newLabel("try.e");
    const afterTryLabel = hasFinally ? B.newLabel("try.f") : endLabel;

    const handler = {
      label: hasCatch ? catchLabel : finExcLabel,
      used: false,
      frameDepth: this.frames.length,
      scopeDepth: this.scopes.length,
    };
    if (hasFinally) {
      this.finallyStack.push({
        frameDepth: this.frames.length,
        scopeDepth: this.scopes.length,
        tryDepth: this.tryStack.length,
        body: s.finallyBody!,
      });
    }
    this.tryStack.push(handler);
    this.emitBlock(s.tryBody);
    this.tryStack.pop();
    B.br(afterTryLabel); // no-op when the try body already terminated

    // Exceptions raised in the CATCH body unwind to the exception-path
    // finally (pending stays set through it) when one exists.
    const excHandler = {
      label: finExcLabel,
      used: !hasCatch && handler.used,
      frameDepth: this.frames.length,
      scopeDepth: this.scopes.length,
    };

    if (hasCatch && handler.used) {
      B.startBlock(catchLabel);
      if (hasFinally) this.tryStack.push(excHandler);
      if (this.currentGenerator !== null) {
        // Generator bodies: a pending GENRET sentinel (.return(v)
        // injected at a yield) is a RETURN completion, not a throw —
        // catch must not take it. Re-unwind past this handler (finally
        // still runs — the unwind targets the exception-path finally or
        // the enclosing context; the depths here equal the handler's).
        this.declare(`declare zeroext i1 @scr_exc_genret_pending()`);
        const gr = B.tmp();
        B.line(`${gr} = call zeroext i1 @scr_exc_genret_pending()`);
        const lg = B.newLabel("try.gr");
        const lk = B.newLabel("try.gk");
        B.condBr(gr, lg, lk);
        B.startBlock(lg);
        this.emitUnwind();
        B.startBlock(lk);
      }
      if (s.catchLocalId !== null) {
        // catch (e): the exception MOVES into the binding's snapshot box,
        // owned by the catch body's scope (released on every exit —
        // normal fall-through, jumps out, and unwinds from the body).
        const slot = `%${mangleLocal(s.catchLocalId)}`;
        this.declare(`declare ptr @scr_exc_take()`);
        this.emitBlock(s.catchBody!, (scope) => {
          const c = B.tmp();
          B.line(`${c} = call ptr @scr_exc_take() ; catch binding`);
          B.line(`store ptr ${c}, ptr ${slot}`);
          scope.push({ slot, type: CAUGHT });
        });
      } else {
        this.declare(`declare void @scr_exc_clear()`);
        B.line(`call void @scr_exc_clear() ; catch takes the exception`);
        this.emitBlock(s.catchBody!);
      }
      if (hasFinally) this.tryStack.pop();
      B.br(afterTryLabel); // the catch's normal completion
    }
    if (hasFinally) this.finallyStack.pop();

    if (hasFinally) {
      B.startBlock(afterTryLabel);
      this.emitBlock(s.finallyBody!); // normal path
      B.br(endLabel);
      if (excHandler.used) {
        // The pending exception is STASHED across the finally body (a
        // ScrCaught snapshot, re-raised after) so the body runs with a
        // CLEAN cell — see emit-stmts.ts's exception-path copy. The
        // stash rides an alloca slot so a throw inside the body unwinds
        // through the synthetic scope entry (replace semantics).
        B.startBlock(finExcLabel);
        this.declare(`declare ptr @scr_exc_take()`);
        this.declare(`declare void @scr_rethrow(ptr)`);
        this.declare(`declare void @scr_caught_release(ptr)`);
        const stash = B.tmp();
        const stashSlot = B.slot();
        B.entryAllocas.push(`${stashSlot} = alloca ptr ; finally exception stash`);
        B.line(`${stash} = call ptr @scr_exc_take() ; stash across finally`);
        B.line(`store ptr ${stash}, ptr ${stashSlot}`);
        this.scopes.push([{ slot: stashSlot, type: CAUGHT }]);
        this.emitBlock(s.finallyBody!);
        this.scopes.pop(); // normal completion keeps the stash for the re-raise
        B.line(`call void @scr_rethrow(ptr ${stash})`);
        B.line(`call void @scr_caught_release(ptr ${stash})`);
        this.emitUnwind();
      }
      B.startBlock(endLabel);
    } else {
      B.startBlock(endLabel);
    }
  }

  /** JS-exact switch: lazily evaluated, arbitrary-expression case tests in
   * source order, bodies falling through in source order until a break —
   * CEmitter.emitSwitch's goto chain, block-flavored. All case bodies
   * share ONE scope; because dispatch can jump PAST a varDecl into a later
   * case, refcounted/boxed case-body locals are NULL-reset up front and
   * the scope-exit releases rely on NULL tolerance. */
  private emitSwitch(s: IrStmt & { kind: "switch" }): void {
    const B = this.B;
    const discKind = s.disc.type.kind;
    if (discKind !== "f64" && discKind !== "string" && discKind !== "bool") {
      throw new LlvmUnsupportedError(`switch:${discKind}`, s.loc);
    }
    // The disc temp lives in the whole statement's frame: for a string
    // discriminant it stays alive across every test and body, released
    // when the switch statement ends (break lands past this statement's
    // frame release — releaseForJump keeps the target's own frame).
    const disc = this.emitExpr(s.disc);
    for (const c of s.cases) {
      for (const stmt of c.body) {
        if (stmt.kind !== "varDecl") continue;
        const local = this.currentLocals.get(stmt.localId)!;
        if (local.boxed || isRefCounted(local.type)) {
          B.line(`store ptr null, ptr %${mangleLocal(local.id)} ; case-scoped ${local.name}`);
        }
      }
    }
    const end = B.newLabel("sw.e");
    const caseLabels = s.cases.map(() => B.newLabel("sw.c"));
    let defaultIdx = -1;
    s.cases.forEach((c, i) => {
      if (c.test === null) {
        defaultIdx = i;
        return;
      }
      // Lazy source-order test evaluation (a test after the match never
      // runs). Each test's temps release right after its comparison.
      this.frames.push([]);
      const t = this.emitExpr(c.test);
      const hit = B.tmp();
      if (c.test.type.kind === "string") {
        this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${disc.name}, ptr ${t.name})`);
      } else if (c.test.type.kind === "bool") {
        B.line(`${hit} = icmp eq i1 ${disc.name}, ${t.name}`);
      } else {
        B.line(`${hit} = fcmp oeq double ${disc.name}, ${t.name}`);
      }
      this.releaseFrame(this.frames.pop()!);
      const next = B.newLabel("sw.t");
      B.condBr(hit, caseLabels[i]!, next);
      B.startBlock(next);
    });
    B.br(defaultIdx >= 0 ? caseLabels[defaultIdx]! : end);

    this.jumpTargets.push({
      kind: "switch",
      brkLabel: end,
      contLabel: null,
      ...(s.labels !== undefined && { labels: s.labels }),
      frameDepth: this.frames.length,
      scopeDepth: this.scopes.length,
    });
    const scope: LlScopeEntry[] = [];
    this.scopes.push(scope);
    s.cases.forEach((c, i) => {
      B.br(caseLabels[i]!); // the previous body's natural fall-through
      B.startBlock(caseLabels[i]!);
      this.emitStmts(c.body);
    });
    this.jumpTargets.pop();
    this.scopes.pop();
    // Natural fall-off of the last body releases the shared scope; a jump
    // already released it before jumping.
    const lastBody = s.cases[s.cases.length - 1]?.body;
    if (!lastBody || !this.endsWithJump(lastBody)) this.releaseScope(scope);
    B.br(end);
    B.startBlock(end);
  }

  /** Evaluates a condition (IR conds are bool-typed) and releases its
   * temps BEFORE the branch — safe because the result is a scalar i1, and
   * required in loop-condition blocks (their temps must not survive into
   * later blocks across the back edge). CEmitter.emitCondition. */
  private emitCondition(cond: IrExpr): string {
    const v = this.emitExpr(cond);
    const frame = this.currentFrame();
    this.releaseFrame(frame);
    frame.length = 0;
    return v.name;
  }

  /** Evaluates `expr` in its own statement frame inside an already-open
   * branch and moves the result into `slot`: the chosen value's ownership
   * transfers, every other temp the arm allocated releases inside the
   * branch. The shared core of ternary/logical. CEmitter.emitBranchInto. */
  private emitBranchInto(slot: string, expr: IrExpr): void {
    this.frames.push([]);
    const v = this.emitExpr(expr);
    this.moveTemp(v);
    this.B.line(`store ${this.llType(expr.type)} ${v.name}, ptr ${slot}`);
    this.releaseFrame(this.frames.pop()!);
  }

  // ── expressions ─────────────────────────────────────────────────────────

  private emitExpr(e: IrExpr): LlValue {
    const B = this.B;
    switch (e.kind) {
      case "numLit":
        return { name: f64Lit(e.value), type: e.type };
      case "boolLit":
        return { name: e.value ? "true" : "false", type: e.type };
      case "strLit": {
        const sym = this.internLiteral(e.value);
        return this.own({ name: this.retainValue(sym, e.type), type: e.type });
      }
      case "unitLit":
        // unitLits are consumed inline by the unionWrap case (a unit arm is
        // tag-only); one reaching the generic dispatch escaped its wrap.
        throw new Error(`llvm emitter bug: bare unitLit '${e.unit}'`);
      case "varRef": {
        const integerSlot = this.integerLoopBindings.get(e.localId);
        if (integerSlot !== undefined) {
          const integer = B.tmp();
          const number = B.tmp();
          B.line(`${integer} = load ${this.sizeType}, ptr ${integerSlot}`);
          B.line(`${number} = uitofp ${this.sizeType} ${integer} to double`);
          return { name: number, type: e.type };
        }
        const b = this.binding(e.localId);
        if (b.kind === "boxed") {
          // Reads go through the shared binding; ref kinds come out +1.
          // Forward-captured consts (tdz) test the box's payload slot
          // first: empty is the temporal dead zone (catchable
          // ReferenceError, Node's message).
          const box = this.loadBox(b.slot);
          if (b.local!.tdz === true) {
            const v = this.tdzBoxRead(box, e.type, b.local!.name);
            return this.own({ name: v, type: e.type });
          }
          const v = this.boxGet(box, e.type);
          return this.own({ name: v, type: e.type });
        }
        const t = B.tmp();
        B.line(`${t} = load ${this.llType(b.type)}, ptr ${b.slot}`);
        if (isRefCounted(e.type)) return this.own({ name: this.retainValue(t, e.type), type: e.type });
        return { name: t, type: e.type };
      }
      case "bin": {
        const l = this.emitExpr(e.left);
        const r = this.emitExpr(e.right);
        const t = B.tmp();
        const arith: Record<string, string> = { "+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv" };
        const cmp: Record<string, string> = { "<": "olt", "<=": "ole", ">": "ogt", ">=": "oge", "===": "oeq", "!==": "une" };
        const libm: Record<string, string> = { "%": "fmod", "**": "pow" };
        const bit: Record<string, string> = {
          "&": "scr_bit_and",
          "|": "scr_bit_or",
          "^": "scr_bit_xor",
          "<<": "scr_bit_shl",
          ">>": "scr_bit_shr",
          ">>>": "scr_bit_ushr",
        };
        if ((e.op === "===" || e.op === "!==") && e.left.type.kind === "bool") {
          B.line(`${t} = icmp ${e.op === "===" ? "eq" : "ne"} i1 ${l.name}, ${r.name}`);
        } else if ((e.op === "===" || e.op === "!==") && this.llType(e.left.type) === "ptr") {
          // Reference identity (JS object equality) — closures, arrays,
          // records compared as pointers, exactly the C `==`.
          B.line(`${t} = icmp ${e.op === "===" ? "eq" : "ne"} ptr ${l.name}, ${r.name}`);
        } else if (arith[e.op] !== undefined || cmp[e.op] !== undefined) {
          if (e.left.type.kind !== "f64") throw new LlvmUnsupportedError(`bin:${e.op}:${e.left.type.kind}`, e.loc);
          if (arith[e.op] !== undefined) B.line(`${t} = ${arith[e.op]} double ${l.name}, ${r.name}`);
          else B.line(`${t} = fcmp ${cmp[e.op]} double ${l.name}, ${r.name}`);
        } else {
          const fn = libm[e.op] ?? bit[e.op];
          if (fn === undefined) throw new LlvmUnsupportedError(`bin:${e.op}`, e.loc);
          this.declare(`declare double @${fn}(double, double)`);
          B.line(`${t} = call double @${fn}(double ${l.name}, double ${r.name})`);
        }
        return { name: t, type: e.type };
      }
      case "unary": {
        const v = this.emitExpr(e.operand);
        const t = B.tmp();
        if (e.op === "-") B.line(`${t} = fneg double ${v.name}`);
        else if (e.op === "!") B.line(`${t} = xor i1 ${v.name}, true`);
        else {
          this.declare(`declare double @scr_bit_not(double)`);
          B.line(`${t} = call double @scr_bit_not(double ${v.name})`);
        }
        return { name: t, type: e.type };
      }
      case "incDec": {
        // Expression-position ++/-- over an f64 binding (locals, module
        // globals, capture boxes): read, write ±1, yield old (postfix) or
        // new (prefix).
        const b = this.binding(e.localId);
        if (b.kind === "boxed") {
          const box = this.loadBox(b.slot);
          const old = this.boxGet(box, e.type);
          const next = B.tmp();
          B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
          this.boxSet(box, e.type, next);
          return { name: e.prefix ? next : old, type: e.type };
        }
        const old = B.tmp();
        const next = B.tmp();
        B.line(`${old} = load double, ptr ${b.slot}`);
        B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
        B.line(`store double ${next}, ptr ${b.slot}`);
        return { name: e.prefix ? next : old, type: e.type };
      }
      case "assignExpr": {
        // `x = e` in expression position: the binding takes its OWN
        // reference (retain for ref kinds), the temp stays the yielded
        // value — CEmitter's order exactly (release old, store retained).
        const b = this.binding(e.localId);
        const v = this.emitExpr(e.value);
        if (b.kind === "boxed") {
          // box_set takes ownership of the passed reference, so hand it a
          // retained copy and keep the temp's own reference for the yield.
          const stored = isRefCounted(v.type) ? this.retainValue(v.name, v.type) : v.name;
          this.boxSet(this.loadBox(b.slot), b.type, stored);
          return v;
        }
        if (isRefCounted(b.type)) {
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${b.slot}`);
          this.releaseValue(old, b.type);
          B.line(`store ptr ${this.retainValue(v.name, v.type)}, ptr ${b.slot}`);
        } else {
          B.line(`store ${this.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        }
        return v;
      }
      case "toBool":
        return { name: this.truthy(this.emitExpr(e.operand)), type: e.type };
      case "logical": {
        // JS value semantics: the result is the deciding operand itself.
        // Left evaluates once, ownership moves into the result slot; when
        // the branch takes the right operand the stale left releases first
        // and the right runs in its own frame — CEmitter's dance.
        const ty = this.llType(e.type);
        const l = this.emitExpr(e.left);
        this.moveTemp(l);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        B.line(`store ${ty} ${l.name}, ptr ${slot}`);
        const truthy = this.truthy(l);
        const lr = B.newLabel("log.r");
        const lj = B.newLabel("log.j");
        if (e.op === "&&") B.condBr(truthy, lr, lj);
        else B.condBr(truthy, lj, lr);
        B.startBlock(lr);
        if (isRefCounted(e.type)) this.releaseValue(l.name, e.type);
        this.emitBranchInto(slot, e.right);
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return this.own({ name: t, type: e.type });
      }
      case "ternary": {
        // Exactly one arm evaluates; each arm runs in its own frame and
        // moves the chosen value into the result slot.
        const ty = this.llType(e.type);
        const c = this.emitExpr(e.cond);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        const lt = B.newLabel("tern.t");
        const lf = B.newLabel("tern.f");
        const lj = B.newLabel("tern.j");
        B.condBr(c.name, lt, lf);
        B.startBlock(lt);
        this.emitBranchInto(slot, e.then);
        B.br(lj);
        B.startBlock(lf);
        this.emitBranchInto(slot, e.else_);
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return this.own({ name: t, type: e.type });
      }
      case "strConcat": {
        const l = this.emitExpr(e.left);
        const r = this.emitExpr(e.right);
        this.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_str_concat(ptr ${l.name}, ptr ${r.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "strEq": {
        const l = this.emitExpr(e.left);
        const r = this.emitExpr(e.right);
        this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        const eq = B.tmp();
        B.line(`${eq} = call zeroext i1 @scr_str_eq(ptr ${l.name}, ptr ${r.name})`);
        if (!e.negated) return { name: eq, type: e.type };
        const t = B.tmp();
        B.line(`${t} = xor i1 ${eq}, true`);
        return { name: t, type: e.type };
      }
      case "strCmp": {
        const l = this.emitExpr(e.left);
        const r = this.emitExpr(e.right);
        const fn = e.utf16 === true ? "scr_str_cmp_u16" : "scr_str_cmp";
        this.declare(`declare i32 @${fn}(ptr, ptr)`);
        const c = B.tmp();
        const t = B.tmp();
        const pred = { "<": "slt", "<=": "sle", ">": "sgt", ">=": "sge" }[e.op];
        B.line(`${c} = call i32 @${fn}(ptr ${l.name}, ptr ${r.name})`);
        B.line(`${t} = icmp ${pred} i32 ${c}, 0`);
        return { name: t, type: e.type };
      }
      case "toString": {
        const v = this.emitExpr(e.operand);
        if (v.type.kind === "union") {
          // The ARM value's ToString: an inline tag switch (unit arms are
          // interned literals, string arms retain the payload, f64/bool
          // arms format — the C per-union helper at the use site). Ref
          // arms never arrive (the frontend fences those).
          const def = this.unionsById.get(v.type.unionId);
          if (!def) throw new Error(`llvm emitter bug: ToString of unknown union ${v.type.unionId}`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const join = B.newLabel("us.j");
          this.unionTagSwitch(v.name, def, (arm) => {
            switch (arm.kind) {
              case "undefinedT":
              case "nullT": {
                const lit = this.internLiteral(arm.kind === "undefinedT" ? "undefined" : "null");
                B.line(`store ptr ${this.retainValue(lit, e.type)}, ptr ${slot}`);
                break;
              }
              case "string":
                B.line(`store ptr ${this.retainValue(this.unionPeek(v.name), e.type)}, ptr ${slot}`);
                break;
              case "f64": {
                const x = B.tmp();
                const r = B.tmp();
                this.declare(`declare double @scr_union_get_f64(ptr)`);
                this.declare(`declare ptr @scr_f64_to_scrstr(double)`);
                B.line(`${x} = call double @scr_union_get_f64(ptr ${v.name})`);
                B.line(`${r} = call ptr @scr_f64_to_scrstr(double ${x})`);
                B.line(`store ptr ${r}, ptr ${slot}`);
                break;
              }
              case "bool": {
                const x = B.tmp();
                const r = B.tmp();
                this.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
                this.declare(`declare ptr @scr_bool_to_scrstr(i1 zeroext)`);
                B.line(`${x} = call zeroext i1 @scr_union_get_bool(ptr ${v.name})`);
                B.line(`${r} = call ptr @scr_bool_to_scrstr(i1 zeroext ${x})`);
                B.line(`store ptr ${r}, ptr ${slot}`);
                break;
              }
              case "bytes": {
                // Buffer.toString() IS the utf8 decode (Node's default
                // encoding) — the `Buffer | string` chunk idiom.
                const enc = this.internLiteral("utf8");
                const p = this.unionPeek(v.name);
                const r = B.tmp();
                this.declare(`declare ptr @scr_bytes_to_str(ptr, ptr)`);
                B.line(`${r} = call ptr @scr_bytes_to_str(ptr ${p}, ptr ${enc})`);
                B.line(`store ptr ${r}, ptr ${slot}`);
                break;
              }
              default:
                throw new LlvmUnsupportedError(`toString:union:${arm.kind}`, e.loc);
            }
            B.br(join);
          });
          B.startBlock(join);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          return this.own({ name: t, type: e.type });
        }
        if (v.type.kind === "record") {
          // String(record) / `${record}`: Object.prototype.toString's
          // constant — the interned literal, retained like a strLit.
          const sym = this.internLiteral("[object Object]");
          return this.own({ name: this.retainValue(sym, e.type), type: e.type });
        }
        if (v.type.kind === "caught") {
          // String(e) / `${e}` on a catch binding: JS's String() over the
          // snapshot (scr_caught_to_string — borrows the box, +1 result).
          this.declare(`declare ptr @scr_caught_to_string(ptr)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_caught_to_string(ptr ${v.name})`);
          return this.own({ name: t, type: e.type });
        }
        if (v.type.kind === "dyn") {
          // String(unknown): dispatch over the dyn kind (dyn.ts's sc_ds —
          // Node's String() incl. arrays-join and "[object Object]").
          const helper = this.dyn.dynToStrHelper();
          const t = B.tmp();
          B.line(`${t} = call ptr @${helper}(ptr ${v.name})`);
          return this.own({ name: t, type: e.type });
        }
        const t = B.tmp();
        if (v.type.kind === "f64") {
          this.declare(`declare ptr @scr_f64_to_scrstr(double)`);
          B.line(`${t} = call ptr @scr_f64_to_scrstr(double ${v.name})`);
        } else if (v.type.kind === "bool") {
          this.declare(`declare ptr @scr_bool_to_scrstr(i1 zeroext)`);
          B.line(`${t} = call ptr @scr_bool_to_scrstr(i1 zeroext ${v.name})`);
        } else {
          throw new LlvmUnsupportedError(`toString:${v.type.kind}`, e.loc);
        }
        return this.own({ name: t, type: e.type });
      }
      case "strIntrinsic":
        return this.emitStrIntrinsic(e);
      case "arrayLit": {
        // Allocate, then push each element in order. Ownership of refcounted
        // plain elements moves into the array; SPREAD positions hold a
        // same-typed source array (borrowed): its elements copy in —
        // _get_ref returns +1 and _push_ref takes ownership, RC-balanced;
        // the length is snapshotted before the loop.
        if (e.type.kind !== "array") throw new Error("llvm emitter bug: arrayLit of non-array type");
        const elem = e.type.elem;
        const arr = B.tmp();
        B.line(`${arr} = ${arrNewCall(this, elem, String(e.elems.length))}`);
        const out = this.own({ name: arr, type: e.type });
        const acc = elemAccess(elem);
        const spreadSet = new Set(e.spreads ?? []);
        e.elems.forEach((el, i) => {
          const v = this.emitExpr(el);
          if (spreadSet.has(i)) {
            this.emitArrayCopyLoop(arr, v.name, acc);
            return;
          }
          if (acc === "ref") this.moveTemp(v);
          this.arrPush(arr, acc, v.name);
        });
        return out;
      }
      case "arrayNewLen": {
        // Mapper-less Array.from({ length: n }): a length-n array of
        // ABSENT slots — the interned undefined arm for unions carrying
        // one (immortal: pushing owes no retain), NULL for every other ref
        // element kind. The `i <= n - 1` bound is ToLength for the lengths
        // that terminate: fractions truncate, negative/NaN → empty.
        if (e.type.kind !== "array") throw new Error("llvm emitter bug: arrayNewLen of non-array type");
        const elem = e.type.elem;
        const n = this.emitExpr(e.length);
        const arr = B.tmp();
        B.line(`${arr} = ${arrNewCall(this, elem, "0")}`);
        const out = this.own({ name: arr, type: e.type });
        const acc = elemAccess(elem);
        let fill = acc === "f64" ? f64Lit(0) : acc === "bool" ? "false" : "null";
        if (elem.kind === "union") {
          const tag = this.undefinedArmTag(elem);
          if (tag >= 0) fill = this.unitInstanceRef(elem.unionId, tag);
        }
        const iSlot = B.slot();
        B.entryAllocas.push(`${iSlot} = alloca double`);
        B.line(`store double ${f64Lit(0)}, ptr ${iSlot}`);
        const lc = B.newLabel("anl.c");
        const lb = B.newLabel("anl.b");
        const le = B.newLabel("anl.e");
        const bound = B.tmp();
        B.line(`${bound} = fsub double ${n.name}, ${f64Lit(1)}`);
        B.br(lc);
        B.startBlock(lc);
        const i = B.tmp();
        const cont = B.tmp();
        B.line(`${i} = load double, ptr ${iSlot}`);
        B.line(`${cont} = fcmp ole double ${i}, ${bound}`);
        B.condBr(cont, lb, le);
        B.startBlock(lb);
        this.arrPush(arr, acc, fill);
        const i2 = B.tmp();
        B.line(`${i2} = fadd double ${i}, ${f64Lit(1)}`);
        B.line(`store double ${i2}, ptr ${iSlot}`);
        B.br(lc);
        B.startBlock(le);
        return out;
      }
      case "arrayGet": {
        const arr = this.emitExpr(e.arr);
        const idx = this.emitExpr(e.index);
        if (e.arr.type.kind !== "array") throw new Error("llvm emitter bug: arrayGet on non-array");
        // Ref-element reads return +1 (the runtime retains); own registers
        // the owned temp in the frame like any other.
        const acc = elemAccess(e.arr.type.elem);
        const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
        this.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ${accTy} @scr_arr_get_${acc}(ptr ${arr.name}, double ${idx.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "arrIntrinsic":
        return this.emitArrIntrinsic(e);
      case "mapNew":
        return this.emitMapNew(e);
      case "mapIntrinsic":
        return this.emitMapIntrinsic(e);
      case "setNew":
        return this.emitSetNew(e);
      case "setIntrinsic":
        return this.emitSetIntrinsic(e);
      case "regexLit": {
        // One immortal static per (pattern, flags) pair; the +1 retain is
        // a no-op on immortals but keeps the owned-temps discipline
        // uniform. Pattern/flags strings intern NOW (the literal table is
        // still open — the C emitter's regex-literal discipline).
        const key = `${e.flags}/${e.pattern}`;
        let re = this.regexInstances.get(key);
        if (!re) {
          re = {
            sym: `sc_re_${this.regexInstances.size}`,
            src: this.internLiteral(e.pattern),
            fl: this.internLiteral(e.flags),
          };
          this.regexInstances.set(key, re);
        }
        return this.own({ name: this.retainValue(`@${re.sym}`, e.type), type: e.type });
      }
      case "templateStrings": {
        // One immortal static string array per template SITE (the key);
        // the +1 retain is a no-op on immortals. Cooked strings intern
        // NOW (the literal table is still open).
        let inst = this.templateStringsInstances.get(e.key);
        if (!inst) {
          inst = {
            sym: `sc_tsa_${this.templateStringsInstances.size}`,
            slots: e.cooked.map((s) => this.internLiteral(s)),
          };
          this.templateStringsInstances.set(e.key, inst);
        }
        return this.own({ name: this.retainValue(`@${inst.sym}`, e.type), type: e.type });
      }
      case "regexIntrinsic":
        return this.emitRegexIntrinsic(e);
      case "recordKeyGet":
        return this.emitRecordKeyGet(e);
      case "recordLit": {
        // Allocate (fields zeroed), then write each field IN SOURCE ORDER —
        // JS evaluates property values in source order. Ownership of
        // refcounted values moves in; the struct is fresh, so there is
        // never an old value to release. OVERFLOW entries insert into the
        // shape's overflow map in the same interleaved order.
        if (e.type.kind !== "record") throw new Error("llvm emitter bug: recordLit of non-record type");
        const shapeId = e.type.shapeId;
        const rec = B.tmp();
        B.line(`${rec} = call ptr @${mangleRecordNew(shapeId)}()`);
        const out = this.own({ name: rec, type: e.type });
        for (const f of e.fields) {
          if (f.drop) {
            // A mapping-dropped field: the initializer runs in its source-
            // order slot — effects included — and the result (if any)
            // releases with the statement frame instead of storing.
            this.emitExpr(f.value);
            continue;
          }
          const v = this.emitExpr(f.value);
          if (f.overflow) {
            const lit = this.internLiteral(f.name);
            const acc = v.type.kind === "f64" ? "f64" : v.type.kind === "bool" ? "bool" : "ref";
            if (acc === "ref") this.moveTemp(v);
            const ovf = this.recordOvfPtr(rec, shapeId);
            const argTy = acc === "f64" ? "double" : acc === "bool" ? "i1 zeroext" : "ptr";
            this.declare(`declare void @scr_map_set_str_${acc}(ptr, ptr, ${argTy})`);
            B.line(
              `call void @scr_map_set_str_${acc}(ptr ${ovf}, ptr ${lit}, ${argTy === "i1 zeroext" ? "i1" : argTy} ${v.name})`,
            );
            continue;
          }
          if (isRefCounted(v.type)) this.moveTemp(v);
          const { ptr, type } = this.recordFieldPtr(rec, shapeId, f.name);
          this.storeField(ptr, type, v.name);
        }
        return out;
      }
      case "recordGet": {
        const obj = this.emitExpr(e.obj);
        const { ptr, type } = this.recordFieldPtr(obj.name, e.shapeId, e.field);
        const v = this.loadField(ptr, type);
        if (isRefCounted(e.type)) return this.own({ name: this.retainValue(v, e.type), type: e.type });
        return { name: v, type: e.type };
      }
      case "recordOvfKeys": {
        // The overflow map's live keys in JS own-key order — a fresh
        // string[] snapshot (+1); the record is borrowed.
        const obj = this.emitExpr(e.obj);
        const ovf = this.recordOvfPtr(obj.name, e.shapeId);
        this.declare(`declare ptr @scr_map_keys_js_order(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_map_keys_js_order(ptr ${ovf})`);
        return this.own({ name: t, type: e.type });
      }
      case "unionWrap": {
        // Construct a fresh immutable tagged box. Ownership of a refcounted
        // payload MOVES into the union; scalars ride the slot. Unit arms
        // carry NO payload: every wrap yields THE interned immortal
        // instance for this (union, tag) — no allocation, and the frame's
        // release is a no-op (rc == SIZE_MAX).
        const arm = e.value.type;
        if (isUnitType(arm)) {
          return this.own({ name: this.unitInstanceRef(e.unionId, e.tag), type: e.type });
        }
        // A VOID payload (a void call wrapping into an undefined arm):
        // evaluate for effects, produce the interned unit instance.
        if (arm.kind === "void") {
          this.emitExpr(e.value);
          return this.own({ name: this.unitInstanceRef(e.unionId, e.tag), type: e.type });
        }
        const v = this.emitExpr(e.value);
        if (isRefCounted(arm)) this.moveTemp(v);
        return this.own({ name: this.unionNewOwned(e.tag, v), type: e.type });
      }
      case "unionNarrow": {
        // Tag-UNCHECKED payload extraction: the frontend emits this only
        // where tsc's control-flow narrowing proved the tag. Ref payloads
        // come out +1; the union temp itself releases with this
        // statement's frame as usual.
        const u = this.emitExpr(e.value);
        const arm = e.type;
        if (isUnitType(arm)) throw new Error(`llvm emitter bug: unionNarrow to unit arm ${arm.kind}`);
        const v = this.unionExtract(u.name, arm);
        return this.own({ name: v, type: arm });
      }
      case "unionDisc": {
        // Shared-field read `r.kind`: switch on the runtime tag and read
        // the (same-typed) field from the concretely-typed payload.
        // Ref-counted results come out retained (+1), owned by this frame.
        const u = this.emitExpr(e.value);
        const def = this.unionsById.get(e.unionId);
        if (!def) throw new Error(`llvm emitter bug: unionDisc of unknown union ${e.unionId}`);
        const ty = this.llType(e.type);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        const join = B.newLabel("ud.j");
        this.unionTagSwitch(u.name, def, (arm) => {
          if (arm.kind !== "record" && arm.kind !== "object") {
            throw new LlvmUnsupportedError(`unionDisc:${arm.kind}`, e.loc);
          }
          const payload = this.unionPeek(u.name);
          const { ptr, type } =
            arm.kind === "object"
              ? this.classFieldPtr(payload, arm.className, e.field)
              : this.recordFieldPtr(payload, arm.shapeId, e.field);
          const v = this.loadField(ptr, type);
          const value = isRefCounted(e.type) ? this.retainValue(v, e.type) : v;
          B.line(`store ${ty} ${value}, ptr ${slot}`);
          B.br(join);
        });
        B.startBlock(join);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return this.own({ name: t, type: e.type });
      }
      case "unionIsTag": {
        // A pure tag compare — the box is borrowed, no payload is touched.
        const u = this.emitExpr(e.value);
        const tag = this.unionTag(u.name);
        const t = B.tmp();
        B.line(`${t} = icmp ${e.negated ? "ne" : "eq"} i32 ${tag}, ${e.tag}`);
        return { name: t, type: e.type };
      }
      case "unionKeyGet": {
        // The unionDisc generalization: switch on the runtime tag; each
        // arm answers at the JOIN type — a declared field reads its slot
        // (wrapping an arm-typed answer into the join), an index-signature
        // arm rides the shared keyed-read chain (owned result, missing-key
        // policy included), and a unit arm answers the interned undefined
        // arm (the optional-chain tail's short-circuit value).
        const u = this.emitExpr(e.value);
        const k = this.emitExpr(e.key);
        const def = this.unionsById.get(e.unionId);
        if (!def) throw new Error(`llvm emitter bug: unionKeyGet of unknown union ${e.unionId}`);
        const resultDef = e.type.kind === "union" ? this.unionsById.get(e.type.unionId) : undefined;
        const literal = e.key.kind === "strLit" ? e.key.value : null;
        const ty = this.llType(e.type);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        const join = B.newLabel("ukg.j");
        this.unionTagSwitch(u.name, def, (arm) => {
          if (isUnitType(arm)) {
            if (e.type.kind === "dyn") {
              // A dyn-typed chain: the unit path is the undefined dyn
              // value — dyn represents undefined directly.
              this.declare(`declare ptr @scr_dyn_undefined()`);
              this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
              const un = B.tmp();
              const r = B.tmp();
              B.line(`${un} = call ptr @scr_dyn_undefined()`);
              B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${un})`);
              B.line(`store ptr ${r}, ptr ${slot}`);
              B.br(join);
              return;
            }
            const tag = resultDef?.arms.findIndex((a) => a.kind === "undefinedT") ?? -1;
            if (tag < 0 || e.type.kind !== "union") {
              throw new Error("llvm emitter bug: unionKeyGet unit arm without an undefined result arm");
            }
            B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, tag)}, ptr ${slot}`);
            B.br(join);
            return;
          }
          if (arm.kind === "array") {
            // A NUMBER-keyed element read (the chain-tail form): the
            // runtime getter answers owned (+1 for ref elements); invalid
            // indices trap. The result wraps into the join when unit arms
            // widened it.
            const payload = this.unionPeek(u.name);
            const acc = elemAccess(arm.elem);
            const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
            this.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
            const v = B.tmp();
            B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr ${payload}, double ${k.name})`);
            if (typeEquals(arm.elem, e.type)) {
              B.line(`store ${ty} ${v}, ptr ${slot}`);
              B.br(join);
              return;
            }
            const tag = resultDef?.arms.findIndex((a) => typeEquals(a, arm.elem)) ?? -1;
            if (tag < 0 || e.type.kind !== "union" || isUnitType(arm.elem)) {
              throw new Error(`llvm emitter bug: unionKeyGet element ${arm.elem.kind} outside the join`);
            }
            // The element read is already owned (+1) — ownership MOVES
            // into the union box, no extra retain.
            B.line(`store ptr ${this.unionNewOwned(tag, { name: v, type: arm.elem })}, ptr ${slot}`);
            B.br(join);
            return;
          }
          if (arm.kind !== "record") throw new LlvmUnsupportedError(`unionKeyGet:${arm.kind}`, e.loc);
          const shape = this.recordShape(arm.shapeId);
          const payload = this.unionPeek(u.name);
          const declared = literal !== null ? shape.fields.find((f) => f.name === literal) : undefined;
          if (declared) {
            const { ptr, type: ft } = this.recordFieldPtr(payload, arm.shapeId, declared.name);
            const v = this.loadField(ptr, ft);
            if (typeEquals(ft, e.type)) {
              B.line(`store ${ty} ${isRefCounted(ft) ? this.retainValue(v, ft) : v}, ptr ${slot}`);
              B.br(join);
              return;
            }
            const tag = resultDef?.arms.findIndex((a) => typeEquals(a, ft)) ?? -1;
            if (tag < 0 || e.type.kind !== "union" || isUnitType(ft)) {
              throw new Error(`llvm emitter bug: unionKeyGet arm answer ${ft.kind} outside the join`);
            }
            const wrapped =
              ft.kind === "f64" || ft.kind === "bool"
                ? this.unionNewOwned(tag, { name: v, type: ft })
                : this.unionNewOwned(tag, { name: this.retainValue(v, ft), type: ft });
            B.line(`store ptr ${wrapped}, ptr ${slot}`);
            B.br(join);
            return;
          }
          // Index-signature arm (or declared-only shape under a runtime
          // key): the shared keyed-read chain — a literal key naming no
          // declared field touches only the overflow map.
          this.keyedRecordReadInto(
            slot,
            join,
            payload,
            k.name,
            arm.shapeId,
            e.type,
            literal !== null && !!shape.indexValue,
            e.loc,
          );
        });
        B.startBlock(join);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return this.own({ name: t, type: e.type });
      }
      case "unionEq": {
        // Strict equality of the ARM values (tag compare + per-arm payload
        // compare — the C per-union helper, inlined). Both boxes borrowed.
        const l = this.emitExpr(e.left);
        const r = this.emitExpr(e.right);
        const def = this.unionsById.get(e.unionId);
        if (!def) throw new Error(`llvm emitter bug: equality of unknown union ${e.unionId}`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca i1`);
        const join = B.newLabel("ue.j");
        const same = B.newLabel("ue.s");
        const ltag = this.unionTag(l.name);
        const rtag = this.unionTag(r.name);
        const tagEq = B.tmp();
        B.line(`${tagEq} = icmp eq i32 ${ltag}, ${rtag}`);
        B.line(`store i1 false, ptr ${slot}`);
        B.condBr(tagEq, same, join);
        B.startBlock(same);
        this.unionTagSwitch(l.name, def, (arm) => {
          switch (arm.kind) {
            case "undefinedT":
            case "nullT":
              B.line(`store i1 true, ptr ${slot}`);
              break;
            case "f64": {
              this.declare(`declare double @scr_union_get_f64(ptr)`);
              const a = B.tmp();
              const b = B.tmp();
              const t = B.tmp();
              B.line(`${a} = call double @scr_union_get_f64(ptr ${l.name})`);
              B.line(`${b} = call double @scr_union_get_f64(ptr ${r.name})`);
              if (e.sameValue) {
                // Object.is's f64 compare: NaN equals NaN, +0 differs
                // from -0 — the runtime SameValue.
                this.declare(`declare zeroext i1 @scr_num_same_value(double, double)`);
                B.line(`${t} = call zeroext i1 @scr_num_same_value(double ${a}, double ${b})`);
              } else {
                B.line(`${t} = fcmp oeq double ${a}, ${b}`);
              }
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
            case "bool": {
              this.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
              const a = B.tmp();
              const b = B.tmp();
              const t = B.tmp();
              B.line(`${a} = call zeroext i1 @scr_union_get_bool(ptr ${l.name})`);
              B.line(`${b} = call zeroext i1 @scr_union_get_bool(ptr ${r.name})`);
              B.line(`${t} = icmp eq i1 ${a}, ${b}`);
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
            case "string": {
              this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
              const a = this.unionPeek(l.name);
              const b = this.unionPeek(r.name);
              const t = B.tmp();
              B.line(`${t} = call zeroext i1 @scr_str_eq(ptr ${a}, ptr ${b})`);
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
            default: {
              // Ref arms: pointer identity, exactly JS object equality.
              const a = this.unionPeek(l.name);
              const b = this.unionPeek(r.name);
              const t = B.tmp();
              B.line(`${t} = icmp eq ptr ${a}, ${b} ; ${arm.kind}`);
              B.line(`store i1 ${t}, ptr ${slot}`);
              break;
            }
          }
          B.br(join);
        });
        B.startBlock(join);
        const eq = B.tmp();
        B.line(`${eq} = load i1, ptr ${slot}`);
        if (!e.negated) return { name: eq, type: e.type };
        const t = B.tmp();
        B.line(`${t} = xor i1 ${eq}, true`);
        return { name: t, type: e.type };
      }
      case "orDefault": {
        // `u || d` narrowed to the single non-unit arm: nullish's dance
        // with the union TRUTHY switch as the test — truthy extracts the
        // arm (+1 for ref kinds), falsy releases and runs the default.
        if (e.left.type.kind !== "union") throw new Error("llvm emitter bug: orDefault left is not a union");
        const l = this.emitExpr(e.left);
        this.moveTemp(l);
        const ty = this.llType(e.type);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        const truthy = this.truthy(l);
        const lt = B.newLabel("ord.t");
        const lf = B.newLabel("ord.f");
        const lj = B.newLabel("ord.j");
        B.condBr(truthy, lt, lf);
        B.startBlock(lt);
        if (e.retag !== undefined) {
          // Retagged shape: the whole box goes to the union→union helper,
          // which CONSUMES it (callees own their params) — no release on
          // this side. The store precedes the pending check so an unwind
          // leaves only the NULL dummy behind, in a slot nothing reads.
          const t = B.tmp();
          B.line(`${t} = call ${ty} @${this.callTarget(e.retag)}(${this.llType(e.left.type)} ${l.name})`);
          B.line(`store ${ty} ${t}, ptr ${slot}`);
          if (this.mayThrow.has(e.retag)) this.emitPendingCheck();
        } else {
          B.line(`store ${ty} ${this.unionExtract(l.name, e.type)}, ptr ${slot}`);
          this.releaseValue(l.name, e.left.type);
        }
        B.br(lj);
        B.startBlock(lf);
        this.releaseValue(l.name, e.left.type);
        this.emitBranchInto(slot, e.right);
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return this.own({ name: t, type: e.type });
      }
      case "unionFuncEq": {
        const u = this.emitExpr(e.union);
        const f = this.emitExpr(e.func);
        const tag = this.unionTag(u.name);
        const tagMatch = B.tmp();
        B.line(`${tagMatch} = icmp eq i32 ${tag}, ${e.tag}`);
        const payload = this.unionPeek(u.name);
        const ptrMatch = B.tmp();
        B.line(`${ptrMatch} = icmp eq ptr ${payload}, ${f.name}`);
        const result = B.tmp();
        B.line(`${result} = and i1 ${tagMatch}, ${ptrMatch}`);
        if (!e.negated) return this.own({ name: result, type: e.type });
        const negated = B.tmp();
        B.line(`${negated} = xor i1 ${result}, true`);
        return this.own({ name: negated, type: e.type });
      }
      case "nullish": {
        // `a ?? b`: logical's move/release dance with the left's runtime
        // TAG against its unit arms as the test. Pass-through shape: the
        // result IS the left box. Narrowed shape: the single non-unit
        // arm's payload extracts (+1 for ref kinds) and the box releases.
        if (e.left.type.kind === "jsval") {
          // The island form: engine nullish test, lazy right (jsval).
          const l = this.emitExpr(e.left);
          this.moveTemp(l);
          this.declare(`declare zeroext i1 @scr_jsval_is_nullish(ptr)`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const isN = B.tmp();
          B.line(`${isN} = call zeroext i1 @scr_jsval_is_nullish(ptr ${l.name})`);
          const lu = B.newLabel("nulj.u");
          const lv = B.newLabel("nulj.v");
          const lj = B.newLabel("nulj.j");
          B.condBr(isN, lu, lv);
          B.startBlock(lu);
          this.releaseValue(l.name, e.left.type);
          this.emitBranchInto(slot, e.right);
          B.br(lj);
          B.startBlock(lv);
          B.line(`store ptr ${l.name}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lj);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          return this.own({ name: t, type: e.type });
        }
        if (e.left.type.kind === "dyn") {
          // The checked-dynamic form: the runtime kind decides (UNDEF/
          // NULL take the default; a wrapped island value asks the
          // engine); the right runs lazily in its branch (already dyn).
          const l = this.emitExpr(e.left);
          this.moveTemp(l);
          this.declare(`declare zeroext i1 @scr_dyn_is_nullish(ptr)`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const isN = B.tmp();
          B.line(`${isN} = call zeroext i1 @scr_dyn_is_nullish(ptr ${l.name})`);
          const lu = B.newLabel("nuld.u");
          const lv = B.newLabel("nuld.v");
          const lj = B.newLabel("nuld.j");
          B.condBr(isN, lu, lv);
          B.startBlock(lu);
          this.releaseValue(l.name, e.left.type);
          this.emitBranchInto(slot, e.right);
          B.br(lj);
          B.startBlock(lv);
          B.line(`store ptr ${l.name}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lj);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          return this.own({ name: t, type: e.type });
        }
        if (e.left.type.kind !== "union") throw new Error("llvm emitter bug: nullish left is not a union");
        const def = this.unionsById.get(e.left.type.unionId);
        if (!def) throw new Error(`llvm emitter bug: nullish of unknown union ${e.left.type.unionId}`);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        if (unitTags.length === 0) throw new Error("llvm emitter bug: nullish union lacks unit arms");
        const l = this.emitExpr(e.left);
        this.moveTemp(l);
        const ty = this.llType(e.type);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        const isUnit = this.tagInSet(l.name, unitTags);
        const lu = B.newLabel("nul.u");
        const lv = B.newLabel("nul.v");
        const lj = B.newLabel("nul.j");
        B.condBr(isUnit, lu, lv);
        B.startBlock(lu);
        this.releaseValue(l.name, e.left.type);
        this.emitBranchInto(slot, e.right);
        B.br(lj);
        B.startBlock(lv);
        if (typeEquals(e.type, e.left.type)) {
          B.line(`store ${ty} ${l.name}, ptr ${slot}`);
        } else {
          B.line(`store ${ty} ${this.unionExtract(l.name, e.type)}, ptr ${slot}`);
          this.releaseValue(l.name, e.left.type);
        }
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return this.own({ name: t, type: e.type });
      }
      case "optChain": {
        // `a?.b` / `f?.()`: the nullish test inverted. The receiver
        // evaluates once into an ordinary frame temp (borrowed); on a unit
        // tag the result is the interned undefined arm and the body never
        // runs; otherwise the narrowed payload fills the bind slot (+1,
        // frame-owned through a SLOT entry — NULL on the unit path, where
        // the frame's release is a no-op) and the body reads it through
        // chainRecv.
        if (e.receiver.type.kind === "dyn") {
          // A dyn (dyn) receiver — the `rawName?.match(re)` step: the
          // nullish test reads the node's kind tag; the unit path is the
          // undefined dyn singleton (dyn results) or nothing (void
          // bodies), the body runs over the bound receiver otherwise.
          const r = this.emitExpr(e.receiver);
          const kd = this.dynKind(r.name);
          const isU = B.tmp();
          const isN = B.tmp();
          const isUnit = B.tmp();
          B.line(`${isU} = icmp eq i32 ${kd}, ${DK.UNDEF}`);
          B.line(`${isN} = icmp eq i32 ${kd}, ${DK.NULL}`);
          B.line(`${isUnit} = or i1 ${isU}, ${isN}`);
          const bind = B.slot();
          B.entryAllocas.push(`${bind} = alloca ptr`);
          B.line(`store ptr null, ptr ${bind}`);
          this.ownSlot(bind, e.receiver.type);
          this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
          if (e.type.kind === "void") {
            const lb = B.newLabel("ocd.b");
            const lj = B.newLabel("ocd.j");
            B.condBr(isUnit, lj, lb);
            B.startBlock(lb);
            const rr = B.tmp();
            B.line(`${rr} = call ptr @scr_dyn_retain_v(ptr ${r.name})`);
            B.line(`store ptr ${rr}, ptr ${bind}`);
            this.chainSlots.set(e.id, { name: bind, type: e.receiver.type, slot: true });
            this.frames.push([]);
            this.emitExpr(e.body);
            this.releaseFrame(this.frames.pop()!);
            this.chainSlots.delete(e.id);
            B.br(lj);
            B.startBlock(lj);
            return { name: "", type: e.type };
          }
          if (e.type.kind !== "dyn") throw new Error("llvm emitter bug: dyn optChain result kind");
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const lu = B.newLabel("ocd.u");
          const lb = B.newLabel("ocd.b");
          const lj = B.newLabel("ocd.j");
          B.condBr(isUnit, lu, lb);
          B.startBlock(lu);
          this.declare(`declare ptr @scr_dyn_undefined()`);
          const un = B.tmp();
          const ur = B.tmp();
          B.line(`${un} = call ptr @scr_dyn_undefined()`);
          B.line(`${ur} = call ptr @scr_dyn_retain_v(ptr ${un})`);
          B.line(`store ptr ${ur}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lb);
          const rr = B.tmp();
          B.line(`${rr} = call ptr @scr_dyn_retain_v(ptr ${r.name})`);
          B.line(`store ptr ${rr}, ptr ${bind}`);
          this.chainSlots.set(e.id, { name: bind, type: e.receiver.type, slot: true });
          this.emitBranchInto(slot, e.body);
          this.chainSlots.delete(e.id);
          B.br(lj);
          B.startBlock(lj);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          return this.own({ name: t, type: e.type });
        }
        if (e.receiver.type.kind === "jsval") {
          // Island-handle chain: the nullish test asks the engine value;
          // the unit path result is the engine's undefined (+1 cell), the
          // body runs lazily over the bound handle otherwise.
          const r = this.emitExpr(e.receiver);
          this.declare(`declare zeroext i1 @scr_jsval_is_nullish(ptr)`);
          this.declare(`declare ptr @scr_jsval_retain_v(ptr)`);
          const isN = B.tmp();
          B.line(`${isN} = call zeroext i1 @scr_jsval_is_nullish(ptr ${r.name})`);
          const bind = B.slot();
          B.entryAllocas.push(`${bind} = alloca ptr`);
          B.line(`store ptr null, ptr ${bind}`);
          this.ownSlot(bind, e.receiver.type);
          if (e.type.kind === "void") {
            const lb = B.newLabel("ocj.b");
            const lj = B.newLabel("ocj.j");
            B.condBr(isN, lj, lb);
            B.startBlock(lb);
            const rr = B.tmp();
            B.line(`${rr} = call ptr @scr_jsval_retain_v(ptr ${r.name})`);
            B.line(`store ptr ${rr}, ptr ${bind}`);
            this.chainSlots.set(e.id, { name: bind, type: e.receiver.type, slot: true });
            this.frames.push([]);
            this.emitExpr(e.body);
            this.releaseFrame(this.frames.pop()!);
            this.chainSlots.delete(e.id);
            B.br(lj);
            B.startBlock(lj);
            return { name: "", type: e.type };
          }
          if (e.type.kind !== "jsval") throw new Error("llvm emitter bug: jsval optChain result kind");
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const lu = B.newLabel("ocj.u");
          const lb = B.newLabel("ocj.b");
          const lj = B.newLabel("ocj.j");
          B.condBr(isN, lu, lb);
          B.startBlock(lu);
          this.declare(`declare ptr @scr_jsval_undefined()`);
          const un = B.tmp();
          B.line(`${un} = call ptr @scr_jsval_undefined()`);
          B.line(`store ptr ${un}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lb);
          const rr = B.tmp();
          B.line(`${rr} = call ptr @scr_jsval_retain_v(ptr ${r.name})`);
          B.line(`store ptr ${rr}, ptr ${bind}`);
          this.chainSlots.set(e.id, { name: bind, type: e.receiver.type, slot: true });
          this.emitBranchInto(slot, e.body);
          this.chainSlots.delete(e.id);
          B.br(lj);
          B.startBlock(lj);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          return this.own({ name: t, type: e.type });
        }
        if (e.receiver.type.kind !== "union") throw new LlvmUnsupportedError(`optChain:${e.receiver.type.kind}`, e.loc);
        const def = this.unionsById.get(e.receiver.type.unionId);
        if (!def) throw new Error(`llvm emitter bug: optChain of unknown union ${e.receiver.type.unionId}`);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        const narrowIdx = def.arms.findIndex((a) => !isUnitType(a));
        if (unitTags.length === 0 || narrowIdx < 0) throw new Error("llvm emitter bug: optChain union arms");
        const narrowed = def.arms[narrowIdx]!;
        const r = this.emitExpr(e.receiver);
        const bind = B.slot();
        B.entryAllocas.push(`${bind} = alloca ${this.llType(narrowed)}`);
        B.line(
          `store ${this.llType(narrowed)} ${this.llType(narrowed) === "ptr" ? "null" : this.llType(narrowed) === "double" ? f64Lit(0) : "false"}, ptr ${bind}`,
        );
        this.ownSlot(bind, narrowed);
        const isUnit = this.tagInSet(r.name, unitTags);
        if (e.type.kind === "void") {
          // Statement form (cb?.()): no result value at all.
          const lb = B.newLabel("oc.b");
          const lj = B.newLabel("oc.j");
          B.condBr(isUnit, lj, lb);
          B.startBlock(lb);
          B.line(`store ${this.llType(narrowed)} ${this.unionExtract(r.name, narrowed)}, ptr ${bind}`);
          this.chainSlots.set(e.id, { name: bind, type: narrowed, slot: true });
          this.frames.push([]);
          this.emitExpr(e.body);
          this.releaseFrame(this.frames.pop()!);
          this.chainSlots.delete(e.id);
          B.br(lj);
          B.startBlock(lj);
          return { name: "", type: e.type };
        }
        if (e.type.kind === "dyn") {
          // A dyn-typed chain (`pricing?.[key]` over an unknown-valued
          // index signature): the unit path is the undefined dyn value —
          // dyn represents undefined directly, no union wrapper exists.
          const slotD = B.slot();
          B.entryAllocas.push(`${slotD} = alloca ptr`);
          const lu = B.newLabel("ocu.u");
          const lb = B.newLabel("ocu.b");
          const lj = B.newLabel("ocu.j");
          B.condBr(isUnit, lu, lb);
          B.startBlock(lu);
          this.declare(`declare ptr @scr_dyn_undefined()`);
          this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
          const un = B.tmp();
          const ur = B.tmp();
          B.line(`${un} = call ptr @scr_dyn_undefined()`);
          B.line(`${ur} = call ptr @scr_dyn_retain_v(ptr ${un})`);
          B.line(`store ptr ${ur}, ptr ${slotD}`);
          B.br(lj);
          B.startBlock(lb);
          B.line(`store ${this.llType(narrowed)} ${this.unionExtract(r.name, narrowed)}, ptr ${bind}`);
          this.chainSlots.set(e.id, { name: bind, type: narrowed, slot: true });
          this.emitBranchInto(slotD, e.body);
          this.chainSlots.delete(e.id);
          B.br(lj);
          B.startBlock(lj);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slotD}`);
          return this.own({ name: t, type: e.type });
        }
        if (e.type.kind !== "union") throw new LlvmUnsupportedError(`optChainResult:${e.type.kind}`, e.loc);
        const undefTag = this.undefinedArmTag(e.type);
        if (undefTag < 0) throw new Error("llvm emitter bug: optChain result lacks its undefined arm");
        const ty = this.llType(e.type);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty}`);
        const lu = B.newLabel("oc.u");
        const lb = B.newLabel("oc.b");
        const lj = B.newLabel("oc.j");
        B.condBr(isUnit, lu, lb);
        B.startBlock(lu);
        B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lb);
        B.line(`store ${this.llType(narrowed)} ${this.unionExtract(r.name, narrowed)}, ptr ${bind}`);
        this.chainSlots.set(e.id, { name: bind, type: narrowed, slot: true });
        this.emitBranchInto(slot, e.body);
        this.chainSlots.delete(e.id);
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ${ty}, ptr ${slot}`);
        return this.own({ name: t, type: e.type });
      }
      case "chainRecv": {
        const bound = this.chainSlots.get(e.id);
        if (!bound) throw new Error(`llvm emitter bug: chainRecv "${e.id}" outside its chain`);
        const v = B.tmp();
        B.line(`${v} = load ${this.llType(bound.type)}, ptr ${bound.name}`);
        if (!isRefCounted(e.type)) return { name: v, type: e.type };
        return this.own({ name: this.retainValue(v, e.type), type: e.type });
      }
      case "closure": {
        const target = this.fnByName.get(e.fnName);
        if (!target) throw new Error(`llvm emitter bug: closure over unknown function ${e.fnName}`);
        if (target.captures === undefined) {
          // Declared function as a value: the interned immortal closure —
          // every mention yields the same pointer, so `f === f` is true.
          this.fnValues.add(e.fnName);
          return this.own({
            name: this.retainValue(`@${mangleFnClosure(e.fnName)}`, e.type),
            type: e.type,
          });
        }
        // Lifted async lambdas enter through their spawn wrapper (which
        // takes sc_env first, like every lifted function).
        this.declare(`declare ptr @scr_closure_new(ptr, ${this.sizeType})`);
        const c = B.tmp();
        B.line(`${c} = call ptr @scr_closure_new(ptr @${this.callTarget(e.fnName)}, ${this.sizeType} ${e.captures.length})`);
        const out = this.own({ name: c, type: e.type });
        e.captures.forEach((localId, i) => {
          const box = this.loadBox(`%${mangleLocal(localId)}`);
          const retained = this.retainBox(box);
          const caps = B.tmp();
          const capp = B.tmp();
          B.line(`${caps} = getelementptr inbounds %ScrClosure, ptr ${c}, i64 1 ; caps`);
          B.line(`${capp} = getelementptr inbounds ptr, ptr ${caps}, ${this.sizeType} ${i} ; caps[${i}]`);
          B.line(`store ptr ${retained}, ptr ${capp}`);
        });
        return out;
      }
      case "callValue": {
        // Calling through a closure value: load the fn pointer, pass the
        // closure itself first (the callValue ABI), then the declared
        // params — callees own their refcounted params.
        if (e.callee.type.kind !== "func") throw new Error("llvm emitter bug: callValue on non-func");
        const ft = e.callee.type;
        if (e.args.length !== ft.params.length) throw new LlvmUnsupportedError("callValue:arity", e.loc);
        const callee = this.emitExpr(e.callee);
        const args = e.args.map((a) => this.emitExpr(a));
        for (const a of args) this.moveTemp(a);
        const fnp = B.tmp();
        const fn = B.tmp();
        B.line(`${fnp} = getelementptr inbounds %ScrClosure, ptr ${callee.name}, i64 0, i32 1`);
        B.line(`${fn} = load ptr, ptr ${fnp}`);
        const argList = [
          `ptr ${callee.name}`,
          ...args.map((a, i) => `${this.llType(ft.params[i]!)} ${a.name}`),
        ].join(", ");
        if (e.type.kind === "void") {
          B.line(`call void ${fn}(${argList})`);
          if (this.indirectMayThrow) this.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const t = B.tmp();
        B.line(`${t} = call ${this.llType(e.type)} ${fn}(${argList})`);
        // The check runs AFTER the result temp joins the frame: an unwind
        // releases it (the dummy is NULL for refcounted returns).
        const out = this.own({ name: t, type: e.type });
        if (this.indirectMayThrow) this.emitPendingCheck();
        return out;
      }
      case "selfRef":
        // The running closure itself (env is borrowed; the result owned).
        return this.own({ name: this.retainValue("%sc_env", e.type), type: e.type });
      case "call": {
        const callee = this.fnByName.get(e.callee);
        if (!callee) throw new Error(`llvm emitter bug: unknown callee ${e.callee}`);
        if (callee.captures !== undefined) throw new Error(`llvm emitter bug: direct call to lifted function ${e.callee}`);
        const args = e.args.map((a) => this.emitExpr(a));
        for (const a of args) this.moveTemp(a); // callees own their params
        const argList = args
          .map((a, i) => `${this.llType(callee.params[i]!.type)} ${a.name}`)
          .join(", ");
        // Async callee: the spawn wrapper runs the body eagerly to its
        // first suspension and returns the promise (+1). The call itself
        // never unwinds — rejections surface at await (computeMayThrow's
        // async exclusion).
        const target = `@${this.callTarget(e.callee)}`;
        if (e.type.kind === "void") {
          B.line(`call void ${target}(${argList})`);
          if (this.mayThrow.has(e.callee)) this.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const t = B.tmp();
        B.line(`${t} = call ${this.llType(e.type)} ${target}(${argList})`);
        const out = this.own({ name: t, type: e.type });
        if (this.mayThrow.has(e.callee)) this.emitPendingCheck();
        return out;
      }
      case "ffiCall": {
        // LIBRARY mode: every ffiCall is a profile-declared host-callback
        // channel (the library lane loads no native-FFI manifest). Fetch
        // the slot's registered pointer — scr_library_cb_require delivers
        // the channel's trap constant through the funnel (SC4025) when the
        // host never registered — then the typed indirect call, opaque
        // context first. Marshalling matches the native ffiCall's value
        // classes exactly; the host cannot raise a scriptc exception, so
        // no pending check follows.
        const libCb = this.mod.lib?.callbacks?.find((c) => c.name === e.import);
        if (libCb !== undefined) {
          const cbArgs = e.args.map((arg) => this.emitExpr(arg));
          const natTypes: string[] = ["ptr"];
          const natArgs: string[] = [];
          libCb.params.forEach((cls, i) => {
            const arg = cbArgs[i]!;
            switch (cls) {
              case "f64":
                natTypes.push("double");
                natArgs.push(`double ${arg.name}`);
                break;
              case "bool": {
                const widened = B.tmp();
                B.line(`${widened} = zext i1 ${arg.name} to i8`);
                natTypes.push("i8");
                natArgs.push(`i8 ${widened}`);
                break;
              }
              case "u8":
              case "u32": {
                this.declare(`declare double @scr_bit_ushr(double, double)`);
                const asDouble = B.tmp();
                const asU32 = B.tmp();
                B.line(`${asDouble} = call double @scr_bit_ushr(double ${arg.name}, double ${f64Lit(0)})`);
                B.line(`${asU32} = fptoui double ${asDouble} to i32`);
                if (cls === "u8") {
                  const asU8 = B.tmp();
                  B.line(`${asU8} = trunc i32 ${asU32} to i8`);
                  natTypes.push("i8");
                  natArgs.push(`i8 ${asU8}`);
                } else {
                  natTypes.push("i32");
                  natArgs.push(`i32 ${asU32}`);
                }
                break;
              }
              case "i32": {
                this.declare(`declare double @scr_bit_or(double, double)`);
                const asDouble = B.tmp();
                const asI32 = B.tmp();
                B.line(`${asDouble} = call double @scr_bit_or(double ${arg.name}, double ${f64Lit(0)})`);
                B.line(`${asI32} = fptosi double ${asDouble} to i32`);
                natTypes.push("i32");
                natArgs.push(`i32 ${asI32}`);
                break;
              }
              case "string": {
                const lenPtr = B.tmp();
                const len = B.tmp();
                const data = B.tmp();
                B.line(`${lenPtr} = getelementptr inbounds %ScrStr, ptr ${arg.name}, i64 0, i32 1`);
                B.line(`${len} = load i64, ptr ${lenPtr}`);
                B.line(`${data} = getelementptr inbounds i8, ptr ${arg.name}, i64 24`);
                natTypes.push("ptr", "i64");
                natArgs.push(`ptr ${data}`, `i64 ${len}`);
                break;
              }
              case "bytes": {
                const lenPtr = B.tmp();
                const len = B.tmp();
                const dataPtr = B.tmp();
                const data = B.tmp();
                B.line(`${lenPtr} = getelementptr inbounds i8, ptr ${arg.name}, i64 8`);
                B.line(`${len} = load i64, ptr ${lenPtr}`);
                B.line(`${dataPtr} = getelementptr inbounds i8, ptr ${arg.name}, i64 24`);
                B.line(`${data} = load ptr, ptr ${dataPtr}`);
                natTypes.push("ptr", "i64");
                natArgs.push(`ptr ${data}`, `i64 ${len}`);
                break;
              }
            }
          });
          this.declare(`declare ptr @scr_library_cb_require(${this.sizeType}, ptr)`);
          this.declare(`declare ptr @scr_library_cb_ctx(${this.sizeType})`);
          const fn = B.tmp();
          B.line(`${fn} = call ptr @scr_library_cb_require(${this.sizeType} ${libCb.slot}, ptr @sc_lib_cb_trap_${libCb.slot})`);
          const ctx = B.tmp();
          B.line(`${ctx} = call ptr @scr_library_cb_ctx(${this.sizeType} ${libCb.slot})`);
          const retTy = ffiNativeTypeLl(libCb.returns);
          const call = `call ${retTy} ${fn}(${[`ptr ${ctx}`, ...natArgs].join(", ")})`;
          if (libCb.returns === "void") {
            B.line(call);
            return { name: "", type: e.type };
          }
          const raw = B.tmp();
          B.line(`${raw} = ${call}`);
          if (libCb.returns === "f64") return { name: raw, type: e.type };
          if (libCb.returns === "bool") {
            const value = B.tmp();
            B.line(`${value} = icmp ne i8 ${raw}, 0`);
            return { name: value, type: e.type };
          }
          const value = B.tmp();
          const op = libCb.returns === "i32" ? "sitofp" : "uitofp";
          B.line(`${value} = ${op} ${retTy} ${raw} to double`);
          return { name: value, type: e.type };
        }
        const entry = this.ffiByName.get(e.import);
        if (!entry) throw new Error(`llvm emitter bug: unknown FFI import ${e.import}`);
        const args = e.args.map((arg) => this.emitExpr(arg));
        const sourceArgs = new Map<number, LlValue>();
        const callbackArgs = new Map<string, LlValue>();
        let sourceIndex = 0;
        entry.params.forEach((param, abiIndex) => {
          if (isFfiContextParam(param)) return;
          const arg = args[sourceIndex++]!;
          sourceArgs.set(abiIndex, arg);
          if (isFfiCallbackParam(param)) callbackArgs.set(param.callback.id, arg);
          if (isFfiReleaseParam(param)) callbackArgs.set(param.callback.release, arg);
        });

        const retainedRegistrations: { table: string; callback: LlValue; global: string | null }[] = [];
        const retainedReleases: { table: string; callback: LlValue; global: string | null }[] = [];
        for (const param of entry.params) {
          if (isFfiCallbackParam(param) && param.callback.lifetime === "retained") {
            const adapter = this.ffiCallbackAdapter(entry.name, param.callback.id);
            const callback = callbackArgs.get(param.callback.id)!;
            if (adapter.table === null) throw new Error("llvm emitter bug: retained callback has no table");
            retainedRegistrations.push({ table: adapter.table, callback, global: adapter.global });
          } else if (isFfiReleaseParam(param)) {
            const split = param.callback.release.lastIndexOf(":");
            const adapter = this.ffiCallbackAdapter(
              param.callback.release.slice(0, split),
              param.callback.release.slice(split + 1),
            );
            const callback = callbackArgs.get(param.callback.release)!;
            if (adapter.table === null) throw new Error("llvm emitter bug: retained release has no table");
            retainedReleases.push({ table: adapter.table, callback, global: adapter.global });
          }
        }
        if (retainedRegistrations.length > 0) {
          this.declare(`declare void @scr_ffi_retain(ptr, ptr)`);
          this.declare(`declare void @scr_ffi_teardown(ptr)`);
        }
        for (const registration of retainedRegistrations) {
          if (registration.global !== null) {
            B.line(`call void @scr_ffi_teardown(ptr @${registration.table})`);
            B.line(`store ptr ${registration.callback.name}, ptr @${registration.global}`);
          }
          B.line(`call void @scr_ffi_retain(ptr @${registration.table}, ptr ${registration.callback.name})`);
        }

        const rawContexts: { tls: string; previous: string }[] = [];
        for (const param of entry.params) {
          if (!isFfiCallbackParam(param)) continue;
          const adapter = this.ffiCallbackAdapter(entry.name, param.callback.id);
          if (adapter.tls === null) continue;
          const callback = callbackArgs.get(param.callback.id)!;
          const previous = B.tmp();
          B.line(`${previous} = load ptr, ptr @${adapter.tls}`);
          B.line(`store ptr ${callback.name}, ptr @${adapter.tls}`);
          rawContexts.push({ tls: adapter.tls, previous });
        }
        const nativeArgs: string[] = [];
        const nativeParamTypes: string[] = [];
        entry.params.forEach((param, i) => {
          if (isFfiCallbackParam(param)) {
            const adapter = this.ffiCallbackAdapter(entry.name, param.callback.id);
            nativeParamTypes.push("ptr");
            nativeArgs.push(`ptr @${adapter.symbol}`);
            return;
          }
          if (isFfiReleaseParam(param)) {
            const split = param.callback.release.lastIndexOf(":");
            const adapter = this.ffiCallbackAdapter(
              param.callback.release.slice(0, split),
              param.callback.release.slice(split + 1),
            );
            nativeParamTypes.push("ptr");
            nativeArgs.push(`ptr @${adapter.symbol}`);
            return;
          }
          if (isFfiContextParam(param)) {
            const callback = callbackArgs.get(param.context);
            if (!callback) throw new Error(`llvm emitter bug: FFI context '${param.context}' has no callback arg`);
            nativeParamTypes.push("ptr");
            nativeArgs.push(`ptr ${callback.name}`);
            return;
          }
          const arg = sourceArgs.get(i)!;
          switch (param) {
            case "f64":
              nativeParamTypes.push("double");
              nativeArgs.push(`double ${arg.name}`);
              break;
            case "bool": {
              const widened = B.tmp();
              B.line(`${widened} = zext i1 ${arg.name} to i8`);
              nativeParamTypes.push("i8");
              nativeArgs.push(`i8 ${widened}`);
              break;
            }
            case "u8":
            case "u32": {
              this.declare(`declare double @scr_bit_ushr(double, double)`);
              const asDouble = B.tmp();
              const asU32 = B.tmp();
              B.line(`${asDouble} = call double @scr_bit_ushr(double ${arg.name}, double ${f64Lit(0)})`);
              B.line(`${asU32} = fptoui double ${asDouble} to i32`);
              if (param === "u8") {
                const asU8 = B.tmp();
                B.line(`${asU8} = trunc i32 ${asU32} to i8`);
                nativeParamTypes.push("i8");
                nativeArgs.push(`i8 ${asU8}`);
              } else {
                nativeParamTypes.push("i32");
                nativeArgs.push(`i32 ${asU32}`);
              }
              break;
            }
            case "i32": {
              this.declare(`declare double @scr_bit_or(double, double)`);
              const asDouble = B.tmp();
              const asI32 = B.tmp();
              B.line(`${asDouble} = call double @scr_bit_or(double ${arg.name}, double ${f64Lit(0)})`);
              B.line(`${asI32} = fptosi double ${asDouble} to i32`);
              nativeParamTypes.push("i32");
              nativeArgs.push(`i32 ${asI32}`);
              break;
            }
            case "string": {
              const lenPtr = B.tmp();
              const len = B.tmp();
              const data = B.tmp();
              B.line(`${lenPtr} = getelementptr inbounds %ScrStr, ptr ${arg.name}, i64 0, i32 1`);
              B.line(`${len} = load i64, ptr ${lenPtr}`);
              B.line(`${data} = getelementptr inbounds i8, ptr ${arg.name}, i64 24`);
              nativeParamTypes.push("ptr", "i64");
              nativeArgs.push(`ptr ${data}`, `i64 ${len}`);
              break;
            }
            case "bytes": {
              const lenPtr = B.tmp();
              const len = B.tmp();
              const dataPtr = B.tmp();
              const data = B.tmp();
              B.line(`${lenPtr} = getelementptr inbounds i8, ptr ${arg.name}, i64 8`);
              B.line(`${len} = load i64, ptr ${lenPtr}`);
              B.line(`${dataPtr} = getelementptr inbounds i8, ptr ${arg.name}, i64 24`);
              B.line(`${data} = load ptr, ptr ${dataPtr}`);
              nativeParamTypes.push("ptr", "i64");
              nativeArgs.push(`ptr ${data}`, `i64 ${len}`);
              break;
            }
          }
        });
        const retTy = ffiNativeTypeLl(entry.returns);
        this.declare(
          `declare ${retTy} @${entry.symbol}(${nativeParamTypes.join(", ")})`,
        );
        const call = `call ${retTy} @${entry.symbol}(${nativeArgs.join(", ")})`;
        const restoreRawContexts = (): void => {
          for (let i = rawContexts.length - 1; i >= 0; i--) {
            const saved = rawContexts[i]!;
            B.line(`store ptr ${saved.previous}, ptr @${saved.tls}`);
          }
        };
        const finishRetainedReleases = (): void => {
          if (retainedReleases.length > 0) this.declare(`declare void @scr_ffi_release(ptr, ptr)`);
          for (const release of retainedReleases) {
            B.line(`call void @scr_ffi_release(ptr @${release.table}, ptr ${release.callback.name})`);
            if (release.global !== null) B.line(`store ptr null, ptr @${release.global}`);
          }
        };
        const callbacksMayThrow = callbackArgs.size > 0 || (this.mod.ffiImports ?? []).some(
          (candidate) => candidate.params.some(
            (param) => isFfiCallbackParam(param) && param.callback.lifetime === "retained",
          ),
        );
        if (entry.returns === "void") {
          B.line(call);
          restoreRawContexts();
          finishRetainedReleases();
          if (callbacksMayThrow) this.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const raw = B.tmp();
        B.line(`${raw} = ${call}`);
        restoreRawContexts();
        finishRetainedReleases();
        if (entry.returns === "f64") {
          const result = { name: raw, type: e.type };
          if (callbacksMayThrow) this.emitPendingCheck();
          return result;
        }
        if (entry.returns === "bool") {
          const value = B.tmp();
          B.line(`${value} = icmp ne i8 ${raw}, 0`);
          const result = { name: value, type: e.type };
          if (callbacksMayThrow) this.emitPendingCheck();
          return result;
        }
        const value = B.tmp();
        const op = entry.returns === "i32" ? "sitofp" : "uitofp";
        B.line(`${value} = ${op} ${retTy} ${raw} to double`);
        const result = { name: value, type: e.type };
        if (callbacksMayThrow) this.emitPendingCheck();
        return result;
      }
      case "new": {
        // Allocate (fields zeroed, vt stamped), then run the ctor. The
        // ctor owns and releases its `this` param like any callee, so it
        // receives a +1 distinct from the one this expression returns.
        // A throwing constructor unwinds like any call; the half-built
        // object is in this frame and releases with it.
        const ctor = this.fnByName.get(`%${e.className}.constructor`);
        if (!ctor) throw new Error(`llvm emitter bug: new ${e.className} without a constructor`);
        const o = B.tmp();
        B.line(`${o} = call ptr @${mangleClassNew(e.className)}()`);
        const out = this.own({ name: o, type: e.type });
        const args = e.args.map((a) => this.emitExpr(a));
        for (const a of args) this.moveTemp(a);
        const r = B.tmp();
        B.line(`${r} = call ptr @${mangleClassRetain(e.className)}(ptr ${o})`);
        const argList = [
          `ptr ${r}`,
          ...args.map((a, i) => `${this.llType(ctor.params[i + 1]!.type)} ${a.name}`),
        ].join(", ");
        B.line(`call void @${mangleFunction(`%${e.className}.constructor`)}(${argList})`);
        if (this.mayThrow.has(`%${e.className}.constructor`)) this.emitPendingCheck();
        return out;
      }
      case "fieldGet": {
        const obj = this.emitExpr(e.obj);
        const { ptr, type } = this.classFieldPtr(obj.name, e.className, e.field);
        const v = this.loadField(ptr, type);
        if (isRefCounted(e.type)) return this.own({ name: this.retainValue(v, e.type), type: e.type });
        return { name: v, type: e.type };
      }
      case "fieldIncDec": {
        // ++/-- over a class FIELD in expression position: one receiver
        // evaluation, read-modify-write, old/new snapshotted — the local
        // form over a field slot. CHECKED-DYNAMIC fields validate the
        // number OUT (dynCheck — the catchable TypeError on non-numbers),
        // compute, and box the result back into the slot; unlink-then-
        // release like fieldSet (emit-exprs.ts's shape).
        const obj = this.emitExpr(e.obj);
        const { ptr } = this.classFieldPtr(obj.name, e.className, e.field);
        if (e.fieldDyn) {
          const box = B.tmp();
          B.line(`${box} = load ptr, ptr ${ptr}`);
          const helper = this.dyn.dynCheckHelper(e.type);
          const old = B.tmp();
          B.line(`${old} = call double @${helper}(ptr ${box}, ptr null)`);
          this.emitPendingCheck();
          const next = B.tmp();
          B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
          this.declare(`declare ptr @scr_dyn_new_num(double)`);
          this.declare(`declare void @scr_dyn_release(ptr)`);
          const boxed = B.tmp();
          B.line(`${boxed} = call ptr @scr_dyn_new_num(double ${next})`);
          B.line(`store ptr ${boxed}, ptr ${ptr}`);
          B.line(`call void @scr_dyn_release(ptr ${box})`);
          return { name: e.prefix ? next : old, type: e.type };
        }
        const old = B.tmp();
        const next = B.tmp();
        B.line(`${old} = load double, ptr ${ptr}`);
        B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
        B.line(`store double ${next}, ptr ${ptr}`);
        return { name: e.prefix ? next : old, type: e.type };
      }
      case "virtualCall": {
        // Dispatch through the receiver's vtable: the slot lives on the
        // method's root-most declaring class; every implementation shares
        // the slot's LLVM signature (override exactness), so the stored
        // pointer is the method function itself — no adapters (see
        // classes.ts).
        const meta = this.classMetaOf(e.className);
        const slotIdx = meta.root.slots.findIndex(
          (sl) => sl.method === e.method && sl.declarer.pre <= meta.pre && meta.pre <= sl.declarer.post,
        );
        if (slotIdx < 0) throw new Error(`llvm emitter bug: no vtable slot for ${e.className}.${e.method}`);
        const slot = meta.root.slots[slotIdx]!;
        const args = e.args.map((a) => this.emitExpr(a));
        for (const a of args) this.moveTemp(a); // callees own their params
        const recv = args[0]!.name;
        const vtp = B.tmp();
        const vt = B.tmp();
        const fnp = B.tmp();
        const fn = B.tmp();
        B.line(`${vtp} = getelementptr inbounds %${classStructSym(e.className)}, ptr ${recv}, i64 0, i32 1`);
        B.line(`${vt} = load ptr, ptr ${vtp}`);
        B.line(`${fnp} = getelementptr inbounds %${mangleVtStruct(meta.root.def.name)}, ptr ${vt}, i64 0, i32 ${slotIdx + 1}`);
        B.line(`${fn} = load ptr, ptr ${fnp} ; ${e.method}`);
        const argList = args
          .map((a, i) => `${this.llType(slot.fn.params[i]!.type)} ${a.name}`)
          .join(", ");
        if (e.type.kind === "void") {
          B.line(`call void ${fn}(${argList})`);
          if (this.mayThrowMethods.has(e.method)) this.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const t = B.tmp();
        B.line(`${t} = call ${this.llType(e.type)} ${fn}(${argList})`);
        const out = this.own({ name: t, type: e.type });
        if (this.mayThrowMethods.has(e.method)) this.emitPendingCheck();
        return out;
      }
      case "instanceOf": {
        // O(1) preorder-interval test against the vtable the object
        // carries; the target's interval is a compile-time constant.
        if (e.value.type.kind !== "object") throw new Error("llvm emitter bug: instanceOf on a non-object");
        const v = this.emitExpr(e.value);
        const target = this.classMetaOf(e.className);
        const pre = this.loadVtPre(v.name, e.value.type.className);
        const ge = B.tmp();
        const le = B.tmp();
        const t = B.tmp();
        B.line(`${ge} = icmp sge ${this.sizeType} ${pre}, ${target.pre}`);
        B.line(`${le} = icmp sle ${this.sizeType} ${pre}, ${target.post}`);
        B.line(`${t} = and i1 ${ge}, ${le} ; instanceof ${e.className}`);
        return { name: t, type: e.type };
      }
      case "instanceOfValue": {
        // The interval check with the target loaded from the class object
        // (same numbering the vtables carry). Frontend guarantees both
        // sides are hierarchy members, so the operand has a vt word.
        if (e.value.type.kind !== "object") throw new Error("llvm emitter bug: instanceOfValue on a non-object");
        const v = this.emitExpr(e.value);
        const target = this.emitExpr(e.classValue);
        const pre = this.loadVtPre(v.name, e.value.type.className);
        const tprep = B.tmp();
        const tpre = B.tmp();
        const tpostp = B.tmp();
        const tpost = B.tmp();
        B.line(`${tprep} = getelementptr inbounds %ScrClassObj, ptr ${target.name}, i64 0, i32 1`);
        B.line(`${tpre} = load ${this.sizeType}, ptr ${tprep}`);
        B.line(`${tpostp} = getelementptr inbounds %ScrClassObj, ptr ${target.name}, i64 0, i32 2`);
        B.line(`${tpost} = load ${this.sizeType}, ptr ${tpostp}`);
        const ge = B.tmp();
        const le = B.tmp();
        const t = B.tmp();
        B.line(`${ge} = icmp sge ${this.sizeType} ${pre}, ${tpre}`);
        B.line(`${le} = icmp sle ${this.sizeType} ${pre}, ${tpost}`);
        B.line(`${t} = and i1 ${ge}, ${le}`);
        return { name: t, type: e.type };
      }
      case "caughtTest": {
        // Kind-tag tests read the snapshot directly; instanceof compares
        // an OBJ payload's vtable preorder against the class's compile-
        // time interval (false for every other payload kind). Box
        // borrowed. SCR_EXC_STR = 3, SCR_EXC_F64 = 1, SCR_EXC_BOOL = 2.
        const c = this.emitExpr(e.value);
        if (e.test === "instanceof") {
          const target = this.classMetaOf(e.className!);
          this.declare(`declare zeroext i1 @scr_caught_instanceof(ptr, ${this.sizeType}, ${this.sizeType})`);
          const t = B.tmp();
          B.line(`${t} = call zeroext i1 @scr_caught_instanceof(ptr ${c.name}, ${this.sizeType} ${target.pre}, ${this.sizeType} ${target.post})`);
          if (e.negated !== true) return { name: t, type: e.type };
          const n = B.tmp();
          B.line(`${n} = xor i1 ${t}, true`);
          return { name: n, type: e.type };
        }
        const tag = { string: 3, number: 1, boolean: 2 }[e.test];
        const kp = B.tmp();
        const k = B.tmp();
        const t = B.tmp();
        B.line(`${kp} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 1`);
        B.line(`${k} = load i32, ptr ${kp}`);
        B.line(`${t} = icmp ${e.negated === true ? "ne" : "eq"} i32 ${k}, ${tag} ; typeof e === "${e.test}"`);
        return { name: t, type: e.type };
      }
      case "caughtNarrow": {
        // Checker-trusted extraction (the matching caughtTest was proven
        // by tsc's narrowing): scalars read the snapshot's slots,
        // refcounted payloads come out retained (+1). Box borrowed.
        const c = this.emitExpr(e.value);
        if (e.type.kind === "f64") {
          const p = B.tmp();
          const v = B.tmp();
          B.line(`${p} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 2`);
          B.line(`${v} = load double, ptr ${p}`);
          return { name: v, type: e.type };
        }
        if (e.type.kind === "bool") {
          const p = B.tmp();
          const raw = B.tmp();
          const v = B.tmp();
          B.line(`${p} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 3`);
          B.line(`${raw} = load i8, ptr ${p}`);
          B.line(`${v} = trunc i8 ${raw} to i1`);
          return { name: v, type: e.type };
        }
        const pp = B.tmp();
        const payload = B.tmp();
        B.line(`${pp} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 4`);
        B.line(`${payload} = load ptr, ptr ${pp}`);
        if (e.type.kind === "string") {
          return this.own({ name: this.retainValue(payload, e.type), type: e.type });
        }
        if (e.type.kind === "object") {
          // Retain through the snapshot's own entry point (the payload's
          // dynamic class is opaque here — exactly the C's retain_fn call).
          const rp = B.tmp();
          const rf = B.tmp();
          const v = B.tmp();
          B.line(`${rp} = getelementptr inbounds %ScrCaught, ptr ${c.name}, i64 0, i32 5`);
          B.line(`${rf} = load ptr, ptr ${rp}`);
          B.line(`${v} = call ptr ${rf}(ptr ${payload})`);
          return this.own({ name: v, type: e.type });
        }
        throw new LlvmUnsupportedError(`caughtNarrow:${e.type.kind}`, e.loc);
      }
      case "caughtCheck": {
        // Checked payload extraction (`e as C`): instanceof match extracts
        // +1, anything else throws the catchable TypeError — the result
        // joins the frame BEFORE the pending check so an unwind releases
        // the NULL dummy harmlessly. Box borrowed.
        const c = this.emitExpr(e.value);
        const target = this.classMetaOf(e.className);
        const display = e.className.startsWith("%") ? e.className.slice(1) : e.className;
        this.declare(`declare ptr @scr_caught_check_obj(ptr, ${this.sizeType}, ${this.sizeType}, ptr)`);
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_caught_check_obj(ptr ${c.name}, ${this.sizeType} ${target.pre}, ${this.sizeType} ${target.post}, ptr ${this.cstr(display)})`,
        );
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "upcast":
      case "downcast": {
        // Prefix layout: both directions are reinterprets of the SAME
        // pointer — no RC traffic, ownership transfers from the operand
        // temp to the result temp (struck so the one +1 releases exactly
        // once, under the RESULT type's release).
        const v = this.emitExpr(e.value);
        if (isRefCounted(v.type)) this.moveTemp(v);
        return this.own({ name: v.name, type: e.type });
      }
      case "classRef": {
        // The class itself as a value: the immortal class object's
        // address. The +1 retain is a no-op on immortals but keeps the
        // owned-temps discipline uniform (the regexLit pattern).
        const sym = this.classObjSym(e.className);
        return this.own({ name: this.retainValue(`@${sym}`, e.type), type: e.type });
      }
      case "newValue": {
        // Construction through a class VALUE: call the class object's
        // construct thunk. Every value legally in the slot shares the
        // static class's constructor ABI (the frontend's flow rule).
        if (e.callee.type.kind !== "classval") throw new Error("llvm emitter bug: newValue on non-classval callee");
        const cls = e.callee.type.className;
        const ctor = this.fnByName.get(`%${cls}.constructor`);
        if (!ctor) throw new Error(`llvm emitter bug: newValue on ${cls} without a constructor`);
        const callee = this.emitExpr(e.callee);
        const args = e.args.map((a) => this.emitExpr(a));
        for (const a of args) this.moveTemp(a); // the constructor owns its params
        const ctorp = B.tmp();
        const thunk = B.tmp();
        B.line(`${ctorp} = getelementptr inbounds %ScrClassObj, ptr ${callee.name}, i64 0, i32 3`);
        B.line(`${thunk} = load ptr, ptr ${ctorp}`);
        const argList = args
          .map((a, i) => `${this.llType(ctor.params[i + 1]!.type)} ${a.name}`)
          .join(", ");
        const t = B.tmp();
        B.line(`${t} = call ptr ${thunk}(${argList})`);
        const out = this.own({ name: t, type: e.type });
        if (this.newValueMayThrow(cls)) this.emitPendingCheck();
        return out;
      }
      case "seqExpr": {
        // Statements mid-expression: each emits in place (its own frame,
        // exactly statement position); the result is an ordinary temp of
        // the current frame. The validator restricted stmts to straight-
        // line writes — no jump can leave the region.
        for (const s of e.stmts) this.emitStmt(s);
        return this.emitExpr(e.result);
      }
      case "jsonStringify": {
        // Type-directed serialization: the STATIC type picks an emitted
        // serializer (interned per typeKey) — no dyn, no runtime dispatch.
        // The value temp is BORROWED (released with this statement's
        // frame); the result string is owned (+1). Never throws — except
        // the dyn root below.
        const v = this.emitExpr(e.value);
        let compact: { name: string; type: IrType };
        if (e.value.type.kind === "dyn") {
          // A dyn root: the runtime's dyn walker (scr_dyn_format_j — the
          // C backend's dispatch exactly): number/string/bool/null/array/
          // object exact, dropped members omitted, and a dropped ROOT
          // becomes the TEXT "undefined" (JSON.stringify(undefined) is
          // the undefined value; printing it spells the word — Node's
          // answer, where the nested-position writer would spell null).
          // Fallible (a runtime handle inside the tree throws) — the
          // pending check runs.
          this.declare(`declare ptr @scr_dyn_format_j(ptr)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_dyn_format_j(ptr ${v.name})`);
          compact = this.own({ name: t, type: e.type });
          this.emitPendingCheck();
        } else {
          const helper = this.walkers.jsonWriteHelper(e.value.type);
          this.declare(`declare void @scr_jb_init(ptr)`);
          this.declare(`declare ptr @scr_jb_finish(ptr)`);
          const buf = B.slot();
          B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`);
          B.line(`call void @scr_jb_init(ptr ${buf})`);
          B.line(`call void @${helper}(ptr ${buf}, ${this.llType(e.value.type)} ${v.name})`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jb_finish(ptr ${buf})`);
          compact = this.own({ name: t, type: e.type });
          // A cycle-capable root can throw the circular-structure
          // TypeError mid-walk: finish still runs (frees the buffer, the
          // partial string joins the frame and releases on unwind), then
          // the pending check unwinds — the C emitter's contract exactly.
          if (traceAdapter(this, e.value.type) !== null) this.emitPendingCheck();
        }
        // A pretty-print form (`stringify(v, null, 2)`): the frontend
        // resolved the space to a compile-time indent string (Node's
        // clamp/truncate rules); the interned re-indenter rewrites the
        // compact text with Node's gap algorithm. Compact temp stays
        // frame-owned; the pretty string is a fresh +1.
        const indent = (e as { indent?: string }).indent;
        if (indent === undefined || indent === "") return compact;
        const rewriter = this.walkers.jsonIndentHelper();
        const t2 = B.tmp();
        B.line(
          `${t2} = call ptr @${rewriter}(ptr ${compact.name}, ptr ${this.cstr(indent)}, ${this.sizeType} ${Buffer.byteLength(indent, "utf8")})`,
        );
        return this.own({ name: t2, type: e.type });
      }
      case "bytesNew": {
        // Typed-array/Buffer construction; the SOURCE's static type picks
        // the runtime entry. The source is borrowed; every form hands
        // back +1. Only the f64 (length) form can throw (Node's "Invalid
        // typed array length" RangeError) — pending check after the temp
        // joins its frame.
        if (e.type.kind !== "bytes") throw new Error("llvm emitter bug: bytesNew of non-bytes type");
        const kind = BYTES_ELEM_NUM[e.type.elem];
        if (!e.source) {
          this.declare(`declare ptr @scr_bytes_new(i32, double)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_bytes_new(i32 ${kind}, double ${f64Lit(0)})`);
          return this.own({ name: t, type: e.type });
        }
        const src = this.emitExpr(e.source);
        const t = B.tmp();
        if (e.source.type.kind === "f64") {
          this.declare(`declare ptr @scr_bytes_new(i32, double)`);
          B.line(`${t} = call ptr @scr_bytes_new(i32 ${kind}, double ${src.name})`);
          const out = this.own({ name: t, type: e.type });
          this.emitPendingCheck();
          return out;
        }
        if (e.source.type.kind === "bytes") {
          this.declare(`declare ptr @scr_bytes_copy(ptr)`);
          B.line(`${t} = call ptr @scr_bytes_copy(ptr ${src.name})`);
          return this.own({ name: t, type: e.type });
        }
        if (e.source.type.kind === "array") {
          this.declare(`declare ptr @scr_bytes_from_arr(i32, ptr)`);
          B.line(`${t} = call ptr @scr_bytes_from_arr(i32 ${kind}, ptr ${src.name})`);
          return this.own({ name: t, type: e.type });
        }
        throw new Error(`llvm emitter bug: bytesNew source of kind ${e.source.type.kind}`);
      }
      case "bytesIntrinsic":
        return this.emitBytesIntrinsic(e);
      case "yieldExpr": {
        // Park the operand in the generator's OUT slot (moved in, typed by
        // the function's yield channel) and switch back to the resumer.
        // Control returns at the next resume — possibly with an injected
        // .throw payload or the GENRET sentinel pending, hence the check.
        // The result is the .next(v) argument, moved out of the IN slot.
        const gen = this.currentGenerator;
        if (!gen) throw new Error("llvm emitter bug: yieldExpr outside a generator body");
        if (e.value === null) throw new Error("llvm emitter bug: yieldExpr with no operand (frontend fills undefined)");
        const v = this.emitExpr(e.value);
        const yt = e.value.type;
        if (yt.kind === "f64" || yt.kind === "date") {
          if (this.wasi) {
            const coro = this.currentWasiCoro!;
            this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            this.declare(`declare void @scr_gen_out_f64(ptr, double)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_f64(ptr ${g}, double ${v.name})`);
          } else {
            this.declare(`declare void @scr_gen_yield_f64(double)`);
            B.line(`call void @scr_gen_yield_f64(double ${v.name})`);
          }
        } else if (yt.kind === "bool") {
          if (this.wasi) {
            const coro = this.currentWasiCoro!;
            this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            this.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_bool(ptr ${g}, i1 ${v.name})`);
          } else {
            this.declare(`declare void @scr_gen_yield_bool(i1 zeroext)`);
            B.line(`call void @scr_gen_yield_bool(i1 ${v.name})`);
          }
        } else {
          this.moveTemp(v); // the OUT slot takes ownership
          if (this.wasi) {
            const coro = this.currentWasiCoro!;
            this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
            this.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
            const g = B.tmp();
            B.line(`${g} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
            B.line(`call void @scr_gen_out_ref(ptr ${g}, ptr ${v.name}, ptr ${vAdapters(this, yt).release})`);
          } else {
            this.declare(`declare void @scr_gen_yield_ref(ptr, ptr)`);
            B.line(`call void @scr_gen_yield_ref(ptr ${v.name}, ptr ${vAdapters(this, yt).release})`);
          }
        }
        if (this.wasi) this.emitWasiSuspendPrepared();
        this.emitPendingCheck();
        if (e.type.kind === "void") {
          // An undefined next-channel: nothing to read (the frontend
          // fences value-position yields on this channel).
          return { name: "", type: e.type };
        }
        const t = B.tmp();
        if (e.type.kind === "f64" || e.type.kind === "date") {
          this.declare(`declare double @scr_gen_take_in_f64()`);
          B.line(`${t} = call double @scr_gen_take_in_f64()`);
          return { name: t, type: e.type };
        }
        if (e.type.kind === "bool") {
          this.declare(`declare zeroext i1 @scr_gen_take_in_bool()`);
          B.line(`${t} = call zeroext i1 @scr_gen_take_in_bool()`);
          return { name: t, type: e.type };
        }
        // Refcounted channels: the slot's +1 moves out.
        this.declare(`declare ptr @scr_gen_take_in_ref()`);
        B.line(`${t} = call ptr @scr_gen_take_in_ref()`);
        return this.own({ name: t, type: e.type });
      }
      case "genResume": {
        // One consumer resume: park the sent value (typed per mode), hop
        // into the fiber, propagate a body exception (pending check), and
        // build the IteratorResult record through the interned helper.
        const genT = e.gen.type;
        if (genT.kind !== "generator") throw new Error("llvm emitter bug: genResume on a non-generator");
        if (e.type.kind !== "record") throw new Error("llvm emitter bug: genResume result is not a record");
        const g = this.emitExpr(e.gen); // borrowed for the calls below
        const sendArg = (store: (aName: string, t: IrType) => void): void => {
          const a = this.emitExpr(e.arg!);
          if (isRefCounted(e.arg!.type)) this.moveTemp(a); // the slot takes ownership
          store(a.name, e.arg!.type);
        };
        const parkIn = (name: string, t: IrType): void => {
          if (t.kind === "f64" || t.kind === "date") {
            this.declare(`declare void @scr_gen_in_f64(ptr, double)`);
            B.line(`call void @scr_gen_in_f64(ptr ${g.name}, double ${name})`);
          } else if (t.kind === "bool") {
            this.declare(`declare void @scr_gen_in_bool(ptr, i1 zeroext)`);
            B.line(`call void @scr_gen_in_bool(ptr ${g.name}, i1 ${name})`);
          } else {
            this.declare(`declare void @scr_gen_in_ref(ptr, ptr, ptr)`);
            B.line(`call void @scr_gen_in_ref(ptr ${g.name}, ptr ${name}, ptr ${vAdapters(this, t).release})`);
          }
        };
        if (e.mode === "next") {
          if (e.arg === null) {
            if (genT.nextT.kind === "dyn") {
              // Valueless resume on a dyn channel: JS's undefined — the
              // dyn singleton rides the IN slot (+1 moves in).
              this.declare(`declare ptr @scr_dyn_undefined()`);
              this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
              this.declare(`declare void @scr_dyn_release_v(ptr)`);
              this.declare(`declare void @scr_gen_in_ref(ptr, ptr, ptr)`);
              const u = B.tmp();
              const r = B.tmp();
              B.line(`${u} = call ptr @scr_dyn_undefined()`);
              B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${u})`);
              B.line(`call void @scr_gen_in_ref(ptr ${g.name}, ptr ${r}, ptr @scr_dyn_release_v)`);
            } else {
              this.declare(`declare void @scr_gen_in_none(ptr)`);
              B.line(`call void @scr_gen_in_none(ptr ${g.name})`);
            }
          } else {
            sendArg(parkIn);
          }
          this.declare(`declare void @scr_gen_resume(ptr)`);
          B.line(`call void @scr_gen_resume(ptr ${g.name})`);
        } else if (e.mode === "return") {
          if (e.arg === null) {
            this.declare(`declare void @scr_gen_ret_none(ptr)`);
            B.line(`call void @scr_gen_ret_none(ptr ${g.name})`);
          } else {
            sendArg((name, t) => {
              if (t.kind === "f64" || t.kind === "date") {
                this.declare(`declare void @scr_gen_ret_f64(ptr, double)`);
                B.line(`call void @scr_gen_ret_f64(ptr ${g.name}, double ${name})`);
              } else if (t.kind === "bool") {
                this.declare(`declare void @scr_gen_ret_bool(ptr, i1 zeroext)`);
                B.line(`call void @scr_gen_ret_bool(ptr ${g.name}, i1 ${name})`);
              } else {
                this.declare(`declare void @scr_gen_ret_ref(ptr, ptr, ptr)`);
                B.line(`call void @scr_gen_ret_ref(ptr ${g.name}, ptr ${name}, ptr ${vAdapters(this, t).release})`);
              }
            });
          }
          this.declare(`declare void @scr_gen_resume_return(ptr)`);
          B.line(`call void @scr_gen_resume_return(ptr ${g.name})`);
        } else {
          // .throw(e): park the payload in the CALLER's cell (the throw
          // statement's exact kind dispatch), then resume — the runtime
          // moves it into the fiber, or leaves it pending (non-suspended
          // generators: the .throw call itself throws at the check below).
          if (e.arg === null) throw new Error("llvm emitter bug: genResume throw with no payload");
          const a = this.emitExpr(e.arg);
          if (isRefCounted(e.arg.type)) this.moveTemp(a); // the cell takes ownership
          this.emitThrowValue({ name: a.name, type: e.arg.type });
          this.declare(`declare void @scr_gen_resume_throw(ptr)`);
          B.line(`call void @scr_gen_resume_throw(ptr ${g.name})`);
        }
        const helper = this.genResultThunkFor(genT, e.type);
        // The record builds before the check so an unwind (a propagated
        // body exception) releases it as the frame's never-read dummy.
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${g.name})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "awaitExpr": {
        // Parks the fiber until the promise settles; rejected promises
        // re-throw here (hence the pending check). Promise temp borrowed;
        // refcounted results arrive +1 and join the frame pre-check so an
        // unwind releases the dummy (NULL) harmlessly.
        const pr = this.emitExpr(e.value);
        if (this.wasi) this.emitWasiSuspend(pr.name);
        if (e.type.kind === "void") {
          this.declare(`declare void @scr_await_void(ptr)`);
          B.line(`call void @scr_await_void(ptr ${pr.name})`);
          this.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const t = B.tmp();
        if (e.type.kind === "f64" || e.type.kind === "date") {
          this.declare(`declare double @scr_await_f64(ptr)`);
          B.line(`${t} = call double @scr_await_f64(ptr ${pr.name})`);
        } else if (e.type.kind === "bool") {
          this.declare(`declare zeroext i1 @scr_await_bool(ptr)`);
          B.line(`${t} = call zeroext i1 @scr_await_bool(ptr ${pr.name})`);
        } else if (e.type.kind === "string") {
          this.declare(`declare ptr @scr_await_str(ptr)`);
          B.line(`${t} = call ptr @scr_await_str(ptr ${pr.name})`);
        } else {
          this.declare(`declare ptr @scr_await_ref(ptr)`);
          B.line(`${t} = call ptr @scr_await_ref(ptr ${pr.name})`);
        }
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "awaitUnionExpr": {
        // Await of a promise-or-absent union: the promise arm awaits like
        // awaitExpr (parks, re-throws rejections); a unit arm takes
        // exactly one microtask hop (JS: await of a non-thenable) and
        // yields itself. The union temp is borrowed; the value-carrying
        // result parks in a slot, joins the frame at the load, and the
        // pending check runs after the join (emit-exprs.ts's shape).
        if (e.value.type.kind !== "union") throw new Error("llvm emitter bug: awaitUnion of a non-union");
        const def = this.unionsById.get(e.value.type.unionId);
        const promiseArm = def?.arms[e.promiseTag];
        if (!def || promiseArm?.kind !== "promise") {
          throw new Error("llvm emitter bug: awaitUnion arm is not a promise");
        }
        const inner = promiseArm.inner;
        const u = this.emitExpr(e.value);
        const tag = this.unionTag(u.name);
        const isP = B.tmp();
        B.line(`${isP} = icmp eq i32 ${tag}, ${e.promiseTag}`);
        this.declare(`declare void @scr_await_hop()`);
        if (e.type.kind === "void") {
          const lp = B.newLabel("au.p");
          const lh = B.newLabel("au.h");
          const lj = B.newLabel("au.j");
          B.condBr(isP, lp, lh);
          B.startBlock(lp);
          this.declare(`declare void @scr_await_void(ptr)`);
          {
            const promise = this.unionPeek(u.name);
            if (this.wasi) this.emitWasiSuspend(promise);
            B.line(`call void @scr_await_void(ptr ${promise})`);
          }
          B.br(lj);
          B.startBlock(lh);
          if (this.wasi) this.emitWasiSuspend(null);
          else B.line(`call void @scr_await_hop()`);
          B.br(lj);
          B.startBlock(lj);
          this.emitPendingCheck();
          return { name: "", type: e.type };
        }
        if (e.type.kind !== "union") {
          throw new Error("llvm emitter bug: awaitUnion result is neither void nor a union");
        }
        const resUnionId = e.type.unionId;
        const resDef = this.unionsById.get(resUnionId);
        if (!resDef) throw new Error("llvm emitter bug: awaitUnion result union unknown");
        const resTagOf = (arm: IrType): number => {
          const t = resDef.arms.findIndex((a) => typeEquals(a, arm));
          if (t < 0) throw new Error("llvm emitter bug: awaitUnion result arm missing");
          return t;
        };
        const innerTag = resTagOf(inner);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        B.line(`store ptr null, ptr ${slot}`);
        const lp = B.newLabel("au.p");
        const lh = B.newLabel("au.h");
        const lj = B.newLabel("au.j");
        B.condBr(isP, lp, lh);
        B.startBlock(lp);
        const peek = this.unionPeek(u.name);
        if (this.wasi) this.emitWasiSuspend(peek);
        let awaited: LlValue;
        if (inner.kind === "f64" || inner.kind === "date") {
          this.declare(`declare double @scr_await_f64(ptr)`);
          const x = B.tmp();
          B.line(`${x} = call double @scr_await_f64(ptr ${peek})`);
          awaited = { name: x, type: inner };
        } else if (inner.kind === "bool") {
          this.declare(`declare zeroext i1 @scr_await_bool(ptr)`);
          const x = B.tmp();
          B.line(`${x} = call zeroext i1 @scr_await_bool(ptr ${peek})`);
          awaited = { name: x, type: inner };
        } else if (inner.kind === "string") {
          this.declare(`declare ptr @scr_await_str(ptr)`);
          const x = B.tmp();
          B.line(`${x} = call ptr @scr_await_str(ptr ${peek})`);
          awaited = { name: x, type: inner };
        } else {
          this.declare(`declare ptr @scr_await_ref(ptr)`);
          const x = B.tmp();
          B.line(`${x} = call ptr @scr_await_ref(ptr ${peek})`);
          awaited = { name: x, type: inner };
        }
        B.line(`store ptr ${this.unionNewOwned(innerTag, awaited)}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lh);
        if (this.wasi) this.emitWasiSuspend(null);
        else B.line(`call void @scr_await_hop()`);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        if (unitTags.length === 1) {
          B.line(`store ptr ${this.unitInstanceRef(resUnionId, resTagOf(def.arms[unitTags[0]!]!))}, ptr ${slot}`);
          B.br(lj);
        } else {
          // Several unit arms: dispatch on the source tag (each maps to
          // its own interned instance in the result union).
          const bad = B.newLabel("au.b");
          const labels = unitTags.map(() => B.newLabel("au.u"));
          B.terminate(
            `switch i32 ${tag}, label %${bad} [ ${unitTags.map((t2, i) => `i32 ${t2}, label %${labels[i]}`).join(" ")} ]`,
          );
          unitTags.forEach((t2, i) => {
            B.startBlock(labels[i]!);
            B.line(`store ptr ${this.unitInstanceRef(resUnionId, resTagOf(def.arms[t2]!))}, ptr ${slot}`);
            B.br(lj);
          });
          B.startBlock(bad);
          this.needsBadTag = true;
          B.line(`call void @sc_bad_tag()`);
          B.terminate(`unreachable`);
        }
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ptr, ptr ${slot}`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "newPromise": {
        // Pending promise + resolve closure, executor run synchronously
        // (its throw rejects — handled inside the runtime helper, so no
        // pending check here). Executor/resolve temps are frame-owned;
        // the run call takes ownership of the resolve/reject closures.
        if (e.type.kind !== "promise") throw new Error("llvm emitter bug: newPromise type");
        const inner = e.type.inner;
        this.declare(`declare ptr @scr_promise_new()`);
        const p = B.tmp();
        B.line(`${p} = call ptr @scr_promise_new()`);
        const out = this.own({ name: p, type: e.type });
        // Zero-param executor: no resolve exists — a forever-pending
        // promise unless the executor throws (which rejects it).
        if (e.executor.type.kind === "func" && e.executor.type.params.length === 0) {
          const exec0 = this.emitExpr(e.executor);
          this.declare(`declare void @scr_promise_run_executor0(ptr, ptr)`);
          B.line(`call void @scr_promise_run_executor0(ptr ${p}, ptr ${exec0.name})`);
          return out;
        }
        let resolve: string;
        const kindNums: Partial<Record<IrType["kind"], number>> = { f64: 0, date: 0, bool: 1, string: 2, void: 3 };
        const kindNum = kindNums[inner.kind];
        if (kindNum !== undefined) {
          this.declare(`declare ptr @scr_make_resolve(ptr, i32)`);
          resolve = B.tmp();
          B.line(`${resolve} = call ptr @scr_make_resolve(ptr ${p}, i32 ${kindNum})`);
        } else {
          this.declare(`declare ptr @scr_make_resolve_fn(ptr, ptr)`);
          resolve = B.tmp();
          B.line(`${resolve} = call ptr @scr_make_resolve_fn(ptr ${p}, ptr @${this.resolveThunkFor(inner)})`);
        }
        if (e.executor.type.kind === "func" && e.executor.type.params.length === 2) {
          // Two-param executor: reject is a runtime-provided closure
          // rejecting the promise with its Error reason. First settle
          // wins in the runtime; both closures' +1 move into the call.
          this.declare(`declare ptr @scr_make_reject(ptr)`);
          const reject = B.tmp();
          B.line(`${reject} = call ptr @scr_make_reject(ptr ${p})`);
          const exec2 = this.emitExpr(e.executor);
          this.declare(`declare void @scr_promise_run_executor2(ptr, ptr, ptr, ptr)`);
          B.line(`call void @scr_promise_run_executor2(ptr ${p}, ptr ${exec2.name}, ptr ${resolve}, ptr ${reject})`);
          return out;
        }
        const exec = this.emitExpr(e.executor);
        this.declare(`declare void @scr_promise_run_executor(ptr, ptr, ptr)`);
        B.line(`call void @scr_promise_run_executor(ptr ${p}, ptr ${exec.name}, ptr ${resolve})`);
        return out;
      }
      case "promiseWithResolvers": {
        // The newPromise pieces without an executor: a pending promise,
        // its runtime resolve closure (typed per the inner kind), and the
        // reject closure, written into the fresh record. Closure +1s move
        // into the record's fields; never throws.
        if (e.type.kind !== "record") throw new Error("llvm emitter bug: promiseWithResolvers type");
        const shape = this.recordsById.get(e.type.shapeId);
        const promT = shape?.fields.find((f) => f.name === "promise")?.type;
        if (!shape || promT?.kind !== "promise") {
          throw new Error("llvm emitter bug: promiseWithResolvers record shape");
        }
        const inner = promT.inner;
        this.declare(`declare ptr @scr_promise_new()`);
        this.declare(`declare ptr @scr_make_reject(ptr)`);
        const p = B.tmp();
        B.line(`${p} = call ptr @scr_promise_new()`);
        const kindNums: Partial<Record<IrType["kind"], number>> = { f64: 0, date: 0, bool: 1, string: 2, void: 3 };
        const kindNum = kindNums[inner.kind];
        const resolve = B.tmp();
        if (kindNum !== undefined) {
          this.declare(`declare ptr @scr_make_resolve(ptr, i32)`);
          B.line(`${resolve} = call ptr @scr_make_resolve(ptr ${p}, i32 ${kindNum})`);
        } else {
          this.declare(`declare ptr @scr_make_resolve_fn(ptr, ptr)`);
          B.line(`${resolve} = call ptr @scr_make_resolve_fn(ptr ${p}, ptr @${this.resolveThunkFor(inner)})`);
        }
        const reject = B.tmp();
        B.line(`${reject} = call ptr @scr_make_reject(ptr ${p})`);
        const rec = B.tmp();
        B.line(`${rec} = call ptr @${mangleRecordNew(e.type.shapeId)}()`);
        const out = this.own({ name: rec, type: e.type });
        // The three +1s move straight into the fresh record's fields.
        for (const [field, value] of [["promise", p], ["resolve", resolve], ["reject", reject]] as const) {
          const { ptr } = this.recordFieldPtr(rec, e.type.shapeId, field);
          B.line(`store ptr ${value}, ptr ${ptr}`);
        }
        return out;
      }
      case "libCall":
        return this.emitLibCall(e);
      case "intrinsic": {
        if (e.name === "module.await") {
          // Internal ESM dependency wait: pending promises park the module
          // fiber, while settled ones continue synchronously.
          const p = this.emitExpr(e.args[0]!);
          if (this.wasi) {
            const coro = this.currentWasiCoro;
            if (coro === null) throw new Error("llvm emitter bug: module await outside wasm coroutine");
            this.declare(`declare zeroext i1 @scr_wasi_module_await_prepare(ptr, ptr)`);
            const needsSuspend = B.tmp();
            const suspend = B.newLabel("ma.suspend");
            const ready = B.newLabel("ma.ready");
            B.line(`${needsSuspend} = call zeroext i1 @scr_wasi_module_await_prepare(ptr ${coro.self}, ptr ${p.name})`);
            B.condBr(needsSuspend, suspend, ready);
            B.startBlock(suspend);
            this.emitWasiSuspendPrepared();
            B.br(ready);
            B.startBlock(ready);
            this.declare(`declare void @scr_module_await(ptr)`);
            B.line(`call void @scr_module_await(ptr ${p.name})`);
          } else {
            this.declare(`declare void @scr_module_await(ptr)`);
            B.line(`call void @scr_module_await(ptr ${p.name})`);
          }
          this.emitPendingCheck();
          return { name: "", type: e.type };
        }
        if (e.name === "promise.all") {
          // The runtime countdown combinator (emit-exprs.ts): a pre-sized
          // values array filled per INPUT index as entries fulfill, plus
          // one subscription per entry. Entry and values arrays both stay
          // frame-owned; the combinator BORROWS them.
          if (e.type.kind !== "promise") throw new Error("llvm emitter bug: promise.all type");
          const entries = e.args[0]!;
          if (entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
            throw new Error("llvm emitter bug: promise.all argument");
          }
          const ps = this.emitExpr(entries);
          this.declare(`declare ptr @scr_promise_all(ptr, ptr, ptr)`);
          if (e.type.inner.kind === "void") {
            const t = B.tmp();
            B.line(`${t} = call ptr @scr_promise_all(ptr ${ps.name}, ptr null, ptr null)`);
            return this.own({ name: t, type: e.type });
          }
          if (e.type.inner.kind !== "array") throw new Error("llvm emitter bug: promise.all result");
          const elem = e.type.inner.elem;
          const store =
            elem.kind === "f64" ? "scr_promise_all_store_f64"
            : elem.kind === "bool" ? "scr_promise_all_store_bool"
            : elem.kind === "string" ? "scr_promise_all_store_str"
            : "scr_promise_all_store_ref";
          this.declare(`declare void @${store}(ptr, double, ptr)`);
          this.declare(`declare double @scr_arr_len(ptr)`);
          const len = B.tmp();
          const cap = B.tmp();
          B.line(`${len} = call double @scr_arr_len(ptr ${ps.name})`);
          B.line(`${cap} = fptoui double ${len} to ${this.sizeType}`);
          const vals = B.tmp();
          B.line(`${vals} = ${arrNewCall(this, elem, cap)}`);
          this.own({ name: vals, type: e.type.inner });
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_promise_all(ptr ${ps.name}, ptr ${vals}, ptr @${store})`);
          return this.own({ name: t, type: e.type });
        }
        if (e.name === "promise.reject") {
          // A fresh promise rejected through the exception cell: the
          // %Error-rooted reason moves in as the cell's OBJ payload (a
          // checked-dynamic reason rides the thrown-dyn REF representation
          // instead — identity flows to catch/unhandledRejection observers,
          // emitThrowValue's dyn arm), and reject_pending moves the cell
          // into the promise (consumed immediately — no pending check runs
          // in between).
          if (e.type.kind !== "promise") throw new Error("llvm emitter bug: promise.reject type");
          const reasonT = e.args[0]!.type;
          if (reasonT.kind !== "object" && reasonT.kind !== "dyn") {
            throw new Error("llvm emitter bug: promise.reject reason");
          }
          this.declare(`declare ptr @scr_promise_new()`);
          this.declare(`declare void @scr_promise_reject_pending(ptr)`);
          const reason = this.emitExpr(e.args[0]!);
          const p = B.tmp();
          B.line(`${p} = call ptr @scr_promise_new()`);
          const out = this.own({ name: p, type: e.type });
          this.moveTemp(reason); // the cell takes ownership
          this.emitThrowValue({ name: reason.name, type: reasonT });
          B.line(`call void @scr_promise_reject_pending(ptr ${p})`);
          return out;
        }
        if (e.name === "promise.resolve") {
          // A fresh promise fulfilled immediately: void/f64/bool by
          // value, strings and refs MOVE in — the async-return
          // trampoline's fulfill exactly. No waiters exist yet.
          if (e.type.kind !== "promise") throw new Error("llvm emitter bug: promise.resolve type");
          this.declare(`declare ptr @scr_promise_new()`);
          const p = B.tmp();
          B.line(`${p} = call ptr @scr_promise_new()`);
          const out = this.own({ name: p, type: e.type });
          if (e.args.length === 0) {
            this.declare(`declare void @scr_promise_fulfill_void(ptr)`);
            B.line(`call void @scr_promise_fulfill_void(ptr ${p})`);
            return out;
          }
          const v = this.emitExpr(e.args[0]!);
          const t = e.args[0]!.type;
          if (t.kind === "f64" || t.kind === "date") {
            this.declare(`declare void @scr_promise_fulfill_f64(ptr, double)`);
            B.line(`call void @scr_promise_fulfill_f64(ptr ${p}, double ${v.name})`);
          } else if (t.kind === "bool") {
            this.declare(`declare void @scr_promise_fulfill_bool(ptr, i1 zeroext)`);
            B.line(`call void @scr_promise_fulfill_bool(ptr ${p}, i1 ${v.name})`);
          } else if (t.kind === "string") {
            this.moveTemp(v);
            this.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
            B.line(`call void @scr_promise_fulfill_str(ptr ${p}, ptr ${v.name})`);
          } else {
            const rc = vAdapters(this, t);
            this.moveTemp(v);
            this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
            B.line(
              `call void @scr_promise_fulfill_ref(ptr ${p}, ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, t)})`,
            );
          }
          return out;
        }
        if (e.name === "promise.race") {
          // A fresh result promise + one race_add per entry: settled
          // entries settle it immediately (first add wins), pending ones
          // park a callback waiter. Entry temps stay frame-owned
          // (race_add retains what it keeps).
          if (e.type.kind !== "promise") throw new Error("llvm emitter bug: promise.race type");
          this.declare(`declare ptr @scr_promise_new()`);
          this.declare(`declare void @scr_promise_race_add(ptr, ptr, ptr)`);
          const result = B.tmp();
          B.line(`${result} = call ptr @scr_promise_new()`);
          const out = this.own({ name: result, type: e.type });
          for (const entry of e.args) {
            if (entry.type.kind !== "promise") throw new Error("llvm emitter bug: promise.race entry");
            const p = this.emitExpr(entry);
            const adapter = this.raceAdapterFor(entry.type.inner, e.type.inner);
            B.line(`call void @scr_promise_race_add(ptr ${result}, ptr ${p.name}, ptr @${adapter})`);
          }
          return out;
        }
        if (e.name !== "console.log" && e.name !== "console.error") {
          throw new LlvmUnsupportedError(`intrinsic:${e.name}`, e.loc);
        }
        // The ScrLogArg protocol: one entry-block array (sized to the
        // function's max arity), tag + 8-byte union slot per argument.
        // String args are BORROWED — their temps stay frame-owned and
        // release at statement end, after the call.
        const args = e.args.map((a) => this.emitExpr(a));
        this.logArgSlots = Math.max(this.logArgSlots, Math.max(args.length, 1));
        args.forEach((a, i) => {
          const tagOf: Record<string, number> = { f64: 0, string: 1, bool: 2 };
          const tag = tagOf[a.type.kind];
          if (tag === undefined) throw new LlvmUnsupportedError(`logArg:${a.type.kind}`, e.loc);
          const tp = B.tmp();
          const vp = B.tmp();
          B.line(`${tp} = getelementptr inbounds %ScrLogArg, ptr %logargs, i64 ${i}, i32 0`);
          B.line(`store i32 ${tag}, ptr ${tp}`);
          B.line(`${vp} = getelementptr inbounds %ScrLogArg, ptr %logargs, i64 ${i}, i32 1`);
          if (a.type.kind === "f64") B.line(`store double ${a.name}, ptr ${vp}`);
          else if (a.type.kind === "string") B.line(`store ptr ${a.name}, ptr ${vp}`);
          else {
            const z = B.tmp();
            B.line(`${z} = zext i1 ${a.name} to i8`);
            B.line(`store i8 ${z}, ptr ${vp}`);
          }
        });
        const fn = e.name === "console.error" ? "scr_console_error" : "scr_console_log";
        this.declare(`declare void @${fn}(${this.sizeType}, ptr)`);
        B.line(`call void @${fn}(${this.sizeType} ${args.length}, ptr %logargs)`);
        return { name: "", type: e.type };
      }
      case "dynFrom": {
        // Static value → fresh dyn tree (+1) through the interned per-type
        // converter; the operand stays borrowed (frame-released as usual).
        // Bare unit literals (an `undefined`/`null` stored under an
        // `unknown` index signature) are the dyn unit values directly.
        if (e.value.kind === "unitLit") {
          const t = B.tmp();
          if (e.value.unit === "undefined") {
            this.declare(`declare ptr @scr_dyn_undefined()`);
            this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
            const u = B.tmp();
            B.line(`${u} = call ptr @scr_dyn_undefined()`);
            B.line(`${t} = call ptr @scr_dyn_retain_v(ptr ${u})`);
          } else {
            this.declare(`declare ptr @scr_dyn_new_null()`);
            B.line(`${t} = call ptr @scr_dyn_new_null()`);
          }
          return this.own({ name: t, type: e.type });
        }
        const v = this.emitExpr(e.value);
        if (e.liveRef) {
          if (v.type.kind === "union") {
            const adapter = this.liveDynUnionRefAdapter(v.type);
            const boxed = B.tmp();
            B.line(`${boxed} = call ptr @${adapter}(ptr ${v.name})`);
            return this.own({ name: boxed, type: e.type });
          }
          if (!this.streamTypedRefEligible(v.type)) {
            throw new Error(`llvm emitter bug: live dyn ref of ${typeKey(v.type)}`);
          }
          const key = typeKey(v.type);
          let adapter = this.liveDynRefAdapters.get(key);
          if (!adapter) {
            const prefix = `sc_ldr_${this.liveDynRefAdapters.size}`;
            adapter = this.streamTypedRefMaterializeAdapter(
              v.type,
              { prefix, adapters: new Map() },
              `${prefix}_materialize`,
            );
            this.liveDynRefAdapters.set(key, adapter);
          }
          const rc = vAdapters(this, v.type);
          this.declare(
            `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${this.sizeType}, ptr, ptr)`,
          );
          const boxed = B.tmp();
          B.line(
            `${boxed} = call ptr @scr_dyn_new_typed_ref(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${this.cstr(key)}, ${this.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
          );
          return this.own({ name: boxed, type: e.type });
        }
        if (v.type.kind === "func") {
          // A closure boxes as the checked-dynamic tree's function kind: retained closure +
          // the per-signature call thunk + the interned signature key. The
          // best-effort name rides along (null when the lowering had none).
          const name =
            e.fnName !== undefined && e.fnName !== "" ? this.cstr(e.fnName) : "null";
          const box = this.dyn.dynFuncBoxHelper(v.type);
          const t = B.tmp();
          B.line(`${t} = call ptr @${box}(ptr ${v.name}, ptr ${name})`);
          return this.own({ name: t, type: e.type });
        }
        const conv = this.dyn.toDynHelper(v.type);
        const valTy = v.type.kind === "f64" ? "double" : v.type.kind === "bool" ? "i1" : "ptr";
        const t = B.tmp();
        B.line(`${t} = call ptr @${conv}(${valTy} ${v.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "dynFromJsval": {
        // Island value → dyn: the by-reference wrap (scr_dyn_from_jsval
        // retains the cell in; engine scalars normalize to native dyn
        // kinds at wrap time). Operand borrowed, result +1, never throws.
        const v = this.emitExpr(e.value);
        this.declare(`declare ptr @scr_dyn_from_jsval(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_dyn_from_jsval(ptr ${v.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "caughtToDyn": {
        // A catch binding flowing into an `unknown` slot: the snapshot's
        // runtime kind converts through the interned helper (+1 fresh
        // tree; never throws). Box borrowed.
        const c = this.emitExpr(e.value);
        const helper = this.dyn.caughtToDynHelper();
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${c.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "dynCheck": {
        // The dynamic boundary: validate the checked-dynamic tree against the target type
        // and BUILD the typed value (+1) — or throw the catchable
        // path-annotated TypeError. The dyn temp is BORROWED; the result
        // joins the frame BEFORE the pending check so an unwind releases
        // the dummy harmlessly.
        const dynV = this.emitExpr(e.value);
        const helper = this.dyn.dynCheckHelper(e.type);
        const ty = this.llType(e.type);
        const t = B.tmp();
        B.line(`${t} = call ${ty === "i1" ? "zeroext i1" : ty} @${helper}(ptr ${dynV.name}, ptr null)`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "dynCall": {
        // Calling a dyn value: args are already dyn (the lowering boxed or
        // converted them); everything is BORROWED by scr_dyn_call — the
        // boxed thunk builds its own typed copies. The callee's source
        // spelling rides along for Node's "<name> is not a function".
        const callee = this.emitExpr(e.callee);
        if (e.spreads !== undefined && e.spreads.length > 0) {
          // The RUNTIME-ARITY form (`f(...args)`): one fresh dyn array
          // collects the arguments left-to-right — plain args move in
          // (push takes ownership), spread args FLATTEN (push_spread
          // retains elements in and throws V8's spread-call TypeError for
          // non-iterable dyn kinds, checked per spread — JS's
          // ArgumentListEvaluation order) — then apply calls through the
          // array's elements (borrowed, exactly scr_dyn_call).
          this.declare(`declare ptr @scr_dyn_new_arr()`);
          this.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
          this.declare(`declare void @scr_dyn_arr_push_spread(ptr, ptr, ptr)`);
          this.declare(`declare ptr @scr_dyn_apply(ptr, ptr, ptr)`);
          const spreadAt = new Map(e.spreads.map((s) => [s.arg, s.what]));
          const pack = B.tmp();
          B.line(`${pack} = call ptr @scr_dyn_new_arr()`);
          this.own({ name: pack, type: DYN });
          e.args.forEach((a, i) => {
            const v = this.emitExpr(a);
            const spreadWhat = spreadAt.get(i);
            if (spreadWhat !== undefined) {
              B.line(`call void @scr_dyn_arr_push_spread(ptr ${pack}, ptr ${v.name}, ptr ${this.cstr(spreadWhat)})`);
              this.emitPendingCheck();
            } else {
              this.moveTemp(v);
              B.line(`call void @scr_dyn_arr_push(ptr ${pack}, ptr ${v.name})`);
            }
          });
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_dyn_apply(ptr ${callee.name}, ptr ${pack}, ptr ${this.cstr(e.calleeName)})`);
          const out = this.own({ name: t, type: e.type });
          this.emitPendingCheck();
          return out;
        }
        const args = e.args.map((a) => this.emitExpr(a));
        let argsPtr = "null";
        if (args.length > 0) {
          const arr = B.slot();
          B.entryAllocas.push(`${arr} = alloca [${args.length} x ptr]`);
          args.forEach((a, i) => {
            const p = B.tmp();
            B.line(`${p} = getelementptr inbounds [${args.length} x ptr], ptr ${arr}, i64 0, ${this.sizeType} ${i}`);
            B.line(`store ptr ${a.name}, ptr ${p}`);
          });
          argsPtr = arr;
        }
        this.declare(`declare ptr @scr_dyn_call(ptr, ptr, ${this.sizeType}, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_dyn_call(ptr ${callee.name}, ptr ${argsPtr}, ${this.sizeType} ${args.length}, ptr ${this.cstr(e.calleeName)})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "dynInvoke": {
        // Prototype-method dispatch on a dyn receiver: everything is
        // BORROWED by scr_dyn_invoke; the result is owned and may ride a
        // pending exception.
        const recv = this.emitExpr(e.recv);
        const args = e.args.map((a) => this.emitExpr(a));
        let argsPtr = "null";
        if (args.length > 0) {
          const arr = B.slot();
          B.entryAllocas.push(`${arr} = alloca [${args.length} x ptr]`);
          args.forEach((a, i) => {
            const p = B.tmp();
            B.line(`${p} = getelementptr inbounds [${args.length} x ptr], ptr ${arr}, i64 0, ${this.sizeType} ${i}`);
            B.line(`store ptr ${a.name}, ptr ${p}`);
          });
          argsPtr = arr;
        }
        this.declare(`declare ptr @scr_dyn_invoke(ptr, ptr, ptr, ${this.sizeType}, ptr)`);
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_dyn_invoke(ptr ${recv.name}, ptr ${this.cstr(e.method)}, ptr ${argsPtr}, ${this.sizeType} ${args.length}, ptr ${this.cstr(e.calleeName)})`,
        );
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "dynArrLit": {
        // A dyn array built element-by-element: ownership of each dyn
        // element MOVES into the array (scr_dyn_arr_push's contract).
        this.declare(`declare ptr @scr_dyn_new_arr()`);
        this.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
        const arr = B.tmp();
        B.line(`${arr} = call ptr @scr_dyn_new_arr()`);
        const out = this.own({ name: arr, type: e.type });
        for (const el of e.elems) {
          const v = this.emitExpr(el);
          this.moveTemp(v);
          B.line(`call void @scr_dyn_arr_push(ptr ${arr}, ptr ${v.name})`);
        }
        return out;
      }
      case "dynObjLit": {
        // A dyn object built member-by-member: key then value, source
        // order. scr_dyn_key_set BORROWS all three (the member retains the
        // value in); the receiver is a fresh OBJ, so the non-object throw
        // paths are unreachable here.
        this.declare(`declare ptr @scr_dyn_new_obj()`);
        this.declare(`declare void @scr_dyn_key_set(ptr, ptr, ptr)`);
        const obj = B.tmp();
        B.line(`${obj} = call ptr @scr_dyn_new_obj()`);
        const out = this.own({ name: obj, type: e.type });
        for (const f of e.fields ?? []) {
          const k = this.emitExpr(f.key);
          const v = this.emitExpr(f.value);
          B.line(`call void @scr_dyn_key_set(ptr ${obj}, ptr ${k.name}, ptr ${v.name})`);
        }
        return out;
      }
      case "dynKeyGet": {
        // Keyed read on the checked-dynamic tree through the one interned helper — the
        // non-optional form throws JS's TypeError on an undefined/null
        // receiver, and HANDLE receivers can throw the loud unmodeled-
        // property ladder on EITHER form; the result is owned (+1).
        const d = this.emitExpr(e.value);
        const k = this.emitExpr(e.key);
        const helper = this.dyn.dynKeyGetHelper();
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${d.name}, ptr ${k.name}, i1 ${e.optional ? "true" : "false"})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "dynHasKey": {
        // `"k" in pkg`: a kind-guarded presence answer, computed against
        // the literal key at compile time — no allocation, borrowed box.
        const d = this.emitExpr(e.value);
        const kd = this.dynKind(d.name);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca i1`);
        B.line(`store i1 false, ptr ${slot}`);
        const lObj = B.newLabel("dhk.o");
        const lArr = B.newLabel("dhk.a");
        const lNotObj = B.newLabel("dhk.no");
        const lj = B.newLabel("dhk.j");
        const isObj = B.tmp();
        B.line(`${isObj} = icmp eq i32 ${kd}, ${DK.OBJ}`);
        B.condBr(isObj, lObj, lNotObj);
        B.startBlock(lObj);
        this.declare(`declare ptr @scr_dyn_obj_get(ptr, ptr, ${this.sizeType})`);
        const keyBytes = Buffer.byteLength(e.key, "utf8");
        const m = B.tmp();
        const has = B.tmp();
        B.line(`${m} = call ptr @scr_dyn_obj_get(ptr ${d.name}, ptr ${this.cstr(e.key)}, ${this.sizeType} ${keyBytes})`);
        B.line(`${has} = icmp ne ptr ${m}, null`);
        B.line(`store i1 ${has}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lNotObj);
        const isArr = B.tmp();
        B.line(`${isArr} = icmp eq i32 ${kd}, ${DK.ARR}`);
        const lNotArr = B.newLabel("dhk.na");
        B.condBr(isArr, lArr, lNotArr);
        B.startBlock(lArr);
        if (e.key === "length") {
          B.line(`store i1 true, ptr ${slot}`);
        } else if (/^(0|[1-9][0-9]*)$/.test(e.key) && Number(e.key) <= Number.MAX_SAFE_INTEGER) {
          const lenp = B.tmp();
          const len = B.tmp();
          const inR = B.tmp();
          B.line(`${lenp} = getelementptr inbounds i8, ptr ${d.name}, i64 16 ; ->v.arr.len`);
          B.line(`${len} = load ${this.sizeType}, ptr ${lenp}`);
          B.line(`${inR} = icmp ugt ${this.sizeType} ${len}, ${e.key}`);
          B.line(`store i1 ${inR}, ptr ${slot}`);
        }
        B.br(lj);
        // An ISLAND-held receiver fences loudly (Node asks the real
        // engine object — `false` would be a silent wrong answer); the
        // helper answers false for every other kind, so this arm is a
        // plain unconditional call.
        B.startBlock(lNotArr);
        this.declare(`declare zeroext i1 @scr_dyn_isl_fence(ptr, ptr)`);
        const fenced = B.tmp();
        B.line(`${fenced} = call zeroext i1 @scr_dyn_isl_fence(ptr ${d.name}, ptr ${this.cstr("'in'")})`);
        B.line(`store i1 ${fenced}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lj);
        const raw = B.tmp();
        B.line(`${raw} = load i1, ptr ${slot}`);
        this.emitPendingCheck();
        if (!e.negated) return { name: raw, type: e.type };
        const neg = B.tmp();
        B.line(`${neg} = xor i1 ${raw}, true`);
        return { name: neg, type: e.type };
      }
      case "dynScalarEq": {
        // dyn vs scalar strict equality: kind test + payload compare.
        // Operands emit in SOURCE order; the dyn side is found by type.
        // Both borrowed, no allocation.
        const l = this.emitExpr(e.left);
        const r = this.emitExpr(e.right);
        const [d, s, st] = e.left.type.kind === "dyn" ? [l, r, e.right.type] : [r, l, e.left.type];
        let test: string;
        if (st.kind === "dyn") {
          // dyn vs dyn: whole-dyn strict equality.
          this.declare(`declare zeroext i1 @scr_dyn_strict_eq(ptr, ptr)`);
          test = B.tmp();
          B.line(`${test} = call zeroext i1 @scr_dyn_strict_eq(ptr ${l.name}, ptr ${r.name})`);
        } else {
          const kd = this.dynKind(d.name);
          const kindOk = B.tmp();
          const wantKind = st.kind === "string" ? DK.STR : st.kind === "f64" ? DK.NUM : DK.BOOL;
          B.line(`${kindOk} = icmp eq i32 ${kd}, ${wantKind}`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca i1`);
          B.line(`store i1 false, ptr ${slot}`);
          const lCmp = B.newLabel("dse.c");
          const lj = B.newLabel("dse.j");
          B.condBr(kindOk, lCmp, lj);
          B.startBlock(lCmp);
          const pv = B.tmp();
          const eq = B.tmp();
          if (st.kind === "string") {
            this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
            B.line(`${pv} = getelementptr inbounds i8, ptr ${d.name}, i64 16 ; ->v.str`);
            const sv = B.tmp();
            B.line(`${sv} = load ptr, ptr ${pv}`);
            B.line(`${eq} = call zeroext i1 @scr_str_eq(ptr ${sv}, ptr ${s.name})`);
          } else if (st.kind === "f64") {
            B.line(`${pv} = getelementptr inbounds i8, ptr ${d.name}, i64 16 ; ->v.num`);
            const nv = B.tmp();
            B.line(`${nv} = load double, ptr ${pv}`);
            B.line(`${eq} = fcmp oeq double ${nv}, ${s.name}`);
          } else {
            B.line(`${pv} = getelementptr inbounds i8, ptr ${d.name}, i64 16 ; ->v.b`);
            const raw = B.tmp();
            const bv = B.tmp();
            B.line(`${raw} = load i8, ptr ${pv}`);
            B.line(`${bv} = trunc i8 ${raw} to i1`);
            B.line(`${eq} = icmp eq i1 ${bv}, ${s.name}`);
          }
          B.line(`store i1 ${eq}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lj);
          test = B.tmp();
          B.line(`${test} = load i1, ptr ${slot}`);
        }
        if (!e.negated) return { name: test, type: e.type };
        const neg = B.tmp();
        B.line(`${neg} = xor i1 ${test}, true`);
        return { name: neg, type: e.type };
      }
      case "dynTest": {
        // A pure kind compare on the dyn node — borrowed; only the truthy
        // form also reads a scalar payload (the runtime's ToBoolean).
        const d = this.emitExpr(e.value);
        let test: string;
        if (e.test === "truthy") {
          this.declare(`declare zeroext i1 @scr_dyn_truthy(ptr)`);
          test = B.tmp();
          B.line(`${test} = call zeroext i1 @scr_dyn_truthy(ptr ${d.name})`);
        } else if (e.test === "error") {
          // `u instanceof Error`: the checked-dynamic tree's error encoding — an object
          // carrying the reserved "%error" marker key — or a real engine
          // Error held by reference (the isl helper answers false for
          // every non-JSVAL kind, so the call is unconditional).
          const kd = this.dynKind(d.name);
          const isObj = B.tmp();
          B.line(`${isObj} = icmp eq i32 ${kd}, ${DK.OBJ}`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca i1`);
          this.declare(`declare zeroext i1 @scr_dyn_isl_is_error(ptr)`);
          const isl = B.tmp();
          B.line(`${isl} = call zeroext i1 @scr_dyn_isl_is_error(ptr ${d.name})`);
          B.line(`store i1 ${isl}, ptr ${slot}`);
          const lObj = B.newLabel("dts.o");
          const lj = B.newLabel("dts.j");
          B.condBr(isObj, lObj, lj);
          B.startBlock(lObj);
          this.declare(`declare ptr @scr_dyn_obj_get(ptr, ptr, ${this.sizeType})`);
          const m = B.tmp();
          const has = B.tmp();
          B.line(`${m} = call ptr @scr_dyn_obj_get(ptr ${d.name}, ptr ${this.cstr("%error")}, ${this.sizeType} 6)`);
          B.line(`${has} = icmp ne ptr ${m}, null`);
          B.line(`store i1 ${has}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lj);
          test = B.tmp();
          B.line(`${test} = load i1, ptr ${slot}`);
        } else {
          const kd = this.dynKind(d.name);
          const oneOf = (kinds: number[]): string => {
            let acc = "";
            for (const k of kinds) {
              const c = B.tmp();
              B.line(`${c} = icmp eq i32 ${kd}, ${k}`);
              if (acc === "") {
                acc = c;
              } else {
                const o = B.tmp();
                B.line(`${o} = or i1 ${acc}, ${c}`);
                acc = o;
              }
            }
            return acc;
          };
          // ISLAND-held nodes route the tests that depend on the engine's
          // answer through the scr_dyn_isl_* helpers (false on every
          // other kind — the calls stay unconditional and branch-free).
          const orIsl = (acc: string, helper: string, arg?: string): string => {
            this.declare(`declare zeroext i1 @${helper}(ptr${arg !== undefined ? ", ptr" : ""})`);
            const c = B.tmp();
            B.line(`${c} = call zeroext i1 @${helper}(ptr ${d.name}${arg !== undefined ? `, ptr ${arg}` : ""})`);
            const o = B.tmp();
            B.line(`${o} = or i1 ${acc}, ${c}`);
            return o;
          };
          if (e.test === "nullish") {
            test = oneOf([DK.UNDEF, DK.NULL]);
          } else if (e.test === "object") {
            // `typeof v === "object"`: objects, arrays, bytes, native
            // handles, promises, AND null — engine-held objects by the
            // engine's own typeof.
            test = orIsl(oneOf([DK.OBJ, DK.ARR, DK.BYTES, DK.HANDLE, DK.PROMISE, DK.NULL]), "scr_dyn_isl_typeof_is", this.cstr("object"));
          } else if (e.test === "array") {
            // Array.isArray: the checked-dynamic tree's array kind, or the engine's own
            // answer for an engine-held value.
            test = orIsl(oneOf([DK.ARR]), "scr_dyn_isl_is_array");
          } else if (e.test === "function") {
            test = orIsl(oneOf([DK.FUNC]), "scr_dyn_isl_typeof_is", this.cstr("function"));
          } else {
            const kindOf: Record<string, number> = {
              string: DK.STR,
              number: DK.NUM,
              boolean: DK.BOOL,
              undefined: DK.UNDEF,
              null: DK.NULL,
              bytes: DK.BYTES,
            };
            test = oneOf([kindOf[e.test]!]);
          }
        }
        if (!e.negated) return { name: test, type: e.type };
        const neg = B.tmp();
        B.line(`${neg} = xor i1 ${test}, true`);
        return { name: neg, type: e.type };
      }
      case "dynDestrCheck": {
        // RequireObjectCoercible with V8's destructuring TypeError. dyn
        // values check in the runtime helper and pass through unchanged
        // (same temp, same ownership); island values check in the engine
        // (a fresh +1 cell for the same value comes back).
        const v = this.emitExpr(e.value);
        const first = e.firstProp !== undefined ? this.cstr(e.firstProp) : "null";
        if (e.value.type.kind === "jsval") {
          this.declare(`declare ptr @scr_jsval_destr_check(ptr, ptr, ptr)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_destr_check(ptr ${v.name}, ptr ${this.cstr(e.spelling)}, ptr ${first})`);
          const out = this.own({ name: t, type: e.type });
          this.emitPendingCheck();
          return out;
        }
        const helper = this.dyn.dynDestrCheckHelper();
        B.line(`call void @${helper}(ptr ${v.name}, ptr ${this.cstr(e.spelling)}, ptr ${first})`);
        this.emitPendingCheck();
        return v;
      }
      case "dynIterN": {
        // GetIterator + first-N steps as a fresh array (V8's exact
        // not-iterable TypeError on non-iterables): the dyn helper for
        // dyn operands, the engine's real iterator protocol for island
        // ones.
        const v = this.emitExpr(e.value);
        if (e.value.type.kind === "jsval") {
          this.declare(`declare ptr @scr_jsval_iter_n(ptr, double)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_iter_n(ptr ${v.name}, double ${f64Lit(e.count)})`);
          const out = this.own({ name: t, type: e.type });
          this.emitPendingCheck();
          return out;
        }
        const helper = this.dyn.dynIterNHelper();
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${v.name}, ${this.sizeType} ${e.count})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "jsMarshal":
        return this.emitJsMarshal(e);
      case "jsOp":
        return this.emitJsOp(e);
      case "jsExit":
        return this.emitJsExit(e);
      case "jsBridgePromise": {
        // Island → static promise bridge: a fresh pending ScrPromise the
        // engine promise settles. Operand borrowed; the +1 promise joins
        // the frame. Pending check like other island ops.
        const v = this.emitExpr(e.value);
        const payload =
          e.type.kind === "promise" && e.type.inner.kind === "void"
            ? 0 // SCR_ISLP_VOID
            : e.type.kind === "promise" && e.type.inner.kind === "array" && e.type.inner.elem.kind === "jsval"
              ? 5 // SCR_ISLP_JSVAL_ARR: the Array.isArray-gated by-reference exit at settle
              : 4; // SCR_ISLP_JSVAL
        this.declare(`declare ptr @scr_jsval_bridge_promise(ptr, i32)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_bridge_promise(ptr ${v.name}, i32 ${payload})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "promiseVoidWiden": {
        // One ScrPromise* either way — ownership transfers, type-only
        // (the C emitter's rule).
        const v = this.emitExpr(e.value);
        this.moveTemp(v);
        return this.own({ name: v.name, type: e.type });
      }
      default: {
        // Exhaustive: phase 6 claimed the last IR expression kinds.
        const _exhaustive: never = e;
        void _exhaustive;
        throw new Error("unreachable");
      }
    }
  }

  /* ── the island surface (emit-island.ts + emit-exprs.ts, ported) ─────── */

  /** Static → island marshal (--dynamic only): primitives by value,
   * JSON-safe composites through the type-directed serializer and the
   * engine's JSON parser, closures behind interned host-call adapters.
   * Operand borrowed; result +1. */
  private emitJsMarshal(e: IrExpr & { kind: "jsMarshal" }): LlValue {
    const B = this.B;
    const v = this.emitExpr(e.value);
    const simple = (sym: string, argTy: string, fallible: boolean): LlValue => {
      this.declare(`declare ptr @${sym}(${argTy === "i1" ? "i1 zeroext" : argTy})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(${argTy} ${v.name})`);
      const out = this.own({ name: t, type: e.type });
      if (fallible) this.emitPendingCheck();
      return out;
    };
    switch (e.value.type.kind) {
      case "f64":
        return simple("scr_jsval_from_f64", "double", false);
      case "bool":
        return simple("scr_jsval_from_bool", "i1", false);
      case "string":
        return simple("scr_jsval_from_str", "ptr", false);
      case "dyn":
        // A CHECKED-DYNAMIC (dyn) value entering the island: deep copy,
        // data kinds only — boxed functions/handles/promises throw the
        // catchable TypeError in the runtime, and a wrapped island value
        // unwraps to the SAME engine value (the identity round trip).
        // The C emitter's rule, mirrored.
        return simple("scr_jsval_from_dyn", "ptr", true);
      case "bytes":
        // A typed array crossing IN: a COPY (the boundary's copy stance).
        return simple("scr_jsval_from_bytes", "ptr", true);
      case "url":
        // A URL crossing IN: an engine URL instance built from href.
        return simple("scr_jsval_from_url", "ptr", true);
      case "promise": {
        // A STATIC promise crossing IN: a real engine thenable settled
        // when the scriptc promise settles (the async-callback return
        // bridge). from_promise takes ownership of a +1 — retain past
        // the borrowed frame temp. The C emitter's rule, mirrored.
        const tag = islandPromisePayloadTag(e.value.type.inner);
        if (!tag) throw new Error("llvm emitter bug: jsMarshal of a promise outside the bridge payload domain");
        const tagN = { void: 0, f64: 1, bool: 2, string: 3, jsval: 4, jsvalArr: 5 }[tag];
        this.declare(`declare ptr @scr_promise_retain(ptr)`);
        this.declare(`declare ptr @scr_jsval_from_promise(ptr, i32)`);
        const pr = B.tmp();
        B.line(`${pr} = call ptr @scr_promise_retain(ptr ${v.name})`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_from_promise(ptr ${pr}, i32 ${tagN})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "func": {
        // A closure entering the island as a host function: from_closure
        // retains it; the engine's finalizer releases it at teardown. The
        // per-signature adapter gives the runtime one uniform call shape.
        const fn = e.value.type;
        const adapter = canMarshalFuncIntoIsland(fn)
          ? this.islandAdapter(fn.params.length, fn.ret.kind as "void" | "jsval" | "f64" | "bool" | "string")
          : this.islandTypedAdapter(fn);
        this.declare(`declare ptr @scr_jsval_from_closure(ptr, i32, ptr)`);
        // ISLAND-REST closures encode a NEGATIVE arity (the C emitter's
        // rule): the wrapper hands the trailing slot the engine array of
        // the surplus arguments.
        const arity = fn.rest === true && fn.restAbi === "jsval" ? -fn.params.length : fn.params.length;
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_from_closure(ptr ${v.name}, i32 ${arity}, ptr @${adapter})`);
        return this.own({ name: t, type: e.type });
      }
      default: {
        // JSON-safe composite: deep copy through the emitted serializer
        // and the engine's JSON parser (documented aliasing divergence).
        const helper = this.walkers.jsonWriteHelper(e.value.type);
        this.declare(`declare void @scr_jb_init(ptr)`);
        this.declare(`declare ptr @scr_jb_finish(ptr)`);
        this.declare(`declare ptr @scr_jsval_from_json(ptr)`);
        const buf = B.slot();
        B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`);
        B.line(`call void @scr_jb_init(ptr ${buf})`);
        B.line(`call void @${helper}(ptr ${buf}, ${this.llType(e.value.type)} ${v.name})`);
        const js = B.tmp();
        B.line(`${js} = call ptr @scr_jb_finish(ptr ${buf})`);
        this.own({ name: js, type: STRING });
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_from_json(ptr ${js})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
    }
  }

  /** Island operation: JS semantics via the engine, never native
   * reimplementations. jsval args are borrowed frame temps; jsval/string
   * results +1; engine exceptions bridge into the cell (pending checks
   * after every fallible op). */
  private emitJsOp(e: IrExpr & { kind: "jsOp" }): LlValue {
    const B = this.B;
    const args = e.args.map((a) => this.emitExpr(a));
    const a = (i: number): string => args[i]!.name;
    const nameSym = (): string => this.internLiteral(e.name!);
    const fallible = (call: () => string): LlValue => {
      const t = call();
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    };
    const argPack = (list: string[]): string => {
      if (list.length === 0) return "null";
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${list.length} x ptr]`);
      list.forEach((x, i) => {
        const p = B.tmp();
        B.line(`${p} = getelementptr inbounds [${list.length} x ptr], ptr ${arr}, i64 0, i64 ${i}`);
        B.line(`store ptr ${x}, ptr ${p}`);
      });
      return arr;
    };
    const JSOP: Record<string, number> = {
      add: 0, sub: 1, mul: 2, div: 3, mod: 4, pow: 5,
      lt: 6, le: 7, gt: 8, ge: 9, eq: 10, neq: 11,
    };
    switch (e.op) {
      case "add": case "sub": case "mul": case "div": case "mod": case "pow":
        this.declare(`declare ptr @scr_jsval_binop(i32, ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_binop(i32 ${JSOP[e.op]}, ptr ${a(0)}, ptr ${a(1)})`);
          return t;
        });
      case "lt": case "le": case "gt": case "ge": case "eq": case "neq": {
        this.declare(`declare i32 @scr_jsval_cmp(i32, ptr, ptr)`);
        const r = B.tmp();
        B.line(`${r} = call i32 @scr_jsval_cmp(i32 ${JSOP[e.op]}, ptr ${a(0)}, ptr ${a(1)})`);
        const t = B.tmp();
        B.line(`${t} = icmp eq i32 ${r}, 1`);
        const out = { name: t, type: e.type };
        this.emitPendingCheck();
        return out;
      }
      case "neg":
      case "plus": {
        const sym = e.op === "neg" ? "scr_jsval_neg" : "scr_jsval_plus";
        this.declare(`declare ptr @${sym}(ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @${sym}(ptr ${a(0)})`);
          return t;
        });
      }
      case "truthy":
      case "not": {
        this.declare(`declare i32 @scr_jsval_truthy(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call i32 @scr_jsval_truthy(ptr ${a(0)})`);
        const t = B.tmp();
        B.line(`${t} = icmp ${e.op === "truthy" ? "ne" : "eq"} i32 ${r}, 0`);
        return { name: t, type: e.type };
      }
      case "typeof": {
        this.declare(`declare ptr @scr_jsval_typeof(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_typeof(ptr ${a(0)})`);
        return this.own({ name: t, type: e.type });
      }
      case "toStr":
        this.declare(`declare ptr @scr_jsval_to_str(ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_to_str(ptr ${a(0)})`);
          return t;
        });
      case "getProp":
        this.declare(`declare ptr @scr_jsval_get_prop(ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_get_prop(ptr ${a(0)}, ptr ${nameSym()})`);
          return t;
        });
      case "globalGet":
        this.declare(`declare ptr @scr_jsval_global_get(ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_global_get(ptr ${nameSym()})`);
          return t;
        });
      case "setProp": {
        this.declare(`declare i32 @scr_jsval_set_prop(ptr, ptr, ptr)`);
        B.line(`${B.tmp()} = call i32 @scr_jsval_set_prop(ptr ${a(0)}, ptr ${nameSym()}, ptr ${a(1)})`);
        this.emitPendingCheck();
        return { name: "", type: e.type };
      }
      case "getIdx":
        this.declare(`declare ptr @scr_jsval_get_idx(ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_get_idx(ptr ${a(0)}, ptr ${a(1)})`);
          return t;
        });
      case "iterNew":
        this.declare(`declare ptr @scr_jsval_iter_new(ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_iter_new(ptr ${a(0)})`);
          return t;
        });
      case "setIdx": {
        this.declare(`declare i32 @scr_jsval_set_idx(ptr, ptr, ptr)`);
        B.line(`${B.tmp()} = call i32 @scr_jsval_set_idx(ptr ${a(0)}, ptr ${a(1)}, ptr ${a(2)})`);
        this.emitPendingCheck();
        return { name: "", type: e.type };
      }
      case "callMethod": {
        const pack = argPack(args.slice(1).map((x) => x.name));
        this.declare(`declare ptr @scr_jsval_call_method(ptr, ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_call_method(ptr ${a(0)}, ptr ${nameSym()}, i32 ${args.length - 1}, ptr ${pack})`);
          return t;
        });
      }
      case "optCallMethod": {
        const pack = argPack(args.slice(1).map((x) => x.name));
        this.declare(`declare ptr @scr_jsval_opt_call_method(ptr, ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_opt_call_method(ptr ${a(0)}, ptr ${nameSym()}, i32 ${args.length - 1}, ptr ${pack})`);
          return t;
        });
      }
      case "callFn": {
        const pack = argPack(args.slice(1).map((x) => x.name));
        this.declare(`declare ptr @scr_jsval_call(ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_call(ptr ${a(0)}, i32 ${args.length - 1}, ptr ${pack})`);
          return t;
        });
      }
      case "callFnThis": {
        const pack = argPack(args.slice(2).map((x) => x.name));
        this.declare(`declare ptr @scr_jsval_call_this(ptr, ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_call_this(ptr ${a(0)}, ptr ${a(1)}, i32 ${args.length - 2}, ptr ${pack})`);
          return t;
        });
      }
      case "callSpread": {
        // Spread application (`f(...pre, ...s)`): the prelude helper's
        // real spread syntax — iterator protocols are the engine's own,
        // the guards front-run V8's spread-call TypeError texts (the name
        // literal is the spread expression's spelling).
        this.declare(`declare ptr @scr_jsval_call_spread(ptr, ptr, ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_call_spread(ptr ${a(0)}, ptr ${a(1)}, ptr ${a(2)}, ptr ${nameSym()})`);
          return t;
        });
      }
      case "construct": {
        const pack = argPack(args.slice(1).map((x) => x.name));
        this.declare(`declare ptr @scr_jsval_construct(ptr, i32, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_construct(ptr ${a(0)}, i32 ${args.length - 1}, ptr ${pack})`);
          return t;
        });
      }
      case "objLit": {
        const pack = argPack(args.map((x) => x.name));
        this.declare(`declare ptr @scr_jsval_obj_lit(i32, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_obj_lit(i32 ${args.length / 2}, ptr ${pack})`);
        return this.own({ name: t, type: e.type });
      }
      case "tplStrings": {
        const pack = argPack(args.map((x) => x.name));
        this.declare(`declare ptr @scr_jsval_tpl_strings(i32, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_tpl_strings(i32 ${args.length / 2}, ptr ${pack})`);
        return this.own({ name: t, type: e.type });
      }
      case "objSpread": {
        this.declare(`declare ptr @scr_jsval_obj_spread(ptr, ptr)`);
        return fallible(() => {
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_obj_spread(ptr ${a(0)}, ptr ${a(1)})`);
          return t;
        });
      }
      case "defineGetter": {
        // Getter completion for an island literal (the C emitter's
        // scr_jsval_define_getter shape): defines key a(1) on obj a(0)
        // as an engine getter invoking a(2); answers the object (+1).
        this.declare(`declare ptr @scr_jsval_define_getter(ptr, ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_define_getter(ptr ${a(0)}, ptr ${a(1)}, ptr ${a(2)})`);
        return this.own({ name: t, type: e.type });
      }
      case "arrLit": {
        const pack = argPack(args.map((x) => x.name));
        this.declare(`declare ptr @scr_jsval_arr_lit(i32, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_arr_lit(i32 ${args.length}, ptr ${pack})`);
        return this.own({ name: t, type: e.type });
      }
      case "instanceOf": {
        // JS_IsInstanceOf through the engine: 1 true, 0 false, -1 threw
        // (Symbol.hasInstance can raise) — the fallible pattern, result
        // narrowed to bool by comparing against 1 (the C emitter's shape).
        this.declare(`declare i32 @scr_jsval_instance_of(ptr, ptr)`);
        return fallible(() => {
          const r = B.tmp();
          B.line(`${r} = call i32 @scr_jsval_instance_of(ptr ${a(0)}, ptr ${a(1)})`);
          const t = B.tmp();
          B.line(`${t} = icmp eq i32 ${r}, 1`);
          return t;
        });
      }
      case "undefLit": {
        this.declare(`declare ptr @scr_jsval_undefined()`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_undefined()`);
        return this.own({ name: t, type: e.type });
      }
      case "nullLit": {
        this.declare(`declare ptr @scr_jsval_null()`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_null()`);
        return this.own({ name: t, type: e.type });
      }
      default:
        throw new Error(`llvm emitter bug: jsOp ${e.op satisfies never}`);
    }
  }

  /** Island → static validated exit: primitives extract STRICTLY (no
   * coercion); composites round-trip engine JSON.stringify → json.parse →
   * the existing dynCheck walker. Every step is a may-throw with the
   * standard pending discipline. */
  private emitJsExit(e: IrExpr & { kind: "jsExit" }): LlValue {
    const B = this.B;
    const v = this.emitExpr(e.value);
    switch (e.type.kind) {
      case "f64":
      case "bool": {
        const isF64 = e.type.kind === "f64";
        const sym = isF64 ? "scr_jsval_exit_f64" : "scr_jsval_exit_bool";
        this.declare(`declare i32 @${sym}(ptr, ptr)`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${isF64 ? "double" : "i8"}`);
        B.line(`store ${isF64 ? `double ${f64Lit(0)}` : "i8 0"}, ptr ${slot}`);
        B.line(`${B.tmp()} = call i32 @${sym}(ptr ${v.name}, ptr ${slot})`);
        this.emitPendingCheck();
        const t = B.tmp();
        if (isF64) {
          B.line(`${t} = load double, ptr ${slot}`);
          return { name: t, type: e.type };
        }
        B.line(`${t} = load i8, ptr ${slot}`);
        const b = B.tmp();
        B.line(`${b} = trunc i8 ${t} to i1`);
        return { name: b, type: e.type };
      }
      case "string": {
        this.declare(`declare ptr @scr_jsval_exit_str(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_exit_str(ptr ${v.name})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "bytes": {
        // Uint8Array exit: kind-checked, copied out (+1).
        this.declare(`declare ptr @scr_jsval_exit_bytes(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_exit_bytes(ptr ${v.name})`);
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      default: {
        // `any[]`-declared slot: Array.isArray-gated, elements BY
        // REFERENCE (identity crosses; the spine is a snapshot copy).
        // JSON-safe element types keep the round trip below.
        if (e.type.kind === "array" && e.type.elem.kind === "jsval") {
          this.declare(`declare ptr @scr_jsval_exit_jsval_arr(ptr)`);
          const t = B.tmp();
          B.line(`${t} = call ptr @scr_jsval_exit_jsval_arr(ptr ${v.name})`);
          const out = this.own({ name: t, type: e.type });
          this.emitPendingCheck();
          return out;
        }
        // An undefined-armed union target: the engine's undefined takes
        // the undefined arm FIRST (JSON cannot spell it); then null and
        // data ride the round trip into the union's dynCheck like any
        // composite.
        const roundTrip = (): string => {
          this.declare(`declare ptr @scr_jsval_to_json(ptr)`);
          this.declare(`declare ptr @scr_json_parse(ptr)`);
          const js = B.tmp();
          B.line(`${js} = call ptr @scr_jsval_to_json(ptr ${v.name})`);
          this.own({ name: js, type: STRING });
          this.emitPendingCheck();
          const dom = B.tmp();
          B.line(`${dom} = call ptr @scr_json_parse(ptr ${js})`);
          this.own({ name: dom, type: { kind: "dyn" } });
          this.emitPendingCheck();
          const helper = this.dyn.dynCheckHelper(e.type);
          const t = B.tmp();
          B.line(`${t} = call ${this.llType(e.type)} @${helper}(ptr ${dom}, ptr null)`);
          return t;
        };
        const undefTag = e.type.kind === "union" ? this.undefinedArmTag(e.type) : -1;
        if (e.type.kind === "union" && undefTag >= 0) {
          this.declare(`declare zeroext i1 @scr_jsval_is_undefined(ptr)`);
          const isU = B.tmp();
          B.line(`${isU} = call zeroext i1 @scr_jsval_is_undefined(ptr ${v.name})`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const lu = B.newLabel("jx.u");
          const ld = B.newLabel("jx.d");
          const lj = B.newLabel("jx.j");
          B.condBr(isU, lu, ld);
          B.startBlock(lu);
          B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(ld);
          this.frames.push([]);
          const unionDef = this.unionsById.get(e.type.unionId);
          const dataArms = unionDef ? unionDef.arms.flatMap((a, i) => (isUnitType(a) ? [] : [{ a, i }])) : [];
          const jsvalArr = dataArms.length === 1 && dataArms[0]!.a.kind === "array" && dataArms[0]!.a.elem.kind === "jsval" ? dataArms[0]! : null;
          let t: string;
          if (jsvalArr) {
            // The `any[] | undefined` defaulted-parameter spelling: the
            // engine array exits BY REFERENCE into the data arm.
            this.declare(`declare ptr @scr_jsval_exit_jsval_arr(ptr)`);
            this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
            this.declare(`declare ptr @scr_arr_retain_v(ptr)`);
            this.declare(`declare void @scr_arr_release_v(ptr)`);
            const arr = B.tmp();
            B.line(`${arr} = call ptr @scr_jsval_exit_jsval_arr(ptr ${v.name})`);
            this.emitPendingCheck();
            t = B.tmp();
            B.line(`${t} = call ptr @scr_union_new_ref(i32 ${jsvalArr.i}, ptr ${arr}, ptr @scr_arr_retain_v, ptr @scr_arr_release_v, ptr null)`);
            B.line(`store ptr ${t}, ptr ${slot}`);
          } else {
            t = roundTrip();
            this.own({ name: t, type: e.type });
            this.emitPendingCheck();
            this.moveTemp({ name: t, type: e.type });
            B.line(`store ptr ${t}, ptr ${slot}`);
          }
          this.releaseFrame(this.frames.pop()!);
          B.br(lj);
          B.startBlock(lj);
          const out = B.tmp();
          B.line(`${out} = load ptr, ptr ${slot}`);
          return this.own({ name: out, type: e.type });
        }
        const t = roundTrip();
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
    }
  }

  /** The host-call adapter for closures of a given (arity, return kind) —
   * emit-island.ts's islandAdapter: argv cells are BORROWED by the
   * wrapper; the closure ABI consumes (+1) each param, so the adapter
   * retains them in. A jsval-returning closure's +1 result passes
   * straight through; primitive returns marshal back by value; void
   * closures return NULL (the wrapper turns that into `undefined`). */
  private islandAdapter(arity: number, retKind: "void" | "jsval" | "f64" | "bool" | "string"): string {
    const tag = { void: "v", jsval: "j", f64: "f", bool: "b", string: "s" }[retKind];
    const key = `ia:${arity}:${tag}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_ia_${arity}${tag}`;
    this.resolveThunks.set(key, sym);
    this.declare(`declare ptr @scr_jsval_retain_v(ptr)`);
    const d: string[] = [
      `define internal ptr @${sym}(ptr %c, ptr %argv) ${FN_ATTRS} { ; island host-call adapter (${arity} arg${arity === 1 ? "" : "s"}, ${retKind})`,
      `entry:`,
    ];
    const passed: string[] = ["ptr %c"];
    for (let i = 0; i < arity; i++) {
      d.push(
        `  %ap${i} = getelementptr inbounds ptr, ptr %argv, i64 ${i}`,
        `  %av${i} = load ptr, ptr %ap${i}`,
        `  %ar${i} = call ptr @scr_jsval_retain_v(ptr %av${i})`,
      );
      passed.push(`ptr %ar${i}`);
    }
    d.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %c, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    switch (retKind) {
      case "void":
        d.push(`  call void %fn(${passed.join(", ")})`, `  ret ptr null`);
        break;
      case "jsval":
        d.push(`  %r = call ptr %fn(${passed.join(", ")})`, `  ret ptr %r`);
        break;
      case "f64":
        this.declare(`declare ptr @scr_jsval_from_f64(double)`);
        d.push(
          `  %r = call double %fn(${passed.join(", ")})`,
          `  %j = call ptr @scr_jsval_from_f64(double %r)`,
          `  ret ptr %j`,
        );
        break;
      case "bool":
        this.declare(`declare ptr @scr_jsval_from_bool(i1 zeroext)`);
        d.push(
          `  %r = call i1 %fn(${passed.join(", ")})`,
          `  %j = call ptr @scr_jsval_from_bool(i1 %r)`,
          `  ret ptr %j`,
        );
        break;
      case "string":
        // The closure's +1 string marshals in, then releases. NULL is the
        // throw-path dummy — the wrapper reverse-bridges the pending
        // exception.
        this.declare(`declare ptr @scr_jsval_from_str(ptr)`);
        this.declare(`declare void @scr_str_release(ptr)`);
        d.push(
          `  %r = call ptr %fn(${passed.join(", ")})`,
          `  %isnull = icmp eq ptr %r, null`,
          `  br i1 %isnull, label %bad, label %ok`,
          `bad:`,
          `  ret ptr null`,
          `ok:`,
          `  %j = call ptr @scr_jsval_from_str(ptr %r)`,
          `  call void @scr_str_release(ptr %r)`,
          `  ret ptr %j`,
        );
        break;
    }
    d.push(`}`, ``);
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** The host-call adapter for a closure with TYPED parameters — emit-
   * island.ts's islandTypedAdapter: each BORROWED argv cell converts to
   * its param's static type through the EXISTING exit machinery (strict
   * primitive exits, JSON round-trip composites via the dynCheck walker,
   * a `T | undefined` param taking the interned undefined arm when the
   * argument is absent or undefined, jsval params passing through as
   * retained handles). A conversion failure releases what was already
   * built and returns NULL with the exception pending — the wrapper
   * reverse-bridges it. Converted params are CONSUMED by the closure ABI. */
  private islandTypedAdapter(fn: IrType & { kind: "func" }): string {
    const ret = islandCallbackRet(fn.ret, (id) => this.recordsById.get(id), (id) => this.unionsById.get(id));
    if (!ret) throw new Error("llvm emitter bug: typed island adapter with unsupported return");
    const key = `ita:${fn.params.map((p) => typeKey(p)).join(",")}=>${ret.async ? "P:" : ""}${ret.tag}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_ita_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const d: string[] = [
      `define internal ptr @${sym}(ptr %c, ptr %argv) ${FN_ATTRS} { ; typed island host-call adapter: ${key}`,
      `entry:`,
    ];
    // One slot per param: scalars hold the converted value; refs start
    // NULL so the convfail path can release NULL-tolerantly. Unit-arm
    // instances are immortal — their release is a no-op.
    const slotTy: string[] = [];
    fn.params.forEach((p, i) => {
      const ty = this.llType(p);
      const st = ty === "double" ? "double" : ty === "i1" ? "i8" : "ptr";
      slotTy.push(st);
      d.push(`  %sl${i} = alloca ${st}`);
      d.push(`  store ${st} ${st === "double" ? f64Lit(0) : st === "i8" ? "0" : "null"}, ptr %sl${i}`);
    });
    let canFail = false;
    const cleanup: string[] = [];
    fn.params.forEach((p, i) => {
      if (isRefCounted(p)) {
        cleanup.push(
          `  %cf${i} = load ptr, ptr %sl${i}`,
          `  call void ${releaseSym(this, p)}(ptr %cf${i})`,
        );
      }
    });
    let blk = 0;
    const failCheckPtr = (val: string): void => {
      // NULL result → convfail.
      canFail = true;
      const b = blk++;
      d.push(
        `  %cn${b} = icmp eq ptr ${val}, null`,
        `  br i1 %cn${b}, label %convfail, label %cont${b}`,
        `cont${b}:`,
      );
    };
    this.declare(`declare zeroext i1 @scr_exc_pending()`);
    fn.params.forEach((p, i) => {
      d.push(`  %ap${i} = getelementptr inbounds ptr, ptr %argv, i64 ${i}`, `  %av${i} = load ptr, ptr %ap${i}`);
      switch (p.kind) {
        case "jsval":
          this.declare(`declare ptr @scr_jsval_retain_v(ptr)`);
          d.push(`  %jr${i} = call ptr @scr_jsval_retain_v(ptr %av${i})`, `  store ptr %jr${i}, ptr %sl${i}`);
          break;
        case "f64": {
          canFail = true;
          this.declare(`declare i32 @scr_jsval_exit_f64(ptr, ptr)`);
          const b = blk++;
          d.push(
            `  %fx${i} = call i32 @scr_jsval_exit_f64(ptr %av${i}, ptr %sl${i})`,
            `  %fk${i} = icmp eq i32 %fx${i}, 0`,
            `  br i1 %fk${i}, label %convfail, label %cont${b}`,
            `cont${b}:`,
          );
          break;
        }
        case "bool": {
          canFail = true;
          this.declare(`declare i32 @scr_jsval_exit_bool(ptr, ptr)`);
          const b = blk++;
          d.push(
            `  %bx${i} = call i32 @scr_jsval_exit_bool(ptr %av${i}, ptr %sl${i})`,
            `  %bk${i} = icmp eq i32 %bx${i}, 0`,
            `  br i1 %bk${i}, label %convfail, label %cont${b}`,
            `cont${b}:`,
          );
          break;
        }
        case "string": {
          this.declare(`declare ptr @scr_jsval_exit_str(ptr)`);
          d.push(`  %sx${i} = call ptr @scr_jsval_exit_str(ptr %av${i})`);
          failCheckPtr(`%sx${i}`);
          d.push(`  store ptr %sx${i}, ptr %sl${i}`);
          break;
        }
        default: {
          // Composite (record/array/union): the jsExit pipeline — engine
          // JSON.stringify, json.parse, the interned dynCheck builder.
          canFail = true;
          this.declare(`declare ptr @scr_jsval_to_json(ptr)`);
          this.declare(`declare ptr @scr_json_parse(ptr)`);
          this.declare(`declare void @scr_str_release(ptr)`);
          this.declare(`declare void @scr_dyn_release(ptr)`);
          const utag = p.kind === "union" ? this.undefinedArmTag(p) : -1;
          const b = blk++;
          if (p.kind === "union" && utag >= 0) {
            this.declare(`declare zeroext i1 @scr_jsval_is_undefined(ptr)`);
            d.push(
              `  %iu${i} = call zeroext i1 @scr_jsval_is_undefined(ptr %av${i})`,
              `  br i1 %iu${i}, label %undef${b}, label %conv${b}`,
              `undef${b}:`,
              `  store ptr ${this.unitInstanceRef(p.unionId, utag)}, ptr %sl${i} ; absent/undefined argument -> the undefined arm`,
              `  br label %cont${b}`,
              `conv${b}:`,
            );
          }
          d.push(`  %tj${i} = call ptr @scr_jsval_to_json(ptr %av${i})`);
          const b2 = blk++;
          d.push(
            `  %tjn${i} = icmp eq ptr %tj${i}, null`,
            `  br i1 %tjn${i}, label %convfail, label %cont${b2}`,
            `cont${b2}:`,
            `  %dp${i} = call ptr @scr_json_parse(ptr %tj${i})`,
            `  call void @scr_str_release(ptr %tj${i})`,
          );
          const b3 = blk++;
          d.push(
            `  %dpn${i} = icmp eq ptr %dp${i}, null`,
            `  br i1 %dpn${i}, label %convfail, label %cont${b3}`,
            `cont${b3}:`,
            `  %cv${i} = call ${this.llType(p)} @${this.dyn.dynCheckHelper(p)}(ptr %dp${i}, ptr null)`,
            `  call void @scr_dyn_release(ptr %dp${i})`,
            `  %pe${i} = call zeroext i1 @scr_exc_pending()`,
          );
          const b4 = blk++;
          d.push(
            `  br i1 %pe${i}, label %convfail, label %cont${b4}`,
            `cont${b4}:`,
            `  store ${this.llType(p)} %cv${i}, ptr %sl${i}`,
          );
          if (p.kind === "union" && utag >= 0) d.push(`  br label %cont${b}`, `cont${b}:`);
        }
      }
    });
    // The call over the converted slots (each moves into the callee).
    const passed = ["ptr %c"];
    fn.params.forEach((p, i) => {
      const ty = this.llType(p);
      if (ty === "i1") {
        d.push(`  %ld${i} = load i8, ptr %sl${i}`, `  %lb${i} = trunc i8 %ld${i} to i1`);
        passed.push(`i1 %lb${i}`);
      } else {
        d.push(`  %ld${i} = load ${ty}, ptr %sl${i}`);
        passed.push(`${ty} %ld${i}`);
      }
    });
    d.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %c, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    if (ret.async) {
      // The closure returns a +1 ScrPromise; from_promise takes ownership.
      const tagN = { void: 0, f64: 1, bool: 2, string: 3, jsval: 4, json: 0, dyn: 0 }[ret.tag];
      this.declare(`declare ptr @scr_jsval_from_promise(ptr, i32)`);
      d.push(
        `  %pr = call ptr %fn(${passed.join(", ")})`,
        `  %prn = icmp eq ptr %pr, null`,
        `  br i1 %prn, label %pnull, label %pok`,
        `pnull:`,
        `  ret ptr null`,
        `pok:`,
        `  %pj = call ptr @scr_jsval_from_promise(ptr %pr, i32 ${tagN})`,
        `  ret ptr %pj`,
      );
    } else {
      switch (ret.tag) {
        case "void":
          d.push(`  call void %fn(${passed.join(", ")})`, `  ret ptr null`);
          break;
        case "jsval":
          d.push(`  %r = call ptr %fn(${passed.join(", ")})`, `  ret ptr %r`);
          break;
        case "f64":
          this.declare(`declare ptr @scr_jsval_from_f64(double)`);
          d.push(
            `  %r = call double %fn(${passed.join(", ")})`,
            `  %j = call ptr @scr_jsval_from_f64(double %r)`,
            `  ret ptr %j`,
          );
          break;
        case "bool":
          this.declare(`declare ptr @scr_jsval_from_bool(i1 zeroext)`);
          d.push(
            `  %r = call i1 %fn(${passed.join(", ")})`,
            `  %j = call ptr @scr_jsval_from_bool(i1 %r)`,
            `  ret ptr %j`,
          );
          break;
        case "string":
          this.declare(`declare ptr @scr_jsval_from_str(ptr)`);
          this.declare(`declare void @scr_str_release(ptr)`);
          d.push(
            `  %r = call ptr %fn(${passed.join(", ")})`,
            `  %rn = icmp eq ptr %r, null`,
            `  br i1 %rn, label %snull, label %sok`,
            `snull:`,
            `  ret ptr null`,
            `sok:`,
            `  %j = call ptr @scr_jsval_from_str(ptr %r)`,
            `  call void @scr_str_release(ptr %r)`,
            `  ret ptr %j`,
          );
          break;
        case "dyn":
          // A checked-dynamic (+1 dyn) result: deep copy into the engine
          // (the jsMarshal dyn rule); NULL is the throw-path dummy.
          this.declare(`declare ptr @scr_jsval_from_dyn(ptr)`);
          this.declare(`declare void @scr_dyn_release(ptr)`);
          d.push(
            `  %r = call ptr %fn(${passed.join(", ")})`,
            `  %rn = icmp eq ptr %r, null`,
            `  br i1 %rn, label %dnull, label %dok`,
            `dnull:`,
            `  ret ptr null`,
            `dok:`,
            `  %j = call ptr @scr_jsval_from_dyn(ptr %r)`,
            `  call void @scr_dyn_release(ptr %r)`,
            `  ret ptr %j`,
          );
          break;
        case "json": {
          // A JSON-safe composite return: the jsMarshal path — the type-
          // directed serializer, then the engine's JSON parser (deep
          // copy). NULL result is the throw-path dummy.
          const helper = this.walkers.jsonWriteHelper(fn.ret);
          this.declare(`declare void @scr_jb_init(ptr)`);
          this.declare(`declare ptr @scr_jb_finish(ptr)`);
          this.declare(`declare ptr @scr_jsval_from_json(ptr)`);
          this.declare(`declare void @scr_str_release(ptr)`);
          d.push(
            `  %jbuf = alloca %ScrJsonBuf`,
            `  %rv = call ${this.llType(fn.ret)} %fn(${passed.join(", ")})`,
            `  %rpend = call zeroext i1 @scr_exc_pending()`,
            `  br i1 %rpend, label %jfail, label %jok`,
            `jfail:`,
            ...(isRefCounted(fn.ret) ? [`  call void ${releaseSym(this, fn.ret)}(${this.llType(fn.ret)} %rv)`] : []),
            `  ret ptr null`,
            `jok:`,
            `  call void @scr_jb_init(ptr %jbuf)`,
            `  call void @${helper}(ptr %jbuf, ${this.llType(fn.ret)} %rv)`,
            ...(isRefCounted(fn.ret) ? [`  call void ${releaseSym(this, fn.ret)}(${this.llType(fn.ret)} %rv)`] : []),
            `  %rj = call ptr @scr_jb_finish(ptr %jbuf)`,
            `  %j = call ptr @scr_jsval_from_json(ptr %rj)`,
            `  call void @scr_str_release(ptr %rj)`,
            `  ret ptr %j`,
          );
          break;
        }
      }
    }
    if (canFail) {
      d.push(
        `convfail:`,
        // Params already converted release here (NULL-tolerant; unit-arm
        // instances are immortal — their release is a no-op). The pending
        // TypeError reverse-bridges in the wrapper.
        ...cleanup,
        `  ret ptr null`,
      );
    }
    d.push(`}`, ``);
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** Loads a dyn node's kind tag after its size_t RC word — the dyn expression tests'
   * shared read. */
  private dynKind(d: string): string {
    const B = this.B;
    const p = B.tmp();
    const k = B.tmp();
    B.line(`${p} = getelementptr inbounds i8, ptr ${d}, i64 ${this.sizeType === "i32" ? 4 : 8} ; ->kind`);
    B.line(`${k} = load i32, ptr ${p}`);
    return k;
  }

  /** Interned Promise.race fulfillment adapter — emit-async.ts's
   * raceAdapterFor: converts a settled entry's payload (inner `from`)
   * into the result promise's inner type `to` and fulfills the
   * destination. Identical types share the runtime's raw copy; a plain
   * entry under a union result wraps into its arm; a sub-union entry
   * re-tags arm-wise. Rejections never reach adapters. */
  private raceAdapterFor(from: IrType, to: IrType): string {
    if (typeEquals(from, to)) {
      this.declare(`declare void @scr_promise_adapt_copy(ptr, ptr)`);
      return "scr_promise_adapt_copy";
    }
    const key = `race:${typeKey(from)}=>${typeKey(to)}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_race_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    if (to.kind !== "union") throw new Error("llvm emitter bug: race adapter to a non-union");
    const toDef = this.unionsById.get(to.unionId);
    if (!toDef) throw new Error("llvm emitter bug: race adapter to an unknown union");
    const tagOf = (t: IrType): number => {
      const tag = toDef.arms.findIndex((a) => typeEquals(a, t));
      if (tag < 0) throw new Error("llvm emitter bug: race adapter arm missing (frontend must fence)");
      return tag;
    };
    const rv = vAdapters(this, to);
    this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
    const fulfill = (value: string): string =>
      `call void @scr_promise_fulfill_ref(ptr %dst, ptr ${value}, ptr ${rv.retain}, ptr ${rv.release}, ptr ${traceArg(this, to)})`;
    const d: string[] = [
      `define internal void @${sym}(ptr %dst, ptr %src) ${FN_ATTRS} { ; race ${key}`,
      `entry:`,
    ];
    if (from.kind !== "union") {
      // One arm wrap, straight off the payload accessors.
      const tag = tagOf(from);
      if (from.kind === "f64") {
        this.declare(`declare double @scr_promise_payload_f64(ptr)`);
        this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
        d.push(`  %x = call double @scr_promise_payload_f64(ptr %src)`, `  %u = call ptr @scr_union_new_f64(i32 ${tag}, double %x)`);
      } else if (from.kind === "bool") {
        this.declare(`declare zeroext i1 @scr_promise_payload_bool(ptr)`);
        this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
        d.push(`  %x = call zeroext i1 @scr_promise_payload_bool(ptr %src)`, `  %u = call ptr @scr_union_new_bool(i32 ${tag}, i1 %x)`);
      } else if (from.kind === "string") {
        this.declare(`declare ptr @scr_promise_payload_str(ptr)`);
        this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
        d.push(
          `  %x = call ptr @scr_promise_payload_str(ptr %src)`,
          `  %u = call ptr @scr_union_new_ref(i32 ${tag}, ptr %x, ptr @scr_str_retain_v, ptr @scr_str_release_v, ptr null)`,
        );
        this.declare(`declare ptr @scr_str_retain_v(ptr)`);
        this.declare(`declare void @scr_str_release_v(ptr)`);
      } else {
        const fv = vAdapters(this, from);
        this.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
        this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
        d.push(
          `  %x = call ptr @scr_promise_payload_ref(ptr %src)`,
          `  %u = call ptr @scr_union_new_ref(i32 ${tag}, ptr %x, ptr ${fv.retain}, ptr ${fv.release}, ptr ${traceArg(this, from)})`,
        );
      }
      d.push(`  ${fulfill("%u")}`, `  ret void`, `}`, ``);
      this.resolveThunkDefs.push(...d);
      return sym;
    }
    // Sub-union re-tag: switch over the entry's arms, rebuild under the
    // result's tags (payloads retained through each arm's own adapters).
    const fromDef = this.unionsById.get(from.unionId);
    if (!fromDef) throw new Error("llvm emitter bug: race adapter from an unknown union");
    this.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
    this.declare(`declare void @scr_union_release(ptr)`);
    d.push(
      `  %u0 = call ptr @scr_promise_payload_ref(ptr %src)`,
      `  %tagp = getelementptr inbounds %ScrUnion, ptr %u0, i64 0, i32 1`,
      `  %tag = load i32, ptr %tagp`,
      `  %slot = alloca ptr`,
      `  switch i32 %tag, label %bad [ ${fromDef.arms.map((_, i) => `i32 ${i}, label %a${i}`).join(" ")} ]`,
    );
    fromDef.arms.forEach((arm, i) => {
      d.push(`a${i}:`);
      const tag = tagOf(arm);
      if (isUnitType(arm)) {
        d.push(`  store ptr ${this.unitInstanceRef(to.unionId, tag)}, ptr %slot`, `  br label %join`);
      } else if (arm.kind === "f64") {
        this.declare(`declare double @scr_union_get_f64(ptr)`);
        this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
        d.push(
          `  %x${i} = call double @scr_union_get_f64(ptr %u0)`,
          `  %v${i} = call ptr @scr_union_new_f64(i32 ${tag}, double %x${i})`,
          `  store ptr %v${i}, ptr %slot`,
          `  br label %join`,
        );
      } else if (arm.kind === "bool") {
        this.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
        this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
        d.push(
          `  %x${i} = call zeroext i1 @scr_union_get_bool(ptr %u0)`,
          `  %v${i} = call ptr @scr_union_new_bool(i32 ${tag}, i1 %x${i})`,
          `  store ptr %v${i}, ptr %slot`,
          `  br label %join`,
        );
      } else {
        const av = vAdapters(this, arm);
        this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
        d.push(
          `  %pp${i} = getelementptr inbounds %ScrUnion, ptr %u0, i64 0, i32 5`,
          `  %p${i} = load ptr, ptr %pp${i}`,
          `  %r${i} = call ptr ${av.retain}(ptr %p${i})`,
          `  %v${i} = call ptr @scr_union_new_ref(i32 ${tag}, ptr %r${i}, ptr ${av.retain}, ptr ${av.release}, ptr ${traceArg(this, arm)})`,
          `  store ptr %v${i}, ptr %slot`,
          `  br label %join`,
        );
      }
    });
    d.push(
      `bad:`,
      `  store ptr null, ptr %slot`,
      `  br label %join`,
      `join:`,
      `  call void @scr_union_release(ptr %u0)`,
      `  %v = load ptr, ptr %slot`,
      `  ${fulfill("%v")}`,
      `  ret void`,
      `}`,
      ``,
    );
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** Interned generator-resume result builder — emit-async.ts's
   * genResultThunkFor: reads the post-resume state of a generator into a
   * fresh IteratorResult record `{ done, value }`. While suspended, the
   * yielded value moves out of the OUT slot into its arm of V (retagging
   * arm-wise into a superset V); once done, a present completion value
   * wraps the same way and an empty OUT is JS's undefined. */
  private genResultThunkFor(genT: IrType & { kind: "generator" }, recT: IrType & { kind: "record" }): string {
    const key = `gr:${typeKey(genT)}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = mangleGenResThunk(this.resolveThunks.size);
    this.resolveThunks.set(key, sym);
    const shape = this.recordsById.get(recT.shapeId);
    const valueT = shape?.fields.find((f) => f.name === "value")?.type;
    if (!shape || !valueT) throw new Error("llvm emitter bug: genResume record lacks its value field");
    if (valueT.kind === "dyn") {
      // The any/unknown channel: OUT holds a dyn (or nothing — undefined).
      const doneIdxD = shape.fields.findIndex((f) => f.name === "done");
      const valueIdxD = shape.fields.findIndex((f) => f.name === "value");
      if (doneIdxD < 0 || valueIdxD < 0) throw new Error("llvm emitter bug: genResume record shape");
      this.declare(`declare zeroext i1 @scr_gen_done(ptr)`);
      this.declare(`declare zeroext i1 @scr_gen_out_has(ptr)`);
      this.declare(`declare ptr @scr_gen_take_out_ref(ptr)`);
      this.declare(`declare ptr @scr_dyn_undefined()`);
      this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
      this.resolveThunkDefs.push(
        `define internal ptr @${sym}(ptr %g) ${FN_ATTRS} { ; IteratorResult<${typeKey(genT)}> (dyn channel)`,
        `entry:`,
        `  %r = call ptr @${mangleRecordNew(recT.shapeId)}()`,
        `  %d = call zeroext i1 @scr_gen_done(ptr %g)`,
        `  %dz = zext i1 %d to i8`,
        `  %dp = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr %r, i64 0, i32 ${doneIdxD + 1}`,
        `  store i8 %dz, ptr %dp`,
        `  %has = call zeroext i1 @scr_gen_out_has(ptr %g)`,
        `  br i1 %has, label %take, label %undefv`,
        `take:`,
        `  %v0 = call ptr @scr_gen_take_out_ref(ptr %g)`,
        `  br label %join`,
        `undefv:`,
        `  %u = call ptr @scr_dyn_undefined()`,
        `  %v1 = call ptr @scr_dyn_retain_v(ptr %u)`,
        `  br label %join`,
        `join:`,
        `  %v = phi ptr [ %v0, %take ], [ %v1, %undefv ]`,
        `  %vp = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr %r, i64 0, i32 ${valueIdxD + 1}`,
        `  store ptr %v, ptr %vp`,
        `  ret ptr %r`,
        `}`,
        ``,
      );
      return sym;
    }
    if (valueT.kind !== "union") throw new LlvmUnsupportedError(`genResume:${valueT.kind}`);
    const def = this.unionsById.get(valueT.unionId);
    if (!def) throw new Error("llvm emitter bug: genResume value union unknown");
    const tagOf = (t: IrType): number => {
      const tag = def.arms.findIndex((a) => typeEquals(a, t));
      if (tag < 0) throw new Error("llvm emitter bug: genResume value union lacks an arm");
      return tag;
    };
    const undefTag = def.arms.findIndex((a) => a.kind === "undefinedT");
    if (undefTag < 0) throw new Error("llvm emitter bug: genResume value union lacks undefined");
    const doneIdx = shape.fields.findIndex((f) => f.name === "done");
    const valueIdx = shape.fields.findIndex((f) => f.name === "value");
    if (doneIdx < 0 || valueIdx < 0) throw new Error("llvm emitter bug: genResume record shape");
    this.declare(`declare zeroext i1 @scr_gen_done(ptr)`);
    this.declare(`declare zeroext i1 @scr_gen_out_has(ptr)`);
    const d: string[] = [
      `define internal ptr @${sym}(ptr %g) ${FN_ATTRS} { ; IteratorResult<${typeKey(genT)}>`,
      `entry:`,
      `  %vslot = alloca ptr`,
      `  %r = call ptr @${mangleRecordNew(recT.shapeId)}()`,
      `  %d = call zeroext i1 @scr_gen_done(ptr %g)`,
      `  %dz = zext i1 %d to i8`,
      `  %dp = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr %r, i64 0, i32 ${doneIdx + 1}`,
      `  store i8 %dz, ptr %dp`,
      `  br i1 %d, label %doneb, label %susp`,
    ];
    const undefRef = this.unitInstanceRef(valueT.unionId, undefTag);
    // Lines that store the wrapped OUT value into %vslot and br %join,
    // taking OUT's payload — one copy per branch, prefix-unique temps.
    const wrapFrom = (srcT: IrType, px: string): string[] => {
      if (srcT.kind === "void") {
        // A channel that can never carry a value (TS `never` yields /
        // void returns): the undefined arm keeps the IR total.
        return [`  store ptr ${undefRef}, ptr %vslot`, `  br label %join`];
      }
      if (srcT.kind === "f64") {
        this.declare(`declare double @scr_gen_take_out_f64(ptr)`);
        this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
        return [
          `  %${px}x = call double @scr_gen_take_out_f64(ptr %g)`,
          `  %${px}u = call ptr @scr_union_new_f64(i32 ${tagOf(srcT)}, double %${px}x)`,
          `  store ptr %${px}u, ptr %vslot`,
          `  br label %join`,
        ];
      }
      if (srcT.kind === "bool") {
        this.declare(`declare zeroext i1 @scr_gen_take_out_bool(ptr)`);
        this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
        return [
          `  %${px}x = call zeroext i1 @scr_gen_take_out_bool(ptr %g)`,
          `  %${px}u = call ptr @scr_union_new_bool(i32 ${tagOf(srcT)}, i1 %${px}x)`,
          `  store ptr %${px}u, ptr %vslot`,
          `  br label %join`,
        ];
      }
      this.declare(`declare ptr @scr_gen_take_out_ref(ptr)`);
      if (srcT.kind !== "union") {
        const v = vAdapters(this, srcT);
        this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
        return [
          `  %${px}x = call ptr @scr_gen_take_out_ref(ptr %g)`,
          `  %${px}u = call ptr @scr_union_new_ref(i32 ${tagOf(srcT)}, ptr %${px}x, ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(this, srcT)})`,
          `  store ptr %${px}u, ptr %vslot`,
          `  br label %join`,
        ];
      }
      // A union channel: OUT holds the union box itself. Identical V
      // passes through; a superset V retags arm-wise.
      if (typeEquals(srcT, valueT)) {
        return [
          `  %${px}u = call ptr @scr_gen_take_out_ref(ptr %g)`,
          `  store ptr %${px}u, ptr %vslot`,
          `  br label %join`,
        ];
      }
      const srcDef = this.unionsById.get(srcT.unionId);
      if (!srcDef) throw new Error("llvm emitter bug: genResume channel union unknown");
      this.declare(`declare void @scr_union_release(ptr)`);
      const lines: string[] = [
        `  %${px}u0 = call ptr @scr_gen_take_out_ref(ptr %g)`,
        `  %${px}tp = getelementptr inbounds %ScrUnion, ptr %${px}u0, i64 0, i32 1`,
        `  %${px}t = load i32, ptr %${px}tp`,
        `  switch i32 %${px}t, label %${px}bad [ ${srcDef.arms.map((_, i) => `i32 ${i}, label %${px}a${i}`).join(" ")} ]`,
      ];
      srcDef.arms.forEach((arm, i) => {
        lines.push(`${px}a${i}:`);
        const tag = tagOf(arm);
        if (isUnitType(arm)) {
          lines.push(`  store ptr ${this.unitInstanceRef(valueT.unionId, tag)}, ptr %vslot`);
        } else if (arm.kind === "f64") {
          this.declare(`declare double @scr_union_get_f64(ptr)`);
          this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
          lines.push(
            `  %${px}x${i} = call double @scr_union_get_f64(ptr %${px}u0)`,
            `  %${px}v${i} = call ptr @scr_union_new_f64(i32 ${tag}, double %${px}x${i})`,
            `  store ptr %${px}v${i}, ptr %vslot`,
          );
        } else if (arm.kind === "bool") {
          this.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
          this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
          lines.push(
            `  %${px}x${i} = call zeroext i1 @scr_union_get_bool(ptr %${px}u0)`,
            `  %${px}v${i} = call ptr @scr_union_new_bool(i32 ${tag}, i1 %${px}x${i})`,
            `  store ptr %${px}v${i}, ptr %vslot`,
          );
        } else {
          const av = vAdapters(this, arm);
          this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
          lines.push(
            `  %${px}pp${i} = getelementptr inbounds %ScrUnion, ptr %${px}u0, i64 0, i32 5`,
            `  %${px}p${i} = load ptr, ptr %${px}pp${i}`,
            `  %${px}r${i} = call ptr ${av.retain}(ptr %${px}p${i})`,
            `  %${px}v${i} = call ptr @scr_union_new_ref(i32 ${tag}, ptr %${px}r${i}, ptr ${av.retain}, ptr ${av.release}, ptr ${traceArg(this, arm)})`,
            `  store ptr %${px}v${i}, ptr %vslot`,
          );
        }
        lines.push(`  br label %${px}rel`);
      });
      lines.push(
        `${px}bad:`,
        `  store ptr ${undefRef}, ptr %vslot`,
        `  br label %${px}rel`,
        `${px}rel:`,
        `  call void @scr_union_release(ptr %${px}u0)`,
        `  br label %join`,
      );
      return lines;
    };
    d.push(`susp:`);
    d.push(...wrapFrom(genT.yieldT, "y"));
    d.push(
      `doneb:`,
      `  %has = call zeroext i1 @scr_gen_out_has(ptr %g)`,
      `  br i1 %has, label %retv, label %undefv`,
      `retv:`,
    );
    d.push(...wrapFrom(genT.retT, "c"));
    d.push(
      `undefv:`,
      `  store ptr ${undefRef}, ptr %vslot`,
      `  br label %join`,
      `join:`,
      `  %v = load ptr, ptr %vslot`,
      `  %vp = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr %r, i64 0, i32 ${valueIdx + 1}`,
      `  store ptr %v, ptr %vp`,
      `  ret ptr %r`,
      `}`,
      ``,
    );
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** Interned per-union child exit adapter — emit-async.ts's
   * childExitThunkFor: the runtime invokes adapter(cb, has_code, code,
   * signal_name); the adapter builds the `number | null` union value
   * (tags are program data) and calls the listener, which owns the union
   * param per the universal convention. */
  private childExitThunkFor(param: IrType): string {
    if (param.kind !== "union") throw new Error("llvm emitter bug: exit listener param not a union");
    const key = `cx:${param.unionId}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_cx_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const def = this.unionsById.get(param.unionId);
    const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
    const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
    if (f64Tag < 0 || nullTag < 0) throw new Error("llvm emitter bug: exit listener union lacks its arms");
    this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
    this.resolveThunkDefs.push(
      `define internal void @${sym}(ptr %cb, i1 zeroext %has, double %code, ptr %sig) ${FN_ATTRS} { ; child exit → ${param.unionId}`,
      `entry:`,
      `  %slot = alloca ptr`,
      `  br i1 %has, label %num, label %none`,
      `num:`,
      `  %u1 = call ptr @scr_union_new_f64(i32 ${f64Tag}, double %code)`,
      `  store ptr %u1, ptr %slot`,
      `  br label %go`,
      `none:`,
      `  store ptr ${this.unitInstanceRef(param.unionId, nullTag)}, ptr %slot`,
      `  br label %go`,
      `go:`,
      `  %u = load ptr, ptr %slot`,
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
      `  call void %fn(ptr %cb, ptr %u)`,
      `  ret void`,
      `}`,
      ``,
    );
    return sym;
  }

  /** The TWO-parameter exit adapter — Node's `(code, signal)` listener:
   * the code union as above plus the signal as its own `string | null`
   * union (a fresh string from the runtime's static signal name when a
   * signal killed the child, the null arm otherwise). */
  private childExitThunkFor2(codeParam: IrType, sigParam: IrType): string {
    if (codeParam.kind !== "union" || sigParam.kind !== "union") {
      throw new Error("llvm emitter bug: exit listener params not unions");
    }
    const key = `cx2:${codeParam.unionId}+${sigParam.unionId}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_cx_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const codeDef = this.unionsById.get(codeParam.unionId);
    const f64Tag = codeDef ? codeDef.arms.findIndex((a) => a.kind === "f64") : -1;
    const codeNullTag = codeDef ? codeDef.arms.findIndex((a) => a.kind === "nullT") : -1;
    const sigDef = this.unionsById.get(sigParam.unionId);
    const strTag = sigDef ? sigDef.arms.findIndex((a) => a.kind === "string") : -1;
    const sigNullTag = sigDef ? sigDef.arms.findIndex((a) => a.kind === "nullT") : -1;
    if (f64Tag < 0 || codeNullTag < 0 || strTag < 0 || sigNullTag < 0) {
      throw new Error("llvm emitter bug: exit listener unions lack their arms");
    }
    this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
    this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    this.declare(`declare ptr @scr_str_new(ptr, ${this.sizeType})`);
    this.declare(`declare ${this.sizeType} @strlen(ptr)`);
    this.declare(`declare ptr @scr_str_retain_v(ptr)`);
    this.declare(`declare void @scr_str_release_v(ptr)`);
    this.resolveThunkDefs.push(
      `define internal void @${sym}(ptr %cb, i1 zeroext %has, double %code, ptr %sig) ${FN_ATTRS} { ; child exit (code, signal)`,
      `entry:`,
      `  %uslot = alloca ptr`,
      `  %sslot = alloca ptr`,
      `  br i1 %has, label %num, label %nonum`,
      `num:`,
      `  %u1 = call ptr @scr_union_new_f64(i32 ${f64Tag}, double %code)`,
      `  store ptr %u1, ptr %uslot`,
      `  br label %sigq`,
      `nonum:`,
      `  store ptr ${this.unitInstanceRef(codeParam.unionId, codeNullTag)}, ptr %uslot`,
      `  br label %sigq`,
      `sigq:`,
      `  %hassig = icmp ne ptr %sig, null`,
      `  br i1 %hassig, label %sigs, label %signull`,
      `sigs:`,
      `  %len = call ${this.sizeType} @strlen(ptr %sig)`,
      `  %ss = call ptr @scr_str_new(ptr %sig, ${this.sizeType} %len)`,
      `  %su = call ptr @scr_union_new_ref(i32 ${strTag}, ptr %ss, ptr @scr_str_retain_v, ptr @scr_str_release_v, ptr null)`,
      `  store ptr %su, ptr %sslot`,
      `  br label %go`,
      `signull:`,
      `  store ptr ${this.unitInstanceRef(sigParam.unionId, sigNullTag)}, ptr %sslot`,
      `  br label %go`,
      `go:`,
      `  %u = load ptr, ptr %uslot`,
      `  %s = load ptr, ptr %sslot`,
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
      `  call void %fn(ptr %cb, ptr %u, ptr %s)`,
      `  ret void`,
      `}`,
      ``,
    );
    return sym;
  }

  /** Interned per-union child-stream data adapter — emit-async.ts's
   * childDataThunkFor: wraps a retained chunk at the union's Buffer arm
   * and calls the listener, which owns the union param. */
  private childDataThunkFor(param: IrType): string {
    if (param.kind !== "union") throw new Error("llvm emitter bug: stream data listener param not a union");
    const key = `cd:${param.unionId}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_cd_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const def = this.unionsById.get(param.unionId);
    const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
    if (bytesTag < 0) throw new Error("llvm emitter bug: stream data listener union lacks its Buffer arm");
    this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    this.declare(`declare ptr @scr_bytes_retain_v(ptr)`);
    this.declare(`declare void @scr_bytes_release_v(ptr)`);
    this.resolveThunkDefs.push(
      `define internal void @${sym}(ptr %cb, ptr %chunk) ${FN_ATTRS} { ; child 'data' → ${param.unionId}`,
      `entry:`,
      `  %r = call ptr @scr_bytes_retain_v(ptr %chunk)`,
      `  %u = call ptr @scr_union_new_ref(i32 ${bytesTag}, ptr %r, ptr @scr_bytes_retain_v, ptr @scr_bytes_release_v, ptr null)`,
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
      `  call void %fn(ptr %cb, ptr %u)`,
      `  ret void`,
      `}`,
      ``,
    );
    return sym;
  }

  /** The fixed-arity EventEmitter listener adapter for one listener func
   * type — emit-async.ts's emitterInvokeThunkFor, split across the C/LLVM
   * boundary: the runtime's matching scr_ee_inv_fixed{k} shim reads k
   * POINTER-SIZE slots off the emit tuple's va_list (textual LLVM IR
   * cannot va_arg portably) and calls this function behind the wrapper
   * closure's fn. It re-types each slot to the listener's declared
   * parameter (f64/bool scalars load from the emit site's stack slot,
   * refcounted values retain the direct pointer — the callee owns +1 per the
   * universal convention) and calls the ORIGINAL listener held by the
   * wrapper's one capture box. A non-void result is discarded (refcounted
   * ones released) — Node ignores listener return values. Interned per
   * func-type key. */
  private emitterFixedAdapter(cbT: IrType & { kind: "func" }): { fn: string; shim: string } {
    // SCR_EE_FIXED_MAX (scr_runtime.h): the registry's audited arity
    // ceiling — refuse past it rather than guess.
    if (cbT.params.length > 4) throw new LlvmUnsupportedError(`emitterListenerArity:${cbT.params.length}`);
    const shim = `scr_ee_inv_fixed${cbT.params.length}`;
    // Only the shim's ADDRESS rides the .ll (the runtime calls it through
    // its real ScrEeInvoke type); the (ptr, ptr) spelling is layout-free.
    this.declare(`declare void @${shim}(ptr, ptr)`);
    const key = `ee:${typeKey(cbT)}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return { fn: sym, shim };
    sym = `sc_ee_ad_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    this.declare(`declare ptr @scr_box_get_ref(ptr)`);
    this.declare(`declare void @scr_closure_release(ptr)`);
    const params = cbT.params.map((_, i) => `ptr %a${i}`).join(", ");
    const d: string[] = [
      `define internal void @${sym}(ptr %cb${params ? ", " + params : ""}) ${FN_ATTRS} { ; emitter listener adapter ${typeKey(cbT)}`,
      `entry:`,
      `  %capsp = getelementptr inbounds %ScrClosure, ptr %cb, i64 1`,
      `  %bx = load ptr, ptr %capsp`,
      `  %orig = call ptr @scr_box_get_ref(ptr %bx) ; the listener, +1`,
    ];
    const passed: string[] = ["ptr %orig"];
    cbT.params.forEach((p, i) => {
      const ty = this.llType(p);
      if (ty === "double") {
        d.push(`  %d${i} = load double, ptr %a${i}`);
        passed.push(`double %d${i}`);
      } else if (ty === "i1") {
        d.push(`  %b${i} = load i1, ptr %a${i}`);
        passed.push(`i1 %b${i}`);
      } else if (isRefCounted(p)) {
        d.push(`  %r${i} = call ptr ${retainSym(this, p)}(ptr %a${i})`);
        passed.push(`ptr %r${i}`);
      } else {
        passed.push(`ptr %a${i}`);
      }
    });
    d.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %orig, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    const retTy = this.llType(cbT.ret);
    if (retTy === "void") {
      d.push(`  call void %fn(${passed.join(", ")})`);
    } else {
      d.push(`  %ret = call ${retTy} %fn(${passed.join(", ")})`);
      if (isRefCounted(cbT.ret)) {
        d.push(`  call void ${releaseSym(this, cbT.ret)}(ptr %ret) ; discarded listener result`);
      }
    }
    d.push(`  call void @scr_closure_release(ptr %orig)`, `  ret void`, `}`, ``);
    this.resolveThunkDefs.push(...d);
    return { fn: sym, shim };
  }

  /** The wrapper closure a fixed-arity adapter dispatches through: fn =
   * the adapter, one capture box owning the target closure (`target` is a
   * +1 the box CONSUMES). Returns the fresh +1 wrapper value name — the
   * registration call it feeds always moves it into the registry. */
  private wrapEmitterListener(target: string, adapterFn: string): string {
    const B = this.B;
    this.declare(`declare ptr @scr_closure_new(ptr, ${this.sizeType})`);
    this.declare(`declare ptr @scr_box_new(i32)`);
    this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
    const ad = B.tmp();
    B.line(`${ad} = call ptr @scr_closure_new(ptr @${adapterFn}, ${this.sizeType} 1)`);
    const bx = B.tmp();
    B.line(`${bx} = call ptr @scr_box_new(i32 4) ; SCR_BOX_FUNC`);
    const capsp = B.tmp();
    B.line(`${capsp} = getelementptr inbounds %ScrClosure, ptr ${ad}, i64 1`);
    B.line(`store ptr ${bx}, ptr ${capsp}`);
    B.line(`call void @scr_box_set_ref(ptr ${bx}, ptr ${target})`);
    return ad;
  }

  /** Unwrap an optional-closure union (`(() => void) | undefined`) into a
   * nullable +1 closure value the callee consumes — the C ternary
   * `u->tag == funcTag ? scr_closure_retain(peek(u)) : NULL`. */
  private unwrapNullableClosure(u: string, funcTag: number): string {
    const B = this.B;
    this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    B.line(`store ptr null, ptr ${slot}`);
    const tagP = B.tmp();
    const tag = B.tmp();
    B.line(`${tagP} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 1`);
    B.line(`${tag} = load i32, ptr ${tagP}`);
    const hit = B.tmp();
    B.line(`${hit} = icmp eq i32 ${tag}, ${funcTag}`);
    const ly = B.newLabel("uc.y");
    const lj = B.newLabel("uc.j");
    B.condBr(hit, ly, lj);
    B.startBlock(ly);
    const pp = B.tmp();
    const pv = B.tmp();
    B.line(`${pp} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 5`);
    B.line(`${pv} = load ptr, ptr ${pp}`);
    const r = B.tmp();
    B.line(`${r} = call ptr @scr_closure_retain_v(ptr ${pv})`);
    B.line(`store ptr ${r}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lj);
    const out = B.tmp();
    B.line(`${out} = load ptr, ptr ${slot}`);
    return out;
  }

  /** The bound server.close adapter — emit-async.ts's closeBindThunkFor:
   * the fn of a fresh closure whose one env slot holds the +1 server. A
   * one-param callback (declaring the `Error | undefined` slot) rides a
   * trampoline firing it with the undefined arm. */
  private closeBindThunkFor(cbUnion: IrType, retServer: boolean): string {
    if (cbUnion.kind !== "union") throw new Error("llvm emitter bug: bound-close callback param not a union");
    const key = `ncb:${cbUnion.unionId}:${retServer ? "srv" : "void"}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_ncb_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const def = this.unionsById.get(cbUnion.unionId);
    const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
    const funcArm = funcTag >= 0 ? (def!.arms[funcTag] as IrType & { kind: "func" }) : null;
    if (!funcArm) throw new Error("llvm emitter bug: bound-close callback union lacks its func arm");
    const oneParam = funcArm.params.length === 1;
    this.declare(`declare ptr @scr_box_get_ref(ptr)`);
    this.declare(`declare void @scr_closure_release(ptr)`);
    this.declare(`declare void @scr_union_release(ptr)`);
    this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
    this.declare(`declare void @scr_net_server_close_direct(ptr, ptr)`);
    let trampoline: string | null = null;
    if (oneParam) {
      const errParam = funcArm.params[0]!;
      if (errParam.kind !== "union") throw new Error("llvm emitter bug: bound-close callback's err param is not a union");
      const errDef = this.unionsById.get(errParam.unionId);
      const undefTag = errDef ? errDef.arms.findIndex((a) => a.kind === "undefinedT") : -1;
      if (undefTag < 0) throw new Error("llvm emitter bug: bound-close err union lacks its undefined arm");
      trampoline = `${sym}_cb`;
      this.resolveThunkDefs.push(
        `define internal void @${trampoline}(ptr %self) ${FN_ATTRS} { ; close cb: fire with no error`,
        `entry:`,
        `  %capsp = getelementptr inbounds %ScrClosure, ptr %self, i64 1`,
        `  %bx = load ptr, ptr %capsp`,
        `  %inner = call ptr @scr_box_get_ref(ptr %bx) ; +1`,
        `  %fnp = getelementptr inbounds %ScrClosure, ptr %inner, i64 0, i32 1`,
        `  %fn = load ptr, ptr %fnp`,
        `  call void %fn(ptr %inner, ptr ${this.unitInstanceRef(errParam.unionId, undefTag)})`,
        `  call void @scr_closure_release(ptr %inner)`,
        `  ret void`,
        `}`,
        ``,
      );
      this.declare(`declare ptr @scr_closure_new(ptr, ${this.sizeType})`);
      this.declare(`declare ptr @scr_box_new(i32)`);
      this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
    }
    if (!retServer) this.declare(`declare void @scr_net_server_release_v(ptr)`);
    const d: string[] = [
      `define internal ${retServer ? "ptr" : "void"} @${sym}(ptr %self, ptr %cbu) ${FN_ATTRS} { ; bound server.close`,
      `entry:`,
      `  %regslot = alloca ptr`,
      `  store ptr null, ptr %regslot`,
      `  %capsp = getelementptr inbounds %ScrClosure, ptr %self, i64 1`,
      `  %bx = load ptr, ptr %capsp`,
      `  %srv = call ptr @scr_box_get_ref(ptr %bx) ; +1`,
      `  %tagp = getelementptr inbounds %ScrUnion, ptr %cbu, i64 0, i32 1`,
      `  %tag = load i32, ptr %tagp`,
      `  %isfn = icmp eq i32 %tag, ${funcTag}`,
      `  br i1 %isfn, label %fn, label %go`,
      `fn:`,
      `  %pp = getelementptr inbounds %ScrUnion, ptr %cbu, i64 0, i32 5`,
      `  %pv = load ptr, ptr %pp`,
    ];
    if (oneParam) {
      d.push(
        `  %reg = call ptr @scr_closure_new(ptr @${trampoline}, ${this.sizeType} 1)`,
        `  %rbx = call ptr @scr_box_new(i32 4) ; SCR_BOX_FUNC`,
        `  %rcp = getelementptr inbounds %ScrClosure, ptr %reg, i64 1`,
        `  store ptr %rbx, ptr %rcp`,
        `  %pr = call ptr @scr_closure_retain_v(ptr %pv)`,
        `  call void @scr_box_set_ref(ptr %rbx, ptr %pr)`,
        `  store ptr %reg, ptr %regslot`,
      );
    } else {
      d.push(
        `  %reg = call ptr @scr_closure_retain_v(ptr %pv)`,
        `  store ptr %reg, ptr %regslot`,
      );
    }
    d.push(
      `  br label %go`,
      `go:`,
      `  %regv = load ptr, ptr %regslot`,
      `  call void @scr_union_release(ptr %cbu) ; the callee owns its +1 param`,
      `  call void @scr_net_server_close_direct(ptr %srv, ptr %regv) ; reg moves`,
    );
    if (retServer) {
      d.push(`  ret ptr %srv ; +1 from the env read`);
    } else {
      d.push(`  call void @scr_net_server_release_v(ptr %srv)`, `  ret void`);
    }
    d.push(`}`, ``);
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** The close-override zero-arg wrapper — emit-async.ts's
   * closeOverrideWrapFor: carries the user function in its one env slot
   * and fires it with the undefined-arm callback argument, releasing the
   * chaining-return server when the signature answers one. */
  private closeOverrideWrapFor(cbUnion: IrType, retServer: boolean): string {
    if (cbUnion.kind !== "union") throw new Error("llvm emitter bug: close-override callback param not a union");
    const key = `ncw:${cbUnion.unionId}:${retServer ? "srv" : "void"}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_ncw_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const def = this.unionsById.get(cbUnion.unionId);
    const undefTag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
    if (undefTag < 0) throw new Error("llvm emitter bug: close-override callback union lacks its undefined arm");
    this.declare(`declare ptr @scr_box_get_ref(ptr)`);
    this.declare(`declare void @scr_closure_release(ptr)`);
    if (retServer) this.declare(`declare void @scr_net_server_release_v(ptr)`);
    this.resolveThunkDefs.push(
      `define internal void @${sym}(ptr %self) ${FN_ATTRS} { ; close override wrapper`,
      `entry:`,
      `  %capsp = getelementptr inbounds %ScrClosure, ptr %self, i64 1`,
      `  %bx = load ptr, ptr %capsp`,
      `  %inner = call ptr @scr_box_get_ref(ptr %bx) ; +1`,
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %inner, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
      ...(retServer
        ? [
            `  %r = call ptr %fn(ptr %inner, ptr ${this.unitInstanceRef(cbUnion.unionId, undefTag)})`,
            `  call void @scr_net_server_release_v(ptr %r) ; the chaining return is unobserved here`,
          ]
        : [`  call void %fn(ptr %inner, ptr ${this.unitInstanceRef(cbUnion.unionId, undefTag)})`]),
      `  call void @scr_closure_release(ptr %inner)`,
      `  ret void`,
      `}`,
      ``,
    );
    return sym;
  }

  /** The stream-'data' listener adapter for one listener func type —
   * emit-async.ts's streamDataThunkFor behind the arity-2 fixed shim: the
   * runtime's 'data' emission carries BOTH payload slots (bytes chunk,
   * string chunk — exactly one non-NULL), and this adapter unwraps the
   * listener's declared side. A listener declaring the WRONG side for the
   * stream's runtime mode gets the C thunk's exact TypeError; dyn
   * listeners box by tag; zero-parameter listeners ignore both slots. */
  private streamDataAdapter(cbT: IrType & { kind: "func" }): string {
    const key = `eed:${typeKey(cbT)}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_ee_dad_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const p = cbT.params[0];
    if (cbT.params.length > 1 || (p && p.kind !== "bytes" && p.kind !== "string" && p.kind !== "dyn")) {
      throw new Error("llvm emitter bug: stream data listener param shape (frontend must fence)");
    }
    this.declare(`declare ptr @scr_box_get_ref(ptr)`);
    this.declare(`declare void @scr_closure_release(ptr)`);
    const d: string[] = [
      `define internal void @${sym}(ptr %cb, ptr %a0, ptr %a1) ${FN_ATTRS} { ; stream 'data' adapter ${typeKey(cbT)}`,
      `entry:`,
      `  %capsp = getelementptr inbounds %ScrClosure, ptr %cb, i64 1`,
      `  %bx = load ptr, ptr %capsp`,
      `  %orig = call ptr @scr_box_get_ref(ptr %bx) ; the listener, +1`,
    ];
    const finish = (arg: string | null): void => {
      d.push(
        `  %fnp = getelementptr inbounds %ScrClosure, ptr %orig, i64 0, i32 1`,
        `  %fn = load ptr, ptr %fnp`,
      );
      const retTy = this.llType(cbT.ret);
      const argList = arg === null ? `ptr %orig` : `ptr %orig, ptr ${arg}`;
      if (retTy === "void") {
        d.push(`  call void %fn(${argList})`);
      } else {
        d.push(`  %ret = call ${retTy} %fn(${argList})`);
        if (isRefCounted(cbT.ret)) {
          d.push(`  call void ${releaseSym(this, cbT.ret)}(ptr %ret) ; discarded listener result`);
        }
      }
      d.push(`  call void @scr_closure_release(ptr %orig)`, `  ret void`);
    };
    if (p === undefined) {
      finish(null);
      d.push(`}`, ``);
    } else if (p.kind === "bytes" || p.kind === "string") {
      const msg = p.kind === "bytes"
        ? "a 'data' listener declaring a Buffer chunk received a string (the stream has an encoding set)"
        : "a 'data' listener declaring a string chunk received a Buffer (call setEncoding, or declare the chunk as a Buffer)";
      const slot = p.kind === "bytes" ? "%a0" : "%a1";
      this.declare(`declare void @scr_throw_error_msg(i32, ptr, ${this.sizeType})`);
      d.push(
        `  %miss = icmp eq ptr ${slot}, null`,
        `  br i1 %miss, label %bad, label %ok`,
        `bad:`,
        `  call void @scr_throw_error_msg(i32 1, ptr ${this.cstr(msg)}, ${this.sizeType} ${Buffer.byteLength(msg, "utf8")})`,
        `  call void @scr_closure_release(ptr %orig)`,
        `  ret void`,
        `ok:`,
        `  %r0 = call ptr ${retainSym(this, p)}(ptr ${slot})`,
      );
      finish("%r0");
      d.push(`}`, ``);
    } else {
      // dyn: box by runtime tag — the JS lane's adapter parameter.
      this.declare(`declare ptr @scr_dyn_new_buffer_copy(ptr)`);
      this.declare(`declare ptr @scr_dyn_new_str(ptr)`);
      d.push(
        `  %dslot = alloca ptr`,
        `  %isb = icmp ne ptr %a0, null`,
        `  br i1 %isb, label %buf, label %str`,
        `buf:`,
        `  %db = call ptr @scr_dyn_new_buffer_copy(ptr %a0)`,
        `  store ptr %db, ptr %dslot`,
        `  br label %go`,
        `str:`,
        `  %ds = call ptr @scr_dyn_new_str(ptr %a1)`,
        `  store ptr %ds, ptr %dslot`,
        `  br label %go`,
        `go:`,
        `  %dv = load ptr, ptr %dslot`,
      );
      finish("%dv");
      d.push(`}`, ``);
    }
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** The stream completion-callback closure fn for one done func type —
   * emit-async.ts's streamDoneFnFor: the `callback` a user's write/final/
   * destroy/transform/flush receives. The closure's one capture box holds
   * the stream (+1); calling it unwraps the (optional) error/data union
   * arguments and reports completion to the runtime's *_done entry. Args
   * arrive callee-owned (+1) and are released here. */
  private streamDoneFnFor(kind: "w" | "f" | "d" | "t" | "l", doneT: IrType & { kind: "func" }): string {
    const key = `sd:${kind}:${typeKey(doneT)}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_sd_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const errT = doneT.params[0];
    let errTag = -1;
    if (errT !== undefined) {
      if (errT.kind !== "union") throw new Error("llvm emitter bug: stream done err param not a union");
      const def = this.unionsById.get(errT.unionId);
      errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
      if (errTag < 0) throw new Error("llvm emitter bug: stream done err union lacks its Error arm");
    }
    const dataT = kind === "t" || kind === "l" ? doneT.params[1] : undefined;
    let bytesTag = -1;
    let strTag = -1;
    if (dataT !== undefined) {
      if (dataT.kind !== "union") throw new Error("llvm emitter bug: stream done data param not a union");
      const def = this.unionsById.get(dataT.unionId);
      bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes") : -1;
      strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
    }
    const entry =
      kind === "w" ? "scr_stream_write_done" :
      kind === "f" ? "scr_stream_final_done" :
      kind === "d" ? "scr_stream_destroy_done" :
      kind === "t" ? "scr_stream_transform_done" : "scr_stream_flush_done";
    const twoSlot = kind === "t" || kind === "l";
    this.declare(`declare void @${entry}(ptr, ptr${twoSlot ? ", ptr, ptr" : ""})`);
    this.declare(`declare ptr @scr_box_get_ref(ptr)`);
    this.declare(`declare void @scr_stream_release_v(ptr)`);
    this.declare(`declare ptr @scr_error_retain_v(ptr)`);
    this.declare(`declare void @scr_union_release(ptr)`);
    const params = [
      "ptr %self",
      ...(errT !== undefined ? ["ptr %e"] : []),
      ...(dataT !== undefined ? ["ptr %d"] : []),
    ];
    const d: string[] = [
      `define internal void @${sym}(${params.join(", ")}) ${FN_ATTRS} { ; stream '${kind}' done ${typeKey(doneT)}`,
      `entry:`,
      `  %eslot = alloca ptr`,
      ...(twoSlot ? [`  %bslot = alloca ptr`, `  %sslot = alloca ptr`] : []),
      `  %capsp = getelementptr inbounds %ScrClosure, ptr %self, i64 1`,
      `  %bx = load ptr, ptr %capsp`,
      `  %s = call ptr @scr_box_get_ref(ptr %bx) ; the stream, +1`,
      `  store ptr null, ptr %eslot`,
      ...(twoSlot ? [`  store ptr null, ptr %bslot`, `  store ptr null, ptr %sslot`] : []),
    ];
    // A tag-guarded retained peek out of a union argument into a slot.
    let arm = 0;
    const unwrap = (u: string, tag: number, retain: string, slot: string): void => {
      const a = arm++;
      d.push(
        `  %un${a} = icmp ne ptr ${u}, null`,
        `  br i1 %un${a}, label %chk${a}, label %done${a}`,
        `chk${a}:`,
        `  %tp${a} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 1`,
        `  %tg${a} = load i32, ptr %tp${a}`,
        `  %hit${a} = icmp eq i32 %tg${a}, ${tag}`,
        `  br i1 %hit${a}, label %yes${a}, label %done${a}`,
        `yes${a}:`,
        `  %pp${a} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 5`,
        `  %pv${a} = load ptr, ptr %pp${a}`,
        `  %rt${a} = call ptr ${retain}(ptr %pv${a})`,
        `  store ptr %rt${a}, ptr ${slot}`,
        `  br label %done${a}`,
        `done${a}:`,
      );
    };
    if (errT !== undefined) unwrap("%e", errTag, "@scr_error_retain_v", "%eslot");
    if (dataT !== undefined && bytesTag >= 0) {
      this.declare(`declare ptr @scr_bytes_retain_v(ptr)`);
      unwrap("%d", bytesTag, "@scr_bytes_retain_v", "%bslot");
    }
    if (dataT !== undefined && strTag >= 0) {
      this.declare(`declare ptr @scr_str_retain_v(ptr)`);
      unwrap("%d", strTag, "@scr_str_retain_v", "%sslot");
    }
    d.push(`  %ev = load ptr, ptr %eslot`);
    if (twoSlot) {
      d.push(
        `  %bv = load ptr, ptr %bslot`,
        `  %sv = load ptr, ptr %sslot`,
        `  call void @${entry}(ptr %s, ptr %ev, ptr %bv, ptr %sv) ; moves err/data; borrows s`,
      );
    } else {
      d.push(`  call void @${entry}(ptr %s, ptr %ev) ; moves err; borrows s`);
    }
    d.push(`  call void @scr_stream_release_v(ptr %s)`);
    if (errT !== undefined) d.push(`  call void @scr_union_release(ptr %e)`);
    if (dataT !== undefined) d.push(`  call void @scr_union_release(ptr %d)`);
    d.push(`  ret void`, `}`, ``);
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** The fs.rename callback adapter: the runtime passes a borrowed Error
   * or NULL and the thunk constructs the callback's owned, program-shaped
   * Error | null union (or a dyn error/null in checkJs programs). */
  private fsRenameThunkFor(cbT: IrType & { kind: "func" }): string {
    if (cbT.params.length === 0) {
      this.declare(`declare void @scr_fs_rename_thunk0(ptr, ptr)`);
      return "scr_fs_rename_thunk0";
    }
    const key = `fsren:${typeKey(cbT)}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_fsren_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const param = cbT.params[0]!;
    const d: string[] = [
      `define internal void @${sym}(ptr %cb, ptr %err) ${FN_ATTRS} { ; fs.rename callback ${typeKey(cbT)}`,
      `entry:`,
      `  %slot = alloca ptr`,
      `  %has = icmp ne ptr %err, null`,
      `  br i1 %has, label %yes, label %no`,
      `yes:`,
    ];
    if (param.kind === "dyn") {
      this.declare(`declare ptr @scr_dyn_from_error(ptr)`);
      this.declare(`declare ptr @scr_dyn_new_null()`);
      d.push(
        `  %de = call ptr @scr_dyn_from_error(ptr %err)`,
        `  store ptr %de, ptr %slot`,
        `  br label %go`,
        `no:`,
        `  %dn = call ptr @scr_dyn_new_null()`,
        `  store ptr %dn, ptr %slot`,
      );
    } else {
      if (param.kind !== "union") throw new Error("llvm emitter bug: fs.rename error param not a union");
      const def = this.unionsById.get(param.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object" && a.className === "%Error") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (errTag < 0 || nullTag < 0) throw new Error("llvm emitter bug: fs.rename error union lacks its arms");
      this.declare(`declare ptr @scr_error_retain(ptr)`);
      this.declare(`declare ptr @scr_error_retain_v(ptr)`);
      this.declare(`declare void @scr_error_release_v(ptr)`);
      this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
      d.push(
        `  %er = call ptr @scr_error_retain(ptr %err)`,
        `  %eu = call ptr @scr_union_new_ref(i32 ${errTag}, ptr %er, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr null)`,
        `  store ptr %eu, ptr %slot`,
        `  br label %go`,
        `no:`,
        `  store ptr ${this.unitInstanceRef(param.unionId, nullTag)}, ptr %slot`,
      );
    }
    d.push(
      `  br label %go`,
      `go:`,
      `  %arg = load ptr, ptr %slot`,
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
      `  call void %fn(ptr %cb, ptr %arg)`,
      `  ret void`,
      `}`,
      ``,
    );
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** The stream option-callback invoke adapter for one (kind, callback
   * type) — emit-async.ts's streamCbThunkFor: the runtime calls the
   * user's read/write/final/destroy/transform/flush (or the finished/
   * pipeline watcher, "e") through it. The stream rides first (the
   * leading `this` param); the user may have declared any PREFIX of the
   * Node signature, so the adapter passes exactly the declared prefix
   * (retaining each ref per the callee-owns convention) and materializes
   * the completion-callback closure only when declared. */
  private streamCbThunkFor(kind: "r" | "w" | "f" | "d" | "t" | "l" | "e", cbT: IrType): string {
    if (cbT.kind !== "func") throw new Error("llvm emitter bug: stream option callback not a func");
    const key = `scb:${kind}:${typeKey(cbT)}`;
    let sym = this.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_scb_${this.resolveThunks.size}`;
    this.resolveThunks.set(key, sym);
    const runtimeParams =
      kind === "r" ? ["ptr %s", "double %size"] :
      kind === "w" || kind === "t" ? ["ptr %s", "ptr %chunk"] :
      kind === "d" || kind === "e" ? ["ptr %s", "ptr %err"] :
      ["ptr %s"];
    const declared = cbT.params;
    const hasThis = declared[0] !== undefined && declared[0].kind === "object";
    if (declared.length === 0) {
      throw new Error("llvm emitter bug: stream option callback with no params (frontend must fence)");
    }
    const off = hasThis ? 1 : 0;
    const full = (kind === "r" ? 1 : kind === "w" || kind === "t" ? 3 : kind === "d" ? 2 : 1) + off;
    if (declared.length > full) {
      throw new Error(`llvm emitter bug: stream '${kind}' callback declares ${declared.length} params (frontend must fence)`);
    }
    const d: string[] = [
      `define internal void @${sym}(ptr %cb, ${runtimeParams.join(", ")}) ${FN_ATTRS} { ; stream '${kind}' option callback ${typeKey(cbT)}`,
      `entry:`,
    ];
    const passed: string[] = ["ptr %cb"];
    if (hasThis) {
      this.declare(`declare ptr @scr_stream_retain_v(ptr)`);
      d.push(`  %sr = call ptr @scr_stream_retain_v(ptr %s)`);
      passed.push(`ptr %sr`);
    }
    // The stream-owning completion closure (a 1-cap closure boxing the
    // retained stream) — shared by the typed and dyn done shapes.
    const doneClosure = (fnRef: string, tag: string): string => {
      this.declare(`declare ptr @scr_closure_new(ptr, ${this.sizeType})`);
      this.declare(`declare ptr @scr_box_new_obj(ptr, ptr, ptr)`);
      this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
      this.declare(`declare ptr @scr_stream_retain_v(ptr)`);
      this.declare(`declare void @scr_stream_release_v(ptr)`);
      this.declare(`declare void @scr_stream_trace(ptr, ptr, ptr)`);
      d.push(
        `  %${tag}clo = call ptr @scr_closure_new(ptr ${fnRef}, ${this.sizeType} 1)`,
        `  %${tag}bx = call ptr @scr_box_new_obj(ptr @scr_stream_retain_v, ptr @scr_stream_release_v, ptr @scr_stream_trace)`,
        `  %${tag}cp = getelementptr inbounds %ScrClosure, ptr %${tag}clo, i64 1`,
        `  store ptr %${tag}bx, ptr %${tag}cp`,
        `  %${tag}sr = call ptr @scr_stream_retain_v(ptr %s)`,
        `  call void @scr_box_set_ref(ptr %${tag}bx, ptr %${tag}sr)`,
      );
      return `%${tag}clo`;
    };
    for (let i = off; i < declared.length; i++) {
      const p = declared[i]!;
      const pos = i - off;
      if (kind === "r") {
        if (p.kind === "dyn") {
          this.declare(`declare ptr @scr_dyn_new_num(double)`);
          d.push(`  %dn${i} = call ptr @scr_dyn_new_num(double %size)`);
          passed.push(`ptr %dn${i}`);
        } else {
          passed.push(`double %size`);
        }
        continue;
      }
      const isChunkPos = (kind === "w" || kind === "t") && pos === 0;
      const isEncPos = (kind === "w" || kind === "t") && pos === 1;
      const isErrPos = (kind === "d" || kind === "e") && pos === 0;
      const isDonePos =
        kind === "e" ? false
        : (kind === "w" || kind === "t") ? pos === 2 : (kind === "f" || kind === "l") ? pos === 0 : pos === 1;
      if (p.kind === "dyn") {
        if (isChunkPos) {
          this.declare(`declare ptr @scr_dyn_new_buffer_copy(ptr)`);
          d.push(`  %dc${i} = call ptr @scr_dyn_new_buffer_copy(ptr %chunk)`);
          passed.push(`ptr %dc${i}`);
        } else if (isEncPos) {
          this.declare(`declare ptr @scr_str_new(ptr, ${this.sizeType})`);
          this.declare(`declare ptr @scr_dyn_new_str(ptr)`);
          this.declare(`declare void @scr_str_release(ptr)`);
          d.push(
            `  %es${i} = call ptr @scr_str_new(ptr ${this.cstr("buffer")}, ${this.sizeType} 6)`,
            `  %ed${i} = call ptr @scr_dyn_new_str(ptr %es${i})`,
            `  call void @scr_str_release(ptr %es${i})`,
          );
          passed.push(`ptr %ed${i}`);
        } else if (isErrPos) {
          // finished/pipeline succeed with UNDEFINED (Node calls the eos
          // callback with no arguments); destroy passes null.
          this.declare(`declare ptr @scr_dyn_from_error(ptr)`);
          d.push(
            `  %edslot${i} = alloca ptr`,
            `  %ehas${i} = icmp ne ptr %err, null`,
            `  br i1 %ehas${i}, label %eyes${i}, label %eno${i}`,
            `eyes${i}:`,
            `  %ede${i} = call ptr @scr_dyn_from_error(ptr %err)`,
            `  store ptr %ede${i}, ptr %edslot${i}`,
            `  br label %ego${i}`,
            `eno${i}:`,
          );
          if (kind === "e") {
            this.declare(`declare ptr @scr_dyn_undefined()`);
            this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
            d.push(
              `  %eun${i} = call ptr @scr_dyn_undefined()`,
              `  %eur${i} = call ptr @scr_dyn_retain_v(ptr %eun${i})`,
              `  store ptr %eur${i}, ptr %edslot${i}`,
            );
          } else {
            this.declare(`declare ptr @scr_dyn_new_null()`);
            d.push(
              `  %enl${i} = call ptr @scr_dyn_new_null()`,
              `  store ptr %enl${i}, ptr %edslot${i}`,
            );
          }
          d.push(
            `  br label %ego${i}`,
            `ego${i}:`,
            `  %edv${i} = load ptr, ptr %edslot${i}`,
          );
          passed.push(`ptr %edv${i}`);
        } else if (isDonePos) {
          const glue = `scr_stream_done_dyn_${kind}`;
          this.declare(`declare ptr @${glue}(ptr, ptr, ${this.sizeType})`);
          this.declare(`declare ptr @scr_dyn_new_func(ptr, ptr, i32, ptr, ptr)`);
          const clo = doneClosure(`@${glue}`, `dd${i}`);
          const arity = kind === "t" || kind === "l" ? 2 : 1;
          const sig = kind === "t" || kind === "l" ? "(error,data)" : "(error)";
          d.push(
            `  %ddn${i} = call ptr @scr_dyn_new_func(ptr ${clo}, ptr @${glue}, i32 ${arity}, ptr ${this.cstr(sig)}, ptr ${this.cstr("callback")})`,
          );
          passed.push(`ptr %ddn${i}`);
        } else {
          throw new Error(`llvm emitter bug: stream '${kind}' dyn callback param ${i} has no adapter`);
        }
        continue;
      }
      if (isChunkPos) {
        this.declare(`declare ptr @scr_bytes_retain_v(ptr)`);
        d.push(`  %rc${i} = call ptr @scr_bytes_retain_v(ptr %chunk)`);
        passed.push(`ptr %rc${i}`);
      } else if (isEncPos) {
        // Node's encoding for decoded (Buffer) chunks is 'buffer'.
        this.declare(`declare ptr @scr_str_new(ptr, ${this.sizeType})`);
        d.push(`  %en${i} = call ptr @scr_str_new(ptr ${this.cstr("buffer")}, ${this.sizeType} 6)`);
        passed.push(`ptr %en${i}`);
      } else if (isErrPos) {
        // destroy's error argument: `Error | null` — wrap type-directedly.
        // The finished/pipeline callback ("e") may declare `Error | null |
        // undefined`; success prefers the undefined arm there.
        if (p.kind !== "union") throw new Error("llvm emitter bug: stream destroy err param not a union");
        const def = this.unionsById.get(p.unionId);
        const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
        const undefTag = kind === "e" && def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
        const nullTag = def
          ? (undefTag >= 0 ? undefTag : def.arms.findIndex((a) => a.kind === "nullT"))
          : -1;
        if (errTag < 0 || nullTag < 0) throw new Error("llvm emitter bug: stream destroy err union lacks its arms");
        this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
        this.declare(`declare ptr @scr_error_retain_v(ptr)`);
        this.declare(`declare void @scr_error_release_v(ptr)`);
        d.push(
          `  %euslot${i} = alloca ptr`,
          `  %euh${i} = icmp ne ptr %err, null`,
          `  br i1 %euh${i}, label %euy${i}, label %eun${i}`,
          `euy${i}:`,
          `  %eur${i} = call ptr @scr_error_retain_v(ptr %err)`,
          `  %euu${i} = call ptr @scr_union_new_ref(i32 ${errTag}, ptr %eur${i}, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr ${traceArg(this, def!.arms[errTag]!)})`,
          `  store ptr %euu${i}, ptr %euslot${i}`,
          `  br label %eug${i}`,
          `eun${i}:`,
          `  store ptr ${this.unitInstanceRef(p.unionId, nullTag)}, ptr %euslot${i}`,
          `  br label %eug${i}`,
          `eug${i}:`,
          `  %euv${i} = load ptr, ptr %euslot${i}`,
        );
        passed.push(`ptr %euv${i}`);
      } else if (isDonePos) {
        const doneKind = kind as "w" | "f" | "d" | "t" | "l"; // "e" has no done position
        if (p.kind !== "func") throw new Error("llvm emitter bug: stream done callback not a func");
        const doneFn = this.streamDoneFnFor(doneKind, p);
        const clo = doneClosure(`@${doneFn}`, `dn${i}`);
        passed.push(`ptr ${clo}`);
      } else {
        throw new Error(`llvm emitter bug: stream '${kind}' callback param ${i} has no adapter`);
      }
    }
    d.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    const retTy = this.llType(cbT.ret);
    if (retTy === "void") {
      d.push(`  call void %fn(${passed.join(", ")})`);
    } else {
      d.push(`  %ret = call ${retTy} %fn(${passed.join(", ")})`);
      if (isRefCounted(cbT.ret)) {
        d.push(`  call void ${releaseSym(this, cbT.ret)}(ptr %ret) ; discarded option-callback result`);
      }
    }
    d.push(`  ret void`, `}`, ``);
    this.resolveThunkDefs.push(...d);
    return sym;
  }

  /** Interned per inner-type resolve thunk for ref-kind new Promise —
   * emit-async.ts's resolveThunkFor: the fn of the runtime-minted resolve
   * closure, forwarding to scr_resolve_ref_impl with the inner type's RC
   * entry points. */
  private resolveThunkFor(inner: IrType): string {
    const key = typeKey(inner);
    let sym = this.resolveThunks.get(key);
    if (!sym) {
      sym = mangleResolveThunk(this.resolveThunks.size);
      this.resolveThunks.set(key, sym);
      const v = vAdapters(this, inner);
      this.declare(`declare void @scr_resolve_ref_impl(ptr, ptr, ptr, ptr, ptr)`);
      this.resolveThunkDefs.push(
        `define internal void @${sym}(ptr %self, ptr %v) ${FN_ATTRS} { ; resolve<${key}>`,
        `entry:`,
        `  call void @scr_resolve_ref_impl(ptr %self, ptr %v, ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(this, inner)})`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    return sym;
  }

  /** `u->tag ∈ tags` as one i1 (or-chain — unit-arm membership tests). */
  private tagInSet(uName: string, tags: number[]): string {
    const B = this.B;
    const tag = this.unionTag(uName);
    let acc = "";
    for (const t of tags) {
      const c = B.tmp();
      B.line(`${c} = icmp eq i32 ${tag}, ${t}`);
      if (acc === "") {
        acc = c;
      } else {
        const o = B.tmp();
        B.line(`${o} = or i1 ${acc}, ${c}`);
        acc = o;
      }
    }
    return acc;
  }

  private arrPush(arr: string, acc: "f64" | "bool" | "ref", value: string): string {
    const argTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
    this.declare(`declare double @scr_arr_push_${acc}(ptr, ${argTy === "i1" ? "i1 zeroext" : argTy})`);
    const t = this.B.tmp();
    this.B.line(`${t} = call double @scr_arr_push_${acc}(ptr ${arr}, ${argTy} ${value})`);
    return t;
  }

  /** The spread/pushSpread copy loop: append `src`'s elements to `dst` in
   * order, count snapshotted before the loop (so `a.push(...a)` duplicates
   * exactly like JS). _get_ref's +1 moves into _push_ref — RC-balanced. */
  private emitArrayCopyLoop(dst: string, src: string, acc: "f64" | "bool" | "ref"): void {
    const B = this.B;
    this.declare(`declare double @scr_arr_len(ptr)`);
    const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
    this.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
    const len = B.tmp();
    B.line(`${len} = call double @scr_arr_len(ptr ${src})`);
    const iSlot = B.slot();
    B.entryAllocas.push(`${iSlot} = alloca double`);
    B.line(`store double ${f64Lit(0)}, ptr ${iSlot}`);
    const lc = B.newLabel("cp.c");
    const lb = B.newLabel("cp.b");
    const le = B.newLabel("cp.e");
    B.br(lc);
    B.startBlock(lc);
    const i = B.tmp();
    const cont = B.tmp();
    B.line(`${i} = load double, ptr ${iSlot}`);
    B.line(`${cont} = fcmp olt double ${i}, ${len}`);
    B.condBr(cont, lb, le);
    B.startBlock(lb);
    const v = B.tmp();
    B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr ${src}, double ${i})`);
    this.arrPush(dst, acc, v);
    const i2 = B.tmp();
    B.line(`${i2} = fadd double ${i}, ${f64Lit(1)}`);
    B.line(`store double ${i2}, ptr ${iSlot}`);
    B.br(lc);
    B.startBlock(le);
  }

  private emitStrIntrinsic(e: IrExpr & { kind: "strIntrinsic" }): LlValue {
    // Receiver and string arguments are owned temps in the current frame;
    // every scr_str_* method BORROWS them. String/array-returning methods
    // hand back a +1 reference, which own() registers like any other.
    // Omitted optional args get the C-side defaults from docs/ir.md.
    const B = this.B;
    const r = this.emitExpr(e.receiver);
    const args = e.args.map((a) => this.emitExpr(a));
    const call = (sym: string, sig: string, argText: string, retTy: string, owned: boolean): LlValue => {
      // sig reads "<ret> (<params>)" — respelled to LLVM's declare form.
      const m = /^(.+?) \((.*)\)$/.exec(sig);
      if (!m) throw new Error(`llvm emitter bug: bad strIntrinsic sig ${sig}`);
      this.declare(`declare ${m[1]} @${sym}(${m[2]})`);
      const t = B.tmp();
      B.line(`${t} = call ${retTy} @${sym}(${argText})`);
      return owned ? this.own({ name: t, type: e.type }) : { name: t, type: e.type };
    };
    const method = e.method;
    switch (method) {
      case "length":
        return call("scr_str_utf16_len", "double (ptr)", `ptr ${r.name}`, "double", false);
      case "charCodeAt":
        return call("scr_str_char_code_at", "double (ptr, double)", `ptr ${r.name}, double ${args[0]!.name}`, "double", false);
      case "charAt":
        return call("scr_str_char_at", "ptr (ptr, double)", `ptr ${r.name}, double ${args[0]!.name}`, "ptr", true);
      case "indexOf":
        return call(
          "scr_str_index_of",
          "double (ptr, ptr, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}`,
          "double",
          false,
        );
      case "includes": {
        if (args[1]) {
          // The position form is indexOf's clamp exactly: found ⇔ != -1.
          const idx = call(
            "scr_str_index_of",
            "double (ptr, ptr, double)",
            `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1].name}`,
            "double",
            false,
          );
          const t = B.tmp();
          B.line(`${t} = fcmp une double ${idx.name}, ${f64Lit(-1)}`);
          return { name: t, type: e.type };
        }
        return call("scr_str_includes", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, "i1", false);
      }
      case "startsWith":
        return call("scr_str_starts_with", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, "i1", false);
      case "endsWith":
        return call("scr_str_ends_with", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, "i1", false);
      case "slice":
        return call(
          "scr_str_slice",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
          "ptr",
          true,
        );
      case "substring":
        return call(
          "scr_str_substring",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? F64_INF}`,
          "ptr",
          true,
        );
      case "repeat":
        return call("scr_str_repeat", "ptr (ptr, double)", `ptr ${r.name}, double ${args[0]!.name}`, "ptr", true);
      case "trim":
        return call("scr_str_trim", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "trimStart":
        return call("scr_str_trim_start", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "trimEnd":
        return call("scr_str_trim_end", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "split":
        return call(
          "scr_str_split_limit",
          "ptr (ptr, ptr, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}`,
          "ptr",
          true,
        );
      case "padStart":
        return call(
          "scr_str_pad_start",
          "ptr (ptr, double, ptr)",
          `ptr ${r.name}, double ${args[0]!.name}, ptr ${args[1]!.name}`,
          "ptr",
          true,
        );
      case "padEnd":
        return call(
          "scr_str_pad_end",
          "ptr (ptr, double, ptr)",
          `ptr ${r.name}, double ${args[0]!.name}, ptr ${args[1]!.name}`,
          "ptr",
          true,
        );
      case "toLowerCase":
        return call("scr_str_to_lower", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "toUpperCase":
        return call("scr_str_to_upper", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      // The well-formedness pair: no-ops over well-formed storage
      // (constant true / retained identity; scr_string.c).
      case "isWellFormed":
        return call("scr_str_is_well_formed", "zeroext i1 (ptr)", `ptr ${r.name}`, "i1", false);
      case "toWellFormed":
        return call("scr_str_to_well_formed", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
      case "cpAt":
        // The code point AT an index as a one-code-point string (+1) —
        // the string-for-of desugar's read.
        return call("scr_str_cp_at", "ptr (ptr, double)", `ptr ${r.name}, double ${args[0]!.name}`, "ptr", true);
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new Error("unreachable");
      }
    }
  }

  private emitArrIntrinsic(e: IrExpr & { kind: "arrIntrinsic" }): LlValue {
    const B = this.B;
    const r = this.emitExpr(e.receiver);
    if (e.receiver.type.kind !== "array") throw new Error("llvm emitter bug: arrIntrinsic on non-array");
    const elem = e.receiver.type.elem;
    const acc = elemAccess(elem);
    const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
    const accArg = acc === "bool" ? "i1 zeroext" : accTy;
    const method = e.method;
    switch (method) {
      case "length": {
        this.declare(`declare double @scr_arr_len(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "push": {
        // Variadic like JS: every argument evaluates first (left to
        // right), then each appends in order. Ownership of refcounted
        // arguments moves into the array; the result is the new length —
        // the last push's return, or the unchanged length for Node's
        // no-op zero-argument call.
        const vs = e.args.map((a) => this.emitExpr(a));
        if (acc === "ref") vs.forEach((v) => this.moveTemp(v));
        let last = "";
        for (const v of vs) last = this.arrPush(r.name, acc, v.name);
        if (last !== "") return { name: last, type: e.type };
        this.declare(`declare double @scr_arr_len(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "pushSpread": {
        // `a.push(...src)`: append src's elements in order (borrowed src,
        // count snapshotted). Result: the new length.
        const src = this.emitExpr(e.args[0]!);
        this.emitArrayCopyLoop(r.name, src.name, acc);
        this.declare(`declare double @scr_arr_len(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "unshift": {
        // Evaluate every argument before the first mutation, then insert
        // from right to left so the final front order is source order.
        const vs = e.args.map((a) => this.emitExpr(a));
        if (acc === "ref") vs.forEach((v) => this.moveTemp(v));
        this.declare(
          `declare double @scr_arr_unshift_${acc}(ptr, ${accArg})`,
        );
        let last = "";
        for (let i = vs.length - 1; i >= 0; i--) {
          last = B.tmp();
          B.line(
            `${last} = call double @scr_arr_unshift_${acc}(ptr ${r.name}, ${accTy} ${vs[i]!.name})`,
          );
        }
        if (last !== "") return { name: last, type: e.type };
        this.declare(`declare double @scr_arr_len(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "unshiftSpread": {
        // The runtime snapshots the borrowed source and handles self-spread.
        const src = this.emitExpr(e.args[0]!);
        this.declare(`declare double @scr_arr_unshift_spread(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_unshift_spread(ptr ${r.name}, ptr ${src.name})`);
        return { name: t, type: e.type };
      }
      case "pop": {
        // Ownership of a refcounted element moves OUT of the array to
        // this temp (+1 to us, the runtime does not release it).
        this.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_pop_${acc}(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ${accTy} @scr_arr_pop_${acc}(ptr ${r.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "indexOf": {
        // The needle is BORROWED (released with this statement's frame);
        // the ref variant dispatches on the array's element kind (strings
        // by content, everything else by pointer). Strict equality.
        const v = this.emitExpr(e.args[0]!);
        this.declare(`declare double @scr_arr_index_of_${acc}(ptr, ${accArg})`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_arr_index_of_${acc}(ptr ${r.name}, ${accTy} ${v.name})`);
        return { name: t, type: e.type };
      }
      case "includes": {
        // Borrowed needle, SameValueZero (NaN matches NaN).
        const v = this.emitExpr(e.args[0]!);
        this.declare(`declare zeroext i1 @scr_arr_includes_${acc}(ptr, ${accArg})`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_arr_includes_${acc}(ptr ${r.name}, ${accTy} ${v.name})`);
        return { name: t, type: e.type };
      }
      case "join": {
        // Separator borrowed; the result is an owned (+1) string. Union
        // elements ride the per-union join walker (nullish arms print
        // empty, everything else through the union ToString) — the C
        // emitter's sc_uj_*, ported in walkers.ts.
        const sep = this.emitExpr(e.args[0]!);
        if (elem.kind === "union") {
          const helper = this.walkers.unionJoinHelper(elem.unionId);
          const t = B.tmp();
          B.line(`${t} = call ptr @${helper}(ptr ${r.name}, ptr ${sep.name})`);
          return this.own({ name: t, type: e.type });
        }
        this.declare(`declare ptr @scr_arr_join(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_join(ptr ${r.name}, ptr ${sep.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "slice": {
        // Receiver borrowed; the result a fresh +1 shallow copy (ref
        // elements retained). Omitted indices get the JS defaults.
        const start = e.args[0] ? this.emitExpr(e.args[0]).name : f64Lit(0);
        const end = e.args[1] ? this.emitExpr(e.args[1]).name : F64_INF;
        this.declare(`declare ptr @scr_arr_slice(ptr, double, double)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_slice(ptr ${r.name}, double ${start}, double ${end})`);
        return this.own({ name: t, type: e.type });
      }
      case "toReversed": {
        this.declare(`declare ptr @scr_arr_to_reversed(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_to_reversed(ptr ${r.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "reverse": {
        // Mutates in place and returns the same receiver as a fresh +1.
        this.declare(`declare ptr @scr_arr_reverse(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_reverse(ptr ${r.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "toSpliced": {
        const start = this.emitExpr(e.args[0]!);
        const count = this.emitExpr(e.args[1]!);
        const items = this.emitExpr(e.args[2]!);
        this.declare(`declare ptr @scr_arr_to_spliced(ptr, double, double, ptr)`);
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_arr_to_spliced(ptr ${r.name}, double ${start.name}, ` +
            `double ${count.name}, ptr ${items.name})`,
        );
        return this.own({ name: t, type: e.type });
      }
      case "with": {
        const index = this.emitExpr(e.args[0]!);
        const value = this.emitExpr(e.args[1]!);
        this.declare(
          `declare ptr @scr_arr_with_${acc}(ptr, double, ${accArg})`,
        );
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_arr_with_${acc}(ptr ${r.name}, double ${index.name}, ` +
            `${accTy} ${value.name})`,
        );
        const out = this.own({ name: t, type: e.type });
        this.emitPendingCheck();
        return out;
      }
      case "splice": {
        // The removal splice: removed elements come back as a fresh +1
        // array, ownership MOVED out of the receiver. An omitted count
        // removes to the end (+Infinity, the slice convention).
        const start = this.emitExpr(e.args[0]!);
        const cnt = e.args[1] ? this.emitExpr(e.args[1]).name : F64_INF;
        this.declare(`declare ptr @scr_arr_splice(ptr, double, double)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_arr_splice(ptr ${r.name}, double ${start.name}, double ${cnt})`);
        return this.own({ name: t, type: e.type });
      }
      case "shift": {
        // JS shift: undefined on an empty array, else the first element
        // out (ref ownership moves into the union box) with the tail
        // sliding down. Union construction is type-directed here.
        if (e.type.kind !== "union") throw new Error("llvm emitter bug: shift result is not a union");
        const def = this.unionsById.get(e.type.unionId);
        const tag = def ? def.arms.findIndex((a) => typeEquals(a, elem)) : -1;
        const undefTag = this.undefinedArmTag(e.type);
        if (tag < 0 || undefTag < 0) throw new Error("llvm emitter bug: shift union lacks its arms");
        this.declare(`declare double @scr_arr_len(ptr)`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        const len = B.tmp();
        const has = B.tmp();
        B.line(`${len} = call double @scr_arr_len(ptr ${r.name})`);
        B.line(`${has} = fcmp one double ${len}, ${f64Lit(0)}`);
        const lp = B.newLabel("shf.p");
        const la = B.newLabel("shf.a");
        const lj = B.newLabel("shf.j");
        B.condBr(has, lp, la);
        B.startBlock(lp);
        this.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_shift_${acc}(ptr)`);
        const v = B.tmp();
        B.line(`${v} = call ${accTy} @scr_arr_shift_${acc}(ptr ${r.name})`);
        B.line(`store ptr ${this.unionNewOwned(tag, { name: v, type: elem })}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(la);
        B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ptr, ptr ${slot}`);
        return this.own({ name: t, type: e.type });
      }
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new Error("unreachable");
      }
    }
  }

  /** Wraps a nullable +1 pointer answer into its `T | unit` union: present
   * moves the value into a fresh box for `presentTag`, absent yields the
   * interned unit instance — the process.envGet convention, shared by map
   * get, sym.desc/keyFor, and regex match. */
  private wrapNullable(raw: string, present: string, valueType: IrType, valueTag: number, resultType: IrType & { kind: "union" }, absentTag: number): LlValue {
    const B = this.B;
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const isnull = B.tmp();
    B.line(`${isnull} = icmp eq ptr ${raw}, null`);
    const lp = B.newLabel("nw.p");
    const la = B.newLabel("nw.a");
    const lj = B.newLabel("nw.j");
    B.condBr(isnull, la, lp);
    B.startBlock(lp);
    B.line(`store ptr ${this.unionNewOwned(valueTag, { name: present, type: valueType })}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(la);
    B.line(`store ptr ${this.unitInstanceRef(resultType.unionId, absentTag)}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ptr, ptr ${slot}`);
    return this.own({ name: t, type: resultType });
  }

  private emitMapNew(e: IrExpr & { kind: "mapNew" }): LlValue {
    // Empty map: the runtime stores the value kind's RC entry points as
    // function pointers (scalar values pass nulls); the trace argument
    // doubles as the cycle-capability flag — exactly the C mapNew.
    if (e.type.kind !== "map") throw new Error("llvm emitter bug: mapNew of non-map type");
    const B = this.B;
    const value = e.type.value;
    const rc = isRefCounted(value) ? vAdapters(this, value) : { retain: "null", release: "null" };
    this.declare(`declare ptr @scr_map_new(i32, i32, ptr, ptr, ptr)`);
    const m = B.tmp();
    B.line(
      `${m} = call ptr @scr_map_new(i32 ${mapKeyKindNum(e.type.key)}, i32 ${mapValKindNum(value)}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${isRefCounted(value) ? traceArg(this, value) : "null"})`,
    );
    const out = this.own({ name: m, type: e.type });
    // Seeded construction: set() each pair in source order — a repeated
    // key overwrites (the runtime releases the old value).
    const kAcc = mapKeyAccess(e.type.key);
    const vAcc = elemAccess(value);
    for (const pair of e.seed ?? []) {
      const k = this.emitExpr(pair.key);
      const v = this.emitExpr(pair.value);
      if (vAcc === "ref") this.moveTemp(v); // the value MOVES in
      this.mapSet(m, kAcc, vAcc, k.name, v.name);
    }
    return out;
  }

  private mapSet(m: string, kAcc: "f64" | "str" | "ref", vAcc: "f64" | "bool" | "ref", key: string, value: string): void {
    const kTy = kAcc === "f64" ? "double" : "ptr";
    const vTy = vAcc === "f64" ? "double" : vAcc === "bool" ? "i1" : "ptr";
    this.declare(`declare void @scr_map_set_${kAcc}_${vAcc}(ptr, ${kTy}, ${vTy === "i1" ? "i1 zeroext" : vTy})`);
    this.B.line(`call void @scr_map_set_${kAcc}_${vAcc}(ptr ${m}, ${kTy} ${key}, ${vTy} ${value})`);
  }

  private emitMapIntrinsic(e: IrExpr & { kind: "mapIntrinsic" }): LlValue {
    const B = this.B;
    const r = this.emitExpr(e.receiver);
    if (e.receiver.type.kind !== "map") throw new Error("llvm emitter bug: mapIntrinsic on non-map");
    const { key, value } = e.receiver.type;
    const kAcc = mapKeyAccess(key);
    const kTy = kAcc === "f64" ? "double" : "ptr";
    const vAcc = elemAccess(value);
    const method = e.method;
    switch (method) {
      case "get": {
        // The union construction is type-directed HERE, like envGet — the
        // runtime knows no tags. Ref values come back +1 (ownership MOVES
        // into the fresh union box on a hit); scalars ride an out-param
        // behind a found flag; a miss is the interned undefined-arm
        // instance. When V is itself a union, the stored box IS the
        // result (`undefined` sorts last in canonical arm order).
        const k = this.emitExpr(e.args[0]!);
        if (e.type.kind !== "union") throw new Error("llvm emitter bug: map get result is not a union");
        const def = this.unionsById.get(e.type.unionId);
        const undefTag = this.undefinedArmTag(e.type);
        if (!def || undefTag < 0) throw new Error("llvm emitter bug: map get union lacks its undefined arm");
        const absent = this.unitInstanceRef(e.type.unionId, undefTag);
        if (value.kind === "union") {
          this.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
          const raw = B.tmp();
          const isnull = B.tmp();
          const t = B.tmp();
          B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${kTy} ${k.name})`);
          B.line(`${isnull} = icmp eq ptr ${raw}, null`);
          B.line(`${t} = select i1 ${isnull}, ptr ${absent}, ptr ${raw}`);
          return this.own({ name: t, type: e.type });
        }
        const valueTag = def.arms.findIndex((a) => typeEquals(a, value));
        if (valueTag < 0) throw new Error("llvm emitter bug: map get union lacks its value arm");
        if (value.kind === "f64" || value.kind === "bool") {
          const outTy = value.kind === "f64" ? "double" : "i8";
          const outSlot = B.slot();
          B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
          B.line(`store ${outTy} ${value.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
          this.declare(`declare zeroext i1 @scr_map_get_${kAcc}_${value.kind === "f64" ? "f64" : "bool"}(ptr, ${kTy}, ptr)`);
          const found = B.tmp();
          B.line(`${found} = call zeroext i1 @scr_map_get_${kAcc}_${value.kind === "f64" ? "f64" : "bool"}(ptr ${r.name}, ${kTy} ${k.name}, ptr ${outSlot})`);
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          const lp = B.newLabel("mg.p");
          const la = B.newLabel("mg.a");
          const lj = B.newLabel("mg.j");
          B.condBr(found, lp, la);
          B.startBlock(lp);
          const rawOut = B.tmp();
          B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
          let hit = rawOut;
          if (value.kind === "bool") {
            hit = B.tmp();
            B.line(`${hit} = trunc i8 ${rawOut} to i1`);
          }
          B.line(`store ptr ${this.unionNewOwned(valueTag, { name: hit, type: value })}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(la);
          B.line(`store ptr ${absent}, ptr ${slot}`);
          B.br(lj);
          B.startBlock(lj);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          return this.own({ name: t, type: e.type });
        }
        this.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
        const raw = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${kTy} ${k.name})`);
        return this.wrapNullable(raw, raw, value, valueTag, e.type, undefTag);
      }
      case "set": {
        // Key borrowed (the runtime retains stored string keys); the
        // value MOVES in (replacement releases the old value inside).
        const k = this.emitExpr(e.args[0]!);
        const v = this.emitExpr(e.args[1]!);
        if (vAcc === "ref") this.moveTemp(v);
        this.mapSet(r.name, kAcc, vAcc, k.name, v.name);
        return { name: "", type: e.type };
      }
      case "has": {
        const k = this.emitExpr(e.args[0]!);
        this.declare(`declare zeroext i1 @scr_map_has_${kAcc}(ptr, ${kTy})`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_has_${kAcc}(ptr ${r.name}, ${kTy} ${k.name})`);
        return { name: t, type: e.type };
      }
      case "delete": {
        const k = this.emitExpr(e.args[0]!);
        this.declare(`declare zeroext i1 @scr_map_delete_${kAcc}(ptr, ${kTy})`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_delete_${kAcc}(ptr ${r.name}, ${kTy} ${k.name})`);
        return { name: t, type: e.type };
      }
      case "size": {
        this.declare(`declare double @scr_map_size(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_map_size(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "clear":
        this.declare(`declare void @scr_map_clear(ptr)`);
        B.line(`call void @scr_map_clear(ptr ${r.name})`);
        return { name: "", type: e.type };
      case "iterCount": {
        this.declare(`declare double @scr_map_iter_count(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_map_iter_count(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "iterLive": {
        const i = this.emitExpr(e.args[0]!);
        this.declare(`declare zeroext i1 @scr_map_iter_live(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_iter_live(ptr ${r.name}, double ${i.name})`);
        return { name: t, type: e.type };
      }
      case "iterKey": {
        // String/ref keys come back +1 (own registers the owned temp).
        const i = this.emitExpr(e.args[0]!);
        const retTy = kAcc === "f64" ? "double" : "ptr";
        this.declare(`declare ${retTy} @scr_map_iter_key_${kAcc}(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ${retTy} @scr_map_iter_key_${kAcc}(ptr ${r.name}, double ${i.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "iterValue": {
        const i = this.emitExpr(e.args[0]!);
        const retTy = vAcc === "f64" ? "double" : vAcc === "bool" ? "i1" : "ptr";
        this.declare(`declare ${vAcc === "bool" ? "zeroext i1" : retTy} @scr_map_iter_val_${vAcc}(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ${retTy} @scr_map_iter_val_${vAcc}(ptr ${r.name}, double ${i.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "iterEnter":
        this.declare(`declare void @scr_map_iter_enter(ptr)`);
        B.line(`call void @scr_map_iter_enter(ptr ${r.name})`);
        return { name: "", type: e.type };
      case "iterExit":
        this.declare(`declare void @scr_map_iter_exit(ptr)`);
        B.line(`call void @scr_map_iter_exit(ptr ${r.name})`);
        return { name: "", type: e.type };
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new Error("unreachable");
      }
    }
  }

  private emitSetNew(e: IrExpr & { kind: "setNew" }): LlValue {
    // Empty set: the map runtime with the element as the KEY and the
    // value slot pinned to the scalar kind. Handle-kind elements (symbol
    // identity hashing) carry their RC adapters at construction.
    if (e.type.kind !== "set") throw new Error("llvm emitter bug: setNew of non-set type");
    const B = this.B;
    const kAcc = mapKeyAccess(e.type.elem);
    const s = B.tmp();
    if (kAcc === "ref") {
      const rc = vAdapters(this, e.type.elem);
      this.declare(`declare ptr @scr_set_new_ref(ptr, ptr)`);
      B.line(`${s} = call ptr @scr_set_new_ref(ptr ${rc.retain}, ptr ${rc.release})`);
    } else {
      this.declare(`declare ptr @scr_map_new(i32, i32, ptr, ptr, ptr)`);
      B.line(`${s} = call ptr @scr_map_new(i32 ${mapKeyKindNum(e.type.elem)}, i32 0, ptr null, ptr null, ptr null)`);
    }
    const out = this.own({ name: s, type: e.type });
    if (e.seed) {
      // Seeded construction (`new Set(values)`): one borrowed T[] whose
      // elements add() in order (duplicates keep first insertion position).
      const arr = this.emitExpr(e.seed);
      this.declare(`declare void @scr_set_add_all(ptr, ptr)`);
      B.line(`call void @scr_set_add_all(ptr ${s}, ptr ${arr.name})`);
    }
    return out;
  }

  private emitSetIntrinsic(e: IrExpr & { kind: "setIntrinsic" }): LlValue {
    const B = this.B;
    const r = this.emitExpr(e.receiver);
    if (e.receiver.type.kind !== "set") throw new Error("llvm emitter bug: setIntrinsic on non-set");
    const kAcc = mapKeyAccess(e.receiver.type.elem);
    const kTy = kAcc === "f64" ? "double" : "ptr";
    const method = e.method;
    switch (method) {
      case "add": {
        // Element borrowed (the runtime retains stored strings); the unit
        // value is the constant 0 — re-adding overwrites in place.
        const k = this.emitExpr(e.args[0]!);
        this.mapSet(r.name, kAcc, "f64", k.name, f64Lit(0));
        return { name: "", type: e.type };
      }
      case "has": {
        const k = this.emitExpr(e.args[0]!);
        this.declare(`declare zeroext i1 @scr_map_has_${kAcc}(ptr, ${kTy})`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_has_${kAcc}(ptr ${r.name}, ${kTy} ${k.name})`);
        return { name: t, type: e.type };
      }
      case "delete": {
        const k = this.emitExpr(e.args[0]!);
        this.declare(`declare zeroext i1 @scr_map_delete_${kAcc}(ptr, ${kTy})`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_delete_${kAcc}(ptr ${r.name}, ${kTy} ${k.name})`);
        return { name: t, type: e.type };
      }
      case "size": {
        this.declare(`declare double @scr_map_size(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_map_size(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "clear":
        this.declare(`declare void @scr_map_clear(ptr)`);
        B.line(`call void @scr_map_clear(ptr ${r.name})`);
        return { name: "", type: e.type };
      case "iterCount": {
        this.declare(`declare double @scr_map_iter_count(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_map_iter_count(ptr ${r.name})`);
        return { name: t, type: e.type };
      }
      case "iterLive": {
        const i = this.emitExpr(e.args[0]!);
        this.declare(`declare zeroext i1 @scr_map_iter_live(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_iter_live(ptr ${r.name}, double ${i.name})`);
        return { name: t, type: e.type };
      }
      case "iterKey": {
        // The ELEMENT read; string/ref elements come back +1.
        const i = this.emitExpr(e.args[0]!);
        const retTy = kAcc === "f64" ? "double" : "ptr";
        this.declare(`declare ${retTy} @scr_map_iter_key_${kAcc}(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ${retTy} @scr_map_iter_key_${kAcc}(ptr ${r.name}, double ${i.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "iterEnter":
        this.declare(`declare void @scr_map_iter_enter(ptr)`);
        B.line(`call void @scr_map_iter_enter(ptr ${r.name})`);
        return { name: "", type: e.type };
      case "iterExit":
        this.declare(`declare void @scr_map_iter_exit(ptr)`);
        B.line(`call void @scr_map_iter_exit(ptr ${r.name})`);
        return { name: "", type: e.type };
      case "toArray": {
        // Fresh +1 elem[] of the live entries in insertion order.
        this.declare(`declare ptr @scr_set_to_arr_${kAcc}(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_set_to_arr_${kAcc}(ptr ${r.name})`);
        return this.own({ name: t, type: e.type });
      }
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new Error("unreachable");
      }
    }
  }

  /** Whether an index/value expression can overwrite the bytes receiver
   * binding. Kept deliberately conservative; uncertain or calling shapes
   * retain the ordinary owned-receiver snapshot. */
  private isStableBytesOperand(e: IrExpr, receiverLocalId: string): boolean {
    switch (e.kind) {
      case "numLit":
      case "boolLit":
      case "varRef":
      case "incDec":
        return true;
      case "assignExpr":
        // A bytes assignment nested under truthiness/ternary can still
        // produce the numeric index/value expected by the outer access.
        return (
          e.localId !== receiverLocalId &&
          this.isStableBytesOperand(e.value, receiverLocalId)
        );
      case "bin":
        return (
          this.isStableBytesOperand(e.left, receiverLocalId) &&
          this.isStableBytesOperand(e.right, receiverLocalId)
        );
      case "unary":
      case "toBool":
        return this.isStableBytesOperand(e.operand, receiverLocalId);
      case "logical":
        return (
          this.isStableBytesOperand(e.left, receiverLocalId) &&
          this.isStableBytesOperand(e.right, receiverLocalId)
        );
      case "ternary":
        return (
          this.isStableBytesOperand(e.cond, receiverLocalId) &&
          this.isStableBytesOperand(e.then, receiverLocalId) &&
          this.isStableBytesOperand(e.else_, receiverLocalId)
        );
      case "bytesIntrinsic":
        return (
          (e.method === "get" || e.method === "length" || e.method === "byteLength") &&
          e.receiver.kind === "varRef" &&
          e.args.every((arg) => this.isStableBytesOperand(arg, receiverLocalId))
        );
      default:
        return false;
    }
  }

  /** Borrow a direct, unboxed bytes binding when later operands are stable.
   * Its scope/global owner keeps it alive through the access. */
  private emitBytesReceiver(receiver: IrExpr, following: IrExpr[]): LlValue {
    if (
      receiver.kind === "varRef" &&
      following.every((operand) => this.isStableBytesOperand(operand, receiver.localId))
    ) {
      const b = this.binding(receiver.localId);
      if (b.kind !== "boxed") {
        const value = this.B.tmp();
        this.B.line(`${value} = load ptr, ptr ${b.slot}`);
        return { name: value, type: receiver.type };
      }
    }
    return this.emitExpr(receiver);
  }

  /** Load a canonical integer-loop induction value for a direct index use.
   * Other expression shapes retain ordinary f64 evaluation. */
  private emitIntegerLoopIndex(expr: IrExpr): string | null {
    if (expr.kind !== "varRef") return null;
    const slot = this.integerLoopBindings.get(expr.localId);
    if (slot === undefined) return null;
    const index = this.B.tmp();
    this.B.line(`${index} = load ${this.sizeType}, ptr ${slot}`);
    return index;
  }

  /** Bounds-check a typed-array element index without an out-of-line call
   * on the valid path. The range test rejects NaN/infinity before fptoui;
   * the integer round trip then rejects fractions. The error block retains
   * the runtime's exact trap text. Leaves the builder in the valid block. */
  private emitBytesIndex(receiver: string, index: string, integerIndex = false): string {
    const B = this.B;
    const lenPtr = B.tmp();
    const len = B.tmp();
    B.line(`${lenPtr} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 1`);
    B.line(`${len} = load ${this.sizeType}, ptr ${lenPtr}`);
    if (integerIndex) {
      const inRange = B.tmp();
      B.line(`${inRange} = icmp ult ${this.sizeType} ${index}, ${len}`);
      const invalid = B.newLabel("bytes.index.invalid");
      const valid = B.newLabel("bytes.index.valid");
      B.condBr(inRange, valid, invalid);
      B.startBlock(invalid);
      const indexF64 = B.tmp();
      B.line(`${indexF64} = uitofp ${this.sizeType} ${index} to double`);
      this.declare(`declare double @scr_bytes_get(ptr, double)`);
      B.line(`call double @scr_bytes_get(ptr ${receiver}, double ${indexF64})`);
      B.terminate("unreachable");
      B.startBlock(valid);
      return index;
    }
    const lenF64 = B.tmp();
    const nonnegative = B.tmp();
    const belowLen = B.tmp();
    const inRange = B.tmp();
    B.line(`${lenF64} = uitofp ${this.sizeType} ${len} to double`);
    B.line(`${nonnegative} = fcmp oge double ${index}, ${f64Lit(0)}`);
    B.line(`${belowLen} = fcmp olt double ${index}, ${lenF64}`);
    B.line(`${inRange} = and i1 ${nonnegative}, ${belowLen}`);

    const rangeOk = B.newLabel("bytes.index.range");
    const invalid = B.newLabel("bytes.index.invalid");
    const valid = B.newLabel("bytes.index.valid");
    B.condBr(inRange, rangeOk, invalid);

    B.startBlock(rangeOk);
    const idx = B.tmp();
    const roundTrip = B.tmp();
    const integral = B.tmp();
    B.line(`${idx} = fptoui double ${index} to ${this.sizeType}`);
    B.line(`${roundTrip} = uitofp ${this.sizeType} ${idx} to double`);
    B.line(`${integral} = fcmp oeq double ${roundTrip}, ${index}`);
    B.condBr(integral, valid, invalid);

    B.startBlock(invalid);
    this.declare(`declare double @scr_bytes_get(ptr, double)`);
    B.line(`call double @scr_bytes_get(ptr ${receiver}, double ${index})`);
    B.terminate("unreachable");

    B.startBlock(valid);
    return idx;
  }

  /** Load the raw data pointer from ScrBytes after the bounds check. */
  private emitBytesData(receiver: string): string {
    const p = this.B.tmp();
    const data = this.B.tmp();
    this.B.line(`${p} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 3`);
    this.B.line(`${data} = load ptr, ptr ${p}`);
    return data;
  }

  /** Static typed-array length/byteLength load. */
  private emitBytesLength(elem: IrBytesElem, receiver: string, bytes: boolean): LlValue {
    const B = this.B;
    const p = B.tmp();
    const len = B.tmp();
    B.line(`${p} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 1`);
    B.line(`${len} = load ${this.sizeType}, ptr ${p}`);
    const count = bytes && elem !== "u8" ? B.tmp() : len;
    if (count !== len) B.line(`${count} = shl ${this.sizeType} ${len}, 2`);
    const out = B.tmp();
    B.line(`${out} = uitofp ${this.sizeType} ${count} to double`);
    return { name: out, type: F64 };
  }

  /** Kind-specialized typed-array load. */
  private emitBytesGet(elem: IrBytesElem, receiver: string, index: string, integerIndex = false): LlValue {
    const B = this.B;
    const idx = this.emitBytesIndex(receiver, index, integerIndex);
    const data = this.emitBytesData(receiver);
    const p = B.tmp();
    if (elem === "u8") {
      const raw = B.tmp();
      const wide = B.tmp();
      const out = B.tmp();
      B.line(`${p} = getelementptr inbounds i8, ptr ${data}, ${this.sizeType} ${idx}`);
      B.line(`${raw} = load i8, ptr ${p}, align 1`);
      B.line(`${wide} = zext i8 ${raw} to i32`);
      B.line(`${out} = uitofp i32 ${wide} to double`);
      return { name: out, type: F64 };
    }
    if (elem === "f32") {
      const raw = B.tmp();
      const out = B.tmp();
      B.line(`${p} = getelementptr inbounds float, ptr ${data}, ${this.sizeType} ${idx}`);
      B.line(`${raw} = load float, ptr ${p}, align 1`);
      B.line(`${out} = fpext float ${raw} to double`);
      return { name: out, type: F64 };
    }
    const raw = B.tmp();
    const out = B.tmp();
    B.line(`${p} = getelementptr inbounds i32, ptr ${data}, ${this.sizeType} ${idx}`);
    B.line(`${raw} = load i32, ptr ${p}, align 1`);
    B.line(`${out} = ${elem === "i32" ? "sitofp" : "uitofp"} i32 ${raw} to double`);
    return { name: out, type: F64 };
  }

  /** ToUint32/ToInt32 coercion with the overwhelmingly common finite,
   * exactly-representable JS-number range on a cast-only path. Exceptional
   * and huge values remain inline in the program TU so unrelated runtime
   * binaries do not acquire another exported helper. */
  private emitBytesU32(value: string): string {
    const B = this.B;
    const aboveMin = B.tmp();
    const belowMax = B.tmp();
    const fast = B.tmp();
    B.line(`${aboveMin} = fcmp oge double ${value}, ${f64Lit(-9007199254740992)}`);
    B.line(`${belowMax} = fcmp ole double ${value}, ${f64Lit(9007199254740992)}`);
    B.line(`${fast} = and i1 ${aboveMin}, ${belowMax}`);

    const fastLabel = B.newLabel("bytes.coerce.fast");
    const slowLabel = B.newLabel("bytes.coerce.slow");
    const done = B.newLabel("bytes.coerce.done");
    B.condBr(fast, fastLabel, slowLabel);

    B.startBlock(fastLabel);
    const signed = B.tmp();
    const fastU32 = B.tmp();
    B.line(`${signed} = fptosi double ${value} to i64`);
    B.line(`${fastU32} = trunc i64 ${signed} to i32`);
    B.br(done);

    B.startBlock(slowLabel);
    const ordered = B.tmp();
    const belowInf = B.tmp();
    const aboveNegInf = B.tmp();
    const finiteRange = B.tmp();
    const finite = B.tmp();
    B.line(`${ordered} = fcmp ord double ${value}, ${value}`);
    B.line(`${belowInf} = fcmp olt double ${value}, ${F64_INF}`);
    B.line(`${aboveNegInf} = fcmp ogt double ${value}, ${f64Lit(-Infinity)}`);
    B.line(`${finiteRange} = and i1 ${belowInf}, ${aboveNegInf}`);
    B.line(`${finite} = and i1 ${ordered}, ${finiteRange}`);
    const finiteLabel = B.newLabel("bytes.coerce.finite");
    const nonfiniteLabel = B.newLabel("bytes.coerce.nonfinite");
    const slowDone = B.newLabel("bytes.coerce.slow.done");
    B.condBr(finite, finiteLabel, nonfiniteLabel);

    B.startBlock(finiteLabel);
    this.declare(`declare double @llvm.trunc.f64(double)`);
    const truncated = B.tmp();
    const residue = B.tmp();
    const negative = B.tmp();
    const wrapped = B.tmp();
    const normalized = B.tmp();
    const finiteU32 = B.tmp();
    B.line(`${truncated} = call double @llvm.trunc.f64(double ${value})`);
    B.line(`${residue} = frem double ${truncated}, ${f64Lit(4294967296)}`);
    B.line(`${negative} = fcmp olt double ${residue}, ${f64Lit(0)}`);
    B.line(`${wrapped} = fadd double ${residue}, ${f64Lit(4294967296)}`);
    B.line(`${normalized} = select i1 ${negative}, double ${wrapped}, double ${residue}`);
    B.line(`${finiteU32} = fptoui double ${normalized} to i32`);
    B.br(slowDone);

    B.startBlock(nonfiniteLabel);
    B.br(slowDone);

    B.startBlock(slowDone);
    const slowU32 = B.tmp();
    B.line(`${slowU32} = phi i32 [ ${finiteU32}, %${finiteLabel} ], [ 0, %${nonfiniteLabel} ]`);
    B.br(done);

    B.startBlock(done);
    const out = B.tmp();
    B.line(`${out} = phi i32 [ ${fastU32}, %${fastLabel} ], [ ${slowU32}, %${slowDone} ]`);
    return out;
  }

  /** Kind-specialized typed-array store. */
  private emitBytesSet(elem: IrBytesElem, receiver: string, index: string, value: string, integerIndex = false): void {
    const B = this.B;
    const idx = this.emitBytesIndex(receiver, index, integerIndex);
    const stored = elem === "f32" ? null : this.emitBytesU32(value);
    const data = this.emitBytesData(receiver);
    const p = B.tmp();
    if (elem === "u8") {
      const byte = B.tmp();
      B.line(`${byte} = trunc i32 ${stored!} to i8`);
      B.line(`${p} = getelementptr inbounds i8, ptr ${data}, ${this.sizeType} ${idx}`);
      B.line(`store i8 ${byte}, ptr ${p}, align 1`);
      return;
    }
    if (elem === "f32") {
      const narrowed = B.tmp();
      B.line(`${narrowed} = fptrunc double ${value} to float`);
      B.line(`${p} = getelementptr inbounds float, ptr ${data}, ${this.sizeType} ${idx}`);
      B.line(`store float ${narrowed}, ptr ${p}, align 1`);
      return;
    }
    B.line(`${p} = getelementptr inbounds i32, ptr ${data}, ${this.sizeType} ${idx}`);
    B.line(`store i32 ${stored!}, ptr ${p}, align 1`);
  }

  /** The bytesIntrinsic surface (emit-exprs.ts's switch, .ll flavored).
   * Receiver and args are borrowed frame temps; string/bytes results come
   * back +1. The MAY_THROW methods get the standard pending check after
   * their temp joins its frame. The numeric families' kind token (args[0],
   * always a strLit) maps to the runtime tag at COMPILE time. */
  private emitBytesIntrinsic(e: IrExpr & { kind: "bytesIntrinsic" }): LlValue {
    const B = this.B;
    const call = (sym: string, sig: string, argText: string, owned: boolean, fallible: boolean): LlValue => {
      const m = /^(.+?) \((.*)\)$/.exec(sig);
      if (!m) throw new Error(`llvm emitter bug: bad bytesIntrinsic sig ${sig}`);
      this.declare(`declare ${m[1]} @${sym}(${m[2]})`);
      const retTy = m[1] === "zeroext i1" ? "i1" : m[1]!;
      if (retTy === "void") {
        B.line(`call void @${sym}(${argText})`);
        if (fallible) this.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const t = B.tmp();
      B.line(`${t} = call ${retTy} @${sym}(${argText})`);
      const out = owned ? this.own({ name: t, type: e.type }) : { name: t, type: e.type };
      if (fallible) this.emitPendingCheck();
      return out;
    };
    if (e.method === "readNum" || e.method === "writeNum" || e.method === "readNumVar" || e.method === "writeNumVar") {
      const tok = e.args[0]!;
      if (tok.kind !== "strLit") throw new Error(`llvm emitter bug: bytesIntrinsic ${e.method} kind must be a strLit`);
      const r0 = this.emitExpr(e.receiver);
      const rest = e.args.slice(1).map((a) => this.emitExpr(a));
      if (e.method === "readNum" || e.method === "writeNum") {
        const spec = BYTES_NUM_KIND[tok.value];
        if (!spec) throw new Error(`llvm emitter bug: bytes numeric kind '${tok.value}'`);
        return e.method === "readNum"
          ? call("scr_bytes_read_num", "double (ptr, double, i32, i1 zeroext)",
              `ptr ${r0.name}, double ${rest[0]!.name}, i32 ${spec.kind}, i1 ${spec.le}`, false, true)
          : call("scr_bytes_write_num", "double (ptr, double, double, i32, i1 zeroext)",
              `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, i32 ${spec.kind}, i1 ${spec.le}`, false, true);
      }
      const spec = BYTES_NUM_VAR[tok.value];
      if (!spec) throw new Error(`llvm emitter bug: bytes variable-width kind '${tok.value}'`);
      return e.method === "readNumVar"
        ? call("scr_bytes_read_var", "double (ptr, double, double, i1 zeroext, i1 zeroext)",
            `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, i1 ${spec.sign}, i1 ${spec.le}`, false, true)
        : call("scr_bytes_write_var", "double (ptr, double, double, double, i1 zeroext, i1 zeroext)",
            `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, double ${rest[2]!.name}, i1 ${spec.sign}, i1 ${spec.le}`, false, true);
    }
    const method = e.method;
    const directElementAccess = method === "length" || method === "byteLength" || method === "get";
    const r = directElementAccess
      ? this.emitBytesReceiver(e.receiver, e.args)
      : this.emitExpr(e.receiver);
    const integerIndex = method === "get" ? this.emitIntegerLoopIndex(e.args[0]!) : null;
    const args = integerIndex === null ? e.args.map((a) => this.emitExpr(a)) : [];
    const NAN = f64Lit(NaN);
    switch (method) {
      case "length":
        if (e.receiver.type.kind !== "bytes") {
          throw new Error("llvm emitter bug: bytesIntrinsic length on non-bytes");
        }
        return this.emitBytesLength(e.receiver.type.elem, r.name, false);
      case "byteLength":
        if (e.receiver.type.kind !== "bytes") {
          throw new Error("llvm emitter bug: bytesIntrinsic byteLength on non-bytes");
        }
        return this.emitBytesLength(e.receiver.type.elem, r.name, true);
      case "get":
        // Any invalid index traps (the array runtime's discipline).
        if (e.receiver.type.kind !== "bytes") {
          throw new Error("llvm emitter bug: bytesIntrinsic get on non-bytes");
        }
        return this.emitBytesGet(
          e.receiver.type.elem,
          r.name,
          integerIndex ?? args[0]!.name,
          integerIndex !== null,
        );
      case "slice":
        return call(
          "scr_bytes_slice",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
          true,
          false,
        );
      case "subarray":
        // A +1 VIEW aliasing the receiver's storage (subarray / Buffer's
        // slice); same index defaults as slice.
        return call(
          "scr_bytes_subarray",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
          true,
          false,
        );
      case "toReversed":
        return call(
          "scr_bytes_to_reversed",
          "ptr (ptr)",
          `ptr ${r.name}`,
          true,
          false,
        );
      case "with":
        return call(
          "scr_bytes_with",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}`,
          true,
          true,
        );
      case "join":
        return call(
          "scr_bytes_join",
          "ptr (ptr, ptr)",
          `ptr ${r.name}, ptr ${args[0]!.name}`,
          true,
          false,
        );
      case "toArray":
        return call(
          "scr_bytes_to_arr",
          "ptr (ptr)",
          `ptr ${r.name}`,
          true,
          false,
        );
      case "setFrom":
        // dst.set(src, offset?) — void; throws Node's RangeError on
        // overflow.
        return call(
          "scr_bytes_set_from",
          "void (ptr, ptr, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}`,
          false,
          true,
        );
      case "toString":
      case "toStringVar": {
        // The encoding arg is always present (the frontend completes an
        // omitted one to "utf8"). The runtime-valued form validates and
        // may throw ERR_UNKNOWN_ENCODING; the literal form is canonical
        // and cannot throw. Both return +1. Range forms: [enc, start]
        // decode to the buffer's end (the element count — r->len in the C
        // spelling); [enc, start, end] clamps.
        const checked = method === "toStringVar";
        const stem = checked ? "scr_bytes_to_str_checked" : "scr_bytes_to_str";
        if (e.args.length === 3) {
          return call(
            `${stem}_range`,
            "ptr (ptr, ptr, double, double)",
            `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}, double ${args[2]!.name}`,
            true,
            checked,
          );
        }
        if (e.args.length === 2) {
          this.declare(`declare double @scr_bytes_len(ptr)`);
          const len = B.tmp();
          B.line(`${len} = call double @scr_bytes_len(ptr ${r.name})`);
          return call(
            `${stem}_range`,
            "ptr (ptr, ptr, double, double)",
            `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}, double ${len}`,
            true,
            checked,
          );
        }
        return call(stem, "ptr (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, true, checked);
      }
      case "equals":
        return call("scr_bytes_equals", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, false, false);
      case "compareBuf": {
        // nargs = the PRESENT index args (omitted ones skip Node's
        // validation); the 0 placeholders are never read past nargs.
        const n = e.args.length - 1;
        const idx = [1, 2, 3, 4].map((i) => args[i]?.name ?? f64Lit(0));
        return call(
          "scr_bytes_compare",
          "double (ptr, ptr, double, double, double, double, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${f64Lit(n)}, ${idx.map((x) => `double ${x}`).join(", ")}`,
          false,
          true,
        );
      }
      case "indexOf":
      case "lastIndexOf":
      case "includes": {
        // args = [needle, align, byteOffset?]; an omitted byteOffset is
        // NaN — the runtime's search-everything default.
        const fwd = method !== "lastIndexOf";
        const idx = call(
          "scr_bytes_index_of",
          "double (ptr, ptr, double, double, i1 zeroext)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[2]?.name ?? NAN}, double ${args[1]!.name}, i1 ${fwd}`,
          false,
          false,
        );
        if (method !== "includes") return idx;
        const t = B.tmp();
        B.line(`${t} = fcmp one double ${idx.name}, ${f64Lit(-1)}`);
        return { name: t, type: e.type };
      }
      case "indexOfNum":
      case "lastIndexOfNum":
      case "includesNum": {
        const fwd = method !== "lastIndexOfNum";
        const idx = call(
          "scr_bytes_index_of_num",
          "double (ptr, double, double, i1 zeroext)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? NAN}, i1 ${fwd}`,
          false,
          false,
        );
        if (method !== "includesNum") return idx;
        const t = B.tmp();
        B.line(`${t} = fcmp one double ${idx.name}, ${f64Lit(-1)}`);
        return { name: t, type: e.type };
      }
      case "fillElem":
        // Per-element TypedArray fill (non-u8): slice-style index
        // defaults, never throws; the receiver comes back +1.
        return call(
          "scr_bytes_fill_elem",
          "ptr (ptr, double, double, double)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? F64_INF}`,
          true,
          false,
        );
      case "fill":
      case "fillNum": {
        const sym = method === "fill" ? "scr_bytes_fill" : "scr_bytes_fill_num";
        const vTy = method === "fill" ? "ptr" : "double";
        const n = e.args.length - 1;
        return call(
          sym,
          `ptr (ptr, ${vTy}, double, double, double)`,
          `ptr ${r.name}, ${vTy} ${args[0]!.name}, double ${f64Lit(n)}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? f64Lit(0)}`,
          true,
          true,
        );
      }
      case "fillStr": {
        const n = e.args.length - 2;
        return call(
          "scr_bytes_fill_str",
          "ptr (ptr, ptr, ptr, double, double, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${f64Lit(n)}, double ${args[2]?.name ?? f64Lit(0)}, double ${args[3]?.name ?? f64Lit(0)}`,
          true,
          true,
        );
      }
      case "copy": {
        const n = e.args.length - 1;
        return call(
          "scr_bytes_copy_into",
          "double (ptr, ptr, double, double, double, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${f64Lit(n)}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? f64Lit(0)}, double ${args[3]?.name ?? f64Lit(0)}`,
          false,
          true,
        );
      }
      case "swap16":
      case "swap32":
      case "swap64": {
        const w = method === "swap16" ? 2 : method === "swap32" ? 4 : 8;
        return call("scr_bytes_swap", "ptr (ptr, double)", `ptr ${r.name}, double ${f64Lit(w)}`, true, true);
      }
      case "writeStr":
        return call(
          "scr_bytes_write_str",
          "double (ptr, ptr, ptr, double, double, i1 zeroext)",
          `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${args[2]!.name}, double ${args[3]?.name ?? f64Lit(0)}, i1 ${args[3] ? "true" : "false"}`,
          false,
          true,
        );
      case "byteOffset":
        return call("scr_bytes_byte_offset", "double (ptr)", `ptr ${r.name}`, false, false);
      case "dataViewNew":
        // new DataView(x.buffer, byteOffset?, byteLength?) — the has_len
        // flag keeps an omitted length distinct from every numeric value.
        return call(
          "scr_dataview_new",
          "ptr (ptr, double, i1 zeroext, double)",
          `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, i1 ${args[1] ? "true" : "false"}, double ${args[1]?.name ?? f64Lit(0)}`,
          true,
          true,
        );
      case "dvGetUint8":
      case "dvGetInt8":
      case "dvGetUint16":
      case "dvGetInt16":
      case "dvGetUint32":
      case "dvGetInt32":
      case "dvGetFloat32":
      case "dvGetFloat64":
      case "dvGetBigUint64Number":
      case "dvGetBigInt64Number":
        // DataView getters: an omitted littleEndian is big-endian (the JS
        // default). Throw Node's constant RangeError on a bad offset.
        return call(
          "scr_dataview_get",
          "double (ptr, double, i32, i1 zeroext)",
          `ptr ${r.name}, double ${args[0]!.name}, i32 ${DV_GET_KIND[method]}, i1 ${args[1]?.name ?? "false"}`,
          false,
          true,
        );
      case "dvSetUint8":
      case "dvSetInt8":
      case "dvSetUint16":
      case "dvSetInt16":
      case "dvSetUint32":
      case "dvSetInt32":
      case "dvSetFloat32":
      case "dvSetFloat64":
        // DataView setters: [offset, value, littleEndian?] — void; throw
        // the getters' constant RangeError on a bad offset.
        return call(
          "scr_dataview_set",
          "void (ptr, double, double, i32, i1 zeroext)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}, ` +
            `i32 ${DV_SET_KIND[method]}, i1 ${args[2]?.name ?? "false"}`,
          false,
          true,
        );
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new Error("unreachable");
      }
    }
  }

  /** The regexIntrinsic surface. Receiver/args borrowed; string/array
   * results +1. replaceAll/split/matchAll may THROW (catchable) — the
   * result joins its frame, then the standard pending check runs (the C
   * fallibleTemp shape). */
  private emitRegexIntrinsic(e: IrExpr & { kind: "regexIntrinsic" }): LlValue {
    const B = this.B;
    const method = e.method;
    const r = this.emitExpr(e.receiver);
    const args = e.args.map((a) => this.emitExpr(a));
    const fallible = (sym: string, argText: string): LlValue => {
      this.declare(`declare ptr @${sym}(${argText.split(", ").map(() => "ptr").join(", ")})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(${argText})`);
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    };
    switch (method) {
      case "matchAll":
        // Every match drained eagerly into a fresh +1 string[][]; throws
        // Node's TypeError on a non-global regex (catchable).
        return fallible("scr_regex_match_all", `ptr ${r.name}, ptr ${args[0]!.name}`);
      case "matchAllInto":
        // matchAll's companion-index form: args[1] (a number[]) also
        // receives each match's UTF-16 start index.
        return fallible("scr_regex_match_all_into", `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}`);
      case "replaceAll":
        return fallible("scr_regex_replace_all", `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}`);
      case "split":
        this.declare(`declare ptr @scr_regex_split_limit(ptr, ptr, double)`);
        {
          const t = B.tmp();
          B.line(
            `${t} = call ptr @scr_regex_split_limit(ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name})`,
          );
          const out = this.own({ name: t, type: e.type });
          this.emitPendingCheck();
          return out;
        }
      case "test": {
        this.declare(`declare zeroext i1 @scr_regex_test(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_regex_test(ptr ${r.name}, ptr ${args[0]!.name})`);
        return { name: t, type: e.type };
      }
      case "match": {
        // +1 string[] or NULL from the runtime; the `string[] | null`
        // union wraps type-directedly, the envGet convention.
        if (e.type.kind !== "union") throw new Error("llvm emitter bug: match result not a union");
        const def = this.unionsById.get(e.type.unionId);
        const arrTag = def ? def.arms.findIndex((a) => a.kind === "array") : -1;
        const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
        if (arrTag < 0 || nullTag < 0 || !def) throw new Error("llvm emitter bug: match union lacks its arms");
        this.declare(`declare ptr @scr_regex_match(ptr, ptr)`);
        const raw = B.tmp();
        B.line(`${raw} = call ptr @scr_regex_match(ptr ${r.name}, ptr ${args[0]!.name})`);
        return this.wrapNullable(raw, raw, def.arms[arrTag]!, arrTag, e.type, nullTag);
      }
      case "search": {
        this.declare(`declare double @scr_regex_search(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call double @scr_regex_search(ptr ${r.name}, ptr ${args[0]!.name})`);
        return { name: t, type: e.type };
      }
      case "source": {
        this.declare(`declare ptr @scr_regex_source(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_regex_source(ptr ${r.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "flags": {
        this.declare(`declare ptr @scr_regex_flags(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_regex_flags(ptr ${r.name})`);
        return this.own({ name: t, type: e.type });
      }
      case "replace": {
        this.declare(`declare ptr @scr_regex_replace(ptr, ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_regex_replace(ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
        return this.own({ name: t, type: e.type });
      }
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new Error("unreachable");
      }
    }
  }

  /** Dynamic-keyed record read (the C per-(shape, result) helper, emitted
   * inline): declared fields answer through a string-equality chain, an
   * index-signature shape falls through to the overflow map, and a miss
   * yields the result union's undefined arm. Result types the tier cannot
   * SAY `undefined` in (the C trap path) and dyn results stay refused. */
  private emitRecordKeyGet(e: IrExpr & { kind: "recordKeyGet" }): LlValue {
    const B = this.B;
    const obj = this.emitExpr(e.obj);
    const k = this.emitExpr(e.key);
    const ty = this.llType(e.type);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ${ty}`);
    const join = B.newLabel("rkg.j");
    this.keyedRecordReadInto(slot, join, obj.name, k.name, e.shapeId, e.type, e.overflowOnly === true, e.loc);
    B.startBlock(join);
    const t = B.tmp();
    B.line(`${t} = load ${ty}, ptr ${slot}`);
    return this.own({ name: t, type: e.type });
  }

  /** The keyed-read chain shared by recordKeyGet and unionKeyGet's record
   * arms: stores the (owned) answer at the RESULT type into `slot` and
   * branches to `join` on every path. Result types that can say
   * `undefined` answer the miss with the interned undefined arm; anything
   * else traps on a miss (the C helper's abort path — see
   * keyedRecordReadDirectInto). */
  private keyedRecordReadInto(
    slot: string,
    join: string,
    objName: string,
    keyName: string,
    shapeId: string,
    resultType: IrType,
    overflowOnly: boolean,
    loc?: SrcLoc,
  ): void {
    const B = this.B;
    const shape = this.recordShape(shapeId);
    if (resultType.kind === "dyn") {
      // A dyn JOIN (the C helper's `surface` dyn arm): declared hits
      // convert through the per-type toDyn walker (borrowed read → fresh
      // +1 tree), a dyn-valued overflow hit passes through (+1 from the
      // map get), and a miss is JS's undefined — the dyn singleton.
      this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
      for (const f of overflowOnly ? [] : shape.fields) {
        const lit = this.internLiteral(f.name);
        const hit = B.tmp();
        B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${keyName}, ptr ${lit}) ; ${f.name}`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(hit, lh, ln);
        B.startBlock(lh);
        const { ptr, type } = this.recordFieldPtr(objName, shapeId, f.name);
        const v = this.loadField(ptr, type);
        if (type.kind === "dyn") {
          this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
          const r = B.tmp();
          B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${v})`);
          B.line(`store ptr ${r}, ptr ${slot}`);
        } else {
          const conv = this.dyn.toDynHelper(type);
          const vTy = type.kind === "f64" ? "double" : type.kind === "bool" ? "i1" : "ptr";
          const r = B.tmp();
          B.line(`${r} = call ptr @${conv}(${vTy} ${v})`);
          B.line(`store ptr ${r}, ptr ${slot}`);
        }
        B.br(join);
        B.startBlock(ln);
      }
      const iv = shape.indexValue;
      if (iv && (iv.kind === "f64" || iv.kind === "bool")) {
        // Scalar overflow under a dyn join: the hit converts through the
        // toDyn box (the C `surface(iv, hit, true)` with t dyn).
        const ovf = this.recordOvfPtr(objName, shapeId);
        const outTy = iv.kind === "f64" ? "double" : "i8";
        const outSlot = B.slot();
        B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
        B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
        this.declare(`declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`);
        const found = B.tmp();
        B.line(`${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${keyName}, ptr ${outSlot})`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(found, lh, ln);
        B.startBlock(lh);
        const rawOut = B.tmp();
        B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
        let hitVal = rawOut;
        if (iv.kind === "bool") {
          hitVal = B.tmp();
          B.line(`${hitVal} = trunc i8 ${rawOut} to i1`);
        }
        const conv = this.dyn.toDynHelper(iv);
        const r = B.tmp();
        B.line(`${r} = call ptr @${conv}(${iv.kind === "f64" ? "double" : "i1"} ${hitVal})`);
        B.line(`store ptr ${r}, ptr ${slot}`);
        B.br(join);
        B.startBlock(ln);
      } else if (iv) {
        if (iv.kind !== "dyn") {
          // The C helper's emitter-bug arm: a non-dyn REF overflow can
          // never join at dyn (the frontend fences it).
          throw new LlvmUnsupportedError(`recordKeyGet:narrow:${iv.kind}`, loc);
        }
        const ovf = this.recordOvfPtr(objName, shapeId);
        this.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
        const raw = B.tmp();
        const isnull = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${keyName})`);
        B.line(`${isnull} = icmp eq ptr ${raw}, null`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(isnull, ln, lh);
        B.startBlock(lh);
        B.line(`store ptr ${raw}, ptr ${slot} ; get returned +1`);
        B.br(join);
        B.startBlock(ln);
      }
      // The miss path: JS's undefined — the dyn singleton, retained.
      this.declare(`declare ptr @scr_dyn_undefined()`);
      this.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
      const u = B.tmp();
      const r = B.tmp();
      B.line(`${u} = call ptr @scr_dyn_undefined()`);
      B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${u})`);
      B.line(`store ptr ${r}, ptr ${slot}`);
      B.br(join);
      return;
    }
    if (resultType.kind !== "union" || this.undefinedArmTag(resultType) < 0) {
      this.keyedRecordReadDirectInto(slot, join, objName, keyName, shapeId, resultType, overflowOnly, loc);
      return;
    }
    const def = this.unionsById.get(resultType.unionId)!;
    const undefTag = this.undefinedArmTag(resultType);
    const ty = this.llType(resultType);
    // How a hit of type `vt` surfaces as the result union (the C helper's
    // `surface`): the same union passes through; anything else wraps into
    // its arm (+1 for borrowed ref reads, ownership moves for owned ones).
    const surface = (vt: IrType, expr: string, owned: boolean): string => {
      if (typeEquals(vt, resultType)) {
        return owned ? expr : this.retainValue(expr, vt);
      }
      const tag = def.arms.findIndex((a) => typeEquals(a, vt));
      if (tag < 0) throw new Error(`llvm emitter bug: keyed read arm for ${vt.kind} missing`);
      if (vt.kind === "f64" || vt.kind === "bool") {
        return this.unionNewOwned(tag, { name: expr, type: vt });
      }
      const payload = owned ? expr : this.retainValue(expr, vt);
      return this.unionNewOwned(tag, { name: payload, type: vt });
    };
    this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
    for (const f of overflowOnly ? [] : shape.fields) {
      const lit = this.internLiteral(f.name);
      const hit = B.tmp();
      B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${keyName}, ptr ${lit}) ; ${f.name}`);
      const lh = B.newLabel("rkg.h");
      const ln = B.newLabel("rkg.n");
      B.condBr(hit, lh, ln);
      B.startBlock(lh);
      const { ptr, type } = this.recordFieldPtr(objName, shapeId, f.name);
      B.line(`store ${ty} ${surface(type, this.loadField(ptr, type), false)}, ptr ${slot}`);
      B.br(join);
      B.startBlock(ln);
    }
    const iv = shape.indexValue;
    if (iv) {
      const ovf = this.recordOvfPtr(objName, shapeId);
      if (iv.kind === "f64" || iv.kind === "bool") {
        const outTy = iv.kind === "f64" ? "double" : "i8";
        const outSlot = B.slot();
        B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
        B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
        this.declare(`declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`);
        const found = B.tmp();
        B.line(`${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${keyName}, ptr ${outSlot})`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(found, lh, ln);
        B.startBlock(lh);
        const rawOut = B.tmp();
        B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
        let hitVal = rawOut;
        if (iv.kind === "bool") {
          hitVal = B.tmp();
          B.line(`${hitVal} = trunc i8 ${rawOut} to i1`);
        }
        B.line(`store ${ty} ${surface(iv, hitVal, true)}, ptr ${slot}`);
        B.br(join);
        B.startBlock(ln);
      } else {
        this.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
        const raw = B.tmp();
        const isnull = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${keyName})`);
        B.line(`${isnull} = icmp eq ptr ${raw}, null`);
        const lh = B.newLabel("rkg.h");
        const ln = B.newLabel("rkg.n");
        B.condBr(isnull, ln, lh);
        B.startBlock(lh);
        B.line(`store ${ty} ${surface(iv, raw, true)}, ptr ${slot}`);
        B.br(join);
        B.startBlock(ln);
      }
    }
    // The miss path: the result union's undefined arm.
    B.line(`store ptr ${this.unitInstanceRef(resultType.unionId, undefTag)}, ptr ${slot}`);
    B.br(join);
  }

  /** The keyed-read chain for a result type that cannot say `undefined`
   * (the checker claimed T without noUncheckedIndexedAccess): every hit
   * answers at the same type; a miss traps (sc_bad_key) — the C helper's
   * abort path, unreachable by any program whose behavior matches Node.
   * dyn results (the toDyn walkers) stay refused. */
  private keyedRecordReadDirectInto(
    slot: string,
    join: string,
    objName: string,
    keyName: string,
    shapeId: string,
    resultType: IrType,
    overflowOnly: boolean,
    loc?: SrcLoc,
  ): void {
    const B = this.B;
    if (resultType.kind === "dyn") throw new LlvmUnsupportedError("recordKeyGet:dyn", loc);
    const shape = this.recordShape(shapeId);
    const ty = this.llType(resultType);
    this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
    for (const f of overflowOnly ? [] : shape.fields) {
      if (!typeEquals(f.type, resultType)) throw new LlvmUnsupportedError(`recordKeyGet:narrow:${f.type.kind}`, loc);
      const lit = this.internLiteral(f.name);
      const hit = B.tmp();
      B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${keyName}, ptr ${lit}) ; ${f.name}`);
      const lh = B.newLabel("rkd.h");
      const ln = B.newLabel("rkd.n");
      B.condBr(hit, lh, ln);
      B.startBlock(lh);
      const { ptr, type } = this.recordFieldPtr(objName, shapeId, f.name);
      const v = this.loadField(ptr, type);
      B.line(`store ${ty} ${isRefCounted(type) ? this.retainValue(v, type) : v}, ptr ${slot}`);
      B.br(join);
      B.startBlock(ln);
    }
    const iv = shape.indexValue;
    if (iv) {
      if (!typeEquals(iv, resultType)) throw new LlvmUnsupportedError(`recordKeyGet:narrow:${iv.kind}`, loc);
      const ovf = this.recordOvfPtr(objName, shapeId);
      if (iv.kind === "f64" || iv.kind === "bool") {
        const outTy = iv.kind === "f64" ? "double" : "i8";
        const outSlot = B.slot();
        B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
        B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
        this.declare(`declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`);
        const found = B.tmp();
        B.line(`${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${keyName}, ptr ${outSlot})`);
        const lh = B.newLabel("rkd.h");
        const ln = B.newLabel("rkd.n");
        B.condBr(found, lh, ln);
        B.startBlock(lh);
        const rawOut = B.tmp();
        B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
        let hitVal = rawOut;
        if (iv.kind === "bool") {
          hitVal = B.tmp();
          B.line(`${hitVal} = trunc i8 ${rawOut} to i1`);
        }
        B.line(`store ${ty} ${hitVal}, ptr ${slot}`);
        B.br(join);
        B.startBlock(ln);
      } else {
        this.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
        const raw = B.tmp();
        const isnull = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${keyName})`);
        B.line(`${isnull} = icmp eq ptr ${raw}, null`);
        const lh = B.newLabel("rkd.h");
        const ln = B.newLabel("rkd.n");
        B.condBr(isnull, ln, lh);
        B.startBlock(lh);
        B.line(`store ${ty} ${raw}, ptr ${slot} ; get returned +1`);
        B.br(join);
        B.startBlock(ln);
      }
    }
    this.needsBadKey = true;
    B.line(`call void @sc_bad_key()`);
    B.terminate(`unreachable`);
  }

  private dynPromiseAdapter(inner: IrType): string {
    if (!isRefCounted(inner) || inner.kind === "dyn") {
      throw new Error(
        `dynamic promise adapter requires a concrete reference type, got ${typeKey(inner)}`,
      );
    }
    const key = typeKey(inner);
    const existing = this.dynPromiseAdapters.get(key);
    if (existing) return existing;
    const sym = `sc_dpa_${this.dynPromiseAdapters.size}`;
    this.dynPromiseAdapters.set(key, sym);
    this.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
    this.declare(`declare void @scr_dyn_release_v(ptr)`);
    this.declare(`declare zeroext i1 @scr_exc_pending()`);
    this.declare(`declare void @scr_promise_reject_pending(ptr)`);
    const B = new BlockBuilder();
    const dyn = B.tmp();
    const value = B.tmp();
    const pending = B.tmp();
    B.line(`${dyn} = call ptr @scr_promise_payload_ref(ptr %src)`);
    B.line(
      `${value} = call ptr @${this.dyn.dynCheckHelper(inner)}(ptr ${dyn}, ptr null)`,
    );
    B.line(`call void @scr_dyn_release_v(ptr ${dyn})`);
    B.line(`${pending} = call zeroext i1 @scr_exc_pending()`);
    const fail = B.newLabel("sra.fail");
    const ok = B.newLabel("sra.ok");
    B.condBr(pending, fail, ok);
    B.startBlock(fail);
    B.line(`call void @scr_promise_reject_pending(ptr %dst)`);
    B.terminate(`ret void`);
    B.startBlock(ok);
    if (inner.kind === "string") {
      this.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
      B.line(`call void @scr_promise_fulfill_str(ptr %dst, ptr ${value})`);
    } else {
      const rc = vAdapters(this, inner);
      this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_promise_fulfill_ref(ptr %dst, ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, inner)})`,
      );
    }
    B.terminate(`ret void`);
    this.resolveThunkDefs.push(
      `define internal void @${sym}(ptr %dst, ptr %src) ${FN_ATTRS} { ; checked-dynamic promise exit ${key}`,
      B.render(),
      `}`,
      ``,
    );
    return sym;
  }

  private streamTypedRefCommitAdapter(
    t: IrType,
    snapshot: string,
  ): string {
    if (t.kind === "bytes") {
      const commit = `${snapshot}_commit`;
      const check = this.dyn.dynCheckHelper(t);
      this.declare(`declare void @scr_bytes_copy_contents(ptr, ptr)`);
      this.declare(`declare void @scr_bytes_release(ptr)`);
      this.resolveThunkDefs.push(
        `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
        `entry:`,
        `  %next = call ptr @${check}(ptr %d, ptr null)`,
        `  %missing = icmp eq ptr %next, null`,
        `  br i1 %missing, label %done, label %copy`,
        `copy:`,
        `  call void @scr_bytes_copy_contents(ptr %target, ptr %next)`,
        `  call void @scr_bytes_release(ptr %next)`,
        `  br label %done`,
        `done:`,
        `  ret void`,
        `}`,
        ``,
      );
      return `@${commit}`;
    }
    if (t.kind === "array") {
      const commit = `${snapshot}_commit`;
      const check = this.dyn.dynCheckHelper(t);
      this.declare(`declare void @scr_arr_release(ptr)`);
      this.resolveThunkDefs.push(
        `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
        `entry:`,
        `  %next = call ptr @${check}(ptr %d, ptr null)`,
        `  %missing = icmp eq ptr %next, null`,
        `  br i1 %missing, label %done, label %swap`,
        `swap:`,
        `  %target_len_ptr = getelementptr inbounds %ScrArr, ptr %target, i64 0, i32 1`,
        `  %next_len_ptr = getelementptr inbounds %ScrArr, ptr %next, i64 0, i32 1`,
        `  %target_len = load ${this.sizeType}, ptr %target_len_ptr`,
        `  %next_len = load ${this.sizeType}, ptr %next_len_ptr`,
        `  store ${this.sizeType} %next_len, ptr %target_len_ptr`,
        `  store ${this.sizeType} %target_len, ptr %next_len_ptr`,
        `  %target_cap_ptr = getelementptr inbounds %ScrArr, ptr %target, i64 0, i32 2`,
        `  %next_cap_ptr = getelementptr inbounds %ScrArr, ptr %next, i64 0, i32 2`,
        `  %target_cap = load ${this.sizeType}, ptr %target_cap_ptr`,
        `  %next_cap = load ${this.sizeType}, ptr %next_cap_ptr`,
        `  store ${this.sizeType} %next_cap, ptr %target_cap_ptr`,
        `  store ${this.sizeType} %target_cap, ptr %next_cap_ptr`,
        `  %target_data_ptr = getelementptr inbounds %ScrArr, ptr %target, i64 0, i32 7`,
        `  %next_data_ptr = getelementptr inbounds %ScrArr, ptr %next, i64 0, i32 7`,
        `  %target_data = load ptr, ptr %target_data_ptr`,
        `  %next_data = load ptr, ptr %next_data_ptr`,
        `  store ptr %next_data, ptr %target_data_ptr`,
        `  store ptr %target_data, ptr %next_data_ptr`,
        `  call void @scr_arr_release(ptr %next)`,
        `  br label %done`,
        `done:`,
        `  ret void`,
        `}`,
        ``,
      );
      return `@${commit}`;
    }
    if (t.kind !== "record") return "null";
    const shape = this.recordsById.get(t.shapeId);
    if (!shape) {
      throw new Error(
        `llvm emitter bug: stream typed-ref commit of unknown shape ${t.shapeId}`,
      );
    }
    const commit = `${snapshot}_commit`;
    const check = this.dyn.dynCheckHelper(t);
    const lines = [
      `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
      `entry:`,
      `  %next = call ptr @${check}(ptr %d, ptr null)`,
      `  %missing = icmp eq ptr %next, null`,
      `  br i1 %missing, label %done, label %swap`,
      `swap:`,
    ];
    const members = [
      ...shape.fields.map((field, index) => ({
        index: index + 1,
        type: llFieldType(field.type),
        name: field.name,
      })),
      ...(shape.indexValue
        ? [{
            index: shape.fields.length + 1,
            type: "ptr" as const,
            name: "[key: string] overflow",
          }]
        : []),
    ];
    members.forEach((member, index) => {
      lines.push(
        `  %tp${index} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %target, i64 0, i32 ${member.index}`,
        `  %np${index} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %next, i64 0, i32 ${member.index}`,
        `  %old${index} = load ${member.type}, ptr %tp${index} ; ${member.name}`,
        `  %new${index} = load ${member.type}, ptr %np${index}`,
        `  store ${member.type} %new${index}, ptr %tp${index}`,
        `  store ${member.type} %old${index}, ptr %np${index}`,
      );
    });
    lines.push(
      `  call void ${releaseSym(this, t)}(ptr %next)`,
      `  br label %done`,
      `done:`,
      `  ret void`,
      `}`,
      ``,
    );
    this.resolveThunkDefs.push(...lines);
    return `@${commit}`;
  }

  /** Box the mutable payload of a union directly, preserving the identity
   * that AbortSignal reasons and stream chunks expose. Scalar/unit arms use
   * the ordinary union-to-dyn converter. */
  private liveDynUnionRefAdapter(
    t: IrType & { kind: "union" },
  ): string {
    const key = typeKey(t);
    const existing = this.liveDynUnionRefAdapters.get(key);
    if (existing) return existing;
    const union = this.unionsById.get(t.unionId);
    if (!union) {
      throw new Error(
        `llvm emitter bug: live dyn ref of unknown union ${t.unionId}`,
      );
    }
    const mutableArms = union.arms
      .map((arm, tag) => ({ arm, tag }))
      .filter(({ arm }) => this.streamTypedRefEligible(arm));
    if (mutableArms.length === 0) {
      throw new Error(`llvm emitter bug: live dyn ref of immutable union ${key}`);
    }

    const sym = `sc_ldu_${this.liveDynUnionRefAdapters.size}`;
    this.liveDynUnionRefAdapters.set(key, sym);
    this.declare(
      `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${this.sizeType}, ptr, ptr)`,
    );
    const adapters = new Map<number, LlStreamTypedRefAdapter>();
    for (const { arm, tag } of mutableArms) {
      const prefix = `${sym}_${tag}`;
      adapters.set(
        tag,
        this.streamTypedRefMaterializeAdapter(
          arm,
          { prefix, adapters: new Map() },
          `${prefix}_materialize`,
        ),
      );
    }

    const B = new BlockBuilder();
    const tagPtr = B.tmp();
    const tagValue = B.tmp();
    B.line(
      `${tagPtr} = getelementptr inbounds %ScrUnion, ptr %u, i64 0, i32 1`,
    );
    B.line(`${tagValue} = load i32, ptr ${tagPtr}`);
    const fallback = B.newLabel("ldu.dyn");
    const armLabels = mutableArms.map(() => B.newLabel("ldu.ref"));
    B.terminate(
      `switch i32 ${tagValue}, label %${fallback} [ ${mutableArms.map(({ tag }, index) => `i32 ${tag}, label %${armLabels[index]}`).join(" ")} ]`,
    );
    mutableArms.forEach(({ arm, tag }, index) => {
      const adapter = adapters.get(tag)!;
      const rc = vAdapters(this, arm);
      const armKey = typeKey(arm);
      B.startBlock(armLabels[index]!);
      const payloadPtr = B.tmp();
      const payload = B.tmp();
      const boxed = B.tmp();
      B.line(
        `${payloadPtr} = getelementptr inbounds %ScrUnion, ptr %u, i64 0, i32 5`,
      );
      B.line(`${payload} = load ptr, ptr ${payloadPtr}`);
      B.line(
        `${boxed} = call ptr @scr_dyn_new_typed_ref(ptr ${payload}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${this.cstr(armKey)}, ${this.sizeType} ${Buffer.byteLength(armKey, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
      );
      B.terminate(`ret ptr ${boxed}`);
    });
    B.startBlock(fallback);
    const boxed = B.tmp();
    B.line(`${boxed} = call ptr @${this.dyn.toDynHelper(t)}(ptr %u)`);
    B.terminate(`ret ptr ${boxed}`);
    this.resolveThunkDefs.push(
      `define internal ptr @${sym}(ptr %u) ${FN_ATTRS} { ; materialize live union value ${key}`,
      B.render(),
      `}`,
      ``,
    );
    return sym;
  }

  private streamTypedRefEligible(t: IrType): boolean {
    return t.kind === "record" || t.kind === "array" || t.kind === "bytes";
  }

  private streamTypedRefBoxValue(
    B: BlockBuilder,
    t: IrType,
    value: string,
    ctx: LlStreamTypedRefContext,
  ): string {
    const boxed = B.tmp();
    if (!this.streamTypedRefEligible(t)) {
      const valueTy = t.kind === "f64"
        ? "double"
        : t.kind === "bool"
          ? "i1"
          : "ptr";
      B.line(
        `${boxed} = call ptr @${this.dyn.toDynHelper(t)}(${valueTy} ${value})`,
      );
      return boxed;
    }
    const nested = this.streamTypedRefMaterializeAdapter(t, ctx);
    const rc = vAdapters(this, t);
    const key = typeKey(t);
    this.declare(
      `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${this.sizeType}, ptr, ptr)`,
    );
    B.line(
      `${boxed} = call ptr @scr_dyn_new_typed_ref(ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${this.cstr(key)}, ${this.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${nested.snapshot}, ptr ${nested.commit})`,
    );
    return boxed;
  }

  /** LLVM twin of the C stream materializer: mutable reference children
   * are their own typed capsules, so writes through a nested alias commit
   * to the nested static source immediately. */
  private streamTypedRefMaterializeAdapter(
    t: IrType,
    ctx: LlStreamTypedRefContext,
    preferredSnapshot?: string,
  ): LlStreamTypedRefAdapter {
    const key = typeKey(t);
    const existing = ctx.adapters.get(key);
    if (existing) return existing;
    const snapshot = preferredSnapshot ??
      `${ctx.prefix}_nested_${ctx.adapters.size}`;
    const adapter: LlStreamTypedRefAdapter = { snapshot, commit: "null" };
    ctx.adapters.set(key, adapter);
    adapter.commit = this.streamTypedRefCommitAdapter(t, snapshot);
    const B = new BlockBuilder();

    if (t.kind === "record") {
      const shape = this.recordsById.get(t.shapeId);
      if (!shape) {
        throw new Error(
          `llvm emitter bug: stream typed-ref materialize of unknown shape ${t.shapeId}`,
        );
      }
      /* Keep the ordinary converter for index-signature/listener records;
       * their source-identity and overflow walks have extra contracts.
       * Declared-field records and tuples cover the live stream values. */
      const ordinary = shape.indexValue || shape.fields.some(
        (field) => field.name === "handleEvent" && field.type.kind === "func",
      );
      if (ordinary) {
        const out = B.tmp();
        B.line(`${out} = call ptr @${this.dyn.toDynHelper(t)}(ptr %p)`);
        B.terminate(`ret ptr ${out}`);
      } else if (shape.tuple) {
        this.declare(`declare ptr @scr_dyn_new_arr()`);
        this.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
        const out = B.tmp();
        B.line(`${out} = call ptr @scr_dyn_new_arr()`);
        const fields = [...shape.fields].sort(
          (a, b) => Number(a.name) - Number(b.name),
        );
        for (const field of fields) {
          const index = shape.fields.indexOf(field) + 1;
          const fieldPtr = B.tmp();
          let fieldValue = B.tmp();
          B.line(`${fieldPtr} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %p, i64 0, i32 ${index}`);
          B.line(`${fieldValue} = load ${llFieldType(field.type)}, ptr ${fieldPtr}`);
          if (llFieldType(field.type) === "i8") {
            const boolValue = B.tmp();
            B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
            fieldValue = boolValue;
          }
          const boxed = this.streamTypedRefBoxValue(
            B,
            field.type,
            fieldValue,
            ctx,
          );
          B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${boxed})`);
        }
        B.terminate(`ret ptr ${out}`);
      } else {
        this.declare(`declare ptr @scr_dyn_new_obj()`);
        this.declare(`declare void @scr_dyn_obj_set(ptr, ptr, ${this.sizeType}, ptr)`);
        const out = B.tmp();
        B.line(`${out} = call ptr @scr_dyn_new_obj()`);
        const byName = new Map(shape.fields.map((field) => [field.name, field]));
        const order = shape.declaredOrder ?? shape.fields.map((field) => field.name);
        const inOrder = new Set(order);
        const fields = [
          ...order.map((name) => byName.get(name)).filter((field) => field !== undefined),
          ...shape.fields.filter((field) => !inOrder.has(field.name)),
        ];
        for (const field of fields) {
          const index = shape.fields.indexOf(field) + 1;
          const fieldPtr = B.tmp();
          let fieldValue = B.tmp();
          B.line(`${fieldPtr} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %p, i64 0, i32 ${index}`);
          B.line(`${fieldValue} = load ${llFieldType(field.type)}, ptr ${fieldPtr}`);
          if (llFieldType(field.type) === "i8") {
            const boolValue = B.tmp();
            B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
            fieldValue = boolValue;
          }
          const boxed = this.streamTypedRefBoxValue(
            B,
            field.type,
            fieldValue,
            ctx,
          );
          B.line(`call void @scr_dyn_obj_set(ptr ${out}, ptr ${this.cstr(field.name)}, ${this.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr ${boxed})`);
        }
        B.terminate(`ret ptr ${out}`);
      }
    } else if (t.kind === "array") {
      const elem = t.elem;
      this.declare(`declare ptr @scr_dyn_new_arr()`);
      this.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
      this.declare(`declare double @scr_arr_len(ptr)`);
      const out = B.tmp();
      B.line(`${out} = call ptr @scr_dyn_new_arr()`);
      const len = B.tmp();
      B.line(`${len} = call double @scr_arr_len(ptr %p)`);
      const iSlot = B.slot();
      B.entryAllocas.push(`${iSlot} = alloca double`);
      B.line(`store double ${f64Lit(0)}, ptr ${iSlot}`);
      const condition = B.newLabel("strm.c");
      const body = B.newLabel("strm.b");
      const done = B.newLabel("strm.e");
      B.br(condition);
      B.startBlock(condition);
      const index = B.tmp();
      const more = B.tmp();
      B.line(`${index} = load double, ptr ${iSlot}`);
      B.line(`${more} = fcmp olt double ${index}, ${len}`);
      B.condBr(more, body, done);
      B.startBlock(body);
      let value: string;
      if (elem.kind === "f64" || elem.kind === "bool") {
        const valueTy = elem.kind === "f64" ? "double" : "i1";
        this.declare(
          `declare ${elem.kind === "bool" ? "zeroext i1" : valueTy} @scr_arr_get_${elem.kind}(ptr, double)`,
        );
        value = B.tmp();
        B.line(`${value} = call ${valueTy} @scr_arr_get_${elem.kind}(ptr %p, double ${index})`);
      } else {
        this.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
        value = B.tmp();
        B.line(`${value} = call ptr @scr_arr_get_ref(ptr %p, double ${index}) ; +1`);
      }
      const boxed = this.streamTypedRefBoxValue(B, elem, value, ctx);
      B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${boxed})`);
      if (isRefCounted(elem)) {
        B.line(`call void ${releaseSym(this, elem)}(ptr ${value})`);
      }
      const next = B.tmp();
      B.line(`${next} = fadd double ${index}, ${f64Lit(1)}`);
      B.line(`store double ${next}, ptr ${iSlot}`);
      B.br(condition);
      B.startBlock(done);
      B.terminate(`ret ptr ${out}`);
    } else {
      const out = B.tmp();
      B.line(`${out} = call ptr @${this.dyn.toDynHelper(t)}(ptr %p)`);
      B.terminate(`ret ptr ${out}`);
    }

    this.resolveThunkDefs.push(
      `define internal ptr @${snapshot}(ptr %p) ${FN_ATTRS} { ; materialize live stream value ${key}`,
      B.render(),
      `}`,
      ``,
    );
    return adapter;
  }

  private streamFromArrayAdapter(
    t: IrType & { kind: "array" },
  ): string {
    const elem = t.elem;
    const key = typeKey(elem);
    const existing = this.streamFromArrayAdapters.get(key);
    if (existing) return existing;
    const sym = `sc_sfa_${this.streamFromArrayAdapters.size}`;
    this.streamFromArrayAdapters.set(key, sym);
    const B = new BlockBuilder();
    const unionDef = elem.kind === "union"
      ? this.unionsById.get(elem.unionId)
      : undefined;
    if (elem.kind === "union" && !unionDef) {
      throw new Error(`llvm emitter bug: streamFrom of unknown union ${elem.unionId}`);
    }
    const unionRefArms = unionDef?.arms
      .map((arm, tag) => ({ arm, tag }))
      .filter(({ arm }) =>
        isRefCounted(arm) && arm.kind !== "dyn" && arm.kind !== "string"
      ) ?? [];
    const typedRef = isRefCounted(elem) &&
      elem.kind !== "dyn" &&
      elem.kind !== "string" &&
      elem.kind !== "union";
    const snapshot = `${sym}_materialize`;
    let value: string;
    if (elem.kind === "f64") {
      this.declare(`declare double @scr_arr_get_f64(ptr, double)`);
      value = B.tmp();
      B.line(
        `${value} = call double @scr_arr_get_f64(ptr %a, double %i)`,
      );
    } else if (elem.kind === "bool") {
      this.declare(`declare zeroext i1 @scr_arr_get_bool(ptr, double)`);
      value = B.tmp();
      B.line(
        `${value} = call i1 @scr_arr_get_bool(ptr %a, double %i)`,
      );
    } else {
      this.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
      value = B.tmp();
      B.line(
        `${value} = call ptr @scr_arr_get_ref(ptr %a, double %i) ; +1`,
      );
    }
    let boxed: string;
    const valueTy =
      elem.kind === "f64" ? "double" : elem.kind === "bool" ? "i1" : "ptr";
    if (elem.kind === "union") {
      if (unionRefArms.length === 0) {
        boxed = B.tmp();
        B.line(
          `${boxed} = call ptr @${this.dyn.toDynHelper(elem)}(ptr ${value})`,
        );
      } else {
        this.declare(
          `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${this.sizeType}, ptr, ptr)`,
        );
        const boxedSlot = B.slot();
        B.entryAllocas.push(`${boxedSlot} = alloca ptr`);
        const tagPtr = B.tmp();
        const tagValue = B.tmp();
        B.line(
          `${tagPtr} = getelementptr inbounds %ScrUnion, ptr ${value}, i64 0, i32 1`,
        );
        B.line(`${tagValue} = load i32, ptr ${tagPtr}`);
        const fallback = B.newLabel("sfa.union.dyn");
        const join = B.newLabel("sfa.union.join");
        const armLabels = unionRefArms.map(() => B.newLabel("sfa.union.ref"));
        B.terminate(
          `switch i32 ${tagValue}, label %${fallback} [ ${unionRefArms.map(({ tag }, i) => `i32 ${tag}, label %${armLabels[i]}`).join(" ")} ]`,
        );
        unionRefArms.forEach(({ arm, tag }, i) => {
          const armKey = typeKey(arm);
          const armSnapshot = `${snapshot}_${tag}`;
          const armCommit = this.streamTypedRefCommitAdapter(
            arm,
            armSnapshot,
          );
          const rc = vAdapters(this, arm);
          B.startBlock(armLabels[i]!);
          const payloadPtr = B.tmp();
          const payload = B.tmp();
          const armBoxed = B.tmp();
          B.line(
            `${payloadPtr} = getelementptr inbounds %ScrUnion, ptr ${value}, i64 0, i32 5`,
          );
          B.line(`${payload} = load ptr, ptr ${payloadPtr}`);
          B.line(
            `${armBoxed} = call ptr @scr_dyn_new_typed_ref(ptr ${payload}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${this.cstr(armKey)}, ${this.sizeType} ${Buffer.byteLength(armKey, "utf8")}, ptr @${armSnapshot}, ptr ${armCommit})`,
          );
          B.line(`store ptr ${armBoxed}, ptr ${boxedSlot}`);
          B.br(join);
          this.resolveThunkDefs.push(
            `define internal ptr @${armSnapshot}(ptr %p) ${FN_ATTRS} { ; materialize stream union arm ${armKey}`,
            `entry:`,
            `  %d = call ptr @${this.dyn.toDynHelper(arm)}(ptr %p)`,
            `  ret ptr %d`,
            `}`,
            ``,
          );
        });
        B.startBlock(fallback);
        const dynBoxed = B.tmp();
        B.line(
          `${dynBoxed} = call ptr @${this.dyn.toDynHelper(elem)}(ptr ${value})`,
        );
        B.line(`store ptr ${dynBoxed}, ptr ${boxedSlot}`);
        B.br(join);
        B.startBlock(join);
        boxed = B.tmp();
        B.line(`${boxed} = load ptr, ptr ${boxedSlot}`);
      }
    } else if (typedRef) {
      boxed = B.tmp();
      const rc = vAdapters(this, elem);
      const keyPtr = this.cstr(key);
      let commit: string;
      if (this.streamTypedRefEligible(elem)) {
        commit = this.streamTypedRefMaterializeAdapter(
          elem,
          { prefix: snapshot, adapters: new Map() },
          snapshot,
        ).commit;
      } else {
        commit = this.streamTypedRefCommitAdapter(elem, snapshot);
        this.resolveThunkDefs.push(
          `define internal ptr @${snapshot}(ptr %p) ${FN_ATTRS} { ; materialize stream element ${key}`,
          `entry:`,
          `  %d = call ptr @${this.dyn.toDynHelper(elem)}(ptr %p)`,
          `  ret ptr %d`,
          `}`,
          ``,
        );
      }
      this.declare(
        `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${this.sizeType}, ptr, ptr)`,
      );
      B.line(
        `${boxed} = call ptr @scr_dyn_new_typed_ref(ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${keyPtr}, ${this.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${snapshot}, ptr ${commit})`,
      );
    } else {
      boxed = B.tmp();
      B.line(
        `${boxed} = call ptr @${this.dyn.toDynHelper(elem)}(${valueTy} ${value})`,
      );
    }
    if (isRefCounted(elem)) {
      B.line(`call void ${releaseSym(this, elem)}(ptr ${value})`);
    }
    B.terminate(`ret ptr ${boxed}`);
    this.resolveThunkDefs.push(
      `define internal ptr @${sym}(ptr %a, double %i) ${FN_ATTRS} { ; ReadableStream.from array<${key}>`,
      B.render(),
      `}`,
      ``,
    );
    return sym;
  }

  /** The claimed libCall slice: args are BORROWED (owned temps of the
   * current frame), refcounted results come back +1. LLVM types derive
   * from the call site's IR types (exactly the contract the C prototypes
   * pin). Throwing members ride the generic path too — LIB_FN_SYMS
   * membership decides support, and the standard pending check runs after
   * a result temp joins its frame (the C `finish` shape). Unlisted
   * members refuse by name. */
  private emitLibCall(e: IrExpr & { kind: "libCall" }): LlValue {
    const B = this.B;
    // Loop liveness first (one table for generic and special shapes).
    if (USES_TIMERS_LIB_FNS.has(e.fn)) this.usesTimers = true;
    if (e.fn === "process.stdoutWriteBytesCb" || e.fn === "process.stderrWriteBytesCb") {
      // All arguments evaluate before bytes are submitted. The callback
      // then moves into the next-tick entry and its error-first adapter
      // constructs Node's success `null` argument when the tick fires.
      this.usesTimers = true;
      const args = e.args.map((a) => this.emitExpr(a));
      const cbT = e.args[2]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: process write callback not a func");
      this.moveTemp(args[2]!);
      const adapter = this.fsRenameThunkFor(cbT);
      const write = e.fn === "process.stdoutWriteBytesCb"
        ? "scr_process_stdout_write_bytes"
        : "scr_process_stderr_write_bytes";
      this.declare(`declare zeroext i1 @${write}(ptr, ptr)`);
      this.declare(`declare void @scr_process_write_callback(ptr, ptr)`);
      const out = B.tmp();
      B.line(`${out} = call i1 @${write}(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      B.line(`call void @scr_process_write_callback(ptr ${args[2]!.name}, ptr @${adapter})`);
      return { name: out, type: e.type };
    }
    if (e.fn === "fs.renameCb") {
      // The callback MOVES into the next-turn operation. Its emitted
      // adapter materializes the callback's Error | null union (or the
      // checkJs dyn argument) from the runtime's borrowed ScrError.
      this.usesTimers = true;
      const args = e.args.map((a) => this.emitExpr(a));
      const cbT = e.args[2]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: fs.rename callback not a func");
      this.moveTemp(args[2]!);
      const adapter = this.fsRenameThunkFor(cbT);
      this.declare(`declare void @scr_fs_rename_async(ptr, ptr, ptr, ptr)`);
      B.line(`call void @scr_fs_rename_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr @${adapter})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "fileHandle.read" || e.fn === "fileHandle.writeBytes" || e.fn === "fileHandle.writeStr") {
      if (e.type.kind !== "promise" || e.type.inner.kind !== "record") {
        throw new Error(`llvm emitter bug: ${e.fn} result`);
      }
      const args = e.args.map((a) => this.emitExpr(a));
      const sym = e.fn === "fileHandle.read"
        ? "scr_file_handle_read"
        : e.fn === "fileHandle.writeBytes"
          ? "scr_file_handle_write_bytes"
          : "scr_file_handle_write_str";
      const tail = e.fn === "fileHandle.writeStr"
        ? "ptr, ptr, double, ptr"
        : "ptr, ptr, double, double, double, i1 zeroext";
      this.declare(`declare double @${sym}(${tail})`);
      const count = B.tmp();
      B.line(
        `${count} = call double @${sym}(${args.map((a) => `${this.llType(a.type)} ${a.name}`).join(", ")})`,
      );
      const inner = e.type.inner;
      const rec = B.tmp();
      B.line(`${rec} = call ptr @${mangleRecordNew(inner.shapeId)}()`);
      const countField = e.fn === "fileHandle.read" ? "bytesRead" : "bytesWritten";
      this.storeField(this.recordFieldPtr(rec, inner.shapeId, countField).ptr, F64, count);
      const payload = this.retainValue(args[1]!.name, e.args[1]!.type);
      B.line(`store ptr ${payload}, ptr ${this.recordFieldPtr(rec, inner.shapeId, "buffer").ptr}`);
      const rc = vAdapters(this, inner);
      this.declare(`declare ptr @scr_promise_settled_ref(ptr, ptr, ptr, ptr)`);
      const result = B.tmp();
      B.line(
        `${result} = call ptr @scr_promise_settled_ref(ptr ${rec}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, inner)})`,
      );
      return this.own({ name: result, type: e.type });
    }
    if (e.fn === "fetch.responseText" || e.fn === "fetch.responseBytes") {
      if (e.type.kind !== "promise") {
        throw new Error(`llvm emitter bug: ${e.fn} result`);
      }
      const response = this.emitExpr(e.args[0]!);
      const runtimeFn =
        e.fn === "fetch.responseText"
          ? "scr_fetch_response_text"
          : "scr_fetch_response_bytes";
      this.declare(`declare ptr @${runtimeFn}(ptr)`);
      this.declare(`declare ptr @scr_promise_new()`);
      this.declare(`declare void @scr_promise_race_add(ptr, ptr, ptr)`);
      const sourceRaw = B.tmp();
      B.line(`${sourceRaw} = call ptr @${runtimeFn}(ptr ${response.name})`);
      const source = this.own({
        name: sourceRaw,
        type: { kind: "promise", inner: DYN },
      });
      const resultRaw = B.tmp();
      B.line(`${resultRaw} = call ptr @scr_promise_new()`);
      const result = this.own({ name: resultRaw, type: e.type });
      B.line(
        `call void @scr_promise_race_add(ptr ${result.name}, ptr ${source.name}, ptr @${this.dynPromiseAdapter(e.type.inner)})`,
      );
      return result;
    }
    if (e.fn === "fetch.readerRead") {
      if (e.type.kind !== "promise" || e.type.inner.kind !== "record") {
        throw new Error("llvm emitter bug: fetch.readerRead result");
      }
      const reader = this.emitExpr(e.args[0]!);
      this.declare(`declare ptr @scr_fetch_reader_read(ptr)`);
      this.declare(`declare ptr @scr_promise_new()`);
      this.declare(`declare void @scr_promise_race_add(ptr, ptr, ptr)`);
      const sourceRaw = B.tmp();
      B.line(
        `${sourceRaw} = call ptr @scr_fetch_reader_read(ptr ${reader.name})`,
      );
      const source = this.own({
        name: sourceRaw,
        type: { kind: "promise", inner: DYN },
      });
      const resultRaw = B.tmp();
      B.line(`${resultRaw} = call ptr @scr_promise_new()`);
      const result = this.own({ name: resultRaw, type: e.type });
      B.line(
        `call void @scr_promise_race_add(ptr ${result.name}, ptr ${source.name}, ptr @${this.dynPromiseAdapter(e.type.inner)})`,
      );
      return result;
    }
    if (e.fn === "fetch.streamFrom") {
      const source = this.emitExpr(e.args[0]!);
      let sym = "scr_fetch_stream_from";
      let extra = "";
      if (source.type.kind === "array") {
        sym = "scr_fetch_stream_from_array";
        extra = `, ptr @${this.streamFromArrayAdapter(source.type)}`;
      } else if (source.type.kind === "bytes") {
        sym = "scr_fetch_stream_from_bytes";
      } else if (source.type.kind === "string") {
        sym = "scr_fetch_stream_from_string";
      }
      this.declare(
        `declare ptr @${sym}(ptr${source.type.kind === "array" ? ", ptr" : ""})`,
      );
      const raw = B.tmp();
      B.line(`${raw} = call ptr @${sym}(ptr ${source.name}${extra})`);
      const out = this.own({ name: raw, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    // The handful with non-generic shapes first.
    if (e.fn === "error.argTypeThrow") {
      // Always throws with the runtime-rendered Received tail (the
      // error.nodeThrow dummy pattern). Borrows all three.
      const an = this.emitExpr(e.args[0]!);
      const ex = this.emitExpr(e.args[1]!);
      const got = this.emitExpr(e.args[2]!);
      this.declare(`declare void @scr_throw_arg_type(ptr, ptr, ptr)`);
      B.line(`call void @scr_throw_arg_type(ptr ${an.name}, ptr ${ex.name}, ptr ${got.name})`);
      const ty = this.llType(e.type);
      if (ty === "void") {
        this.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
      const out = this.own({ name: dummy, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "error.propTypeThrow") {
      // The property flavor of argTypeThrow — same always-throw shape.
      const an = this.emitExpr(e.args[0]!);
      const ex = this.emitExpr(e.args[1]!);
      const got = this.emitExpr(e.args[2]!);
      this.declare(`declare void @scr_throw_prop_type(ptr, ptr, ptr)`);
      B.line(`call void @scr_throw_prop_type(ptr ${an.name}, ptr ${ex.name}, ptr ${got.name})`);
      const ty = this.llType(e.type);
      if (ty === "void") {
        this.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
      const out = this.own({ name: dummy, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    {
      // The fs validation-ladder Chk forms that ALWAYS throw (a
      // validation error or the trailing compiler-rendered fence): every
      // argument is a ptr (dyns + the fence string), and the typed dummy
      // is abandoned by the pending check's unwind.
      const FS_CHK_THROW_SYMS: Record<string, string | undefined> = {
        "fs.mkdtempChk": "scr_fs_mkdtemp_chk",
        "fs.readFileChk": "scr_fs_read_file_chk",
        "fs.opendirChk": "scr_fs_opendir_chk",
        "fs.watchFileChk": "scr_fs_watch_file_chk",
        "fs.lchmodChk": "scr_fs_lchmod_chk",
        "fs.readChk": "scr_fs_read_chk",
        "fs.streamOptsChk": "scr_fs_stream_opts_chk",
        "net.connectOptsChk": "scr_net_connect_opts_chk",
      };
      const sym = FS_CHK_THROW_SYMS[e.fn];
      if (sym !== undefined) {
        const args = e.args.map((a) => this.emitExpr(a));
        this.declare(`declare void @${sym}(${args.map(() => "ptr").join(", ")})`);
        B.line(`call void @${sym}(${args.map((a) => `ptr ${a.name}`).join(", ")})`);
        const ty = this.llType(e.type);
        if (ty === "void") {
          this.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
        const out = this.own({ name: dummy, type: e.type });
        this.emitPendingCheck();
        return out;
      }
    }
    if (e.fn === "error.nodeThrow") {
      // The compiler-resolved Node-parity throw (always throws — the
      // typed dummy is abandoned by the pending check's unwind).
      const kind = this.emitExpr(e.args[0]!);
      const code = this.emitExpr(e.args[1]!);
      const msg = this.emitExpr(e.args[2]!);
      this.declare(`declare void @scr_throw_node_coded(double, ptr, ptr)`);
      B.line(`call void @scr_throw_node_coded(double ${kind.name}, ptr ${code.name}, ptr ${msg.name})`);
      const ty = this.llType(e.type);
      if (ty === "void") {
        this.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
      const out = this.own({ name: dummy, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "global.undefRead") {
      // A declare-d const nothing defines: Node's catchable
      // ReferenceError at the access (always throws — the typed dummy is
      // abandoned by the pending check's unwind; releases are
      // NULL-tolerant). Borrows the name string.
      const name = this.emitExpr(e.args[0]!);
      this.declare(`declare void @scr_undef_global_read(ptr)`);
      B.line(`call void @scr_undef_global_read(ptr ${name.name})`);
      const ty = this.llType(e.type);
      const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
      const out = this.own({ name: dummy, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "fs.readFileSync" || e.fn === "fs.readFdSync") {
      // args[1] is the (always-"utf8") encoding: evaluated for JS-exact
      // side-effect order, ignored by the runtime. May throw.
      const args = e.args.map((a) => this.emitExpr(a));
      const isFd = e.fn === "fs.readFdSync";
      const sym = isFd ? "scr_fs_read_fd" : "scr_fs_read_file";
      const argTy = isFd ? "double" : "ptr";
      this.declare(`declare ptr @${sym}(${argTy})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(${argTy} ${args[0]!.name})`);
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "fsp.readFile") {
      // fs.promises.readFile(path, "utf8"): args[1] is the encoding —
      // evaluated for JS-exact side-effect order, ignored by the runtime
      // exactly like fs.readFileSync's. The C prototype takes ONLY the
      // path, so the generic path (which passes every evaluated arg)
      // would declare a second parameter the runtime never had. Settles
      // the +1 promise instead of throwing — no pending check.
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare ptr @scr_fsp_read_file(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_fsp_read_file(ptr ${args[0]!.name})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "timers.setTimeout" || e.fn === "timers.setInterval" || e.fn === "timers.setTimeoutHandle" || e.fn === "timers.setImmediate" || e.fn === "process.nextTick" || e.fn === "timers.queueMicrotask") {
      // The loop owns the callback until it fires (setTimeout/setImmediate/
      // queueMicrotask) or until clear (setInterval) — the +1 MOVES in;
      // main runs the loop.
      this.usesTimers = true;
      const cb = this.emitExpr(e.args[0]!);
      this.moveTemp(cb);
      const sym = {
        "timers.setTimeout": "scr_set_timeout",
        "timers.setInterval": "scr_set_interval",
        "timers.setTimeoutHandle": "scr_set_timeout_handle",
        "timers.setImmediate": "scr_set_immediate",
        "process.nextTick": "scr_next_tick",
        "timers.queueMicrotask": "scr_queue_microtask",
      }[e.fn];
      const rest = e.args.slice(1).map((a) => this.emitExpr(a));
      const argList = [`ptr ${cb.name}`, ...rest.map((a) => `${this.llType(a.type)} ${a.name}`)].join(", ");
      const argDecl = ["ptr", ...rest.map((a) => this.llType(a.type))].join(", ");
      if (e.type.kind === "void") {
        this.declare(`declare void @${sym}(${argDecl})`);
        B.line(`call void @${sym}(${argList})`);
        return { name: "", type: e.type };
      }
      this.declare(`declare ${this.llType(e.type)} @${sym}(${argDecl})`);
      const t = B.tmp();
      B.line(`${t} = call ${this.llType(e.type)} @${sym}(${argList})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "cp.spawn" || e.fn === "cp.spawnOpts") {
      // child_process.spawn: the child starts NOW (posix_spawnp); the
      // loop reaps it and fires its listeners. Never throws — spawn
      // failure defers to "error".
      this.usesTimers = true;
      const sym = e.fn === "cp.spawn" ? "scr_spawn" : "scr_spawn_opts";
      const args = e.args.map((a) => this.emitExpr(a));
      const argDecl = args.map((a) => (this.llType(a.type) === "i1" ? "i1 zeroext" : this.llType(a.type))).join(", ");
      this.declare(`declare ptr @${sym}(${argDecl})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(${args.map((a) => `${this.llType(a.type)} ${a.name}`).join(", ")})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "child.onExit") {
      // The callback MOVES into the child's registry; the third
      // ingredient is the ADAPTER — emitted per callback shape, because
      // the `number | null` union's tags are program data (a zero-param
      // listener gets the runtime's ignoring thunk).
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: child.onExit callback not a func");
      const child = this.emitExpr(e.args[0]!);
      const cb = this.emitExpr(e.args[1]!);
      this.moveTemp(cb);
      let adapter: string;
      if (cbT.params.length === 0) {
        adapter = "scr_child_exit_thunk0";
        this.declare(`declare void @scr_child_exit_thunk0(ptr, i1 zeroext, double, ptr)`);
      } else if (cbT.params.length === 1) {
        adapter = this.childExitThunkFor(cbT.params[0]!);
      } else {
        adapter = this.childExitThunkFor2(cbT.params[0]!, cbT.params[1]!);
      }
      this.declare(`declare void @scr_child_on_exit(ptr, ptr, ptr)`);
      B.line(`call void @scr_child_on_exit(ptr ${child.name}, ptr ${cb.name}, ptr @${adapter})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "child.onError") {
      // Both error-listener shapes have runtime-provided adapters
      // (constructing the %Error instance needs no program types).
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: child.onError callback not a func");
      const child = this.emitExpr(e.args[0]!);
      const cb = this.emitExpr(e.args[1]!);
      this.moveTemp(cb);
      const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
      this.declare(`declare void @${adapter}(ptr, ptr)`);
      this.declare(`declare void @scr_child_on_error(ptr, ptr, ptr)`);
      B.line(`call void @scr_child_on_error(ptr ${child.name}, ptr ${cb.name}, ptr @${adapter})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "stream.onData") {
      // The callback MOVES into the stream's listener registry; the
      // adapter is per callback shape — runtime-provided for the
      // zero-param and Buffer forms, emitted per union for the
      // `Buffer | string` chunk (the chunk wraps at its Buffer arm).
      this.usesTimers = true; // a flowing stream holds the loop
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: stream.onData callback not a func");
      const s0 = this.emitExpr(e.args[0]!);
      const cb = this.emitExpr(e.args[1]!);
      const once = this.emitExpr(e.args[2]!);
      this.moveTemp(cb);
      const param = cbT.params[0];
      let adapter: string;
      if (param === undefined) {
        adapter = "scr_child_stream_thunk0";
        this.declare(`declare void @scr_child_stream_thunk0(ptr, ptr)`);
      } else if (param.kind === "union") {
        adapter = this.childDataThunkFor(param);
      } else {
        adapter = "scr_child_stream_thunk_bytes";
        this.declare(`declare void @scr_child_stream_thunk_bytes(ptr, ptr)`);
      }
      this.declare(`declare void @scr_child_stream_on_data(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_child_stream_on_data(ptr ${s0.name}, ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "stream.onEnd") {
      const s0 = this.emitExpr(e.args[0]!);
      const cb = this.emitExpr(e.args[1]!);
      const once = this.emitExpr(e.args[2]!);
      this.moveTemp(cb);
      this.declare(`declare void @scr_child_stream_on_end(ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_child_stream_on_end(ptr ${s0.name}, ptr ${cb.name}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "fs.watch") {
      // The callback-less form: NULL listener/adapter. Throws Node-shaped
      // fs errors when the path won't open; an open watcher holds the
      // loop (usesTimers).
      this.usesTimers = true;
      const path = this.emitExpr(e.args[0]!);
      this.declare(`declare ptr @scr_fs_watch(ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_fs_watch(ptr ${path.name}, ptr null, ptr null)`);
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "fs.watchCb") {
      // The callback MOVES into the watcher's registry; the adapter is
      // runtime-provided per listener shape (zero-param, or the eventType
      // string). May throw (ENOENT) — the standard pending check.
      this.usesTimers = true;
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: fs.watchCb callback not a func");
      const path = this.emitExpr(e.args[0]!);
      const cb = this.emitExpr(e.args[1]!);
      this.moveTemp(cb);
      const adapter = cbT.params.length === 0 ? "scr_watch_thunk0" : "scr_watch_thunk_event";
      this.declare(`declare void @${adapter}(ptr, ptr)`);
      this.declare(`declare ptr @scr_fs_watch(ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_fs_watch(ptr ${path.name}, ptr ${cb.name}, ptr @${adapter})`);
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "rl.create") {
      // readline interface handles are runtime IDs (doubles); an open
      // interface holds the loop.
      this.usesTimers = true;
      this.declare(`declare double @scr_rl_create()`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_rl_create()`);
      return { name: t, type: e.type };
    }
    if (e.fn === "rl.question") {
      // The answer callback MOVES into the interface's registry; throws
      // Node's use-after-close error (the may-throw seed).
      this.usesTimers = true;
      const cbT = e.args[2]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: rl.question callback not a func");
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[2]!);
      const adapter = cbT.params.length === 0 ? "scr_rl_answer_thunk0" : "scr_rl_answer_thunk_str";
      this.declare(`declare void @${adapter}(ptr, ptr)`);
      this.declare(`declare void @scr_rl_question(double, ptr, ptr, ptr)`);
      B.line(`call void @scr_rl_question(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr @${adapter})`);
      this.emitPendingCheck();
      return { name: "", type: e.type };
    }
    if (e.fn === "rl.close") {
      const id = this.emitExpr(e.args[0]!);
      this.declare(`declare void @scr_rl_close(double)`);
      B.line(`call void @scr_rl_close(double ${id.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "rl.onClose") {
      // The close listener MOVES into the interface's registry.
      this.usesTimers = true;
      const id = this.emitExpr(e.args[0]!);
      const cb = this.emitExpr(e.args[1]!);
      this.moveTemp(cb);
      this.declare(`declare void @scr_rl_on_close(double, ptr)`);
      B.line(`call void @scr_rl_on_close(double ${id.name}, ptr ${cb.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "watcher.close") {
      // Idempotent; never throws.
      const w = this.emitExpr(e.args[0]!);
      this.declare(`declare void @scr_watcher_close(ptr)`);
      B.line(`call void @scr_watcher_close(ptr ${w.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "spawnRes.status" || e.fn === "child.pid" || e.fn === "child.exitCode") {
      // `number | null` / `number | undefined`, constructed type-
      // directedly over the runtime's has/get pairs (emit-exprs.ts).
      if (e.type.kind !== "union") throw new Error(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = this.unionsById.get(e.type.unionId);
      const wantUnit = e.fn === "child.pid" ? "undefinedT" : "nullT";
      const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
      const unitTag = def ? def.arms.findIndex((a) => a.kind === wantUnit) : -1;
      if (f64Tag < 0 || unitTag < 0) throw new Error(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const has = e.fn === "spawnRes.status" ? "scr_spawn_res_has_status" : e.fn === "child.pid" ? "scr_child_has_pid" : "scr_child_has_exit_code";
      const get = e.fn === "spawnRes.status" ? "scr_spawn_res_status" : e.fn === "child.pid" ? "scr_child_pid" : "scr_child_exit_code";
      const recv = this.emitExpr(e.args[0]!);
      this.declare(`declare zeroext i1 @${has}(ptr)`);
      this.declare(`declare double @${get}(ptr)`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const hasV = B.tmp();
      B.line(`${hasV} = call zeroext i1 @${has}(ptr ${recv.name})`);
      const lp = B.newLabel("hg.p");
      const la = B.newLabel("hg.a");
      const lj = B.newLabel("hg.j");
      B.condBr(hasV, lp, la);
      B.startBlock(lp);
      const x = B.tmp();
      B.line(`${x} = call double @${get}(ptr ${recv.name})`);
      B.line(`store ptr ${this.unionNewOwned(f64Tag, { name: x, type: F64 })}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(la);
      B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, unitTag)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ptr, ptr ${slot}`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "spawnRes.signal") {
      // The `string | null` union (the termination signal's name, null
      // for a normal exit or spawn failure) — the has/get pair wrapped
      // type-directedly.
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: spawnRes.signal result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (strTag < 0 || nullTag < 0) throw new Error("llvm emitter bug: spawnRes.signal union lacks its arms");
      const recv = this.emitExpr(e.args[0]!);
      this.declare(`declare zeroext i1 @scr_spawn_res_has_signal(ptr)`);
      this.declare(`declare ptr @scr_spawn_res_signal(ptr)`);
      const hasV = B.tmp();
      B.line(`${hasV} = call zeroext i1 @scr_spawn_res_has_signal(ptr ${recv.name})`);
      const rawSlot = B.slot();
      B.entryAllocas.push(`${rawSlot} = alloca ptr`);
      B.line(`store ptr null, ptr ${rawSlot}`);
      const lp = B.newLabel("srs.p");
      const lj = B.newLabel("srs.j");
      B.condBr(hasV, lp, lj);
      B.startBlock(lp);
      const sv = B.tmp();
      B.line(`${sv} = call ptr @scr_spawn_res_signal(ptr ${recv.name}) ; +1`);
      B.line(`store ptr ${sv}, ptr ${rawSlot}`);
      B.br(lj);
      B.startBlock(lj);
      const raw = B.tmp();
      B.line(`${raw} = load ptr, ptr ${rawSlot}`);
      return this.wrapNullable(raw, raw, STRING, strTag, e.type, nullTag);
    }
    if (e.fn === "spawnRes.error") {
      // The `Error | undefined` union, the envGet convention: a spawn
      // failure hands back a fresh +1 %Error (ownership moves into the
      // union box); otherwise the interned undefined arm.
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: spawnRes.error result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object" && a.className === "%Error") : -1;
      const undefTag = this.undefinedArmTag(e.type);
      if (errTag < 0 || undefTag < 0) throw new Error("llvm emitter bug: spawnRes.error union lacks its arms");
      const recv = this.emitExpr(e.args[0]!);
      this.declare(`declare ptr @scr_spawn_res_error(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_spawn_res_error(ptr ${recv.name}) ; +1 or NULL`);
      return this.wrapNullable(raw, raw, { kind: "object", className: "%Error" }, errTag, e.type, undefTag);
    }
    if (e.fn === "child.stdout" || e.fn === "child.stderr") {
      // `Readable | null` — the child.pid pattern with a REF arm: the
      // runtime answers a +1 stream handle or NULL (not piped).
      if (e.type.kind !== "union") throw new Error(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = this.unionsById.get(e.type.unionId);
      const streamTag = def ? def.arms.findIndex((a) => a.kind === "childStream") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (streamTag < 0 || nullTag < 0) throw new Error(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const get = e.fn === "child.stdout" ? "scr_child_stdout" : "scr_child_stderr";
      const recv = this.emitExpr(e.args[0]!);
      this.declare(`declare ptr @${get}(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @${get}(ptr ${recv.name}) ; +1 or NULL`);
      return this.wrapNullable(raw, raw, def!.arms[streamTag]!, streamTag, e.type, nullTag);
    }
    if (e.fn === "stdin.nextChunk") {
      // +1 promise of the next chunk (empty = EOF); the await parks the
      // fiber while the loop watches fd 0.
      this.usesTimers = true;
      this.declare(`declare ptr @scr_stdin_next_chunk()`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_stdin_next_chunk()`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "stdin.onData" || e.fn === "stdin.onEnd" || e.fn === "stdin.onError") {
      // A stdin listener is a consumer: the loop watches fd 0 and stays
      // alive until EOF, so main must run it. The callback MOVES in.
      this.usesTimers = true;
      const cbT = e.args[0]!.type;
      if (cbT.kind !== "func") throw new Error(`llvm emitter bug: ${e.fn} callback not a func`);
      const cb = this.emitExpr(e.args[0]!);
      const once = this.emitExpr(e.args[1]!);
      this.moveTemp(cb);
      if (e.fn === "stdin.onEnd") {
        this.declare(`declare void @scr_stdin_on_end(ptr, i1 zeroext)`);
        B.line(`call void @scr_stdin_on_end(ptr ${cb.name}, i1 ${once.name})`);
        return { name: "", type: e.type };
      }
      const adapter =
        e.fn === "stdin.onData"
          ? (cbT.params.length === 0 ? "scr_stdin_data_thunk0" : "scr_stdin_data_thunk_bytes")
          : (cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error");
      const sym = e.fn === "stdin.onData" ? "scr_stdin_on_data" : "scr_stdin_on_error";
      this.declare(`declare void @${adapter}(ptr, ptr)`);
      this.declare(`declare void @${sym}(ptr, ptr, i1 zeroext)`);
      B.line(`call void @${sym}(ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "process.onSignal") {
      // The registry owns the callback (zero-param — frontend-pinned)
      // until off/once removes it. The loop dispatches deliveries.
      this.usesTimers = true;
      const sig = this.emitExpr(e.args[0]!);
      const cb = this.emitExpr(e.args[1]!);
      const once = this.emitExpr(e.args[2]!);
      this.moveTemp(cb);
      this.declare(`declare void @scr_signal_on(double, ptr, i1 zeroext)`);
      B.line(`call void @scr_signal_on(double ${sig.name}, ptr ${cb.name}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "process.onExit") {
      // Runtime adapters cover both shapes (the code is a plain double);
      // the registry owns the callback.
      const cbT = e.args[0]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: process.onExit callback not a func");
      const cb = this.emitExpr(e.args[0]!);
      const once = this.emitExpr(e.args[1]!);
      this.moveTemp(cb);
      const adapter = cbT.params.length === 0 ? "scr_exit_thunk0" : "scr_exit_thunk_code";
      this.declare(`declare void @${adapter}(ptr, double)`);
      this.declare(`declare void @scr_process_on_exit(ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_process_on_exit(ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "timers.unref" || e.fn === "timers.ref" || e.fn === "timers.refresh" || e.fn === "timers.immediateUnref" || e.fn === "timers.immediateRef") {
      // The chaining forms: bookkeep, then yield the handle itself (the
      // C comma expressions).
      const h = this.emitExpr(e.args[0]!);
      const sym = {
        "timers.unref": "scr_timer_unref",
        "timers.ref": "scr_timer_ref",
        "timers.refresh": "scr_timer_refresh",
        "timers.immediateUnref": "scr_immediate_unref",
        "timers.immediateRef": "scr_immediate_ref",
      }[e.fn];
      this.declare(`declare void @${sym}(double)`);
      B.line(`call void @${sym}(double ${h.name})`);
      return { name: h.name, type: e.type };
    }
    if (e.fn === "sp.get") {
      // `string | null` — the sym.desc pattern with a null arm: the
      // runtime answers a +1 string or NULL.
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: sp.get result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (strTag < 0 || nullTag < 0) throw new Error("llvm emitter bug: sp.get union lacks its arms");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare ptr @scr_sp_get(ptr, ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_sp_get(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      return this.wrapNullable(raw, raw, STRING, strTag, e.type, nullTag);
    }
    if (e.fn === "timers.clearTimeout" || e.fn === "timers.clearInterval") {
      const h = this.emitExpr(e.args[0]!);
      this.declare(`declare void @scr_clear_interval(double)`);
      B.line(`call void @scr_clear_interval(double ${h.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "timers.clearNoop") {
      // clearTimeout(null) and friends: Node silently ignores
      // non-handles — nothing runs (arguments still evaluate).
      for (const a of e.args) this.emitExpr(a);
      return { name: "", type: e.type };
    }
    if (e.fn === "qs.parse") {
      // The ParsedUrlQuery dictionary: a fresh pure-index-signature
      // record whose overflow map the runtime scan fills
      // (scr_qs_parse_into groups repeats into string[] buckets) — the
      // C emitter's shape exactly. The frontend verified the structure;
      // lookups here only guard emitter bugs. Args: qs, sep, eq, maxKeys.
      if (e.type.kind !== "record") throw new Error("llvm emitter bug: qs.parse result is not a record");
      const dictShape = this.recordsById.get(e.type.shapeId);
      const iv = dictShape?.indexValue;
      if (!dictShape || iv?.kind !== "union") throw new Error("llvm emitter bug: qs.parse dict shape");
      const ivDef = this.unionsById.get(iv.unionId);
      const strTag = ivDef?.arms.findIndex((a) => a.kind === "string") ?? -1;
      const arrTag = ivDef?.arms.findIndex((a) => a.kind === "array") ?? -1;
      if (strTag < 0 || arrTag < 0) throw new Error("llvm emitter bug: qs.parse index union lacks its arms");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare void @scr_qs_parse_into(ptr, ptr, ptr, ptr, double, i32, i32)`);
      const dict = B.tmp();
      B.line(`${dict} = call ptr @${mangleRecordNew(e.type.shapeId)}()`);
      const out = this.own({ name: dict, type: e.type });
      const ovf = this.recordOvfPtr(dict, e.type.shapeId);
      B.line(
        `call void @scr_qs_parse_into(ptr ${ovf}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, double ${args[3]!.name}, i32 ${strTag}, i32 ${arrTag})`,
      );
      return out;
    }
    if (e.fn === "os.networkInterfaces") {
      // The Dict<NetworkInterfaceInfo[]> record, built inline from a
      // getifaddrs(3) snapshot — emit-exprs.ts's builder, block-lowered.
      // Every shape/union/tag below comes from the call's own type; the
      // frontend verified the structure, so lookups only guard against
      // emitter bugs. Rows append to their interface's bucket in snapshot
      // order; a first row makes the bucket (a fresh Info[] wrapped into
      // the `Info[] | undefined` union arm the overflow map stores).
      if (e.type.kind !== "record") throw new Error("llvm emitter bug: networkInterfaces result is not a record");
      const dictShape = this.recordsById.get(e.type.shapeId);
      const iv = dictShape?.indexValue;
      if (!dictShape || iv?.kind !== "union") throw new Error("llvm emitter bug: networkInterfaces dict shape");
      const ivDef = this.unionsById.get(iv.unionId);
      const arrTag = ivDef?.arms.findIndex((a) => a.kind === "array") ?? -1;
      const arrT = ivDef?.arms[arrTag];
      if (arrT?.kind !== "array" || arrT.elem.kind !== "union") throw new Error("llvm emitter bug: networkInterfaces bucket type");
      const infoT = arrT.elem;
      const infoDef = this.unionsById.get(infoT.unionId);
      if (!infoDef || infoDef.arms.length !== 2) throw new Error("llvm emitter bug: networkInterfaces Info union");
      const tag6 = infoDef.arms.findIndex(
        (a) => a.kind === "record" && this.recordsById.get(a.shapeId)?.fields.find((f) => f.name === "scopeid")?.type.kind === "f64",
      );
      const tag4 = 1 - tag6;
      this.declare(`declare ptr @scr_os_ifaddrs()`);
      this.declare(`declare ${this.sizeType} @scr_os_ifaddrs_count(ptr)`);
      this.declare(`declare ptr @scr_os_ifaddrs_name(ptr, ${this.sizeType})`);
      this.declare(`declare ptr @scr_os_ifaddrs_address(ptr, ${this.sizeType})`);
      this.declare(`declare ptr @scr_os_ifaddrs_netmask(ptr, ${this.sizeType})`);
      this.declare(`declare ptr @scr_os_ifaddrs_family(ptr, ${this.sizeType})`);
      this.declare(`declare ptr @scr_os_ifaddrs_mac(ptr, ${this.sizeType})`);
      this.declare(`declare zeroext i1 @scr_os_ifaddrs_internal(ptr, ${this.sizeType})`);
      this.declare(`declare zeroext i1 @scr_os_ifaddrs_ipv6(ptr, ${this.sizeType})`);
      this.declare(`declare ptr @scr_os_ifaddrs_cidr(ptr, ${this.sizeType})`);
      this.declare(`declare double @scr_os_ifaddrs_scopeid(ptr, ${this.sizeType})`);
      this.declare(`declare void @scr_os_ifaddrs_free(ptr)`);
      this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
      this.declare(`declare ptr @scr_union_retain_v(ptr)`);
      this.declare(`declare void @scr_union_release(ptr)`);
      this.declare(`declare ptr @scr_str_retain_v(ptr)`);
      this.declare(`declare void @scr_str_release_v(ptr)`);
      this.declare(`declare void @scr_str_release(ptr)`);
      this.declare(`declare ptr @scr_arr_retain_v(ptr)`);
      this.declare(`declare void @scr_arr_release(ptr)`);
      this.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
      this.declare(`declare void @scr_map_set_str_ref(ptr, ptr, ptr)`);
      const dict = B.tmp();
      B.line(`${dict} = call ptr @${mangleRecordNew(e.type.shapeId)}()`);
      const out = this.own({ name: dict, type: e.type });
      const ovf = this.recordOvfPtr(dict, e.type.shapeId);
      const snap = B.tmp();
      const cnt = B.tmp();
      B.line(`${snap} = call ptr @scr_os_ifaddrs()`);
      B.line(`${cnt} = call ${this.sizeType} @scr_os_ifaddrs_count(ptr ${snap})`);
      const iSlot = B.slot();
      const rowSlot = B.slot();
      B.entryAllocas.push(`${iSlot} = alloca ${this.sizeType}`, `${rowSlot} = alloca ptr`);
      B.line(`store ${this.sizeType} 0, ptr ${iSlot}`);
      const lc = B.newLabel("ni.c");
      const lb = B.newLabel("ni.b");
      const le = B.newLabel("ni.e");
      B.br(lc);
      B.startBlock(lc);
      const i = B.tmp();
      const cont = B.tmp();
      B.line(`${i} = load ${this.sizeType}, ptr ${iSlot}`);
      B.line(`${cont} = icmp ult ${this.sizeType} ${i}, ${cnt}`);
      B.condBr(cont, lb, le);
      B.startBlock(lb);
      const isV6 = B.tmp();
      B.line(`${isV6} = call zeroext i1 @scr_os_ifaddrs_ipv6(ptr ${snap}, ${this.sizeType} ${i})`);
      const l6 = B.newLabel("ni.v6");
      const l4 = B.newLabel("ni.v4");
      const lRow = B.newLabel("ni.r");
      B.condBr(isV6, l6, l4);
      const emitRow = (tag: number, v6: boolean): void => {
        const t = infoDef.arms[tag];
        if (t?.kind !== "record") throw new Error("llvm emitter bug: networkInterfaces Info arm");
        const shape = this.recordsById.get(t.shapeId);
        if (!shape) throw new Error("llvm emitter bug: networkInterfaces Info shape");
        const cidrT = shape.fields.find((f) => f.name === "cidr")?.type;
        const cidrDef = cidrT?.kind === "union" ? this.unionsById.get(cidrT.unionId) : undefined;
        if (cidrT?.kind !== "union" || !cidrDef) throw new Error("llvm emitter bug: networkInterfaces cidr type");
        const cidrStrTag = cidrDef.arms.findIndex((a) => a.kind === "string");
        const cidrNullTag = cidrDef.arms.findIndex((a) => a.kind === "nullT");
        const r = B.tmp();
        B.line(`${r} = call ptr @${mangleRecordNew(t.shapeId)}()`);
        for (const [field, sym] of [
          ["address", "scr_os_ifaddrs_address"],
          ["netmask", "scr_os_ifaddrs_netmask"],
          ["family", "scr_os_ifaddrs_family"],
          ["mac", "scr_os_ifaddrs_mac"],
        ] as const) {
          const v = B.tmp();
          B.line(`${v} = call ptr @${sym}(ptr ${snap}, ${this.sizeType} ${i}) ; +1`);
          B.line(`store ptr ${v}, ptr ${this.recordFieldPtr(r, t.shapeId, field).ptr}`);
        }
        const internal = B.tmp();
        B.line(`${internal} = call zeroext i1 @scr_os_ifaddrs_internal(ptr ${snap}, ${this.sizeType} ${i})`);
        this.storeField(this.recordFieldPtr(r, t.shapeId, "internal").ptr, { kind: "bool" }, internal);
        const cs = B.tmp();
        B.line(`${cs} = call ptr @scr_os_ifaddrs_cidr(ptr ${snap}, ${this.sizeType} ${i}) ; +1 or null`);
        const hasCidr = B.tmp();
        B.line(`${hasCidr} = icmp ne ptr ${cs}, null`);
        const lcs = B.newLabel("ni.cs");
        const lcn = B.newLabel("ni.cn");
        const lcj = B.newLabel("ni.cj");
        const cidrSlot = B.slot();
        B.entryAllocas.push(`${cidrSlot} = alloca ptr`);
        B.condBr(hasCidr, lcs, lcn);
        B.startBlock(lcs);
        const cu = B.tmp();
        B.line(`${cu} = call ptr @scr_union_new_ref(i32 ${cidrStrTag}, ptr ${cs}, ptr @scr_str_retain_v, ptr @scr_str_release_v, ptr null)`);
        B.line(`store ptr ${cu}, ptr ${cidrSlot}`);
        B.br(lcj);
        B.startBlock(lcn);
        const cn = B.tmp();
        B.line(`${cn} = call ptr @scr_union_retain_v(ptr ${this.unitInstanceRef(cidrT.unionId, cidrNullTag)})`);
        B.line(`store ptr ${cn}, ptr ${cidrSlot}`);
        B.br(lcj);
        B.startBlock(lcj);
        const cv = B.tmp();
        B.line(`${cv} = load ptr, ptr ${cidrSlot}`);
        B.line(`store ptr ${cv}, ptr ${this.recordFieldPtr(r, t.shapeId, "cidr").ptr}`);
        if (v6) {
          const sc = B.tmp();
          B.line(`${sc} = call double @scr_os_ifaddrs_scopeid(ptr ${snap}, ${this.sizeType} ${i})`);
          this.storeField(this.recordFieldPtr(r, t.shapeId, "scopeid").ptr, F64, sc);
        } else {
          const st = shape.fields.find((f) => f.name === "scopeid")?.type;
          if (st?.kind !== "union") throw new Error("llvm emitter bug: networkInterfaces IPv4 scopeid type");
          const undefTag = this.undefinedArmTag(st);
          const su = B.tmp();
          B.line(`${su} = call ptr @scr_union_retain_v(ptr ${this.unitInstanceRef(st.unionId, undefTag)})`);
          B.line(`store ptr ${su}, ptr ${this.recordFieldPtr(r, t.shapeId, "scopeid").ptr}`);
        }
        const rc = vAdapters(this, t);
        const rowU = B.tmp();
        B.line(`${rowU} = call ptr @scr_union_new_ref(i32 ${tag}, ptr ${r}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, t)})`);
        B.line(`store ptr ${rowU}, ptr ${rowSlot}`);
        B.br(lRow);
      };
      B.startBlock(l6);
      emitRow(tag6, true);
      B.startBlock(l4);
      emitRow(tag4, false);
      B.startBlock(lRow);
      const row = B.tmp();
      B.line(`${row} = load ptr, ptr ${rowSlot}`);
      const nm = B.tmp();
      B.line(`${nm} = call ptr @scr_os_ifaddrs_name(ptr ${snap}, ${this.sizeType} ${i}) ; +1`);
      const cell = B.tmp();
      B.line(`${cell} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${nm})`);
      const hasCell = B.tmp();
      B.line(`${hasCell} = icmp ne ptr ${cell}, null`);
      const lh = B.newLabel("ni.h");
      const lm = B.newLabel("ni.m");
      const lj = B.newLabel("ni.j");
      const rowsSlot = B.slot();
      B.entryAllocas.push(`${rowsSlot} = alloca ptr`);
      B.condBr(hasCell, lh, lm);
      B.startBlock(lh);
      const peeked = this.unionPeek(cell);
      const retained = B.tmp();
      B.line(`${retained} = call ptr @scr_arr_retain_v(ptr ${peeked})`);
      B.line(`store ptr ${retained}, ptr ${rowsSlot}`);
      B.line(`call void @scr_union_release(ptr ${cell})`);
      B.br(lj);
      B.startBlock(lm);
      const fresh = B.tmp();
      B.line(`${fresh} = ${arrNewCall(this, infoT, "1")}`);
      const arrRc = vAdapters(this, arrT);
      const freshRet = B.tmp();
      B.line(`${freshRet} = call ptr @scr_arr_retain_v(ptr ${fresh})`);
      const bucketU = B.tmp();
      B.line(`${bucketU} = call ptr @scr_union_new_ref(i32 ${arrTag}, ptr ${freshRet}, ptr ${arrRc.retain}, ptr ${arrRc.release}, ptr ${traceArg(this, arrT)})`);
      B.line(`call void @scr_map_set_str_ref(ptr ${ovf}, ptr ${nm}, ptr ${bucketU})`);
      B.line(`store ptr ${fresh}, ptr ${rowsSlot}`);
      B.br(lj);
      B.startBlock(lj);
      const rows = B.tmp();
      B.line(`${rows} = load ptr, ptr ${rowsSlot}`);
      this.arrPush(rows, "ref", row); // push takes ownership of the row
      B.line(`call void @scr_arr_release(ptr ${rows})`);
      B.line(`call void @scr_str_release(ptr ${nm})`);
      const i2 = B.tmp();
      B.line(`${i2} = add ${this.sizeType} ${i}, 1`);
      B.line(`store ${this.sizeType} ${i2}, ptr ${iSlot}`);
      B.br(lc);
      B.startBlock(le);
      B.line(`call void @scr_os_ifaddrs_free(ptr ${snap})`);
      return out;
    }
    if (e.fn === "fs.readdirTypesSync") {
      // Dirent rows assembled inline from one scandir snapshot — the C
      // emitter's flat loop. The snapshot call throws Node's scandir
      // error and answers NULL then, so the pending check runs before
      // any allocation.
      if (e.type.kind !== "array" || e.type.elem.kind !== "record") {
        throw new Error("llvm emitter bug: readdirTypesSync result is not a record array");
      }
      const recT = e.type.elem;
      const path = this.emitExpr(e.args[0]!);
      this.declare(`declare ptr @scr_fs_scandir(ptr)`);
      this.declare(`declare ${this.sizeType} @scr_fs_scandir_count(ptr)`);
      this.declare(`declare ptr @scr_fs_scandir_name(ptr, ${this.sizeType})`);
      this.declare(`declare double @scr_fs_scandir_type(ptr, ${this.sizeType})`);
      this.declare(`declare void @scr_fs_scandir_free(ptr)`);
      const snap = B.tmp();
      B.line(`${snap} = call ptr @scr_fs_scandir(ptr ${path.name})`);
      this.emitPendingCheck();
      const cnt = B.tmp();
      B.line(`${cnt} = call ${this.sizeType} @scr_fs_scandir_count(ptr ${snap})`);
      const arr = B.tmp();
      B.line(`${arr} = ${arrNewCall(this, recT, cnt)}`);
      const out = this.own({ name: arr, type: e.type });
      const iSlot = B.slot();
      B.entryAllocas.push(`${iSlot} = alloca ${this.sizeType}`);
      B.line(`store ${this.sizeType} 0, ptr ${iSlot}`);
      const lc = B.newLabel("sd.c");
      const lb = B.newLabel("sd.b");
      const le = B.newLabel("sd.e");
      B.br(lc);
      B.startBlock(lc);
      const i = B.tmp();
      const cont = B.tmp();
      B.line(`${i} = load ${this.sizeType}, ptr ${iSlot}`);
      B.line(`${cont} = icmp ult ${this.sizeType} ${i}, ${cnt}`);
      B.condBr(cont, lb, le);
      B.startBlock(lb);
      const row = B.tmp();
      B.line(`${row} = call ptr @${mangleRecordNew(recT.shapeId)}()`);
      const dt = B.tmp();
      B.line(`${dt} = call double @scr_fs_scandir_type(ptr ${snap}, ${this.sizeType} ${i})`);
      this.storeField(this.recordFieldPtr(row, recT.shapeId, "%dtype").ptr, F64, dt);
      const nm = B.tmp();
      B.line(`${nm} = call ptr @scr_fs_scandir_name(ptr ${snap}, ${this.sizeType} ${i}) ; +1`);
      B.line(`store ptr ${nm}, ptr ${this.recordFieldPtr(row, recT.shapeId, "name").ptr}`);
      B.line(`store ptr ${this.retainValue(path.name, STRING)}, ptr ${this.recordFieldPtr(row, recT.shapeId, "parentPath").ptr}`);
      this.arrPush(arr, "ref", row); // push takes ownership of the row
      const i2 = B.tmp();
      B.line(`${i2} = add ${this.sizeType} ${i}, 1`);
      B.line(`store ${this.sizeType} ${i2}, ptr ${iSlot}`);
      B.br(lc);
      B.startBlock(le);
      B.line(`call void @scr_fs_scandir_free(ptr ${snap})`);
      return out;
    }
    if (e.fn === "assert.shapeStr" || e.fn === "assert.shapeRe") {
      // The throws(fn, {shape}) accumulator's slot writers: the key is a
      // C int (the generic path would pass a double through the ABI —
      // fptosi here, exactly the C prototype's implicit conversion).
      // Never throw.
      const key = this.emitExpr(e.args[0]!);
      const v = this.emitExpr(e.args[1]!);
      const sym = e.fn === "assert.shapeStr" ? "scr_assert_shape_str" : "scr_assert_shape_re";
      this.declare(`declare void @${sym}(i32, ptr)`);
      const k32 = B.tmp();
      B.line(`${k32} = fptosi double ${key.name} to i32`);
      B.line(`call void @${sym}(i32 ${k32}, ptr ${v.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "emitter.on") {
      // (recv, name, cb /moves — the identity/, once, prepend): the
      // listener registers through scr_emitter_on_via with an emitted
      // fixed-arity adapter closure (what emit invokes) and the runtime's
      // matching va_list shim — the C backend's emitterInvokeThunkFor
      // split across the C/LLVM boundary. May-throw ('newListener' meta
      // listeners run inside).
      const cbT = e.args[2]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: emitter.on listener not a func");
      const args = e.args.map((a) => this.emitExpr(a));
      const { fn: adapterFn, shim } = this.emitterFixedAdapter(cbT);
      // The wrapper's capture box owns its OWN +1 of the listener; the
      // frame's +1 moves in as the entry's identity (orig).
      this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
      const cbr = B.tmp();
      B.line(`${cbr} = call ptr @scr_closure_retain_v(ptr ${args[2]!.name})`);
      const wrapped = this.wrapEmitterListener(cbr, adapterFn);
      this.moveTemp(args[2]!);
      this.declare(`declare ptr @scr_emitter_on_via(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`);
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_emitter_on_via(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
          `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @${shim}, i1 ${args[3]!.name}, i1 ${args[4]!.name})`,
      );
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "emitter.onDyn") {
      // (recv, name, cb /borrowed dyn — the identity/, adapter /moves/,
      // once, prepend): the frontend's dyn adapter (it boxes the tuple to
      // dyn and calls the original through the checked-dynamic machinery)
      // rides behind the same fixed-arity wrapper; the runtime keeps the
      // dyn box's underlying closure as the entry's identity.
      const adT = e.args[3]!.type;
      if (adT.kind !== "func") throw new Error("llvm emitter bug: emitter.onDyn adapter not a func");
      const args = e.args.map((a) => this.emitExpr(a));
      const { fn: adapterFn, shim } = this.emitterFixedAdapter(adT);
      this.moveTemp(args[3]!); // the frame's +1 moves into the wrapper's box
      const wrapped = this.wrapEmitterListener(args[3]!.name, adapterFn);
      this.declare(`declare ptr @scr_emitter_on_dyn(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`);
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_emitter_on_dyn(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
          `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @${shim}, i1 ${args[4]!.name}, i1 ${args[5]!.name})`,
      );
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "emitter.emit") {
      // The variadic dispatch: the event's unified tuple rides the C
      // variadic tail POINTER-CLASSED. Scalar values ride pointers to
      // call-lived stack slots, while reference values ride directly; the
      // fixed shim can therefore read one pointer-width slot per argument
      // on both wasm32 and native targets. Every argument is borrowed. May
      // throw (listeners run inside).
      const args = e.args.map((a) => this.emitExpr(a));
      const tuple = args.slice(2).map((a) => {
        const ty = this.llType(a.type);
        if (ty === "double" || ty === "i1") {
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ${ty} ; EventEmitter scalar argument`);
          B.line(`store ${ty} ${a.name}, ptr ${slot}`);
          return `ptr ${slot}`;
        }
        return `ptr ${a.name}`;
      });
      this.declare(`declare zeroext i1 @scr_emitter_emit(ptr, ptr, ...)`);
      const call = `call zeroext i1 (ptr, ptr, ...) @scr_emitter_emit(` +
        [`ptr ${args[0]!.name}`, `ptr ${args[1]!.name}`, ...tuple].join(", ") + `)`;
      if (e.type.kind === "void") {
        B.line(`${B.tmp()} = ${call}`);
        this.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const t = B.tmp();
      B.line(`${t} = ${call}`);
      this.emitPendingCheck();
      return { name: t, type: e.type };
    }
    if (e.fn === "emitter.emitData") {
      // A user emit('data', chunk) on a stream-rooted receiver: fill the
      // matching payload slot of the two-slot 'data' ABI, NULL the other.
      const args = e.args.map((a) => this.emitExpr(a));
      const chunkT = e.args[2]!.type;
      const both = chunkT.kind === "string"
        ? [`ptr null`, `ptr ${args[2]!.name}`]
        : [`ptr ${args[2]!.name}`, `ptr null`];
      this.declare(`declare zeroext i1 @scr_emitter_emit(ptr, ptr, ...)`);
      const t = B.tmp();
      B.line(
        `${t} = call zeroext i1 (ptr, ptr, ...) @scr_emitter_emit(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ${both.join(", ")})`,
      );
      this.emitPendingCheck();
      return e.type.kind === "void" ? { name: "", type: e.type } : { name: t, type: e.type };
    }
    if (e.fn === "emitter.onData" || e.fn === "emitter.onDataDyn") {
      // The stream-'data' registration: same runtime entries as
      // emitter.on/onDyn, but the DATA adapter (the two-slot payload ABI
      // — scr_stream_emit_data) behind the arity-2 fixed shim.
      const isDyn = e.fn === "emitter.onDataDyn";
      const cbT = e.args[isDyn ? 3 : 2]!.type;
      if (cbT.kind !== "func") throw new Error(`llvm emitter bug: ${e.fn} listener not a func`);
      const args = e.args.map((a) => this.emitExpr(a));
      const adapterFn = this.streamDataAdapter(cbT);
      this.declare(`declare void @scr_ee_inv_fixed2(ptr, ptr)`);
      const t = B.tmp();
      if (isDyn) {
        this.moveTemp(args[3]!);
        const wrapped = this.wrapEmitterListener(args[3]!.name, adapterFn);
        this.declare(`declare ptr @scr_emitter_on_dyn(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`);
        B.line(
          `${t} = call ptr @scr_emitter_on_dyn(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
            `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @scr_ee_inv_fixed2, i1 ${args[4]!.name}, i1 ${args[5]!.name})`,
        );
      } else {
        this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
        const cbr = B.tmp();
        B.line(`${cbr} = call ptr @scr_closure_retain_v(ptr ${args[2]!.name})`);
        const wrapped = this.wrapEmitterListener(cbr, adapterFn);
        this.moveTemp(args[2]!);
        this.declare(`declare ptr @scr_emitter_on_via(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`);
        B.line(
          `${t} = call ptr @scr_emitter_on_via(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
            `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @scr_ee_inv_fixed2, i1 ${args[3]!.name}, i1 ${args[4]!.name})`,
        );
      }
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (/^(readable|writable|duplex|transform|passthrough)\.(new|init)$/.test(e.fn)) {
      // Head args then flags then the PRESENT option callbacks in
      // canonical order (the flags literal names which; absent ones pass
      // NULL pairs). The .init forms carry the BORROWED receiver at arg 0
      // and shift everything by one (emit-exprs.ts's shape, ported).
      const base = e.fn.slice(0, e.fn.indexOf("."));
      const isInit = e.fn.endsWith(".init");
      const off = isInit ? 1 : 0;
      const duplexShape = base !== "readable" && base !== "writable";
      const headLen = duplexShape ? 8 : 4;
      const flagsArg = e.args[off + headLen - 1]!;
      if (flagsArg.kind !== "numLit") throw new Error(`llvm emitter bug: ${e.fn} flags not a literal`);
      const flags = flagsArg.value;
      const args = e.args.map((a) => this.emitExpr(a));
      const canonical = STREAM_CANONICAL_CBS[base]!;
      const cbArgs: string[] = [];
      let at = off + headLen;
      for (let i = 0; i < canonical.length; i++) {
        if ((flags & (1 << i)) === 0) {
          cbArgs.push("ptr null", "ptr null");
          continue;
        }
        const cb = args[at]!;
        const cbT = e.args[at]!.type;
        this.moveTemp(cb); // the callback closure MOVES into the stream
        cbArgs.push(`ptr ${cb.name}`, `ptr @${this.streamCbThunkFor(canonical[i]!, cbT)}`);
        at++;
      }
      const entry = isInit ? `scr_stream_init_${base}` : `scr_stream_new_${base}`;
      const headIdx = duplexShape ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2];
      const head = headIdx.map((i) => {
        const a = args[off + i]!;
        const ty = this.llType(a.type);
        return `${ty} ${a.name}`;
      });
      const headDecl = headIdx.map((i) => (this.llType(args[off + i]!.type) === "i1" ? "i1 zeroext" : this.llType(args[off + i]!.type)));
      const cbDecl = cbArgs.map(() => "ptr");
      if (isInit) {
        this.declare(`declare void @${entry}(ptr, ${[...headDecl, ...cbDecl].join(", ")})`);
        B.line(`call void @${entry}(${[`ptr ${args[0]!.name}`, ...head, ...cbArgs].join(", ")})`);
        return { name: "", type: e.type };
      }
      this.declare(`declare ptr @${entry}(${[...headDecl, ...cbDecl].join(", ")})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${entry}(${[...head, ...cbArgs].join(", ")})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "stream.setRead" || e.fn === "stream.setWrite" || e.fn === "stream.setFinal" || e.fn === "stream.setDestroy" || e.fn === "stream.setTransform" || e.fn === "stream.setFlush") {
      // The underscore-method assignment surface: the runtime slot swaps
      // its closure (+1 moves in) and invoke thunk — the next
      // _read/_write/... dispatch uses it, Node's timing.
      const kindOf: Record<string, "r" | "w" | "f" | "d" | "t" | "l"> = {
        "stream.setRead": "r", "stream.setWrite": "w", "stream.setFinal": "f",
        "stream.setDestroy": "d", "stream.setTransform": "t", "stream.setFlush": "l",
      };
      const symOf: Record<string, string> = {
        "stream.setRead": "scr_stream_set_read", "stream.setWrite": "scr_stream_set_write",
        "stream.setFinal": "scr_stream_set_final", "stream.setDestroy": "scr_stream_set_destroy",
        "stream.setTransform": "scr_stream_set_transform", "stream.setFlush": "scr_stream_set_flush",
      };
      const recv = this.emitExpr(e.args[0]!);
      const cb = this.emitExpr(e.args[1]!);
      const cbT = e.args[1]!.type;
      this.moveTemp(cb); // the callback closure MOVES into the stream
      const sym = symOf[e.fn]!;
      this.declare(`declare void @${sym}(ptr, ptr, ptr)`);
      B.line(`call void @${sym}(ptr ${recv.name}, ptr ${cb.name}, ptr @${this.streamCbThunkFor(kindOf[e.fn]!, cbT)})`);
      return { name: "", type: e.type };
    }
    if (/^(readable|writable|duplex|transform|passthrough)\.initDyn$/.test(e.fn)) {
      // The dyn-options super(options): borrowed receiver + record, then
      // the FALLBACK underscore-method wrappers in canonical order (the
      // flags literal names which; wrappers MOVE). MAY THROW.
      const base = e.fn.slice(0, e.fn.indexOf("."));
      const flagsArg = e.args[2]!;
      if (flagsArg.kind !== "numLit") throw new Error(`llvm emitter bug: ${e.fn} flags not a literal`);
      const flags = flagsArg.value;
      const args = e.args.map((a) => this.emitExpr(a));
      const canonical = STREAM_CANONICAL_CBS[base]!;
      const cbArgs: string[] = [];
      let at = 3;
      for (let i = 0; i < canonical.length; i++) {
        if ((flags & (1 << i)) === 0) {
          cbArgs.push("ptr null", "ptr null");
          continue;
        }
        const cb = args[at]!;
        const cbT = e.args[at]!.type;
        this.moveTemp(cb);
        cbArgs.push(`ptr ${cb.name}`, `ptr @${this.streamCbThunkFor(canonical[i]!, cbT)}`);
        at++;
      }
      const entry = `scr_stream_init_${base}_dyn`;
      this.declare(`declare void @${entry}(ptr, ptr, ${cbArgs.map(() => "ptr").join(", ")})`);
      B.line(`call void @${entry}(${[`ptr ${args[0]!.name}`, `ptr ${args[1]!.name}`, ...cbArgs].join(", ")})`);
      this.emitPendingCheck();
      return { name: "", type: e.type };
    }
    if (e.fn === "readable.pushU" || e.fn === "writable.writeU") {
      // Union-typed chunk: dispatch by tag (bytes / string / null arms —
      // the frontend admitted exactly those). May throw (write_null's
      // ERR_STREAM_NULL_VALUES; listeners run inside).
      const t = e.args[1]!.type;
      if (t.kind !== "union") throw new Error(`llvm emitter bug: ${e.fn} chunk not a union`);
      const def = this.unionsById.get(t.unionId);
      if (!def) throw new Error(`llvm emitter bug: ${e.fn} union unknown`);
      const args = e.args.map((a) => this.emitExpr(a));
      const pushing = e.fn === "readable.pushU";
      const entries: Record<string, string> = pushing
        ? { bytes: "scr_stream_push", string: "scr_stream_push_str", nullT: "scr_stream_push_null" }
        : { bytes: "scr_stream_write", string: "scr_stream_write_str", nullT: "scr_stream_write_null" };
      const present = (["nullT", "string", "bytes"] as const)
        .map((kind) => ({ kind, tag: def.arms.findIndex((a) => a.kind === kind) }))
        .filter((a) => a.tag >= 0);
      if (present.length === 0) throw new Error(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const tagP = B.tmp();
      const tag = B.tmp();
      B.line(`${tagP} = getelementptr inbounds %ScrUnion, ptr ${args[1]!.name}, i64 0, i32 1`);
      B.line(`${tag} = load i32, ptr ${tagP}`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca i1`);
      const lj = B.newLabel("scu.j");
      const emitArm = (kind: "bytes" | "string" | "nullT"): void => {
        const entry = entries[kind]!;
        if (kind === "nullT") {
          this.declare(`declare zeroext i1 @${entry}(ptr)`);
          const r = B.tmp();
          B.line(`${r} = call zeroext i1 @${entry}(ptr ${args[0]!.name})`);
          B.line(`store i1 ${r}, ptr ${slot}`);
          return;
        }
        const pk = B.tmp();
        const pv = B.tmp();
        B.line(`${pk} = getelementptr inbounds %ScrUnion, ptr ${args[1]!.name}, i64 0, i32 5`);
        B.line(`${pv} = load ptr, ptr ${pk} ; borrowed payload`);
        const r = B.tmp();
        if (pushing) {
          this.declare(`declare zeroext i1 @${entry}(ptr, ptr)`);
          B.line(`${r} = call zeroext i1 @${entry}(ptr ${args[0]!.name}, ptr ${pv})`);
        } else {
          this.declare(`declare zeroext i1 @${entry}(ptr, ptr, ptr)`);
          B.line(`${r} = call zeroext i1 @${entry}(ptr ${args[0]!.name}, ptr ${pv}, ptr null)`);
        }
        B.line(`store i1 ${r}, ptr ${slot}`);
      };
      // The C shape is a ternary chain ending at the LAST present arm
      // (no default): mirror with a tag switch whose default is that arm.
      const last = present[present.length - 1]!;
      const labels = present.slice(0, -1).map((a) => ({ ...a, label: B.newLabel(`scu.${a.kind}`) }));
      const ld = B.newLabel("scu.d");
      if (labels.length > 0) {
        B.terminate(
          `switch i32 ${tag}, label %${ld} [ ${labels.map((a) => `i32 ${a.tag}, label %${a.label}`).join(" ")} ]`,
        );
      } else {
        B.br(ld);
      }
      for (const a of labels) {
        B.startBlock(a.label);
        emitArm(a.kind);
        B.br(lj);
      }
      B.startBlock(ld);
      emitArm(last.kind);
      B.br(lj);
      B.startBlock(lj);
      const rv = B.tmp();
      B.line(`${rv} = load i1, ptr ${slot}`);
      this.emitPendingCheck();
      return e.type.kind === "void" ? { name: "", type: e.type } : { name: rv, type: e.type };
    }
    if (e.fn === "readable.read") {
      // +1 Buffer or NULL → the `Buffer | null` union, constructed
      // type-directedly (the C error.code pattern); the pending check
      // runs between the call and the wrap (encoded streams throw).
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: readable.read result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (bytesTag < 0 || nullTag < 0) throw new Error("llvm emitter bug: readable.read union lacks its arms");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare ptr @scr_stream_read(ptr, double)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_stream_read(ptr ${args[0]!.name}, double ${args[1]!.name})`);
      const b = this.own({ name: raw, type: def!.arms[bytesTag]! });
      this.emitPendingCheck();
      this.moveTemp(b); // moves into the union arm when present
      return this.wrapNullable(raw, raw, def!.arms[bytesTag]!, bytesTag, e.type, nullTag);
    }
    if (e.fn === "readable.flowing") {
      // -1 (null: never kicked) / 0 / 1 → the `boolean | null` union.
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: readable.flowing result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const boolTag = def ? def.arms.findIndex((a) => a.kind === "bool") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (boolTag < 0 || nullTag < 0) throw new Error("llvm emitter bug: readable.flowing union lacks its arms");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare double @scr_stream_flowing(ptr)`);
      this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      const f = B.tmp();
      B.line(`${f} = call double @scr_stream_flowing(ptr ${args[0]!.name})`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const isNull = B.tmp();
      B.line(`${isNull} = fcmp olt double ${f}, ${f64Lit(0)}`);
      const ln = B.newLabel("fl.n");
      const lb = B.newLabel("fl.b");
      const lj = B.newLabel("fl.j");
      B.condBr(isNull, ln, lb);
      B.startBlock(ln);
      B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, nullTag)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lb);
      const isOn = B.tmp();
      B.line(`${isOn} = fcmp ogt double ${f}, ${f64Lit(0)}`);
      const u = B.tmp();
      B.line(`${u} = call ptr @scr_union_new_bool(i32 ${boolTag}, i1 ${isOn})`);
      B.line(`store ptr ${u}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ptr, ptr ${slot}`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "readable.unpipe") {
      // (src[, dst]) — the absent destination unpipes everything.
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare ptr @scr_stream_unpipe(ptr, ptr)`);
      const dst = e.args.length > 1 ? args[1]!.name : "null";
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_stream_unpipe(ptr ${args[0]!.name}, ptr ${dst})`);
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "writable.write" || e.fn === "writable.writeStr" || e.fn === "writable.writeDyn") {
      // write borrows its chunk; the optional completion callback MOVES.
      const entry = e.fn === "writable.write" ? "scr_stream_write"
        : e.fn === "writable.writeStr" ? "scr_stream_write_str" : "scr_stream_write_dyn";
      const args = e.args.map((a) => this.emitExpr(a));
      let cb = "null";
      if (e.fn !== "writable.writeDyn" && e.args.length > 2) {
        this.moveTemp(args[2]!);
        cb = args[2]!.name;
      }
      this.declare(`declare zeroext i1 @${entry}(ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${cb})`);
      this.emitPendingCheck();
      return e.type.kind === "void" ? { name: "", type: e.type } : { name: t, type: e.type };
    }
    if (e.fn === "writable.end") {
      // (recv, flags[, chunk][, cb]) — flags: 1 bytes chunk, 2 string
      // chunk, 8 dyn chunk (write first, Node's end(chunk) decomposition),
      // 4 callback.
      const flagsArg = e.args[1]!;
      if (flagsArg.kind !== "numLit") throw new Error("llvm emitter bug: writable.end flags not a literal");
      const flags = flagsArg.value;
      const args = e.args.map((a) => this.emitExpr(a));
      let at = 2;
      let chunkB = "null";
      let chunkS = "null";
      let chunkD: string | null = null;
      if (flags & 1) chunkB = args[at++]!.name;
      else if (flags & 2) chunkS = args[at++]!.name;
      else if (flags & 8) chunkD = args[at++]!.name;
      let cbName = "null";
      if (flags & 4) {
        this.moveTemp(args[at]!);
        cbName = args[at]!.name;
      }
      if (chunkD !== null) {
        this.declare(`declare zeroext i1 @scr_stream_write_dyn(ptr, ptr, ptr)`);
        B.line(`${B.tmp()} = call zeroext i1 @scr_stream_write_dyn(ptr ${args[0]!.name}, ptr ${chunkD}, ptr null)`);
      }
      this.declare(`declare ptr @scr_stream_end(ptr, ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_stream_end(ptr ${args[0]!.name}, ptr ${chunkB}, ptr ${chunkS}, ptr ${cbName})`);
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "stream.destroy") {
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare ptr @scr_stream_destroy(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_stream_destroy(ptr ${args[0]!.name}, ptr null)`);
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "stream.prop") {
      // The property NAME is a compile-time literal; args[1]'s emitted
      // temp is unused (released with the statement's frame).
      const nameArg = e.args[1]!;
      if (nameArg.kind !== "strLit") throw new Error("llvm emitter bug: stream.prop name not a literal");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare double @scr_stream_prop(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_stream_prop(ptr ${args[0]!.name}, ptr ${this.cstr(nameArg.value)})`);
      if (e.type.kind === "bool") {
        const b = B.tmp();
        B.line(`${b} = fcmp une double ${t}, ${f64Lit(0)}`);
        return { name: b, type: e.type };
      }
      return { name: t, type: e.type };
    }
    if (e.fn === "stream.errored") {
      // +1 error or NULL → the `Error | null` union.
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: stream.errored result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (errTag < 0 || nullTag < 0) throw new Error("llvm emitter bug: stream.errored union lacks its arms");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare ptr @scr_stream_errored(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_stream_errored(ptr ${args[0]!.name}) ; +1 or NULL`);
      return this.wrapNullable(raw, raw, def!.arms[errTag]!, errTag, e.type, nullTag);
    }
    if (e.fn === "stream.finished" || e.fn === "stream.finishedDyn") {
      // finished(s, cb): the +1 cleanup closure answers. Typed callbacks
      // ride the "e" thunk; dyn values ride the runtime's own inv.
      const args = e.args.map((a) => this.emitExpr(a));
      const t = B.tmp();
      if (e.fn === "stream.finishedDyn") {
        this.declare(`declare ptr @scr_stream_finished_dyn(ptr, ptr)`);
        B.line(`${t} = call ptr @scr_stream_finished_dyn(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      } else {
        const cbT = e.args[1]!.type;
        if (cbT.kind !== "func") throw new Error("llvm emitter bug: stream.finished callback not a func");
        this.moveTemp(args[1]!); // the watcher closure MOVES into the stream
        const thunk = this.streamCbThunkFor("e", cbT);
        this.declare(`declare ptr @scr_stream_finished(ptr, ptr, ptr)`);
        B.line(`${t} = call ptr @scr_stream_finished(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${thunk})`);
      }
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "sp.pipeline") {
      // pipeline(count, s1..sn) settling a void promise: the stream list
      // rides the callback form's stack array, no callback slot.
      const countArg = e.args[0]!;
      if (countArg.kind !== "numLit") throw new Error(`llvm emitter bug: ${e.fn} count not a literal`);
      const n = countArg.value;
      const args = e.args.map((a) => this.emitExpr(a));
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${n} x ptr]`);
      for (let i = 0; i < n; i++) {
        const p = B.tmp();
        B.line(`${p} = getelementptr inbounds [${n} x ptr], ptr ${arr}, i64 0, i64 ${i}`);
        B.line(`store ptr ${args[1 + i]!.name}, ptr ${p}`);
      }
      const t = B.tmp();
      this.declare(`declare ptr @scr_sp_pipeline(double, ptr)`);
      B.line(`${t} = call ptr @scr_sp_pipeline(double ${f64Lit(n)}, ptr ${arr})`);
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (e.fn === "stream.pipeline" || e.fn === "stream.pipelineDyn") {
      // pipeline(count, s1..sn, cb): the destination answers +1. The
      // stream list rides a stack array (the C compound literal).
      const countArg = e.args[0]!;
      if (countArg.kind !== "numLit") throw new Error(`llvm emitter bug: ${e.fn} count not a literal`);
      const n = countArg.value;
      const args = e.args.map((a) => this.emitExpr(a));
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${n} x ptr]`);
      for (let i = 0; i < n; i++) {
        const p = B.tmp();
        B.line(`${p} = getelementptr inbounds [${n} x ptr], ptr ${arr}, i64 0, i64 ${i}`);
        B.line(`store ptr ${args[1 + i]!.name}, ptr ${p}`);
      }
      const t = B.tmp();
      if (e.fn === "stream.pipelineDyn") {
        this.declare(`declare ptr @scr_stream_pipeline_dyn(double, ptr, ptr)`);
        B.line(`${t} = call ptr @scr_stream_pipeline_dyn(double ${f64Lit(n)}, ptr ${arr}, ptr ${args[1 + n]!.name})`);
      } else {
        const cbT = e.args[1 + n]!.type;
        if (cbT.kind !== "func") throw new Error("llvm emitter bug: stream.pipeline callback not a func");
        this.moveTemp(args[1 + n]!);
        const thunk = this.streamCbThunkFor("e", cbT);
        this.declare(`declare ptr @scr_stream_pipeline(double, ptr, ptr, ptr)`);
        B.line(`${t} = call ptr @scr_stream_pipeline(double ${f64Lit(n)}, ptr ${arr}, ptr ${args[1 + n]!.name}, ptr @${thunk})`);
      }
      const out = this.own({ name: t, type: e.type });
      this.emitPendingCheck();
      return out;
    }
    // ── node:net + node:http (the server surface): registrations move
    // their callbacks into the handle's registry with runtime-provided
    // adapters; the handful of union-wrapped reads use the envGet shapes.
    if (e.fn === "net.createServer" || e.fn === "net.createServerCb") {
      const args = e.args.map((a) => this.emitExpr(a));
      let cb = "null";
      let adapter = "null";
      if (e.fn === "net.createServerCb") {
        const cbT = e.args[0]!.type;
        if (cbT.kind !== "func") throw new Error("llvm emitter bug: net.createServerCb handler not a func");
        this.moveTemp(args[0]!);
        cb = args[0]!.name;
        adapter = cbT.params.length === 0 ? "@scr_net_conn_thunk0" : "@scr_net_conn_thunk_sock";
        this.declare(`declare void ${adapter}(ptr, ptr)`);
      }
      this.declare(`declare ptr @scr_net_create_server(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_net_create_server(ptr ${cb}, ptr ${adapter})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "net.listen" || e.fn === "net.listenCb") {
      const args = e.args.map((a) => this.emitExpr(a));
      let cb = "null";
      if (e.fn === "net.listenCb") {
        this.moveTemp(args[2]!);
        cb = args[2]!.name;
      }
      this.declare(`declare void @scr_net_listen(ptr, double, ptr)`);
      B.line(`call void @scr_net_listen(ptr ${args[0]!.name}, double ${args[1]!.name}, ptr ${cb})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.listenOpts" || e.fn === "net.listenOptsCb") {
      // The callback slot may be the `(() => void) | undefined` optional-
      // binding union: unwrap to a nullable closure.
      const args = e.args.map((a) => this.emitExpr(a));
      let cb = "null";
      if (e.fn === "net.listenOptsCb") {
        const cbT = e.args[4]!.type;
        if (cbT.kind === "func") {
          this.moveTemp(args[4]!);
          cb = args[4]!.name;
        } else {
          if (cbT.kind !== "union") throw new Error("llvm emitter bug: net.listenOptsCb callback shape");
          const def = this.unionsById.get(cbT.unionId);
          const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
          if (funcTag < 0) throw new Error("llvm emitter bug: net.listenOptsCb union lacks its func arm");
          cb = this.unwrapNullableClosure(args[4]!.name, funcTag);
        }
      }
      const decls = e.args.slice(0, 4).map((a) => (this.llType(a.type) === "i1" ? "i1 zeroext" : this.llType(a.type)));
      this.declare(`declare void @scr_net_listen_opts(${decls.join(", ")}, ptr)`);
      B.line(
        `call void @scr_net_listen_opts(${args.slice(0, 4).map((a) => `${this.llType(a.type)} ${a.name}`).join(", ")}, ptr ${cb})`,
      );
      return { name: "", type: e.type };
    }
    if (e.fn === "net.serverAddress") {
      // The AddressInfo record from the three runtime reads.
      if (e.type.kind !== "record") throw new Error("llvm emitter bug: net.serverAddress result is not a record");
      const recT = e.type;
      const shape = this.recordsById.get(recT.shapeId);
      if (!shape) throw new Error("llvm emitter bug: net.serverAddress record unknown");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare ptr @scr_net_server_addr_ip(ptr)`);
      this.declare(`declare ptr @scr_net_server_addr_family(ptr)`);
      this.declare(`declare double @scr_net_server_port(ptr)`);
      const ip = B.tmp();
      B.line(`${ip} = call ptr @scr_net_server_addr_ip(ptr ${args[0]!.name}) ; +1`);
      const rec = B.tmp();
      B.line(`${rec} = call ptr @${mangleRecordNew(recT.shapeId)}()`);
      const fieldIdx = (name: string): number => {
        const i = shape.fields.findIndex((f) => f.name === name);
        if (i < 0) throw new Error(`llvm emitter bug: net.serverAddress record lacks ${name}`);
        return i + 1;
      };
      const store = (name: string, ty: string, v: string): void => {
        const p = B.tmp();
        B.line(`${p} = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr ${rec}, i64 0, i32 ${fieldIdx(name)}`);
        B.line(`store ${ty} ${v}, ptr ${p} ; ${name}`);
      };
      store("address", "ptr", ip);
      const fam = B.tmp();
      B.line(`${fam} = call ptr @scr_net_server_addr_family(ptr ${args[0]!.name}) ; +1 — "IPv4"/"IPv6"`);
      store("family", "ptr", fam);
      const port = B.tmp();
      B.line(`${port} = call double @scr_net_server_port(ptr ${args[0]!.name})`);
      store("port", "double", port);
      return this.own({ name: rec, type: e.type });
    }
    if (e.fn === "net.serverClose" || e.fn === "net.serverCloseCb") {
      const args = e.args.map((a) => this.emitExpr(a));
      let cb = "null";
      if (e.fn === "net.serverCloseCb") {
        this.moveTemp(args[1]!);
        cb = args[1]!.name;
      }
      this.declare(`declare void @scr_net_server_close(ptr, ptr)`);
      B.line(`call void @scr_net_server_close(ptr ${args[0]!.name}, ptr ${cb})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.serverCloseBind") {
      // The bound REAL close as a value: an emitted adapter behind a
      // fresh closure whose one env slot holds the +1 server.
      if (e.type.kind !== "func") throw new Error("llvm emitter bug: net.serverCloseBind result not a func");
      const args = e.args.map((a) => this.emitExpr(a));
      const fnSym = this.closeBindThunkFor(e.type.params[0]!, e.type.ret.kind === "netServer");
      this.declare(`declare ptr @scr_closure_new(ptr, ${this.sizeType})`);
      this.declare(`declare ptr @scr_box_new_obj(ptr, ptr, ptr)`);
      this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
      this.declare(`declare ptr @scr_net_server_retain_v(ptr)`);
      this.declare(`declare void @scr_net_server_release_v(ptr)`);
      const bound = B.tmp();
      B.line(`${bound} = call ptr @scr_closure_new(ptr @${fnSym}, ${this.sizeType} 1)`);
      const bx = B.tmp();
      B.line(`${bx} = call ptr @scr_box_new_obj(ptr @scr_net_server_retain_v, ptr @scr_net_server_release_v, ptr null)`);
      const capp = B.tmp();
      B.line(`${capp} = getelementptr inbounds %ScrClosure, ptr ${bound}, i64 1`);
      B.line(`store ptr ${bx}, ptr ${capp}`);
      const sr = B.tmp();
      B.line(`${sr} = call ptr @scr_net_server_retain_v(ptr ${args[0]!.name})`);
      B.line(`call void @scr_box_set_ref(ptr ${bx}, ptr ${sr})`);
      return this.own({ name: bound, type: e.type });
    }
    if (e.fn === "net.serverSetCloseOverride") {
      // The override MOVES into the server's slot behind the emitted
      // zero-arg wrapper (the runtime can't build the callback union).
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: close override not a func");
      const args = e.args.map((a) => this.emitExpr(a));
      const wrapSym = this.closeOverrideWrapFor(cbT.params[0]!, cbT.ret.kind === "netServer");
      this.moveTemp(args[1]!); // ownership moves into the wrapper's env box
      const wrap = this.wrapEmitterListener(args[1]!.name, wrapSym);
      this.declare(`declare void @scr_net_server_set_close_override(ptr, ptr)`);
      B.line(`call void @scr_net_server_set_close_override(ptr ${args[0]!.name}, ptr ${wrap})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.serverOnError" || e.fn === "net.sockOnError") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error(`llvm emitter bug: ${e.fn} callback not a func`);
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
      const entry = e.fn === "net.serverOnError" ? "scr_net_server_on_error" : "scr_net_sock_on_error";
      this.declare(`declare void @${adapter}(ptr, ptr)`);
      this.declare(`declare void @${entry}(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (
      e.fn === "net.serverOnClose" || e.fn === "net.serverOnListening" ||
      e.fn === "net.sockOnEnd" || e.fn === "net.sockOnClose" || e.fn === "net.sockOnConnect" ||
      e.fn === "net.sockOnTimeout" || e.fn === "net.sockOnReadable" ||
      e.fn === "http.reqOnEnd" || e.fn === "http.reqOnClose" || e.fn === "http.resOnClose" ||
      e.fn === "http.clientOnTimeout" || e.fn === "http.clientOnClose"
    ) {
      // Adapter-free registrations: (recv, cb /moves/, once).
      const entry = {
        "net.serverOnClose": "scr_net_server_on_close",
        "net.serverOnListening": "scr_net_server_on_listening",
        "net.sockOnEnd": "scr_net_sock_on_end",
        "net.sockOnClose": "scr_net_sock_on_close",
        "net.sockOnConnect": "scr_net_sock_on_connect",
        "net.sockOnTimeout": "scr_net_sock_on_timeout",
        "net.sockOnReadable": "scr_net_sock_on_readable",
        "http.reqOnEnd": "scr_http_req_on_end",
        "http.reqOnClose": "scr_http_req_on_close",
        "http.resOnClose": "scr_http_res_on_close",
        "http.clientOnTimeout": "scr_http_client_on_timeout",
        "http.clientOnClose": "scr_http_client_on_close",
      }[e.fn]!;
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      this.declare(`declare void @${entry}(ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.serverOnConnection") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: net.serverOnConnection callback not a func");
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      const adapter = cbT.params.length === 0 ? "scr_net_conn_thunk0" : "scr_net_conn_thunk_sock";
      this.declare(`declare void @${adapter}(ptr, ptr)`);
      this.declare(`declare void @scr_net_server_on_connection(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_net_server_on_connection(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.connect" || e.fn === "net.connectCb") {
      const args = e.args.map((a) => this.emitExpr(a));
      let cb = "null";
      if (e.fn === "net.connectCb") {
        this.moveTemp(args[2]!);
        cb = args[2]!.name;
      }
      this.declare(`declare ptr @scr_net_connect(double, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_net_connect(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${cb})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "net.sockOnData" || e.fn === "http.reqOnData") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error(`llvm emitter bug: ${e.fn} callback not a func`);
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      const adapter =
        cbT.params.length === 0 ? "scr_net_data_thunk0"
        : cbT.params[0]!.kind === "dyn" ? "scr_net_data_thunk_dyn"
        : "scr_net_data_thunk_bytes";
      const entry = e.fn === "net.sockOnData" ? "scr_net_sock_on_data" : "scr_http_req_on_data";
      this.declare(`declare void @${adapter}(ptr, ptr)`);
      this.declare(`declare void @${entry}(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.sockRead") {
      // Buffer | null: NULL (not enough buffered) takes the null arm.
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: net.sockRead result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (bytesTag < 0 || nullTag < 0) throw new Error("llvm emitter bug: net.sockRead union lacks its arms");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare ptr @scr_net_sock_read_bytes(ptr, double)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_net_sock_read_bytes(ptr ${args[0]!.name}, double ${args[1]!.name}) ; +1 or NULL`);
      return this.wrapNullable(raw, raw, def!.arms[bytesTag]!, bytesTag, e.type, nullTag);
    }
    if (e.fn === "net.sockRemoteAddress" || e.fn === "http.reqHeader" || e.fn === "http.resGetHeader" || e.fn === "http.reqStatusMessage") {
      // string | undefined: +1 or NULL, NULL takes the undefined arm.
      if (e.type.kind !== "union") throw new Error(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = this.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const undefTag = this.undefinedArmTag(e.type);
      if (strTag < 0 || undefTag < 0) throw new Error(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const entry = {
        "net.sockRemoteAddress": "scr_net_sock_remote_address",
        "http.reqHeader": "scr_http_req_header",
        "http.resGetHeader": "scr_http_res_get_header",
        "http.reqStatusMessage": "scr_http_req_status_message",
      }[e.fn]!;
      const args = e.args.map((a) => this.emitExpr(a));
      const argList = args.map((a) => `${this.llType(a.type)} ${a.name}`).join(", ");
      this.declare(`declare ptr @${entry}(${args.map((a) => this.llType(a.type)).join(", ")})`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @${entry}(${argList}) ; +1 or NULL`);
      return this.wrapNullable(raw, raw, STRING, strTag, e.type, undefTag);
    }
    if (e.fn === "net.sockEncrypted") {
      // boolean | undefined: the true arm iff a TLS transport.
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: net.sockEncrypted result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const boolTag = def ? def.arms.findIndex((a) => a.kind === "bool") : -1;
      const undefTag = this.undefinedArmTag(e.type);
      if (boolTag < 0 || undefTag < 0) throw new Error("llvm emitter bug: net.sockEncrypted union lacks its arms");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare zeroext i1 @scr_net_sock_encrypted(ptr)`);
      this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      const w = B.tmp();
      B.line(`${w} = call zeroext i1 @scr_net_sock_encrypted(ptr ${args[0]!.name})`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const lp = B.newLabel("se.p");
      const la = B.newLabel("se.a");
      const lj = B.newLabel("se.j");
      B.condBr(w, lp, la);
      B.startBlock(lp);
      const u = B.tmp();
      B.line(`${u} = call ptr @scr_union_new_bool(i32 ${boolTag}, i1 true)`);
      B.line(`store ptr ${u}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(la);
      B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ptr, ptr ${slot}`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "http.reqStatusCode") {
      // number | undefined: the runtime answers a negative status for
      // server requests (the process.columns shape).
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: http.reqStatusCode result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
      const undefTag = this.undefinedArmTag(e.type);
      if (f64Tag < 0 || undefTag < 0) throw new Error("llvm emitter bug: http.reqStatusCode union lacks its arms");
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare double @scr_http_req_status(ptr)`);
      this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
      const w = B.tmp();
      B.line(`${w} = call double @scr_http_req_status(ptr ${args[0]!.name})`);
      const has = B.tmp();
      B.line(`${has} = fcmp oge double ${w}, ${f64Lit(0)}`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const lp = B.newLabel("rs.p");
      const la = B.newLabel("rs.a");
      const lj = B.newLabel("rs.j");
      B.condBr(has, lp, la);
      B.startBlock(lp);
      const u = B.tmp();
      B.line(`${u} = call ptr @scr_union_new_f64(i32 ${f64Tag}, double ${w})`);
      B.line(`store ptr ${u}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(la);
      B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ptr, ptr ${slot}`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "http.createServer" || e.fn === "http.createServerEmpty") {
      const args = e.args.map((a) => this.emitExpr(a));
      let cb = "null";
      let adapter = "null";
      if (e.fn === "http.createServer") {
        const cbT = e.args[0]!.type;
        if (cbT.kind !== "func") throw new Error("llvm emitter bug: http.createServer handler not a func");
        this.moveTemp(args[0]!);
        cb = args[0]!.name;
        const sym =
          cbT.params.length === 2 ? "scr_http_handler_thunk2"
          : cbT.params.length === 1 ? "scr_http_handler_thunk1"
          : "scr_http_handler_thunk0";
        this.declare(`declare void @${sym}(ptr, ptr, ptr)`);
        adapter = `@${sym}`;
      }
      this.declare(`declare ptr @scr_http_create_server(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_http_create_server(ptr ${cb}, ptr ${adapter})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "http.serverOnRequest") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error("llvm emitter bug: http.serverOnRequest handler not a func");
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      const adapter =
        cbT.params.length === 2 ? "scr_http_handler_thunk2"
        : cbT.params.length === 1 ? "scr_http_handler_thunk1"
        : "scr_http_handler_thunk0";
      this.declare(`declare void @${adapter}(ptr, ptr, ptr)`);
      this.declare(`declare void @scr_http_server_on_request(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_http_server_on_request(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "http.serverOnUpgrade" || e.fn === "http.clientOnUpgrade") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error(`llvm emitter bug: ${e.fn} listener not a func`);
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      const adapter =
        cbT.params.length === 3 ? "scr_http_upgrade_thunk3"
        : cbT.params.length === 2 ? "scr_http_upgrade_thunk2"
        : cbT.params.length === 1 ? "scr_http_upgrade_thunk1"
        : "scr_http_upgrade_thunk0";
      const entry = e.fn === "http.serverOnUpgrade" ? "scr_http_server_on_upgrade" : "scr_http_client_on_upgrade";
      this.declare(`declare void @${adapter}(ptr, ptr, ptr, ptr)`);
      this.declare(`declare void @${entry}(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "http.request" || e.fn === "http.requestCb" || e.fn === "http.requestUrl" || e.fn === "http.requestUrlCb" ||
        e.fn === "http.requestAgent" || e.fn === "http.requestAgentCb" ||
        e.fn === "https.request" || e.fn === "https.requestCb" ||
        e.fn === "https.requestUrl" || e.fn === "https.requestUrlCb") {
      // The https URL row is the http one with the TLS entry point — same
      // three arguments, same response-callback adapter. The https options
      // row is wider: rejectUnauthorized stays an i1, while its ScrStr or
      // ScrBytes CA value expands to the runtime's raw pointer + length.
      const isTls = e.fn.startsWith("https.");
      const isUrl = e.fn.includes("requestUrl");
      const isTlsOptions = isTls && !isUrl;
      const isAgent = e.fn.startsWith("http.requestAgent");
      const cbIdx = isUrl ? 3 : isTlsOptions ? 9 : isAgent ? 8 : 7;
      const hasCb = e.fn.endsWith("Cb");
      const args = e.args.map((a) => this.emitExpr(a));
      let cb = "null";
      let adapter = "null";
      if (hasCb) {
        const cbT = e.args[cbIdx]!.type;
        if (cbT.kind !== "func") throw new Error(`llvm emitter bug: ${e.fn} callback not a func`);
        this.moveTemp(args[cbIdx]!);
        cb = args[cbIdx]!.name;
        const sym = cbT.params.length === 0 ? "scr_http_resp_thunk0" : "scr_http_resp_thunk_res";
        this.declare(`declare void @${sym}(ptr, ptr)`);
        adapter = `@${sym}`;
      }
      const head = args.slice(0, cbIdx);
      const entry = isTlsOptions ? "scr_https_request"
        : isTls ? "scr_https_request_url"
        : isUrl ? "scr_http_request_url"
        : isAgent ? "scr_http_request_agent" : "scr_http_request";
      let callArgs = head.map((a) => `${this.llType(a.type)} ${a.name}`);
      if (isTlsOptions) {
        const ca = args[8]!;
        const caLenPtr = B.tmp();
        const caLen = B.tmp();
        let caData: string;
        if (ca.type.kind === "string") {
          caData = B.tmp();
          B.line(`${caLenPtr} = getelementptr inbounds %ScrStr, ptr ${ca.name}, i64 0, i32 1`);
          B.line(`${caLen} = load ${this.sizeType}, ptr ${caLenPtr}`);
          B.line(`${caData} = getelementptr inbounds i8, ptr ${ca.name}, i64 ${this.abiOffset(24, 12)}`);
        } else if (ca.type.kind === "bytes" && ca.type.elem === "u8") {
          const caDataPtr = B.tmp();
          caData = B.tmp();
          B.line(`${caLenPtr} = getelementptr inbounds i8, ptr ${ca.name}, i64 ${this.abiOffset(8, 4)}`);
          B.line(`${caLen} = load ${this.sizeType}, ptr ${caLenPtr}`);
          B.line(`${caDataPtr} = getelementptr inbounds i8, ptr ${ca.name}, i64 ${this.abiOffset(24, 12)}`);
          B.line(`${caData} = load ptr, ptr ${caDataPtr}`);
        } else {
          throw new Error(`llvm emitter bug: ${e.fn} CA is not a string or Buffer`);
        }
        callArgs = [...callArgs.slice(0, 8), `ptr ${caData}`, `${this.sizeType} ${caLen}`];
        this.declare(`declare ptr @scr_https_request(ptr, double, ptr, ptr, double, ptr, i1 zeroext, i1 zeroext, ptr, ${this.sizeType}, ptr, ptr)`);
      } else {
        const decls = head.map((a) => (this.llType(a.type) === "i1" ? "i1 zeroext" : this.llType(a.type)));
        this.declare(`declare ptr @${entry}(${[...decls, "ptr", "ptr"].join(", ")})`);
      }
      const t = B.tmp();
      B.line(
        `${t} = call ptr @${entry}(${[...callArgs, `ptr ${cb}`, `ptr ${adapter}`].join(", ")})`,
      );
      const out = this.own({ name: t, type: e.type });
      if (MAY_THROW_LIB_FNS.has(e.fn)) this.emitPendingCheck();
      return out;
    }
    if (e.fn === "http.clientOnResponse" || e.fn === "http.clientOnError" || e.fn === "http.reqOnError") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new Error(`llvm emitter bug: ${e.fn} callback not a func`);
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      const adapter = e.fn === "http.clientOnResponse"
        ? (cbT.params.length === 0 ? "scr_http_resp_thunk0" : "scr_http_resp_thunk_res")
        : (cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error");
      const entry = {
        "http.clientOnResponse": "scr_http_client_on_response",
        "http.clientOnError": "scr_http_client_on_error",
        "http.reqOnError": "scr_http_req_on_error",
      }[e.fn]!;
      this.declare(`declare void @${adapter}(ptr, ptr)`);
      this.declare(`declare void @${entry}(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "http.resOnFinish") {
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      this.declare(`declare void @scr_http_res_on_finish(ptr, ptr)`);
      B.line(`call void @scr_http_res_on_finish(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.sockOnFinish") {
      const args = e.args.map((a) => this.emitExpr(a));
      this.moveTemp(args[1]!);
      this.declare(`declare void @scr_net_sock_on_finish(ptr, ptr)`);
      B.line(`call void @scr_net_sock_on_finish(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "island.castFail") {
      // The deferred boundary failure: the island value was evaluated
      // (its side effects are real), the throw is unconditional
      // (catchable TypeError naming the target type), and the typed
      // dummy is NULL — the pending check abandons it.
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare void @scr_jsval_cast_fail(ptr, ptr)`);
      B.line(`call void @scr_jsval_cast_fail(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      const out = this.own({ name: "null", type: e.type });
      this.emitPendingCheck();
      return out;
    }
    if (MAY_THROW_LIB_FNS.has(e.fn) && LIB_FN_SYMS[e.fn] === undefined) {
      throw new LlvmUnsupportedError(`libCall:${e.fn}`, e.loc);
    }
    if (e.fn === "math.floor" || e.fn === "math.trunc" || e.fn === "math.ceil") {
      const intr = e.fn === "math.floor" ? "floor" : e.fn === "math.trunc" ? "trunc" : "ceil";
      const v = this.emitExpr(e.args[0]!);
      this.declare(`declare double @llvm.${intr}.f64(double)`);
      const t = B.tmp();
      B.line(`${t} = call double @llvm.${intr}.f64(double ${v.name})`);
      return { name: t, type: e.type };
    }
    if (e.fn === "math.abs") {
      const v = this.emitExpr(e.args[0]!);
      this.declare(`declare double @llvm.fabs.f64(double)`);
      const t = B.tmp();
      B.line(`${t} = call double @llvm.fabs.f64(double ${v.name})`);
      return { name: t, type: e.type };
    }
    if (e.fn === "num.isNaN") {
      const v = this.emitExpr(e.args[0]!);
      const t = B.tmp();
      B.line(`${t} = fcmp uno double ${v.name}, ${f64Lit(0)}`);
      return { name: t, type: e.type };
    }
    if (e.fn === "sym.newAnon") {
      this.declare(`declare ptr @scr_sym_new(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_sym_new(ptr null)`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "sym.desc" || e.fn === "sym.keyFor") {
      // `string | undefined` — the runtime answers a +1 string or NULL;
      // the union construction is type-directed here (envGet convention).
      if (e.type.kind !== "union") throw new Error(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = this.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const undefTag = this.undefinedArmTag(e.type);
      if (strTag < 0 || undefTag < 0) throw new Error(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const v = this.emitExpr(e.args[0]!);
      const sym = e.fn === "sym.desc" ? "scr_sym_desc" : "scr_sym_key_for";
      this.declare(`declare ptr @${sym}(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @${sym}(ptr ${v.name})`);
      return this.wrapNullable(raw, raw, STRING, strTag, e.type, undefTag);
    }
    if (e.fn === "error.new") {
      // Which builtin the runtime constructs is named by the RESULT type;
      // the message is borrowed (the runtime retains its copy). Never
      // throws.
      if (e.type.kind !== "object") throw new Error("llvm emitter bug: error.new result is not a class");
      const rec = RUNTIME_ERROR_CLASSES.get(e.type.className);
      if (!rec) throw new Error(`llvm emitter bug: error.new of ${e.type.className}`);
      const msg = this.emitExpr(e.args[0]!);
      this.declare(`declare ptr @scr_error_new(i32, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_error_new(i32 ${rec.kind}, ptr ${msg.name})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "error.ctor") {
      // super(message) into the builtin base: stamps name/message on the
      // receiver (borrowed, like the message). The RECEIVER'S static class
      // names which builtin name to stamp.
      const recvT = e.args[0]!.type;
      if (recvT.kind !== "object") throw new Error("llvm emitter bug: error.ctor receiver is not a class");
      const rec = RUNTIME_ERROR_CLASSES.get(recvT.className);
      if (!rec) throw new Error(`llvm emitter bug: error.ctor on ${recvT.className}`);
      const args = e.args.map((a) => this.emitExpr(a));
      this.declare(`declare void @scr_error_init(ptr, i32, ptr)`);
      B.line(`call void @scr_error_init(ptr ${args[0]!.name}, i32 ${rec.kind}, ptr ${args[1]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "error.code") {
      // `string | undefined`, constructed type-directedly like
      // process.envGet: the runtime answers +1 or NULL (the receiver may
      // be a user subclass — the code slot sits in its ScrError prefix).
      if (e.type.kind !== "union") throw new Error("llvm emitter bug: error.code result is not a union");
      const def = this.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const undefTag = this.undefinedArmTag(e.type);
      if (strTag < 0 || undefTag < 0) throw new Error("llvm emitter bug: error.code union lacks its arms");
      const recv = this.emitExpr(e.args[0]!);
      this.declare(`declare ptr @scr_error_code(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_error_code(ptr ${recv.name})`);
      return this.wrapNullable(raw, raw, STRING, strTag, e.type, undefTag);
    }
    if (e.fn === "string.fromCharCode") {
      // One packed f64[] (the frontend built it) or one bytes value (the
      // spread-typed-array form); +1 string.
      const sym = e.args[0]!.type.kind === "bytes" ? "scr_str_from_char_code_bytes" : "scr_str_from_char_code";
      const v = this.emitExpr(e.args[0]!);
      this.declare(`declare ptr @${sym}(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(ptr ${v.name})`);
      return this.own({ name: t, type: e.type });
    }
    if (e.fn === "process.envGet" || e.fn === "process.columns") {
      // getenv(3) / ioctl(TIOCGWINSZ): the runtime answers a +1 string or
      // NULL (a width or a negative sentinel); the union construction is
      // type-directed HERE — present wraps the value arm, absent yields
      // the interned immortal undefined-arm instance.
      if (e.type.kind !== "union") throw new Error(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = this.unionsById.get(e.type.unionId);
      const undefTag = this.undefinedArmTag(e.type);
      const isEnv = e.fn === "process.envGet";
      const valTag = def ? def.arms.findIndex((a) => a.kind === (isEnv ? "string" : "f64")) : -1;
      if (valTag < 0 || undefTag < 0) throw new Error(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const args = e.args.map((a) => this.emitExpr(a));
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const lp = B.newLabel("env.p");
      const la = B.newLabel("env.a");
      const lj = B.newLabel("env.j");
      const raw = B.tmp();
      const present = B.tmp();
      if (isEnv) {
        this.declare(`declare ptr @scr_env_get(ptr)`);
        B.line(`${raw} = call ptr @scr_env_get(ptr ${args[0]!.name})`);
        B.line(`${present} = icmp ne ptr ${raw}, null`);
      } else {
        this.declare(`declare double @scr_process_columns(double)`);
        B.line(`${raw} = call double @scr_process_columns(double ${args[0]!.name})`);
        B.line(`${present} = fcmp oge double ${raw}, ${f64Lit(0)}`);
      }
      B.condBr(present, lp, la);
      B.startBlock(lp);
      B.line(
        `store ptr ${this.unionNewOwned(valTag, { name: raw, type: isEnv ? STRING : F64 })}, ptr ${slot}`,
      );
      B.br(lj);
      B.startBlock(la);
      B.line(`store ptr ${this.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ptr, ptr ${slot}`);
      return this.own({ name: t, type: e.type });
    }
    const sym = LIB_FN_SYMS[e.fn];
    if (sym === undefined) throw new LlvmUnsupportedError(`libCall:${e.fn}`, e.loc);
    const args = e.args.map((a) => this.emitExpr(a));
    const argDecls = args.map((a) => {
      const ty = this.llType(a.type);
      return ty === "i1" ? "i1 zeroext" : ty;
    });
    const retTy = this.llType(e.type);
    const retDecl = retTy === "i1" ? "zeroext i1" : retTy;
    this.declare(`declare ${retDecl} @${sym}(${argDecls.join(", ")})`);
    const argList = args.map((a) => `${this.llType(a.type)} ${a.name}`).join(", ");
    if (retTy === "void") {
      B.line(`call void @${sym}(${argList})`);
      if (MAY_THROW_LIB_FNS.has(e.fn)) this.emitPendingCheck();
      return { name: "", type: e.type };
    }
    const t = B.tmp();
    B.line(`${t} = call ${retTy} @${sym}(${argList})`);
    // The result joins its frame BEFORE the pending check so an unwind
    // releases the dummy (NULL for refcounted returns) harmlessly.
    const out = this.own({ name: t, type: e.type });
    if (MAY_THROW_LIB_FNS.has(e.fn)) this.emitPendingCheck();
    return out;
  }
}
